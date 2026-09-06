import { WEAPONS } from '../../shared/combatmath.js';
import { PHYSICS, canStartVault, findVault, stepVault, boxCollides } from '../../shared/player-movement.js';
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

  for (const [x, descendingCatch] of [[18, false], [16.5, true]]) {
    const client = new PlayerPhysics();
    client.solid = wall;
    Object.assign(client.pos, { ...start, x });
    client.vel.x = PHYSICS.sprint;
    client.grounded = true;
    const server = { ...authoritative, x, y: 10, z: start.z,
      vx: PHYSICS.sprint, vy: 0, vz: 0, grounded: true, vault: null, hist: [],
      jumpGroundY: null, coyote: 0,
      input: { yaw: -Math.PI / 2, pitch: 0, keys: { f: true, sprint: true } } };
    let caught = false, caughtDescending = false, parity = true, collisionFree = true;
    for (let i = 0; i < 100; i++) {
      const jump = i === 0;
      const previousVy = client.vel.y;
      server.input.keys.jump = jump;
      client.step(1 / 60, { x: 1, z: 0 }, PHYSICS.sprint, jump, 1);
      stepMovement(server, 1 / 60, { solidAt: wall, now: i * 1000 / 60, onFall() {} });
      if (!caught && client.vault) {
        caught = true;
        caughtDescending = previousVy < 0;
      }
      parity &&= Math.hypot(client.pos.x - server.x, client.pos.y - server.y,
        client.pos.z - server.z) < 1e-8;
      collisionFree &&= !boxCollides(wall, client.pos.x, client.pos.y, client.pos.z);
      if (caught && !client.vault) break;
    }
    ok(caught && caughtDescending === descendingCatch && client.pos.y === 12
      && parity && collisionFree,
    `running jump catches a ledge while ${descendingCatch ? 'descending' : 'ascending'} after releasing jump, with client/server parity`);
  }
  ok(!canStartVault(true, false, 1, false, 10, 10)
    && !canStartVault(false, false, 1, false, 9, 10)
    && !canStartVault(false, true, 1, false, 11, null)
    && !canStartVault(false, false, 0, false, 11, 10)
    && !canStartVault(false, false, 1, true, 11, 10),
  'automatic ledge grabs require forward movement, jump height, and an uncrouched player');
}
