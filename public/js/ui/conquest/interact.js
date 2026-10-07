/**
 * Interact prompt with the revive / repair hold ring. While Interact is held
 * for at least repairHoldStartMs near a valid target, a support intent is
 * re-sent at 5 Hz (the server drops progress when the last intent is older
 * than supportIntentStaleMs). The ring shows authoritative progress, cq[6].
 */
import { CONQUEST_RULES } from '../../../../shared/conquest-contract.js';
import { el } from '../hud-support.js';
import { bindingLabel } from '../../keybindings.js';
import { svgIcon } from './icons.js';

export const SUPPORT_INTERVAL_MS = 200;
const SVG_NS = 'http://www.w3.org/2000/svg';
const R = 17, C = 2 * Math.PI * R;

/**
 * Pure pump: given the prompt model, how long Interact has been held and the
 * last send time, decide whether to send `{type, targetId}` now.
 */
export function supportPump(state, { model, heldMs, nowMs, rules = CONQUEST_RULES }) {
  const holdable = model && (model.type === 'revive' || model.type === 'repair');
  const active = holdable && heldMs >= rules.repairHoldStartMs;
  if (!active) return { state: { lastAt: -Infinity, targetId: null, active: false }, send: null };
  const retarget = state.targetId !== model.targetId;
  if (!retarget && nowMs - state.lastAt < SUPPORT_INTERVAL_MS) return { state: { ...state, active: true }, send: null };
  return { state: { lastAt: nowMs, targetId: model.targetId, active: true }, send: { type: model.type, targetId: model.targetId } };
}

export class InteractPrompt {
  constructor(parent, { onInteract = () => {}, onSupport = () => {} } = {}) {
    this.onSupport = onSupport;
    this.root = el('button', 'cq-interact', parent);
    this.root.type = 'button';
    this.root.hidden = true;
    this.type = null;
    this.pressedAt = null;
    // Tap enters or leaves a hull; pressing and holding the prompt (touch, mouse) is a revive / repair hold.
    this.root.addEventListener('click', () => { if (this.type === 'enter' || this.type === 'exit') onInteract(); });
    const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
    this.root.addEventListener('pointerdown', event => {
      this.pressedAt = now();
      try { this.root.setPointerCapture?.(event.pointerId); } catch { /* synthetic pointer */ }
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) this.root.addEventListener(type, () => { this.pressedAt = null; });
    const doc = globalThis.document;
    const ring = doc.createElementNS(SVG_NS, 'svg');
    ring.setAttribute('viewBox', '0 0 40 40');
    ring.setAttribute('class', 'cq-interact-ring');
    ring.setAttribute('aria-hidden', 'true');
    const track = doc.createElementNS(SVG_NS, 'circle');
    for (const [k, v] of Object.entries({ cx: 20, cy: 20, r: R, class: 'cq-interact-track' })) track.setAttribute(k, String(v));
    this.arc = doc.createElementNS(SVG_NS, 'circle');
    for (const [k, v] of Object.entries({ cx: 20, cy: 20, r: R, class: 'cq-interact-arc', transform: 'rotate(-90 20 20)',
      'stroke-dasharray': `${C.toFixed(2)} ${C.toFixed(2)}`, 'stroke-dashoffset': C.toFixed(2) })) this.arc.setAttribute(k, String(v));
    ring.appendChild(track); ring.appendChild(this.arc);
    this.ringBox = el('span', 'cq-interact-ringbox', this.root);
    this.ringBox.appendChild(ring);
    this.glyph = el('span', 'cq-interact-glyph', this.ringBox);
    this.key = el('kbd', 'cq-interact-key', this.root);
    this.label = el('span', 'cq-interact-label', this.root);
    this.pump = { lastAt: -Infinity, targetId: null, active: false };
    this._sig = '';
  }

  /** Milliseconds the prompt itself has been pressed (0 when not). */
  pressedMs(now) { return this.pressedAt === null ? 0 : Math.max(0, now - this.pressedAt); }

  update(model, { heldMs = 0, nowMs = 0, touch = false } = {}) {
    this.type = model?.type ?? null;
    if (!model) this.pressedAt = null;
    const { state, send } = supportPump(this.pump, { model, heldMs, nowMs });
    this.pump = state;
    if (send) this.onSupport(send);
    if (!model) { this.root.hidden = true; this._sig = ''; return; }
    this.root.hidden = false;
    // The parachute prompt names Jump; every other prompt is Interact.
    const key = touch ? '' : bindingLabel(model.binding || 'interact');
    // Touch has no F-row: "ENTER JEEP · F2 GUNNER" reads "ENTER JEEP · GUNNER".
    const label = touch ? model.label.replace(/ · F\d+ /, ' · ') : model.label;
    const text = model.hold ? `HOLD ${label}` : label;
    const sig = `${model.type}|${text}|${key}`;
    if (sig !== this._sig) {
      this._sig = sig;
      this.root.dataset.type = model.type;
      this.key.textContent = key;
      this.key.hidden = !key;
      this.label.textContent = text;
      this.glyph.textContent = '';
      const icon = svgIcon(globalThis.document, model.type === 'revive' ? 'revive' : model.type === 'repair' ? 'repair' : 'tank', 'cq-interact-icon');
      if (icon && model.hold) this.glyph.appendChild(icon);
      this.root.setAttribute('aria-label', text);
    }
    this.root.classList.toggle('is-active', state.active);
    this.ringBox.hidden = !model.hold;
    const progress = Math.max(0, Math.min(1, model.progress || 0));
    this.arc.setAttribute('stroke-dashoffset', (C * (1 - progress)).toFixed(2));
  }
}
