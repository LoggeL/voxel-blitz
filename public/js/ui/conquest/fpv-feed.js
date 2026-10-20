/**
 * The Engineer's FPV drone feed (design docs/design/conquest/fpv/, variant C):
 * while the own drone flies, the infantry HUD gives way to the goggle view.
 * A soft vignette and analog static that thickens as the signal fades, a
 * square centre reticle, and one instrument strip at the bottom centre in the
 * vehicle-card style: FPV DRONE with the drones left, BATTERY (seconds and a
 * bar), SIGNAL (four bars), SPEED, ALT and RANGE (to the operator). The key
 * hints show for FPV_HINT_MS after a launch only. Every value comes from the
 * snapshot through FpvPilot.telemetry (public/js/session/fpv-controller.js).
 * fpvBanner turns the server's `fpv` events into HUD banners.
 *
 * The launch and link-loss frames (docs/design/conquest/fpv-handset/, variant
 * A; timed by public/js/session/fpv-transition.js): `boot` 1..0 brings the
 * feed up out of full static, `lost` is the SIGNAL LOST frame, heavy snow and
 * tear lines over the last picture with only the label on it.
 */
import { el } from '../hud-support.js';
import { svgIcon } from './icons.js';
import { FPV_RULES } from '../../../../shared/fpv-rules.js';

/** Key hints stay up this long after a launch (the HUD rule: no permanent keybind line). */
export const FPV_HINT_MS = 6000;
/** Battery seconds under which the readout turns amber, then red. */
const LOW_SECONDS = 12, CRITICAL_SECONDS = 6;
const STATIC_W = 384, STATIC_H = 240;
/** Snow alpha at full noise: close to unwatchable, the world only glimpsed through it. */
const STATIC_MAX = 0.8;
/** A dropout lasts FPV_RULES.static.dropMs: the snow freezes over the whole picture. */
const DROP_MS = FPV_RULES.static.dropMs, DROP_ALPHA = 236;
/** Tear lines per frame at full tear, and the rolling hold bar's speed (rows per ms) and height. */
const TEARS = 6, ROLL_SPEED = 0.05, ROLL_ROWS = 18;
const hash = n => {
  let h = (n | 0) * 2654435761 >>> 0;
  h ^= h >>> 15; h = Math.imul(h, 2246822519) >>> 0; h ^= h >>> 13;
  return h >>> 0;
};
const finite = (value, fallback = 0) => (Number.isFinite(value) ? value : fallback);

/** Static over the SIGNAL LOST frame: near full snow, torn and bleeding, half the picture blanked. */
export const FPV_LOST_STATIC = Object.freeze({ noise: 1, tear: 0.75, bleed: 0.45, blank: 0.5 });
/** Under the boot static the picture starts this blank (fading with `boot`). */
const BOOT_BLANK = 0.55;

/**
 * The feed model of one telemetry frame (null while no drone flies). Pure:
 * text and levels only. `boot` (0..1) and `lost` come from the transition
 * (FpvTransition frame): the static rises to them, the strip fades under them.
 */
export function fpvFeedModel(telemetry, { hints = '', boot = 0, lost = false } = {}) {
  if (!telemetry) return null;
  const up = Math.max(0, Math.min(1, finite(boot)));
  const seconds = Math.max(0, Math.round(finite(telemetry.seconds)));
  const left = Number.isInteger(telemetry.left) ? telemetry.left : null;
  return {
    battery: Math.max(0, Math.min(1, finite(telemetry.battery))), seconds, batteryText: `${seconds} S`,
    batteryTone: seconds <= CRITICAL_SECONDS ? 'critical' : seconds <= LOW_SECONDS ? 'low' : 'ok',
    bars: Math.max(0, telemetry.bars | 0), maxBars: Math.max(1, telemetry.maxBars | 0 || 4),
    signalTone: telemetry.bars <= 1 ? 'critical' : telemetry.degraded ? 'low' : 'ok',
    speedText: `${Math.round(finite(telemetry.speed))} M/S`,
    altText: Number.isFinite(telemetry.altitude) ? `${Math.round(telemetry.altitude)} M` : '— M',
    rangeText: `${Math.round(finite(telemetry.distance))} M`,
    leftText: left === null ? '' : `${left} LEFT`,
    noise: lost ? FPV_LOST_STATIC.noise : Math.max(up, Math.min(1, Math.max(0, finite(telemetry.noise)))),
    tear: lost ? FPV_LOST_STATIC.tear : Math.max(up * 0.5, Math.min(1, Math.max(0, finite(telemetry.tear)))),
    bleed: lost ? FPV_LOST_STATIC.bleed : Math.max(0, Math.min(1, finite(telemetry.bleed))),
    drop: lost ? 0 : Math.max(0, finite(telemetry.drop)),
    blank: lost ? FPV_LOST_STATIC.blank : up * BOOT_BLANK,
    phase: lost ? 'lost' : up > 0 ? 'boot' : 'live', boot: lost ? 0 : up,
    roll: finite(telemetry.roll), hints,
  };
}

const REFUSED_DETAIL = Object.freeze({
  kit: 'PICK THE FPV GADGET ON THE DEPLOY SCREEN', state: 'STAND ON THE GROUND FIRST', busy: 'ONE DRONE AT A TIME',
  empty: 'A SUPPORT RESUPPLIES ONE DRONE', blocked: 'NO ROOM OVERHEAD', cooldown: 'NEXT DRONE READY SOON',
});
const CUT_DETAIL = Object.freeze({
  hit: 'YOU WERE HIT · THE DRONE FALLS', signal: 'OUT OF RANGE · THE DRONE FALLS', battery: 'BATTERY EMPTY · THE DRONE FALLS',
  released: 'THE DRONE FALLS AND DETONATES', lost: 'THE DRONE FALLS',
});

/** A HUD banner for an own `fpv` event (shared/conquest-contract.js), else null. */
export function fpvBanner(ev, selfId) {
  if (ev?.kind !== 'fpv' || selfId == null || String(ev.id) !== String(selfId)) return null;
  if (ev.state === 'refused') {
    const detail = ev.reason === 'cooldown' && Number.isFinite(ev.waitMs) ? `READY IN ${Math.max(1, Math.ceil(ev.waitMs / 1000))} S` : REFUSED_DETAIL[ev.reason] || 'NOT HERE';
    return { key: `fpv:refused:${ev.reason}`, tone: 'enemy', title: 'CANNOT LAUNCH DRONE', detail, priority: 2 };
  }
  if (ev.state === 'cut') return { key: `fpv:cut:${ev.vehicleId}`, tone: 'enemy', title: 'LINK LOST', detail: CUT_DETAIL[ev.reason] || CUT_DETAIL.lost, priority: 3 };
  if (ev.state === 'lost') return { key: `fpv:lost:${ev.vehicleId}`, tone: 'enemy', title: 'DRONE SHOT DOWN', detail: 'THE CHARGE DID NOT FIRE', priority: 3 };
  return null;
}

export class FpvFeed {
  constructor(parent, { hints = '' } = {}) {
    this.root = el('section', 'cq-fpv', parent);
    this.root.hidden = true;
    this.root.setAttribute('aria-label', 'FPV drone feed');
    // The video layer (static and vignette) sits on the picture under every HUD panel, the kill feed too.
    this.video = el('div', 'cq-fpv-video', parent?.ownerDocument?.body ?? parent);
    this.video.hidden = true;
    this.video.setAttribute('aria-hidden', 'true');
    this.canvas = el('canvas', 'cq-fpv-static', this.video);
    this.canvas.width = STATIC_W; this.canvas.height = STATIC_H;
    this.context = this.canvas.getContext?.('2d') ?? null;
    this.image = this.context?.createImageData?.(STATIC_W, STATIC_H) ?? null;
    // Blanks the picture under the boot static and the SIGNAL LOST snow.
    this.blank = el('div', 'cq-fpv-blank', this.video);
    this.blank.style.opacity = '0';
    el('div', 'cq-fpv-vignette', this.video);
    el('div', 'cq-fpv-reticle', this.root);
    this.horizon = el('div', 'cq-fpv-horizon', this.root);
    this.hints = el('div', 'cq-fpv-hint', this.root);
    this.hints.hidden = true;
    this._hintText = hints;
    const strip = el('div', 'cq-fpv-strip', this.root);
    const id = el('div', 'cq-fpv-id', strip);
    const icon = svgIcon(globalThis.document, 'fpv', 'cq-fpv-icon');
    if (icon) id.appendChild(icon);
    const name = el('div', 'cq-fpv-name', id);
    el('b', '', name).textContent = 'FPV DRONE';
    this.left = el('span', '', name);
    this.cells = {};
    for (const [key, label] of [['battery', 'BATTERY'], ['signal', 'SIGNAL'], ['speed', 'SPEED'], ['alt', 'ALT'], ['range', 'RANGE']]) {
      const cell = el('div', `cq-fpv-cell cq-fpv-${key}`, strip);
      el('span', 'cq-fpv-label', cell).textContent = label;
      this.cells[key] = cell;
      if (key === 'signal') {
        const bars = el('div', 'cq-fpv-bars', cell);
        this.bars = [0, 1, 2, 3].map(() => el('i', '', bars));
      } else this.cells[`${key}Value`] = el('b', 'cq-fpv-value', cell);
      if (key === 'battery') this.batteryFill = el('i', '', el('div', 'cq-fpv-meter', cell));
    }
    // SIGNAL LOST (design variant A): a navy plate with a red accent bar, centred on the snow.
    this.lost = el('div', 'cq-fpv-lost', this.root);
    this.lost.hidden = true;
    el('b', '', this.lost).textContent = 'SIGNAL LOST';
    el('span', '', this.lost).textContent = 'NO VIDEO LINK';
    this._sig = ''; this._hintAt = -Infinity; this._was = false; this._dropSlot = null;
    this.model = null;
  }

  setHints(text) { this._hintText = text; }

  /** `clockMs` (a monotonic clock) times the key hints and the static grain. */
  update(model, { clockMs = 0 } = {}) {
    this.model = model;
    const doc = globalThis.document;
    if (!model) {
      if (!this.root.hidden) { this.root.hidden = true; this.video.hidden = true; }
      if (doc?.body?.dataset?.fpv) delete doc.body.dataset.fpv;
      if (this.root.dataset.phase) delete this.root.dataset.phase;
      this._was = false;
      return;
    }
    if (!this._was) { this._was = true; this._hintAt = clockMs; }
    if (this.root.hidden) { this.root.hidden = false; this.video.hidden = false; }
    if (doc?.body?.dataset && doc.body.dataset.fpv !== 'true') doc.body.dataset.fpv = 'true';
    const phase = model.phase || 'live';
    if (this.root.dataset.phase !== phase) { this.root.dataset.phase = phase; this.lost.hidden = phase !== 'lost'; }
    // The strip, the reticle and the horizon come up out of the boot static.
    const shown = phase === 'boot' ? (1 - model.boot).toFixed(2) : '';
    if (this.root.style.getPropertyValue('--fpv-shown') !== shown) {
      if (shown) this.root.style.setProperty('--fpv-shown', shown); else this.root.style.removeProperty('--fpv-shown');
    }
    const blank = finite(model.blank).toFixed(2);
    if (this.blank.style.opacity !== blank) this.blank.style.opacity = blank;
    const hint = model.hints || this._hintText;
    const showHint = !!hint && clockMs - this._hintAt < FPV_HINT_MS;
    if (this.hints.hidden === showHint) this.hints.hidden = !showHint;
    const sig = [model.batteryText, model.batteryTone, Math.round(model.battery * 100), model.bars, model.signalTone, model.speedText,
      model.altText, model.rangeText, model.leftText, showHint ? hint : ''].join('|');
    if (sig !== this._sig) {
      this._sig = sig;
      this.cells.batteryValue.textContent = model.batteryText;
      this.cells.battery.dataset.tone = model.batteryTone;
      this.batteryFill.style.width = `${Math.round(model.battery * 100)}%`;
      this.bars.forEach((bar, i) => { bar.dataset.on = String(i < model.bars); });
      this.cells.signal.dataset.tone = model.signalTone;
      this.cells.speedValue.textContent = model.speedText;
      this.cells.altValue.textContent = model.altText;
      this.cells.rangeValue.textContent = model.rangeText;
      this.left.textContent = model.leftText;
      if (showHint) this.hints.textContent = hint;
    }
    this.horizon.style.transform = `translate(-50%, -50%) rotate(${(-model.roll * 180 / Math.PI).toFixed(1)}deg)`;
    this._paintStatic(model, clockMs);
  }

  /**
   * Analog static, one pass over a reused buffer per frame: snow whose alpha
   * is the noise level, horizontal tear lines (bright streaks and a rolling
   * hold bar) and colour bleed (rows drifting red and cyan) as the link
   * stretches, and dropouts: for DROP_MS the snow freezes over the picture.
   */
  _paintStatic(model, clockMs) {
    const noise = model.noise;
    const on = !!this.context && !!this.image && noise > 0.01;
    const opacity = on ? '1' : '0';
    if (this.canvas.style.opacity !== opacity) this.canvas.style.opacity = opacity;
    if (!on) return;
    // A dropout slot: chance drop × DROP_MS per slot, the same for every frame inside it.
    const slot = Math.floor(clockMs / DROP_MS);
    const dropped = model.drop > 0 && hash(slot) / 4294967296 < model.drop * DROP_MS / 1000;
    if (dropped && this._dropSlot === slot) return;
    this._dropSlot = dropped ? slot : null;
    const data = this.image.data, tear = model.tear, bleed = model.bleed;
    const alpha = dropped ? DROP_ALPHA : noise * STATIC_MAX * 255;
    const frame = (Math.floor(clockMs) * 2654435761) >>> 0;
    let seed = frame;
    // Tear rows this frame: up to TEARS streaks 1-3 rows tall, each from a random column to the right edge.
    const tears = tear > 0 ? Math.floor(tear * TEARS + (hash(frame) & 255) / 256) : 0;
    const roll = Math.floor(clockMs * ROLL_SPEED) % STATIC_H;
    for (let y = 0, i = 0; y < STATIC_H; y++) {
      let streak = -1;
      for (let t = 0; t < tears; t++) {
        const h = hash(frame + t * 7919);
        const row = h % STATIC_H, rows = 1 + ((h >>> 9) & 1) + ((h >>> 10) & 1);
        if (y >= row && y < row + rows) { streak = (h >>> 12) % STATIC_W; break; }
      }
      const rolled = tear > 0 && (y - roll + STATIC_H) % STATIC_H < ROLL_ROWS;
      const rowAlpha = rolled ? Math.min(255, alpha + 70 * tear) : alpha;
      // Colour bleed: the row drifts toward red or cyan and the snow picks up chroma, strongest at the range.
      const drift = bleed > 0 ? Math.sin(y * 0.31 + clockMs * 0.006) * 28 * bleed : 0, chroma = 70 * bleed;
      for (let x = 0; x < STATIC_W; x++, i += 4) {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        let v = seed >>> 24, a = rowAlpha * (0.45 + (seed >>> 16 & 255) / 464);
        if (streak >= 0 && x >= streak) { v = 200 + (v >>> 3); a = 150 + 105 * tear; }
        // The buffer is a Uint8ClampedArray: the bleed and the streak alpha clamp themselves.
        const hue = drift + ((seed >>> 8 & 255) - 128) / 128 * chroma;
        data[i] = v + hue;
        data[i + 1] = v;
        data[i + 2] = v - hue;
        data[i + 3] = a;
      }
    }
    this.context.putImageData(this.image, 0, 0);
  }

  hide() { this.update(null); }

  dispose() { this.hide(); this.video.remove(); }
}
