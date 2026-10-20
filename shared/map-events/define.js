// Map event definitions (docs/conquest.md "Map events"): `defineMapEvent`
// checks and freezes one event's data. Every event lives in its own file
// under shared/map-events/ and is listed once in ./registry.js; its server
// controller, HUD presenter and FX hooks register under the same id.

/** Presentation classes: the default glyph, banner tone and marker of an event. */
export const MAP_EVENT_KINDS = Object.freeze(['levolution', 'control', 'callin', 'supply']);
/** Team filters of an interaction point (attackers / defenders read the Breakthrough sides, `trigger` / `rival` the event's team). */
export const MAP_EVENT_POINT_TEAMS = Object.freeze(['any', 'alpha', 'bravo', 'trigger', 'rival', 'none']);

const ID = /^[a-z][a-z0-9-]{0,23}$/;
const finite = Number.isFinite;
const point3 = (p, what) => {
  if (!p || !finite(p.x) || !finite(p.z) || (p.y !== undefined && !finite(p.y))) throw new Error(`${what}: x, z (and y) must be finite`);
  return Object.freeze({ x: p.x, ...(finite(p.y) ? { y: p.y } : {}), z: p.z });
};
const box = (b, what) => {
  for (const k of ['x0', 'y0', 'z0', 'x1', 'y1', 'z1']) if (!finite(b?.[k])) throw new Error(`${what}: box needs ${k}`);
  return Object.freeze({ ...(b.id ? { id: String(b.id) } : {}), x0: b.x0, y0: b.y0, z0: b.z0, x1: b.x1, y1: b.y1, z1: b.z1 });
};

/**
 * Check and freeze one event definition:
 *
 *   id          'dam' (lower case, unique; the HUD, the server controller and the FX register under it)
 *   maps        ['redrock'] (one or both battlefield ids)
 *   kind        one of MAP_EVENT_KINDS
 *   name        'REDROCK DAM' (HUD and banner name)
 *   short       'DAM' (world marker and map label; default: the name's last word)
 *   glyph       an ICON_PATHS name for banners and markers (default by kind)
 *   texts       banner texts per phase: {warning: {title, detail, countdown, own?, enemy?}, ...}
 *               (`title` follows the name, `countdown` labels the seconds, e.g. 'BREACH IN';
 *               `own` / `enemy` replace title / detail when the event's team is / is not the viewer's)
 *   anchor      {x, y?, z} or {frontier: {...}, redrock: {...}}: the marker point (null for events that publish one at runtime)
 *   flag        nearest flag id or null (bots and the HUD group the event with it)
 *   big         true: the director never lets two big events warn or peak at once
 *   repeat      null (once per round) or {cooldownMs, max} (idle again after the cooldown, at most `max` fires a match)
 *   breakthrough  false keeps the event out of the Breakthrough variant
 *   durations   {armedMs, warningMs, activeMs}: default phase lengths (null: the controller advances it)
 *   points      [{id, x, y, z, radius, holdMs, teams, verb, glyph, enabled}] hold-to-use spots (see interactions.js)
 *   targets     [{id, boxes:[box], integrity, supportDamage?, minReach?}] blast integrity pools (see integrity.js)
 *   killKeys    {key: {label, icon}}: kill feed keys of the event's hazards (credited to the trigger);
 *               the first one is the default `killKey` of the event's hazard zones
 *   cues        objective audio per phase: {warning: {stinger, own, enemy, any}, ...}; `stinger` one of
 *               OBJECTIVE_STINGERS (public/js/audio/objective-cues.js), `own` / `enemy` / `any` an existing
 *               announcer cue (shared/announcer.js: 'winning', 'losing', 'tickets_low', or 'under_attack',
 *               'captured', 'lost' for the event's flag), null for none. Without cues: the alarm stinger
 *               as it warns, the hit as it strikes, no announcer line
 *   tuning      free-form frozen data for the event's own logic
 */
export function defineMapEvent(def) {
  if (!def || !ID.test(def.id ?? '')) throw new Error(`map event id ${def?.id} must match ${ID}`);
  const what = `map event ${def.id}`;
  const maps = Object.freeze([...(Array.isArray(def.maps) ? def.maps : [def.map])].filter(Boolean).map(String));
  if (!maps.length) throw new Error(`${what}: needs maps`);
  if (!MAP_EVENT_KINDS.includes(def.kind)) throw new Error(`${what}: kind must be one of ${MAP_EVENT_KINDS.join(', ')}`);
  let anchor = null;
  if (def.anchor && finite(def.anchor.x)) anchor = point3(def.anchor, what);
  else if (def.anchor) anchor = Object.freeze(Object.fromEntries(Object.entries(def.anchor).map(([map, p]) => [map, point3(p, `${what} anchor ${map}`)])));
  const points = Object.freeze((def.points ?? []).map((p, i) => {
    if (!ID.test(p.id ?? '')) throw new Error(`${what}: point ${i} needs an id`);
    const teams = p.teams ?? 'any';
    if (!MAP_EVENT_POINT_TEAMS.includes(teams)) throw new Error(`${what}: point ${p.id} teams ${teams}`);
    return Object.freeze({ id: p.id, ...point3(p, `${what} point ${p.id}`), y: finite(p.y) ? p.y : 0,
      radius: finite(p.radius) && p.radius > 0 ? p.radius : 2, holdMs: finite(p.holdMs) && p.holdMs >= 0 ? p.holdMs : 4000,
      teams, verb: String(p.verb ?? 'USE').toUpperCase(), glyph: p.glyph ?? null, enabled: p.enabled !== false });
  }));
  if (new Set(points.map(p => p.id)).size !== points.length) throw new Error(`${what}: duplicate point ids`);
  const targets = Object.freeze((def.targets ?? []).map((t, i) => {
    if (!ID.test(t.id ?? '')) throw new Error(`${what}: target ${i} needs an id`);
    const boxes = Object.freeze((t.boxes ?? []).map((b, j) => box({ id: b.id ?? `${t.id}-${j}`, ...b }, `${what} target ${t.id}`)));
    if (!boxes.length || !(t.integrity > 0)) throw new Error(`${what}: target ${t.id} needs boxes and integrity`);
    return Object.freeze({ id: t.id, boxes, integrity: t.integrity,
      ...(t.supportDamage ? { supportDamage: Object.freeze({ ...t.supportDamage }) } : {}),
      ...(finite(t.minReach) ? { minReach: t.minReach } : {}) });
  }));
  const killKeys = Object.freeze(Object.fromEntries(Object.entries(def.killKeys ?? {}).map(([key, v]) => {
    if (!/^[a-z][a-zA-Z0-9_]{1,31}$/.test(key)) throw new Error(`${what}: kill key ${key}`);
    return [key, Object.freeze({ label: String(v?.label ?? key).toUpperCase(), icon: v?.icon ?? 'collapse' })];
  })));
  const texts = Object.freeze(Object.fromEntries(Object.entries(def.texts ?? {}).map(([phase, t]) => {
    const text = v => (v == null ? undefined : String(v).toUpperCase());
    const side = v => (v ? Object.freeze({ ...(v.title != null ? { title: text(v.title) } : {}), ...(v.detail != null ? { detail: text(v.detail) } : {}) }) : undefined);
    return [phase, Object.freeze({ ...(t?.title != null ? { title: text(t.title) } : {}), ...(t?.detail != null ? { detail: text(t.detail) } : {}),
      ...(t?.countdown != null ? { countdown: text(t.countdown) } : {}), ...(t?.own ? { own: side(t.own) } : {}), ...(t?.enemy ? { enemy: side(t.enemy) } : {}) })];
  })));
  const cues = def.cues ? Object.freeze(Object.fromEntries(Object.entries(def.cues).map(([phase, c]) => {
    if (!['armed', 'warning', 'active', 'done', 'cooldown', 'idle'].includes(phase)) throw new Error(`${what}: cues phase ${phase}`);
    const pick = k => (c?.[k] == null ? null : String(c[k]));
    return [phase, Object.freeze({ stinger: pick('stinger'), own: pick('own'), enemy: pick('enemy'), any: pick('any') })];
  }))) : null;
  const name = String(def.name ?? def.id).toUpperCase();
  const durations = Object.freeze({ armedMs: null, warningMs: null, activeMs: null, ...(def.durations ?? {}) });
  const repeat = def.repeat ? Object.freeze({ cooldownMs: Math.max(0, def.repeat.cooldownMs ?? 60000), max: Math.max(1, def.repeat.max ?? 3) }) : null;
  return Object.freeze({
    id: def.id, maps, kind: def.kind, name, short: String(def.short ?? name.split(/\s+/).at(-1)).toUpperCase(), glyph: def.glyph ?? null, texts,
    anchor, flag: def.flag ?? null, big: def.big !== false, repeat, breakthrough: def.breakthrough !== false,
    durations, points, targets, killKeys, cues, tuning: Object.freeze({ ...(def.tuning ?? {}) }),
  });
}
