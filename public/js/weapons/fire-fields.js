import * as THREE from '../vendor/three.module.js';
import { MOLOTOV_FIRE } from '../../../shared/molotov-rules.js';

const MAX_FIELDS = MOLOTOV_FIRE.maxFields;
const MAX_CELLS = MOLOTOV_FIRE.maxCells;
const CAPACITY = MAX_FIELDS * MAX_CELLS * 2;

/** Snapshot-owned ground fire. One bounded billboard draw, with real terrain depth testing. */
export class FireFieldFX {
  constructor(scene) {
    this.fields = new Map();
    this.now = 0;
    this.animationTime = 0;
    this.geometry = new THREE.InstancedBufferGeometry();
    const plane = new THREE.PlaneGeometry(1, 1);
    this.geometry.index = plane.index.clone();
    this.geometry.setAttribute('position', plane.attributes.position.clone());
    this.geometry.setAttribute('uv', plane.attributes.uv.clone());
    plane.dispose();
    this.centers = new THREE.InstancedBufferAttribute(new Float32Array(CAPACITY * 3), 3);
    this.shapes = new THREE.InstancedBufferAttribute(new Float32Array(CAPACITY * 4), 4);
    for (const attribute of [this.centers, this.shapes]) attribute.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('center', this.centers);
    this.geometry.setAttribute('shape', this.shapes);
    this.geometry.instanceCount = 0;
    this.material = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, toneMapped: false,
      uniforms: { time: { value: 0 } },
      vertexShader: `
        attribute vec3 center;
        attribute vec4 shape;
        varying vec2 fireUv;
        varying vec2 fireLife;
        void main() {
          fireUv = uv;
          fireLife = shape.zw;
          vec4 view = modelViewMatrix * vec4(center, 1.0);
          view.xy += position.xy * shape.xy;
          gl_Position = projectionMatrix * view;
        }
      `,
      fragmentShader: `
        uniform float time;
        varying vec2 fireUv;
        varying vec2 fireLife;
        void main() {
          float y = fireUv.y;
          float sway = sin(y * 9.0 - time * 8.0 + fireLife.x) * y * 0.10;
          float x = abs(fireUv.x - 0.5 + sway);
          float width = 0.46 * pow(1.0 - y, 0.7);
          float edge = 1.0 - smoothstep(width * 0.45, width, x);
          float alpha = edge * smoothstep(0.0, 0.10, y) * (1.0 - y * y) * fireLife.y;
          if (alpha < 0.01) discard;
          float core = (1.0 - y) * (1.0 - smoothstep(0.0, width, x));
          vec3 tint = mix(vec3(0.95, 0.12, 0.015), vec3(1.0, 0.82, 0.22), core);
          gl_FragColor = vec4(tint, alpha * 0.92);
        }
      `,
    });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = 'molotov-ground-fire';
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }

  sync(rows, serverNow) {
    if (Number.isFinite(serverNow)) this.now = serverNow;
    this.fields.clear();
    for (const row of Array.isArray(rows) ? rows.slice(0, MAX_FIELDS) : []) {
      if (!row?.id || ![row.x, row.y, row.z, row.expiresAt].every(Number.isFinite) || row.expiresAt <= this.now) continue;
      const cells = (Array.isArray(row.cells) ? row.cells : [[row.x, row.y, row.z]])
        .filter(cell => Array.isArray(cell) && cell.length === 3 && cell.every(Number.isFinite))
        .slice(0, MAX_CELLS);
      this.fields.set(row.id, { ...row, cells });
    }
    this.update(0);
  }

  update(dt) {
    this.now += Math.max(0, Number(dt) || 0) * 1000;
    this.animationTime = (this.animationTime + Math.max(0, Number(dt) || 0)) % 1000;
    this.material.uniforms.time.value = this.animationTime;
    let count = 0;
    for (const [id, field] of this.fields) {
      const remaining = (field.expiresAt - this.now) / 1000;
      if (remaining <= 0) { this.fields.delete(id); continue; }
      const fade = Math.min(1, remaining / 0.6);
      for (let i = 0; i < field.cells.length; i++) {
        const [x, y, z] = field.cells[i];
        for (let layer = 0; layer < 2; layer++) {
          const seed = x * 17.7 + z * 23.1 + layer * 4.2;
          const flicker = Math.sin(this.now / 140 + seed);
          const height = (layer ? 0.68 : 1.1) + flicker * 0.16;
          this.centers.setXYZ(count, x + Math.sin(seed) * 0.18, y + height * 0.46, z + Math.cos(seed) * 0.18);
          this.shapes.setXYZW(count, layer ? 0.58 : 0.9, height, seed, fade);
          count++;
        }
      }
    }
    this.geometry.instanceCount = count;
    this.centers.needsUpdate = true;
    this.shapes.needsUpdate = true;
  }

  dispose() {
    this.fields.clear();
    this.mesh.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }
}
