import * as THREE from '../../vendor/three.module.js';
import { createBlenderParts } from '../../engine/blender-assets.js';

// BISON supplies the belt-fed LMG. The Blender template owns every rigid form.
// Two things under `extra` are re-hung here for the belt reload choreography
// in actions.js:
//   * the feed cover leaves (lid, ribs, latch, pawls) ship as world-baked
//     nodes and are gathered into one group pivoting on the authored hinge pin,
//     so reloadPart.rotation.x swings the real lid;
//   * the belt lead (linked rounds lying across the feed tray) ships as
//     origin-centred nodes whose translation is its home on the tray; the
//     reload lifts it out with the spent box and lays a fresh one back in.
const SIGHT_HEIGHT = 0.155;
// Authored 'Feed cover hinge' pin (authoring y 0.206, z 0.145) mapped to game
// space. Rotation.x opens the lid upward-backward like the fallback.
const COVER_HINGE = new THREE.Vector3(0, 0.145, -0.206);
const BELT_LEAD = /belt.?lead/i;

export function buildBison({ groups }) {
  const parts = createBlenderParts('bison');
  if (!parts) return false;
  for (const key of ['body', 'mag', 'bolt', 'trigger']) groups[key].add(...parts[key].children);
  const cover = new THREE.Group();
  cover.name = 'bison_feed_cover';
  cover.position.copy(COVER_HINGE);
  const lead = new THREE.Group();
  lead.name = 'bison_belt_lead';
  for (const mesh of [...parts.extra.children]) {
    if (BELT_LEAD.test(mesh.name)) {
      if (!lead.children.length) lead.position.copy(mesh.position);
      mesh.position.sub(lead.position);
      lead.add(mesh);
    } else {
      mesh.position.sub(COVER_HINGE);
      cover.add(mesh);
    }
  }
  groups.extra.add(cover);
  groups.extra.userData.reloadPart = cover;
  if (lead.children.length) {
    lead.userData.homePosition = lead.position.clone();
    groups.extra.add(lead);
    groups.extra.userData.beltLead = lead;
  }
  groups.body.userData.blenderAsset = 'bison';
  groups.body.userData.sightHeight = SIGHT_HEIGHT;
  return true;
}
