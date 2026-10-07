import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { GameEngine } from '../server/game.js';
import { AnnouncerVoice, ANNOUNCER_GAIN, ANNOUNCER_COALESCE_MS } from '../public/js/audio/announcer.js';
import { CombatFeedback } from '../public/js/combat/feedback.js';
import { BUILTIN_SAMPLE_MANIFEST } from '../public/js/audio/samples.js';
import {
  ANNOUNCER_CUES, MULTIKILL_WINDOW_MS, OBJECTIVE_CUES, OBJECTIVE_FLAG_IDS, announcerCueInfo, objectiveAnnouncerCue, objectiveCueUrl,
} from '../shared/announcer.js';
import {
  createObjectiveCues, OBJECTIVE_STINGERS, STINGER_SCORES, stingerForEvent, matchEndCue, CAPTURE_START_REPEAT_MS, UNDER_ATTACK_REPEAT_MS,
} from '../public/js/audio/objective-cues.js';
import { FRONTIER_PLAN } from '../shared/conquest-contract.js';
import { drainOwnEventsEarly, drainEventsWithDedupe } from '../public/js/engine/netclient.js';

const engine = new GameEngine();
engine.addClient('self', 'Announcer test');
engine.addBot('target', 'Target');
const self = engine.entities.get('self'), target = engine.entities.get('target');
function kill(gap = 500) {
  engine.now += gap;
  engine.respawnPlayer(target);
  engine.killPlayer(target, self, 'rifle', false);
  return engine.tickEvents.at(-1);
}
const calls = [kill(), kill(), kill(), kill(), kill(), kill(), kill()];
assert.deepEqual(calls.map(e => e.announcer),
  [undefined, 'doublekill', 'triplekill', 'multikill', 'ultrakill', 'monsterkill', undefined]);
const beforeDuplicate = engine.tickEvents.length;
engine.killPlayer(target, self, 'rifle', false);
assert.equal(engine.tickEvents.length, beforeDuplicate, 'an already dead victim cannot count twice');
assert.equal(kill(MULTIKILL_WINDOW_MS + 1).announcer, undefined, 'expired combos start with one kill');
assert.equal(kill(MULTIKILL_WINDOW_MS).announcer, 'doublekill', 'exact window boundary still counts');
assert.equal(kill().announcer, 'rampage', 'ten kills in one life outrank a simultaneous triple');
for (let n = 11; n <= 20; n++) {
  assert.equal(kill(MULTIKILL_WINDOW_MS + 1).announcer, n === 20 ? 'godlike' : undefined,
    'life streak survives gaps but only speaks at its milestones');
}
engine.respawnPlayer(self);
assert.equal(kill().announcer, undefined, 'round respawns reset surviving players too');
assert.equal(kill().announcer, 'doublekill');
engine.killPlayer(self, target, 'rifle', false);
assert.equal(kill().announcer, undefined, 'posthumous damage never starts a new life streak');
engine.respawnPlayer(self);
assert.equal(kill().announcer, undefined, 'death and respawn clear combo and streak');
engine.killPlayer(self, self, 'grenade', false);
assert.equal(engine.tickEvents.at(-1).announcer, undefined, 'suicides have no reward');
engine.respawnPlayer(self);
engine.killPlayer(self, null, 'world', false);
assert.equal(engine.tickEvents.at(-1).announcer, undefined, 'world deaths have no reward');
engine.respawnPlayer(self);
const isEnemy = engine.mode.policy.isEnemy;
engine.mode.policy.isEnemy = () => false;
kill(); kill();
engine.mode.policy.isEnemy = isEnemy;
assert.equal(kill().announcer, undefined, 'friendly kills never advance the counter');
const mode = engine.mode.policy.mode;
engine.mode.policy.mode = 'ttt';
assert.equal(kill().announcer, undefined, 'TTT never carries reward metadata');
engine.mode.policy.mode = mode;
engine.mode.policy.phase = 'post';
assert.equal(kill().announcer, undefined, 'post-round kills never advance the counter');
engine.mode.policy.phase = 'live';
assert.equal(kill().announcer, 'doublekill', 'excluded kills leave the legitimate combo untouched');

// Existing transport deduplication also protects the new cue field.
const wire = JSON.parse(JSON.stringify(calls[1]));
const state = { seen: new Set() };
const frames = [{ now: 10, snapSeq: 1, events: [wire] }];
assert.deepEqual(drainOwnEventsEarly(frames, 'self', state), [wire]);
assert.deepEqual(drainOwnEventsEarly(frames, 'self', state), []);
assert.deepEqual(drainEventsWithDedupe(frames, 10, state), []);

const heard = [];
const player = { alive: true };
const feedback = new CombatFeedback({
  sfx: { announceKill: cue => heard.push(cue), stopAnnouncer: () => heard.push('stop') },
  hud: { hitmark() {}, killfeed() {}, setPainImpulse() {}, setDeathBrutality() {}, setDead() {} },
  roster: { death() {} }, player,
  getMyId: () => 'self', getSelfRow: () => null, isRunning: () => true,
});
feedback.handleEvent(wire);
feedback.handleEvent({ ...wire, killer: 'other' });
player.alive = false;
feedback.handleEvent(wire);
assert.deepEqual(heard, ['doublekill'], 'only the living local killer hears the authoritative cue');
player.alive = true;
feedback.handleEvent({ kind: 'respawn', id: 'self' });
assert.deepEqual(heard, ['doublekill', 'stop'], 'an authoritative round reset stops speech even while already alive');
feedback.presentLocalRespawn();
feedback.dispose();
feedback.handleEvent(wire);
assert.deepEqual(heard, ['doublekill', 'stop', 'stop', 'stop'], 'respawn and leaving stop queued speech');

class Param {
  constructor() { this.events = []; }
  setValueAtTime(value, at) { this.events.push(['set', value, at]); }
  linearRampToValueAtTime(value, at) { this.events.push(['ramp', value, at]); }
}
class Node {
  constructor() { this.gain = new Param(); this.connections = []; }
  connect(node) { this.connections.push(node); return node; }
  disconnect() { this.disconnected = true; }
  start(at) { this.startedAt = at; }
  stop() { this.stopped = true; }
}
const sources = [], gains = [], timers = new Map();
let timerId = 0, hidden = false, loaded = true;
const ctx = { state: 'running', currentTime: 0,
  createBufferSource() { const s = new Node(); sources.push(s); return s; },
  createGain() { const g = new Node(); gains.push(g); return g; } };
const audio = { ctx, bus: {}, get now() { return ctx.currentTime; } };
const speaker = new AnnouncerVoice(audio, cue => loaded ? { cue, duration: 2 } : null, {
  schedule(fn, ms) { assert.equal(ms, ANNOUNCER_COALESCE_MS); timers.set(++timerId, fn); return timerId; },
  cancel(id) { timers.delete(id); }, hidden: () => hidden,
});
const flush = () => { const work = [...timers.values()]; timers.clear(); work.forEach(fn => fn()); };
speaker.play('doublekill'); speaker.play('triplekill'); speaker.play('doublekill');
assert.equal(timers.size, 1);
flush();
assert.equal(sources.length, 1);
assert.equal(sources[0].buffer.cue, 'triplekill', 'a same-tick blast speaks only the highest multikill');
assert.equal(gains[0].connections[0], audio.bus, 'speech shares master volume and limiter');
assert.ok(gains[0].gain.events.some(e => e[1] === ANNOUNCER_GAIN));
speaker.play('ultrakill'); flush();
assert.equal(sources[0].stopped, true, 'a higher call replaces rather than overlaps the current one');
sources[0].onended();
assert.equal(speaker.voice.source, sources[1], 'late onended cannot clear the replacement');
speaker.play('doublekill'); flush();
assert.equal(sources.length, 2, 'a lower call cannot cut off a stronger one');
speaker.play('monsterkill'); speaker.stop(); flush();
assert.equal(sources.length, 2, 'death or leave cancels the pending call');
assert.equal(sources[1].stopped, true);
ctx.state = 'suspended';
assert.equal(speaker.play('doublekill'), false);
ctx.state = 'running'; flush();
assert.equal(sources.length, 2, 'unlock never replays stale speech');
hidden = true; assert.equal(speaker.play('doublekill'), false);
hidden = false; speaker.play('doublekill'); hidden = true; flush();
assert.equal(sources.length, 2, 'a hidden tab cannot start a pending call');
hidden = false; loaded = false; assert.equal(speaker.play('doublekill'), false);
loaded = true;
for (const invalid of ['constructor', '__proto__', '../other.wav', null, undefined]) {
  assert.equal(speaker.play(invalid), false, 'unknown cue IDs cannot load arbitrary audio');
}
speaker.stop();

const source = JSON.parse(readFileSync(new URL('../public/assets/audio/announcer/quake/sources.json', import.meta.url)));
assert.deepEqual(source.clips.map(c => c.id), Object.keys(ANNOUNCER_CUES));
for (const clip of source.clips) {
  const url = BUILTIN_SAMPLE_MANIFEST[`announcer.${clip.id}`];
  assert.equal(url, `/assets/audio/announcer/quake/${clip.id}.wav`);
  const bytes = readFileSync(new URL(`../public${url}`, import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), clip.sha256,
    `${clip.id} is the unmodified classic recording`);
}
console.log('Quake announcer: authoritative combos/streaks, lifecycle, dedupe, local routing, bounded playback and 7 original hashes passed.');

// ---------------------------------------------------------------- Conquest objective calls
const objectiveIds = [...OBJECTIVE_FLAG_IDS.flatMap(id => [`captured_${id}`, `lost_${id}`, `under_attack_${id}`]), 'tickets_low', 'victory', 'defeat'];
assert.deepEqual(Object.keys(OBJECTIVE_CUES).sort(), objectiveIds.sort(), 'captured/lost/under_attack per flag plus tickets_low, victory, defeat');
const lowestMultikill = Math.min(...Object.values(ANNOUNCER_CUES).map(c => c.priority));
for (const [cue, info] of Object.entries(OBJECTIVE_CUES)) {
  assert.ok(info.priority < lowestMultikill, `${cue} ranks below every multikill call`);
  assert.equal(announcerCueInfo(cue), info);
  assert.equal(objectiveCueUrl(cue), `/assets/audio/announcer/objective/${cue}.wav`);
}
assert.equal(objectiveCueUrl('../quake/godlike'), null, 'objective URLs are whitelisted');
assert.equal(announcerCueInfo('__proto__'), null);

// Offline-synthesized WAVs: one per cue, RIFF/WAVE PCM, hashes pinned, no cloud voice service.
const objectiveSource = JSON.parse(readFileSync(new URL('../public/assets/audio/announcer/objective/sources.json', import.meta.url)));
assert.match(objectiveSource.method, /macOS say/); assert.doesNotMatch(JSON.stringify(objectiveSource), /eleven/i, 'no ElevenLabs assets');
assert.deepEqual(objectiveSource.clips.map(c => c.id).sort(), objectiveIds.sort());
for (const clip of objectiveSource.clips) {
  const bytes = readFileSync(new URL(`../public${objectiveCueUrl(clip.id)}`, import.meta.url));
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF'); assert.equal(bytes.toString('ascii', 8, 12), 'WAVE');
  assert.equal(bytes.readUInt16LE(20), 1, `${clip.id} is PCM`);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), clip.sha256, `${clip.id} matches its synthesis record`);
  assert.ok(bytes.length < 200_000, `${clip.id} stays small`);
}

// Events map 1:1 to calls and stingers for the local team.
const objectiveEvents = [
  [{ kind: 'flag_captured', flag: 'C', team: 'alpha' }, 'alpha', null, 'captured_C', 'captured'],
  [{ kind: 'flag_captured', flag: 'C', team: 'bravo' }, 'alpha', null, null, null],
  [{ kind: 'flag_neutralized', flag: 'B', team: 'bravo', prev: 'alpha' }, 'alpha', 'alpha', 'lost_B', 'lost'],
  [{ kind: 'flag_neutralized', flag: 'D', team: 'alpha', prev: 'bravo' }, 'alpha', 'bravo', null, 'neutralized'],
  [{ kind: 'flag_state', flag: 'A', state: 'neutralizing', team: 'bravo' }, 'alpha', 'alpha', 'under_attack_A', null],
  [{ kind: 'flag_state', flag: 'A', state: 'contested', team: null }, 'alpha', 'alpha', 'under_attack_A', null],
  [{ kind: 'flag_state', flag: 'D', state: 'neutralizing', team: 'alpha' }, 'alpha', 'bravo', null, 'capture_start'],
  [{ kind: 'flag_state', flag: 'C', state: 'capturing', team: 'alpha' }, 'alpha', null, null, 'capture_start'],
  [{ kind: 'flag_state', flag: 'B', state: 'restoring', team: 'alpha' }, 'alpha', 'alpha', null, null],
  [{ kind: 'ticket_low', team: 'alpha', tickets: 75 }, 'alpha', null, 'tickets_low', 'ticket_low'],
  [{ kind: 'ticket_low', team: 'bravo', tickets: 75 }, 'alpha', null, null, null],
];
for (const [ev, team, owner, cue, stinger] of objectiveEvents) {
  assert.equal(objectiveAnnouncerCue(ev, team, owner), cue, `${ev.kind} ${ev.flag ?? ''} call`);
  assert.equal(stingerForEvent(ev, team), stinger, `${ev.kind} ${ev.flag ?? ''} stinger`);
}
assert.equal(matchEndCue('alpha', 'alpha'), 'victory'); assert.equal(matchEndCue('alpha', 'bravo'), 'defeat'); assert.equal(matchEndCue(null, 'alpha'), null);
assert.deepEqual(Object.keys(STINGER_SCORES).sort(), [...OBJECTIVE_STINGERS].sort());

// Live wiring with a fake WebAudio graph: stingers through primitives, calls through the shared announcer voice.
const started = [];
const fakeParam = () => ({ value: 0, setValueAtTime() { return this; }, linearRampToValueAtTime() { return this; },
  exponentialRampToValueAtTime() { return this; }, setTargetAtTime() { return this; }, cancelScheduledValues() { return this; } });
const fakeNode = kind => ({ kind, frequency: fakeParam(), gain: fakeParam(), Q: fakeParam(), detune: fakeParam(), playbackRate: fakeParam(),
  connect(target) { return target; }, disconnect() {}, start(at) { started.push([kind, at]); }, stop() {} });
const objectiveCtx = new Proxy({ state: 'running', currentTime: 5, sampleRate: 22050, destination: fakeNode('destination'),
  decodeAudioData: async () => ({ duration: 1.4 }) }, {
  get(target, key) {
    if (key in target) return target[key];
    if (typeof key === 'string' && key.startsWith('create')) return () => fakeNode(key);
    return undefined;
  },
});
const objectiveEngine = { ctx: objectiveCtx, bus: fakeNode('bus'), noiseBuffer: { duration: 1 }, get now() { return objectiveCtx.currentTime; } };
const spoken = [];
const objectiveVoice = new AnnouncerVoice(objectiveEngine, () => null, { schedule: fn => { fn(); return 1; }, cancel() {}, hidden: () => false });
const realPlay = objectiveVoice.play.bind(objectiveVoice);
objectiveVoice.play = cue => { spoken.push(cue); return realPlay(cue); };
const fetched = [];
const cues = createObjectiveCues({ audioContext: objectiveEngine, announcer: objectiveVoice, hidden: () => false,
  fetchImpl: async url => { fetched.push(url); return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) }; } });
assert.equal(await cues.ready, objectiveIds.length, 'every objective WAV decodes and registers once');
assert.equal(fetched.length, objectiveIds.length);
assert.equal(objectiveVoice.play('captured_C'), true, 'registered objective buffers are playable');
spoken.length = 0;
cues.syncMatch({ mode: 'conquest', phase: 'live', conquest: { flags: [['A', 100, 'alpha', 'idle', 0, 0], ['D', -100, 'bravo', 'idle', 0, 0]] } }, 'alpha');
assert.deepEqual(cues.handleEvent({ kind: 'flag_state', flag: 'A', state: 'neutralizing', team: 'bravo' }, 'alpha'), { stinger: null, cue: 'under_attack_A' });
assert.deepEqual(cues.handleEvent({ kind: 'flag_neutralized', flag: 'A', team: 'bravo', prev: 'alpha' }, 'alpha'), { stinger: 'lost', cue: 'lost_A' });
assert.deepEqual(cues.handleEvent({ kind: 'flag_state', flag: 'A', state: 'capturing', team: 'bravo' }, 'alpha'), { stinger: null, cue: null },
  'a neutral flag the enemy captures is no longer ours: silent');
assert.deepEqual(cues.handleEvent({ kind: 'flag_captured', flag: 'D', team: 'alpha' }, 'alpha'), { stinger: 'captured', cue: 'captured_D' });
assert.deepEqual(cues.played, ['lost', 'captured'], 'stingers rendered through the primitives');
assert.ok(started.some(([kind]) => kind === 'createOscillator'), 'stinger tones started');
cues.syncMatch({ mode: 'conquest', phase: 'post', winner: 'alpha', conquest: { endsAt: 9, flags: [] } }, 'alpha');
cues.syncMatch({ mode: 'conquest', phase: 'post', winner: 'alpha', conquest: { endsAt: 9, flags: [] } }, 'alpha');
assert.deepEqual(cues.played, ['lost', 'captured', 'victory'], 'match end plays once');
assert.deepEqual(spoken, ['under_attack_A', 'lost_A', 'captured_D', 'victory']);
// Repeats are damped: capture start only inside the zone and once per window; under attack once per window.
{
  let clock = 0;
  const gated = createObjectiveCues({ audioContext: objectiveEngine, announcer: objectiveVoice, hidden: () => false, now: () => clock,
    fetchImpl: async () => ({ ok: false }) });
  const flagC = FRONTIER_PLAN.flags.find(f => f.id === 'C');
  const live = { mode: 'conquest', phase: 'live', conquest: { flags: [['A', 100, 'alpha', 'idle', 0, 0]] } };
  const start = { kind: 'flag_state', flag: 'C', state: 'capturing', team: 'alpha' };
  assert.equal(gated.handleEvent(start, 'alpha').stinger, 'capture_start', 'no self row yet: no zone gate');
  gated.syncMatch(live, 'alpha', { state: 'alive', x: flagC.x + flagC.radius + 150, z: flagC.z });
  clock = 10_000;
  assert.equal(gated.handleEvent(start, 'alpha').stinger, null, 'a teammate capturing elsewhere is silent');
  gated.syncMatch(live, 'alpha', { state: 'alive', x: flagC.x + 3, z: flagC.z });
  assert.equal(gated.handleEvent(start, 'alpha').stinger, 'capture_start', 'inside the zone');
  clock += 1000;
  assert.equal(gated.handleEvent(start, 'alpha').stinger, null, 'capturing → contested → capturing inside the window');
  clock += CAPTURE_START_REPEAT_MS;
  assert.equal(gated.handleEvent(start, 'alpha').stinger, 'capture_start');
  gated.syncMatch(live, 'alpha', { state: 'dead', x: flagC.x, z: flagC.z });
  clock += CAPTURE_START_REPEAT_MS;
  assert.equal(gated.handleEvent(start, 'alpha').stinger, null, 'a dead player hears no capture start');
  const attack = { kind: 'flag_state', flag: 'A', state: 'neutralizing', team: 'bravo' };
  assert.equal(gated.handleEvent(attack, 'alpha').cue, 'under_attack_A');
  clock += 2000;
  assert.equal(gated.handleEvent({ kind: 'flag_state', flag: 'A', state: 'contested', team: null }, 'alpha').cue, null,
    'an oscillating flag_state is not announced again');
  clock += UNDER_ATTACK_REPEAT_MS;
  assert.equal(gated.handleEvent(attack, 'alpha').cue, 'under_attack_A');
  assert.equal(gated.handleEvent({ kind: 'flag_neutralized', flag: 'A', team: 'bravo', prev: 'alpha' }, 'alpha').cue, 'lost_A',
    'transitions are never damped');
  gated.dispose();
}
cues.dispose();
assert.equal(cues.handleEvent({ kind: 'flag_captured', flag: 'C', team: 'alpha' }, 'alpha'), null, 'disposed cues stay silent');
// A multikill call is never cut off by an objective call.
objectiveVoice.stop();
const order = [];
const voice2 = new AnnouncerVoice(objectiveEngine, cue => ({ cue, duration: 2 }), { schedule: fn => { order.push('sched'); fn(); return 1; }, cancel() {}, hidden: () => false });
voice2.play('doublekill');
assert.equal(voice2.voice.priority, ANNOUNCER_CUES.doublekill.priority);
voice2.play('captured_A');
assert.equal(voice2.voice.priority, ANNOUNCER_CUES.doublekill.priority, 'objective call waits behind the multikill');
voice2.stop();
console.log(`Conquest objective audio: ${objectiveIds.length} offline calls (pinned WAVs), 1:1 event mapping, stingers and priority below multikill passed.`);
