import assert from 'node:assert/strict';
import { sfx } from '../public/js/audio/sfx.js';
import { BUILTIN_SAMPLE_MANIFEST } from '../public/js/audio/samples.js';

class Element {
  constructor(tagName = 'div') {
    this.tagName = tagName;
    this.children = [];
    this.listeners = new Map();
    this.attributes = new Map();
    this.textContent = '';
    this.value = '0.5';
    this.dataset = {};
  }
  addEventListener(type, fn) {
    const callbacks = this.listeners.get(type) || [];
    callbacks.push(fn);
    this.listeners.set(type, callbacks);
  }
  async dispatch(type, event = {}) {
    await Promise.all((this.listeners.get(type) || []).map((fn) => fn({
      target: this, preventDefault() {}, ...event,
    })));
  }
  append(...children) { this.children.push(...children); }
  setAttribute(name, value) { this.attributes.set(name, value); }
  setPointerCapture() {}
  pause() { this.paused = true; }
  getContext() { return { beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fillRect() {} }; }
}

const elements = [];
const ids = new Map();
const document = new Element();
document.getElementById = (id) => {
  if (!ids.has(id)) { const element = new Element(); element.id = id; ids.set(id, element); }
  return ids.get(id);
};
document.createElement = (tag) => { const element = new Element(tag); elements.push(element); return element; };
document.querySelectorAll = (selector) => elements.filter((element) =>
  selector === '[aria-pressed]' ? element.attributes.has('aria-pressed') : element.tagName === selector);
document.documentElement = new Element();
const timers = new Map();
const calls = [];
let timerId = 0;
let finishLoading;
const loadPromise = new Promise((resolve) => { finishLoading = resolve; });
const previousSfx = { ...sfx };
const globals = {
  document,
  window: new Element(),
  OfflineAudioContext: class {
    async decodeAudioData() {
      return { getChannelData: () => new Float32Array([0, 0.2, -0.1, 0]), duration: 0.5, sampleRate: 48000 };
    }
  },
  fetch: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) }),
  setTimeout: (fn) => { const id = ++timerId; timers.set(id, fn); return id; },
  clearTimeout: (id) => timers.delete(id),
};
const savedGlobals = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) {
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
Object.assign(sfx, {
  unlock: async () => true,
  loadSamples: () => loadPromise,
  setMasterVolume() {}, setListener() {}, minigunMotor() {},
  painMoan: (level) => calls.push(`moan:${level}`),
  stopPainMoans: () => calls.push('stop-moans'),
  grenadePin: () => calls.push('pin'),
  hitmark: (headshot) => calls.push(`hit:${headshot}`),
  killConfirm: (headshot) => calls.push(`kill:${headshot}`),
  fire: (weapon) => calls.push(weapon),
  stopFlame: () => calls.push('fade'),
  stopFlames: () => { throw new Error('Preview release must fade, not dispose the flame graph.'); },
});
const findButton = (label) => elements.find((element) => element.tagName === 'button' && element.textContent === label);

try {
  await import('../public/js/capture/audio-preview.js');
  const pin = findButton('Pull pin');
  const pending = pin.dispatch('click');
  await Promise.resolve();
  await document.getElementById('stop-loops').dispatch('click');
  finishLoading({ loaded: Object.keys(BUILTIN_SAMPLE_MANIFEST).length, failed: 0 });
  await pending;
  assert.ok(!calls.includes('pin'), 'Stop during loading cancels the pending runtime cue');
  assert.equal(document.getElementById('status').textContent, 'Loops stopped.');
  await pin.dispatch('click');
  assert.equal(calls.at(-1), 'pin', 'a fresh click after Stop can play normally');
  await findButton('Body hit').dispatch('click');
  assert.equal(calls.at(-1), 'hit:false');
  await findButton('Headshot kill').dispatch('click');
  assert.deepEqual(calls.slice(-2), ['hit:true', 'kill:true'], 'preview reproduces real lethal-hit overlap');

  const hold = findButton('Hold flame');
  await hold.dispatch('pointerdown', { button: 0, pointerId: 1 });
  for (let i = 0; i < 4; i++) await Promise.resolve();
  assert.equal(calls.at(-1), 'flamethrower');
  assert.equal(timers.size, 1, 'held flame refreshes on one pending timer');
  await hold.dispatch('pointerup');
  assert.ok(calls.slice(-2).includes('fade'), 'releasing a held flame uses the game release envelope');
  assert.equal(timers.size, 0, 'release cancels further source refreshes');
  assert.equal(hold.attributes.get('aria-pressed'), 'false');

  await findButton('Two-second flame').dispatch('click');
  assert.equal(calls.at(-1), 'flamethrower');
  await elements.find((element) => element.tagName === 'audio').dispatch('play');
  assert.ok(calls.slice(-2).includes('fade'), 'isolated sample playback fades the live flame');
  assert.equal(timers.size, 0, 'isolated playback cancels the timed demonstration');
  await globals.window.dispatch('blur');
  assert.ok(calls.slice(-2).includes('fade'), 'window blur also uses the release envelope');
  await findButton('Severe pain: 20 seconds').dispatch('click');
  assert.equal(calls.at(-1), 'moan:1', 'pain preview uses the real pain level interface');
  assert.equal(timers.size, 1, 'pain preview has a single bounded update timer');
  await document.getElementById('stop-loops').dispatch('click');
  assert.equal(calls.at(-1), 'stop-moans');
  assert.equal(timers.size, 0, 'Stop cancels the cadence and current moan');
} finally {
  Object.assign(sfx, previousSfx);
  for (const [key, descriptor] of savedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
}
console.log('Audio preview: loading cancellation, fresh playback, held release, sample handoff and blur fade passed.');
