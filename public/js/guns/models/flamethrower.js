import * as THREE from '../../vendor/three.module.js';
import { COL } from '../kit.js';

export function build({ kit, T, groups: { body, mag, bolt, trigger } }) {
  const { box, cylZ, mat, ironSights } = kit;
  const orange = 0xea6b21;
  const cream = 0xd8c39b;
  const fuelRed = 0xad3024;
  const axisY = T.muzzle[1];

  // F-4 FIRESTORM: a compact pressure tool with a broad burner cage and underslung tank.
  box(body, 0.12, 0.108, 0.235, 0, 0.014, -0.16, COL.polyDark);
  box(body, 0.135, 0.023, 0.19, 0, 0.079, -0.166, cream);
  box(body, 0.141, 0.077, 0.11, 0, 0.014, -0.11, orange);
  box(body, 0.114, 0.021, 0.084, 0, 0.093, -0.122, orange);
  box(body, 0.13, 0.061, 0.07, 0, 0.024, -0.242, cream);
  box(body, 0.119, 0.065, 0.015, 0, 0.01, -0.042, COL.steel);
  for (const side of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      box(body, 0.009, 0.039, 0.011, side * 0.072, 0.018, -0.079 - i * 0.027, COL.polyDark);
    }
    box(body, 0.016, 0.013, 0.030, side * 0.071, 0.044, -0.246, COL.brass);
  }

  // Short mixing chamber, with an open eight-sided shield around the hot nozzle.
  cylZ(body, 0.045, 0.175, 0, axisY, -0.333, COL.steel, { seg: 8 });
  cylZ(body, 0.058, 0.024, 0, axisY, -0.291, COL.brass, { seg: 8 });
  cylZ(body, 0.060, 0.032, 0, axisY, -0.402, orange, { seg: 8 });
  const nozzleMaterial = new THREE.MeshStandardMaterial({
    color: 0x80664b, emissive: 0xff5818, emissiveIntensity: 0.04,
    roughness: 0.47, metalness: 0.75, flatShading: true,
  });
  nozzleMaterial.userData.flameThermal = true;
  const nozzle = cylZ(body, 0.044, 0.235, 0, axisY, T.muzzle[2] + 0.1175, 0, { seg: 8, open: true });
  nozzle.name = 'flamethrower_nozzle';
  nozzle.material = nozzleMaterial;
  cylZ(body, 0.031, 0.008, 0, axisY, T.muzzle[2] + 0.014, COL.polymer, { seg: 8 });
  for (const z of [-0.442, T.muzzle[2] + 0.027]) {
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.072, 0.012, 4, 8), mat(orange));
    rim.position.set(0, axisY, z);
    body.add(rim);
  }
  for (let i = 0; i < 8; i++) {
    const a = i * Math.PI / 4 + Math.PI / 8;
    box(body, 0.029, 0.013, 0.181, Math.cos(a) * 0.071, axisY + Math.sin(a) * 0.071,
      -0.535, i % 2 ? COL.steel : cream, { rz: a - Math.PI / 2 });
  }
  // Pilot sits outside the left shield edge, visible from the player's shoulder.
  cylZ(body, 0.011, 0.135, -0.112, axisY + 0.022, T.muzzle[2] + 0.060, COL.brass, { seg: 6 });
  box(body, 0.065, 0.021, 0.025, -0.083, axisY + 0.022, -0.55, COL.steel);
  const pilotMaterial = new THREE.MeshStandardMaterial({
    color: 0x8adfff, emissive: 0x33baff, emissiveIntensity: 1.6,
    roughness: 0.4, metalness: 0, flatShading: true,
  });
  pilotMaterial.userData.pilot = true;
  const pilot = cylZ(body, 0.011, 0.040, -0.125, axisY + 0.037, T.muzzle[2] - 0.032, 0,
    { seg: 6, rBot: 0.001 });
  pilot.name = 'flamethrower_pilot';
  pilot.material = pilotMaterial;
  pilot.rotation.set(0.35, 0.35, 0);

  box(body, 0.053, 0.139, 0.066, 0, -0.079, -0.077, COL.polyDark, { rx: -0.2 });
  box(body, 0.063, 0.017, 0.076, 0, -0.145, -0.064, orange);
  box(body, 0.016, 0.054, 0.015, 0, -0.051, -0.135, COL.steel);
  box(body, 0.05, 0.013, 0.061, 0, -0.079, -0.112, COL.steel);
  box(body, 0.048, 0.086, 0.061, -0.023, -0.045, -0.355, COL.polyDark);
  box(trigger, 0.014, 0.035, 0.012, 0, -0.035, -0.11, COL.brass);

  // One transverse red reservoir detaches as a complete magazine assembly during reload.
  const tank = new THREE.Group();
  tank.name = 'flamethrower_fuel_tank';
  tank.position.set(0, -0.136, -0.235);
  tank.rotation.y = Math.PI / 2;
  mag.add(tank);
  cylZ(tank, 0.080, 0.218, 0, 0, 0, fuelRed, { seg: 10 });
  for (const side of [-1, 1]) {
    const cap = cylZ(tank, 0.08, 0.033, 0, 0, side * 0.121, fuelRed,
      { seg: 10, rTop: side > 0 ? 0.048 : 0.08, rBot: side > 0 ? 0.08 : 0.048 });
    cap.name = `flamethrower_tank_end_${side}`;
    cylZ(tank, 0.083, 0.021, 0, 0, side * 0.069, COL.steel, { seg: 10 });
    cylZ(tank, 0.026, 0.030, 0, 0, side * 0.15, COL.brass, { seg: 8 });
    box(tank, 0.055, 0.008, 0.048, 0, 0.079, side * 0.029, cream);
  }
  box(mag, 0.196, 0.029, 0.074, 0, -0.06, -0.235, COL.steel);

  // Faceted hoses connect tank couplings to the manifold and mixing chamber.
  for (const side of [-1, 1]) {
    const points = [
      [side * 0.158, -0.136, -0.235], [side * 0.178, -0.097, -0.153],
      [side * 0.156, -0.039, -0.084], [side * 0.119, 0.011, -0.13],
      [side * 0.109, 0.013, -0.286], [side * 0.043, 0.035, -0.355],
    ];
    for (let i = 1; i < points.length; i++) {
      const a = new THREE.Vector3(...points[i - 1]);
      const b = new THREE.Vector3(...points[i]);
      const middle = a.clone().add(b).multiplyScalar(0.5);
      const hose = cylZ(body, 0.014, a.distanceTo(b) + 0.006, ...middle.toArray(), COL.polymer, { seg: 6 });
      hose.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), b.sub(a).normalize());
    }
    cylZ(body, 0.022, 0.033, side * 0.108, 0.012, -0.269, COL.brass, { seg: 6 });
  }

  // A rear-facing dial is readable by the player, with a separate animated needle.
  const dial = new THREE.Group();
  dial.name = 'flamethrower_pressure_gauge';
  dial.position.set(-0.08, 0.096, -0.036);
  dial.rotation.y = -0.20;
  body.add(dial);
  box(body, 0.024, 0.057, 0.032, -0.075, 0.06, -0.054, COL.brass);
  cylZ(dial, 0.045, 0.025, 0, 0, 0, COL.brass, { seg: 12 });
  cylZ(dial, 0.038, 0.008, 0, 0, 0.016, cream, { seg: 12 });
  for (let i = 0; i < 9; i++) {
    const a = 1.1 - i * 2.2 / 8;
    box(dial, 0.003, i % 2 ? 0.006 : 0.009, 0.003, -Math.sin(a) * 0.028, Math.cos(a) * 0.028,
      0.022, i < 2 ? fuelRed : COL.polyDark, { rz: a });
  }
  const needle = new THREE.Group();
  needle.name = 'flamethrower_pressure_needle';
  needle.position.z = 0.026;
  needle.userData.minAngle = 1.1;
  needle.userData.maxAngle = -1.1;
  needle.rotation.z = needle.userData.maxAngle;
  dial.add(needle);
  box(needle, 0.004, 0.028, 0.003, 0, 0.010, 0, fuelRed);
  cylZ(dial, 0.006, 0.006, 0, 0, 0.030, COL.polyDark, { seg: 8 });
  box(bolt, 0.019, 0.013, 0.05, 0.077, 0.061, -0.094, COL.brass);
  box(bolt, 0.041, 0.024, 0.017, 0.077, 0.061, -0.073, orange);
  ironSights(body, { rearZ: -0.16, frontZ: -0.438, height: -T.adsOffset.y, width: 0.032, gap: 0.016, accent: cream });
}
