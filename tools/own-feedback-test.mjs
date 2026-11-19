// Own-feedback contract: local shot confirmations, hit markers and kills leave the
// snapshot ring the frame they arrive, everything else waits for the
// presentation delay, and every event is still delivered exactly once.
import assert from 'node:assert/strict';
import {
  NetClient, RING_LEN,
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
const shot = { kind: 'shoot', id: me, w: 'rifle', paths: [[{ o: [0, 2, 0], end: [0, 2, -3] }]] };
const launch = { kind: 'shoot', id: me, w: 'sniper', roundId: 35 };
const impact = { ...shot, kind: 'bullet', w: 'sniper', roundId: 35, seq: 350 };
for (const event of [shot, launch, impact]) assert.ok(isOwnFeedbackEvent(event, me));
for (const event of [{ ...shot, id: 'p2' }, { ...shot, vehicleId: 'tank' },
  { ...shot, chaosArc: true }, { ...shot, chaosFlame: true }, { kind: 'shoot', id: me, w: 'rocket' }]) {
  assert.equal(isOwnFeedbackEvent(event, me), false, 'remote, mounted, ability and projectile fire keep delayed presentation');
}

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

// Use the actual receipt and presentation paths. A late render loses most world
// events in an evicted snapshot, but keeps the original event indices of our shots.
const client = new NetClient();
client.id = me;
let tickNumber = 0;
const tick = (events = []) => client._onTick({ t: 'tick', now: ++tickNumber * 17, events });
const fillRing = () => { for (let i = 0; i < RING_LEN; i++) tick(); };
const frame = (delay = 200) => client.interpolate(client.latestSnapshots.at(-1).now, delay).events;
const dispatched = [];
client.on('shoot', (event) => dispatched.push(event));
tick([launch]);
assert.deepEqual(frame(), [launch], 'accepting a launched round does not wait for interpolation');
tick([theirs, shot, impact]);
fillRing();
const newer = { ...shot, seq: 351 };
const mounted = { ...shot, seq: 352, vehicleId: 'tank' };
tick([newer, impact, mounted]);
assert.deepEqual(frame(), [shot, impact, newer], 'evicted and buffered confirmations arrive in order without repeats');
assert.deepEqual(frame(), []);
assert.deepEqual(frame(0), [mounted], 'the mounted shot is presented on the world clock');
assert.deepEqual(dispatched, [launch, shot, newer, mounted], 'listeners receive each confirmation once');
tick([shot]); fillRing();
assert.deepEqual(client.interpolate(client.latestSnapshots.at(-1).now + 60_000, 0).events, [],
  'a long suspension does not replay stale hit effects');
tick([shot]); fillRing();
client._resetSessionState(false);
client.id = me; tick();
assert.deepEqual(frame(), [], 'reusing the client clears the previous session backlog');
for (let i = 0; i < 300; i++) tick([{ ...shot, seq: 1000 + i }]);
const backlog = frame();
assert.ok(backlog.length >= RING_LEN && backlog.length < 300, 'retention has a hard bound');
assert.equal(backlog.at(-1).seq, 1299, 'the newest accepted shot wins on overflow');
assert.equal(new Set(backlog.map((event) => event.seq)).size, backlog.length);
assert.deepEqual(frame(0), []);
console.log('ok - own feedback: early local confirmations, bounded overflow recovery, delayed world events and exactly-once delivery');
