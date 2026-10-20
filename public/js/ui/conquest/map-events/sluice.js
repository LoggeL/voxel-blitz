/**
 * Ford sluices on the HUD (docs/conquest.md "Ford sluices"; design
 * docs/design/conquest/events/sluice/, variant A): the levolution look for
 * the weir (amber outline while damaged, hazard stripes through the groan,
 * the gap with break marks once down) plus what the release does to the
 * lane, all from the decoded `ev` row and the shared bore:
 *
 *   active   the bore front: a white foam line across the reach at the
 *            front's distance (`sluiceBore`, from the row's time left)
 *   down     the washed-out ford: deep water over the ford rows with white
 *            break marks on the road at both bank ends; the marker reads
 *            "SHORT · WASHED OUT"
 */
import { LEVOLUTION_STAGE, levolutionStage } from '../../../../../shared/map-events/levolution.js';
import { sluiceBore } from '../../../../../shared/map-events/sluice.js';
import { BRIDGE_STAGE } from '../../../../../shared/conquest-bridge.js';
import { paintBridge } from '../bridge-hud.js';
import { levolutionPresenter } from './levolution.js';

export const SLUICE_MAP_COLORS = Object.freeze({ deep: '#173f66', foam: '#f4fbff' });

const bores = new WeakMap();
const boreOf = def => {
  const S = def?.tuning?.sluice;
  if (!S) return null;
  if (!bores.has(S)) bores.set(S, sluiceBore(S.weir, S.release.bore));
  return bores.get(S);
};

/** The ford box a release washes out: the ford bed across the ford rows. */
export const sluiceFordBox = weir => ({ x0: weir.ford.bed.x0, z0: weir.ford.z0, x1: weir.ford.bed.x1, z1: weir.ford.z1 });

/** Release ms of a decoded active row (from its time left), or null. */
export function sluiceReleaseMs(event) {
  const R = event?.def?.tuning?.sluice?.release;
  if (!R || event.phase !== 'active' || !Number.isFinite(event.leftMs)) return null;
  return Math.max(0, R.doneMs - event.leftMs);
}

export function sluicePresenter() {
  const base = levolutionPresenter();
  return Object.freeze({
    banner: base.banner,

    paintMap(ctx, event, opts = {}) {
      base.paintMap(ctx, event, opts);
      const S = event?.def?.tuning?.sluice, stage = levolutionStage(event?.phase);
      if (!S || stage < LEVOLUTION_STAGE.down) return;
      const px = opts.px ?? 1, line = m => Math.max(m / Math.max(px, 1e-3), 0.25);
      // The ford: deep water under the road, break marks at both bank ends.
      const ford = sluiceFordBox(S.weir);
      ctx.save();
      ctx.fillStyle = SLUICE_MAP_COLORS.deep;
      ctx.fillRect(ford.x0, ford.z0, ford.x1 - ford.x0 + 1, ford.z1 - ford.z0 + 1);
      ctx.restore();
      paintBridge(ctx, { stage: BRIDGE_STAGE.down, span: ford, axis: 'x', water: false }, opts);
      // The bore front while it runs.
      const ms = sluiceReleaseMs(event), bore = boreOf(event.def);
      if (ms == null || !bore || ms / 1000 * bore.rules.speed > bore.rules.reachM) return;
      const z = bore.zAt(bore.front(ms)), c = bore.centre(z), h = 10;
      ctx.save();
      ctx.globalAlpha = 0.5 + 0.5 * bore.crest(bore.front(ms)) / bore.rules.crest;
      ctx.strokeStyle = SLUICE_MAP_COLORS.foam; ctx.lineWidth = line(2.2); ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(c - h, z); ctx.lineTo(c + h, z); ctx.stroke();
      ctx.restore();
    },

    marker(model, event) {
      if (levolutionStage(event.phase) >= LEVOLUTION_STAGE.down) return { ...model, name: `${event.def.short} · WASHED OUT` };
      return base.marker(model, event);
    },
  });
}

export const SLUICE_PRESENTER = sluicePresenter();
