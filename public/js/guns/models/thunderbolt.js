import * as THREE from '../../vendor/three.module.js';
import { mergeGeometries } from '../../vendor/utils/BufferGeometryUtils.js';
import { COL, GLOW_ACCENT } from '../kit.js';
import { BOLT_HOME } from './common.js';
import { buildBlenderThunderbolt } from './thunderbolt-blender.js';
import { installThunderboltPlasma } from '../thunderbolt-plasma.js';

// ImageGen concept A: docs/design/thunderbolt. An open accelerator, ceramic
// insulation and a rear-visible four-cell rotor make the orb mechanism readable.
const SIGHT_Y = 0.17;
const BLUE = GLOW_ACCENT.thunderbolt;
const CERAMIC = 0xb8c5cc;
const COPPER = 0xb97d50;
export const DISPLAY_MOUNT = Object.freeze({ x: -0.045, y: 0.137, z: 0.170, w: 0.045, h: 0.035, seat: 'deck' });

// Batch only rigid siblings. The rotor, each charge, sights and effect groups
// stay separate so ammo, reloads and cosmetics retain their own ownership.
function batch(group) {
  const materials = new Map();
  for (const mesh of [...group.children]) {
    if (!mesh.isMesh) continue;
    mesh.updateMatrix();
    const geometry = mesh.geometry.clone().applyMatrix4(mesh.matrix);
    const list = materials.get(mesh.material) || [];
    list.push(geometry);
    materials.set(mesh.material, list);
    mesh.geometry.dispose();
    group.remove(mesh);
  }
  for (const [material, geometries] of materials) {
    const merged = mergeGeometries(geometries);
    for (const geometry of geometries) geometry.dispose();
    group.add(new THREE.Mesh(merged, material));
  }
}

export function build({ kit, T, groups }) {
  if (buildBlenderThunderbolt(groups, DISPLAY_MOUNT)) return true;
  // DOM-free simulation fallback. HTTP clients preload the authored Blender model.
  const { box, cylZ, mat, ironSights } = kit;
  const { body, mag, bolt, trigger, extra } = groups;
  const [mx, axisY, mz] = T.muzzle;
  body.userData.displayMount = DISPLAY_MOUNT;
  const ceramic = mat(CERAMIC, 0.65, 0.15);
  // Owned by this gun, never mutate the shared kit palette when pulsing.
  const pulseMaterial = new THREE.MeshStandardMaterial({ color: 0x4b9fff, emissive: 0x287aff,
    emissiveIntensity: 1.6, metalness: 0.1, roughness: 0.25, flatShading: true });
  const arcMaterial = new THREE.MeshBasicMaterial({ color: 0xb9efff, toneMapped: false });
  pulseMaterial.userData.tbEnergy = true;

  function ring(parent, radius, tube, x, y, z, material) {
    const mesh = new THREE.Mesh(new THREE.TorusGeometry(radius, tube, 4, 16), material);
    mesh.position.set(x, y, z);
    parent.add(mesh);
    return mesh;
  }
  function bevel(parent, w, h, d, x, y, z, material, edge = 0.006) {
    const shape = new THREE.Shape();
    shape.moveTo(-w / 2 + edge, -h / 2); shape.lineTo(w / 2 - edge, -h / 2);
    shape.lineTo(w / 2, -h / 2 + edge); shape.lineTo(w / 2, h / 2 - edge);
    shape.lineTo(w / 2 - edge, h / 2); shape.lineTo(-w / 2 + edge, h / 2);
    shape.lineTo(-w / 2, h / 2 - edge); shape.lineTo(-w / 2, -h / 2 + edge); shape.closePath();
    const geometry = new THREE.ExtrudeGeometry(shape, { depth: d - 2 * edge, bevelEnabled: true,
      bevelSegments: 1, steps: 1, bevelSize: edge * 0.35, bevelThickness: edge });
    geometry.translate(0, 0, -d / 2 + edge);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    parent.add(mesh);
    return mesh;
  }

  // Stepped receiver leaves an open gap above the drum and around the coil cage.
  box(body, 0.082, 0.074, 0.34, 0, axisY - 0.006, -0.18, COL.gunmetal);
  for (const side of [-1, 1]) {
    // Chamfered plates are separate from the batched kit meshes (non-indexed).
    const plate = new THREE.Group(); body.add(plate);
    bevel(plate, 0.016, 0.086, 0.285, side * 0.048, axisY + 0.005, -0.175, ceramic);
    box(body, 0.009, 0.012, 0.235, side * 0.055, axisY - 0.043, -0.175, COPPER, { mt: 0.65 });
    for (let i = 0; i < 3; i++) {
      box(body, 0.005, 0.012, 0.026, side * 0.058, axisY + 0.02, -0.23 - i * 0.035, COL.brake);
    }
  }
  box(body, 0.055, 0.018, 0.36, 0, axisY + 0.055, -0.13, COL.polyDark);
  // Compact padded stock and the original physically seated counter deck.
  box(body, 0.064, 0.065, 0.21, 0, axisY - 0.012, 0.115, COL.gunmetal);
  box(body, 0.044, 0.027, 0.175, 0, axisY + 0.028, 0.10, CERAMIC);
  box(body, 0.072, 0.100, 0.026, 0, axisY - 0.02, 0.238, COL.polyDark);
  box(body, 0.050, 0.018, 0.073, -0.03, 0.107, 0.152, CERAMIC);

  // Three rails form an open accelerator. No solid tube or luminous heat sleeve
  // may fill this space: the suspended field is the distinctive mechanism.
  for (let i = 0; i < 3; i++) {
    const a = Math.PI / 6 + i * Math.PI * 2 / 3;
    const x = mx + Math.cos(a) * 0.063, y = axisY + Math.sin(a) * 0.063;
    box(body, 0.024, 0.028, 0.35, x, y, -0.565, COL.gunmetal, { rz: a });
    box(body, 0.014, 0.019, 0.105, x, y, -0.445, CERAMIC, { rz: a });
    for (let j = 0; j < 4; j++) {
      box(body, 0.027, 0.031, 0.008, x, y, -0.487 - j * 0.012, COPPER, { rz: a, mt: 0.7 });
    }
    box(body, 0.030, 0.034, 0.025, x, y, mz + 0.014, COPPER, { rz: a, mt: 0.65 });
    box(body, 0.005, 0.009, 0.135, x * 0.84, axisY + (y - axisY) * 0.84, -0.637, BLUE,
      { mat: pulseMaterial, rz: a });
  }
  ring(body, 0.06, 0.010, mx, axisY, -0.40, mat(COL.brake));
  ring(body, 0.058, 0.005, mx, axisY, -0.421, ceramic);
  ring(body, 0.06, 0.006, mx, axisY, mz + 0.025, mat(COL.gunmetal));

  const energy = new THREE.Group(); energy.name = 'orb-field';
  energy.position.set(mx, axisY, -0.64); body.add(energy);
  energy.add(new THREE.Mesh(new THREE.SphereGeometry(0.023, 24, 16), pulseMaterial));
  const arcs = new THREE.Group(); arcs.name = 'accelerator-arcs'; body.add(arcs);
  for (let rail = 0; rail < 3; rail++) {
    const a = Math.PI / 6 + rail * Math.PI * 2 / 3;
    const points = Array.from({ length: 11 }, (_, j) => {
      const t = j / 10, radius = 0.018 + Math.abs(2 * t - 1) * 0.033;
      const jitter = j % 2 ? 0.009 : -0.004;
      return new THREE.Vector3(Math.cos(a) * radius + Math.sin(a) * jitter,
        axisY + Math.sin(a) * radius + Math.cos(a) * jitter, -0.435 - t * 0.28);
    });
    const curve = new THREE.CurvePath();
    for (let j = 1; j < points.length; j++) curve.add(new THREE.LineCurve3(points[j - 1], points[j]));
    arcs.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 20, 0.0013, 3, false), arcMaterial));
  }

  // Rear-facing rotor sits proud of the left receiver so all four cells can be
  // read in first person. The mag keeps the shared reload transform; rotor spins.
  const rotor = new THREE.Group(); rotor.name = 'thunderbolt-rotor';
  rotor.position.set(-0.103, axisY - 0.061, -0.22); mag.add(rotor);
  cylZ(rotor, 0.094, 0.082, 0, 0, 0, COL.gunmetal, { seg: 16 });
  ring(rotor, 0.089, 0.008, 0, 0, 0.046, ceramic);
  ring(rotor, 0.089, 0.005, 0, 0, -0.046, mat(COL.brake));
  const rounds = [];
  for (let i = 0; i < 4; i++) {
    // Positive indexing brings the next loaded cell into this same feed seat.
    const a = Math.PI / 4 - i * Math.PI / 2;
    const x = Math.cos(a) * 0.052, y = Math.sin(a) * 0.052;
    cylZ(rotor, 0.027, 0.008, x, y, 0.047, COL.polymer, { seg: 12 });
    ring(rotor, 0.026, 0.004, x, y, 0.053, mat(COL.steel));
    const round = new THREE.Group(); round.name = `orb-charge-${i}`;
    round.position.set(x, y, 0.059);
    const orb = new THREE.Mesh(new THREE.SphereGeometry(0.021, 24, 16), pulseMaterial);
    round.add(orb);
    rotor.add(round); rounds.push(round);
  }
  cylZ(rotor, 0.016, 0.103, 0, 0, 0, COPPER, { seg: 6, mt: 0.65 });
  // Asymmetric index mark makes each quarter turn unambiguous, even at full load.
  box(rotor, 0.015, 0.014, 0.011, 0, 0.080, 0.050, COPPER);
  box(body, 0.024, 0.020, 0.055, -0.103, axisY + 0.043, -0.18, CERAMIC);

  const belly = axisY - 0.060;
  box(body, 0.036, 0.11, 0.05, 0.004, belly - 0.05, -0.07, COL.polymer, { rx: 0.2 });
  box(body, 0.040, 0.012, 0.054, 0.004, belly - 0.104, -0.058, CERAMIC, { rx: 0.2 });
  box(body, 0.032, 0.008, 0.075, 0.004, belly - 0.035, -0.12, COL.polyDark);
  box(trigger, 0.008, 0.028, 0.01, 0.004, belly - 0.016, T.triggerZ ?? -0.12, COL.steel);
  box(body, 0.034, 0.075, 0.04, -0.004, axisY - 0.09, -0.43, COL.polymer, { rx: -0.1 });
  box(body, 0.06, 0.014, 0.05, -0.004, axisY - 0.054, -0.43, COL.gunmetal);
  box(bolt, 0.020, 0.030, 0.036, 0.062, axisY - 0.02, BOLT_HOME.thunderbolt - 0.12, COPPER);

  const sight = new THREE.Group(); sight.name = 'factory-optic'; body.add(sight);
  ironSights(sight, { rearZ: -0.01, frontZ: -0.56, height: SIGHT_Y,
    width: 0.04, gap: 0.016, color: COL.polyDark, accent: BLUE });
  box(sight, 0.018, 0.023, 0.022, 0, 0.129, -0.56, COL.polyDark);
  body.userData.sightHeight = SIGHT_Y;
  batch(body); batch(rotor); batch(arcs); batch(sight);
  const animated = { drum: mag, rotor, rounds, energy, arcs, pulseMaterial };
  animated.plasma = installThunderboltPlasma(animated);
  extra.userData.thunderbolt = animated;
  return true;
}
