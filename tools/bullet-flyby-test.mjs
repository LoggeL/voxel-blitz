import assert from 'node:assert/strict';
import { closestBulletFlyby, BULLET_FLYBY_RADIUS } from '../public/js/combat/bullet-flyby.js';
import { CombatFeedback } from '../public/js/combat/feedback.js';
import { PlayerEntity } from '../server/sim/player.js';
import { fireOneShot } from '../server/sim/combat.js';
import { WEAPON_IDS } from '../shared/combatmath.js';

const listener = { x: 0, y: 2, z: 0 };
const segment = (x, start = -10, end = 10) => ({ o: [x, 2, start], end: [x, 2, end] });
const pass = closestBulletFlyby([[segment(1)]], listener);
assert.deepEqual(pass.pos, [1, 2, 0]);
assert.equal(pass.distance, 1);
assert.equal(closestBulletFlyby([[segment(1, -10, -1)]], listener), null, 'a stopped ray cannot fly past a listener beyond it');
assert.equal(closestBulletFlyby([[segment(1, 1, 10)]], listener), null, 'a shot moving away cannot fly past us');
assert.equal(closestBulletFlyby([[segment(BULLET_FLYBY_RADIUS)]], listener), null);
assert.ok(closestBulletFlyby([[segment(BULLET_FLYBY_RADIUS - 0.001)]], listener).volume < 0.001, 'gain fades to silence at radius');
const gains = [0, 0.5, 1, 1.5, 2, BULLET_FLYBY_RADIUS - 0.001]
  .map((distance) => closestBulletFlyby([[segment(distance)]], listener).volume);
assert.ok(gains.every((gain, i) => i === 0 || gain < gains[i - 1]), 'farther passes are consistently quieter');
assert.ok(gains[4] < gains[1] / 50, 'a 2 m pass is strongly attenuated compared with a 0.5 m pass');
const nearRuntime = harness();
const farRuntime = harness();
for (const [h, distance] of [[nearRuntime, 0.5], [farRuntime, 2]]) {
  h.feedback.handleEvent({ kind: 'shoot', id: 'remote', w: 'rifle',
    o: [distance, 2, -10], d: [0, 0, 1], paths: [[segment(distance)]] });
}
assert.ok(farRuntime.calls[0][0] < nearRuntime.calls[0][0] / 50,
  'runtime passes the distance fade to the shared sound player');
assert.deepEqual(closestBulletFlyby([[segment(5), segment(-0.5)]], listener).pos, [-0.5, 2, 0], 'ricochet continuation uses its own direction');
assert.equal(closestBulletFlyby([[segment(1.5)], [segment(0.5)]], listener).distance, 0.5, 'closest shotgun pellet wins once');
assert.equal(closestBulletFlyby([[{ o: [0, 2, 0], end: [0, 2, 0] }, { o: [NaN, 2, 0], end: [1, 2, 0] }]], listener), null);

function harness({ block = 0, alive = true } = {}) {
  const calls = [];
  const feedback = new CombatFeedback({
    effects: { shoot() {}, confirmShot() {} },
    sfx: { fire() {}, bulletWhiz: (...args) => calls.push(args) },
    getMyId: () => 'local', isRunning: () => true,
    player: { alive }, camera: { position: listener }, world: { getBlock: () => block },
  });
  return { feedback, calls };
}
const shot = { kind: 'shoot', id: 'remote', w: 'rifle', o: [1, 2, -10], d: [0, 0, 1], paths: [[segment(1)]] };
const { feedback, calls } = harness();
feedback.handleEvent(shot);
assert.equal(calls.length, 1);
assert.deepEqual(calls[0], [pass.volume, { pos: [1, 2, 0] }], 'runtime sends actual near-ear world position');
feedback.handleEvent(shot);
assert.equal(calls.length, 1, 'rapid fire is rate limited');
feedback._lastBulletFlybyAt -= 120;
feedback.handleEvent({ ...shot, paths: [[segment(-1)]] });
assert.deepEqual(calls[1][1].pos, [-1, 2, 0], 'next eligible pass moves to the correct side');
for (const ev of [
  { ...shot, id: 'local' }, { ...shot, hitVictims: ['local'] },
  { ...shot, paths: undefined }, { ...shot, paths: [[segment(1, -10, -1)]] },
  ...['rocket', 'longarc', 'knife', 'flamethrower'].map((w) => ({ ...shot, w })),
]) {
  const h = harness(); h.feedback.handleEvent(ev);
  assert.equal(h.calls.length, 0, `excluded shot ${ev.w}, ${ev.id}, ${JSON.stringify(ev.hitVictims)}`);
}
for (const opts of [{ block: 1 }, { alive: false }]) {
  const h = harness(opts); h.feedback.handleEvent(shot);
  assert.equal(h.calls.length, 0, 'cover and dead listener suppress flybys');
}
for (const offset of [0, 0.8]) {
  const owner = new PlayerEntity('remote', 'remote', { x: 20.5, y: 10, z: 40.5 }, false);
  const target = new PlayerEntity('local', 'local', { x: 20.5 + offset, y: 10, z: 30.5 }, false);
  owner.yaw = 0; owner.pitch = 0; owner.weapon = WEAPON_IDS.indexOf('rifle');
  owner.spawnProtectedUntil = target.spawnProtectedUntil = 0;
  const events = [];
  fireOneShot(owner, { now: 1000, entities: new Map([['remote', owner], ['local', target]]),
    solidAt: () => false, getBlock: () => 0, blockHp: new Map(),
    canDamage: () => true, computeConeDeg: () => 0, pushEvent: (ev) => events.push(ev),
    canAffectWorld: () => true, killPlayer: (v) => { v.state = 'dead'; },
    setBlock() {}, pushBlockDelta() {}, destroyBlock: () => false });
  const resolved = events.find((ev) => ev.kind === 'shoot');
  assert.ok(resolved.paths?.length, 'server publishes actual shot segments');
  assert.equal(resolved.hitVictims?.includes('local') ?? false, offset === 0,
    'server publishes direct-hit exclusion only when the shot hits');
}
console.log('Bullet flybys: finite paths, ricochets, pellets, distance fade, spatial position, cooldown, cover, own shots and hit exclusions passed.');
