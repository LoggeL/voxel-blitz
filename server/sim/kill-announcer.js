import { MULTIKILL_WINDOW_MS, killAnnouncerCue } from '../../shared/announcer.js';

/** Per-life streaks on the simulation clock, independent of score and delivery latency. */
export class KillAnnouncer {
  constructor() { this.lives = new WeakMap(); }

  reset(player) { if (player) this.lives.delete(player); }

  kill(victim, killer, now, eligible) {
    this.reset(victim);
    if (!eligible || !killer || killer === victim || killer.id === victim.id ||
        killer.state !== 'alive' || !Number.isFinite(now)) return null;
    const previous = this.lives.get(killer);
    const consecutive = previous && now >= previous.at && now - previous.at <= MULTIKILL_WINDOW_MS;
    const combo = consecutive ? previous.combo + 1 : 1;
    const streak = (previous?.streak || 0) + 1;
    this.lives.set(killer, { at: now, combo, streak });
    return killAnnouncerCue(combo, streak);
  }
}
