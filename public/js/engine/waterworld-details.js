import * as THREE from '../vendor/three.module.js';

/**
 * Non-blocking set dressing for WATERWORLD: lockers, benches, cafe tables,
 * vending machines, barrels and crates from the original prop placements,
 * doors swung open against their frames, and the traitor-tester beam rig at
 * the top of the flume tower. Every position comes from the compiled map data
 * (shared/world/waterworld-data.js); collision lives in the shared voxels.
 */
const PROP_COLORS = Object.freeze({
  locker: 0x6f7d8c, barrel: 0x2f62b8, table: 0x9c8a6a, vending: 0xc8323c, crate: 0xa07a48,
  bench: 0x7a5a3a, tank: 0x8d9298, bin: 0x4c5258, generator: 0x5d6a4a, desk: 0x8a8378, shelf: 0x6d6a62,
});

export function buildWaterworldDetails(meta) {
  const group = new THREE.Group();
  group.name = 'waterworld-details';
  const props = meta?.props || {};
  const disposables = [];
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  disposables.push(geometry);

  const batches = new Map();
  const box = (color, x, y, z, sx, sy, sz, yaw = 0, emissive = 0) => {
    const key = `${color}:${emissive}`;
    if (!batches.has(key)) batches.set(key, { color, emissive, boxes: [] });
    batches.get(key).boxes.push({ x, y, z, sx, sy, sz, yaw });
  };

  // Oriented prop boxes: [kind, x, y, z, halfX, halfY, halfZ, yaw]; y is the
  // model origin (its base), so the box rises by its half height.
  for (const [kind, x, y, z, hx, hy, hz, yaw] of props.boxes || []) {
    const color = PROP_COLORS[kind] ?? 0x808080;
    box(color, x, y + hy, z, hx * 2, hy * 2, hz * 2, yaw);
    if (kind === 'locker') {
      // Door seams and a darker plinth read as a bank of lockers.
      box(0x3f4750, x, y + 0.08, z, hx * 2 + 0.02, 0.16, hz * 2 + 0.02, yaw);
    } else if (kind === 'table') {
      box(0x5d5246, x, y + hy * 0.5, z, hx * 1.6, hy, hz * 0.5, yaw);
    } else if (kind === 'vending') {
      box(0x9fd3ff, x, y + hy * 1.15, z, hx * 2.02, hy * 0.9, hz * 2.02, yaw, 0x3d7fb8);
    }
  }
  // Doors: a panel on the frame's open side, swung 90 degrees into the room.
  for (const [x, y, z, dx, dz] of props.doors || []) {
    const along = 1.35;
    box(0x8c6a44, x + dx * along / 2, y + 1.65, z + dz * along / 2,
      dx ? along : 0.1, 3.3, dz ? along : 0.1);
    box(0xc9c2b4, x + dx * (along - 0.2), y + 1.55, z + dz * (along - 0.2),
      dx ? 0.12 : 0.16, 0.12, dz ? 0.12 : 0.16);
  }
  // Traitor tester: the beam rig above the tower shows the verdict lamps.
  const beams = meta?.tester?.beams || [];
  if (beams.length === 2) {
    const [[ax, ay, az], [bx, by, bz]] = beams;
    const cx = (ax + bx) / 2, cy = (ay + by) / 2, cz = (az + bz) / 2;
    const length = Math.hypot(bx - ax, bz - az);
    const yaw = Math.atan2(-(bz - az), bx - ax);
    box(0x3a3f46, cx, cy + 0.45, cz, length + 0.4, 0.14, 0.14, yaw);
    box(0x62ff3a, cx, cy, cz, length, 0.08, 0.08, yaw, 0x2ac81a);
    for (const [px, py, pz] of beams) box(0x1f2328, px, py + 0.2, pz, 0.3, 0.6, 0.3, yaw);
  }

  const meshes = [];
  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const position = new THREE.Vector3();
  for (const { color, emissive, boxes } of batches.values()) {
    const material = new THREE.MeshLambertMaterial({ color, emissive, emissiveIntensity: emissive ? 0.8 : 0 });
    const mesh = new THREE.InstancedMesh(geometry, material, boxes.length);
    mesh.name = `waterworld-${color.toString(16)}`;
    boxes.forEach((b, i) => {
      quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), b.yaw);
      scale.set(b.sx, b.sy, b.sz);
      position.set(b.x, b.y, b.z);
      matrix.compose(position, quaternion, scale);
      mesh.setMatrixAt(i, matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    group.add(mesh);
    meshes.push(mesh);
    disposables.push(material);
  }

  return {
    group,
    dispose() {
      for (const mesh of meshes) mesh.dispose();
      for (const item of disposables) item.dispose();
      group.removeFromParent();
      group.clear();
    },
  };
}
