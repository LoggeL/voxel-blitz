import assert from 'node:assert/strict';
import * as THREE from '../public/js/vendor/three.module.js';
import { ImpactFX } from '../public/js/weapons/impacts.js';
import { AIR, MC_WATER, MC_PORTAL, MC_GHOST_STONE } from '../shared/world/blocks.js';

const camera = new THREE.PerspectiveCamera();
const matrix = new THREE.Matrix4();
const color = new THREE.Color();
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-5,
  `expected ${expected}, got ${actual}`);
const particle = { speed: 0, gravity: 0, size: 1, life: 1 };
const activePrefix = (pool, count) => {
  assert.ok(pool.slice(0, count).every(slot => slot.active));
  assert.ok(pool.slice(count).every(slot => !slot.active));
};

const originalRandom = Math.random;
Math.random = () => 0.5;
try {
  const scene = new THREE.Scene();
  const fx = new ImpactFX(scene, camera, () => AIR);
  const meshes = [fx.partMesh, fx.starMesh, ...fx.impactMeshes];
  const versions = () => meshes.flatMap(mesh => [mesh.instanceMatrix.version, mesh.instanceColor.version]);
  const idle = versions();
  for (let frame = 0; frame < 120; frame++) fx.update(1 / 60);
  assert.deepEqual(versions(), idle, 'empty pools upload no attributes');
  assert.ok(meshes.every(mesh => mesh.count === 0 && !mesh.visible), 'empty pools submit no draws');

  // Mixed lifetimes compact without losing records, face shade, colors or a frame of movement.
  const records = new Set(fx.parts);
  fx.spawnParticles(10, 20, 30, 1, 0xff0000, { ...particle, life: 0.01 });
  fx.spawnParticles(11, 21, 31, 1, 0x0000ff, { ...particle, blocky: true });
  fx.spawnParticles(12, 22, 32, 1, 0x00ff00, { ...particle, spriteGlint: true, life: 2 });
  const chip = fx.parts[1], glint = fx.parts[2];
  fx.update(0.02);
  assert.equal(fx.partMesh.count, 2, 'only live debris is submitted');
  assert.equal(fx.parts[0], chip, 'survivors fill the live range in their original order');
  assert.equal(fx.parts[1], glint);
  assert.deepEqual(new Set(fx.parts), records, 'compaction reuses the fixed pool records');
  activePrefix(fx.parts, 2);
  near(chip.t, 0.02); near(glint.t, 0.02);
  for (let i = 0; i < fx.partMesh.count; i++) {
    const p = fx.parts[i];
    assert.equal(fx.partShade.getX(i), p.blocky ? 1 : 0, 'face-shade weight follows its record');
    fx.partMesh.getMatrixAt(i, matrix);
    near(matrix.elements[12], p.x); near(matrix.elements[13], p.y); near(matrix.elements[14], p.z);
    fx.partMesh.getColorAt(i, color);
    near(color.r, p.colR); near(color.g, p.colG); near(color.b, p.colB);
  }
  fx.partMesh.getMatrixAt(2, matrix);
  assert.equal(matrix.elements[0], 0, 'the trailing freed transform is hidden');
  fx.spawnParticles(13, 23, 33, 1, 0xffffff, particle);
  assert.equal(fx.partMesh.count, 3, 'the next spawn appends directly to the live range');
  activePrefix(fx.parts, 3);
  fx.update(3);
  assert.equal(fx.partMesh.count, 0); assert.equal(fx.partMesh.visible, false);

  fx.spawnParticles(0, 1, 0, fx.parts.length, 0xffffff, particle);
  for (const p of fx.parts) p.t = 0.1;
  fx.parts[333].t = 0.9;
  fx.spawnParticles(999, 1, 0, 1, 0xffffff, particle);
  assert.equal(fx.parts[333].x, 999, 'overflow replaces the most expired record');
  assert.equal(fx.partMesh.count, fx.parts.length, 'overflow keeps the fixed draw budget');
  activePrefix(fx.parts, fx.parts.length);
  fx.update(2);

  fx.spawnStars(2, 3, 4, 3, 0xf4f1e6);
  const starRecords = fx.stars.slice();
  fx.stars[0].life = 0.01;
  const secondStar = fx.stars[1];
  const lastStar = fx.stars[2];
  fx.update(0.1);
  assert.equal(fx.starMesh.count, 3, 'the range includes hidden holes before live stars');
  assert.ok(fx.stars.every((slot, i) => slot === starRecords[i]), 'transparent star slots retain their original identity and order');
  assert.equal(fx.stars[1], secondStar);
  assert.equal(fx.stars[2], lastStar);
  near(lastStar.t, 0.1);
  assert.equal(fx.stars[0].active, false);
  fx.spawnStars(99, 3, 4, 1, 0x0000ff);
  assert.equal(fx.stars[0], starRecords[0], 'a newcomer uses the first free slot before the surviving stars');
  near(fx.stars[0].x, 99 - 0.2);
  fx.stars[2].life = 0.11;
  fx.update(0.02);
  assert.equal(fx.starMesh.count, 2, 'an expired tail leaves the range without moving a survivor');
  fx.spawnStars(5, 6, 7, fx.stars.length, 0xd8243c);
  assert.equal(fx.starMesh.count, fx.stars.length);
  fx.stars[44].t = fx.stars[44].life * 0.99;
  fx.spawnStars(999, 6, 7, 1, 0xffffff);
  near(fx.stars[44].x, 999 - 0.2);
  fx.update(2);
  assert.equal(fx.starMesh.count, 0); assert.equal(fx.starMesh.visible, false);

  fx.impact({ vx: 0, vy: 2, vz: -2, hs: true });
  fx.impact({ vx: 0, vy: 2, vz: -3 });
  assert.ok(fx.impactMeshes.every(mesh => mesh.count === 2 && mesh.visible));
  fx.update(0.3);
  assert.equal(fx.impacts[0].active, true, 'headshot cue retains its longer lifetime');
  assert.ok(fx.impactMeshes.every(mesh => mesh.count === 1), 'expired trailing cues shrink the draw range');
  for (let i = 0; i < 100; i++) fx.impact({ vx: i, vy: 2, vz: -2 });
  assert.ok(fx._impactCount <= fx.impacts.length, 'cue ring remains bounded after wraparound');
  fx.update(2);
  assert.ok(meshes.every(mesh => mesh.count === 0 && !mesh.visible));
  const expired = versions();
  for (let frame = 0; frame < 120; frame++) fx.update(1 / 60);
  assert.deepEqual(versions(), expired, 'drained pools return to zero idle uploads');

  const disposed = meshes.map(mesh => {
    const counts = [0, 0, 0];
    [mesh, mesh.geometry, mesh.material].forEach((resource, i) => resource.addEventListener('dispose', () => counts[i]++));
    return counts;
  });
  fx.dispose(); fx.dispose();
  fx.spawnParticles(0, 0, 0, 5, 0xffffff, particle);
  fx.spawnStars(0, 0, 0, 5, 0xffffff);
  fx.impact({ vx: 0, vy: 0, vz: 0 });
  fx.update(1);
  assert.deepEqual(versions(), expired, 'disposed pools cannot write released GPU buffers');
  assert.ok(disposed.every(counts => counts.every(count => count === 1)), 'instance buffers, geometry and materials dispose once');
  assert.equal(scene.children.length, 0);

  for (const type of [MC_WATER, MC_PORTAL, MC_GHOST_STONE]) {
    const passable = new ImpactFX(new THREE.Scene(), camera, () => type);
    passable.spawnParticles(0.5, 1.01, 0.5, 1, 0xffffff, { ...particle, blocky: true });
    const p = passable.parts[0];
    p.vy = -1;
    passable.update(0.1);
    assert.ok(p.active && p.y < 1, 'chips travel through fluids, portals and ghost blocks');
    passable.dispose();
  }
} finally {
  Math.random = originalRandom;
}

console.log('ok - active impact draw ranges, dense particles, fixed star lifecycle order, shade/color coherence, overflow, passable cells, idle uploads and disposal');

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
      const { ImpactFX } = await import('/js/weapons/impacts.js');
      const renderer = new THREE.WebGLRenderer({ antialias: true });
      renderer.setSize(640, 480);
      document.body.replaceChildren(renderer.domElement);
      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(45, 640 / 480, 0.01, 20);
      camera.position.z = 2;
      const fx = new ImpactFX(scene, camera, () => 0);
      renderer.render(scene, camera);
      const idle = { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles };
      fx.impact({ vx: 0, vy: 0, vz: 0 });
      fx.spawnStars(0, 0, 0, 3, 0xffffff);
      fx.update(0.01);
      renderer.render(scene, camera);
      const hit = { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles };
      const pixels = new Uint8Array(640 * 480 * 4);
      const gl = renderer.getContext();
      gl.readPixels(0, 0, 640, 480, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      let litPixels = 0;
      for (let i = 0; i < pixels.length; i += 4) if (pixels[i] || pixels[i + 1] || pixels[i + 2]) litPixels++;
      const meshes = [fx.partMesh, fx.starMesh, ...fx.impactMeshes];
      const expectedTriangles = meshes.reduce((sum, mesh) => {
        const passes = mesh.material.transparent && mesh.material.side === THREE.DoubleSide && !mesh.material.forceSinglePass ? 2 : 1;
        return sum + passes * mesh.count * (mesh.geometry.index?.count ?? mesh.geometry.attributes.position.count) / 3;
      }, 0);
      // Draw this exact frame with the former full-capacity ranges. Hidden
      // instances must not change its pixels, only the geometry submitted.
      const counts = meshes.map(mesh => mesh.count);
      meshes.forEach(mesh => { mesh.count = mesh.instanceMatrix.count; });
      renderer.render(scene, camera);
      const capacityDraw = { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles };
      const capacityPixels = new Uint8Array(pixels.length);
      gl.readPixels(0, 0, 640, 480, gl.RGBA, gl.UNSIGNED_BYTE, capacityPixels);
      let pixelDifferences = 0;
      for (let i = 0; i < pixels.length; i++) if (pixels[i] !== capacityPixels[i]) pixelDifferences++;
      meshes.forEach((mesh, i) => { mesh.count = counts[i]; });
      fx.update(3);
      renderer.render(scene, camera);
      const drained = { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles };
      fx.spawnStars(0, 0, 0, 1, 0xffffff);
      fx.update(0.01);
      renderer.render(scene, camera);
      const reused = { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles };
      fx.dispose();
      renderer.render(scene, camera);

      // Exercise expiry plus reuse, then compare with the former fixed-slot
      // draw order. A full-capacity rendering of the current order cannot
      // catch compaction reversing an overlapping newcomer and survivor.
      const lifecycle = new ImpactFX(scene, camera, () => 0);
      const originalSlots = lifecycle.stars.slice();
      lifecycle.spawnStars(0, 0, 0, 2, 0xff0000);
      lifecycle.stars[0].life = 0.01;
      lifecycle.stars[1].life = 5;
      lifecycle.update(0.02);
      lifecycle.spawnStars(0, 0, 0, 1, 0x0000ff);
      for (const star of lifecycle.stars) if (star.active) Object.assign(star, {
        x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
        rot: 0, spin: 0, size: 0.6, t: 0, life: 5,
      });
      lifecycle.update(0);
      renderer.render(scene, camera);
      const lifecyclePixels = new Uint8Array(pixels.length);
      gl.readPixels(0, 0, 640, 480, gl.RGBA, gl.UNSIGNED_BYTE, lifecyclePixels);
      const reference = new THREE.InstancedMesh(lifecycle.starMesh.geometry, lifecycle.starMesh.material, originalSlots.length);
      reference.frustumCulled = false;
      reference.renderOrder = lifecycle.starMesh.renderOrder;
      const transform = new THREE.Matrix4(), tint = new THREE.Color();
      for (let i = 0; i < originalSlots.length; i++) {
        const slot = originalSlots[i];
        if (slot.active) {
          const currentIndex = lifecycle.stars.indexOf(slot);
          lifecycle.starMesh.getMatrixAt(currentIndex, transform);
          lifecycle.starMesh.getColorAt(currentIndex, tint);
          reference.setColorAt(i, tint);
        } else transform.makeScale(0, 0, 0);
        reference.setMatrixAt(i, transform);
      }
      lifecycle.starMesh.visible = false;
      scene.add(reference);
      renderer.render(scene, camera);
      const referencePixels = new Uint8Array(pixels.length);
      gl.readPixels(0, 0, 640, 480, gl.RGBA, gl.UNSIGNED_BYTE, referencePixels);
      let lifecyclePixelDifferences = 0, lifecycleLitPixels = 0;
      for (let i = 0; i < lifecyclePixels.length; i += 4) {
        if (lifecyclePixels[i] || lifecyclePixels[i + 1] || lifecyclePixels[i + 2]) lifecycleLitPixels++;
        if (lifecyclePixels[i] !== referencePixels[i] || lifecyclePixels[i + 1] !== referencePixels[i + 1]
            || lifecyclePixels[i + 2] !== referencePixels[i + 2] || lifecyclePixels[i + 3] !== referencePixels[i + 3]) lifecyclePixelDifferences++;
      }
      scene.remove(reference);
      reference.dispose();
      lifecycle.dispose();
      renderer.render(scene, camera);
      const geometries = renderer.info.memory.geometries;
      const error = gl.getError();
      renderer.dispose();
      return { idle, hit, expectedTriangles, litPixels, capacityDraw, pixelDifferences, drained, reused,
        lifecyclePixelDifferences, lifecycleLitPixels, geometries, error };
    })()`);
    assert.deepEqual(result.idle, { calls: 0, triangles: 0 });
    assert.equal(result.hit.calls, 9, 'populated batches retain their transparent front/back passes');
    assert.equal(result.hit.triangles, result.expectedTriangles, 'WebGL submits exactly the active instances');
    assert.equal(result.hit.triangles, 396, 'five debris, three stars and one layered cue reach the GPU');
    assert.ok(result.litPixels > 100, 'impact and crit-star shaders produce visible pixels');
    assert.equal(result.capacityDraw.triangles, 19008, 'fixed-capacity ranges submit the former geometry budget');
    assert.equal(result.pixelDifferences, 0, 'active ranges preserve every rendered pixel, including transparent opacity');
    assert.deepEqual(result.drained, { calls: 0, triangles: 0 });
    assert.deepEqual(result.reused, { calls: 2, triangles: 24 }, 'a drained pool renders a new single star');
    assert.ok(result.lifecycleLitPixels > 100, 'the overlapping lifecycle stars produce visible reference pixels');
    assert.equal(result.lifecyclePixelDifferences, 0, 'expiry and first-free reuse retain the baseline transparent draw order');
    assert.equal(result.geometries, 0, 'disposed pools release their renderer geometry');
    assert.equal(result.error, 0, 'impact shaders and buffers produce no WebGL error');
    console.log('Combat FX WebGL:', JSON.stringify(result));
  } finally {
    await browser?.close();
    await stopServer(server);
  }
}
