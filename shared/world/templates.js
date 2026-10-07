import { generateFrontierInto } from './flatmap-frontier.js';
import { getMapDimensions } from './dimensions.js';
import { generateHarborInto, generateCanyonInto } from './flatmap-large.js';
import { generateNuketownInto } from './flatmap-nuketown.js';
import { generateDust2Into } from './flatmap-dust2.js';
import { generateReactorInto } from './flatmap-reactor.js';
import { generateCausewayInto } from './flatmap-causeway.js';
import { MAP_IDS } from '../modes.js';
import { BEDROCK, SX, SY, SZ } from './blocks.js';
import { generateDepotInto } from './flatmap-depot.js';
import { generateCitadelInto } from './flatmap-citadel.js';
import { generateSolsticeInto } from './flatmap-solstice.js';
import { generateCalderaInto } from './flatmap-caldera.js';
import { createMapMetadata } from './metadata.js';
import {
  deserializeBlocks,
  rebuildHeights,
  validateSerializedWorld,
} from './serialize.js';
import { generateKillhouseInto } from './flatmap-killhouse.js';
import { generateMinecraftB5Into } from './flatmap-minecraft-b5.js';
import { generateWaterworldInto } from './flatmap-waterworld.js';
import { generateBikiniBottomInto } from './flatmap-bikini-bottom.js';
import { createStateApi } from './state.js';
import { generateFoundryInto } from './terrain-foundry.js';

export { MAP_IDS };

let data = new Uint8Array(SX * SY * SZ);
let heightMap = new Int16Array(SX * SZ);
let defaultWorld = createStateApi(data, heightMap);

function requireMapId(id) {
  if (typeof id !== 'string' || !MAP_IDS.includes(id)) {
    throw new Error(`unknown map: ${String(id)}`);
  }
  return id;
}

function buildPristineTemplate(id) {
  const dimensions = getMapDimensions(id);
  const { sx: SX, sy: SY, sz: SZ } = dimensions;
  const blocks = new Uint8Array(SX * SY * SZ);
  const heights = new Int16Array(dimensions.sx * dimensions.sz);
  const world = createStateApi(blocks, heights, null, id);

  if (id === 'frontier') generateFrontierInto(world, blocks, heights);
  else if (id === 'harbor') generateHarborInto(world, blocks, heights);
  else if (id === 'canyon') generateCanyonInto(world, blocks, heights);
  else if (id === 'foundry') generateFoundryInto(world, blocks, heights);
  else if (id === 'depot') generateDepotInto(world, blocks, heights);
  else if (id === 'citadel') generateCitadelInto(world, blocks, heights);
  else if (id === 'caldera') generateCalderaInto(world, blocks, heights);
  else if (id === 'nuketown') generateNuketownInto(world, blocks, heights);
  else if (id === 'dust2') generateDust2Into(world, blocks, heights);
  else if (id === 'reactor') generateReactorInto(world, blocks, heights);
  else if (id === 'killhouse') generateKillhouseInto(world, blocks, heights);
  else if (id === 'minecraft_b5') generateMinecraftB5Into(world, blocks, heights);
  else if (id === 'waterworld') generateWaterworldInto(world, blocks, heights);
  else if (id === 'causeway') generateCausewayInto(world, blocks, heights);
  else if (id === 'bikini_bottom') generateBikiniBottomInto(world, blocks, heights);
  else generateSolsticeInto(world, blocks, heights);

  blocks.fill(BEDROCK, 0, SX * SZ);
  rebuildHeights(blocks, heights, dimensions);
  return Object.freeze({
    blocks,
    heights,
    meta: createMapMetadata(id, world),
  });
}

// Build authoritative private baselines at import. Every state receives fresh cells.
const pristineTemplates = new Map();
for (const id of MAP_IDS) if (id !== 'frontier') pristineTemplates.set(id, buildPristineTemplate(id));
function getTemplate(id) {
  requireMapId(id);
  if (!pristineTemplates.has(id)) pristineTemplates.set(id, buildPristineTemplate(id));
  return pristineTemplates.get(id);
}
// Frontier metadata is static (terrain-derived, no voxels) and built on first use.
let frontierMetadata = null;
const frontierMeta = () => (frontierMetadata ??= createMapMetadata('frontier', { dimensions: getMapDimensions('frontier') }));

const defaultTemplate = pristineTemplates.get('foundry');
data.set(defaultTemplate.blocks);
heightMap.set(defaultTemplate.heights);

export function getBlock(x, y, z) {
  return defaultWorld.getBlock(x, y, z);
}

export function setBlock(x, y, z, value) {
  return defaultWorld.setBlock(x, y, z, value);
}

export function heightAt(x, z) {
  return defaultWorld.heightAt(x, z);
}

/** Deterministic spread surface spawns in the legacy Foundry singleton. */
export function findSpawns(n) {
  return defaultWorld.findSpawns(n);
}

/** 'VB', version, dimensions, then raw block bytes. */
export function serializeWorld() {
  return defaultWorld.serializeWorld();
}

export function deserializeWorld(buf) {
  const dimensions = validateSerializedWorld(buf);
  data = deserializeBlocks(buf).blocks;
  heightMap = new Int16Array(dimensions.sx * dimensions.sz);
  defaultWorld = createStateApi(data, heightMap, null, 'foundry', null, dimensions);
  defaultWorld.rebuildHeightMap();
}

export function rebuildHeightMap() {
  defaultWorld.rebuildHeightMap();
}

/** Rebuild the process-global legacy singleton as Foundry. */
export function generateWorld() {
  data = new Uint8Array(SX * SY * SZ);
  heightMap = new Int16Array(SX * SZ);
  defaultWorld = createStateApi(data, heightMap);
  generateFoundryInto(defaultWorld, data, heightMap);
  data.fill(BEDROCK, 0, SX * SZ);
  defaultWorld.rebuildHeightMap();
}

export function getMapMeta(id) {
  requireMapId(id);
  return id === 'frontier' ? frontierMeta() : getTemplate(id).meta;
}

export function createMapState(id, serializedBytes) {
  const template = getTemplate(id);
  const dimensions = getMapDimensions(id);
  let blocks;
  let heights;
  if (serializedBytes === undefined) {
    blocks = template.blocks.slice();
    heights = template.heights.slice();
  } else {
    validateSerializedWorld(serializedBytes, dimensions);
    blocks = deserializeBlocks(serializedBytes, dimensions).blocks;
    heights = new Int16Array(dimensions.sx * dimensions.sz);
    rebuildHeights(blocks, heights, dimensions);
  }
  return createStateApi(blocks, heights, template.meta.spawns.fun, id, template.meta);
}

export function createWorldState(serializedBytes) {
  return createMapState('foundry', serializedBytes);
}
