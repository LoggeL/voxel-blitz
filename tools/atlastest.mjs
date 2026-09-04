// Headless sanity checks for the voxel engine's pure logic + real geometry
// classes (three.module.js loads fine under node; nothing here touches canvas
// or WebGL). Run: node tools/atlastest.mjs

import {
  TILE, TILE_PAINTERS, tileRect, faceTile, wob,
  DEFAULT_BLOCK_TILES, ATLAS_SIZE, TILE_PX, GRID,
} from '../public/js/engine/atlas.js';
import {
  AIR, LEAVES, GLASS, GRASS, STONE, WOOD, PLANK, SX, SZ, SY, BLOCK_HP,
  getBlock as getWorldBlock, setBlock as setWorldBlock, heightAt,
  serializeWorld, deserializeWorld, createWorldState, createMapState,
  getMapMeta, MAP_IDS as WORLD_MAP_IDS,
} from '../shared/worlddata.js';
import {
  MODE_IDS, TEAM_IDS, MAP_IDS, MODE_RULES, WEAPON_PRICES,
  GUN_GAME_WEAPON_ORDER,
  START_CREDITS, KILL_CREDITS, PLANT_CREDITS, ROUND_WIN_CREDITS,
  MAX_CREDITS, LOSS_CREDIT_LADDER, MAP_MODE_COMPATIBILITY,
  normalizeModeId, normalizeTeamId, normalizeMapId, normalizeWeaponId,
  isModeMapCompatible, isTeamMode,
} from '../shared/modes.js';
import { raycastVoxels } from '../shared/raycast.js';
import { WEAPON_IDS, PLAYER_HALF, EYE_HEIGHT } from '../shared/combatmath.js';
import { BOLT_RULES } from '../shared/bolt-rules.js';
import { MAP_CAPTURE_SHOTS } from '../shared/map-capture-shots.js';
import {
  ChunkStore, aoLevel, FACE_SHADE, CHUNK_X,
  MAX_REBUILDS_PER_FRAME,
} from '../public/js/engine/chunks.js';
import * as THREE from '../public/js/vendor/three.module.js';
import { GameEngine, aimAngles } from '../server/game.js';
import { runClientContracts } from './contracts/client-contracts.mjs';
import {
  bytesEqual,
  deeplyFrozen,
  fnv1a,
  ok as assertOk,
  sameValue,
} from './lib/assert.mjs';

let failures = 0;
function ok(cond, msg) {
  assertOk(cond, msg, (message) => {
    failures++;
    console.error('FAIL ' + message);
  });
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
  ok(sameValue(MODE_IDS, ['fun', 'tdm', 'snd', 'gungame'])
    && sameValue(MAP_IDS, ['foundry', 'depot', 'citadel', 'solstice', 'caldera'])
    && sameValue(TEAM_IDS, ['alpha', 'bravo'])
    && WORLD_MAP_IDS === MAP_IDS
    && deeplyFrozen(MODE_IDS) && deeplyFrozen(MAP_IDS) && deeplyFrozen(TEAM_IDS),
  'mode, map, and team identifiers are exact immutable shared lists');

  const sndMaps = MAP_IDS.filter((map) => MAP_MODE_COMPATIBILITY[map].includes('snd'));
  const capturedSites = sndMaps.every((map) => ['A', 'B'].every((site) =>
    MAP_CAPTURE_SHOTS.some((shot) =>
      shot.map === map && shot.id === `snd-site-${site.toLowerCase()}` && shot.mode === 'snd')));
  ok(capturedSites,
    'every S&D-compatible map exposes dedicated A/B marker render-validation shots');

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
    gungame: {
      teams: false,
      friendlyFire: true,
      respawnMs: 1500,
      postMs: 5000,
      weaponOrder: ['rifle', 'smg', 'shotgun', 'sniper', 'lmg', 'rocket', 'longarc', 'lance', 'revolver', 'knife'],
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
  ok(MODE_RULES.gungame.weaponOrder === GUN_GAME_WEAPON_ORDER
    && deeplyFrozen(GUN_GAME_WEAPON_ORDER),
  'Gun Game progression has one exact immutable shared weapon order');
  ok(isTeamMode('tdm') && isTeamMode('snd')
    && !isTeamMode('fun') && !isTeamMode('gungame') && !isTeamMode('invalid'),
  'team-mode classification derives from the shared mode rules');

  const expectedPrices = {
    revolver: 0,
    knife: 500,
    smg: 1250,
    shotgun: 1800,
    rifle: 2700,
    longarc: 3500,
    lance: 3800,
    lmg: 4000,
    rocket: 4300,
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
    foundry: ['fun', 'tdm', 'snd', 'gungame'],
    depot: ['fun', 'tdm', 'gungame'],
    citadel: ['fun', 'tdm', 'snd', 'gungame'],
    solstice: ['fun', 'tdm', 'snd', 'gungame'],
    caldera: ['fun', 'tdm', 'snd', 'gungame'],
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
    solstice: 'Solstice',
    caldera: 'Caldera',
  };
  const expectedMapHashes = {
    foundry: '78553d52',
    depot: '3769109c',
    citadel: '7fdfff21',
    solstice: 'e7809a25',
    caldera: 'fe8b73d1',
  };
  const expectedSpawnCounts = {
    foundry: { fun: 12, tdmAlpha: 6, tdmBravo: 6, sndAttackers: 5, sndDefenders: 5 },
    depot: { fun: 12, tdmAlpha: 6, tdmBravo: 6, sndAttackers: 0, sndDefenders: 0 },
    citadel: { fun: 12, tdmAlpha: 6, tdmBravo: 6, sndAttackers: 6, sndDefenders: 6 },
    solstice: { fun: 12, tdmAlpha: 6, tdmBravo: 6, sndAttackers: 6, sndDefenders: 6 },
    caldera: { fun: 12, tdmAlpha: 6, tdmBravo: 6, sndAttackers: 6, sndDefenders: 6 },
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


// ------------------------------------------- melee + lance combat contracts
// Headless server behavior: drive the REAL GameEngine combat resolve over a
// carved flat arena and pin the K-7 RIPPER and CL-9 VOLTLANCE contracts.
{
  const world = createMapState('foundry');
  const engine = new GameEngine({ world });
  // Flat arena: solid floor at y=14, open 15..22, across x 56..75 / z 40..55.
  for (let x = 56; x < 76; x++) {
    for (let z = 40; z < 56; z++) {
      for (let y = 15; y <= 22; y++) world.setBlock(x, y, z, AIR);
      world.setBlock(x, 14, z, GRASS);
    }
  }

  const KNIFE = WEAPON_IDS.indexOf('knife');
  const LANCE = WEAPON_IDS.indexOf('lance');
  const eyeY = 15 + EYE_HEIGHT;

  // Seat one entity on the arena floor with a weapon and a look direction.
  function seat(id, x, z, lookX, weapon, lookZ = 48) {
    engine.addClient(id, id);
    const p = engine.entities.get(id);
    p.x = x;
    p.y = 15;
    p.z = z;
    p.vx = p.vy = p.vz = 0;
    p.weapon = weapon;
    p.deployT = 0;
    p.cooldown = 0;
    p.spawnProtectedUntil = 0;
    p.spawnProtected = false;
    const angles = aimAngles([x, eyeY, z], [lookX, eyeY, lookZ]);
    p.yaw = angles.yaw;
    p.pitch = angles.pitch;
    engine.applyInput(id, { yaw: angles.yaw, pitch: angles.pitch, wantFire: false });
    return p;
  }

  const eventsOf = (kind) => engine.tickEvents.filter((e) => e.kind === kind);

  // (a1) Best-angle selection: a dead-ahead victim at 2 m beats a nearer one
  // sitting 30 degrees off the aim ray, and the swing consumes no ammunition.
  const hero = seat('m-hero', 60, 48, 62, KNIFE);
  seat('m-ahead', 62, 48, 58, KNIFE);
  seat('m-angled', 61.3, 48.75, 58, KNIFE);
  engine.applyInput('m-hero', { wantFire: true });
  engine.resolveWeaponIntent(hero, 0.016);
  const bestHits = eventsOf('hit');
  ok(eventsOf('shoot').length === 1 && eventsOf('shoot')[0].w === 'knife'
    && bestHits.length === 1
    && bestHits[0].attacker === 'm-hero' && bestHits[0].victim === 'm-ahead'
    && bestHits[0].dmg === 58 && bestHits[0].hs === false
    && hero.mag[KNIFE] === 0 && hero.reserve[KNIFE] === 0
    && engine.entities.get('m-angled').hp === 100,
  'knife swing hits the best-angle victim inside the reach cone and consumes no ammo');

  // (a2) Held trigger respects the rpm cadence (120 rpm -> 0.5 s per swing).
  engine.resolveWeaponIntent(hero, 0.016);
  ok(eventsOf('hit').length === 1 && hero.cooldown > 0,
    'held knife trigger cannot swing inside the cooldown');
  engine.updateTimers(hero, 0.5);
  engine.resolveWeaponIntent(hero, 0.016);
  ok(eventsOf('hit').length === 2,
    'held knife trigger swings again once the cadence elapses');

  // (a3) Backstab: swinging from behind the victim's facing multiplies 2.5x.
  engine.tickEvents.length = 0;
  const bHero = seat('b-hero', 60, 48, 62, KNIFE);
  seat('b-back', 62, 48, 70, KNIFE); // faces the same way the swing travels
  engine.applyInput('b-hero', { wantFire: true });
  engine.resolveWeaponIntent(bHero, 0.016);
  const backHits = eventsOf('hit');
  const backKills = eventsOf('kill');
  ok(backHits.length === 1 && backHits[0].dmg === 145 && backHits[0].hs === false
    && backKills.length === 1 && backKills[0].w === 'knife'
    && backKills[0].killer === 'b-hero' && backKills[0].victim === 'b-back'
    && backKills[0].hs === false && backKills[0].lr === false,
  'knife backstab multiplies swing damage and kills through the normal kill path');

  // (a4) Frontal swing: the victim faces the blade, so base damage only.
  engine.tickEvents.length = 0;
  const fHero = seat('f-hero', 60, 48, 62, KNIFE);
  seat('f-face', 62, 48, 58, KNIFE); // faces back toward the hero
  engine.applyInput('f-hero', { wantFire: true });
  engine.resolveWeaponIntent(fHero, 0.016);
  const faceHits = eventsOf('hit');
  ok(faceHits.length === 1 && faceHits[0].dmg === 58
    && engine.entities.get('f-face').hp === 42,
  'frontal knife swing deals base damage with no backstab multiplier');

  // (a5) A wall between blade and body voids the swing and takes no damage.
  engine.tickEvents.length = 0;
  world.setBlock(61, 16, 48, PLANK);
  const wHero = seat('w-hero', 60, 48, 62, KNIFE);
  seat('w-victim', 62, 48, 70, KNIFE);
  engine.applyInput('w-hero', { wantFire: true });
  engine.resolveWeaponIntent(wHero, 0.016);
  ok(eventsOf('shoot').length === 1 && eventsOf('hit').length === 0
    && eventsOf('kill').length === 0
    && world.getBlock(61, 16, 48) === PLANK,
  'a wall between shooter and victim voids the knife swing without block damage');
  world.setBlock(61, 16, 48, AIR);

  // Charged fire helper: press, hold `holdTicks` * 100 ms, release. The shot
  // leaves on release with charge = held / charge.ms (capped at 1).
  function fireCharged(id, holdTicks) {
    engine.applyInput(id, { wantFire: true });
    engine.resolveWeaponIntent(engine.entities.get(id), 0.1);
    for (let i = 0; i < holdTicks; i++) {
      engine.resolveWeaponIntent(engine.entities.get(id), 0.1);
    }
    engine.applyInput(id, { wantFire: false });
    engine.resolveWeaponIntent(engine.entities.get(id), 0.1);
  }

  // (b1) A full charge spears up to pierce.players (6) aligned victims with
  // the 0.9 player falloff per body, killing the first three outright.
  engine.tickEvents.length = 0;
  const lHero = seat('l-hero', 60, 44.5, 80, LANCE, 44.5);
  lHero.ads = true;
  lHero.adsT = 1;
  seat('l-v1', 64, 44.5, 80, LANCE);
  seat('l-v2', 66, 44.5, 80, LANCE);
  seat('l-v3', 68, 44.5, 80, LANCE);
  seat('l-v4', 70, 44.5, 80, LANCE);
  seat('l-v5', 72, 44.5, 80, LANCE);
  seat('l-v6', 74, 44.5, 80, LANCE);
  fireCharged('l-hero', 12); // 1300 ms hold -> a full lance cell
  const lanceHits = eventsOf('hit');
  const lanceShots = eventsOf('shoot');
  const lanceKills = eventsOf('kill');
  ok(lanceShots.length === 1 && lanceShots[0].w === 'lance'
    && lanceShots[0].charge === 1
    && lanceHits.length === 6
    && lanceHits[0].victim === 'l-v1' && lanceHits[0].dmg === 130
    && lanceHits[1].victim === 'l-v2' && lanceHits[1].dmg === 117
    && lanceHits[2].victim === 'l-v3' && lanceHits[2].dmg === 105
    && lanceHits[3].victim === 'l-v4' && lanceHits[3].dmg === 95
    && lanceHits[4].victim === 'l-v5' && lanceHits[4].dmg === 85
    && lanceHits[5].victim === 'l-v6' && lanceHits[5].dmg === 77
    && lanceHits.every((hit) => !hit.hs)
    && lanceKills.length === 3
    && lanceKills.every((kill) => kill.w === 'lance' && kill.killer === 'l-hero')
    && Math.round(engine.entities.get('l-v4').hp * 10) / 10 === 5.2
    && engine.entities.get('l-v5').hp > 0 && engine.entities.get('l-v6').hp > 0
    && lHero.mag[LANCE] === 3,
  'a full-charge lance spears exactly 6 aligned victims with per-body falloff');

  // (b2) A full charge crosses exactly two walls: the body behind them takes
  // wallFalloff-squared damage, a third wall stops the slug for good, and the
  // crossed walls themselves go untouched.
  engine.tickEvents.length = 0;
  world.setBlock(62, 16, 42, PLANK);
  world.setBlock(64, 16, 42, PLANK);
  world.setBlock(68, 16, 42, PLANK);
  const lwHero = seat('lw-hero', 60, 42.5, 80, LANCE, 42.5);
  lwHero.ads = true;
  lwHero.adsT = 1;
  seat('lw-v1', 66, 42.5, 80, LANCE);
  seat('lw-v2', 70, 42.5, 80, LANCE);
  fireCharged('lw-hero', 12);
  const wallHits = eventsOf('hit');
  ok(eventsOf('shoot').length === 1 && eventsOf('shoot')[0].charge === 1
    && wallHits.length === 1 && wallHits[0].victim === 'lw-v1'
    && wallHits[0].dmg === 67 && wallHits[0].hs === false
    && world.getBlock(62, 16, 42) === PLANK
    && world.getBlock(64, 16, 42) === PLANK
    && world.getBlock(68, 16, 42) === AIR
    && Math.round(engine.entities.get('lw-v1').hp * 10) / 10 === 32.6
    && engine.entities.get('lw-v2').hp === 100,
  'a full-charge lance crosses exactly two walls to hurt the body behind and dies on the third');
  world.setBlock(62, 16, 42, AIR);
  world.setBlock(64, 16, 42, AIR);

  // (b3) A sub-full charge pierces no walls (wallPierceAt 1): the slug dies on
  // the first wall, spends its damage on the block, and the body behind lives.
  engine.tickEvents.length = 0;
  world.setBlock(62, 16, 40, PLANK);
  const lsHero = seat('ls-hero', 60, 40.5, 80, LANCE, 40.5);
  lsHero.ads = true;
  lsHero.adsT = 1;
  seat('ls-v', 66, 40.5, 80, LANCE);
  fireCharged('ls-hero', 5); // 600 ms hold -> charge ~0.52, below wallPierceAt
  const lsShot = eventsOf('shoot')[0];
  ok(lsShot && lsShot.w === 'lance' && lsShot.charge > 0.4 && lsShot.charge < 0.6
    && eventsOf('hit').length === 0
    && world.getBlock(62, 16, 40) === AIR
    && engine.entities.get('ls-v').hp === 100,
  'a sub-full lance charge pierces no walls: the slug dies on the first wall and the body behind is unharmed');
  world.setBlock(62, 16, 40, AIR);
}

// ------------------------------------------- longarc bolt combat contracts
// Headless server behavior: the LN-03 LONGARC launches an authoritative bolt
// that reflects off walls (1 on a tap, 3 on a full charge), chips the voxel it
// bounced from, never pierces players, and always fizzles — never blasts.
{
  const world = createMapState('foundry');
  const engine = new GameEngine({ world });
  // Flat arena: solid floor at y=14, open 15..22, across x 56..71 / z 40..55.
  for (let x = 56; x < 72; x++) {
    for (let z = 40; z < 56; z++) {
      for (let y = 15; y <= 22; y++) world.setBlock(x, y, z, AIR);
      world.setBlock(x, 14, z, GRASS);
    }
  }

  const LONGARC = WEAPON_IDS.indexOf('longarc');
  const eyeY = 15 + EYE_HEIGHT;

  // Seat one entity on the arena floor with a weapon and a look direction.
  function seat(id, x, z, lookX, weapon, lookZ = 48) {
    engine.addClient(id, id);
    const p = engine.entities.get(id);
    p.x = x;
    p.y = 15;
    p.z = z;
    p.vx = p.vy = p.vz = 0;
    p.weapon = weapon;
    p.deployT = 0;
    p.cooldown = 0;
    p.spawnProtectedUntil = 0;
    p.spawnProtected = false;
    const angles = aimAngles([x, eyeY, z], [lookX, eyeY, lookZ]);
    p.yaw = angles.yaw;
    p.pitch = angles.pitch;
    engine.applyInput(id, { yaw: angles.yaw, pitch: angles.pitch, wantFire: false });
    return p;
  }

  const eventsOf = (kind) => engine.tickEvents.filter((e) => e.kind === kind);

  // Press, hold `holdTicks` * 100 ms, release: the bolt leaves on release.
  function fireCharged(id, holdTicks) {
    engine.applyInput(id, { wantFire: true });
    engine.resolveWeaponIntent(engine.entities.get(id), 0.1);
    for (let i = 0; i < holdTicks; i++) {
      engine.resolveWeaponIntent(engine.entities.get(id), 0.1);
    }
    engine.applyInput(id, { wantFire: false });
    engine.resolveWeaponIntent(engine.entities.get(id), 0.1);
  }

  // Advance the projectile sim in 50 ms slices until the arena is quiet.
  function runBolt(maxTicks = 64) {
    for (let i = 0; i < maxTicks && engine.projectiles.active.size > 0; i++) {
      engine.now += 50;
      engine.projectiles.step(0.05, engine.projectileContext());
    }
  }

  // (c1) A short tap releases a weak bolt carrying exactly one reflection,
  // which fizzles harmlessly when it finally touches terrain.
  engine.tickEvents.length = 0;
  const cHero = seat('c-hero', 58, 44.5, 70, LONGARC, 44.5);
  cHero.ads = true;
  cHero.adsT = 1;
  fireCharged('c-hero', 1); // 200 ms hold -> a weak tap
  const tapShot = eventsOf('shoot')[0];
  const tapLaunch = eventsOf('projectileLaunch')[0];
  ok(tapShot && tapShot.w === 'longarc' && tapShot.charge > 0 && tapShot.charge < 1
    && tapLaunch && tapLaunch.type === 'bolt' && tapLaunch.bn === 1
    && tapLaunch.fuse === 3000 && tapLaunch.o[0] > 58 && tapLaunch.o[0] < 59.5
    && tapLaunch.v[0] > 45,
  'a short LONGARC tap releases a bolt with a sub-full charge and one reflection');
  runBolt();
  const tapBoom = eventsOf('projectileExplode')[0];
  ok(tapBoom && tapBoom.type === 'bolt' && tapBoom.radius === 0.5
    && eventsOf('hit').length === 0 && eventsOf('kill').length === 0
    && engine.projectiles.active.size === 0,
  'an unobstructed tap bolt fizzles harmlessly with no blast damage');

  // (c2) A full charge arms the heavy bolt with three reflections.
  engine.tickEvents.length = 0;
  const dHero = seat('d-hero', 58, 48, 70, LONGARC, 48);
  dHero.ads = true;
  dHero.adsT = 1;
  fireCharged('d-hero', 8); // 900 ms hold -> a full charge
  const fullShot = eventsOf('shoot')[0];
  const fullLaunch = eventsOf('projectileLaunch')[0];
  ok(fullShot && fullShot.w === 'longarc' && fullShot.charge === 1
    && fullLaunch && fullLaunch.type === 'bolt' && fullLaunch.bn === 3,
  'a full LONGARC charge releases a bolt with three reflections');
  runBolt();
  ok(eventsOf('projectileExplode').length === 1
    && eventsOf('projectileExplode')[0].type === 'bolt'
    && eventsOf('hit').length === 0
    && engine.projectiles.active.size === 0,
  'a full bolt with nothing around still ends as a harmless fizzle');

  // (c3) The direct lane to the victim is walled off, but a ricochet off the
  // corner wall reaches them: the bolt kills through the normal longarc path,
  // chips the wall it bounced from, and fizzles without a blast.
  engine.tickEvents.length = 0;
  world.setBlock(59, 16, 43, PLANK); // blocks the direct hero -> victim ray
  world.setBlock(64, 16, 43, PLANK); // the bounce wall
  const eHero = seat('e-hero', 58, 44.5, 70, LONGARC, 41.8);
  eHero.ads = true;
  eHero.adsT = 1;
  const eVic = seat('e-vic', 60, 42.5, 70, LONGARC);
  eVic.hp = 30;
  fireCharged('e-hero', 8);
  const cornerLaunch = eventsOf('projectileLaunch')[0];
  runBolt();
  const cornerHits = eventsOf('hit');
  const cornerKills = eventsOf('kill');
  const cornerBoom = eventsOf('projectileExplode')[0];
  ok(cornerLaunch && cornerLaunch.type === 'bolt' && cornerLaunch.bn === 3
    && cornerHits.length === 1 && cornerHits[0].victim === 'e-vic'
    && cornerHits[0].attacker === 'e-hero' && cornerHits[0].dmg === 88
    && cornerHits[0].hs === false
    && cornerKills.length === 1 && cornerKills[0].w === 'longarc'
    && cornerKills[0].killer === 'e-hero' && cornerKills[0].victim === 'e-vic'
    && eVic.state === 'dead'
    && cornerBoom && cornerBoom.type === 'bolt' && cornerBoom.radius === 0.5
    && world.getBlock(64, 16, 43) === PLANK
    && engine.blockHp.get('64,16,43') === BLOCK_HP[PLANK] - BOLT_RULES.blockDamage
    && engine.projectiles.active.size === 0,
  'a full bolt ricochets off the corner wall into the protected victim, chips it, and fizzles');
  world.setBlock(59, 16, 43, AIR);
  world.setBlock(64, 16, 43, AIR);

  // (c4) Reflections run out: a tap bolt ping-pongs once between two stone
  // walls and fizzles without hurting anyone, even its own shooter.
  engine.tickEvents.length = 0;
  world.setBlock(58, 16, 46, STONE);
  world.setBlock(64, 16, 46, STONE);
  const fHero = seat('f-hero', 60, 46.5, 80, LONGARC, 46.5);
  fHero.ads = true;
  fHero.adsT = 1;
  fireCharged('f-hero', 1);
  runBolt();
  const pingBoom = eventsOf('projectileExplode')[0];
  ok(pingBoom && pingBoom.type === 'bolt' && pingBoom.radius === 0.5
    && eventsOf('hit').length === 0 && eventsOf('kill').length === 0
    && eventsOf('block').length === 0
    && world.getBlock(58, 16, 46) === STONE && world.getBlock(64, 16, 46) === STONE
    && fHero.hp === 100
    && engine.projectiles.active.size === 0,
  'a tap bolt exhausts its one reflection in the corridor and fizzles without damage');

  // (c5) A full bolt survives three ricochets and dies on its fourth contact.
  engine.tickEvents.length = 0;
  world.setBlock(58, 16, 50, STONE);
  world.setBlock(64, 16, 50, STONE);
  const gHero = seat('g-hero', 60, 50.5, 80, LONGARC, 50.5);
  gHero.ads = true;
  gHero.adsT = 1;
  fireCharged('g-hero', 8);
  const spinLaunch = eventsOf('projectileLaunch')[0];
  runBolt();
  ok(spinLaunch && spinLaunch.type === 'bolt' && spinLaunch.bn === 3
    && eventsOf('projectileExplode').length === 1
    && eventsOf('projectileExplode')[0].type === 'bolt'
    && eventsOf('hit').length === 0 && eventsOf('kill').length === 0
    && eventsOf('block').length === 0
    && world.getBlock(58, 16, 50) === STONE && world.getBlock(64, 16, 50) === STONE
    && gHero.hp === 100
    && engine.projectiles.active.size === 0,
  'a full bolt survives three ricochets between the walls and fizzles on the fourth contact');
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

// Browser-adjacent client contracts live in their own harness so the atlas
// checks stay focused and the shared fakes have one lifecycle owner.
await runClientContracts(ok);


if (failures === 0) console.log('atlastest: ALL OK');
else { console.log(`atlastest: ${failures} failure(s)`); process.exit(1); }
