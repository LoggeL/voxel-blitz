import assert from 'node:assert/strict';
import { GameEngine } from '../server/game.js';
import { PowerupSystem, applyPowerup, validPowerupSite } from '../server/sim/powerups.js';
import { PlayerEntity } from '../server/sim/player.js';
import { makeSnapshot } from '../server/protocol/snapshot.js';
import { WEAPON_IDS, WEAPONS } from '../shared/combatmath.js';
import { POWERUP_RULES } from '../shared/powerups.js';
import { findPowerupSites } from '../shared/powerup-sites.js';
import { createMapState, MAP_IDS } from '../shared/worlddata.js';
import { PLAYER_KEYS } from './lib/protocol-contract.mjs';
import { NetClient } from '../public/js/engine/netclient.js';

const origin = { x: 20.5, y: 15.02, z: 20.5 };
const sites = [origin, { ...origin, x: 40.5 }, { ...origin, x: 60.5 }, { ...origin, x: 80.5 }];
function harness(rng = () => 0) {
  const mutations = new Map();
  const solidAt = (x, y, z) => mutations.get(`${x},${y},${z}`) ?? (y <= 14);
  const system = new PowerupSystem({ solidAt, findSites: () => sites, rng, now: 0 });
  const entities = new Map(), events = [];
  return { system, mutations, entities, events,
    step: (now, overrides = {}) => system.step({ now, mode: 'fun', phase: 'live', entities,
      pushEvent: (event) => events.push(event), ...overrides }) };
}
function player(id = 'human', isBot = false) {
  const entity = new PlayerEntity(id, id, origin, isBot);
  entity.owned = WEAPON_IDS.slice();
  return entity;
}
function addPickup(h, type = 'armor', overrides = {}) {
  const pickup = { id: 'test-pickup', type, ...origin, expiresAt: 30000, ...overrides };
  h.system.active.set(pickup.id, pickup);
  return pickup;
}

// Scheduling uses sim time, remains bounded on slow ticks, and does not repeat
// the preceding site while another exposed location is free.
{
  const h = harness();
  h.step(11999);
  assert.equal(h.system.active.size, 0);
  h.step(12000);
  assert.equal(h.system.active.size, 1);
  assert.equal(h.system.nextSpawnAt, 30000);
  const first = h.system.snapshot()[0];
  assert.equal(first.type, 'armor');
  assert.equal(first.expiresAt, 42000);
  h.step(29999);
  assert.equal(h.system.active.size, 1);
  h.step(30000);
  assert.equal(h.system.active.size, 2);
  assert.notEqual(h.system.snapshot()[1].x, first.x);
  h.step(42000);
  assert.equal(h.system.active.has(first.id), false, 'expiry is inclusive');
  h.step(900000);
  assert.equal(h.system.active.size, 1, 'no overdue spawn burst');
  assert.equal(h.system.nextSpawnAt, 918000);
  const high = harness(() => 1);
  high.step(12000);
  assert.ok(high.system.nextSpawnAt > 39999 && high.system.nextSpawnAt <= 40000);
  assert.equal(high.system.snapshot()[0].type, 'armor', 'each match opens with armor');
  high.step(40000);
  assert.equal(high.system.snapshot().at(-1).type, 'ammo');
  const blocked = harness();
  for (let index = 0; index < POWERUP_RULES.maxActive; index++) {
    addPickup(blocked, 'armor', { ...sites[index], id: `cap-${index}`, expiresAt: 100000 });
  }
  blocked.step(12000);
  assert.equal(blocked.system.active.size, POWERUP_RULES.maxActive);
}

// All live supported modes spawn; prep/post/disabled modes clear existing state
// and restart the initial delay when live play resumes.
for (const mode of ['fun', 'tdm', 'chaos']) {
  const h = harness();
  h.step(12000, { mode });
  assert.equal(h.system.active.size, 1, mode);
  h.step(12050, { mode, phase: 'post' });
  assert.equal(h.system.active.size, 0);
  h.step(13000, { mode });
  assert.equal(h.system.nextSpawnAt, 25000);
  h.step(24999, { mode });
  assert.equal(h.system.active.size, 0);
  h.step(25000, { mode });
  assert.equal(h.system.active.size, 1);
  h.step(25050, { mode, round: 2 });
  assert.equal(h.system.active.size, 0, 'a new round drops all pickups');
}
for (const mode of ['snd', 'gungame', 'training', 'unknown']) {
  const h = harness();
  addPickup(h);
  h.step(12000, { mode });
  assert.equal(h.system.active.size, 0, mode);
  assert.equal(h.system.nextSpawnAt, null);
}

// Armor and healing report their actual capped benefits. Full players leave
// pickups available, including for a bot arriving in the same sim tick.
{
  const p = player();
  assert.equal(applyPowerup(p, 'armor'), 50);
  p.armor = 80;
  assert.equal(applyPowerup(p, 'armor'), 20);
  assert.equal(p.armor, 100);
  assert.equal(applyPowerup(p, 'armor'), 0);
  p.hp = 40;
  assert.equal(applyPowerup(p, 'health'), 35);
  assert.equal(applyPowerup(p, 'health'), 25);
  assert.equal(p.hp, 100);
  assert.equal(applyPowerup(p, 'health'), 0);
  const h = harness(), first = player('full'), bot = player('bot', true), rival = player('rival');
  first.armor = 100;
  for (const entity of [first, bot, rival]) h.entities.set(entity.id, entity);
  addPickup(h);
  h.step(1000);
  assert.equal(first.armor, 100);
  assert.equal(bot.armor, 50);
  assert.equal(rival.armor, 0);
  assert.deepEqual(h.events, [{ t: 'ev', kind: 'powerup', id: 'bot', pickupId: 'test-pickup', type: 'armor', amount: 50 }]);
  h.step(1050);
  assert.equal(h.events.length, 1, 'racing players consume once');
  const full = harness();
  full.entities.set(first.id, first);
  addPickup(full);
  full.step(1000);
  assert.equal(full.system.active.size, 1);
}

// Ammo restores only spare magazines, retains partial reload state and owned
// weapons, and uses the active weapon definition for upgraded capacity.
{
  const p = player();
  p.owned = ['rifle', 'shotgun', 'knife'];
  p.weapon = WEAPON_IDS.indexOf('rifle');
  p.reserve.fill(0);
  p.mag.fill(1);
  p.reloading = true;
  p.reloadT = 0.7;
  p.reloadStage = 'insert';
  p.reloadLoose = 3;
  const before = { mag: p.mag.slice(), reloading: p.reloading, reloadT: p.reloadT,
    reloadStage: p.reloadStage, reloadLoose: p.reloadLoose };
  Object.defineProperty(p, 'def', { value: { ...WEAPONS.rifle, spareMags: 9 } });
  assert.equal(applyPowerup(p, 'ammo'), 9 + WEAPONS.shotgun.spareRounds);
  assert.equal(p.reserve[0], 9);
  assert.equal(p.reserve[WEAPON_IDS.indexOf('shotgun')], WEAPONS.shotgun.spareRounds);
  assert.equal(p.reserve[WEAPON_IDS.indexOf('smg')], 0, 'unowned weapon remains empty');
  assert.equal(p.reserve[WEAPON_IDS.indexOf('knife')], 0);
  for (const [key, value] of Object.entries(before)) assert.deepEqual(p[key], value, key);
  assert.equal(applyPowerup(p, 'ammo'), 0);
  p.infiniteMagazines = true;
  p.reserve.fill(0);
  assert.equal(applyPowerup(p, 'ammo'), 0);
  p.infiniteMagazines = false;
  p.owned = [];
  assert.equal(applyPowerup(p, 'ammo'), 0);
}

// Body distance, vertical distance and line of sight all matter. Terrain
// destruction or a newly obstructed pickup removes it before collection.
for (const scenario of ['dead', 'far', 'above', 'wall', 'floor', 'ceiling']) {
  const h = harness(), p = player();
  addPickup(h);
  h.entities.set(p.id, p);
  if (scenario === 'dead') p.state = 'dead';
  if (scenario === 'far') p.x += 1.31;
  if (scenario === 'above') p.y += 0.76;
  if (scenario === 'wall') {
    p.x -= 1.2;
    h.mutations.set('19,15,20', true);
  }
  if (scenario === 'floor') h.mutations.set('20,14,20', false);
  if (scenario === 'ceiling') h.mutations.set('20,16,20', true);
  h.step(1000);
  assert.equal(p.armor, 0, scenario);
  assert.equal(h.events.length, 0, scenario);
  assert.equal(h.system.active.size, ['floor', 'ceiling'].includes(scenario) ? 0 : 1, scenario);
}

// PvP maps have exposed pickups on real geometry. Training has none; Bastion
// owns its authored wave supply point instead of the random pickup scheduler.
for (const mapId of MAP_IDS) {
  const world = createMapState(mapId), mapSites = findPowerupSites(world, world.meta);
  if (mapId === 'killhouse' || mapId === 'reactor') assert.equal(mapSites.length, 0);
  else assert.ok(mapSites.length >= 3, `${mapId}: enough exposed contest points`);
  assert.ok(mapSites.every((site) => validPowerupSite(site, (x, y, z) => world.getBlock(x, y, z) !== 0, world.dimensions)));
}

// Snapshots own pickup rows, contain the full current state for a late join,
// clamp armor, and never need historical collection events to remove a pickup.
{
  const h = harness(), p = player();
  p.armor = 1000;
  h.step(12000);
  const raw = h.system.snapshot();
  const frame = makeSnapshot([p], [], [], 12000, undefined, [], raw);
  assert.equal(Object.keys(frame.players[0]).sort().join(','), PLAYER_KEYS);
  assert.equal(frame.players[0].armor, 100);
  assert.equal(frame.powerups.length, 1);
  assert.equal(Object.keys(frame.powerups[0]).sort().join(','), 'expiresAt,id,type,x,y,z');
  raw[0].x = -100;
  assert.notEqual(frame.powerups[0].x, -100);
  frame.powerups[0].x = -200;
  assert.notEqual(h.system.snapshot()[0].x, -200);
  assert.equal(makeSnapshot([], [], [], 0, undefined, [], [{ type: 'fake' }, { id: 'bad', type: 'armor', x: NaN }]).powerups.length, 0);
  const frames = [], game = new GameEngine({ broadcast: (tick) => frames.push(tick), powerupRng: () => 0 });
  game.powerups.nextSpawnAt = game.now;
  game.step();
  assert.equal(frames.at(-1).powerups.length, 1);
  game.addClient('late', 'Late arrival');
  const live = game.entities.get('late');
  game.step();
  assert.equal(frames.at(-1).powerups.length, 1, 'joining does not need old spawn events');
  const lateNet = new NetClient();
  lateNet._onTick(frames.at(-1));
  assert.equal(lateNet.latestSnapshots.at(-1).powerups.length, 1);
  assert.ok(Object.isFrozen(lateNet.latestSnapshots.at(-1).powerups[0]));
  const pickup = frames.at(-1).powerups[0];
  Object.assign(live, { x: pickup.x, y: pickup.y, z: pickup.z, armor: 0 });
  game.step();
  assert.equal(frames.at(-1).powerups.length, 0);
  assert.equal(frames.at(-1).players.find((row) => row.id === live.id).armor, 50);
  assert.equal(frames.at(-1).events.filter((event) => event.kind === 'powerup').length, 1);
  lateNet._onTick(frames.at(-1));
  assert.equal(lateNet.latestSnapshots.at(-1).powerups.length, 0, 'late client receives authoritative removal');
  game.killPlayer(live, null, 'world', false);
  assert.equal(live.armor, 0, 'death clears armor immediately');
  game.stop();
  assert.equal(game.powerups.active.size, 0);
}

console.log('powerup-test: scheduling, effects, races, terrain, mode gates and snapshots passed');
