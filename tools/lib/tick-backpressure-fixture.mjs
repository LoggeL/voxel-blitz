// Private IPC control of the real server writer. Corking holds actual socket
// writes and their callbacks; ticks, coalescing and wire payloads stay real.
// No public debug route is added.
import { LobbyManager } from '../../server/lobby.js';
import { serveEngineCommands } from './engine-fixture.mjs';

let client;
let heldSocket;
let snapshots = 0;
let lastSnapshotNow = null;
const broadcast = LobbyManager.prototype._broadcastJson;
LobbyManager.prototype._broadcastJson = function (room, message) {
  if (message.t === 'tick') {
    client = room.members.values().next().value?.meta;
    snapshots++;
    lastSnapshotNow = message.now;
  }
  return broadcast.call(this, room, message);
};

serveEngineCommands({
  holdWrites() {
    if (!client) throw new Error('No live transport');
    if (heldSocket) throw new Error('Transport writes already held');
    heldSocket = client.ws._socket;
    heldSocket.cork();
    return { corked: heldSocket.writableCorked };
  },
  releaseWrites() {
    if (!heldSocket) return { released: false };
    heldSocket.uncork();
    heldSocket = null;
    return { released: true };
  },
  transport(engine) {
    if (!client) throw new Error('No live transport');
    return {
      now: engine.now, tickMs: engine.intervalMs, snapshots, lastSnapshotNow,
      ticksInFlight: client.ticksInFlight ?? 0,
      skippedTicks: client.skippedTicks ?? 0,
      heldTicks: client.heldTick?.ticks ?? 0,
      queuedBytes: client.ws.bufferedAmount,
      corked: client.ws._socket.writableCorked,
      tick: engine.tickTiming.read(),
    };
  },
  transportDebug() {
    if (!client) throw new Error('No live transport');
    const ws = client.ws, socket = ws._socket;
    return {
      ticksInFlight: client.ticksInFlight, skippedTicks: client.skippedTicks,
      heldTicks: client.heldTick?.ticks, queuedBytes: ws.bufferedAmount,
      readable: { paused: socket.isPaused(), flowing: socket.readableFlowing,
        length: socket.readableLength, destroyed: socket.destroyed, bytesRead: socket.bytesRead },
      writable: { length: socket.writableLength, needDrain: socket.writableNeedDrain,
        corked: socket.writableCorked, bytesWritten: socket.bytesWritten },
    };
  },
});

await import('../../server/index.js');
