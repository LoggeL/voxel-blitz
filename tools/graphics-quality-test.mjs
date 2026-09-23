// Graphics tier resolution, the settings summary and the post chain's pass
// accounting and fail-open behaviour, without a browser or a GPU.
import assert from 'node:assert/strict';
import {
  GRAPHICS_PROFILES, GRAPHICS_TIERS, autoGraphicsTier, normalizeGraphicsQuality, rendererCapabilities,
  resolveGraphicsProfile,
} from '../public/js/engine/graphics-quality.js';
import { CombatPostProcess, DEFAULT_GRADE } from '../public/js/engine/combat-post-process.js';
import { describeGraphicsTier, graphicsSettingsSummary } from '../public/js/ui/graphics-settings.js';
import * as THREE from '../public/js/vendor/three.module.js';
import { CHARACTER_LIGHT_KEY, ShaderErrorMonitor, warmShaders } from '../public/js/engine/shader-warmup.js';
import { patchCharacterMaterial, setCharacterLightEnabled } from '../public/js/engine/character-light.js';

let checks = 0;
const check = (fn) => { fn(); checks++; };

// --- normalizeGraphicsQuality -------------------------------------------------
check(() => assert.deepEqual(GRAPHICS_TIERS.map(t => t.value), ['auto', 'low', 'medium', 'high', 'ultra']));
for (const tier of GRAPHICS_TIERS) check(() => assert.equal(normalizeGraphicsQuality(tier.value), tier.value));
for (const bad of [null, undefined, '', 'HIGH', 'epic', 3, {}]) {
  check(() => assert.equal(normalizeGraphicsQuality(bad), 'auto', `${String(bad)} falls back to auto`));
}

// --- autoGraphicsTier ------------------------------------------------------------
check(() => assert.equal(autoGraphicsTier({ touch: true, deviceMemory: 16 }), 'low', 'touch -> low'));
check(() => assert.equal(autoGraphicsTier({ touch: false, deviceMemory: 8 }), 'high', '8 GB -> high'));
check(() => assert.equal(autoGraphicsTier({ deviceMemory: 4 }), 'low', '4 GB -> low'));
check(() => assert.equal(autoGraphicsTier({ deviceMemory: 6 }), 'medium'));
check(() => assert.equal(autoGraphicsTier({}), 'medium', 'unknown memory (Safari, Firefox) -> medium'));
check(() => assert.equal(autoGraphicsTier(), 'medium'));

// --- resolveGraphicsProfile ------------------------------------------------------
const desktop = { maxSamples: 4, halfFloat: true, maxAnisotropy: 16, deviceMemory: 8 };
for (const tier of ['low', 'medium', 'high', 'ultra']) {
  const profile = resolveGraphicsProfile(tier, desktop);
  check(() => assert.equal(profile.tier, tier));
  check(() => assert.equal(profile.preference, tier));
  check(() => assert.equal(profile.msaa, GRAPHICS_PROFILES[tier].msaa, `${tier} keeps its MSAA with 4 samples`));
  check(() => assert.ok(Object.isFrozen(profile)));
}
check(() => assert.equal(resolveGraphicsProfile('auto', desktop).tier, 'high'));
check(() => assert.equal(resolveGraphicsProfile('auto', desktop).preference, 'auto'));
check(() => assert.equal(resolveGraphicsProfile('bogus', { ...desktop, touch: true }).tier, 'low'));
// MSAA clamps to the samples the context can allocate.
check(() => assert.equal(resolveGraphicsProfile('ultra', { ...desktop, maxSamples: 2 }).msaa, 2));
check(() => assert.equal(resolveGraphicsProfile('high', { ...desktop, maxSamples: 0 }).msaa, 0));
check(() => assert.equal(resolveGraphicsProfile('high', { halfFloat: true }).msaa, 0, 'unknown sample count -> no MSAA'));
// Touch never multisamples, even when the tier is forced.
for (const tier of ['medium', 'high', 'ultra']) {
  check(() => assert.equal(resolveGraphicsProfile(tier, { ...desktop, touch: true }).msaa, 0, `${tier} on touch`));
}
// HDR needs renderable half floats; bloom needs HDR.
for (const tier of ['medium', 'high', 'ultra']) {
  const ldr = resolveGraphicsProfile(tier, { ...desktop, halfFloat: false });
  check(() => assert.equal(ldr.hdr, false, `${tier} without half floats`));
  check(() => assert.equal(ldr.bloomLevels, 0, `${tier} has no bloom without HDR`));
  const hdr = resolveGraphicsProfile(tier, desktop);
  check(() => assert.equal(hdr.hdr, true));
  check(() => assert.equal(hdr.bloomLevels, GRAPHICS_PROFILES[tier].bloomLevels));
}
check(() => assert.equal(resolveGraphicsProfile('low', desktop).hdr, false, 'low stays LDR'));
check(() => assert.equal(resolveGraphicsProfile('ultra', { ...desktop, maxAnisotropy: 4 }).anisotropy, 4));
check(() => assert.equal(resolveGraphicsProfile('low', { ...desktop, maxAnisotropy: 16 }).anisotropy, 4));

// --- rendererCapabilities --------------------------------------------------------
check(() => assert.deepEqual(rendererCapabilities(null), { maxSamples: 0, maxAnisotropy: 1, halfFloat: false }));
check(() => assert.deepEqual(rendererCapabilities({
  capabilities: { maxSamples: 8, getMaxAnisotropy: () => 16 },
  extensions: { has: name => name === 'EXT_color_buffer_float' },
}), { maxSamples: 8, maxAnisotropy: 16, halfFloat: true }));

// --- settings summary ------------------------------------------------------------
{
  const auto = graphicsSettingsSummary('auto', { touch: true });
  check(() => assert.equal(auto.tier, 'low'));
  check(() => assert.equal(auto.badge, '→ LOW'));
  check(() => assert.match(auto.help, /AUTO picks LOW on this device/));
  check(() => assert.match(auto.help, /next map loads/));
  const forced = graphicsSettingsSummary('ultra', { deviceMemory: 8 });
  check(() => assert.equal(forced.tier, 'ultra'));
  check(() => assert.equal(forced.autoTier, 'high'));
  check(() => assert.equal(forced.badge, ''));
  check(() => assert.match(forced.help, /^AUTO picks HIGH on this device\. ULTRA: 4× MSAA/));
  check(() => assert.match(describeGraphicsTier('low'), /^FXAA · no bloom/));
  check(() => assert.equal(describeGraphicsTier('nope'), ''));
  // What separates HIGH from ULTRA is named: shadow map size and SSAO.
  check(() => assert.match(describeGraphicsTier('high'), /sun shadows 2048px/));
  check(() => assert.doesNotMatch(describeGraphicsTier('high'), /ambient occlusion/));
  check(() => assert.match(describeGraphicsTier('ultra'), /sun shadows 4096px · ambient occlusion/));
  check(() => assert.match(describeGraphicsTier('medium'), /baked shadows only/));
  // Touch never multisamples, so the card must not promise MSAA there.
  check(() => assert.match(describeGraphicsTier('high', { touch: true }), /^FXAA · HDR bloom/));
  const touchHigh = graphicsSettingsSummary('high', { touch: true });
  check(() => assert.doesNotMatch(touchHigh.help, /MSAA ·/));
  check(() => assert.match(touchHigh.help, /MSAA is off on touch devices/));
  check(() => assert.match(forced.help, /MSAA and HDR switch off where the GPU lacks them/));
}

// --- CombatPostProcess with a mock renderer --------------------------------------
function mockRenderer({ throwOn = null } = {}) {
  const renderer = {
    autoClear: true,
    target: null,
    calls: [],
    info: { autoReset: true, reset() {} },
    setRenderTarget(target) { this.target = target; },
    render(scene, camera) {
      this.calls.push({ scene, camera, target: this.target });
      if (throwOn && throwOn(this)) throw new Error('mock GL failure');
    },
  };
  return renderer;
}
const scene = { isScene: true };
const camera = { isCamera: true, position: { x: 0, y: 0, z: 0 }, matrixWorldInverse: { elements: [] }, projectionMatrixInverse: { elements: [] }, matrixWorld: { elements: [] } };

{
  const renderer = mockRenderer();
  const post = new CombatPostProcess(renderer, { msaa: 4, hdr: false, bloomLevels: 5 });
  post.setSize(800, 600, 1);
  check(() => assert.equal(post.bloomLevels, 0, 'no bloom without HDR'));
  check(() => assert.equal(post.target.samples, 4));
  check(() => assert.equal(post.render(scene, camera, {}), true));
  check(() => assert.equal(renderer.calls.length, 2, 'scene + composite without bloom'));
  check(() => assert.equal(renderer.calls[0].target, post.target, 'scene always renders into the target'));
  check(() => assert.equal(renderer.calls[0].scene, scene));
  check(() => assert.equal(renderer.calls[1].target, null, 'composite reaches the canvas'));
  check(() => assert.equal(renderer.calls[1].scene, post.scene));
  check(() => assert.equal(renderer.target, null));
  check(() => assert.equal(post.stats.frames, 1));

  // Disabled grading (?shader=off) still renders through the target: same program keys.
  const off = mockRenderer();
  const bypass = new CombatPostProcess(off, { enabled: false });
  bypass.setSize(320, 240, 1);
  bypass.render(scene, camera, {});
  check(() => assert.equal(off.calls.length, 2));
  check(() => assert.equal(off.calls[0].target, bypass.target));
  check(() => assert.equal(bypass.uniforms.grading.value, 0));

  // HDR with bloom adds its passes (prefilter, downsample chain, upsample chain, adaptation).
  const hdrRenderer = mockRenderer();
  const hdr = new CombatPostProcess(hdrRenderer, { msaa: 4, hdr: true, bloomLevels: 5 });
  hdr.setSize(800, 600, 1);
  hdr.render(scene, camera, { time: 1 });
  check(() => assert.equal(hdrRenderer.calls.length, 2 + 2 + 1 + 4 + 4, 'scene, adaptation 2, bloom 9, composite'));
  check(() => assert.equal(hdrRenderer.autoClear, true, 'bloom restores autoClear'));
  hdr.dispose();
  post.dispose();
  bypass.dispose();
}

{
  // A pass that throws disables the chain for good and renders the scene directly.
  const renderer = mockRenderer({ throwOn: r => r.target === null && r.calls.at(-1).scene !== scene });
  const post = new CombatPostProcess(renderer, {});
  post.setSize(640, 480, 1);
  check(() => assert.equal(post.render(scene, camera, {}), false));
  check(() => assert.equal(post.failed, true));
  check(() => assert.equal(post.enabled, false));
  check(() => assert.equal(post.stats.fallbacks, 1));
  check(() => assert.match(post.stats.lastError, /mock GL failure/));
  const last = renderer.calls.at(-1);
  check(() => assert.equal(last.scene, scene, 'fallback renders the scene'));
  check(() => assert.equal(last.target, null, 'fallback renders to the canvas'));
  renderer.calls.length = 0;
  check(() => assert.equal(post.render(scene, camera, {}), false));
  check(() => assert.equal(renderer.calls.length, 1, 'later frames render directly once'));
  check(() => assert.equal(renderer.calls[0].target, null));
  post.dispose();

  // A shader compile error flagged from outside (renderer.debug.onShaderError) takes the same path.
  const flagged = mockRenderer();
  const chain = new CombatPostProcess(flagged, {});
  chain.failed = true;
  chain.render(scene, camera, {});
  check(() => assert.deepEqual(flagged.calls.map(c => [c.scene === scene, c.target]), [[true, null]]));
  chain.dispose();
}

{
  const post = new CombatPostProcess(mockRenderer(), {});
  const clamped = post.setGrade({ exposure: 5, saturation: 0.1, contrast: 9, shadowTint: [1, 2], highlightTint: [0.1, NaN, 0] });
  check(() => assert.equal(clamped.exposure, 2));
  check(() => assert.equal(clamped.saturation, 0.5));
  check(() => assert.equal(clamped.contrast, 1.4));
  check(() => assert.deepEqual(clamped.shadowTint, DEFAULT_GRADE.shadowTint, 'short tint keeps default'));
  check(() => assert.deepEqual(clamped.highlightTint, DEFAULT_GRADE.highlightTint, 'NaN tint keeps default'));
  check(() => assert.equal(post.uniforms.exposure.value, 2));
  check(() => assert.equal(post.uniforms.gradeContrast.value, 1.4));
  const low = post.setGrade({ exposure: 0.1, contrast: 0.2, saturation: 3, shadowTint: [0.01, 0.02, 0.03] });
  check(() => assert.equal(low.exposure, 0.5));
  check(() => assert.equal(low.contrast, 0.7));
  check(() => assert.equal(low.saturation, 1.5));
  check(() => assert.deepEqual(post.uniforms.shadowTint.value.toArray(), [0.01, 0.02, 0.03]));
  check(() => assert.deepEqual(post.setGrade(null), { ...DEFAULT_GRADE }));
  post.dispose();
}

// --- warmupPasses covers every full-screen material of the chain -------------------
function shaderMaterialsOf(post) {
  const found = new Set();
  const walk = (value, depth) => {
    if (!value || typeof value !== 'object' || depth > 3) return;
    if (value.isShaderMaterial) { found.add(value); return; }
    if (value.isWebGLRenderTarget || value.isTexture || value.isObject3D || value === post.renderer) return;
    for (const child of Array.isArray(value) ? value : Object.values(value)) walk(child, depth + 1);
  };
  for (const [key, value] of Object.entries(post)) if (key !== 'renderer' && key !== 'uniforms') walk(value, 0);
  return found;
}
for (const options of [{}, { hdr: true, bloomLevels: 5 }, { hdr: true, bloomLevels: 1, ssao: true }, { hdr: true, bloomLevels: 5, ssao: true, msaa: 4 }]) {
  const post = new CombatPostProcess(mockRenderer(), options);
  const passes = post.warmupPasses();
  const listed = new Set(passes.map(p => p.material));
  const tag = JSON.stringify(options);
  for (const material of shaderMaterialsOf(post)) {
    check(() => assert.ok(listed.has(material), `${tag}: ${material.name} is warmed`));
  }
  check(() => assert.equal(passes.at(-1).material, post.material, `${tag}: composite last`));
  check(() => assert.equal(passes.at(-1).target, null, `${tag}: composite onto the canvas`));
  for (const pass of passes.slice(0, -1)) {
    check(() => assert.ok(pass.target?.isWebGLRenderTarget, `${tag}: ${pass.material.name} compiles against its target`));
  }
  // Guards the walk itself: composite + adaptation 2 + bloom 3 + SSAO 2 when all are on.
  const expected = 1 + (post.adaptation ? 2 : 0) + (post.bloomMaterials ? 3 : 0) + (post.occlusion ? 2 : 0);
  check(() => assert.equal(shaderMaterialsOf(post).size, expected, `${tag}: material walk finds every pass`));
  if (options.ssao) {
    check(() => assert.ok(listed.has(post.occlusion.pass) && listed.has(post.occlusion.blur), `${tag}: SSAO passes`));
  }
  post.dispose();
}

// --- warmShaders with a mock renderer ------------------------------------------------
function warmupRenderer({ never = false, programs = 3 } = {}) {
  const renderer = {
    target: null,
    compiles: [],
    info: { programs: [] },
    setRenderTarget(target) { this.target = target; },
    compileAsync(root, cam, targetScene = null) {
      const materials = [];
      root.traverse?.(o => { if (o.material) materials.push(o.material); });
      this.compiles.push({ root, targetScene, target: this.target, keys: materials.map(m => m.customProgramCacheKey()),
        screenMaterial: root.children?.[0]?.material });
      return never ? new Promise(() => {}) : Promise.resolve(root);
    },
  };
  for (let i = 0; i < programs; i++) {
    renderer.info.programs.push({ touched: 0, getUniforms() { this.touched++; return {}; } });
  }
  return renderer;
}
{
  const renderer = warmupRenderer();
  const post = new CombatPostProcess(mockRenderer(), { hdr: true, bloomLevels: 5, ssao: true, msaa: 4 });
  const worldScene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera();
  worldScene.add(cam);
  const rig = new THREE.Group();
  const gun = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ name: 'probe-gun' }));
  gun.visible = false; // hidden gear is compiled by compile() and must carry the patch too
  rig.add(gun);
  cam.add(rig);
  const detached = new THREE.Group();
  detached.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshLambertMaterial({ name: 'probe-avatar' })));
  const result = await warmShaders({ renderer, scene: worldScene, camera: cam, post, characterRoots: [rig, detached] });
  check(() => assert.equal(result.skipped, false));
  check(() => assert.equal(result.timedOut, false));
  check(() => assert.equal(result.failed, false));
  check(() => assert.equal(result.patched, 2, 'both character materials patched'));
  check(() => assert.equal(gun.material.customProgramCacheKey(), CHARACTER_LIGHT_KEY, 'character-light cache key pinned'));
  const [sceneCompile, detachedCompile, ...passCompiles] = renderer.compiles;
  check(() => assert.equal(sceneCompile.root, worldScene));
  check(() => assert.equal(sceneCompile.target, post.target, 'scene compiles with the post target bound'));
  check(() => assert.deepEqual(sceneCompile.keys, [CHARACTER_LIGHT_KEY], 'patched before the scene compiles'));
  check(() => assert.equal(detachedCompile.root, detached, 'roots outside the scene compile too'));
  check(() => assert.equal(detachedCompile.targetScene, worldScene, '...with the scene lights'));
  const passes = post.warmupPasses();
  check(() => assert.equal(passCompiles.length, passes.length));
  passes.forEach((pass, i) => {
    check(() => assert.equal(passCompiles[i].root, post.scene));
    check(() => assert.equal(passCompiles[i].screenMaterial, pass.material, `${pass.material.name} on the screen quad`));
    check(() => assert.equal(passCompiles[i].target, pass.target, `${pass.material.name} against its own target`));
  });
  check(() => assert.equal(post.screen.material, post.material, 'composite restored'));
  check(() => assert.equal(renderer.target, null, 'canvas bound again'));
  check(() => assert.ok(renderer.info.programs.every(p => p.touched === 1), 'every program link-checked once'));
  check(() => assert.equal(result.linked, 3));
  check(() => assert.equal(result.programs, 3));
  post.dispose();

  // Budget: a compile that never finishes releases the loading screen and skips the blocking link check.
  const slow = warmupRenderer({ never: true });
  const late = await warmShaders({ renderer: slow, scene: new THREE.Scene(), camera: cam, budgetMs: 20 });
  check(() => assert.equal(late.timedOut, true));
  check(() => assert.ok(slow.info.programs.every(p => p.touched === 0)));

  // A failed post chain is not warmed; the scene compiles for the canvas.
  const direct = warmupRenderer();
  const broken = new CombatPostProcess(mockRenderer(), {});
  broken.failed = true;
  await warmShaders({ renderer: direct, scene: new THREE.Scene(), camera: cam, post: broken });
  check(() => assert.equal(direct.compiles.length, 1));
  check(() => assert.equal(direct.compiles[0].target, null));
  broken.dispose();

  const skipped = await warmShaders({ renderer: { setRenderTarget() {} }, scene: worldScene, camera: cam });
  check(() => assert.equal(skipped.skipped, true));
}

// --- ShaderErrorMonitor --------------------------------------------------------------
{
  const gl = {
    COMPILE_STATUS: 1, VALIDATE_STATUS: 2,
    getShaderSource: () => '#define SHADER_TYPE ShaderMaterial\n#define SHADER_NAME from-source\nvoid main(){}',
    getShaderInfoLog: (shader) => (shader === 'fs' ? 'ERROR: 0:3: undeclared identifier' : ''),
    getShaderParameter: (shader) => shader !== 'fs',
    getProgramParameter: () => false,
    getProgramInfoLog: () => 'link failed',
    getError: () => 0,
  };
  const props = new Map();
  const properties = { has: m => props.has(m), get: m => props.get(m) };
  const program = (name, type, cacheKey) => ({ program: { id: name + type }, name, type, cacheKey });
  const programs = {
    bloom: program('combat-bloom-up', 'ShaderMaterial', 'bloom'),
    terrain: program('terrain-opaque', 'MeshLambertMaterial', 'lambert,terrain'),
    character: program('', 'MeshStandardMaterial', `physical,${CHARACTER_LIGHT_KEY}`),
    lambert: program('', 'MeshLambertMaterial', 'lambert,other'),
  };
  const renderer = { debug: {}, properties, info: { programs: Object.values(programs) } };
  const post = new CombatPostProcess(mockRenderer(), {});
  const world = new THREE.Scene();
  const terrain = new THREE.MeshLambertMaterial({ name: 'terrain-opaque' });
  terrain.onBeforeCompile = () => {};
  terrain.customProgramCacheKey = () => 'terrain';
  const otherPatched = new THREE.MeshLambertMaterial({ name: 'props' });
  otherPatched.onBeforeCompile = () => {};
  world.add(new THREE.Mesh(new THREE.BoxGeometry(), terrain), new THREE.Mesh(new THREE.BoxGeometry(), [otherPatched, terrain]));
  props.set(terrain, { currentProgram: programs.terrain });
  props.set(otherPatched, { currentProgram: programs.lambert });
  const monitor = new ShaderErrorMonitor({ renderer, getPost: () => post, getRoots: () => [world] }).install();
  check(() => assert.equal(typeof renderer.debug.onShaderError, 'function', 'replaces three report'));

  const logged = [];
  const { error, warn } = console;
  console.error = (...args) => logged.push(['error', String(args[0])]);
  console.warn = (...args) => logged.push(['warn', String(args[0])]);
  try {
    renderer.debug.onShaderError(gl, programs.bloom.program, 'vs', 'fs');
    check(() => assert.equal(post.failed, true, 'broken post pass fails the chain open'));
    check(() => assert.equal(post.enabled, false));
    check(() => assert.equal(post.stats.fallbacks, 1));
    check(() => assert.match(post.stats.lastError, /combat-bloom-up/));
    check(() => assert.match(logged[0][1], /Material Name: combat-bloom-up\nMaterial Type: ShaderMaterial/));
    check(() => assert.match(logged[0][1], /> 3: void main/));
    check(() => assert.equal(logged.filter(l => l[0] === 'warn').length, 1));

    const version = terrain.version;
    renderer.debug.onShaderError(gl, programs.terrain.program, 'vs', 'fs');
    check(() => assert.equal(Object.hasOwn(terrain, 'onBeforeCompile'), false, 'terrain patch stripped'));
    check(() => assert.equal(Object.hasOwn(terrain, 'customProgramCacheKey'), false));
    check(() => assert.equal(terrain.version, version + 1, 'recompiles as stock Lambert'));
    check(() => assert.equal(Object.hasOwn(otherPatched, 'onBeforeCompile'), true, 'other programs keep their patch'));
    check(() => assert.equal(monitor.stripped, 1, 'shared material stripped once'));

    renderer.debug.onShaderError(gl, programs.character.program, 'vs', 'fs');
    check(() => assert.equal(patchCharacterMaterial(new THREE.MeshStandardMaterial()), false, 'character patch switched off'));
    renderer.debug.onShaderError(gl, programs.lambert.program, 'vs', 'fs');
    renderer.debug.onShaderError(gl, programs.lambert.program, 'vs', 'fs');
    // Unknown program: identified from the shader source.
    renderer.debug.onShaderError(gl, { id: 'orphan' }, 'vs', 'fs');
    check(() => assert.deepEqual(monitor.errors, [
      'combat-bloom-up (ShaderMaterial)', 'terrain-opaque (MeshLambertMaterial)',
      'unnamed (MeshStandardMaterial)', 'unnamed (MeshLambertMaterial)', 'from-source (ShaderMaterial)',
    ], 'unnamed failures stay distinct, repeats are recorded once'));
    check(() => assert.equal(post.stats.fallbacks, 1, 'non-post failures leave the chain alone'));
  } finally {
    console.error = error;
    console.warn = warn;
    setCharacterLightEnabled(true);
    post.dispose();
  }
}

console.log(`graphics-quality-test: ${checks} checks passed`);
