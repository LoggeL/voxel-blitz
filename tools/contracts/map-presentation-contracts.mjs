import { createMapState, AIR, GLASS } from '../../shared/worlddata.js';
import { MAP_IDS } from '../../shared/modes.js';
import { buildMapSigns } from '../../public/js/engine/map-signs.js';

export function runMapPresentationContracts(ok) {
  const previousDocument = globalThis.document;
  globalThis.document = {
    createElement: () => ({ getContext: () => ({ fillRect() {}, fillText() {} }) }),
  };
  try {
    for (const id of MAP_IDS) {
      const world = createMapState(id);
      const signs = buildMapSigns(id, world.getBlock);
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
