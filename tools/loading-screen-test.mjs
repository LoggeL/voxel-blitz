import assert from 'node:assert/strict';
import { buildInitialMesh } from '../public/js/engine/initial-mesh.js';
import { LoadingScreen } from '../public/js/ui/loading-screen.js';
import { PregameFlow } from '../public/js/session/pregame.js';

// Completed sectors, yielding and cancellation use actual work, not elapsed time.
let now = 0, yielded = 0;
const built = [], progress = [];
const store = { width: 4, depth: 3, rebuildChunk(x, z) { built.push([x, z]); now += 5; } };
assert.equal(await buildInitialMesh(store, { now: () => now,
  yieldControl: async () => { yielded++; }, onProgress: (...p) => progress.push(p) }), true);
assert.equal(built.length, 12);
assert.equal(new Set(built.map(p => p.join(','))).size, 12);
assert.deepEqual(progress[0], [0, 12]);
assert.deepEqual(progress.at(-1), [12, 12]);
assert.ok(yielded > 1, 'large builds yield between batches');
let active = true, cancelledBuilds = 0;
assert.equal(await buildInitialMesh({ width: 8, depth: 8, rebuildChunk() { cancelledBuilds++; now += 10; } },
  { now: () => now, isActive: () => active, yieldControl: async () => { if (cancelledBuilds) active = false; } }), false);
assert.equal(cancelledBuilds, 1, 'no geometry is recreated after cancellation/disposal');
assert.equal(await buildInitialMesh({ width: 1, depth: 1, rebuildChunk() { throw Error('stale boot'); } },
  { isActive: () => false, yieldControl: async () => {} }), false);

class Element {
  constructor() { this.attrs = new Map(); this.listeners = {}; this.style = { setProperty() {}, removeProperty() {} }; }
  setAttribute(k, v) { this.attrs.set(k, v); }
  removeAttribute(k) { this.attrs.delete(k); if (k === 'value') delete this.value; }
  addEventListener(k, fn) { this.listeners[k] = fn; }
  showModal() { this.open = true; }
  close() { this.open = false; }
}
const children = new Map();
const root = new Element(); root.dataset = {}; root.open = true;
root.ownerDocument = { baseURI: 'http://example.test/' };
let backdrop = ''; root.style.setProperty = (key, value) => { backdrop = value; };
root.querySelector = key => { if (!children.has(key)) children.set(key, new Element()); return children.get(key); };
const loading = new LoadingScreen(root);
loading.show('boot');
assert.equal(root.open, true);
assert.equal(loading.action.hidden, true);
assert.equal(loading.progress.value, undefined, 'unknown network progress is indeterminate');
let cancels = 0;
loading.show('connect', { onCancel: () => cancels++ });
root.listeners.cancel({ preventDefault() {} });
loading.action.listeners.click();
assert.equal(cancels, 2, 'keyboard and pointer cancellation reach the same callback');
loading.advance(3, 12); assert.equal(loading.progress.value, .25);
loading.advance(99, 12); assert.equal(loading.progress.value, 1);
loading.hide(); assert.equal(root.open, false); assert.equal(loading.onCancel, null);
loading.show('connect'); assert.equal(loading.progress.value, undefined, 'a new attempt clears stale progress');
loading.show('arena', { image: './assets/maps/killhouse-range.webp' });
assert.equal(backdrop, 'url("http://example.test/assets/maps/killhouse-range.webp")', 'map artwork resolves against the page, not the CSS directory');
loading.fail('Test error'); assert.equal(root.dataset.stage, 'error'); assert.equal(loading.action.hidden, false);

// Late async network completions cannot reopen the loader or start a cancelled boot.
let phase = 'menu', booted = 0, resolveConnect;
const net = { on() { return () => {}; }, close() {}, connect() { return new Promise(resolve => { resolveConnect = resolve; }); } };
const flow = new PregameFlow({ loading, hud: { showJoinState() {}, showLobbyStatus() {}, showLobby() {} }, makeNet: () => net,
  getPhase: () => phase, setPhase: value => { phase = value; }, isTornDown: () => false,
  unlockAudio: async () => {}, connectUrl: () => 'ws://test', closeNet() {}, writeName() {},
  enterMenu() { phase = 'menu'; flow.resetAttempt(); loading.hide(); }, detachGameplay() {},
  enterLive() { booted++; }, cancelBoot() { phase = 'menu'; flow.resetAttempt(); loading.hide(); } });
flow.replaceNet();
const pending = flow.begin({ mode: 'quick' });
await Promise.resolve();
assert.equal(root.dataset.stage, 'connect');
loading.onCancel();
resolveConnect({ phase: 'live', map: 'foundry' }); await pending;
assert.equal(root.open, false); assert.equal(booted, 0);
const next = flow.begin({ mode: 'create', gameMode: 'training', map: 'killhouse' });
await Promise.resolve();
resolveConnect({ phase: 'waiting', map: 'killhouse', gameMode: 'training' }); await next;
flow._handleLobbyState(net, { phase: 'waiting', code: 'TEST' });
assert.equal(root.open, false, 'the waiting lobby remains interactive');
flow.attempt.mapBytes = new Uint8Array(1);
flow._handleLobbyState(net, { phase: 'live' });
assert.equal(root.dataset.stage, 'arena'); assert.equal(booted, 1);
loading.onCancel(); assert.equal(root.open, false);
console.log('ok - loading progress, modal lifecycle, keyboard cancel, stale admission, waiting lobby and arena cancellation');
