import * as THREE from '../../vendor/three.module.js';
import { COL } from '../kit.js';

export function build({ kit, T, groups: { body, mag, trigger } }) {
  const { box, cylZ, mat, ironSights } = kit;
  const axisY = T.muzzle[1];
  const armor = 0x62694a;
  const edge = 0x889071;

  // M-6 FURNACE: a low, stepped drive unit behind an exposed six-barrel rotor.
  // The shoulder sees over the motor, with a clear gap between the upper tubes.
  cylZ(body, 0.067, 0.22, 0, -0.007, -0.195, COL.gunmetal, { seg: 8 });
  box(body, 0.113, 0.076, 0.085, 0, -0.021, -0.041, COL.polyDark);
  box(body, 0.15, 0.034, 0.23, 0, -0.073, -0.165, COL.steel);
  box(body, 0.109, 0.018, 0.16, 0, 0.061, -0.19, armor);
  box(body, 0.075, 0.016, 0.055, 0, 0.044, -0.072, armor);
  box(body, 0.016, 0.008, 0.145, 0.047, 0.072, -0.19, edge);
  for (const x of [-0.075, 0.075]) {
    box(body, 0.016, 0.084, 0.185, x, -0.006, -0.19, armor);
    for (let i = 0; i < 5; i++) {
      box(body, 0.019, 0.047, 0.012, x, 0.004, -0.126 - i * 0.028, COL.polyDark);
      box(body, 0.020, 0.008, 0.012, x, 0.031, -0.126 - i * 0.028, edge);
    }
    for (const z of [-0.107, -0.28]) box(body, 0.020, 0.014, 0.014, x, -0.022, z, COL.tan);
  }
  cylZ(body, 0.084, 0.038, 0, axisY, -0.325, COL.steel, { seg: 12, open: true });
  const bearing = new THREE.Mesh(new THREE.TorusGeometry(0.079, 0.007, 4, 12), mat(COL.brass));
  bearing.position.set(0, axisY, -0.349);
  body.add(bearing);
  box(body, 0.053, 0.062, 0.064, 0, -0.042, -0.315, armor);

  // The carry handle sits outside the rotor, leaving the aim channel open.
  for (const z of [-0.10, -0.265]) box(body, 0.02, 0.065, 0.023, -0.107, 0.04, z, COL.steel);
  box(body, 0.032, 0.028, 0.19, -0.107, 0.079, -0.183, COL.polymer);
  for (let i = 0; i < 4; i++) box(body, 0.035, 0.030, 0.009, -0.107, 0.079, -0.13 - i * 0.037, COL.gunmetal);
  box(body, 0.055, 0.13, 0.067, 0.025, -0.089, -0.073, COL.polymer, { rx: -0.18 });
  box(body, 0.067, 0.020, 0.080, 0.025, -0.151, -0.064, armor);
  box(body, 0.028, 0.035, 0.20, -0.055, -0.031, -0.39, COL.steel);
  box(body, 0.051, 0.091, 0.06, -0.055, -0.064, -0.46, COL.polymer);
  box(body, 0.012, 0.044, 0.018, 0.025, -0.062, -0.133, COL.steel);
  box(body, 0.05, 0.012, 0.069, 0.025, -0.085, -0.112, COL.steel);
  box(trigger, 0.015, 0.03, 0.018, 0.025, -0.055, 0.018, COL.amber);
  ironSights(body, { rearZ: -0.085, frontZ: -0.327, height: -T.adsOffset.y, width: 0.04 });

  // Player-facing temperature cells belong to this rig, never the material cache.
  box(body, 0.088, 0.035, 0.013, -0.014, 0.033, -0.015, COL.steel);
  for (let i = 0; i < 5; i++) {
    const material = new THREE.MeshStandardMaterial({
      color: 0x362e20, emissive: 0xff6416, emissiveIntensity: 0.04,
      roughness: 0.45, metalness: 0.25, flatShading: true,
    });
    material.userData.heatIndicator = (i + 1) / 5;
    const indicator = box(body, 0.011, 0.019, 0.006, -0.045 + i * 0.015, 0.033, -0.006, 0, { mat: material });
    indicator.name = `minigun_heat_indicator_${i}`;
  }

  // A deep drum and bowed brass belt make the weight legible from the shoulder.
  cylZ(mag, 0.112, 0.17, 0.002, -0.154, -0.225, armor, { seg: 12 });
  for (const z of [-0.134, -0.316]) {
    cylZ(mag, 0.116, 0.018, 0.002, -0.154, z, COL.steel, { seg: 12 });
    cylZ(mag, 0.084, 0.022, 0.002, -0.154, z, armor, { seg: 12 });
    cylZ(mag, 0.038, 0.026, 0.002, -0.154, z, COL.polyDark, { seg: 8 });
  }
  box(mag, 0.128, 0.024, 0.020, 0.002, -0.154, -0.119, COL.tan);
  box(body, 0.056, 0.043, 0.083, -0.11, -0.024, -0.20, COL.steel);
  for (let i = 0; i < 9; i++) {
    const a = i / 8 * Math.PI * 0.78;
    const x = -0.126 - Math.sin(a) * 0.055;
    const y = -0.033 - i * 0.018;
    cylZ(body, 0.011, 0.082, x, y, -0.203, COL.brass, { seg: 6 });
    cylZ(body, 0.011, 0.027, x, y, -0.257, COL.tan, { seg: 6, rBot: 0.002 });
    box(body, 0.024, 0.009, 0.022, x, y, -0.179, COL.polyDark);
  }

  const rotor = new THREE.Group();
  rotor.name = 'minigun_rotor';
  rotor.position.y = axisY;
  body.add(rotor);
  const barrelMat = new THREE.MeshStandardMaterial({
    color: 0x4c535a, roughness: 0.48, metalness: 0.75, flatShading: true,
  });
  barrelMat.userData.thermal = true;
  const startZ = -0.35;
  const length = startZ - T.muzzle[2];
  cylZ(rotor, 0.016, length - 0.02, 0, 0, (startZ + T.muzzle[2]) / 2 + 0.01, COL.polyDark, { seg: 8 });
  for (let i = 0; i < 6; i++) {
    const a = i * Math.PI / 3;
    const x = Math.cos(a) * 0.062, y = Math.sin(a) * 0.062;
    const barrel = cylZ(rotor, 0.017, length, x, y, (startZ + T.muzzle[2]) / 2, 0, { seg: 8, open: true });
    barrel.name = `minigun_barrel_${i}`;
    barrel.material = barrelMat;
    cylZ(rotor, 0.021, 0.030, x, y, T.muzzle[2] + 0.015, COL.steel, { seg: 8, open: true });
    cylZ(rotor, 0.011, 0.006, x, y, T.muzzle[2] + 0.006, COL.polymer, { seg: 8 });
    cylZ(rotor, 0.021, 0.038, x, y, startZ - 0.019, COL.gunmetal, { seg: 8 });
  }
  // Two open collars leave a long uninterrupted span of independent steel tubes.
  for (const z of [-0.415, T.muzzle[2] + 0.064]) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.081, 0.008, 4, 12), mat(COL.steel));
    ring.position.z = z;
    rotor.add(ring);
    for (let i = 0; i < 6; i++) {
      const a = i * Math.PI / 3;
      box(rotor, 0.012, 0.023, 0.018, Math.cos(a) * 0.070, Math.sin(a) * 0.070, z, COL.steel, { rz: a - Math.PI / 2 });
    }
  }
  box(rotor, 0.021, 0.017, 0.026, 0, 0.086, T.muzzle[2] + 0.064, COL.amber);
}
