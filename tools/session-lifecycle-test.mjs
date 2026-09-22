import assert from 'node:assert/strict';
import { Session } from '../public/js/session/session.js';
import { BuildController } from '../public/js/player/build-controller.js';
import { NetClient } from '../public/js/engine/netclient.js';

// Session admission/live lifecycle against a scripted NetClient and recording
// hud/input/audio stubs. Only the documented guarantees are asserted.

const flush = async (turns = 8) => { for (let i = 0; i < turns; i++) await Promise.resolve(); };

class FakeNet {
  constructor(log) {
    this.listeners = new Map();
    this.open = false;
    this.closed = 0;
    this.welcome = null;
    this.latestLobbyState = null;
    this.latestSnapshots = [];
    this.onMap = null;
    this.pending = null;
    log.push(this);
  }

  on(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
    return () => this.listeners.get(type)?.delete(fn);
  }

  emit(type, payload) {
    for (const fn of [...(this.listeners.get(type) || [])]) fn(payload);
  }

  connect() {
    return new Promise((resolve, reject) => { this.pending = { resolve, reject }; });
  }

  /** The server admits this socket: map frame first, then the welcome resolves. */
  admit(welcome) {
    this.open = true;
    this.welcome = welcome;
    this.onMap?.(new Uint8Array(4));
    this.pending.resolve(welcome);
  }

  refuse(message = 'connection failed before welcome/map') {
    this.pending.reject(new Error(message));
  }

  /** The socket dies underneath the session (dropped link or server kick). */
  drop(info = { code: 1006, reason: '' }) {
    this.open = false;
    this.emit('close', info);
  }

  isOpen() { return this.open; }

  close() {
    this.closed++;
    if (!this.open) return;
    this.open = false;
    this.emit('close', { code: 1000, reason: 'bye' });
  }
}

function recorder(fixed = {}) {
  const calls = [];
  const target = { calls, ...fixed };
  return new Proxy(target, {
    get(object, key) {
      if (key in object) return object[key];
      if (typeof key === 'symbol') return undefined;
      return (...args) => { calls.push([key, ...args]); };
    },
  });
}

function makeHarness({ onEnterLive } = {}) {
  const nets = [];
  const events = [];
  const windowListeners = new Map();
  let menuAction = null;
  let reloads = 0;
  let disconnects = 0;
  let teardowns = 0;
  const hud = recorder({
    settingsOpen: false,
    isBuyMenuOpen: () => false,
    isWeaponWheelOpen: () => false,
    buildMenu(action) { menuAction = action; hud.calls.push(['buildMenu']); },
    menuDone() { events.push('menuDone'); },
  });
  const loading = {
    stage: null, title: null, status: null, onCancel: null, failed: null, shows: 0,
    show(stage, { title, status, onCancel } = {}) {
      this.shows++;
      Object.assign(this, { stage, title, status, onCancel: onCancel || null });
    },
    update(status) { this.status = status; },
    hide() { this.stage = null; this.onCancel = null; },
    fail(message) { this.failed = message; },
    advance() {},
  };
  const session = new Session({
    hud,
    loading,
    input: recorder({ canvas: {}, getSensitivity: () => 0.003 }),
    audio: recorder(),
    gameplay: { running: false, alive: false, spectating: false, matchState: null, selfRow: null },
    makeNet: () => new FakeNet(nets),
    platform: {
      window: {
        addEventListener(type, fn) { windowListeners.set(type, fn); },
        removeEventListener(type, fn) { if (windowListeners.get(type) === fn) windowListeners.delete(type); },
      },
      document: null,
      location: { protocol: 'http:', host: 'test.local', href: 'http://test.local/', reload() { reloads++; } },
      history: null,
      storage: null,
      now: () => 0,
    },
    callbacks: {
      onEnterLive: onEnterLive || ((payload) => payload.complete({
        activateLive: () => events.push('activateLive'),
        flushQueuedSnapshots: () => events.push('flush'),
        consumeLatestAuthoritativeState: () => events.push('consume'),
        startLoop: () => events.push('startLoop'),
      })),
      onDisconnect: () => { disconnects++; },
      onTeardown: () => { teardowns++; },
    },
  });
  return {
    session, hud, loading, nets, events, windowListeners,
    get menuAction() { return menuAction; },
    get reloads() { return reloads; },
    get disconnects() { return disconnects; },
    get teardowns() { return teardowns; },
    lastJoinState: () => hud.calls.filter(([name]) => name === 'showJoinState').at(-1)?.[1],
    menuBuilds: () => hud.calls.filter(([name]) => name === 'buildMenu').length,
  };
}

const WELCOME = Object.freeze({ id: 'me', map: 'foundry', gameMode: 'tdm', phase: 'live', lobby: { code: 'ABCDE' } });

async function goLive(h) {
  h.session.start();
  h.menuAction({ mode: 'quick', name: 'Tester' });
  await flush();
  h.session.net.admit(WELCOME);
  await flush();
}

/** Run recover()'s backoff instantly while recording the requested delays. */
async function withInstantTimers(run) {
  const realSetTimeout = globalThis.setTimeout;
  const delays = [];
  globalThis.setTimeout = (fn, ms) => { delays.push(ms); queueMicrotask(fn); return 0; };
  try { await run(delays); } finally { globalThis.setTimeout = realSetTimeout; }
}

// A successful boot hands off once, in the documented order, after menuDone.
{
  const h = makeHarness();
  await goLive(h);
  assert.equal(h.session.phase, 'live');
  assert.deepEqual(h.events, ['menuDone', 'activateLive', 'flush', 'consume', 'startLoop']);
  assert.equal(h.loading.stage, null, 'the arena screen closes once live');

  // teardown is terminal and idempotent; live resources are released once.
  assert.equal(h.session.teardown(), true);
  assert.equal(h.session.teardown(), false);
  assert.equal(h.disconnects, 1);
  assert.equal(h.teardowns, 1);
  assert.equal(h.session.enterMenu(), false, 'no menu after teardown');

  // A Back/Forward cache restore of the torn-down page reloads it.
  const pageshow = h.windowListeners.get('pageshow');
  assert.equal(typeof pageshow, 'function', 'pageshow survives teardown');
  pageshow({ persisted: false });
  assert.equal(h.reloads, 0, 'a normal load never reloads');
  pageshow({ persisted: true });
  assert.equal(h.reloads, 1, 'a bfcache restore of a dead session reloads');
}
{
  const h = makeHarness();
  h.session.start();
  h.windowListeners.get('pageshow')({ persisted: true });
  assert.equal(h.reloads, 0, 'a restore of a live session keeps it');
}

// A dropped link during live play reconnects without rebuilding the menu per retry.
await withInstantTimers(async (delays) => {
  const h = makeHarness();
  await goLive(h);
  const builds = h.menuBuilds();
  h.session.net.drop();
  assert.equal(h.disconnects, 1, 'live resources are released once per generation');
  assert.equal(h.session.phase, 'menu');
  assert.match(h.lastJoinState(), /Reconnecting \(1\/6\)/);
  for (let retry = 1; retry <= 6; retry++) {
    await flush();
    const net = h.session.net;
    assert(net.pending, `retry ${retry} opens a fresh connection`);
    assert.equal(h.loading.title, 'RECONNECTING');
    assert.match(h.loading.status, new RegExp(`Reconnecting \\(${retry}/6\\)`));
    assert.match(h.lastJoinState(), /Reconnecting/, 'the join status keeps the reconnect feedback');
    net.refuse();
    await flush();
  }
  assert.deepEqual(delays, [500, 1000, 2000, 4000, 4000, 4000]);
  assert.equal(h.menuBuilds(), builds + 2, 'menu is built when recovery starts and when it gives up');
  assert.equal(h.lastJoinState(), 'Could not reconnect. Join again with room code ABCDE.');
  assert.equal(h.loading.stage, null);
  assert.equal(h.disconnects, 1);
});

// Cancel on the reconnect overlay ends the loop, also between retries.
await withInstantTimers(async () => {
  const h = makeHarness();
  await goLive(h);
  h.session.net.drop();
  await flush();
  h.session.net.refuse();
  await flush(2);
  const nets = h.nets.length;
  h.loading.onCancel();
  assert.equal(h.session.phase, 'menu');
  await flush(20);
  assert.equal(h.nets.length, nets + 1, 'only the menu replaces the net; no retry connects');
  assert.equal(h.session.net.pending, null);
});

// A server kick (e.g. TTT karma ban) shows its reason instead of retrying.
await withInstantTimers(async () => {
  const h = makeHarness();
  await goLive(h);
  const karma = 'Karma too low (450 or below). Banned for 60 minutes.';
  h.session.net.emit('serverError', { msg: karma });
  h.session.net.drop({ code: 4003, reason: 'Karma too low: 60 minute ban' });
  await flush(20);
  assert.equal(h.session.phase, 'menu');
  assert.equal(h.lastJoinState(), karma);
  assert.equal(h.session.net.pending, null, 'no reconnect attempt follows a kick');
  assert.equal(h.disconnects, 1);
});

// Leaving while onEnterLive is still building never completes the stale boot.
{
  let payload = null;
  let finish = null;
  const h = makeHarness({ onEnterLive: (p) => { payload = p; return new Promise((resolve) => { finish = resolve; }); } });
  await goLive(h);
  assert.equal(h.session.phase, 'booting');
  assert.equal(payload.isActive(), true);
  assert.equal(h.session.leaveMatch(), true);
  assert.equal(h.session.phase, 'menu');
  assert.equal(h.disconnects, 1);
  assert.equal(payload.isActive(), false);
  assert.equal(payload.complete({
    activateLive: () => h.events.push('activateLive'), flushQueuedSnapshots() {},
    consumeLatestAuthoritativeState() {}, startLoop: () => h.events.push('startLoop'),
  }), false);
  finish();
  await flush();
  assert.deepEqual(h.events, [], 'a cancelled boot never activates or starts the loop');
  assert.equal(h.session.tornDown, false);
  assert.equal(h.disconnects, 1);
}

// A failed boot returns to the menu; a repeat failure is terminal.
{
  const h = makeHarness({ onEnterLive: () => Promise.reject(new Error('asset task failed')) });
  const logged = console.error;
  console.error = () => {};
  try {
    await goLive(h);
    await flush();
    assert.equal(h.session.phase, 'menu');
    assert.equal(h.session.tornDown, false);
    assert.equal(h.disconnects, 1);
    assert.match(h.lastJoinState(), /Could not prepare the arena: asset task failed/);
    assert.equal(h.loading.failed, null);

    h.menuAction({ mode: 'quick', name: 'Tester' });
    await flush();
    h.session.net.admit(WELCOME);
    await flush();
    assert.equal(h.session.tornDown, true);
    assert.match(h.loading.failed, /Reload the game/);
    assert.equal(h.disconnects, 2);
  } finally { console.error = logged; }
}

// NetClient forwards the server's close code so a kick is told from a dropped link.
{
  const net = new NetClient();
  const ws = { readyState: 1, close() {} };
  net.ws = ws;
  net._reattach(ws, net._sessionGeneration);
  let info = null;
  net.on('close', (event) => { info = event; });
  ws.onclose({ code: 4003, reason: 'karma ban' });
  assert.deepEqual(info, { code: 4003, reason: 'karma ban' });
  assert.equal(net.isOpen(), false);
}

// Bastion build mode: cycle order, phase/menu exits and rotation.
{
  const input = {
    mode: false, toggle: null,
    setBuildMode(value) { this.mode = value; },
    consumeBuildToggle() { const toggle = this.toggle; this.toggle = null; return toggle; },
    consumePlaceRequest() { return false; },
    consumeBuildRotate() { return false; },
  };
  const match = { mode: 'bastion', phase: 'prep' };
  let buyMenuOpen = false;
  const build = new BuildController({
    input, getBlock: () => 0, getWorldview: () => null, getCamera: () => null,
    getPlayer: () => ({ alive: true }), getMatch: () => match, getSelfRow: () => ({ state: 'alive' }),
    getMapMeta: () => null, purchase: () => assert.fail('no placement without a ghost'),
    isBuyMenuOpen: () => buyMenuOpen,
  });
  const order = [];
  for (let i = 0; i < 5; i++) { build.cycle(); order.push(build.active ? build.kind : 'off'); }
  assert.deepEqual(order, ['wall', 'sandbag', 'turret', 'crate', 'off']);
  assert.equal(input.mode, false);

  match.phase = 'live';
  assert.equal(build.select('wall'), false, 'no building while the wave is live');
  match.phase = 'supply';
  assert.equal(build.select('turret'), true);
  assert.equal(input.mode, true);
  buyMenuOpen = true;
  build.update();
  assert.equal(build.active, false, 'the armory closes build mode');
  buyMenuOpen = false;
  build.select('wall');
  match.phase = 'live';
  build.update();
  assert.equal(build.active, false, 'a phase change closes build mode');

  build.rotate(-1);
  assert.equal(build.rotateOffset, 3);
  build.rotate(2);
  assert.equal(build.rotateOffset, 1);
  build.dispose();
}

console.log('Session lifecycle: boot handoff order, teardown, bfcache reload, reconnect, kick, cancelled/failed boot and build mode passed.');
