import assert from 'node:assert/strict';
import { PRONE, stanceHeight } from '../shared/player-stance.js';
import { PHYSICS, boxCollides, slidePlayerAxis } from '../shared/player-movement.js';
import { PlayerPhysics } from '../public/js/player-physics.js';
import { PlayerEntity } from '../server/sim/player.js';
import { stepMovement, updateTimers } from '../server/sim/movement.js';
import { resolveWeaponIntent } from '../server/sim/combat.js';
import { Input } from '../public/js/engine/input.js';
import { LocalPlayer } from '../public/js/player/local-player.js';
import { WeaponState } from '../public/js/guns/weapon-state.js';

const start = { x: 19.5, y: 10, z: 24.5 };
const floor = (_x, y) => y < 10;
const wall = (x, y) => floor(x, y) || (x >= 20 && x < 23 && y < 12);
function pair(solid, position = start, mapMeta = null) {
  const client = new PlayerPhysics(mapMeta);
  client.solid = solid;
  Object.assign(client.pos, position);
  client.grounded = true;
  const server = new PlayerEntity('traversal', 'Traversal', position, false);
  Object.assign(server, { grounded: true, deployT: 0 });
  server.input = { yaw: -Math.PI / 2, pitch: 0, keys: {} };
  const ctx = { solidAt: solid, mapMeta, now: 0, onFall: () => assert.fail('unexpected fall') };
  function step(dt, { forward = false, jump = false, prone = false, crouch = false } = {}) {
    Object.assign(server.input.keys, { f: forward, jump, prone, crouch });
    client.wantProne = prone;
    client._crouching = crouch;
    client.step(dt, { x: forward ? 1 : 0, z: 0 }, crouch ? PHYSICS.crouch : PHYSICS.walk,
      jump, forward ? 1 : 0, -Math.PI / 2);
    ctx.now += dt * 1000;
    stepMovement(server, dt, ctx);
    // Prediction snaps sub-millimetre idle velocity to zero; authority decays it.
    assert.ok(Math.hypot(client.pos.x - server.x, client.pos.y - server.y, client.pos.z - server.z) < 0.001,
      `prediction/authority parity: ${JSON.stringify({ client: client.pos, server: [server.x, server.y, server.z] })}`);
    assert.equal(client.proneT, server.proneT);
    assert.equal(!!client.vault, !!server.vault);
    assert.equal(boxCollides(solid, server.x, server.y, server.z, stanceHeight(PHYSICS.height, server.proneT)), false);
  }
  return { client, server, ctx, step };
}

// One block wide and high. Include Dust II's terrain-step path as well as
// ordinary voxel movement, and traverse at render and server tick rates.
for (const hz of [20, 60, 120]) for (const mapMeta of [null, { id: 'dust2', spawnBounds: { surfaces: [] } }]) {
  const tunnel = (x, y, z) => floor(x, y) ||
    (x >= 20 && x <= 22 && (y >= 11 || z !== 24));
  const h = pair(tunnel, start, mapMeta);
  for (let i = 0; i < hz; i++) h.step(1 / hz, { forward: true });
  assert.ok(h.server.x < 20 - PHYSICS.halfW, 'standing body cannot enter');
  for (let i = 0; i < hz; i++) h.step(1 / hz, { forward: true, prone: true });
  assert.equal(h.server.proneT, 1);
  assert.ok(h.server.x > 20, 'lying down allows entry into a one-block opening');
  for (let i = 0; i < hz; i++) h.step(1 / hz, { jump: true, crouch: true });
  assert.equal(h.server.proneT, 1, 'standing/crouching/jumping cannot raise the body under the roof');
  assert.equal(h.server.y, 10);
  for (let i = 0; i < hz * 5; i++) {
    h.step(1 / hz, { forward: true });
    if (h.server.x - PHYSICS.halfW < 23) assert.equal(h.server.proneT, 1, 'the whole body must clear the exit');
  }
  assert.ok(h.server.x > 24, 'crawl movement remains possible with standing requested');
  assert.equal(h.server.proneT, 0, 'standing resumes after leaving the tunnel');
}

// Partial transitions still collide, and the reduced body also sweeps Z and Y.
for (const axis of ['x', 'z']) {
  const obstacle = (x, y, z) => y < 10 || (Math.floor(axis === 'x' ? x : z) >= 20 && y >= 11);
  const p = { x: 19.5, y: 10, z: 19.5 };
  assert.equal(slidePlayerAxis(p, axis, 2, obstacle, stanceHeight(PHYSICS.height, 0.25)), true);
  assert.ok(p[axis] < 20);
  assert.equal(slidePlayerAxis(p, axis, 2, obstacle, PRONE.height), false);
  assert.ok(p[axis] > 21);
}
{
  const h = pair((_x, y) => y < 10 || y >= 11, { ...start, x: 21 });
  h.client.proneT = h.server.proneT = 1;
  h.client.vel.y = h.server.vy = 8;
  for (let i = 0; i < 60; i++) h.step(1 / 60, { prone: true });
  assert.equal(h.server.y, 10, 'an upward impulse hits the low ceiling and lands on the floor');
  stepMovement(h.server, 1 / 60, { ...h.ctx, movementLocked: true });
  assert.equal(h.server.proneT, 1, 'round movement locks cannot stand the body through a roof');
}

// Hands busy blocks automatic, deliberate airborne and grounded grabs, while
// ordinary jumping stays available. The same setup must climb with free hands.
for (const airborne of [false, true]) for (const busy of ['reload', 'grenade', 'melee', 'deploy', 'medkit']) {
  const h = pair(wall, { ...start, y: airborne ? 10.5 : 10 });
  h.client.grounded = h.server.grounded = !airborne;
  h.client.climbBlocked = true;
  if (busy === 'reload') h.server.reloading = true;
  if (busy === 'grenade') h.server.input.grenadeHandling = true;
  if (busy === 'melee') h.server.quickMeleeT = 0.4;
  if (busy === 'deploy') h.server.deployT = 0.4;
  if (busy === 'medkit') h.server.medkit.active = true;
  h.step(1 / 60, { forward: true, jump: true });
  assert.equal(h.server.vault, null, `${busy} blocks ${airborne ? 'airborne' : 'grounded'} grab`);
  if (!airborne) assert.ok(h.server.vy > 0, 'a normal jump remains possible with occupied hands');
}
{
  const h = pair(wall);
  h.step(1 / 60, { forward: true, jump: true });
  assert.ok(h.server.vault, 'free hands can grab the same ledge');
  h.client.climbBlocked = h.server.reloading = true;
  h.step(1 / 60, { forward: true });
  assert.equal(h.server.vault, null, 'occupied hands interrupt an active pull-up');
}
{
  const h = pair(wall, { ...start, y: 10.5 });
  h.client.grounded = h.server.grounded = false;
  h.client.jumpGroundY = h.server.jumpGroundY = 10;
  h.client.climbBlocked = h.server.reloading = true;
  h.step(1 / 60, { forward: true });
  assert.equal(h.server.vault, null, 'automatic airborne grabs also respect reload');
}

const ladder = { ladders: [{ minX: 19, maxX: 21, minY: 10, maxY: 15, minZ: 24, maxZ: 25 }] };
for (const down of [false, true]) {
  const h = pair(floor, { ...start, y: down ? 12 : 10 }, ladder);
  h.client.grounded = h.server.grounded = !down;
  h.client.climbBlocked = h.server.reloading = true;
  h.step(1 / 60, { forward: !down, crouch: down });
  if (down) assert.ok(h.server.vy > -PHYSICS.gravity / 30, 'reload cannot engage ladder descent');
  else assert.equal(h.server.y, 10, 'reload cannot engage ladder ascent');
  h.client.climbBlocked = h.server.reloading = false;
  h.step(1 / 60, { forward: !down, crouch: down });
  assert.equal(h.server.vy, down ? -2.4 : 3.4, 'ladder movement returns when hands are free');
}

// Real R input, LocalPlayer frame order and WeaponState, including the server's
// movement-before-combat order and its held acknowledged reload request.
{
  let now = 2000;
  const input = new Input({});
  input.fallback = true;
  const h = pair(wall);
  const weapon = new WeaponState({ now: () => now,
    rig: { setWeapon() {}, fire: () => true, reload() {}, cancelReload() {}, ads() {}, pumpAnim() {}, boltAnim() {} },
    audio: { draw() {}, reloadClick() {}, fire() {} }, effects: { shoot() {} },
    feedback: { addExhaustion() {}, addRecoil() {} },
    network: { isRunning: () => true, isCurrentGeneration: () => true },
    setTimer: () => 0, clearTimer() {},
  });
  weapon.resetToLoadout();
  weapon._ammo.rifle.mag = h.server.mag[0] = 5;
  const player = new LocalPlayer({ input, physics: h.client });
  player.setGameplayInputEnabled(true);
  player.view.yaw = -Math.PI / 2;
  const event = code => ({ code, repeat: false, preventDefault() {} });
  try {
    for (const code of ['KeyR', 'KeyW', 'Space']) input._onKeyDown(event(code));
    player.update(1 / 60, now, { weapon, fireAllowed: true,
      onWeaponIntents: intents => weapon.applyIntents(intents, now, { allowFire: true, alive: true }),
    });
    assert.equal(weapon.isReloading, true);
    assert.equal(player.physics.vault, null, 'R blocks the very first predicted climb frame');
    h.server.input = { yaw: -Math.PI / 2, pitch: 0, reload: true, reloadId: weapon.reloadId,
      keys: { f: true, jump: true } };
    stepMovement(h.server, 1 / 60, h.ctx);
    assert.equal(h.server.vault, null, 'a new valid reload blocks movement before combat accepts it');
    resolveWeaponIntent(h.server, 1 / 60, { canUseWeapon: () => true, canFire: () => true });
    assert.equal(h.server.reloading, true);
    assert.ok(Math.abs(player.physics.pos.y - h.server.y) < 1e-8);
    updateTimers(h.server, 10);
    assert.equal(h.server.reloading, false);
    Object.assign(h.server, start, { grounded: true, vx: 0, vy: 0, vz: 0 });
    stepMovement(h.server, 1 / 60, h.ctx);
    assert.ok(h.server.vault, 'an old held reload packet cannot block a completed reload');

    now += 10000;
    weapon.tickReload(now);
    weapon.reconcileServer({ weapon: 0, reloading: false, reloadAck: weapon.reloadId, alive: true,
      mag: h.server.mag, reserve: h.server.reserve }, now);
    assert.equal(weapon.reloadRequested, false);
    input._onKeyUp(event('KeyR'));
    Object.assign(player.physics.pos, start);
    Object.assign(player.physics.vel, { x: 0, y: 0, z: 0 });
    player.physics.grounded = true;
    player.update(1 / 60, now, { weapon, fireAllowed: true });
    assert.ok(player.physics.vault, 'prediction can climb again after reload completion');
    player.physics.solid = (_x, y) => y < 10 || y >= 11;
    Object.assign(player.physics.pos, start);
    player.physics.proneT = 1;
    player.update(1 / 60, now, { weapon, fireAllowed: false, movementAllowed: false });
    assert.equal(player.physics.proneT, 1, 'client movement locks preserve headroom restrictions');
  } finally { player.dispose(); weapon.dispose(); input.dispose(); }
}

// Empty reserve and a full magazine are no-op reloads, not hand occupations.
for (const full of [false, true]) {
  const h = pair(wall);
  h.server.mag[0] = full ? h.server.def.magSize : 5;
  h.server.reserve[0] = 0;
  h.server.input.reload = true;
  stepMovement(h.server, 1 / 60, { ...h.ctx });
  h.server.input.keys = { f: true, jump: true };
  stepMovement(h.server, 1 / 60, h.ctx);
  assert.ok(h.server.vault, 'rejected reload requests leave hands available');
}
console.log('Traversal passed: one-block tunnels, headroom locks, stance collision, client/server parity, occupied hands, ladders and real reload input/recovery.');
