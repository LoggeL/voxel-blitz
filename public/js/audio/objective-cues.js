/**
 * Conquest objective audio: procedural stingers (built from the shared
 * synthesis primitives, read-only) plus announcer calls from offline-
 * synthesized WAVs. Every cue maps 1:1 to an authoritative event:
 *
 *   flag_state  (own side starts capturing / neutralizing) → capture_start
 *   flag_state  (enemy on an own flag)                     → announcer under_attack_X
 *   flag_neutralized (we neutralized an enemy flag)         → neutralized
 *   flag_neutralized (an own flag was neutralized)          → lost + lost_X
 *   flag_captured    (own team)                             → captured + captured_X
 *   ticket_low       (own team)                             → ticket_low + tickets_low
 *   match end (phase → post, winner)                       → victory / defeat
 *
 * With the Conquest bank decoded (`bank` = sfx.conquestAudio()), the
 * capture-start, neutralized, captured, lost and low-tickets stingers play
 * their synthesized bank takes (project-original, see docs/audio/conquest-sfx.md),
 * and a progress tick loop runs while the local player
 * stands in a zone whose control is moving (pitch follows the control level).
 *
 * The live layer only damps repeats of the same call: the capture-start
 * stinger plays while the local player stands in that flag's zone (when the
 * integrator passes the self row to syncMatch) and at most once per
 * CAPTURE_START_REPEAT_MS per flag; "under attack" for one flag at most once
 * per UNDER_ATTACK_REPEAT_MS, because flag_state also fires on every mover
 * change (neutralizing → contested → neutralizing).
 */
import { createVoices } from './primitives.js';
import { OBJECTIVE_CUES, objectiveAnnouncerCue, objectiveCueUrl } from '../../../shared/announcer.js';
import { CONQUEST_RULES, FRONTIER_PLAN } from '../../../shared/conquest-contract.js';

export const OBJECTIVE_STINGERS = Object.freeze(['capture_start', 'neutralized', 'captured', 'lost', 'ticket_low', 'victory', 'defeat']);
const STINGER_GAIN = 0.5;
/** Recorded stinger takes (Conquest bank groups) and their level against the announcer. */
export const OBJECTIVE_SAMPLE_CUES = Object.freeze({
  capture_start: 'cq.flag.start', neutralized: 'cq.flag.neutralized', captured: 'cq.flag.captured',
  lost: 'cq.flag.lost', ticket_low: 'cq.flag.ticketsLow',
});
const SAMPLE_GAIN = 1.7;
export const CAPTURE_LOOP = Object.freeze({ group: 'cq.flag.progress', level: 0.32, fade: 0.25, states: Object.freeze(['capturing', 'neutralizing', 'restoring']) });
export const CAPTURE_START_REPEAT_MS = 4000;
export const UNDER_ATTACK_REPEAT_MS = 20000;
const FLAG_ZONES = new Map(FRONTIER_PLAN.flags.map(f => [f.id, f]));

/**
 * True when `pos` stands inside the flag's capture zone: within its radius and,
 * when both heights are known, within CONQUEST_RULES.presenceDy of the flag
 * like the server's presence test (a pilot flying over a flag is not in it).
 * `zones` maps flag id -> {x, y?, z, radius} (default: the plan, which has no heights).
 */
export function insideFlagZone(flagId, pos, zones = FLAG_ZONES) {
  const flag = zones.get(flagId);
  if (!flag || !Number.isFinite(pos?.x) || !Number.isFinite(pos?.z)) return false;
  if (Math.hypot(pos.x - flag.x, pos.z - flag.z) > flag.radius) return false;
  return !Number.isFinite(flag.y) || !Number.isFinite(pos.y) || Math.abs(pos.y - flag.y) <= CONQUEST_RULES.presenceDy;
}

/** Plan flag zones with the heights (and any moved centres) of the map metadata flags. */
export function flagZonesFrom(metaFlags) {
  const zones = new Map(FLAG_ZONES);
  for (const flag of Array.isArray(metaFlags) ? metaFlags : []) {
    if (typeof flag?.id !== 'string' || !Number.isFinite(flag.x) || !Number.isFinite(flag.z)) continue;
    const plan = FLAG_ZONES.get(flag.id);
    zones.set(flag.id, { x: flag.x, y: Number.isFinite(flag.y) ? flag.y : null, z: flag.z,
      radius: Number.isFinite(flag.radius) ? flag.radius : plan?.radius ?? 20 });
  }
  return zones;
}

/** Pure: the stinger an event earns for the local team, or null. */
export function stingerForEvent(ev, selfTeam) {
  if (!ev || !selfTeam) return null;
  switch (ev.kind) {
    case 'flag_state':
      return ev.team === selfTeam && (ev.state === 'capturing' || ev.state === 'neutralizing') ? 'capture_start' : null;
    case 'flag_neutralized':
      if (ev.prev === selfTeam && ev.team !== selfTeam) return 'lost';
      return ev.team === selfTeam ? 'neutralized' : null;
    case 'flag_captured':
      return ev.team === selfTeam ? 'captured' : null;
    case 'ticket_low':
      return ev.team === selfTeam ? 'ticket_low' : null;
    case 'match_end':
      return ev.winner == null ? null : ev.winner === selfTeam ? 'victory' : 'defeat';
    default:
      return null;
  }
}

/** Pure: the announcer cue of a match end. */
export const matchEndCue = (winner, selfTeam) => winner == null || !selfTeam ? null : winner === selfTeam ? 'victory' : 'defeat';

/** Note frequencies (Hz) used by the stingers. */
const N = Object.freeze({ A3: 220, C4: 261.63, E4: 329.63, G4: 392, A4: 440, B4: 493.88, C5: 523.25, D5: 587.33, E5: 659.25, G5: 783.99, A5: 880, C6: 1046.5 });

/** Stinger scores: [startSec, waveform, f0, f1|null, gain, attack, decay]. Plus optional noise swells. */
export const STINGER_SCORES = Object.freeze({
  capture_start: { notes: [[0, 'square', N.A4, null, 0.12, 0.004, 0.08], [0.09, 'square', N.E5, null, 0.12, 0.004, 0.12]] },
  neutralized: { notes: [[0, 'triangle', N.E5, N.C5, 0.22, 0.006, 0.22], [0.16, 'triangle', N.G4, null, 0.2, 0.006, 0.3]],
    noise: [[0, 'bandpass', 1800, 500, 0.08, 0.25]] },
  captured: { notes: [[0, 'sawtooth', N.C5, null, 0.13, 0.01, 0.16], [0.1, 'sawtooth', N.E5, null, 0.13, 0.01, 0.16],
    [0.2, 'sawtooth', N.G5, null, 0.14, 0.01, 0.2], [0.32, 'triangle', N.C6, null, 0.22, 0.01, 0.55], [0.32, 'triangle', N.C5, null, 0.16, 0.01, 0.55]],
  noise: [[0.28, 'highpass', 3000, 6000, 0.05, 0.4]] },
  lost: { notes: [[0, 'sawtooth', N.E5, null, 0.12, 0.01, 0.18], [0.16, 'sawtooth', N.C5, null, 0.12, 0.01, 0.18],
    [0.32, 'triangle', N.A4, N.A3, 0.24, 0.01, 0.6], [0.32, 'sine', 70, 45, 0.35, 0.005, 0.4]] },
  ticket_low: { notes: [[0, 'square', N.A5, null, 0.1, 0.004, 0.12], [0.16, 'square', N.E5, null, 0.1, 0.004, 0.12],
    [0.36, 'square', N.A5, null, 0.1, 0.004, 0.12], [0.52, 'square', N.E5, null, 0.1, 0.004, 0.16]] },
  victory: { notes: [[0, 'sawtooth', N.C5, null, 0.12, 0.01, 0.22], [0.18, 'sawtooth', N.E5, null, 0.12, 0.01, 0.22],
    [0.36, 'sawtooth', N.G5, null, 0.12, 0.01, 0.22], [0.6, 'triangle', N.C6, null, 0.2, 0.02, 1.1],
    [0.6, 'triangle', N.G5, null, 0.16, 0.02, 1.1], [0.6, 'triangle', N.E5, null, 0.14, 0.02, 1.1], [0.6, 'sine', N.C4, null, 0.2, 0.02, 1.2]],
  noise: [[0.56, 'highpass', 2500, 7000, 0.05, 0.9]] },
  defeat: { notes: [[0, 'sawtooth', N.A4, null, 0.12, 0.02, 0.32], [0.3, 'sawtooth', N.E4, null, 0.12, 0.02, 0.32],
    [0.62, 'triangle', N.C4, N.A3, 0.22, 0.03, 1.3], [0.62, 'triangle', N.E4, N.C4, 0.16, 0.03, 1.3], [0.62, 'sine', 55, 40, 0.3, 0.01, 1.2]] },
});

/**
 * Engine view: the shared AudioEngine (ctx / bus / noiseBuffer getters, read
 * live because its context starts after the first gesture) or a raw
 * AudioContext wrapped with its own output gain and white-noise buffer.
 */
function engineFrom(audioContext) {
  if (!audioContext) return () => null;
  if ('ctx' in audioContext) return () => (audioContext.ctx ? audioContext : null);
  const ctx = audioContext;
  if (typeof ctx.createGain !== 'function') return () => null;
  let wrapped = null;
  return () => {
    if (wrapped || ctx.state === 'closed') return wrapped;
    const bus = ctx.createGain();
    bus.gain.value = 0.9;
    bus.connect(ctx.destination);
    const rate = ctx.sampleRate || 44100;
    const noiseBuffer = ctx.createBuffer(1, rate, rate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    wrapped = { ctx, bus, noiseBuffer };
    return wrapped;
  };
}

/** Render one stinger score through primitives (tone / hiss) into `dest`. */
export function playStinger(voices, dest, id, at) {
  const score = STINGER_SCORES[id];
  if (!score || !voices) return false;
  for (const [start, type, f0, f1, g, att, dec] of score.notes) {
    voices.tone(dest, { t0: at + start, type, f0, f1: f1 || undefined, g, att, dec });
  }
  for (const [start, filter, f, sweepTo, g, dec] of score.noise || []) {
    voices.hiss(dest, { t0: at + start, filter, f, sweepTo, g, att: 0.02, dec });
  }
  return true;
}

/** Flag owners at match start from the frozen plan; kept current by events and snapshot syncs. */
const initialOwners = () => new Map(FRONTIER_PLAN.flags.map(f => [f.id, f.home ?? null]));

const defaultClock = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

export function createObjectiveCues({ audioContext = null, announcer = null, fetchImpl = globalThis.fetch?.bind(globalThis),
  hidden = () => globalThis.document?.hidden === true, now = defaultClock, bank = null, flagZones = null } = {}) {
  const zones = flagZonesFrom(flagZones);
  const currentEngine = engineFrom(audioContext);
  let voices = null;
  let voicesCtx = null;
  let output = null;
  const owners = initialOwners();
  let endKey = null;
  let disposed = false;
  let loading = null;
  const played = [];
  /** Local player position from the last syncMatch; selfKnown stays false until a self row was passed (no zone gate). */
  let selfPos = null;
  let selfKnown = false;
  const lastAt = new Map();
  const repeatBlocked = (key, windowMs) => {
    const at = now();
    const last = lastAt.get(key);
    if (Number.isFinite(last) && at - last < windowMs) return true;
    lastAt.set(key, at);
    return false;
  };

  const ensureVoices = engine => {
    if (voices && voicesCtx === engine.ctx) return voices;
    voices = null;
    try { output?.disconnect(); } catch { /* old context */ }
    output = null;
    if (!engine.noiseBuffer) return null;
    try {
      voices = createVoices(engine);
      voicesCtx = engine.ctx;
      output = engine.ctx.createGain();
      output.gain.value = STINGER_GAIN;
      output.connect(engine.bus || engine.ctx.destination);
    } catch { voices = null; output = null; }
    return voices;
  };

  // Decode the objective WAVs once, as soon as a context exists, and hand them to the announcer voice.
  const load = () => {
    if (loading) return loading;
    const engine = currentEngine();
    if (!engine?.ctx || typeof fetchImpl !== 'function' || typeof announcer?.registerBuffer !== 'function') return Promise.resolve(0);
    loading = (async () => {
      let loaded = 0;
      await Promise.all(Object.keys(OBJECTIVE_CUES).map(async cue => {
        try {
          const response = await fetchImpl(objectiveCueUrl(cue));
          if (!response.ok) return;
          const buffer = await engine.ctx.decodeAudioData(await response.arrayBuffer());
          if (!disposed && announcer.registerBuffer(cue, buffer)) loaded++;
        } catch { /* a missing call just stays silent */ }
      }));
      return loaded;
    })();
    return loading;
  };

  const bufferOf = group => (group && typeof bank?.getBuffer === 'function' ? bank.getBuffer(`${group}.1`) : null);
  const stinger = id => {
    if (!id || disposed || hidden()) return false;
    const engine = currentEngine();
    if (engine?.ctx?.state !== 'running' || !ensureVoices(engine)) return false;
    played.push(id);
    const buffer = bufferOf(OBJECTIVE_SAMPLE_CUES[id]);
    if (buffer) {
      try {
        const source = engine.ctx.createBufferSource();
        const level = engine.ctx.createGain();
        source.buffer = buffer;
        level.gain.value = SAMPLE_GAIN;
        source.connect(level).connect(output);
        source.onended = () => { try { source.disconnect(); level.disconnect(); } catch { /* gone */ } };
        source.start(engine.ctx.currentTime + 0.01);
        return true;
      } catch { /* fall through to the procedural score */ }
    }
    return playStinger(voices, output, id, engine.ctx.currentTime + 0.01);
  };

  // Capture progress tick loop while the local player stands in a moving zone.
  let progress = null;
  const stopProgress = () => {
    if (!progress) return;
    const { source, level, ctx } = progress;
    progress = null;
    try {
      const at = ctx.currentTime;
      level.gain.cancelScheduledValues(at);
      level.gain.setValueAtTime(level.gain.value, at);
      level.gain.linearRampToValueAtTime(0, at + CAPTURE_LOOP.fade);
      source.stop(at + CAPTURE_LOOP.fade + 0.05);
      source.onended = () => { try { source.disconnect(); level.disconnect(); } catch { /* gone */ } };
    } catch { /* context closed */ }
  };
  const updateProgress = flags => {
    const buffer = bufferOf(CAPTURE_LOOP.group);
    const engine = currentEngine();
    const zone = selfPos && Array.isArray(flags)
      ? flags.find(t => Array.isArray(t) && CAPTURE_LOOP.states.includes(t[3]) && insideFlagZone(String(t[0]), selfPos, zones)) : null;
    if (!zone || !buffer || disposed || hidden() || engine?.ctx?.state !== 'running' || !ensureVoices(engine)) { stopProgress(); return; }
    const ctx = engine.ctx;
    const control = Math.min(1, Math.abs(Number(zone[1]) || 0) / 100);
    const rate = 0.85 + 0.4 * control;
    if (!progress || progress.ctx !== ctx) {
      stopProgress();
      const source = ctx.createBufferSource();
      const level = ctx.createGain();
      source.buffer = buffer;
      source.loop = true;
      level.gain.value = 0;
      source.connect(level).connect(output);
      source.start(ctx.currentTime);
      level.gain.setTargetAtTime(CAPTURE_LOOP.level / STINGER_GAIN, ctx.currentTime, 0.05);
      progress = { source, level, ctx };
    }
    progress.source.playbackRate.setTargetAtTime(rate, ctx.currentTime, 0.1);
  };
  const speak = cue => (cue && !disposed && typeof announcer?.play === 'function' ? announcer.play(cue) : false);

  return {
    /** Starts (once) and returns the WAV decode; resolves to the number of calls registered. */
    get ready() { return load(); },
    /** Stingers and announcer calls already started (for tests and diagnostics). */
    get played() { return played.slice(); },
    /**
     * Track flag owners from the authoritative snapshot (match.conquest.flags
     * tuples), the local player's position (optional self row) and match end.
     */
    syncMatch(match, selfTeam, self = undefined) {
      if (self !== undefined) {
        selfKnown = true;
        selfPos = self && self.state !== 'dead' && Number.isFinite(self.x) && Number.isFinite(self.z)
          ? { x: self.x, y: Number.isFinite(self.y) ? self.y : null, z: self.z } : null;
      }
      if (match?.mode === 'conquest') load();
      const flags = match?.conquest?.flags;
      if (Array.isArray(flags)) for (const tuple of flags) if (Array.isArray(tuple)) owners.set(String(tuple[0]), tuple[2] ?? null);
      if (match?.phase === 'post') stopProgress();
      else if (selfKnown) updateProgress(flags);
      if (match?.mode === 'conquest' && match.phase === 'post' && selfTeam) {
        const key = `${match.conquest?.endsAt ?? ''}:${match.winner ?? 'draw'}`;
        if (key !== endKey) { endKey = key; this.handleEvent({ kind: 'match_end', winner: match.winner ?? null }, selfTeam); }
      } else if (match?.phase && match.phase !== 'post') endKey = null;
    },
    handleEvent(ev, selfTeam) {
      if (!ev || disposed) return null;
      load();
      const ownerBefore = typeof ev.flag === 'string' ? owners.get(ev.flag) ?? null : null;
      let id = stingerForEvent(ev, selfTeam);
      let cue = ev.kind === 'match_end' ? matchEndCue(ev.winner, selfTeam) : objectiveAnnouncerCue(ev, selfTeam, ownerBefore);
      if (id === 'capture_start' && ((selfKnown && !insideFlagZone(ev.flag, selfPos, zones))
        || repeatBlocked(`start:${ev.flag}`, CAPTURE_START_REPEAT_MS))) id = null;
      if (cue && cue.startsWith('under_attack_') && repeatBlocked(cue, UNDER_ATTACK_REPEAT_MS)) cue = null;
      if (ev.kind === 'flag_captured') owners.set(ev.flag, ev.team ?? null);
      if (ev.kind === 'flag_neutralized') owners.set(ev.flag, null);
      if (id) stinger(id);
      if (cue) speak(cue);
      return { stinger: id, cue };
    },
    /** True while the capture progress loop runs (tests and diagnostics). */
    get capturing() { return !!progress; },
    dispose() {
      disposed = true;
      stopProgress();
      try { output?.disconnect(); } catch { /* already gone */ }
      output = null; voices = null;
    },
  };
}
