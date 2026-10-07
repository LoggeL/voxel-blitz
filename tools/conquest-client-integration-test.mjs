import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { NetClient, vehicleActionFrame } from '../public/js/engine/netclient.js';
import { parseConquestIntent, parseVehicleAction } from '../server/protocol/admission.js';
import { LobbyManager } from '../server/lobby.js';
import { CONQUEST_EVENT_KINDS, REMOVED_EVENT_KINDS, VEHICLE_ACTION_TYPES } from '../shared/conquest-contract.js';

const source = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

// --- Input frames: vehicle controls and the vehicleAction whitelist (spec 3.4).
const net = new NetClient();
const sent = [];
net.ws = { readyState: 1, send: frame => sent.push(JSON.parse(frame)) };
net.sendInput({ keys: {}, yaw: 0.3, pitch: 0.1, vehicleThrottle: 2, vehicleSteer: -2, vehicleBrake: 2,
  vehicleAction: { type: 'enter', vehicleId: 'tank-1', injected: true }, wantFire: true });
assert.equal(sent[0].vehicleThrottle, 1);
assert.equal(sent[0].vehicleSteer, -1); assert.equal(sent[0].vehicleBrake, 1);
assert.deepEqual(sent[0].vehicleAction, { type: 'enter', vehicleId: 'tank-1' });
net.sendInput({ keys: {}, vehicleThrottle: NaN, vehicleBrake: NaN, vehicleAction: { type: 'teleport', vehicleId: 'tank-1' } });
assert(!('vehicleBrake' in sent[1])); assert(!('vehicleAction' in sent[1])); assert(!('vehicleThrottle' in sent[1]));
net.sendInput({ keys: {}, vehicleAction: { type: 'exit', vehicleId: 'ignored' } });
assert.deepEqual(sent[2].vehicleAction, { type: 'exit' });
net.sendInput({ keys: {}, vehicleAction: { type: 'seat', seatId: 'commander', extra: 1 } });
assert.deepEqual(sent[3].vehicleAction, { type: 'seat', seatId: 'commander' }, 'seat switch keeps only seatId');
net.sendInput({ keys: {}, vehicleAction: { type: 'cm', kind: 'flares' } });
assert.deepEqual(sent[4].vehicleAction, { type: 'cm' }, 'countermeasure frame carries no payload');
net.sendInput({ keys: {}, vehicleAction: { type: 'weapon', index: 1 } });
assert.deepEqual(sent[5].vehicleAction, { type: 'weapon', index: 1 });

// Every whitelisted frame is exactly what the server parser accepts; everything else is never sent.
const samples = [
  { type: 'exit' }, { type: 'cm' },
  { type: 'enter', vehicleId: 'alpha-tank' }, { type: 'enter', vehicleId: 'alpha-tank', seatId: 'commander' },
  { type: 'enter', vehicleId: 'v'.repeat(64), seatId: 's'.repeat(32) },
  { type: 'enter', vehicleId: 'v'.repeat(65) }, { type: 'enter', vehicleId: '' },
  { type: 'enter', vehicleId: 'alpha-jeep', seatId: 's'.repeat(33) },
  { type: 'seat', seatId: 'gunner' }, { type: 'seat', seatId: '' }, { type: 'seat', seatId: 's'.repeat(33) }, { type: 'seat' },
  { type: 'weapon', index: 0 }, { type: 'weapon', index: 3 }, { type: 'weapon', index: 4 }, { type: 'weapon', index: -1 },
  { type: 'weapon', index: 1.5 }, { type: 'weapon' }, { type: 'repair' }, null, 'exit',
];
for (const sample of samples) {
  const frame = vehicleActionFrame(sample);
  if (frame) {
    assert(VEHICLE_ACTION_TYPES.includes(frame.type), `${frame.type} is a contract action type`);
    assert.deepEqual(parseVehicleAction(frame), frame, `server accepts the client frame ${JSON.stringify(frame)}`);
  } else if (sample && typeof sample === 'object' && sample.type !== 'enter') {
    assert.equal(parseVehicleAction(sample), null, `client drops what the server refuses: ${JSON.stringify(sample)}`);
  }
}
// An over-long seat on enter is dropped, the enter itself survives (first free seat).
assert.deepEqual(vehicleActionFrame({ type: 'enter', vehicleId: 'alpha-jeep', seatId: 's'.repeat(33) }),
  { type: 'enter', vehicleId: 'alpha-jeep' });
assert.equal(vehicleActionFrame({ type: 'enter', vehicleId: 'v'.repeat(65) }), null);
for (const type of VEHICLE_ACTION_TYPES) {
  const probe = { exit: { type }, cm: { type }, enter: { type, vehicleId: 'x' }, seat: { type, seatId: 'driver' }, weapon: { type, index: 0 } }[type];
  assert(probe && vehicleActionFrame(probe), `client whitelists contract action ${type}`);
}

// --- Conquest intents: one field per frame, per-type rate limits (deploy 4/s, spot 2/s, support 10/s).
const intents = new NetClient();
const intentFrames = [];
intents.ws = { readyState: 1, send: frame => intentFrames.push(JSON.parse(frame)) };
const deploy = { spawn: 'flag:A', kit: 'engineer', variant: 1 };
assert.equal(intents.sendConquest({ deploy }), true);
assert.deepEqual(intentFrames[0], { t: 'conquest', deploy });
assert.deepEqual(parseConquestIntent(intentFrames[0]), { type: 'deploy', spawn: 'flag:A', kit: 'engineer', variant: 1, gadget: 0 });
assert.equal(intents.sendConquest({ deploy: { spawn: 'hq' } }), false, 'a second deploy within 250 ms is held back');
assert.equal(intents.sendConquest({ spot: 1 }), true, 'rate limits are per intent type');
assert.deepEqual(parseConquestIntent(intentFrames[1]), { type: 'spot' });
assert.equal(intents.sendConquest({ spot: 1 }), false, 'spot is limited to 2/s');
assert.equal(intents.sendConquest({ support: { type: 'revive', targetId: 'p7' } }), true);
assert.deepEqual(parseConquestIntent(intentFrames[2]), { type: 'support', support: 'revive', targetId: 'p7' });
assert.equal(intents.sendConquest({}), false); assert.equal(intents.sendConquest(null), false);
assert.equal(intents.sendConquest({ teleport: 1 }), false);
assert.equal(intentFrames.length, 3, 'refused intents never reach the socket');
assert(intentFrames.every(frame => Object.keys(frame).length === 2), 'every frame carries exactly one intent');
const closed = new NetClient();
assert.equal(closed.sendConquest({ spot: 1 }), false, 'a closed socket sends nothing');
assert.equal(closed.sendConquest({ spot: 1 }), false);
closed.ws = { readyState: 1, send: () => {} };
assert.equal(closed.sendConquest({ spot: 1 }), true, 'a frame the socket refused does not use up the rate limit');

// --- Server routing: {t:'conquest'} -> LobbyManager.conquest -> engine.conquestIntent, rate limited.
const calls = [];
const member = { id: 'p1' };
const room = { phase: 'live', engine: { conquestIntent: (id, intent) => { calls.push([id, intent]); return true; } } };
const lobby = { _memberFor: () => ({ room, member }) };
const route = intent => LobbyManager.prototype.conquest.call(lobby, {}, intent);
assert.equal(route({ type: 'spot' }), true);
assert.equal(route({ type: 'spot' }), false, 'the lobby rate-limits spot to 2/s');
assert.equal(route({ type: 'deploy', spawn: 'hq', kit: 'assault', variant: 0 }), true);
assert.equal(route(null), false, 'unparsable frames stop at the lobby');
// Gaps are measured on arrival: jitter that bunches two correctly paced deploys
// (client gap 250 ms) to 200 ms apart must still pass; a real burst does not.
member.conquestIntentAt.deploy = performance.now() - 200;
assert.equal(route({ type: 'deploy', spawn: 'hq', kit: 'recon', variant: 0 }), true, 'the lobby tolerates jitter below the client gap');
assert.equal(route({ type: 'deploy', spawn: 'hq', kit: 'assault', variant: 0 }), false, 'a burst is still rate limited');
room.phase = 'waiting';
assert.equal(route({ type: 'support', support: 'repair', targetId: 'alpha-tank' }), false, 'only live rooms take intents');
room.phase = 'live';
room.engine.conquestIntent = () => { throw new Error('policy failure'); };
assert.equal(route({ type: 'support', support: 'repair', targetId: 'alpha-tank' }), false, 'a throwing policy never kills the socket handler');
assert.deepEqual(calls.map(([id, intent]) => [id, intent.type]), [['p1', 'spot'], ['p1', 'deploy'], ['p1', 'deploy']]);
const index = await source('server/index.js');
assert(/msg\.t === 'conquest'\)\s*{\s*manager\.conquest\(meta, parseConquestIntent\(msg\)\)/.test(index), 'server/index.js routes conquest frames');
assert(/conquestIntent\(id, intent\)/.test(await source('server/game.js')), 'GameEngine.conquestIntent passthrough exists');

// --- Snapshots keep vehicle rows immutable and in order.
net.id = 'me';
net._onTick({ now: 1000, players: [{ id: 'me', state: 'alive', vehicleId: 'tank-1' }],
  vehicles: [{ id: 'tank-1', type: 'tank', x: 2, y: 0, z: 3, yaw: 0, hp: 400 }], match: { mode: 'conquest' } });
const snapshot = net.latestSnapshots.at(-1);
assert.equal(snapshot.vehicles[0].id, 'tank-1');
assert.equal(snapshot.players[0].vehicleId, 'tank-1');
assert(Object.isFrozen(snapshot.vehicles[0]));

// --- Event kinds: every Conquest kind reaches onGameplayEvent and has a client consumer; flag_capture is gone.
const session = await source('public/js/session/session.js');
assert(session.includes('...CONQUEST_EVENT_KINDS'), 'session forwards every CONQUEST_EVENT_KINDS entry');
assert(session.includes("import { CONQUEST_EVENT_KINDS } from '../../../shared/conquest-contract.js'"));
const consumers = await Promise.all(['public/js/ui/conquest-hud.js', 'public/js/ui/conquest-hud-state.js',
  'public/js/vehicles/vehicle-fx.js', 'public/js/audio/objective-cues.js'].map(source));
for (const kind of CONQUEST_EVENT_KINDS) {
  assert(consumers.some(text => text.includes(`'${kind}'`)), `${kind} has a client consumer`);
}
for (const kind of REMOVED_EVENT_KINDS) {
  assert(!session.includes(`'${kind}'`), `${kind} is not forwarded`);
  for (const text of consumers) assert(!new RegExp(`'${kind}'`).test(text), `${kind} has no consumer left`);
}

// --- main.js wiring (spec 3.6 / WP9 checklist).
const main = await source('public/js/main.js');
for (const owner of ['vehicleController', 'vehicleView', 'conquestHud', 'vehicleFx', 'particleField', 'conquestAmbience',
  'objectiveCues', 'vehicleDestructionFX', 'vehicleAudio']) {
  assert(main.includes(`this.${owner}?.dispose()`), `${owner} is released between matches`);
}
assert(main.indexOf('this.conquestAmbience?.dispose()') < main.indexOf('this.worldview?.dispose()'), 'ambience is disposed before the world');
assert(main.indexOf('this.worldview.setViewPosition(welcome.spawn)') < main.indexOf('await this.worldview.ready('));
assert(main.includes('this.vehicleController?.sync({ self, vehicles: snapshot.vehicles'));
assert(/}\s*else\s*{\s*this\._vehicleControlSample = null;\s*this\.player\.update\(dt, now,/.test(main), 'seating bypasses infantry prediction and clears flight input samples on exit');
assert(!main.includes('vehicle-armor.png') && !main.includes('loadPaintTexture'), 'the deleted paint texture is not loaded');
assert(main.includes('this.worldview.addCharacterRoots(this.vehicleView.lightingRoot())'), 'hulls get voxel lighting');
assert(main.includes('new rt.VehicleView({ getBlock })'), 'hulls fit their ground attitude from the voxels');
for (const callback of ['onDeploy: (choice) => this.net?.sendConquest({ deploy: choice })', 'onSpot: () => this.net?.sendConquest({ spot: 1 })',
  'onSupport: (intent) => this.net?.sendConquest({ support: intent })']) assert(main.includes(callback), `ConquestHud ${callback.split(':')[0]} sends an intent`);
assert(main.includes("this.hud.spectator.setSuppressed(welcome.gameMode === 'conquest')"), 'the deploy screen replaces the spectator overlay');
assert(main.includes('this.hud.spectator?.setSuppressed(false)'), 'other modes get the spectator overlay back');
const events = main.slice(main.indexOf('onGameplayEvent: (event) => {'));
assert(events.indexOf('this.conquestHud?.handleEvent(event, this.myId)') < events.indexOf("event.kind === 'vehicle_destroyed'"),
  'the HUD sees vehicle_destroyed before the destruction FX early return');
assert(events.includes('this.objectiveCues?.handleEvent(event, this.selfRow?.team)'));
assert(events.includes('this.vehicleFx?.handleEvent(event, this.myId)') && events.includes('this.vehicleFx?.correctMissile(event)'));
const killcamFilter = events.slice(events.indexOf('if (this.killcam?.active'), events.indexOf('this.vehicleFx?.handleEvent(event, this.myId)'));
assert(killcamFilter.includes('this.vehicleFx?.correctMissile(event)') && killcamFilter.includes('this.vehicleFx?.endMissile(event.pid)'),
  'missile trails keep their corrections and end at impact while the killcam drops live projectile events');
assert(/this\.conquestHud\?\.update\(\{ match, mapMeta: this\.mapMeta, self, players, vehicles: snapshot\.vehicles, camera: this\.camera,/.test(main));
assert(main.includes('this.objectiveCues?.syncMatch(match, self?.team, self)'));
assert(main.includes('this.conquestHud?.refresh({ camera: this.camera'), 'markers follow the camera every frame');
const loop = main.slice(main.indexOf('  loop(generation'));
assert(loop.indexOf('this.vehicleController.updateCamera(') < loop.indexOf('this.cameraShake?.apply(this.camera, dt)'),
  'the infantry shake applies after the camera pose');
assert(loop.indexOf('this.cameraShake?.apply(this.camera, dt)') < loop.indexOf('this.conquestHud?.refresh('));
assert(main.includes('this.session.gameplayInputEnabled && this.vehicleController.canFire'), 'touch fire follows the seat weapons');
assert(!/\['tank', 'helicopter', 'plane'\]\.includes\(ctx\.vehicleType\)/.test(main), 'no hard-coded firing hull list');
assert(main.includes("['helicopter', 'transport', 'plane'].includes(row.type)"), 'the transport uses airborne fog');
assert(main.includes('...this.conquestHud.touchContextFields()') || main.includes('this.conquestHud.touchContextFields()'));
assert(main.includes('rt.VEHICLE_WARMUP_MATERIALS') && main.includes('rt.WORLD_WARMUP_MATERIALS'), 'warm-up lists the Conquest programs');
assert(main.indexOf('this.worldview.syncFarFog()') < main.indexOf("showStatus('warming up shaders…'"), 'far fog syncs before warm-up');
assert(main.indexOf('this.vehicleFx = new rt.VehicleFx(') < main.indexOf('rt.warmShaders('), 'VehicleFx programs exist before warm-up');
console.log('Conquest client integration checks passed');
