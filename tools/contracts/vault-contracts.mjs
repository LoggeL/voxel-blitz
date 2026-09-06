import { WEAPONS } from '../../shared/combatmath.js';
import { findVault, stepVault, boxCollides } from '../../shared/player-movement.js';
import { PlayerPhysics } from '../../public/js/player-physics.js';
import { stepMovement } from '../../server/sim/movement.js';

export function runVaultContracts(ok) {
  const wall = (x, y, z) => y < 10 || (x >= 20 && x < 23 && y < 12);
  const position = { x: 19.5, y: 10, z: 24.5 };
  const vault = findVault(wall, position, { x: 1, z: 0 }, 10);
  let clear = !!vault;
  for (let i = 0; vault && i < 60; i++) {
    const active = stepVault(position, vault, 1 / 60, wall);
    clear &&= !boxCollides(wall, position.x, position.y, position.z);
    if (!active) break;
  }
  ok(clear && position.y === 12 && position.x > 20,
    'vault smoothly reaches a two-block ledge without intersecting its wall');
  const start = { x: 19.5, y: 10, z: 24.5 };
  ok(!findVault((x, y, z) => wall(x, y, z) || (x >= 20 && y === 12), start, { x: 1, z: 0 }, 10)
    && !findVault((x, y, z) => wall(x, y, z) || y === 13, start, { x: 1, z: 0 }, 10),
    'vault rejects three-block walls and insufficient headroom');
  const predicted = new PlayerPhysics();
  predicted.solid = wall;
  Object.assign(predicted.pos, start);
  predicted.grounded = true;
  const authoritative = { ...start, vx: 0, vy: 0, vz: 0, grounded: true,
    def: WEAPONS.rifle, adsT: 0, coyote: 0, hist: [],
    input: { yaw: -Math.PI / 2, pitch: 0, keys: { f: true, jump: true } } };
  let matches = true;
  for (let i = 0; i < 29; i++) {
    predicted.step(1 / 60, { x: 1, z: 0 }, 4.4, true, 1);
    stepMovement(authoritative, 1 / 60, { solidAt: wall, now: i * 1000 / 60, onFall() {} });
    matches &&= Math.hypot(predicted.pos.x - authoritative.x,
      predicted.pos.y - authoritative.y, predicted.pos.z - authoritative.z) < 1e-8;
  }
  ok(matches && authoritative.y === 12, 'vault prediction and authority agree throughout the full pull-up');
}
