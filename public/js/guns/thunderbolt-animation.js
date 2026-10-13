import { displaySettings } from '../ui/display-settings.js';

// TB-4 presentation only. WeaponState owns ammunition and reload completion.
export const THUNDERBOLT_INDEX_SECONDS = 0.3;
export const THUNDERBOLT_CONTACT_SECONDS = Object.freeze([0.06, 0.17, THUNDERBOLT_INDEX_SECONDS]);
const QUARTER_TURN = Math.PI / 2;
const ROUND_COUNT = 4;
const ease = (value) => value * value * (3 - 2 * value);
const count = (value, fallback = ROUND_COUNT) => Number.isFinite(value)
  ? Math.max(0, Math.min(ROUND_COUNT, Math.trunc(value))) : fallback;
const angleFor = (mag) => (ROUND_COUNT - mag) * QUARTER_TURN;

export class ThunderboltAnimation {
  constructor(parts, onContact = () => {}) {
    this.parts = parts;
    this.onContact = onContact;
    this.mag = ROUND_COUNT;
    this.reloading = false;
    this.shot = null;
    this.home = null;
    this.pulse = 0;
    this.energyScale = parts.energy?.scale.clone();
    this.emissive = parts.pulseMaterial?.emissiveIntensity ?? 1;
    this.reset();
  }

  /** Redrawing clears motion but never fills a partially spent drum. */
  reset(state = null) {
    this.mag = count(state?.mag, this.mag);
    this.reloading = !!state?.reloading;
    this.shot = null;
    this.home = null;
    this.pulse = 0;
    this.parts.rotor.rotation.z = angleFor(this.mag);
    this._pose();
  }

  /** Repeated snapshots are idempotent; corrections cancel the predicted index. */
  setState(state) {
    if (!state) return;
    const next = count(state.mag, this.mag);
    const reloading = !!state.reloading;
    if (reloading && !this.reloading) this.reload();
    if (!reloading && this.reloading) {
      this.home = null;
      this.shot = null;
      this.parts.rotor.rotation.z = angleFor(next);
    }
    this.reloading = reloading;
    const shot = this.shot;
    if (shot) {
      if (next === shot.expectedMag) shot.confirmed = true;
      else if (next !== shot.fromMag || shot.confirmed) {
        this.shot = null;
        this.pulse = 0;
        this.parts.rotor.rotation.z = angleFor(next);
      }
    } else if (!reloading && next !== this.mag) {
      this.parts.rotor.rotation.z = angleFor(next);
    }
    this.mag = next;
    this._pose();
  }

  /** An accepted shot starts the mechanism; the following state supplies consumption. */
  fire() {
    if (this.reloading || this.mag <= 0) return false;
    this.home = null;
    this.shot = { fromMag: this.mag, expectedMag: this.mag - 1, confirmed: false,
      elapsed: 0, contact: 0, fromAngle: angleFor(this.mag), toAngle: angleFor(this.mag - 1) };
    this.parts.rotor.rotation.z = this.shot.fromAngle;
    this.pulse = 1;
    this._pose();
    return true;
  }

  /** The empty carrier returns home; no timer here creates replacement orbs. */
  reload() {
    if (this.reloading) return;
    this.reloading = true;
    this.shot = null;
    this.pulse = 0;
    this.home = { elapsed: 0, fromAngle: this.parts.rotor.rotation.z };
    this._pose();
  }

  cancelReload() { this.reset({ mag: this.mag, reloading: false }); }

  update(elapsed, { reducedMotion = displaySettings().reducedMotion } = {}) {
    const dt = Math.max(0, Number(elapsed) || 0);
    this.parts.plasma?.update(dt, { reducedMotion });
    if (this.shot) {
      const shot = this.shot;
      shot.elapsed = Math.min(THUNDERBOLT_INDEX_SECONDS, shot.elapsed + dt);
      const phase = shot.elapsed / THUNDERBOLT_INDEX_SECONDS;
      this.pulse = 1 - phase;
      if (shot.confirmed) {
        // A brief discharge pause precedes the visible quarter turn.
        const turn = ease(Math.max(0, Math.min(1, (phase - 0.12) / 0.88)));
        this.parts.rotor.rotation.z = shot.fromAngle + (shot.toAngle - shot.fromAngle) * turn;
        while (shot.contact < THUNDERBOLT_CONTACT_SECONDS.length &&
            shot.elapsed + 1e-9 >= THUNDERBOLT_CONTACT_SECONDS[shot.contact]) {
          this.onContact(++shot.contact);
        }
      }
      if (phase >= 1) {
        this.parts.rotor.rotation.z = angleFor(this.mag);
        this.shot = null;
      }
    }
    if (this.home) {
      this.home.elapsed = Math.min(THUNDERBOLT_INDEX_SECONDS, this.home.elapsed + dt);
      const phase = this.home.elapsed / THUNDERBOLT_INDEX_SECONDS;
      this.parts.rotor.rotation.z = this.home.fromAngle * (1 - ease(phase));
      if (phase >= 1) this.home = null;
    }
    this._pose();
  }

  _pose() {
    // Slots leave in firing order, retaining a visible gap for every spent orb.
    const spent = ROUND_COUNT - this.mag;
    for (let index = 0; index < this.parts.rounds.length; index++) {
      this.parts.rounds[index].visible = index >= spent;
    }
    const live = this.mag > 0 && !this.reloading;
    if (this.parts.energy) {
      this.parts.energy.visible = live || this.pulse > 0;
      this.parts.energy.scale.copy(this.energyScale).multiplyScalar(1 + this.pulse * 0.35);
    }
    if (this.parts.arcs) this.parts.arcs.visible = this.pulse > 0.04;
    if (this.parts.pulseMaterial) this.parts.pulseMaterial.emissiveIntensity = this.emissive + this.pulse * 3;
    this.parts.plasma?.setPulse(this.pulse);
  }
}

export function thunderboltAnimationFor(model, onContact = null) {
  const parts = model?.extra.userData.thunderbolt;
  if (!parts?.rotor || !Array.isArray(parts.rounds)) return null;
  const animation = parts.animation || (parts.animation = new ThunderboltAnimation(parts));
  if (onContact) animation.onContact = onContact;
  return animation;
}
