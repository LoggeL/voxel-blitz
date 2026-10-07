/**
 * Objective banners (captured, lost, under attack, ticket low, match end),
 * the restricted / out-of-bounds countdown and the incoming-lock warning.
 */
import { el } from '../hud-support.js';

export const BANNER_MS = 2800;
const REPEAT_MS = 6000;
const QUEUE_MAX = 3;

/**
 * Pure banner scheduling: a higher priority banner replaces the shown one,
 * others queue (bounded); a key already shown within REPEAT_MS is dropped so
 * oscillating flag_state events cannot spam "under attack".
 */
export function scheduleBanner(state, banner, nowMs) {
  const ticked = tickBanners(state, nowMs);
  const next = { current: ticked.current, queue: [...ticked.queue], seen: new Map(ticked.seen) };
  for (const [key, at] of next.seen) if (nowMs - at > REPEAT_MS) next.seen.delete(key);
  if (banner) {
    if (next.seen.has(banner.key) && banner.priority < 9) return next;
    next.seen.set(banner.key, nowMs);
    const entry = { ...banner, at: nowMs };
    if (!next.current || banner.priority > next.current.priority) {
      if (next.current && next.current.priority < 9) next.queue.unshift(next.current);
      next.current = entry;
    } else {
      next.queue.push(entry);
      next.queue.sort((a, b) => b.priority - a.priority);
      next.queue.length = Math.min(next.queue.length, QUEUE_MAX);
    }
  }
  return next;
}

/** Advance the schedule without a new banner (expiry and queue pop). */
export function tickBanners(state, nowMs) {
  if (!state.current || nowMs - state.current.at < (state.current.holdMs ?? BANNER_MS)) return state;
  const queue = [...state.queue];
  const head = queue.shift();
  return { current: head ? { ...head, at: nowMs } : null, queue, seen: state.seen };
}

export class Banners {
  constructor(parent) {
    this.root = el('div', 'cq-banner', parent);
    this.root.hidden = true;
    this.root.setAttribute('role', 'alert');
    this.title = el('div', 'cq-banner-title', this.root);
    this.detail = el('div', 'cq-banner-detail', this.root);
    this.state = { current: null, queue: [], seen: new Map() };
    this._shown = null;
  }

  push(banner, nowMs) { this.state = scheduleBanner(this.state, banner, nowMs); this.render(); }
  update(nowMs) { this.state = tickBanners(this.state, nowMs); this.render(); }

  /** A persistent banner (match end) that stays until cleared. */
  hold(banner, nowMs) {
    if (!banner) return;
    if (this.state.current?.key === banner.key) return;
    this.state = { current: { ...banner, at: nowMs, holdMs: Infinity }, queue: [], seen: this.state.seen };
    this.render();
  }

  render() {
    const banner = this.state.current;
    if (banner === this._shown) return;
    this._shown = banner;
    this.root.hidden = !banner;
    if (!banner) return;
    this.root.dataset.tone = banner.tone;
    this.root.dataset.outcome = banner.outcome || '';
    this.title.textContent = banner.title;
    this.detail.textContent = banner.detail || '';
    this.root.classList.remove('is-in');
    void this.root.offsetWidth;
    this.root.classList.add('is-in');
  }

  clear() { this.state = { current: null, queue: [], seen: new Map() }; this.render(); }
}

/** Restricted area / out of bounds: big countdown from cq[4]. */
export class RestrictedOverlay {
  constructor(parent) {
    this.root = el('div', 'cq-restricted', parent);
    this.root.hidden = true;
    this.root.setAttribute('role', 'alert');
    this.title = el('div', 'cq-restricted-title', this.root);
    this.seconds = el('div', 'cq-restricted-seconds', this.root);
    this.detail = el('div', 'cq-restricted-detail', this.root);
    this._key = '';
  }

  update(model) {
    if (!model) { this.root.hidden = true; this._key = ''; return; }
    this.root.hidden = false;
    const key = `${model.title}|${model.seconds}`;
    if (key === this._key) return;
    this._key = key;
    this.title.textContent = model.title;
    this.seconds.textContent = String(model.seconds);
    this.detail.textContent = `${model.detail} · ${model.seconds} S`;
    this.root.style.setProperty('--urgency', model.urgency.toFixed(2));
  }
}

/** Incoming lock banner with a bearing arrow around the crosshair. */
export class LockWarning {
  constructor(parent) {
    this.root = el('div', 'cq-lock', parent);
    this.root.hidden = true;
    this.root.setAttribute('role', 'alert');
    this.label = el('div', 'cq-lock-label', this.root);
    this.bearing = el('div', 'cq-lock-bearing', parent);
    this.bearing.hidden = true;
    el('i', '', this.bearing);
  }

  update(lock) {
    if (!lock) { this.root.hidden = true; this.bearing.hidden = true; return; }
    this.root.hidden = false;
    this.root.dataset.state = String(lock.state);
    const text = `${lock.label}${lock.distance ? ` · ${Math.round(lock.distance)} M` : ''}`;
    if (this.label.textContent !== text) this.label.textContent = text;
    this.bearing.hidden = !Number.isFinite(lock.bearing);
    if (Number.isFinite(lock.bearing)) {
      this.bearing.dataset.state = String(lock.state);
      this.bearing.style.transform = `translate(-50%, -50%) rotate(${(lock.bearing * 180 / Math.PI).toFixed(1)}deg)`;
    }
  }
}
