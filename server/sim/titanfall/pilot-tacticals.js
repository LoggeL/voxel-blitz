/**
 * Pilot tacticals (docs/titanfall.md §4.1: grapple, stim, cloak) and pilot
 * health regen. State lives on the body as `p.pilotTac`
 * ({ kind, charges, readyAt, cloakUntil, stimUntil }), times in engine ms.
 *
 * - GRAPPLE: 2 charges, each recharging in `recharge` s (readyAt = the next
 *   charge). The hook is an eye ray of `range` m onto a solid voxel or a titan
 *   hull; the pull itself is pilot movement (`p.pilot.grapple`, shared/pilot-movement.js),
 *   predicted by the client from the `tf[6]` anchor. A titan anchor follows its hull.
 * - STIM: `seconds` of ×speedMul speed and regen without delay at `regen` hp/s;
 *   cooldown counted from activation.
 * - CLOAK: `seconds` of cloak (perception.js), cooldown counted from activation.
 * - Regen (every pilot): `regen.delay` s after the last damage, `regen.rate` hp/s.
 * - Exposure (perception.js noteExposure): a cloaked pilot who fires, throws,
 *   melees, deals or takes damage is perceivable anywhere for revealMs.
 */
import { TITAN_PILOT_TACTICALS, TITANFALL_PLAYER_FLAGS, isTitanType } from '../../../shared/titan-contract.js';
import { PILOT_RULES, createPilotState, resetPilotMotion, pilotJumpSeq, grappleLineClear } from '../../../shared/pilot-movement.js';
import { raycastVoxels } from '../../../shared/raycast.js';
import { noteExposure } from './perception.js';

const G = PILOT_RULES.grapple, STIM = PILOT_RULES.stim, CLOAK = PILOT_RULES.cloak, REGEN = PILOT_RULES.regen;
const PILOT_MAX_HP = 100;

/** Fresh tactical state for a life with tactical `kind` (one of TITAN_PILOT_TACTICALS). */
export function resetPilotTactical(p, kind = TITAN_PILOT_TACTICALS[0]) {
  if (!p || typeof p !== 'object') return null;
  const tac = TITAN_PILOT_TACTICALS.includes(kind) ? kind : TITAN_PILOT_TACTICALS[0];
  p.pilotTac = { kind: tac, charges: tac === 'grapple' ? G.charges : 1, readyAt: 0, cloakUntil: 0, stimUntil: 0 };
  p.tfRegen = null;
  return p.pilotTac;
}

const finiteVec = v => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);

/**
 * Grapple hook target from the eye along the aim: { anchor, vehicleId, offset } or null.
 * The nearer of the first solid voxel and a titan hull within `range`. A target the
 * pull would drop at once (inside the release distance, or out of the pull's line
 * of sight) is refused, so it never spends a charge.
 */
export function grappleTarget(policy, p) {
  const solidAt = policy?.engine?.solidAt;
  if (typeof solidAt !== 'function') return null;
  const yaw = Number.isFinite(p.yaw) ? p.yaw : 0, pitch = Number.isFinite(p.pitch) ? p.pitch : 0;
  const cp = Math.cos(pitch);
  const dir = [-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp];
  const origin = [Number.isFinite(p.eyeX) ? p.eyeX : p.x, Number.isFinite(p.eyeY) ? p.eyeY : p.y + 1.62,
    Number.isFinite(p.eyeZ) ? p.eyeZ : p.z];
  if (!finiteVec(origin)) return null;
  const voxel = raycastVoxels(solidAt, origin[0], origin[1], origin[2], dir[0], dir[1], dir[2], G.range);
  let best = voxel && voxel.t <= G.range && voxel.t > 0.3 ? { t: voxel.t, normal: [voxel.nx, voxel.ny, voxel.nz], vehicle: null } : null;
  const hull = policy.engine?.vehicles?.rayHit?.(origin, dir, best ? best.t : G.range, p.vehicleId ?? null);
  if (hull && isTitanType(hull.vehicle?.type) && hull.vehicle.hp > 0 && hull.distance > 0.3 && (!best || hull.distance < best.t)) {
    best = { t: hull.distance, normal: [-dir[0], -dir[1], -dir[2]], vehicle: hull.vehicle };
  }
  if (!best) return null;
  const pad = 0.05;
  const anchor = [origin[0] + dir[0] * best.t + best.normal[0] * pad, origin[1] + dir[1] * best.t + best.normal[1] * pad,
    origin[2] + dir[2] * best.t + best.normal[2] * pad];
  if (Math.hypot(anchor[0] - p.x, anchor[1] - (p.y + G.chest), anchor[2] - p.z) < G.release) return null;
  if (!grappleLineClear({ solidAt }, p, anchor)) return null;
  const v = best.vehicle;
  return { anchor, vehicleId: v ? v.id : null, offset: v ? [anchor[0] - v.x, anchor[1] - v.y, anchor[2] - v.z] : null };
}

/** The `{t:'titanfall', tac:1}` intent: fires the life's tactical when it is ready. */
export function usePilotTactical(policy, p, now) {
  if (!p || typeof p !== 'object' || p.state !== 'alive' || !Number.isFinite(now)) return false;
  if (p.vehicleId || p.rodeoVehicleId || p.embarkUntil > now) return false;
  const tac = p.pilotTac ?? resetPilotTactical(p);
  switch (tac.kind) {
    case 'grapple': {
      const pilot = p.pilot ??= createPilotState();
      if (!(tac.charges > 0) || pilot.grapple) return false;
      const target = grappleTarget(policy, p);
      if (!target) return false;
      resetPilotMotion(pilot);
      pilot.grapple = { anchor: target.anchor, t: 0, vehicleId: target.vehicleId, offset: target.offset };
      if (tac.charges >= G.charges || !(tac.readyAt > now)) tac.readyAt = now + G.recharge * 1000;
      tac.charges--;
      return true;
    }
    case 'stim':
      if (tac.readyAt > now) return false;
      tac.stimUntil = now + STIM.seconds * 1000;
      tac.readyAt = now + STIM.cooldown * 1000;
      tac.charges = 0;
      return true;
    case 'cloak':
      if (tac.readyAt > now) return false;
      tac.cloakUntil = now + CLOAK.seconds * 1000;
      tac.readyAt = now + CLOAK.cooldown * 1000;
      tac.charges = 0;
      return true;
    default:
      return false;
  }
}

/**
 * Chained `beforeDamage` hook (the conquest/titans pattern): the victim and a
 * pilot attacker are exposed, and the victim's regen clock restarts.
 */
function attachExposureHook(policy, p) {
  if (p.tfExposureHook) return;
  const prior = typeof p.beforeDamage === 'function' ? p.beforeDamage : null;
  const hook = (dmg, attacker, weapon) => {
    const amount = prior ? (prior(dmg, attacker, weapon) ?? dmg) : dmg;
    if (amount > 0 && Number.isFinite(policy.now)) {
      noteExposure(p, policy.now);
      if (p.tfRegen) p.tfRegen.hurtAt = policy.now;
      if (attacker && typeof attacker === 'object' && attacker !== p && attacker.pilotTac) noteExposure(attacker, policy.now);
    }
    return amount;
  };
  p.beforeDamage = hook;
  p.tfExposureHook = hook;
}

/**
 * A seated or riding pilot is not integrated (GameEngine.integrate skips it), so
 * its pilot motion ends here and its jump presses are consumed: nothing resumes
 * after the exit, and the press that jumps off a titan's back (stepRodeo, later
 * in the same tick) is not replayed as a double jump by the first integrate.
 */
function seatedPilot(p) {
  const pilot = p.pilot;
  if (pilot) {
    resetPilotMotion(pilot);
    pilotJumpSeq(pilot, p.input?.jumpSeq, true);
  }
  p.jumpWasHeld = !!p.input?.keys?.jump;
}

/** Per-tick upkeep: charges, titan anchors, regen and exposure. Runs in the policy's beforeTick (live phase). */
export function stepPilotTacticals(policy, entities, now, dt) {
  if (!entities || !Number.isFinite(now)) return;
  const list = typeof entities.values === 'function' ? entities.values() : entities;
  for (const p of list) {
    if (!p || typeof p !== 'object' || p.npcRole) continue;
    if (p.state === 'alive' && (p.vehicleId || p.rodeoVehicleId)) seatedPilot(p);
    const tac = p.pilotTac;
    if (!tac) continue;
    if (p.state !== 'alive') { if (p.pilot) resetPilotMotion(p.pilot); continue; }
    attachExposureHook(policy, p);
    // Charges.
    if (tac.kind === 'grapple') {
      if (tac.charges < G.charges && tac.readyAt > 0 && now >= tac.readyAt) {
        tac.charges++;
        tac.readyAt = tac.charges < G.charges ? now + G.recharge * 1000 : 0;
      }
    } else tac.charges = tac.readyAt > now ? 0 : 1;
    // A titan anchor rides its hull; the hook lets go of a dead or vanished hull.
    const grapple = p.pilot?.grapple;
    if (grapple?.vehicleId) {
      const v = policy.engine?.vehicles?.vehicles?.get?.(grapple.vehicleId);
      if (!v || !(v.hp > 0) || !finiteVec(grapple.offset)) p.pilot.grapple = null;
      else grapple.anchor = [v.x + grapple.offset[0], v.y + grapple.offset[1], v.z + grapple.offset[2]];
    }
    // Exposure from own actions: a shot, a throw or a melee swing.
    const seen = p.tfSeen ??= { shotSeq: p.shotSeq | 0, throwAt: p.nextThrowAt || 0 };
    if ((p.shotSeq | 0) !== seen.shotSeq || (p.nextThrowAt || 0) !== seen.throwAt || p.quickMeleeT > 0) noteExposure(p, now);
    seen.shotSeq = p.shotSeq | 0;
    seen.throwAt = p.nextThrowAt || 0;
    // Regen: delay after the last damage (none while stimmed).
    const hp = Number.isFinite(p.hp) ? p.hp : 0;
    const regen = p.tfRegen ??= { hp, hurtAt: -Infinity };
    if (hp < regen.hp) regen.hurtAt = Math.max(regen.hurtAt, now);
    const stimmed = tac.stimUntil > now;
    const delay = stimmed ? 0 : REGEN.delay * 1000, rate = stimmed ? STIM.regen : REGEN.rate;
    if (hp > 0 && hp < PILOT_MAX_HP && now - regen.hurtAt >= delay && dt > 0) p.hp = Math.min(PILOT_MAX_HP, hp + rate * dt);
    regen.hp = p.hp;
  }
}

/** `tf[3]` flag bits owned by the tactical (cloaked, stimmed, grappling). */
export function pilotTacticalFlags(p, now) {
  const tac = p?.pilotTac;
  if (!tac) return 0;
  let flags = 0;
  if (tac.cloakUntil > now) flags |= TITANFALL_PLAYER_FLAGS.cloaked;
  if (tac.stimUntil > now) flags |= TITANFALL_PLAYER_FLAGS.stimmed;
  if (p.pilot?.grapple) flags |= TITANFALL_PLAYER_FLAGS.grappling;
  return flags;
}

/** `tfs` fields owned by the tactical: { tacCharges, tacReady (0..1) }. */
export function pilotTacticalStatus(p, now) {
  const tac = p?.pilotTac;
  if (!tac) return { tacCharges: 0, tacReady: 0 };
  // 0..1 progress of the next charge (grapple) or of the cooldown (stim, cloak); 1 when ready.
  const span = (tac.kind === 'grapple' ? G.recharge : tac.kind === 'stim' ? STIM.cooldown : CLOAK.cooldown) * 1000;
  const full = tac.kind === 'grapple' ? tac.charges >= G.charges : !(tac.readyAt > now);
  const tacReady = full ? 1 : Math.max(0, Math.min(1, 1 - (tac.readyAt - now) / span));
  return { tacCharges: tac.charges, tacReady };
}
