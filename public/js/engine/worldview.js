import { TttSupplyView } from './ttt-supplies.js';
import { TttCorpseView } from './ttt-corpses.js';
import { TttWeaponView } from './ttt-weapons.js';
import { TttTrapView } from './ttt-traps.js';
import { getMapDimensions } from '../../../shared/world/dimensions.js';
import { BastionWorld } from './bastion-world.js';
// WorldView: composition root for the client's visual world. Owns the THREE.Scene,
// lighting rig, texture atlas, chunk mesher, sky and voxel picking. Fed a live
// store reference ({ getBlock }) whose closure always reflects the latest netcode
// state, so every mesh rebuild and raycast reads current blocks.

import * as THREE from '../vendor/three.module.js';
import { buildAtlas } from './atlas.js';
import { ChunkStore } from './chunks.js';
import { GrassTufts } from './grass-tufts.js';
import { buildInitialMesh } from './initial-mesh.js';
import { installSky } from './sky.js';
import { buildNuketownDetails } from './nuketown-details.js';
import { buildMinecraftB5Details } from './minecraft-b5-details.js';
import { buildWaterworldDetails } from './waterworld-details.js';
import { buildBikiniBottomDetails } from './bikini-bottom-details.js';
import { tickFluidMaterials, applyWaterPalette, configureFluidQuality } from './fluid-material.js';
import { mapAtmosphere } from './map-atmosphere.js';
import { buildMapBackdrop } from './map-backdrop.js';
import { buildMapAmbience } from './map-ambience.js';
import { buildMapSigns } from './map-signs.js';
import { buildMapLights } from './map-lights.js';
import { SiteMarkers } from './site-markers.js';
import { PowerupView } from './powerup-view.js';
import { raycastVoxels } from '../../../shared/raycast.js';
import { GRAPHICS_PROFILES } from './graphics-quality.js';
import { VoxelLightVolume, createVoxelLightUniforms, bindVoxelLightVolume, updateViewExposure } from './voxel-light.js';
import { bakeEnvironment } from './environment-map.js';
import { installFarFog } from './fog-chunk.js';
import { DynamicShadows, configureShadowRenderer } from './dynamic-shadows.js';
import { ContactShadows, presentCharacterFrame } from './contact-shadows.js';
import { bindCharacterLight, releaseCharacterLight } from './character-light.js';

installFarFog();

/** Distance of the directional sun from the map centre along its palette direction. */
const SUN_DISTANCE = 110;

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
  // Authored wall faces mark wooden block ladders; the foundry towers keep their steel.
  const wooden = ladders.some((ladder) => typeof ladder.face === 'string');
  const material = wooden
    ? new THREE.MeshStandardMaterial({ color: 0x8a6438, metalness: 0, roughness: 0.85 })
    : new THREE.MeshStandardMaterial({
      color: 0xffd21f,
      emissive: 0x6b2d00,
      emissiveIntensity: 0.9,
      metalness: 0.35,
      roughness: 0.42,
    });
  const mesh = new THREE.InstancedMesh(geometry, material, instanceCount);
  mesh.name = wooden ? 'block-ladders' : 'foundry-ladders';
  const matrix = new THREE.Matrix4();
  let instance = 0;

  const setBox = (x, y, z, sx, sy, sz) => {
    matrix.makeScale(sx, sy, sz);
    matrix.setPosition(x, y, z);
    mesh.setMatrixAt(instance++, matrix);
  };

  for (const ladder of ladders) {
    // Rails run along the wall the ladder hangs on: -Z by default (foundry).
    const face = ladder.face || 'z-';
    const alongX = face === 'z-' || face === 'z+';
    const wall = face === 'z-' ? ladder.minZ + 0.055 : face === 'z+' ? ladder.maxZ - 0.055
      : face === 'x-' ? ladder.minX + 0.055 : ladder.maxX - 0.055;
    const inward = face === 'z-' || face === 'x-' ? 1 : -1;
    const low = (alongX ? ladder.minX : ladder.minZ) + 0.15;
    const high = (alongX ? ladder.maxX : ladder.maxZ) - 0.15;
    const railHeight = ladder.maxY - ladder.minY;
    const railY = ladder.minY + railHeight * 0.5;
    const place = (along, y, out, sizeAlong, sizeY, sizeOut) => (alongX
      ? setBox(along, y, out, sizeAlong, sizeY, sizeOut)
      : setBox(out, y, along, sizeOut, sizeY, sizeAlong));
    place(low, railY, wall, 0.075, railHeight, 0.075);
    place(high, railY, wall, 0.075, railHeight, 0.075);

    const rungCount = ladderRungCount(ladder);
    const rungWidth = high - low + 0.075;
    for (let i = 0; i < rungCount; i++) {
      const y = ladder.minY + LADDER_RUNG_BOTTOM_INSET + i * LADDER_RUNG_SPACING;
      place((low + high) * 0.5, y, wall + inward * 0.008, rungWidth, 0.065, 0.085);
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
   * @param {{graphics?:object,renderer?:object}} options graphics tier knobs
   *   (graphics-quality.js) and the WebGLRenderer used for one-off bakes.
   */
  constructor(storeRef, mapMeta = null, { graphics = GRAPHICS_PROFILES.medium, renderer = null } = {}) {
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
    this.palette = palette;
    this.graphics = graphics;

    this.scene = new THREE.Scene();
    this.bastion = meta?.bastion ? new BastionWorld(this.scene, meta.bastion) : null;
    this.scene.fog = new THREE.FogExp2(palette.fog, palette.density);
    const dimensions = getMapDimensions(meta?.id);
    this.dimensions = dimensions;
    const center = new THREE.Vector3(dimensions.sx / 2, 0, dimensions.sz / 2);
    this.sunDir = new THREE.Vector3(...palette.sunDir).normalize();

    const hemi = new THREE.HemisphereLight(palette.skyLight, palette.groundLight, palette.ambient);
    hemi.name = 'hemi';
    this.scene.add(hemi);

    // The sun aims at the map centre; its target must live in the scene graph
    // or the light keeps pointing at the world origin.
    const sun = new THREE.DirectionalLight(palette.sun, palette.sunlight);
    sun.name = 'sun';
    sun.position.copy(center).addScaledVector(this.sunDir, SUN_DISTANCE);
    sun.target.position.copy(center);
    sun.castShadow = false;              // the voxel light volume bakes sun visibility
    this.scene.add(sun, sun.target);
    this.sun = sun;
    // High/Ultra add a shadow map for dynamic casters only; decided here, before
    // any world program compiles, and never toggled for the life of this map.
    configureFluidQuality(graphics);     // water shader detail, before any water material exists
    this.dynamicShadows = configureShadowRenderer(renderer, graphics)
      ? new DynamicShadows(this.scene, sun, {
        size: graphics.shadowMapSize, sunDir: this.sunDir, intensity: palette.light?.shadow ?? 0.75,
      })
      : null;

    // Prefiltered sky light for PBR surfaces, baked before any program compiles.
    this.environment = graphics.ibl ? bakeEnvironment(renderer, palette, this.sunDir) : null;
    if (this.environment) {
      this.scene.environment = this.environment.texture;
      this.scene.environmentIntensity = palette.envIntensity;
    }

    this.atlas = buildAtlas({ anisotropy: graphics.anisotropy, normals: graphics.normalMaps });
    this.lightUniforms = createVoxelLightUniforms();
    this.lightVolume = new VoxelLightVolume(visualBlock, dimensions, {
      sunDir: this.sunDir,
      emitters: () => this.mapLights?.emitters?.() || [],
    });
    this.chunkStore = new ChunkStore(this.scene, this.atlas, visualBlock, visualDamage, dimensions, {
      lightUniforms: this.lightUniforms,
      edgeShading: graphics.edgeShading,
      mapId: meta?.id,
    });
    this.grassTufts = new GrassTufts(this.scene, visualBlock, visualDamage, dimensions, {
      density: graphics.grassDensity, lightUniforms: this.lightUniforms, receiveShadow: !!this.dynamicShadows,
    });
    // An 8-bit target clips each channel at 1.0 on its own, which turns HDR
    // glowstone lime; LDR tiers keep emitters just inside the range.
    for (const kind of ['opaque', 'cutout', 'glass']) {
      const u = this.chunkStore.materials[kind].userData.terrainUniforms;
      if (u) u.terrainEmissive.value = graphics.hdr ? 1.7 : 0.4;
    }
    for (const fluid of [this.chunkStore.materials.water, this.chunkStore.materials.lava]) {
      fluid.uniforms.sunDir?.value.copy(this.sunDir);
    }

    this.mapDetails = meta?.id === 'nuketown' ? buildNuketownDetails()
      : meta?.id === 'minecraft_b5' ? buildMinecraftB5Details(meta, this.atlas)
        : meta?.id === 'waterworld' ? buildWaterworldDetails(meta)
          : meta?.id === 'bikini_bottom' ? buildBikiniBottomDetails(meta, visualBlock) : null;
    if (this.mapDetails) this.scene.add(this.mapDetails.group);
    applyWaterPalette(palette);
    this.mapSigns = buildMapSigns(meta?.id, visualBlock);
    this.scene.add(this.mapSigns.group);
    this.mapLights = buildMapLights(meta?.id, visualBlock);
    this.scene.add(this.mapLights.group);
    // Distant skyline (one merged draw) and the air (one points draw).
    this.backdrop = buildMapBackdrop(palette, dimensions);
    if (this.backdrop) this.scene.add(this.backdrop.group);
    this.ambience = buildMapAmbience(palette, {
      graphics, lightUniforms: this.lightUniforms,
      floorY: palette.ambience?.floor ?? (palette.backdrop?.ground ?? 14) + 1,
    });
    if (this.ambience) this.scene.add(this.ambience.points);

    // Fog takes the panorama's horizon tone, so distant geometry melts into the
    // sky behind it; the palette colour keeps a say for readability.
    this.skyUpdate = installSky(this.scene, palette, dimensions, {
      onHorizon: (horizon) => {
        if (!this._disposed) this.scene.fog.color.set(palette.fog).lerp(horizon, 0.6);
      },
    });

    this.ladderVisuals = buildLadderVisuals(mapMeta || storeRef.meta || null);
    if (this.ladderVisuals) this.scene.add(this.ladderVisuals.group);
    this.siteMarkers = new SiteMarkers((mapMeta || storeRef.meta || null)?.sites);
    this.scene.add(this.siteMarkers.group);
    this.tttSupplies = new TttSupplyView();
    this.scene.add(this.tttSupplies.group);
    this.tttCorpses = new TttCorpseView();
    this.scene.add(this.tttCorpses.group);
    this.tttWeapons = new TttWeaponView();
    this.scene.add(this.tttWeapons.group);
    this.tttTraps = new TttTrapView();
    this.scene.add(this.tttTraps.group);
    this.powerups = new PowerupView();
    this.scene.add(this.powerups.group);
    // Blob contact shadows (one draw) and character lighting from the light volume.
    this.contactShadows = new ContactShadows(visualBlock, { strength: this.dynamicShadows ? 0.8 : 1 });
    this.scene.add(this.contactShadows.mesh);
    bindCharacterLight(this.lightUniforms);
    this.characterRoots = [this.tttWeapons.group, this.tttCorpses.group];
    this.nearCharacterRoots = [];        // take the camera probe like the viewmodel (own body)
    if (this.dynamicShadows) {
      // Corpses and dropped guns are avatar-grade part lists: one silhouette per joint.
      for (const group of [this.tttWeapons.group, this.tttCorpses.group]) this.dynamicShadows.addCasterRoot(group, { coarse: true });
      for (const group of [this.tttSupplies.group, this.bastion?.group]) this.dynamicShadows.addCasterRoot(group);
      for (const group of [this.mapDetails?.group, this.ladderVisuals?.group]) this.dynamicShadows.markReceivers(group);
    }
  }

  /** Builds every initial chunk column; resolves when the world is renderable. */
  async ready(options) {
    this.lightVolume.build();
    bindVoxelLightVolume(this.lightUniforms, this.lightVolume, { ...this.palette.light, adaptation: !!this.graphics?.hdr });
    if (options) await buildInitialMesh(this.chunkStore, options);
    else this.chunkStore.buildAll();
    this.grassTufts.build();
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
      this.grassTufts.applyBlockDelta(d.x, d.y, d.z, d.v);
    }
    this.lightVolume.applyDeltas(deltas);
    if (deltas.length) {
      this.contactShadows.invalidate();
      this.mapSigns.refresh();
      const lit = this.mapLights.stats.visible;
      this.mapLights.refresh();
      if (this.mapLights.stats.visible !== lit) this.lightVolume.touchEmitters(this.mapLights.emitters());
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
    this.grassTufts.flush();
    this.lightVolume.flush();
    if (!terrain) this.replayTouched.clear();
  }

  updateReplayTerrain(deltas) {
    if (!this.replayTerrain || !deltas.length) return;
    this.rememberReplayDeltas(deltas);
    this.rebuildDeltas(deltas);
    this.chunkStore.update(Infinity);
    this.grassTufts.flush();
    this.lightVolume.flush();
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

  setMatch(match, serverNow) { this.bastion?.sync(match, undefined, serverNow); this.tttWeapons.sync(match?.weaponPickups || []); this.tttCorpses.sync(match?.corpses || []); this.tttSupplies.sync([...(match?.weaponPickups||[]).filter(p=>p.grenade),...(match?.c4||[])]); }

  setGameMode(mode) {
    this.siteMarkers.setMode(mode);
  }

  setPowerups(rows) {
    this.powerups.sync(rows);
  }

  /** Groups whose lit materials take character lighting (avatars, own body, viewmodel). */
  addCharacterRoots(...roots) {
    for (const root of roots) if (root && !this.characterRoots.includes(root)) this.characterRoots.push(root);
  }

  /**
   * Character roots lit by the camera probe instead of their own position (the
   * first-person body). Anything parented to the render camera, such as the
   * viewmodel, is near already.
   */
  addNearCharacterRoots(...roots) {
    this.addCharacterRoots(...roots);
    for (const root of roots) if (root && !this.nearCharacterRoots.includes(root)) this.nearCharacterRoots.push(root);
  }

  /**
   * Just before the render: patch character materials, feed the camera light
   * probe and rebuild the contact blobs. `frame` is a reused object:
   * { camera, dt, roster, bodyPosition } (contact-shadows.js).
   */
  presentCharacters(frame) {
    presentCharacterFrame(this, frame);
  }

  /** Per-frame tick: drains the chunk remesh budget and drifts the clouds. */
  update(dt, camera = null) {
    this.chunkStore.update();
    this.grassTufts.update(dt);
    this.lightVolume.update(typeof performance !== 'undefined' ? performance.now() : 0);
    if (camera) updateViewExposure(this.lightUniforms, this.lightVolume, camera.position, dt);
    tickFluidMaterials(dt);
    this.skyUpdate(dt);
    this.ambience?.update(dt);
    this.powerups.update(dt);
    this.bastion?.update(dt);
    this.mapDetails?.update?.(dt);
    this.tttTraps.update(this.tttTrapClock = (this.tttTrapClock || 0) + dt);
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.chunkStore.dispose();
    this.grassTufts.dispose();
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
    this.tttWeapons.dispose();
    this.tttTraps.dispose();
    this.tttCorpses.dispose();
    this.tttSupplies.dispose();
    this.mapSigns.dispose();
    this.mapLights.dispose();
    this.skyUpdate.dispose();
    this.backdrop?.dispose();
    this.ambience?.dispose();
    this.atlas.dispose();
    this.contactShadows.dispose();
    releaseCharacterLight(this.lightUniforms);
    this.characterRoots.length = 0;
    this.nearCharacterRoots.length = 0;
    this.lightVolume.dispose();
    this.lightUniforms._fallback.dispose();
    this.environment?.dispose();
    this.dynamicShadows?.dispose();
  }
}
