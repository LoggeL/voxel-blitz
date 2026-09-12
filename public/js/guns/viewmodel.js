import { applyGunCosmetics } from '../cosmetics/skins.js';
// First-person viewmodel facade: public gunfeel API plus one rig-owned
// material cache and one action-state owner.
import { weaponSwapProfile } from '../../../shared/weapon-swap.js';
import { WEAPONS } from '../../../shared/combatmath.js';
import * as THREE from '../vendor/three.module.js';
import { animateHeavyWeapon } from './heavy-weapon-animation.js';
import { BOB, DEPLOY, TIMERS } from './defs.js';
import { buildGun, disposeGunModels } from './assemble.js';
import { WeaponActions } from './actions.js';
import { MaterialCache } from './kit.js';
import { D2R, HIP, VM_FOV_BASE } from './models/common.js';
import { kickMassScale } from './defs.js';
import { WeaponTurnInertia } from './turn-inertia.js';
import { SPRINT_AIM_DIP } from './weapon-aim.js';
import { VaultHands } from './vault-hands.js';
import { ThrowableHands } from './throwable-hands.js';
import { MedkitHands } from './medkit-hands.js';
import { QUICK_MELEE_SECONDS } from '../../../shared/quick-melee.js';
import { PICKAXE_SWING_SECONDS as SWING_S, PICKAXE_CARRY_YAW, PICKAXE_CARRY_ROLL, pickaxeSwingPose } from './pickaxe-swing.js';


export class ViewmodelRig {

  /** Parented to the MAIN camera at (0,0,0). Builds nothing until setWeapon(). */
  constructor(camera) {
    this.camera = camera;
    this.root = new THREE.Group();
    this.root.matrixAutoUpdate = true;
    this.root.renderOrder = 10;
    this.posG = new THREE.Group();                                 // dynamic translation layer
    this.pivot = new THREE.Group();                                // static pos + dynamic ROTATION
    this.pivot.rotation.order = 'YXZ';
    this.comp = new THREE.Group();                                 // cancels pivot -> rotation about grip
    this.content = new THREE.Group();                              // animated base pose (hip<->ADS)
    camera.add(this.root);
    this.root.add(this.posG); this.posG.add(this.pivot);
    this.pivot.add(this.comp); this.comp.add(this.content);
    this._vaultHands = new VaultHands(this.root);
    this._medkitHands = new MedkitHands(this.root);
    this._throwableHands = new ThrowableHands(this.root, (event) => this.onGrenadeCue?.(event));

    this._disposed = false;
    this._models = {};                 // lazily-built gun cache keyed by weapon id
    this._materials = new MaterialCache();
    this._chargeOrb = new THREE.Group();
    const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.055, 1),
      new THREE.MeshBasicMaterial({ color: 0xc9a2ff, transparent: true, opacity: 0.8,
        blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
    this._chargeOrb.add(core);
    for (let i = 0; i < 2; i++) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.085 + i * 0.018, 0.004, 4, 24),
        new THREE.MeshBasicMaterial({ color: i ? 0x86edff : 0xc9a2ff,
          transparent: true, opacity: 0.65, blending: THREE.AdditiveBlending,
          depthWrite: false, toneMapped: false }));
      ring.rotation.x = i * Math.PI / 2;
      this._chargeOrb.add(ring);
    }
    this._chargeOrb.visible = false;
    this._cur = null;                  // active model bundle
    this._id = null;
    this._now = 0;                     // rig-local clock, advanced only by update()
    this._queue = [];                  // deferred timer-boundary events {at, fn}

    this._spr = { pitch: { p: 0, v: 0 }, yaw: { p: 0, v: 0 }, push: { p: 0, v: 0 } }; // kick springs
    this._turn = new WeaponTurnInertia(); // camera-independent, weight-limited weapon orientation
    this._air = { p: 0, v: 0 };         // damped vertical inertia across takeoff/landing
    this._nadeThrowT = 0;               // seconds left in the throw lunge
    this._swingT = 0;                   // seconds left in the pickaxe chop (T.melee only)
    this._swingContact = false;          // accepted contact for this swing
    this._chargeT = 0;                  // held capacitor charge 0..1 (coil glow floor + squeeze)
    this._lean = { p: 0, v: 0 };        // lagged lateral lean (m) from strafing, mass-scaled
    this._surge = { p: 0, v: 0 };       // lagged fore/aft surge (m) from acceleration
    this._wasGrounded = true;
    this._fallSpeed = 0;
    this._phase = 0;                   // walk bob figure-8 phase accumulator
    this._bobVal = 0;                  // public bobAmt readback for HUD/audio glue
    this._gait = 0;
    this._sprint = 0;
    this._crouchBlend = 0;
    this._groundBlend = 1;
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
    this.onGrenadeCue = null;   // ({cue,type,charge}) — draw, pin/ignite, ready, throw contacts

    this._tmpV = new THREE.Vector3(); this._tmpQ = new THREE.Quaternion();
    this._aimQ = new THREE.Quaternion();
    this._cameraQ = new THREE.Quaternion();
    this._cosmeticQ = new THREE.Quaternion();
    this._aimEuler = new THREE.Euler(0, 0, 0, 'YXZ');
    this._actions = new WeaponActions({
      onBoltClack: (step) => this.onBoltClack?.(step),
      onShellEject: () => this._emitShell(),
      onReloadClick: (step) => this.onReloadClick?.(step),
      onPumpImpulse: (amount) => { this._spr.push.v += amount; },
    });
  }

  /* ------------------------------------ public API ----------------------------------------- */

  /** Lazily builds `id`, swaps visibility, resets transient motion state, replays equip dip. */
  /** Keep the outgoing model attached until it has reached the holster. */
  equipWeapon(id) {
    if (!this._cur) { this.setWeapon(id); return; }
    const profile = weaponSwapProfile(WEAPONS[id]);
    this._swap = { id, elapsed: this._swap?.elapsed || 0, ...profile };
    this._actions.reset(this._cur);
    this._queue.length = 0;
    this._adsTarget = 0;
    this.flashOff(true);
  }

  setCosmetics(loadout) {
    this._cosmetics = loadout;
    for (const [weapon, model] of Object.entries(this._models)) applyGunCosmetics(model, weapon, loadout);
  }

  setWeapon(id) {
    this._quickMelee = null;
    this._swap = null;
    this._swapDraw = false;
    const key = TIMERS[id] ? id : 'rifle';                           // forgiving: bad key stays playable
    if (!this._models[key]) {
      const model = buildGun(key, this._materials);
      this._models[key] = model;
    }
    const next = this._models[key];
    applyGunCosmetics(next, key, this._cosmetics);
    this._actions.reset(this._cur);
    this._actions.reset(next);
    if (this._cur && this._cur !== next) this.content.remove(this._cur.root);
    this._cur = next; this._id = key;
    this.content.add(next.root);
    next.muzzleMarker.add(this._chargeOrb);
    this._chargeOrb.visible = false;
    this.pivot.position.copy(next.pivotCam);
    this.comp.position.copy(next.pivotCam).negate();

    this._spr.pitch = { p: 0, v: 0 }; this._spr.yaw = { p: 0, v: 0 }; this._spr.push = { p: 0, v: 0 };
    this._turn.reset(this.camera?.rotation?.y, this.camera?.rotation?.x);
    this._nadeWind = 0; this._nadeThrowT = 0;
    this._swingT = 0; this._swingContact = false;                     // no mid-swap slash residue
    this._lean.p = this._lean.v = 0;
    this._surge.p = this._surge.v = 0;
    this._nadeWind = 0; this._nadeThrowT = 0;
    this._chargeT = 0;
    this._flameActive = false;
    this._flameFuel = 1;
    this._fallSpeed = 0;
    this._queue.length = 0;
    this._lockUntil = this._now; this._stallUntil = Infinity;
    this._rngState = (0xB041 ^ (key.charCodeAt(0) * 7919)) | 0;      // deterministic-ish per-mag seed
    this._yawFlip = this._rng() < 0.5 ? 1 : -1;
    this._uniSet(1, 0);                                              // fresh draw: glow pop, cold barrel
    this.flashOff(true);
    this._depT = 0;                                                  // replay DEPLOY raise/settle curve
    this._applyBasePose();                                           // snap content pose immediately
  }

  quickMelee() {
    if (!this._cur || this.grenadeActive || this._swap || this._quickMelee) return false;
    const weapon = this._id;
    this.setWeapon('knife');
    this._depT = 1;
    if (!this.fire()) { this.setWeapon(weapon); this._depT = 1; return false; }
    this._quickMelee = { weapon, remaining: QUICK_MELEE_SECONDS };
    return true;
  }

  cancelQuickMelee() {
    if (!this._quickMelee) return;
    this.setWeapon(this._quickMelee.weapon);
    this._depT = 1;
  }

  /** Only accepted local contacts add the wrist rebound; misses follow through. */
  pickaxeContact() {
    if (this._id === 'knife' && this._swingT > 0) this._swingContact = true;
  }

  /**
   * One accepted/enqueued shot envelope: spring impulses from WEAPONS canonical viewKick (mirrored
   * into TIMERS by defs.js), glow+heat shader spikes, 60ms billboard flash + 80ms muzzle light,
   * timer-driven choreography enqueues, rof lockout, callback dispatch. Returns false when busy.
   */
  fire(def = WEAPONS[this._id]) {
    const cur = this._cur; if (!cur || this.grenadeActive || this._swap || (this._swapDraw && this._depT < 1)) return false;
    const T = cur.T;
    const now = this._now;
    // Rotary cadence is metered by WeaponState, like the continuous nozzle.
    // A second frame-rounded rate gate would turn 1200 RPM into 900 at 30fps.
    if (this._id === 'minigun' ? this._actions.cycling || this._actions.reloading : this.isBusy(now)) return false;
    // The weapon state meters continuous fuel. Heating the nozzle does not cycle
    // a bolt or repeatedly kick/flash like individual firearm discharges.
    if (T.continuous) {
      this._uniSet(1, Math.min(1, cur.uni.uHeat.value + 0.12));
      return true;
    }
    // Melee uses the hand-pivot chop and contact rebound instead of gun recoil.
    // The rate cap paces swings; muzzle flash and barrel heat remain inactive.
    if (T.melee) {
      this._swingContact = false;
      this._swingT = SWING_S;
      this._lockUntil = Math.max(this._lockUntil, now + 60000 / T.rof / 1000);
      return true;
    }


    const mass = kickMassScale(T.weightKg);                          // <1 heavy, >1 light
    const wn = Math.sqrt(T.kick.stiffness * mass);
    const flip = (this._yawFlip = -this._yawFlip);
    const jitter = 0.8 + this._rng() * 0.4;                          // seeded wobble multiplier
    const pr = (def?.recoil?.pitch ?? T.viewKick.pitchDeg) * D2R;
    const yr = (def?.recoil?.yaw ?? T.viewKick.yawDeg) * D2R * T.kick.yawWobble * jitter * flip;
    // Velocity kicks scaled by sqrt(k): a light gun snaps up and back fast, a heavy one
    // lifts less but on a slower spring, so the muzzle is still climbing when the next
    // round leaves and sustained fire visibly wallows instead of buzzing.
    this._spr.pitch.v += pr * wn * 0.9;
    this._spr.yaw.v += yr * wn * 0.9;
    this._spr.push.v += ((this._id === 'minigun' ? 0.10 : 0.35) + pr * 1.1) * Math.sqrt(mass);

    this._uniSet(1, Math.min(1, cur.uni.uHeat.value + 0.5)); // burst heat accumulator, capped
    this.revealFlash();

    const cycMs = 60000 / T.rof;          // rpm-referenced gate — literally the fire-cap definition
    this._lockUntil = Math.max(this._lockUntil, now + cycMs / 1000);

    if (T.cycleBack) {
      // Mode owns rechambering (rig.pumpAnim()/boltAnim()); deadline prevents a lost event wedging
      // the busy gate forever. The pause document (bursts[0][0]) informs pacing, drives nothing.
      this._stallUntil = now + cycMs / 1000 + 0.15;
    } else if (this._id === 'minigun') {
      // The rotary feed ejects steadily; it has no reciprocating rifle bolt.
      if (T.ejectOnFire) this._enqueue(0.025, () => this._emitShell());
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

  /**
   * Charge weapons: live 0..1 capacitor charge while the trigger is held. Drives the coil
   * glow floor and a slight rearward squeeze; presentation only, it never gates fire.
   */
  setMinigun(state) { this._minigunState = { ...state }; }

  setFlame(active, fuel = 1) {
    this._flameActive = !!active;
    this._flameFuel = Math.max(0, Math.min(1, fuel));
  }

  setCharge(t01) {
    this._chargeT = Math.max(0, Math.min(1, Number(t01) || 0));
    if (this._chargeT === 0) this._chargeOrb.visible = false;
  }

  /** External button-hold ramp reaches us pre-normalized (0..1); we ease-polish + expose readback. */
  ads(t01) {
    this._adsTarget = Math.max(0, Math.min(1, Number(t01) || 0));
  }

  /** Magazine, belt box, tube, stripper, or cylinder reload choreography. */
  reload(dur, type, stages = null, elapsed = 0) {
    if (!this._cur) return;
    this._actions.startReload(this._now - elapsed, dur, type, this._cur.T, stages);
  }

  /** A shot interrupted a staged reload: snap the moving parts home, keep the gun raised. */
  cancelReload() {
    if (!this._cur) return false;
    return this._actions.cancelReload(this._cur);
  }

  /**
   * Explicit active supports the first held frame at zero charge. holdMs advances
   * draw/pin contacts even when a render frame is skipped; numeric-only callers remain valid.
   */
  grenadeCharge(t01, type = 0, holdMs = null, active = Number(t01) > 0) {
    this._nadeTarget = active ? Math.max(0, Math.min(1, Number(t01) || 0)) : 0;
    this._throwableHands.setCharge(t01, type, holdMs, active);
  }

  /** Release: a short forward lunge with a muzzle dip, then the springs settle it. */
  grenadeThrow(charge = 0.5, type = this._throwableHands.type) {
    this._throwableHands.throw(charge, type);
    const strength = 0.6 + Math.max(0, Math.min(1, Number(charge) || 0)) * 0.4;
    this._nadeThrowT = 0.34;
    this._nadeThrowStrength = strength;
    this._spr.push.v -= 0.9 * strength;                     // forward surge
    this._spr.pitch.v -= 0.12 * Math.sqrt(this._cur?.T.kick.stiffness || 200) * strength;
    this._nadeTarget = 0;
  }

  cancelGrenade() {
    this._throwableHands.cancel();
    this._nadeTarget = this._nadeWind = this._nadeThrowT = 0;
    this.content.visible = true;
  }

  get grenadeActive() {
    const hands = this._throwableHands;
    return hands.held || hands.throwElapsed !== null || hands.returnElapsed !== null;
  }

  /** Manual staged cycles (mode-driven). Ignored when cycling already or gun lacks the linkage. */
  pumpAnim() { this._actions.beginCycle('pump', false, this._cur?.T); }
  boltAnim() { this._actions.beginCycle('bolt', false, this._cur?.T); }

  isBusy(now) { return (now ?? this._now) < this._lockUntil || this._actions.cycling; }

  get bobAmt() { return this._bobVal; }              // 0..~1 normalized walk-bob magnitude
  get currentAdsT01() { return this._adsSmooth; }    // HUD scope-opacity readback
  get turnLag() { return this._turn.readModel; }      // gun-only angular follower readback

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
    this._vaultHands.dispose();
    this._medkitHands.dispose();
    this._throwableHands.dispose();

    this._chargeOrb.removeFromParent();
    for (const mesh of this._chargeOrb.children) {
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
    disposeGunModels(this._models, this._materials);
    this.content.clear();
    this.root.clear();
    this._queue.length = 0;
    this._actions.dispose(this._cur);
    this._models = {};
    this._cur = null;
    this._id = null;
  }

  /* ------------------------------------- simulation ---------------------------------------- */

  /**
   * @param dt      elapsed seconds; action clocks advance while spring steps stay capped at 0.033
   * @param ctx     {speed,grounded,verticalVelocity,lateralSpeed,forwardSpeed,isSprinting,crouch,
   *                 panic,exhaustion,pain,aimSwayScale}
   *                Camera orientation is observed, never delayed or modified by this rig.
   */
  update(dt, ctx = {}) {
    if (!(dt > 0)) return;
    const elapsed = Math.min(dt, 0.25);
    let drawElapsed = elapsed;
    if (this._quickMelee) {
      this._quickMelee.remaining -= elapsed;
      if (this._quickMelee.remaining <= 1e-6) this.cancelQuickMelee();
    }
    dt = Math.min(dt, 0.033);
    if (this._swap) {
      this._swap.elapsed += elapsed;
      if (this._swap.elapsed >= this._swap.holster) {
        const pending = this._swap;
        drawElapsed = pending.elapsed - pending.holster;
        this.setWeapon(pending.id);
        this._swapDraw = true;
        this._swapDrawSeconds = pending.draw;
      }
    }
    const cur = this._cur;
    if (cur) animateHeavyWeapon(cur.body, { dt: elapsed, time: this._now,
      minigun: this._minigunState, flameActive: this._flameActive, fuel: this._flameFuel });
    const speed = ctx.speed || 0, grounded = ctx.grounded !== false;
    const verticalVelocity = Number.isFinite(ctx.verticalVelocity) ? ctx.verticalVelocity : 0;
    const lateralSpeed = Number.isFinite(ctx.lateralSpeed) ? ctx.lateralSpeed : 0;
    const forwardSpeed = Number.isFinite(ctx.forwardSpeed) ? ctx.forwardSpeed : 0;
    const sprinting = !!ctx.isSprinting, crouching = !!ctx.crouch;
    const vaulting = !!ctx.vaulting;
    const vaultBlend = this._vaultHands.update(elapsed, vaulting, ctx.vaultProgress);
    const throwableBlend = this._throwableHands.update(elapsed, { suppressed: vaulting });
    const healing = !!ctx.medkitActive && !vaulting;
    const medkitBlend = this._medkitHands.update(elapsed, healing, ctx.medkitProgress, ctx.reducedMotion);
    this.content.visible = throwableBlend < 0.92 && !healing && medkitBlend < 0.05;
    this._now += elapsed;
    this._drainQueue();

    /* fov counter-scale trick — apparent size locked while WEAPONS.adsFov zooms the real camera */
    const live = (this.camera && this.camera.fov) || VM_FOV_BASE;
    const target = Math.tan((VM_FOV_BASE / 2) * D2R) / Math.tan((live / 2) * D2R);
    this._fovScale += (Math.max(0.75, Math.min(3.2, target)) - this._fovScale) * Math.min(1, dt * 18);
    this.root.scale.setScalar(this._fovScale);

    if (!cur) { this._decayFx(dt, null); return; }
    const T = cur.T;

    /* springs: semi-implicit Euler, 4 equal substeps (h <= 8.25ms, omega^2*h safe for k<=300).
       Mass scaling lowers the natural frequency for heavy guns while keeping the damping ratio. */
    const mass = kickMassScale(T.weightKg);
    const K = T.kick.stiffness * mass, C = T.kick.damping * Math.sqrt(mass);
    const h = dt / 4;
    for (let i = 0; i < 4; i++) {
      this._spring(this._spr.pitch, K, C, h);
      this._spring(this._spr.yaw, K, C, h);
      this._spring(this._spr.push, K * 1.2, C * 1.4, h);            // stiffer shove settles faster
    }

    /* vertical inertia: camera follows physics immediately, the carried gun trails on a damped spring */
    if (!grounded) this._fallSpeed = Math.max(this._fallSpeed, -verticalVelocity);
    if (grounded !== this._wasGrounded) {
      if (!grounded && verticalVelocity > 0.5) {
        this._air.v -= BOB.jumpTakeoffImpulse;
      } else if (grounded && this._fallSpeed > 1.5) {
        const impact = Math.max(0.35, Math.min(1, this._fallSpeed / 8));
        this._air.v -= BOB.landImpactImpulse * impact;
      }
      if (grounded) this._fallSpeed = 0;
      this._wasGrounded = grounded;
    }
    const airTarget = grounded ? 0 : Math.max(
      -BOB.airOffsetClamp,
      Math.min(BOB.airOffsetClamp, -verticalVelocity * BOB.airVelocityLag),
    );
    for (let i = 0; i < 4; i++) {
      this._springTo(
        this._air,
        airTarget,
        BOB.airSpringStiffness,
        BOB.airSpringDamping,
        h,
      );
    }

    const turn = ctx.weaponAim?.turn || this._turn.update(dt, {
      yaw: this.camera?.rotation?.y,
      pitch: this.camera?.rotation?.x,
      weightKg: T.weightKg,
      handling: ctx.weaponDef?.handling || WEAPONS[this._id]?.handling,
      ads: this._adsSmooth,
    });

    /* body-motion inertia: the carried mass trails strafes and stops on a loose, heavy spring */
    const leanTarget = Math.max(-1, Math.min(1, -lateralSpeed / 6.2)) * BOB.leanMax * (1 - this._adsSmooth * 0.7);
    const surgeTarget = Math.max(-1, Math.min(1, forwardSpeed / 6.2)) * BOB.surgeMax * (1 - this._adsSmooth * 0.7);
    const bodyK = BOB.bodySpringStiffness * mass, bodyC = BOB.bodySpringDamping * Math.sqrt(mass);
    for (let i = 0; i < 4; i++) {
      this._springTo(this._lean, leanTarget, bodyK, bodyC, h);
      this._springTo(this._surge, surgeTarget, bodyK, bodyC, h);
    }

    /* walk bob figure-8 (freq scales with speed; sprint lifts freq+amp+cant; crouch dampens) */
    const follow = 1 - Math.exp(-12 * elapsed);
    this._gait += ((vaulting ? 0 : Math.min(1, speed / 4.4)) - this._gait) * follow;
    this._sprint += ((sprinting && grounded && !crouching && !vaulting ? 1 : 0) - this._sprint) * follow;
    this._crouchBlend += ((crouching ? 1 : 0) - this._crouchBlend) * follow;
    this._groundBlend += ((grounded ? 1 : 0) - this._groundBlend) * follow;
    const spdN = this._gait;
    const ampMul = (1 + (BOB.sprintAmpMul - 1) * this._sprint)
      * (BOB.airDampen + (1 - BOB.airDampen) * this._groundBlend)
      * (1 + (BOB.crouchDampen - 1) * this._crouchBlend) * (1 - vaultBlend);
    const freq = BOB.walkFreq + (BOB.sprintFreq - BOB.walkFreq) * this._sprint;
    this._phase += elapsed * freq * spdN;
    const bp = this._phase * Math.PI * 2;
    const bobX = Math.sin(bp * 0.5) * BOB.walkHorz * ampMul * spdN * (ctx.reducedMotion ? 0.15 : 1);   // figure-8: lazy infinity loop
    const bobY = Math.cos(bp) * BOB.walkVert * ampMul * spdN * (0.8 + this._sprint * 0.2) * (ctx.reducedMotion ? 0.15 : 1);
    this._bobVal = Math.min(1, Math.abs(bobY) / (BOB.walkVert * BOB.sprintAmpMul) +
                                Math.abs(bobX) / (BOB.walkHorz * BOB.sprintAmpMul));

    /* ADS polish: approach rate inverted from canonical adsTime, smoothstep the eased value */
    const rate = 2.2 / Math.max(0.05, T.adsTime);
    this._adsSmooth += (this._adsTarget - this._adsSmooth) * Math.min(1, rate * dt);
    const adsE = this._smooth01(this._adsSmooth);

    /* deploy timeline: rise over DEPLOY.raise slice, spring overshoot, quenched by settleBy */
    this._depT = Math.min(1.0001, this._depT + drawElapsed / Math.max(0.05, this._swapDraw ? this._swapDrawSeconds : T.deployTime));

    /* Baseline idle life plus hidden condition motion. Both are deterministic rig-clock functions. */
    const panic = Math.max(0, Math.min(1, Number(ctx.panic) || 0));
    const exhaustion = Math.max(0, Math.min(1, Number(ctx.exhaustion) || 0));
    const cosmeticMotion = ctx.reducedMotion ? 0 : 1;
    const distress = panic * cosmeticMotion;
    const aimSwayScale = Number.isFinite(ctx.aimSwayScale)
      ? Math.max(0, Math.min(2, ctx.aimSwayScale))
      : 1;
    const condDamp = 1 - adsE * 0.35;
    const phase = cur.conditionPhase;
    const breathe = Math.sin(this._now * (BOB.idleFreq + panic * 0.45) * Math.PI * 2) * BOB.idleAmp *
      (1 - adsE * 0.6) * aimSwayScale * (1 + panic * 0.7) * cosmeticMotion;
    const exhaustedBreath = Math.sin(this._now * (3.2 + exhaustion * 0.9) + phase) *
      BOB.idleAmp * 1.8 * exhaustion * condDamp * aimSwayScale * cosmeticMotion;
    const tremorX = (Math.sin(this._now * 7 + phase) * 0.00045 +
      Math.sin(this._now * 11 + phase * 1.7) * 0.00025) * distress * condDamp * aimSwayScale;
    const tremorY = (Math.sin(this._now * 8 + phase * 0.7) * 0.00040 +
      Math.sin(this._now * 12 + phase * 1.3) * 0.00020) * distress * condDamp * aimSwayScale;
    const conditionPitch = (Math.sin(this._now * 13 + phase) * 0.0015 * distress +
      Math.sin(this._now * 3.4 + phase) * 0.0030 * exhaustion) * condDamp * aimSwayScale * cosmeticMotion;
    const conditionYaw = Math.sin(this._now * 19 + phase * 0.8) * 0.0012 *
      distress * condDamp * aimSwayScale;

    /* ---------- choreography states ---------- */
    const actionMotion = this._actions.update(this._now, dt, cur, T);
    const reloadDip = actionMotion.dip;
    const reloadRock = actionMotion.rock;

    /* grenade wind-up + throw lunge (mass-scaled: a heavy gun is slower to pull aside) */
    const windRate = 9 * Math.sqrt(mass);
    this._nadeWind += (Math.max(this._nadeTarget || 0, throwableBlend) - this._nadeWind) * Math.min(1, dt * windRate);
    const wind = this._smooth01(this._nadeWind);
    let lunge = 0;
    if (this._nadeThrowT > 0) {
      this._nadeThrowT = Math.max(0, this._nadeThrowT - dt);
      lunge = Math.sin(Math.PI * (1 - this._nadeThrowT / 0.34)) * (this._nadeThrowStrength || 1);
    }
    /* capacitor charge: the gun creeps back into the shoulder and hums with a fine tremor */
    const chargeT = this._chargeT;
    const strain = this._id === 'lance' ? chargeT ** 3 : chargeT * 0.12;
    const chargeZ = 0.045 * chargeT + Math.sin(this._now * 61) * 0.009 * strain;
    const chargeY = Math.sin(this._now * 47) * 0.007 * strain;
    const nadeX = -0.035 * wind + 0.02 * lunge + Math.sin(this._now * 73) * 0.006 * strain;
    const nadeY = -0.42 * wind - 0.03 * lunge + chargeY;
    const nadeZ = 0.03 * wind - 0.06 * lunge + chargeZ;
    const nadeRx = -0.14 * wind - 0.16 * lunge + Math.sin(this._now * 53) * 0.018 * strain;
    const nadeRz = 0.20 * wind + 0.08 * lunge;

    // The pickaxe carries at a side angle and chops inward around the palm.
    let swingX = 0, swingY = 0, swingZ = 0, swingRx = 0, swingRy = 0, swingRz = 0;
    if (this._swingT > 0) {
      this._swingT = Math.max(0, this._swingT - elapsed);
      const pose = pickaxeSwingPose(1 - this._swingT / SWING_S, this._swingContact);
      swingX = pose.x; swingY = pose.y; swingZ = pose.z;
      swingRx = pose.rx; swingRy = pose.ry; swingRz = pose.rz;
    }

    /* sprint cant + counter-roll + inertia roll composition */
    const proneMotion = Math.sin(Math.PI * Math.max(0, Math.min(1, ctx.proneT || 0)));
    this._vaultDip = vaultBlend;
    const carry = this._sprint * (1 - adsE) * (1 - vaultBlend);
    const aimYaw = ctx.weaponAim?.yaw ?? turn.yaw;
    const aimPitch = ctx.weaponAim?.pitch ?? turn.pitch - SPRINT_AIM_DIP * this._sprint * (1 - adsE);
    const cant = BOB.sprintTiltZ * carry;
    const roll = bobX / (BOB.walkHorz || 1) * BOB.counterRoll * (1 - adsE * 0.5)
      + turn.roll
      + this._lean.p * BOB.leanRollPerMeter;
    const motor = this._id === 'minigun' ? (this._minigunState?.spin || 0) : 0;
    const pressure = this._id === 'flamethrower' && this._flameActive ? 1 : 0;
    const machineTremor = Math.sin(this._now * (35 + motor * 55)) * motor * 0.0012;

    /* ---------- compose transforms (condition offsets never touch the authoritative camera) ---------- */
    this.posG.position.set(
      turn.x + this._lean.p + bobX + tremorX + machineTremor,
      turn.y + bobY + this._air.p + breathe + exhaustedBreath + tremorY + Math.sin(this._now * 43) * pressure * 0.0008,
      this._spr.push.p + this._surge.p + pressure * 0.006
    );
    // World-space yaw/pitch offsets are not camera-local Euler offsets when the
    // player looks steeply up/down. Transform the actual shot orientation back
    // into camera space, then layer the short decorative recoil/carry motion.
    this.camera.getWorldQuaternion(this._cameraQ);
    this._aimEuler.setFromQuaternion(this._cameraQ, 'YXZ');
    const shotYaw = Number.isFinite(ctx.shotYaw) ? ctx.shotYaw : this._aimEuler.y + aimYaw;
    const shotPitch = Number.isFinite(ctx.shotPitch) ? ctx.shotPitch : this._aimEuler.x + aimPitch;
    this._aimQ.setFromEuler(this._aimEuler.set(shotPitch, shotYaw, 0, 'YXZ'));
    this._aimQ.premultiply(this._cameraQ.invert());
    this._cosmeticQ.setFromEuler(this._aimEuler.set(
      this._spr.pitch.p + this._air.p * BOB.airPitchPerMeter + conditionPitch,
      this._spr.yaw.p + conditionYaw,
      roll + cant + nadeRz, 'YXZ'));
    this.pivot.quaternion.copy(this._aimQ).multiply(this._cosmeticQ);

    /* base hip pose eased toward adsOffset absolute pose; dips layered on top */
    const dep = this._deployOffset();
    this.content.position.set(
      HIP.x + (T.adsOffset.x - HIP.x) * adsE + nadeX + swingX + (dep.x || 0) - carry * 0.055 + (actionMotion.x || 0),
      HIP.y + (T.adsOffset.y - HIP.y) * adsE + reloadDip + dep.y + nadeY + swingY - this._vaultDip * 0.55 - proneMotion * 0.12 - carry * 0.065,
      HIP.z + (T.adsOffset.z - HIP.z) * adsE + nadeZ + swingZ + (dep.z || 0) + carry * 0.045 + vaultBlend * 0.1 + (actionMotion.push || 0)
    );
    this.content.rotation.set(dep.rx + reloadRock + nadeRx + swingRx - this._vaultDip * 0.65 - proneMotion * 0.22,
      swingRy + (this._id === 'knife' ? PICKAXE_CARRY_YAW : 0) + (dep.ry || 0) + (actionMotion.yaw || 0),
      swingRz + (this._id === 'knife' ? PICKAXE_CARRY_ROLL : 0) + (dep.rz || 0) + this._vaultDip * 0.18 + (actionMotion.roll || 0));

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

  _springTo(s, target, k, c, h) {
    s.v += (-k * (s.p - target) - c * s.v) * h;
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

  get flashLight() { return this._cur?.flash.light || null; }

  _uniSet(glow, heat) {
    if (!this._cur) return;
    this._cur.uni.uGlow.value = glow; this._cur.uni.uHeat.value = heat;
  }

  _decayFx(dt, cur) {
    if (!cur) return;
    const u = cur.uni;
    const tauG = Math.max(0.004, cur.T.rechargeDur / 3);
    u.uGlow.value *= Math.exp(-dt / tauG);
    // A held charge keeps the coils lit at the charge level (plus a fast flicker near full).
    if (this._chargeT > 0) {
      const flicker = this._chargeT > 0.85 ? 0.85 + 0.15 * Math.sin(this._now * 90) : 1;
      u.uGlow.value = Math.max(u.uGlow.value, this._chargeT * flicker * (this._id === 'lance' ? 2.5 : 1));
    }
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
    // A growing energy corona at the muzzle accompanies the charging rails.
    if (this._id === 'lance' && this._chargeT > 0) {
      const energy = this._chargeT ** 2;
      const pulse = 0.9 + 0.1 * Math.sin(this._now * (14 + 36 * energy));
      this._chargeOrb.visible = true;
      this._chargeOrb.scale.setScalar((0.25 + energy * 1.8) * pulse);
      this._chargeOrb.rotation.set(this._now * 2, this._now * 3, this._now * 4);
      for (const mesh of this._chargeOrb.children) mesh.material.opacity = (0.25 + energy * 0.6) * pulse;
      cur.flash.light.intensity = 0.2 + energy * 2.8 * pulse;
    } else if (this._flashT < 0 && this._lightT < 0) {
      cur.flash.grp.visible = false;
      cur.flash.light.intensity = 0;
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
    if (this._swap) {
      const t = this._smooth01(Math.min(1, this._swap.elapsed / this._swap.holster));
      return { x: 0.22 * t, y: -0.72 * t, z: 0.18 * t,
        rx: -0.65 * t, ry: 0.3 * t, rz: -0.65 * t };
    }
    const p = this._depT;
    if (this._swapDraw && p < 1) {
      const t = this._smooth01(Math.min(1, p / 0.86));
      const settle = Math.sin(Math.max(0, (p - 0.75) / 0.25) * Math.PI) * 0.014;
      return { x: 0.16 * (1 - t), y: -0.72 * (1 - t) + settle,
        z: 0.18 * (1 - t), rx: -0.55 * (1 - t), ry: -0.2 * (1 - t), rz: -0.4 * (1 - t) };
    }
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
