// Conquest map events (docs/conquest.md "Map events"): the shared registry,
// phases, tuning and wire codec of the scripted battlefield events (dam
// breach, fuel depot, weir, relay mast, grain elevator, quarry rockslide,
// comeback call-in, supply airdrop). The Iron Bridge collapse predates the
// framework and keeps its own module (shared/conquest-bridge.js).
//
// HOW TO ADD AN EVENT (each step names the file; keep every number in data):
//  1. shared/map-events/<id>.js: `export const <ID>_EVENT = defineMapEvent({...})`
//     (id, maps, kind, name, glyph, anchor, flag, big, repeat, breakthrough,
//     durations, points, targets, killKeys, tuning; see ./map-events/define.js).
//     Fill your two slot lines in shared/map-events/registry.js.
//  2. server/modes/conquest/map-events/<id>.js: `class extends MapEventController`
//     (server/modes/conquest/map-events/controller.js) with the hooks you need
//     (onReset, onTick, onPhase, onUse, onTarget, botTasks); fill your slot in
//     server/modes/conquest/map-events/registry.js. Use the helpers on
//     `this.system`: interaction points, integrity targets, staged voxel edits,
//     hazard zones, the director, awards and credit.
//  3. Phases: idle -> armed -> warning -> active -> done (once per round) or
//     -> cooldown -> idle (repeat). `trigger()` asks the director for a slot;
//     every change emits one `map_event {event, phase, ...}` and rides
//     `match.conquest.ev` for late joiners. Voxel changes go through
//     StagedEdits only (block deltas: joiners get them via the map cache).
//  4. Bots: post tasks from `botTasks(team, view)` (go use / hold / defend a
//     point with a priority and squad size); hazards are avoided for you.
//  5. Client: public/js/ui/conquest/map-events/<id>.js presenter (banner text,
//     map paint, markers; slot in .../map-events/registry.js) and FX in
//     public/js/fx/map-events/<id>.js (slot in .../fx/map-events/registry.js).
//  6. Tests: tools/conquest-map-event-<id>-test.mjs in `conquest:test`, with
//     the fixture helpers of tools/lib/map-event-fixtures.mjs; docs: your
//     subsection under docs/conquest.md "Map events" and the map doc.
import { MAP_EVENT_DEFS } from './map-events/registry.js';

export { defineMapEvent, MAP_EVENT_KINDS, MAP_EVENT_POINT_TEAMS } from './map-events/define.js';
export {
  boxDistance, insideBox, integrityBlastDamage, segmentCrossesZone, zoneCenter, zoneContains, zoneExit, zoneFlatDistance,
} from './map-events/geometry.js';
export { MAP_EVENT_DEFS };

/** Phase order on the wire (`ev[i][1]`, the `map_event` event's `phase` name). */
export const MAP_EVENT_PHASES = Object.freeze(['idle', 'armed', 'warning', 'active', 'done', 'cooldown']);
export const MAP_EVENT_PHASE = Object.freeze(Object.fromEntries(MAP_EVENT_PHASES.map((p, i) => [p, i])));
/** The server -> client event kind, score reason and support intent type of the framework (contract v7). */
export const MAP_EVENT_KIND = 'map_event';
export const MAP_EVENT_SCORE_REASON = 'map_event';
export const MAP_EVENT_SUPPORT = 'use';
/** Teams on the wire: 0 alpha, 1 bravo, -1 none. */
export const TEAM_CODES = Object.freeze(['alpha', 'bravo']);
export const teamCode = team => TEAM_CODES.indexOf(team);
export const codeTeam = code => TEAM_CODES[code] ?? null;

/**
 * Framework tuning (every event's own numbers live in its definition).
 *  director     two `big` events never warn or peak together: a trigger while
 *               another big event warns, or within `peakMs` of its active
 *               start, waits (phase `armed`) until `gapMs` after that window.
 *               `repeatCap` bounds the fires of all repeating events a match.
 *  interaction  a hold advances while the user's newest `use` intent is at
 *               most `staleMs` old (the client re-sends at 5 Hz); moving out of
 *               the radius (plus `exitPad`), damage, death, down or a seat
 *               reset it; `dy` is the height band around the point.
 *  hazards      damage zones tick every `tickMs`; `pushCooldownMs` keeps an
 *               impulse zone from shoving the same body every tick.
 *  edits        staged voxel edits apply at most `cellsPerTick` cells a tick
 *               (block deltas), about 2.4 k cells per second at 60 Hz.
 *  score        `map_event` scales per action (SCORE_POINTS.map_event = 200):
 *               setting an event off or stopping it (a defuse) 200, a
 *               completed hold (a plant, a claim) 100, an assist 50.
 *  wire         `ev` + `evp` ride `match.conquest` under their own budget
 *               (like `recon`): the base 440 B has about 24 B left with 16
 *               bots (416 B max measured on Frontier, 40 s), so the event
 *               rows are measured apart. `extraMax` bounds a row's extra gauges.
 */
export const MAP_EVENT_RULES = Object.freeze({
  director: Object.freeze({ gapMs: 4000, peakMs: 8000, repeatCap: 8 }),
  interaction: Object.freeze({ staleMs: 350, exitPad: 0.75, dy: 2.5, damageResets: true }),
  hazards: Object.freeze({ tickMs: 250, pushCooldownMs: 1000, fleeMargin: 4 }),
  edits: Object.freeze({ cellsPerTick: 40 }),
  score: Object.freeze({ trigger: 1, defuse: 1, use: 0.5, assist: 0.25 }),
  wire: Object.freeze({ budgetBytes: 200, extraMax: 6 }),
});

/** Glyph (public/js/ui/conquest/icons.js ICON_PATHS) per kind when a definition names none. */
export const MAP_EVENT_KIND_GLYPHS = Object.freeze({ levolution: 'collapse', control: 'event-relay', callin: 'bomb', supply: 'event-crate' });
export const mapEventGlyph = def => def?.glyph ?? MAP_EVENT_KIND_GLYPHS[def?.kind] ?? 'event';

/* --------------------------------------------------------------- registry */

const sortedCache = new WeakMap();
/**
 * The events of a map, sorted by id: `ev[i][0]` indexes this list. Every
 * event of the map is listed whatever the variant (the server instantiates
 * only the ones active in it), so client and server agree from the map id.
 */
export function mapEventsFor(mapId, defs = MAP_EVENT_DEFS) {
  let byMap = sortedCache.get(defs);
  if (!byMap) sortedCache.set(defs, byMap = new Map());
  const key = String(mapId ?? '');
  if (!byMap.has(key)) byMap.set(key, Object.freeze(defs.filter(d => d.maps.includes(key)).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))));
  return byMap.get(key);
}

export const mapEventDef = (id, defs = MAP_EVENT_DEFS) => defs.find(d => d.id === id) ?? null;

/** The definition's anchor on `mapId` ({x, y?, z}) or null. */
export function mapEventAnchor(def, mapId) {
  const a = def?.anchor;
  if (!a) return null;
  return Number.isFinite(a.x) ? a : a[mapId] ?? null;
}

/** Kill feed keys of every registered event: {key: {label, icon, event}}. */
export function mapEventKillKeys(defs = MAP_EVENT_DEFS) {
  const out = {};
  for (const def of defs) for (const [key, v] of Object.entries(def.killKeys)) out[key] = Object.freeze({ ...v, event: def.id });
  return Object.freeze(out);
}
export const MAP_EVENT_KILL_KEYS = mapEventKillKeys();

/* ------------------------------------------------------------------- wire */

const pct = v => Math.max(0, Math.min(100, Math.round((Number(v) || 0) * 100)));
/** Default of each trailing `ev` field (index 2 progress, 3 team, 4 leftDs): a row drops trailing defaults. */
const EV_TRAIL = [null, null, 0, -1, -1];
/** Default of each trailing `evp` field (index 3 progress, 4 userTeam). */
const EVP_TRAIL = [null, null, null, 0, -1];
const trim = (row, defaults) => {
  while (row.length > 2 && defaults[row.length - 1] != null && row[row.length - 1] === defaults[row.length - 1]) row.pop();
  return row;
};

/**
 * `match.conquest.ev` row of one event that is not plain idle:
 *   [index, phase, progress100?, team?, leftDs?, extra?, x?, z?]
 * `progress100` is the event's own 0..100 gauge (integrity, fill, hold),
 * `team` the side that set it off (TEAM codes, -1 none), `leftDs` the
 * deciseconds to the phase's end (-1 open-ended), `extra` up to
 * MAP_EVENT_RULES.wire.extraMax small integers of the event's own (a gauge
 * per fuel tank, a water level; 0 when absent but an anchor follows), `x` /
 * `z` only for an anchor the event moved at runtime (an airdrop's landing
 * point). Trailing defaults are left out: a finished event is `[i, 4]`.
 */
export function encodeMapEventRow(index, state) {
  const left = Number.isFinite(state.leftMs) ? Math.max(0, Math.round(state.leftMs / 100)) : -1;
  const row = [index | 0, MAP_EVENT_PHASE[state.phase] ?? 0, pct(state.progress), teamCode(state.team), left];
  const extra = Array.isArray(state.extra) && state.extra.length
    ? state.extra.slice(0, MAP_EVENT_RULES.wire.extraMax).map(v => Math.round(Number(v) || 0)) : null;
  const a = state.anchor;
  if (a && Number.isFinite(a.x) && Number.isFinite(a.z)) row.push(extra ?? 0, Math.round(a.x), Math.round(a.z));
  else if (extra) row.push(extra);
  else trim(row, EV_TRAIL);
  return row;
}

/**
 * `match.conquest.evp` row of one enabled interaction point some team may use:
 *   [eventIndex, pointIndex, teamMask, progress100?, userTeam?, x?, y?, z?]
 * `teamMask` 1 WEST, 2 EAST, 3 both; `userTeam` the side holding it now
 * (-1 nobody); x/y/z (0.1 m) only for points the event placed at runtime.
 */
export function encodeMapEventPoint(eventIndex, pointIndex, point) {
  const mask = (point.teams?.has?.('alpha') ? 1 : 0) | (point.teams?.has?.('bravo') ? 2 : 0);
  const row = [eventIndex | 0, pointIndex | 0, mask, pct(point.progress), teamCode(point.userTeam)];
  if (point.dynamic) row.push(Math.round(point.x * 10) / 10, Math.round(point.y * 10) / 10, Math.round(point.z * 10) / 10);
  else trim(row, EVP_TRAIL);
  return row;
}

/**
 * Decode `ev` and `evp` against the map's registered events. Returns
 * `{ events: [{index, id, def, phase, progress, team, leftMs, extra, anchor}],
 * points: [{event, eventIndex, index, id, def, x, y, z, radius, holdMs, verb,
 * glyph, teams, progress, userTeam}] }`; rows naming an unknown index are skipped.
 */
export function decodeMapEvents(ev, evp, mapId, defs = MAP_EVENT_DEFS) {
  const list = mapEventsFor(mapId, defs);
  const events = [];
  for (const row of Array.isArray(ev) ? ev : []) {
    const def = Array.isArray(row) ? list[row[0] | 0] : null;
    if (!def) continue;
    const fixed = mapEventAnchor(def, mapId);
    const moved = Number.isFinite(row[6]) && Number.isFinite(row[7]);
    const anchor = moved ? { x: row[6], y: fixed?.y ?? null, z: row[7] } : fixed;
    const left = Number(row[4] ?? -1);
    events.push({ index: row[0] | 0, id: def.id, def, phase: MAP_EVENT_PHASES[row[1] | 0] ?? 'idle',
      progress: Math.max(0, Math.min(1, (Number(row[2]) || 0) / 100)), team: codeTeam(row[3] ?? -1),
      leftMs: left >= 0 ? left * 100 : null, extra: Array.isArray(row[5]) ? row[5] : null, anchor: anchor ?? null, moved });
  }
  const points = [];
  for (const row of Array.isArray(evp) ? evp : []) {
    const def = Array.isArray(row) ? list[row[0] | 0] : null;
    if (!def) continue;
    const k = row[1] | 0, base = def.points[k] ?? null;
    const dynamic = Number.isFinite(row[5]) && Number.isFinite(row[7]);
    if (!base && !dynamic) continue;
    const mask = row[2] | 0;
    points.push({ event: def.id, eventIndex: row[0] | 0, index: k, id: base?.id ?? `p${k}`, def,
      x: dynamic ? row[5] : base.x, y: dynamic ? row[6] : base.y, z: dynamic ? row[7] : base.z,
      radius: base?.radius ?? 2, holdMs: base?.holdMs ?? 4000, verb: base?.verb ?? 'USE', glyph: base?.glyph ?? mapEventGlyph(def),
      teams: [...(mask & 1 ? ['alpha'] : []), ...(mask & 2 ? ['bravo'] : [])],
      progress: Math.max(0, Math.min(1, (Number(row[3]) || 0) / 100)), userTeam: codeTeam(row[4] ?? -1) });
  }
  return { events, points };
}

/** Bytes `ev` + `evp` add to `match.conquest` (MAP_EVENT_RULES.wire.budgetBytes bounds it; the tests measure it). */
export function mapEventWireBytes(matchConquest) {
  const { ev, evp } = matchConquest ?? {};
  let n = 0;
  if (ev) n += JSON.stringify(ev).length + 6;    // ,"ev":
  if (evp) n += JSON.stringify(evp).length + 7;  // ,"evp":
  return n;
}

/** The `use` intent target id of an interaction point: `<eventId>:<pointIndex>` (at most 64 chars on the wire). */
export const mapEventPointKey = (eventId, pointIndex) => `${eventId}:${pointIndex | 0}`;

/**
 * The interaction point `self` (a living, unseated body of `team`) can use
 * now, nearest first, or null. Same reach rule as the server (radius flat,
 * MAP_EVENT_RULES.interaction.dy up or down).
 */
export function usableMapEventPoint(points, self, team, rules = MAP_EVENT_RULES.interaction) {
  if (!self || !Array.isArray(points)) return null;
  let best = null;
  for (const p of points) {
    if (!p.teams.includes(team)) continue;
    const d = Math.hypot(p.x - self.x, p.z - self.z);
    if (d > p.radius || Math.abs((p.y ?? self.y) - self.y) > rules.dy) continue;
    if (p.userTeam && p.userTeam !== team) continue;
    if (!best || d < best.d) best = { point: p, d };
  }
  return best?.point ?? null;
}
