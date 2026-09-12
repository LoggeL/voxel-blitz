// A stationary shooting range driven by the production combat systems.
// No weapon balance or damage formula is duplicated here.
import { PlayerEntity, aimAngles, fwdFromYawPitch } from '../../server/sim/player.js';
import { resolveWeaponIntent } from '../../server/sim/combat.js';
import { updateTimers, updateCondition } from '../../server/sim/movement.js';
import { ProjectileSystem } from '../../server/sim/projectiles.js';
import { FlameSystem, updateBurn } from '../../server/sim/fire.js';
import { WEAPONS, WEAPON_IDS, chargeProfile } from '../../shared/combatmath.js';
import { MINIGUN } from '../../shared/minigun.js';
import { rocketLaunch, stepRocket } from '../../shared/rocket-rules.js';
import { boltLaunch, stepBolt } from '../../shared/bolt-rules.js';
import { TICK_MS } from '../../server/protocol/admission.js';

export const DISTANCES = [1, 2, 5, 10, 15, 20, 30, 40, 60, 80, 100, 120];
export const SCENARIOS = [
  { id: 'ideal-body', label: 'Perfekt: Körper', perfect: true, aim: 'body', ads: true },
  { id: 'ideal-head', label: 'Perfekt: Kopf', perfect: true, aim: 'head', ads: true },
  { id: 'ads-body', label: 'Streuung: ADS Körper', perfect: false, aim: 'body', ads: true },
  { id: 'ads-head', label: 'Streuung: ADS Kopf', perfect: false, aim: 'head', ads: true },
  { id: 'hip-body', label: 'Streuung: Hüfte Körper', perfect: false, aim: 'body', ads: false },
];

const aimCache = new Map();
/** Compensate gravity and muzzle offset using the actual discrete integrator.
 * The target stays still; this deliberately assumes perfect range estimation. */
function ballisticPitch(id, distance, eyeHeight, targetHeight) {
  const key = [id, distance, eyeHeight, targetHeight].join(':');
  if (aimCache.has(key)) return aimCache.get(key);
  const launch = id === 'rocket' ? rocketLaunch : boltLaunch;
  const step = id === 'rocket' ? stepRocket : stepBolt;
  function height(pitch) {
    const p = launch({ x: 0, y: eyeHeight, z: 0, dir: fwdFromYawPitch(0, pitch) });
    for (let tick = 0; tick < 200; tick++) {
      const from = { z: p.z, y: p.y };
      step(p, TICK_MS / 1000, () => null);
      if (p.z <= -distance) {
        const fraction = (-distance - from.z) / (p.z - from.z);
        return from.y + fraction * (p.y - from.y);
      }
    }
    return -Infinity;
  }
  let low = -0.7, high = 0.7;
  for (let i = 0; i < 40; i++) {
    const mid = (low + high) / 2;
    if (height(mid) < targetHeight) low = mid;
    else high = mid;
  }
  const pitch = (low + high) / 2;
  aimCache.set(key, pitch);
  return pitch;
}

export function simulateFight({ weapon, distance, scenario = 'ideal-body', seed = 1,
  hp = 100, armor = 0, maxSeconds = 20, minigun = 'cold', chargeMs,
  backstab = false, trace = false } = {}) {
  const def = WEAPONS[weapon];
  const mode = SCENARIOS.find(s => s.id === scenario);
  if (!def || !mode || !Number.isFinite(distance) || distance <= 0 || distance > 160)
    throw new Error('Unknown weapon/scenario or distance outside (0, 160] metres');
  if (!(hp > 0 && hp <= 1000) || !(armor >= 0 && armor <= 100)
    || !(maxSeconds > 0 && maxSeconds <= 120)) throw new Error('Invalid HP, armor or time limit');
  if (!['cold', 'ready', 'hot'].includes(minigun)) throw new Error('Invalid minigun state');
  const holdMs = chargeMs ?? chargeProfile(def).holdMaxMs;
  if (!Number.isFinite(holdMs) || holdMs < 0) throw new Error('Invalid charge time');
  const shooter = new PlayerEntity(`ttk-${seed}`, 'Shooter', { x: 100, y: 20, z: 200 });
  const victim = new PlayerEntity('target', 'Target', { x: 100, y: 20, z: 200 - distance });
  Object.assign(shooter, { weapon: WEAPON_IDS.indexOf(weapon), deployT: 0,
    ads: mode.ads, adsT: mode.ads ? 1 : 0, grounded: true, yaw: 0 });
  Object.assign(victim, { hp, armor, yaw: backstab ? 0 : Math.PI, pitch: 0, grounded: true });
  shooter.minigun = { heat: minigun === 'hot' ? MINIGUN.sweetHeat : 0,
    spin: minigun === 'cold' ? 0 : 1, overheated: false };
  const aimHeight = victim.y + (mode.aim === 'head' ? 1.66 : 1.18);
  shooter.pitch = def.projectile
    ? ballisticPitch(weapon, distance, shooter.eyeY, aimHeight)
    : aimAngles([shooter.x, shooter.eyeY, shooter.z], [victim.x, aimHeight, victim.z]).pitch;
  const entities = new Map([[shooter.id, shooter], [victim.id, victim]]);
  const targets = new Map([[victim.id, victim]]);
  const projectiles = new ProjectileSystem();
  const flames = new FlameSystem();
  let timeMs = 0, firstShotMs = null, firstHitMs = null, killMs = null;
  let shots = 0, hits = 0, headHits = 0, reloads = 0, totalDamage = 0;
  let firstAttackDamage = 0;
  let lastAttackDamage = 0;
  const takeDamage = victim.takeDamage.bind(victim);
  victim.takeDamage = (amount, ...args) => {
    lastAttackDamage = amount;
    return takeDamage(amount, ...args);
  };
  const events = [];
  const ctx = {
    entities, targets, flames, dimensions: { sx: 512, sy: 128, sz: 512 }, now: 1000,
    canFire: () => true, canUseWeapon: () => true, canBurn: () => true,
    canDamage: (a, v) => a === shooter && v === victim, canThrow: () => false,
    getBlock: () => 0, solidAt: () => false, blockHp: new Map(),
    destroyBlock: () => false, pushBlockDelta() {},
    ...(mode.perfect ? { computeConeDeg: () => 0 } : {}),
    launchRocket: (p, dir) => projectiles.launchRocket(p, ctx, dir),
    launchBolt: (p, dir, charge) => projectiles.launchBolt(p, ctx, dir, charge),
    pushEvent(event) {
      if (event.kind === 'shoot') { shots++; firstShotMs ??= timeMs; }
      if (event.kind === 'hit' && event.victim === victim.id) {
        hits++; headHits += event.hs ? 1 : 0; totalDamage += lastAttackDamage;
        firstHitMs ??= timeMs;
        if (timeMs === firstHitMs) firstAttackDamage += lastAttackDamage;
      }
      if (trace && ['shoot', 'hit'].includes(event.kind)) events.push({ ms: timeMs, ...event });
    },
    killPlayer(v) { v.state = 'dead'; if (v === victim) killMs = timeMs; },
  };
  for (let tick = 0; tick * TICK_MS <= maxSeconds * 1000; tick++) {
    timeMs = tick * TICK_MS;
    ctx.now = 1000 + timeMs;
    const dt = TICK_MS / 1000;
    updateTimers(shooter, dt);
    // No locomotion, aim error or camera recoil. Conditions still recover and
    // firing still adds exhaustion/bloom through the real server routines.
    updateCondition(shooter, dt);
    updateBurn(victim, dt, ctx);
    flames.step(dt, ctx);
    projectiles.step(dt, ctx);
    if (killMs !== null) break;
    const empty = def.mode !== 'melee' && shooter.mag[shooter.weapon] === 0;
    const reload = empty && !shooter.reloading && shooter.reserve[shooter.weapon] > 0;
    // Fast repeated trigger presses at the authoritative cadence. A charge
    // releases on the first tick meeting the requested hold duration.
    const release = def.mode === 'charge' && shooter.charging
      && shooter.chargeT + TICK_MS >= holdMs;
    shooter.input = { wantFire: !reload && !release, wantAds: mode.ads,
      reload, keys: {}, yaw: shooter.yaw, pitch: shooter.pitch };
    shooter.fireEdgeQueued = !reload && !shooter.reloading && !shooter.charging
      && shooter.cooldown <= 0 && (!empty || def.mode === 'melee');
    const wasReloading = shooter.reloading;
    resolveWeaponIntent(shooter, dt, ctx);
    if (!wasReloading && shooter.reloading) reloads++;
    if (killMs !== null) break;
    // No attack can reach these distances in this stationary fixture.
    if (tick === 0 && ((def.melee && distance > 3) || (def.flame && distance > 30))) break;
  }
  return { weapon, distance, scenario, seed, killMs, firstShotMs, firstHitMs,
    damageWindowMs: killMs !== null && firstHitMs !== null ? killMs - firstHitMs : null,
    shots, hits, headHits, reloads, firstAttackDamage, totalDamage, hpLeft: victim.hp,
    ...(trace ? { events } : {}) };
}

/** Censored runs sort after the time limit. Never hide failures by calculating
 * median/P90 on successful kills alone. Null means that percentile did not kill. */
export function summarize(fights) {
  const values = fights.map(f => f.killMs ?? Infinity).sort((a, b) => a - b);
  const percentile = p => {
    const v = values[Math.max(0, Math.ceil(values.length * p) - 1)];
    return Number.isFinite(v) ? v : null;
  };
  const killed = fights.filter(f => f.killMs !== null);
  const mean = key => fights.reduce((sum, f) => sum + f[key], 0) / fights.length;
  return { trials: fights.length, kills: killed.length, killRate: killed.length / fights.length,
    firstImpactKillRate: fights.filter(f => f.killMs !== null && f.damageWindowMs === 0).length / fights.length,
    p10Ms: percentile(0.1), medianMs: percentile(0.5), p90Ms: percentile(0.9),
    meanShots: mean('shots'), meanHits: mean('hits'), meanReloads: mean('reloads'),
    meanFirstAttackDamage: mean('firstAttackDamage'),
    medianDamageWindowMs: killed.length ? killed.map(f => f.damageWindowMs).sort((a, b) => a - b)[Math.floor(killed.length / 2)] : null };
}
