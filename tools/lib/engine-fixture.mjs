// Test-only preload shared by the IPC browser fixtures. It captures the live
// room engine and answers startServer({ ipc: true }).request(command) with the
// matching handler's result. Production ticks and wire delivery are unchanged
// and no route or debug endpoint is added to the server.
import { GameEngine } from '../../server/game.js';

export function serveEngineCommands(handlers) {
  let engine;
  const start = GameEngine.prototype.start;
  GameEngine.prototype.start = function (...args) {
    engine = this;
    return start.apply(this, args);
  };

  process.on('message', ({ requestId, command }) => {
    try {
      if (!engine?.running) throw new Error('No live room engine');
      const handler = Object.hasOwn(handlers, command) ? handlers[command] : null;
      if (!handler) throw new Error(`Unknown fixture command: ${command}`);
      process.send({ requestId, result: handler(engine) });
    } catch (error) {
      process.send({ requestId, error: error.message });
    }
  });
}

export function humanPlayer(engine) {
  const player = [...engine.entities.values()].find(entity => !entity.bot);
  if (!player) throw new Error('No human player');
  return player;
}
