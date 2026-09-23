// SB-1 SUDSBLASTER presentation: the soap film, squeeze bulb and soap tank on a built
// bubble bundle. The authoritative game state (rounds in the tank, the held charge, the
// accepted shot, the reload clock) arrives through setMag()/setCharge()/fire()/reload();
// nothing here decides gameplay. One instance per bundle (bubblePresentationFor).
//
// Hooks: `models/bubble.js` publishes `extra.userData.bubble`. Every entry is optional, so a
// placeholder model with only some of them still animates what it has.
//   bulb      Object3D   squeeze-bulb pivot; animated by scale (squash/stretch).
//   film      Mesh       the flat film disc across the wand ring (a CircleGeometry facing -z).
//                        Its home position is the ring centre; scale.x/y is how far it has formed.
//   bulge     Mesh       film dome that swells forward on a tap. Its depth axis is
//                        `bulge.userData.depthAxis` ('x'|'y'|'z', default 'z').
//   charge    Mesh       unit-radius film sphere grown off the ring while a Big Bubble charges.
//   handoff   Mesh       film sphere that carries the released bubble away from the ring.
//   bead      Mesh       air bead that runs along `beadCurve` from the bulb to the nozzle.
//   beadCurve THREE.Curve (getPointAt) in the bead's parent space.
//   hoseCurve THREE.Curve optional soap-feed path for the reload gulp beads (else beadCurve).
//   suds      Object3D   liquid column pivoted at its bottom; scale.y is the soap level.
//                        `suds.userData.height` is the full column height (default 0.104 m).
//   foam      Object3D   foam cap riding the liquid top (same parent as suds); slosh rolls it.
//   fizz      Object3D[] | Object3D (its children): specks rising inside the liquid (same
//                        parent as suds).
//   tank      Object3D   the screw-in tank inside the mag group; rotation.y is the thread turn.
//   idle      Mesh[]     small film spheres that drift off the ring top while idle.
// Film parts are driven through their material: a `makeSoapFilm` ShaderMaterial (uAlpha,
// uThin, with `userData.baseAlpha/basePhase`) or any transparent material (opacity). Parts
// that fade on their own (handoff, each idle bubble) need their own material.
const RING_R = 0.056;              // wand ring radius (idle bubbles leave from its top)
const SUDS_HEIGHT = 0.104;
const SUDS_FLOOR = 0.12;           // an empty tank still shows a puddle
const SUDS_OMEGA = 12;             // critically damped level spring (rad/s)
const CHARGE_SHOW = 0.05;
const CHARGE_R0 = 0.02;
const CHARGE_R1 = 0.14;
const TREMBLE_AT = 0.9;
const FIRE_S = 0.2;                // the whole shot choreography fits the 200 ms cycle
const SQUASH_S = 0.03;
const SPRING_S = 0.17;
const BEAD_S = 0.06;
const BULGE_S = 0.045;
const REGROW_FROM = 0.06;
const REGROW_TO = 0.19;
const HANDOFF_S = 0.08;
const HANDOFF_Z = 0.25;
const HANDOFF_R = 0.045;
const DRY_S = 0.3;
const DRY_POP = 0.18;
const DEPLOY_FROM = 0.15;
const DEPLOY_TO = 0.36;
const PRIME_S = 0.45;
const IDLE_LIFE = 1.2;
const IDLE_RISE = 0.12;
const SLOSH_RAD = 0.18;
const CANCEL_S = 0.12;

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const smooth = (t) => { const u = clamp01(t); return u * u * (3 - 2 * u); };
const span = (t, a, b) => clamp01((t - a) / (b - a));
/** Ease-out-back: overshoots ~`s`-shaped past 1, then settles. */
const outBack = (t, s = 1.70158) => { const u = clamp01(t) - 1; return 1 + u * u * ((s + 1) * u + s); };

function materialsOf(mesh) {
  const m = mesh?.material;
  return !m ? [] : Array.isArray(m) ? m : [m];
}

export class BubblePresentation {
  constructor(model) {
    this.model = model;
    this.parts = model?.extra?.userData?.bubble || null;
    this.homes = new Map();
    this.filmBase = new Map();
    this._capture();
    this.magSize = 12;
    this.reset();
  }

  get ready() { return !!this.parts; }

  _capture() {
    const parts = this.parts;
    if (!parts) return;
    const nodes = [parts.bulb, parts.film, parts.bulge, parts.charge, parts.handoff, parts.bead,
      parts.suds, parts.foam, parts.tank, ...(parts.idle || []), ...this._fizz()];
    for (const node of nodes) {
      if (!node?.position || this.homes.has(node)) continue;
      this.homes.set(node, { p: node.position.clone(), s: node.scale.clone(), r: node.rotation.clone(),
        visible: node.visible });
    }
    for (const node of [parts.film, parts.bulge, parts.charge, parts.handoff, ...(parts.idle || [])]) {
      for (const material of materialsOf(node)) {
        if (this.filmBase.has(material)) continue;
        this.filmBase.set(material, {
          alpha: material.userData?.baseAlpha ?? material.uniforms?.uAlpha?.value ?? material.opacity ?? 1,
          thin: material.userData?.basePhase ?? material.uniforms?.uThin?.value ?? 0,
        });
      }
    }
  }

  _fizz() {
    const fizz = this.parts?.fizz;
    if (!fizz) return [];
    return Array.isArray(fizz) ? fizz : fizz.children || [];
  }

  /** Snap to the drawn pose (weapon draw, respawn): full film forms over the deploy. */
  reset(mag, magSize) {
    if (Number.isFinite(magSize) && magSize > 0) this.magSize = magSize;
    const level = Number.isFinite(mag) ? this._levelFor(mag) : 1;
    this.level = level;
    this.levelV = 0;
    this.levelTarget = level;
    this.time = 0;
    this.charge = 0;
    this.peakCharge = 0;
    this.pendingRelease = null;  // a charge that just dropped to 0: fire() or a cancel consumes it
    this.cancelT = null;         // seconds into a dropped (unfired) charge deflating
    this.cancelFrom = 0;
    this.fireT = null;           // seconds since the accepted shot
    this.fireCharge = 0;
    this.handoffR = HANDOFF_R;
    this.dryT = null;
    this.deployT = 0;
    this.reloadState = null;     // { t, dur, timeline }
    this.primeT = null;
    this.sloshT = null;
    this.surge = 0;
    this.tilt = 0;
    this.nextIdle = 3;
    this.idleT = (this.parts?.idle || []).map(() => null);
    this.seed = 0x5b1;
  }

  _levelFor(mag) {
    const full = clamp01((Number(mag) || 0) / Math.max(1, this.magSize));
    return SUDS_FLOOR + (1 - SUDS_FLOOR) * full;
  }

  /** Authoritative rounds in the tank; the suds column springs toward the matching level. */
  setMag(mag, magSize = this.magSize) {
    if (Number.isFinite(magSize) && magSize > 0) this.magSize = magSize;
    this.levelTarget = this._levelFor(mag);
  }

  /** Live 0..1 hold charge from WeaponState. A drop to 0 is a release (or a cancel). */
  setCharge(c01) {
    const c = clamp01(Number(c01) || 0);
    if (c > 0) {
      this.peakCharge = Math.max(this.peakCharge, c);
      this.pendingRelease = null;
      this.cancelT = null;
    } else if (this.charge > 0 || this.peakCharge > 0) {
      this.pendingRelease = { charge: this.peakCharge, age: 0 };
      this.peakCharge = 0;
    }
    this.charge = c;
  }

  /** The accepted local shot. `charge01` defaults to the hold that was just released. */
  fire(charge01) {
    const released = this.pendingRelease?.charge ?? 0;
    const charge = clamp01(Number.isFinite(charge01) ? charge01 : released);
    this.pendingRelease = null;
    this.cancelT = null;
    this.peakCharge = 0;
    this.charge = 0;
    this.fireT = 0;
    this.fireCharge = charge;
    this.handoffR = Math.max(HANDOFF_R, charge > CHARGE_SHOW ? this._chargeRadius(charge) : 0);
    this.sloshT = 0;
    this.surge = 1;
    this.dryT = null;
  }

  /** An empty-tank trigger: the bulb squashes, a weak film forms, wobbles and pops. */
  dryFire() {
    if (this.fireT !== null && this.fireT < FIRE_S) return;
    this.dryT = 0;
  }

  /** Reload choreography on the rig clock: `timeline` is TIMERS.bubble.magTimeline. */
  reload(durationS, timeline = null, elapsedS = 0) {
    const dur = Math.max(0.1, Number(durationS) || 2.2);
    this.reloadState = { t: Math.max(0, Number(elapsedS) || 0), dur,
      timeline: timeline || { start: 0.16, home: 0.8, clickAt: 0.9 } };
    this.primeT = null;
    this.pendingRelease = null;
    this.charge = 0;
  }

  /** A shot interrupted the reload: the tank snaps home, the level follows authority again. */
  cancelReload() {
    if (!this.reloadState) return;
    this.reloadState = null;
    this.primeT = 0;
  }

  /** Reload click 3: bulb double-pump, gulp beads along the feed hose, the film re-forms. */
  prime() {
    this.primeT = 0;
    this.surge = 1;
  }

  _chargeRadius(c) { return CHARGE_R0 + CHARGE_R1 * c * c; }

  _rand() {
    // Presentation-only LCG: idle timings vary without touching Math.random.
    this.seed = (Math.imul(this.seed, 1103515245) + 12345) >>> 0;
    return this.seed / 4294967296;
  }

  _setFilm(mesh, alphaMul, thinAdd = 0) {
    for (const material of materialsOf(mesh)) {
      const base = this.filmBase.get(material) || { alpha: 1, thin: 0 };
      const u = material.uniforms;
      if (u?.uAlpha) {
        u.uAlpha.value = base.alpha * alphaMul;
        if (u.uThin) u.uThin.value = base.thin + thinAdd;
      } else if ('opacity' in material) {
        material.opacity = Math.min(1, base.alpha * alphaMul);
      }
    }
  }

  _pose(node, fn) {
    const home = node && this.homes.get(node);
    if (!home) return;
    node.position.copy(home.p);
    node.scale.copy(home.s);
    node.rotation.copy(home.r);
    fn(home);
  }

  /** Reload phase for the film and tank: 0 home, 1 tank out, with the thread turns. */
  _reloadPose() {
    const r = this.reloadState;
    if (!r) return null;
    const frac = r.t / r.dur;
    const { start, home } = r.timeline;
    // Out: unscrew 1.5 turns before the drop. In: screw 1 turn during the final seat.
    const unscrew = span(frac, 0.03, start);
    const screw = span(frac, home - 0.14, home);
    const out = frac >= start && frac < home - 0.14;
    const turn = frac < start ? -Math.PI * 3 * smooth(unscrew)
      : frac < home - 0.14 ? 0 : Math.PI * 2 * (1 - smooth(screw));
    // The film deflates as the tank leaves and stays down until the prime re-forms it.
    const deflate = smooth(span(frac, start, start + 0.14));
    return { frac, turn, out, deflate };
  }

  /**
   * Advance and pose. `speed01` is the sprint blend, `leanX` the rig's lagged strafe lean
   * (metres), `adsT` the eased aim blend.
   */
  update(dt, { speed01 = 0, leanX = 0, adsT = 0 } = {}) {
    const step = Math.max(0, Math.min(0.25, Number(dt) || 0));
    this.time += step;
    this.deployT += step;
    if (this.fireT !== null) { this.fireT += step; if (this.fireT >= FIRE_S + HANDOFF_S) this.fireT = null; }
    if (this.dryT !== null) { this.dryT += step; if (this.dryT >= DRY_S) this.dryT = null; }
    if (this.primeT !== null) { this.primeT += step; if (this.primeT >= PRIME_S) this.primeT = null; }
    if (this.sloshT !== null) { this.sloshT += step; if (this.sloshT >= 1.2) this.sloshT = null; }
    if (this.reloadState) {
      this.reloadState.t += step;
      if (this.reloadState.t >= this.reloadState.dur) this.reloadState = null;
    }
    // A charge that dropped without a shot this frame (swap, reload, block) deflates instead.
    if (this.pendingRelease) {
      this.pendingRelease.age += step;
      if (this.pendingRelease.age > 0.05) {
        this.cancelFrom = this.pendingRelease.charge;
        this.cancelT = 0;
        this.pendingRelease = null;
      }
    }
    if (this.cancelT !== null) { this.cancelT += step; if (this.cancelT >= CANCEL_S) this.cancelT = null; }
    this.surge = Math.max(0, this.surge - step * 2);

    const reload = this._reloadPose();
    // Suds: critically damped toward the authoritative level; the fresh tank enters full.
    if (reload && reload.frac >= this.reloadState.timeline.start + 0.2) {
      this.level = 1; this.levelV = 0;
    } else {
      const w = SUDS_OMEGA;
      const accel = w * w * (this.levelTarget - this.level) - 2 * w * this.levelV;
      this.levelV += accel * step;
      this.level += this.levelV * step;
    }
    this.tilt += (Math.max(-0.25, Math.min(0.25, -leanX * 3)) - this.tilt) * (1 - Math.exp(-step * 6));

    const parts = this.parts;
    if (!parts) return;
    this._poseBulb(parts);
    this._poseFilm(parts, reload, speed01, adsT);
    this._poseBead(parts);
    this._poseTank(parts, reload);
    this._poseIdle(parts, reload, step);
  }

  _poseBulb(parts) {
    this._pose(parts.bulb, () => {
      let sx = 1, sy = 1;
      // Charging squeezes the bulb down progressively.
      const held = this.charge > 0 ? this.charge : 0;
      sy -= 0.3 * held; sx += 0.08 * held;
      const squash = (t) => {
        if (t < SQUASH_S) {
          const u = smooth(t / SQUASH_S);
          return [1 + 0.16 * u, 1 - 0.38 * u];
        }
        const u = outBack(span(t, SQUASH_S, SPRING_S), 2.2);
        return [1.16 + (1 - 1.16) * u, 0.62 + (1 - 0.62) * u];
      };
      let pulse = null;
      if (this.fireT !== null && this.fireT < SPRING_S) pulse = squash(this.fireT);
      else if (this.dryT !== null && this.dryT < SPRING_S) pulse = squash(this.dryT);
      else if (this.primeT !== null) {
        // Double pump: two squeezes 140 ms apart.
        const t = this.primeT < 0.14 ? this.primeT : this.primeT - 0.14;
        if (t < SPRING_S) pulse = squash(t);
      }
      if (pulse) { sx = pulse[0]; sy = pulse[1]; }
      parts.bulb.scale.x *= sx; parts.bulb.scale.z *= sx; parts.bulb.scale.y *= sy;
    });
  }

  _poseFilm(parts, reload, speed01, adsT) {
    const t = this.time;
    // How far the ring film has formed: deploy, reload deflate / prime re-form, shots.
    let form = smooth(span(this.deployT, DEPLOY_FROM, DEPLOY_TO));
    if (reload) form *= 1 - reload.deflate;
    if (this.primeT !== null) form = Math.min(form, outBack(span(this.primeT, 0.2, PRIME_S), 1.4));
    let thin = 0;
    let bulge = 0;
    let wobbleAmp = 0.03 * (speed01 > 0.8 ? 3 : 1);
    const tap = this.fireT !== null && this.fireCharge <= CHARGE_SHOW;
    if (this.fireT !== null) {
      const f = this.fireT;
      if (tap && f < BULGE_S) {
        bulge = smooth(f / BULGE_S);
        thin += 0.6 * bulge;
        wobbleAmp = 0.08;
      } else if (f < REGROW_FROM) {
        form = 0;
      } else if (f < REGROW_TO) {
        const u = span(f, REGROW_FROM, REGROW_TO);
        form = Math.min(form, outBack(u, 1.8));
        thin += 0.5 * (1 - u);
      }
    }
    if (this.dryT !== null) {
      const d = this.dryT;
      if (d < DRY_POP) { bulge = 0.3 * smooth(d / 0.12); wobbleAmp = 0.1; }
      else form = Math.min(form, span(d, DRY_POP + 0.04, DRY_S));
    }
    if (this.primeT !== null && this.primeT > 0.2) thin += 0.8 * (1 - span(this.primeT, 0.2, PRIME_S));
    const breathe = 1 + wobbleAmp * Math.sin(t * Math.PI * 2 * (bulge > 0 ? 40 : 0.8));
    const alpha = 1 - 0.36 * clamp01(adsT);

    if (parts.film) this._pose(parts.film, () => {
      parts.film.visible = form > 0.01;
      parts.film.scale.x *= form * breathe;
      parts.film.scale.y *= form * (2 - breathe);
      this._setFilm(parts.film, alpha, thin);
    });
    if (parts.bulge) this._pose(parts.bulge, () => {
      const axis = parts.bulge.userData?.depthAxis || 'z';
      parts.bulge.visible = bulge > 0.01 && form > 0.01;
      // The dome rests flat (depth ~0.001); a model authored at full depth scales from 1.
      const unit = parts.bulge.scale[axis] > 0.01 ? parts.bulge.scale[axis] : 1;
      parts.bulge.scale[axis] = Math.max(0.001, unit * bulge * breathe);
      this._setFilm(parts.bulge, alpha, thin);
    });

    // Big Bubble: the film swells forward off the ring; a dropped charge deflates back.
    const ring = this.homes.get(parts.film)?.p;
    if (parts.charge) this._pose(parts.charge, (home) => {
      let c = this.charge;
      if (this.cancelT !== null) c = this.cancelFrom * (1 - smooth(this.cancelT / CANCEL_S));
      const show = c > CHARGE_SHOW && !reload;
      parts.charge.visible = show;
      if (!show) return;
      const r = this._chargeRadius(c);
      const tremble = c >= TREMBLE_AT ? 3 : 1;
      const w = 0.06 * tremble * Math.sin(t * Math.PI * 2 * 7);
      const k = r / (parts.charge.geometry?.parameters?.radius || 1);
      parts.charge.scale.set(k * (1 + w), k * (1 - w), k * (1 + 0.7 * w));
      const base = ring || home.p;
      const jitter = c >= TREMBLE_AT ? 0.0015 : 0;
      parts.charge.position.set(base.x + jitter * Math.sin(t * Math.PI * 80),
        base.y + jitter * Math.cos(t * Math.PI * 80 + 1), base.z - r);
      // Pink -> cyan -> gold as it swells.
      this._setFilm(parts.charge, alpha * (0.8 + 0.3 * c), 1.1 * c);
    });

    // Release: the handoff sphere carries the bubble off the ring and fades into the world one.
    if (parts.handoff) this._pose(parts.handoff, (home) => {
      const start = this.fireT === null ? null : tap ? BULGE_S : 0;
      const u = start === null ? -1 : (this.fireT - start) / HANDOFF_S;
      parts.handoff.visible = u >= 0 && u < 1;
      if (!parts.handoff.visible) return;
      const base = ring || home.p;
      const r = this.handoffR * (1 + 0.33 * u);
      parts.handoff.scale.setScalar(r / (parts.handoff.geometry?.parameters?.radius || HANDOFF_R));
      parts.handoff.position.set(base.x, base.y, base.z - r - HANDOFF_Z * smooth(u));
      this._setFilm(parts.handoff, alpha * (1 - u), 0.3);
    });
  }

  _poseBead(parts) {
    const bead = parts.bead;
    if (!bead) return;
    this._pose(bead, () => {
      let u = -1, curve = parts.beadCurve;
      if (this.fireT !== null && this.fireT < BEAD_S) u = this.fireT / BEAD_S;
      else if (this.primeT !== null && this.primeT < 0.3) {
        // Three gulp beads run the soap feed one after another.
        const k = this.primeT / 0.1;
        u = k - Math.floor(k);
        if (u > 0.8) u = -1; else u /= 0.8;
        curve = parts.hoseCurve || parts.beadCurve;
      }
      bead.visible = u >= 0 && !!curve?.getPointAt;
      if (bead.visible) curve.getPointAt(clamp01(u), bead.position);
    });
  }

  _poseTank(parts, reload) {
    const level = Math.max(0.001, this.level);
    const sudsHome = this.homes.get(parts.suds);
    const height = parts.suds?.userData?.height || SUDS_HEIGHT;
    if (parts.suds) this._pose(parts.suds, () => {
      parts.suds.scale.y *= level;
      parts.suds.rotation.z += this.tilt;
    });
    const slosh = this.sloshT === null ? 0
      : SLOSH_RAD * Math.sin(this.sloshT * Math.PI * 2 * 6) * Math.exp(-this.sloshT * 5);
    if (parts.foam) this._pose(parts.foam, (home) => {
      const scaleY = sudsHome ? sudsHome.s.y : 1;
      parts.foam.position.y = home.p.y - (1 - level) * height * scaleY;
      parts.foam.rotation.z += slosh + this.tilt;
      parts.foam.visible = home.visible && level > SUDS_FLOOR + 0.01;
    });
    // Fizz specks rise from the tank floor to the liquid top, faster after a shot.
    const fizz = this._fizz();
    if (fizz.length && sudsHome) {
      const floor = sudsHome.p.y + 0.004;
      const top = sudsHome.p.y + height * sudsHome.s.y * level - 0.004;
      const rise = Math.max(0.001, top - floor);
      for (let i = 0; i < fizz.length; i++) {
        const speck = fizz[i];
        this._pose(speck, (home) => {
          const speed = 0.35 + 0.1 * i + 1.6 * this.surge;
          const u = (this.time * speed * 0.3 + i / fizz.length) % 1;
          speck.position.y = floor + rise * u;
          speck.position.x = home.p.x + 0.002 * Math.sin(this.time * 9 + i * 2);
          speck.visible = home.visible && rise > 0.01;
        });
      }
    }
    if (parts.tank) this._pose(parts.tank, () => {
      if (reload) parts.tank.rotation.y += reload.turn;
    });
  }

  _poseIdle(parts, reload, step) {
    const idle = parts.idle || [];
    if (!idle.length) return;
    const ring = this.homes.get(parts.film)?.p;
    this.nextIdle -= step;
    if (this.nextIdle <= 0 && !reload && this.charge === 0) {
      this.nextIdle = 3 + 3 * this._rand();
      const slot = this.idleT.findIndex((v) => v === null);
      if (slot >= 0) this.idleT[slot] = 0;
    }
    for (let i = 0; i < idle.length; i++) {
      const node = idle[i];
      this._pose(node, (home) => {
        const t = this.idleT[i];
        node.visible = t !== null;
        if (t === null) return;
        const next = t + step;
        this.idleT[i] = next >= IDLE_LIFE ? null : next;
        const u = next / IDLE_LIFE;
        const base = ring || home.p;
        node.position.set(base.x + 0.008 * Math.sin(next * 5 + i), base.y + RING_R + IDLE_RISE * smooth(u),
          base.z + 0.01 * u);
        this._setFilm(node, 1 - smooth(span(u, 0.6, 1)), 0.4 * u);
      });
    }
  }
}

const presentations = new WeakMap();

/** One presentation per built bundle (first-person rig or avatar mount). */
export function bubblePresentationFor(model) {
  if (!model) return null;
  let presentation = presentations.get(model);
  if (!presentation) {
    presentation = new BubblePresentation(model);
    presentations.set(model, presentation);
  }
  return presentation;
}
