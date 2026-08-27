// Public procedural-audio facade. AudioEngine owns the one AudioContext and
// master graph; VoicePool owns every bounded output graph; synthesis modules
// are pure graph builders.
import { AudioEngine } from './engine.js';
import { VoicePool } from './voices.js';
import { createVoices } from './primitives.js';
import { bodyImpact, synthPainVoice } from './human.js';
import { IMPACT_PARAMS, genericImpact, impactGlass, impactMetal } from './impacts.js';
import {
  DRAW_LEN,
  WEP_TONE,
  drawCloth,
  genericReloadStep,
  reloadLmg,
  reloadRevolver,
} from './mechanics.js';
import {
  FIRE_PARAMS,
  sendEcho,
  shotLmg,
  shotRevolver,
  shotRifleSmg,
  shotShotgun,
  shotSniper,
} from './reports.js';

const engine = new AudioEngine();
let pool = null;
let primitives = null;
let panSide = 1;

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

function ensureSynthesis() {
  if (!engine.ctx || engine.ctx.state === 'closed') return false;
  if (!pool) pool = new VoicePool(engine);
  if (!primitives) primitives = createVoices(engine);
  return true;
}

function run(kind, callback) {
  return engine.queueOrRun(kind, () => {
    if (ensureSynthesis()) callback();
  });
}

function addCleanup(output, cleanup) {
  pool.addCleanup(output, cleanup);
}

export const sfx = {
  init() {
    if (!engine.ensure()) return Promise.resolve(this);
    ensureSynthesis();
    return engine.resume().then(() => this);
  },

  unlock() {
    if (!engine.ensure()) return Promise.resolve(false);
    ensureSynthesis();
    return engine.resume();
  },

  async dispose() {
    pool = null;
    primitives = null;
    panSide = 1;
    await engine.dispose();
  },

  setMasterVolume(value) {
    engine.setMasterVolume(value);
  },

  fire(key, options) {
    const deferred = copyOptions(options);
    run('fire', () => {
      const lifetime = key === 'sniper' ? 1.3 : key === 'revolver' ? 0.75 : 0.8;
      const output = pool.acquireFire(key, outputOptions(deferred), lifetime);
      if (key === 'shotgun') shotShotgun(output, primitives);
      else if (key === 'sniper') {
        shotSniper(output, primitives, engine.echoIn, addCleanup);
      } else if (key === 'lmg') shotLmg(output, primitives);
      else if (key === 'revolver') shotRevolver(output, primitives);
      else shotRifleSmg(output, primitives, FIRE_PARAMS[key] || FIRE_PARAMS.rifle);
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
      if (kind === 'glass') impactGlass(output, primitives, normalized);
      else if (kind === 'metal') impactMetal(output, primitives, normalized);
      else genericImpact(output, primitives, params, normalized);
    });
  },

  reloadClick(step, weapon) {
    run('reload', () => {
      const brightness = WEP_TONE[weapon] || 1;
      const output = pool.acquire(null, 0.45);
      const at = primitives.nowT();
      if (weapon === 'lmg') reloadLmg(output, primitives, step, at, brightness);
      else if (weapon === 'revolver') {
        reloadRevolver(output, primitives, step, at, brightness);
      } else genericReloadStep(output, primitives, step, at, brightness);
    });
  },

  hitmark(headshot) {
    run('hitmark', () => {
      const output = pool.acquire(null, 0.4);
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

  pain({ damage = 0, headshot = false, lethal = false, pos, local = false } = {}) {
    const deferredPos = Array.isArray(pos) ? pos.slice(0, 3) : pos;
    run('pain', () => {
      const numeric = Number(damage);
      const hitDamage = Number.isFinite(numeric) ? Math.min(100, Math.max(0, numeric)) : 0;
      const lifetime = lethal ? 1.45 : headshot ? 1.05 : hitDamage >= 35 ? 0.95 : 0.7;
      const output = pool.acquireHuman({ pos: local ? null : positionOf(deferredPos) }, lifetime);
      output.gain.value = local ? 0.96 : 0.82;
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
      drawCloth(output, primitives, weapon);
    });
  },

  bulletWhiz(volume = 0.5) {
    run('bulletWhiz', () => {
      const output = pool.acquire(null, 0.4);
      primitives.hiss(output, {
        filter: 'bandpass', f: 3000, sweepTo: 1400,
        sweepMs: 0.16, q: 5, dec: 0.16, g: 0.32 * volume,
        pan: (Math.random() < 0.5 ? -1 : 1) * primitives.rnd(0.6, 0.95),
      });
    });
  },

  setListener(listener) {
    engine.setListener(listener);
  },
};
