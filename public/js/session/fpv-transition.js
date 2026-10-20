/**
 * The FPV drone's launch and link-loss presentation (docs/conquest.md "FPV
 * drone", design docs/design/conquest/fpv-handset/). Client presentation
 * only: the server's drone timing is untouched, and the drone flies (and takes
 * the keys) from the first snapshot that carries it.
 *
 *   idle ─launch→ raise ─→ boot ─→ feed ─link gone→ lost ─→ lower ─→ idle
 *
 * raise  the operator lifts the handset to the camera (the body camera, the
 *        weapon stowed);
 * boot   the camera is in the drone, the feed comes up out of full static;
 * feed   the drone feed (fpv-feed.js);
 * lost   SIGNAL LOST over heavy static on the last drone frame (detonation,
 *        shoot-down, range, battery or the operator cutting the link);
 * lower  the body camera again, the handset drops away, then the weapon draws.
 *
 * A drone that ends during the raise skips SIGNAL LOST (the feed never came
 * up) and the handset lowers from where it was. Death drops the sequence at
 * once (the death camera takes over). Reduced motion keeps the static and the
 * SIGNAL LOST frame but drops the handset's raise and lower.
 */
export const FPV_TRANSITION = Object.freeze({
  raiseMs: 450, bootMs: 250, lostMs: 600, lowerMs: 400,
  /** A cut from a hit on the operator: he is under fire, the SIGNAL LOST frame is short. */
  hitLostMs: 250,
});

const clamp01 = v => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
/** Smoothstep ease: the handset leaves and arrives at rest. */
export const easeHandset = t => { const x = clamp01(t); return x * x * (3 - 2 * x); };

export class FpvTransition {
  constructor(rules = FPV_TRANSITION) {
    this.rules = rules;
    this.phase = 'idle';
    this._at = 0;
    this._from = 0;
    this._lostMs = rules.lostMs;
    this._cutReason = null;
    /**
     * The frame (reused): `camera` 'body' | 'drone' | 'frozen' (the last drone
     * pose), `handset` 0..1 (0 lowered out of view, 1 the screen in front of
     * the eye), `boot` 0..1 extra static over the feed, `lost` the SIGNAL LOST
     * frame, `feed` the feed HUD shown, `weaponHidden` the gun stowed (no fire),
     * `redraw` true on the one frame the weapon comes back.
     */
    this.frame = { phase: 'idle', t: 0, camera: 'body', handset: 0, boot: 0, lost: false, feed: false, weaponHidden: false, redraw: false };
  }

  /** The server's cut reason for the link that just ended (fpv event `reason`): 'hit' shortens SIGNAL LOST. */
  noteCut(reason) { this._cutReason = reason ?? null; }

  _enter(phase, nowMs, from = 0) { this.phase = phase; this._at = nowMs; this._from = from; }

  /** One frame: `active` (FpvPilot.active), `alive` (the own body). Returns `this.frame`. */
  update(nowMs, { active = false, alive = true, reducedMotion = false } = {}) {
    const r = this.rules, now = Number.isFinite(nowMs) ? nowMs : 0;
    const raiseMs = reducedMotion ? 0 : r.raiseMs, lowerMs = reducedMotion ? 0 : r.lowerMs;
    const wasHidden = this.frame.weaponHidden;
    if (!alive) { if (this.phase !== 'idle') this._enter('idle', now); }
    else {
      // Several steps in one frame are fine (a long frame or zero-length phases under reduced motion).
      for (let guard = 0; guard < 6; guard++) {
        const elapsed = now - this._at, phase = this.phase;
        if (phase === 'idle') { if (active) this._enter('raise', now, 0); }
        else if (phase === 'raise') {
          if (!active) this._enter('lower', now, this._handset(now));
          else if (elapsed >= raiseMs * (1 - this._from)) this._enter('boot', this._at + raiseMs * (1 - this._from));
        } else if (phase === 'boot' || phase === 'feed') {
          if (!active) {
            this._lostMs = this._cutReason === 'hit' ? r.hitLostMs : r.lostMs;
            this._enter('lost', now);
          } else if (phase === 'boot' && elapsed >= r.bootMs) this._enter('feed', this._at + r.bootMs);
        } else if (phase === 'lost') {
          if (active) this._enter('boot', now);
          else if (elapsed >= this._lostMs) this._enter('lower', this._at + this._lostMs, 1);
        } else if (phase === 'lower') {
          if (active) this._enter('raise', now, this._handset(now));
          else if (elapsed >= lowerMs * this._from) this._enter('idle', this._at + lowerMs * this._from);
        }
        if (this.phase === phase) break;
      }
      if (this.phase === 'idle' || this.phase === 'raise') this._cutReason = null;
    }
    const f = this.frame, phase = this.phase, elapsed = now - this._at;
    f.phase = phase;
    f.t = phase === 'raise' ? (raiseMs > 0 ? clamp01(elapsed / raiseMs) : 1) // wall share of a full raise
      : phase === 'boot' ? clamp01(elapsed / r.bootMs)
        : phase === 'lost' ? clamp01(elapsed / this._lostMs)
          : phase === 'lower' ? (lowerMs > 0 ? clamp01(elapsed / lowerMs) : 1) : phase === 'feed' ? 1 : 0;
    f.camera = phase === 'boot' || phase === 'feed' ? 'drone' : phase === 'lost' ? 'frozen' : 'body';
    f.handset = reducedMotion && (phase === 'raise' || phase === 'lower') ? 0 : this._handset(now);
    f.boot = phase === 'boot' ? 1 - f.t : 0;
    f.lost = phase === 'lost';
    f.feed = phase === 'boot' || phase === 'feed' || phase === 'lost';
    f.weaponHidden = phase !== 'idle';
    f.redraw = wasHidden && !f.weaponHidden && alive;
    return f;
  }

  _handset(now) {
    const r = this.rules, elapsed = now - this._at;
    switch (this.phase) {
      case 'raise': {
        // A raise from a half-lowered handset (a relaunch mid-lower) covers only the rest.
        const span = r.raiseMs * (1 - this._from);
        return span > 0 ? this._from + (1 - this._from) * easeHandset(elapsed / span) : 1;
      }
      case 'boot': case 'feed': case 'lost': return 1;
      case 'lower': {
        const span = r.lowerMs * this._from;
        return span > 0 ? this._from * (1 - easeHandset(elapsed / span)) : 0;
      }
      default: return 0;
    }
  }

  reset() { this._enter('idle', 0); this._cutReason = null; Object.assign(this.frame, { phase: 'idle', t: 0, camera: 'body', handset: 0, boot: 0, lost: false, feed: false, weaponHidden: false, redraw: false }); }
}
