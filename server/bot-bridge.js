// Bots and the levolutions: the Iron Bridge collapse (docs/conquest.md "Iron
// Bridge collapse") and every levolution map event (the Canyon Trestle, ...).
//
// The infantry surface graph learns the gap from the block deltas like any
// crater (bots.js pollTerrain). What it cannot know is intent: from the groan
// on, the road crossing is closed for bot drivers (bot-vehicle-driving.js
// routes over another crossing instead), objective points on a closed span
// move to the head on the bot's own side, and a bot standing on a failing
// span runs off it. The closed spans come from the structure views
// (structureViews: the Iron Bridge first, then the map events').
import { IRON_BRIDGE, crossesBridgeSpan } from '../shared/conquest-bridge.js';
import { LEVOLUTION_RULES } from '../shared/map-events/levolution.js';
import { eventClosedCrossings, structureViews } from './bot-map-events.js';

const NONE = Object.freeze(new Set());
/** Metres past the span edge a bridgehead point stands (on the quay road). */
export const BRIDGEHEAD_OFFSET = 9;
/** Metres around the span footprint that count as "on the span" for objective points. */
const SPAN_PAD = 3;

/** The authoritative bridge view (ConquestPolicy.bridge), or null on maps without one. */
export function bridgeView(game) {
  const view = game?.mode?.policy?.bridge?.view?.();
  return view?.active ? view : null;
}

/** Road crossing ids bot drivers may not use (the Iron Bridge from its groan on, plus what map events close). */
export function closedCrossings(game) {
  const view = bridgeView(game);
  const events = eventClosedCrossings(game);
  if (!events.size) return view?.closed ? new Set([view.crossing]) : NONE;
  return new Set([...(view?.closed ? [view.crossing] : []), ...events]);
}

/** Bank side of a point relative to the bridge (or a span view): -1 west, 1 east (north / south on a span crossed along z). */
export const bankSide = (point, bridge = IRON_BRIDGE) => (bridge.axis === 'z' ? (point.z < bridge.z ? -1 : 1) : (point.x < bridge.x ? -1 : 1));

/**
 * The Iron Bridge in the shape every levolution's structureView has (span =
 * the footprint with exclusive upper edges and its bottom row y0); the helpers
 * below take either it or a view.
 */
const IRON_SPAN = Object.freeze({ id: IRON_BRIDGE.id, x: IRON_BRIDGE.x, z: IRON_BRIDGE.z, deckY: IRON_BRIDGE.deckY, waterY: IRON_BRIDGE.waterY, axis: 'x',
  span: Object.freeze({ x0: IRON_BRIDGE.span.x0, z0: IRON_BRIDGE.span.z0, x1: IRON_BRIDGE.span.x1 + 1, z1: IRON_BRIDGE.span.z1 + 1, y0: IRON_BRIDGE.span.y0 }) });
const spanOf = bridge => (bridge === IRON_BRIDGE ? IRON_SPAN : bridge);

/** A point on the road just past the span on `side` (the cross coordinate kept inside the deck width). */
export function bridgeheadPoint(side, z = IRON_BRIDGE.z, bridge = IRON_BRIDGE) {
  const v = spanOf(bridge), s = v.span, along = v.axis === 'z';
  const cross = Number.isFinite(z) ? z : along ? v.x : v.z;
  const lo = along ? s.x0 : s.z0, hi = along ? s.x1 : s.z1;
  const c = Math.max(lo + 1, Math.min(hi - 2, cross)) + 0.5;
  const a = (side < 0 ? (along ? s.z0 : s.x0) - BRIDGEHEAD_OFFSET : (along ? s.z1 : s.x1) + BRIDGEHEAD_OFFSET) + 0.5;
  return along ? { x: c, y: v.deckY + 1.02, z: a } : { x: a, y: v.deckY + 1.02, z: c };
}

/** True when an (x, z) point lies on the span footprint grown by `pad`. */
export function nearSpan(point, pad = SPAN_PAD, bridge = IRON_BRIDGE) {
  const s = spanOf(bridge).span;
  return point.x >= s.x0 - pad && point.x < s.x1 + pad && point.z >= s.z0 - pad && point.z < s.z1 + pad;
}

/** The spans closed now (from their groan on): the Iron Bridge's and the levolution events' structure views. */
export function closedSpans(game) {
  return structureViews(game).filter(v => v?.closed && v.span);
}

/** The head on the side of `from` for a point on (or beside) span view `v`. */
const spanHead = (v, point, from) => bridgeheadPoint(bankSide(from ?? point, v), v.axis === 'z' ? point.x : point.z, v);

/**
 * An objective point for a bot at `from`: unchanged unless a closed span's
 * footprint (or its edge) holds it, then the head on the bot's side.
 */
export function avoidSpan(game, point, from) {
  if (!point) return point;
  for (const v of closedSpans(game)) if (nearSpan(point, SPAN_PAD, v)) return spanHead(v, point, from);
  return point;
}

/**
 * True when a body stands on a span: its footprint, up to spanCrush.above
 * over the deck, from the span's bottom over water (a bridge) or two blocks
 * under the deck (a trestle: the canyon floor under it is not "on" it).
 */
function onSpan(v, p) {
  const s = v.span, deckY = v.deckY;
  const y0 = v.waterY != null ? s.y0 : deckY - 2;
  return p.x >= s.x0 && p.x < s.x1 && p.z >= s.z0 && p.z < s.z1 && p.y >= y0 && p.y <= deckY + 1 + LEVOLUTION_RULES.spanCrush.above;
}

/** A bot on a failing (or fallen) span: where to run to, else null. */
export function spanEscape(game, p) {
  if (!p) return null;
  for (const v of closedSpans(game)) if (onSpan(v, p)) return spanHead(v, p, p);
  return null;
}

/** True when a straight drive from `a` to `b` would cross a closed span. */
export function crossesClosedSpan(game, a, b) {
  for (const v of closedSpans(game)) {
    const s = v.span;
    if (crossesBridgeSpan(a, b, 2, { span: { x0: s.x0, z0: s.z0, x1: s.x1 - 1, z1: s.z1 - 1 } })) return true;
  }
  return false;
}
