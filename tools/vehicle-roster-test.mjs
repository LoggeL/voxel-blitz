import assert from 'node:assert/strict';
import * as THREE from '../public/js/vendor/three.module.js';
import { AvatarRoster } from '../public/js/avatar/avatar-roster.js';
import { BASTION_ENEMIES } from '../shared/bastion.js';

const context = new Proxy({ measureText: () => ({ width: 60 }) },
  { get: (target, key) => target[key] ?? (() => {}) });
globalThis.document = { createElement: () => ({ getContext: () => context }) };

const ROLE = 'apc';
const CORPSE_SECONDS = 10;
const row = (state, extra = {}) => ({
  id: 'hull', name: 'APC', team: 'bravo', x: 4, y: 1, z: 4, yaw: 0, pitch: 0,
  hp: state === 'alive' ? BASTION_ENEMIES[ROLE].hp : 0, state, weapon: 0,
  npcVehicle: true, npcRole: ROLE, ...extra,
});

function fixture() {
  const scene = new THREE.Scene();
  let now = 0;
  const drone = [];
  const gore = [];
  const roster = new AvatarRoster({ scene, now: () => now, getMyId: () => 'local',
    getBlock: (x, y) => y < 1,
    gore: (impact, options) => gore.push(options),
    vehicle: (id, pos, kind) => drone.push({ id, pos, kind }) });
  return {
    roster, scene, drone, gore,
    frame(state, extra, dt = 1 / 60) {
      now += dt * 1000;
      const remotes = state ? new Map([['hull', row(state, extra)]]) : new Map();
      roster.sync(remotes, dt, now, false);
    },
    run(state, seconds) {
      for (let i = 0; i < Math.round(seconds * 60); i++) this.frame(state);
    },
    starts: () => drone.filter(call => call.pos).length,
    stops: () => drone.filter(call => call.pos === null).length,
  };
}

// --- a live vehicle hums, shows its role health, and dies without gore ------
{
  const run = fixture();
  run.frame('alive');
  const hull = run.roster._avatars.get('hull');
  assert.equal(hull?.vehicle, true, 'a vehicle row builds a vehicle presenter, not an operator');
  assert.equal(hull.alive, true, 'the vehicle comes up alive');
  let health = null;
  hull.updateHealth = (t01) => { health = t01; };
  run.frame('alive', { hp: BASTION_ENEMIES[ROLE].hp / 2 });
  assert.equal(health, 0.5, 'the hp bar is scaled by the role hp from shared/bastion.js');
  run.run('alive', 0.5);
  assert.equal(run.stops(), 0, 'no drone stop while the vehicle lives');
  assert.ok(run.starts() >= 30, 'the drone is refreshed every frame the vehicle is alive');
  assert.deepEqual(run.drone.at(-1), { id: 'hull', pos: [4, 1, 4], kind: ROLE },
    'the drone follows the authoritative row position and role');

  const starts = run.starts();
  run.frame('dead');
  assert.equal(run.stops(), 1, 'death stops the drone once');
  assert.equal(run.gore.length, 0, 'a destroyed hull sprays no blood');
  assert.equal(run.roster._avatars.has('hull'), false, 'the wreck is detached from its row');
  assert.equal(run.roster._corpses.get('hull')?.avatar, hull, 'the wreck moves to the corpse pool');
  assert.equal(hull.limbStates.length, 0, 'the hull gets no humanoid limb physics');

  run.run('dead', CORPSE_SECONDS + 2);
  assert.equal(run.starts(), starts, 'a dead vehicle never restarts its drone');
  assert.equal(run.gore.length, 0, 'the wreck is not rebuilt and destroyed again after it fades');
  assert.equal(run.roster._corpses.size, 0, 'the wreck fades out after the corpse lifetime');
  assert.equal(run.roster._avatars.size, 0, 'the still-dead row gets no new hull');
  assert.equal(run.scene.children.length, 0, 'nothing is left in the scene');
  run.roster.dispose();
}

// --- a row that leaves, and disposal, silence remaining drones -----------------
{
  const run = fixture();
  run.frame('alive');
  run.frame(null);
  assert.equal(run.stops(), 1, 'a vehicle that leaves the snapshot stops its drone');
  assert.equal(run.scene.children.length, 0, 'and leaves the scene');
  run.frame('alive');
  run.roster.dispose();
  assert.equal(run.stops(), 2, 'disposal stops the drone of a live vehicle');
  assert.equal(run.scene.children.length, 0, 'disposal clears the scene');
}

console.log('Vehicle roster: role hp bar, per-frame drone, gore-free wreck, one corpse per death, '
  + 'and drone stops on death, leave and dispose passed.');
