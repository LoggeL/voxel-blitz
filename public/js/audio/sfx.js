import { CosmeticAudio } from './cosmetics.js';
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
  fireReportProfile,
  fireSampleProfile,
  renderFireReport,
  renderGlaiveCue,
  sendEcho,
} from './reports.js';

const engine = new AudioEngine();
const cosmeticAudio = new CosmeticAudio(engine);
let pool = null;
let primitives = null;
let samples = null;
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
const VEHICLE_DRONE = Object.freeze({ buggy: 140, apc: 90, walker: 60 });
const VEHICLE_HOLD = 0.6;
const VEHICLE_FADE = 0.3;
const VEHICLE_LEVEL = 0.16;
const MAX_VEHICLE_LOOPS = 6;

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
    voice.osc.stop(at + VEHICLE_FADE + 0.05);
    voice.sub.stop(at + VEHICLE_FADE + 0.05);
  } catch {}
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

/** Blast voice per explosive type: gain, low weight, and crack brightness. */
const EXPLOSION_PROFILES = Object.freeze({
  frag: Object.freeze({ gain: 1.08, lifetime: 1.25, low: 0.72, lowHz: 78, crack: 0.34, crackHz: 1850, echo: 0.22 }),
  limpet: Object.freeze({ gain: 1.18, lifetime: 2.2, low: 0.9, lowHz: 64, crack: 0.42, crackHz: 1500, echo: 0.28 }),
  pulse: Object.freeze({ gain: 1.0, lifetime: 1.2, low: 0.36, lowHz: 110, crack: 0.5, crackHz: 3400, echo: 0.16, electric: true }),
  rocket: Object.freeze({ gain: 1.22, lifetime: 2.2, low: 0.95, lowHz: 58, crack: 0.4, crackHz: 1600, echo: 0.3 }),
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
  if (!chargeLoop) return;
  try {
    chargeLoop.oscillator.stop();
    chargeLoop.shimmer.stop();
    chargeLoop.gain.disconnect();
  } catch {}
  chargeLoop = null;
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

  async dispose() {
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
    samples?.clear();
    samples = null;
    builtInSamplesPromise = null;
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

  fire(key, options) {
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
  weaponCharge(level01, active = true) {
    const level = Math.max(0, Math.min(1, Number(level01) || 0));
    if (!active) {
      if (chargeLoop) {
        const at = chargeLoop.ctx.currentTime;
        chargeLoop.gain.gain.cancelScheduledValues(at);
        chargeLoop.gain.gain.setTargetAtTime(0, at, 0.03);
        chargeLoop.level = 0;
      }
      return false;
    }
    if (!engine.ctx || engine.ctx.state === 'closed') return false;
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
  vehicleLoop(id, pos, kind = 'buggy') {
    // Refreshed every frame, so a suspended context skips it instead of filling
    // the unlock queue with stale drones that would push out real cues.
    if (!engine.ensure() || engine.ctx.state !== 'running') { void engine.resume(); return; }
    const key = String(id);
    const deferredPos = positionFrom(pos);
    run('vehicleLoop', () => {
      const ctx = engine.ctx;
      if (!ctx || ctx.state !== 'running') return;
      const at = ctx.currentTime;
      const hz = VEHICLE_DRONE[kind] ?? 100;
      let voice = vehicleLoops.get(key);
      if (voice && (voice.ctx !== ctx || at >= voice.end)) { releaseVehicleLoop(key, voice); voice = null; }
      if (!voice) {
        while (vehicleLoops.size >= MAX_VEHICLE_LOOPS) {
          const [oldKey, oldest] = [...vehicleLoops.entries()].reduce((a, b) => (a[1].last <= b[1].last ? a : b));
          releaseVehicleLoop(oldKey, oldest);
        }
        const output = pool.acquire(deferredPos ? { pos: deferredPos, priority: 1 } : null, VEHICLE_HOLD + VEHICLE_FADE);
        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.value = hz;
        const sub = ctx.createOscillator();
        sub.type = 'triangle';
        sub.frequency.value = hz / 2;
        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = kind === 'walker' ? 260 : 420;
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
      const level = at >= voice.end ? 0 : voice.gain.gain.value;
      voice.last = at;
      voice.end = at + VEHICLE_HOLD + VEHICLE_FADE;
      const g = voice.gain.gain;
      g.cancelScheduledValues(at);
      g.setValueAtTime(level, at);
      g.linearRampToValueAtTime(VEHICLE_LEVEL, at + 0.12);
      g.setValueAtTime(VEHICLE_LEVEL, at + VEHICLE_HOLD);
      g.linearRampToValueAtTime(0, voice.end);
      // WebAudio permits replacing a future stop deadline until the source ends.
      voice.osc.stop(voice.end + 0.05);
      voice.sub.stop(voice.end + 0.05);
      voice.osc.frequency.setTargetAtTime(hz * (0.98 + 0.04 * Math.random()), at, 0.12);
      if (kind === 'walker' && at >= voice.thudAt) {
        voice.thudAt = at + 0.7;
        primitives.tone(voice.output, { t0: at, type: 'sine', f0: 70, f1: 32, att: 0.004, dec: 0.22, g: 0.3 });
      }
      pool.refresh(voice.output, deferredPos ? { pos: deferredPos } : null, VEHICLE_HOLD + VEHICLE_FADE);
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

  cycleClick(step, weapon) {
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

  reloadClick(step, weapon) {
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

  draw(weapon) {
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
    // Bolt expiry shares the projectile event channel, but has no blast radius.
    if (type === 'bolt') return this.arcZap(deferredPos);
    if (type === 'glaive') {
      if (detail?.id != null) this.stopGlaiveFlight(detail.id);
      const cue = detail?.caught ? 'catch' : detail?.embedded ? 'embed' : 'fizzle';
      return this.glaiveCue(cue, Array.isArray(deferredPos) ? { pos: deferredPos } : null);
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
    run('explosion', () => {
      const output = pool.acquire({ pos: deferredPos, priority: 2 }, profile.lifetime);
      output.gain.value = profile.gain;
      const at = primitives.nowT();
      const sampleType = EXPLOSION_PROFILES[type] ? type : 'frag';
      if (samples.play(`grenades.${sampleType}.explosion`, output, {
        gain: type === 'pulse' ? 0.75 : 0.95,
        rate: 1,
      })) {
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
    const listenerPos = engine.listenerPos?.();
    if (Array.isArray(deferredPos) && deferredPos.every(Number.isFinite) && Array.isArray(listenerPos)) {
      const distance = Math.hypot(deferredPos[0] - listenerPos[0],
        deferredPos[1] - listenerPos[1], deferredPos[2] - listenerPos[2]);
      const proximity = Math.max(0, Math.min(1, 1 - distance / 18));
      if (proximity > 0) {
        run('flashbang', () => {
          const output = pool.acquire(null, 2.4);
          primitives.tone(output, {
            t0: primitives.nowT(), type: 'sine', f0: 3400, f1: 3100,
            att: 0.005, dec: 0.6 + proximity * 1.4, g: 0.05 + proximity * 0.22,
          });
        });
      }
    }
  },

  setListener(listener) {
    engine.setListener(listener);
  },
};
