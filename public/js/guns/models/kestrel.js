import { createBlenderParts } from '../../engine/blender-assets.js';
import * as THREE from '../../vendor/three.module.js';

export function buildKestrel({ groups }) {
  const parts = createBlenderParts('kestrel');
  if (!parts) return false;
  for (const key of ['body', 'mag', 'bolt', 'trigger']) groups[key].add(...parts[key].children);
  groups.body.add(parts['factory-optic']);
  const dot = new THREE.Mesh(new THREE.CircleGeometry(.0014, 8),
    new THREE.MeshBasicMaterial({ color: 0xff543f, side: THREE.DoubleSide }));
  dot.position.set(0, .145, -.187);
  parts['factory-optic'].add(dot);
  groups.body.userData.blenderAsset = 'kestrel';
  groups.body.userData.sightHeight = .145;
  return true;
}
