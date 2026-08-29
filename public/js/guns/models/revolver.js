import * as THREE from '../../vendor/three.module.js';
import { COL } from '../kit.js';
import { BREACH_Z, BOLT_HOME, TRIGGER_Z } from './common.js';

// Extrude a reference-profile polygon across local X. This keeps the unmistakable stepped
// side silhouette while still giving the remote-avatar model real thickness and lighting.
function profilePlate(parent, points, width, material) {
  const shape = new THREE.Shape();
  shape.moveTo(-points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) shape.lineTo(-points[i][0], points[i][1]);
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: width,
    bevelEnabled: false,
    curveSegments: 1,
  });
  geometry.rotateY(Math.PI / 2);
  geometry.translate(-width / 2, 0, 0);
  const mesh = new THREE.Mesh(geometry, material);
  parent.add(mesh);
  return mesh;
}

function cylX(parent, radius, length, x, y, z, material, segments = 10) {
  const geometry = new THREE.CylinderGeometry(radius, radius, length, segments, 1);
  geometry.rotateZ(Math.PI / 2);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(x, y, z);
  parent.add(mesh);
  return mesh;
}

/** Build the IRONCLAD .44 around its chunky six-shot HUD-reference silhouette. */
export function build({ kit, T, groups }) {
  const { box, cylZ, ironSights, mat } = kit;
  const { body, mag, bolt, trigger, extra } = groups;
  const metal = mat(COL.gunmetal, 0.50, 0.68);
  const darkMetal = mat(COL.blued, 0.42, 0.78);
  const walnut = mat(COL.walnut, 0.86, 0.08);
  const amber = mat(COL.amber, 0.47, 0.48);

  // One deep, angular frame gives the gun the same massive upper bridge and dropped trigger
  // shelf as the reference. The oversized cylinder projects beyond it on both sides.
  profilePlate(body, [
    [0.045, 0.083], [-0.185, 0.083], [-0.220, 0.060], [-0.212, -0.026],
    [-0.158, -0.052], [-0.042, -0.052], [0.018, -0.018], [0.055, 0.030],
  ], 0.072, metal);
  box(body, 0.078, 0.020, 0.222, 0, 0.087, -0.075, COL.blued,
    { rg: 0.42, mt: 0.78 });
  box(body, 0.060, 0.018, 0.126, 0, -0.045, -0.101, COL.polyDark,
    { rg: 0.64, mt: 0.35 });
  box(body, 0.080, 0.018, 0.034, 0, 0.052, -0.209, COL.gunmetal,
    { rx: -0.32, rg: 0.48, mt: 0.70 });

  // Long slab-sided barrel, full underlug and inset side flats. Its forward faces and the bore
  // terminate exactly at T.muzzle, so muzzle flash/heat geometry keep their canonical anchor.
  const barrelTip = T.muzzle[2];
  profilePlate(body, [
    [BREACH_Z.revolver, 0.087], [barrelTip + 0.020, 0.087], [barrelTip, 0.069],
    [barrelTip, 0.006], [barrelTip + 0.022, -0.010], [BREACH_Z.revolver, -0.010],
  ], 0.074, darkMetal);
  box(body, 0.078, 0.014, 0.292, 0, 0.092, -0.348, COL.gunmetal,
    { rg: 0.46, mt: 0.72 });
  box(body, 0.080, 0.025, 0.296, 0, -0.018, -0.346, COL.gunmetal,
    { rg: 0.50, mt: 0.66 });
  for (const side of [-1, 1]) {
    box(body, 0.005, 0.046, 0.235, side * 0.0395, 0.040, -0.350, COL.polyDark,
      { rg: 0.62, mt: 0.38 });
    box(body, 0.006, 0.009, 0.245, side * 0.041, 0.071, -0.348, COL.gunmetal,
      { rg: 0.47, mt: 0.70 });
  }
  const barrelLength = Math.abs(barrelTip - BREACH_Z.revolver);
  cylZ(body, 0.017, barrelLength, T.muzzle[0], T.muzzle[1],
    (barrelTip + BREACH_Z.revolver) / 2, COL.brake, { seg: 12, rg: 0.38, mt: 0.82 });
  cylZ(body, 0.031, 0.018, T.muzzle[0], T.muzzle[1], barrelTip + 0.009,
    COL.gunmetal, { seg: 12, rg: 0.43, mt: 0.76 });
  cylZ(body, 0.021, 0.006, T.muzzle[0], T.muzzle[1], barrelTip + 0.003,
    COL.polyDark, { seg: 12, rg: 0.68, mt: 0.30 });
  box(body, 0.050, 0.008, 0.030, 0, 0.095, barrelTip + 0.025, COL.amber,
    { rg: 0.47, mt: 0.50 });

  // Open sights stay on the existing 0.105 ADS axis; neither the hammer nor the top rib crosses
  // the center gap, including while the hammer cycles.
  ironSights(body, {
    rearZ: 0.012,
    frontZ: barrelTip + 0.035,
    height: 0.105,
    width: 0.046,
    gap: 0.014,
    color: COL.polyDark,
    accent: COL.amber,
  });

  // The rotating group contains the entire six-shot cylinder, its chamber flutes and ejector.
  // Keeping all of it under `mag` preserves swing-out reload and 60-degree firing rotation.
  cylZ(mag, 0.056, 0.090, 0, 0.025, -0.145, COL.gunmetal,
    { seg: 12, rg: 0.44, mt: 0.72 });
  cylZ(mag, 0.058, 0.007, 0, 0.025, -0.1035, COL.brass,
    { seg: 12, rg: 0.40, mt: 0.72 });
  cylZ(mag, 0.058, 0.007, 0, 0.025, -0.1865, COL.blued,
    { seg: 12, rg: 0.40, mt: 0.76 });
  for (let i = 0; i < 6; i++) {
    const angle = i * Math.PI / 3;
    cylZ(mag, 0.0105, 0.094, Math.cos(angle) * 0.034,
      0.025 + Math.sin(angle) * 0.034, -0.145, COL.fluteDark,
      { seg: 8, rg: 0.66, mt: 0.32 });
  }
  // Broad stepped flutes remain readable from the third-person side view instead of looking
  // like a featureless wheel.
  for (const side of [-1, 1]) {
    for (const y of [0.000, 0.025, 0.050]) {
      box(mag, 0.004, 0.012, 0.050, side * 0.056, y, -0.145, COL.polyDark,
        { rg: 0.68, mt: 0.30 });
    }
  }
  cylZ(mag, 0.014, 0.104, 0, 0.025, -0.145, COL.brass,
    { seg: 10, rg: 0.40, mt: 0.72 });

  // Crane and ejector hardware sit outside the frame, like the orange-backed assembly in the
  // reference, but remain static so the established reload choreography stays unchanged.
  for (const side of [-1, 1]) {
    box(body, 0.010, 0.018, 0.105, side * 0.061, 0.003, -0.145, COL.gunmetal,
      { rg: 0.48, mt: 0.70 });
    box(body, 0.012, 0.030, 0.018, side * 0.061, -0.009, -0.098, COL.brass,
      { rg: 0.42, mt: 0.68 });
  }

  // Reference-shaped grip: broad at the frame, swept rearward at the heel, with a dark
  // backstrap, orange butt cap, grip panels, checker blocks and visible fasteners.
  profilePlate(body, [
    [-0.052, -0.010], [0.025, -0.010], [0.069, -0.142], [0.050, -0.165],
    [-0.020, -0.153], [-0.047, -0.070],
  ], 0.070, walnut);
  box(body, 0.074, 0.013, 0.074, 0, -0.158, 0.015, COL.polyDark,
    { rx: 0.18, rg: 0.76, mt: 0.25 });
  box(body, 0.076, 0.008, 0.074, 0, -0.164, 0.017, COL.amber,
    { rx: 0.18, rg: 0.50, mt: 0.45 });
  box(body, 0.076, 0.122, 0.011, 0, -0.084, 0.046, COL.polyDark,
    { rx: 0.30, rg: 0.72, mt: 0.28 });
  for (const side of [-1, 1]) {
    for (let row = 0; row < 3; row++) {
      box(body, 0.004, 0.019, 0.022, side * 0.037, -0.054 - row * 0.032,
        0.006 + row * 0.010, row % 2 ? COL.walnut : 0x704421,
        { rx: 0.30, rg: 0.88, mt: 0.04 });
    }
    cylX(body, 0.007, 0.006, side * 0.038, -0.087, 0.018, amber, 10);
  }

  // Hammer remains fully animated via `bolt`, but is forked around the open sight line.
  box(bolt, 0.046, 0.030, 0.024, 0, 0.066, BOLT_HOME.revolver, COL.gunmetal,
    { rx: -0.36, rg: 0.48, mt: 0.70 });
  for (const side of [-1, 1]) {
    box(bolt, 0.015, 0.010, 0.030, side * 0.019, 0.092,
      BOLT_HOME.revolver + 0.013, COL.brass, { rg: 0.42, mt: 0.70 });
  }
  // A proper open trigger guard replaces the old solid shelf and exposes the amber trigger.
  box(trigger, 0.010, 0.042, 0.010, 0, -0.036, TRIGGER_Z.revolver, COL.amber,
    { rx: 0.32, rg: 0.45, mt: 0.56 });
  box(body, 0.054, 0.008, 0.088, 0, -0.088, -0.081, COL.gunmetal,
    { rg: 0.48, mt: 0.68 });
  box(body, 0.054, 0.066, 0.008, 0, -0.058, -0.126, COL.gunmetal,
    { rx: -0.28, rg: 0.48, mt: 0.68 });
  box(body, 0.054, 0.056, 0.008, 0, -0.061, -0.038, COL.gunmetal,
    { rx: 0.35, rg: 0.48, mt: 0.68 });

  // Six visible speed-loader rounds retain the exact reload handle and home-position contract.
  const loader = new THREE.Group();
  loader.name = 'speedloader';
  for (let i = 0; i < 6; i++) {
    const angle = i * Math.PI / 3;
    cylZ(loader, 0.007, 0.045, Math.cos(angle) * 0.024, Math.sin(angle) * 0.024,
      0, COL.brass, { seg: 8, rg: 0.38, mt: 0.74 });
  }
  cylZ(loader, 0.010, 0.020, 0, 0, 0.025, COL.polymer, { seg: 10 });
  loader.position.set(-0.10, 0.04, -0.145);
  loader.userData.homePosition = loader.position.clone();
  loader.visible = false;
  extra.add(loader);
  extra.userData.reloadRounds = loader;
}
