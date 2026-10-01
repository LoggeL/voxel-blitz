import assert from 'node:assert/strict';
import { NetClient, CONNECTION_TIMEOUT_MS } from '../public/js/engine/netclient.js';

class FakeSocket {
  static instances = [];
  constructor() { this.readyState = 0; this.sent = []; FakeSocket.instances.push(this); }
  open() { this.readyState = 1; this.onopen?.(); }
  send(frame) { this.sent.push(frame); }
  message(data) { this.onmessage?.({ data }); }
  close() { this.readyState = 3; this.onclose?.({ code: 1000 }); }
}

const welcome = JSON.stringify({ t: 'welcome', id: 'me', mapBytes: 3, tickRate: 60,
  gameMode: 'fun', map: 'foundry', phase: 'live' });
const originalSocket = globalThis.WebSocket;
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
const timers = new Map();
let nextTimer = 0;
globalThis.WebSocket = FakeSocket;
globalThis.setTimeout = (callback, ms) => {
  const id = ++nextTimer;
  timers.set(id, { callback, ms });
  return id;
};
globalThis.clearTimeout = (id) => timers.delete(id);
try {
  for (const admitted of [false, true]) {
    const net = new NetClient();
    const pending = net.connect('ws://test.local', 'Tester');
    const rejected = assert.rejects(pending, /timed out/i);
    const socket = FakeSocket.instances.at(-1);
    socket.open();
    if (admitted) socket.message(welcome);
    assert.equal(timers.size, 1, 'the welcome/map pair owns one admission deadline');
    const timer = [...timers.values()][0];
    assert.equal(timer.ms, CONNECTION_TIMEOUT_MS);
    timer.callback();
    await rejected;
    assert.equal(timers.size, 0, 'a timeout releases its timer');
    assert.equal(socket.readyState, 3, 'an incomplete admission closes the socket');
    assert.equal(net.ws, null);
    assert.equal(net.welcome, null, 'a timed-out map never retains the partial welcome');
    assert.equal(net._connectAbort, null, 'the same client can connect again after the timeout');
  }

  {
    const net = new NetClient();
    let maps = 0;
    net.onMap = () => { maps++; };
    const pending = net.connect('ws://test.local', 'Tester');
    const socket = FakeSocket.instances.at(-1);
    socket.open();
    const staleDeadline = [...timers.values()][0].callback;
    socket.message(welcome);
    socket.message(Uint8Array.of(1, 2, 3).buffer);
    await pending;
    assert.equal(timers.size, 0, 'a completed welcome/map pair releases its deadline');
    staleDeadline();
    assert.equal(net.isOpen(), true, 'a queued deadline cannot close a completed admission');
    assert.equal(maps, 1);
    net.close();
  }

  {
    const net = new NetClient();
    const pending = net.connect('ws://test.local', 'Tester');
    const rejected = assert.rejects(pending, /closed before welcome\/map/);
    net.close();
    await rejected;
    assert.equal(timers.size, 0, 'cancelling admission releases its deadline');
  }
} finally {
  if (originalSocket === undefined) delete globalThis.WebSocket;
  else globalThis.WebSocket = originalSocket;
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
}

// Gameplay event listeners may synchronously leave or replace the live session.
// No remaining event from that old interpolation pass may reach the new one.
{
  const net = new NetClient();
  net.ws = new FakeSocket();
  net.ws.readyState = 1;
  net._onTick({ now: 100, players: [], events: [{ kind: 'hit' }, { kind: 'kill' }] });
  const delivered = [];
  net.on('hit', () => { delivered.push('hit'); net.close(); });
  net.on('hit', () => delivered.push('stale hit listener'));
  net.on('kill', () => delivered.push('stale kill'));
  net.interpolate(net.latestSnapshots[0].now, 0);
  assert.deepEqual(delivered, ['hit'], 'a generation change stops the old event pass and same-event listeners');
  assert.deepEqual(net.latestEvents, [], 'closing clears the old frame events');
}

console.log('NetClient lifecycle: admission deadlines, deadline cleanup, cancellation and event generation isolation passed.');
