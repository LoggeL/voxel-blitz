// Blob contact shadows: one instanced, depth-tested quad per grounded body
// (avatars, vehicles, the local player, pickups). The ground under each blob is
// found by scanning the voxel column below it; the blob fades with height
// (quadratically over `reach`, so a full-strength avatar blob is gone by about
// 2.5 m) and hides over fluids or when nothing solid lies within reach. One draw call on
// every tier; the program is fixed at construction (instanced colour on, fog
// on) and per-frame work only rewrites instance matrices and colours.

import * as THREE from '../vendor/three.module.js';
import { AIR, FLUID_BLOCKS, MC_PORTAL } from '../../../shared/worlddata.js';
import { prepareCharacterTree, setCharacterNearRoots, updateCharacterProbe } from './character-light.js';

export const CONTACT_SHADOW = Object.freeze({
  capacity: 64,
  reach: 3,            // column-scan depth and fade length; (1 - h/reach)^2 culls avatars near 2.5 m
  maxDistance: 72,     // blobs beyond this from the camera are skipped (fog eats them)
  lift: 0.018,         // metres above the ground face, on top of polygon offset
  renderOrder: 1,      // after opaque, below glass (2) and water (3)
});

/** Soft radial falloff in the green channel, which alphaMap reads. */
function blobTexture(size = 64) {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5) / size * 2 - 1, dy = (y + 0.5) / size * 2 - 1;
      const r = Math.min(1, Math.hypot(dx, dy));
      // Broad soft falloff: half strength at mid radius, zero at the rim, so
      // it reads as contact occlusion around the feet rather than a disc.
      const q = 1 - r * r;
      const a = Math.round(255 * q * q);
      const o = (y * size + x) * 4;
      data[o] = data[o + 1] = data[o + 2] = a;
      data[o + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.magFilter = texture.minFilter = THREE.LinearFilter;
  texture.name = 'contact-shadow-blob';
  texture.needsUpdate = true;
  return texture;
}

export class ContactShadows {
  /**
   * @param {(x:number,y:number,z:number)=>number} getBlock visual voxel getter
   * @param {{strength?:number}} options global strength (lower when a shadow map also draws bodies)
   */
  constructor(getBlock, { strength = 1 } = {}) {
    this.getBlock = getBlock;
    this.strength = strength;
    const capacity = CONTACT_SHADOW.capacity;
    this.texture = blobTexture();
    this.geometry = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    this.material = new THREE.MeshBasicMaterial({
      color: 0x000000,
      alphaMap: this.texture,
      transparent: true,
      depthWrite: false,
      fog: true,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -4,
    });
    // Instance colour carries the per-blob strength into alpha; fog fades the
    // blob out instead of tinting a black patch towards the fog colour.
    this.material.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <color_fragment>', `#if defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR )
  diffuseColor.a *= vColor.r;
#endif`)
        .replace('#include <fog_fragment>', `#include <fog_fragment>
#ifdef USE_FOG
  gl_FragColor = vec4( 0.0, 0.0, 0.0, gl_FragColor.a * ( 1.0 - fogFactor ) );
#endif`);
    };
    this.material.customProgramCacheKey = () => 'contact-shadow-v1';
    this.mesh = new THREE.InstancedMesh(this.geometry, this.material, capacity);
    this.mesh.name = 'contact-shadows';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = CONTACT_SHADOW.renderOrder;
    this.mesh.matrixAutoUpdate = false;
    this._matrix = new THREE.Matrix4();
    this._color = new THREE.Color(0, 0, 0);
    // Fix the instanced-colour define before the first compile.
    for (let i = 0; i < capacity; i++) this.mesh.setColorAt(i, this._color);
    this.mesh.count = 0;
    // Per-slot ground cache: cell of the last scan and the world generation.
    this._cacheX = new Int32Array(capacity).fill(-2147483648);
    this._cacheY = new Int32Array(capacity);
    this._cacheZ = new Int32Array(capacity);
    this._cacheGen = new Int32Array(capacity);
    this._cacheGround = new Float32Array(capacity);
    this.generation = 0;
    this.count = 0;
    this._ox = 0; this._oy = 0; this._oz = 0; this._hasOrigin = false;
  }

  /** Terrain changed: every cached column scan is stale. */
  invalidate() {
    this.generation = (this.generation + 1) | 0;
  }

  /** Start a frame. `origin` (camera position) enables distance culling. */
  begin(origin = null) {
    this.count = 0;
    this._hasOrigin = !!origin;
    if (origin) { this._ox = origin.x; this._oy = origin.y; this._oz = origin.z; }
  }

  /**
   * Top of the first solid block at or below (x,y,z) within `reach`, NaN when
   * nothing solid is in reach or the column meets a fluid first.
   */
  groundBelow(x, y, z, slot = -1) {
    const cx = Math.floor(x), cz = Math.floor(z), top = Math.floor(y + 0.1);
    if (slot >= 0 && this._cacheX[slot] === cx && this._cacheZ[slot] === cz
      && this._cacheY[slot] === top && this._cacheGen[slot] === this.generation) {
      return this._cacheGround[slot];
    }
    let ground = NaN;
    const bottom = Math.floor(y - CONTACT_SHADOW.reach);
    for (let cy = top; cy >= bottom && cy >= 0; cy--) {
      const id = this.getBlock(cx, cy, cz);
      if (id === AIR || id === MC_PORTAL || !id) continue;
      if (!FLUID_BLOCKS.has(id)) ground = cy + 1;
      break;
    }
    if (slot >= 0) {
      this._cacheX[slot] = cx; this._cacheY[slot] = top; this._cacheZ[slot] = cz;
      this._cacheGen[slot] = this.generation; this._cacheGround[slot] = ground;
    }
    return ground;
  }

  /** Queue one blob; returns false when it was culled or the pool is full. */
  add(x, y, z, radius = 0.45, strength = 0.5) {
    const slot = this.count;
    if (slot >= CONTACT_SHADOW.capacity || !(radius > 0) || !(strength > 0)) return false;
    if (!Number.isFinite(x + y + z)) return false;
    if (this._hasOrigin) {
      const dx = x - this._ox, dz = z - this._oz;
      if (dx * dx + dz * dz > CONTACT_SHADOW.maxDistance * CONTACT_SHADOW.maxDistance) return false;
    }
    const ground = this.groundBelow(x, y, z, slot);
    if (!Number.isFinite(ground)) return false;
    const height = y - ground;
    if (height < -0.35 || height > CONTACT_SHADOW.reach) return false;
    const lift = Math.max(0, height) / CONTACT_SHADOW.reach;
    const fade = (1 - lift) * (1 - lift);
    const alpha = Math.min(1, strength * this.strength * fade);
    if (alpha < 0.01) return false;
    // A body higher up casts a wider, fainter blob.
    const size = radius * 2 * (1 + lift * 0.6);
    const e = this._matrix.elements;
    e[0] = size; e[1] = 0; e[2] = 0; e[3] = 0;
    e[4] = 0; e[5] = 1; e[6] = 0; e[7] = 0;
    e[8] = 0; e[9] = 0; e[10] = size; e[11] = 0;
    e[12] = x; e[13] = ground + CONTACT_SHADOW.lift; e[14] = z; e[15] = 1;
    this.mesh.setMatrixAt(slot, this._matrix);
    this._color.setRGB(alpha, alpha, alpha);
    this.mesh.setColorAt(slot, this._color);
    this.count = slot + 1;
    return true;
  }

  /** Array form: [{x,y,z,radius,strength}], allocation-free for reused rows. */
  setBlobs(list, origin = null) {
    this.begin(origin);
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      this.add(b.x, b.y, b.z, b.radius, b.strength);
    }
    this.end();
  }

  end() {
    // The mesh stays visible at zero instances so its program compiles with
    // the first frame of the map, not with the first blob mid-match.
    this.mesh.count = this.count;
    if (this.count > 0) {
      this.mesh.instanceMatrix.needsUpdate = true;
      if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    }
  }

  dispose() {
    this.mesh.removeFromParent();
    this.mesh.dispose();
    this.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
  }
}

const cameraPosition = new THREE.Vector3();

/** Blobs under world pickups owned by a WorldView (powerups, TTT drops and supplies). */
function addPickupBlobs(shadows, view, radius, strength) {
  if (!view?.items || view.group?.visible === false) return;
  for (const item of view.items.values()) {
    const root = item.root;
    if (!root || root.visible === false) continue;
    shadows.add(root.position.x, root.position.y, root.position.z, radius, strength);
  }
}

/**
 * Per-frame character presentation for one WorldView, called just before the
 * render: character materials under the registered roots are patched, the
 * camera light probe is fed and the contact blobs are rebuilt.
 *
 * frame: { camera, dt, roster, bodyPosition }
 */
export function presentCharacterFrame(worldview, frame) {
  const roots = worldview.characterRoots;
  for (let i = 0; i < roots.length; i++) prepareCharacterTree(roots[i]);
  setCharacterNearRoots(worldview.nearCharacterRoots);
  const camera = frame.camera;
  if (camera) camera.getWorldPosition(cameraPosition);
  updateCharacterProbe(worldview.lightVolume, camera ? cameraPosition : null, frame.dt || 0);
  const shadows = worldview.contactShadows;
  if (!shadows) return;
  shadows.begin(camera ? cameraPosition : null);
  const body = frame.bodyPosition;
  if (body) shadows.add(body.x, body.y, body.z, 0.55, 0.45);
  frame.roster?.addContactShadows?.(shadows);
  addPickupBlobs(shadows, worldview.powerups, 0.36, 0.38);
  addPickupBlobs(shadows, worldview.tttWeapons, 0.34, 0.34);
  addPickupBlobs(shadows, worldview.tttSupplies, 0.32, 0.34);
  shadows.end();
}
