// WorldView: composition root for the client's visual world. Owns the THREE.Scene,
// lighting rig, texture atlas, chunk mesher, sky and voxel picking. Fed a live
// store reference ({ getBlock }) whose closure always reflects the latest netcode
// state, so every mesh rebuild and raycast reads current blocks.

import * as THREE from '../vendor/three.module.js';
import { buildAtlas } from './atlas.js';
import { ChunkStore } from './chunks.js';
import { installSky, SUN_DIR } from './sky.js';
import { raycastVoxels } from '../../../shared/raycast.js';

export { SUN_DIR };

const FOG_COLOR = '#9fbcd8';
const FOG_DENSITY = 0.0055;
/** Sun placement in world units; direction normalises to sky.SUN_DIR. */
const SUN_POS = new THREE.Vector3(60, 90, 20);

const _rayO = new THREE.Vector3();
const _rayD = new THREE.Vector3();

const LADDER_RUNG_SPACING = 0.62;
const LADDER_RUNG_BOTTOM_INSET = 0.3;
const LADDER_RUNG_TOP_INSET = 0.1;

function ladderRungCount(ladder) {
  const usable = ladder.maxY - ladder.minY
    - LADDER_RUNG_BOTTOM_INSET - LADDER_RUNG_TOP_INSET;
  return usable < 0 ? 0 : Math.floor(usable / LADDER_RUNG_SPACING) + 1;
}

function buildLadderVisuals(mapMeta) {
  const ladders = Array.isArray(mapMeta?.ladders) ? mapMeta.ladders : [];
  if (ladders.length === 0) return null;

  let instanceCount = ladders.length * 2;
  for (const ladder of ladders) instanceCount += ladderRungCount(ladder);

  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const material = new THREE.MeshStandardMaterial({
    color: 0xffd21f,
    emissive: 0x6b2d00,
    emissiveIntensity: 0.9,
    metalness: 0.35,
    roughness: 0.42,
  });
  const mesh = new THREE.InstancedMesh(geometry, material, instanceCount);
  mesh.name = 'foundry-ladders';
  const matrix = new THREE.Matrix4();
  let instance = 0;

  const setBox = (x, y, z, sx, sy, sz) => {
    matrix.makeScale(sx, sy, sz);
    matrix.setPosition(x, y, z);
    mesh.setMatrixAt(instance++, matrix);
  };

  for (const ladder of ladders) {
    const z = ladder.minZ + 0.055;
    const railLeft = ladder.minX + 0.15;
    const railRight = ladder.maxX - 0.15;
    const railHeight = ladder.maxY - ladder.minY;
    const railY = ladder.minY + railHeight * 0.5;
    setBox(railLeft, railY, z, 0.075, railHeight, 0.075);
    setBox(railRight, railY, z, 0.075, railHeight, 0.075);

    const rungCount = ladderRungCount(ladder);
    const rungWidth = railRight - railLeft + 0.075;
    for (let i = 0; i < rungCount; i++) {
      const y = ladder.minY + LADDER_RUNG_BOTTOM_INSET + i * LADDER_RUNG_SPACING;
      setBox((railLeft + railRight) * 0.5, y, z + 0.008, rungWidth, 0.065, 0.085);
    }
  }

  mesh.instanceMatrix.needsUpdate = true;
  if (typeof mesh.computeBoundingSphere === 'function') mesh.computeBoundingSphere();
  const group = new THREE.Group();
  group.name = 'ladder-group';
  group.add(mesh);
  return { group, mesh, geometry, material };
}

export class WorldView {
  /**
   * @param {{getBlock(x:number,y:number,z:number):number,meta?:object}} storeRef
   * @param {object|null} mapMeta
   */
  constructor(storeRef, mapMeta = null) {
    if (!storeRef || typeof storeRef.getBlock !== 'function') {
      throw new TypeError('WorldView requires { getBlock }');
    }
    this.store = storeRef;

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(FOG_COLOR, FOG_DENSITY);

    const hemi = new THREE.HemisphereLight(0xbcd8ff, 0x5a4a38, 0.55);
    hemi.name = 'hemi';
    this.scene.add(hemi);

    const sun = new THREE.DirectionalLight(0xfff2dd, 1.35);
    sun.name = 'sun';
    sun.position.copy(SUN_POS);
    sun.castShadow = false;              // perf: AO + face shading carry the look
    this.scene.add(sun);
    this.sun = sun;

    this.atlas = buildAtlas();
    this.chunkStore = new ChunkStore(this.scene, this.atlas, storeRef.getBlock);

    this.camera = null;                  // optional: setCamera() enables rayHitCamera()
    this.skyUpdate = installSky(this.scene);

    this.ladderVisuals = buildLadderVisuals(mapMeta || storeRef.meta || null);
    if (this.ladderVisuals) this.scene.add(this.ladderVisuals.group);
  }

  /** Builds every initial chunk column; resolves when the world is renderable. */
  async ready() {
    this.chunkStore.buildAll();
    await Promise.resolve();             // let the first paint schedule before use
    return this;
  }

  /**
   * Batched block updates from the snapshot loop / 'block' events.
   * Each entry is {x,y,z,v}; dirty chunks remesh within the per-frame budget.
   */
  applyDeltas(deltas) {
    for (let i = 0; i < deltas.length; i++) {
      const d = deltas[i];
      this.chunkStore.applyBlockDelta(d.x, d.y, d.z, d.v);
    }
  }

  /** Single-block convenience wrapper around applyDeltas(). */
  applyDelta(x, y, z, v) {
    this.chunkStore.applyBlockDelta(x, y, z, v);
  }

  /**
   * Straight-through shared DDA cast against the CURRENT store.
   * @returns {{x,y,z,nx,ny,nz,t}|null} shared/raycast hit shape.
   */
  pickCameraRay(origin, dir, maxDist) {
    return raycastVoxels(
      this.store.getBlock,
      origin.x, origin.y, origin.z,
      dir.x, dir.y, dir.z,
      maxDist,
    );
  }

  setCamera(camera) {
    this.camera = camera;
  }

  /** Camera-centred convenience ray; requires a prior setCamera(). */
  rayHitCamera(maxDist = 64) {
    if (!this.camera) return null;
    _rayO.setFromMatrixPosition(this.camera.matrixWorld);
    _rayD.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    return this.pickCameraRay(_rayO, _rayD, maxDist);
  }

  /** Per-frame tick: drains the chunk remesh budget and drifts the clouds. */
  update(dt) {
    this.chunkStore.update();
    this.skyUpdate(dt);
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.chunkStore.dispose();
    if (this.ladderVisuals) {
      this.scene.remove(this.ladderVisuals.group);
      this.ladderVisuals.mesh.dispose();
      this.ladderVisuals.geometry.dispose();
      this.ladderVisuals.material.dispose();
      this.ladderVisuals.group.clear();
      this.ladderVisuals = null;
    }
    this.skyUpdate.dispose();
    this.atlas.dispose();
  }
}
