// Grass tufts: short crossed blades on exposed grass tops. Purely visual and
// deliberately tiny (<= 0.22 m), so a tuft can never read as cover or hide a
// player's feet. Placement is a pure hash of the block position, identical on
// every client and every rebuild. The world is split into 64 x 64 regions with
// one merged mesh each (a 192 x 144 map needs at most 9 draws). Every grass
// cell owns a fixed vertex slot in its region, so a block delta that hides or
// reveals a tuft rewrites that slot in place; only newly placed grass relays
// out a region, at most one region per frame.

import * as THREE from '../vendor/three.module.js';
import { AIR, GRASS, MC_GRASS } from '../../../shared/worlddata.js';
import { patchVoxelLitMaterial, createVoxelLightUniforms } from './voxel-light.js';
import { displaySettings } from '../ui/display-settings.js';

export const TUFT_REGION = 64;
export const TUFT_MAX_HEIGHT = 0.22;
/** Blades per tuft; each blade is one triangle emitted with both windings. */
const BLADES = 5;
/** Average tufts per exposed grass top at density 1. */
const TUFTS_PER_BLOCK = 1.5;
/** Tip sway in metres at full motion. */
const SWAY_AMPLITUDE = 0.035;

const GRASS_BLOCKS = new Set([GRASS, MC_GRASS]);

// Linear base tones taken from each grass top tile's average colour: the
// blade roots melt into the tile, the tips catch a little more light.
const TONES = new Map([
  [GRASS, new THREE.Color().setRGB(78 / 255, 140 / 255, 47 / 255, THREE.SRGBColorSpace)],
  [MC_GRASS, new THREE.Color().setRGB(104 / 255, 158 / 255, 66 / 255, THREE.SRGBColorSpace)],
]);
const ROOT_SHADE = 0.55;
/** Sunlit, slightly yellowed tips (r, g, b gain over the base tone). */
const TIP_GAIN = [1.5, 1.34, 1.05];

function hash(x, y, z, salt) {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 2147483647) ^ Math.imul(salt, 144665);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const TUFT_VERTEX_PARS = /* glsl */ `
attribute float tuftSway;
uniform float tuftTime;
uniform float tuftAmplitude;
`;

// Normals point straight up so blades shade exactly like the grass top they
// grow from; the tip sways by world position, the root stays planted.
const TUFT_BEGIN_NORMAL = /* glsl */ `
vec3 objectNormal = vec3( 0.0, 1.0, 0.0 );
`;

const TUFT_BEGIN_VERTEX = /* glsl */ `
#include <begin_vertex>
{
  float tuftPhase = dot( position.xz, vec2( 0.61, 0.37 ) ) + tuftTime * 1.9;
  float gust = 0.65 + 0.35 * sin( tuftTime * 0.43 + position.x * 0.05 );
  transformed.xz += tuftSway * tuftAmplitude * gust
    * vec2( sin( tuftPhase ) + 0.6, 0.55 * cos( tuftPhase * 0.83 ) );
}
`;

/** Lambert, vertex coloured, voxel lit, with the sway patch. One program per map. */
export function createTuftMaterial(lightUniforms = createVoxelLightUniforms()) {
  const material = new THREE.MeshLambertMaterial({ vertexColors: true });
  material.name = 'grass-tufts';
  const uniforms = {
    tuftTime: { value: 0 },
    tuftAmplitude: { value: SWAY_AMPLITUDE },
  };
  material.userData.tuftUniforms = uniforms;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${TUFT_VERTEX_PARS}`)
      .replace('#include <beginnormal_vertex>', TUFT_BEGIN_NORMAL)
      .replace('#include <begin_vertex>', TUFT_BEGIN_VERTEX);
  };
  material.customProgramCacheKey = () => 'grass-tufts';
  return patchVoxelLitMaterial(material, lightUniforms, 'voxel-lit');
}

const VERTS_PER_TUFT = BLADES * 3;

/** Tufts a grass top carries at this density (pure hash, fixed per cell). */
function tuftCount(x, y, z, perBlock) {
  const whole = Math.floor(perBlock);
  return whole + (hash(x, y, z, 5) < perBlock - whole ? 1 : 0);
}

/**
 * Write one tuft's blades for the grass top at block (x, y, z) into the
 * region arrays at vertex offset `v`. Colour and sway always, positions only
 * when `pos` is given.
 */
function writeTuft(pos, col, sway, v, x, y, z, k, tone) {
  const cx = x + 0.14 + hash(x, y, z, 11 + k) * 0.72;
  const cz = z + 0.14 + hash(x, y, z, 23 + k) * 0.72;
  const top = y + 1.002;
  const height = TUFT_MAX_HEIGHT * (0.55 + 0.45 * hash(x, y, z, 37 + k));
  const hue = 0.9 + hash(x, y, z, 41 + k) * 0.2;
  const spin = hash(x, y, z, 53 + k) * Math.PI * 2;
  const r = tone.r * hue, g = tone.g, bl = tone.b * hue;
  for (let b = 0; b < BLADES; b++, v += 3) {
    if (pos) {
      const angle = spin + (b / BLADES) * Math.PI * 2 + (hash(x, y + b, z, 61 + k) - 0.5) * 0.9;
      const dx = Math.cos(angle), dz = Math.sin(angle);
      const bladeHeight = height * (0.62 + 0.38 * hash(x, y + b, z, 67 + k));
      const width = 0.032 + 0.02 * hash(x, y + b, z, 71 + k);
      const lean = bladeHeight * (0.25 + 0.3 * hash(x, y + b, z, 73 + k));
      const bx = cx + dx * 0.04, bz = cz + dz * 0.04;
      // Root pair across the blade, tip leaning outwards.
      const o = v * 3;
      pos[o] = bx - dz * width; pos[o + 1] = top; pos[o + 2] = bz + dx * width;
      pos[o + 3] = bx + dz * width; pos[o + 4] = top; pos[o + 5] = bz - dx * width;
      pos[o + 6] = bx + dx * lean; pos[o + 7] = top + bladeHeight; pos[o + 8] = bz + dz * lean;
    }
    if (col) {
      const o = v * 3;
      col[o] = col[o + 3] = r * ROOT_SHADE;
      col[o + 1] = col[o + 4] = g * ROOT_SHADE;
      col[o + 2] = col[o + 5] = bl * ROOT_SHADE;
      col[o + 6] = r * TIP_GAIN[0]; col[o + 7] = g * TIP_GAIN[1]; col[o + 8] = bl * TIP_GAIN[2];
      sway[v] = 0; sway[v + 1] = 0; sway[v + 2] = 1;
    }
  }
}

export class GrassTufts {
  /**
   * @param {THREE.Scene|THREE.Object3D} parent
   * @param {Function} getBlock live visual block getter
   * @param {Function} getBlockDamage live visual damage getter (0..1)
   * @param {{sx:number,sy:number,sz:number}} dimensions
   * @param {{density?:number, lightUniforms?:object, receiveShadow?:boolean}} options
   *   density is the graphics tier's grassDensity (0 disables tufts entirely).
   */
  constructor(parent, getBlock, getBlockDamage, dimensions, {
    density = 0, lightUniforms, receiveShadow = false,
  } = {}) {
    this.parent = parent;
    this.getBlock = getBlock;
    this.getBlockDamage = getBlockDamage || (() => 0);
    this.dimensions = dimensions;
    this.density = Math.max(0, Math.min(1, Number(density) || 0));
    this.enabled = this.density > 0;
    this.perBlock = TUFTS_PER_BLOCK * this.density;
    this.receiveShadow = receiveShadow;
    this.width = Math.ceil(dimensions.sx / TUFT_REGION);
    this.depth = Math.ceil(dimensions.sz / TUFT_REGION);
    this.regions = [];
    this.dirty = [];
    this.time = 0;
    this.group = new THREE.Group();
    this.group.name = 'grass-tufts';
    this.material = this.enabled ? createTuftMaterial(lightUniforms) : null;
    this.uniforms = this.material?.userData.tuftUniforms || null;
    parent.add(this.group);
  }

  cellIndex(x, y, z) {
    return (y * this.dimensions.sz + z) * this.dimensions.sx + x;
  }

  regionOf(x, z) {
    return this.regions[((z / TUFT_REGION) | 0) * this.width + ((x / TUFT_REGION) | 0)];
  }

  /** Grass top that may carry tufts right now: open air above, no damage. */
  exposed(x, y, z) {
    return GRASS_BLOCKS.has(this.getBlock(x, y, z))
      && y + 1 < this.dimensions.sy && this.getBlock(x, y + 1, z) === AIR
      && !(this.getBlockDamage(x, y, z) > 0);
  }

  /** Scan the world once for grass blocks, then lay out every region. */
  build() {
    if (!this.enabled) return this;
    const { sx: SX, sy: SY, sz: SZ } = this.dimensions;
    this.regions = [];
    for (let i = 0; i < this.width * this.depth; i++) {
      this.regions.push({ index: i, cells: new Set(), slots: new Map(), tufts: new Set(), mesh: null, queued: false });
    }
    for (let z = 0; z < SZ; z++) {
      for (let x = 0; x < SX; x++) {
        const region = this.regionOf(x, z);
        for (let y = 0; y < SY; y++) {
          if (GRASS_BLOCKS.has(this.getBlock(x, y, z))) region.cells.add(this.cellIndex(x, y, z));
        }
      }
    }
    for (const region of this.regions) this.rebuildRegion(region);
    return this;
  }

  /**
   * Feed one block delta. Every grass cell of a region owns a fixed vertex
   * slot, so a tuft appearing or vanishing (block placed on top, blasted off,
   * damaged) rewrites only its own ~15 vertices in place. Only brand-new grass
   * cells, which have no slot yet, queue a relayout of the region.
   */
  applyBlockDelta(x, y, z, v) {
    if (!this.enabled || this.regions.length === 0) return;
    const { sx: SX, sy: SY, sz: SZ } = this.dimensions;
    if (x < 0 || z < 0 || x >= SX || z >= SZ || y < 0 || y >= SY) return;
    const region = this.regionOf(x, z);
    if (GRASS_BLOCKS.has(v)) region.cells.add(this.cellIndex(x, y, z));
    for (let yy = y; yy >= y - 1 && yy >= 0; yy--) {
      const index = this.cellIndex(x, yy, z);
      if (!region.cells.has(index)) continue;
      const show = this.exposed(x, yy, z);
      if (region.tufts.has(index) !== show) this.setShown(region, index, x, yy, z, show);
    }
  }

  /** Show or collapse one cell's tufts inside its region mesh. */
  setShown(region, index, x, y, z, show) {
    const slot = region.slots.get(index);
    if (slot === undefined || !region.mesh) {
      // No slot: an empty-hash cell stays bare; a new grass cell needs a relayout.
      if (show && tuftCount(x, y, z, this.perBlock) > 0) this.queue(region);
      return;
    }
    const geometry = region.mesh.geometry;
    const position = geometry.attributes.position;
    const count = slot.count * VERTS_PER_TUFT;
    if (show) {
      const id = this.getBlock(x, y, z);
      const color = geometry.attributes.color;
      for (let k = 0; k < slot.count; k++) {
        writeTuft(position.array, color.array, geometry.attributes.tuftSway.array,
          slot.start + k * VERTS_PER_TUFT, x, y, z, k, TONES.get(id));
      }
      color.addUpdateRange(slot.start * 3, count * 3);
      color.needsUpdate = true;
      region.tufts.add(index);
    } else {
      // Zero-area triangles: every vertex of the slot collapses onto one point.
      position.array.fill(0, slot.start * 3, (slot.start + count) * 3);
      region.tufts.delete(index);
    }
    position.addUpdateRange(slot.start * 3, count * 3);
    position.needsUpdate = true;
    region.mesh.visible = region.tufts.size > 0;
  }

  queue(region) {
    if (region.queued) return;
    region.queued = true;
    this.dirty.push(region);
  }

  /**
   * Lay out a region: one vertex slot per grass cell that carries tufts,
   * covered or damaged cells written collapsed so they can appear in place.
   */
  rebuildRegion(region) {
    region.queued = false;
    if (region.mesh) {
      this.group.remove(region.mesh);
      region.mesh.geometry.dispose();
      region.mesh = null;
    }
    region.tufts.clear();
    region.slots.clear();
    const { sx: SX, sz: SZ } = this.dimensions;
    let verts = 0;
    for (const index of region.cells) {
      const x = index % SX;
      const z = ((index / SX) | 0) % SZ;
      const y = (index / (SX * SZ)) | 0;
      if (!GRASS_BLOCKS.has(this.getBlock(x, y, z))) { region.cells.delete(index); continue; }
      const count = tuftCount(x, y, z, this.perBlock);
      if (count === 0) continue;
      region.slots.set(index, { start: verts, count });
      verts += count * VERTS_PER_TUFT;
    }
    if (verts === 0) return;
    const pos = new Float32Array(verts * 3);
    const col = new Float32Array(verts * 3);
    const sway = new Float32Array(verts);
    const index = verts > 65535 ? new Uint32Array(verts * 2) : new Uint16Array(verts * 2);
    for (let v = 0, i = 0; v < verts; v += 3, i += 6) {
      index[i] = v; index[i + 1] = v + 1; index[i + 2] = v + 2;
      index[i + 3] = v; index[i + 4] = v + 2; index[i + 5] = v + 1;
    }
    for (const [cell, slot] of region.slots) {
      const x = cell % SX;
      const z = ((cell / SX) | 0) % SZ;
      const y = (cell / (SX * SZ)) | 0;
      const tone = TONES.get(this.getBlock(x, y, z));
      for (let k = 0; k < slot.count; k++) {
        writeTuft(pos, col, sway, slot.start + k * VERTS_PER_TUFT, x, y, z, k, tone);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geometry.setAttribute('tuftSway', new THREE.BufferAttribute(sway, 1));
    geometry.setIndex(new THREE.BufferAttribute(index, 1));
    // Bounds cover every slot (hidden ones included) so tufts that appear
    // later are never culled; sway moves tips a few centimetres on top.
    geometry.computeBoundingSphere();
    geometry.boundingSphere.radius += SWAY_AMPLITUDE * 2;
    for (const [cell, slot] of region.slots) {
      const x = cell % SX;
      const z = ((cell / SX) | 0) % SZ;
      const y = (cell / (SX * SZ)) | 0;
      if (this.exposed(x, y, z)) region.tufts.add(cell);
      else pos.fill(0, slot.start * 3, (slot.start + slot.count * VERTS_PER_TUFT) * 3);
    }
    const mesh = new THREE.Mesh(geometry, this.material);
    mesh.name = `grass-tufts-${region.index}`;
    mesh.matrixAutoUpdate = false;
    mesh.receiveShadow = this.receiveShadow;
    mesh.userData.noShadow = true;
    mesh.visible = region.tufts.size > 0;
    region.mesh = mesh;
    this.group.add(mesh);
  }

  /** Per frame: advance the sway clock and rebuild at most one dirty region. */
  update(dt) {
    if (!this.enabled) return;
    this.time += dt;
    this.uniforms.tuftTime.value = this.time;
    this.uniforms.tuftAmplitude.value = displaySettings().reducedMotion ? 0 : SWAY_AMPLITUDE;
    if (this.dirty.length > 0) this.rebuildRegion(this.dirty.shift());
  }

  /** Rebuild every queued region now (replay frames, captures). */
  flush() {
    while (this.dirty.length > 0) this.rebuildRegion(this.dirty.shift());
  }

  get stats() {
    let meshes = 0, tufts = 0;
    for (const region of this.regions) {
      if (region.mesh) meshes++;
      tufts += region.tufts.size;
    }
    return { meshes, cells: tufts, queued: this.dirty.length };
  }

  dispose() {
    for (const region of this.regions) {
      if (region.mesh) region.mesh.geometry.dispose();
      region.mesh = null;
    }
    this.regions = [];
    this.dirty.length = 0;
    this.parent.remove(this.group);
    this.material?.dispose();
  }
}
