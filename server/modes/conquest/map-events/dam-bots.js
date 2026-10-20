// Redrock Dam breach, the bots' value of closing crossings (docs/conquest.md
// "Redrock Dam breach" -> Bots): a local stand-in for the planned shared
// `crossingDenialValue` (G2, server/bot-map-events.js), on the same road graph
// the drivers route over (roadGraph, server/bot-vehicle-driving.js).
//
// For each living ground hull, the mean road metres to the flags its side
// does not hold, with the crossings open and with `close` shut; the value of
// shutting them for `team` is what the enemy's hulls lose minus what its own
// hulls lose (metres; a route the closure cuts off counts `capM`). Breaching
// pays when enemy armour depends on the crossing more than one's own does
// (an enemy tank column on the crest, enemy hulls heading for the far bank).
import { isAircraft } from '../../../../shared/vehicles.js';
import { roadGraph } from '../../../bot-vehicle-driving.js';

const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const ENTRY_NODES = 3;

/** Single-source road distances from a point (the nearest few nodes as entries), skipping `closed` crossing nodes. */
function roadDistances(graph, from, closed) {
  const n = graph.nodes.length, dist = new Float64Array(n).fill(Infinity), done = new Uint8Array(n);
  const entries = graph.nodes.map(node => ({ node, d: flat(node, from) })).sort((a, b) => a.d - b.d).slice(0, ENTRY_NODES);
  for (const { node, d } of entries) if (!closed.has(node.crossing)) dist[node.id] = Math.min(dist[node.id], d);
  for (;;) {
    let id = -1, best = Infinity;
    for (let i = 0; i < n; i++) if (!done[i] && dist[i] < best) { best = dist[i]; id = i; }
    if (id < 0) break;
    done[id] = 1;
    for (const [next, length] of graph.nodes[id].edges) {
      if (done[next] || closed.has(graph.nodes[next].crossing)) continue;
      const cost = best + length;
      if (cost < dist[next]) dist[next] = cost;
    }
  }
  return dist;
}

/** Road metres from `from` to the nearest of `goals` (points), through open crossings only. */
export function roadCost(graph, from, goals, closed = new Set()) {
  if (!graph.nodes.length || !goals.length) return Infinity;
  const dist = roadDistances(graph, from, closed);
  let best = Infinity;
  for (const goal of goals) {
    // Leave the road where the drivers do: at the node nearest the goal (no
    // cutting cross-country over a canyon from the nearest reachable node).
    let exit = null, near = Infinity;
    for (const node of graph.nodes) {
      if (closed.has(node.crossing)) continue;
      const d = flat(node, goal);
      if (d < near) { near = d; exit = node; }
    }
    if (!exit) continue;
    best = Math.min(best, dist[exit.id] + near);
  }
  return best;
}

/**
 * Metres of road the crossings `close` take from the enemy's ground hulls
 * minus those they take from `team`'s, averaged over the flags each hull's
 * side does not hold. `capM` bounds one route's loss (a cut-off route).
 */
export function crossingDenialLocal(game, team, close, { capM = 600, flags = game?.mode?.policy?.flags ?? [] } = {}) {
  const graph = roadGraph(game), closed = new Set(close);
  let value = 0;
  for (const hull of game?.vehicles?.vehicles?.values?.() ?? []) {
    if (!(hull.hp > 0) || !hull.team || isAircraft(hull.type) || hull.type === 'boat') continue;
    let loss = 0, n = 0;
    for (const f of flags) {
      if (f.owner === hull.team) continue;
      const goal = [{ x: f.x, z: f.z }], open = roadCost(graph, hull, goal);
      if (!Number.isFinite(open)) continue;
      const shut = roadCost(graph, hull, goal, closed);
      loss += Math.min(capM, Number.isFinite(shut) ? Math.max(0, shut - open) : capM); n++;
    }
    if (n) value += (hull.team === team ? -loss : loss) / n;
  }
  return value;
}
