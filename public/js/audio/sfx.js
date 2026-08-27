// Procedural WebAudio engine for Voxel Blitz. Zero audio files.
// Contract API: init/unlock/dispose/setMasterVolume/fire/impact/reloadClick/
// hitmark/deathFar/footstep/draw/bulletWhiz/setListener/pain/deathSelf.
// fire(), impact(), and pain() accept optional world positions for HRTF
// playback. Voice graphs are capped at 48 overall and 16 positional, with
// separate caps for rapid-fire reports and human voices.

let ctx = null;
let bus = null;             // master input gain
let masterLimiter = null;   // owned terminal limiter
let noiseBuf = null;
let echo = null;            // persistent multi-tap "canyon" tail network
let masterVolume = 0.9;
let resumePromise = null;
let gestureListenersArmed = false;
let panSide = 1;            // footstep L/R alternator
let visibilityListenerArmed = false;
let pageShowListenerArmed = false;
let flushingCues = false;
let lastListener = null;

const GESTURE_EVENTS = ['pointerdown', 'touchend', 'keydown'];
const MAX_POS = 16;
const MAX_VOICES = 48;
const MAX_QUEUED_CUES = 16;
const MAX_HUMAN_VOICES = 4;
const POS = [];             // live positional voice entries
const VOICES = [];          // every live output graph, oldest first
const VOICE_BY_OUT = new Map();
const CLEANUP_TIMERS = new Set();
const QUEUED_CUES = [];
const HUMAN_ACTIVE = [];
const FIRE_LIMIT = { lmg: 6, revolver: 4 };
const FIRE_ACTIVE = { lmg: [], revolver: [] };

/* ------------------------------------------------------------------ tables */

const FIRE_PARAMS = {
  rifle: {
    blipType: 'square', blipF0: 140, blipF1: 60, blipMs: 90,
    nzFilter: 'highpass', nzF: 2000, nzQ: 0.7, nzMs: 70,
    subHz: 55, subG: 0.5, subMs: 120, drive: 3,
  },
  smg: {
    blipType: 'square', blipF0: 110, blipF1: 46, blipMs: 55,
    nzFilter: 'bandpass', nzF: 3000, nzQ: 1.4, nzMs: 48,
    subHz: 66, subG: 0.32, subMs: 65, drive: 3,
  },
};

const IMPACT_PARAMS = {
  stone: { nzFilter: 'bandpass', nzF: 1200, nzQ: 4, ms: 60, g: 0.68 },
  wood:  { nzFilter: 'bandpass', nzF: 500, nzQ: 5, ms: 75, g: 0.62,
           knock: { type: 'triangle', f: 180, ms: 40, g: 0.36 } },
  metal: { partials: [900, 1359, 2140, 3415], ringMs: 300, g: 0.19,
           strikeMs: 6, strikeG: 0.38 },
  glass: { sparkles: 5, fMin: 2400, fMax: 7000, lifeMs: 260, g: 0.1 },
  flesh: { nzFilter: 'lowpass', nzF: 400, nzQ: 0.7, ms: 85, g: 0.58, cap: 0.45 },
};

// Per-weapon brightness factor applied to mechanical click/ping filter freqs.
const WEP_TONE = {
  rifle: 1, smg: 1.16, shotgun: 0.86, sniper: 1.05, lmg: 0.72, revolver: 1.32,
};
// Cloth-rustle draw length per weapon.
const DRAW_LEN = {
  rifle: 0.11, smg: 0.085, shotgun: 0.17, sniper: 0.21, lmg: 0.25, revolver: 0.13,
};

/* -------------------------------------------------------------- primitives */

function nowT(offset = 0) { return ctx.currentTime + 0.001 + offset; }
function rnd(a, b) { return a + Math.random() * (b - a); }

function biquad(type, f, q) {
  const b = ctx.createBiquadFilter();
  b.type = type;
  b.frequency.value = Math.max(20, f);
  if (q != null) b.Q.value = q;
  return b;
}

// tanh waveshaper with fixed drive (1..8 sensible).
function shaper(drive) {
  const ws = ctx.createWaveShaper();
  const n = 256;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * drive) / Math.tanh(drive);
  }
  ws.curve = curve;
  return ws;
}

// Percussive gain envelope: fast linear attack, exponential decay to silence.
function envGain(t0, peak, attSec, decSec) {
  const g = ctx.createGain();
  const p = g.gain;
  p.setValueAtTime(0.0001, t0);
  p.linearRampToValueAtTime(Math.max(0.0002, peak), t0 + attSec);
  p.exponentialRampToValueAtTime(0.0001, t0 + attSec + decSec);
  return g;
}

// Sine/square/saw tone with pitch env. o={t0,type,f0,f1,detune,g,att,dec}.
function tone(dest, o) {
  const t0 = o.t0 ?? nowT();
  const att = o.att ?? 0.003;
  const dec = o.dec ?? 0.1;
  const osc = ctx.createOscillator();
  osc.type = o.type || 'sine';
  osc.frequency.setValueAtTime(Math.max(1, o.f0), t0);
  if (o.f1) osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.f1), t0 + dec);
  if (o.detune) osc.detune.value = o.detune;
  const g = envGain(t0, o.g ?? 0.3, att, dec);
  osc.connect(g).connect(dest);
  osc.start(t0);
  osc.stop(t0 + att + dec + 0.03);
}

// Filtered white-noise burst. o={t0,filter,f,q,sweepTo,sweepMs,rate,g,att,dec,pan}.
function hiss(dest, o) {
  const t0 = o.t0 ?? nowT();
  const att = o.att ?? 0.001;
  const dec = o.dec ?? 0.08;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  src.loop = true;
  if (o.rate) src.playbackRate.value = o.rate;
  const flt = biquad(o.filter || 'bandpass', o.f ?? 1200, o.q ?? 1);
  if (o.sweepTo) flt.frequency.exponentialRampToValueAtTime(Math.max(30, o.sweepTo), t0 + (o.sweepMs ?? dec));
  const g = envGain(t0, o.g ?? 0.3, att, dec);
  let last = g;
  if (o.pan && ctx.createStereoPanner) {
    const sp = ctx.createStereoPanner();
    sp.pan.value = o.pan;
    g.connect(sp);
    last = sp;
  }
  src.connect(flt).connect(g);
  last.connect(dest);
  src.start(t0);
  src.stop(t0 + att + dec + 0.05);
}

/* ------------------------------------------- master graph / voice plumbing */

function documentSupportsLifecycleListeners() {
  return typeof document !== 'undefined' &&
    typeof document.addEventListener === 'function' &&
    typeof document.removeEventListener === 'function';
}

function disarmGestureUnlock() {
  if (!gestureListenersArmed) return;
  gestureListenersArmed = false;
  if (typeof document === 'undefined' ||
      typeof document.removeEventListener !== 'function') return;
  for (const event of GESTURE_EVENTS) {
    document.removeEventListener(event, onUnlockGesture, true);
  }
}

function armGestureUnlock() {
  if (gestureListenersArmed || !ctx || ctx.state === 'running' ||
      ctx.state === 'closed' || !documentSupportsLifecycleListeners()) return;
  gestureListenersArmed = true;
  for (const event of GESTURE_EVENTS) {
    document.addEventListener(event, onUnlockGesture, { capture: true, passive: true });
  }
}

function armLifecycleListeners() {
  if (!visibilityListenerArmed && documentSupportsLifecycleListeners()) {
    document.addEventListener('visibilitychange', onVisibilityChange, true);
    visibilityListenerArmed = true;
  }
  if (!pageShowListenerArmed && typeof window !== 'undefined' &&
      typeof window.addEventListener === 'function' &&
      typeof window.removeEventListener === 'function') {
    window.addEventListener('pageshow', onPageShow, true);
    pageShowListenerArmed = true;
  }
}

function disarmLifecycleListeners() {
  if (visibilityListenerArmed) {
    visibilityListenerArmed = false;
    if (typeof document !== 'undefined' &&
        typeof document.removeEventListener === 'function') {
      document.removeEventListener('visibilitychange', onVisibilityChange, true);
    }
  }
  if (pageShowListenerArmed) {
    pageShowListenerArmed = false;
    if (typeof window !== 'undefined' &&
        typeof window.removeEventListener === 'function') {
      window.removeEventListener('pageshow', onPageShow, true);
    }
  }
}

function audibleMasterGain() {
  return masterVolume <= 0 ? 0 : Math.max(0.025, masterVolume);
}

function queueCue(kind, replay) {
  if (!ctx || ctx.state === 'closed') return false;
  if (kind === 'footstep') {
    const stale = QUEUED_CUES.find((cue) => cue.kind === kind);
    if (stale) {
      stale.replay = replay;
      return true;
    }
  }
  // Preserve the first action that exposed the suspension. A bounded queue is
  // preferable to dumping a long backlog when a tab has been asleep.
  if (QUEUED_CUES.length >= MAX_QUEUED_CUES) return false;
  QUEUED_CUES.push({ kind, replay });
  return true;
}

function applyLastListener() {
  if (!lastListener || !ctx || ctx.state !== 'running' || !ctx.listener) return;
  const { fwd, pos } = lastListener;
  const L = ctx.listener;
  if (L.forwardX) {
    if (fwd) {
      L.forwardX.value = fwd[0]; L.forwardY.value = fwd[1]; L.forwardZ.value = fwd[2];
      L.upX.value = 0; L.upY.value = 1; L.upZ.value = 0;
    }
    if (pos) {
      L.positionX.value = pos[0]; L.positionY.value = pos[1]; L.positionZ.value = pos[2];
    }
  } else {
    if (fwd) L.setOrientation(fwd[0], fwd[1], fwd[2], 0, 1, 0);
    if (pos) L.setPosition(pos[0], pos[1], pos[2]);
  }
}

function flushQueuedCues() {
  if (flushingCues || !ctx || ctx.state !== 'running') return;
  flushingCues = true;
  try {
    applyLastListener();
    while (QUEUED_CUES.length && ctx && ctx.state === 'running') {
      const cue = QUEUED_CUES.shift();
      try { cue.replay(); } catch (_) {}
    }
  } finally {
    flushingCues = false;
  }
}

function onUnlockGesture() {
  // Context construction and resume are invoked in this event stack. Do not
  // defer either behind a promise: autoplay policies inspect the initiating
  // gesture synchronously.
  disarmGestureUnlock();
  if (ensureContext()) void resumeAudio(true);
}

function onVisibilityChange() {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
  if (ctx && ctx.state !== 'closed') void resumeAudio(true);
}

function onPageShow() {
  if (ctx && ctx.state !== 'closed') void resumeAudio(true);
}

function onAudioStateChange() {
  if (!ctx || ctx.state === 'closed') {
    disarmGestureUnlock();
  } else if (ctx.state === 'running') {
    disarmGestureUnlock();
    flushQueuedCues();
  } else {
    armGestureUnlock();
    // Output devices and browsers may interrupt a previously unlocked context.
    // A visible document gets an immediate best-effort resume; the gesture
    // listener remains armed if the platform still requires activation.
    if (typeof document === 'undefined' || document.visibilityState !== 'hidden') {
      void resumeAudio();
    }
  }
}

function ensureContext() {
  if (ctx && ctx.state !== 'closed') return true;
  const AudioContextCtor = typeof window !== 'undefined' &&
    (window.AudioContext || window.webkitAudioContext);
  if (!AudioContextCtor) return false;

  let next = null;
  try {
    next = new AudioContextCtor();
    ctx = next;
    bus = ctx.createGain();
    bus.gain.value = audibleMasterGain();
    masterLimiter = ctx.createDynamicsCompressor();
    masterLimiter.threshold.value = -12;
    masterLimiter.knee.value = 3;
    masterLimiter.ratio.value = 20;
    masterLimiter.attack.value = 0.001;
    masterLimiter.release.value = 0.11;
    bus.connect(masterLimiter).connect(ctx.destination);
    noiseBuf = makeNoiseBuffer();
    echo = buildEcho();
    ctx.addEventListener?.('statechange', onAudioStateChange);
    armLifecycleListeners();
    onAudioStateChange();
    return true;
  } catch (_) {
    disarmGestureUnlock();
    disarmLifecycleListeners();
    try { next?.removeEventListener?.('statechange', onAudioStateChange); } catch (_) {}
    try { next?.close(); } catch (_) {}
    ctx = null;
    bus = null;
    masterLimiter = null;
    noiseBuf = null;
    echo = null;
    return false;
  }
}

function resumeAudio(force = false) {
  if (!ctx || ctx.state === 'closed') return Promise.resolve(false);
  if (ctx.state === 'running') {
    disarmGestureUnlock();
    flushQueuedCues();
    return Promise.resolve(true);
  }
  armGestureUnlock();
  if (resumePromise && !force) return resumePromise;

  const activeCtx = ctx;
  let resumeResult;
  try {
    // Deliberately invoked before returning so callers inside pointer/key
    // handlers preserve their browser activation token.
    resumeResult = activeCtx.resume();
  } catch (_) {
    armGestureUnlock();
    return Promise.resolve(false);
  }

  const finish = () => {
    const running = activeCtx === ctx && activeCtx.state === 'running';
    if (running) {
      disarmGestureUnlock();
      flushQueuedCues();
    } else {
      armGestureUnlock();
    }
    return running;
  };
  const attempt = Promise.resolve(resumeResult).then(finish, finish);
  resumePromise = attempt;
  void attempt.finally(() => {
    if (resumePromise === attempt) resumePromise = null;
  });
  return attempt;
}

function readyForSound() {
  return ensureContext() && ctx.state === 'running';
}

function deferCue(kind, replay) {
  if (!ctx || ctx.state === 'closed') return;
  if (ctx.state === 'running') {
    replay();
    return;
  }
  queueCue(kind, replay);
  void resumeAudio();
}

function makeNoiseBuffer() {
  const len = ctx.sampleRate | 0;
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

// Build the persistent echo network: three parallel feedback delay taps at
// .11/.23/.31 s, each feeding a shared damped sum -> safety limiter chain.
function buildEcho() {
  const inp = ctx.createGain();
  const damp = biquad('lowpass', 4200, 0.5);
  const outG = ctx.createGain();
  const nodes = [inp, damp, outG];
  outG.gain.value = 0.55;
  damp.connect(outG);
  outG.connect(bus);
  for (const [dt, fbk] of [[0.11, 0.52], [0.23, 0.61], [0.31, 0.45]]) {
    const dl = ctx.createDelay(1);
    dl.delayTime.value = dt;
    inp.connect(dl);
    const fg = ctx.createGain();
    fg.gain.value = fbk;
    dl.connect(fg).connect(dl);          // self-feedback loop (<1 => decays)
    const tap = ctx.createGain();
    tap.gain.value = 0.25;
    dl.connect(tap).connect(damp);
    nodes.push(dl, fg, tap);
  }
  return { in: inp, nodes };
}

function scheduleCleanup(fn, delayMs) {
  const handle = setTimeout(() => {
    CLEANUP_TIMERS.delete(handle);
    fn();
  }, delayMs);
  CLEANUP_TIMERS.add(handle);
  return handle;
}

function removeEntry(list, entry) {
  const i = list.indexOf(entry);
  if (i >= 0) list.splice(i, 1);
}

function cleanupVoice(entry) {
  if (!entry || entry.closed) return;
  entry.closed = true;
  if (entry.timer != null) {
    clearTimeout(entry.timer);
    CLEANUP_TIMERS.delete(entry.timer);
  }
  for (const cleanup of entry.cleanups) {
    try { cleanup(); } catch (_) {}
  }
  try { entry.panner?.disconnect(); } catch (_) {}
  try { entry.out.disconnect(); } catch (_) {}
  removeEntry(VOICES, entry);
  removeEntry(POS, entry);
  VOICE_BY_OUT.delete(entry.out);
  for (const active of Object.values(FIRE_ACTIVE)) {
    for (let i = active.length - 1; i >= 0; i--) {
      if (active[i].out === entry.out) active.splice(i, 1);
    }
  }
  for (let i = HUMAN_ACTIVE.length - 1; i >= 0; i--) {
    if (HUMAN_ACTIVE[i].out === entry.out) HUMAN_ACTIVE.splice(i, 1);
  }
}

function pruneVoices(tnow) {
  for (const entry of [...VOICES]) {
    if (entry.until <= tnow) cleanupVoice(entry);
  }
}

function movePanner(p, pos) {
  if (p.positionX) {
    p.positionX.setValueAtTime(pos[0], ctx.currentTime);
    p.positionY.setValueAtTime(pos[1], ctx.currentTime);
    p.positionZ.setValueAtTime(pos[2], ctx.currentTime);
  } else {
    p.setPosition(pos[0], pos[1], pos[2]);
  }
}

// Callers may pass opts as a bare [x,y,z] position, an object {pos,muffled},
// or null/undefined — normalize both signals out of either shape.
function posOpt(v) {
  if (Array.isArray(v)) return v;
  if (v && Array.isArray(v.pos)) return v.pos;
  return null;
}

function copySoundOpts(v) {
  if (Array.isArray(v)) return v.slice(0, 3);
  if (!v || typeof v !== 'object') return v;
  return {
    ...v,
    pos: Array.isArray(v.pos) ? v.pos.slice(0, 3) : v.pos,
  };
}

function muffledOpt(v) {
  return !!(v && !Array.isArray(v) && v.muffled);
}

// Returns the tracked head node; synthesis layers connect into it.
function makeOut(opts, lifetimeSec) {
  const lifetime = lifetimeSec || 1.4;
  const tnow = ctx.currentTime;
  pruneVoices(tnow);
  while (VOICES.length >= MAX_VOICES) cleanupVoice(VOICES[0]);

  const head = ctx.createGain();
  let panner = null;
  let last = head;
  if (opts && opts.muffled) {
    const lp = biquad('lowpass', 480, 0.6);
    last.connect(lp);
    last = lp;
  }
  if (opts && Array.isArray(opts.pos) && ctx.createPanner) {
    while (POS.length >= MAX_POS) cleanupVoice(POS[0]);
    panner = ctx.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = 7;
    panner.maxDistance = 170;
    panner.rolloffFactor = 1.05;
    movePanner(panner, opts.pos);
    last.connect(panner);
    panner.connect(bus);
  } else {
    last.connect(bus);
  }

  const entry = {
    out: head,
    panner,
    until: tnow + lifetime + 0.5,
    timer: null,
    cleanups: [],
    closed: false,
  };
  VOICES.push(entry);
  VOICE_BY_OUT.set(head, entry);
  if (panner) POS.push(entry);
  entry.timer = scheduleCleanup(() => cleanupVoice(entry), (lifetime + 0.5) * 1000);
  return head;
}

function addVoiceCleanup(out, cleanup) {
  const entry = VOICE_BY_OUT.get(out);
  if (!entry || entry.closed) {
    try { cleanup(); } catch (_) {}
    return;
  }
  entry.cleanups.push(cleanup);
}

function makeFireOut(key, opts, lifetime) {
  const out = makeOut(opts, lifetime);
  out.gain.value = 1.16;
  const active = FIRE_ACTIVE[key];
  if (!active) return out;
  const tnow = ctx.currentTime;
  for (let i = active.length - 1; i >= 0; i--) {
    if (active[i].until <= tnow || !VOICE_BY_OUT.has(active[i].out)) active.splice(i, 1);
  }
  while (active.length >= FIRE_LIMIT[key]) {
    const oldest = active[0];
    const voice = VOICE_BY_OUT.get(oldest.out);
    if (voice) cleanupVoice(voice);
    else active.shift();
  }
  active.push({ out, until: tnow + lifetime });
  return out;
}

function makeHumanOut(opts, lifetime) {
  const tnow = ctx.currentTime;
  for (let i = HUMAN_ACTIVE.length - 1; i >= 0; i--) {
    if (HUMAN_ACTIVE[i].until <= tnow || !VOICE_BY_OUT.has(HUMAN_ACTIVE[i].out)) {
      HUMAN_ACTIVE.splice(i, 1);
    }
  }
  while (HUMAN_ACTIVE.length >= MAX_HUMAN_VOICES) {
    const oldest = HUMAN_ACTIVE[0];
    const voice = VOICE_BY_OUT.get(oldest.out);
    if (voice) cleanupVoice(voice);
    else HUMAN_ACTIVE.shift();
  }
  const out = makeOut(opts, lifetime);
  HUMAN_ACTIVE.push({ out, until: tnow + lifetime });
  return out;
}

// A pitched source is split across resonant vocal bands. Two differently
// shaped bursts create glottal grit without samples or long-lived nodes.
function vocalBurst(out, {
  t0, type, f0, f1, duration, gain, formants,
}) {
  const attack = Math.min(0.035, duration * 0.12);
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(Math.max(45, f0), t0);
  osc.frequency.exponentialRampToValueAtTime(Math.max(40, f1), t0 + duration);

  const throat = biquad('lowpass', rnd(2600, 3900), 0.8);
  const envelope = envGain(t0, gain, attack, duration);
  const nodes = [osc, throat, envelope];
  osc.connect(throat);
  for (let i = 0; i < formants.length; i++) {
    const band = biquad('bandpass', formants[i] * rnd(0.94, 1.06), 4.5 + i * 1.2);
    const weight = ctx.createGain();
    weight.gain.value = [1, 0.72, 0.46][i] || 0.35;
    throat.connect(band).connect(weight).connect(envelope);
    nodes.push(band, weight);
  }
  envelope.connect(out);
  osc.start(t0);
  osc.stop(t0 + attack + duration + 0.04);
  addVoiceCleanup(out, () => {
    try { osc.stop(); } catch (_) {}
    for (const node of nodes) {
      try { node.disconnect(); } catch (_) {}
    }
  });
}

function synthPainVoice(out, {
  damage = 0, headshot = false, lethal = false, self = false,
} = {}) {
  const heavy = lethal || damage >= 35;
  const duration = lethal ? rnd(0.86, 1.08)
    : headshot ? rnd(0.58, 0.76)
      : heavy ? rnd(0.52, 0.7) : rnd(0.28, 0.42);
  const t0 = nowT();
  const base = headshot ? rnd(235, 285) : heavy ? rnd(145, 185) : rnd(185, 225);
  const end = lethal ? rnd(62, 82) : heavy ? rnd(82, 108) : rnd(115, 145);
  const level = self ? 0.42 : lethal ? 0.36 : heavy ? 0.3 : 0.23;
  const formants = headshot
    ? [rnd(710, 820), rnd(1450, 1680), rnd(2480, 2820)]
    : [rnd(520, 680), rnd(1080, 1370), rnd(2180, 2580)];

  vocalBurst(out, {
    t0, type: lethal || heavy ? 'sawtooth' : 'triangle',
    f0: base, f1: end, duration: duration * 0.72,
    gain: level, formants,
  });
  vocalBurst(out, {
    t0: t0 + duration * (lethal ? 0.3 : 0.24),
    type: lethal || headshot ? 'sawtooth' : 'triangle',
    f0: base * rnd(0.88, 1.08), f1: end * rnd(0.82, 1),
    duration: duration * 0.68, gain: level * 0.7,
    formants: formants.map((f) => f * rnd(0.95, 1.08)),
  });
  hiss(out, {
    t0: t0 + duration * 0.08,
    filter: 'bandpass', f: headshot ? 1950 : 1280, q: 1.1,
    sweepTo: lethal ? 520 : 760, sweepMs: duration * 0.75,
    rate: rnd(0.78, 1.16), att: 0.008, dec: duration * 0.72,
    g: level * (self ? 0.72 : 0.5),
  });
  return { t0, duration };
}

function bodyImpact(out, t0, gain = 1) {
  hiss(out, {
    t0, filter: 'lowpass', f: 310, q: 0.65,
    sweepTo: 95, sweepMs: 0.16, dec: 0.22, g: 0.72 * gain,
  });
  tone(out, {
    t0, type: 'sine', f0: 78, f1: 34,
    att: 0.001, dec: 0.24, g: 0.48 * gain,
  });
  hiss(out, {
    t0: t0 + 0.018, filter: 'bandpass', f: 1050, q: 5,
    dec: 0.028, g: 0.2 * gain,
  });
}

/* ------------------------------------------------------------ gun profiles */

function shotRifleSmg(out, P) {
  tone(out, { type: P.blipType, f0: P.blipF0, f1: P.blipF1, dec: P.blipMs / 1000, g: 0.26 });
  hiss(out, { filter: P.nzFilter, f: P.nzF, q: P.nzQ, dec: P.nzMs / 1000, g: 0.5 });
  const sat = shaper(P.drive);
  sat.connect(out);
  tone(sat, { type: 'sine', f0: P.subHz, f1: P.subHz * 0.72, dec: P.subMs / 1000, g: P.subG, att: 0.001 });
}

function shotShotgun(out) {
  hiss(out, { filter: 'lowpass', f: 900, sweepTo: 200, sweepMs: 0.22, dec: 0.22, g: 0.9 });
  tone(out, { type: 'sine', f0: 45, f1: 34, dec: 0.26, g: 0.5, att: 0.001 });
  tone(out, { type: 'sine', f0: 60, f1: 44, dec: 0.22, g: 0.36, detune: 9, att: 0.001 });
  // Pump action is integral to the sound — always auto-chained.
  hiss(out, { t0: nowT(0.38), filter: 'bandpass', f: 2600, q: 6, dec: 0.02, g: 0.42 });
  hiss(out, { t0: nowT(0.455), filter: 'bandpass', f: 2100, q: 6, dec: 0.02, g: 0.36 });
}

function boltClack(out, t0, k) {
  hiss(out, { t0, filter: 'bandpass', f: 3100 * k, q: 5, dec: 0.015, g: 0.4 });
  tone(out, { t0, type: 'square', f0: 1150 * k, f1: 700 * k, dec: 0.012, g: 0.14 });
}

function sendEcho(out, gain) {
  if (!echo) return;
  const send = ctx.createGain();
  send.gain.value = gain;
  out.connect(send).connect(echo.in);
  addVoiceCleanup(out, () => send.disconnect());
}

function shotSniper(out) {
  hiss(out, { filter: 'highpass', f: 6000, dec: 0.03, g: 0.6 });             // crack
  tone(out, { type: 'sawtooth', f0: 180, f1: 70, dec: 0.2, g: 0.3 });        // mid body
  tone(out, { type: 'sine', f0: 38, f1: 30, dec: 0.42, g: 0.55, att: 0.001 }); // deep sub
  sendEcho(out, 0.5);                                                        // canyon tail
  const k = WEP_TONE.sniper;
  boltClack(out, nowT(0.7), k);                                               // bolt cycle sequence
  boltClack(out, nowT(0.82), k);
}

function shotLmg(out) {
  // Four fixed layers: a broad piston-like report with a short feed-tray snap.
  hiss(out, { filter: 'bandpass', f: 1350, q: 0.75, sweepTo: 430, sweepMs: 0.1, dec: 0.11, g: 0.58 });
  tone(out, { type: 'square', f0: 98, f1: 43, dec: 0.11, g: 0.3 });
  tone(out, { type: 'sine', f0: 43, f1: 31, dec: 0.18, g: 0.48, att: 0.001 });
  hiss(out, { t0: nowT(0.055), filter: 'bandpass', f: 2350, q: 6, dec: 0.018, g: 0.24 });
}

function shotRevolver(out) {
  // Four fixed layers: sharp muzzle crack, resonant chamber body, and hammer tick.
  hiss(out, { filter: 'highpass', f: 5200, q: 0.65, dec: 0.045, g: 0.68 });
  tone(out, { type: 'sawtooth', f0: 270, f1: 92, dec: 0.15, g: 0.31 });
  tone(out, { type: 'sine', f0: 58, f1: 41, dec: 0.21, g: 0.36, att: 0.001 });
  tone(out, { t0: nowT(0.055), type: 'square', f0: 1850, f1: 880, dec: 0.018, g: 0.13 });
}

function reloadLmg(out, step, t0, k) {
  if (step === 1) {
    hiss(out, { t0, filter: 'lowpass', f: 520, q: 0.7, dec: 0.13, g: 0.5 });
    tone(out, { t0: t0 + 0.1, type: 'sine', f0: 86, f1: 45, dec: 0.075, g: 0.55 });
  } else if (step === 2) {
    tone(out, { t0, type: 'sine', f0: 78, f1: 39, dec: 0.085, g: 0.62 });
    tone(out, { t0: t0 + 0.095, type: 'sine', f0: 66, f1: 36, dec: 0.07, g: 0.52 });
    hiss(out, { t0: t0 + 0.16, filter: 'bandpass', f: 1050 * k, q: 5, dec: 0.025, g: 0.24 });
  } else if (step === 3) {
    hiss(out, { t0, filter: 'bandpass', f: 1250 * k, q: 1.5, dec: 0.14, g: 0.58 });
    tone(out, { t0: t0 + 0.115, type: 'square', f0: 540, f1: 290, dec: 0.025, g: 0.28 });
  }
}

function reloadRevolver(out, step, t0, k) {
  if (step === 1) {
    tone(out, { t0, type: 'triangle', f0: 1250 * k, f1: 720 * k, dec: 0.04, g: 0.22 });
    hiss(out, { t0: t0 + 0.04, filter: 'highpass', f: 3200, q: 2, dec: 0.035, g: 0.2 });
  } else if (step === 2) {
    // Three chambers imply a cylinder load without spawning an unbounded loop.
    for (let i = 0; i < 3; i++) {
      tone(out, { t0: t0 + i * 0.055, type: 'sine', f0: 1420 * k, f1: 980 * k, dec: 0.022, g: 0.17 });
    }
  } else if (step === 3) {
    hiss(out, { t0, filter: 'bandpass', f: 2600 * k, q: 5, dec: 0.025, g: 0.28 });
    tone(out, { t0: t0 + 0.045, type: 'square', f0: 1780 * k, f1: 760 * k, dec: 0.026, g: 0.2 });
  }
}

/* ---------------------------------------------------------------- impacts */

function impactGlass(out, v) {
  const P = IMPACT_PARAMS.glass;
  const t0 = nowT();
  for (let i = 0; i < P.sparkles; i++) {
    const f = rnd(P.fMin, P.fMax);
    tone(out, {
      t0: t0 + i * 0.019 + rnd(0, 0.008),
      type: 'sine', f0: f, f1: f * 0.93,
      att: 0.002, dec: (P.lifeMs / 1000) * (1 - i * 0.09), g: P.g * v,
    });
  }
  hiss(out, { t0, filter: 'highpass', f: 6500, q: 0.5, dec: 0.16, g: 0.1 * v });
}

function impactMetal(out, v) {
  const P = IMPACT_PARAMS.metal;
  const t0 = nowT();
  hiss(out, { t0, filter: 'highpass', f: 3200, dec: P.strikeMs / 1000, g: P.strikeG * v });
  P.partials.forEach((f, i) => {
    tone(out, { t0, type: 'sine', f0: f, att: 0.002, dec: P.ringMs / 1000, g: P.g * (1 - i * 0.16) * v, detune: rnd(-4, 4) });
  });
}

/* ------------------------------------------------------------------- sfx */

export const sfx = {
  // These methods remain promise-compatible, but context construction and the
  // resume() call both happen before returning to the initiating event.
  init() {
    if (!ensureContext()) return Promise.resolve(this);
    return resumeAudio().then(() => this);
  },

  unlock() {
    if (!ensureContext()) return Promise.resolve(false);
    return resumeAudio();
  },

  async dispose() {
    disarmGestureUnlock();
    disarmLifecycleListeners();
    const activeCtx = ctx;
    try { activeCtx?.removeEventListener?.('statechange', onAudioStateChange); } catch (_) {}

    QUEUED_CUES.length = 0;
    for (const entry of [...VOICES]) cleanupVoice(entry);
    for (const handle of CLEANUP_TIMERS) clearTimeout(handle);
    CLEANUP_TIMERS.clear();
    POS.length = 0;
    VOICES.length = 0;
    HUMAN_ACTIVE.length = 0;
    VOICE_BY_OUT.clear();
    for (const entries of Object.values(FIRE_ACTIVE)) entries.length = 0;

    for (const node of echo?.nodes || []) {
      try { node.disconnect(); } catch (_) {}
    }
    try { masterLimiter?.disconnect(); } catch (_) {}
    try { bus?.disconnect(); } catch (_) {}

    ctx = null;
    bus = null;
    masterLimiter = null;
    noiseBuf = null;
    echo = null;
    resumePromise = null;
    lastListener = null;
    flushingCues = false;
    panSide = 1;

    if (activeCtx && activeCtx.state !== 'closed') {
      try { await activeCtx.close(); } catch (_) {}
    }
  },

  setMasterVolume(value) {
    const next = Number(value);
    if (Number.isFinite(next)) masterVolume = Math.min(1, Math.max(0, next));
    if (bus && ctx && ctx.state !== 'closed') {
      bus.gain.cancelScheduledValues(ctx.currentTime);
      bus.gain.setValueAtTime(audibleMasterGain(), ctx.currentTime);
    }
  },

  // key: rifle|smg|shotgun|sniper|lmg|revolver
  // opts: {muffled?:bool, pos?:[x,y,z]}
  fire(key, opts) {
    if (!readyForSound()) {
      const deferredOpts = copySoundOpts(opts);
      deferCue('fire', () => sfx.fire(key, deferredOpts));
      return;
    }
    const lifetime = key === 'sniper' ? 1.3 : key === 'revolver' ? 0.75 : 0.8;
    const outOpts = { pos: posOpt(opts), muffled: muffledOpt(opts) };
    const out = makeFireOut(key, outOpts, lifetime);
    if (key === 'shotgun') shotShotgun(out);
    else if (key === 'sniper') shotSniper(out);
    else if (key === 'lmg') shotLmg(out);
    else if (key === 'revolver') shotRevolver(out);
    else shotRifleSmg(out, FIRE_PARAMS[key] || FIRE_PARAMS.rifle);
  },

  // kind: stone|wood|glass|metal|flesh ; vol 0..1 ; opts: {pos?}
  impact(kind, vol = 1, opts) {
    if (!readyForSound()) {
      const deferredOpts = copySoundOpts(opts);
      deferCue('impact', () => sfx.impact(kind, vol, deferredOpts));
      return;
    }
    let v = Math.min(1, Math.max(0, vol));
    const P = IMPACT_PARAMS[kind];
    if (!P) return;
    if (P.cap) v = Math.min(v, P.cap);
    const out = makeOut({ pos: posOpt(opts), muffled: muffledOpt(opts) }, kind === 'glass' ? 0.6 : 0.5);
    out.gain.value = 1.14;
    const t0 = nowT();
    if (kind === 'glass') impactGlass(out, v);
    else if (kind === 'metal') impactMetal(out, v);
    else {
      hiss(out, { t0, filter: P.nzFilter, f: P.nzF, q: P.nzQ, dec: P.ms / 1000, g: P.g * v });
      if (P.knock) {
        tone(out, { t0, type: P.knock.type, f0: P.knock.f, f1: P.knock.f * 0.82, dec: P.knock.ms / 1000, g: P.knock.g * v });
      }
    }
  },

  // step 1 mag/cylinder out · 2 insert/load · 3 rack/close
  reloadClick(step, wkey) {
    if (!readyForSound()) {
      deferCue('reload', () => sfx.reloadClick(step, wkey));
      return;
    }
    const k = WEP_TONE[wkey] || 1;
    const out = makeOut(null, 0.45);
    const t0 = nowT();
    if (wkey === 'lmg') {
      reloadLmg(out, step, t0, k);
    } else if (wkey === 'revolver') {
      reloadRevolver(out, step, t0, k);
    } else if (step === 1) {
      hiss(out, { t0, filter: 'lowpass', f: 800 * k, q: 0.8, dec: 0.075, g: 0.38 });
      tone(out, { t0: t0 + 0.065, type: 'square', f0: 1450 * k, dec: 0.012, g: 0.2 });
    } else if (step === 2) {
      tone(out, { t0, type: 'sine', f0: 118, f1: 62, dec: 0.05, g: 0.5, att: 0.002 });
      tone(out, { t0: t0 + 0.06, type: 'sine', f0: 96, f1: 54, dec: 0.05, g: 0.4, att: 0.002 });
      hiss(out, { t0: t0 + 0.105, filter: 'bandpass', f: 1250 * k, q: 4, dec: 0.014, g: 0.18 });
    } else if (step === 3) {
      hiss(out, { t0, filter: 'highpass', f: 1500 * k, q: 0.7, dec: 0.095, g: 0.55 });
      tone(out, { t0: t0 + 0.01, type: 'sine', f0: 1900 * k, detune: 6, dec: 0.07, g: 0.22 });
      tone(out, { t0: t0 + 0.085, type: 'square', f0: 820, dec: 0.012, g: 0.25 });
    }
  },

  hitmark(hs) {
    if (!readyForSound()) {
      deferCue('hitmark', () => sfx.hitmark(hs));
      return;
    }
    const out = makeOut(null, 0.4);
    const t0 = nowT();
    // Short, upper-mid transient stays legible under a gun report; summed peak
    // remains below unity before the master safety compressor.
    hiss(out, { t0, filter: 'highpass', f: 4800, q: 0.7, dec: 0.018, g: 0.12 });
    tone(out, { t0, type: 'square', f0: 1760, f1: 1420, att: 0.001, dec: 0.04, g: 0.2 });
    if (hs) {
      tone(out, { t0: t0 + 0.012, type: 'sine', f0: 2489.02, att: 0.002, dec: 0.045, g: 0.14 });
      tone(out, { t0: t0 + 0.025, type: 'sine', f0: 987.77, att: 0.005, dec: 0.1, g: 0.12 });
      tone(out, { t0: t0 + 0.095, type: 'sine', f0: 1567.98, att: 0.005, dec: 0.13, g: 0.11 });
    }
  },

  pain({ damage = 0, headshot = false, lethal = false, pos, local = false } = {}) {
    if (!readyForSound()) {
      const deferredPos = Array.isArray(pos) ? pos.slice(0, 3) : pos;
      deferCue('pain', () => sfx.pain({
        damage, headshot, lethal, pos: deferredPos, local,
      }));
      return;
    }
    const numericDamage = Number(damage);
    const hitDamage = Number.isFinite(numericDamage)
      ? Math.min(100, Math.max(0, numericDamage)) : 0;
    const isHeadshot = !!headshot;
    const isLethal = !!lethal;
    const isLocal = !!local;
    const lifetime = isLethal ? 1.45 : isHeadshot ? 1.05 : hitDamage >= 35 ? 0.95 : 0.7;
    const out = makeHumanOut({
      pos: isLocal ? null : posOpt(pos),
    }, lifetime);
    out.gain.value = isLocal ? 0.96 : 0.82;
    synthPainVoice(out, {
      damage: hitDamage,
      headshot: isHeadshot,
      lethal: isLethal,
      self: false,
    });
  },

  deathSelf({ headshot = false } = {}) {
    if (!readyForSound()) {
      deferCue('deathSelf', () => sfx.deathSelf({ headshot }));
      return;
    }
    const out = makeHumanOut(null, 1.75);
    out.gain.value = 0.94;
    const voice = synthPainVoice(out, {
      damage: 100, headshot: !!headshot, lethal: true, self: true,
    });
    bodyImpact(out, voice.t0 + Math.min(0.82, voice.duration * 0.72), 0.95);
    if (headshot) {
      hiss(out, {
        t0: voice.t0, filter: 'highpass', f: 3600, q: 0.8,
        dec: 0.035, g: 0.28,
      });
    }
  },

  deathFar(vol = 0.4) {
    if (!readyForSound()) {
      deferCue('deathFar', () => sfx.deathFar(vol));
      return;
    }
    const out = makeOut({ muffled: true }, 0.9);
    const t0 = nowT();
    hiss(out, { t0, filter: 'bandpass', f: 420, q: 0.5, dec: 0.1, g: 0.5 * vol });
    tone(out, { t0, type: 'sine', f0: 84, f1: 38, dec: 0.17, g: 0.22 * vol, att: 0.002 });
    sendEcho(out, 0.18);
  },

  footstep(vol = 0.45) {
    if (!readyForSound()) {
      deferCue('footstep', () => sfx.footstep(vol));
      return;
    }
    panSide = -panSide;
    hiss(makeOut(null, 0.25), {
      filter: 'lowpass', f: 320, q: 0.5,
      rate: rnd(0.85, 1.13),
      dec: 0.08, g: 0.26 * vol, pan: 0.4 * panSide,
    });
  },

  draw(wkey) {
    if (!readyForSound()) {
      deferCue('draw', () => sfx.draw(wkey));
      return;
    }
    const D = DRAW_LEN[wkey] || 0.11;
    const out = makeOut(null, D + 0.3);
    const t0 = nowT();
    if (wkey === 'lmg') {
      hiss(out, { t0, filter: 'lowpass', f: 430, q: 0.7, dec: D * 0.75, g: 0.34 });
      tone(out, { t0: t0 + D * 0.55, type: 'sine', f0: 92, f1: 48, dec: 0.07, g: 0.3 });
      hiss(out, { t0: t0 + D * 0.82, filter: 'bandpass', f: 1200, q: 5, dec: 0.032, g: 0.24 });
    } else if (wkey === 'revolver') {
      hiss(out, { t0, filter: 'bandpass', f: 1450, q: 1.1, dec: D * 0.65, g: 0.18 });
      tone(out, { t0: t0 + D * 0.45, type: 'triangle', f0: 1320, f1: 820, dec: 0.03, g: 0.16 });
      tone(out, { t0: t0 + D * 0.82, type: 'square', f0: 2050, f1: 980, dec: 0.018, g: 0.12 });
    } else {
      hiss(out, { t0, filter: 'bandpass', f: 780, q: 0.8, dec: D * 0.6, g: 0.22 });
      hiss(out, { t0: t0 + D * 0.35, filter: 'bandpass', f: 900, q: 0.7, dec: D * 0.5, g: 0.13 });
      tone(out, { t0: t0 + D * 0.75, type: 'triangle', f0: 240, dec: 0.015, g: 0.12 });
    }
  },

  bulletWhiz(vol = 0.5) {
    if (!readyForSound()) {
      deferCue('bulletWhiz', () => sfx.bulletWhiz(vol));
      return;
    }
    hiss(makeOut(null, 0.4), {
      filter: 'bandpass', f: 3000, sweepTo: 1400, sweepMs: 0.16, q: 5,
      dec: 0.16, g: 0.32 * vol, pan: (Math.random() < 0.5 ? -1 : 1) * rnd(0.6, 0.95),
    });
  },

  setListener({ fwd, pos } = {}) {
    lastListener = {
      fwd: Array.isArray(fwd) ? fwd.slice(0, 3) : null,
      pos: Array.isArray(pos) ? pos.slice(0, 3) : null,
    };
    applyLastListener();
  },
};
