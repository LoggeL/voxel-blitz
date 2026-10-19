// Vehicle pack balance rigs (docs/conquest.md "Vehicle balance"). Headless
// GameEngine fixtures on a flat world that measure, through the real damage
// model, the anti-vehicle weapons of the 2026-10-19 pack (TOW, GUIDED MSL, AT
// MINE, jet bombs) against the counters they sit beside (RX-8 HAVOC, AX-9
// STINGER, the tank's AP and HE shells, the jet's AA missile):
//
// - hitsToKill: direct + splash hits on a hull, through VehicleSystem.damage /
//   explosion (tank armour parts, slopes and ricochets included), sampled from
//   a facing sector like tools/tank-armor-ttk.mjs;
// - shotTimes: the authoritative cadence (magazine, cooldown, reload, rail
//   re-arm, lock) turned into a time to kill;
// - beamTrial: a sight-guided missile from a real mount against a hull driven
//   along a scripted path, by an ideal operator or the Conquest bot gunner;
// - mineTrial / bombSortie: the AT mine under moving hulls, and a two-bomb
//   pass over a squad of infantry.
//
// Every number comes from the data tables; nothing here is tuning.
import { GameEngine } from '../../server/game.js';
import { applyMountedCombat } from '../../server/bot-vehicle-combat.js';
import { mulberry32 } from '../../shared/noise.js';
import { BOT_AIRCRAFT_SIGHT_RANGE } from '../../shared/bot-difficulty.js';
import { WEAPONS } from '../../shared/combatmath.js';
import { KIT_GADGET_AMMO } from '../../shared/conquest-kits.js';
import { GRENADE_TYPE_IDS } from '../../shared/grenade-rules.js';
import { AT_MINE_RULES } from '../../shared/at-mine-rules.js';
import { KITS, VEHICLE_WEAPON_META } from '../../shared/conquest-contract.js';
import { ROCKET_RULES } from '../../shared/rocket-rules.js';
import {
  VEHICLE_DEFS, VEHICLE_WEAPONS, CONQUEST_ROCKET_PROFILE, STINGER_RULES, LOCK_RULES, VEHICLE_DAMAGE_RULES,
  bombReleaseVelocity, mountPose, vehicleMaxHp,
} from '../../shared/vehicle-defs.js';

export const TICK = 1000 / 60;
const ATM = GRENADE_TYPE_IDS.indexOf('atmine');

const vw = key => ({ ...VEHICLE_WEAPONS[key], speed: VEHICLE_WEAPON_META[key].speed });
const heat = w => w.heatPerShot ? { heatPerShot: w.heatPerShot, coolPerSecond: w.coolPerSecond, overheatSeconds: w.overheatSeconds } : {};
/**
 * The weapons under audit. `direct` / `splash` are hull points before armour
 * at classes `cls` / `splashCls` (`perType` replaces `direct` per airframe:
 * the STINGER); `cadence` is what shotTimes needs; `speed` the flight speed.
 */
export const BALANCE_WEAPONS = (() => {
  const t = (key, label, extra = {}) => {
    const w = vw(key);
    return { id: key, label, weapon: key, direct: w.damage, splash: w.splash ?? 0, cls: w.cls, splashCls: w.splashCls ?? w.cls, speed: w.speed,
      cadence: { magazine: w.magazine ?? Infinity, cooldown: w.cooldown, reload: w.reloadSeconds ?? 0, rearm: w.rearmSeconds ?? 0, ...heat(w) }, ...extra };
  };
  const rx8 = WEAPONS.rocket, stinger = WEAPONS.stinger;
  return Object.freeze({
    rocket: { id: 'rocket', label: 'RX-8 HAVOC', weapon: 'rocket', direct: CONQUEST_ROCKET_PROFILE.hullDirect, splash: CONQUEST_ROCKET_PROFILE.hullSplash,
      cls: 'at', splashCls: 'at', speed: ROCKET_RULES.speed, infantry: true,
      cadence: { magazine: 1, cooldown: 60 / rx8.rpm, reload: rx8.reloadTime, carried: KIT_GADGET_AMMO.rocket.mag + KIT_GADGET_AMMO.rocket.reserve } },
    stinger: { id: 'stinger', label: 'AX-9 STINGER', weapon: 'stinger', direct: 0, perType: STINGER_RULES.hullDamage, splash: 0, cls: 'aa', splashCls: 'aa',
      speed: STINGER_RULES.speed, infantry: true, airOnly: true,
      cadence: { magazine: 1, cooldown: 60 / stinger.rpm, reload: stinger.reloadTime, lock: LOCK_RULES.stinger.seconds, relock: true,
        carried: KIT_GADGET_AMMO.stinger.mag + KIT_GADGET_AMMO.stinger.reserve } },
    tankAP: t('tankAP', '120MM AP'),
    tankHE: t('tankHE', '120MM HE'),
    towMissile: t('towMissile', 'TOW MSL'),
    guidedMissile: t('guidedMissile', 'GUIDED MSL'),
    aaMissile: t('aaMissile', 'AA MISSILE', { airOnly: true, cadence: { ...t('aaMissile').cadence, lock: LOCK_RULES.aaMissile.seconds } }),
    // A free-fall bomb comes down steeply (45-80 degrees) onto the roof or the deck.
    jetBomb: t('jetBomb', 'BOMB (direct)', { dive: [45, 80] }),
    atmine: { id: 'atmine', label: 'AT MINE', weapon: 'atmine', direct: AT_MINE_RULES.hullDamage, splash: 0, cls: AT_MINE_RULES.hullCls, splashCls: 'explosive',
      speed: 0, groundOnly: true, fromBelow: true, cadence: { magazine: 1, cooldown: 0, reload: 0, carried: KITS.engineer.grenades.atmine } },
    helicopterRocket: t('helicopterRocket', 'ROCKET POD'),
    chinCannon: t('chinCannon', '25MM CHIN'),
    hmg: t('hmg', '.50 HMG'),
    planeCannon: t('planeCannon', '20MM CANNON'),
  });
})();

/** Facing sectors (degrees from the hull's nose) a shooter fires from. */
export const SECTORS = Object.freeze({ front: [-30, 30], side: [60, 120], rear: [150, 210], 'all-round': [0, 360] });
export const HULL_TYPES = Object.freeze(['jeep', 'jeep_at', 'tank', 'helicopter', 'transport', 'plane']);

/** A flat 1 km conquest world with `spawns` hulls, `players(...)` and the tick helpers. */
export function flatRig(spawns, { size = 1024, floor = 0 } = {}) {
  const dimensions = { sx: size, sy: 96, sz: size }, removed = new Set(), frames = [];
  const world = { dimensions, mapId: 'frontier',
    getBlock: (x, y, z) => y <= floor && y >= 0 && !removed.has(`${x},${y},${z}`) ? 3 : 0,
    setBlock: (x, y, z, value) => { if (!value) removed.add(`${x},${y},${z}`); else removed.delete(`${x},${y},${z}`); return true; },
    heightAt: () => floor, findSpawns: () => [{ x: 20, y: floor + 1, z: 20 }] };
  const game = new GameEngine({ mode: 'conquest', world, broadcast: frame => frames.push(frame),
    mapMeta: { id: 'frontier', dimensions, spawns: { conquest: { alpha: [{ x: 20, y: floor + 1, z: 20 }], bravo: [{ x: 40, y: floor + 1, z: 20 }] } },
      conquest: { flags: [], bases: {}, vehicleSpawns: spawns } } });
  game.now = 100000;
  const player = (id, team, extra = {}) => {
    game.addClient(id, id);
    const p = game.entities.get(id);
    game.mode.policy.setLobbyTeam(p, team);
    Object.assign(p, { x: 20, y: floor + 1, z: 20, hp: 100, armor: 0, spawnProtectedUntil: 0, spawnProtected: false, grounded: true,
      input: { keys: {}, yaw: 0, pitch: 0 }, ...extra });
    return p;
  };
  const vehicle = id => game.vehicles.vehicles.get(id);
  const board = (p, id, seatId) => {
    const v = vehicle(id);
    Object.assign(p, { x: v.x, y: v.y, z: v.z });
    return game.vehicles.enter(p, id, seatId) ? p : null;
  };
  const events = (kind, from = 0) => frames.slice(from).flatMap(frame => frame.events ?? []).filter(event => event.kind === kind);
  const step = () => game.step(TICK);
  return { game, frames, player, vehicle, board, events, step, floor, removed };
}

/** Restore a hull to a fresh, undamaged state between samples. */
export function freshHull(v) {
  Object.assign(v, { hp: vehicleMaxHp(v), disabled: false, burning: false, disabledBy: null, subsystems: null, respawnIn: 0, wreckAge: 0 });
  v.damageLog?.clear?.();
}

function enterBox(o, d, lo, hi) {
  let near = -Infinity, far = Infinity;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-9) { if (o[i] < lo[i] || o[i] > hi[i]) return null; continue; }
    const a = (lo[i] - o[i]) / d[i], b = (hi[i] - o[i]) / d[i];
    near = Math.max(near, Math.min(a, b)); far = Math.min(far, Math.max(a, b));
    if (near > far) return null;
  }
  return near > 0 ? o.map((n, i) => n + d[i] * near) : null;
}

/**
 * One round on hull `v` (yaw 0, level) from a random azimuth of `sector` at
 * a point drawn uniformly over the collider: the splash at the impact, then
 * the direct hit, as ProjectileSystem.explode applies them. A tank plate too
 * steep for an AT round makes it glance off (no damage). Returns the HP dealt
 * and whether the round ricocheted.
 */
export function strike(rig, v, attacker, spec, sector, random) {
  const def = VEHICLE_DEFS[v.type], hw = def.collider.halfWidth, hl = def.collider.halfLength, h = def.height;
  const lo = [v.x - hw, v.y, v.z - hl], hi = [v.x + hw, v.y + h, v.z + hl];
  let point, d;
  if (spec.fromBelow) { point = [v.x + (random() * 2 - 1) * hw * 0.6, v.y + 0.06, v.z + (random() * 2 - 1) * hl * 0.6]; d = [0, 1, 0]; }
  else {
    for (;;) {
      const az = (sector[0] + random() * (sector[1] - sector[0])) * Math.PI / 180;
      // Infantry and ground guns fire nearly level; aircraft and their missiles come from above the horizon.
      const [dipLo, dipHi] = spec.dive ?? (def.handling === 'rotor' || def.handling === 'fixedwing' ? [0, 20] : [0, 6]);
      const down = (dipLo + random() * (dipHi - dipLo)) * Math.PI / 180;
      d = [-Math.sin(az) * Math.cos(down), -Math.sin(down), Math.cos(az) * Math.cos(down)];
      const target = [v.x + (random() * 2 - 1) * hw, v.y + random() * h, v.z + (random() * 2 - 1) * hl];
      point = enterBox(target.map((n, i) => n - d[i] * 60), d, lo, hi);
      if (point) break;
    }
  }
  const before = v.hp;
  const velocity = d.map(n => n * Math.max(1, spec.speed || 40));
  if (spec.cls === 'at' && !spec.fromBelow && rig.game.vehicles.ricochet(v.id, point, velocity, attacker, { cls: 'at', weapon: spec.weapon })) {
    return { dealt: 0, rico: true };
  }
  const radius = Math.max(0.5, VEHICLE_WEAPONS[spec.weapon]?.splashRadius ?? 3);
  if (spec.splash > 0) rig.game.vehicles.explosion(point, radius, spec.splash, attacker, { cls: spec.splashCls });
  const direct = spec.perType ? spec.perType[v.type] ?? 0 : spec.direct;
  if (direct > 0 && v.hp > 0) rig.game.vehicles.damage(v.id, direct, attacker, { cls: spec.cls, point, dir: d, weapon: spec.weapon });
  return { dealt: before - v.hp, rico: false };
}

/** Whether `spec` can hurt hull type `type` at all (seekers, triggers). */
export function canEngage(spec, type) {
  const def = VEHICLE_DEFS[type], air = def.handling === 'rotor' || def.handling === 'fixedwing';
  if (spec.airOnly && !air) return false;
  if (spec.groundOnly && air) return false;
  return true;
}

/**
 * Mean hits to kill (hull at 0 HP) and to disable (the DISABLED state, which
 * burns the hull out unless an Engineer repairs it) for `spec` on hull `type`
 * from `sector`, over `runs` random sequences; plus the ricochet share. Null
 * when the weapon cannot engage that hull.
 */
export function hitsToKill(spec, type, sector = SECTORS['all-round'], { runs = 300, seed = 7, rig = null } = {}) {
  if (!canEngage(spec, type)) return null;
  rig ??= damageRig();
  const v = rig.hulls[type], random = mulberry32(seed);
  let kill = 0, disable = 0, hits = 0, rico = 0, first = 0;
  const counts = [];
  for (let r = 0; r < runs; r++) {
    freshHull(v);
    let n = 0, disabledAt = 0;
    while (v.hp > 0 && n < 400) {
      const before = v.hp;
      const out = strike(rig, v, rig.attacker, spec, sector, random);
      n++; hits++; if (out.rico) rico++;
      if (n === 1) first += before - v.hp;
      if (!disabledAt && (v.disabled || !(v.hp > 0))) disabledAt = n;
    }
    kill += n; disable += disabledAt || n; counts.push(n);
  }
  freshHull(v);
  return { kill: kill / runs, disable: disable / runs, rico: rico / hits, firstHit: first / runs, counts };
}

/** One hull of every audited type, far apart, plus a WEST attacker; all hulls are EAST. */
export function damageRig() {
  const spawns = HULL_TYPES.map((type, i) => ({ id: `h-${type}`, type, team: 'bravo', x: 100 + i * 140, y: 1, z: 500, yaw: 0 }));
  const rig = flatRig(spawns);
  rig.attacker = rig.player('attacker', 'alpha', { x: 60, z: 60 });
  rig.hulls = Object.fromEntries(HULL_TYPES.map(type => [type, rig.vehicle(`h-${type}`)]));
  // Aircraft hang in the air (no ground contact): blasts reach them from every side.
  for (const type of ['helicopter', 'transport', 'plane']) Object.assign(rig.hulls[type], { y: 40, grounded: false });
  return rig;
}

/**
 * Seconds from the first trigger opportunity to the `n`-th shot of one
 * shooter who never misses: magazine and cooldown, a reload once the
 * magazine is empty, per-rail re-arm timers, heat lockouts, the seeker lock
 * before the first shot (and again after every reload for `relock`).
 * Infinity when the shooter carries fewer than `n` rounds.
 */
export function shotTimes(cadence, n) {
  if (!(n > 0)) return 0;
  if (Number.isFinite(cadence.carried) && n > cadence.carried) return Infinity;
  const lock = cadence.lock ?? 0, rails = [];
  let t = lock, ammo = cadence.magazine, heatLevel = 0, last = null;
  for (let shot = 1; shot <= n; shot++) {
    if (last != null) {
      t = last + cadence.cooldown;
      if (cadence.rearm > 0) {
        rails.sort((a, b) => a - b);
        while (rails.length && rails[0] <= t) { rails.shift(); ammo++; }
        if (ammo <= 0) { t = rails.shift(); ammo++; }
      } else if (ammo <= 0) {
        t = last + Math.max(cadence.cooldown, cadence.reload) + (cadence.relock ? lock : 0);
        ammo = cadence.magazine;
      }
    }
    if (cadence.heatPerShot) {
      if (last != null) heatLevel = Math.max(0, heatLevel - (t - last) * cadence.coolPerSecond);
      if (heatLevel + cadence.heatPerShot > 1) { t += cadence.overheatSeconds; heatLevel = 0; }
      heatLevel += cadence.heatPerShot;
    }
    ammo--; last = t;
    if (cadence.rearm > 0) rails.push(t + cadence.rearm);
  }
  return t;
}

/** Mean time to kill over the per-run hit counts of hitsToKill. */
export const meanTimeToKill = (spec, counts) => counts.reduce((sum, n) => sum + shotTimes(spec.cadence, n), 0) / counts.length;

// ---------------------------------------------------------------------------
// Sight-guided missiles against moving hulls
// ---------------------------------------------------------------------------

/** World aim [yaw, pitch] from `origin` to `point`. */
export const aimFrom = (origin, point) => {
  const d = point.map((n, i) => n - origin[i]);
  return { yaw: Math.atan2(-d[0], -d[2]), pitch: Math.atan2(d[1], Math.hypot(d[0], d[2])) };
};

/**
 * Target motion across the shooter's line at `range` m: `crossing` drives
 * back and forth across it at `speed` (±0.6 × range, so at most 31° off the
 * centre), `weave` adds a ±`amplitude` m sine (period `period` s) along the
 * line of sight, `approach` drives straight at the shooter. Returns
 * {x, z, vx, vz, yaw} at time `t` relative to the shooter's position.
 */
export function targetPath({ kind = 'crossing', speed = 10, range = 150, amplitude = 8, period = 5, phase = 0 } = {}) {
  const span = range * 0.6;
  return t => {
    if (kind === 'approach') return { x: 0, z: -range + speed * t, vx: 0, vz: speed, yaw: Math.PI };
    const s = ((speed * t + span + phase * speed) % (4 * span) + 4 * span) % (4 * span), out = s < 2 * span;
    const along = out ? s - span : 3 * span - s, vx = speed > 0 ? (out ? speed : -speed) : 0;
    const w = 2 * Math.PI / period;
    const side = kind === 'weave' ? amplitude * Math.sin(w * (t + phase)) : 0;
    const vside = kind === 'weave' ? amplitude * w * Math.cos(w * (t + phase)) : 0;
    // A parked target stands broadside, like a crossing one.
    return { x: along, z: -range + side, vx, vz: vside, yaw: vx || vside ? Math.atan2(-vx, -vside) : -Math.PI / 2 };
  };
}

/**
 * Sight-guided missile trial: `shooterType` (jeep_at TOW gunner, or a
 * helicopter hovering `hover` m up with its chin-sighted GUIDED MSL) against
 * a crewed `targetType` on `path`. `operator` 'ideal' keeps the sight on the
 * hull centre every tick (limited only by the mount's slew); 'bot' runs the
 * Conquest bot gunner (applyMountedCombat at `difficulty`). Every missile is
 * followed to its end: a hit is a launch whose explosion took 200+ HP off the
 * target (a splash-only near miss is counted apart). The target soaks every
 * hit, so the run measures hit rate, not a kill. `beamOverride` patches the
 * `beam` numbers of each launched missile (lead sweeps); `onTick` sees every
 * tick before it is stepped.
 */
export function beamTrial({ shooterType = 'jeep_at', targetType = 'tank', path, seconds = 40, operator = 'ideal', difficulty = 'normal',
  hover = 25, targetHeight = 0, seed = 1, beamOverride = null, onTick = null } = {}) {
  const origin = { x: 512, z: 900 };
  const shooterSeat = 'gunner', weapon = shooterType === 'jeep_at' ? 'towMissile' : 'guidedMissile';
  const rig = flatRig([{ id: 'shooter', type: shooterType, team: 'alpha', x: origin.x, y: 1, z: origin.z, yaw: 0 },
    { id: 'target', type: targetType, team: 'bravo', x: origin.x, y: 1, z: origin.z - 200, yaw: 0 }]);
  const { game } = rig, shooter = rig.vehicle('shooter'), target = rig.vehicle('target');
  const realRandom = Math.random;
  Math.random = mulberry32(seed);
  try {
    const gunner = operator === 'bot' ? botGunner(rig, difficulty, seed) : rig.player('gunner', 'alpha');
    if (!rig.board(gunner, 'shooter', shooterSeat)) throw new Error('gunner could not board');
    const driver = rig.player('driver', 'bravo');
    if (!rig.board(driver, 'target', 'driver')) throw new Error('target driver could not board');
    const air = VEHICLE_DEFS[targetType].handling === 'rotor' || VEHICLE_DEFS[targetType].handling === 'fixedwing';
    const pinShooter = () => {
      if (shooterType !== 'jeep_at') Object.assign(shooter, { x: origin.x, y: 1 + hover, z: origin.z, vx: 0, vy: 0, vz: 0, speed: 0, yaw: 0, pitch: 0, roll: 0,
        grounded: false, rotorSpeed: 1, engineOn: true });
      else Object.assign(shooter, { x: origin.x, z: origin.z, vx: 0, vz: 0, speed: 0 });
    };
    const pinTarget = t => {
      const at = path(t);
      Object.assign(target, { x: origin.x + at.x, z: origin.z + at.z, yaw: at.yaw, vx: at.vx, vz: at.vz,
        speed: Math.hypot(at.vx, at.vz), engineOn: true });
      if (air) Object.assign(target, { y: 1 + targetHeight, vy: 0, grounded: false, pitch: 0, roll: 0, rotorSpeed: 1 });
      else if (targetHeight) target.y = 1 + targetHeight;
    };
    if (shooterType !== 'jeep_at') {
      // Select the guided missile (weapon 1 on the gunner seat) for the ideal operator; the bot picks its own weapon.
      if (operator === 'ideal') game.applyInput(gunner.id, { keys: {}, yaw: 0, pitch: 0, vehicleAction: { type: 'weapon', index: 1 } });
    }
    // The target soaks every hit (the damage model sees a deep pool), so the
    // run keeps one crewed target and measures hits, not a kill.
    const model = game.vehicles.damageModel, apply = model.apply.bind(model);
    let dealt = 0;
    model.apply = (v, amount, attacker, options) => {
      if (v !== target) return apply(v, amount, attacker, options);
      const pool = vehicleMaxHp(v) * 1000;
      v.hp = pool;
      const ok = apply(v, amount, attacker, options);
      dealt += pool - v.hp;
      freshHull(v);
      return ok;
    };
    const br = gunner.brain;
    const sightMount = shooterType === 'jeep_at' ? 'pintle' : 'chin';
    const missiles = new Map();
    let launches = 0, hits = 0, splash = 0, t = 0;
    const missDistances = [];
    const ticks = Math.round(seconds * 1000 / TICK);
    for (let i = 0; i < ticks; i++, t += TICK / 1000) {
      pinShooter(); pinTarget(t);
      let inp;
      if (operator === 'bot') {
        inp = { seq: ++br.seq, keys: {}, yaw: gunner.yaw, pitch: gunner.pitch, wantFire: false };
        // The commander's threat axis points the idle sweep down the range (BotManager passes it in play).
        applyMountedCombat(game, br, gunner, shooter, shooterSeat, game.now, TICK / 1000, inp,
          shooterType === 'jeep_at' ? { threatAxis: 0 } : { threatAxis: 0, aircraft: true, sightRange: BOT_AIRCRAFT_SIGHT_RANGE });
      } else {
        const pose = game.vehicles.mountPose(shooter, shooterSeat, sightMount);
        const centre = game.vehicles.hullCenter(target);
        const aim = aimFrom(pose.pivot, centre), now = mountPose(shooter, shooterSeat, sightMount);
        const off = Math.acos(Math.max(-1, Math.min(1, now.dir.reduce((s, n, k) => s + n * (centre[k] - now.pivot[k]), 0)
          / Math.hypot(...centre.map((n, k) => n - now.pivot[k])))));
        const mount = game.vehicles.mounts.selected(shooter, shooterSeat);
        const state = game.vehicles.mounts.state(shooter, mount.mount);
        const flying = [...missiles.values()].some(m => game.projectiles.active.has(m.id));
        inp = { keys: {}, ...aim, wantFire: !flying && off < 0.01 && (state?.ammo ?? 1) > 0 && !(state?.cooldown > 0) };
      }
      game.applyInput(gunner.id, inp);
      onTick?.({ game, shooter, target, gunner, input: inp, t });
      dealt = 0;
      rig.step();
      for (const r of game.projectiles.active.values()) {
        if (r.weaponKey === weapon && !missiles.has(r.id)) {
          missiles.set(r.id, { id: r.id, closest: Infinity }); launches++;
          if (beamOverride && r.beam) Object.assign(r.beam, beamOverride);
        }
      }
      for (const m of missiles.values()) {
        const r = game.projectiles.active.get(m.id);
        if (r) {
          const c = game.vehicles.hullCenter(target);
          m.closest = Math.min(m.closest, Math.hypot(r.x - c[0], r.y - c[1], r.z - c[2]));
        } else if (!m.done) {
          m.done = true;
          if (dealt >= 200) hits++; else { if (dealt > 0) splash++; missDistances.push(m.closest); }
        }
      }
    }
    const settled = [...missiles.values()].filter(m => m.done).length;
    return { launches, settled, hits, splash, hitRate: settled ? hits / settled : 0,
      medianMiss: missDistances.length ? missDistances.sort((a, b) => a - b)[Math.floor(missDistances.length / 2)] : null };
  } finally {
    Math.random = realRandom;
  }
}

/** A bot entity with a minimal brain for applyMountedCombat (as in tools/conquest-bot-vehicle-combat-test.mjs). */
function botGunner(rig, difficulty, seed) {
  rig.game.addBot('bot-g');
  const p = rig.game.entities.get('bot-g');
  rig.game.mode.policy.setLobbyTeam(p, 'alpha');
  Object.assign(p, { hp: 100, spawnProtectedUntil: 0, spawnProtected: false });
  p.brain = { id: p.id, index: 0, rng: mulberry32(seed * 977 + 13), skill: difficulty === 'hard' ? 0.85 : difficulty === 'easy' ? 0.35 : 0.6,
    difficulty, personality: 'skirmisher', reactionScale: 1, seq: 0 };
  return p;
}

// ---------------------------------------------------------------------------
// AT mines under moving hulls
// ---------------------------------------------------------------------------

/**
 * One armed AT mine, `offset` m off the centre line of a `type` hull that
 * drives over it at `speed` m/s. Returns whether it went off, the HP the hull
 * lost, and whether it ended disabled or destroyed.
 */
export function mineTrial({ type = 'tank', speed = 10, offset = 0, mines = 1, spacing = 1.2, across = false } = {}) {
  const rig = flatRig([{ id: 'hull', type, team: 'bravo', x: 300, y: 1, z: 700, yaw: 0 }]);
  const { game } = rig, v = rig.vehicle('hull');
  const eng = rig.player('eng', 'alpha', { x: 300, z: 500 });
  eng.grenades = GRENADE_TYPE_IDS.map(() => 0);
  eng.grenades[ATM] = mines;
  const ctx = game.contexts.projectiles;
  for (let i = 0; i < mines; i++) {
    Object.assign(eng, { x: 300.5 + offset + (across ? i * spacing : 0), y: 1, z: 500.5 + (across ? 0 : i * spacing), yaw: 0, pitch: -0.95 });
    game.projectiles.throw(eng, ctx, 0, ATM, 0, { yaw: 0, pitch: -0.95 });
  }
  const placed = [...game.projectiles.active.values()].filter(m => m.type === 'atmine');
  Object.assign(eng, { x: 100, z: 100 });
  for (let i = 0; i < Math.ceil(AT_MINE_RULES.armMs / TICK) + 2; i++) { Object.assign(v, { x: 300, z: 700 }); rig.step(); }
  const lane = (placed[0]?.x ?? 300.5) - offset;
  const startZ = Math.min(...placed.map(m => m.z)) + 12;
  let z = startZ, blastAt = -1;
  const hp0 = v.hp, live = () => [...game.projectiles.active.values()].filter(m => m.type === 'atmine').length;
  // Drive on until 0.25 s after the first blast: the charge, not the burn that follows a disable.
  for (let i = 0; i < 600 && z > startZ - 30 && (blastAt < 0 || i - blastAt < 15); i++) {
    z -= speed * TICK / 1000;
    if (v.hp > 0) Object.assign(v, { x: lane, z, yaw: 0, speed, vx: 0, vz: -speed, engineOn: true });
    rig.step();
    if (blastAt < 0 && live() < placed.length) blastAt = i;
  }
  return { detonated: placed.length - live(), lost: hp0 - Math.max(0, v.hp), disabled: !!v.disabled || !(v.hp > 0), destroyed: !(v.hp > 0),
    tracks: !!v.subsystems?.tracks?.until };
}

// ---------------------------------------------------------------------------
// Bomb pass over infantry
// ---------------------------------------------------------------------------

/**
 * One jet pass at `agl` m and `speed` m/s that walks both bombs (0.5 s apart,
 * so they land `speed` / 2 m apart) across a squad of `squad` soldiers
 * standing within `spread` m of the target, the stick centred `error` m off
 * it (CCIP slop, a random direction). Soldiers stand `react` s after the
 * first blast, then run straight out of it at `run` m/s. Returns the kills,
 * split into the blasts and the burning field, as the server credits them
 * (kill key jetBomb).
 */
export function bombSortie({ agl = 60, speed = 40, squad = 4, spread = 8, error = 0, react = 1.5, run = 5.5, seed = 1 } = {}) {
  const random = mulberry32(seed), floor = 4, ground = floor + 1;
  const rig = flatRig([{ id: 'jet', type: 'plane', team: 'alpha', x: 500, y: 1, z: 900, yaw: 0 }], { floor });
  const { game } = rig, jet = rig.vehicle('jet');
  const pilot = rig.player('pilot', 'alpha', { x: 505, y: ground, z: 900 });
  if (!rig.board(pilot, 'jet', 'driver')) throw new Error('pilot could not board');
  const fly = z => Object.assign(jet, { x: 500, y: ground + agl, z, yaw: 0, pitch: 0, roll: 0, vx: 0, vy: 0, vz: -speed, speed, airspeed: speed,
    grounded: false, gearDown: false, throttle: 0.6, enginePower: 0.6 });
  fly(900);
  game.applyInput(pilot.id, { keys: {}, yaw: 0, pitch: 0, vehicleAction: { type: 'weapon', index: 2 } });
  rig.step(); fly(900);
  // The CCIP solution on flat ground: how far ahead of the release a bomb lands.
  const pose = mountPose(jet, 'driver', 'bombs', { side: 0 }), vel = bombReleaseVelocity(jet), g = VEHICLE_WEAPON_META.jetBomb.gravity;
  const drop = pose.origin[1] - ground, fall = (vel[1] + Math.sqrt(vel[1] ** 2 + 2 * g * drop)) / g;
  const ahead = -vel[2] * fall + (pose.origin[2] - jet.z) * -1;
  const angle = random() * Math.PI * 2, gap = speed * VEHICLE_WEAPONS.jetBomb.cooldown;
  const centre = [500 + Math.cos(angle) * error, ground, 600 + Math.sin(angle) * error];
  const soldiers = [];
  for (let i = 0; i < squad; i++) {
    const r = spread * Math.sqrt(random()), a = random() * Math.PI * 2;
    soldiers.push(rig.player(`s${i}`, 'bravo', { x: 500 + Math.cos(a) * r, y: ground, z: 600 + Math.sin(a) * r, hp: 100 }));
  }
  // First bomb lands gap/2 short of the stick centre, the second gap/2 past it.
  const releaseZ = centre[2] + gap / 2 + ahead;
  const kills = { blast: 0, burn: 0 };
  let z = releaseZ + speed * 1.5, t = 0, firstBlast = null, lastBlastTick = -99, seen = rig.frames.length, fired = 0;
  const blasts = [];
  for (let i = 0; i < 60 * 14; i++, t += TICK / 1000) {
    z -= speed * TICK / 1000;
    fly(z);
    const due = fired === 0 ? z <= releaseZ : z <= releaseZ - gap;
    const ammo = game.vehicles.mounts.state(jet, 'bombs').ammo;
    game.applyInput(pilot.id, { keys: {}, yaw: 0, pitch: 0, wantFire: fired < 2 && due });
    rig.step();
    if (game.vehicles.mounts.state(jet, 'bombs').ammo < ammo) fired++;
    for (; seen < rig.frames.length; seen++) for (const e of rig.frames[seen].events ?? []) {
      if (e.kind === 'projectileExplode' && e.vehicleWeapon === 'jetBomb') {
        lastBlastTick = i;
        firstBlast ??= { t, at: [e.x, e.y, e.z] };
        blasts.push([e.x, e.y, e.z]);
      }
      if (e.kind === 'kill' && e.killer === pilot.id && e.w === 'jetBomb') kills[i - lastBlastTick <= 3 ? 'blast' : 'burn']++;
    }
    // Survivors react, then run straight out of the first blast.
    for (const s of soldiers) {
      if (s.state !== 'alive') continue;
      Object.assign(s, { vx: 0, vy: 0, vz: 0 });
      if (!firstBlast || t - firstBlast.t < react) continue;
      const c = Array.isArray(firstBlast.at) ? firstBlast.at : centre;
      const dx = s.x - c[0], dz = s.z - c[2], l = Math.hypot(dx, dz) || 1;
      s.x += dx / l * run * TICK / 1000; s.z += dz / l * run * TICK / 1000;
    }
  }
  return { dead: soldiers.filter(s => s.state !== 'alive').length, kills, squad, fired,
    blasts: blasts.map(b => [b[0] - 500, b[1] - ground, b[2] - 600]), centre: [centre[0] - 500, centre[2] - 600] };
}

// ---------------------------------------------------------------------------
// Bot matches
// ---------------------------------------------------------------------------

/** Weapon keys the match tally follows (vehicle mounts, infantry AT/AA, the mine). */
export const MATCH_WEAPONS = Object.freeze(['towMissile', 'guidedMissile', 'jetBomb', 'aaMissile', 'tankAP', 'tankHE', 'rocket', 'stinger', 'atmine']);

/**
 * One seeded Frontier match with `bots` bots for `seconds` (GameEngine +
 * attachBots, as tools/conquest-action-test.mjs). Tallies per weapon of
 * MATCH_WEAPONS: shots, direct hull hits and the HP they dealt (through the
 * damage model), hulls destroyed (credited to the last weapon that hit them)
 * and kills; AT mines laid and set off; hijacks; and hijack opportunity
 * seconds: a living bot on foot within 10.5 m of an empty live enemy hull it
 * could board.
 */
export async function matchStats({ seed = 1, seconds = 180, bots = 16, difficulty = 'normal' } = {}) {
  const [{ createMapState, getMapMeta }, { attachBots }] = await Promise.all([import('../../shared/worlddata.js'), import('../../server/bots.js')]);
  const meta = getMapMeta('frontier');
  const realRandom = Math.random, realNow = Date.now;
  Math.random = mulberry32(seed);
  const events = [];
  let game;
  Date.now = () => 1_800_000_000_000;
  try { game = new GameEngine({ mode: 'conquest', world: createMapState('frontier'), mapMeta: meta, broadcast: snap => events.push(...(snap.events ?? [])) }); }
  finally { Date.now = realNow; }
  try {
    const manager = attachBots(game, bots, { difficulties: new Map(Array.from({ length: bots }, (_, i) => [`bot-${i}`, difficulty])) });
    const tally = Object.fromEntries(MATCH_WEAPONS.map(key => [key, { shots: 0, hits: 0, dealt: 0, destroyed: 0, kills: 0 }]));
    const lastWeapon = new Map();
    const model = game.vehicles.damageModel, apply = model.apply.bind(model);
    model.apply = (v, amount, attacker, options = {}) => {
      const before = v?.hp ?? 0, ok = apply(v, amount, attacker, options);
      const key = options.weapon;
      if (ok && key && tally[key] && attacker) {
        tally[key].hits++; tally[key].dealt += Math.max(0, before - (v.hp ?? 0));
        lastWeapon.set(v.id, key);
      }
      return ok;
    };
    const teamOf = p => game.mode.teamFor?.(p) ?? p.team;
    const out = { hijacks: 0, hijackTypes: {}, minesLaid: 0, minesDetonated: 0, seatSeconds: {}, hijackOpportunitySeconds: 0 };
    let seen = 0;
    const ticks = Math.round(seconds * 1000 / TICK);
    for (let i = 0; i < ticks; i++) {
      game.step(TICK);
      for (; seen < events.length; seen++) {
        const e = events[seen];
        const shot = e.kind === 'shoot' ? e.vehicleWeapon ?? e.w : null;
        if (shot && tally[shot]) tally[shot].shots++;
        if (e.kind === 'projectileLaunch' && e.type === 'atmine') out.minesLaid++;
        if (e.kind === 'projectileExplode' && e.type === 'atmine') out.minesDetonated++;
        if (e.kind === 'kill' && tally[e.w]) tally[e.w].kills++;
        if (e.kind === 'vehicle_destroyed') {
          const key = lastWeapon.get(e.vehicleId);
          if (key && e.attacker) tally[key].destroyed++;
          lastWeapon.delete(e.vehicleId);
        }
        if (e.kind === 'vehicle_hijacked') { out.hijacks++; out.hijackTypes[e.type] = (out.hijackTypes[e.type] ?? 0) + 1; }
      }
      if (i % 60) continue;
      for (const p of game.entities.values()) {
        if (!p.bot || p.state !== 'alive') continue;
        if (p.vehicleId) {
          const v = game.vehicles.vehicles.get(p.vehicleId), key = `${v?.type}:${p.vehicleSeatId}`;
          out.seatSeconds[key] = (out.seatSeconds[key] ?? 0) + 1;
          continue;
        }
        for (const v of game.vehicles.vehicles.values()) {
          if (!(v.hp > 0) || v.padInactive || v.team === teamOf(p) || Math.hypot(v.x - p.x, v.y - p.y, v.z - p.z) > 10.5) continue;
          if (game.vehicles.hijackable(v, teamOf(p))) { out.hijackOpportunitySeconds++; break; }
        }
      }
    }
    manager.dispose();
    for (const row of Object.values(tally)) row.dealt = Math.round(row.dealt);
    return { seed, seconds, tally, ...out };
  } finally {
    Math.random = realRandom;
    game?.stop?.();
  }
}

export { VEHICLE_DAMAGE_RULES };
