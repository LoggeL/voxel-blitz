import { CAREER_CATALOG } from '../../../shared/career.js';

const node = (tag, parent, text, className = '') => {
  const element = document.createElement(tag);
  element.className = className;
  if (text) element.textContent = text;
  parent.append(element);
  return element;
};

export class CareerShop {
  constructor({ accounts = null } = {}) {
    this.accounts = accounts;
    this.profile = null;
    this.busy = false;
    this.dialog = node('dialog', document.body, '', 'vb-career');
    this.dialog.id = 'career-shop';
    this.dialog.setAttribute('aria-labelledby', 'career-title');
    const header = node('header', this.dialog);
    node('span', header, 'YOUR CAREER', 'vb-career-kicker');
    node('h2', header, 'Play. Progress. Make it yours.').id = 'career-title';
    const close = node('button', header, 'BACK', 'vb-btn');
    close.id = 'career-close'; close.type = 'button';
    close.addEventListener('click', () => this.dialog.close());
    this.stats = node('div', this.dialog, '', 'vb-career-stats');
    this.progress = node('progress', this.dialog);
    this.progress.setAttribute('aria-label', 'Progress to next career level');
    const accountRow = node('div', this.dialog, '', 'vb-career-account');
    this.accountDescription = node('p', accountRow);
    this.accountButton = node('button', accountRow, 'SAVE YOUR CAREER', 'vb-btn');
    this.accountButton.id = 'career-account';
    this.accountButton.type = 'button';
    this.accountButton.addEventListener('click', () => this.accounts?.open(this.accounts.user ? 'account' : 'register'));
    node('p', this.dialog, 'Earn XP and career credits through kills, objectives and active play. Completed matches add a bonus. Training does not award XP.');
    node('p', this.dialog, 'Human kill: 25 XP / 10 credits. Bot kill: 10 / 4. Active minute: 20 / 8. Objectives: 75 / 30. Match: 100 / 40, plus 50 / 20 for a win.', 'vb-career-rules');
    this.grid = node('div', this.dialog, '', 'vb-career-grid');
    this.status = node('p', this.dialog, '', 'vb-career-status');
    this.status.setAttribute('role', 'status');
    node('p', this.dialog, 'Cosmetics only. Career credits are separate from match shop credits.', 'vb-career-note');
    this.badge = node('div', document.body, '', 'vb-career-badge');
    this.badge.id = 'career-badge';
    this.dialog.addEventListener('close', () => document.getElementById('career-open')?.focus());
    this.onAccountChange = () => {
      // Hide the previous account's balance immediately during an identity switch.
      this.requestVersion = (this.requestVersion || 0) + 1;
      this.profile = null;
      this.grid.replaceChildren();
      this.stats.textContent = 'Loading career...';
      this.badge.textContent = '';
      document.documentElement.style.setProperty('--career-accent', '#ffb347');
      this.syncAccount();
      this.request().catch(error => { this.status.textContent = error.message; });
    };
    window.addEventListener('vb-account-change', this.onAccountChange);
    this.onPagehide = event => { if (!event.persisted) this.dispose(); };
    window.addEventListener('pagehide', this.onPagehide);
    this.syncAccount();
  }

  syncAccount() {
    const user = this.accounts?.user;
    this.accountDescription.textContent = user
      ? `Saved to ${user.username}. Log in on another device to continue this career.`
      : 'Guest career stays in this browser. Register to save it to an account and continue on other devices.';
    this.accountButton.textContent = user ? 'ACCOUNT' : 'SAVE YOUR CAREER';
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
    // A poll started before a purchase must not repaint older ownership or XP.
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
    this.observer.observe(document.getElementById('menu'), { childList: true, subtree: true });
    this.timer = setInterval(() => {
      if (!document.hidden && !this.dialog.open && !this.accounts?.dialog.open) {
        Promise.resolve(this.accounts?.refresh()).then(() => this.request()).catch(() => {});
      }
    }, 15000);
  }

  mountButton() {
    const footer = document.querySelector('#menu .vb-menu-footer');
    if (!footer || document.getElementById('career-open')) return;
    const button = node('button', footer, 'CAREER & SHOP', 'vb-btn');
    button.id = 'career-open'; button.type = 'button';
    button.setAttribute('aria-haspopup', 'dialog');
    button.addEventListener('click', async () => {
      this.dialog.showModal();
      this.status.textContent = 'Loading career...';
      try { await this.accounts?.refresh(); await this.request(); this.status.textContent = ''; }
      catch (error) { this.status.textContent = error.message; }
    });
  }

  render() {
    const profile = this.profile;
    if (!profile) return;
    this.syncAccount();
    this.stats.textContent = `LEVEL ${profile.level} · ${profile.xp} XP · ${profile.credits} CREDITS`;
    this.progress.max = profile.nextLevel - profile.levelStart;
    this.progress.value = profile.xp - profile.levelStart;
    this.progress.title = `${profile.nextLevel - profile.xp} XP to level ${profile.level + 1}`;
    const theme = CAREER_CATALOG.find(item => item.id === profile.equipped.theme);
    const title = CAREER_CATALOG.find(item => item.id === profile.equipped.title);
    document.documentElement.style.setProperty('--career-accent', theme?.color || '#ffb347');
    this.badge.textContent = `LV ${profile.level} · ${title?.name || 'Rookie'}`;
    this.grid.replaceChildren();
    for (const item of CAREER_CATALOG) {
      const owned = profile.owned.includes(item.id);
      const equipped = profile.equipped[item.kind] === item.id;
      const locked = profile.level < item.level;
      const card = node('article', this.grid, '', 'vb-career-item');
      const preview = node('div', card, item.kind === 'theme' ? '+' : item.name, 'vb-career-preview');
      preview.style.color = item.color || 'var(--career-accent)';
      node('h3', card, item.name);
      node('p', card, item.detail);
      node('small', card, `${item.kind.toUpperCase()} · LEVEL ${item.level}`);
      const button = node('button', card, equipped ? 'EQUIPPED' : owned ? 'EQUIP' : locked
        ? `LEVEL ${item.level} REQUIRED` : `${item.price} CREDITS`, 'vb-btn');
      button.type = 'button'; button.dataset.item = item.id;
      button.disabled = this.busy || equipped || (!owned && (locked || profile.credits < item.price));
      button.addEventListener('click', async () => {
        if (this.busy) return;
        this.busy = true; this.render();
        try { await this.request(item.id, owned); this.status.textContent = `${item.name} equipped`; }
        catch (error) { this.status.textContent = error.message; }
        finally { this.busy = false; this.render(); }
      });
    }
  }

  dispose() {
    clearInterval(this.timer);
    this.observer?.disconnect();
    window.removeEventListener('pagehide', this.onPagehide);
    window.removeEventListener('vb-account-change', this.onAccountChange);
    this.dialog.remove(); this.badge.remove();
  }
}
