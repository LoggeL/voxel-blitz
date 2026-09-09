import * as THREE from '../vendor/three.module.js';
import { POWERUP_TYPES, MAX_WORLD_PICKUPS } from '../../../shared/powerups.js';

function box(parent, material, x, y, z, sx, sy, sz) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), material);
  mesh.position.set(x, y, z);
  parent.add(mesh);
  return mesh;
}

function labelTexture(text, color) {
  const canvas = document.createElement('canvas');
  canvas.width = 384; canvas.height = 80;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#0b1420e8';
  ctx.fillRect(0, 0, 384, 80);
  ctx.fillStyle = color;
  ctx.fillRect(0, 76, 384, 4);
  ctx.font = 'bold 30px sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, 192, 40);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Bounded, small, depth-tested world pickups; snapshots own their lifetime. */
export class PowerupView {
  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'map-powerups';
    this.items = new Map();
    this.time = 0;
  }

  sync(rows = []) {
    const retained = new Set();
    for (const row of Array.isArray(rows) ? rows.slice(0, MAX_WORLD_PICKUPS) : []) {
      if (!row || !Object.hasOwn(POWERUP_TYPES, row.type) ||
          ![row.x, row.y, row.z].every(Number.isFinite) || typeof row.id !== 'string') continue;
      retained.add(row.id);
      let item = this.items.get(row.id);
      if (item && item.type !== row.type) { this.remove(row.id); item = null; }
      if (!item) {
        item = this.create(row.type);
        this.items.set(row.id, item);
        this.group.add(item.root);
      }
      item.root.position.set(row.x, row.y, row.z);
    }
    for (const id of this.items.keys()) if (!retained.has(id)) this.remove(id);
  }

  create(type) {
    const definition = POWERUP_TYPES[type];
    const root = new THREE.Group();
    root.name = `powerup-${type}`;
    const color = new THREE.Color(definition.color);
    const shell = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.32, roughness: 0.4, metalness: 0.25 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x18232e, roughness: 0.7 });
    const bright = new THREE.MeshBasicMaterial({ color: 0xf1f8ff });
    const glow = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.65, depthWrite: false, side: THREE.DoubleSide });
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.63, 0.72, 0.12, 8), dark);
    base.position.y = 0.065; root.add(base);
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.68, 0.76, 32), glow);
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.025; root.add(ring);
    const body = new THREE.Group(); root.add(body);
    if (type === 'cash') {
      for (let i = 0; i < 3; i++) {
        box(body, shell, (i % 2) * 0.07, i * 0.14, 0, 0.72, 0.11, 0.36);
        box(body, bright, (i % 2) * 0.07, i * 0.14, 0, 0.14, 0.12, 0.38);
      }
      base.visible = ring.visible = false;
      shell.emissiveIntensity = 0.12;
    } else if (type === 'armor') {
      box(body, shell, 0, 0, 0, 0.68, 0.62, 0.30);
      box(body, shell, 0, -0.36, 0, 0.38, 0.14, 0.30);
      box(body, dark, 0, 0.27, 0, 0.25, 0.16, 0.32);
      box(body, bright, 0, 0, 0.16, 0.09, 0.35, 0.02);
      box(body, bright, 0, 0, -0.16, 0.09, 0.35, 0.02);
    } else if (type === 'health') {
      box(body, shell, 0, 0, 0, 0.72, 0.53, 0.4);
      box(body, dark, 0, 0.31, 0, 0.30, 0.10, 0.17);
      for (const z of [-0.21, 0.21]) {
        box(body, bright, 0, 0, z, 0.12, 0.34, 0.025);
        box(body, bright, 0, 0, z, 0.34, 0.12, 0.025);
      }
    } else {
      box(body, dark, 0, -0.12, 0, 0.76, 0.36, 0.42);
      for (const x of [-0.23, 0, 0.23]) {
        box(body, shell, x, 0.14, 0, 0.15, 0.52, 0.22);
        box(body, bright, x, 0.43, 0, 0.10, 0.08, 0.17);
      }
    }
    const beamMaterial = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.13, depthWrite: false });
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 2.5, 6), beamMaterial);
    beam.position.y = 1.35; root.add(beam);
    const texture = labelTexture(definition.label.toUpperCase(), `#${color.getHexString()}`);
    const labelMaterial = new THREE.SpriteMaterial({ map: texture, depthTest: true, depthWrite: false });
    const label = new THREE.Sprite(labelMaterial);
    label.position.y = 2.05; label.scale.set(1.9, 0.40, 1); root.add(label);
    if (type === 'cash') { beam.visible = false; label.position.y = 0.8; label.scale.set(1.1, 0.23, 1); }
    return { root, body, ring, glow, type, texture, materials: [shell, dark, bright, glow, beamMaterial, labelMaterial] };
  }

  update(dt) {
    this.time += Math.max(0, Math.min(dt || 0, 0.1));
    for (const item of this.items.values()) {
      item.body.position.y = (item.type === 'cash' ? 0.24 : 0.96) + Math.sin(this.time * 2.4) * 0.1;
      item.body.rotation.y = this.time * 0.7;
      item.glow.opacity = 0.48 + Math.sin(this.time * 3) * 0.15;
    }
  }

  remove(id) {
    const item = this.items.get(id);
    if (!item) return;
    item.root.removeFromParent();
    item.root.traverse(object => { if (object.isMesh) object.geometry.dispose(); });
    item.materials.forEach(material => material.dispose());
    item.texture.dispose();
    this.items.delete(id);
  }

  dispose() {
    for (const id of this.items.keys()) this.remove(id);
    this.group.removeFromParent();
  }
}
