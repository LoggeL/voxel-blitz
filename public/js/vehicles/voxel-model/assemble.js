// Assembly kit shared by the voxel vehicle models: meshes each rigid part
// once per (type, team, variant), caches the geometry for every hull of that
// team, and builds the node hierarchy (pivots, anchors, instanced wheel sets).
// Variants: 'intact', 'wreck' (break-away tags removed) and 'frag:<tag>'
// (one tag only, recentred about its own centre for tumbling).
import * as THREE from '../../vendor/three.module.js';
import { meshVoxelPart } from './mesher.js';
import { createPaletteResolver } from './material.js';

const geometryCache = new Map();
const resolvers = new Map();
const SEEDS = Object.freeze({ jeep: 3, tank: 7, helicopter: 11, transport: 13, plane: 17 });

function resolverFor(type, team) {
  const key = `${type}|${team}`;
  let resolve = resolvers.get(key);
  if (!resolve) { resolve = createPaletteResolver(team, SEEDS[type] ?? 5); resolvers.set(key, resolve); }
  return resolve;
}

/**
 * Cached geometry pair { opaque, glass, triangles, center } for one part.
 * Geometries are shared: callers must never dispose them (userData.cached).
 */
export function partGeometry(type, team, part, variant = 'intact') {
  const key = `${type}|${team}|${part.name}|${variant}`;
  let entry = geometryCache.get(key);
  if (entry) return entry;
  const resolve = resolverFor(type, team);
  let include = null, pivot = part.pivot;
  let center = null;
  if (variant === 'wreck') include = tag => !tag;
  else if (variant.startsWith('frag:')) {
    const tag = variant.slice(5);
    include = value => value === tag;
    // Recentre the chunk on its own voxels so it tumbles about its middle.
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const [x, y, z, , voxelTag] of part.voxels()) {
      if (voxelTag !== tag) continue;
      const p = [x, y, z];
      for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i], p[i]); max[i] = Math.max(max[i], p[i] + 1); }
    }
    if (Number.isFinite(min[0])) {
      center = [0, 1, 2].map(i => (min[i] + max[i]) * 0.1 + part.grid[i]);
      pivot = center;
    }
  }
  const meshed = meshVoxelPart(part, resolve, { include, pivot });
  // Fine parts (wheels) are authored at 1/scale size and shrunk about their pivot.
  const scale = part.userData?.scale;
  for (const geometry of [meshed.opaque, meshed.glass]) {
    if (!geometry) continue;
    if (scale && scale !== 1) { geometry.scale(scale, scale, scale); geometry.computeBoundingBox(); geometry.computeBoundingSphere(); }
    geometry.userData.cached = true;
  }
  entry = Object.freeze({ ...meshed, center });
  geometryCache.set(key, entry);
  return entry;
}

/** Drop every cached geometry (tests and page teardown only). */
export function clearVehicleGeometryCache() {
  for (const entry of geometryCache.values()) { entry.opaque?.dispose(); entry.glass?.dispose(); }
  geometryCache.clear();
}

/**
 * One model under construction. Nodes remember their hull-frame pivot so an
 * anchor authored in hull metres lands correctly under any parent.
 */
export class ModelKit {
  constructor(type, team, { material, glass = null, blur = null } = {}) {
    this.type = type;
    this.team = team || 'neutral';
    this.material = material;
    this.glass = glass;
    this.blur = blur;
    this.group = new THREE.Group();
    this.group.name = `vehicle-${type}`;
    this.group.userData.pivot = [0, 0, 0];
    this.parts = [];       // { node, part, mesh, glassMesh, fragmentTags }
    this.instanced = [];   // InstancedMesh entries
    this.extraMeshes = []; // non-voxel meshes (rotor blur)
  }

  /** A pivot node at a hull-frame point, parented under `parent`. */
  node(parent, name, pivot = [0, 0, 0]) {
    const node = new THREE.Group();
    node.name = name;
    const base = parent.userData.pivot || [0, 0, 0];
    node.position.set(pivot[0] - base[0], pivot[1] - base[1], pivot[2] - base[2]);
    node.userData.pivot = [...pivot];
    parent.add(node);
    return node;
  }

  /** An empty anchor at a hull-frame point under `parent`. */
  anchor(parent, name, point) {
    const anchor = new THREE.Object3D();
    anchor.name = name;
    const base = parent.userData.pivot || [0, 0, 0];
    anchor.position.set(point[0] - base[0], point[1] - base[1], point[2] - base[2]);
    anchor.userData.pivot = [...point];
    parent.add(anchor);
    return anchor;
  }

  /** Mesh a part (authored in hull metres) under `node`, whose pivot it uses. */
  part(node, part) {
    const pivot = node.userData.pivot || [0, 0, 0];
    if (part.pivot.some((value, i) => Math.abs(value - pivot[i]) > 1e-9)) {
      throw new Error(`part ${part.name} pivot does not match node ${node.name}`);
    }
    const geometry = partGeometry(this.type, this.team, part);
    const entry = { node, part, mesh: null, glassMesh: null, fragmentTags: part.tags() };
    if (geometry.opaque) {
      entry.mesh = new THREE.Mesh(geometry.opaque, this.material);
      entry.mesh.name = `${part.name}-voxels`;
      entry.mesh.castShadow = true; entry.mesh.receiveShadow = true;
      node.add(entry.mesh);
    }
    if (geometry.glass && this.glass) {
      entry.glassMesh = new THREE.Mesh(geometry.glass, this.glass);
      entry.glassMesh.name = `${part.name}-glass`;
      entry.glassMesh.renderOrder = 2;
      node.add(entry.glassMesh);
    }
    this.parts.push(entry);
    return entry;
  }

  /**
   * One InstancedMesh for every copy of a rigid voxel part (wheels, cleats,
   * missiles). `transforms` are { position, quaternion?, scale? } in the
   * parent's frame; the model updates the matrices when it animates them.
   */
  instances(parent, part, transforms, name = `${part.name}-instances`) {
    const geometry = partGeometry(this.type, this.team, part);
    const mesh = new THREE.InstancedMesh(geometry.opaque, this.material, transforms.length);
    mesh.name = name;
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const matrix = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(1, 1, 1), p = new THREE.Vector3();
    transforms.forEach((transform, i) => {
      p.fromArray(transform.position);
      matrix.compose(p, transform.quaternion || q.identity(), transform.scale ? s.fromArray(transform.scale) : s.set(1, 1, 1));
      mesh.setMatrixAt(i, matrix);
    });
    mesh.computeBoundingSphere();
    parent.add(mesh);
    const entry = { mesh, part, transforms, triangles: (geometry.opaque?.userData.triangles || 0) * transforms.length };
    this.instanced.push(entry);
    return mesh;
  }

  /** Flat translucent rotor disc (radius metres) under `parent` at local y. */
  blurDisc(parent, radius, name, axis = 'y') {
    const geometry = new THREE.CircleGeometry(radius, 24);
    if (axis === 'y') geometry.rotateX(-Math.PI / 2);
    else geometry.rotateY(Math.PI / 2);
    const mesh = new THREE.Mesh(geometry, this.blur);
    mesh.name = name;
    mesh.renderOrder = 3;
    mesh.visible = false;
    mesh.userData.ownedGeometry = true;
    parent.add(mesh);
    this.extraMeshes.push(mesh);
    return mesh;
  }

  /** Draw calls and triangles of the intact model (instances counted fully). */
  stats() {
    let draws = 0, triangles = 0;
    for (const entry of this.parts) {
      if (entry.mesh) { draws++; triangles += entry.mesh.geometry.userData.triangles || 0; }
      if (entry.glassMesh) { draws++; triangles += entry.glassMesh.geometry.userData.triangles || 0; }
    }
    for (const entry of this.instanced) { draws++; triangles += entry.triangles; }
    for (const mesh of this.extraMeshes) { draws++; triangles += mesh.geometry.index ? mesh.geometry.index.count / 3 : 0; }
    return { draws, triangles };
  }

  /**
   * Swap every part between its intact and wreck geometry. Parts whose voxels
   * all break away (a tossed turret) hide; respawn restores the cached intact
   * geometry without allocating.
   */
  setWreck(wreck) {
    for (const entry of this.parts) {
      if (!entry.mesh || !entry.fragmentTags.length) continue;
      const geometry = partGeometry(this.type, this.team, entry.part, wreck ? 'wreck' : 'intact');
      if (geometry.opaque) { entry.mesh.geometry = geometry.opaque; entry.mesh.visible = true; }
      else entry.mesh.visible = !wreck;
      if (entry.glassMesh) entry.glassMesh.visible = !wreck;
    }
    for (const entry of this.instanced) if (entry.part.userData?.breaks) entry.mesh.visible = !wreck;
  }

  /** Break-away sources: one per (part, tag) with its node for the world pose. */
  fragmentSources() {
    const sources = [];
    for (const entry of this.parts) for (const tag of entry.fragmentTags) {
      sources.push({ tag, node: entry.node, part: entry.part, priority: entry.part.userData?.priority?.[tag] ?? 50 });
    }
    return sources;
  }

  /** Fragment geometry for one source, recentred (cached per team). */
  fragmentGeometry(source) {
    return partGeometry(this.type, this.team, source.part, `frag:${source.tag}`);
  }
}
