// GV-4 RIPTIDE presentation: the per-shot disc states on a built glaive bundle. The
// authoritative game state (discs in hand, the `caught` explode event, fabricate
// progress) arrives through setDiscs()/caught(); nothing here decides gameplay. Shared by
// the first-person rig and the remote avatar mount, so both show the same horn clamp.
//
// States: THROW (seated disc spins out and hides, flywheel whirls, cassette lift if a
// spare exists), RETURN (horns flare 22 deg, prongs brighten, a small view tilt), CATCH
// (disc slides home from the front, horns clamp, 3 cm bump), EMPTY (bare spindle, horns
// half-open), FABRICATE (cassette strip + gauge needle sweep, then the cassette lift).
// The throw/catch slide shrinks the disc so its rim clears the horn hinge pins; the
// cassette lift shrinks the spare in its cage and grows the next disc on the seat, so
// no disc ever passes through the rail, spindle or arbor pin.
import { WEAPONS } from '../../../shared/combatmath.js';

const D2R = Math.PI / 180;
const RULES = WEAPONS.glaive.glaive;
const THROW_S = 0.12;          // seated disc spins and slides out, then hides
const THROW_Z = -0.18;
const SLIDE_SCALE_END = 0.25;  // disc scale at the end of the throw slide (hinge-pin clearance)
const SLIDE_SHRINK_RATE = 2.4; // reaches SLIDE_SCALE_END by 42 % of the slide, before the hinge knuckles
const LIFT_S = 0.22;           // cassette disc rises onto the spindle
const FLARE_S = 0.12;          // horns flare on the return leg
const FLARE_RAD = 22 * D2R;
const EMPTY_RAD = 11 * D2R;
const CATCH_S = 0.18;          // caught disc slides home
const CLAMP_S = 0.08;
const BUMP_M = 0.03;
const BUMP_S = 0.15;
const TILT_RAD = 3 * D2R;
const GAIN_GRACE_S = 0.15;     // a mag gain without a catch event in this window = fabricate/pickup
const STALE_S = 0.35;          // snapshots this soon after a throw may predate it
const RETURN_HOLD_S = 1.2;     // flare/tilt fade out if no catch confirms the return
const GLOW_BY_DISCS = [0.08, 0.45, 1.0];

const smooth = (t) => { const u = Math.max(0, Math.min(1, t)); return u * u * (3 - 2 * u); };

export class GlaivePresentation {
  constructor(model) {
    this.model = model;
    this.parts = model?.extra?.userData?.glaive || null;
    this.reset();
  }

  get ready() { return !!this.parts; }

  /** Snap to the resting pose for `discs` in hand (weapon draw, respawn, mode reset). */
  reset(discs) {
    this.magSize = this.magSize || WEAPONS.glaive.magSize;
    this.discs = Math.max(0, Math.min(this.magSize, Number.isFinite(discs) ? discs : this.magSize));
    this.fab01 = null;
    this.time = 0;
    this.throwT = null;      // seconds since the last throw
    this.sinceThrow = Infinity;
    this.liftT = null;       // seconds into the cassette lift
    this.catchT = null;      // seconds since the authoritative catch
    this.returnT = null;     // seconds since the return leg started
    this.returnAt = [];      // pending automatic flips (seconds on this clock)
    this.gainT = null;       // unexplained mag gain waiting for a catch event
    this.motor = 1;
    this.flywheelAngle = 0;
    this.tiltX = 0;          // -1..1 screen side of the incoming disc
    this.snapNext = true;    // the first authoritative count after a reset is not a gain
  }

  /** Authoritative discs in hand (mag) plus optional fabricate progress 0..1. */
  setDiscs(discs, magSize = this.magSize, fab01 = null) {
    if (Number.isFinite(magSize) && magSize > 0) this.magSize = magSize;
    const next = Math.max(0, Math.min(this.magSize, Math.trunc(Number(discs) || 0)));
    this.fab01 = Number.isFinite(fab01) ? Math.max(0, Math.min(1, fab01)) : null;
    // A snapshot older than the throw still counts the thrown disc; only a later gain is real.
    // The first count after a reset (draw, respawn) only corrects a stale cached value.
    if (next > this.discs && !this.snapNext && this.catchT === null && this.sinceThrow > STALE_S) this.gainT = 0;
    this.snapNext = false;
    this.discs = next;
  }

  /** An accepted local throw. `outMs` follows the (Chaos-modified) out leg. */
  throw(outMs = RULES.outMs) {
    this.throwT = 0;
    this.sinceThrow = 0;
    this.liftT = null;
    this.catchT = null;
    this.discs = Math.max(0, this.discs - 1);
    this.motor = 0.35;
    this.returnAt.push(this.time + outMs / 1000);
  }

  /**
   * R (returnDiscs) flips every disc out; an observed single flip (`all:false`) stands
   * in for the oldest local flip timer, so the timer never flares a second time.
   */
  returnLeg({ screenX = 0, all = true } = {}) {
    if (all) this.returnAt.length = 0;
    else this.returnAt.shift();
    this._flare(screenX);
  }

  _flare(screenX) {
    // Already returning: keep the horns open and restart the hold instead of re-closing.
    this.returnT = this.returnT === null ? 0 : Math.min(this.returnT, FLARE_S);
    this.tiltX = Math.max(-1, Math.min(1, Number(screenX) || 0));
  }

  /** The authoritative `caught:true` explode event for one of this player's discs. */
  caught() {
    // A disc caught before its timed flip must not flare the horns afterwards.
    this.returnAt.shift();
    this.catchT = 0;
    this.gainT = null;
    this.returnT = null;
    this.throwT = null;
    this.liftT = null;
    this.motor = Math.max(this.motor, 0.7);
  }

  /**
   * Advance and pose. Returns the camera-local offsets the rig layers on the carried pose:
   * `pushZ` (catch bump, metres, +z back), `tiltYaw`/`tiltPitch` (radians), `motor` 0..1.
   */
  update(dt) {
    const out = { pushZ: 0, tiltYaw: 0, tiltPitch: 0, motor: this.motor };
    const parts = this.parts;
    const step = Math.max(0, Math.min(0.25, Number(dt) || 0));
    this.time += step;
    this.sinceThrow += step;
    if (this.returnAt.length && this.time >= this.returnAt[0]) {
      this.returnAt.shift();
      this._flare(this.tiltX);
    }
    if (this.throwT !== null) {
      this.throwT += step;
      if (this.throwT >= THROW_S) {
        this.throwT = null;
        if (this.discs > 0) this.liftT = 0;
      }
    }
    if (this.liftT !== null) {
      this.liftT += step;
      if (this.liftT >= LIFT_S) this.liftT = null;
    }
    if (this.catchT !== null) {
      this.catchT += step;
      if (this.catchT >= CATCH_S + BUMP_S) this.catchT = null;
    }
    if (this.returnT !== null) {
      this.returnT += step;
      if (this.returnT >= RETURN_HOLD_S) this.returnT = null;
    }
    if (this.gainT !== null) {
      this.gainT += step;
      if (this.gainT >= GAIN_GRACE_S) { this.gainT = null; this.liftT = 0; }
    }
    this.motor += (1 - this.motor) * (1 - Math.exp(-step * 3));
    out.motor = this.motor;
    if (!parts) return out;

    // Seated disc: throw (spin + slide out, hide), cassette lift, catch slide-in, else rest.
    const { disc, discSpin, spare, flywheel, needle } = parts;
    const lifting = this.liftT !== null;
    const catching = this.catchT !== null && this.catchT < CATCH_S;
    const lift = lifting ? this.liftT / LIFT_S : 0;
    if (disc) {
      let slide = 0, visible = this.discs > 0 && !lifting, spin = 0, scale = 1;
      if (this.throwT !== null) {
        const u = this.throwT / THROW_S;
        slide = smooth(u);
        spin = u * Math.PI * 3;
        visible = true;
      } else if (catching) {
        const u = this.catchT / CATCH_S;
        slide = 1 - smooth(u);
        spin = (1 - u) * Math.PI * 2;
        visible = true;
      } else if (lifting && lift > 0.5) {
        // Second half of the lift: the next disc grows onto the seat inside its own footprint.
        scale = Math.max(0.05, smooth((lift - 0.5) * 2));
        spin = (1 - scale) * Math.PI;
        visible = true;
      }
      // Shrinking as it slides keeps the rim inside the gap between the hinge pins.
      if (slide > 0) scale = 1 - (1 - SLIDE_SCALE_END) * Math.min(1, slide * SLIDE_SHRINK_RATE);
      const z = THROW_Z * slide;
      disc.position.set(parts.seat.x, parts.seat.y + Math.sin(parts.tilt) * -z, parts.seat.z + z * Math.cos(parts.tilt));
      disc.scale.setScalar(scale);
      disc.visible = visible;
      if (discSpin) discSpin.rotation.y = spin;
    }
    if (spare) {
      const home = spare.userData.homePosition;
      if (home) spare.position.copy(home);
      spare.rotation.x = 0;
      if (lifting) {
        // First half of the lift: the spare shrinks away inside the cassette cage.
        const u = Math.min(1, lift * 2);
        spare.scale.setScalar(Math.max(0.05, 1 - smooth(u)));
        spare.visible = u < 1;
      } else {
        spare.scale.setScalar(1);
        // The cassette holds the next disc whenever a second one is in hand.
        spare.visible = this.discs >= 2;
      }
    }

    // Flywheel whirl: motor 1 while armed, dips on the throw and spins back up.
    this.flywheelAngle += step * (6 + 30 * this.motor);
    if (flywheel) flywheel.rotation.z = this.flywheelAngle;

    // Horns: flare on the return leg, clamp on the catch, half-open when empty.
    let flare = this.discs === 0 ? EMPTY_RAD : 0;
    let returnGlow = 0;
    if (this.returnT !== null) {
      const open = smooth(this.returnT / FLARE_S);
      const fade = this.returnT > RETURN_HOLD_S - 0.3 ? smooth((RETURN_HOLD_S - this.returnT) / 0.3) : 1;
      flare = Math.max(flare, FLARE_RAD * open * fade);
      returnGlow = open * fade;
    }
    if (this.catchT !== null) {
      const clamp = smooth(this.catchT / CLAMP_S);
      flare = FLARE_RAD * (1 - clamp);
    }
    for (const { pivot, side } of parts.horns) pivot.rotation.y = -side * flare;

    // Razor glow follows discs in hand; prongs brighten with the return leg.
    const glowIndex = Math.min(GLOW_BY_DISCS.length - 1, this.discs);
    const discGlow = GLOW_BY_DISCS[glowIndex];
    for (const material of parts.glow) material.emissiveIntensity = material.userData.baseEmissive * discGlow;
    for (const material of parts.hornGlow) {
      material.emissiveIntensity = material.userData.baseEmissive * (0.5 + 1.5 * returnGlow);
    }
    // Fabricate: strip and needle track authoritative progress when the snapshot carries it,
    // otherwise the needle reads flywheel RPM and the strip idles dim.
    const fab = this.fab01;
    for (const material of parts.strip) {
      material.emissiveIntensity = material.userData.baseEmissive * (fab === null ? 1 : 1 + 9 * fab);
    }
    if (needle) needle.rotation.x = -1.1 + 2.2 * (fab === null ? this.motor * 0.8 : fab);

    // Camera-local layers the rig adds: catch bump and the tilt toward the incoming disc.
    if (this.catchT !== null && this.catchT >= CATCH_S - 0.02) {
      out.pushZ = BUMP_M * Math.sin(Math.PI * Math.min(1, (this.catchT - CATCH_S + 0.02) / BUMP_S));
    }
    if (returnGlow > 0) {
      out.tiltYaw = -this.tiltX * TILT_RAD * returnGlow;
      out.tiltPitch = (this.tiltX === 0 ? TILT_RAD * 0.5 : 0) * returnGlow;
    }
    return out;
  }
}

const presentations = new WeakMap();

/** One presentation per built bundle (first-person rig or avatar mount). */
export function glaivePresentationFor(model) {
  if (!model) return null;
  let presentation = presentations.get(model);
  if (!presentation) {
    presentation = new GlaivePresentation(model);
    presentations.set(model, presentation);
  }
  return presentation;
}
