import { GameEngine } from '../../server/game.js';
import { SpawnSelector } from '../../server/sim/spawn.js';

export function runSpawnVarietyContracts(ok) {
  const arena = new GameEngine({ mode: 'gungame' });
  const basePool = arena.mapMeta.spawns.fun;
  const expanded = arena.spawnSelector.expand(basePool);
  ok(expanded.length >= basePool.length * 10 && expanded.every((point) => arena.spawnSelector.walkable(point)),
    'expanded spawns provide at least ten times as many currently walkable choices');
  const seen = new Set();
  for (let i = 0; i < 12; i++) {
    const point = arena.selectSafestSpawn(expanded);
    seen.add(`${point.x},${point.y},${point.z}`);
  }
  ok(seen.size === 12, 'spawn recent-use penalties distribute consecutive arrivals across different locations');
  arena.stop();
  const enemy = { id: 'enemy', state: 'alive', x: 2, y: 1, z: 10 };
  const selector = new SpawnSelector({ entities: new Map([['enemy', enemy]]), isEnemy: () => true,
    solidAt: (x, y, z) => y === 0 || (x === 10 && z < 20 && y < 5), now: 0 });
  const hidden = { x: 16.5, y: 1, z: 10.5 };
  const exposed = { x: 2.5, y: 1, z: 44.5 };
  ok(selector.pick([hidden, exposed], null, -1, { variety: true }).x === hidden.x,
    'spawn safety prefers hidden cover over a farther point in an enemy sightline');
}
