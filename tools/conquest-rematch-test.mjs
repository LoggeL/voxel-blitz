// Conquest rematch: the continuation vote restores tickets, home-flag ownership,
// the clock, squads, hulls and counters, and every player stands at HQ again.
import assert from 'node:assert/strict';
import { GameEngine } from '../server/game.js';
import { TICK_MS } from '../server/protocol/admission.js';
import { VEHICLE_RULES } from '../shared/vehicles.js';
import { CONQUEST_RULES, decodeConquestPlayer, decodeConquestStats } from '../shared/conquest-contract.js';

const spot = (x, z) => ({ x: x + 0.5, y: 2, z: z + 0.5 });
const hq = (team, x) => ({ id: team, name: team, ...spot(x, 64), radius: 10, spawns: [spot(x, 60), spot(x, 64), spot(x, 68)] });
const bases = { alpha: hq('alpha', 6), bravo: hq('bravo', 121) };
const spawns = [{ id: 'tank', team: 'alpha', type: 'tank', x: 20, y: 2, z: 30, yaw: 0 }];
const mapMeta = { id: 'frontier', dimensions: { sx: 128, sy: 32, sz: 128 },
  spawns: { conquest: { alpha: bases.alpha.spawns, bravo: bases.bravo.spawns } },
  conquest: { version: 2, bases, combatArea: { minX: 1, maxX: 126, minZ: 1, maxZ: 126 }, vehicleSpawns: spawns,
    flags: [{ id: 'A', x: 40, y: 2, z: 40, radius: 10, home: 'alpha', spawns: [spot(40, 46)] },
      { id: 'C', x: 64, y: 2, z: 64, radius: 10, home: null, spawns: [spot(64, 70)] },
      { id: 'E', x: 90, y: 2, z: 90, radius: 10, home: 'bravo', spawns: [spot(90, 84)] }] } };
const world = { dimensions: { sx: 128, sy: 32, sz: 128 }, getBlock: (_x, y) => (y < 2 ? 1 : 0), findSpawns: () => [spot(20, 20)], setBlock: () => {} };
let last = null;
const game = new GameEngine({ mode: 'conquest', mapMeta, world, broadcast: snap => { last = snap; } });
const run = ms => { for (let t = 0; t < ms - 1e-6; t += TICK_MS) game.step(TICK_MS); };
game.addClient('a', 'Alpha'); game.addClient('b', 'Bravo');
const a = game.entities.get('a'), b = game.entities.get('b');
const policy = game.mode.policy;
const startEndsAt = policy.ledger.endsAt;

// Play: capture C, seat and damage the tank, score, then bleed bravo out.
Object.assign(a, { x: 64.5, z: 64.5 });
run(8200);
assert.equal(policy.flags[1].owner, 'alpha');
Object.assign(a, { x: 20, y: 2, z: 30 });
assert(game.vehicles.enter(a, 'tank'));
const v = game.vehicles.vehicles.get('tank');
Object.assign(v, { hp: 100, x: 24, z: 35, speed: 7 });
assert(a.score > 0);
game.killPlayer(b, a, 'rifle', false);
assert(game.mode.conquestIntent(b, { type: 'deploy', spawn: 'flag:E', kit: 'recon', variant: 1 }));
// Terrain wear (cracked voxels here; removed voxels go through the same
// restoreWorld) must not carry into the rematch.
let restores = 0;
const restoreWorld = game.restoreWorld.bind(game);
game.restoreWorld = () => { restores++; return restoreWorld(); };
game.blockDamage.set('40,1,46', { x: 40, y: 1, z: 46, progress: 0.6 });
game.blockHp.set('40,1,46', 10);
policy.ledger.tickets.bravo = 1;
run(CONQUEST_RULES.respawnMs + 100);
game.killPlayer(b, a, 'rifle', false);
run(TICK_MS);
assert.equal(game.mode.phase, 'post');
assert.equal(game.mode.matchWinner, 'alpha');
assert(Array.isArray(last.match.conquest.ticketGraph), 'the post-match snapshot carries the ticket graph');
const vote = last.match.continuation;
assert(game.mode.approveContinuation('a', vote.id));
run(5000 + 2 * TICK_MS);

assert.equal(game.mode.phase, 'live');
const match = last.match.conquest;
assert.deepEqual(match.tickets, { alpha: CONQUEST_RULES.tickets, bravo: CONQUEST_RULES.tickets }, 'tickets are restored');
assert.deepEqual(match.bleed, { alpha: 0, bravo: 0 });
assert.deepEqual(match.flags.map(([id, control, owner, state]) => [id, control, owner, state]),
  [['A', 100, 'alpha', 'idle'], ['C', 0, null, 'idle'], ['E', -100, 'bravo', 'idle']], 'home flags owned, C neutral again');
assert(!('ticketGraph' in match), 'the graph belongs to the finished match only');
assert(policy.ledger.endsAt > startEndsAt && Math.abs(match.endsAt - (game.now + CONQUEST_RULES.timeLimitMs)) < 6000, 'the 20-minute clock restarts');
assert.equal(policy.ledger.graph.length, 1, 'a fresh ticket graph');
assert.deepEqual(match.squads, [['alpha', 1, 'a'], ['bravo', 1, 'b']], 'squads persist across the rematch');
assert.equal(restores, 1, 'the rematch restores the world once');
assert.equal(game.blockDamage.size, 0, 'block damage is restored'); assert.equal(game.blockHp.size, 0);
assert.equal(game.changedBlocks.size, 0);
const fresh = game.vehicles.vehicles.get('tank');
assert.equal(fresh.hp, VEHICLE_RULES.tank.hp);
assert.equal(fresh.x, 20); assert.equal(fresh.z, 30); assert.equal(fresh.speed, 0); assert.equal(fresh.occupantId, null);
for (const p of game.entities.values()) {
  assert.equal(p.vehicleId, null);
  assert.equal(p.state, 'alive');
  assert.equal(p.kills, 0); assert.equal(p.deaths, 0); assert.equal(p.score, 0);
  assert(policy.hqPool(p).some(s => Math.hypot(s.x - p.x, s.z - p.z) < 0.01), `${p.id} restarts at HQ`);
  const row = last.players.find(r => r.id === p.id);
  assert.deepEqual(decodeConquestStats(row), { objective: 0, vehicles: 0, revives: 0, captures: 0 });
  assert.equal(decodeConquestPlayer(row).restrictedMs, 0);
}
assert.equal(decodeConquestPlayer(last.players.find(r => r.id === 'b')).kit, 'recon', 'chosen kits survive the rematch');
assert.equal(policy.deploy.state('b').lastValid, null, 'remembered spawns do not');
console.log('Conquest rematch: continuation restores tickets, home-flag ownership, clock and graph, keeps squads and kits, resets counters, hulls and terrain, and restarts everyone at HQ.');
