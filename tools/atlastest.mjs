// Headless sanity checks for the voxel engine's pure logic + real geometry
// classes (three.module.js loads fine under node; nothing here touches canvas
// or WebGL). Run: node tools/atlastest.mjs

import {
  TILE, TILE_PAINTERS, tileRect, faceTile, wob,
  DEFAULT_BLOCK_TILES, ATLAS_SIZE, TILE_PX, GRID,
} from '../public/js/engine/atlas.js';
import {
  AIR, LEAVES, GLASS, GRASS, WOOD, SX, SZ, SY, BLOCK_HP,
  getBlock as getWorldBlock, setBlock as setWorldBlock, heightAt,
  serializeWorld, deserializeWorld, createWorldState, createMapState,
  getMapMeta, MAP_IDS as WORLD_MAP_IDS,
} from '../shared/worlddata.js';
import {
  MODE_IDS, TEAM_IDS, MAP_IDS, MODE_RULES, WEAPON_PRICES,
  START_CREDITS, KILL_CREDITS, PLANT_CREDITS, ROUND_WIN_CREDITS,
  MAX_CREDITS, LOSS_CREDIT_LADDER, MAP_MODE_COMPATIBILITY,
  normalizeModeId, normalizeTeamId, normalizeMapId, normalizeWeaponId,
  isModeMapCompatible,
} from '../shared/modes.js';
import { raycastVoxels } from '../shared/raycast.js';
import {
  ChunkStore, aoLevel, FACE_SHADE, CHUNK_X,
  MAX_REBUILDS_PER_FRAME,
} from '../public/js/engine/chunks.js';
import * as THREE from '../public/js/vendor/three.module.js';
import { WEAPONS, WEAPON_IDS } from '../shared/combatmath.js';
import { GameEngine } from '../server/game.js';

let failures = 0;
function ok(cond, msg) {
  if (!cond) { failures++; console.error('FAIL ' + msg); }
}

// ------------------------------------------------------------------ wob
for (let i = 0; i < 5000; i++) {
  const v = wob(i % 64, i % 37, i % 9, 100);
  if (v < 0 || v >= 100) { ok(false, 'wob range ' + v); break; }
}
ok(wob(3, 4, 5, 97) === wob(3, 4, 5, 97), 'wob deterministic');

// ------------------------------------------------------------- painters
for (const [key, paint] of Object.entries(TILE_PAINTERS)) {
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const c = paint(x, y);
      const t = Number(key);
      if (!Array.isArray(c) || c.length !== 4 || c.some((ch) => !Number.isFinite(ch))) {
        ok(false, `tile ${t} bad pixel ${x},${y}`);
        break;
      }
    }
  }
}
{
  const p = TILE_PAINTERS[TILE.LEAVES];
  let holes = 0;
  let same = true;
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const c = p(x, y);
      const d = p(x, y);
      if (c[0] !== d[0] || c[3] !== d[3]) same = false;
      if (c[3] === 0) holes++;
    }
  }
  ok(same, 'painter determinism');
  ok(holes >= 30 && holes <= 45, `leaves hole px ~15% of 256 (got ${holes})`);
}
ok(TILE_PAINTERS[TILE.GLASS](5, 5)[3] === 200, 'glass interior alpha');
ok(TILE_PAINTERS[TILE.GLASS](0, 7)[3] === 235, 'glass frame alpha');

// -------------------------------------------------------------- uv rects
for (let t = 0; t < GRID * GRID; t++) {
  const r = tileRect(t);
  if (!(r.u0 > (t % GRID) / GRID && r.u1 < ((t % GRID) + 1) / GRID)) {
    ok(false, `rect inset u tile ${t}`);
    break;
  }
}
const rGT = tileRect(TILE.GRASS_TOP);
const rGS = tileRect(TILE.GRASS_SIDE);
ok(rGT !== rGS && rGT.u0 !== rGS.u0, 'distinct tiles -> distinct rects');
ok(tileRect(TILE.DIRT) === tileRect(TILE.DIRT), 'rect cache stable identity');
ok(rGT.v0 > rGT.v1, 'v0 is image top (high v)');
ok(Math.abs((rGT.u1 - rGT.u0) - (rGT.v0 - rGT.v1)) < 1e-6, 'square rect');
const gtCol = TILE.GRASS_TOP % GRID;
const gtRow = (TILE.GRASS_TOP / GRID) | 0;
const insetPx = [
  (rGT.u0 - gtCol * TILE_PX / ATLAS_SIZE) * ATLAS_SIZE,
  ((gtCol + 1) * TILE_PX / ATLAS_SIZE - rGT.u1) * ATLAS_SIZE,
  (1 - gtRow * TILE_PX / ATLAS_SIZE - rGT.v0) * ATLAS_SIZE,
  (rGT.v1 - (1 - (gtRow + 1) * TILE_PX / ATLAS_SIZE)) * ATLAS_SIZE,
];
ok(insetPx.every((v) => Math.abs(v - 0.5) < 1e-12), 'tile rect uses an exact half-pixel inset');

// ---------------------------------------------------------- face mapping
ok(faceTile(GRASS, 2) === TILE.GRASS_TOP, 'grass top');
ok(faceTile(GRASS, 3) === TILE.DIRT, 'grass bottom -> dirt');
ok(faceTile(GRASS, 0) === TILE.GRASS_SIDE, 'grass side lip');
ok(faceTile(WOOD, 2) === TILE.WOOD_RINGS, 'wood top rings');
ok(faceTile(WOOD, 4) === TILE.WOOD_BARK, 'wood side bark');
ok(faceTile(LEAVES, 0) === TILE.LEAVES, 'leaves uniform');
ok(DEFAULT_BLOCK_TILES[GLASS].all === TILE.GLASS, 'glass uniform');

// ------------------------------------------------------ shared world data
{
  const bytesEqual = (a, b) => {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  };

  const pristineA = createWorldState();
  const pristineB = createWorldState();
  const pristineBytes = pristineA.serializeWorld();
  ok(bytesEqual(pristineBytes, pristineB.serializeWorld()),
    'fresh world states contain identical pristine arenas');
  ok(bytesEqual(pristineBytes, serializeWorld()),
    'fresh world state matches the pristine default arena');
  ok(pristineBytes.length === 6 + SX * SY * SZ
    && pristineBytes[0] === 86 && pristineBytes[1] === 66 && pristineBytes[2] === 1
    && pristineBytes[3] === SX && pristineBytes[4] === SZ && pristineBytes[5] === SY,
  'world state serialization keeps the exact VB header and payload length');

  const x = 64, z = 48, y = pristineA.heightAt(x, z);
  const pristineBlock = pristineA.getBlock(x, y, z);
  ok(pristineBlock !== AIR, 'world isolation probe starts on a solid pristine block');
  pristineA.setBlock(x, y, z, AIR);
  ok(pristineA.getBlock(x, y, z) === AIR
    && pristineB.getBlock(x, y, z) === pristineBlock,
  'mutating one world state leaves a second world state unchanged');

  const reconstructed = createWorldState(pristineBytes);
  const reconstructedPeer = createWorldState(pristineBytes);
  ok(bytesEqual(reconstructed.serializeWorld(), pristineBytes),
    'world state reconstructs exactly from serialized bytes');
  reconstructed.setBlock(x, y, z, AIR);
  ok(reconstructedPeer.getBlock(x, y, z) === pristineBlock
    && pristineB.getBlock(x, y, z) === pristineBlock,
  'reconstructed worlds own independent block storage');

  const singletonBlock = getWorldBlock(x, y, z);
  setWorldBlock(x, y, z, singletonBlock === AIR ? GRASS : AIR);
  const afterSingletonMutation = createWorldState();
  ok(afterSingletonMutation.getBlock(x, y, z) === pristineBlock
    && bytesEqual(afterSingletonMutation.serializeWorld(), pristineBytes),
  'fresh world state ignores mutations to the default singleton');
  setWorldBlock(x, y, z, singletonBlock);

  const engineA = new GameEngine();
  const engineB = new GameEngine();
  const engineY = engineA.world.heightAt(x, z);
  const engineBlock = engineA.world.getBlock(x, engineY, z);
  engineA.world.setBlock(x, engineY, z, AIR);
  ok(engineBlock !== AIR
    && engineA.world.getBlock(x, engineY, z) === AIR
    && engineB.world.getBlock(x, engineY, z) === engineBlock,
  'GameEngine defaults own independent worlds for block destruction');
}

{
  const bytes = serializeWorld();
  ok(bytes.length === 6 + SX * SY * SZ
    && bytes[0] === 86 && bytes[1] === 66 && bytes[2] === 1
    && bytes[3] === SX && bytes[4] === SZ && bytes[5] === SY,
  'map bytes carry the exact versioned header and payload length');

  const heights = new Int16Array(SX * SZ);
  for (let z = 0; z < SZ; z++)
    for (let x = 0; x < SX; x++) heights[z * SX + x] = heightAt(x, z);
  deserializeWorld(bytes);
  let heightsMatch = true;
  for (let z = 0; z < SZ && heightsMatch; z++)
    for (let x = 0; x < SX; x++)
      if (heightAt(x, z) !== heights[z * SX + x]) { heightsMatch = false; break; }
  ok(heightsMatch, 'map load preserves fixed-seed terrain heights beneath structures');

  const rejects = (candidate) => {
    try { deserializeWorld(candidate); return false; } catch { return true; }
  };
  const badMagic = bytes.slice(); badMagic[0] = 0;
  const badVersion = bytes.slice(); badVersion[2]++;
  const badDims = bytes.slice(); badDims[3]--;
  const extended = new Uint8Array(bytes.length + 1); extended.set(bytes);
  ok(rejects(badMagic) && rejects(badVersion) && rejects(badDims)
    && rejects(bytes.subarray(0, bytes.length - 1)) && rejects(extended),
  'map load rejects bad magic, version, dimensions, and non-exact lengths');
  ok(getWorldBlock(64, heightAt(64, 48), 48) !== 0, 'valid map remains loaded after rejected frames');
}

// ---------------------------------------------- mode + map foundation contract
{
  const sameValue = (actual, expected) => {
    if (Object.is(actual, expected)) return true;
    if (!actual || !expected || typeof actual !== 'object' || typeof expected !== 'object')
      return false;
    if (Array.isArray(actual) !== Array.isArray(expected)) return false;
    const actualKeys = Object.keys(actual).sort();
    const expectedKeys = Object.keys(expected).sort();
    return actualKeys.length === expectedKeys.length
      && actualKeys.every((key, i) =>
        key === expectedKeys[i] && sameValue(actual[key], expected[key]));
  };
  const deeplyFrozen = (value) => !value || typeof value !== 'object'
    || (Object.isFrozen(value) && Object.values(value).every(deeplyFrozen));
  const bytesEqual = (a, b) => {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  };
  const fnv1a = (bytes) => {
    let hash = 2166136261;
    for (let i = 0; i < bytes.length; i++) {
      hash ^= bytes[i];
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  };

  ok(sameValue(MODE_IDS, ['fun', 'tdm', 'snd'])
    && sameValue(MAP_IDS, ['foundry', 'depot', 'citadel'])
    && sameValue(TEAM_IDS, ['alpha', 'bravo'])
    && WORLD_MAP_IDS === MAP_IDS
    && deeplyFrozen(MODE_IDS) && deeplyFrozen(MAP_IDS) && deeplyFrozen(TEAM_IDS),
  'mode, map, and team identifiers are exact immutable shared lists');

  const expectedRules = {
    fun: {
      teams: false,
      friendlyFire: true,
      respawnMs: 1500,
    },
    tdm: {
      teams: true,
      friendlyFire: false,
      respawnMs: 3000,
      scoreLimit: 40,
      postMs: 5000,
    },
    snd: {
      teams: true,
      friendlyFire: false,
      prepMs: 10000,
      liveMs: 90000,
      postMs: 5000,
      roundsPerHalf: 6,
      roundWins: 7,
      pickupRadius: 1.4,
      plantMs: 3000,
      defuseRadius: 2,
      defuseMs: 5000,
      fuseMs: 40000,
      startCredits: 800,
      killCredits: 300,
      plantCredits: 300,
      roundWinCredits: 3250,
      lossCredits: [1400, 1900, 2400, 2900, 3400],
      maxCredits: 16000,
    },
  };
  ok(sameValue(MODE_RULES, expectedRules) && deeplyFrozen(MODE_RULES),
    'mode rules are exact and recursively immutable');

  const expectedPrices = {
    revolver: 0,
    smg: 1250,
    shotgun: 1800,
    rifle: 2700,
    lmg: 4000,
    sniper: 4750,
  };
  ok(sameValue(WEAPON_PRICES, expectedPrices)
    && deeplyFrozen(WEAPON_PRICES)
    && START_CREDITS === 800
    && KILL_CREDITS === 300
    && PLANT_CREDITS === 300
    && ROUND_WIN_CREDITS === 3250
    && MAX_CREDITS === 16000
    && sameValue(LOSS_CREDIT_LADDER, [1400, 1900, 2400, 2900, 3400])
    && deeplyFrozen(LOSS_CREDIT_LADDER)
    && MODE_RULES.snd.lossCredits === LOSS_CREDIT_LADDER,
  'Search and Destroy prices and credit economy are exact immutable values');

  const expectedCompatibility = {
    foundry: ['fun', 'tdm', 'snd'],
    depot: ['fun', 'tdm'],
    citadel: ['fun', 'tdm', 'snd'],
  };
  ok(sameValue(MAP_MODE_COMPATIBILITY, expectedCompatibility)
    && deeplyFrozen(MAP_MODE_COMPATIBILITY)
    && MAP_IDS.every((mapId) => MODE_IDS.every((modeId) =>
      isModeMapCompatible(modeId, mapId)
        === expectedCompatibility[mapId].includes(modeId)))
    && !isModeMapCompatible('invalid', 'foundry')
    && !isModeMapCompatible('fun', 'invalid'),
  'mode and map compatibility is exact, immutable, and rejects unknown identifiers');

  ok(MODE_IDS.every((id) => normalizeModeId(id) === id)
    && TEAM_IDS.every((id) => normalizeTeamId(id) === id)
    && MAP_IDS.every((id) => normalizeMapId(id) === id)
    && Object.keys(WEAPON_PRICES).every((id) => normalizeWeaponId(id) === id)
    && normalizeModeId('FUN', 'tdm') === 'tdm'
    && normalizeModeId(null, 'invalid') === 'fun'
    && normalizeTeamId('attackers', 'bravo') === 'bravo'
    && normalizeTeamId(null, 'invalid') === 'alpha'
    && normalizeMapId('Depot', 'citadel') === 'citadel'
    && normalizeMapId(null, 'invalid') === 'foundry'
    && normalizeWeaponId('laser', 'rifle') === 'rifle'
    && normalizeWeaponId(null, 'invalid') === 'revolver',
  'shared normalizers preserve canonical ids and apply validated/default fallbacks');

  const expectedMapNames = {
    foundry: 'Foundry',
    depot: 'Depot',
    citadel: 'Citadel',
  };
  const expectedMapHashes = {
    foundry: '78553d52',
    depot: '6432c666',
    citadel: '3905a525',
  };
  const expectedSpawnCounts = {
    foundry: { fun: 12, tdmAlpha: 6, tdmBravo: 6, sndAttackers: 5, sndDefenders: 5 },
    depot: { fun: 12, tdmAlpha: 6, tdmBravo: 6, sndAttackers: 0, sndDefenders: 0 },
    citadel: { fun: 12, tdmAlpha: 6, tdmBravo: 6, sndAttackers: 6, sndDefenders: 6 },
  };
  const pristineBytes = new Map();

  for (const mapId of MAP_IDS) {
    const roomA = createMapState(mapId);
    const roomB = createMapState(mapId);
    const bytes = roomA.serializeWorld();
    pristineBytes.set(mapId, bytes);
    ok(bytes.length === 6 + SX * SY * SZ
      && bytes[0] === 86 && bytes[1] === 66 && bytes[2] === 1
      && bytes[3] === SX && bytes[4] === SZ && bytes[5] === SY
      && fnv1a(bytes) === expectedMapHashes[mapId],
    `${mapId} template keeps its exact VB header, length, and byte fingerprint`);

    const meta = getMapMeta(mapId);
    const counts = expectedSpawnCounts[mapId];
    ok(roomA.mapId === mapId && roomA.meta === meta && roomB.meta === meta
      && meta.id === mapId && meta.name === expectedMapNames[mapId]
      && meta.modes === MAP_MODE_COMPATIBILITY[mapId]
      && meta.spawns.fun.length === counts.fun
      && meta.spawns.tdm.alpha.length === counts.tdmAlpha
      && meta.spawns.tdm.bravo.length === counts.tdmBravo
      && meta.spawns.snd.attackers.length === counts.sndAttackers
      && meta.spawns.snd.defenders.length === counts.sndDefenders
      && deeplyFrozen(meta),
    `${mapId} metadata is exact, shared safely, and recursively immutable`);

    const spawnPools = [
      meta.spawns.fun,
      meta.spawns.tdm.alpha,
      meta.spawns.tdm.bravo,
      meta.spawns.snd.attackers,
      meta.spawns.snd.defenders,
    ];
    let spawnsAreWalkable = true;
    for (const pool of spawnPools) {
      for (const spawn of pool) {
        const x = Math.floor(spawn.x);
        const y = Math.floor(spawn.y);
        const z = Math.floor(spawn.z);
        if (!Number.isFinite(spawn.x) || !Number.isFinite(spawn.y)
          || !Number.isFinite(spawn.z)
          || x < 0 || x >= SX || z < 0 || z >= SZ || y <= 0 || y >= SY - 1
          || roomA.getBlock(x, y - 1, z) === AIR
          || roomA.getBlock(x, y, z) !== AIR
          || roomA.getBlock(x, y + 1, z) !== AIR) {
          spawnsAreWalkable = false;
          break;
        }
      }
      if (!spawnsAreWalkable) break;
    }
    ok(spawnsAreWalkable,
      `${mapId} spawn metadata has solid footing and two-block headroom`);

    const probe = meta.spawns.fun[0];
    const x = Math.floor(probe.x);
    const z = Math.floor(probe.z);
    const probeY = Math.floor(probe.y) + 1;
    const originalHeight = roomA.heightAt(x, z);
    const engineA = new GameEngine({ world: roomA });
    const engineB = new GameEngine({ world: roomB });
    roomA.setBlock(x, probeY, z, GLASS);
    roomA.rebuildHeightMap();
    ok(roomA.getBlock(x, probeY, z) === GLASS
      && roomB.getBlock(x, probeY, z) === AIR
      && roomA.heightAt(x, z) === probeY
      && roomB.heightAt(x, z) === originalHeight,
    `${mapId} room cells and rebuilt height maps are isolated`);

    const key = engineA.blockKey(x, probeY, z);
    engineA.damageBlock(x, probeY, z, GLASS, 1);
    ok(engineA.blockHp.get(key) === BLOCK_HP[GLASS] - 1
      && !engineB.blockHp.has(key)
      && engineA.tickBlocks.length === 0
      && engineB.tickBlocks.length === 0,
    `${mapId} partial block damage is isolated per room`);
    engineA.damageBlock(x, probeY, z, GLASS, BLOCK_HP[GLASS]);
    ok(roomA.getBlock(x, probeY, z) === AIR
      && roomB.getBlock(x, probeY, z) === AIR
      && !engineA.blockHp.has(key) && !engineB.blockHp.has(key)
      && engineA.tickBlocks.length === 1
      && engineA.tickBlocks[0].i === ((probeY * SZ + z) * SX + x)
      && engineA.tickBlocks[0].v === AIR
      && engineB.tickBlocks.length === 0,
    `${mapId} destruction deltas are isolated per room`);
    roomA.rebuildHeightMap();
    ok(roomA.heightAt(x, z) === originalHeight
      && roomB.heightAt(x, z) === originalHeight
      && bytesEqual(roomB.serializeWorld(), bytes)
      && bytesEqual(createMapState(mapId).serializeWorld(), bytes),
    `${mapId} room mutations cannot alter peers or the cached template`);
  }

  const depot = createMapState('depot');
  let depotIsPointSymmetric = true;
  symmetry:
  for (let y = 0; y < SY; y++) {
    for (let z = 0; z < SZ; z++) {
      for (let x = 0; x < SX; x++) {
        if (depot.getBlock(x, y, z)
          !== depot.getBlock(SX - 1 - x, y, SZ - 1 - z)) {
          depotIsPointSymmetric = false;
          break symmetry;
        }
      }
    }
  }
  ok(depotIsPointSymmetric,
    'Depot blocks preserve exact 180-degree point symmetry');

  const citadel = createMapState('citadel');
  const expectedCitadelSites = [
    { id: 'A', minX: 21, maxX: 34, minZ: 18, maxZ: 30, y: 15.02 },
    { id: 'B', minX: 97, maxX: 108, minZ: 42, maxZ: 54, y: 18.02 },
  ];
  const [siteA, siteB] = citadel.meta.sites;
  let sitesOverlap = true;
  let sightlineLength = 0;
  let sightlineBlock = null;
  if (siteA && siteB) {
    sitesOverlap = siteA.minX <= siteB.maxX && siteB.minX <= siteA.maxX
      && siteA.minZ <= siteB.maxZ && siteB.minZ <= siteA.maxZ;
    const ax = (siteA.minX + siteA.maxX + 1) / 2;
    const az = (siteA.minZ + siteA.maxZ + 1) / 2;
    const bx = (siteB.minX + siteB.maxX + 1) / 2;
    const bz = (siteB.minZ + siteB.maxZ + 1) / 2;
    const ay = siteA.y + 1.62;
    const by = siteB.y + 1.62;
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    sightlineLength = Math.hypot(dx, dy, dz);
    sightlineBlock = raycastVoxels(
      (x, y, z) => citadel.getBlock(x, y, z) !== AIR,
      ax, ay, az, dx, dy, dz, sightlineLength
    );
  }
  ok(sameValue(citadel.meta.sites, expectedCitadelSites)
    && !sitesOverlap
    && sightlineBlock !== null
    && sightlineBlock.t < sightlineLength
    && sightlineBlock.x >= 48 && sightlineBlock.x <= 78,
  'Citadel has exact disjoint A/B objectives with the keep blocking direct sightline');

  const foundryBytes = pristineBytes.get('foundry');
  const defaultFoundry = createWorldState();
  const restoredFoundry = createWorldState(foundryBytes);
  ok(defaultFoundry.mapId === 'foundry'
    && defaultFoundry.meta === getMapMeta('foundry')
    && restoredFoundry.mapId === 'foundry'
    && restoredFoundry.meta === getMapMeta('foundry')
    && bytesEqual(defaultFoundry.serializeWorld(), foundryBytes)
    && bytesEqual(restoredFoundry.serializeWorld(), foundryBytes),
  'createWorldState remains the default Foundry API with byte restoration support');
}

// -------------------------------------------------------------------- AO
ok(aoLevel(0, 0, 0) === 1.0, 'open corner brightest');
ok(aoLevel(1, 1, 0) === 0.42, 'two sides -> forced darkest (corner rule)');
ok(aoLevel(1, 0, 0) === 0.82, 'one side sample');
ok(aoLevel(0, 0, 0) > aoLevel(1, 0, 0) && aoLevel(1, 0, 0) > aoLevel(1, 1, 1), 'AO monotonic');
ok(FACE_SHADE[2] === 1.0 && FACE_SHADE[3] === 0.58, 'top/bottom shades per spec');

// ------------------------------------------------- real geometry smoke
const WSX = 24, WSY = 12, WSZ = 24;
const blocks = new Uint8Array(WSX * WSY * WSZ);
const idxOf = (x, y, z) => (y * WSZ + z) * WSX + x;
blocks[idxOf(8, 4, 8)] = GRASS;
blocks[idxOf(9, 4, 8)] = 10;          // PLANK
blocks[idxOf(8, 4, 9)] = LEAVES;
blocks[idxOf(8, 4, 10)] = GLASS;
blocks[idxOf(12, 4, 12)] = 8;         // METAL
blocks[idxOf(13, 4, 12)] = 2;         // DIRT
function getBlock(x, y, z) {
  if (y < 0 || x < 0 || z < 0 || x >= WSX || z >= WSZ || y >= WSY) return 13; // treat OOB solid
  return blocks[idxOf(x, y, z)];
}
const stubAtlas = { texture() { return {}; }, tileRect, faceTile };
const scene = new THREE.Scene();
const store = new ChunkStore(scene, stubAtlas, getBlock);
for (let cx = 0; cx < 2; cx++) for (let cz = 0; cz < 2; cz++) store.rebuildChunk(cx, cz);

const meshes = [];
scene.traverse((o) => { if (o.isMesh) meshes.push(o); });
ok(meshes.length > 0, 'meshes produced');
for (const m of meshes) {
  const g = m.geometry;
  ok(g.index.count % 6 === 0, `${m.name}: quad index multiples`);
  ok(g.attributes.position.count === g.attributes.color.count, `${m.name}: color pairs with position`);
  ok(g.attributes.uv.count === g.attributes.position.count, `${m.name}: uv pairs with position`);
  let maxIdx = 0;
  const ia = g.index.array;
  for (let i = 0; i < ia.length; i++) if (ia[i] > maxIdx) maxIdx = ia[i];
  ok(maxIdx < g.attributes.position.count, `${m.name}: index in bounds`);
}
const names = new Set(meshes.map((m) => m.name));
ok(names.has('cutout'), 'leaves built into cutout bucket');
ok(names.has('glass'), 'glass separate transparent bucket');
ok([...meshes].find((m) => m.name === 'glass')?.renderOrder === 2, 'glass renderOrder 2');

// quad-diagonal flip branch: lone block on a floor gives mixed corner occlusion
{
  // Floor at y=3 plus one raised block: top faces of the floor show the classic
  // diagonal asymmetry next to the pillar.
  const fx = (x, y, z) =>
    (y === 0 ? 3 : (x === 5 && z === 5 && y === 1 ? 1 : 0)); // slab + one pillar block
  const fs = new THREE.Scene();
  const fl = new ChunkStore(fs, stubAtlas, fx);
  fl.rebuildChunk(0, 0);
  let quads = 0;
  for (const m of fl.group.children) quads += m.geometry.index.count / 6;
  ok(quads > 20, `slab+pillar mesher produces full surface (${quads} quads)`);
}

// delta pipeline: mark dirty + budget drain + dispose safety
{
  blocks[idxOf(3, 3, 3)] = 9;
  store.applyBlockDelta(3, 3, 3, 9);
  const drained = store.update();
  ok(drained >= 1 && drained <= MAX_REBUILDS_PER_FRAME, 'update drains within budget');

  blocks[idxOf(16, 5, 5)] = 2;             // lx===0 inside chunk cx=1
  store.applyBlockDelta(16, 5, 5, 2);
  ok(store.dirtyQueue.length >= 2, 'edge delta queues neighbour chunk too');
  store.update();
}

// sky installs cleanly in node (no DOM required)
{
  const { installSky } = await import('../public/js/engine/sky.js');
  const skyScene = new THREE.Scene();
  const update = installSky(skyScene);
  ok(typeof update === 'function', 'installSky returns updater');
  ok(typeof update.dispose === 'function', 'sky updater exposes dispose');
  update(0.016);
  const dome = skyScene.getObjectByName('skydome');
  ok(dome && dome.renderOrder === -10, 'skydome renders first');
  const skyGroup = skyScene.getObjectByName('sky');
  ok(skyGroup.children.length === 15, 'dome + 14 clouds');
  const clouds = skyGroup.children.filter((c) => c !== dome);
  clouds[0].position.x = 64 + 240 + 4;       // just past maxX -> wrap expected
  update(1);                                  // +1.6 u/s drift crosses wrap line
  ok(clouds[0].position.x < 64 + 240, 'cloud wrapped back into bounds');
  update.dispose();
  ok(!skyScene.getObjectByName('sky'), 'sky dispose removes its group');
}


// ------------------------------------------------------ headless integration
// Stub the canvas surface buildAtlas() needs, then drive a REAL WorldView over
// the canonical generated arena: atlas assembly, chunk build, deltas, picking.
{
  const fakeCtx = {
    createImageData(w, h) { return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }; },
    putImageData() {},
  };
  let made = null;
  globalThis.document = {
    createElement() {
      made = { width: 0, height: 0, getContext: () => fakeCtx };
      return made;
    },
  };

  const world = await import('../shared/worlddata.js'); // generateWorld already ran
  const { WorldView } = await import('../public/js/engine/worldview.js');

  const view = new WorldView({ getBlock: world.getBlock });
  await view.ready();

  ok(made && made.width === 256 && made.height === 256, 'atlas canvas is 256x256');
  const tex = view.atlas.texture();
  ok(tex.anisotropy === 4
    && tex.generateMipmaps === true
    && tex.magFilter === THREE.NearestFilter
    && tex.minFilter === THREE.NearestMipmapLinearFilter, 'atlas texture spec flags');
  ok(view.scene.fog.density === 0.0055, 'fog density');
  ok(view.sun.intensity === 1.35 && !view.sun.castShadow, 'sun rig');
  const hemi = view.scene.children.find((c) => c.isHemisphereLight);
  ok(hemi && hemi.intensity === 0.55, 'hemisphere light');
  ok(view.chunkStore.stats.chunks === (world.SX / CHUNK_X) * (96 / 16), `48 column chunks (${view.chunkStore.stats.chunks})`);
  ok(view.scene.getObjectByName('skydome'), 'sky installed into view scene');

  // pick straight down from above map centre -> must strike real terrain
  const hit = view.pickCameraRay({ x: 64.5, y: 39.5, z: 48.5 }, { x: 0, y: -1, z: 0 }, 40);
  ok(hit !== null && hit.t >= 0 && hit.t <= 40, 'center pick hits terrain');
  if (hit) ok(hit.y < 39 && world.getBlock(hit.x, hit.y, hit.z) !== 0, 'pick voxel is solid');

  // smash a block near centre, push through the delta pipeline like netcode would
  const hx = hit ? hit.x : 64, hy = hit ? hit.y : 13;
  const originalBlock = world.getBlock(hx, hy, 48);
  world.setBlock(hx, hy, 48, 0);
  view.applyDeltas([{ x: hx, y: hy, z: 48, v: 0 }]);
  const queued = view.chunkStore.dirtyQueue.length;
  ok(queued > 0, 'WorldView delta queues an affected chunk');
  view.update(0.016);
  const drained = queued - view.chunkStore.dirtyQueue.length;
  ok(drained === Math.min(queued, MAX_REBUILDS_PER_FRAME),
    'WorldView update drains the queued chunks within the frame budget');

  world.setBlock(hx, hy, 48, originalBlock);
  view.dispose();
  delete globalThis.document;
}

// ------------------------------------------------ behavioral feature contracts
{
  const installGlobals = (values) => {
    const saved = new Map();
    for (const [name, value] of Object.entries(values)) {
      saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
      Object.defineProperty(globalThis, name, {
        configurable: true,
        enumerable: true,
        writable: true,
        value,
      });
    }
    return () => {
      for (const [name, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
    };
  };

  // Input: headless is a pointer-lock substitute, not a gameplay-suppression
  // bypass. Direct slots cover the full six-gun roster and wheel edges drain.
  {
    let input = null;
    let unlocked = null;
    const restore = installGlobals({ location: { search: '?headless=1' } });
    try {
      const { Input } = await import('../public/js/engine/input.js');
      input = new Input({});
      const key = (code, repeat = false) => ({
        code,
        repeat,
        preventDefault() {},
      });

      input._onKeyDown(key('Digit5'));
      ok(input.consumeWeaponSlot() === 4 && input.consumeWeaponSlot() === null,
        'headless Digit5 queues and consumes weapon slot five exactly once');
      input._onKeyDown(key('Digit6'));
      ok(input.consumeWeaponSlot() === 5,
        'headless Digit6 reaches the sixth weapon slot');

      let prevented = 0;
      input._onWheel({ deltaY: 12, preventDefault() { prevented++; } });
      input._onWheel({ deltaY: -3, preventDefault() { prevented++; } });
      ok(input.consumeWeaponSwitch() === 0 && prevented === 2,
        'headless wheel accumulates opposing weapon steps and prevents page scroll');
      input._onWheel({ deltaY: 1, preventDefault() {} });
      ok(input.consumeWeaponSwitch() === 1 && input.consumeWeaponSwitch() === 0,
        'headless wheel switch is a draining edge');

      input._onKeyDown(key('KeyE'));
      ok(input.getKeys().interact,
        'held E is exposed as interaction input');
      input._onKeyUp(key('KeyE'));
      ok(!input.getKeys().interact,
        'releasing E clears held interaction input');

      input.setGameplayEnabled(false);
      input._onKeyDown(key('Digit6'));
      input._onWheel({ deltaY: 1, preventDefault() {} });
      ok(input.consumeWeaponSlot() === null && input.consumeWeaponSwitch() === 0,
        'explicit gameplay suppression still blocks headless weapon input');

      globalThis.location = { search: '' };
      unlocked = new Input({});
      unlocked.setGameplayEnabled(false);
      unlocked._onKeyDown(key('KeyB'));
      unlocked._onKeyDown(key('KeyE'));
      unlocked._onKeyDown(key('KeyW'));
      unlocked._onKeyDown(key('Digit5'));
      unlocked._onWheel({ deltaY: 1, preventDefault() {} });
      unlocked._onMouseDown({
        button: 0,
        isTrusted: false,
        preventDefault() {},
      });
      const suppressedKeys = unlocked.getKeys();
      ok(!unlocked.isLocked()
        && unlocked.consumeBuyMenuRequest()
        && !suppressedKeys.interact
        && !suppressedKeys.forward
        && !unlocked.wantFireHeld
        && !unlocked.consumeFireTap()
        && unlocked.consumeWeaponSlot() === null
        && unlocked.consumeWeaponSwitch() === 0,
      'unlocked suppressed input admits the B UI edge but no gameplay input');
      unlocked._onKeyDown(key('KeyB', true));
      ok(!unlocked.consumeBuyMenuRequest(),
        'a physical B repeat cannot enqueue a second toggle');

      unlocked._onKeyUp(key('KeyB'));
      unlocked._onKeyDown(key('KeyB'));
      ok(unlocked.consumeBuyMenuRequest(),
        'B keyup while suppressed rearms exactly one close-capable UI edge');

      unlocked._onKeyUp(key('KeyB'));
      unlocked._onKeyDown(key('KeyB'));
      unlocked.clearTransient();
      ok(!unlocked.consumeBuyMenuRequest(),
        'transient reset clears a stale queued B edge');
      unlocked._onKeyDown(key('KeyB'));
      ok(unlocked.consumeBuyMenuRequest(),
        'transient reset also clears the held-B latch for a fresh physical edge');

      input.setGameplayEnabled(true);
      input._onKeyDown(key('KeyE'));
      input._onKeyDown(key('KeyB'));
      input.dispose();
      ok(!input.getKeys().interact
        && !input.consumeBuyMenuRequest(),
      'Input disposal clears held interaction and pending buy-menu state');
      input = null;
    } finally {
      input?.dispose();
      unlocked?.dispose();
      restore();
    }
  }

  // Viewmodel: every canonical weapon must build and survive a real update.
  // The generic magswap request resolves into the weapon's physical reload
  // profile, and identical mouse travel lags more as weapon mass increases.
  {
    const { TIMERS } = await import('../public/js/guns/defs.js');
    const { ViewmodelRig } = await import('../public/js/guns/viewmodel.js');
    const camera = new THREE.PerspectiveCamera(75, 1, 0.01, 100);
    const rig = new ViewmodelRig(camera);
    const lagByWeapon = new Map();
    try {
      for (const id of WEAPON_IDS) {
        rig.setWeapon(id);
        rig.reload(2, 'magswap');
        ok(rig._rl?.type === TIMERS[id].magTimeline.type,
          `${id} magswap resolves to its ${TIMERS[id].magTimeline.type} profile`);

        rig.update(0.016, {
          speed: 2.4,
          grounded: true,
          mouseDX: 1,
          mouseDY: -0.5,
        });
        lagByWeapon.set(id, Math.abs(rig._sway.x));
        ok(rig._id === id
          && rig._models[id]?.root.parent === rig.content
          && Number.isFinite(rig.posG.position.x)
          && Number.isFinite(rig.pivot.rotation.y),
        `${id} viewmodel builds, attaches, and updates to finite transforms`);
      }

      ok(Object.keys(rig._models).length === WEAPON_IDS.length,
        'one ViewmodelRig lazily constructs all six canonical weapon models');
      const byWeight = [...WEAPON_IDS].sort(
        (a, b) => WEAPONS[a].weightKg - WEAPONS[b].weightKg
      );
      ok(byWeight.every((id, i) =>
        i === 0 || lagByWeapon.get(byWeight[i - 1]) < lagByWeapon.get(id)),
      'viewmodel turn lag strictly follows canonical weapon-weight ordering');
    } finally {
      rig.dispose();
    }
  }

  // Audio: install the recording context before module evaluation so every
  // graph edge, source start, voice steal, and lifecycle transition is real.
  {
    class FakeAudioParam {
      constructor(value = 0) {
        this.value = value;
        this.events = [];
      }
      setValueAtTime(value, time) {
        this.value = value;
        this.events.push(['set', value, time]);
        return this;
      }
      linearRampToValueAtTime(value, time) {
        this.value = value;
        this.events.push(['linear', value, time]);
        return this;
      }
      exponentialRampToValueAtTime(value, time) {
        this.value = value;
        this.events.push(['exponential', value, time]);
        return this;
      }
      cancelScheduledValues(time) {
        this.events.push(['cancel', time]);
        return this;
      }
    }

    class FakeAudioNode {
      constructor(context, kind) {
        this.context = context;
        this.kind = kind;
        this.connections = [];
        this.disconnectCount = 0;
        context.nodes.push(this);
      }
      connect(target) {
        this.connections.push(target);
        return target;
      }
      disconnect() {
        this.disconnectCount++;
      }
      get disconnected() {
        return this.disconnectCount > 0;
      }
    }

    class FakeScheduledNode extends FakeAudioNode {
      constructor(context, kind) {
        super(context, kind);
        this.starts = [];
        this.stops = [];
      }
      start(time = 0) {
        this.starts.push(time);
        this.context.starts.push({ node: this, time });
      }
      stop(time = 0) {
        this.stops.push(time);
      }
    }

    class FakeAudioContext {
      static instances = [];

      constructor() {
        this.state = 'suspended';
        this.currentTime = 0;
        this.sampleRate = 64;
        this.nodes = [];
        this.starts = [];
        this.closeCount = 0;
        this.resumeCount = 0;
        this.listeners = new Map();
        this.destination = new FakeAudioNode(this, 'destination');
        const param = () => new FakeAudioParam();
        this.listener = {
          forwardX: param(), forwardY: param(), forwardZ: param(),
          upX: param(), upY: param(), upZ: param(),
          positionX: param(), positionY: param(), positionZ: param(),
        };
        FakeAudioContext.instances.push(this);
      }
      addEventListener(type, fn) {
        let listeners = this.listeners.get(type);
        if (!listeners) this.listeners.set(type, listeners = new Set());
        listeners.add(fn);
      }
      removeEventListener(type, fn) {
        this.listeners.get(type)?.delete(fn);
      }
      _emit(type) {
        for (const fn of this.listeners.get(type) || []) fn();
      }
      async resume() {
        this.resumeCount++;
        this.state = 'running';
        this._emit('statechange');
      }
      async close() {
        this.closeCount++;
        this.state = 'closed';
        this._emit('statechange');
      }
      createGain() {
        const node = new FakeAudioNode(this, 'gain');
        node.gain = new FakeAudioParam(1);
        return node;
      }
      createDynamicsCompressor() {
        const node = new FakeAudioNode(this, 'compressor');
        node.threshold = new FakeAudioParam();
        node.knee = new FakeAudioParam();
        node.ratio = new FakeAudioParam();
        node.attack = new FakeAudioParam();
        node.release = new FakeAudioParam();
        return node;
      }
      createBiquadFilter() {
        const node = new FakeAudioNode(this, 'biquad');
        node.frequency = new FakeAudioParam();
        node.Q = new FakeAudioParam();
        return node;
      }
      createWaveShaper() {
        return new FakeAudioNode(this, 'waveshaper');
      }
      createDelay() {
        const node = new FakeAudioNode(this, 'delay');
        node.delayTime = new FakeAudioParam();
        return node;
      }
      createOscillator() {
        const node = new FakeScheduledNode(this, 'oscillator');
        node.frequency = new FakeAudioParam();
        node.detune = new FakeAudioParam();
        return node;
      }
      createBufferSource() {
        const node = new FakeScheduledNode(this, 'buffer-source');
        node.playbackRate = new FakeAudioParam(1);
        return node;
      }
      createStereoPanner() {
        const node = new FakeAudioNode(this, 'stereo-panner');
        node.pan = new FakeAudioParam();
        return node;
      }
      createPanner() {
        const node = new FakeAudioNode(this, 'panner');
        node.positionX = new FakeAudioParam();
        node.positionY = new FakeAudioParam();
        node.positionZ = new FakeAudioParam();
        return node;
      }
      createBuffer(channels, length) {
        const data = Array.from({ length: channels }, () => new Float32Array(length));
        return { getChannelData: (channel) => data[channel] };
      }
    }

    const restore = installGlobals({
      window: { AudioContext: FakeAudioContext },
    });
    let sfx = null;
    try {
      ({ sfx } = await import('../public/js/audio/sfx.js'));
      sfx.setMasterVolume(9);
      await sfx.init();
      await sfx.init();
      await sfx.unlock();

      ok(FakeAudioContext.instances.length === 1,
        'audio init and unlock reuse one live AudioContext');
      const audio = FakeAudioContext.instances[0];
      const master = audio.nodes.find((node) => node.kind === 'gain');
      const limiter = master?.connections[0];
      ok(master?.gain.value === 1
        && limiter?.kind === 'compressor'
        && limiter.connections.includes(audio.destination),
      'all audio routes through a clamped master gain and terminal limiter');

      sfx.setMasterVolume(-4);
      ok(master.gain.value === 0
        && master.gain.events.some((event) => event[0] === 'set' && event[1] === 0),
      'live master volume clamps low and updates the existing graph');
      sfx.setMasterVolume(0.35);

      const startedBy = (fn) => {
        const before = audio.starts.length;
        fn();
        return audio.starts.length - before;
      };
      ok(startedBy(() => sfx.fire('lmg')) >= 4,
        'LMG fire starts its layered procedural voice');
      ok(startedBy(() => sfx.fire('revolver')) >= 4,
        'revolver fire starts its layered procedural voice');
      ok(startedBy(() => {
        sfx.impact('metal', 0.8);
        sfx.hitmark(true);
      }) >= 7, 'metal impact and headshot hit voices start');
      ok(startedBy(() => {
        sfx.reloadClick(1, 'lmg');
        sfx.reloadClick(2, 'revolver');
      }) >= 5, 'LMG and revolver reload voices start');

      const liveDirectToMaster = () => audio.nodes.filter((node) =>
        !node.disconnected && node.connections.includes(master));
      const voiceBaseline = liveDirectToMaster().length;
      for (let i = 0; i < 20; i++) sfx.fire('lmg');
      const afterLmg = liveDirectToMaster().length;
      ok(afterLmg - voiceBaseline <= 6,
        'LMG voice stealing keeps at most six live output nodes');
      for (let i = 0; i < 20; i++) sfx.fire('revolver');
      const afterRevolver = liveDirectToMaster().length;
      ok(afterRevolver - afterLmg <= 4,
        'revolver voice stealing keeps at most four live output nodes');

      for (let i = 0; i < 60; i++) sfx.hitmark(false);
      ok(liveDirectToMaster().length <= 49,
        'global voice registry leaves at most 48 live outputs plus the echo bus');
      for (let i = 0; i < 30; i++) {
        sfx.impact('metal', 1, { pos: [i, 0, -i] });
      }
      ok(audio.nodes.filter((node) =>
        node.kind === 'panner' && !node.disconnected).length <= 16,
      'positional voice registry leaves at most sixteen live panner nodes');

      await sfx.dispose();
      ok(audio.state === 'closed' && audio.closeCount === 1,
        'audio dispose closes the reusable context exactly once');
      await sfx.init();
      ok(FakeAudioContext.instances.length === 2
        && FakeAudioContext.instances[1].state === 'running'
        && FakeAudioContext.instances[1].nodes.find((node) => node.kind === 'gain')?.gain.value === 0.35,
      'audio dispose permits clean re-init with the persisted clamped master volume');
    } finally {
      if (sfx) await sfx.dispose();
      restore();
    }
  }

  // HUD: just enough DOM to execute the shipped settings and scope paths.
  {
    class FakeEventTarget {
      constructor() {
        this.listeners = new Map();
      }
      addEventListener(type, fn) {
        let listeners = this.listeners.get(type);
        if (!listeners) this.listeners.set(type, listeners = new Set());
        listeners.add(fn);
      }
      removeEventListener(type, fn) {
        this.listeners.get(type)?.delete(fn);
      }
      dispatchEvent(event) {
        if (!event || !event.type) throw new Error('fake event requires a type');
        if (!event.target) event.target = this;
        event.currentTarget = this;
        for (const fn of [...(this.listeners.get(event.type) || [])]) fn(event);
        return !event.defaultPrevented;
      }
    }

    class FakeClassList {
      constructor(owner) {
        this.owner = owner;
      }
      add(...names) {
        for (const name of names) this.owner.classes.add(name);
      }
      remove(...names) {
        for (const name of names) this.owner.classes.delete(name);
      }
      contains(name) {
        return this.owner.classes.has(name);
      }
      toggle(name, force) {
        const on = force === undefined ? !this.contains(name) : !!force;
        if (on) this.add(name);
        else this.remove(name);
        return on;
      }
    }

    class FakeStyle {
      setProperty(name, value) {
        this[name] = String(value);
      }
      getPropertyValue(name) {
        return this[name] || '';
      }
      removeProperty(name) {
        const old = this[name] || '';
        delete this[name];
        return old;
      }
    }

    class FakeElement extends FakeEventTarget {
      constructor(ownerDocument, tagName) {
        super();
        this.ownerDocument = ownerDocument;
        this.tagName = String(tagName).toUpperCase();
        this.parentNode = null;
        this.children = [];
        this.classes = new Set();
        this.classList = new FakeClassList(this);
        this.style = new FakeStyle();
        this.dataset = {};
        this.attributes = new Map();
        this._textContent = '';
        this._innerHTML = '';
        this.value = '';
        this.type = '';
        this.disabled = false;
        this.checked = false;
        this.clientWidth = 340;
        this._id = '';
      }
      dispatchEvent(event) {
        const allowed = super.dispatchEvent(event);
        if (!event.propagationStopped) this.parentNode?.dispatchEvent(event);
        return allowed;
      }
      set id(value) {
        if (this._id) this.ownerDocument.ids.delete(this._id);
        this._id = String(value || '');
        if (this._id) this.ownerDocument.ids.set(this._id, this);
      }
      get id() {
        return this._id;
      }
      set className(value) {
        this.classes = new Set(String(value || '').split(/\s+/).filter(Boolean));
      }
      get className() {
        return [...this.classes].join(' ');
      }
      set textContent(value) {
        for (const child of this.children) child.parentNode = null;
        this.children.length = 0;
        this._textContent = String(value ?? '');
        this._innerHTML = '';
      }
      get textContent() {
        return this._textContent + this.children.map((child) => child.textContent).join('');
      }
      set innerHTML(value) {
        for (const child of this.children) child.parentNode = null;
        this.children.length = 0;
        this._textContent = '';
        this._innerHTML = String(value ?? '');
        const stack = [this];
        const tokens = this._innerHTML.match(/<[^>]+>|[^<]+/g) || [];
        for (const token of tokens) {
          if (token.startsWith('</')) {
            if (stack.length > 1) stack.pop();
            continue;
          }
          if (!token.startsWith('<')) {
            const text = token.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
            if (text) stack.at(-1)._textContent += text;
            continue;
          }
          if (/^<!/.test(token)) continue;
          const match = token.match(/^<\s*([a-zA-Z0-9-]+)([^>]*)>/);
          if (!match) continue;
          const child = this.ownerDocument.createElement(match[1]);
          const attrs = match[2];
          const attrRe = /([:@\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
          let attr;
          while ((attr = attrRe.exec(attrs))) {
            child.setAttribute(attr[1], attr[2] ?? attr[3] ?? attr[4] ?? '');
          }
          stack.at(-1).appendChild(child);
          if (!/\/\s*>$/.test(token)
            && !/^(?:INPUT|BR|HR|IMG|META|LINK)$/.test(child.tagName)) {
            stack.push(child);
          }
        }
      }
      get innerHTML() {
        return this._innerHTML;
      }
      get parentElement() {
        return this.parentNode;
      }
      get options() {
        return this.children.filter((child) => child.tagName === 'OPTION');
      }
      appendChild(child) {
        child.parentNode?.removeChild(child);
        child.parentNode = this;
        this.children.push(child);
        this._innerHTML = '';
        return child;
      }
      append(...children) {
        for (const child of children) {
          this.appendChild(typeof child === 'string'
            ? Object.assign(this.ownerDocument.createElement('span'), { textContent: child })
            : child);
        }
      }
      replaceChildren(...children) {
        for (const child of this.children) child.parentNode = null;
        this.children.length = 0;
        for (const child of children) this.appendChild(child);
      }
      removeChild(child) {
        const index = this.children.indexOf(child);
        if (index >= 0) this.children.splice(index, 1);
        child.parentNode = null;
        return child;
      }
      remove() {
        this.parentNode?.removeChild(this);
      }
      contains(node) {
        return node === this || this.children.some((child) => child.contains(node));
      }
      setAttribute(name, value) {
        const text = String(value);
        this.attributes.set(name, text);
        if (name === 'id') this.id = text;
        else if (name === 'class') this.className = text;
        else if (name === 'value') this.value = text;
        else if (name === 'type') this.type = text;
        else if (name === 'disabled') this.disabled = true;
        else if (name.startsWith('data-')) {
          const key = name.slice(5).replace(/-([a-z])/g, (_all, letter) => letter.toUpperCase());
          this.dataset[key] = text;
        }
      }
      getAttribute(name) {
        return this.attributes.has(name) ? this.attributes.get(name) : null;
      }
      hasAttribute(name) {
        return this.attributes.has(name);
      }
      removeAttribute(name) {
        if (!this.attributes.delete(name)) return;
        if (name === 'id') this.id = '';
        else if (name === 'class') this.className = '';
        else if (name === 'value') this.value = '';
        else if (name === 'type') this.type = '';
        else if (name === 'disabled') this.disabled = false;
        else if (name.startsWith('data-')) {
          const key = name.slice(5).replace(/-([a-z])/g, (_all, letter) => letter.toUpperCase());
          delete this.dataset[key];
        }
      }
      matches(selector) {
        return selector.split(',').some((part) => {
          const candidate = part.trim();
          const attrs = [...candidate.matchAll(/\[([^\]=]+)(?:=["']?([^"'\]]+)["']?)?\]/g)];
          const withoutAttrs = candidate.replace(/\[[^\]]+\]/g, '');
          const id = withoutAttrs.match(/#([\w-]+)/)?.[1];
          const classes = [...withoutAttrs.matchAll(/\.([\w-]+)/g)].map((match) => match[1]);
          const tag = withoutAttrs.match(/^[a-zA-Z][\w-]*/)?.[0];
          return (!id || this.id === id)
            && (!tag || this.tagName === tag.toUpperCase())
            && classes.every((name) => this.classList.contains(name))
            && attrs.every(([, name, expected]) => {
              const actual = this.getAttribute(name)
                ?? (name.startsWith('data-')
                  ? this.dataset[name.slice(5).replace(/-([a-z])/g,
                    (_all, letter) => letter.toUpperCase())]
                  : null);
              return actual != null && (expected === undefined || String(actual) === expected);
            });
        });
      }
      closest(selector) {
        for (let node = this; node; node = node.parentNode) {
          if (node.matches?.(selector)) return node;
        }
        return null;
      }
      querySelectorAll(selector) {
        const found = [];
        const visit = (node) => {
          for (const child of node.children) {
            if (child.matches(selector)) found.push(child);
            visit(child);
          }
        };
        visit(this);
        return found;
      }
      querySelector(selector) {
        return this.querySelectorAll(selector)[0] || null;
      }
      click() {
        if (!this.disabled) this.dispatchEvent({
          type: 'click',
          target: this,
          currentTarget: this,
          defaultPrevented: false,
          preventDefault() { this.defaultPrevented = true; },
          stopPropagation() {},
        });
      }
      focus() {
        this.ownerDocument.activeElement = this;
      }
      select() {}
      setSelectionRange() {}
      getBoundingClientRect() {
        return { left: 0, top: 0, width: this.clientWidth, height: 40 };
      }
    }

    class FakeDocument extends FakeEventTarget {
      constructor() {
        super();
        this.ids = new Map();
        this.hidden = false;
        this.activeElement = null;
        this.body = new FakeElement(this, 'body');
      }
      createElement(tagName) {
        return new FakeElement(this, tagName);
      }
      getElementById(id) {
        return this.ids.get(id) || null;
      }
      querySelectorAll(selector) {
        const found = [];
        if (this.body.matches(selector)) found.push(this.body);
        return found.concat(this.body.querySelectorAll(selector));
      }
      querySelector(selector) {
        return this.querySelectorAll(selector)[0] || null;
      }
      execCommand() {
        return true;
      }
    }

    class FakeStorage {
      constructor(entries) {
        this.values = new Map(entries);
      }
      getItem(key) {
        return this.values.has(key) ? this.values.get(key) : null;
      }
      setItem(key, value) {
        this.values.set(key, String(value));
      }
    }

    const document = new FakeDocument();
    const window = new FakeEventTarget();
    const localStorage = new FakeStorage([
      ['vb-sens', '0.021'],
      ['vb-volume', '0.42'],
      ['vb-fov', '86'],
    ]);
    let nowMs = 1000;
    let nextRaf = 1;
    const rafs = new Map();
    const requestAnimationFrame = (fn) => {
      const id = nextRaf++;
      rafs.set(id, fn);
      return id;
    };
    const cancelAnimationFrame = (id) => {
      rafs.delete(id);
    };
    const flushRaf = (limit = 40) => {
      for (let turn = 0; turn < limit && rafs.size; turn++) {
        const batch = [...rafs.values()];
        rafs.clear();
        nowMs += 50;
        for (const fn of batch) fn(nowMs);
      }
    };
    const event = (type, extra = {}) => ({
      type,
      defaultPrevented: false,
      propagationStopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.propagationStopped = true; },
      ...extra,
    });

    const restore = installGlobals({
      document,
      window,
      localStorage,
      requestAnimationFrame,
      cancelAnimationFrame,
      performance: { now: () => nowMs },
    });
    let hud = null;
    try {
      const { HUD } = await import('../public/js/ui/hud.js');
      hud = new HUD();
      ok(hud._settingsConfig.sensitivity === 0.021
        && hud._settingsConfig.volume === 0.42
        && hud._settingsConfig.fov === 86,
      'HUD loads all persisted settings into its initial configuration');

      const changes = [];
      let resumes = 0;
      hud.setupSettings({
        sensitivity: 0.028,
        volume: 0.55,
        fov: 91,
        onChange: (settings) => changes.push(settings),
        onResume: () => { resumes++; },
      });
      ok(localStorage.getItem('vb-sens') === '0.028'
        && localStorage.getItem('vb-volume') === '0.55'
        && localStorage.getItem('vb-fov') === '91',
      'HUD setup persists the complete settings triplet');

      hud.settingsDom.sensSlider.value = '0.047';
      hud.settingsDom.sensSlider.dispatchEvent(event('input'));
      hud.settingsDom.volSlider.value = '0.63';
      hud.settingsDom.volSlider.dispatchEvent(event('input'));
      hud.settingsDom.fovSlider.value = '98';
      hud.settingsDom.fovSlider.dispatchEvent(event('input'));
      const lastChange = changes.at(-1);
      ok(changes.length === 3
        && changes.every((change) =>
          Object.keys(change).sort().join(',') === 'fov,sensitivity,volume')
        && lastChange.sensitivity === 0.047
        && lastChange.volume === 0.63
        && lastChange.fov === 98,
      'every HUD slider emits a full current settings object');
      ok(localStorage.getItem('vb-sens') === '0.047'
        && localStorage.getItem('vb-volume') === '0.63'
        && localStorage.getItem('vb-fov') === '98',
      'HUD slider changes persist all three live values');

      hud.openSettings();
      ok(hud.settingsOpen
        && hud.settingsDom.root.style.display === 'flex'
        && hud.settingsDom.root.getAttribute('aria-hidden') === 'false',
      'HUD settings open state makes the dialog visible and accessible');
      hud.closeSettings();
      ok(!hud.settingsOpen
        && hud.settingsDom.root.style.display === 'none'
        && hud.settingsDom.root.classList.contains('hidden'),
      'HUD closeSettings hides the dialog and clears its open state');

      hud.openSettings();
      hud.settingsDom.resumeBtn.dispatchEvent(event('click'));
      ok(!hud.settingsOpen && resumes === 1,
        'HUD resume button closes settings and invokes onResume once');
      hud.openSettings();
      const escape = event('keydown', { key: 'Escape' });
      hud.settingsDom.root.dispatchEvent(escape);
      ok(!hud.settingsOpen
        && resumes === 2
        && escape.defaultPrevented
        && escape.propagationStopped,
      'HUD Escape resume closes, consumes the key, and invokes onResume once');

      const menuActions = [];
      hud.buildMenu((action) => menuActions.push(action));
      const modeSelect = document.getElementById('game-mode-select');
      const mapSelect = document.getElementById('map-select');
      ok(modeSelect && mapSelect
        && modeSelect.options.map((option) => option.value).join(',') === MODE_IDS.join(','),
      'HUD menu exposes every canonical game mode');
      modeSelect.value = 'snd';
      modeSelect.dispatchEvent(event('change'));
      ok(mapSelect.options.map((option) => option.value).join(',') === 'foundry,citadel'
        && !mapSelect.options.some((option) => option.value === 'depot'),
      'HUD menu removes maps incompatible with the selected mode');
      modeSelect.value = 'tdm';
      modeSelect.dispatchEvent(event('change'));
      mapSelect.value = 'depot';
      document.getElementById('name-input').value = 'HOST';
      document.getElementById('bot-count').value = '3';
      document.getElementById('create-lobby-btn').click();
      ok(menuActions.length === 1
        && menuActions[0].mode === 'create'
        && menuActions[0].name === 'HOST'
        && menuActions[0].bots === 3
        && menuActions[0].gameMode === 'tdm'
        && menuActions[0].map === 'depot',
      'HUD create action carries the selected compatible mode-map pair');

      hud.buildMenu((action) => menuActions.push(action));
      document.getElementById('game-mode-select').value = 'snd';
      document.getElementById('game-mode-select').dispatchEvent(event('change'));
      document.getElementById('map-select').value = 'citadel';
      document.getElementById('play-btn').click();
      ok(menuActions.length === 2
        && menuActions[1].mode === 'quick'
        && menuActions[1].gameMode === 'fun'
        && menuActions[1].map === 'foundry'
        && !Object.hasOwn(globalThis, 'location'),
      'HUD quick action always selects the shared Fun match on Foundry');

      const lobbyState = {
        code: 'ZX9Q2',
        host: 17,
        selfId: 17,
        phase: 'waiting',
        bots: 1,
        gameMode: 'snd',
        map: 'citadel',
        members: [
          { id: 17, name: 'HOST', ready: true, bot: false, team: 'alpha' },
        ],
      };
      const inviteLocation = Object.freeze({
        origin: 'https://play.voxel.test',
        pathname: '/arena/index.html',
        search: '?stale=query',
        hash: '#stale-hash',
      });
      const restoreLocation = installGlobals({ location: inviteLocation });
      try {
        hud.showLobby(lobbyState, {
          onReady() {},
          onStart() {},
          onLeave() {},
        });
        ok(/search|destroy|s&d/i.test(document.getElementById('lobby-mode-val').textContent)
          && /citadel/i.test(document.getElementById('lobby-map-val').textContent),
        'HUD lobby renders immutable mode and map identity chips');
        ok(globalThis.location === inviteLocation
          && document.getElementById('lobby-invite-input').value
            === 'https://play.voxel.test/arena/index.html?lobby=ZX9Q2',
        'HUD lobby derives the exact absolute invite from origin and path only');
      } finally {
        restoreLocation();
      }
      ok(!Object.hasOwn(globalThis, 'location'),
        'HUD invite fixture restores detached global location state');
      hud.updateLobby({ ...lobbyState, gameMode: 'tdm', map: 'depot' });
      ok(!Object.hasOwn(globalThis, 'location')
        && document.getElementById('lobby-invite-input').value === '?lobby=ZX9Q2'
        && /team|deathmatch|tdm/i.test(document.getElementById('lobby-mode-val').textContent)
        && /depot/i.test(document.getElementById('lobby-map-val').textContent),
      'HUD lobby chips update when a replacement lobby state arrives');

      hud.hideLobby();

      hud.buildHUD();
      hud.setState({ wid: 'sniper', adsT01: 0.7199, alive: true, hp: 100 });
      ok(!hud.scopeShown && !hud.dom.scope,
        'sniper scope stays absent immediately below the ADS threshold');
      hud.setState({ adsT01: 0.72 });
      ok(hud.scopeShown && hud.dom.scope.classList.contains('active'),
        'sniper scope enters exactly at the ADS threshold');
      flushRaf();
      ok(hud.scopeProgress === 1
        && hud.dom.scope.style.opacity === '1'
        && !hud.dom.scope.classList.contains('exiting'),
      'sniper scope RAF reaches its fully active live state');

      hud.setState({ adsT01: 0.7199 });
      ok(!hud.scopeShown
        && !hud.dom.scope.classList.contains('active')
        && hud.dom.scope.classList.contains('exiting'),
      'dropping below the threshold begins the scope exit transition');
      flushRaf();
      ok(hud.scopeProgress === 0
        && !hud.dom.scope.classList.contains('active')
        && !hud.dom.scope.classList.contains('exiting')
        && hud.dom.scope.style.opacity === ''
        && hud.dom.scope.style.transform === '',
      'scope exit removes transition classes and inline animation residue');

      hud.setState({ adsT01: 0.9, alive: true });
      flushRaf();
      hud.setState({ alive: false });
      ok(!hud.scopeShown && hud.dom.ch.classList.contains('vb-dead'),
        'live-to-dead state immediately suppresses the scope and marks the crosshair dead');
      flushRaf();
      ok(!hud.dom.scope.classList.contains('active')
        && !hud.dom.scope.classList.contains('exiting'),
      'live-to-dead scope exit leaves no active or exiting class');

      hud.setState({ alive: true, adsT01: 0.2 });
      hud.setDead(true, 'RIVAL');
      ok(hud.dom.ch.classList.contains('vb-dead')
        && hud.dom.deathnote.textContent === 'eliminated by RIVAL'
        && hud.dom.deathnote.style.display === 'block',
      'explicit death state shows the killer note and dead crosshair');
      hud.setDead(false);
      hud.setState({ alive: true });
      ok(!hud.dom.ch.classList.contains('vb-dead')
        && hud.dom.deathnote.style.display === 'none',
      'HUD revival clears explicit death presentation');

      const visible = (element) => !!element
        && element.style.display !== 'none'
        && !element.classList.contains('hidden')
        && element.getAttribute('aria-hidden') !== 'true';
      const players = [
        {
          id: 17, name: 'HOST', team: 'alpha', score: 12,
          kills: 5, deaths: 1, bomb: true, state: 'alive', local: true,
        },
        {
          id: 23, name: 'RIVAL', team: 'bravo', score: 8,
          kills: 3, deaths: 2, state: 'dead', dead: true,
        },
      ];
      const prepMatch = {
        mode: 'snd',
        map: 'citadel',
        phase: 'prep',
        phaseEndsAt: 25000,
        scores: { alpha: 4, bravo: 3 },
        winner: null,
        round: 8,
        roundWinner: null,
        attackers: 'alpha',
        defenders: 'bravo',
        bomb: { state: 'carried', carrierId: 17, site: null, fuseEndsAt: null },
      };
      const selfRow = {
        id: 17,
        team: 'alpha',
        credits: 2100,
        owned: ['revolver', 'smg'],
        bomb: true,
        hp: 100,
        state: 'alive',
        interaction: null,
      };
      hud.setMatchState(prepMatch, selfRow, players, 20000);
      ok(!Object.hasOwn(globalThis, 'location')
        && visible(document.getElementById('match-header'))
        && /snd|search|destroy/i.test(document.getElementById('match-mode-chip').textContent)
        && /citadel/i.test(document.getElementById('match-map-chip').textContent)
        && document.getElementById('match-clock').textContent.length > 0,
      'HUD match header renders mode, map, and a server-clocked phase timer');
      ok(document.getElementById('hud-credits-val').textContent.replace(/\D/g, '') === '2100'
        && visible(document.getElementById('hud-carrier-badge'))
        && visible(document.getElementById('hud-buy-prompt')),
      'S&D prep HUD renders authoritative credits, carrier state, and buy prompt');

      const liveMatch = {
        ...prepMatch,
        phase: 'live',
        phaseEndsAt: 90000,
        bomb: {
          state: 'planted',
          carrierId: null,
          site: 'A',
          fuseEndsAt: 28000,
        },
      };
      hud.setMatchState(liveMatch, {
        ...selfRow,
        bomb: false,
        interaction: { kind: 'defuse', site: 'A', progress: 0.4 },
      }, players, 20000);
      const interactionFill = document.querySelector('#interaction-bar .vb-interaction-fill')
        || document.querySelector('.vb-interaction-fill');
      ok(document.getElementById('match-alpha-score').textContent.trim() === '4'
        && document.getElementById('match-bravo-score').textContent.trim() === '3'
        && /attack/i.test(document.getElementById('match-alpha-role').textContent)
        && /defend/i.test(document.getElementById('match-bravo-role').textContent),
      'HUD renders authoritative team scores and current S&D roles');
      ok(document.getElementById('match-bomb-banner').textContent.trim()
          === 'BOMB PLANTED AT SITE A'
        && visible(document.getElementById('interaction-bar'))
        && document.getElementById('interaction-label').textContent.trim()
          === 'DEFUSING BOMB [SITE A]...'
        && interactionFill?.style.width === '40%',
      'HUD renders explicit planted/defuse objective copy and the exact visible 40% progress state');

      hud.setScoreboard(true);
      hud.setPlayers(players);
      const scoreboard = document.getElementById('scores');
      ok(scoreboard.querySelectorAll('tr.vb-team-alpha').length === 1
        && scoreboard.querySelectorAll('tr.vb-team-bravo').length === 1
        && scoreboard.querySelectorAll('tr.vb-me').length === 1
        && scoreboard.querySelectorAll('tr.dead').length === 1,
      'scoreboard rows receive stable team, local-player, and death classes');
      ok(scoreboard.querySelectorAll('.vb-badge-alpha').length === 1
        && scoreboard.querySelectorAll('.vb-badge-bravo').length === 1
        && scoreboard.querySelectorAll('.vb-sb-bomb-badge').length === 1,
      'scoreboard renders team badges and objective-carrier badge');

      const purchases = [];
      let buyCloses = 0;
      hud.setupBuyMenu({
        onBuy: (weapon) => purchases.push(weapon),
        onClose: () => { buyCloses++; },
      });
      hud.setBuyMenuState({
        open: true,
        phase: 'prep',
        credits: 2000,
        owned: ['revolver'],
      });
      const buyCredits = document.getElementById('buy-credits-val');
      const ownedCard = document.getElementById('buy-card-revolver');
      const smgButton = document.getElementById('buy-btn-smg');
      const sniperButton = document.getElementById('buy-btn-sniper');
      ok(!Object.hasOwn(globalThis, 'location')
        && hud.isBuyMenuOpen()
        && /prep|buy/i.test(document.getElementById('buy-phase-val').textContent)
        && buyCredits.textContent.replace(/\D/g, '') === '2000'
        && (/owned|refill/i.test(ownedCard.textContent)
          || ownedCard.classList.contains('owned')
          || ownedCard.classList.contains('vb-owned'))
        && !smgButton.disabled
        && smgButton.getAttribute('aria-disabled') === 'false'
        && sniperButton.disabled
        && sniperButton.getAttribute('aria-disabled') === 'true',
      'buy dialog renders prep phase, credits, ownership, and affordability guards');

      const authoritativeBuyView = [
        buyCredits.textContent,
        ownedCard.className,
        ownedCard.textContent,
        smgButton.className,
        smgButton.textContent,
      ].join('|');
      hud.triggerPurchase('smg');
      hud.triggerPurchase('laser');
      hud.triggerPurchase('sniper');
      ok(purchases.join(',') === 'smg'
        && [
          buyCredits.textContent,
          ownedCard.className,
          ownedCard.textContent,
          smgButton.className,
          smgButton.textContent,
        ].join('|') === authoritativeBuyView,
      'buy requests reject unknown and unaffordable weapons without local purchase optimism');

      hud.setBuyMenuState({
        open: true,
        phase: 'prep',
        credits: 2000,
        owned: ['revolver', 'smg'],
      });
      hud.triggerPurchase('smg');
      ok(purchases.join(',') === 'smg,smg',
        'an affordable owned weapon remains requestable as an authoritative refill');

      const buyKeyTarget = window.listeners.has('keydown')
        ? window
        : document.listeners.has('keydown') ? document : document.getElementById('buy-menu');
      buyKeyTarget.dispatchEvent(event('keydown', {
        key: '3',
        code: 'Digit3',
        repeat: false,
      }));
      ok(purchases.at(-1) === 'shotgun',
        'buy dialog maps weapon digits to guarded purchase requests');
      const buyB = event('keydown', { key: 'b', code: 'KeyB', repeat: false });
      buyKeyTarget.dispatchEvent(buyB);
      ok(hud.isBuyMenuOpen()
        && purchases.length === 3
        && !buyB.defaultPrevented
        && !buyB.propagationStopped,
      'HUD neither handles nor consumes B, leaving the toggle exclusively to Input and Main');
      const buyEscape = event('keydown', { key: 'Escape', code: 'Escape', repeat: false });
      buyKeyTarget.dispatchEvent(buyEscape);
      ok(!hud.isBuyMenuOpen() && buyCloses === 1 && buyEscape.defaultPrevented,
        'buy dialog consumes Escape and closes through its owner callback');

      hud.setBuyMenuState({
        open: true,
        phase: 'live',
        credits: 16000,
        owned: ['revolver'],
      });
      ok(!hud.isBuyMenuOpen(),
        'buy dialog refuses to stay open outside the authoritative prep phase');

      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      hud?.dispose();
      restore();
    }
  }

  // NetClient: admission frames normalize mode-map pairs, inbound state is
  // owned defensively, and gameplay frames remain guarded by socket state.
  {
    class FakeWebSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSED = 3;
      static instances = [];

      constructor(url) {
        this.url = url;
        this.readyState = FakeWebSocket.CONNECTING;
        this.sent = [];
        this.binaryType = '';
        FakeWebSocket.instances.push(this);
      }
      send(data) {
        if (this.readyState !== FakeWebSocket.OPEN) {
          throw new Error('send while fake socket is not open');
        }
        this.sent.push(data);
      }
      open() {
        this.readyState = FakeWebSocket.OPEN;
        this.onopen?.();
      }
      message(data) {
        this.onmessage?.({ data });
      }
      close(code, reason) {
        this.readyState = FakeWebSocket.CLOSED;
        this.closeArgs = [code, reason];
        this.onclose?.();
      }
    }

    const restore = installGlobals({ WebSocket: FakeWebSocket });
    try {
      const { NetClient } = await import('../public/js/engine/netclient.js');
      const deeplyFrozen = (value) => !value || typeof value !== 'object'
        || (Object.isFrozen(value) && Object.values(value).every(deeplyFrozen));
      const connect = async (
        name,
        opts,
        expectedFrame,
        welcomeMode = 'fun',
        welcomeMap = 'foundry'
      ) => {
        const client = new NetClient();
        const maps = [];
        client.onMap = (bytes) => maps.push([...bytes]);
        const pending = client.connect('ws://voxel.test/ws', name, opts);
        const ws = FakeWebSocket.instances.at(-1);
        ws.open();
        ok(ws.binaryType === 'arraybuffer'
          && JSON.stringify(JSON.parse(ws.sent[0])) === JSON.stringify(expectedFrame),
        `${opts?.mode || 'quick'} sends the exact normalized initial admission frame`);

        ws.message(JSON.stringify({
          t: 'welcome',
          id: 17,
          name,
          mapBytes: 3,
          tickRate: 20,
          spawn: [1, 2, 3],
          lobby: opts?.mode === 'quick' || !opts
            ? null
            : { code: 'ZX9Q2', role: opts.mode === 'create' ? 'host' : 'guest' },
          phase: opts?.mode === 'quick' || !opts ? 'live' : 'waiting',
          gameMode: welcomeMode,
          map: welcomeMap,
        }));
        ws.message(Uint8Array.of(7, 8, 9).buffer);
        const welcome = await pending;
        ok(welcome.id === 17
          && welcome.gameMode === welcomeMode
          && welcome.map === welcomeMap
          && client.welcome === welcome
          && Object.isFrozen(welcome)
          && maps.length === 1
          && maps[0].join(',') === '7,8,9',
        `${opts?.mode || 'quick'} stores its mode-map welcome and pairs exactly one binary map`);
        return { client, ws };
      };

      const quick = await connect('QUICK', null, {
        t: 'join', name: 'QUICK', bots: 0,
      });
      quick.client.close();

      const compatible = await connect('HOST', {
        mode: 'create',
        bots: 4,
        gameMode: 'tdm',
        map: 'depot',
      }, {
        t: 'create',
        name: 'HOST',
        bots: 4,
        gameMode: 'tdm',
        map: 'depot',
      }, 'tdm', 'depot');
      compatible.client.close();

      const incompatible = await connect('HOST2', {
        mode: 'create',
        bots: 2,
        gameMode: 'snd',
        map: 'depot',
      }, {
        t: 'create',
        name: 'HOST2',
        bots: 2,
        gameMode: 'snd',
        map: 'foundry',
      }, 'snd', 'foundry');
      incompatible.client.close();

      const joined = await connect('GUEST', {
        mode: 'join',
        bots: 7,
        lobby: 'ZX9Q2',
        gameMode: 'tdm',
        map: 'depot',
      }, {
        t: 'join', name: 'GUEST', lobby: 'ZX9Q2',
      }, 'snd', 'citadel');

      const sentBeforeBuy = joined.ws.sent.length;
      joined.client.buyWeapon('smg');
      joined.client.buyWeapon('laser');
      joined.client.buyWeapon(null);
      ok(joined.ws.sent.length === sentBeforeBuy + 1
        && JSON.stringify(JSON.parse(joined.ws.sent.at(-1)))
          === JSON.stringify({ t: 'buy', weapon: 'smg' }),
      'NetClient sends one exact buy frame and rejects unknown weapon ids');

      joined.client.sendInput({
        keys: {
          forward: false,
          back: false,
          left: false,
          right: false,
          jump: false,
          crouch: false,
          sprint: false,
          interact: true,
        },
        yaw: 0.25,
        pitch: -0.1,
        weapon: 0,
        wantFire: false,
        wantAds: false,
        reload: false,
      });
      const inputFrame = JSON.parse(joined.ws.sent.at(-1));
      ok(JSON.stringify(inputFrame) === JSON.stringify({
        t: 'input',
        seq: 1,
        keys: {
          f: false,
          b: false,
          l: false,
          r: false,
          jump: false,
          sprint: false,
          crouch: false,
          interact: true,
        },
        yaw: 0.25,
        pitch: -0.1,
        weapon: 0,
        wantFire: false,
        wantAds: false,
        reload: false,
      }),
      'NetClient sends the exact nested held-interaction input frame');

      const emitted = [];
      joined.client.on('lobby', (state) => emitted.push(state));
      joined.ws.message(JSON.stringify({
        t: 'lobbyState',
        code: 'ZX9Q2',
        host: 17,
        phase: 'waiting',
        bots: 2,
        gameMode: 'snd',
        map: 'citadel',
        members: [
          null,
          5,
          { id: 17, name: 'GUEST', ready: true, bot: false, team: 'alpha' },
        ],
      }));
      const lobby = joined.client.latestLobbyState;
      ok(emitted.length === 1
        && lobby.selfId === 17
        && lobby.gameMode === 'snd'
        && lobby.map === 'citadel'
        && lobby.members.length === 1
        && lobby.members[0].name === 'GUEST'
        && Object.isFrozen(lobby)
        && Object.isFrozen(lobby.members)
        && Object.isFrozen(lobby.members[0]),
      'NetClient stores mode-map lobby state, filters malformed members, and freezes replacements');
      let mutationBlocked = false;
      try {
        lobby.members[0].name = 'MUTATED';
      } catch {
        mutationBlocked = true;
      }
      ok(mutationBlocked && lobby.members[0].name === 'GUEST',
        'frozen lobby members defensively reject consumer mutation');

      joined.ws.message(JSON.stringify({
        t: 'lobbyState',
        code: 'ZX9Q2',
        host: 17,
        phase: 'live',
        bots: 0,
        gameMode: 'snd',
        map: 'citadel',
        members: { invalid: true },
      }));
      ok(joined.client.latestLobbyState.phase === 'live'
        && joined.client.latestLobbyState.gameMode === 'snd'
        && joined.client.latestLobbyState.map === 'citadel'
        && joined.client.latestLobbyState.members.length === 0
        && joined.client.latestLobbyState !== lobby,
      'each lobbyState fully replaces prior state and defaults malformed members to empty');

      const firstOwned = ['revolver'];
      const firstBomb = { state: 'carried', site: null };
      const firstInteraction = { kind: 'plant', site: 'A', progress: 0.2 };
      joined.ws.message(JSON.stringify({
        t: 'tick',
        serverTime: 1000,
        tick: 1,
        players: [{
          id: 23,
          name: 'RIVAL',
          team: 'bravo',
          hp: 100,
          state: 'alive',
          credits: 1900,
          owned: firstOwned,
          bomb: firstBomb,
          interaction: firstInteraction,
          x: 2,
          y: 3,
          z: 4,
          yaw: 0,
          pitch: 0,
        }],
        events: [],
        match: {
          mode: 'snd',
          map: 'citadel',
          phase: 'prep',
          scores: { alpha: 4, bravo: 3 },
          bomb: { state: 'carried', carrierId: 23 },
        },
      }));
      joined.ws.message(JSON.stringify({
        t: 'tick',
        serverTime: 1050,
        tick: 2,
        players: [{
          id: 23,
          name: 'RIVAL',
          team: 'bravo',
          hp: 100,
          state: 'alive',
          credits: 650,
          owned: ['revolver', 'smg'],
          bomb: { state: 'dropped', site: null },
          interaction: { kind: 'plant', site: 'A', progress: 0.8 },
          x: 4,
          y: 3,
          z: 4,
          yaw: 0.5,
          pitch: 0.1,
        }],
        events: [],
        match: {
          mode: 'snd',
          map: 'citadel',
          phase: 'live',
          scores: { alpha: 4, bravo: 3 },
          bomb: { state: 'dropped', carrierId: null },
        },
      }));
      const view = joined.client.interpolate(performance.now());
      const rival = view.players.get(23);
      ok(rival.team === 'bravo'
        && rival.credits === 1900
        && rival.owned.join(',') === 'revolver'
        && rival.bomb.state === 'carried'
        && rival.interaction.progress === 0.2,
      'interpolation preserves team, credits, owned weapons, bomb, and interaction fields');
      const retainedRival = joined.client.latestSnapshots[0].players[0];
      ok(Object.isFrozen(rival)
        && Object.isFrozen(rival.owned)
        && Object.isFrozen(rival.bomb)
        && Object.isFrozen(rival.interaction)
        && Object.isFrozen(joined.client.latestSnapshots[0])
        && Object.isFrozen(joined.client.latestSnapshots[0].players)
        && Object.isFrozen(retainedRival)
        && Object.isFrozen(retainedRival.owned)
        && Object.isFrozen(retainedRival.bomb)
        && Object.isFrozen(retainedRival.interaction),
      'interpolated and retained player output objects are recursively frozen');
      const mutationThrows = (mutate) => {
        try {
          mutate();
        } catch (error) {
          return error instanceof TypeError;
        }
        return false;
      };
      ok(mutationThrows(() => rival.owned.push('sniper'))
        && mutationThrows(() => { rival.bomb.state = 'exploded'; })
        && mutationThrows(() => { rival.interaction.progress = 1; }),
      'ESM consumers cannot mutate frozen interpolation output');
      const pristine = joined.client.interpolate(performance.now()).players.get(23);
      ok(pristine.owned.join(',') === 'revolver'
        && pristine.bomb.state === 'carried'
        && pristine.interaction.progress === 0.2
        && joined.client.latestSnapshots[0].players[0].owned.join(',') === 'revolver'
        && joined.client.latestSnapshots[0].players[0].bomb.state === 'carried'
        && joined.client.latestSnapshots[0].players[0].interaction.progress === 0.2,
      'rejected consumer mutations leave subsequent interpolation and retained snapshots pristine');
      ok(joined.client.latestMatch.phase === 'live'
        && joined.client.latestMatch.mode === 'snd'
        && deeplyFrozen(joined.client.latestMatch),
      'NetClient stores the newest immutable match replacement independently of render delay');

      const sentBeforeClose = joined.ws.sent.length;
      joined.client.close();
      joined.client.buyWeapon('rifle');
      joined.client.sendInput({ interact: true });
      ok(joined.ws.sent.length === sentBeforeClose
        && joined.client.welcome === null
        && joined.client.latestLobbyState === null
        && joined.client.latestMatch === null
        && joined.client.latestSnapshots.length === 0,
      'NetClient close clears stored session state and gates input and buy frames');
    } finally {
      restore();
    }
  }
}


if (failures === 0) console.log('atlastest: ALL OK');
else { console.log(`atlastest: ${failures} failure(s)`); process.exit(1); }
