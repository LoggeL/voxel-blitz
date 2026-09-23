import { DEFAULT_DIMENSIONS } from '../../../shared/world/dimensions.js';
// Column-chunk mesher: 16 x SY x 16 world slices -> one BufferGeometry per
// material bucket (opaque / cutout / glass / fluids). Vertex colours bake
// classic 4-sample ambient occlusion, per-face directional shading, a slow
// macro tone and floor grime. Solid buckets sample a per-tile texture array
// (no atlas bleeding, clean mips) with hashed rotation/mirroring against
// visible tiling, and read the voxel light volume for sky occlusion, sun
// shadows and block light. Fluids keep the 2D atlas sheet.

import * as THREE from '../vendor/three.module.js';
import {
  AIR, GRASS, DIRT, LEAVES, GLASS, MC_GRASS, MC_GLASS, MC_LEAVES, MC_WATER, MC_LAVA, MC_PORTAL,
  MC_GHOST_GRASS, MC_GLOWSTONE, MC_GHOST_GLOWSTONE,
  BB_PINE_LEAF, BB_KELP,
} from '../../../shared/worlddata.js';
import { createFluidMaterial } from './fluid-material.js';
import { DAMAGE_GRID, damageStage, damageCells } from './block-damage-geometry.js';
import { TILE, mapSurface, BOUNDARY_SKIN } from './atlas.js';
import {
  createVoxelLightUniforms, VOXEL_LIGHT_PARS, VOXEL_LIGHT_SAMPLE, VOXEL_LIGHT_MODULATE,
  voxelLightsFragmentBegin,
} from './voxel-light.js';

export const CHUNK_X = 16;
export const CHUNK_Z = 16;
/** Frame budget: at most this many chunk rebuilds drained per update() call. */
export const MAX_REBUILDS_PER_FRAME = 3;

/** AO brightness by occupied-sample count (0..3). */
export const AO_LEVELS = [0.42, 0.62, 0.82, 1.0];

/**
 * Classic corner rule: when both adjacent sides are solid the corner sample is
 * ignored (count forced to 3) so AO cannot leak through diagonal gaps.
 */
export function aoIndex(side1, side2, corner) {
  return side1 && side2 ? 3 : side1 + side2 + corner;
}

/**
 * Brightness lookup: sample counts feed the classic rule (aoIndex above), then
 * the LUT is read 3-minus-count so open corners stay bright, occluded darken.
 */
export function aoLevel(side1, side2, corner) {
  return AO_LEVELS[3 - aoIndex(side1, side2, corner)];
}

/** Fixed directional shade per face id 0:+X 1:-X 2:+Y 3:-Y 4:+Z 5:-Z. */
export const FACE_SHADE = [0.76, 0.76, 1.0, 0.58, 0.84, 0.84];

// Tangent frame per face: origin corner offset within the voxel cube, then U
// and V edge directions such that U x V = N. Vertex order p00, p10, p11, p01
// is therefore guaranteed CCW seen from outside the block.
const FACES = [
  { n: [1, 0, 0], o: [1, 0, 1], u: [0, 0, -1], v: [0, 1, 0] }, // +X
  { n: [-1, 0, 0], o: [0, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },  // -X
  { n: [0, 1, 0], o: [0, 1, 0], u: [0, 0, 1], v: [1, 0, 0] },   // +Y
  { n: [0, -1, 0], o: [0, 0, 0], u: [1, 0, 0], v: [0, 0, 1] },  // -Y
  { n: [0, 0, 1], o: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },   // +Z
  { n: [0, 0, -1], o: [1, 0, 0], u: [-1, 0, 0], v: [0, 1, 0] }, // -Z
];
const CORNER_UV = [[0, 0], [1, 0], [1, 1], [0, 1]];

const CUTOUT = new Set([LEAVES, MC_LEAVES, BB_PINE_LEAF, BB_KELP]);
const TRANSLUCENT = new Set([GLASS, MC_GLASS, MC_WATER, MC_PORTAL]);
/** Fluids render through their own animated materials, one bucket each. */
const FLUID_BUCKETS = Object.freeze({ [MC_WATER]: 'water', [MC_LAVA]: 'lava' });
// Neighbour faces next to any fluid stay visible: the animated surface dips
// below the block top, so a culled side would show the sky through the gap.
const isSeeThrough = (v) => CUTOUT.has(v) || TRANSLUCENT.has(v) || v === MC_LAVA;
/** Fluids and the portal film never darken neighbouring faces. */
const NO_OCCLUDE = new Set([AIR, MC_WATER, MC_PORTAL]);
const GRASS_TOPS = new Set([GRASS, MC_GRASS, MC_GHOST_GRASS]);
/** Self-lit blocks: no AO or face shade, an HDR emissive term in the shader. */
const EMISSIVE = new Set([MC_GLOWSTONE, MC_GHOST_GLOWSTONE, MC_PORTAL]);

/** Isotropic tiles: tops and bottoms rotate per block so fields never tile. */
const ROTATABLE = new Set([
  TILE.GRASS_TOP, TILE.DIRT, TILE.STONE, TILE.SAND, TILE.CONCRETE, TILE.ASPHALT, TILE.PALE,
  TILE.LEAVES, TILE.MC_GRASS_TOP, TILE.MC_DIRT, TILE.MC_STONE, TILE.MC_SAND, TILE.MC_GRAVEL,
  TILE.MC_CLAY, TILE.MC_NETHERRACK, TILE.MC_OBSIDIAN, TILE.MC_COBBLE, TILE.MC_MOSSY, TILE.MC_LEAVES,
  TILE.DUST_PLASTER, TILE.DUST_FLOOR, TILE.MC_CLOUD, TILE.MC_WOOL_WHITE, TILE.MC_WOOL_RED,
  TILE.ARMOR_CONCRETE,
]);
/** Side tiles with lettering or handed detail keep their orientation. */
const NO_MIRROR = new Set([
  TILE.MC_TNT_SIDE, TILE.AIR_DEBUG,
  // Facade ribs and hazard stripes must line up across neighbouring blocks.
  TILE.FACADE_PANEL, TILE.FACADE_JOINT, TILE.FACADE_PILLAR, TILE.FACADE_BASE,
]);

/** Boundary skins cover cells this close to the map edge... */
export const BOUNDARY_SHELL = 4;
/**
 * ...in columns whose topmost block sits within this many cells of the world
 * ceiling (inner dressing layers may stop short of the outer shell)...
 */
export const BOUNDARY_TOP_SLACK = 10;
/** ...and whose solid run hangs down from that top at least this far. */
export const BOUNDARY_MIN_RUN = 10;
/** Every fourth cladding course carries a horizontal panel joint. */
const FACADE_JOINT_EVERY = 4;

/** Integer hash of a block position and salt -> 0..2^32. */
function blockHash(x, y, z, salt) {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 2147483647) ^ Math.imul(salt, 144665);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * Per-face UV transform: 0-3 quarter turns for rotatable tops/bottoms, a
 * mirror for side faces. Shared by intact and chipped faces, so a block never
 * visibly turns when its first damage stage appears.
 */
function faceUvTransform(wx, wy, wz, f, tile) {
  const h = blockHash(wx, wy, wz, f + 1);
  if (f === 2 || f === 3) return ROTATABLE.has(tile) ? (h & 3) : 0;
  return NO_MIRROR.has(tile) ? 0 : (h & 1) << 2;
}

/** Map face-local (u, t) through a transform: bits 0-1 rotation, bit 2 mirror. */
function transformUv(u, t, transform, out) {
  if (transform & 4) u = 1 - u;
  switch (transform & 3) {
    case 1: out[0] = 1 - t; out[1] = u; break;
    case 2: out[0] = 1 - u; out[1] = 1 - t; break;
    case 3: out[0] = t; out[1] = 1 - u; break;
    default: out[0] = u; out[1] = t;
  }
  return out;
}

function lattice(ix, iy, iz) {
  return blockHash(ix, iy, iz, 97) / 4294967295;
}

/**
 * Smooth 3D value noise in -1..1 with 11-voxel cells: large floors and walls
 * drift a few percent in tone, which breaks the repetition of identical tiles
 * without re-drawing the block grid that per-block jitter would.
 */
export function macroTone(x, y, z) {
  const s = 1 / 11;
  const gx = x * s, gy = y * s, gz = z * s;
  const ix = Math.floor(gx), iy = Math.floor(gy), iz = Math.floor(gz);
  let fx = gx - ix, fy = gy - iy, fz = gz - iz;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy); fz = fz * fz * (3 - 2 * fz);
  const l = (dx, dy, dz) => lattice(ix + dx, iy + dy, iz + dz);
  const x00 = l(0, 0, 0) + (l(1, 0, 0) - l(0, 0, 0)) * fx;
  const x10 = l(0, 1, 0) + (l(1, 1, 0) - l(0, 1, 0)) * fx;
  const x01 = l(0, 0, 1) + (l(1, 0, 1) - l(0, 0, 1)) * fx;
  const x11 = l(0, 1, 1) + (l(1, 1, 1) - l(0, 1, 1)) * fx;
  const y0 = x00 + (x10 - x00) * fy, y1 = x01 + (x11 - x01) * fy;
  return (y0 + (y1 - y0) * fz) * 2 - 1;
}
const MACRO_AMPLITUDE = 0.06;
/** Wall base grime and ceiling soot, as multipliers on the vertex colour. */
const GRIME_FLOOR = 0.86;
const GRIME_CEILING = 0.93;

const TERRAIN_VERTEX_PARS = /* glsl */ `
attribute float terrainLayer;
attribute vec4 terrainAux;
varying vec3 vTerrainUv;
varying vec4 vTerrainAux;
varying vec3 vVoxelWorld;
varying vec3 vVoxelNormal;
`;

const TERRAIN_FRAGMENT_PARS = /* glsl */ `
uniform highp sampler2DArray terrainMap;
#ifdef TERRAIN_NORMALS
uniform highp sampler2DArray terrainNormalMap;
#endif
uniform float terrainEmissive;
varying vec3 vTerrainUv;
varying vec4 vTerrainAux;
varying vec3 vVoxelWorld;
varying vec3 vVoxelNormal;
${VOXEL_LIGHT_PARS}
`;

const TERRAIN_MAP = /* glsl */ `
vec4 terrainTexel = texture( terrainMap, vTerrainUv );
#ifdef TERRAIN_CUTOUT
  // Mip levels average leaf holes into half-alpha; lift alpha with the mip
  // level so distant canopies stay full instead of dissolving.
  vec2 terrainTexelUv = vTerrainUv.xy * 16.0;
  vec2 tdx = dFdx( terrainTexelUv ), tdy = dFdy( terrainTexelUv );
  float terrainLod = max( 0.0, 0.5 * log2( max( dot( tdx, tdx ), dot( tdy, tdy ) ) ) );
  terrainTexel.a *= 1.0 + terrainLod * 0.35;
#endif
diffuseColor *= terrainTexel;
`;

// Convex block edges catch a one-texel highlight lip, anti-aliased with fwidth.
const TERRAIN_EDGES = /* glsl */ `
#include <color_fragment>
#ifdef TERRAIN_EDGES
{
  float mask = floor( vTerrainAux.x * 255.0 + 0.5 );
  vec2 tuv = vTerrainUv.xy;
  float edge = 4.0;
  if ( mod( mask, 2.0 ) >= 1.0 ) edge = min( edge, tuv.x );
  if ( mod( floor( mask * 0.5 ), 2.0 ) >= 1.0 ) edge = min( edge, 1.0 - tuv.x );
  if ( mod( floor( mask * 0.25 ), 2.0 ) >= 1.0 ) edge = min( edge, tuv.y );
  if ( mod( floor( mask * 0.125 ), 2.0 ) >= 1.0 ) edge = min( edge, 1.0 - tuv.y );
  float aa = fwidth( edge ) + 1e-4;
  float lip = 1.0 - smoothstep( 0.0625 - aa, 0.0625 + aa, edge );
  diffuseColor.rgb *= 1.0 + lip * 0.17;
}
#endif
`;

// Pixel relief from the per-layer normal array, in a derivative tangent frame.
const TERRAIN_NORMAL_MAP = /* glsl */ `
#ifdef TERRAIN_NORMALS
{
  vec3 q0 = dFdx( - vViewPosition ), q1 = dFdy( - vViewPosition );
  vec2 st0 = dFdx( vTerrainUv.xy ), st1 = dFdy( vTerrainUv.xy );
  vec3 q1perp = cross( q1, normal ), q0perp = cross( normal, q0 );
  vec3 T = q1perp * st0.x + q0perp * st1.x;
  vec3 B = q1perp * st0.y + q0perp * st1.y;
  float det = max( dot( T, T ), dot( B, B ) );
  float scale = det == 0.0 ? 0.0 : inversesqrt( det );
  vec3 mapN = texture( terrainNormalMap, vTerrainUv ).xyz * 2.0 - 1.0;
  normal = normalize( mat3( T * scale, B * scale, normal ) * mapN );
}
#endif
`;

// Glass thickens and picks up a faint sky reflection towards grazing angles
// (Schlick fresnel). Head-on panes keep their tile alpha, so sight lines
// through windows stay readable; the alpha lift is capped at +0.25.
const TERRAIN_GLASS_FRESNEL = /* glsl */ `
#ifdef TERRAIN_GLASS
{
  float glassFacing = clamp( abs( dot( normal, normalize( vViewPosition ) ) ), 0.0, 1.0 );
  // The emissive portal film shares this bucket and keeps its own glow.
  float glassFresnel = pow( 1.0 - glassFacing, 5.0 ) * ( 1.0 - step( 0.5, vTerrainAux.y ) );
  #if NUM_HEMI_LIGHTS > 0
    vec3 glassSky = hemisphereLights[ 0 ].skyColor * 0.55;
  #else
    vec3 glassSky = vec3( 0.36, 0.45, 0.55 );
  #endif
  glassSky *= voxelLight.sky;
  outgoingLight = mix( outgoingLight, glassSky, glassFresnel * 0.6 );
  diffuseColor.a = min( 1.0, diffuseColor.a + glassFresnel * 0.25 );
}
#endif
#include <opaque_fragment>
`;

const TERRAIN_EMISSIVE = /* glsl */ `
#include <emissivemap_fragment>
totalEmissiveRadiance += diffuseColor.rgb * vTerrainAux.y * terrainEmissive;
`;

/**
 * Terrain material: MeshLambert lighting with the texture array, edge lip,
 * optional pixel normals and the voxel light volume patched in. One program
 * per bucket kind; the cache key never changes during a match.
 */
export function createTerrainMaterial(kind, {
  map = null, normalMap = null, lightUniforms = createVoxelLightUniforms(), edgeShading = true,
} = {}) {
  const material = new THREE.MeshLambertMaterial({
    vertexColors: true,
    alphaTest: kind === 'cutout' ? 0.5 : 0,
    transparent: kind === 'glass',
    depthWrite: kind !== 'glass',
  });
  material.name = `terrain-${kind}`;
  const uniforms = {
    terrainMap: { value: map },
    terrainNormalMap: { value: normalMap },
    terrainEmissive: { value: 1.7 },
    voxelLightMap: lightUniforms.voxelLightMap,
    voxelLightSize: lightUniforms.voxelLightSize,
    voxelLightParams: lightUniforms.voxelLightParams,
    voxelLightView: lightUniforms.voxelLightView,
  };
  material.userData.terrainUniforms = uniforms;
  const defines = [
    kind === 'cutout' ? '#define TERRAIN_CUTOUT' : '',
    edgeShading && kind === 'opaque' ? '#define TERRAIN_EDGES' : '',
    normalMap && kind !== 'glass' ? '#define TERRAIN_NORMALS' : '',
    kind === 'glass' ? '#define TERRAIN_GLASS' : '',
  ].filter(Boolean).join('\n');
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${TERRAIN_VERTEX_PARS}`)
      .replace('#include <uv_vertex>', `#include <uv_vertex>
  vTerrainUv = vec3( uv, terrainLayer );
  vTerrainAux = terrainAux;
  vVoxelWorld = position;
  vVoxelNormal = normal;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `${defines}\n#include <common>\n${TERRAIN_FRAGMENT_PARS}`)
      .replace('#include <map_fragment>', TERRAIN_MAP)
      .replace('#include <color_fragment>', TERRAIN_EDGES)
      .replace('#include <normal_fragment_maps>', TERRAIN_NORMAL_MAP)
      .replace('#include <emissivemap_fragment>', TERRAIN_EMISSIVE)
      .replace('#include <lights_fragment_begin>', `${VOXEL_LIGHT_SAMPLE}\n${voxelLightsFragmentBegin()}`)
      .replace('#include <aomap_fragment>', VOXEL_LIGHT_MODULATE)
      .replace('#include <opaque_fragment>', TERRAIN_GLASS_FRESNEL);
  };
  material.customProgramCacheKey = () => `terrain|${kind}|${defines}`;
  return material;
}

/** Per-position hash jitter source for tint code paths -> 0..100. */
function posJitter(x, y, z) {
  return ((x * 7 + y * 13 + z * 31) % 101 + 101) % 101;
}

export class ChunkStore {
  /**
   * @param {THREE.Scene} scene parent; chunk meshes are added to a group at origin
   * @param atlas atlas surface from buildAtlas(): texture(), tileRect(), faceTile()
   * @param getBlockFn live voxel getter (x,y,z)->blockId closed over the CURRENT
   *        store, so rebuilds always read fresh blocks and chunk-border
   *        neighbours resolve exactly across chunk seams.
   * @param getBlockDamage optional live visual damage getter (x,y,z)->0..1
   */
  constructor(scene, atlas, getBlockFn, getBlockDamage = () => 0, dimensions = DEFAULT_DIMENSIONS, {
    lightUniforms = createVoxelLightUniforms(), edgeShading = true, mapId = null,
  } = {}) {
    this.dimensions = dimensions;
    this.width = Math.ceil(dimensions.sx / CHUNK_X);
    this.depth = Math.ceil(dimensions.sz / CHUNK_Z);
    this.scene = scene;
    this.atlas = atlas;
    this.getBlock = getBlockFn;
    this.getBlockDamage = getBlockDamage;
    // FACE_MAP aligned with the atlas sheet via the atlas' own registry, then
    // the map's own surface treatment: whole-tile remaps and boundary skins.
    const surface = mapSurface(mapId);
    this.surface = surface;
    const remap = surface.remap;
    const baseTile = remap
      ? (id, face) => { const tile = atlas.faceTile(id, face); return remap[tile] ?? tile; }
      : (id, face) => atlas.faceTile(id, face);
    // Column cache for boundary walls: -2 unknown, -1 not a wall, else base y.
    // Decided once from the map as it stands when the view is built and never
    // reset by block deltas: the skin is decoration, so a destroyed cell only
    // removes its own faces instead of un-skinning its whole column.
    this.wallBase = surface.boundary ? new Int16Array(dimensions.sx * dimensions.sz).fill(-2) : null;
    if (this.wallBase) this.scanBoundaryWalls();
    this.FACE_MAP = {
      resolveTile: surface.boundary
        ? (id, face, x, y, z) => this.boundaryTile(baseTile(id, face), face, x, y, z)
        : baseTile,
    };

    this.group = new THREE.Group();
    this.group.name = 'chunks';
    scene.add(this.group);

    this.chunks = new Map();     // "cx,cz" -> { cx, cz, meshes: [] }
    this.dirtyQueue = [];        // FIFO of keys awaiting rebuild
    this.queued = new Set();

    const tex = atlas.texture();
    const terrain = atlas.terrainTextures?.() || { map: null, normalMap: null };
    const terrainOptions = { ...terrain, lightUniforms, edgeShading };
    this.lightUniforms = lightUniforms;
    this.materials = {
      opaque: createTerrainMaterial('opaque', terrainOptions),
      cutout: createTerrainMaterial('cutout', terrainOptions),
      glass: createTerrainMaterial('glass', terrainOptions),
      water: createFluidMaterial('water', { map: tex, tileRect: atlas.tileRect(atlas.faceTile(MC_WATER, 2)) }),
      lava: createFluidMaterial('lava', { map: tex, tileRect: atlas.tileRect(atlas.faceTile(MC_LAVA, 2)) }),
    };
  }

  chunkKey(cx, cz) { return cx + ',' + cz; }

  /** Synchronous initial build of every chunk column. */
  buildAll() {
    for (let cz = 0; cz < this.depth; cz++) {
      for (let cx = 0; cx < this.width; cx++) {
        this.rebuildChunk(cx, cz);
      }
    }
    return this;
  }

  /**
   * Queue-safe block mutation from netcode/events: remeshes own chunk plus any
   * neighbour when the changed voxel touches a chunk border. The new block id
   * is not needed: rebuilds read the live store through getBlock.
   */
  applyBlockDelta(x, y, z) {
    const { sx: SX, sy: SY, sz: SZ } = this.dimensions;
    if (x < 0 || z < 0 || x >= SX || z >= SZ || y < 0 || y >= SY) return;
    const cx = x >> 4, cz = z >> 4;
    this.markDirty(cx, cz);
    const lx = x & 15, lz = z & 15;
    if (lx === 0) this.markDirty(cx - 1, cz);
    else if (lx === 15) this.markDirty(cx + 1, cz);
    if (lz === 0) this.markDirty(cx, cz - 1);
    else if (lz === 15) this.markDirty(cx, cz + 1);
    // Corner edits also feed the AO corner sample of the DIAGONAL chunk.
    if ((lx === 0 || lx === 15) && (lz === 0 || lz === 15)) {
      this.markDirty(cx + (lx ? 1 : -1), cz + (lz ? 1 : -1));
    }
  }

  /** Resolves every perimeter column's wall base up front (initial map state). */
  scanBoundaryWalls() {
    const { sx: SX, sz: SZ } = this.dimensions;
    for (let z = 0; z < SZ; z++) {
      const edgeZ = Math.min(z, SZ - 1 - z) < BOUNDARY_SHELL;
      for (let x = 0; x < SX; x++) {
        if (edgeZ || Math.min(x, SX - 1 - x) < BOUNDARY_SHELL) this.wallBaseAt(x, z);
      }
    }
  }

  /**
   * Lowest y of the solid run that hangs down from a perimeter column's top,
   * or -1 when the column is no tall boundary wall. Cached per column for the
   * lifetime of the store (see constructor).
   */
  wallBaseAt(x, z) {
    const { sx: SX, sy: SY, sz: SZ } = this.dimensions;
    if (Math.min(x, z, SX - 1 - x, SZ - 1 - z) >= BOUNDARY_SHELL) return -1;
    const index = x + z * SX;
    let base = this.wallBase[index];
    if (base !== -2) return base;
    const solid = (y) => { const id = this.getBlock(x, y, z); return id !== AIR && !isSeeThrough(id); };
    let top = SY - 1;
    while (top >= SY - 1 - BOUNDARY_TOP_SLACK && !solid(top)) top--;
    let y = top;
    while (y >= 0 && solid(y)) y--;
    base = top >= SY - 1 - BOUNDARY_TOP_SLACK && top - y >= BOUNDARY_MIN_RUN ? y + 1 : -1;
    this.wallBase[index] = base;
    return base;
  }

  /**
   * Boundary skin for a side face of a tall perimeter wall: ribbed cladding
   * for the grey shell materials, steel pilasters for METAL, a hazard kick
   * band where the face meets the floor in front of it. Destructible METAL
   * cover inside the map is never a full-height perimeter column, so it keeps
   * its own tile.
   */
  boundaryTile(tile, f, x, y, z) {
    if (f === 2 || f === 3 || x === undefined) return tile;
    const skin = BOUNDARY_SKIN[tile];
    if (skin === undefined) return tile;
    const base = this.wallBaseAt(x, z);
    if (base < 0 || y < base) return tile;
    const n = FACES[f].n;
    const fx = x + n[0], fz = z + n[2];
    const { sx: SX, sz: SZ } = this.dimensions;
    if (fx >= 0 && fz >= 0 && fx < SX && fz < SZ && y > 0) {
      const below = this.getBlock(fx, y - 1, fz);
      // Kick band only where the face meets real floor: a hole blasted into
      // a neighbouring wall column is not floor.
      if (below !== AIR && !isSeeThrough(below) && this.getBlock(fx, y, fz) === AIR) {
        const neighbourBase = this.wallBaseAt(fx, fz);
        if (neighbourBase < 0 || y - 1 < neighbourBase) return TILE.FACADE_BASE;
      }
    }
    if (skin !== TILE.FACADE_PANEL) return skin;
    // Plain masses (BEDROCK walls) get steel pilasters at a fixed rhythm along
    // the wall; authored walls already carry their own METAL pilasters.
    const every = this.surface.pilasterEvery;
    if (every && tile !== TILE.CONCRETE && tile !== TILE.STONE) {
      const along = n[0] !== 0 ? z : x;
      if (along % every === 0) return TILE.FACADE_PILLAR;
    }
    return y % FACADE_JOINT_EVERY === 0 ? TILE.FACADE_JOINT : skin;
  }

  markDirty(cx, cz) {
    if (cx < 0 || cz < 0 || cx >= this.width || cz >= this.depth) return;
    const key = this.chunkKey(cx, cz);
    if (!this.chunks.has(key) || this.queued.has(key)) return;
    this.queued.add(key);
    this.dirtyQueue.push(key);
  }

  /** Drain the rebuild queue up to MAX_REBUILDS_PER_FRAME entries per frame. */
  update(maxRebuilds = MAX_REBUILDS_PER_FRAME) {
    let n = 0;
    while (this.dirtyQueue.length > 0 && n < maxRebuilds) {
      const key = this.dirtyQueue.shift();
      this.queued.delete(key);
      const c = this.chunks.get(key);
      if (c !== undefined) this.rebuildChunk(c.cx, c.cz);
      n++;
    }
    return n;
  }

  get stats() {
    return {
      chunks: this.chunks.size,
      queued: this.dirtyQueue.length,
      meshes: this.group.children.length,
    };
  }

  dispose() {
    for (const rec of this.chunks.values()) this.disposeRecord(rec);
    this.chunks.clear();
    this.dirtyQueue.length = 0;
    this.queued.clear();
    this.scene.remove(this.group);
    for (const m of Object.values(this.materials)) m.dispose();
  }

  disposeRecord(rec) {
    for (const mesh of rec.meshes) {
      this.group.remove(mesh);
      mesh.geometry.dispose();
    }
    rec.meshes.length = 0;
  }

  rebuildChunk(cx, cz) {
    const { sy: SY } = this.dimensions;
    if (cx < 0 || cz < 0 || cx >= this.width || cz >= this.depth) return;
    const key = this.chunkKey(cx, cz);
    let rec = this.chunks.get(key);
    if (rec === undefined) {
      rec = { cx, cz, meshes: [] };
      this.chunks.set(key, rec);
    } else {
      this.disposeRecord(rec);          // dispose-safe: old geometry freed first
    }

    const buckets = newBuckets();
    const x0 = cx << 4, z0 = cz << 4;
    // Beyond the world edge there is nothing to occlude or hide behind: the
    // store's out-of-range wall must not darken shoreline AO or cull the
    // outer faces an outside camera (spectator, captures) can see.
    const { sx: SX, sz: SZ } = this.dimensions;
    const inner = this.getBlock;
    const gb = (x, y, z) => (x < 0 || z < 0 || x >= SX || z >= SZ ? AIR : inner(x, y, z));
    const rectOf = this.atlas.tileRect;
    const resolveTile = this.FACE_MAP.resolveTile;
    // A one-voxel halo includes neighbour visibility and corner AO samples.
    // Cache intact results too: each block's live damage is read once per build.
    const strideX = CHUNK_X + 2, strideZ = CHUNK_Z + 2;
    const stages = new Int8Array(strideX * strideZ * (SY + 2)).fill(-1);
    const shapeAt = (x, y, z) => {
      const index = x - x0 + 1 + strideX * (z - z0 + 1 + strideZ * (y + 1));
      let stage = stages[index];
      if (stage === -1) {
        stage = damageStage(this.getBlockDamage(x, y, z));
        stages[index] = stage;
      }
      return stage > 0 ? damageCells(x, y, z, stage) : null;
    };

    for (let ly = 0; ly < SY; ly++) {
      for (let lz = 0; lz < CHUNK_Z; lz++) {
        const wz = z0 + lz;
        for (let lx = 0; lx < CHUNK_X; lx++) {
          const wx = x0 + lx;
          const id = gb(wx, ly, wz);
          if (id === AIR) continue;
          const bucket = FLUID_BUCKETS[id] ? buckets[FLUID_BUCKETS[id]]
            : TRANSLUCENT.has(id) ? buckets.glass
              : CUTOUT.has(id) ? buckets.cutout : buckets.opaque;
          const shape = shapeAt(wx, ly, wz);
          if (shape) {
            emitDamagedBlock(bucket, wx, ly, wz, id, shape, rectOf, resolveTile, gb, shapeAt);
            continue;
          }
          for (let f = 0; f < 6; f++) {
            const fd = FACES[f];
            // Visible unless fully hidden: air, or see-through neighbour of another kind.
            const nx = wx + fd.n[0], ny = ly + fd.n[1], nz = wz + fd.n[2];
            const nb = gb(nx, ny, nz);
            if (nb === AIR || (isSeeThrough(nb) && nb !== id)) {
              emitFace(bucket, wx, ly, wz, f, id, rectOf, resolveTile, gb);
            } else if (shapeAt(nx, ny, nz)) {
              // A chipped neighbour exposes parts of this otherwise hidden
              // intact face. Cover those holes, including across chunk seams.
              emitUncoveredFace(bucket, wx, ly, wz, f, id, rectOf, resolveTile, gb, shapeAt);
            }
          }
        }
      }
    }

    for (const name of Object.keys(buckets)) {
      const b = buckets[name];
      if (b.index.length === 0) continue;
      const mesh = buildMesh(b, this.materials[name]);
      mesh.name = name;
      // Terrain only receives the dynamic-caster shadow map; the voxel light volume carries its own shade.
      mesh.receiveShadow = true;
      if (name === 'glass') mesh.renderOrder = 2;
      if (name === 'water') mesh.renderOrder = 3;
      rec.meshes.push(mesh);
      this.group.add(mesh);
    }
  }
}

function newBuckets() {
  const mk = (flags = {}) => ({ pos: [], nrm: [], col: [], uv: [], layer: [], aux: [], index: [], verts: 0, ...flags });
  return {
    opaque: mk(), cutout: mk({ cutout: true }), glass: mk({ glass: true }),
    water: mk({ atlasUv: true }), lava: mk({ atlasUv: true }),
  };
}

function cellOccludes(gb, shapeAt, x, y, z, faceBlockId) {
  const wx = Math.floor(x / DAMAGE_GRID), wy = Math.floor(y / DAMAGE_GRID);
  const wz = Math.floor(z / DAMAGE_GRID);
  const id = gb(wx, wy, wz);
  if (id === AIR || (faceBlockId !== undefined && isSeeThrough(id) && id !== faceBlockId)) return 0;
  const shape = shapeAt(wx, wy, wz);
  if (!shape) return 1;
  return shape[(x - wx * DAMAGE_GRID) + DAMAGE_GRID
    * ((y - wy * DAMAGE_GRID) + DAMAGE_GRID * (z - wz * DAMAGE_GRID))];
}

function emitDamagedBlock(bucket, wx, wy, wz, id, shape, rectOf, resolveTile, gb, shapeAt) {
  for (let z = 0; z < DAMAGE_GRID; z++) {
    for (let y = 0; y < DAMAGE_GRID; y++) {
      for (let x = 0; x < DAMAGE_GRID; x++) {
        if (!shape[x + DAMAGE_GRID * (y + DAMAGE_GRID * z)]) continue;
        for (let f = 0; f < FACES.length; f++) {
          const n = FACES[f].n;
          if (cellOccludes(gb, shapeAt, wx * DAMAGE_GRID + x + n[0],
            wy * DAMAGE_GRID + y + n[1], wz * DAMAGE_GRID + z + n[2], id)) continue;
          emitCellFace(bucket, wx, wy, wz, x, y, z, f, id, rectOf, resolveTile, gb, shapeAt);
        }
      }
    }
  }
}

function emitUncoveredFace(bucket, wx, wy, wz, f, id, rectOf, resolveTile, gb, shapeAt) {
  const fd = FACES[f];
  for (let v = 0; v < DAMAGE_GRID; v++) {
    for (let u = 0; u < DAMAGE_GRID; u++) {
      // The tangent frame runs backwards on some faces. Choose the occupied
      // quarter-cell on the inside of the face at each tangent coordinate.
      const cell = fd.o.map((o, axis) => Math.min(DAMAGE_GRID - 1,
        o * DAMAGE_GRID + fd.u[axis] * u + fd.v[axis] * v
          + Math.min(0, fd.u[axis]) + Math.min(0, fd.v[axis])));
      if (cellOccludes(gb, shapeAt, wx * DAMAGE_GRID + cell[0] + fd.n[0],
        wy * DAMAGE_GRID + cell[1] + fd.n[1], wz * DAMAGE_GRID + cell[2] + fd.n[2], id)) continue;
      emitCellFace(bucket, wx, wy, wz, ...cell, f, id, rectOf, resolveTile, gb, shapeAt);
    }
  }
}

/** Quarter-block quad, with the original full-block texture scale and cut AO. */
function emitCellFace(bucket, wx, wy, wz, x, y, z, f, id, tileRectFn, resolveTile, gb, shapeAt) {
  const fd = FACES[f];
  const local = [x, y, z];
  const normalAxis = fd.n.findIndex((value) => value !== 0);
  const plane = local[normalAxis] + Number(fd.n[normalAxis] > 0);
  const isCut = plane > 0 && plane < DAMAGE_GRID;
  const textureId = isCut && id === GRASS ? DIRT : id;
  const tile = resolveTile(textureId, f, wx, wy, wz);
  const rect = tileRectFn(tile);
  const transform = faceUvTransform(wx, wy, wz, f, tile);
  const base = bucket.verts;
  const grassTop = GRASS_TOPS.has(id) && f === 2 && !isCut;
  const emissive = EMISSIVE.has(id);
  const shade = emissive ? 1 : FACE_SHADE[f] * (isCut ? 0.82 : 1)
    * (1 + (grassTop ? (posJitter(wx, wy, wz) - 50) * 0.0006 : 0));
  const outer = [wx * DAMAGE_GRID + x + fd.n[0], wy * DAMAGE_GRID + y + fd.n[1],
    wz * DAMAGE_GRID + z + fd.n[2]];
  const ao = [];
  const sample = (u, v) => cellOccludes(gb, shapeAt,
    outer[0] + fd.u[0] * u + fd.v[0] * v,
    outer[1] + fd.u[1] * u + fd.v[1] * v,
    outer[2] + fd.u[2] * u + fd.v[2] * v);

  for (let c = 0; c < CORNER_UV.length; c++) {
    const [cu, cv] = CORNER_UV[c];
    const su = cu ? 1 : -1, sv = cv ? 1 : -1;
    const level = emissive ? 1 : aoLevel(sample(su, 0), sample(0, sv), sample(su, sv));
    ao.push(level);
    const p = local.map((value, axis) =>
      (value + fd.o[axis] + cu * fd.u[axis] + cv * fd.v[axis]) / DAMAGE_GRID);
    const px = wx + p[0], py = wy + p[1], pz = wz + p[2];
    bucket.pos.push(px, py, pz);
    bucket.nrm.push(...fd.n);
    const k = shade * level * (emissive ? 1 : 1 + macroTone(px, py, pz) * MACRO_AMPLITUDE);
    bucket.col.push(k * (grassTop ? 1.02 : 1), k, k * (grassTop ? 0.94 : 1));
    const u = p.reduce((sum, value, axis) => sum + (value - fd.o[axis]) * fd.u[axis], 0);
    const v = p.reduce((sum, value, axis) => sum + (value - fd.o[axis]) * fd.v[axis], 0);
    if (bucket.atlasUv) {
      bucket.uv.push(rect.u0 + (rect.u1 - rect.u0) * u, rect.v1 + (rect.v0 - rect.v1) * v);
    } else {
      transformUv(u, 1 - v, transform, UV_SCRATCH);
      bucket.uv.push(UV_SCRATCH[0], UV_SCRATCH[1]);
    }
    bucket.layer.push(tile);
    bucket.aux.push(0, emissive ? 255 : 0, 0, 0);
  }
  if (ao[0] + ao[2] > ao[1] + ao[3]) {
    bucket.index.push(base + 1, base + 2, base + 3, base + 1, base + 3, base);
  } else {
    bucket.index.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  bucket.verts += 4;
}

const UV_SCRATCH = [0, 0];
const CORNER_T = [[0, 0], [0, 0], [0, 0], [0, 0]];
/** Face-frame edges (-u, +u, -v, +v) as their two corner indices. */
const FACE_EDGES = [[0, 3], [1, 2], [0, 1], [3, 2]];

/**
 * Emit one visible quad into a bucket with per-vertex baked colour:
 * AO level x directional shade x macro tone x grime (+ grass-top warm tint and
 * hash jitter). Local UVs run u along the face, t down the tile image, then
 * through the block's hashed rotation/mirror; aux carries the convex-edge
 * mask and the emissive flag for the terrain shader.
 */
function emitFace(bucket, wx, wy, wz, f, id, tileRectFn, resolveTile, gb) {
  const fd = FACES[f];
  const tile = resolveTile(id, f, wx, wy, wz);
  const rect = tileRectFn(tile);
  const base = bucket.verts;

  // Corner AO samples sit on the slab this face opens onto.
  const sx = wx + fd.n[0], sy = wy + fd.n[1], sz = wz + fd.n[2];
  const ux = fd.u[0], uy = fd.u[1], uz = fd.u[2];
  const vx = fd.v[0], vy = fd.v[1], vz = fd.v[2];

  const emissive = EMISSIVE.has(id);
  const shade = emissive ? 1 : FACE_SHADE[f];
  const grassTopFace = GRASS_TOPS.has(id) && f === 2;
  const warmR = grassTopFace ? 1.02 : 1;
  const warmG = grassTopFace ? 1.0 : 1;
  const warmB = grassTopFace ? 0.94 : 1;
  const jitBase = grassTopFace ? (posJitter(wx, wy, wz) - 50) * 0.0006 : 0; // ±3%
  const solidBucket = !bucket.atlasUv && !bucket.cutout && !bucket.glass;
  // Walls darken towards the floor they stand on and under a ceiling.
  const side = f !== 2 && f !== 3 && solidBucket && !emissive;
  const grimeBottom = side && occ(gb, sx, sy - 1, sz) ? GRIME_FLOOR : 1;
  const grimeTop = side && occ(gb, sx, sy + 1, sz) ? GRIME_CEILING : 1;
  const transform = faceUvTransform(wx, wy, wz, f, tile);

  const ao = [0, 0, 0, 0];
  for (let c = 0; c < 4; c++) {
    const cu = CORNER_UV[c][0], cv = CORNER_UV[c][1];
    const su = cu === 1 ? 1 : -1;
    const sv = cv === 1 ? 1 : -1;
    let lvl = 1;
    if (!emissive) {
      const s1 = occ(gb, sx + su * ux, sy + su * uy, sz + su * uz);
      const s2 = occ(gb, sx + sv * vx, sy + sv * vy, sz + sv * vz);
      const co = occ(gb, sx + su * ux + sv * vx, sy + su * uy + sv * vy, sz + su * uz + sv * vz);
      lvl = aoLevel(s1, s2, co);
    }
    ao[c] = lvl;

    const px = wx + fd.o[0] + cu * ux + cv * vx;
    const py = wy + fd.o[1] + cu * uy + cv * vy;
    const pz = wz + fd.o[2] + cu * uz + cv * vz;
    bucket.pos.push(px, py, pz);
    bucket.nrm.push(fd.n[0], fd.n[1], fd.n[2]);

    let k = lvl * shade * (1 + jitBase);   // per-position variance, uniform per quad
    if (!emissive) k *= (1 + macroTone(px, py, pz) * MACRO_AMPLITUDE) * (cv ? grimeTop : grimeBottom);
    bucket.col.push(k * warmR, k * warmG, k * warmB);

    if (bucket.atlasUv) {
      bucket.uv.push(cu === 0 ? rect.u0 : rect.u1, cv === 0 ? rect.v1 : rect.v0);
    } else {
      transformUv(cu, 1 - cv, transform, CORNER_T[c]);
      bucket.uv.push(CORNER_T[c][0], CORNER_T[c][1]);
    }
  }

  let edgeMask = 0;
  if (solidBucket) {
    // A face edge is convex when the block beside it along that edge is open.
    for (let e = 0; e < 4; e++) {
      const du = e === 0 ? -1 : e === 1 ? 1 : 0;
      const dv = e === 2 ? -1 : e === 3 ? 1 : 0;
      if (occ(gb, wx + du * ux + dv * vx, wy + du * uy + dv * vy, wz + du * uz + dv * vz)) continue;
      const [a, b] = FACE_EDGES[e];
      const A = CORNER_T[a], B = CORNER_T[b];
      edgeMask |= A[0] === B[0] ? (A[0] < 0.5 ? 1 : 2) : (A[1] < 0.5 ? 4 : 8);
    }
  }
  for (let c = 0; c < 4; c++) {
    bucket.layer.push(tile);
    bucket.aux.push(edgeMask, emissive ? 255 : 0, 0, 0);
  }

  // Standard anisotropy fix: flip the split diagonal so AO gradients interpolate cleanly.
  if (ao[0] + ao[2] > ao[1] + ao[3]) {
    bucket.index.push(base + 1, base + 2, base + 3, base + 1, base + 3, base);
  } else {
    bucket.index.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  bucket.verts += 4;
}

function occ(gb, x, y, z) {
  return NO_OCCLUDE.has(gb(x, y, z)) ? 0 : 1;
}

function buildMesh(b, material) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(b.nrm, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(b.col, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
  if (!b.atlasUv) {
    g.setAttribute('terrainLayer', new THREE.Float32BufferAttribute(b.layer, 1));
    g.setAttribute('terrainAux', new THREE.Uint8BufferAttribute(b.aux, 4, true));
  }
  g.setIndex(new THREE.Uint32BufferAttribute(b.index, 1));
  g.computeBoundingSphere();   // meshes sit at origin using absolute world coords
  const mesh = new THREE.Mesh(g, material);
  mesh.matrixAutoUpdate = false;
  return mesh;
}
