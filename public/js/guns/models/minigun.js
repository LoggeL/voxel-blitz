import * as THREE from '../../vendor/three.module.js';
import { COL } from '../kit.js';

export function build({ kit, T, groups: { body, mag, trigger } }) {
  const { box, cylZ, mat, ironSights } = kit;
  const axisY = T.muzzle[1];
  // The stepped motor sits below the sight line: the rotating tubes remain visible
  // from the player's shoulder instead of disappearing behind a tall receiver lid.
  cylZ(body, 0.065, 0.23, 0, -0.015, -0.19, COL.gunmetal, { seg: 8 });
  box(body, 0.083, 0.062, 0.13, 0, -0.025, -0.035, COL.polyDark);
  box(body, 0.15, 0.038, 0.18, 0, -0.064, -0.19, COL.steel);
  box(body, 0.068, 0.02, 0.16, 0, 0.059, -0.18, COL.olive);
  for (const x of [-0.078, 0.078]) {
    box(body, 0.012, 0.06, 0.15, x, 0.012, -0.20, COL.olive);
    for (let i = 0; i < 5; i++) {
      box(body, 0.014, 0.034, 0.009, x, 0.018, -0.145 - i * 0.024, COL.polymer);
    }
    for (const z of [-0.11, -0.29]) {
      box(body, 0.016, 0.015, 0.016, x, -0.015, z, COL.tan);
    }
  }
  for (const [z, radius, color] of [[-0.325, 0.083, COL.steel], [-0.344, 0.081, COL.amber]]) {
    const bearing = new THREE.Mesh(new THREE.TorusGeometry(radius, 0.009, 4, 12), mat(color));
    bearing.position.set(0, axisY, z);
    body.add(bearing);
  }
  box(body, 0.035, 0.085, 0.05, 0, -0.025, -0.325, COL.steel);

  // Offset carrying handle and two grips leave the central aim channel open.
  for (const z of [-0.11, -0.29]) box(body, 0.025, 0.075, 0.026, -0.10, 0.079, z, COL.steel);
  box(body, 0.034, 0.032, 0.205, -0.10, 0.118, -0.20, COL.polymer);
  for (let i = 0; i < 5; i++) box(body, 0.037, 0.035, 0.008, -0.10, 0.118, -0.14 - i * 0.029, COL.steel);
  box(body, 0.055, 0.13, 0.067, 0.025, -0.083, -0.075, COL.polymer, { rx: -0.18 });
  box(body, 0.068, 0.022, 0.078, 0.025, -0.145, -0.065, COL.steel);
  box(body, 0.028, 0.046, 0.21, -0.055, -0.025, -0.385, COL.steel);
  box(body, 0.052, 0.095, 0.06, -0.055, -0.045, -0.46, COL.polymer);
  box(body, 0.012, 0.045, 0.018, 0.025, -0.06, -0.133, COL.steel);
  box(body, 0.05, 0.012, 0.07, 0.025, -0.083, -0.11, COL.steel);
  box(trigger, 0.015, 0.03, 0.018, 0.025, -0.055, 0.018, COL.amber);
  ironSights(body, { rearZ: -0.09, frontZ: -0.32, height: -T.adsOffset.y, width: 0.046 });

  // Low ammunition drum, with a linked belt visible on the player's side.
  cylZ(mag, 0.108, 0.16, 0.015, -0.155, -0.23, COL.olive, { seg: 12 });
  for (const z of [-0.145, -0.315]) {
    cylZ(mag, 0.112, 0.018, 0.015, -0.155, z, COL.steel, { seg: 12 });
    cylZ(mag, 0.066, 0.02, 0.015, -0.155, z, COL.polyDark, { seg: 12 });
  }
  box(body, 0.052, 0.047, 0.085, -0.104, -0.027, -0.20, COL.steel);
  for (let i = 0; i < 9; i++) {
    const a = i / 8 * Math.PI * 0.78;
    const x = -0.12 - Math.sin(a) * 0.064;
    const y = -0.035 - i * 0.018;
    cylZ(body, 0.010, 0.079, x, y, -0.205, COL.brass, { seg: 6 });
    cylZ(body, 0.010, 0.026, x, y, -0.257, COL.tan, { seg: 6, rTop: 0.002 });
    box(body, 0.023, 0.009, 0.023, x, y, -0.183, COL.polyDark);
  }

  const rotor = new THREE.Group();
  rotor.name = 'minigun_rotor';
  rotor.position.y = axisY;
  body.add(rotor);
  const barrelMat = new THREE.MeshStandardMaterial({ color: COL.blued, roughness: 0.48, metalness: 0.75, flatShading: true });
  barrelMat.userData.thermal = true;
  const startZ = -0.35;
  const length = startZ - T.muzzle[2];
  cylZ(rotor, 0.019, length - 0.05, 0, 0, (startZ + T.muzzle[2]) / 2 + 0.025, COL.steel, { seg: 8 });
  for (let i = 0; i < 6; i++) {
    const a = i * Math.PI / 3;
    const x = Math.cos(a) * 0.061, y = Math.sin(a) * 0.061;
    const barrel = cylZ(rotor, 0.018, length, x, y, (startZ + T.muzzle[2]) / 2, COL.blued, { seg: 8, open: true });
    barrel.name = `minigun_barrel_${i}`;
    barrel.material = barrelMat;
    cylZ(rotor, 0.013, 0.006, x, y, T.muzzle[2] + 0.008, COL.polymer, { seg: 8 });
    cylZ(rotor, 0.021, 0.025, x, y, startZ - 0.015, COL.steel, { seg: 8 });
  }
  // Open polygonal collars expose the separate barrels and central drive shaft.
  for (const z of [-0.395, -0.66, T.muzzle[2] + 0.04]) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.08, 0.009, 4, 12), mat(COL.steel));
    ring.position.z = z;
    rotor.add(ring);
    for (let i = 0; i < 6; i++) {
      const a = i * Math.PI / 3;
      box(rotor, 0.012, 0.023, 0.018, Math.cos(a) * 0.069, Math.sin(a) * 0.069, z, COL.steel, { rz: a - Math.PI / 2 });
    }
  }
  // One amber index tooth makes rotation readable even at low spin speed.
  box(rotor, 0.02, 0.018, 0.027, 0, 0.085, -0.66, COL.amber);
}
