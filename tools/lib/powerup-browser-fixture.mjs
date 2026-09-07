// Test-only preload. IPC arranges state; production ticks, collection and wire
// delivery remain unchanged. No route or debug endpoint is added to the server.
import { GameEngine } from '../../server/game.js';
import { findPowerupSites } from '../../shared/powerup-sites.js';

let engine;
const start = GameEngine.prototype.start;
GameEngine.prototype.start = function (...args) {
  engine = this;
  return start.apply(this, args);
};

process.on('message', ({ requestId, command }) => {
  try {
    if (!engine?.running) throw new Error('No live room engine');
    const player = [...engine.entities.values()].find(entity => !entity.bot);
    if (!player) throw new Error('No human player');
    if (command === 'stage') {
      engine.powerups.active.clear();
      engine.powerups.nextSpawnAt = engine.now + 60_000;
      const sites = findPowerupSites(engine.world, engine.mapMeta);
      for (const [index, type] of ['armor', 'health', 'ammo'].entries()) {
        if (!sites[index]) throw new Error('Missing exposed site');
        const id = `browser-${type}`;
        engine.powerups.active.set(id, {
          ...sites[index], id, type, expiresAt: engine.now + 60_000,
        });
      }
      player.armor = 0;
      process.send({ requestId, result: engine.powerups.snapshot() });
    } else if (command === 'collect') {
      const pickup = engine.powerups.active.get('browser-armor');
      if (!pickup) throw new Error('Armor fixture is unavailable');
      Object.assign(player, { x: pickup.x, y: pickup.y, z: pickup.z,
        vx: 0, vy: 0, vz: 0, armor: 0, input: null });
      process.send({ requestId, result: { playerId: player.id } });
    } else throw new Error(`Unknown fixture command: ${command}`);
  } catch (error) {
    process.send({ requestId, error: error.message });
  }
});

await import('../../server/index.js');
