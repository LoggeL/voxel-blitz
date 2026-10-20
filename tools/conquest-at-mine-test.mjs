// Conquest AT MINE (Engineer pouch `atmine`, docs/conquest.md "AT mines"):
// placement, arming, the ground-hull-only trigger, belly damage on the jeep
// and the tank, friendly hulls, the per-owner cap, chain/shot detonation and
// owner cleanup, through the real GameEngine tick and vehicle damage model.
import assert from 'node:assert/strict';
import { GameEngine } from '../server/game.js';
import { KITS } from '../shared/conquest-contract.js';
import { kitLoadout } from '../shared/conquest-kits.js';
import { AT_MINE_RULES, placeAtMine } from '../shared/at-mine-rules.js';
import { atMineTriggeredBy } from '../shared/at-mine-trigger.js';
import { FREE_GRENADE_TYPE_IDS, GRENADE_ROLES, GRENADE_TYPES, GRENADE_TYPE_IDS, freshGrenadeLoadout, grenadeLaunch } from '../shared/grenade-rules.js';
import { VEHICLE_DEFS } from '../shared/vehicle-defs.js';
import { PROJECTILE_RULES } from '../server/sim/projectiles.js';
import { attachBots } from '../server/bots.js';
import * as THREE from '../public/js/vendor/three.module.js';
import { ProjectileFX } from '../public/js/weapons/projectiles.js';
import { GRENADE_HUD_ICONS, THROWABLE_NAMES } from '../public/js/ui/hud-support.js';
import { grenadeRoleLine } from '../public/js/ui/grenade-pouch.js';

const TICK = 1000 / 60;
const ATM = GRENADE_TYPE_IDS.indexOf('atmine');
const near = (a, b, tolerance, message) => assert(Math.abs(a - b) <= tolerance, `${message}: ${a} vs ${b}`);

// ---------------------------------------------------------------- roster and kit
{
  assert.equal(ATM, GRENADE_TYPE_IDS.length - 1, 'atmine is appended: older pouch slots keep their index');
  assert.equal(GRENADE_TYPES.atmine.perLife, 0, 'no free AT mines outside a kit');
  assert.equal(freshGrenadeLoadout()[ATM], 0);
  assert.equal(GRENADE_ROLES.atmine, 'gadget');
  assert.ok(!FREE_GRENADE_TYPE_IDS.includes('atmine'), 'kit-only type stays out of free rosters');
  assert.equal(KITS.engineer.grenades.atmine, 3, 'the Engineer carries three AT mines');
  for (const [kit, def] of Object.entries(KITS)) if (kit !== 'engineer') assert.ok(!def.grenades.atmine, `${kit} carries no AT mines`);
  assert.equal(kitLoadout('engineer').grenades[ATM], 3, 'engineer loadout issues the mines');
  assert.equal(kitLoadout('engineer', 0, 1).grenades[ATM], 3, 'the STINGER engineer keeps the mines');
  assert.equal(PROJECTILE_RULES.atmine.cls, 'at', 'belly charge is AT class');
}

// ---------------------------------------------------------------- pure placement
{
  const floor = (_x, y) => y === 0;
  const down = placeAtMine({ x: 10.5, eyeY: 2.6, z: 10.5, dir: { x: 0, y: -1, z: -1 } }, floor);
  assert.ok(down, 'aimed at the floor in reach');
  assert.deepEqual(down.n, [0, 1, 0]);
  near(down.y, 1 + AT_MINE_RULES.surfaceOffset, 1e-9, 'disc rests on the floor face');
  assert.equal(down.mount[1], 0);
  const ahead = placeAtMine({ x: 10.5, eyeY: 2.6, z: 10.5, dir: { x: 0, y: 0, z: -1 } }, floor);
  assert.ok(ahead, 'looking ahead drops the mine in front');
  near(ahead.z, 10.5 - AT_MINE_RULES.dropReach, 0.25, 'drop point is in front of the player');
  assert.equal(placeAtMine({ x: 10.5, eyeY: 2.6, z: 10.5, dir: { x: 0, y: 0, z: -1 } }, () => false), null, 'no floor, no mine');
  assert.equal(placeAtMine({ x: 10.5, eyeY: 2.6, z: 10.5, dir: { x: 0, y: 0, z: -1 } }, (x, y, z) => y === 0 || z === 9), null,
    'a wall between the eye and the drop point refuses');
  assert.equal(placeAtMine({ x: 10.5, eyeY: 2.6, z: 10.5, dir: { x: 0, y: 1, z: 0 } }, floor), null, 'looking up refuses');
  assert.equal(placeAtMine({ x: 10.5, eyeY: 2.6, z: 10.5, dir: { x: NaN, y: 0, z: 0 } }, floor), null, 'invalid aim refuses');
  const launch = grenadeLaunch({ x: 10.5, y: 1, z: 10.5, eyeY: 2.6, dir: { x: 0, y: -1, z: -1 }, charge: 1, type: 'atmine', solidAt: floor });
  assert.equal(launch.type, 'atmine', 'grenadeLaunch places, never throws');
  assert.equal(launch.vx, 0);
  // Trigger rule: ground hulls of the other team only, footprint and height band.
  const mine = { x: 50, y: 1.06, z: 50, team: 'alpha' };
  const hull = (type, extra = {}) => ({ type, hp: 100, team: 'bravo', x: 50, y: 1, z: 50, yaw: 0, ...extra });
  assert.ok(atMineTriggeredBy(mine, hull('jeep')));
  assert.ok(atMineTriggeredBy(mine, hull('tank')));
  assert.ok(!atMineTriggeredBy(mine, hull('jeep', { team: 'alpha' })), 'friendly hull');
  assert.ok(!atMineTriggeredBy(mine, hull('jeep', { hp: 0 })), 'wreck');
  assert.ok(!atMineTriggeredBy(mine, hull('helicopter')), 'aircraft never trigger');
  assert.ok(!atMineTriggeredBy(mine, hull('helicopter', { y: 1 })), 'a landed helicopter does not either');
  assert.ok(!atMineTriggeredBy(mine, hull('tank', { y: 5 })), 'a hull passing high above (bridge, jump)');
  assert.ok(!atMineTriggeredBy(mine, hull('jeep', { x: 50 + VEHICLE_DEFS.jeep.collider.halfWidth + 0.5 })), 'beside the jeep');
  assert.ok(atMineTriggeredBy(mine, hull('jeep', { x: 50 + VEHICLE_DEFS.jeep.collider.halfWidth })), 'under the jeep wheel line');
  // Along the hull the charge waits until the mine is triggerInset inside either end (under the belly, not the nose lip).
  for (const [type, yaw] of [['tank', 0], ['tank', Math.PI / 2], ['jeep', 0], ['jeep', -Math.PI / 2]]) {
    const end = VEHICLE_DEFS[type].collider.halfLength, axis = yaw ? [1, 0] : [0, 1];
    for (const sign of [1, -1]) {
      const at = d => hull(type, { yaw, x: 50 + sign * axis[0] * d, z: 50 + sign * axis[1] * d });
      assert.ok(!atMineTriggeredBy(mine, at(end - AT_MINE_RULES.triggerInset + 0.1)), `${type} yaw ${yaw.toFixed(2)}: mine under the ${sign > 0 ? 'front' : 'rear'} lip stays live`);
      assert.ok(atMineTriggeredBy(mine, at(end - AT_MINE_RULES.triggerInset - 0.1)), `${type} yaw ${yaw.toFixed(2)}: mine under the ${sign > 0 ? 'front' : 'rear'} belly goes off`);
    }
  }
  assert.ok(!atMineTriggeredBy({ ...mine, team: null }, hull('jeep')), 'teamless mine');
}

// ---------------------------------------------------------------- engine fixture
function fixture(spawns) {
  const size = 256, dimensions = { sx: size, sy: 64, sz: size }, blocks = new Set(), removed = new Set(), frames = [];
  const world = { dimensions,
    getBlock: (x, y, z) => (y === 0 && !removed.has(`${x},${y},${z}`)) || blocks.has(`${x},${y},${z}`) ? 3 : 0,
    setBlock(x, y, z, value) {
      const key = `${x},${y},${z}`;
      if (value) { blocks.add(key); removed.delete(key); } else { blocks.delete(key); if (y === 0) removed.add(key); }
      return true;
    },
    findSpawns: () => [{ x: 20, y: 1, z: 20 }] };
  const game = new GameEngine({ mode: 'conquest', world, broadcast: frame => frames.push(frame),
    mapMeta: { id: 'frontier', dimensions, spawns: { conquest: { alpha: [{ x: 20, y: 1, z: 20 }], bravo: [{ x: 30, y: 1, z: 20 }] } },
      conquest: { flags: [], bases: {}, vehicleSpawns: spawns } } });
  const player = (id, team, extra = {}) => {
    game.addClient(id, id);
    const p = game.entities.get(id);
    game.mode.policy.setLobbyTeam(p, team);
    Object.assign(p, { x: 20, y: 1, z: 20, hp: 100, armor: 0, spawnProtectedUntil: 0, spawnProtected: false, grounded: true,
      input: { keys: {}, yaw: 0, pitch: 0 }, ...extra });
    p.grenades = GRENADE_TYPE_IDS.map(() => 0);
    p.grenades[ATM] = 3;
    return p;
  };
  const vehicle = id => game.vehicles.vehicles.get(id);
  const ctx = game.contexts.projectiles;
  // Place one mine: aim down-forward from (x, z); the mine lands ~1.6 m ahead (-z).
  const place = (p, x, z) => {
    Object.assign(p, { x, y: 1, z, yaw: 0, pitch: -0.95 });
    return game.projectiles.throw(p, ctx, 0, ATM, 0, { yaw: 0, pitch: -0.95 });
  };
  const mines = () => [...game.projectiles.active.values()].filter(m => m.type === 'atmine');
  const events = kind => frames.flatMap(frame => frame.events).filter(event => event.kind === kind);
  const tick = (count = 1) => { for (let i = 0; i < count; i++) game.step(TICK); };
  const park = (v, mine) => Object.assign(v, { x: mine.x, z: mine.z, speed: 0 });
  return { game, frames, player, vehicle, place, mines, events, tick, park, ctx };
}
const spawn = (id, type, team, x, z, yaw = 0) => ({ id, type, team, x, y: 1, z, yaw });
const armTicks = Math.ceil(AT_MINE_RULES.armMs / TICK) + 2;

// ---------------------------------------------------------------- jeep: one mine kills it
{
  const f = fixture([spawn('j1', 'jeep', 'bravo', 120, 120)]);
  const eng = f.player('eng', 'alpha', { spawnProtectedUntil: 99999, spawnProtected: true });
  const mine = f.place(eng, 60.5, 60.5);
  assert.ok(mine, 'engineer lays a mine');
  assert.equal(eng.grenades[ATM], 2, 'one mine spent');
  assert.equal(eng.spawnProtectedUntil, 0, 'placing ends spawn protection');
  assert.equal(mine.team, 'alpha', 'mine carries the owner team');
  near(mine.y, 1 + AT_MINE_RULES.surfaceOffset, 1e-9, 'mine on the floor');
  assert.ok(mine.z < 60.5, 'mine lies ahead of the player');
  const launch = f.frames.flatMap(fr => fr.events).find(e => e.pid === mine.id);
  f.tick(1);
  const row = f.frames.at(-1).mines.find(m => m.pid === mine.id);
  assert.ok(row && row.type === 'atmine' && row.armMs > 0, 'snapshot carries the arming mine');
  assert.ok(launch || row, 'placement reaches clients');
  // Infantry never trigger it: enemy soldier stands on the mine through arming and after.
  const grunt = f.player('grunt', 'bravo', { x: mine.x, y: 1, z: mine.z });
  f.tick(armTicks + 30);
  assert.equal(f.mines().length, 1, 'infantry walking over an armed AT mine does not set it off');
  assert.equal(grunt.state, 'alive');
  Object.assign(grunt, { x: mine.x + 4.5, z: mine.z });
  const jeep = f.vehicle('j1');
  // A hull over it during arming does nothing.
  const f2 = fixture([spawn('j2', 'jeep', 'bravo', 120, 120)]);
  const eng2 = f2.player('eng2', 'alpha');
  const m2 = f2.place(eng2, 60.5, 60.5);
  f2.park(f2.vehicle('j2'), m2);
  f2.tick(Math.floor(AT_MINE_RULES.armMs / TICK) - 6);
  assert.equal(f2.mines().length, 1, 'an unarmed mine ignores a hull on it');
  f2.tick(12);
  assert.equal(f2.mines().length, 0, 'it goes off once armed under the hull');
  // Live jeep run-over.
  const driver = f.player('driver', 'bravo');
  f.park(jeep, mine);
  jeep.x = mine.x; jeep.z = mine.z + 3;
  Object.assign(driver, { x: jeep.x, y: jeep.y, z: jeep.z });
  f.game.applyInput(driver.id, { keys: {}, yaw: jeep.yaw, pitch: 0, vehicleAction: { type: 'enter', vehicleId: 'j1' } });
  assert.equal(driver.vehicleId, 'j1', 'driver boards the jeep');
  f.tick(1);
  assert.equal(f.mines().length, 1, 'jeep not yet over the mine');
  f.park(jeep, mine);
  f.tick(1);
  assert.equal(f.mines().length, 0, 'enemy jeep detonates the mine');
  assert.equal(jeep.hp, 0, 'one AT mine destroys a jeep');
  const destroyed = f.events('vehicle_destroyed').find(e => e.vehicleId === 'j1');
  assert.equal(destroyed?.attacker, 'eng', 'the mine owner is credited');
  assert.ok(f.events('projectileExplode').some(e => e.pid === mine.id || e.gid === mine.id || e.type === 'atmine'), 'explosion event');
  assert.ok(grunt.hp < 100 && grunt.state === 'alive', `infantry 4.5 m away take splash only (${grunt.hp})`);
  assert.notEqual(driver.state, 'alive', 'the jeep crew dies with the hull');
  assert.ok(f.events('kill').some(e => e.victim === 'driver' && e.killer === 'eng'), 'crew kill credited to the mine owner');
}

// ---------------------------------------------------------------- tank: one disables, two destroy
{
  const f = fixture([spawn('t1', 'tank', 'bravo', 140, 140)]);
  const eng = f.player('eng', 'alpha');
  const tank = f.vehicle('t1');
  const max = VEHICLE_DEFS.tank.hp;
  const mine = f.place(eng, 60.5, 60.5);
  f.tick(armTicks);
  f.park(tank, mine);
  f.tick(1);
  assert.equal(f.mines().length, 0, 'enemy tank detonates the mine');
  const dealt = max - tank.hp;
  assert.ok(dealt >= 580 && dealt <= 660, `one mine takes ~60% of a tank (${dealt} of ${max})`);
  assert.equal(tank.disabled, true, 'a belly hit disables the tank');
  f.tick(10);
  const hit = f.events('vehicle_hit').find(e => e.vehicleId === 't1' && e.cls === 'at');
  assert.equal(hit?.zone, 'bottom', 'reported on the bottom zone');
  assert.equal(hit?.part, 'hull-bottom', 'tank part is the belly plate');
  // Second mine: destroyed.
  tank.x = 140; tank.z = 140;
  const second = f.place(eng, 80.5, 80.5);
  f.tick(armTicks);
  f.park(tank, second);
  f.tick(1);
  assert.equal(tank.hp, 0, 'two AT mines destroy a tank');
}

// ---------------------------------------------------------------- stacked pair: chain kills a tank in one pass
{
  const f = fixture([spawn('t1', 'tank', 'bravo', 140, 140)]);
  const eng = f.player('eng', 'alpha');
  const a = f.place(eng, 60.5, 60.5);
  const b = f.place(eng, 61.5, 60.5);
  f.tick(armTicks);
  f.park(f.vehicle('t1'), a);
  f.vehicle('t1').x = (a.x + b.x) / 2;
  f.tick(3);
  assert.equal(f.mines().length, 0, 'the second mine chains');
  assert.equal(f.vehicle('t1').hp, 0, 'a stacked pair kills a tank in one pass');
}

// ---------------------------------------------------------------- friendly hulls
{
  const f = fixture([spawn('j1', 'jeep', 'alpha', 120, 120), spawn('t1', 'tank', 'alpha', 140, 140)]);
  const eng = f.player('eng', 'alpha');
  const mine = f.place(eng, 60.5, 60.5);
  f.tick(armTicks);
  f.park(f.vehicle('j1'), mine);
  f.tick(5);
  assert.equal(f.mines().length, 1, 'a friendly jeep rolls over safely');
  assert.equal(f.vehicle('j1').hp, VEHICLE_DEFS.jeep.hp);
  f.vehicle('j1').x = 120;
  f.park(f.vehicle('t1'), mine);
  f.tick(5);
  assert.equal(f.mines().length, 1, 'a friendly tank too');
}

// ---------------------------------------------------------------- aircraft never trigger
{
  const f = fixture([spawn('h1', 'helicopter', 'bravo', 120, 120)]);
  const eng = f.player('eng', 'alpha');
  const mine = f.place(eng, 60.5, 60.5);
  f.tick(armTicks);
  f.park(f.vehicle('h1'), mine);
  f.tick(5);
  assert.equal(f.mines().length, 1, 'a landed enemy helicopter does not set it off');
}

// ---------------------------------------------------------------- cap, persistence and cleanup
{
  const f = fixture([]);
  const eng = f.player('eng', 'alpha');
  eng.grenades[ATM] = 5;
  const placed = [10.5, 20.5, 30.5, 40.5].map(x => f.place(eng, x, 60.5));
  assert.ok(placed.every(Boolean));
  const live = f.mines();
  assert.equal(live.length, AT_MINE_RULES.maxPerOwner, 'at most three live mines per player');
  assert.ok(!live.includes(placed[0]), 'the oldest makes room');
  assert.equal(eng.grenades[ATM], 1);
  eng.grenades[ATM] = 0;
  assert.equal(f.place(eng, 50.5, 60.5), null, 'an empty pouch places nothing');
  // Owner death keeps the mines; leaving removes them.
  f.game.killPlayer(eng, null, 'world', false);
  f.tick(2);
  assert.equal(f.mines().length, 3, 'mines outlive the owner\'s death');
  const other = f.player('other', 'alpha');
  const kept = f.place(other, 70.5, 60.5);
  f.game.removeClient('eng');
  f.tick(1);
  assert.deepEqual(f.mines(), [kept], 'leaving clears only the leaver\'s mines');
  assert.deepEqual(f.frames.at(-1).mines.map(m => m.pid), [kept.id], 'snapshot drops them');
}

// ---------------------------------------------------------------- shot and blasted mines, removed floor
{
  const f = fixture([]);
  const eng = f.player('eng', 'alpha');
  const mine = f.place(eng, 60.5, 60.5);
  const origin = [mine.x, mine.y + 3, mine.z + 3];
  const len = Math.hypot(0, -3, -3);
  const hit = f.game.projectiles.nearestClaymore(origin, { x: 0, y: -3 / len, z: -3 / len }, 20);
  assert.equal(hit?.mine, mine, 'bullets find the disc');
  f.game.contexts.combat.shootClaymore(hit.mine);
  assert.equal(f.mines().length, 0, 'a shot mine detonates');
  // Explosive chain: a frag going off beside a mine sets it off.
  const chained = f.place(eng, 30.5, 30.5);
  f.game.projectiles.chaosBlast(eng, [chained.x + 1, chained.y + 0.3, chained.z], 'frag', 5, 50, 0, f.ctx);
  f.tick(1);
  assert.equal(f.mines().length, 0, 'a nearby blast chains the mine');
  // A mine whose floor voxel is gone is removed without a blast.
  const floating = f.place(eng, 90.5, 90.5);
  f.game.world.setBlock(...floating.mount, 0);
  f.tick(1);
  assert.equal(f.mines().length, 0, 'mine leaves with its floor');
}

// ---------------------------------------------------------------- client presentation
{
  const f = fixture([]);
  const eng = f.player('eng', 'alpha');
  const mine = f.place(eng, 60.5, 60.5);
  f.tick(1);
  const getBlock = (x, y, z) => f.game.world.getBlock(x, y, z);
  const armed = [];
  const fx = new ProjectileFX(new THREE.Scene(), getBlock, { onMineArmed: m => armed.push(m.id) });
  fx.syncMines(f.frames.at(-1).mines, 'someone-else');
  const view = fx.projectiles.get(mine.id);
  assert.ok(view && view.type === 'atmine' && view.stuck && view.fuse === Infinity, 'remote clients see the laid mine');
  near(view.group.position.y, mine.y, 1e-6, 'the disc sits where the authority placed it');
  for (let i = 0; i < 40; i++) fx.update(0.05);
  assert.deepEqual(armed, [mine.id], 'the arm click fires once when the mine goes live');
  const late = new ProjectileFX(new THREE.Scene(), getBlock, { onMineArmed: m => armed.push(`late:${m.id}`) });
  f.tick(armTicks);
  late.syncMines(f.frames.at(-1).mines, 'late-joiner');
  for (let i = 0; i < 10; i++) late.update(0.05);
  assert.ok(late.projectiles.has(mine.id) && !armed.includes(`late:${mine.id}`), 'a late joiner sees a live mine without a click');
  fx.syncMines([], 'someone-else');
  assert.ok(!fx.projectiles.has(mine.id), 'a mine missing from the snapshot leaves the view');
  const preview = fx.setPreview({ ...grenadeLaunch({ x: 30.5, y: 1, z: 30.5, eyeY: 2.6, dir: { x: 0, y: -1, z: -1 }, type: 'atmine', solidAt: (x, y, z) => getBlock(x, y, z) !== 0 }) });
  assert.ok(preview?.rests && fx.atMinePreview.group.visible && !fx.minePreview.group.visible, 'placement ghost is the AT mine');
  fx.setPreview(null);
  assert.ok(!fx.atMinePreview.group.visible);
  assert.equal(THROWABLE_NAMES.atmine, 'AT MINE');
  assert.ok(GRENADE_HUD_ICONS.atmine.endsWith('atmine.svg'), 'kill feed and pouch icon');
  assert.ok(grenadeRoleLine('atmine').startsWith('Floor mine'), `pouch role line: ${grenadeRoleLine('atmine')}`);
  fx.dispose?.(); late.dispose?.();
}

// ---------------------------------------------------------------- bots: a defending Engineer mines its flag
{
  const f = fixture([spawn('t1', 'tank', 'bravo', 140, 140)]);
  const bots = attachBots(f.game, 0);
  const eng = f.player('bot-eng', 'alpha', { x: 60.5, y: 1, z: 60.5, yaw: 0, grounded: true });
  const flag = { x: 62, z: 60, radius: 12 };
  const defend = { kind: 'capture', stance: 'defend', target: flag };
  const think = (goal, now, brain = {}) => {
    const inp = { keys: {}, yaw: eng.yaw, pitch: 0 };
    return { laid: bots.layMine(brain, eng, goal, inp, now), inp };
  };
  assert.equal(think({ ...defend, stance: 'attack' }, 1000).laid, false, 'attackers do not mine');
  f.vehicle('t1').x = 400; f.vehicle('t1').z = 400;
  assert.equal(think(defend, 1000).laid, false, 'no enemy hull in reach, no mine');
  Object.assign(f.vehicle('t1'), { x: 140, z: 140 });
  const brain = {};
  const { laid, inp } = think(defend, 1000, brain);
  assert.ok(laid && inp.throwGrenade && inp.grenadeType === ATM && inp.grenadeAim.pitch < -0.9, 'a defender with a tank in reach lays a mine');
  assert.equal(think(defend, 2000, brain).laid, false, 'mine checks are rate limited');
  f.game.applyInput(eng.id, inp);
  f.tick(1);
  f.game.applyInput(eng.id, { keys: {}, yaw: 0, pitch: 0 });
  const laidMine = f.mines().find(m => m.ownerId === eng.id);
  assert.ok(laidMine, 'the bot input places a real mine through the human throw path');
  assert.equal(think(defend, 99999).laid, false, 'no second mine on top of its own');
  bots.dispose?.();
}

console.log('conquest AT mine: ok');
