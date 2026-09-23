// High/Ultra lighting extras without a GPU: dynamic-caster sun shadows, the
// SSAO passes of the post chain, and the water surface's sky/foam terms.
import assert from 'node:assert/strict';
import * as THREE from '../public/js/vendor/three.module.js';
import { DynamicShadows, SHADOW_PROFILE, configureShadowRenderer, isCoarseShadowPart } from '../public/js/engine/dynamic-shadows.js';
import { warmShaders } from '../public/js/engine/shader-warmup.js';
import { CombatPostProcess, SSAO } from '../public/js/engine/combat-post-process.js';
import { applyWaterPalette, configureFluidQuality, createFluidMaterial } from '../public/js/engine/fluid-material.js';
import { voxelLightsFragmentBegin } from '../public/js/engine/voxel-light.js';
import { mapAtmosphere } from '../public/js/engine/map-atmosphere.js';
import { GRAPHICS_PROFILES } from '../public/js/engine/graphics-quality.js';

let checks = 0;
const check = (fn) => { fn(); checks++; };

// --- renderer shadow state follows the tier, decided once per map ----------------
{
  const renderer = { shadowMap: { enabled: true, type: 0, autoUpdate: false } };
  check(() => assert.equal(configureShadowRenderer(renderer, GRAPHICS_PROFILES.medium), false));
  check(() => assert.equal(renderer.shadowMap.enabled, false, 'medium has no shadow map'));
  check(() => assert.equal(configureShadowRenderer(renderer, GRAPHICS_PROFILES.high), true));
  check(() => assert.equal(renderer.shadowMap.enabled, true));
  check(() => assert.equal(renderer.shadowMap.type, THREE.PCFSoftShadowMap));
  check(() => assert.equal(configureShadowRenderer(null, GRAPHICS_PROFILES.ultra), false, 'no renderer, no shadows'));
}

// --- the shadow box follows the viewer on a texel grid; the sun keeps its direction
{
  const scene = new THREE.Scene();
  const sunDir = new THREE.Vector3(60, 90, 20).normalize();
  const sun = new THREE.DirectionalLight(0xffffff, 1);
  sun.position.set(64, 0, 48).addScaledVector(sunDir, 110);
  sun.target.position.set(64, 0, 48);
  scene.add(sun, sun.target);
  const shadows = new DynamicShadows(scene, sun, { size: 2048, sunDir, intensity: 0.75 });
  check(() => assert.equal(sun.castShadow, true));
  check(() => assert.equal(sun.shadow.mapSize.x, 2048));
  check(() => assert.equal(sun.shadow.intensity, 0.75, 'dynamic shadow as dark as the baked one'));
  check(() => assert.equal(sun.shadow.camera.right, SHADOW_PROFILE.radius));

  const camera = new THREE.PerspectiveCamera();
  const follow = (x, y, z) => {
    camera.position.set(x, y, z);
    camera.updateMatrixWorld();
    scene.onBeforeRender(null, scene, camera, null);
    return sun.target.position.clone();
  };
  const a = follow(30.0, 20, 40.0);
  const dir = sun.position.clone().sub(sun.target.position).normalize();
  check(() => assert.ok(dir.distanceTo(sunDir) < 1e-6, 'sun direction is unchanged by the follow'));
  check(() => assert.ok(a.distanceTo(new THREE.Vector3(30, 20, 40 - SHADOW_PROFILE.lead)) < 0.05, 'box leads the view'));
  // A sub-texel camera move keeps the box on the same texel grid position.
  const b = follow(30.004, 20, 40.0);
  const texel = shadows.texel;
  const inLight = (v) => [v.dot(shadows.axisX) / texel, v.dot(shadows.axisY) / texel];
  for (const value of [...inLight(a), ...inLight(b)]) {
    check(() => assert.ok(Math.abs(value - Math.round(value)) < 1e-6, 'centre snapped to whole texels'));
  }

  // Casters: opaque meshes under a root cast; FX, sprites and fades never do.
  const root = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshLambertMaterial({ transparent: true }));
  const glow = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial({ blending: THREE.AdditiveBlending }));
  const ghost = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshLambertMaterial({ transparent: true, opacity: 0.2 }));
  const tag = new THREE.Sprite(new THREE.SpriteMaterial());
  root.add(body, glow, ghost, tag);
  shadows.addCasterRoot(root);
  check(() => assert.equal(body.castShadow, true, 'avatar parts cast even with transparent: true at full opacity'));
  check(() => assert.equal(glow.castShadow, false));
  check(() => assert.equal(ghost.castShadow, false, 'a fading body stops casting'));
  check(() => assert.equal(tag.castShadow, false));
  const floor = new THREE.Group();
  floor.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshLambertMaterial()));
  shadows.markReceivers(floor);
  check(() => assert.equal(floor.children[0].receiveShadow, true));
  check(() => assert.equal(floor.children[0].castShadow, false, 'receivers never cast'));

  // Coarse roots (avatars): one silhouette mesh per rigid joint, never slivers,
  // big hull panels always, and nothing past the distance cap.
  const box = (size) => new THREE.Mesh(new THREE.BoxGeometry(size, size, size), new THREE.MeshLambertMaterial());
  const avatars = new THREE.Group();
  const torso = new THREE.Group();
  const [chest, plate, strap] = [box(0.5), box(0.3), box(0.05)];
  torso.add(chest, plate, strap);
  const hand = new THREE.Group();
  const finger = box(0.1);
  hand.add(finger);
  const hull = new THREE.Group();
  const [deck, skirt, wheel] = [box(2), box(0.9), box(0.3)];
  hull.add(deck, skirt, wheel);
  const twinA = box(0.4), twinB = box(0.4);
  const legs = new THREE.Group();
  legs.add(twinA, twinB);
  const avatar = new THREE.Group();
  avatar.add(torso, hand, hull, legs);
  avatars.add(avatar);
  const casting = () => [chest, plate, strap, finger, deck, skirt, wheel, twinA, twinB].map(m => m.castShadow);
  const shadows2 = new DynamicShadows(new THREE.Scene(), new THREE.DirectionalLight(), { size: 1024, sunDir });
  shadows2.addCasterRoot(avatars, { coarse: true });
  check(() => assert.deepEqual(casting(), [true, false, false, false, true, true, false, true, false],
    'largest part per joint, no slivers, large panels always, one of equal twins'));
  check(() => assert.equal(isCoarseShadowPart(strap), false));
  check(() => assert.equal(shadows2.stats.coarseRoots, 1));
  const sweepAt = (x) => {
    avatar.position.set(x, 0, 0);
    avatar.updateMatrixWorld(true);
    shadows2.sweepClock = Infinity;
    camera.position.set(0, 1.7, 0);
    camera.updateMatrixWorld();
    shadows2.follow(camera);
  };
  sweepAt(SHADOW_PROFILE.coarseDistance + 6);
  check(() => assert.ok(casting().every(v => v === false), 'far avatars cast nothing'));
  sweepAt(6);
  check(() => assert.equal(chest.castShadow, true, 'near avatars cast again'));
  chest.material.opacity = 0.2;
  sweepAt(6);
  check(() => assert.equal(chest.castShadow, false, 'a fading coarse part stops casting'));
  chest.material.opacity = 1;

  // warm(): one shadow-only proxy per depth-program key, behind the warm camera.
  const warmScenes = [];
  const warmRenderer = {
    shadowMap: { enabled: true }, target: 'canvas',
    getRenderTarget() { return this.target; }, setRenderTarget(target) { this.target = target; },
    render(scene, cam) { warmScenes.push({ scene, cam, target: this.target }); },
  };
  const cutout = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshLambertMaterial({ alphaTest: 0.5, map: new THREE.Texture() }));
  const extra = new THREE.Group();
  extra.add(cutout);
  const proxies = shadows2.warm(warmRenderer, [extra]);
  check(() => assert.equal(warmScenes.length, 1));
  const warmed = warmScenes[0];
  const meshes = warmed.scene.children.filter(o => o.isMesh);
  check(() => assert.equal(proxies, meshes.length));
  check(() => assert.equal(proxies, 2, 'the shared depth program plus the alpha-tested cutout clone'));
  check(() => assert.ok(meshes.every(m => m.castShadow)));
  check(() => assert.ok(meshes.some(m => m.material === cutout.material), 'real caster materials are warmed'));
  const light = warmed.scene.children.find(o => o.isDirectionalLight);
  check(() => assert.equal(light?.castShadow, true));
  warmed.cam.updateMatrixWorld();
  const frustum = new THREE.Frustum().setFromProjectionMatrix(
    new THREE.Matrix4().multiplyMatrices(warmed.cam.projectionMatrix, warmed.cam.matrixWorldInverse));
  check(() => assert.ok(meshes.every(m => { m.updateMatrixWorld(); return !frustum.intersectsObject(m); }),
    'the colour pass culls every proxy: no colour program compiles'));
  check(() => assert.notEqual(warmed.target, 'canvas', 'warm renders off-screen'));
  check(() => assert.equal(warmRenderer.target, 'canvas', 'previous target restored'));
  check(() => assert.equal(shadows2.warm({ shadowMap: { enabled: false }, render() { throw new Error('no'); } }), 0));
  let warmedBy = null;
  await warmShaders({
    renderer: { setRenderTarget() {}, info: { programs: [] }, compileAsync: () => Promise.resolve() },
    scene: new THREE.Scene(), camera, characterRoots: [extra],
    shadows: { warm(renderer, roots) { warmedBy = roots; } },
  });
  check(() => assert.deepEqual(warmedBy, [extra], 'warmShaders links the shadow depth programs'));
  shadows2.dispose();

  const frames = shadows.frames;
  shadows.dispose();
  scene.onBeforeRender(null, scene, camera, null);
  check(() => assert.equal(shadows.frames, frames, 'a disposed follow no longer runs'));
}

// --- baked sun and shadow map combine as min(), not a product --------------------
{
  const chunk = voxelLightsFragmentBegin();
  check(() => assert.match(chunk, /directLight\.color \*= voxelLight\.sun;/));
  check(() => assert.match(chunk, /min\( 1\.0, getShadow\( directionalShadowMap\[ i \][^;]*\/ max\( voxelLight\.sun, 0\.05 \) \)/));
}

// --- SSAO: two half-resolution passes, compiled only when asked for -------------
function mockRenderer() {
  return {
    autoClear: true, target: null, calls: [], info: { autoReset: true, reset() {} },
    setRenderTarget(target) { this.target = target; },
    render(scene, camera) { this.calls.push({ scene, camera, target: this.target }); },
  };
}
{
  const camera = new THREE.PerspectiveCamera(75, 16 / 9, 0.05, 400);
  camera.updateProjectionMatrix();
  const scene = new THREE.Scene();
  const plain = mockRenderer();
  const off = new CombatPostProcess(plain, { msaa: 4 });
  off.setSize(800, 600, 1);
  off.render(scene, camera, {});
  check(() => assert.equal(plain.calls.length, 2, 'no SSAO: scene + composite'));
  check(() => assert.equal(off.material.defines.USE_SSAO, undefined));
  check(() => assert.equal(off.stats.ssao, false));

  const r = mockRenderer();
  const on = new CombatPostProcess(r, { msaa: 4, ssao: true });
  on.setSize(800, 600, 1);
  check(() => assert.equal(on.render(scene, camera, {}), true));
  check(() => assert.equal(r.calls.length, 4, 'scene, SSAO, blur, composite'));
  check(() => assert.equal(r.calls[1].target, on.occlusion.raw));
  check(() => assert.equal(r.calls[2].target, on.occlusion.blurred));
  check(() => assert.equal(on.occlusion.raw.width, 400, 'half resolution'));
  check(() => assert.equal(on.material.defines.USE_SSAO, ''));
  check(() => assert.equal(on.uniforms.ssaoTexture.value, on.occlusion.blurred.texture));
  check(() => assert.equal(on.occlusion.pass.defines.SSAO_SAMPLES, SSAO.samples));
  check(() => assert.ok(on.occlusion.pass.uniforms.cameraProjectionInverse.value.equals(camera.projectionMatrixInverse)));
  check(() => assert.equal(on.stats.ssao, true));
  on.dispose();
  off.dispose();
}

// --- water: sky reflection and bank foam per map palette -------------------------
{
  const water = createFluidMaterial('water');
  const lava = createFluidMaterial('lava');
  check(() => assert.equal(water.defines.FLUID_WATER, ''));
  check(() => assert.equal(lava.defines.FLUID_WATER, undefined, 'lava keeps its own branch'));
  check(() => assert.match(water.fragmentShader, /skyColor/));
  applyWaterPalette(mapAtmosphere('waterworld'));
  check(() => assert.ok(water.uniforms.reflection.value < 0.3, 'indoor pools only get a faint sky sheen'));
  check(() => assert.equal(water.uniforms.skyColor.value.getHex(), new THREE.Color(mapAtmosphere('waterworld').skyTop).getHex()));
  applyWaterPalette(mapAtmosphere('minecraft_b5'));
  check(() => assert.ok(water.uniforms.reflection.value >= 0.45, 'open sea reflects the sky'));
  const later = createFluidMaterial('water');
  check(() => assert.equal(later.uniforms.reflection.value, water.uniforms.reflection.value, 'new water starts from the palette'));
  for (const m of [water, lava, later]) m.dispose();

  // Tier detail picks the water defines at map load: Low keeps reflection only.
  const detail = (tier) => {
    configureFluidQuality({ tier });
    const m = createFluidMaterial('water');
    const d = { ...m.defines };
    m.dispose();
    return d;
  };
  check(() => assert.deepEqual(detail('low'), { FLUID_WATER: '' }, 'low: no foam noise at all'));
  check(() => assert.deepEqual(detail('medium'), { FLUID_WATER: '', FLUID_FOAM: '' }));
  check(() => assert.deepEqual(detail('ultra'), { FLUID_WATER: '', FLUID_FOAM: '', FLUID_FOAM_DETAIL: '' }));
  check(() => assert.deepEqual(detail('high'), { FLUID_WATER: '', FLUID_FOAM: '', FLUID_FOAM_DETAIL: '' }));
}

console.log(`advanced-lighting-test: ${checks} checks passed`);
