// Conquest dynamic weather authority (docs/conquest.md, *Weather*). One
// seeded timeline per match (shared/conquest-weather.js weatherTimeline),
// stepped with the match clock: the current phase and wetness ride the
// snapshot as `match.conquest.wx`, the lightning schedule becomes
// `weather_strike` events, and the gameplay multipliers (spotting, locks,
// bot vision, canopy drift) are decoded from that same tuple, so the server
// and the client read identical numbers.

import {
  CALM_WEATHER, WEATHER_RULES, WEATHER_STATES, decodeConquestWeather, encodeConquestWeather,
  stepWetness, weatherPhaseAt, weatherMix, weatherTimeline, windDegAt,
} from '../../../shared/conquest-weather.js';

/**
 * Seed source: the platform CSPRNG, so drawing a match seed never shifts a
 * seeded `Math.random` sequence (bot tests and the action gate replay theirs).
 */
const drawSeed = () => {
  const cell = new Uint32Array(1);
  if (globalThis.crypto?.getRandomValues) { globalThis.crypto.getRandomValues(cell); return cell[0] / 2 ** 32; }
  return Math.random();
};

/**
 * The VB_CONQUEST_WEATHER value as a weather option: unset or empty is
 * undefined (the default timeline), 'off' / 'false' / '0' / 'no' / 'none'
 * turn weather off (an env var can only carry the boolean `false` as text),
 * anything else (a state id such as 'storm', 'on') passes through.
 */
export function weatherOptionFromEnv(value) {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const text = value.trim().toLowerCase();
  return ['off', 'false', '0', 'no', 'none'].includes(text) ? 'off' : text;
}

/** Longest timeline drawn when the match has no finite time limit (lightning is scheduled up front). */
const OPEN_ENDED_MS = 60 * 60 * 1000;

/**
 * `option` (the mode rule `weather`): false/'off' disables weather (calm, no
 * `wx`); a state id ('storm') pins that state for the whole match (captures,
 * tests); an object `{ seed?, script?, state? }` fixes the seed, the script or
 * the state; anything else draws a fresh seed per match.
 */
export class ConquestWeather {
  constructor({ option = true, rules = WEATHER_RULES, durationMs = 20 * 60 * 1000, area = null, random = drawSeed } = {}) {
    this.option = option;
    this.rules = rules;
    // The strike schedule is drawn up front: a match without a finite time limit gets an hour of it.
    this.durationMs = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : OPEN_ENDED_MS;
    this.area = area;
    this.random = random;
    this.timeline = null;
    this.fixed = null;
    this.reset(0);
  }

  get enabled() { return this.option !== false && this.option !== 'off'; }

  /** Start a new match timeline at match clock `startedAt` (ms). */
  reset(startedAt, seed = null) {
    const option = this.option && typeof this.option === 'object' ? this.option : {};
    this.startedAt = Number.isFinite(startedAt) ? startedAt : 0;
    this.fixed = typeof this.option === 'string' && WEATHER_STATES[this.option] ? this.option
      : WEATHER_STATES[option.state] ? option.state : null;
    this.seed = Number.isFinite(seed) ? seed >>> 0 : Number.isFinite(option.seed) ? option.seed >>> 0
      : Math.floor(this.random() * 2 ** 31);
    this.timeline = this.enabled ? weatherTimeline(this.seed, { durationMs: this.durationMs, rules: this.rules, area: this.area,
      script: this.fixed ? [this.fixed] : option.script ?? null }) : null;
    this.nextStrike = 0;
    this.lastElapsed = 0;
    this.wet = this.fixed ? WEATHER_STATES[this.fixed].rain : 0;
    this.tuple = null;
    this.effects = CALM_WEATHER;
    this._sync(0);
    return this;
  }

  _sync(elapsed) {
    if (!this.timeline) { this.tuple = null; this.effects = CALM_WEATHER; return; }
    const phase = weatherPhaseAt(this.timeline, elapsed);
    const tuple = encodeConquestWeather({ ...phase, windDeg: windDegAt(this.timeline, elapsed, this.rules), wet: this.wet });
    // The effects object only changes with the tuple, so per-tick readers may cache by identity.
    if (this.tuple && tuple.every((value, i) => value === this.tuple[i])) return;
    this.tuple = tuple;
    this.effects = Object.freeze(decodeConquestWeather(tuple) ?? CALM_WEATHER);
  }

  /**
   * Advance to match clock `now` (ms). Returns the strikes due since the last
   * step, as `weather_strike` payloads `{ x, z }` (the policy adds the ground height).
   */
  step(now) {
    if (!this.timeline) return [];
    const elapsed = Math.max(0, (Number.isFinite(now) ? now : 0) - this.startedAt);
    const dtS = Math.max(0, elapsed - this.lastElapsed) / 1000;
    this.lastElapsed = elapsed;
    const phase = weatherPhaseAt(this.timeline, elapsed);
    this.wet = stepWetness(this.wet, weatherMix(phase.from, phase.to, phase.blend).rain, dtS, this.rules);
    this._sync(elapsed);
    const due = [];
    const strikes = this.timeline.strikes;
    while (this.nextStrike < strikes.length && strikes[this.nextStrike].at <= elapsed) {
      const strike = strikes[this.nextStrike++];
      // A long stall (or a late reset) never fires a backlog: only the last 2 s count.
      if (elapsed - strike.at <= 2000) due.push({ x: strike.x, z: strike.z });
    }
    return due;
  }

  /** `match.conquest.wx` or null while weather is off. */
  snapshot() { return this.tuple ? this.tuple.slice() : null; }
}
