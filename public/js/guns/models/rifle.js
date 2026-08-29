import * as THREE from '../../vendor/three.module.js';
import { COL } from '../kit.js';
import { BOLT_HOME, BREACH_Z, TRIGGER_Z } from './common.js';

// VK-77: modular, short-stroke service rifle. The large forms deliberately follow the
// side-profile HUD reference; shallow overlays keep the silhouette readable without textures.
export function build({ kit, T, groups }) {
  const { mat, box, cylZ, brakeRings, ironSights } = kit;
  const { body, mag, bolt, trigger } = groups;

  // Body parts never animate independently, so equal-material boxes share one unit cube and
  // carry their original dimensions/rotations in instance matrices. Animated groups stay plain
  // meshes below so reload, bolt and trigger hooks retain their existing object boundaries.
  const staticBatches = new Map();
  const bodyBox = (w, h, d, x, y, z, color, options = {}) => {
    const roughness = options.rg ?? 0.78;
    const metalness = options.mt ?? 0.22;
    const key = `${color}|${roughness}|${metalness}`;
    if (!staticBatches.has(key)) {
      staticBatches.set(key, { color, roughness, metalness, transforms: [] });
    }
    staticBatches.get(key).transforms.push({ w, h, d, x, y, z, options });
  };
  const flushBodyBoxes = () => {
    const position = new THREE.Vector3();
    const rotation = new THREE.Euler();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const matrix = new THREE.Matrix4();
    let batchIndex = 0;
    for (const batch of staticBatches.values()) {
      const mesh = new THREE.InstancedMesh(
        new THREE.BoxGeometry(1, 1, 1),
        mat(batch.color, batch.roughness, batch.metalness),
        batch.transforms.length,
      );
      mesh.name = `rifle_static_${batchIndex++}`;
      batch.transforms.forEach(({ w, h, d, x, y, z, options }, index) => {
        position.set(x, y, z);
        rotation.set(options.rx || 0, options.ry || 0, options.rz || 0, 'XYZ');
        quaternion.setFromEuler(rotation);
        scale.set(w, h, d);
        matrix.compose(position, quaternion, scale);
        mesh.setMatrixAt(index, matrix);
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingBox();
      mesh.computeBoundingSphere();
      body.add(mesh);
    }
  };
  const sidePair = (w, h, d, x, y, z, color, options) => {
    bodyBox(w, h, d, x, y, z, color, options);
    bodyBox(w, h, d, -x, y, z, color, options);
  };

  // Adjustable stock: stepped butt pad, cheek rest and open lower brace replace the old block.
  cylZ(body, 0.016, 0.18, 0, 0.040, 0.135, COL.gunmetal, { seg: 8 });
  bodyBox(0.018, 0.018, 0.16, 0, 0.070, 0.145, COL.polyDark);
  bodyBox(0.070, 0.018, 0.125, 0, 0.100, 0.150, COL.steel);
  bodyBox(0.074, 0.012, 0.090, 0, 0.113, 0.120, COL.polymer);
  bodyBox(0.026, 0.022, 0.082, -0.025, -0.006, 0.174, COL.polyDark, { rx: -0.62 });
  bodyBox(0.026, 0.022, 0.082, 0.025, -0.006, 0.174, COL.polyDark, { rx: -0.62 });
  bodyBox(0.026, 0.022, 0.094, -0.025, -0.026, 0.194, COL.polymer, { rx: 0.50 });
  bodyBox(0.026, 0.022, 0.094, 0.025, -0.026, 0.194, COL.polymer, { rx: 0.50 });
  // The pad is an open frame: from the first-person rear angle it cannot become a solid panel.
  // Orange lives on the outward/forward trim; the rear sight picture sees the dark contact pad.
  // Its side silhouette stays full-height, while its narrow X depth avoids filling the ADS view.
  bodyBox(0.016, 0.094, 0.014, 0, 0.034, 0.246, COL.amber);
  bodyBox(0.012, 0.086, 0.018, 0, 0.034, 0.260, COL.polymer);

  // Layered upper and lower receiver reproduce the stepped forged profile in the reference.
  bodyBox(0.096, 0.090, 0.255, 0, 0.052, -0.118, COL.gunmetal);
  bodyBox(0.104, 0.034, 0.235, 0, 0.105, -0.120, COL.steel);
  bodyBox(0.090, 0.012, 0.210, 0, 0.116, -0.122, COL.polyDark);
  bodyBox(0.090, 0.072, 0.168, 0, -0.016, -0.088, COL.polyDark);
  bodyBox(0.080, 0.030, 0.118, 0, -0.064, -0.128, COL.polymer);
  bodyBox(0.074, 0.034, 0.058, 0, 0.020, 0.030, COL.steel);
  bodyBox(0.056, 0.050, 0.032, 0, 0.040, 0.064, COL.polyDark);

  // Ejection cover, magazine release, selector and illuminated receiver status strip.
  bodyBox(0.006, 0.042, 0.092, 0.051, 0.062, -0.128, COL.polymer);
  bodyBox(0.007, 0.028, 0.068, 0.055, 0.063, -0.128, COL.steel);
  bodyBox(0.010, 0.020, 0.022, 0.057, 0.010, -0.050, COL.polymer);
  cylZ(body, 0.010, 0.010, 0.057, 0.018, -0.020, COL.amber, { seg: 8 });
  cylZ(body, 0.006, 0.012, 0.058, 0.040, 0.005, COL.steel, { seg: 8 });
  bodyBox(0.008, 0.018, 0.055, -0.052, 0.091, -0.126, COL.amber);
  bodyBox(0.008, 0.014, 0.024, -0.054, 0.091, -0.086, COL.polyDark);

  // Swept pistol grip with orange heel; short facets avoid the old rectangular club shape.
  bodyBox(0.062, 0.090, 0.052, 0, -0.095, -0.018, COL.polymer, { rx: -0.30 });
  bodyBox(0.065, 0.082, 0.056, 0, -0.160, 0.005, COL.polyDark, { rx: -0.24 });
  bodyBox(0.068, 0.018, 0.062, 0, -0.207, 0.022, COL.amber, { rx: -0.18 });
  [-0.116, -0.145, -0.174].forEach((y, i) => {
    sidePair(0.004, 0.008, 0.038, 0.034, y, -0.004 + i * 0.010, COL.steel, { rx: -0.24 });
  });

  // Full handguard with top/side rails. Dark inset panels and separated ribs read as its vents.
  bodyBox(0.094, 0.076, 0.270, 0, 0.057, -0.372, COL.polyDark);
  bodyBox(0.082, 0.062, 0.258, 0, 0.052, -0.372, COL.steel);
  bodyBox(0.070, 0.018, 0.265, 0, 0.105, -0.372, COL.polymer);
  for (let i = 0; i < 6; i++) {
    const z = -0.263 - i * 0.043;
    bodyBox(0.076, 0.012, 0.026, 0, 0.122, z, i === 1 ? COL.amber : COL.gunmetal);
  }
  [-1, 1].forEach((side) => {
    for (let i = 0; i < 4; i++) {
      const z = -0.292 - i * 0.057;
      bodyBox(0.008, 0.024, 0.039, side * 0.047, 0.064, z, COL.polymer);
      bodyBox(0.010, 0.009, 0.022, side * 0.052, 0.064, z, i === 1 ? COL.amber : COL.steel);
    }
  });
  bodyBox(0.075, 0.018, 0.174, 0, 0.018, -0.390, COL.polymer);
  for (let i = 0; i < 4; i++) {
    bodyBox(0.050, 0.009, 0.025, 0, 0.006, -0.317 - i * 0.047, COL.gunmetal);
  }
  bodyBox(0.018, 0.052, 0.045, 0, -0.015, -0.463, COL.amber, { rx: -0.18 });

  // Continuous Picatinny spine across receiver and handguard, with raised reference sights.
  for (let i = 0; i < 9; i++) {
    const z = 0.018 - i * 0.055;
    bodyBox(0.074, 0.010, 0.036, 0, 0.124, z, i % 3 === 1 ? COL.steel : COL.polyDark);
  }
  ironSights(body, {
    rearZ: 0.030,
    frontZ: -0.515,
    height: 0.145,
    width: 0.050,
    gap: 0.014,
    color: COL.polymer,
    accent: COL.amber,
  });
  bodyBox(0.060, 0.008, 0.026, 0, 0.128, 0.030, COL.steel);
  bodyBox(0.060, 0.008, 0.026, 0, 0.128, -0.515, COL.steel);

  const muzzleX = T.muzzle[0];
  const muzzleY = T.muzzle[1];
  const barrelLength = Math.abs(T.muzzle[2] - BREACH_Z.rifle);
  cylZ(
    body,
    0.016,
    barrelLength,
    muzzleX,
    muzzleY,
    (T.muzzle[2] + BREACH_Z.rifle) / 2,
    COL.blued,
    { seg: 12 },
  );
  cylZ(body, 0.029, 0.042, muzzleX, muzzleY, -0.527, COL.gunmetal, { seg: 10 });
  cylZ(body, 0.022, 0.022, muzzleX, muzzleY, T.muzzle[2] + 0.031, COL.amber, { seg: 10 });
  brakeRings(body, 0.031, muzzleX, muzzleY, T.muzzle[2], 2, 0.007, 0.012, COL.brake);
  cylZ(body, 0.026, 0.012, muzzleX, muzzleY, T.muzzle[2] + 0.006, COL.brake, { seg: 10 });
  sidePair(0.010, 0.018, 0.018, 0.030, muzzleY, T.muzzle[2] + 0.030, COL.polymer);
  sidePair(0.010, 0.018, 0.018, 0.030, muzzleY, T.muzzle[2] + 0.055, COL.polymer);
  flushBodyBoxes();

  // Three-facet curved magazine. Every facet remains in the animated magazine group.
  box(mag, 0.068, 0.060, 0.082, 0, -0.074, -0.158, COL.polymer, { rx: 0.10 });
  box(mag, 0.070, 0.080, 0.078, 0, -0.128, -0.145, COL.polyDark, { rx: 0.20 });
  box(mag, 0.073, 0.072, 0.075, 0, -0.188, -0.121, COL.polymer, { rx: 0.34 });
  box(mag, 0.080, 0.020, 0.084, 0, -0.230, -0.096, COL.amber, { rx: 0.34 });
  [0.040, 0.012, -0.016].forEach((x) => {
    box(mag, 0.007, 0.024, 0.012, x, -0.174, -0.173, COL.amber, { rx: 0.30 });
  });
  box(mag, 0.075, 0.007, 0.055, 0, -0.120, -0.187, COL.steel, { rx: 0.20 });

  // Charging parts retain the bolt group so their existing reciprocation remains intact.
  box(bolt, 0.050, 0.040, 0.044, -0.045, 0.084, BOLT_HOME.rifle, COL.polymer);
  box(bolt, 0.023, 0.014, 0.070, -0.067, 0.091, BOLT_HOME.rifle + 0.020, COL.steel);
  box(bolt, 0.020, 0.018, 0.024, -0.078, 0.091, BOLT_HOME.rifle + 0.048, COL.amber);

  // Trigger and guard stay isolated so the tactile trigger animation rotates unchanged.
  box(trigger, 0.008, 0.030, 0.008, 0, -0.022, TRIGGER_Z.rifle, COL.amber);
  box(trigger, 0.038, 0.007, 0.060, 0, -0.047, TRIGGER_Z.rifle, COL.polyDark);
  box(trigger, 0.007, 0.035, 0.010, -0.018, -0.032, TRIGGER_Z.rifle - 0.027, COL.polyDark, { rz: -0.48 });
  box(trigger, 0.007, 0.035, 0.010, 0.018, -0.032, TRIGGER_Z.rifle - 0.027, COL.polyDark, { rz: 0.48 });
}
