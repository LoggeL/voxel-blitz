// Public effects facade. Each bounded pool has exactly one owner and the
// facade preserves the historic API consumed by the game composition root.
import { FlameFX } from './flame.js';
import { FireFieldFX } from './fire-fields.js';
import { TracerFX } from './ballistics.js';
import { BrassPool } from './brass.js';
import { GoreFX } from './gore.js';
import { ImpactFX, blockSoundFor } from './impacts.js';
import { ProjectileFX } from './projectiles.js';
import { RailBeamFX } from './rail-beam.js';
import { boltBounces, BOLT_RULES } from '../../../shared/bolt-rules.js';
import { WEAPONS } from '../../../shared/combatmath.js';
import { rocketLaunch } from '../../../shared/rocket-rules.js';
import { GLAIVE_RULES, glaiveLaunch } from '../../../shared/glaive-rules.js';

export { blockSoundFor };

/**
 * Window events for the local player's RIPTIDE discs, so the viewmodel/HUD can react
 * without reaching into the FX layer. `detail` is `{pid, x, y, z}` plus `reason` on a
 * flip ('time'|'bounce'|'return'; predicted, then confirmed by authority at most once
 * per disc). Catch/embed/stock come from authoritative events only; `stock` carries
 * `{fab, pickups, restored}` from the server's `glaiveStock`.
 */
export const GLAIVE_EVENTS = Object.freeze({
  flip: 'vb-glaive-flip',
  catch: 'vb-glaive-catch',
  embed: 'vb-glaive-embed',
  stock: 'vb-glaive-stock',
});

function emitGlaive(name, detail) {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

const BLAST_PARTICLES = Object.freeze({
  frag: Object.freeze({ count: 34, tint: 0xff9f1c, speed: 8.2, size: 1.55, life: 0.72, shake: 0.95, reach: 26 }),
  limpet: Object.freeze({ count: 44, tint: 0xffc27a, speed: 9.5, size: 1.7, life: 0.8, shake: 1.05, reach: 28 }),
  pulse: Object.freeze({ count: 26, tint: 0x9ff4ff, speed: 11, size: 1.2, life: 0.45, shake: 0.7, reach: 24 }),
  rocket: Object.freeze({ count: 52, tint: 0xffb347, speed: 10.5, size: 1.8, life: 0.85, shake: 1.15, reach: 32 }),
  bolt: Object.freeze({ count: 10, tint: 0x7dfcff, speed: 5.5, size: 1.0, life: 0.4, shake: 0.18, reach: 14 }),
  molotov: Object.freeze({ count: 24, tint: 0xff9238, speed: 4.5, size: 1.1, life: 0.65, shake: 0.22, reach: 14 }),
  // RIPTIDE: remote catch sparkle and fizzle. No shake: nothing detonates.
  glaive: Object.freeze({ count: 8, tint: 0xff3fd0, speed: 3.2, size: 0.9, life: 0.35, shake: 0, reach: 1 }),
});

export class Effects {
  constructor(scene, camera, worldGetBlockFn, {
    getEntityPosition = null, onBounce = null, onGlaiveFlip = null, onGlaiveFlight = null,
  } = {}) {
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
    this.fireFields = new FireFieldFX(scene);
    this.railBeams = new RailBeamFX(scene, this.getBlockFn);
    this.goreFx = new GoreFX(scene, camera, this.getBlockFn);
    this.brass = new BrassPool(scene, this.getBlockFn);
    this.projectiles = new ProjectileFX(scene, this.getBlockFn, {
      camera,
      getEntityPosition,
      onTrail: (x, y, z) => this.impacts.spawnParticles(
        x, y, z, 1, 0x8d8f94, { speed: 0.6, gravity: -0.4, size: 1.6, life: 0.55, softness: true },
      ),
      onBounce: (x, y, z, type, contact) => {
        // RIPTIDE wall contact: bright sparks plus a stone chip off the bitten face.
        if (type === 'glaive') this._glaiveSparks(x, y, z, contact);
        if (typeof onBounce === 'function') onBounce(x, y, z, type, contact);
      },
      onGlaiveFlip: (disc, reason) => {
        const detail = { pid: disc.id, x: disc.x, y: disc.y, z: disc.z, reason };
        emitGlaive(GLAIVE_EVENTS.flip, detail);
        if (typeof onGlaiveFlip === 'function') onGlaiveFlip(detail);
      },
      onGlaiveFlight: typeof onGlaiveFlight === 'function' ? onGlaiveFlight : null,
    });
    /** The local player's queued fabrications as `performance.now()` due times. */
    this._glaiveFabDue = [];

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
    } else if (options.local && definition?.projectile === 'glaive' && Array.isArray(event.o)) {
      // A RIPTIDE throw spawns the predicted disc from the shared launch formula; the
      // authority `projectileLaunch` adopts it. Remote discs arrive as launch events.
      const dir = event.spread || event.d;
      const direction = Array.isArray(dir)
        ? { x: dir[0], y: dir[1], z: dir[2] }
        : dir;
      const length = Math.hypot(direction.x, direction.y, direction.z) || 1;
      const launch = glaiveLaunch({
        x: event.o[0], y: event.o[1], z: event.o[2],
        dir: { x: direction.x / length, y: direction.y / length, z: direction.z / length },
      });
      this.projectiles.launch({
        type: 'glaive',
        o: [launch.x, launch.y, launch.z],
        v: [launch.vx, launch.vy, launch.vz],
        bn: launch.bouncesLeft,
      }, { local: true });
    }
  }

  /**
   * Predict R on the RIPTIDE: the local player's out-leg discs turn home at once
   * (each flip also emits `vb-glaive-flip`). Returns how many discs turned.
   */
  glaiveReturn() {
    return this._disposed ? 0 : this.projectiles.returnOwnGlaives();
  }

  /** Local player's discs currently in the air (predicted or confirmed). */
  glaivesInFlight() {
    return this._disposed ? 0 : this.projectiles.ownGlaivesInFlight();
  }

  /**
   * The HUD's RIPTIDE split beside the authoritative `mag`: discs in the air, how many
   * of them R can still turn (`outLeg`), embedded pickups and each fabrication's
   * progress 0..1. Shape matches `GameplayHud.setGlaiveDiscs` (`s.glaive`).
   */
  glaiveHudState(now = performance.now()) {
    let inFlight = 0, outLeg = 0, embedded = 0;
    for (const disc of this.projectiles.projectiles.values()) {
      if (disc.type !== 'glaive' || !disc.own || disc.parked) continue;
      inFlight++;
      if (disc.phase === 'out') outLeg++;
    }
    for (const pickup of this.projectiles.glaivePickups.values()) if (pickup.own) embedded++;
    const regen = GLAIVE_RULES.regenMs;
    const fab01 = this._glaiveFabDue.map(due => Math.max(0, Math.min(1, 1 - (due - now) / regen)));
    return { inFlight, outLeg, embedded, fab01 };
  }

  /**
   * Server `glaiveStock` for one owner: replace that owner's embedded discs and, for
   * the local player, the fabrication queue the HUD reads.
   */
  glaiveStock(event, { own = false } = {}) {
    if (this._disposed || !event) return;
    this.projectiles.syncGlaivePickups(event.id, event.pickups, own);
    if (!own) return;
    const now = performance.now();
    this._glaiveFabDue = Array.isArray(event.fab)
      ? event.fab.map(ms => now + Math.max(0, Number(ms) || 0)) : [];
    emitGlaive(GLAIVE_EVENTS.stock, { fab: event.fab || [], pickups: event.pickups || [], restored: event.restored || null });
  }

  _glaiveSparks(x, y, z, contact) {
    this.impacts.spawnParticles(x, y, z, 9, 0xffd6f4, { speed: 6, gravity: 12, size: 0.8, life: 0.3, sparks: true });
    this.impacts.spawnParticles(
      x + (contact?.nx || 0) * 0.05, y + (contact?.ny || 0) * 0.05, z + (contact?.nz || 0) * 0.05,
      5, 0x7b7670, { speed: 2.8, gravity: 16, size: 1.4, life: 0.55, softness: true },
    );
  }

  confirmShot(event) {
    if (this._disposed || !Array.isArray(event.paths)) return;
    this.tracers.resolvedShot(event, { continuationsOnly: true });
    if (event.w === 'lance') {
      // Replace the short-lived predicted rail with its authoritative terrain path.
      for (const beam of this.railBeams.pool) if (beam.local) beam.group.visible = false;
      this.railBeams.shoot(event);
    }
  }

  impact(event) {
    if (!this._disposed) this.impacts.impact(event);
  }

  gore(event, options = {}) {
    if (!this._disposed) this.goreFx.gore(event, options);
  }

  explodeBlock(x, y, z, blockId) {
    if (!this._disposed) this.impacts.explodeBlock(x, y, z, blockId);
  }

  spawnBrass(position, velocity) {
    if (!this._disposed) this.brass.spawn(position, velocity);
  }

  /** `options.local` spawns a prediction; `options.fromSelf` lets authority adopt it. */
  projectileLaunch(event, options = {}) {
    if (!this._disposed) this.projectiles.launch(event, options);
  }

  /**
   * Predicted flight preview for a `{type,x,y,z,vx,vy,vz,fuseMs?,effectRadius?,chaosLevel?}`
   * launch, or `null` to hide it. Passed through whole, so the landing zone keeps the
   * caller's effect radius.
   */
  projectilePreview(launch) {
    if (this._disposed) return null;
    return this.projectiles.setPreview(launch);
  }

  projectileStick(event) {
    if (!this._disposed) this.projectiles.stick(event);
  }

  /** `options.fromSelf` marks the local player's projectile (RIPTIDE catch/embed hooks). */
  projectileExplode(event, options = {}) {
    if (this._disposed) return;
    if (event?.type === 'glaive') { this._glaiveEnd(event, options); return; }
    this.projectiles.explode(event);
    if (event?.type === 'smoke') return;
    const style = BLAST_PARTICLES[event?.type] || BLAST_PARTICLES.frag;
    this.impacts.spawnParticles(
      Number(event.x), Number(event.y), Number(event.z),
      style.count, style.tint,
      { speed: style.speed, gravity: event?.type === 'pulse' ? 2 : 15, size: style.size, life: style.life, sparks: true },
    );
    if (event?.type === 'frag' || event?.type === 'limpet' || event?.type === 'rocket') {
      // Dirt burst: the blast throws soil up around the sparks — slower,
      // longer-lived and soft. Energy blasts (pulse/bolt) throw none.
      this.impacts.spawnParticles(
        Number(event.x), Number(event.y), Number(event.z),
        26, 0x6e5136,
        { speed: 5.2, gravity: 17, size: 2.3, life: 1.15, softness: true },
      );
    }
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

  _glaiveEnd(event, { fromSelf } = {}) {
    const existing = this.projectiles.projectiles.get(String(event.pid ?? ''));
    const own = fromSelf ?? existing?.own ?? false;
    this.projectiles.explode(event, { fromSelf: own });
    const x = Number(event.x), y = Number(event.y), z = Number(event.z);
    const detail = { pid: String(event.pid ?? ''), x, y, z };
    if (event.picked || ![x, y, z].every(Number.isFinite)) return;
    if (event.caught) {
      if (own) emitGlaive(GLAIVE_EVENTS.catch, detail);
      else this._blastParticles(event, BLAST_PARTICLES.glaive);
      return;
    }
    if (event.embed || event.reason === 'embed') {
      this._glaiveSparks(x, y, z, Array.isArray(event.n) ? { nx: event.n[0], ny: event.n[1], nz: event.n[2] } : null);
      if (own) emitGlaive(GLAIVE_EVENTS.embed, detail);
      return;
    }
    this._blastParticles(event, BLAST_PARTICLES.glaive);
  }

  _blastParticles(event, style) {
    this.impacts.spawnParticles(
      Number(event.x), Number(event.y), Number(event.z),
      style.count, style.tint,
      { speed: style.speed, gravity: 6, size: style.size, life: style.life, sparks: true },
    );
  }


  syncMines(rows, selfId) {
    if (!this._disposed) this.projectiles.syncMines?.(rows, selfId);
  }

  syncFireFields(rows, serverNow) {
    if (!this._disposed) this.fireFields.sync(rows, serverNow);
  }

  update(dt, elapsed = dt) {
    if (this._disposed) return;
    this._trauma = Math.max(0, this._trauma - dt * 1.8);
    this.tracers.update(dt);
    this.railBeams.update(dt);
    this.flames.update(elapsed);
    this.fireFields.update(elapsed);
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

  clearCombatHazards() {
    this.projectiles.clear();
    this._glaiveFabDue = [];
    this.flames.localActive = false; this.flames.localEvent = null;
    for (const puff of this.flames.puffs) puff.life = 0;
    this.flames.geometry.instanceCount = 0;
    this.fireFields.sync([], 0);
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.tracers.dispose();
    this.railBeams.dispose();
    this.flames.dispose();
    this.fireFields.dispose();
    this.impacts.dispose();
    this.goreFx.dispose();
    this.brass.dispose();
    this.projectiles.dispose();
  }
}

/** Wire the rig's live muzzle transform into the local tracer anchor. */
export function attachMuzzleBridge(effects, rig) {
  if (effects.flames) effects.flames.muzzleProvider = (out) => rig.getMuzzleWorldPos(out);
  if (effects.railBeams) effects.railBeams.muzzleProvider = (out) => rig.getMuzzleWorldPos(out);
  effects.tracers.setMuzzleProvider((out) => rig.getMuzzleWorldPos(out));
}

/** Wire the avatar roster's barrel tips into remote shot presentation. Hits
 *  stay authoritative; only tracer/flash/flame/beam origins move to the
 *  rendered muzzle. Safe to call before the roster exists (lazy lookup). */
export function attachRemoteMuzzleBridge(effects, getRoster) {
  const provider = (id, out) => getRoster()?.muzzleWorldPos?.(id, out) ?? null;
  if (effects.flames) effects.flames.remoteMuzzleProvider = provider;
  if (effects.railBeams) effects.railBeams.remoteMuzzleProvider = provider;
  if (effects.tracers) effects.tracers.remoteMuzzleProvider = provider;
}
