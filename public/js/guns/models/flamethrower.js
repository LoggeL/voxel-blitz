import * as THREE from '../../vendor/three.module.js';
import { COL } from '../kit.js';

export function build({ kit, T, groups }) {
  const { box, cylZ, ironSights } = kit;
  const { body, mag, bolt, trigger } = groups;
  const orange = 0xff7518;
  const fuelRed = 0xb92e18;

  // Broad pressure housing and heat shield give the burner an industrial silhouette.
  box(body, 0.13, 0.14, 0.3, 0, 0.055, -0.15, COL.gunmetal);
  box(body, 0.145, 0.035, 0.22, 0, 0.125, -0.15, COL.brake);
  box(body, 0.148, 0.065, 0.105, 0, 0.04, -0.195, orange);
  for (const x of [-0.076, 0.076]) {
    for (let i = 0; i < 3; i++) {
      box(body, 0.005, 0.035, 0.009, x, 0.04, -0.16 - i * 0.024, COL.polymer);
    }
  }
  cylZ(body, 0.041, 0.56, 0, 0.075, -0.50, COL.steel);
  for (let i = 0; i < 6; i++) {
    cylZ(body, 0.051, 0.018, 0, 0.075, -0.34 - i * 0.075, i % 2 ? COL.gunmetal : orange);
  }
  // Open collar, dark recessed bore and a small pilot burner below the actual muzzle.
  cylZ(body, 0.057, 0.046, 0, T.muzzle[1], T.muzzle[2] + 0.026, COL.brass, { open: true });
  cylZ(body, 0.038, 0.009, 0, T.muzzle[1], T.muzzle[2] + 0.007, COL.polymer);
  cylZ(body, 0.013, 0.1, 0, 0.009, -0.726, COL.brass);
  cylZ(body, 0.008, 0.012, 0, 0.009, -0.779, orange);
  box(body, 0.026, 0.065, 0.022, 0, 0.035, -0.691, COL.brake);

  box(body, 0.055, 0.15, 0.065, 0, -0.07, -0.08, COL.polyDark, { rx: -0.2 });
  box(body, 0.048, 0.1, 0.05, 0, -0.025, -0.40, COL.polyDark);
  // The paired removable pressure canisters share the magazine animation.
  for (const x of [-0.075, 0.075]) {
    cylZ(mag, 0.063, 0.25, x, -0.095, -0.22, fuelRed);
    cylZ(mag, 0.063, 0.037, x, -0.095, -0.076, fuelRed, { rTop: 0.026 });
    cylZ(mag, 0.063, 0.032, x, -0.095, -0.36, fuelRed, { rBot: 0.027 });
    for (const z of [-0.13, -0.3]) cylZ(mag, 0.066, 0.018, x, -0.095, z, COL.steel);
    cylZ(mag, 0.024, 0.025, x, -0.095, -0.044, COL.brass);
    box(mag, 0.008, 0.028, 0.052, x + Math.sign(x) * 0.063, -0.088, -0.21, 0xe4bd77);
  }

  // Armoured fuel hoses remain attached to the gun's manifold during a tank swap.
  for (const side of [-1, 1]) {
    const points = [
      [side * 0.075, -0.095, -0.026], [side * 0.137, -0.078, -0.025],
      [side * 0.158, -0.035, -0.11], [side * 0.15, -0.012, -0.27],
      [side * 0.102, 0.005, -0.37], [side * 0.043, 0.025, -0.41],
    ];
    for (let i = 1; i < points.length; i++) {
      const a = new THREE.Vector3(...points[i - 1]);
      const b = new THREE.Vector3(...points[i]);
      const midpoint = a.clone().add(b).multiplyScalar(0.5);
      const hose = cylZ(body, 0.013, a.distanceTo(b) + 0.007, ...midpoint.toArray(), COL.polymer, { seg: 8 });
      hose.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), b.sub(a).normalize());
    }
  }
  // Twin side gauges are readable both in first person and on the selection icon.
  for (const side of [-1, 1]) {
    const gauge = cylZ(body, 0.027, 0.012, side * 0.08, 0.087, -0.067, COL.brass);
    gauge.rotation.y = Math.PI / 2;
    const face = cylZ(body, 0.022, 0.013, side * 0.086, 0.087, -0.067, 0xe7d8ad);
    face.rotation.y = Math.PI / 2;
    box(body, 0.003, 0.024, 0.004, side * 0.095, 0.091, -0.069, fuelRed, { rx: 0.5 });
  }
  box(bolt, 0.035, 0.035, 0.045, 0.077, 0.075, -0.1, orange);
  box(trigger, 0.014, 0.035, 0.012, 0, -0.035, -0.11, COL.steel);
  ironSights(body, { rearZ: -0.02, frontZ: -0.64, height: 0.175, width: 0.04, gap: 0.016 });
  body.userData.sightHeight = 0.175;
}
