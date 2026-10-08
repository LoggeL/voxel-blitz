// Conquest sound bank: shipped files, provenance and licensing (sources.json,
// LICENSES.md, CC BY credits, docs), the lazy loading contract (never in the
// boot manifest), and the sampled voices on a muted recording AudioContext:
// engine layers driven by speed/rotor/power, near/far/interior cannon, blast
// banks per weapon, gun one-shots, cue loops, budgets, pass-by alignment,
// bank unload; VehicleAudio's derived cues; the soundscape; objective cues.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { CONQUEST_SAMPLE_GROUPS, CONQUEST_SAMPLE_MANIFEST, CONQUEST_SAMPLE_MANIFEST_LITE, CONQUEST_STREAMS, CONQUEST_AUDIO_URLS } from '../public/js/audio/conquest-bank.js';
import { BUILTIN_SAMPLE_MANIFEST, SAMPLE_FILE_SLOTS } from '../public/js/audio/samples.js';
import { VehicleAudio, VEHICLE_AUDIO, closestApproach, polylineDistance } from '../public/js/vehicles/vehicle-audio.js';
import { ConquestSoundscape, SOUNDSCAPE, soundscapeTargets, nearestOnPolyline } from '../public/js/audio/conquest-soundscape.js';
import { createObjectiveCues, OBJECTIVE_SAMPLE_CUES, insideFlagZone, flagZonesFrom } from '../public/js/audio/objective-cues.js';
import { CONQUEST_RULES, FRONTIER_PLAN } from '../shared/conquest-contract.js';
import { MC_STONE, MC_WATER } from '../shared/world/blocks.js';
import { installGlobals } from './lib/install-globals.mjs';

let checks = 0;
const check = (fn) => { fn(); checks++; };
const root = new URL('../public/', import.meta.url);
const file = url => new URL(`.${url}`, root);
const BANKS = ['vehicles', 'explosions', 'atmosphere'];

// --- Files, provenance and licensing ------------------------------------------------------------
const durations = new Map();
const docs = readFileSync(new URL('../docs/audio/conquest-sfx.md', import.meta.url), 'utf8');
const licenses = readFileSync(new URL('assets/audio/LICENSES.md', root), 'utf8');
const credits = readFileSync(new URL('assets/audio/conquest/CREDITS.txt', root), 'utf8');
const ALLOWED = /^(CC0 1\.0|CC BY 3\.0|CC BY 4\.0|Creative Commons Attribution license \(reuse allowed\)|Project original \(no third-party audio\))$/;
let shippedBytes = 0, decodedChannelSeconds = 0;
const ccBy = new Set();
for (const bank of BANKS) {
  const dir = new URL(`assets/audio/conquest/${bank}/`, root);
  const sources = JSON.parse(readFileSync(new URL('sources.json', dir), 'utf8'));
  const listed = new Set(sources.files.map(f => f.file));
  const onDisk = readdirSync(dir).filter(name => name.endsWith('.ogg'));
  check(() => assert.deepEqual(onDisk.sort(), [...listed].sort(), `${bank}: every shipped .ogg has a sources.json entry and vice versa`));
  for (const entry of sources.files) {
    const path = new URL(entry.file, dir);
    const bytes = readFileSync(path);
    shippedBytes += bytes.length;
    durations.set(`/assets/audio/conquest/${bank}/${entry.file}`, entry.durationS);
    check(() => assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.output_sha256, `${bank}/${entry.file} output hash`));
    check(() => assert.equal(bytes.subarray(0, 4).toString('latin1'), 'OggS', `${entry.file} is an Ogg container`));
    check(() => assert.ok(bytes.includes(Buffer.from('OpusHead')), `${entry.file} is Opus (never Vorbis)`));
    check(() => assert.ok(entry.durationS > 0 && Number.isFinite(entry.loudnessLUFS) && Number.isFinite(entry.peakDb), `${entry.file} decoded measurements`));
    if (!(bank === 'atmosphere' && entry.durationS > 20)) decodedChannelSeconds += entry.durationS * (entry.channels || 1);
    check(() => assert.ok(entry.sources.length > 0, `${entry.file} has sources`));
    for (const source of entry.sources) {
      check(() => assert.match(source.license, ALLOWED, `${entry.file}: ${source.license} is an allowed license`));
      check(() => assert.doesNotMatch(`${source.author} ${source.title}`, /craigsmith|zapsplat|battlefield|call of duty/i, `${entry.file}: no doubtful library`));
      if (source.url) {
        check(() => assert.ok(source.title && source.author && source.retrieved && source.processing && source.download_sha256, `${entry.file}: source record`));
        check(() => assert.ok(Array.isArray(source.cuts) && source.cuts.every(([a, b]) => b > a), `${entry.file}: in/out seconds`));
      }
      if (/CC BY|Attribution/.test(source.license)) ccBy.add(source.url);
    }
  }
}
check(() => assert.ok(ccBy.size >= 20, 'the CC BY sources are counted'));
for (const url of ccBy) {
  check(() => assert.ok(docs.includes(url), `docs credit ${url}`));
  check(() => assert.ok(licenses.includes(url), `LICENSES.md credits ${url}`));
  check(() => assert.ok(credits.includes(url), `served CREDITS.txt credits ${url}`));
}
check(() => assert.match(licenses, /## CC BY credits/, 'LICENSES.md has a CC BY credits section'));
// No source whose permission is unclear: the NATO-derived gunfire layer, the non-commercial M61 take, and the
// standard-license YouTube bullet whiz (all modes) were removed on 2026-10-08.
for (const bank of BANKS) {
  const text = readFileSync(new URL(`assets/audio/conquest/${bank}/sources.json`, root), 'utf8');
  check(() => assert.doesNotMatch(text, /sounds\/855244|sounds\/611449|Seidhepriest/, `${bank}: no removed source`));
}
const flyby = JSON.parse(readFileSync(new URL('assets/audio/bullet-flyby-sources.json', root), 'utf8'));
check(() => assert.equal(flyby.license, 'CC BY 3.0', 'bullet whiz: CC BY source'));
check(() => assert.equal(flyby.clips.length, 3));
for (const clip of flyby.clips) {
  check(() => assert.equal(createHash('sha256').update(readFileSync(new URL(`assets/audio/${clip.file}`, root))).digest('hex'), clip.sha256, `${clip.file} hash`));
  check(() => assert.ok(clip.end_seconds > clip.start_seconds, `${clip.file} cut`));
}
check(() => assert.ok(licenses.includes(flyby.source_url), 'LICENSES.md credits the bullet whiz source'));
check(() => assert.doesNotMatch(readFileSync(new URL('js/audio/samples.js', root), 'utf8'), /8hVB1kChbvA/));
// Low graphics tier: one take per group.
check(() => assert.deepEqual(Object.keys(CONQUEST_SAMPLE_MANIFEST_LITE).sort(), Object.keys(CONQUEST_SAMPLE_GROUPS).map(group => `${group}.1`).sort()));
check(() => assert.ok(Object.entries(CONQUEST_SAMPLE_MANIFEST_LITE).every(([slot, url]) => CONQUEST_SAMPLE_MANIFEST[slot] === url)));
// Every manifest/stream URL exists; every shipped file is wired.
const referenced = new Set(CONQUEST_AUDIO_URLS);
for (const url of referenced) check(() => assert.ok(statSync(file(url)).size > 0, `${url} exists`));
check(() => assert.equal(referenced.size, durations.size, 'no dead Conquest asset and no missing one'));
check(() => assert.equal(Object.keys(CONQUEST_SAMPLE_MANIFEST).length, Object.values(CONQUEST_SAMPLE_GROUPS).flat().length));
check(() => assert.ok(Object.values(CONQUEST_STREAMS).every(url => durations.get(url) > 20), 'only long beds are streamed'));
// Lazy: nothing of the Conquest bank sits in the boot manifest or the generic slot catalog.
check(() => assert.ok(!Object.keys(BUILTIN_SAMPLE_MANIFEST).some(slot => slot.startsWith('cq.'))));
check(() => assert.ok(!Object.values(BUILTIN_SAMPLE_MANIFEST).some(url => url.includes('/conquest/'))));
check(() => assert.ok(!Object.keys(SAMPLE_FILE_SLOTS).some(slot => slot.startsWith('cq.'))));
// Budgets: download and decoded PCM (48 kHz float32) of the decoded part.
check(() => assert.ok(shippedBytes < 14.5 * 1048576, `Conquest audio download ${(shippedBytes / 1048576).toFixed(2)} MiB stays under 14.5 MiB`));
const decodedMb = decodedChannelSeconds * 48000 * 4 / 1048576;
check(() => assert.ok(decodedMb < 95, `decoded Conquest PCM ${decodedMb.toFixed(1)} MB stays under 95 MB`));

// --- Sampled voices on a recording context ---------------------------------------------------------
class Param {
  constructor(value = 0) { this.value = value; this.events = []; }
  setValueAtTime(value, at) { this.events.push(['set', value, at]); }
  linearRampToValueAtTime(value, at) { this.events.push(['ramp', value, at]); }
  setTargetAtTime(value, at, tau) { this.value = value; this.events.push(['target', value, at, tau]); }
  exponentialRampToValueAtTime(value, at) { this.events.push(['exponential', value, at]); }
  cancelScheduledValues(at) { this.events = this.events.filter(event => event[2] < at); }
}
class Node {
  constructor(ctx, kind) {
    this.ctx = ctx; this.kind = kind; this.connections = []; this.starts = [];
    for (const key of ['gain', 'frequency', 'Q', 'detune', 'delayTime', 'playbackRate', 'pan',
      'positionX', 'positionY', 'positionZ', 'threshold', 'knee', 'ratio', 'attack', 'release']) {
      this[key] = new Param(key === 'gain' || key === 'playbackRate' ? 1 : 0);
    }
    ctx.nodes.push(this);
  }
  connect(target) { this.connections.push(target); return target; }
  disconnect() { this.disconnected = true; }
  start(at = 0, offset = 0) { assert.equal(this.starts.length, 0, 'each source starts once'); this.starts.push([at, offset]); }
  stop(at) { this.stoppedAt = at ?? this.ctx.currentTime; }
}
class RecordingAudioContext {
  static last = null;
  constructor() {
    this.nodes = []; this.currentTime = 0; this.state = 'running'; this.sampleRate = 48000;
    this.destination = new Node(this, 'destination');
    this.listener = {};
    for (const key of ['positionX', 'positionY', 'positionZ', 'forwardX', 'forwardY', 'forwardZ', 'upX', 'upY', 'upZ']) this.listener[key] = new Param();
    RecordingAudioContext.last = this;
  }
  createGain() { return new Node(this, 'gain'); }
  createOscillator() { return new Node(this, 'oscillator'); }
  createBufferSource() { return new Node(this, 'source'); }
  createBiquadFilter() { return new Node(this, 'filter'); }
  createPanner() { return new Node(this, 'panner'); }
  createStereoPanner() { return new Node(this, 'stereo'); }
  createDynamicsCompressor() { return new Node(this, 'compressor'); }
  createDelay() { return new Node(this, 'delay'); }
  createMediaElementSource(element) { const node = new Node(this, 'media'); node.element = element; return node; }
  createBuffer(channels, length) { const data = Array.from({ length: channels }, () => new Float32Array(length)); return { getChannelData: index => data[index] }; }
  async decodeAudioData(bytes) {
    const url = new TextDecoder().decode(bytes);
    return { url, duration: durations.get(url) ?? 1, numberOfChannels: 1 };
  }
  addEventListener() {}
  removeEventListener() {}
  async close() { this.state = 'closed'; }
}
const fetchImpl = async (url) => ({ ok: true, arrayBuffer: async () => new TextEncoder().encode(url) });
const restore = installGlobals({ window: { AudioContext: RecordingAudioContext } });
const { sfx, VEHICLE_SOUND, CONQUEST_MIX, CONQUEST_TRIM_DB, BULLET_IMPACT_SOUND, HULL_HIT_SOUND, FAR_BOOM_HOLD, CONQUEST_BANK_RETRIES, JET_FLYBY_PEAKS,
  alignPeak, conquestBlastGroup, nearHandover } = await import('../public/js/audio/sfx.js');
const fresh = run => { const ctx = RecordingAudioContext.last; const from = ctx.nodes.length; run(); return ctx.nodes.slice(from); };
const buffered = nodes => nodes.filter(node => node.kind === 'source' && node.buffer?.url);
const urls = nodes => buffered(nodes).map(node => node.buffer.url);
const groupOf = url => Object.entries(CONQUEST_SAMPLE_GROUPS).find(([, files]) => files.some(f => url.endsWith(`/conquest/${f}`)))?.[0];
const groups = nodes => urls(nodes).map(groupOf);
try {
  sfx.setMasterVolume(0);
  // Before the bank decodes, Conquest cues are procedural (no buffers).
  sfx.vehicleLoop('warm', [0, 0, 0], 'jeep', { occupied: true });
  const ctx = RecordingAudioContext.last;
  sfx.setListener({ pos: [0, 2, 0], fwd: [0, 0, -1] });
  check(() => assert.equal(buffered(fresh(() => sfx.vehicleCannon([0, 2, -60]))).length, 0, 'procedural until the bank decodes'));
  check(() => assert.equal(sfx.bulletImpact('stone', [0, 2, -5]), false, 'bullet impacts are silent without the bank'));
  const loaded = await sfx.loadConquestBank(CONQUEST_SAMPLE_MANIFEST, fetchImpl);
  check(() => assert.equal(loaded.loaded, Object.keys(CONQUEST_SAMPLE_MANIFEST).length, 'every bank slot decodes'));
  check(() => assert.equal(sfx.loadConquestBank(CONQUEST_SAMPLE_MANIFEST, fetchImpl) instanceof Promise, true));
  sfx.stopVehicleLoops();

  // Engine loops: tank idle/rev/tracks/pivot layers, crossfaded and pitched by speed.
  ctx.currentTime = 1;
  let nodes = fresh(() => sfx.vehicleLoop('t1', [0, 2, -20], 'tank', { speed: 0, trackSpeed: 0, occupied: true }));
  check(() => assert.deepEqual(groups(nodes).sort(), ['cq.tank.idle', 'cq.tank.pivot', 'cq.tank.rev', 'cq.tank.tracks']));
  const tank = Object.fromEntries(buffered(nodes).map(node => [groupOf(node.buffer.url), node]));
  check(() => assert.ok(buffered(nodes).every(node => node.loop === true), 'engine layers loop'));
  const levelOf = source => source.connections[0].gain.value;
  check(() => assert.ok(levelOf(tank['cq.tank.idle']) > 0.9 && levelOf(tank['cq.tank.rev']) < 0.05, 'idle at rest'));
  ctx.currentTime = 1.1;
  check(() => assert.equal(buffered(fresh(() => sfx.vehicleLoop('t1', [0, 2, -20], 'tank', { speed: 12, trackSpeed: 12, occupied: true }))).length, 0, 'refresh reuses the layers'));
  check(() => assert.ok(levelOf(tank['cq.tank.rev']) > 0.9 && levelOf(tank['cq.tank.idle']) < 0.05, 'full speed is the load loop'));
  check(() => assert.ok(tank['cq.tank.rev'].playbackRate.value > 1.1 && levelOf(tank['cq.tank.tracks']) > 0.7, 'pitched up, tracks clattering'));
  ctx.currentTime = 1.2;
  sfx.vehicleLoop('t1', [0, 2, -20], 'tank', { speed: 0, trackSpeed: 5, occupied: true });
  check(() => assert.ok(levelOf(tank['cq.tank.pivot']) > 0.4, 'neutral steer squeals'));
  // Rotor and jet layers; the crew hears its own hull in the head.
  nodes = fresh(() => sfx.vehicleLoop('h1', [0, 20, -30], 'helicopter', { rotorSpeed: 1, occupied: true, self: true }));
  check(() => assert.deepEqual(groups(nodes).sort(), ['cq.heli.cockpit', 'cq.heli.distant', 'cq.heli.ext']));
  check(() => assert.equal(nodes.filter(node => node.kind === 'panner').length, 0, 'own rotorcraft is not positional'));
  const heli = Object.fromEntries(buffered(nodes).map(node => [groupOf(node.buffer.url), node]));
  check(() => assert.ok(levelOf(heli['cq.heli.cockpit']) > 0.9, 'cockpit loop for the pilot'));
  nodes = fresh(() => sfx.vehicleLoop('p1', [0, 60, -150], 'plane', { enginePower: 1, occupied: true, engineOn: true, speed: 120, velocity: [0, 0, 120] }));
  const jet = Object.fromEntries(buffered(nodes).map(node => [groupOf(node.buffer.url), node]));
  check(() => assert.ok(levelOf(jet['cq.jet.burner']) > 0.85 && levelOf(jet['cq.jet.ext']) > 0.95, 'full power lights the afterburner layer'));
  check(() => assert.ok(jet['cq.jet.ext'].playbackRate.value > 1.15, 'an approaching jet is Doppler-shifted up'));
  sfx.stopVehicleLoops();

  // Cannon: near take, recorded distant report past 150 m (delayed by distance / 343), interior for the crew, 400 m cull.
  ctx.currentTime = 2;
  check(() => assert.deepEqual(groups(fresh(() => check(() => assert.deepEqual(sfx.vehicleCannon([0, 2, -60]), { near: true, far: false })))), ['cq.cannon.near']));
  nodes = fresh(() => check(() => assert.deepEqual(sfx.vehicleCannon([0, 2, -300]), { near: false, far: true })));
  check(() => assert.deepEqual(groups(nodes), ['cq.cannon.distant']));
  check(() => assert.ok(Math.abs(buffered(nodes)[0].starts[0][0] - (2 + 300 / 343)) < 0.02, 'the far report arrives at the speed of sound'));
  check(() => assert.deepEqual(groups(fresh(() => sfx.vehicleCannon([0, 2, -5], { self: true }))), ['cq.cannon.interior']));
  check(() => assert.equal(fresh(() => sfx.vehicleCannon([0, 2, -450])).length, 0));

  // Blast banks by projectile type, vehicle weapon, radius and water.
  check(() => assert.equal(conquestBlastGroup('shell', { vehicleWeapon: 'tankAP' }), 'cq.blast.ap'));
  check(() => assert.equal(conquestBlastGroup('shell', { radius: 5.5 }), 'cq.blast.he'));
  check(() => assert.equal(conquestBlastGroup('shell', { radius: 2.5 }), 'cq.blast.ap'));
  check(() => assert.equal(conquestBlastGroup('rocket', { vehicleWeapon: 'aaMissile' }), 'cq.blast.airburst'));
  check(() => assert.equal(conquestBlastGroup('mgl', { vehicleWeapon: 'chinCannon' }), 'cq.blast.autocannon'));
  check(() => assert.equal(conquestBlastGroup('frag', { fluid: true }), 'cq.blast.water'));
  check(() => assert.equal(conquestBlastGroup('pulse', null), null, 'Chaos pulse keeps its own voice'));
  for (const [type, detail, group] of [['shell', { vehicleWeapon: 'tankHE', radius: 5.5 }, 'cq.blast.he'], ['frag', null, 'cq.blast.frag'],
    ['limpet', null, 'cq.blast.limpet'], ['rocket', { vehicleWeapon: 'aaMissile' }, 'cq.blast.airburst'], ['rocket', { fluid: true }, 'cq.blast.water']]) {
    check(() => assert.deepEqual(groups(fresh(() => sfx.explosion([0, 2, -40], type, detail))), [group], `${type} -> ${group}`));
  }
  ctx.currentTime = 2.5;
  nodes = fresh(() => sfx.explosion([0, 2, -200], 'shell', { vehicleWeapon: 'tankHE' }));
  check(() => assert.deepEqual(groups(nodes).sort(), ['cq.blast.he', 'cq.distant'], '150-260 m: near take plus distant boom'));
  // ...arriving together (both delayed by distance / 343 m/s) with the near take fading across the band: one blast, not two.
  const layered = buffered(nodes);
  check(() => assert.ok(layered.every(node => Math.abs(node.starts[0][0] - (2.5 + 200 / 343)) < 0.02), 'near take and boom land together'));
  check(() => assert.ok(nearHandover(100).gain === 1 && nearHandover(100).delay === 0, 'closer than 150 m: immediate, full'));
  check(() => assert.ok(nearHandover(205).gain < 0.75 && nearHandover(259).gain < 0.05, 'the near take fades toward 260 m'));
  // A recorded distant boom keeps its voice for FAR_BOOM_HOLD only (a fade, then the pool frees it).
  const boomGain = buffered(nodes).find(node => groupOf(node.buffer.url) === 'cq.distant').connections[0].connections[0].gain;
  check(() => assert.ok(boomGain.events.some(([kind, value, at]) => kind === 'ramp' && value === 0 && Math.abs(at - (2.5 + 200 / 343 + FAR_BOOM_HOLD)) < 0.02),
    'distant boom held for FAR_BOOM_HOLD'));
  check(() => assert.deepEqual(groups(fresh(() => sfx.explosion([0, 2, -320], 'frag'))), ['cq.distant'], 'past 260 m only the distant boom'));
  check(() => assert.equal(fresh(() => sfx.explosion([0, 2, -500], 'frag')).length, 0, 'past 400 m nothing'));
  // Variation: consecutive picks never repeat a take.
  const picks = Array.from({ length: 12 }, () => groups(fresh(() => sfx.explosion([0, 2, -40], 'frag'))) && urls(RecordingAudioContext.last.nodes.slice(-6))[0]);
  check(() => assert.ok(picks.every((url, i) => i === 0 || url !== picks[i - 1]), 'no immediate repeat'));
  check(() => assert.ok(new Set(picks).size >= 2, 'several frag takes in rotation'));

  // Destruction per class and cook-off.
  for (const [type, group] of [['tank', 'cq.destroy.tank'], ['jeep', 'cq.destroy.jeep'], ['transport', 'cq.destroy.heli'], ['plane', 'cq.destroy.jet']]) {
    check(() => assert.deepEqual(groups(fresh(() => sfx.vehicleDestruction([0, 2, -30], type))), [group]));
  }
  check(() => assert.deepEqual(groups(fresh(() => sfx.vehicleDestruction([0, 2, -30], 'tank', { secondary: true }))), ['cq.cookoff']));

  // Guns: one recorded round per shot, at most three overlapping per mount; door gun motor loop.
  ctx.currentTime = 3;
  let rounds = 0;
  for (let i = 0; i < 6; i++) rounds += buffered(fresh(() => sfx.vehicleGun('j:pintle', [5, 2, 0], 'hmg', { heat: 0 }))).length;
  check(() => assert.equal(rounds, 6, 'six rounds, six takes'));
  const hmgVoices = buffered(ctx.nodes).filter(node => groupOf(node.buffer.url) === 'cq.gun.hmg');
  check(() => assert.ok(hmgVoices.length === 6 && new Set(hmgVoices.map(node => node.buffer.url)).size >= 2, 'round robin over the takes'));
  nodes = fresh(() => sfx.vehicleGun('h:door', [5, 10, 0], 'doorMinigun'));
  check(() => assert.deepEqual(groups(nodes), ['cq.gun.doorMinigun']));
  check(() => assert.equal(buffered(nodes)[0].loop, true));
  check(() => assert.equal(buffered(fresh(() => sfx.vehicleGun('h:door', [5, 10, 0], 'doorMinigun'))).length, 0, 'the motor loop refreshes'));
  check(() => assert.deepEqual(groups(fresh(() => sfx.vehicleGun('p:nose', [0, 60, -200], 'planeCannon'))), ['cq.gun.planeCannonFar'], 'ground-heard burst far away'));
  check(() => assert.deepEqual(groups(fresh(() => sfx.vehicleAutocannon([0, 10, -20]))), ['cq.chin']));
  // Level trims: coax and HMG takes are raised toward the infantry guns.
  ctx.currentTime = 3.5;
  const coax = buffered(fresh(() => sfx.vehicleGun('t:coax', [5, 2, 0], 'coaxMG', { heat: 0 })))[0];
  const coaxIndex = Number(coax.buffer.url.match(/coax762-shot-(\d)/)[1]) - 1;
  check(() => assert.ok(Math.abs(coax.connections[0].gain.value - CONQUEST_MIX.gunShot * 10 ** (CONQUEST_TRIM_DB['cq.gun.coaxMG'][coaxIndex] / 20)) < 1e-9,
    'coax take trimmed to its measured level'));
  check(() => assert.ok(CONQUEST_MIX.cannon > CONQUEST_MIX.chin * 1.5, 'the 120 mm main gun stays above the 25 mm chin gun'));
  sfx.stopVehicleCues();

  // Cue loops: lock tones and alarms are sampled loops in the head.
  ctx.currentTime = 4;
  nodes = fresh(() => sfx.vehicleLockTone('inbound'));
  check(() => assert.deepEqual(groups(nodes), ['cq.cue.inbound']));
  check(() => assert.equal(nodes.filter(node => node.kind === 'panner').length, 0));
  check(() => assert.deepEqual(groups(fresh(() => sfx.vehicleAlarm(true, { air: true }))), ['cq.cue.alarmAir']));
  sfx.vehicleAlarm(false);
  check(() => assert.deepEqual(groups(fresh(() => sfx.vehicleAlarm(true))), ['cq.cue.alarm']));
  sfx.stopVehicleCues();

  // Hull hits, hatches, reloads, countermeasures, missiles, burning.
  for (const [name, call, group] of [
    ['AT crunch', () => sfx.vehicleHullHit([0, 2, -10], { eff: 1, dmg: 300, cls: 'at' }), 'cq.hull.heavy'],
    ['interior crunch', () => sfx.vehicleHullHit([0, 2, -1], { eff: 1, dmg: 300, cls: 'he', self: true }), 'cq.hull.heavyIn'],
    ['armour ping', () => sfx.vehicleHullHit([0, 2, -10], { eff: 0, cls: 'small', type: 'tank' }), 'cq.hull.small'],
    ['jeep sheet metal', () => sfx.vehicleHullHit([0, 2, -10], { eff: 1, dmg: 20, cls: 'mg', type: 'jeep' }), 'cq.hull.light'],
    ['tank hatch', () => sfx.vehicleHatch([0, 2, -5], { enter: true }, 'tank'), 'cq.hatch.tankEnter'],
    ['jeep door', () => sfx.vehicleHatch([0, 2, -5], { enter: false }, 'jeep'), 'cq.hatch.jeepExit'],
    ['breech', () => sfx.vehicleReload([0, 2, -5], { self: true, heavy: true }), 'cq.reload.heavy'],
    ['feed tray', () => sfx.vehicleReload([0, 2, -5], { self: true, heavy: false }), 'cq.reload.light'],
    ['flares', () => sfx.vehicleCountermeasure([0, 20, -20], 'flares'), 'cq.flares'],
    ['smoke', () => sfx.vehicleCountermeasure([0, 2, -20], 'smoke'), 'cq.smoke'],
    ['pods', () => sfx.vehicleMissileLaunch([0, 20, -20], { kind: 'pod' }), 'cq.pod'],
    ['AA launch', () => sfx.vehicleMissileLaunch([0, 20, -20], { kind: 'aa' }), 'cq.aa.launch'],
    ['missile flight', () => sfx.missileFlight('m1', [0, 30, -50]), 'cq.aa.flight'],
    ['burning', () => sfx.vehicleBurning('b', [0, 2, -15], 1), 'cq.burning'],
    ['block debris', () => sfx.impact('stone', 0.8, [0, 2, -15]), 'cq.debris.stone'],
    ['ejection', () => sfx.ejectionSeat([0, 50, -20]), 'cq.eject'],
    ['chute open', () => sfx.parachuteOpen([0, 50, -20], { self: true }), 'cq.chute.open'],
    ['chute descent', () => sfx.parachuteDescent('c', [0, 50, -2], { self: true }), 'cq.chute.descent'],
    ['spool', () => sfx.vehicleRotorSpool([0, 2, -20], 'up'), 'cq.rotor.spoolUp'],
    ['wade', () => sfx.vehicleWade('w', [0, 2, -20], 1), 'cq.wade.loop'],
    ['skid', () => sfx.vehicleSkid([0, 2, -20]), 'cq.jeep.skid'],
  ]) check(() => assert.deepEqual(groups(fresh(call)), [group], name));
  // Turret servo (after the burst above has expired from the pool), then the stop clunk.
  ctx.currentTime = 4.5;
  sfx.stopVehicleCues();
  ctx.currentTime = 10;
  check(() => assert.deepEqual(groups(fresh(() => sfx.vehicleTurret('tt', [0, 2, -10], 1))), ['cq.tank.turret'], 'turret'));
  check(() => assert.deepEqual(groups(fresh(() => sfx.vehicleTurret('tt', [0, 2, -10], 0))), ['cq.tank.turretStop'], 'traverse stop clunk'));
  sfx.stopVehicleCues();

  // Pass-bys: the loudest moment lands on the closest approach.
  check(() => assert.deepEqual(alignPeak(5, 3.1), { delay: 1.9, offset: 0 }));
  check(() => assert.ok(alignPeak(1, 3.1).delay === 0 && Math.abs(alignPeak(1, 3.1).offset - 2.1) < 1e-9));
  ctx.currentTime = 15;
  nodes = buffered(fresh(() => sfx.jetFlyby([0, 30, -20], { delay: 1 })));
  const take = Number(nodes[0].buffer.url.match(/jet-flyby-(\d)/)[1]);
  check(() => assert.ok(Math.abs(nodes[0].starts[0][1] - (JET_FLYBY_PEAKS[take - 1] - 1)) < 1e-6, 'flyby offset into the take'));
  nodes = buffered(fresh(() => sfx.shellFlyby([0, 2, -3], { delay: 0.5 })));
  check(() => assert.ok(Math.abs(nodes[0].starts[0][0] - (15 + 0.5 - 0.16)) < 1e-6, 'AP crack timed to the pass'));

  // Bullet impacts: per surface, budgeted, out of range silent.
  ctx.currentTime = 20;
  check(() => assert.deepEqual(groups(fresh(() => sfx.bulletImpact('grass', [0, 2, -5]))).slice(0, 1), ['cq.bullet.dirt']));
  check(() => assert.equal(sfx.bulletImpact('metal', [0, 2, -80]), false, 'beyond 45 m'));
  let hits = 0;
  for (let i = 0; i < 30; i++) if (sfx.bulletImpact('wood', [0, 2, -5])) hits++;
  check(() => assert.ok(hits <= BULLET_IMPACT_SOUND.budget, `at most ${BULLET_IMPACT_SOUND.budget} impacts per window`));
  // Hull hits share a budget too: HMG fire into a jeep cannot flood the positional voices.
  let hullHits = 0;
  for (let i = 0; i < 12; i++) if (sfx.vehicleHullHit([0, 2, -10], { eff: 1, dmg: 20, cls: 'mg', type: 'jeep' })) hullHits++;
  check(() => assert.equal(hullHits, HULL_HIT_SOUND.budget, `at most ${HULL_HIT_SOUND.budget} hull hits per window`));
  ctx.currentTime = 20 + HULL_HIT_SOUND.window + 0.01;
  check(() => assert.equal(sfx.vehicleHullHit([0, 2, -10], { eff: 1, dmg: 20, cls: 'mg', type: 'jeep' }), true, 'the next window plays again'));

  // A shell that bursts before its pass point silences its pending pass cue.
  ctx.currentTime = 21;
  nodes = fresh(() => sfx.shellFlyby([0, 2, -3], { he: true, delay: 2, id: 'shell-7' }));
  const whistle = nodes.find(node => node.kind === 'gain' && node.connections.some(target => target.kind === 'panner'));
  check(() => assert.equal(sfx.cancelShellFlyby('shell-7'), true, 'cancelled before the pass'));
  check(() => assert.ok(whistle.gain.events.some(([kind, value]) => kind === 'ramp' && value === 0), 'the pass voice fades out'));
  check(() => assert.equal(sfx.cancelShellFlyby('shell-7'), false, 'only once'));

  // Unload: back to procedural voices.
  sfx.unloadConquestBank();
  // Files that fail to load are retried in the background (not stuck on the procedural voice all match).
  {
    const realSetTimeout = globalThis.setTimeout;
    const timers = [];
    globalThis.setTimeout = (fn, ms) => { timers.push([fn, ms]); return { unref() {} }; };
    let failing = true;
    const flaky = async (url) => (failing && url.endsWith('frag-2.ogg') ? { ok: false } : fetchImpl(url));
    try {
      const first = await sfx.loadConquestBank(CONQUEST_SAMPLE_MANIFEST, flaky);
      check(() => assert.equal(first.failed, 1, 'one file failed'));
      check(() => assert.equal(timers.length, 1) || assert.equal(timers[0][1], CONQUEST_BANK_RETRIES[0] * 1000));
      failing = false;
      timers.shift()[0]();
      await new Promise(resolve => realSetTimeout(resolve, 20));
      check(() => assert.ok(sfx.conquestAudio().getBuffer('cq.blast.frag.2'), 'the retry decoded the missing take'));
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    sfx.unloadConquestBank();
  }
  check(() => assert.equal(buffered(fresh(() => sfx.vehicleCannon([0, 2, -60]))).length, 0, 'unloaded bank: procedural again'));
  check(() => assert.ok(CONQUEST_MIX.cannon > 0 && VEHICLE_SOUND.farRange === 400));
} finally {
  await sfx.dispose();
  restore();
}

// --- VehicleAudio derived cues ------------------------------------------------------------------------
function recordingSfx() {
  const calls = [];
  return new Proxy({ calls }, { get: (target, name) => name in target ? target[name] : (...args) => { calls.push([name, ...args]); return true; } });
}
const named = (sfx, name) => sfx.calls.filter(call => call[0] === name);
{
  check(() => assert.ok(polylineDistance(384, 384, FRONTIER_PLAN.river.points) < 1e-9 && polylineDistance(500, 384, FRONTIER_PLAN.river.points) > 100));
  const pass = closestApproach([0, 50, -400], [0, 0, 200], [10, 0, 0]);
  check(() => assert.ok(Math.abs(pass.time - 2) < 1e-9 && Math.abs(pass.distance - Math.hypot(10, 50)) < 1e-9));
  const sfx = recordingSfx();
  const audio = new VehicleAudio(sfx, { river: FRONTIER_PLAN.river });
  const self = { id: 'me', team: 'alpha' };
  // Rotor spool-up from rest, spool-down once the empty rotor slows.
  audio.update([{ id: 'h', type: 'helicopter', x: 0, y: 30, z: -20, hp: 900, rotorSpeed: 0, seatOccupants: { driver: 'x' } }], [0, 30, 0], { now: 0 });
  audio.update([{ id: 'h', type: 'helicopter', x: 0, y: 30, z: -20, hp: 900, rotorSpeed: 0.2, seatOccupants: { driver: 'x' } }], [0, 30, 0], { now: 0.1 });
  check(() => assert.equal(named(sfx, 'vehicleRotorSpool').at(-1)[2], 'up'));
  audio.update([{ id: 'h', type: 'helicopter', x: 0, y: 30, z: -20, hp: 900, rotorSpeed: 1, seatOccupants: {} }], [0, 30, 0], { now: 0.2 });
  audio.update([{ id: 'h', type: 'helicopter', x: 0, y: 30, z: -20, hp: 900, rotorSpeed: 0.95, seatOccupants: {} }], [0, 30, 0], { now: 0.3 });
  audio.update([{ id: 'h', type: 'helicopter', x: 0, y: 30, z: -20, hp: 900, rotorSpeed: 0.9, seatOccupants: {} }], [0, 30, 0], { now: 0.4 });
  check(() => assert.deepEqual(named(sfx, 'vehicleRotorSpool').map(call => call[2]), ['up', 'down'], 'one spool-down per wind-down'));
  // Jet pass: closest approach 2 s ahead and 50 m off.
  audio.update([{ id: 'p', type: 'plane', x: 50, y: 60, z: -400, vx: 0, vy: 0, vz: 200, hp: 500, enginePower: 1, engineOn: true, seatOccupants: { driver: 'x' } }], [0, 40, 0], { now: 1 });
  const flyby = named(sfx, 'jetFlyby').at(-1);
  check(() => assert.ok(flyby && Math.abs(flyby[2].delay - 2) < 1e-9, 'flyby scheduled at the pass'));
  audio.update([{ id: 'p', type: 'plane', x: 50, y: 60, z: -398, vx: 0, vy: 0, vz: 200, hp: 500, enginePower: 1, engineOn: true, seatOccupants: { driver: 'x' } }], [0, 40, 0], { now: 1.01 });
  check(() => assert.equal(named(sfx, 'jetFlyby').length, 1, 'one flyby per pass'));
  // Turret traverse for the crew, then the stop.
  const tank = (turretYaw, extra = {}) => ({ id: 't', type: 'tank', x: 0, y: 26, z: -10, yaw: 0, turretYaw, hp: 1000, seatOccupants: { driver: 'me' }, ...extra });
  audio.update([tank(0)], [0, 26, 0], { self, now: 2 });
  audio.update([tank(0.05)], [0, 26, 0], { self, now: 2.05 });
  const traverse = named(sfx, 'vehicleTurret').at(-1);
  check(() => assert.ok(traverse && traverse[3] > 0.5 && traverse[4].self === true, 'traverse whine for the gunner'));
  audio.update([tank(0.05)], [0, 26, 0], { self, now: 2.5 });
  check(() => assert.equal(named(sfx, 'vehicleTurret').at(-1)[3], 0, 'traverse stops'));
  // Wading at the north ford, splash on entry; dry ground stops the loop.
  const jeep = (x, z, extra = {}) => ({ id: 'j', type: 'jeep', x, y: 21.5, z, yaw: 0, speed: 6, hp: 320, seatOccupants: { driver: 'x' }, ...extra });
  audio.update([jeep(392, 270)], [392, 23, 280], { now: 3 });
  check(() => assert.equal(named(sfx, 'vehicleWadeSplash').length, 1));
  check(() => assert.equal(named(sfx, 'vehicleWade').length, 1));
  audio.update([jeep(420, 270, { y: 26 })], [392, 23, 280], { now: 3.1 });
  check(() => assert.equal(named(sfx, 'stopVehicleWade').length, 1));
  // Skid on a hard turn at speed.
  audio.update([jeep(300, 300, { y: 26, speed: 12, yaw: 0 })], [300, 26, 310], { now: 4 });
  audio.update([jeep(300, 301, { y: 26, speed: 12, yaw: 0.2 })], [300, 26, 310], { now: 4.05 });
  check(() => assert.equal(named(sfx, 'vehicleSkid').length, 1));
  // Hatch types reach sfx; aircraft alarms are the master caution.
  audio.update([{ id: 'p2', type: 'plane', x: 0, y: 30, z: -5, hp: 100, enginePower: 0.5, engineOn: true, seatOccupants: { driver: 'me' } }], [0, 30, 0], { self, now: 5 });
  check(() => assert.deepEqual(named(sfx, 'vehicleAlarm').at(-1).slice(1), [true, { air: true }]));
  const loop = named(sfx, 'vehicleLoop').at(-1);
  check(() => assert.equal(loop[4].self, true, 'own hull loop is flagged self'));
  audio.dispose();
  check(() => assert.equal(VEHICLE_AUDIO.flybyRange, 110));
}

// --- Soundscape -------------------------------------------------------------------------------------
{
  const base = { fwd: [0, 0, -1], wind: 1.6, intensity: 0.2, calm: { A: 1, B: 1 }, wrecks: [{ x: 100, y: 30, z: 100 }] };
  const river = soundscapeTargets({ ...base, pos: [384 + 10, 24, 384 - 100] });
  check(() => assert.ok(river.river.gain > 0.3 && river.birdsFarm.gain === 0, 'river bank'));
  const farm = soundscapeTargets({ ...base, pos: [232, 30, 248] });
  check(() => assert.ok(farm.birdsFarm.gain > 0.5 && farm.river.gain === 0, 'birds at Kestrel Farm'));
  check(() => assert.equal(soundscapeTargets({ ...base, pos: [232, 30, 248], calm: { A: 0, B: 1 } }).birdsFarm.gain, 0, 'silent after combat'));
  const ford = soundscapeTargets({ ...base, pos: [392, 22, 272] });
  check(() => assert.ok(ford.rapids.gain > 0.5, 'rapids at the ford'));
  const ridge = soundscapeTargets({ ...base, pos: [496, 60, 248], wind: 2.2 });
  check(() => assert.ok(ridge.windRidge.gain > 0.35 && ridge.windGusty.gain > farm.windGusty.gain, 'ridge whistle and overcast gusts'));
  const hot = soundscapeTargets({ ...base, pos: [384, 30, 384], intensity: 1 });
  check(() => assert.ok(hot.battleHigh.gain > hot.battleLow.gain, 'busy match: the high bed leads'));
  check(() => assert.ok(soundscapeTargets({ ...base, pos: [101, 30, 101] }).wreckFire.gain > 0.3, 'fire crackle at a wreck prop'));
  check(() => assert.ok(soundscapeTargets({ ...base, pos: [536, 30, 520] }).industrial.gain > 0.5, 'Kessler Works drone'));
  const east = soundscapeTargets({ ...base, pos: [384 - 30, 24, 300], fwd: [0, 0, -1] });
  check(() => assert.ok(east.river.pan > 0.5, 'the river to the east pans right when facing north (-z)'));
  check(() => assert.ok(nearestOnPolyline(384, 384, FRONTIER_PLAN.river.points).distance < 1e-9));

  // Live instance with a fake engine, streams and the decoded bank.
  const ctx = new RecordingAudioContext();
  const engine = { ctx, bus: ctx.createGain() };
  const streams = [];
  const createStream = (context, url) => {
    const element = { url, playing: false };
    const stream = { element, source: context.createMediaElementSource(element), play: () => { element.playing = true; return Promise.resolve(); },
      pause: () => { element.playing = false; }, dispose: () => { element.disposed = true; } };
    streams.push(stream);
    return stream;
  };
  const bank = { engine, getBuffer: slot => ({ url: slot, duration: 5 }), pick: group => `${group}.1` };
  const scape = new ConquestSoundscape({ audio: bank, weather: 'overcast', wrecks: [{ x: 100, y: 30, z: 100 }], random: () => 0.5, createStream });
  const camera = { position: { x: 232, y: 30, z: 248 }, matrixWorld: { elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] } };
  scape.update(1 / 60, camera, { match: { phase: 'live', conquest: { flags: [['A', 0, 'alpha', 'capturing', 1, 0]] } }, selfTeam: 'alpha' });
  const opened = streams.map(stream => stream.element.url.split('/').pop()).sort();
  check(() => assert.ok(opened.includes('birds-countryside-bed.ogg') && opened.includes('battle-bed-low.ogg') && opened.includes('wind-valley-bed.ogg')));
  check(() => assert.ok(!opened.includes('river-flow.ogg') && !opened.includes('industrial-drone.ogg'), 'out-of-range beds are never fetched'));
  check(() => assert.ok(streams.every(stream => stream.element.playing)));
  check(() => assert.equal(scape.played.filter(group => group === 'cq.amb.bell').length, SOUNDSCAPE.bell.tolls, 'three tolls at match start'));
  // A close blast scatters the birds and silences them.
  scape.handleEvent({ kind: 'projectileExplode', x: 240, y: 30, z: 250 });
  check(() => assert.ok(scape.played.includes('cq.amb.scatter') && scape.calm.A === 0));
  // Artillery: delayed by distance / 343 m/s.
  const before = ctx.nodes.length;
  check(() => assert.equal(scape.artillery([232 + 343, 30, 248]), true));
  const boom = ctx.nodes.slice(before).find(node => node.kind === 'source');
  check(() => assert.ok(Math.abs(boom.starts[0][0] - 1) < 1e-6, 'one second for 343 m'));
  // A salvo 730 m away (West HQ to the east-edge flashes) is still heard, at the floor level of its own attenuation.
  const far = ctx.nodes.length;
  check(() => assert.equal(scape.artillery([232 + 730, 30, 248]), true, 'flashes past 600 m are not dropped'));
  const farAmp = ctx.nodes.slice(far).find(node => node.kind === 'source').connections[0];
  check(() => assert.ok(Math.abs(farAmp.gain.value - SOUNDSCAPE.artillery.level * Math.max(SOUNDSCAPE.artillery.floor, 1 - 730 / SOUNDSCAPE.artillery.range)) < 1e-9,
    'one distance attenuation only'));
  scape.update(1 / 60, camera, { match: { phase: 'post', conquest: { flags: [] } }, selfTeam: 'alpha' });
  check(() => assert.equal(scape.played.filter(group => group === 'cq.amb.bell').length, SOUNDSCAPE.bell.tolls * 2, 'and three at match end'));
  scape.dispose();
  await new Promise(resolve => setTimeout(resolve, 400));
  check(() => assert.ok(streams.every(stream => stream.element.disposed), 'streams released after the fade'));
}

// --- Objective cues with the bank -----------------------------------------------------------------
{
  const ctx = new RecordingAudioContext();
  const engine = { ctx, bus: ctx.createGain(), noiseBuffer: { length: 1 } };
  const bank = { getBuffer: slot => ({ url: slot, duration: 2 }) };
  const cues = createObjectiveCues({ audioContext: engine, announcer: { play() { return true; }, registerBuffer() { return true; } }, fetchImpl: null,
    hidden: () => false, bank });
  let from = ctx.nodes.length;
  check(() => assert.equal(cues.handleEvent({ kind: 'flag_captured', flag: 'D', team: 'alpha' }, 'alpha').stinger, 'captured'));
  check(() => assert.deepEqual(ctx.nodes.slice(from).filter(node => node.kind === 'source').map(node => node.buffer.url), [`${OBJECTIVE_SAMPLE_CUES.captured}.1`]));
  check(() => assert.equal(ctx.nodes.slice(from).filter(node => node.kind === 'oscillator').length, 0, 'recorded take instead of the synth score'));
  const inZone = { x: 232, z: 248, state: 'alive' };
  cues.syncMatch({ mode: 'conquest', phase: 'live', conquest: { flags: [['A', 40, null, 'capturing', 2, 0]] } }, 'alpha', inZone);
  check(() => assert.equal(cues.capturing, true, 'capture tick loop in the moving zone'));
  cues.syncMatch({ mode: 'conquest', phase: 'live', conquest: { flags: [['A', 100, 'alpha', 'idle', 0, 0]] } }, 'alpha', inZone);
  check(() => assert.equal(cues.capturing, false, 'stops when the zone settles'));
  cues.dispose();
  // Height: like the server presence test, a pilot over the flag is not in its zone.
  const zones = flagZonesFrom([{ id: 'A', x: 232, y: 30, z: 248, radius: 22 }]);
  check(() => assert.equal(insideFlagZone('A', { x: 232, y: 31, z: 248 }, zones), true));
  check(() => assert.equal(insideFlagZone('A', { x: 232, y: 30 + CONQUEST_RULES.presenceDy + 5, z: 248 }, zones), false, 'flying over the flag'));
  check(() => assert.equal(insideFlagZone('A', { x: 232, z: 248 }, zones), true, 'unknown height: x/z only'));
  const aloft = createObjectiveCues({ audioContext: engine, announcer: { play() { return true; }, registerBuffer() { return true; } }, fetchImpl: null,
    hidden: () => false, bank, flagZones: [{ id: 'A', x: 232, y: 30, z: 248, radius: 22 }] });
  aloft.syncMatch({ mode: 'conquest', phase: 'live', conquest: { flags: [['A', 40, null, 'capturing', 2, 0]] } }, 'alpha', { x: 232, y: 90, z: 248, state: 'alive' });
  check(() => assert.equal(aloft.capturing, false, 'no capture tick loop for a pilot over a moving flag'));
  aloft.syncMatch({ mode: 'conquest', phase: 'live', conquest: { flags: [['A', 40, null, 'capturing', 2, 0]] } }, 'alpha', { x: 232, y: 31, z: 248, state: 'alive' });
  check(() => assert.equal(aloft.capturing, true, 'on the ground it ticks'));
  aloft.dispose();
}

// --- Water entry of a bullet path (rounds pass through water, so wall impacts never report it) ------------
{
  const { TracerFX, WATER_PROBE } = await import('../public/js/weapons/ballistics.js');
  const tracer = Object.create(TracerFX.prototype);
  const getBlock = (x, y, z) => (y <= 20 && y >= 17 && x >= 0 && x < 40 ? MC_WATER : 0);
  const splashes = [];
  Object.assign(tracer, { getBlockFn: getBlock, fluidAt: (x, y, z) => getBlock(x, y, z) === MC_WATER,
    onWaterImpact: (point, local) => splashes.push([point, local]), waterFocus: () => [20, 22, 0] });
  const down = { x: 0.6, y: -0.8, z: 0 };
  check(() => assert.equal(tracer.probeWater([0, 30, 0], down, 40, false), true, 'a round into the pond reports its entry'));
  check(() => assert.ok(Math.abs(splashes[0][0][1] - 21) < 1e-6 && splashes[0][0][0] > 6 && splashes[0][0][0] < 7, 'at the water surface'));
  check(() => assert.equal(tracer.probeWater([0, 30, 0], { x: 1, y: 0, z: 0 }, 40, false), false, 'a round over the water: nothing'));
  tracer.waterFocus = () => [20 + WATER_PROBE.radius + 30, 22, 0];
  check(() => assert.equal(tracer.probeWater([0, 30, 0], down, 40, false), false, 'far from the listener: not probed'));
  tracer.waterFocus = () => [20, 22, 0];
  check(() => assert.equal(tracer.probeWater([10, 19, 0], down, 10, false), false, 'a round fired under water is not an entry'));
}

// --- Vehicle hitscan wall impacts reach the impact sound hook ----------------------------------------------
// VehicleFx._impact (coax, HMG, door minigun, plane cannon) calls the shared tracers' onWallImpact
// (conquest-vehicle-fx-test checks that routing); Effects wires that same callback to the sound hook.
{
  const THREE = await import('../public/js/vendor/three.module.js');
  const { Effects } = await import('../public/js/weapons/effects.js');
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 1000);
  const getBlock = (x, y, z) => (x === 4 && y === 10 && z === -6 ? MC_STONE : 0);
  const sounds = [];
  const effects = new Effects(scene, camera, getBlock, { onWallImpact: (surface, pos) => sounds.push([surface, pos]) });
  effects.tracers.onWallImpact({ x: 4, y: 10, z: -6, nx: 0, ny: 0, nz: 1 }, false);
  check(() => assert.deepEqual(sounds, [['stone', [4.5, 10.5, -5]]], 'a vehicle gun round into stone plays the stone impact at the struck face'));
  effects.dispose?.();
}

console.log(`Conquest SFX bank: ${checks} checks passed (files, hashes, licenses and CC BY credits, lazy manifest, budgets, sampled vehicle/weapon/blast/cue voices, derived vehicle cues, soundscape, objective cues).`);
