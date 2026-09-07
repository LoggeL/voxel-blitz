import { WEAPONS } from '../../../shared/combatmath.js';
import { CHAOS_UPGRADES, chaosLevel, chaosPurchaseId } from '../../../shared/chaos.js';
import { WEAPON_PRICES } from '../../../shared/modes.js';
import {
  el,
  GLYPH,
  WEAPON_NAMES,
  THROWABLE_NAMES,
  WEAPON_CLASSES,
  WEAPON_BUY_ORDER,
} from './hud-support.js';

/**
 * Owns the S&D armory dialog and all of its mutable state. The host exposes
 * read-only primitive queries only: mode(), isAlive(), settingsOpen(), and
 * isLobbyOpen(). Closing settings is injected separately from those queries.
 */
export class BuyMenuController {
  constructor(host = {}, dismissSettings = null) {
    this.host = host;
    this.dismissSettings = typeof dismissSettings === 'function' ? dismissSettings : () => {};

    this._buyMenuCallbacks = null;
    this._buyMenuOpen = false;
    this._buyMenuState = {
      phase: 'idle',
      credits: 0,
      owned: [],
    };
    this.buyDom = {};
    this._buyPreviousFocus = null;
    this._onBuyKeyDown = null;
    this._isClosingBuyMenu = false;
    this._ownsRoot = false;
    this._deferredTimers = new Set();
    this._paintedState = null;
  }

  ensureBuyMenu() {
    const mode = this._isChaosMode() ? 'chaos' : 'snd';
    if (this.buyDom.root && this.buyDom.mode === mode) return this.buyDom.root;

    let root = document.getElementById('buy-menu');
    if (!root) {
      root = el('div', 'hidden', document.body, 'buy-menu');
      root.setAttribute('role', 'dialog');
      root.setAttribute('aria-modal', 'true');
      root.setAttribute('aria-labelledby', 'buy-title');
      root.setAttribute('aria-hidden', 'true');
      this._ownsRoot = true;
    }

    root.innerHTML = '';
    this._paintedState = null;
    root.classList.toggle('vb-chaos-shop', mode === 'chaos');
    root.style.display = 'none';

    const panel = el('div', 'vb-buy-panel', root);
    const header = el('div', 'vb-buy-header', panel);

    const titlesBox = el('div', 'vb-buy-titles', header);
    const title = el('h2', 'vb-title', titlesBox, 'buy-title');
    title.textContent = mode === 'chaos' ? 'CHAOS LAB' : 'ARMORY REQUISITION';
    const sub = el('div', 'vb-sub', titlesBox);
    sub.textContent = mode === 'chaos' ? 'Upgrades stack and survive death. The fight stays live.' : 'Tactical weapons procurement · Prep phase only';

    const metaBox = el('div', 'vb-buy-meta-row', header);

    const credMeta = el('div', 'vb-buy-meta-item', metaBox);
    el('span', 'vb-label', credMeta).textContent = 'CREDITS BALANCE';
    const credVal = el('span', 'vb-buy-credits-val', credMeta, 'buy-credits-val');
    credVal.textContent = '$ 800';

    const phaseMeta = el('div', 'vb-buy-meta-item', metaBox);
    el('span', 'vb-label', phaseMeta).textContent = 'STATUS';
    const phaseVal = el('span', 'vb-buy-phase-val', phaseMeta, 'buy-phase-val');
    phaseVal.textContent = 'PREP PHASE';

    const closeBtn = el('button', 'vb-buy-close-btn', metaBox, 'buy-close-btn');
    closeBtn.type = 'button';
    closeBtn.textContent = '✕ CLOSE [ESC]';
    closeBtn.setAttribute('aria-label', mode === 'chaos' ? 'Close Chaos Lab' : 'Close Armory Requisition');

    const grid = el('div', 'vb-buy-grid', panel, 'buy-grid');
    const cards = {};

    const itemOrder = mode === 'chaos' ? Object.keys(CHAOS_UPGRADES) : WEAPON_BUY_ORDER;
    itemOrder.forEach((wid, index) => {
      const def = WEAPONS[wid] || {};
      const price = WEAPON_PRICES[wid] || 0;
      // 1..9 then 0 for the tenth entry, matching the digit shortcuts below.
      const keyNumber = (index + 1) % 10;

      const card = el('div', 'vb-buy-card', grid, `buy-card-${wid}`);
      card.dataset.wid = wid;

      const cardTop = el('div', 'vb-buy-card-top', card);
      const keyBadge = el('span', 'vb-buy-key-badge', cardTop);
      keyBadge.textContent = index < 10 ? `[${keyNumber}]` : WEAPONS[wid] ? 'SELECT' : 'GRENADE';

      const glyphBadge = el('span', `vb-buy-glyph-badge vb-w-${wid}`, cardTop);
      glyphBadge.textContent = GLYPH[wid] || wid.toUpperCase();
      if (mode === 'chaos') glyphBadge.remove();

      const priceBadge = el('span', 'vb-buy-price-badge', cardTop, `buy-price-${wid}`);
      priceBadge.textContent = price > 0 ? `$${price.toLocaleString()}` : 'FREE';

      const cardBody = el('div', 'vb-buy-card-body', card);
      const nameEl = el('div', 'vb-buy-wname', cardBody);
      nameEl.textContent = WEAPON_NAMES[wid] || THROWABLE_NAMES[wid] || def.name || wid.toUpperCase();

      const classEl = el('div', 'vb-buy-wclass', cardBody);
      classEl.textContent = WEAPON_CLASSES[wid] || 'TACTICAL WEAPON';

      const statsEl = el('div', 'vb-buy-wstats', cardBody);
      const damage = Array.isArray(def.damage) ? def.damage[0] : (def.damage || 0);
      const rpm = def.rpm || 0;
      const mag = def.magSize || 0;
      const spareMags = def.spareMags || 0;
      statsEl.textContent = `DMG ${damage} · ${rpm ? `${rpm} RPM · ` : ''}${mag} RDS · ${spareMags} MAGS`;

      const stages = [];
      if (mode === 'chaos') {
        classEl.textContent = ['frag', 'limpet', 'pulse'].includes(wid) ? 'GRENADE EXPERIMENTS' : 'WEAPON EXPERIMENTS';
        classEl.remove();
        statsEl.remove();
        if (WEAPONS[wid]) {
          const image = el('img', 'vb-chaos-weapon-image', cardBody);
          image.src = `./assets/weapons/hud/${wid}.png`;
          image.alt = '';
          image.draggable = false;
          cardBody.insertBefore(image, nameEl);
        }
        const ladder = el('ol', 'vb-chaos-ladder', cardBody);
        CHAOS_UPGRADES[wid].forEach((upgrade) => {
          const stage = el('li', 'vb-chaos-stage', ladder);
          const heading = el('strong', '', stage);
          heading.textContent = `${upgrade.name} · $${upgrade.price}`;
          el('span', '', stage).textContent = upgrade.description;
          stages.push(stage);
        });
      }

      const cardBottom = el('div', 'vb-buy-card-bottom', card);
      const buyBtn = el('button', 'vb-btn vb-buy-btn', cardBottom, `buy-btn-${wid}`);
      buyBtn.type = 'button';
      buyBtn.textContent = `BUY $${price.toLocaleString()}`;
      buyBtn.dataset.wid = wid;

      buyBtn.addEventListener('click', (event) => {
        event.preventDefault();
        this.triggerPurchase(wid);
      });

      cards[wid] = {
        card,
        priceBadge,
        buyBtn,
        price,
        stages,
      };
    });

    const footer = el('div', 'vb-buy-footer', panel);
    const hint = el('span', 'vb-buy-footer-hint', footer);
    hint.textContent = mode === 'chaos' ? '[1-9, 0] WEAPONS · CLICK GRENADES · [ESC] CLOSE' : 'PRESS [1-8] TO BUY · [ESC] TO CLOSE · UI UPDATES ON SERVER CONFIRMATION';

    this.buyDom = {
      root,
      mode,
      itemOrder,
      panel,
      credVal,
      phaseVal,
      closeBtn,
      cards,
    };

    closeBtn.addEventListener('click', (event) => {
      event.preventDefault();
      this.toggleBuyMenu(false);
    });

    if (!this._onBuyKeyDown) {
      this._onBuyKeyDown = (event) => {
        if (!this._buyMenuOpen) return;

        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          this.toggleBuyMenu(false);
          return;
        }

        if (event.key === 'Tab') {
          const buttons = [...this.buyDom.root.querySelectorAll('button:not(:disabled)')];
          if (buttons.length) {
            event.preventDefault();
            event.stopPropagation();
            const current = buttons.indexOf(document.activeElement);
            buttons[(current + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length].focus();
          }
          return;
        }
        if (event.repeat) return;

        let digitIndex = -1;
        if (event.code >= 'Digit1' && event.code <= 'Digit9') {
          digitIndex = parseInt(event.code.replace('Digit', ''), 10) - 1;
        } else if (event.code === 'Digit0') {
          digitIndex = 9; // 0 trails 9 as the tenth weapon shortcut
        } else if (event.code >= 'Numpad1' && event.code <= 'Numpad9') {
          digitIndex = parseInt(event.code.replace('Numpad', ''), 10) - 1;
        } else if (event.code === 'Numpad0') {
          digitIndex = 9;
        }

        if (digitIndex >= 0 && digitIndex < this.buyDom.itemOrder.length) {
          event.preventDefault();
          event.stopPropagation();
          this.triggerPurchase(this.buyDom.itemOrder[digitIndex]);
        }
      };
      document.addEventListener('keydown', this._onBuyKeyDown, true);
    }

    this.syncBuyMenuUI();
    return root;
  }

  setupBuyMenu({ onBuy, onClose } = {}) {
    this._buyMenuCallbacks = { onBuy, onClose };
    this.ensureBuyMenu();
  }

  setBuyMenuState({ open, phase, credits, owned, chaosUpgrades } = {}) {
    if (phase !== undefined) this._buyMenuState.phase = phase;
    if (credits !== undefined) this._buyMenuState.credits = Number(credits) || 0;
    if (owned !== undefined) {
      this._buyMenuState.owned = Array.isArray(owned) ? owned.slice() : [];
    }

    if (chaosUpgrades !== undefined) this._buyMenuState.chaosUpgrades = { ...chaosUpgrades };
    if (this.buyDom.root && this.buyDom.mode !== (this._isChaosMode() ? 'chaos' : 'snd')) {
      this.closeBuyMenuDirect();
      this.ensureBuyMenu();
    }

    const admitted = this._isAdmitted();
    if (open !== undefined) {
      if (open && admitted && !this._buyMenuOpen && !this._isClosingBuyMenu) {
        this.toggleBuyMenu(true);
      } else if ((!open || !admitted) && this._buyMenuOpen) {
        this.toggleBuyMenu(false);
      }
    } else if (this._buyMenuOpen && !admitted) {
      this.toggleBuyMenu(false);
    }

    if (this._buyMenuOpen) this.syncBuyMenuUI();
  }

  toggleBuyMenu(force) {
    this.ensureBuyMenu();
    const shouldOpen = force !== undefined ? !!force : !this._buyMenuOpen;

    if (shouldOpen) {
      if (this._isClosingBuyMenu || !this._isAdmitted()) return false;

      this.dismissSettings();
      this._buyMenuOpen = true;
      const root = this.buyDom.root;
      if (root) {
        root.classList.remove('hidden');
        root.style.display = 'flex';
        root.setAttribute('aria-hidden', 'false');
      }

      this._buyPreviousFocus = document.activeElement;
      this.syncBuyMenuUI();

      this._defer(() => {
        try {
          if (this._buyMenuOpen && this.buyDom.closeBtn) {
            this.buyDom.closeBtn.focus();
          }
        } catch (_) {}
      });

      return true;
    }

    if (this._isClosingBuyMenu) return false;
    const wasOpen = this._buyMenuOpen;
    this.closeBuyMenuDirect();
    if (wasOpen && typeof this._buyMenuCallbacks?.onClose === 'function') {
      this._isClosingBuyMenu = true;
      try {
        this._buyMenuCallbacks.onClose();
      } finally {
        this._isClosingBuyMenu = false;
      }
    }
    return false;
  }

  closeBuyMenuDirect() {
    this._buyMenuOpen = false;
    const root = this.buyDom.root;
    if (root) {
      root.classList.add('hidden');
      root.style.display = 'none';
      root.setAttribute('aria-hidden', 'true');
    }

    const previousFocus = this._buyPreviousFocus;
    this._buyPreviousFocus = null;
    if (
      previousFocus
      && !root?.contains(previousFocus)
      && typeof previousFocus.focus === 'function'
    ) {
      try { previousFocus.focus(); } catch (_) {}
    }
  }

  isBuyMenuOpen() {
    return !!this._buyMenuOpen;
  }

  triggerPurchase(wid) {
    if (!wid) return;
    const cardData = this.buyDom.cards && this.buyDom.cards[wid];
    if (!cardData) return;

    if (!this._isAdmitted() || !this._buyMenuOpen) return;
    if (this._isChaosMode()) {
      const level = chaosLevel(this._buyMenuState, wid);
      const upgrade = CHAOS_UPGRADES[wid]?.[level];
      if (!upgrade || this._buyMenuState.credits < upgrade.price) return;
      this._buyMenuCallbacks?.onBuy?.(chaosPurchaseId(wid, level));
      return;
    }

    if (this._buyMenuState.credits < cardData.price) return;

    if (typeof this._buyMenuCallbacks?.onBuy === 'function') {
      this._buyMenuCallbacks.onBuy(wid);
    }
  }

  syncBuyMenuUI() {
    const dom = this.buyDom;
    if (!dom.root) return;

    // Store incoming state while closed, and repaint an open dialog only when
    // the fields it actually presents change. Successive snapshots often
    // contain the same authoritative economy.
    const state = this._buyMenuState;
    const painted = JSON.stringify([dom.mode, this._isAdmitted(), this._isAlive(),
      state.phase, state.credits, state.owned, state.chaosUpgrades]);
    if (painted === this._paintedState) return;
    this._paintedState = painted;

    if (this._isChaosMode()) {
      this._syncChaosUI();
      return;
    }

    const credits = this._buyMenuState.credits;
    const owned = this._buyMenuState.owned || [];
    const phase = this._buyMenuState.phase;
    const isPrep = phase === 'prep';
    const isAlive = this._isAlive();

    if (dom.credVal) {
      dom.credVal.textContent = `$ ${Number(credits).toLocaleString()}`;
    }

    if (dom.phaseVal) {
      dom.phaseVal.textContent = isPrep ? 'PREP (BUY OPEN)' : 'CLOSED (LOCKED)';
      dom.phaseVal.classList.toggle('is-open', isPrep);
      dom.phaseVal.classList.toggle('is-closed', !isPrep);
    }

    if (!dom.cards) return;
    for (const wid of WEAPON_BUY_ORDER) {
      const item = dom.cards[wid];
      if (!item) continue;

      const isOwned = owned.includes(wid);
      const canAfford = credits >= item.price;
      const { buyBtn, card } = item;
      const weaponName = WEAPON_NAMES[wid] || wid.toUpperCase();

      card.classList.toggle('is-owned', isOwned);
      card.classList.toggle('is-unaffordable', !isOwned && !canAfford);
      card.classList.toggle('can-buy', !isOwned && canAfford && isPrep && isAlive);
      card.classList.toggle('is-locked', !isPrep || !isAlive);

      if (!isAlive) {
        buyBtn.textContent = 'ELIMINATED';
        buyBtn.disabled = true;
        buyBtn.setAttribute('aria-disabled', 'true');
        buyBtn.title = `Armory locked · Player eliminated (${weaponName})`;
      } else if (!isPrep) {
        buyBtn.textContent = item.price > 0
          ? `LOCKED · $${item.price.toLocaleString()}`
          : 'LOCKED · FREE';
        buyBtn.disabled = true;
        buyBtn.setAttribute('aria-disabled', 'true');
        buyBtn.title = `Armory locked · ${weaponName} available during prep phase`;
      } else if (!canAfford) {
        buyBtn.textContent = `NEED $${item.price.toLocaleString()}`;
        buyBtn.disabled = true;
        buyBtn.setAttribute('aria-disabled', 'true');
        buyBtn.title = `Insufficient funds: need $${item.price.toLocaleString()} for ${weaponName} (balance $${credits.toLocaleString()})`;
      } else if (isOwned) {
        buyBtn.textContent = item.price > 0
          ? `REFILL $${item.price.toLocaleString()}`
          : 'REFILL FREE';
        buyBtn.disabled = false;
        buyBtn.setAttribute('aria-disabled', 'false');
        buyBtn.title = item.price > 0
          ? `Refill ammunition for ${weaponName} ($${item.price.toLocaleString()})`
          : `Refill free ammunition for ${weaponName}`;
      } else {
        buyBtn.textContent = item.price > 0
          ? `BUY $${item.price.toLocaleString()}`
          : 'CLAIM FREE';
        buyBtn.disabled = false;
        buyBtn.setAttribute('aria-disabled', 'false');
        buyBtn.title = item.price > 0
          ? `Purchase ${weaponName} for $${item.price.toLocaleString()}`
          : `Claim free ${weaponName}`;
      }
    }
  }

  _syncChaosUI() {
    const { credVal, phaseVal, cards } = this.buyDom;
    const credits = this._buyMenuState.credits;
    const admitted = this._isAdmitted();
    credVal.textContent = `$ ${credits.toLocaleString()}`;
    phaseVal.textContent = admitted ? 'EXPERIMENTS OPEN' : 'LAB LOCKED';
    phaseVal.classList.toggle('is-open', admitted);
    phaseVal.classList.toggle('is-closed', !admitted);
    for (const [id, item] of Object.entries(cards)) {
      const level = chaosLevel(this._buyMenuState, id);
      const next = CHAOS_UPGRADES[id][level];
      const canAfford = !!next && credits >= next.price;
      item.priceBadge.textContent = `${level} / 3 INSTALLED`;
      item.card.classList.toggle('is-owned', !next);
      item.card.classList.toggle('is-unaffordable', !!next && !canAfford);
      item.card.classList.toggle('can-buy', admitted && canAfford);
      item.card.classList.toggle('is-locked', !admitted);
      item.stages.forEach((stage, index) => {
        stage.classList.toggle('is-installed', index < level);
        stage.classList.toggle('is-next', index === level);
      });
      item.buyBtn.disabled = !admitted || !canAfford;
      item.buyBtn.setAttribute('aria-disabled', String(item.buyBtn.disabled));
      item.buyBtn.textContent = !next ? 'MAXIMUM STUPIDITY' : !admitted ? 'LAB LOCKED' : canAfford ? `UPGRADE ${level + 1} · $${next.price}` : `NEED $${next.price - credits} MORE`;
      item.buyBtn.title = next ? `${next.name}: ${next.description}` : 'All three upgrades installed';
    }
  }

  dispose() {
    for (const timer of this._deferredTimers) clearTimeout(timer);
    this._deferredTimers.clear();

    if (this._onBuyKeyDown && typeof document !== 'undefined') {
      document.removeEventListener('keydown', this._onBuyKeyDown, true);
    }
    this._onBuyKeyDown = null;

    this.closeBuyMenuDirect();
    const root = this.buyDom.root;
    if (root) {
      if (this._ownsRoot) root.remove();
      else root.innerHTML = '';
    }

    this._buyMenuCallbacks = null;
    this.buyDom = {};
    this._paintedState = null;
    this._buyMenuState = { phase: 'idle', credits: 0, owned: [] };
    this._isClosingBuyMenu = false;
    this._buyMenuOpen = false;
    this._buyPreviousFocus = null;
    this._ownsRoot = false;
  }

  _isAdmitted() {
    return ((this._isSndMode() && this._buyMenuState.phase === 'prep')
      || (this._isChaosMode() && this._buyMenuState.phase === 'live'))
      && this._isAlive()
      && !this.host.settingsOpen?.()
      && !this.host.isLobbyOpen?.();
  }

  _isChaosMode() {
    return this.host.mode?.() === 'chaos';
  }

  _isSndMode() {
    const mode = this.host.mode?.();
    return mode == null || mode === 'snd';
  }

  _isAlive() {
    return this.host.isAlive?.() ?? true;
  }

  _defer(callback) {
    const timer = setTimeout(() => {
      this._deferredTimers.delete(timer);
      callback();
    }, 0);
    this._deferredTimers.add(timer);
    return timer;
  }
}
