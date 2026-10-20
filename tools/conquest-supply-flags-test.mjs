// Conquest flag supply caches (docs/conquest.md "Infantry supply" -> "Flag
// caches"): every flag on Frontier and Redrock gets a valid cache spot in the
// map metadata, the server pays only the holder and nothing while contested,
// at the documented rates; the HUD tag, the map pip, the world prop and the
// bot run follow the same rules.
import assert from 'node:assert/strict';
import * as THREE from '../public/js/vendor/three.module.js';
import { createMapState, getMapMeta } from '../shared/world/templates.js';
import { AIR, MC_WATER, isSolidBlock } from '../shared/world/blocks.js';
import { CONQUEST_RULES } from '../shared/conquest-contract.js';
import { decodeConquestMatch, encodeConquestFlag } from '../shared/conquest.js';
import { FLAG_CACHE_RULES, flagCacheSpot, flagCacheTeam, inFlagCacheReach } from '../shared/flag-cache.js';
import { kitLoadout } from '../shared/conquest-kits.js';
import { WEAPON_IDS } from '../shared/combatmath.js';
import { PlayerEntity } from '../server/sim/player.js';
import { createConquestRoles } from '../server/modes/conquest/roles.js';
import { CaptureSystem } from '../server/modes/conquest/capture.js';
import { FlagCaches } from '../server/modes/conquest/flag-caches.js';
import { botSupplyState, flagCacheGoal } from '../server/bot-flag-cache.js';
import { flagCacheServing, flagSupplyPip, mapItems } from '../public/js/ui/conquest-hud-state.js';
import { ConquestWorld } from '../public/js/engine/conquest-world.js';

let checks = 0;
const ok = (value, message) => { assert.ok(value, message); checks++; };
const eq = (a, b, message) => { assert.deepEqual(a, b, message); checks++; };

// ------------------------------------------------ every flag has a spot --
for (const id of ['frontier', 'redrock']) {
  const world = createMapState(id), meta = getMapMeta(id);
  eq(meta.conquest.flags.length, 5, `${id}: five flags`);
  for (const f of meta.conquest.flags) {
    const c = f.cache, at = `${id} ${f.id}`;
    ok(c && [c.x, c.y, c.z, c.yaw].every(Number.isFinite), `${at}: cache spot in the metadata`);
    const d = Math.hypot(c.x - f.x, c.z - f.z);
    ok(d >= FLAG_CACHE_RULES.ringMin && d <= FLAG_CACHE_RULES.ringMax, `${at}: ${d.toFixed(2)} m from the pole`);
    const floor = Math.floor(c.y) - 1, x = Math.floor(c.x), z = Math.floor(c.z);
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      ok(isSolidBlock(world.getBlock(x + dx, floor, z + dz)), `${at}: solid floor under the crates (${dx},${dz})`);
      for (let dy = 1; dy <= 3; dy++) {
        const b = world.getBlock(x + dx, floor + dy, z + dz);
        ok(b === AIR && b !== MC_WATER, `${at}: open, dry air over the floor (${dx},${dy},${dz}): no wall, door or water`);
      }
    }
    ok(f.spawns.every(s => Math.hypot(s.x - c.x, s.z - c.z) >= 2.5), `${at}: clear of the flag spawns`);
    eq(flagCacheSpot({ ...f, spawns: [] }, { topY: () => Math.floor(f.y) - 1, center: { x: f.x + 10, z: f.z } }).z, Math.floor(f.z) + 0.5,
      `${at}: the picker is deterministic and starts toward the map centre`);
  }
  // Conquest and Breakthrough share the capture rows: the cache rides them.
  const capture = new CaptureSystem(CONQUEST_RULES);
  capture.reset(meta.conquest.flags);
  ok(capture.flags.every(f => f.cache && f.cache.x === meta.conquest.flags.find(m => m.id === f.id).cache.x), `${id}: capture rows carry the cache`);
}
eq(flagCacheSpot({ x: 50, z: 50, spawns: [] }, { topY: () => 10, waterY: () => 12 }), null, 'no spot in water');
ok(flagCacheSpot({ x: 50, z: 50, spawns: [] }, { topY: () => 25, waterY: () => 20 }), 'a deck over the river is dry');

// ------------------------------------------------------------- server --
const DIMS = { sx: 256, sy: 64, sz: 256 };
let floorSolid = true;
const engine = { now: 100000, entities: new Map(), world: { getBlock: (_x, y) => (y < 10 && floorSolid ? 1 : 0) } };
const flag = { id: 'A', name: 'A', x: 100, y: 10.02, z: 100, radius: 20, owner: 'alpha', control: 1, state: 'idle', alpha: 0, bravo: 0,
  cache: { x: 106.5, y: 10.02, z: 100.5, yaw: 0 } };
const policy = { engine, _entities: engine.entities, capture: { flags: [flag] }, teamFor: p => p?.team ?? null,
  award() {}, _emit() {}, refundTicket() {}, phase: 'live' };
const roles = createConquestRoles({ policy, engine, rules: CONQUEST_RULES });
policy.roles = roles;
const caches = new FlagCaches(policy);
policy.flagCaches = caches;
const add = (id, team, kit, x, z) => {
  const p = new PlayerEntity(id, id, { x, y: 10.02, z }, false, DIMS);
  p.team = team; engine.entities.set(id, p);
  roles.applyLoadout(p, kit, 0); roles.onRespawn(p);
  return p;
};
const drain = p => {
  const l = roles.loadoutOf(p), load = kitLoadout(l.kit, l.variant, l.gadget);
  p.reserve[load.weapon] = 0; p.grenades.fill(0); p.medkit.remaining = 0;
  if (load.gadget) { const g = WEAPON_IDS.indexOf(load.gadget); p.reserve[g] = 0; p.mag[g] = 0; }
  return load;
};
const holder = add('a1', 'alpha', 'engineer', 107, 101);
const far = add('a2', 'alpha', 'assault', 112, 100);
const enemy = add('b1', 'bravo', 'assault', 106, 100);
const load = drain(holder); drain(far); drain(enemy);
const reserveOf = p => p.reserve[kitLoadout(roles.loadoutOf(p).kit).weapon];
const tick = ms => { engine.now += ms; caches.tick(engine.now); };
tick(0);
ok(reserveOf(holder) > 0 && holder.grenades.some(g => g > 0), 'the holder at the cache gets a magazine and a grenade');
eq(holder.medkit.remaining, 1, 'and a bandage');
const gslot = WEAPON_IDS.indexOf(load.gadget);
eq(holder.reserve[gslot], 1, 'and an AT round (the Engineer launcher)');
eq(reserveOf(far), 0, 'a holder 6 m from the cache gets nothing (4 m reach)');
eq(reserveOf(enemy), 0, 'the enemy at the cache gets nothing (holder only)');
const r1 = reserveOf(holder);
tick(FLAG_CACHE_RULES.tickMs - 100);
eq(reserveOf(holder), r1, 'nothing before the next 3 s pulse');
tick(100);
ok(reserveOf(holder) > r1, 'the next magazine comes on the 3 s pulse');
eq(holder.medkit.remaining, 1, 'no second bandage before bandageMs');
holder.medkit.remaining = 0; holder.reserve[gslot] = 0;
const paidAt = engine.now - FLAG_CACHE_RULES.tickMs, step = FLAG_CACHE_RULES.tickMs;
while (engine.now + step < paidAt + FLAG_CACHE_RULES.gadgetMs) tick(step);
eq(holder.reserve[gslot], 0, 'no AT round before gadgetMs');
tick(step);
eq(holder.reserve[gslot], 1, 'the AT round comes back gadgetMs after the last');
eq(holder.medkit.remaining, 0, 'still no bandage before bandageMs');
while (engine.now < paidAt + FLAG_CACHE_RULES.bandageMs) tick(step);
eq(holder.medkit.remaining, 1, 'one bandage again bandageMs after the last');

// Contested, neutral, lost floor and seated: inert.
drain(holder);
flag.bravo = 1;
tick(FLAG_CACHE_RULES.tickMs);
eq(reserveOf(holder), 0, 'an enemy in the zone stops the cache');
eq(flagCacheTeam(flag), null);
flag.bravo = 0; flag.owner = null;
tick(FLAG_CACHE_RULES.tickMs);
eq(reserveOf(holder), 0, 'a neutral flag pays no one');
flag.owner = 'bravo';
tick(FLAG_CACHE_RULES.tickMs);
eq(reserveOf(holder), 0, 'an enemy-held flag pays the old holder nothing');
ok(reserveOf(enemy) > 0, 'the new holder is served at once');
flag.owner = 'alpha'; floorSolid = false;
tick(FLAG_CACHE_RULES.tickMs);
eq(reserveOf(holder), 0, 'the floor gone (a fallen span or a breach): the cache is quiet');
floorSolid = true; holder.vehicleId = 'jeep-1';
tick(FLAG_CACHE_RULES.tickMs);
eq(reserveOf(holder), 0, 'a seated soldier is not served');
holder.vehicleId = null;
tick(FLAG_CACHE_RULES.tickMs);
ok(reserveOf(holder) > 0, 'back on foot at a held, quiet flag it pays again');
ok(inFlagCacheReach(flag.cache, { x: 106.5, y: 12, z: 104 }) && !inFlagCacheReach(flag.cache, { x: 106.5, y: 14, z: 100.5 }), 'reach: 4 m flat, 2.5 m height band');

// --------------------------------------------------------------- bots --
{
  const commander = { game: { mode: { policy } }, walkablePoint: p => p };
  const runs = new Map();
  const bot = add('bot-1', 'alpha', 'assault', 160, 100);
  const now = engine.now;
  eq(flagCacheGoal(commander, bot, 'alpha', { runs, now }), null, 'a full bot does not go');
  const issue = kitLoadout('assault');
  bot.reserve[issue.weapon] = Math.floor(issue.reserve[issue.weapon] * 0.3);
  ok(botSupplyState(bot, roles.loadoutOf(bot)).share < FLAG_CACHE_RULES.botReserveShare, 'under 35 % reserve');
  const goal = flagCacheGoal(commander, bot, 'alpha', { runs, now });
  ok(goal && goal.role === 'supply' && goal.point.x === flag.cache.x && goal.target.id === 'A', 'a low bot walks to the held flag cache');
  flag.bravo = 2;
  eq(flagCacheGoal(commander, bot, 'alpha', { runs, now }), null, 'no run to a contested cache');
  flag.bravo = 0;
  bot.reserve[issue.weapon] = issue.reserve[issue.weapon]; bot.medkit.remaining = 0; bot.hp = 60;
  ok(flagCacheGoal(commander, bot, 'alpha', { runs, now }), 'no bandage and under 70 HP: a run');
  bot.medkit.remaining = 1;
  eq(flagCacheGoal(commander, bot, 'alpha', { runs, now }), null, 'topped up: the run ends');
  bot.x = 400; bot.reserve[issue.weapon] = 0; runs.clear();
  eq(flagCacheGoal(commander, bot, 'alpha', { runs, now }), null, 'no held cache within 150 m');
  bot.x = 160;
  eq(flagCacheGoal(commander, bot, 'alpha', { runs, now, order: { allIn: true } }), null, 'an all-in order comes first');
}

// --------------------------------------------------------- client side --
{
  const meta = { flags: [{ id: 'A', name: 'A', x: 100, y: 10.02, z: 100, radius: 20, cache: flag.cache }] };
  flag.owner = 'alpha'; flag.bravo = 0; flag.alpha = 1;
  const cq = decodeConquestMatch({ v: 7, flags: [encodeConquestFlag(flag)] }, meta);
  eq(cq.flags[0].cache, flag.cache, 'the decoder carries the cache spot');
  const self = { id: 'a1', team: 'alpha', state: 'alive', hp: 80, x: 106, y: 10.02, z: 101 };
  ok(flagCacheServing(cq, self, 'alpha'), 'RESUPPLYING for the holder at the cache');
  ok(!flagCacheServing(cq, { ...self, team: 'bravo' }, 'bravo'), 'never for the enemy');
  ok(!flagCacheServing(cq, { ...self, x: 112 }, 'alpha'), 'not out of reach');
  ok(!flagCacheServing(cq, { ...self, vehicleId: 'v' }, 'alpha'), 'not seated');
  eq(flagSupplyPip(cq.flags[0], 'alpha'), 'on', 'held flag: supply pip on');
  eq(flagSupplyPip(cq.flags[0], 'bravo'), null, 'enemy flag: no pip');
  eq(mapItems({ cq, self, selfTeam: 'alpha' }).find(i => i.kind === 'flag').supply, 'on', 'the minimap item carries the pip');
  const contested = decodeConquestMatch({ v: 7, flags: [encodeConquestFlag({ ...flag, bravo: 1, state: 'contested' })] }, meta);
  eq(flagSupplyPip(contested.flags[0], 'alpha'), 'off', 'contested: the pip greys');
  ok(!flagCacheServing(contested, self, 'alpha'), 'contested: no tag');

  globalThis.document = { createElement: () => ({ getContext: () => new Proxy({}, { get: () => () => {}, set: () => true }) }) };
  let solid = true;
  const scene = new THREE.Scene();
  const world = new ConquestWorld(scene, meta, { getBlock: (_x, y) => (y < 10 && solid ? 1 : 0) });
  eq(world.stats.draws, 5 + 2, 'one flag in five draws plus the crate and strip draws');
  const m = new THREE.Matrix4(), pos = new THREE.Vector3();
  world.caches.getMatrixAt(0, m); pos.setFromMatrixPosition(m);
  ok(Math.abs(pos.x - 106.5) < 1e-6 && Math.abs(pos.y - 10.01) < 1e-6, 'the crates sit on the floor at the spot');
  world.setViewerTeam('alpha');
  world.sync({ mode: 'conquest', conquest: { flags: [encodeConquestFlag(flag)] } }); world.update(0.016);
  const c = new THREE.Color(); world.cacheStrips.getColorAt(0, c);
  eq(c.getHex(), 0x4cc3ff, 'the strip shows the holder (own blue)');
  solid = false; world.applyDeltas([{ x: 106, y: 9, z: 100 }]); world.update(0.016);
  world.caches.getMatrixAt(0, m); pos.setFromMatrixPosition(m);
  ok(m.elements[0] === 0 && !world.flags.get('A').cacheShown, 'a gone floor hides the crates');
  world.dispose();
}

console.log(`Conquest flag supply caches passed (${checks} checks): every Frontier and Redrock flag has a dry, open cache spot 4-8 m from its pole; holder only, contested and neutral stop it, 3 s magazines and grenades, ${FLAG_CACHE_RULES.bandageMs / 1000} s bandages, ${FLAG_CACHE_RULES.gadgetMs / 1000} s gadget rounds; HUD tag, map pip, world prop and bot runs.`);
