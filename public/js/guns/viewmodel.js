// First-person viewmodel facade: public gunfeel API plus one rig-owned
// material cache and one action-state owner.
import * as THREE from '../vendor/three.module.js';
import { BOB, DEPLOY, TIMERS } from './defs.js';
import { buildGun } from './assemble.js';
import { WeaponActions } from './actions.js';
import { MaterialCache } from './kit.js';
import { D2R, HIP, VM_FOV_BASE } from './models/common.js';

export class ViewmodelRig {

  /** Parented to the MAIN camera at (0,0,0). Builds nothing until setWeapon(). */
  constructor(camera) {
    this.camera = camera;
    this.root = new THREE.Group();
    this.root.matrixAutoUpdate = true;
    this.root.renderOrder = 10;
    this.posG = new THREE.Group();                                 // dynamic translation layer
    this.pivot = new THREE.Group();                                // static pos + dynamic ROTATION
    this.comp = new THREE.Group();                                 // cancels pivot -> rotation about grip
    this.content = new THREE.Group();                              // animated base pose (hip<->ADS)
    camera.add(this.root);
    this.root.add(this.posG); this.posG.add(this.pivot);
    this.pivot.add(this.comp); this.comp.add(this.content);

    this._disposed = false;
    this._models = {};                 // lazily-built gun cache keyed by weapon id
    this._materials = new MaterialCache();
    this._cur = null;                  // active model bundle
    this._id = null;
    this._now = 0;                     // rig-local clock, advanced only by update()
    this._queue = [];                  // deferred timer-boundary events {at, fn}

    this._spr = { pitch: { p: 0, v: 0 }, yaw: { p: 0, v: 0 }, push: { p: 0, v: 0 } }; // kick springs
    this._sway = { x: 0, y: 0 };       // look-inertia lag (consumed mouse deltas, BOB.swayPxPerUnit px)
    this._phase = 0;                   // walk bob figure-8 phase accumulator
    this._bobVal = 0;                  // public bobAmt readback for HUD/audio glue
    this._yawFlip = 1;                 // alternating yaw kick sign (wobble seeds it)
    this._rngState = 0xB041;           // mulberry-lite seed, reseeded per magazine below

    this._adsTarget = 0; this._adsSmooth = 0; this._fovScale = 1;
    this._depT = 99;                   // deploy timeline cursor (>=1 == settled)
    this._lockUntil = 0;               // rof-referenced fire gate
    this._stallUntil = Infinity;       // anti-wedge: auto-pumps if mode never calls back
    this._flashT = -1; this._lightT = -1;

    // Timing hooks for the effects/UI/audio agents. All optional; invoked strictly at
    // TIMERS boundary crossings so external glue stays decoupled from internals.
    this.onShellEject = null;   // ({pos:[xyz], vel:[xyz], spin:[xyz]}) — world-space toss recipe
    this.onMuzzleFlash = null;  // (posWorld:{x,y,z}, quatWorld) — first-fire-frame world anchor
    this.onBoltClack = null;    // (stepNum: 1|2|3)  — staged mechanical crossing cues
    this.onReloadClick = null;  // (n:int>=1)       — drop/insert/tap or tube thunk counter

    this._tmpV = new THREE.Vector3(); this._tmpQ = new THREE.Quaternion();
    this._actions = new WeaponActions({
      onBoltClack: (step) => this.onBoltClack?.(step),
      onShellEject: () => this._emitShell(),
      onReloadClick: (step) => this.onReloadClick?.(step),
      onPumpImpulse: (amount) => { this._spr.push.v += amount; },
    });
  }

  /* ------------------------------------ public API ----------------------------------------- */

  /** Lazily builds `id`, swaps visibility, resets transient motion state, replays equip dip. */
  setWeapon(id) {
    const key = TIMERS[id] ? id : 'rifle';                           // forgiving: bad key stays playable
    if (!this._models[key]) {
      const model = buildGun(key, this._materials);
      this._models[key] = model;
    }
    const next = this._models[key];
    this._actions.reset(this._cur);
    this._actions.reset(next);
    if (this._cur && this._cur !== next) this.content.remove(this._cur.root);
    this._cur = next; this._id = key;
    this.content.add(next.root);
    this.pivot.position.copy(next.pivotCam);
    this.comp.position.copy(next.pivotCam).negate();

    this._spr.pitch = { p: 0, v: 0 }; this._spr.yaw = { p: 0, v: 0 }; this._spr.push = { p: 0, v: 0 };
    this._sway.x = this._sway.y = 0;
    this._queue.length = 0;
    this._lockUntil = this._now; this._stallUntil = Infinity;
    this._rngState = (0xB041 ^ (key.charCodeAt(0) * 7919)) | 0;      // deterministic-ish per-mag seed
    this._yawFlip = this._rng() < 0.5 ? 1 : -1;
    this._uniSet(1, 0);                                              // fresh draw: glow pop, cold barrel
    this.flashOff(true);
    this._depT = 0;                                                  // replay DEPLOY raise/settle curve
    this._applyBasePose();                                           // snap content pose immediately
  }

  /**
   * One accepted/enqueued shot envelope: spring impulses from WEAPONS canonical viewKick (mirrored
   * into TIMERS by defs.js), glow+heat shader spikes, 60ms billboard flash + 80ms muzzle light,
   * timer-driven choreography enqueues, rof lockout, callback dispatch. Returns false when busy.
   */
  fire() {
    const cur = this._cur; if (!cur) return false;
    const T = cur.T;
    const now = this._now;
    if (this.isBusy(now)) return false;

    const wn = Math.sqrt(T.kick.stiffness);
    const flip = (this._yawFlip = -this._yawFlip);
    const jitter = 0.8 + this._rng() * 0.4;                          // seeded wobble multiplier
    const pr = T.viewKick.pitchDeg * D2R;
    const yr = T.viewKick.yawDeg * D2R * T.kick.yawWobble * jitter * flip;
    this._spr.pitch.v += pr * wn * 0.9;   // velocity-kick scaled by sqrt(k): peak ~= 0.8x input rad
    this._spr.yaw.v += yr * wn * 0.9;
    this._spr.push.v += 0.35 + pr * 1.1;  // meters/sec rearward surge — bigger kicks shove harder

    this._uniSet(1, Math.min(1, cur.uni.uHeat.value + 0.5)); // burst heat accumulator, capped
    this.revealFlash();

    const cycMs = 60000 / T.rof;          // rpm-referenced gate — literally the fire-cap definition
    this._lockUntil = Math.max(this._lockUntil, now + cycMs / 1000);

    if (T.cycleBack) {
      // Mode owns rechambering (rig.pumpAnim()/boltAnim()); deadline prevents a lost event wedging
      // the busy gate forever. The pause document (bursts[0][0]) informs pacing, drives nothing.
      this._stallUntil = now + cycMs / 1000 + 0.15;
    } else {
      this._enqueue(0.010, () => { if (this.onBoltClack) this.onBoltClack(1); }); // rack back
      this._enqueue(0.014, () => {
        this._actions.startJerk(this._id, this._cur, T.boltTravel, 0.05);
      });       // snappy reciprocation
      this._enqueue(Math.max(0.030, T.rechargeDur * 0.8), () => {
        if (this.onBoltClack) this.onBoltClack(2);                               // snapped home
      });
      if (T.ejectOnFire) this._enqueue(0.045, () => this._emitShell());          // bolt-clear moment
    }

    if (this.onMuzzleFlash) {
      cur.muzzleMarker.updateWorldMatrix(true, false);
      cur.muzzleMarker.getWorldPosition(this._tmpV);
      cur.muzzleMarker.getWorldQuaternion(this._tmpQ);
      this.onMuzzleFlash(this._tmpV.clone(), this._tmpQ.clone());
    }
    return true;
  }

  /** External button-hold ramp reaches us pre-normalized (0..1); we ease-polish + expose readback. */
  ads(t01) {
    this._adsTarget = Math.max(0, Math.min(1, Number(t01) || 0));
  }

  /** Magazine, belt box, tube, stripper, or cylinder reload choreography. */
  reload(dur, type) {
    if (!this._cur) return;
    this._actions.startReload(this._now, dur, type, this._cur.T);
  }

  /** Manual staged cycles (mode-driven). Ignored when cycling already or gun lacks the linkage. */
  pumpAnim() { this._actions.beginCycle('pump', false, this._cur?.T); }
  boltAnim() { this._actions.beginCycle('bolt', false, this._cur?.T); }

  isBusy(now) { return (now ?? this._now) < this._lockUntil || this._actions.cycling; }

  get bobAmt() { return this._bobVal; }              // 0..~1 normalized walk-bob magnitude
  get currentAdsT01() { return this._adsSmooth; }    // HUD scope-opacity readback
  get _rl() { return this._actions?._reload || null; }

  /** Live muzzle world position (uses the actual Object3D — correct through every nested shift). */
  getMuzzleWorldPos(out) {
    const o = out || new THREE.Vector3();
    if (!this._cur) return o.set(0, 0, 0);
    this._cur.muzzleMarker.getWorldPosition(o);
    return o;
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.camera.remove(this.root);

    const geometries = new Set();
    const materials = new Set();
    const textures = new Set();
    const collectMaterial = (material) => {
      if (!material || materials.has(material)) return;
      materials.add(material);
      for (const value of Object.values(material)) {
        if (value?.isTexture) textures.add(value);
      }
      for (const uniform of Object.values(material.uniforms || {})) {
        const value = uniform?.value;
        if (value?.isTexture) textures.add(value);
        else if (Array.isArray(value)) {
          for (const item of value) if (item?.isTexture) textures.add(item);
        }
      }
    };

    const models = Object.values(this._models);
    for (const model of models) {
      model.root.traverse((object) => {
        if (object.geometry) geometries.add(object.geometry);
        if (Array.isArray(object.material)) {
          for (const material of object.material) collectMaterial(material);
        } else {
          collectMaterial(object.material);
        }
      });
    }
    // Cached materials are reference-counted across rigs; only this rig's unique resources
    // can be released before the final shared owner goes away.

    for (const geometry of geometries) geometry.dispose();
    for (const texture of textures) texture.dispose();
    for (const material of materials) {
      if (!this._materials.sharedMaterials.has(material)) material.dispose();
    }

    for (const model of models) {
      model.root.removeFromParent();
      model.root.clear();
    }
    this.content.clear();
    this.root.clear();
    this._queue.length = 0;
    this._actions.dispose(this._cur);
    this._models = {};
    this._cur = null;
    this._id = null;
    this._materials.releaseRig();
  }

  /* ------------------------------------- simulation ---------------------------------------- */

  /**
   * @param dt      seconds, clamped hard to 0.033 (tab-refocus spikes never explode springs)
   * @param ctx     {speed, grounded, mouseDX, mouseDY, isSprinting, crouch, panic, exhaustion}
   *                Mouse deltas move only this gun rig; camera aim remains caller-authoritative.
   */
  update(dt, ctx = {}) {
    if (!(dt > 0)) return;
    dt = Math.min(dt, 0.033);
    const cur = this._cur;
    const speed = ctx.speed || 0, grounded = ctx.grounded !== false;
    const sprinting = !!ctx.isSprinting, crouching = !!ctx.crouch;
    this._now += dt;
    this._drainQueue();

    /* fov counter-scale trick — apparent size locked while WEAPONS.adsFov zooms the real camera */
    const live = (this.camera && this.camera.fov) || VM_FOV_BASE;
    const target = Math.tan((VM_FOV_BASE / 2) * D2R) / Math.tan((live / 2) * D2R);
    this._fovScale += (Math.max(0.75, Math.min(3.2, target)) - this._fovScale) * Math.min(1, dt * 18);
    this.root.scale.setScalar(this._fovScale);

    if (!cur) { this._decayFx(dt, null); return; }
    const T = cur.T;

    /* springs: semi-implicit Euler, 4 equal substeps (h <= 8.25ms, omega^2*h safe for k<=300) */
    const K = T.kick.stiffness, C = T.kick.damping;
    const h = dt / 4;
    for (let i = 0; i < 4; i++) {
      this._spring(this._spr.pitch, K, C, h);
      this._spring(this._spr.yaw, K, C, h);
      this._spring(this._spr.push, K * 1.2, C * 1.4, h);            // stiffer shove settles faster
    }

    /*
     * Turn inertia is an impulse with exact exponential decay: integrated mouse travel produces
     * the same deterministic gun-only lag, while weapon mass scales amplitude and settling time.
     */
    const gain = BOB.swayPxPerUnit;
    const weightRatio = Math.max(0.25, Math.min(3, (Number(T.weightKg) || 3.4) / 3.4));
    const turnAmplitude = 0.72 + weightRatio * 0.32;
    const settleRate = 12 / (0.45 + weightRatio * 0.55);
    const turnImpulse = 0.12 * turnAmplitude;
    const turnDecay = Math.exp(-settleRate * dt);
    this._sway.x = (this._sway.x - (Number(ctx.mouseDX) || 0) / gain * turnImpulse) * turnDecay;
    this._sway.y = (this._sway.y + (Number(ctx.mouseDY) || 0) / gain * turnImpulse) * turnDecay;
    this._sway.x = Math.max(-BOB.swayClamp, Math.min(BOB.swayClamp, this._sway.x));
    this._sway.y = Math.max(-BOB.swayClamp, Math.min(BOB.swayClamp, this._sway.y));

    /* walk bob figure-8 (freq scales with speed; sprint lifts freq+amp+cant; crouch dampens) */
    const spdN = Math.min(1, speed / 4.4);                            // normalized to contract walk
    let ampMul = (sprinting ? BOB.sprintAmpMul : 1) * (grounded ? 1 : BOB.airDampen);
    if (crouching) ampMul *= BOB.crouchDampen;
    const freq = sprinting ? BOB.sprintFreq : BOB.walkFreq;
    this._phase += dt * freq * Math.max(spdN, sprinting ? 1 : spdN) ;
    const bp = this._phase * Math.PI * 2;
    const bobX = Math.sin(bp * 0.5) * BOB.walkHorz * ampMul * spdN;   // figure-8: lazy infinity loop
    const bobY = Math.cos(bp) * BOB.walkVert * ampMul * spdN * (sprinting ? 1 : 0.8);
    this._bobVal = Math.min(1, Math.abs(bobY) / (BOB.walkVert * BOB.sprintAmpMul) +
                                Math.abs(bobX) / (BOB.walkHorz * BOB.sprintAmpMul));

    /* ADS polish: approach rate inverted from canonical adsTime, smoothstep the eased value */
    const rate = 2.2 / Math.max(0.05, T.adsTime);
    this._adsSmooth += (this._adsTarget - this._adsSmooth) * Math.min(1, rate * dt);
    const adsE = this._smooth01(this._adsSmooth);

    /* deploy timeline: rise over DEPLOY.raise slice, spring overshoot, quenched by settleBy */
    this._depT = Math.min(1.0001, this._depT + dt / Math.max(0.05, T.deployTime));

    /* Baseline idle life plus hidden condition motion. Both are deterministic rig-clock functions. */
    const panic = Math.max(0, Math.min(1, Number(ctx.panic) || 0));
    const exhaustion = Math.max(0, Math.min(1, Number(ctx.exhaustion) || 0));
    const condDamp = 1 - adsE * 0.35;
    const phase = cur.conditionPhase;
    const breathe = Math.sin(this._now * BOB.idleFreq * Math.PI * 2) * BOB.idleAmp * (1 - adsE * 0.6);
    const exhaustedBreath = Math.sin(this._now * (3.2 + exhaustion * 0.9) + phase) *
      BOB.idleAmp * 1.8 * exhaustion * condDamp;
    const tremorX = (Math.sin(this._now * 41 + phase) * 0.00045 +
      Math.sin(this._now * 67 + phase * 1.7) * 0.00025) * panic * condDamp;
    const tremorY = (Math.sin(this._now * 47 + phase * 0.7) * 0.00040 +
      Math.sin(this._now * 73 + phase * 1.3) * 0.00020) * panic * condDamp;
    const conditionPitch = (Math.sin(this._now * 13 + phase) * 0.0015 * panic +
      Math.sin(this._now * 3.4 + phase) * 0.0030 * exhaustion) * condDamp;
    const conditionYaw = Math.sin(this._now * 19 + phase * 0.8) * 0.0012 * panic * condDamp;

    /* ---------- choreography states ---------- */
    const actionMotion = this._actions.update(this._now, dt, cur, T);
    const reloadDip = actionMotion.dip;
    const reloadRock = actionMotion.rock;

    /* sprint cant + counter-roll composition */
    const cant = sprinting ? BOB.sprintTiltZ * Math.min(1, speed / 6.2) * (1 - adsE) : 0;
    const roll = bobX / (BOB.walkHorz || 1) * BOB.counterRoll * (1 - adsE * 0.5);

    /* ---------- compose transforms (condition offsets never touch the authoritative camera) ---------- */
    this.posG.position.set(
      this._sway.x * 0.35 + bobX + tremorX,
      this._sway.y * 0.35 + bobY + breathe + exhaustedBreath + tremorY,
      this._spr.push.p
    );
    this.pivot.rotation.set(
      this._spr.pitch.p + this._sway.y * 0.6 + conditionPitch,
      this._spr.yaw.p + this._sway.x * 0.6 + conditionYaw,
      roll + cant
    );

    /* base hip pose eased toward adsOffset absolute pose; dips layered on top */
    const dep = this._deployOffset();
    this.content.position.set(
      HIP.x + (T.adsOffset.x - HIP.x) * adsE,
      HIP.y + (T.adsOffset.y - HIP.y) * adsE + reloadDip + dep.y,
      HIP.z + (T.adsOffset.z - HIP.z) * adsE
    );
    this.content.rotation.set(dep.rx + reloadRock, 0, 0);

    /* shader slot decays: fast capacitor pop, slower ember heat (tau 0.6s per spec) */
    this._decayFx(dt, cur);

    /* anti-stall catch-up: keeps the busy gate honest even if a server event got dropped */
    if (T.cycleBack && !this._actions.cycling && this._now > this._stallUntil) {
      this._stallUntil = Infinity;
      this._actions.beginCycle(T.cycleKind || 'bolt', true, T);
    }
  }

  /* ----------------------------------- private internals ----------------------------------- */

  _rng() {                                                             // mulberry-lite, seeded per mag
    this._rngState = (this._rngState + 0x6D2B79F5) | 0;
    let t = this._rngState;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  _spring(s, k, c, h) {
    s.v += (-k * s.p - c * s.v) * h;
    s.p += s.v * h;
  }

  _smooth01(t) { return t * t * (3 - 2 * t); }

  _enqueue(delayS, fn) { this._queue.push({ at: this._now + delayS, fn }); }
  _drainQueue() {
    if (!this._queue.length) return;
    this._queue.sort((a, b) => a.at - b.at);
    const keep = [];
    for (const e of this._queue) (e.at <= this._now) ? e.fn() : keep.push(e);
    this._queue = keep;
  }

  _uniSet(glow, heat) {
    if (!this._cur) return;
    this._cur.uni.uGlow.value = glow; this._cur.uni.uHeat.value = heat;
  }

  _decayFx(dt, cur) {
    if (!cur) return;
    const u = cur.uni;
    const tauG = Math.max(0.004, cur.T.rechargeDur / 3);
    u.uGlow.value *= Math.exp(-dt / tauG);
    u.uHeat.value *= Math.exp(-dt / 0.6);
    u.uT.value = this._now;
    if (this._flashT >= 0) {
      this._flashT -= dt;
      const k = Math.max(0, this._flashT / 0.06);                      // linear 60ms fade
      for (const m of cur.flash.mats) m.opacity = k;
      if (this._flashT < 0) this.flashOff(false);
    }
    if (this._lightT >= 0) {
      this._lightT -= dt;
      cur.flash.light.intensity = 2.4 * Math.max(0, this._lightT / 0.08); // 80ms exponential-feel falloff
      if (this._lightT < 0) cur.flash.light.intensity = 0;
    }
  }

  revealFlash() {
    const cur = this._cur; if (!cur) return;
    const g = cur.flash.grp;
    const s = 0.85 + this._rng() * 0.5;                                // seeded size flicker
    g.scale.setScalar(s);
    g.quaternion.copy(this.camera.quaternion);                         // billboard to eye plane
    g.visible = true;
    for (const m of cur.flash.mats) m.opacity = 1;
    cur.flash.light.intensity = 2.4;
    this._flashT = 0.06; this._lightT = 0.08;
  }

  flashOff(all) {
    if (!this._cur) return;
    const f = this._cur.flash;
    f.grp.visible = false;
    for (const m of f.mats) m.opacity = 0;
    if (all) { f.light.intensity = 0; this._flashT = this._lightT = -1; }
  }

  /** World-space shell-toss recipe handed to the effects agent via onShellEject. */
  _emitShell() {
    if (!this._cur || typeof this.onShellEject !== 'function') return;
    const cur = this._cur, T = cur.T;
    const cam = this.camera;
    const right = new THREE.Vector3(), up = new THREE.Vector3(), fwd = new THREE.Vector3();
    right.setFromMatrixColumn(cam.matrixWorld, 0);                     // TRUE screen-right basis
    up.setFromMatrixColumn(cam.matrixWorld, 1);
    fwd.setFromMatrixColumn(cam.matrixWorld, 2).negate();
    const port = this.getMuzzleWorldPos(new THREE.Vector3())
      .addScaledVector(fwd, 0.24)                                      // port sits back along receiver
      .addScaledVector(up, T.portY * 0.35);
    // def.ejectRight sign kept verbatim; emission flips onto true-right so ports fling correctly.
    const vr = Math.abs(T.ejectRight) * 30;
    const vel = new THREE.Vector3()
      .addScaledVector(right, vr)
      .addScaledVector(up, 1.6 + this._rng() * 0.6)
      .addScaledVector(fwd, 0.4);
    const spin = [(this._rng() - 0.5) * 30, (this._rng() - 0.5) * 30, (this._rng() - 0.5) * 20];
    this.onShellEject({ pos: port.toArray(), vel: vel.toArray(), spin });
  }

  /** Equip dip: rise out of DEPLOY.startDrop across `raise` slice, overshoot settle, tilt ease. */
  _deployOffset() {
    const p = this._depT;
    if (p >= 1) return { y: 0, rx: 0 };
    const rise = this._smooth01(Math.min(1, p / DEPLOY.raise));
    const osc = p < DEPLOY.settleBy
      ? Math.sin(((p - DEPLOY.raise) / (DEPLOY.peak - DEPLOY.raise)) * Math.PI * 0.5) *
        Math.exp(-(p - DEPLOY.raise) / (DEPLOY.settleBy - DEPLOY.raise) * 3.2) * (DEPLOY.overshoot - 1)
      : 0;
    const tilt = DEPLOY.startTilt * (1 - rise);
    return { y: DEPLOY.startDrop * (1 - rise) + osc * 0.08, rx: tilt };
  }

  /** Snap base pose without waiting for next update tick (setWeapon-time correctness). */
  _applyBasePose() {
    this.content.position.set(HIP.x, HIP.y, HIP.z);
    this.content.rotation.set(DEPLOY.startTilt, 0, 0);
    this.posG.position.set(0, 0, 0);
  }
}
