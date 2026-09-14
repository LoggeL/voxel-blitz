import * as THREE from '../../vendor/three.module.js';
import { createBlenderParts } from '../../engine/blender-assets.js';
import { makeReticleTexture } from '../kit.js';

// PEREGRINE supplies the LONGSHOT MK-II. The Blender template owns every rigid form; only the
// parts the game animates are pulled out of it, and the additive lens plus reticle stay here so
// the optic still reads at gameplay distance.
const OPTIC_Y = 0.205;
// Concept A's compact optic ends at z=-0.34544; glass sits just ahead of its rim.
const LENS_Z = -0.347;
const GLASS_R = 0.042;
const RETICLE_SIZE = 0.067;
const CARTRIDGE_Y = 0.115;
const CARTRIDGE_STEP = 0.016;
const CARTRIDGE_Z = -0.235;

export function buildPeregrine({ groups }) {
  const parts = createBlenderParts('peregrine');
  if (!parts) return false;
  for (const key of ['body', 'mag', 'bolt', 'trigger']) groups[key].add(...parts[key].children);

  // One optic node, so a replacement sight hides the authored tube and its lenses with it.
  const optic = parts['factory-optic'];
  groups.body.add(optic);

  const glass = new THREE.Mesh(
    new THREE.CircleGeometry(GLASS_R, 24),
    new THREE.MeshBasicMaterial({
      color: 0x88dfff,
      transparent: true,
      opacity: 0.16,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  glass.name = 'peregrine_objective_glass';
  glass.position.set(0, OPTIC_Y, LENS_Z);
  optic.add(glass);

  const reticleTexture = makeReticleTexture();
  const reticle = new THREE.Mesh(
    new THREE.PlaneGeometry(RETICLE_SIZE, RETICLE_SIZE),
    reticleTexture
      ? new THREE.MeshBasicMaterial({
        map: reticleTexture,
        transparent: true,
        opacity: 0.82,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
      : new THREE.MeshBasicMaterial({
        color: 0x88ffcc,
        transparent: true,
        opacity: 0.22,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
  );
  reticle.name = 'peregrine_reticle';
  reticle.position.set(0, OPTIC_Y, LENS_Z);
  optic.add(reticle);

  // Reload choreography owns visibility and the y offset of every stripper round each frame, so
  // each round hangs directly off `extra`, centred on its own origin, placed once in x/z here.
  const rounds = parts.extra.children.slice().sort((a, b) => a.position.y - b.position.y);
  if (rounds.length !== 3) {
    console.warn(`[vb] PEREGRINE carries ${rounds.length} stripper rounds; the reload timeline expects 3`);
  }
  for (let i = 0; i < rounds.length; i++) {
    const cartridge = rounds[i];
    cartridge.position.set(0, CARTRIDGE_Y + i * CARTRIDGE_STEP, CARTRIDGE_Z);
    cartridge.visible = false;
    groups.extra.add(cartridge);
    groups.extra.userData.cartridges.push(cartridge);
  }

  groups.body.userData.blenderAsset = 'peregrine';
  groups.body.userData.sightHeight = OPTIC_Y;
  return true;
}
