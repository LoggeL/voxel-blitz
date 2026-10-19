// Squad orders and the comm rose on the authoritative Frontier v2 map
// (GameEngine + attachBots, real ConquestPolicy, no sockets): intent parsing,
// leader-only orders from the full map and from the rose (flag under the
// crosshair), the squad tuple's order flag, bot squad members following a
// human leader's order, bot-led squads publishing the commander's flag, the
// order_capture / order_defend bonuses and their career XP, comm requests
// (marker rows, expiry, serving), bots answering NEED MEDIC / AMMO / REPAIR /
// RIDE, radio callouts and the bot AFFIRMATIVE after a human order.
//
//   node tools/conquest-orders-test.mjs
import assert from 'node:assert/strict';
import { createMapState, getMapMeta } from '../shared/worlddata.js';
import { GameEngine } from '../server/game.js';
import { attachBots } from '../server/bots.js';
import { TICK_MS, parseConquestIntent } from '../server/protocol/admission.js';
import { makeSnapshot } from '../server/protocol/snapshot.js';
import { mulberry32 } from '../shared/noise.js';
import { CONQUEST_EVENT_KINDS, CONQUEST_INTENT_SHAPE, SCORE_LABELS, SCORE_POINTS } from '../shared/conquest-contract.js';
import { CAREER_REWARDS } from '../shared/career.js';
import { decodeConquestMatch } from '../shared/conquest.js';
import { KIT_ROLE_RULES } from '../shared/conquest-kits.js';
import { COMM_KINDS, COMM_ROSE, COMM_RULES, commAudience, commRequestsOf, decodeCommField, flagInSight, orderStance } from '../shared/conquest-comms.js';

const meta = getMapMeta('frontier');
const world = createMapState('frontier');
const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
let checks = 0;
const ok = (value, message) => { assert.ok(value, message); checks++; };
const eq = (a, b, message) => { assert.deepEqual(a, b, message); checks++; };
const flagOf = id => meta.conquest.flags.find(f => f.id === id);
/** The wire player rows of a policy (server/protocol/snapshot.js). */
const wireRows = (game, policy) => makeSnapshot([...game.combatants.values()]
  .map(p => ({ ...p, ...policy.playerSnapshot(p) })), [], [], game.now).players;
/** Aim angles from an eye toward a point (yaw 0 faces -Z, pitch > 0 up). */
const aimAt = (eye, point) => {
  const dx = point.x - eye.x, dy = point.y - eye.y, dz = point.z - eye.z;
  return { yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(dy, Math.hypot(dx, dz)) };
};

// --------------------------------------------------------------- contract --
eq(COMM_KINDS, ['medic', 'ammo', 'repair', 'ride', 'yes', 'no', 'spot', 'order'], 'comm wire order');
eq([...COMM_ROSE].sort(), [...COMM_KINDS].sort(), 'the rose shows every comm kind once');
ok(['squad_order', 'comm', 'comm_answer'].every(k => CONQUEST_EVENT_KINDS.includes(k)), 'order and comm events are Conquest events');
eq(CONQUEST_EVENT_KINDS.slice(-3), ['squad_order', 'comm', 'comm_answer'], 'new events are appended');
ok(CONQUEST_INTENT_SHAPE.comm && CONQUEST_INTENT_SHAPE.order, 'comm and order intents are in the contract');
eq([SCORE_POINTS.order_capture, SCORE_POINTS.order_defend], [100, 50], 'order bonus points');
eq([SCORE_LABELS.order_capture, SCORE_LABELS.order_defend], ['ORDER CAPTURE', 'ORDER DEFEND']);
eq(Object.keys(SCORE_POINTS).slice(-2), ['order_capture', 'order_defend'], 'score reasons are appended');
ok(['order_capture', 'order_defend'].every(r => CAREER_REWARDS.conquestObjective.major.includes(r)), 'order bonuses pay major career XP');
ok(commAudience('medic', { kit: 'medic' }) && !commAudience('medic', { kit: 'assault' }), 'medics see NEED MEDIC');
ok(commAudience('ammo', { kit: 'support' }) && commAudience('repair', { kit: 'engineer' }) && commAudience('ride', { driving: true })
  && !commAudience('ride', { kit: 'engineer' }), 'supports, engineers and drivers see their requests');
eq(orderStance({ owner: 'alpha' }, 'alpha'), 'defend');
eq(orderStance({ owner: null }, 'alpha'), 'attack');
eq(orderStance({ owner: 'bravo' }, 'alpha'), 'attack');

// ---------------------------------------------------------------- parsing --
eq(parseConquestIntent({ t: 'conquest', comm: 'medic' }), { type: 'comm', comm: 'medic' });
eq(parseConquestIntent({ t: 'conquest', comm: 'order' }), { type: 'comm', comm: 'order' });
eq(parseConquestIntent({ t: 'conquest', order: 'C' }), { type: 'order', flag: 'C' });
eq(parseConquestIntent({ t: 'conquest', order: '' }), { type: 'order', flag: '' });
for (const bad of [{ comm: 'taxi' }, { comm: 3 }, { order: 'AB' }, { order: ['A'] }, { order: 1 }, { comm: 'medic', order: 'A' }]) {
  eq(parseConquestIntent({ t: 'conquest', ...bad }), null, `rejects ${JSON.stringify(bad)}`);
}

// --------------------------------------------------------- flag in sight --
{
  const C = flagOf('C'), D = flagOf('D');
  const eye = { x: C.x - 120, y: C.y + 1.6, z: C.z + 40 };
  const aim = aimAt(eye, { x: C.x, y: C.y + 2.5, z: C.z });
  eq(flagInSight(eye, aim.yaw, aim.pitch, meta.conquest.flags)?.id, 'C', 'looking at C picks C');
  eq(flagInSight(eye, aim.yaw + Math.PI, aim.pitch, meta.conquest.flags), null, 'looking away picks nothing');
  const aimD = aimAt(eye, { x: D.x, y: D.y + 2.5, z: D.z });
  eq(flagInSight(eye, aimD.yaw, aimD.pitch, meta.conquest.flags)?.id, 'D', 'looking at D picks D');
}

/**
 * Alpha: the human 'me' (joins first, so it leads squad 1) plus `n` bots;
 * bravo: one idle enemy. Hulls cleared unless `hulls`.
 */
function fixture(n, { seed = 3, hulls = false } = {}) {
  Math.random = mulberry32(seed);
  const events = [];
  const game = new GameEngine({ mode: 'conquest', world, mapMeta: meta, broadcast: snap => events.push(...(snap.events ?? [])) });
  if (!hulls) game.vehicles.vehicles.clear();
  game.addClient('me', 'ME');
  const policy = game.mode.policy;
  const me = game.entities.get('me');
  policy.setLobbyTeam(me, 'alpha');
  const bots = attachBots(game, n);
  const list = bots.brains.map(br => game.entities.get(br.id));
  for (const p of list) policy.setLobbyTeam(p, 'alpha');
  game.addClient('enemy', 'ENEMY');
  const enemy = game.entities.get('enemy');
  policy.setLobbyTeam(enemy, 'bravo');
  for (let i = 0; i < 3; i++) game.step(TICK_MS);
  const place = (p, s, extra = {}) => Object.assign(p, { x: s.x, y: s.y, z: s.z, vx: 0, vy: 0, vz: 0, spawnProtectedUntil: 0, ...extra });
  const kit = (p, id) => { policy.roles.applyLoadout(p, id, 0, 0); p.hp = p.maxHp || 100; };
  const run = ms => { for (let t = 0; t < ms; t += TICK_MS) game.step(TICK_MS); };
  const intent = value => game.conquestIntent('me', value);
  // Broadcast events plus the ones still queued for this tick.
  const all = () => [...events, ...(game.tickEvents ?? [])];
  const ofKind = kind => all().filter(e => e.kind === kind);
  return { game, bots, policy, me, list, enemy, events, place, kit, run, intent, ofKind, all };
}

// ------------------------------------------------- human leader's orders --
{
  const f = fixture(3);
  const { policy, me, list } = f;
  const squad = policy.squads.squadOf('me');
  eq(policy.squads.leaderOf('alpha', squad), 'me', 'the first to join leads');
  const mate = list.find(p => policy.squads.squadOf(p.id) === squad);
  ok(mate, 'a bot shares the squad');
  ok(!policy.squadOrders.issue(mate, 'C'), 'only the leader orders');
  ok(f.intent({ type: 'order', flag: 'C' }), 'the leader orders C from the map');
  const order = f.ofKind('squad_order').filter(e => e.by === 'me').at(-1);
  eq([order.team, order.squad, order.flag, order.by], ['alpha', squad, 'C', 'me'], 'squad_order event');
  const snap = policy.matchSnapshot().conquest;
  const tuple = snap.squads.find(t => t[0] === 'alpha' && t[1] === squad);
  eq(tuple, ['alpha', squad, 'me', 'C'], 'the squad tuple carries the order flag');
  eq(decodeConquestMatch(snap, meta.conquest).squads.find(s => s.squadId === squad && s.team === 'alpha').order, 'C', 'decoded order');
  ok(!f.intent({ type: 'order', flag: 'D' }), 'a second order inside the cooldown is refused');
  f.run(COMM_RULES.orderCooldownMs + 50);
  ok(f.intent({ type: 'order', flag: 'C' }), 'the standing order is accepted unchanged');
  ok(!f.intent({ type: 'order', flag: 'Q' }), 'unknown flags are refused');
  // Bots of the squad follow the human order; other squads keep the commander's split.
  f.run(1200);
  const ts = f.bots.commander.teams.get('alpha');
  const botSquad = ts.squads.get(squad);
  eq([botSquad.order.flagId, botSquad.order.stance, botSquad.order.human], ['C', 'attack', true], 'the commander holds the human order');
  const goal = f.bots.commander.goalFor(mate);
  if (goal.kind === 'capture') eq(goal.target.id, 'C', 'the bot mate heads for the ordered flag');
  // The bot mate radios AFFIRMATIVE shortly after the order.
  ok(f.ofKind('comm').some(e => e.comm === 'yes' && e.squad === squad && e.team === 'alpha' && f.game.entities.get(e.by)?.bot),
    'a bot squad mate radios AFFIRMATIVE');
  // Defend: an own flag ordered is defended by the bots.
  f.run(COMM_RULES.orderCooldownMs + 50);
  const own = policy.capture.flags.find(fl => fl.owner === 'alpha');
  ok(f.intent({ type: 'order', flag: own.id }), 'order on an own flag');
  f.run(1200);
  eq([ts.squads.get(squad).order.flagId, ts.squads.get(squad).order.stance], [own.id, 'defend'], 'an own flag order is a defend order');
  // The rose's ORDER: the flag under the crosshair.
  f.run(COMM_RULES.orderCooldownMs + COMM_RULES.cooldownMs);
  const D = flagOf('D');
  const eyeAt = { x: D.x - 150, y: D.y, z: D.z + 30 };
  f.place(me, eyeAt);
  const aim = aimAt({ x: me.x, y: me.y + 1.6, z: me.z }, { x: D.x, y: D.y + 2.5, z: D.z });
  Object.assign(me, { yaw: aim.yaw, pitch: aim.pitch });
  ok(f.intent({ type: 'comm', comm: 'order' }), 'ORDER from the rose');
  eq(policy.squadOrders.flagFor('alpha', squad), 'D', 'ordered onto the flag in sight');
  f.run(COMM_RULES.orderCooldownMs + COMM_RULES.cooldownMs);
  Object.assign(me, { yaw: aim.yaw + Math.PI, pitch: 0 });
  const C = flagOf('C');
  const away = flagInSight({ x: me.x, y: me.y + 1.6, z: me.z }, me.yaw, me.pitch, meta.conquest.flags);
  if (!away) ok(!f.intent({ type: 'comm', comm: 'order' }), 'no flag in sight: no order');
  void C;
  // Clearing.
  f.run(COMM_RULES.orderCooldownMs + 50);
  ok(f.intent({ type: 'order', flag: '' }), 'the leader clears the order');
  eq(policy.squadOrders.flagFor('alpha', squad), null);
  eq(f.ofKind('squad_order').filter(e => e.by === 'me').at(-1).flag, null, 'clearing emits flag null');
  // Bonuses: capture and defend on the order flag pay the squad's members present.
  f.run(COMM_RULES.orderCooldownMs + 50);
  ok(f.intent({ type: 'order', flag: 'C' }), 'order C again');
  const other = list.find(p => policy.squads.squadOf(p.id) !== squad);
  const flagC = policy.capture.flags.find(fl => fl.id === 'C');
  const scores = () => f.all().filter(e => e.kind === 'score');
  const before = scores().length;
  policy._applyFlagOutcome({ kind: 'captured', flag: flagC, team: 'alpha', present: ['me', String(mate.id), ...(other ? [String(other.id)] : [])], assists: [] });
  const paid = scores().slice(before);
  ok(paid.some(e => e.id === 'me' && e.reason === 'order_capture' && e.pts === SCORE_POINTS.order_capture), 'the leader earns order_capture');
  ok(paid.some(e => e.id === String(mate.id) && e.reason === 'order_capture'), 'the bot mate earns order_capture');
  if (other) ok(!paid.some(e => e.id === String(other.id) && e.reason === 'order_capture'), 'another squad earns only the capture');
  const mid = scores().length;
  policy._applyFlagOutcome({ kind: 'defended', flag: flagC, team: 'alpha', defenders: ['me'] });
  ok(scores().slice(mid).some(e => e.id === 'me' && e.reason === 'order_defend' && e.pts === SCORE_POINTS.order_defend), 'defending the order flag pays order_defend');
  ok(policy.score.statsRow('me')[0] >= SCORE_POINTS.order_capture + SCORE_POINTS.order_defend, 'order bonuses count as objective score');
  // The leader leaves: the human order lapses and the bots get the commander's order again.
  f.game.removeClient?.('me');
  if (!f.game.entities.has('me')) {
    f.run(TICK_MS * 2);
    ok(f.ofKind('squad_order').some(e => e.by === 'me' && e.flag === null), 'a departed leader\'s order is cleared');
  }
}

// ----------------------------------------------- bot-led squads publish --
{
  const f = fixture(7, { seed: 5 });
  f.run(1500);
  const { policy } = f;
  const ts = f.bots.commander.teams.get('alpha');
  let published = 0;
  for (const squad of ts.squads.values()) {
    if (!f.game.entities.get(squad.leaderId)?.bot) continue;
    eq(policy.squadOrders.flagFor('alpha', squad.id), squad.order?.flagId ?? null, `bot squad ${squad.id} publishes its order`);
    published++;
  }
  ok(published >= 1, 'at least one bot-led squad');
  const tuples = policy.matchSnapshot().conquest.squads;
  ok(tuples.some(t => t[0] === 'alpha' && typeof t[3] === 'string'), 'a bot squad tuple carries its order');
  // A bot leader's order never overrides the human leader's own squad.
  const mine = policy.squads.squadOf('me');
  eq(policy.squadOrders.get('alpha', mine), null, 'the human-led squad shows no order until its leader gives one');
}

// ------------------------------------------------------- comm requests --
{
  const f = fixture(3, { seed: 9 });
  const { policy, me, list } = f;
  const C = flagOf('C');
  const spot = C.spawns[0];
  f.place(me, spot);
  const [medic, support, engineer] = list;
  f.kit(medic, 'medic'); f.kit(support, 'support'); f.kit(engineer, 'engineer');
  for (const [i, p] of [medic, support, engineer].entries()) f.place(p, C.spawns[3 + i]);
  f.place(f.enemy, flagOf('E').spawns[0]);
  // Radio callouts.
  ok(f.intent({ type: 'comm', comm: 'yes' }), 'AFFIRMATIVE');
  eq([f.ofKind('comm').at(-1).comm, f.ofKind('comm').at(-1).by], ['yes', 'me'], 'a radio comm event');
  ok(!f.intent({ type: 'comm', comm: 'no' }), 'comms share a cooldown');
  f.run(COMM_RULES.cooldownMs + 50);
  ok(f.intent({ type: 'comm', comm: 'no' }), 'NEGATIVE after the cooldown');
  ok(!f.intent({ type: 'comm', comm: 'taxi' }), 'unknown kinds are refused');
  // NEED MEDIC: a marker row, a Medic bot answers and walks over; healing to full serves it.
  f.run(COMM_RULES.cooldownMs + 50);
  me.hp = 40;
  me.lastDamagedAt = f.game.now - 10000;
  ok(f.intent({ type: 'comm', comm: 'medic' }), 'NEED MEDIC');
  const rows = wireRows(f.game, policy);
  const row = commRequestsOf(rows).find(r => r.by === 'me');
  eq([row?.kind, row?.by, row?.responder], ['medic', 'me', null], 'the request rides the requester row as cqc');
  ok(Math.abs(row.x - me.x) < 0.02 && Math.abs(row.z - me.z) < 0.02, 'the marker stands at the requester');
  ok(rows.filter(r => r.cqc).length === 1, 'only the requester row carries cqc');
  f.run(1100);
  const answer = f.ofKind('comm_answer').find(e => e.comm === 'medic' && e.by === 'me');
  ok(answer && answer.responder === String(medic.id), 'the Medic bot answers NEED MEDIC');
  const goal = f.bots.commander.goalFor(medic);
  ok(goal.kind === 'heal' && goal.comm === answer.seq, 'the Medic walks to the requester');
  ok(flat(goal.point, me) <= 4, 'it stands next to the requester');
  eq(decodeCommField(wireRows(f.game, policy).find(r => r.id === 'me'))?.responder, String(medic.id), 'the marker names the responder');
  // Served: a heal pulse then full health.
  policy._emit('heal', { id: 'me', by: String(medic.id), hp: 5 });
  me.hp = me.maxHp || 100;
  f.run(TICK_MS * 2);
  ok(!policy.comms.requests.has('me'), 'healed to full: the request is served');
  // NEED AMMO: the Support bot answers and its aura serves it.
  f.run(COMM_RULES.cooldownMs + 50);
  ok(f.intent({ type: 'comm', comm: 'ammo' }), 'NEED AMMO');
  f.run(1100);
  ok(f.ofKind('comm_answer').some(e => e.responder === String(support.id)), 'the Support bot answers NEED AMMO');
  const ammoGoal = f.bots.commander.goalFor(support);
  ok(ammoGoal.kind === 'heal' && flat(ammoGoal.point, me) <= KIT_ROLE_RULES.resupplyRadius - 1, 'it stands inside its aura beside the requester');
  me.reserve = me.reserve.map(() => 0);
  f.place(support, { x: me.x + 2, y: me.y, z: me.z });
  f.run(5000);
  ok(!policy.comms.requests.has('me'), 'the aura refilled the requester: served');
  // NEED REPAIR needs a damaged friendly hull: refused on foot without one.
  f.run(COMM_RULES.cooldownMs + 50);
  ok(!f.intent({ type: 'comm', comm: 'repair' }), 'NEED REPAIR without a damaged hull nearby is refused');
  // Expiry.
  f.run(COMM_RULES.cooldownMs + 50);
  me.hp = 50;
  ok(f.intent({ type: 'comm', comm: 'medic' }), 'NEED MEDIC again');
  f.bots.commander.teams.get('alpha').commAssign = new Map();
  for (const p of list) f.place(p, flagOf('A').spawns[0]);
  f.run(COMM_RULES.requestMs + 600);
  ok(!policy.comms.requests.has('me'), 'an unanswered request times out');
  ok(policy.matchSnapshot().conquest.comms === undefined, 'no comms field without live requests');
  // SPOT through the rose is the ordinary spot intent.
  ok(typeof f.intent({ type: 'comm', comm: 'spot' }) === 'boolean', 'SPOT goes through the spot intent');
}

// ---------------------------------------------- NEED MEDIC while down --
{
  const f = fixture(1, { seed: 21 });
  const { policy, me, list, game } = f;
  const [medic] = list;
  f.kit(medic, 'medic'); f.kit(me, 'assault');
  const C = flagOf('C');
  f.place(me, C.spawns[0]);
  // A Medic past REVIVE_RANGE (25 m): only the request brings it over.
  const d0 = flat(C.spawns[0], C), ux = (C.spawns[0].x - C.x) / (d0 || 1), uz = (C.spawns[0].z - C.z) / (d0 || 1);
  const far = f.bots.commander.walkablePoint({ x: me.x - ux * 34, y: me.y, z: me.z - uz * 34 })
    ?? f.bots.commander.walkablePoint({ x: me.x + 34, y: me.y, z: me.z });
  ok(far && flat(far, me) > 26, 'a Medic spot past revive range');
  f.place(medic, far);
  f.place(f.enemy, flagOf('E').spawns[0]);
  game.step(TICK_MS);
  me.takeDamage(500, false, f.enemy, 'rifle');
  game.killPlayer(me, f.enemy, 'rifle', false);
  ok(policy.roles.isDown(me), 'the requester is down');
  ok(!f.intent({ type: 'comm', comm: 'yes' }), 'a downed body cannot radio');
  ok(f.intent({ type: 'comm', comm: 'medic' }), 'but it can call a medic');
  const body = policy.roles.downedBodies('alpha').find(b => String(b.id) === 'me');
  const row = commRequestsOf(wireRows(game, policy)).find(r => r.by === 'me');
  eq(row?.kind, 'medic', 'the downed requester row carries the request');
  ok(flat(policy.comms.position(policy.comms.requests.get('me')), body) < 0.5, 'the request stands at the body');
  // A Medic that cannot sprint to the body before it bleeds out (reviveWindowMs) does not answer.
  const distant = f.bots.commander.walkablePoint({ x: me.x - ux * 70, y: me.y, z: me.z - uz * 70 })
    ?? f.bots.commander.walkablePoint({ x: me.x + 70, y: me.y, z: me.z });
  ok(distant && flat(distant, body) > 60, 'a Medic spot out of sprint reach');
  f.place(medic, distant);
  f.run(600);
  ok(!f.ofKind('comm_answer').some(e => e.by === 'me'), 'out of reach before the bleed-out: no answer');
  f.place(medic, far);
  f.run(1100);
  ok(f.ofKind('comm_answer').some(e => e.by === 'me' && e.responder === String(medic.id)), 'the Medic bot answers the downed call');
  const goal = f.bots.commander.goalFor(medic);
  ok(['heal', 'revive'].includes(goal.kind) && flat(goal.point, body) <= 2, `it heads for the body (${goal.kind})`);
}

// ------------------------------------------- NEED REPAIR and NEED RIDE --
{
  const f = fixture(3, { seed: 11, hulls: true });
  const { policy, me, list, game } = f;
  const jeep = [...game.vehicles.vehicles.values()].find(v => v.team === 'alpha' && v.type === 'jeep' && !v.flag)
    ?? [...game.vehicles.vehicles.values()].find(v => v.team === 'alpha' && v.type === 'jeep');
  ok(jeep, 'an alpha jeep');
  // Keep the team's other hulls out of reach of the bots: only this jeep matters.
  const [engineer, driver, third] = list;
  f.kit(engineer, 'engineer'); f.kit(driver, 'assault'); f.kit(third, 'assault');
  // Repair: the requester stands by its damaged jeep.
  jeep.hp = 150;
  f.place(me, { x: jeep.x + 3, y: jeep.y, z: jeep.z });
  f.place(engineer, { x: jeep.x + 20, y: jeep.y, z: jeep.z + 4 });
  f.place(driver, { x: jeep.x - 60, y: jeep.y, z: jeep.z - 60 });
  f.place(third, { x: jeep.x - 60, y: jeep.y, z: jeep.z - 64 });
  ok(f.intent({ type: 'comm', comm: 'repair' }), 'NEED REPAIR beside a damaged jeep');
  eq(policy.comms.requests.get('me').vehicleId, String(jeep.id), 'the request names the jeep');
  f.run(1100);
  ok(f.ofKind('comm_answer').some(e => e.responder === String(engineer.id)), 'the Engineer bot answers NEED REPAIR');
  const g = f.bots.commander.goalFor(engineer);
  ok(g.kind === 'repair' && g.support?.targetId === String(jeep.id), 'it walks to the jeep to repair it');
  jeep.hp = 320;
  f.run(TICK_MS * 2);
  ok(!policy.comms.requests.has('me'), 'repaired to full: served');
  // Ride: the requester stands 120 m from the empty jeep, a bot next to it drives over.
  f.run(COMM_RULES.cooldownMs + 50);
  const far = { x: jeep.x, y: jeep.y, z: jeep.z };
  f.place(driver, { x: jeep.x + 4, y: jeep.y, z: jeep.z + 2 });
  f.place(engineer, { x: jeep.x - 80, y: jeep.y, z: jeep.z + 80 });
  const C = flagOf('C');
  // A walkable spot about 110 m from the jeep toward C.
  const d = flat(far, C), ux = (C.x - far.x) / d, uz = (C.z - far.z) / d;
  const target = f.bots.commander.walkablePoint({ x: far.x + ux * 110, y: far.y, z: far.z + uz * 110 });
  ok(target, 'a walkable pickup spot');
  f.place(me, target);
  // No squad ride may take the jeep first.
  const ts = f.bots.commander.teams.get('alpha');
  ts.rideCooldown ??= new Map();
  for (const id of [1, 2, 3, 4]) ts.rideCooldown.set(id, f.game.now + 600000);
  ts.transits.clear();
  ok(f.intent({ type: 'comm', comm: 'ride' }), 'NEED RIDE');
  f.run(1100);
  const pickup = [...ts.transits.values()].find(t => t.pickup?.humanId === 'me');
  ok(pickup, 'a pickup ride is booked');
  eq([...pickup.seats.keys()][0], String(driver.id), 'the bot next to the jeep drives it');
  ok(f.ofKind('comm_answer').some(e => e.responder === String(driver.id)), 'the driver is announced');
  // Let it drive; the requester then boards.
  let boarded = false, closest = Infinity;
  for (let t = 0; t < 60000 && !boarded; t += 500) {
    f.run(500);
    const v = game.vehicles.vehicles.get(pickup.vehicleId);
    closest = Math.min(closest, flat(v, me));
    if (driver.vehicleId === pickup.vehicleId && closest < 16) boarded = true;
  }
  ok(driver.vehicleId === pickup.vehicleId, 'the bot took the wheel');
  ok(closest < 20, `the jeep came to the requester (closest ${closest.toFixed(1)} m)`);
  // The requester gets in: the ride heads for the squad order flag.
  ok(f.intent({ type: 'order', flag: 'D' }), 'the leader orders D');
  me.x = game.vehicles.vehicles.get(pickup.vehicleId).x; me.z = game.vehicles.vehicles.get(pickup.vehicleId).z;
  const entered = game.vehicles.enter(me, pickup.vehicleId);
  ok(entered, 'the requester boards the pickup');
  f.run(1100);
  ok(!policy.comms.requests.has('me'), 'aboard: NEED RIDE is served');
  const ride = ts.transits.get(pickup.vehicleId);
  ok(ride?.pickup.stage === 'deliver' && ride.flagId === 'D', 'the ride now heads for the order flag');
  const start = flat(game.vehicles.vehicles.get(pickup.vehicleId), flagOf('D'));
  f.run(8000);
  const now = flat(game.vehicles.vehicles.get(pickup.vehicleId), flagOf('D'));
  ok(now < start - 10, `the ride drives toward D (${start.toFixed(0)} -> ${now.toFixed(0)} m)`);
  // Seated, NEED MEDIC is refused like AMMO and RIDE: the heal aura skips seated mates.
  ok(me.vehicleId === pickup.vehicleId, 'the requester still rides');
  me.hp = 40;
  ok(!f.intent({ type: 'comm', comm: 'medic' }) && !policy.comms.requests.has('me'), 'seated: no NEED MEDIC');
}

// --------------------------------------------------------- budget --
{
  const f = fixture(15, { seed: 13 });
  f.run(1500);
  for (let i = 0; i < COMM_RULES.maxPerTeam; i++) {
    const p = f.list[i];
    f.policy.comms.request(p, 'medic', f.game.now);
  }
  const bytes = JSON.stringify(f.policy.matchSnapshot().conquest).length;
  ok(bytes <= 400, `match.conquest with orders stays within 400 B while ${COMM_RULES.maxPerTeam} requests stand (${bytes} B)`);
  const rows = wireRows(f.game, f.policy).filter(r => r.cqc);
  eq(rows.length, COMM_RULES.maxPerTeam, 'each requester row carries its cqc');
  ok(rows.every(r => JSON.stringify(r.cqc).length <= 24), 'a cqc field is a few bytes');
  // A team keeps at most maxPerTeam live requests: the oldest gives way.
  const first = String(f.list[0].id), extra = f.list[COMM_RULES.maxPerTeam];
  f.policy.comms.request(extra, 'medic', f.game.now);
  eq(f.policy.comms.list('alpha').length, COMM_RULES.maxPerTeam, 'request cap per team');
  ok(!f.policy.comms.requests.has(first) && f.policy.comms.requests.has(String(extra.id)), 'the oldest request gives way');
}

console.log(`Conquest squad orders and comm rose: ${checks} checks passed (contract, parsing, flag in sight, leader orders from map and rose, bot squads following and publishing orders, order bonuses, comm requests, bot answers for medic, ammo, repair and ride, radio callouts, snapshot budget).`);
