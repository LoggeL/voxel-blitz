// Conquest vehicle audio: VehicleAudio's snapshot-driven loops and crew cues
// (any seat keeps the engine running, transport rotor, burning, hatches,
// alarm, lock tones, reload clunks), and the sfx vehicle voices on a muted
// recording AudioContext (cannon near/far layers and 400 m cull, gun loops
// with heat, missiles, countermeasures, hull clangs, cue loops, destruction,
// the 24-voice positional budget with priorities and the far range).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { VehicleAudio, VEHICLE_AUDIO } from '../public/js/vehicles/vehicle-audio.js';
import { VoicePool, MAX_POSITIONAL_VOICES, VOICE_RANGES } from '../public/js/audio/voices.js';
import { VEHICLE_STATUS } from '../shared/conquest-contract.js';
import { installGlobals } from './lib/install-globals.mjs';

let checks = 0;
const check = (fn) => { fn(); checks++; };

// --- VehicleAudio with a recording facade --------------------------------------------------
function recordingSfx() {
  const calls = [];
  return new Proxy({ calls }, { get: (target, name) => name in target ? target[name] : (...args) => { calls.push([name, ...args]); } });
}
const named = (sfx, name) => sfx.calls.filter(call => call[0] === name);
const row = (id, overrides = {}) => ({ id, type: 'jeep', x: 0, y: 0, z: 0, hp: 320, speed: 0, seatOccupants: {}, ...overrides });
{
  const sfx = recordingSfx();
  const audio = new VehicleAudio(sfx);
  audio.update([row('parked'), row('passengers', { seatOccupants: { 'rear-left': 'p', 'front-passenger': 'q' } }),
    row('moving', { speed: -5 }), row('far', { x: 91, speed: 5 }), row('dead', { hp: 0, seatOccupants: { driver: 'p' }, wreckAge: 30 }),
    row('pivot', { type: 'tank', hp: 1000, leftTrackSpeed: -2, rightTrackSpeed: 2 })], [0, 0, 0]);
  const loops = named(sfx, 'vehicleLoop');
  check(() => assert.deepEqual(loops.map(call => call[1]).sort(), ['conquest:moving', 'conquest:passengers', 'conquest:pivot']));
  check(() => assert.equal(loops.find(call => call[1] === 'conquest:passengers')[4].occupied, true, 'a jeep with only passengers keeps its engine loop'));
  check(() => assert.equal(loops.find(call => call[1] === 'conquest:moving')[4].speed, 5));
  check(() => assert.equal(loops.find(call => call[1] === 'conquest:pivot')[4].trackSpeed, 2));
  // The transport is a rotorcraft: its loop runs on rotor speed with its own kind.
  sfx.calls.length = 0;
  audio.update([row('lift', { type: 'transport', hp: 600, rotorSpeed: 0.6, y: 20, seatOccupants: { 'door-left': 'g' } })], [0, 0, 0]);
  const lift = named(sfx, 'vehicleLoop')[0];
  check(() => assert.equal(lift[3], 'transport'));
  check(() => assert.equal(lift[4].rotorSpeed, 0.6));
  check(() => assert.deepEqual(named(sfx, 'stopVehicleLoop').map(call => call[1]).sort(), ['conquest:moving', 'conquest:passengers', 'conquest:pivot']));
  // Four nearest loops at most.
  sfx.calls.length = 0;
  audio.update(Array.from({ length: 8 }, (_, i) => row(i, { x: 8 - i, speed: 1 })), { x: 0, y: 0, z: 0 });
  check(() => assert.deepEqual(named(sfx, 'vehicleLoop').map(call => call[1]), ['conquest:7', 'conquest:6', 'conquest:5', 'conquest:4']));
  check(() => assert.equal(VEHICLE_AUDIO.maxEngineLoops, 4));
  audio.dispose();
  const stops = named(sfx, 'stopVehicleLoop').length;
  audio.dispose();
  check(() => assert.equal(named(sfx, 'stopVehicleLoop').length, stops, 'dispose is idempotent'));
}
{
  // Burning hulls and fresh wrecks crackle (nearest two); old wrecks are silent.
  const sfx = recordingSfx(), audio = new VehicleAudio(sfx);
  audio.update([row('burning', { type: 'tank', hp: 200, st: VEHICLE_STATUS.burning | VEHICLE_STATUS.disabled }),
    row('fresh', { hp: 0, wreckAge: 3, x: 5 }), row('old', { hp: 0, wreckAge: 40, x: 2 }), row('far', { hp: 0, wreckAge: 1, x: 200 })], [0, 0, 0]);
  check(() => assert.deepEqual(named(sfx, 'vehicleBurning').map(call => call[1]).sort(), ['burn:burning', 'burn:fresh']));
  audio.update([row('burning', { type: 'tank', hp: 800 })], [0, 0, 0]);
  check(() => assert.deepEqual(named(sfx, 'stopVehicleBurning').map(call => call[1]).sort(), ['burn:burning', 'burn:fresh']));
  audio.dispose();
}
{
  // Hatches: boarding and leaving a nearby hull; the local boarder hears it in the head.
  const sfx = recordingSfx(), audio = new VehicleAudio(sfx);
  const self = { id: 'me', team: 'alpha' };
  audio.update([row('j')], [0, 0, 0], { self });
  audio.update([row('j', { seatOccupants: { driver: 'me' } })], [0, 0, 0], { self });
  check(() => assert.deepEqual(named(sfx, 'vehicleHatch').at(-1)[2], { enter: true, self: true }));
  audio.update([row('j')], [0, 0, 0], { self });
  check(() => assert.deepEqual(named(sfx, 'vehicleHatch').at(-1)[2], { enter: false, self: false }));
  const count = named(sfx, 'vehicleHatch').length;
  audio.update([row('j', { x: 100, seatOccupants: { driver: 'x' } })], [0, 0, 0], { self });
  check(() => assert.equal(named(sfx, 'vehicleHatch').length, count, 'distant hatches are silent'));
  audio.dispose();
}
{
  // Crew cues: alarm below 30 %, lock tones from lk and the own seeker, reload clunks.
  const sfx = recordingSfx(), audio = new VehicleAudio(sfx);
  const self = { id: 'me', team: 'alpha', cq: [1, 1, 0, 0, 0, 0, 0] };
  const tank = (extra = {}) => row('t', { type: 'tank', hp: 1000, seatOccupants: { driver: 'me' }, mounts: [[0, 0, 1, 0, 0], [0, 0, 1, 0, 0], [0, 0, 1, 0, 0]], ...extra });
  audio.update([tank({ hp: 250 })], [0, 0, 0], { self });
  check(() => assert.equal(named(sfx, 'vehicleAlarm').at(-1)[1], true, 'alarm below 30 %'));
  audio.update([tank({ hp: 400 })], [0, 0, 0], { self });
  check(() => assert.equal(named(sfx, 'vehicleAlarm').at(-1)[1], false));
  for (const [lk, mode] of [[1, 'locking'], [2, 'locked'], [3, 'inbound'], [0, null]]) {
    audio.update([tank({ lk })], [0, 0, 0], { self });
    check(() => assert.equal(named(sfx, 'vehicleLockTone').at(-1)[1], mode, `lk ${lk}`));
  }
  audio.update([tank({ mounts: [[0, 0, 1, 0, 80], [0, 0, 1, 0, 80], [0, 0, 1, 0, 0]] })], [0, 0, 0], { self });
  audio.update([tank({ mounts: [[0, 0, 1, 0, 30], [0, 0, 1, 0, 30], [0, 0, 1, 0, 0]] })], [0, 0, 0], { self });
  check(() => assert.equal(named(sfx, 'vehicleReload').length, 0));
  audio.update([tank()], [0, 0, 0], { self });
  check(() => assert.equal(named(sfx, 'vehicleReload').length, 2, 'main and coax both report their reload'));
  check(() => assert.deepEqual(named(sfx, 'vehicleReload')[0][2], { self: true, heavy: true }, 'main gun breech is heavy'));
  // On foot, the own seeker beeps (Engineer rocket lock via cq[5]).
  audio.update([], [0, 0, 0], { self: { ...self, cq: [1, 1, 0, 0, 0, 40, 0] } });
  check(() => assert.equal(named(sfx, 'vehicleLockTone').at(-1)[1], 'acquire'));
  audio.update([], [0, 0, 0], { self: { ...self, cq: [1, 1, 0, 0, 0, 100, 0] } });
  check(() => assert.equal(named(sfx, 'vehicleLockTone').at(-1)[1], 'lock'));
  audio.update([], [0, 0, 0], { self });
  check(() => assert.equal(named(sfx, 'vehicleLockTone').at(-1)[1], null));
  audio.dispose();
  check(() => assert.equal(named(sfx, 'vehicleAlarm').at(-1)[1], false));
}

// --- Voice pool: 24 positional voices, priority 0..3, far range ---------------------------------
{
  class Node {
    constructor(kind) { this.kind = kind; this.gain = { value: 1 }; this.frequency = { value: 0 }; this.Q = { value: 0 };
      this.positionX = this.positionY = this.positionZ = { setValueAtTime() {} }; this.connections = []; }
    connect(target) { this.connections.push(target); return target; }
    disconnect() { this.disconnected = true; }
  }
  const ctx = { currentTime: 0, state: 'running', createGain: () => new Node('gain'), createPanner: () => new Node('panner'),
    createBiquadFilter: () => new Node('filter') };
  const pool = new VoicePool({ ctx, bus: {}, _registerVoicePool() {} });
  check(() => assert.equal(MAX_POSITIONAL_VOICES, 24));
  const anchors = Array.from({ length: 24 }, () => pool.acquire({ pos: [0, 0, 0], priority: 3 }, 2));
  const weapon = pool.acquire({ pos: [0, 0, 0], priority: 2 }, 1);
  check(() => assert.equal(weapon.disconnected, true, 'a full anchor pool rejects a lower-priority shot'));
  check(() => assert.ok(anchors.every(voice => !voice.disconnected)));
  pool.disposeAll();
  const far = pool.acquire({ pos: [0, 0, 0], priority: 3, range: 'far', lowpass: 320 }, 2);
  const entry = pool._byOutput.get(far);
  check(() => assert.equal(entry.panner.maxDistance, VOICE_RANGES.far.maxDistance));
  check(() => assert.equal(entry.panner.maxDistance, 400, 'heavy sources roll off to 400 m'));
  check(() => assert.equal(entry.lowpass.frequency.value, 320, 'far layer is low-passed'));
  const near = pool._byOutput.get(pool.acquire({ pos: [0, 0, 0] }, 1));
  check(() => assert.equal(near.panner.maxDistance, 170));
  check(() => assert.equal(near.panner.rolloffFactor, 1.05));
  check(() => assert.equal(pool._byOutput.get(pool.acquire({ pos: [0, 0, 0], priority: 9 }, 1)).priority, 3, 'priority clamps to 3'));
  pool.disposeAll();
}

// --- sfx vehicle voices on a muted recording context ---------------------------------------------
class Param {
  constructor(value = 0) { this.value = value; this.events = []; }
  setValueAtTime(value, at) { this.events.push(['set', value, at]); }
  linearRampToValueAtTime(value, at) { this.events.push(['ramp', value, at]); }
  setTargetAtTime(value, at, tau) { this.events.push(['target', value, at, tau]); }
  exponentialRampToValueAtTime(value, at) { this.events.push(['exponential', value, at]); }
  cancelScheduledValues(at) { this.events = this.events.filter(event => event[2] < at); }
}
class AudioNodeStub {
  constructor(ctx, kind) {
    this.ctx = ctx; this.kind = kind; this.connections = []; this.starts = [];
    for (const key of ['gain', 'frequency', 'Q', 'detune', 'delayTime', 'playbackRate', 'pan',
      'positionX', 'positionY', 'positionZ', 'threshold', 'knee', 'ratio', 'attack', 'release']) {
      this[key] = new Param(key === 'gain' || key === 'playbackRate' ? 1 : 0);
    }
    ctx.nodes.push(this);
  }
  connect(target) { this.connections.push(target); return target; }
  disconnect() { this.disconnected = true; this.connections.length = 0; }
  start(at = 0) { assert.equal(this.starts.length, 0, 'each source is started once'); this.starts.push(at); }
  stop(at) {
    assert.ok(at == null || this.stoppedAt == null || this.ctx.currentTime < this.stoppedAt, 'an expired source cannot be extended');
    this.stoppedAt = at ?? this.ctx.currentTime;
  }
}
class RecordingAudioContext {
  static instances = [];
  constructor() {
    this.nodes = []; this.currentTime = 0; this.state = 'running'; this.sampleRate = 128;
    this.destination = new AudioNodeStub(this, 'destination');
    this.listener = {};
    for (const key of ['positionX', 'positionY', 'positionZ', 'forwardX', 'forwardY', 'forwardZ', 'upX', 'upY', 'upZ']) this.listener[key] = new Param();
    RecordingAudioContext.instances.push(this);
  }
  createGain() { return new AudioNodeStub(this, 'gain'); }
  createOscillator() { return new AudioNodeStub(this, 'oscillator'); }
  createBufferSource() { return new AudioNodeStub(this, 'noise'); }
  createBiquadFilter() { return new AudioNodeStub(this, 'filter'); }
  createPanner() { return new AudioNodeStub(this, 'panner'); }
  createStereoPanner() { return new AudioNodeStub(this, 'stereo'); }
  createWaveShaper() { return new AudioNodeStub(this, 'shaper'); }
  createDynamicsCompressor() { return new AudioNodeStub(this, 'compressor'); }
  createConvolver() { return new AudioNodeStub(this, 'convolver'); }
  createDelay() { return new AudioNodeStub(this, 'delay'); }
  createBuffer(channels, length) { const data = Array.from({ length: channels }, () => new Float32Array(length)); return { getChannelData: index => data[index] }; }
  decodeAudioData() { return Promise.reject(new Error('no samples in tests')); }
  addEventListener() {}
  removeEventListener() {}
  async close() { this.state = 'closed'; }
}
const restore = installGlobals({ window: { AudioContext: RecordingAudioContext } });
const { sfx, VEHICLE_SOUND } = await import('../public/js/audio/sfx.js');
try {
  sfx.setMasterVolume(0);
  sfx.vehicleLoop('warm', [0, 0, 0], 'jeep', { occupied: true });
  const ctx = RecordingAudioContext.instances[0];
  sfx.setListener({ pos: [0, 2, 0], fwd: [0, 0, -1] });
  const fresh = run => { const from = ctx.nodes.length; run(); return ctx.nodes.slice(from); };
  const panners = nodes => nodes.filter(node => node.kind === 'panner');
  const sources = nodes => nodes.filter(node => node.kind === 'noise' || node.kind === 'oscillator');

  // Tank cannon: near crack in range, far thump past 150 m, nothing past 400 m, in-head for the crew.
  let nodes = fresh(() => check(() => assert.deepEqual(sfx.vehicleCannon([0, 2, -60]), { near: true, far: false })));
  check(() => assert.equal(panners(nodes).length, 1));
  check(() => assert.equal(panners(nodes)[0].maxDistance, 400, 'tank fire rolls off to 400 m'));
  nodes = fresh(() => check(() => assert.deepEqual(sfx.vehicleCannon([0, 2, -200]), { near: true, far: true })));
  const filters = nodes.filter(node => node.kind === 'filter' && node.type === 'lowpass' && node.frequency.value === 320);
  check(() => assert.ok(filters.length >= 1, 'far thump through the low-pass layer'));
  nodes = fresh(() => check(() => assert.deepEqual(sfx.vehicleCannon([0, 2, -300]), { near: false, far: true })));
  check(() => assert.equal(panners(nodes).length, 1, 'only the far layer at 300 m'));
  nodes = fresh(() => check(() => assert.deepEqual(sfx.vehicleCannon([0, 2, -450]), { near: false, far: false })));
  check(() => assert.equal(nodes.length, 0, 'culled past 400 m'));
  nodes = fresh(() => sfx.vehicleCannon([0, 2, -450], { self: true }));
  check(() => assert.equal(panners(nodes).length, 0, 'the shooter hears the cannon in the head, at any listener distance'));
  check(() => assert.ok(sources(nodes).length >= 5, 'crack, body, blast and breech clank'));
  // Explosions also carry to 400 m with the far layer.
  nodes = fresh(() => sfx.explosion([0, 2, -250], 'rocket'));
  check(() => assert.ok(panners(nodes).some(node => node.maxDistance === 400)));
  check(() => assert.ok(nodes.some(node => node.kind === 'filter' && node.frequency.value === 320), 'far blast rumble'));
  nodes = fresh(() => sfx.explosion([0, 2, -500], 'rocket'));
  check(() => assert.equal(nodes.length, 0, 'blasts past 400 m are culled'));
  // A tank shell burst ('shell' projectileExplode type) plays the rocket's heavy blast bank.
  const kinds = list => list.map(node => JSON.stringify([node.kind, node.type, node.maxDistance, node.frequency, node.gain]));
  const rocketBlast = kinds(fresh(() => sfx.explosion([0, 2, -250], 'rocket')));
  const shellBlast = kinds(fresh(() => sfx.explosion([0, 2, -250], 'shell')));
  const fragBlast = kinds(fresh(() => sfx.explosion([0, 2, -250], 'frag')));
  check(() => assert.ok(shellBlast.length > 0));
  check(() => assert.deepEqual(shellBlast, rocketBlast, 'shell blast = rocket blast graph'));
  check(() => assert.notDeepEqual(fragBlast, rocketBlast, 'the comparison can tell blast banks apart'));

  // Gun loop: one graph refreshed per round, held briefly, heat adds the sizzle.
  ctx.currentTime = 1;
  nodes = fresh(() => sfx.vehicleGun('j:pintle', [5, 2, 0], 'hmg', { heat: 0 }));
  const loopSources = sources(nodes);
  check(() => assert.ok(loopSources.length >= 4, 'report noise, pulse gate, body and sizzle'));
  const pulse = loopSources.find(node => node.type === 'sawtooth');
  check(() => assert.equal(pulse.frequency.value, 8, 'pulses at the HMG fire rate'));
  ctx.currentTime = 1.05;
  nodes = fresh(() => sfx.vehicleGun('j:pintle', [5, 2, 0], 'hmg', { heat: 0.9 }));
  check(() => assert.equal(sources(nodes).length, 0, 'refresh reuses the loop'));
  for (const source of loopSources) check(() => assert.ok(Math.abs(source.stoppedAt - (1.05 + VEHICLE_SOUND.gunHold + VEHICLE_SOUND.gunFade + 0.05)) < 1e-9, 'held briefly after the last round'));
  ctx.currentTime = 2;
  nodes = fresh(() => sfx.vehicleGun('j:pintle', [5, 2, 0], 'hmg'));
  check(() => assert.ok(sources(nodes).length >= 4, 'an expired loop is rebuilt, never extended'));
  sfx.stopVehicleGun('j:pintle');

  // Missiles, countermeasures, hull hits, hatches, reloads, destruction.
  for (const [name, call] of [
    ['missile launch', () => sfx.vehicleMissileLaunch([0, 2, -20], { kind: 'aa' })],
    ['missile flight', () => sfx.missileFlight('m1', [0, 30, -50])],
    ['flares', () => sfx.vehicleCountermeasure([0, 20, -20], 'flares')],
    ['smoke pop', () => sfx.vehicleCountermeasure([0, 2, -20], 'smoke')],
    ['hull clang', () => sfx.vehicleHullHit([0, 2, -10], { zone: 'front', eff: 1, dmg: 300 })],
    ['ping', () => sfx.vehicleHullHit([0, 2, -10], { zone: 'side', eff: 0 })],
    ['hatch', () => sfx.vehicleHatch([0, 2, -5], { enter: true })],
    ['reload', () => sfx.vehicleReload([0, 2, -5], { self: true, heavy: true })],
    ['burning', () => sfx.vehicleBurning('b', [0, 2, -15], 1)],
    ['destruction', () => sfx.vehicleDestruction([0, 2, -30], 'tank')],
    ['cook-off', () => sfx.vehicleDestruction([0, 2, -30], 'tank', { secondary: true })],
  ]) check(() => assert.ok(sources(fresh(call)).length > 0, `${name} plays`));
  ctx.currentTime = 2.1;
  check(() => assert.equal(sources(fresh(() => sfx.missileFlight('m1', [0, 30, -60]))).length, 0, 'flight loop refreshes in place'));
  sfx.stopMissileFlight('m1'); sfx.stopVehicleBurning('b');
  check(() => assert.deepEqual(sfx.vehicleDestruction([0, 2, -500], 'tank'), { near: false, far: false }));
  check(() => assert.equal(sfx.vehicleHullHit([0, 2, -500], { eff: 1 }), false, 'distant clangs are culled'));

  // Lock tone and alarm: one cue loop each, mode switches rebuild, null silences.
  ctx.currentTime = 3;
  nodes = fresh(() => sfx.vehicleLockTone('locking'));
  check(() => assert.equal(panners(nodes).length, 0, 'cockpit cues are in the head'));
  const locking = sources(nodes);
  check(() => assert.ok(locking.some(node => node.type === 'square' && node.frequency.value === 980)));
  ctx.currentTime = 3.02;
  check(() => assert.equal(sources(fresh(() => sfx.vehicleLockTone('locking'))).length, 0, 'same mode refreshes'));
  nodes = fresh(() => sfx.vehicleLockTone('inbound'));
  check(() => assert.ok(sources(nodes).some(node => node.frequency.value === 1460), 'missile warning'));
  check(() => assert.ok(locking.every(node => node.stoppedAt <= 3.02 + 0.1), 'the old mode stops'));
  sfx.vehicleLockTone(null);
  nodes = fresh(() => sfx.vehicleAlarm(true));
  check(() => assert.ok(sources(nodes).some(node => node.frequency.value === 620), 'damage alarm'));
  sfx.vehicleAlarm(false);
  sfx.stopVehicleCues();

  // Transport rotor loop uses the rotor voice, slower than the attack helicopter.
  ctx.currentTime = 4;
  const heli = sources(fresh(() => sfx.vehicleLoop('heli', [0, 10, -30], 'helicopter', { rotorSpeed: 1 })));
  const lift = sources(fresh(() => sfx.vehicleLoop('lift', [0, 10, -40], 'transport', { rotorSpeed: 1 })));
  const blade = list => list.find(node => node.type === 'triangle').frequency.events.findLast(event => event[0] === 'target')[1];
  check(() => assert.ok(lift.length === heli.length, 'transport uses the rotor graph'));
  check(() => assert.ok(blade(lift) < blade(heli), 'transport rotor chops slower'));
  sfx.stopVehicleLoops();
} finally {
  await sfx.dispose();
  restore();
}

// The legacy loop signature and the shared six-loop budget stay as Bastion expects.
const source = readFileSync(new URL('../public/js/audio/sfx.js', import.meta.url), 'utf8');
check(() => assert.match(source, /vehicleLoop\(id, pos, kind = 'buggy', options = null\)/));
check(() => assert.match(source, /MAX_VEHICLE_LOOPS = 6/));
const loop = source.slice(source.indexOf('  vehicleLoop('), source.indexOf('  stopVehicleLoop('));
check(() => assert.doesNotMatch(loop, /Math\.random|engine\.resume/));

console.log(`Conquest vehicle audio: ${checks} checks passed (snapshot loops and crew cues, 24-voice priority pool, 400 m far layer, weapon, hull and cue voices).`);
