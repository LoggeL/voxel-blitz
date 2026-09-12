import * as THREE from '../../vendor/three.module.js';

export const palette = { cloth: 0x393c54, armor: 0x282332, glove: 0x292532, cuff: 0xbb91ff };

const INK = 0x13111c;
const OBSIDIAN = 0x3c324b;
const FACET = 0x665a76;
const EDGE = 0x9c87b2;
const ETCH = 0xd2c3ed;
const VIOLET = 0xbb91ff;

// Rigid details are batched by finish within each animated joint. Vertex colors
// retain the many individual facets without giving every engraving a draw call.
function panels(ctx, parent, name, finishes) {
  const group = ctx.group(parent, `revenant_${name}`);
  const batches = [[], []];
  const transform = new THREE.Object3D();
  function add(geometry, position, color, rotation = [0, 0, 0], luminous = false) {
    const source = geometry.index ? geometry.toNonIndexed() : geometry;
    if (source !== geometry) geometry.dispose();
    transform.position.set(...position);
    transform.rotation.set(...rotation);
    transform.updateMatrix();
    source.applyMatrix4(transform.matrix);
    const tint = new THREE.Color(color);
    const colors = new Float32Array(source.attributes.position.count * 3);
    for (let i = 0; i < colors.length; i += 3) {
      colors[i] = tint.r; colors[i + 1] = tint.g; colors[i + 2] = tint.b;
    }
    source.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    batches[luminous ? 1 : 0].push(source);
  }
  function box(size, position, color = OBSIDIAN, rotation, luminous = false) {
    add(new THREE.BoxGeometry(...size), position, color, rotation, luminous);
  }
  function plate(points, depth, position, color = OBSIDIAN, bevel = 0.003, rotation) {
    const shape = new THREE.Shape();
    points.forEach(([x, y], i) => i ? shape.lineTo(x, y) : shape.moveTo(x, y));
    shape.closePath();
    const geometry = new THREE.ExtrudeGeometry(shape, {
      depth: depth - bevel * 2, bevelEnabled: bevel > 0, bevelSize: bevel,
      bevelThickness: bevel, bevelSegments: 1, steps: 1, curveSegments: 1,
    });
    geometry.translate(0, 0, -depth / 2 + bevel);
    add(geometry, position, color, rotation);
  }
  function line(a, b, z, width = 0.003, color = ETCH, luminous = false) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    box([width, Math.hypot(dx, dy), 0.002], [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, z],
      color, [0, 0, -Math.atan2(dx, dy)], luminous);
  }
  function ring(radius, tube, position, color = EDGE, rotation = [0, 0, 0], luminous = false) {
    add(new THREE.TorusGeometry(radius, tube, 3, 8), position, color, rotation, luminous);
  }
  function finish() {
    batches.forEach((sources, index) => {
      if (!sources.length) return;
      const geometry = new THREE.BufferGeometry();
      for (const key of ['position', 'normal', 'color']) {
        const total = sources.reduce((n, source) => n + source.attributes[key].array.length, 0);
        const array = new Float32Array(total);
        let offset = 0;
        for (const source of sources) {
          array.set(source.attributes[key].array, offset);
          offset += source.attributes[key].array.length;
        }
        geometry.setAttribute(key, new THREE.BufferAttribute(array, 3));
      }
      for (const source of sources) source.dispose();
      geometry.computeBoundingSphere();
      const mesh = new THREE.Mesh(geometry, finishes[index]);
      mesh.name = `${group.name}_${index ? 'channels' : 'armor'}`;
      group.add(mesh);
    });
  }
  return { group, box, plate, line, ring, finish };
}

const HEX = [[-0.5, -0.30], [-0.28, -0.5], [0.28, -0.5], [0.5, -0.30], [0.5, 0.30], [0.28, 0.5], [-0.28, 0.5], [-0.5, 0.30]];
const shield = (w, h) => [[-w / 2, h / 2], [w / 2, h / 2], [w / 2, -h * 0.24], [0, -h / 2], [-w / 2, -h * 0.24]];
const hex = (w, h) => HEX.map(([x, y]) => [x * w, y * h]);

function glyph(p, x, y, z, scale = 1) {
  const point = (a, b) => [x + a * scale, y + b * scale];
  // A broken double diamond and descending stem, repeated across the armor.
  for (const [a, b] of [
    [[0, 0.022], [0.016, 0]], [[0.016, 0], [0, -0.022]],
    [[0, -0.022], [-0.016, 0]], [[-0.016, 0], [-0.006, 0.014]],
    [[0, 0.011], [0.007, 0]], [[0.007, 0], [0, -0.010]],
    [[0, -0.022], [0, -0.038]], [[-0.008, -0.031], [0.008, -0.031]],
  ]) p.line(point(...a), point(...b), z, Math.max(0.0015, 0.0024 * scale), ETCH, true);
}

function helmet(ctx, av, materials) {
  const p = panels(ctx, av.head, 'sealed_helm', materials);
  // The face seal hides exposed cheeks on every base operator variant, while
  // the existing team-colored helmet shell remains visible above and behind it.
  p.plate([[-0.139, 0.045], [0.139, 0.045], [0.143, -0.083], [0.081, -0.153], [-0.081, -0.153], [-0.143, -0.083]],
    0.028, [0, 0, -0.169], INK, 0.005);
  p.plate(hex(0.299, 0.060), 0.024, [0, 0.066, -0.175], OBSIDIAN);
  p.plate([[-0.148, 0.014], [-0.09, 0.03], [0, 0.015], [0.09, 0.03], [0.148, 0.014], [0.105, -0.015], [0, -0.029], [-0.105, -0.015]],
    0.019, [0, 0.010, -0.188], FACET, 0.002);
  p.plate(hex(0.246, 0.027), 0.010, [0, 0.007, -0.202], INK, 0.001);
  for (const side of [-1, 1]) {
    p.line([side * 0.014, 0.006], [side * 0.11, 0.013], -0.209, 0.006, VIOLET, true);
    p.plate([[-0.035, 0.022], [0.025, 0.031], [0.037, -0.029], [0, -0.052], [-0.034, -0.021]],
      0.017, [side * 0.09, -0.068, -0.191], side < 0 ? FACET : OBSIDIAN, 0.003, [0, side * 0.12, side * 0.14]);
    // Three inset respirator vents on each cheek, with polished lower edges.
    for (let i = 0; i < 3; i++) {
      p.box([0.027, 0.008, 0.002], [side * (0.080 + i * 0.004), -0.055 - i * 0.015, -0.204], INK, [0, 0, side * 0.24]);
      p.box([0.022, 0.002, 0.002], [side * (0.080 + i * 0.004), -0.058 - i * 0.015, -0.206], EDGE, [0, 0, side * 0.24]);
    }
    p.plate(hex(0.04, 0.086), 0.029, [side * 0.183, -0.020, 0.02], OBSIDIAN);
    p.box([0.004, 0.039, 0.018], [side * 0.206, -0.018, 0.01], EDGE);
    p.box([0.003, 0.013, 0.014], [side * 0.209, -0.013, 0.01], VIOLET, undefined, true);
    p.line([side * 0.112, 0.063], [side * 0.076, 0.070], -0.190, 0.002);
  }
  p.plate(shield(0.070, 0.100), 0.028, [0, -0.075, -0.204], OBSIDIAN);
  p.plate(shield(0.022, 0.073), 0.014, [0, -0.067, -0.224], FACET, 0.002);
  p.line([-0.029, -0.101], [0, -0.127], -0.220, 0.003, EDGE);
  p.line([0, -0.127], [0.029, -0.101], -0.220, 0.003, EDGE);
  glyph(p, 0, 0.063, -0.191, 0.53);
  p.finish();
}

function cuirass(ctx, av, materials) {
  const p = panels(ctx, av.torso, 'cuirass', materials);
  for (const side of [-1, 1]) {
    p.plate(hex(0.168, 0.215), 0.026, [side * 0.095, 0.019, -0.250], OBSIDIAN, 0.005, [0, side * 0.05, side * 0.04]);
    p.plate([[-0.065, 0.073], [0.057, 0.073], [0.067, 0.027], [0, -0.065], [-0.067, 0.027]],
      0.012, [side * 0.095, 0.030, -0.270], side < 0 ? FACET : OBSIDIAN, 0.002);
    p.line([side * 0.025, 0.086], [side * 0.028, 0.008], -0.279, 0.006, VIOLET, true);
    p.line([side * 0.028, 0.008], [side * 0.068, -0.044], -0.279, 0.006, VIOLET, true);
    p.line([side * 0.082, -0.060], [side * 0.147, 0.014], -0.280, 0.003, EDGE);
    for (let i = 0; i < 4; i++) {
      p.line([side * (0.113 + i * 0.008), 0.077], [side * (0.108 + i * 0.008), 0.061], -0.279, 0.002);
    }
    // Segmented ribs remain on the torso; shoulder cloth is never covered.
    for (let i = 0; i < 3; i++) {
      p.plate(hex(0.062, 0.025), 0.015, [side * 0.208, -0.040 - i * 0.033, -0.179], i === 0 ? EDGE : OBSIDIAN,
        0.002, [0, side * 0.62, 0]);
    }
  }
  p.plate(shield(0.038, 0.111), 0.020, [0, 0.001, -0.280], INK, 0.003);
  glyph(p, 0, 0.029, -0.292, 0.67);
  p.plate(hex(0.205, 0.039), 0.014, [0, -0.123, -0.282], OBSIDIAN, 0.002);
  for (const side of [-1, 1]) p.line([side * 0.025, -0.115], [side * 0.072, -0.115], -0.291, 0.002, EDGE);
  p.finish();

  const belt = panels(ctx, av.hips, 'segmented_belt', materials);
  for (const side of [-1, 1]) {
    belt.plate(hex(0.100, 0.042), 0.020, [side * 0.130, 0.066, -0.169], OBSIDIAN, 0.002);
    belt.box([0.014, 0.031, 0.003], [side * 0.141, 0.066, -0.181], EDGE);
  }
  belt.plate(hex(0.064, 0.048), 0.014, [0, 0.066, -0.200], FACET, 0.002);
  belt.ring(0.016, 0.002, [0, 0.066, -0.210], VIOLET, undefined, true);
  glyph(belt, 0, 0.071, -0.211, 0.3);
  belt.finish();
}

function reactor(ctx, av, materials) {
  const p = panels(ctx, av.pack, 'reliquary', materials);
  // Variant 2 has a deeper factory pack. Seat the same assembly on its surface.
  p.group.position.z = av.variant === 2 ? 0.080 : 0;
  p.plate(hex(0.308, 0.300), 0.025, [0, -0.163, 0.109], OBSIDIAN, 0.005);
  // Split rails frame an octagonal sealed core. The assembly follows the pack's
  // gear motion instead of floating rigidly with the main torso.
  for (const side of [-1, 1]) {
    p.plate(hex(0.053, 0.271), 0.029, [side * 0.118, -0.163, 0.136], FACET, 0.003);
    p.box([0.008, 0.224, 0.004], [side * 0.116, -0.163, 0.153], INK);
    p.line([side * 0.116, -0.064], [side * 0.116, -0.254], 0.156, 0.0045, VIOLET, true);
    for (let i = 0; i < 5; i++) {
      p.box([0.044, 0.008, 0.013], [side * 0.118, -0.083 - i * 0.040, 0.158], EDGE);
    }
    p.line([side * 0.076, -0.112], [side * 0.089, -0.080], 0.143, 0.004, EDGE);
    p.line([side * 0.076, -0.208], [side * 0.089, -0.247], 0.143, 0.004, EDGE);
  }
  p.plate(hex(0.175, 0.204), 0.024, [0, -0.163, 0.131], INK, 0.004);
  p.ring(0.066, 0.009, [0, -0.157, 0.151], FACET);
  p.ring(0.052, 0.003, [0, -0.157, 0.158], VIOLET, [0, 0, Math.PI / 8], true);
  p.plate(hex(0.070, 0.077), 0.022, [0, -0.157, 0.162], OBSIDIAN, 0.003);
  glyph(p, 0, -0.151, 0.175, 0.90);
  for (const y of [-0.060, -0.260]) {
    p.box([0.078, 0.011, 0.009], [0, y, 0.143], EDGE);
    p.box([0.026, 0.004, 0.003], [0, y, 0.150], VIOLET, undefined, true);
  }
  p.finish();
}

function arms(ctx, av, materials) {
  for (const [side, arm, elbow, hand] of [[-1, av.lArm, av.lElbow, av.lHand], [1, av.rArm, av.rElbow, av.rHand]]) {
    const shoulder = panels(ctx, arm, `${side < 0 ? 'left' : 'right'}_pauldron`, materials);
    // Three scales stop above the base shoulder stripe, leaving its team ID visible.
    shoulder.plate(hex(0.179, 0.035), 0.219, [0, 0.012, 0], OBSIDIAN, 0.003);
    shoulder.plate(hex(0.067, 0.081), 0.036, [side * 0.074, -0.115, -0.092], OBSIDIAN, 0.003);
    shoulder.plate(hex(0.049, 0.062), 0.031, [side * 0.082, -0.157, -0.085], FACET, 0.002);
    shoulder.line([side * 0.055, -0.093], [side * 0.057, -0.130], -0.113, 0.0045, VIOLET, true);
    shoulder.line([-0.056, 0.013], [0.056, 0.013], -0.114, 0.002, EDGE);
    glyph(shoulder, side * 0.073, -0.101, -0.114, 0.4);
    shoulder.finish();

    const fore = panels(ctx, elbow, `${side < 0 ? 'left' : 'right'}_vambrace`, materials);
    fore.plate(hex(0.139, 0.188), 0.020, [0, -0.145, 0.100], OBSIDIAN, 0.003);
    fore.plate(shield(0.103, 0.128), 0.014, [0, -0.128, 0.115], FACET, 0.002);
    fore.line([0.044, -0.080], [0.044, -0.175], 0.119, 0.0045, VIOLET, true);
    for (let i = 0; i < 3; i++) {
      fore.plate(hex(0.123 - i * 0.009, 0.023), 0.015, [0, -0.201 - i * 0.024, 0.098], i === 1 ? EDGE : OBSIDIAN, 0.002);
    }
    glyph(fore, 0, -0.120, 0.124, 0.65);
    fore.finish();

    const glove = panels(ctx, hand, `${side < 0 ? 'left' : 'right'}_gauntlet`, materials);
    glove.plate(hex(0.071, 0.050), 0.015, [0, 0.010, 0.049], OBSIDIAN, 0.002);
    for (let i = 0; i < 3; i++) glove.box([0.073, 0.005, 0.003], [0, -0.032 + i * 0.023, -0.070], EDGE);
    glyph(glove, 0, 0.015, 0.058, 0.38);
    glove.finish();
  }
}

function legs(ctx, av, materials) {
  for (const [side, leg] of [[-1, av.lLeg], [1, av.rLeg]]) {
    const { thigh, knee, boot } = leg.userData.joints;
    const t = panels(ctx, thigh, `${side < 0 ? 'left' : 'right'}_tasset`, materials);
    t.plate(hex(0.071, 0.193), 0.029, [side * 0.078, -0.166, -0.133], OBSIDIAN, 0.003);
    t.line([side * 0.060, -0.100], [side * 0.060, -0.215], -0.150, 0.003, EDGE);
    glyph(t, side * 0.085, -0.118, -0.151, 0.47);
    t.finish();

    const shin = panels(ctx, knee, `${side < 0 ? 'left' : 'right'}_greave`, materials);
    shin.plate(shield(0.174, 0.138), 0.025, [0, -0.023, -0.163], OBSIDIAN, 0.004);
    shin.plate(shield(0.111, 0.083), 0.014, [0, -0.013, -0.184], FACET, 0.002);
    glyph(shin, 0, -0.001, -0.193, 0.65);
    shin.plate(shield(0.126, 0.190), 0.029, [0, -0.185, -0.111], OBSIDIAN, 0.003);
    for (let i = 0; i < 3; i++) {
      shin.plate(hex(0.122 - i * 0.014, 0.036), 0.015, [0, -0.121 - i * 0.045, -0.135], i === 1 ? FACET : OBSIDIAN, 0.002);
    }
    shin.line([side * 0.039, -0.117], [side * 0.031, -0.235], -0.144, 0.0045, VIOLET, true);
    shin.line([-0.051, 0.014], [0.051, 0.014], -0.193, 0.002, EDGE);
    shin.finish();

    const foot = panels(ctx, boot, `${side < 0 ? 'left' : 'right'}_sabatons`, materials);
    foot.plate(hex(0.184, 0.071), 0.013, [0, -0.002, -0.210], OBSIDIAN, 0.002);
    for (let i = 0; i < 3; i++) foot.box([0.182 - i * 0.009, 0.008, 0.024], [0, 0.068, -0.143 + i * 0.038], i === 1 ? EDGE : FACET);
    foot.line([-0.056, 0.019], [0.056, 0.019], -0.219, 0.002, EDGE);
    foot.finish();
  }
}

export function apply(avatar, ctx) {
  // Only cloned armor and visor materials change. Cloth and dark team material
  // retain their identities, so setAvatarTeam keeps working after equipping.
  for (const root of [avatar.head, avatar.torso, avatar.hips, avatar.lArm, avatar.rArm, avatar.lLeg, avatar.rLeg]) {
    ctx.tint(root, {
      [0x26323b]: { color: palette.armor, roughness: 0.42, metalness: 0.46 },
      [0x6aa5af]: { color: 0x6f4d8c, roughness: 0.19, metalness: 0.83 },
    });
  }
  const armor = ctx.material(0xffffff, { vertexColors: true, roughness: 0.44, metalness: 0.40 });
  const channels = ctx.material(0xffffff, {
    vertexColors: true, roughness: 0.35, metalness: 0.30,
    emissive: 0xaa74ff, emissiveIntensity: 1.3,
  });
  channels.userData.cosmeticGlow = true;
  const materials = [armor, channels];
  helmet(ctx, avatar, materials);
  cuirass(ctx, avatar, materials);
  reactor(ctx, avatar, materials);
  arms(ctx, avatar, materials);
  legs(ctx, avatar, materials);
}
