// Conquest bot capture flow and Medic uptime (server/bot-flag-flow.js,
// server/bot-medic.js). Pure checks of the rules against stub commanders,
// then the real GameEngine + attachBots + ConquestPolicy on Frontier v2:
//  - a squad's attack order survives a re-plan that would flip it to another
//    flag, and frees once its flag is taken or its commitment runs out;
//  - a bot standing in an enemy flag stays there until the flag turns, even
//    with its squad ordered elsewhere, and the capture completes;
//  - a bot walking past an undefended enemy flag takes it on the way;
//  - a Medic bot trails a walking squad mate inside the heal aura, picks a mate
//    it can catch up with, and a revive run is only taken while it can finish;
//  - a bot in a trench the surface graph does not cover vaults out (bot-unstick.js).
//
//   node tools/conquest-bot-flow-test.mjs
import assert from 'node:assert/strict';
import { createMapState, getMapMeta } from '../shared/worlddata.js';
import { GameEngine } from '../server/game.js';
import { attachBots } from '../server/bots.js';
import { TICK_MS } from '../server/protocol/admission.js';
import { mulberry32 } from '../shared/noise.js';
import { CONQUEST_RULES } from '../shared/conquest-contract.js';
import { KIT_ROLE_RULES } from '../shared/conquest-kits.js';
import { FLAG_FLOW_RULES, committedFlag, keepAttackOrder, passingFlag, turnRemaining } from '../server/bot-flag-flow.js';
import { MEDIC_BOT_RULES, medicTrailMate, medicTrailSpot, reviveRunInTime } from '../server/bot-medic.js';
import { pitEscape } from '../server/bot-unstick.js';
import { surfaceNavigation } from '../server/bot-surface-nav.js';

const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
let checks = 0;
const ok = (value, message) => { assert.ok(value, message); checks++; };

// ------------------------------------------------------------ pure rules --
{
  const flags = [
    { id: 'C', x: 0, y: 20, z: 0, radius: 20, owner: 'bravo', state: 'idle' },
    { id: 'D', x: 200, y: 20, z: 0, radius: 20, owner: 'bravo', state: 'idle' },
    { id: 'B', x: -200, y: 20, z: 0, radius: 20, owner: 'alpha', state: 'idle' },
  ];
  const view = { flags };
  const entities = new Map();
  const add = (id, x, z, extra = {}) => { const p = { id, x, y: 20, z, state: 'alive', bot: true, team: 'alpha', ...extra }; entities.set(id, p); return p; };
  const presence = new Map(flags.map(f => [f.id, { alpha: 0, bravo: 0 }]));
  const known = new Map();
  const commander = {
    game: { entities }, presence,
    teamOf: p => p.team, kitOf: p => p.kit ?? 'assault',
    defenders: flag => known.get(flag.id) ?? 0,
    squadCentroid: squad => {
      const list = squad.members.map(id => entities.get(id)).filter(p => p?.state === 'alive' && !p.vehicleId);
      if (!list.length) return null;
      return { x: list.reduce((s, p) => s + p.x, 0) / list.length, z: list.reduce((s, p) => s + p.z, 0) / list.length };
    },
    objectiveFlagOf: p => flags.find(f => f.id === p.flagId) ?? null,
  };
  const ts = { team: 'alpha', memberSquad: new Map() };
  const a = add('a', -150, 0), b = add('b', -152, 4);
  const squad = { id: 1, members: ['a', 'b'] };
  const prior = { stance: 'attack', flagId: 'C', issuedAt: 0 };
  // Commitment against another attack plan, then its end.
  ok(keepAttackOrder(commander, squad, prior, { stance: 'attack', flagId: 'D' }, view, ts, 10000), 'an attack order keeps its flag against a re-plan to another flag');
  ok(!keepAttackOrder(commander, squad, prior, { stance: 'attack', flagId: 'D' }, view, ts, FLAG_FLOW_RULES.attackCommitMs), 'the commitment ends after attackCommitMs');
  ok(keepAttackOrder(commander, squad, { ...prior, flank: true }, { stance: 'attack', flagId: 'D' }, view, ts, FLAG_FLOW_RULES.attackCommitMs + 1000), 'a flank order is committed longer');
  ok(!keepAttackOrder(commander, squad, prior, { stance: 'attack', flagId: 'D', flank: true }, view, ts, 1000), 'a stalled line sends its flankers at once');
  ok(keepAttackOrder(commander, squad, { ...prior, flagId: 'D', flank: true }, { stance: 'attack', flagId: 'C' }, view, ts, 1000), '... and the flank order sticks when the line moves again');
  ok(!keepAttackOrder(commander, squad, prior, { stance: 'defend', flagId: 'B', allIn: true }, view, ts, 1000), 'an all-in home defence always frees the squad');
  ok(!keepAttackOrder(commander, squad, prior, { stance: 'defend', flagId: 'B' }, view, ts, 1000), 'a squad on its way answers a defend call');
  // A capture under way extends the commitment and holds against a defend call.
  Object.assign(a, { x: 5, z: 0 });
  ok(keepAttackOrder(commander, squad, prior, { stance: 'defend', flagId: 'B' }, view, ts, 1000), 'a squad taking its flag finishes before it answers a defend call');
  ok(keepAttackOrder(commander, squad, prior, { stance: 'attack', flagId: 'D' }, view, ts, FLAG_FLOW_RULES.attackCommitMs + 1000), 'squad bots in the zone extend the commitment');
  ok(keepAttackOrder(commander, squad, prior, { stance: 'attack', flagId: 'D', flank: true }, view, ts, 1000), 'a capture under way is not abandoned for a flank');
  ok(!keepAttackOrder(commander, squad, prior, { stance: 'attack', flagId: 'D' }, view, ts, FLAG_FLOW_RULES.attackCommitMs * FLAG_FLOW_RULES.zoneCommitFactor), '... up to zoneCommitFactor times');
  flags[0].owner = 'alpha';
  ok(!keepAttackOrder(commander, squad, prior, { stance: 'attack', flagId: 'D' }, view, ts, 1000), 'a taken flag frees the squad at once');
  flags[0].owner = 'bravo';

  // Staying on a capture.
  presence.get('C').alpha = 1;
  ok(committedFlag(commander, a, 'alpha', view)?.id === 'C', 'a bot in an enemy zone its team holds stays on it');
  const defendB = { stance: 'defend', flagId: 'B' };
  flags[0].control = -0.9;
  ok(committedFlag(commander, a, 'alpha', view, defendB) === null, 'a defend order pulls it off a capture that has far to go');
  flags[0].control = -FLAG_FLOW_RULES.defendBreakRemaining / 2;
  ok(committedFlag(commander, a, 'alpha', view, defendB)?.id === 'C', '... but waits for a flag about to turn');
  ok(turnRemaining({ owner: null, control: 0.8 }, 'alpha') < 0.21 && turnRemaining({ owner: 'alpha', control: 1 }, 'bravo') === 1, 'turnRemaining measures control left to the next transition');
  flags[0].control = -1;
  presence.get('C').bravo = 2;
  ok(committedFlag(commander, a, 'alpha', view) === null, 'outnumbered in the zone, the order decides');
  presence.get('C').bravo = 0;
  Object.assign(a, { y: 20 + FLAG_FLOW_RULES.zoneDy + 1 });
  ok(committedFlag(commander, a, 'alpha', view) === null, 'a bot above the height band is not on the flag');
  Object.assign(a, { y: 20 });
  flags[0].owner = 'alpha';
  ok(committedFlag(commander, a, 'alpha', view) === null, 'a quiet owned flag holds nobody back');
  flags[0].state = 'neutralizing';
  ok(committedFlag(commander, a, 'alpha', view)?.id === 'C', 'an owned flag being neutralized keeps its defender in the zone');
  Object.assign(flags[0], { owner: 'bravo', state: 'idle' });

  // Taking an empty flag on the way.
  const walker = add('w', 175, 30);
  ok(passingFlag(commander, walker, ts, view, 'C')?.id === 'D', 'a bot passing an undefended enemy flag takes it');
  known.set('D', 1);
  ok(passingFlag(commander, walker, ts, view, 'C') === null, 'a flag the team knows is held is left to the order');
  known.delete('D');
  presence.get('D').alpha = FLAG_FLOW_RULES.passCrew;
  ok(passingFlag(commander, walker, ts, view, 'C') === null, `at most ${FLAG_FLOW_RULES.passCrew} passers detour onto one flag`);
  presence.get('D').alpha = 0;
  Object.assign(walker, { x: 260 });
  ok(passingFlag(commander, walker, ts, view, 'C') === null, 'a flag beyond passRadius is no detour');

  // Medic trail mate and spot.
  for (const id of ['a', 'b', 'w']) entities.delete(id);
  const medic = add('m', -100, 0, { kit: 'medic' });
  const ahead = add('ahead', -80, 0, { flagId: 'C' });
  const recon = add('recon', -95, 2, { kit: 'recon', flagId: 'C' });
  const other = add('other', -98, 1, { flagId: 'D' });
  ts.memberSquad.set('m', { members: ['m', 'ahead', 'recon'] });
  ok(medicTrailMate(commander, medic, ts, flags[0]) === ahead, 'the Medic trails the squad mate ahead before a nearer Recon');
  entities.delete('ahead'); entities.delete('recon');
  ok(medicTrailMate(commander, medic, ts, flags[0]) === null, 'another squad bound for a different flag is not trailed');
  other.flagId = 'C';
  ok(medicTrailMate(commander, medic, ts, flags[0]) === other, 'another squad bound for the same flag is');
  Object.assign(other, { x: -100 - MEDIC_BOT_RULES.trailNear - 40 });
  ok(medicTrailMate(commander, medic, ts, flags[0]) === null, 'a mate far behind on the way to the flag is not walked back to');
  const still = { x: 10, y: 20, z: 0, vx: 0, vz: 0 };
  const spot = medicTrailSpot(medic, still, flags[0]);
  ok(Math.abs(flat(spot, still) - MEDIC_BOT_RULES.trailDist) < 1e-6 && flat(spot, flags[0]) > flat(still, flags[0]), 'a standing mate gets the Medic on its side away from the flag');
  const runner = { x: 10, y: 20, z: 0, vx: 6, vz: 0 };
  const led = medicTrailSpot(medic, runner, flags[0]);
  ok(led.x > runner.x + 6, 'a running mate is led, so the Medic keeps sprinting on its heels');
  ok(MEDIC_BOT_RULES.trailDist + MEDIC_BOT_RULES.trailArrive < KIT_ROLE_RULES.healRadius, 'the trail spot and its arrival stay inside the heal aura');
  ok(reviveRunInTime(20, 8000, 0, CONQUEST_RULES.reviveHoldMs) && !reviveRunInTime(MEDIC_BOT_RULES.reviveRange, 4000, 0, CONQUEST_RULES.reviveHoldMs),
    'a revive run is only taken while the down window outlasts the sprint and the hold');
}

// --------------------------------------------------------- live fixtures --
const meta = getMapMeta('frontier');
const world = createMapState('frontier');
const flagOf = id => meta.conquest.flags.find(f => f.id === id);

/** `n` alpha bots plus an idle bravo human far away; no hulls (no crew seats). */
function fixture(n, seed = 11) {
  Math.random = mulberry32(seed);
  const events = [];
  const game = new GameEngine({ mode: 'conquest', world, mapMeta: meta, broadcast: snap => events.push(...(snap.events ?? [])) });
  game.vehicles.vehicles.clear();
  const bots = attachBots(game, n);
  const policy = game.mode.policy;
  const list = bots.brains.map(br => game.entities.get(br.id));
  for (const p of list) policy.setLobbyTeam?.(p, 'alpha');
  game.addClient('enemy', 'ENEMY');
  const enemy = game.entities.get('enemy');
  policy.setLobbyTeam?.(enemy, 'bravo');
  for (let i = 0; i < 3; i++) game.step(TICK_MS);
  const place = (p, s, extra = {}) => Object.assign(p, { x: s.x, y: s.y, z: s.z, vx: 0, vy: 0, vz: 0, spawnProtectedUntil: 0, ...extra });
  const kit = (p, id, variant = 0) => { policy.roles.applyLoadout(p, id, variant, 0); p.hp = p.maxHp || 100; };
  place(enemy, meta.conquest.bases.bravo.spawns[0], { hp: 100000 });
  const setFlag = (id, patch) => Object.assign(policy.capture.flags.find(f => f.id === id), patch);
  return { game, bots, policy, list, enemy, events, place, kit, setFlag };
}

// A bot in flag D (EAST, nobody there) stays until it is captured, even with its squad sent to C.
{
  const f = fixture(1, 3);
  const [bot] = f.list;
  f.kit(bot, 'assault');
  const D = flagOf('D');
  const inside = D.spawns.find(s => flat(s, D) <= D.radius * 0.5) ?? D.spawns[0];
  f.place(bot, inside);
  const commander = f.bots.commander;
  let away = 0, ticks = 0, captured = false;
  for (let t = 0; t < 40000 && !captured; t += TICK_MS) {
    // Every re-plan, force the squad onto flag C (a stale or conflicting order).
    const squad = commander.teams.get('alpha').memberSquad?.get(String(bot.id));
    if (squad?.order) Object.assign(squad.order, { stance: 'attack', flagId: 'C', phase: 'push', staging: null });
    f.game.step(TICK_MS);
    ticks++;
    if (flat(bot, D) > D.radius) away++;
    captured = f.events.some(e => e.kind === 'flag_captured' && e.flag === 'D' && e.team === 'alpha');
  }
  ok(captured, 'a lone bot standing in an empty enemy flag captures it although its squad is sent elsewhere');
  ok(away / ticks < 0.05, `it stays in the zone while the flag turns (${(100 * away / ticks).toFixed(1)} % outside)`);
  f.bots.dispose(); f.game.stop?.();
}

// A bot ordered to C walks past an empty, undefended enemy flag and takes it.
{
  const f = fixture(1, 5);
  const [bot] = f.list;
  f.kit(bot, 'assault');
  const D = flagOf('D');
  // A spot just outside D's zone, inside the pass radius.
  const near = D.spawns.slice().sort((a, b) => flat(b, D) - flat(a, D))[0];
  const out = { x: D.x + (near.x - D.x) * (D.radius + 12) / Math.max(1, flat(near, D)), z: D.z + (near.z - D.z) * (D.radius + 12) / Math.max(1, flat(near, D)) };
  const nav = f.bots.commander.walkablePoint({ ...out, y: D.y });
  assert(nav, 'flag D has standable ground 12 m past its edge');
  f.place(bot, nav);
  f.setFlag('C', { owner: 'bravo', control: -1, state: 'idle' });
  let detoured = false, captured = false;
  for (let t = 0; t < 45000 && !captured; t += TICK_MS) {
    f.game.step(TICK_MS);
    if (f.bots.commander.goalFor(bot).target?.id === 'D') detoured = true;
    captured = f.events.some(e => e.kind === 'flag_captured' && e.flag === 'D' && e.team === 'alpha');
  }
  ok(detoured, 'the passing bot takes flag D as its goal');
  ok(captured, 'and captures it on the way');
  f.bots.dispose(); f.game.stop?.();
}

// A Medic bot keeps the aura on a squad mate walking toward C.
{
  const f = fixture(1, 9);
  const [medic] = f.list;
  f.game.addClient('mate', 'MATE');
  const mate = f.game.entities.get('mate');
  f.policy.setLobbyTeam?.(mate, 'alpha');
  f.game.step(TICK_MS);
  f.kit(medic, 'medic');
  const commander = f.bots.commander;
  const squad = () => commander.teams.get('alpha').memberSquad?.get(String(medic.id));
  // The human mate walks the West HQ spawn row and back (scripted at 4 m/s, flat ground).
  const row = meta.conquest.bases.alpha.spawns.filter(s => Math.abs(s.z - meta.conquest.bases.alpha.spawns[0].z) < 0.5).sort((a, b) => a.x - b.x);
  const from = row[0], to = row.at(-1);
  f.place(medic, { x: from.x - 8, y: from.y, z: from.z });
  f.place(mate, from);
  for (let i = 0; i < 40; i++) f.game.step(TICK_MS);
  ok(squad()?.members.includes(String(mate.id)), 'the human mate joined the Medic bot squad');
  let inAura = 0, samples = 0, dir = 1, u = 0, trailed = 0;
  for (let t = 0; t < 30000; t += TICK_MS) {
    u += dir * 4 * TICK_MS / 1000 / Math.max(1, flat(from, to));
    if (u >= 1 || u <= 0) { dir = -dir; u = Math.max(0, Math.min(1, u)); }
    const x = from.x + (to.x - from.x) * u, z = from.z + (to.z - from.z) * u;
    Object.assign(mate, { x, y: from.y, z, vx: dir * 4 * Math.sign(to.x - from.x), vz: 0, hp: 100 });
    f.game.step(TICK_MS);
    if (t < 5000) continue;
    samples++;
    if (Math.hypot(medic.x - mate.x, medic.y - mate.y, medic.z - mate.z) <= KIT_ROLE_RULES.healRadius) inAura++;
    const g = commander.goalFor(medic);
    if (g.point && flat(g.point, mate) < MEDIC_BOT_RULES.trailDist + 6) trailed++;
  }
  ok(trailed / samples > 0.9, `the Medic's goal is the spot on its mate (${(100 * trailed / samples).toFixed(0)} %)`);
  ok(inAura / samples > 0.75, `the walking mate stays inside the heal aura (${(100 * inAura / samples).toFixed(0)} % of 25 s)`);
  f.bots.dispose(); f.game.stop?.();
}

// A Medic already holding a revive finishes it although the window left is shorter than a fresh
// run would need (reviveRunInTime only gates new runs; re-checking it mid-hold dropped the revive).
{
  const f = fixture(2, 7);
  const [medic, mate] = f.list;
  f.kit(medic, 'medic'); f.kit(mate, 'assault');
  const C = flagOf('C');
  f.place(medic, C.spawns[0]); f.place(mate, C.spawns[0]);
  f.game.step(TICK_MS);
  mate.takeDamage(500, false, f.enemy, 'rifle');
  f.game.killPlayer(mate, f.enemy, 'rifle', false);
  const down = f.policy.roles.states.get(String(mate.id)).down;
  const left = CONQUEST_RULES.reviveHoldMs + 700;
  down.until = f.game.now + left;
  ok(!reviveRunInTime(0, down.until, f.game.now + 200, CONQUEST_RULES.reviveHoldMs + 600), 'the fixture window is too short to re-pass the run check mid-hold');
  let revived = false;
  for (let t = 0; t < left + 500 && !revived; t += TICK_MS) {
    f.game.step(TICK_MS);
    revived = f.events.some(e => e.kind === 'revive' && e.id === mate.id && e.by === medic.id);
  }
  ok(revived, `a Medic on the body finishes a revive with ${left} ms of the down window left`);
  f.bots.dispose(); f.game.stop?.();
}

// A bot dropped into a Ridge Bunkers trench the surface graph does not cover climbs out.
{
  const f = fixture(1, 13);
  const [bot] = f.list;
  f.kit(bot, 'assault');
  // Trench floor west of flag D (feet y 32 under a rim at 34, lips at 35).
  const pit = { x: 481.5, y: 32, z: 219.5 };
  ok(f.game.solidAt(481, 31, 219) && !f.game.solidAt(481, 32, 219) && f.game.solidAt(484, 33, 219), 'the trench fixture still matches the Frontier voxels');
  const nav = surfaceNavigation(f.game.world);
  ok(pitEscape(nav, f.game.solidAt, pit) === null, 'a body level with its start node and no route is no pit');
  // The route out runs over the rim two voxels up (the graph's vault edge), along a line the trench lip blocks.
  const escape = pitEscape(nav, f.game.solidAt, pit, { x: 486, y: 34.02, z: 222 });
  ok(escape && escape.to.y >= pit.y + 1.5, 'pitEscape finds a vault out of the trench toward the rim the route needs');
  // Titanfall shares Frontier but keeps the plain side-step (the escape is Conquest's).
  const br = f.bots.brains.find(b => b.id === bot.id);
  const tfStub = { game: { mode: { mode: 'titanfall' }, world: f.game.world }, solidAt: f.game.solidAt };
  ok(f.bots.planEscape.call(tfStub, { surfaceRoute: { points: [{ x: 486, y: 34.02, z: 222 }] } }, { ...pit, state: 'alive' }, f.game.now) === false,
    'a Titanfall bot never plans a Conquest pit escape');
  f.place(bot, pit);
  // The stuck watchdog plans the escape when the body has not moved for a window while the
  // route's next point sits on the rim (the live walk often gets out on its own: forced here).
  Object.assign(br, { intendsMove: true, watchX: pit.x, watchZ: pit.z, stuckSince: f.game.now - 1500, climbing: false,
    escape: null, surfaceRoute: { points: [{ x: 486, y: 34.02, z: 222 }] }, trap: { x: pit.x, z: pit.z, since: f.game.now, wedges: 0, wet: 0 } });
  f.bots.watchStuck(br, bot, f.game.now);
  ok(br.escape && br.trap.wedges === 1, 'the stuck watchdog plans a pit escape and counts the wedge');
  const to = br.escape.to;
  let out = false, redeployed = false, dropped = false;
  for (let t = 0; t < 15000 && !out; t += TICK_MS) {
    f.game.step(TICK_MS);
    redeployed ||= f.events.some(e => e.kind === 'kill' && e.victim === bot.id);
    out = bot.state === 'alive' && bot.y >= to.y - 0.3;
    if (!out && !br.escape) dropped = true;
  }
  ok(out && !redeployed, 'the bot vaults out of the trench instead of pressing into its wall until the trap redeploy');
  ok(!dropped, '... driven by the planned escape until it stands on the rim');
  f.bots.dispose(); f.game.stop?.();
}

console.log(`Conquest bot flow: ${checks} checks passed (attack commitment, zone stay, passing captures, Medic trail and revive timing, late revive, pit escape).`);
process.exit(0);
