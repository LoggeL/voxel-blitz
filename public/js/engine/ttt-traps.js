import * as THREE from '../vendor/three.module.js';
const TINT = { ready: 0xff3b29, cooldown: 0xd9a441, used: 0x5a6670 };
const normal = (face) => [face === 'x+' ? 1 : face === 'x-' ? -1 : 0, face === 'z+' ? 1 : face === 'z-' ? -1 : 0];
/** Trap buttons only traitors receive: a small emissive plate on the wall, tinted by state. */
export class TttTrapView {
  constructor() { this.group = new THREE.Group(); this.group.name = 'ttt-traps'; this.items = new Map(); }
  sync(rows = []) {
    const keep = new Set();
    for (const row of rows) {
      const id = String(row.id); keep.add(id);
      const [nx, nz] = normal(row.face);
      let item = this.items.get(id);
      if (!item) {
        const root = new THREE.Group(), resources = [];
        const box = (w, h, d, material, x, y, z) => {
          const geo = new THREE.BoxGeometry(w, h, d), mesh = new THREE.Mesh(geo, material);
          mesh.position.set(x, y, z); root.add(mesh); resources.push(geo); return mesh;
        };
        const plate = new THREE.MeshStandardMaterial({ color: 0x2a3138, roughness: 0.55, metalness: 0.4 });
        const lamp = new THREE.MeshStandardMaterial({ color: 0x331111, emissive: TINT.ready, emissiveIntensity: 1.6, roughness: 0.3 });
        resources.push(plate, lamp);
        const alongX = nx !== 0;
        box(alongX ? 0.06 : 0.44, 0.44, alongX ? 0.44 : 0.06, plate, 0, 0, 0);
        box(alongX ? 0.05 : 0.2, 0.2, alongX ? 0.2 : 0.05, lamp, -nx * 0.05, 0, -nz * 0.05);
        item = { root, resources, lamp }; this.items.set(id, item); this.group.add(root);
      }
      item.root.position.set(row.x + 0.5 + nx * 0.47, row.y + 1.15, row.z + 0.5 + nz * 0.47);
      item.state = row.state;
      item.lamp.emissive.setHex(TINT[row.state] || TINT.used);
      item.lamp.emissiveIntensity = row.state === 'ready' ? 1.6 : row.state === 'cooldown' ? 0.8 : 0.25;
    }
    for (const [id, item] of this.items) if (!keep.has(id)) {
      item.root.removeFromParent(); item.resources.forEach((r) => r.dispose()); this.items.delete(id);
    }
  }
  /** Ready buttons pulse so a traitor spots them across the room. */
  update(elapsed = 0) {
    for (const item of this.items.values()) {
      if (item.state === 'ready') item.lamp.emissiveIntensity = 1.3 + 0.6 * Math.sin(elapsed * 4);
    }
  }
  dispose() { this.sync([]); this.group.removeFromParent(); }
}
