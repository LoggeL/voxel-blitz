// Test-only preload. IPC arranges state; production ticks, collection and wire
// delivery remain unchanged. No route or debug endpoint is added to the server.
import { findPowerupSites } from '../../shared/powerup-sites.js';
import { humanPlayer, serveEngineCommands } from './engine-fixture.mjs';

serveEngineCommands({
  stage(engine) {
    const player = humanPlayer(engine);
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
    return engine.powerups.snapshot();
  },
  collect(engine) {
    const player = humanPlayer(engine);
    const pickup = engine.powerups.active.get('browser-armor');
    if (!pickup) throw new Error('Armor fixture is unavailable');
    Object.assign(player, { x: pickup.x, y: pickup.y, z: pickup.z,
      vx: 0, vy: 0, vz: 0, armor: 0, input: null });
    return { playerId: player.id };
  },
});

await import('../../server/index.js');
