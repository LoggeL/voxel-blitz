import { combatDamage } from '../../shared/combat-balance.js';
import { AIR, worldDimensions } from '../../shared/worlddata.js';
import { PLAYER_HALF } from '../../shared/combatmath.js';
import { MOLOTOV_FIRE, molotovFireProfile } from '../../shared/molotov-rules.js';
import { raycastVoxels } from '../../shared/raycast.js';
import { evHit } from '../protocol/events.js';
import { occupantShielded, occupantHitPose, occupantDamageScale } from './vehicle-damage.js';
import { hullFootprint, footprintsOverlap } from '../../shared/vehicle-collision.js';
import { armorMultiplier } from '../../shared/vehicle-armor.js';
import { vehicleDef } from '../../shared/vehicle-defs.js';

const solid = (ctx, x, y, z) => ctx.getBlock(Math.floor(x), Math.floor(y), Math.floor(z)) !== AIR;

function visible(ctx, from, to) {
  const d = to.map((n, i) => n - from[i]);
  const distance = Math.hypot(...d);
  return distance < 0.04 || !raycastVoxels(ctx.solidAt || ((x, y, z) => solid(ctx, x, y, z)),
    ...from, ...d, distance - 0.04);
}

/** First exposed supporting surface below a point, never through a floor. */
function groundAt(ctx, x, startY, z, minY = 0) {
  const { sx: SX, sy: SY, sz: SZ } = worldDimensions(ctx);
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

  /**
   * `override` (titanfall thermite, incendiary trap, the jet's bomb): { radius?,
   * durationMs?, damagePerSecond? (pilots), hullDamagePerSecond?, key? (pilot
   * kill key), maxCells? (at most MOLOTOV_FIRE.maxCells), onHullDamage? (called
   * with the hull and the damage it took from this field, for the titan core
   * meter), cellSize? (metres between flame cells, centred on the impact; each
   * cell's reach and flames scale with it), rise?/drop? (a blast field: each
   * cell's ground is searched from `rise` m above the blast down into its
   * crater, and nothing lights without ground within `drop` m below the
   * blast) } over the molotov profile.
   */
  ignite(projectile, ctx, override = null) {
    if (ctx.canAffectWorld?.() === false) return null;
    const { x, y, z } = projectile;
    if (![x, y, z].every(Number.isFinite)) return null;
    const groundY = groundAt(ctx, x, y + 0.01, z);
    if (groundY == null) return null;
    const blast = Number.isFinite(override?.rise);
    if (blast && y - groundY > (override.drop ?? Infinity)) return null;
    const cells = [];
    const profile = override ? { ...molotovFireProfile(projectile.chaosLevel), ...override } : molotovFireProfile(projectile.chaosLevel);
    const radius = profile.radius, cellSize = override?.cellSize > 0 ? override.cellSize : 1;
    const top = blast ? Math.max(groundY, y) + override.rise : groundY + 0.75;
    const origin = [x, (blast ? Math.max(groundY, y) : groundY) + 0.12, z];
    const sites = [];
    if (cellSize === 1) {
      for (let iz = Math.floor(z - radius); iz <= Math.floor(z + radius); iz++) {
        for (let ix = Math.floor(x - radius); ix <= Math.floor(x + radius); ix++) sites.push([ix + 0.5, iz + 0.5]);
      }
    } else {
      const steps = Math.floor(radius / cellSize);
      for (let j = -steps; j <= steps; j++) for (let i = -steps; i <= steps; i++) sites.push([x + i * cellSize, z + j * cellSize]);
    }
    for (const [cx, cz] of sites) {
      if (Math.hypot(cx - x, cz - z) > radius) continue;
      const cy = groundAt(ctx, cx, top, cz, groundY - 1.1);
      const cell = [cx, cy, cz];
      if (cy != null && visible(ctx, origin, [cx, cy + 0.12, cz])) cells.push(cell);
    }
    cells.sort((a, b) => Math.hypot(a[0] - x, a[2] - z) - Math.hypot(b[0] - x, b[2] - z));
    cells.length = Math.min(cells.length, override ? Math.min(MOLOTOV_FIRE.maxCells, profile.maxCells ?? Infinity) : MOLOTOV_FIRE.maxCells);
    if (!cells.length) return null;
    // Drop the oldest field when the room's visual/network budget is full.
    if (this.active.size >= MOLOTOV_FIRE.maxFields) this.active.delete(this.active.keys().next().value);
    const field = { id: `fire-${projectile.id}`, ownerId: projectile.ownerId,
      owner: projectile.owner || ctx.entities.get(projectile.ownerId) || null,
      x, y: groundY, z, radius, createdAt: ctx.now,
      expiresAt: ctx.now + profile.durationMs, damagePerSecond: profile.damagePerSecond, cells };
    if (cellSize !== 1) field.cellSize = cellSize;
    if (override) {
      if (Number.isFinite(override.hullDamagePerSecond)) field.hullDamagePerSecond = override.hullDamagePerSecond;
      if (typeof override.key === 'string') field.key = override.key;
      if (typeof override.onHullDamage === 'function') field.onHullDamage = override.onHullDamage;
    }
    this.active.set(field.id, field);
    return field;
  }

  _contact(field, body, ctx) {
    // Exposed crew burn at their crouched seat pose; sealed crew never reach here.
    const victim = occupantHitPose(body), reach = MOLOTOV_FIRE.cellRadius * (field.cellSize ?? 1);
    if (Math.hypot(victim.x - field.x, victim.z - field.z) > field.radius + PLAYER_HALF.x + reach) return false;
    const target = [victim.x, victim.y + 0.22, victim.z];
    for (const cell of field.cells) {
      if (victim.y < cell[1] - 0.3 || victim.y > cell[1] + MOLOTOV_FIRE.height) continue;
      if (Math.hypot(victim.x - cell[0], victim.z - cell[2]) > reach + PLAYER_HALF.x) continue;
      if (visible(ctx, [cell[0], cell[1] + 0.12, cell[2]], target)) return true;
    }
    return false;
  }

  step(dt, ctx) {
    if (ctx.canAffectWorld?.() === false) { this.clear(); return; }
    if (!Number.isFinite(dt) || dt <= 0) return;
    this._clearExposure();
    for (const [id, field] of this.active) {
      let kept = 0;
      for (const cell of field.cells) if (supported(ctx, cell)) field.cells[kept++] = cell;
      field.cells.length = kept;
      if (!field.cells.length || field.expiresAt <= ctx.now - dt * 1000) this.active.delete(id);
    }
    const damageEnabled = ctx.grenadeDamage !== false;
    if (!damageEnabled) this.pending.clear();
    // Most room ticks have no ground fire. Exposure was cleared above, and
    // pending doses must still flush after the last field disappears.
    if (!this.active.size && !this.pending.size) return;
    if (damageEnabled) for (const victim of (ctx.targets || ctx.entities).values()) {
      // A fire kill can end the round while this loop is still running.
      if (ctx.canAffectWorld?.() === false) { this.clear(); return; }
      // A fire-immune body (Conquest Pyro) stands in the field untouched.
      if (victim.fireImmune === true || occupantShielded(victim) || victim.state !== 'alive' || victim.spawnProtectedUntil > ctx.now) {
        this.pending.delete(victim.id);
        continue;
      }
      let contact = null, seconds = 0, exposure = 0;
      for (const field of this.active.values()) {
        const self = field.owner && field.owner.id === victim.id;
        if (!self && !ctx.canDamage(field.owner, victim)) continue;
        const elapsed = Math.max(0, Math.min(ctx.now, field.expiresAt)
          - Math.max(ctx.now - dt * 1000, field.createdAt)) / 1000;
        const dose = elapsed * field.damagePerSecond * (self ? MOLOTOV_FIRE.selfDamage : 1) * occupantDamageScale(victim);
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
        pending.key = contact.key ?? null;
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
      pending.damage = combatDamage(pending.damage);
      const lethal = victim.takeDamage(pending.damage, false, pending.owner, pending.key ?? 'molotov');
      ctx.pushEvent(evHit(pending.owner?.id || '', victim.id, pending.damage, false,
        [victim.x, victim.y + 0.22, victim.z], victim.lastDamage));
      if (lethal) {
        victim.molotovBurning = 0;
        this.exposed.delete(victim.id);
        ctx.killPlayer(victim, pending.owner, pending.key ?? 'molotov', false, null);
      }
    }
    for (const id of this.pending.keys()) if (!ctx.entities.has(id)) this.pending.delete(id);
    if (damageEnabled) this._burnHulls(dt, ctx);
    for (const [id, field] of this.active) if (field.expiresAt <= ctx.now) this.active.delete(id);
  }

  /** Light hulls parked in a fire field take the fire class dose (0.3 per s). */
  _burnHulls(dt, ctx) {
    const vehicles = ctx.vehicles;
    if (!vehicles?.vehicles?.size || !this.active.size) return;
    for (const v of vehicles.vehicles.values()) {
      const def = vehicleDef(v);
      if (!(v.hp > 0) || !def || !(armorMultiplier('fire', def.armor) > 0)) continue;
      const hull = hullFootprint(v.type, v.x, v.z, v.yaw);
      for (const field of this.active.values()) {
        if (field.expiresAt <= ctx.now - dt * 1000 || Math.hypot(v.x - field.x, v.z - field.z) > field.radius + def.radius + 1) continue;
        const cell = field.cells.find(c => c[1] >= v.y - 0.6 && c[1] <= v.y + 1.2
          && footprintsOverlap(hull, hullFootprint('voxel', c[0], c[2], 0)));
        if (!cell) continue;
        const elapsed = Math.max(0, Math.min(ctx.now, field.expiresAt) - Math.max(ctx.now - dt * 1000, field.createdAt)) / 1000;
        if (elapsed > 0) {
          // onHullDamage gets what the owner's damage log gained (after armour and refusals).
          const logged = () => v.damageLog?.get(String(field.owner?.id))?.dmg ?? 0, before = field.onHullDamage ? logged() : 0;
          vehicles.damage(v.id, (field.hullDamagePerSecond ?? field.damagePerSecond) * elapsed, field.owner, { cls: 'fire', origin: [cell[0], cell[1], cell[2]] });
          if (field.onHullDamage) field.onHullDamage(v, Math.max(0, logged() - before));
        }
        break;
      }
    }
  }

  snapshot() {
    return Array.from(this.active.values(), ({ owner, ...field }) => ({ ...field,
      cells: field.cells.map(cell => cell.slice()) }));
  }
}
