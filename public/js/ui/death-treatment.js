import { createDeathSignature } from '../cosmetics/signature.js';
import { clamp01, el } from './hud-support.js';

const DEATH_IMPACT_MS = 420;

// Owns death-note DOM and the complete death-impact timer lifecycle.
export class DeathTreatment {
  constructor({ getDom, getHudRoot, isDead, isDisposed, setTimer, clearTimer }) {
    this.brutality = 0;
    this.impactTimer = 0;
    this._ownedNote = null;
    this._ownedRecap = null;

    this._getDom = getDom;
    this._getHudRoot = getHudRoot;
    this._isDead = isDead;
    this._isDisposed = isDisposed;
    this._setTimer = setTimer;
    this._clearTimer = clearTimer;
    this._onImpactTimeout = () => this.finishImpact();
  }

  ensureNote() {
    const dom = this._getDom();
    if (dom.deathnote) return dom.deathnote;
    if (this._ownedNote) return this._ownedNote;
    const hud = this._getHudRoot();
    if (!hud) return null;
    const note = el('div', '', hud, 'deathnote');
    dom.deathnote = note;
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
    dom.deathrecap = recap;
    this._ownedRecap = recap;
    return recap;
  }

  showNote(killerName, recapText = '', cosmetics = null) {
    const note = this.ensureNote();
    if (!note) return;
    note.textContent = killerName ? `eliminated by ${killerName}` : 'eliminated';
    note.style.display = 'block';
    this._signature?.remove();
    this._signature = cosmetics?.signature ? createDeathSignature(cosmetics.signature) : null;
    if (this._signature) note.append(this._signature);
    const recap = this.ensureRecap();
    if (recap) {
      recap.textContent = recapText || '';
      recap.style.display = recapText ? 'block' : 'none';
    }
  }

  hideNote() {
    this._signature?.remove();
    this._signature = null;
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

  clear() {
    this.reset();
    this.hideNote();
    const dom = this._getDom();
    if (this._ownedNote) {
      this._ownedNote?.remove();
      if (dom.deathnote === this._ownedNote) delete dom.deathnote;
      this._ownedNote = null;
    }
    if (this._ownedRecap) {
      this._ownedRecap?.remove();
      if (dom.deathrecap === this._ownedRecap) delete dom.deathrecap;
      this._ownedRecap = null;
    }
  }
}
