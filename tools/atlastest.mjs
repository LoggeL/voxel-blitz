import { blockKey, damageBlock, resolveWeaponIntent } from '../server/sim/combat.js';
import { updateTimers } from '../server/sim/movement.js';
// Headless sanity checks for the voxel engine's pure logic + real geometry
// classes (three.module.js loads fine under node; nothing here touches canvas
// or WebGL). Run: node tools/atlastest.mjs

import {
  TILE, TILE_PAINTERS, tileRect, faceTile, wob,
  DEFAULT_BLOCK_TILES, ATLAS_SIZE, TILE_PX, GRID,
} from '../public/js/engine/atlas.js';
import {
  AIR, LEAVES, GLASS, GRASS, STONE, WOOD, PLANK, METAL, SX, SZ, SY, BLOCK_HP,
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
  isModeMapCompatible, isTeamMode, mapForMode,
} from '../shared/modes.js';
import { raycastVoxels } from '../shared/raycast.js';
import { WEAPON_IDS, PLAYER_HALF, EYE_HEIGHT } from '../shared/combatmath.js';
import { BOLT_RULES, stepBolt } from '../shared/bolt-rules.js';
import { MAP_CAPTURE_SHOTS } from '../shared/map-capture-shots.js';
import {
  ChunkStore, aoLevel, FACE_SHADE, CHUNK_X,
  MAX_REBUILDS_PER_FRAME,
} from '../public/js/engine/chunks.js';
import * as THREE from '../public/js/vendor/three.module.js';
import { GameEngine } from '../server/game.js';
import { aimAngles } from '../server/sim/player.js';
import { resolveModeMap, parseAdmissionFrame } from '../server/protocol/admission.js';
import { PlayerPhysics } from '../public/js/player-physics.js';
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
  ok(sameValue(MODE_IDS, ['fun', 'duel', 'chaos', 'tdm', 'snd', 'gungame', 'training'])
    && sameValue(MAP_IDS, ['foundry', 'depot', 'citadel', 'solstice', 'caldera', 'nuketown', 'dust2', 'killhouse'])
    && sameValue(TEAM_IDS, ['alpha', 'bravo'])
    && WORLD_MAP_IDS === MAP_IDS
    && deeplyFrozen(MODE_IDS) && deeplyFrozen(MAP_IDS) && deeplyFrozen(TEAM_IDS),
  'mode, map, and team identifiers are exact immutable shared lists');

  ok(mapForMode('training', 'foundry') === 'killhouse'
    && resolveModeMap('training').map === 'killhouse'
    && parseAdmissionFrame({ t: 'create', name: 'Range', bots: 0, gameMode: 'training' }).map === 'killhouse'
    && mapForMode('snd', 'depot') === 'foundry' && mapForMode('invalid') === null,
  'mode defaults agree across browser selection and strict admission, including Training');

  const sndMaps = MAP_IDS.filter((map) => MAP_MODE_COMPATIBILITY[map].includes('snd'));
  const capturedSites = sndMaps.every((map) => ['A', 'B'].every((site) =>
    MAP_CAPTURE_SHOTS.some((shot) =>
      shot.map === map && shot.id === `snd-site-${site.toLowerCase()}` && shot.mode === 'snd')));
  ok(capturedSites,
    'every S&D-compatible map exposes dedicated A/B marker render-validation shots');

  const expectedRules = {
    duel: { teams: false, friendlyFire: true, respawnMs: 1500, killLimit: 5, postMs: 8000 },
    chaos: { teams: false, friendlyFire: true, respawnMs: 1500 },
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
      weaponOrder: ['rifle', 'smg', 'shotgun', 'sniper', 'lmg', 'flamethrower', 'rocket', 'longarc', 'lance', 'revolver', 'minigun', 'knife'],
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
    training: {
      teams: false,
      friendlyFire: false,
      respawnMs: 1500,
    },
  };
  ok(sameValue(MODE_RULES, expectedRules) && deeplyFrozen(MODE_RULES),
    'mode rules are exact and recursively immutable');
  ok(MODE_RULES.gungame.weaponOrder === GUN_GAME_WEAPON_ORDER
    && deeplyFrozen(GUN_GAME_WEAPON_ORDER),
  'Gun Game progression has one exact immutable shared weapon order');
  ok(isTeamMode('tdm') && isTeamMode('snd')
    && !isTeamMode('fun') && !isTeamMode('gungame') && !isTeamMode('training')
    && !isTeamMode('invalid'),
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
    minigun: 4800,
    rocket: 4300,
    flamethrower: 2400,
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
    foundry: ['fun', 'duel', 'chaos', 'tdm', 'snd', 'gungame'],
    depot: ['fun', 'duel', 'chaos', 'tdm', 'gungame'],
    citadel: ['fun', 'duel', 'chaos', 'tdm', 'snd', 'gungame'],
    solstice: ['fun', 'duel', 'chaos', 'tdm', 'snd', 'gungame'],
    caldera: ['fun', 'duel', 'chaos', 'tdm', 'snd', 'gungame'],
    nuketown: ['fun', 'duel', 'chaos', 'tdm', 'snd', 'gungame'],
    dust2: ['fun', 'duel', 'chaos', 'tdm', 'snd', 'gungame'],
    killhouse: ['training'],
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
    nuketown: 'Nuketown',
    dust2: 'Dust 2',
    killhouse: 'Killhouse',
  };
  const expectedMapHashes = {
    foundry: 'db04cb71',
    depot: '41bc3abe',
    citadel: '2848ff82',
    solstice: '58d6eaad',
    caldera: '8454f327',
    nuketown: 'eac51fd4',
    dust2: '7efc9f29',
    killhouse: '395d8d45',
  };
  const expectedSpawnCounts = {
    foundry: { fun: 12, tdmAlpha: 6, tdmBravo: 6, sndAttackers: 5, sndDefenders: 5 },
    depot: { fun: 12, tdmAlpha: 6, tdmBravo: 6, sndAttackers: 0, sndDefenders: 0 },
    citadel: { fun: 12, tdmAlpha: 6, tdmBravo: 6, sndAttackers: 6, sndDefenders: 6 },
    solstice: { fun: 12, tdmAlpha: 6, tdmBravo: 6, sndAttackers: 6, sndDefenders: 6 },
    caldera: { fun: 12, tdmAlpha: 6, tdmBravo: 6, sndAttackers: 6, sndDefenders: 6 },
    nuketown: { fun: 12, tdmAlpha: 6, tdmBravo: 6, sndAttackers: 6, sndDefenders: 6 },
    dust2: { fun: 10, tdmAlpha: 6, tdmBravo: 6, sndAttackers: 6, sndDefenders: 6 },
    killhouse: { fun: 12, tdmAlpha: 6, tdmBravo: 6, sndAttackers: 0, sndDefenders: 0 },
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
    const loopMode = MAP_MODE_COMPATIBILITY[mapId][0];
    const engineA = new GameEngine({ world: roomA, mode: loopMode });
    const engineB = new GameEngine({ world: roomB, mode: loopMode });
    roomA.setBlock(x, probeY, z, GLASS);
    roomA.rebuildHeightMap();
    ok(roomA.getBlock(x, probeY, z) === GLASS
      && roomB.getBlock(x, probeY, z) === AIR
      && roomA.heightAt(x, z) === Math.max(probeY, originalHeight)
      && roomB.heightAt(x, z) === originalHeight,
    `${mapId} room cells and rebuilt height maps are isolated`);

    const key = blockKey(x, probeY, z);
    damageBlock(x, probeY, z, GLASS, 1, engineA.contexts.combat);
    ok(engineA.blockHp.get(key) === BLOCK_HP[GLASS] - 1
      && !engineB.blockHp.has(key)
      && engineA.tickBlocks.length === 0
      && engineB.tickBlocks.length === 0,
    `${mapId} partial block damage is isolated per room`);
    damageBlock(x, probeY, z, GLASS, BLOCK_HP[GLASS], engineA.contexts.combat);
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
  resolveWeaponIntent(hero, 0.016, engine.contexts.combat);
  const bestHits = eventsOf('hit');
  ok(eventsOf('shoot').length === 1 && eventsOf('shoot')[0].w === 'knife'
    && bestHits.length === 1
    && bestHits[0].attacker === 'm-hero' && bestHits[0].victim === 'm-ahead'
    && bestHits[0].dmg === 58 && bestHits[0].hs === false
    && hero.mag[KNIFE] === 0 && hero.reserve[KNIFE] === 0
    && engine.entities.get('m-angled').hp === 100,
  'knife swing hits the best-angle victim inside the reach cone and consumes no ammo');

  // (a2) Held trigger respects the rpm cadence (120 rpm -> 0.5 s per swing).
  resolveWeaponIntent(hero, 0.016, engine.contexts.combat);
  ok(eventsOf('hit').length === 1 && hero.cooldown > 0,
    'held knife trigger cannot swing inside the cooldown');
  updateTimers(hero, 0.5);
  resolveWeaponIntent(hero, 0.016, engine.contexts.combat);
  ok(eventsOf('hit').length === 2,
    'held knife trigger swings again once the cadence elapses');

  // (a3) Backstab: swinging from behind the victim's facing multiplies 2.5x.
  engine.tickEvents.length = 0;
  const bHero = seat('b-hero', 60, 48, 62, KNIFE);
  seat('b-back', 62, 48, 70, KNIFE); // faces the same way the swing travels
  engine.applyInput('b-hero', { wantFire: true });
  resolveWeaponIntent(bHero, 0.016, engine.contexts.combat);
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
  resolveWeaponIntent(fHero, 0.016, engine.contexts.combat);
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
  resolveWeaponIntent(wHero, 0.016, engine.contexts.combat);
  ok(eventsOf('shoot').length === 1 && eventsOf('hit').length === 0
    && eventsOf('kill').length === 0
    && world.getBlock(61, 16, 48) === PLANK,
  'a wall between shooter and victim voids the knife swing without block damage');
  world.setBlock(61, 16, 48, AIR);

  // Charged fire helper: press, hold `holdTicks` * 100 ms, release. The shot
  // leaves on release with charge = held / charge.ms (capped at 1).
  function fireCharged(id, holdTicks) {
    engine.applyInput(id, { wantFire: true });
    resolveWeaponIntent(engine.entities.get(id), 0.1, engine.contexts.combat);
    for (let i = 0; i < holdTicks; i++) {
      resolveWeaponIntent(engine.entities.get(id), 0.1, engine.contexts.combat);
    }
    engine.applyInput(id, { wantFire: false });
    resolveWeaponIntent(engine.entities.get(id), 0.1, engine.contexts.combat);
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
  // Lift the targets so this fixed horizontal lane tests torso damage.
  for (let i = 1; i <= 6; i++) engine.entities.get(`l-v${i}`).y += 0.5;
  fireCharged('l-hero', 28); // 2800 ms reaches a full lance cell
  const lanceHits = eventsOf('hit');
  const lanceShots = eventsOf('shoot');
  const lanceKills = eventsOf('kill');
  ok(lanceShots.length === 1 && lanceShots[0].w === 'lance'
    && lanceShots[0].charge === 1
    && lanceHits.length === 6
    && lanceHits[0].victim === 'l-v1' && lanceHits[0].dmg === 300
    && lanceHits[1].victim === 'l-v2' && lanceHits[1].dmg === 270
    && lanceHits[2].victim === 'l-v3' && lanceHits[2].dmg === 243
    && lanceHits[3].victim === 'l-v4' && lanceHits[3].dmg === 219
    && lanceHits[4].victim === 'l-v5' && lanceHits[4].dmg === 197
    && lanceHits[5].victim === 'l-v6' && lanceHits[5].dmg === 177
    && lanceHits.every((hit) => !hit.hs)
    && lanceKills.length === 6
    && lanceKills.every((kill) => kill.w === 'lance' && kill.killer === 'l-hero')
    && lHero.mag[LANCE] === 0,
  'a full-charge lance spears exactly 6 aligned victims with per-body falloff');

  lHero.state = 'dead'; // Remove the previous scenario's shooter from the adjacent lane.

  // (b2) A full rail destroys successive blocks and hits bodies behind them.
  engine.tickEvents.length = 0;
  world.setBlock(62, 16, 42, PLANK);
  world.setBlock(64, 16, 42, PLANK);
  world.setBlock(68, 16, 42, PLANK);
  const lwHero = seat('lw-hero', 60, 42.5, 80, LANCE, 42.5);
  lwHero.ads = true;
  lwHero.adsT = 1;
  seat('lw-v1', 66, 42.5, 80, LANCE);
  seat('lw-v2', 70, 42.5, 80, LANCE);
  engine.entities.get('lw-v1').y += 0.5;
  engine.entities.get('lw-v2').y += 0.5;
  fireCharged('lw-hero', 28);
  const wallHits = eventsOf('hit');
  ok(eventsOf('shoot').length === 1 && eventsOf('shoot')[0].charge === 1
    && wallHits.length === 2 && wallHits[0].victim === 'lw-v1'
    && wallHits[0].dmg > 200 && wallHits[0].dmg < 300 && wallHits[0].hs === false
    && world.getBlock(62, 16, 42) === AIR
    && world.getBlock(64, 16, 42) === AIR
    && world.getBlock(68, 16, 42) === AIR
    && engine.entities.get('lw-v1').state === 'dead'
    && engine.entities.get('lw-v2').state === 'dead',
  'a full-charge lance destroys three blocks and hits both bodies behind them');
  world.setBlock(62, 16, 42, AIR);
  world.setBlock(64, 16, 42, AIR);

  // (b3) An early release penetrates one wall while retaining its low damage.
  engine.tickEvents.length = 0;
  world.setBlock(62, 16, 40, PLANK);
  const lsHero = seat('ls-hero', 60, 40.5, 80, LANCE, 40.5);
  lsHero.ads = true;
  lsHero.adsT = 1;
  seat('ls-v', 66, 40.5, 80, LANCE);
  engine.entities.get('ls-v').y += 0.5;
  fireCharged('ls-hero', 1); // Early release before the mandatory charge completes.
  const lsShot = eventsOf('shoot')[0];
  ok(lsShot && lsShot.charge > 0 && lsShot.charge < 0.3 && lsHero.mag[LANCE] === 0
    && eventsOf('hit').length === 1
    && world.getBlock(62, 16, 40) === AIR
    && engine.entities.get('ls-v').hp < 100 && engine.entities.get('ls-v').hp > 70,
  'an early rail release breaks soft planks and deals reduced damage beyond');
  world.setBlock(62, 16, 40, AIR);
}

// The heavy rail accepts a grazing body hit that a thin ray misses.
{
  const { nearestVictim } = await import('../server/sim/combat.js');
  const { WEAPONS, PLAYER_HALF } = await import('../shared/combatmath.js');
  const shooter = { bot: true };
  const victim = { state: 'alive', x: 5, y: 0, z: PLAYER_HALF.x + 0.15 };
  const ctx = { entities: new Map([['target', victim]]), canDamage: () => true };
  const origin = [0, 1, 0], direction = { x: 1, y: 0, z: 0 };
  ok(!nearestVictim(shooter, origin, direction, 10, ctx)
      && nearestVictim(shooter, origin, direction, 10, ctx, 0, WEAPONS.lance.hitRadius)?.victim === victim,
    'the wider rail catches a grazing body outside the ordinary hitscan ray');
}

// ------------------------------------------- training firing range contracts
// Headless server behavior: drive the REAL GameEngine in training mode over
// the killhouse template and pin the dummy-target, staged-run, and METAL gate
// contracts through the engine's own step -> snapshot -> block-delta seam.
{
  const meta = getMapMeta('killhouse');
  const world = createMapState('killhouse');
  const frames = [];
  const engine = new GameEngine({
    world,
    mapMeta: meta,
    mode: 'training',
    broadcast: (snapshot) => frames.push(snapshot),
  });
  const posts = meta.dummyPosts;
  const course = meta.course;
  ok([...meta.spawns.fun, ...meta.spawns.tdm.alpha, ...meta.spawns.tdm.bravo, ...posts]
    .every((point) => Math.floor(point.y) === 15),
  'covered Killhouse spawns and all dummy targets stay on the facility floor, never the roof');
  ok(world.getBlock(16, 22, 86) === METAL && world.getBlock(16, 15, 86) === AIR
    && world.getBlock(14, 15, 47) === AIR && world.getBlock(114, 15, 47) === AIR,
  'Killhouse canopy preserves standing headroom and walkable course entry and return doors');
  const openCourse = createMapState('killhouse');
  for (const gate of course.gates) {
    for (let y = course.gateY[0]; y <= course.gateY[1]; y++) {
      for (let z = course.gateZ[0]; z <= course.gateZ[1]; z++) openCourse.setBlock(gate.x, y, z, AIR);
    }
  }
  const visited = new Set(['16,86']);
  const queue = [[16, 86]];
  for (let i = 0; i < queue.length; i++) {
    const [x, z] = queue[i];
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, nz = z + dz, key = `${nx},${nz}`;
      if (nx < 7 || nx > 121 || nz < 26 || nz > 90 || visited.has(key)) continue;
      if (openCourse.getBlock(nx, 14, nz) === AIR || openCourse.getBlock(nx, 15, nz) !== AIR
        || openCourse.getBlock(nx, 16, nz) !== AIR) continue;
      visited.add(key);
      queue.push([nx, nz]);
    }
  }
  ok(posts.every((post) => visited.has(`${post.x},${post.z}`)) && visited.has('114,38'),
    'every target and the finish remain reachable on foot from the covered gallery with course gates open');

  // Teleport the runner onto one cell (y = terrain headroom) and zero its
  // velocity: `_feetInside` keys the run clock to the floored feet cell.
  const runner = (x, z) => {
    const entity = engine.entities.get('runner');
    entity.x = x + 0.5;
    entity.z = z + 0.5;
    entity.y = world.heightAt(x, z) + 1.02;
    entity.vx = entity.vy = entity.vz = 0;
  };
  const dummy = (id) => engine.entities.get(id);
  const gateCells = (gate) => {
    const cells = [];
    for (let y = course.gateY[0]; y <= course.gateY[1]; y++) {
      for (let z = course.gateZ[0]; z <= course.gateZ[1]; z++) {
        cells.push({ x: gate.x, y, z, i: ((y * SZ) + z) * SX + gate.x });
      }
    }
    return cells;
  };
  const gates = course.gates.map(gateCells);
  const stepOnce = () => {
    engine.step(engine.intervalMs);
    return frames[frames.length - 1];
  };
  const eventsOf = (frame, kind) => (frame.events || []).filter((e) => e.kind === kind);
  const openedGateDeltas = (frame, cells) =>
    frame.blocks.length === cells.length
    && frame.blocks.every((delta) => delta.v === AIR && cells.some((cell) => cell.i === delta.i));

  // (a) Zero dummies before the first policy tick, then all 17 as bots on it.
  ok(engine.entities.size === 0, 'training room attaches zero entities before its first tick');
  stepOnce();
  ok([...engine.entities.keys()].length === 17
    && [...engine.entities.keys()].every((id, index) => id === 'dummy-' + index)
    && [...engine.entities.values()].every((entity) => entity.bot && entity.state === 'alive')
    && [...engine.entities.values()].every((entity, index) =>
      entity.name === 'Dummy ' + String(index + 1).padStart(2, '0'))
    && posts.every((post, index) => {
      const entity = engine.entities.get('dummy-' + index);
      return entity.x === post.x + 0.5 && entity.y === post.y && entity.z === post.z + 0.5;
    }),
  'first training tick spawns all 17 dummy targets on their exact posts as bots');

  // Seat one human far from the start region so the idle ticks below start
  // no run: the run clock begins only when feet enter the start cell.
  engine.addClient('runner', 'Runner');
  runner(64, 62);

  // (b) Dummies never fire; humans damage dummies but never each other.
  ok(engine.mode.canFire(dummy('dummy-0')) === false
    && engine.mode.canFire(engine.entities.get('runner')) === true
    && engine.mode.canDamage('runner', 'dummy-0') === true
    && engine.mode.canDamage('runner', 'runner') === false
    && engine.mode.canDamage('dummy-0', 'runner') === false,
  'training damage policy: dummies never fire, humans shoot dummies, humans never shoot humans');

  // (c) A range dummy stays dead through its whole 1200 ms respawn window
  // (23 x 50 ms ticks) and returns to its exact post on the tick past it.
  const rangePost = { x: posts[0].x + 0.5, y: posts[0].y, z: posts[0].z + 0.5 };
  const rangeKilledAt = engine.now;
  engine.killPlayer(dummy('dummy-0'), null, 'world', false);
  for (let i = 0; i < 23; i++) stepOnce();
  ok(engine.now === rangeKilledAt + 1150 && dummy('dummy-0').state === 'dead',
    'range dummy remains dead through 1200 ms minus one tick');
  const rangeReviveFrame = stepOnce();
  ok(rangeReviveFrame.now === rangeKilledAt + 1200
    && dummy('dummy-0').state === 'alive' && dummy('dummy-0').hp === 100
    && dummy('dummy-0').x === rangePost.x && dummy('dummy-0').y === rangePost.y
    && dummy('dummy-0').z === rangePost.z
    && eventsOf(rangeReviveFrame, 'respawn').some((e) => e.id === 'dummy-0'),
  'range dummy respawns at its exact post when the 1200 ms window elapses');

  // (c) A stage dummy plays the same contract over the 4000 ms window.
  const stagePost = { x: posts[9].x + 0.5, y: posts[9].y, z: posts[9].z + 0.5 };
  const stageKilledAt = engine.now;
  engine.killPlayer(dummy('dummy-9'), null, 'world', false);
  for (let i = 0; i < 79; i++) stepOnce();
  ok(engine.now === stageKilledAt + 3950 && dummy('dummy-9').state === 'dead',
    'stage dummy remains dead through 4000 ms minus one tick');
  const stageReviveFrame = stepOnce();
  ok(stageReviveFrame.now === stageKilledAt + 4000
    && dummy('dummy-9').state === 'alive'
    && dummy('dummy-9').x === stagePost.x && dummy('dummy-9').y === stagePost.y
    && dummy('dummy-9').z === stagePost.z,
  'stage dummy respawns at its exact post when the 4000 ms window elapses');

  // (d) Staged run: start, one split per cleared stage, gate cells opening
  // through matching AIR deltas, finish, persisted personal best.
  runner(14, 50);
  const start1Frame = stepOnce();
  const start1 = eventsOf(start1Frame, 'run_start');
  ok(start1.length === 1 && start1[0].id === 'runner' && start1[0].at === start1Frame.now,
    'entering the start cell starts a staged training run on the wire');
  ok(gates.every((cells) => cells.every((cell) => world.getBlock(cell.x, cell.y, cell.z) === METAL)),
    'run start re-arms every METAL gate cell');

  engine.killPlayer(dummy('dummy-9'), null, 'world', false);
  engine.killPlayer(dummy('dummy-10'), null, 'world', false);
  const split0Frame = stepOnce();
  const split0 = eventsOf(split0Frame, 'run_split');
  ok(split0.length === 1 && split0[0].id === 'runner' && split0[0].stage === 0
    && split0[0].ms > 0
    && gates[0].every((cell) => world.getBlock(cell.x, cell.y, cell.z) === AIR)
    && openedGateDeltas(split0Frame, gates[0]),
  'stage zero kills emit one run_split and open the first gate cell by cell');

  engine.addClient('guest', 'Guest');
  Object.assign(engine.entities.get('guest'), { x: 14.5, y: 7, z: 50.5 });
  const guestFrame = stepOnce();
  ok(eventsOf(guestFrame, 'run_start').length === 0
      && gates[0].every((cell) => world.getBlock(cell.x, cell.y, cell.z) === AIR)
      && !engine.mode.canDamage('guest', 'dummy-11') && engine.mode.canDamage('runner', 'dummy-11')
      && engine.mode.canDamage('guest', 'dummy-0'),
    'a second player cannot reset an active course or clear its targets, while range practice remains available');
  engine.removeClient('guest');
  engine.killPlayer(dummy('dummy-11'), null, 'world', false);
  for (let i = 0; i < 85; i++) stepOnce();
  ok(dummy('dummy-9').state === 'dead' && dummy('dummy-11').state === 'dead',
    'stage targets stay cleared throughout a run even beyond their idle respawn deadline');
  engine.killPlayer(dummy('dummy-12'), null, 'world', false);
  const split1Frame = stepOnce();
  ok(eventsOf(split1Frame, 'run_split')[0]?.stage === 1
    && gates[1].every((cell) => world.getBlock(cell.x, cell.y, cell.z) === AIR)
    && openedGateDeltas(split1Frame, gates[1]),
  'stage one opens the second gate cell by cell');
  for (let i = 0; i < 6; i++) stepOnce(); // pad run one so it stays the slower run
  engine.killPlayer(dummy('dummy-13'), null, 'world', false);
  engine.killPlayer(dummy('dummy-14'), null, 'world', false);
  const split2Frame = stepOnce();
  ok(eventsOf(split2Frame, 'run_split')[0]?.stage === 2
    && gates[2].every((cell) => world.getBlock(cell.x, cell.y, cell.z) === AIR)
    && openedGateDeltas(split2Frame, gates[2]),
  'stage two opens the third gate cell by cell');
  for (let i = 0; i < 6; i++) stepOnce();
  engine.killPlayer(dummy('dummy-15'), null, 'world', false);
  engine.killPlayer(dummy('dummy-16'), null, 'world', false);
  const split3Frame = stepOnce();
  ok(eventsOf(split3Frame, 'run_split')[0]?.stage === 3
    && gates.every((cells) => cells.every((cell) => world.getBlock(cell.x, cell.y, cell.z) === AIR)),
  'stage three completes the course with every gate fully open');

  runner(114, 38);
  const finish1Frame = stepOnce();
  const finish1 = eventsOf(finish1Frame, 'run_finish');
  ok(finish1.length === 1 && finish1[0].id === 'runner'
    && finish1[0].ms > 0
    && finish1[0].best === finish1[0].ms
    && finish1[0].splits.length === 4
    && finish1[0].splits.every((value) => Number.isFinite(value) && value > 0),
  'crossing the finish after four splits publishes the run time and a fresh personal best');
  const firstFinish = finish1[0];

  // Re-enter the start for a second run: gates re-arm, stage dummies reset,
  // and re-entering mid-run rearms the clock. Finish faster so the persisted
  // best shrinks to the smaller run time.
  runner(14, 50);
  const start2Frame = stepOnce();
  ok(eventsOf(start2Frame, 'run_start').length === 1
    && gates.every((cells) => cells.every((cell) => world.getBlock(cell.x, cell.y, cell.z) === METAL)),
  're-entering the start re-arms the METAL gates and starts a fresh run');
  runner(64, 62);
  const leftFrame = stepOnce();
  ok(eventsOf(leftFrame, 'run_reset').length === 0 && eventsOf(leftFrame, 'run_finish').length === 0,
    'leaving the start region alone does not reset the run');
  runner(14, 50);
  const rearmedFrame = stepOnce();
  const rearmedResets = eventsOf(rearmedFrame, 'run_reset');
  ok(rearmedResets.length === 1 && rearmedResets[0].reason === 'rearmed'
    && eventsOf(rearmedFrame, 'run_start').length === 1,
    're-entering the start mid-run rearms the run and restarts it fresh');
  for (let index = 9; index <= 16; index++) {
    engine.killPlayer(dummy('dummy-' + index), null, 'world', false);
  }
  for (let i = 0; i < 4; i++) stepOnce();
  runner(114, 38);
  const finish2Frame = stepOnce();
  const finish2 = eventsOf(finish2Frame, 'run_finish');
  ok(finish2.length === 1 && finish2[0].ms > 0
    && finish2[0].best === finish2[0].ms
    && finish2[0].splits.length === 4
    && finish2[0].ms < firstFinish.ms && finish2[0].best < firstFinish.best,
  'a faster second run replaces the persisted personal best with the smaller time');

  // (e) Dying mid-run tears the run down with reason death.
  runner(14, 50);
  const start3Frame = stepOnce();
  ok(eventsOf(start3Frame, 'run_start').length === 1,
    'a third run starts after the second finishes');
  engine.killPlayer(engine.entities.get('runner'), null, 'world', false);
  const deathFrame = stepOnce();
  const deathResets = eventsOf(deathFrame, 'run_reset');
  ok(deathResets.length === 1 && deathResets[0].reason === 'death'
    && deathResets[0].id === 'runner'
    && engine.entities.get('runner').state === 'dead'
    && eventsOf(deathFrame, 'die').some((e) => e.id === 'runner'),
  'dying mid-run resets the staged run with reason death');
}

// ------------------------------------------- longarc bolt combat contracts
// Headless server behavior: the LN-03 LONGARC launches an authoritative bolt
// that reflects off one wall, chips the voxel it
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

  // Advance the projectile sim in 50 ms slices until the arena is quiet.
  function runBolt(maxTicks = 64) {
    for (let i = 0; i < maxTicks && engine.projectiles.active.size > 0; i++) {
      engine.now += 50;
      engine.projectiles.step(0.05, engine.contexts.projectiles);
    }
  }

  // The direct lane to the victim is walled off, but a ricochet off the
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
  eVic.y += 0.5; // Keep the ricochet fixture aimed at the torso.
  engine.applyInput('e-hero', { wantFire: true });
  resolveWeaponIntent(eHero, 0.1, engine.contexts.combat);
  const cornerLaunch = eventsOf('projectileLaunch')[0];
  runBolt();
  const cornerHits = eventsOf('hit');
  const cornerKills = eventsOf('kill');
  const cornerBoom = eventsOf('projectileExplode')[0];
  ok(cornerLaunch && cornerLaunch.type === 'bolt' && cornerLaunch.bn === 1
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

}
// Collision regression: one tick can travel to a wall and back past a body.
{
  const engine = new GameEngine();
  engine.addClient('shooter', 'Shooter');
  engine.addClient('target', 'Target');
  const shooter = engine.entities.get('shooter');
  const target = engine.entities.get('target');
  const ctx = engine.contexts.projectiles;
  for (let x = 38; x <= 44; x++) for (let y = 19; y <= 24; y++) for (let z = 48; z <= 52; z++) {
    engine.world.setBlock(x, y, z, x === 42 ? STONE : AIR);
  }
  Object.assign(shooter, { x: 40, y: 20, z: 50.5 });
  Object.assign(target, { x: 41.6, y: 20, z: 50.5, spawnProtectedUntil: 0 });
  const bolt = engine.projectiles.launchBolt(shooter, ctx, { x: 1, y: 0, z: 0 }, 1);
  engine.tickEvents.length = 0;
  engine.projectiles.step(0.05, ctx);
  ok(target.hp < 100 && !engine.projectiles.active.has(bolt.id)
      && engine.tickEvents.filter((e) => e.kind === 'hit').length === 1,
    'a body on the outgoing ricochet leg is hit before the bolt can reflect back');

  const reflected = { x: 40, y: 21, z: 50.5, vx: 52, vy: 0, vz: 0, bouncesLeft: 3 };
  const travel = [];
  stepBolt(reflected, 0.05, (...args) => raycastVoxels((x) => x === 42, ...args), {
    onTravel: (from, to) => { travel.push([from.x, to.x]); },
  });
  ok(travel.length === 2 && travel[0][1] > travel[0][0] && travel[1][1] < travel[1][0]
      && reflected.traveled > 2.59 && !reflected.hit,
    'shared bolt integration reports both ricochet legs and accumulates actual flight distance');
  const embedded = { x: 42.5, y: 21, z: 50.5, vx: 52, vy: 0, vz: 0, bouncesLeft: 3 };
  stepBolt(embedded, 0.05, (...args) => raycastVoxels((x) => x === 42, ...args));
  ok(embedded.hit && embedded.bouncesLeft === 3,
    'a bolt spawned inside a voxel fizzles instead of inventing zero-normal reflections');
  const edge = { x: 0, y: 5, z: 0, vx: 1, vy: 0.3, vz: 0, bouncesLeft: 1 };
  stepBolt(edge, 0.1, () => ({ x: 1, y: 5, z: 0, nx: -1, ny: 0, nz: 0, t: 0.15 }));
  ok(!edge.hit && edge.bouncesLeft === 0,
    'using the last distance of a frame to ricochet does not prematurely fizzle a bolt');

  target.hp = 100;
  const inert = engine.projectiles.launchBolt(shooter, ctx, { x: 1, y: 0, z: 0 }, 1);
  engine.tickEvents.length = 0;
  engine.projectiles.explode(inert, ctx);
  ok(target.hp === 100 && engine.tickEvents.length === 1 && engine.tickEvents[0].radius === 0.5,
    'every bolt termination path remains a harmless fizzle with no grenade blast fallback');
}

// Client/server movement use the same collision primitive over identical voxels.
{
  const engine = new GameEngine();
  engine.addClient('movement', 'Movement');
  const player = engine.entities.get('movement');
  const physics = new PlayerPhysics();
  physics.solid = engine.solidAt;
  for (let x = 48; x <= 58; x++) for (let z = 48; z <= 58; z++) for (let y = 18; y <= 25; y++) {
    engine.world.setBlock(x, y, z, y === 18 || x === 55 ? STONE : AIR);
  }
  Object.assign(player, { x: 51.5, y: 19, z: 51.5, vx: 0, vy: 0, vz: 0, grounded: true });
  Object.assign(physics.pos, { x: player.x, y: player.y, z: player.z });
  physics.grounded = true;
  engine.applyInput(player.id, { yaw: -Math.PI / 2, pitch: 0, keys: { f: true } });
  for (let i = 0; i < 40; i++) {
    updateTimers(player, 0.05);
    engine.integrate(player, 0.05);
    physics.step(0.05, { x: 1, z: 0 }, 4.4, false);
  }
  ok(Math.abs(player.x - physics.pos.x) < 1e-9 && player.y === physics.pos.y
      && player.x < 55 && player.vx === 0 && physics.vel.x === 0,
    'predicted and authoritative movement stop at the same wall and floor without velocity drift');
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
  update(0.016);
  const dome = skyScene.getObjectByName('skydome');
  ok(dome && dome.renderOrder === -10, 'skydome renders first');
  const skyGroup = skyScene.getObjectByName('sky');
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
(await import('./contracts/player-hitbox-contracts.mjs')).runPlayerHitboxContracts(ok);
(await import('./contracts/player-hitbox-pose-contracts.mjs')).runPlayerHitboxPoseContracts(ok);
await (await import('./contracts/rail-penetration-contracts.mjs')).runRailPenetrationContracts(ok);
await (await import('./contracts/blast-impulse-contracts.mjs')).runBlastImpulseContracts(ok);
await (await import('./contracts/spawn-variety-contracts.mjs')).runSpawnVarietyContracts(ok);
await (await import('./contracts/energy-fx-contracts.mjs')).runEnergyFxContracts(ok);
await (await import('./contracts/vault-contracts.mjs')).runVaultContracts(ok);
await (await import('./contracts/destruction-contracts.mjs')).runDestructionContracts(ok);
await (await import('./contracts/gungame-rules-contracts.mjs')).runGunGameRulesContracts(ok);
await (await import('./contracts/reload-contracts.mjs')).runReloadContracts(ok);
await (await import('./contracts/map-presentation-contracts.mjs')).runMapPresentationContracts(ok);


if (failures === 0) console.log('atlastest: ALL OK');
else { console.log(`atlastest: ${failures} failure(s)`); process.exit(1); }
