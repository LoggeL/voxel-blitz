import { evBlock } from '../../protocol/events.js';
import { BASTION_RULES as R } from '../../../shared/bastion.js';
import { BASTION_STRUCTURES, structureFootprint, canPlaceStructure } from '../../../shared/bastion-build.js';
import { AIR, BARRICADE } from '../../../shared/world/blocks.js';
import { WEAPONS, WEAPON_IDS, PLAYER_HALF } from '../../../shared/combatmath.js';
import { raycastVoxels } from '../../../shared/raycast.js';
import { fireOneShot } from '../../sim/combat.js';
import { aimAngles, wrapAngle } from '../../sim/player.js';
import { turn, slot } from './ai-common.js';

// The sentry fires the LMG's tracer/sfx identity with its own flat damage curve.
export const TURRET_DEF = Object.freeze({ ...WEAPONS.lmg, damage: [12, 12, 40], rpm: 360, pellets: 1, headMult: 1,
  spreadDeg: { ...WEAPONS.lmg.spreadDeg, hip: 1.2 }, bloomDeg: 0 });
const CRATE_TICK_MS = 250;
const key = (x, y, z) => `${x},${y},${z}`;

/** Player-built fortifications: barricade voxels plus turret/crate objectives. */
export class BastionStructures {
  constructor(engine, policy) {
    this.engine = engine; this.policy = policy;
    this.items = new Map();      // id -> structure objective
    this.built = new Map();      // voxel index -> { kind, stage, owner, at }
    this.cells = new Set();      // "x,y,z" of objective-kind structure cells
    this.crateUsed = new Set();  // "crateId:playerId", cleared at every startWave
    this.serial = 0; this.currentStage = 0; this.crateAt = 0;
  }
  get now() { return this.engine.now; }
  index(c) { const { sx, sz } = this.engine.world.dimensions; return ((c.y * sz) + c.z) * sx + c.x; }
  cellOf(i) { const { sx, sz } = this.engine.world.dimensions; return { x: i % sx, z: Math.floor(i / sx) % sz, y: Math.floor(i / (sx * sz)) }; }
  getBlock(x, y, z) { return this.engine.world.getBlock(x, y, z); }
  /** A cell NPCs must breach: a barricade voxel or a turret/crate footprint. */
  isBuiltCell(x, y, z) { return this.getBlock(x, y, z) === BARRICADE || this.cells.has(key(x, y, z)); }
  structureAt(x, y, z) {
    for (const t of this.items.values()) if (t.cell.x === x && t.cell.y === y && t.cell.z === z) return t;
    return null;
  }
  onStageChange(i) { this.currentStage = i; }
  clear() {
    for (const t of this.items.values()) this.engine.objectives.delete(t.id);
    if (this.cells.size) this.engine.blockRevision++;
    this.items.clear(); this.built.clear(); this.cells.clear(); this.crateUsed.clear();
  }
  rows() {
    return [...this.items.values()].map(t => ({ id: t.id, kind: t.structure, x: t.x, y: t.y, z: t.z, facing: t.facing,
      yaw: Math.round(t.yaw * 100) / 100, hp: t.hp, maxHp: t.maxHp, ammo: t.ammo, charges: t.charges, owner: t.owner, stage: t.stage }));
  }
  budget() {
    let voxels = 0;
    for (const [i, row] of this.built) {
      const c = this.cellOf(i);
      if (this.getBlock(c.x, c.y, c.z) !== BARRICADE) { this.built.delete(i); continue; }
      if (row.stage === this.currentStage) voxels++;
    }
    const alive = kind => [...this.items.values()].filter(t => t.structure === kind && t.state === 'alive' && t.stage === this.currentStage).length;
    return { barricadeVoxels: { used: voxels, max: R.build.barricadeVoxels },
      turrets: { used: alive('turret'), max: R.build.turrets }, crates: { used: alive('crate'), max: R.build.crates } };
  }
  /** Any alive combatant whose body box overlaps a footprint cell blocks placement. */
  occupied(cells) {
    for (const p of this.engine.combatants.values()) {
      if (p.state !== 'alive') continue;
      const hx = p.combatBox ? p.combatBox[0] : PLAYER_HALF.x, hz = p.combatBox ? p.combatBox[2] : PLAYER_HALF.x;
      const top = p.y + (p.combatBox ? p.combatBox[1] * 2 : PLAYER_HALF.h * 2);
      for (const c of cells) {
        if (p.x + hx > c.x && p.x - hx < c.x + 1 && top > c.y && p.y < c.y + 1 && p.z + hz > c.z && p.z - hz < c.z + 1) return true;
      }
    }
    return false;
  }
  place(p, req) {
    const { engine, policy } = this, def = BASTION_STRUCTURES[req.item];
    const res = canPlaceStructure({ getBlock: (x, y, z) => this.getBlock(x, y, z), layout: policy.layout, stageIndex: policy.stageIndex,
      kind: req.item, cell: req.cell, facing: req.facing, player: p, phase: policy.phase, budget: this.budget(),
      credits: policy.availableCredits(), structures: this.rows(), occupied: cells => this.occupied(cells) });
    if (!res.ok) return false;
    const cell = req.cell, cells = structureFootprint(req.item, cell, req.facing);
    if (def.kind === 'block') {
      for (const c of cells) {
        engine.world.setBlock(c.x, c.y, c.z, BARRICADE); engine.pushBlockDelta(c.x, c.y, c.z, BARRICADE);
        engine.tickEvents.push(evBlock(c.x, c.y, c.z, BARRICADE, AIR));
        this.built.set(this.index(c), { kind: req.item, stage: this.currentStage, owner: p.id, at: this.now });
      }
    } else {
      const t = {
        id: `struct-${policy.run}-${++this.serial}`, objective: true, structure: req.item, name: def.name, owner: p.id, stage: this.currentStage,
        cell: { x: cell.x, y: cell.y, z: cell.z }, x: cell.x + 0.5, y: cell.y, z: cell.z + 0.5, facing: req.facing, yaw: req.facing * Math.PI / 2, pitch: 0,
        eyeY: cell.y + def.half[1], combatBox: [...def.half], state: 'alive', hp: def.hp, maxHp: def.hp, armor: 0, vx: 0, vy: 0, vz: 0,
        lastDamage: null, spawnProtectedUntil: 0, team: 'alpha', kills: 0, score: 0, deaths: 0,
        ammo: def.ammo ?? 0, charges: def.charges ?? 0, cooldown: 0, target: null, shooter: null,
        takeDamage(dmg, _hs, attacker) {
          if (policy.phase !== 'live' || !attacker?.npcRole || this.state !== 'alive') return false;
          this.hp = Math.max(0, this.hp - dmg); this.lastDamage = { at: policy.now }; return this.hp === 0;
        },
      };
      engine.objectives.set(t.id, t); this.items.set(t.id, t); this.cells.add(key(cell.x, cell.y, cell.z));
      engine.blockRevision++; // footprints are navigation walls; the keyed rebuild must see them
    }
    policy.credits -= def.price;
    p.bastionBuild = { kind: req.item, x: cell.x, y: cell.y, z: cell.z, facing: req.facing, at: this.now };
    policy.emit('bastion_build', { kind: req.item, x: cell.x, y: cell.y, z: cell.z, name: p.name, price: def.price });
    return true;
  }
  /** Turrets near a charged crate refill for free; every turret refills at each break. */
  refillTurrets(all = false) {
    const crates = [...this.items.values()].filter(t => t.structure === 'crate' && t.state === 'alive' && t.charges > 0);
    for (const t of this.items.values()) {
      if (t.structure !== 'turret' || t.state !== 'alive') continue;
      if (all || crates.some(c => Math.hypot(c.x - t.x, c.z - t.z) <= BASTION_STRUCTURES.crate.turretRadius)) t.ammo = BASTION_STRUCTURES.turret.ammo;
    }
  }
  refillAll() { this.refillTurrets(true); }
  tick(dt) {
    const { engine, policy } = this;
    for (const t of this.items.values()) {
      if (t.hp > 0 && t.state === 'alive') continue;
      engine.objectives.delete(t.id); this.items.delete(t.id); this.cells.delete(key(t.cell.x, t.cell.y, t.cell.z));
      engine.blockRevision++;
      policy.emit('bastion_structure', { id: t.id, kind: t.structure, x: t.cell.x, y: t.cell.y, z: t.cell.z, destroyed: true });
    }
    if (policy.phase === 'live') for (const t of this.items.values()) if (t.structure === 'turret') this.turretTick(t, dt);
    if ((policy.phase === 'live' || policy.phase === 'supply') && this.now >= this.crateAt) {
      this.crateAt = this.now + CRATE_TICK_MS;
      for (const t of this.items.values()) if (t.structure === 'crate') this.crateTick(t);
    }
  }
  sightPoint(npc) { return [npc.x, npc.y + (npc.combatBox ? npc.combatBox[1] : 1.1 * (npc.bodyScale || 1)), npc.z]; }
  canSee(origin, point) {
    const delta = point.map((v, i) => v - origin[i]), length = Math.hypot(...delta);
    return !this.engine.projectiles.smoke.blocksSight(origin, point, this.now)
      && !raycastVoxels(this.engine.solidAt, ...origin, ...delta, Math.max(0, length - 0.1));
  }
  turretTick(t, dt) {
    const def = BASTION_STRUCTURES.turret, origin = [t.x, t.eyeY, t.z];
    t.cooldown -= dt;
    let best = null, bestDist = def.range;
    for (const npc of this.engine.npcs.values()) {
      if (npc.state !== 'alive') continue;
      const d = Math.hypot(npc.x - t.x, npc.z - t.z);
      if (d >= bestDist) continue;
      const point = this.sightPoint(npc);
      if (!this.canSee(origin, point)) continue;
      best = { npc, point }; bestDist = d;
    }
    t.target = best?.npc.id ?? null;
    if (!best) return;
    const angles = aimAngles(origin, best.point);
    t.yaw = turn(t.yaw, angles.yaw, def.turnRate * dt); t.pitch = turn(t.pitch, angles.pitch, def.turnRate * dt);
    if (Math.abs(wrapAngle(angles.yaw - t.yaw)) >= 0.12 || Math.abs(angles.pitch - t.pitch) >= 0.12) return;
    if (t.cooldown > 0 || t.ammo <= 0) return;
    const shooter = this.shooterFor(t);
    shooter.cooldown = 0;
    fireOneShot(shooter, this.engine.contexts.combat);
    t.ammo--; t.cooldown = 60 / def.rpm;
  }
  /** Minimal shooter duck-type for fireOneShot, cached per turret; `bot` skips victim rewind. */
  shooterFor(t) {
    if (t.shooter) return t.shooter;
    t.shooter = { id: t.id, structure: 'turret', bot: true, team: 'alpha',
      get x() { return t.x; }, get y() { return t.y; }, get z() { return t.z; }, get eyeY() { return t.eyeY; },
      get yaw() { return t.yaw; }, get pitch() { return t.pitch; },
      def: TURRET_DEF, weapon: slot('lmg'), mag: WEAPON_IDS.map(() => Infinity), reserve: [], cooldown: 0, firing: false,
      shotSeq: 0, bloom: 0, exhaustion: 0, panic: 0, pain: 0, adsT: 1, crouch: false, vx: 0, vz: 0,
      spawnProtectedUntil: 0, spawnProtected: false, minigun: null, input: null, state: 'alive', hist: null,
      kills: 0, score: 0 };
    return t.shooter;
  }
  crateTick(t) {
    const { policy } = this, def = BASTION_STRUCTURES.crate;
    if (t.charges <= 0) return;
    for (const p of this.engine.entities.values()) {
      if (t.charges <= 0) break;
      const used = `${t.id}:${p.id}`;
      if (p.state !== 'alive' || !policy.active.has(p.id) || this.crateUsed.has(used)) continue;
      if (Math.hypot(p.x - t.x, p.y - t.y, p.z - t.z) > def.radius) continue;
      p.hp = Math.min(100, p.hp + 25);
      const primary = policy.players.get(p.id)?.primary, i = slot(primary), w = WEAPONS[primary];
      if (i >= 0) {
        const unit = w.reloadStages ? w.magSize : 1;
        p.reserve[i] = Math.min(p.reserve[i] + unit, unit * (3 + (policy.upgrades.reserve ? 1 : 0)));
      }
      t.charges--; this.crateUsed.add(used); policy.emit('bastion_pickup', { id: p.id });
    }
  }
}
