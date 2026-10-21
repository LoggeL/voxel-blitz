import { interactKind } from '../../../shared/interact-anim.js';

// Hold-to-use interaction animations (docs/conquest.md "Interaction
// animations", design docs/design/interact-anims/): presentation only, driven
// by the authoritative row `interaction` {kind, progress} (S&D plant and
// defuse, Bastion and Conquest repair, the Conquest revive and map-event
// points) plus the local Interact key, so a release drops the hands at once.
//
// Phases: idle -> enter (the gun lowers, the hands come up) -> work (the
// kind's loop, the camera dipped into a kneel) -> finish (a short beat when
// the hold ended done: the charge armed, the mate up, the sparks out) or a
// quick cancel -> exit (the hands go, the gun draws again) -> idle.

export const INTERACT_ANIM = Object.freeze({
  enterMs: 220,
  /** The hands drop away this fast after a release or a broken hold. */
  cancelMs: 150,
  /** ... and this fast after a finishing beat. */
  exitMs: 260,
  /** The finishing beat per kind (ms). */
  finishMs: Object.freeze({ plant: 520, defuse: 420, revive: 600, repair: 380, hack: 440 }),
  /** A hold whose last progress reached this counts as done when it ends (snapshots land every 50 ms). */
  completeAt: 0.9,
  /** A row missing its interaction this briefly (a late snapshot) while the key is held keeps the work going. */
  graceMs: 160,
  /** Camera drop (m) at full level, standing (a kneel); crouched or prone keeps a quarter of it. */
  dip: Object.freeze({ plant: 0.42, defuse: 0.42, revive: 0.46, repair: 0.2, hack: 0 }),
});

const clamp01 = v => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
const ease = t => { const x = clamp01(t); return x * x * (3 - 2 * x); };

/**
 * The hold a snapshot row shows: {kind, progress} or null (dead, seated, no
 * hold, unknown kind). The third-person pose reads remote rows through this.
 */
export function rowInteraction(row) {
  if (!row || row.state !== 'alive' || row.vehicleId != null) return null;
  const kind = interactKind(row.interaction?.kind);
  if (!kind) return null;
  return { kind, progress: clamp01(Number(row.interaction.progress)) };
}

const IDLE = Object.freeze({ phase: 'idle', kind: null, level: 0, workS: 0, progress: 0, finish: 0, done: false,
  weaponHidden: false, dip: 0, redraw: false });

export class InteractAnim {
  constructor(rules = INTERACT_ANIM) {
    this.rules = rules;
    this.reset();
  }

  reset() {
    this.phase = 'idle';
    this.kind = null;
    this.at = 0;          // phase start (ms)
    this.from = 0;        // level at the phase start
    this.workAt = 0;      // work start (ms), the loops' clock
    this.progress = 0;
    this.lastSeenAt = -Infinity;
    this.done = false;
    this.exitMs = this.rules.cancelMs;
    this.frame = IDLE;
  }

  _go(phase, now, from = this.level()) { this.phase = phase; this.at = now; this.from = from; }

  /** The hands' level (0 gone, 1 up) at the current phase start, for a reversal. */
  level() { return this.frame?.level ?? 0; }

  /**
   * One frame. `interaction` {kind, progress} or null (rowInteraction of the
   * own row), `held` the local Interact key, `alive` the body alive and on
   * foot, `crouched` crouched or prone (the kneel dips less), `reducedMotion`
   * no camera dip. Returns the frame (also kept as `this.frame`).
   */
  update(now, { interaction = null, held = false, alive = true, crouched = false, reducedMotion = false } = {}) {
    const R = this.rules;
    const kind = held && alive ? interactKind(interaction?.kind) : null;
    if (!alive) { if (this.phase !== 'idle') this.reset(); return (this.frame = IDLE); }
    if (kind) { this.lastSeenAt = now; this.progress = clamp01(interaction.progress); }
    // A fresh hold (or another kind) starts from wherever the hands are.
    if (kind && (this.phase === 'idle' || this.phase === 'exit' || kind !== this.kind) && this.phase !== 'finish') {
      const from = this.phase === 'idle' ? 0 : this.level();
      this.kind = kind; this.done = false;
      this._go('enter', now, from);
      this.workAt = now;
    }
    // A hold that had run out ends at once (the server completed it); a missing row waits out the grace.
    const ended = !kind && (!held || this.progress >= R.completeAt || now - this.lastSeenAt > R.graceMs);
    if ((this.phase === 'enter' || this.phase === 'work') && ended) {
      // Released or broken: done only when the hold had run out (the server completes it on that tick).
      this.done = held && this.progress >= R.completeAt;
      if (this.done) this._go('finish', now);
      else { this.exitMs = R.cancelMs; this._go('exit', now); }
    }
    let level = this.from, finish = 0, redraw = false;
    const t = now - this.at;
    if (this.phase === 'enter') {
      level = this.from + (1 - this.from) * ease(R.enterMs > 0 ? t / R.enterMs : 1);
      if (t >= R.enterMs) { this._go('work', now, 1); level = 1; }
    } else if (this.phase === 'work') {
      level = 1;
    } else if (this.phase === 'finish') {
      const ms = R.finishMs[this.kind] ?? 400;
      level = 1; finish = clamp01(t / ms);
      if (t >= ms) { this.exitMs = R.exitMs; this._go('exit', now, 1); finish = 1; }
    }
    if (this.phase === 'exit') {
      const u = now - this.at;
      level = this.from * (1 - ease(this.exitMs > 0 ? u / this.exitMs : 1));
      if (u >= this.exitMs) { const was = this.kind; this.reset(); redraw = !!was; level = 0; }
    }
    if (this.phase === 'idle' && !redraw) return (this.frame = IDLE);
    const dip = reducedMotion || !this.kind ? 0 : (R.dip[this.kind] ?? 0) * (crouched ? 0.25 : 1) * ease(level);
    return (this.frame = {
      phase: this.phase, kind: this.kind, level, workS: Math.max(0, now - this.workAt) / 1000,
      progress: this.phase === 'finish' && this.done ? 1 : this.progress, finish, done: this.done,
      weaponHidden: this.phase !== 'idle', dip, redraw,
    });
  }
}
