// VehicleFx: every combat effect is reached only through an authoritative
// event or a snapshot field. Injects events and rows into the real view,
// particle field and FX layer and counts what comes out; checks the draw
// budget, the FX CPU budget with a 16-hull load and that the shader warm-up
// covers every program the vehicle layer can create during a match.
import assert from 'node:assert/strict';
import * as THREE from '../public/js/vendor/three.module.js';
import { ParticleField } from '../public/js/fx/particle-field.js';
import { VehicleFx, VEHICLE_FX, blockDustTint } from '../public/js/vehicles/vehicle-fx.js';
import { VehicleView } from '../public/js/engine/vehicle-view.js';
import { CameraShake } from '../public/js/engine/camera-shake.js';
import { VehicleDestructionFX } from '../public/js/vehicles/vehicle-destruction-fx.js';
import { collectProgramVariants, warmShaders, VEHICLE_WARMUP_MATERIALS } from '../public/js/engine/shader-warmup.js';
import { VEHICLE_STATUS, VEHICLE_TYPE_IDS, vehicleMountOrder } from '../shared/conquest-contract.js';
import { vehicleDef } from '../shared/vehicle-defs.js';
import { MC_WATER } from '../shared/world/blocks.js';
import { CombatFeedback } from '../public/js/combat/feedback.js';

globalThis.document ??= { createElement: () => ({ getContext: () => new Proxy({}, { get: (o, k) => o[k] ?? (() => {}) }) }) };

let checks = 0;
const check = (fn) => { fn(); checks++; };
const GROUND = 10, DIRT = 3, GRASS = 2;
// Flat ground at y=10 with a water pond around x in [200, 240).
const getBlock = (x, y, z) => {
  if (y >= GROUND || y < GROUND - 6) return 0;
  if (x >= 200 && x < 240 && y >= GROUND - 2) return MC_WATER;
  return y === GROUND - 1 ? (x < 0 ? DIRT : GRASS) : DIRT;
};

function recorder() {
  const calls = [];
  const sfx = new Proxy({}, { get: (_, name) => name === 'calls' ? calls : (...args) => { calls.push([name, ...args]); return true; } });
  return sfx;
}
const calledWith = (sfx, name) => sfx.calls.filter(call => call[0] === name);

function harness({ capacity = 8192 } = {}) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 1000);
  camera.position.set(0, 14, 30); camera.updateMatrixWorld();
  const view = new VehicleView({ getBlock });
  scene.add(view.group);
  const fx = new ParticleField({ scene, capacity });
  const sfx = recorder();
  const shake = new CameraShake();
  const spawned = [], walls = [];
  const tracers = { spawnTracer: (...args) => spawned.push(args), onWallImpact: hit => walls.push(hit) };
  const muzzleLights = { lights: [new THREE.PointLight(0xffd080, 0, 6), new THREE.PointLight(0xffd080, 0, 6)] };
  const vfx = new VehicleFx({ fx, vehicleView: view, sfx, cameraShake: shake, getBlock, tracers, muzzleLights, scene });
  return { scene, camera, view, fx, sfx, shake, spawned, walls, muzzleLights, vfx };
}

const rowFor = (type, overrides = {}) => {
  const def = vehicleDef(type);
  return { id: `${type}-1`, type, team: 'alpha', x: 0, y: GROUND, z: 0, yaw: 0, pitch: 0, roll: 0, hp: def.hp,
    seatOccupants: {}, engineOn: false, mounts: vehicleMountOrder(type).map(() => [0, 0, 2, 0, 0]), ...overrides };
};
const frames = (h, rows, count, dt = 1 / 60, players = []) => {
  for (let i = 0; i < count; i++) {
    h.view.sync(rows, players, { id: 'me', team: 'alpha' });
    h.view.update(dt, h.camera);
    h.vfx.update(dt, h.camera, rows);
    h.fx.update(dt, h.camera);
  }
};

// --- Draw budget ---------------------------------------------------------------------
{
  const h = harness();
  const draws = [];
  h.fx.group.traverse(o => { if (o.isMesh) draws.push(o.name); });
  check(() => assert.equal(draws.length, 2, 'particle field: 2 draws'));
  const own = [];
  h.vfx.group.traverse(o => { if (o.isMesh) own.push(o.name); });
  check(() => assert.deepEqual(own.sort(), ['vehicle-hull-marks', 'vehicle-light-sprites', 'vehicle-track-decals']));
  h.vfx.dispose(); h.fx.dispose(); h.view.dispose();
}

// --- Parked, uncrewed, undamaged hulls emit nothing -------------------------------------
{
  const h = harness();
  const rows = VEHICLE_TYPE_IDS.map((type, i) => rowFor(type, { id: `${type}-park`, x: i * 25 - 50 }));
  frames(h, rows, 600);
  check(() => assert.equal(h.fx.emitted, 0, 'no particle without an event or snapshot cause'));
  check(() => assert.deepEqual({ ...h.vfx.counts }, {}, 'no combat FX'));
  check(() => assert.equal(h.vfx.decals.mesh.count, 0, 'no track marks while parked'));
  check(() => assert.equal(h.sfx.calls.length, 0, 'no vehicle sound without a cause'));
  check(() => assert.ok(h.vfx.stats.sprites > 0 && h.vfx.stats.sprites < 20, 'aircraft nav lights stay on; parked head/tail lamps off'));
  check(() => assert.equal(h.shake.trauma, 0));
  h.vfx.dispose(); h.fx.dispose(); h.view.dispose();
}

// --- Events --------------------------------------------------------------------------------
{
  const h = harness();
  const tank = rowFor('tank', { seatOccupants: { driver: 'me' }, occupantId: 'me', st: VEHICLE_STATUS.engine, turretYaw: 0.4 });
  const jeep = rowFor('jeep', { id: 'jeep-1', x: 20, seatOccupants: { gunner: 'enemy' }, team: 'bravo' });
  jeep.mounts[0] = [0.2, 0, 50, 64, 0];
  const heli = rowFor('helicopter', { id: 'heli-1', x: -30, y: GROUND + 3, seatOccupants: { driver: 'p' }, rotorSpeed: 1, grounded: false, vx: 4, vy: 0, vz: 0 });
  const rows = [tank, jeep, heli];
  frames(h, rows, 30);
  const base = h.fx.emitted;

  // Tank main gun: muzzle, smoke, dust cone, recoil and rock, muzzle light, shake, cannon report.
  check(() => assert.equal(h.vfx.handleEvent({ kind: 'shoot', id: 'me', w: 'rocket', o: [0, 12, -6], d: [0, 0, -1],
    vehicleId: 'tank-1', mount: 'main', vehicleWeapon: 'tankAP', tracer: false }, 'me'), true));
  check(() => assert.ok(h.fx.emitsByKind.muzzle >= 3 && h.fx.emitsByKind.smoke > 10 && h.fx.emitsByKind.dust > 10));
  const recoilNode = h.view.item('tank-1').model.mounts['driver:main'].recoilNode;
  const rest = recoilNode.position.z;
  check(() => assert.ok(h.view.item('tank-1').recoil.get('driver:main') > 0.5, 'barrel recoils 0.6 m'));
  check(() => assert.equal(h.muzzleLights.lights[1].intensity, 0, 'light written on the next update'));
  frames(h, rows, 1);
  check(() => assert.ok(h.muzzleLights.lights[1].intensity > 0, 'borrows one muzzle light'));
  check(() => assert.ok(recoilNode.position.z > rest, 'barrel slides back'));
  check(() => assert.ok(h.shake.trauma > 0.2, 'shooter feels the shot'));
  check(() => assert.deepEqual(calledWith(h.sfx, 'vehicleCannon')[0].slice(2), [{ self: true, weapon: 'tankAP' }], 'shooter hears the cannon in the head'));
  frames(h, rows, 12);
  check(() => assert.equal(h.muzzleLights.lights[1].intensity, 0, 'flash ends'));
  // A remote listener's cannon is positional.
  h.vfx.handleEvent({ kind: 'shoot', id: 'other', w: 'rocket', o: [0, 12, -6], d: [0, 0, -1], vehicleId: 'tank-1', mount: 'main', vehicleWeapon: 'tankHE' }, 'someone-else');
  check(() => assert.equal(calledWith(h.sfx, 'vehicleCannon')[1][2].self, false));
  h.vfx.selfId = 'me';

  // Hitscan pintle with tracer and a terrain hit; heat read from the row.
  const shot = { kind: 'shoot', id: 'enemy', w: 'lmg', o: [20, 12, 0], d: [0, -0.2, -1], vehicleId: 'jeep-1', mount: 'pintle',
    vehicleWeapon: 'hmg', tracer: true, paths: [[{ o: [20, 12, 0], end: [20, 9.5, -12], hit: { x: 20, y: 9, z: -12, nx: 0, ny: 1, nz: 0 } }]] };
  h.vfx.handleEvent(shot, 'me');
  check(() => assert.equal(h.spawned.length, 1, 'tracer for the tracer round'));
  check(() => assert.ok(h.spawned[0][2] > 10 && h.spawned[0][2] < 13, 'tracer length to the path end'));
  check(() => assert.ok(h.spawned[0][3].tracer.width > 1.5, 'HMG tracer definition'));
  check(() => assert.equal(h.walls.length, 1, 'impact routed to the shared wall-impact feedback'));
  const gun = calledWith(h.sfx, 'vehicleGun').at(-1);
  check(() => assert.equal(gun[1], 'jeep-1:pintle'));
  check(() => assert.equal(gun[3], 'hmg'));
  check(() => assert.ok(Math.abs(gun[4].heat - 0.64) < 1e-9, 'gun loop heat from mounts[3]'));
  h.vfx.handleEvent({ ...shot, tracer: false, paths: undefined }, 'me');
  check(() => assert.equal(h.spawned.length, 1, 'non-tracer rounds draw no tracer'));

  // Missile: launch puff, trail emitter, flight loop, explode ends the trail.
  h.vfx.handleEvent({ kind: 'shoot', id: 'p', w: 'rocket', o: [-30, 14, -3], d: [0, 0, -1], vehicleId: 'heli-1', mount: 'pods', vehicleWeapon: 'helicopterRocket', side: 1 }, 'me');
  check(() => assert.equal(calledWith(h.sfx, 'vehicleMissileLaunch').at(-1)[2].kind, 'pod'));
  check(() => assert.equal(h.vfx.handleEvent({ kind: 'projectileLaunch', id: 'p', pid: 'm1', type: 'rocket', o: [-30, 14, -3], v: [0, 0, -150], vehicleWeapon: 'aaMissile', g: 0 }, 'me'), true));
  check(() => assert.equal(h.vfx.missiles.size, 1));
  const emitters = h.fx.emitters.size;
  frames(h, rows, 10);
  check(() => assert.ok(calledWith(h.sfx, 'missileFlight').length >= 10, 'missile flight loop follows the trail'));
  check(() => assert.ok(h.vfx.missiles.get('m1').pos[2] < -20, 'trail advances along the launch velocity'));
  // A homing correction re-bases the path but keeps the remaining trail lifetime.
  {
    const trail = h.vfx.missiles.get('m1'), remaining = trail.life - trail.age;
    check(() => assert.equal(h.vfx.correctMissile({ kind: 'projectileUpdate', pid: 'm1', o: [-31, 14, -25], v: [5, 0, -150] }), true));
    check(() => assert.ok(Math.abs(trail.life - remaining) < 1e-9 && trail.age === 0, `correction keeps ${remaining.toFixed(3)} s of trail`));
    check(() => assert.deepEqual(trail.v, [5, 0, -150]));
  }
  h.vfx.handleEvent({ kind: 'projectileExplode', pid: 'm1', type: 'rocket', x: -30, y: 11, z: -40, vehicleWeapon: 'aaMissile' }, 'me');
  check(() => assert.equal(h.vfx.missiles.size, 0));
  check(() => assert.equal(h.fx.emitters.size, emitters - 2, 'trail emitters removed'));
  check(() => assert.equal(calledWith(h.sfx, 'stopMissileFlight').length, 1));
  // Behind the killcam an impact only ends the trail and its loop: no ring, no shake.
  h.vfx.handleEvent({ kind: 'projectileLaunch', id: 'p', pid: 'm2', type: 'rocket', o: [-30, 14, -3], v: [0, 0, -150], vehicleWeapon: 'aaMissile', g: 0 }, 'me');
  frames(h, rows, 2);
  h.shake.reset();
  const dustBefore = h.fx.emitsByKind.dust || 0;
  check(() => assert.equal(h.vfx.endMissile('m2'), true));
  check(() => assert.equal(h.vfx.missiles.size, 0));
  check(() => assert.equal(h.fx.emitters.size, emitters - 2, 'killcam impact removes the trail emitters'));
  check(() => assert.equal(calledWith(h.sfx, 'stopMissileFlight').length, 2, 'and stops the flight loop'));
  check(() => assert.equal(h.fx.emitsByKind.dust || 0, dustBefore)); check(() => assert.equal(h.shake.trauma, 0));
  check(() => assert.equal(h.vfx.endMissile('m2'), false, 'an ended trail is no change'));
  // A shell launch only flashes (no trail).
  h.vfx.handleEvent({ kind: 'projectileLaunch', id: 'me', pid: 's1', type: 'rocket', o: [0, 12, -6], v: [0, 0, -170], vehicleWeapon: 'tankAP', g: 6 }, 'me');
  check(() => assert.equal(h.vfx.missiles.size, 0));
  // Heavy shell impact: dust ring and distance shake.
  h.shake.reset();
  h.vfx.handleEvent({ kind: 'projectileExplode', pid: 's1', type: 'rocket', x: 0, y: GROUND + 0.5, z: 25, vehicleWeapon: 'tankHE' }, 'me');
  check(() => assert.ok(h.shake.trauma > 0, 'a nearby HE impact shakes the camera'));

  // Hull hits: eff 0 is a white spark and a ping only.
  const sparks = h.fx.emitsByKind.spark, debris = h.fx.emitsByKind.debris;
  h.vfx.handleEvent({ kind: 'vehicle_hit', vehicleId: 'tank-1', attacker: 'x', dmg: 0, zone: 'front', cls: 'small', eff: 0, pos: [0, 11.5, -2.6] }, 'me');
  check(() => assert.equal(h.fx.emitsByKind.spark, sparks + 3));
  check(() => assert.equal(h.fx.emitsByKind.debris, debris, 'no chips for an ineffective round'));
  check(() => assert.equal(h.vfx.hullMarks.mesh.count, 0, 'no scorch for an ineffective round'));
  check(() => assert.deepEqual(calledWith(h.sfx, 'vehicleHullHit').at(-1)[2], { zone: 'front', eff: 0, dmg: 0, self: true }));
  h.shake.reset();
  h.vfx.handleEvent({ kind: 'vehicle_hit', vehicleId: 'tank-1', attacker: 'x', dmg: 345, zone: 'side', cls: 'at', eff: 1, pos: [1.9, 11.5, 0] }, 'me');
  check(() => assert.ok(h.fx.emitsByKind.debris > debris));
  check(() => assert.equal(h.vfx.hullMarks.mesh.count, 1, 'scorch mark on the hull'));
  check(() => assert.ok(h.shake.trauma > 0.3, 'crew feel a heavy hit'));
  check(() => assert.equal(h.vfx.handleEvent({ kind: 'vehicle_hit', vehicleId: 'tank-1', pos: [NaN, 0, 0] }, 'me'), false));
  // The mark follows the hull.
  const markBefore = new THREE.Matrix4(); h.vfx.hullMarks.mesh.getMatrixAt(0, markBefore);
  tank.x = 5;
  frames(h, rows, 60);
  const markAfter = new THREE.Matrix4(); h.vfx.hullMarks.mesh.getMatrixAt(0, markAfter);
  check(() => assert.ok(markAfter.elements[12] - markBefore.elements[12] > 4, 'scorch mark rides the hull'));

  // Countermeasures (WP2 sends the kind as `cm`).
  const flares = h.fx.emitsByKind.flare;
  check(() => assert.equal(h.vfx.handleEvent({ kind: 'countermeasure', vehicleId: 'heli-1', cm: 'flares' }, 'me'), true));
  frames(h, rows, 40);
  check(() => assert.ok(h.fx.emitsByKind.flare - flares >= 12, 'three flare salvos from both dispensers'));
  check(() => assert.equal(calledWith(h.sfx, 'vehicleCountermeasure').at(-1)[2], 'flares'));
  const smoke = h.fx.emitsByKind.smoke;
  h.vfx.handleEvent({ kind: 'countermeasure', vehicleId: 'tank-1', cm: 'smoke' }, 'me');
  check(() => assert.ok(h.fx.emitsByKind.smoke - smoke >= 24, 'both smoke banks fire'));
  check(() => assert.equal(calledWith(h.sfx, 'vehicleCountermeasure').at(-1)[3].self, true));

  // Disabled and repaired.
  check(() => assert.equal(h.vfx.handleEvent({ kind: 'vehicle_disabled', vehicleId: 'tank-1', attacker: 'x' }, 'me'), true));
  check(() => assert.equal(h.vfx.handleEvent({ kind: 'vehicle_repaired', vehicleId: 'tank-1', by: 'y', hp: 10 }, 'me'), true));
  check(() => assert.equal(h.vfx.handleEvent({ kind: 'vehicle_disabled', vehicleId: 'missing' }, 'me'), false));
  // Infantry shots are not vehicle FX.
  check(() => assert.equal(h.vfx.handleEvent({ kind: 'shoot', id: 'x', w: 'rifle', o: [0, 0, 0], d: [0, 0, -1] }, 'me'), false));
  check(() => assert.equal(h.vfx.handleEvent({ kind: 'projectileLaunch', id: 'x', pid: 'r', type: 'rocket', o: [0, 0, 0], v: [0, 0, 1] }, 'me'), false));
  h.vfx.dispose();
  check(() => assert.equal(h.vfx.group.parent, null));
  check(() => assert.ok(calledWith(h.sfx, 'stopVehicleCues').length === 1));
  h.fx.dispose(); h.view.dispose();
}

// --- Snapshot-driven damage, wreck column, locomotion ------------------------------------------
{
  const h = harness();
  const damaged = rowFor('jeep', { id: 'damaged', x: -60, hp: 100 });
  const burning = rowFor('tank', { id: 'burning', x: -40, hp: 220, st: VEHICLE_STATUS.disabled | VEHICLE_STATUS.burning });
  const wreck = rowFor('helicopter', { id: 'wreck', x: -20, hp: 0, wreck: true, wreckAge: 0 });
  frames(h, [damaged, burning, wreck], 120);
  const alive = h.fx.emitsByKind;
  check(() => assert.ok(alive.smoke > 0, 'damage smoke below 50 %'));
  check(() => assert.ok(alive.fire > 0, 'fire while burning'));
  check(() => assert.ok(alive.smokeColumn > 0, 'wreck column'));
  // The column lasts 30-45 s, then stops; the wreck fire stops after ~14 s.
  frames(h, [damaged, burning, { ...wreck, wreckAge: 50 }], 1);
  const column = h.fx.emitsByKind.smokeColumn;
  frames(h, [damaged, burning, { ...wreck, wreckAge: 50 }], 460, 0.1);
  const afterColumn = h.fx.emitsByKind.smokeColumn;
  frames(h, [damaged, burning, { ...wreck, wreckAge: 60 }], 50, 0.1);
  check(() => assert.ok(afterColumn > column, 'column keeps smoking for its life'));
  check(() => assert.equal(h.fx.emitsByKind.smokeColumn, afterColumn, 'column ends after 30-45 s'));
  // Repair above half HP stops the damage smoke.
  const smokeBefore = h.fx.emitsByKind.smoke;
  frames(h, [{ ...damaged, hp: 300 }, { ...burning, hp: 900, st: 0 }], 120);
  check(() => assert.equal(h.fx.emitsByKind.smoke, smokeBefore, 'a repaired hull stops smoking'));
  h.vfx.dispose(); h.fx.dispose(); h.view.dispose();
}
// A pad capture repaints a parked damaged hull (VehicleView rebuilds it under
// the same id). Its smoke and fire must follow the new model when it drives off.
{
  const h = harness();
  const parked = rowFor('jeep', { id: 'captured', x: -60, hp: 100, st: VEHICLE_STATUS.burning });
  frames(h, [parked], 30);
  const oldItem = h.view.items.get('captured'), oldSmoke = h.vfx.state.get('captured').smoke;
  check(() => assert.ok(oldSmoke && h.vfx.state.get('captured').fire, 'damaged burning hull smokes and burns'));
  const taken = { ...parked, team: 'bravo' };
  frames(h, [taken], 1);
  const item = h.view.items.get('captured'), state = h.vfx.state.get('captured');
  check(() => assert.notEqual(item, oldItem, 'the team change rebuilt the hull'));
  check(() => assert.ok(!h.fx.emitters.has(oldSmoke), 'the old model\'s emitter is released'));
  check(() => assert.equal(h.fx.emitters.size, 2, 'exactly one smoke and one fire emitter remain'));
  for (let i = 0; i < 60; i++) { taken.x += 1; frames(h, [taken], 1); }
  const anchor = item.model.emitters.fire[0].getWorldPosition(new THREE.Vector3());
  for (const handle of [state.smoke, state.fire]) {
    const at = handle.pos();
    check(() => assert.ok(Math.hypot(at[0] - anchor.x, at[1] - anchor.y, at[2] - anchor.z) < 1e-6 && at[0] > -10,
      `${handle.kind} follows the rebuilt, driven hull`));
  }
  h.vfx.dispose(); h.fx.dispose(); h.view.dispose();
}
{
  const h = harness();
  // A crewed jeep driving over dirt: tinted dust, tyre marks, exhaust, head and tail lights.
  const jeep = rowFor('jeep', { id: 'driving', x: -40, z: 0, seatOccupants: { driver: 'd' }, occupantId: 'd', speed: 9, st: VEHICLE_STATUS.engine, engineOn: true, yaw: 0 });
  const rows = [jeep];
  for (let i = 0; i < 180; i++) { jeep.z -= 9 / 60; frames(h, rows, 1); }
  check(() => assert.ok(h.fx.emitsByKind.dust > 20, 'wheel dust while moving'));
  check(() => assert.ok(h.fx.emitsByKind.exhaust > 20, 'exhaust while the engine runs'));
  check(() => assert.ok(h.vfx.decals.mesh.count >= 2 * Math.floor(27 / (VEHICLE_FX.trackStamp + 0.15)) - 6 && h.vfx.decals.mesh.count <= 2 * Math.ceil(27 / VEHICLE_FX.trackStamp), `tyre marks laid every ${VEHICLE_FX.trackStamp} m: ${h.vfx.decals.mesh.count}`));
  check(() => assert.ok(h.vfx.stats.sprites >= 4, 'head and tail lamps on with the engine'));
  // Dust is tinted by the block under the wheel (dirt here).
  const tint = blockDustTint(DIRT);
  const pool = h.fx.pools.alpha, colors = pool.attributes.aCol0.array;
  let tinted = false;
  for (let i = 0; i < pool.used && !tinted; i++) if (Math.abs(colors[i * 4] - Math.fround(tint[0])) < 1e-6 && Math.abs(colors[i * 4 + 1] - Math.fround(tint[1])) < 1e-6) tinted = true;
  check(() => assert.ok(tinted, 'dust carries the ground block tint'));
  check(() => assert.notDeepEqual(blockDustTint(DIRT), blockDustTint(GRASS)));
  // Decals fade after 30 s and the ring buffer never exceeds 2048.
  check(() => assert.equal(h.vfx.decals.capacity, 2048));
  for (let i = 0; i < 2200; i++) h.vfx.decals.add(new THREE.Matrix4(), [0, 0, 0], 0.5);
  check(() => assert.equal(h.vfx.decals.mesh.count, 2048));
  frames(h, [], 310, 0.1);
  check(() => assert.equal(h.vfx.decals.live, 0, 'every mark fades within 30 s'));
  h.vfx.dispose(); h.fx.dispose(); h.view.dispose();
}
{
  const h = harness();
  // Rotor wash below 14 m, spray over water, nothing at altitude.
  const low = rowFor('helicopter', { id: 'low', x: 0, y: GROUND + 5, seatOccupants: { driver: 'p' }, rotorSpeed: 1, grounded: false, engineOn: true });
  frames(h, [low], 60);
  check(() => assert.ok(h.vfx.counts.wash > 0 && h.fx.emitsByKind.dust > 10, 'rotor wash kicks up dust'));
  check(() => assert.equal(h.vfx.counts.spray, undefined));
  const water = { ...low, id: 'water', x: 220 };
  frames(h, [water], 60);
  check(() => assert.ok(h.vfx.counts.spray > 0 && h.fx.emitsByKind.water > 0, 'spray over water'));
  const high = { ...low, id: 'high', y: GROUND + 30 };
  const washed = h.vfx.counts.wash;
  frames(h, [high], 60);
  check(() => assert.equal(h.vfx.counts.wash, washed, 'no wash above 14 m AGL'));
  // Jet: afterburner over 80 % power, contrail above 120 m AGL, vortices on a hard pull.
  const jet = rowFor('plane', { id: 'jet', x: 50, y: GROUND + 40, seatOccupants: { driver: 'p' }, enginePower: 0.95, engineOn: true, grounded: false, vx: 0, vy: 0, vz: -60, speed: 60 });
  frames(h, [jet], 30);
  check(() => assert.ok(h.vfx.counts.afterburner > 0, 'afterburner'));
  check(() => assert.equal(h.vfx.counts.contrail, undefined, 'no contrail at 40 m'));
  frames(h, [{ ...jet, y: GROUND + 140 }], 30);
  check(() => assert.ok(h.vfx.counts.contrail > 0, 'contrail above 120 m'));
  frames(h, [{ ...jet, vx: 30, vz: -50 }], 2);
  check(() => assert.ok(h.vfx.counts.vortex > 0, 'wingtip vortices at high G'));
  frames(h, [{ ...jet, enginePower: 0.5, vx: 30, vz: -50 }], 30);
  const burner = h.vfx.counts.afterburner;
  frames(h, [{ ...jet, enginePower: 0.5, vx: 30, vz: -50 }], 30);
  check(() => assert.equal(h.vfx.counts.afterburner, burner, 'no afterburner at cruise power'));
  h.vfx.dispose(); h.fx.dispose(); h.view.dispose();
}

// --- FX CPU with a 16-hull synthetic load --------------------------------------------------------
{
  const h = harness();
  const rows = Array.from({ length: 16 }, (_, i) => {
    const type = VEHICLE_TYPE_IDS[i % VEHICLE_TYPE_IDS.length];
    const air = ['helicopter', 'transport', 'plane'].includes(type);
    return rowFor(type, { id: `load-${i}`, x: (i % 4) * 30 - 45, z: Math.floor(i / 4) * 30 - 45, y: GROUND + (air ? 6 : 0),
      seatOccupants: { driver: `d${i}` }, occupantId: `d${i}`, speed: 8, engineOn: true, st: VEHICLE_STATUS.engine | (i % 3 === 0 ? VEHICLE_STATUS.burning : 0),
      hp: Math.round(vehicleDef(type).hp * (i % 2 ? 0.3 : 0.9)), rotorSpeed: 1, enginePower: 0.9, grounded: !air, vz: -8 });
  });
  for (let i = 0; i < 60; i++) { for (const row of rows) row.z -= 8 / 60; frames(h, rows, 1); }
  let fxMs = 0;
  const count = 240;
  for (let i = 0; i < count; i++) {
    for (const row of rows) row.z -= 8 / 60;
    h.view.sync(rows, [], { id: 'me', team: 'alpha' });
    h.view.update(1 / 60, h.camera);
    if (i % 4 === 0) h.vfx.handleEvent({ kind: 'vehicle_hit', vehicleId: rows[i % 16].id, dmg: 20, zone: 'side', cls: 'hmg', eff: 1, pos: [rows[i % 16].x, GROUND + 1.5, rows[i % 16].z] }, 'me');
    const started = performance.now();
    h.vfx.update(1 / 60, h.camera, rows);
    h.fx.update(1 / 60, h.camera);
    fxMs += performance.now() - started;
  }
  const perFrame = fxMs / count;
  check(() => assert.ok(perFrame <= 1.5, `FX CPU ${perFrame.toFixed(3)} ms/frame with 16 hulls`));
  console.log(`  FX CPU: ${perFrame.toFixed(3)} ms/frame with 16 hulls (${h.fx.stats.alive} live particles)`);
  h.vfx.dispose(); h.fx.dispose(); h.view.dispose();
}

// --- Shader warm-up covers every vehicle program ------------------------------------------------
{
  const h = harness();
  const explosions = { spawn() {} };
  const destruction = new VehicleDestructionFX(h.scene, { explosions, camera: h.camera, getBlock, fx: h.fx, sfx: h.sfx, cameraShake: h.shake,
    getFragments: (id, options) => h.view.destructionFragments(id, options) });
  const warmed = collectProgramVariants(h.scene);
  const compiled = [];
  const renderer = { setRenderTarget() {}, info: { programs: [] }, compileAsync(root) { compiled.push(root); return Promise.resolve(root); } };
  const result = await warmShaders({ renderer, scene: h.scene, camera: h.camera, expectMaterials: VEHICLE_WARMUP_MATERIALS });
  check(() => assert.deepEqual(result.missing, [], 'every vehicle program family is in the warm-up scene'));
  check(() => assert.ok(compiled.includes(h.scene)));
  // Play a match: every type and team, damage, wrecks, destruction, every FX kind.
  const rows = VEHICLE_TYPE_IDS.flatMap((type, i) => ['alpha', 'bravo'].map((team, j) => rowFor(type, { id: `${type}-${team}`, team,
    x: i * 20 - 40, z: j * 20, hp: Math.round(vehicleDef(type).hp * 0.3), st: VEHICLE_STATUS.engine | VEHICLE_STATUS.burning,
    seatOccupants: {}, speed: 6, rotorSpeed: 1 })));
  frames(h, rows, 30);
  for (const row of rows) {
    h.vfx.handleEvent({ kind: 'vehicle_hit', vehicleId: row.id, dmg: 50, zone: 'side', cls: 'at', eff: 1, pos: [row.x, row.y + 1, row.z] }, 'me');
    h.vfx.handleEvent({ kind: 'countermeasure', vehicleId: row.id, cm: 'flares' }, 'me');
  }
  const doomed = rows.map(row => ({ ...row, hp: 0, wreck: true, wreckAge: 0 }));
  h.view.sync(doomed, [], null, { events: doomed.map(row => ({ kind: 'vehicle_destroyed', vehicleId: row.id, vehicleType: row.type, pos: [row.x, row.y, row.z] })) });
  for (const row of doomed) destruction.handleEvent({ kind: 'vehicle_destroyed', vehicleId: row.id, vehicleType: row.type, pos: [row.x, row.y, row.z] });
  for (let i = 0; i < 180; i++) { h.view.sync(doomed, [], null); h.view.update(1 / 60, h.camera); h.vfx.update(1 / 60, h.camera); h.fx.update(1 / 60, h.camera); destruction.update(1 / 60); }
  check(() => assert.ok(destruction.stats.tossed + destruction.stats.fragments > 0, 'fragments flew'));
  check(() => assert.ok(destruction.stats.cookoffs >= 10, 'cook-offs fired'));
  check(() => assert.ok(calledWith(h.sfx, 'vehicleDestruction').length >= 10, 'destruction is audible'));
  const played = collectProgramVariants(h.scene);
  const missing = [...played.variants].filter(variant => !warmed.variants.has(variant));
  check(() => assert.deepEqual(missing, [], 'no program first appears mid-match'));
  destruction.dispose(); h.vfx.dispose(); h.fx.dispose(); h.view.dispose();
}

// --- CombatFeedback hands mounted shots to VehicleFx; infantry is unchanged ---------------------
{
  const shots = [], fires = [], confirms = [], whiz = [];
  let selfRow = null;
  const feedback = new CombatFeedback({
    effects: { shoot: ev => shots.push(ev), confirmShot: ev => confirms.push(ev) },
    sfx: { fire: (...args) => fires.push(args), bulletWhiz: (...args) => whiz.push(args) },
    hud: { setPainImpulse() {} }, roster: { swingPickaxe() {} }, player: { alive: true, view: { yaw: 0 } },
    getMyId: () => 'me', getPlayersCache: () => [], getSelfRow: () => selfRow, isRunning: () => true,
    camera: { position: { x: 0, y: 1.6, z: 0 } }, world: { getBlock: () => 0 }, viewport: {},
  });
  const mounted = { kind: 'shoot', id: 'gunner', w: 'lmg', o: [0, 2, -40], d: [0, 0, 1], spread: [0, 0, 1],
    vehicleId: 'jeep-1', mount: 'pintle', vehicleWeapon: 'hmg', tracer: true, paths: [[{ o: [0, 2, -40], end: [0.3, 1.7, 5] }]] };
  feedback.handleEvent(mounted);
  check(() => assert.equal(shots.length, 0, 'no generic tracer/flash for a mounted shot'));
  check(() => assert.equal(fires.length, 0, 'no infantry report for a mounted shot'));
  check(() => assert.equal(whiz.length, 1, 'the listener still hears rounds pass'));
  feedback.handleEvent({ ...mounted, id: 'me' });
  check(() => assert.equal(confirms.length, 0, 'own mounted shots are not infantry predictions'));
  const infantry = { kind: 'shoot', id: 'rifleman', w: 'rifle', o: [0, 2, -40], d: [0, 0, 1], spread: [0, 0, 1] };
  feedback.handleEvent(infantry);
  check(() => assert.equal(shots.length, 1, 'infantry shots keep their presentation'));
  check(() => assert.equal(fires.length, 1));
  feedback.handleEvent({ ...infantry, id: 'me' });
  check(() => assert.equal(confirms.length, 1, 'own infantry shots still confirm the prediction'));
  // A passenger firing a personal weapon has no prediction: the shot is presented from the event.
  selfRow = { id: 'me', vehicleId: 'jeep-1', vehicleSeatId: 'rear-left' };
  feedback.handleEvent({ ...infantry, id: 'me' });
  check(() => assert.equal(confirms.length, 1));
  check(() => assert.equal(shots.length, 2, 'seated personal-weapon shot is drawn'));
  check(() => assert.equal(fires.length, 2, 'and heard'));
}

console.log(`Vehicle FX: ${checks} checks passed (event/snapshot-only triggers, budgets, warm-up coverage).`);
