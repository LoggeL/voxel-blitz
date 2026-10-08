// Conquest in-game menu RESPAWN (the `redeploy` intent): the protocol frame and
// its rate limits, the policy rules (an ordinary 1-ticket death with the kill
// key `redeploy`, no revivable body, enemy credit within FALL_DAMAGE.creditMs,
// the cooldown, refusals while dead or after the match) and the seated case
// (the player dies in the seat, the hull carries on with the seat free).
import assert from 'node:assert/strict';
import { GameEngine } from '../server/game.js';
import { LobbyManager } from '../server/lobby.js';
import { TICK_MS, parseConquestIntent } from '../server/protocol/admission.js';
import { CONQUEST_RULES, CONQUEST_DEATH_KEYS, CONQUEST_INTENT_SHAPE, decodeConquestPlayer } from '../shared/conquest-contract.js';
import { FALL_DAMAGE } from '../shared/parachute.js';
import { vehicleSeatOccupantId } from '../shared/vehicle-seats.js';
import { NetClient } from '../public/js/engine/netclient.js';
import { REDEPLOY_KILL_KEY } from '../server/modes/conquest.js';

let checks = 0;
const check = (value, message) => { assert(value, message); checks++; };

// --- protocol -------------------------------------------------------------------------
{
  check(CONQUEST_DEATH_KEYS.includes('redeploy') && REDEPLOY_KILL_KEY === 'redeploy', 'the contract lists the redeploy kill key');
  check(CONQUEST_INTENT_SHAPE.redeploy === '1', 'the contract lists the redeploy intent');
  check(CONQUEST_RULES.redeployCooldownMs === 10000, 'redeploys are limited to one per 10 s');
  assert.deepEqual(parseConquestIntent({ t: 'conquest', redeploy: 1 }), { type: 'redeploy' }); checks++;
  assert.deepEqual(parseConquestIntent({ t: 'conquest', redeploy: true }), { type: 'redeploy' }); checks++;
  for (const bad of [{ t: 'conquest', redeploy: 0 }, { t: 'conquest', redeploy: {} }, { t: 'conquest', redeploy: 'yes' },
    { t: 'conquest', redeploy: 1, spot: 1 }, { t: 'conquest', redeploy: 2 }]) check(parseConquestIntent(bad) === null, `rejects ${JSON.stringify(bad)}`);

  const net = new NetClient();
  const frames = [];
  net.ws = { readyState: 1, send: frame => frames.push(JSON.parse(frame)) };
  check(net.sendConquest({ redeploy: 1 }) === true, 'the client sends a redeploy');
  assert.deepEqual(frames[0], { t: 'conquest', redeploy: 1 }); checks++;
  check(net.sendConquest({ redeploy: 1 }) === false, 'a second redeploy within 1 s is held back');
  check(net.sendConquest({ spot: 1 }) === true, 'redeploy has its own rate limit');

  const calls = [];
  const member = { id: 'p1' };
  const room = { phase: 'live', engine: { conquestIntent: (id, intent) => { calls.push(intent.type); return true; } } };
  const route = intent => LobbyManager.prototype.conquest.call({ _memberFor: () => ({ room, member }) }, {}, intent);
  check(route({ type: 'redeploy' }) === true, 'the lobby routes a redeploy');
  check(route({ type: 'redeploy' }) === false, 'the lobby rate-limits redeploys');
  member.conquestIntentAt.redeploy = performance.now() - 800;
  check(route({ type: 'redeploy' }) === true, 'jitter below the client gap passes');
}

// --- policy ----------------------------------------------------------------------------
const SX = 160, SY = 64, SZ = 160, FLOOR = 2;
const spot = (x, z) => ({ x: x + 0.5, y: FLOOR, z: z + 0.5 });
function fixture({ vehicles = [] } = {}) {
  const hq = (team, x) => ({ id: team, name: `${team} HQ`, ...spot(x, 80), radius: 12, spawns: [spot(x, 76), spot(x, 80), spot(x, 84)] });
  const bases = { alpha: hq('alpha', 8), bravo: hq('bravo', SX - 9) };
  const mapMeta = { id: 'frontier', dimensions: { sx: SX, sy: SY, sz: SZ },
    spawns: { conquest: { alpha: bases.alpha.spawns, bravo: bases.bravo.spawns } },
    conquest: { version: 2, bases, combatArea: { minX: 2, maxX: SX - 2, minZ: 2, maxZ: SZ - 2 }, vehicleSpawns: vehicles, flags: [] } };
  const getBlock = (x, y, z) => (x < 0 || z < 0 || x >= SX || z >= SZ ? 1 : y < FLOOR ? 1 : 0);
  const world = { dimensions: { sx: SX, sy: SY, sz: SZ }, getBlock, findSpawns: () => [spot(20, 20)], setBlock: () => {} };
  const events = [];
  const game = new GameEngine({ mode: 'conquest', mapMeta, world, broadcast: snap => { events.push(...snap.events); game.lastSnapshot = snap; } });
  return { game, events, policy: game.mode.policy };
}
const run = (game, ms) => { for (let t = 0; t < ms - 1e-6; t += TICK_MS) game.step(TICK_MS); };
const human = (game, id, team = 'alpha') => { game.addClient(id, id); const p = game.entities.get(id); game.mode.policy.setLobbyTeam(p, team); return p; };
const place = (p, x, z) => Object.assign(p, { x: x + 0.5, y: FLOOR, z: z + 0.5, vx: 0, vy: 0, vz: 0, spawnProtected: false, spawnProtectedUntil: 0 });
const kills = events => events.filter(e => e.kind === 'kill');
const redeploy = (game, p) => game.conquestIntent(p.id, { type: 'redeploy' });

{
  const { game, events, policy } = fixture();
  const a = human(game, 'p1_a'), b = human(game, 'p2_b', 'bravo');
  place(a, 40, 40); place(b, 120, 120);
  run(game, 200);
  const tickets = policy.tickets.alpha, deaths = a.deaths, bKills = b.kills;
  check(redeploy(game, a) === true, 'a living player redeploys');
  check(a.state === 'dead', 'and is dead at once');
  const kill = kills(events).at(-1) ?? null;
  run(game, TICK_MS);
  const feed = kills(events).find(e => e.victim === a.id);
  check(feed?.w === 'redeploy' && feed.killer === '', `the feed shows a self redeploy (${JSON.stringify(feed ?? kill)})`);
  check(policy.tickets.alpha === tickets - CONQUEST_RULES.deathTicketCost, 'it costs exactly one ticket');
  check(a.deaths === deaths + 1 && b.kills === bKills, 'it counts as a death and credits nobody');
  check(policy.roles.isDown(a) !== true, 'the body is not revivable');
  check(decodeConquestPlayer(game.lastSnapshot.players.find(r => r.id === a.id))?.down === false, 'the snapshot shows no downed body');
  check(redeploy(game, a) === false, 'a dead player cannot redeploy');
  // Respawn through the deploy screen as usual.
  check(game.conquestIntent(a.id, { type: 'deploy', spawn: 'hq', kit: 'assault', variant: 0, gadget: 0 }), 'the deploy screen choice is accepted');
  run(game, CONQUEST_RULES.respawnMs + 500);
  check(a.state === 'alive', 'the player deploys after the normal respawn delay');
  check(redeploy(game, a) === false, `a second redeploy within ${CONQUEST_RULES.redeployCooldownMs} ms is refused`);
  check(a.state === 'alive' && policy.tickets.alpha === tickets - 1, 'a refused redeploy costs nothing');
  run(game, CONQUEST_RULES.redeployCooldownMs);
  check(redeploy(game, a) === true, 'after the cooldown it works again');
  // Enemy damage within FALL_DAMAGE.creditMs credits the enemy (no kill denial).
  game.conquestIntent(a.id, { type: 'deploy', spawn: 'hq', kit: 'assault', variant: 0, gadget: 0 });
  run(game, CONQUEST_RULES.respawnMs + CONQUEST_RULES.redeployCooldownMs);
  check(a.state === 'alive', 'alive again');
  a.spawnProtected = false; a.spawnProtectedUntil = 0;
  a.takeDamage(20, false, b, 'rifle');
  run(game, FALL_DAMAGE.creditMs / 2);
  const before = b.kills;
  check(redeploy(game, a) === true, 'a wounded player redeploys');
  run(game, TICK_MS);
  const credited = kills(events).filter(e => e.victim === a.id).at(-1);
  check(credited?.killer === b.id && credited.w === 'redeploy' && b.kills === before + 1, 'the enemy who just hit you gets the kill');
  // The post phase refuses it.
  game.conquestIntent(a.id, { type: 'deploy', spawn: 'hq', kit: 'assault', variant: 0, gadget: 0 });
  run(game, CONQUEST_RULES.respawnMs + CONQUEST_RULES.redeployCooldownMs);
  policy._finishMatch('alpha');
  check(policy.phase === 'post' && redeploy(game, a) === false && a.state === 'alive', 'no redeploy after the match ended');
}

{
  // Seated: the player dies in the seat; the seat is free and the hull stays.
  const { game, events } = fixture({ vehicles: [{ id: 'jeep', team: 'alpha', type: 'jeep', x: 60.5, y: FLOOR, z: 60.5, yaw: 0 }] });
  const a = human(game, 'p1_a');
  run(game, 200);
  const jeep = game.vehicles.vehicles.get('jeep');
  place(a, 61, 61);
  check(game.vehicles.enter(a, 'jeep', 'driver'), 'the player drives the jeep');
  check(redeploy(game, a) === true && a.state === 'dead', 'a seated player redeploys');
  run(game, TICK_MS);
  check(vehicleSeatOccupantId(jeep, 'driver') == null && !a.vehicleId, 'the driver seat is free');
  check(jeep.hp > 0, 'the hull is unharmed');
  check(kills(events).some(e => e.victim === a.id && e.w === 'redeploy'), 'the seated death reads as a redeploy');
}

console.log(`conquest-redeploy-test: OK (${checks} checks)`);
