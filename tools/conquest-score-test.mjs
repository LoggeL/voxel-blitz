// Conquest v2 score ledger: every SCORE_POINTS reason through its real source,
// exact points, one kill payout per kill, cqs counters and the score events.
import assert from 'node:assert/strict';
import { GameEngine } from '../server/game.js';
import { TICK_MS } from '../server/protocol/admission.js';
import { SCORE_POINTS, decodeConquestStats } from '../shared/conquest-contract.js';
import { VEHICLE_RULES } from '../shared/vehicles.js';

const SX = 200, SY = 32, SZ = 160;
const spot = (x, z) => ({ x: x + 0.5, y: 2, z: z + 0.5 });
const ring = (x, z) => Array.from({ length: 12 }, (_, i) => spot(x + Math.round(Math.cos(i * Math.PI / 6) * 6), z + Math.round(Math.sin(i * Math.PI / 6) * 6)));
const flagRow = (id, x, z, home) => ({ id, name: id, ...spot(x, z), radius: 10, home, spawns: ring(x, z) });

function fixture() {
  const hq = (team, x) => ({ id: team, name: team, ...spot(x, 80), radius: 12, spawns: [spot(x, 74), spot(x, 77), spot(x, 80), spot(x, 83), spot(x, 86)] });
  const bases = { alpha: hq('alpha', 8), bravo: hq('bravo', SX - 9) };
  const vehicleSpawns = [{ id: 'alpha-jeep', team: 'alpha', type: 'jeep', x: 30.5, y: 2, z: 30.5, yaw: 0 },
    { id: 'bravo-tank', team: 'bravo', type: 'tank', x: 170.5, y: 2, z: 30.5, yaw: 0 }];
  const mapMeta = { id: 'frontier', dimensions: { sx: SX, sy: SY, sz: SZ }, spawns: { conquest: { alpha: bases.alpha.spawns, bravo: bases.bravo.spawns } },
    conquest: { version: 2, bases, combatArea: { minX: 2, maxX: SX - 2, minZ: 2, maxZ: SZ - 2 }, vehicleSpawns,
      flags: [flagRow('A', 50, 40, 'alpha'), flagRow('B', 50, 120, 'alpha'), flagRow('C', 100, 80, null), flagRow('D', 150, 40, 'bravo'), flagRow('E', 150, 120, 'bravo')] } };
  const world = { dimensions: { sx: SX, sy: SY, sz: SZ }, getBlock: (x, y, z) => (x < 0 || z < 0 || x >= SX || z >= SZ || y < 2 ? 1 : 0),
    findSpawns: () => [spot(20, 20)], setBlock: () => {} };
  const events = [], log = [];
  const game = new GameEngine({ mode: 'conquest', mapMeta, world,
    broadcast: snap => { events.push(...snap.events); log.push(...snap.events); game.lastSnapshot = snap; } });
  return { game, events, log, policy: game.mode.policy };
}
const run = (game, ms) => { for (let t = 0; t < ms - 1e-6; t += TICK_MS) game.step(TICK_MS); };
const place = (p, x, z) => Object.assign(p, { x: x + 0.5, y: 2, z: z + 0.5, vx: 0, vy: 0, vz: 0 });
const scored = (events, id, reason) => events.filter(e => e.kind === 'score' && e.id === id && (!reason || e.reason === reason));
const pts = (events, id, reason) => scored(events, id, reason).reduce((s, e) => s + e.pts, 0);

const { game, events, log, policy } = fixture();
const ids = ['p1_a', 'p2_b', 'p3_a', 'p4_b', 'p5_a', 'p6_b', 'p7_a', 'p8_b'];
for (const id of ids) game.addClient(id, id);
const alpha = ids.map(id => game.entities.get(id)).filter(p => p.team === 'alpha');
const bravo = ids.map(id => game.entities.get(id)).filter(p => p.team === 'bravo');
const park = () => { alpha.forEach((p, i) => place(p, 6, 72 + i * 3)); bravo.forEach((p, i) => place(p, SX - 6, 72 + i * 3)); };
park();
run(game, TICK_MS);
const [a1, a2, a3, a4] = alpha;
const [b1, b2, b3] = bravo;
const reset = () => { events.length = 0; };
const revive = victim => { if (victim.state === 'dead') { game.respawnPlayer(victim, spot(SX - 6, 90 + Math.random() * 10)); game.mode.onPlayerRespawn(victim); } };

// Plain kill on open ground: exactly one payout of 100 and no double count.
reset();
place(b1, 80, 140);
let before = a1.score;
game.killPlayer(b1, a1, 'rifle', false);
run(game, TICK_MS);
assert.equal(a1.score - before, SCORE_POINTS.kill, 'a kill pays exactly kill points (killScoreDelta is 0)');
assert.equal(a1.kills, 1);
assert.deepEqual(scored(events, a1.id).map(e => [e.reason, e.pts]), [['kill', 100]], 'one score event per kill');

// Headshot and an assist by damage share. This emulates GameEngine.killPlayer
// with `headshot` in the mode context (a wiring request to server/game.js).
revive(b1); run(game, TICK_MS); reset();
place(b1, 80, 140);
b1.takeDamage(40, false, a2, 'smg');
before = a1.score;
b1.hp = 0; b1.state = 'dead'; b1.deaths++;
a1.kills++; a1.score += game.mode.killScoreDelta(b1, a1, { weapon: 'sniper', headshot: true });
game.mode.onPlayerDeath(b1, a1, { weapon: 'sniper', headshot: true });
game.tickEvents.push({ t: 'ev', kind: 'kill', killer: a1.id, victim: b1.id, w: 'sniper', hs: true });
run(game, TICK_MS);
assert.equal(pts(events, a1.id, 'kill'), 100);
assert.equal(pts(events, a1.id, 'headshot'), SCORE_POINTS.headshot, 'headshot bonus');
assert.equal(pts(events, a2.id, 'assist'), 40, '40 damage of 100 HP is a 40-point assist (50 per half life, 10..90)');
assert.equal(a1.score - before, 125);

// Assists clamp to 10..90 and expire after 10 s.
revive(b1); run(game, TICK_MS); reset();
place(b1, 80, 140);
b1.takeDamage(3, false, a2, 'smg');
b1.takeDamage(95, false, a3, 'lmg');
game.killPlayer(b1, a1, 'rifle', false);
run(game, TICK_MS);
assert.equal(pts(events, a2.id, 'assist'), 10, 'tiny assists pay the 10-point floor');
assert.equal(pts(events, a3.id, 'assist'), 90, 'large assists cap at 90');
revive(b1); run(game, TICK_MS); reset();
place(b1, 80, 140);
b1.takeDamage(30, false, a2, 'smg');
run(game, 10500);
game.killPlayer(b1, a1, 'rifle', false);
run(game, TICK_MS);
assert.equal(scored(events, a2.id, 'assist').length, 0, 'damage older than 10 s earns nothing');

// Attacker kill inside an enemy flag, defender kill inside an own flag.
revive(b1); run(game, TICK_MS); reset();
place(b1, 150, 42);
game.killPlayer(b1, a1, 'rifle', false);
revive(b2);
place(b2, 51, 41);
game.killPlayer(b2, a1, 'rifle', false);
run(game, TICK_MS);
assert.equal(pts(events, a1.id, 'attacker_kill'), 50, 'attacker kill at D');
assert.equal(pts(events, a1.id, 'defender_kill'), 50, 'defender kill at A');
revive(b1); revive(b2); park(); run(game, TICK_MS);

// Capture, capture assist, neutralize and defend through the capture zones.
reset();
place(a1, 100, 80); place(a2, 101, 81);
run(game, 2000);
place(a2, 6, 90);
run(game, 5500);
assert.equal(policy.flags[2].owner, 'alpha', '2 s at 1.5x plus 5 s at 1x');
assert.equal(pts(events, a1.id, 'capture'), 250, 'present at the capture');
assert.equal(pts(events, a2.id, 'capture_assist'), 100, 'helped, then left before the capture');
park(); run(game, TICK_MS);
reset();
place(b1, 50, 40);
run(game, 2000);
assert.equal(policy.flags[0].state, 'neutralizing');
place(a3, 51, 41);
run(game, 1000);
assert.equal(policy.flags[0].state, 'contested');
place(b1, SX - 6, 72);
run(game, 4000);
assert.equal(policy.flags[0].state, 'idle');
assert.equal(pts(events, a3.id, 'defend'), 100, 'holding off a neutralization defends the flag');
// An enemy stepping in and out of a full flag (1v1 contest, control never
// moves) is not a defence: repeating it must not farm 'defend'.
reset();
for (let i = 0; i < 5; i++) {
  place(b1, 50, 40);
  run(game, TICK_MS);
  assert.equal(policy.flags[0].state, 'contested');
  place(b1, SX - 6, 72);
  run(game, TICK_MS);
  assert.equal(policy.flags[0].state, 'idle');
}
assert.equal(policy.flags[0].control, 1, 'control never moved');
assert.equal(pts(events, a3.id, 'defend'), 0, 'an untouched full flag pays no defend');
park(); run(game, TICK_MS);
reset();
place(b2, 50, 120);
run(game, 8300);
assert.equal(policy.flags[1].owner, null);
assert.equal(pts(events, b2.id, 'neutralize'), 150, 'neutralizing B');
park(); run(game, TICK_MS);

// Vehicle events from the VehicleSystem hook.
reset();
const tankHp = VEHICLE_RULES.tank.hp;
game.mode.onVehicleEvent('vehicle_hit', { vehicleId: 'bravo-tank', attacker: a4.id, dmg: tankHp * 0.15, zone: 'rear', cls: 'at', eff: 1, pos: [170, 3, 30] });
game.mode.onVehicleEvent('vehicle_hit', { vehicleId: 'bravo-tank', attacker: a4.id, dmg: tankHp * 0.10, zone: 'side', cls: 'at', eff: 1, pos: [170, 3, 30] });
game.mode.onVehicleEvent('vehicle_hit', { vehicleId: 'bravo-tank', attacker: a4.id, dmg: 50, zone: 'front', cls: 'small', eff: 0, pos: [170, 3, 30] });
game.mode.onVehicleEvent('vehicle_hit', { vehicleId: 'alpha-jeep', attacker: a3.id, dmg: 80, zone: 'side', cls: 'hmg', eff: 1, pos: [30, 3, 30] });
run(game, 1000);
assert.equal(scored(events, a4.id, 'vehicle_damage').length, 0, 'hull damage pays out after a pause');
run(game, 700);
assert.equal(pts(events, a4.id, 'vehicle_damage'), 50, 'a quarter of a hull is 50 points; no-effect hits do not count');
assert.equal(scored(events, a3.id).length, 0, 'damage to an own-team hull pays nothing');
game.mode.onVehicleEvent('vehicle_disabled', { vehicleId: 'bravo-tank', attacker: a4.id });
game.mode.onVehicleEvent('vehicle_hit', { vehicleId: 'bravo-tank', attacker: a4.id, dmg: tankHp * 0.8, zone: 'rear', cls: 'at', eff: 1, pos: [170, 3, 30] });
game.mode.onVehicleEvent('vehicle_destroyed', { vehicleId: 'bravo-tank', type: 'tank', attacker: a4.id, assists: [], crewKilled: 2 });
run(game, TICK_MS);
assert.equal(pts(events, a4.id, 'vehicle_disabled'), 100);
assert.equal(pts(events, a4.id, 'vehicle_damage'), 200, 'destruction flushes the pending hull damage (capped at 150)');
assert.equal(pts(events, a4.id, 'vehicle_destroyed'), 200);
assert.equal(pts(events, a4.id, 'vehicle_crew'), 100, 'two crew killed with the hull');

// Driver assist: a passenger's kill credits the driver.
reset();
place(a1, 30, 27); place(a2, 30, 33);
assert(game.vehicles.enter(a1, 'alpha-jeep'), 'driver boards');
assert(game.vehicles.enter(a2, 'alpha-jeep'), 'second seat boards');
place(b3, 60, 140);
game.killPlayer(b3, a2, 'rifle', false);
run(game, TICK_MS);
assert.equal(pts(events, a1.id, 'driver_assist'), 25);
game.vehicles.release(a1); game.vehicles.release(a2);
revive(b3); park(); run(game, TICK_MS);

// Role awards (revive, repair, resupply, spot assist) go through the same
// ledger via policy.award; the squad spawn is paid by a real squad deploy.
reset();
for (const reason of ['revive', 'heal', 'repair', 'resupply', 'spot_assist']) assert.equal(policy.award(a3.id, reason), SCORE_POINTS[reason]);
assert(policy.squads.areSquadmates(a1.id, a2.id), 'four alpha players share squad 1');
place(a1, 20, 60);
game.killPlayer(a2, b1, 'rifle', false);
assert(game.mode.conquestIntent(a2, { type: 'deploy', spawn: `squad:${a1.id}`, kit: 'assault', variant: 0 }));
run(game, 6200);
assert.equal(a2.state, 'alive');
assert.equal(pts(events, a1.id, 'squad_spawn'), SCORE_POINTS.squad_spawn, 'the mate spawned on earns squad_spawn');
park(); run(game, TICK_MS);
assert.equal(policy.award('nobody', 'kill'), 0, 'unknown players earn nothing');
assert.equal(policy.award(a3.id, 'not_a_reason'), 0);

// Every reason fired with its contracted points; scores and cqs are authoritative.
const scores = log.filter(e => e.kind === 'score');
for (const reason of Object.keys(SCORE_POINTS)) assert(scores.some(e => e.reason === reason), `${reason} fired`);
const scaled = new Set(['assist', 'vehicle_damage', 'vehicle_crew']);
for (const e of scores) {
  if (!scaled.has(e.reason)) assert.equal(e.pts, SCORE_POINTS[e.reason], `${e.reason} pays ${SCORE_POINTS[e.reason]}`);
  assert(Number.isInteger(e.pts) && e.pts > 0);
}
const kills = log.filter(e => e.kind === 'kill' && e.killer && e.killer !== e.victim);
assert.equal(scores.filter(e => e.reason === 'kill').length, kills.length, 'one kill payout per kill, never two');
for (const p of [...alpha, ...bravo]) {
  const mine = scores.filter(e => e.id === p.id);
  assert.equal(p.score, mine.reduce((sum, e) => sum + e.pts, 0), `${p.id}: players[].score is the ledger total`);
  const row = game.lastSnapshot.players.find(r => r.id === p.id);
  assert.equal(row.score, p.score);
  const objective = mine.filter(e => ['capture', 'neutralize', 'capture_assist', 'defend'].includes(e.reason)).reduce((sum, e) => sum + e.pts, 0);
  assert.deepEqual(decodeConquestStats(row), {
    objective,
    vehicles: mine.filter(e => e.reason === 'vehicle_destroyed').length,
    revives: mine.filter(e => e.reason === 'revive').length,
    captures: mine.filter(e => e.reason === 'capture').length,
  }, `${p.id}: cqs counters`);
}

// The ledger closes with the match and the results rows carry the counters.
policy.ledger.tickets.bravo = 1;
game.killPlayer(b1, a1, 'rifle', false);
run(game, TICK_MS);
assert.equal(policy.phase, 'post');
const before2 = a3.score;
assert.equal(policy.award(a3.id, 'revive'), 0, 'no awards after the match');
assert.equal(a3.score, before2);
const results = game.lastSnapshot.match.results;
const a4row = results.find(r => r.id === a4.id);
assert.deepEqual(a4row.cqs, [0, 1, 0, 0], 'post-match results carry cqs');
assert(a4row.squad > 0 && typeof a4row.kit === 'string');
// Rematch resets scores and counters.
const vote = game.lastSnapshot.match.continuation;
for (const p of [...alpha, ...bravo].slice(0, vote.required)) assert(game.mode.approveContinuation(p.id, vote.id));
run(game, 5200);
assert.equal(policy.phase, 'live');
assert.equal(a4.score, 0);
run(game, TICK_MS);
assert.deepEqual(decodeConquestStats(game.lastSnapshot.players.find(r => r.id === a4.id)), { objective: 0, vehicles: 0, revives: 0, captures: 0 });

console.log(`Conquest score ledger: all ${Object.keys(SCORE_POINTS).length} SCORE_POINTS reasons fired with contracted points (assist 10..90, vehicle damage 10..150), one kill payout per kill, score events equal players[].score, cqs counters, post-match freeze, results counters and rematch reset passed.`);
