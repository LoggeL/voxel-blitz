// Bots and the Iron Bridge collapse (docs/conquest.md "Iron Bridge collapse").
//
// The infantry surface graph learns the gap from the block deltas like any
// crater (bots.js pollTerrain). What it cannot know is intent: from the groan
// on, the road crossing is closed for bot drivers (bot-vehicle-driving.js
// routes over the fords instead), objective points on the span move to the
// bridgehead on the bot's own bank, and a bot standing on the failing span
// runs off it.
import { IRON_BRIDGE, crossesBridgeSpan, onBridgeSpan } from '../shared/conquest-bridge.js';
import { eventClosedCrossings } from './bot-map-events.js';

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

/** Bank side of a point relative to the bridge: -1 west, 1 east. */
export const bankSide = (point, bridge = IRON_BRIDGE) => (point.x < bridge.x ? -1 : 1);

/** A point on the paved axis just past the span on `side` (z kept inside the deck width). */
export function bridgeheadPoint(side, z = IRON_BRIDGE.z, bridge = IRON_BRIDGE) {
  const s = bridge.span;
  const x = side < 0 ? s.x0 - BRIDGEHEAD_OFFSET : s.x1 + 1 + BRIDGEHEAD_OFFSET;
  return { x: x + 0.5, y: bridge.deckY + 1.02, z: Math.max(s.z0 + 1, Math.min(s.z1 - 1, Number.isFinite(z) ? z : bridge.z)) + 0.5 };
}

/** True when an (x, z) point lies on the span footprint grown by `pad`. */
export function nearSpan(point, pad = SPAN_PAD, bridge = IRON_BRIDGE) {
  const s = bridge.span;
  return point.x >= s.x0 - pad && point.x < s.x1 + 1 + pad && point.z >= s.z0 - pad && point.z < s.z1 + 1 + pad;
}

/**
 * An objective point for a bot at `from`: unchanged unless the bridge is
 * closed and the point lies on (or beside) the span, then the bridgehead on
 * the bot's bank.
 */
export function avoidSpan(game, point, from) {
  const view = bridgeView(game);
  if (!view?.closed || !point || !nearSpan(point)) return point;
  return bridgeheadPoint(bankSide(from ?? point), point.z);
}

/** A bot on the failing (or fallen) span: where to run to, else null. */
export function spanEscape(game, p) {
  const view = bridgeView(game);
  if (!view?.closed || !p || !onBridgeSpan(p.x, p.y, p.z)) return null;
  return bridgeheadPoint(p.x < IRON_BRIDGE.x ? -1 : 1, p.z);
}

/** True when a straight drive from `a` to `b` would cross the closed span. */
export function crossesClosedSpan(game, a, b) {
  return !!bridgeView(game)?.closed && crossesBridgeSpan(a, b);
}
