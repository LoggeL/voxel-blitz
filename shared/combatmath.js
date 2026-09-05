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
 * @property {string} id            stable key ('rifle'|'smg'|'shotgun'|'sniper'|'lmg'|'revolver'|'longarc'|'rocket'|'lance'|'knife')
 * @property {string} name          display name
 * @property {'auto'|'semi'|'pump'|'bolt'|'charge'|'melee'} mode trigger behavior; `charge` fires on
 *                                  trigger release and scales with the hold (see `charge`); `melee`
 *                                  swings consume no ammunition and never reload (see `melee`)
 * @property {number} rpm           rounds per minute cap
 * @property {number} magSize       magazine capacity
 * @property {number} spareMags    full spare magazines carried on spawn
 * @property {[number,number,number]} damage  [close, far, falloffEnd] units; linear close->far between falloffStart and falloffEnd
 * @property {number} [falloffStart=20] distance before damage begins falling
 * @property {number} headMult      headshot damage multiplier
 * @property {number} pellets       projectiles per shot (1 except shotgun)
 * @property {boolean} [centerPellet=false] keep pellet zero exactly on the aim ray
 * @property {{hip:number, ads:number}} spreadDeg base cone half-angle, degrees
 * @property {number} bloomDeg      spread added per shot, degrees
 * @property {number} bloomMaxDeg   bloom ceiling, degrees
 * @property {number} bloomRecover  bloom decay deg/s
 * @property {number} moveSpreadDeg additional hip cone at full sprint, degrees
 * @property {number} crouchSpreadMult cone multiplier while crouched
 * @property {{pitch:number,pitchRamp:number,maxPitchRamp:number,yaw:number,yawPattern:number[],jitter:number,resetMs:number,adsMult:number,recovery:number}} recoil client camera/viewmodel recoil profile; `recovery` is the fraction of accumulated aim climb walked back once fire pauses for resetMs
 * @property {{start:number,perRound:number,end:number}} [reloadStages] tube/loose-round reload: rounds seat one at a time and firing interrupts the reload keeping every seated round
 * @property {number} adsFov        fov while aiming
 * @property {number} zoom          sight magnification (>1 scopes, used by overlay/SFX)
 * @property {number} adsTime       seconds to reach full ADS
 * @property {number} reloadTime    full magazine reload seconds
 * @property {number} tacTime       fast tactical reload seconds (round still chambered)
 * @property {number} deployTime    equip raise seconds
 * @property {?{color:string,width:number,len:number}} tracer  visual spec, hex + px + world units; `null` for weapons with no projectile line (melee)
 * @property {number} weightKg      carried weapon mass; drives viewmodel inertia only
 * @property {string} sfx           bank key for the audio engine
 * @property {{reach:number,coneDeg:number,backstabMult:number,backstabDot:number}} [melee] melee profile: swing hits enemies within `reach` meters inside a `coneDeg` arc; damage multiplies by `backstabMult` when the swing direction aligns with the victim's facing beyond `backstabDot`
 * @property {'rocket'|'bolt'} [projectile]  when set, the shot launches an authoritative projectile (shared/rocket-rules.js, shared/bolt-rules.js) instead of firing hitscan rays
 * @property {{ms:number,holdMaxMs:number,minDamageMult:number,damageExponent?:number,wallPierceAt?:number}} [charge]  charge-fire profile; `wallPierceAt` is the charge needed before terrain pierces (terrain penetration grows with charge)
 * @property {number} [hitRadius] extra body collision radius for a thick rail beam
 * @property {{players:number,walls:number,playerFalloff:number,wallFalloff:number}} [pierce]  rail pierce profile: victims the slug passes through, walls it crosses, and the multiplicative damage falloff per crossing
 */

/** The ten-weapon roster. Slot order = scroll order. Tuned for TTK ~0.2–1.1 s. */
export const WEAPONS = {
  rifle: {
    id: 'rifle', name: 'VK-77 RAPTOR', mode: 'auto',
    weightKg: 3.4,
    rpm: 660, magSize: 30, spareMags: 6,
    damage: [25, 15, 65], headMult: 1.85, pellets: 1,
    spreadDeg: { hip: 1.35, ads: 0.28 }, bloomDeg: 0.16, bloomMaxDeg: 2.6,
    bloomRecover: 4.2, moveSpreadDeg: 2.2,
    crouchSpreadMult: 0.72,
    recoil: {
      pitch: 0.68, pitchRamp: 0.055, maxPitchRamp: 0.33,
      yaw: 0.32, yawPattern: [-0.20, 0.15, 0.35, -0.40, -0.65, 0.25, 0.55, -0.15],
      jitter: 0.12, resetMs: 280, adsMult: 0.72, recovery: 0.62,
    },
    adsFov: 55, zoom: 1.3, adsTime: 0.16,
    reloadTime: 2.1, tacTime: 1.55, deployTime: 0.42,
    tracer: { color: '#ffd27a', width: 1.2, len: 26 },
    sfx: 'rifle',
  },
  smg: {
    id: 'smg', name: 'HORNET SMG', mode: 'auto',
    weightKg: 2.3,
    rpm: 900, magSize: 36, spareMags: 6,
    damage: [19, 10, 42], headMult: 1.7, pellets: 1,
    spreadDeg: { hip: 1.9, ads: 0.75 }, bloomDeg: 0.13, bloomMaxDeg: 3.4,
    bloomRecover: 6.0, moveSpreadDeg: 1.4,
    crouchSpreadMult: 0.78,
    recoil: {
      pitch: 0.42, pitchRamp: 0.025, maxPitchRamp: 0.18,
      yaw: 0.42, yawPattern: [-0.65, 0.70, -0.25, 0.95, -0.90, 0.35],
      jitter: 0.22, resetMs: 190, adsMult: 0.80, recovery: 0.55,
    },
    adsFov: 62, zoom: 1.15, adsTime: 0.11,
    reloadTime: 1.75, tacTime: 1.3, deployTime: 0.3,
    tracer: { color: '#ffe9a8', width: 1.0, len: 22 },
    sfx: 'smg',
  },
  shotgun: {
    id: 'shotgun', name: 'M-DOCK 12', mode: 'pump',
    weightKg: 3.6,
    rpm: 90, magSize: 7, spareMags: 6,
    damage: [14.5, 5, 50], falloffStart: 12,
    headMult: 1.35, pellets: 9, centerPellet: true,
    spreadDeg: { hip: 3.6, ads: 1.45 }, bloomDeg: 0.25, bloomMaxDeg: 4.2,
    bloomRecover: 6.0, moveSpreadDeg: 0.9,
    crouchSpreadMult: 0.82,
    recoil: {
      pitch: 2.35, pitchRamp: 0, maxPitchRamp: 0,
      yaw: 0.55, yawPattern: [-0.40, 0.45],
      jitter: 0.08, resetMs: 780, adsMult: 0.72, recovery: 0.72,
    },
    adsFov: 62, zoom: 1.15, adsTime: 0.12,
    reloadTime: 3.1, tacTime: 2.6, deployTime: 0.5,
    // Tube magazine: shells seat one at a time; a shot interrupts the reload.
    reloadStages: { start: 0.42, perRound: 0.36, end: 0.22 },
    tracer: { color: '#ffc37a', width: 1.0, len: 24 },
    sfx: 'shotgun',
  },
  sniper: {
    id: 'sniper', name: 'LONGSHOT MK-II', mode: 'bolt',
    weightKg: 5.2,
    rpm: 42, magSize: 5, spareMags: 6,
    damage: [95, 68, 120], headMult: 2.1, pellets: 1,
    spreadDeg: { hip: 5.5, ads: 0.02 }, bloomDeg: 1.2, bloomMaxDeg: 7,
    bloomRecover: 3.0, moveSpreadDeg: 3.5,
    crouchSpreadMult: 0.58,
    recoil: {
      pitch: 3.80, pitchRamp: 0, maxPitchRamp: 0,
      yaw: 0.58, yawPattern: [-0.25, 0.20],
      jitter: 0.06, resetMs: 1800, adsMult: 0.60, recovery: 0.55,
    },
    adsFov: 18, zoom: 5, adsTime: 0.26,
    reloadTime: 3.0, tacTime: 2.2, deployTime: 0.55,
    tracer: { color: '#bfe8ff', width: 1.6, len: 40 },
    sfx: 'sniper',
  },
  lmg: {
    id: 'lmg', name: 'BASTION LMG', mode: 'auto',
    weightKg: 8.4,
    rpm: 720, magSize: 60, spareMags: 4,
    damage: [22, 14, 75], headMult: 1.7, pellets: 1,
    spreadDeg: { hip: 1.65, ads: 0.48 }, bloomDeg: 0.13, bloomMaxDeg: 3.1,
    bloomRecover: 3.0, moveSpreadDeg: 3.0,
    crouchSpreadMult: 0.68,
    recoil: {
      pitch: 0.58, pitchRamp: 0.04, maxPitchRamp: 0.50,
      yaw: 0.34,
      yawPattern: [
        -0.15, -0.35, 0.20, 0.50, 0.70, 0.35,
        -0.10, -0.55, -0.75, -0.40, 0.15, 0.45,
      ],
      jitter: 0.10, resetMs: 340, adsMult: 0.74, recovery: 0.48,
    },
    adsFov: 58, zoom: 1.2, adsTime: 0.22,
    reloadTime: 4.2, tacTime: 3.4, deployTime: 0.65,
    tracer: { color: '#ffbf5f', width: 1.3, len: 30 },
    sfx: 'lmg',
  },
  revolver: {
    id: 'revolver', name: 'IRONCLAD .44', mode: 'semi',
    weightKg: 1.4,
    rpm: 300, magSize: 6, spareMags: 8,
    damage: [54, 35, 80], headMult: 1.9, pellets: 1,
    spreadDeg: { hip: 1.15, ads: 0.12 }, bloomDeg: 0.65, bloomMaxDeg: 3.6,
    bloomRecover: 3.4, moveSpreadDeg: 1.8,
    crouchSpreadMult: 0.7,
    recoil: {
      pitch: 2.25, pitchRamp: 0, maxPitchRamp: 0,
      yaw: 0.68, yawPattern: [-0.65, 0.35, 0.75, -0.25, -0.80, 0.55],
      jitter: 0.08, resetMs: 650, adsMult: 0.68, recovery: 0.70,
    },
    adsFov: 56, zoom: 1.35, adsTime: 0.13,
    reloadTime: 2.35, tacTime: 1.8, deployTime: 0.28,
    tracer: { color: '#ffe0a3', width: 1.4, len: 28 },
    sfx: 'revolver',
  },
  longarc: {
    // Automatic arc bolts, each carrying exactly one wall reflection.
    id: 'longarc', name: 'LN-03 LONGARC', mode: 'auto',
    weightKg: 4.1,
    rpm: 300, magSize: 8, spareMags: 6,
    damage: [88, 62, 95], headMult: 2.0, pellets: 1,
    spreadDeg: { hip: 1.6, ads: 0.08 }, bloomDeg: 0.5, bloomMaxDeg: 3.0,
    bloomRecover: 3.2, moveSpreadDeg: 2.2,
    crouchSpreadMult: 0.65,
    recoil: {
      pitch: 1.9, pitchRamp: 0, maxPitchRamp: 0,
      yaw: 0.4, yawPattern: [-0.5, 0.35, 0.6, -0.3],
      jitter: 0.07, resetMs: 900, adsMult: 0.65, recovery: 0.6,
    },
    adsFov: 38, zoom: 2, adsTime: 0.18,
    reloadTime: 2.6, tacTime: 2.0, deployTime: 0.5,
    tracer: { color: '#7dfcff', width: 1.5, len: 44 },
    sfx: 'longarc',
    projectile: 'bolt',
  },
  lance: {
    // Single-cell rail shot: release at any charge, then reload.
    id: 'lance', name: 'CL-9 VOLTLANCE', mode: 'charge',
    weightKg: 3.8,
    rpm: 100, magSize: 1, spareMags: 5,
    damage: [300, 220, 95], falloffStart: 45, headMult: 2.0, pellets: 1,
    spreadDeg: { hip: 1.2, ads: 0.05 }, bloomDeg: 0.4, bloomMaxDeg: 2.4,
    bloomRecover: 3.4, moveSpreadDeg: 2.0,
    crouchSpreadMult: 0.66,
    recoil: {
      pitch: 2.6, pitchRamp: 0, maxPitchRamp: 0,
      yaw: 0.45, yawPattern: [-0.40, 0.50, -0.30, 0.60],
      jitter: 0.06, resetMs: 1000, adsMult: 0.60, recovery: 0.62,
    },
    adsFov: 42, zoom: 1.8, adsTime: 0.17,
    reloadTime: 2.9, tacTime: 2.3, deployTime: 0.6,
    tracer: { color: '#c9a2ff', width: 4.0, len: 70 },
    sfx: 'lance',
    charge: {
      ms: 2800,           // hold that reaches a full charge
      holdMaxMs: 2800,    // cell vents: the shot fires itself at this hold
      minDamageMult: 0.08,
      damageExponent: 2,
      wallPierceAt: 0.4,    // piercing grows from this charge to five blocks at full
    },
    hitRadius: 0.22,
    pierce: { players: 6, walls: 5, playerFalloff: 0.9, wallFalloff: 0.9 },
  },
  knife: {
    // K-7 RIPPER: fighting knife. No magazine and no reload — every swing is free
    // and the cadence is the rpm cap alone. A short reach cone replaces ballistics;
    // swinging into an enemy from behind their facing is a lethal backstab.
    id: 'knife', name: 'K-7 RIPPER', mode: 'melee',
    weightKg: 0.9,
    rpm: 120, magSize: 0, spareMags: 0,
    damage: [58, 58, 2], headMult: 1.0, pellets: 1,
    spreadDeg: { hip: 0, ads: 0 }, bloomDeg: 0, bloomMaxDeg: 0,
    bloomRecover: 1, moveSpreadDeg: 0,
    crouchSpreadMult: 1,
    recoil: {
      pitch: 1.1, pitchRamp: 0, maxPitchRamp: 0,
      yaw: 0.3, yawPattern: [0.40, -0.35],
      jitter: 0.05, resetMs: 550, adsMult: 1, recovery: 0.7,
    },
    adsFov: 68, zoom: 1, adsTime: 0.08,
    reloadTime: 0, tacTime: 0, deployTime: 0.3,
    tracer: null,        // no projectile line: the swing arc is presentation-only
    sfx: 'knife',
    melee: { reach: 2.2, coneDeg: 110, backstabMult: 2.5, backstabDot: 0.4 },
  },
  rocket: {
    // Shoulder launcher: one slow rocket per tube that detonates on any contact. Splash
    // and terrain carve come from shared/rocket-rules.js; the owner's own blast launches
    // them hardest, so rocket jumps are a real movement tool.
    id: 'rocket', name: 'RX-8 HAVOC', mode: 'semi',
    weightKg: 9.6,
    rpm: 45, magSize: 1, spareMags: 5,
    damage: [100, 100, 60], headMult: 1.0, pellets: 1,
    spreadDeg: { hip: 1.1, ads: 0.25 }, bloomDeg: 0, bloomMaxDeg: 0,
    bloomRecover: 1, moveSpreadDeg: 1.4,
    crouchSpreadMult: 0.8,
    recoil: {
      pitch: 4.2, pitchRamp: 0, maxPitchRamp: 0,
      yaw: 1.1, yawPattern: [0.6, -0.5, 0.4, -0.6],
      jitter: 0.15, resetMs: 1500, adsMult: 0.8, recovery: 0.5,
    },
    adsFov: 58, zoom: 1.3, adsTime: 0.32,
    reloadTime: 2.9, tacTime: 2.9, deployTime: 0.85,
    tracer: { color: '#ff9f1c', width: 2.2, len: 6 },
    sfx: 'rocket',
    projectile: 'rocket',
  },
};

export const WEAPON_IDS = ['rifle', 'smg', 'shotgun', 'sniper', 'lmg', 'revolver', 'longarc', 'rocket', 'lance', 'knife'];

/** Charge profile with safe defaults for weapons that are not `charge` mode. */
export function chargeProfile(def) {
  const charge = def && def.charge;
  return {
    damageExponent: charge?.damageExponent ?? 1,
    ms: Number.isFinite(charge?.ms) ? charge.ms : 850,
    holdMaxMs: Number.isFinite(charge?.holdMaxMs) ? charge.holdMaxMs : 2200,
    minDamageMult: Number.isFinite(charge?.minDamageMult) ? charge.minDamageMult : 1,
    wallPierceAt: Number.isFinite(charge?.wallPierceAt) ? charge.wallPierceAt : 0,
  };
}

/** Normalized 0..1 charge for a hold of `heldMs` on a `charge` weapon. */
export function chargeFromHold(def, heldMs) {
  const profile = chargeProfile(def);
  const held = Number.isFinite(heldMs) ? Math.max(0, heldMs) : 0;
  return Math.min(1, held / Math.max(1, profile.ms));
}

/** Damage multiplier grows from the tap floor to full power using the charge curve. */
export function chargeDamageMult(def, charge01) {
  const profile = chargeProfile(def);
  const t = Math.max(0, Math.min(1, Number.isFinite(charge01) ? charge01 : 1));
  return profile.minDamageMult + (1 - profile.minDamageMult) * t ** profile.damageExponent;
}

/** Shared beam size and terrain penetration for prediction and authority. */
export function chargeShotProfile(def, charge01 = 1) {
  const t = def?.mode === 'charge' ? Math.max(0, Math.min(1, Number.isFinite(charge01) ? charge01 : 1)) : 1;
  const size = def?.mode === 'charge' ? 0.15 + 0.85 * t * t : 1;
  const threshold = chargeProfile(def).wallPierceAt;
  return {
    size,
    hitRadius: (def?.hitRadius || 0) * size,
    walls: t < threshold ? 0 : Math.floor((def?.pierce?.walls || 0) * t),
  };
}
/** Deterministic patterned camera kick in degrees; random01 only adds bounded micro-variation. */
export function computeRecoilKickDeg(def, shotIndex, adsT = 0, random01 = 0.5) {
  const profile = def.recoil;
  const index = Math.max(0, Math.trunc(Number.isFinite(shotIndex) ? shotIndex : 0));
  const ads = Math.max(0, Math.min(1, Number.isFinite(adsT) ? adsT : 0));
  const adsScale = 1 + (profile.adsMult - 1) * ads;
  const ramp = Math.min(profile.maxPitchRamp, index * profile.pitchRamp);
  const pattern = profile.yawPattern[index % profile.yawPattern.length];
  const random = Math.max(0, Math.min(1, Number.isFinite(random01) ? random01 : 0.5));
  const yawVariation = (random * 2 - 1) * profile.jitter;
  return {
    pitch: (profile.pitch + ramp) * adsScale,
    yaw: profile.yaw * (pattern + yawVariation) * adsScale,
  };
}

/**
 * Reload plan shared by authority and prediction. Magazine weapons swap in one step;
 * tube weapons seat rounds one at a time (`staged`), so the duration depends on how many
 * rounds are missing and the reload can be interrupted with every seated round kept.
 * @returns {{staged:boolean,rounds:number,seconds:number,startSeconds:number,perRoundSeconds:number,endSeconds:number}}
 */
export function reloadPlan(def, mag) {
  const inMag = Math.max(0, Math.min(def.magSize, Number.isFinite(mag) ? Math.trunc(mag) : 0));
  const stages = def.reloadStages;
  if (!stages) {
    return {
      staged: false,
      rounds: def.magSize,
      seconds: inMag > 0 ? def.tacTime : def.reloadTime,
      startSeconds: 0,
      perRoundSeconds: 0,
      endSeconds: 0,
    };
  }
  const rounds = Math.max(0, def.magSize - inMag);
  return {
    staged: true,
    rounds,
    seconds: stages.start + rounds * stages.perRound + stages.end,
    startSeconds: stages.start,
    perRoundSeconds: stages.perRound,
    endSeconds: stages.end,
  };
}

/** Linear falloff between close-range and far-range damage. */
export function damageAtDistance(def, dist) {
  const falloffStart = Number.isFinite(def.falloffStart) ? def.falloffStart : 20;
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

/** Shared per-pellet policy so prediction and authority cannot drift. */
export function samplePelletDirection(def, fwd, rng, halfAngleDeg, pelletIndex) {
  if (def.centerPellet === true && pelletIndex === 0) {
    return { x: fwd.x, y: fwd.y, z: fwd.z };
  }
  return sampleSpreadDir(fwd, rng, halfAngleDeg);
}

/** Smallest angle between two unit dirs, degrees (server-side sanity check). */
export function angleBetweenDeg(a, b) {
  const d = Math.min(1, Math.max(-1, a.x * b.x + a.y * b.y + a.z * b.z));
  return Math.acos(d) / D2R;
}
