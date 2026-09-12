import { CAREER_CATALOG } from '../../../shared/career.js';
import { mountMusicControl } from './music-control.js';

const node = (tag, parent, text, className = '') => {
  const element = document.createElement(tag);
  element.className = className;
  if (text) element.textContent = text;
  parent.append(element);
  return element;
};

function artwork(parent, item, className = '') {
  const container = className ? node('div', parent, '', className) : parent;
  const art = node('div', container, '', 'vb-cosmetic-art');
  const index = Math.max(0, CAREER_CATALOG.findIndex(entry => entry.id === item?.id));
  art.style.backgroundPosition = `${(index % 4) * 100 / 3}% ${index < 4 ? 0 : 100}%`;
  art.setAttribute('aria-hidden', 'true');
  return className ? container : art;
}

const format = value => Number(value || 0).toLocaleString('en-US');

export class CareerShop {
  constructor({ accounts = null } = {}) {
    this.accounts = accounts;
    this.profile = null;
    this.busy = false;
    this.filter = 'all';
    this.dialog = node('dialog', document.body, '', 'vb-career');
    this.dialog.id = 'career-shop';
    this.dialog.setAttribute('aria-labelledby', 'career-title');
    const header = node('header', this.dialog, '', 'vb-career-header');
    node('span', header, 'VOXEL BLITZ', 'vb-career-brand');
    node('h2', header, 'CAREER & SHOP').id = 'career-title';
    mountMusicControl(header);
    this.wallet = node('div', header, '', 'vb-career-wallet');
    this.wallet.setAttribute('aria-label', 'Career credits');
    const close = node('button', header, 'BACK', 'vb-btn');
    close.id = 'career-close'; close.type = 'button';
    close.addEventListener('click', () => this.dialog.close());
    const layout = node('div', this.dialog, '', 'vb-career-layout');
    this.sidebar = node('aside', layout, '', 'vb-career-profile');
    node('span', this.sidebar, 'YOUR CAREER', 'vb-career-kicker');
    this.rank = node('div', this.sidebar, '', 'vb-career-rank');
    this.playerName = node('h3', this.sidebar, 'GUEST PLAYER', 'vb-career-player');
    this.titleName = node('p', this.sidebar, '', 'vb-career-title-name');
    this.stats = node('div', this.sidebar, '', 'vb-career-stats');
    this.progress = node('progress', this.sidebar);
    this.progress.setAttribute('aria-label', 'Progress to next career level');
    this.xpRemaining = node('p', this.sidebar, '', 'vb-career-xp-remaining');
    this.record = node('div', this.sidebar, '', 'vb-career-record');
    const accountRow = node('div', this.sidebar, '', 'vb-career-account');
    this.accountDescription = node('p', accountRow);
    this.accountButton = node('button', accountRow, 'SAVE YOUR CAREER', 'vb-btn');
    this.accountButton.id = 'career-account';
    this.accountButton.type = 'button';
    this.accountButton.addEventListener('click', () => this.accounts?.open(this.accounts.user ? 'account' : 'register'));
    const shop = node('main', layout, '', 'vb-career-store');
    this.feature = node('section', shop, '', 'vb-career-feature');
    const catalogHeader = node('div', shop, '', 'vb-career-catalog-header');
    node('h3', catalogHeader, 'MAKE IT YOURS');
    this.filters = node('nav', catalogHeader, '', 'vb-career-filters');
    this.filters.setAttribute('aria-label', 'Cosmetic category');
    for (const [id, label] of [['all', 'ALL'], ['theme', 'HUD THEMES'], ['title', 'CALLSIGNS']]) {
      const filter = node('button', this.filters, label, 'vb-career-filter');
      filter.type = 'button'; filter.dataset.filter = id;
      filter.setAttribute('aria-pressed', String(id === this.filter));
      filter.addEventListener('click', () => { this.filter = id; this.renderCatalog(); });
    }
    this.grid = node('div', shop, '', 'vb-career-grid');
    this.status = node('p', shop, '', 'vb-career-status');
    this.status.setAttribute('role', 'status');
    this.status.setAttribute('aria-live', 'polite');
    this.journey = node('section', shop, '', 'vb-career-journey');
    const rules = node('details', shop, '', 'vb-career-rules');
    node('summary', rules, 'HOW TO EARN XP & CREDITS');
    node('p', rules, 'Human kill: 25 XP / 10 credits. Bot kill: 10 / 4. Active minute: 20 / 8. Objectives: 75 / 30. Completed match: 100 / 40, plus 50 / 20 for a win. Training does not award XP.');
    node('p', shop, 'HUD colors and callsigns only. Career credits are separate from match shop credits.', 'vb-career-note');
    this.badge = node('div', document.body, '', 'vb-career-badge');
    this.badge.id = 'career-badge';
    this.dialog.addEventListener('keydown', event => event.stopPropagation());
    this.dialog.addEventListener('close', () => {
      if (this.returnFocus?.isConnected && this.returnFocus.getClientRects().length) this.returnFocus.focus();
      else document.getElementById('career-open')?.focus();
    });
    this.onAccountChange = () => {
      // Clear the previous identity before any account-bound request completes.
      this.requestVersion = (this.requestVersion || 0) + 1;
      this.profile = null;
      this.grid.replaceChildren();
      this.rank.replaceChildren();
      this.feature.replaceChildren();
      this.journey.replaceChildren();
      this.record.replaceChildren();
      this.stats.textContent = 'Loading career...';
      this.wallet.textContent = '... CREDITS';
      this.titleName.textContent = '';
      this.progress.value = 0;
      this.xpRemaining.textContent = '';
      this.badge.textContent = '';
      document.documentElement.style.setProperty('--career-accent', '#ffb347');
      this.syncAccount();
      this.renderMenuPreview();
      this.request().catch(error => { this.status.textContent = error.message; });
    };
    window.addEventListener('vb-account-change', this.onAccountChange);
    this.onPagehide = event => { if (!event.persisted) this.dispose(); };
    window.addEventListener('pagehide', this.onPagehide);
    this.syncAccount();
  }

  syncAccount() {
    const user = this.accounts?.user;
    this.playerName.textContent = user?.username || 'GUEST PLAYER';
    this.accountDescription.textContent = user
      ? `Saved to ${user.username}. Log in on another device to continue this career.`
      : 'Guest career stays in this browser. Create an account to continue on other devices.';
    this.accountButton.textContent = user ? 'MANAGE ACCOUNT' : 'SAVE YOUR CAREER';
    this.accountButton.hidden = !this.accounts;
  }

  async request(item = null, equipOnly = false) {
    if (item && this.accounts) {
      const accountId = this.accounts.user?.id || null;
      await this.accounts.refresh();
      if ((this.accounts.user?.id || null) !== accountId)
        throw new Error('Your session changed. Choose the item again after checking your career.');
    }
    const version = this.requestVersion = (this.requestVersion || 0) + 1;
    const response = await fetch(item ? '/api/career/purchase' : '/api/career', {
      method: item ? 'POST' : 'GET', credentials: 'same-origin',
      ...(item ? { headers: { 'Content-Type': 'application/json', 'X-VB-Career': '1' },
        body: JSON.stringify({ item, equipOnly }) } : {}),
      signal: AbortSignal.timeout(5000),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Career unavailable');
    if (version !== this.requestVersion) return payload;
    this.profile = payload;
    this.render();
    return payload;
  }

  async start() {
    // Establish the HttpOnly career cookie before the gameplay socket connects.
    try { await this.request(); } catch (error) { this.status.textContent = error.message; }
    this.mountButton();
    this.observer = new MutationObserver(() => this.mountButton());
    const menu = document.getElementById('menu');
    if (menu) this.observer.observe(menu, { childList: true, subtree: true });
    this.timer = setInterval(() => {
      if (!document.hidden && !this.dialog.open && !this.accounts?.dialog.open) {
        Promise.resolve(this.accounts?.refresh()).then(() => this.request()).catch(() => {});
      }
    }, 15000);
  }

  async open(opener = document.activeElement) {
    this.returnFocus = opener;
    if (!this.dialog.open) this.dialog.showModal();
    this.status.textContent = 'Loading career...';
    try { await this.accounts?.refresh(); await this.request(); this.status.textContent = ''; }
    catch (error) { this.status.textContent = error.message; }
  }

  mountButton() {
    const navigation = document.querySelector('#menu .vb-main-nav');
    if (navigation && !document.getElementById('career-open')) {
      const button = node('button', navigation, 'CAREER & SHOP', 'vb-main-nav-button');
      button.id = 'career-open'; button.type = 'button';
      button.setAttribute('aria-haspopup', 'dialog');
      button.addEventListener('click', () => this.open(button));
    }
    const showcase = document.querySelector('#menu .vb-menu-showcase');
    if (showcase && !document.getElementById('career-menu-preview')) {
      this.menuPreview = node('button', showcase, '', 'vb-career-menu-preview');
      this.menuPreview.id = 'career-menu-preview'; this.menuPreview.type = 'button';
      this.menuPreview.setAttribute('aria-haspopup', 'dialog');
      this.menuPreview.addEventListener('click', () => this.open(this.menuPreview));
      this.renderMenuPreview();
    }
  }

  renderMenuPreview() {
    if (!this.menuPreview?.isConnected) return;
    this.menuPreview.replaceChildren();
    const profile = this.profile;
    if (!profile) { node('span', this.menuPreview, 'Loading your career...'); return; }
    const title = CAREER_CATALOG.find(item => item.id === profile.equipped.title);
    artwork(this.menuPreview, title);
    const copy = node('div', this.menuPreview, '', 'vb-career-menu-copy');
    node('span', copy, this.accounts?.user ? 'YOUR CAREER' : 'YOUR GUEST CAREER', 'vb-career-kicker');
    node('strong', copy, `LEVEL ${profile.level} / ${title?.name || 'Rookie'}`);
    const progress = node('progress', copy);
    progress.max = profile.nextLevel - profile.levelStart;
    progress.value = profile.xp - profile.levelStart;
    progress.setAttribute('aria-label', 'Progress to next career level');
    node('span', copy, `${format(profile.xp)} XP · ${format(profile.credits)} CREDITS`, 'vb-career-menu-meta');
    node('span', this.menuPreview, 'CAREER & SHOP  ›', 'vb-career-menu-link');
  }

  itemState(item) {
    const owned = this.profile.owned.includes(item.id);
    const equipped = this.profile.equipped[item.kind] === item.id;
    const locked = this.profile.level < item.level;
    return { owned, equipped, locked, label: equipped ? 'EQUIPPED' : owned ? 'EQUIP' : locked
      ? `LEVEL ${item.level} REQUIRED` : `${item.price} CREDITS`,
    disabled: this.busy || equipped || (!owned && (locked || this.profile.credits < item.price)) };
  }

  purchaseButton(parent, item, featured = false) {
    const state = this.itemState(item);
    const button = node('button', parent, state.label, 'vb-btn');
    button.type = 'button';
    if (featured) button.dataset.featuredItem = item.id;
    else button.dataset.item = item.id;
    button.disabled = state.disabled;
    button.addEventListener('click', async () => {
      if (this.busy) return;
      this.busy = true; this.render();
      try { await this.request(item.id, state.owned); this.status.textContent = `${item.name} equipped`; }
      catch (error) { this.status.textContent = error.message; }
      finally { this.busy = false; this.render(); }
    });
  }

  renderCatalog() {
    if (!this.profile) return;
    for (const filter of this.filters.children) filter.setAttribute('aria-pressed', String(filter.dataset.filter === this.filter));
    this.grid.replaceChildren();
    for (const item of CAREER_CATALOG.filter(item => this.filter === 'all' || item.kind === this.filter)) {
      const state = this.itemState(item);
      const card = node('article', this.grid, '', 'vb-career-item');
      card.dataset.cosmetic = item.id;
      card.dataset.state = state.equipped ? 'equipped' : state.owned ? 'owned' : state.locked ? 'locked' : 'available';
      card.style.setProperty('--item-color', item.color || '#ffbc43');
      const preview = artwork(card, item, 'vb-career-preview');
      node('span', preview, state.equipped ? 'EQUIPPED' : state.owned ? 'OWNED' : `LV ${item.level}`, 'vb-career-item-state');
      const body = node('div', card, '', 'vb-career-item-body');
      node('small', body, item.kind === 'theme' ? 'HUD THEME' : 'CALLSIGN');
      node('h3', body, item.name);
      node('p', body, item.detail);
      this.purchaseButton(body, item);
    }
  }

  render() {
    const profile = this.profile;
    if (!profile) return;
    this.syncAccount();
    this.stats.textContent = `LEVEL ${profile.level} · ${profile.xp} XP · ${profile.credits} CREDITS`;
    this.wallet.textContent = `${format(profile.credits)} CREDITS`;
    this.progress.max = profile.nextLevel - profile.levelStart;
    this.progress.value = profile.xp - profile.levelStart;
    this.progress.title = `${profile.nextLevel - profile.xp} XP to level ${profile.level + 1}`;
    this.xpRemaining.textContent = `${format(profile.nextLevel - profile.xp)} XP TO LEVEL ${profile.level + 1}`;
    const theme = CAREER_CATALOG.find(item => item.id === profile.equipped.theme);
    const title = CAREER_CATALOG.find(item => item.id === profile.equipped.title);
    document.documentElement.style.setProperty('--career-accent', theme?.color || '#ffb347');
    this.badge.textContent = `LV ${profile.level} · ${title?.name || 'Rookie'}`;
    this.titleName.textContent = `LEVEL ${profile.level} / ${title?.name || 'Rookie'}`;
    this.rank.replaceChildren();
    artwork(this.rank, title);
    this.record.replaceChildren();
    for (const [label, value] of [['KILLS', profile.kills], ['MATCHES', profile.matches]]) {
      const metric = node('div', this.record);
      node('strong', metric, format(value)); node('span', metric, label);
    }
    this.feature.replaceChildren();
    const featured = CAREER_CATALOG.find(item => item.id === 'arctic');
    const featureBody = node('div', this.feature, '', 'vb-career-feature-body');
    node('span', featureBody, 'FEATURED HUD THEME', 'vb-career-kicker');
    node('h3', featureBody, 'ARCTIC');
    node('p', featureBody, 'Ice blue. Clear focus.');
    node('small', featureBody, `${featured.price} CREDITS · LEVEL ${featured.level}`);
    this.purchaseButton(featureBody, featured, true);
    this.renderCatalog();
    this.journey.replaceChildren();
    node('h3', this.journey, 'YOUR NEXT LEVELS');
    const milestones = node('div', this.journey, '', 'vb-career-milestones');
    for (let level = Math.max(1, profile.level - 1); level <= Math.max(1, profile.level - 1) + 3; level++) {
      const milestone = node('div', milestones, '', 'vb-career-milestone');
      milestone.dataset.state = level < profile.level ? 'complete' : level === profile.level ? 'current' : 'next';
      node('strong', milestone, `LEVEL ${level}`);
      node('span', milestone, level === profile.level ? 'YOUR LEVEL' : `${format((level - 1) ** 2 * 100)} XP`);
    }
    this.renderMenuPreview();
  }

  dispose() {
    clearInterval(this.timer);
    this.observer?.disconnect();
    window.removeEventListener('pagehide', this.onPagehide);
    window.removeEventListener('vb-account-change', this.onAccountChange);
    this.dialog.remove(); this.badge.remove(); this.menuPreview?.remove();
    document.getElementById('career-open')?.remove();
  }
}
