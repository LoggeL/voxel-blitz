// Tracer and remote muzzle-flash pools for the weapon-effects facade.
import * as THREE from '../vendor/three.module.js';
import { WEAPONS } from '../../../shared/combatmath.js';
import { raycastVoxels } from '../../../shared/raycast.js';
import { freeOldestIndex, hideInstance, makeFlashTexture } from './instancing.js';

const TAU = Math.PI * 2;
const TRACER_POOL_SIZE = 96;
const FLASH_POOL_SIZE = 24;
const NEG_Z = new THREE.Vector3(0, 0, -1);
const EMPTY_OPTIONS = Object.freeze({});
const NO_BLOCK = () => 0;

function directionInto(target, value) {
  if (Array.isArray(value)) return target.set(value[0], value[1], value[2]);
  return target.set(value.x, value.y, value.z);
}

export class TracerFX {
  constructor(scene, worldGetBlockFn, onWallImpact) {
    this.scene = scene;
    this.getBlockFn = worldGetBlockFn || NO_BLOCK;
    this.onWallImpact = typeof onWallImpact === 'function' ? onWallImpact : null;

    this._matrix = new THREE.Matrix4();
    this._rotation = new THREE.Quaternion();
    this._position = new THREE.Vector3();
    this._scale = new THREE.Vector3();
    this._direction = new THREE.Vector3();

    const tracerGeometry = new THREE.BoxGeometry(1, 1, 1);
    tracerGeometry.translate(0, 0, -0.5);
    const tracerMaterial = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    this.tracerMesh = new THREE.InstancedMesh(
      tracerGeometry,
      tracerMaterial,
      TRACER_POOL_SIZE,
    );
    this.tracerMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.tracerMesh.frustumCulled = false;
    this.tracers = new Array(TRACER_POOL_SIZE);
    for (let i = 0; i < TRACER_POOL_SIZE; i++) {
      const tracer = {
        active: false,
        t: 0,
        life: 0.06,
        len: 20,
        w: 0.03,
        color: new THREE.Color(0xffffff),
      };
      this.tracers[i] = tracer;
      this.tracerMesh.setColorAt(i, tracer.color);
      hideInstance(this.tracerMesh, i);
    }
    scene.add(this.tracerMesh);

    this.flashTexture = makeFlashTexture();
    this.flashes = new Array(FLASH_POOL_SIZE);
    for (let i = 0; i < FLASH_POOL_SIZE; i++) {
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this.flashTexture,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        transparent: true,
        opacity: 0,
        rotation: Math.random() * TAU,
      }));
      sprite.scale.setScalar(0.55);
      sprite.visible = false;
      scene.add(sprite);
      this.flashes[i] = { spr: sprite, t: 0, life: 0.05 };
    }

    this.stats = { shots: 0 };
    this._tracersDisposed = false;
    this._flashesDisposed = false;
  }

  /**
   * Consume the server shot wire shape without changing its array/object
   * direction conventions. Only the first terrain hit emits wall feedback.
   */
  shoot(event, options = EMPTY_OPTIONS) {
    this.stats.shots++;
    const definition = WEAPONS[event.w];
    const pelletDirections = event.pellets;
    const usePellets = pelletDirections && pelletDirections.length > 1;
    const directionCount = usePellets ? pelletDirections.length : 1;
    const limit = Math.min(directionCount, definition ? definition.pellets : 1);
    const ox = event.o[0];
    const oy = event.o[1];
    const oz = event.o[2];
    const local = !!options.local;

    if (!local) this.spawnFlash(event.o, event.d);

    for (let i = 0; i < limit; i++) {
      const rawDirection = usePellets
        ? pelletDirections[i]
        : (event.spread || event.d);
      const direction = directionInto(this._direction, rawDirection);
      let length = definition ? definition.tracer.len : 22;
      const hit = raycastVoxels(
        this.getBlockFn,
        ox,
        oy,
        oz,
        direction.x,
        direction.y,
        direction.z,
        length,
      );
      if (hit) {
        if (i === 0 && this.onWallImpact) this.onWallImpact(hit, local);
        // Piercing rail slugs pass through: keep the full-length tracer and
        // only clip non-piercing reports at the first terrain hit.
        const piercesWalls = Boolean(definition && definition.pierce && definition.pierce.walls > 0);
        if (!piercesWalls) length = Math.max(0.1, Math.min(length, hit.t) - 0.35);
      }
      this.spawnTracer(event.o, direction, length, definition);
    }
  }

  spawnTracer(origin, direction, length, definition) {
    let index = -1;
    for (let i = 0; i < this.tracers.length; i++) {
      if (!this.tracers[i].active) {
        index = i;
        break;
      }
    }
    if (index < 0) index = freeOldestIndex(this.tracers);

    const tracer = this.tracers[index];
    tracer.active = true;
    tracer.t = 0;
    tracer.life = 0.055 + length * 0.0006;
    tracer.len = length;
    tracer.w = definition ? 0.028 * definition.tracer.width : 0.03;
    tracer.color.set(definition ? definition.tracer.color : '#ffd27a');

    this._position.set(direction.x, direction.y, direction.z).normalize();
    this._rotation.setFromUnitVectors(NEG_Z, this._position);
    const px = origin[0] + direction.x * 0.35;
    const py = origin[1] + direction.y * 0.35;
    const pz = origin[2] + direction.z * 0.35;
    this._scale.set(tracer.w, tracer.w, length);
    this._matrix.compose(
      this._position.set(px, py, pz),
      this._rotation,
      this._scale,
    );
    this.tracerMesh.setMatrixAt(index, this._matrix);
    this.tracerMesh.setColorAt(index, tracer.color);
    tracer.px = px;
    tracer.py = py;
    tracer.pz = pz;
    tracer.qx = this._rotation.x;
    tracer.qy = this._rotation.y;
    tracer.qz = this._rotation.z;
    tracer.qw = this._rotation.w;
    this.tracerMesh.instanceMatrix.needsUpdate = true;
    if (this.tracerMesh.instanceColor) {
      this.tracerMesh.instanceColor.needsUpdate = true;
    }
  }

  spawnFlash(origin, rawDirection) {
    let flash = null;
    for (let i = 0; i < this.flashes.length; i++) {
      if (!this.flashes[i].spr.visible) {
        flash = this.flashes[i];
        break;
      }
    }
    if (!flash) {
      flash = this.flashes[0];
      for (let i = 1; i < this.flashes.length; i++) {
        if (this.flashes[i].t >= flash.t) flash = this.flashes[i];
      }
    }

    const direction = directionInto(this._direction, rawDirection);
    flash.t = 0;
    flash.life = 0.045;
    flash.spr.visible = true;
    flash.spr.position.set(
      origin[0] + direction.x * 0.35,
      origin[1] + direction.y * 0.35,
      origin[2] + direction.z * 0.35,
    );
    flash.spr.material.rotation = Math.random() * TAU;
    flash.spr.scale.setScalar(0.45 + Math.random() * 0.3);
    flash.spr.material.opacity = 1;
  }

  updateTracers(dt) {
    for (let i = 0; i < this.tracers.length; i++) {
      const tracer = this.tracers[i];
      if (!tracer.active) continue;
      tracer.t += dt;
      if (tracer.t >= tracer.life) {
        tracer.active = false;
        hideInstance(this.tracerMesh, i);
        continue;
      }
      const remaining = 1 - tracer.t / tracer.life;
      this._scale.set(tracer.w, tracer.w, tracer.len * remaining);
      this._rotation.set(tracer.qx, tracer.qy, tracer.qz, tracer.qw);
      this._matrix.compose(
        this._position.set(tracer.px, tracer.py, tracer.pz),
        this._rotation,
        this._scale,
      );
      this.tracerMesh.setMatrixAt(i, this._matrix);
    }
    this.tracerMesh.instanceMatrix.needsUpdate = true;
  }

  updateFlashes(dt) {
    for (let i = 0; i < this.flashes.length; i++) {
      const flash = this.flashes[i];
      if (!flash.spr.visible) continue;
      flash.t += dt;
      if (flash.t >= flash.life) {
        flash.spr.visible = false;
        continue;
      }
      flash.spr.material.opacity = 1 - flash.t / flash.life;
    }
  }

  update(dt) {
    this.updateTracers(dt);
    this.updateFlashes(dt);
  }

  reset() {
    for (let i = 0; i < this.tracers.length; i++) {
      this.tracers[i].active = false;
      this.tracers[i].t = 0;
      hideInstance(this.tracerMesh, i);
    }
    this.tracerMesh.instanceMatrix.needsUpdate = true;
    for (let i = 0; i < this.flashes.length; i++) {
      const flash = this.flashes[i];
      flash.t = 0;
      flash.spr.visible = false;
      flash.spr.material.opacity = 0;
    }
    this.stats.shots = 0;
  }

  /** Dispose the instanced tracer resource before the other instanced FX pools. */
  disposeTracers() {
    if (this._tracersDisposed) return;
    this._tracersDisposed = true;
    this.scene.remove(this.tracerMesh);
    this.tracerMesh.geometry.dispose();
    this.tracerMesh.material.dispose();
  }

  /** Dispose sprites after every instanced FX pool, preserving facade order. */
  disposeFlashes() {
    if (this._flashesDisposed) return;
    this._flashesDisposed = true;
    for (let i = 0; i < this.flashes.length; i++) {
      const sprite = this.flashes[i].spr;
      this.scene.remove(sprite);
      sprite.material.dispose();
    }
    this.flashTexture.dispose();
  }

  dispose() {
    this.disposeTracers();
    this.disposeFlashes();
  }
}
