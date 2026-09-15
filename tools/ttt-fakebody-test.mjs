import assert from 'node:assert/strict';
import { GameEngine } from '../server/game.js';
import { isTttRequest } from '../shared/ttt.js';

const game = new GameEngine({ mode: 'ttt' });
for (const id of ['a', 'b', 'c', 'd']) game.addClient(id, id);
const policy = game.mode.policy;
game.now = policy.phaseEndsAt; game.mode.tick();
const p = game.entities.get('a'), enemy = game.entities.get('b');
policy.roles.set('a', 'traitor'); for (const id of ['b', 'c', 'd']) policy.roles.set(id, 'innocent');
policy.wallets.set('a', 10);

assert.equal(isTttRequest('ttt:fakebody'), true);
assert.equal(isTttRequest('ttt:fakebody-place'), true);
assert.equal(policy.buy(enemy, 'ttt:fakebody'), false, 'innocents cannot buy the fake body');
assert.equal(policy.buy(p, 'ttt:fakebody'), true);
assert.equal(policy.buy(p, 'ttt:fakebody'), false, 'one charge per round rejects duplicates');
assert.equal(policy.privateState('a').equipment.includes('fakebody'), true);
assert.equal(policy.privateState('a').fakeBodies, 1);
assert.equal(policy.privateState('a').credits, 9);

// Solid floor pads like the teleporter tests use.
for (const x of [20, 30]) for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) for (let y = 14; y <= 18; y++) game.world.setBlock(x + dx, y, 20 + dz, y === 14 ? 1 : 0);
Object.assign(p, { x: 20.5, y: 15, z: 20.5, yaw: 1.2, grounded: false });
assert.equal(policy.buy(p, 'ttt:fakebody-place'), false, 'midair placement is rejected');
p.grounded = true;
p.vault = { elapsed: 0.1 };
assert.equal(policy.buy(p, 'ttt:fakebody-place'), false, 'vaulting placement is rejected');
p.vault = null;
assert.equal(policy.buy(p, 'ttt:fakebody-place'), true);
assert.equal(policy.privateState('a').fakeBodies, 0, 'placement consumes the charge');
assert.equal(policy.corpses.size, 1);
const fake = [...policy.corpses.values()][0];
assert.ok(/^[0-9]+$/.test(fake.id), 'fake id stays numeric so inspect keeps working');
assert.equal(fake.playerId, 'a');
assert.equal(fake.name, p.name);
assert.equal(fake.role, 'innocent', 'the planted body reads innocent, never traitor');
assert.equal(fake.fake, true);
assert.equal(fake.identified, false);
assert.equal(fake.x, p.x);

// Unidentified wire shape: indistinguishable from a real body.
let snap = policy.matchSnapshot();
let row = snap.corpses.find(b => b.id === fake.id);
assert.equal(row.fake, undefined);
assert.equal(row.name, undefined);
assert.equal(row.role, undefined);

// Identification reports the traitor as innocent and flags the fake for the scoreboard filter.
Object.assign(enemy, { x: 21.5, y: 15, z: 20.5 });
assert.equal(policy.buy(enemy, `ttt:inspect:${fake.id}`), true);
assert.equal(fake.identified, true);
snap = policy.matchSnapshot();
row = snap.corpses.find(b => b.id === fake.id);
assert.equal(row.role, 'innocent');
assert.equal(row.name, p.name);
assert.equal(row.fake, true, 'scoreboard excludes flagged bodies from death/role confirmation');
// Same predicate the scoreboard uses: the planter stays unconfirmed.
const identified = new Map(snap.corpses.filter(b => b.identified && b.playerId != null && !b.fake).map(b => [String(b.playerId), b]));
assert.equal(identified.has('a'), false);
assert.equal(p.state, 'alive', 'planting never kills the planter');

// Re-planting replaces the old fake instead of stacking bodies.
policy.equipment.players.get('a').fakeBodies = 1;
p.x = 30.5; p.z = 20.5;
assert.equal(policy.buy(p, 'ttt:fakebody-place'), true);
assert.equal(policy.corpses.size, 1, 're-plant replaces the previous fake');
assert.equal([...policy.corpses.values()][0].x, 30.5);

// A genuine death replaces the fake so the real corpse is never suppressed.
assert.equal(policy.onPlayerDeath(p, enemy, { weapon: 'rifle' }), true);
assert.equal(policy.corpses.size, 1);
const real = [...policy.corpses.values()][0];
assert.equal(real.fake, undefined);
assert.equal(real.role, 'traitor');
assert.equal(real.playerId, 'a');

console.log('TTT fake body: traitor-only purchase, placement gates, innocent-on-inspect wire, scoreboard-neutral flag, death replacement passed.');
