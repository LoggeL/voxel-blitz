import { reloadPlan } from './combatmath.js';

const chamberOf = (def) => Math.max(0, Math.trunc(Number(def.chamber) || 0));

/** Reload simulation in seconds. The caller owns the clock and ammo storage.
 * `panic01` fumbles every stage (authority passes its own, prediction its own). */
export function beginReload(def, ammo, infinite = false, panic01 = 0) {
  if (def.mode === 'melee' || ammo.mag >= def.magSize || (!infinite && ammo.reserve <= 0)) return null;
  const plan = reloadPlan(def, ammo.mag, infinite ? Infinity : ammo.reserve, panic01);
  // A magazine swap drops the magazine at once; a chambered round stays put.
  if (!plan.staged) ammo.mag = plan.chambered ? chamberOf(def) : 0;
  return { ...plan, elapsed: 0, inserted: 0, done: false };
}

/** Catch up every crossed shell boundary, including a whole reload in one tick. */
export function advanceReload(reload, def, ammo, dt, infinite = false) {
  if (!reload || reload.done) return false;
  reload.elapsed = Math.min(reload.seconds, reload.elapsed + Math.max(0, dt));
  const before = ammo.mag;
  if (reload.staged) {
    const due = Math.min(reload.rounds, Math.max(0,
      Math.floor((reload.elapsed - reload.startSeconds + 1e-9) / reload.perRoundSeconds)));
    while (reload.inserted < due) {
      reload.inserted++;
      if (ammo.mag < def.magSize && (infinite || ammo.reserve > 0)) {
        ammo.mag++;
        if (!infinite) ammo.reserve--;
      }
    }
  }
  if (reload.elapsed + 1e-9 >= reload.seconds) {
    reload.done = true;
    if (!reload.staged && (infinite || ammo.reserve > 0)) {
      // Closed-bolt launchers: an empty swap must strip one round of the fresh
      // magazine into the chamber, so it delivers magSize - chamber in total.
      ammo.mag = reload.chambered || !chamberOf(def) ? def.magSize : def.magSize - chamberOf(def);
      if (!infinite) ammo.reserve--;
    }
  }
  return ammo.mag !== before || reload.done;
}

export function reloadPhase(reload) {
  if (!reload || reload.done || !reload.staged) return null;
  if (reload.elapsed < reload.startSeconds) return 'start';
  return reload.inserted < reload.rounds ? 'round' : 'end';
}
