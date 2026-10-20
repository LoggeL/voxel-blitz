// Conquest Iron Bridge collapse (docs/conquest.md "Iron Bridge collapse") on
// the authoritative Frontier world:
//  - rules, wire contract (v6: `br`, the `bridge` event, BRIDGE DESTROYED);
//  - a real RX-8 rocket against a pier wears the integrity down through
//    ProjectileSystem.explode -> mode.onBlast; bullets and far blasts do not;
//  - damaged -> failing -> down, with the groan window, one event per stage,
//    the score to the final blow and `match.conquest.br` for late joiners;
//  - the span empties into the river (no deck left over the water, rubble
//    under the surface), the bank stubs stand, infantry and hulls on the span
//    take the crush, and two engines fed the same blasts agree block for block;
//  - the infantry surface graph loses the crossing, bot drivers route over a
//    ford, objective points move to the bridgehead, C stays capturable from
//    the bank and its spawns stay standable; bots and the commander keep
//    running; a rematch rebuilds the bridge;
//  - client: banner, countdown, chip badge, map model and painter, stinger, FX.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createMapState, getMapMeta } from '../shared/worlddata.js';
import { GameEngine } from '../server/game.js';
import { TICK_MS } from '../server/protocol/admission.js';
import { attachBots } from '../server/bots.js';
import { SurfaceNav, TerrainWatch } from '../server/bot-surface-nav.js';
import { vehicleRoute } from '../server/bot-vehicle-driving.js';
import { avoidSpan, bridgeheadPoint, closedCrossings, crossesClosedSpan, spanEscape } from '../server/bot-bridge.js';
import { CONCRETE, FLUID_BLOCKS, isSolidBlock } from '../shared/world/blocks.js';
import { STRUCTURE_RULES } from '../shared/structure.js';
import { vehicleMaxHp } from '../shared/vehicles.js';
import {
  CONQUEST_CONTRACT_VERSION, CONQUEST_EVENT_KINDS, CONQUEST_RULES, SCORE_LABELS, SCORE_POINTS,
} from '../shared/conquest-contract.js';
import { decodeConquestMatch } from '../shared/conquest.js';
import {
  BRIDGE_STAGE, BRIDGE_STAGES, IRON_ARCH, IRON_BRIDGE, IRON_BRIDGE_RULES, boxDistance, bridgeBlastDamage, crossesBridgeSpan,
  decodeBridge, encodeBridge, onBridgeSpan,
} from '../shared/conquest-bridge.js';
import { IRON_ARCH_TOP_Y } from '../shared/world/frontier-sites/bridge.js';
import { CONQUEST_BRIDGE_KEY, CONQUEST_CONTRACT, CONQUEST_MATCH_BUDGET_BYTES, conquestMatchBytes } from './lib/protocol-contract.mjs';
import { IronBridge } from '../server/modes/conquest/bridge.js';
import {
  bannerCountdown, bridgeBanner, bridgeChipBadge, bridgeMapModel, bridgeStateBanner, hasIronBridge, paintBridge, paintBridgeFlag,
} from '../public/js/ui/conquest/bridge-hud.js';
import { scheduleBanner } from '../public/js/ui/conquest/banners.js';
import { stingerForEvent } from '../public/js/audio/objective-cues.js';
import { BRIDGE_FX, BridgeFx } from '../public/js/fx/bridge-fx.js';

const meta = getMapMeta('frontier');
const S = IRON_BRIDGE.span;
const PIER = [IRON_BRIDGE.x - 0.5, IRON_BRIDGE.waterY + 1, IRON_BRIDGE.z - 2.5];
const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
/** An event without its absolute clock fields (each engine starts on its own wall clock). */
const strip = ev => Object.fromEntries(Object.entries(ev).filter(([k]) => !['at', 'fallAt', 'land', 't'].includes(k)));

// ---------------------------------------------------------------- rules and contract
{
  assert.equal(CONQUEST_CONTRACT_VERSION, 8, 'the bridge is contract v6');
  assert.equal(CONQUEST_CONTRACT.version, 7);
  assert.equal(CONQUEST_BRIDGE_KEY, 'br');
  assert.equal(CONQUEST_EVENT_KINDS.indexOf('bridge'), CONQUEST_EVENT_KINDS.indexOf('weather_strike') + 1, 'the bridge event kind is appended after the weather');
  assert.equal(SCORE_POINTS.bridge_destroyed, 200);
  assert.equal(SCORE_LABELS.bridge_destroyed, 'BRIDGE DESTROYED');
  assert(S.y1 >= IRON_ARCH_TOP_Y, 'the falling box reaches over the arch crown of the voxel site');
  assert.deepEqual(BRIDGE_STAGES, ['intact', 'damaged', 'failing', 'down']);
  const crossing = meta.conquest.crossings.find(c => c.id === IRON_BRIDGE.crossing);
  assert(crossing && crossing.kind === 'bridge', 'the Iron Bridge is a mapMeta crossing');
  const C = meta.conquest.flags.find(f => f.id === IRON_BRIDGE.flag);
  assert(flat(C, IRON_BRIDGE) < 1, 'flag C stands on the bridge');
  // Integrity accounting: 10 rockets, 3 bombs.
  assert.equal(Math.ceil(IRON_BRIDGE_RULES.integrity / IRON_BRIDGE_RULES.supportDamage.rocket), 10);
  assert.equal(Math.ceil(IRON_BRIDGE_RULES.integrity / IRON_BRIDGE_RULES.supportDamage.jetBomb), 3);
  // The wave's explosives: the Support mortar's HE bomb and the mobile AA's 35 mm flak.
  assert.equal(Math.ceil(IRON_BRIDGE_RULES.integrity / IRON_BRIDGE_RULES.supportDamage.mortarHE), 25, 'five mortar magazines drop it');
  assert.equal(Math.ceil(IRON_BRIDGE_RULES.integrity / IRON_BRIDGE_RULES.supportDamage.flak35), 250, 'flak barely chips it');
  assert(IRON_BRIDGE_RULES.supportDamage.mortarHE < IRON_BRIDGE_RULES.supportDamage.tankHE && IRON_BRIDGE_RULES.supportDamage.flak35 < IRON_BRIDGE_RULES.supportDamage.frag,
    'a mortar bomb is lighter than a tank shell and a flak shell than a frag grenade');
  for (const key of ['mortarHE', 'flak35']) assert(bridgeBlastDamage(PIER, key, 3).damage === IRON_BRIDGE_RULES.supportDamage[key], `${key} on a pier takes its share`);
  const hit = bridgeBlastDamage(PIER, 'rocket', 3);
  assert.equal(hit.support, 'piers'); assert.equal(hit.damage, 100, 'a rocket on a pier takes its full share');
  assert.equal(bridgeBlastDamage(PIER, 'rifle', 3).damage, 0, 'bullets do nothing');
  assert.equal(bridgeBlastDamage(PIER, 'smoke', 6).damage, 0, 'smoke does nothing');
  // The wall claymore explodes as projectile type `limpet`: its share is the claymore's.
  assert.equal(bridgeBlastDamage(PIER, 'limpet', 3).damage, 10, 'a claymore barely scratches the supports');
  assert.equal(bridgeBlastDamage([IRON_BRIDGE.x, IRON_BRIDGE.deckY + 12, IRON_BRIDGE.z - 30], 'jetBomb', 6).damage, 0, 'out of reach');
  const feet = bridgeBlastDamage([IRON_ARCH.x0 + 0.5, IRON_BRIDGE.deckY + 1.5, IRON_ARCH.zs[0] + 0.5], 'tankHE', 3);
  assert(feet.support.startsWith('foot-w') && feet.damage === 120, 'a truss foot on the bank is a support too');
  const graze = bridgeBlastDamage([PIER[0], PIER[1], IRON_BRIDGE.piers.z0 - 1.5], 'rocket', 3);
  assert(graze.damage > 0 && graze.damage < 100, 'damage falls off with the distance to the support');
  assert.equal(boxDistance(IRON_BRIDGE.piers, ...PIER), 0);
  // Wire row.
  assert.equal(encodeBridge({ stage: 0, integrity: 1 }), null, 'an untouched bridge sends nothing');
  assert.deepEqual(encodeBridge({ stage: 1, integrity: 0.42 }), [1, 42]);
  assert.deepEqual(encodeBridge({ stage: 2, integrity: 0, fallAt: 1234.4 }), [2, 0, 1234]);
  assert.deepEqual(decodeBridge([2, 0, 1234]), { stage: 2, name: 'failing', integrity: 0, fallAt: 1234 });
  assert.deepEqual(decodeBridge(undefined), { stage: 0, name: 'intact', integrity: 1, fallAt: null });
  assert.equal(decodeConquestMatch({ br: [3, 0], flags: [], tickets: {} }, meta.conquest).bridge.name, 'down');
  // Geometry helpers.
  assert(onBridgeSpan(IRON_BRIDGE.x, IRON_BRIDGE.deckY + 1.02, IRON_BRIDGE.z), 'the deck is on the span');
  assert(!onBridgeSpan(S.x0 - 3, IRON_BRIDGE.deckY + 1.02, IRON_BRIDGE.z), 'the quay is not');
  assert(!onBridgeSpan(IRON_BRIDGE.x, IRON_BRIDGE.deckY + 12, IRON_BRIDGE.z), 'a helicopter overhead is not');
  assert(crossesBridgeSpan({ x: S.x0 - 30, z: IRON_BRIDGE.z }, { x: S.x1 + 30, z: IRON_BRIDGE.z }));
  assert(!crossesBridgeSpan({ x: S.x0 - 30, z: IRON_BRIDGE.z - 60 }, { x: S.x1 + 30, z: IRON_BRIDGE.z - 60 }));
  const west = bridgeheadPoint(-1), east = bridgeheadPoint(1);
  assert(west.x < S.x0 && east.x > S.x1 + 1, 'bridgeheads stand past the span on either bank');
  assert(flat(west, C) < C.radius - 4 && flat(east, C) < C.radius - 4, 'both bridgeheads are inside flag C');
}

// ---------------------------------------------------------------- engine on the real Frontier
function fixture({ blast = 'rocket' } = {}) {
  const world = createMapState('frontier');
  const events = [];
  let snap = null;
  const game = new GameEngine({ mode: 'conquest', world, mapMeta: meta, broadcast: s => { snap = s; for (const e of s.events ?? s.ev ?? []) events.push(e); } });
  const run = ms => { for (let t = 0; t < ms - 1e-6; t += TICK_MS) game.step(TICK_MS); };
  const player = (id, team) => {
    game.addClient(id, id);
    const p = game.entities.get(id);
    game.mode.policy.setLobbyTeam(p, team);
    return p;
  };
  return { world, game, events, run, player, blast, get snap() { return snap; }, bridge: game.mode.policy.bridge };
}

const placeOnDeck = (p, x, z) => Object.assign(p, { x, y: IRON_BRIDGE.deckY + 1.02, z, vx: 0, vy: 0, vz: 0, hp: 100, state: 'alive',
  spawnProtected: false, spawnProtectedUntil: 0, grounded: true });

const spanLeft = world => {
  let n = 0;
  for (let z = S.z0; z <= S.z1; z++) for (let x = S.x0; x <= S.x1; x++) {
    if (!FLUID_BLOCKS.has(world.templateBlock?.(x, IRON_BRIDGE.waterY, z) ?? world.getBlock(x, IRON_BRIDGE.waterY, z)) && !(x >= IRON_BRIDGE.piers.x0 && x <= IRON_BRIDGE.piers.x1)) continue;
    for (let y = IRON_BRIDGE.waterY + 1; y <= S.y1; y++) if (isSolidBlock(world.getBlock(x, y, z))) n++;
  }
  return n;
};

const F = fixture();
const { game, events, run, bridge } = F;
const policy = game.mode.policy;
const a = F.player('a', 'alpha'), b = F.player('b', 'bravo');
run(TICK_MS * 2);
assert.equal(game.mode.phase, 'live', 'the match is live');
assert.equal(bridge.active, true, 'Frontier has the Iron Bridge');
assert.equal(bridge.stage, BRIDGE_STAGE.intact);
assert(!('br' in F.snap.match.conquest), 'an intact bridge adds no field to match.conquest');
const deckBlocks = spanLeft(F.world);
assert(deckBlocks > 300, `the pristine span carries the deck, girders and truss (${deckBlocks})`);

// The surface graph and a road route before the fall.
const nav = new SurfaceNav(F.world, meta.navigation);
nav.build();
const watch = new TerrainWatch(game);
const westHead = bridgeheadPoint(-1), eastHead = bridgeheadPoint(1);
const walkBefore = nav.route(nav.snap(westHead, 2), nav.snap(eastHead, 2));
assert(walkBefore.reached && walkBefore.length < 60, `infantry cross the bridge directly (${walkBefore.length?.toFixed(0)} m)`);
const jeep = [...game.vehicles.vehicles.values()].find(v => v.type === 'jeep' && v.team === 'alpha');
assert(jeep, 'an alpha jeep exists');
const goalEast = { x: IRON_BRIDGE.x + 60, y: 26, z: IRON_BRIDGE.z };
const driveFrom = { ...jeep, x: IRON_BRIDGE.x - 60, y: 26, z: IRON_BRIDGE.z, spawn: null };
const routeBefore = vehicleRoute(game, driveFrom, goalEast);
const viaSpan = route => route.some((p, i) => i && crossesBridgeSpan(route[i - 1], p, 0));
assert(viaSpan(routeBefore), 'bot drivers take the bridge while it stands');

// A real RX-8 rocket from the river against a pier: explode -> onBlast.
b.vehicleId = null;
const rocket = game.projectiles.launchRocket(b, game.contexts.projectiles, { x: 1, y: 0, z: 0 },
  { origin: [IRON_BRIDGE.x - 4.5, IRON_BRIDGE.waterY + 1.6, IRON_BRIDGE.z - 2.5] });
assert(rocket, 'the rocket launches');
run(400);
assert(bridge.integrity < 1 && bridge.integrity >= 0.89, `one rocket on a pier wears the supports (${bridge.integrity.toFixed(2)})`);
assert.equal(bridge.by, 'b', 'the blast is credited to its owner');
// Bullets and blasts elsewhere leave it alone.
const before = bridge.integrity;
game.mode.onBlast([IRON_BRIDGE.x, 30, IRON_BRIDGE.z - 80], { key: 'rocket', radius: 3, ownerId: 'b' });
game.mode.onBlast(PIER, { key: 'rifle', radius: 0, ownerId: 'b' });
assert.equal(bridge.integrity, before);

// Damaged at half.
while (bridge.stage === BRIDGE_STAGE.intact) game.mode.onBlast(PIER, { key: 'rocket', radius: 3, ownerId: 'b' });
assert.equal(bridge.stage, BRIDGE_STAGE.damaged);
assert(bridge.integrity <= IRON_BRIDGE_RULES.damagedAt + 1e-9);
run(TICK_MS * 2);
assert.deepEqual(F.snap.match.conquest.br, [1, Math.round(bridge.integrity * 100)], 'late joiners read the damage from br');
assert.equal(bridge.closed, false, 'a damaged bridge still carries the bots');

// Bodies on the span: an alpha soldier and the alpha jeep.
placeOnDeck(a, IRON_BRIDGE.x + 0.5, IRON_BRIDGE.z + 0.5);
Object.assign(jeep, { x: IRON_BRIDGE.x - 2, y: IRON_BRIDGE.deckY + 1.02, z: IRON_BRIDGE.z + 3, vx: 0, vy: 0, vz: 0, speed: 0 });
const jeepHp = jeep.hp;

// Failing: the last blow starts the groan.
while (bridge.stage === BRIDGE_STAGE.damaged) game.mode.onBlast(PIER, { key: 'rocket', radius: 3, ownerId: 'b' });
assert.equal(bridge.stage, BRIDGE_STAGE.failing);
assert.equal(bridge.fallAt, game.now + IRON_BRIDGE_RULES.warnMs);
assert.equal(bridge.closed, true, 'the groan closes the crossing for bot drivers');
assert.equal(game.mode.onBlast(PIER, { key: 'jetBomb', radius: 6, ownerId: 'a' }), undefined);
assert.equal(bridge.by, 'b', 'blasts after the last blow do not steal the credit');
assert.deepEqual([...closedCrossings(game)], [IRON_BRIDGE.crossing]);
assert(crossesClosedSpan(game, westHead, eastHead));
const escape = spanEscape(game, a);
assert(escape && escape.x > S.x1 + 1, 'a bot on the failing span runs for its nearer bank');
assert.equal(spanEscape(game, { x: S.x0 - 12, y: 26, z: IRON_BRIDGE.z }), null, 'a bot on the quay stays put');
const cFlag = meta.conquest.flags.find(f => f.id === 'C');
assert.deepEqual(avoidSpan(game, cFlag, { x: S.x0 - 40, z: IRON_BRIDGE.z }), bridgeheadPoint(-1, cFlag.z), 'the C centre becomes the west bridgehead');
assert.equal(avoidSpan(game, { x: 300, y: 26, z: 300 }, a).x, 300, 'points off the span are unchanged');
run(TICK_MS * 2);
const br = F.snap.match.conquest.br;
assert.equal(br[0], 2); assert.equal(br[1], 0); assert.equal(br[2], Math.round(bridge.fallAt));
assert(conquestMatchBytes(F.snap.match.conquest) <= CONQUEST_MATCH_BUDGET_BYTES, 'match.conquest with br still fits its budget');
run(IRON_BRIDGE_RULES.warnMs - 200);
assert.equal(bridge.stage, BRIDGE_STAGE.failing, 'the span carries traffic through the groan');
assert(spanLeft(F.world) === deckBlocks, 'nothing falls before fallAt');

// Down.
const t0 = performance.now();
run(400 + STRUCTURE_RULES.creakMs + 3000);
const simMs = performance.now() - t0;
assert.equal(bridge.stage, BRIDGE_STAGE.down);
assert.deepEqual(F.snap.match.conquest.br, [3, 0]);
const stages = events.filter(e => e.kind === 'bridge');
assert.deepEqual(stages.map(e => e.name), ['damaged', 'failing', 'down'], 'one event per stage');
assert.equal(stages[1].fallAt, br[2]); assert.equal(stages[1].by, 'b');
assert(stages[2].blocks > 300, `the down event counts the falling blocks (${stages[2].blocks})`);
assert(events.some(e => e.kind === 'score' && e.id === 'b' && e.reason === 'bridge_destroyed'), 'the final blow scores BRIDGE DESTROYED');
assert(events.some(e => e.kind === 'creak'), 'the structural system creaks the span');
assert(events.filter(e => e.kind === 'collapse').length >= 1, 'chunks fall');
assert(events.filter(e => e.kind === 'collapse').length <= IRON_BRIDGE_RULES.chunkCap + 4, 'within the chunk budget');
const left = spanLeft(F.world);
assert(left <= 24 * 4, `the span over the river is gone, rubble aside (${left} blocks left)`);
// Every column over open water is clear from the surface to above the deck; the few footprint
// columns that stand on the irregular bank keep a ledge of deck on the quay.
let open = 0;
for (let z = S.z0; z <= S.z1; z++) for (let x = S.x0; x <= S.x1; x++) {
  if (!FLUID_BLOCKS.has(F.world.templateBlock(x, IRON_BRIDGE.waterY, z))) continue;
  open++;
  for (let y = IRON_BRIDGE.waterY + 1; y <= IRON_BRIDGE.deckY + 1; y++) {
    assert(!isSolidBlock(F.world.getBlock(x, y, z)), `nothing stands over the water at ${x},${y},${z}`);
  }
}
assert(open >= 110, `most of the footprint is open river now (${open} columns)`);
assert.equal(F.world.templateBlock(IRON_BRIDGE.piers.x0, IRON_BRIDGE.waterY, IRON_BRIDGE.piers.z0 + 1), CONCRETE, 'a pier stands here in the template');
assert(FLUID_BLOCKS.has(F.world.getBlock(IRON_BRIDGE.piers.x0, IRON_BRIDGE.waterY, IRON_BRIDGE.piers.z0 + 1)), 'the pier stumps turned into river water');
assert(isSolidBlock(F.world.getBlock(IRON_ARCH.x0, IRON_BRIDGE.deckY + 1, IRON_ARCH.zs[0])), 'the west truss foot stands');
assert(isSolidBlock(F.world.getBlock(IRON_ARCH.x1, IRON_BRIDGE.deckY + 1, IRON_ARCH.zs[1])), 'the east truss foot stands');
console.log(`collapse: ${stages[2].blocks} blocks, ${events.filter(e => e.kind === 'collapse').length} chunks, ${left} left over the river, ${simMs.toFixed(0)} ms for ${(400 + STRUCTURE_RULES.creakMs + 3000) / 1000} s sim`);
// The crush.
assert(a.hp <= 100 - IRON_BRIDGE_RULES.spanCrush.infantry || a.state === 'dead', `the soldier on the span takes the crush (${a.hp})`);
assert(jeep.hp <= jeepHp - vehicleMaxHp('jeep') * IRON_BRIDGE_RULES.spanCrush.hullFraction + 1e-6, `the jeep on the span takes ${IRON_BRIDGE_RULES.spanCrush.hullFraction * 100} % (${jeep.hp}/${jeepHp})`);
// A helicopter hovering low over the deck is not a ground hull; one parked on it is.
{
  const heli = [...game.vehicles.vehicles.values()].find(v => v.type === 'helicopter' && v.hp > 0);
  const home = { x: heli.x, y: heli.y, z: heli.z, grounded: heli.grounded };
  Object.assign(heli, { x: IRON_BRIDGE.x, y: IRON_BRIDGE.deckY + 3.5, z: IRON_BRIDGE.z, grounded: false });
  const hp = heli.hp;
  bridge._crushSpan();
  assert.equal(heli.hp, hp, 'a hovering helicopter over the span flies on');
  heli.grounded = true;
  bridge._crushSpan();
  assert(heli.hp < hp, 'a helicopter parked on the span goes down with it');
  Object.assign(heli, home, { hp });
}

// Infantry nav: the deltas reach the surface graph; the short way is gone.
const columns = watch.poll();
assert(columns && columns.size > 0, 'TerrainWatch reports the fallen span');
nav.applyChanges(columns);
const walkAfter = nav.route(nav.snap(westHead, 2), nav.snap(eastHead, 2));
assert(!walkAfter.reached || walkAfter.length > walkBefore.length * 2,
  `no short walk across any more (${walkBefore.length.toFixed(0)} m -> ${walkAfter.reached ? walkAfter.length.toFixed(0) + ' m' : 'unreached'})`);
// Vehicle route: over a ford.
const routeAfter = vehicleRoute(game, driveFrom, goalEast);
assert(!viaSpan(routeAfter), 'bot drivers no longer route over the span');
const fords = meta.conquest.crossings.filter(c => c.kind !== 'bridge');
assert(routeAfter.some(p => fords.some(f => flat(p, f) < 12)), 'they route over a ford');
const hullAtHead = { ...jeep, ...bridgeheadPoint(-1), spawn: null };
const routeToC = vehicleRoute(game, hullAtHead, cFlag);
assert(!viaSpan(routeToC), 'a hull ordered to C stops at its own bridgehead');
// Flag C: capturable from the bank, its spawns standable.
const cState = policy.capture.flags.find(f => f.id === 'C');
for (const spawn of cFlag.spawns) {
  const below = F.world.getBlock(Math.floor(spawn.x), Math.floor(spawn.y) - 1, Math.floor(spawn.z));
  assert(isSolidBlock(below), `C spawn ${spawn.x},${spawn.z} still stands on ground`);
}
Object.assign(b, { ...bridgeheadPoint(1), vx: 0, vy: 0, vz: 0, hp: 100, state: 'alive' });
if (a.state === 'alive') Object.assign(a, { x: 120, y: 40, z: 120 });
run(CONQUEST_RULES.captureMs ?? 12000);
assert(cState.control < 0 || cState.owner === 'bravo', `bravo moves C's control from the east bridgehead (${cState.control})`);

// Determinism: a second engine fed the same blasts drops the same blocks.
{
  const G = fixture();
  G.player('a', 'alpha'); G.player('b', 'bravo');
  G.run(TICK_MS * 2);
  for (let i = 0; i < 10; i++) G.game.mode.onBlast(PIER, { key: 'rocket', radius: 3, ownerId: 'b' });
  G.run(IRON_BRIDGE_RULES.warnMs + STRUCTURE_RULES.creakMs + 3400);
  const H = fixture();
  H.player('a', 'alpha'); H.player('b', 'bravo');
  H.run(TICK_MS * 2);
  for (let i = 0; i < 10; i++) H.game.mode.onBlast(PIER, { key: 'rocket', radius: 3, ownerId: 'b' });
  H.run(IRON_BRIDGE_RULES.warnMs + STRUCTURE_RULES.creakMs + 3400);
  assert.equal(G.bridge.stage, BRIDGE_STAGE.down); assert.equal(H.bridge.stage, BRIDGE_STAGE.down);
  const pick = list => list.filter(e => ['bridge', 'creak', 'collapse', 'collapse_land', 'crumble'].includes(e.kind)).map(strip);
  assert.deepEqual(pick(G.events), pick(H.events), 'the same bridge and structure events');
  assert.deepEqual([...G.game.changedBlocks].sort(), [...H.game.changedBlocks].sort(), 'the same block deltas');
  assert.equal(spanLeft(G.world), spanLeft(H.world));
}

// Bots and the commander keep running on the broken map (fresh engine, 16 bots, fallen bridge).
{
  const B = fixture();
  const bots = attachBots(B.game, 16);
  B.run(TICK_MS * 2);
  for (let i = 0; i < 10; i++) B.game.mode.onBlast(PIER, { key: 'rocket', radius: 3, ownerId: null });
  B.run(IRON_BRIDGE_RULES.warnMs + STRUCTURE_RULES.creakMs + 1500);
  assert.equal(B.bridge.stage, BRIDGE_STAGE.down);
  assert.equal(B.bridge.by, null, 'an ownerless blast scores nobody');
  assert(!B.events.some(e => e.kind === 'score' && e.reason === 'bridge_destroyed'));
  B.run(6000);
  assert(bots.brains.every(br => B.game.entities.get(br.id)), 'bots survive with the bridge down');
  const goals = [...B.game.entities.values()].filter(p => p.bot && p.state === 'alive')
    .map(p => B.game.mode.policy.director?.goalFor?.(p)).filter(g => g?.point);
  assert(goals.length > 0, 'the commander still hands out goals');
  for (const g of goals) assert(!(g.point.x >= S.x0 && g.point.x < S.x1 + 1 && g.point.z >= S.z0 && g.point.z < S.z1 + 1), `no goal on the gap (${g.point.x.toFixed(1)}, ${g.point.z.toFixed(1)})`);
  bots.dispose();
}

// Rematch: the world and the bridge come back.
{
  policy.ledger.tickets.bravo = 1;
  const victim = [b].find(p => p.state === 'alive');
  game.killPlayer(victim, a, 'rifle', false);
  run(TICK_MS * 2);
  assert.equal(game.mode.phase, 'post');
  const vote = F.snap.match.continuation;
  assert(game.mode.approveContinuation('a', vote.id));
  run(5000 + 2 * TICK_MS);
  assert.equal(game.mode.phase, 'live');
  assert.equal(bridge.stage, BRIDGE_STAGE.intact, 'the rematch resets the bridge');
  assert.equal(bridge.active, true);
  assert.equal(bridge.integrity, 1);
  assert.equal(spanLeft(F.world), deckBlocks, 'restoreWorld rebuilds every span block');
  assert.equal(F.world.getBlock(IRON_BRIDGE.piers.x0, IRON_BRIDGE.waterY, IRON_BRIDGE.piers.z0 + 1), CONCRETE, 'and the pier stumps under the water');
  assert(!('br' in F.snap.match.conquest), 'and the snapshot field is gone');
  assert.equal(closedCrossings(game).size, 0, 'the crossing reopens');
}

// A span the structural pass already doomed on its own falls as it is: no instant removal on top.
{
  const world = createMapState('frontier'), deltas = [];
  const engine = { world, mapMeta: meta, now: 0, mode: { phase: 'live' }, combatants: new Map(), tickEvents: [],
    structure: { active: true, rules: { creakMs: 700 }, bringDown: () => null, attribute: () => {} },
    pushBlockDelta: (x, y, z, v) => deltas.push(v) };
  const lone = new IronBridge({ engine: () => engine, now: () => 0 });
  assert.equal(lone.active, true);
  const piers = (() => { let n = 0; for (let z = IRON_BRIDGE.piers.z0; z <= IRON_BRIDGE.piers.z1; z++) for (let x = IRON_BRIDGE.piers.x0; x <= IRON_BRIDGE.piers.x1; x++) for (let y = IRON_BRIDGE.waterY; y >= IRON_BRIDGE.piers.y0 && world.getBlock(x, y, z) === CONCRETE; y--) n++; return n; })();
  assert(lone.collapse(0));
  assert.equal(deltas.length, piers, 'only the drowned pier stumps change; the creaking span is left to the structural system');
  assert.equal(lone.crushAt, 700, 'the crush still waits for the creak');
  assert(isSolidBlock(world.getBlock(IRON_BRIDGE.x, IRON_BRIDGE.deckY, IRON_BRIDGE.z)), 'the deck is still there until it falls');
}

// Inert elsewhere: an ad-hoc world without the deck never takes part.
{
  const dimensions = { sx: 128, sy: 32, sz: 128 };
  const world = { dimensions, getBlock: (_x, y) => (y < 2 ? 1 : 0), setBlock: () => true, findSpawns: () => [{ x: 20, y: 2, z: 20 }] };
  const g = new GameEngine({ mode: 'conquest', world, broadcast: () => {},
    mapMeta: { id: 'frontier', dimensions, spawns: { conquest: { alpha: [{ x: 20, y: 2, z: 20 }], bravo: [{ x: 30, y: 2, z: 20 }] } },
      conquest: { flags: [], bases: {}, vehicleSpawns: [], crossings: [] } } });
  assert.equal(g.mode.policy.bridge.active, false);
  g.mode.onBlast(PIER, { key: 'jetBomb', radius: 6, ownerId: 'x' });
  assert.equal(g.mode.policy.bridge.stage, BRIDGE_STAGE.intact);
  assert.equal(g.mode.policy.bridge.snapshot(), null);
}

// ---------------------------------------------------------------- client presentation
{
  const cq = { meta: meta.conquest, bridge: decodeBridge([2, 0, 5000]) };
  assert(hasIronBridge(cq));
  assert.equal(hasIronBridge({ meta: { crossings: [] }, bridge: cq.bridge }), false, 'other maps show nothing');
  assert.deepEqual(bridgeChipBadge(cq), { flag: 'C', badge: 'hazard' });
  assert.deepEqual(bridgeChipBadge({ ...cq, bridge: decodeBridge([3, 0]) }), { flag: 'C', badge: 'down' });
  assert.equal(bridgeChipBadge({ ...cq, bridge: decodeBridge(null) }), null);
  assert.equal(bridgeMapModel({ ...cq, bridge: decodeBridge(null) }), null, 'an intact bridge draws nothing');
  const failing = bridgeMapModel(cq);
  assert.equal(failing.note, 'COLLAPSING'); assert.equal(failing.flag, 'C');
  assert.equal(bridgeMapModel({ ...cq, bridge: decodeBridge([3, 0]) }).note, 'DOWN');
  assert.equal(bridgeMapModel({ ...cq, bridge: decodeBridge([1, 40]) }).note, null);
  const ev = (name, extra = {}) => ({ kind: 'bridge', bridge: 'iron-bridge', stage: BRIDGE_STAGES.indexOf(name), name, integrity: 0, ...extra });
  const damaged = bridgeBanner(ev('damaged', { integrity: 40 }), 1000);
  assert.equal(damaged.title, 'IRON BRIDGE DAMAGED'); assert.equal(damaged.detail, 'SUPPORTS AT 40 %'); assert.equal(damaged.tone, 'hazard');
  const fall = bridgeBanner(ev('failing', { fallAt: 4500 }), 1000);
  assert.equal(fall.title, 'IRON BRIDGE COLLAPSING'); assert.equal(fall.detail, 'GET OFF THE SPAN');
  assert(fall.holdMs >= 3500, 'the collapsing banner holds until the fall');
  assert.deepEqual(bannerCountdown(fall, 1000), { seconds: 4, fraction: 1 });
  assert.deepEqual(bannerCountdown(fall, 2750), { seconds: 2, fraction: 0.5 });
  assert.deepEqual(bannerCountdown(fall, 9000), { seconds: 0, fraction: 0 });
  const down = bridgeBanner(ev('down'), 4600);
  assert.equal(down.title, 'IRON BRIDGE DESTROYED'); assert.equal(down.detail, 'VEHICLES CROSS AT THE FORDS'); assert.equal(down.tone, 'danger');
  assert.equal(bridgeBanner({ kind: 'bridge', bridge: 'other', name: 'down' }), null);
  // From the snapshot stage (a joiner during the groan): the same banner, keyed by its fall time.
  const joined = bridgeStateBanner(cq, 1000);
  assert.equal(joined.banner.title, 'IRON BRIDGE COLLAPSING'); assert.equal(joined.key, 5000);
  assert.deepEqual(bannerCountdown(joined.banner, 1000), { seconds: 4, fraction: 1 });
  for (const row of [null, [1, 40], [3, 0]]) assert.equal(bridgeStateBanner({ ...cq, bridge: decodeBridge(row) }, 1000), null, `stage ${row?.[0] ?? 0}: no collapsing banner`);
  assert.equal(bridgeStateBanner({ meta: { crossings: [] }, bridge: cq.bridge }, 1000), null, 'other maps: none');
  // Scheduling: "destroyed" replaces "collapsing" for good (not re-queued behind it).
  let state = { current: null, queue: [], seen: new Map() };
  state = scheduleBanner(state, damaged, 1000);
  state = scheduleBanner(state, fall, 1200);
  assert.equal(state.current.key, fall.key);
  state = scheduleBanner(state, down, 4600);
  assert.equal(state.current.key, down.key);
  assert(!state.queue.some(q => q.key === fall.key || q.key === damaged.key), 'no stale bridge banner waits behind it');
  // Stingers reuse the alarm and the loss takes, for both teams.
  assert.equal(stingerForEvent(ev('failing'), 'alpha'), 'ticket_low');
  assert.equal(stingerForEvent(ev('down'), 'bravo'), 'neutralized');
  assert.equal(stingerForEvent(ev('damaged'), 'alpha'), null);
  // Painters on a recording context.
  const calls = [];
  const ctx = new Proxy({}, { get: (_t, k) => (k in _t ? _t[k] : (...args) => calls.push([k, ...args])), set: (t, k, v) => { t[k] = v; calls.push(['set', k, v]); return true; } });
  paintBridge(ctx, failing, { nowMs: 100, px: 2 });
  assert(calls.some(c => c[0] === 'strokeRect'), 'the failing span is outlined');
  calls.length = 0;
  paintBridge(ctx, bridgeMapModel({ ...cq, bridge: decodeBridge([3, 0]) }), { px: 2 });
  assert(calls.some(c => c[0] === 'fillRect' && c[2] === S.z0), 'the fallen span is painted as river');
  calls.length = 0;
  paintBridgeFlag(ctx, failing, { x: 50, y: 50 }, { size: 12 });
  assert(calls.filter(c => c[0] === 'stroke').length >= 4, 'break marks either side of the diamond');
  assert(calls.some(c => c[0] === 'fillText' && c[1] === '!'), 'and the warning badge');
  calls.length = 0;
  paintBridge(ctx, null); paintBridgeFlag(ctx, null, { x: 0, y: 0 });
  assert.equal(calls.length, 0, 'nothing to paint while intact');
  // FX: groans through the warning window, shake by distance, the fall's burst.
  const sounds = [], puffs = [];
  let trauma = 0;
  const camera = { position: { x: IRON_BRIDGE.x - 20, y: 27, z: IRON_BRIDGE.z } };
  const fx = new BridgeFx({ audio: { structureCreak: (pos, o) => sounds.push(['creak', o.material]), structureImpact: (pos, o) => sounds.push(['impact', o.material]) },
    cameraShake: { add: t => { trauma += t; } }, getCamera: () => camera, fx: { emit: (kind) => { puffs.push(kind); return 1; } } });
  assert.equal(fx.handleEvent({ kind: 'score' }), false);
  assert(fx.handleEvent(ev('damaged', { integrity: 50 })));
  assert.deepEqual(sounds.shift(), ['creak', 'metal']);
  fx.handleEvent(ev('failing', { fallAt: 0 }));
  for (let t = 0; t < IRON_BRIDGE_RULES.warnMs / 1000 + 0.5; t += 1 / 60) fx.update(1 / 60);
  const groans = sounds.filter(s => s[0] === 'creak').length;
  assert(groans >= Math.floor(IRON_BRIDGE_RULES.warnMs / 1000 / BRIDGE_FX.groanEvery), `the span groans through the window (${groans})`);
  assert.equal(fx.groan, null, 'the groan ends with the window');
  fx.handleEvent(ev('down', { blocks: 600 }));
  assert(sounds.some(s => s[0] === 'impact'), 'the fall rumbles');
  assert(puffs.includes('grit') && puffs.includes('dust') && puffs.includes('water'));
  assert(trauma > 0, 'the camera shakes nearby');
  const farTrauma = trauma;
  camera.position.x = IRON_BRIDGE.x - 400;
  fx.handleEvent(ev('down'));
  assert.equal(trauma, farTrauma, 'no shake far away');
}

console.log('conquest bridge: ok');
