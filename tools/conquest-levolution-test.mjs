// Levolutions (docs/conquest.md "Map events", "Levolutions"): the generic
// stage machine on a test definition over Frontier's north bridge (damaged,
// the groan with the crossing closed, the fall with crush, payDestroyed with
// an assist, the HUD presenter and FX hook, the rematch), then the bots on
// the Iron Bridge: crossingDenialValue by flag ownership, the demolish task
// and the bridgehead holds, a bot tank firing HE and a bot on foot firing an
// RX-8 at the supports.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { isSolidBlock } from '../shared/world/blocks.js';
import { WEAPON_IDS } from '../shared/combatmath.js';
import { defineLevolution } from '../shared/map-events/levolution.js';
import { LevolutionController } from '../server/modes/conquest/map-events/levolution.js';
import { attachBots } from '../server/bots.js';
import { crossingDenialValue, mapEventsView, roadMetres } from '../server/bot-map-events.js';
import { closedCrossings } from '../server/bot-bridge.js';
import { mapEventBanner } from '../public/js/ui/conquest/map-events.js';
import { levolutionPresenter } from '../public/js/ui/conquest/map-events/levolution.js';
import { levolutionFx } from '../public/js/fx/map-events/levolution.js';
import { TICK_MS, eventFixture, groundY } from './lib/map-event-fixtures.mjs';

const t0 = performance.now();
const DEF = defineLevolution({
  id: 'test-span', maps: ['frontier'], name: 'North Bridge', short: 'NORTH', anchor: { x: 396, y: 27, z: 149 }, crossing: 'bridge-north',
  integrity: 400, supports: [{ id: 'pier', x0: 395, y0: 18, z0: 145, x1: 396, y1: 25, z1: 152 }],
  span: { x0: 386, y0: 25, z0: 144, x1: 405, y1: 27, z1: 153 }, deckY: 26, waterY: 20,
  sinks: [{ x0: 395, y0: 18, z0: 145, x1: 396, y1: 24, z1: 152 }],
  heads: [{ x: 383.5, y: 27.02, z: 149.5 }, { x: 408.5, y: 27.02, z: 149.5 }], axis: 'x', detect: [396, 26, 149],
});

// ---------------------------------------------------------------- G1: the generic stage machine
{
  const F = eventFixture({ map: 'frontier', defs: [DEF], controllers: { 'test-span': LevolutionController } });
  const { game, policy, system, world } = F;
  const a = F.player('a', 'alpha'), b = F.player('b', 'alpha'), c = F.player('c', 'bravo');
  F.run(TICK_MS * 2);
  const event = system.instance('test-span'), target = event.controller.target('supports');
  assert(event.controller.levolution.active && target.enabled, 'the north bridge stands: the levolution takes part');
  assert(!F.snap.match.conquest.ev, 'an untouched levolution stays off the wire');
  const west = { x: 330, z: 150 }, east = { x: 470, z: 150 };
  const open = roadMetres(game, west, east, []), cut = roadMetres(game, west, east, ['bridge-north']);
  assert(cut > open + 50, `closing the north bridge lengthens the drive (${open.toFixed(0)} -> ${cut.toFixed(0)} m)`);

  system.targets.damage(target, 250, 'b');
  F.run(TICK_MS);
  assert.equal(event.phase, 'armed', 'below half the supports: damaged');
  const armed = F.kinds().find(e => e.phase === 'armed');
  const presenters = { 'test-span': levolutionPresenter() };
  assert.equal(mapEventBanner(armed, { defs: [DEF], presenters })?.detail, 'SUPPORTS AT 38 %', 'the HUD banners the supports left');
  const sounds = [], kit = { defs: [DEF], audio: { structureCreak: () => sounds.push('creak'), structureImpact: () => sounds.push('impact') } };
  const fx = levolutionFx();
  assert(fx.onEvent(armed, kit) && sounds.includes('creak'), 'the FX hook groans on damaged');

  system.targets.damage(target, 150, 'a');
  F.run(TICK_MS);
  assert.equal(event.phase, 'warning', 'the pool at 0: the groan');
  assert(closedCrossings(game).has('bridge-north'), 'the crossing closes for bot drivers from the groan on');
  assert(mapEventsView(game).structures.some(s => s.id === 'test-span' && s.closed && s.event === 'test-span'), 'the bots read the structure');
  const row = F.decoded().events[0];
  assert.deepEqual([row.phase, row.progress], ['warning', 1], 'ev: warning, the pool gone');
  assert.equal(presenters['test-span'].marker({ name: 'x' }, row).name, 'NORTH · COLLAPSING');

  F.runUntil(() => event.phase === 'active', 5000);
  assert.equal(event.phase, 'active', 'the groan runs out: the fall');
  F.place(c, 400.5, 149.5, 27.02);
  const fallen = F.kinds().find(e => e.note === 'fallen');
  assert(fallen?.data?.blocks > 300, `the span comes down (${fallen?.data?.blocks} blocks)`);
  const pts = id => F.kinds('score').filter(e => e.id === id && e.reason === 'map_event').reduce((n, e) => n + e.pts, 0);
  assert.equal(pts('a'), 300, 'the final blow pays 300');
  assert(pts('b') > 100 && pts('b') < 150, `the assist pays its share (${pts('b')})`);
  F.run(4000);
  assert(c.state !== 'alive' || c.hp < 100, 'a body on the span is crushed');
  assert(F.kinds('kill').every(k => k.victim !== 'c' || k.killer === 'a'), 'the crush is the final blow\'s');
  assert(!isSolidBlock(world.getBlock(390, 26, 149)) && !isSolidBlock(world.getBlock(401, 26, 149)), 'the deck is gone');
  assert(isSolidBlock(world.getBlock(383, 26, 149)), 'the bank stays');
  F.run(4000);
  assert(event.phase === 'done' && closedCrossings(game).has('bridge-north'), 'down for the round, the crossing stays closed');

  policy.reset();
  F.run(TICK_MS * 2);
  const again = system.instance('test-span');
  assert(again.phase === 'idle' && isSolidBlock(world.getBlock(390, 26, 149)) && !closedCrossings(game).has('bridge-north'), 'the rematch rebuilds it');
  fx.clear(kit);
}

// ---------------------------------------------------------------- G2 / F1: the bots on the Iron Bridge
{
  const F = eventFixture({ map: 'frontier' });
  const { game, policy } = F;
  const bots = attachBots(game, 2);
  F.run(TICK_MS * 2);
  const setOwners = own => { for (const f of policy.capture.flags) { f.owner = own[f.id]; f.control = own[f.id] === 'alpha' ? -1 : own[f.id] ? 1 : 0; f.state = 'idle'; f.mover = null; } };
  setOwners({ A: 'alpha', B: 'alpha', C: 'alpha', D: 'bravo', E: 'bravo' });
  game.now += 20000;
  const even = crossingDenialValue(game, 'bravo', { close: 'iron-bridge' });
  setOwners({ A: 'alpha', B: 'alpha', C: 'alpha', D: 'alpha', E: 'bravo' });
  game.now += 20000;
  const east = crossingDenialValue(game, 'bravo', { close: 'iron-bridge' }), westV = crossingDenialValue(game, 'alpha', { close: 'iron-bridge' });
  assert(east > 300 && westV < -300 && Math.abs(east + westV) < 1, `cornered East gains by the bridge down (E ${east}, W ${westV})`);
  assert(Math.abs(even) < east, `uneven holdings drive the value (W:ABC E:DE ${even})`);

  const brains = bots.brains.map(br => game.entities.get(String(br.id)));
  const bot = brains.find(p => game.mode.teamFor(p) === 'bravo'), other = brains.find(p => p !== bot);
  F.place(other, 80, 384);
  const tasks = team => (bots.commander.teams.get(team).structureTasks ?? []).map(t => t.id);
  const bridge = policy.bridge;
  // A bot tank east of the bridge: booked on the task, it fires HE at the supports.
  const tank = [...game.vehicles.vehicles.values()].find(v => v.type === 'tank' && v.team === 'bravo');
  for (const v of game.vehicles.vehicles.values()) if (v.team === 'bravo' && v !== tank) Object.assign(v, { hp: 0, respawnIn: 1e9 });
  Object.assign(tank, { x: 470, y: groundY(F.world, 470, 386) + 0.05, z: 386, vx: 0, vy: 0, vz: 0, yaw: Math.PI / 2, grounded: true });
  F.place(bot, 473, 386);
  assert(game.vehicles.enter(bot, tank.id, 'driver'));
  F.runUntil(() => bridge.damage > 0, 20000);
  assert(tasks('bravo').includes('demolish:iron-bridge'), `East posts the demolish task (${tasks('bravo')})`);
  assert(tasks('alpha').some(id => id.startsWith('hold:iron-bridge')), `West holds the bridgeheads (${tasks('alpha')})`);
  assert(bridge.damage > 50 && bridge.by === String(bot.id), `the bot tank shells the supports (${bridge.damage.toFixed(0)})`);
  const shelled = bridge.damage;

  // On foot with an RX-8 (no hull left): it walks to the standoff and fires rockets.
  bridge.reset();
  game.vehicles.release(bot);
  Object.assign(tank, { hp: 0, respawnIn: 1e9 });
  F.place(bot, 455, 384);
  const slot = WEAPON_IDS.indexOf('rocket');
  bot.owned = [...new Set([...(bot.owned ?? []), 'rocket'])]; bot.mag[slot] = 1; bot.reserve[slot] = 4;
  F.runUntil(() => { if (bot.vehicleId) game.vehicles.release(bot); return bridge.damage > 0; }, 20000);
  assert(bridge.damage > 50 && bridge.by === String(bot.id), `the bot on foot rockets the supports (${bridge.damage.toFixed(0)})`);
  console.log(`levolution: values E ${east} / W ${westV} (even ${even}), tank HE ${shelled.toFixed(0)}, RX-8 ${bridge.damage.toFixed(0)} of ${bridge.rules.integrity}`);
  bots.dispose();
}

console.log(`conquest levolution: ok (${(performance.now() - t0).toFixed(0)} ms)`);
