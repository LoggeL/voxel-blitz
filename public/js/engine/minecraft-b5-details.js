import * as THREE from '../vendor/three.module.js';

/**
 * Non-blocking set dressing for MINECRAFT B5: torches, flowers, minecart rails
 * and carts, swung-open doors, wall signs and the sea beyond the voxel edge.
 * Every position comes from the compiled map data (shared/world/minecraft-b5-data.js);
 * gameplay collision lives entirely in the shared voxel bytes.
 */
export function buildMinecraftB5Details(meta) {
  const group = new THREE.Group();
  group.name = 'minecraft-b5-details';
  const props = meta?.props || {};
  const disposables = [];
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  disposables.push(geometry);

  const batches = new Map();
  const box = (color, x, y, z, sx, sy, sz, emissive = 0) => {
    const key = `${color}:${emissive}`;
    if (!batches.has(key)) batches.set(key, { color, emissive, boxes: [] });
    batches.get(key).boxes.push({ x, y, z, sx, sy, sz });
  };

  // Torches: a short stick with a glowing head, standing on the floor cell or
  // pressed against the wall the brush touched.
  for (const [x, y, z] of props.torches || []) {
    box(0x6e4a26, x, y + 0.3, z, 0.12, 0.6, 0.12);
    box(0xffc23a, x, y + 0.66, z, 0.17, 0.17, 0.17, 0xffa020);
  }
  // Roses: a stem and a coloured head; kind 1 is the yellow flower.
  for (const [x, y, z, kind] of props.roses || []) {
    box(0x3f7a2a, x + 0.5, y + 0.25, z + 0.5, 0.07, 0.5, 0.07);
    box(kind === 1 ? 0xf2d032 : 0xd9322a, x + 0.5, y + 0.55, z + 0.5, 0.24, 0.2, 0.24);
  }
  // Rails: two rails on three ties; bends draw both orientations as a cross.
  for (const [x, y, z, orientation] of props.rails || []) {
    const along = orientation === 1 ? ['z'] : orientation === 0 ? ['x'] : ['x', 'z'];
    for (const axis of along) {
      for (const offset of [-0.32, 0.32]) {
        if (axis === 'x') box(0x9a9a9a, x + 0.5, y + 0.045, z + 0.5 + offset, 1, 0.05, 0.08);
        else box(0x9a9a9a, x + 0.5 + offset, y + 0.045, z + 0.5, 0.08, 0.05, 1);
      }
      for (const tie of [-0.33, 0, 0.33]) {
        if (axis === 'x') box(0x6b4b2a, x + 0.5 + tie, y + 0.02, z + 0.5, 0.16, 0.035, 0.9);
        else box(0x6b4b2a, x + 0.5, y + 0.02, z + 0.5 + tie, 0.9, 0.035, 0.16);
      }
    }
  }
  // Minecarts parked on their rails.
  for (const [x, y, z] of props.carts || []) {
    box(0x4c4c50, x, y + 0.26, z, 0.96, 0.46, 0.7);
    box(0x8a8a90, x, y + 0.5, z, 0.7, 0.06, 0.46);
    for (const [dx, dz] of [[-0.3, -0.36], [0.3, -0.36], [-0.3, 0.36], [0.3, 0.36]]) {
      box(0x2a2a2c, x + dx, y + 0.1, z + dz, 0.2, 0.2, 0.06);
    }
  }
  // Doors swung open against the wall (kind 1 is iron).
  for (const [x0, y0, z0, x1, y1, z1, kind] of props.doors || []) {
    const color = kind === 1 ? 0xb9b9bd : 0x9a6b3a;
    box(color, (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, Math.max(0.08, x1 - x0), y1 - y0, Math.max(0.08, z1 - z0));
    if (kind !== 1) box(0x3a2a18, (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, Math.max(0.1, x1 - x0) * 0.6, 0.12, Math.max(0.1, z1 - z0) * 0.6);
  }

  const meshes = [];
  const matrix = new THREE.Matrix4();
  for (const { color, emissive, boxes } of batches.values()) {
    const material = new THREE.MeshLambertMaterial({ color, emissive, emissiveIntensity: emissive ? 0.9 : 0 });
    const mesh = new THREE.InstancedMesh(geometry, material, boxes.length);
    mesh.name = `minecraft-b5-${color.toString(16)}`;
    boxes.forEach((b, i) => {
      matrix.makeScale(b.sx, b.sy, b.sz);
      matrix.setPosition(b.x, b.y, b.z);
      mesh.setMatrixAt(i, matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    group.add(mesh);
    meshes.push(mesh);
    disposables.push(material);
  }

  // Wall signs: a small plank with the original label text.
  const signMaterials = [];
  for (const [x, y, z, face, text] of props.signs || []) {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#9a6b3a';
    ctx.fillRect(0, 0, 256, 128);
    ctx.fillStyle = '#6b4622';
    ctx.fillRect(0, 0, 256, 6);
    ctx.fillRect(0, 122, 256, 6);
    ctx.fillStyle = '#1d1208';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `bold ${text.length > 8 ? 28 : 40}px monospace`;
    ctx.fillText(text, 128, 64, 240);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const material = new THREE.MeshLambertMaterial({ map: texture });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.45), material);
    const outward = face === 'x+' || face === 'z+' ? 1 : -1;
    if (face === 'x+' || face === 'x-') {
      mesh.position.set(x + outward * 0.07, y, z);
      mesh.rotation.y = outward > 0 ? Math.PI / 2 : -Math.PI / 2;
    } else {
      mesh.position.set(x, y, z + outward * 0.07);
      mesh.rotation.y = outward > 0 ? 0 : Math.PI;
    }
    mesh.name = `sign-${text}`;
    group.add(mesh);
    signMaterials.push({ mesh, material, texture });
  }

  // The ocean continues to the horizon past the voxel edge, over a dark sea bed.
  const sea = Number.isFinite(meta?.seaLevel) ? meta.seaLevel : 37;
  const { sx = 128, sz = 96 } = meta?.dimensions || {};
  const reach = 420;
  const seaMaterial = new THREE.MeshLambertMaterial({ color: 0x2f5cc0, transparent: true, opacity: 0.72, depthWrite: false });
  const bedMaterial = new THREE.MeshLambertMaterial({ color: 0x2c2a2e });
  disposables.push(seaMaterial, bedMaterial);
  const ring = [
    [-reach, sx + reach, -reach, 0],
    [-reach, sx + reach, sz, sz + reach],
    [-reach, 0, 0, sz],
    [sx, sx + reach, 0, sz],
  ];
  for (const [x0, x1, z0, z1] of ring) {
    for (const [material, y] of [[seaMaterial, sea - 0.02], [bedMaterial, sea - 4]]) {
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, z1 - z0), material);
      plane.rotation.x = -Math.PI / 2;
      plane.position.set((x0 + x1) / 2, y, (z0 + z1) / 2);
      plane.name = material === seaMaterial ? 'sea' : 'sea-bed';
      group.add(plane);
      disposables.push(plane.geometry);
    }
  }

  return {
    group,
    dispose() {
      for (const mesh of meshes) mesh.dispose();
      for (const { mesh, material, texture } of signMaterials) {
        mesh.geometry.dispose();
        material.dispose();
        texture.dispose();
      }
      for (const item of disposables) item.dispose();
      group.removeFromParent();
      group.clear();
    },
  };
}
