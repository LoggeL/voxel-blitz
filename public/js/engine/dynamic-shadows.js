// Sun shadows for DYNAMIC casters only (High/Ultra). Terrain shade already
// comes from the voxel light volume, so the shadow map holds just avatars,
// vehicles, built structures, corpses and dropped weapons: terrain chunks
// receive but never cast. One orthographic box follows the viewer, snapped to
// whole shadow texels so edges do not shimmer while the camera moves.
//
// Program keys: the sun's castShadow and the renderer's shadow flag/type are
// decided once per map (WorldView construction), before any world material
// compiles, and never toggled afterwards. The per-frame follow only moves the
// light and its target; the caster sweep only flips object flags, which the
// shadow pass reads without recompiling anything. The shadow pass's own depth
// programs are linked by warm() on the loading screen (shader-warmup.js).
//
// Draw budget: one operator avatar is ~100 meshes (merged panels per joint,
// pouches, visor, a weapon of 30 parts). "Coarse" roots (avatars, corpses,
// dropped weapons, the killcam replay) cast only one silhouette mesh per rigid
// joint, the largest, plus any mesh big enough to matter on its own (vehicle
// hulls), and only within SHADOW_PROFILE.coarseDistance of the viewer: about
// 16 shadow draws per nearby avatar instead of ~100.
//
// Gameplay parity (design decision): only High/Ultra render these shadows, so
// a High player can see a sunlit enemy's shadow before the enemy, like other
// shooters' shadow-quality settings. The distance cap and the coarse (joint-
// level) silhouette keep that cue short-ranged; Low/Medium keep the contact
// blobs under every character (contact-shadows.js).

import * as THREE from '../vendor/three.module.js';

export const SHADOW_PROFILE = Object.freeze({
  radius: 28,          // half extent of the ortho box, metres
  lead: 8,             // box centre sits this far ahead of the viewer, on the ground plane
  depth: 90,           // light distance from the box centre along the sun direction
  sweepSeconds: 0.25,  // caster flag refresh cadence (new avatars, fades, drops)
  coarseDistance: 24,  // coarse casters farther than this from the viewer never cast
  coarseMinRadius: 0.15, // a joint's silhouette mesh needs at least this bounding radius, metres
  coarseLargeRadius: 0.6, // meshes this big always cast under coarse roots (vehicle hulls)
  bias: -0.00025,
  normalBias: 0.025,
});

/**
 * Decide the renderer's shadow state for a graphics profile. Called before the
 * first world material compiles; a later map with another tier flips it at
 * load time only.
 */
export function configureShadowRenderer(renderer, graphics) {
  const map = renderer?.shadowMap;
  if (!map) return false;
  const enabled = (Number(graphics?.shadowMapSize) || 0) > 0;
  map.enabled = enabled;
  map.type = THREE.PCFSoftShadowMap;
  map.autoUpdate = true;
  return enabled;
}

/** Opaque, depth-writing meshes cast; FX, sprites, fades and glows never do. */
export function castsShadow(object) {
  if (!object.isMesh || object.isSprite || object.userData?.noShadow) return false;
  const material = object.material;
  if (!material || Array.isArray(material)) return !!material;
  return material.depthWrite !== false && material.blending === THREE.NormalBlending
    && material.opacity >= 0.5 && material.visible !== false;
}

function meshRadius(mesh) {
  const geometry = mesh.geometry;
  if (!geometry) return 0;
  if (!geometry.boundingSphere) geometry.computeBoundingSphere();
  const s = mesh.scale;
  return (geometry.boundingSphere?.radius || 0) * Math.max(Math.abs(s.x), Math.abs(s.y), Math.abs(s.z));
}

/**
 * Coarse silhouette part: the largest mesh among its mesh siblings (one per
 * rigid joint) when it is not a sliver, or any mesh large on its own. Decided
 * once per mesh and cached in userData (models only gain new meshes, e.g. a
 * weapon swap, which are judged when first seen).
 */
export function isCoarseShadowPart(mesh) {
  const cached = mesh.userData.vbShadowPart;
  if (cached !== undefined) return cached;
  const radius = meshRadius(mesh);
  let part = radius >= SHADOW_PROFILE.coarseLargeRadius;
  if (!part && radius >= SHADOW_PROFILE.coarseMinRadius) {
    part = true;
    const siblings = mesh.parent ? mesh.parent.children : [];
    const own = siblings.indexOf(mesh);
    for (let i = 0; i < siblings.length && part; i++) {
      const other = siblings[i];
      if (other === mesh || !other.isMesh || other.isSprite) continue;
      const r = meshRadius(other);
      // Ties go to the earlier sibling so exactly one of equal parts casts.
      if (r > radius || (r === radius && i < own)) part = false;
    }
  }
  mesh.userData.vbShadowPart = part;
  return part;
}

export class DynamicShadows {
  /**
   * @param {THREE.Scene} scene the world scene (its onBeforeRender drives the follow)
   * @param {THREE.DirectionalLight} sun the palette sun; its direction never changes
   * @param {{size:number, sunDir:THREE.Vector3, intensity?:number}} options
   *   intensity matches the voxel volume's baked shadow strength so a dynamic
   *   shadow and a baked one read equally dark.
   */
  constructor(scene, sun, { size = 2048, sunDir, intensity = 0.75 } = {}) {
    this.scene = scene;
    this.sun = sun;
    this.size = Math.max(256, Math.floor(size));
    this.sunDir = (sunDir ? sunDir.clone() : sun.position.clone().sub(sun.target.position)).normalize();
    this.casterRoots = [];              // an array: the sweep iterates without allocating
    this.coarseRoots = [];              // parallel flags: coarse silhouette + distance cap
    this.eye = new THREE.Vector3();
    this.hasEye = false;
    this.sweepClock = Infinity;
    this.lastTime = null;
    this.focus = new THREE.Vector3();
    this.forward = new THREE.Vector3();
    this.frames = 0;

    const R = SHADOW_PROFILE.radius;
    sun.castShadow = true;
    const shadow = sun.shadow;
    shadow.mapSize.set(this.size, this.size);
    shadow.bias = SHADOW_PROFILE.bias;
    shadow.normalBias = SHADOW_PROFILE.normalBias;
    shadow.intensity = Math.max(0, Math.min(1, intensity));
    shadow.autoUpdate = true;
    const cam = shadow.camera;
    cam.left = -R; cam.right = R; cam.top = R; cam.bottom = -R;
    cam.near = 1;
    cam.far = SHADOW_PROFILE.depth + R * 2;
    cam.updateProjectionMatrix();
    this.texel = (2 * R) / this.size;

    // Light-space basis exactly as Matrix4.lookAt builds the shadow camera:
    // z towards the sun, x = up x z, y = z x x.
    this.axisZ = this.sunDir.clone();
    const up = Math.abs(this.axisZ.y) > 0.999 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
    this.axisX = new THREE.Vector3().crossVectors(up, this.axisZ).normalize();
    this.axisY = new THREE.Vector3().crossVectors(this.axisZ, this.axisX);

    this._markCaster = (object) => { object.castShadow = castsShadow(object); };
    const coarseDistance2 = SHADOW_PROFILE.coarseDistance * SHADOW_PROFILE.coarseDistance;
    this._markCoarse = (object) => {
      let cast = castsShadow(object) && isCoarseShadowPart(object);
      if (cast && this.hasEye) {
        const m = object.matrixWorld.elements, eye = this.eye;
        const dx = m[12] - eye.x, dy = m[13] - eye.y, dz = m[14] - eye.z;
        cast = dx * dx + dy * dy + dz * dz <= coarseDistance2;
      }
      object.castShadow = cast;
    };
    this._markReceiver = (object) => { if (object.isMesh) object.receiveShadow = true; };
    this._previousBeforeRender = scene.onBeforeRender;
    const previous = this._previousBeforeRender;
    scene.onBeforeRender = (renderer, sceneArg, camera, target) => {
      previous?.call(scene, renderer, sceneArg, camera, target);
      this.follow(camera);
    };
  }

  /**
   * Meshes under root cast while they stay opaque; swept a few times a second.
   * `coarse` (avatars, corpses, dropped weapons) casts one silhouette mesh per
   * joint and only near the viewer; otherwise every opaque mesh casts.
   */
  addCasterRoot(root, { coarse = false } = {}) {
    if (!root) return;
    const index = this.casterRoots.indexOf(root);
    if (index < 0) { this.casterRoots.push(root); this.coarseRoots.push(!!coarse); }
    else this.coarseRoots[index] = !!coarse;
    root.traverse(coarse ? this._markCoarse : this._markCaster);
  }

  removeCasterRoot(root) {
    const index = this.casterRoots.indexOf(root);
    if (index >= 0) { this.casterRoots.splice(index, 1); this.coarseRoots.splice(index, 1); }
  }

  /** One-time receive flag for static meshes (details, ladders, structures). */
  markReceivers(root) { root?.traverse(this._markReceiver); }

  /**
   * Centre the shadow box a little ahead of the viewer on the sun's texel
   * grid. Runs from scene.onBeforeRender, after the scene graph's matrices and
   * before the shadow pass, so the killcam and captures follow too.
   */
  follow(camera) {
    if (!camera?.matrixWorld) return;
    const e = camera.matrixWorld.elements;
    this.eye.set(e[12], e[13], e[14]);
    this.hasEye = true;
    const f = this.forward.set(-e[8], 0, -e[10]);
    const flat = f.length();
    if (flat > 1e-4) f.multiplyScalar(SHADOW_PROFILE.lead / flat);
    const focus = this.focus.set(e[12], e[13], e[14]).add(f);
    const t = this.texel;
    const a = Math.round(focus.dot(this.axisX) / t) * t;
    const b = Math.round(focus.dot(this.axisY) / t) * t;
    const c = focus.dot(this.axisZ);
    focus.copy(this.axisX).multiplyScalar(a).addScaledVector(this.axisY, b).addScaledVector(this.axisZ, c);
    const sun = this.sun;
    sun.target.position.copy(focus);
    sun.position.copy(focus).addScaledVector(this.sunDir, SHADOW_PROFILE.depth);
    sun.updateMatrixWorld();
    sun.target.updateMatrixWorld();

    const now = typeof performance !== 'undefined' ? performance.now() * 0.001 : 0;
    const dt = this.lastTime === null ? 0 : Math.max(0, now - this.lastTime);
    this.lastTime = now;
    this.sweepClock += dt;
    if (this.sweepClock >= SHADOW_PROFILE.sweepSeconds) {
      this.sweepClock = 0;
      const roots = this.casterRoots, coarse = this.coarseRoots;
      for (let i = 0; i < roots.length; i++) roots[i].traverse(coarse[i] ? this._markCoarse : this._markCaster);
    }
    this.frames++;
  }

  get stats() {
    return Object.freeze({
      size: this.size,
      radius: SHADOW_PROFILE.radius,
      texel: this.texel,
      casterRoots: this.casterRoots.length,
      coarseRoots: this.coarseRoots.filter(Boolean).length,
      frames: this.frames,
    });
  }

  /**
   * Link the shadow pass's depth programs on the loading screen. compileAsync
   * never builds them and no avatar casts yet, so the first remote player to
   * walk into the box would otherwise compile MeshDepthMaterial mid-match.
   * three draws every plain caster with ONE shared depth material whose
   * program is fixed by its first compile (later map/side changes do not bump
   * its version), and gives each alpha-tested (or alpha-mapped) material its
   * own clone. So a throwaway scene with a 16 px shadow light holds one proxy
   * box for the shared program (an operator-like textured front-side part,
   * the same key the first avatar would pick) and one per alpha-test variant
   * found under the caster roots and `extraRoots`. The boxes sit behind the
   * warm camera, so the colour pass culls them and compiles nothing; only the
   * shadow pass draws them. Returns the number of proxies rendered.
   */
  warm(renderer, extraRoots = []) {
    if (!renderer?.render || !renderer.shadowMap?.enabled) return 0;
    const scene = new THREE.Scene();
    const light = new THREE.DirectionalLight(0xffffff, 1);
    light.castShadow = true;
    light.shadow.mapSize.set(16, 16);
    const cam = light.shadow.camera;
    cam.left = -8; cam.right = 8; cam.top = 8; cam.bottom = -8; cam.near = 0.5; cam.far = 60;
    cam.updateProjectionMatrix();
    light.position.set(0, 20, 50);
    light.target.position.set(0, 0, 50);
    scene.add(light, light.target);
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1);   // looks down -Z, the boxes sit at +Z
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const texel = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    texel.needsUpdate = true;
    const synthetic = [new THREE.MeshStandardMaterial({ map: texel })];
    const keys = new Set();
    const addProxy = (material) => {
      if (!material || material.visible === false) return;
      // Mirrors WebGLShadowMap.getDepthMaterial: which materials get their own depth clone.
      const own = (material.alphaMap && material.alphaTest > 0) || (material.map && material.alphaTest > 0)
        || material.alphaToCoverage === true || (material.displacementMap && material.displacementScale !== 0);
      const key = own
        ? `${material.shadowSide ?? material.side}|${!!material.map}|${!!material.alphaMap}|${!!material.displacementMap}`
        : 'shared';
      if (keys.has(key)) return;
      keys.add(key);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set((keys.size % 8) - 4, 0, 50);
      mesh.castShadow = true;
      scene.add(mesh);
    };
    for (const material of synthetic) addProxy(material);
    const collect = (object) => {
      if (!object.isMesh || object.isInstancedMesh || object.isSkinnedMesh || object.isSprite) return;
      if (Array.isArray(object.material)) { for (const m of object.material) addProxy(m); return; }
      if (castsShadow(object)) addProxy(object.material);
    };
    for (const root of this.casterRoots) root.traverse(collect);
    for (const root of extraRoots) root?.traverse?.(collect);

    const previousTarget = renderer.getRenderTarget?.() ?? null;
    const target = new THREE.WebGLRenderTarget(1, 1);
    const proxies = keys.size;
    try {
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
    } catch (error) {
      console.warn('[vb] shadow warm-up failed', error);
    } finally {
      renderer.setRenderTarget(previousTarget);
      target.dispose();
      light.shadow.dispose();
      geometry.dispose();
      texel.dispose();
      for (const material of synthetic) material.dispose();
    }
    return proxies;
  }

  dispose() {
    if (this.scene.onBeforeRender !== this._previousBeforeRender) {
      this.scene.onBeforeRender = this._previousBeforeRender || function () {};
    }
    this.casterRoots.length = 0;
    this.coarseRoots.length = 0;
    this.sun.shadow.map?.dispose();
    this.sun.shadow.map = null;
  }
}
