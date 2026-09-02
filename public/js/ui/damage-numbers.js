import { DMG_MAX_POOL, DMG_MS, el, removeNode } from './hud-support.js';

const EMPTY = Object.freeze({});
/** Hits on the same target inside this window merge into one growing number. */
export const DMG_STACK_MS = 420;

// Owns the complete floating-damage lifecycle: DOM node reuse, record reuse,
// animation scheduling, and cancellation. CombatHudController only exposes the
// historic methods and collection views.
export class DamageNumberPool {
  constructor(adapter = EMPTY) {
    this.pool = [];
    this.active = [];
    this._records = [];
    this.raf = 0;
    this.lastCritAt = -1e9;

    this._getLayer = () => null;
    this._isBuilt = () => false;
    this._isDisposed = () => false;
    this._now = Date.now;
    this._random = Math.random;
    this._requestFrame = () => 0;
    this._cancelFrame = () => {};
    this._onFrame = () => this._step();
    this.configure(adapter);
  }

  configure(adapter = EMPTY) {
    if (typeof adapter.getLayer === 'function') this._getLayer = adapter.getLayer;
    if (typeof adapter.isBuilt === 'function') this._isBuilt = adapter.isBuilt;
    if (typeof adapter.isDisposed === 'function') this._isDisposed = adapter.isDisposed;
    if (typeof adapter.now === 'function') this._now = adapter.now;
    if (typeof adapter.random === 'function') this._random = adapter.random;
    if (typeof adapter.requestFrame === 'function') this._requestFrame = adapter.requestFrame;
    if (typeof adapter.cancelFrame === 'function') this._cancelFrame = adapter.cancelFrame;
    return this;
  }

  spawn(amount, sx, sy, visible = true, headshot = false, stackKey = null) {
    if (!this._isBuilt() || visible === false || this._isDisposed()) return;
    const crit = !!headshot;
    const now = this._now();
    if (stackKey != null) {
      // Rapid hits on one target read as a single growing number, not confetti.
      for (let i = this.active.length - 1; i >= 0; i--) {
        const rec = this.active[i];
        if (rec.stackKey !== stackKey || now - rec.t0 > DMG_STACK_MS) continue;
        rec.total += Math.max(0, Number(amount) || 0);
        rec.node.textContent = String(Math.round(rec.total));
        if (crit && !rec.node.classList.contains('vb-crit')) rec.node.classList.add('vb-crit');
        rec.node.classList.remove('vb-stack');
        void rec.node.offsetWidth;
        rec.node.classList.add('vb-stack');
        rec.sx = sx;
        rec.sy = sy;
        rec.t0 = now;
        this.place(rec, 0);
        return;
      }
    }
    let jx = this._random() * 16 - 8;
    if (crit) {
      jx *= 1.8;
      if (now - this.lastCritAt < 280) jx += this._random() * 18 - 9;
      this.lastCritAt = now;
    }

    const rec = this.take();
    if (!rec) return;
    rec.node.textContent = String(Math.round(amount));
    rec.node.classList.toggle('vb-crit', crit);
    rec.node.style.opacity = '1';
    rec.sx = sx;
    rec.sy = sy;
    rec.jx = jx;
    rec.t0 = now;
    rec.total = Math.max(0, Number(amount) || 0);
    rec.stackKey = stackKey;
    rec.node.classList.remove('vb-stack');
    this.place(rec, 0);
    this.active.push(rec);
    if (!this.raf) this.step();
  }

  take() {
    const layer = this._getLayer();
    if (!layer) return null;
    let node = this.pool.pop() || null;
    if (!node && layer.children && layer.children.length < DMG_MAX_POOL) {
      node = el('div', 'dmgnum', layer);
    }
    if (node) {
      const rec = this._records.pop() || {};
      rec.node = node;
      return rec;
    }
    return this.active.shift() || null;
  }

  place(rec, elapsed) {
    const rise = 46 * (1 - Math.pow(1 - elapsed, 3));
    const drift = rec.jx * (1 - Math.pow(1 - elapsed, 2));
    const skew = rec.node.classList.contains('vb-crit') ? ' skewX(-6deg)' : '';
    rec.node.style.transform = `translate3d(${rec.sx + drift}px,${rec.sy - rise}px,0)${skew}`;
  }

  step() {
    if (this.raf || !this.active.length || this._isDisposed()) return;
    this.raf = this._requestFrame(this._onFrame);
  }

  _step() {
    const now = this._now();
    for (let i = this.active.length - 1; i >= 0; i--) {
      const rec = this.active[i];
      const elapsed = Math.min(1, (now - rec.t0) / DMG_MS);
      this.place(rec, elapsed);
      rec.node.style.opacity = elapsed > 0.62
        ? String((1 - (elapsed - 0.62) / 0.38).toFixed(3))
        : '1';
      if (elapsed >= 1) {
        this.active.splice(i, 1);
        rec.node.style.opacity = '0';
        if (this.pool.length < DMG_MAX_POOL) this.pool.push(rec.node);
        this._release(rec);
      }
    }
    if (this.active.length) this.raf = this._requestFrame(this._onFrame);
    else this.raf = 0;
  }

  clear(removeNodes = false) {
    for (const rec of this.active) {
      if (!rec?.node) continue;
      rec.node.style.opacity = '0';
      if (this.pool.length < DMG_MAX_POOL) this.pool.push(rec.node);
      this._release(rec);
    }
    this.active.length = 0;
    if (this.raf) {
      this._cancelFrame(this.raf);
      this.raf = 0;
    }
    if (removeNodes) {
      for (const node of this.pool) removeNode(node);
      this.pool.length = 0;
      this._records.length = 0;
    }
  }

  reset(removeNodes = false) {
    this.clear(removeNodes);
    this.lastCritAt = -1e9;
  }

  _release(rec) {
    rec.node = null;
    rec.sx = 0;
    rec.sy = 0;
    rec.jx = 0;
    rec.t0 = 0;
    rec.total = 0;
    rec.stackKey = null;
    if (this._records.length < DMG_MAX_POOL) this._records.push(rec);
  }
}
