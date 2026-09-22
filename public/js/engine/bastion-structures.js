import * as THREE from '../vendor/three.module.js';
import { BASTION_STRUCTURES } from '../../../shared/bastion-build.js';

// Player-built sentries and ammo crates (`match.bastion.structures` rows). Same
// keyed sync as ttt-traps.js: rows that vanish dispose their meshes. Barricade
// voxels are not here; they render through the chunk path with the BARRICADE tile.
const LAMP = { green: 0x46ddb1, amber: 0xffae45, red: 0xff4d40, off: 0x1a1f26 };
const CRATE_GLOW = { charged: 0x22ddaa, spent: 0x102b29 };

function hpSprite(resources) {
  const canvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
  let ctx = null, texture = null;
  if (canvas) { canvas.width = 128; canvas.height = 16; ctx = canvas.getContext('2d'); texture = new THREE.CanvasTexture(canvas); resources.push(texture); }
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: true });
  resources.push(material);
  const sprite = new THREE.Sprite(material); sprite.scale.set(0.9, 0.11, 1);
  sprite.update = (t01) => {
    if (!ctx) return;
    ctx.clearRect(0, 0, 128, 16); ctx.fillStyle = '#10141a'; ctx.fillRect(0, 0, 128, 16);
    ctx.fillStyle = t01 > 0.5 ? '#7fd069' : t01 > 0.25 ? '#ffb340' : '#ff3355';
    ctx.fillRect(2, 2, Math.max(0, Math.round(124 * Math.max(0, Math.min(1, t01)))), 12);
    texture.needsUpdate = true;
  };
  return sprite;
}

export class BastionStructureView {
  constructor() { this.group = new THREE.Group(); this.group.name = 'bastion-structures'; this.items = new Map(); this.clock = 0; }

  _build(row) {
    const root = new THREE.Group(), resources = [];
    const material = (color, extra = {}) => { const m = new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.4, ...extra }); resources.push(m); return m; };
    const add = (parent, geometry, mat, x, y, z) => { resources.push(geometry); const mesh = new THREE.Mesh(geometry, mat); mesh.position.set(x, y, z); parent.add(mesh); return mesh; };
    const item = { root, resources, kind: row.kind, hp: hpSprite(resources) };
    const dark = material(0x24303b), pale = material(0xb8c4c9);
    if (row.kind === 'turret') {
      add(root, new THREE.BoxGeometry(0.9, 0.25, 0.9), dark, 0, 0.125, 0);
      add(root, new THREE.CylinderGeometry(0.18, 0.18, 0.6, 12), pale, 0, 0.55, 0);
      const head = new THREE.Group(); head.position.y = 1.0; root.add(head);
      add(head, new THREE.BoxGeometry(0.5, 0.35, 0.5), dark, 0, 0, 0);
      const barrel = new THREE.CylinderGeometry(0.06, 0.06, 0.7, 10); barrel.rotateX(Math.PI / 2);
      add(head, barrel, pale, 0.12, 0.02, -0.55);
      item.lamp = material(0x111111, { emissive: LAMP.green, emissiveIntensity: 1.4 });
      add(head, new THREE.BoxGeometry(0.14, 0.1, 0.14), item.lamp, -0.15, 0.22, 0);
      item.head = head; item.hp.position.y = 1.55;
    } else {
      add(root, new THREE.BoxGeometry(1.0, 0.8, 1.0), material(0x7a4a2c, { roughness: 0.8 }), 0, 0.4, 0);
      add(root, new THREE.BoxGeometry(1.04, 0.1, 1.04), material(0xd7b45a), 0, 0.82, 0);
      item.glow = material(0x1f3a35, { emissive: CRATE_GLOW.charged, emissiveIntensity: 1.0 });
      add(root, new THREE.BoxGeometry(0.7, 0.06, 0.7), item.glow, 0, 0.88, 0);
      item.hp.position.y = 1.25;
    }
    root.add(item.hp);
    return item;
  }

  sync(rows = []) {
    const keep = new Set();
    for (const row of rows) {
      if (!row || !BASTION_STRUCTURES[row.kind]) continue;
      const id = String(row.id); keep.add(id);
      let item = this.items.get(id);
      if (!item || item.kind !== row.kind) {
        if (item) this._drop(id, item);
        item = this._build(row); this.items.set(id, item); this.group.add(item.root);
      }
      const def = BASTION_STRUCTURES[row.kind];
      // Rows carry the cell centre (+0.5); a bare cell coordinate is centred here.
      item.root.position.set(Number.isInteger(row.x) ? row.x + 0.5 : row.x, row.y, Number.isInteger(row.z) ? row.z + 0.5 : row.z);
      const frac = (row.hp ?? def.hp) / (row.maxHp || def.hp || 1);
      if (frac !== item.lastFrac) { item.lastFrac = frac; item.hp.update(frac); }
      if (item.head) {
        item.head.rotation.y = Number.isFinite(row.yaw) ? row.yaw : ((row.facing ?? 0) & 3) * Math.PI / 2;
        const ammo = (row.ammo ?? def.ammo) / (def.ammo || 1);
        item.lamp.emissive.setHex(ammo > 0.5 ? LAMP.green : ammo > 0.2 ? LAMP.amber : ammo > 0 ? LAMP.red : LAMP.off);
      } else {
        item.charged = (row.charges ?? def.charges) > 0;
        item.glow.emissive.setHex(item.charged ? CRATE_GLOW.charged : CRATE_GLOW.spent);
      }
    }
    for (const [id, item] of this.items) if (!keep.has(id)) this._drop(id, item);
  }

  _drop(id, item) { item.root.removeFromParent(); item.resources.forEach((r) => r.dispose()); this.items.delete(id); }

  /** Charged crates breathe so a defender spots a refill across the yard. */
  update(dt = 0) {
    this.clock += dt;
    for (const item of this.items.values()) if (item.glow) item.glow.emissiveIntensity = item.charged ? 0.8 + 0.4 * Math.sin(this.clock * 3) : 0.2;
  }

  dispose() { this.sync([]); this.group.removeFromParent(); }
}
