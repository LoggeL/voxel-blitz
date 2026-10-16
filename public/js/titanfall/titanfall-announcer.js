/**
 * Titanfall announcer cue mapping (docs/titanfall.md §8.4; WP6). The voice is
 * the shared single announcer (sfx.objectiveAudio(): priority coalescing, no
 * queue); this module loads the Gemini TTS WAVs once a context exists
 * (shared/announcer.js TITANFALL_CUES, titanfallCueUrl) and decides which cue
 * an authoritative event or HUD state change speaks.
 *
 * `titanfallEventCue(event, ctx)` and `titanfallStateCues(prev, next, ctx)`
 * are pure (unit-tested); `createTitanfallAnnouncer` owns loading, the
 * repeat guards and the timers, and dispose() stops all of them.
 */
import { TITANFALL_CUES, titanfallCueUrl } from '../../../shared/announcer.js';

/** Minimum gap per cue (ms) so a burst of events cannot repeat one call. */
export const TITANFALL_CUE_GAPS = Object.freeze({ enemy_titan: 20000, winning: 60000, losing: 60000, rodeo_warning: 6000,
  battery_acquired: 4000, titanfall_ready: 8000, titan_ready: 8000, prepare_titanfall: 4000, core_online: 8000,
  titan_doomed: 4000, eject: 4000, match_win: 600000, match_lose: 600000 });
/** Score lead (points) that calls winning / losing. */
export const LEAD_CALL = 40;

/**
 * One gameplay event -> cue or null. ctx = { selfId, selfTeam, ownTitanId, teamOf(id) }.
 */
export function titanfallEventCue(event, ctx = {}) {
  if (!event || typeof event.kind !== 'string') return null;
  const self = ctx.selfId == null ? null : String(ctx.selfId);
  const own = ctx.ownTitanId ?? null;
  switch (event.kind) {
    case 'titanfall_drop': {
      if (self && String(event.owner) === self) return 'prepare_titanfall';
      const team = typeof ctx.teamOf === 'function' ? ctx.teamOf(event.owner) : null;
      return team && ctx.selfTeam && team !== ctx.selfTeam ? 'enemy_titan' : null;
    }
    case 'core_ready': return own && event.vehicleId === own ? 'core_online' : null;
    case 'titan_doomed': return own && event.vehicleId === own ? 'titan_doomed' : null;
    case 'rodeo_mount': return own && event.vehicleId === own && String(event.id) !== self ? 'rodeo_warning' : null;
    case 'rodeo_rip': return self && String(event.id) === self ? 'battery_acquired' : null;
    case 'battery_pickup': return self && String(event.id) === self ? 'battery_acquired' : null;
    default: return null;
  }
}

/**
 * HUD model transitions -> cues: meter full, own titan landed, the eject
 * reminder late in doom, the score lead and the match result.
 */
export function titanfallStateCues(prev, next, { winner = undefined, selfTeam = null } = {}) {
  const cues = [];
  if (!next) return cues;
  const meter = model => model?.pilot?.meter?.state ?? model?.meter?.state ?? null;
  // Full meter (filling -> ready) or a full bay freeing up (bay -> ready): the pilot can call now.
  if (meter(next) === 'ready' && (meter(prev) === 'filling' || meter(prev) === 'bay')) cues.push('titanfall_ready');
  if (meter(prev) === 'dropping' && meter(next) === 'owned') cues.push('titan_ready');
  const doomLeft = next.titan?.doomed ? next.titan.doomLeft : null;
  const prevDoom = prev?.titan?.doomed ? prev.titan.doomLeft : null;
  if (doomLeft != null && doomLeft <= 3.5 && (prevDoom == null || prevDoom > 3.5)) cues.push('eject');
  const lead = model => model?.top ? model.top.own.score - model.top.enemy.score : 0;
  if (prev?.top && next.top) {
    if (lead(next) >= LEAD_CALL && lead(prev) < LEAD_CALL) cues.push('winning');
    if (lead(next) <= -LEAD_CALL && lead(prev) > -LEAD_CALL) cues.push('losing');
  }
  if (winner !== undefined && selfTeam && winner !== null) cues.push(winner === selfTeam ? 'match_win' : 'match_lose');
  return cues;
}

/** How long a call made before the WAVs finished decoding may still be spoken once they have. */
const PENDING_CUE_MS = 2500;
const defaultClock = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

/** The live announcer: loads the calls and speaks cues through `announcer.play`. */
export function createTitanfallAnnouncer({ audio = null, fetchImpl = globalThis.fetch?.bind(globalThis), now = defaultClock } = {}) {
  const engine = audio?.engine ?? null, announcer = audio?.announcer ?? null;
  const lastAt = new Map();
  let loading = null, loaded = false, pending = null, disposed = false;
  const played = [];
  // Only a call the voice accepted counts: a refused one (buffer not decoded yet, context
  // suspended, tab hidden) neither starts the cue's gap nor enters the `played` log.
  const speak = (cue, at) => {
    let ok = false;
    try { ok = announcer?.play?.(cue) === true; } catch { ok = false; }
    if (ok) { lastAt.set(cue, at); played.push(cue); }
    return ok;
  };
  const load = () => {
    if (loading || disposed) return loading;
    if (!engine?.ctx || typeof fetchImpl !== 'function' || typeof announcer?.registerBuffer !== 'function') return null;
    loading = Promise.all(Object.keys(TITANFALL_CUES).map(async cue => {
      try {
        const response = await fetchImpl(titanfallCueUrl(cue));
        if (!response.ok) return 0;
        const buffer = await engine.ctx.decodeAudioData(await response.arrayBuffer());
        return !disposed && announcer.registerBuffer(cue, buffer) ? 1 : 0;
      } catch { return 0; }
    })).then(counts => {
      loaded = true;
      // A call made while the WAVs were still decoding is spoken now, if it is still fresh.
      const late = pending;
      pending = null;
      if (late && !disposed && now() - late.at <= PENDING_CUE_MS) speak(late.cue, now());
      return counts.reduce((a, b) => a + b, 0);
    });
    return loading;
  };
  return {
    played,
    /** Start decoding the calls (needs the shared AudioContext); null until it exists. */
    load,
    play(cue) {
      if (disposed || !Object.hasOwn(TITANFALL_CUES, cue)) return false;
      const at = now(), last = lastAt.get(cue);
      if (Number.isFinite(last) && at - last < (TITANFALL_CUE_GAPS[cue] ?? 3000)) return false;
      load();
      if (speak(cue, at)) return true;
      if (loading && !loaded) pending = { cue, at };
      return false;
    },
    dispose() {
      disposed = true;
      pending = null;
      lastAt.clear();
      try { announcer?.stop?.(); } catch { /* voice already gone */ }
    },
  };
}
