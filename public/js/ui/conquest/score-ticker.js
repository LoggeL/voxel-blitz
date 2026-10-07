/** Stacking "+100 KILL" ticker below the crosshair for the local player's `score` events. */
import { el } from '../hud-support.js';

export const TICKER_HOLD_MS = 3000;
const MAX_LINES = 5;

/**
 * Pure stacking: entries inside the hold window stay; a repeated reason within
 * 600 ms merges into one line (an assist plus attacker kill stays separate).
 */
export function stackTicker(lines, entry, nowMs) {
  const live = lines.filter(line => nowMs - line.at < TICKER_HOLD_MS);
  if (!entry) return live;
  const last = live[live.length - 1];
  if (last && last.reason === entry.reason && nowMs - last.at < 600) {
    const merged = { ...last, pts: last.pts + entry.pts, count: last.count + 1, at: nowMs };
    merged.text = `+${merged.pts} ${entry.label}${merged.count > 1 ? ` ×${merged.count}` : ''}`;
    return [...live.slice(0, -1), merged];
  }
  return [...live, { ...entry, count: 1, at: nowMs, text: `+${entry.pts} ${entry.label}` }].slice(-MAX_LINES);
}

export class ScoreTicker {
  constructor(parent) {
    this.root = el('div', 'cq-ticker', parent);
    this.root.setAttribute('aria-live', 'polite');
    this.lines = [];
    this.total = el('div', 'cq-ticker-total', this.root);
    this.list = el('div', 'cq-ticker-lines', this.root);
    this._sig = '';
  }

  push(entry, nowMs) {
    this.lines = stackTicker(this.lines, entry, nowMs);
    this.render(nowMs);
  }

  update(nowMs) {
    const before = this.lines.length;
    this.lines = stackTicker(this.lines, null, nowMs);
    if (this.lines.length !== before) this.render(nowMs);
    for (const node of this.list.children || []) {
      const age = nowMs - Number(node.dataset.at || 0);
      node.style.opacity = age > TICKER_HOLD_MS - 500 ? Math.max(0, (TICKER_HOLD_MS - age) / 500).toFixed(2) : '1';
    }
  }

  render() {
    const sig = this.lines.map(l => `${l.text}@${l.at}`).join('|');
    if (sig === this._sig) return;
    this._sig = sig;
    this.list.textContent = '';
    for (const line of this.lines) {
      const row = el('div', `cq-ticker-line${line.reason === 'kill' || line.reason === 'headshot' ? ' is-kill' : ''}`, this.list);
      row.dataset.at = String(line.at);
      row.dataset.reason = line.reason;
      el('b', '', row).textContent = `+${line.pts}`;
      el('span', '', row).textContent = `${line.label}${line.count > 1 ? ` ×${line.count}` : ''}`;
    }
    const sum = this.lines.reduce((a, l) => a + l.pts, 0);
    this.total.textContent = this.lines.length > 1 ? `+${sum}` : '';
    this.root.hidden = this.lines.length === 0;
  }

  clear() { this.lines = []; this.render(); }
}
