import { createMapState, AIR, GLASS } from '../../shared/worlddata.js';
import * as THREE from '../../public/js/vendor/three.module.js';
import { findMapCaptureShot } from '../../shared/map-capture-shots.js';
import { MAP_PREVIEWS } from '../../public/js/ui/hud-support.js';
import { MAP_IDS } from '../../shared/modes.js';
import { buildMapSigns } from '../../public/js/engine/map-signs.js';
import { getMapDimensions } from '../../shared/world/dimensions.js';

export function runMapPresentationContracts(ok) {
  const overview = findMapCaptureShot('frontier', 'overview');
  ok(MAP_PREVIEWS.frontier === './assets/maps/frontier.jpg', 'frontier lobby uses an actual rendered map image');
  const { sx: FX, sz: FZ } = getMapDimensions('frontier');
  ok(overview?.kind === 'orthographic' && overview.scale === Math.max(FX, FZ), `frontier overview frames the authoritative ${Math.max(FX, FZ)}m coordinate extent`);
  const half = overview.scale / 2;
  const camera = new THREE.OrthographicCamera(-half, half, half, -half, 0.05, 3000);
  camera.up.set(0, 0, -1); camera.position.fromArray(overview.position);
  camera.lookAt(new THREE.Vector3().fromArray(overview.target)); camera.updateMatrixWorld();
  for (const [x, z, u, v] of [[0, 0, -1, 1], [FX, 0, 1, 1], [0, FZ, -1, -1], [FX, FZ, 1, -1], [FX / 2, FZ / 2, 0, 0]]) {
    const projected = new THREE.Vector3(x, 30, z).project(camera);
    ok(Math.abs(projected.x - u) < 1e-8 && Math.abs(projected.y - v) < 1e-8,
      `frontier overview aligns world (${x},${z}) with north-up map coordinates`);
  }
  const previousDocument = globalThis.document;
  globalThis.document = {
    createElement: () => ({ getContext: () => ({ fillRect() {}, fillText() {} }) }),
  };
  try {
    for (const id of MAP_IDS) {
      const world = createMapState(id);
      const signs = buildMapSigns(id, world.getBlock);
      if (id === 'frontier') {
        // Frontier uses capture markers, not painted wall signage.
        ok(signs.group.children.length === 0, 'frontier has no unauthored wall signage');
        signs.dispose();
        continue;
      }
      ok(signs.group.children.length > 0 && signs.group.children.length <= 4,
        `${id} has bounded, fully supported landmark signage`);
      const painted = signs.group.children[0];
      if (!painted) { signs.dispose(); continue; }
      const { x, y, z } = painted.position;
      const outward = Math.cos(painted.rotation.y) > 0 ? 1 : -1;
      const cell = [Math.floor(x), Math.floor(y), Math.floor(z - outward * 0.03)];
      const original = world.getBlock(...cell);
      world.setBlock(...cell, AIR);
      signs.refresh();
      ok(!painted.visible, `${id} paint disappears when its backing is destroyed`);
      const lateJoin = buildMapSigns(id, world.getBlock);
      ok(!lateJoin.group.children.some(mesh => mesh.name === painted.name && mesh.position.equals(painted.position)),
        `${id} late join does not restore paint across a broken wall`);
      lateJoin.dispose();
      world.setBlock(...cell, GLASS);
      signs.refresh();
      ok(!painted.visible, `${id} paint never obscures a transparent replacement`);
      world.setBlock(...cell, original);
      signs.refresh();
      ok(painted.visible, `${id} restored backing accepts paint again`);
      const front = [cell[0], cell[1], cell[2] + outward];
      world.setBlock(...front, original);
      signs.refresh();
      ok(!painted.visible, `${id} paint requires an exposed wall face`);
      world.setBlock(...front, AIR);
      let releases = 0;
      for (const mesh of signs.group.children) {
        for (const resource of [mesh.geometry, mesh.material, mesh.material.map]) {
          resource.addEventListener('dispose', () => releases++);
        }
      }
      const expected = signs.group.children.length * 3;
      signs.dispose();
      signs.dispose();
      ok(releases === expected && signs.group.children.length === 0,
        `${id} signage releases all resources once when leaving the map`);
    }
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
}
