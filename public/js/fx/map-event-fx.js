// Conquest map events in the world (docs/conquest.md "Map events"): the
// presentation kit every event's FX hook (./map-events/registry.js) builds
// on. Presentation only: it reads `map_event` events and the snapshot's
// `match.conquest.ev` rows and never decides anything.
//
//   shake(at, trauma, rangeM)   camera shake that falls off with the
//                               camera's distance to `at` (squared, as the
//                               Iron Bridge's), 0 beyond rangeM
//   puff(kind, pos, opts)       one particle burst (FX_KINDS: dust, smoke,
//                               smokeColumn, fire, spark, debris, water, ember, grit)
//   emitter(key, spec)          a standing source (a burning depot, a smoke
//                               column seen across the map) under a key
//                               `<eventId>:<name>`, kept until stopEmitter(key),
//                               the event leaves the snapshot, clear() or `until` s
//   sound.blast / creak / impact  the existing explosion and structure voices
//   anchor(id)                  the event's marker point on this map
//   scene()                     the world scene, for an event's own meshes (an
//                               airdrop's transport and crate); null in tests
//   tier / selfTeam / reducedMotion  the graphics tier (fixed at map load), the
//                               viewer's side and the display setting, for
//                               hooks that scale or colour their meshes
//
// Without a hook an event gets the generic strike: as a `levolution` or
// `callin` event goes active, a shake, a ring of dust and the structure
// rumble at its anchor. There is no dedicated recording or announcer line
// for any map event; the objective cues (objective-cues.js) reuse the alarm
// and hit stingers and the definition's existing announcer cues.
import { MAP_EVENT_DEFS, MAP_EVENT_KIND, decodeMapEvents, mapEventAnchor, mapEventDef } from '../../../shared/conquest-map-events.js';
import { MAP_EVENT_FX } from './map-events/registry.js';

/** Presentation tuning (no gameplay meaning). */
export const MAP_EVENT_FX_RULES = Object.freeze({
  /** Generic strike: trauma, fade-out range (m), dust puffs and their ring radius (m). */
  strike: Object.freeze({ trauma: 0.45, rangeM: 220, dust: 10, ringM: 9 }),
  /** Kinds that get the generic strike as they go active. */
  strikeKinds: Object.freeze(['levolution', 'callin']),
});

/** Deterministic 0..1 noise (puff placement). */
function hash01(n) {
  let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export class MapEventFx {
  /**
   * @param {object} options
   * @param {object|null} options.audio        sfx facade (explosion, structureCreak, structureImpact)
   * @param {object|null} options.cameraShake  CameraShake bus
   * @param {() => object|null} options.getCamera
   * @param {object|null} options.fx           ParticleField
   * @param {object|null} [options.scene]      THREE.Scene for an event's own meshes
   * @param {object} [options.hooks]           id -> FX hook (default: the registry)
   * @param {Array} [options.defs]             event definitions (default: the registry)
   * @param {string} [options.tier]            graphics tier ('low' .. 'ultra')
   */
  constructor({ audio = null, cameraShake = null, getCamera = () => null, fx = null, scene = null, hooks = MAP_EVENT_FX, defs = MAP_EVENT_DEFS, tier = 'medium' } = {}) {
    this.audio = audio; this.cameraShake = cameraShake; this.getCamera = getCamera; this.fx = fx; this._scene = scene;
    this.tier = tier; this.selfTeam = null; this.reducedMotion = false;
    this.hooks = hooks ?? {}; this.defs = defs;
    this.mapId = null;
    this.emitters = new Map();
    this.seen = new Set();
    this.events = [];
    this._ev = null;
    this._seq = 0;
    this._params = { count: 0, scale: 1, alpha: 1, color: null, speed: 1, life: 1 };
    const self = this;
    this.sound = Object.freeze({
      blast: (pos, type = 'rocket') => self.audio?.explosion?.(pos, type),
      creak: (pos, opts = {}) => self.audio?.structureCreak?.(pos, { n: 200, material: 'stone', seconds: 0.8, ...opts }),
      impact: (pos, opts = {}) => self.audio?.structureImpact?.(pos, { n: 240, speed: 10, material: 'stone', ...opts }),
    });
  }

  hook(id) { return this.hooks?.[id] ?? null; }

  /** The marker point of an event on this map ([x, y, z]) or null. */
  anchor(id) {
    const live = this.events.find(e => e.id === id)?.anchor;
    const a = live ?? mapEventAnchor(mapEventDef(id, this.defs), this.mapId);
    return a && Number.isFinite(a.x) ? [a.x, Number.isFinite(a.y) ? a.y : 30, a.z] : null;
  }

  camera() { return this.getCamera?.() ?? null; }

  scene() { return this._scene ?? null; }

  /** Shake falloff 0..1 by the camera's distance to `at`. */
  falloff(at, rangeM) {
    const eye = this.getCamera?.()?.position;
    if (!eye || !at) return 0;
    const d = Math.hypot(eye.x - at[0], eye.y - at[1], eye.z - at[2]);
    const f = Math.max(0, 1 - d / Math.max(1, rangeM));
    return f * f;
  }

  shake(at, trauma, rangeM = MAP_EVENT_FX_RULES.strike.rangeM) {
    const f = this.falloff(at, rangeM);
    if (f > 0 && trauma > 0) this.cameraShake?.add?.(trauma * f);
    return f;
  }

  puff(kind, pos, { count = 6, scale = 1, alpha = 1, color = null, speed = 1, life = 1 } = {}) {
    if (!this.fx?.emit || !pos) return 0;
    const p = this._params;
    p.count = count; p.scale = scale; p.alpha = alpha; p.color = color; p.speed = speed; p.life = life;
    return this.fx.emit(kind, pos, p);
  }

  /** A standing source under `key` (a second call with the same key replaces it). */
  emitter(key, { kind = 'smoke', pos, rate = 8, params = {}, until = Infinity } = {}) {
    this.stopEmitter(key);
    const handle = this.fx?.addEmitter?.({ kind, pos, rate, params, until }) ?? null;
    if (handle) this.emitters.set(key, handle);
    return handle;
  }

  stopEmitter(key) {
    const handle = this.emitters.get(key);
    if (handle) this.fx?.removeEmitter?.(handle);
    return this.emitters.delete(key);
  }

  /** A point on a ring of radius `r` around `at` (deterministic). */
  ring(at, r, y = at?.[1] ?? 0) {
    const i = ++this._seq, a = hash01(i * 7) * Math.PI * 2, d = r * (0.35 + 0.65 * hash01(i * 7 + 3));
    return [at[0] + Math.cos(a) * d, y, at[2] + Math.sin(a) * d];
  }

  handleEvent(ev) {
    if (ev?.kind !== MAP_EVENT_KIND || typeof ev.event !== 'string') return false;
    const hook = this.hook(ev.event);
    if (hook?.onEvent?.(ev, this) === true) return true;
    if (ev.note || ev.phase !== 'active') return !!hook;
    const def = mapEventDef(ev.event, this.defs);
    if (!def || !MAP_EVENT_FX_RULES.strikeKinds.includes(def.kind)) return !!hook;
    const at = Array.isArray(ev.pos) ? ev.pos : this.anchor(ev.event);
    if (!at) return false;
    const s = MAP_EVENT_FX_RULES.strike;
    this.shake(at, s.trauma, s.rangeM);
    this.sound.impact(at, { n: 320 });
    for (let i = 0; i < s.dust; i++) this.puff('dust', this.ring(at, s.ringM, at[1] + 1), { count: 4, scale: 2.4, speed: 1.3 });
    return true;
  }

  /**
   * Per frame: the snapshot's event rows (decoded when the `ev` array
   * changes) to the hooks' `sync`, then their `update`.
   */
  update(dt, { match = null, mapId = null, selfTeam, reducedMotion } = {}) {
    if (mapId && mapId !== this.mapId) { this.clear(); this.mapId = mapId; }
    if (selfTeam !== undefined) this.selfTeam = selfTeam ?? null;
    if (reducedMotion !== undefined) this.reducedMotion = !!reducedMotion;
    const ev = match?.conquest?.ev ?? null;
    if (ev !== this._ev) { this._ev = ev; this.events = ev ? decodeMapEvents(ev, null, this.mapId, this.defs).events : []; }
    for (const event of this.events) {
      const fresh = !this.seen.has(event.id);
      this.seen.add(event.id);
      this.hook(event.id)?.sync?.(event, this, { fresh });
    }
    // An event that left the snapshot (back to idle, a rematch): its standing sources go.
    if (this.seen.size > this.events.length) {
      for (const id of [...this.seen]) {
        if (this.events.some(e => e.id === id)) continue;
        this.seen.delete(id);
        this.end(id);
      }
    }
    for (const hook of Object.values(this.hooks ?? {})) hook?.update?.(dt, this);
  }

  /** The event `id` went quiet: its emitters (keys `<id>:...`) stop and its hook's `end` runs. */
  end(id) {
    for (const key of [...this.emitters.keys()]) if (key.startsWith(`${id}:`)) this.stopEmitter(key);
    this.hook(id)?.end?.(this);
  }

  /** Match end, rematch, leave: every standing source goes, the hooks reset. */
  clear() {
    for (const key of [...this.emitters.keys()]) this.stopEmitter(key);
    for (const hook of Object.values(this.hooks ?? {})) hook?.clear?.(this);
    this.seen.clear();
    this.events = [];
    this._ev = null;
  }
}
