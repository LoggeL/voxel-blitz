import { AIR, BEDROCK, MC_IRON, MC_LAVA, MC_WATER, isSolidBlock } from '../../shared/world/blocks.js';
import { PHYSICS } from '../../shared/player-movement.js';
import { TRAP_RULES, trapButtonPoint, trapEffectContains, trapsFor } from '../../shared/world/traps.js';
import { evHit } from '../protocol/events.js';

const FILL_BLOCKS = Object.freeze({ lava: MC_LAVA, flood: MC_WATER, door_lock: MC_IRON });

function regionCenter(region) {
  return { x: (region.minX + region.maxX + 1) / 2, y: (region.minY + region.maxY + 1) / 2,
    z: (region.minZ + region.maxZ + 1) / 2 };
}

/**
 * Round-scoped traitor traps. Buttons are map data (`shared/world/traps.js`);
 * this system enforces role, phase, range, cooldown and uses, runs the effects
 * through the engine's block, projectile, smoke and fire paths, and reverts
 * every temporary block change. Trap damage is world damage: hits, kills and
 * corpses never name the traitor who pressed the button.
 */
export class TttTraps {
  constructor(policy, engine) {
    this.policy = policy;
    this.engine = engine;
    this.defs = trapsFor(engine.mapMeta?.id);
    this.state = new Map();
    this.fills = [];
    this.volumes = [];
    this.held = new Map();
    this.serial = 0;
    this.reset();
  }

  reset() {
    for (const trap of this.defs) this.state.set(trap.id, { uses: trap.uses ?? Infinity, readyAt: 0 });
  }

  /** Round end: revert every block change at once and re-arm the buttons. */
  clear() {
    for (const fill of this.fills) this.restore(fill, true);
    this.fills.length = 0;
    this.volumes.length = 0;
    this.held.clear();
    this.reset();
  }

  remove(id) { this.held.delete(String(id)); }
  takeover(oldId, newId) {
    if (this.held.has(oldId)) { this.held.set(String(newId), this.held.get(oldId)); this.held.delete(oldId); }
  }

  admitted(player) {
    return this.policy.phase === 'live' && player?.state === 'alive'
      && this.policy.roles.get(String(player.id)) === 'traitor';
  }

  status(trap) {
    const s = this.state.get(trap.id), now = this.engine.now;
    const cooldown = Math.max(0, Math.ceil((s.readyAt - now) / 1000));
    return { state: s.uses <= 0 ? 'used' : cooldown > 0 ? 'cooldown' : 'ready', cooldown,
      uses: Number.isFinite(s.uses) ? s.uses : null };
  }

  inRange(player, trap) {
    const b = trapButtonPoint(trap);
    return Math.hypot(player.x - b.x, player.z - b.z) <= TRAP_RULES.useRange && Math.abs(player.y - b.y) <= 1.2;
  }

  nearest(player) {
    let best = null, bestD = Infinity;
    for (const trap of this.defs) {
      if (!this.inRange(player, trap)) continue;
      const b = trapButtonPoint(trap), d = Math.hypot(player.x - b.x, player.z - b.z);
      if (d < bestD) { best = trap; bestD = d; }
    }
    return best;
  }

  trigger(player, id) {
    if (!this.admitted(player)) return false;
    const trap = this.defs.find((t) => t.id === id);
    if (!trap || !this.inRange(player, trap)) return false;
    const s = this.state.get(trap.id), now = this.engine.now;
    if (s.uses <= 0 || now < s.readyAt) return false;
    s.uses--;
    s.readyAt = now + (trap.cooldownMs ?? 0);
    const origin = this.apply(trap.effect);
    const b = trapButtonPoint(trap);
    this.engine.tickEvents.push({ t: 'ev', kind: 'trap', at: now, id: trap.id, name: trap.name,
      effect: trap.effect.kind, by: 'traitor', x: origin.x, y: origin.y, z: origin.z, button: [b.x, b.y, b.z] });
    return true;
  }

  apply(effect) {
    const now = this.engine.now, ctx = this.engine.contexts.projectiles;
    switch (effect.kind) {
      case 'explosion': {
        const id = `trap-${++this.serial}`;
        const projectile = { id, type: TRAP_RULES.weaponKey, owner: null, ownerId: '',
          x: effect.x, y: effect.y, z: effect.z, blastRules: {
            damage: effect.damage, damageRadius: effect.radius, damageFalloffExponent: 1.1,
            selfDamage: 1, knockback: 10, terrainRadius: effect.terrainRadius,
            terrainPower: effect.terrainPower, maxDestroyedBlocks: effect.maxDestroyedBlocks,
            concussMs: 0, concussPanic: 0 } };
        this.engine.projectiles.active.set(id, projectile);
        this.engine.projectiles.explode(projectile, ctx);
        return { x: effect.x, y: effect.y, z: effect.z };
      }
      case 'lava': case 'flood': case 'door_lock': {
        const block = FILL_BLOCKS[effect.kind], cells = [];
        this.eachCell(effect.region, (x, y, z) => {
          if (this.engine.world.getBlock(x, y, z) !== AIR) return;
          if (effect.kind === 'door_lock' && this.occupied(x, y, z)) return;
          cells.push({ x, y, z, from: AIR, placed: block });
          this.setBlock(x, y, z, block);
        });
        this.fills.push({ cells, restoreAt: now + effect.durationMs });
        return regionCenter(effect.region);
      }
      case 'collapse': {
        const cells = [];
        this.eachCell(effect.region, (x, y, z) => {
          const from = this.engine.world.getBlock(x, y, z);
          if (!isSolidBlock(from) || from === BEDROCK) return;
          cells.push({ x, y, z, from, placed: AIR });
          this.setBlock(x, y, z, AIR);
        });
        this.fills.push({ cells, restoreAt: now + effect.durationMs });
        return regionCenter(effect.region);
      }
      case 'electrify': case 'gas': {
        const regions = effect.regions ?? [effect.region];
        this.volumes.push({ regions, damage: effect.damage, intervalMs: effect.intervalMs,
          expiresAt: now + effect.durationMs, nextAt: now });
        for (const f of effect.fields ?? []) {
          const field = this.engine.projectiles.smoke.deploy({ id: `trap-${++this.serial}`, x: f.x, y: f.y, z: f.z }, ctx);
          if (field) { field.radius = f.radius; field.expiresAt = now + effect.durationMs; }
        }
        const r = regions[0];
        return { x: (r.minX + r.maxX) / 2, y: (r.minY + r.maxY) / 2, z: (r.minZ + r.maxZ) / 2 };
      }
      case 'fire': {
        for (const p of effect.points) {
          const field = this.engine.projectiles.fire.ignite({ id: `trap-${++this.serial}`, x: p.x, y: p.y, z: p.z,
            owner: null, ownerId: '', chaosLevel: 0 }, ctx);
          if (field && effect.durationMs) field.expiresAt = now + effect.durationMs;
        }
        return { ...effect.points[0] };
      }
      default:
        return { x: 0, y: 0, z: 0 };
    }
  }

  eachCell(region, fn) {
    const { sx, sy, sz } = this.engine.world.dimensions;
    for (let y = Math.max(1, region.minY); y <= Math.min(sy - 1, region.maxY); y++) {
      for (let z = Math.max(0, region.minZ); z <= Math.min(sz - 1, region.maxZ); z++) {
        for (let x = Math.max(0, region.minX); x <= Math.min(sx - 1, region.maxX); x++) fn(x, y, z);
      }
    }
  }

  setBlock(x, y, z, value) {
    this.engine.world.setBlock(x, y, z, value);
    this.engine.pushBlockDelta(x, y, z, value);
  }

  /** A living body overlaps the voxel; solid blocks never appear inside a player. */
  occupied(x, y, z) {
    const reach = PHYSICS.halfW + 0.5;
    for (const p of this.engine.entities.values()) {
      if (p.state !== 'alive') continue;
      if (Math.abs(p.x - (x + 0.5)) < reach && Math.abs(p.z - (z + 0.5)) < reach
        && p.y < y + 1 && p.y + PHYSICS.height > y) return true;
    }
    return false;
  }

  restore(fill, force = false) {
    fill.cells = fill.cells.filter((cell) => {
      if (!force && isSolidBlock(cell.from) && this.occupied(cell.x, cell.y, cell.z)) return true;
      if (this.engine.world.getBlock(cell.x, cell.y, cell.z) !== cell.from) this.setBlock(cell.x, cell.y, cell.z, cell.from);
      return false;
    });
  }

  hurt(victim, amount) {
    const lethal = victim.takeDamage(amount, false, null, TRAP_RULES.weaponKey);
    this.engine.tickEvents.push(evHit('', victim.id, amount, false, [victim.x, victim.y + 0.9, victim.z], victim.lastDamage));
    if (lethal) this.engine.killPlayer(victim, null, TRAP_RULES.weaponKey, false, null);
  }

  tick() {
    const now = this.engine.now, live = this.policy.phase === 'live';
    if (live) {
      for (const p of this.engine.entities.values()) {
        const id = String(p.id), down = !!p.input?.keys?.interact, was = this.held.get(id) === true;
        this.held.set(id, down);
        // Bots press buttons through botGoal; humans through the interact key edge.
        if (!down || was || p.bot || !this.admitted(p)) continue;
        const trap = this.nearest(p);
        if (trap) this.trigger(p, trap.id);
      }
    }
    this.volumes = this.volumes.filter((volume) => {
      if (!live || now >= volume.expiresAt) return false;
      if (now < volume.nextAt) return true;
      volume.nextAt = now + volume.intervalMs;
      for (const p of this.engine.entities.values()) {
        if (p.state !== 'alive' || p.spawnProtectedUntil > now) continue;
        if (volume.regions.some((r) => p.x >= r.minX && p.x <= r.maxX && p.y >= r.minY && p.y <= r.maxY
          && p.z >= r.minZ && p.z <= r.maxZ)) this.hurt(p, volume.damage);
      }
      return true;
    });
    for (const fill of this.fills) if (!live || now >= fill.restoreAt) this.restore(fill, !live);
    this.fills = this.fills.filter((fill) => fill.cells.length);
  }

  privateState(id) {
    const player = this.engine.entities.get(String(id));
    if (!this.admitted(player) || !this.defs.length) return {};
    return { traps: this.defs.map((trap) => ({ id: trap.id, name: trap.name, detail: trap.detail,
      ...trap.button, effect: trap.effect.kind, ...this.status(trap) })) };
  }

  /** Traitor bots: use a ready trap once an innocent stands in its effect. */
  botGoal(player) {
    if (!this.admitted(player)) return null;
    const innocents = [...this.engine.entities.values()].filter((p) => p.state === 'alive'
      && this.policy.roles.get(String(p.id)) === 'innocent');
    if (!innocents.length) return null;
    for (const trap of this.defs) {
      if (this.status(trap).state !== 'ready') continue;
      if (!innocents.some((p) => trapEffectContains(trap.effect, p.x, p.y, p.z))) continue;
      if (this.inRange(player, trap)) { this.trigger(player, trap.id); return null; }
      const b = trapButtonPoint(trap);
      if (Math.hypot(player.x - b.x, player.y - b.y, player.z - b.z) <= TRAP_RULES.botApproachRange) {
        return { kind: 'move', target: b, interact: false };
      }
    }
    return null;
  }
}
