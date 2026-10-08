// Conquest v2 deploy: the respawn gate, HQ/flag/squad/vehicle spawns, refusals,
// bots via the director, squads, shared deployOptions and forward spawn distance.
import assert from 'node:assert/strict';
import { GameEngine } from '../server/game.js';
import { TICK_MS } from '../server/protocol/admission.js';
import { CONQUEST_RULES, KITS, VEHICLE_TOPOLOGY, decodeConquestPlayer } from '../shared/conquest-contract.js';
import { decodeConquestMatch, deployOptions, deployViewFromSnapshot, resolveDeployChoice } from '../shared/conquest.js';
import { SquadRoster } from '../server/modes/conquest/squads.js';
import { BOT_FLEX_POOL } from '../shared/conquest-kits.js';

const SX = 200, SY = 32, SZ = 160;
const spot = (x, z) => ({ x: x + 0.5, y: 2, z: z + 0.5 });
const ring = (x, z) => Array.from({ length: 12 }, (_, i) => spot(x + Math.round(Math.cos(i * Math.PI / 6) * 6), z + Math.round(Math.sin(i * Math.PI / 6) * 6)));
const flagRow = (id, x, z, home) => ({ id, name: `Flag ${id}`, ...spot(x, z), radius: 10, home, spawns: ring(x, z) });

function fixture({ walls = [], vehicles = [], flags = null } = {}) {
  const hq = (team, x) => ({ id: team, name: `${team} HQ`, ...spot(x, 80), radius: 12,
    spawns: [spot(x, 74), spot(x, 77), spot(x, 80), spot(x, 83), spot(x, 86)] });
  const bases = { alpha: hq('alpha', 8), bravo: hq('bravo', SX - 9) };
  const mapMeta = { id: 'frontier', dimensions: { sx: SX, sy: SY, sz: SZ },
    spawns: { conquest: { alpha: bases.alpha.spawns, bravo: bases.bravo.spawns } },
    conquest: { version: 2, bases, combatArea: { minX: 2, maxX: SX - 2, minZ: 2, maxZ: SZ - 2 }, vehicleSpawns: vehicles,
      flags: flags ?? [flagRow('A', 50, 40, 'alpha'), flagRow('B', 50, 120, 'alpha'), flagRow('C', 100, 80, null),
        flagRow('D', 150, 40, 'bravo'), flagRow('E', 150, 120, 'bravo')] } };
  const solid = (x, y, z) => x < 0 || z < 0 || x >= SX || z >= SZ || y < 2
    || walls.some(w => x >= w.x0 && x <= w.x1 && z >= w.z0 && z <= w.z1 && y <= (w.top ?? 6));
  const world = { dimensions: { sx: SX, sy: SY, sz: SZ }, getBlock: (x, y, z) => (solid(x, y, z) ? 1 : 0),
    findSpawns: () => [spot(20, 20)], setBlock: () => {} };
  const events = [];
  const game = new GameEngine({ mode: 'conquest', mapMeta, world, broadcast: snap => { events.push(...snap.events); game.lastSnapshot = snap; } });
  return { game, events, policy: game.mode.policy, mapMeta };
}
const run = (game, ms) => { for (let t = 0; t < ms - 1e-6; t += TICK_MS) game.step(TICK_MS); };
const place = (p, x, z, yaw = 0) => Object.assign(p, { x: x + 0.5, y: 2, z: z + 0.5, vx: 0, vy: 0, vz: 0, yaw });
const human = (game, id) => { game.addClient(id, id); return game.entities.get(id); };
const refusals = (events, id) => events.filter(e => e.kind === 'deploy_refused' && e.id === id).map(e => e.reason);
const intent = (game, p, spawn, kit = 'assault', variant = 0) => game.mode.conquestIntent(p, { type: 'deploy', spawn, kit, variant });
const near = (p, q, r = 1e-6) => Math.hypot(p.x - q.x, p.z - q.z) <= r;
const inRing = (p, flag) => Math.abs(Math.hypot(p.x - flag.x, p.z - flag.z) - 6) < 1.5;

// --- human gate, flag spawn, refusals and the HQ timeout -------------------------
{
  const { game, events, policy } = fixture();
  const a = human(game, 'p1_alpha'), b = human(game, 'p2_bravo'), a2 = human(game, 'p3_alpha');
  assert.deepEqual([a.team, b.team, a2.team], ['alpha', 'bravo', 'alpha']);
  for (const p of [a, b, a2]) assert(near(p, policy.hqPool(p).find(s => near(s, p)) ?? { x: Infinity, z: 0 }, 0.01), 'round start spawns everyone at HQ');
  place(b, SX - 6, 70); place(a2, 6, 70);
  game.killPlayer(a, b, 'rifle', false);
  assert.equal(intent(game, a, 'flag:D'), false, 'an enemy flag is refused');
  assert.deepEqual(refusals(game.tickEvents, a.id), ['invalid']);
  assert.equal(intent(game, a, 'flag:A', 'recon', 1), true, 'an own flag is accepted');
  run(game, CONQUEST_RULES.respawnMs - 200);
  assert.equal(a.state, 'dead', 'no deploy before respawnAt');
  run(game, 400);
  assert.equal(a.state, 'alive', 'a valid choice deploys at respawnAt');
  assert(inRing(a, policy.flags[0]), 'spawned on a flag A cell');
  assert.equal(decodeConquestPlayer(game.lastSnapshot.players.find(p => p.id === a.id)).kit, 'recon', 'the chosen kit is published');
  assert.equal(a.spawnProtectedUntil, 0, 'only HQ deploys are protected');

  // An enemy capturing A closes the option; the player waits and falls back to HQ at the timeout.
  place(a, 6, 74);
  place(b, 50, 40);
  run(game, 1500);
  assert.equal(policy.flags[0].state, 'neutralizing');
  game.killPlayer(a, b, 'rifle', false);
  run(game, TICK_MS);
  events.length = 0;
  assert.equal(intent(game, a, 'flag:A'), false);
  run(game, TICK_MS);
  assert.deepEqual(refusals(events, a.id), ['contested'], 'a flag being neutralized is refused');
  run(game, CONQUEST_RULES.respawnMs + 1000);
  assert.equal(a.state, 'dead', 'without a choice the player stays on the deploy screen');
  run(game, CONQUEST_RULES.deployTimeoutMs);
  assert.equal(a.state, 'alive', 'auto-deploy at respawnAt + deployTimeoutMs');
  assert(policy.hqPool(a).some(s => near(s, a, 0.01)), 'the timeout fell back to HQ (the last valid choice is unavailable)');
  assert(a.spawnProtectedUntil > game.now, 'HQ deploys carry spawn protection');

  // A chosen flag that turns invalid by respawnAt is refused once and the player keeps waiting.
  place(b, SX - 6, 70);
  Object.assign(policy.flags[0], { owner: 'alpha', control: 1, state: 'idle', mover: null });
  run(game, TICK_MS);
  game.killPlayer(a, b, 'rifle', false);
  assert.equal(intent(game, a, 'flag:A'), true);
  place(b, 50, 40);
  events.length = 0;
  run(game, CONQUEST_RULES.respawnMs + 500);
  assert.equal(a.state, 'dead');
  assert.deepEqual(refusals(events, a.id), ['contested'], 'refused once at respawnAt');
}

// --- flag cells: enemy line of sight within 40 m, distance from enemy flags --------
{
  const wall = { x0: 103, x1: 103, z0: 60, z1: 100, top: 8 };
  const { game, events, policy } = fixture({ walls: [wall] });
  Object.assign(policy.flags[2], { owner: 'alpha', control: 1, state: 'idle' });
  const a = human(game, 'p1_alpha'), b = human(game, 'p2_bravo');
  place(b, 128, 80);
  const flagC = policy.flags[2];
  for (let i = 0; i < 12; i++) {
    game.killPlayer(a, b, 'rifle', false);
    assert.equal(intent(game, a, 'flag:C'), true);
    run(game, CONQUEST_RULES.respawnMs + 100);
    assert.equal(a.state, 'alive');
    assert(inRing(a, flagC), 'a C cell');
    assert(a.x < 103, `cells the enemy at 28 m can see are dropped (spawned at x ${a.x})`);
    place(a, 6, 74 + (i % 5));
  }
  // Behind the wall but further than 40 m: the line-of-sight rule no longer applies.
  place(b, 150, 80);
  const xs = [], cells = new Set();
  for (let i = 0; i < 30; i++) {
    game.killPlayer(a, b, 'rifle', false);
    intent(game, a, 'flag:C');
    run(game, CONQUEST_RULES.respawnMs + 100);
    xs.push(a.x);
    cells.add(`${a.x},${a.z}`);
    place(a, 6, 74 + (i % 5));
  }
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  assert(mean < flagC.x - 1, `cells away from the nearest enemy-held flag are preferred (mean x ${mean.toFixed(1)})`);
  assert(cells.size >= 3, `variety spreads the cells (${cells.size} distinct)`);
}
{
  // Open ground with an enemy 15 m from C: every cell is watched, so the deploy is refused.
  const { game, events, policy } = fixture();
  Object.assign(policy.flags[2], { owner: 'alpha', control: 1, state: 'idle' });
  const a = human(game, 'p1_alpha'), b = human(game, 'p2_bravo');
  place(b, 100, 95);
  game.killPlayer(a, b, 'rifle', false);
  assert.equal(intent(game, a, 'flag:C'), true, 'the option itself is open (no enemy inside the radius)');
  run(game, CONQUEST_RULES.respawnMs + 100);
  assert.equal(a.state, 'dead');
  assert.deepEqual(refusals(events, a.id), ['enemy'], 'no unseen cell: deploy_refused enemy');
  run(game, CONQUEST_RULES.deployTimeoutMs);
  assert(policy.hqPool(a).some(s => near(s, a, 0.01)), 'the timeout deploys at HQ');
}
{
  // Terrain alone (every cell buried or cratered) blocks C with no enemy anywhere:
  // the refusal says the spawn is unavailable, not that enemies hold the zone.
  const { game, events, policy } = fixture({ walls: [{ x0: 92, x1: 108, z0: 72, z1: 88 }] });
  Object.assign(policy.flags[2], { owner: 'alpha', control: 1, state: 'idle' });
  const a = human(game, 'p1_alpha'), b = human(game, 'p2_bravo');
  place(b, SX - 6, 70);
  game.killPlayer(a, b, 'rifle', false);
  assert.equal(intent(game, a, 'flag:C'), true);
  run(game, CONQUEST_RULES.respawnMs + 100);
  assert.equal(a.state, 'dead');
  assert.deepEqual(refusals(events, a.id), ['invalid'], 'no standable cell: deploy_refused invalid');
}

// --- squad spawns: damage lock, cooldown, ring behind the mate ----------------------
{
  const { game, events, policy } = fixture();
  const a = human(game, 'p1_alpha'), b = human(game, 'p2_bravo'), mate = human(game, 'p3_alpha');
  assert(policy.squads.areSquadmates(a.id, mate.id));
  place(b, SX - 6, 70);
  place(mate, 70, 80, 0);
  game.killPlayer(a, b, 'rifle', false);
  run(game, 1000);
  mate.takeDamage(10, false, b, 'rifle');
  run(game, 2000);
  events.length = 0;
  assert.equal(intent(game, a, `squad:${mate.id}`), false, 'a mate damaged 2 s ago is locked');
  run(game, TICK_MS);
  assert.deepEqual(refusals(events, a.id), ['busy']);
  run(game, 2200);
  assert.equal(intent(game, a, `squad:${mate.id}`), true, 'the lock lifts after squadSpawnDamageLockMs');
  run(game, CONQUEST_RULES.respawnMs);
  assert.equal(a.state, 'alive');
  const d = Math.hypot(a.x - mate.x, a.z - mate.z);
  assert(d >= 1 && d <= 4, `spawned 1-4 m from the mate (${d.toFixed(2)})`);
  assert(a.z - mate.z > 0.5, 'behind the mate (forward is -z at yaw 0)');
  assert(events.some(e => e.kind === 'score' && e.id === mate.id && e.reason === 'squad_spawn' && e.pts === 15), 'the mate earns squad_spawn');
  place(human(game, 'p4_bravo'), SX - 6, 74);
  const second = human(game, 'p5_alpha');
  assert(policy.squads.areSquadmates(second.id, mate.id));
  game.killPlayer(second, b, 'rifle', false);
  events.length = 0;
  assert.equal(intent(game, second, `squad:${mate.id}`), false, 'one squad spawn per mate per squadSpawnCooldownMs');
  run(game, TICK_MS);
  assert.deepEqual(refusals(events, second.id), ['cooldown']);
  // A walled-in mate has no free ring cell.
  const boxed = fixture({ walls: [{ x0: 68, x1: 68, z0: 74, z1: 86, top: 9 }, { x0: 72, x1: 72, z0: 74, z1: 86, top: 9 },
    { x0: 68, x1: 72, z0: 78, z1: 78, top: 9 }, { x0: 68, x1: 72, z0: 82, z1: 82, top: 9 }] });
  const ba = human(boxed.game, 'p1_alpha'), bb = human(boxed.game, 'p2_bravo'), bm = human(boxed.game, 'p3_alpha');
  place(bb, SX - 6, 70); place(bm, 70, 80);
  boxed.game.killPlayer(ba, bb, 'rifle', false);
  assert.equal(intent(boxed.game, ba, `squad:${bm.id}`), true);
  run(boxed.game, CONQUEST_RULES.respawnMs + 100);
  assert.equal(ba.state, 'dead');
  assert.deepEqual(refusals(boxed.events, ba.id), ['busy'], 'no free cell beside the mate');
  // A mate in an aircraft or in a flag being neutralized is no squad spawn.
  const view = { flags: [{ id: 'A', x: 50, y: 2, z: 40, radius: 10, owner: 'alpha', state: 'neutralizing', alpha: 1, bravo: 2 }],
    players: [{ id: 'm1', team: 'alpha', state: 'alive', x: 51, y: 2, z: 41, squad: 1 }, { id: 'm2', team: 'alpha', state: 'alive', x: 0, y: 30, z: 0, squad: 1, vehicleId: 'jet' }],
    vehicles: [{ id: 'jet', type: 'plane', team: 'alpha', hp: 450, seatOccupants: { driver: 'm2' } }] };
  const opts = deployOptions(view, { id: 'me', team: 'alpha', squad: 1 });
  assert.deepEqual(opts.filter(o => o.kind === 'squad').map(o => [o.id, o.reason]), [['m1', 'contested'], ['m2', 'busy']]);
  assert.deepEqual(opts.filter(o => o.kind === 'vehicle').map(o => [o.id, o.reason]), [['jet', 'seat']], 'a full hull is no option');
}

// --- vehicle seats ------------------------------------------------------------------
{
  const vehicles = [{ id: 'alpha-tank', team: 'alpha', type: 'tank', x: 30.5, y: 2, z: 60.5, yaw: 0 },
    { id: 'bravo-jeep', team: 'bravo', type: 'jeep', x: 170.5, y: 2, z: 60.5, yaw: 0 }];
  const { game, events, policy } = fixture({ vehicles });
  const a = human(game, 'p1_alpha'), b = human(game, 'p2_bravo'), driver = human(game, 'p3_alpha');
  place(b, SX - 6, 70);
  place(driver, 30, 57);
  assert(game.vehicles.enter(driver, 'alpha-tank'), 'a teammate drives');
  const tank = game.vehicles.vehicles.get('alpha-tank');
  const seats = Object.keys(tank.seatOccupants);
  const commander = VEHICLE_TOPOLOGY.tank.map(s => s.id).find(id => id !== 'driver' && seats.includes(id)) ?? seats[1];
  game.killPlayer(a, b, 'rifle', false);
  assert.equal(intent(game, a, 'vehicle:bravo-jeep'), false, 'enemy hulls are refused');
  assert.equal(intent(game, a, 'vehicle:alpha-tank:driver'), false, 'an occupied seat is refused');
  run(game, TICK_MS);
  assert.deepEqual(refusals(events, a.id), ['invalid', 'seat']);
  assert.equal(intent(game, a, `vehicle:alpha-tank:${commander}`, 'engineer', 0), true);
  run(game, CONQUEST_RULES.respawnMs);
  assert.equal(a.state, 'alive');
  assert.equal(a.vehicleId, 'alpha-tank', 'the deploy seats the player');
  assert.equal(a.vehicleSeatId, commander, `in the requested ${commander} seat`);
  assert.equal(tank.seatOccupants[commander], a.id);
  const full = policy.conquestView().deployOptions(driver).find(o => o.spawn === 'vehicle:alpha-tank');
  assert.equal(full.reason, 'seat', 'a full tank is closed');
  assert.equal(resolveDeployChoice([full], 'vehicle:alpha-tank').reason, 'seat');
}

// --- squad spawn on a mate seated in a ground hull: behind the hull, outside it -------
{
  const vehicles = [{ id: 'alpha-tank', team: 'alpha', type: 'tank', x: 60.5, y: 2, z: 80.5, yaw: 0 }];
  const { game, policy } = fixture({ vehicles });
  const a = human(game, 'p1_alpha'), b = human(game, 'p2_bravo'), mate = human(game, 'p3_alpha');
  assert(policy.squads.areSquadmates(a.id, mate.id));
  place(b, SX - 6, 70);
  place(mate, 60, 78);
  assert(game.vehicles.enter(mate, 'alpha-tank'), 'the mate drives the tank');
  const tank = game.vehicles.vehicles.get('alpha-tank');
  game.killPlayer(a, b, 'rifle', false);
  assert.equal(intent(game, a, `squad:${mate.id}`), true, 'a mate in a ground hull is a squad spawn');
  run(game, CONQUEST_RULES.respawnMs + 100);
  assert.equal(a.state, 'alive', 'deployed beside the hull');
  assert.equal(a.vehicleId ?? null, null, 'on foot, not seated');
  const d = Math.hypot(a.x - tank.x, a.z - tank.z);
  assert(d > 3.25 && d < 3.25 + 3.01, `outside the tank footprint (${d.toFixed(2)} m from the hull centre)`);
  assert(a.z - tank.z > 1, 'behind the hull (forward is -z at yaw 0)');
  assert(Math.abs(a.y - tank.y) <= 1.01, `standing on the ground, not at the seat height (y ${a.y})`);
}

// --- a throwing director never breaks the tick ------------------------------------------
{
  const { game, policy } = fixture();
  const b = human(game, 'p1_bravo');
  game.addBot('bot-0');
  const bot = game.entities.get('bot-0');
  game.mode.setBotDirector({ goalFor: () => { throw new Error('goal'); }, deployFor: () => { throw new Error('deploy'); } });
  assert.equal(game.mode.botGoal(bot).kind, 'capture', 'goalFor errors fall back to the simple goal');
  place(b, bot.team === 'alpha' ? SX - 6 : 6, 70);
  game.killPlayer(bot, b, 'rifle', false);
  run(game, CONQUEST_RULES.respawnMs + 100);
  assert.equal(bot.state, 'alive', 'deployFor errors fall back to the frontline choice at respawnAt');
  game.mode.setBotDirector(null);
  // A revive keeps the body's kit: a kit picked on the deploy screen while down is dropped.
  const a = human(game, 'p2_alpha');
  assert.equal(policy.kitFor(a).kit, 'assault');
  game.killPlayer(a, b, 'rifle', false);
  assert.equal(intent(game, a, 'hq', 'recon', 1), true);
  game.respawnPlayer(a, { x: a.x, y: a.y, z: a.z });
  assert.equal(policy.onRevive(a), true);
  assert.deepEqual(policy.kitFor(a), { kit: 'assault', variant: 0, gadget: 0 }, 'revived with the kit the body carried');
}

// --- bots: director at respawnAt, frontline fallback ------------------------------------
{
  const { game, policy } = fixture();
  const b = human(game, 'p1_bravo');
  game.addBot('bot-0'); game.addBot('bot-1');
  const bot = game.entities.get('bot-0');
  assert.equal(bot.team, 'bravo' === b.team ? 'alpha' : 'bravo');
  Object.assign(policy.flags[2], { owner: bot.team, control: bot.team === 'alpha' ? 1 : -1 });
  const asked = [];
  game.mode.setBotDirector({ goalFor: () => null, deployFor: p => { asked.push(p.id); return { spawn: 'flag:C', kit: 'support', variant: 1 }; } });
  // Registered right after the round-start HQ spawn: fresh bots switch to the
  // director's kit for their opening life (the spawn part is ignored).
  const botIds = [...game.entities.values()].filter(p => p.bot).map(p => p.id).sort();
  assert.deepEqual(asked.slice().sort(), botIds, 'fresh bots take the director kit on registration');
  run(game, TICK_MS);
  assert.equal(decodeConquestPlayer(game.lastSnapshot.players.find(p => p.id === bot.id)).kit, 'support');
  assert(bot.owned.includes('minigun') && !bot.owned.includes('rifle'), 'support variant 1 loadout applied');
  assert(policy.hqPool(bot).some(s => near(s, bot, 0.01)), 'the opening life stays at HQ');
  asked.length = 0;
  place(b, bot.team === 'alpha' ? SX - 6 : 6, 70);
  game.killPlayer(bot, b, 'rifle', false);
  const respawnAt = bot.respawnAt;
  run(game, CONQUEST_RULES.respawnMs - 100);
  assert.equal(bot.state, 'dead');
  assert.equal(asked.length, 0, 'the director is asked at respawnAt');
  run(game, 200);
  assert.equal(bot.state, 'alive', 'bots deploy without waiting for the timeout');
  assert(game.now - respawnAt < 200);
  assert.deepEqual(asked, [bot.id]);
  assert(inRing(bot, policy.flags[2]), 'at the director-chosen flag');
  assert.equal(decodeConquestPlayer(game.lastSnapshot.players.find(p => p.id === bot.id)).kit, 'support');
  // An invalid director choice falls back to HQ at once.
  game.mode.setBotDirector({ goalFor: () => null, deployFor: () => ({ spawn: bot.team === 'alpha' ? 'flag:D' : 'flag:A', kit: 'recon', variant: 0 }) });
  game.killPlayer(bot, b, 'rifle', false);
  run(game, CONQUEST_RULES.respawnMs + 100);
  assert.equal(bot.state, 'alive');
  assert(policy.hqPool(bot).some(s => near(s, bot, 0.01)), 'invalid director choice: HQ');
  // A director that returns null keeps the bot waiting until the timeout.
  game.mode.setBotDirector({ goalFor: () => null, deployFor: () => null });
  game.killPlayer(bot, b, 'rifle', false);
  run(game, CONQUEST_RULES.respawnMs + 1000);
  assert.equal(bot.state, 'dead', 'a null deployFor waits (e.g. for a revive)');
  run(game, CONQUEST_RULES.deployTimeoutMs);
  assert.equal(bot.state, 'alive');
  // No director: frontline owned flag.
  game.mode.setBotDirector(null);
  game.killPlayer(bot, b, 'rifle', false);
  run(game, CONQUEST_RULES.respawnMs + 100);
  assert(inRing(bot, policy.flags[2]), 'director-less bots deploy at the frontline flag');
}

// --- bots: the opening life already carries the squad kit mix -----------------------------
{
  const { game, policy } = fixture();
  for (let i = 0; i < 8; i++) game.addBot(`bot-${i}`);
  const bots = [...game.entities.values()].filter(p => p.bot);
  for (const team of ['alpha', 'bravo']) {
    const kits = bots.filter(p => p.team === team).map(p => policy.kitFor(p).kit);
    // Shared BOT_SQUAD_SLOTS: assault, medic, engineer, then one flex kit from the pool.
    for (const kit of ['assault', 'medic', 'engineer']) assert(kits.includes(kit), `${team} opening squad has a ${kit}`);
    assert(kits.every(kit => ['assault', 'medic', 'engineer', ...BOT_FLEX_POOL].includes(kit)), `${team} opening squad mixes kits: ${kits}`);
  }
  for (const p of bots) assert(p.owned.includes(KITS[policy.kitFor(p).kit].primaries[0]), 'loadout follows the seeded kit');
  // A late director registration leaves bots that have been alive a while alone.
  run(game, CONQUEST_RULES.spawnProtectMs + 500);
  const before = bots.map(p => policy.kitFor(p).kit);
  let calls = 0;
  game.mode.setBotDirector({ goalFor: () => null, deployFor: () => { calls++; return { spawn: 'hq', kit: 'recon', variant: 1 }; } });
  assert.equal(calls, 0);
  assert.deepEqual(bots.map(p => policy.kitFor(p).kit), before);
  game.mode.setBotDirector(null);
}

// --- deployOptions: identical on server and client fixtures ------------------------------
{
  const vehicles = [{ id: 'alpha-jeep', team: 'alpha', type: 'jeep', x: 20.5, y: 2, z: 40.5, yaw: 0 },
    { id: 'alpha-tank', team: 'alpha', type: 'tank', x: 20.5, y: 2, z: 120.5, yaw: 0 }];
  const { game, policy, mapMeta } = fixture({ vehicles });
  const ids = ['p1_a', 'p2_b', 'p3_a', 'p4_b', 'p5_a', 'p6_b', 'p7_a', 'p8_b', 'p9_a', 'p10_b'];
  const players = ids.map(id => human(game, id));
  const enemyOnB = players.find(p => p.team === 'bravo');
  place(enemyOnB, 52, 118);
  place(players[2], 99, 81, 1.2);
  place(players[4], 47.3, 41.7, 2.1);
  game.vehicles.enter(Object.assign(players[6], { x: 20.5, y: 2, z: 37.5 }), 'alpha-jeep');
  game.killPlayer(players[0], enemyOnB, 'rifle', false);
  run(game, 3000);
  const snap = JSON.parse(JSON.stringify(game.lastSnapshot));
  const decoded = decodeConquestMatch(snap.match.conquest, mapMeta.conquest);
  const clientView = deployViewFromSnapshot(decoded, snap.players, snap.vehicles, decodeConquestPlayer);
  let compared = 0;
  for (const p of players) {
    const row = snap.players.find(r => r.id === p.id);
    const server = policy.conquestView().deployOptions(p);
    const client = deployOptions(clientView, { id: row.id, team: row.team, squad: decodeConquestPlayer(row).squad });
    assert.deepEqual(client, server, `deployOptions agree for ${p.id}`);
    compared += server.length;
  }
  assert(compared > players.length * 3, 'the fixtures exercise HQ, flag, squad and vehicle options');
  const alphaOpts = policy.conquestView().deployOptions(players[0]);
  assert.deepEqual(alphaOpts.filter(o => o.kind === 'flag').map(o => [o.id, o.ok, o.reason]), [['A', true, null], ['B', false, 'contested']],
    'a lone enemy neutralizing B closes it');
  // Two defenders hold B at full control: the flag is idle, yet an enemy inside still closes it.
  const defenders = players.filter(p => p.team === 'alpha' && p.state === 'alive' && !p.vehicleId).slice(0, 2);
  defenders.forEach((p, i) => place(p, 48 + i, 121));
  run(game, 12000);
  assert.equal(policy.flags[1].state, 'idle');
  assert.equal(policy.flags[1].bravo, 1);
  assert.deepEqual(policy.conquestView().deployOptions(players[0]).filter(o => o.kind === 'flag').map(o => [o.id, o.reason]),
    [['A', null], ['B', 'enemy']], 'an enemy inside the radius closes an idle flag');
}

// --- squads: balance through joins and leaves -----------------------------------------------
{
  const roster = new SquadRoster(4);
  const order = [];
  for (let i = 0; i < 31; i++) { roster.add(`p${i}`, i % 2 ? 'bravo' : 'alpha'); order.push(`p${i}`); }
  const balanced = () => ['alpha', 'bravo'].every(team => {
    const sizes = roster.sizes(team);
    const n = sizes.reduce((s, x) => s + x, 0);
    return sizes.length === Math.ceil(n / 4) && Math.max(...sizes) - Math.min(...sizes) <= 1 && sizes.every(x => x <= 4);
  });
  assert(balanced(), 'balanced after joins');
  let rng = 7;
  for (let i = 0; i < 200; i++) {
    rng = (rng * 1103515245 + 12345) % 2147483648;
    if (order.length > 2 && rng % 3 === 0) roster.remove(order.splice(rng % order.length, 1)[0]);
    else { const id = `q${i}`; roster.add(id, rng % 2 ? 'alpha' : 'bravo'); order.push(id); }
    assert(balanced(), `balanced after step ${i}: ${roster.sizes('alpha')} / ${roster.sizes('bravo')}`);
  }
  const [team, squadId, leader] = roster.tuples()[0];
  const members = roster.membersOf(team, squadId);
  assert.equal(leader, members[0], 'the leader is the longest-standing member');
  roster.remove(leader);
  assert.equal(roster.leaderOf(team, squadId) ?? roster.tuples()[0][2], roster.membersOf(team, squadId)[0] ?? roster.tuples()[0][2], 'leadership passes on');
}

// --- forward spawns beat the old safest-spawn picker on distance to the fight ----------------
{
  const { game, policy } = fixture();
  Object.assign(policy.flags[2], { owner: 'alpha', control: 1 });
  const alphaBots = [], enemies = [];
  for (let i = 0; i < 8; i++) game.addBot(`bot-${i}`);
  for (const p of game.entities.values()) (p.team === 'alpha' ? alphaBots : enemies).push(p);
  enemies.forEach((p, i) => place(p, 150 + (i % 3) * 6, 60 + i * 6));
  alphaBots.forEach((p, i) => place(p, 6, 72 + i * 3));
  const nearest = p => Math.min(...enemies.map(e => Math.hypot(e.x - p.x, e.z - p.z)));
  const median = list => list.slice().sort((x, y) => x - y)[Math.floor(list.length / 2)];
  const oldPool = p => [...policy.hqPool(p), ...policy.flags.filter(f => f.owner === 'alpha').flatMap(f => f.spawns)];
  const before = [], after = [];
  for (let round = 0; round < 6; round++) {
    for (const bot of alphaBots) {
      before.push(nearest(game.selectSafestSpawn(oldPool(bot), bot, -1)));
      game.killPlayer(bot, enemies[0], 'rifle', false);
    }
    run(game, CONQUEST_RULES.respawnMs + 100);
    for (const bot of alphaBots) { assert.equal(bot.state, 'alive'); after.push(nearest(bot)); }
    alphaBots.forEach((p, i) => place(p, 6, 72 + i * 3));
    enemies.forEach((p, i) => place(p, 150 + (i % 3) * 6, 60 + i * 6));
  }
  assert(median(after) < median(before), `median spawn-to-enemy ${median(after).toFixed(1)} m < old picker ${median(before).toFixed(1)} m`);
}

console.log('Conquest deploy: respawn gate, flag cells (40 m sight, away from enemy flags, variety), contested/enemy/invalid/seat/busy/cooldown refusals, HQ timeout fallback, squad ring spawn with damage lock and cooldown, vehicle seat deploy, director bots at respawnAt, opening-life squad kit mix, shared deployOptions parity, balanced squads and closer forward spawns passed.');
