// Rocket artillery truck (shared/artillery-rules.js, hull `artillery`): the
// contract and defs, the truck's own drive numbers, the stowed pod raising
// before it fires, HE rockets landing on the laid target, the store swap
// costing a full reload, the cluster carrier bursting into bomblets over the
// target, and the client's indirect-fire controls and sight read model.
//
//   node tools/conquest-artillery-test.mjs
import assert from 'node:assert/strict';
import { GameEngine } from '../server/game.js';
import { TICK_MS } from '../server/protocol/admission.js';
import { CONQUEST_CONTRACT_VERSION, VEHICLE_TOPOLOGY, VEHICLE_TYPE_IDS, VEHICLE_WEAPON_META, seatWeaponList, vehicleHullType } from '../shared/conquest-contract.js';
import { VEHICLE_DEFS, VEHICLE_WEAPONS } from '../shared/vehicle-defs.js';
import { ARTILLERY_RULES, indirectFireRules, artilleryTargetRefusal, artilleryFlatImpact } from '../shared/artillery-rules.js';
import { IRON_BRIDGE_RULES } from '../shared/conquest-bridge.js';
import { DEPOT_SUPPORT_DAMAGE, DEPOT_SERVICE_TYPES } from '../shared/map-events/depot.js';
import { fireMountedRay } from '../server/sim/combat.js';
import { MORTAR_RULES, mortarAim, mortarFlatRange, mortarRangeEnvelope } from '../shared/mortar-rules.js';
import { stepJeepDrive, JEEP_RULES } from '../shared/vehicle-handling/jeep.js';
import { bombletVelocities, bombletFallSeconds } from '../server/sim/cluster-fuse.js';
import { mortarSightModel } from '../public/js/ui/conquest/mortar-sight.js';

let checks = 0;
const ok = (value, message) => { assert.ok(value, message); checks++; };
const eq = (a, b, message) => { assert.deepEqual(a, b, message); checks++; };
const flat = (a, b) => Math.hypot(a[0] - b[0], a[2] - b[2]);

// ------------------------------------------------------------ contract --
eq(CONQUEST_CONTRACT_VERSION, 9, 'contract v9 adds the rocket truck');
eq(VEHICLE_TYPE_IDS.at(-1), 'artillery', 'appended to the pad roster');
eq(vehicleHullType('artillery'), 'jeep', 'rides the jeep gear');
eq(VEHICLE_TOPOLOGY.artillery.map(s => [s.id, s.role, s.drives, s.exposed]),
  [['driver', 'driver', true, false], ['launcher', 'gunner', false, false], ['top-gunner', 'gunner', false, true]]);
eq(seatWeaponList('artillery', 'launcher').map(w => w.weapon), ['artyRocket', 'artyCluster']);
eq([VEHICLE_WEAPON_META.artyRocket.speed, VEHICLE_WEAPON_META.artyRocket.gravity],
  [VEHICLE_WEAPON_META.artyCluster.speed, VEHICLE_WEAPON_META.artyCluster.gravity], 'both stores fly one arc');
const def = VEHICLE_DEFS.artillery;
ok(def.handling === 'wheeled' && def.hp === 520 && !def.openCrew && def.mounts.pod.stow === true, 'a closed wheeled hull with a stowing pod');
ok(indirectFireRules('artillery', 'launcher') === ARTILLERY_RULES && !indirectFireRules('artillery', 'driver')
  && indirectFireRules('mortar', 'operator').minPitch === MORTAR_RULES.minPitch, 'indirect-fire seats');
{
  const band = mortarRangeEnvelope(ARTILLERY_RULES);
  ok(band.min > 120 && band.min < 150 && band.max > 390 && band.max < 410, `range band ${band.min.toFixed(0)}..${band.max.toFixed(0)} m`);
}

// ---------------------------------------------------------------- drive --
{
  const truck = { speed: 0, yaw: 0 }, jeep = { speed: 0, yaw: 0 };
  for (let i = 0; i < 20 * 30; i++) { stepJeepDrive(truck, { throttle: 1 }, 1 / 30, null, def.rules); stepJeepDrive(jeep, { throttle: 1 }, 1 / 30); }
  ok(Math.abs(truck.speed - def.rules.speed) < 0.01 && Math.abs(jeep.speed - JEEP_RULES.speed) < 0.01 && truck.speed < jeep.speed,
    `the truck tops out at ${truck.speed.toFixed(1)} m/s, under the jeep`);
}

// -------------------------------------------------------------- cluster --
{
  const c = VEHICLE_WEAPONS.artyCluster.cluster, g = VEHICLE_WEAPONS.artyBomblet.gravity;
  const fall = bombletFallSeconds(c.height, c.sink, g), carrier = [35, -45, 0];
  const out = bombletVelocities(carrier, c.height, c, g);
  eq(out.length, c.count);
  // The pattern's centre lands where the carrier was heading.
  const cx = out.reduce((sum, v) => sum + v[0], 0) / out.length * fall, expected = carrier[0] * c.height / -carrier[1];
  ok(Math.abs(cx - expected) < 3, `pattern centre ${cx.toFixed(1)} m ahead, carrier impact ${expected.toFixed(1)} m`);
  const reach = Math.max(...out.map(v => Math.hypot(v[0] * fall - expected, v[2] * fall)));
  ok(reach > 10 && reach < 22, `bomblets cover ${reach.toFixed(1)} m around it`);
}

// ---------------------------------------------------------- server rig --
const frames = [], dimensions = { sx: 768, sy: 96, sz: 768 };
const world = { dimensions, getBlock: (x, y, z) => y === 0 ? 3 : 0, setBlock() { return true; }, findSpawns: () => [{ x: 20, y: 1, z: 20 }] };
const game = new GameEngine({ mode: 'conquest', world, broadcast: frame => frames.push(frame),
  mapMeta: { id: 'frontier', dimensions, spawns: { conquest: { alpha: [{ x: 20, y: 1, z: 20 }], bravo: [{ x: 30, y: 1, z: 20 }] } },
    conquest: { flags: [], bases: {}, vehicleSpawns: [{ id: 'truck', type: 'artillery', team: 'alpha', x: 380.5, y: 1, z: 600.5, yaw: 0 }] } } });
const join = (id, team, at) => {
  game.addClient(id, id);
  const p = game.entities.get(id);
  game.mode.policy.setLobbyTeam(p, team);
  Object.assign(p, { x: at[0], y: at[1], z: at[2], yaw: 0, grounded: true, hp: 100, armor: 0, spawnProtectedUntil: 0, input: { keys: {}, yaw: 0, pitch: 0 } });
  return p;
};
const step = (n = 1) => { for (let i = 0; i < n; i++) game.step(TICK_MS); };
const events = () => frames.flatMap(f => f.events || []);
const vehicles = game.vehicles;
const op = join('op', 'alpha', [380.5, 1, 603]);
step();
const truck = [...vehicles.vehicles.values()].find(v => v.type === 'artillery');
ok(truck, 'the truck stands on its pad');
const pod = () => vehicles.mounts.state(truck, 'pod');
ok(Math.abs(pod().pitch) < 0.01, 'unmanned: the pod lies flat');
ok(vehicles.enter(op, truck.id, 'launcher'), 'the operator takes the launcher seat');
const target = [380.5, 1, 600.5 - 260];
const aim = mortarAim(truck, def.mounts.pod, target, ARTILLERY_RULES);
ok(Number.isFinite(aim.pitch) && aim.pitch >= ARTILLERY_RULES.minPitch && aim.pitch <= ARTILLERY_RULES.maxPitch, 'a 260 m target is inside the band');
op.input = { keys: {}, yaw: aim.yaw, pitch: aim.pitch, wantFire: true };
step(2);
ok(pod().ammo === 6 && pod().pitch < ARTILLERY_RULES.minPitch, 'no rocket leaves the pod while it is still raising');
const launches = () => events().filter(e => e.kind === 'projectileLaunch' && e.vehicleWeapon === 'artyRocket').length;
const waitFor = (test, ticks) => { for (let i = 0; i < ticks && !test(); i++) step(); return test(); };
ok(waitFor(() => launches() >= 1, 400), 'raised and laid: the first rocket goes');
ok(Math.abs(pod().pitch - aim.pitch) < 0.02, 'the pod is on the laid elevation');
op.input.wantFire = false;
ok(waitFor(() => events().some(e => e.kind === 'projectileExplode' && e.vehicleWeapon === 'artyRocket'), 900), 'the rocket lands');
{
  const hit = events().find(e => e.kind === 'projectileExplode' && e.vehicleWeapon === 'artyRocket');
  const miss = flat([hit.x, hit.y, hit.z], target);
  ok(miss < 12, `the rocket lands ${miss.toFixed(1)} m from the laid target`);
}

// Swapping to the cluster carrier empties the pod for the carrier's full reload.
ok(vehicles.action(op, { type: 'weapon', index: 1 }), 'the cluster carrier is selected');
ok(pod().weapon === 'artyCluster' && pod().ammo === 0 && Math.abs(pod().reloadT - VEHICLE_WEAPONS.artyCluster.reloadSeconds) < 1e-6, 'the swap is a full reload');
op.input.wantFire = true;
step(120);
ok(!events().some(e => e.kind === 'projectileLaunch' && e.vehicleWeapon === 'artyCluster'), 'nothing fires during the swap');
ok(waitFor(() => events().some(e => e.kind === 'projectileLaunch' && e.vehicleWeapon === 'artyCluster'), Math.ceil(23000 / TICK_MS)), 'the carrier goes once it is loaded');
op.input.wantFire = false;
ok(waitFor(() => events().some(e => e.kind === 'projectileExplode' && e.vehicleWeapon === 'artyCluster'), 900), 'the carrier opens');
{
  const burst = events().find(e => e.kind === 'projectileExplode' && e.vehicleWeapon === 'artyCluster');
  const c = VEHICLE_WEAPONS.artyCluster.cluster;
  ok(burst.burst === 1 && burst.y > 1 + c.height * 0.5 && burst.y <= 1 + c.height + 6, `it bursts ${(burst.y - 1).toFixed(1)} m over the ground`);
  eq(events().filter(e => e.kind === 'projectileLaunch' && e.vehicleWeapon === 'artyBomblet').length, c.count, 'every bomblet is thrown');
  step(240);
  const blasts = events().filter(e => e.kind === 'projectileExplode' && e.vehicleWeapon === 'artyBomblet');
  eq(blasts.length, c.count, 'every bomblet goes off on the ground');
  const far = Math.max(...blasts.map(e => flat([e.x, e.y, e.z], target)));
  ok(far < 35, `the pattern lies within ${far.toFixed(1)} m of the laid target`);
  const spread = Math.max(...blasts.map(a => Math.max(...blasts.map(b => flat([a.x, 0, a.z], [b.x, 0, b.z])))));
  ok(spread > 12, `and is ${spread.toFixed(1)} m across`);
}

// ------------------------------------------- hatch gunner, HQ, structures --
{
  // The exposed hatch gunner's body rises above the cab roof: a .50 from the side hits him, not the hull.
  const gunner = join('g', 'alpha', [380.5, 1, 604]), shooter = join('x', 'bravo', [360.5, 1, 600.5]);
  ok(vehicles.enter(gunner, truck.id, 'top-gunner'), 'the hatch gunner boards');
  step();
  const head = [gunner.x, truck.y + def.height + 0.25, gunner.z], from = [truck.x - 20, head[1] + 2, gunner.z];
  const d = head.map((n, i) => n - from[i]), l = Math.hypot(...d);
  const shot = fireMountedRay(shooter, from, d.map(n => n / l), VEHICLE_WEAPONS.hmg, vehicles.combatContext());
  ok(gunner.hp < 100, `the hatch gunner is hit above the armour (hp ${gunner.hp.toFixed(0)}, ${JSON.stringify(shot?.hit ?? null).slice(0, 60)})`);
  // No fire into an HQ circle; structure tables know the stores.
  const meta = { bases: { bravo: { x: 100, z: 100, radius: 56 } } };
  eq([artilleryTargetRefusal(meta, 100, 100 + 56 + ARTILLERY_RULES.hqPad - 1), artilleryTargetRefusal(meta, 100, 100 + 56 + ARTILLERY_RULES.hqPad + 1)], ['hq', null]);
  const flatImpact = artilleryFlatImpact([0, 0, 0], 0, Math.PI / 4);
  ok(Math.abs(flatImpact[1] + mortarFlatRange(Math.PI / 4, ARTILLERY_RULES)) < 1e-6 && Math.abs(flatImpact[0]) < 1e-9, 'the gate aims where the sight does');
  for (const key of ['artyRocket', 'artyCluster', 'artyBomblet']) ok(IRON_BRIDGE_RULES.supportDamage[key] > 0 && DEPOT_SUPPORT_DAMAGE[key] > 0, `${key} wears structures`);
  ok(DEPOT_SERVICE_TYPES.includes('artillery'), 'the depots service the truck');
}

// ------------------------------------------------------- client sight --
{
  const row = vehicles.row(truck, vehicles.nowMs());
  const seated = { row, seat: def.seats.find(s => s.id === 'launcher') };
  const model = mortarSightModel(seated, {});
  ok(model && model.title === 'ROCKET FIRE-CONTROL' && model.icon === 'artillery' && model.weaponLabel === 'CLUSTER', 'the launcher seat gets the fire-control sight');
  ok(Math.abs(model.range - mortarFlatRange(pod().pitch, ARTILLERY_RULES)) < 6 && model.envelope.max > 390, `sight range ${model.range} m`);
  ok(model.blastRadius > 12 && model.rounds.magazine === 1, 'the cluster store shows its footprint and one round');
  eq(mortarSightModel({ row, seat: def.seats.find(s => s.id === 'driver') }, {}), null, 'no sight for the driver');
}

console.log(`conquest-artillery-test: ${checks} checks passed`);
