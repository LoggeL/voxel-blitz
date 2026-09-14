import * as THREE from '../../vendor/three.module.js';
import { createBlenderParts } from '../../engine/blender-assets.js';
import { COL } from '../kit.js';

// FANG supplies the IRONCLAD .44 as a swing-out-cylinder revolver. The Blender
// template owns every rigid form; the builder only sorts the separable buckets
// into the pivots the reload choreography and the firing cycle animate.
const SIGHT_HEIGHT = 0.105;
// Drum centre: authoring bore span y 0.095..0.148 at height z 0.026 maps to
// game (0, 0.026, -0.1215) via game_x = x, game_y = z, game_z = -y.
const CYLINDER_CENTER = new THREE.Vector3(0, 0.026, -0.1215);
// Crane hinge: the authored 'Crane pivot' tube centre at (0, 0.160, 0.004).
const CRANE_HINGE = new THREE.Vector3(0, 0.004, -0.160);
// Hammer pin: the authored pivot pin centre at (0, 0.018, 0.030).
const HAMMER_PIN = new THREE.Vector3(0, 0.030, -0.018);
// Speedloader home: owned by actions.js, which rewrites this position every
// reload frame, so it must match the procedural fallback exactly.
const LOADER_HOME = new THREE.Vector3(-0.058, -0.052, 0.025);
const CHAMBER_RING = 0.034;

function cylinderZ(radius, length, material, segments) {
  const geometry = new THREE.CylinderGeometry(radius, radius, length, segments, 1);
  geometry.rotateX(Math.PI / 2);
  return new THREE.Mesh(geometry, material);
}

export function buildFang({ groups }) {
  const parts = createBlenderParts('fang');
  if (!parts) return false;
  for (const key of ['body', 'trigger']) groups[key].add(...parts[key].children);

  // The spur hammer rotates about its pin, below the rear sight, instead of
  // translating a slide; the pin itself stays rigid on the bolt node.
  const hammer = new THREE.Group();
  hammer.name = 'hammer';
  hammer.position.copy(HAMMER_PIN);
  for (const mesh of [...parts.bolt.children]) {
    const stem = mesh.name.toLowerCase().replace(/_\d+$/, '');
    if (stem === 'bolt_hammer' || stem.endsWith('_hammer')) {
      mesh.position.sub(HAMMER_PIN);
      hammer.add(mesh);
    } else {
      groups.bolt.add(mesh);
    }
  }
  groups.bolt.add(hammer);

  // Crane pivots about the bore-parallel hinge below the cylinder; the drum
  // spins on its own centerline. Reload swing and firing index therefore never
  // orbit the gun origin. Exported vertices are baked to game space, so each
  // bucket is shifted by its pivot origin on the way in.
  const crane = new THREE.Group();
  crane.name = 'cylinderCrane';
  crane.position.copy(CRANE_HINGE);
  const cylinder = new THREE.Group();
  cylinder.name = 'cylinder';
  cylinder.position.copy(CYLINDER_CENTER).sub(CRANE_HINGE);
  const cases = new THREE.Group();
  cases.name = 'cartridgeCases';
  const ejector = new THREE.Group();
  ejector.name = 'ejectorRod';
  // The loader splits multi-primitive meshes (suffixing _1, _2) and sanitizes
  // spaces to underscores, so match on the normalized bucket stem instead of
  // the authored object name. Anything unrecognized stays visible on the drum.
  const bucket = (name) => {
    const stem = name.toLowerCase().replace(/_\d+$/, '');
    if (stem === 'bolt_hammer' || stem.endsWith('_hammer')) return 'hammer-route';
    if (stem.includes('crane')) return 'crane';
    if (stem.includes('cylinder')) return 'cylinder';
    if (stem.includes('case')) return 'cases';
    if (stem.includes('ejector')) return 'ejector';
    return null;
  };
  const seen = new Set();
  for (const mesh of [...parts.mag.children]) {
    const kind = bucket(mesh.name);
    seen.add(kind || mesh.name);
    if (kind === 'crane') {
      mesh.position.sub(CRANE_HINGE);
      crane.add(mesh);
    } else if (kind === 'cylinder' || kind === null) {
      mesh.position.sub(CYLINDER_CENTER);
      cylinder.add(mesh);
    } else if (kind === 'cases') {
      mesh.position.sub(CYLINDER_CENTER);
      cases.add(mesh);
    } else if (kind === 'ejector') {
      mesh.position.sub(CYLINDER_CENTER);
      ejector.add(mesh);
    }
  }
  for (const need of ['crane', 'cylinder', 'cases', 'ejector']) {
    if (!seen.has(need)) console.warn(`[vb] FANG mag bucket missing: ${need}`);
  }
  cylinder.add(cases, ejector);
  crane.add(cylinder);
  groups.mag.add(crane);
  groups.extra.userData.revolver = { crane, cylinder, cases, ejector, hammer };

  // Six speed-loader rounds share the cylinder chamber radius and approach
  // from behind. No loose rounds are authored (the choreography drives this
  // single group, never the cartridges array), so the loader stays procedural.
  const brass = new THREE.MeshStandardMaterial({ color: COL.brass, roughness: 0.38, metalness: 0.74 });
  const polymer = new THREE.MeshStandardMaterial({ color: COL.polymer, roughness: 0.65, metalness: 0.45 });
  const loader = new THREE.Group();
  loader.name = 'speedloader';
  for (let i = 0; i < 6; i++) {
    const angle = i * Math.PI / 3 + Math.PI / 2;
    const round = cylinderZ(0.007, 0.045, brass, 8);
    round.position.set(Math.cos(angle) * CHAMBER_RING, Math.sin(angle) * CHAMBER_RING, 0);
    loader.add(round);
  }
  const handle = cylinderZ(0.010, 0.020, polymer, 10);
  handle.position.set(0, 0, 0.025);
  loader.add(handle);
  loader.position.copy(LOADER_HOME);
  loader.userData.homePosition = LOADER_HOME.clone();
  loader.visible = false;
  groups.extra.add(loader);
  groups.extra.userData.reloadRounds = loader;

  groups.body.userData.blenderAsset = 'fang';
  groups.body.userData.sightHeight = SIGHT_HEIGHT;
  return true;
}
