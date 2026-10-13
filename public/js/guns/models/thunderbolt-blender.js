import * as THREE from '../../vendor/three.module.js';
import { createBlenderParts } from '../../engine/blender-assets.js';
import { disposeObjectTrees } from '../../engine/dispose.js';
import { installThunderboltPlasma } from '../thunderbolt-plasma.js';

const ROTOR = new THREE.Vector3(-0.103, 0.009, -0.22);
const ENERGY = new THREE.Vector3(0, 0.07, -0.64);
const REQUIRED = ['body', 'bolt', 'trigger', 'rotor', 'orb0', 'orb1', 'orb2', 'orb3', 'energy', 'arcs', 'optic'];

/** The exporter bakes Blender geometry into gun space. Convert articulated
 * parts to their joints once; templates and shared texture maps stay immutable. */
export function buildBlenderThunderbolt(groups, displayMount) {
  const parts = createBlenderParts('thunderbolt');
  if (!parts) return false;
  if (REQUIRED.some(name => !parts[name]?.children.length)) {
    disposeObjectTrees(Object.values(parts));
    return false;
  }
  let pulseMaterial = null;
  for (const part of Object.values(parts)) part.traverse(mesh => {
    for (const material of [].concat(mesh.material || [])) {
      if (material.userData.tbEnergy) pulseMaterial = material;
    }
  });
  if (!pulseMaterial) {
    disposeObjectTrees(Object.values(parts));
    return false;
  }

  for (const name of ['body', 'bolt', 'trigger']) groups[name].add(...parts[name].children);
  const optic = parts.optic;
  optic.name = 'factory-optic';
  groups.body.add(optic);

  const atJoint = (part, pivot) => {
    for (const mesh of part.children) mesh.position.sub(pivot);
    part.position.copy(pivot);
    return part;
  };
  const rotor = atJoint(parts.rotor, ROTOR);
  rotor.name = 'thunderbolt-rotor';
  groups.mag.add(rotor);
  const rounds = Array.from({ length: 4 }, (_, index) => {
    const angle = Math.PI / 4 - index * Math.PI / 2;
    const local = new THREE.Vector3(Math.cos(angle) * 0.052, Math.sin(angle) * 0.052, 0.059);
    const round = atJoint(parts[`orb${index}`], ROTOR.clone().add(local));
    round.position.copy(local);
    round.name = `orb-charge-${index}`;
    rotor.add(round);
    return round;
  });
  const energy = atJoint(parts.energy, ENERGY);
  energy.name = 'orb-field';
  const arcs = parts.arcs;
  arcs.name = 'accelerator-arcs';
  groups.body.add(energy, arcs);
  groups.body.userData.blenderAsset = 'thunderbolt';
  groups.body.userData.displayMount = displayMount;
  groups.body.userData.sightHeight = 0.17;
  const animated = { drum: groups.mag, rotor, rounds, energy, arcs, pulseMaterial };
  animated.plasma = installThunderboltPlasma(animated);
  groups.extra.userData.thunderbolt = animated;
  return true;
}
