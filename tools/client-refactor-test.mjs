import assert from 'node:assert/strict';
import * as THREE from '../public/js/vendor/three.module.js';
import { BrassPool } from '../public/js/weapons/brass.js';
import { Effects } from '../public/js/weapons/effects.js';
import { WeaponState } from '../public/js/guns/weapon-state.js';
import { ViewmodelRig } from '../public/js/guns/viewmodel.js';
import { WEAPON_IDS } from '../shared/combatmath.js';
import { disposeObjectTrees } from '../public/js/engine/dispose.js';

{
  let now = 0;
  const rig = new ViewmodelRig(new THREE.PerspectiveCamera());
  const state = new WeaponState({ rig, now: () => now,
    audio: { draw() {}, fire() {}, reloadClick() {} },
    effects: { shoot() {} }, feedback: { addExhaustion() {}, addRecoil() {} },
    setTimer: () => 0, clearTimer() {}, random: () => 0.5,
    network: { isCurrentGeneration: () => true, isRunning: () => true } });
  try {
    state.resetToLoadout();
    state.forceWeapon(WEAPON_IDS.indexOf('flamethrower'), { now });
    for (let frame = 0; frame < 240; frame++) rig.update(1 / 120);
    const context = { allowFire: true, alive: true };
    now = 2000;
    state.applyIntents({ fireHeld: true }, now, context);
    assert.equal(state.tryFire(now, context), true);
    now += 250; // GPU work or another task can delay presentation within this frame.
    assert.equal(state.flameFiring, true, 'render cost does not change an accepted frame decision');
    const originalFire = rig.fire;
    rig.fire = () => false;
    state.tryFire(now, context);
    assert.equal(state.flameFiring, false, 'next fire update expires an emitter without accepted shots');
    rig.fire = originalFire;
    now += 50;
    assert.equal(state.tryFire(now, context), true);
    assert.equal(state.flameFiring, true);
    state.applyIntents({ fireHeld: false }, now, context);
    assert.equal(state.flameFiring, false, 'release cancels the stream immediately');
  } finally { state.dispose(); rig.dispose(); }
}

const matrix = new THREE.Matrix4();
const position = new THREE.Vector3();
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-6,
  `expected ${expected}, got ${actual}`);
const disposals = resource => {
  const events = { count: 0 };
  resource.addEventListener('dispose', () => events.count++);
  return events;
};

{
  const scene = new THREE.Scene();
  const brass = new BrassPool(scene, () => 0);
  const disposed = [brass.mesh, brass.mesh.geometry, brass.mesh.material].map(disposals);
  const idleVersion = brass.mesh.instanceMatrix.version;
  brass.update(1 / 60);
  assert.equal(brass.mesh.instanceMatrix.version, idleVersion, 'empty brass does not upload transforms');
  assert.equal(brass.mesh.visible, false);
  brass.spawn([1, 1, 2], new THREE.Vector3(2, 0, -1));
  brass.update(0.1);
  brass.mesh.getMatrixAt(0, matrix);
  position.setFromMatrixPosition(matrix);
  near(position.x, 1.2); near(position.y, 0.82); near(position.z, 1.9);
  assert.equal(brass.mesh.visible, true);
  brass.update(3.5);
  assert.equal(brass.mesh.visible, false, 'expired shells submit no draw call');
  brass.mesh.getMatrixAt(0, matrix);
  assert.equal(matrix.elements[0], 0, 'expired instance is hidden when other shells remain visible');
  brass.reset();
  for (let i = 0; i < 32; i++) brass.spawn([i, 3, 0], [0, 0, 0]);
  brass.spawn([99, 3, 0], [0, 0, 0]);
  brass.mesh.getMatrixAt(31, matrix);
  near(matrix.elements[12], 99);
  assert.equal(brass.shells.filter(shell => shell.active).length, 32,
    'overflow replaces the last tied oldest slot and keeps the pool bounded');
  brass.reset();
  brass.spawn(new THREE.Vector3(12, 3, 0), [0, 0, 0]);
  assert.equal(brass.shells.filter(shell => shell.active).length, 1);
  brass.dispose(); brass.dispose();
  assert.equal(scene.children.length, 0);
  assert.ok(disposed.every(events => events.count === 1), 'instance buffer, geometry and material dispose once');
}
{
  const brass = new BrassPool(new THREE.Scene(), (_x, y) => y < 0 ? 1 : 0);
  brass.spawn([1, 0.05, 2], [0, -1, 0]);
  brass.update(0.1);
  brass.mesh.getMatrixAt(0, matrix);
  near(matrix.elements[13], 0.03);
  assert.equal(brass.shells[0].vel.lengthSq(), 0, 'collision settles velocity');
  assert.equal(brass.shells[0].spin.lengthSq(), 0, 'collision settles rotation');
  brass.dispose();
}

// The only browser surface needed to construct remote muzzle sprites is Canvas2D.
const previousDocument = globalThis.document;
const context = new Proxy({ createRadialGradient: () => ({ addColorStop() {} }) },
  { get: (target, key) => target[key] ?? (() => {}) });
globalThis.document = { createElement: () => ({ getContext: () => context }) };
try {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  const fx = new Effects(scene, camera, () => 0);
  const meshes = [fx.tracers.tracerMesh, fx.impacts.partMesh,
    ...fx.impacts.impactMeshes, ...fx.goreFx.goreMeshes];
  const attributes = meshes.flatMap(mesh => [mesh.instanceMatrix, mesh.instanceColor].filter(Boolean));
  const initialVersions = attributes.map(attribute => attribute.version);
  for (let frame = 0; frame < 120; frame++) fx.update(1 / 60);
  assert.deepEqual(attributes.map(attribute => attribute.version), initialVersions,
    'empty tracer, impact and gore pools upload no GPU attributes');
  fx.shoot({ w: 'rifle', o: [0, 2, 0], d: [0, 0, -1] }, { local: true });
  fx.impact({ vx: 0, vy: 2, vz: -2, hs: true });
  fx.gore({ vx: 0, vy: 2, vz: -2, hs: true }, { local: true, lethal: true });
  fx.goreFx.spawnBloodStain(0, 0, -2, 0, 1, 0, 0.4);
  const spawnedVersions = meshes.map(mesh => mesh.instanceMatrix.version);
  fx.update(1 / 60);
  assert.ok(meshes.every((mesh, i) => mesh.instanceMatrix.version > spawnedVersions[i]),
    'every populated effect still uploads animated transforms');
  fx.update(60);
  const expiredVersions = attributes.map(attribute => attribute.version);
  for (let frame = 0; frame < 120; frame++) fx.update(1 / 60);
  assert.deepEqual(attributes.map(attribute => attribute.version), expiredVersions,
    'expiry uploads hidden transforms once and returns to zero idle uploads');
  const meshDisposals = meshes.map(disposals);
  fx.dispose(); fx.dispose();
  assert.equal(scene.children.length, 0, 'all effect resources leave the scene');
  assert.ok(meshDisposals.every(events => events.count === 1), 'all instanced effects release GPU buffers once');
} finally {
  if (previousDocument === undefined) delete globalThis.document;
  else globalThis.document = previousDocument;
}


{
  const geometry = new THREE.BoxGeometry();
  const colorMap = new THREE.Texture();
  const normalMap = new THREE.Texture();
  const uniformMap = new THREE.Texture();
  const cached = new THREE.MeshStandardMaterial({ map: colorMap, normalMap });
  const shader = new THREE.ShaderMaterial({ uniforms: {
    one: { value: uniformMap }, many: { value: [uniformMap, colorMap] },
  } });
  const roots = [new THREE.Group(), new THREE.Group()];
  roots[0].add(new THREE.Mesh(geometry, [cached, shader]));
  roots[1].add(new THREE.Mesh(geometry, cached));
  const freed = [geometry, colorMap, normalMap, uniformMap, shader].map(disposals);
  const retained = disposals(cached);
  disposeObjectTrees(roots, { excludedMaterials: new Set([cached]) });
  assert.ok(freed.every(events => events.count === 1), 'shared geometries and direct/uniform textures release once across roots');
  assert.equal(retained.count, 0, 'cache-owned materials remain with their owner');
  cached.dispose();
}
console.log('Client refactor: one brass batch, flight/collision/reuse, zero idle FX uploads and GPU/resource cleanup passed.');

if (process.argv.includes('--browser')) {
  const { launchCdpSession } = await import('./lib/cdp-session.mjs');
  const { startServer, stopServer, waitForHttp } = await import('./lib/server-process.mjs');
  const server = startServer({ cwd: new URL('..', import.meta.url).pathname });
  let browser;
  try {
    const port = await server.port;
    await waitForHttp(port);
    // A plain module document gives this renderer an origin without starting the game.
    browser = await launchCdpSession(`http://127.0.0.1:${port}/js/vendor/three.module.js`);
    const result = await browser.page.evaluate(`(async () => {
      const THREE = await import('/js/vendor/three.module.js');
      const { BrassPool } = await import('/js/weapons/brass.js');
      const renderer = new THREE.WebGLRenderer({ antialias: true });
      renderer.setSize(640, 480);
      document.body.replaceChildren(renderer.domElement);
      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(28, 640 / 480, 0.01, 10);
      camera.position.z = 1;
      scene.add(new THREE.HemisphereLight(0xffffff, 0x555555, 3));
      const light = new THREE.DirectionalLight(0xffffff, 3);
      light.position.set(0, 0, 2);
      scene.add(light);
      const brass = new BrassPool(scene, () => 0);
      for (let i = 0; i < 32; i++) {
        brass.spawn([(i % 8 - 3.5) * 0.09, (Math.floor(i / 8) - 1.5) * 0.09, 0], [0, 0, 0]);
      }
      renderer.render(scene, camera);
      const populated = { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles };
      const pixels = new Uint8Array(640 * 480 * 4);
      const gl = renderer.getContext();
      gl.readPixels(0, 0, 640, 480, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      let litPixels = 0;
      for (let i = 0; i < pixels.length; i += 4) if (pixels[i] > 80 && pixels[i + 1] > 40) litPixels++;
      brass.reset();
      renderer.render(scene, camera);
      const emptyCalls = renderer.info.render.calls;
      brass.dispose();
      renderer.render(scene, camera);
      const geometries = renderer.info.memory.geometries;
      const error = gl.getError();
      renderer.dispose();
      return { populated, litPixels, emptyCalls, geometries, error };
    })()`);
    assert.equal(result.populated.calls, 1, 'WebGL submits the complete brass pool in one draw call');
    assert.equal(result.populated.triangles, 32 * 12, 'all shell geometry reaches the GPU');
    assert.ok(result.litPixels > 1000, 'shells produce visible pixels');
    assert.equal(result.emptyCalls, 0, 'empty brass pool submits no draw calls');
    assert.equal(result.geometries, 0, 'renderer releases disposed shell geometry');
    assert.equal(result.error, 0, 'brass shaders and instance buffers produce no WebGL errors');
    console.log('Client WebGL refactor:', JSON.stringify(result));
  } finally {
    await browser?.close();
    await stopServer(server);
  }
}
