import { getMapDimensions } from '../../../shared/world/dimensions.js';
import { BastionWorld } from './bastion-world.js';
// WorldView: composition root for the client's visual world. Owns the THREE.Scene,
// lighting rig, texture atlas, chunk mesher, sky and voxel picking. Fed a live
// store reference ({ getBlock }) whose closure always reflects the latest netcode
// state, so every mesh rebuild and raycast reads current blocks.

import * as THREE from '../vendor/three.module.js';
import { buildAtlas } from './atlas.js';
import { ChunkStore } from './chunks.js';
import { installSky } from './sky.js';
import { buildNuketownDetails } from './nuketown-details.js';
import { mapAtmosphere } from './map-atmosphere.js';
import { buildMapSigns } from './map-signs.js';
import { buildMapLights } from './map-lights.js';
import { SiteMarkers } from './site-markers.js';
import { PowerupView } from './powerup-view.js';
import { raycastVoxels } from '../../../shared/raycast.js';

/** Sun placement in world units; direction normalises to sky.SUN_DIR. */
const SUN_POS = new THREE.Vector3(60, 90, 20);

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
   * @param {{getBlock:Function,getBlockDamage?:Function,meta?:object}} storeRef
   * @param {object|null} mapMeta
   */
  constructor(storeRef, mapMeta = null) {
    if (!storeRef || typeof storeRef.getBlock !== 'function') {
      throw new TypeError('WorldView requires { getBlock }');
    }
    this.store = storeRef;
    this.replayTerrain = null;
    this.replayTouched = new Map();
    const visualBlock = (x, y, z) => (this.replayTerrain || this.store).getBlock(x, y, z);
    const visualDamage = (x, y, z) => (this.replayTerrain || this.store).getBlockDamage?.(x, y, z) || 0;
    const meta = mapMeta || storeRef.meta;
    const palette = mapAtmosphere(meta?.id);

    this.scene = new THREE.Scene();
    this.bastion = meta?.id === 'reactor' ? new BastionWorld(this.scene) : null;
    this.scene.fog = new THREE.FogExp2(palette.fog, palette.density);

    const hemi = new THREE.HemisphereLight(palette.skyLight, palette.groundLight, palette.ambient);
    hemi.name = 'hemi';
    this.scene.add(hemi);

    const sun = new THREE.DirectionalLight(palette.sun, palette.sunlight);
    sun.name = 'sun';
    sun.position.copy(SUN_POS);
    sun.castShadow = false;              // perf: AO + face shading carry the look
    this.scene.add(sun);
    this.sun = sun;

    this.atlas = buildAtlas();
    this.chunkStore = new ChunkStore(this.scene, this.atlas, visualBlock, visualDamage, getMapDimensions(meta?.id));

    this.mapDetails = (mapMeta || storeRef.meta)?.id === 'nuketown' ? buildNuketownDetails() : null;
    if (this.mapDetails) this.scene.add(this.mapDetails.group);
    this.mapSigns = buildMapSigns(meta?.id, visualBlock);
    this.scene.add(this.mapSigns.group);
    this.mapLights = buildMapLights(meta?.id, visualBlock);
    this.scene.add(this.mapLights.group);

    this.skyUpdate = installSky(this.scene, palette, getMapDimensions(meta?.id));

    this.ladderVisuals = buildLadderVisuals(mapMeta || storeRef.meta || null);
    if (this.ladderVisuals) this.scene.add(this.ladderVisuals.group);
    this.siteMarkers = new SiteMarkers((mapMeta || storeRef.meta || null)?.sites);
    this.scene.add(this.siteMarkers.group);
    this.powerups = new PowerupView();
    this.scene.add(this.powerups.group);
  }

  /** Builds every initial chunk column; resolves when the world is renderable. */
  async ready() {
    this.chunkStore.buildAll();
    return this;
  }

  /**
   * Batched block updates from the snapshot loop / 'block' events.
   * Each entry is {x,y,z,v}; dirty chunks remesh within the per-frame budget.
   */
  applyDeltas(deltas) {
    if (this.replayTerrain) {
      this.rememberReplayDeltas(deltas);
      return;
    }
    this.rebuildDeltas(deltas);
  }

  rebuildDeltas(deltas) {
    for (let i = 0; i < deltas.length; i++) {
      const d = deltas[i];
      this.chunkStore.applyBlockDelta(d.x, d.y, d.z, d.v);
    }
    if (deltas.length) {
      this.mapSigns.refresh();
      this.mapLights.refresh();
    }
  }

  rememberReplayDeltas(deltas) {
    for (const d of deltas) this.replayTouched.set(`${d.x},${d.y},${d.z}`, d);
  }

  setReplayTerrain(terrain) {
    if (terrain === this.replayTerrain) return;
    this.replayTerrain = terrain;
    this.rememberReplayDeltas(terrain?.changed || []);
    this.rebuildDeltas([...this.replayTouched.values()]);
    // A replay frame must show the recorded state before it is rendered.
    this.chunkStore.update(Infinity);
    if (!terrain) this.replayTouched.clear();
  }

  updateReplayTerrain(deltas) {
    if (!this.replayTerrain || !deltas.length) return;
    this.rememberReplayDeltas(deltas);
    this.rebuildDeltas(deltas);
    this.chunkStore.update(Infinity);
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

  setMatch(match) { this.bastion?.sync(match); }

  setGameMode(mode) {
    this.siteMarkers.setMode(mode);
  }

  setPowerups(rows) {
    this.powerups.sync(rows);
  }

  /** Per-frame tick: drains the chunk remesh budget and drifts the clouds. */
  update(dt) {
    this.chunkStore.update();
    this.skyUpdate(dt);
    this.powerups.update(dt);
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.chunkStore.dispose();
    this.bastion?.dispose();
    if (this.ladderVisuals) {
      this.scene.remove(this.ladderVisuals.group);
      this.ladderVisuals.mesh.dispose();
      this.ladderVisuals.geometry.dispose();
      this.ladderVisuals.material.dispose();
      this.ladderVisuals.group.clear();
      this.ladderVisuals = null;
    }
    if (this.mapDetails) {
      this.scene.remove(this.mapDetails.group);
      this.mapDetails.dispose();
      this.mapDetails = null;
    }
    this.siteMarkers.dispose();
    this.powerups.dispose();
    this.mapSigns.dispose();
    this.mapLights.dispose();
    this.skyUpdate.dispose();
    this.atlas.dispose();
  }
}
