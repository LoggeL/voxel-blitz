/**
 * Conquest dynamic weather (docs/conquest.md, *Weather*). The server draws one
 * seeded timeline per match from WEATHER_RULES (a forecast script of states
 * with holds and transitions, plus a lightning schedule), steps it with the
 * match clock and sends the current mix as `match.conquest.wx`. Every
 * gameplay effect (spotting range, aircraft lock range, bot vision, canopy
 * drift) is a multiplier in WEATHER_STATES, read from that same quantized
 * tuple on the server and the client, so prediction and presentation agree
 * with the authority. Pure data and pure functions: no clock, no I/O.
 */
import { mulberry32 } from './noise.js';

/** Wire order of the weather states (`wx[0]`, `wx[1]` index this list): append only. */
export const WEATHER_IDS = Object.freeze(['golden', 'overcast', 'mist', 'storm']);

/**
 * Per state, at full strength (a transition lerps every value):
 *   label        HUD name
 *   rain         0..1 rain strength (particles, wet surfaces, rain bed)
 *   wind         0..1 wind strength (soundscape, rain slant, canopy drift)
 *   lightning    0..1 lightning activity (strike chance per draw)
 *   spot         × spotting range (CONQUEST_RULES.spotRange / spotRangeRecon)
 *   lock         × lock range of the STINGER and the jet's AA missile (LOCK_RULES)
 *   vision       × bot sight range (infantry, crews and pilots)
 *   recognition  × bot detection rate (how fast a seen enemy is recognised)
 *   drift        m/s an open canopy drifts downwind at this state's wind
 */
export const WEATHER_STATES = Object.freeze({
  golden: Object.freeze({ label: 'CLEAR', rain: 0, wind: 0.3, lightning: 0,
    spot: 1, lock: 1, vision: 1, recognition: 1, drift: 0.5 }),
  overcast: Object.freeze({ label: 'OVERCAST', rain: 0, wind: 0.55, lightning: 0,
    spot: 0.92, lock: 0.95, vision: 0.92, recognition: 0.95, drift: 0.9 }),
  mist: Object.freeze({ label: 'FOG', rain: 0, wind: 0.12, lightning: 0,
    spot: 0.55, lock: 0.7, vision: 0.62, recognition: 0.8, drift: 0.2 }),
  storm: Object.freeze({ label: 'STORM', rain: 1, wind: 1, lightning: 1,
    spot: 0.7, lock: 0.75, vision: 0.72, recognition: 0.85, drift: 1.8 }),
});

/**
 * Timeline tuning. Times in ms of match clock.
 *   openingMs     the opening state holds this long (the action gate's 180 s run stays in it)
 *   holdMs        hold per state after the opening
 *   transitionMs  blend time between two states
 *   scripts       forecast scripts; one is drawn per match, its last state holds to the end;
 *                 every script opens clear (multipliers 1), so the first minutes play as before
 *   lightning     strike draws every `everyMs`, kept with the mix's lightning value as the
 *                 chance; strikes land anywhere within `reach` m of the map (the apron too)
 *   windVeerDeg   the seeded wind direction veers by up to this much over `windVeerMs`
 *   wetPerSec / dryPerSec   ground wetness gain per second of full rain / loss per dry second
 */
export const WEATHER_RULES = Object.freeze({
  openingMs: Object.freeze([240000, 330000]),
  holdMs: Object.freeze({
    golden: Object.freeze([150000, 240000]),
    overcast: Object.freeze([80000, 140000]),
    mist: Object.freeze([100000, 160000]),
    storm: Object.freeze([150000, 220000]),
  }),
  transitionMs: Object.freeze([45000, 75000]),
  scripts: Object.freeze([
    Object.freeze(['golden', 'overcast', 'storm', 'overcast', 'golden']),
    Object.freeze(['golden', 'mist', 'golden', 'overcast', 'storm']),
    Object.freeze(['golden', 'storm', 'overcast', 'golden', 'mist']),
    Object.freeze(['golden', 'overcast', 'mist', 'overcast', 'storm', 'golden']),
  ]),
  lightning: Object.freeze({ everyMs: Object.freeze([4000, 13000]), reach: 160 }),
  windVeerDeg: 35, windVeerMs: 300000,
  wetPerSec: 1 / 45, dryPerSec: 1 / 150,
});

/** The mix nobody changed: clear weather, every multiplier 1, no wind drift. */
export const CALM_WEATHER = Object.freeze({
  from: 'golden', to: 'golden', blend: 0, etaS: 0, next: null, windDeg: 0, wet: 0, label: WEATHER_STATES.golden.label,
  rain: 0, wind: 0, lightning: 0, spot: 1, lock: 1, vision: 1, recognition: 1, drift: Object.freeze({ x: 0, z: 0 }),
});

const clamp01 = value => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
const between = (rng, [lo, hi]) => lo + (hi - lo) * rng();
const smooth = t => t * t * (3 - 2 * t);
const MIX_KEYS = Object.freeze(['rain', 'wind', 'lightning', 'spot', 'lock', 'vision', 'recognition']);

/**
 * Deterministic timeline for `seed`: `{ seed, script, keys:[{ state, at, until }], strikes:[{ at, x, z }],
 * windDeg, durationMs }`. Key i holds `state` from `at` to `until`, then blends into key i + 1
 * until that key's `at`. `area` is the map rectangle strikes land around ({minX, maxX, minZ, maxZ}).
 */
export function weatherTimeline(seed, { durationMs = 20 * 60 * 1000, rules = WEATHER_RULES, area = null, script = null } = {}) {
  const rng = mulberry32((seed >>> 0) ^ 0x57EA7E3);
  const scripts = rules.scripts;
  const chosen = Array.isArray(script) && script.every(id => WEATHER_STATES[id])
    ? script : scripts[Math.floor(rng() * scripts.length) % scripts.length];
  const keys = [];
  let at = 0;
  chosen.forEach((state, index) => {
    if (at >= durationMs && index > 0) return;
    const hold = index === 0 ? between(rng, rules.openingMs) : between(rng, rules.holdMs[state] || rules.holdMs.golden);
    const until = index === chosen.length - 1 ? Infinity : Math.round(at + hold);
    keys.push({ state, at: Math.round(at), until });
    at = until + between(rng, rules.transitionMs);
  });
  const windDeg = Math.floor(rng() * 360);
  const timeline = { seed: seed >>> 0, script: chosen.slice(), keys, strikes: [], windDeg, durationMs };
  // Lightning: one draw every 4-13 s, kept with the storm's share of the mix as the chance.
  const box = area || { minX: 0, maxX: 768, minZ: 0, maxZ: 768 };
  const reach = rules.lightning.reach;
  const strikeRng = mulberry32((seed >>> 0) ^ 0x7B0175);
  for (let t = between(strikeRng, rules.lightning.everyMs); t < durationMs; t += between(strikeRng, rules.lightning.everyMs)) {
    const chance = strikeRng(), x = strikeRng(), z = strikeRng();
    if (chance >= weatherMixAt(timeline, t).lightning) continue;
    timeline.strikes.push({ at: Math.round(t),
      x: Math.round(box.minX - reach + x * (box.maxX - box.minX + 2 * reach)),
      z: Math.round(box.minZ - reach + z * (box.maxZ - box.minZ + 2 * reach)) });
  }
  return timeline;
}

/**
 * `{ from, to, blend, etaS, next }` of a timeline at match time `t` (ms): `etaS`
 * counts down to the next change (the end of a hold or of a transition) and
 * `next` names the state that change leads to (null on the last hold).
 */
export function weatherPhaseAt(timeline, t) {
  const keys = timeline?.keys || [];
  if (!keys.length) return { from: 'golden', to: 'golden', blend: 0, etaS: 0, next: null };
  const time = Math.max(0, Number.isFinite(t) ? t : 0);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i], next = keys[i + 1];
    if (time < key.until || !next) {
      return { from: key.state, to: key.state, blend: 0, etaS: next ? Math.ceil((key.until - time) / 1000) : 0, next: next?.state ?? null };
    }
    if (time < next.at) {
      return { from: key.state, to: next.state, blend: clamp01((time - key.until) / Math.max(1, next.at - key.until)),
        etaS: Math.ceil((next.at - time) / 1000), next: next.state };
    }
  }
  const last = keys[keys.length - 1];
  return { from: last.state, to: last.state, blend: 0, etaS: 0, next: null };
}

/** Blended state values of `from` → `to` at `blend` (smoothstepped): rain, wind, lightning and the multipliers. */
export function weatherMix(from, to, blend) {
  const a = WEATHER_STATES[from] || WEATHER_STATES.golden, b = WEATHER_STATES[to] || a;
  const k = smooth(clamp01(blend));
  const mix = {};
  for (const key of MIX_KEYS) mix[key] = a[key] + (b[key] - a[key]) * k;
  mix.driftSpeed = a.drift + (b.drift - a.drift) * k;
  mix.label = (k < 0.5 ? a : b).label;
  return mix;
}

/** weatherMix at a timeline time. */
export function weatherMixAt(timeline, t) {
  const phase = weatherPhaseAt(timeline, t);
  return weatherMix(phase.from, phase.to, phase.blend);
}

/** Wind direction (deg, the way the wind blows toward; 0 = +X, 90 = +Z) at match time `t`. */
export function windDegAt(timeline, t, rules = WEATHER_RULES) {
  const veer = rules.windVeerDeg * Math.sin((Math.max(0, t) / rules.windVeerMs) * Math.PI * 2);
  return (((timeline?.windDeg ?? 0) + veer) % 360 + 360) % 360;
}

/** Ground wetness after `dtS` seconds at `rain` strength (0..1). */
export function stepWetness(wet, rain, dtS, rules = WEATHER_RULES) {
  const dt = Math.max(0, Number.isFinite(dtS) ? dtS : 0);
  const r = clamp01(rain);
  return clamp01(clamp01(wet) + (r > 0.05 ? rules.wetPerSec * r * dt : -rules.dryPerSec * dt));
}

/**
 * The snapshot tuple `match.conquest.wx`: [from, to, blend100, etaS, windDeg, wet100, next (-1 none)]
 * (from/to/next index WEATHER_IDS). Seven small integers, about 22 bytes of JSON.
 */
export function encodeConquestWeather({ from, to, blend, etaS, windDeg, wet, next = null }) {
  const index = id => Math.max(0, WEATHER_IDS.indexOf(id));
  return [index(from), index(to), Math.round(clamp01(blend) * 100), Math.max(0, Math.round(etaS) | 0),
    Math.round(((windDeg % 360) + 360) % 360), Math.round(clamp01(wet) * 100), WEATHER_IDS.indexOf(next)];
}

/**
 * Decoded weather of a `wx` tuple, or null without one: the phase, the blended
 * values (WEATHER_STATES keys) and the canopy drift vector `drift {x, z}` (m/s).
 * The server reads its gameplay multipliers through this too, so both sides
 * compute them from the same quantized numbers.
 */
export function decodeConquestWeather(wx) {
  if (!Array.isArray(wx) || wx.length < 3) return null;
  const from = WEATHER_IDS[wx[0] | 0] ?? 'golden', to = WEATHER_IDS[wx[1] | 0] ?? from;
  const blend = clamp01((wx[2] | 0) / 100);
  const mix = weatherMix(from, to, blend);
  const windDeg = Number.isFinite(wx[4]) ? wx[4] : 0;
  const rad = windDeg * Math.PI / 180;
  const speed = mix.driftSpeed;
  return {
    from, to, blend, etaS: Math.max(0, wx[3] | 0), windDeg, wet: clamp01((wx[5] | 0) / 100),
    next: Number.isInteger(wx[6]) ? WEATHER_IDS[wx[6]] ?? null : null,
    label: mix.label, rain: mix.rain, wind: mix.wind, lightning: mix.lightning,
    spot: mix.spot, lock: mix.lock, vision: mix.vision, recognition: mix.recognition,
    drift: { x: Math.cos(rad) * speed, z: Math.sin(rad) * speed },
  };
}
