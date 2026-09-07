// Combat-only HUD feedback. The controller owns every timer, animation handle,
// pool, and transient combat value. Gameplay supplies stable DOM/state objects
// and the presentation callbacks needed by death transitions.

import {
  WEAPON_NAMES,
  THROWABLE_NAMES,
  el,
  clamp01,
  resolveKey,
} from './hud-support.js';
import { DamageNumberPool } from './damage-numbers.js';
import { DeathTreatment } from './death-treatment.js';

const KILLFEED_MAX_ROWS = 5;
const KILLFEED_HOLD_MS = 4000;
const KILLFEED_REMOVE_MS = 320;
const HITMARK_MS = 210;
const KILLMARK_MS = 520;

const EMPTY = Object.freeze({});

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

/** Owns transient combat presentation across gameplay HUD rebuilds. */
export class CombatHudController {
  constructor({ dom, matchDom, state, isBuilt, getHudRoot, closeBuyMenuDirect,
    resetScope, setReloadProgress, hideCrosshairForAds, updateCrosshairStress }) {
    this.dom = dom;
    this.matchDom = matchDom;
    this.st = state;
    this._isBuilt = isBuilt;
    this._getHudRoot = getHudRoot;
    this._closeBuyMenuDirect = closeBuyMenuDirect;
    this._resetScope = resetScope;
    this._setReloadProgress = setReloadProgress;
    this._hideCrosshairForAds = hideCrosshairForAds;
    this._updateCrosshairStress = updateCrosshairStress;

    this._now = nowDefault;
    this._random = Math.random;
    this._requestFrame = requestFrameDefault;
    this._cancelFrame = cancelFrameDefault;
    // Browser timer functions may require their global receiver. Wrappers keep
    // timer calls safe as ordinary methods in strict ES modules.
    this._setTimer = (callback, delay) => setTimeout(callback, delay);
    this._clearTimer = (handle) => clearTimeout(handle);

    this.names = new Map();
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
      isBuilt: () => this._isBuilt(),
      isDisposed: () => this._disposed,
      now: () => this._now(),
      random: () => this._random(),
      requestFrame: (callback) => this._requestFrame(callback),
      cancelFrame: (handle) => this._cancelFrame(handle),
    });
    this._deathTreatment = new DeathTreatment({
      getDom: () => this.dom,
      getHudRoot: () => this._getHudRoot(),
      isDead: () => this.dead,
      isDisposed: () => this._disposed,
      setTimer: (callback, delay) => this._setTimer(callback, delay),
      clearTimer: (handle) => this._clearTimer(handle),
    });
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

  setNames(players) {
    if (Array.isArray(players)) {
      for (const player of players) {
        if (player && player.id != null) {
          this.names.set(String(player.id), String(player.name || player.id));
        }
      }
    }
    return this.names;
  }

  nameFor(id) {
    return this.names.get(String(id)) ?? String(id);
  }

  killfeed(ev) {
    const kf = this.dom.kf;
    if (!kf || !ev || this._disposed) return;

    const classes = ['kf-row'];
    if (ev.hs) classes.push('kf-hs');
    if (ev.ns) classes.push('kf-no-scope');
    const row = el('div', classes.join(' '));
    const killer = el('b', '', row);
    killer.textContent = this.nameFor(ev.killer);
    const weaponKey = resolveKey(ev.w);
    const throwable = !!(weaponKey && THROWABLE_NAMES[weaponKey]);
    const weapon = el('span', `kf-weapon kf-weapon-${weaponKey || 'world'}`, row);
    if (weaponKey && WEAPON_NAMES[weaponKey]) {
      const icon = el('img', 'kf-weapon-icon', weapon);
      icon.src = `./assets/weapons/hud/${weaponKey}.png`;
      icon.alt = '';
      icon.setAttribute('aria-hidden', 'true');
    } else {
      const icon = el('span', 'kf-grenade-icon', weapon);
      icon.textContent = throwable ? '◆' : '·';
      icon.setAttribute('aria-hidden', 'true');
    }
    const weaponName = el('span', 'kf-weapon-name', weapon);
    weaponName.textContent = throwable
      ? THROWABLE_NAMES[weaponKey]
      : (WEAPON_NAMES[weaponKey] || 'ENVIRONMENT');
    const markers = [];
    if (ev.hs) markers.push('HEADSHOT');
    if (ev.lr) markers.push('LONG RANGE');
    if (ev.ns) markers.push('NO-SCOPE');
    for (const marker of markers) {
      const badge = el('em', 'kf-marker', row);
      badge.textContent = marker;
    }
    const victim = el('span', '', row);
    victim.textContent = this.nameFor(ev.victim);

    kf.insertBefore(row, kf.firstChild);

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
        row?.remove();
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
    }
    let timer = 0;
    timer = this._setTimer(() => {
      if (this._killfeedRows.get(row) === timer) this._killfeedRows.set(row, 0);
      callback();
    }, delay);
    this._killfeedRows.set(row, timer);
  }

  _removeKillRow(row) {
    if (!row) return;
    const timer = this._killfeedRows.get(row);
    if (timer) {
      this._clearTimer(timer);
    }
    this._killfeedRows.delete(row);
    row?.remove();
  }

  clearKillfeed() {
    for (const [row, timer] of this._killfeedRows) {
      if (timer) this._clearTimer(timer);
      row.remove();
    }
    this._killfeedRows.clear();
  }

  hitmark(kind) {
    const hm = this.dom.hitmarker;
    if (!hm || this._disposed) return;
    const resolved = kind === true ? 'head' : (typeof kind === 'string' ? kind : 'body');
    const kill = resolved === 'kill' || resolved === 'killHead';
    const hs = resolved === 'head' || resolved === 'killHead';
    // A kill mark is never downgraded by a trailing body-hit confirmation.
    if (this.hmTimer && this._hitmarkKind?.startsWith('kill') && !kill) return;
    if (this.hmTimer) this._clearTimer(this.hmTimer);
    hm.classList.remove('vb-show', 'show', 'pop', 'on');
    void hm.offsetWidth;
    hm.classList.add('vb-show');
    hm.classList.toggle('vb-hs', hs);
    hm.classList.toggle('hs', hs);
    hm.classList.toggle('vb-kill', kill);
    this._hitmarkerNode = hm;
    this._hitmarkKind = resolved;
    this.hmTimer = this._setTimer(this._onHitmarkTimeout, kill ? KILLMARK_MS : HITMARK_MS);
  }

  _finishHitmark() {
    const hm = this._hitmarkerNode || this.dom.hitmarker;
    if (hm) hm.classList.remove('vb-show', 'show', 'pop', 'on', 'vb-hs', 'hs', 'vb-kill');
    this._hitmarkerNode = null;
    this._hitmarkKind = null;
    this.hmTimer = 0;
  }

  /* -------------------------------------------- own damage / death state */

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
    if (!this._isBuilt() || this.flashRAF) return;

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

  hideDeathNote() {
    this._deathTreatment.hideNote();
  }

  setDeathBrutality(value) {
    this._deathTreatment.setBrutality(value);
  }

  setDead(dead, killerName = '', recap = '') {
    if (this._disposed) return;
    this.dead = !!dead;
    if (!this.dead) this._deathTreatment.reset();
    else if (this._deathTreatment.brutality <= 0) this._deathTreatment.brutality = 0.85;

    if (this.dead) {
      if (this._closeBuyMenuDirect) this._closeBuyMenuDirect();
      const match = this.matchDom;
      if (match.interactBar) {
        match.interactBar.style.display = 'none';
        if (match.interactFill) match.interactFill.style.width = '0%';
      }
    }
    if (!this._isBuilt()) return;

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
      this._deathTreatment.activate();
      this._deathTreatment.showNote(killerName, recap);
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

  spawnDamage(amount, sx, sy, visible = true, hs = false, stackKey = null) {
    return this._damageNumbers.spawn(amount, sx, sy, visible, hs, stackKey);
  }

  /* ------------------------------------------------------------ lifecycle */

  reset() {
    this._clearPresentation();
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
    this._clearPresentation();
    this.names.clear();
    this.dead = false;
    this.flashV = 0;
    this.painImpulse = 0;
    this.painDirectionSeed = 0;
    this._disposed = true;

    this.dom = this.matchDom = this.st = EMPTY;
    this._isBuilt = () => false;
    this._getHudRoot = () => null;
    this._closeBuyMenuDirect = null;
    this._resetScope = null;
    this._setReloadProgress = null;
    this._hideCrosshairForAds = null;
    this._updateCrosshairStress = null;
  }

  _clearPresentation() {
    this.clearKillfeed();

    if (this.hmTimer) {
      this._clearTimer(this.hmTimer);
      this.hmTimer = 0;
    }
    this._finishHitmark();

    this.clearOwnDamage();
    this._damageNumbers.reset();

    this._deathTreatment.clear();
  }
}
