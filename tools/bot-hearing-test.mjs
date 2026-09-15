import assert from 'node:assert/strict';
import { hearNoise, noiseOf, GUNSHOT_RANGE, SPRINT_STEP_RANGE, WALK_STEP_RANGE, OCCLUDED_FACTOR } from '../server/bot-hearing.js';

const open = () => 0;
// A solid wall on the plane x = 10.
const wall = (x) => (Math.floor(x) === 10 ? 1 : 0);
const body = (x, over = {}) => ({ x, y: 1, eyeY: 2.6, z: 0, vx: 0, vz: 0, grounded: true, crouch: false, sprint: false, ...over });
const listener = body(0);

// Quiet bodies make no noise; walking, sprinting and shooting are graded.
assert.equal(noiseOf(body(5)), null, 'a standing body is silent');
assert.equal(noiseOf(body(5, { vx: 6, grounded: false })), null, 'airborne bodies do not step');
assert.equal(noiseOf(body(5, { vx: 6, crouch: true })), null, 'crouch-walking is silent');
assert.equal(noiseOf(body(5, { vx: 2 })), null, 'creeping below step speed is silent');
assert.equal(noiseOf(body(5, { vx: 4.4 })).range, WALK_STEP_RANGE, 'walking carries the short range');
assert.equal(noiseOf(body(5, { vx: 6.2, sprint: true })).range, SPRINT_STEP_RANGE, 'sprinting carries further');
assert.equal(noiseOf(body(5), true).kind, 'shot', 'a shot is heard even from a standing body');
assert.ok(GUNSHOT_RANGE > SPRINT_STEP_RANGE * 3, 'gunshots carry far beyond footsteps');

// Range, loudness and occlusion.
{
  const near = hearNoise(listener, body(6, { vx: 4.4 }), false, open);
  const far = hearNoise(listener, body(9.5, { vx: 4.4 }), false, open);
  assert.ok(near && far && near.loudness > far.loudness, 'closer steps are louder');
  assert.deepEqual(near.position, { x: 6, y: 1, z: 0 }, 'the heard position is the body, not the head');
  assert.equal(hearNoise(listener, body(WALK_STEP_RANGE + 1, { vx: 4.4 }), false, open), null, 'steps fade past their range');
  assert.ok(hearNoise(listener, body(WALK_STEP_RANGE + 1, { vx: 4.4 }), false, open, 1.3), 'a sharper-eared profile hears further');
  assert.ok(hearNoise(listener, body(50), true, open), 'a shot at 50 blocks is heard in the open');
  assert.equal(hearNoise(listener, body(50), true, wall), null, 'a wall halves the gunshot range');
  assert.ok(hearNoise(listener, body(GUNSHOT_RANGE * OCCLUDED_FACTOR - 1), true, wall), 'muffled shots are still heard up close');
  assert.equal(hearNoise(listener, body(14, { vx: 6.2, sprint: true }), false, wall), null, 'a wall hides distant sprinting');
}

console.log('ok: bot hearing grades shots, sprint and walk, fades with range and is muffled by walls');

// Engine integration: a bot that cannot see the shooter still walks toward
// the shot, and hears sprinting close behind a wall but not far behind it.
import { GameEngine } from '../server/game.js';
import { attachBots } from '../server/bots.js';
import { AIR, CONCRETE, GROUND } from '../shared/worlddata.js';
{
  const y = GROUND + 1.02;
  const blocks = new Set();
  const spawn = { x: 20.5, y, z: 30.5, index: 0 };
  const world = {
    meta: { id: 'foundry', spawns: { fun: [spawn] } },
    getBlock: (x, by, z) => by <= GROUND || blocks.has(`${x},${by},${z}`) ? CONCRETE : AIR,
    heightAt: () => GROUND,
    findSpawns: () => [spawn],
    setBlock: () => false,
  };
  for (let x = 0; x < 128; x++) for (let by = GROUND + 1; by <= GROUND + 3; by++) blocks.add(`${x},${by},25`);
  const engine = new GameEngine({ world, mode: 'fun' });
  engine.now = 100_000;
  const bots = attachBots(engine, 1);
  engine.addClient('human', 'Human');
  const bot = engine.entities.get('bot-0');
  const human = engine.entities.get('human');
  const brain = bots.brains[0];
  Object.assign(bot, { x: 20.5, y, z: 30.5, yaw: 0, pitch: 0, deployT: 0, spawnProtectedUntil: 0 });
  Object.assign(human, { x: 20.5, y, z: 20.5, yaw: 0, pitch: 0, spawnProtectedUntil: 0, grounded: true });
  const decide = (ms = 50) => {
    engine.now += ms;
    const input = bots.think(brain, bot, engine.now, ms / 1000);
    bot.yaw = input.yaw; bot.pitch = input.pitch;
    return input;
  };
  try {
    for (let i = 0; i < 6; i++) decide();
    assert.equal(brain.lastSeen, null, 'a silent hidden enemy leaves no memory');
    assert.equal(brain.state, 'roam');

    human.shotSeq++;
    for (let i = 0; i < 3; i++) decide();
    assert.ok(brain.lastSeen?.heard, 'a gunshot behind cover is heard');
    assert.deepEqual(brain.lastSeen.position, { x: 20.5, y, z: 20.5 }, 'the shot is placed at the shooter');
    assert.equal(brain.state, 'search', 'the bot investigates the shot');
    const heardUntil = brain.lastSeen.until;
    for (let i = 0; i < 6; i++) decide();
    assert.equal(brain.lastSeen.until, heardUntil, 'a shooter that fell silent does not refresh the memory');

    // Footsteps: turn the bot away so nothing is visible once the wall goes.
    engine.now = heardUntil;
    decide();
    assert.equal(brain.lastSeen, null, 'the heard shot is forgotten after the search window');
    blocks.clear();
    bot.yaw = Math.PI; // facing +z, human is at -z
    Object.assign(human, { vx: 6.2, vz: 0, sprint: true, grounded: true });
    for (let i = 0; i < 3; i++) decide();
    assert.ok(brain.lastSeen?.heard, 'sprinting ten blocks behind the bot is heard in the open');
    let turned = false;
    for (let i = 0; i < 20; i++) turned = Math.abs(decide().yaw) < 0.5 || turned;
    assert.ok(turned, 'the bot turns toward the footsteps');

    Object.assign(human, { vx: 0, sprint: false });
    engine.now += 3000;
    decide();
    assert.equal(brain.lastSeen, null, 'footstep memory is short');
    for (let x = 0; x < 128; x++) for (let by = GROUND + 1; by <= GROUND + 3; by++) blocks.add(`${x},${by},25`);
    bot.yaw = Math.PI;
    Object.assign(human, { vx: 6.2, sprint: true });
    for (let i = 0; i < 6; i++) decide();
    assert.equal(brain.lastSeen, null, 'a wall muffles sprinting ten blocks away');
    human.z = 24.5;
    for (let i = 0; i < 3; i++) decide();
    assert.ok(brain.lastSeen?.heard, 'sprinting right behind the wall is still heard');
  } finally { bots.dispose(); engine.stop(); }
}
console.log('ok: idle bots investigate shots and nearby footsteps, walls muffle them');
