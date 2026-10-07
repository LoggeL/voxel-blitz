// Conquest bot commander (server/bot-commander.js) on the authoritative
// Frontier v2 map with the real ConquestPolicy: director registration,
// frontline attack target, defend surge into the zone, staged synchronised
// pushes, flank retargeting, defender counting, reachable cover, kit mix,
// crew budget, deploy choices and per-tick goal caching. Positions come from
// mapMeta; flag state is set on the policy's own capture rows.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createMapState, getMapMeta } from '../shared/worlddata.js';
import { GameEngine } from '../server/game.js';
import { attachBots } from '../server/bots.js';
import { TICK_MS } from '../server/protocol/admission.js';
import { BotCommander, COMMANDER_PLAN_MS, STAGE_MIN, STAGE_MAX, STAGE_ANGLE, frontlineTiers, readConquestView } from '../server/bot-commander.js';
import { KIT_IDS } from '../shared/conquest-contract.js';
import { surfaceNavigation } from '../server/bot-surface-nav.js';

const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
const meta = getMapMeta('frontier');
const world = createMapState('frontier');

function fixture(n = 16) {
  const game = new GameEngine({ mode: 'conquest', world, mapMeta: meta, broadcast: () => {} });
  const bots = attachBots(game, n);
  game.step(TICK_MS);
  const policy = game.mode.policy;
  const commander = bots.commander;
  const teamOf = p => game.mode.teamFor(p);
  const flag = id => policy.capture.flags.find(f => f.id === id);
  const replan = () => {
    policy._view = null; commander.viewAt = -1; commander.goalAt = -1;
    commander.plan(game.now);
  };
  const bodies = team => [...game.entities.values()].filter(p => p.bot && teamOf(p) === team);
  return { game, bots, policy, commander, teamOf, flag, replan, bodies };
}

// --- registration and the frontline ------------------------------------------
{
  const { game, bots, policy, commander, flag, replan, bodies } = fixture();
  assert(commander instanceof BotCommander, 'attachBots builds a commander in Conquest');
  assert(policy.director && typeof policy.director.goalFor === 'function' && typeof policy.director.deployFor === 'function',
    'the commander is registered as the mode bot director');
  const view = readConquestView(game);
  assert.equal(view.flags.length, meta.conquest.flags.length, 'the commander reads every flag from policy.conquestView()');
  const tiers = frontlineTiers(view.flags, view.bases, 'alpha').map(t => t.map(f => f.id).sort().join(''));
  assert.deepEqual(tiers, ['AB', 'C', 'DE'], 'alpha frontline: A/B <-> C <-> D/E');
  assert.deepEqual(frontlineTiers(view.flags, view.bases, 'bravo').map(t => t.map(f => f.id).sort().join('')), ['DE', 'C', 'AB'],
    'bravo frontline runs the other way');
  replan();
  for (const team of ['alpha', 'bravo']) {
    const ts = commander.teams.get(team);
    assert.deepEqual(ts.attackFlags.map(f => f.id), ['C'], `${team} attacks the first non-owned flag along the graph (C)`);
    const orders = [...ts.squads.values()].map(s => s.order).filter(Boolean);
    assert(orders.length >= 1 && orders.every(o => o.flagId === 'C' && o.stance === 'attack'), `${team} squads all push C at the start`);
  }
  // Alpha takes C: its attack moves on to the enemy home tier.
  Object.assign(flag('C'), { owner: 'alpha', control: 1, state: 'idle' });
  replan();
  const alpha = commander.teams.get('alpha');
  assert.deepEqual(alpha.attackFlags.map(f => f.id).sort(), ['D', 'E'], 'with C held, alpha attacks the D/E tier');
  assert.deepEqual(commander.teams.get('bravo').attackFlags.map(f => f.id), ['C'], 'bravo attacks C, now enemy-held');

  // Goals are cached per tick: the same object for the same bot in one tick.
  const bot = bodies('alpha').find(p => p.state === 'alive');
  const g1 = policy.botGoal(bot), g2 = policy.botGoal(bot);
  assert.equal(g1, g2, 'goalFor is cached per tick');
  assert(['capture', 'revive', 'repair'].includes(g1.kind) && g1.target && Number.isFinite(g1.point?.x), 'the director goal has the bot goal shape plus a point');
  // spec 3.5: stance is one of attack|defend|stage (bot-only roles ride in `role`).
  assert(['attack', 'defend', 'stage'].includes(g1.stance) || (g1.stance === undefined && g1.role === 'support'), `the director goal carries a contract stance (${g1.stance})`);
  for (const p of bodies('alpha').concat(bodies('bravo')).filter(q => q.state === 'alive')) {
    const g = policy.botGoal(p);
    if (g.kind === 'capture') assert(['attack', 'defend', 'stage'].includes(g.stance), `capture goals carry a contract stance (${g.stance}/${g.role})`);
    else if (g.kind !== 'spectate') assert(g.stance === undefined && g.role === 'support', `support goals carry the support role (${g.kind})`);
  }
  bots.dispose();
}

// --- defend surge when a home flag is being lost --------------------------------
{
  const { game, bots, commander, flag, replan, bodies } = fixture();
  const A = flag('A');
  const raiders = bodies('bravo').slice(0, 3);
  raiders.forEach((p, i) => Object.assign(p, { x: A.x + i, y: A.y, z: A.z + 1 }));
  Object.assign(A, { state: 'neutralizing', control: 0.6, mover: 'bravo' });
  replan();
  const alpha = commander.teams.get('alpha');
  const squads = [...alpha.squads.values()].filter(s => s.order);
  assert(squads.length >= 2, 'alpha has several squads with orders');
  assert(squads.every(s => s.order.stance === 'defend' && s.order.flagId === 'A' && s.order.allIn), 'every alpha squad surges to defend A');
  // ... and the surge goes into the zone: only bodies inside the radius stop
  // the neutralization, never the cover ring around it (any kit, recon too).
  {
    commander.goalAt = -1;
    const surging = squads.flatMap(s => s.members).map(id => game.entities.get(id))
      .filter(p => p?.bot && p.state === 'alive' && !p.vehicleId && !alpha.crews.has(String(p.id)));
    let inside = 0;
    for (const p of surging) {
      const g = commander.computeGoal(p, game.now);
      if (g.kind !== 'capture') continue;
      assert.equal(g.stance, 'defend', 'a surging defender keeps the defend stance');
      const d = flat(g.point, A);
      assert(d <= A.radius * 0.85 && Math.abs(g.point.y - A.y) <= 8,
        `a surging defender's goal is inside A's zone (${d.toFixed(1)} m of ${A.radius}, dy ${(g.point.y - A.y).toFixed(1)})`);
      inside++;
    }
    assert(inside >= 2, `several defenders surge into the zone (${inside})`);
  }
  // A threatened (not losing) flag gets defenders while the rest still attacks.
  Object.assign(A, { state: 'idle', control: 1, mover: null });
  raiders.forEach(p => Object.assign(p, { x: A.x + 45, y: A.y, z: A.z }));
  commander.teams.get('alpha').knowledge = [];
  replan();
  const held = [...alpha.squads.values()].map(s => s.order).filter(Boolean);
  assert(held.every(o => o.stance === 'defend'), 'defend orders hold for a while after the surge');
  game.now += 21000;
  // An alpha bot has seen the raider 45 m from A: team knowledge, not presence.
  const watcher = bots.brains.find(br => game.mode.teamFor(game.entities.get(br.id)) === 'alpha');
  watcher.lastSeen = { id: raiders[0].id, lives: raiders[0].lives, until: game.now + 5000, position: { x: raiders[0].x, y: raiders[0].y, z: raiders[0].z } };
  replan();
  const orders = [...alpha.squads.values()].map(s => s.order).filter(Boolean);
  assert(orders.some(o => o.stance === 'defend' && o.flagId === 'A'), 'an enemy within 60 m of A draws a defending squad');
  assert(orders.some(o => o.stance === 'attack'), 'the remaining squads keep attacking (60/40 split)');
  bots.dispose();
}

// --- staging, then a synchronised push -----------------------------------------
{
  const { game, bots, commander, flag, replan, bodies, teamOf } = fixture();
  // C is enemy-held and defended: alpha squads stage before they push.
  const C = flag('C');
  Object.assign(C, { owner: 'bravo', control: -1, state: 'idle' });
  const guard = bodies('bravo')[0];
  Object.assign(guard, { x: C.x, y: C.y, z: C.z });
  // Clear any prior order so newOrder runs with the defended flag.
  for (const ts of commander.teams.values()) for (const squad of ts.squads.values()) squad.order = null;
  replan();
  const alpha = commander.teams.get('alpha');
  const staged = [...alpha.squads.values()].filter(s => s.order?.stance === 'attack' && s.order.flagId === 'C' && s.order.staging);
  assert(staged.length >= 1, 'an alpha squad attacking a defended C gets a staging point');
  const squad = staged[0], order = squad.order;
  assert.equal(order.phase, 'move', 'the squad first moves to its staging point');
  const d = flat(order.staging, C);
  assert(d >= STAGE_MIN - 9 && d <= STAGE_MAX + 7, `staging point 50-70 m out (${d.toFixed(1)} m)`);
  const base = meta.conquest.bases.alpha;
  const approach = Math.atan2(base.z - C.z, base.x - C.x), angle = Math.atan2(order.staging.z - C.z, order.staging.x - C.x);
  assert(Math.abs(Math.abs(wrap(angle - approach)) - STAGE_ANGLE) <= 0.45, `staging point about 50 degrees off the approach (${(wrap(angle - approach) * 180 / Math.PI).toFixed(0)})`);
  const members = squad.members.map(id => game.entities.get(id)).filter(p => p?.bot && p.state === 'alive' && !p.vehicleId && !alpha.crews.has(String(p.id)));
  assert(members.length >= 2, 'the squad has infantry members');
  for (const p of members) {
    const goal = commander.goalFor(p);
    if (goal.kind !== 'capture') continue;
    assert.equal(goal.stance, 'stage', 'members are sent to the staging point');
    assert(flat(goal.point, order.staging) < 12, 'their goal point is at the staging point');
  }
  // Everyone arrives: the squad holds briefly, then all push together.
  for (const p of members) Object.assign(p, { x: order.staging.x, y: order.staging.y, z: order.staging.z });
  commander.advanceOrder(squad, commander.readView(), alpha, game.now);
  assert.equal(order.phase, 'stage', 'arrival switches the squad to the staging hold');
  commander.advanceOrder(squad, commander.readView(), alpha, game.now + 1000);
  assert.equal(order.phase, 'stage', 'the hold lasts a moment');
  commander.advanceOrder(squad, commander.readView(), alpha, game.now + 3200);
  assert.equal(order.phase, 'push', 'then the whole squad pushes at once');
  commander.goalAt = -1;
  const pushGoals = members.map(p => commander.computeGoal(p, game.now)).filter(g => g.kind === 'capture');
  assert(pushGoals.length && pushGoals.every(g => g.stance !== 'stage'), 'no member is left staging after the push');
  assert(pushGoals.filter(g => g.stance === 'attack').every(g => flat(g.point, C) <= C.radius), 'pushers go into the zone');
  // An empty enemy flag is taken at a run (no staging).
  guard.x = C.x + 300; guard.z = C.z;
  for (const s of alpha.squads.values()) s.order = null;
  alpha.knowledge = [];
  commander.computePresence(commander.readView());
  replan();
  assert([...alpha.squads.values()].filter(s => s.order?.flagId === 'C').every(s => !s.order.staging), 'an undefended enemy flag is attacked directly');
  bots.dispose();
}

// --- a flank squad moves on once its back flag is taken ----------------------------
{
  const { game, bots, commander, flag, replan, bodies } = fixture();
  replan();
  const alpha = commander.teams.get('alpha');
  const C = flag('C');
  // The frontline flag is locked in a stalemate long enough to send a flanker.
  Object.assign(C, { state: 'contested' });
  alpha.stalemateSince = game.now - 21000;
  replan();
  const flanker = () => [...alpha.squads.values()].find(s => s.order?.flank);
  const first = flanker();
  assert(first && ['D', 'E'].includes(first.order.flagId), `a stalled line sends a squad to back-cap D or E (${first?.order?.flagId})`);
  const taken = first.order.flagId, next = taken === 'D' ? 'E' : 'D';
  Object.assign(flag(taken), { owner: 'alpha', control: 1, state: 'idle' });
  replan();
  const second = flanker();
  assert(second, 'the stalemate continues, so a squad still flanks');
  assert.equal(second.order.flagId, next, `the flankers leave the captured back flag ${taken} for ${next}`);
  assert.equal(second.order.stance, 'attack');

  // defenders(): one enemy seen by several bots (live sighting, memory, damage) counts once.
  const raider = bodies('bravo')[0];
  Object.assign(raider, { x: C.x + 35, y: C.y, z: C.z });
  commander.computePresence(commander.readView());
  const watchers = bots.brains.filter(br => game.mode.teamFor(game.entities.get(br.id)) === 'alpha').slice(0, 4);
  for (const br of watchers) {
    br.enemyId = raider.id; br.noticeProgress = 1;
    br.lastSeen = { id: raider.id, lives: raider.lives, until: game.now + 5000, position: { x: raider.x, y: raider.y, z: raider.z } };
    br.damageFrom = { id: raider.id, x: raider.x, y: raider.y, z: raider.z, at: game.now };
  }
  alpha.knowledge = commander.gatherKnowledge('alpha', game.now);
  assert(alpha.knowledge.length >= 8, `several knowledge entries for the raider (${alpha.knowledge.length})`);
  assert.equal(commander.defenders(C, alpha), 1, 'one enemy body known near C counts as one defender');
  for (const br of watchers) { br.enemyId = null; br.noticeProgress = 0; br.lastSeen = null; br.damageFrom = null; }
  bots.dispose();
}

// --- cover, overwatch and armour nodes are reachable on foot -------------------------
{
  const { bots, commander } = fixture();
  const nav = surfaceNavigation(world);
  const seen = new Uint8Array(nav.nodes);
  for (const base of Object.values(meta.conquest.bases)) {
    const reach = nav.reachableFrom(base.spawns[0]);
    for (let i = 0; i < seen.length; i++) seen[i] |= reach[i];
  }
  let nodes = 0;
  for (const set of commander.cover.sets.values()) {
    for (const node of [...set.cover, ...set.overwatch, ...set.armor]) {
      const id = nav.nodeAt({ x: node.x, y: node.y - 0.02, z: node.z }, 1);
      assert(id >= 0 && seen[id], `${node.key} is reachable from an HQ`);
      nodes++;
    }
    assert(set.cover.length >= 8, `flag ${set.flag.id} keeps its cover nodes (${set.cover.length})`);
  }
  assert(nodes > 100, `cover sets built (${nodes} nodes)`);
  bots.dispose();
}

// --- kits, crews, deploy ------------------------------------------------------
{
  const { game, bots, commander, replan, bodies, teamOf } = fixture();
  replan();
  for (const team of ['alpha', 'bravo']) {
    const ts = commander.teams.get(team);
    for (const squad of ts.squads.values()) {
      const kits = squad.members.map(id => commander.kitFor(game.entities.get(id)));
      assert(kits.every(k => KIT_IDS.includes(k)), 'every kit is a contract kit');
      if (squad.members.length >= 3) assert.deepEqual(kits.slice(0, 3), ['assault', 'engineer', 'support'], 'squad mix: assault, engineer, support ...');
      if (squad.members.length >= 4) assert(['recon', 'assault'].includes(kits[3]), '... and recon or assault');
    }
    const teamBots = bots.brains.filter(br => teamOf(game.entities.get(br.id)) === team).length;
    assert(ts.crews.size <= Math.ceil(teamBots / 3), `${team} crew budget <= ceil(teamBots/3) (${ts.crews.size}/${teamBots})`);
    const types = [...ts.crews.values()].map(c => `${game.vehicles.vehicles.get(c.vehicleId)?.type}:${c.seatId}`);
    assert(types.includes('tank:driver'), `${team}: the tank driver is the first crew slot (${types.join(',')})`);
    if (ts.crews.size >= 2) assert(types.includes('helicopter:driver'), `${team}: the attack helicopter pilot comes next`);
  }
  // Deploy: a dead crew bot spawns straight into its seat; others pick a valid option.
  const alpha = commander.teams.get('alpha');
  const [crewId, crew] = [...alpha.crews.entries()][0];
  const p = game.entities.get(crewId);
  game.killPlayer(p, null, 'world', false);
  policy_refresh(game);
  replan();
  const pick = commander.deployFor(p);
  assert(pick && typeof pick.spawn === 'string', 'deployFor returns a spawn');
  const options = game.mode.policy.conquestView().deployOptions(p).filter(o => o.ok).map(o => o.spawn);
  assert(KIT_IDS.includes(pick.kit) && (pick.variant === 0 || pick.variant === 1), 'deployFor returns a kit and variant');
  if (alpha.crews.get(crewId)) {
    const seat = `vehicle:${crew.vehicleId}`;
    assert(pick.spawn === `${seat}:${crew.seatId}` || options.includes(pick.spawn), `a crew bot deploys into its seat or a valid option (${pick.spawn})`);
  }
  for (const other of bodies('bravo').slice(0, 4)) {
    const choice = commander.deployFor(other);
    const valid = game.mode.policy.conquestView().deployOptions(other).filter(o => o.ok).map(o => o.spawn);
    const base = choice.spawn.split(':').slice(0, 2).join(':');
    assert(choice.spawn === 'hq' || valid.includes(choice.spawn) || valid.includes(base), `bravo deploy choice is a valid option (${choice.spawn})`);
  }
  bots.dispose();
}

// --- engineer gadgets: AT by default, a share of STINGERs once enemy aircraft fly ----------------
{
  const { game, bots, commander, replan, bodies } = fixture();
  replan();
  const engineers = bodies('alpha').filter(p => commander.kitFor(p) === 'engineer');
  const others = bodies('alpha').filter(p => commander.kitFor(p) !== 'engineer');
  assert(engineers.length >= 1, 'alpha has engineer bots');
  assert(others.every(p => commander.gadgetFor(p) === 0), 'only engineers pick a gadget');
  assert(engineers.every(p => commander.gadgetFor(p) === 0), 'no enemy aircraft in play: every engineer carries the AT launcher');
  assert.equal(commander.deployFor(engineers[0]).gadget, 0, 'deployFor carries the gadget choice');
  // An enemy helicopter is crewed: a share of the engineers switches to the STINGER on the next deploy.
  const heli = [...game.vehicles.vehicles.values()].find(v => v.team === 'bravo' && v.type === 'helicopter');
  const pilot = bodies('bravo').find(p => !p.vehicleId);
  game.vehicles.release?.(pilot);
  Object.assign(pilot, { x: heli.x, y: heli.y, z: heli.z });
  assert(game.vehicles.enter(pilot, heli.id, 'driver') || heli.occupantId != null, 'an enemy pilot crews the helicopter');
  game.now += 1500; // past the air-threat cache
  const aa = engineers.filter(p => commander.gadgetFor(p) === 1);
  assert(aa.length >= 1 && aa.length <= Math.max(1, Math.round(engineers.length * 0.4)), `one enemy aircraft: ${aa.length}/${engineers.length} AA engineers`);
  assert.deepEqual(engineers.map(p => commander.gadgetFor(p)), engineers.map(p => commander.gadgetFor(p)), 'the split is stable');
  const jet = [...game.vehicles.vehicles.values()].find(v => v.team === 'bravo' && v.type === 'plane');
  jet.grounded = false;
  game.now += 1500;
  const aa2 = engineers.filter(p => commander.gadgetFor(p) === 1);
  assert(aa2.length >= aa.length, 'more enemy aircraft, at least as many STINGERs');
  // The choice reaches the authoritative loadout: an AA engineer bot respawns owning the STINGER.
  const pick = aa[0];
  // (Bot pilots come and go; hold the air threat so the redeploy sees it.)
  commander.enemyAirThreat = () => 2;
  game.killPlayer(pick, null, 'world', false);
  for (let i = 0; i < 60 * 8 && pick.state !== 'alive'; i++) game.step(TICK_MS);
  assert.deepEqual(game.mode.policy.kitFor(pick), { kit: 'engineer', variant: 0, gadget: 1 }, 'the deploy state holds the STINGER choice');
  assert.equal(pick.state, 'alive', 'the AA engineer bot redeploys');
  assert(pick.owned.includes('stinger') && !pick.owned.includes('rocket'), `the redeployed bot carries the STINGER (${pick.owned})`);
  bots.dispose();
}

// --- cost: a full replan of both teams is cheap ------------------------------------
{
  const { game, bots, commander, replan } = fixture();
  replan();
  const t0 = performance.now();
  for (let i = 0; i < 40; i++) replan();
  const ms = (performance.now() - t0) / 40;
  console.log(`commander replan (both teams, 16 bots): ${ms.toFixed(3)} ms every ${COMMANDER_PLAN_MS} ms`);
  assert(ms < 6, `a replan costs < 6 ms (${ms.toFixed(2)})`);
  // Run the live loop briefly: the director keeps answering through real ticks.
  for (let i = 0; i < 120; i++) game.step(TICK_MS);
  assert(bots.brains.every(br => game.entities.get(br.id)), 'bots survive live ticks with the director attached');
  bots.dispose();
  assert.equal(game.mode.policy.director, null, 'dispose unregisters the director');
}

function policy_refresh(game) { game.mode.policy._view = null; }

console.log('conquest bot commander tests passed');
