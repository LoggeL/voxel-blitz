// Conquest Recon gadgets (docs/conquest.md "Recon gadgets"): the SPAWN BEACON
// (placement, one per Recon, squad deploys with cooldown and enemy refusals,
// kit change and leave cleanup, bullet destruction and awards) and the MOTION
// SENSOR (throw and settle, speed/stance detection, the per-owner cap, expiry,
// blast destruction, kill assist), the wire codec and the bots, through the
// real GameEngine tick.
import assert from 'node:assert/strict';
import { GameEngine } from '../server/game.js';
import { TICK_MS } from '../server/protocol/admission.js';
import { CONQUEST_CONTRACT_VERSION, CONQUEST_EVENT_KINDS, CONQUEST_RULES, KITS, SCORE_POINTS } from '../shared/conquest-contract.js';
import { KIT_GADGET_LABELS, kitLoadout } from '../shared/conquest-kits.js';
import { decodeConquestMatch, deployOptions, deployViewFromSnapshot, parseSpawnChoice } from '../shared/conquest.js';
import { GRENADE_TYPES, GRENADE_TYPE_IDS, FREE_GRENADE_TYPE_IDS, grenadeLaunch } from '../shared/grenade-rules.js';
import {
  RECON_GADGET_RULES, beaconRestricted, decodeReconGadgets, encodeReconGadgets, placeBeacon, rayReconGadget, sensorDetects,
} from '../shared/recon-gadgets.js';
import { attachBots } from '../server/bots.js';
import { AimSteering } from '../server/bot-aim.js';
import * as THREE from '../public/js/vendor/three.module.js';
import { ProjectileFX } from '../public/js/weapons/projectiles.js';
import { ReconGadgetView } from '../public/js/engine/recon-gadget-view.js';
import { GRENADE_HUD_ICONS, THROWABLE_NAMES } from '../public/js/ui/hud-support.js';
import { grenadeRoleLine } from '../public/js/ui/grenade-pouch.js';
import { ICON_PATHS } from '../public/js/ui/conquest/icons.js';
import { deployModel, kitCards, mapItems, readConquest, reconGadgetBanner } from '../public/js/ui/conquest-hud-state.js';

const BEACON = GRENADE_TYPE_IDS.indexOf('beacon');
const SENSOR = GRENADE_TYPE_IDS.indexOf('sensor');
const B = RECON_GADGET_RULES.beacon, S = RECON_GADGET_RULES.sensor;

// ---------------------------------------------------------------- rules, kit and codec
{
  assert.equal(CONQUEST_CONTRACT_VERSION, 7);
  assert.equal(CONQUEST_EVENT_KINDS[CONQUEST_EVENT_KINDS.indexOf('comm_answer') + 1], 'recon_gadget', 'recon_gadget is appended after the orders kinds');
  assert.deepEqual(GRENADE_TYPE_IDS.slice(-2), ['beacon', 'sensor'], 'the gadget pouch types are appended');
  assert.ok(!FREE_GRENADE_TYPE_IDS.includes('beacon') && !FREE_GRENADE_TYPE_IDS.includes('sensor'), 'kit-only types');
  assert.deepEqual(KITS.recon.gadgets, ['beacon', 'sensor']);
  assert.equal(KIT_GADGET_LABELS.beacon.name, 'SPAWN BEACON');
  assert.equal(KIT_GADGET_LABELS.sensor.name, 'MOTION SENSOR');
  const beaconKit = kitLoadout('recon', 0, 0), sensorKit = kitLoadout('recon', 0, 1);
  assert.equal(beaconKit.grenades[BEACON], 1, 'gadget 0: one beacon');
  assert.equal(beaconKit.grenades[SENSOR], 0);
  assert.equal(sensorKit.grenades[SENSOR], 2, 'gadget 1: two sensors');
  assert.equal(sensorKit.grenades[BEACON], 0);
  assert.equal(kitLoadout('assault', 0, 0).grenades[BEACON], 0, 'no beacons outside the Recon');
  assert.deepEqual(parseSpawnChoice('beacon:rb7'), { kind: 'beacon', id: 'rb7' });
  assert.equal(parseSpawnChoice('beacon:'), null);

  // Placement: floor under the aim, else nothing; the antenna needs headroom.
  const floor = (_x, y) => y < 2;
  const spot = placeBeacon({ x: 10.5, eyeY: 3.6, z: 10.5, dir: { x: 0, y: -0.8, z: -0.6 } }, floor);
  assert.ok(spot && spot.y === 2 && spot.mount[1] === 1, 'laid on the floor voxel');
  assert.equal(placeBeacon({ x: 10.5, eyeY: 3.6, z: 10.5, dir: { x: 0, y: -0.8, z: -0.6 } }, () => false), null, 'no floor, no beacon');
  const roofed = (x, y, z) => y < 2 || y === 3;
  assert.equal(placeBeacon({ x: 10.5, eyeY: 2.9, z: 10.5, dir: { x: 0, y: -0.8, z: -0.6 } }, roofed), null, 'no headroom, no beacon');
  assert.equal(grenadeLaunch({ x: 10.5, y: 2, z: 10.5, eyeY: 3.6, dir: { x: 0, y: -0.8, z: -0.6 }, type: 'beacon', solidAt: floor }).type, 'beacon',
    'the client placement preview uses the same rule');

  // Shot box.
  const gadget = { kind: 'beacon', x: 0, y: 0, z: 0 };
  assert.ok(Math.abs(rayReconGadget(gadget, [0, B.centerY, 5], { x: 0, y: 0, z: -1 }, 50) - (5 - B.half[2])) < 1e-9, 'ray enters the box face');
  assert.equal(rayReconGadget(gadget, [1, B.centerY, 5], [0, 0, -1], 50), null, 'a ray beside it misses');

  // Detection: walk speed and above, not a crouch walk or a prone crawl, inside the radius and height band.
  const sensor = { x: 0, y: 2, z: 0 };
  const body = (extra = {}) => ({ x: 10, y: 2, z: 0, proneT: 0, ...extra });
  assert.ok(sensorDetects(sensor, body(), 4.4), 'a walk is sensed');
  assert.ok(!sensorDetects(sensor, body(), 2.2), 'a crouch walk is not');
  assert.ok(!sensorDetects(sensor, body({ proneT: 1 }), 6), 'prone is never sensed');
  assert.ok(!sensorDetects(sensor, body({ x: S.radius + 1 }), 6), 'outside the radius');
  assert.ok(!sensorDetects(sensor, body({ y: 2 + S.dy + 1 }), 6), 'outside the height band');

  // Codec.
  const wire = encodeReconGadgets({
    beacons: [{ id: 'rb1', ownerId: 'p1', team: 'alpha', x: 1.234, y: 2, z: 3, hp: 50, cooldownMs: 4100, spottedBy: 'bravo' }],
    sensors: [{ id: 'rs2', ownerId: 'p1', team: 'alpha', x: 4, y: 2, z: 5, leftMs: 19950 }],
    sensed: { alpha: ['p2'], bravo: [] } });
  assert.deepEqual(wire, { b: [['rb1', 'p1', 0, 1.23, 2, 3, 50, 41, 1]], s: [['rs2', 'p1', 0, 4, 2, 5, 200]], m: [['p2'], []] });
  const back = decodeReconGadgets(wire);
  assert.equal(back.beacons[0].team, 'alpha'); assert.equal(back.beacons[0].hp, 50); assert.equal(back.beacons[0].cooldownMs, 4100);
  assert.equal(back.beacons[0].spottedBy, 'bravo');
  assert.equal(back.sensors[0].leftMs, 20000);
  assert.deepEqual(back.sensed, { alpha: ['p2'], bravo: [] });
  assert.equal(encodeReconGadgets({}), null, 'nothing to send: omitted');
  assert.deepEqual(decodeReconGadgets(undefined), { beacons: [], sensors: [], sensed: { alpha: [], bravo: [] } });
}

// ---------------------------------------------------------------- engine fixture
const SX = 200, SY = 32, SZ = 160;
const spot = (x, z) => ({ x: x + 0.5, y: 2, z: z + 0.5 });
const ring = (x, z) => Array.from({ length: 12 }, (_, i) => spot(x + Math.round(Math.cos(i * Math.PI / 6) * 6), z + Math.round(Math.sin(i * Math.PI / 6) * 6)));
const flagRow = (id, x, z, home) => ({ id, name: id, ...spot(x, z), radius: 10, home, spawns: ring(x, z) });

function fixture({ walls = [] } = {}) {
  const hq = (team, x) => ({ id: team, name: team, ...spot(x, 80), radius: 12, spawns: [spot(x, 74), spot(x, 77), spot(x, 80), spot(x, 83), spot(x, 86)] });
  const bases = { alpha: hq('alpha', 8), bravo: hq('bravo', SX - 9) };
  const mapMeta = { id: 'frontier', dimensions: { sx: SX, sy: SY, sz: SZ }, spawns: { conquest: { alpha: bases.alpha.spawns, bravo: bases.bravo.spawns } },
    conquest: { version: 2, bases, combatArea: { minX: 2, maxX: SX - 2, minZ: 2, maxZ: SZ - 2 }, vehicleSpawns: [],
      flags: [flagRow('A', 50, 40, 'alpha'), flagRow('B', 50, 120, 'alpha'), flagRow('C', 100, 80, null), flagRow('D', 150, 40, 'bravo'), flagRow('E', 150, 120, 'bravo')] } };
  const removed = new Set();
  const solid = (x, y, z) => x < 0 || z < 0 || x >= SX || z >= SZ || (y < 2 && !removed.has(`${x},${y},${z}`))
    || walls.some(w => x >= w.x0 && x <= w.x1 && z >= w.z0 && z <= w.z1 && y >= 2 && y <= (w.top ?? 6));
  const world = { dimensions: { sx: SX, sy: SY, sz: SZ }, getBlock: (x, y, z) => (solid(x, y, z) ? 1 : 0),
    findSpawns: () => [spot(20, 20)], setBlock: (x, y, z, v) => { if (!v) removed.add(`${x},${y},${z}`); else removed.delete(`${x},${y},${z}`); return true; } };
  const events = [];
  const game = new GameEngine({ mode: 'conquest', mapMeta, world,
    broadcast: snap => { events.push(...snap.events); game.lastSnapshot = snap; } });
  const policy = game.mode.policy;
  const run = ms => { for (let t = 0; t < ms - 1e-6; t += TICK_MS) game.step(TICK_MS); };
  const human = id => { game.addClient(id, id); return game.entities.get(id); };
  const place = (p, x, z, yaw = 0) => Object.assign(p, { x: x + 0.5, y: 2, z: z + 0.5, vx: 0, vy: 0, vz: 0, yaw, pitch: 0,
    spawnProtectedUntil: 0, spawnProtected: false });
  const recon = (p, gadget) => { policy.roles.applyLoadout(p, 'recon', 0, gadget); policy.reconGadgets.onLoadout(p, 'recon', gadget); };
  const throwOne = (p, index, aim, charge = 0) => game.projectiles.throw(p, game.contexts.projectiles, charge, index, 0, aim);
  const intent = (p, spawn, kit = 'assault', gadget = 0) => game.mode.conquestIntent(p, { type: 'deploy', spawn, kit, variant: 0, gadget });
  const refusals = id => events.filter(e => e.kind === 'deploy_refused' && e.id === id).map(e => e.reason);
  const recon_events = (state, gadget) => events.filter(e => e.kind === 'recon_gadget' && (!state || e.state === state) && (!gadget || e.gadget === gadget));
  const scores = (id, reason) => events.filter(e => e.kind === 'score' && e.id === id && e.reason === reason);
  const wire = () => game.lastSnapshot?.match?.conquest?.recon ?? null;
  return { game, events, policy, run, human, place, recon, throwOne, intent, refusals, recon_events, scores, wire, world, removed };
}

// ---------------------------------------------------------------- spawn beacon
{
  const f = fixture();
  const { game, policy, run } = f;
  const r = f.human('p1_a'), b = f.human('p2_b'), mate = f.human('p3_a'), b2 = f.human('p4_b'), mate2 = f.human('p5_a');
  run(TICK_MS);
  assert.equal(policy.phase, 'live');
  assert(policy.squads.areSquadmates(r.id, mate.id), 'recon and mate share a squad');
  for (const [p, x, z] of [[b, SX - 6, 70], [b2, SX - 6, 74], [mate, 6, 90], [mate2, 6, 94]]) f.place(p, x, z);
  f.place(r, 60, 80, 0);
  f.recon(r, 0);
  assert.equal(r.grenades[BEACON], 1);
  // Outside the live phase the beacon is refused and nothing is spent.
  policy.phase = 'post';
  assert.equal(f.throwOne(r, BEACON, { yaw: 0, pitch: -0.95 }), null);
  policy.phase = 'live';
  assert.equal(r.grenades[BEACON], 1, 'a refused beacon is not spent');
  const beacon = f.throwOne(r, BEACON, { yaw: 0, pitch: -0.95 });
  assert.ok(beacon && beacon.ownerId === r.id && beacon.team === 'alpha', 'beacon laid');
  assert.equal(r.grenades[BEACON], 0, 'the pouch beacon is spent');
  assert.ok(beacon.z < r.z && Math.abs(beacon.y - 2) < 1e-9, 'on the floor ahead of the Recon');
  run(TICK_MS);
  assert.equal(f.recon_events('placed', 'beacon').length, 1, 'recon_gadget placed event');
  const decoded = decodeConquestMatch(game.lastSnapshot.match.conquest);
  assert.deepEqual(decoded.recon.beacons.map(x => x.id), [beacon.id], 'match.conquest.recon carries the beacon');

  // Deploy options: the owner's squad only.
  const optionFor = p => policy.deploy.options(p).find(o => o.spawn === `beacon:${beacon.id}`);
  assert.ok(optionFor(mate)?.ok, 'a squad mate may spawn on it');
  assert.ok(!optionFor(b), 'enemies never see the option');
  const view = deployViewFromSnapshot(decoded, [...game.entities.values()].map(p => ({ id: p.id, team: p.team, state: p.state, x: p.x, z: p.z, squad: policy.squads.squadOf(p.id) })));
  assert.ok(deployOptions(view, { id: mate.id, team: 'alpha', squad: policy.squads.squadOf(mate.id) }).some(o => o.kind === 'beacon' && o.ok),
    'the client derives the same option from the snapshot');

  // A squad mate spawns beside it; the beacon owner is paid, the beacon cools down.
  game.killPlayer(mate, b, 'rifle', false);
  f.events.length = 0;
  assert.equal(f.intent(mate, `beacon:${beacon.id}`), true);
  run(CONQUEST_RULES.respawnMs + 100);
  assert.equal(mate.state, 'alive', 'deployed on the beacon');
  const d = Math.hypot(mate.x - beacon.x, mate.z - beacon.z);
  assert(d >= B.spawnMinRadius - 0.3 && d <= B.spawnMaxRadius + 0.6, `spawned beside the beacon (${d.toFixed(2)} m)`);
  assert.equal(mate.spawnProtected, false, 'no spawn protection on a forward spawn');
  assert.equal(f.scores(r.id, 'beacon_spawn').length, 1, 'beacon_spawn paid to the owner');
  assert.equal(f.scores(r.id, 'beacon_spawn')[0].pts, SCORE_POINTS.beacon_spawn);
  game.killPlayer(mate2, b, 'rifle', false);
  f.events.length = 0;
  assert.equal(f.intent(mate2, `beacon:${beacon.id}`), false, 'cooling down');
  run(TICK_MS);
  assert.deepEqual(f.refusals(mate2.id), ['cooldown']);
  run(B.spawnCooldownMs);
  // A living enemy within the block range shuts it.
  f.place(b2, 70, 74);
  f.events.length = 0;
  assert.equal(f.intent(mate2, `beacon:${beacon.id}`), false, 'an enemy near the beacon refuses the spawn');
  run(TICK_MS);
  assert.deepEqual(f.refusals(mate2.id), ['enemy']);
  f.place(b2, SX - 6, 74);
  assert.equal(f.intent(mate2, `beacon:${beacon.id}`), true, 'open again once the enemy left');

  // The beacon outlives its owner's death; a respawn on the sensor gadget takes it down.
  game.killPlayer(r, b, 'rifle', false);
  run(TICK_MS);
  assert.ok(policy.reconGadgets.beacon(beacon.id), 'lives through the owner dying');
  f.recon(r, 0);
  assert.ok(policy.reconGadgets.beacon(beacon.id), 'the same kit and gadget keep it');
  assert.equal(f.intent(r, 'hq', 'recon', 1), true);
  run(CONQUEST_RULES.respawnMs + 100);
  assert.equal(r.state, 'alive');
  assert.equal(r.grenades[SENSOR], 2, 'respawned on the sensor gadget');
  assert.equal(policy.reconGadgets.beacon(beacon.id), null, 'another gadget at respawn removes it');
  assert.equal(f.recon_events('removed', 'beacon').length, 1);

  // One per Recon: the second replaces the first.
  f.place(r, 60, 80, 0);
  f.recon(r, 0);
  const first = f.throwOne(r, BEACON, { yaw: 0, pitch: -0.95 });
  r.grenades[BEACON] = 1;
  r.nextThrowAt = 0;
  f.place(r, 64, 80, 0);
  const second = f.throwOne(r, BEACON, { yaw: 0, pitch: -0.95 });
  assert.ok(first && second && first.id !== second.id);
  assert.equal(policy.reconGadgets.beacon(first.id), null, 'the old beacon goes');
  assert.ok(policy.reconGadgets.beacon(second.id));

  // Enemy fire: bullets wear it down; the destroyer is paid gadget_destroyed.
  run(TICK_MS);
  f.events.length = 0;
  f.place(r, 30, 30);
  f.place(b, second.x - 0.5, second.z + 6);
  b.hp = 100;
  const eyeY = b.eyeY;
  const look = { yaw: Math.atan2(-(second.x - b.x), -(second.z - b.z)), pitch: Math.atan2(second.y + B.centerY - eyeY, Math.hypot(second.x - b.x, second.z - b.z)) };
  // The enemy can spot it: marked for its team in the snapshot.
  Object.assign(b, look);
  assert.equal(policy.roles.spotting.spot(b), second.id, 'an enemy beacon in the cone is spotted');
  run(TICK_MS);
  assert.equal(decodeConquestMatch(game.lastSnapshot.match.conquest).recon.beacons.find(x => x.id === second.id)?.spottedBy, 'bravo');
  for (let i = 0; i < 600 && policy.reconGadgets.beacon(second.id); i++) {
    Object.assign(b, { x: second.x, z: second.z + 6 });
    b.reserve[b.weapon] = 999;
    game.applyInput(b.id, { keys: {}, ...look, wantFire: i % 2 === 0 });
    game.step(TICK_MS);
  }
  game.applyInput(b.id, { keys: {}, ...look, wantFire: false });
  assert.equal(policy.reconGadgets.beacon(second.id), null, 'shot to pieces');
  const destroyed = f.recon_events('destroyed', 'beacon');
  assert.equal(destroyed.length, 1); assert.equal(destroyed[0].by, b.id);
  assert.equal(f.scores(b.id, 'gadget_destroyed').length, 1, 'gadget_destroyed paid');
  assert.equal(f.scores(b.id, 'gadget_destroyed')[0].pts, SCORE_POINTS.gadget_destroyed);

  // Never in an enemy HQ or outside the combat area (the restricted-zone timer would kill whoever deploys
  // there); the own HQ is fine. A refused beacon spends nothing and keeps the old one.
  const meta = policy.mapMeta.conquest;
  assert.equal(beaconRestricted({ x: SX - 9, z: 80 }, 'alpha', meta), 'hq', 'the enemy HQ is restricted');
  assert.equal(beaconRestricted({ x: 8.5, z: 80 }, 'alpha', meta), null, 'the own HQ is not');
  assert.equal(beaconRestricted({ x: 100, z: 1 }, 'alpha', meta), 'oob', 'outside the combat area');
  assert.equal(beaconRestricted({ x: 100, z: 80 }, 'alpha', null), null, 'no map metadata, no restriction');
  f.place(r, SX - 9, 80, 0);
  r.grenades[BEACON] = 1; r.nextThrowAt = 0;
  assert.equal(f.throwOne(r, BEACON, { yaw: 0, pitch: -0.95 }), null, 'no beacon inside the enemy HQ');
  assert.equal(r.grenades[BEACON], 1, 'the refused beacon is not spent');
  f.place(r, 100, 2, 0);
  assert.equal(f.throwOne(r, BEACON, { yaw: 0, pitch: -0.95 }), null, 'no beacon outside the combat area');
  assert.equal(r.grenades[BEACON], 1);
  r.grenades[BEACON] = 0;

  // Friendly fire never hurts it; the floor voxel blown away drops it; leaving removes it.
  assert.equal(r.state, 'alive');
  f.place(r, 60, 80, 0);
  r.grenades[BEACON] = 1; r.nextThrowAt = 0;
  const third = f.throwOne(r, BEACON, { yaw: 0, pitch: -0.95 });
  assert.equal(policy.reconGadgets.damage(third, 500, mate), false, 'friendly damage is ignored');
  assert.ok(policy.reconGadgets.beacon(third.id));
  f.removed.add(third.mount.join(','));
  run(TICK_MS);
  assert.equal(policy.reconGadgets.beacon(third.id), null, 'the floor went, the beacon went');
  f.removed.clear();
  r.grenades[BEACON] = 1; r.nextThrowAt = 0;
  const fourth = f.throwOne(r, BEACON, { yaw: 0, pitch: -0.95 });
  game.removeClient(r.id);
  run(TICK_MS);
  assert.equal(policy.reconGadgets.beacon(fourth.id), null, 'the owner leaving removes it');
  assert.equal(wire(), null);
  function wire() { return game.lastSnapshot?.match?.conquest?.recon ?? null; }
}

// ---------------------------------------------------------------- real blasts on a beacon
{
  // An enemy frag through the real projectile system (projectileExplode -> ReconGadgets._blast)
  // destroys the beacon and pays its thrower; an own-team frag leaves it standing.
  const f = fixture();
  const { game, policy, run } = f;
  const r = f.human('p1_a'), b = f.human('p2_b'), mate = f.human('p3_a');
  run(TICK_MS);
  f.place(r, 60, 80, 0); f.place(b, 120, 80); f.place(mate, 6, 90);
  f.recon(r, 0);
  const beacon = f.throwOne(r, BEACON, { yaw: 0, pitch: -0.95 });
  f.place(r, 30, 30);
  const FRAG = GRENADE_TYPE_IDS.indexOf('frag');
  // Dropped at the thrower's feet, `back` m from the beacon (inside the 7.5 m blast; past the 3.9 m crater at 5.5 m).
  const drop = (p, back) => { f.place(p, beacon.x - 0.5, beacon.z + back); p.grenades[FRAG] = 1; p.nextThrowAt = 0;
    return game.projectiles.throw(p, game.contexts.projectiles, 0, FRAG, 0, { yaw: 0, pitch: -1.55 }); };
  assert.ok(drop(mate, 5.5), 'own frag thrown');
  run(GRENADE_TYPES.frag.fuseMs + 300);
  assert.ok(f.events.some(e => e.kind === 'projectileExplode' && e.type === 'frag'), 'the own frag went off');
  assert.equal(policy.reconGadgets.beacon(beacon.id)?.hp, B.hp, 'an own-team blast never hurts it');
  f.place(mate, 6, 90);
  f.events.length = 0;
  assert.ok(drop(b, 2.5), 'enemy frag thrown');
  run(GRENADE_TYPES.frag.fuseMs + 300);
  assert.ok(f.events.some(e => e.kind === 'projectileExplode' && e.type === 'frag'), 'the frag went off');
  assert.equal(policy.reconGadgets.beacon(beacon.id), null, 'an enemy frag beside it destroys it');
  assert.equal(f.recon_events('destroyed', 'beacon')[0]?.by, b.id);
  assert.equal(f.scores(b.id, 'gadget_destroyed').length, 1, 'the thrower is paid');
}

// ---------------------------------------------------------------- motion sensor
{
  const f = fixture();
  const { game, policy, run } = f;
  const r = f.human('p1_a'), b = f.human('p2_b'), mate = f.human('p3_a'), b2 = f.human('p4_b');
  run(TICK_MS);
  f.place(r, 60, 80, 0); f.place(mate, 6, 90); f.place(b, SX - 6, 70); f.place(b2, SX - 6, 74);
  f.recon(r, 1);
  assert.equal(r.grenades[SENSOR], 2);
  const thrown = f.throwOne(r, SENSOR, { yaw: 0, pitch: 0.2 }, 0);
  assert.ok(thrown && thrown.type === 'sensor', 'thrown like a grenade');
  run(S.fuseMs + 100);
  const sensors = [...policy.reconGadgets.sensors.values()];
  assert.equal(sensors.length, 1, 'settled into a live sensor at its fuse');
  const sensor = sensors[0];
  assert.ok(Math.abs(sensor.y - 2) < 0.05, `rests on the floor (${sensor.y.toFixed(3)})`);
  // A fuse that runs out mid-air drops the sensor onto the floor below; the per-owner cap (2) then removes the oldest.
  assert.equal(policy.reconGadgets.deploySensor({ ownerId: r.id, x: sensor.x + 3, y: 9.5, z: sensor.z }), true);
  const dropped = [...policy.reconGadgets.sensors.values()].at(-1);
  assert.ok(Math.abs(dropped.y - 2) < 0.05, `a mid-air sensor drops onto the floor (${dropped.y.toFixed(3)})`);
  policy.reconGadgets.remove(dropped, 'removed');
  assert.equal(policy.reconGadgets.sensors.size, 1);
  assert.ok(!f.events.some(e => e.kind === 'explode' && e.type === 'sensor' && e.damage > 0), 'no damage from a sensor');
  assert.equal(f.wire().s.length, 1, 'match.conquest.recon carries the sensor');

  // Walk an enemy past it: revealed; a crouch walk and a prone crawl are not.
  const walk = (p, speed, ms, extra = {}) => {
    for (let t = 0; t < ms; t += TICK_MS) {
      Object.assign(p, { x: p.x + speed * TICK_MS / 1000, vx: 0, vz: 0, ...extra });
      game.step(TICK_MS);
    }
  };
  f.place(b, sensor.x - 12, sensor.z + 4);
  walk(b, 1.8, 1500);
  assert.ok(!policy.reconGadgets.isSensed(b, 'alpha'), 'a crouch-speed walk stays hidden');
  walk(b, 6, 1500, { proneT: 1 });
  assert.ok(!policy.reconGadgets.isSensed(b, 'alpha'), 'prone stays hidden');
  walk(b, 4.4, 600, { proneT: 0 });
  assert.ok(policy.reconGadgets.isSensed(b, 'alpha'), 'a walking enemy is revealed');
  assert.ok(f.wire().m[0].includes(b.id), 'alpha sees it in match.conquest.recon');
  assert.ok(!policy.reconGadgets.isSensed(mate, 'alpha'), 'own team is never sensed');
  // A teammate kills the revealed enemy: the sensor owner earns the assist.
  f.events.length = 0;
  game.killPlayer(b, mate, 'rifle', false);
  run(TICK_MS);
  assert.equal(f.scores(r.id, 'spot_assist').length, 1, 'sensor assist paid');
  // The reveal lapses once the body stops.
  f.place(b2, sensor.x + 8, sensor.z);
  walk(b2, 4.4, 600);
  assert.ok(policy.reconGadgets.isSensed(b2, 'alpha'));
  run(S.revealMs + 2 * S.scanMs);
  assert.ok(!policy.reconGadgets.isSensed(b2, 'alpha'), 'standing still: the reveal lapses');

  // Cap: a third live sensor removes the oldest.
  r.nextThrowAt = 0;
  f.throwOne(r, SENSOR, { yaw: 0, pitch: 0.2 }, 0);
  r.grenades[SENSOR] = 1; r.nextThrowAt = 0;
  f.throwOne(r, SENSOR, { yaw: Math.PI / 2, pitch: 0.2 }, 0);
  run(S.fuseMs + 100);
  assert.equal(policy.reconGadgets.sensors.size, S.maxPerOwner, 'at most two per owner');
  assert.ok(!policy.reconGadgets.sensors.has(sensor.id), 'the oldest went');

  // A blast destroys one; its thrower is paid.
  const target = [...policy.reconGadgets.sensors.values()][0];
  f.events.length = 0;
  game.tickEvents.push({ kind: 'projectileExplode', type: 'frag', id: b2.id, x: target.x, y: target.y + 0.3, z: target.z, radius: GRENADE_TYPES.frag.damageRadius });
  policy.reconGadgets.tick(policy.now);
  assert.ok(!policy.reconGadgets.sensors.has(target.id), 'a frag at its feet destroys it');
  run(TICK_MS);
  assert.equal(f.scores(b2.id, 'gadget_destroyed').length, 1);

  // Expiry.
  run(S.lifeMs + 200);
  assert.equal(policy.reconGadgets.sensors.size, 0, 'sensors expire after lifeMs');
  assert.ok(f.recon_events('expired', 'sensor').length >= 1);
}

// ---------------------------------------------------------------- bots
{
  const f = fixture();
  const { game, policy, run } = f;
  const bots = attachBots(game, 0);
  const r = f.human('bot-recon_a'), b = f.human('p2_b');
  r.bot = true;
  run(TICK_MS);
  f.place(r, 60, 80, Math.PI / 2); f.place(b, SX - 6, 70);
  r.grounded = true;
  f.recon(r, 0);
  const flag = { x: 100.5, y: 2, z: 80.5, radius: 10 };
  const attack = { kind: 'capture', stance: 'attack', target: flag };
  const think = (goal, now, brain = {}) => { const inp = { keys: {}, yaw: r.yaw, pitch: 0 }; return { used: bots.recon.use(brain, r, goal, inp, now), inp }; };
  assert.equal(think({ ...attack, target: { ...flag, x: 70.5 } }, 1000).used, null, 'too close to the flag for a beacon');
  f.place(b, 62, 90);
  assert.equal(think(attack, 1000).used, null, 'an enemy too close: no beacon');
  f.place(b, SX - 6, 70);
  const brain = {};
  const { used, inp } = think(attack, 1000, brain);
  assert.equal(used, 'beacon', 'an attacking Recon 40 m short of the flag lays its beacon');
  assert.equal(inp.grenadeType, BEACON);
  assert.equal(think(attack, 2000, brain).used, null, 'gadget checks are rate limited');
  // Inside the enemy HQ the bot never tries a beacon the authority would refuse.
  const hqPos = { x: r.x, z: r.z };
  f.place(r, SX - 9, 80, Math.PI / 2);
  assert.equal(think({ ...attack, target: { ...flag, x: SX - 60.5 } }, 1000, {}).used, null, 'no beacon attempt in the enemy HQ');
  f.place(r, Math.floor(hqPos.x), Math.floor(hqPos.z), Math.PI / 2);
  game.applyInput(r.id, inp);
  run(TICK_MS);
  game.applyInput(r.id, { keys: {}, yaw: r.yaw, pitch: 0 });
  assert.ok(policy.reconGadgets.beaconOf(r.id), 'the bot input lays a real beacon through the human throw path');

  // A sensor Recon near the flag throws one at it.
  f.recon(r, 1);
  r.nextThrowAt = 0;
  f.place(r, 76, 80, Math.PI / 2);
  const s = think(attack, 5000, {});
  assert.equal(s.used, 'sensor', 'a Recon 24 m from the flag throws a sensor at it');
  game.applyInput(r.id, s.inp);
  run(S.fuseMs + 200);
  game.applyInput(r.id, { keys: {}, yaw: r.yaw, pitch: 0 });
  const laid = [...policy.reconGadgets.sensors.values()].find(x => x.ownerId === r.id);
  assert.ok(laid, 'the sensor settled');
  assert.ok(Math.hypot(laid.x - flag.x, laid.z - flag.z) < S.radius * 0.5, `close to the flag (${Math.hypot(laid.x - flag.x, laid.z - flag.z).toFixed(1)} m)`);
  assert.equal(think(attack, 9000, {}).used, null, 'no second sensor on a watched flag');

  // An enemy bot with nobody to fight shoots the sensor it can see.
  const shooter = f.human('bot-gunner_b');
  shooter.bot = true;
  if (shooter.team !== 'bravo') policy.setLobbyTeam(shooter, 'bravo');
  run(TICK_MS);
  assert.equal(policy.teamFor(shooter), 'bravo');
  f.place(shooter, laid.x, laid.z + 15);
  const brainB = { aim: new AimSteering() };
  assert.equal(bots.recon.target(shooter)?.id, laid.id, 'the visible enemy sensor is the target');
  assert.equal(bots.recon.target(r), null, 'own gadgets are never targets');
  let destroyedBy = null;
  for (let i = 0; i < 600 && policy.reconGadgets.sensors.has(laid.id); i++) {
    Object.assign(shooter, { x: laid.x, z: laid.z + 15 });
    const inpB = { keys: {}, yaw: shooter.yaw, pitch: shooter.pitch };
    bots.recon.shoot(brainB, shooter, inpB, policy.now, TICK_MS / 1000, shooter.owned ?? [shooter.weapon], 20, 20);
    shooter.reserve[shooter.weapon] = 999;
    game.applyInput(shooter.id, inpB);
    game.step(TICK_MS);
    destroyedBy = f.recon_events('destroyed', 'sensor').at(-1)?.by ?? destroyedBy;
  }
  assert.ok(!policy.reconGadgets.sensors.has(laid.id), 'the bot shot the sensor');
  assert.equal(destroyedBy, shooter.id);
  bots.dispose?.();
}

// ---------------------------------------------------------------- client presentation
{
  const f = fixture();
  const { game, policy, run } = f;
  const r = f.human('p1_a'), b = f.human('p2_b'), mate = f.human('p3_a');
  run(TICK_MS);
  f.place(r, 60, 80, 0); f.place(b, 120, 80); f.place(mate, 50, 90);
  f.recon(r, 0);
  const beacon = f.throwOne(r, BEACON, { yaw: 0, pitch: -0.95 });
  r.grenades[SENSOR] = 1; r.nextThrowAt = 0;
  f.throwOne(r, SENSOR, { yaw: -Math.PI / 2, pitch: 0.1 }, 0.4);
  run(S.fuseMs + 300);
  const sensor = [...policy.reconGadgets.sensors.values()][0];
  assert.ok(sensor, 'a sensor settled');
  // An enemy walks inside the sensor's reach and gets revealed.
  for (let t = 0; t < 900; t += TICK_MS) { Object.assign(b, { x: sensor.x + 6 + t / 1000 * 4.4, z: sensor.z, vx: 0, vz: 0 }); game.step(TICK_MS); }
  assert.ok(policy.reconGadgets.isSensed(b, 'alpha'));
  const snap = game.lastSnapshot;
  const mapMeta = { dimensions: { sx: SX, sy: SY, sz: SZ }, conquest: game.mode.policy.mapMeta?.conquest ?? null };
  const cq = readConquest(snap.match, mapMeta);
  const players = snap.players;
  const row = id => players.find(p => String(p.id) === id);
  // Own team: the beacon (squad tone for the owner's squad), the sensor with its ring, the sensed enemy.
  const own = mapItems({ cq, self: row(mate.id), players, vehicles: [], selfTeam: 'alpha' });
  const ownBeacon = own.find(i => i.kind === 'beacon');
  assert.ok(ownBeacon && ownBeacon.rel === 'squad' && ownBeacon.id === beacon.id, 'the squad sees its beacon');
  assert.ok(own.some(i => i.kind === 'sensor' && i.radius === S.radius), 'the sensor and its ring');
  assert.ok(own.some(i => i.kind === 'sensed' && i.id === b.id), 'the sensed enemy shows on the own map');
  // Enemy view: no sensed marks of its own team, the enemy beacon only up close or spotted.
  const far = mapItems({ cq, self: row(b.id), players, vehicles: [], selfTeam: 'bravo' });
  assert.ok(!far.some(i => i.kind === 'sensor'), 'enemies never see sensors on the map');
  assert.ok(!far.some(i => i.kind === 'beacon'), 'an enemy far away does not see the beacon');
  const nearRow = { ...row(b.id), x: beacon.x + 10, z: beacon.z };
  assert.ok(mapItems({ cq, self: nearRow, players, vehicles: [], selfTeam: 'bravo' }).some(i => i.kind === 'beacon' && i.rel === 'spotted'),
    `an enemy within ${B.enemyRevealRange} m sees it`);

  // Deploy model: the beacon row for a dead squad mate, and the refusals.
  game.killPlayer(mate, b, 'rifle', false);
  run(TICK_MS);
  const dead = game.lastSnapshot.players.find(p => String(p.id) === mate.id);
  const model = deployModel({ cq: readConquest(game.lastSnapshot.match, mapMeta), self: dead, players: game.lastSnapshot.players, vehicles: [], nowMs: policy.now,
    selection: { spawn: `beacon:${beacon.id}`, kit: 'recon', gadget: 1 } });
  const option = model.options.find(o => o.kind === 'beacon');
  assert.ok(option && option.ok && option.label === 'SPAWN BEACON' && option.detail.endsWith('SQUAD BEACON'), `beacon row: ${option?.detail}`);
  assert.equal(model.spawn, `beacon:${beacon.id}`);
  assert.equal(model.gadget, 1, 'the Recon gadget choice rides the model');
  assert.deepEqual(model.choice, { spawn: `beacon:${beacon.id}`, kit: 'recon', variant: 0, gadget: 1, upgrades: {} });
  const cooling = deployModel({ cq: { ...cq, recon: { ...cq.recon, beacons: cq.recon.beacons.map(x => ({ ...x, cooldownMs: 4200 })) } },
    self: dead, players: game.lastSnapshot.players, vehicles: [], nowMs: policy.now });
  const coolRow = cooling.options.find(o => o.kind === 'beacon');
  assert.ok(!coolRow.ok && coolRow.reasonText.endsWith('READY IN 5 S'), `cooldown row: ${coolRow.reasonText}`);
  const card = kitCards('recon', 0, 1).find(c => c.id === 'recon');
  assert.deepEqual(card.gadgets.map(g => [g.role, g.label, g.selected]), [['BCN', 'SPAWN BEACON', false], ['MSN', 'MOTION SENSOR', true]]);
  assert.equal(card.gadget, 'MOTION SENSOR');

  // Banners for the owner.
  assert.equal(reconGadgetBanner({ kind: 'recon_gadget', gadget: 'beacon', state: 'placed', owner: r.id, id: 'x' }, r.id)?.title, 'SPAWN BEACON PLACED');
  assert.equal(reconGadgetBanner({ kind: 'recon_gadget', gadget: 'beacon', state: 'destroyed', owner: r.id, id: 'x' }, r.id)?.tone, 'enemy');
  assert.equal(reconGadgetBanner({ kind: 'recon_gadget', gadget: 'beacon', state: 'placed', owner: r.id, id: 'x' }, b.id), null, 'only the owner');

  // World view: models where the authority put them, team-relative lamps, removal.
  const scene = new THREE.Scene();
  const view = new ReconGadgetView(scene);
  view.setViewerTeam('bravo');
  view.sync(snap.match.conquest.recon);
  assert.equal(view.count, 2, 'beacon and sensor drawn');
  const model3d = view.views.get(beacon.id);
  assert.ok(Math.abs(model3d.group.position.y - beacon.y) < 0.01 && Math.abs(model3d.group.position.x - beacon.x) < 0.01);
  assert.equal(model3d.lamp.color.getHex(), 0xff4b4b, 'an enemy beacon lamp is red');
  view.update(0.1);
  view.sync(null);
  assert.equal(view.count, 0, 'gone with the snapshot');
  view.dispose();

  // Projectile presentation: no blast for a settling sensor, a beacon placement ghost.
  const getBlock = (x, y, z) => game.world.getBlock(x, y, z);
  const fx = new ProjectileFX(new THREE.Scene(), getBlock);
  assert.equal(fx.explode({ pid: 'g1', type: 'sensor', x: 1, y: 2, z: 3, radius: 30 }), true);
  assert.equal(fx.explosions?.active?.length ?? 0, 0, 'a sensor never blasts');
  const ghost = fx.setPreview(grenadeLaunch({ x: 30.5, y: 2, z: 30.5, eyeY: 3.6, dir: { x: 0, y: -0.8, z: -0.6 }, type: 'beacon', solidAt: (x, y, z) => getBlock(x, y, z) !== 0 }));
  assert.ok(ghost?.rests && fx.beaconPreview.group.visible, 'beacon placement ghost');
  fx.setPreview(null);
  assert.ok(!fx.beaconPreview.group.visible);
  fx.dispose?.();
  assert.equal(THROWABLE_NAMES.beacon, 'SPAWN BEACON'); assert.equal(THROWABLE_NAMES.sensor, 'MOTION SENSOR');
  assert.ok(GRENADE_HUD_ICONS.beacon.endsWith('beacon.svg') && GRENADE_HUD_ICONS.sensor.endsWith('sensor.svg'));
  assert.ok(ICON_PATHS.beacon && ICON_PATHS.sensor, 'map glyphs');
  assert.ok(grenadeRoleLine('sensor').includes('motion reveal'), grenadeRoleLine('sensor'));
  assert.ok(grenadeRoleLine('beacon').includes('squad spawn'), grenadeRoleLine('beacon'));
}

console.log('conquest recon gadgets: ok');
