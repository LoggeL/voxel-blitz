/**
 * Vehicle camera view strip: after V (or the pad's D-pad down) it shows the
 * seat's views under the ticket bar for VIEW_STRIP_MS, the active one
 * underlined ("V  CHASE · ACTION · COCKPIT · FLYBY"). Design reference:
 * docs/design/conquest/views/view-toast-b-reference.jpg.
 */
import { el } from '../hud-support.js';

export const VIEW_STRIP_MS = 1600;

/**
 * Read model from VehicleCamera.viewState(): { key, views: [{ id, label, active }] }
 * while the last change is younger than VIEW_STRIP_MS, else null.
 */
export function viewStripModel(state, nowMs, keyLabel = 'V') {
  if (!state || !Array.isArray(state.views) || state.views.length < 2) return null;
  if (!(Number.isFinite(state.changedAt) && Number.isFinite(nowMs)) || nowMs - state.changedAt > VIEW_STRIP_MS || nowMs < state.changedAt) return null;
  return { key: keyLabel, view: state.view, views: state.views.map(view => ({ id: view.id, label: view.label, active: view.id === state.view })) };
}

export class ViewStrip {
  constructor(parent) {
    this.root = el('div', 'cq-view', parent);
    this.root.hidden = true;
    this.root.setAttribute('role', 'status');
    this.root.setAttribute('aria-live', 'polite');
    this.keyCap = el('span', 'cq-view-key', this.root);
    this.list = el('span', 'cq-view-list', this.root);
    this._sig = '';
  }

  update(model) {
    if (!model) { this.root.hidden = true; this._sig = ''; return; }
    const sig = `${model.key}|${model.views.map(view => `${view.id}:${view.label}:${view.active ? 1 : 0}`).join(',')}`;
    this.root.hidden = false;
    if (sig === this._sig) return;
    this._sig = sig;
    this.keyCap.textContent = model.key;
    this.list.replaceChildren(...model.views.map(view => {
      const item = el('span', 'cq-view-item');
      item.textContent = view.label;
      item.dataset.view = view.id;
      if (view.active) item.dataset.active = 'true';
      return item;
    }));
    this.root.setAttribute('aria-label', `Camera view: ${model.views.find(view => view.active)?.label ?? ''}`);
  }
}
