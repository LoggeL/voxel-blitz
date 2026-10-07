// Conquest airborne rules: fall damage (curve, kill credit, water), the
// parachute (open, descent, glide, steer, cut, landing, no fire), bots' auto
// chute and bail-out, the jet ejection seat, bot seat takeover (deploy, enter,
// seat swap, airborne pilot handover) and the cq[7] snapshot field.
import assert from 'node:assert/strict';
import { GameEngine } from '../server/game.js';
import { TICK_MS } from '../server/protocol/admission.js';
import { CONQUEST_RULES, CONQUEST_DEATH_KEYS, CONQUEST_EVENT_KINDS, decodeConquestPlayer } from '../shared/conquest-contract.js';
import { deployOptions, deployViewFromSnapshot, resolveDeployChoice, isBotId } from '../shared/conquest.js';
import { CHUTE, EJECTION, FALL_DAMAGE, PARACHUTE, fallDamage, groundClearance, stepChuteState } from '../shared/parachute.js';
import { GRAVITY } from '../shared/combatmath.js';
import { MC_WATER } from '../shared/world/blocks.js';
import { PlayerPhysics } from '../public/js/player-physics.js';
import { ConquestAircraftDriving, BAIL_PILOTLESS_MS } from '../server/bot-aircraft.js';
import { SEAT_TAKEOVER_GRACE_SECONDS } from '../server/sim/vehicles.js';

const SX = 200, SY = 96, SZ = 160, FLOOR = 2;
// A pool 3 blocks deep at x 120..129, z 20..29 (water surface at y = FLOOR).
const pool = (x, z) => x >= 120 && x < 130 && z >= 20 && z < 30;
const spot = (x, z) => ({ x: x + 0.5, y: FLOOR, z: z + 0.5 });
function fixture({ vehicles = [] } = {}) {
  const hq = (team, x) => ({ id: team, name: `${team} HQ`, ...spot(x, 80), radius: 12, spawns: [spot(x, 76), spot(x, 80), spot(x, 84)] });
  const bases = { alpha: hq('alpha', 8), bravo: hq('bravo', SX - 9) };
  const mapMeta = { id: 'frontier', dimensions: { sx: SX, sy: SY, sz: SZ },
    spawns: { conquest: { alpha: bases.alpha.spawns, bravo: bases.bravo.spawns } },
    conquest: { version: 2, bases, combatArea: { minX: 2, maxX: SX - 2, minZ: 2, maxZ: SZ - 2 }, vehicleSpawns: vehicles, flags: [] } };
  const getBlock = (x, y, z) => {
    if (x < 0 || z < 0 || x >= SX || z >= SZ) return 1;
    if (pool(x, z)) return y < FLOOR - 3 ? 1 : y < FLOOR ? MC_WATER : 0;
    return y < FLOOR ? 1 : 0;
  };
  const world = { dimensions: { sx: SX, sy: SY, sz: SZ }, getBlock, findSpawns: () => [spot(20, 20)], setBlock: () => {} };
  const events = [];
  const game = new GameEngine({ mode: 'conquest', mapMeta, world, broadcast: snap => { events.push(...snap.events); game.lastSnapshot = snap; } });
  return { game, events, policy: game.mode.policy };
}
const run = (game, ms) => { for (let t = 0; t < ms - 1e-6; t += TICK_MS) game.step(TICK_MS); };
const until = (game, test, ms = 30000) => { for (let t = 0; t < ms; t += TICK_MS) { if (test()) return true; game.step(TICK_MS); } return test(); };
const human = (game, id, team = 'alpha') => { game.addClient(id, id); const p = game.entities.get(id); game.mode.policy.setLobbyTeam(p, team); return p; };
const bot = (game, id, team = 'alpha') => { game.addBot(id); const p = game.entities.get(id); game.mode.policy.setLobbyTeam(p, team); return p; };
const place = (p, x, y, z) => Object.assign(p, { x: x + 0.5, y, z: z + 0.5, vx: 0, vy: 0, vz: 0, grounded: false, spawnProtected: false, spawnProtectedUntil: 0, hp: 100, armor: 0 });
const input = (game, p, keys = {}, extra = {}) => game.applyInput(p.id, { keys, yaw: 0, pitch: 0, ...extra });
const kills = events => events.filter(e => e.kind === 'kill');
const rowOf = (game, p) => game.lastSnapshot.players.find(row => row.id === p.id);
let checks = 0;
const check = (value, message) => { assert(value, message); checks++; };

// --- shared curve -------------------------------------------------------------------
{
  const landing = h => Math.sqrt(2 * GRAVITY * h);
  check(fallDamage(landing(1.4)) === 0, 'a jump lands free');
  check(fallDamage(landing(4)) === 0, 'a 4 m terrace drop is free');
  check(fallDamage(Math.hypot(8.2, landing(4))) === 0, 'jumping off a 4 m terrace is free');
  const ten = fallDamage(landing(10));
  check(ten > 45 && ten < 65, `10 m hurts a lot (${ten.toFixed(1)})`);
  check(fallDamage(landing(15)) >= 100, '15 m is lethal');
  check(fallDamage(landing(40)) === FALL_DAMAGE.maxDamage, 'damage caps at maxDamage');
  check(CONQUEST_DEATH_KEYS.includes('fall') && CONQUEST_EVENT_KINDS.includes('ejection'), 'contract lists the fall key and the ejection event');
  check(isBotId('bot-3') && !isBotId('p1_abc') && !isBotId(null), 'bot ids are bot-<n>');
  const solid = (x, y) => y < 2;
  check(groundClearance(solid, null, 5, 12, 5) === 10, 'clearance measures to the floor top');
  check(stepChuteState({ chute: 0, grounded: false, vy: -10, x: 5, y: 7, z: 5 }, { jumpPressed: true, solidAt: solid }).chute === CHUTE.none,
    'no chute below minHeight');
  check(stepChuteState({ chute: 0, grounded: false, vy: -10, x: 5, y: 2 + PARACHUTE.minHeight + 1, z: 5 }, { jumpPressed: true, solidAt: solid }).chute === CHUTE.open,
    'Jump opens a chute above minHeight');
}

// --- fall damage: hurt, lethal self death, credited fall, deep water ---------------------
{
  const { game, events } = fixture();
  const a = human(game, 'p1_a'), b = human(game, 'p2_b', 'bravo');
  place(b, 180, FLOOR, 140);
  place(a, 40, FLOOR + 3.5, 40); input(game, a);
  until(game, () => a.grounded, 3000);
  check(a.hp === 100, 'a 3.5 m drop costs nothing');
  place(a, 40, FLOOR + 10, 40); input(game, a);
  until(game, () => a.grounded, 3000);
  check(a.hp > 35 && a.hp < 55 && a.state === 'alive', `a 10 m fall hurts (hp ${a.hp.toFixed(1)})`);
  check(events.some(e => e.kind === 'hit' && e.victim === a.id && e.attacker === ''), 'fall damage shows as a world hit');
  place(a, 40, FLOOR + 18, 40);
  until(game, () => a.state !== 'alive', 4000);
  const self = kills(events).at(-1);
  check(self?.victim === a.id && self.w === 'fall' && self.killer === '', 'a lethal fall is a self "fall" death');

  // An enemy's hit within FALL_DAMAGE.creditMs credits the fall.
  const c = human(game, 'p3_a');
  place(c, 60, FLOOR + 18, 60); input(game, c);
  c.takeDamage(10, false, b, 'rifle');
  until(game, () => c.state !== 'alive', 4000);
  const credited = kills(events).at(-1);
  check(credited?.victim === c.id && credited.killer === b.id && credited.w === 'fall', 'the enemy who hit you before the fall gets the kill');

  // Deep water cushions the same fall.
  const d = human(game, 'p4_a');
  place(d, 124, FLOOR + 14, 24); input(game, d);
  run(game, 3000);
  check(d.state === 'alive' && d.hp === 100, 'a 14 m fall into 3 m of water is free');
}

// --- parachute: open, sink, glide, steer, cut, re-open, land, no fire, snapshot ----------
{
  const { game } = fixture();
  const a = human(game, 'p1_a');
  place(a, 100, FLOOR + 60, 80); input(game, a);
  run(game, 400);
  check((a.chute | 0) === CHUTE.none, 'no canopy before Jump');
  input(game, a, { jump: true });
  run(game, TICK_MS);
  check(a.chute === CHUTE.open, 'Jump in a long fall opens the canopy');
  check(game.mode.policy.canFire(a) === false, 'no weapon fires under the canopy');
  run(game, 50);
  check(decodeConquestPlayer(rowOf(game, a)).chute === CHUTE.open && rowOf(game, a).cq.length === 8, 'cq[7] publishes the open canopy');
  input(game, a, {});
  run(game, 2000);
  check(Math.abs(a.vy + PARACHUTE.descent) < 0.4, `the canopy sinks at ~${PARACHUTE.descent} m/s (${a.vy.toFixed(2)})`);
  const glide = -a.vz;
  check(Math.abs(glide - PARACHUTE.glide) < 0.6, `it glides along the look direction (${glide.toFixed(2)})`);
  input(game, a, { r: true });
  run(game, 2500);
  check(a.vx > PARACHUTE.steer * 0.7, `D steers right (${a.vx.toFixed(2)})`);
  input(game, a, { jump: true }); run(game, TICK_MS);
  check(a.chute === CHUTE.none, 'Jump again cuts the canopy');
  input(game, a, {}); run(game, 300);
  check(a.vy < -6, 'free fall resumes');
  input(game, a, { jump: true }); run(game, TICK_MS);
  check(a.chute === CHUTE.open, 'it can be opened again while high enough');
  input(game, a, {});
  until(game, () => a.grounded, 30000);
  check(a.chute === CHUTE.none && a.hp === 100, 'landing closes it without fall damage');
  run(game, 50);
  check(rowOf(game, a).cq.length === 7, 'grounded rows keep seven cq entries');
  check(game.mode.policy.canFire(a) === true, 'weapons work again on the ground');
  // A jump from the ground never opens a canopy.
  input(game, a, { jump: true }); run(game, 200); input(game, a, {}); run(game, 600);
  check(a.chute === CHUTE.none, 'no canopy on an ordinary jump');
}

// --- client prediction tracks the authority under the canopy ------------------------------
{
  const { game } = fixture();
  const a = human(game, 'p1_a');
  place(a, 100, FLOOR + 50, 80); input(game, a);
  const physics = new PlayerPhysics();
  physics.airRules = true;
  physics._solidAt = (x, y, z) => game.solidAt(x, y, z);
  physics._fluidAt = () => false;
  physics.pos = { x: a.x, y: a.y, z: a.z }; physics.vel = { x: 0, y: 0, z: 0 }; physics.grounded = false;
  const steps = (n, keys, wish) => { for (let i = 0; i < n; i++) { input(game, a, keys); game.step(TICK_MS);
    physics.step(TICK_MS / 1000, wish, 4.4, !!keys.jump, 0, 0); } };
  steps(20, {}, { x: 0, z: 0 });
  steps(1, { jump: true }, { x: 0, z: 0 });
  check(physics.chute === CHUTE.open && a.chute === CHUTE.open, 'prediction opens the canopy on the same tick');
  check(physics.adoptChute(CHUTE.none) === false && physics.chute === CHUTE.open, 'a stale snapshot right after a toggle is not adopted');
  steps(120, { f: true }, { x: 0, z: -1 });
  check(Math.hypot(physics.pos.x - a.x, physics.pos.y - a.y, physics.pos.z - a.z) < 0.05, 'predicted canopy flight matches the authority');
  check(physics.adoptChute(CHUTE.seat) === true && physics.chute === CHUTE.seat, 'a server-side seat ride is adopted');
  check(physics.chutePrompt() === 'seat', 'the HUD prompt follows the predicted state');
}

// --- bots: auto chute when ejected/falling, bail-out policy ------------------------------
{
  const { game } = fixture();
  const b = bot(game, 'bot-1');
  place(b, 70, FLOOR + 40, 70);
  until(game, () => b.chute === CHUTE.open, 3000);
  check(b.chute === CHUTE.open, 'a falling bot opens its canopy itself');
  until(game, () => b.grounded, 30000);
  check(b.state === 'alive' && b.hp === 100, 'the bot lands unhurt');
  // A short drop never needs a canopy and costs nothing.
  place(b, 70, FLOOR + 3, 70);
  until(game, () => b.grounded, 3000);
  check(b.chute === CHUTE.none && b.hp === 100, 'no canopy on a short drop');

  const air = new ConquestAircraftDriving({ game: null });
  const hull = { id: 'h', type: 'transport', grounded: false, hp: 600, seatOccupants: { driver: null, 'rear-left': 'bot-2' } };
  const rider = { id: 'rear-left', drives: false };
  check(air.shouldBail(hull, rider, 0) === false, 'riders wait a moment for a pilot');
  let bailed = false;
  for (let t = 100; t <= BAIL_PILOTLESS_MS + 100 && !bailed; t += 100) bailed = air.shouldBail(hull, rider, t) ? t : false;
  check(bailed >= BAIL_PILOTLESS_MS, `riders bail out of a pilotless aircraft (${bailed} ms)`);
  check(air.shouldBail(hull, rider, 99999) === false, 'a stale pilotless record starts over');
  check(air.shouldBail({ ...hull, seatOccupants: { driver: 'p1', 'rear-left': 'bot-2' } }, rider, 10000) === false, 'a piloted aircraft keeps its riders');
  check(air.shouldBail({ ...hull, seatOccupants: { driver: 'bot-3' }, burning: true, hp: 50 }, { id: 'driver', drives: true }, 0) === false,
    'a bot pilot rides a burning aircraft on (a long canopy ride costs more than a redeploy)');
  check(air.shouldBail({ ...hull, grounded: true }, rider, 99999) === false, 'nobody bails out on the ground');
}

// --- jet ejection seat --------------------------------------------------------------------
{
  const { game, events } = fixture({ vehicles: [{ id: 'jet', team: 'alpha', type: 'plane', x: 100.5, y: FLOOR, z: 120.5, yaw: 0 }] });
  const a = human(game, 'p1_a');
  const jet = game.vehicles.vehicles.get('jet');
  place(a, 100, FLOOR, 120);
  check(game.vehicles.enter(a, 'jet'), 'the pilot boards');
  // Ground exit: an ordinary dismount, no seat.
  input(game, a, {}, { vehicleAction: { type: 'exit' } });
  check(!a.vehicleId && a.chute !== CHUTE.seat, 'leaving a parked jet is an ordinary exit');
  place(a, 100, FLOOR, 120); check(game.vehicles.enter(a, 'jet'), 'the pilot boards again');
  Object.assign(jet, { y: 60, grounded: false, gearDown: false, vx: 0, vy: 0, vz: -50, speed: 50, airspeed: 50, throttle: 1, enginePower: 1, pitch: 0, roll: 0 });
  game.vehicles.syncCrew(jet);
  const impulse = a.impulseSeq | 0;
  input(game, a, {}, { vehicleAction: { type: 'exit' } });
  check(a.vehicleId == null && a.chute === CHUTE.seat && a.chuteT === EJECTION.seatSeconds, 'exiting a flying jet fires the ejection seat');
  check(a.vy > EJECTION.launchSpeed * 0.8 && a.impulseSeq === impulse + 1, `the seat launches upward (${a.vy.toFixed(1)} m/s) and clients adopt it`);
  check(Math.hypot(a.vx, a.vz) <= EJECTION.maxCarry + 1e-6 && a.vz < -20, 'the pilot keeps part of the jet momentum');
  const ejection = game.tickEvents.find(e => e.kind === 'ejection');
  check(ejection?.id === a.id && ejection.vehicleId === 'jet' && ejection.pos.length === 3, 'an ejection event drives the effects');
  check(jet.occupantId == null && !jet.engineOn, 'the jet flies on without a pilot');
  run(game, 50);
  check(decodeConquestPlayer(rowOf(game, a)).chute === CHUTE.seat, 'cq[7] publishes the seat ride');
  const y0 = a.y;
  run(game, EJECTION.seatSeconds * 1000 + 50);
  check(a.chute === CHUTE.open && a.y > y0, 'the canopy opens by itself above the ejection point');
  until(game, () => a.grounded, 40000);
  check(a.state === 'alive' && a.hp === 100, 'the pilot lands unhurt');
  until(game, () => !(jet.hp > 0), 40000);
  check(!(jet.hp > 0), 'the empty jet crashes');
  check(events.some(e => e.kind === 'ejection'), 'the ejection reached the snapshot');
}

// --- a hull lost to its own crash: crew deaths read 'crash', never a self roadkill -------
{
  const { game, events } = fixture({ vehicles: [{ id: 'heli', team: 'alpha', type: 'helicopter', x: 100.5, y: FLOOR, z: 60.5, yaw: 0 }] });
  const heli = game.vehicles.vehicles.get('heli');
  const pilot = human(game, 'p1_a'), gunner = bot(game, 'bot-1');
  for (const p of [pilot, gunner]) { place(p, 100, FLOOR, 60); game.vehicles.enter(p, 'heli'); }
  // Dive straight into the ground at full speed.
  Object.assign(heli, { y: FLOOR + 40, grounded: false, rotorSpeed: 1, enginePower: 1, vx: 0, vy: -40, vz: -10, pitch: 0.3 });
  game.vehicles.syncCrew(heli);
  until(game, () => !(heli.hp > 0), 8000);
  const crew = kills(events).filter(e => e.victim === pilot.id || e.victim === gunner.id);
  check(!(heli.hp > 0) && crew.length === 2 && crew.every(e => e.w === 'crash' && e.killer === ''),
    `crash victims carry the 'crash' key and no killer (${crew.map(e => `${e.killer}/${e.w}`)})`);
}

// --- bot seat takeover: enter, F-key seat, swap, human never ejected ---------------------
{
  const { game } = fixture({ vehicles: [{ id: 'tank', team: 'alpha', type: 'tank', x: 60.5, y: FLOOR, z: 60.5, yaw: 0 }] });
  const tank = game.vehicles.vehicles.get('tank');
  const b1 = bot(game, 'bot-1'), b2 = bot(game, 'bot-2'), h = human(game, 'p1_a'), h2 = human(game, 'p2_a');
  for (const p of [b1, b2, h, h2]) place(p, 60, FLOOR, 60);
  check(game.vehicles.enter(b1, 'tank', 'driver') && game.vehicles.enter(b2, 'tank', 'commander'), 'two bots crew the tank');
  check(game.vehicles.enter(h, 'tank', 'commander'), 'a human takes the requested seat from a bot');
  check(tank.seatOccupants.commander === h.id && !b2.vehicleId && b2.state === 'alive', 'the bot is put out beside the hull');
  check(Math.hypot(b2.x - tank.x, b2.z - tank.z) > 1.5 && Math.abs(b2.y - FLOOR) < 0.6, 'the bot stands on the ground beside the hull');
  // F1 from the commander seat swaps with the bot driver.
  check(game.vehicles.switchSeat(h, 'driver'), 'switching to a bot seat swaps');
  check(tank.seatOccupants.driver === h.id && tank.seatOccupants.commander === b1.id && b1.vehicleSeatId === 'commander' && tank.occupantId === h.id,
    'the human drives, the bot moves to the commander seat');
  // A bot never takes a human's seat, and a human never ejects a human.
  place(b2, 60, FLOOR, 60);
  check(game.vehicles.enter(b2, 'tank', 'driver') === false, 'a bot cannot take a human seat');
  for (const p of [b1, b2, h, h2]) { if (p.vehicleId) game.vehicles.exit(p); place(p, 60, FLOOR, 60); }
  check(game.vehicles.enter(h, 'tank', 'driver') && game.vehicles.enter(b1, 'tank', 'commander'), 'human driver, bot commander');
  check(game.vehicles.enter(h2, 'tank', 'driver') === false, 'a human never ejects another human');
  check(game.vehicles.enter(h2, 'tank') && h2.vehicleSeatId === 'commander' && !b1.vehicleId, 'plain entry takes the bot seat');
  check(game.vehicles.enter(b1, 'tank') === false, 'a full human crew turns bots away');
}

// --- deploy into a bot seat (shared options, deploy screen data, server deploy) -----------
{
  const view = { flags: [], players: [{ id: 'bot-4', team: 'alpha', state: 'alive', bot: true }, { id: 'p9_x', team: 'alpha', state: 'alive' }],
    vehicles: [{ id: 'jeep', type: 'jeep', team: 'alpha', hp: 300, seatOccupants: { driver: 'bot-4', gunner: 'p9_x', 'front-passenger': 'p9_x', 'rear-left': 'p9_x' } }] };
  const forHuman = deployOptions(view, { id: 'me', team: 'alpha', squad: 0 }).find(o => o.kind === 'vehicle');
  check(forHuman.ok && forHuman.seats.length === 0 && forHuman.takeover?.join() === 'driver', 'a full hull with a bot is a takeover option for humans');
  check(resolveDeployChoice([forHuman], 'vehicle:jeep').seatId === 'driver' && resolveDeployChoice([forHuman], 'vehicle:jeep:driver').takeover === true,
    'the bot seat resolves');
  check(resolveDeployChoice([forHuman], 'vehicle:jeep:gunner').reason === 'seat', 'a human-held seat stays closed');
  const asBot = deployOptions(view, { id: 'bot-9', team: 'alpha', squad: 0, bot: true }).find(o => o.kind === 'vehicle');
  check(!asBot.ok && asBot.reason === 'seat', 'bots never deploy into a bot seat');
  // A squad mate flying an aircraft is a spawn into that aircraft, not "target is busy".
  const air = { flags: [], players: [{ id: 'bot-5', team: 'alpha', state: 'alive', bot: true, squad: 1, vehicleId: 'heli', x: 1, z: 1 },
    { id: 'bot-6', team: 'alpha', state: 'alive', bot: true, squad: 1, vehicleId: 'jet', x: 1, z: 1 }],
    vehicles: [{ id: 'heli', type: 'helicopter', team: 'alpha', hp: 600, seatOccupants: { driver: 'bot-5', gunner: null } },
      { id: 'jet', type: 'plane', team: 'alpha', hp: 400, seatOccupants: { driver: 'bot-6' } }] };
  const squadOptions = deployOptions(air, { id: 'me', team: 'alpha', squad: 1 }).filter(o => o.kind === 'squad');
  check(squadOptions.every(o => o.ok) && squadOptions[0].seatId === 'gunner' && squadOptions[1].seatId === 'driver',
    'a mate in a heli seats you as gunner, a mate in a full jet hands you the bot pilot seat');
  check(resolveDeployChoice(squadOptions, 'squad:bot-5').seatId === 'gunner', 'the squad choice resolves to the aircraft seat');
  const fromRows = deployViewFromSnapshot({ flags: [] }, [{ id: 'bot-4', team: 'alpha', state: 'alive' }], view.vehicles);
  check(fromRows.players[0].bot === true, 'clients recognise bot rows by id');

  const { game, policy } = fixture({ vehicles: [{ id: 'heli', team: 'alpha', type: 'helicopter', x: 60.5, y: FLOOR, z: 60.5, yaw: 0 }] });
  const heli = game.vehicles.vehicles.get('heli');
  const pilot = bot(game, 'bot-1'), gunner = bot(game, 'bot-2'), h = human(game, 'p1_a'), enemy = human(game, 'p2_b', 'bravo');
  place(enemy, 190, FLOOR, 150);
  for (const p of [pilot, gunner]) { place(p, 60, FLOOR, 60); game.vehicles.enter(p, 'heli'); }
  // The heli hovers 30 m up when the human deploys into its pilot seat.
  Object.assign(heli, { y: FLOOR + 30, grounded: false, rotorSpeed: 1, enginePower: 1, vx: 0, vy: 0, vz: 0, pitch: 0, roll: 0 });
  game.vehicles.syncCrew(heli);
  game.killPlayer(h, enemy, 'rifle', false);
  check(game.mode.conquestIntent(h, { type: 'deploy', spawn: 'vehicle:heli:driver', kit: 'assault', variant: 0 }), 'a bot seat is a valid deploy choice');
  until(game, () => h.state === 'alive', CONQUEST_RULES.respawnMs + 2000);
  check(h.vehicleId === 'heli' && h.vehicleSeatId === 'driver' && heli.occupantId === h.id, 'the human deploys into the pilot seat');
  check(!pilot.vehicleId && pilot.state === 'alive' && gunner.vehicleSeatId === 'gunner', 'only the bot pilot is put out');
  // The human's client is still on the deploy screen: a stale packet without mounted controls.
  const yaw0 = heli.yaw, alt0 = heli.y;
  for (let i = 0; i < 30; i++) { game.applyInput(h.id, { keys: {}, yaw: yaw0 + 2, pitch: -0.9 }); game.step(TICK_MS); }
  check(Math.abs(heli.yaw - yaw0) < 0.1 && Math.abs(heli.y - alt0) < 2.5, `the hull holds steady through the handover (Δyaw ${(heli.yaw - yaw0).toFixed(3)}, Δy ${(heli.y - alt0).toFixed(2)})`);
  check(SEAT_TAKEOVER_GRACE_SECONDS >= 0.5, 'the handover grace lasts long enough for a round trip');
  // A squad mate of the new pilot spawns on them: into the aircraft, taking the bot gunner's seat.
  const mate = human(game, 'p3_a');
  check(policy.squads.areSquadmates(mate.id, h.id), 'fixture: squad mates');
  game.killPlayer(mate, enemy, 'rifle', false);
  check(game.mode.conquestIntent(mate, { type: 'deploy', spawn: `squad:${h.id}`, kit: 'assault', variant: 0 }), 'a mate in an aircraft is a valid squad spawn');
  until(game, () => mate.state === 'alive', CONQUEST_RULES.respawnMs + 2000);
  check(mate.vehicleId === 'heli' && mate.vehicleSeatId === 'gunner' && !gunner.vehicleId, 'the squad spawn seats the mate in the aircraft');
  until(game, () => pilot.grounded, 30000);
  check(pilot.state === 'alive' && pilot.hp === 100, 'the bot pilot parachutes down unhurt');
  // A seat held by a human is never a deploy target for another human.
  const options = policy.conquestView().deployOptions(enemy);
  check(!options.some(o => o.kind === 'vehicle' && o.id === 'heli'), 'enemy hulls are not offered');
}

console.log(`conquest-airborne-test: ${checks} checks passed`);
