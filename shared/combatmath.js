// Shared weapon definitions + authoritative ballistic math.
// Both server (combat resolve / anticheat) and client (recoil & spray feel) import this.
// THERE IS ONE SOURCE OF TRUTH for every gun number in the game.

export const GRAVITY = 24;
export const PLAYER_HALF = { x: 0.32, h: 0.95 };   // AABB half-width, half-height
export const EYE_HEIGHT = 1.62;                    // eye above feet
export const HEADSHOT_Y_FRAC = 0.86;               // fraction of authoritative full height
export const SNIPER_SCOPE_ADS_THRESHOLD = 0.72;

const D2R = Math.PI / 180;

/** Shared hidden-condition rates used by authority and local prediction. */
export const CONDITION_RULES = Object.freeze({
  panicDamageGain: 0.012,
  panicHeadshotGain: 0.22,
  panicDecayPerS: 0.2,
  panicLowHpFloor: 0.45,
  painDamageGain: 0.016,
  painHeadshotGain: 0.28,
  painDecayPerS: 0.65,
  painLowHpFloor: 0.6,
  exhaustionSprintPerS: 0.24,
  exhaustionRecoverPerS: 0.18,
  exhaustionJumpGain: 0.14,
  exhaustionShotGain: 0.025,
});

/**
 * @typedef {Object} WeaponDef
 * @property {string} id            stable key ('rifle'|'smg'|'shotgun'|'sniper'|'lmg'|'revolver')
 * @property {string} name          display name
 * @property {'auto'|'semi'|'pump'|'bolt'} mode trigger behavior
 * @property {number} rpm           rounds per minute cap
 * @property {number} magSize       magazine capacity
 * @property {number} reserveMax    spare ammo pool
 * @property {[number,number,number]} damage  [close, far, falloffEnd] units; linear close->far between falloffStart(20) and falloffEnd
 * @property {number} headMult      headshot damage multiplier
 * @property {number} pellets       projectiles per shot (1 except shotgun)
 * @property {{hip:number, ads:number}} spreadDeg base cone half-angle, degrees
 * @property {number} bloomDeg      spread added per shot, degrees
 * @property {number} bloomMaxDeg   bloom ceiling, degrees
 * @property {number} bloomRecover  bloom decay deg/s
 * @property {number} moveSpreadDeg additional hip cone at full sprint, degrees
 * @property {number} crouchSpreadMult cone multiplier while crouched
 * @property {{pitch:number, yaw:number}} kickDeg max view-kick per shot, degrees
 * @property {number} adsFov        fov while aiming
 * @property {number} zoom          sight magnification (>1 scopes, used by overlay/SFX)
 * @property {number} adsTime       seconds to reach full ADS
 * @property {number} reloadTime    full magazine reload seconds
 * @property {number} tacTime       fast tactical reload seconds (round still chambered)
 * @property {number} deployTime    equip raise seconds
 * @property {{color:string,width:number,len:number}} tracer  visual spec, hex + px + world units
 * @property {number} weightKg      carried weapon mass; drives viewmodel inertia only
 * @property {string} sfx           bank key for the audio engine
 */

/** The six-gun roster. Slot order = scroll order. Tuned for TTK ~0.2–1.1 s. */
export const WEAPONS = {
  rifle: {
    id: 'rifle', name: 'VK-77 RAPTOR', mode: 'auto',
    weightKg: 3.4,
    rpm: 660, magSize: 30, reserveMax: 180,
    damage: [25, 15, 65], headMult: 1.85, pellets: 1,
    spreadDeg: { hip: 1.35, ads: 0.28 }, bloomDeg: 0.16, bloomMaxDeg: 2.6,
    bloomRecover: 4.2, moveSpreadDeg: 2.2,
    crouchSpreadMult: 0.72,
    kickDeg: { pitch: 0.42, yaw: 0.17 }, adsFov: 55, zoom: 1.3, adsTime: 0.16,
    reloadTime: 2.1, tacTime: 1.55, deployTime: 0.42,
    tracer: { color: '#ffd27a', width: 1.2, len: 26 },
    sfx: 'rifle',
  },
  smg: {
    id: 'smg', name: 'HORNET SMG', mode: 'auto',
    weightKg: 2.3,
    rpm: 900, magSize: 36, reserveMax: 216,
    damage: [19, 10, 42], headMult: 1.7, pellets: 1,
    spreadDeg: { hip: 1.9, ads: 0.75 }, bloomDeg: 0.13, bloomMaxDeg: 3.4,
    bloomRecover: 6.0, moveSpreadDeg: 1.4,
    crouchSpreadMult: 0.78,
    kickDeg: { pitch: 0.26, yaw: 0.22 }, adsFov: 62, zoom: 1.15, adsTime: 0.11,
    reloadTime: 1.75, tacTime: 1.3, deployTime: 0.3,
    tracer: { color: '#ffe9a8', width: 1.0, len: 22 },
    sfx: 'smg',
  },
  shotgun: {
    id: 'shotgun', name: 'M-DOCK 12', mode: 'pump',
    weightKg: 3.6,
    rpm: 78, magSize: 7, reserveMax: 42,
    damage: [13, 3, 24], headMult: 1.35, pellets: 9,
    spreadDeg: { hip: 4.4, ads: 3.1 }, bloomDeg: 0.5, bloomMaxDeg: 6,
    bloomRecover: 5.0, moveSpreadDeg: 1.2,
    crouchSpreadMult: 0.88,
    kickDeg: { pitch: 1.5, yaw: 0.35 }, adsFov: 66, zoom: 1.1, adsTime: 0.14,
    reloadTime: 3.1, tacTime: 2.6, deployTime: 0.5,
    tracer: { color: '#ffc37a', width: 1.0, len: 12 },
    sfx: 'shotgun',
  },
  sniper: {
    id: 'sniper', name: 'LONGSHOT MK-II', mode: 'bolt',
    weightKg: 5.2,
    rpm: 42, magSize: 5, reserveMax: 30,
    damage: [95, 68, 120], headMult: 2.1, pellets: 1,
    spreadDeg: { hip: 5.5, ads: 0.02 }, bloomDeg: 1.2, bloomMaxDeg: 7,
    bloomRecover: 3.0, moveSpreadDeg: 3.5,
    crouchSpreadMult: 0.58,
    kickDeg: { pitch: 2.1, yaw: 0.3 }, adsFov: 18, zoom: 5, adsTime: 0.26,
    reloadTime: 3.0, tacTime: 2.2, deployTime: 0.55,
    tracer: { color: '#bfe8ff', width: 1.6, len: 40 },
    sfx: 'sniper',
  },
  lmg: {
    id: 'lmg', name: 'BASTION LMG', mode: 'auto',
    weightKg: 8.4,
    rpm: 720, magSize: 60, reserveMax: 240,
    damage: [22, 14, 75], headMult: 1.7, pellets: 1,
    spreadDeg: { hip: 1.65, ads: 0.48 }, bloomDeg: 0.13, bloomMaxDeg: 3.1,
    bloomRecover: 3.0, moveSpreadDeg: 3.0,
    crouchSpreadMult: 0.68,
    kickDeg: { pitch: 0.36, yaw: 0.18 }, adsFov: 58, zoom: 1.2, adsTime: 0.22,
    reloadTime: 4.2, tacTime: 3.4, deployTime: 0.65,
    tracer: { color: '#ffbf5f', width: 1.3, len: 30 },
    sfx: 'lmg',
  },
  revolver: {
    id: 'revolver', name: 'IRONCLAD .44', mode: 'semi',
    weightKg: 1.4,
    rpm: 300, magSize: 6, reserveMax: 48,
    damage: [54, 35, 80], headMult: 1.9, pellets: 1,
    spreadDeg: { hip: 1.15, ads: 0.12 }, bloomDeg: 0.65, bloomMaxDeg: 3.6,
    bloomRecover: 3.4, moveSpreadDeg: 1.8,
    crouchSpreadMult: 0.7,
    kickDeg: { pitch: 1.25, yaw: 0.26 }, adsFov: 56, zoom: 1.35, adsTime: 0.13,
    reloadTime: 2.35, tacTime: 1.8, deployTime: 0.28,
    tracer: { color: '#ffe0a3', width: 1.4, len: 28 },
    sfx: 'revolver',
  },
};

export const WEAPON_IDS = ['rifle', 'smg', 'shotgun', 'sniper', 'lmg', 'revolver'];

/** Linear falloff between close-range and far-range damage. */
export function damageAtDistance(def, dist) {
  const falloffStart = 20;
  const t = Math.min(1, Math.max(0, (dist - falloffStart) / (def.damage[2] - falloffStart)));
  return def.damage[0] + (def.damage[1] - def.damage[0]) * t;
}

/** Movement, stance, bloom, and hidden-condition spread. Trailing defaults keep older callers valid. */
export function computeSpreadConeDeg(
  def,
  bloomDeg,
  speedXZ,
  adsT,
  panic = 0,
  exhaustion = 0,
  crouching = false,
  pain = 0,
) {
  const t = Math.max(0, Math.min(1, adsT));
  const hip = def.spreadDeg.hip + def.moveSpreadDeg * Math.min(1, speedXZ / 6.2);
  const base = hip + (def.spreadDeg.ads - hip) * t;
  const panic01 = Math.max(0, Math.min(1, Number.isFinite(panic) ? panic : 0));
  const exhaustion01 = Math.max(0, Math.min(1, Number.isFinite(exhaustion) ? exhaustion : 0));
  const pain01 = Math.max(0, Math.min(1, Number.isFinite(pain) ? pain : 0));
  const stanceMult = crouching
    ? Math.max(0, Math.min(1, Number.isFinite(def.crouchSpreadMult) ? def.crouchSpreadMult : 1))
    : 1;
  const conditionPenalty = (panic01 * 0.85 + exhaustion01 * 1.15 + pain01 * 1.65)
    * (1 - t * 0.45);
  return (base + bloomDeg * (1 - t * 0.75)) * stanceMult + conditionPenalty;
}

/**
 * Sample one direction inside the weapon cone.
 * `rng` is a ()=>float in [0,1); deterministic via shared/mulberry32 on server.
 * Spring-disk distribution (sqrt radius) so density is uniform over the cone area.
 * Returns a NEW unit-length dir object {x,y,z}.
 */
export function sampleSpreadDir(fwd, rng, halfAngleDeg) {
  const a = rng() * Math.PI * 2;
  const r = Math.sqrt(rng()) * Math.tan(halfAngleDeg * D2R);
  // build tangent basis around fwd
  const upAbs = Math.abs(fwd.y) > 0.99 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
  let tx = fwd.y * upAbs.z - fwd.z * upAbs.y;
  let ty = fwd.z * upAbs.x - fwd.x * upAbs.z;
  let tz = fwd.x * upAbs.y - fwd.y * upAbs.x;
  const tl = Math.hypot(tx, ty, tz) || 1; tx /= tl; ty /= tl; tz /= tl;
  const bx = fwd.y * tz - fwd.z * ty;
  const by = fwd.z * tx - fwd.x * tz;
  const bz = fwd.x * ty - fwd.y * tx;
  const cx = fwd.x + tx * Math.cos(a) * r + bx * Math.sin(a) * r;
  const cy = fwd.y + ty * Math.cos(a) * r + by * Math.sin(a) * r;
  const cz = fwd.z + tz * Math.cos(a) * r + bz * Math.sin(a) * r;
  const l = Math.hypot(cx, cy, cz);
  return { x: cx / l, y: cy / l, z: cz / l };
}

/** Smallest angle between two unit dirs, degrees (server-side sanity check). */
export function angleBetweenDeg(a, b) {
  const d = Math.min(1, Math.max(-1, a.x * b.x + a.y * b.y + a.z * b.z));
  return Math.acos(d) / D2R;
}
