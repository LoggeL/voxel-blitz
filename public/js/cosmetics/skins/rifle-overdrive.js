import * as THREE from '../../vendor/three.module.js';

// OVERDRIVE / OD-077. Machined violet shells over carbon composite, with an exposed
// data bus on the left and a serviceable ejection cover on the right. Every added
// piece belongs to its animated parent and the layer owns every new resource.
export function apply(model, ctx) {
  const palette = {
    0x454b52: { color: 0x302b43, roughness: 0.42, metalness: 0.66 },
    0x3c4046: { color: 0x58417c, roughness: 0.36, metalness: 0.68 },
    0x22252a: { color: 0x171922, roughness: 0.66, metalness: 0.22 },
    0x15171a: { color: 0x10131b, roughness: 0.82, metalness: 0.15 },
    0x2b3038: { color: 0x262e3e, roughness: 0.32, metalness: 0.8 },
    0xff8c1a: { color: 0x57decf, roughness: 0.38, metalness: 0.48 },
  };
  for (const part of [model.body, model.mag, model.bolt, model.triggerGroup]) {
    for (const child of part?.children || []) {
      if (child.name !== 'hand_l' && child.name !== 'hand_r') ctx.tint(child, palette);
    }
  }

  const violet = ctx.material(0x7047ba, { roughness: 0.38, metalness: 0.58 });
  const edge = ctx.material(0xafa6cb, { roughness: 0.29, metalness: 0.78 });
  const carbon = ctx.material(0x171d2b, { roughness: 0.72, metalness: 0.26 });
  const weave = ctx.material(0x354052, { roughness: 0.43, metalness: 0.43 });
  const ink = ctx.material(0x090e17, { roughness: 0.64, metalness: 0.15 });
  const cyan = ctx.material(0x71f3e0, {
    roughness: 0.4, metalness: 0.35, emissive: 0x16b9ac, emissiveIntensity: 0.16,
  });
  const body = ctx.group(model.body, 'overdrive_receiver_and_handguard');
  const magazine = ctx.group(model.mag, 'overdrive_magazine');
  const bolt = ctx.group(model.bolt, 'overdrive_charging_handle');

  // Fine detail is grouped by material and animation owner, so a weave, a vent bank
  // or a whole engraved serial adds instances instead of one draw per tiny mark.
  const batches = new Map();
  const block = (parent, material, size, position, rotation = [0, 0, 0]) => {
    if (!batches.has(parent)) batches.set(parent, new Map());
    const materials = batches.get(parent);
    if (!materials.has(material)) materials.set(material, []);
    materials.get(material).push({ size, position, rotation });
  };
  const stroke = (parent, material, x, y1, z1, y2, z2, width = 0.0013) => {
    block(parent, material, [0.0009, width, Math.hypot(y2 - y1, z2 - z1)],
      [x, (y1 + y2) / 2, (z1 + z2) / 2], [-Math.atan2(y2 - y1, z2 - z1), 0, 0]);
  };
  const panel = (parent, x, outline, material, name) => {
    const shape = new THREE.Shape(outline.map(([z, y]) => new THREE.Vector2(-z, y)));
    const geometry = new THREE.ExtrudeGeometry(shape, {
      depth: 0.0022, bevelEnabled: true, bevelSegments: 1,
      bevelThickness: 0.00055, bevelSize: 0.00075, steps: 1, curveSegments: 1,
    });
    geometry.rotateY(Math.PI / 2);
    geometry.translate(x - 0.0011, 0, 0);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    parent.add(mesh);
  };

  // Receiver shells are deliberately different: right panel ends below the moving
  // ejection cover, while the left carries the long circuit and inset serial plate.
  panel(body, -0.0535, [
    [-0.224, 0.016], [-0.224, 0.067], [-0.206, 0.079], [-0.073, 0.079],
    [-0.045, 0.051], [-0.045, 0.016], [-0.064, 0.009], [-0.209, 0.009],
  ], violet, 'overdrive_left_chamfered_receiver');
  panel(body, 0.0525, [
    [-0.221, -0.020], [-0.221, 0.034], [-0.192, 0.034], [-0.176, 0.027],
    [-0.063, 0.027], [-0.063, -0.021], [-0.092, -0.033], [-0.205, -0.033],
  ], violet, 'overdrive_right_lower_receiver');

  // Carbon cassette and twill weave: short alternating diagonals do not spill past
  // its inset. Small gaps preserve legibility at a first-person viewing distance.
  block(body, carbon, [0.003, 0.031, 0.116], [-0.056, 0.033, -0.143]);
  for (let column = 0; column < 15; column++) {
    const z = -0.195 + column * 0.0074;
    for (let row = 0; row < 3; row++) {
      const y = 0.023 + row * 0.009;
      block(body, weave, [0.0008, 0.0014, 0.007], [-0.0579, y, z],
        [(column + row) % 2 ? 0.65 : -0.65, 0, 0]);
    }
  }
  stroke(body, edge, -0.0568, 0.075, -0.207, 0.075, -0.082, 0.0015);
  stroke(body, cyan, -0.058, 0.058, -0.214, 0.058, -0.169);
  stroke(body, cyan, -0.058, 0.058, -0.169, 0.066, -0.161);
  stroke(body, cyan, -0.058, 0.066, -0.161, 0.066, -0.085);
  stroke(body, cyan, -0.058, 0.062, -0.213, 0.062, -0.178, 0.0007);
  stroke(body, cyan, -0.058, 0.062, -0.178, 0.071, -0.170, 0.0007);
  stroke(body, cyan, -0.058, 0.071, -0.170, 0.071, -0.134, 0.0007);
  for (let i = 0; i < 3; i++) {
    block(body, cyan, [0.0012, 0.003, 0.004], [-0.058, 0.066, -0.077 + i * 0.006]);
  }

  // Recessed service-cover slats and cut-aluminium fasteners on the opposite side.
  for (let i = 0; i < 7; i++) {
    block(body, ink, [0.001, 0.017, 0.0028], [0.0591, 0.063, -0.150 + i * 0.007]);
  }
  block(body, carbon, [0.0028, 0.020, 0.080], [0.0553, 0.005, -0.151]);
  stroke(body, cyan, 0.0574, -0.020, -0.202, -0.020, -0.139);
  stroke(body, cyan, 0.0574, -0.020, -0.139, -0.012, -0.131);
  for (const side of [-1, 1]) {
    for (const [y, z] of [[0.018, -0.211], [0.021, -0.079]]) {
      block(body, edge, [0.0024, 0.005, 0.005], [side * 0.0573, y, z], [Math.PI / 4, 0, 0]);
      block(body, ink, [0.0008, 0.001, 0.003], [side * 0.0589, y, z]);
    }
  }

  // Three separate armor cells preserve the existing handguard rib silhouette.
  // The long cyan traces sit on the side faces, below the iron-sight picture.
  for (const side of [-1, 1]) {
    for (let cell = 0; cell < 3; cell++) {
      const z = -0.303 - cell * 0.076;
      panel(body, side * 0.0585, [
        [z + 0.031, 0.029], [z + 0.031, 0.084], [z + 0.021, 0.091],
        [z - 0.028, 0.091], [z - 0.034, 0.080], [z - 0.034, 0.030],
      ], violet, `overdrive_vent_shell_${side}_${cell}`);
      block(body, ink, [0.002, 0.026, 0.046], [side * 0.0604, 0.061, z - 0.003]);
      for (let vent = 0; vent < 4; vent++) {
        block(body, side < 0 ? edge : weave, [0.0014, 0.020, 0.003],
          [side * 0.0621, 0.061, z + 0.013 - vent * 0.011], [0.28, 0, 0]);
      }
      stroke(body, cyan, side * 0.0609, 0.084, z + 0.022, 0.084, z - 0.020, 0.0016);
      stroke(body, cyan, side * 0.0609, 0.084, z - 0.020, 0.076, z - 0.028, 0.0016);
      block(body, edge, [0.0012, 0.004, 0.004], [side * 0.061, 0.037, z + 0.022]);
    }
    // Stock gets a thin, faceted inlay. The open butt frame stays open.
    block(body, violet, [0.003, 0.010, 0.080], [side * 0.0362, 0.101, 0.147]);
    block(body, cyan, [0.0008, 0.0015, 0.043], [side * 0.0381, 0.102, 0.157]);
  }

  // An actual geometry serial, not random decorative bars. Seven-segment glyphs
  // read OD-077, with enough spacing to remain a small industrial marking.
  const glyphs = { O: 'abcdef', D: 'bcdeg', '-': 'g', 0: 'abcdef', 7: 'abc' };
  const segments = {
    a: [1, 0, 1, 1], b: [1, 1, 0.5, 1], c: [0.5, 1, 0, 1],
    d: [0, 0, 0, 1], e: [0, 0, 0.5, 0], f: [0.5, 0, 1, 0], g: [0.5, 0, 0.5, 1],
  };
  const serial = (parent, x, y, z, height, material) => {
    [...'OD-077'].forEach((letter, index) => {
      for (const key of glyphs[letter]) {
        const [y1, z1, y2, z2] = segments[key];
        const advance = index * height * 0.79;
        stroke(parent, material, x, y + y1 * height, z + advance + z1 * height * 0.47,
          y + y2 * height, z + advance + z2 * height * 0.47, height * 0.085);
      }
    });
  };
  serial(body, 0.0572, -0.0015, -0.177, 0.010, edge);

  // Magazine armor follows the original curve and stays attached through reloads.
  for (const side of [-1, 1]) {
    panel(magazine, side * 0.038, [
      [-0.173, -0.100], [-0.121, -0.091], [-0.111, -0.150], [-0.082, -0.209],
      [-0.128, -0.224], [-0.153, -0.172],
    ], violet, `overdrive_magazine_chamfer_${side}`);
    for (let row = 0; row < 6; row++) {
      const y = -0.115 - row * 0.015;
      const z = -0.148 + row * 0.0045;
      block(magazine, carbon, [0.0018, 0.007, 0.033], [side * 0.040, y, z], [-0.20, 0, 0]);
      block(magazine, weave, [0.0008, 0.001, 0.025], [side * 0.0413, y + 0.002, z]);
    }
    stroke(magazine, cyan, side * 0.0414, -0.110, -0.126, -0.151, -0.119, 0.0015);
    stroke(magazine, cyan, side * 0.0414, -0.151, -0.119, -0.207, -0.095, 0.0015);
    block(magazine, edge, [0.0018, 0.004, 0.006], [side * 0.041, -0.210, -0.119], [0.34, 0, 0]);
  }
  // The charging lever itself carries the knurl, never a static floating overlay.
  for (let i = 0; i < 5; i++) {
    block(bolt, ink, [0.013, 0.0012, 0.0015], [-0.078, 0.1007, 0.005 + i * 0.0034]);
  }
  block(bolt, cyan, [0.001, 0.005, 0.010], [-0.0886, 0.091, 0.013]);

  const dummy = new THREE.Object3D();
  for (const [parent, materials] of batches) {
    for (const [material, transforms] of materials) {
      const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), material, transforms.length);
      mesh.name = 'overdrive_batched_detail';
      transforms.forEach(({ size, position, rotation }, index) => {
        dummy.position.set(...position); dummy.rotation.set(...rotation); dummy.scale.set(...size);
        dummy.updateMatrix(); mesh.setMatrixAt(index, dummy.matrix);
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingBox(); mesh.computeBoundingSphere();
      parent.add(mesh);
    }
  }
}
