import { GameEngine } from '../../server/game.js';
import { SpawnSelector } from '../../server/sim/spawn.js';

export function runSpawnVarietyContracts(ok) {
  const arena = new GameEngine({ mode: 'gungame' });
  const basePool = arena.mapMeta.spawns.fun;
  const expanded = arena.spawnSelector.expand(basePool);
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

  // Fluid guard: lava at the feet, at a neighbouring feet cell or under a
  // neighbouring floor cell disqualifies a candidate while any dry one exists.
  const lava = new Set(['15,1,10', '20,0,10', '25,1,11']);
  const guarded = new SpawnSelector({ entities: new Map(), isEnemy: () => true,
    solidAt: (x, y, z) => y === 0 && !lava.has(`${x},${y},${z}`),
    fluidAt: (x, y, z) => lava.has(`${x},${y},${z}`), now: 0 });
  const inLava = { x: 15.5, y: 1, z: 10.5 };
  const besideLavaFloor = { x: 19.5, y: 1, z: 10.5 };
  const besideLava = { x: 24.5, y: 1, z: 10.5 };
  const dry = { x: 40.5, y: 1, z: 10.5 };
  ok(guarded.walkable(inLava) && guarded.hazardous(inLava) && guarded.hazardous(besideLavaFloor)
    && guarded.hazardous(besideLava) && !guarded.hazardous(dry),
    'a lava cell is walkable geometry but hazardous at the feet, beside the feet and beside the floor');
  ok(guarded.pick([inLava, besideLavaFloor, besideLava, dry]).x === dry.x,
    'spawn selection skips every lava candidate for the dry one even when it scores lower');
  ok(guarded.pick([inLava, besideLava]).x === inLava.x,
    'an entirely wet pool falls back to ordinary scoring instead of failing');
  const unguarded = new SpawnSelector({ entities: new Map(), isEnemy: () => true, solidAt: (x, y) => y === 0, now: 0 });
  ok(!unguarded.hazardous(inLava) && unguarded.pick([inLava, dry]).x === inLava.x,
    'worlds without fluids keep their previous spawn behaviour');
}
