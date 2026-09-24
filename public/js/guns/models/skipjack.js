import * as THREE from '../../vendor/three.module.js';
import { createBlenderParts } from '../../engine/blender-assets.js';

// The cassette swings on the vertical hinge hub at its front edge (authoring
// (-0.142, 0.306, 0.020); game = (x, z, -y)). Runtime meshes carry baked
// game-space coordinates, so offset them into this pivot once at build.
const CASSETTE_HINGE = new THREE.Vector3(-0.142, 0.020, -0.306);
const ROUND_NAME = /round[ _-]*([1-3])(?:\b|[ _|-])/i;

// GL-3 SKIPJACK is authored as five rigid runtime parts. Up to three reserve
// rounds travel with the flank cassette (`mag`); one shot is already chambered.
// The charging pawl remains independent, so firing and reload motion stay
// inside the normal viewmodel contract.
export function buildSkipjack({ groups }) {
  const parts = createBlenderParts('skipjack');
  if (!parts) return false;

  for (const key of ['body', 'bolt', 'trigger', 'extra']) {
    if (parts[key]) groups[key].add(...parts[key].children);
  }

  const cassette = new THREE.Group();
  cassette.name = 'skipjack_cassette_hinge';
  cassette.position.copy(CASSETTE_HINGE);
  cassette.userData.homePosition = CASSETTE_HINGE.clone();
  const rounds = Array.from({ length: 3 }, (_, index) => {
    const group = new THREE.Group();
    group.name = `skipjack_round_${index + 1}`;
    cassette.add(group);
    return group;
  });
  for (const mesh of [...(parts.mag?.children || [])]) {
    mesh.position.sub(CASSETTE_HINGE);
    const number = ROUND_NAME.exec(mesh.name)?.[1];
    (number ? rounds[Number(number) - 1] : cassette).add(mesh);
  }
  groups.mag.add(cassette);
  // `reload` is the presentation plan of the running swap (see ViewmodelRig.reload).
  groups.extra.userData.skipjack = { cassette, rounds, reload: null };

  groups.body.userData.blenderAsset = 'skipjack';
  groups.body.userData.sightHeight = 0.216;
  groups.mag.userData.cassette = true;
  return true;
}
