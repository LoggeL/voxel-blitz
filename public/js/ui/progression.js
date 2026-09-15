import { CAREER_CATALOG, PROGRESSION_BRANCHES, PROGRESSION_TREE, careerItemState, treeNode } from '../../../shared/career.js';
import { WEAPONS } from '../../../shared/combatmath.js';
import { mountMusicControl } from './music-control.js';
import { cosmeticArtwork as artwork, CosmeticAudition, COSMETIC_AUDIO, cosmeticVolume } from './cosmetic-preview.js';

const node = (tag, parent, text, className = '') => {
  const element = document.createElement(tag);
  element.className = className;
  if (text) element.textContent = text;
  parent.append(element);
  return element;
};

const format = value => Number(value || 0).toLocaleString('en-US');
const KIND_LABELS = { weaponSkin: 'WEAPON SKIN', characterSkin: 'CHARACTER SKIN', signature: 'DEATH SIGNATURE', sound: 'SOUND KIT',
  theme: 'HUD THEME', title: 'CALLSIGN', attachment: 'ATTACHMENT', reticle: 'RETICLE', nameplate: 'NAMEPLATE' };
const EQUIPPABLE = ['weaponSkin', 'characterSkin', 'signature', 'sound', 'theme', 'title', 'reticle', 'nameplate'];
const FILTERS = [['all', 'ALL'], ...PROGRESSION_BRANCHES.map(branch => [branch.id, branch.name])];

/** The shortfall that keeps a node closed, in the player's words. */
export function unlockSummary(state, item) {
  if (state.blockedByParent) return `UNLOCK ${(treeNode(item.parent)?.name || 'THE PREVIOUS NODE').toUpperCase()} FIRST`;
  const pending = state.requirements.find(requirement => !requirement.complete);
  if (!pending) return 'UNLOCKS AUTOMATICALLY';
  return pending.label === 'Career level' ? `LEVEL ${item.level} REQUIRED` : `${format(pending.target)} ${pending.label.toUpperCase()}`;
}

export function progressionActionState(profile, item, busy = false) {
  const state = careerItemState(profile, item);
  const equippable = EQUIPPABLE.includes(item.kind);
  return { ...state, equippable,
    label: state.equipped ? 'EQUIPPED'
      : !state.owned || state.locked ? unlockSummary(state, item)
      : equippable ? 'EQUIP' : 'OPEN IN ARMORY',
    disabled: busy || state.equipped || !state.owned || state.locked || !equippable };
}

function announceProfile(profile) {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('vb-career-change', { detail: profile }));
}

export class ProgressionTree {
  constructor({ accounts = null } = {}) {
    this.accounts = accounts;
    this.profile = null;
    this.busy = false;
    this.filter = 'all';
    this.featuredId = 'rifle-overdrive';
    this.masteryWeapon = 'rifle';
    this.audition = new CosmeticAudition(active => this.syncAudition(active));
    this.dialog = node('dialog', document.body, '', 'vb-career');
    this.dialog.id = 'career-shop';
    this.dialog.setAttribute('aria-labelledby', 'career-title');
    const header = node('header', this.dialog, '', 'vb-career-header');
    node('span', header, 'VOXEL BLITZ', 'vb-career-brand');
    node('h2', header, 'CAREER & PROGRESSION').id = 'career-title';
    mountMusicControl(header);
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
    const store = node('main', layout, '', 'vb-career-store');
    this.feature = node('section', store, '', 'vb-career-feature');
    const treeHeader = node('div', store, '', 'vb-career-catalog-header');
    node('h3', treeHeader, 'UNLOCK TREE');
    this.filters = node('nav', treeHeader, '', 'vb-career-filters');
    this.filters.setAttribute('aria-label', 'Progression branch');
    for (const [id, label] of FILTERS) {
      const filter = node('button', this.filters, label, 'vb-career-filter');
      filter.type = 'button'; filter.dataset.filter = id;
      filter.setAttribute('aria-pressed', String(id === this.filter));
      filter.addEventListener('click', () => {
        this.audition.stop(); this.filter = id;
        this.renderTree();
      });
    }
    this.collectionSummary = node('p', store, '', 'vb-career-collection-summary');
    this.jump = node('button', store, 'JUMP TO NEXT UNLOCK', 'vb-btn vb-tree-jump');
    this.jump.type = 'button';
    this.jump.addEventListener('click', () => {
      const next = this.tree.querySelector('[aria-current="step"]');
      if (next) { next.scrollIntoView({ block: 'center', behavior: 'instant' }); next.focus({ preventScroll: true }); }
    });
    this.loadout = node('div', store, '', 'vb-career-loadout');
    this.tree = node('div', store, '', 'vb-tree');
    this.tree.id = 'progression-tree';
    this.status = node('p', store, '', 'vb-career-status');
    this.status.setAttribute('role', 'status');
    this.status.setAttribute('aria-live', 'polite');
    this.mastery = node('section', store, '', 'vb-career-mastery');
    this.mountAudioSettings(store);
    const rules = node('details', store, '', 'vb-career-rules');
    node('summary', rules, 'HOW TO EARN XP');
    node('p', rules, 'Human kill: 25 XP. Bot kill: 10 XP. Active minute: 20 XP. Objectives: 75 XP. Completed match: 100 XP, plus 50 XP for a win. Training does not award XP.');
    node('p', rules, 'Every reward unlocks automatically once its requirements and the node before it are complete. Nothing is bought. Weapon mastery counts human opponents in eligible matches, including Gun Game; training and bot kills do not count.');
    node('p', store, 'Cosmetics keep weapon damage, hitboxes and team identification unchanged. All weapons remain available in Gun Game.', 'vb-career-note');
    this.badge = node('div', document.body, '', 'vb-career-badge');
    this.badge.id = 'career-badge';
    this.dialog.addEventListener('keydown', event => event.stopPropagation());
    this.dialog.addEventListener('close', () => {
      this.audition.stop();
      this.disposeModelPreview();
      if (this.returnFocus?.isConnected && this.returnFocus.getClientRects().length) this.returnFocus.focus();
      else document.getElementById('career-open')?.focus();
    });
    this.onAccountChange = () => {
      // Clear the previous identity before any account-bound request completes.
      this.requestVersion = (this.requestVersion || 0) + 1;
      this.profile = null;
      this.audition.stop();
      this.disposeModelPreview();
      announceProfile(null);
      this.tree.replaceChildren();
      this.rank.replaceChildren();
      this.feature.replaceChildren();
      this.record.replaceChildren();
      this.mastery.replaceChildren();
      this.loadout.replaceChildren();
      this.collectionSummary.textContent = '';
      this.stats.textContent = 'Loading career...';
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

  async request(item = null, equipOnly = false, reset = {}) {
    if (item && this.accounts) {
      const accountId = this.accounts.user?.id || null;
      await this.accounts.refresh();
      if ((this.accounts.user?.id || null) !== accountId)
        throw new Error('Your session changed. Choose the item again after checking your career.');
    }
    const version = this.requestVersion = (this.requestVersion || 0) + 1;
    const response = await fetch(item ? '/api/career/equip' : '/api/career', {
      method: item ? 'POST' : 'GET', credentials: 'same-origin',
      ...(item ? { headers: { 'Content-Type': 'application/json', 'X-VB-Career': '1' },
        body: JSON.stringify({ item, equipOnly, ...reset }) } : {}),
      signal: AbortSignal.timeout(5000),
    });
    const payload = await response.json();
    if (version !== this.requestVersion || this.disposed) return null;
    if (!response.ok) throw new Error(payload.error || 'Career unavailable');
    this.profile = payload;
    this.render();
    announceProfile(payload);
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
      const button = node('button', navigation, 'CAREER', 'vb-main-nav-button');
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

  /** The node the player is closest to opening, across every branch. */
  nextUnlock() {
    let best = null;
    for (const item of PROGRESSION_TREE) {
      const state = this.itemState(item);
      if (state.owned || state.blockedByParent) continue;
      if (!best || state.progress > best.progress) best = { item, progress: state.progress, state };
    }
    return best;
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
    const next = this.nextUnlock();
    node('span', copy, next ? `NEXT: ${next.item.name.toUpperCase()} · ${unlockSummary(next.state, next.item)}`
      : `ALL ${PROGRESSION_TREE.length} UNLOCKS COMPLETE`, 'vb-career-menu-meta');
    node('span', this.menuPreview, 'CAREER & PROGRESSION  ›', 'vb-career-menu-link');
  }

  itemState(item) {
    return progressionActionState(this.profile, item, this.busy);
  }

  actionButton(parent, item, featured = false) {
    const state = this.itemState(item);
    const button = node('button', parent, state.label, 'vb-btn');
    button.type = 'button';
    if (featured) button.dataset.featuredItem = item.id;
    else button.dataset.item = item.id;
    button.disabled = state.disabled;
    if (!state.equippable && state.owned && !state.locked) {
      button.disabled = false;
      button.addEventListener('click', () => { this.dialog.close(); document.getElementById('workshop-open')?.click(); });
      return button;
    }
    button.addEventListener('click', async () => {
      if (this.busy) return;
      this.busy = true; this.render();
      try {
        const accepted = await this.request(item.id, true);
        if (accepted) this.status.textContent = `${item.name} equipped`;
      }
      catch (error) { this.status.textContent = error.message; }
      finally { this.busy = false; this.render(); }
    });
    return button;
  }

  matchesFilter(item) {
    return this.filter === 'all' || item.branch === this.filter;
  }

  requirements(parent, item, state = this.itemState(item)) {
    const requirements = node('div', parent, '', 'vb-career-requirements');
    for (const requirement of state.requirements) {
      const row = node('div', requirements, '', 'vb-career-requirement');
      row.dataset.complete = String(requirement.complete);
      const label = node('div', row);
      node('span', label, requirement.label);
      node('strong', label, `${format(requirement.current)} / ${format(requirement.target)}`);
      const progress = node('progress', row);
      progress.max = requirement.target;
      progress.value = Math.min(requirement.current, requirement.target);
      progress.setAttribute('aria-label', requirement.label);
    }
    if (!state.owned) node('span', requirements, state.blockedByParent
      ? `Unlock ${treeNode(item.parent)?.name || 'the previous node'} first.`
      : 'Unlocks automatically. Nothing to buy.', 'vb-career-unlock-note');
    return requirements;
  }

  soundButtons(parent, item) {
    if (item.kind !== 'sound') return;
    const row = node('div', parent, '', 'vb-career-auditions');
    for (const [cue, label] of [['kill', 'KILL'], ['death', 'DEATH'], ['victory', 'VICTORY']]) {
      const button = node('button', row, `▶ ${label}`, 'vb-btn vb-career-audition');
      button.type = 'button';
      button.dataset.audition = `${item.id}:${cue}`;
      button.dataset.cue = cue;
      button.setAttribute('aria-label', `Preview ${item.name} ${label.toLowerCase()} sound`);
      button.setAttribute('aria-pressed', 'false');
      button.addEventListener('click', () => {
        this.audition.play(item, cue).catch(error => { this.status.textContent = error.message; });
      });
    }
    this.syncAudition(this.audition.active);
  }

  syncAudition(active) {
    if (!this.dialog) return;
    for (const button of this.dialog.querySelectorAll('[data-audition]')) {
      const playing = button.dataset.audition === active;
      button.setAttribute('aria-pressed', String(playing));
      button.textContent = `${playing ? '■' : '▶'} ${button.dataset.cue.toUpperCase()}`;
    }
  }

  mountAudioSettings(parent) {
    const details = node('details', parent, '', 'vb-career-audio-settings');
    node('summary', details, 'COSMETIC AUDIO SETTINGS');
    node('p', details, 'Set each cue separately. Zero mutes that cue, including previews.');
    for (const [cue, setting] of Object.entries(COSMETIC_AUDIO)) {
      const row = node('div', details, '', 'vb-career-audio-setting');
      const label = node('label', row, setting.label);
      label.htmlFor = `career-volume-${cue}`;
      const slider = node('input', row);
      slider.id = label.htmlFor;
      slider.type = 'range'; slider.min = '0'; slider.max = '100'; slider.step = '1';
      slider.value = String(Math.round(cosmeticVolume(cue) * 100));
      const output = node('output', row);
      output.htmlFor = slider.id;
      const mute = node('button', row, 'MUTE', 'vb-btn');
      mute.type = 'button';
      mute.setAttribute('aria-label', `Mute ${setting.label.toLowerCase()}`);
      let lastVolume = Number(slider.value) || setting.defaultVolume * 100;
      const update = (save = false) => {
        const value = Number(slider.value);
        if (value > 0) lastVolume = value;
        output.value = value === 0 ? 'MUTED' : `${value}%`;
        slider.setAttribute('aria-valuetext', value === 0 ? 'Muted' : `${value} percent`);
        mute.textContent = value === 0 ? 'UNMUTE' : 'MUTE';
        mute.setAttribute('aria-pressed', String(value === 0));
        if (save) {
          try { localStorage.setItem(`vb-cosmetic-${cue}-volume`, String(value / 100)); } catch {}
          window.dispatchEvent(new CustomEvent('vb-cosmetic-volume', { detail: { cue, volume: value / 100 } }));
          if (this.audition.active?.endsWith(`:${cue}`)) this.audition.audio.volume = value / 100;
        }
      };
      slider.addEventListener('input', () => update(true));
      mute.addEventListener('click', () => { slider.value = Number(slider.value) === 0 ? String(lastVolume) : '0'; update(true); });
      update();
    }
  }

  renderLoadout(items) {
    this.loadout.replaceChildren();
    const slots = new Map();
    for (const item of items) {
      if (!['weaponSkin', 'characterSkin', 'signature', 'sound', 'reticle', 'nameplate'].includes(item.kind)) continue;
      const key = item.kind === 'weaponSkin' ? `weaponSkin:${item.weapon}` : item.kind;
      slots.set(key, { slot: item.kind, ...(item.weapon ? { weapon: item.weapon } : {}) });
    }
    for (const [key, reset] of slots) {
      const equipped = reset.weapon ? this.profile.equipped.weaponSkins?.[reset.weapon] : this.profile.equipped[reset.slot];
      const label = reset.weapon ? WEAPONS[reset.weapon]?.name || reset.weapon : KIND_LABELS[reset.slot];
      const button = node('button', this.loadout, `${label}: STANDARD`, 'vb-career-reset');
      button.type = 'button'; button.dataset.reset = key;
      button.disabled = this.busy || !equipped || equipped === 'standard';
      button.setAttribute('aria-label', `Restore standard ${label.toLowerCase()}`);
      button.addEventListener('click', async () => {
        if (this.busy) return;
        this.busy = true; this.render();
        try {
          const accepted = await this.request('standard', true, reset);
          if (accepted) this.status.textContent = `Standard ${label.toLowerCase()} equipped`;
        } catch (error) { this.status.textContent = error.message; }
        finally { this.busy = false; this.render(); }
      });
    }
    this.loadout.hidden = slots.size === 0;
  }

  renderTree() {
    if (!this.profile) return;
    for (const filter of this.filters.children) filter.setAttribute('aria-pressed', String(filter.dataset.filter === this.filter));
    this.tree.replaceChildren();
    const visible = PROGRESSION_TREE.filter(item => this.matchesFilter(item));
    const owned = visible.filter(item => this.itemState(item).owned).length;
    this.collectionSummary.textContent = `${owned} / ${visible.length} UNLOCKED · Everything opens through play`;
    this.renderLoadout(visible);
    const next = this.nextUnlock();
    this.jump.hidden = !next;
    for (const branch of PROGRESSION_BRANCHES) {
      if (this.filter !== 'all' && this.filter !== branch.id) continue;
      const items = PROGRESSION_TREE.filter(item => item.branch === branch.id);
      const section = node('section', this.tree, '', 'vb-tree-branch');
      section.dataset.branch = branch.id;
      const heading = node('h3', section, branch.name);
      heading.id = `tree-branch-${branch.id}`;
      section.setAttribute('aria-labelledby', heading.id);
      node('p', section, `${items.filter(item => this.itemState(item).owned).length} of ${items.length} unlocked · ${branch.detail}`, 'vb-tree-branch-progress');
      const chain = node('ol', section, '', 'vb-tree-chain');
      for (const item of items) {
        const state = this.itemState(item);
        const row = node('li', chain, '', 'vb-tree-item');
        row.dataset.state = state.owned && !state.locked ? 'unlocked' : state.blockedByParent ? 'locked' : 'next';
        const button = node('button', row, '', 'vb-tree-node');
        button.type = 'button';
        button.dataset.node = item.id;
        button.dataset.cosmetic = item.id;
        button.style.setProperty('--item-color', item.color || '#ffbc43');
        if (next?.item.id === item.id) button.setAttribute('aria-current', 'step');
        const marker = node('span', button, String(item.level), 'vb-tree-marker');
        marker.setAttribute('aria-hidden', 'true');
        node('span', button, `${{ unlocked: 'Unlocked.', next: 'Next up.', locked: 'Locked.' }[row.dataset.state]} `, 'vb-visually-hidden');
        node('strong', button, item.name);
        node('small', button, `${KIND_LABELS[item.kind]}${item.weapon ? ` / ${(WEAPONS[item.weapon]?.name || item.weapon).toUpperCase()}` : ''} · LEVEL ${item.level}`);
        node('span', button, row.dataset.state.toUpperCase(), 'vb-tree-chip');
        const body = node('div', row, '', 'vb-tree-body');
        body.id = `req-${item.id}`;
        button.setAttribute('aria-describedby', body.id);
        node('p', body, item.detail);
        // Full progress rows only where they are actionable; a level-75 bar on an
        // unreachable node is noise that costs a column of height.
        if (!state.owned || state.locked) this.requirements(body, item, state);
        if (state.owned && !state.locked) this.actionButton(body, item);
        else node('p', body, unlockSummary(state, item), 'vb-tree-unlock-note');
        if (item.masteryKills) {
          const link = node('button', body, `VIEW ${(WEAPONS[item.weapon]?.name || item.weapon).toUpperCase()} MASTERY`, 'vb-btn vb-tree-mastery-link');
          link.type = 'button';
          link.addEventListener('click', () => {
            this.masteryWeapon = item.weapon; this.renderMastery();
            this.mastery.scrollIntoView({ block: 'center', behavior: 'instant' });
            this.mastery.querySelector('select')?.focus();
          });
        }
        button.addEventListener('click', () => {
          this.audition.stop(); this.featuredId = item.id; this.renderFeature();
          this.feature.scrollIntoView({ block: 'center', behavior: 'instant' });
          this.feature.focus({ preventScroll: true });
        });
      }
    }
  }

  renderFeature() {
    const version = this.previewVersion = (this.previewVersion || 0) + 1;
    const item = CAREER_CATALOG.find(entry => entry.id === this.featuredId) || CAREER_CATALOG[0];
    const state = this.itemState(item);
    this.feature.replaceChildren();
    this.feature.tabIndex = -1;
    this.feature.setAttribute('aria-label', `${item.name} preview`);
    this.feature.dataset.kind = item.kind;
    this.feature.dataset.rarity = item.rarity || 'common';
    this.feature.style.setProperty('--item-color', item.color || '#ffc568');
    if (this.dialog.open && ['weaponSkin', 'characterSkin'].includes(item.kind)) {
      const host = node('div', this.feature, '', 'vb-career-model-host');
      if (this.modelPreview) host.append(this.modelPreview.element);
      else artwork(host, item, 'vb-career-feature-art');
      this.renderModelPreview(item, host, version);
    } else {
      this.disposeModelPreview();
      artwork(this.feature, item, 'vb-career-feature-art');
    }
    const body = node('div', this.feature, '', 'vb-career-feature-body');
    node('span', body, item.collection ? `${item.collection.toUpperCase()} COLLECTION / ${KIND_LABELS[item.kind]}` : KIND_LABELS[item.kind], 'vb-career-kicker');
    node('h3', body, item.name.toUpperCase());
    node('p', body, item.detail);
    node('small', body, `${(item.rarity || 'standard').toUpperCase()} · ${state.owned && !state.locked ? 'UNLOCKED' : unlockSummary(state, item)}`);
    this.requirements(body, item, state);
    this.soundButtons(body, item);
    if (['weaponSkin', 'characterSkin'].includes(item.kind)) {
      const inspect = node('button', body, 'INSPECT IN 3D', 'vb-career-inspect');
      inspect.type = 'button'; inspect.dataset.inspect = item.id;
      inspect.setAttribute('aria-label', `Inspect ${item.name}`);
      inspect.addEventListener('click', () => { this.featuredId = item.id; this.renderFeature(); });
    }
    this.actionButton(body, item, true);
  }

  async renderModelPreview(item, host, version) {
    try {
      const { ModelViewer } = await import('./model-viewer.js');
      if (version !== this.previewVersion || this.disposed || !this.dialog.open) return;
      this.modelPreview ||= new ModelViewer(host);
      host.replaceChildren(this.modelPreview.element);
      const loadout = item.weapon ? { weaponSkins: { [item.weapon]: item.id } } : { characterSkin: item.id };
      this.modelPreview.show({ weapon: item.weapon || null, loadout,
        attachments: this.profile?.equipped?.weaponAttachments?.[item.weapon], mastery: this.profile?.mastery, label: item.name });
    } catch {
      if (version !== this.previewVersion) return;
      this.disposeModelPreview();
      host.replaceChildren();
      artwork(host, item, 'vb-career-feature-art');
      node('p', host, '3D preview unavailable on this device. Showing artwork.', 'vb-career-model-fallback');
    }
  }

  disposeModelPreview() {
    this.previewVersion = (this.previewVersion || 0) + 1;
    this.modelPreview?.dispose();
    this.modelPreview = null;
  }

  renderMastery() {
    this.mastery.replaceChildren();
    const heading = node('div', this.mastery, '', 'vb-career-section-heading');
    node('h3', heading, 'WEAPON MASTERY');
    const select = node('select', heading);
    select.id = 'career-mastery-weapon';
    select.setAttribute('aria-label', 'Weapon mastery');
    for (const [id, weapon] of Object.entries(WEAPONS)) {
      const option = node('option', select, weapon.name || id);
      option.value = id;
    }
    select.value = this.masteryWeapon;
    select.addEventListener('change', () => { this.masteryWeapon = select.value; this.renderMastery(); this.mastery.querySelector('select').focus(); });
    const record = this.profile.mastery?.[this.masteryWeapon] || {};
    const kills = record.kills || 0;
    node('p', this.mastery, `${format(kills)} HUMAN KILLS · ${format(record.headshots)} HEADSHOT KILLS`, 'vb-career-mastery-record');
    const track = node('div', this.mastery, '', 'vb-career-mastery-track');
    for (const [index, target] of [250, 1000, 5000, 10000].entries()) {
      const tier = node('div', track, '', 'vb-career-mastery-tier');
      tier.dataset.complete = String(kills >= target);
      node('span', tier, ['INITIATED', 'SPECIALIST', 'ELITE', 'MASTER'][index]);
      node('strong', tier, format(target));
      const progress = node('progress', tier);
      progress.max = target; progress.value = Math.min(kills, target);
      progress.setAttribute('aria-label', `${format(target)} human kills`);
    }
    const rewards = PROGRESSION_TREE.filter(item => item.weapon === this.masteryWeapon && item.masteryKills);
    node('p', this.mastery, rewards.length
      ? `Tree reward: ${rewards.map(item => `${item.name} (level ${item.level} + ${format(item.masteryKills)} kills)`).join(', ')}.`
      : 'Mastery is tracked for this weapon. No tree reward is assigned to it yet.', 'vb-career-note');
    node('p', this.mastery, 'Gun Game counts. Bot kills and training do not contribute. Mastery tiers track achievement; only tree nodes award cosmetics.', 'vb-career-note');
  }

  render() {
    const profile = this.profile;
    if (!profile) return;
    this.syncAccount();
    this.stats.textContent = `LEVEL ${profile.level} · ${format(profile.xp)} XP`;
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
    for (const [label, value] of [['PVP KILLS', profile.pvpKills], ['WINS', profile.wins], ['ALL KILLS', profile.kills], ['MATCHES', profile.matches]]) {
      const metric = node('div', this.record);
      node('strong', metric, format(value)); node('span', metric, label);
    }
    this.renderFeature();
    this.renderTree();
    this.renderMastery();
    this.renderMenuPreview();
  }

  dispose() {
    this.disposed = true;
    this.disposeModelPreview();
    this.requestVersion = (this.requestVersion || 0) + 1;
    this.audition.stop();
    clearInterval(this.timer);
    this.observer?.disconnect();
    window.removeEventListener('pagehide', this.onPagehide);
    window.removeEventListener('vb-account-change', this.onAccountChange);
    this.dialog.remove(); this.badge.remove(); this.menuPreview?.remove();
    document.getElementById('career-open')?.remove();
  }
}
