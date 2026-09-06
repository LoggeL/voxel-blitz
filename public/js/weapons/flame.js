import * as THREE from '../vendor/three.module.js';
import { raycastVoxels } from '../../../shared/raycast.js';
import { FLAME_RULES } from '../../../shared/flame-rules.js';

const CAPACITY = 512;
const PARTICLES_PER_SHOT = 6;

/** Bounded billboard batch. Accepted shots sustain a continuous, cancellable local emitter. */
export class FlameFX {
  constructor(scene, getBlock) {
    this.getBlock = getBlock;
    this.muzzleProvider = null;
    this.origin = new THREE.Vector3();
    this.cursor = 0;
    this.localEvent = null;
    this.localActive = false;
    this.localKeepalive = 0;
    this.localElapsed = 0;
    this.puffs = Array.from({ length: CAPACITY }, () => ({
      age: 0, life: 0, ember: false, rotation: 0,
      position: new THREE.Vector3(), velocity: new THREE.Vector3(),
    }));
    this.geometry = new THREE.InstancedBufferGeometry();
    const plane = new THREE.PlaneGeometry(1, 1);
    this.geometry.index = plane.index.clone();
    this.geometry.setAttribute('position', plane.attributes.position.clone());
    this.geometry.setAttribute('uv', plane.attributes.uv.clone());
    plane.dispose();
    this.centers = new THREE.InstancedBufferAttribute(new Float32Array(CAPACITY * 3), 3);
    this.shapes = new THREE.InstancedBufferAttribute(new Float32Array(CAPACITY * 3), 3);
    this.colors = new THREE.InstancedBufferAttribute(new Float32Array(CAPACITY * 4), 4);
    for (const attribute of [this.centers, this.shapes, this.colors]) attribute.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('center', this.centers);
    this.geometry.setAttribute('shape', this.shapes);
    this.geometry.setAttribute('tint', this.colors);
    this.geometry.instanceCount = 0;
    this.material = new THREE.ShaderMaterial({
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
      vertexShader: `
        attribute vec3 center;
        attribute vec3 shape;
        attribute vec4 tint;
        varying vec2 flameUv;
        varying vec4 flameTint;
        void main() {
          flameUv = uv;
          flameTint = tint;
          float c = cos(shape.z), s = sin(shape.z);
          vec2 local = position.xy * shape.xy;
          local = mat2(c, -s, s, c) * local;
          vec4 view = modelViewMatrix * vec4(center, 1.0);
          view.xy += local;
          gl_Position = projectionMatrix * view;
        }
      `,
      fragmentShader: `
        varying vec2 flameUv;
        varying vec4 flameTint;
        void main() {
          vec2 p = flameUv * 2.0 - 1.0;
          float width = 0.72 - p.y * 0.2;
          float radius = length(vec2(p.x / width, p.y));
          float edge = max(0.0, 1.0 - radius);
          float ripple = 0.88 + 0.12 * sin(p.y * 17.0 + p.x * 11.0);
          float alpha = edge * edge * ripple * flameTint.a;
          vec3 hot = mix(flameTint.rgb, vec3(1.0, 0.93, 0.55), pow(edge, 4.0) * 0.8);
          gl_FragColor = vec4(hot, alpha);
        }
      `,
    });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }

  setLocalStream(active, direction, origin) {
    this.localActive = !!active;
    if (!active) { this.localElapsed = 0; return; }
    if (this.localEvent && Array.isArray(direction)) this.localEvent.d = direction.slice();
    if (this.localEvent && Array.isArray(origin)) this.localEvent.o = origin.slice();
  }

  shoot(event, options = {}) {
    if (options.local) {
      if (!this.emit(event, options, 1, false)) return;
      this.localEvent = { ...event, o: event.o.slice(), d: event.d.slice() };
      this.localKeepalive = FLAME_RULES.cadence * 1.5;
      return;
    }
    this.emit(event, options, PARTICLES_PER_SHOT, true);
  }

  emit(event, options, count, stagger, initialAge = 0) {
    if (!Array.isArray(event.o) || !Array.isArray(event.d) ||
        event.o.length !== 3 || event.d.length !== 3 ||
        !event.o.every(Number.isFinite) || !event.d.every(Number.isFinite)) return;
    this.origin.fromArray(event.o);
    const forward = new THREE.Vector3().fromArray(event.d);
    if (forward.lengthSq() < 0.0001) return;
    forward.normalize();
    if (options.local && this.muzzleProvider) {
      const eye = this.origin.clone();
      const eyeHit = raycastVoxels(this.getBlock, ...event.o, ...forward.toArray(), FLAME_RULES.range);
      const target = eye.clone().addScaledVector(forward, eyeHit ? Math.max(0, eyeHit.t - 0.05) : FLAME_RULES.range);
      this.muzzleProvider(this.origin);
      const muzzleRay = this.origin.clone().sub(eye);
      const muzzleDistance = muzzleRay.length();
      if (muzzleDistance > 0) {
        muzzleRay.divideScalar(muzzleDistance);
        if (raycastVoxels(this.getBlock, ...event.o, ...muzzleRay.toArray(), muzzleDistance)) return;
      }
      forward.copy(target).sub(this.origin).normalize();
    }
    const right = new THREE.Vector3(0, 1, 0).cross(forward);
    if (right.lengthSq() < 0.001) right.set(1, 0, 0);
    right.normalize();
    const up = forward.clone().cross(right).normalize();
    for (let i = 0, total = count + (count === 1 ? Number(Math.random() < 0.33) : 2); i < total; i++) {
      const puff = this.puffs[this.cursor++ % CAPACITY];
      const ember = i >= count;
      const angle = Math.random() * Math.PI * 2;
      const spread = Math.sqrt(Math.random()) * Math.tan(FLAME_RULES.coneDeg * Math.PI / 360) * (ember ? 1 : 0.65);
      const direction = forward.clone().addScaledVector(right, Math.cos(angle) * spread)
        .addScaledVector(up, Math.sin(angle) * spread).normalize();
      const hit = raycastVoxels(this.getBlock, ...this.origin.toArray(), ...direction.toArray(), FLAME_RULES.range);
      const reach = hit ? Math.max(0, hit.t - 0.15) : FLAME_RULES.range;
      puff.age = stagger ? (i % PARTICLES_PER_SHOT) * FLAME_RULES.cadence / PARTICLES_PER_SHOT : initialAge;
      puff.life = reach / FLAME_RULES.speed;
      puff.ember = ember;
      puff.rotation = Math.random() * Math.PI * 2;
      puff.velocity.copy(direction).multiplyScalar(FLAME_RULES.speed);
      puff.position.copy(this.origin).addScaledVector(puff.velocity, puff.age);
    }
    return true;
  }

  update(dt) {
    const delta = Math.max(0, dt);
    // Advance previously emitted particles once. New subframe samples below already
    // include their own travel time and must not receive the full frame delta.
    for (const puff of this.puffs) {
      if (puff.age >= puff.life) continue;
      puff.age += delta;
      puff.position.addScaledVector(puff.velocity, delta);
    }
    this.localKeepalive -= delta;
    if (this.localActive && this.localEvent && this.localKeepalive > 0 && delta <= 0.1) {
      this.localElapsed += delta;
      const interval = FLAME_RULES.cadence / PARTICLES_PER_SHOT;
      const elapsedIntervals = Math.floor((this.localElapsed + 1e-9) / interval);
      const emissions = Math.min(PARTICLES_PER_SHOT, elapsedIntervals);
      this.localElapsed = Math.max(0, this.localElapsed - elapsedIntervals * interval);
      for (let i = 0; i < emissions; i++) {
        const age = this.localElapsed + i * interval;
        this.emit(this.localEvent, { local: true }, 1, false, age);
      }
    } else this.localElapsed = 0;
    let count = 0;
    for (const puff of this.puffs) {
      if (puff.age >= puff.life) continue;
      const distance = puff.age * FLAME_RULES.speed;
      const size = puff.ember ? 0.035 + distance * 0.004 : 0.32 + distance * 0.11;
      const fade = Math.min(1, (puff.life - puff.age) / 0.10);
      this.centers.setXYZ(count, puff.position.x, puff.position.y, puff.position.z);
      this.shapes.setXYZ(count, size, size * (puff.ember ? 2.5 : 1.3), puff.rotation + puff.age * 1.5);
      this.colors.setXYZW(count, 1, Math.max(0.14, 0.67 - distance * 0.027), 0.015, fade * (puff.ember ? 1 : 0.94));
      count++;
    }
    this.geometry.instanceCount = count;
    this.centers.needsUpdate = this.shapes.needsUpdate = this.colors.needsUpdate = true;
  }

  dispose() {
    this.mesh.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }
}
