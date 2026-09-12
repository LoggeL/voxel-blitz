import { ACCENT, CONCRETE, DUST_FLOOR, DUST_TRIM, GROUND } from './blocks.js';
import { generateFlatBase, paintFloor } from './flatmaps.js';
import { LARGE_SITES } from './large-layout.js';
import { buildHarborArchitecture } from './flatmap-harbor.js';
import { buildCanyonArchitecture } from './flatmap-canyon.js';
import { addHarborDetails } from './detail-harbor.js';
import { addCanyonDetails } from './detail-canyon.js';

function sitePads(world, floor, trim) {
  for (const site of LARGE_SITES) {
    paintFloor(world, site.minX, site.minZ, site.maxX, site.maxZ, GROUND, floor);
    for (const z of [site.minZ, site.maxZ]) paintFloor(world, site.minX, z, site.maxX, z, GROUND, trim);
    for (const x of [site.minX, site.maxX]) paintFloor(world, x, site.minZ, x, site.maxZ, GROUND, trim);
  }
}

export function generateHarborInto(world, blocks, heights) {
  generateFlatBase(world, blocks, heights);
  buildHarborArchitecture(world);
  sitePads(world, CONCRETE, ACCENT);
  addHarborDetails(world);
}

export function generateCanyonInto(world, blocks, heights) {
  generateFlatBase(world, blocks, heights);
  buildCanyonArchitecture(world);
  sitePads(world, DUST_FLOOR, DUST_TRIM);
  addCanyonDetails(world);
}
