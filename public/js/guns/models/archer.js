import * as THREE from '../../vendor/three.module.js';
import { COL, GLOW_ACCENT } from '../kit.js';
import { BOLT_HOME } from './common.js';

// ImageGen reference and actual browser comparisons: docs/design/archer/.
// Hollow octagonal tube, short armor saddles and a split-shell loading trough.
// Ammo authority owns the seated prop; the support hand loads a complete rocket.
const SIGHT_Y = 0.19;
const CYAN = GLOW_ACCENT.archer;
const OLIVE = 0x59634b, EDGE = 0xc1aa7b, HAZARD = 0xd8ad43, ROUND = 0xc7c9bd;
const TEXTURE_METERS = 0.18;

export const DISPLAY_MOUNT = Object.freeze({ x: -0.027, y: 0.155, z: 0.120, w: 0.045, h: 0.035, seat: 'deck', adsHidden: true });

/** Hollow flat-shaded octagonal shell, optionally split at the horizontal seam. */
function shell(parent, material, outer, inner, length, x, y, z, half = 'full', uvOffsetZ = 0) {
  const upper = [0, Math.PI / 8, 3 * Math.PI / 8, 5 * Math.PI / 8, 7 * Math.PI / 8, Math.PI];
  const angles = half === 'upper' ? upper : half === 'lower' ? upper.map(a => a + Math.PI)
    : [...upper, ...upper.slice(1).map(a => a + Math.PI)];
  const vertices = [], uvs = [];
  const point = (r, a, end) => {
    // Split meets the middle of an octagon face, without adding a ninth corner.
    const radius = Math.abs(Math.sin(a)) < 1e-6 ? r * Math.cos(Math.PI / 8) : r;
    return [x + radius * Math.cos(a), y + radius * Math.sin(a), z + end * length / 2];
  };
  const capUV = p => [(p[0] - x) / TEXTURE_METERS, (p[1] - y) / TEXTURE_METERS];
  // The V origin stays in closed gun coordinates even when the lid geometry
  // lives around its hinge. Split shells therefore meet on the same scan.
  const sideUV = (r, a, end) => [
    // Round to complete circumference tiles so the two seam edges agree.
    Math.max(1, Math.round(2 * Math.PI * r / TEXTURE_METERS)) * a / (2 * Math.PI),
    (z + uvOffsetZ + end * length / 2) / TEXTURE_METERS,
  ];
  const quad = (a, b, c, d, ua = capUV(a), ub = capUV(b), uc = capUV(c), ud = capUV(d)) => {
    vertices.push(...a, ...b, ...c, ...a, ...c, ...d);
    uvs.push(...ua, ...ub, ...uc, ...ua, ...uc, ...ud);
  };
  for (let i = 0; i < angles.length - 1; i++) {
    const a = angles[i], b = angles[i + 1];
    const of = point(outer, a, -1), ob = point(outer, a, 1);
    const nf = point(outer, b, -1), nb = point(outer, b, 1);
    const inf = point(inner, a, -1), inb = point(inner, a, 1);
    const jnf = point(inner, b, -1), jnb = point(inner, b, 1);
    quad(of, nf, nb, ob, sideUV(outer, a, -1), sideUV(outer, b, -1), sideUV(outer, b, 1), sideUV(outer, a, 1));
    quad(inf, inb, jnb, jnf, sideUV(inner, a, -1), sideUV(inner, a, 1), sideUV(inner, b, 1), sideUV(inner, b, -1));
    quad(of, inf, jnf, nf);
    quad(ob, nb, jnb, inb);
  }
  if (half !== 'full') {
    const a = angles[0], b = angles.at(-1);
    const seamUV = (r, end) => [r / TEXTURE_METERS, (z + uvOffsetZ + end * length / 2) / TEXTURE_METERS];
    quad(point(outer, a, -1), point(outer, a, 1), point(inner, a, 1), point(inner, a, -1),
      seamUV(outer, -1), seamUV(outer, 1), seamUV(inner, 1), seamUV(inner, -1));
    quad(point(outer, b, -1), point(inner, b, -1), point(inner, b, 1), point(outer, b, 1),
      seamUV(outer, -1), seamUV(inner, -1), seamUV(inner, 1), seamUV(outer, 1));
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, material);
  parent.add(mesh);
  return mesh;
}

/** Same complete missile shape in the chamber and the support hand. */
function rocket(parent, kit, name) {
  const { cylZ, box } = kit;
  const group = new THREE.Group();
  group.name = name;
  parent.add(group);
  cylZ(group, 0.031, 0.245, 0, 0, -0.0075, ROUND, { seg: 10, rg: 0.55, mt: 0.2 });
  // cylZ's bottom radius faces -z, the bore direction.
  cylZ(group, 0.031, 0.075, 0, 0, -0.1675, COL.gunmetal, { seg: 10, rBot: 0.004, rTop: 0.031 });
  cylZ(group, 0.0325, 0.023, 0, 0, -0.116, HAZARD, { seg: 10 });
  cylZ(group, 0.026, 0.067, 0, 0, 0.147, COL.steel, { seg: 10 });
  cylZ(group, 0.022, 0.02, 0, 0, 0.19, COL.polyDark, { seg: 10, open: true });
  for (let i = 0; i < 4; i++) {
    const fin = new THREE.Group();
    fin.rotation.z = i * Math.PI / 2;
    group.add(fin);
    box(fin, 0.005, 0.021, 0.063, 0, 0.036, 0.149, COL.steel, { rx: -0.12 });
  }
  for (const side of [-1, 1]) box(group, 0.002, 0.010, 0.043, side * 0.0305, 0, -0.024, COL.polyDark);
  return group;
}

export function build({ kit, T, groups }) {
  const { box, cylZ, mat, imagegenMat } = kit;
  const { body, bolt, trigger, extra } = groups;
  const [mx, axisY, muzzleZ] = T.muzzle;
  body.userData.displayMount = DISPLAY_MOUNT;
  body.userData.sightHeight = SIGHT_Y;
  const metal = imagegenMat('archer-olive', OLIVE, 0.67, 0.24), dark = mat(COL.polyDark, 0.72, 0.22);
  const armor = imagegenMat('archer-tan', COL.tan, 0.8, 0.12), bright = mat(EDGE, 0.68, 0.18), lamp = mat(CYAN, 0.28, 0.15);

  // Open forward tube, rim ends exactly at the authoritative muzzle.
  shell(body, metal, 0.064, 0.054, 0.335, mx, axisY, muzzleZ + 0.1675);
  shell(body, dark, 0.077, 0.053, 0.035, mx, axisY, muzzleZ + 0.0175);
  shell(body, bright, 0.071, 0.064, 0.012, mx, axisY, muzzleZ + 0.059);
  shell(body, armor, 0.076, 0.064, 0.052, 0, axisY, -0.60);
  shell(body, dark, 0.065, 0.051, 0.045, 0, axisY, -0.556);

  // Lower receiver is a real trough with interior runners.
  shell(body, metal, 0.067, 0.052, 0.62, 0, axisY, -0.245, 'lower');
  for (const side of [-1, 1]) {
    box(body, 0.011, 0.012, 0.56, side * 0.049, axisY - 0.022, -0.24, COL.steel);
    box(body, 0.012, 0.018, 0.54, side * 0.06, axisY - 0.009, -0.24, COL.polyDark);
  }
  shell(body, dark, 0.066, 0.045, 0.115, 0, axisY, 0.118);
  shell(body, armor, 0.078, 0.063, 0.075, 0, axisY, 0.118);
  shell(body, dark, 0.072, 0.045, 0.021, 0, axisY, 0.183);
  shell(body, metal, 0.058, 0.043, 0.052, 0, axisY, 0.215);
  shell(body, dark, 0.064, 0.043, 0.018, 0, axisY, 0.25);
  box(body, 0.103, 0.025, 0.090, 0, axisY - 0.075, 0.167, COL.polymer, { rx: -0.08 });
  for (const z of [0.141, 0.166, 0.191]) box(body, 0.11, 0.006, 0.006, 0, axisY - 0.09, z, COL.steel);

  const hinge = new THREE.Vector3(0.061, axisY, -0.19);
  const gate = new THREE.Group();
  gate.name = 'archer_breech_lid';
  gate.position.copy(hinge);
  extra.add(gate);
  shell(gate, metal, 0.067, 0.052, 0.60, -hinge.x, 0, -0.245 - hinge.z, 'upper', hinge.z);
  for (const z of [-0.45, -0.105]) {
    shell(gate, dark, 0.077, 0.067, 0.067, -hinge.x, 0, z - hinge.z, 'upper', hinge.z);
    shell(gate, armor, 0.079, 0.074, 0.049, -hinge.x, 0, z - hinge.z - 0.002, 'upper', hinge.z);
    shell(body, dark, 0.077, 0.067, 0.067, 0, axisY, z, 'lower');
    shell(body, armor, 0.079, 0.074, 0.049, 0, axisY, z - 0.002, 'lower');
    cylZ(body, 0.010, 0.079, hinge.x, axisY, z, COL.steel, { seg: 8 });
    box(gate, 0.014, 0.016, 0.024, -hinge.x - 0.064, 0.008, z - hinge.z, EDGE);
    box(body, 0.014, 0.013, 0.024, -0.064, axisY - 0.013, z, COL.polyDark);
  }
  for (const z of [-0.37, -0.34, -0.31]) box(gate, 0.049, 0.005, 0.009, -hinge.x, 0.062, z - hinge.z, COL.fluteDark);
  for (const z of [-0.42, -0.08]) box(body, 0.006, 0.008, 0.027, -0.068, axisY - 0.020, z, CYAN, { mat: lamp });

  // Compact round seeker replaces the long block on the cheek.
  const seekerX = -0.083;
  cylZ(body, 0.026, 0.094, seekerX, axisY + 0.007, -0.636, COL.gunmetal, { seg: 8 });
  shell(body, dark, 0.029, 0.020, 0.021, seekerX, axisY + 0.007, -0.683);
  cylZ(body, 0.019, 0.003, seekerX, axisY + 0.007, -0.691, CYAN, { seg: 12, rg: 0.18 });
  box(body, 0.031, 0.015, 0.059, -0.062, axisY + 0.012, -0.616, COL.steel);
  box(body, 0.060, 0.027, 0.047, -0.023, 0.135, 0.115, COL.tan, { rx: -0.08, mat: armor });

  // Both grips preserve the existing hand anchors.
  box(body, 0.036, 0.105, 0.047, 0.004, -0.032, -0.065, COL.polymer, { rx: 0.18 });
  box(body, 0.040, 0.010, 0.052, 0.004, -0.083, -0.055, COL.tan, { rx: 0.18, mat: armor });
  for (const y of [-0.012, -0.033, -0.054]) box(body, 0.038, 0.004, 0.044, 0.004, y, -0.065, COL.steel, { rx: 0.18 });
  box(body, 0.032, 0.008, 0.075, 0.004, -0.014, -0.115, COL.polyDark);
  box(body, 0.031, 0.033, 0.008, 0.004, 0, -0.15, COL.polyDark, { rx: -0.20 });
  box(trigger, 0.008, 0.025, 0.01, 0.004, 0.003, T.triggerZ, COL.steel);
  box(body, 0.034, 0.078, 0.040, -0.004, -0.018, -0.38, COL.polymer, { rx: -0.12 });
  box(body, 0.046, 0.016, 0.070, -0.004, 0.014, -0.38, COL.tan, { mat: armor });
  box(body, 0.039, 0.010, 0.047, -0.004, -0.056, -0.375, COL.steel);
  // Uncage latch stays outside the round's path.
  box(bolt, 0.011, 0.027, 0.037, -0.071, axisY - 0.012, BOLT_HOME.archer, COL.steel, { rz: -0.22 });
  box(bolt, 0.014, 0.008, 0.022, -0.073, axisY + 0.003, BOLT_HOME.archer, HAZARD);

  const sights = new THREE.Group();
  sights.name = 'factory-optic';
  body.add(sights);
  // Slim posts on fixed bridges outside the lid, open centerline at SIGHT_Y.
  for (const [z, radius, stemBottom] of [[0.079, 0.010, 0.143], [-0.66, 0.026, 0.134]]) {
    const stemTop = SIGHT_Y - radius;
    box(sights, 0.010, stemTop - stemBottom, 0.014, 0, (stemTop + stemBottom) / 2, z, COL.steel);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(radius, 0.003, 4, 8), dark);
    ring.rotation.z = Math.PI / 8;
    ring.position.set(0, SIGHT_Y, z);
    sights.add(ring);
  }
  const lockLamp = box(sights, 0.006, 0.005, 0.006, 0, SIGHT_Y + 0.025, -0.66, CYAN, { mat: lamp });
  lockLamp.name = 'archer_lock_lamp';

  const seat = new THREE.Vector3(0, axisY, -0.26);
  const chambered = rocket(extra, kit, 'archer_chambered_rocket');
  chambered.position.copy(seat);
  const round = rocket(extra, kit, 'archer_reload_rocket');
  round.position.copy(seat);
  round.userData.homePosition = seat.clone();
  round.visible = false;
  extra.userData.archer = { sights, lockLamp, gate, hinge, round, chambered, axisY, seat, authoritativeMag: 1, reloading: false };
  return true;
}
