import assert from 'node:assert/strict';
import * as THREE from '../public/js/vendor/three.module.js';
import { VehicleView } from '../public/js/engine/vehicle-view.js';
import { ExplosionFX, BLAST_CAPACITY } from '../public/js/weapons/explosion-fx.js';
import {
  VehicleDestructionFX, VEHICLE_DEBRIS_CAPACITY, VEHICLE_EMBER_CAPACITY, VEHICLE_EVENT_CAPACITY,
  VEHICLE_FRAGMENT_CAPACITY, VEHICLE_FRAGMENTS_PER_BURST, VEHICLE_LOW_FRAGMENTS_PER_BURST,
} from '../public/js/vehicles/vehicle-destruction-fx.js';
import { createVehicleFragments, disposeVehicleFragment, fragmentMaterial } from '../public/js/vehicles/vehicle-fragments.js';
import { VEHICLE_DESTRUCTION_STYLE } from '../public/js/vehicles/vehicle-destruction-fx.js';
import { ParticleField } from '../public/js/fx/particle-field.js';
import { CameraShake } from '../public/js/engine/camera-shake.js';
import { VEHICLE_RULES } from '../shared/vehicles.js';
import { NetClient, RING_LEN } from '../public/js/engine/netclient.js';
import { VEHICLE_VIEW } from '../public/js/engine/vehicle-view.js';
import { Session } from '../public/js/session/session.js';

// Only operator labels need a canvas. Models, materials, particles and explosions are real.
globalThis.document = { createElement: () => ({ getContext: () => new Proxy({}, {
  get: (object, key) => object[key] ?? (() => {}),
}) }) };

const primary = (vehicleId = 'plane-1', extra = {}) => ({
  kind: 'vehicle_destroyed', vehicleId, vehicleType: 'plane',
  pos: [10, 30, 10], velocity: [12, -3, 1], blastRadius: 7, ...extra,
});
const secondary = (vehicleId = 'plane-1', extra = {}) => ({
  kind: 'explosion', type: 'vehicle', vehicleId, vehicleType: 'plane', pos: [10, 31, 10], r: 7, ...extra,
});
const active = pool => pool.filter(particle => particle.active);
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-8, message);
const step = (fx, seconds) => {
  for (let frame = 0; frame < Math.ceil(seconds * 60); frame++) fx.update(1 / 60);
};

function resources(root, extras = []) {
  const found = new Set(extras);
  root.traverse(node => {
    if (node.geometry && !node.geometry.userData.pageOwned) found.add(node.geometry);
    for (const material of [].concat(node.material || [])) {
      if (!material || material.userData.pageOwned) continue;
      found.add(material);
      for (const value of Object.values(material)) if (value?.isTexture && !value.userData.pageOwned) found.add(value);
      for (const uniform of Object.values(material.uniforms || {})) {
        if (uniform?.value?.isTexture && !uniform.value.userData.pageOwned) found.add(uniform.value);
      }
    }
  });
  return found;
}

function watchDisposals(found) {
  const counts = new Map([...found].map(resource => [resource, 0]));
  for (const resource of found) resource.addEventListener('dispose', () => counts.set(resource, counts.get(resource) + 1));
  return expected => {
    for (const [resource, count] of counts) assert.equal(count, expected, `${resource.type || resource.constructor.name} disposed ${expected} times`);
  };
}

function finiteParticles(fx) {
  for (const particle of [...active(fx.debris), ...active(fx.embers)]) {
    assert.ok(['x', 'y', 'z', 'vx', 'vy', 'vz'].every(key => Number.isFinite(particle[key])), 'active particle stays finite');
  }
  for (const [mesh, capacity] of [[fx.debrisMesh, VEHICLE_DEBRIS_CAPACITY], [fx.emberMesh, VEHICLE_EMBER_CAPACITY]]) {
    assert.ok(mesh.isInstancedMesh, 'vehicle fragments share an instanced batch');
    assert.ok(mesh.count >= 0 && mesh.count <= capacity, 'draw count stays inside the fixed pool');
    const matrix = new THREE.Matrix4();
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, matrix);
      assert.ok(matrix.elements.every(Number.isFinite), 'drawn particle has a finite transform');
    }
  }
}

// Use the real subscription registry and presentation drain. A direct FX call
// cannot catch an event omitted from Session's gameplay subscriptions.
function networkHarness() {
  const scene = new THREE.Scene(), explosions = new ExplosionFX(scene), view = new VehicleView(); scene.add(view.group);
  const fx = new VehicleDestructionFX(scene, { explosions,
    getFragments: (id, options) => view.destructionFragments(id, options) });
  const net = new NetClient(), delivered = [], accepted = [];
  const session = Object.create(Session.prototype);
  Object.assign(session, {
    _pregame: { net }, _gameplayUnsubs: [], _gameplayEventsWired: false,
    _liveResourcesOwned: true, _tornDown: false, _phase: 'live',
    onGameplayEvent(event) { delivered.push(event.kind); accepted.push(fx.handleEvent(event)); },
    onTick(snapshot) { view.sync(snapshot.vehicles, snapshot.players, null, {events: snapshot.events, snapSeq: snapshot.snapSeq}); fx.sync(snapshot.vehicles); },
  });
  session._attachGameplayListeners(net);
  return { scene, explosions, fx, view, net, session, delivered, accepted,
    receive(now, vehicles, events = [], players = []) { net._onTick({ now, players, vehicles, events }); },
    present() { return net.interpolate(net.latestSnapshots.at(-1).now, 0); },
    dispose() { session._detachGameplayListeners(); fx.dispose(); view.dispose(); explosions.dispose(); net.close(); },
  };
}


// The raw receipt and delayed presentation use the real NetClient/Session
// pipeline. Moving wreck ticks must neither detach early nor move the eventual
// fragment source ahead of the authoritative blast position.
{
  const h = networkHarness();
  const row = {id: 'delayed-plane', type: 'plane', team: 'alpha', x: 96, y: 42, z: 120,
    yaw: .7, pitch: .2, roll: -.4, hp: VEHICLE_RULES.plane.hp, enginePower: 1, grounded: false};
  h.receive(1000, [row]); h.present(); h.view.update(.1);
  const item = h.view.items.get(row.id), sources = item.model.fragmentSources();
  const intactQuaternion = item.root.quaternion.clone(), intactPosition = item.root.position.clone();
  const intactTriangles = visibleTriangles(item);
  const pair = [primary(row.id, {pos: [100, 42, 120]}),
    secondary(row.id, {pos: [100, 42 + VEHICLE_RULES.plane.height * .5, 120]})];
  h.receive(1050, [{...row, x: 104, y: 40, yaw: 1.2, pitch: -.3, roll: .6, hp: 0, wreck: true}], pair);
  const deathTime = h.net.latestSnapshots.at(-1).now;
  assert.equal(item.wreck, false, 'raw death receipt does not prematurely char or detach the visible hull');
  assert.ok(item.pendingDestruction, 'the exact owning snapshot defers its destruction');
  assert.equal(visibleTriangles(item), intactTriangles, 'every break-away part stays attached until presentation');
  h.receive(1100, [{...row, x: 108, y: 38, yaw: 1.3, pitch: -.4, roll: .7, hp: 0, wreck: true}]);
  for (let frame = 0; frame < 15; frame++) h.view.update(1 / 60);
  assert.ok(item.root.position.equals(intactPosition) && item.root.quaternion.equals(intactQuaternion),
    'future moving-wreck rows retain the original visible pose while their destruction is queued');
  h.net.interpolate(deathTime - .01, 0);
  assert.equal(h.fx.stats.bursts, 0); assert.equal(h.fx.stats.fragments, 0);
  h.net.interpolate(deathTime, 0);
  assert.equal(h.fx.stats.bursts, 1);
  assert.equal(h.fx.stats.fragments, Math.min(sources.length, VEHICLE_FRAGMENTS_PER_BURST), 'every tagged voxel chunk breaks away');
  assert.equal(item.wreck, true); assert.equal(item.pendingDestruction, null);
  assert.ok(item.root.position.equals(new THREE.Vector3(100, 42, 120)) && item.root.quaternion.equals(intactQuaternion),
    'the presented wreck and burst meet at the authoritative event pose');
  assert.ok(visibleTriangles(item) < intactTriangles, 'the wreck geometry drops the chunks in the same step');
  // Each chunk starts exactly where its part sat on the posed hull.
  item.root.updateMatrixWorld(true);
  for (const particle of active(h.fx.fragments)) {
    const piece = particle.fragment, source = sources.find(entry => entry.tag === piece.name);
    const geometry = item.model.fragmentGeometry(source), pivot = source.node.userData.pivot;
    const expected = new THREE.Vector3(geometry.center[0] - pivot[0], geometry.center[1] - pivot[1], geometry.center[2] - pivot[2])
      .applyMatrix4(source.node.matrixWorld);
    assert.ok(piece.object.position.distanceTo(expected) < 1e-5, `${piece.name} starts at its posed part`);
  }
  const shared = new Set(active(h.fx.fragments).map(particle => particle.fragment.geometry));
  const checkShared = watchDisposals(shared);
  h.view.update(.1);
  assert.ok(item.root.position.x > 100 && item.root.position.y < 42, 'after detachment the wreck follows subsequent authoritative motion');
  h.receive(1150, [row]); h.present();
  assert.equal(item.wreck, false);
  assert.equal(visibleTriangles(item), intactTriangles, 'the next life restores the intact hull');
  step(h.fx, 14);
  assert.equal(h.fx.stats.fragments, 0);
  checkShared(0);
  h.dispose();
  checkShared(0);
}

function visibleTriangles(item) {
  let triangles = 0;
  item.model.group.traverse(node => {
    if (node.isMesh && node.visible && !node.isInstancedMesh && node.geometry.userData.vehicleVoxel) triangles += node.geometry.userData.triangles;
  });
  return triangles;
}


// A newer live snapshot invalidates destruction still queued for the old life.
// Both members of its paired event must leave the respawn and FX pools intact.
for (const withSeq of [true, false]) {
  const h = networkHarness();
  const row = {id: 'fast-respawn', type: 'jeep', team: 'alpha', x: 80, y: 11, z: 70, yaw: .3, hp: VEHICLE_RULES.jeep.hp};
  h.receive(1000, [row]); h.present();
  const pair = [primary(row.id, {...(withSeq ? {seq: 201} : {}), vehicleType: row.type, pos: [80, 11, 70]}),
    secondary(row.id, {...(withSeq ? {seq: 202} : {}), vehicleType: row.type, pos: [80, 11 + VEHICLE_RULES.jeep.height * .5, 70]})];
  h.receive(1050, [{...row, hp: 0, wreck: true}], pair);
  const item = h.view.items.get(row.id), deathTime = h.net.latestSnapshots.at(-1).now;
  assert.ok(item.pendingDestruction);
  h.receive(1100, [{...row, x: 140}]);
  assert.equal(item.pendingDestruction, null); assert.equal(item.wreck, false);
  h.net.interpolate(deathTime, 0);
  assert.deepEqual(h.accepted, [false, false], 'both delayed events belonging to the cancelled life are rejected');
  assert.equal(h.fx.stats.bursts, 0); assert.equal(h.fx.stats.fragments, 0); assert.equal(h.explosions.blasts.length, 0);
  assert.equal(item.wreck, false);
  const fresh = pair.map(event => ({...event, ...(withSeq ? {seq: event.seq + 10} : {}), pos: event.pos.map((value, i) => i === 0 ? 140 : value)}));
  h.receive(1150, [{...row, x: 140, hp: 0, wreck: true}], fresh); h.present();
  assert.equal(h.fx.stats.bursts, 1, 'a distinct next-life event still explodes normally');
  assert.equal(item.wreck, true);
  h.dispose();
}

// A destruction whose owning snapshot leaves NetClient's ring undrained (a long
// boot replay, a hidden tab without rAF) can never be presented. The hull must
// still turn into a wreck with its exposed crew gone instead of freezing intact.
assert.equal(VEHICLE_VIEW.destructionHorizon, RING_LEN, 'the view horizon matches the NetClient snapshot ring');
for (const withSnapSeq of [true, false]) {
  const h = networkHarness();
  if (!withSnapSeq) h.session.onTick = snapshot => { h.view.sync(snapshot.vehicles, snapshot.players, null, {events: snapshot.events}); h.fx.sync(snapshot.vehicles); };
  const driver = {id: 'pad-driver', team: 'alpha', state: 'alive', hp: 100, vehicleId: 'evicted-jeep', vehicleSeatId: 'driver', x: 80, y: 11, z: 70};
  const row = {id: 'evicted-jeep', type: 'jeep', team: 'alpha', x: 80, y: 11, z: 70, yaw: .3, hp: VEHICLE_RULES.jeep.hp, seatOccupants: {driver: driver.id}};
  h.receive(1000, [row], [], [driver]); h.present();
  const item = h.view.items.get(row.id);
  assert.equal(item.crew.size, 1, 'the exposed driver is seated');
  const pair = [primary(row.id, {seq: 401, vehicleType: row.type, pos: [80, 11, 70]}),
    secondary(row.id, {seq: 402, vehicleType: row.type, pos: [80, 11 + VEHICLE_RULES.jeep.height * .5, 70]})];
  const wreckRow = {...row, hp: 0, wreck: true, seatOccupants: {}};
  h.receive(1050, [wreckRow], pair, [{...driver, state: 'dead', vehicleId: null, vehicleSeatId: null}]);
  assert.ok(item.pendingDestruction, 'the owning snapshot defers its destruction');
  // No presentation frame runs while the ring rolls past the owning snapshot.
  for (let tick = 1; tick < RING_LEN; tick++) h.receive(1050 + tick * 16, [wreckRow]);
  assert.ok(item.pendingDestruction, 'still drainable while the owning snapshot is in the ring');
  assert.ok(h.net.latestSnapshots.some(snapshot => snapshot.events?.length));
  h.receive(1050 + RING_LEN * 16, [wreckRow]);
  assert.ok(!h.net.latestSnapshots.some(snapshot => snapshot.events?.length), 'the owning snapshot left the ring undrained');
  assert.equal(item.pendingDestruction, null, `${withSnapSeq ? 'snapSeq' : 'sync count'}: an evicted destruction stops freezing the hull`);
  assert.equal(item.wreck, true, 'the hull presents as a wreck');
  assert.equal(item.crew.size, 0, 'the exposed crew leaves the wreck');
  h.present();
  assert.equal(h.fx.stats.bursts, 0, 'no stale burst replays');
  assert.equal(h.view.destructionFragments(row.id, {event: pair[0]}), false, 'a stray late copy of the evicted event is rejected');
  h.receive(2000, [row], [], [driver]); h.present();
  assert.equal(item.wreck, false, 'the respawn still restores the hull');
  h.dispose();
}

const networkVehicle = { id: 'plane-1', type: 'plane', hp: VEHICLE_RULES.plane.hp };
const networkPair = (id = 'plane-1', seq = 11) => [primary(id, { seq }), secondary(id, { seq: seq + 1 })];

// Actual NetClient -> Session -> FX delivery includes both events once, and
// vehicle lifecycle snapshots reach FX without replaying late-join wrecks.
{
  const h = networkHarness();
  h.receive(1000, [{...networkVehicle, hp: 0, wreck: true}]); h.present();
  assert.equal(h.fx.stats.bursts, 0, 'an actual late-join wreck tick never replays destruction');
  h.receive(1050, [networkVehicle]); h.present();
  h.receive(1100, [{...networkVehicle, hp: 0}], networkPair());
  assert.deepEqual(h.delivered, [], 'receiving a tick waits for the presentation clock');
  h.net.interpolate(h.net.latestSnapshots.at(-1).now - .01, 0);
  assert.deepEqual(h.delivered, [], 'destruction stays gated until its owning snapshot is visible');
  assert.equal(h.fx.stats.bursts, 0);
  const shown = h.present();
  assert.deepEqual(shown.events.map(event => event.kind), ['vehicle_destroyed', 'explosion']);
  assert.deepEqual(h.delivered, ['vehicle_destroyed', 'explosion'],
    'both authoritative event kinds cross the actual Session subscription registry');
  assert.deepEqual(h.accepted, [true, false]);
  assert.equal(h.fx.stats.bursts, 1, 'the published event pair creates exactly one visible burst');
  assert.equal(h.explosions.blasts.length, 1);
  assert.ok(h.fx.stats.debris > 0 && h.fx.stats.embers > 0);
  for (let frame = 0; frame < 30; frame++) h.present();
  h.receive(1150, [{...networkVehicle, hp: 0, wreck: true}], networkPair()); h.present();
  assert.deepEqual(h.delivered, ['vehicle_destroyed', 'explosion'],
    'repeated frames and repeated wire event sequences never call gameplay handlers again');
  assert.equal(h.fx.stats.bursts, 1);
  h.receive(1200, [networkVehicle]); h.present();
  assert.equal(h.fx.stats.bursts, 1, 'a real respawn tick re-arms without creating a burst');
  h.receive(1250, [{...networkVehicle, hp: 0}], networkPair('plane-1', 21)); h.present();
  assert.deepEqual(h.delivered, ['vehicle_destroyed', 'explosion', 'vehicle_destroyed', 'explosion']);
  assert.deepEqual(h.accepted, [true, false, true, false]);
  assert.equal(h.fx.stats.bursts, 2, 'the next authoritative life creates one new burst');
  h.dispose();
}

// Session ownership guards apply at delivery time to already queued snapshots.
for (const guard of ['old-net', 'released-resources', 'torn-down']) {
  const h = networkHarness();
  h.receive(1000, [{...networkVehicle, hp: 0}], networkPair());
  if (guard === 'old-net') h.session._pregame.net = new NetClient();
  if (guard === 'released-resources') h.session._liveResourcesOwned = false;
  if (guard === 'torn-down') h.session._tornDown = true;
  const shown = h.present();
  assert.equal(shown.events.length, 2, `${guard}: events reach the real presentation drain`);
  assert.deepEqual(h.delivered, [], `${guard}: queued events cannot cross Session's ownership guard`);
  assert.equal(h.fx.stats.bursts, 0); assert.equal(h.fx.stats.debris + h.fx.stats.embers, 0);
  assert.equal(h.explosions.blasts.length, 0);
  h.dispose();
}
{
  const h = networkHarness();
  h.receive(1000, [{...networkVehicle, hp: 0}], networkPair());
  h.session._detachGameplayListeners();
  assert.equal(h.session._gameplayUnsubs.length, 0);
  h.present();
  h.receive(1050, [{...networkVehicle, id: 'later', hp: 0}], networkPair('later', 21)); h.present();
  assert.deepEqual(h.delivered, [], 'detaching suppresses both queued and subsequently received events');
  assert.equal(h.fx.stats.bursts, 0); assert.equal(h.explosions.blasts.length, 0);
  h.dispose();
}
{
  const h = networkHarness();
  h.receive(1000, [{...networkVehicle, hp: 0}], networkPair());
  h.fx.dispose();
  h.present();
  assert.deepEqual(h.delivered, ['vehicle_destroyed', 'explosion'], 'disposed FX may still be reached by a queued callback');
  assert.deepEqual(h.accepted, [false, false], 'disposed FX rejects queued delivery without touching released buffers');
  assert.equal(h.fx.stats.bursts, 0); assert.equal(h.fx.stats.debris + h.fx.stats.embers, 0);
  assert.equal(h.explosions.blasts.length, 0);
  h.dispose();
}

// A disconnect inside the first callback aborts the remaining old-generation
// event and listeners. A fresh NetClient/session attachment still works.
{
  const h = networkHarness(), oldSocket = { readyState: 1, close() { this.readyState = 3; } };
  h.net.ws = oldSocket;
  h.net._reattach(oldSocket, h.net._sessionGeneration);
  const staleMessage = oldSocket.onmessage, staleClose = oldSocket.onclose, staleError = oldSocket.onerror;
  const replacement = new NetClient(), replacementExplosions = new ExplosionFX(h.scene);
  const replacementFx = new VehicleDestructionFX(h.scene, { explosions: replacementExplosions });
  const replacementDelivered = [], staleListeners = [];
  h.net.on('vehicle_destroyed', () => staleListeners.push('second destruction listener'));
  h.session.onGameplayEvent = event => {
    h.delivered.push(event.kind); h.accepted.push(h.fx.handleEvent(event));
    h.session._liveResourcesOwned = false;
    h.session._detachGameplayListeners(); h.fx.dispose(); h.net.close();
    h.session._pregame.net = replacement;
    h.session._liveResourcesOwned = true;
    h.session.onTick = snapshot => replacementFx.sync(snapshot.vehicles);
    h.session.onGameplayEvent = next => { replacementDelivered.push(next.kind); replacementFx.handleEvent(next); };
    h.session._attachGameplayListeners(replacement);
  };
  h.receive(1000, [{...networkVehicle, hp: 0}], networkPair()); h.present();
  assert.deepEqual(h.delivered, ['vehicle_destroyed'], 'a callback-triggered disconnect drops the remaining paired event');
  assert.deepEqual(h.accepted, [true]); assert.equal(h.fx.stats.bursts, 1);
  assert.deepEqual(staleListeners, [], 'generation replacement also drops later listeners for the same event');
  assert.deepEqual(h.net.latestEvents, [], 'closing clears the old presentation event view');
  const retiredDirty = h.net.dirty;
  staleMessage({ data: JSON.stringify({t: 'tick', now: 1050, players: [], vehicles: [], events: networkPair('stale', 31)}) });
  staleError(); staleClose({ code: 1006, reason: 'stale socket' });
  assert.equal(h.net.latestSnapshots.length, 0, 'old socket callbacks cannot repopulate the closed snapshot ring');
  assert.equal(h.net.dirty, retiredDirty, 'old socket callbacks cannot change the retired client state');
  assert.equal(replacement.dirty, false, 'old socket callbacks cannot mark the replacement client disconnected');
  assert.equal(h.session.net, replacement);
  assert.deepEqual(replacementDelivered, []); assert.equal(replacementFx.stats.bursts, 0);
  replacement._onTick({now: 2000, players: [], vehicles: [{...networkVehicle, hp: 0}], events: networkPair()});
  replacement.interpolate(replacement.latestSnapshots.at(-1).now, 0);
  assert.deepEqual(replacementDelivered, ['vehicle_destroyed', 'explosion'], 'a fresh session generation delivers the complete event pair');
  assert.equal(replacementFx.stats.bursts, 1, 'the replacement generation creates exactly one independent burst');
  h.session._detachGameplayListeners(); replacementFx.dispose(); replacementExplosions.dispose();
  h.dispose(); replacement.close();
}

// Both server event orders create one blast and one burst. Snapshots alone never explode.
for (const events of [[primary(), secondary()], [secondary(), primary()]]) {
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 20, 0);
  const getBlock = (_x, y) => y < 0 ? 1 : 0;
  const explosions = new ExplosionFX(scene, getBlock);
  const fx = new VehicleDestructionFX(scene, { explosions, camera, getBlock });
  fx.sync([{id: 'late-wreck', type: 'plane', hp: 0, wreck: true}]);
  assert.equal(explosions.blasts.length, 0, 'late join wreck snapshot does not replay destruction');
  assert.equal(active(fx.debris).length + active(fx.embers).length, 0);
  fx.sync([{id: 'plane-1', type: 'plane', hp: VEHICLE_RULES.plane.hp}]);
  assert.equal(explosions.blasts.length, 0, 'alive snapshot has no destruction presentation');
  assert.equal(fx.handleEvent(events[0]), true);
  assert.equal(explosions.blasts.length, 1, 'vehicle destruction uses the real shared explosion pool');
  assert.equal(explosions.blasts[0].radius, 7, 'shared blast receives the event radius');
  assert.ok(active(explosions.fire).length > 0 && active(explosions.smoke).length > 0, 'shared explosion carries fire and smoke');
  assert.ok(active(fx.debris).length > 0 && active(fx.embers).length > 0, 'destruction adds metal fragments and embers');
  const debrisCount = active(fx.debris).length, emberCount = active(fx.embers).length;
  assert.equal(fx.handleEvent(events[1]), false, 'secondary event does not replay the same destruction');
  assert.equal(fx.handleEvent(events[0]), false, 'duplicate primary event does not replay destruction');
  assert.equal(explosions.blasts.length, 1);
  assert.equal(active(fx.debris).length, debrisCount);
  assert.equal(active(fx.embers).length, emberCount);
  const stats = fx.stats;
  assert.deepEqual(stats, {bursts: 1, debris: debrisCount, embers: emberCount, remembered: 1,
    debrisCapacity: VEHICLE_DEBRIS_CAPACITY, emberCapacity: VEHICLE_EMBER_CAPACITY,
    fragments: 0, tossed: 0, cookoffs: 0, pendingCookoffs: 1, smoking: 0,
    fragmentCapacity: VEHICLE_FRAGMENT_CAPACITY, fragmentsPerBurst: VEHICLE_FRAGMENTS_PER_BURST});
  assert.ok(Object.isFrozen(stats), 'live diagnostics are immutable snapshots');
  assert.throws(() => { stats.bursts = 100; }, TypeError);
  fx.sync([{id: 'plane-1', type: 'plane', hp: VEHICLE_RULES.plane.hp}]);
  assert.equal(fx.handleEvent(events[1]), false, 'stale alive snapshot immediately after the event cannot re-arm it');
  fx.sync([{id: 'plane-1', type: 'plane', hp: 0, wreck: true}]);
  fx.sync([{id: 'plane-1', type: 'plane', hp: 0}]);
  assert.equal(explosions.blasts.length, 1, 'repeated wreck snapshots never create blasts');
  const fragment = active(fx.debris)[0], before = {x: fragment.x, y: fragment.y, z: fragment.z, vy: fragment.vy};
  fx.update(1 / 60);
  assert.ok(Math.hypot(fragment.x - before.x, fragment.y - before.y, fragment.z - before.z) > 0, 'fragments move after the burst');
  assert.ok(fragment.vy < before.vy, 'airborne fragments fall under gravity');
  near(explosions.blasts[0].age, 0, 'vehicle particles never advance the caller-owned explosion clock');
  finiteParticles(fx);
  for (const dt of [NaN, Infinity, -1, 0]) fx.update(dt);
  finiteParticles(fx);
  fx.sync([{id: 'plane-1', type: 'plane', hp: VEHICLE_RULES.plane.hp}]);
  assert.equal(explosions.blasts.length, 1, 'respawn snapshot re-arms without creating a blast');
  assert.equal(fx.handleEvent(primary()), true, 'a subsequent life can be destroyed again');
  assert.equal(explosions.blasts.length, 2);
  assert.equal(stats.bursts, 1, 'previous diagnostic snapshot remains unchanged after another burst');
  assert.equal(fx.stats.bursts, 2);
  const checkOwned = watchDisposals(resources(fx.debrisMesh, [...resources(fx.emberMesh), fx.debrisMesh, fx.emberMesh]));
  const checkShared = watchDisposals(resources(explosions.root));
  fx.clear(); fx.clear();
  assert.equal(active(fx.debris).length, 0); assert.equal(active(fx.embers).length, 0);
  assert.equal(fx.debrisMesh.count, 0); assert.equal(fx.emberMesh.count, 0); assert.equal(fx.seen.size, 0);
  assert.equal(explosions.blasts.length, 2, 'clearing vehicle particles leaves shared blast presentation intact');
  checkOwned(0); checkShared(0);
  fx.dispose(); fx.dispose();
  checkOwned(1); checkShared(0);
  assert.equal(fx.handleEvent(primary('after-dispose')), false);
  fx.sync([]); fx.update(1 / 60); fx.clear();
  assert.deepEqual(scene.children, [explosions.root], 'vehicle disposal removes its batches while preserving caller-owned effects');
  explosions.dispose();
  assert.equal(scene.children.length, 0);
}

// Bad payloads neither render nor poison the next valid event for that vehicle id.
{
  const scene = new THREE.Scene(), explosions = new ExplosionFX(scene);
  const fx = new VehicleDestructionFX(scene, { explosions });
  for (const event of [null, {}, primary(''), primary('  '), primary(null), primary(NaN), primary(Infinity), primary(true),
    primary('bad-pos', {pos: [NaN, 3, 4]}),
    primary('bad-pos', {pos: [1, Infinity, 4]}), primary('bad-pos', {pos: [1, 2]}),
    primary('bad-pos', {pos: [, 2, 3]}),
    primary('bad-type', {vehicleType: 'invalid'}), primary('missing-type', {vehicleType: null}),
    secondary('unrelated', {type: 'grenade'}), primary('unrelated', {kind: 'projectileExplode'})]) {
    assert.equal(fx.handleEvent(event), false, 'invalid or unrelated vehicle event is rejected');
  }
  assert.equal(fx.seen.size, 0); assert.equal(explosions.blasts.length, 0);
  assert.equal(active(fx.debris).length + active(fx.embers).length, 0);
  assert.equal(fx.handleEvent(primary('bad-pos')), true, 'a rejected payload does not reserve its id');
  assert.equal(fx.handleEvent(primary('bad-motion', {velocity: [NaN, Infinity, -Infinity]})), true,
    'invalid optional motion metadata cannot suppress a valid destruction event');
  fx.update(1 / 60); finiteParticles(fx);
  fx.dispose(); explosions.dispose();
}

// Large simultaneous battles have a fixed allocation budget and particles eventually drain.
{
  assert.equal(VEHICLE_DEBRIS_CAPACITY, 128); assert.equal(VEHICLE_EMBER_CAPACITY, 256); assert.equal(VEHICLE_EVENT_CAPACITY, 128);
  const scene = new THREE.Scene(), getBlock = (_x, y) => y < 0 ? 1 : 0;
  const explosions = new ExplosionFX(scene, getBlock), fx = new VehicleDestructionFX(scene, { explosions, getBlock });
  const debrisRecords = [...fx.debris], emberRecords = [...fx.embers];
  const sceneObjects = []; scene.traverse(node => sceneObjects.push(node));
  for (let i = 0; i < 200; i++) assert.equal(fx.handleEvent(primary(`salvo-${i}`, {
    vehicleType: ['jeep', 'tank', 'helicopter', 'plane'][i % 4], pos: [10 + i, 30, 10],
  })), true);
  fx.update(1 / 60);
  assert.equal(fx.debris.length, VEHICLE_DEBRIS_CAPACITY); assert.equal(fx.embers.length, VEHICLE_EMBER_CAPACITY);
  for (const [pool, saved] of [[fx.debris, debrisRecords], [fx.embers, emberRecords]]) {
    for (let i = 0; i < pool.length; i++) assert.equal(pool[i], saved[i], 'salvo reuses existing particle records');
  }
  assert.ok(fx.seen.size <= VEHICLE_EVENT_CAPACITY && explosions.blasts.length <= BLAST_CAPACITY);
  const afterObjects = []; scene.traverse(node => afterObjects.push(node));
  assert.deepEqual(afterObjects, sceneObjects, 'salvo adds no meshes or point lights');
  finiteParticles(fx);
  step(fx, 20);
  assert.equal(active(fx.debris).length, 0); assert.equal(active(fx.embers).length, 0);
  assert.equal(fx.debrisMesh.count, 0); assert.equal(fx.emberMesh.count, 0);
  assert.ok(explosions.blasts.every(blast => blast.age === 0), 'caller still owns the blast update schedule');
  fx.dispose(); explosions.dispose();
}

// Wrecks reuse each voxel model: charred and dark, crew cleared, the wreck
// geometry kept across snapshots, and everything restored on respawn.
{
  const view = new VehicleView();
  const camera = new THREE.PerspectiveCamera();
  for (const type of ['jeep', 'tank', 'helicopter', 'transport', 'plane']) {
    const air = type === 'helicopter' || type === 'transport' || type === 'plane';
    const row = {id: `wreck-${type}`, type, team: 'alpha', x: 10, y: 30, z: 10, yaw: .2, pitch: air ? .3 : 0, roll: air ? -.4 : 0,
      hp: VEHICLE_RULES[type].hp, speed: 16, rotorSpeed: 1, enginePower: 1, grounded: !air, st: 1};
    const exposed = { jeep: 'gunner', tank: 'commander', helicopter: 'driver', transport: 'door-left', plane: 'driver' }[type];
    const player = {id: `crew-${type}`, state: 'alive', name: 'Crew', team: 'alpha', hp: 100, vehicleId: row.id, vehicleSeatId: exposed};
    view.sync([{...row, seatOccupants: {[exposed]: player.id}}], [player]);
    view.update(1 / 60, camera);
    const item = view.items.get(row.id);
    const state = item.materials.material.userData.vehicleState.value;
    assert.equal(item.crew.size, 1, `${type} shows its ${exposed}`);
    const crew = [...item.crew.values()][0];
    const checkCrew = watchDisposals(resources(crew.avatar.group));
    const intact = visibleTriangles(item);
    const rotor = item.model.mainRotor;
    view.sync([{...row, hp: 0, seatOccupants: {[exposed]: player.id}}], [player]);
    assert.equal(item.wreck, true, 'hp zero selects wreck presentation without an optional wreck flag');
    assert.equal(item.crew.size, 0); checkCrew(1);
    assert.equal(item.hpBar.visible, false);
    assert.equal(state.x, 1, `${type} wreck is fully charred`);
    assert.equal(state.y, 0, `${type} wreck lamps are dark`);
    assert.ok(visibleTriangles(item) < intact, `${type} wreck loses its break-away chunks`);
    const wreckTriangles = visibleTriangles(item);
    const moving = {...row, hp: 0, wreck: true, x: 30, y: 12, z: 25, yaw: -.6, pitch: air ? -.1 : 0, roll: air ? .6 : 0};
    view.sync([moving], [player]);
    const distance = item.root.position.distanceTo(new THREE.Vector3(moving.x, moving.y, moving.z));
    const rotorAngle = rotor?.rotation.y;
    for (let frame = 0; frame < 30; frame++) view.update(1 / 60, camera);
    assert.ok(item.root.position.distanceTo(new THREE.Vector3(moving.x, moving.y, moving.z)) < distance * .01, 'wreck follows authoritative motion');
    if (air) {
      assert.ok(Math.abs(item.root.rotation.x - moving.pitch) < .01 && Math.abs(item.root.rotation.z - moving.roll) < .01, 'airborne wreck follows pitch and bank');
    }
    if (rotor) assert.equal(rotor.rotation.y, rotorAngle, 'a wrecked rotor never spins');
    view.sync([moving], [player]);
    assert.equal(visibleTriangles(item), wreckTriangles, 'repeated snapshots keep the same wreck');
    view.sync([row]);
    view.update(1 / 60, camera);
    assert.equal(item.wreck, false);
    assert.equal(visibleTriangles(item), intact, 'respawn restores the intact geometry');
    assert.ok(state.x < 0.01, 'respawn clears the soot');
    assert.equal(state.y, 1, 'respawn relights the lamps');
    const owned = new Set(Object.values(item.materials));
    const checkHull = watchDisposals(owned);
    view.sync([]); checkHull(1);
  }
  view.dispose(); view.dispose();
  assert.equal(view.items.size, 0); assert.equal(view.group.children.length, 0);
}

// Fragment extraction keeps nested transforms (turret yaw, gun pitch, hull
// attitude) far out on Frontier; chunks share cached geometry and one fogged,
// near-fading charred material.
{
  const view = new VehicleView();
  const row = { id: 'posed', type: 'tank', team: 'bravo', x: 899.3, y: 61.7, z: 902.8, yaw: .78, pitch: .31, roll: -.42, hp: 1000,
    turretYaw: -.9, turretPitch: .2 };
  view.sync([row]); view.update(1 / 60);
  const item = view.items.get(row.id);
  item.root.rotation.set(row.pitch, row.yaw, row.roll, 'YXZ');
  item.root.updateMatrixWorld(true);
  const pieces = createVehicleFragments(item.model, { maxPieces: 64 });
  const turret = pieces.find(piece => piece.name === 'turret');
  const barrel = pieces.find(piece => piece.name === 'barrel');
  assert.ok(turret && barrel);
  const turretWorld = item.model.turret.getWorldQuaternion(new THREE.Quaternion());
  assert.ok(turret.object.quaternion.angleTo(turretWorld) < 1e-6, 'turret chunk keeps the turret orientation');
  const gunWorld = item.model.gun.getWorldQuaternion(new THREE.Quaternion());
  assert.ok(barrel.object.quaternion.angleTo(gunWorld) < 1e-6, 'barrel chunk keeps the gun pitch');
  for (const piece of pieces) {
    assert.equal(piece.object.material, fragmentMaterial());
    assert.equal(piece.geometry.userData.cached, true, 'chunk geometry is the shared cache');
    assert.ok(piece.radius > 0 && Number.isFinite(piece.radius));
  }
  assert.notEqual(fragmentMaterial().fog, false, 'chunks are fogged');
  const checkCached = watchDisposals(new Set(pieces.map(piece => piece.geometry)));
  for (const piece of pieces) { disposeVehicleFragment(piece); disposeVehicleFragment(piece); }
  checkCached(0);
  const top = createVehicleFragments(item.model, { maxPieces: 2 }).map(piece => piece.name);
  assert.deepEqual(top, ['barrel', 'turret'], 'the most recognizable chunks come first');
  view.dispose();
}

// Destruction choreography: turret toss, cook-offs, smoking chunks, the
// shockwave ring, the boom and a camera jolt; respawn cancels pending cook-offs.
{
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera();
  camera.position.set(12, 14, 12); camera.updateMatrixWorld();
  const getBlock = (_x, y) => y < 11 ? 1 : 0;
  const view = new VehicleView({ getBlock }); scene.add(view.group);
  const field = new ParticleField({ scene, capacity: 4096 });
  const calls = [];
  const sfx = { vehicleDestruction: (...args) => calls.push(args) };
  const shake = new CameraShake();
  const spawned = [];
  const explosions = { spawn: (...args) => spawned.push(args) };
  const fx = new VehicleDestructionFX(scene, { explosions, camera, getBlock, fx: field, sfx, cameraShake: shake,
    getFragments: (id, options) => view.destructionFragments(id, options) });
  const row = { id: 'boom', type: 'tank', team: 'alpha', x: 10, y: 11, z: 10, yaw: .4, hp: 1000 };
  view.sync([row]); view.update(1 / 60);
  view.sync([{...row, hp: 0, wreck: true}], [], null, { events: [primary('boom', { vehicleType: 'tank', pos: [10, 11, 10] })] });
  assert.equal(fx.handleEvent(primary('boom', { vehicleType: 'tank', pos: [10, 11, 10] })), true);
  const tossed = active(fx.fragments).filter(particle => particle.tossed);
  assert.deepEqual(tossed.map(particle => particle.fragment.name).sort(), ['barrel', 'gun', 'rws', 'rws', 'turret'].sort(), 'the turret assembly leaves together');
  assert.ok(tossed.every(particle => particle.vy >= VEHICLE_DESTRUCTION_STYLE.tossSpeed[0] && particle.vy === tossed[0].vy), 'shared upward toss');
  assert.equal(calls.length, 1, 'destruction is audible');
  assert.deepEqual(calls[0].slice(1), ['tank']);
  assert.ok(shake.trauma > 0, 'a nearby destruction shakes the camera');
  assert.ok(field.emitsByKind.dust >= VEHICLE_DESTRUCTION_STYLE.ringParticles, 'shockwave dust ring');
  assert.equal(fx.stats.smoking, VEHICLE_DESTRUCTION_STYLE.smokingFragments, 'the largest chunks trail smoke');
  assert.equal(fx.stats.pendingCookoffs, VEHICLE_DESTRUCTION_STYLE.cookoffCount.tank);
  step(fx, 2.6);
  assert.equal(fx.stats.cookoffs, 2, 'two ammunition cook-offs');
  assert.equal(calls.filter(call => call[2]?.secondary).length, 2, 'each cook-off has its own report');
  assert.equal(spawned.length, 3, 'blast plus two secondary blasts');
  // Fragments expire, and so do their smoke trails.
  step(fx, 13);
  for (let i = 0; i < 10; i++) field.update(.1, camera);
  assert.equal(fx.stats.fragments, 0);
  assert.equal(fx.stats.smoking, 0);
  assert.equal(field.emitters.size, 0, 'no leftover emitters');
  // A respawn before the cook-off cancels it.
  view.sync([row]); fx.sync([row]);
  for (let i = 0; i < 70; i++) fx.update(1 / 60);
  fx.sync([row]);
  view.sync([{...row, hp: 0, wreck: true}], [], null, { events: [primary('boom', { vehicleType: 'tank', pos: [10, 11, 10], seq: 99 })] });
  assert.equal(fx.handleEvent(primary('boom', { vehicleType: 'tank', pos: [10, 11, 10], seq: 99 })), true, 'the next life explodes again');
  fx.sync([{...row, hp: 0, wreck: true}]);
  fx.sync([row]);
  step(fx, 3);
  assert.equal(fx.stats.cookoffs, 2, 'respawn cancelled the pending cook-offs');
  fx.dispose(); field.dispose(); view.dispose();
}

// Sixteen simultaneous tanks fit the chunk budget; replacements, expiry and
// low graphics never dispose the shared chunk geometry or live hulls.
{
  const scene = new THREE.Scene(), view = new VehicleView(); scene.add(view.group);
  const rows = Array.from({length: 17}, (_, i) => ({ id: `fleet-${i}`, type: 'tank', team: 'alpha',
    x: 70 + i * 6, y: 12, z: 120, yaw: i * .2, hp: VEHICLE_RULES.tank.hp }));
  view.sync(rows);
  const perTank = view.items.get('fleet-0').model.fragmentSources().length;
  const hullMaterials = new Set([...view.items.values()].flatMap(item => Object.values(item.materials)));
  const checkHulls = watchDisposals(hullMaterials);
  const fx = new VehicleDestructionFX(scene, { getFragments: (id, options) => view.destructionFragments(id, options),
    getBlock: (_x, y) => y < 11 ? 1 : 0 });
  view.sync(rows.map(row => ({...row, hp: 0, wreck: true})));
  for (const row of rows.slice(0, 16)) fx.handleEvent(primary(row.id, { vehicleType: 'tank', pos: [row.x, row.y, row.z] }));
  assert.equal(fx.stats.fragments, 16 * perTank, 'sixteen complete bursts');
  assert.ok(fx.stats.fragments <= VEHICLE_FRAGMENT_CAPACITY);
  const geometries = new Set(active(fx.fragments).map(particle => particle.fragment.geometry));
  assert.equal(geometries.size, perTank, 'every hull of a team shares one cached geometry per chunk');
  const checkGeometry = watchDisposals(geometries);
  for (let frame = 0; frame < 30; frame++) fx.update(1 / 60);
  assert.ok(active(fx.fragments).every(particle => ['x','y','z','vx','vy','vz','rx','ry','rz'].every(key => Number.isFinite(particle[key]))));
  step(fx, 14); assert.equal(fx.stats.fragments, 0);
  assert.equal(fx.root.children.length, 2, 'expired chunks leave only the fixed shrapnel and ember batches');
  fx.setQuality('low');
  assert.equal(fx.stats.fragmentsPerBurst, VEHICLE_LOW_FRAGMENTS_PER_BURST);
  fx.handleEvent(primary('low-graphics', { vehicleType: 'tank' }));
  assert.equal(fx.stats.fragments, 0, 'a missing model is harmless and fabricates no geometry');
  fx.clear(); fx.handleEvent(primary(rows[16].id, { vehicleType: 'tank', pos: [rows[16].x, 12, 120] }));
  assert.equal(fx.stats.fragments, Math.min(perTank, VEHICLE_LOW_FRAGMENTS_PER_BURST));
  fx.dispose(); fx.dispose(); checkGeometry(0); checkHulls(0);
  view.dispose(); checkHulls(1); checkGeometry(0);
}

console.log('Vehicle destruction passed: real event delivery and deduplication, posed voxel chunks, turret toss, cook-offs, smoking chunks, shockwave, bounded sixteen-hull bursts, persistent wrecks, respawn and shared-geometry lifetime.');
