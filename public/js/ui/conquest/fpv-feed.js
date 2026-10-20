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
 */
import { el } from '../hud-support.js';
import { svgIcon } from './icons.js';

/** Key hints stay up this long after a launch (the HUD rule: no permanent keybind line). */
export const FPV_HINT_MS = 6000;
/** Battery seconds under which the readout turns amber, then red. */
const LOW_SECONDS = 12, CRITICAL_SECONDS = 6;
const STATIC_W = 384, STATIC_H = 240;
/** Static opacity at full noise: a snowstorm, but the world still shows through. */
const STATIC_MAX = 0.55;
const finite = (value, fallback = 0) => (Number.isFinite(value) ? value : fallback);

/** The feed model of one telemetry frame (null while no drone flies). Pure: text and levels only. */
export function fpvFeedModel(telemetry, { hints = '' } = {}) {
  if (!telemetry) return null;
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
    noise: Math.max(0, Math.min(1, finite(telemetry.noise))),
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
    this.canvas = el('canvas', 'cq-fpv-static', this.root);
    this.canvas.width = STATIC_W; this.canvas.height = STATIC_H;
    this.context = this.canvas.getContext?.('2d') ?? null;
    this.image = this.context?.createImageData?.(STATIC_W, STATIC_H) ?? null;
    el('div', 'cq-fpv-vignette', this.root);
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
    this._sig = ''; this._hintAt = -Infinity; this._was = false;
    this.model = null;
  }

  setHints(text) { this._hintText = text; }

  /** `clockMs` (a monotonic clock) times the key hints and the static grain. */
  update(model, { clockMs = 0 } = {}) {
    this.model = model;
    const doc = globalThis.document;
    if (!model) {
      if (!this.root.hidden) this.root.hidden = true;
      if (doc?.body?.dataset?.fpv) delete doc.body.dataset.fpv;
      this._was = false;
      return;
    }
    if (!this._was) { this._was = true; this._hintAt = clockMs; }
    if (this.root.hidden) this.root.hidden = false;
    if (doc?.body?.dataset && doc.body.dataset.fpv !== 'true') doc.body.dataset.fpv = 'true';
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
    this._paintStatic(model.noise, clockMs);
  }

  /** Analog grain: fresh noise every frame, its opacity the model's noise level. */
  _paintStatic(noise, clockMs) {
    this.canvas.style.opacity = (noise * STATIC_MAX).toFixed(2);
    if (!this.context || !this.image || noise <= 0.01) return;
    const data = this.image.data;
    let seed = (Math.floor(clockMs) * 2654435761) >>> 0;
    for (let i = 0; i < data.length; i += 4) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const v = seed >>> 24;
      data[i] = data[i + 1] = data[i + 2] = v;
      data[i + 3] = 255;
    }
    this.context.putImageData(this.image, 0, 0);
  }

  hide() { this.update(null); }
}
