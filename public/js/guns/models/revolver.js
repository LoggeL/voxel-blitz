import * as THREE from '../../vendor/three.module.js';
import { COL } from '../kit.js';
import { TRIGGER_Z } from './common.js';

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

/** Build the IRONCLAD .44 as a six-shot, swing-out-cylinder revolver. */
export function build({ kit, T, groups }) {
  const { box, cylZ, ironSights, mat } = kit;
  const { body, mag, bolt, trigger, extra } = groups;
  const metal = mat(COL.gunmetal, 0.50, 0.68);
  const walnut = mat(COL.walnut, 0.86, 0.08);
  const amber = mat(COL.amber, 0.47, 0.48);

  // Separate frame straps leave an actual opening around the cylinder. There is no slide.
  profilePlate(body, [
    [0.040, 0.068], [-0.075, 0.068], [-0.080, -0.029],
    [-0.045, -0.050], [0.025, -0.023],
  ], 0.052, metal);
  box(body, 0.048, 0.014, 0.172, 0, 0.075, -0.126, COL.blued);
  box(body, 0.034, 0.014, 0.145, 0, -0.052, -0.140, COL.gunmetal);
  box(body, 0.042, 0.104, 0.018, 0, 0.014, -0.205, COL.gunmetal);

  // A round, exposed long barrel and slender ejector-rod shroud create the revolver profile.
  const barrelTip = T.muzzle[2];
  const barrelRear = -0.205;
  cylZ(body, 0.027, barrelRear - barrelTip, 0, T.muzzle[1],
    (barrelRear + barrelTip) / 2, COL.blued, { seg: 12, rg: 0.38, mt: 0.8 });
  box(body, 0.027, 0.013, 0.300, 0, 0.069, -0.360, COL.gunmetal);
  cylZ(body, 0.014, 0.216, 0, -0.004, -0.315, COL.gunmetal, { seg: 10 });
  cylZ(body, 0.030, 0.012, 0, T.muzzle[1], barrelTip + 0.006,
    COL.gunmetal, { seg: 12 });
  cylZ(body, 0.018, 0.003, 0, T.muzzle[1], barrelTip + 0.001,
    COL.polyDark, { seg: 12 });
  box(body, 0.026, 0.020, 0.025, 0, 0.081, barrelTip + 0.035, COL.blued);

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

  // Crane pivots about the bore-parallel hinge below the cylinder; the drum spins on
  // its own centerline. Reload swing and firing index therefore never orbit the gun origin.
  const crane = new THREE.Group();
  crane.name = 'cylinderCrane';
  crane.position.set(0, -0.052, -0.145);
  mag.add(crane);
  box(crane, 0.015, 0.060, 0.016, 0, 0.030, -0.049, COL.gunmetal);
  cylZ(crane, 0.009, 0.151, 0, 0.058, -0.028, COL.gunmetal, { seg: 10 });
  const cylinder = new THREE.Group();
  cylinder.name = 'cylinder';
  cylinder.position.y = 0.058;
  crane.add(cylinder);
  cylZ(cylinder, 0.057, 0.090, 0, 0, 0, COL.gunmetal,
    { seg: 18, rg: 0.38, mt: 0.78 });
  cylZ(cylinder, 0.059, 0.006, 0, 0, 0.046, COL.blued, { seg: 18 });
  const cases = new THREE.Group();
  cases.name = 'cartridgeCases';
  cylinder.add(cases);
  for (let i = 0; i < 6; i++) {
    const angle = Math.PI / 2 + i * Math.PI / 3;
    const x = Math.cos(angle) * 0.034;
    const y = Math.sin(angle) * 0.034;
    // Dark chamber mouths remain visible when the cartridges are extracted.
    cylZ(cylinder, 0.011, 0.096, x, y, 0, COL.fluteDark, { seg: 10 });
    cylZ(cases, 0.009, 0.066, x, y, 0.012, COL.brass, { seg: 10 });
    cylZ(cases, 0.0105, 0.004, x, y, 0.050, COL.brass, { seg: 10 });
    cylZ(cases, 0.0035, 0.005, x, y, 0.051, COL.gunmetal, { seg: 8 });
    // Long radial flute panels follow the drum rather than a square slide silhouette.
    box(cylinder, 0.021, 0.003, 0.062, Math.cos(angle) * 0.056,
      Math.sin(angle) * 0.056, 0, COL.fluteDark, { rz: angle - Math.PI / 2 });
  }
  const ejector = new THREE.Group();
  ejector.name = 'ejectorRod';
  cylinder.add(ejector);
  cylZ(ejector, 0.006, 0.160, 0, 0, -0.025, COL.gunmetal, { seg: 10 });
  cylZ(ejector, 0.020, 0.006, 0, 0, 0.051, COL.blued, { seg: 6 });
  extra.userData.revolver = { crane, cylinder, cases, ejector };

  // Swept wooden grip: broad at the frame, swept rearward at the heel, with a dark
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

  // The hammer rotates about its pin, below the rear sight, instead of translating a slide.
  const hammer = new THREE.Group();
  hammer.name = 'hammer';
  hammer.position.set(0, 0.024, 0.016);
  bolt.add(hammer);
  box(hammer, 0.021, 0.035, 0.018, 0, 0.018, 0, COL.gunmetal);
  box(hammer, 0.029, 0.009, 0.027, 0, 0.033, 0.012, COL.blued);
  extra.userData.revolver.hammer = hammer;
  // A proper open trigger guard replaces the old solid shelf and exposes the amber trigger.
  box(trigger, 0.010, 0.042, 0.010, 0, -0.036, TRIGGER_Z.revolver, COL.amber,
    { rx: 0.32, rg: 0.45, mt: 0.56 });
  box(body, 0.054, 0.008, 0.088, 0, -0.088, -0.081, COL.gunmetal,
    { rg: 0.48, mt: 0.68 });
  box(body, 0.054, 0.066, 0.008, 0, -0.058, -0.126, COL.gunmetal,
    { rx: -0.28, rg: 0.48, mt: 0.68 });
  box(body, 0.054, 0.056, 0.008, 0, -0.061, -0.038, COL.gunmetal,
    { rx: 0.35, rg: 0.48, mt: 0.68 });

  // Six speed-loader rounds share the cylinder chamber radius and approach from behind.
  const loader = new THREE.Group();
  loader.name = 'speedloader';
  for (let i = 0; i < 6; i++) {
    const angle = i * Math.PI / 3;
    cylZ(loader, 0.007, 0.045, Math.cos(angle + Math.PI / 2) * 0.034, Math.sin(angle + Math.PI / 2) * 0.034,
      0, COL.brass, { seg: 8, rg: 0.38, mt: 0.74 });
  }
  cylZ(loader, 0.010, 0.020, 0, 0, 0.025, COL.polymer, { seg: 10 });
  loader.position.set(-0.058, -0.052, 0.025);
  loader.userData.homePosition = loader.position.clone();
  loader.visible = false;
  extra.add(loader);
  extra.userData.reloadRounds = loader;
}
