import * as THREE from '../../vendor/three.module.js';
import { createBlenderParts } from '../../engine/blender-assets.js';

// SKUA supplies the GV-4 RIPTIDE. The Blender template owns every rigid form; only the
// parts glaive-presentation.js animates are re-hung here:
//   * the seated disc (`mag`) is wrapped in a pivot at its own centre, tilted like the
//     authored disc, so the throw/catch spin runs about the disc axis, not the gun origin;
//   * the flywheel (`bolt`) gets a pivot on its hub so it can whirl about the bore axis;
//   * the catch horn leaves (`extra`, `horn left|right | <mat>`) ship hinge-relative like
//     the TORCH gate and are grouped per side on the authored hinge;
//   * the cassette's spare disc is the `extra` round node (reloadRounds);
//   * the optional gauge needle (`extra`, /needle/) pivots about the gauge face normal.
// Lookups are tolerant: a missing node warns once and the presentation skips that part.
const SIGHT_HEIGHT = 0.150;
const DISC_TILT = 6 * Math.PI / 180;
const HORN = /horn/i;
const LEFT = /left/i;
const NEEDLE = /needle/i;
const GLOW = /razor.?glow/i;
const STRIP = /strip|progress/i;

function centerOf(meshes) {
  const box = new THREE.Box3();
  for (const mesh of meshes) {
    mesh.updateMatrixWorld(true);
    box.expandByObject(mesh);
  }
  return box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
}

/** Re-parent `meshes` under a pivot at `center` (optionally tilted) keeping their placement. */
function pivotAround(name, meshes, center, tiltX = 0) {
  const pivot = new THREE.Group();
  pivot.name = name;
  pivot.position.copy(center);
  pivot.rotation.x = tiltX;
  const spin = new THREE.Group();
  spin.name = `${name}_spin`;
  pivot.add(spin);
  pivot.updateMatrixWorld(true);
  for (const mesh of meshes) {
    mesh.updateMatrixWorld(true);
    spin.attach(mesh);
  }
  return { pivot, spin };
}

function collectMaterials(root, test, role, clone = false) {
  const out = [];
  root.traverse(object => {
    if (!object.isMesh) return;
    const list = [].concat(object.material || []);
    const next = list.map(material => {
      if (!material || !test(material)) return material;
      const owned = clone ? material.clone() : material;
      owned.userData.glaiveGlow = role;
      owned.userData.baseEmissive = Number.isFinite(owned.emissiveIntensity) ? owned.emissiveIntensity : 1;
      if (!out.includes(owned)) out.push(owned);
      return owned;
    });
    object.material = Array.isArray(object.material) ? next : next[0];
  });
  return out;
}

export function buildSkua({ groups }) {
  const parts = createBlenderParts('skua');
  if (!parts) return false;
  const warn = (what) => console.warn(`[vb] SKUA asset has no ${what}; glaive presentation skips it`);
  for (const key of ['body', 'trigger']) groups[key].add(...(parts[key]?.children || []));

  // Seated disc: spin pivot on the disc centre, carrying the authored 6-degree tilt.
  const discMeshes = [...(parts.mag?.children || [])];
  let disc = null, discSpin = null;
  // The export ships the mag node at the exact disc centre; the sawtooth bbox can drift.
  const seat = discMeshes.length ? discMeshes[0].position.clone() : new THREE.Vector3();
  if (discMeshes.length) {
    ({ pivot: disc, spin: discSpin } = pivotAround('glaive_disc', discMeshes, seat, DISC_TILT));
    groups.mag.add(disc);
  } else warn('seated disc (mag)');

  // Flywheel: whirl pivot on the drive wheel hub (the bore axis runs through it).
  const wheelMeshes = [...(parts.bolt?.children || [])];
  let flywheel = null;
  if (wheelMeshes.length) {
    // The bolt node's translation is the hub; fall back to the bbox for older exports.
    const hub = wheelMeshes[0].position.lengthSq() > 0 ? wheelMeshes[0].position.clone() : centerOf(wheelMeshes);
    hub.x = 0; hub.y = 0;
    const { pivot, spin } = pivotAround('glaive_flywheel', wheelMeshes, hub);
    groups.bolt.add(pivot);
    flywheel = spin;
  } else warn('flywheel (bolt)');

  // extra: horn leaves per side on their authored hinge, optional needle, spare disc.
  const leaves = { [-1]: [], [1]: [] };
  const needleMeshes = [];
  const roundMeshes = [];
  for (const mesh of [...(parts.extra?.children || [])]) {
    if (HORN.test(mesh.name)) leaves[LEFT.test(mesh.name) ? -1 : 1].push(mesh);
    else if (NEEDLE.test(mesh.name)) needleMeshes.push(mesh);
    else roundMeshes.push(mesh);
  }
  const horns = [];
  for (const side of [-1, 1]) {
    if (!leaves[side].length) { warn(`horn ${side < 0 ? 'left' : 'right'} leaf`); continue; }
    const pivot = new THREE.Group();
    pivot.name = side < 0 ? 'glaive_horn_left' : 'glaive_horn_right';
    pivot.position.copy(leaves[side][0].position);
    for (const mesh of leaves[side]) mesh.position.sub(pivot.position);
    pivot.add(...leaves[side]);
    groups.extra.add(pivot);
    horns.push({ pivot, side });
  }
  let needle = null;
  if (needleMeshes.length) {
    needle = new THREE.Group();
    needle.name = 'glaive_fab_needle';
    needle.position.copy(needleMeshes[0].position);
    for (const mesh of needleMeshes) mesh.position.sub(needle.position);
    needle.add(...needleMeshes);
    groups.extra.add(needle);
  }
  let spare = null;
  if (roundMeshes.length) {
    spare = new THREE.Group();
    spare.name = 'glaive_spare_disc';
    spare.position.copy(roundMeshes[0].position);
    for (const mesh of roundMeshes) mesh.position.sub(spare.position);
    spare.add(...roundMeshes);
    spare.userData.homePosition = spare.position.clone();
    groups.extra.add(spare);
    groups.extra.userData.reloadRounds = spare;
  } else warn('cassette spare disc (extra round)');

  // Razor glow: the disc/spare glow follows discs in hand; the horn prongs get their own
  // clone so the return flare can brighten them alone; the cassette strip shows fabricate.
  const isGlow = material => GLOW.test(material.name || '') || material.userData?.emissive_coil != null
    || material.userData?.cosmeticGlow;
  const hornGlow = [];
  for (const { pivot } of horns) hornGlow.push(...collectMaterials(pivot, isGlow, 'horn', true));
  // The export shares 'SKUA | razor glow' across every glow part; on the body the only glow
  // primitive is the cassette strip, so every body glow is the strip (a named strip material
  // from a later export matches too). The clone keeps it off the disc-count glow below.
  const strip = collectMaterials(groups.body, m => isGlow(m) || STRIP.test(m.name || ''), 'strip', true);
  const glow = [];
  for (const root of [groups.mag, groups.body, ...(spare ? [spare] : [])]) {
    for (const material of collectMaterials(root, m => isGlow(m) && !m.userData.glaiveGlow, 'disc')) {
      if (!glow.includes(material)) glow.push(material);
    }
  }

  groups.extra.userData.glaive = {
    disc, discSpin, flywheel, horns, spare, needle,
    seat, tilt: DISC_TILT, glow, hornGlow, strip,
  };
  groups.body.userData.blenderAsset = 'skua';
  groups.body.userData.sightHeight = SIGHT_HEIGHT;
  return true;
}
