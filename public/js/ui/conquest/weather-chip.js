/**
 * Conquest weather tab (design A, docs/design/conquest/weather/): a slim strip
 * hung under the ticket bar with the state glyph and name, the own spotting
 * and lock ranges and the forecast; on touch a compact glyph + name beside the
 * clock instead. Every value comes from weatherChipModel (the authoritative
 * `match.conquest.wx`); a lightning strike flashes the strip.
 */
import { el } from '../hud-support.js';
import { svgIcon } from './icons.js';

const FLASH_MS = 320;

export class WeatherChip {
  /** `top` is the TopBar: the tab hangs off its root, the touch tag sits in its centre column. */
  constructor(top) {
    this.root = el('div', 'cq-weather', top.root);
    this.root.setAttribute('role', 'status');
    this.root.hidden = true;
    this.glyph = el('span', 'cq-weather-glyph', this.root);
    this.label = el('strong', 'cq-weather-label', this.root);
    el('i', 'cq-weather-sep', this.root);
    this.spot = el('span', 'cq-weather-range cq-weather-spot', this.root);
    this.lock = el('span', 'cq-weather-range cq-weather-lock', this.root);
    this.forecast = el('span', 'cq-weather-forecast', this.root);
    this.tag = el('div', 'cq-weather-tag', top.root.querySelector?.('.cq-center') ?? top.root);
    this.tag.hidden = true;
    this.tagGlyph = el('span', 'cq-weather-glyph', this.tag);
    this.tagLabel = el('span', 'cq-weather-label', this.tag);
    this._painted = new Map();
    this._flashUntil = 0;
    this._glyphState = null;
  }

  _set(node, key, value) {
    if (this._painted.get(key) === value) return;
    this._painted.set(key, value);
    node.textContent = value;
  }

  _setGlyph(state) {
    if (this._glyphState === state) return;
    this._glyphState = state;
    const doc = this.root.ownerDocument ?? globalThis.document;
    for (const host of [this.glyph, this.tagGlyph]) {
      host.replaceChildren?.();
      const svg = svgIcon(doc, `wx-${state}`, 'cq-weather-icon');
      if (svg) host.appendChild(svg);
    }
  }

  /** Lightning: flash the strip for a moment (the sky flash itself is the world view's). */
  flash(nowMs) { this._flashUntil = nowMs + FLASH_MS; }

  /** Paint one model (null hides the tab). Returns whether the tab shows. */
  update(model, nowMs) {
    const on = !!model;
    if (this.root.hidden === on) { this.root.hidden = !on; this.tag.hidden = !on; }
    if (!on) return false;
    this._setGlyph(model.state);
    this._set(this.label, 'label', model.label);
    this._set(this.tagLabel, 'tag', model.label);
    this._set(this.spot, 'spot', model.spotText);
    this._set(this.lock, 'lock', model.lockText);
    this._set(this.forecast, 'forecast', model.forecast);
    const data = this.root.dataset;
    if (data.state !== model.state) { data.state = model.state; this.tag.dataset.state = model.state; }
    if (data.severity !== model.severity) { data.severity = model.severity; this.tag.dataset.severity = model.severity; }
    data.trend = model.trend;
    this.spot.dataset.reduced = String(model.spotReduced);
    this.lock.dataset.reduced = String(model.lockReduced);
    this.forecast.hidden = !model.forecast;
    const flashing = String(Number.isFinite(nowMs) && nowMs < this._flashUntil);
    if (data.flash !== flashing) { data.flash = flashing; this.tag.dataset.flash = flashing; }
    const title = `Weather ${model.label}: ${model.spotText}, ${model.lockText}${model.forecast ? `, ${model.forecast}` : ''}`;
    if (this.root.title !== title) { this.root.title = title; this.root.setAttribute?.('aria-label', title); }
    return true;
  }
}
