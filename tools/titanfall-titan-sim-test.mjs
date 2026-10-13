// Titan server simulation (docs/titanfall.md §5.1–5.3, §1.1, §11.1 WP2 row):
// call and every refusal reason, ground lost mid-drop, drop crush and friendly
// push, leg-box crush, shield order, no regen, the 7 s doom, eject only while
// doomed (credit to the doomer), owner-only enter, destroyed during embark,
// the auto-titan (fires and credits a dead owner, smoke on a rider), rodeo
// (rip 15 % once, one enemy rider, insert refused at the cap, hatch cap, a
// rifle rider needs ≥ 15 s, an ally shoots the rider off), batteries, meter,
// wreck removal, one titan per pilot, survival across respawn, walker
// locomotion (speeds, strafe, sprint, dash pips, turn rates, step, slope,
// fluid wall, lava, light-voxel ram), the 4 m blind spot, and stepTitanWalk server/client
// parity at 20/60/120 Hz with reconcile convergence < 0.25 m.
// Node only, headless, no audio.
import assert from 'node:assert/strict';
import { GameEngine } from '../server/game.js';
import { getMapMeta, createMapState } from '../shared/world/templates.js';
import { TICK_MS } from '../server/protocol/admission.js';
import { AIR, STONE, MC_WATER, MC_LAVA, PLANK, YELLOW_SIDING } from '../shared/world/blocks.js';
import { TITAN_PHASE, decodeTitanRow } from '../shared/titan-contract.js';
import { TITAN_RULES, stepTitanWalk, titanFrame, createTitanMove, placeWalker, walkerSlope, rodeoContact, rodeoContactMounts, rodeoArcMounts } from '../shared/vehicle-handling/titan.js';
import { TITAN_ARMOR } from '../shared/vehicle-armor.js';
import { vehicleMaxHp, vehicleDef, mountPose } from '../shared/vehicle-defs.js';
import { WEAPONS, damageAtDistance } from '../shared/combatmath.js';
import { infantryDamageClass } from '../shared/vehicle-armor.js';
import { aimAngles } from '../server/sim/player.js';
import { fireMountedRay } from '../server/sim/combat.js';
import { TITAN_WRECK_SECONDS } from '../server/sim/titans.js';
import { backAnchor, riderPose, releaseRider } from '../server/sim/titanfall/rodeo.js';
import { usePilotTactical, resetPilotTactical } from '../server/sim/titanfall/pilot-tacticals.js';
import { PLAY_AREA_RULES } from '../server/sim/titanfall/play-area.js';
import { titanCockpitEye } from '../server/sim/titanfall/titan-mounts.js';
import { TitanPredictor, createWalkerWorld, PREDICT_PLAY_AREAS, PREDICT_RULES } from '../public/js/titanfall/titan-predict.js';
import * as titanPredict from '../public/js/titanfall/titan-predict.js';
import { setBlock as setClientBlock, SX as CLIENT_SX, SY as CLIENT_SY, SZ as CLIENT_SZ } from '../shared/worlddata.js';

let checks = 0;
const ok = (condition, message) => { assert.ok(condition, message); checks++; };
const eq = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++; };
const near = (actual, expected, tolerance, message) => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} vs ${expected} ±${tolerance}`); checks++;
};
const notes = [];

function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
Math.random = seeded(0x7172);

const TICKS_PER_S = 1000 / TICK_MS;
const ticks = seconds => Math.round(seconds * TICKS_PER_S);
const DROP_TICKS = Math.ceil((TITAN_RULES.drop.markerMs + TITAN_RULES.drop.fallMs) / TICK_MS) + 2;

/* ---------------------------------------------------------------- arena */
// Harbor (192 × 40 × 144): team spawns sit at z ≈ 11–19 (bravo) and 124–132
// (alpha). The arena is flattened stone at G with open sky, ≥ 30 m from both.
const G = 10;
const ARENA = { minX: 30, maxX: 160, minZ: 52, maxZ: 92 };
const SPAWN_PATCH = { minX: 30, maxX: 52, minZ: 22, maxZ: 34 }; // beside the bravo spawn (40, 19)

function flatten(engine, rect, level = G) {
  const world = engine.world, sy = world.dimensions.sy;
  for (let x = rect.minX; x < rect.maxX; x++) for (let z = rect.minZ; z < rect.maxZ; z++) {
    for (let y = 0; y < sy; y++) world.setBlock(x, y, z, y < level ? STONE : AIR);
  }
  engine.blockRevision++;
}
function setBlocks(engine, x0, x1, y0, y1, z0, z1, value) {
  for (let x = x0; x < x1; x++) for (let y = y0; y < y1; y++) for (let z = z0; z < z1; z++) engine.world.setBlock(x, y, z, value);
  engine.blockRevision++;
}

/** A titanfall engine on harbor with exactly `roster` ([[id, team]]) and the flattened arena. */
function arena(roster = [['a1', 'alpha'], ['a2', 'alpha'], ['b1', 'bravo'], ['b2', 'bravo']]) {
  const f = { events: [], last: null };
  f.engine = new GameEngine({ mode: 'titanfall', mapMeta: getMapMeta('harbor'), world: createMapState('harbor'),
    broadcast: s => { f.last = s; for (const e of s.events ?? []) f.events.push(e); } });
  f.policy = f.engine.mode.policy;
  if (f.policy.grunts) f.policy.grunts.enabled = false;   // scripted titan checks: no attrition minions (§10, WP8)
  f.titans = f.engine.vehicles.titans;
  f.vehicles = f.engine.vehicles;
  for (const [id, team] of roster) { f.engine.addClient(id, id.toUpperCase()); f.policy.setLobbyTeam(id, team); f.policy.deployNow(id); }
  flatten(f.engine, ARENA);
  f.step = (n = 1) => { for (let i = 0; i < n; i++) f.engine.step(TICK_MS); };
  f.step(2);
  f.p = id => f.engine.entities.get(id);
  f.kinds = kind => f.events.filter(e => e.kind === kind);
  f.row = id => f.last?.vehicles?.find(r => r.id === id) ?? null;
  return f;
}
/** Stand a pilot at (x, z) on the arena floor, looking along yaw, unprotected. */
function place(p, x, z, yaw = 0, pitch = 0, y = G) {
  Object.assign(p, { x, y, z, vx: 0, vy: 0, vz: 0, grounded: true, yaw, pitch, spawnProtectedUntil: 0, spawnProtected: false });
  p.input = { ...(p.input || {}), keys: {}, yaw, pitch };
  p.hist = [];
}
/** Remove a pilot from play: dead with no respawn. */
function park(f, p) {
  if (p.state === 'alive') f.engine.killPlayer(p, null, 'world', false);
  p.respawnAt = Infinity;
}
/** Aim `p` (standing at its place) at a world point. */
function aimAt(p, point) {
  const a = aimAngles([p.x, p.y + 1.62, p.z], point);
  p.input = { ...(p.input || {}), keys: {}, yaw: a.yaw, pitch: a.pitch };
  p.yaw = a.yaw; p.pitch = a.pitch;
}
/** Call `p`'s titan onto (x, z) from 18 m south (+z) of it; returns the TitanSystem result. */
function callAt(f, p, x, z, { from = 18, meter = 1 } = {}) {
  assert.ok(z + from <= ARENA.maxZ - 1 || z < ARENA.minZ, 'the caller stands on the arena floor');
  place(p, x, z + from, 0);
  aimAt(p, [x, G + 0.01, z]);
  f.policy.setTitanMeter(p, meter);
  return f.titans.call(p, null);
}
function landAt(f, p, x, z) {
  const result = callAt(f, p, x, z);
  assert.ok(result.ok, `call for ${p.id} at ${x},${z}: ${result.reason}`);
  f.step(DROP_TICKS + 62);
  const v = f.vehicles.vehicles.get(result.vehicleId);
  assert.ok(v && !v.dropping && v.hp > 0, 'titan landed');
  return v;
}
function embark(f, p, v) {
  place(p, v.x, v.z + titanFrame(v).hl + 1.2, v.yaw);
  const entered = f.vehicles.action(p, { type: 'enter', vehicleId: v.id });
  f.step(ticks(TITAN_RULES.embark.animMs / 1000) + 2);
  return entered;
}
/** Piloted controls for the next ticks. */
function drive(p, { throttle = 0, steer = 0, yaw, pitch = 0, hold = 0, fire = false } = {}) {
  p.input = { ...(p.input || {}), keys: {}, vehicleThrottle: throttle, vehicleSteer: steer, yaw, pitch, titanHold: hold, wantFire: fire };
}
const lastKill = (f, victim) => f.kinds('kill').filter(e => e.victim === victim).at(-1) ?? null;
const total = v => v.hp + v.shield;

/* ================================================================ call and refusals */
{
  const f = arena();
  const [a1, a2, b1, b2] = ['a1', 'a2', 'b1', 'b2'].map(f.p);
  park(f, b2);
  // range: aimed at the sky.
  place(a1, 60, 70, 0, 0.6);
  f.policy.setTitanMeter(a1, 1);
  eq(f.titans.call(a1, null).reason, 'range', 'refused: nothing hit within 160 m');
  // meter
  eq(callAt(f, a1, 60, 70, { meter: 0.5 }).reason, 'meter', 'refused: meter not full');
  // fluid: water over the target column.
  setBlocks(f.engine, 58, 63, G - 1, G, 68, 73, MC_WATER);
  eq(callAt(f, a1, 60.5, 70.5).reason, 'fluid', 'refused: water (the ray stops at the surface)');
  setBlocks(f.engine, 58, 63, G - 1, G, 68, 73, STONE);
  // fluid under one footprint corner only.
  setBlocks(f.engine, 61, 63, G - 1, G, 71, 73, MC_WATER);
  eq(callAt(f, a1, 60.5, 70.5).reason, 'fluid', 'refused: water under a footprint corner');
  setBlocks(f.engine, 61, 63, G - 1, G, 71, 73, STONE);
  // uneven: a two-voxel block under one corner.
  setBlocks(f.engine, 61, 62, G, G + 2, 71, 72, STONE);
  eq(callAt(f, a1, 60.5, 70.5).reason, 'uneven', 'refused: footprint heights differ by more than maxStep');
  setBlocks(f.engine, 61, 62, G, G + 2, 71, 72, AIR);
  // sky: a roof 6 m over the target (the shallow aim ray passes under it).
  setBlocks(f.engine, 57, 65, G + 6, G + 7, 67, 75, STONE);
  eq(callAt(f, a1, 60.5, 70.5).reason, 'sky', 'refused: fewer than 12 clear voxels over the footprint');
  setBlocks(f.engine, 57, 65, G + 6, G + 7, 67, 75, AIR);
  // spawn: within 30 m of an enemy (bravo) spawn point.
  flatten(f.engine, SPAWN_PATCH);
  eq(callAt(f, a1, 40.5, 26.5, { from: 6 }).reason, 'spawn', 'refused: within 30 m of an enemy spawn');
  // accepted
  const call = callAt(f, a1, 60.5, 70.5);
  ok(call.ok, `accepted on open level ground (${call.reason})`);
  eq(f.policy.titanMeter(a1), 0, 'a call spends the meter');
  const v = f.vehicles.vehicles.get(call.vehicleId);
  ok(v.dropping && v.landsAt === f.engine.now + TITAN_RULES.drop.markerMs + TITAN_RULES.drop.fallMs, 'dropping until marker + fall');
  // owned / bay / blocked
  eq(callAt(f, a1, 90.5, 70.5).reason, 'owned', 'refused: one titan per pilot');
  eq(callAt(f, a2, 90.5, 70.5).reason, 'bay', 'refused: alpha bay full (cap ceil(2/2))');
  eq(callAt(f, b1, 61.5, 71.5).reason, 'blocked', 'refused: footprint overlaps a pending drop');
  f.step(DROP_TICKS);
  ok(!v.dropping && v.hp > 0, 'landed');
  eq(callAt(f, b1, 61.5, 71.5).reason, 'blocked', 'refused: footprint overlaps a landed hull');
  f.step(1);
  const refused = new Set(f.kinds('titanfall_refused').map(e => e.reason));
  for (const reason of ['range', 'meter', 'fluid', 'uneven', 'sky', 'spawn', 'owned', 'bay', 'blocked']) ok(refused.has(reason), `titanfall_refused ${reason}`);
  eq(f.policy.titanMeter(b1), 1, 'a refusal leaves the meter full');
  ok(f.kinds('titanfall_drop').some(e => e.vehicleId === v.id && e.owner === 'a1'), 'titanfall_drop event');
  // Landing: drop shield and crouch phase.
  near(v.shield, TITAN_RULES.dropShieldFrac * vehicleMaxHp(v), 1e-6, 'drop shield 25 %');
  f.engine.stop();
}

/* ================================================================ ground lost mid-drop; drop crush and push */
{
  const f = arena();
  const [a1, a2, b1, b2] = ['a1', 'a2', 'b1', 'b2'].map(f.p);
  const call = callAt(f, a1, 80.5, 70.5);
  ok(call.ok, 'drop called');
  const v = f.vehicles.vehicles.get(call.vehicleId);
  // Crush: an enemy in the footprint dies (key titanfall); an ally is pushed clear.
  place(b1, 80.5, 70.5);
  place(a2, 80.5 + 1.0, 70.5 + 0.6);
  place(b2, 80.5, 70.5 + 9); // outside: unharmed
  place(a1, 80.5, 50 + 40);
  f.step(DROP_TICKS - 2);
  eq(b1.state, 'dead', 'enemy in the footprint crushed');
  eq(lastKill(f, 'b1')?.w, TITAN_RULES.drop.crushKey, 'crush kill key titanfall');
  eq(lastKill(f, 'b1')?.killer, 'a1', 'crush credited to the owner');
  eq(a2.state, 'alive', 'ally survives the landing');
  ok(Math.hypot(a2.x - v.x, a2.z - v.z) > Math.hypot(titanFrame(v).hw, titanFrame(v).hl), 'ally pushed out of the footprint');
  eq(b2.state, 'alive', 'enemy outside the footprint unharmed');
  eq(decodeTitanRow(f.row(v.id))?.phase, TITAN_PHASE.landed, 'landed crouch phase');
  f.engine.stop();
}
{
  const f = arena();
  const a1 = f.p('a1');
  const call = callAt(f, a1, 100.5, 70.5);
  const v = f.vehicles.vehicles.get(call.vehicleId);
  // Dig a 3 m pit under the marker before impact.
  setBlocks(f.engine, 97, 105, G - 3, G, 67, 75, AIR);
  f.step(DROP_TICKS + ticks(1.5));
  ok(f.vehicles.vehicles.has(v.id) && v.hp > 0, 'ground lost: the titan is not removed');
  near(v.y, G - 3, 0.01, 'ground lost: it falls under gravity to the pit floor');
  ok(v.grounded === true, 'ground lost: grounded again');
  f.engine.stop();
}

/* ================================================================ walker locomotion (pure stepTitanWalk on the arena) */
{
  const f = arena([['a1', 'alpha']]);
  const world = f.titans.world;
  const hull = (x, z, yaw = 0, type = 'titan_ion') => ({ type, x, y: G, z, yaw, legYaw: yaw, vx: 0, vy: 0, vz: 0, grounded: true,
    dash: titanFrame(type).pips, dashT: 0, dashX: 0, dashZ: 0, tfMove: createTitanMove() });
  const run = (v, controls, seconds) => {
    const c = { fwd: 0, side: 0, aimYaw: v.yaw, aimPitch: 0, sprint: false, dash: false, piloted: true, ...controls };
    for (let i = 0, n = Math.round(seconds * 120); i < n; i++) { stepTitanWalk(v, c, 1 / 120, world); c.dash = false; }
    return v;
  };
  const atlas = titanFrame('titan_ion');
  // Speeds: walk forward (−Z at yaw 0), sprint, back, strafe relative to the aim.
  let v = run(hull(60, 85), { fwd: 1 }, 2);
  near(v.speed, atlas.walk, 1e-6, 'walk speed');
  ok(v.z < 85 - 7 && Math.abs(v.x - 60) < 1e-6, 'walks along its aim (−Z)');
  v = run(hull(70, 85), { fwd: 1, sprint: true }, 2);
  near(v.speed, atlas.sprint, 1e-6, 'sprint speed (forward only)');
  v = run(hull(80, 85), { fwd: 1, side: 1, sprint: true }, 2);
  ok(v.speed <= atlas.walk + 1e-6, 'no sprint while strafing');
  v = run(hull(90, 60), { fwd: -1 }, 2);
  near(v.speed, atlas.back, 1e-6, 'backpedal speed');
  v = run(hull(100, 70, Math.PI / 2), { side: 1, aimYaw: Math.PI / 2 }, 2);
  near(v.speed, atlas.strafe, 1e-6, 'strafe speed');
  ok(v.z < 70 - 6 && Math.abs(v.x - 100) < 1e-6, 'strafe right is relative to the aim (yaw π/2 → −Z)');
  // Turning: piloted 1:1, legs lag at most legTwistLimit; auto turns at the leg rate.
  v = run(hull(110, 70), { aimYaw: 1.2 }, 1 / 120);
  near(v.yaw, 1.2, 1e-9, 'piloted hull yaw = aim yaw at once');
  ok(Math.abs(v.yaw - v.legYaw) <= TITAN_RULES.legTwistLimit + 1e-9, 'legs lag the hull by ≤ legTwistLimit');
  run(v, { aimYaw: 1.2 }, 1);
  near(v.legYaw, 1.2, 1e-6, 'legs catch up');
  v = run(hull(120, 70), { aimYaw: 2, piloted: false }, 0.5);
  near(v.yaw, atlas.legTurn * 0.5, 1e-6, 'auto-titan turns at the leg rate');
  // Dash: one pip, dash speed for 0.28 s, pips regenerate.
  v = hull(130, 85);
  run(v, { fwd: 1, dash: true }, 1 / 120);
  near(v.dash, atlas.pips - 1, 1e-9, 'dash spends one pip');
  near(v.speed, atlas.dash.speed, 1e-6, 'dash speed');
  run(v, { fwd: 1 }, 0.3);
  ok(v.dashT === 0 && v.speed < atlas.dash.speed - 0.2, 'dash ends after 0.28 s');
  run(v, { fwd: 1 }, 0.7);
  near(v.speed, atlas.walk, 1e-6, 'then blends back to walk speed');
  run(v, { dash: true }, 1 / 120);
  ok(v.dash < 1 && v.dashT > 0, 'second dash spends the second pip');
  run(v, {}, 0.3);
  const coasting = v.speed;
  run(v, { dash: true }, 1 / 120);
  ok(v.dashT === 0 && v.speed < coasting, 'no third dash with both pips spent');
  const before = v.dash;
  run(v, {}, atlas.pipRegen);
  near(v.dash - before, 1, 1e-6, 'one pip per pipRegen seconds');
  ok(titanFrame('titan_northstar').pips === 3, 'stryder has 3 pips');
  // Step: a one-voxel ledge is climbed, a two-voxel wall is not.
  setBlocks(f.engine, 40, 50, G, G + 1, 52, 70, STONE);
  v = run(hull(45, 76), { fwd: 1 }, 2.5);
  near(v.y, G + 1, 1e-6, 'climbs a one-voxel step');
  setBlocks(f.engine, 52, 62, G, G + 2, 52, 70, STONE);
  v = run(hull(57, 76), { fwd: 1 }, 2.5);
  near(v.y, G, 1e-6, 'a two-voxel wall stops it');
  ok(v.z >= 70 + atlas.hl - 0.05, 'stopped at the wall face');
  // Slope: a one-voxel-per-metre staircase is refused, one voxel per three metres is climbed.
  for (let k = 0; k < 8; k++) setBlocks(f.engine, 64, 74, G, G + k + 1, 70 - k - 1, 70 - k, STONE);
  v = run(hull(69, 74), { fwd: 1 }, 4);
  // The 3 m gradient baseline reads the foot of the stairs as gentler: it stalls within two steps of eight.
  ok(v.y <= G + 2 + 1e-6, `45° staircase refused (stalled ${v.y - G} m above the floor)`);
  const slope = walkerSlope({ y: G + 3 }, 69, 67.5, 0, -1, world);
  ok(slope > TITAN_RULES.maxSlope, `staircase gradient ${slope} > maxSlope`);
  for (let k = 0; k < 4; k++) setBlocks(f.engine, 76, 86, G, G + k + 1, 70 - 3 * (k + 1), 70 - 3 * k, STONE);
  v = run(hull(81, 74), { fwd: 1 }, 3);
  near(v.y, G + 4, 1e-6, 'gentle stairs (1 per 3 m) climbed');
  // Fluid: two metres of water are a wall, one metre is waded.
  setBlocks(f.engine, 88, 98, G - 2, G, 60, 70, MC_WATER);
  v = run(hull(93, 76), { fwd: 1 }, 3);
  ok(v.z >= 70 + atlas.hl - 0.05, 'deep water is a wall');
  ok(placeWalker({ type: 'titan_ion', x: 93, y: G, z: 76, yaw: 0 }, 93, 65, world) === null, 'no step into deep water');
  ok(placeWalker({ type: 'titan_ion', x: 93, y: G + 3, z: 76, yaw: 0 }, 93, 65, world) === null, 'deep water under a drop deeper than the probe is a wall too');
  eq(placeWalker({ type: 'titan_ion', x: 93, y: G - 2, z: 65, yaw: 0 }, 93, 64, world), G - 2, 'a hull already in deep water wades on its bed');
  setBlocks(f.engine, 100, 110, G - 1, G, 60, 70, MC_WATER);
  v = run(hull(105, 76), { fwd: 1 }, 3);
  ok(v.z < 66, 'shallow water is waded');
  // A river 3 m below the bank (4 m of water over its bed): the bank edge is a
  // wall even though the bed is past the fall probe; a hull that ends up in it
  // anyway (bridge gone, pushed) sinks to the bed and wades out, never hangs.
  setBlocks(f.engine, 124, 142, G - 7, G, 52, 64, AIR);
  setBlocks(f.engine, 124, 142, G - 7, G - 3, 52, 64, MC_WATER);
  v = run(hull(133, 76), { fwd: 1 }, 4);
  ok(v.z >= 64 + atlas.hl - 0.05 && v.y === G, `the bank over a deep river is a wall (z ${v.z.toFixed(2)})`);
  v = { ...hull(133, 58), grounded: false };
  run(v, {}, 2);
  ok(v.grounded && Math.abs(v.y - (G - 7)) < 1e-6, `fallen in: sinks to the bed (y ${v.y.toFixed(2)})`);
  for (const [fwd, side] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const x0 = v.x, z0 = v.z;
    v.vx = 0; v.vz = 0;
    run(v, { fwd, side }, 0.5);
    ok(Math.hypot(v.x - x0, v.z - z0) > 1, `fallen in: wades ${fwd},${side}`);
  }
  run(v, { fwd: -1 }, 6);
  ok(v.z > 64 - atlas.hl - 0.05, 'wades back to the bank wall');
  // Bounds: the hull stays inside the play area (map edge).
  const edge = { ...hull(60, 85), x: 1 + atlas.hw + 0.2 };
  f.engine.world; // whole-map area on harbor
  edge.x = atlas.hw + 0.5; edge.z = 80; edge.y = f.vehicles.ground(edge.x, edge.z, 30, 10, 40) ?? G;
  run(edge, { side: -1 }, 2);
  ok(edge.x >= atlas.hw - 1e-6, 'clamped to the play area');
  // Lava under the feet burns: lavaDps × 0.6 (fire) per second.
  f.engine.stop();
}
{
  const f = arena([['a1', 'alpha'], ['b1', 'bravo']]);
  const v = landAt(f, f.p('a1'), 120.5, 60.5);
  v.shield = 0;
  setBlocks(f.engine, 118, 124, G, G + 1, 58, 64, MC_LAVA);
  const hp = v.hp;
  f.titans.lava(v, 1);
  near(hp - v.hp, TITAN_RULES.fluid.lavaDps * TITAN_ARMOR.fire, 1e-6, 'lava burns lavaDps (cls fire)');
  f.engine.stop();
}

/* ================================================================ walker voxel ram */
{
  const f = arena([['a1', 'alpha'], ['b1', 'bravo']]);
  const a1 = f.p('a1');
  park(f, f.p('b1'));
  const v = landAt(f, a1, 60.5, 72.5);
  ok(embark(f, a1, v), 'owner embarks for the ram test');
  // A plank fence (wood) and a siding wall (thin) across the path are walked through; stone stops it.
  setBlocks(f.engine, 54, 68, G, G + 3, 66, 67, PLANK);
  setBlocks(f.engine, 54, 68, G, G + 6, 61, 62, YELLOW_SIDING);
  setBlocks(f.engine, 54, 68, G, G + 8, 53, 55, STONE);
  const hp = total(v);
  for (let i = 0; i < ticks(6); i++) { drive(a1, { throttle: 1, yaw: 0 }); f.step(); }
  let plank = 0, siding = 0, stone = 0;
  for (let x = 54; x < 68; x++) for (let y = G; y < G + 8; y++) {
    if (y < G + 3 && f.engine.world.getBlock(x, y, 66) === PLANK) plank++;
    if (y < G + 6 && f.engine.world.getBlock(x, y, 61) === YELLOW_SIDING) siding++;
    if (f.engine.world.getBlock(x, y, 54) === STONE) stone++;
  }
  // The 2.7 m Atlas footprint spans three voxel columns: it cuts a 3-wide hole, full height.
  ok(plank <= 14 * 3 - 3 * 3 && plank >= 14 * 3 - 5 * 3, `walker breaks a footprint-wide hole through a plank fence (${plank} of 42 left)`);
  ok(siding <= 14 * 6 - 3 * 6 && siding >= 14 * 6 - 5 * 6, `walker breaks a footprint-wide hole through thin siding (${siding} of 84 left)`);
  eq(stone, 14 * 8, 'stone is never rammed');
  ok(v.z < 61 && v.z >= 55 + titanFrame(v).hl - 0.05, `walked through to the stone wall (z ${v.z.toFixed(2)})`);
  eq(total(v), hp, 'light voxels do not harm the walker');
  // A landing breaks light voxels built into the drop volume.
  const b1 = f.p('b1');
  b1.respawnAt = 0; f.step(ticks(1)); place(b1, 120.5, 66.5);
  const call = callAt(f, b1, 120.5, 59.5);
  ok(call.ok, `bravo call: ${call.reason}`);
  f.step(2);
  setBlocks(f.engine, 118, 124, G, G + 2, 56, 62, PLANK); // built during the marker
  f.step(DROP_TICKS + 60);
  let left = 0;
  for (let x = 118; x < 124; x++) for (let y = G; y < G + 2; y++) for (let z = 56; z < 62; z++) left += f.engine.world.getBlock(x, y, z) === PLANK ? 1 : 0;
  const bv = f.vehicles.vehicles.get(call.vehicleId);
  ok(bv && !bv.dropping && bv.hp > 0, 'titan landed on the plank pile');
  ok(left < 72 && bv.y < G + 2, `landing breaks light voxels in the drop volume (${left} of 72 left, y ${bv.y})`);
  f.engine.stop();
}

/* ================================================================ leg-box crush */
{
  const f = arena();
  const [a1, a2, b1, b2] = ['a1', 'a2', 'b1', 'b2'].map(f.p);
  park(f, b2);
  const v = landAt(f, a1, 70.5, 72.5);
  ok(embark(f, a1, v), 'owner embarks');
  const legX = 0.8; // in front of the right leg (hull-local +X)
  place(b1, v.x + legX, v.z - 5);
  place(a2, v.x - legX, v.z - 12);
  // Slow contact: a parked hull never crushes.
  place(b1, v.x + legX, v.z - titanFrame(v).hl - 0.3);
  drive(a1, { yaw: 0 });
  f.step(30);
  eq(b1.state, 'alive', 'no crush at rest');
  place(b1, v.x + legX, v.z - 5);
  drive(a1, { throttle: 1, yaw: 0 });
  f.step(ticks(2.5));
  eq(b1.state, 'dead', 'an enemy in front of a leg is crushed');
  eq(lastKill(f, 'b1')?.w, TITAN_RULES.crush.key, 'crush key titan_crush');
  eq(lastKill(f, 'b1')?.killer, 'a1', 'crush credited to the pilot');
  eq(a2.state, 'alive', 'an ally in the path is pushed, not crushed');
  f.engine.stop();
}
{
  // The rodeo approach: an enemy sprinting into the back of a titan walking away is pushed, not crushed.
  const f = arena();
  const [a1, a2, b1, b2] = ['a1', 'a2', 'b1', 'b2'].map(f.p);
  park(f, b2); place(a2, 150, 90);
  const v = landAt(f, a1, 70.5, 72.5);
  ok(embark(f, a1, v), 'owner embarks');
  drive(a1, { throttle: 1, yaw: 0 });
  f.step(ticks(0.5));
  const z0 = v.z;
  place(b1, v.x + 0.8, v.z + titanFrame(v).hl + 1.5);
  for (let i = 0; i < ticks(2); i++) {
    b1.input = { ...b1.input, yaw: 0, pitch: 0, keys: { f: true, b: false, l: false, r: false, jump: false, sprint: true, crouch: false } };
    f.step(1);
  }
  ok(z0 - v.z > 5, `the titan walked away (${(z0 - v.z).toFixed(1)} m)`);
  ok(v.z + titanFrame(v).hl + 1 > b1.z, 'the pilot caught up with the rear face');
  eq(b1.state, 'alive', 'an enemy running into the back of a walking titan is not crushed');
  f.engine.stop();
}

/* ================================================================ damage: shield order, no regen, doom, eject */
{
  const f = arena();
  const [a1, a2, b1, b2] = ['a1', 'a2', 'b1', 'b2'].map(f.p);
  park(f, b2);
  const v = landAt(f, a1, 70.5, 70.5);
  const max = vehicleMaxHp(v), shield = v.shield;
  place(b1, 150, 90); place(a2, 40, 60);
  park(f, b1);
  b1.state = 'alive';
  f.vehicles.damage(v.id, shield - 100, b1, { cls: 'at' });
  near(v.shield, 100, 1e-6, 'shield absorbs first');
  eq(v.hp, max, 'hp untouched while shielded');
  f.vehicles.damage(v.id, 300, b1, { cls: 'at' });
  eq(v.shield, 0, 'shield emptied');
  near(v.hp, max - 200, 1e-6, 'the rest reaches hp');
  near(f.titans.shieldOf(v), 0, 0, 'shieldOf');
  // Small arms barely scratch a titan; the rear takes more.
  const hp0 = v.hp;
  f.vehicles.damage(v.id, 100, b1, { cls: 'small', point: [v.x, v.y + 3, v.z - 3] });
  near(hp0 - v.hp, 100 * TITAN_ARMOR.small, 1e-6, 'small arms × 0.06');
  const hp1 = v.hp;
  f.vehicles.damage(v.id, 100, b1, { cls: 'at', point: [v.x, v.y + 3, v.z + 3] });
  near(hp1 - v.hp, 100 * 1.3, 1e-6, 'rear zone × 1.3');
  // No regen and no burn (vehicle-damage step returns early for titans).
  const hpBefore = v.hp;
  f.step(ticks(12));
  eq(v.hp, hpBefore, 'no hp regen');
  eq(v.shield, 0, 'no shield regen');
  ok(!v.burning && !v.disabled, 'no burn or disable state');
  // Eject refused while not doomed.
  ok(embark(f, a1, v), 'owner embarks');
  eq(f.titans.eject(v, a1), false, 'eject refused while not doomed');
  eq(f.policy.titanfallIntent(a1, { type: 'eject', value: 1 }), false, 'eject intent refused while not doomed');
  // Doom: hp at 0 → doom pool 20 %, credit to the doomer.
  f.vehicles.damage(v.id, 1e6, b1, { cls: 'at' });
  ok(v.doomed && f.titans.isDoomed(v), 'doomed at 0 hp');
  near(v.hp, TITAN_RULES.doomPoolFrac * max, 1e-6, 'doom pool 20 %');
  // Doom guard (playtest): with a seated pilot, focused fire cannot finish the hull inside the 2 s window.
  f.vehicles.damage(v.id, 1e6, b1, { cls: 'at' });
  ok(v.doomed && v.hp > 0, 'doom guard: focused fire at doom start leaves the pilot time to eject');
  eq(f.titans.doomedBy(v), b1, 'doomedBy');
  f.step(1);
  eq(decodeTitanRow(f.row(v.id)).doomed, true, 'row doomed');
  ok(f.kinds('titan_doomed').some(e => e.vehicleId === v.id && e.by === 'b1'), 'titan_doomed event');
  f.step(ticks(1));
  // Eject during doom: the pilot flies clear, the titan dies, 10 to the doomer's team.
  const score = f.policy.scores.bravo;
  ok(f.policy.titanfallIntent(a1, { type: 'eject', value: 1 }), 'eject accepted while doomed');
  ok(!a1.vehicleId && a1.state === 'alive' && a1.vy > 20, 'ejected upward');
  ok(a1.ejectCloakUntil > f.engine.now, 'eject cloak');
  ok(!(v.hp > 0), 'titan destroyed on eject');
  f.step(2);
  eq(f.policy.scores.bravo - score, 10, 'eject during doom: 10 to the doomer');
  eq(f.kinds('vehicle_destroyed').find(e => e.vehicleId === v.id)?.attacker, 'b1', 'destruction credited to the doomer');
  f.engine.stop();
}
/* Final fixer: the ejecting pilot is outside its own hull's destruction blast (open sky and a roof right
   over the hull, where the blast hit hardest), so a pilot on 9 hp survives its own eject. */
for (const gap of [null, 0]) {
  const f = arena();
  const [a1, a2, b1, b2] = ['a1', 'a2', 'b1', 'b2'].map(f.p);
  park(f, b2); park(f, a2);
  place(b1, 150, 90);
  const v = landAt(f, a1, 70.5, 70.5);
  embark(f, a1, v);
  if (gap != null) {
    const roof = G + Math.ceil(titanFrame(v).height) + gap;
    for (let x = 62; x < 80; x++) for (let y = roof; y < roof + 2; y++) for (let z = 62; z < 80; z++) f.engine.world.setBlock(x, y, z, STONE);
    f.engine.blockRevision++;
  }
  f.vehicles.damage(v.id, 1e6, b1, { cls: 'at' });
  f.step(ticks(0.3));
  a1.hp = 9;
  const hitsBefore = f.kinds('hit').filter(e => e.victim === 'a1').length;
  ok(f.policy.titanfallIntent(a1, { type: 'eject', value: 1 }), `eject (roof gap ${gap})`);
  f.step(ticks(1));
  eq(f.kinds('hit').filter(e => e.victim === 'a1').length - hitsBefore, 0, `own hull blast spares the ejecting pilot (roof gap ${gap})`);
  ok(a1.state === 'alive' && a1.hp === 9, `9 hp pilot survives its own eject (roof gap ${gap})`);
  f.engine.stop();
}
/* Final fixer: a rider jumping off a reversing titan keeps the hull's motion and lands clear of its legs. */
for (const loadout of [0, 2 << 12]) {
  const f = arena();
  const [a1, a2, b1, b2] = ['a1', 'a2', 'b1', 'b2'].map(f.p);
  park(f, b2); park(f, a2);
  f.policy._tf(f.policy._state(a1)).loadout = loadout;
  const v = landAt(f, a1, 95.5, 72.5);
  embark(f, a1, v);
  place(b1, v.x, v.z + titanFrame(v).hl + 0.6, 0); b1.y = G + 2.6; b1.grounded = false;
  ok(f.titans.rodeo(b1, 'mount'), `${v.type}: rider mounted`);
  f.step(ticks(0.3));
  drive(a1, { throttle: -1, yaw: v.yaw });
  f.step(ticks(0.6));
  ok(v.speed > 3, `${v.type}: reversing (${v.speed.toFixed(1)} m/s)`);
  b1.input = { ...(b1.input || {}), keys: { jump: true }, jumpSeq: ((b1.input?.jumpSeq ?? 0) + 1) & 255, yaw: 0, pitch: 0 };
  f.step(1);
  ok(!b1.rodeoVehicleId, `${v.type}: jumped off`);
  b1.input = { ...b1.input, keys: {} };
  let landed = null;
  for (let i = 0; i < ticks(2) && landed == null; i++) { f.step(); if (b1.grounded) landed = f.engine.now; }
  f.step(ticks(0.3));
  ok(landed != null && b1.state === 'alive', `${v.type}: the rider lands alive behind a reversing hull (${b1.state})`);
  f.engine.stop();
}
{
  // Doom drains over 7 s.
  const f = arena();
  const [a1, b1] = ['a1', 'b1'].map(f.p);
  for (const id of ['a2', 'b2']) park(f, f.p(id));
  const v = landAt(f, a1, 70.5, 70.5);
  place(b1, 150, 60);
  f.vehicles.damage(v.id, 1e6, b1, { cls: 'at' });
  park(f, b1);
  ok(v.doomed, 'doomed');
  let n = 0;
  while (v.hp > 0 && n < ticks(10)) { f.step(1); n++; }
  near(n / TICKS_PER_S, TITAN_RULES.doomSeconds, 0.1, 'doom pool drains in 7 s');
  f.step(2);
  eq(f.policy.scores.bravo, 10, 'doom expiry: 10 to the doomer');
  f.engine.stop();
}

/* ================================================================ crew: owner-only enter, destroyed during embark */
{
  const f = arena();
  const [a1, a2, b1, b2] = ['a1', 'a2', 'b1', 'b2'].map(f.p);
  park(f, b2);
  const v = landAt(f, a1, 70.5, 70.5);
  place(a2, v.x, v.z + 2.4);
  eq(f.vehicles.action(a2, { type: 'enter', vehicleId: v.id }), false, 'a teammate cannot enter');
  place(b1, v.x, v.z + 2.4);
  eq(f.vehicles.action(b1, { type: 'enter', vehicleId: v.id }), false, 'an enemy cannot enter');
  place(b1, 150, 90);
  place(a1, v.x, v.z + 2.4);
  ok(f.vehicles.action(a1, { type: 'enter', vehicleId: v.id }), 'the owner enters');
  ok(a1.embarkUntil > f.engine.now && !f.policy.canMove(a1), 'embark lock');
  eq(decodeTitanRow((f.step(1), f.row(v.id))).phase, TITAN_PHASE.embark, 'embark phase');
  // Destroyed during embark: released alive at the exit spot, no crew death.
  f.vehicles.damage(v.id, 1e6, b1, { cls: 'at' });
  f.vehicles.damage(v.id, 1e6, b1, { cls: 'at' });
  ok(!(v.hp > 0), 'destroyed during embark');
  ok(a1.state === 'alive' && !a1.vehicleId && a1.embarkUntil === 0, 'pilot released unharmed');
  f.step(1);
  ok(!f.kinds('kill').some(e => e.victim === 'a1'), 'no crew death');
  // Disembark: tap exit puts the pilot in front of the hatch.
  f.engine.stop();
}
{
  const f = arena();
  const a1 = f.p('a1');
  for (const id of ['a2', 'b1', 'b2']) park(f, f.p(id));
  const v = landAt(f, a1, 70.5, 70.5);
  ok(embark(f, a1, v), 'embarked');
  ok(f.vehicles.action(a1, { type: 'exit' }), 'disembark');
  const local = (a1.z - v.z) * Math.cos(v.yaw) + (a1.x - v.x) * Math.sin(v.yaw);
  ok(!a1.vehicleId && local < -titanFrame(v).hl, 'out in front of the hatch');
  f.step(1);
  eq(decodeTitanRow(f.row(v.id)).phase, TITAN_PHASE.disembark, 'disembark phase');
  f.step(ticks(1));
  eq(decodeTitanRow(f.row(v.id)).phase, TITAN_PHASE.auto, 'empty titan is an auto-titan');
  f.engine.stop();
}

/* ================================================================ 4 m blind spot: the primary hits a pilot in front */
{
  const f = arena();
  const [a1, b1] = ['a1', 'b1'].map(f.p);
  for (const id of ['a2', 'b2']) park(f, f.p(id));
  const v = landAt(f, a1, 70.5, 70.5);
  ok(embark(f, a1, v), 'embarked');
  const def = vehicleDef(v), seat = def.seats[0], mountId = seat.mounts[0];
  const pivot = mountPose(v, seat.id, mountId).pivot;
  place(b1, pivot[0], v.z - titanFrame(v).hl - 4, 0);
  // The crosshair (cockpit eye) on the pilot's chest: the mount converges on it from the right arm.
  const chest = [b1.x, b1.y + 1.1, b1.z];
  const aim = aimAngles(titanCockpitEye(v), chest);
  ok(aim.pitch > TITAN_RULES.pitch[0], `crosshair pitch ${aim.pitch.toFixed(2)} inside the driver limit`);
  for (let i = 0; i < 30; i++) { const a = aimAngles(titanCockpitEye(v), chest); drive(a1, { yaw: a.yaw, pitch: a.pitch }); f.step(1); }
  const state = f.vehicles.mounts.state(v, mountId);
  const choice = f.vehicles.mounts.selected(v, seat.id);
  const hpBefore = b1.hp;
  ok(f.vehicles.mounts.fire(v, seat, a1, choice.mount, choice.weapon), 'primary fires');
  ok(b1.hp < hpBefore || b1.state === 'dead', `hits a pilot 4 m in front (mount pitch ${state.pitch.toFixed(2)})`);
  f.engine.stop();
}

{
  // Eject under a low roof: the launch starts clear of voxels and its apex stays under the roof.
  for (const gap of [0, 1, 3]) {
    const f = arena();
    const [a1, b1] = ['a1', 'b1'].map(f.p);
    for (const id of ['a2', 'b2']) park(f, f.p(id));
    place(b1, 150, 90);
    const v = landAt(f, a1, 70.5, 70.5);
    ok(embark(f, a1, v), `owner embarks (roof +${7 + gap})`);
    const roof = G + Math.ceil(titanFrame(v).height) + gap;
    setBlocks(f.engine, 62, 80, roof, roof + 2, 62, 80, STONE);
    f.vehicles.damage(v.id, 1e6, b1, { cls: 'at' });
    ok(f.policy.titanfallIntent(a1, { type: 'eject', value: 1 }), `eject accepted under a roof at +${roof - G}`);
    let inside = false, top = -Infinity;
    for (let i = 0; i < ticks(2); i++) { f.step(1); inside ||= !f.vehicles.bodyClear(a1.x, a1.y, a1.z); top = Math.max(top, a1.y); }
    ok(!inside && top + 1.8 <= roof + 1e-6, `roof +${roof - G}: never inside a voxel, apex under the roof (head ${(top + 1.8).toFixed(2)})`);
    ok(a1.state === 'alive' && a1.grounded, `roof +${roof - G}: landed`);
    const x0 = a1.x, z0 = a1.z;
    a1.input = { ...(a1.input || {}), keys: { r: true }, yaw: 0, pitch: 0 };
    f.step(ticks(1));
    ok(Math.hypot(a1.x - x0, a1.z - z0) > 1, `roof +${roof - G}: the pilot walks away`);
    f.engine.stop();
  }
}

/* ================================================================ auto-titan */
{
  const f = arena();
  const [a1, a2, b1, b2] = ['a1', 'a2', 'b1', 'b2'].map(f.p);
  park(f, b2); park(f, a2);
  const v = landAt(f, a1, 70.5, 70.5);
  place(a1, 40, 90);
  park(f, a1);
  eq(a1.state, 'dead', 'owner dead');
  // An enemy 20 m away (behind the hull, so it has to turn first).
  place(b1, v.x + 4, v.z + 20, 0);
  const scoreA = f.policy.scores.alpha, standX = v.x, standZ = v.z;
  let n = 0;
  while (b1.state === 'alive' && n < ticks(12)) { f.step(1); n++; }
  eq(b1.state, 'dead', `auto-titan kills a perceivable enemy in range (${(n / TICKS_PER_S).toFixed(1)} s)`);
  ok(f.events.some(e => e.vehicleId === v.id && e.vehicleWeapon === 'splitter'), 'auto-titan fired its primary');
  const targetYaw = Math.atan2(-(b1.x - v.x), -(b1.z - v.z));
  ok(Math.abs(Math.atan2(Math.sin(v.yaw - targetYaw), Math.cos(v.yaw - targetYaw))) < 0.4, 'the hull turned toward its target');
  ok(v.x === standX && v.z === standZ, 'the auto-titan does not walk');
  const kill = lastKill(f, 'b1');
  eq(kill?.killer, 'a1', 'credited to the dead owner');
  eq(kill?.w, 'splitter', 'with the primary');
  eq(f.policy.scores.alpha - scoreA, 5, 'pilot kill points to the owner team');
  // Cloaked beyond 12 m: not perceived.
  b1.respawnAt = Infinity;
  f.engine.respawnPlayer(b1);
  place(b1, v.x, v.z - 40, 0);
  b1.ejectCloakUntil = f.engine.now + 10_000;
  const hp = b1.hp;
  f.step(ticks(2));
  eq(b1.hp, hp, 'a cloaked pilot beyond 12 m is not engaged');
  f.engine.stop();
}
{
  // A living human owner's auto-titan fires as a non-rewound shooter (its aim is at current poses).
  const f = arena();
  const [a1, b1] = ['a1', 'b1'].map(f.p);
  for (const id of ['a2', 'b2']) park(f, f.p(id));
  const v = landAt(f, a1, 70.5, 70.5);
  place(a1, 40, 90);
  a1.input = { ...(a1.input || {}), viewAge: 250 };
  place(b1, v.x + 4, v.z + 20, 0);
  const shooters = [], fire = f.vehicles.mounts.fire.bind(f.vehicles.mounts);
  f.vehicles.mounts.fire = (hull, seat, shooter, ...rest) => { if (hull === v) shooters.push(shooter); return fire(hull, seat, shooter, ...rest); };
  for (let i = 0; i < ticks(12) && b1.state === 'alive'; i++) f.step(1);
  ok(shooters.length > 0 && shooters.every(s => s.bot === true && s.id === 'a1'), 'auto fire: a bot stand-in with the owner id, never the human owner');
  eq(lastKill(f, 'b1')?.killer, 'a1', 'auto kill with a living owner credits the owner');
  f.engine.stop();
}
{
  // Auto-titan smoke on a rider; killRiders.
  const f = arena();
  const [a1, b1] = ['a1', 'b1'].map(f.p);
  for (const id of ['a2', 'b2']) park(f, f.p(id));
  const v = landAt(f, a1, 70.5, 70.5);
  park(f, a1);
  const anchor = backAnchor(v);
  place(b1, anchor[0], anchor[2], Math.PI, 0, anchor[1] - 1.2);
  ok(f.titans.rodeo(b1, 'mount'), 'rider mounts the auto-titan');
  f.step(ticks(1.2));
  eq(v.tfAuto?.smokeAskedAt ?? 0, 0, 'no smoke before 1.5 s');
  f.step(ticks(0.5));
  ok(v.tfAuto.smokeAskedAt > 0, 'auto-titan smokes a rider after 1.5 s');
  eq(b1.state, 'alive', 'the auto-titan does not shoot its own rider');
  eq(f.titans.killRiders(v, TITAN_RULES.smoke.riderDps, 0.2), 0, 'killRiders: 50 hp is not lethal');
  eq(b1.hp, 50, 'killRiders: dps × dt');
  eq(f.titans.killRiders(v, TITAN_RULES.smoke.riderDps, 0.5), 1, 'killRiders kills the rider (250/s)');
  f.step(1);
  eq(lastKill(f, 'b1')?.w, 'electricSmoke', 'smoke kill key');
  eq(lastKill(f, 'b1')?.killer, 'a1', 'smoke kill credited to the owner');
  ok(!v.riderId && !b1.rodeoVehicleId, 'rider released on death');
  f.engine.stop();
}

/* ================================================================ rodeo */
{
  const f = arena();
  const [a1, a2, b1, b2] = ['a1', 'a2', 'b1', 'b2'].map(f.p);
  const v = landAt(f, a1, 70.5, 70.5);
  ok(embark(f, a1, v), 'owner pilots (no auto fire)');
  drive(a1, { yaw: v.yaw });
  const max = vehicleMaxHp(v);
  // Mount: chest within reach of the back anchor.
  const anchor = backAnchor(v);
  place(b1, anchor[0], anchor[2] + 3, Math.PI, 0, G);
  eq(f.titans.rodeo(b1, 'mount'), false, 'out of reach');
  place(b1, anchor[0], anchor[2] + 0.4, Math.PI, 0, anchor[1] - 1.2 - 0.5);
  ok(f.titans.rodeo(b1, 'mount'), 'mount within reach');
  eq(v.riderId, 'b1', 'riderId');
  ok(f.titans.rodeo(a2, 'mount') === false, 'a friendly pilot cannot rodeo');
  // One enemy rider: a second contact is pushed off.
  place(b2, anchor[0], anchor[2] + 0.4, Math.PI, 0, anchor[1] - 1.2);
  const seq = b2.impulseSeq || 0;
  eq(f.titans.rodeo(b2, 'mount'), false, 'second enemy rider refused');
  ok((b2.impulseSeq || 0) > seq && b2.vy > 0, 'second contact pushed off');
  place(b2, 150, 90); park(f, b2);
  f.step(2);
  const pose = riderPose(v);
  near(Math.hypot(b1.x - pose.x, b1.y - pose.y, b1.z - pose.z), 0, 1e-6, 'rider posed at the back anchor');
  // The rider sits outside the rear hull box (an ally's ray reaches it first).
  const local = (b1.x - v.x) * Math.sin(v.yaw) + (b1.z - v.z) * Math.cos(v.yaw);
  ok(local - 0.32 >= titanFrame(v).hl + 0.3 - 1e-6, 'rider 0.3 m outside the rear box');
  f.step(1);
  ok(decodeTitanRow(f.row(v.id)).rider, 'row rider bit');
  // Rip: 1.4 s, 15 % of max, once.
  v.shield = 0.25 * max;
  const before = total(v), shieldBefore = v.shield;
  ok(f.titans.rodeo(b1, 'rip'), 'rip started');
  f.step(ticks(1.2));
  eq(total(v), before, 'nothing before 1.4 s');
  f.step(ticks(0.3));
  near(before - total(v), TITAN_RULES.rodeo.ripFrac * max, 1e-6, 'rip deals 15 % of max');
  eq(v.shield, shieldBefore, 'the rip skips the shield: the hull takes it (playtest)');
  ok(v.batteryOut && b1.tfBattery, 'batteryOut, the rider carries the battery');
  eq(f.titans.rodeo(b1, 'rip'), false, 'rip once');
  f.step(1);
  ok(decodeTitanRow(f.row(v.id)).batteryOut, 'row batteryOut bit');
  ok(f.kinds('rodeo_mount').length >= 1 && f.kinds('rodeo_rip').length === 1, 'rodeo events');
  // Hatch: AT rounds are not hatch shots; rifle hatch damage × armour × 4.
  const hullHp = total(v);
  eq(f.titans.riderHit(b1, v, { point: anchor, raw: 300, cls: 'at' }, 'rocket'), false, 'AT shots hit the hull normally');
  eq(total(v), hullHp, 'and riderHit dealt nothing');
  const rifle = WEAPONS.rifle, raw = damageAtDistance(rifle, 1.5), cls = infantryDamageClass(rifle);
  ok(f.titans.riderHit(b1, v, { point: anchor, raw, cls }, 'rifle'), 'a rifle hatch shot is consumed');
  near(hullHp - total(v), raw * TITAN_ARMOR[cls] * TITAN_RULES.rodeo.hatchMul, 1e-6, 'hatch: raw × armour × 4');
  eq(f.titans.riderHit(a2, v, { point: anchor, raw, cls }, 'rifle'), false, 'only the rider shoots the hatch');
  // Hatch cap: 150 dps per rider.
  const capStart = total(v);
  for (let i = 0; i < 120; i++) { f.titans.riderHit(b1, v, { point: anchor, raw: 200, cls: 'hmg' }, 'sniper'); if (i % 6 === 5) f.step(1); }
  const seconds = 20 / TICKS_PER_S;
  ok(capStart - total(v) <= TITAN_RULES.rodeo.hatchDpsCap * (seconds + 0.25) + 1e-6, `hatch damage capped (${(capStart - total(v)).toFixed(0)} in ${seconds.toFixed(2)} s)`);
  // Dismount by jump.
  b1.input = { ...b1.input, keys: { jump: true } };
  f.step(1);
  ok(!b1.rodeoVehicleId && !v.riderId && b1.vy > 0, 'a jump dismounts');
  ok(f.kinds('rodeo_off').some(e => e.id === 'b1'), 'rodeo_off');
  b1.input = { ...b1.input, keys: {} };
  f.engine.stop();
}
{
  // Insert: refused at the shield cap; +35 % shield, clears batteryOut, +1 smoke.
  const f = arena();
  const [a1, a2] = ['a1', 'a2'].map(f.p);
  for (const id of ['b1', 'b2']) park(f, f.p(id));
  const v = landAt(f, a1, 70.5, 70.5);
  ok(embark(f, a1, v), 'piloted');
  drive(a1, { yaw: v.yaw });
  const max = vehicleMaxHp(v), cap = TITAN_RULES.shieldMaxFrac * max;
  const anchor = backAnchor(v);
  place(a2, anchor[0], anchor[2] + 0.5, Math.PI, 0, anchor[1] - 1.2);
  eq(f.titans.rodeo(a2, 'insert'), false, 'no battery, no insert');
  a2.tfBattery = true;
  v.shield = cap;
  eq(f.titans.rodeo(a2, 'insert'), false, 'insert refused at the shield cap');
  v.shield = 100; v.batteryOut = true; v.tfAbility.smoke = 1;
  ok(f.titans.rodeo(a2, 'insert'), 'insert started');
  f.step(ticks(0.8));
  eq(v.shield, 100, 'nothing before 1.0 s');
  place(a2, anchor[0], anchor[2] + 0.5, Math.PI, 0, anchor[1] - 1.2);
  f.step(ticks(0.3));
  near(v.shield, cap, 1e-6, 'shield +35 % up to the cap');
  ok(!v.batteryOut && !a2.tfBattery, 'battery inserted');
  eq(v.tfAbility.smoke, 2, '+1 smoke charge');
  f.step(1);
  ok(f.kinds('rodeo_insert').some(e => e.id === 'a2'), 'rodeo_insert event');
  // From the ground (playability pass): a pilot standing right behind the hull reaches the
  // back anchor (batteryInsertGap ignores up to 4 m of drop); 3 m further out does not.
  const back = [Math.sin(v.yaw), Math.cos(v.yaw)];
  const ground = d => { const a = backAnchor(v); place(a2, a[0] + back[0] * d, a[2] + back[1] * d, v.yaw + Math.PI); };
  v.shield = 100; a2.tfBattery = true;
  ground(4);
  eq(f.titans.rodeo(a2, 'insert'), false, 'ground insert refused 4 m behind the anchor');
  ground(0.8);
  ok(backAnchor(v)[1] - (a2.y + 1.2) > 2.2, 'the ground pilot\'s chest is out of the plain rodeo reach below the anchor');
  ok(f.titans.rodeo(a2, 'insert'), 'ground insert started right behind the hull');
  f.step(ticks(1.1));
  ok(v.shield > 100 && !a2.tfBattery, `ground insert completes (shield ${Math.round(v.shield)})`);
  f.engine.stop();
}
{
  // A rifle rider needs ≥ 15 s to doom an Atlas (with its drop shield).
  const f = arena();
  const [a1, b1] = ['a1', 'b1'].map(f.p);
  for (const id of ['a2', 'b2']) park(f, f.p(id));
  const v = landAt(f, a1, 70.5, 70.5);
  ok(embark(f, a1, v), 'piloted');
  drive(a1, { yaw: v.yaw });
  const anchor = backAnchor(v);
  place(b1, anchor[0], anchor[2] + 0.4, Math.PI, 0, anchor[1] - 1.2);
  ok(f.titans.rodeo(b1, 'mount'), 'mounted');
  const rifle = WEAPONS.rifle, interval = 60 / rifle.rpm, raw = damageAtDistance(rifle, 1.5), cls = infantryDamageClass(rifle);
  let t = 0, next = 0;
  while (!v.doomed && t < 120) {
    while (next <= t) { f.titans.riderHit(b1, v, { point: anchor, raw, cls }, 'rifle'); next += interval; }
    f.step(1); t += TICK_MS / 1000;
  }
  ok(v.doomed, 'the rider dooms it eventually');
  ok(t >= 15, `rifle rider needs ${t.toFixed(1)} s ≥ 15 s`);
  notes.push(`rifle rider dooms an Atlas in ${t.toFixed(1)} s`);
  f.engine.stop();
}
{
  // An ally shoots the rider off: the rider is struck before the hull.
  const f = arena();
  const [a1, a2, b1] = ['a1', 'a2', 'b1'].map(f.p);
  park(f, f.p('b2'));
  const v = landAt(f, a1, 70.5, 70.5);
  ok(embark(f, a1, v), 'piloted');
  drive(a1, { yaw: v.yaw });
  const anchor = backAnchor(v);
  place(b1, anchor[0], anchor[2] + 0.4, Math.PI, 0, anchor[1] - 1.2);
  ok(f.titans.rodeo(b1, 'mount'), 'mounted');
  f.step(ticks(0.3));
  place(a2, v.x, v.z + 14, 0);
  a2.input.viewAge = 0;
  const eye = [a2.x, a2.y + 1.62, a2.z], chest = [b1.x, b1.y + 1.2, b1.z];
  const d = chest.map((n, i) => n - eye[i]), len = Math.hypot(...d);
  const hullBefore = total(v);
  const result = fireMountedRay(a2, eye, d.map(n => n / len), { key: 'rifle', damage: 250, infantryDamage: 250, range: 100, cls: 'small' },
    f.engine.contexts.combat);
  eq(result?.victimId, 'b1', 'the ally ray strikes the rider first');
  eq(total(v), hullBefore, 'the hull behind the rider is untouched');
  eq(b1.state, 'dead', 'rider shot off');
  ok(!v.riderId && !b1.rodeoVehicleId, 'rodeo link cleared on death');
  f.engine.stop();
}
{
  // Roof auto-mount for an enemy; a jump-held mount is not an instant dismount.
  const f = arena();
  const [a1, b1] = ['a1', 'b1'].map(f.p);
  for (const id of ['a2', 'b2']) park(f, f.p(id));
  const v = landAt(f, a1, 70.5, 70.5);
  ok(embark(f, a1, v), 'piloted');
  drive(a1, { yaw: v.yaw });
  place(b1, v.x, v.z, 0, 0, v.y + titanFrame(v).height);
  b1.input.keys = { jump: true };
  f.step(1);
  eq(b1.rodeoVehicleId, v.id, 'an enemy on the roof auto-mounts');
  f.step(3);
  eq(b1.rodeoVehicleId, v.id, 'a held jump is not a dismount edge');
  ok(f.titans.rodeo(b1, 'dismount'), 'dismount verb');
  f.engine.stop();
}

{
  // The rider is never run over by its own hull: a one-tick flick of the pilot's aim.
  for (const flick of [0.6, -1]) {
    const f = arena();
    const [a1, b1] = ['a1', 'b1'].map(f.p);
    for (const id of ['a2', 'b2']) park(f, f.p(id));
    const v = landAt(f, a1, 70.5, 70.5);
    ok(embark(f, a1, v), 'piloted (flick)');
    drive(a1, { yaw: 0 }); f.step(4);
    const anchor = backAnchor(v);
    place(b1, anchor[0], anchor[2] + 0.4, Math.PI, 0, anchor[1] - 1.7);
    ok(f.titans.rodeo(b1, 'mount'), 'rider mounts (flick)');
    f.step(2);
    drive(a1, { yaw: flick }); f.step(1);
    near(v.yaw, flick, 1e-9, `the hull turned ${flick} rad in one tick`);
    ok(b1.state === 'alive' && b1.hp === 100 && b1.rodeoVehicleId === v.id, `the rider survives a ${flick} rad flick, still mounted`);
    f.engine.stop();
  }
  // Nor is a pilot standing at the hull's side: the run-over impact sees the leg turn rate.
  const f = arena();
  const [a1, b1] = ['a1', 'b1'].map(f.p);
  for (const id of ['a2', 'b2']) park(f, f.p(id));
  const v = landAt(f, a1, 70.5, 70.5);
  ok(embark(f, a1, v), 'piloted (side flick)');
  drive(a1, { yaw: 0 }); f.step(4);
  place(b1, v.x + titanFrame(v).hw + 0.35, v.z - titanFrame(v).hl + 0.2, 0);
  f.step(1);
  drive(a1, { yaw: 0.9 }); f.step(1);
  ok(b1.state === 'alive' && b1.hp === 100, `a pilot beside the hull survives a 0.9 rad flick (hp ${b1.hp})`);
  f.engine.stop();
}
{
  // Back to a wall: the rider is pulled in out of the voxels and leaves from a clear spot.
  const f = arena();
  const [a1, b1] = ['a1', 'b1'].map(f.p);
  for (const id of ['a2', 'b2']) park(f, f.p(id));
  const v = landAt(f, a1, 70.5, 70.5);
  ok(embark(f, a1, v), 'piloted (wall)');
  drive(a1, { yaw: 0 }); f.step(4);
  const wall = Math.ceil(v.z + titanFrame(v).hl + 0.2);
  setBlocks(f.engine, 60, 82, G, G + 9, wall, wall + 2, STONE);
  ok(!f.vehicles.bodyClear(riderPose(v).x, riderPose(v).y, riderPose(v).z), 'the nominal rider spot is inside the wall');
  place(b1, v.x, v.z, 0, 0, v.y + titanFrame(v).height + 0.05);
  f.step(3);
  eq(b1.rodeoVehicleId, v.id, 'roof auto-mount');
  ok(f.vehicles.bodyClear(b1.x, b1.y, b1.z), 'the rider is posed clear of the wall');
  ok(f.titans.rodeo(b1, 'dismount'), 'dismount');
  f.step(ticks(1));
  ok(f.vehicles.bodyClear(b1.x, b1.y, b1.z) && b1.grounded, 'dismounted onto clear ground');
  const x0 = b1.x, z0 = b1.z;
  b1.input = { ...(b1.input || {}), keys: { f: true }, yaw: Math.atan2(b1.x - v.x, b1.z - v.z) + Math.PI, pitch: 0 };
  f.step(ticks(1));
  ok(Math.hypot(b1.x - x0, b1.z - z0) > 1, 'the dismounted rider walks away');
  f.engine.stop();
}
{
  // Rear over the area edge (harbor: the map edge): the rider is posed inside the area, no OOB timer.
  const f = arena();
  const [a1, b1] = ['a1', 'b1'].map(f.p);
  for (const id of ['a2', 'b2']) park(f, f.p(id));
  flatten(f.engine, { minX: 0, maxX: 12, minZ: 60, maxZ: 72 });
  const atlas = titanFrame('titan_ion');
  const v = f.titans.spawnDrop(a1, atlas.hl + 0.05, G, 66, 'titan_ion', -Math.PI / 2); // nose +X, rear toward x = 0
  f.step(DROP_TICKS + 62);
  ok(f.vehicles.vehicles.has(v.id) && !v.dropping && v.hp > 0, 'titan stands at the map edge');
  ok(riderPose(v).x < 0, 'the nominal rider spot is off the map');
  v.tfAbility.smoke = 0; // WP3 electric smoke kills a rider within ~2.6 s: keep this one to the posing check
  const anchor = backAnchor(v);
  place(b1, Math.max(0.4, anchor[0]), anchor[2], 0, 0, anchor[1] - 1.7);
  ok(f.titans.rodeo(b1, 'mount'), 'rider mounts at the edge');
  const kills = f.kinds('kill').length;
  f.step(ticks(4));
  ok(b1.x >= 0 && b1.state === 'alive' && b1.rodeoVehicleId === v.id, `rider inside the area and alive after 4 s (x ${b1.x.toFixed(2)})`);
  eq(f.kinds('oob_warning').filter(e => e.id === 'b1').length, 0, 'no OOB warning for the rider');
  eq(f.kinds('kill').length, kills, 'no restricted kill');
  f.engine.stop();
}

/* ================================================================ rodeo contact mount (feel pass) */
{
  // Zones and gaps of the shared contact rule (Atlas: hw 1.35, hl 1.1, height 7; rear is hull-local +Z).
  const hull = { type: 'titan_ion', x: 0, y: 0, z: 0, yaw: 0 };
  const at = (x, y, z) => rodeoContact({ x, y, z }, hull);
  eq(at(0, 3, 2).zone, 'back', 'behind the rear plate: back');
  eq(at(2.5, 3, 0).zone, 'side', 'beside the hull: side');
  eq(at(0, 1, -2).zone, 'front', 'ahead of the cockpit: front');
  eq(at(0, 1, -0.9).zone, 'front', 'under the cockpit overhang: front');
  eq(at(0, 6.8, -2).zone, 'top', 'above the top, even forward: top');
  ok(rodeoContactMounts(at(0, 1.4, 2.2)), 'a jump apex right behind the back mounts');
  ok(rodeoContactMounts(at(2.9, 1.4, 0)), 'a jump apex beside the hull mounts');
  ok(!rodeoContactMounts(at(0, 2.5, -2.2)), 'a double jump at the cockpit never mounts');
  ok(!rodeoContactMounts(at(0, 1.4, 4.5)), 'too far behind');
  ok(!rodeoContactMounts(at(4, 0, 0)), 'a pilot 2.3 m off the side on the ground is out of contact');
  ok(rodeoContactMounts(at(0, 0, -3.5), true) && !rodeoContactMounts(at(0, 0, -4.5), true), 'hooked: 2.6 m of any part, front too');
  ok(rodeoArcMounts({ x: 0, y: 0, z: 4.5 }, [0, -8.5], hull, [0, 0]) && !rodeoArcMounts({ x: 0, y: 0, z: 4.5 }, [0, 0], hull, [0, 0]),
    'a sprint jump from 3.4 m behind reaches the back, a standing one does not');
  ok(!rodeoArcMounts({ x: 0, y: 0, z: -4 }, [0, 8.5], hull, [0, 0]), 'a sprint jump at the front never mounts');
}
{
  // Scripted pilots against a titan walking at full speed (and parked): running jumps from
  // behind and from the sides, drops from above, grapples onto it, and ground jumps at the
  // front. The server grabs every reasonable approach (≥ 80 % per family) and none from the front.
  const f = arena();
  const [a1, b1] = ['a1', 'b1'].map(f.p);
  for (const id of ['a2', 'b2']) park(f, f.p(id));
  const v = f.titans.spawnDrop(a1, 60, G, 72, 'titan_ion', -Math.PI / 2);   // walks +X, rear toward -X
  f.step(DROP_TICKS + 62);
  place(a1, v.x, v.z + 3, 0);
  f.vehicles.action(a1, { type: 'enter', vehicleId: v.id });
  f.step(ticks(TITAN_RULES.embark.animMs / 1000) + 2);
  ok(a1.vehicleId === v.id, 'piloted (contact runs)');
  const fr = titanFrame(v);
  const toWorld = (lx, lz) => [v.x + lx * Math.cos(v.yaw) + lz * Math.sin(v.yaw), v.z - lx * Math.sin(v.yaw) + lz * Math.cos(v.yaw)];
  const toLocal = (x, z) => { const dx = x - v.x, dz = z - v.z, c = Math.cos(v.yaw), s = Math.sin(v.yaw); return [dx * c - dz * s, dx * s + dz * c]; };
  const start = (walk, x0 = 60) => {
    if (b1.state !== 'alive') f.policy.deployNow('b1');   // crushed by a front run
    if (b1.rodeoVehicleId) releaseRider(f.titans, b1);
    Object.assign(b1, { rodeoCooldown: null, rodeoHook: null }); if (b1.pilot) b1.pilot.grapple = null;
    place(b1, 150, 88, 0);
    Object.assign(v, { x: x0, z: 72, yaw: -Math.PI / 2, vx: 0, vz: 0, speed: 0 });
    drive(a1, { throttle: walk ? 1 : 0, yaw: -Math.PI / 2 });
    f.step(walk ? ticks(0.6) : 2);
  };
  const run = (script, seconds) => {
    for (let i = 0; i < ticks(seconds); i++) {
      if (b1.state !== 'alive') return 'dead';
      if (b1.rodeoVehicleId === v.id) return 'mount';
      b1.input = { ...b1.input, ...script(i) };
      f.step(1);
    }
    return b1.rodeoVehicleId === v.id ? 'mount' : 'miss';
  };
  const runner = (target, gapOf, jumpGap) => {
    let jumped = false;
    return () => {
      const [wx, wz] = toWorld(target[0], target[1]);
      const keys = { f: true, sprint: true, jump: false };
      if (!jumped && b1.grounded && gapOf() <= jumpGap) { keys.jump = true; jumped = true; }
      return { yaw: Math.atan2(-(wx + (v.vx || 0) * 0.3 - b1.x), -(wz + (v.vz || 0) * 0.3 - b1.z)), pitch: 0, keys };
    };
  };
  const rate = {};
  const tally = (family, outcome) => { const r = rate[family] ??= { mount: 0, n: 0, dead: 0 }; r.n++; if (outcome === 'mount') r.mount++; if (outcome === 'dead') r.dead++; };
  for (const walk of [true, false]) {
    for (const lat of [-0.9, 0, 0.9]) for (const jumpGap of [0.8, 1.6, 2.6]) {
      start(walk);
      const [x, z] = toWorld(lat, fr.hl + 9);
      place(b1, x, z, 0);
      tally('behind', run(runner([lat * 0.5, fr.hl], () => toLocal(b1.x, b1.z)[1] - fr.hl - 0.32, jumpGap), 3));
    }
    for (const side of [-1, 1]) for (const jumpGap of [0.8, 1.6, 2.4]) {
      start(walk);
      const [x, z] = toWorld(side * (fr.hw + 7), 0.3);
      place(b1, x, z, 0);
      tally('side', run(runner([side * fr.hw, 0.3], () => Math.abs(toLocal(b1.x, b1.z)[0]) - fr.hw - 0.32, jumpGap), 3));
    }
    for (const [lx, lz] of [[-1.2, -0.6], [0, 0], [1.2, 0.6], [0.6, -0.3]]) {
      start(walk);
      const [x, z] = toWorld(lx, lz);
      place(b1, x, z, 0, 0, v.y + fr.height + 2.5);
      b1.grounded = false;
      tally('above', run(() => ({ keys: {} }), 2));
    }
    for (const ang of [0, 0.8, 1.57, 2.4, Math.PI]) {
      start(walk);
      const [x, z] = toWorld(Math.sin(ang) * 14, Math.cos(ang) * 14);
      place(b1, x, z, 0);
      resetPilotTactical(b1, 'grapple');
      aimAt(b1, [v.x, v.y + fr.height * 0.72, v.z]);
      const hooked = usePilotTactical(f.policy, b1, f.engine.now);
      tally('grapple', hooked ? run(() => ({ keys: {} }), 2.5) : 'miss');
    }
    for (const lat of [-0.8, 0, 0.8]) for (const jumpGap of [0.6, 1.6, 2.6]) {
      start(walk, walk ? 50 : 60);
      const [x, z] = toWorld(lat, -(fr.hl + 7));
      place(b1, x, z, 0);
      tally('front', run(runner([lat, -fr.hl], () => -toLocal(b1.x, b1.z)[1] - fr.hl - 0.32, jumpGap), 2));
    }
  }
  for (const family of ['behind', 'side', 'above', 'grapple']) {
    const r = rate[family];
    ok(r.mount / r.n >= 0.8, `rodeo ${family}: ${r.mount}/${r.n} mount (walking and parked titan)`);
  }
  eq(rate.front.mount, 0, `no rodeo from in front at ground level (${rate.front.n} tries, ${rate.front.dead} crushed by the walking titan)`);
  notes.push(`rodeo contact: behind ${rate.behind.mount}/${rate.behind.n}, side ${rate.side.mount}/${rate.side.n}, above ${rate.above.mount}/${rate.above.n}, grapple ${rate.grapple.mount}/${rate.grapple.n}, front ${rate.front.mount}/${rate.front.n}`);

  // A pilot standing in contact behind a parked titan is not grabbed by walking up: a jump or T does it.
  start(false);
  const [bx, bz] = toWorld(0, fr.hl + 0.32 + 0.6);
  place(b1, bx, bz, 0);
  f.step(ticks(0.3));
  eq(b1.rodeoVehicleId ?? null, null, 'standing behind the back is no mount by itself');
  ok(f.titans.rodeo(b1, 'mount'), 'T (the mount verb) mounts a pilot standing in contact');
  // Jump off: the hop stays in contact range, but the same hull does not grab it straight back.
  b1.input = { ...b1.input, keys: { jump: true } };
  f.step(1);
  ok(!b1.rodeoVehicleId, 'a jump dismounts');
  b1.input = { ...b1.input, keys: {} };
  let regrabbed = false;
  for (let i = 0; i < ticks(TITAN_RULES.rodeo.remountMs / 1000) - 2; i++) { f.step(1); regrabbed ||= !!b1.rodeoVehicleId; }
  ok(!regrabbed, 'no re-grab by the same hull inside remountMs');
  // One rider: a second airborne contact is pushed off once and not re-grabbed every tick.
  const b2 = f.p('b2');
  f.policy.deployNow('b2');
  start(false);
  place(b1, bx, bz, 0);
  ok(f.titans.rodeo(b1, 'mount'), 'first rider on');
  const [sx, sz] = toWorld(fr.hw + 0.6, 0);
  place(b2, sx, sz, 0, 0, v.y + 2);
  b2.grounded = false;
  const seq = b2.impulseSeq || 0;
  f.step(ticks(0.4));
  ok(!b2.rodeoVehicleId && v.riderId === 'b1', 'a second contact is refused');
  eq((b2.impulseSeq || 0) - seq, 1, 'the second contact is pushed off once');
  park(f, b2);
  f.engine.stop();
}

/* ================================================================ batteries */
{
  const f = arena();
  const [a1, a2, b1] = ['a1', 'a2', 'b1'].map(f.p);
  park(f, f.p('b2'));
  place(b1, 80.5, 70.5, 0, 0, G + 4.2);
  b1.tfBattery = true;
  place(a1, 80.5, 75.5); place(a2, 120.5, 60.5);
  f.engine.killPlayer(b1, a1, 'rifle', false);
  b1.respawnAt = Infinity;
  ok(!b1.tfBattery, 'carrier death drops the battery');
  const bats = f.titans.batteries();
  eq(bats.length, 1, 'one pickup');
  eq(bats[0][2], G * 10, 'pickup rests on the ground (tenths)');
  f.step(1);
  ok(f.kinds('battery_drop').length === 1, 'battery_drop event');
  eq(f.last.match.titanfall.bat.length, 1, 'match.titanfall.bat');
  // Pickup within 1.6 m.
  place(a1, 80.5 + 2.2, 70.5);
  f.step(1);
  ok(!a1.tfBattery, 'out of reach at 2.2 m');
  place(a1, 80.5 + 1.2, 70.5);
  f.step(1);
  ok(a1.tfBattery && f.titans.batteries().length === 0, 'picked up within 1.6 m');
  ok(f.kinds('battery_pickup').some(e => e.id === 'a1'), 'battery_pickup event');
  // One per pilot; lifetime 30 s; at most 12 (oldest first).
  f.titans.bats.drop(81, G, 70.5, f.engine.now);
  place(a1, 81, 70.5);
  f.step(1);
  eq(f.titans.batteries().length, 1, 'a carrier does not take a second battery');
  place(a1, 40, 90);
  f.step(ticks(TITAN_RULES.battery.lifeMs / 1000) + 2);
  eq(f.titans.batteries().length, 0, 'pickups expire after 30 s');
  for (let i = 0; i < 13; i++) f.titans.bats.drop(100 + i, G, 60, f.engine.now);
  const ids = f.titans.batteries().map(row => row[0]);
  eq(ids.length, TITAN_RULES.battery.max, 'at most 12 pickups');
  ok(!ids.includes(f.titans.bats.list[0].id.replace(/\d+$/, n => String(n - 1))), 'the oldest is removed first');
  f.engine.stop();
}

/* ================================================================ meter */
{
  const f = arena();
  const [a1, a2, b1] = ['a1', 'a2', 'b1'].map(f.p);
  park(f, f.p('b2'));
  place(a1, 40, 90); place(a2, 50, 90); place(b1, 150, 55);
  f.policy.setTitanMeter(a1, 0);
  f.step(ticks(10));
  near(f.policy.titanMeter(a1), TITAN_RULES.meter.passive * 10, 0.002, 'passive 0.9 %/s');
  // Pilot damage: +0.0005 per hp.
  f.policy.setTitanMeter(b1, 0);
  a1.takeDamage(40, false, b1, 'rifle');
  near(f.policy.titanMeter(b1), 40 * TITAN_RULES.meter.pilotDamagePerHp, 1e-9, 'pilot damage credit');
  a2.takeDamage(10, false, a1, 'rifle');
  near(f.policy.titanMeter(a1), TITAN_RULES.meter.passive * 10, 0.002, 'no credit for team damage');
  // Titan damage: +0.00008 per hp dealt.
  const v = landAt(f, a2, 70.5, 70.5);
  const m = f.policy.titanMeter(b1);
  f.vehicles.damage(v.id, 1000, b1, { cls: 'at' });
  near(f.policy.titanMeter(b1) - m, 1000 * TITAN_RULES.meter.titanDamagePerHp, 1e-9, 'titan damage credit');
  // The owner's meter holds while the titan and its wreck stand.
  f.policy.setTitanMeter(a2, 0);
  f.step(ticks(2));
  eq(f.policy.titanMeter(a2), 0, 'no fill while the titan lives');
  f.vehicles.damage(v.id, 1e6, b1, { cls: 'at' });
  f.vehicles.damage(v.id, 1e6, b1, { cls: 'at' });
  ok(!(v.hp > 0), 'destroyed');
  f.step(ticks(TITAN_WRECK_SECONDS - 1));
  ok(f.vehicles.vehicles.has(v.id), 'wreck stands until wreckSolidSeconds');
  eq(f.policy.titanMeter(a2), 0, 'no fill while the wreck stands');
  f.step(ticks(1.5));
  ok(!f.vehicles.vehicles.has(v.id), `wreck removed after ${TITAN_WRECK_SECONDS} s`);
  f.step(ticks(1));
  ok(f.policy.titanMeter(a2) > 0, 'the meter fills again after the wreck clears');
  f.engine.stop();
}

/* ================================================================ one titan per pilot; survives owner respawn; bay */
{
  const f = arena();
  const [a1, a2, b1] = ['a1', 'a2', 'b1'].map(f.p);
  park(f, f.p('b2'));
  place(b1, 150, 90);
  const v = landAt(f, a1, 70.5, 70.5);
  eq(callAt(f, a1, 100.5, 70.5).reason, 'owned', 'one titan per pilot');
  eq(f.titans.ownedBy('a1'), v, 'ownedBy');
  eq(callAt(f, a2, 100.5, 70.5).reason, 'bay', 'bay cap: ceil(2 / 2) titans per team');
  park(f, b1);
  f.engine.killPlayer(a1, null, 'world', false);
  f.engine.titanfallIntent('a1', { type: 'deploy', value: f.policy._state(a1).loadout }); // §3.4: queued DEPLOY
  f.step(ticks(4.2));
  eq(a1.state, 'alive', 'owner respawned');
  ok(v.hp > 0 && f.titans.ownedBy('a1') === v, 'the titan survives its owner\'s death');
  ok(embark(f, a1, v), 'and the respawned owner embarks again');
  f.engine.stop();
}

/* ================================================================ prediction: parity and reconcile */
{
  const f = arena([['a1', 'alpha']]);
  const a1 = f.p('a1');
  const v = landAt(f, a1, 70.5, 72.5);
  ok(embark(f, a1, v), 'piloted');
  eq(PREDICT_PLAY_AREAS.frontier, { ...PLAY_AREA_RULES.frontier }, 'client frontier bounds mirror the play area');
  const clientWorld = () => createWalkerWorld({ getBlock: (x, y, z) => f.engine.world.getBlock(x, y, z), dimensions: f.engine.world.dimensions, mapId: 'harbor' });
  // A scripted 50 ms control plan (the seated send rate): walk, strafe, sprint, turn, dash, stop.
  const plan = [];
  for (let i = 0; i < 60; i++) {
    const t = i * 0.05;
    plan.push({ fwd: t < 2.2 ? 1 : 0, side: t > 0.8 && t < 1.6 ? 1 : 0, sprint: t > 0.3 && t < 0.8, aimYaw: 0.4 * Math.sin(t * 1.3), dash: i === 20 });
  }
  // Server: TitanSystem through the engine, input changed on 50 ms boundaries (every 3 ticks).
  const start = { x: v.x, y: v.y, z: v.z, yaw: v.yaw, dash: v.dash };
  const server = [];
  for (let i = 0; i < plan.length; i++) {
    const c = plan[i];
    drive(a1, { throttle: c.fwd, steer: c.side, yaw: c.aimYaw, hold: c.sprint ? 1 : 0 });
    if (c.dash) ok(f.titans.ability(v, a1, 'dash'), 'server dash accepted');
    for (let k = 0; k < 3; k++) { f.step(1); server.push({ x: v.x, y: v.y, z: v.z, yaw: v.yaw, row: f.row(v.id) }); }
  }
  const end = server.at(-1);
  for (const hz of [20, 60, 120]) {
    const predictor = new TitanPredictor(clientWorld());
    predictor.adopt({ id: v.id, type: v.type, x: start.x, y: start.y, z: start.z, yaw: start.yaw, tw: [0, Math.round(start.dash * 10), 0, 0, 0, 0] });
    predictor.v.dash = start.dash;
    const frames = Math.round(0.05 * hz);
    let maxErr = 0;
    for (let i = 0; i < plan.length; i++) {
      const c = plan[i];
      if (c.dash) predictor.noteDash();
      for (let k = 0; k < frames; k++) predictor.step(1 / hz, c);
      const s = server[i * 3 + 2];
      maxErr = Math.max(maxErr, Math.hypot(predictor.v.x - s.x, predictor.v.y - s.y, predictor.v.z - s.z));
    }
    ok(maxErr < 1e-6, `client stepTitanWalk at ${hz} Hz matches the server (max ${maxErr.toExponential(2)} m)`);
    notes.push(`parity ${hz} Hz: max error ${maxErr.toExponential(2)} m`);
  }
  ok(Math.hypot(end.x - start.x, end.z - start.z) > 8, 'the script moved the titan');
  // Reconcile: a 1.2 m error (blend) and a 5 m error (snap) both converge under 0.25 m
  // while rows arrive 100 ms late.
  for (const [offset, label] of [[1.2, 'blend'], [5, 'snap']]) {
    const predictor = new TitanPredictor(clientWorld());
    predictor.adopt({ id: v.id, type: v.type, x: start.x + offset, y: start.y, z: start.z, yaw: start.yaw, tw: [0, Math.round(start.dash * 10), 0, 0, 0, 0] });
    predictor.v.dash = start.dash;
    let lastErr = Infinity;
    for (let i = 0; i < plan.length; i++) {
      const c = plan[i];
      if (c.dash) predictor.noteDash();
      for (let k = 0; k < 3; k++) {
        predictor.step(1 / 60, c);
        const tick = i * 3 + k - 6; // 100 ms latency
        if (tick >= 0) lastErr = predictor.reconcile({ ...server[tick].row });
      }
    }
    for (let k = 0; k < 30; k++) { predictor.step(1 / 60, {}); predictor.reconcile({ ...end.row }); }
    const final = Math.hypot(predictor.v.x - end.x, predictor.v.y - end.y, predictor.v.z - end.z);
    ok(lastErr < PREDICT_RULES.blendError, `${label}: trail error under 0.25 m while moving (${lastErr.toFixed(3)} m)`);
    ok(final < 0.05, `${label}: at rest the pose settles on the row (${final.toFixed(3)} m)`);
    notes.push(`reconcile ${label} (${offset} m start error, 100 ms rows): trail error ${lastErr.toFixed(3)} m, final ${final.toFixed(3)} m`);
    if (label === 'snap') ok(predictor.snaps >= 1, 'a 5 m error snaps');
  }
  // Divergence mid-run: a dash the server never ran. Rows are matched around the
  // round trip (not the nearest sample in the whole trail), so the error is seen
  // within about one round trip and blended out, and the velocity the server
  // never had (dash, slide) is dropped.
  {
    const predictor = new TitanPredictor(clientWorld());
    predictor.adopt({ id: v.id, type: v.type, x: start.x, y: start.y, z: start.z, yaw: start.yaw, tw: [0, Math.round(start.dash * 10), 0, 0, 0, 0] });
    predictor.v.dash = start.dash;
    let phantomAt = null, settledAt = null, correctedAt = null, maxLive = 0;
    for (let i = 0; i < plan.length; i++) {
      const c = plan[i];
      if (c.dash) predictor.noteDash();
      if (i === 34) { predictor.dashQueued = true; predictor.dashControls = { fwd: 0, side: -1, aimYaw: c.aimYaw }; phantomAt = i * 3; }
      for (let k = 0; k < 3; k++) {
        predictor.step(1 / 60, c);
        const tick = i * 3 + k, row = tick - 6;
        if (row >= 0) predictor.reconcile({ ...server[row].row }, 100, TICK_MS / 1000);
        const live = Math.hypot(predictor.v.x - server[tick].x, predictor.v.z - server[tick].z);
        if (phantomAt !== null && tick > phantomAt && predictor.correction) correctedAt ??= tick;
        if (phantomAt !== null && tick > phantomAt) {
          maxLive = Math.max(maxLive, live);
          if (live < PREDICT_RULES.blendError) settledAt ??= tick; else settledAt = null;
        }
      }
    }
    const ms = tick => tick === null ? Infinity : (tick - phantomAt) * TICK_MS;
    ok(maxLive > 2, `phantom dash diverges (${maxLive.toFixed(2)} m)`);
    ok(ms(correctedAt) <= 100 + 4 * TICK_MS, `correction under way within about one round trip (${ms(correctedAt).toFixed(0)} ms)`);
    ok(ms(settledAt) <= 600, `back under 0.25 m within ${ms(settledAt).toFixed(0)} ms`);
    notes.push(`reconcile phantom dash: max ${maxLive.toFixed(2)} m, correcting after ${ms(correctedAt).toFixed(0)} ms, settled after ${ms(settledAt).toFixed(0)} ms`);
  }
  // Dash requests mirror the server: refused without a pip or mid-dash, one-shot when they cannot fire.
  {
    const predictor = new TitanPredictor(clientWorld());
    predictor.adopt({ id: v.id, type: v.type, x: start.x, y: start.y, z: start.z, yaw: start.yaw, tw: [0, 20, 0, 0, 0, 0] });
    ok(predictor.noteDash(), 'dash noted with pips');
    predictor.step(1 / 60, { fwd: 1, aimYaw: start.yaw });
    ok(predictor.v.dashT > 0, 'dash fires on the next substep');
    eq(predictor.noteDash(), false, 'a dash pressed mid-dash is refused (server ability())');
    const steps = (seconds, c) => { for (let i = 0; i < Math.round(seconds * 60); i++) predictor.step(1 / 60, c); };
    steps(0.3, { fwd: 1, aimYaw: start.yaw });
    ok(predictor.noteDash(), 'second pip');
    steps(0.3, { fwd: 1, aimYaw: start.yaw });
    eq(predictor.noteDash(), false, 'no pip left: refused at the press');
    steps(1, { aimYaw: start.yaw });
    eq(predictor.v.dashT, 0, 'a refused press never fires later');
    predictor.v.dash = 1; predictor.v.grounded = false;
    ok(predictor.noteDash(), 'queued while airborne');
    predictor.step(1 / 120, { aimYaw: start.yaw });
    predictor.v.grounded = true;
    steps(0.1, { aimYaw: start.yaw });
    eq(predictor.v.dashT, 0, 'a queued dash that cannot fire on its substep is dropped (one-shot dashRequest)');
    // The dash runs along the controls the server holds (noteDash(controls) / the last noteSent).
    predictor.v.dash = 2; predictor.v.vx = 0; predictor.v.vz = 0;
    predictor.noteSent({ fwd: 1, side: 0, aimYaw: start.yaw });
    predictor.noteDash();
    predictor.step(1 / 120, { fwd: 0, side: -1, aimYaw: start.yaw });
    near(Math.hypot(predictor.v.dashX + Math.sin(start.yaw), predictor.v.dashZ + Math.cos(start.yaw)), 0, 1e-9, 'dash along the last sent controls, not the live keys');
  }
  // Another hull ahead: the server reverts the overlapping substep, the predictor too.
  {
    const g = arena([['a1', 'alpha'], ['a2', 'alpha'], ['a3', 'alpha'], ['a4', 'alpha']]);
    const q = g.p('a2'), p = g.p('a1');
    const other = landAt(g, q, 70.5, 62.5);
    place(q, 150, 60);
    const own = landAt(g, p, 70.5, 72.5);
    ok(embark(g, p, own), 'piloted (hull ahead)');
    other.x = own.x; other.z = own.z - 8; other.yaw = 0;
    g.step(2);
    const world2 = createWalkerWorld({ getBlock: (x, y, z) => g.engine.world.getBlock(x, y, z), dimensions: g.engine.world.dimensions, mapId: 'harbor' });
    const predictor = new TitanPredictor(world2);
    predictor.adopt(g.row(own.id));
    predictor.setObstacles(g.last.vehicles.map(row => ({ ...row })), own.id);
    eq(predictor.obstacles.length, 1, 'the other titan row is an obstacle, the own one is not');
    drive(p, { throttle: 1, yaw: own.yaw });
    g.step(ticks(3));
    for (let i = 0; i < 180; i++) predictor.step(1 / 60, { fwd: 1, aimYaw: own.yaw });
    near(predictor.v.z, own.z, 0.02, `prediction stops at the hull where the server does (${predictor.v.z.toFixed(2)} vs ${own.z.toFixed(2)})`);
    g.engine.stop();
  }
  f.engine.stop();
}
/* ================================================================ prediction glue: sprint, sends, rtt, obstacles */
{
  // A flat pad in the client world (shared/worlddata) for the module glue.
  const floor = 5;
  for (let x = 20; x < 70; x++) for (let z = 20; z < 70; z++) for (let y = 0; y < CLIENT_SY; y++) setClientBlock(x, y, z, y < floor ? STONE : AIR);
  const keys = {}, poses = [];
  let hold = 0;
  const app = { mapMeta: { id: 'glue-test', dimensions: { sx: CLIENT_SX, sy: CLIENT_SY, sz: CLIENT_SZ } }, myId: 'me',
    vehicleController: { active: true, vehicle: { id: 'T9' }, seatId: 'driver' }, input: { getKeys: () => keys },
    player: { view: { yaw: 0, pitch: 0 } }, session: { gameplayInputEnabled: true }, net: { ping: 80 }, _vehicleSendAt: 0,
    vehicleView: { setPredictedPose: (id, pose) => poses.push([id, pose]) } };
  titanPredict.init(app, { titanHold: () => hold });
  const own = { id: 'T9', type: 'titan_ion', x: 45, y: floor, z: 60, yaw: 0, hp: 2500, own: 'me', tw: [0, 20, 0, 0, 0, TITAN_PHASE.idle] };
  const blocker = { id: 'T3', type: 'titan_ion', x: 45, y: floor, z: 30, yaw: 0, hp: 2500, own: 'x', tw: [0, 20, 0, 0, 0, TITAN_PHASE.auto] };
  titanPredict.tick({ vehicles: [own, blocker] });
  const pr = titanPredict.activePredictor();
  ok(pr && pr.rttMs === 80, 'rtt from the netclient ping');
  eq(pr.obstacles.map(row => row.id), ['T3'], 'snapshot hull rows become obstacles');
  Object.assign(keys, { forward: true, sprint: true });
  for (let i = 0; i < 90; i++) titanPredict.frame(1 / 60);
  near(pr.v.speed, titanFrame('titan_ion').walk, 1e-6, 'the sprint key alone does not sprint (the seated send carries titanHold only)');
  hold = 1;
  for (let i = 0; i < 30; i++) titanPredict.frame(1 / 60);
  near(pr.v.speed, titanFrame('titan_ion').sprint, 1e-6, 'titanHold bit 1 sprints');
  app._vehicleSendAt = 1234; app.player.view.yaw = 0.1;
  titanPredict.frame(1 / 60);
  ok(pr.sent && pr.sent.fwd === 1 && pr.sent.aimYaw === 0.1 && pr.sent.sprint === true, 'a seated send is noted with its controls');
  for (let i = 0; i < 400; i++) titanPredict.frame(1 / 60);
  ok(pr.v.z > blocker.z + 2 * titanFrame('titan_ion').hl - 0.2, `stops at the snapshot hull (${pr.v.z.toFixed(2)})`);
  ok(poses.length > 0 && poses.at(-1)[0] === 'T9', 'pose handed to vehicleView');
  titanPredict.dispose();
}

console.log(notes.map(line => `  ${line}`).join('\n'));
console.log(`Titanfall titan sim: ${checks} checks passed (call and refusals, ground lost mid-drop, drop crush and push, leg crush, shield order, no regen, doom 7 s, eject and credit, owner-only enter, destroyed during embark, blind spot, auto-titan fire/credit/smoke, rodeo rip/one rider/insert cap/hatch/ally shot/contact mount rates, batteries, meter, wreck removal, one titan per pilot, respawn survival, walker speeds/turns/dash/step/slope/fluid/lava/bounds/voxel ram, prediction parity at 20/60/120 Hz and reconcile).`);
