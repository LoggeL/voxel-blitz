import * as THREE from '../../vendor/three.module.js';
import { createBlenderParts } from '../../engine/blender-assets.js';

// The cassette swings on the vertical hinge hub at its front edge (authoring
// (-0.142, 0.306, 0.020); game = (x, z, -y)). Runtime meshes carry baked
// game-space coordinates, so offset them into this pivot once at build.
const CASSETTE_HINGE = new THREE.Vector3(-0.142, 0.020, -0.306);
const ROUND_NAME = /round[ _-]*([1-3])(?:\b|[ _|-])/i;
const cleanedStockGeometry = new WeakMap();
const C = Object.freeze({
  black: 0x171b1e, steel: 0x30383d, edge: 0x657078, silver: 0x9a9d99,
  orange: 0xed711c, orangeLight: 0xff9d34, amber: 0xffb02e,
});

function mesh(parent, geometry, material, x, y, z, name) {
  const object = new THREE.Mesh(geometry, material);
  object.name = name;
  object.position.set(x, y, z);
  parent.add(object);
  return object;
}

function ring(parent, radius, tube, x, y, z, material, name) {
  return mesh(parent, new THREE.TorusGeometry(radius, tube, 6, 24), material, x, y, z, name);
}

function strut(parent, a, b, radius, material, name) {
  const from = new THREE.Vector3(...a);
  const to = new THREE.Vector3(...b);
  const object = mesh(parent, new THREE.CylinderGeometry(radius, radius, from.distanceTo(to), 8),
    material, 0, 0, 0, name);
  object.position.copy(from).add(to).multiplyScalar(0.5);
  object.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), to.sub(from).normalize());
  return object;
}

function sidePlate(parent, side, outline, thickness, material, name) {
  const shape = new THREE.Shape();
  for (let i = 0; i < outline.length; i++) {
    const [z, y] = outline[i];
    if (i) shape.lineTo(-z, y);
    else shape.moveTo(-z, y);
  }
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: true,
    bevelSegments: 1, steps: 1, bevelSize: 0.005, bevelThickness: 0.003 });
  geometry.rotateY(Math.PI / 2);
  const plate = mesh(parent, geometry, material, side * 0.066, 0, 0, name);
  if (side < 0) plate.position.x -= thickness;
  return plate;
}

// The Blender stock has four small, layered screw assemblies whose old cover
// supplied their backing. Keep its grip, rails and buttpad, and remove only
// those isolated triangles after the cover is hidden.
function removeUnbackedStockFasteners(body) {
  for (const part of body.children) {
    if (!part.isMesh || !part.visible || !part.geometry?.index) continue;
    const geometry = part.geometry;
    if (cleanedStockGeometry.has(geometry)) {
      part.geometry = cleanedStockGeometry.get(geometry);
      continue;
    }
    const position = geometry.getAttribute('position');
    const index = geometry.index;
    const retained = [];
    const isLegacyFastener = vertex => {
      const x = Math.abs(position.getX(vertex));
      const y = position.getY(vertex);
      const z = position.getZ(vertex);
      return z >= 0.17 && z <= 0.20 && x >= 0.04 && x <= 0.06 &&
        ((y >= 0.09 && y <= 0.11) || (y >= -0.07 && y <= -0.05));
    };
    for (let i = 0; i < index.count; i += 3) {
      const a = index.getX(i), b = index.getX(i + 1), c = index.getX(i + 2);
      if (!isLegacyFastener(a) || !isLegacyFastener(b) || !isLegacyFastener(c)) {
        retained.push(a, b, c);
      }
    }
    if (retained.length === index.count) {
      cleanedStockGeometry.set(geometry, geometry);
      continue;
    }
    const cleaned = geometry.clone();
    cleaned.setIndex(retained);
    cleaned.clearGroups();
    // The source geometry belongs to the page's Blender asset template. The
    // filtered form has the same lifetime and is shared by every gun instance.
    cleaned.userData.pageOwned = true;
    cleanedStockGeometry.set(geometry, cleaned);
    part.geometry = cleaned;
  }
}

function buildChassis(groups, kit, T, surfaces) {
  const { box, cylZ, mat } = kit;
  const { body, mag, bolt } = groups;
  const dark = mat(C.black, 0.48, 0.72);
  const steel = surfaces.steel || mat(C.steel, 0.42, 0.82);
  const edge = surfaces.edge || mat(C.edge, 0.36, 0.78);
  const orange = surfaces.orange || mat(C.orange, 0.52, 0.42);
  const orangeLight = mat(C.orangeLight, 0.48, 0.34);
  const silver = mat(C.silver, 0.34, 0.85);
  const amber = new THREE.MeshStandardMaterial({ color: C.amber, emissive: 0xd75c00,
    emissiveIntensity: 0.75, roughness: 0.38, metalness: 0.45 });

  // The barrel stays on the authored muzzle axis. An open vent cage sits around
  // it, with long windows that reveal the amber heat sleeve during each shot.
  cylZ(body, 0.048, 0.085, 0, 0.075, -0.490, C.steel, { seg: 20, rg: 0.43, mt: 0.82 });
  cylZ(body, 0.039, 0.260, 0, 0.075, -0.652, C.black, { seg: 20, rg: 0.43, mt: 0.82 });
  cylZ(body, 0.049, 0.030, 0, 0.075, -0.765, C.steel, { seg: 20, rg: 0.43, mt: 0.82 });
  cylZ(body, 0.051, 0.018, 0, 0.075, -0.469, C.silver, { seg: 20, rg: 0.35, mt: 0.85 });
  cylZ(body, 0.062, 0.012, 0, 0.075, -0.776, C.black, { seg: 16, rg: 0.42, mt: 0.82 });
  for (const z of [-0.535, -0.655, -0.758]) ring(body, 0.065, 0.008, 0, 0.075, z,
    z === -0.655 ? orange : edge, 'skipjack_muzzle_cage_ring');
  for (let i = 0; i < 8; i++) {
    const a = i * Math.PI / 4;
    const x = Math.cos(a) * 0.065;
    const y = 0.075 + Math.sin(a) * 0.065;
    strut(body, [x, y, -0.773], [x, y, -0.525], 0.005, i % 2 ? steel : edge,
      'skipjack_muzzle_cage_rail');
  }
  // Dark bore and bright inner bevel give the front of the cage depth.
  mesh(body, new THREE.CircleGeometry(0.041, 24), dark, 0, 0.075, T.muzzle[2] - 0.001,
    'skipjack_bore').rotation.y = Math.PI;
  ring(body, 0.044, 0.0025, 0, 0.075, T.muzzle[2] - 0.002, orangeLight, 'skipjack_bore_lip');

  // Open rotary feed housing. The layered rings and six radial feed tubes read as
  // a working mechanism from both third person and the near shoulder camera.
  cylZ(body, 0.095, 0.112, 0, 0.027, -0.385, C.black, { seg: 24, rg: 0.49, mt: 0.68 });
  for (const z of [-0.454, -0.321]) {
    ring(body, 0.099, 0.010, 0, 0.027, z, orange, 'skipjack_feed_lock_ring');
    ring(body, 0.078, 0.004, 0, 0.027, z + 0.002, silver, 'skipjack_feed_bearing');
  }
  for (const side of [-1, 1]) {
    const x = side * 0.098;
    cylZ(body, 0.026, 0.015, x, 0.027, -0.386, C.steel, { seg: 16, rg: 0.4, mt: 0.82 });
    ring(body, 0.025, 0.004, x, 0.027, -0.397, silver, 'skipjack_feed_side_hub');
  }
  const feed = new THREE.Group();
  feed.name = 'skipjack_rotary_feed';
  feed.position.set(0, 0.027, -0.385);
  body.add(feed);
  for (let i = 0; i < 6; i++) {
    const a = i * Math.PI / 3;
    const x = Math.cos(a) * 0.065;
    const y = Math.sin(a) * 0.065;
    cylZ(feed, 0.015, 0.108, x, y, 0, i % 2 ? C.steel : C.edge,
      { seg: 10, rg: 0.45, mt: 0.74 });
  }

  // Squared, segmented armor replaces the smooth olive clamshell. The top is
  // kept below the sight axis, with a mechanical spine visible between cheeks.
  box(body, 0.146, 0.113, 0.20, 0, 0.018, -0.338, C.black, { rg: 0.52, mt: 0.58 });
  for (const side of [-1, 1]) {
    box(body, 0.040, 0.148, 0.166, side * 0.080, 0.059, -0.345, C.orange,
      { rz: side * -0.10, mat: orange });
    box(body, 0.043, 0.025, 0.156, side * 0.082, 0.139, -0.343, C.orangeLight,
      { rg: 0.47, mt: 0.42 });
    box(body, 0.047, 0.031, 0.142, side * 0.077, -0.038, -0.348, C.steel,
      { mat: steel });
    // A visible steel piston links the chamber collar to the front shroud.
    strut(body, [side * 0.082, 0.150, -0.482], [side * 0.082, 0.150, -0.285],
      0.009, steel, 'skipjack_recoil_piston');
    for (const z of [-0.45, -0.30]) {
      mesh(body, new THREE.SphereGeometry(0.009, 8, 6), silver,
        side * 0.107, 0.105, z, 'skipjack_armor_fastener');
    }
  }
  box(body, 0.095, 0.015, 0.278, 0, 0.154, -0.355, C.steel, { mat: steel });
  for (const z of [-0.48, -0.44, -0.40, -0.36, -0.32]) {
    box(body, 0.104, 0.010, 0.012, 0, 0.165, z, C.edge, { rg: 0.4, mt: 0.8 });
  }

  // Rear receiver and skeleton stock. Large diagonal plates take the place
  // of the old continuous hood, leaving steel joints and the optic exposed.
  box(body, 0.126, 0.104, 0.255, 0, 0.025, -0.097, C.black, { mat: steel });
  box(body, 0.095, 0.025, 0.240, 0, 0.089, -0.096, C.steel, { mat: edge });
  for (const side of [-1, 1]) {
    sidePlate(body, side, [
      [-0.238, 0.058], [-0.212, 0.126], [-0.104, 0.132], [-0.075, 0.091],
      [-0.086, -0.025], [-0.215, -0.035],
    ], 0.027, orange, 'skipjack_rear_armor_plate');
    sidePlate(body, side, [
      [-0.060, 0.105], [0.015, 0.105], [0.059, 0.065], [0.047, -0.031],
      [-0.072, -0.031],
    ], 0.021, steel, 'skipjack_rear_receiver_plate');
    box(body, 0.014, 0.008, 0.160, side * 0.099, 0.117, -0.131,
      C.orangeLight, { rg: 0.45, mt: 0.48 });
    for (const z of [-0.177, -0.128, -0.078, 0.022]) {
      mesh(body, new THREE.SphereGeometry(0.006, 8, 6), silver,
        side * (z > 0 ? 0.089 : 0.097), 0.049, z, 'skipjack_rear_plate_bolt');
    }
    strut(body, [side * 0.039, 0.066, 0.020], [side * 0.039, 0.066, 0.246],
      0.012, edge, 'skipjack_stock_upper_rail');
    strut(body, [side * 0.038, -0.025, 0.020], [side * 0.038, -0.025, 0.246],
      0.012, steel, 'skipjack_stock_lower_rail');
    box(body, 0.034, 0.089, 0.024, side * 0.050, 0.021, 0.091,
      C.orange, { mat: orange });
    box(body, 0.033, 0.089, 0.024, side * 0.050, 0.021, 0.226,
      C.orange, { mat: orange });
    for (const z of [0.091, 0.226]) {
      mesh(body, new THREE.SphereGeometry(0.005, 8, 6), dark,
        side * 0.069, 0.022, z, 'skipjack_stock_bracket_fastener');
    }
  }
  // A single rigid bridge ties both pairs of rails together and seats on the
  // original polymer stock. The rods enter the bridge rather than passing by it.
  const bridge = box(body, 0.112, 0.112, 0.052, 0, 0.021, 0.147,
    C.steel, { mat: steel });
  bridge.name = 'skipjack_stock_bridge';
  const bridgeCap = box(body, 0.114, 0.014, 0.054, 0, 0.076, 0.147,
    C.edge, { mat: edge });
  bridgeCap.name = 'skipjack_stock_bridge_cap';
  box(body, 0.137, 0.119, 0.027, 0, 0.015, 0.252,
    C.black, { rg: 0.85, mt: 0.08 });
  for (const y of [-0.026, 0.004, 0.034, 0.064]) {
    box(body, 0.135, 0.007, 0.030, 0, y, 0.268, C.edge, { rg: 0.66, mt: 0.34 });
  }

  strut(body, [-0.098, 0.111, -0.174], [-0.082, 0.150, -0.300],
    0.006, edge, 'skipjack_chamber_feed_rail');
  strut(body, [-0.082, 0.150, -0.300], [-0.044, 0.098, -0.372],
    0.006, edge, 'skipjack_chamber_entry_guide');

  // Framed cassette windows leave every authored shell visible. Their glowing
  // bands live inside the same round groups, so zero ammo cannot show a glow.
  const frame = box(mag, 0.028, 0.220, 0.014, -0.160 - CASSETTE_HINGE.x,
    0.020 - CASSETTE_HINGE.y, -0.081 - CASSETTE_HINGE.z,
    C.orange, { mat: orange });
  frame.name = 'skipjack_cassette_orange_spine';
  for (const y of [0.103, 0.040, -0.023]) {
    // Fixed clamps, rather than ammo indicators, remain when the cassette empties.
    box(mag, 0.066, 0.010, 0.010, -0.128 - CASSETTE_HINGE.x,
      y - 0.030 - CASSETTE_HINGE.y, -0.084 - CASSETTE_HINGE.z,
      C.steel, { rg: 0.46, mt: 0.72 });
  }

  // The charging pawl gets enough mass to read its short chambering stroke.
  box(bolt, 0.049, 0.023, 0.053, 0.082, 0.087, -0.304, C.orange,
    { mat: orange });
  box(bolt, 0.015, 0.032, 0.060, 0.104, 0.093, -0.305, C.black,
    { rg: 0.53, mt: 0.58 });
  return { amber, feed };
}

// GL-3 SKIPJACK is authored as five rigid runtime parts. Up to three reserve
// rounds travel with the flank cassette (`mag`); one shot is already chambered.
// The charging pawl remains independent, so firing and reload motion stay
// inside the normal viewmodel contract.
export function buildSkipjack({ groups, kit, T }) {
  const parts = createBlenderParts('skipjack');
  if (!parts) return false;

  for (const key of ['body', 'bolt', 'trigger', 'extra']) {
    if (parts[key]) groups[key].add(...parts[key].children);
  }
  const surface = (texture, color, roughness, metalness) => {
    const original = groups.body.children.find((child) => child.material?.map?.name?.includes(texture))?.material;
    if (!original) return null;
    const material = original.clone();
    material.color.setHex(color);
    material.roughness = roughness;
    material.metalness = metalness;
    return material;
  };
  const surfaces = {
    orange: surface('orange-paint', 0xffffff, 0.52, 0.38),
    steel: surface('skipjack-dark-steel', 0xd7dce0, 0.45, 0.72),
    edge: surface('machined-steel', 0xaab1b7, 0.38, 0.78),
  };
  // Keep the original Blender surfaces as the mechanical substrate. Its broad
  // olive cover is deliberately hidden so the open feed and angular armor read.
  for (const child of groups.body.children) {
    const mapName = child.material?.map?.name || '';
    if (/olive[ _-]*drab/i.test(child.name) || /skipjack-olive-armor/i.test(mapName)) {
      child.visible = false;
    }
  }
  removeUnbackedStockFasteners(groups.body);

  const cassette = new THREE.Group();
  cassette.name = 'skipjack_cassette_hinge';
  cassette.position.copy(CASSETTE_HINGE);
  cassette.userData.homePosition = CASSETTE_HINGE.clone();
  const rounds = Array.from({ length: 3 }, (_, index) => {
    const group = new THREE.Group();
    group.name = `skipjack_round_${index + 1}`;
    group.userData.homePosition = new THREE.Vector3();
    // The authored shell's center in body space. The first round occupies the
    // upper cassette slot; subsequent slots are one round pitch lower.
    group.userData.homeCenter = new THREE.Vector3(-0.119, 0.083 - index * 0.063, -0.187);
    cassette.add(group);
    return group;
  });
  for (const mesh of [...(parts.mag?.children || [])]) {
    mesh.position.sub(CASSETTE_HINGE);
    const number = ROUND_NAME.exec(mesh.name)?.[1];
    (number ? rounds[Number(number) - 1] : cassette).add(mesh);
  }
  const { amber, feed } = buildChassis({ ...groups, mag: cassette }, kit, T, surfaces);
  for (let index = 0; index < rounds.length; index++) {
    const y = [0.083, 0.020, -0.043][index];
    ring(rounds[index], 0.025, 0.004,
      -0.119 - CASSETTE_HINGE.x, y - CASSETTE_HINGE.y,
      -0.182 - CASSETTE_HINGE.z, amber, 'skipjack_live_shell_band');
  }
  groups.mag.add(cassette);
  // `reload` is the presentation plan of the running swap (see ViewmodelRig.reload).
  groups.extra.userData.skipjack = {
    cassette, rounds, feed, reload: null,
    roundPitch: 0.063,
    chamberAnchor: new THREE.Vector3(0, 0.075, -0.385),
  };

  groups.body.userData.blenderAsset = 'skipjack';
  groups.body.userData.sightHeight = 0.216;
  groups.mag.userData.cassette = true;
  return true;
}
