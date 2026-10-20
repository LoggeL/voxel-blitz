// Ford sluices in the world (docs/conquest.md "Ford sluices"): the levolution
// effects (./levolution.js, stone voices) for the groan and the fall, plus the
// release. Presentation only, from `map_event` phases and the `ev` row.
//
//   active   a burst of water over the gates as they go, then spray along the
//            bore front as it runs down the reach (`sluiceBore`, the same
//            front the server's push zones use, from the row's time left)
//
// A joiner who walks into the release picks the front up from the row. No
// dedicated recording: the structure voices and the water puffs carry it.
import { mapEventDef } from '../../../../shared/conquest-map-events.js';
import { sluiceBore } from '../../../../shared/map-events/sluice.js';
import { sluiceReleaseMs } from '../../ui/conquest/map-events/sluice.js';
import { levolutionFx } from './levolution.js';

export const SLUICE_FX_RULES = Object.freeze({ sprayMs: 140, sprayPuffs: 3, burstPuffs: 8 });

export function sluiceFx() {
  const base = levolutionFx({ material: 'stone' });
  const runs = new WeakMap(); // kit -> Map(id -> { bore, weir, ms, spray })
  const runsOf = kit => { let m = runs.get(kit); if (!m) runs.set(kit, m = new Map()); return m; };
  const boreFor = (kit, id) => {
    const S = mapEventDef(id, kit.defs)?.tuning?.sluice;
    return S ? { bore: sluiceBore(S.weir, S.release.bore), weir: S.weir } : null;
  };
  const start = (kit, id, ms) => {
    const r = boreFor(kit, id);
    if (r) runsOf(kit).set(id, { ...r, ms, spray: 0 });
    return r;
  };
  return Object.freeze({
    onEvent(ev, kit) {
      const handled = base.onEvent(ev, kit);
      if (!ev.note && ev.phase === 'active') {
        const r = start(kit, ev.event, 0);
        if (r && kit.puff) {
          const w = r.weir, at = [(w.pass.x0 + w.pass.x1 + 1) / 2, 23, w.z1 + 1.5];
          for (let i = 0; i < SLUICE_FX_RULES.burstPuffs; i++) kit.puff('water', kit.ring?.(at, 7, 23) ?? at, { count: 10, scale: 2.2, speed: 2 });
        }
      }
      if (!ev.note && ev.phase !== 'active') runs.get(kit)?.delete(ev.event);
      return handled;
    },
    sync(event, kit, opts = {}) {
      base.sync(event, kit, opts);
      const ms = sluiceReleaseMs(event);
      const run = runs.get(kit)?.get(event.id);
      if (ms == null) { runs.get(kit)?.delete(event.id); return; }
      if (!run) start(kit, event.id, ms);
      else if (Math.abs(run.ms - ms) > 1500) run.ms = ms; // a joiner or a hitch: follow the row
    },
    update(dt, kit) {
      base.update(dt, kit);
      for (const run of runs.get(kit)?.values() ?? []) {
        run.ms += dt * 1000;
        const R = run.bore.rules, d = run.bore.front(run.ms);
        if (run.ms / 1000 * R.speed > R.reachM || !kit.puff) continue;
        run.spray -= dt * 1000;
        if (run.spray > 0) continue;
        run.spray = SLUICE_FX_RULES.sprayMs;
        const z = run.bore.zAt(d), c = run.bore.centre(z), k = run.bore.crest(d) / R.crest;
        for (let i = 0; i < SLUICE_FX_RULES.sprayPuffs; i++) {
          kit.puff('water', [c + (Math.random() * 2 - 1) * R.halfWidth * 0.7, 22.5 + k, z], { count: 4, scale: 1.2 + 1.4 * k, speed: 1 + k });
        }
      }
    },
    end(kit) { base.end(kit); runs.delete(kit); },
    clear(kit) { base.clear(kit); runs.delete(kit); },
  });
}

export const SLUICE_FX = sluiceFx();
