import assert from 'node:assert/strict';
import { GameEngine } from '../server/game.js';
import { PlayerEntity } from '../server/sim/player.js';
import { stepMovement } from '../server/sim/movement.js';
import { PlayerPhysics } from '../public/js/player-physics.js';
import { LEAN, leanBlocked, leanEyeOffset, leanEyeShift, leanInput, leanPose, leanReach, stepLean } from '../shared/player-lean.js';
import { playerHitboxes, rayPlayerHitboxes } from '../shared/player-hitboxes.js';
import { KEYBINDING_ACTIONS, normalizeKeybindings } from '../public/js/keybindings.js';
import { validateAccountRecord } from '../server/accounts.js';
import { PASSWORD_COST } from '../server/account-security.js';

const near = (actual, expected, tolerance, label) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} vs ${expected}`);
let checks = 0;

// Shared contract: signed request, timing, smoothing and body-right direction.
{
  assert.equal(leanInput({ leanLeft: true }), -1);
  assert.equal(leanInput({ leanRight: true }), 1);
  assert.equal(leanInput({ leanLeft: true, leanRight: true }), 0, 'both keys cancel');
  assert.equal(leanBlocked({ sprint: true, forward: true }), true, 'a forward sprint holds the body square');
  assert.equal(leanBlocked({ sprint: true, forward: true, crouch: true }), false, 'crouch cancels the sprint gate');
  assert.equal(leanBlocked({ sprint: true }), false, 'Shift without forward (steady aim) still leans');
  assert.equal(leanBlocked({ prone: true }), true);
  let value = 0;
  for (let i = 0; i < 10; i++) value = stepLean(value, 1, LEAN.inS / 10);
  near(value, 1, 1e-9, 'a full lean takes LEAN.inS');
  value = stepLean(value, -1, LEAN.inS);
  near(value, 0, 1e-9, 'switching sides passes through upright at the same rate');
  assert.equal(stepLean(0.8, 1, 0.01, 1, 0.3), 0.3, 'a wall snaps an existing lean back');
  assert.equal(leanPose(-0.5), -0.5);
  const standing = leanEyeShift(1, 0).side, crouched = leanEyeShift(1, 1).side;
  assert.ok(standing > 0.28 && standing < 0.32, `standing peek moves the eye ~0.3 m (${standing})`);
  assert.ok(crouched > 0.2 && crouched < standing, `crouched peek is shorter (${crouched})`);
  const east = leanEyeOffset(1, 0);
  near(east.x, standing, 1e-9, 'yaw 0 leans right toward +x');
  near(east.z, 0, 1e-9, 'yaw 0 lean stays lateral');
  assert.ok(east.y < 0, 'the leaned eye drops slightly');
  const quarter = leanEyeOffset(1, Math.PI / 2);
  near(quarter.z, -standing, 1e-9, 'facing -x the right side is -z');
  near(leanEyeOffset(-1, 0.7).x, -leanEyeOffset(1, 0.7).x, 1e-9, 'left mirrors right');
  checks += 18;
}

// Walls clamp the lean so the eye keeps LEAN.headClear of air beside it.
const floorAndWall = (wallX) => (x, y, z) => y < 10 || x >= wallX;
{
  assert.equal(leanReach(floorAndWall(20), 10.5, 11.5, 10.5, 0, 1), 1, 'open air allows a full lean');
  const reach = leanReach(floorAndWall(11), 10.7, 11.5, 10.5, 0, 1);
  const room = 0.3 - LEAN.headClear;
  assert.ok(reach > 0 && reach < 1, `a wall at 0.3 m limits the lean (${reach})`);
  near(leanEyeShift(reach, 0).side, room, 1e-3, 'the clamped eye stops headClear short of the wall');
  assert.equal(leanReach(floorAndWall(11), 10.7, 11.5, 10.5, 0, -1), 1, 'the open side stays free');
  checks += 4;
}

// Authority: Q/E arrive as leanL/leanR, step into leanT and move the shooting eye.
function authority(wallX = 20, keys = {}) {
  const game = new GameEngine();
  const player = new PlayerEntity('p', 'Player', { x: 10.5, y: 10, z: 10.5 });
  player.grounded = true;
  game.entities.set('p', player);
  game.applyInput('p', { seq: 1, keys, yaw: 0, pitch: 0 });
  const ctx = { now: 0, solidAt: floorAndWall(wallX), fluidAt: () => false, mapMeta: null, onFall() {} };
  const run = (seconds, x = null) => {
    for (let t = 0; t < seconds; t += 1 / 60) {
      if (x !== null) player.x = x;
      ctx.now += 1000 / 60;
      stepMovement(player, 1 / 60, ctx);
    }
  };
  return { game, player, run };
}
{
  const { player, run } = authority(20, { leanR: true });
  const upright = player.eyeY;
  run(0.3);
  near(player.leanT, 1, 1e-9, 'held E reaches a full right lean on the authority');
  near(player.eyeX - player.x, leanEyeShift(1, 0).side, 1e-9, 'the shooting eye moves right');
  near(player.eyeZ, player.z, 1e-9, 'yaw 0 keeps the eye on the same z');
  assert.ok(player.eyeY < upright && player.eyeY > upright - 0.1, 'the eye drops a few centimetres');
  assert.equal(player.hist.at(-1).leanT, 1, 'rewind samples keep the lean');
  assert.ok(Math.abs(player.x - 10.5) < 1e-6, 'leaning never strafes the feet');
  // The leaned head is a real target: a ray through the peek hits the head,
  // while the upright head is nowhere near that line.
  const head = playerHitboxes(player).find(box => box.zone === 'head');
  const upBody = { ...player, leanT: 0 };
  const upHead = playerHitboxes(upBody).find(box => box.zone === 'head');
  assert.ok(head.center[0] - upHead.center[0] > 0.25, 'the head zone swings out with the lean');
  const origin = [head.center[0], head.center[1], player.z + 5];
  const hit = rayPlayerHitboxes(origin, { x: 0, y: 0, z: -1 }, player, 20);
  assert.equal(hit?.zone, 'head', 'a shot through the peek lands on the head');
  const miss = rayPlayerHitboxes(origin, { x: 0, y: 0, z: -1 }, upBody, 20);
  assert.notEqual(miss?.zone, 'head', 'the upright head is not on the peek line');
  const legs = playerHitboxes(player).filter(box => box.zone === 'leg' || box.zone === 'hips');
  const upLegs = playerHitboxes(upBody).filter(box => box.zone === 'leg' || box.zone === 'hips');
  assert.deepEqual(legs.map(box => box.center), upLegs.map(box => box.center), 'hips and legs stay planted');
  checks += 11;
}
{
  const { game, player, run } = authority(20, { leanL: true, f: true, sprint: true });
  run(0.3);
  assert.equal(player.leanT, 0, 'a forward sprint blocks the lean');
  game.applyInput('p', { seq: 2, keys: { leanL: true, prone: true }, yaw: 0, pitch: 0 });
  run(0.3);
  assert.equal(player.leanT, 0, 'prone blocks the lean');
  game.applyInput('p', { seq: 3, keys: { leanL: true }, yaw: 0, pitch: 0 });
  run(1.2);
  near(player.leanT, -1, 1e-9, 'standing back up restores the held lean');
  game.applyInput('p', { seq: 4, keys: {}, yaw: 0, pitch: 0 });
  run(0.3);
  assert.equal(player.leanT, 0, 'releasing Q returns upright');
  checks += 4;
}

// Prediction and authority agree next to a wall, including the clamp.
{
  const { player, run } = authority(11, { leanR: true });
  const physics = new PlayerPhysics();
  physics._solidAt = floorAndWall(11);
  physics.pos = { x: 10.7, y: 10, z: 10.5 };
  physics.grounded = true;
  physics.wantLean = 1;
  for (let i = 0; i < 30; i++) {
    run(1 / 60 - 1e-9, 10.7);
    physics.pos.x = 10.7;
    physics.step(1 / 60, { x: 0, z: 0 }, 0, false, 0, 0);
    near(physics.leanT, player.leanT, 1e-9, `prediction tick ${i} matches authority`);
  }
  assert.ok(player.leanT > 0.2 && player.leanT < 1, `the wall clamps the authoritative lean (${player.leanT})`);
  near(physics.leanEyeOffset().x, player.eyeX - player.x, 1e-9, 'the camera and the shooting eye coincide');
  checks += 32;
}

// Bindings saved before Q/E leaned keep working: a player's own keys win over
// the new defaults, and stored account records that predate the actions load.
{
  const defaults = normalizeKeybindings(null);
  assert.deepEqual([defaults.leanLeft, defaults.leanRight, defaults.left, defaults.right],
    [['KeyQ'], ['KeyE'], ['KeyA'], ['KeyD']], 'Q/E lean by default and A/D strafe alone');
  const legacy = Object.fromEntries(KEYBINDING_ACTIONS.filter(action => !action.id.startsWith('lean'))
    .map(action => [action.id, [...action.codes]]));
  legacy.jump = ['KeyQ'];
  legacy.left = ['KeyA'];
  const migrated = normalizeKeybindings(legacy);
  assert.deepEqual(migrated.jump, ['KeyQ'], 'a saved Q binding keeps its key');
  assert.deepEqual(migrated.leanLeft, [], 'the new lean default yields to it');
  assert.deepEqual(migrated.leanRight, ['KeyE']);
  const record = { version: 1, id: 'a'.repeat(32), username: 'leaner', recoveryHash: 'b'.repeat(64),
    authVersion: 1, createdAt: 1, updatedAt: 2, sessions: [],
    password: { algorithm: 'scrypt', N: PASSWORD_COST.N, r: PASSWORD_COST.r, p: PASSWORD_COST.p, salt: 'c'.repeat(32), hash: 'd'.repeat(128) },
    keybindings: normalizeKeybindings(legacy) };
  delete record.keybindings.leanLeft;
  delete record.keybindings.leanRight;
  assert.doesNotThrow(() => validateAccountRecord(record, 'leaner.json'), 'an account saved before lean still loads');
  assert.throws(() => validateAccountRecord({ ...record, keybindings: { ...record.keybindings, jump: ['KeyQ', 'KeyQ'] } }, 'leaner.json'),
    /Invalid keybindings/, 'non-normalized stored bindings still fail closed');
  assert.throws(() => validateAccountRecord({ ...record, keybindings: { ...record.keybindings, bogus: [] } }, 'leaner.json'),
    /Invalid keybindings/, 'unknown actions still fail closed');
  checks += 7;
}

console.log(`lean tests passed: ${checks} checks`);
