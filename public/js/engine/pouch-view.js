// World view of the Conquest ammo pouches of the fallen (docs/conquest.md
// "Infantry supply" -> "Ammo pouches"): a small low-poly olive bag with a
// strap and a brass buckle that glints faintly (team-neutral: either team may
// take it), drawn where match.conquest.pch says. The list rides only ticks
// where it changed plus keyframes, so an absent field keeps what is shown.
// Three instanced meshes draw every pouch (AMMO_POUCH_RULES.maxActive).
import * as THREE from '../vendor/three.module.js';
import { AMMO_POUCH_RULES, decodeAmmoPouches } from '../../../shared/ammo-pouches.js';

const GLINT_HZ = 0.55;
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(1, 1, 1);
const _up = new THREE.Vector3(0, 1, 0);

/** Body, flap/strap and buckle parts of one pouch (feet at the origin), shared by every instance. */
function pouchParts() {
  const body = new THREE.BoxGeometry(0.34, 0.16, 0.22); body.translate(0, 0.08, 0);
  const flap = new THREE.BoxGeometry(0.36, 0.05, 0.16); flap.translate(0, 0.175, -0.035);
  const strap = new THREE.BoxGeometry(0.05, 0.17, 0.24); strap.translate(0.12, 0.088, 0);
  const trim = mergeBoxes([flap, strap]);
  const buckle = new THREE.BoxGeometry(0.07, 0.05, 0.02); buckle.translate(0, 0.14, 0.115);
  return { body, trim, buckle };
}

/** Two non-indexed boxes as one geometry (no BufferGeometryUtils import needed). */
function mergeBoxes(list) {
  const parts = list.map(g => g.toNonIndexed());
  const merged = new THREE.BufferGeometry();
  for (const name of ['position', 'normal']) {
    const arrays = parts.map(g => g.getAttribute(name).array);
    const out = new Float32Array(arrays.reduce((n, a) => n + a.length, 0));
    let at = 0;
    for (const a of arrays) { out.set(a, at); at += a.length; }
    merged.setAttribute(name, new THREE.BufferAttribute(out, 3));
  }
  for (const g of [...list, ...parts]) g.dispose();
  return merged;
}

export class PouchView {
  constructor(scene, capacity = AMMO_POUCH_RULES.maxActive) {
    this.group = new THREE.Group();
    this.group.name = 'ammo-pouches';
    this.capacity = capacity;
    this.rows = [];
    this.time = 0;
    this.disposed = false;
    const parts = pouchParts();
    this.materials = [
      new THREE.MeshStandardMaterial({ color: 0x707a44, roughness: 0.9, metalness: 0 }),
      new THREE.MeshStandardMaterial({ color: 0x4d5530, roughness: 0.95, metalness: 0 }),
      new THREE.MeshStandardMaterial({ color: 0xc9a75a, roughness: 0.35, metalness: 0.7, emissive: 0xffe2a0, emissiveIntensity: 0.3 }),
    ];
    this.meshes = [parts.body, parts.trim, parts.buckle].map((geometry, i) => {
      const mesh = new THREE.InstancedMesh(geometry, this.materials[i], capacity);
      mesh.name = `ammo-pouch-${['body', 'trim', 'buckle'][i]}`;
      mesh.count = 0;
      mesh.frustumCulled = false;
      this.group.add(mesh);
      return mesh;
    });
    this.buckle = this.materials[2];
    scene?.add(this.group);
  }

  /** Raw `match.conquest.pch` rows or decoded `{id,x,y,z}` rows; null/undefined keeps the shown set. */
  sync(raw) {
    if (this.disposed) return;
    const rows = Array.isArray(raw) && raw.every(r => r && !Array.isArray(r)) ? raw : decodeAmmoPouches(raw);
    if (!rows) return;
    this.rows = rows.slice(0, this.capacity);
    this.rows.forEach((row, i) => {
      // A per-pouch yaw from its id: the bags do not all face one way.
      _q.setFromAxisAngle(_up, ((row.id * 2.399) % (Math.PI * 2)));
      _m.compose(_p.set(row.x, row.y, row.z), _q, _s);
      for (const mesh of this.meshes) mesh.setMatrixAt(i, _m);
    });
    for (const mesh of this.meshes) { mesh.count = this.rows.length; mesh.instanceMatrix.needsUpdate = true; }
  }

  /** The faint buckle glint. */
  update(dt = 0) {
    if (this.disposed || !this.rows.length) return;
    this.time += Math.max(0, Number(dt) || 0);
    const wave = Math.sin(this.time * GLINT_HZ * Math.PI * 2);
    this.buckle.emissiveIntensity = 0.25 + Math.max(0, wave) ** 6 * 1.4;
  }

  get count() { return this.rows.length; }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const mesh of this.meshes) { mesh.geometry.dispose(); mesh.dispose?.(); }
    for (const material of this.materials) material.dispose();
    this.rows = [];
    this.group.removeFromParent();
    this.group.clear();
  }
}
