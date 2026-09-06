// Public effects facade. Each bounded pool has exactly one owner and the
// facade preserves the historic API consumed by the game composition root.
import { FlameFX } from './flame.js';
import { TracerFX } from './ballistics.js';
import { BrassPool } from './brass.js';
import { GoreFX } from './gore.js';
import { ImpactFX, blockSoundFor } from './impacts.js';
import { hideInstance } from './instancing.js';
import { ProjectileFX } from './projectiles.js';
import { RailBeamFX } from './rail-beam.js';
import { boltBounces, BOLT_RULES } from '../../../shared/bolt-rules.js';
import { WEAPONS } from '../../../shared/combatmath.js';
import { rocketLaunch } from '../../../shared/rocket-rules.js';

export { blockSoundFor };

const BLAST_PARTICLES = Object.freeze({
  frag: Object.freeze({ count: 34, tint: 0xff9f1c, speed: 8.2, size: 1.55, life: 0.72, shake: 0.95, reach: 26 }),
  limpet: Object.freeze({ count: 44, tint: 0xffc27a, speed: 9.5, size: 1.7, life: 0.8, shake: 1.05, reach: 28 }),
  pulse: Object.freeze({ count: 26, tint: 0x9ff4ff, speed: 11, size: 1.2, life: 0.45, shake: 0.7, reach: 24 }),
  rocket: Object.freeze({ count: 52, tint: 0xffb347, speed: 10.5, size: 1.8, life: 0.85, shake: 1.15, reach: 32 }),
  bolt: Object.freeze({ count: 10, tint: 0x7dfcff, speed: 5.5, size: 1.0, life: 0.4, shake: 0.18, reach: 14 }),
});

export class Effects {
  constructor(scene, camera, worldGetBlockFn, { getEntityPosition = null, onBounce = null } = {}) {
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
    this.flames = new FlameFX(scene, this.getBlockFn);
    this.railBeams = new RailBeamFX(scene, this.getBlockFn);
    this.goreFx = new GoreFX(scene, camera, this.getBlockFn);
    this.brass = new BrassPool(scene, this.getBlockFn);
    this.projectiles = new ProjectileFX(scene, this.getBlockFn, {
      camera,
      getEntityPosition,
      onTrail: (x, y, z) => this.impacts.spawnParticles(
        x, y, z, 1, 0x8d8f94, { speed: 0.6, gravity: -0.4, size: 1.6, life: 0.55, softness: true },
      ),
      onBounce: typeof onBounce === 'function' ? onBounce : null,
    });

    this.stats = {};
    Object.defineProperties(this.stats, {
      shots: { enumerable: true, get: () => this.tracers?.stats?.shots || 0 },
      particlesSpawned: {
        enumerable: true,
        get: () => this.impacts?.particlesSpawned || 0,
      },
      projectiles: { enumerable: true, get: () => this.projectiles?.projectiles.size || 0 },
    });
  }

  setShellSpawner(_spawn) {
    // Legacy no-op: attachShellBridge injects directly into spawnBrass().
  }

  hideInstance(mesh, index) {
    hideInstance(mesh, index);
  }

  shoot(event, options = {}) {
    if (this._disposed) return;
    if (event.w === 'flamethrower') { this.flames.shoot(event, options); return; }
    this.tracers.shoot(event, options);
    if (event.w === 'lance') this.railBeams.shoot(event, options);
    // A rocket shot spawns the predicted projectile locally; remote rockets arrive as
    // authoritative `projectileLaunch` events and only get the muzzle flash here.
    const definition = WEAPONS[event?.w];
    if (options.local && definition?.projectile === 'rocket' && Array.isArray(event.o)) {
      const dir = event.spread || event.d;
      const direction = Array.isArray(dir)
        ? { x: dir[0], y: dir[1], z: dir[2] }
        : dir;
      const launch = rocketLaunch({ x: event.o[0], y: event.o[1], z: event.o[2], dir: direction });
      this.projectiles.launch({
        type: 'rocket',
        o: [launch.x, launch.y, launch.z],
        v: [launch.vx, launch.vy, launch.vz],
      }, { local: true });
    } else if (options.local && definition?.projectile === 'bolt' && Array.isArray(event.o)) {
      // A bolt shot spawns the predicted projectile locally with its reflection budget;
      // remote bolts arrive as authoritative `projectileLaunch` events instead.
      const dir = event.spread || event.d;
      const direction = Array.isArray(dir)
        ? { x: dir[0], y: dir[1], z: dir[2] }
        : dir;
      const length = Math.hypot(direction.x, direction.y, direction.z) || 1;
      this.projectiles.launch({
        type: 'bolt',
        o: [event.o[0], event.o[1], event.o[2]],
        v: [
          direction.x / length * BOLT_RULES.speed,
          direction.y / length * BOLT_RULES.speed,
          direction.z / length * BOLT_RULES.speed,
        ],
        bn: boltBounces(event.charge ?? 1),
      }, { local: true });
    }
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

  /** `options.local` spawns a prediction; `options.fromSelf` lets authority adopt it. */
  projectileLaunch(event, options = {}) {
    if (!this._disposed) this.projectiles.launch(event, options);
  }

  /** Predicted flight preview for a `{type,x,y,z,vx,vy,vz}` launch, or `null` to hide it. */
  projectilePreview(launch) {
    if (this._disposed) return null;
    return this.projectiles.setPreview(launch);
  }

  projectileStick(event) {
    if (!this._disposed) this.projectiles.stick(event);
  }

  projectileExplode(event) {
    if (this._disposed) return;
    this.projectiles.explode(event);
    const style = BLAST_PARTICLES[event?.type] || BLAST_PARTICLES.frag;
    this.impacts.spawnParticles(
      Number(event.x), Number(event.y), Number(event.z),
      style.count, style.tint,
      { speed: style.speed, gravity: event?.type === 'pulse' ? 2 : 15, size: style.size, life: style.life, sparks: true },
    );
    const position = this.camera?.position;
    if (position) {
      const distance = Math.hypot(
        position.x - Number(event.x),
        position.y - Number(event.y),
        position.z - Number(event.z),
      );
      this.shake(Math.max(0, style.shake - distance / style.reach));
    }
  }

  update(dt, elapsed = dt) {
    if (this._disposed) return;
    this._trauma = Math.max(0, this._trauma - dt * 1.8);
    this.tracers.update(dt);
    this.railBeams.update(dt);
    this.flames.update(elapsed);
    this.impacts.update(dt);
    this.goreFx.update(dt);
    this.brass.update(dt);
    this.projectiles.update(dt);
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
    this.railBeams.dispose();
    this.flames.dispose();
    this.impacts.dispose();
    this.goreFx.dispose();
    this.brass.dispose();
    this.projectiles.dispose();
  }
}

/** Wire the rig's world-space shell recipe into the single brass owner. */
export function attachShellBridge(effects, rig) {
  rig.onShellEject = ({ pos, vel }) => effects.spawnBrass(pos, vel);
}

/** Wire the rig's live muzzle transform into the local tracer anchor. */
export function attachMuzzleBridge(effects, rig) {
  if (effects.flames) effects.flames.muzzleProvider = (out) => rig.getMuzzleWorldPos(out);
  if (effects.railBeams) effects.railBeams.muzzleProvider = (out) => rig.getMuzzleWorldPos(out);
  effects.tracers.setMuzzleProvider((out) => rig.getMuzzleWorldPos(out));
}
