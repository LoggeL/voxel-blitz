/**
 * Attrition minions (docs/titanfall.md §10; WP8): squads of GRUNTS (rifle
 * infantry, 100 hp, 1 point) and SPECTRES (robotic, 200 hp, 2 points) that
 * drop in waves at each team's side of the play area, advance on the
 * midfield and fight whatever enemy they see within 40 m.
 *
 * Minions are real combat bodies (PlayerEntity in `engine.npcs`, the Bastion
 * pattern): hitscan, projectiles, blasts and titan mounts reach them through
 * `engine.combatants`, they fire through the stock weapon path
 * (`resolveWeaponIntent`) with a per-body tuned weapon `def`, and they move
 * through `stepMovement` like any body. They are not players: no lobby slot,
 * no respawn, no player row. The wire carries them compactly in
 * `match.titanfall.npc` (`wire()`), the engine leaves `tfNpc` bodies out of
 * the player rows, and the policy routes their deaths here (`onDeath`,
 * `scoreFor`). Titans crush them on contact (moving legs, landing drop);
 * this system checks that itself because TitanSystem's crush passes only see
 * players.
 *
 * Everything here runs only for a titanfall policy: the system is created by
 * TitanfallPolicy and its tick hook unregisters itself once the engine's
 * policy is a different one.
 */
import { WEAPONS, WEAPON_IDS } from '../../../shared/combatmath.js';
import { isSolidBlock } from '../../../shared/worlddata.js';
import { FLUID_BLOCKS } from '../../../shared/world/blocks.js';
import { boxCollides, PHYSICS } from '../../../shared/player-movement.js';
import { raycastVoxels } from '../../../shared/raycast.js';
import { TITAN_RULES, titanFrame } from '../../../shared/vehicle-handling/titan.js';
import { TEAM_IDS } from '../../../shared/modes.js';
import { PlayerEntity, aimAngles, wrapAngle } from '../player.js';
import { navigationWaypoint } from '../../bot-navigation.js';
import { isPerceivable } from './perception.js';

const ALPHA = TEAM_IDS[0], BRAVO = TEAM_IDS[1];

/** Tuning (docs/titanfall.md §10). Weapon `def` fields override the stock weapon for minions only. */
export const GRUNT_RULES = Object.freeze({
  kinds: Object.freeze({
    grunt: Object.freeze({ code: 0, name: 'GRUNT', hp: 100, points: 1, speed: 0.8, weapon: 'rifle',
      def: Object.freeze({ damage: [10, 6, 45], headMult: 1.5, rpm: 480, hip: 2.2, bloomDeg: 0.25, bloomMaxDeg: 3.4 }),
      burst: Object.freeze([3, 6]), pauseMs: Object.freeze([650, 1500]), reactMs: Object.freeze([450, 900]),
      // Aim error: radians of yaw/pitch noise per burst, scaled up with range.
      aimError: 0.03, aimErrorPerM: 0.0016, noPanic: false }),
    spectre: Object.freeze({ code: 1, name: 'SPECTRE', hp: 200, points: 2, speed: 0.72, weapon: 'smg',
      def: Object.freeze({ damage: [13, 8, 40], headMult: 1.4, rpm: 330, hip: 1.5, bloomDeg: 0.18, bloomMaxDeg: 2.6 }),
      burst: Object.freeze([2, 4]), pauseMs: Object.freeze([550, 1200]), reactMs: Object.freeze([300, 650]),
      aimError: 0.022, aimErrorPerM: 0.0011, noPanic: true }),
  }),
  squadSize: 4,
  capPerTeam: 12,
  firstWaveMs: 6000,
  waveMs: 16000,
  spectreChance: 0.3,
  sightRange: 40,
  titanRange: 55,
  thinkMs: 200,
  /** Range at which an engaged minion stops advancing on its target. */
  holdRange: 24,
  /** With no target, a magazine below this fraction is reloaded (an empty one always is). */
  reloadIdleBelow: 0.4,
  /** A target lost from sight this recently and seen again is the same engagement (no new reaction delay). */
  recallMs: 1500,
  /** A crouched minion stands this long before its next burst. */
  standLeadMs: 150,
  /** Points of the titan meter a pilot gains per minion kill. */
  meterPerKill: 0.02,
  /** A dead minion's row stays this long (the client plays the death), then the body is removed. */
  corpseMs: 700,
  /** Watchdog: no progress for stuckMs → hop and re-route; for giveUpMs → removed without a kill. */
  stuckMs: 2500,
  giveUpMs: 24000,
  /** Leg crush: a walker moving faster than this (m/s) kills a minion in its footprint (+pad m). */
  crushSpeed: TITAN_RULES.crush?.minSpeed ?? 1.5,
  crushPad: 0.35,
});

const KIND_BY_CODE = Object.freeze(Object.keys(GRUNT_RULES.kinds));
const finite = (value, fallback = 0) => (Number.isFinite(value) ? value : fallback);
const r1 = value => Math.round(value * 10) / 10;
const r2 = value => Math.round(value * 100) / 100;
const between = (rng, [lo, hi]) => lo + rng() * (hi - lo);

/** Minion weapon defs, built once per kind on the stock weapon. */
const KIND_DEFS = Object.freeze(Object.fromEntries(Object.entries(GRUNT_RULES.kinds).map(([kind, k]) => {
  const base = WEAPONS[k.weapon];
  return [kind, Object.freeze({ ...base, damage: [...k.def.damage], headMult: k.def.headMult, rpm: k.def.rpm,
    bloomDeg: k.def.bloomDeg, bloomMaxDeg: k.def.bloomMaxDeg,
    spreadDeg: { ...base.spreadDeg, hip: Math.max(base.spreadDeg.hip, k.def.hip) } })];
})));

/** Deterministic LCG fallback when no rng is given. */
function lcg(seed) {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
}

export class GruntSystem {
  /**
   * @param engine GameEngine (npcs, combatants, world, solidAt, registerTickHook, killPlayer)
   * @param policy TitanfallPolicy (phase, teamFor, isEnemy, teamSpawnPool, playArea, titans, _addScore)
   */
  constructor(engine, policy, { rng = null, enabled = true } = {}) {
    this.engine = engine;
    this.policy = policy;
    this.rng = typeof rng === 'function' ? rng : lcg(0x9e1a);
    this.enabled = enabled !== false;
    this.serial = 0;
    this.squadSerial = 0;
    this.errors = 0;
    this.lastError = null;
    this.stats = { spawned: 0, killed: 0, crushed: 0, removed: 0 };
    this.titanTrack = new Map();
    this.lanes = null;
    this.reset();
    this.unhook = typeof engine?.registerTickHook === 'function' ? engine.registerTickHook(dt => this.tick(dt)) : null;
  }

  /** Remove every minion and restart the wave clock (match start / reset). */
  reset() {
    for (const p of this.list()) this.engine.npcs?.delete(p.id);
    this.nextWave = { [ALPHA]: this.now + GRUNT_RULES.firstWaveMs, [BRAVO]: this.now + GRUNT_RULES.firstWaveMs + 1500 };
    this.titanTrack.clear();
    this.lanes = null;
  }

  get now() { return finite(this.engine?.now); }

  /** This system's bodies (alive and dying). */
  *list() {
    const npcs = this.engine?.npcs;
    if (!npcs) return;
    for (const p of npcs.values()) if (p.tfNpc && p.tfNpc.system === this) yield p;
  }

  alive(team = null) {
    let n = 0;
    for (const p of this.list()) if (p.state === 'alive' && (team == null || p.team === team)) n++;
    return n;
  }

  /** Per-tick upkeep (engine tick hook, before movement and weapons). */
  tick(dt) {
    const engine = this.engine;
    if (engine?.mode?.policy && engine.mode.policy !== this.policy) {
      // A different policy took over this engine: leave no minions behind.
      for (const p of this.list()) engine.npcs.delete(p.id);
      this.unhook?.();
      this.unhook = null;
      return;
    }
    try {
      this._tick(dt);
    } catch (error) {
      this.errors++;
      this.lastError = error;
    }
  }

  _tick(dt) {
    const now = this.now, live = this.policy.phase === 'live';
    // Corpses leave after their death has reached the wire.
    for (const p of [...this.list()]) {
      if (p.state !== 'alive' && now >= finite(p.tfNpc.removeAt, now)) this.engine.npcs.delete(p.id);
    }
    if (!live) {
      for (const p of this.list()) this._idle(p);
      return;
    }
    if (this.enabled) for (const team of [ALPHA, BRAVO]) {
      if (now < this.nextWave[team]) continue;
      this.nextWave[team] = now + GRUNT_RULES.waveMs;
      if (this.alive(team) + GRUNT_RULES.squadSize <= GRUNT_RULES.capPerTeam) this.spawnSquad(team);
    }
    this._crush(dt);
    for (const p of this.list()) {
      if (p.state !== 'alive') continue;
      if (![p.x, p.y, p.z].every(Number.isFinite)) { this.remove(p); continue; }
      if (p.tfNpc.hold) { this._idle(p); continue; }   // scripted (tests, captures): no AI
      this._steer(p, dt, now);
    }
  }

  // ---- spawning -------------------------------------------------------------------------

  /** Team-side lanes: { [team]: {x, z} spawn centroid }, the midfield and the across axis. */
  _layout() {
    if (this.lanes) return this.lanes;
    const centroid = team => {
      const pool = this.policy.teamSpawnPool?.(team) ?? [];
      if (!pool.length) return null;
      let x = 0, z = 0;
      for (const s of pool) { x += s.x; z += s.z; }
      return { x: x / pool.length, z: z / pool.length };
    };
    const b = this.policy.playArea?.bounds ?? { minX: 0, maxX: 0, minZ: 0, maxZ: 0 };
    const a = centroid(ALPHA) ?? { x: b.minX + 16, z: (b.minZ + b.maxZ) / 2 };
    const c = centroid(BRAVO) ?? { x: b.maxX - 16, z: (b.minZ + b.maxZ) / 2 };
    const dx = c.x - a.x, dz = c.z - a.z, len = Math.hypot(dx, dz) || 1;
    this.lanes = { [ALPHA]: a, [BRAVO]: c, mid: { x: (a.x + c.x) / 2, z: (a.z + c.z) / 2 },
      axis: { x: dx / len, z: dz / len }, across: { x: -dz / len, z: dx / len }, span: len, bounds: b };
    return this.lanes;
  }

  /**
   * Feet height of a standable column (a solid block with 3 cells of air above,
   * no fluid on top), or null. With `yHint`, the standable level nearest to it
   * (a roof 7 m up is not the ground beside it); without, the topmost.
   */
  _standY(x, z, yHint = null) {
    const world = this.engine.world, sy = world?.dimensions?.sy ?? 64;
    const bx = Math.floor(x), bz = Math.floor(z);
    const hinted = Number.isFinite(yHint);
    const top = hinted ? Math.min(sy - 1, Math.floor(yHint) + 6) : sy - 1;
    let best = null;
    for (let y = top; y >= 0; y--) {
      const block = world.getBlock(bx, y, bz);
      if (FLUID_BLOCKS.has(block)) { if (best == null) return null; break; }
      if (!isSolidBlock(block)) continue;
      let clear = true;
      for (let h = 1; h <= 3 && clear; h++) {
        const above = world.getBlock(bx, y + h, bz);
        if (isSolidBlock(above) || FLUID_BLOCKS.has(above)) clear = false;
      }
      if (!clear) { if (best == null && !hinted) return null; continue; }
      if (!hinted) return y + 1;
      if (best == null || Math.abs(y + 1 - yHint) < Math.abs(best - yHint)) best = y + 1;
      else break;   // levels only get farther from the hint below this one
    }
    return best;
  }

  /** A clear standing spot near (x, z) inside the play area, or null. */
  _spot(x, z, yHint, radius = 3) {
    const b = this._layout().bounds, solidAt = this.engine.solidAt;
    for (let tries = 0; tries < 12; tries++) {
      const r = tries === 0 ? 0 : radius * Math.sqrt(this.rng()), a = this.rng() * Math.PI * 2;
      const px = Math.floor(x + Math.cos(a) * r) + 0.5, pz = Math.floor(z + Math.sin(a) * r) + 0.5;
      if (px < b.minX + 2 || px > b.maxX - 2 || pz < b.minZ + 2 || pz > b.maxZ - 2) continue;
      const y = this._standY(px, pz, yHint);
      if (y == null || boxCollides(solidAt, px, y + 0.02, pz, PHYSICS.height, PHYSICS.halfW + 0.05)) continue;
      return { x: px, y: y + 0.02, z: pz };
    }
    return null;
  }

  /** Drop one squad on `team`'s side (a pilot spawn pushed 10 m toward the midfield). Returns its bodies. */
  spawnSquad(team, kind = null) {
    const lanes = this._layout(), pool = this.policy.teamSpawnPool?.(team) ?? [];
    if (!pool.length) return [];
    kind ??= this.rng() < GRUNT_RULES.spectreChance ? 'spectre' : 'grunt';
    const toward = (s, metres) => {
      const dx = lanes.mid.x - s.x, dz = lanes.mid.z - s.z, len = Math.hypot(dx, dz) || 1;
      return { x: s.x + dx / len * metres, z: s.z + dz / len * metres };
    };
    let anchor = null, squad = null;
    for (let tries = 0; tries < 6 && !anchor; tries++) {
      const s = pool[Math.floor(this.rng() * pool.length)];
      const at = toward(s, 6 + this.rng() * 8);
      anchor = this._spot(at.x, at.z, s.y, 4);
      if (anchor && this._enemyNear(team, anchor, 14)) anchor = null;
      if (!anchor) continue;
      squad = { id: 0, team, kind, goal: null, holdUntil: 0, leg: 0 };
      this._squadGoal(squad, anchor);
      // A squad that cannot route off its drop point would only stand there: try another point.
      if (tries < 5 && !this._routable(anchor, squad.goal)) anchor = null;
    }
    if (!anchor) return [];
    squad.id = ++this.squadSerial;
    const bodies = [];
    for (let i = 0; i < GRUNT_RULES.squadSize; i++) {
      const at = i === 0 ? anchor : this._spot(anchor.x + ((i & 1) ? 1.6 : -1.6), anchor.z + ((i & 2) ? 1.6 : -1.6), anchor.y, 2);
      if (!at) continue;
      bodies.push(this.spawn(kind, team, at, squad, i));
    }
    return bodies;
  }

  /** One minion body at `at` (feet), facing the midfield. */
  spawn(kind, team, at, squad = null, slot = 0) {
    const profile = GRUNT_RULES.kinds[kind], engine = this.engine;
    if (!profile) return null;
    const serial = ++this.serial, id = `tfg${serial}`;
    const p = new PlayerEntity(id, profile.name, { x: at.x, y: at.y, z: at.z }, true, engine.world?.dimensions);
    const weapon = WEAPON_IDS.indexOf(profile.weapon), def = KIND_DEFS[kind];
    squad ??= { id: ++this.squadSerial, team, kind, goal: null, holdUntil: 0, leg: 0 };
    Object.assign(p, {
      npcRole: kind, team, hp: profile.hp, maxHp: profile.hp, armor: 0, weapon, owned: [profile.weapon],
      infiniteMagazines: true, grenades: (p.grenades ?? []).map(() => 0), noPanic: profile.noPanic,
      npcSpeed: profile.speed * (0.94 + this.rng() * 0.12), bodyScale: 1,
      tfNpc: { system: this, serial, kind, code: profile.code, squad, slot, removeAt: 0,
        target: null, targetKind: null, aimPoint: null, seenAt: 0, fireAt: 0, burstLeft: 0, pauseUntil: 0,
        thinkAt: engine.now + (serial % 12) * (GRUNT_RULES.thinkMs / 12), errYaw: 0, errPitch: 0,
        waypoint: null, wpHeld: null, moveGoal: null, blocked: false, unstickUntil: 0, unstickX: 0, unstickZ: 0, nav: {}, watchX: at.x, watchZ: at.z, watchAt: engine.now, progressAt: engine.now,
        cover: null, coverAt: 0, crouch: false, hold: false, strafe: 0, strafeUntil: 0, hurtBy: null, hurtAt: 0, firing: false, lost: null, lostAt: 0 },
    });
    if (p.medkit) p.medkit.remaining = 0;
    // Minion weapons: the stock weapon with minion damage, cadence and spread.
    Object.defineProperty(p, 'def', { get: () => def, configurable: true });
    p.beforeDamage = (dmg, attacker) => {
      if (attacker && String(attacker.id) !== id) { p.tfNpc.hurtBy = attacker; p.tfNpc.hurtAt = engine.now; }
      return dmg;
    };
    const mid = this._layout().mid;
    p.yaw = aimAngles([p.x, 0, p.z], [mid.x, 0, mid.z]).yaw;
    p.pitch = 0;
    p.input = { keys: {}, wantFire: false, reload: false, yaw: p.yaw, pitch: p.pitch, viewYaw: p.yaw };
    engine.npcs.set(id, p);
    this.stats.spawned++;
    return p;
  }

  /** True when the map's navigation leads a body at `from` off toward `to` (a failed route answers with `from` itself). */
  _routable(from, to) {
    if (!to || Math.hypot(to.x - from.x, to.z - from.z) <= 1.2) return true;
    const wp = navigationWaypoint(this.engine.world, from, to, {}, this.now);
    // A real route looks ahead along clear walks; a failed one answers with
    // `from` or the node under it.
    return !!wp && Math.hypot(wp.x - from.x, wp.z - from.z) > 1.5;
  }

  _enemyNear(team, at, radius) {
    for (const o of this.engine.combatants.values()) {
      if (o.state !== 'alive' || this.policy.teamFor(o) === team || this.policy.teamFor(o) == null) continue;
      if (Math.hypot(o.x - at.x, o.z - at.z) < radius) return true;
    }
    return false;
  }

  /** Remove a body without a kill (stuck, out of the world): no score, no feed entry. */
  remove(p) {
    if (this.engine.npcs.get(p.id) !== p) return;
    this.engine.npcs.delete(p.id);
    this.stats.removed++;
  }

  // ---- squads and goals ----------------------------------------------------------------------

  /** Next squad goal: a midfield lane point first, then pushes 30 % further toward the enemy side. */
  _squadGoal(squad, from) {
    const lanes = this._layout(), b = lanes.bounds, sign = squad.team === ALPHA ? 1 : -1;
    const push = Math.min(0.42, squad.leg * 0.14) * lanes.span * sign;
    const lateral = (this.rng() * 2 - 1) * Math.min(48, lanes.span * 0.3);
    let x = lanes.mid.x + lanes.axis.x * push + lanes.across.x * lateral;
    let z = lanes.mid.z + lanes.axis.z * push + lanes.across.z * lateral;
    x = Math.max(b.minX + 8, Math.min(b.maxX - 8, x));
    z = Math.max(b.minZ + 8, Math.min(b.maxZ - 8, z));
    const spot = this._spot(x, z, from?.y ?? null, 6) ?? { x, y: from?.y ?? 0, z };
    squad.goal = spot;
    squad.leg++;
    squad.holdUntil = 0;
    return spot;
  }

  /** The squad member's own goal: the squad goal plus its formation slot. */
  _memberGoal(p) {
    const ai = p.tfNpc, g = ai.squad.goal, lanes = this._layout();
    if (!g) return null;
    const lateral = ((ai.slot & 1) ? 1 : -1) * 2.2, back = (ai.slot & 2) ? -2.2 : 0;
    const sign = p.team === ALPHA ? 1 : -1;
    return { x: g.x + lanes.across.x * lateral + lanes.axis.x * back * sign, y: g.y, z: g.z + lanes.across.z * lateral + lanes.axis.z * back * sign };
  }

  // ---- AI ----------------------------------------------------------------------------------------

  _idle(p) {
    if (!p.input || p.state !== 'alive') return;
    p.input.keys = {};
    p.input.wantFire = false;
  }

  /**
   * The minion's shooting eye: always the standing one. A minion crouches only
   * between bursts and stands to fire, so sight, aim and cover are judged from
   * where the shot will leave, not from the crouched eye (which a waist-high
   * wall hides: the target was dropped and re-acquired with a fresh reaction
   * delay on every crouch).
   */
  _eye(p) {
    return [p.x, p.y + PHYSICS.eye * (p.bodyScale || 1), p.z];
  }

  /** Eye point of a body (or a hull's centre) to aim and look at. */
  _point(target, kind) {
    if (kind === 'titan') return [target.x, target.y + finite(titanFrame(target)?.height, 6) * 0.55, target.z];
    return [target.x, target.y + (target.crouch ? 0.85 : 1.15), target.z];
  }

  _clear(from, to) {
    const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2], len = Math.hypot(dx, dy, dz);
    if (!(len > 0.3)) return true;
    return !raycastVoxels(this.engine.solidAt, from[0], from[1], from[2], dx, dy, dz, len - 0.3);
  }

  /** Nearest visible enemy: pilots and minions within sightRange, titans within titanRange (weighted farther). */
  _acquire(p, now) {
    const team = p.team, eye = this._eye(p), observer = { x: eye[0], y: eye[1], z: eye[2] };
    const candidates = [];
    for (const o of this.engine.combatants.values()) {
      if (o === p || o.state !== 'alive' || o.vehicleId || o.objective) continue;
      const other = this.policy.teamFor(o);
      if (!other || other === team) continue;
      const d = Math.hypot(o.x - p.x, o.y - p.y, o.z - p.z);
      if (d > GRUNT_RULES.sightRange) continue;
      // Pilots first at equal range; the one that shot us most recently first of all.
      let score = d * (o.tfNpc ? 1.15 : 1);
      if (p.tfNpc.hurtBy === o && now - p.tfNpc.hurtAt < 3000) score *= 0.5;
      candidates.push({ o, kind: o.tfNpc ? 'npc' : 'pilot', score });
    }
    for (const v of this.policy.titans?.titans?.() ?? []) {
      if (!(v.hp > 0) || v.dropping || v.team === team) continue;
      const d = Math.hypot(v.x - p.x, v.z - p.z);
      if (d > GRUNT_RULES.titanRange) continue;
      const hurtBy = p.tfNpc.hurtBy, shotUs = now - p.tfNpc.hurtAt < 3000 && hurtBy?.standIn && String(hurtBy.id) === String(v.owner);
      candidates.push({ o: v, kind: 'titan', score: (d * 1.8 + 6) * (shotUs ? 0.5 : 1) });
    }
    candidates.sort((a, b) => a.score - b.score);
    let rays = 0;
    for (const c of candidates) {
      if (c.kind === 'pilot' && !isPerceivable(observer, c.o, now)) continue;
      if (rays++ >= 5) break;
      if (this._clear(eye, this._point(c.o, c.kind))) return c;
    }
    return null;
  }

  /** Still a valid target? (alive, enemy, perceivable, in range, in sight) */
  _keep(p, now) {
    const ai = p.tfNpc, t = ai.target;
    if (!t) return false;
    if (ai.targetKind === 'titan') {
      if (!(t.hp > 0) || t.dropping || !this.engine.vehicles?.vehicles?.has?.(t.id)) return false;
    } else if (t.state !== 'alive' || t.vehicleId || (ai.targetKind === 'npc' && !this.engine.npcs.has(t.id))) return false;
    const eye = this._eye(p), point = this._point(t, ai.targetKind);
    const range = ai.targetKind === 'titan' ? GRUNT_RULES.titanRange : GRUNT_RULES.sightRange + 6;
    if (Math.hypot(point[0] - eye[0], point[2] - eye[2]) > range) return false;
    if (ai.targetKind === 'pilot' && !isPerceivable({ x: eye[0], y: eye[1], z: eye[2] }, t, now)) return false;
    return this._clear(eye, point);
  }

  /** A crouch-cover spot within 4 m: the target sees standing eyes there (to fire from) but not a crouched body. */
  _findCover(p, point) {
    const solidAt = this.engine.solidAt;
    let best = null, bestD = Infinity;
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + this.rng() * 0.5, r = 1.5 + this.rng() * 2.5;
      const x = Math.floor(p.x + Math.cos(a) * r) + 0.5, z = Math.floor(p.z + Math.sin(a) * r) + 0.5;
      const y = this._standY(x, z, p.y);
      if (y == null || Math.abs(y - p.y) > 1.1 || boxCollides(solidAt, x, y + 0.02, z, PHYSICS.height, PHYSICS.halfW)) continue;
      const low = [x, y + 0.75, z];
      if (this._clear(point, low)) continue;           // a crouched body is still exposed
      if (!this._clear([x, y + PHYSICS.eye, z], point)) continue;   // blind there: no shot from this cover
      const d = Math.hypot(x - p.x, z - p.z);
      if (d < bestD) { best = { x, y, z }; bestD = d; }
    }
    return best;
  }

  _think(p, now) {
    const ai = p.tfNpc, profile = GRUNT_RULES.kinds[ai.kind];
    ai.thinkAt = now + GRUNT_RULES.thinkMs;
    if (!this._keep(p, now)) {
      if (ai.target) { ai.lost = ai.target; ai.lostAt = now; }
      const found = this._acquire(p, now);
      // A target that was out of sight for a moment is not a new one: no new reaction delay.
      const fresh = found && found.o !== ai.target && !(found.o === ai.lost && now - ai.lostAt < GRUNT_RULES.recallMs);
      ai.target = found?.o ?? null;
      ai.targetKind = found?.kind ?? null;
      if (fresh) {
        // Reaction time before the first burst; a new aim error.
        ai.fireAt = Math.max(ai.fireAt, now + between(this.rng, profile.reactMs));
        ai.burstLeft = 0;
        ai.cover = null;
      }
      const hurt = !found && now - ai.hurtAt < 2500 ? this._hurtPoint(ai.hurtBy) : null;
      // Shot by something unseen: turn toward it.
      if (hurt) ai.aimPoint = hurt;
    }
    if (ai.target) {
      ai.seenAt = now;
      ai.aimPoint = this._point(ai.target, ai.targetKind);
      // Cover once in a while while engaged (spectres stand their ground).
      if (ai.kind === 'grunt' && now >= ai.coverAt) {
        ai.coverAt = now + 2600 + this.rng() * 1600;
        ai.cover = this._findCover(p, ai.aimPoint);
        ai.crouch = !!ai.cover || this.rng() < 0.35;
      }
      if (now >= ai.strafeUntil) {
        ai.strafeUntil = now + 900 + this.rng() * 1400;
        ai.strafe = ai.cover ? 0 : [-1, 0, 0, 1][Math.floor(this.rng() * 4)];
      }
    } else {
      ai.crouch = false;
      ai.cover = null;
      ai.strafe = 0;
    }
    // Squad goal upkeep: arrive, hold a while, push on.
    const squad = ai.squad, g = squad.goal;
    if (g && Math.hypot(p.x - g.x, p.z - g.z) < 7) {
      if (!squad.holdUntil) squad.holdUntil = now + 9000 + this.rng() * 9000;
      else if (now >= squad.holdUntil) this._squadGoal(squad, p);
    }
    // Waypoint toward the move goal (cover, target or the squad slot).
    const goal = ai.moveGoal = this._moveGoal(p);
    ai.waypoint = goal ? navigationWaypoint(this.engine.world, p, goal, ai.nav, now) : null;
    // A failed route answers with our own spot, or keeps answering with the
    // node we stand on. Wanting to go somewhere, walk straight at the goal
    // instead: it either works, or the stuck watchdog (hop, a random way out,
    // re-route, a new squad goal) takes over rather than idling forever.
    const wp = ai.waypoint, near = wp ? Math.hypot(wp.x - p.x, wp.z - p.z) : Infinity;
    if (!wp || !ai.wpHeld || Math.hypot(wp.x - ai.wpHeld.x, wp.z - ai.wpHeld.z) > 0.3) ai.wpHeld = wp ? { x: wp.x, z: wp.z, since: now } : null;
    ai.blocked = !!(goal && wp && Math.hypot(goal.x - p.x, goal.z - p.z) > 1.2
      && (near <= 0.35 || (near < 1.5 && now - ai.wpHeld.since > 1500)));
    if (ai.blocked) ai.waypoint = goal;
  }

  /**
   * A finite point to turn toward for whatever last hurt us, or null. An
   * auto-titan's stand-in attacker has no position: its owner's hull stands in.
   */
  _hurtPoint(source) {
    if (!source) return null;
    if (source.standIn) {
      const hull = this.policy.titans?.ownedBy?.(source.id);
      return hull && hull.hp > 0 && !hull.dropping ? this._point(hull, 'titan') : null;
    }
    if (source.state !== 'alive') return null;
    const point = [source.x, source.y + 1.2, source.z];
    return point.every(Number.isFinite) ? point : null;
  }

  /** Where the body walks: its cover spot, toward a far target, or its squad slot; null to hold. */
  _moveGoal(p) {
    const ai = p.tfNpc;
    if (ai.cover) return Math.hypot(ai.cover.x - p.x, ai.cover.z - p.z) > 0.6 ? ai.cover : null;
    if (ai.target) {
      const t = ai.target, d = Math.hypot(t.x - p.x, t.z - p.z);
      if (ai.targetKind === 'titan' || d <= GRUNT_RULES.holdRange) return null;
      return { x: t.x, y: t.y, z: t.z };
    }
    const g = this._memberGoal(p);
    return g && Math.hypot(g.x - p.x, g.z - p.z) > 1.2 ? g : null;
  }

  _steer(p, dt, now) {
    const ai = p.tfNpc, profile = GRUNT_RULES.kinds[ai.kind], input = p.input;
    if (now >= ai.thinkAt) this._think(p, now);
    input.keys = {};
    input.wantFire = false;
    input.reload = false;
    // Look: at the target (with this burst's error), along the walk, or toward the midfield.
    let wantYaw = p.yaw, wantPitch = 0;
    const eye = this._eye(p);
    if (ai.aimPoint) {
      const a = aimAngles(eye, ai.aimPoint);
      wantYaw = a.yaw + (ai.target ? ai.errYaw : 0);
      wantPitch = a.pitch + (ai.target ? ai.errPitch : 0);
    } else if (ai.waypoint) {
      wantYaw = aimAngles(eye, [ai.waypoint.x, eye[1], ai.waypoint.z]).yaw;
    }
    // A non-finite look (a bad aim point) never reaches the body: it would stick for good.
    if (!Number.isFinite(wantYaw) || !Number.isFinite(wantPitch)) { ai.aimPoint = null; wantYaw = finite(p.yaw); wantPitch = 0; }
    if (!Number.isFinite(p.yaw)) p.yaw = wantYaw;
    if (!Number.isFinite(p.pitch)) p.pitch = 0;
    const rate = (ai.target ? 5.5 : 3.2) * dt;
    p.yaw = p.yaw + Math.max(-rate, Math.min(rate, wrapAngle(wantYaw - p.yaw)));
    p.pitch = Math.max(-1.2, Math.min(1.2, p.pitch + Math.max(-rate, Math.min(rate, wantPitch - p.pitch))));
    input.yaw = p.yaw;
    input.pitch = p.pitch;
    if (!ai.target) ai.aimPoint = ai.hurtBy && now - ai.hurtAt < 2500 ? ai.aimPoint : null;
    // Move: toward the waypoint, with separation from squadmates; strafe while engaged.
    const wp = ai.waypoint;
    let moving = false;
    if (wp && Math.hypot(wp.x - p.x, wp.z - p.z) > 0.35) {
      let mx = wp.x - p.x, mz = wp.z - p.z;
      const len = Math.hypot(mx, mz) || 1;
      mx /= len; mz /= len;
      // Unsticking: walk a random way out of the pocket for a moment.
      if (now < ai.unstickUntil) { mx = ai.unstickX; mz = ai.unstickZ; }
      for (const o of this.engine.npcs.values()) {
        if (o === p || o.state !== 'alive') continue;
        const dx = p.x - o.x, dz = p.z - o.z, d2 = dx * dx + dz * dz;
        if (d2 < 1.44 && d2 > 1e-6) { const d = Math.sqrt(d2); mx += dx / d * (1.2 - d); mz += dz / d * (1.2 - d); }
      }
      input.viewYaw = Math.atan2(-mx, -mz);
      input.keys.f = true;
      moving = true;
    } else if (ai.target && ai.strafe) {
      input.viewYaw = p.yaw;
      input.keys[ai.strafe > 0 ? 'r' : 'l'] = true;
      moving = true;
    } else input.viewYaw = p.yaw;
    // Crouch between bursts only; stand up just before the next one to fire.
    input.keys.crouch = !!(ai.target && ai.crouch && !moving && ai.burstLeft <= 0 && now < ai.fireAt - GRUNT_RULES.standLeadMs);
    // Swimming: keep the head above water (a submerged head drowns) and wade on.
    if (p.swimming) { input.keys.jump = true; input.keys.crouch = false; }
    // Watchdog: wanting to move without progress → hop, then re-route; at giveUpMs → removed.
    if (!moving || Math.hypot(p.x - ai.watchX, p.z - ai.watchZ) > 1.2) {
      ai.watchX = p.x; ai.watchZ = p.z; ai.watchAt = now;
      if (moving || ai.target) ai.progressAt = now;
    } else if (now - ai.watchAt > GRUNT_RULES.stuckMs) {
      input.keys.jump = true;
      if (now - ai.watchAt > GRUNT_RULES.stuckMs * 2) {
        ai.watchAt = now; ai.watchX = p.x; ai.watchZ = p.z;
        ai.nav = {};
        ai.cover = null;
        const a = this.rng() * Math.PI * 2;
        ai.unstickX = Math.cos(a); ai.unstickZ = Math.sin(a); ai.unstickUntil = now + 1400;
        if (!ai.target) this._squadGoal(ai.squad, p);
      }
    }
    if (!ai.target && now - ai.progressAt > GRUNT_RULES.giveUpMs) { this.remove(p); return; }
    // Fire: bursts at the target after the reaction delay, while roughly on aim.
    if (ai.target && ai.aimPoint) {
      const a = aimAngles(eye, ai.aimPoint);
      const onAim = Math.abs(wrapAngle(a.yaw + ai.errYaw - p.yaw)) < 0.12;
      if (now >= ai.fireAt && onAim) {
        if (ai.burstLeft <= 0) {
          ai.burstLeft = Math.round(between(this.rng, profile.burst));
          ai.burstShots = p.shotSeq;
          const range = Math.hypot(ai.aimPoint[0] - eye[0], ai.aimPoint[2] - eye[2]);
          const sigma = profile.aimError + profile.aimErrorPerM * range;
          ai.errYaw = (this.rng() + this.rng() - 1) * sigma * 1.6;
          ai.errPitch = (this.rng() + this.rng() - 1) * sigma;
        }
        if (p.shotSeq - ai.burstShots >= ai.burstLeft) {
          ai.burstLeft = 0;
          ai.fireAt = now + between(this.rng, profile.pauseMs);
        } else input.wantFire = true;
      }
    }
    // Reload: an empty magazine (infiniteMagazines only refills the reserve;
    // without a reload press the mag stays at 0 and the minion stares at its
    // target for good), or a low one with nothing to shoot at.
    const mag = p.mag?.[p.weapon], magSize = p.def?.magSize;
    if (!p.reloading && Number.isFinite(mag) && (mag <= 0 || (!ai.target && mag < magSize * GRUNT_RULES.reloadIdleBelow))) {
      input.reload = true;
      input.wantFire = false;
    }
    ai.firing = input.wantFire;
  }

  // ---- titans ---------------------------------------------------------------------------------

  /** Titans crush minions: a moving walker's footprint, and the footprint of a landing titanfall. */
  _crush(dt) {
    const titans = this.policy.titans;
    if (!titans?.titans) return;
    const seen = new Set();
    for (const v of titans.titans()) {
      seen.add(v.id);
      const prior = this.titanTrack.get(v.id);
      const speed = prior && dt > 0 ? Math.hypot(v.x - prior.x, v.z - prior.z) / dt : 0;
      const landed = prior?.dropping && !v.dropping;
      this.titanTrack.set(v.id, { x: v.x, z: v.z, dropping: !!v.dropping });
      if (!(v.hp > 0) || v.dropping || (!landed && speed < GRUNT_RULES.crushSpeed)) continue;
      const f = titanFrame(v);
      if (!f) continue;
      const pad = landed ? 0.5 : GRUNT_RULES.crushPad, c = Math.cos(v.yaw), s = Math.sin(v.yaw);
      let attacker;
      for (const p of this.list()) {
        if (p.state !== 'alive' || p.team === v.team) continue;
        const dx = p.x - v.x, dz = p.z - v.z, lx = dx * c - dz * s, lz = dx * s + dz * c;
        if (Math.abs(lx) > f.hw + pad + PHYSICS.halfW || Math.abs(lz) > f.hl + pad + PHYSICS.halfW) continue;
        if (p.y > v.y + f.height || p.y + PHYSICS.height < v.y - 1) continue;
        attacker ??= titans.attackerFor?.(v) ?? null;
        if (!attacker) break;
        const key = landed ? TITAN_RULES.drop?.crushKey ?? 'titanfall' : TITAN_RULES.crush?.key ?? 'titan_crush';
        if (typeof titans.crushPilot === 'function' && titans.crushPilot(p, attacker, key)) this.stats.crushed++;
      }
    }
    for (const id of this.titanTrack.keys()) if (!seen.has(id)) this.titanTrack.delete(id);
  }

  // ---- policy hooks ---------------------------------------------------------------------------

  /** Personal score for killing `victim` (engine.killPlayer → policy.killScoreDelta). */
  scoreFor(victim, killer) {
    if (!victim?.tfNpc || !killer || !this.policy.isEnemy(killer, victim)) return 0;
    return GRUNT_RULES.kinds[victim.tfNpc.kind]?.points ?? 0;
  }

  /**
   * A minion died (policy.onPlayerDeath): attrition points to the killer's team,
   * +meterPerKill to a pilot's titan meter, and pilot K/D stays pilot-only.
   */
  onDeath(victim, killer = null) {
    const ai = victim?.tfNpc;
    if (!ai || ai.removeAt) return false;
    ai.removeAt = this.now + GRUNT_RULES.corpseMs;
    ai.target = null;
    this.stats.killed++;
    const policy = this.policy;
    // engine.killPlayer counted this as a kill on the attacker it was given (an
    // auto-titan's stand-in forwards it to the owner): minions stay out of a
    // pilot's K/D in every phase. Resolve the pilot by id, never by identity.
    const scored = !!killer && killer !== victim && String(killer.id) !== String(victim.id);
    const entity = scored ? this.engine.entities?.get(String(killer.id)) ?? null : null;
    const pilot = entity && (entity === killer || killer.standIn) ? entity : null;
    if (pilot) pilot.kills = Math.max(0, (pilot.kills | 0) - 1);
    if (policy.phase !== 'live' || !killer || !policy.isEnemy(killer, victim)) return true;
    const points = GRUNT_RULES.kinds[ai.kind]?.points ?? 0;
    if (pilot) {
      pilot.tfMinionKills = (pilot.tfMinionKills | 0) + 1;
      const titans = policy.titans;
      const holding = titans ? (typeof titans.holdsTitan === 'function' ? titans.holdsTitan(pilot.id) : !!titans.ownedBy?.(pilot.id)) : false;
      if (!holding && typeof policy.setTitanMeter === 'function') {
        policy.setTitanMeter(pilot, policy.titanMeter(pilot) + GRUNT_RULES.meterPerKill);
      }
    }
    const team = policy.teamFor(killer);
    if (points > 0 && team) policy._addScore(team, points);
    return true;
  }

  /** `match.titanfall.npc`: [[serial, kind, team, x, y, z, yaw, hp100, flags]] (flags 1 moving, 2 firing, 4 crouched, 8 dead). */
  wire() {
    const rows = [];
    for (const p of this.list()) {
      const ai = p.tfNpc, dead = p.state !== 'alive';
      const moving = !dead && Math.hypot(finite(p.vx), finite(p.vz)) > 0.4;
      const flags = (moving ? 1 : 0) | (!dead && (ai.firing || p.firing) ? 2 : 0) | (!dead && p.crouch ? 4 : 0) | (dead ? 8 : 0);
      rows.push([ai.serial, ai.code, p.team === BRAVO ? 1 : 0, r1(p.x), r1(p.y), r1(p.z), r2(wrapAngle(p.yaw)),
        dead ? 0 : Math.max(1, Math.min(100, Math.round(p.hp / (p.maxHp || 100) * 100))), flags]);
    }
    return rows;
  }

  dispose() {
    for (const p of [...this.list()]) this.engine.npcs.delete(p.id);
    this.unhook?.();
    this.unhook = null;
  }
}

/** Decode one wire row (tests and the client share the layout). */
export function decodeGruntRow(row) {
  if (!Array.isArray(row) || row.length < 8) return null;
  const flags = row[8] | 0;
  return { serial: row[0] | 0, id: `tfg${row[0] | 0}`, kind: KIND_BY_CODE[row[1] | 0] ?? 'grunt', team: row[2] ? BRAVO : ALPHA,
    x: +row[3], y: +row[4], z: +row[5], yaw: +row[6], hp: row[7] | 0,
    moving: !!(flags & 1), firing: !!(flags & 2), crouch: !!(flags & 4), dead: !!(flags & 8) };
}
