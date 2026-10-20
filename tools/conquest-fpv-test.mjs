// Engineer FPV drone (shared/fpv-rules.js, server/sim/fpv-drones.js): the
// gadget gating, the link (operator held still, damage, range and battery
// cuts), the shaped charge against a tank and infantry, and the wire round
// trip of the drone row and the drones-left field. Kept small on purpose.
//
//   node tools/conquest-fpv-test.mjs
import assert from 'node:assert/strict';
import { GameEngine } from '../server/game.js';
import { TICK_MS, parseConquestIntent } from '../server/protocol/admission.js';
import { CONQUEST_CONTRACT_VERSION, CONQUEST_EVENT_KINDS, DEPLOYABLE_TYPE_IDS, KITS, isDeployableType } from '../shared/conquest-contract.js';
import { kitDeployable, kitGadgetWeapon, kitWeapons } from '../shared/conquest-kits.js';
import { FPV_RULES, decodeFpvRow, fpvSignal, fpvRowOf } from '../shared/fpv-rules.js';
import { flakTargets } from '../server/sim/flak-fuse.js';
import { ConquestFpvBots } from '../server/bot-fpv.js';
import { normalizeGadget } from '../server/modes/conquest/deploy.js';

let checks = 0;
const measured = {};
const ok = (value, message) => { assert.ok(value, message); checks++; };
const eq = (a, b, message) => { assert.deepEqual(a, b, message); checks++; };

// ------------------------------------------------------------ contract and gating --
eq(CONQUEST_CONTRACT_VERSION, 7, 'contract v7 carries the FPV drone');
eq([KITS.engineer.gadgets.at(-1), DEPLOYABLE_TYPE_IDS.at(-1), CONQUEST_EVENT_KINDS.at(-1)], ['fpv', 'fpv', 'fpv'], 'every new entry is appended');
ok(isDeployableType('fpv') && kitDeployable('engineer', 2) === 'fpv' && kitGadgetWeapon('engineer', 2) === null, 'gadget 2 is the drone, no launcher');
eq(kitWeapons('engineer', 0, 2).owned.filter(id => id === 'rocket' || id === 'stinger'), [], 'the FPV Engineer owns no launcher');
eq(parseConquestIntent({ fpv: 1 }), { type: 'fpv' });
eq([normalizeGadget('engineer', 2), normalizeGadget('support', 2), normalizeGadget('recon', 2)], [2, 0, 0], 'the deploy keeps gadget 2 for the Engineer only');
eq([parseConquestIntent({ deploy: { spawn: 'hq', kit: 'engineer', gadget: 2 } })?.gadget, parseConquestIntent({ deploy: { spawn: 'hq', kit: 'support', gadget: 2 } })],
  [2, null], 'gadget 2 only where the kit has a third choice');
eq([fpvSignal(100).bars, fpvSignal(300).degraded, fpvSignal(351).lost], [4, true, true], 'signal curve');

// ------------------------------------------------------------------------- rig --
function fixture() {
  const frames = [], dimensions = { sx: 512, sy: 64, sz: 512 };
  const world = { dimensions, getBlock: (x, y, z) => (y === 0 ? 3 : 0), setBlock() { return true; }, findSpawns: () => [{ x: 20, y: 1, z: 20 }] };
  const game = new GameEngine({ mode: 'conquest', world, broadcast: frame => frames.push(frame),
    mapMeta: { id: 'frontier', dimensions, spawns: { conquest: { alpha: [{ x: 20, y: 1, z: 20 }], bravo: [{ x: 30, y: 1, z: 20 }] } },
      conquest: { flags: [], bases: {}, vehicleSpawns: [{ id: 'tk', type: 'tank', team: 'bravo', x: 200.5, y: 1, z: 150.5, yaw: 0 }] } } });
  const policy = game.mode.policy;
  const join = (id, team, at) => {
    game.addClient(id, id);
    const p = game.entities.get(id);
    policy.setLobbyTeam(p, team);
    Object.assign(p, { x: at[0], y: at[1], z: at[2], yaw: 0, grounded: true, hp: 100, armor: 0, spawnProtectedUntil: 0, input: { keys: {}, yaw: 0, pitch: 0 } });
    return p;
  };
  const step = (n = 1) => { for (let i = 0; i < n; i++) game.step(TICK_MS); };
  const fpvEvents = id => frames.flatMap(f => f.events || []).filter(e => e.kind === 'fpv' && e.id === id);
  return { game, policy, join, step, frames, fpvEvents, fpv: game.vehicles.fpv };
}
const fly = (game, id, keys = {}, extra = {}) => game.applyInput(id, { keys, yaw: 0, pitch: 0, ...extra });

const f = fixture();
const op = f.join('op', 'alpha', [100.5, 1, 100.5]);
// Not an FPV Engineer: refused.
f.policy.roles.applyLoadout(op, 'engineer', 0, 0);
f.fpv.onLoadout(op, false);
ok(f.policy.conquestIntent(op, { type: 'fpv' }) === false, 'an AT Engineer has no drone');
f.step();
eq(f.fpvEvents('op').map(e => [e.state, e.reason]), [['refused', 'kit']]);
// The FPV Engineer: two drones, launched over his head.
f.policy.roles.applyLoadout(op, 'engineer', 0, 2);
f.fpv.onLoadout(op, true);
ok(!op.owned.includes('rocket') && op.grenades.some(n => n === 3), 'no launcher, the AT mines stay');
ok(f.policy.conquestIntent(op, { type: 'fpv' }) === true, 'the intent launches the drone');
const drone = f.fpv.droneOf('op');
ok(drone && drone.y > op.y + 1.5, 'the drone goes up over the operator');
eq(f.fpv.dronesLeft('op'), 1, 'one drone left');
ok(f.policy.canFire(op) === false, 'no gun while flying');
// W flies the drone along the look; the body stays put, crouched.
const start = { x: op.x, z: op.z }, droneZ = drone.z;
for (let i = 0; i < Math.ceil(1500 / TICK_MS); i++) { fly(f.game, "op", { f: true }); f.step(); }
ok(Math.hypot(op.x - start.x, op.z - start.z) < 0.05 && op.crouch === true, 'the operator stays crouched where he stood');
ok(droneZ - drone.z > 6 && drone.speed > 15, `the drone flies ahead (${(droneZ - drone.z).toFixed(1)} m, ${drone.speed.toFixed(1)} m/s)`);

// Wire: the drone row (own, battery, link) and the drones-left field.
{
  const snap = f.frames.at(-1);
  const row = fpvRowOf(snap.vehicles, 'op'), decoded = decodeFpvRow(row);
  ok(row && decoded.ownerId === 'op' && decoded.link === 'live' && decoded.battery > 0.9, 'the row names its operator, link and battery');
  eq(snap.players.find(p => p.id === 'op')?.cqf, 1, 'the row carries the drones left');
  ok(JSON.stringify(row).length < 260, `drone row ${JSON.stringify(row).length} B`);
  ok(flakTargets(f.game.vehicles.vehicles, 'bravo').includes(drone), 'enemy flak fuses on the drone');
}

// Damage to the operator cuts the link: the drone falls and fires a second later.
op.hp -= 5;
f.step();
ok(drone.cutAt != null && !f.fpv.linkedDrone(op) && f.policy.canFire(op), 'a hit cuts the link and frees the hands');
f.step(Math.ceil((FPV_RULES.cutFuseMs + 100) / TICK_MS));
ok(!f.fpv.droneOf('op') && f.fpvEvents('op').some(e => e.state === 'detonated'), 'the charge fires after the fuse');

// Range and battery: both cut the link.
op.hp = 100;
f.fpv.readyAt.clear();
ok(f.policy.conquestIntent(op, { type: 'fpv' }) === true, 'the second drone');
eq(f.fpv.dronesLeft('op'), 0);
const second = f.fpv.droneOf('op');
second.x = op.x + FPV_RULES.signal.range + 5;
fly(f.game, 'op'); f.step();
eq([second.cutAt != null, second.cutReason], [true, 'signal'], 'past the signal range the link is lost');
f.step(Math.ceil((FPV_RULES.cutFuseMs + 100) / TICK_MS));
f.fpv.stock.get('op').left = 1; f.fpv.readyAt.clear();
f.policy.conquestIntent(op, { type: 'fpv' });
const third = f.fpv.droneOf('op');
third.batteryUntil = f.game.vehicles.nowMs();
fly(f.game, 'op'); f.step();
eq(third.cutReason, 'battery', 'an empty battery cuts the link');
f.step(Math.ceil((FPV_RULES.cutFuseMs + 100) / TICK_MS));
ok(f.policy.conquestIntent(op, { type: 'fpv' }) === false, 'no drones left');

// ------------------------------------------------------------- the shaped charge --
{
  const tank = f.game.vehicles.vehicles.get('tk');
  ok(tank?.type === 'tank' && tank.hp === 1000, 'a full enemy tank');
  const enemy = f.join('foot', 'bravo', [tank.x + 6, 1, tank.z]);
  const near = f.join('near', 'bravo', [150.5, 1, 300.5]), far = f.join('far', 'bravo', [154, 1, 300.5]);
  const launch = (at, vy) => {
    f.fpv.stock.get('op').left = 1; f.fpv.readyAt.clear();
    ok(f.policy.conquestIntent(op, { type: 'fpv' }) === true, 'launch');
    const v = f.fpv.droneOf('op');
    Object.assign(v, { x: at[0], y: at[1], z: at[2], vx: 0, vy, vz: 0, launchedAt: -1e9 });
    return v;
  };
  // Two drones diving onto the roof kill the tank.
  for (let n = 0; n < 2; n++) {
    launch([tank.x, tank.y + 6, tank.z + 0.5], -20);
    for (let i = 0; i < 20 && f.fpv.droneOf('op'); i++) { fly(f.game, 'op', { crouch: true }, { pitch: -1.3 }); f.step(); }
    ok(!f.fpv.droneOf('op'), `drone ${n + 1} struck the hull`);
    if (n === 0) { measured.roof = Math.round(1000 - tank.hp); ok(tank.hp < 520 && tank.hp > 0, `one drone on the roof: ${measured.roof} damage`); }
  }
  ok(!(tank.hp > 0), 'the second drone kills the tank');
  // Infantry: lethal within 2 m, a survivor at 3.5 m.
  const v = launch([150.5, 2.2, 301.5], 0);
  f.fpv.detonate(v, null);
  f.step();
  ok(near.state !== 'alive' || near.hp <= 0, 'a soldier 1.3 m from the blast dies');
  measured.at37m = Math.round(100 - far.hp);
  ok(far.state === 'alive' && far.hp > 40 && far.hp < 100, `a soldier 3.7 m away is hurt (${Math.round(far.hp)} HP)`);
  const kill = f.frames.flatMap(fr => fr.events || []).find(e => e.kind === 'kill' && e.victim === 'near');
  eq([kill?.killer, kill?.w], ['op', 'fpv'], 'the kill feed credits the operator with the fpv key');
  ok(enemy.state === 'alive', 'unrelated soldier unharmed');
}

// -------------------------------------------------------------------- shot down --
{
  const gunner = f.game.entities.get('foot');
  f.fpv.stock.get('op').left = 1; f.fpv.readyAt.clear();
  f.policy.conquestIntent(op, { type: 'fpv' });
  const v = f.fpv.droneOf('op');
  f.game.vehicles.damage(v.id, 25, gunner, { cls: 'small' });
  f.step();
  ok(!f.fpv.droneOf('op') && f.fpvEvents('op').some(e => e.state === 'lost' && e.by === 'foot'), 'one rifle round brings it down');
  ok(f.frames.flatMap(fr => fr.events || []).some(e => e.kind === 'score' && e.id === 'foot' && e.reason === 'gadget_destroyed'), 'the shooter earns gadget_destroyed');
}

// ---------------------------------------------------------------------- bots --
{
  const g = fixture(), bot = g.join('bot', 'alpha', [100.5, 1, 100.5]);
  g.policy.roles.applyLoadout(bot, 'engineer', 0, 2);
  g.fpv.onLoadout(bot, true);
  const bots = new ConquestFpvBots(g.game, null), br = { id: 'bot', rng: () => 0, enemyId: null };
  const tank = g.game.vehicles.vehicles.get('tk');
  const think = () => { const inp = { keys: {}, yaw: bot.yaw, pitch: 0 }; const out = bots.think(br, bot, null, g.game.vehicles.nowMs(), TICK_MS / 1000, inp); g.game.applyInput('bot', inp); return out; };
  ok(think()?.vehicle?.type === 'fpv', 'a bot FPV Engineer launches on an enemy tank 112 m off');
  const v = g.fpv.droneOf('bot'), d0 = Math.hypot(v.x - tank.x, v.z - tank.z);
  for (let i = 0; i < Math.ceil(3000 / TICK_MS); i++) { think(); g.step(); }
  ok(v.y > 15 && Math.hypot(v.x - tank.x, v.z - tank.z) < d0 - 10, `the bot climbs and closes in (${v.y.toFixed(0)} m up, ${Math.hypot(v.x - tank.x, v.z - tank.z).toFixed(0)} m off)`);
  for (let i = 0; i < Math.ceil(12000 / TICK_MS) && g.fpv.droneOf('bot'); i++) { think(); g.step(); }
  measured.botHit = Math.round(1000 - tank.hp);
  ok(!g.fpv.droneOf('bot') && tank.hp < 700, `the bot's dive lands on the tank (${measured.botHit} damage)`);
  // A rifleman shoots an enemy drone in sight.
  const shooter = g.join('rifle', 'bravo', [100.5, 1, 140.5]);
  g.fpv.readyAt.clear();
  g.policy.conquestIntent(bot, { type: 'fpv' });
  const target = g.fpv.droneOf('bot');
  ok(bots.target(shooter, false) === target, 'an enemy sees the drone as a target');
}

console.log(`conquest-fpv-test: ${checks} checks passed (roof hit ${measured.roof}, infantry at 3.7 m ${measured.at37m}, bot dive ${measured.botHit})`);
