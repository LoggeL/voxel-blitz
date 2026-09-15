import assert from 'node:assert/strict';
import { buildInitialMesh } from '../public/js/engine/initial-mesh.js';
import { LoadingScreen } from '../public/js/ui/loading-screen.js';
import { PregameFlow } from '../public/js/session/pregame.js';
import { AssetScheduler } from '../public/js/boot/asset-scheduler.js';

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

// Startup stages: weighted real progress, activation completes earlier stages,
// and a new screen clears the plan so admission starts indeterminate again.
loading.show('boot');
loading.setPlan([{ id: 'modules', label: 'GAME SYSTEMS', weight: 25 }, { id: 'models', label: 'MODELS', weight: 55 },
  { id: 'account', label: 'ACCOUNT', weight: 20 }], { startedAt: 1000 });
assert.equal(loading.progress.value, 0, 'a declared plan starts at zero, not indeterminate');
assert.equal(loading.step('modules', { status: 'active', done: 133, total: 266, detail: '133 / 266 MODULES' }), true);
assert.equal(loading.progress.value, 0.125);
assert.equal(loading.count.textContent, '133 / 266 MODULES', 'the active stage owns the counter');
loading.step('models', { status: 'active', done: 25, total: 100 });
assert.equal(loading.progress.value, 0.25 + 0.55 * 0.25, 'activating a later stage completes the earlier one');
loading.step('models', { done: 100, total: 100 });
loading.step('account', { status: 'done' });
assert.equal(loading.progress.value, 1);
assert.equal(loading.step('unknown', { status: 'done' }), false, 'unknown stages are ignored');
assert.equal(loading.elapsedMs(1500), 500);
loading.show('connect');
assert.equal(loading.progress.value, undefined, 'admission has no declared plan');
assert.equal(loading.plan.length, 0);
loading.advance(6, 12); assert.equal(loading.progress.value, .5, 'sector progress still works without a plan');

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

// Background asset scheduler: tasks load one at a time in definition order,
// require() promotes exactly what a match needs and mirrors the outstanding
// tasks as stages of the arena screen, failures retry on the next request.
{
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  const gates = {};
  const gate = (id) => new Promise((resolve, reject) => { gates[id] = { resolve, reject }; });
  let clock = 0;
  const changes = [];
  const scheduler = new AssetScheduler({ now: () => clock, warn() {}, onChange: (status) => changes.push(status.active?.id || null) });
  for (const id of ['models', 'runtime', 'audio', 'art']) {
    scheduler.define(id, { label: id.toUpperCase(), weight: id === 'models' ? 3 : 1,
      load: (report) => { report({ detail: `${id} started` }); return gate(id); } });
  }
  assert.throws(() => scheduler.define('models', { load: () => {} }), /already defined/);
  assert.deepEqual(scheduler.outstanding(['models', 'audio']), ['models', 'audio']);
  assert.equal(scheduler.status.idle, false);
  const background = scheduler.startAll();
  assert.equal(scheduler.startAll(), background, 'the background queue starts once');
  await tick();
  assert.equal(scheduler.status.active.id, 'models');
  assert.equal(scheduler.status.tasks.runtime, 'pending', 'the background queue loads one task at a time');
  assert.equal(scheduler.status.active.detail, 'models started');

  loading.show('arena');
  const required = scheduler.require(['models', 'audio'], { loading, trailing: [{ id: 'world', label: 'ARENA GEOMETRY', weight: 1 }] });
  await tick();
  assert.deepEqual(loading.plan.map(step => step.id), ['models', 'audio', 'world'], 'only outstanding assets become stages, then the sectors');
  assert.equal(loading.plan[0].status, 'active');
  assert.equal(loading.count.textContent, 'models started', 'task detail reaches the active stage');
  assert.equal(scheduler.status.tasks.audio, 'pending', 'required tasks wait for each other in order');
  clock = 120;
  gates.models.resolve('templates');
  await tick();
  assert.equal(loading.plan[0].status, 'done');
  assert.equal(scheduler.status.tasks.audio, 'active', 'require() promotes a task ahead of the background queue');
  assert.equal(scheduler.status.tasks.runtime, 'active', 'the background queue moved on to the next task');
  assert.equal(scheduler.status.timings.models, 120);
  gates.audio.resolve('bank');
  await tick();
  assert.deepEqual(await required, { models: 'templates', audio: 'bank' });
  assert.equal(loading.plan[1].status, 'done');
  assert.equal(loading.plan[2].status, 'pending', 'the sectors stage waits for the mesher');
  loading.step('world', { status: 'active', done: 1, total: 4, detail: '1 / 4 SECTORS' });
  assert.equal(loading.progress.value, (3 + 1 + 0.25) / 5, 'sector progress is the weighted tail of the plan');
  assert.equal(loading.count.textContent, '1 / 4 SECTORS');

  loading.show('arena');
  assert.deepEqual(await scheduler.require(['models', 'audio'], { loading }), { models: 'templates', audio: 'bank' });
  assert.equal(loading.plan.length, 0, 'loaded assets add no stages, the rail stays with the sectors');

  gates.runtime.reject(new Error('offline'));
  await tick();
  assert.equal(scheduler.status.tasks.runtime, 'failed');
  assert.equal(scheduler.status.tasks.art, 'active', 'a failed task never stops the background queue');
  const retry = scheduler.require(['runtime']);
  await tick();
  assert.equal(scheduler.status.tasks.runtime, 'active', 'a failed task is retried by the next request');
  gates.runtime.resolve('systems');
  gates.art.resolve(4);
  assert.deepEqual(await retry, { runtime: 'systems' });
  await background;
  assert.equal(scheduler.status.idle, true);
  assert.deepEqual(scheduler.status.tasks, { models: 'done', runtime: 'done', audio: 'done', art: 'done' });
  assert.ok(changes.includes('models') && changes.includes('art') && changes.at(-1) === null, 'status listeners observe each transition');
  await assert.rejects(scheduler.require(['missing']), /unknown asset task/);
  loading.hide();
}

// Weighted menu fractions: done counts full, active reports its share,
// failures count empty, unknown ids never gate the menu.
{
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  const gates2 = {};
  const gate2 = (id) => new Promise((resolve, reject) => { gates2[id] = { resolve, reject }; });
  const weighed = new AssetScheduler({ now: () => 0, warn() {}, onChange() {} });
  weighed.define('heavy', { weight: 3, load: (report) => { report({ fraction: 0.5 }); return gate2('heavy'); } });
  weighed.define('light', { weight: 1, load: () => gate2('light') });
  assert.equal(weighed.fraction(['heavy', 'light']), 0, 'pending tasks weigh nothing');
  assert.equal(weighed.fraction(['nope']), 1, 'unknown tasks never gate the menu');
  const wip = weighed.startAll();
  await tick();
  assert.equal(weighed.fraction(['heavy', 'light']), 0.375, 'active fractions weight into the menu bar');
  gates2.heavy.resolve(1);
  await tick(); await tick();
  assert.equal(weighed.fraction(['heavy', 'light']), 0.75, 'finished tasks count full while the tail pends');
  gates2.light.reject(new Error('offline'));
  await wip;
  assert.equal(weighed.fraction(['heavy', 'light']), 0.75, 'failed tasks count empty');
}

console.log('ok - loading progress, modal lifecycle, keyboard cancel, stale admission, waiting lobby, arena cancellation and background asset scheduling');
