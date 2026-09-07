import { WEAPONS } from '../../shared/combatmath.js';
import { PHYSICS, VAULT_SECONDS, canStartVault, findVault, stepVault, boxCollides } from '../../shared/player-movement.js';
import { PlayerPhysics } from '../../public/js/player-physics.js';
import { stepMovement } from '../../server/sim/movement.js';
import { createMapState } from '../../shared/worlddata.js';

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
  const cliff = (x, y, z) => y < 10 || (x >= 20 && x < 23 && y < 13);
  for (const repress of [false, true]) {
    const client = new PlayerPhysics();
    client.solid = cliff;
    Object.assign(client.pos, { ...start, x: 18 });
    client.vel.x = PHYSICS.sprint;
    client.grounded = true;
    const server = { ...authoritative, x: 18, y: 10, z: start.z,
      vx: PHYSICS.sprint, vy: 0, vz: 0, grounded: true, vault: null, hist: [],
      jumpGroundY: null, jumpWasHeld: false, coyote: 0,
      input: { yaw: -Math.PI / 2, pitch: 0, keys: { f: true, sprint: true } } };
    let pressedAgain = false, caught = false, parity = true, collisionFree = true;
    for (let i = 0; i < 95; i++) {
      const retry = repress && !pressedAgain && client.pos.x > 19.1 && client.pos.y > 11;
      const jump = repress ? i === 0 || retry : true;
      pressedAgain ||= retry;
      server.input.keys.jump = jump;
      client.step(1 / 60, { x: 1, z: 0 }, PHYSICS.sprint, jump, 1, -Math.PI / 2);
      stepMovement(server, 1 / 60, { solidAt: cliff, now: i * 1000 / 60, onFall() {} });
      caught ||= !!client.vault;
      parity &&= Math.hypot(client.pos.x - server.x, client.pos.y - server.y,
        client.pos.z - server.z) < 1e-8;
      collisionFree &&= !boxCollides(cliff, client.pos.x, client.pos.y, client.pos.z);
      if (caught && !client.vault) break;
    }
    ok(parity && collisionFree && (repress
      ? pressedAgain && caught && client.pos.y === 13
      : !caught), repress
      ? 'a second airborne Space press climbs a cliff reachable from current height with client/server parity'
      : 'holding the original jump does not gain repeated climbing reach against a taller cliff');
  }

  for (const groundY of [null, 17]) {
    const client = new PlayerPhysics();
    client.solid = cliff;
    Object.assign(client.pos, { ...start, y: 11.2 });
    client.vel.y = -2;
    client.jumpGroundY = groundY;
    client.jumpWasHeld = true;
    const server = { ...authoritative, ...client.pos, vx: 0, vy: -2, vz: 0,
      grounded: false, vault: null, hist: [], jumpGroundY: groundY, jumpWasHeld: true,
      input: { yaw: -Math.PI / 2, pitch: 0, keys: {} } };
    let caught = false, parity = true;
    for (let i = 0; i < 40; i++) {
      // Release, then press Space while falling beside the ledge with no movement keys.
      const jump = i === 1;
      server.input.keys.jump = jump;
      client.step(1 / 60, { x: 0, z: 0 }, PHYSICS.walk, jump, 0, -Math.PI / 2);
      stepMovement(server, 1 / 60, { solidAt: cliff, now: i * 1000 / 60, onFall() {} });
      caught ||= !!client.vault;
      parity &&= Math.hypot(client.pos.x - server.x, client.pos.y - server.y,
        client.pos.z - server.z) < 1e-8;
      if (caught && !client.vault) break;
    }
    ok(caught && parity && client.pos.y === 13,
      `stationary airborne Space reaches the facing ledge with ${groundY === null ? 'no takeoff history' : 'a higher takeoff point'}`);
  }

  const airborne = { ...start, y: 11.2 };
  ok(!findVault((x, y, z) => y < 10 || (x >= 20 && y < 14), airborne, { x: 1, z: 0 })
    && !findVault((x, y, z) => cliff(x, y, z) || y === 14, airborne, { x: 1, z: 0 })
    && !findVault(cliff, { ...airborne, x: 18.5 }, { x: 1, z: 0 })
    && !findVault(cliff, airborne, { x: -1, z: 0 }),
  'deliberate airborne grabs reject unreachable, ceiling-blocked, distant, and opposite ledges');
  const interruptedPosition = { ...airborne };
  const interrupted = findVault(cliff, interruptedPosition, { x: 1, z: 0 });
  stepVault(interruptedPosition, interrupted, VAULT_SECONDS * 0.25, cliff);
  const dynamicCeiling = (x, y, z) => cliff(x, y, z) || y === 14;
  ok(!stepVault(interruptedPosition, interrupted, VAULT_SECONDS, dynamicCeiling)
    && !boxCollides(dynamicCeiling, interruptedPosition.x, interruptedPosition.y, interruptedPosition.z),
  'a new obstacle during a pull-up cancels the vault before the player intersects it');

  const killhouse = createMapState('killhouse');
  const mapSolid = (x, y, z) => killhouse.getBlock(x, y, z) !== 0;
  const mapPosition = { x: 21.5, y: 16.2, z: 36.5 };
  const mapVault = findVault(mapSolid, mapPosition, { x: 0, z: 0 }, mapPosition.y, -Math.PI / 2);
  let mapClear = !!mapVault;
  for (let i = 0; mapVault && i < 10; i++) {
    const active = stepVault(mapPosition, mapVault, 1 / 20, mapSolid);
    mapClear &&= !boxCollides(mapSolid, mapPosition.x, mapPosition.y, mapPosition.z);
    if (!active) break;
  }
  ok(mapClear && mapPosition.y === 18 && mapPosition.x > 22,
    'current-height reaching clears a real Killhouse cliff with the authoritative tick interval');
  ok(!canStartVault(true, false, 1, false, 10, 10)
    && !canStartVault(false, false, 1, false, 9, 10)
    && !canStartVault(false, false, 0, false, 11, 10)
    && !canStartVault(false, true, 1, true, 11, 10)
    && canStartVault(false, true, 0, false, 11, null),
  'automatic grabs require forward jump height; deliberate airborne presses still require an uncrouched player');
}
