import assert from 'node:assert/strict';
import * as THREE from '../public/js/vendor/three.module.js';
import { NetClient } from '../public/js/engine/netclient.js';
import { AvatarRoster } from '../public/js/avatar/avatar-roster.js';
import { goreProfile } from '../public/js/weapons/gore-profile.js';

const originalDocument = globalThis.document;
const context = new Proxy({ measureText: () => ({ width: 60 }) },
  { get: (target, key) => target[key] ?? (() => {}) });
globalThis.document = { createElement: () => ({ getContext: () => context }) };

const alive = { id: 'remote', name: 'Remote', team: null, x: 4, y: 1, z: 4,
  yaw: 0, pitch: 0, hp: 100, state: 'alive', weapon: 0, ads: false, grounded: true, vaulting: false };
const dead = { ...alive, x: 4.2, hp: 0, state: 'dead' };
const deathEvents = [
  { kind: 'hit', victim: 'remote', vx: 4.2, vy: 2, vz: 4, healthDamage: 300, overkill: 200, lethal: true },
  { kind: 'die', id: 'remote', healthDamage: 300, overkill: 200, lethal: true },
  { kind: 'kill', victim: 'remote', healthDamage: 300, overkill: 200, lethal: true },
];

function fixture() {
  let now = 0;
  let previousTime = 0;
  const gore = [];
  const net = new NetClient(); net.id = 'local';
  const roster = new AvatarRoster({ scene: new THREE.Scene(), now: () => now,
    gore: (event, options) => gore.push({ at: now, event, profile: goreProfile(event, options) }) });
  net.on('hit', event => roster.hit(event.victim, event));
  net.on('die', event => roster.death(event.id, undefined, event));
  net.on('kill', event => roster.death(event.victim, undefined, event));
  net.on('respawn', event => roster.respawn(event.id, event));
  return {
    net, roster, gore,
    snapshot(at, row, events = []) {
      const snapshot = { now: at, snapSeq: net.latestSnapshots.length + 1, players: [row], events };
      net.latestSnapshots.push(snapshot);
      net._playerIndexes.set(snapshot, new Map([[row.id, row]]));
    },
    frame(at) {
      now = at;
      const view = net.interpolate(at, 0);
      roster.sync(view.players, Math.min(0.05, Math.max(0, at - previousTime) / 1000), at);
      previousTime = at;
      return view;
    },
  };
}

try {
  const run = fixture();
  run.snapshot(100, alive);
  run.frame(100);
  run.snapshot(150, dead, deathEvents);
  for (const at of [125, 149.999]) {
    const view = run.frame(at);
    assert.equal(view.players.get('remote').state, 'alive', 'future death row cannot beat its hit metadata');
    assert.equal(view.players.get('remote').hp, 100, 'health belongs to the same life as the presented state');
    assert.equal(view.players.get('remote').x, alive.x, 'lifecycle transition does not move the old life early');
    assert.equal(view.events.length, 0);
    assert.equal(run.gore.length, 0, 'no baseline gore can consume the death before its event');
  }
  const death = run.frame(150);
  assert.equal(death.players.get('remote').state, 'dead');
  assert.equal(death.events.length, 3);
  assert.equal(run.gore.length, 1, 'hit/die/kill and dead row produce one lethal splatter');
  assert.equal(run.gore[0].event.overkill, 200);
  assert.equal(run.gore[0].profile.mistCount, 88, 'actual routed excess selects high-overkill splatter');
  run.frame(175);
  assert.equal(run.gore.length, 1, 'repeated interpolation cannot replay death');

  const respawn = { ...alive, x: 30, z: 25 };
  run.snapshot(1650, respawn, [{ kind: 'respawn', id: 'remote', x: 30, y: 1, z: 25 }]);
  const waiting = run.frame(1600);
  assert.equal(waiting.players.get('remote').state, 'dead', 'respawn waits for its event time too');
  assert.equal(waiting.players.get('remote').x, dead.x, 'corpse cannot teleport to the next spawn early');
  const fresh = run.frame(1650);
  assert.equal(fresh.players.get('remote').state, 'alive');
  assert.equal(fresh.players.get('remote').x, 30);
  assert.equal(run.gore.length, 1);
  run.roster.dispose();

  const first = fixture();
  first.snapshot(100, dead, deathEvents);
  const early = first.frame(75);
  assert.equal(early.players.has('remote'), false, 'first appearance of a dead avatar waits for its events');
  assert.equal(first.gore.length, 0);
  first.frame(100);
  assert.equal(first.gore.length, 1, 'pending death is presented when its first row arrives');
  assert.equal(first.gore[0].event.overkill, 200);
  first.roster.dispose();

  const movement = fixture();
  movement.snapshot(100, alive);
  movement.snapshot(150, { ...alive, x: 5, yaw: 0.2, pitch: 0.1, ads: true, grounded: false, vaulting: true });
  const moving = movement.frame(125).players.get('remote');
  assert.equal(moving.x, 4.5, 'ordinary live movement keeps interpolation');
  assert.ok(Math.abs(moving.yaw - 0.1) < 1e-10 && Math.abs(moving.pitch - 0.05) < 1e-10,
    'ordinary live gun aim keeps interpolation');
  assert.equal(moving.ads, true);
  assert.equal(moving.grounded, false);
  assert.equal(moving.vaulting, true, 'ordinary live stance flags keep the existing newest-row contract');
  movement.roster.dispose();
} finally {
  if (originalDocument === undefined) delete globalThis.document;
  else globalThis.document = originalDocument;
}

console.log('Remote death timing: high-overkill event routing, one death burst, exact lifecycle boundaries, initial dead row and live movement interpolation passed.');
