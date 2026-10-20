// Engineer FPV drone (shared/fpv-rules.js): a 5-inch quad frame with the
// shaped charge strapped under it, the camera pod on its nose and a team LED
// on its tail (the recognition colour, unlit by the scene, so it reads at
// night and against the sky). Authored at four times its size and meshed at
// quarter scale (0.05 m voxels). The four props are blur discs that spin up
// while it flies; the row's pitch and roll (fpvAttitude) tilt the whole frame.
import * as THREE from '../../vendor/three.module.js';
import { VoxelPart } from '../voxel-model/dsl.js';
import { teamScheme } from '../voxel-model/material.js';
import { blueprint, createKit, finishModel } from './common.js';

const FINE = 0.25;
const at = offset => offset.map(n => n / FINE);
const fine = name => {
  const part = new VoxelPart(name, { pivot: [0, 0, 0], grid: [0, 0, 0] });
  part.userData.scale = FINE;
  return part;
};
/** Motor centres (real metres, forward -Z). */
const MOTORS = Object.freeze([[-0.17, 0.13, -0.17], [0.17, 0.13, -0.17], [-0.17, 0.13, 0.17], [0.17, 0.13, 0.17]]);
const PROP_RADIUS = 0.11;
/** One LED material per team, shared by every drone (never disposed). */
const ledMaterials = new Map();
const ledMaterial = team => {
  if (!ledMaterials.has(team)) ledMaterials.set(team, new THREE.MeshBasicMaterial({ color: teamScheme(team).recog, toneMapped: false }));
  return ledMaterials.get(team);
};

function rod(part, a, b, material, thick = 0.025) {
  const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / 0.02));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps, p = a.map((n, k) => n + (b[k] - n) * t);
    part.box(at(p.map(n => n - thick / 2)), at(p.map(n => n + thick / 2)), material);
  }
}

function buildParts() {
  const frame = fine('fpv-frame');
  // Centre stack and the battery strapped on top (its strap in team drab).
  frame.box(at([-0.05, 0.1, -0.08]), at([0.05, 0.15, 0.08]), 'gunmetal');
  frame.box(at([-0.04, 0.15, -0.05]), at([0.04, 0.2, 0.07]), 'dark');
  frame.box(at([-0.045, 0.165, 0]), at([0.045, 0.18, 0.02]), 'drab');
  // Arms out to the motors and the motor bells.
  for (const m of MOTORS) {
    rod(frame, [0, 0.12, 0], m, 'dark');
    frame.box(at([m[0] - 0.025, m[1] - 0.01, m[2] - 0.025]), at([m[0] + 0.025, m[1] + 0.035, m[2] + 0.025]), 'steel');
  }
  // Camera pod on the nose, the lens glass forward.
  frame.box(at([-0.03, 0.11, -0.12]), at([0.03, 0.16, -0.07]), 'dark');
  frame.box(at([-0.015, 0.125, -0.13]), at([0.015, 0.15, -0.12]), 'glass');
  // The charge: an RPG warhead slung under the frame, nose forward.
  const charge = fine('fpv-charge');
  charge.cyl(at([0, 0.06, -0.02]), 0.04 / FINE, 0.2 / FINE, 'z', 'warhead');
  charge.cyl(at([0, 0.06, -0.14]), 0.025 / FINE, 0.05 / FINE, 'z', 'warhead');
  charge.box(at([-0.045, 0.08, 0.02]), at([0.045, 0.1, 0.04]), 'hazard');
  charge.box(at([-0.045, 0.08, -0.08]), at([0.045, 0.1, -0.06]), 'hazard');
  return { frame, charge };
}

/** The FPV drone. Options: { team, material, glass, blur }. */
export function makeFpvModel(options = {}) {
  const type = 'fpv';
  const parts = blueprint(type, buildParts);
  const { kit, team } = createKit(type, options);
  const { group } = kit;
  const body = kit.node(group, 'fpv-body', [0, 0, 0]);
  kit.part(body, parts.frame);
  kit.part(body, parts.charge);
  const discs = MOTORS.map((m, i) => {
    const node = kit.node(body, `fpv-prop-${i}`, [m[0], m[1] + 0.045, m[2]]);
    return kit.blurDisc(node, PROP_RADIUS, `fpv-prop-blur-${i}`);
  });
  // Team LED: an unlit cube on the tail, so a drone overhead reads friend or foe.
  const led = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.03, 0.035), ledMaterial(team));
  led.name = 'fpv-led';
  led.position.set(0, 0.2, 0.085);
  led.userData.ownedGeometry = true;
  body.add(led);
  kit.extraMeshes.push(led);
  let clock = 0;
  const animate = (dt, { wreck = false } = {}) => {
    clock += Math.max(0, Math.min(0.1, dt || 0));
    for (const disc of discs) {
      disc.visible = !wreck;
      if (disc.material) disc.material.opacity = 0.32;
    }
    // A slow blink (2 Hz) so the eye catches it; a wreck goes dark.
    led.visible = !wreck && (clock * 2) % 1 < 0.7;
  };
  return finishModel(kit, {
    body, mounts: {}, seatAnchors: {}, wheels: [], contacts: [], animate,
    emitters: { exhaust: [], dust: [], tracks: [], lights: [], fire: [], cookoff: [] },
    floorTop: 0,
  });
}
