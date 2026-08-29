import * as THREE from '../../vendor/three.module.js';
import { COL } from '../kit.js';
import { BREACH_Z, BOLT_HOME, TRIGGER_Z } from './common.js';

/** Build the belt-fed heavy support gun shown by assets/weapons/hud/lmg.png. */
export function build({ kit, T, groups }) {
  const { mat, box, cylZ, brakeRings } = kit;
  const { body: b, mag: mg, bolt, trigger: tg, extra } = groups;

  // Repeated detail is instanced so the extra fidelity does not turn every vent/link into a
  // separate draw call on remote-player models.
  function instancedBoxes(parent, dimensions, color, transforms) {
    const mesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(...dimensions),
      mat(color),
      transforms.length,
    );
    const dummy = new THREE.Object3D();
    transforms.forEach(({ x, y, z, rx = 0, ry = 0, rz = 0 }, index) => {
      dummy.position.set(x, y, z);
      dummy.rotation.set(rx, ry, rz);
      dummy.updateMatrix();
      mesh.setMatrixAt(index, dummy.matrix);
    });
    parent.add(mesh);
    return mesh;
  }

  // Stepped, reinforced shoulder stock. The orange heel and cheek-line are the quickest
  // identifiers in the HUD reference, so they remain readable even at avatar scale.
  box(b, 0.092, 0.108, 0.155, 0, 0.010, 0.155, COL.polymer);
  box(b, 0.102, 0.082, 0.092, 0, -0.002, 0.245, COL.polyDark, { rx: -0.10 });
  box(b, 0.108, 0.096, 0.025, 0, -0.004, 0.298, COL.amber);
  box(b, 0.114, 0.066, 0.014, 0, -0.004, 0.302, COL.polyDark);
  box(b, 0.086, 0.036, 0.106, 0, 0.080, 0.205, COL.gunmetal);
  box(b, 0.070, 0.016, 0.090, 0, 0.104, 0.200, COL.amber);
  box(b, 0.060, 0.020, 0.070, 0, -0.055, 0.178, COL.polyDark, { rx: -0.24 });

  // Massive receiver and feed housing, layered rather than represented by one plain cuboid.
  box(b, 0.132, 0.145, 0.315, 0, 0.020, -0.040, COL.parkerized);
  box(b, 0.138, 0.052, 0.260, 0, 0.112, -0.075, COL.gunmetal);
  // Twin feed-cover rails leave the x=0 / y=.155 bore line open. A solid plate here looked
  // correct from the side but hid the target marker when viewed through the rear notch.
  box(b, 0.045, 0.012, 0.235, -0.036, 0.142, -0.078, COL.polyDark);
  box(b, 0.045, 0.012, 0.235, 0.036, 0.142, -0.078, COL.polyDark);
  box(b, 0.039, 0.012, 0.190, -0.034, 0.174, -0.080, COL.amber);
  box(b, 0.039, 0.012, 0.190, 0.034, 0.174, -0.080, COL.amber);
  box(b, 0.142, 0.036, 0.075, 0, 0.050, 0.105, COL.gunmetal);
  box(b, 0.142, 0.035, 0.085, 0, -0.025, -0.185, COL.polyDark);
  box(b, 0.138, 0.016, 0.026, 0, 0.055, 0.105, COL.amber);
  // Side service panels / latch details are intentionally asymmetric like the reference.
  box(b, 0.012, 0.052, 0.145, -0.072, 0.046, -0.030, COL.gunmetal);
  box(b, 0.014, 0.025, 0.048, -0.075, 0.042, -0.105, COL.amber);
  box(b, 0.014, 0.022, 0.055, -0.075, 0.030, 0.030, COL.polyDark);

  // Deep pistol grip with a bright lower edge and a proper guard around the moving trigger.
  box(b, 0.070, 0.120, 0.065, 0.006, -0.090, 0.060, COL.polymer, { rx: 0.28 });
  box(b, 0.076, 0.018, 0.054, 0.006, -0.150, 0.075, COL.amber, { rx: 0.28 });
  box(b, 0.080, 0.012, 0.090, 0, -0.040, -0.008, COL.polyDark);
  box(b, 0.018, 0.058, 0.012, 0, -0.066, -0.050, COL.polyDark, { rx: 0.30 });

  // Long perforated handguard over the gas system.
  box(b, 0.128, 0.105, 0.275, 0, 0.034, -0.320, COL.olive);
  box(b, 0.136, 0.022, 0.292, 0, 0.094, -0.322, COL.parkerized);
  box(b, 0.118, 0.018, 0.280, 0, -0.024, -0.322, COL.polyDark);
  const ventZ = Array.from({ length: 4 }, (_, i) => -0.235 - i * 0.060);
  instancedBoxes(b, [0.014, 0.026, 0.034], COL.fluteDark,
    ventZ.flatMap((z) => [-0.066, 0.066].map((x) => ({ x, y: 0.040, z }))));
  instancedBoxes(b, [0.060, 0.012, 0.032], COL.fluteDark,
    ventZ.map((z) => ({ x: 0, y: 0.094, z })));
  box(b, 0.086, 0.018, 0.250, 0, 0.118, -0.325, COL.polyDark); // top rail
  instancedBoxes(b, [0.088, 0.012, 0.014], COL.gunmetal,
    Array.from({ length: 5 }, (_, i) => ({ x: 0, y: 0.132, z: -0.225 - i * 0.050 })));

  const muzzleX = T.muzzle[0];
  const muzzleY = T.muzzle[1];
  const barrelLength = Math.abs(T.muzzle[2] - BREACH_Z.lmg);
  cylZ(
    b,
    0.027,
    barrelLength,
    muzzleX,
    muzzleY,
    (T.muzzle[2] + BREACH_Z.lmg) / 2,
    COL.gunmetal,
    { seg: 12 },
  );
  // Under-barrel gas tube, collar and regulator reproduce the double-line front end.
  cylZ(b, 0.017, 0.280, 0, -0.008, -0.485, COL.parkerized, { seg: 10 });
  cylZ(b, 0.042, 0.050, muzzleX, muzzleY, -0.500, COL.parkerized, { seg: 12 });
  cylZ(b, 0.035, 0.035, muzzleX, muzzleY, -0.620, COL.gunmetal, { seg: 12 });
  box(b, 0.112, 0.078, 0.042, 0, 0.022, -0.490, COL.polyDark);
  box(b, 0.118, 0.018, 0.046, 0, 0.069, -0.490, COL.amber);

  // The final cap spans [muzzle, muzzle + 0.014], keeping the bore tip exactly on T.muzzle.
  brakeRings(b, 0.042, muzzleX, muzzleY, T.muzzle[2], 3, 0.007, 0.012);
  cylZ(b, 0.033, 0.014, muzzleX, muzzleY, T.muzzle[2] + 0.007, COL.brake, { seg: 12 });
  instancedBoxes(b, [0.014, 0.045, 0.018], COL.amber, [-1, 1].map((side) => ({
    x: side * 0.034,
    y: muzzleY,
    z: T.muzzle[2] + 0.050,
  })));

  // Folding bipod: y/z angles create the same forward-splayed silhouette as the reference.
  box(b, 0.130, 0.022, 0.040, 0, -0.028, -0.486, COL.gunmetal);
  instancedBoxes(b, [0.018, 0.020, 0.245], COL.polyDark, [-1, 1].map((side) => ({
    x: side * 0.050,
    y: -0.098,
    z: -0.500,
    rx: side * 0.36,
  })));
  instancedBoxes(b, [0.050, 0.018, 0.070], COL.amber, [-1, 1].map((side) => ({
    x: side * 0.050,
    y: -0.182,
    z: -0.500 - side * 0.082,
  })));
  instancedBoxes(b, [0.056, 0.012, 0.076], COL.polyDark, [-1, 1].map((side) => ({
    x: side * 0.050,
    y: -0.190,
    z: -0.500 - side * 0.082,
  })));

  // Carry handle and compact optic sit around, never across, the y=.155 iron-sight line.
  box(b, 0.018, 0.095, 0.026, -0.052, 0.145, -0.145, COL.polyDark, { rz: -0.30 });
  box(b, 0.018, 0.095, 0.026, 0.052, 0.145, -0.145, COL.polyDark, { rz: 0.30 });
  box(b, 0.120, 0.018, 0.150, 0, 0.198, -0.145, COL.gunmetal);
  cylZ(b, 0.029, 0.130, 0.044, 0.220, -0.080, COL.polyDark, { seg: 12 });
  cylZ(b, 0.035, 0.025, 0.044, 0.220, -0.153, COL.amber, { seg: 12 });
  cylZ(b, 0.035, 0.025, 0.044, 0.220, -0.007, COL.gunmetal, { seg: 12 });
  box(b, 0.018, 0.035, 0.028, 0.044, 0.257, -0.080, COL.amber);
  // Open LMG battle sight. Both ears and blade stop below the actual .155 aim line, producing
  // visible air around the target marker instead of merely touching it at a rasterized edge.
  b.userData.sightHeight = 0.155;
  box(b, 0.058, 0.008, 0.018, 0, 0.119, 0.098, COL.polyDark);
  box(b, 0.018, 0.026, 0.018, -0.020, 0.135, 0.098, COL.polyDark);
  box(b, 0.018, 0.026, 0.018, 0.020, 0.135, 0.098, COL.polyDark);
  box(b, 0.034, 0.008, 0.014, 0, 0.121, -0.655, COL.polyDark);
  box(b, 0.008, 0.018, 0.014, 0, 0.134, -0.655, COL.amber);

  // Detachable box, top latches and a short, clearly readable brass feed run.
  box(mg, 0.142, 0.150, 0.175, -0.022, -0.130, -0.120, COL.olive);
  box(mg, 0.148, 0.024, 0.184, -0.022, -0.047, -0.120, COL.polyDark);
  box(mg, 0.148, 0.020, 0.184, -0.022, -0.213, -0.120, COL.gunmetal);
  box(mg, 0.014, 0.088, 0.090, -0.096, -0.125, -0.120, COL.polyDark);
  box(mg, 0.014, 0.038, 0.055, -0.100, -0.120, -0.120, COL.amber);
  box(mg, 0.018, 0.032, 0.050, -0.094, -0.092, -0.025, COL.amber);
  const beltTransforms = Array.from({ length: 5 }, (_, i) => ({
    x: -0.080 + i * 0.032,
    y: -0.022 + i * 0.017,
    z: -0.172,
  }));
  const cartridgeGeometry = new THREE.CylinderGeometry(0.011, 0.011, 0.058, 8);
  cartridgeGeometry.rotateX(Math.PI / 2);
  const cartridges = new THREE.InstancedMesh(
    cartridgeGeometry,
    mat(COL.brass, 0.65, 0.45),
    beltTransforms.length,
  );
  const cartridgeDummy = new THREE.Object3D();
  beltTransforms.forEach((transform, index) => {
    cartridgeDummy.position.set(transform.x, transform.y, transform.z);
    cartridgeDummy.rotation.x = Math.PI / 2;
    cartridgeDummy.updateMatrix();
    cartridges.setMatrixAt(index, cartridgeDummy.matrix);
  });
  mg.add(cartridges);
  instancedBoxes(mg, [0.024, 0.009, 0.064], COL.polyDark, beltTransforms);

  // Feed cover is a real hinge group because reload choreography rotates reloadPart.x.
  const cover = new THREE.Group();
  cover.name = 'belt_cover';
  cover.position.set(0, 0.105, -0.075);
  box(cover, 0.138, 0.024, 0.250, 0, 0, 0, COL.gunmetal);
  box(cover, 0.105, 0.012, 0.180, 0, 0.020, -0.012, COL.polyDark);
  box(cover, 0.075, 0.010, 0.108, 0, 0.029, -0.012, COL.amber);
  box(cover, 0.018, 0.028, 0.025, -0.072, 0.008, 0.092, COL.amber);
  extra.add(cover);
  extra.userData.reloadPart = cover;

  // Reciprocating charging handle, selector and trigger keep their original animation groups.
  box(bolt, 0.056, 0.034, 0.082, -0.064, 0.075, BOLT_HOME.lmg, COL.gunmetal);
  box(bolt, 0.030, 0.020, 0.060, -0.096, 0.076, BOLT_HOME.lmg + 0.028, COL.amber);
  box(tg, 0.010, 0.034, 0.012, 0, -0.020, TRIGGER_Z.lmg, COL.amber);
  box(tg, 0.042, 0.008, 0.060, 0, -0.050, TRIGGER_Z.lmg, COL.polyDark);
}
