import assert from 'node:assert/strict';
import { buildGun, disposeGunModels } from '../public/js/guns/assemble.js';
import { MaterialCache } from '../public/js/guns/kit.js';
import { startServer, stopServer } from './lib/server-process.mjs';
import { launchCdpSession } from './lib/cdp-session.mjs';

// Headless construction has no image loader. It must keep readable materials
// and the same complete UV geometry without pretending that maps were loaded.
const fallbackCache = new MaterialCache();
const fallback = buildGun('archer', fallbackCache);
const fallbackMaterials = new Set();
fallback.root.traverse(object => {
  if (object.material?.userData.imagegenTexture) fallbackMaterials.add(object.material);
});
assert.equal(fallbackMaterials.size, 2);
for (const material of fallbackMaterials) {
  assert.equal(material.map, null);
  assert.equal(material.bumpMap, null);
  assert.equal(material.color.getHex(), material.userData.paletteColor);
}
disposeGunModels([fallback], fallbackCache);

const server = startServer({ entry: 'tools/capture-server.mjs' });
let browser;
try {
  const base = `http://127.0.0.1:${await server.port}`;
  browser = await launchCdpSession(`${base}/weapon-capture.html?weapon=archer&state=held`, { width: 1200, height: 800 });
  const page = browser.page;
  await page.waitFor(`document.documentElement.dataset.captureReady === 'true'`, { timeoutMs: 30000 });
  const report = await page.evaluate(`(async () => {
    const THREE = await import('/js/vendor/three.module.js');
    const { buildGun, disposeGunModels } = await import('/js/guns/assemble.js');
    const { MaterialCache } = await import('/js/guns/kit.js');
    const { imagegenMap } = await import('/js/engine/blender-assets.js');
    const must = (condition, label) => { if (!condition) throw new Error(label); };
    const cacheA = new MaterialCache(), cacheB = new MaterialCache();
    const a = buildGun('archer', cacheA), b = buildGun('archer', cacheB);
    const materials = root => {
      const result = new Map();
      root.traverse(object => {
        const material = object.material;
        if (material?.userData.imagegenTexture) result.set(material.userData.imagegenTexture, material);
      });
      return result;
    };
    const am = materials(a.root), bm = materials(b.root);
    must(am.size === 2 && bm.size === 2, 'both ImageGen surface materials are used');
    let disposedMaps = 0, disposedMaterials = 0, texturedMeshes = 0;
    for (const name of ['archer-olive', 'archer-tan']) {
      const material = am.get(name), other = bm.get(name), map = imagegenMap(name);
      must(map?.image?.width === 1024 && map.image.height === 1024, name + ' decoded delivered image');
      must(map.colorSpace === THREE.SRGBColorSpace, name + ' sRGB albedo');
      must(map.wrapS === THREE.RepeatWrapping && map.wrapT === THREE.RepeatWrapping, name + ' repeat wrapping');
      must(map.userData.pageOwned, name + ' page lifetime');
      must(material !== other, name + ' mutable materials have separate rig ownership');
      must(material.map === map && other.map === map, name + ' decoded map shared across rigs');
      must(material.bumpMap === map && material.bumpScale === 0.00005, name + ' shallow surface bump');
      must(material.color.getHex() === 0xffffff, name + ' generated albedo remains untinted');
      map.addEventListener('dispose', () => disposedMaps++);
      material.addEventListener('dispose', () => disposedMaterials++);
      material.opacity = 0.25;
      must(other.opacity === 1, name + ' fading one rig leaves the other opaque');
    }
    a.root.traverse(object => {
      if (!object.material?.userData.imagegenTexture) return;
      texturedMeshes++;
      const positions = object.geometry.getAttribute('position'), uv = object.geometry.getAttribute('uv');
      must(uv && uv.count === positions.count, 'textured mesh has UVs for every vertex');
      must(Array.from(uv.array).every(Number.isFinite), 'textured UVs are finite');
      const indices = object.geometry.index?.array ?? Array.from({ length: positions.count }, (_, i) => i);
      for (let i = 0; i < indices.length; i += 3) {
        const [p, q, r] = [indices[i], indices[i + 1], indices[i + 2]];
        const area = (uv.getX(q) - uv.getX(p)) * (uv.getY(r) - uv.getY(p))
          - (uv.getY(q) - uv.getY(p)) * (uv.getX(r) - uv.getX(p));
        must(Math.abs(area) > 1e-8, 'mapped triangle is not collapsed to a texture line');
      }
    });
    // At the closed seam the upper lid uses gun-space V even though its
    // vertices are hinge-local. Compare repeated UVs at matching seam points.
    a.root.updateMatrixWorld(true);
    const lower = a.body.children.find(o => o.isMesh && o.material === am.get('archer-olive') && o.geometry.getAttribute('position').count === 132);
    const upper = a.extra.userData.archer.gate.children.find(o => o.isMesh && o.material === am.get('archer-olive'));
    must(lower && upper, 'split olive receiver meshes available');
    const seamSamples = mesh => {
      const position = mesh.geometry.getAttribute('position'), uv = mesh.geometry.getAttribute('uv'), result = [];
      for (let i = 0; i < position.count; i++) {
        // Each shell segment emits outer, inner, front cap, then back cap.
        // End caps intentionally use planar UVs, so only compare side faces.
        if (i < position.count - 12 && i % 24 >= 12) continue;
        const point = new THREE.Vector3().fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld);
        if (Math.abs(point.y - a.extra.userData.archer.axisY) < 1e-6) result.push({ point, u: uv.getX(i), v: uv.getY(i) });
      }
      return result;
    };
    const top = seamSamples(upper), bottom = seamSamples(lower);
    // Different lid/trough lengths use different end points. Their texture V
    // still follows one physical origin, so their V - Z / .18 must agree.
    must([...top, ...bottom].every(p => Math.abs(p.v - p.point.z / .18) < 1e-6), 'closed lid and trough keep their longitudinal texture origin');
    disposeGunModels([a], cacheA);
    must(disposedMaterials === 2, 'rig-owned textured materials are released');
    must(disposedMaps === 0, 'disposing a rig preserves both page-owned maps');
    for (const [name, material] of bm) must(material.map === imagegenMap(name), name + ' second rig retains its map');
    disposeGunModels([b], cacheB);
    must(disposedMaps === 0, 'all rig disposals preserve decoded page maps');
    return { texturedMeshes, imagegenMaps: [...am.keys()], independentMaterials: true, pageOwnedMapsPreserved: true };
  })()`);
  assert.deepEqual(page.errors, []);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await stopServer(server);
}
