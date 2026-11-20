import * as THREE from '../../vendor/three.module.js';
import { createBlenderParts, hasBlenderAsset } from '../../engine/blender-assets.js';
import { disposeObjectTrees } from '../../engine/dispose.js';
import { buildFallback } from './selvedge-fallback.js';

// The workshop export stores vertices in gun space. Move each part's origin
// to its physical bearing so every view animates the same rigid assembly.
const PIVOTS = {
  bobbin: [0, .017, -.145],
  leftTine: [-.041, .062, -.370],
  rightTine: [.041, .062, -.370],
  shuttle: [0, .062, -.369],
  latch: [-.070, .071, -.205],
  guide: [-.047, .064, -.255],
  indicator: [0, .092, -.048],
};

export function build({ kit, groups, lod }) {
  const joints = {};
  for (const [name, pivot] of Object.entries(PIVOTS)) {
    const joint = new THREE.Group();
    joint.name = 'selvedge-' + name;
    joint.position.fromArray(pivot);
    (name === 'bobbin' ? groups.mag : groups.body).add(joint);
    joints[name] = joint;
  }
  groups.extra.userData.selvedge = joints;
  groups.trigger.position.set(0, -.023, -.043);
  groups.body.userData.sightHeight = .144;

  const world = lod === 'world' && hasBlenderAsset('selvedge-world');
  const parts = createBlenderParts(world ? 'selvedge-world' : 'selvedge');
  const targets = { body: groups.body, trigger: groups.trigger, cassette: groups.mag, ...joints };
  if (!parts || Object.keys(targets).some(name => !parts[name]?.children.length)) {
    if (parts) disposeObjectTrees(Object.values(parts));
    buildFallback({ kit, groups, joints, lod });
    return true;
  }
  for (const [name, target] of Object.entries(targets)) {
    for (const mesh of [...parts[name].children]) {
      mesh.position.sub(target.position);
      target.add(mesh);
    }
  }
  groups.body.userData.blenderAsset = 'selvedge';
  groups.body.userData.blenderLod = world ? 'world' : 'full';
  return true;
}
