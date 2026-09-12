import * as THREE from '../../vendor/three.module.js';

export const palette = { cloth: 0x8c6843, armor: 0x675342, glove: 0x514435, cuff: 0xc69a58 };

// Fabric keeps its team tint. These workshop fittings sit on the existing rigid
// joints and are batched by material, including the individual bolts and vents.
function fittings(ctx, parent, name) {
  const group = ctx.group(parent, `salvager_${name}`);
  const batches = new Map();
  const transform = new THREE.Matrix4();
  const orientation = new THREE.Quaternion();
  const position = new THREE.Vector3();
  const unit = new THREE.Vector3(1, 1, 1);
  function add(geometry, at, material, rotation = [0, 0, 0]) {
    orientation.setFromEuler(new THREE.Euler(...rotation));
    transform.compose(position.set(...at), orientation, unit);
    geometry.applyMatrix4(transform);
    if (geometry.index) {
      const indexed = geometry;
      geometry = geometry.toNonIndexed();
      indexed.dispose();
    }
    if (!batches.has(material)) batches.set(material, []);
    batches.get(material).push(geometry);
  }
  return {
    box(size, at, material, rotation) {
      add(new THREE.BoxGeometry(...size), at, material, rotation);
    },
    plate(size, at, material, rotation, bevel = 0.008) {
      const [w, h, d] = size;
      const b = Math.min(bevel, w / 4, h / 4, d / 4);
      const shape = new THREE.Shape();
      shape.moveTo(-w / 2 + b, -h / 2 + b);
      shape.lineTo(w / 2 - b, -h / 2 + b);
      shape.lineTo(w / 2 - b, h / 2 - b);
      shape.lineTo(-w / 2 + b, h / 2 - b);
      shape.closePath();
      const geometry = new THREE.ExtrudeGeometry(shape, {
        depth: d - 2 * b, bevelEnabled: true, bevelSegments: 1, steps: 1,
        bevelSize: b, bevelThickness: b,
      });
      geometry.translate(0, 0, -d / 2 + b);
      add(geometry, at, material, rotation);
    },
    cylinder(radius, length, at, material, rotation, segments = 10) {
      const geometry = new THREE.CylinderGeometry(radius, radius, length, segments);
      geometry.rotateX(Math.PI / 2);
      add(geometry, at, material, rotation);
    },
    finish() {
      for (const [material, pieces] of batches) {
        const geometry = new THREE.BufferGeometry();
        for (const key of ['position', 'normal', 'uv']) {
          const attrs = pieces.map(piece => piece.getAttribute(key));
          const array = new Float32Array(attrs.reduce((sum, attr) => sum + attr.array.length, 0));
          let offset = 0;
          for (const attr of attrs) { array.set(attr.array, offset); offset += attr.array.length; }
          geometry.setAttribute(key, new THREE.BufferAttribute(array, attrs[0].itemSize));
        }
        for (const piece of pieces) piece.dispose();
        geometry.computeBoundingSphere();
        const mesh = new THREE.Mesh(geometry, material);
        mesh.name = `${group.name}_batch`;
        group.add(mesh);
      }
      return group;
    },
  };
}

export function apply(avatar, ctx) {
  const ceramic = ctx.material(0xd4c9a7, { roughness: 0.78, metalness: 0.12 });
  const bronze = ctx.material(0x9c7141, { roughness: 0.48, metalness: 0.68 });
  const steel = ctx.material(0x494e49, { roughness: 0.62, metalness: 0.65 });
  const rubber = ctx.material(0x292b26, { roughness: 0.93, metalness: 0.04 });
  const amber = ctx.material(0xf2b85b, { emissive: 0x5b2508, emissiveIntensity: 0.6,
    roughness: 0.28, metalness: 0.28 });
  amber.userData.cosmeticGlow = true;
  // Only stock armor and the visor may change. Team cloth, shoulder bands and
  // exposed skin retain their original shared materials.
  for (const part of [avatar.torso, avatar.hips, avatar.head, avatar.lArm, avatar.rArm,
    avatar.lLeg, avatar.rLeg]) ctx.tint(part, {
    [0x26323b]: { color: 0x675342, roughness: 0.72, metalness: 0.38 },
    [0x6aa5af]: { color: 0xc39349, roughness: 0.26, metalness: 0.5 },
  });

  // Twin salvaged breast plates: the right one has a visibly replaced corner.
  const chest = fittings(ctx, avatar.torso, 'chest');
  chest.plate([0.172, 0.182, 0.028], [-0.094, 0.005, -0.251], ceramic, [0, 0, -0.045]);
  chest.plate([0.172, 0.13, 0.028], [0.094, 0.028, -0.251], ceramic, [0, 0, 0.035]);
  chest.plate([0.173, 0.047, 0.032], [0.094, -0.066, -0.254], bronze, [0, 0, 0.035]);
  chest.box([0.022, 0.197, 0.008], [0, 0.005, -0.272], rubber);
  for (const x of [-0.158, -0.028, 0.028, 0.158]) for (const y of [-0.065, 0.072]) {
    chest.cylinder(0.009, 0.009, [x, y, -0.272], bronze, undefined, 6);
  }
  // Recessed serial plate, tiny embossed dots and stepped repair staples.
  chest.box([0.093, 0.028, 0.009], [-0.098, 0.015, -0.273], steel);
  for (let i = 0; i < 5; i++) chest.box([0.007, 0.012, 0.003], [-0.128 + i * 0.014, 0.015, -0.28], ceramic);
  for (let i = 0; i < 3; i++) chest.box([0.015, 0.028, 0.008], [0.05 + i * 0.036, -0.038, -0.276], steel);
  chest.plate([0.035, 0.098, 0.03], [-0.218, 0.034, -0.206], bronze);
  for (const y of [0.004, 0.034, 0.064]) chest.box([0.016, 0.012, 0.008], [-0.218, y, -0.225], amber);
  // Low side guards leave the team-colored shoulder and upper chest stripe clear.
  for (const side of [-1, 1]) chest.plate([0.037, 0.20, 0.23], [side * 0.245, -0.102, 0], steel);
  chest.finish();

  const head = fittings(ctx, avatar.head, 'respirator');
  head.plate([0.255, 0.105, 0.06], [0, -0.096, -0.174], rubber, undefined, 0.012);
  head.plate([0.105, 0.087, 0.029], [0, -0.085, -0.216], ceramic);
  // Main filter on one side, smaller valve on the other, no mirrored gas-mask toy.
  head.cylinder(0.047, 0.046, [-0.103, -0.097, -0.211], bronze, [0, -0.18, 0]);
  head.cylinder(0.036, 0.049, [-0.104, -0.097, -0.219], rubber, [0, -0.18, 0]);
  head.cylinder(0.027, 0.028, [0.101, -0.103, -0.211], steel);
  head.cylinder(0.017, 0.031, [0.101, -0.103, -0.215], bronze);
  for (let i = -2; i <= 2; i++) head.box([0.011, 0.043 - Math.abs(i) * 0.006, 0.006],
    [-0.103 + i * 0.012, -0.097, -0.249], bronze);
  for (const y of [-0.062, -0.081, -0.100]) head.box([0.065, 0.006, 0.005], [0, y, -0.233], rubber);
  // Brow reinforcement and a compact workshop lamp, below the helmet crown.
  head.plate([0.287, 0.019, 0.029], [0, 0.04, -0.181], bronze);
  head.plate([0.044, 0.084, 0.12], [0.182, 0.034, -0.003], steel);
  head.cylinder(0.022, 0.027, [0.182, 0.051, -0.077], bronze);
  head.cylinder(0.014, 0.03, [0.182, 0.051, -0.08], amber);
  for (const side of [-1, 1]) {
    head.box([0.013, 0.023, 0.15], [side * 0.146, -0.078, -0.038], rubber);
    head.cylinder(0.011, 0.014, [side * 0.157, -0.03, -0.051], bronze);
  }
  head.finish();

  const pack = fittings(ctx, avatar.pack, 'reclaimer_pack');
  pack.plate([0.22, 0.30, 0.045], [0, -0.196, 0.134], steel);
  for (const x of [-0.091, 0.091]) {
    // Cylinder helper is Z-aligned; turn each reservoir upright along local Y.
    pack.cylinder(0.048, 0.272, [x, -0.18, 0.169], ceramic, [Math.PI / 2, 0, 0]);
    for (const y of [-0.31, -0.18, -0.05]) {
      pack.cylinder(0.052, 0.02, [x, y, 0.169], bronze, [Math.PI / 2, 0, 0]);
    }
    pack.cylinder(0.022, 0.037, [x, -0.022, 0.169], steel, [Math.PI / 2, 0, 0]);
    pack.box([0.015, 0.272, 0.013], [x, -0.18, 0.22], bronze);
  }
  for (const y of [-0.267, -0.108]) pack.box([0.31, 0.025, 0.014], [0, y, 0.224], steel);
  pack.box([0.038, 0.032, 0.014], [0, -0.108, 0.235], bronze);
  // Rear vent slots and the off-center service-key handle.
  for (let y = -0.28; y < -0.12; y += 0.036) pack.box([0.022, 0.009, 0.013], [0, y, 0.164], bronze);
  pack.box([0.025, 0.16, 0.024], [-0.164, -0.12, 0.095], bronze);
  pack.box([0.068, 0.022, 0.028], [-0.164, -0.037, 0.095], steel);
  pack.finish();

  const belt = fittings(ctx, avatar.hips, 'utility_belt');
  belt.plate([0.092, 0.061, 0.025], [0, 0.059, -0.174], bronze);
  belt.box([0.061, 0.036, 0.029], [0, 0.059, -0.177], steel);
  for (const side of [-1, 1]) {
    belt.box([0.033, 0.085, 0.026], [side * 0.164, 0.058, -0.166], bronze);
    belt.box([0.04, 0.057, 0.039], [side * 0.211, 0.032, 0.09], steel);
  }
  belt.finish();

  for (const [elbow, side] of [[avatar.lElbow, -1], [avatar.rElbow, 1]]) {
    const arm = fittings(ctx, elbow, side < 0 ? 'left_gauntlet' : 'right_gauntlet');
    arm.plate([0.155, 0.15, 0.03], [0, -0.143, 0.106], side < 0 ? bronze : ceramic);
    for (const y of [-0.084, -0.202]) arm.box([0.158, 0.017, 0.017], [0, y, 0.126], steel);
    if (side < 0) {
      // A riveted forearm tool rail with a three-prong stamped service fitting.
      arm.box([0.021, 0.105, 0.018], [-0.042, -0.144, 0.135], steel);
      for (const x of [-0.048, -0.028, -0.008]) arm.box([0.011, 0.03, 0.018], [x, -0.09, 0.138], steel);
      for (const x of [-0.06, 0.06]) for (const y of [-0.092, -0.192]) arm.cylinder(0.006, 0.008, [x, y, 0.136], steel, undefined, 6);
    } else {
      for (const x of [-0.048, -0.018, 0.012, 0.042]) arm.box([0.009, 0.064, 0.009], [x, -0.145, 0.128], steel);
    }
    arm.finish();
  }

  for (const [leg, side] of [[avatar.lLeg, -1], [avatar.rLeg, 1]]) {
    const { thigh, knee, boot } = leg.userData.joints;
    const upper = fittings(ctx, thigh, side < 0 ? 'left_tool_holster' : 'right_tool_holster');
    // Flat holstered fittings stay inside the original thigh armor envelope.
    upper.box([0.027, 0.142, 0.024], [side * 0.161, -0.16, -0.051], bronze);
    upper.box([0.027, 0.142, 0.024], [side * 0.161, -0.16, 0.025], bronze);
    upper.box([0.031, 0.022, 0.123], [side * 0.163, -0.09, -0.012], bronze);
    upper.box([0.031, 0.018, 0.123], [side * 0.163, -0.18, -0.012], bronze);
    upper.finish();

    const lower = fittings(ctx, knee, side < 0 ? 'left_greave' : 'right_greave');
    lower.plate([0.172, 0.12, 0.025], [0, -0.025, -0.171], ceramic);
    lower.plate([0.102, 0.113, 0.018], [0, -0.151, -0.113], bronze);
    for (const x of [-0.063, 0.063]) lower.cylinder(0.008, 0.009, [x, -0.021, -0.188], bronze, undefined, 6);
    for (const y of [-0.14, -0.172]) lower.box([0.12, 0.009, 0.009], [0, y, -0.128], ceramic);
    lower.finish();

    const foot = fittings(ctx, boot, side < 0 ? 'left_steeltoe' : 'right_steeltoe');
    foot.plate([0.185, 0.074, 0.026], [0, -0.007, -0.214], bronze);
    for (const x of [-0.061, 0, 0.061]) foot.box([0.018, 0.086, 0.014], [x, -0.006, -0.232], bronze);
    foot.finish();
  }

  for (const [hand, side] of [[avatar.lHand, -1], [avatar.rHand, 1]]) {
    const glove = fittings(ctx, hand, side < 0 ? 'left_glove' : 'right_glove');
    glove.plate([0.072, 0.07, 0.014], [0, 0.002, 0.055], bronze, undefined, 0.003);
    for (const x of [-0.025, 0, 0.025]) glove.box([0.012, 0.019, 0.018], [x, -0.025, 0.057], bronze);
    glove.finish();
  }
}
