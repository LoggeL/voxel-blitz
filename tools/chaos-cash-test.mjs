import assert from 'node:assert/strict';
import { GameEngine } from '../server/game.js';
import { applyPowerup, PowerupSystem } from '../server/sim/powerups.js';
import { PlayerEntity } from '../server/sim/player.js';
import { findChaosCashSites } from '../shared/chaos-cash-sites.js';
import { isPowerupSiteSupported } from '../shared/powerup-sites.js';
import { CHAOS_CASH_RULES } from '../shared/powerups.js';
import { createMapState, MAP_IDS } from '../shared/worlddata.js';
import { isModeMapCompatible, MAX_CREDITS } from '../shared/modes.js';

for (const map of MAP_IDS.filter(id => isModeMapCompatible('chaos', id))) {
  const world = createMapState(map), sites = findChaosCashSites(world);
  assert.ok(sites.length >= 3, `${map} has multiple hiding places`);
  assert.ok(sites.every(site => isPowerupSiteSupported(world, site)), map);
  for (const site of sites) for (const spawn of world.meta.spawns.fun) {
    assert.ok(Math.hypot(site.x - spawn.x, site.z - spawn.z) >= 12, 'cash stays away from spawn');
  }
}
// Enclosed pockets with ample floor space must not become reachable candidates.
{
  const getBlock = (x,y,z) => y <= 14 || (y <= 19 &&
    ((x === 29 || x === 35) && z >= 29 && z <= 35 ||
     (z === 29 || z === 35) && x >= 29 && x <= 35)) ? 3 : 0;
  const sites = findChaosCashSites({ getBlock, meta: { spawns: { fun: [{ x: 10.5, y: 15.02, z: 10.5 }] } } });
  assert.ok(sites.every(p => !(p.x > 29 && p.x < 35 && p.z > 29 && p.z < 35)), 'sealed room excluded');
}
const site = { x: 20.5, y: 15.02, z: 20.5 };
function harness() {
  const system = new PowerupSystem({ solidAt: (_x,y) => y < 15,
    findSites: () => [site, { ...site, x: 40.5 }, { ...site, z: 40.5 }],
    rules: CHAOS_CASH_RULES, types: ['cash'], prefix: 'cash', now: 0, rng: () => 0 });
  const entities = new Map(), events = [];
  return { system, entities, events, step: (now, mode = 'chaos', phase = 'live') => system.step({
    now, mode, phase, entities, pushEvent: ev => events.push(ev),
  }) };
}
{
  const h = harness(); h.step(0);
  assert.equal(h.system.active.size, 1, 'cash is present from the first live tick');
  assert.equal(h.system.snapshot()[0].type, 'cash');
  const full = new PlayerEntity('full', 'Full', site), a = new PlayerEntity('a', 'A', site), b = new PlayerEntity('b', 'B', site);
  for (const p of [full,a,b]) { p.credits = 600; p.chaosUpgrades = {}; h.entities.set(p.id,p); }
  full.credits = MAX_CREDITS;
  h.step(50);
  assert.equal(full.credits, MAX_CREDITS, 'full wallet leaves money for the next player');
  assert.equal(a.credits, 900); assert.equal(b.credits, 600);
  assert.equal(h.system.active.size, 0);
  h.step(100); assert.equal(h.events.length, 1, 'race pays exactly once');
  assert.equal(h.events[0].amount, 300);
  h.step(15000);
  assert.equal(h.system.active.size, 1, 'money respawns');
  assert.notEqual(h.system.snapshot()[0].x, site.x, 'respawn chooses another location');
  a.credits = MAX_CREDITS - 10;
  assert.equal(applyPowerup(a, 'cash'), 10);
  assert.equal(a.credits, MAX_CREDITS);
  delete b.chaosUpgrades;
  assert.equal(applyPowerup(b, 'cash'), 0, 'cash cannot credit a regular-mode player');
  h.step(15050, 'chaos', 'post'); assert.equal(h.system.active.size, 0);
}
for (const mode of ['fun', 'tdm', 'snd', 'gungame', 'training', 'duel']) {
  const h = harness(); h.step(0,mode); assert.equal(h.system.active.size, 0, mode);
}
{
  let snapshot;
  const game = new GameEngine({ mode: 'chaos', powerupRng: () => 0, broadcast: s => { snapshot = s; } });
  game.addClient('collector', 'Collector');
  game.step();
  const cash = snapshot.powerups.find(p => p.type === 'cash');
  assert.ok(cash, 'cash reaches the wire snapshot');
  const p = game.entities.get('collector');
  Object.assign(p, { x: cash.x, y: cash.y, z: cash.z, vx: 0, vy: 0, vz: 0 });
  game.step();
  assert.equal(snapshot.players.find(p => p.id === 'collector').credits, 900, 'HUD wallet snapshot updates in collection tick');
  assert.equal(snapshot.powerups.some(p => p.id === cash.id), false);
  assert.ok(snapshot.events.some(e => e.kind === 'powerup' && e.type === 'cash' && e.amount === 300));
  game.stop();
}
console.log('Chaos cash: all combat maps, reachable cover, sealed-room exclusion, first spawn, respawn variety, wallet cap, races, mode isolation and live snapshots passed.');
