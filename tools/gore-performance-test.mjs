import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import * as THREE from '../public/js/vendor/three.module.js';
import { GoreFX } from '../public/js/weapons/gore.js';
import { MC_WATER, MC_PORTAL, MC_GHOST_STONE } from '../shared/world/blocks.js';

const camera = new THREE.PerspectiveCamera();
const matrix = new THREE.Matrix4();
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-5,
  `expected ${expected}, got ${actual}`);
const originalRandom = Math.random;
Math.random = () => 0.5;
try {
  const scene = new THREE.Scene();
  const fx = new GoreFX(scene, camera, () => 0);
  const versions = () => fx.goreMeshes.map(mesh => mesh.instanceMatrix.version);
  const idle = versions();
  let directionReads = 0;
  const originalDirection = camera.getWorldDirection;
  camera.getWorldDirection = function (out) { directionReads++; return originalDirection.call(this, out); };
  for (let i = 0; i < 120; i++) fx.update(1 / 60);
  assert.deepEqual(versions(), idle);
  assert.equal(directionReads, 0, 'empty veil performs no camera matrix work');
  assert.ok(fx.goreMeshes.every(mesh => !mesh.visible && mesh.count === 0), 'empty gore submits no draws');

  // The plateau is deliberately stationary. Upload exactly at spawn, fade and expiry.
  fx.spawnBloodStain(1, 2, 3, 0, 1, 0, 0.4);
  const stain = fx.goreStains[0];
  fx.goreStainMesh.getMatrixAt(0, matrix);
  const startMatrix = matrix.elements.slice();
  const spawnedVersion = fx.goreStainMesh.instanceMatrix.version;
  for (let i = 0; i < 600; i++) fx.update(1 / 60);
  assert.equal(fx.goreStainMesh.instanceMatrix.version, spawnedVersion, 'ten-second plateau reuses its existing GPU buffer');
  fx.goreStainMesh.getMatrixAt(0, matrix);
  assert.deepEqual(matrix.elements, startMatrix, 'plateau retains the exact spawn transform');
  fx.update(2.5);
  const fade = Math.min(1, (1 - stain.t / stain.life) * 4);
  assert.ok(fade < 1);
  fx.goreStainMesh.getMatrixAt(0, matrix);
  near(new THREE.Vector3().setFromMatrixScale(matrix).x, stain.size * 1.35 * fade);
  assert.ok(fx.goreStainMesh.instanceMatrix.version > spawnedVersion, 'the original fade still animates');
  fx.update(10);
  assert.equal(fx.goreStainMesh.count, 0);

  fx.spawnBloodStain(0, 1, 0, 0, 1, 0, 0.2);
  fx.spawnBloodStain(1, 1, 0, 0, 1, 0, 0.2);
  fx.spawnBloodStain(2, 1, 0, 0, 1, 0, 0.2);
  const records = fx.goreStains.slice();
  fx.goreStains[0].life = 0.01;
  fx.goreStains[2].life = 0.01;
  fx.update(0.02);
  assert.equal(fx.goreStainMesh.count, 2, 'an expired tail shrinks the draw range');
  assert.ok(fx.goreStains.every((p, i) => p === records[i]), 'slots and transparent ordering remain stable');
  const beforeReuse = fx.goreStainMesh.instanceMatrix.version;
  fx.spawnBloodStain(99, 1, 0, 0, 1, 0, 0.2);
  assert.equal(fx.goreStains[0].x, 99, 'the first free slot is reused');
  assert.ok(fx.goreStainMesh.instanceMatrix.version > beforeReuse, 'replacement emission publishes its transform before update');
  fx.update(30);

  for (let i = 0; i < fx.goreStains.length; i++) fx.spawnBloodStain(i, 1, 0, 0, 1, 0, 0.2);
  fx.goreStains[123].t = fx.goreStains[123].life * 0.9;
  fx.spawnBloodStain(999, 1, 0, 0, 1, 0, 0.2);
  assert.equal(fx.goreStains[123].x, 999, 'overflow retains the most-expired overwrite policy');
  assert.equal(fx.goreStainMesh.count, fx.goreStains.length);
  fx.update(30);

  fx.spawnChunks(0, 2, 0, { chunkCount: 1, chunkSpeed: 0, chunkScale: 1 });
  const chunk = fx.goreChunks[0];
  chunk.settled = true; chunk.life = 10; chunk.squash = 0;
  fx.update(0);
  const settledVersion = fx.goreChunkMesh.instanceMatrix.version;
  for (let i = 0; i < 300; i++) fx.update(1 / 60);
  assert.equal(fx.goreChunkMesh.instanceMatrix.version, settledVersion, 'settled fragments stop uploading until their fade');
  fx.update(4.6);
  assert.ok(fx.goreChunkMesh.instanceMatrix.version > settledVersion);
  fx.update(1);
  assert.equal(fx.goreChunkMesh.count, 0);

  // Repeated kills retain a fixed palette and release all five bounded pools.
  const palette = fx.goreChunkMesh.instanceColor.array.slice();
  for (let i = 0; i < 40; i++) fx.gore({ vx: 0, vy: 2, vz: 0, hs: true, overkill: 200 }, { lethal: true, local: true });
  assert.deepEqual(fx.goreChunkMesh.instanceColor.array, palette);
  assert.ok(fx.goreMeshes.every(mesh => mesh.count <= mesh.instanceMatrix.count));
  fx.update(1 / 60);
  assert.ok(directionReads > 0, 'a populated veil still follows the camera');
  for (let i = 0; i < 400; i++) fx.update(0.1);
  assert.ok(fx.goreMeshes.every(mesh => !mesh.visible && mesh.count === 0));
  const drained = versions();
  for (let i = 0; i < 120; i++) fx.update(1 / 60);
  assert.deepEqual(versions(), drained);
  const disposed = fx.goreMeshes.map(mesh => {
    const counts = [0, 0, 0];
    [mesh, mesh.geometry, mesh.material].forEach((resource, i) => resource.addEventListener('dispose', () => counts[i]++));
    return counts;
  });
  fx.dispose(); fx.dispose();
  fx.gore({ vx: 0, vy: 2, vz: 0 }, { lethal: true });
  fx.spawnBloodStain(0, 1, 0, 0, 1, 0, 0.2);
  fx.spawnChunks(0, 1, 0, { chunkCount: 1 });
  fx.update(1);
  assert.deepEqual(versions(), drained, 'late emission cannot write released GPU buffers');
  assert.ok(disposed.every(counts => counts.every(count => count === 1)));
  assert.equal(scene.children.length, 0);

  for (const type of [MC_WATER, MC_PORTAL, MC_GHOST_STONE]) {
    const passable = new GoreFX(new THREE.Scene(), null, x => x === 2 ? type : 0);
    passable.gore({ vx: 0.5, vy: 2, vz: 0.5 });
    for (const p of passable.goreDroplets) p.active = false;
    const p = passable.goreDroplets[0];
    Object.assign(p, { active: true, life: 2, t: 0, vx: 100, vy: 0, vz: 0 });
    passable.update(0.05);
    assert.ok(p.active && p.x > 2, 'droplets pass through fluid, portal and ghost voxels');
    assert.equal(passable.goreStains.some(p => p.active), false, 'passable cells do not receive wall stains');
    passable.dispose();
  }

  if (process.argv.includes('--bench')) {
    const full = new GoreFX(new THREE.Scene(), null, () => 0);
    for (let i = 0; i < full.goreStains.length; i++) full.spawnBloodStain(i, 1, 0, 0, 1, 0, 0.2);
    const forceStationaryTransforms = () => {
      for (let i = 0; i < full.goreStainMesh.count; i++) {
        const stain = full.goreStains[i];
        const fade = Math.min(1, (1 - stain.t / stain.life) * 4);
        full._q.set(stain.qx, stain.qy, stain.qz, stain.qw);
        full._m4.compose(full._v.set(stain.x, stain.y, stain.z), full._q,
          full._s.set(stain.size * 1.35 * fade, stain.size * 0.78 * fade, 1));
        full.goreStainMesh.setMatrixAt(i, full._m4);
      }
      full.goreStainMesh.instanceMatrix.needsUpdate = true;
    };
    const run = (fn) => { const start = performance.now(); for (let i = 0; i < 5000; i++) fn(); return performance.now() - start; };
    for (let i = 0; i < 500; i++) { full.update(0); forceStationaryTransforms(); }
    const staticMs = run(() => full.update(0));
    const forcedTransformsMs = run(() => { full.update(0); forceStationaryTransforms(); });
    console.log(JSON.stringify({ frames: 5000, stains: full.goreStains.length, staticMs, forcedTransformsMs,
      note: 'Node stationary-stain microbenchmark, not browser FPS' }));
    full.dispose();
  }
} finally {
  Math.random = originalRandom;
}

console.log('ok - bounded gore draws/scans, unchanged stains/settled chunks, stable slots/palette, overflow, passable collisions and late-event disposal');

if (process.argv.includes('--browser')) {
  const { launchCdpSession } = await import('./lib/cdp-session.mjs');
  const { startServer, stopServer, waitForHttp } = await import('./lib/server-process.mjs');
  const server = startServer();
  let browser;
  try {
    const port = await server.port;
    await waitForHttp(port);
    browser = await launchCdpSession(`http://127.0.0.1:${port}/js/vendor/three.module.js`);
    const result = await browser.page.evaluate(`(async () => {
      const THREE = await import('/js/vendor/three.module.js');
      const { GoreFX } = await import('/js/weapons/gore.js');
      const renderer = new THREE.WebGLRenderer({ antialias: true });
      renderer.setSize(640, 480);
      document.body.replaceChildren(renderer.domElement);
      const scene = new THREE.Scene();
      scene.add(new THREE.HemisphereLight(0xffffff, 0x888888, 3));
      const camera = new THREE.PerspectiveCamera(45, 640 / 480, 0.01, 30);
      camera.position.set(0, 2, 5); camera.lookAt(0, 2, 0);
      const fx = new GoreFX(scene, camera, () => 0);
      const gl = renderer.getContext();
      const pixels = () => {
        const data = new Uint8Array(640 * 480 * 4);
        gl.readPixels(0, 0, 640, 480, gl.RGBA, gl.UNSIGNED_BYTE, data);
        return data;
      };
      const differences = (a, b) => { let n = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++; return n; };
      renderer.render(scene, camera);
      const idleCalls = renderer.info.render.calls;
      fx.gore({ vx: 0, vy: 2, vz: 0, normal: [0, 0, 1], overkill: 0 }, { lethal: true, local: true });
      fx.update(1 / 60);
      renderer.render(scene, camera);
      const hit = { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles };
      const hitPixels = pixels();
      let litPixels = 0;
      for (let i = 0; i < hitPixels.length; i += 4) if (hitPixels[i] || hitPixels[i + 1] || hitPixels[i + 2]) litPixels++;
      const expectedTriangles = fx.goreMeshes.reduce((sum, mesh) =>
        sum + mesh.count * (mesh.geometry.index?.count ?? mesh.geometry.attributes.position.count) / 3, 0);
      const counts = fx.goreMeshes.map(mesh => mesh.count);
      fx.goreMeshes.forEach(mesh => { mesh.count = mesh.instanceMatrix.count; });
      renderer.render(scene, camera);
      const capacityTriangles = renderer.info.render.triangles;
      const capacityPixelDifferences = differences(hitPixels, pixels());
      fx.goreMeshes.forEach((mesh, i) => { mesh.count = counts[i]; });
      fx.update(40);
      renderer.render(scene, camera);
      const drainedCalls = renderer.info.render.calls;
      fx.spawnBloodStain(0, 2, 0, 0, 0, 1, 0.5);
      renderer.render(scene, camera);
      const stainPixels = pixels();
      const stainVersion = fx.goreStainMesh.instanceMatrix.version;
      fx.update(8);
      renderer.render(scene, camera);
      const plateauPixelDifferences = differences(stainPixels, pixels());
      const plateauUpload = fx.goreStainMesh.instanceMatrix.version - stainVersion;
      const stain = fx.goreStains[0];
      fx.update(stain.life * 0.8 - stain.t);
      renderer.render(scene, camera);
      const fadePixelDifferences = differences(stainPixels, pixels());
      fx.dispose();
      renderer.render(scene, camera);
      const geometries = renderer.info.memory.geometries;
      const error = gl.getError();
      renderer.dispose();
      return { idleCalls, hit, expectedTriangles, litPixels, capacityTriangles, capacityPixelDifferences,
        drainedCalls, plateauPixelDifferences, plateauUpload, fadePixelDifferences, geometries, error };
    })()`);
    assert.equal(result.idleCalls, 0);
    assert.equal(result.hit.calls, 5, 'all populated gore layers retain one draw each');
    assert.equal(result.hit.triangles, result.expectedTriangles);
    assert.equal(result.capacityTriangles, 41104, 'fixed-capacity ranges retain the former geometry budget');
    assert.equal(result.capacityPixelDifferences, 0, 'bounded draws preserve every pixel, palette and transparent-layer order');
    assert.ok(result.litPixels > 100);
    assert.equal(result.drainedCalls, 0);
    assert.equal(result.plateauPixelDifferences, 0, 'stationary stain caching preserves its exact pixels');
    assert.equal(result.plateauUpload, 0, 'stationary stains stop publishing transform uploads');
    assert.ok(result.fadePixelDifferences > 0, 'the stain still visibly fades at the original lifetime boundary');
    assert.equal(result.geometries, 0);
    assert.equal(result.error, 0);
    console.log('Gore WebGL:', JSON.stringify(result));
  } finally {
    await browser?.close();
    await stopServer(server);
  }
}
