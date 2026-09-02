import { clamp01, el, removeNode } from './hud-support.js';

export const DEATH_IMPACT_MS = 420;

const EMPTY = Object.freeze({});

// Owns death-note DOM and the complete death-impact timer lifecycle. Its small
// interface keeps the combat controller compatible without sharing ownership.
export class DeathTreatment {
  constructor(adapter = EMPTY) {
    this.brutality = 0;
    this.impactTimer = 0;
    this._ownedNote = null;
    this._ownedRecap = null;

    this._getDom = () => EMPTY;
    this._getHudRoot = () => null;
    this._isDead = () => false;
    this._isDisposed = () => false;
    this._setTimer = () => 0;
    this._clearTimer = () => {};
    this._onImpactTimeout = () => this.finishImpact();
    this.configure(adapter);
  }

  configure(adapter = EMPTY) {
    if (typeof adapter.getDom === 'function') this._getDom = adapter.getDom;
    if (typeof adapter.getHudRoot === 'function') this._getHudRoot = adapter.getHudRoot;
    if (typeof adapter.isDead === 'function') this._isDead = adapter.isDead;
    if (typeof adapter.isDisposed === 'function') this._isDisposed = adapter.isDisposed;
    if (typeof adapter.setTimer === 'function') this._setTimer = adapter.setTimer;
    if (typeof adapter.clearTimer === 'function') this._clearTimer = adapter.clearTimer;
    return this;
  }

  get ownedNote() { return this._ownedNote; }

  ensureNote() {
    const dom = this._getDom();
    if (dom.deathnote) return dom.deathnote;
    if (this._ownedNote) return this._ownedNote;
    const hud = this._getHudRoot();
    if (!hud) return null;
    const note = el('div', '', hud, 'deathnote');
    if (dom !== EMPTY && Object.isExtensible(dom)) dom.deathnote = note;
    this._ownedNote = note;
    return note;
  }

  /** The recap (weapon, range, killer's remaining health) sits under the note. */
  ensureRecap() {
    const dom = this._getDom();
    if (dom.deathrecap) return dom.deathrecap;
    if (this._ownedRecap) return this._ownedRecap;
    const hud = this._getHudRoot();
    if (!hud) return null;
    const recap = el('div', '', hud, 'deathrecap');
    if (dom !== EMPTY && Object.isExtensible(dom)) dom.deathrecap = recap;
    this._ownedRecap = recap;
    return recap;
  }

  showNote(killerName, recapText = '') {
    const note = this.ensureNote();
    if (!note) return;
    note.textContent = killerName ? `eliminated by ${killerName}` : 'eliminated';
    note.style.display = 'block';
    const recap = this.ensureRecap();
    if (recap) {
      recap.textContent = recapText || '';
      recap.style.display = recapText ? 'block' : 'none';
    }
  }

  hideNote() {
    const note = this._getDom().deathnote || this._ownedNote;
    if (note) note.style.display = 'none';
    const recap = this._getDom().deathrecap || this._ownedRecap;
    if (recap) recap.style.display = 'none';
  }

  style(force) {
    const fx = this._getDom().deathFx;
    if (!fx) return;
    const strength = clamp01(force);
    fx.style.setProperty('--death-opacity', (0.58 + strength * 0.18).toFixed(3));
    fx.style.setProperty('--death-blood-opacity', (0.38 + strength * 0.34).toFixed(3));
  }

  setBrutality(value) {
    if (this._isDisposed()) return;
    this.brutality = clamp01(value);
    this.style(this.brutality);
    if (this._isDead() && this.brutality > 0) this.activate();
  }

  activate() {
    const fx = this._getDom().deathFx;
    if (!fx || this._isDisposed()) return;
    const force = this.brutality || 0.85;
    this.brutality = force;
    this.style(force);
    fx.classList.add('vb-active');
    fx.classList.remove('vb-impact');
    void fx.offsetWidth;
    fx.classList.add('vb-impact');
    if (this.impactTimer) this._clearTimer(this.impactTimer);
    this.impactTimer = this._setTimer(this._onImpactTimeout, DEATH_IMPACT_MS);
  }

  finishImpact() {
    this.impactTimer = 0;
    const fx = this._getDom().deathFx;
    if (fx) fx.classList.remove('vb-impact');
  }

  reset() {
    this.brutality = 0;
    if (this.impactTimer) {
      this._clearTimer(this.impactTimer);
      this.impactTimer = 0;
    }
    const fx = this._getDom().deathFx;
    if (fx) {
      fx.classList.remove('vb-active', 'vb-impact');
      this.style(0);
    }
  }

  clear(removeOwnedNote = false) {
    this.reset();
    this.hideNote();
    if (!removeOwnedNote) return;
    const dom = this._getDom();
    if (this._ownedNote) {
      removeNode(this._ownedNote);
      if (dom.deathnote === this._ownedNote) delete dom.deathnote;
      this._ownedNote = null;
    }
    if (this._ownedRecap) {
      removeNode(this._ownedRecap);
      if (dom.deathrecap === this._ownedRecap) delete dom.deathrecap;
      this._ownedRecap = null;
    }
  }
}
