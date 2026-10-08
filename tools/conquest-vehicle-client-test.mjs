// Conquest vehicle client: VehicleView (def-driven rigs, ground attitude and
// suspension, recoil, damage presentation, HP bar rules, contact blobs),
// VehicleController (seat actions, tap-on-release T, optics, crew commands)
// and the per-seat VehicleCamera (profiles, optics, speed FOV, free look,
// boresight, shake), plus the composition root's seat/fire handoff.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from '../public/js/vendor/three.module.js';
import { VehicleView, VEHICLE_VIEW } from '../public/js/engine/vehicle-view.js';
import { VehicleController, SEAT_KEYS, INTERACT_TAP_MS } from '../public/js/session/vehicle-controller.js';
import { VehicleCamera, VEHICLE_CAMERA, VEHICLE_VIEW_PREF_KEY, seatCameraProfile, seatViews, seatEyeWorld, vehicleViewLabel, cockpitLook,
  aircraftBoresight } from '../public/js/session/vehicle-camera.js';
import { KEYBINDING_ACTIONS, defaultKeybindings } from '../public/js/keybindings.js';
import { CameraShake, CAMERA_SHAKE } from '../public/js/engine/camera-shake.js';
import { Input } from '../public/js/engine/input.js';
import { LocalPlayer } from '../public/js/player/local-player.js';
import { WeaponState } from '../public/js/guns/weapon-state.js';
import { WEAPON_IDS } from '../shared/combatmath.js';
import { copySmokeFields } from '../shared/smoke-rules.js';
import { VEHICLE_STATUS, vehicleMountOrder, CONQUEST_RULES } from '../shared/conquest-contract.js';
import { vehicleDef, VEHICLE_RULES, vehicleWorldToLocal, vehicleDirection, mountPose } from '../shared/vehicle-defs.js';
import { vehicleSeats } from '../shared/vehicle-seats.js';
import { groundAttitude } from '../shared/vehicle-attitude.js';

globalThis.document ??= { createElement: () => ({ getContext: () => new Proxy({ measureText: () => ({ width: 60 }) }, { get: (o, k) => o[k] ?? (() => {}) }) }) };

let checks = 0;
const check = (fn) => { fn(); checks++; };
const mounts = type => vehicleMountOrder(type).map(() => [0, 0, 1, 0, 0]);
const tankRow = (extra = {}) => ({ id: 'tank-1', type: 'tank', team: 'alpha', x: 10, y: 10, z: 10, yaw: 0, turretYaw: Math.PI / 2, turretPitch: 0,
  hp: 600, mounts: mounts('tank'), seatOccupants: {}, ...extra });

// --- VehicleView -------------------------------------------------------------------------
{
  const view = new VehicleView();
  check(() => assert.equal(view.lightingRoot(), view.group, 'lighting root for worldview.addCharacterRoots'));
  view.sync([tankRow()], [], { id: 'me', team: 'alpha' });
  view.update(1 / 60);
  const item = view.items.get('tank-1');
  check(() => assert.equal(item.root.rotation.y, 0));
  check(() => assert.ok(Math.abs(item.model.turret.rotation.y - Math.PI / 2) < 1e-6, 'turret follows turretYaw independently of the hull'));
  check(() => assert.equal(item.hpBar.visible, false, 'parked, uncrewed hulls never show a bar'));
  // Friendly crewed and damaged: bar; own hull: never.
  view.sync([tankRow({ seatOccupants: { driver: 'mate' } })], [], { id: 'me', team: 'alpha' });
  view.update(1 / 60);
  check(() => assert.equal(item.hpBar.visible, true, 'friendly crewed damaged hull shows HP'));
  check(() => assert.ok(Math.abs(item.hpBar.geometry.attributes.position.getX(5) - (-0.7 + 1.4 * 0.6)) < 1e-6, 'bar uses vehicleMaxHp (1000), not a row maxHp'));
  view.sync([tankRow({ seatOccupants: { driver: 'me' } })], [], { id: 'me', team: 'alpha' });
  view.update(1 / 60);
  check(() => assert.equal(item.hpBar.visible, false, 'no HP bar over your own hull'));
  view.sync([tankRow({ seatOccupants: { driver: 'foe' }, team: 'bravo' })], [], { id: 'me', team: 'alpha' });
  check(() => assert.equal(view.items.get('tank-1') !== item, true, 'a team change repaints (camouflage is baked per team)'));
  view.update(1 / 60);
  check(() => assert.equal(view.items.get('tank-1').hpBar.visible, false, 'enemy hulls show no bar'));
  // Every hull and glass material is fogged (aircraft included).
  view.sync(['jeep', 'tank', 'helicopter', 'transport', 'plane'].map((type, i) => ({ id: type, type, team: 'alpha', x: i * 20, y: 10, z: 0, yaw: 0, hp: vehicleDef(type).hp })), [], null);
  view.update(1 / 60);
  for (const it of view.items.values()) it.root.traverse(o => {
    if (o.isMesh && o.name !== 'vehicle-hp-bar') check(() => assert.notEqual(o.material.fog, false, `${it.kind} ${o.name} is fogged`));
  });
  // Damage presentation: soot from hp, burn from st, lamps from the engine bit.
  view.sync([{ id: 'tank', type: 'tank', team: 'alpha', x: 0, y: 10, z: 0, yaw: 0, hp: 200, st: VEHICLE_STATUS.engine | VEHICLE_STATUS.burning }], [], null);
  view.update(1 / 60);
  const state = view.items.get('tank').materials.material.userData.vehicleState.value;
  check(() => assert.ok(state.x > 0.2, 'soot below half HP'));
  check(() => assert.equal(state.z, 0.5, 'burning glow'));
  check(() => assert.equal(state.y, 1, 'lamps on with the engine'));
  // Wreck: charred, tilted, crew cleared; respawn restores.
  view.sync([{ id: 'tank', type: 'tank', team: 'alpha', x: 0, y: 10, z: 0, yaw: 0, hp: 0, wreck: true }], [], null);
  view.update(1 / 60);
  check(() => assert.equal(view.items.get('tank').wreck, true));
  check(() => assert.equal(state.x, 1));
  check(() => assert.ok(view.items.get('tank').model.group.rotation.z > 0, 'ground wrecks settle at a tilt'));
  view.sync([{ id: 'tank', type: 'tank', team: 'alpha', x: 0, y: 10, z: 0, yaw: 0, hp: 1000 }], [], null);
  view.update(1 / 60);
  check(() => assert.equal(view.items.get('tank').wreck, false));
  // Main gun recoil 0.6 m and a ~2 degree rock, both decaying.
  const tank = view.items.get('tank');
  const recoil = tank.model.mounts['driver:main'].recoilNode;
  for (let i = 0; i < 30; i++) view.update(1 / 60);
  const rest = recoil.position.z;
  check(() => assert.equal(view.kick('tank', 'main'), true));
  view.update(1 / 60);
  check(() => assert.ok(recoil.position.z - rest > 0.45 && recoil.position.z - rest <= VEHICLE_VIEW.tankRecoil + 1e-9, 'barrel recoils up to 0.6 m'));
  let peak = 0;
  for (let i = 0; i < 40; i++) { view.update(1 / 60); peak = Math.max(peak, Math.abs(tank.model.body.rotation.x), Math.abs(tank.model.body.rotation.z)); }
  check(() => assert.ok(peak > 0.02 && peak < 0.06, `hull rocks about 2 degrees (${(peak * 180 / Math.PI).toFixed(2)})`));
  for (let i = 0; i < 120; i++) view.update(1 / 60);
  check(() => assert.ok(Math.abs(recoil.position.z - rest) < 1e-9, 'barrel returns'));
  check(() => assert.equal(view.kick('missing', 'main'), false));
  view.dispose();
}

// Ground attitude from the voxel support (the shared function the server uses).
{
  const slope = (x, y, z) => (y < 10 + Math.floor(Math.max(0, z) / 3) ? 1 : 0); // rises 1 voxel per 3 m toward +z
  const view = new VehicleView({ getBlock: slope });
  const row = { id: 'j', type: 'jeep', team: 'alpha', x: 20, y: 12, z: 6, yaw: 0, hp: 320 };
  view.sync([row], [], null);
  for (let i = 0; i < 90; i++) view.update(1 / 60);
  const fit = groundAttitude(slope, 'jeep', row.x, row.z, row.yaw, row.y);
  const root = view.items.get('j').root;
  check(() => assert.ok(Math.abs(fit.pitch) > 0.05, 'fixture actually slopes'));
  check(() => assert.ok(Math.abs(root.rotation.x - fit.pitch) < 0.01, 'hull pitch eases to groundAttitude'));
  check(() => assert.ok(Math.abs(root.rotation.z - fit.roll) < 0.01));
  // Suspension squats under acceleration and settles.
  const body = view.items.get('j').model.body;
  view.sync([{ ...row, speed: 10 }], [], null);
  view.update(1 / 60);
  let squat = 0;
  for (let i = 0; i < 12; i++) { view.update(1 / 60); squat = Math.max(squat, Math.abs(body.rotation.x)); }
  check(() => assert.ok(squat > 0.002, 'spring suspension reacts to the speed change'));
  // Contact blobs: one per wheel axle or track pair, stretched along yaw.
  const blobs = [];
  view.addContactShadows({ add: (...args) => blobs.push(args) });
  check(() => assert.equal(blobs.length, 2, 'jeep: two axle blobs'));
  check(() => assert.ok(blobs.every(args => args[5] < 1 && Math.abs(args[6] - Math.PI / 2) < 0.2), 'axle blobs lie across the hull'));
  view.dispose();
}

/** Vertex-exact world bounds, instances included (Box3.setFromObject inflates rotated instances). */
function preciseBounds(root) {
  const box = new THREE.Box3(), v = new THREE.Vector3(), m = new THREE.Matrix4(), world = new THREE.Matrix4();
  root.updateMatrixWorld(true);
  root.traverse(object => {
    if (!object.isMesh || !object.visible || !object.geometry.attributes.position) return;
    const p = object.geometry.attributes.position;
    const count = object.isInstancedMesh ? object.count : 1;
    for (let i = 0; i < count; i++) {
      if (object.isInstancedMesh) { object.getMatrixAt(i, m); world.multiplyMatrices(object.matrixWorld, m); } else world.copy(object.matrixWorld);
      for (let j = 0; j < p.count; j++) box.expandByPoint(v.fromBufferAttribute(p, j).applyMatrix4(world));
    }
  });
  return box;
}

// Server rows drive the view: feet on the ground, belts counter-rotate on a pivot.
{
  const { VehicleSystem } = await import('../server/sim/vehicles.js');
  const player = { id: 'driver', state: 'alive', team: 'alpha', x: 40, y: 1, z: 40, input: { vehicleThrottle: 0, vehicleSteer: 1 } };
  const engine = { entities: new Map([[player.id, player]]), tickEvents: [], world: { dimensions: { sx: 100, sy: 20, sz: 100 }, getBlock: (_x, y) => y === 0 ? 3 : 0 },
    mapMeta: { conquest: { vehicleSpawns: [{ id: 't', type: 'tank', team: 'alpha', x: 40, y: 1, z: 40 }, { id: 'j', type: 'jeep', team: 'alpha', x: 20, y: 1, z: 20 }] } } };
  const system = new VehicleSystem(engine), models = new VehicleView({ getBlock: engine.world.getBlock });
  system.action ? system.action(player, { type: 'enter', vehicleId: 't' }) : system.enter(player, 't');
  for (let i = 0; i < 6; i++) system.step(1 / 60);
  const rows = system.snapshot();
  const tank = rows.find(v => v.id === 't');
  check(() => assert.ok(tank.leftTrackSpeed > 0 && tank.rightTrackSpeed < 0, 'pivot drives opposite belts'));
  check(() => assert.equal(tank.maxHp, undefined, 'rows no longer carry maxHp'));
  models.sync(rows, [], null);
  for (let i = 0; i < 10; i++) models.update(1 / 60);
  for (const id of ['t', 'j']) {
    const item = models.items.get(id);
    item.root.updateMatrixWorld(true);
    const bounds = preciseBounds(item.model.group);
    check(() => assert.ok(Math.abs(bounds.min.y - item.root.position.y) < 0.12, `${id} feet on the snapshot ground (${(bounds.min.y - item.root.position.y).toFixed(3)})`));
    check(() => assert.ok(bounds.max.y - item.root.position.y <= VEHICLE_RULES[item.kind].height + 1.3, `${id} fits its chassis height`));
  }
  models.dispose();
}

// --- VehicleController ---------------------------------------------------------------------
function keyTarget() {
  const listeners = new Map();
  return {
    listeners,
    addEventListener: (type, fn) => { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
    removeEventListener: (type, fn) => listeners.get(type)?.delete(fn),
    fire(type, init) {
      const event = { repeat: false, defaultPrevented: false, target: null, button: 0, ...init, prevented: false, preventDefault() { this.prevented = true; } };
      for (const fn of listeners.get(type) || []) fn(event);
      return event;
    },
    count: () => [...listeners.values()].reduce((n, set) => n + set.size, 0),
  };
}
{
  let clock = 1000;
  const target = keyTarget();
  const camera = new THREE.PerspectiveCamera(70, 16 / 9);
  const controller = new VehicleController({ camera, eventTarget: target, raycast: () => null, now: () => clock });
  const self = { id: 'p', state: 'alive', team: 'alpha', x: 11, y: 10, z: 10, hp: 100 };
  const tank = tankRow();
  controller.sync({ self, vehicles: [tank], enabled: true });
  check(() => assert.equal(controller.active, false));
  check(() => assert.equal(controller.nearest, tank));
  // T is a tap: the action fires on release before the repair-hold threshold.
  check(() => assert.equal(INTERACT_TAP_MS, CONQUEST_RULES.repairHoldStartMs));
  target.fire('keydown', { code: 'KeyT' });
  clock += 120;
  check(() => assert.equal(controller.interactHeldMs(), 120));
  check(() => assert.equal(controller.consumeAction(), null, 'nothing queued while T is held'));
  target.fire('keyup', { code: 'KeyT' });
  check(() => assert.deepEqual(controller.consumeAction(), { type: 'enter', vehicleId: 'tank-1' }));
  check(() => assert.equal(controller.interactHeldMs(), 0));
  target.fire('keydown', { code: 'KeyT' });
  clock += INTERACT_TAP_MS + 50;
  target.fire('keyup', { code: 'KeyT' });
  check(() => assert.equal(controller.consumeAction(), null, 'a long hold (repair) never enters or exits'));
  // F2 enters straight into the commander seat; F5 is swallowed so the page never reloads.
  check(() => assert.deepEqual(SEAT_KEYS, ['F1', 'F2', 'F3', 'F4', 'F5']));
  target.fire('keydown', { code: 'F2' });
  check(() => assert.deepEqual(controller.consumeAction(), { type: 'enter', vehicleId: 'tank-1', seatId: 'commander' }));
  const f5 = target.fire('keydown', { code: 'F5' });
  check(() => assert.equal(f5.prevented, true));
  check(() => assert.equal(controller.consumeAction(), null, 'no third tank seat'));

  // Seated as the driver: main gun aim, AP/HE cycling, smoke, seat switch, exit.
  const seated = tankRow({ seatOccupants: { driver: 'p' }, occupantId: 'p', turretYaw: 0.4, mounts: [[0.4, 0.05, 1, 0, 0], [0.4, 0.05, 1, 0, 0], [0, 0, 1, 0, 0]] });
  controller.sync({ self: { ...self, vehicleId: 'tank-1' }, vehicles: [seated], enabled: true });
  check(() => assert.equal(controller.active, true));
  check(() => assert.equal(controller.seatId, 'driver'));
  check(() => assert.equal(controller.canFire, true));
  check(() => assert.ok(Math.abs(controller.yaw - 0.4) < 1e-9, 'aim seeds from the main mount'));
  check(() => assert.deepEqual(controller.selectedWeapon(), { mount: 'main', weapon: 'tankAP', index: 0, count: 3 }));
  target.fire('keydown', { code: 'KeyQ' });
  check(() => assert.deepEqual(controller.consumeAction(), { type: 'weapon', index: 1 }));
  controller.sync({ self: { ...self, vehicleId: 'tank-1' }, vehicles: [{ ...seated, sel: { driver: 2 } }], enabled: true });
  check(() => assert.equal(controller.selectedWeapon().weapon, 'coaxMG', 'selection read from row.sel'));
  target.fire('keydown', { code: 'KeyQ' });
  check(() => assert.deepEqual(controller.consumeAction(), { type: 'weapon', index: 0 }, 'cycle wraps'));
  target.fire('keydown', { code: 'Digit2' });
  check(() => assert.deepEqual(controller.consumeAction(), { type: 'weapon', index: 1 }, 'slot keys pick a weapon directly'));
  target.fire('keydown', { code: 'Digit3' });
  check(() => assert.equal(controller.consumeAction(), null, 'the selected weapon is no change'));
  target.fire('keydown', { code: 'Digit5' });
  check(() => assert.equal(controller.consumeAction(), null, 'no fifth weapon'));
  target.fire('keydown', { code: 'KeyX' });
  check(() => assert.deepEqual(controller.consumeAction(), { type: 'cm' }, 'X pops smoke'));
  target.fire('keydown', { code: 'F2' });
  check(() => assert.deepEqual(controller.consumeAction(), { type: 'seat', seatId: 'commander' }));
  target.fire('keydown', { code: 'F1' });
  check(() => assert.equal(controller.consumeAction(), null, 'the current seat is no switch'));
  let command = controller.controls({ forward: true, left: true, jump: true }, { dx: 0.3, dy: 0.1 }, true);
  check(() => assert.equal(command.vehicleThrottle, 1));
  check(() => assert.equal(command.vehicleSteer, -1));
  check(() => assert.equal(command.vehicleBrake, 1));
  check(() => assert.equal(command.wantFire, true));
  check(() => assert.ok(Math.abs(command.yaw - 0.1) < 1e-9 && Math.abs(command.pitch + 0.05) < 1e-9, 'driver look aims the main gun'));
  // C holds free look: the gun keeps its aim and fire is held back.
  target.fire('keydown', { code: 'KeyC' });
  command = controller.controls({}, { dx: 0.5, dy: 0 }, true);
  check(() => assert.ok(Math.abs(command.yaw - 0.1) < 1e-9, 'free look leaves the aim'));
  check(() => assert.equal(command.wantFire, false));
  target.fire('keyup', { code: 'KeyC' });
  check(() => assert.equal(controller.freeLook, false));
  target.fire('keydown', { code: 'KeyT' }); target.fire('keyup', { code: 'KeyT' });
  check(() => assert.deepEqual(controller.consumeAction(), { type: 'exit' }));
  // Optic subscription (RMB): tank 3x.
  const optics = [];
  const unsubscribe = controller.onOptic(state => optics.push(state));
  target.fire('mousedown', { button: 2 });
  target.fire('mouseup', { button: 2 });
  check(() => assert.deepEqual(optics, [{ active: true, zoom: 3, seatId: 'driver' }, { active: false, zoom: 1, seatId: 'driver' }]));
  unsubscribe();

  // Commander (gunner) aims the RWS and fires; no hull-locked camera.
  controller.sync({ self, vehicles: [{ ...seated, seatOccupants: { driver: 'mate', commander: 'p' }, occupantId: 'mate' }], enabled: true });
  check(() => assert.equal(controller.seatId, 'commander'));
  check(() => assert.equal(controller.role, 'gunner'));
  command = controller.controls({ forward: true }, { dx: 0.2, dy: -0.1 }, true);
  check(() => assert.equal(command.wantFire, true, 'gunner seats fire'));
  check(() => assert.equal(command.vehicleThrottle, undefined, 'gunners send no drive axes'));
  target.fire('keydown', { code: 'KeyX' });
  check(() => assert.equal(controller.consumeAction(), null, 'only the driving seat pops countermeasures'));
  target.fire('keydown', { code: 'KeyQ' });
  check(() => assert.equal(controller.consumeAction(), null, 'single-weapon seats do not cycle'));
  // Jet pilot: Q is also the left rudder (Input leanLeft -> flightYawLeft), so it never flips the weapon; slot keys do.
  const jet = { id: 'plane-1', type: 'plane', team: 'alpha', x: 11, y: 10, z: 10, yaw: 0, hp: 450, seatOccupants: { driver: 'p' }, occupantId: 'p' };
  controller.sync({ self, vehicles: [jet], enabled: true });
  check(() => assert.equal(controller.selectedWeapon().count, 2));
  target.fire('keydown', { code: 'KeyQ' });
  check(() => assert.equal(controller.consumeAction(), null, 'the jet rudder key does not cycle weapons'));
  target.fire('keydown', { code: 'Digit2' });
  check(() => assert.deepEqual(controller.consumeAction(), { type: 'weapon', index: 1 }, 'jet slot 2 picks the missiles'));
  // Jeep passenger looks around and may fire a personal weapon.
  const jeep = { id: 'jeep', type: 'jeep', team: 'alpha', x: 11, y: 10, z: 10, yaw: 0.7, hp: 320, seatOccupants: { driver: 'd', 'front-passenger': 'p' } };
  controller.sync({ self, vehicles: [jeep], enabled: true });
  check(() => assert.equal(controller.role, 'passenger'));
  check(() => assert.equal(controller.canFire, true, 'personal-weapon seat'));
  const before = controller.yaw;
  command = controller.controls({}, { dx: 0.4, dy: 0 }, true);
  check(() => assert.ok(Math.abs(command.yaw - (before - 0.4)) < 1e-9, 'passengers look around'));
  check(() => assert.equal(command.wantFire, true));
  // Leaving the hull restores the infantry FOV and clears queued actions.
  controller.sync({ self, vehicles: [{ ...jeep, seatOccupants: { driver: 'd' } }], enabled: true });
  check(() => assert.equal(controller.active, false));
  check(() => assert.equal(controller.consumeAction(), null));
  controller.dispose();
  check(() => assert.equal(target.count(), 0, 'controller releases every listener'));
}

// Gamepad Interact (D-pad left) through the real Input: Input.padButtons feeds
// VehicleController.padInteract, which taps enter/exit exactly like T.
{
  let clock = 5000;
  const input = new Input({});
  input.fallback = true;
  const pad = { id: 'pad', mapping: 'standard', connected: true, axes: [0, 0, 0, 0], buttons: [] };
  input._pad.navigator = { getGamepads: () => [pad] };
  const controller = new VehicleController({ camera: new THREE.PerspectiveCamera(), eventTarget: null, now: () => clock });
  const self = { id: 'p', state: 'alive', team: 'alpha', x: 11, y: 10, z: 10, hp: 100 };
  const frame = (held, enabled = true) => {
    pad.buttons = Array.from({ length: 17 }, (_, i) => ({ pressed: held && i === 14, value: held && i === 14 ? 1 : 0 }));
    input.poll(clock, 1 / 60);
    const buttons = input.padButtons;
    return controller.padInteract({ held: !!buttons?.held.interact, pressed: !!buttons?.pressed.interact }, enabled && !!buttons);
  };
  try {
    controller.sync({ self, vehicles: [tankRow()], enabled: true });
    frame(true); clock += 120; frame(true);
    check(() => assert.equal(controller.consumeAction(), null, 'nothing queued while D-pad left is held'));
    clock += 40; frame(false);
    check(() => assert.deepEqual(controller.consumeAction(), { type: 'enter', vehicleId: 'tank-1' }, 'a D-pad left tap enters'));
    frame(true); clock += INTERACT_TAP_MS + 50; frame(true); frame(false);
    check(() => assert.equal(controller.consumeAction(), null, 'a long pad hold (repair / revive) never enters'));
    controller.sync({ self: { ...self, vehicleId: 'tank-1' }, vehicles: [tankRow({ seatOccupants: { driver: 'p' } })], enabled: true });
    frame(true); clock += 60; frame(false);
    check(() => assert.deepEqual(controller.consumeAction(), { type: 'exit' }, 'a D-pad left tap leaves the hull'));
    frame(true); frame(true, false); frame(false);
    check(() => assert.equal(controller.consumeAction(), null, 'a hold through a menu is dropped, not tapped'));
    frame(true); pad.connected = false; input.poll(clock, 1 / 60);
    controller.padInteract({ held: false, pressed: false }, !!input.padButtons);
    check(() => assert.equal(controller.consumeAction(), null, 'losing the pad mid-press never exits'));
  } finally { controller.dispose(); input.dispose(); }
}

// Crew membership edge cases.
{
  const controller = new VehicleController({ camera: new THREE.PerspectiveCamera(), eventTarget: null });
  const self = { id: 'p', state: 'alive', team: 'alpha', x: 11, y: 10, z: 10 };
  const jeep = { id: 'crew', type: 'jeep', team: 'alpha', x: 12, y: 10, z: 10, yaw: 0, hp: 320, seatOccupants: { driver: 'o', 'front-passenger': null, 'rear-left': 'a', gunner: 'b' } };
  const full = { ...jeep, id: 'full', x: 11.1, seatOccupants: { driver: 'o', 'front-passenger': 'c', 'rear-left': 'a', gunner: 'b' } };
  const enemy = { ...jeep, id: 'enemy', team: 'bravo', x: 11.05 };
  controller.sync({ self, vehicles: [full, enemy, jeep], enabled: true });
  check(() => assert.equal(controller.nearest, jeep, 'entry picks an allied hull with a free seat'));
  controller.sync({ self: { ...self, vehicleId: 'crew', vehicleSeatId: 'rear-left' }, vehicles: [{ ...jeep, seatOccupants: { driver: 'o' } }], enabled: true });
  check(() => assert.equal(controller.active, false, 'a stale player hint cannot hold a seat'));
  controller.sync({ self: { ...self, state: 'dead' }, vehicles: [jeep], enabled: true });
  check(() => assert.equal(controller.queueInteract(), false, 'the dead cannot board'));
  controller.dispose();
}

// --- VehicleCamera -------------------------------------------------------------------------
{
  check(() => assert.deepEqual(seatCameraProfile('tank', 'driver'), { mode: 'chase', distance: 9.5, height: 3.4, optic: 3,
    views: ['chase', 'action', 'cockpit'], eye: [0, 3.35, 0.3], eyeFrame: 'turret' }));
  check(() => assert.equal(seatCameraProfile('helicopter', 'gunner').optic, 4, 'chin gunner 4x'));
  check(() => assert.equal(seatCameraProfile('transport', 'door-left').optic, 1.5, 'door gun 1.5x'));
  check(() => assert.equal(seatCameraProfile('jeep', 'rear-left').mode, 'passenger'));
  for (const type of ['jeep', 'tank', 'helicopter', 'transport', 'plane']) for (const seat of vehicleSeats(type)) {
    check(() => assert.ok(seatCameraProfile(type, seat.id).distance >= 0));
  }
  let wall = null;
  const camera = new THREE.PerspectiveCamera(70, 16 / 9);
  const view = new VehicleCamera({ camera, raycast: () => wall, getBaseFov: () => 70 });
  const tank = tankRow({ turretYaw: 0 });
  view.update(1 / 60, { row: tank, seatId: 'driver', aimYaw: 0, aimPitch: 0 });
  check(() => assert.equal(view.mode, 'chase'));
  check(() => assert.ok(Math.abs(camera.position.distanceTo(view.focus) - 9.5) < 1e-6, 'tank chase distance from the seat profile'));
  check(() => assert.ok(camera.position.z > tank.z, 'behind a gun aimed along -Z'));
  wall = { t: 2 };
  view.update(1 / 60, { row: tank, seatId: 'driver', aimYaw: 0, aimPitch: 0 });
  check(() => assert.ok(Math.abs(camera.position.distanceTo(view.focus) - (2 - VEHICLE_CAMERA.clearance)) < 1e-6, 'walls shorten the orbit at once'));
  wall = null;
  for (const dt of [NaN, Infinity, -1]) view.update(dt, { row: tank, seatId: 'driver', aimYaw: 0, aimPitch: 0 });
  check(() => assert.ok([camera.position.x, camera.position.y, camera.position.z].every(Number.isFinite)));
  // RMB: the tank driver looks through the 3x gunner's sight at the main gun.
  for (let i = 0; i < 20; i++) view.update(1 / 60, { row: tank, seatId: 'driver', aimYaw: 0, aimPitch: 0, optic: true });
  check(() => assert.ok(Math.abs(camera.fov - 70 / 3) < 0.5, `3x optic (${camera.fov.toFixed(2)})`));
  const gun = camera.position.clone();
  check(() => assert.ok(gun.distanceTo(new THREE.Vector3(tank.x, tank.y + 2, tank.z)) < 4, 'sight sits at the gun'));
  // Speed widens the FOV by up to 8 degrees.
  for (let i = 0; i < 120; i++) view.update(1 / 60, { row: { ...tank, speed: 13 }, seatId: 'driver', aimYaw: 0, aimPitch: 0 });
  check(() => assert.ok(Math.abs(camera.fov - 78) < 0.2, `speed FOV (${camera.fov.toFixed(2)})`));
  // Free look orbits the camera only, then springs back.
  view.addFreeLook(-1, 0);
  view.update(1 / 60, { row: tank, seatId: 'driver', aimYaw: 0, aimPitch: 0, freeLook: true });
  check(() => assert.ok(Math.abs(camera.rotation.y - 1) < 0.05, 'free look turns the view'));
  for (let i = 0; i < 180; i++) view.update(1 / 60, { row: tank, seatId: 'driver', aimYaw: 0, aimPitch: 0 });
  check(() => assert.ok(Math.abs(camera.rotation.y) < 0.02, 'free look returns'));
  // Chin gunner: a stabilised sight at the chin, 4x on RMB.
  const heli = { id: 'h', type: 'helicopter', team: 'alpha', x: 0, y: 30, z: 0, yaw: 0, pitch: 0, roll: 0, hp: 650, mounts: mounts('helicopter') };
  view.begin();
  for (let i = 0; i < 20; i++) view.update(1 / 60, { row: heli, seatId: 'gunner', aimYaw: 0.5, aimPitch: -0.3, optic: true });
  check(() => assert.equal(view.mode, 'gimbal'));
  check(() => assert.ok(Math.abs(camera.fov - 17.5) < 0.3, 'chin 4x'));
  check(() => assert.ok(Math.abs(camera.rotation.y - 0.5) < 1e-6 && Math.abs(camera.rotation.x + 0.3) < 1e-6, 'sight looks along the aim'));
  check(() => assert.ok(camera.position.y < heli.y + 1.2, 'sight at the chin'));
  // Pilot: boresight on the pods' convergence point.
  const bore = aircraftBoresight({ ...heli, pitch: 0.1 });
  check(() => assert.ok(bore && Math.abs(Math.hypot(...bore.dir) - 1) < 1e-9));
  view.begin();
  view.update(1 / 60, { row: { ...heli, pitch: 0.1 }, seatId: 'driver', aimYaw: 0, aimPitch: 0 });
  const forward = camera.getWorldDirection(new THREE.Vector3());
  const aim = new THREE.Vector3(...bore.origin).addScaledVector(new THREE.Vector3(...bore.dir), VEHICLE_CAMERA.boresightRange).sub(camera.position).normalize();
  check(() => assert.ok(forward.dot(aim) > 0.9999, 'the screen centre is the pods\' convergence point'));
  check(() => assert.equal(aircraftBoresight(tank), null));
  // Door gunner: over the shoulder of the minigun, 1.5x optic.
  const transport = { id: 'tr', type: 'transport', team: 'alpha', x: 0, y: 10, z: 0, yaw: 0, hp: 600, mounts: [[Math.PI / 2, 0, 1, 0, 0], [-Math.PI / 2, 0, 1, 0, 0]] };
  view.begin();
  for (let i = 0; i < 20; i++) view.update(1 / 60, { row: transport, seatId: 'door-left', aimYaw: Math.PI / 2, aimPitch: 0, optic: true });
  check(() => assert.equal(view.mode, 'mount'));
  check(() => assert.ok(Math.abs(camera.fov - 70 / 1.5) < 0.5));
  // Leaving the vehicle restores the base FOV.
  view.end();
  check(() => assert.equal(camera.fov, 70));
}

// --- Camera views (V) --------------------------------------------------------------------------
{
  const memory = () => {
    const data = new Map();
    return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, String(value)), data };
  };
  // Every seat offers its own camera plus first person; drivers get the action chase, pilots the fly-by.
  check(() => assert.deepEqual(seatViews('plane', 'driver'), ['chase', 'action', 'cockpit', 'flyby']));
  check(() => assert.deepEqual(seatViews('helicopter', 'driver'), ['chase', 'action', 'cockpit', 'flyby']));
  check(() => assert.deepEqual(seatViews('transport', 'driver'), ['chase', 'action', 'cockpit', 'flyby']));
  check(() => assert.deepEqual(seatViews('jeep', 'driver'), ['chase', 'action', 'cockpit']));
  check(() => assert.deepEqual(seatViews('tank', 'driver'), ['chase', 'action', 'cockpit']));
  check(() => assert.deepEqual(seatViews('helicopter', 'gunner'), ['gimbal', 'cockpit']));
  check(() => assert.deepEqual(seatViews('tank', 'commander'), ['mount', 'cockpit']));
  check(() => assert.deepEqual(seatViews('transport', 'door-right'), ['mount', 'cockpit']));
  for (const [type, seat] of [['jeep', 'front-passenger'], ['jeep', 'rear-left'], ['transport', 'rear-right']]) {
    check(() => assert.deepEqual(seatViews(type, seat), ['passenger', 'cockpit'], `${type} ${seat}: orbit and first person`));
  }
  check(() => assert.equal(vehicleViewLabel('plane', 'driver', 'cockpit'), 'COCKPIT'));
  check(() => assert.equal(vehicleViewLabel('tank', 'driver', 'cockpit'), 'HATCH'));
  check(() => assert.equal(vehicleViewLabel('transport', 'door-left', 'cockpit'), 'FIRST PERSON'));
  check(() => assert.equal(cockpitLook('plane', 'driver'), 'hull'));
  check(() => assert.equal(cockpitLook('jeep', 'driver'), 'hull'));
  check(() => assert.equal(cockpitLook('tank', 'driver'), 'aim', 'the tank hatch follows the gun'));

  // Cycling wraps through the seat's views and is remembered per hull type and seat.
  const storage = memory();
  const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.05, 400);
  const view = new VehicleCamera({ camera, raycast: () => null, getBaseFov: () => 70, storage });
  const jet = { id: 'j', type: 'plane', team: 'alpha', x: 0, y: 80, z: 0, yaw: 0.3, pitch: 0.05, roll: 0.6, hp: 450, vx: -20, vy: 0, vz: -80,
    mounts: vehicleMountOrder('plane').map(() => [0, 0, 1, 0, 0]) };
  view.begin();
  view.update(1 / 60, { row: jet, seatId: 'driver' });
  check(() => assert.equal(view.view, 'chase', 'the first view is the default'));
  check(() => assert.equal(view.cycleView('plane', 'driver', { nowMs: 5 }), 'action'));
  check(() => assert.equal(view.viewChangedAt, 5));
  check(() => assert.equal(view.cycleView('plane', 'driver'), 'cockpit'));
  check(() => assert.deepEqual(JSON.parse(storage.data.get(VEHICLE_VIEW_PREF_KEY)), { plane: { driver: 'cockpit' } }));
  check(() => assert.equal(view.cycleView('plane', 'driver'), 'flyby'));
  check(() => assert.equal(view.cycleView('plane', 'driver'), 'chase', 'the cycle wraps'));
  view.setView('plane', 'driver', 'cockpit');
  check(() => assert.equal(view.setView('plane', 'driver', 'gimbal'), 'cockpit', 'a view the seat lacks is ignored'));
  const again = new VehicleCamera({ camera: new THREE.PerspectiveCamera(70, 16 / 9), getBaseFov: () => 70, storage });
  again.update(1 / 60, { row: jet, seatId: 'driver' });
  check(() => assert.equal(again.view, 'cockpit', 'a new seat in a jet starts in the remembered view'));
  again.update(1 / 60, { row: tankRow(), seatId: 'driver' });
  check(() => assert.equal(again.view, 'chase', 'other hull types keep their own choice'));
  const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
  const guarded = new VehicleCamera({ camera: new THREE.PerspectiveCamera(), getBaseFov: () => 70, storage: broken });
  check(() => assert.equal(guarded.cycleView('jeep', 'driver'), 'action', 'blocked storage never throws'));
  check(() => assert.equal(guarded.viewState(), null, 'no HUD state while not seated'));
  storage.data.set(VEHICLE_VIEW_PREF_KEY, '{"plane": {"driver": "warp"}}');
  check(() => assert.equal(new VehicleCamera({ camera, storage }).storedView('plane', 'driver'), 'chase', 'unknown stored views fall back'));
  storage.data.set(VEHICLE_VIEW_PREF_KEY, JSON.stringify({ plane: { driver: 'cockpit' } }));

  // Cockpit: the eye sits inside the hull footprint and above the seat, the
  // camera rolls with the jet (the chase stays level) and the screen centre
  // stays on the boresight.
  const right = () => new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
  const forward = () => camera.getWorldDirection(new THREE.Vector3());
  const boreAim = row => {
    const bore = aircraftBoresight(row);
    return new THREE.Vector3(...bore.origin).addScaledVector(new THREE.Vector3(...bore.dir), VEHICLE_CAMERA.boresightRange).sub(camera.position).normalize();
  };
  view.setView('plane', 'driver', 'chase');
  view.update(1 / 60, { row: jet, seatId: 'driver' });
  check(() => assert.ok(Math.abs(right().y) < 1e-6, 'the chase horizon stays level'));
  check(() => assert.equal(view.firstPerson, false));
  view.setView('plane', 'driver', 'cockpit');
  view.update(1 / 60, { row: jet, seatId: 'driver' });
  check(() => assert.equal(view.firstPerson, true));
  check(() => assert.ok(Math.abs(Math.asin(right().y) - 0.6) < 0.05, `the cockpit rolls with the hull (${Math.asin(right().y).toFixed(3)})`));
  check(() => assert.ok(forward().dot(boreAim(jet)) > 0.99999, 'the cockpit centre is the nose gun boresight'));
  const eyeLocal = vehicleWorldToLocal(jet, camera.position.toArray());
  check(() => assert.ok(eyeLocal[1] > vehicleDef('plane').seats[0].position[1] + 0.5, 'the eye is above the seat'));
  const heli = { id: 'h', type: 'helicopter', team: 'alpha', x: 5, y: 40, z: 5, yaw: -0.4, pitch: -0.1, roll: -0.2, hp: 650,
    mounts: vehicleMountOrder('helicopter').map(() => [-0.4, 0, 1, 0, 0]) };
  view.setView('helicopter', 'driver', 'cockpit');
  view.update(1 / 60, { row: heli, seatId: 'driver' });
  check(() => assert.ok(forward().dot(boreAim(heli)) > 0.99999, 'the helicopter cockpit centre is the pods\' convergence point'));
  // Free look turns the head inside the cockpit, within limits.
  view.addFreeLook(-1.2, 0);
  view.update(1 / 60, { row: heli, seatId: 'driver', freeLook: true });
  const hullForward = new THREE.Vector3(...vehicleDirection(heli.yaw, heli.pitch));
  check(() => assert.ok(forward().dot(hullForward) < 0.6, 'free look turns the head away from the nose'));
  for (let i = 0; i < 40; i++) view.addFreeLook(-1, 0);
  view.update(1 / 60, { row: heli, seatId: 'driver', freeLook: true });
  check(() => assert.ok(forward().dot(hullForward) > Math.cos(VEHICLE_CAMERA.cockpitYaw) - 0.15, 'the head stops at the cockpit limit'));
  // A mouse-aim pilot's head follows the aim point a little.
  view.begin();
  view.setView('plane', 'driver', 'cockpit');
  view.update(1 / 60, { row: { ...jet, roll: 0 }, seatId: 'driver', flightAim: { yaw: jet.yaw + 0.5, pitch: 0.05 } });
  check(() => assert.ok(forward().dot(new THREE.Vector3(...vehicleDirection(jet.yaw + 0.5, 0.05))) > 0.999, 'the head looks toward the flight aim'));
  for (const type of ['jeep', 'tank', 'helicopter', 'transport', 'plane']) for (const seat of vehicleSeats(type)) {
    const row = { id: type, type, x: 3, y: 20, z: -4, yaw: 0.7, pitch: 0.02, roll: -0.03, turretYaw: 0.7, turretPitch: 0,
      mounts: vehicleMountOrder(type).map(key => [0.7 + (vehicleDef(type).mounts[key.split(':')[1]].yawLimit?.[0] ?? 0), 0, 1, 0, 0]) };
    const eye = vehicleWorldToLocal(row, seatEyeWorld(row, seat.id));
    const def = vehicleDef(type), hip = vehicleDef(type).seats.find(entry => entry.id === seat.id).position;
    check(() => assert.ok(Math.abs(eye[0]) <= def.collider.halfWidth && Math.abs(eye[2]) <= def.collider.halfLength,
      `${type} ${seat.id}: the eye is over the hull (${eye.map(v => v.toFixed(2))})`));
    // The sealed tank driver looks out of the turret hatch (the gunner's eye) instead.
    const reach = type === 'tank' && seat.id === 'driver' ? 2.6 : 1.5;
    check(() => assert.ok(eye[1] > hip[1] + 0.4 && eye[1] < hip[1] + reach, `${type} ${seat.id}: the eye is above the seat (${eye[1].toFixed(2)} vs hip ${hip[1]})`));
    view.begin();
    view.setView(type, seat.id, 'cockpit', { remember: false });
    view.update(1 / 60, { row, seatId: seat.id, aimYaw: 0.7, aimPitch: 0 });
    check(() => assert.ok(camera.position.distanceTo(new THREE.Vector3(...seatEyeWorld(row, seat.id))) < 1e-9, `${type} ${seat.id}: camera at the eye`));
  }
  // Tank hatch: the eye rides the turret and looks along the gun aim, so the shell marker stays in front.
  const turned = tankRow({ yaw: 0, turretYaw: 1.2, turretPitch: 0.05 });
  view.begin();
  view.setView('tank', 'driver', 'cockpit');
  view.update(1 / 60, { row: turned, seatId: 'driver', aimYaw: 1.2, aimPitch: 0.05 });
  check(() => assert.ok(forward().dot(new THREE.Vector3(...vehicleDirection(1.2, 0.05))) > 0.99999, 'the hatch looks along the gun'));
  const main = mountPose(turned, 'driver', 'main');
  check(() => assert.ok(camera.position.distanceTo(new THREE.Vector3(...main.pivot)) < 2.2, 'the hatch eye is at the turret'));
  check(() => assert.ok(camera.position.clone().sub(new THREE.Vector3(...main.pivot)).dot(new THREE.Vector3(...main.dir)) < -1,
    'and turns with it: behind the gun, whatever the hull heading'));
  check(() => assert.ok(Math.abs(right().y) < 1e-9, 'no hatch roll on level ground'));
  // RMB still drops into the 3x gunner's sight from the hatch.
  for (let i = 0; i < 20; i++) view.update(1 / 60, { row: turned, seatId: 'driver', aimYaw: 1.2, aimPitch: 0.05, optic: true });
  check(() => assert.ok(Math.abs(camera.fov - 70 / 3) < 0.5));
  // Action: a closer chase than the default one.
  view.begin();
  view.setView('jeep', 'driver', 'chase');
  const jeepRow = { id: 'jp', type: 'jeep', x: 0, y: 10, z: 0, yaw: 0, hp: 320 };
  view.update(1 / 60, { row: jeepRow, seatId: 'driver' });
  const chaseRange = camera.position.distanceTo(view.focus);
  view.setView('jeep', 'driver', 'action');
  view.update(1 / 60, { row: jeepRow, seatId: 'driver' });
  check(() => assert.ok(camera.position.distanceTo(view.focus) < chaseRange * 0.7, 'the action chase sits closer'));
  // Fly-by: a fixed point ahead of the flight path the jet passes, then a new one.
  view.begin();
  view.setView('plane', 'driver', 'flyby');
  let flyRow = { ...jet, roll: 0, vx: 0, vz: -90, yaw: 0, pitch: 0, speed: 90 };
  view.update(1 / 60, { row: flyRow, seatId: 'driver' });
  const spot = camera.position.clone();
  check(() => assert.ok(spot.z < flyRow.z - 30, 'the fly-by point is ahead of the jet'));
  check(() => assert.ok(forward().dot(new THREE.Vector3(flyRow.x, flyRow.y + 1, flyRow.z).sub(camera.position).normalize()) > 0.99, 'it watches the jet'));
  for (let i = 0; i < 60; i++) { flyRow = { ...flyRow, z: flyRow.z - 1.5 }; view.update(1 / 60, { row: flyRow, seatId: 'driver' }); }
  check(() => assert.ok(camera.position.distanceTo(spot) < 1e-9, 'the point holds while the jet closes'));
  for (let i = 0; i < 120; i++) { flyRow = { ...flyRow, z: flyRow.z - 1.5 }; view.update(1 / 60, { row: flyRow, seatId: 'driver' }); }
  check(() => assert.ok(camera.position.distanceTo(spot) > 50 && camera.position.z < flyRow.z, 'after the pass a new point waits ahead again'));
  check(() => assert.ok(Math.sign(camera.position.x - flyRow.x) !== Math.sign(spot.x - flyRow.x), 'on the other side of the path'));
  check(() => assert.ok(camera.fov >= VEHICLE_CAMERA.flyby.minFov && camera.fov <= 80));
  view.end();
}

// Controller: V cycles the seat's views (never a melee while seated), the
// jeep cockpit look rides the hull, and the HUD reads the view state.
{
  const target = keyTarget();
  const camera = new THREE.PerspectiveCamera(70, 16 / 9);
  const controller = new VehicleController({ camera, eventTarget: target, raycast: () => null });
  controller.view.storage = null;
  const self = { id: 'p', state: 'alive', team: 'alpha', x: 0, y: 10, z: 0, hp: 100 };
  const jeep = { id: 'jp', type: 'jeep', team: 'alpha', x: 0, y: 10, z: 0, yaw: 0, hp: 320, seatOccupants: { driver: 'p' } };
  const v = target.fire('keydown', { code: 'KeyV' });
  check(() => assert.equal(v.prevented, false, 'on foot V stays the quick melee'));
  controller.sync({ self, vehicles: [jeep], enabled: true });
  controller.updateCamera(1 / 60);
  check(() => assert.equal(controller.view.view, 'chase'));
  const press = target.fire('keydown', { code: 'KeyV' });
  check(() => assert.equal(press.prevented, true, 'seated, V is the camera view (Input never sees a melee)'));
  check(() => assert.equal(controller.view.view, 'action'));
  target.fire('keydown', { code: 'KeyV', repeat: true });
  check(() => assert.equal(controller.view.view, 'action', 'auto-repeat does not cycle'));
  check(() => assert.equal(controller.cycleView(), 'cockpit'));
  check(() => assert.equal(controller.viewState().label, 'FIRST PERSON'));
  check(() => assert.deepEqual(controller.viewState().views.map(entry => entry.id), ['chase', 'action', 'cockpit']));
  check(() => assert.equal(controller.view.hullLook, true));
  controller.controls({}, { dx: -0.4, dy: 0 }, false);
  check(() => assert.ok(Math.abs(controller.yaw - 0.4) < 1e-9, 'the mouse turns the head'));
  controller.sync({ self, vehicles: [{ ...jeep, yaw: 0.5 }], enabled: true });
  controller.controls({}, { dx: 0, dy: 0 }, false);
  check(() => assert.ok(Math.abs(controller.yaw - 0.9) < 1e-9, 'the look turns with the jeep'));
  for (let i = 0; i < 10; i++) controller.controls({}, { dx: -0.5, dy: 0 }, false);
  check(() => assert.ok(Math.abs(controller.yaw - (0.5 + VEHICLE_CAMERA.driverHeadYaw)) < 1e-9, 'the head turn stops at its limit'));
  controller.sync({ self, vehicles: [], enabled: true });
  check(() => assert.equal(controller.viewState(), null));
  check(() => assert.equal(controller.cycleView(), null, 'no view to cycle on foot'));
  controller.dispose();
  const bindings = defaultKeybindings();
  check(() => assert.deepEqual(bindings.vehicleView, ['KeyV']));
  check(() => assert.deepEqual(bindings.quickMelee, ['KeyV'], 'the same key on foot'));
  check(() => assert.equal(KEYBINDING_ACTIONS.find(action => action.id === 'vehicleView').context, 'vehicle', 'rebindable in the vehicle context'));
  const main = readFileSync(new URL('../public/js/main.js', import.meta.url), 'utf8');
  check(() => assert.ok(/'consumeQuickMelee'/.test(main), 'seated frames drain the quick melee'));
}

// VehicleView first person: the local seat's head, chest and upper arms hide
// (hands stay on the controls), the glass fades, the cockpit dressing shows
// and the jeep windscreen folds away; leaving restores everything.
{
  const view = new VehicleView();
  const jet = { id: 'jet', type: 'plane', team: 'alpha', x: 0, y: 50, z: 0, yaw: 0, pitch: 0, roll: 0, hp: 450, seatOccupants: { driver: 'me' } };
  const jeep = { id: 'jp', type: 'jeep', team: 'alpha', x: 20, y: 10, z: 0, yaw: 0, hp: 320, seatOccupants: { driver: 'me2', 'front-passenger': 'mate' } };
  const me = { id: 'me', team: 'alpha', state: 'alive', hp: 100, vehicleId: 'jet', vehicleSeatId: 'driver' };
  const players = [{ id: 'me2', team: 'alpha', state: 'alive', hp: 100, vehicleId: 'jp', vehicleSeatId: 'driver' },
    { id: 'mate', team: 'alpha', state: 'alive', hp: 100, vehicleId: 'jp', vehicleSeatId: 'front-passenger' }];
  view.sync([jet, jeep], players, me);
  view.update(1 / 60);
  const pilot = view.item('jet').crew.get('driver');
  check(() => assert.equal(pilot.avatar.head.visible, true, 'third person shows the whole pilot'));
  view.setLocalView({ id: 'jet', seatId: 'driver' });
  view.update(1 / 60);
  check(() => assert.equal(pilot.avatar.head.visible, false, 'first person hides the own head'));
  check(() => assert.equal(pilot.avatar.torso.visible, false, 'and the chest'));
  check(() => assert.equal(pilot.avatar.lElbow.visible && pilot.avatar.rHand.visible, true, 'hands stay on the stick and throttle'));
  check(() => assert.equal(view.item('jet').materials.glass.opacity, VEHICLE_VIEW.insideGlassOpacity, 'the canopy fades from inside'));
  const cockpit = view.item('jet').cockpit;
  check(() => assert.ok(cockpit?.group.visible && cockpit.group.children.length >= 2, 'the jet cockpit dressing shows'));
  check(() => assert.equal(view.item('jp').cockpit, undefined, 'only the local hull builds one'));
  view.setLocalView({ id: 'jp', seatId: 'front-passenger' });
  view.update(1 / 60);
  check(() => assert.equal(pilot.avatar.head.visible, true, 'leaving first person restores the head'));
  check(() => assert.equal(view.item('jet').materials.glass.opacity, 0.42));
  check(() => assert.equal(cockpit.group.visible, false));
  check(() => assert.equal(view.item('jp').model.windscreen.visible, false, 'the jeep windscreen folds away in first person'));
  check(() => assert.equal(view.item('jp').crew.get('driver').avatar.head.visible, true, 'other seats keep their heads'));
  check(() => assert.equal(view.item('jp').crew.get('front-passenger').avatar.head.visible, false));
  view.setLocalView(null);
  view.update(1 / 60);
  check(() => assert.equal(view.item('jp').model.windscreen.visible, true));
  view.dispose();
}

// --- CameraShake ---------------------------------------------------------------------------
{
  const shake = new CameraShake();
  const camera = new THREE.PerspectiveCamera();
  check(() => assert.equal(shake.add(0.4), 0.4));
  check(() => assert.equal(shake.add(5), 1, 'trauma saturates'));
  shake.reset();
  check(() => assert.equal(shake.addExplosion([0, 0, 1000], 4, camera), 0, 'far blasts do not shake'));
  check(() => assert.ok(shake.addExplosion([0, 0, 3], 5, camera) > 0.4, 'a close blast shakes hard'));
  const out = shake.apply(camera, 1 / 60);
  check(() => assert.ok(Math.abs(out.yaw) <= CAMERA_SHAKE.maxYaw && Math.abs(out.roll) <= CAMERA_SHAKE.maxRoll));
  check(() => assert.ok(camera.quaternion.angleTo(new THREE.Quaternion()) > 0, 'apply layers on the posed camera'));
  for (let i = 0; i < 120; i++) shake.sample(1 / 60);
  check(() => assert.equal(shake.trauma, 0, 'trauma decays'));
  const calm = new CameraShake({ reducedMotion: true }), wild = new CameraShake();
  calm.add(1); wild.add(1);
  let calmMax = 0, wildMax = 0;
  for (let i = 0; i < 30; i++) { calmMax = Math.max(calmMax, Math.abs(calm.sample(1 / 60).roll)); wildMax = Math.max(wildMax, Math.abs(wild.sample(1 / 60).roll)); }
  check(() => assert.ok(calmMax <= wildMax * CAMERA_SHAKE.reducedScale + 1e-9, 'reduced motion caps the shake'));
  check(() => assert.equal(calm.sample(0).x, 0, 'reduced motion never translates the camera'));
  calm.setReducedMotion(false);
  check(() => assert.equal(calm.reducedMotion, false));
  // The vehicle camera applies the bus after posing.
  const posed = new THREE.PerspectiveCamera(70, 1);
  const bus = new CameraShake();
  const cam = new VehicleCamera({ camera: posed, shake: bus });
  cam.update(1 / 60, { row: tankRow(), seatId: 'driver', aimYaw: 0, aimPitch: 0 });
  const calmRotation = posed.rotation.clone();
  bus.add(1);
  cam.update(1 / 60, { row: tankRow(), seatId: 'driver', aimYaw: 0, aimPitch: 0 });
  check(() => assert.ok(Math.abs(posed.rotation.z - calmRotation.z) > 0 || Math.abs(posed.rotation.y - calmRotation.y) > 0, 'shake applied to the vehicle camera'));
}

// --- Composition root: authoritative seat timing and the first infantry packet ---------------------
{
  const source = readFileSync(new URL('../public/js/main.js', import.meta.url), 'utf8');
  const start = source.indexOf('class Game {'), end = source.indexOf('\nconst debugParams =', start);
  let now = 5000;
  const Game = new Function('WEAPON_IDS', 'copySmokeFields', 'nowMs', 'bastionRepairAvailable',
    `return (${source.slice(start, end)});`)(WEAPON_IDS, copySmokeFields, () => now, () => false);
  const input = new Input({}); input.fallback = true; input._locked = true;
  const player = new LocalPlayer({ input, physics: { pos: { x: 10, y: 0, z: 10 }, vel: { x: 0, y: 0, z: 0 }, grounded: true,
    step: () => false, eyeY: () => 1.62, setMapMeta() {} } });
  player.setGameplayInputEnabled(true);
  const weapon = new WeaponState({
    rig: { setWeapon() {}, fire: () => true, reload() {}, cancelReload() {}, pumpAnim() {}, boltAnim() {}, ads() {} },
    audio: { draw() {}, reloadClick() {}, fire() {} }, effects: { shoot() {} },
    network: { isRunning: () => true, isCurrentGeneration: () => true },
    feedback: { addExhaustion() {}, addRecoil() {} }, now: () => now, setTimer: () => 0, clearTimer() {},
  });
  weapon.resetToLoadout();
  const self = { id: 'p', state: 'alive', team: 'alpha', x: 11, y: 0, z: 10 };
  const controller = new VehicleController({ camera: new THREE.PerspectiveCamera(), eventTarget: null });
  const wires = [], game = Object.create(Game.prototype);
  const match = { mode: 'conquest', phase: 'live' }, standing = { ...self, hp: 100, vehicleId: null, vehicleSeatId: null };
  Object.assign(game, {
    player, weapon, input, vehicleController: controller, camera: new THREE.PerspectiveCamera(), selfRow: standing, matchState: match,
    _touchContext: {}, _inputVehicleSeatKey: '', _lastConsumedSnapSeq: null,
    weaponWheel: { open: false, sync() {} }, grenadePouch: { open: false, sync() {} },
    session: { myId: self.id, gameplayInputEnabled: true, canOpenBuyMenu: () => false,
      confirmPurchase: () => null, syncBuyMenuState() {}, syncGameplayInput() {}, restoreGameplayFocus() {},
      net: { sendInput: packet => { wires.push(packet); return true; } } },
    hud: { setMatchState() {}, setScoreboard() {} },
    running: true, _loopGeneration: 1, frameRate: { begin() {} }, clock: { getDelta: () => 1 / 60 },
  });
  let sequence = 0;
  const tank = tankRow({ x: 10, y: 0, z: 10, occupantId: self.id, seatOccupants: { driver: self.id, commander: null } });
  const snapshot = (vehicle = tank, seatId = 'driver') => game.consumeAuthoritativeSnapshot({
    snapSeq: ++sequence, match, players: [{ ...standing, vehicleId: seatId ? vehicle.id : null, vehicleSeatId: seatId }],
    vehicles: [seatId ? vehicle : { ...vehicle, occupantId: null, seatOccupants: { driver: null, commander: null } }], events: [],
  });
  const stopAfterPlayer = new Error('player frame complete');
  weapon.settleFrame = () => { throw stopAfterPlayer; };
  const savedRaf = globalThis.requestAnimationFrame;
  const savedDocument = globalThis.document;
  globalThis.requestAnimationFrame = () => 0;
  globalThis.document = { hidden: false };
  const frame = () => { now += 20; assert.throws(() => game.loop(1, now), error => error === stopAfterPlayer); };
  try {
    input._onMouseDown({ button: 0 });
    player.fireTapLatched = true; player.pendingShotIntent = { tap: true, held: true };
    player.grenadeThrowLatched = { charge: 1, type: 0 };
    snapshot();
    check(() => assert.equal(input.wantFireHeld, false, 'entry clears held infantry fire'));
    check(() => assert.equal(player.grenadeThrowLatched, null, 'entry discards an unsent grenade'));
    input._onMouseDown({ button: 0 });
    snapshot();
    check(() => assert.equal(input.wantFireHeld, true, 'unchanged seats preserve newly held fire'));
    snapshot(tank, null);
    check(() => assert.equal(input.wantFireHeld, false, 'exit acknowledgement clears mounted fire'));
    const mag = weapon.ammoOf('rifle').mag;
    frame();
    check(() => assert.equal(wires.at(-1).wantFire, false));
    check(() => assert.equal(wires.at(-1).vehicleControlId, undefined));
    check(() => assert.equal(weapon.ammoOf('rifle').mag, mag, 'the first infantry frame consumes no ammunition'));
    input._onMouseDown({ button: 0 }); frame();
    check(() => assert.equal(wires.at(-1).wantFire, true));
    input._onMouseUp({ button: 0 });
  } finally {
    if (savedRaf === undefined) delete globalThis.requestAnimationFrame; else globalThis.requestAnimationFrame = savedRaf;
    controller.dispose(); player.dispose(); weapon.dispose(); input.dispose();
    if (savedDocument === undefined) delete globalThis.document; else globalThis.document = savedDocument;
  }
}

console.log(`Conquest vehicle client: ${checks} checks passed (view, controller, per-seat cameras, shake, seat handoff).`);
