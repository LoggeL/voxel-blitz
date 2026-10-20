// World view of the Conquest supply crates (docs/conquest.md "Infantry supply"):
// the Support's AMMO CRATE (olive box, yellow stencil band and chevron) and the
// Medic's MEDICAL CRATE (white box, red crosses), drawn where the authority says
// they stand (match.conquest.crates, decoded by shared/supply-crates.js).
// Everyone sees every crate (it is a physical object to shoot); only the own
// team's get a map and screen marker (conquest-hud-state.js).
import * as THREE from '../vendor/three.module.js';
import { decodeSupplyCrates } from '../../../shared/supply-crates.js';

let shared = null;
/** Geometries and materials shared by every crate (never disposed per instance). */
function parts() {
  if (shared) return shared;
  const mat = (color, roughness = 0.75, metalness = 0.1) => new THREE.MeshStandardMaterial({ color, roughness, metalness });
  shared = {
    olive: mat(0x56602f), oliveDark: mat(0x3d4522), yellow: mat(0xf0c419, 0.6),
    white: mat(0xe8e6dc, 0.7), grey: mat(0x8d949a, 0.45, 0.5), red: mat(0xd42020, 0.6), steel: mat(0x2f353a, 0.5, 0.6),
    body: new THREE.BoxGeometry(0.8, 0.42, 0.56),
    lid: new THREE.BoxGeometry(0.84, 0.08, 0.6),
    corner: new THREE.BoxGeometry(0.1, 0.44, 0.1),
    band: new THREE.BoxGeometry(0.82, 0.07, 0.58),
    chevron: new THREE.BoxGeometry(0.12, 0.04, 0.01),
    crossBar: new THREE.BoxGeometry(0.22, 0.07, 0.01),
    crossTop: new THREE.BoxGeometry(0.26, 0.01, 0.08),
    handle: new THREE.BoxGeometry(0.06, 0.05, 0.2),
  };
  return shared;
}

/** A crate model, feet at the group origin, its long side along local x. `kind` 'ammocrate' | 'medcrate'. */
export function buildSupplyCrateModel(kind) {
  const p = parts(), med = kind === 'medcrate';
  const group = new THREE.Group();
  group.name = `supply-${kind}`;
  const add = (geometry, material, x, y, z, rz = 0) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z); mesh.rotation.z = rz;
    group.add(mesh);
    return mesh;
  };
  add(p.body, med ? p.white : p.olive, 0, 0.21, 0);
  add(p.lid, med ? p.grey : p.oliveDark, 0, 0.46, 0);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) add(p.corner, med ? p.grey : p.steel, sx * 0.37, 0.22, sz * 0.25);
  for (const sx of [-1, 1]) add(p.handle, p.steel, sx * 0.43, 0.3, 0);
  if (med) {
    // A red cross on both long faces and on the lid.
    for (const sz of [-1, 1]) {
      add(p.crossBar, p.red, 0, 0.22, sz * 0.285);
      add(p.crossBar, p.red, 0, 0.22, sz * 0.285, Math.PI / 2);
    }
    add(p.crossTop, p.red, 0, 0.505, 0);
    add(p.crossTop, p.red, 0, 0.505, 0).rotation.y = Math.PI / 2;
  } else {
    // The yellow stencil band and a chevron on both long faces.
    add(p.band, p.yellow, 0, 0.12, 0);
    for (const sz of [-1, 1]) {
      add(p.chevron, p.yellow, -0.04, 0.27, sz * 0.285, Math.PI / 4);
      add(p.chevron, p.yellow, 0.04, 0.27, sz * 0.285, -Math.PI / 4);
    }
  }
  group.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return group;
}

export class SupplyCrateView {
  constructor(scene) {
    this.group = new THREE.Group();
    this.group.name = 'supply-crates';
    this.views = new Map();
    this.disposed = false;
    scene?.add(this.group);
  }

  /** Raw `match.conquest.crates` rows or their decoded form; a missing list clears every crate. */
  sync(raw) {
    if (this.disposed) return;
    const crates = Array.isArray(raw) && raw.length && !Array.isArray(raw[0]) ? raw : decodeSupplyCrates(raw);
    const seen = new Set();
    for (const c of crates) {
      if (![c.x, c.y, c.z].every(Number.isFinite)) continue;
      seen.add(c.id);
      let view = this.views.get(c.id);
      if (!view || view.kind !== c.kind) {
        if (view) this.group.remove(view.group);
        view = { kind: c.kind, group: buildSupplyCrateModel(c.kind) };
        this.views.set(c.id, view);
        this.group.add(view.group);
      }
      view.group.position.set(c.x, c.y, c.z);
      // Yaw 0 faces -Z (the placer's view): the long side lies across it.
      view.group.rotation.y = Number(c.yaw) || 0;
    }
    for (const [id, view] of this.views) {
      if (seen.has(id)) continue;
      this.group.remove(view.group);
      this.views.delete(id);
    }
  }

  get count() { return this.views.size; }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.views.clear();
    this.group.removeFromParent();
    this.group.clear();
  }
}
