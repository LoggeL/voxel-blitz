// Map event director (docs/conquest.md "Map events"): two big events never
// warn or peak at once, and repeating events fire a bounded number of times
// a match (MAP_EVENT_RULES.director).
//
// Every trigger reserves a window from its warning start to `peakMs` after
// its active start. A trigger whose window would overlap another big event's
// (plus `gapMs` either side) is pushed to start `gapMs` after that window:
// the event waits armed (`queued`) and its warning begins then.
import { MAP_EVENT_RULES } from '../../../../shared/conquest-map-events.js';

export class MapEventDirector {
  constructor(system, rules = MAP_EVENT_RULES.director) {
    this.system = system;
    this.rules = rules;
    this.reset();
  }

  reset() {
    this.windows = new Map(); // instance id -> { start, end }
    this.repeatFires = 0;
  }

  /** May `instance` fire now? Its own repeat cap and the match-wide cap of repeating events. */
  mayFire(instance) {
    const repeat = instance.def.repeat;
    if (!repeat) return instance.fires < 1;
    return instance.fires < repeat.max && this.repeatFires < this.rules.repeatCap;
  }

  noteFire(instance) { if (instance.def.repeat) this.repeatFires++; }

  /** A fire called off before it struck (defused, relay lost): it does not count, its window frees. */
  refund(instance) {
    instance.fires = Math.max(0, instance.fires - 1);
    if (instance.def.repeat) this.repeatFires = Math.max(0, this.repeatFires - 1);
    this.windows.delete(instance.id);
  }

  /**
   * The engine time `instance`'s warning may begin (now when no big window
   * is in the way), and reserve its window. Small events never wait.
   */
  reserve(instance, warningMs = 0) {
    const now = this.system.now;
    const length = Math.max(0, warningMs || 0) + this.rules.peakMs;
    if (!instance.def.big) return now;
    const gap = this.rules.gapMs;
    const others = [...this.windows.entries()].filter(([id, w]) => id !== instance.id && w.end > now).map(([, w]) => w)
      .sort((a, b) => a.start - b.start);
    let start = now;
    for (let guard = 0; guard < 16; guard++) {
      const clash = others.find(w => start < w.end + gap && start + length + gap > w.start);
      if (!clash) break;
      start = clash.end + gap;
    }
    this.windows.set(instance.id, { start, end: start + length });
    return start;
  }

  /** The event went quiet (idle, done, cooldown): its window is free (once its peak is over). */
  release(instance) {
    const w = this.windows.get(instance.id);
    if (w && (instance.phase === 'idle' || w.end <= this.system.now)) this.windows.delete(instance.id);
  }

  /** Reserved windows for tests and the bot view: [{id, start, end}]. */
  list() { return [...this.windows.entries()].map(([id, w]) => ({ id, ...w })); }
}
