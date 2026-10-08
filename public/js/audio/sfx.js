import { CosmeticAudio } from './cosmetics.js';
import { AnnouncerVoice } from './announcer.js';
import { PanicBreathCadence } from './panic-breath.js';
import { PainMoanCadence, PAIN_MOAN_THRESHOLD, painSampleChoice, renderPainMoan } from './pain-moans.js';
import { renderBreath } from './breath.js';
// Public procedural-audio facade. AudioEngine owns the one AudioContext and
// master graph; VoicePool owns every bounded output graph; synthesis modules
// are pure graph builders.
import { AudioEngine } from './engine.js';
import { VoicePool } from './voices.js';
import { FlameLoops } from './flame-loop.js';
import { MinigunMotor, MINIGUN_REPORT, minigunReportChoice, renderMinigunReport } from './minigun-motor.js';
import {
  PickaxeDigVariations, pickaxeDigMaterial, pickaxeSampleChoice, pickaxeMaterial, renderMeleeHitFallback,
  renderPickaxeContact,
} from './pickaxe.js';
import { createVoices } from './primitives.js';
import { BUILTIN_SAMPLE_MANIFEST, LocalSampleBank } from './samples.js';
import { MenuMusicLoop } from './music.js';
import { FootstepVariations, FOOTSTEP_SLOTS } from './footsteps.js';
import { bodyImpact, synthPainVoice } from './human.js';
import { IMPACT_PARAMS, genericImpact, impactGlass, impactMetal } from './impacts.js';
import {
  DRAW_LEN,
  WEP_TONE,
  cycleActionClick,
  drawCloth,
  genericReloadStep,
  glaiveFabricate,
  reloadGlaive,
  reloadLmg,
  reloadLongarc,
  reloadRevolver,
  reloadRocket,
} from './mechanics.js';
import {
  GLAIVE_CUES,
  arcZap,
  bubblePop,
  fireReportProfile,
  fireSampleProfile,
  renderFireReport,
  renderGlaiveCue,
  sendEcho,
} from './reports.js';

/** Weapons that borrow another weapon's sound bank (no recorded assets of their own). */
const SFX_ALIAS = Object.freeze({ stinger: 'rocket' });
const engine = new AudioEngine();
const cosmeticAudio = new CosmeticAudio(engine);
let pool = null;
let primitives = null;
let samples = null;
const announcer = new AnnouncerVoice(engine, cue => samples?.getBuffer(`announcer.${cue}`));
let builtInSamplesPromise = null;
let menuMusic = null;
let menuMusicVolume = 0.8;
let footstepVariations = new FootstepVariations();
let heartbeatAt = -Infinity;
const panicBreaths = new PanicBreathCadence();
const painMoans = new PainMoanCadence();
let painMoanVoice = null;
let localVocalUntil = 0;
let painHitVariant = -1;
let chargeLoop = null;
let bubbleChargeLoop = null;
let flameLoops = null;
let minigunMotor = null;
let minigunReportIndex = 0;
let pickaxeSwingIndex = 0;
let pickaxeImpactIndex = 0;
let pickaxeVariations = new PickaxeDigVariations();
let bulletWhizIndex = 0;
const vehicleLoops = new Map();
const glaiveLoops = new Map();

/** Bastion vehicle drones: sawtooth fundamental per hull; the walker adds a stride thud. */
const VEHICLE_DRONE = Object.freeze({ buggy: 140, apc: 90, walker: 60, jeep: 115, tank: 48 });
const VEHICLE_HOLD = 0.6;
const VEHICLE_FADE = 0.3;
const VEHICLE_LEVEL = 0.16;
const MAX_VEHICLE_LOOPS = 6;
const vehicleUnit = value => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
/** Rotorcraft share the blade-pass voice; the transport is a heavier tuning of it. */
const ROTOR_KINDS = new Set(['helicopter', 'transport']);
const AIRCRAFT_KINDS = new Set(['helicopter', 'transport', 'plane']);

/** Broadband rotor wash and jet exhaust share the normal positional output. */
function createAircraftVehicleVoice(ctx, output, key, kind, at) {
  const gain = ctx.createGain();
  gain.gain.value = 0;
  gain.connect(output);
  const makeNoise = (type, frequency, level, offset) => {
    const source = ctx.createBufferSource();
    source.buffer = engine.noiseBuffer;
    source.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = frequency;
    filter.Q.value = 0.65;
    const mix = ctx.createGain();
    mix.gain.value = level;
    source.connect(filter).connect(mix);
    source.start(at, offset);
    return { source, filter, mix };
  };
  const rotor = ROTOR_KINDS.has(kind);
  const body = makeNoise('lowpass', rotor ? 150 : 650, 0.85, 0);
  const wash = makeNoise('bandpass', rotor ? 450 : 1250, 0.55, 0.173);
  const tone = ctx.createOscillator();
  tone.type = 'sine';
  tone.frequency.value = rotor ? 45 : 230;
  const toneGain = ctx.createGain();
  toneGain.gain.value = rotor ? 0.16 : 0.06;
  tone.connect(toneGain).connect(gain);
  const sources = [body.source, wash.source, tone];
  const nodes = [body.filter, body.mix, wash.filter, wash.mix, toneGain, gain];
  const voice = { ctx, output, key, gain, kind, body, wash, tone, toneGain, sources, nodes,
    last: at, end: at };
  if (rotor) {
    // The blade-pass oscillator modulates broadband air, never the output.
    // This produces a rounded chop without an audible square-wave buzz.
    const pulse = ctx.createGain();
    pulse.gain.value = 0.54;
    const rotorPulse = ctx.createOscillator();
    rotorPulse.type = 'triangle';
    rotorPulse.frequency.value = 4;
    const pulseDepth = ctx.createGain();
    pulseDepth.gain.value = 0.46;
    rotorPulse.connect(pulseDepth).connect(pulse.gain);
    body.mix.connect(pulse);
    wash.mix.connect(pulse);
    pulse.connect(gain);
    rotorPulse.start(at);
    sources.push(rotorPulse);
    nodes.push(pulse, pulseDepth);
    Object.assign(voice, { pulse, rotorPulse, pulseDepth });
  } else {
    body.mix.connect(gain);
    wash.mix.connect(gain);
  }
  tone.start(at);
  pool.addCleanup(output, () => {
    voice.cleaned = true;
    for (const source of sources) {
      try { source.stop(); } catch {}
      source.disconnect();
    }
    for (const node of nodes) node.disconnect();
    if (vehicleLoops.get(voice.key) === voice) vehicleLoops.delete(voice.key);
  });
  return voice;
}

function tuneAircraftVehicleVoice(voice, options, speed, at) {
  const tune = (param, value) => {
    param.cancelScheduledValues(at);
    param.setTargetAtTime(value, at, 0.12);
  };
  if (ROTOR_KINDS.has(voice.kind)) {
    const rotor = vehicleUnit(options?.rotorSpeed);
    const moving = Math.min(1, speed / 34);
    // The transport's bigger two-blade rotor chops slower and lower.
    const heavy = voice.kind === 'transport' ? 0.72 : 1;
    tune(voice.rotorPulse.frequency, (3 + rotor * 21) * heavy);
    tune(voice.body.filter.frequency, (100 + rotor * 140) * heavy);
    tune(voice.wash.filter.frequency, 300 + rotor * 500 + moving * 250);
    tune(voice.wash.mix.gain, 0.4 + moving * 0.3);
    tune(voice.tone.frequency, 25 + rotor * 26);
    tune(voice.toneGain.gain, 0.14 * rotor);
    return VEHICLE_LEVEL * rotor * (0.7 + moving * 0.3);
  }
  const power = vehicleUnit(options?.enginePower);
  const moving = Math.min(1, speed / 100);
  tune(voice.body.filter.frequency, 400 + power * 1600);
  tune(voice.wash.filter.frequency, 750 + power * 2000 + moving * 300);
  tune(voice.wash.mix.gain, 0.35 + power * 0.25 + moving * 0.15);
  tune(voice.tone.frequency, 190 + power * 570 + moving * 120);
  tune(voice.toneGain.gain, 0.04 + power * 0.06);
  return VEHICLE_LEVEL * power * (0.85 + moving * 0.15);
}

function positionFrom(value) {
  const pos = positionOf(value);
  if (pos) return pos.slice(0, 3);
  return value && Number.isFinite(value.x) && Number.isFinite(value.z)
    ? [value.x, Number.isFinite(value.y) ? value.y : 0, value.z] : null;
}

function releaseVehicleLoop(key, voice) {
  if (!voice) return;
  const ctx = voice.ctx;
  const at = ctx && ctx.state !== 'closed' ? ctx.currentTime : 0;
  try {
    voice.gain.gain.cancelScheduledValues(at);
    voice.gain.gain.setValueAtTime(voice.gain.gain.value, at);
    voice.gain.gain.linearRampToValueAtTime(0, at + VEHICLE_FADE);
  } catch {}
  for (const source of voice.sources ?? [voice.osc, voice.sub]) {
    try { source.stop(at + VEHICLE_FADE + 0.05); } catch {}
  }
  if (vehicleLoops.get(key) === voice) vehicleLoops.delete(key);
  pool?.refresh(voice.output, null, VEHICLE_FADE);
}

/**
 * RIPTIDE in-flight whirr: a band-passed saw pair under a 30 Hz tremolo. The
 * return leg sits 20% higher so a listener can tell an incoming disc apart,
 * and Doppler follows the disc's radial speed relative to the listener.
 */
const GLAIVE_FLIGHT = Object.freeze({
  hz: 330, bandHz: 1900, q: 3.2, tremoloHz: 30, depth: 0.45, level: 0.16,
  backPitch: 1.2, hold: 0.25, fade: 0.12, maxLoops: 8, soundSpeed: 343,
});

function releaseGlaiveLoop(key, voice) {
  if (!voice) return;
  const ctx = voice.ctx;
  const at = ctx && ctx.state !== 'closed' ? ctx.currentTime : 0;
  try {
    voice.gain.gain.cancelScheduledValues(at);
    voice.gain.gain.setValueAtTime(voice.gain.gain.value, at);
    voice.gain.gain.linearRampToValueAtTime(0, at + GLAIVE_FLIGHT.fade);
    for (const osc of voice.sources) osc.stop(at + GLAIVE_FLIGHT.fade + 0.05);
  } catch {}
  if (glaiveLoops.get(key) === voice) glaiveLoops.delete(key);
  pool?.refresh(voice.output, null, GLAIVE_FLIGHT.fade);
}

/** Doppler ratio for a source moving at `velocity` as heard from `listener` (clamped). */
function dopplerRatio(pos, velocity, listener) {
  if (!Array.isArray(listener) || !velocity) return 1;
  const dx = pos[0] - listener[0];
  const dy = pos[1] - listener[1];
  const dz = pos[2] - listener[2];
  const distance = Math.hypot(dx, dy, dz);
  if (!(distance > 0.05)) return 1;
  // Positive radial speed means the disc is moving away from the listener.
  const radial = (velocity[0] * dx + velocity[1] * dy + velocity[2] * dz) / distance;
  const ratio = GLAIVE_FLIGHT.soundSpeed / (GLAIVE_FLIGHT.soundSpeed + radial);
  return Math.max(0.8, Math.min(1.25, ratio));
}

/**
 * Conquest vehicle weapons, hull and crew cues (presentation only; every call
 * comes from an authoritative event or snapshot field). Distances in metres.
 */
export const VEHICLE_SOUND = Object.freeze({
  farRange: 400,        // heavy sources are culled beyond this
  thumpFrom: 150,       // the low-passed far layer starts here
  crackTo: 260,         // the bright near crack is gone beyond this
  gunHold: 0.16, gunFade: 0.09, maxGunLoops: 6,
  burnHold: 0.7, burnFade: 0.5, maxBurnLoops: 3, burnLevel: 0.22,
  missileHold: 0.25, missileFade: 0.15, maxMissileLoops: 4,
  cueHold: 0.35, cueFade: 0.08,
});
/** Gun loop voicing per hitscan weapon: band (Hz), body (Hz), level, rounds/s. */
const VEHICLE_GUNS = Object.freeze({
  coaxMG: Object.freeze({ band: 1500, q: 0.9, body: 130, level: 0.42, rate: 10 }),
  hmg: Object.freeze({ band: 1050, q: 0.8, body: 92, level: 0.55, rate: 8 }),
  doorMinigun: Object.freeze({ band: 2100, q: 1.1, body: 150, level: 0.42, rate: 18 }),
  planeCannon: Object.freeze({ band: 820, q: 0.75, body: 70, level: 0.62, rate: 14 }),
});
/** Lock and alarm cue loops: carrier Hz, gate Hz (0 = steady), level. */
const VEHICLE_CUES = Object.freeze({
  locking: Object.freeze({ hz: 980, gate: 4, level: 0.07 }),
  locked: Object.freeze({ hz: 1180, gate: 0, level: 0.06 }),
  inbound: Object.freeze({ hz: 1460, gate: 11, level: 0.085 }),
  acquire: Object.freeze({ hz: 880, gate: 2.5, level: 0.05 }),
  lock: Object.freeze({ hz: 1320, gate: 0, level: 0.05 }),
  alarm: Object.freeze({ hz: 620, gate: 1.6, level: 0.06 }),
  alarmAir: Object.freeze({ hz: 760, gate: 2.4, level: 0.055 }),
});
const gunLoops = new Map();
const burnLoops = new Map();
const missileLoops = new Map();
const cueLoops = new Map();

/**
 * Distance from the audio listener to a world point. An unknown listener or
 * position counts as at the listener (0): the cue plays normally and neither
 * the 400 m cull nor the far layer applies.
 */
function listenerDistance(pos) {
  const listener = engine.listenerPos?.();
  if (!Array.isArray(pos) || !Array.isArray(listener) || !pos.every(Number.isFinite) || !listener.every(Number.isFinite)) return 0;
  return Math.hypot(pos[0] - listener[0], pos[1] - listener[1], pos[2] - listener[2]);
}

/**
 * The muffled "far layer" of a heavy source: a low-passed rumble that grows
 * as the bright near layer rolls off past VEHICLE_SOUND.thumpFrom.
 */
function farLayer(pos, { gain = 0.8, low = 52, lifetime = 2.4, delay = 0, group = 'cq.distant' } = {}) {
  const distance = listenerDistance(pos);
  if (!(distance > VEHICLE_SOUND.thumpFrom) || distance > VEHICLE_SOUND.farRange) return false;
  const weight = Math.min(1, (distance - VEHICLE_SOUND.thumpFrom) / VEHICLE_SOUND.thumpFrom);
  if (cqHas(group)) {
    // Conquest bank: a recorded distant boom with its rolling valley tail,
    // arriving after the flash (distance / 343 m/s).
    // The voice is held for FAR_BOOM_HOLD only: the 4.5-6.5 s recordings would
    // otherwise keep a priority-3 positional voice that gunfire can never evict.
    run('farLayer', () => {
      cqOneShot(group, { pos: pos.slice(0, 3), priority: 3, range: 'far', lowpass: 2600 }, {
        gain: CONQUEST_MIX.distant * gain * (0.55 + 0.45 * weight), rate: 0.92 + Math.random() * 0.14,
        delay: delay + distance / SOUND_SPEED, hold: FAR_BOOM_HOLD,
      });
    });
    return true;
  }
  run('farLayer', () => {
    const output = pool.acquire({ pos: pos.slice(0, 3), priority: 3, range: 'far', lowpass: 320 }, lifetime);
    const at = primitives.nowT(delay);
    primitives.tone(output, { t0: at, type: 'sine', f0: low, f1: 24, att: 0.02, dec: lifetime * 0.55, g: gain * (0.45 + 0.55 * weight) });
    primitives.hiss(output, { t0: at, filter: 'lowpass', f: 240, q: 0.5, att: 0.03, dec: lifetime * 0.6, g: gain * 0.5 * (0.4 + 0.6 * weight) });
    sendEcho(output, primitives, 0.35, engine.echoIn, addCleanup);
  });
  return true;
}

/**
 * Near take of a heavy source inside the far-layer band (VEHICLE_SOUND.thumpFrom
 * to crackTo): it is delayed like the far layer (distance / 343 m/s) so the two
 * land together, and its gain fades toward the far edge. Closer, it plays at
 * once and in full.
 */
export function nearHandover(distance) {
  const from = VEHICLE_SOUND.thumpFrom, to = VEHICLE_SOUND.crackTo;
  if (!(distance > from)) return { gain: 1, delay: 0 };
  const t = Math.min(1, (distance - from) / (to - from));
  return { gain: Math.cos(t * Math.PI / 2), delay: distance / SOUND_SPEED };
}

/** Stop and forget one refreshed loop voice (gun, burn, missile, cue). */
function releaseLoop(map, key, voice, fade) {
  if (!voice) return;
  const ctx = voice.ctx;
  const at = ctx && ctx.state !== 'closed' ? ctx.currentTime : 0;
  try {
    voice.gain.gain.cancelScheduledValues(at);
    voice.gain.gain.setValueAtTime(voice.gain.gain.value, at);
    voice.gain.gain.linearRampToValueAtTime(0, at + fade);
  } catch {}
  for (const source of voice.sources) {
    try { source.stop(at + fade + 0.05); } catch {}
  }
  if (map.get(key) === voice) map.delete(key);
  pool?.refresh(voice.output, null, fade);
}

/**
 * Shared refresh for sustained cue voices: create on demand (evicting the
 * stalest past `max`), hold the level for `hold`, then fade unless refreshed.
 */
function refreshLoop(map, key, { pos = null, priority = 1, range = 'near', hold, fade, max, level, create, retune }) {
  const ctx = engine.ctx;
  if (!ctx || ctx.state !== 'running') return null;
  const at = ctx.currentTime;
  let voice = map.get(key);
  if (voice && (voice.ctx !== ctx || at >= voice.end)) { releaseLoop(map, key, voice, fade); voice = null; }
  if (!voice) {
    while (map.size >= max) {
      const [oldKey, oldest] = [...map.entries()].reduce((a, b) => (a[1].last <= b[1].last ? a : b));
      releaseLoop(map, oldKey, oldest, fade);
    }
    const output = pool.acquire(pos ? { pos, priority, range } : { priority }, hold + fade);
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.connect(output);
    voice = { ctx, output, gain, sources: [], nodes: [gain], last: at, end: at };
    create(voice, at);
    // Sampled loops may start part-way into their buffer (loopOffset).
    for (const source of voice.sources) {
      if (source.loopOffset > 0) source.start(at, source.loopOffset);
      else source.start(at);
    }
    map.set(key, voice);
    pool.addCleanup(output, () => {
      for (const source of voice.sources) { try { source.stop(); } catch {} source.disconnect(); }
      for (const node of voice.nodes) node.disconnect();
      if (map.get(key) === voice) map.delete(key);
    });
  }
  retune?.(voice, at);
  const current = at >= voice.end ? 0 : voice.gain.gain.value;
  voice.last = at;
  voice.end = at + hold + fade;
  const g = voice.gain.gain;
  g.cancelScheduledValues(at);
  g.setValueAtTime(current, at);
  g.linearRampToValueAtTime(level, at + 0.03);
  g.setValueAtTime(level, at + hold);
  g.linearRampToValueAtTime(0, voice.end);
  for (const source of voice.sources) source.stop(voice.end + 0.05);
  pool.refresh(voice.output, pos ? { pos } : null, hold + fade);
  return voice;
}

/** Looping noise source through a filter into `dest`. */
function loopNoise(voice, type, frequency, q, level, dest = voice.gain) {
  const ctx = voice.ctx;
  const source = ctx.createBufferSource();
  source.buffer = engine.noiseBuffer;
  source.loop = true;
  const filter = ctx.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = frequency;
  filter.Q.value = q;
  const mix = ctx.createGain();
  mix.gain.value = level;
  source.connect(filter).connect(mix).connect(dest);
  voice.sources.push(source);
  voice.nodes.push(filter, mix);
  return { source, filter, mix };
}

/** Blast voice per explosive type: gain, low weight, and crack brightness. */
const EXPLOSION_PROFILES = Object.freeze({
  frag: Object.freeze({ gain: 1.08, lifetime: 1.25, low: 0.72, lowHz: 78, crack: 0.34, crackHz: 1850, echo: 0.22 }),
  limpet: Object.freeze({ gain: 1.18, lifetime: 2.2, low: 0.9, lowHz: 64, crack: 0.42, crackHz: 1500, echo: 0.28 }),
  pulse: Object.freeze({ gain: 1.0, lifetime: 1.2, low: 0.36, lowHz: 110, crack: 0.5, crackHz: 3400, echo: 0.16, electric: true }),
  rocket: Object.freeze({ gain: 1.22, lifetime: 2.2, low: 0.95, lowHz: 58, crack: 0.4, crackHz: 1600, echo: 0.3 }),
  mgl: Object.freeze({ gain: 1.08, lifetime: 1.45, low: 0.82, lowHz: 68, crack: 0.4, crackHz: 2350, echo: 0.2 }),
});

/** One sustained capacitor whine for a held charge (LONGARC, VOLTLANCE); created lazily, never pooled. */
function ensureChargeLoop() {
  const ctx = engine.ctx;
  if (!ctx || ctx.state === 'closed' || !engine.bus) return null;
  if (chargeLoop && chargeLoop.ctx === ctx) return chargeLoop;
  const oscillator = ctx.createOscillator();
  oscillator.type = 'sawtooth';
  oscillator.frequency.value = 180;
  const shimmer = ctx.createOscillator();
  shimmer.type = 'sine';
  shimmer.frequency.value = 360;
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 600;
  filter.Q.value = 3;
  const gain = ctx.createGain();
  gain.gain.value = 0;
  oscillator.connect(filter);
  shimmer.connect(filter);
  filter.connect(gain).connect(engine.bus);
  oscillator.start();
  shimmer.start();
  chargeLoop = { ctx, oscillator, shimmer, filter, gain, level: 0 };
  return chargeLoop;
}

function disposeChargeLoop() {
  if (chargeLoop) {
    try {
      chargeLoop.oscillator.stop();
      chargeLoop.shimmer.stop();
      chargeLoop.gain.disconnect();
    } catch {}
    chargeLoop = null;
  }
  if (bubbleChargeLoop) {
    try {
      bubbleChargeLoop.noise.stop();
      bubbleChargeLoop.tone.stop();
      bubbleChargeLoop.vibrato.stop();
      bubbleChargeLoop.tremolo.stop();
      bubbleChargeLoop.gain.disconnect();
    } catch {}
    bubbleChargeLoop = null;
  }
}

/**
 * SUDSBLASTER Big-Bubble hold: a band-passed breath of air through the wand and a wobbling
 * soap-film tone that both climb with the charge; past 90 % a slow tremolo creaks the film.
 */
function ensureBubbleChargeLoop() {
  const ctx = engine.ctx;
  if (!ctx || ctx.state === 'closed' || !engine.bus || !engine.noiseBuffer) return null;
  if (bubbleChargeLoop && bubbleChargeLoop.ctx === ctx) return bubbleChargeLoop;
  const noise = ctx.createBufferSource();
  noise.buffer = engine.noiseBuffer;
  noise.loop = true;
  const band = ctx.createBiquadFilter();
  band.type = 'bandpass';
  band.frequency.value = 600;
  band.Q.value = 1.2;
  const tone = ctx.createOscillator();
  tone.type = 'sine';
  tone.frequency.value = 220;
  const vibrato = ctx.createOscillator();
  vibrato.frequency.value = 6;
  const vibratoDepth = ctx.createGain();
  vibratoDepth.gain.value = 8;
  vibrato.connect(vibratoDepth).connect(tone.frequency);
  const toneGain = ctx.createGain();
  toneGain.gain.value = 0.45;
  const creak = ctx.createGain();
  creak.gain.value = 1;
  const tremolo = ctx.createOscillator();
  tremolo.frequency.value = 13;
  const tremoloDepth = ctx.createGain();
  tremoloDepth.gain.value = 0;
  tremolo.connect(tremoloDepth).connect(creak.gain);
  const gain = ctx.createGain();
  gain.gain.value = 0;
  noise.connect(band).connect(creak);
  tone.connect(toneGain).connect(creak);
  creak.connect(gain).connect(engine.bus);
  noise.start();
  tone.start();
  vibrato.start();
  tremolo.start();
  bubbleChargeLoop = { ctx, noise, band, tone, vibrato, vibratoDepth, tremolo, tremoloDepth, gain, level: 0 };
  return bubbleChargeLoop;
}

function copyOptions(value) {
  if (Array.isArray(value)) return value.slice(0, 3);
  if (!value || typeof value !== 'object') return value;
  return {
    ...value,
    pos: Array.isArray(value.pos) ? value.pos.slice(0, 3) : value.pos,
  };
}

function positionOf(value) {
  if (Array.isArray(value)) return value;
  return value && Array.isArray(value.pos) ? value.pos : null;
}

function outputOptions(value) {
  return {
    pos: positionOf(value),
    muffled: !!(value && !Array.isArray(value) && value.muffled),
  };
}

function ensureAudioModules() {
  if (!engine.ctx || engine.ctx.state === 'closed') return false;
  if (!pool) pool = new VoicePool(engine);
  if (!flameLoops) {
    flameLoops = new FlameLoops(engine, pool,
      () => samples?.getBuffer('weapons.flamethrower.loop'));
  }
  if (!minigunMotor) minigunMotor = new MinigunMotor(engine, pool);
  if (!primitives) primitives = createVoices(engine);
  if (!samples) {
    samples = new LocalSampleBank({
      getContext: () => engine.ctx,
      addCleanup,
    });
  }
  if (!menuMusic) {
    menuMusic = new MenuMusicLoop({
      getContext: () => engine.ctx,
      getDestination: () => engine.musicDestination,
      volume: menuMusicVolume,
    });
  }
  return true;
}

function run(kind, callback) {
  return engine.queueOrRun(kind, () => {
    if (ensureAudioModules()) callback();
  });
}

function loadBuiltInSamples() {
  if (!samples) return Promise.resolve(Object.freeze({ loaded: 0, failed: 0 }));
  if (!builtInSamplesPromise) {
    builtInSamplesPromise = samples.load(BUILTIN_SAMPLE_MANIFEST).catch(() =>
      Object.freeze({ loaded: 0, failed: Object.keys(BUILTIN_SAMPLE_MANIFEST).length }));
  }
  return builtInSamplesPromise;
}

function addCleanup(output, cleanup) {
  pool.addCleanup(output, cleanup);
}

function createReportLayer(output, gain) {
  const layer = primitives.createGain();
  layer.gain.value = Math.max(0, Math.min(1, Number(gain) || 0));
  layer.connect(output);
  addCleanup(output, () => layer.disconnect());
  return layer;
}

// ---------------------------------------------------------------------------
// Conquest sample bank (slots `cq.<group>.<n>` from audio/conquest-bank.js,
// decoded only for a Conquest match). Each Conquest cue prefers a decoded
// variant and keeps its procedural voice as the fallback, so the menu, the
// other modes and a match whose bank is still loading sound as before.
// ---------------------------------------------------------------------------
const CQ_PREFIX = 'cq.';
const CQ_MAX_VARIANTS = 8;
const cqLastVariant = new Map();
let conquestBankPromise = null;
let conquestBankGeneration = 0;
/** Seconds before each retry of the Conquest files that failed to fetch or decode. */
export const CONQUEST_BANK_RETRIES = Object.freeze([5, 20]);

/**
 * Load `manifest` into the sample bank; files that fail are retried in the
 * background (CONQUEST_BANK_RETRIES) until the bank is unloaded. Resolves with
 * the first attempt's result.
 */
function loadConquestSlots(manifest, fetchImpl, generation, attempt) {
  return samples.load(manifest, fetchImpl)
    .catch(() => Object.freeze({ loaded: 0, failed: Object.keys(manifest).length }))
    .then(result => {
      if (result.failed > 0 && attempt < CONQUEST_BANK_RETRIES.length && typeof setTimeout === 'function') {
        const timer = setTimeout(() => {
          if (generation !== conquestBankGeneration || !samples) return;
          const missing = Object.fromEntries(Object.entries(manifest).filter(([slot]) => !samples.getBuffer(slot)));
          if (Object.keys(missing).length) void loadConquestSlots(missing, fetchImpl, generation, attempt + 1);
        }, CONQUEST_BANK_RETRIES[attempt] * 1000);
        timer?.unref?.();
      }
      return result;
    });
}
/** Decoded mix levels (bank loops sit near -18 LUFS, one-shots peak at -3.5 dBFS). */
export const CONQUEST_MIX = Object.freeze({
  tank: 0.55, jeep: 0.42, rotor: 0.62, plane: 0.62,
  cannon: 1.2, cannonSelf: 0.9, distant: 0.85, blast: 1, gunShot: 0.85, gunLoop: 0.5, chin: 0.62, chinSelf: 0.5,
  burning: 0.5, cue: 0.32, missile: 0.5, turret: 0.38, wade: 0.5, descent: 0.35, bullet: 0.7, debris: 0.85,
});
/**
 * Per-take level trims (dB, by variant index) from the loudest 100 ms of each
 * file, so one-shots of a group land near a common level: coax shots about
 * -13 dB and HMG shots about -11 dB (the infantry rifle sits near -10 dB), the
 * AA airbursts within 1 dB of each other and closer to the rocket blasts, and
 * the CIWS-sourced jet burst level with its ground-heard take. The master
 * limiter catches the hotter peaks.
 */
export const CONQUEST_TRIM_DB = Object.freeze({
  'cq.gun.coaxMG': Object.freeze([7.5, 8, 7]),
  'cq.gun.hmg': Object.freeze([6, 6.5, 5.5]),
  'cq.blast.airburst': Object.freeze([5, 6]),
  'cq.gun.planeCannon': Object.freeze([1.5]),
});
/** Seconds a recorded distant boom keeps its voice (the old procedural far layer lasted 2.4-3 s). */
export const FAR_BOOM_HOLD = 3;
/** Hull-hit sounds per window, like the bullet-impact and debris budgets. */
export const HULL_HIT_SOUND = Object.freeze({ window: 0.25, budget: 4, selfBudget: 6 });
/** Engine loop layers per hull kind: [layer, bank group]. */
const SAMPLED_VEHICLE_LAYERS = Object.freeze({
  tank: Object.freeze([['idle', 'cq.tank.idle'], ['rev', 'cq.tank.rev'], ['tracks', 'cq.tank.tracks'], ['pivot', 'cq.tank.pivot']]),
  jeep: Object.freeze([['idle', 'cq.jeep.idle'], ['drive', 'cq.jeep.drive'], ['tyres', 'cq.jeep.tyres'], ['rattle', 'cq.jeep.rattle']]),
  helicopter: Object.freeze([['ext', 'cq.heli.ext'], ['distant', 'cq.heli.distant'], ['cabin', 'cq.heli.cockpit']]),
  transport: Object.freeze([['ext', 'cq.transport.ext'], ['distant', 'cq.heli.distant'], ['cabin', 'cq.transport.cabin']]),
  plane: Object.freeze([['ext', 'cq.jet.ext'], ['low', 'cq.jet.low'], ['burner', 'cq.jet.burner']]),
});
/** Hatch takes per hull kind: [enter, exit]. */
const HATCH_GROUPS = Object.freeze({
  tank: ['cq.hatch.tankEnter', 'cq.hatch.tankExit'], jeep: ['cq.hatch.jeepEnter', 'cq.hatch.jeepExit'],
  transport: ['cq.hatch.cabin', 'cq.hatch.cabin'], helicopter: ['cq.hatch.canopy', 'cq.hatch.cabin'], plane: ['cq.hatch.canopy', 'cq.hatch.canopy'],
});
const DESTRUCTION_GROUPS = Object.freeze({ tank: 'cq.destroy.tank', jeep: 'cq.destroy.jeep', helicopter: 'cq.destroy.heli',
  transport: 'cq.destroy.heli', plane: 'cq.destroy.jet' });
const BULLET_SURFACES = Object.freeze({ dirt: 'dirt', grass: 'dirt', gravel: 'dirt', sand: 'dirt', wood: 'wood', metal: 'metal',
  water: 'water', stone: 'stone', glass: 'stone', cloth: 'dirt' });
/** Bullet impacts: audible radius (m), budget per window, ricochet share of stone/metal hits. */
export const BULLET_IMPACT_SOUND = Object.freeze({ range: 45, window: 0.25, budget: 8, ricochetRange: 30, ricochet: 0.12 });
const DEBRIS_SOUND = Object.freeze({ window: 0.15, budget: 5 });
/** Jet flyby takes: seconds from the start of each file to its loudest pass. */
export const JET_FLYBY_PEAKS = Object.freeze([3.1, 2.1, 4.5]);
const SOUND_SPEED = 343;
const turretLoops = new Map();
const wadeLoops = new Map();
const chuteLoops = new Map();
const gunShots = new Map();
const gunTimers = new Map();
const burstVoices = new Map();
const cqBudgets = new Map();
/** Pending shell pass voices by projectile id: { output, passAt } (audio clock). */
const shellPasses = new Map();

/** Decoded variants of a bank group, in slot order. */
function cqSlots(group) {
  const slots = [];
  if (!samples) return slots;
  for (let i = 1; i <= CQ_MAX_VARIANTS; i++) {
    const slot = `${group}.${i}`;
    if (samples.getBuffer(slot)) slots.push(slot);
  }
  return slots;
}

function cqHas(group) {
  return !!samples?.getBuffer(`${group}.1`);
}

/** Random variant that never repeats the previous pick of the same group. */
function cqPick(group, random = Math.random) {
  const slots = cqSlots(group);
  if (slots.length <= 1) return slots[0] || null;
  let index = Math.floor(random() * slots.length) % slots.length;
  if (slots[index] === cqLastVariant.get(group)) index = (index + 1) % slots.length;
  cqLastVariant.set(group, slots[index]);
  return slots[index];
}

/** Sliding budget so a burst of block breaks or bullet hits cannot flood the pool. */
function cqBudget(name, window, budget) {
  const now = engine.now;
  const list = cqBudgets.get(name) || [];
  while (list.length && now - list[0] > window) list.shift();
  if (list.length >= budget) { cqBudgets.set(name, list); return false; }
  list.push(now);
  cqBudgets.set(name, list);
  return true;
}

/**
 * One random variant of `group` as its own pooled voice (`voice`: VoicePool
 * options). Returns the output, or null when nothing has decoded (the caller
 * then plays its procedural voice).
 */
function cqOneShot(group, voice, { gain = 1, rate = 1, delay = 0, offset = 0, echo = 0, slot: forced = null, hold = Infinity } = {}) {
  const slot = forced || cqPick(group);
  const buffer = slot ? samples.getBuffer(slot) : null;
  if (!buffer) return null;
  const speed = Math.max(0.25, Math.min(4, rate));
  const skip = Math.max(0, Math.min(buffer.duration - 0.01, offset));
  const wait = Math.max(0, delay);
  const length = Math.max(0.05, (buffer.duration - skip) / speed);
  // `hold`: the voice ends (with a 0.6 s fade) after this many seconds of sound.
  const held = Number.isFinite(hold) && hold > 0.7 && hold < length;
  const output = pool.acquire(voice, (held ? hold : length) + wait + 0.05);
  const trim = CONQUEST_TRIM_DB[group]?.[Number(slot.slice(group.length + 1)) - 1] || 0;
  if (!samples.play(slot, output, { gain: gain * 10 ** (trim / 20), rate: speed, delay: wait, offset: skip })) return null;
  if (held) {
    try {
      const end = engine.now + wait + hold;
      output.gain.setValueAtTime(output.gain.value, end - 0.6);
      output.gain.linearRampToValueAtTime(0, end);
    } catch { /* closed */ }
  }
  if (echo > 0) sendEcho(output, primitives, echo, engine.echoIn, addCleanup);
  return output;
}

/** A looping BufferSource of `group` (variant `variant`) for refreshLoop voices. */
function cqLoopSource(voice, group, { variant = 1, level = 1, rate = 1, dest = voice.gain, offset = 0 } = {}) {
  const buffer = samples?.getBuffer(`${group}.${variant}`) || samples?.getBuffer(`${group}.1`);
  if (!buffer) return null;
  const source = voice.ctx.createBufferSource();
  source.buffer = buffer;
  source.loop = true;
  source.playbackRate.value = rate;
  source.loopOffset = Math.max(0, Math.min(buffer.duration - 0.01, offset));
  const mix = voice.ctx.createGain();
  mix.gain.value = level;
  source.connect(mix).connect(dest);
  voice.sources.push(source);
  voice.nodes.push(mix);
  return { source, mix };
}

/** Every layer of a hull kind's sampled engine voice has decoded. */
function sampledVehicleReady(kind) {
  const layers = SAMPLED_VEHICLE_LAYERS[kind];
  return !!layers && layers.every(([, group]) => cqHas(group));
}

/** Sampled engine voice: looped layers (random start points) into a tone filter and the level gain. */
function createSampledVehicleVoice(ctx, output, key, kind, at, self) {
  const gain = ctx.createGain();
  gain.gain.value = 0;
  const tone = ctx.createBiquadFilter();
  tone.type = 'lowpass';
  tone.frequency.value = 18000;
  tone.Q.value = 0.5;
  tone.connect(gain).connect(output);
  const layers = {};
  const sources = [];
  const nodes = [tone, gain];
  for (const [name, group] of SAMPLED_VEHICLE_LAYERS[kind]) {
    const buffer = samples.getBuffer(`${group}.1`);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    const level = ctx.createGain();
    level.gain.value = 0;
    source.connect(level).connect(tone);
    // Identical hulls side by side must not phase: each loop starts somewhere else.
    source.start(at, Math.random() * Math.max(0, (buffer?.duration || 0) - 0.05));
    layers[name] = { source, level };
    sources.push(source);
    nodes.push(level);
  }
  const voice = { ctx, output, key, kind, self, sampled: true, gain, tone, layers, sources, nodes, last: at, end: at };
  pool.addCleanup(output, () => {
    voice.cleaned = true;
    for (const source of sources) {
      try { source.stop(); } catch {}
      source.disconnect();
    }
    for (const node of nodes) node.disconnect();
    if (vehicleLoops.get(key) === voice) vehicleLoops.delete(key);
  });
  return voice;
}

/**
 * Drive the sampled layers from the snapshot state: speed crossfades idle and
 * load loops and pitches them, track speed runs the track clatter (pivot
 * squeal when the tracks turn faster than the hull moves), rotor speed and
 * engine power pitch the aircraft, and Doppler bends a passing aircraft.
 * Returns the voice level.
 */
function tuneSampledVehicleVoice(voice, options, speed, trackSpeed, at, pos) {
  const layers = voice.layers;
  const set = (layer, level, rate) => {
    if (!layer) return;
    layer.level.gain.cancelScheduledValues(at);
    layer.level.gain.setTargetAtTime(Math.max(0, level), at, 0.08);
    if (rate) {
      layer.source.playbackRate.cancelScheduledValues(at);
      layer.source.playbackRate.setTargetAtTime(Math.max(0.3, Math.min(2.5, rate)), at, 0.12);
    }
  };
  const quarter = Math.PI / 2;
  const doppler = AIRCRAFT_KINDS.has(voice.kind) && !voice.self
    ? dopplerRatio(pos, options?.velocity, engine.listenerPos?.()) : 1;
  voice.tone.frequency.cancelScheduledValues(at);
  voice.tone.frequency.setTargetAtTime(voice.kind === 'plane' && voice.self ? 1400 : 18000, at, 0.1);
  if (voice.kind === 'tank') {
    const load = Math.min(1, speed / 12);
    const tracks = Math.min(1, trackSpeed / 8);
    const pivot = Math.max(0, Math.min(1, (trackSpeed - speed - 0.8) / 3));
    set(layers.idle, Math.cos(load * quarter), 1 + load * 0.22);
    set(layers.rev, Math.sin(load * quarter) * 0.95, 0.86 + load * 0.3);
    set(layers.tracks, tracks * 0.75, 0.75 + tracks * 0.5);
    set(layers.pivot, pivot * 0.6, 0.9 + pivot * 0.2);
    return CONQUEST_MIX.tank * (0.72 + 0.28 * Math.max(load, tracks));
  }
  if (voice.kind === 'jeep') {
    const load = Math.min(1, speed / 18);
    // Four gear bands: revs climb through each band and drop at the shift.
    const gear = Math.min(3, Math.floor(speed / 6));
    const within = Math.min(1, (speed - gear * 6) / 6);
    set(layers.idle, Math.cos(Math.min(1, speed / 4) * quarter), 1 + Math.min(1, speed / 4) * 0.15);
    set(layers.drive, Math.sin(Math.min(1, speed / 4) * quarter), 0.82 + within * 0.36 + gear * 0.05);
    set(layers.tyres, Math.min(1, speed / 10) * 0.7, 0.8 + load * 0.4);
    set(layers.rattle, Math.min(1, speed / 8) * 0.45, 0.9 + load * 0.2);
    return CONQUEST_MIX.jeep * (0.75 + 0.25 * load);
  }
  if (ROTOR_KINDS.has(voice.kind)) {
    const rotor = vehicleUnit(options?.rotorSpeed);
    const far = voice.self ? 0 : Math.max(0, Math.min(1, (listenerDistance(pos) - 60) / 90));
    const rate = (0.55 + 0.45 * rotor) * doppler;
    set(layers.ext, voice.self ? 0.2 : Math.cos(far * quarter), rate);
    set(layers.distant, voice.self ? 0 : Math.sin(far * quarter), rate * (voice.kind === 'transport' ? 0.85 : 1));
    set(layers.cabin, voice.self ? 1 : 0, 0.7 + 0.3 * rotor);
    return CONQUEST_MIX.rotor * rotor * (0.85 + 0.15 * Math.min(1, speed / 34));
  }
  const power = vehicleUnit(options?.enginePower);
  set(layers.low, Math.cos(power * quarter), (0.85 + power * 0.2) * doppler);
  set(layers.ext, Math.sin(power * quarter), (0.85 + power * 0.25) * doppler);
  set(layers.burner, Math.max(0, (power - 0.8) / 0.2) * 0.9, doppler);
  return CONQUEST_MIX.plane * (0.35 + 0.65 * power);
}

/** Close-blast ring for the stunned ear: in-head, fades with distance. */
function flashbangRing(pos) {
  const listenerPos = engine.listenerPos?.();
  if (!Array.isArray(pos) || !pos.every(Number.isFinite) || !Array.isArray(listenerPos)) return;
  const distance = Math.hypot(pos[0] - listenerPos[0], pos[1] - listenerPos[1], pos[2] - listenerPos[2]);
  const proximity = Math.max(0, Math.min(1, 1 - distance / 18));
  if (proximity <= 0) return;
  run('flashbang', () => {
    const output = pool.acquire(null, 2.4);
    primitives.tone(output, {
      t0: primitives.nowT(), type: 'sine', f0: 3400, f1: 3100,
      att: 0.005, dec: 0.6 + proximity * 1.4, g: 0.05 + proximity * 0.22,
    });
  });
}

/**
 * Conquest bank group of a blast: water geyser over a fluid block, tank AP
 * (2.5 m) or HE (5.5 m) shell, AA airburst, rocket, 25 mm pop, limpet, frag.
 */
export function conquestBlastGroup(type, detail = null) {
  if (detail?.fluid && type !== 'pulse') return 'cq.blast.water';
  const weapon = detail?.vehicleWeapon;
  if (type === 'shell') return weapon === 'tankAP' || (!weapon && Number(detail?.radius) > 0 && Number(detail.radius) < 4)
    ? 'cq.blast.ap' : 'cq.blast.he';
  if (weapon === 'aaMissile' || type === 'stinger') return 'cq.blast.airburst';
  return { rocket: 'cq.blast.rocket', mgl: 'cq.blast.autocannon', frag: 'cq.blast.frag', limpet: 'cq.blast.limpet' }[type] || null;
}

/** Retire a pooled one-shot early with a short fade. */
function fadeVoice(output, fade = 0.2) {
  const ctx = engine.ctx;
  if (!output || !ctx || ctx.state === 'closed') return;
  try {
    output.gain.cancelScheduledValues(ctx.currentTime);
    output.gain.setValueAtTime(output.gain.value, ctx.currentTime);
    output.gain.linearRampToValueAtTime(0, ctx.currentTime + fade);
  } catch {}
  pool?.refresh(output, null, fade);
}

/** Run `onStop` once the trigger lifts (no new round within the gun hold). */
function armGunStop(key, onStop) {
  clearTimeout(gunTimers.get(key));
  gunTimers.set(key, setTimeout(() => {
    gunTimers.delete(key);
    try { if (pool) onStop(); } catch {}
  }, (VEHICLE_SOUND.gunHold + 0.06) * 1000));
}

/**
 * Conquest bank gun voices. Coax and HMG play one recorded round per
 * authoritative shot (random take, at most three overlapping per mount); the
 * door minigun runs its motor loop while rounds keep coming and spins down
 * after the last; the jet cannon plays its burst take (the ground-heard take
 * past 120 m), restarting every 1.2 s of continuous fire and fading when the
 * trigger lifts. Returns false when the weapon has no decoded take.
 */
function sampledGun(key, at, weapon, self, heat) {
  const pos = self ? null : at;
  if (weapon === 'coaxMG' || weapon === 'hmg') {
    const group = `cq.gun.${weapon}`;
    if (!cqHas(group)) return false;
    run('vehicleGun', () => {
      const output = cqOneShot(group, { pos, priority: 2 }, {
        gain: CONQUEST_MIX.gunShot * (self ? 0.8 : 1),
        rate: 0.97 + Math.random() * 0.06 + heat * 0.03,
      });
      if (!output) return;
      const shots = gunShots.get(key) || [];
      shots.push(output);
      while (shots.length > 3) fadeVoice(shots.shift(), 0.03);
      gunShots.set(key, shots);
    });
    return true;
  }
  if (weapon === 'doorMinigun') {
    if (!cqHas('cq.gun.doorMinigun')) return false;
    run('vehicleGun', () => {
      refreshLoop(gunLoops, key, {
        pos, priority: 2, hold: VEHICLE_SOUND.gunHold, fade: VEHICLE_SOUND.gunFade, max: VEHICLE_SOUND.maxGunLoops,
        level: CONQUEST_MIX.gunLoop * (self ? 0.85 : 1),
        create: (voice) => { cqLoopSource(voice, 'cq.gun.doorMinigun', { offset: Math.random() * 2 }); },
      });
      armGunStop(key, () => cqOneShot('cq.gun.doorMinigunStop', { pos, priority: 1 }, { gain: self ? 0.6 : 0.75 }));
    });
    return true;
  }
  if (weapon === 'planeCannon') {
    if (!cqHas('cq.gun.planeCannon')) return false;
    run('vehicleGun', () => {
      const now = engine.now;
      let burst = burstVoices.get(key);
      if (!burst || now - burst.started > 1.2) {
        if (burst) fadeVoice(burst.output, 0.12);
        const far = !self && listenerDistance(at) > 120 && cqHas('cq.gun.planeCannonFar');
        const output = cqOneShot(far ? 'cq.gun.planeCannonFar' : 'cq.gun.planeCannon', { pos, priority: 2, range: 'far' }, {
          gain: self ? 0.75 : 0.9, echo: self ? 0 : 0.15,
        });
        burst = { output, started: now };
        burstVoices.set(key, burst);
      }
      armGunStop(key, () => {
        const ending = burstVoices.get(key);
        burstVoices.delete(key);
        if (ending) fadeVoice(ending.output, 0.3);
      });
    });
    return true;
  }
  return false;
}

/**
 * Line a pass-by take up with the closest approach: `delay` is the time until
 * the pass, `peak` the loudest moment in the file. Returns { delay, offset }.
 */
export function alignPeak(delay, peak) {
  const until = Math.max(0, Number(delay) || 0);
  return until >= peak ? { delay: until - peak, offset: 0 } : { delay: 0, offset: peak - until };
}

export const sfx = {
  init() {
    if (!engine.ensure()) return Promise.resolve(this);
    ensureAudioModules();
    void cosmeticAudio.preload();
    return Promise.all([engine.resume(), loadBuiltInSamples()]).then(() => this);
  },

  unlock() {
    if (!engine.ensure()) return Promise.resolve(false);
    ensureAudioModules();
    return engine.resume();
  },

  /**
   * Fetch and decode the built-in sample bank in the background. Decoding does
   * not need a running context, so the menu can warm the bank before any
   * gesture; init() and later calls reuse the same one-shot load.
   */
  preloadSamples() {
    if (!engine.ensure()) return Promise.resolve(Object.freeze({ loaded: 0, failed: 0 }));
    ensureAudioModules();
    return loadBuiltInSamples();
  },

  playCosmetic(id, cue) { return cosmeticAudio.play(id, cue); },
  stopCosmetics(cue) { cosmeticAudio.stop(cue); },

  // No queued unlock replay: a stale multikill should never speak over a new life.
  announceKill(cue) { return announcer.play(cue); },
  /** Conquest objective cues render on the shared engine and the single announcer voice. */
  objectiveAudio() { return { engine, announcer }; },
  stopAnnouncer() { announcer.stop(); },

  async dispose() {
    announcer.stop();
    cosmeticAudio.clear();
    this.stopPainMoans();
    localVocalUntil = 0;
    painHitVariant = -1;
    disposeChargeLoop();
    this.stopVehicleLoops();
    this.stopGlaiveFlights();
    flameLoops?.dispose();
    flameLoops = null;
    minigunMotor?.dispose();
    minigunMotor = null;
    minigunReportIndex = 0;
    pickaxeSwingIndex = 0;
    pickaxeImpactIndex = 0;
    pickaxeVariations = new PickaxeDigVariations();
    menuMusic?.dispose();
    menuMusic = null;
    pool = null;
    primitives = null;
    this.stopVehicleCues();
    samples?.clear();
    samples = null;
    builtInSamplesPromise = null;
    conquestBankPromise = null;
    cqLastVariant.clear();
    cqBudgets.clear();
    footstepVariations = new FootstepVariations();
    heartbeatAt = -Infinity;
    panicBreaths.reset();
    await engine.dispose();
  },

  setMasterVolume(value) {
    engine.setMasterVolume(value);
  },

  setMenuMusicVolume(value) {
    const next = Number(value);
    if (Number.isFinite(next)) menuMusicVolume = Math.max(0, Math.min(1, next));
    menuMusic?.setVolume(menuMusicVolume);
  },

  startMenuMusic(fetchImpl) {
    if (!engine.ensure()) return Promise.resolve(false);
    ensureAudioModules();
    void engine.resume();
    return menuMusic.start(fetchImpl);
  },

  stopMenuMusic(fadeSeconds) {
    return menuMusic?.stop(fadeSeconds) || false;
  },

  async loadSamples(manifest, fetchImpl) {
    if (!engine.ensure()) return Object.freeze({ loaded: 0, failed: 0 });
    ensureAudioModules();
    return samples.load(manifest, fetchImpl);
  },

  fire(rawKey, options) {
    // Kit gadgets without their own bank reuse a launcher's sounds (STINGER -> RX-8).
    const key = SFX_ALIAS[rawKey] ?? rawKey;
    const deferred = copyOptions(options);
    if (key === 'flamethrower') {
      if (!engine.ensure()) return;
      ensureAudioModules();
      if (engine.ctx.state !== 'running') { void engine.resume(); return; }
      flameLoops.refresh({ ...outputOptions(deferred), shooterId: deferred?.shooterId });
      return;
    }
    run('fire', () => {
      if (key === 'minigun') {
        // Share the six-output rapid-fire budget; the rotary report has its own
        // recording rate, gain and short transient so it stays clear at 1200 RPM.
        const output = pool.acquireFire('lmg', outputOptions(deferred), MINIGUN_REPORT.lifetime);
        const at = engine.ctx.currentTime;
        output.gain.setValueAtTime(output.gain.value, at);
        output.gain.setValueAtTime(output.gain.value, at + MINIGUN_REPORT.lifetime - 0.025);
        output.gain.linearRampToValueAtTime(0, at + MINIGUN_REPORT.lifetime);
        const choice = minigunReportChoice(minigunReportIndex++);
        const sampled = samples.play(choice.slot, output, choice)
          || (choice.slot !== 'weapons.minigun.fire'
            && samples.play('weapons.minigun.fire', output, choice))
          || samples.play('weapons.lmg.fire', output, choice);
        const reportOutput = sampled ? createReportLayer(output, MINIGUN_REPORT.layerGain) : output;
        renderMinigunReport(reportOutput, primitives, { sampled });
        return;
      }
      const profile = fireReportProfile(key);
      const charge = deferred && !Array.isArray(deferred) && Number.isFinite(deferred.charge)
        ? deferred.charge : 1;
      const output = pool.acquireFire(key, outputOptions(deferred), profile.lifetime);
      if (key === 'knife') {
        const choice = { ...pickaxeSampleChoice(pickaxeSwingIndex++), gain: profile.sampleGain };
        if (samples.play(choice.slot, output, choice)
          || (choice.slot !== 'weapons.knife.fire' && samples.play('weapons.knife.fire', output, choice))) return;
        renderFireReport(key, output, primitives, engine.echoIn, addCleanup, output);
        return;
      }
      const sampled = samples.play(`weapons.${key}.fire`, output, fireSampleProfile(key, charge));
      const reportOutput = sampled
        ? createReportLayer(output, profile.layerGain)
        : output;
      renderFireReport(key, reportOutput, primitives, engine.echoIn, addCleanup, output, {
        // Local pump/bolt contacts come from the actual rig state machine. Remote
        // reports have no rig, so their matching contacts stay scheduled here.
        includeMechanics: !!positionOf(deferred),
        charge,
      });
    });
  },

  stopFlame(shooterId = null) {
    flameLoops?.stop(shooterId);
  },

  stopFlames() {
    flameLoops?.dispose();
  },

  /** Refresh local rotary drive/thermal audio; inactive calls fade it immediately. */
  minigunMotor(spin01, heat01, active = true, overheated = false) {
    if (!active) return minigunMotor?.refresh(spin01, heat01, false, overheated) || false;
    if (!engine.ctx || engine.ctx.state !== 'running') {
      minigunMotor?.stop();
      return false;
    }
    ensureAudioModules();
    return minigunMotor.refresh(spin01, heat01, true, overheated);
  },

  /**
   * Held capacitor charge (LONGARC, VOLTLANCE): call every frame with the 0..1 level while
   * `active`; the whine climbs in pitch and brightness with the charge and fades out on
   * release.
   */
  weaponCharge(level01, active = true, weaponId = null) {
    const level = Math.max(0, Math.min(1, Number(level01) || 0));
    if (!active) {
      // A release or cancel stops every charge voice, whichever weapon was held.
      for (const loop of [chargeLoop, bubbleChargeLoop]) {
        if (!loop) continue;
        const at = loop.ctx.currentTime;
        loop.gain.gain.cancelScheduledValues(at);
        loop.gain.gain.setTargetAtTime(0, at, 0.03);
        loop.level = 0;
      }
      return false;
    }
    if (!engine.ctx || engine.ctx.state === 'closed') return false;
    if (weaponId === 'bubble') {
      const loop = ensureBubbleChargeLoop();
      if (!loop) return false;
      const at = loop.ctx.currentTime;
      loop.level = level;
      loop.band.frequency.setTargetAtTime(600 + 1600 * level, at, 0.04);
      loop.tone.frequency.setTargetAtTime(220 + 420 * level, at, 0.04);
      loop.vibratoDepth.gain.setTargetAtTime(8 + 30 * level, at, 0.05);
      loop.tremoloDepth.gain.setTargetAtTime(level > 0.9 ? 0.25 : 0, at, 0.03);
      loop.gain.gain.setTargetAtTime(0.025 + 0.09 * level, at, 0.015);
      return true;
    }
    const loop = ensureChargeLoop();
    if (!loop) return false;
    const at = loop.ctx.currentTime;
    loop.level = level;
    loop.oscillator.frequency.setTargetAtTime(160 + level * level * 1500, at, 0.04);
    loop.shimmer.frequency.setTargetAtTime(320 + level * 2600, at, 0.04);
    loop.filter.frequency.setTargetAtTime(500 + level * 3200, at, 0.05);
    const pulse = 1 + Math.sin(at * (18 + level * 30)) * level ** 3 * 0.22;
    loop.gain.gain.setTargetAtTime((0.03 + level * 0.11) * pulse, at, 0.015);
    return true;
  },

  /** Bolt wall-ricochet crackle at a world position (client-derived from the shared integrator). */
  arcZap(pos) {
    const deferredPos = Array.isArray(pos) ? pos.slice(0, 3) : pos;
    run('arcZap', () => {
      const output = pool.acquire({ pos: deferredPos }, 0.4);
      output.gain.value = 0.9;
      arcZap(output, primitives);
    });
  },

  /** Bastion director cues. `pos` ([x,y,z] or {x,y,z}) makes the cue positional. */
  bastionCue(kind, pos = null) {
    const deferredPos = positionFrom(pos);
    run('bastion', () => {
      const output = pool.acquire(deferredPos ? { pos: deferredPos } : null, 1.6);
      const at = primitives.nowT();
      const tone = (o) => primitives.tone(output, { t0: at, type: 'sine', dec: 0.16, g: 0.065, ...o });
      switch (kind) {
        case 'bastion_stage':
          [520, 700, 880].forEach((f, i) => tone({ t0: at + i * 0.14, f0: f, dec: 0.26, g: 0.07 }));
          break;
        case 'bastion_regroup':
          [720, 480].forEach((f, i) => tone({ t0: at + i * 0.22, type: 'triangle', f0: f, f1: f * 0.94, dec: 0.32, g: 0.07 }));
          break;
        case 'bastion_extract':
          for (let i = 0; i < 3; i++) {
            tone({ t0: at + i * 0.36, f0: 880, dec: 0.12, g: 0.06 });
            tone({ t0: at + i * 0.36 + 0.13, f0: 1320, dec: 0.14, g: 0.05 });
          }
          break;
        case 'bastion_build':
          tone({ type: 'square', f0: 900, att: 0.002, dec: 0.04, g: 0.045 });
          tone({ t0: at + 0.07, type: 'square', f0: 1200, att: 0.002, dec: 0.04, g: 0.045 });
          break;
        case 'bastion_structure':
          tone({ type: 'sawtooth', f0: 500, f1: 180, dec: 0.45, g: 0.08 });
          break;
        case 'bastion_vehicle':
          tone({ type: 'sawtooth', f0: 80, f1: 60, att: 0.02, dec: 0.8, g: 0.12 });
          break;
        case 'bastion_breach':
          tone({ type: 'square', f0: 220, att: 0.002, dec: 0.08, g: 0.08 });
          tone({ t0: at + 0.14, type: 'square', f0: 220, att: 0.002, dec: 0.08, g: 0.08 });
          break;
        case 'bastion_tier':
          // Brass stab: a detuned sawtooth chord with a short bite.
          [220, 330, 440].forEach((f, i) => {
            tone({ type: 'sawtooth', f0: f, f1: f * 0.985, att: 0.012, dec: 0.36, g: 0.05, detune: (i - 1) * 6 });
            tone({ type: 'square', f0: f * 2, att: 0.012, dec: 0.12, g: 0.018 });
          });
          break;
        default: {
          const alarm = kind === 'bastion_alarm' || kind === 'bastion_charge';
          for (let i = 0; i < 3; i++) tone({
            t0: at + i * 0.19, type: alarm ? 'triangle' : 'sine',
            f0: alarm ? 420 + i * 180 : 600 + i * 200,
            f1: alarm ? 240 : 720 + i * 200, dec: 0.16, g: 0.065,
          });
        }
      }
    });
  },

  /**
   * Refresh a positional engine drone for one vehicle; call every frame it is
   * heard. A loop that stops being refreshed fades out on the audio clock.
   */
  vehicleLoop(id, pos, kind = 'buggy', options = null) {
    // Refreshed every frame, so a suspended context skips it instead of filling
    // the unlock queue with stale drones that would push out real cues.
    if (!engine.ensure() || engine.ctx.state !== 'running') return;
    const key = String(id);
    const deferredPos = positionFrom(pos);
    const aircraft = AIRCRAFT_KINDS.has(kind);
    if (aircraft && (!deferredPos || (ROTOR_KINDS.has(kind)
      ? vehicleUnit(options?.rotorSpeed) <= 0.01
      : !options?.occupied || options?.engineOn === false || vehicleUnit(options?.enginePower) <= 0.01))) {
      this.stopVehicleLoop(key);
      return;
    }
    run('vehicleLoop', () => {
      const ctx = engine.ctx;
      if (!ctx || ctx.state !== 'running') return;
      const at = ctx.currentTime;
      const ground = kind === 'jeep' || kind === 'tank';
      const speed = Math.min(aircraft ? 140 : 24,
        Number.isFinite(options?.speed) ? Math.abs(options.speed) : 0);
      const trackSpeed = Math.min(24, Math.max(speed, Math.abs(options?.trackSpeed || 0)));
      const rpm = ground ? 1 + speed / (kind === 'tank' ? 15 : 12) : 1;
      const hz = (VEHICLE_DRONE[kind] ?? 100) * rpm;
      let targetLevel = ground ? VEHICLE_LEVEL * (0.28 + Math.min(1, speed / 12) * 0.55) : VEHICLE_LEVEL;
      // Conquest bank loops replace the drone once every layer has decoded; the
      // crew (self) hears its own hull in the head through the interior layers.
      const sampled = sampledVehicleReady(kind);
      const self = sampled && !!options?.self;
      let voice = vehicleLoops.get(key);
      if (voice && (voice.ctx !== ctx || at >= voice.end || voice.kind !== kind
        || !!voice.sampled !== sampled || (sampled && voice.self !== self))) {
        releaseVehicleLoop(key, voice); voice = null;
      }
      if (!voice) {
        while (vehicleLoops.size >= MAX_VEHICLE_LOOPS) {
          const [oldKey, oldest] = [...vehicleLoops.entries()].reduce((a, b) => (a[1].last <= b[1].last ? a : b));
          releaseVehicleLoop(oldKey, oldest);
        }
        const output = pool.acquire(self ? { priority: 1 } : deferredPos ? { pos: deferredPos, priority: 1 } : null,
          VEHICLE_HOLD + VEHICLE_FADE);
        if (sampled) {
          voice = createSampledVehicleVoice(ctx, output, key, kind, at, self);
          if (voice.cleaned) return;
          vehicleLoops.set(key, voice);
        } else if (aircraft) {
          voice = createAircraftVehicleVoice(ctx, output, key, kind, at);
          if (voice.cleaned) return;
          vehicleLoops.set(key, voice);
        } else {
          const osc = ctx.createOscillator();
          osc.type = 'sawtooth';
          osc.frequency.value = hz;
          const sub = ctx.createOscillator();
          sub.type = kind === 'tank' ? 'square' : 'triangle';
          sub.frequency.value = kind === 'tank' ? 24 + trackSpeed * 2.8 : hz / 2;
          const filter = ctx.createBiquadFilter();
          filter.type = 'lowpass';
          filter.frequency.value = kind === 'tank' ? 180 : kind === 'walker' ? 260 : 420;
          filter.Q.value = 1.2;
          const gain = ctx.createGain();
          gain.gain.value = 0;
          osc.connect(filter);
          sub.connect(filter);
          filter.connect(gain).connect(output);
          osc.start(at);
          sub.start(at);
          voice = { ctx, output, osc, sub, filter, gain, kind, last: at, end: at, thudAt: at };
          vehicleLoops.set(key, voice);
          pool.addCleanup(output, () => {
            try { osc.stop(); sub.stop(); } catch {}
            osc.disconnect(); sub.disconnect(); filter.disconnect(); gain.disconnect();
            if (vehicleLoops.get(key) === voice) vehicleLoops.delete(key);
          });
        }
      }
      if (voice.sampled) targetLevel = tuneSampledVehicleVoice(voice, options, speed, trackSpeed, at, deferredPos);
      else if (aircraft) targetLevel = tuneAircraftVehicleVoice(voice, options, speed, at);
      const level = at >= voice.end ? 0 : voice.gain.gain.value;
      voice.last = at;
      voice.end = at + VEHICLE_HOLD + VEHICLE_FADE;
      const g = voice.gain.gain;
      g.cancelScheduledValues(at);
      g.setValueAtTime(level, at);
      g.linearRampToValueAtTime(targetLevel, at + 0.12);
      g.setValueAtTime(targetLevel, at + VEHICLE_HOLD);
      g.linearRampToValueAtTime(0, voice.end);
      // WebAudio permits replacing a future stop deadline until the source ends.
      for (const source of voice.sources ?? [voice.osc, voice.sub]) source.stop(voice.end + 0.05);
      if (!aircraft && !voice.sampled) {
        voice.osc.frequency.setTargetAtTime(hz, at, 0.12);
        voice.sub.frequency.setTargetAtTime(kind === 'tank' ? 24 + trackSpeed * 2.8 : hz / 2, at, 0.12);
      }
      if (kind === 'walker' && !voice.sampled && at >= voice.thudAt) {
        voice.thudAt = at + 0.7;
        primitives.tone(voice.output, { t0: at, type: 'sine', f0: 70, f1: 32, att: 0.004, dec: 0.22, g: 0.3 });
      }
      pool.refresh(voice.output, deferredPos && !voice.self ? { pos: deferredPos } : null, VEHICLE_HOLD + VEHICLE_FADE);
    });
  },

  stopVehicleLoop(id) {
    const key = String(id);
    releaseVehicleLoop(key, vehicleLoops.get(key));
  },

  stopVehicleLoops() {
    for (const [key, voice] of [...vehicleLoops]) releaseVehicleLoop(key, voice);
    vehicleLoops.clear();
  },

  /**
   * Refresh the positional whirr of one RIPTIDE disc in flight; call every frame
   * it is visible with its world `pos`. `phase` is 'out' or 'back' (the return
   * leg is pitched up 20%). `velocity` ([x,y,z] m/s) drives Doppler; without it
   * the velocity is estimated from successive positions. A loop that stops
   * being refreshed fades out on its own.
   */
  glaiveFlight(id, pos, { phase = 'out', velocity = null } = {}) {
    const key = String(id);
    const deferredPos = positionFrom(pos);
    if (!deferredPos) return;
    const deferredVelocity = Array.isArray(velocity) && velocity.length >= 3
      && velocity.slice(0, 3).every(Number.isFinite) ? velocity.slice(0, 3) : null;
    run('glaiveFlight', () => {
      const ctx = engine.ctx;
      if (!ctx || ctx.state !== 'running') return;
      const at = ctx.currentTime;
      let voice = glaiveLoops.get(key);
      if (voice && (voice.ctx !== ctx || at >= voice.end)) { releaseGlaiveLoop(key, voice); voice = null; }
      if (!voice) {
        while (glaiveLoops.size >= GLAIVE_FLIGHT.maxLoops) {
          const [oldKey, oldest] = [...glaiveLoops.entries()].reduce((a, b) => (a[1].last <= b[1].last ? a : b));
          releaseGlaiveLoop(oldKey, oldest);
        }
        const lifetime = GLAIVE_FLIGHT.hold + GLAIVE_FLIGHT.fade;
        const output = pool.acquire({ pos: deferredPos, priority: 1 }, lifetime);
        const saw = ctx.createOscillator();
        saw.type = 'sawtooth';
        saw.frequency.value = GLAIVE_FLIGHT.hz;
        const edge = ctx.createOscillator();
        edge.type = 'sawtooth';
        edge.frequency.value = GLAIVE_FLIGHT.hz * 2.01;
        const filter = ctx.createBiquadFilter();
        filter.type = 'bandpass';
        filter.frequency.value = GLAIVE_FLIGHT.bandHz;
        filter.Q.value = GLAIVE_FLIGHT.q;
        // Tremolo: gain = (1 - depth) + depth * sin(30 Hz), the spinning teeth chopping the air.
        const tremolo = ctx.createGain();
        tremolo.gain.value = 1 - GLAIVE_FLIGHT.depth;
        const lfo = ctx.createOscillator();
        lfo.frequency.value = GLAIVE_FLIGHT.tremoloHz;
        const lfoDepth = ctx.createGain();
        lfoDepth.gain.value = GLAIVE_FLIGHT.depth;
        lfo.connect(lfoDepth).connect(tremolo.gain);
        const gain = ctx.createGain();
        gain.gain.value = 0;
        saw.connect(filter);
        edge.connect(filter);
        filter.connect(tremolo).connect(gain).connect(output);
        const sources = [saw, edge, lfo];
        for (const osc of sources) osc.start(at);
        voice = {
          ctx, output, saw, edge, filter, gain, sources,
          last: at, end: at, pos: deferredPos, velocity: null,
        };
        glaiveLoops.set(key, voice);
        pool.addCleanup(output, () => {
          for (const osc of sources) {
            try { osc.stop(); } catch {}
            osc.disconnect();
          }
          filter.disconnect(); tremolo.disconnect(); lfoDepth.disconnect(); gain.disconnect();
          if (glaiveLoops.get(key) === voice) glaiveLoops.delete(key);
        });
      }
      // Estimate velocity from the previous refresh when the caller has none.
      let motion = deferredVelocity;
      const dt = at - voice.last;
      if (!motion && dt > 0.004) {
        const sample = [0, 1, 2].map((axis) => (deferredPos[axis] - voice.pos[axis]) / dt);
        motion = voice.velocity
          ? voice.velocity.map((value, axis) => value + (sample[axis] - value) * 0.5) : sample;
      }
      if (motion) voice.velocity = motion;
      const pitch = (phase === 'back' ? GLAIVE_FLIGHT.backPitch : 1)
        * dopplerRatio(deferredPos, voice.velocity, engine.listenerPos?.());
      const level = at >= voice.end ? 0 : voice.gain.gain.value;
      voice.last = at;
      voice.pos = deferredPos;
      voice.end = at + GLAIVE_FLIGHT.hold + GLAIVE_FLIGHT.fade;
      const g = voice.gain.gain;
      g.cancelScheduledValues(at);
      g.setValueAtTime(level, at);
      g.linearRampToValueAtTime(GLAIVE_FLIGHT.level, at + 0.04);
      g.setValueAtTime(GLAIVE_FLIGHT.level, at + GLAIVE_FLIGHT.hold);
      g.linearRampToValueAtTime(0, voice.end);
      for (const osc of voice.sources) osc.stop(voice.end + 0.05);
      voice.saw.frequency.setTargetAtTime(GLAIVE_FLIGHT.hz * pitch, at, 0.03);
      voice.edge.frequency.setTargetAtTime(GLAIVE_FLIGHT.hz * 2.01 * pitch, at, 0.03);
      voice.filter.frequency.setTargetAtTime(GLAIVE_FLIGHT.bandHz * pitch, at, 0.03);
      pool.refresh(voice.output, { pos: deferredPos }, GLAIVE_FLIGHT.hold + GLAIVE_FLIGHT.fade);
    });
  },

  stopGlaiveFlight(id) {
    const key = String(id);
    releaseGlaiveLoop(key, glaiveLoops.get(key));
  },

  stopGlaiveFlights() {
    for (const [key, voice] of [...glaiveLoops]) releaseGlaiveLoop(key, voice);
    glaiveLoops.clear();
  },

  /**
   * One RIPTIDE disc event. `cue` is bounce | slice | return | catch | embed |
   * pickup | fizzle | fabricate | fabricated. `options` is a world position
   * ([x,y,z] or { pos }) for positional cues, plus `head` for a headshot slice.
   * Without a position the cue plays in the listener's head (own catch, R return,
   * fabricate).
   */
  glaiveCue(cue, options = null) {
    const deferred = copyOptions(options);
    const head = !!(deferred && !Array.isArray(deferred) && deferred.head);
    if (cue === 'fabricate' || cue === 'fabricated') {
      run('glaiveCue', () => {
        const output = pool.acquire(outputOptions(deferred), cue === 'fabricate' ? 1 : 0.3);
        glaiveFabricate(output, primitives, cue === 'fabricated');
      });
      return;
    }
    if (!GLAIVE_CUES[cue]) return;
    run('glaiveCue', () => {
      const output = pool.acquire(outputOptions(deferred), GLAIVE_CUES[cue]);
      renderGlaiveCue(cue, output, primitives, { head });
    });
  },

  cycleClick(step, rawWeapon) {
    const weapon = SFX_ALIAS[rawWeapon] ?? rawWeapon;
    run('cycle', () => {
      const output = pool.acquire(null, 0.24);
      cycleActionClick(output, primitives, weapon, step);
    });
  },

  impact(kind, volume = 1, options) {
    const deferred = copyOptions(options);
    run('impact', () => {
      const params = IMPACT_PARAMS[kind];
      if (!params) return;
      let normalized = Math.min(1, Math.max(0, volume));
      if (params.cap) normalized = Math.min(normalized, params.cap);
      if (cqHas(`cq.debris.${kind}`)) {
        // Conquest bank: crumbling voxel chunks, budgeted so a blast that breaks
        // dozens of blocks stacks a few takes instead of flooding the pool.
        if (!cqBudget('debris', DEBRIS_SOUND.window, DEBRIS_SOUND.budget)) return;
        if (cqOneShot(`cq.debris.${kind}`, { ...outputOptions(deferred), priority: 0 }, {
          gain: CONQUEST_MIX.debris * normalized, rate: 0.92 + Math.random() * 0.16 })) return;
      }
      const output = pool.acquire(outputOptions(deferred), kind === 'glass' ? 0.6 : 0.5);
      output.gain.value = 1.14;
      if (samples.play(`impact.${kind}`, output, { gain: normalized })) return;
      if (kind === 'glass') impactGlass(output, primitives, normalized);
      else if (kind === 'metal') impactMetal(output, primitives, normalized);
      else genericImpact(output, primitives, params, normalized);
    });
  },

  mine(type, broken, pos) {
    const deferred = copyOptions(pos);
    run('impact', () => {
      // The block's own dig take first; the generic contact chain stays as fallback.
      const has = (slot) => !!samples.getBuffer(slot);
      const dig = pickaxeVariations.dig(pickaxeDigMaterial(type), !!broken, Math.random, has);
      if (dig) {
        const lifetime = (samples.getBuffer(dig.slot).duration || 0.5) / dig.rate + 0.02;
        const output = pool.acquire(outputOptions(deferred), lifetime);
        if (samples.play(dig.slot, output, { gain: dig.gain, rate: dig.rate, cleanupOwner: output })) return;
      }
      const material = pickaxeMaterial(type);
      const output = pool.acquire(outputOptions(deferred), 0.4);
      let contact = output;
      if (material === 'soft' || material === 'glass') {
        contact = primitives.biquad(material === 'soft' ? 'lowpass' : 'highpass',
          material === 'soft' ? 1250 : 900, 0.6);
        contact.connect(output);
        addCleanup(output, () => contact.disconnect());
      }
      const variation = pickaxeSampleChoice(pickaxeImpactIndex++, true);
      const choice = { ...variation,
        rate: variation.rate
          * (material === 'soft' ? 0.86 : material === 'glass' ? 1.18 : material === 'metal' ? 0.94 : 0.97),
        gain: (material === 'soft' ? 0.82 : material === 'glass' ? 0.7 : 0.92)
          * (broken ? 1 : 0.58), cleanupOwner: output };
      const sampled = samples.play(choice.slot, contact, choice)
        || (choice.slot !== 'pickaxe.impact' && samples.play('pickaxe.impact', contact, choice));
      renderPickaxeContact(contact, primitives, material, { sampled, broken: !!broken });
    });
  },

  reloadClick(step, rawWeapon) {
    const weapon = SFX_ALIAS[rawWeapon] ?? rawWeapon;
    run('reload', () => {
      const brightness = WEP_TONE[weapon] || 1;
      const output = pool.acquire(null, 0.45);
      if (samples.play(`weapons.${weapon}.reload.${step}`, output)) return;
      const at = primitives.nowT();
      if (weapon === 'lmg') reloadLmg(output, primitives, step, at, brightness);
      else if (weapon === 'longarc') reloadLongarc(output, primitives, step, at, brightness);
      else if (weapon === 'rocket') reloadRocket(output, primitives, step, at, brightness);
      else if (weapon === 'glaive') reloadGlaive(output, primitives, step, at, brightness);
      else if (weapon === 'revolver') {
        reloadRevolver(output, primitives, step, at, brightness);
      } else genericReloadStep(output, primitives, step, at, brightness);
    });
  },

  /**
   * IRON PICK player hit. `kind` is strong | crit | knockback | backstab |
   * armor; `pos` ([x,y,z] or {x,y,z}) places it in the world unless `local`
   * (the listener dealt or took the hit) plays it in the head.
   */
  meleeHit({ kind = 'strong', pos = null, local = false } = {}) {
    const at = local ? null : positionFrom(pos);
    run('meleeHit', () => {
      const choice = pickaxeVariations.attack(kind, Math.random, (slot) => !!samples.getBuffer(slot));
      const lifetime = choice.slot ? (samples.getBuffer(choice.slot).duration || 0.5) / choice.rate + 0.02 : 0.3;
      const output = pool.acquire({ pos: at, priority: 1 }, lifetime);
      if (choice.slot && samples.play(choice.slot, output, { ...choice, cleanupOwner: output })) return;
      renderMeleeHitFallback(output, primitives, choice.kind);
    });
  },

  hitmark(headshot) {
    run('hitmark', () => {
      const output = pool.acquire(null, headshot ? 0.14 : 0.125);
      if (samples.play(headshot ? 'ui.hitmark.head' : 'ui.hitmark.body', output)) return;
      const at = primitives.nowT();
      primitives.hiss(output, {
        t0: at, filter: 'bandpass', f: headshot ? 1600 : 1050,
        q: 0.6, dec: headshot ? 0.032 : 0.022, g: headshot ? 0.12 : 0.10,
      });
      primitives.tone(output, {
        t0: at, type: 'triangle', f0: headshot ? 580 : 390,
        f1: headshot ? 380 : 270, att: 0.001, dec: 0.024, g: 0.09,
      });
    });
  },

  /** A weightier, slightly longer confirmation that stays soft beside the hit tick. */
  killConfirm(headshot = false) {
    run('killConfirm', () => {
      const output = pool.acquire(null, 0.24);
      if (samples.play(headshot ? 'ui.kill.head' : 'ui.kill.body', output)) return;
      const at = primitives.nowT();
      primitives.hiss(output, {
        t0: at, filter: 'bandpass', f: headshot ? 1300 : 850,
        q: 0.6, dec: 0.052, g: 0.13,
      });
      primitives.tone(output, {
        t0: at, type: 'triangle', f0: headshot ? 460 : 330, f1: 200,
        att: 0.002, dec: 0.065, g: 0.11,
      });
    });
  },

  /** Deliberate breath-hold transition cues. */
  breath(event) {
    if (!['inhale', 'exhale', 'gasp'].includes(event)) return;
    run('breath', () => {
      this.stopPainMoans();
      localVocalUntil = engine.now + 0.9;
      renderBreath(pool.acquire(null, 0.9), primitives, event);
    });
  },

  /** Ambient pain is local, bounded to one voice, and never queued on unlock. */
  painMoan(level, now, options = {}) {
    const active = options.active !== false && engine.ctx?.state === 'running';
    if (!active || options.holding || !Number.isFinite(level) || level < PAIN_MOAN_THRESHOLD) {
      this.stopPainMoans();
      return false;
    }
    const cue = painMoans.update(level, now, {
      ...options, active: engine.now >= localVocalUntil,
    });
    if (!cue || !ensureAudioModules()) return false;
    if (painMoanVoice) pool.release(painMoanVoice.output);
    const choice = painSampleChoice(cue.pain, cue.variant);
    const duration = samples.getBuffer(choice.slot)?.duration / choice.rate || cue.duration;
    const output = pool.acquireHuman(null, duration + 0.15);
    output.gain.value = cue.gain;
    painMoanVoice = { output, until: engine.now + duration + 0.15 };
    if (!samples.play(choice.slot, output, choice)) renderPainMoan(output, primitives, addCleanup, cue);
    return true;
  },

  stopPainMoans() {
    painMoans.reset();
    if (painMoanVoice) pool?.release(painMoanVoice.output);
    painMoanVoice = null;
  },

  panicBreath(level, now, options = {}) {
    // Ambient cues must never queue behind the browser's audio unlock boundary.
    const active = options.active !== false && engine.ctx?.state === 'running'
      && !(painMoanVoice && engine.now < painMoanVoice.until);
    const cue = panicBreaths.update(level, now, { ...options, active });
    if (!cue || !ensureAudioModules()) return false;
    const output = pool.acquire(null, 0.6);
    output.gain.value = cue.gain;
    renderBreath(output, primitives, cue.event);
    return true;
  },

  /** Frame-driven danger heartbeat; silent at zero danger. */
  dangerPulse(level01, now = Date.now()) {
    const level = Math.max(0, Math.min(1, Number(level01) || 0));
    if (level <= 0) {
      heartbeatAt = -Infinity;
      return false;
    }
    const interval = 1150 - level * 560;
    if (now - heartbeatAt < interval) return false;
    heartbeatAt = now;
    run('heartbeat', () => {
      const output = pool.acquire({ muffled: true }, 0.5);
      output.gain.value = 0.3 + level * 0.5;
      if (samples.play('human.heartbeat', output)) return;
      const at = primitives.nowT();
      primitives.tone(output, {
        t0: at, type: 'sine', f0: 64, f1: 42, att: 0.004, dec: 0.12, g: 0.55,
      });
      primitives.tone(output, {
        t0: at + 0.15, type: 'sine', f0: 58, f1: 38, att: 0.004, dec: 0.1, g: 0.4,
      });
    });
    return true;
  },

  pain({ damage = 0, headshot = false, lethal = false, pos, local = false } = {}) {
    const deferredPos = Array.isArray(pos) ? pos.slice(0, 3) : pos;
    run('pain', () => {
      const numeric = Number(damage);
      const hitDamage = Number.isFinite(numeric) ? Math.min(100, Math.max(0, numeric)) : 0;
      painHitVariant = painHitVariant < 0 ? Math.floor(Math.random() * 3)
        : (painHitVariant + 1 + Math.floor(Math.random() * 2)) % 3;
      const choice = painSampleChoice(headshot ? 1 : hitDamage / 55, painHitVariant);
      const sampleDuration = lethal ? 0 : (samples.getBuffer(choice.slot)?.duration || 0) / choice.rate;
      const lifetime = Math.max(lethal ? 1.45 : headshot ? 1.05 : hitDamage >= 35 ? 0.95 : 0.7,
        sampleDuration + 0.1);
      if (local) {
        this.stopPainMoans();
        localVocalUntil = engine.now + lifetime;
      }
      const output = pool.acquireHuman({ pos: local ? null : positionOf(deferredPos) }, lifetime);
      output.gain.value = local ? 0.96 : 0.82;
      const slot = lethal
        ? 'human.death.far'
        : headshot
          ? 'human.pain.head'
          : hitDamage >= 35
            ? 'human.pain.heavy'
            : 'human.pain.light';
      if (!lethal && samples.play(choice.slot, output, choice)) return;
      if (samples.play(slot, output)) return;
      synthPainVoice(output, primitives, addCleanup, {
        damage: hitDamage,
        headshot: !!headshot,
        lethal: !!lethal,
        self: false,
      });
    });
  },

  deathSelf({ headshot = false } = {}) {
    this.stopPainMoans();
    run('deathSelf', () => {
      const output = pool.acquireHuman(null, 1.75);
      output.gain.value = 0.94;
      if (samples.play('human.death.self', output)) return;
      const voice = synthPainVoice(output, primitives, addCleanup, {
        damage: 100, headshot: !!headshot, lethal: true, self: true,
      });
      bodyImpact(output, primitives, voice.t0 + Math.min(0.82, voice.duration * 0.72), 0.95);
      if (headshot) {
        primitives.hiss(output, {
          t0: voice.t0, filter: 'highpass', f: 3600, q: 0.8,
          dec: 0.035, g: 0.28,
        });
      }
    });
  },

  deathFar(volume = 0.4) {
    run('deathFar', () => {
      const output = pool.acquire({ muffled: true }, 0.9);
      if (samples.play('human.death.far', output, { gain: volume })) return;
      const at = primitives.nowT();
      primitives.hiss(output, {
        t0: at, filter: 'bandpass', f: 420, q: 0.5,
        dec: 0.1, g: 0.5 * volume,
      });
      primitives.tone(output, {
        t0: at, type: 'sine', f0: 84, f1: 38,
        dec: 0.17, g: 0.22 * volume, att: 0.002,
      });
      sendEcho(output, primitives, 0.18, engine.echoIn, addCleanup);
    });
  },

  /**
   * One footfall. With `pos` the step is placed in the world (another
   * player's body); without, it is the listener's own step and alternates
   * gently left/right.
   */
  footstep(volume = 0.45, options = null) {
    if (!Number.isFinite(volume) || volume <= 0) return;
    volume = Math.min(1, volume);
    const deferred = copyOptions(options);
    run('footstep', () => {
      const positional = !!positionOf(deferred);
      const choice = footstepVariations.next(deferred?.surface, deferred?.body);
      const slot = [choice.slot, ...FOOTSTEP_SLOTS[choice.surface], 'movement.footstep']
        .find((candidate) => samples.getBuffer(candidate));
      const lifetime = slot ? samples.getBuffer(slot).duration / choice.rate : 0.3;
      const output = pool.acquire(outputOptions(deferred), lifetime);
      if (slot) {
        let target = output;
        if (!positional && engine.ctx.createStereoPanner) {
          target = engine.ctx.createStereoPanner();
          target.pan.value = choice.pan;
          target.connect(output);
          addCleanup(output, () => target.disconnect());
        }
        if (samples.play(slot, target, { gain: volume * choice.gain,
          rate: choice.rate, cleanupOwner: output })) return;
      }
      const pan = positional ? 0 : choice.pan;
      // Heel thud plus a short sole scuff.
      primitives.tone(output, {
        type: 'sine', f0: primitives.rnd(120, 150), f1: 58,
        dec: 0.07, g: 0.22 * volume, att: 0.002, pan,
      });
      primitives.hiss(output, {
        filter: 'lowpass', f: 420, q: 0.6,
        rate: primitives.rnd(0.85, 1.13), dec: 0.07,
        g: 0.2 * volume, pan,
      });
    });
  },

  draw(rawWeapon) {
    const weapon = SFX_ALIAS[rawWeapon] ?? rawWeapon;
    run('draw', () => {
      const output = pool.acquire(null, (DRAW_LEN[weapon] || 0.11) + 0.3);
      if (samples.play(`weapons.${weapon}.draw`, output)) return;
      drawCloth(output, primitives, weapon);
    });
  },

  bulletWhiz(volume = 0.5, options = null) {
    run('bulletWhiz', () => {
      const output = pool.acquire(outputOptions(options), 1.15);
      const variant = bulletWhizIndex++ % 3;
      const slot = variant ? `combat.bulletWhiz.${variant + 1}` : 'combat.bulletWhiz';
      if (samples.play(slot, output, { gain: volume })
        || (variant && samples.play('combat.bulletWhiz', output, { gain: volume }))) return;
      primitives.hiss(output, {
        filter: 'bandpass', f: 3000, sweepTo: 1400,
        sweepMs: 0.16, q: 5, dec: 0.16, g: 0.32 * volume,
        pan: positionOf(options) ? 0 : (Math.random() < 0.5 ? -1 : 1) * primitives.rnd(0.6, 0.95),
      });
    });
  },

  /** Cloth movement as the throwable is raised into view. */
  grenadeDraw() {
    run('grenadeDraw', () => {
      const output = pool.acquire(null, 0.22);
      primitives.hiss(output, {
        t0: primitives.nowT(), filter: 'bandpass', f: 850, q: 0.8, att: 0.015, dec: 0.16, g: 0.09,
      });
    });
  },

  /** A lighter strike followed by the soft ignition of the visible cloth. */
  molotovIgnite() {
    run('molotovIgnite', () => {
      const output = pool.acquire(null, 0.65);
      const at = primitives.nowT();
      primitives.hiss(output, { t0: at, filter: 'highpass', f: 4200, dec: 0.025, g: 0.2 });
      primitives.tone(output, { t0: at, type: 'square', f0: 1600, f1: 900, dec: 0.035, g: 0.035 });
      primitives.hiss(output, {
        t0: at + 0.04, filter: 'bandpass', f: 620, sweepTo: 1300, sweepMs: 0.18,
        q: 0.7, att: 0.025, dec: 0.48, g: 0.19,
      });
    });
  },

  /** Pin extraction cue, triggered by the hand animation. */
  grenadePin() {
    run('grenadePin', () => {
      const output = pool.acquire(null, 0.25);
      if (samples.play('combat.grenadePin', output)) return;
      const at = primitives.nowT();
      primitives.hiss(output, {
        t0: at, filter: 'bandpass', f: 3600, q: 6, dec: 0.035, g: 0.22, pan: 0.25,
      });
      primitives.tone(output, {
        t0: at + 0.004, type: 'square', f0: 2400, f1: 1700, att: 0.001, dec: 0.045, g: 0.08,
      });
    });
  },

  /** Denied grenade press (empty pouch or throw cooldown): a dry, dead trigger click. */
  grenadeEmpty() {
    run('grenadeEmpty', () => {
      const output = pool.acquire(null, 0.12);
      const at = primitives.nowT();
      primitives.hiss(output, { t0: at, filter: 'highpass', f: 5200, dec: 0.012, g: 0.16 });
      primitives.tone(output, { t0: at, type: 'square', f0: 820, f1: 540, att: 0.001, dec: 0.018, g: 0.05 });
    });
  },

  /** The throwable settles in the fingers (the hands' 'ready' cue): a soft spoon click. */
  grenadeReady() {
    run('grenadeReady', () => {
      const output = pool.acquire(null, 0.12);
      const at = primitives.nowT();
      primitives.hiss(output, { t0: at, filter: 'bandpass', f: 2300, q: 3, dec: 0.028, g: 0.09, pan: 0.2 });
      primitives.tone(output, { t0: at + 0.002, type: 'sine', f0: 1350, f1: 1080, dec: 0.04, g: 0.035 });
    });
  },

  /** Pin back ('cancel' cue): the ring scrapes into its socket and the spoon seats. */
  grenadePinBack() {
    run('grenadePinBack', () => {
      const output = pool.acquire(null, 0.3);
      const at = primitives.nowT();
      primitives.hiss(output, {
        t0: at, filter: 'bandpass', f: 2600, sweepTo: 4300, sweepMs: 0.08, q: 5, att: 0.01, dec: 0.08, g: 0.1, pan: -0.15,
      });
      primitives.tone(output, {
        t0: at + 0.1, type: 'square', f0: 1900, f1: 2500, att: 0.001, dec: 0.03, g: 0.06,
      });
      primitives.hiss(output, { t0: at + 0.1, filter: 'bandpass', f: 3400, q: 6, dec: 0.03, g: 0.14 });
    });
  },

  /**
   * One cook tick while a timed fuse burns in the hand. `rate` > 1 is the
   * urgent tick near the end of the fuse: higher and a little louder.
   */
  grenadeFuseTick(rate = 1) {
    const urgency = Math.max(0.5, Math.min(2, Number(rate) || 1));
    run('grenadeFuseTick', () => {
      const output = pool.acquire(null, 0.08);
      const at = primitives.nowT();
      primitives.tone(output, {
        t0: at, type: 'square', f0: 1500 * urgency, f1: 1200 * urgency, att: 0.001, dec: 0.018,
        g: 0.03 + 0.015 * (urgency - 1),
      });
      primitives.hiss(output, { t0: at, filter: 'highpass', f: 6000, dec: 0.01, g: 0.06 });
    });
  },

  /** Claymore placement: the mount bites into the wall and the latch snaps shut. */
  claymoreClamp() {
    run('claymoreClamp', () => {
      const output = pool.acquire(null, 0.3);
      const at = primitives.nowT();
      primitives.tone(output, { t0: at, type: 'sine', f0: 190, f1: 85, att: 0.002, dec: 0.09, g: 0.22 });
      primitives.hiss(output, { t0: at, filter: 'lowpass', f: 900, dec: 0.05, g: 0.14 });
      primitives.hiss(output, { t0: at + 0.06, filter: 'bandpass', f: 2800, q: 4, dec: 0.035, g: 0.16 });
      primitives.tone(output, { t0: at + 0.062, type: 'square', f0: 1400, f1: 900, att: 0.001, dec: 0.025, g: 0.045 });
    });
  },

  /** Release: an arm swing whoosh whose weight scales with the charge. */
  grenadeThrow(charge = 0.5, options) {
    const strength = Math.max(0, Math.min(1, Number(charge) || 0));
    const deferred = copyOptions(options);
    run('grenadeThrow', () => {
      const output = pool.acquire(outputOptions(deferred), 0.5);
      if (samples.play('combat.grenadeThrow', output, { gain: 0.6 + strength * 0.4 })) return;
      const at = primitives.nowT();
      primitives.hiss(output, {
        t0: at, filter: 'bandpass', f: 700 + strength * 500, sweepTo: 260,
        sweepMs: 0.2 + strength * 0.08, q: 1.4, dec: 0.24 + strength * 0.1,
        g: 0.24 + strength * 0.16, pan: 0.3,
      });
    });
  },

  /**
   * Blast at a world position. `type` is frag | limpet | pulse | rocket (frag by default).
   * A RIPTIDE disc ending (`type` 'glaive') is never a blast: `detail.caught` plays the
   * catch clack, `detail.embedded` the wall thunk, and anything else a lifetime fizzle.
   */
  explosion(pos, type = 'frag', detail = null) {
    const deferredPos = Array.isArray(pos) ? pos.slice(0, 3) : pos;
    // Conquest bank (when decoded): per-weapon blast takes, near/distant by range.
    const conquestGroup = conquestBlastGroup(type, detail);
    // A Conquest tank shell bursts with the rocket's heavy blast bank.
    if (type === 'shell') type = 'rocket';
    // Bolt expiry shares the projectile event channel, but has no blast radius.
    if (type === 'bolt') return this.arcZap(deferredPos);
    if (type === 'glaive') {
      if (detail?.id != null) this.stopGlaiveFlight(detail.id);
      const cue = detail?.caught ? 'catch' : detail?.embedded ? 'embed' : 'fizzle';
      return this.glaiveCue(cue, Array.isArray(deferredPos) ? { pos: deferredPos } : null);
    }
    if (type === 'bubble') {
      // SUDSBLASTER pop: soap, not powder, so never the frag sample. The blast radius tells
      // a Big Bubble (> 3 m) from a Soap Shot and a Foam-party mini (< 2.15 m).
      const radius = Number(detail?.radius) || 2.2;
      run('bubblePop', () => {
        const output = pool.acquire({ pos: deferredPos, priority: 1 }, 0.35);
        bubblePop(output, primitives, { big: radius > 3, child: radius < 2.15 });
      });
      return;
    }
    if (type === 'smoke') {
      run('smokeRelease', () => {
        const output = pool.acquire({ pos: deferredPos, priority: 2 }, 2.2);
        primitives.hiss(output, { t0: primitives.nowT(), filter: 'lowpass', f: 2200,
          sweepTo: 600, sweepMs: 1.5, q: 0.6, att: 0.04, dec: 2, g: 0.35 });
      });
      return;
    }
    if (type === 'molotov') {
      run('molotovBreak', () => {
        const output = pool.acquire({ pos: deferredPos, priority: 2 }, 1.5);
        impactGlass(output, primitives, 1.5);
        primitives.hiss(output, {
          t0: primitives.nowT() + 0.035, filter: 'lowpass', f: 1600, sweepTo: 500,
          sweepMs: 0.8, q: 0.65, att: 0.025, dec: 1.25, g: 0.45,
        });
      });
      return;
    }
    const profile = EXPLOSION_PROFILES[type] || EXPLOSION_PROFILES.frag;
    if (conquestGroup && cqHas(conquestGroup) && Array.isArray(deferredPos) && deferredPos.every(Number.isFinite)) {
      const distance = listenerDistance(deferredPos);
      if (distance > VEHICLE_SOUND.farRange) return;
      // The near take carries the crack and debris; past 150 m the sampled
      // distant boom (delayed by the speed of sound) takes over, and beyond
      // 260 m only that boom is left.
      // Where both play (150-260 m) the near take arrives with the boom (distance /
      // 343 m/s) and fades out across the band, so one blast never sounds twice.
      if (distance <= VEHICLE_SOUND.crackTo) {
        const handover = nearHandover(distance);
        run('explosion', () => {
          cqOneShot(conquestGroup, { pos: deferredPos, priority: 2, range: 'far' }, {
            gain: CONQUEST_MIX.blast * profile.gain * 0.85 * handover.gain, rate: 0.95 + Math.random() * 0.1, echo: profile.echo * 0.4,
            delay: handover.delay,
          });
        });
      }
      farLayer(deferredPos, { gain: profile.gain * 0.75, low: profile.lowHz, lifetime: profile.lifetime + 0.4 });
      flashbangRing(deferredPos);
      return;
    }
    // Blasts carry to 400 m; past 150 m a low-passed rumble takes over.
    if (Array.isArray(deferredPos)) {
      if (listenerDistance(deferredPos) > VEHICLE_SOUND.farRange) return;
      farLayer(deferredPos, { gain: profile.gain * 0.75, low: profile.lowHz, lifetime: profile.lifetime + 0.4 });
    }
    run('explosion', () => {
      const output = pool.acquire({ pos: deferredPos, priority: 2, range: 'far' }, profile.lifetime);
      output.gain.value = profile.gain;
      const at = primitives.nowT();
      const sampleType = EXPLOSION_PROFILES[type] ? type : 'frag';
      if (samples.play(`grenades.${sampleType}.explosion`, output, {
        gain: type === 'pulse' ? 0.75 : 0.95,
        rate: 1,
      })) {
        if (type === 'mgl') {
          // The round's close, dry detonation keeps an immediate punch under the sample.
          primitives.tone(output, {
            t0: at, type: 'sine', f0: 98, f1: 36, att: 0.001, dec: 0.32, g: 0.3,
          });
          primitives.hiss(output, {
            t0: at + 0.008, filter: 'bandpass', f: 2500, q: 0.85, dec: 0.11, g: 0.18,
          });
        }
        sendEcho(output, primitives, profile.echo * 0.45, engine.echoIn, addCleanup);
        return;
      }
      if (profile.electric) {
        // Pulse: an electric snap, a rising shockwave sweep, and a thin low thud.
        primitives.hiss(output, {
          t0: at, filter: 'bandpass', f: profile.crackHz, sweepTo: 900, sweepMs: 0.18, q: 1.6, dec: 0.2, g: profile.crack,
        });
        primitives.tone(output, {
          t0: at, type: 'square', f0: 1800, f1: 240, att: 0.001, dec: 0.14, g: 0.18,
        });
        primitives.hiss(output, {
          t0: at + 0.02, filter: 'highpass', f: 2400, q: 0.7, dec: 0.3, g: 0.26,
        });
        primitives.tone(output, {
          t0: at, type: 'sine', f0: profile.lowHz, f1: 40, att: 0.001, dec: 0.28, g: profile.low,
        });
        sendEcho(output, primitives, profile.echo, engine.echoIn, addCleanup);
        return;
      }
      if (samples.play('combat.grenadeExplosion', output, { gain: 0.8 + profile.low * 0.3 })) {
        if (type !== 'frag') {
          primitives.tone(output, {
            t0: at, type: 'sine', f0: profile.lowHz, f1: 28, att: 0.001, dec: 0.5, g: profile.low * 0.5,
          });
        }
        return;
      }
      primitives.hiss(output, {
        t0: at, filter: 'lowpass', f: 680, q: 0.55, dec: 0.3 + profile.low * 0.1, g: 0.82,
      });
      primitives.hiss(output, {
        t0: at + 0.012, filter: 'bandpass', f: profile.crackHz, q: 0.8, dec: 0.16, g: profile.crack,
      });
      primitives.tone(output, {
        t0: at, type: 'sine', f0: profile.lowHz, f1: 31, att: 0.001, dec: 0.3 + profile.low * 0.2, g: profile.low,
      });
      sendEcho(output, primitives, profile.echo, engine.echoIn, addCleanup);
    });
    // Flashbang ring: a close blast leaves a high ringing that fades with
    // distance. In-head and non-positional, like a stunned ear.
    flashbangRing(deferredPos);
  },

  /**
   * Tank main gun: a supersonic crack and chest thump near the gun, a
   * low-passed far thump beyond 150 m, culled past 400 m. `self` (the
   * listener rides that hull) plays in the head with the breech clank.
   * Returns which layers played.
   */
  vehicleCannon(pos, { self = false, weapon = 'tankAP' } = {}) {
    const at = positionFrom(pos);
    const distance = self ? 0 : listenerDistance(at);
    if (!self && distance > VEHICLE_SOUND.farRange) return { near: false, far: false };
    const near = self || distance <= VEHICLE_SOUND.crackTo;
    const he = weapon === 'tankHE';
    if (cqHas('cq.cannon.near')) {
      // Conquest bank: interior take for the crew, the near crack-boom with its
      // slapback in range, and the recorded distant report past 150 m.
      if (near) run('vehicleCannon', () => {
        if (self && cqOneShot('cq.cannon.interior', { priority: 3 }, { gain: CONQUEST_MIX.cannonSelf, echo: 0.12 })) return;
        const handover = self ? { gain: 1, delay: 0 } : nearHandover(distance);
        cqOneShot('cq.cannon.near', { pos: self ? null : at, priority: 3, range: 'far' }, {
          gain: CONQUEST_MIX.cannon * handover.gain, rate: (he ? 0.94 : 1) + Math.random() * 0.06, echo: 0.22,
          delay: handover.delay,
        });
      });
      const far = !self && farLayer(at, { gain: 1, low: 46, lifetime: 2.6, group: cqHas('cq.cannon.distant') ? 'cq.cannon.distant' : 'cq.distant' });
      return { near, far };
    }
    if (near) run('vehicleCannon', () => {
      const output = pool.acquire({ pos: self ? null : at, priority: 3, range: 'far' }, 2.6);
      output.gain.value = 1.2;
      const t = primitives.nowT();
      const crack = Math.max(0, 1 - distance / VEHICLE_SOUND.crackTo);
      primitives.hiss(output, { t0: t, filter: 'highpass', f: 2600, q: 0.7, dec: 0.08, g: 0.75 * (0.35 + 0.65 * crack) });
      primitives.hiss(output, { t0: t, filter: 'bandpass', f: he ? 900 : 1300, q: 0.7, dec: 0.22, g: 0.62 });
      primitives.tone(output, { t0: t, type: 'sine', f0: he ? 64 : 72, f1: 26, att: 0.001, dec: 0.7, g: 0.95 });
      primitives.hiss(output, { t0: t + 0.004, filter: 'lowpass', f: 700, q: 0.5, dec: 0.55, g: 0.72 });
      if (self) {
        // Breech kick and the spent stub hitting the turret floor.
        primitives.tone(output, { t0: t + 0.05, type: 'square', f0: 220, f1: 120, att: 0.001, dec: 0.07, g: 0.12 });
        primitives.tone(output, { t0: t + 0.62, type: 'triangle', f0: 640, f1: 410, att: 0.001, dec: 0.12, g: 0.07 });
      }
      sendEcho(output, primitives, 0.32, engine.echoIn, addCleanup);
    });
    const far = !self && farLayer(at, { gain: 1, low: 46, lifetime: 2.6 });
    return { near, far };
  },

  /** Chin autocannon round: a hard pop and a short body thump. */
  vehicleAutocannon(pos, { self = false } = {}) {
    const at = positionFrom(pos);
    if (!self && listenerDistance(at) > VEHICLE_SOUND.farRange) return false;
    run('vehicleAutocannon', () => {
      if (cqOneShot('cq.chin', { pos: self ? null : at, priority: 2, range: 'far' }, {
        gain: self ? CONQUEST_MIX.chinSelf : CONQUEST_MIX.chin, rate: 0.96 + Math.random() * 0.08 })) return;
      const output = pool.acquire({ pos: self ? null : at, priority: 2, range: 'far' }, 0.5);
      const t = primitives.nowT();
      primitives.hiss(output, { t0: t, filter: 'bandpass', f: 1700, q: 0.9, dec: 0.06, g: 0.5 });
      primitives.tone(output, { t0: t, type: 'sine', f0: 120, f1: 48, att: 0.001, dec: 0.16, g: 0.5 });
    });
    return true;
  },

  /**
   * Sustained hitscan mount loop (coax, HMG, door minigun, jet cannon).
   * Refresh on every authoritative shot; the loop holds ~0.16 s after the
   * last round. `heat` (0..1) brightens the report and adds a barrel sizzle.
   */
  vehicleGun(id, pos, weapon = 'hmg', { heat = 0, self = false } = {}) {
    const voicing = VEHICLE_GUNS[weapon] || VEHICLE_GUNS.hmg;
    const at = positionFrom(pos);
    const key = String(id);
    const hot = vehicleUnit(heat);
    if (!engine.ensure() || engine.ctx.state !== 'running') return false;
    if (!self && listenerDistance(at) > 260) { releaseLoop(gunLoops, key, gunLoops.get(key), VEHICLE_SOUND.gunFade); return false; }
    if (sampledGun(key, at, weapon, self, hot)) return true;
    run('vehicleGun', () => {
      refreshLoop(gunLoops, key, {
        pos: self ? null : at, priority: 2, hold: VEHICLE_SOUND.gunHold, fade: VEHICLE_SOUND.gunFade,
        max: VEHICLE_SOUND.maxGunLoops, level: voicing.level,
        create: (voice) => {
          const ctx = voice.ctx;
          // Each round is a pulse: a sawtooth at the fire rate gates the noise and body.
          const gate = ctx.createGain();
          gate.gain.value = 0.15;
          gate.connect(voice.gain);
          const pulse = ctx.createOscillator();
          pulse.type = 'sawtooth';
          pulse.frequency.value = voicing.rate;
          const depth = ctx.createGain();
          depth.gain.value = 0.85;
          pulse.connect(depth).connect(gate.gain);
          voice.report = loopNoise(voice, 'bandpass', voicing.band, voicing.q, 1, gate);
          const body = ctx.createOscillator();
          body.type = 'triangle';
          body.frequency.value = voicing.body;
          const bodyGain = ctx.createGain();
          bodyGain.gain.value = 0.55;
          body.connect(bodyGain).connect(gate);
          voice.sizzle = loopNoise(voice, 'highpass', 5200, 0.7, 0);
          voice.sources.push(pulse, body);
          voice.nodes.push(gate, depth, bodyGain);
        },
        retune: (voice, t) => {
          voice.report.filter.frequency.setTargetAtTime(voicing.band * (1 + hot * 0.18), t, 0.05);
          voice.sizzle.mix.gain.setTargetAtTime(hot * hot * 0.3, t, 0.1);
        },
      });
    });
    return true;
  },

  stopVehicleGun(id) { releaseLoop(gunLoops, String(id), gunLoops.get(String(id)), VEHICLE_SOUND.gunFade); },

  /** Missile or rocket launch: an ignition crack and a tearing whoosh. */
  vehicleMissileLaunch(pos, { self = false, kind = 'aa' } = {}) {
    const at = positionFrom(pos);
    if (!self && listenerDistance(at) > VEHICLE_SOUND.farRange) return false;
    const pod = kind === 'pod';
    run('vehicleMissileLaunch', () => {
      if (cqOneShot(pod ? 'cq.pod' : 'cq.aa.launch', { pos: self ? null : at, priority: 2, range: 'far' }, {
        gain: pod ? 0.85 : 0.95, rate: 0.95 + Math.random() * 0.1, echo: pod ? 0.08 : 0.15 })) return;
      const output = pool.acquire({ pos: self ? null : at, priority: 2, range: 'far' }, pod ? 0.6 : 1.2);
      const t = primitives.nowT();
      primitives.hiss(output, { t0: t, filter: 'bandpass', f: pod ? 1900 : 1400, q: 0.8, dec: 0.05, g: 0.4 });
      primitives.hiss(output, { t0: t + 0.01, filter: 'bandpass', f: pod ? 2600 : 1800, sweepTo: pod ? 900 : 600,
        sweepMs: pod ? 0.35 : 0.9, q: 0.7, att: 0.01, dec: pod ? 0.4 : 0.95, g: pod ? 0.32 : 0.45 });
      primitives.tone(output, { t0: t, type: 'sine', f0: 90, f1: 40, att: 0.002, dec: 0.2, g: 0.3 });
    });
    return true;
  },

  /** Positional rocket-motor roar for one missile in flight; refresh each frame. */
  missileFlight(id, pos) {
    const at = positionFrom(pos);
    if (!at || !engine.ensure() || engine.ctx.state !== 'running') return false;
    const key = String(id);
    run('missileFlight', () => {
      refreshLoop(missileLoops, key, {
        pos: at, priority: 1, range: 'far', hold: VEHICLE_SOUND.missileHold, fade: VEHICLE_SOUND.missileFade,
        max: VEHICLE_SOUND.maxMissileLoops, level: cqHas('cq.aa.flight') ? CONQUEST_MIX.missile : 0.2,
        create: (voice) => {
          if (cqLoopSource(voice, 'cq.aa.flight', { offset: Math.random() })) return;
          loopNoise(voice, 'bandpass', 1400, 0.6, 1); loopNoise(voice, 'lowpass', 300, 0.5, 0.6);
        },
      });
    });
    return true;
  },

  stopMissileFlight(id) { releaseLoop(missileLoops, String(id), missileLoops.get(String(id)), VEHICLE_SOUND.missileFade); },

  /** Flares: a string of pops and hiss; smoke: the launcher thumps and a rushing cloud. */
  vehicleCountermeasure(pos, kind = 'flares', { self = false } = {}) {
    const at = positionFrom(pos);
    if (!self && listenerDistance(at) > 260) return false;
    run('vehicleCountermeasure', () => {
      if (cqOneShot(kind === 'smoke' ? 'cq.smoke' : 'cq.flares', { pos: self ? null : at, priority: 2 }, {
        gain: 0.85, rate: 0.96 + Math.random() * 0.08 })) return;
      const output = pool.acquire({ pos: self ? null : at, priority: 2 }, 1.8);
      const t = primitives.nowT();
      if (kind === 'smoke') {
        for (let i = 0; i < 3; i++) primitives.tone(output, { t0: t + i * 0.07, type: 'sine', f0: 150, f1: 60, att: 0.001, dec: 0.12, g: 0.4 });
        primitives.hiss(output, { t0: t + 0.2, filter: 'lowpass', f: 1800, sweepTo: 500, sweepMs: 1.2, q: 0.6, att: 0.05, dec: 1.3, g: 0.3 });
      } else {
        for (let i = 0; i < 6; i++) {
          primitives.hiss(output, { t0: t + i * 0.09, filter: 'bandpass', f: 2400, q: 1.1, dec: 0.05, g: 0.32 });
          primitives.tone(output, { t0: t + i * 0.09, type: 'sine', f0: 260, f1: 110, att: 0.001, dec: 0.06, g: 0.16 });
        }
        primitives.hiss(output, { t0: t + 0.05, filter: 'highpass', f: 3200, q: 0.6, att: 0.04, dec: 1.4, g: 0.12 });
      }
    });
    return true;
  },

  /**
   * Round on a hull. Effective hits ring the plate per zone (front glacis
   * deeper, rear and top thinner); ineffective small-arms hits only ping.
   */
  vehicleHullHit(pos, { zone = 'side', eff = 1, dmg = 0, self = false, cls = null, type = null } = {}) {
    const at = positionFrom(pos);
    if (!self && listenerDistance(at) > 170) return false;
    const pitch = { front: 0.8, side: 1, rear: 1.15, top: 1.25, bottom: 0.9 }[zone] ?? 1;
    const weight = Math.max(0.2, Math.min(1, (Number(dmg) || 0) / 120 + 0.25));
    // Budgeted like bullet impacts: sustained HMG fire on a hull cannot crowd out weapon reports.
    if (!cqBudget(self ? 'hullSelf' : 'hull', HULL_HIT_SOUND.window, self ? HULL_HIT_SOUND.selfBudget : HULL_HIT_SOUND.budget)) return false;
    run('vehicleHullHit', () => {
      // Conquest bank: AT/HE/AA rounds crunch the plate (muffled interior take
      // for the crew); rounds that cannot hurt it ping off, sheet metal on a jeep.
      const heavy = eff && (cls ? ['at', 'he', 'aa'].includes(cls) : weight >= 0.6);
      const group = heavy ? (self ? 'cq.hull.heavyIn' : 'cq.hull.heavy') : type === 'jeep' ? 'cq.hull.light' : 'cq.hull.small';
      if (cqOneShot(group, { pos: self ? null : at, priority: eff ? 2 : 0 }, {
        gain: heavy ? 0.95 : 0.55 + weight * 0.3, rate: pitch > 1 ? 1 + (pitch - 1) * 0.3 : 1 - (1 - pitch) * 0.3,
      })) return;
      const output = pool.acquire({ pos: self ? null : at, priority: eff ? 2 : 0 }, 0.9);
      if (!eff) {
        primitives.tone(output, { t0: primitives.nowT(), type: 'triangle', f0: 2600 * pitch, f1: 1900 * pitch, att: 0.001, dec: 0.08, g: 0.14 });
        return;
      }
      impactMetal(output, primitives, weight);
      const t = primitives.nowT();
      primitives.tone(output, { t0: t, type: 'triangle', f0: 420 * pitch, f1: 300 * pitch, att: 0.001, dec: 0.35 + weight * 0.3, g: 0.22 * weight });
      primitives.tone(output, { t0: t, type: 'sine', f0: 140 * pitch, f1: 70, att: 0.001, dec: 0.25, g: 0.35 * weight });
    });
    return true;
  },

  /** Positional burning crackle for a burning hull or a fresh wreck; refresh each frame. */
  vehicleBurning(id, pos, intensity = 1) {
    const at = positionFrom(pos);
    if (!at || !engine.ensure() || engine.ctx.state !== 'running') return false;
    const key = String(id);
    run('vehicleBurning', () => {
      refreshLoop(burnLoops, key, {
        pos: at, priority: 1, hold: VEHICLE_SOUND.burnHold, fade: VEHICLE_SOUND.burnFade,
        max: VEHICLE_SOUND.maxBurnLoops,
        level: (cqHas('cq.burning') ? CONQUEST_MIX.burning : VEHICLE_SOUND.burnLevel) * vehicleUnit(intensity),
        create: (voice) => {
          // Conquest bank: one of the fire roar loops, picked per key so a wreck keeps its voice.
          const variant = 1 + ([...key].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 2);
          if (cqLoopSource(voice, 'cq.burning', { variant, offset: Math.random() * 4 })) return;
          const ctx = voice.ctx;
          const crackle = ctx.createGain();
          crackle.gain.value = 0.2;
          crackle.connect(voice.gain);
          const flicker = ctx.createOscillator();
          flicker.type = 'sawtooth';
          flicker.frequency.value = 9;
          const depth = ctx.createGain();
          depth.gain.value = 0.6;
          flicker.connect(depth).connect(crackle.gain);
          loopNoise(voice, 'lowpass', 420, 0.6, 0.9);
          loopNoise(voice, 'bandpass', 2600, 1.4, 0.7, crackle);
          voice.sources.push(flicker);
          voice.nodes.push(crackle, depth);
        },
      });
    });
    return true;
  },

  stopVehicleBurning(id) { releaseLoop(burnLoops, String(id), burnLoops.get(String(id)), VEHICLE_SOUND.burnFade); },

  /** Hatch slam (enter) or latch and creak (exit). */
  vehicleHatch(pos, { enter = true, self = false } = {}, type = null) {
    const at = positionFrom(pos);
    if (!self && listenerDistance(at) > 60) return false;
    run('vehicleHatch', () => {
      const groups = HATCH_GROUPS[type];
      if (groups && cqOneShot(groups[enter ? 0 : 1], { pos: self ? null : at, priority: 0 }, { gain: self ? 0.7 : 0.9 })) return;
      const output = pool.acquire({ pos: self ? null : at, priority: 0 }, 0.8);
      const t = primitives.nowT();
      if (enter) {
        primitives.tone(output, { t0: t, type: 'square', f0: 180, f1: 90, att: 0.001, dec: 0.08, g: 0.16 });
        primitives.hiss(output, { t0: t, filter: 'bandpass', f: 900, q: 1.1, dec: 0.12, g: 0.3 });
      } else {
        primitives.tone(output, { t0: t, type: 'triangle', f0: 1400, f1: 1100, att: 0.001, dec: 0.05, g: 0.1 });
        primitives.hiss(output, { t0: t + 0.06, filter: 'bandpass', f: 600, sweepTo: 420, sweepMs: 0.3, q: 2.5, att: 0.03, dec: 0.3, g: 0.12 });
      }
    });
    return true;
  },

  /** Reload complete: the breech or feed tray clunks home. */
  vehicleReload(pos, { self = false, heavy = false } = {}) {
    const at = positionFrom(pos);
    if (!self && listenerDistance(at) > 50) return false;
    run('vehicleReload', () => {
      if (cqOneShot(heavy ? 'cq.reload.heavy' : 'cq.reload.light', { pos: self ? null : at, priority: 0 }, {
        gain: self ? 0.75 : 0.9 })) return;
      const output = pool.acquire({ pos: self ? null : at, priority: 0 }, 0.6);
      const t = primitives.nowT();
      primitives.tone(output, { t0: t, type: 'square', f0: heavy ? 150 : 260, f1: heavy ? 80 : 160, att: 0.001, dec: 0.06, g: 0.14 });
      primitives.hiss(output, { t0: t + 0.08, filter: 'bandpass', f: heavy ? 700 : 1300, q: 1.6, dec: 0.08, g: 0.22 });
      primitives.tone(output, { t0: t + 0.09, type: 'sine', f0: heavy ? 90 : 140, f1: 60, att: 0.001, dec: 0.12, g: 0.22 });
    });
    return true;
  },

  /**
   * Cockpit cue loop for locks: 'locking' beeps, 'locked' steady tone,
   * 'inbound' fast warble (the hull is being locked or targeted), 'acquire' /
   * 'lock' for the shooter's own seeker, or null/'off' to silence. Refresh
   * each frame while the state holds.
   */
  vehicleLockTone(mode) {
    this._cueLoop('lock', mode);
  },

  /** Damage alarm (own hull below 30 %); refresh each frame while active. */
  vehicleAlarm(active, { air = false } = {}) {
    this._cueLoop('alarm', active ? (air ? 'alarmAir' : 'alarm') : null);
  },

  _cueLoop(slot, mode) {
    const cue = mode && VEHICLE_CUES[mode];
    const voice = cueLoops.get(slot);
    if (!cue) { if (voice) releaseLoop(cueLoops, slot, voice, VEHICLE_SOUND.cueFade); return false; }
    if (!engine.ensure() || engine.ctx.state !== 'running') return false;
    if (voice && voice.mode !== mode) releaseLoop(cueLoops, slot, voice, 0.02);
    const sampled = cqHas(`cq.cue.${mode}`);
    run('vehicleCue', () => {
      refreshLoop(cueLoops, slot, {
        priority: 2, hold: VEHICLE_SOUND.cueHold, fade: VEHICLE_SOUND.cueFade, max: 2, level: sampled ? CONQUEST_MIX.cue : cue.level,
        create: (next) => {
          const ctx = next.ctx;
          next.mode = mode;
          if (sampled && cqLoopSource(next, `cq.cue.${mode}`)) return;
          const tone = ctx.createOscillator();
          tone.type = 'square';
          tone.frequency.value = cue.hz;
          const shape = ctx.createBiquadFilter();
          shape.type = 'lowpass';
          shape.frequency.value = cue.hz * 3;
          const gate = ctx.createGain();
          gate.gain.value = cue.gate ? 0.5 : 1;
          tone.connect(shape).connect(gate).connect(next.gain);
          next.sources.push(tone);
          next.nodes.push(shape, gate);
          if (cue.gate) {
            const lfo = ctx.createOscillator();
            lfo.type = 'square';
            lfo.frequency.value = cue.gate;
            const depth = ctx.createGain();
            depth.gain.value = 0.5;
            lfo.connect(depth).connect(gate.gain);
            next.sources.push(lfo);
            next.nodes.push(depth);
          }
        },
      });
    });
    return true;
  },

  /**
   * A hull blowing up: a heavy boom with debris rattle near it and a far
   * rumble beyond 150 m. Cook-offs (`secondary`) are shorter and sharper.
   */
  vehicleDestruction(pos, type = 'jeep', { secondary = false } = {}) {
    const at = positionFrom(pos);
    if (listenerDistance(at) > VEHICLE_SOUND.farRange) return { near: false, far: false };
    const heavy = type === 'tank' ? 1 : type === 'jeep' ? 0.7 : 0.85;
    const near = listenerDistance(at) <= VEHICLE_SOUND.crackTo;
    const group = secondary ? 'cq.cookoff' : DESTRUCTION_GROUPS[type];
    if (group && cqHas(group)) {
      // Conquest bank: per-class fuel and ammo blast (airborne breakup and crash
      // for aircraft) or a cook-off crackle, plus the recorded distant boom.
      if (near) run('vehicleDestruction', () => {
        cqOneShot(group, { pos: at, priority: 3, range: 'far' }, {
          gain: secondary ? 0.85 : CONQUEST_MIX.blast * 1.1, rate: 0.96 + Math.random() * 0.08, echo: secondary ? 0.1 : 0.25,
        });
      });
      const far = farLayer(at, { gain: secondary ? 0.6 : 1.1, low: 44, lifetime: secondary ? 1.6 : 3 });
      return { near, far };
    }
    if (near) run('vehicleDestruction', () => {
      const output = pool.acquire({ pos: at, priority: 3, range: 'far' }, secondary ? 1.4 : 3.2);
      output.gain.value = secondary ? 0.9 : 1.25;
      const t = primitives.nowT();
      if (!secondary && samples.play('grenades.rocket.explosion', output, { gain: 0.9, rate: 0.82 })) {
        primitives.tone(output, { t0: t, type: 'sine', f0: 52, f1: 22, att: 0.002, dec: 1.2, g: 0.6 * heavy });
      } else {
        primitives.hiss(output, { t0: t, filter: 'lowpass', f: secondary ? 1100 : 620, q: 0.55, dec: secondary ? 0.35 : 0.9, g: 0.85 });
        primitives.tone(output, { t0: t, type: 'sine', f0: secondary ? 88 : 50, f1: 24, att: 0.001, dec: secondary ? 0.4 : 1.1, g: 0.9 * heavy });
        primitives.hiss(output, { t0: t + 0.01, filter: 'bandpass', f: 1500, q: 0.8, dec: 0.2, g: 0.4 });
      }
      if (!secondary) {
        // Metal rain: a few delayed clatters as fragments land.
        for (let i = 0; i < 5; i++) {
          primitives.tone(output, { t0: t + 0.6 + i * 0.23 + Math.random() * 0.1, type: 'triangle',
            f0: 900 + Math.random() * 900, f1: 500, att: 0.001, dec: 0.08, g: 0.05 });
        }
      }
      sendEcho(output, primitives, 0.4, engine.echoIn, addCleanup);
    });
    const far = farLayer(at, { gain: secondary ? 0.6 : 1.1, low: 44, lifetime: secondary ? 1.6 : 3 });
    return { near, far };
  },

  /**
   * Turret servo whine while the main gun traverses (`speed01` = traverse
   * rate 0..1, refreshed each frame); 0 stops it with the stop clunk. Quiet
   * outside, full for the crew (self). Conquest bank only.
   */
  vehicleTurret(id, pos, speed01, { self = false } = {}) {
    const key = String(id);
    const at = positionFrom(pos);
    const rate = vehicleUnit(speed01);
    const voice = turretLoops.get(key);
    if (rate <= 0.02) {
      if (!voice) return false;
      releaseLoop(turretLoops, key, voice, 0.1);
      if (cqHas('cq.tank.turretStop')) {
        run('vehicleTurret', () => cqOneShot('cq.tank.turretStop', { pos: self ? null : at, priority: 0 }, { gain: self ? 0.65 : 0.45 }));
      }
      return true;
    }
    if (!cqHas('cq.tank.turret') || !engine.ensure() || engine.ctx.state !== 'running') return false;
    if (!self && listenerDistance(at) > 40) return false;
    run('vehicleTurret', () => {
      refreshLoop(turretLoops, key, {
        pos: self ? null : at, priority: 1, hold: 0.15, fade: 0.12, max: 2,
        level: CONQUEST_MIX.turret * (self ? 1 : 0.5) * (0.45 + 0.55 * rate),
        create: (next) => { next.whine = cqLoopSource(next, 'cq.tank.turret', { rate: 0.7, offset: Math.random() * 2 }); },
        retune: (next, t) => next.whine?.source.playbackRate.setTargetAtTime(0.8 + 0.4 * rate, t, 0.08),
      });
    });
    return true;
  },

  stopVehicleTurret(id) { releaseLoop(turretLoops, String(id), turretLoops.get(String(id)), 0.1); },

  /** Turbine wind-up ('up') or blades slowing ('down') of a rotorcraft. Conquest bank only. */
  vehicleRotorSpool(pos, direction = 'up', { self = false, kind = 'helicopter' } = {}) {
    const group = direction === 'down' ? 'cq.rotor.spoolDown' : 'cq.rotor.spoolUp';
    const at = positionFrom(pos);
    if (!cqHas(group) || (!self && listenerDistance(at) > VEHICLE_SOUND.crackTo)) return false;
    run('vehicleRotorSpool', () => cqOneShot(group, { pos: self ? null : at, priority: 1, range: 'far' }, {
      gain: self ? 0.5 : 0.8, rate: kind === 'transport' ? 0.86 : 1 }));
    return true;
  },

  /**
   * Jet pass: `pos` is the closest-approach point and `delay` the seconds
   * until the jet gets there; the take's loudest moment lands on the pass.
   */
  jetFlyby(pos, { delay = 0 } = {}) {
    const at = positionFrom(pos);
    if (!at || !cqHas('cq.jet.flyby') || listenerDistance(at) > VEHICLE_SOUND.farRange) return false;
    run('jetFlyby', () => {
      const slot = cqPick('cq.jet.flyby');
      const index = Math.max(0, Number(slot?.split('.').pop()) - 1) || 0;
      const timing = alignPeak(delay, JET_FLYBY_PEAKS[index] ?? 3);
      cqOneShot('cq.jet.flyby', { pos: at, priority: 2, range: 'far' }, { slot, gain: 0.95, ...timing });
    });
    return true;
  },

  /** Tank shell passing the listener: AP supersonic crack, HE incoming whistle, aligned to the pass. */
  shellFlyby(pos, { he = false, delay = 0, id = null } = {}) {
    const group = he ? 'cq.shell.he' : 'cq.shell.ap';
    const at = positionFrom(pos);
    if (!at || !cqHas(group)) return false;
    run('shellFlyby', () => {
      const output = cqOneShot(group, { pos: at, priority: 2 }, {
        gain: he ? 0.7 : 0.9, rate: 0.96 + Math.random() * 0.08, ...alignPeak(delay, he ? 1.6 : 0.16) });
      if (!output || id == null) return;
      const now = engine.now;
      for (const [key, entry] of shellPasses) if (entry.passAt < now) shellPasses.delete(key);
      shellPasses.set(String(id), { output, passAt: now + Math.max(0, Number(delay) || 0) });
    });
    return true;
  },

  /** The shell `id` burst before its pass: silence its pending whistle or crack. */
  cancelShellFlyby(id) {
    const entry = shellPasses.get(String(id));
    if (!entry) return false;
    shellPasses.delete(String(id));
    if (engine.now >= entry.passAt) return false;
    fadeVoice(entry.output, 0.05);
    return true;
  },

  /** Jeep skid on a hard turn (gravel). Conquest bank only. */
  vehicleSkid(pos) {
    const at = positionFrom(pos);
    if (!cqHas('cq.jeep.skid') || listenerDistance(at) > 70) return false;
    run('vehicleSkid', () => cqOneShot('cq.jeep.skid', { pos: at, priority: 0 }, { gain: 0.65, rate: 0.92 + Math.random() * 0.16 }));
    return true;
  },

  /** Tracks or tyres churning through a ford; refresh each frame while wading. */
  vehicleWade(id, pos, intensity = 1, { self = false } = {}) {
    const at = positionFrom(pos);
    if (!at || !cqHas('cq.wade.loop') || !engine.ensure() || engine.ctx.state !== 'running') return false;
    if (!self && listenerDistance(at) > 70) return false;
    const key = String(id);
    run('vehicleWade', () => {
      refreshLoop(wadeLoops, key, {
        pos: self ? null : at, priority: 1, hold: 0.4, fade: 0.4, max: 2, level: CONQUEST_MIX.wade * vehicleUnit(intensity),
        create: (voice) => { cqLoopSource(voice, 'cq.wade.loop', { offset: Math.random() * 2 }); },
      });
    });
    return true;
  },

  stopVehicleWade(id) { releaseLoop(wadeLoops, String(id), wadeLoops.get(String(id)), 0.3); },

  /** Bow splash as a hull drives into the water. */
  vehicleWadeSplash(pos, { self = false } = {}) {
    const at = positionFrom(pos);
    if (!cqHas('cq.wade.splash') || (!self && listenerDistance(at) > 70)) return false;
    run('vehicleWadeSplash', () => cqOneShot('cq.wade.splash', { pos: self ? null : at, priority: 0 }, { gain: 0.75 }));
    return true;
  },

  /** Ejection seat fired: canopy bolts, canopy tear and the seat rocket. */
  ejectionSeat(pos, { self = false } = {}) {
    const at = positionFrom(pos);
    if (!cqHas('cq.eject') || (!self && listenerDistance(at) > VEHICLE_SOUND.crackTo)) return false;
    run('ejectionSeat', () => cqOneShot('cq.eject', { pos: self ? null : at, priority: 2, range: 'far' }, { gain: 0.9 }));
    return true;
  },

  /** Canopy snapping open. */
  parachuteOpen(pos, { self = false } = {}) {
    const at = positionFrom(pos);
    if (!cqHas('cq.chute.open') || (!self && listenerDistance(at) > 80)) return false;
    run('parachuteOpen', () => cqOneShot('cq.chute.open', { pos: self ? null : at, priority: 0 }, { gain: self ? 0.8 : 0.7 }));
    return true;
  },

  /** Wind and canopy flutter under an open chute; refresh each frame. */
  parachuteDescent(id, pos, { self = false } = {}) {
    const at = positionFrom(pos);
    if (!at || !cqHas('cq.chute.descent') || !engine.ensure() || engine.ctx.state !== 'running') return false;
    if (!self && listenerDistance(at) > 30) return false;
    const key = String(id);
    run('parachuteDescent', () => {
      refreshLoop(chuteLoops, key, {
        pos: self ? null : at, priority: 1, hold: 0.3, fade: 0.5, max: 2, level: CONQUEST_MIX.descent * (self ? 1 : 0.5),
        create: (voice) => { cqLoopSource(voice, 'cq.chute.descent', { offset: Math.random() * 3 }); },
      });
    });
    return true;
  },

  stopParachuteDescent(id) { releaseLoop(chuteLoops, String(id), chuteLoops.get(String(id)), 0.4); },

  /**
   * Bullet hitting the world (`surface`: dirt/grass/gravel/sand, stone, wood,
   * metal, glass, water). Within 45 m, budgeted, with an occasional ricochet
   * off stone and metal. Conquest bank only (other modes stay visual-only).
   */
  bulletImpact(surface, pos) {
    const kind = BULLET_SURFACES[surface] || 'stone';
    const group = `cq.bullet.${kind}`;
    const at = positionFrom(pos);
    if (!at || !cqHas(group)) return false;
    const distance = listenerDistance(at);
    if (distance > BULLET_IMPACT_SOUND.range) return false;
    if (!cqBudget('bullet', BULLET_IMPACT_SOUND.window, BULLET_IMPACT_SOUND.budget)) return false;
    run('bulletImpact', () => {
      cqOneShot(group, { pos: at, priority: 0 }, { gain: CONQUEST_MIX.bullet, rate: 0.9 + Math.random() * 0.2 });
      if ((kind === 'stone' || kind === 'metal') && distance <= BULLET_IMPACT_SOUND.ricochetRange
        && Math.random() < BULLET_IMPACT_SOUND.ricochet) {
        cqOneShot('cq.ricochet', { pos: at, priority: 0 }, { gain: CONQUEST_MIX.bullet * 0.8, rate: 0.9 + Math.random() * 0.2, delay: 0.015 });
      }
    });
    return true;
  },

  /**
   * Decode the Conquest bank (audio/conquest-bank.js manifest) in the
   * background. Every cue keeps its procedural voice until its take decodes.
   */
  loadConquestBank(manifest, fetchImpl) {
    if (!manifest || typeof manifest !== 'object' || !engine.ensure()) return Promise.resolve(Object.freeze({ loaded: 0, failed: 0 }));
    ensureAudioModules();
    conquestBankPromise ??= loadConquestSlots(manifest, fetchImpl, conquestBankGeneration, 0);
    return conquestBankPromise;
  },

  /** Release the Conquest bank's decoded PCM after a Conquest match. */
  unloadConquestBank() {
    conquestBankPromise = null;
    conquestBankGeneration++;
    shellPasses.clear();
    cqLastVariant.clear();
    cqBudgets.clear();
    return samples?.unload(CQ_PREFIX) || 0;
  },

  /** The shared engine and decoded bank for the Conquest soundscape and objective cues. */
  conquestAudio() {
    return { engine, getBuffer: slot => samples?.getBuffer(slot) || null, pick: group => cqPick(group), has: group => cqHas(group) };
  },

  stopVehicleCues() {
    for (const map of [gunLoops, burnLoops, missileLoops, cueLoops, turretLoops, wadeLoops, chuteLoops]) {
      for (const [key, voice] of [...map]) releaseLoop(map, key, voice, 0.05);
      map.clear();
    }
    for (const timer of gunTimers.values()) clearTimeout(timer);
    gunTimers.clear();
    burstVoices.clear();
    gunShots.clear();
  },

  setListener(listener) {
    engine.setListener(listener);
  },
};
