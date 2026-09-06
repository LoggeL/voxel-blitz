import { ProjectileSystem } from '../../server/sim/projectiles.js';
import { ROCKET_RULES } from '../../shared/rocket-rules.js';
import { AIR, STONE } from '../../shared/worlddata.js';

export function runDestructionContracts(ok) {
  const system = new ProjectileSystem();
  const carve = (rules) => {
    const blocks = new Set();
    for (let x = 20; x <= 27; x++) for (let y = 8; y <= 16; y++) {
      for (let z = 20; z <= 28; z++) blocks.add(`${x},${y},${z}`);
    }
    let removed = 0;
    system._destroyTerrain([19.99, 12.5, 24.5], rules, {
      getBlock: (x, y, z) => blocks.has(`${x},${y},${z}`) ? STONE : AIR,
      destroyBlock: (x, y, z) => {
        const hit = blocks.delete(`${x},${y},${z}`);
        if (hit) removed++;
        return hit;
      },
    });
    return removed;
  };
  const previous = carve({ terrainRadius: 3.1, terrainPower: 145, maxDestroyedBlocks: 80 });
  const current = carve(ROCKET_RULES);
  ok(current > previous * 2 && current <= ROCKET_RULES.maxDestroyedBlocks,
    `rocket opens a larger bounded breach in stone (${previous} -> ${current} blocks)`);
}
