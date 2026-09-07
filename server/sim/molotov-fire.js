import { AIR, SX, SY, SZ } from '../../shared/worlddata.js';
import { PLAYER_HALF } from '../../shared/combatmath.js';
import { MOLOTOV_FIRE, molotovFireProfile } from '../../shared/molotov-rules.js';
import { raycastVoxels } from '../../shared/raycast.js';
import { evHit } from '../protocol/events.js';

const solid = (ctx, x, y, z) => ctx.getBlock(Math.floor(x), Math.floor(y), Math.floor(z)) !== AIR;

function visible(ctx, from, to) {
  const d = to.map((n, i) => n - from[i]);
  const distance = Math.hypot(...d);
  return distance < 0.04 || !raycastVoxels(ctx.solidAt || ((x, y, z) => solid(ctx, x, y, z)),
    ...from, ...d, distance - 0.04);
}

/** First exposed supporting surface below a point, never through a floor. */
function groundAt(ctx, x, startY, z, minY = 0) {
  if (x < 0 || x >= SX || z < 0 || z >= SZ || startY < 0) return null;
  for (let y = Math.min(SY - 1, Math.floor(startY)); y >= Math.max(0, Math.floor(minY)); y--) {
    if (!solid(ctx, x, y, z)) continue;
    return !solid(ctx, x, y + 1.05, z) && y + 1 <= startY + 0.01 ? y + 1.04 : null;
  }
  return null;
}

function supported(ctx, cell) {
  return solid(ctx, cell[0], cell[1] - 0.1, cell[2]) && !solid(ctx, ...cell);
}

/** Ground hazards are separate from travelling bottles and never chain-explode. */
export class MolotovFireSystem {
  constructor() {
    this.active = new Map();
    this.pending = new Map();
    this.exposed = new Map();
  }

  clear() {
    this.active.clear();
    this.pending.clear();
    this._clearExposure();
  }

  _clearExposure() {
    for (const victim of this.exposed.values()) victim.molotovBurning = 0;
    this.exposed.clear();
  }

  ignite(projectile, ctx) {
    if (ctx.canAffectWorld?.() === false) return null;
    const { x, y, z } = projectile;
    if (![x, y, z].every(Number.isFinite)) return null;
    const groundY = groundAt(ctx, x, y + 0.01, z);
    if (groundY == null) return null;
    const cells = [];
    const profile = molotovFireProfile(projectile.chaosLevel);
    const radius = profile.radius;
    const origin = [x, groundY + 0.12, z];
    for (let iz = Math.floor(z - radius); iz <= Math.floor(z + radius); iz++) {
      for (let ix = Math.floor(x - radius); ix <= Math.floor(x + radius); ix++) {
        const cx = ix + 0.5, cz = iz + 0.5;
        if (Math.hypot(cx - x, cz - z) > radius) continue;
        const cy = groundAt(ctx, cx, groundY + 0.75, cz, groundY - 1.1);
        const cell = [cx, cy, cz];
        if (cy != null && visible(ctx, origin, [cx, cy + 0.12, cz])) cells.push(cell);
      }
    }
    cells.sort((a, b) => Math.hypot(a[0] - x, a[2] - z) - Math.hypot(b[0] - x, b[2] - z));
    cells.length = Math.min(cells.length, MOLOTOV_FIRE.maxCells);
    if (!cells.length) return null;
    // Drop the oldest field when the room's visual/network budget is full.
    if (this.active.size >= MOLOTOV_FIRE.maxFields) this.active.delete(this.active.keys().next().value);
    const field = { id: `fire-${projectile.id}`, ownerId: projectile.ownerId,
      owner: projectile.owner || ctx.entities.get(projectile.ownerId) || null,
      x, y: groundY, z, radius, createdAt: ctx.now,
      expiresAt: ctx.now + profile.durationMs, damagePerSecond: profile.damagePerSecond, cells };
    this.active.set(field.id, field);
    return field;
  }

  _contact(field, victim, ctx) {
    if (Math.hypot(victim.x - field.x, victim.z - field.z) > field.radius + PLAYER_HALF.x + MOLOTOV_FIRE.cellRadius) return false;
    const target = [victim.x, victim.y + 0.22, victim.z];
    for (const cell of field.cells) {
      if (victim.y < cell[1] - 0.3 || victim.y > cell[1] + MOLOTOV_FIRE.height) continue;
      if (Math.hypot(victim.x - cell[0], victim.z - cell[2]) > MOLOTOV_FIRE.cellRadius + PLAYER_HALF.x) continue;
      if (visible(ctx, [cell[0], cell[1] + 0.12, cell[2]], target)) return true;
    }
    return false;
  }

  step(dt, ctx) {
    if (ctx.canAffectWorld?.() === false) { this.clear(); return; }
    if (!Number.isFinite(dt) || dt <= 0) return;
    this._clearExposure();
    for (const [id, field] of this.active) {
      field.cells = field.cells.filter(cell => supported(ctx, cell));
      if (!field.cells.length || field.expiresAt <= ctx.now - dt * 1000) this.active.delete(id);
    }
    if (ctx.grenadeDamage === false) this.pending.clear();
    else for (const victim of ctx.entities.values()) {
      // A fire kill can end the round while this loop is still running.
      if (ctx.canAffectWorld?.() === false) { this.clear(); return; }
      if (victim.state !== 'alive' || victim.spawnProtectedUntil > ctx.now) {
        this.pending.delete(victim.id);
        continue;
      }
      let contact = null, seconds = 0, exposure = 0;
      for (const field of this.active.values()) {
        const self = field.owner && field.owner.id === victim.id;
        if (!self && !ctx.canDamage(field.owner, victim)) continue;
        const elapsed = Math.max(0, Math.min(ctx.now, field.expiresAt)
          - Math.max(ctx.now - dt * 1000, field.createdAt)) / 1000;
        const dose = elapsed * field.damagePerSecond * (self ? MOLOTOV_FIRE.selfDamage : 1);
        if (dose <= exposure || !this._contact(field, victim, ctx)) continue;
        contact = field;
        seconds = elapsed;
        exposure = dose;
      }
      let pending = this.pending.get(victim.id);
      // Multiple overlapping bottles apply a single exposure, with stable ownership.
      if (contact) {
        if (contact.expiresAt > ctx.now) {
          victim.molotovBurning = 0.5;
          this.exposed.set(victim.id, victim);
        }
        pending ||= { owner: contact.owner, elapsed: 0, damage: 0 };
        pending.owner = contact.owner;
        pending.elapsed += seconds;
        pending.damage += exposure;
        this.pending.set(victim.id, pending);
      }
      if (!pending) continue;
      if (pending.owner?.id !== victim.id && !ctx.canDamage(pending.owner, victim)) {
        this.pending.delete(victim.id);
        continue;
      }
      if (pending.elapsed + 1e-9 < MOLOTOV_FIRE.damageInterval && contact && contact.expiresAt > ctx.now) continue;
      this.pending.delete(victim.id);
      const lethal = victim.takeDamage(pending.damage, false);
      ctx.pushEvent(evHit(pending.owner?.id || '', victim.id, pending.damage, false,
        [victim.x, victim.y + 0.22, victim.z], victim.lastDamage));
      if (lethal) {
        victim.molotovBurning = 0;
        this.exposed.delete(victim.id);
        ctx.killPlayer(victim, pending.owner, 'molotov', false, null);
      }
    }
    for (const id of this.pending.keys()) if (!ctx.entities.has(id)) this.pending.delete(id);
    for (const [id, field] of this.active) if (field.expiresAt <= ctx.now) this.active.delete(id);
  }

  snapshot() {
    return Array.from(this.active.values(), ({ owner, ...field }) => ({ ...field,
      cells: field.cells.map(cell => cell.slice()) }));
  }
}
