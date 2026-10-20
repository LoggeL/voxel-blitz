// Support mortar (shared/mortar-rules.js, server/sim/mortars.js, server/bot-mortar.js):
// the contract and kit, the shared high-arc solve, placement and its refusals,
// the cooldowns, one mortar per player, rounds landing on the laid target,
// crushing, the operator surviving, the wreck going, no hijack and no deploy
// spawn; the client controls, RMB snap, camera, model muzzle, fire-control
// read model and banners; and a Support bot on Frontier placing a mortar and
// walking rounds onto spotted enemies taking a flag.
//
//   node tools/conquest-mortar-test.mjs
import assert from 'node:assert/strict';
import * as THREE from '../public/js/vendor/three.module.js';
import { GameEngine } from '../server/game.js';
import { attachBots } from '../server/bots.js';
import { TICK_MS, parseConquestIntent } from '../server/protocol/admission.js';
import { createMapState, getMapMeta } from '../shared/worlddata.js';
import { mulberry32 } from '../shared/noise.js';
import {
  CONQUEST_CONTRACT_VERSION, CONQUEST_EVENT_KINDS, CONQUEST_INTENT_SHAPE, DEPLOYABLE_TYPE_IDS, KITS, VEHICLE_TOPOLOGY,
  SCORE_CATEGORY_IDS, SCORE_POINTS, VEHICLE_TYPE_IDS, VEHICLE_WEAPON_META, isDeployableType,
} from '../shared/conquest-contract.js';
import { kitDeployable, kitGadget, KIT_GADGET_LABELS } from '../shared/conquest-kits.js';
import {
  MORTAR_BOT_RULES, MORTAR_REFUSALS, MORTAR_RULES, mortarAim, mortarFlatRange, mortarFlatTime, mortarPitchForRange,
  mortarRangeEnvelope, mortarSnapTargets, solveMortarArc,
} from '../shared/mortar-rules.js';
import { VEHICLE_DEFS, isEmplacementType, mountPose, vehicleWeapon } from '../shared/vehicle-defs.js';
import { vehicleHijackable } from '../shared/vehicle-seats.js';
import { blocksHulls, solidHull } from '../shared/vehicle-collision.js';
import { deployOptions } from '../shared/conquest.js';
import { installFakeDom } from './lib/conquest-ui-dom.mjs';

let checks = 0;
const ok = (value, message) => { assert.ok(value, message); checks++; };
const eq = (a, b, message) => { assert.deepEqual(a, b, message); checks++; };
const flat = (a, b) => Math.hypot(a[0] - b[0], a[2] - b[2]);

// ------------------------------------------------------------ contract --
eq(CONQUEST_CONTRACT_VERSION, 8, 'contract v6 carries the mortar');
eq(CONQUEST_EVENT_KINDS[CONQUEST_EVENT_KINDS.indexOf('recon_gadget') + 1], 'mortar', 'the mortar event kind is appended after the recon kind');
eq(CONQUEST_INTENT_SHAPE.mortar, '1');
eq(DEPLOYABLE_TYPE_IDS, ['mortar', 'fpv']);
ok(isDeployableType('mortar') && !VEHICLE_TYPE_IDS.includes('mortar'), 'the mortar is a deployable, no pad hull');
ok(isEmplacementType('mortar'), 'emplacement handling');
eq(VEHICLE_TOPOLOGY.mortar.map(s => [s.id, s.role, s.drives, s.exposed]), [['operator', 'gunner', false, true]]);
eq(VEHICLE_WEAPON_META.mortarHE.kind, 'shell');
eq(KITS.support.gadgets, ['ammocrate', 'mortar']);
eq([kitGadget('support', 1), kitDeployable('support', 1), kitDeployable('support', 0), kitDeployable('engineer', 1)], [null, 'mortar', 'ammocrate', null]);
eq(KIT_GADGET_LABELS.mortar.name, 'M-81 MORTAR');
eq(parseConquestIntent({ mortar: 1 }), { type: 'mortar' });
eq(parseConquestIntent({ mortar: 2 }), null, 'only mortar:1 places');
eq(MORTAR_REFUSALS, ['kit', 'state', 'cooldown', 'ground', 'blocked']);

// ----------------------------------------------------------- ballistics --
{
  const envelope = mortarRangeEnvelope();
  ok(envelope.min > 35 && envelope.min < 50 && envelope.max > 240 && envelope.max < 260, `range band ${envelope.min.toFixed(0)}..${envelope.max.toFixed(0)} m`);
  for (const pitch of [0.8, 1.0, 1.2, 1.4]) {
    const range = mortarFlatRange(pitch);
    const solved = solveMortarArc([0, 10, 0], [0, 10, -range]);
    ok(Math.abs(solved.pitch - pitch) < 1e-6 && Math.abs(solved.yaw) < 1e-9, `flat solve recovers ${pitch}`);
    ok(Math.abs(solved.tof - mortarFlatTime(pitch)) < 1e-6, 'time of flight');
    ok(Math.abs(mortarPitchForRange(range) - pitch) < 1e-6, 'pitch for range');
  }
  eq(solveMortarArc([0, 0, 0], [0, 0, -400]).reason, 'far');
  eq(solveMortarArc([0, 0, 0], [0, 0, -10]).reason, 'near');
  // Uphill and downhill: the arc meets the target height.
  for (const dy of [-20, 15]) {
    const s = solveMortarArc([0, 0, 0], [60, dy, -120]);
    const vx = 59 * Math.cos(s.pitch), vy = 59 * Math.sin(s.pitch), t = Math.hypot(60, 120) / vx;
    ok(Math.abs(vy * t - 0.5 * 14 * t * t - dy) < 1e-6, `arc reaches ${dy} m`);
  }
}

// ---------------------------------------------------------- server rig --
function fixture({ jeep = false, holes = null } = {}) {
  const frames = [], dimensions = { sx: 512, sy: 64, sz: 512 };
  // `holes`: a Set of 'x,z' columns whose ground voxel is gone.
  const world = { dimensions, getBlock: (x, y, z) => y === 0 && !holes?.has(`${x},${z}`) ? 3 : 0, setBlock() { return true; },
    findSpawns: () => [{ x: 20, y: 1, z: 20 }] };
  const game = new GameEngine({ mode: 'conquest', world, broadcast: frame => frames.push(frame),
    mapMeta: { id: 'frontier', dimensions, spawns: { conquest: { alpha: [{ x: 20, y: 1, z: 20 }], bravo: [{ x: 30, y: 1, z: 20 }] } },
      conquest: { flags: [], bases: {}, vehicleSpawns: jeep ? [{ id: 'j', type: 'jeep', team: 'bravo', x: 300, y: 1, z: 300, yaw: 0 }] : [] } } });
  const policy = game.mode.policy;
  const join = (id, team, at) => {
    game.addClient(id, id);
    const p = game.entities.get(id);
    policy.setLobbyTeam(p, team);
    Object.assign(p, { x: at[0], y: at[1], z: at[2], yaw: 0, grounded: true, hp: 100, armor: 0, spawnProtectedUntil: 0, input: { keys: {}, yaw: 0, pitch: 0 } });
    return p;
  };
  const events = () => frames.flatMap(f => f.events || []);
  const step = (n = 1) => { for (let i = 0; i < n; i++) game.step(TICK_MS); };
  const mortarEvents = id => events().filter(e => e.kind === 'mortar' && e.id === id);
  return { game, policy, join, events, step, mortarEvents };
}

const f = fixture({ jeep: true });
const s = f.join('s', 'alpha', [100.5, 1, 100.5]);
const enemy = f.join('e', 'bravo', [100.5, 1, 99.1 + 150]);
const thief = f.join('t', 'bravo', [300, 1, 302]);
// Not a Support with the mortar gadget: refused, nothing placed.
f.policy.roles.applyLoadout(s, 'support', 0, 0);
f.policy.conquestIntent(s, { type: 'mortar' });
f.step();
eq(f.mortarEvents('s').map(e => [e.state, e.reason]), [['refused', 'kit']], 'no gadget: refused');
ok(!s.vehicleId, 'no mortar without the gadget');
// With it: placed 1.4 m ahead, seated, owned.
f.policy.roles.applyLoadout(s, 'support', 0, 1);
Object.assign(s, { x: 100.5, y: 1, z: 100.5, yaw: 0, grounded: true });
ok(f.policy.conquestIntent(s, { type: 'mortar' }) === true, 'the intent places the mortar');
const v = f.game.vehicles.vehicles.get(s.vehicleId);
ok(v?.type === 'mortar' && s.vehicleSeatId === 'operator', 'seated at the operator seat');
ok(Math.abs(v.z - (100.5 - MORTAR_RULES.placeForward)) < 1e-6 && Math.abs(v.y - 1) < 1e-6, 'on the ground ahead of the feet');
f.step();
eq(f.mortarEvents('s').at(-1).state, 'placed');
const row = f.game.vehicles.row(v, f.game.vehicles.nowMs());
eq(row.own, 's', 'the row names its owner');
ok(Array.isArray(row.mounts) && row.mounts.length === 1, 'one tube mount on the row');
ok(!blocksHulls(v) && solidHull(v), 'solid for bodies, no obstacle for hulls');
ok(!vehicleHijackable(v, 'bravo'), 'never hijacked');
const options = deployOptions({ flags: [] }, { id: 's2', team: 'alpha' }, undefined);
ok(!options.some(o => o.type === 'mortar'), 'never a deploy spawn');
// Seated: a second intent is refused ('state').
f.policy.conquestIntent(s, { type: 'mortar' });
f.step();
eq(f.mortarEvents('s').at(-1).reason, 'state');

// Fire on the enemy 150 m out: the rounds land on him.
{
  const aim = mortarAim(v, VEHICLE_DEFS.mortar.mounts.tube, [enemy.x, enemy.y, enemy.z]);
  ok(Number.isFinite(aim.pitch) && aim.pitch > 1.1, 'a high-arc solution');
  s.input = { keys: {}, yaw: aim.yaw, pitch: aim.pitch, wantFire: false };
  f.step(60 * 5); // the tube traverses 0.9 rad/s: half a turn takes 3.5 s
  s.input.wantFire = true;
  const before = f.events().length;
  f.step(60 * 24);
  s.input.wantFire = false;
  const later = f.events().slice(before);
  const booms = later.filter(e => e.kind === 'projectileExplode' && e.vehicleWeapon === 'mortarHE');
  ok(booms.length >= 1, 'rounds explode');
  ok(flat([booms[0].x, 0, booms[0].z], [enemy.x, 0, enemy.z]) < 7, `the first round lands inside the blast (spreadDeg)  (${flat([booms[0].x, 0, booms[0].z], [enemy.x, 0, enemy.z]).toFixed(1)} m)`);
  ok(later.some(e => e.kind === 'kill' && e.killer === 's' && e.victim === 'e' && e.w === 'mortarHE'), 'the enemy dies to the mortar');
  const tube = f.game.vehicles.mounts.state(v, 'tube');
  ok(tube.shots >= 5 && tube.ammo < vehicleWeapon('mortarHE').magazine + 1, 'five rounds a box');
}

// Leave and place again elsewhere: the new mortar replaces the old; another
// placement within replaceCooldownMs of it is refused.
{
  f.game.vehicles.exit(s);
  Object.assign(s, { x: 140.5, y: 1, z: 140.5, yaw: 0, grounded: true });
  ok(f.policy.conquestIntent(s, { type: 'mortar' }) === true, 'a new mortar');
  ok(!f.game.vehicles.vehicles.has(v.id), 'the old mortar is gone');
  eq(f.game.vehicles.mortars.live().length, 1, 'one mortar per player');
  const second = s.vehicleId;
  f.game.vehicles.exit(s);
  Object.assign(s, { x: 180.5, y: 1, z: 180.5, yaw: 0, grounded: true });
  f.policy.conquestIntent(s, { type: 'mortar' });
  f.step();
  ok(f.mortarEvents('s').at(-1).reason === 'cooldown' && f.game.vehicles.vehicles.has(second), 'no instant re-placement');
  f.step(60 * 3);
  Object.assign(s, { x: 140.5, y: 1, z: 140.5, yaw: 0, grounded: true });
  ok(f.game.vehicles.enter(s, second, 'operator'), 'back on the own tube');
}

// A hull rolling over it crushes it; the operator survives and waits out the lost cooldown.
{
  const m = f.game.vehicles.vehicles.get(s.vehicleId), jeep = f.game.vehicles.vehicles.get('j');
  Object.assign(thief, { x: jeep.x, y: jeep.y, z: jeep.z });
  ok(f.game.vehicles.enter(thief, 'j'), 'the enemy takes the jeep');
  Object.assign(jeep, { x: m.x, z: m.z + 1.2, y: m.y, speed: 8, yaw: 0 });
  f.step(2);
  ok(!(m.hp > 0), 'crushed');
  ok(s.state === 'alive' && !s.vehicleId, 'the operator survives and is out');
  const lost = f.mortarEvents('s').find(e => e.state === 'lost');
  ok(lost && lost.waitMs === MORTAR_RULES.lostCooldownMs, 'lost, with the cooldown');
  ok(f.events().some(e => e.kind === 'vehicle_destroyed' && e.vehicleId === m.id && e.attacker === 't'), 'the jeep driver gets the kill');
  // A mortar is a gadget, not a vehicle: gadget_destroyed (50), no vehicle award, stat or ribbon progress.
  f.step(Math.ceil(2000 / TICK_MS));
  const paid = f.events().filter(e => e.kind === 'score' && e.id === 't');
  eq(paid.filter(e => e.reason === 'gadget_destroyed').map(e => e.pts), [SCORE_POINTS.gadget_destroyed], 'the destroyer earns gadget_destroyed');
  ok(!paid.some(e => ['vehicle_destroyed', 'vehicle_crew', 'vehicle_disabled', 'vehicle_damage'].includes(e.reason)), 'no vehicle points for a mortar');
  eq(f.policy.score.statsRow('t')[1], 0, 'a mortar never counts as a vehicle destroyed');
  eq(f.policy.score.categoryRow('t')[SCORE_CATEGORY_IDS.indexOf('vehicles')], 0, 'nothing in the vehicles category');
  Object.assign(s, { x: 60.5, y: 1, z: 60.5, yaw: 0, grounded: true });
  f.policy.conquestIntent(s, { type: 'mortar' });
  f.step();
  ok(f.mortarEvents('s').at(-1).reason === 'cooldown' && f.mortarEvents('s').at(-1).waitMs > 15000, 'cooldown after a loss');
  f.step(60 * (MORTAR_RULES.wreckSeconds + 1));
  ok(!f.game.vehicles.vehicles.has(m.id), 'the wreck is removed');
}

// Refusals: no ground ahead, a wall in the way; an owner leaving takes his mortar.
{
  const g = fixture();
  const p = g.join('p', 'alpha', [100.5, 1, 100.5]);
  g.policy.roles.applyLoadout(p, 'support', 0, 1);
  Object.assign(p, { x: 0.6, y: 1, z: 0.6, yaw: 0, grounded: true });
  g.policy.conquestIntent(p, { type: 'mortar' });
  g.step();
  eq(g.mortarEvents('p').at(-1).reason, 'ground', 'off the map edge: no ground');
  Object.assign(p, { x: 100.5, y: 1, z: 100.5, yaw: 0, grounded: true });
  ok(g.policy.conquestIntent(p, { type: 'mortar' }) === true);
  g.game.removeClient('p');
  g.step(2);
  eq(g.game.vehicles.mortars.live().length, 0, 'a leaving owner takes his mortar');
}

// The ground under a placed mortar goes: it is lost (no credit), the operator survives.
{
  const holes = new Set();
  const g = fixture({ holes });
  const p = g.join('p', 'alpha', [100.5, 1, 100.5]);
  g.policy.roles.applyLoadout(p, 'support', 0, 1);
  ok(g.policy.conquestIntent(p, { type: 'mortar' }) === true);
  const m = g.game.vehicles.vehicles.get(p.vehicleId);
  g.step(2);
  ok(m.hp > 0, 'standing on its ground');
  holes.add(`${Math.floor(m.x)},${Math.floor(m.z)}`);
  g.game.blockRevision++;
  g.step(2);
  ok(!(m.hp > 0), 'no ground: destroyed');
  ok(p.state === 'alive' && !p.vehicleId, 'the operator survives');
  eq(g.mortarEvents('p').at(-1)?.state, 'lost', 'lost event');
  ok(g.events().some(e => e.kind === 'vehicle_destroyed' && e.vehicleId === m.id && e.attacker == null), 'no one is credited');
}

// A bot that left its mortar after a hit and walks back to it later stays at
// the tube: the hull reading starts again from its hit points then.
{
  const { ConquestMortarBots } = await import('../server/bot-mortar.js');
  const tube = { shots: 0, yaw: 0, pitch: 1, cooldown: 0, ammo: 5 };
  const game = { mode: { mode: 'conquest', teamFor: p => p.team }, entities: new Map(), mapMeta: {}, now: 0,
    vehicles: { mortars: {}, vehicles: new Map(), mounts: { state: () => tube } } };
  const mb = new ConquestMortarBots(game, {});
  const br = { id: 'b', rng: () => 0.5 }, bot = { id: 'b', team: 'alpha', x: 0, z: 0, state: 'alive' };
  const m = { id: 'm', type: 'mortar', hp: 150, x: 0, y: 0, z: 0, yaw: 0 };
  let inp = { keys: {} };
  mb.operate(br, bot, m, 0, inp);
  ok(!inp.vehicleAction, 'seated');
  m.hp = 100; inp = { keys: {} };
  mb.operate(br, bot, m, 100, inp);
  eq(inp.vehicleAction, { type: 'exit' }, 'out when the mortar is hit');
  inp = { keys: {} };
  mb.operate(br, bot, m, 20000, inp);
  ok(!inp.vehicleAction, 'back at the damaged mortar, no instant exit');
}

// ------------------------------------------------------------- client --
const dom = installFakeDom({ width: 1440, height: 900 });
const { VehicleController } = await import('../public/js/session/vehicle-controller.js');
const { VehicleCamera } = await import('../public/js/session/vehicle-camera.js');
const { mortarSightModel, mortarBanner, MortarSight, MORTAR_HINT_MS } = await import('../public/js/ui/conquest/mortar-sight.js');
const { seatedVehicle, mapItems } = await import('../public/js/ui/conquest-hud-state.js');
const { VehicleView } = await import('../public/js/engine/vehicle-view.js');
const { KILL_KEY_ICONS, ICON_PATHS } = await import('../public/js/ui/conquest/icons.js');
{
  const yaw = 0.4;
  const mortar = { id: 'mortar-me-1', type: 'mortar', team: 'alpha', x: 50, y: 10, z: 50, yaw, pitch: 0, roll: 0, hp: 150,
    seatOccupants: { operator: 'me' }, mounts: [[yaw, 1.2, 3, 0, 0]], own: 'me' };
  const self = { id: 'me', team: 'alpha', state: 'alive', hp: 100, x: 50, y: 10, z: 50.6, vehicleId: mortar.id, vehicleSeatId: 'operator', cq: [3, 1, 0, 0, 0, 0, 0] };
  const foe = { id: 'foe', team: 'bravo', state: 'alive', hp: 100, x: 50 - Math.sin(yaw) * 150 + 6, y: 10, z: 50 - Math.cos(yaw) * 150, cq: [0, 1, 0, 1, 0, 0, 0] };
  const hidden = { id: 'hid', team: 'bravo', state: 'alive', hp: 100, x: foe.x + 2, y: 10, z: foe.z, cq: [0, 1, 0, 0, 0, 0, 0] };
  eq(mortarSnapTargets({ players: [self, foe, hidden], vehicles: [], team: 'alpha' }), [[foe.x, 10, foe.z]], 'only spotted enemies snap');

  const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 1000);
  const controller = new VehicleController({ camera, eventTarget: null, raycast: () => null, now: () => 5000 });
  controller.sync({ self, vehicles: [mortar], players: [self, foe, hidden], enabled: true });
  ok(controller.active && controller.type === 'mortar', 'seated at the mortar');
  controller.yaw = yaw; controller.pitch = 1.0;
  let out = controller.controls({}, { dx: 0, dy: -0.2 });
  ok(Math.abs(out.pitch - 0.9) < 1e-9, 'mouse forward lowers the tube (farther)');
  out = controller.controls({}, { dx: 0, dy: -5 });
  eq(out.pitch, MORTAR_RULES.minPitch, 'clamped at 45 degrees');
  out = controller.controls({}, { dx: 0, dy: 5 });
  eq(out.pitch, MORTAR_RULES.maxPitch, 'clamped at 85 degrees');
  controller.pitch = mortarPitchForRange(150);
  controller.updateCamera(1 / 60);
  eq(controller.view.mode, 'mortar', 'the mortar view');
  const impact = controller.view.mortarImpact;
  ok(impact && Math.abs(Math.hypot(impact[0] - 50, impact[2] - 50) - 150) < 3, 'the camera looks at the flat impact');
  ok(camera.position.y > 10 + MORTAR_RULES.placeRise, 'raised behind the tube');
  const snap = controller.snapMortar();
  ok(snap && snap.target[0] === foe.x, 'RMB snaps to the spotted enemy');
  const laid = mortarAim(mortar, VEHICLE_DEFS.mortar.mounts.tube, [foe.x, foe.y, foe.z]);
  ok(Math.abs(controller.yaw - laid.yaw) < 1e-9 && Math.abs(controller.pitch - laid.pitch) < 1e-9, 'laid with the shared solve');
  controller.dispose();

  // Fire-control read model from the row (a flat floor at y 10).
  const floor = (origin, dir, max) => (dir.y < -1e-6 && (10 - origin.y) / dir.y <= max ? { t: (10 - origin.y) / dir.y } : null);
  const seated = seatedVehicle(self, [mortar]);
  const model = mortarSightModel(seated, { items: mapItems({ cq: { flags: [], bases: {} }, self, players: [self, foe, hidden], vehicles: [mortar], selfTeam: 'alpha' }),
    raycast: floor, aim: { yaw, pitch: 1.2 } });
  const expected = mountPose(mortar, 'operator', 'tube');
  ok(Math.abs(model.range - Math.hypot(model.impact[0] - expected.origin[0], model.impact[2] - expected.origin[2])) <= 1, 'range from the solved impact');
  ok(Math.abs(model.range - mortarFlatRange(1.2)) < 4, `impact near the flat range (${model.range})`);
  eq([model.azimuth, model.elevation, model.rounds.ammo, model.rounds.magazine, model.laid], [Math.round((360 - yaw * 180 / Math.PI) % 360), 68.8, 3, 5, true]);
  eq(model.targets.map(t => t.id), ['foe'], 'only spotted enemies on the sight');
  eq(mortarSightModel(seated, { aim: { yaw: yaw + 0.3, pitch: 1.2 } }).status, 'LAYING', 'the tube still slews');
  eq(mortarSightModel({ row: { ...mortar, type: 'jeep' }, seat: VEHICLE_TOPOLOGY.jeep[0] }), null, 'no sight in other hulls');

  // Panel: the key hints show for a while after manning, then go.
  const sight = new MortarSight(dom.document.body, { hints: 'MOUSE AIM · RMB SNAP' });
  sight.update(model, { clockMs: 1000 });
  ok(!sight.root.hidden && sight.hints.textContent.includes('RMB SNAP'), 'hints at first');
  eq(sight.values.range.textContent, `${model.range} M`);
  sight.update(model, { clockMs: 1000 + MORTAR_HINT_MS + 1 });
  ok(sight.hints.hidden && sight.hints.textContent === '', 'hints fade');
  sight.update(null);
  ok(sight.root.hidden, 'hidden off the tube');

  eq(mortarBanner({ kind: 'mortar', id: 'me', state: 'refused', reason: 'cooldown', waitMs: 12400 }, 'me').detail, 'READY IN 13 S');
  eq(mortarBanner({ kind: 'mortar', id: 'me', state: 'lost', vehicleId: 'x', waitMs: 20000 }, 'me').title, 'MORTAR LOST');
  eq(mortarBanner({ kind: 'mortar', id: 'other', state: 'placed' }, 'me'), null, 'only own events');
  ok(ICON_PATHS[KILL_KEY_ICONS.mortarHE], 'kill feed glyph');

  // The drawn tube's muzzle is the server's.
  const view = new VehicleView();
  view.sync([mortar], [], null);
  view.update(1 / 60, null);
  const rendered = view.mountWorldPose(mortar.id, 'operator:tube');
  ok(rendered && flat(rendered.origin, expected.origin) < 0.15 && Math.abs(rendered.origin[1] - expected.origin[1]) < 0.15, 'model muzzle at mountPose');
  ok(rendered.dir.reduce((sum, n, i) => sum + n * expected.dir[i], 0) > 0.995, 'model tube along the aim');
  view.dispose();
  void VehicleCamera;
}

// ------------------------------------------------------ bots, Frontier --
{
  Math.random = mulberry32(11);
  const meta = getMapMeta('frontier'), world = createMapState('frontier');
  const events = [];
  const game = new GameEngine({ mode: 'conquest', world, mapMeta: meta, broadcast: snap => events.push(...(snap.events ?? [])) });
  game.vehicles.vehicles.clear();
  const bots = attachBots(game, 1);
  const policy = game.mode.policy;
  const bot = game.entities.get(bots.brains[0].id);
  policy.setLobbyTeam(bot, 'alpha');
  game.addClient('foe', 'FOE');
  const foe = game.entities.get('foe');
  policy.setLobbyTeam(foe, 'bravo');
  // A fire mission is a cluster (MORTAR_BOT_RULES.minCluster): a second spotted enemy beside the first.
  game.addClient('foe2', 'FOE2');
  const foe2 = game.entities.get('foe2');
  policy.setLobbyTeam(foe2, 'bravo');
  for (let i = 0; i < 3; i++) game.step(TICK_MS);
  const C = meta.conquest.flags.find(fl => fl.id === 'C');
  // A firing spot 160..220 m from C, out of sight of it (bot sight 120 m), on any spawn of the map.
  const spawns = [...meta.conquest.flags.flatMap(fl => fl.spawns), ...Object.values(meta.conquest.bases).flatMap(b => b.spawns ?? [])];
  const spot = spawns.find(sp => { const d = Math.hypot(sp.x - C.x, sp.z - C.z); return d >= 160 && d <= 220; });
  ok(spot, 'a firing spot behind the line');
  policy.roles.applyLoadout(bot, 'support', 0, 1);
  ok(bots.mortarBots.carriesMortar(bot), 'the bot carries the mortar');
  const target = C.spawns[0];
  Object.assign(foe, { x: target.x, y: target.y, z: target.z, hp: 100000, maxHp: 100000, spawnProtectedUntil: 0, input: { keys: {}, yaw: 0, pitch: 0 } });
  const beside = { x: target.x + 3, y: target.y, z: target.z };
  Object.assign(foe2, { ...beside, hp: 100000, maxHp: 100000, spawnProtectedUntil: 0, input: { keys: {}, yaw: 0, pitch: 0 } });
  // An own soldier holds out on C, 22 m from the enemies, so the flag stays fought over (contested).
  game.addClient('mate', 'MATE');
  const mate = game.entities.get('mate');
  policy.setLobbyTeam(mate, 'alpha');
  const holdout = C.spawns.find(sp => Math.hypot(sp.x - target.x, sp.z - target.z) > 20 && Math.hypot(sp.x - C.x, sp.z - C.z) < C.radius - 4);
  const hold = () => Object.assign(mate, { x: holdout.x, y: holdout.y, z: holdout.z, hp: 100000, maxHp: 100000, spawnProtectedUntil: 0, input: { keys: {}, yaw: 0, pitch: 0 } });
  hold();
  const markFoes = () => { for (const p of [foe, foe2]) policy.roles.spotting.markPlayer(p, { team: 'alpha', until: game.now + 60_000 }); };
  const place = () => Object.assign(bot, { x: spot.x, y: spot.y, z: spot.z, vx: 0, vy: 0, vz: 0, spawnProtectedUntil: 0,
    yaw: Math.atan2(-(target.x - spot.x), -(target.z - spot.z)) });
  place();
  let placedAt = null;
  // One spotted enemy alone is no cluster: no mission.
  game.step(TICK_MS);
  policy.roles.spotting.markPlayer(foe, { team: 'alpha', until: game.now + 60_000 });
  Object.assign(foe2, { x: 5, z: 5 });
  game.step(TICK_MS);
  eq(bots.mortarBots.mission(spot, 'alpha'), null, 'a lone spotted enemy is no fire mission');
  Object.assign(foe2, beside);
  markFoes();
  for (let i = 0; i < 4; i++) game.step(TICK_MS);
  const mission = bots.mortarBots.mission(spot, 'alpha');
  ok(mission?.count === 2, 'two spotted enemies on the flag: a fire mission');
  // Behind the line only: the same cluster from the enemy side of it (mirrored through C) is no mission.
  const ahead = { x: 2 * C.x - spot.x, y: spot.y, z: 2 * C.z - spot.z };
  eq(bots.mortarBots.mission(ahead, 'alpha'), null, 'no mission from in front of the target');
  ok(bots.mortarBots.mission(ahead, 'bravo') === null && bots.mortarBots.mission(spot, 'bravo') === null, 'own soldiers are no mission');
  // A human squad leader's order binds the bot: it shells only the ordered flag (bot-commander `human` orders).
  ok(bots.mortarBots.mission(spot, 'alpha', game.now, 'C')?.count === 2, 'a human order on C keeps the mission on C');
  eq(bots.mortarBots.mission(spot, 'alpha', game.now, 'A'), null, 'a human order on another flag leaves no mission');
  {
    const ordered = order => Object.assign(Object.create(bots.mortarBots), { bots: { commander: { teams: new Map([['alpha',
      { memberSquad: new Map([[String(bot.id), { order }]]) }]]) } } });
    eq(ordered({ human: true, flagId: 'B', stance: 'attack' }).humanOrderFlag(bot), 'B', 'a human order names its flag');
    eq(ordered({ human: false, flagId: 'B', stance: 'attack' }).humanOrderFlag(bot), null, 'a commander order does not bind the tube');
  }
  for (let i = 0; i < 60 * 40 && !placedAt; i++) {
    markFoes();
    if (!bot.vehicleId) place();
    game.step(TICK_MS);
    if (bot.vehicleId && game.vehicles.vehicles.get(bot.vehicleId)?.type === 'mortar') placedAt = i;
  }
  ok(placedAt != null, 'the bot places its mortar for the fire mission');
  const hp0 = foe.hp;
  let landed = [];
  for (let i = 0; i < 60 * 45; i++) {
    markFoes();
    hold();
    Object.assign(foe, { x: target.x, y: target.y, z: target.z });
    Object.assign(foe2, beside);
    game.step(TICK_MS);
  }
  landed = events.filter(e => e.kind === 'projectileExplode' && e.vehicleWeapon === 'mortarHE');
  ok(landed.length >= 3, `the bot fires (${landed.length} rounds)`);
  const misses = landed.map(e => Math.hypot(e.x - target.x, e.z - target.z));
  ok(Math.min(...misses) < MORTAR_BOT_RULES.spreadStart + 4, `rounds walk in (closest ${Math.min(...misses).toFixed(1)} m)`);
  ok(foe.hp < hp0, 'the target takes damage');
  // Once the mission dries up (the target gone), the bot leaves the tube for the rest of its brain.
  Object.assign(foe, { x: 5, z: 5 });
  Object.assign(foe2, { x: 7, z: 5 });
  policy.roles.spotting.players.clear();
  for (let i = 0; i < 60 * ((MORTAR_BOT_RULES.idleExitMs + MORTAR_BOT_RULES.retargetMs) / 1000 + 2) && bot.vehicleId; i++) game.step(TICK_MS);
  ok(!bot.vehicleId, 'the bot gets out when there is nothing left to shell');
}

console.log(`Conquest mortar: ${checks} checks passed.`);
