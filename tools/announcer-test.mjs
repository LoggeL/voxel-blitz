import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { GameEngine } from '../server/game.js';
import { AnnouncerVoice, ANNOUNCER_GAIN, ANNOUNCER_COALESCE_MS } from '../public/js/audio/announcer.js';
import { CombatFeedback } from '../public/js/combat/feedback.js';
import { BUILTIN_SAMPLE_MANIFEST } from '../public/js/audio/samples.js';
import { ANNOUNCER_CUES, MULTIKILL_WINDOW_MS } from '../shared/announcer.js';
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
