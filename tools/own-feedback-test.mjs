// Own-feedback contract: the local player's hit markers and kills leave the
// snapshot ring the frame they arrive, everything else waits for the
// presentation delay, and every event is still delivered exactly once.
import assert from 'node:assert/strict';
import {
  drainEventsWithDedupe,
  drainOwnEventsEarly,
  isOwnFeedbackEvent,
} from '../public/js/engine/netclient.js';

const me = 'p1';
const mine = { kind: 'hit', attacker: me, victim: 'p2', dmg: 30 };
const theirs = { kind: 'hit', attacker: 'p2', victim: 'p3', dmg: 30 };
const onMe = { kind: 'hit', attacker: 'p2', victim: me, dmg: 30 };
const myKill = { kind: 'kill', killer: me, victim: 'p2', w: 'rifle' };
const suicide = { kind: 'kill', killer: me, victim: me, w: 'grenade' };
const death = { kind: 'die', id: 'p2' };

assert.equal(isOwnFeedbackEvent(mine, me), true, 'own hit is own feedback');
assert.equal(isOwnFeedbackEvent(myKill, me), true, 'own kill is own feedback');
assert.equal(isOwnFeedbackEvent(theirs, me), false, 'other hits wait');
assert.equal(isOwnFeedbackEvent(onMe, me), false, 'damage taken keeps its snapshot order');
assert.equal(isOwnFeedbackEvent(suicide, me), false, 'self kills keep their snapshot order');
assert.equal(isOwnFeedbackEvent(death, me), false, 'deaths keep their snapshot order');
assert.equal(isOwnFeedbackEvent(mine, null), false, 'no identity, nothing early');

// Snapshot 3 just arrived at local time 300 while presentation sits at 220.
const ring = [
  { now: 100, snapSeq: 1, events: [theirs] },
  { now: 200, snapSeq: 2, events: [mine, death] },
  { now: 300, snapSeq: 3, events: [myKill, onMe, { kind: 'hit', attacker: me, victim: 'p4', seq: 41 }] },
];
const state = { seen: new Set(), seq: -1, snapSeq: -1 };

const early = drainOwnEventsEarly(ring, me, state);
assert.deepEqual(early.map((event) => event.kind + ':' + (event.victim)), ['hit:p2', 'kill:p2', 'hit:p4'],
  'own feedback from every received snapshot surfaces immediately');
const delayed = drainEventsWithDedupe(ring, 220, state);
assert.deepEqual(delayed, [theirs, death], 'the delayed pass skips already-delivered own feedback and holds future snapshots');

const earlyAgain = drainOwnEventsEarly(ring, me, state);
assert.equal(earlyAgain.length, 0, 'own feedback is never delivered twice');
const later = drainEventsWithDedupe(ring, 300, state);
assert.deepEqual(later, [onMe], 'once presentation reaches snapshot 3 only the remaining events are delivered');
assert.equal(drainEventsWithDedupe(ring, 300, state).length, 0, 'repeated frames deliver nothing new');

// A snapshot arriving after the watermark advanced still surfaces own feedback once.
ring.push({ now: 400, snapSeq: 4, events: [{ kind: 'kill', killer: me, victim: 'p5', w: 'smg' }, theirs] });
assert.deepEqual(drainOwnEventsEarly(ring, me, state).map((event) => event.victim), ['p5'], 'later snapshots keep surfacing own kills early');
assert.deepEqual(drainEventsWithDedupe(ring, 400, state), [theirs], 'and their remaining events arrive with the delayed pass');

console.log('ok - own feedback: early hit/kill delivery, delayed world events, exactly-once across both passes');
