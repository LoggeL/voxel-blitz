// SB-1 SUDSBLASTER HUD: the rise ladder above the crosshair and the "soaked" vignette.
// Both read authoritative inputs only: the ladder angles come from the shared bubble
// flight model (bubbleProfile/bubbleAimDrop at the live hold charge) and the soak window
// is the `soak` ms the server put on the hit event. Styles: styles/bubble-hud.css.
import { bubbleAimDrop, bubbleProfile } from '../../../shared/bubble-rules.js';
import { el } from './hud-support.js';

// Soap Shot marks at 15/20/25 m slide toward the Big-Bubble ones at 8/10/12 m while charging.
const LADDER_SMALL_M = Object.freeze([15, 20, 25]);
const LADDER_BIG_M = Object.freeze([8, 10, 12]);
const SOAK_FADE_MS = 250;
const SOAK_OPACITY = 0.35;
const SOAK_LABEL_MS = 1000;
const SOAK_BUBBLES = 6;

/**
 * Screen pixels above the crosshair for a mark `distance` metres out: the angle the shot
 * must be aimed below the target, projected with the vertical field of view. Null when the
 * profile cannot reach that far (the mark disappears).
 */
export function bubbleLadderOffsetPx(profile, distance, fovDeg = 75, heightPx = 800) {
  const drop = bubbleAimDrop(profile, distance);
  if (drop === null || !(drop > 0)) return null;
  const focal = heightPx / (2 * Math.tan((Number(fovDeg) || 75) * Math.PI / 360));
  return Math.tan(drop) * focal;
}

/** The three ladder marks `{ distance, px }` for a hold charge (px null = out of reach). */
export function bubbleLadderMarks(charge01 = 0, fovDeg = 75, heightPx = 800) {
  const profile = bubbleProfile(charge01);
  return LADDER_SMALL_M.map((small, i) => {
    const distance = Math.round(small + (LADDER_BIG_M[i] - small) * profile.mix);
    return { distance, px: bubbleLadderOffsetPx(profile, distance, fovDeg, heightPx) };
  });
}

export class BubbleHud {
  build(hud, crosshair) {
    this.dispose();
    this.ladder = el('div', 'vb-bubble-ladder', crosshair, 'bubble-ladder');
    this.ladder.setAttribute('aria-hidden', 'true');
    this.ladder.hidden = true;
    this.marks = LADDER_SMALL_M.map(() => {
      const mark = el('i', 'vb-bubble-mark', this.ladder);
      const label = el('span', '', mark);
      return { mark, label, px: undefined, distance: undefined };
    });
    this.vignette = el('div', 'vb-soap-vignette', hud, 'soap-vignette');
    this.vignette.setAttribute('aria-hidden', 'true');
    this.vignette.hidden = true;
    for (let i = 0; i < SOAK_BUBBLES; i++) {
      const bubble = el('i', 'vb-soap-bubble', this.vignette);
      bubble.style.setProperty('--i', String(i));
    }
    this.label = el('div', 'vb-soap-label', hud, 'soap-label');
    this.label.textContent = 'SOAKED';
    this.label.hidden = true;
    this.soakUntil = 0;
    this.labelUntil = 0;
    this.shownOpacity = null;
    this.ladderKey = null;
  }

  /** A bubble pop soaked the local player for `ms` (the server's `evHit.soak`). */
  soak(ms, now = performance.now()) {
    if (!(Number(ms) > 0)) return;
    this.soakUntil = Math.max(this.soakUntil || 0, now + Number(ms));
    // A chained soak replays the SOAKED cue: its one-shot CSS animation ends at
    // opacity 0, so restart it rather than leave a visible but transparent label.
    if (this.label && !this.label.hidden) {
      this.label.style.animation = 'none';
      void this.label.offsetWidth;
      this.label.style.animation = '';
    }
    this.labelUntil = now + SOAK_LABEL_MS;
    this._paintSoak(now);
  }

  /** Per-frame: `key` is the drawn weapon id, `s` the gameplay HUD state. */
  update(s, key, alive, now = performance.now()) {
    if (!this.ladder) return;
    const equipped = alive && key === 'bubble';
    const charge = equipped ? Math.max(0, Math.min(1, Number(s.charge01) || 0)) : 0;
    const fov = Number(s.crosshairFov) || 75;
    const height = Number(s.crosshairHeight) || 800;
    const ladderKey = equipped ? `${charge.toFixed(2)}|${fov}|${height}` : 'off';
    if (ladderKey !== this.ladderKey) {
      this.ladderKey = ladderKey;
      this.ladder.hidden = !equipped;
      if (equipped) {
        const marks = bubbleLadderMarks(charge, fov, height);
        marks.forEach(({ distance, px }, i) => {
          const view = this.marks[i];
          view.mark.hidden = px === null;
          if (px !== null && px !== view.px) view.mark.style.transform = `translate(-50%, ${(-px).toFixed(1)}px)`;
          if (distance !== view.distance) view.label.textContent = String(distance);
          view.px = px;
          view.distance = distance;
        });
      }
    }
    if (!alive && this.soakUntil > now) this.soakUntil = this.labelUntil = 0;
    this._paintSoak(now);
  }

  _paintSoak(now) {
    if (!this.vignette) return;
    const remaining = this.soakUntil - now;
    const opacity = remaining > 0 ? SOAK_OPACITY * Math.min(1, remaining / SOAK_FADE_MS) : 0;
    const rounded = Math.round(opacity * 1000) / 1000;
    if (rounded !== this.shownOpacity) {
      this.shownOpacity = rounded;
      this.vignette.hidden = rounded <= 0;
      this.vignette.style.opacity = String(rounded);
    }
    const label = now < this.labelUntil && remaining > 0;
    if (this.label.hidden === label) this.label.hidden = !label;
  }

  dispose() {
    this.ladder?.remove();
    this.vignette?.remove();
    this.label?.remove();
    this.ladder = this.vignette = this.label = null;
    this.marks = [];
  }
}
