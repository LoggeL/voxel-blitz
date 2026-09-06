// Radial weapon wheel overlay. The pure geometry helpers are shared with the
// input seam; the controller owns the #weapon-wheel dialog and mirrors the
// buy-menu lifecycle: a body-level fixed-id root that starts hidden, an
// idempotent ensure(), guarded host callbacks, and a real dispose().
import { el } from './hud-support.js';

/** Vectors shorter than this (normalized against the full ring radius) select nothing. */
export const WHEEL_DEAD_ZONE = 0.32;

/**
 * Angle in degrees of slot `index` around a `count`-slot wheel, in atan2
 * space: -90deg is straight up (slot 0 sits at the top) and the value grows
 * clockwise. Normalized to [0, 360).
 *
 * @param {number} index Zero-based slot index.
 * @param {number} count Total slot count (2..16).
 * @returns {number} Normalized angle in [0, 360).
 */
export function wheelAngleForSlot(index, count) {
  if (!Number.isFinite(index) || !Number.isFinite(count) || count <= 0) return 0;
  const deg = -90 + (360 * index) / count;
  return ((deg % 360) + 360) % 360;
}

/**
 * Maps a normalized wheel vector to a slot index. Slot 0 is at the top and
 * slots grow clockwise; the half-up sector boundary rounds outward.
 *
 * @param {number} x Normalized vector X (1 == full ring deflection).
 * @param {number} y Normalized vector Y (+Y is down, matching screen space).
 * @param {number} count Total slot count.
 * @param {number} [deadZone=WHEEL_DEAD_ZONE] Radius below which nothing is selected.
 * @returns {number} Slot index, or -1 inside the dead zone / for bad input.
 */
export function wheelSlotFromVector(x, y, count, deadZone = WHEEL_DEAD_ZONE) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return -1;
  if (!Number.isFinite(count) || count <= 0) return -1;
  if (Math.hypot(x, y) < deadZone) return -1;
  const deg = ((Math.atan2(y, x) * 180) / Math.PI + 90 + 360) % 360;
  return Math.round(deg / (360 / count)) % count;
}

/**
 * Cheap identity signature for an entries array: every field the slots render.
 * Slot identity (length + ids) alone would swallow live ammo/ownership/current
 * refreshes, so the diff must see them too.
 */
function _entriesSignature(entries) {
  if (!Array.isArray(entries)) return '';
  return `${entries.length}:` + entries.map((entry) => (
    entry ? `${entry.id}|${entry.name}|${entry.ammo}|${entry.owned ? 1 : 0}|${entry.current ? 1 : 0}` : 'null'
  )).join(',');
}

/** textContent setter that skips identical writes (cheap diff). */
function _setText(node, value) {
  if (node && node.textContent !== value) node.textContent = value;
}

/**
 * Owns the #weapon-wheel dialog: ring slots, center hub, highlight state, and
 * the pointer-capture path used for touch. Display strings arrive pre-formed
 * on the entries; this class never imports game modules.
 */
export class WeaponWheelController {
  /**
   * @param {object} [host] Optional callback host: onPick(slot), onCancel().
   */
  constructor(host = {}) {
    this.host = host;
    this.dom = {};
    this._callbacks = null;
    this._open = false;
    this._entries = [];
    this._entriesSig = '';
    this._highlight = -1;
    this._ownsRoot = false;
    this._pointerInteractive = false;
    this._pointerId = null;
    this._ringRadius = 1;
    this._vecX = 0;
    this._vecY = 0;
    this._pointerHandlers = null;
  }

  /**
   * Creates (once) or adopts the body-level #weapon-wheel root and rebuilds
   * its static chrome. Safe to call repeatedly; existing DOM is re-created in
   * place like buy-menu's ensureBuyMenu().
   *
   * @returns {HTMLElement} The wheel root element.
   */
  ensure() {
    if (this.dom.root) return this.dom.root;

    let root = document.getElementById('weapon-wheel');
    if (!root) {
      root = el('div', 'hidden', document.body, 'weapon-wheel');
      this._ownsRoot = true;
    }
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'Weapon wheel');
    root.setAttribute('aria-hidden', 'true');
    root.classList.add('hidden');
    root.innerHTML = '';
    root.style.display = 'none';

    const ring = el('div', 'vb-wheel-ring', root);
    const cursor = el('span', 'vb-wheel-cursor', ring);
    const hub = el('div', 'vb-wheel-hub', ring);
    const hubName = el('div', 'vb-wheel-hub-name', hub);
    const hubCls = el('div', 'vb-wheel-hub-cls', hub);
    const hubHint = el('div', 'vb-wheel-hub-hint', hub);
    hubName.textContent = 'MOVE TO SELECT';
    hubCls.textContent = 'Q / ESC CANCEL';

    this.dom = { root, ring, cursor, hub, hubName, hubCls, hubHint, slots: [], ticks: [] };
    this._attachPointerHandlers();
    return root;
  }

  /**
   * Wires the guarded callbacks and ensures the DOM.
   *
   * @param {{onPick?: Function, onCancel?: Function}} [config]
   */
  setup({ onPick, onCancel } = {}) {
    this._callbacks = { onPick, onCancel };
    this.ensure();
  }

  /**
 * Opens the wheel with 2..16 slot entries. Any other count is ignored and
 * the wheel stays closed. Entries carry display strings only:
 * {id, name, cls, icon, key, ammo, owned, current}.
   *
   * @param {Array<{id: string, name: string, cls: string, icon: string,
   *   key: string, ammo: string, owned: boolean, current: boolean}>} entries
   * @param {{pointerInteractive?: boolean}} [options] Enables the touch
   *   pointer-capture path (drag to aim, release to pick).
   * @returns {boolean} True when the wheel opened.
   */
  open(entries, { pointerInteractive = false } = {}) {
    if (!Array.isArray(entries) || entries.length < 2 || entries.length > 16) return false;
    this.ensure();
    this._entriesSig = _entriesSignature(entries);
    this.setEntries(entries);
    this._open = true;
    this._highlight = -1;
    this._pointerId = null;
    this._vecX = 0;
    this._vecY = 0;

    const root = this.dom.root;
    root.classList.remove('hidden');
    root.classList.add('is-open');
    root.style.display = 'flex';
    root.setAttribute('aria-hidden', 'false');

    this._refreshRingRadius();
    this.point(0, 0);
    this._applyHighlight();
    if (!!pointerInteractive !== this._pointerInteractive) {
      this.setPointerInteractive(!!pointerInteractive);
    }
    return true;
  }

  /** Hides the wheel and drops transient pointer/highlight state. */
  close() {
    this._open = false;
    this._highlight = -1;
    this._pointerId = null;
    this._vecX = 0;
    this._vecY = 0;
    const root = this.dom.root;
    if (root) {
      root.classList.add('hidden');
      root.classList.remove('is-open');
      root.style.display = 'none';
      root.setAttribute('aria-hidden', 'true');
    }
  }

  /** @returns {boolean} Whether the wheel is currently shown. */
  isOpen() {
    return this._open;
  }

  /**
   * Refreshes the slot set in place: rebuilds the slot nodes only when the
   * count changes, otherwise patches text, icon, classes, and angles cheaply.
   * Counts outside 2..8 are ignored.
   *
   * @param {Array<{id: string, name: string, cls: string, icon: string,
   *   key: string, ammo: string, owned: boolean, current: boolean}>} entries
   */
  setEntries(entries) {
    const list = Array.isArray(entries) ? entries : [];
    if (list.length < 2 || list.length > 16) return;
    this._entries = list;
    if (!Array.isArray(this.dom.slots) || this.dom.slots.length !== list.length) {
      this._buildSlots(list);
    } else {
      this._patchSlots(list);
    }
    this._applyHighlight();
  }

  /**
   * Highlights the slot under a normalized wheel vector.
   *
   * @param {number} x Normalized vector X.
   * @param {number} y Normalized vector Y.
   * @returns {number} The resulting slot index (-1 in the dead zone).
   */
  point(x, y) {
    const slot = wheelSlotFromVector(x, y, this._entries.length);
    this._vecX = x;
    this._vecY = y;
    if (this.dom.cursor) {
      this.dom.cursor.style.transform = `translate(${x * this._ringRadius}px, ${y * this._ringRadius}px)`;
    }
    this.highlightSlot(slot);
    return slot;
  }

  /**
   * Moves the highlight by a relative step, wrapping around the wheel. A -1
   * base is treated as 0.
   *
   * @param {number} delta Signed step (usually +-1).
   * @returns {number} The new slot index, or -1 when there is nothing to step.
   */
  stepHighlight(delta) {
    const count = this._entries.length;
    if (count < 2) return -1;
    const base = this._highlight < 0 ? 0 : this._highlight;
    const next = ((((base + delta) % count) + count) % count);
    this.highlightSlot(next);
    return next;
  }

  /**
   * Sets the highlighted slot. Out-of-range indices collapse to -1 (none).
   *
   * @param {number} slot Slot index or -1.
   */
  highlightSlot(slot) {
    if (slot === this._highlight) return;
    this._highlight = slot;
    this._applyHighlight();
  }

  /** @returns {number} Highlighted slot index, or -1 when none. */
  highlightedSlot() {
    return this._highlight;
  }

  /**
   * Toggles the touch pointer path: pointer capture on the root, move maps to
   * point() against the ring, release picks the highlighted slot or cancels.
   *
   * @param {boolean} enabled
   */
  setPointerInteractive(enabled) {
    this._pointerInteractive = !!enabled;
    if (!this._pointerInteractive) this._pointerId = null;
  }

  /**
   * Frame-driven state forwarder with cheap diffing: unchanged fields are
   * skipped. `setHighlight` accepts either an explicit slot override (number)
   * or a change-listener callback invoked with the current highlight.
   *
   * @param {{open?: boolean, entries?: Array, x?: number, y?: number,
   *   highlight?: number, step?: number, setHighlight?: number|Function,
   *   pointerInteractive?: boolean}} [state]
   */
  setState(state = {}) {
    const { open, entries, x, y, highlight, step, setHighlight, pointerInteractive } = state;

    if (entries !== undefined) {
      const sig = _entriesSignature(entries);
      if (sig !== this._entriesSig) {
        this._entriesSig = sig;
        this.setEntries(entries);
      }
    }

    if (open !== undefined) {
      if (open && !this._open) this.open(this._entries);
      else if (!open && this._open) this.close();
    }

    if (highlight !== undefined && highlight !== this._highlight) {
      this.highlightSlot(highlight);
    }
    if (setHighlight !== undefined) {
      if (typeof setHighlight === 'function') setHighlight(this._highlight);
      else if (setHighlight !== null) this.highlightSlot(setHighlight);
    }
    if (step) this.stepHighlight(step);
    if (x !== undefined || y !== undefined) {
      const px = x === undefined ? this._vecX : x;
      const py = y === undefined ? this._vecY : y;
      if (px !== this._vecX || py !== this._vecY) this.point(px, py);
    }
    if (pointerInteractive !== undefined && !!pointerInteractive !== this._pointerInteractive) {
      this.setPointerInteractive(!!pointerInteractive);
    }
  }

  /**
   * Closes the wheel and fires the guarded onCancel callback. Used by the HUD
   * facade's requestWheelCancel().
   *
   * @returns {boolean} True when a cancel was dispatched.
   */
  requestCancel() {
    if (!this._open) return false;
    this.close();
    const onCancel = this._callbacks?.onCancel ?? this.host?.onCancel;
    if (typeof onCancel === 'function') onCancel();
    return true;
  }

  /** Tears down listeners and owned DOM; the controller is reusable-free after this. */
  dispose() {
    const root = this.dom.root;
    if (this._pointerHandlers && root) {
      root.removeEventListener('pointerdown', this._pointerHandlers.down);
      root.removeEventListener('pointermove', this._pointerHandlers.move);
      root.removeEventListener('pointerup', this._pointerHandlers.up);
      root.removeEventListener('pointercancel', this._pointerHandlers.cancel);
    }
    this._pointerHandlers = null;

    this.close();
    if (root) {
      if (this._ownsRoot) root.remove();
      else root.innerHTML = '';
    }

    this.dom = {};
    this._callbacks = null;
    this._entries = [];
    this._entriesSig = '';
    this._highlight = -1;
    this._open = false;
    this._ownsRoot = false;
    this._pointerInteractive = false;
    this._pointerId = null;
  }

  /**
   * Builds fresh slot + tick nodes for the entry list (count changed).
   *
   * @param {Array<object>} list Validated 2..16 entries.
   * @private
   */
  _buildSlots(list) {
    const ring = this.dom.ring;
    if (!ring) return;

    for (const item of this.dom.slots || []) item.node?.remove();
    for (const node of this.dom.ticks || []) node.remove?.();
    this.dom.slots = [];
    this.dom.ticks = [];

    list.forEach((entry, index) => {
      const angle = wheelAngleForSlot(index, list.length);

      const tick = el('span', 'vb-wheel-tick', null);
      tick.style.setProperty('--vb-wheel-angle', `${angle}deg`);
      ring.insertBefore(tick, this.dom.hub);
      this.dom.ticks.push(tick);
      const node = el('div', 'vb-wheel-slot', null);
      node.style.setProperty('--vb-wheel-angle', `${angle}deg`);
      const icon = el('img', 'vb-wheel-icon', node);
      icon.alt = '';
      icon.decoding = 'async';
      icon.draggable = false;
      const name = el('div', 'vb-wheel-name', node);
      const key = el('div', 'vb-wheel-key', node);
      const ammo = el('div', 'vb-wheel-ammo', node);
      const lock = el('span', 'vb-wheel-lock', node);
      lock.textContent = 'LOCKED';
      ring.insertBefore(node, this.dom.hub);
      this.dom.slots.push({ node, icon, name, key, ammo, lock });
    });

    this._patchSlots(list);
  }

  /**
   * Cheap per-slot refresh: text, icon source, angle, and state classes.
   *
   * @param {Array<object>} list Validated 2..16 entries.
   * @private
   */
  _patchSlots(list) {
    const slots = this.dom.slots || [];
    list.forEach((entry, index) => {
      const item = slots[index];
      if (!item) return;

      const angle = `${wheelAngleForSlot(index, list.length)}deg`;
      if (item.node.style.getPropertyValue('--vb-wheel-angle') !== angle) {
        item.node.style.setProperty('--vb-wheel-angle', angle);
      }
      const icon = entry && entry.icon ? entry.icon : '';
      if (item.icon.getAttribute('src') !== icon) item.icon.setAttribute('src', icon);
      _setText(item.name, (entry && entry.name) || '');
      item.node.setAttribute('aria-label', `${entry?.name || ''}, ${entry?.owned ? entry.ammo : 'locked'}${entry?.current ? ', equipped' : ''}`);
      _setText(item.key, (entry && entry.key) || '');
      _setText(item.ammo, (entry && entry.ammo) || '');
      item.node.classList.toggle('is-current', !!(entry && entry.current));
      item.node.classList.toggle('is-locked', !(entry && entry.owned));
    });
  }

  /**
   * Applies the current highlight to slot classes and the hub copy. An
   * out-of-range _highlight collapses to -1.
   *
   * @private
   */
  _applyHighlight() {
    const count = this._entries.length;
    if (!Number.isInteger(this._highlight) || this._highlight < 0 || this._highlight >= count) {
      this._highlight = -1;
    }
    const slots = this.dom.slots || [];
    for (let index = 0; index < slots.length; index += 1) {
      slots[index].node.classList.toggle('is-hl', index === this._highlight);
    }
    this._syncHub();
  }

  /**
   * Renders the hub lines for the current highlight:
   * none -> MOVE TO SELECT / Q / ESC CANCEL; locked -> name + LOCKED · NOT
   * OWNED; otherwise name + class + CLICK / RT TO EQUIP · Q / ESC CANCEL.
   *
   * @private
   */
  _syncHub() {
    const dom = this.dom;
    if (!dom.hub) return;
    const entry = this._highlight >= 0 ? this._entries[this._highlight] : null;
    if (!entry) {
      _setText(dom.hubName, 'MOVE TO SELECT');
      _setText(dom.hubCls, 'Q / ESC CANCEL');
      _setText(dom.hubHint, '');
      return;
    }
    const locked = !entry.owned;
    _setText(dom.hubName, entry.name || '');
    _setText(dom.hubCls, locked ? 'LOCKED · NOT OWNED' : entry.cls || '');
    _setText(dom.hubHint, locked ? 'Q / ESC CANCEL' : 'CLICK / RT TO EQUIP · Q / ESC CANCEL');
  }

  /** Re-measures the ring radius used to normalize pointer deltas. @private */
  _refreshRingRadius() {
    const ring = this.dom.ring;
    if (!ring || typeof ring.getBoundingClientRect !== 'function') {
      this._ringRadius = 1;
      return;
    }
    const rect = ring.getBoundingClientRect();
    this._ringRadius = rect.width > 0 ? rect.width / 2 : 1;
  }

  /**
   * Converts a pointer event into a normalized wheel vector centered on the
   * ring, scaled so one ring radius == 1.
   *
   * @param {PointerEvent} event
   * @returns {{x: number, y: number}}
   * @private
   */
  _pointerVector(event) {
    const ring = this.dom.ring;
    if (!ring || !Number.isFinite(event.clientX)) return { x: 0, y: 0 };
    const rect = ring.getBoundingClientRect();
    const radius = this._ringRadius > 1 ? this._ringRadius : Math.max(rect.width / 2, 1);
    return {
      x: (event.clientX - (rect.left + rect.width / 2)) / radius,
      y: (event.clientY - (rect.top + rect.height / 2)) / radius,
    };
  }

  /** Registers the root pointer listeners once (guarded by the flag). @private */
  _attachPointerHandlers() {
    if (this._pointerHandlers || typeof document === 'undefined') return;
    const root = this.dom.root;
    const handlers = {
      down: (event) => this._onPointerDown(event),
      move: (event) => this._onPointerMove(event),
      up: (event) => this._onPointerUp(event),
      cancel: (event) => this._onPointerCancel(event),
    };
    root.addEventListener('pointerdown', handlers.down);
    root.addEventListener('pointermove', handlers.move);
    root.addEventListener('pointerup', handlers.up);
    root.addEventListener('pointercancel', handlers.cancel);
    this._pointerHandlers = handlers;
  }

  /**
   * Pointer down: capture and start aiming from wherever the finger landed.
   *
   * @param {PointerEvent} event
   * @private
   */
  _onPointerDown(event) {
    if (!this._pointerInteractive || !this._open || document.pointerLockElement || event.button > 0) return;
    event.preventDefault();
    this._pointerId = event.pointerId;
    this._refreshRingRadius();
    const vec = this._pointerVector(event);
    this.point(vec.x, vec.y);
    try {
      this.dom.root.setPointerCapture(event.pointerId);
    } catch (_) { /* capture is best-effort */ }
  }

  /**
   * Pointer move: aim the highlight (only for the captured pointer).
   *
   * @param {PointerEvent} event
   * @private
   */
  _onPointerMove(event) {
    if (!this._pointerInteractive || !this._open || document.pointerLockElement) return;
    if (event.pointerType !== 'mouse' && event.pointerId !== this._pointerId) return;
    const vec = this._pointerVector(event);
    this.point(vec.x, vec.y);
  }

  /**
   * Pointer up: pick the highlighted slot, or cancel when nothing is selected.
   *
   * @param {PointerEvent} event
   * @private
   */
  _onPointerUp(event) {
    if (!this._pointerInteractive || !this._open || event.pointerId !== this._pointerId) return;
    this._pointerId = null;
    try {
      this.dom.root.releasePointerCapture(event.pointerId);
    } catch (_) { /* release is best-effort */ }
    if (this._highlight >= 0) this._pick(this._highlight);
    else this._cancel();
  }

  /**
   * Pointer cancel: drop the capture without picking or cancelling.
   *
   * @param {PointerEvent} event
   * @private
   */
  _onPointerCancel(event) {
    if (event.pointerId !== this._pointerId) return;
    this._pointerId = null;
    try {
      this.dom.root.releasePointerCapture(event.pointerId);
    } catch (_) { /* release is best-effort */ }
  }

  /**
   * Fires the guarded onPick callback (host or setup-provided).
   *
   * @param {number} slot
   * @private
   */
  _pick(slot) {
    const onPick = this._callbacks?.onPick ?? this.host?.onPick;
    if (this._open && typeof onPick === 'function') onPick(slot);
  }

  /** Fires the guarded onCancel callback (host or setup-provided). @private */
  _cancel() {
    const onCancel = this._callbacks?.onCancel ?? this.host?.onCancel;
    if (this._open && typeof onCancel === 'function') onCancel();
  }
}
