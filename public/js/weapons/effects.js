// Public effects facade. Each bounded pool has exactly one owner and the
// facade preserves the historic API consumed by the game composition root.
import { TracerFX } from './ballistics.js';
import { BrassPool } from './brass.js';
import { GoreFX } from './gore.js';
import { ImpactFX, blockSoundFor } from './impacts.js';
import { hideInstance } from './instancing.js';

export { blockSoundFor };

export class Effects {
  constructor(scene, camera, worldGetBlockFn) {
    this.scene = scene;
    this.camera = camera;
    this.getBlockFn = worldGetBlockFn || (() => 0);
    this._disposed = false;
    this._trauma = 0;

    this.impacts = new ImpactFX(scene, camera, this.getBlockFn);
    this.tracers = new TracerFX(
      scene,
      this.getBlockFn,
      (hit, local) => this.impacts.wallDust(hit, local),
    );
    this.goreFx = new GoreFX(scene, camera, this.getBlockFn);
    this.brass = new BrassPool(scene, this.getBlockFn);

    this.stats = {};
    Object.defineProperties(this.stats, {
      shots: { enumerable: true, get: () => this.tracers?.stats?.shots || 0 },
      particlesSpawned: {
        enumerable: true,
        get: () => this.impacts?.particlesSpawned || 0,
      },
    });
  }

  setShellSpawner(_spawn) {
    // Legacy no-op: attachShellBridge injects directly into spawnBrass().
  }

  hideInstance(mesh, index) {
    hideInstance(mesh, index);
  }

  shoot(event, options = {}) {
    if (!this._disposed) this.tracers.shoot(event, options);
  }

  spawnTracer(origin, direction, length, definition) {
    if (!this._disposed) this.tracers.spawnTracer(origin, direction, length, definition);
  }

  spawnFlash(origin, direction) {
    if (!this._disposed) this.tracers.spawnFlash(origin, direction);
  }

  impact(event) {
    if (!this._disposed) this.impacts.impact(event);
  }

  updateImpactCue(index, cue, progress) {
    if (!this._disposed) this.impacts._updateImpactCue(index, cue, progress);
  }

  gore(event, options = {}) {
    if (!this._disposed) this.goreFx.gore(event, options);
  }

  claimGoreSlot(pool) {
    return this.goreFx._claimSlot(pool);
  }

  spawnBloodStain(x, y, z, nx, ny, nz, size) {
    if (!this._disposed) this.goreFx.spawnBloodStain(x, y, z, nx, ny, nz, size);
  }

  wallDust(hit, local) {
    if (!this._disposed) this.impacts.wallDust(hit, local);
  }

  explodeBlock(x, y, z, blockId) {
    if (!this._disposed) this.impacts.explodeBlock(x, y, z, blockId);
  }

  spawnParticles(x, y, z, count, tint, options) {
    if (!this._disposed) this.impacts.spawnParticles(x, y, z, count, tint, options);
  }

  spawnBrass(position, velocity) {
    if (!this._disposed) this.brass.spawn(position, velocity);
  }

  update(dt) {
    if (this._disposed) return;
    this._trauma = Math.max(0, this._trauma - dt * 1.8);
    this.tracers.update(dt);
    this.impacts.update(dt);
    this.goreFx.update(dt);
    this.brass.update(dt);
  }

  shake(amount) {
    this._trauma = Math.min(1, this._trauma + amount);
  }

  get currentShakeXY() {
    const trauma = this._trauma * this._trauma;
    return {
      x: (Math.random() * 2 - 1) * trauma * 0.014,
      y: (Math.random() * 2 - 1) * trauma * 0.010,
    };
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.tracers.dispose();
    this.impacts.dispose();
    this.goreFx.dispose();
    this.brass.dispose();
  }
}

/** Wire the rig's world-space shell recipe into the single brass owner. */
export function attachShellBridge(effects, rig) {
  rig.onShellEject = ({ pos, vel }) => effects.spawnBrass(pos, vel);
}
