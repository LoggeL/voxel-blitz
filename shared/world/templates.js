import { generateNuketownInto } from './flatmap-nuketown.js';
import { generateDust2Into } from './flatmap-dust2.js';
import { MAP_IDS } from '../modes.js';
import { BEDROCK, SX, SY, SZ } from './blocks.js';
import { generateDepotInto } from './flatmap-depot.js';
import { generateCitadelInto } from './flatmap-citadel.js';
import { generateSolsticeInto } from './flatmap-solstice.js';
import { generateCalderaInto } from './flatmap-caldera.js';
import { createMapMetadata } from './metadata.js';
import {
  MAP_BYTES,
  MAP_HEADER_BYTES,
  rebuildHeights,
  validateSerializedWorld,
} from './serialize.js';
import { generateKillhouseInto } from './flatmap-killhouse.js';
import { createStateApi } from './state.js';
import { generateFoundryInto } from './terrain-foundry.js';

export { MAP_IDS };

const data = new Uint8Array(SX * SY * SZ);
const heightMap = new Int16Array(SX * SZ);
const defaultWorld = createStateApi(data, heightMap);

function requireMapId(id) {
  if (typeof id !== 'string' || !MAP_IDS.includes(id)) {
    throw new Error(`unknown map: ${String(id)}`);
  }
  return id;
}

function buildPristineTemplate(id) {
  const blocks = new Uint8Array(SX * SY * SZ);
  const heights = new Int16Array(SX * SZ);
  const world = createStateApi(blocks, heights, null, id);

  if (id === 'foundry') generateFoundryInto(world, blocks, heights);
  else if (id === 'depot') generateDepotInto(world, blocks, heights);
  else if (id === 'citadel') generateCitadelInto(world, blocks, heights);
  else if (id === 'caldera') generateCalderaInto(world, blocks, heights);
  else if (id === 'nuketown') generateNuketownInto(world, blocks, heights);
  else if (id === 'dust2') generateDust2Into(world, blocks, heights);
  else if (id === 'killhouse') generateKillhouseInto(world, blocks, heights);
  else generateSolsticeInto(world, blocks, heights);

  blocks.fill(BEDROCK, 0, SX * SZ);
  rebuildHeights(blocks, heights);
  return Object.freeze({
    blocks,
    heights,
    meta: createMapMetadata(id, world),
  });
}

// Build authoritative private baselines at import. Every state receives fresh cells.
const pristineTemplates = new Map();
for (const id of MAP_IDS) pristineTemplates.set(id, buildPristineTemplate(id));

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
  validateSerializedWorld(buf);
  data.set(buf.subarray(MAP_HEADER_BYTES, MAP_BYTES));
  defaultWorld.rebuildHeightMap();
}

export function rebuildHeightMap() {
  defaultWorld.rebuildHeightMap();
}

/** Rebuild the process-global legacy singleton as Foundry. */
export function generateWorld() {
  generateFoundryInto(defaultWorld, data, heightMap);
  data.fill(BEDROCK, 0, SX * SZ);
  defaultWorld.rebuildHeightMap();
}

export function getMapMeta(id) {
  return pristineTemplates.get(requireMapId(id)).meta;
}

export function createMapState(id, serializedBytes) {
  const template = pristineTemplates.get(requireMapId(id));
  let blocks;
  let heights;
  if (serializedBytes === undefined) {
    blocks = template.blocks.slice();
    heights = template.heights.slice();
  } else {
    validateSerializedWorld(serializedBytes);
    blocks = new Uint8Array(template.blocks.length);
    blocks.set(serializedBytes.subarray(MAP_HEADER_BYTES, MAP_BYTES));
    heights = new Int16Array(SX * SZ);
    rebuildHeights(blocks, heights);
  }
  return createStateApi(blocks, heights, template.meta.spawns.fun, id, template.meta);
}

export function createWorldState(serializedBytes) {
  return createMapState('foundry', serializedBytes);
}
