// Combat-only HUD feedback. The controller owns every timer, animation handle,
// pool, and transient combat value; callers provide only narrow DOM/state getters
// and the handful of presentation callbacks needed by death transitions.

import {
  GLYPH,
  DMG_MS,
  DMG_MAX_POOL,
  el,
  clamp01,
  removeNode,
  resolveKey,
} from './hud-support.js';
import { DamageNumberPool } from './damage-numbers.js';
import { DEATH_IMPACT_MS, DeathTreatment } from './death-treatment.js';

export { DMG_MS, DMG_MAX_POOL };

export const KILLFEED_MAX_ROWS = 5;
export const KILLFEED_HOLD_MS = 4000;
export const KILLFEED_REMOVE_MS = 320;
export const HITMARK_MS = 210;
export { DEATH_IMPACT_MS };

const EMPTY = Object.freeze({});
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function nowDefault() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function requestFrameDefault(callback) {
  if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(callback);
  return setTimeout(() => callback(nowDefault()), 16);
}

function cancelFrameDefault(handle) {
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(handle);
  else clearTimeout(handle);
}

/**
 * Narrow adapter: DOM/state entries may be stable objects or zero-argument
 * getters; optional callbacks cover only the death-transition operations.
 * @typedef {Object} CombatHudAdapter
 */

export class CombatHudController {
  /** @param {CombatHudAdapter} [adapter] */
  constructor(adapter = EMPTY) {
    this._domSource = EMPTY;
    this._matchDomSource = EMPTY;
    this._stateSource = EMPTY;
    this._builtSource = null;
    this._hudRootSource = null;
    this._root = null;
    this._resolveName = null;
    this._closeBuyMenuDirect = null;
    this._resetScope = null;
    this._setReloadProgress = null;
    this._hideCrosshairForAds = null;
    this._updateCrosshairStress = null;

    this._now = nowDefault;
    this._random = Math.random;
    this._requestFrame = requestFrameDefault;
    this._cancelFrame = cancelFrameDefault;
    // Browser timer functions may require their global receiver. Wrappers keep
    // the adapter callable as an ordinary method in strict ES modules.
    this._setTimer = (callback, delay) => setTimeout(callback, delay);
    this._clearTimer = (handle) => clearTimeout(handle);

    this.names = new Map();
    this.killfeedTimers = new Set();
    this._killfeedRows = new Map();

    this._onPainFrame = () => this._stepPain();
    this._onHitmarkTimeout = () => this._finishHitmark();

    this.dead = false;
    this.flashV = 0;
    this.flashRAF = 0;
    this.painImpulse = 0;
    this.painDirectionSeed = 0;
    this.hmTimer = 0;
    this._hitmarkerNode = null;
    this._painLastAt = 0;
    this._disposed = false;

    this._damageNumbers = new DamageNumberPool({
      getLayer: () => this.dom.dmglayer,
      isBuilt: () => this.built,
      isDisposed: () => this._disposed,
      now: () => this._now(),
      random: () => this._random(),
      requestFrame: (callback) => this._requestFrame(callback),
      cancelFrame: (handle) => this._cancelFrame(handle),
    });
    this._deathTreatment = new DeathTreatment({
      getDom: () => this.dom,
      getHudRoot: () => this._hudRoot(),
      isDead: () => this.dead,
      isDisposed: () => this._disposed,
      setTimer: (callback, delay) => this._setTimer(callback, delay),
      clearTimer: (handle) => this._clearTimer(handle),
    });

    this.configure(adapter);
  }

  /** Update only the explicitly supplied adapter fields. */
  configure(adapter = EMPTY) {
    if (!adapter || typeof adapter !== 'object') return this;
    if (hasOwn(adapter, 'dom')) this._domSource = adapter.dom || EMPTY;
    if (hasOwn(adapter, 'matchDom')) this._matchDomSource = adapter.matchDom || EMPTY;
    if (hasOwn(adapter, 'state')) this._stateSource = adapter.state || EMPTY;
    if (hasOwn(adapter, 'built')) this._builtSource = adapter.built;
    if (hasOwn(adapter, 'hudRoot')) this._hudRootSource = adapter.hudRoot;
    if (hasOwn(adapter, 'root')) this._root = typeof adapter.root === 'function' ? adapter.root : null;
    if (hasOwn(adapter, 'resolveName')) {
      this._resolveName = typeof adapter.resolveName === 'function' ? adapter.resolveName : null;
    }

    for (const key of ['closeBuyMenuDirect', 'resetScope', 'setReloadProgress',
      'hideCrosshairForAds', 'updateCrosshairStress']) {
      if (hasOwn(adapter, key)) {
        this[`_${key}`] = typeof adapter[key] === 'function' ? adapter[key] : null;
      }
    }

    if (typeof adapter.now === 'function') this._now = adapter.now;
    if (typeof adapter.random === 'function') this._random = adapter.random;
    if (typeof adapter.requestFrame === 'function') this._requestFrame = adapter.requestFrame;
    if (typeof adapter.cancelFrame === 'function') this._cancelFrame = adapter.cancelFrame;
    if (typeof adapter.setTimer === 'function') this._setTimer = adapter.setTimer;
    if (typeof adapter.clearTimer === 'function') this._clearTimer = adapter.clearTimer;
    return this;
  }

  get dom() { return this._readObject(this._domSource); }
  get matchDom() { return this._readObject(this._matchDomSource); }
  get st() { return this._readObject(this._stateSource); }
  get built() { return this._isBuilt(); }
  get disposed() { return this._disposed; }
  get dmgPool() { return this._damageNumbers.pool; }
  get dmgActive() { return this._damageNumbers.active; }
  get dmgRAF() { return this._damageNumbers.raf; }
  set dmgRAF(value) { this._damageNumbers.raf = value; }
  get lastCritAt() { return this._damageNumbers.lastCritAt; }
  set lastCritAt(value) { this._damageNumbers.lastCritAt = value; }
  get deathBrutality() { return this._deathTreatment.brutality; }
  set deathBrutality(value) { this._deathTreatment.brutality = value; }
  get deathImpactTimer() { return this._deathTreatment.impactTimer; }
  set deathImpactTimer(value) { this._deathTreatment.impactTimer = value; }
  get _ownedDeathNote() { return this._deathTreatment.ownedNote; }

  setDom(dom, matchDom = undefined) {
    this._domSource = dom || EMPTY;
    if (matchDom !== undefined) this._matchDomSource = matchDom || EMPTY;
    return this;
  }

  setStateSource(state) {
    this._stateSource = state || EMPTY;
    return this;
  }

  setBuiltSource(built) {
    this._builtSource = built;
    return this;
  }

  _readObject(source) {
    const value = typeof source === 'function' ? source() : source;
    return value && typeof value === 'object' ? value : EMPTY;
  }

  _isBuilt() {
    if (typeof this._builtSource === 'function') return !!this._builtSource();
    if (this._builtSource != null) return !!this._builtSource;
    const d = this.dom;
    return !!(d.kf || d.hitmarker || d.dmglayer || d.flash || d.deathFx);
  }

  _hudRoot() {
    const supplied = typeof this._hudRootSource === 'function'
      ? this._hudRootSource()
      : this._hudRootSource;
    if (supplied) return supplied;
    if (this._root) {
      const root = this._root('hud');
      if (root) return root;
    }
    const d = this.dom;
    if (d.hud) return d.hud;
    if (d.root) return d.root;
    return typeof document !== 'undefined' ? document.getElementById('hud') : null;
  }

  _stress() {
    if (!this._updateCrosshairStress) return;
    const s = this.st;
    this._updateCrosshairStress(
      s.panic,
      s.pain,
      !this.dead && s.alive !== false,
      this.painImpulse,
    );
  }

  /* ------------------------------------------------------------- events */

  pushEvent(ev) {
    if (!ev || !this.built || this._disposed) return;
    switch (ev.kind) {
      case 'kill':
        this.killfeed(ev);
        break;
      case 'hit':
        this.hitmark(!!ev.hs);
        if (typeof ev.sx === 'number' && typeof ev.sy === 'number' && !ev.behind) {
          this.spawnDamage(ev.dmg, ev.sx, ev.sy, true, !!ev.hs);
        }
        break;
    }
  }

  killfeed(ev) {
    if (!ev || this._disposed) return;
    this.killRow({
      killer: this.nameFor(ev.killer),
      victim: this.nameFor(ev.victim),
      glyphKey: resolveKey(ev.w),
      hs: !!ev.hs,
      longRange: !!ev.lr,
      noScope: !!ev.ns,
    });
  }

  setNames(players) {
    if (players instanceof Map) {
      for (const [id, name] of players) this.names.set(String(id), String(name));
    } else if (Array.isArray(players)) {
      for (const player of players) {
        if (player && player.id != null) {
          this.names.set(String(player.id), String(player.name || player.id));
        }
      }
    }
    return this.names;
  }

  nameFor(id) {
    if (this._resolveName) {
      const resolved = this._resolveName(id);
      if (resolved != null) return String(resolved);
    }
    return this.names.get(String(id)) ?? String(id);
  }

  killRow(entry) {
    const kf = this.dom.kf;
    if (!kf || !entry || this._disposed) return;

    const classes = ['kf-row'];
    if (entry.hs) classes.push('kf-hs');
    if (entry.noScope) classes.push('kf-no-scope');
    const row = el('div', classes.join(' '));
    const killer = el('b', '', row);
    killer.textContent = entry.killer;
    const glyph = el('span', 'kf-w', row);
    glyph.textContent = GLYPH[entry.glyphKey] || '?';
    const markers = [];
    if (entry.hs) markers.push('HEADSHOT');
    if (entry.longRange) markers.push('LONG RANGE');
    if (entry.noScope) markers.push('NO-SCOPE');
    for (const marker of markers) {
      const badge = el('em', 'kf-marker', row);
      badge.textContent = marker;
    }
    const victim = el('span', '', row);
    victim.textContent = entry.victim;

    if (typeof kf.insertBefore === 'function') kf.insertBefore(row, kf.firstChild);
    else if (typeof kf.prepend === 'function') kf.prepend(row);
    else if (typeof kf.appendChild === 'function') kf.appendChild(row);
    else return;

    this._killfeedRows.set(row, 0);
    while (this._killfeedRows.size > KILLFEED_MAX_ROWS) {
      const oldestTracked = this._killfeedRows.keys().next().value;
      this._removeKillRow(oldestTracked);
    }
    while (kf.children && kf.children.length > KILLFEED_MAX_ROWS) {
      this._removeKillRow(kf.lastElementChild || kf.lastChild);
    }

    this._setKillRowTimer(row, () => {
      if (row.isConnected === false) {
        this._killfeedRows.delete(row);
        removeNode(row);
        return;
      }
      row.style.transition = 'opacity 300ms linear';
      row.style.opacity = '0';
      this._setKillRowTimer(row, () => this._removeKillRow(row), KILLFEED_REMOVE_MS);
    }, KILLFEED_HOLD_MS);
  }

  _setKillRowTimer(row, callback, delay) {
    const prior = this._killfeedRows.get(row);
    if (prior) {
      this._clearTimer(prior);
      this.killfeedTimers.delete(prior);
    }
    let timer = 0;
    timer = this._setTimer(() => {
      this.killfeedTimers.delete(timer);
      if (this._killfeedRows.get(row) === timer) this._killfeedRows.set(row, 0);
      callback();
    }, delay);
    this._killfeedRows.set(row, timer);
    this.killfeedTimers.add(timer);
  }

  _removeKillRow(row) {
    if (!row) return;
    const timer = this._killfeedRows.get(row);
    if (timer) {
      this._clearTimer(timer);
      this.killfeedTimers.delete(timer);
    }
    this._killfeedRows.delete(row);
    removeNode(row);
  }

  clearKillfeed() {
    for (const timer of this.killfeedTimers) this._clearTimer(timer);
    this.killfeedTimers.clear();
    for (const row of Array.from(this._killfeedRows.keys())) removeNode(row);
    this._killfeedRows.clear();
  }

  hitmark(hs) {
    const hm = this.dom.hitmarker;
    if (!hm || this._disposed) return;
    if (this.hmTimer) this._clearTimer(this.hmTimer);
    hm.classList.remove('vb-show', 'show', 'pop', 'on');
    void hm.offsetWidth;
    hm.classList.add('vb-show');
    hm.classList.toggle('vb-hs', !!hs);
    hm.classList.toggle('hs', !!hs);
    this._hitmarkerNode = hm;
    this.hmTimer = this._setTimer(this._onHitmarkTimeout, HITMARK_MS);
  }

  _finishHitmark() {
    const hm = this._hitmarkerNode || this.dom.hitmarker;
    if (hm) hm.classList.remove('vb-show', 'show', 'pop', 'on', 'vb-hs', 'hs');
    this._hitmarkerNode = null;
    this.hmTimer = 0;
  }

  /* -------------------------------------------- own damage / death state */

  setOwnDamage(intensity01) {
    this.setPainImpulse(intensity01);
  }

  setPainImpulse(value) {
    if (this._disposed) return;
    const detail = value && typeof value === 'object' ? value : null;
    const raw = detail ? (detail.intensity ?? detail.value ?? detail.damage ?? 0) : value;
    const intensity = clamp01(raw);
    if (intensity === 0) {
      this.clearOwnDamage();
      return;
    }

    let x = detail ? Number(detail.x) : NaN;
    let y = detail ? Number(detail.y) : NaN;
    if (detail && Number.isFinite(Number(detail.angleDeg))) {
      const angle = Number(detail.angleDeg) * Math.PI / 180;
      x = Math.sin(angle);
      y = -Math.cos(angle);
    }
    if (!Number.isFinite(x) || !Number.isFinite(y) || Math.hypot(x, y) < 0.001) {
      this.painDirectionSeed = (this.painDirectionSeed + 137.508) % 360;
      const angle = this.painDirectionSeed * Math.PI / 180;
      x = Math.cos(angle);
      y = Math.sin(angle);
    } else {
      const length = Math.hypot(x, y);
      x /= length;
      y /= length;
    }

    this.flashV = Math.max(this.flashV, intensity);
    this.painImpulse = Math.max(this.painImpulse, intensity);
    const flash = this.dom.flash;
    if (flash) {
      flash.style.setProperty('--pain-x', `${(50 + x * 48).toFixed(2)}%`);
      flash.style.setProperty('--pain-y', `${(50 + y * 48).toFixed(2)}%`);
      flash.style.setProperty('--pain-rotation', `${(Math.atan2(y, x) * 180 / Math.PI).toFixed(2)}deg`);
      flash.style.opacity = String(this.flashV);
    }
    if (!this.built || this.flashRAF) return;

    this._painLastAt = this._now();
    this.flashRAF = this._requestFrame(this._onPainFrame);
  }

  _stepPain() {
    const now = this._now();
    const dt = Math.min(0.12, (now - this._painLastAt) / 1000);
    this._painLastAt = now;
    this.flashV = Math.max(0, this.flashV * Math.exp(-dt * 6.5) - dt * 0.22);
    this.painImpulse = Math.max(0, this.painImpulse * Math.exp(-dt * 4.8) - dt * 0.1);
    const flash = this.dom.flash;
    if (flash) flash.style.opacity = Math.min(1, this.flashV).toFixed(3);
    this._stress();
    if (this.flashV <= 0.001 && this.painImpulse <= 0.001) {
      this.flashV = 0;
      this.painImpulse = 0;
      if (flash) flash.style.opacity = '0';
      this.flashRAF = 0;
      return;
    }
    this.flashRAF = this._requestFrame(this._onPainFrame);
  }

  clearOwnDamage() {
    this.flashV = 0;
    this.painImpulse = 0;
    if (this.flashRAF) {
      this._cancelFrame(this.flashRAF);
      this.flashRAF = 0;
    }
    const flash = this.dom.flash;
    if (flash) flash.style.opacity = '0';
    this._stress();
  }

  clearDamage() {
    this.clearOwnDamage();
    this._damageNumbers.clear();
  }

  resetDamage() {
    this.clearDamage();
  }

  ensureDeathNote() {
    return this._deathTreatment.ensureNote();
  }

  showDeathNote(killerName) {
    this._deathTreatment.showNote(killerName);
  }

  hideDeathNote() {
    this._deathTreatment.hideNote();
  }

  styleDeathTreatment(force) {
    this._deathTreatment.style(force);
  }

  setDeathBrutality(value) {
    this._deathTreatment.setBrutality(value);
  }

  activateDeathTreatment() {
    this._deathTreatment.activate();
  }

  _finishDeathImpact() {
    this._deathTreatment.finishImpact();
  }

  resetDeathTreatment() {
    this._deathTreatment.reset();
  }

  setDead(dead, killerName = '') {
    if (this._disposed) return;
    this.dead = !!dead;
    if (!this.dead) this.resetDeathTreatment();
    else if (this.deathBrutality <= 0) this.deathBrutality = 0.85;

    if (this.dead) {
      if (this._closeBuyMenuDirect) this._closeBuyMenuDirect();
      const match = this.matchDom;
      if (match.interactBar) {
        match.interactBar.style.display = 'none';
        if (match.interactFill) match.interactFill.style.width = '0%';
      }
    }
    if (!this.built) return;

    const d = this.dom;
    if (d.ch) d.ch.classList.toggle('vb-dead', this.dead);
    if (this.dead) {
      if (this._resetScope) this._resetScope();
      else if (d.scope) {
        d.scope.classList.remove('active', 'exiting');
        d.scope.style.opacity = '';
        d.scope.style.transform = '';
      }
      if (this._setReloadProgress) this._setReloadProgress(null);
      this.clearOwnDamage();
      if (d.lowhp) d.lowhp.style.opacity = '0';
      this.activateDeathTreatment();
      this.showDeathNote(killerName);
    } else {
      this.hideDeathNote();
      const state = this.st;
      if (this._hideCrosshairForAds) {
        this._hideCrosshairForAds((Number(state.adsT01) || 0) > 0.35);
      }
      this._stress();
    }
  }

  /* ------------------------------------------------------ damage numbers */

  spawnDamage(amount, sx, sy, visible = true, hs = false) {
    return this._damageNumbers.spawn(amount, sx, sy, visible, hs);
  }

  takeDmgNode() {
    return this._damageNumbers.take();
  }

  placeDmg(rec, elapsed) {
    return this._damageNumbers.place(rec, elapsed);
  }

  dmgStep() {
    return this._damageNumbers.step();
  }

  _stepDamage() {
    return this._damageNumbers._step();
  }

  _releaseDamageRecord(rec) {
    return this._damageNumbers._release(rec);
  }

  /* ------------------------------------------------------------ lifecycle */

  reset(adapter = null) {
    this._clearPresentation(true);
    if (adapter) this.configure(adapter);
    this.names.clear();
    this.dead = false;
    this.flashV = 0;
    this.painImpulse = 0;
    this.painDirectionSeed = 0;
    this._painLastAt = 0;
    this._disposed = false;
    return this;
  }

  dispose() {
    if (this._disposed) return;
    this._clearPresentation(true);
    this.names.clear();
    this.dead = false;
    this.flashV = 0;
    this.painImpulse = 0;
    this.painDirectionSeed = 0;
    this._disposed = true;

    this._domSource = EMPTY;
    this._matchDomSource = EMPTY;
    this._stateSource = EMPTY;
    this._builtSource = false;
    this._hudRootSource = null;
    this._root = null;
    this._resolveName = null;
    this._closeBuyMenuDirect = null;
    this._resetScope = null;
    this._setReloadProgress = null;
    this._hideCrosshairForAds = null;
    this._updateCrosshairStress = null;
  }

  _clearPresentation(removeDamageNodes) {
    this.clearKillfeed();

    if (this.hmTimer) {
      this._clearTimer(this.hmTimer);
      this.hmTimer = 0;
    }
    this._finishHitmark();

    this.clearDamage();
    if (removeDamageNodes) this._damageNumbers.clear(true);
    this._damageNumbers.lastCritAt = -1e9;

    this._deathTreatment.clear(true);
  }
}
