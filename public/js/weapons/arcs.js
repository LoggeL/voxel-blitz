// Chain-arc presentation for charged LONGARC hits: a jagged, re-rolled lightning line
// between two world points that lives for a few frames, plus a bloom sprite at each end.
import * as THREE from '../vendor/three.module.js';

const ARC_POOL_SIZE = 12;
const ARC_SEGMENTS = 14;
const ARC_LIFE_S = 0.2;
const REROLL_S = 0.03;

export class ArcFX {
  constructor(scene) {
    this.scene = scene;
    this.arcs = [];
    this._a = new THREE.Vector3();
    this._b = new THREE.Vector3();
    this._d = new THREE.Vector3();
    this._t = new THREE.Vector3();
    this._n = new THREE.Vector3();
    for (let i = 0; i < ARC_POOL_SIZE; i++) {
      const positions = new Float32Array((ARC_SEGMENTS + 1) * 3);
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      const material = new THREE.LineBasicMaterial({
        color: 0x9ff4ff,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      });
      const line = new THREE.Line(geometry, material);
      line.frustumCulled = false;
      line.renderOrder = 9;
      line.visible = false;
      scene.add(line);
      this.arcs.push({
        line, positions, material,
        active: false, age: 0, rerollAt: 0,
        from: [0, 0, 0], to: [0, 0, 0], seed: 0,
      });
    }
  }

  /** Fire one arc between two `[x,y,z]` points. Reuses the oldest slot when the pool is full. */
  arc(from, to) {
    if (!Array.isArray(from) || !Array.isArray(to)) return false;
    let slot = this.arcs.find((entry) => !entry.active) || null;
    if (!slot) {
      slot = this.arcs[0];
      for (const entry of this.arcs) if (entry.age > slot.age) slot = entry;
    }
    slot.active = true;
    slot.age = 0;
    slot.rerollAt = 0;
    slot.seed = Math.random() * 1000;
    slot.from = [Number(from[0]), Number(from[1]), Number(from[2])];
    slot.to = [Number(to[0]), Number(to[1]), Number(to[2])];
    slot.line.visible = true;
    slot.material.opacity = 1;
    this._reroll(slot);
    return true;
  }

  _reroll(slot) {
    const a = this._a.set(slot.from[0], slot.from[1], slot.from[2]);
    const b = this._b.set(slot.to[0], slot.to[1], slot.to[2]);
    const d = this._d.subVectors(b, a);
    const length = d.length();
    if (length < 1e-6) return;
    d.divideScalar(length);
    const helper = Math.abs(d.y) > 0.9 ? this._t.set(1, 0, 0) : this._t.set(0, 1, 0);
    const n1 = this._n.crossVectors(d, helper).normalize();
    const n2 = helper.crossVectors(d, n1).normalize();
    const amp = Math.min(0.45, 0.06 + length * 0.05);
    const positions = slot.positions;
    for (let i = 0; i <= ARC_SEGMENTS; i++) {
      const t = i / ARC_SEGMENTS;
      const envelope = Math.sin(t * Math.PI);
      const j1 = (Math.random() * 2 - 1) * amp * envelope;
      const j2 = (Math.random() * 2 - 1) * amp * envelope;
      positions[i * 3] = a.x + d.x * length * t + n1.x * j1 + n2.x * j2;
      positions[i * 3 + 1] = a.y + d.y * length * t + n1.y * j1 + n2.y * j2;
      positions[i * 3 + 2] = a.z + d.z * length * t + n1.z * j1 + n2.z * j2;
    }
    slot.line.geometry.attributes.position.needsUpdate = true;
  }

  update(dt) {
    const step = Math.max(0, Math.min(0.05, Number(dt) || 0));
    for (const slot of this.arcs) {
      if (!slot.active) continue;
      slot.age += step;
      if (slot.age >= ARC_LIFE_S) {
        slot.active = false;
        slot.line.visible = false;
        slot.material.opacity = 0;
        continue;
      }
      if (slot.age >= slot.rerollAt) {
        slot.rerollAt = slot.age + REROLL_S;
        this._reroll(slot);
      }
      slot.material.opacity = Math.max(0, 1 - slot.age / ARC_LIFE_S);
    }
  }

  dispose() {
    for (const slot of this.arcs) {
      this.scene.remove(slot.line);
      slot.line.geometry.dispose();
      slot.material.dispose();
    }
    this.arcs.length = 0;
  }
}
