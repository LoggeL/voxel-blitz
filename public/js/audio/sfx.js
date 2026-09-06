// Public procedural-audio facade. AudioEngine owns the one AudioContext and
// master graph; VoicePool owns every bounded output graph; synthesis modules
// are pure graph builders.
import { AudioEngine } from './engine.js';
import { VoicePool } from './voices.js';
import { FlameLoops } from './flame-loop.js';
import { createVoices } from './primitives.js';
import { BUILTIN_SAMPLE_MANIFEST, LocalSampleBank } from './samples.js';
import { MenuMusicLoop } from './music.js';
import { bodyImpact, synthPainVoice } from './human.js';
import { IMPACT_PARAMS, genericImpact, impactGlass, impactMetal } from './impacts.js';
import {
  DRAW_LEN,
  WEP_TONE,
  cycleActionClick,
  drawCloth,
  genericReloadStep,
  reloadLmg,
  reloadLongarc,
  reloadRevolver,
  reloadRocket,
} from './mechanics.js';
import {
  arcZap,
  fireReportProfile,
  fireSampleProfile,
  renderFireReport,
  sendEcho,
} from './reports.js';

const engine = new AudioEngine();
let pool = null;
let primitives = null;
let samples = null;
let builtInSamplesPromise = null;
let menuMusic = null;
let panSide = 1;
let heartbeatAt = -Infinity;
let chargeLoop = null;
let flameLoops = null;

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
  if (!flameLoops) flameLoops = new FlameLoops(engine, pool);
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
      getDestination: () => engine.bus,
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
    return Promise.all([engine.resume(), loadBuiltInSamples()]).then(() => this);
  },

  unlock() {
    if (!engine.ensure()) return Promise.resolve(false);
    ensureAudioModules();
    return engine.resume();
  },

  async dispose() {
    disposeChargeLoop();
    flameLoops?.dispose();
    flameLoops = null;
    menuMusic?.dispose();
    menuMusic = null;
    pool = null;
    primitives = null;
    samples?.clear();
    samples = null;
    builtInSamplesPromise = null;
    panSide = 1;
    heartbeatAt = -Infinity;
    await engine.dispose();
  },

  setMasterVolume(value) {
    engine.setMasterVolume(value);
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
    if (key === 'minigun') key = 'lmg';
    const deferred = copyOptions(options);
    if (key === 'flamethrower') {
      if (!engine.ensure()) return;
      ensureAudioModules();
      if (engine.ctx.state !== 'running') { void engine.resume(); return; }
      flameLoops.refresh({ ...outputOptions(deferred), shooterId: deferred?.shooterId });
      return;
    }
    run('fire', () => {
      const profile = fireReportProfile(key);
      const charge = deferred && !Array.isArray(deferred) && Number.isFinite(deferred.charge)
        ? deferred.charge : 1;
      const output = pool.acquireFire(key, outputOptions(deferred), profile.lifetime);
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
    run('impact', () => {
      const output = pool.acquire({ pos }, 0.4);
      const at = primitives.nowT();
      const soft = [1, 2, 4, 5, 6, 10].includes(type);
      const pitch = (soft ? 150 : type === 11 ? 950 : 330) * (0.9 + Math.random() * 0.2);
      for (let i = 0; i < (broken ? 4 : 2); i++) {
        primitives.hiss(output, { t0: at + i * 0.028, filter: 'bandpass',
          f: pitch * 4, q: 0.7, dec: 0.045, g: broken ? 0.3 : 0.18 });
        primitives.tone(output, { t0: at + i * 0.028, type: 'square',
          f0: pitch, f1: pitch * 0.45, att: 0.001, dec: 0.035, g: 0.055 });
      }
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
      else if (weapon === 'revolver') {
        reloadRevolver(output, primitives, step, at, brightness);
      } else genericReloadStep(output, primitives, step, at, brightness);
    });
  },

  hitmark(headshot) {
    run('hitmark', () => {
      const output = pool.acquire(null, 0.4);
      if (samples.play(headshot ? 'ui.hitmark.head' : 'ui.hitmark.body', output)) return;
      const at = primitives.nowT();
      primitives.hiss(output, {
        t0: at, filter: 'highpass', f: 4800, q: 0.7, dec: 0.018, g: 0.12,
      });
      primitives.tone(output, {
        t0: at, type: 'square', f0: 1760, f1: 1420,
        att: 0.001, dec: 0.04, g: 0.2,
      });
      if (headshot) {
        primitives.tone(output, {
          t0: at + 0.012, type: 'sine', f0: 2489.02,
          att: 0.002, dec: 0.045, g: 0.14,
        });
        primitives.tone(output, {
          t0: at + 0.025, type: 'sine', f0: 987.77,
          att: 0.005, dec: 0.1, g: 0.12,
        });
        primitives.tone(output, {
          t0: at + 0.095, type: 'sine', f0: 1567.98,
          att: 0.005, dec: 0.13, g: 0.11,
        });
      }
    });
  },

  /** Kill confirmation: a two-note rise above the hitmark, brighter for headshots. */
  killConfirm(headshot = false) {
    run('killConfirm', () => {
      const output = pool.acquire(null, 0.6);
      if (samples.play(headshot ? 'ui.kill.head' : 'ui.kill.body', output)) return;
      const at = primitives.nowT();
      primitives.hiss(output, {
        t0: at, filter: 'highpass', f: 3400, q: 0.8, dec: 0.05, g: 0.1,
      });
      primitives.tone(output, {
        t0: at, type: 'square', f0: 880, f1: 660, att: 0.002, dec: 0.09, g: 0.2,
      });
      primitives.tone(output, {
        t0: at + 0.07, type: 'sine', f0: 1318.51, att: 0.003, dec: 0.17, g: 0.16,
      });
      if (headshot) {
        primitives.tone(output, {
          t0: at + 0.13, type: 'sine', f0: 1975.53, att: 0.003, dec: 0.2, g: 0.13,
        });
      }
    });
  },

  /**
   * Low-health heartbeat. Call every frame with the 0..1 danger level; the pulse
   * rate and weight rise with it and nothing plays at zero.
   */
  lowHealthPulse(level01, now = Date.now()) {
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
      const lifetime = lethal ? 1.45 : headshot ? 1.05 : hitDamage >= 35 ? 0.95 : 0.7;
      const output = pool.acquireHuman({ pos: local ? null : positionOf(deferredPos) }, lifetime);
      output.gain.value = local ? 0.96 : 0.82;
      const slot = lethal
        ? 'human.death.far'
        : headshot
          ? 'human.pain.head'
          : hitDamage >= 35
            ? 'human.pain.heavy'
            : 'human.pain.light';
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

  footstep(volume = 0.45) {
    run('footstep', () => {
      panSide = -panSide;
      const output = pool.acquire(null, 0.25);
      if (samples.play('movement.footstep', output, {
        gain: volume,
        rate: primitives.rnd(0.93, 1.07),
      })) return;
      primitives.hiss(output, {
        filter: 'lowpass', f: 320, q: 0.5,
        rate: primitives.rnd(0.85, 1.13), dec: 0.08,
        g: 0.26 * volume, pan: 0.4 * panSide,
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

  bulletWhiz(volume = 0.5) {
    run('bulletWhiz', () => {
      const output = pool.acquire(null, 0.4);
      if (samples.play('combat.bulletWhiz', output, { gain: volume })) return;
      primitives.hiss(output, {
        filter: 'bandpass', f: 3000, sweepTo: 1400,
        sweepMs: 0.16, q: 5, dec: 0.16, g: 0.32 * volume,
        pan: (Math.random() < 0.5 ? -1 : 1) * primitives.rnd(0.6, 0.95),
      });
    });
  },

  /** Pin pull at the start of a charge: a short, dry metallic click. */
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

  /** Release: an arm swing whoosh whose weight scales with the charge. */
  grenadeThrow(charge = 0.5) {
    const strength = Math.max(0, Math.min(1, Number(charge) || 0));
    run('grenadeThrow', () => {
      const output = pool.acquire(null, 0.5);
      if (samples.play('combat.grenadeThrow', output, { gain: 0.6 + strength * 0.4 })) return;
      const at = primitives.nowT();
      primitives.hiss(output, {
        t0: at, filter: 'bandpass', f: 700 + strength * 500, sweepTo: 260,
        sweepMs: 0.2 + strength * 0.08, q: 1.4, dec: 0.24 + strength * 0.1,
        g: 0.24 + strength * 0.16, pan: 0.3,
      });
    });
  },

  /** Blast at a world position. `type` is frag | limpet | pulse | rocket (frag by default). */
  explosion(pos, type = 'frag') {
    const deferredPos = Array.isArray(pos) ? pos.slice(0, 3) : pos;
    const profile = EXPLOSION_PROFILES[type] || EXPLOSION_PROFILES.frag;
    run('explosion', () => {
      const output = pool.acquire({ pos: deferredPos }, profile.lifetime);
      output.gain.value = profile.gain;
      const at = primitives.nowT();
      const sampleType = type === 'rocket' ? 'limpet' : type;
      if (samples.play(`grenades.${sampleType}.explosion`, output, {
        gain: type === 'pulse' ? 0.75 : 0.95,
        rate: type === 'rocket' ? 1.08 : 1,
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
  },

  /** Legacy alias kept for the frag blast. */
  grenadeExplosion(pos) {
    return this.explosion(pos, 'frag');
  },

  setListener(listener) {
    engine.setListener(listener);
  },
};
