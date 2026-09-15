import assert from 'node:assert/strict';
import * as THREE from '../public/js/vendor/three.module.js';
import { AvatarRoster } from '../public/js/avatar/avatar-roster.js';

const context = new Proxy({ measureText: () => ({ width: 60 }) },
  { get: (target, key) => target[key] ?? (() => {}) });
globalThis.document = { createElement: () => ({ getContext: () => context }) };

const CORPSE_SECONDS = 10;
const row = (state, extra = {}) => ({
  id: 'remote', name: 'Remote', team: null, x: 4, y: 1, z: 4, yaw: 0, pitch: 0,
  hp: state === 'alive' ? 100 : 0, state, weapon: 0, ads: false, grounded: true,
  vaulting: false, ...extra,
});

function fixture() {
  const scene = new THREE.Scene();
  let now = 0;
  // Solid ground under the body, so the loose pieces land instead of falling forever.
  const roster = new AvatarRoster({ scene, now: () => now, getMyId: () => 'local',
    getBlock: (x, y) => y < 1 });
  return {
    roster,
    scene,
    frame(state, dt = 1 / 60, extra) {
      now += dt * 1000;
      roster.sync(new Map([['remote', row(state, extra)]]), dt, now, false);
    },
    run(state, seconds) {
      for (let i = 0; i < Math.round(seconds * 60); i++) this.frame(state);
    },
    bodies: () => scene.children.length,
  };
}

// --- a killed player leaves a body that outlives their respawn --------------
{
  const run = fixture();
  run.frame('alive');
  assert.equal(run.bodies(), 1, 'a live player has one avatar in the scene');
  const living = run.roster._avatars.get('remote');

  run.frame('dead');
  assert.equal(run.roster._avatars.has('remote'), false,
    'the killed avatar is detached from its player');
  assert.equal(run.roster._corpses.size, 1, 'the body moves to the corpse pool');
  assert.equal(run.roster._corpses.get('remote').avatar, living,
    'the corpse is the very body that was killed, with its own kit and weapon');
  assert.equal(run.bodies(), 1, 'the body stays in the scene');

  // Most modes respawn within a couple of seconds. The body must not go with it.
  run.run('dead', 1.5);
  run.frame('alive');
  assert.equal(run.roster._avatars.has('remote'), true, 'the player comes back alive');
  assert.equal(run.roster._corpses.size, 1, 'their old body is still lying there');
  assert.equal(run.bodies(), 2, 'the scene holds the respawned player and the corpse');
  assert.notEqual(run.roster._avatars.get('remote'), living,
    'the respawned player gets a fresh avatar, not the corpse');

  // Once the pieces have come to rest the body stops simulating, so a screen
  // full of corpses costs no physics.
  const settledFrames = () => {
    let frames = 0;
    while (frames < 600 && !run.roster._corpses.get('remote')?.settled) { run.frame('alive'); frames++; }
    return frames;
  };
  const restFrames = settledFrames();
  assert.ok(restFrames > 0 && restFrames < 600, 'the loose pieces come to rest on their own');

  run.run('alive', 7.8 - restFrames / 60);
  assert.equal(run.roster._corpses.size, 1,
    `the body is still there most of its ${CORPSE_SECONDS} seconds`);
  const corpse = run.roster._corpses.get('remote').avatar;
  assert.ok(corpse.fadeMaterials.every(material => material.opacity < 1),
    'the body has started to fade out by then');

  run.run('alive', 1);
  assert.equal(run.roster._corpses.size, 0, `the body is gone after ${CORPSE_SECONDS} seconds`);
  assert.equal(run.bodies(), 1, 'only the living player is left in the scene');
  run.roster.dispose();
}

// --- the pool cannot grow without bound ------------------------------------
{
  const run = fixture();
  for (let life = 0; life < 4; life++) {
    run.frame('alive');
    run.frame('dead');
    run.run('dead', 0.5);
  }
  assert.equal(run.roster._corpses.size, 1, 'one player leaves at most one body behind');
  assert.equal(run.bodies(), 1, 'dropped bodies leave the scene with their avatar');
  run.frame('alive');
  run.roster.dispose();
  assert.equal(run.bodies(), 0, 'disposal takes the corpses with it');
}

// --- a dead player who was never seen alive does not spawn a live avatar ----
{
  const run = fixture();
  run.frame('dead');
  assert.equal(run.roster._corpses.size, 1, 'a row seen only as dead still drops its body');
  run.run('dead', 2);
  assert.equal(run.roster._avatars.size, 0,
    'no live avatar is rebuilt for a row that is still dead');
  run.roster.dispose();
}

console.log(`Corpse lifetime: bodies detach from their player, outlive the respawn, `
  + `fade out and vanish after ${CORPSE_SECONDS}s, stay one per player, and dispose cleanly.`);
