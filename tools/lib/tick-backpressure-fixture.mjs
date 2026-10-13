// Private IPC observation of the real server transport. No socket callbacks,
// game ticks or wire payloads are replaced and no public debug route is added.
import { LobbyManager } from '../../server/lobby.js';
import { serveEngineCommands } from './engine-fixture.mjs';

let client;
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
  transport(engine) {
    if (!client) throw new Error('No live transport');
    return {
      now: engine.now, tickMs: engine.intervalMs, snapshots, lastSnapshotNow,
      ticksInFlight: client.ticksInFlight ?? 0,
      skippedTicks: client.skippedTicks ?? 0,
      heldTicks: client.heldTick?.ticks ?? 0,
      queuedBytes: client.ws.bufferedAmount,
      tick: engine.tickTiming.read(),
    };
  },
});

await import('../../server/index.js');
