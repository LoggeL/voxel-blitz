// Conquest ammo pouches from the fallen (docs/conquest.md "Infantry supply" ->
// "Ammo pouches"), through the real GameEngine tick: a death on foot drops one
// pouch at the body, a death in (or with) a hull or out of the world drops
// none, either team takes it (one magazine), a full reserve leaves it, it
// expires after 30 s, the room keeps at most 32 (the oldest goes first), and
// the `pch` wire list rides only change and keyframe ticks. Plus the client
// view and the bot detour.
import assert from 'node:assert/strict';
import { GameEngine } from '../server/game.js';
import { TICK_MS } from '../server/protocol/admission.js';
import { CONQUEST_CONTRACT_VERSION, CONQUEST_EVENT_KINDS } from '../shared/conquest-contract.js';
import { kitLoadout } from '../shared/conquest-kits.js';
import { AMMO_POUCH_RULES, decodeAmmoPouches, encodeAmmoPouches, primaryReserveFraction } from '../shared/ammo-pouches.js';
import { pouchGoal } from '../server/bot-pouches.js';
import { PouchView } from '../public/js/engine/pouch-view.js';
import { CONQUEST_POUCH_BUDGET_BYTES, conquestMatchBytes, CONQUEST_MATCH_BUDGET_BYTES } from './lib/protocol-contract.mjs';

const R = AMMO_POUCH_RULES;

// ---------------------------------------------------------------- contract and codec
assert.equal(CONQUEST_CONTRACT_VERSION, 8, 'the pouches are contract v8');
assert.equal(CONQUEST_EVENT_KINDS[CONQUEST_EVENT_KINDS.indexOf('fpv') + 1], 'ammo_pouch', 'ammo_pouch is appended after fpv');
assert.deepEqual([R.lifetimeMs, R.maxActive, R.radius, R.grant.mags, R.grant.grenades], [30000, 32, 1.6, 1, 0]);
assert.deepEqual(encodeAmmoPouches([{ id: 7, x: 10.04, y: 2, z: -3.26 }]), [[7, 10, 2, -3.3]]);
assert.deepEqual(decodeAmmoPouches([[7, 10, 2, -3.3], ['x'], null]), [{ id: 7, x: 10, y: 2, z: -3.3 }]);
assert.equal(decodeAmmoPouches(undefined), null, 'an absent list decodes to null (keep what is shown)');

// ---------------------------------------------------------------- engine fixture
const SX = 128, SY = 32, SZ = 128;
const world = { dimensions: { sx: SX, sy: SY, sz: SZ }, getBlock: (x, y, z) => (x < 0 || z < 0 || x >= SX || z >= SZ || y < 2 ? 1 : 0),
  findSpawns: () => [{ x: 20, y: 2, z: 20 }], setBlock: () => true };
const events = [];
const game = new GameEngine({ mode: 'conquest', world,
  mapMeta: { id: 'frontier', dimensions: world.dimensions,
    spawns: { conquest: { alpha: [{ x: 10.5, y: 2, z: 10.5 }], bravo: [{ x: 110.5, y: 2, z: 110.5 }] } },
    conquest: { flags: [], bases: {}, vehicleSpawns: [{ id: 'alpha-tank', team: 'alpha', type: 'tank', x: 40.5, y: 2, z: 40.5, yaw: 0 }] } },
  broadcast: snap => { events.push(...snap.events); game.lastSnapshot = snap; } });
const policy = game.mode.policy;
const step = (n = 1) => { for (let i = 0; i < n; i++) game.step(TICK_MS); };
const join = id => { game.addClient(id, id); return game.entities.get(id); };
const place = (p, x, z) => Object.assign(p, { x, y: 2, z, vx: 0, vy: 0, vz: 0, spawnProtectedUntil: 0, spawnProtected: false });
const revive = (p, x, z) => {
  Object.assign(p, { state: 'alive', hp: 100, vehicleId: null });
  policy._state(p).deathHandled = false;
  policy.roles.onRespawn?.(p);
  policy.roles.applyLoadout(p, 'assault', 0, 0);
  place(p, x, z);
};
const slot = kitLoadout('assault', 0, 0).weapon;
const full = kitLoadout('assault', 0, 0).reserve[slot];
const pch = () => game.lastSnapshot?.match?.conquest?.pch;
const ids = [...'abcd'].map(c => join(`p_${c}`));
step();
const alpha = ids.filter(p => policy.teamFor(p) === 'alpha'), bravo = ids.filter(p => policy.teamFor(p) === 'bravo');
assert.ok(alpha.length >= 2 && bravo.length >= 2, 'two per team');
const [a1, a2] = alpha, [b1, b2] = bravo;
for (const [p, x] of [[a1, 60], [a2, 64], [b1, 90], [b2, 94]]) revive(p, x + 0.5, 80.5);
step();

// ---------------------------------------------------------------- a death on foot drops one pouch at the body
assert.equal(policy.pouches.size, 0);
game.killPlayer(a1, b1, 'rifle', false);
assert.equal(policy.pouches.size, 1, 'one pouch per infantry death on foot');
const dropped = [...policy.pouches.pouches.values()][0];
assert.ok(Math.abs(dropped.x - 60.5) < 1e-9 && Math.abs(dropped.z - 80.5) < 1e-9 && dropped.y === 2, 'at the body on the floor');
step();
assert.deepEqual(pch(), [[dropped.id, 60.5, 2, 80.5]], 'the change tick carries the list');
step();
assert.equal(pch(), undefined, 'an unchanged tick does not resend it');

// ---------------------------------------------------------------- a full reserve leaves it; either team takes it
place(b2, 60.5 + 1.0, 80.5);
b2.reserve[slot] = full;
step();
assert.equal(policy.pouches.size, 1, 'a soldier with a full reserve leaves the pouch');
events.length = 0;
b2.reserve[slot] = 0;
step();
assert.equal(policy.pouches.size, 0, 'an enemy with room takes the pouch');
assert.ok(b2.reserve[slot] > 0 && b2.reserve[slot] < full, 'one magazine, not a full refill');
const took = events.find(e => e.kind === 'ammo_pouch');
assert.ok(took && took.id === b2.id && took.pouch === dropped.id && took.rounds === b2.reserve[slot], 'ammo_pouch event for the picker');
assert.deepEqual(pch(), [], 'the emptied list is sent once');
step();
assert.equal(pch(), undefined, 'then nothing while no pouch lies');

revive(a1, 60.5, 80.5);
game.killPlayer(b1, a1, 'rifle', false);
place(a2, 90.5, 81.2); a2.reserve[slot] = 0;
step();
assert.equal(policy.pouches.size, 0, 'a soldier of the dead one\'s enemy team (or its own) takes it too');
assert.ok(a2.reserve[slot] > 0);

// ---------------------------------------------------------------- no pouch from hull deaths or a fall out of the world
revive(b1, 90.5, 80.5);
const tank = game.vehicles.vehicles.get('alpha-tank');
place(a2, tank.x + 2, tank.z);
assert.equal(game.vehicles.action(a2, { type: 'enter', vehicleId: 'alpha-tank' }), true, 'crew boards the hull');
step();
game.killPlayer(a2, b1, 'rifle', false); // shot in the seat (released before the hook)
assert.ok(policy._state(a2).deathHandled, 'the seated death reached the mode');
assert.equal(policy.pouches.size, 0, 'a crew member killed in the seat drops none');
revive(a2, tank.x + 2, tank.z);
assert.equal(game.vehicles.action(a2, { type: 'enter', vehicleId: 'alpha-tank' }), true);
step();
game.vehicles.destroy(tank, b1);
step();
assert.equal(a2.state, 'dead', 'crew dies with the hull');
assert.equal(policy.pouches.size, 0, 'a crew member of a destroyed hull drops none');
revive(a2, 30.5, 30.5);
for (const weapon of ['void', 'world', 'restricted', 'redeploy']) {
  revive(a2, 30.5, 30.5);
  game.killPlayer(a2, null, weapon, false);
  assert.ok(policy._state(a2).deathHandled, `the ${weapon} death reached the mode`);
  assert.equal(policy.pouches.size, 0, `a ${weapon} death drops none`);
}

// ---------------------------------------------------------------- 30 s expiry
revive(a2, 30.5, 30.5);
game.killPlayer(a2, b1, 'rifle', false);
assert.equal(policy.pouches.size, 1);
for (const p of [a1, b1, b2]) place(p, 100.5, 20.5 + ids.indexOf(p) * 3);
step(Math.ceil((R.lifetimeMs - 2 * TICK_MS) / TICK_MS));
assert.equal(policy.pouches.size, 1, 'still there just before 30 s');
let keyframes = 0;
step(4);
assert.equal(policy.pouches.size, 0, 'gone after 30 s');

// ---------------------------------------------------------------- the 32 cap (the oldest goes first) and the wire budget
revive(a2, 30.5, 30.5);
a2.state = 'dead';
const first = policy.pouches._nextId;
for (let i = 0; i < 40; i++) { a2.x = 10.5 + (i % 10) * 3; a2.z = 10.5 + Math.floor(i / 10) * 3; policy.pouches.onDeath(a2, { weapon: 'rifle' }); }
assert.equal(policy.pouches.size, R.maxActive, 'at most 32 per room');
assert.equal([...policy.pouches.pouches.keys()][0], first + 8, 'the eight oldest went first');
step();
const list = pch();
assert.equal(list.length, 32);
const bytes = Buffer.byteLength(JSON.stringify(list));
assert.ok(bytes <= CONQUEST_POUCH_BUDGET_BYTES, `a full list ${bytes} B fits ${CONQUEST_POUCH_BUDGET_BYTES} B`);
assert.ok(conquestMatchBytes(game.lastSnapshot.match.conquest) <= CONQUEST_MATCH_BUDGET_BYTES, 'the base match.conquest keeps its budget');
for (let t = 0; t < Math.ceil(5000 / TICK_MS); t++) { step(); if (pch()) keyframes++; }
assert.ok(keyframes >= 2 && keyframes <= 3, `a keyframe every ${R.keyframeMs} ms (${keyframes} in 5 s), never per tick`);

// ---------------------------------------------------------------- bots
{
  const bot = { id: 'bot', state: 'alive', x: 10.5, y: 2, z: 10.5, reserve: a1.reserve.slice() };
  policy.roles.applyLoadout(a1, 'assault', 0, 0);
  const loadout = { kit: 'assault', variant: 0, gadget: 0 };
  const fakeGame = { mode: { policy: { pouches: policy.pouches, roles: { loadoutOf: () => loadout } } } };
  const goal = { kind: 'capture', target: { x: 0, y: 2, z: 0 } };
  bot.reserve[slot] = Math.floor(full * 0.4);
  assert.ok(primaryReserveFraction(bot, loadout) < R.botNeed);
  const g = pouchGoal(fakeGame, {}, bot, goal, 1000);
  assert.equal(g?.kind, 'pouch', 'a bot below half its reserve walks to a pouch in reach');
  assert.ok(Math.hypot(g.point.x - bot.x, g.point.z - bot.z) <= R.botReachM);
  assert.equal(pouchGoal(fakeGame, { contactAt: 900 }, bot, goal, 1000), null, 'not with an enemy in sight');
  assert.equal(pouchGoal(fakeGame, {}, bot, { kind: 'board' }, 1000), null, 'not off a seat assignment');
  bot.reserve[slot] = full;
  assert.equal(pouchGoal(fakeGame, {}, bot, goal, 1000), null, 'not with a full reserve');
  bot.reserve[slot] = 0; bot.x = 80;
  assert.equal(pouchGoal(fakeGame, {}, bot, goal, 1000), null, 'not past the reach');
}

// ---------------------------------------------------------------- rematch clears them; the client view
policy.reset();
assert.equal(policy.pouches.size, 0, 'a rematch clears the pouches');
{
  const view = new PouchView(null);
  view.sync([[1, 1, 2, 3], [2, 4, 2, 6]]);
  assert.equal(view.count, 2);
  assert.equal(view.meshes[0].count, 2, 'one instanced draw per part');
  view.sync(undefined);
  assert.equal(view.count, 2, 'an absent list keeps the shown pouches');
  view.update(0.4);
  view.sync([]);
  assert.equal(view.count, 0, 'an empty list clears them');
  view.dispose();
}
console.log('conquest supply pouches: drop, pickup, full-reserve, vehicle, expiry, cap, wire, bots, view passed');
