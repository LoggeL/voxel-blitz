// Frontier sluice weir in the world (docs/conquest.md "Sluice weir").
// Presentation only, from the `map_event` events and the snapshot's `ev`
// row; the water itself is the server's staged block edits.
//
//   warning   the gate winches creak (metal) at both bays
//   active    a jolt, white water bursting through both bays, and a spill
//             spray at the bays while the surge still rises (the flood gauge
//             under 1); a joiner mid-surge gets the spray from the snapshot
//   recede    the winches creak again as the gates come down
// The horn is the alarm stinger of the definition's cues; there is no
// recording of the surge of its own (the wade splash voice stands in).
import { WEIR } from '../../../../shared/map-events/weir.js';

export const WEIR_FX_RULES = Object.freeze({
  /** Surge jolt: trauma and fade-out range (m). */
  trauma: 0.22, rangeM: 140,
  /** Water puffs per bay as the gates open; the spill spray's rate (/s) per bay. */
  burst: 8, spillRate: 14,
});

const BAY_POINTS = WEIR.bays.map(b => [(b.x0 + b.x1 + 1) / 2, WEIR.shutTopY, WEIR.gateZ + 1.5]);
const SPILL_KEYS = WEIR.bays.map(b => `weir:spill-${b.id}`);

function spill(kit, on) {
  WEIR.bays.forEach((b, i) => {
    const key = SPILL_KEYS[i];
    if (!on) { kit.stopEmitter(key); return; }
    if (kit.emitters.has(key)) return;
    kit.emitter(key, { kind: 'water', pos: BAY_POINTS[i], rate: WEIR_FX_RULES.spillRate, params: { scale: 1.6, speed: 1.3, jitter: 1.2 } });
  });
}

export const WEIR_FX = Object.freeze({
  onEvent(ev, kit) {
    if (ev.note === 'surge') return true;
    if (ev.note) return false;
    if (ev.phase === 'warning') {
      for (const at of BAY_POINTS) kit.sound.creak([at[0], WEIR.gantryTopY - 2, at[2]], { material: 'metal', n: 400, seconds: 1.6 });
      return true;
    }
    if (ev.phase === 'active') {
      const r = WEIR_FX_RULES;
      kit.shake(BAY_POINTS[0], r.trauma, r.rangeM);
      for (const at of BAY_POINTS) {
        kit.sound.impact(at, { n: 260, speed: 6, material: 'metal' });
        kit.audio?.vehicleWadeSplash?.(at);
        for (let i = 0; i < r.burst; i++) kit.puff('water', kit.ring(at, 2.4, at[1]), { count: 5, scale: 2.2, speed: 1.6 });
      }
      spill(kit, true);
      return true;
    }
    if (ev.phase === 'cooldown' || ev.phase === 'done') {
      spill(kit, false);
      for (const at of BAY_POINTS) kit.sound.creak([at[0], WEIR.gantryTopY - 2, at[2]], { material: 'metal', n: 300, seconds: 1.2 });
      return true;
    }
    return false;
  },
  sync(event, kit) {
    spill(kit, event.phase === 'active' && event.progress < 0.99);
  },
  clear(kit) { spill(kit, false); },
});
