import * as THREE from '../../vendor/three.module.js';
import { COL } from '../kit.js';
import { BOLT_HOME, BREACH_Z, TRIGGER_Z } from './common.js';

/**
 * Collapse decorative voxel boxes by group and material. The SMG deliberately carries more
 * silhouette detail than the older model; batching keeps that detail from multiplying draw calls
 * on every remote avatar. All moving assemblies retain their own parent group and animate intact.
 */
function makeBoxBatcher(kit) {
  const batches = new Map();

  function box(parent, w, h, d, x, y, z, color, options = {}) {
    const material = options.mat || kit.mat(color, options.rg ?? 0.78, options.mt ?? 0.22);
    let byMaterial = batches.get(parent);
    if (!byMaterial) {
      byMaterial = new Map();
      batches.set(parent, byMaterial);
    }
    let specs = byMaterial.get(material);
    if (!specs) {
      specs = [];
      byMaterial.set(material, specs);
    }
    specs.push({ w, h, d, x, y, z, rx: options.rx || 0, ry: options.ry || 0, rz: options.rz || 0 });
  }

  function flush() {
    for (const [parent, byMaterial] of batches) {
      for (const [material, specs] of byMaterial) {
        const geometries = specs.map(({ w, h, d, x, y, z, rx, ry, rz }) => {
          const geometry = new THREE.BoxGeometry(w, h, d).toNonIndexed();
          if (rx) geometry.rotateX(rx);
          if (ry) geometry.rotateY(ry);
          if (rz) geometry.rotateZ(rz);
          geometry.translate(x, y, z);
          return geometry;
        });
        const vertexCount = geometries.reduce(
          (sum, geometry) => sum + geometry.getAttribute('position').count,
          0,
        );
        const positions = new Float32Array(vertexCount * 3);
        const normals = new Float32Array(vertexCount * 3);
        let offset = 0;
        for (const geometry of geometries) {
          const position = geometry.getAttribute('position').array;
          const normal = geometry.getAttribute('normal').array;
          positions.set(position, offset * 3);
          normals.set(normal, offset * 3);
          offset += geometry.getAttribute('position').count;
          geometry.dispose();
        }
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
        geometry.computeBoundingBox();
        geometry.computeBoundingSphere();
        parent.add(new THREE.Mesh(geometry, material));
      }
    }
    batches.clear();
  }

  return { box, flush };
}

export function build({ kit, T, groups }) {
  const { box, flush: flushBoxes } = makeBoxBatcher(kit);
  const { cylZ, brakeRings, ironSights } = kit;
  const { body, mag, bolt, trigger } = groups;

  // Compact, layered receiver: the broad side plates and stepped upper match the HUD silhouette
  // without widening the sight picture when the weapon settles into ADS.
  box(body, 0.098, 0.105, 0.260, 0, 0.018, -0.085, COL.gunmetal);
  box(body, 0.090, 0.035, 0.282, 0, 0.083, -0.090, COL.blued);
  box(body, 0.082, 0.026, 0.090, 0, 0.096, 0.006, COL.polyDark);
  box(body, 0.088, 0.045, 0.065, 0, 0.052, 0.056, COL.polymer);
  box(body, 0.084, 0.026, 0.070, 0, -0.041, -0.171, COL.polyDark);

  // Mirrored inset panels keep the weapon readable both in first person and on remote avatars.
  for (const side of [-1, 1]) {
    box(body, 0.006, 0.058, 0.172, side * 0.052, 0.022, -0.078, COL.polyDark);
    box(body, 0.007, 0.018, 0.064, side * 0.053, 0.050, -0.016, COL.steel);
    box(body, 0.007, 0.015, 0.039, side * 0.054, 0.053, -0.106, COL.polymer);
    box(body, 0.008, 0.018, 0.029, side * 0.054, 0.014, -0.001, COL.amber);
    box(body, 0.008, 0.010, 0.060, side * 0.055, -0.016, -0.154, COL.amber);
    box(body, 0.008, 0.018, 0.018, side * 0.055, 0.016, -0.192, COL.steel);
  }

  // Full-length PDW rail and the HUD image's protected notch/blade sight pair. The sight height is
  // deliberately unchanged: T.adsOffset is calibrated to this 0.112 m axis.
  box(body, 0.072, 0.008, 0.300, 0, 0.102, -0.093, COL.polymer);
  for (let i = 0; i < 8; i++) {
    // Rail crowns stop below the declared sight height, leaving a real optical channel rather
    // than relying on the capture camera to visually hide an axis intersection.
    box(body, 0.078, 0.010, 0.024, 0, 0.105, 0.028 - i * 0.041, COL.steel);
  }
  ironSights(body, {
    rearZ: 0.055,
    frontZ: -0.335,
    height: 0.112,
    width: 0.044,
    gap: 0.012,
    color: COL.polymer,
    accent: COL.amber,
  });

  // Skeletonized two-strut stock with a deep butt pad. Its light wire frame is the strongest
  // identifying feature of the HORNET reference, but remains narrow enough for the viewmodel.
  box(body, 0.020, 0.018, 0.224, 0, 0.036, 0.161, COL.steel);
  box(body, 0.018, 0.018, 0.205, 0, -0.055, 0.160, COL.steel, { rx: 0.32 });
  for (const side of [-1, 1]) {
    box(body, 0.014, 0.132, 0.026, side * 0.025, -0.031, 0.279, COL.polymer);
    box(body, 0.006, 0.138, 0.010, side * 0.034, -0.031, 0.297, COL.amber);
  }
  box(body, 0.064, 0.018, 0.026, 0, 0.032, 0.279, COL.polymer);
  box(body, 0.064, 0.018, 0.026, 0, -0.094, 0.279, COL.polymer);
  box(body, 0.056, 0.026, 0.036, 0, 0.040, 0.267, COL.polyDark);
  box(body, 0.056, 0.026, 0.036, 0, -0.101, 0.267, COL.polyDark);
  box(body, 0.070, 0.030, 0.052, 0, 0.018, 0.071, COL.polyDark);
  box(body, 0.052, 0.014, 0.020, 0, 0.019, 0.100, COL.amber);

  // Rearward-raked pistol grip with shallow horizontal texture bands.
  box(body, 0.050, 0.125, 0.060, 0, -0.105, -0.012, COL.polymer, { rx: -0.30 });
  for (let i = 0; i < 4; i++) {
    box(body, 0.053, 0.008, 0.048, 0, -0.076 - i * 0.026, -0.006 + i * 0.008,
      i === 3 ? COL.amber : COL.polyDark, { rx: -0.30 });
  }
  box(body, 0.056, 0.015, 0.066, 0, -0.172, 0.010, COL.amber, { rx: -0.30 });

  // Short perforated barrel shroud. Dark inset strips fake genuine openings while retaining the
  // inexpensive primitive-only model and its deterministic headless construction.
  const muzzleX = T.muzzle[0];
  const muzzleY = T.muzzle[1];
  const barrelLength = Math.abs(T.muzzle[2] - BREACH_Z.smg);
  cylZ(body, 0.037, barrelLength, muzzleX, muzzleY,
    (T.muzzle[2] + BREACH_Z.smg) / 2, COL.blued, { seg: 12 });
  cylZ(body, 0.044, 0.044, muzzleX, muzzleY, BREACH_Z.smg - 0.022, COL.gunmetal, { seg: 12 });
  for (const z of [-0.266, -0.310, -0.354]) {
    for (const side of [-1, 1]) {
      box(body, 0.007, 0.017, 0.026, side * 0.038, muzzleY + 0.004, z, COL.polymer);
    }
    box(body, 0.026, 0.007, 0.026, 0, muzzleY + 0.037, z, COL.polymer);
  }
  for (const side of [-1, 1]) {
    box(body, 0.007, 0.010, 0.078, side * 0.040, muzzleY - 0.019, -0.310, COL.amber);
  }

  // Ported muzzle brake terminates exactly on T.muzzle; the surrounding amber ring remains a
  // small accent instead of turning the whole muzzle into an orange cap.
  brakeRings(body, 0.042, muzzleX, muzzleY, T.muzzle[2], 1, 0.006, 0.012, COL.amber);
  cylZ(body, 0.029, 0.030, muzzleX, muzzleY, T.muzzle[2] + 0.015, COL.brake, { seg: 10 });
  for (const side of [-1, 1]) {
    box(body, 0.007, 0.022, 0.012, side * 0.026, muzzleY + 0.006,
      T.muzzle[2] + 0.014, COL.polymer);
  }

  // The complete straight magazine stays in the animated group so drop/reseat choreography still
  // moves the follower, ribs, orange witness stripe and floor plate as one coherent part.
  box(mag, 0.054, 0.036, 0.076, 0, -0.047, -0.158, COL.gunmetal);
  box(mag, 0.052, 0.164, 0.064, 0, -0.143, -0.158, COL.polymer);
  for (let i = 0; i < 4; i++) {
    box(mag, 0.055, 0.008, 0.068, 0, -0.091 - i * 0.035, -0.158, COL.polyDark);
  }
  for (const side of [-1, 1]) {
    box(mag, 0.005, 0.090, 0.015, side * 0.028, -0.158, -0.158, COL.amber);
  }
  box(mag, 0.062, 0.016, 0.074, 0, -0.233, -0.158, COL.amber);
  box(mag, 0.056, 0.010, 0.068, 0, -0.246, -0.158, COL.polyDark);

  // Reciprocating charging assembly: every piece stays under `bolt`, preserving the existing
  // short-stroke animation while making the motion readable against the receiver.
  box(bolt, 0.030, 0.016, 0.084, -0.054, 0.051, BOLT_HOME.smg, COL.polymer);
  box(bolt, 0.018, 0.018, 0.042, -0.062, 0.056, BOLT_HOME.smg + 0.038, COL.steel);
  box(bolt, 0.022, 0.014, 0.024, -0.066, 0.056, BOLT_HOME.smg + 0.064, COL.amber);

  // Orange trigger inside a compact, closed rectangular guard. The group ownership keeps trigger
  // travel independent from the otherwise static lower receiver.
  box(trigger, 0.009, 0.032, 0.009, 0, -0.026, TRIGGER_Z.smg, COL.amber, { rx: 0.18 });
  box(trigger, 0.040, 0.007, 0.058, 0, -0.052, TRIGGER_Z.smg, COL.polymer);
  box(trigger, 0.040, 0.030, 0.007, 0, -0.037, TRIGGER_Z.smg - 0.027, COL.polymer);
  box(trigger, 0.040, 0.030, 0.007, 0, -0.037, TRIGGER_Z.smg + 0.027, COL.polymer);
  flushBoxes();
}
