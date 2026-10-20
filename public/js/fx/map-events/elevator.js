// Kestrel Halt grain elevator topple in the world (docs/conquest.md "Kestrel
// Halt grain elevator"). The fall itself is the structural system's
// (structure-fx.js draws the creak, the chunks turning a quarter as they fly
// east and their landing); this adds what only the `map_event` knows: a
// timber creak with grit when the base is half gone, the long groan with
// grit raining off the bin and a rising shake through the warning, and as
// the chunks land a rumble, a camera shake and a big dust cloud rolling
// along the fall line, left standing for a few seconds. Sounds reuse the
// structure voices (material 'wood'); there is no dedicated recording.
import { STRUCTURE_RULES } from '../../../../shared/structure.js';
import { ELEVATOR_EVENT, KESTREL_ELEVATOR, KESTREL_ELEVATOR_RUBBLE } from '../../../../shared/map-events/elevator.js';

/** Presentation tuning (no gameplay meaning). */
export const ELEVATOR_FX_RULES = Object.freeze({
  /** Seconds between groans while it gives way. */
  groanEvery: 0.55,
  /** Camera shake trauma: damaged, each groan (rising), the landing. */
  shake: Object.freeze({ damaged: 0.1, groan: Object.freeze([0.04, 0.14]), land: 0.6 }),
  shakeRange: 170,
  /** Seconds after the active phase starts (creak + flight) for the two landing waves. */
  waves: Object.freeze([STRUCTURE_RULES.creakMs / 1000 + 0.55, STRUCTURE_RULES.creakMs / 1000 + 1.25]),
  /** Dust puffs per landing wave, the standing cloud's rate and life (s). */
  dust: 14, cloudRate: 9, cloudSeconds: 7,
  grit: 5,
});

const T = KESTREL_ELEVATOR, B = T.box;
const TOP = [(B.x0 + B.x1 + 1) / 2, T.perch.y0, (B.z0 + B.z1 + 1) / 2];
const LAST = Math.max(...KESTREL_ELEVATOR_RUBBLE.segments.map(s => s.to));
const GROUND = T.hinge.y + 1;

function hash01(n) {
  let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** A point on the fall line `t` (0 the stump, 1 the roof's landing), jittered across it. */
function linePoint(t, n, y = GROUND) {
  const x = T.hinge.x - 3 + (LAST + 4) * t;
  return [x, y + hash01(n * 5 + 1) * 2, T.hinge.z + (hash01(n * 5 + 2) - 0.5) * 7];
}

function createElevatorFx() {
  let groan = null, waves = null, seq = 0;
  const grit = (kit, n) => {
    for (let i = 0; i < n; i++) {
      const k = ++seq;
      kit.puff('grit', [B.x0 + 0.5 + hash01(k * 3) * (B.x1 - B.x0), T.perch.y0 - 1 - hash01(k * 3 + 1) * 10, B.z0 + 0.5 + hash01(k * 3 + 2) * (B.z1 - B.z0)],
        { count: 6, scale: 1, speed: 1 });
    }
  };
  const startGroan = seconds => { groan = { left: seconds, total: Math.max(0.5, seconds), next: 0 }; };
  return {
    onEvent(ev, kit) {
      if (ev.note === 'damaged') {
        kit.sound.creak(TOP, { n: 180, material: 'wood', seconds: 0.9 });
        kit.shake(TOP, ELEVATOR_FX_RULES.shake.damaged, ELEVATOR_FX_RULES.shakeRange);
        grit(kit, ELEVATOR_FX_RULES.grit);
        return true;
      }
      if (ev.note) return true;
      if (ev.phase === 'warning') {
        startGroan((ELEVATOR_EVENT.durations.warningMs ?? 4000) / 1000);
        return true;
      }
      if (ev.phase === 'active') {
        groan = null;
        waves = ELEVATOR_FX_RULES.waves.map((at, i) => ({ at, i, done: false }));
        waves.t = 0;
        return true;
      }
      return ev.phase === 'done' || ev.phase === 'armed' || ev.phase === 'idle';
    },
    sync(event, kit, { fresh }) {
      // A joiner during the creak hears the rest of it.
      if (fresh && event.phase === 'warning' && !groan) startGroan((event.leftMs ?? 2000) / 1000);
    },
    update(dt, kit) {
      if (!(dt > 0)) return;
      const R = ELEVATOR_FX_RULES;
      if (groan) {
        groan.left -= dt; groan.next -= dt;
        if (groan.left <= 0) groan = null;
        else if (groan.next <= 0) {
          groan.next = R.groanEvery;
          const k = 1 - groan.left / groan.total;
          kit.sound.creak(TOP, { n: 260 + 420 * k, material: 'wood', seconds: 0.8 });
          kit.shake(TOP, R.shake.groan[0] + (R.shake.groan[1] - R.shake.groan[0]) * k, R.shakeRange);
          grit(kit, Math.round(R.grit * (1 + k)));
        }
      }
      if (waves) {
        waves.t += dt;
        for (const wave of waves) {
          if (wave.done || waves.t < wave.at) continue;
          wave.done = true;
          const mid = linePoint(wave.i ? 0.85 : 0.4, ++seq);
          kit.sound.impact(mid, { n: wave.i ? 900 : 600, speed: 14, material: 'wood' });
          kit.shake(mid, R.shake.land * (wave.i ? 1 : 0.7), R.shakeRange);
          for (let i = 0; i < R.dust; i++) kit.puff('dust', linePoint(hash01(++seq) * (wave.i ? 1 : 0.6), seq), { count: 5, scale: 3, speed: 1.4, life: 1.6 });
          for (let i = 0; i < 4; i++) kit.puff('debris', linePoint(hash01(++seq), seq, GROUND + 1), { count: 6, scale: 1.2, speed: 1.6 });
          if (wave.i) kit.emitter('elevator:cloud', { kind: 'dust', pos: linePoint(0.5, ++seq, GROUND + 1.5), rate: R.cloudRate,
            params: { scale: 3.4, alpha: 0.8, life: 2 }, until: R.cloudSeconds });
        }
        if (waves.every(w => w.done)) waves = null;
      }
    },
    end() { groan = null; waves = null; },
    clear() { groan = null; waves = null; },
  };
}

export const ELEVATOR_FX = createElevatorFx();
