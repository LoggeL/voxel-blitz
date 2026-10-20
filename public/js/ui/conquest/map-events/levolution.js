/**
 * Levolutions on the HUD (docs/conquest.md "Map events", "Levolutions";
 * the Iron Bridge's look, design docs/design/conquest/bridge/). Reads only
 * the decoded `ev` row (phase, gauge, time left) and the definition's
 * structure; nothing is predicted.
 *
 *   damaged  (armed)   "NAME · DAMAGED · SUPPORTS AT n %" and an amber
 *                      outline over the span on the maps
 *   failing  (warning) "NAME · COLLAPSING · GET OFF THE SPAN" held to the
 *                      fall with its countdown, pulsing hazard stripes
 *   down     (active, done)  the definition's `active` texts (a reason
 *                      variant `active:<reason>` first; `done` banners nothing), the gap and white
 *                      break marks on the maps, "SHORT · DOWN" on the marker
 *
 * An event registers it in its presenter slot: `trestle: levolutionPresenter()`;
 * `water: false` paints a dry gap (a canyon) instead of river.
 */
import { LEVOLUTION_STAGE, levolutionStage } from '../../../../../shared/map-events/levolution.js';
import { paintBridge } from '../bridge-hud.js';

/** The share of the supports left (0..100) a decoded row or a `map_event` carries. */
export const levolutionSupports = event => Math.max(0, Math.min(100, Math.round(100 - (Number(event?.progress) || 0) * 100)));

/** The map overlay model of one span box of a decoded row, or null while intact. */
export function levolutionMapModel(event, box, { water = true } = {}) {
  const stage = levolutionStage(event?.phase);
  const L = event?.def?.tuning?.levolution;
  if (!L || stage <= LEVOLUTION_STAGE.intact) return null;
  return { stage, span: box, axis: L.structure.axis, water: water && L.structure.waterY != null };
}

export function levolutionPresenter({ water = true } = {}) {
  return Object.freeze({
    banner(ev, ctx, base) {
      // The `fallen` note is effects only; the active phase banners the fall.
      // `done` (the dust settled) repeats the fall's banner: none.
      if (ev?.note || ev?.phase === 'done') return null;
      if (!base) return undefined;
      if (ev.phase === 'armed' && Number.isFinite(ev.data?.integrity)) return { ...base, detail: `SUPPORTS AT ${Math.round(ev.data.integrity)} %` };
      return undefined;
    },

    paintMap(ctx, event, { nowMs = 0, px = 1 } = {}) {
      for (const box of event?.def?.tuning?.levolution?.structure.span ?? []) {
        const model = levolutionMapModel(event, box, { water });
        if (model) paintBridge(ctx, model, { nowMs, px });
      }
    },

    marker(model, event) {
      const stage = levolutionStage(event.phase);
      if (stage >= LEVOLUTION_STAGE.down) return { ...model, name: `${event.def.short} · DOWN` };
      if (stage === LEVOLUTION_STAGE.failing) return { ...model, name: `${event.def.short} · COLLAPSING` };
      if (stage === LEVOLUTION_STAGE.damaged) return { ...model, name: `${event.def.short} · ${levolutionSupports(event)} %` };
      return model;
    },
  });
}
