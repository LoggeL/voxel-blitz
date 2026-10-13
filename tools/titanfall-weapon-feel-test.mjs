// Titan primary weapon feel and sound (docs/titanfall.md §5.4 "Feel", §7.3; docs/audio/titan-sfx.md):
//   - feel tuning (titan-weapon-feel.js): per-weapon ordering, railgun charge scaling, the shake bus
//     held (never stacked) by a Predator burst, the FOV punch cap, nearby viewers, the cockpit kick
//     spring (titan-cockpit.js stepRecoil) peaking and settling
//   - the titan weapon bank (audio/titan-bank.js): every file shipped as Opus, credited
//     (sources.json, CREDITS.txt, LICENSES.md), lazy (not in the boot manifest), inside the budgets
//   - TitanSynth on a muted recording AudioContext: synth fallback before the bank decodes, the sampled
//     report layers per weapon, distance low-pass and range, the Predator round cap, casings and burst
//     tail, the railgun charge whine synced to the server charge with ready cue and hold loop, the
//     Predator spin-up / spin / spin-down, own reloads, impact / ricochet / confirm budgets
//   - no frag blast for titan shells or Leadwall pellets (sfx.explosion), pellets that run out of range
//     in the air (radius 0) end silently, and their impacts / ricochets reach the titan voices
import assert from 'node:assert/strict';
import { readFileSync, statSync, existsSync } from 'node:fs';
import { TITAN_WEAPON_FEEL, TITAN_FEEL_NEAR, TITAN_FEEL_VIEW, shotFeel, holdShake, applyShotFeel } from '../public/js/titanfall/titan-weapon-feel.js';
import { TITAN_COCKPIT, stepRecoil, makeTitanCockpit } from '../public/js/titanfall/titan-cockpit.js';
import { TitanSynth, TITAN_AUDIO, TITAN_WEAPON_MIX } from '../public/js/vehicles/vehicle-audio.js';
import { TITAN_SAMPLE_GROUPS, TITAN_LOOP_GROUPS, TITAN_SAMPLE_MANIFEST, TITAN_AUDIO_URLS } from '../public/js/audio/titan-bank.js';
import { BUILTIN_SAMPLE_MANIFEST } from '../public/js/audio/samples.js';
import { VEHICLE_WEAPONS } from '../shared/vehicle-defs.js';
import { explodeTitanProjectile } from '../server/sim/titanfall/titan-projectiles.js';
import * as projectileViews from '../public/js/titanfall/titan-projectile-views.js';
import * as titanPresentation from '../public/js/titanfall/titan-presentation.js';
import { installGlobals } from './lib/install-globals.mjs';

let checks = 0;
const check = fn => { fn(); checks++; };
const PRIMARIES = ['splitter', 't203', 'railgun', 'leadwall', 'predatorClose', 'predatorLong'];

// --- Feel tuning -------------------------------------------------------------------------------------
check(() => assert.ok(PRIMARIES.every(w => shotFeel(w)), 'every titan primary has a feel'));
check(() => assert.equal(shotFeel('titanMelee'), null));
check(() => assert.equal(shotFeel('cannon'), null, 'not for Conquest weapons'));
{
  const full = shotFeel('railgun', { charge: 1 }), tap = shotFeel('railgun', { charge: 0 }), half = shotFeel('railgun', { charge: 0.5 });
  check(() => assert.ok(full.trauma > tap.trauma && full.fov > half.fov && half.fov > tap.fov && full.cabin.pitch > tap.cabin.pitch, 'railgun feel grows with the charge'));
  check(() => assert.ok(tap.cabin.pitch >= TITAN_WEAPON_FEEL.railgun.cabin.pitch * TITAN_WEAPON_FEEL.railgun.minCharge - 1e-12, 'a tap still kicks'));
  // The order the weapons are felt in: a charged rail hardest, then the shotgun and the shell; per-round guns light.
  const by = key => shotFeel(key, { charge: 1 });
  check(() => assert.ok(by('railgun').trauma > by('leadwall').trauma && by('leadwall').trauma > by('t203').trauma && by('t203').trauma > by('splitter').trauma));
  check(() => assert.ok(by('railgun').cabin.pitch > by('leadwall').cabin.pitch && by('leadwall').cabin.pitch > by('t203').cabin.pitch
    && by('t203').cabin.pitch > by('splitter').cabin.pitch && by('splitter').cabin.pitch > by('predatorClose').cabin.pitch));
  check(() => assert.ok(shotFeel('splitter', { split: true }).fov > shotFeel('splitter').fov, 'the ION split shot shoves harder'));
  check(() => assert.ok(shotFeel('predatorClose').alternate && shotFeel('predatorLong').alternate && !shotFeel('t203').alternate));
}
{
  // The shake bus: a Predator burst holds its level instead of saturating the bus.
  const shake = { trauma: 0, add(x) { this.trauma = Math.min(1, this.trauma + x); return this.trauma; } };
  const feel = shotFeel('predatorClose');
  for (let i = 0; i < 40; i++) applyShotFeel(feel, { self: true, shake });
  check(() => assert.ok(Math.abs(shake.trauma - feel.trauma) < 1e-9, `40 rounds hold ${feel.trauma} (${shake.trauma})`));
  check(() => assert.equal(holdShake(shake, 0.1), shake.trauma, 'a lower shot never lowers the bus'));
  holdShake(shake, 0.6);
  check(() => assert.ok(Math.abs(shake.trauma - 0.6) < 1e-9, 'a heavier shot raises it'));
  // Others' heavy shots shake nearby viewers by distance; per-round guns never do.
  const near = { trauma: 0, add(x) { this.trauma += x; return this.trauma; } };
  const at = applyShotFeel(shotFeel('leadwall'), { distance: TITAN_FEEL_NEAR.range / 2, shake: near });
  check(() => assert.ok(Math.abs(at.trauma - TITAN_WEAPON_FEEL.leadwall.trauma * TITAN_FEEL_NEAR.share * 0.5) < 1e-9));
  check(() => assert.equal(applyShotFeel(shotFeel('leadwall'), { distance: TITAN_FEEL_NEAR.range + 1, shake: near }).trauma, 0));
  check(() => assert.equal(applyShotFeel(shotFeel('predatorClose'), { distance: 3, shake: near }).trauma, 0));
  check(() => assert.equal(applyShotFeel(shotFeel('leadwall'), { distance: 3, shake: near, camera: { isPerspectiveCamera: true, fov: 70, userData: {} } }).fov, 0,
    'no FOV punch for others\' shots'));
}
{
  // FOV punch: the cockpit view takes the whole punch, the chase view a share; a burst stays within maxFov.
  const camera = { isPerspectiveCamera: true, fov: 70, userData: {}, updates: 0, updateProjectionMatrix() { this.updates++; } };
  const out = applyShotFeel(shotFeel('t203'), { self: true, camera });
  check(() => assert.ok(Math.abs(out.fov - TITAN_WEAPON_FEEL.t203.fov) < 1e-9 && camera.fov > 70 && camera.updates === 1));
  for (let i = 0; i < 30; i++) applyShotFeel(shotFeel('railgun', { charge: 1 }), { self: true, camera });
  check(() => assert.ok(camera.fov <= 70 + TITAN_FEEL_VIEW.maxFov + 1e-9, `FOV punches cap at +${TITAN_FEEL_VIEW.maxFov}° (${camera.fov})`));
  const chase = { isPerspectiveCamera: true, fov: 60, userData: {} };
  check(() => assert.ok(Math.abs(applyShotFeel(shotFeel('leadwall'), { self: true, camera: chase, chase: true }).fov
    - TITAN_WEAPON_FEEL.leadwall.fov * TITAN_FEEL_VIEW.chaseFov) < 1e-9));
  // The cockpit kick: only with the cockpit shown; the Predator's yaw alternates per round.
  const kicks = [];
  const cockpit = { kick(peaks, bloom) { kicks.push({ ...peaks, bloom }); return true; } };
  check(() => assert.equal(applyShotFeel(shotFeel('leadwall'), { self: true, cockpit, chase: true }).kicked, false, 'no cabin kick in the chase view'));
  for (let i = 0; i < 4; i++) applyShotFeel(shotFeel('predatorClose'), { self: true, cockpit });
  check(() => assert.ok(kicks.length === 4 && kicks.every((k, i) => i === 0 || Math.sign(k.yaw) === -Math.sign(kicks[i - 1].yaw)), 'Predator yaw alternates'));
  check(() => assert.ok(kicks.every(k => k.bloom === TITAN_WEAPON_FEEL.predatorClose.bloom && k.pitch > 0 && k.push > 0)));
}
{
  // The cabin spring: an impulse sized by kick() peaks near the asked angle and settles within half a second.
  const K = TITAN_COCKPIT.kick, w = Math.sqrt(K.stiffness), z = K.damping, s = Math.sqrt(1 - z * z);
  const gain = w / Math.exp(-z / s * Math.atan2(s, z));
  const peak = TITAN_WEAPON_FEEL.railgun.cabin.pitch;
  const recoil = { x: [0, 0, 0, 0], v: [peak * gain, 0, 0, 0] };
  let top = 0, t = 0;
  for (; t < 0.5; t += 1 / 60) { stepRecoil(recoil, 1 / 60); top = Math.max(top, recoil.x[0]); }
  check(() => assert.ok(Math.abs(top - peak) < peak * 0.12, `cabin kick peaks at ${peak} rad (${top.toFixed(4)})`));
  check(() => assert.ok(Math.abs(recoil.x[0]) < peak * 0.05 && Math.abs(recoil.v[0]) < 0.02, 'and settles within 0.5 s'));
  const hard = { x: [0, 0, 0, 0], v: [10, 0, 0, 10] };
  for (let i = 0; i < 10; i++) stepRecoil(hard, 1 / 60);
  check(() => assert.ok(Math.abs(hard.x[0]) <= K.maxAngle + 1e-12 && Math.abs(hard.x[3]) <= K.maxPush + 1e-12, 'kick offsets are clamped'));
  const live = makeTitanCockpit('titan_northstar');
  check(() => assert.equal(live.kick({ pitch: peak, yaw: 0, roll: 0, push: 0.05 }, 1), true));
  check(() => assert.deepEqual(live.recoilOffsets(), [0, 0, 0, 0], 'the spring moves on the next placement, not at the kick'));
  live.dispose();
}

// --- Server: what the client feel reads ---------------------------------------------------------------
{
  const events = [];
  explodeTitanProjectile({}, { tf: 'titan:leadwall', ownerId: 'a1', id: 'p1', x: 4, y: 12, z: 9 }, { pushEvent: e => events.push(e) });
  check(() => assert.equal(events.length, 1));
  check(() => assert.ok(events[0].kind === 'projectileExplode' && events[0].type === 'leadwall' && events[0].radius === 0,
    'a pellet out of range in the air ends with radius 0'));
}

// --- The bank: files, licences, budgets ----------------------------------------------------------------
const publicRoot = new URL('../public/', import.meta.url);
const fileOf = url => new URL(`.${url}`, publicRoot);
const sources = JSON.parse(readFileSync(new URL('assets/audio/titan/sources.json', publicRoot), 'utf8'));
const credits = readFileSync(new URL('assets/audio/titan/CREDITS.txt', publicRoot), 'utf8');
const licenses = readFileSync(new URL('assets/audio/LICENSES.md', publicRoot), 'utf8');
const docs = readFileSync(new URL('../docs/audio/titan-sfx.md', import.meta.url), 'utf8');
const ALLOWED = /^(CC0 1\.0|CC BY 3\.0|CC BY 4\.0|Public Domain)$/;
/** Seconds of an Ogg Opus file: the last page's granule position less the pre-skip, at 48 kHz. */
function opusInfo(bytes) {
  const buffer = Buffer.from(bytes);
  assert.equal(buffer.toString('latin1', 0, 4), 'OggS', 'Ogg container');
  const head = buffer.indexOf('OpusHead', 0, 'latin1');
  assert.ok(head > 0 && head < 200, 'Opus stream');
  const channels = buffer[head + 9], preSkip = buffer.readUInt16LE(head + 10);
  const last = buffer.lastIndexOf('OggS', buffer.length - 4, 'latin1');
  const granule = Number(buffer.readBigUInt64LE(last + 6));
  return { channels, seconds: (granule - preSkip) / 48000 };
}
const durations = new Map();
let bytes = 0, decoded = 0;
const entries = Array.isArray(sources) ? sources : sources.files ?? Object.values(sources);
const entryFor = url => entries.find(entry => url.endsWith(`/titan/${entry.file ?? entry.path}`) || entry.url === url);
for (const url of TITAN_AUDIO_URLS) {
  check(() => assert.ok(existsSync(fileOf(url)), `${url} shipped`));
  const data = readFileSync(fileOf(url));
  const info = opusInfo(data);
  durations.set(url, info.seconds);
  bytes += statSync(fileOf(url)).size;
  decoded += info.seconds * info.channels * 48000 * 4;
  const entry = entryFor(url);
  check(() => assert.ok(entry, `${url} in sources.json`));
  check(() => assert.match(String(entry.license), ALLOWED, `${url}: licence ${entry.license}`));
  for (const source of [entry.sources ?? entry.source ?? []].flat()) {
    const license = String(source.license ?? entry.license);
    check(() => assert.match(license, ALLOWED, `${url} source licence ${license}`));
    if (/^CC BY/.test(license)) {
      const author = String(source.author ?? source.creator ?? '');
      check(() => assert.ok(author && credits.includes(author) && licenses.includes(author), `${url}: CC BY credit for ${author}`));
    }
  }
}
check(() => assert.equal(new Set(TITAN_AUDIO_URLS).size, Object.values(TITAN_SAMPLE_GROUPS).flat().length));
check(() => assert.equal(Object.keys(TITAN_SAMPLE_MANIFEST).length, Object.values(TITAN_SAMPLE_GROUPS).flat().length));
check(() => assert.ok(TITAN_LOOP_GROUPS.every(group => TITAN_SAMPLE_GROUPS[group]?.length), 'loop groups are bank groups'));
check(() => assert.ok(!Object.keys(BUILTIN_SAMPLE_MANIFEST).some(slot => slot.startsWith('tf.')), 'lazy: not in the boot manifest'));
check(() => assert.ok(!Object.values(BUILTIN_SAMPLE_MANIFEST).some(url => url.includes('/titan/'))));
check(() => assert.ok(bytes < 1.5 * 1048576, `titan bank download ${(bytes / 1048576).toFixed(2)} MiB under 1.5 MiB`));
check(() => assert.ok(decoded / 1048576 < 25, `titan bank decoded ${(decoded / 1048576).toFixed(1)} MB under 25 MB`));
check(() => assert.ok(licenses.includes('## Titan weapon sound bank') && docs.includes('## In-game wiring')));
const seconds = group => durations.get(`/assets/audio/titan/${TITAN_SAMPLE_GROUPS[group][0]}`);
check(() => assert.ok(Math.abs(seconds('tf.railgun.charge') - VEHICLE_WEAPONS.railgun.chargeSeconds) < 0.25, `charge take ≈ the server charge (${seconds('tf.railgun.charge')} s)`));
check(() => assert.ok(seconds('tf.predator.spinUp') > 0.3 && seconds('tf.predator.spinUp') < 1.5));
check(() => assert.ok(TITAN_LOOP_GROUPS.every(group => seconds(group) >= 0.4), 'loops long enough not to buzz'));
for (const group of Object.keys(TITAN_SAMPLE_GROUPS).filter(g => /\.(fire|impact|ricochet|casings)$/.test(g) || g === 'tf.hit.confirm')) {
  check(() => assert.ok(TITAN_SAMPLE_GROUPS[group].every(file => durations.get(`/assets/audio/titan/${file}`) < 3), `${group}: one-shots stay short`));
}

// --- TitanSynth on a muted recording context ------------------------------------------------------------
class Param {
  constructor(value = 0) { this.value = value; this.events = []; }
  setValueAtTime(value, at) { this.events.push(['set', value, at]); }
  linearRampToValueAtTime(value, at) { this.events.push(['ramp', value, at]); }
  setTargetAtTime(value, at, tau) { this.events.push(['target', value, at, tau]); }
  exponentialRampToValueAtTime(value, at) { this.events.push(['exponential', value, at]); }
  cancelScheduledValues() {}
}
class Node {
  constructor(ctx, kind) {
    this.ctx = ctx; this.kind = kind; this.connections = []; this.starts = [];
    for (const key of ['gain', 'frequency', 'Q', 'detune', 'delayTime', 'playbackRate', 'pan', 'positionX', 'positionY', 'positionZ',
      'threshold', 'knee', 'ratio', 'attack', 'release']) this[key] = new Param(key === 'gain' || key === 'playbackRate' ? 1 : 0);
    ctx.nodes.push(this);
  }
  connect(target) { this.connections.push(target); return target; }
  disconnect() { this.disconnected = true; }
  start(at = 0, offset = 0) { assert.equal(this.starts.length, 0, 'each source starts once'); this.starts.push([at, offset]); }
  stop(at) { this.stoppedAt = at ?? this.ctx.currentTime; }
}
class RecordingAudioContext {
  constructor() {
    this.nodes = []; this.currentTime = 0; this.state = 'running'; this.sampleRate = 48000; this.destination = new Node(this, 'destination');
    this.listener = {};
    for (const key of ['positionX', 'positionY', 'positionZ', 'forwardX', 'forwardY', 'forwardZ', 'upX', 'upY', 'upZ']) this.listener[key] = new Param();
  }
  createGain() { return new Node(this, 'gain'); }
  createOscillator() { return new Node(this, 'oscillator'); }
  createBufferSource() { return new Node(this, 'source'); }
  createBiquadFilter() { return new Node(this, 'filter'); }
  createPanner() { return new Node(this, 'panner'); }
  createWaveShaper() { return new Node(this, 'shaper'); }
  createStereoPanner() { return new Node(this, 'stereo'); }
  createDynamicsCompressor() { return new Node(this, 'compressor'); }
  createDelay() { return new Node(this, 'delay'); }
  createConvolver() { return new Node(this, 'convolver'); }
  createBuffer(channels, length) { const data = Array.from({ length: channels }, () => new Float32Array(length)); return { getChannelData: i => data[i], duration: length / 48000 }; }
  async decodeAudioData(data) { const url = new TextDecoder().decode(data); return { url, duration: durations.get(url) ?? 1, numberOfChannels: 1 }; }
}
const fetchImpl = async url => ({ ok: true, arrayBuffer: async () => new TextEncoder().encode(url) });
const ctx = new RecordingAudioContext();
const engine = { ctx, bus: ctx.createGain(), noiseBuffer: ctx.createBuffer(1, 4800), ensure: () => true };
const synth = new TitanSynth({ objectiveAudio: () => ({ engine }) });
synth.listener = [0, 0, 0];
const fresh = run => { const from = ctx.nodes.length; run(); return ctx.nodes.slice(from); };
const groupOf = url => Object.entries(TITAN_SAMPLE_GROUPS).find(([, files]) => files.some(f => url.endsWith(`/titan/${f}`)))?.[0];
const sampled = nodes => nodes.filter(node => node.kind === 'source' && node.buffer?.url).map(node => groupOf(node.buffer.url));
const sourcesOf = (nodes, group) => nodes.filter(node => node.kind === 'source' && node.buffer?.url && groupOf(node.buffer.url) === group);
const later = seconds => { ctx.currentTime += seconds; };

// Before the bank decodes: the synthesized voices.
for (const weapon of PRIMARIES) {
  const nodes = fresh(() => synth.shot(weapon, [0, 0, -10], { self: true, charge: 1, vehicleId: `s-${weapon}` }));
  check(() => assert.ok(nodes.some(node => node.kind === 'oscillator') && sampled(nodes).length === 0, `${weapon}: synth until the bank decodes`));
  later(1);
}
synth.dispose();
const loaded = await synth.loadBank(TITAN_SAMPLE_MANIFEST, fetchImpl);
check(() => assert.equal(loaded.loaded, Object.keys(TITAN_SAMPLE_MANIFEST).length, 'every bank slot decodes'));
check(() => assert.equal(synth.pick('tf.splitter.fire') !== synth.pick('tf.splitter.fire'), true, 'never the same take twice in a row'));
{
  // One failed take must not hide later decoded variations of the same weapon.
  const getBuffer = synth.bank.getBuffer.bind(synth.bank);
  synth.bank.getBuffer = slot => slot === 'tf.splitter.fire.1' ? null : getBuffer(slot);
  check(() => assert.ok(synth.has('tf.splitter.fire')));
  check(() => assert.ok(synth._takes('tf.splitter.fire').length === 3 && synth.pick('tf.splitter.fire') !== 'tf.splitter.fire.1'));
  synth.bank.getBuffer = getBuffer;
}

// Report layers per weapon (own titan, in the head).
later(5);
{
  let groups = sampled(fresh(() => synth.shot('splitter', [0, 0, 0], { self: true, vehicleId: 'ion' })));
  check(() => assert.deepEqual(groups.sort(), ['tf.splitter.fire', 'tf.splitter.tail']));
  later(3);
  groups = sampled(fresh(() => synth.shot('splitter', [0, 0, 0], { self: true, split: true, vehicleId: 'ion' })));
  check(() => assert.ok(groups.includes('tf.splitter.split'), 'the split shot adds its layer'));
  later(3);
  const t203 = fresh(() => synth.shot('t203', [0, 0, 0], { self: true, vehicleId: 'scorch' }));
  check(() => assert.deepEqual(sampled(t203).sort(), ['tf.t203.fire', 'tf.t203.mech', 'tf.t203.tail']));
  check(() => assert.ok(sourcesOf(t203, 'tf.t203.mech')[0].starts[0][0] >= ctx.currentTime + 0.5, 'the breech cycles after the shot'));
  later(3);
  check(() => assert.ok(sampled(fresh(() => synth.shot('leadwall', [0, 0, 0], { self: true, vehicleId: 'ronin' }))).includes('tf.leadwall.pump')));
  later(3);
  // Far away: no mechanics, a low-pass, louder tail share; out of range: nothing.
  const far = fresh(() => synth.shot('leadwall', [200, 0, 0], { vehicleId: 'ronin2' }));
  check(() => assert.deepEqual(sampled(far).sort(), ['tf.leadwall.fire', 'tf.leadwall.tail'], 'no rack heard at 200 m'));
  check(() => assert.ok(far.some(node => node.kind === 'filter' && node.frequency.value < 8000), 'distance low-pass'));
  check(() => assert.equal(sampled(fresh(() => synth.shot('leadwall', [TITAN_AUDIO.weaponRange + 5, 0, 0], {}))).length, 0));
  check(() => assert.equal(sampled(fresh(() => synth.shot('titanMelee', [0, 0, 0], { self: true }))).length, 0, 'melee keeps its swing'));
  later(4);
}

// Predator: rounds capped, brass every few rounds, the tail when the burst stops.
{
  const nodes = fresh(() => { for (let i = 0; i < 12; i++) synth.shot('predatorClose', [0, 0, 0], { self: true, vehicleId: 'legion' }); });
  check(() => assert.equal(sourcesOf(nodes, 'tf.predator.fire').length, TITAN_AUDIO.maxRounds, 'at most maxRounds overlapping rounds'));
  check(() => assert.equal(sourcesOf(nodes, 'tf.predator.casings').length, Math.ceil(12 / TITAN_AUDIO.casingEvery)));
  later(TITAN_AUDIO.predatorTailAfter + 0.05);
  const tail = fresh(() => synth.update([], [0, 0, 0], 0));
  check(() => assert.equal(sourcesOf(tail, 'tf.predator.tail').length, 1, 'burst tail'));
  check(() => assert.equal(sourcesOf(fresh(() => synth.update([], [0, 0, 0], 0)), 'tf.predator.tail').length, 0, 'once'));
  later(3);
  const ability = fresh(() => synth.shot('predatorClose', [0, 0, 0], { self: true, ability: true, vehicleId: 'legion' }));
  check(() => assert.equal(sourcesOf(ability, 'tf.predator.casings').length, 0, 'ability rays borrow the report only'));
  later(3);
}

{
  // At the highest authoritative cadence every round remains audible, including the last one.
  const rate = 17;
  const nodes = fresh(() => { for (let i = 0; i < 34; i++) {
    synth.shot('predatorClose', [0, 0, 0], { self: true, vehicleId: 'cadence-legion' }); later(1 / rate);
  } });
  check(() => assert.equal(sourcesOf(nodes, 'tf.predator.fire').length, 34, 'no artificial silence inside a 17 Hz burst'));
  later(4);
}

// Charge whine and spin from the presented mount row (field 6), own reloads.
const titanRow = (type, reload100, charge100) => ({ type, mounts: [[0, 0, -1, 0, reload100, charge100]] });
const at = (row, id, self = true, pos = [0, 0, 0], distance = 0) => [{ row, id, pos, distance, self }];
{
  const getBuffer = synth.bank.getBuffer.bind(synth.bank);
  synth.bank.getBuffer = slot => slot.startsWith('tf.railgun.hold.') || slot.startsWith('tf.predator.spin.') ? null : getBuffer(slot);
  for (const [type, id] of [['titan_northstar', 'missing-hold'], ['titan_legion', 'missing-spin']]) {
    fresh(() => synth.update(at(titanRow(type, 0, 100), id), [0, 0, 0], 0));
    check(() => assert.ok(synth.weapon.get(id)?.wind?.synth, `${type}: failed full-state loop keeps its synthesized voice`));
  }
  synth.bank.getBuffer = getBuffer;
  const nodes = fresh(() => synth.update(at(titanRow('titan_legion', 0, 100), 'missing-spin'), [0, 0, 0], 0));
  check(() => assert.equal(sourcesOf(nodes, 'tf.predator.spin').length, 1, 'late loop decode replaces the synthesized voice'));
  const held = synth.weapon.get('missing-spin').hold;
  check(() => assert.ok(held.level.gain.events.some(([kind, , at]) => kind === 'ramp' && at > ctx.currentTime), '12 ms fade when joining a loop'));
  later(3);
}
{
  const dur = seconds('tf.railgun.charge');
  let nodes = fresh(() => synth.update(at(titanRow('titan_northstar', 0, 50), 'ns'), [0, 0, 0], 0));
  const charge = sourcesOf(nodes, 'tf.railgun.charge')[0];
  check(() => assert.ok(charge, 'charge whine starts with the charge'));
  check(() => assert.ok(Math.abs(charge.playbackRate.value - dur / VEHICLE_WEAPONS.railgun.chargeSeconds) < 1e-9, 'stretched to the server charge time'));
  check(() => assert.ok(Math.abs(charge.starts[0][1] - dur * 0.5) < 1e-6, 'joined at the charge reached'));
  later(0.8);
  nodes = fresh(() => synth.update(at(titanRow('titan_northstar', 0, 100), 'ns'), [0, 0, 0], 0));
  check(() => assert.equal(sourcesOf(nodes, 'tf.railgun.ready').length, 1, 'ready cue at full charge'));
  const hold = sourcesOf(nodes, 'tf.railgun.hold')[0];
  check(() => assert.ok(hold?.loop, 'hold loop while the charge is held'));
  check(() => assert.equal(sourcesOf(fresh(() => synth.update(at(titanRow('titan_northstar', 0, 100), 'ns'), [0, 0, 0], 0)), 'tf.railgun.ready').length, 0, 'ready once'));
  nodes = fresh(() => synth.shot('railgun', [0, 0, 0], { self: true, charge: 1, vehicleId: 'ns' }));
  check(() => assert.ok(hold.stoppedAt != null && charge.stoppedAt != null, 'the shot cuts the whine'));
  check(() => assert.ok(Math.abs(sourcesOf(nodes, 'tf.railgun.fire')[0].playbackRate.value - 1) < 1e-9, 'full charge plays at pitch'));
  const tap = fresh(() => { later(3); synth.shot('railgun', [0, 0, 0], { self: true, charge: 0.2, vehicleId: 'ns2' }); });
  check(() => assert.ok(sourcesOf(tap, 'tf.railgun.fire')[0].connections[0].gain.value < TITAN_WEAPON_MIX.railFire * 0.7, 'a tap is quieter'));
  synth.update(at(titanRow('titan_northstar', 0, 0), 'ns'), [0, 0, 0], 0);
  // Out of windRange: no whine for others' charge.
  later(1);
  check(() => assert.equal(sampled(fresh(() => synth.update(at(titanRow('titan_northstar', 0, 60), 'far', false, [80, 0, 0], 80), [0, 0, 0], 0))).length, 0));
}
{
  later(2);
  const dur = seconds('tf.predator.spinUp');
  let nodes = fresh(() => synth.update(at(titanRow('titan_legion', 0, 40), 'lg'), [0, 0, 0], 0));
  const up = sourcesOf(nodes, 'tf.predator.spinUp')[0];
  check(() => assert.ok(up && Math.abs(up.playbackRate.value - Math.max(0.25, Math.min(4, dur / VEHICLE_WEAPONS.predatorClose.spinUpSeconds))) < 1e-9, 'spin-up synced to the server spin-up'));
  nodes = fresh(() => synth.update(at(titanRow('titan_legion', 0, 100), 'lg'), [0, 0, 0], 0));
  const spin = sourcesOf(nodes, 'tf.predator.spin')[0];
  check(() => assert.ok(spin?.loop, 'spin loop at full spin'));
  nodes = fresh(() => synth.update(at(titanRow('titan_legion', 0, 70), 'lg'), [0, 0, 0], 0));
  check(() => assert.ok(spin.stoppedAt != null && sourcesOf(nodes, 'tf.predator.spinDown').length === 1, 'spin-down as the barrels slow'));
  // Own magazine reload starting.
  nodes = fresh(() => synth.update(at(titanRow('titan_legion', 10, 0), 'lg'), [0, 0, 0], 0));
  check(() => assert.equal(sourcesOf(nodes, 'tf.predator.reload').length, 1));
  check(() => assert.ok(Math.abs(sourcesOf(nodes, 'tf.predator.reload')[0].playbackRate.value
    - seconds('tf.predator.reload') / VEHICLE_WEAPONS.predatorClose.reloadSeconds) < 1e-9, 'drum lock follows the authoritative reload duration'));
  check(() => assert.ok(Math.abs(sourcesOf(nodes, 'tf.predator.reload')[0].starts[0][1] - seconds('tf.predator.reload') * 0.9) < 1e-9,
    'joining a reload at 10% remaining skips to its final 10%'));
  check(() => assert.equal(sourcesOf(fresh(() => synth.update(at(titanRow('titan_legion', 40, 0), 'lg'), [0, 0, 0], 0)), 'tf.predator.reload').length, 0, 'once per reload'));
  later(3);
  check(() => assert.equal(sampled(fresh(() => synth.update(at(titanRow('titan_ion', 10, 0), 'ion2', false, [10, 0, 0], 10), [0, 0, 0], 0))).length, 0, 'no reload for others'));
  synth.update([], [0, 0, 0], 0);
  check(() => assert.equal(synth.weapon.size, 0, 'hulls that left forget their state'));
}

// Impacts, ricochets and confirms: budgeted.
{
  later(5);
  let nodes = fresh(() => { for (let i = 0; i < 10; i++) synth.impact('leadwall', [5, 0, 5]); });
  check(() => assert.equal(sourcesOf(nodes, 'tf.leadwall.impact').length, TITAN_AUDIO.impactBudget, 'ten pellets, a few hits heard'));
  later(1);
  nodes = fresh(() => synth.impact('t203', [5, 0, 5]));
  check(() => assert.deepEqual(sampled(nodes).sort(), ['tf.t203.burn', 'tf.t203.impact']));
  later(1);
  nodes = fresh(() => { for (let i = 0; i < 6; i++) synth.ricochet([2, 0, 2]); });
  check(() => assert.equal(sourcesOf(nodes, 'tf.leadwall.ricochet').length, TITAN_AUDIO.ricochetBudget));
  later(1);
  nodes = fresh(() => { synth.confirm('hit'); synth.confirm('hit'); synth.confirm('doom'); });
  check(() => assert.equal(sourcesOf(nodes, 'tf.hit.confirm').length, 1, `one hit confirm per ${TITAN_AUDIO.confirmGap} s`));
  check(() => assert.equal(sourcesOf(nodes, 'tf.hit.doom').length, 1));
  check(() => assert.equal(sourcesOf(fresh(() => synth.confirm('kill')), 'tf.hit.kill').length, 1, 'destruction has its own cue'));
  later(3);
  // The weapon voice budget holds under a flood.
  nodes = fresh(() => { for (let i = 0; i < 60; i++) synth.shot(i % 2 ? 'splitter' : 'leadwall', [i, 0, 0], { vehicleId: `f${i}` }); });
  check(() => assert.ok(synth.weaponVoices.length <= TITAN_AUDIO.maxWeaponVoices));
  later(5);
  synth.unloadBank();
  nodes = fresh(() => synth.shot('t203', [0, 0, 0], { self: true }));
  check(() => assert.ok(sampled(nodes).length === 0 && nodes.some(node => node.kind === 'oscillator'), 'unloaded: back to the synth'));
  synth.dispose();
}

{
  const calls = [];
  const own = { id: 'own-titan', walker: true, wreck: false, row: { type: 'titan_legion', own: 'me', seatOccupants: { driver: 'me' } },
    cockpit: { confirm: label => calls.push(['glass', label]) } };
  titanPresentation.setTitanWorld({ selfId: () => 'me', view: { items: new Map([['own-titan', own]]) },
    audio: { titanConfirm: kind => calls.push(['audio', kind]) } });
  titanPresentation.onEvent({ kind: 'vehicle_destroyed', type: 'titan_ion', vehicleId: 'enemy', attacker: 'other' });
  titanPresentation.onEvent({ kind: 'vehicle_destroyed', type: 'tank', vehicleId: 'enemy', attacker: 'me' });
  titanPresentation.onEvent({ kind: 'vehicle_destroyed', type: 'titan_ion', vehicleId: 'own-titan', attacker: 'me' });
  check(() => assert.equal(calls.length, 0, 'no kill confirm for another attacker, Conquest hull, or own hull'));
  titanPresentation.onEvent({ kind: 'vehicle_destroyed', type: 'titan_ion', vehicleId: 'enemy', attacker: 'me' });
  check(() => assert.deepEqual(calls, [['audio', 'kill'], ['glass', 'TITAN DESTROYED']]));
  titanPresentation.setTitanWorld({});
}

// Titan shells and Leadwall pellets never fall back to the frag blast; impacts and ricochets reach the titan voices.
{
  const calls = [];
  projectileViews.setProjectileSinks({ audio: { titanImpact: (w, p) => calls.push(['impact', w, p]), titanRicochet: p => calls.push(['ricochet', p]) } });
  projectileViews.onEvent({ kind: 'projectileExplode', type: 'leadwall', x: 1, y: 2, z: 3, radius: 0 });
  check(() => assert.equal(calls.length, 0, 'a pellet out of range in the air is silent'));
  projectileViews.onEvent({ kind: 'projectileExplode', type: 'leadwall', x: 1, y: 2, z: 3, radius: 0.15 });
  projectileViews.onEvent({ kind: 'projectileExplode', type: 't203', x: 1, y: 2, z: 3, radius: 4 });
  check(() => assert.deepEqual(calls.map(c => c[1]), ['leadwall', 't203']));
  projectileViews.dispose();
  const restore = installGlobals({ window: { AudioContext: class extends RecordingAudioContext { addEventListener() {} removeEventListener() {} async close() {} } } });
  try {
    const { sfx } = await import('../public/js/audio/sfx.js');
    sfx.setMasterVolume(0);
    sfx.objectiveAudio().engine.ensure?.();
    const audio = sfx.objectiveAudio().engine.ctx;
    const frag = audio.nodes.length;
    sfx.explosion([0, 2, -5], 'frag');
    check(() => assert.ok(audio.nodes.length > frag, 'the recording context hears a frag'));
    const before = audio.nodes.length;
    sfx.explosion([0, 2, -5], 'leadwall', { radius: 0.15 });
    sfx.explosion([0, 2, -5], 't203', { radius: 4 });
    check(() => assert.equal(audio.nodes.length, before, 'no frag blast for a T-203 shell or a Leadwall pellet'));
  } finally { restore(); }
}

console.log(`Titan weapon feel: ${checks} checks passed (feel ordering and charge scaling, held shake, FOV cap, cockpit spring, `
  + `leadwall range-out radius 0, bank files/licences/budgets (${(bytes / 1048576).toFixed(2)} MiB, ${(decoded / 1048576).toFixed(1)} MB decoded), `
  + 'synth fallback, sampled layers, distance low-pass, Predator round cap/casings/tail, charge whine and spin synced to the server, '
  + 'reloads, impact/ricochet/confirm budgets, no frag blast for titan rounds).');
process.exit(0);
