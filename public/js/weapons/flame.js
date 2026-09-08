import * as THREE from '../vendor/three.module.js';
import { createFireAtlas, FIRE_SPRITE_GLSL } from './fire-sprite.js';
import { raycastVoxels } from '../../../shared/raycast.js';
import { FLAME_RULES } from '../../../shared/flame-rules.js';

const CAPACITY = 512;
const PARTICLES_PER_SHOT = 6;
const LOCAL_OPTIONS = Object.freeze({ local: true });

/** Bounded billboard batch. Accepted shots sustain a continuous, cancellable local emitter. */
export class FlameFX {
  constructor(scene, getBlock) {
    this.getBlock = getBlock;
    this.muzzleProvider = null;
    this.origin = new THREE.Vector3();
    this._forward = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._direction = new THREE.Vector3();
    this._target = new THREE.Vector3();
    this._muzzleRay = new THREE.Vector3();
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
      transparent: true, depthWrite: false, toneMapped: false,
      uniforms: { time: { value: 0 }, fireAtlas: { value: createFireAtlas() } },
      vertexShader: `
        attribute vec3 center;
        attribute vec3 shape;
        attribute vec4 tint;
        varying vec2 flameUv;
        varying vec4 flameTint;
        varying float flamePhase;
        void main() {
          flameUv = uv;
          flameTint = tint;
          flamePhase = shape.z * 3.0;
          float c = cos(shape.z), s = sin(shape.z);
          vec2 local = position.xy * shape.xy;
          local = mat2(c, -s, s, c) * local;
          vec4 view = modelViewMatrix * vec4(center, 1.0);
          view.xy += local;
          gl_Position = projectionMatrix * view;
        }
      `,
      fragmentShader: `
        ${FIRE_SPRITE_GLSL}
        uniform float time;
        varying vec2 flameUv;
        varying vec4 flameTint;
        varying float flamePhase;
        void main() {
          vec4 sprite = fireSprite(flameUv, time * 20.0 + flamePhase);
          gl_FragColor = vec4(sprite.rgb, sprite.a * flameTint.a);
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
    const forward = this._forward.fromArray(event.d);
    if (forward.lengthSq() < 0.0001) return;
    forward.normalize();
    if (options.local && this.muzzleProvider) {
      const eyeHit = raycastVoxels(this.getBlock, this.origin.x, this.origin.y, this.origin.z,
        forward.x, forward.y, forward.z, FLAME_RULES.range);
      const target = this._target.copy(this.origin)
        .addScaledVector(forward, eyeHit ? Math.max(0, eyeHit.t - 0.05) : FLAME_RULES.range);
      this.muzzleProvider(this.origin);
      const muzzleRay = this._muzzleRay.set(
        this.origin.x - event.o[0], this.origin.y - event.o[1], this.origin.z - event.o[2],
      );
      const muzzleDistance = muzzleRay.length();
      if (muzzleDistance > 0) {
        muzzleRay.divideScalar(muzzleDistance);
        if (raycastVoxels(this.getBlock, event.o[0], event.o[1], event.o[2],
          muzzleRay.x, muzzleRay.y, muzzleRay.z, muzzleDistance)) return;
      }
      forward.copy(target).sub(this.origin).normalize();
    }
    const right = this._right.set(0, 1, 0).cross(forward);
    if (right.lengthSq() < 0.001) right.set(1, 0, 0);
    right.normalize();
    const up = this._up.copy(forward).cross(right).normalize();
    for (let i = 0, total = count + (count === 1 ? Number(Math.random() < 0.33) : 2); i < total; i++) {
      const puff = this.puffs[this.cursor++ % CAPACITY];
      const ember = i >= count;
      const angle = Math.random() * Math.PI * 2;
      const spread = Math.sqrt(Math.random()) * Math.tan(FLAME_RULES.coneDeg * Math.PI / 360) * (ember ? 1 : 0.65);
      const direction = this._direction.copy(forward).addScaledVector(right, Math.cos(angle) * spread)
        .addScaledVector(up, Math.sin(angle) * spread).normalize();
      const hit = raycastVoxels(this.getBlock, this.origin.x, this.origin.y, this.origin.z,
        direction.x, direction.y, direction.z, FLAME_RULES.range);
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
    this.material.uniforms.time.value = (this.material.uniforms.time.value + delta) % 1000;
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
        this.emit(this.localEvent, LOCAL_OPTIONS, 1, false, age);
      }
    } else this.localElapsed = 0;
    let count = 0;
    for (const puff of this.puffs) {
      if (puff.age >= puff.life) continue;
      const distance = puff.age * FLAME_RULES.speed;
      const size = puff.ember ? 0.035 + distance * 0.004 : 0.30 + distance * 0.075;
      const fade = Math.min(1, (puff.life - puff.age) / 0.10);
      this.centers.setXYZ(count, puff.position.x, puff.position.y, puff.position.z);
      this.shapes.setXYZ(count, size, size * (puff.ember ? 2.5 : 1.3), puff.rotation + puff.age * 1.5);
      // Blue pressure core opens into orange tongues without whitening the whole aim lane.
      const core = puff.ember ? 0 : Math.max(0, 1 - distance / 1.1);
      this.colors.setXYZW(count, 1 - core * 0.72,
        Math.max(0.14, 0.58 - distance * 0.025) + core * 0.08,
        0.015 + core * 0.985, fade * (puff.ember ? 1 : 0.66));
      count++;
    }
    this.geometry.instanceCount = count;
    if (count) this.centers.needsUpdate = this.shapes.needsUpdate = this.colors.needsUpdate = true;
  }

  dispose() {
    this.mesh.removeFromParent();
    this.geometry.dispose();
    this.material.uniforms.fireAtlas.value.dispose();
    this.material.dispose();
  }
}
