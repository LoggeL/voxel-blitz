import * as THREE from '../../vendor/three.module.js';
import { COL } from '../../guns/kit.js';

const TAU = Math.PI * 2;
const COLORS = { blue: 0x152334, brass: 0xbe914b, gold: 0xe6bc72, ivory: 0xe9dac0, walnut: 0x3b231a };

/** One draw per material/animated parent, including all the tiny hand-cut ornament. */
function lineBatch(parent, material, segments) {
  if (!segments.length) return;
  const mesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1, 1, 5), material, segments.length);
  const matrix = new THREE.Matrix4();
  const rotation = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const middle = new THREE.Vector3();
  const direction = new THREE.Vector3();
  const scale = new THREE.Vector3();
  segments.forEach(([a, b, radius], i) => {
    direction.subVectors(b, a);
    const length = direction.length();
    rotation.setFromUnitVectors(up, direction.normalize());
    middle.copy(a).add(b).multiplyScalar(0.5);
    scale.set(radius, length, radius);
    matrix.compose(middle, rotation, scale);
    mesh.setMatrixAt(i, matrix);
  });
  mesh.name = 'high_noon_inlaid_engraving';
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingBox();
  mesh.computeBoundingSphere();
  parent.add(mesh);
}

function segment(list, a, b, radius = 0.00055) {
  list.push([new THREE.Vector3(...a), new THREE.Vector3(...b), radius]);
}

function path(list, points, radius = 0.00055, closed = false) {
  for (let i = 1; i < points.length; i++) segment(list, points[i - 1], points[i], radius);
  if (closed) segment(list, points[points.length - 1], points[0], radius);
}

/** All side ornament is expressed in (z,y), on the true side of the gun rather than a decal plane. */
function sideRing(lines, x, y, z, radius, thickness, divisions = 16) {
  const points = Array.from({ length: divisions }, (_, i) => {
    const angle = i * TAU / divisions;
    return [x, y + Math.sin(angle) * radius, z + Math.cos(angle) * radius];
  });
  path(lines, points, thickness, true);
}

function scroll(lines, x, y, z, size, direction = 1, turn = 0) {
  // A tapering spiral ending in a tight curled tip, with three paired acanthus leaves.
  const points = [];
  for (let i = 0; i <= 16; i++) {
    const t = i / 16;
    const angle = turn + direction * t * TAU * 1.15;
    const radius = size * (1 - t * 0.88);
    points.push([x, y + Math.sin(angle) * radius, z + Math.cos(angle) * radius]);
  }
  path(lines, points, 0.00046);
  for (const i of [2, 5, 8]) {
    const p = points[i];
    const before = points[i - 1];
    const after = points[i + 1];
    const dy = after[1] - before[1];
    const dz = after[2] - before[2];
    const length = Math.hypot(dy, dz);
    const reach = size * (0.38 - i * 0.015);
    const tip = [x, p[1] + dz / length * reach, p[2] - dy / length * reach];
    const heel = [x, p[1] - dy * 0.45, p[2] - dz * 0.45];
    path(lines, [heel, tip, p], 0.00040);
  }
}

function gripPanel(parent, ctx, side, ivory) {
  // Keep the original walnut visible around a genuine bevelled ivory insert.
  // Coordinates follow the original swept grip profile, leaving the backstrap and heel exposed.
  const points = [[-0.027, -0.035], [0.009, -0.035], [0.047, -0.137],
    [0.039, -0.146], [0.009, -0.139], [-0.018, -0.064]];
  const shape = new THREE.Shape();
  points.forEach(([z, y], i) => i ? shape.lineTo(-z, y) : shape.moveTo(-z, y));
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: 0.002, steps: 1, bevelEnabled: true, bevelThickness: 0.0007,
    bevelSize: 0.0012, bevelSegments: 1, curveSegments: 1,
  });
  geometry.rotateY(Math.PI / 2);
  geometry.translate(side * 0.040 - 0.001, 0, 0);
  const panel = new THREE.Mesh(geometry, ivory);
  panel.name = side < 0 ? 'high_noon_ivory_left' : 'high_noon_ivory_right';
  parent.add(panel);
  return points;
}

export function apply(model, ctx) {
  const bodyPalette = {
    [COL.gunmetal]: { color: COLORS.brass, roughness: 0.36, metalness: 0.77 },
    [COL.blued]: { color: COLORS.blue, roughness: 0.30, metalness: 0.84 },
    [COL.walnut]: { color: COLORS.walnut, roughness: 0.58, metalness: 0.02 },
    [0x704421]: { color: 0x593524, roughness: 0.66, metalness: 0.02 },
    [COL.amber]: { color: COLORS.gold, roughness: 0.32, metalness: 0.76 },
  };
  // Hands share some base colors with the receiver. Do not include them or muzzle FX in a tint traversal.
  for (const child of model.body.children) {
    if (child.name === 'hand_r' || child.name === 'hand_l' || child === model.flash?.grp) continue;
    ctx.tint(child, bodyPalette);
  }
  ctx.tint(model.mag, {
    [COL.gunmetal]: { color: COLORS.blue, roughness: 0.30, metalness: 0.82 },
    [COL.blued]: { color: COLORS.brass, roughness: 0.34, metalness: 0.78 },
    [COL.fluteDark]: { color: 0x0e1822, roughness: 0.43, metalness: 0.68 },
  });
  ctx.tint(model.bolt, bodyPalette);
  ctx.tint(model.triggerGroup, { [COL.amber]: { color: COLORS.gold, roughness: 0.30, metalness: 0.8 } });

  const detail = ctx.group(model.body, 'high_noon_body');
  const gold = ctx.material(COLORS.gold, { roughness: 0.30, metalness: 0.83 });
  const brass = ctx.material(COLORS.brass, { roughness: 0.38, metalness: 0.76 });
  const ivory = ctx.material(COLORS.ivory, { roughness: 0.58, metalness: 0.03 });
  const blue = ctx.material(COLORS.blue, { roughness: 0.37, metalness: 0.70 });
  const dark = ctx.material(0x4a321f, { roughness: 0.64, metalness: 0.27 });
  const goldLines = [], darkLines = [];

  for (const side of [-1, 1]) {
    const points = gripPanel(detail, ctx, side, ivory);
    const x = side * 0.0422;
    path(goldLines, points.map(([z, y]) => [x, y, z]), 0.00065, true);
    // The upper and lower scrolls read as carved scrimshaw at close inspection.
    scroll(darkLines, x, -0.054, -0.006, 0.010, side, 1.0);
    scroll(darkLines, x, -0.116, 0.026, 0.010, -side, 2.5);
    const medallion = ctx.cylinder(detail, 0.013, 0.0015, [side * 0.0425, -0.086, 0.010], blue,
      { segments: 12, rotation: [0, Math.PI / 2, 0] });
    medallion.name = 'high_noon_sun_medallion';
    sideRing(goldLines, side * 0.0435, -0.086, 0.010, 0.0130, 0.00065, 20);
    sideRing(goldLines, side * 0.0436, -0.086, 0.010, 0.0040, 0.00068, 12);
    for (let i = 0; i < 12; i++) {
      const angle = i * TAU / 12;
      const r2 = i % 3 === 0 ? 0.0109 : 0.0090;
      segment(goldLines,
        [side * 0.0436, -0.086 + Math.sin(angle) * 0.0060, 0.010 + Math.cos(angle) * 0.0060],
        [side * 0.0436, -0.086 + Math.sin(angle) * r2, 0.010 + Math.cos(angle) * r2], 0.00060);
    }
    // Brass frame carries a dark engraved sun, border and matching scrolls.
    const frameX = side * 0.0266;
    path(darkLines, [[frameX, 0.058, 0.028], [frameX, 0.058, -0.064],
      [frameX, -0.022, -0.067], [frameX, -0.036, -0.045]], 0.00065);
    sideRing(darkLines, frameX, 0.023, -0.025, 0.010, 0.00058);
    sideRing(darkLines, frameX, 0.023, -0.025, 0.005, 0.00052, 12);
    for (let i = 0; i < 16; i++) {
      const angle = i * TAU / 16;
      const r = i % 2 ? 0.013 : 0.016;
      segment(darkLines,
        [frameX, 0.023 + Math.sin(angle) * 0.0115, -0.025 + Math.cos(angle) * 0.0115],
        [frameX, 0.023 + Math.sin(angle) * r, -0.025 + Math.cos(angle) * r], 0.0005);
    }
    scroll(darkLines, frameX, -0.010, -0.038, 0.010, side, 0.3);
    scroll(darkLines, frameX, 0.044, 0.012, 0.010, -side, 1.2);

    // Barrel side inlay stays below the top rib and far behind the muzzle mouth.
    for (const y of [0.033, 0.047]) {
      segment(goldLines, [side * 0.0262, y, -0.249], [side * 0.0262, y, -0.447], 0.00075);
    }
    for (let i = 0; i < 5; i++) {
      const z = -0.278 - i * 0.034;
      path(goldLines, [[side * 0.0277, 0.040, z - 0.0055], [side * 0.0277, 0.0428, z],
        [side * 0.0277, 0.040, z + 0.0055], [side * 0.0277, 0.0372, z]], 0.00048, true);
    }
  }
  for (const z of [-0.238, -0.459]) {
    ctx.cylinder(detail, 0.0280, 0.005, [0, 0.040, z], brass, { segments: 12 });
  }
  // Open annulus: the muzzle and front blade retain their original functional geometry.
  const muzzleRing = new THREE.Mesh(new THREE.TorusGeometry(0.0284, 0.0008, 4, 12), gold);
  muzzleRing.position.set(0, 0.040, -0.505);
  detail.add(muzzleRing);
  lineBatch(detail, gold, goldLines);
  lineBatch(detail, dark, darkLines);

  const cylinder = model.extra?.userData.revolver?.cylinder || model.mag.getObjectByName('cylinder');
  if (cylinder) {
    // This is the drum's own moving coordinate system, not the crane or the static frame.
    const drum = ctx.group(cylinder, 'high_noon_cylinder_inlay');
    const drumLines = [];
    const point = (angle, z, radius = 0.0594) => [Math.cos(angle) * radius, Math.sin(angle) * radius, z];
    for (const z of [-0.038, 0.036]) {
      path(drumLines, Array.from({ length: 36 }, (_, i) => point(i * TAU / 36, z)), 0.00070, true);
    }
    for (let i = 0; i < 6; i++) {
      const angle = Math.PI / 2 + i * TAU / 6;
      for (const offset of [-0.19, 0.19]) {
        segment(drumLines, point(angle + offset, -0.029), point(angle + offset, 0.026), 0.00065);
      }
      // Six elongated, two-tone lozenges and tiny alternating rays identify each chamber.
      path(drumLines, [point(angle, -0.018, 0.060), point(angle - 0.10, -0.003, 0.060),
        point(angle, 0.012, 0.060), point(angle + 0.10, -0.003, 0.060)], 0.0007, true);
      segment(drumLines, point(angle, -0.009, 0.060), point(angle, 0.004, 0.060), 0.00065);
      for (const z of [-0.028, 0.022]) {
        segment(drumLines, point(angle - 0.07, z), point(angle + 0.07, z), 0.00055);
      }
    }
    lineBatch(drum, gold, drumLines);
  }
}
