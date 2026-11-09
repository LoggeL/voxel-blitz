import * as THREE from '../../vendor/three.module.js';
import { blenderContract, createBlenderParts, hasBlenderAsset } from '../../engine/blender-assets.js';
import { disposeObjectTrees } from '../../engine/dispose.js';

// SP-2 DOPPLER: baked-atlas Blender asset (tools/blender/doppler). A fixed carrier
// chassis around a recoiling firing unit; see docs/weapon-design/doppler.md.
export const DOPPLER_SIGHT_HEIGHT = 0.142;
const TRIGGER_PIVOT = new THREE.Vector3(0, -0.038, -0.130);
const REQUIRED = ['body', 'unit', 'bolt', 'trigger', 'mag', 'rounds', 'follower', 'pulley', 'spring', 'factory-optic'];
/** Sheave pitch radius: cable travel over this is the wheel's turn. */
const SHEAVE_RADIUS = 0.0118;
/** Free length of the buffer spring between the fixed stop and the unit's rod bracket. */
const SPRING_LENGTH = 0.104;

/** Move a part's meshes into a group standing on `pivot` (meshes ship in baked gun space). */
function atPivot(part, pivot, name) {
  for (const mesh of part.children) mesh.position.sub(pivot);
  part.position.copy(pivot);
  part.name = name;
  return part;
}

/** Chevron reticle with two doublet holdover dots, drawn on the sight line inside the prism housing. */
function reticle() {
  const material = new THREE.MeshBasicMaterial({ color: 0xff5a36, side: THREE.DoubleSide, toneMapped: false });
  const shape = new THREE.Shape();
  const w = 0.0022, h = 0.0020, t = 0.00055;
  shape.moveTo(0, 0); shape.lineTo(w, -h); shape.lineTo(w - t, -h); shape.lineTo(0, -t * 1.5);
  shape.lineTo(-w + t, -h); shape.lineTo(-w, -h); shape.closePath();
  const group = new THREE.Group();
  group.name = 'doppler-reticle';
  group.add(new THREE.Mesh(new THREE.ShapeGeometry(shape), material));
  for (const y of [-0.0036, -0.0054]) {
    const dot = new THREE.Mesh(new THREE.CircleGeometry(0.00034, 8), material);
    dot.position.y = y;
    group.add(dot);
  }
  return group;
}

/** Detail parts the reduced world model ships without (`WORLD_DROP` in tools/blender/doppler/export-doppler.py). */
const WORLD_OPTIONAL = new Set(['spring']);

export function build({ groups, lod = null }) {
  // Remote players carry the reduced world mesh: same atlas, parts and contract, a quarter of the triangles.
  const world = lod === 'world' && hasBlenderAsset('doppler-world');
  const parts = createBlenderParts(world ? 'doppler-world' : 'doppler');
  const contract = blenderContract('doppler');
  if (!parts || !contract) return false;
  for (const name of WORLD_OPTIONAL) if (world && !parts[name]) parts[name] = Object.assign(new THREE.Group(), { name });
  if (REQUIRED.some(name => !parts[name]?.children.length && !(world && WORLD_OPTIONAL.has(name)))) {
    disposeObjectTrees(Object.values(parts));
    return false;
  }
  const marker = name => new THREE.Vector3().fromArray(contract.markers[name]);
  groups.body.add(...parts.body.children);

  // The recoiling firing unit: receiver, barrel, gas block, brake and cable runs.
  const unit = parts.unit;
  unit.name = 'doppler-unit';
  groups.body.add(unit);
  // The buffer spring is squeezed against its fixed rear stop by the unit's rod bracket.
  const spring = atPivot(parts.spring, marker('spring'), 'doppler-spring');
  groups.body.add(spring);
  // Both sheaves turn on the fixed axle as the cable follows the unit.
  const pulley = atPivot(parts.pulley, marker('pulley'), 'doppler-pulley');
  groups.body.add(pulley);

  // The rig reciprocates groups.bolt; the carrier also rides the unit, so it sits in a slide of its own.
  const boltSlide = parts.bolt;
  boltSlide.name = 'doppler-bolt-slide';
  groups.bolt.add(boltSlide);
  groups.trigger.position.copy(TRIGGER_PIVOT);
  for (const mesh of parts.trigger.children.slice()) {
    mesh.position.sub(TRIGGER_PIVOT);
    groups.trigger.add(mesh);
  }

  // Magazine: smoke body, floor and lips; the cartridge stack is one instanced round
  // (the atlas bakes a single cartridge), so a spent round is one instance fewer.
  groups.mag.add(...parts.mag.children);
  const round = parts.rounds.children[0];
  const count = Math.max(1, contract.roundCount | 0);
  const rounds = new THREE.InstancedMesh(round.geometry, round.material, count);
  rounds.name = 'doppler-rounds';
  const matrix = new THREE.Matrix4();
  for (let index = 0; index < count; index++) {
    matrix.fromArray(contract.roundMatrices[index]);
    rounds.setMatrixAt(index, matrix);
  }
  rounds.instanceMatrix.needsUpdate = true;
  rounds.computeBoundingSphere();
  rounds.frustumCulled = false;
  groups.mag.add(rounds);
  const follower = parts.follower;
  follower.name = 'doppler-follower';
  groups.mag.add(follower);

  const optic = parts['factory-optic'];
  optic.name = 'factory-optic';
  const sight = reticle();
  sight.position.copy(marker('sight'));
  optic.add(sight);
  groups.body.add(optic);

  groups.body.userData.blenderAsset = 'doppler';
  groups.body.userData.blenderLod = world ? 'world' : 'full';
  groups.body.userData.sightHeight = contract.sightHeight ?? DOPPLER_SIGHT_HEIGHT;
  groups.extra.userData.doppler = {
    unit, boltSlide, spring, pulley, rounds, follower,
    travel: contract.unitTravel, roundCount: count, followerPath: contract.followerPath,
    sheaveRadius: SHEAVE_RADIUS, springLength: SPRING_LENGTH,
  };
  return true;
}
