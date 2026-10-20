// Iron Bridge collapse presentation (docs/conquest.md "Iron Bridge collapse").
// The fall itself is the structural system's (structure-fx.js draws the
// creak, the falling chunks and their landing); this adds what only the
// `bridge` events know: a metal groan when the supports give, the long groan
// with grit raining off the deck and a rising shake through the warning
// window, and the river burst and rumble as the span goes. Sounds reuse the
// structure voices (structureCreak / structureImpact, material 'metal');
// there is no dedicated recording or announcer line for the bridge.
//
// The same effects serve every levolution (a span, `deckY`, `waterY` and the
// material are options; ./map-events/levolution.js drives one per event from
// its `map_event` phases through `stage(name)`).
import { IRON_BRIDGE, IRON_BRIDGE_RULES } from '../../../shared/conquest-bridge.js';

/** Presentation tuning (no gameplay meaning). */
export const BRIDGE_FX = Object.freeze({
  /** Seconds between groans while the span is failing. */
  groanEvery: 0.62,
  /** Camera shake trauma: damaged, each groan (rising to the second value), the fall. */
  shake: Object.freeze({ damaged: 0.12, groan: Object.freeze([0.05, 0.16]), down: 0.55 }),
  /** Metres from the span centre at which the shake has faded out. */
  shakeRange: 150,
  /** Grit puffs per groan under the deck, and dust / water bursts when it falls. */
  grit: 5, dust: 9, water: 6,
});


/** Deterministic 0..1 noise (puff placement). */
function hash01(n) {
  let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export class BridgeFx {
  /**
   * @param {object} options
   * @param {object|null} options.audio        sfx facade (structureCreak / structureImpact)
   * @param {object|null} options.cameraShake  CameraShake bus
   * @param {() => object|null} options.getCamera
   * @param {object|null} options.fx           ParticleField (grit, dust, water)
   * @param {object} [options.span]             the falling footprint {x0, z0, x1, z1} (inclusive; default the Iron Bridge's)
   * @param {number} [options.deckY]            deck block row (grit under it, groans on it)
   * @param {number|null} [options.waterY]      water line under the span (null: dust only, no water bursts)
   * @param {string} [options.material]         structure voice material
   */
  constructor({ audio = null, cameraShake = null, getCamera = () => null, fx = null, rules = IRON_BRIDGE_RULES,
    span = IRON_BRIDGE.span, deckY = IRON_BRIDGE.deckY, waterY = IRON_BRIDGE.waterY, material = 'metal' } = {}) {
    this.audio = audio; this.cameraShake = cameraShake; this.getCamera = getCamera; this.fx = fx; this.rules = rules;
    this.span = span; this.deckY = deckY; this.waterY = waterY; this.material = material;
    this.center = Object.freeze([(span.x0 + span.x1 + 1) / 2, deckY + 0.5, (span.z0 + span.z1 + 1) / 2]);
    this.groan = null;
    this._seq = 0;
    this._params = { count: 0, scale: 1, alpha: 1, color: null, speed: 1, life: 1 };
  }

  /** Shake falloff 0..1 by the camera's distance to the span. */
  falloff() {
    const eye = this.getCamera?.()?.position;
    if (!eye) return 0;
    const d = Math.hypot(eye.x - this.center[0], eye.y - this.center[1], eye.z - this.center[2]);
    const f = Math.max(0, 1 - d / BRIDGE_FX.shakeRange);
    return f * f;
  }

  handleEvent(ev) {
    if (ev?.kind !== 'bridge' || ev.bridge !== IRON_BRIDGE.id) return false;
    return this.stage(ev.name, ev);
  }

  /**
   * One stage's effects: 'damaged' (a groan, grit, a shake), 'failing' (the
   * groans through the warning window: `leftMs` of it, default all of it),
   * 'down' (the rumble, dust and water as the span goes; `blocks` scales it).
   */
  stage(name, { blocks = 0, leftMs = null } = {}) {
    const ground = this.waterY ?? this.deckY - 6;
    if (name === 'damaged') {
      this.audio?.structureCreak?.(this.center, { n: 160, material: this.material, seconds: 0.9 });
      this._shake(BRIDGE_FX.shake.damaged);
      this._grit(BRIDGE_FX.grit);
    } else if (name === 'failing') {
      const total = this.rules.warnMs / 1000, left = Number.isFinite(leftMs) ? Math.max(0, Math.min(total, leftMs / 1000)) : total;
      this.groan = { left, total, next: 0 };
    } else if (name === 'down') {
      this.groan = null;
      this.audio?.structureImpact?.(this.center, { n: Math.max(200, blocks | 0), speed: 12, material: this.material });
      this._shake(BRIDGE_FX.shake.down);
      for (let i = 0; i < BRIDGE_FX.dust; i++) this._puff('dust', this._spanPoint(ground + 1.5), 4, 2.2, 1.2);
      if (this.waterY != null) for (let i = 0; i < BRIDGE_FX.water; i++) this._puff('water', this._spanPoint(this.waterY + 0.6), 10, 1.6, 1.4);
    } else return false;
    return true;
  }

  /** Per frame: the groans through the warning window. */
  update(dt) {
    const g = this.groan;
    if (!g || !(dt > 0)) return;
    g.left -= dt; g.next -= dt;
    if (g.left <= 0) { this.groan = null; return; }
    if (g.next > 0) return;
    g.next = BRIDGE_FX.groanEvery;
    const k = 1 - g.left / g.total;
    const at = this._spanPoint(this.deckY + 0.5);
    this.audio?.structureCreak?.(at, { n: 240 + 360 * k, material: this.material, seconds: 0.8 });
    const [a, b] = BRIDGE_FX.shake.groan;
    this._shake(a + (b - a) * k);
    this._grit(Math.round(BRIDGE_FX.grit * (1 + k)));
  }

  clear() { this.groan = null; }

  _shake(trauma) {
    const f = this.falloff();
    if (f > 0) this.cameraShake?.add?.(trauma * f);
  }

  _grit(n) { for (let i = 0; i < n; i++) this._puff('grit', this._spanPoint(this.deckY - 0.6), 6, 1, 1); }

  _spanPoint(y) {
    const i = ++this._seq, s = this.span;
    return [s.x0 + 0.5 + hash01(i * 3) * (s.x1 - s.x0), y, s.z0 + 0.5 + hash01(i * 3 + 1) * (s.z1 - s.z0)];
  }

  _puff(kind, pos, count, scale, speed) {
    if (!this.fx?.emit) return 0;
    const p = this._params;
    p.count = count; p.scale = scale; p.alpha = 1; p.color = null; p.speed = speed; p.life = 1;
    return this.fx.emit(kind, pos, p);
  }
}
