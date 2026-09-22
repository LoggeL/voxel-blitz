// The ARMORY: one dialog (#career-shop) for everything a player earns and wears.
// ProgressionTree is the single profile store; network calls live in career-store.js.
import { CAREER_CATALOG, careerItemState, nextGoals, serviceStars, treeNode } from '../../../shared/career.js';
import { applyLocalPresentation, applyTheme, resetLocalPresentation } from '../cosmetics/local-presentation.js';
import { mountMusicControl } from './music-control.js';
import { careerRequest, careerSaveAttachments, announceCareer } from './career-store.js';
import { TAB_HOLDS, equippable, format, slotOf, weaponName } from './armory/armory-model.js';
import { Inspector, art, bar, button, node, setBar, unlockSummary } from './armory/inspector.js';
import { LoadoutPanel } from './armory/loadout-panel.js';
import { ProgressPanel } from './armory/progress-panel.js';
import { MasteryPanel } from './armory/mastery-panel.js';
import { SeenStore } from './armory/seen-store.js';
import { rovingKeys, rovingSync } from './armory/focus-nav.js';

export { unlockSummary };

const TABS = [['loadout', 'LOADOUT'], ['weapons', 'WEAPONS'], ['progress', 'PROGRESS'], ['mastery', 'MASTERY']];
const TAB_IDS = TABS.map(([id]) => id);

export function progressionActionState(profile, item, busy = false) {
  const state = careerItemState(profile, item);
  const canEquip = equippable(item);
  const open = state.owned && !state.locked;
  return { ...state, equippable: canEquip,
    label: state.equipped ? 'EQUIPPED' : !open ? unlockSummary(state, item) : canEquip ? 'EQUIP' : 'FIT ON WEAPON',
    disabled: busy || state.equipped || !open || !canEquip };
}

/** Speaker glyph; CSS swaps the waves for a slash while music is muted. */
function speaker(parent) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'vb-armory-speaker');
  for (const [d, className] of [['M2 6h3l4-3v10l-4-3H2Z', ''], ['M11 5.5a3.5 3.5 0 0 1 0 5M12.5 3.5a6 6 0 0 1 0 9', 'vb-speaker-waves'], ['M11 5.5l4 5M15 5.5l-4 5', 'vb-speaker-mute']]) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    if (className) path.setAttribute('class', className);
    svg.append(path);
  }
  parent.append(svg);
}

const loadBench = () => import('./armory/weapon-bench.js').then(module => module.WeaponBench);

export class ProgressionTree {
  constructor({ accounts = null, loadViewer, loadWeaponBench = loadBench } = {}) {
    this.accounts = accounts;
    this.profile = null;
    this.busy = false;
    this.tab = 'loadout';
    this.loadWeaponBench = loadWeaponBench;
    this.dialog = node('dialog', document.body, '', 'vb-career vb-armory');
    this.dialog.id = 'career-shop';
    this.dialog.setAttribute('aria-labelledby', 'career-title');
    this.dialog.dataset.tab = this.tab;
    this.buildHeader();
    this.buildStrip();
    const body = node('div', this.dialog, '', 'vb-armory-body');
    this.panels = Object.fromEntries(TABS.map(([id]) => {
      const panel = node('section', body, '', `vb-armory-panel vb-armory-panel-${id}`);
      panel.id = `armory-panel-${id}`;
      panel.setAttribute('role', 'tabpanel');
      panel.setAttribute('aria-labelledby', `armory-tab-${id}`);
      panel.hidden = id !== this.tab;
      return [id, panel];
    }));
    const aside = node('aside', body, '', 'vb-armory-inspector vb-career-feature');
    aside.id = 'armory-inspector';
    aside.setAttribute('aria-label', 'Inspector');
    this.inspector = new Inspector(aside, { host: this, ...(loadViewer ? { loadViewer } : {}) });
    this.loadout = new LoadoutPanel(this.panels.loadout, this);
    this.progress = new ProgressPanel(this.panels.progress, this);
    this.mastery = new MasteryPanel(this.panels.mastery, this);
    this.benchNote = node('p', this.panels.weapons, 'LOADING WEAPONS', 'vb-armory-empty');
    this.stale = new Set(TAB_IDS);
    this.badge = node('div', document.body, '', 'vb-career-badge');
    this.badge.id = 'career-badge';
    this.dialog.addEventListener('keydown', event => event.stopPropagation());
    this.dialog.addEventListener('close', () => this.onClose());
    this.onAccountChange = () => this.resetIdentity();
    window.addEventListener('vb-account-change', this.onAccountChange);
    this.onPagehide = event => { if (!event.persisted) this.dispose(); };
    window.addEventListener('pagehide', this.onPagehide);
    this.syncAccount();
  }

  buildHeader() {
    const header = node('header', this.dialog, '', 'vb-armory-header');
    node('span', header, 'VOXEL BLITZ', 'vb-armory-brand');
    node('h2', header, 'ARMORY').id = 'career-title';
    this.tablist = node('div', header, '', 'vb-armory-tabs');
    this.tablist.setAttribute('role', 'tablist');
    this.tablist.setAttribute('aria-label', 'Armory sections');
    this.tabs = Object.fromEntries(TABS.map(([id, label]) => {
      const tab = button(this.tablist, '', 'vb-armory-tab', () => this.setTab(id));
      tab.id = `armory-tab-${id}`;
      tab.setAttribute('role', 'tab');
      tab.dataset.tab = id;
      tab.dataset.focusKey = `tab:${id}`;
      tab.setAttribute('aria-controls', `armory-panel-${id}`);
      node('span', tab, label, 'vb-armory-tab-label');
      return [id, tab];
    }));
    rovingKeys(this.tablist, '[role=tab]', { orientation: 'horizontal', onMove: tab => this.setTab(tab.dataset.tab) });
    this.music = node('div', header, '', 'vb-armory-music');
    // At <=640px the header shows a 44px speaker button that opens the slider on demand.
    this.musicToggle = button(this.music, '', 'vb-armory-music-toggle', () => this.setMusicOpen(this.music.dataset.open !== 'true'));
    this.musicToggle.setAttribute('aria-label', 'Music volume');
    this.musicToggle.setAttribute('aria-expanded', 'false');
    speaker(this.musicToggle);
    mountMusicControl(this.music);
    const close = button(header, 'BACK', 'vb-btn vb-armory-close', () => this.dialog.close());
    close.id = 'career-close';
    this.syncTabs();
  }

  setMusicOpen(open) {
    this.music.dataset.open = String(open);
    this.musicToggle.setAttribute('aria-expanded', String(open));
  }

  buildStrip() {
    const strip = this.strip = node('section', this.dialog, '', 'vb-armory-strip');
    strip.setAttribute('aria-label', 'Your career');
    strip.dataset.expanded = 'false';
    this.levelCircle = node('span', strip, '', 'vb-armory-level-circle');
    this.levelCircle.setAttribute('aria-hidden', 'true');
    this.rank = node('span', strip, '', 'vb-career-rank-art');
    const identity = node('div', strip, '', 'vb-armory-identity');
    this.playerName = node('p', identity, 'GUEST PLAYER', 'vb-career-player');
    this.titleName = node('p', identity, '', 'vb-career-title-name');
    const xp = node('div', strip, '', 'vb-armory-xp');
    this.stats = node('p', xp, 'Loading career...', 'vb-career-stats');
    this.xpBar = bar(xp, 0, 1, 'Loading career', 'vb-armory-bar vb-armory-xp-bar');
    this.xpLeft = node('p', xp, '', 'vb-armory-xp-left');
    this.record = node('dl', strip, '', 'vb-armory-record');
    const account = node('div', strip, '', 'vb-career-account');
    this.accountDescription = node('p', account);
    this.accountButton = button(account, 'SAVE YOUR CAREER', 'vb-btn', () => this.accounts?.open(this.accounts.user ? 'account' : 'register'));
    this.accountButton.id = 'career-account';
    this.stripToggle = button(strip, 'CAREER DETAILS', 'vb-armory-strip-toggle', () => {
      const open = strip.dataset.expanded !== 'true';
      strip.dataset.expanded = String(open);
      this.stripToggle.setAttribute('aria-expanded', String(open));
    });
    this.stripToggle.setAttribute('aria-expanded', 'false');
  }

  get mobile() { try { return !!globalThis.matchMedia?.('(max-width: 640px)').matches; } catch { return false; } }
  get benchWeapon() { return this.bench?.weapon || this.weaponSelection || 'rifle'; }

  syncAccount() {
    const user = this.accounts?.user;
    this.playerName.textContent = user?.username || 'GUEST PLAYER';
    this.accountDescription.textContent = user
      ? `Saved to ${user.username}. Log in on another device to continue this career.`
      : 'Guest career stays in this browser. Log in to keep it.';
    this.accountButton.textContent = user ? 'MANAGE ACCOUNT' : 'SAVE YOUR CAREER';
    this.accountButton.hidden = !this.accounts;
  }

  // ---------- store ----------
  request(item = null, equipOnly = false, reset = {}) { return careerRequest(this, item, equipOnly, reset); }
  saveAttachments(weapon, attachments) {
    // A previous identity's pending bench choice never reaches the next one.
    if (this.resetting) return Promise.resolve(null);
    return careerSaveAttachments(this, weapon, attachments);
  }

  async refresh() {
    try { await this.accounts?.refresh(); return await this.request(); }
    catch (error) { this.inspector.setStatus(error.message, 'error'); return null; }
  }

  async start() {
    this.mountButton();
    this.observer = new MutationObserver(() => this.mountButton());
    const menu = document.getElementById('menu');
    if (menu) this.observer.observe(menu, { childList: true, subtree: true });
    // Establish the HttpOnly career cookie before the gameplay socket connects.
    try { await this.request(); } catch (error) { this.inspector.setStatus(error.message, 'error'); }
    this.mountButton();
    this.timer = setInterval(() => {
      if (!document.hidden && !this.dialog.open && !this.accounts?.dialog?.open) {
        Promise.resolve(this.accounts?.refresh()).then(() => this.request()).catch(() => {});
      }
    }, 15000);
  }

  // ---------- NEW flags ----------
  ensureSeen() {
    const id = this.accounts?.user?.id || null;
    if (!this.seen || this.seenUser !== id) { this.seen = new SeenStore(id); this.seenUser = id; }
    if (this.profile) this.seen.sync(this.profile);
    return this.seen;
  }

  isNew(id) { return !!this.seen?.isNew(id) && !!treeNode(id) && !!this.profile?.owned?.includes(id); }
  newIds() { return this.profile ? (this.seen?.newIds(this.profile) || []).filter(id => treeNode(id)) : []; }

  /** Shown in the inspector: clear its NEW marks in place, without re-rendering lists.
   * An element may stand for several rewards (`newIds`, a mastery card); its NEW state
   * clears once none of them is new. `onSeen` swaps its NEW chip for the owned one. */
  markSeen(id) {
    if (!this.seen?.markSeen(id)) return;
    for (const element of this.dialog.querySelectorAll('[data-new]')) {
      const ids = element.newIds || [element.dataset.new];
      if (!ids.includes(id) || ids.some(other => this.isNew(other))) continue;
      delete element.dataset.new;
      element.onSeen?.();
    }
    this.syncNew();
  }

  markAllSeen() {
    if (!this.profile || !this.seen?.markAllSeen(this.profile)) return;
    this.renderMenuPreview();
    if (this.dialog.open) { this.stale = new Set(TAB_IDS); this.renderDialog(); }
  }

  syncNew() {
    const fresh = this.newIds().map(treeNode);
    for (const [id, tab] of Object.entries(this.tabs)) {
      const has = fresh.some(item => TAB_HOLDS[id](item));
      let dot = tab.querySelector('.vb-tab-new');
      if (has && !dot) { dot = node('span', tab, '', 'vb-tab-new'); node('span', dot, ', new unlocks', 'vb-sr'); }
      else if (!has) dot?.remove();
    }
    for (const control of this.dialog.querySelectorAll('.vb-armory-slot[data-has-new]')) {
      const slot = control.dataset.slot;
      if (!fresh.some(item => item.kind === slot)) { delete control.dataset.hasNew; control.querySelector('.vb-new-dot')?.remove(); }
    }
    this.renderNav();
  }

  // ---------- opening and tabs ----------
  /** open({tab, weapon, part, item}); an element argument is the legacy focus-return opener. */
  async open(options = {}, opener = null) {
    if (options && typeof options === 'object' && 'nodeType' in options) { opener = options; options = {}; }
    const { tab = null, weapon = null, part = null, item = null } = options || {};
    const wasOpen = this.dialog.open;
    if (!wasOpen) {
      this.returnFocus = opener || (typeof document !== 'undefined' ? document.activeElement : null);
      this.dialog.showModal();
    }
    if (weapon) this.weaponSelection = weapon;
    this.setTab(tab || (wasOpen ? this.tab : 'loadout'), { weapon, part, item, focus: !wasOpen });
    if (wasOpen) return this.profile;
    this.inspector.setStatus('Loading career...');
    try {
      await this.accounts?.refresh();
      const profile = await this.request();
      if (profile) this.inspector.setStatus('');
      return profile;
    } catch (error) { this.inspector.setStatus(error.message, 'error'); return null; }
  }

  setTab(tab, { weapon = null, part = null, item = null, focus = false } = {}) {
    if (!TAB_IDS.includes(tab)) tab = 'loadout';
    const previous = this.tab;
    // A control inside the panel being hidden (a weapon row, TUNE IN WEAPONS, a goal card)
    // would strand focus on <body>: the new tab takes it until the panel offers a better target.
    const stranded = previous !== tab && !!this.panels?.[previous]?.contains(document.activeElement);
    this.tab = tab;
    this.dialog.dataset.tab = tab;
    this.syncTabs();
    if (focus || stranded) this.tabs[tab].focus();
    if (tab !== 'weapons') this.inspector.action.hidden = false;
    // A new tab starts with its list in view: the mobile sheet and the last tab's status go.
    if (previous !== tab) {
      this.inspector.setSheet(false);
      if (this.inspector.status.dataset.tone !== 'error') this.inspector.setStatus('');
    }
    if (tab === 'weapons') {
      if (weapon) this.weaponSelection = weapon;
      // Without a profile the bench waits; renderDialog opens it once the career arrives.
      this.benchRequest = { weapon: weapon || this.benchWeapon, part, item, land: stranded };
      if (this.profile) this.showBench(this.benchRequest);
      return;
    }
    if (!this.profile) return;
    if (this.stale.has(tab)) this.renderPanel(tab);
    if (item) { this.inspector.inspect(item, { pin: true }); return; }
    if (tab === 'loadout') this.inspector.inspect(this.loadout.equippedTarget(), { pin: true });
    else if (previous !== tab || !this.inspector.pinned) this.inspector.inspect(this.defaultTarget(tab), { pin: true });
  }

  defaultTarget(tab) {
    if (tab === 'progress') return this.progress.selected || nextGoals(this.profile)[0]?.id || this.loadout.equippedTarget('characterSkin');
    if (tab === 'mastery') {
      const fresh = this.newIds().find(id => TAB_HOLDS.mastery(treeNode(id)));
      return fresh || nextGoals(this.profile).find(goal => goal.type === 'mastery')?.id || this.inspector.pinned;
    }
    return this.loadout.equippedTarget('characterSkin');
  }

  syncTabs() {
    for (const [id, tab] of Object.entries(this.tabs)) {
      const selected = id === this.tab;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    }
    for (const [id, panel] of Object.entries(this.panels || {})) panel.hidden = id !== this.tab;
    rovingSync(this.tablist, '[role=tab]', this.tabs[this.tab]);
  }

  async showBench({ weapon, part = null, item = null, land = false } = {}) {
    this.benchRequest = null;
    try {
      const bench = await this.ensureBench();
      if (!bench || this.tab !== 'weapons') return;
      // FIT ON <WEAPON> lands on the inspected attachment itself.
      const id = part ? treeNode(item)?.part || null : null;
      bench.select(weapon || 'rifle', part ? { part, ...(id ? { id } : {}) } : {});
      // Focus parked on the tab by setTab moves on to the chosen weapon in the rail.
      if (land && !part && document.activeElement === this.tabs.weapons) bench.railButtons?.get(bench.weapon)?.focus();
    } catch {
      this.benchNote.textContent = 'Weapons are unavailable right now. Close the armory and try again.';
    }
  }

  ensureBench() {
    if (this.bench) return Promise.resolve(this.bench);
    this.benchLoading ||= Promise.resolve().then(() => this.loadWeaponBench()).then(WeaponBench => {
      if (this.disposed) return null;
      this.benchNote.remove();
      this.bench = new WeaponBench({ panel: this.panels.weapons, inspector: this.inspector, host: this });
      if (this.profile) this.bench.setProfile(this.profile);
      return this.bench;
    }).finally(() => { this.benchLoading = null; });
    return this.benchLoading;
  }

  /** Goal cards and journey chips: level rewards select in the tree, mastery rewards open their ladder. */
  jumpTo(id) {
    const item = treeNode(id);
    if (!item) return;
    if (TAB_HOLDS.progress(item)) {
      if (this.tab !== 'progress') this.setTab('progress');
      this.progress.reveal(id);
      return;
    }
    this.setTab('mastery', { item: id });
    if (item.weapon) this.mastery.show(item.weapon);
    this.inspector.inspect(id, { pin: true, reveal: true });
    // Coming from another panel, setTab parked focus on the tab: land on the reward itself.
    if (document.activeElement === this.tabs.mastery) {
      const panel = this.panels.mastery;
      const target = [...panel.querySelectorAll('[data-mastery-node]')].find(tile => tile.dataset.masteryNode === id && !tile.closest('[hidden]'))
        || (item.weapon ? panel.querySelector(`[data-weapon-mastery="${item.weapon}"]`) : null);
      target?.focus();
    }
  }

  summary(item) { return unlockSummary(careerItemState(this.profile, item), item); }

  /** Equip an owned reward or reset a slot; only the server's answer changes what is shown. */
  async equip(target, { control = null } = {}) {
    if (this.busy || !this.profile) return null;
    const standard = typeof target === 'object' && target?.standard;
    const item = standard ? null : treeNode(typeof target === 'string' ? target : target?.id);
    if (!standard && !item) return null;
    this.busy = true;
    control?.setAttribute('aria-busy', 'true');
    this.inspector.action.disabled = true;
    try {
      const reset = standard ? { slot: target.slot, ...(target.weapon ? { weapon: target.weapon } : {}) } : null;
      const accepted = standard ? await this.request('standard', true, reset) : await this.request(item.id, true);
      if (accepted) {
        const label = target.slot === 'weaponSkin' ? `${weaponName(target.weapon)} SKIN` : slotOf(target.slot)?.label;
        this.inspector.setStatus(standard ? `${label} set to standard` : `${item.name} equipped`);
      }
      return accepted;
    } catch (error) {
      this.inspector.setStatus(error.message, 'error');
      return null;
    } finally {
      this.busy = false;
      control?.removeAttribute('aria-busy');
      this.inspector.refresh();
    }
  }

  // ---------- rendering ----------
  render() {
    const profile = this.profile;
    if (!profile) return;
    this.ensureSeen();
    // D16: in a match the crosshair follows the self snapshot row (main.js); the poll only re-tints.
    const inMatch = document.getElementById('hud')?.classList.contains('hidden') === false;
    if (inMatch) applyTheme(profile.equipped?.theme);
    else applyLocalPresentation(profile.equipped);
    this.renderBadge();
    this.renderNav();
    this.renderMenuPreview();
    // D18: a closed dialog is never re-rendered by the idle poll.
    if (!this.dialog.open) { this.stale = new Set(TAB_IDS); return; }
    this.renderDialog();
  }

  renderDialog() {
    if (!this.profile) return;
    this.syncAccount();
    this.renderStrip();
    this.stale = new Set(TAB_IDS);
    this.renderPanel(this.tab);
    if (this.bench) this.bench.setProfile(this.profile);
    else if (this.tab === 'weapons' && !this.benchLoading) this.showBench(this.benchRequest || { weapon: this.benchWeapon });
    if (!this.inspector.current && this.tab !== 'weapons') this.setTab(this.tab);
    else this.inspector.refresh();
    this.syncNew();
  }

  renderPanel(tab) {
    this.stale.delete(tab);
    ({ loadout: this.loadout, progress: this.progress, mastery: this.mastery })[tab]?.render();
  }

  titleOf(profile = this.profile) { return treeNode(profile?.equipped?.title) || treeNode('rookie'); }
  levelText(profile = this.profile) {
    const stars = serviceStars(profile.level);
    return { level: `LEVEL ${profile.level} / ${this.titleOf(profile).name}`, stars: stars ? `★${stars}` : '' };
  }

  renderStrip() {
    const profile = this.profile;
    const { level, stars } = this.levelText(profile);
    this.levelCircle.textContent = String(profile.level);
    this.rank.replaceChildren();
    art(this.rank, this.titleOf(profile), 'thumb');
    this.titleName.replaceChildren();
    this.titleName.textContent = level;
    if (stars) node('span', this.titleName, ` ${stars}`, 'vb-armory-stars');
    this.stats.textContent = `LEVEL ${profile.level} · ${format(profile.xp)} XP`;
    const span = profile.nextLevel - profile.levelStart, into = profile.xp - profile.levelStart, left = profile.nextLevel - profile.xp;
    const text = `${format(into)} of ${format(span)} XP to level ${profile.level + 1}`;
    setBar(this.xpBar, into, span, text);
    this.xpLeft.textContent = `${format(left)} XP TO LEVEL ${profile.level + 1}`;
    this.record.replaceChildren();
    for (const [label, value] of [['PVP KILLS', profile.pvpKills], ['WINS', profile.wins], ['ALL KILLS', profile.kills], ['MATCHES', profile.matches]]) {
      const entry = node('div', this.record);
      node('dt', entry, label);
      node('dd', entry, format(value));
    }
  }

  renderBadge() {
    const profile = this.profile;
    const stars = serviceStars(profile.level);
    this.badge.textContent = `LV ${profile.level} · ${this.titleOf(profile).name}${stars ? ` ★${stars}` : ''}`;
  }

  renderNav() {
    const open = document.getElementById('career-open');
    if (!open) return;
    const count = this.newIds().length;
    let badge = open.querySelector('.vb-nav-badge');
    if (!badge) { badge = node('span', open, '', 'vb-nav-badge'); badge.setAttribute('aria-hidden', 'true'); }
    badge.textContent = String(count);
    badge.hidden = count === 0;
    if (count) open.setAttribute('aria-label', `Armory, ${count} new unlock${count === 1 ? '' : 's'}`);
    else open.removeAttribute('aria-label');
  }

  mountButton() {
    const navigation = document.querySelector('#menu .vb-main-nav');
    if (navigation && !document.getElementById('career-open')) {
      const open = button(navigation, '', 'vb-main-nav-button');
      open.id = 'career-open';
      node('span', open, 'ARMORY', 'vb-nav-label');
      open.setAttribute('aria-haspopup', 'dialog');
      open.addEventListener('click', () => this.open({ tab: 'loadout' }, open));
      this.renderNav();
    }
    const showcase = document.querySelector('#menu .vb-menu-showcase');
    if (showcase && !document.getElementById('career-menu-preview')) {
      this.menuPreview = button(showcase, '', 'vb-career-menu-preview');
      this.menuPreview.id = 'career-menu-preview';
      this.menuPreview.setAttribute('aria-haspopup', 'dialog');
      this.menuPreview.addEventListener('click', () => {
        const first = treeNode(this.newIds()[0]);
        this.open({ tab: first?.branch === 'mastery' ? 'mastery' : 'progress' }, this.menuPreview);
      });
      this.renderMenuPreview();
    }
  }

  renderMenuPreview() {
    if (!this.menuPreview?.isConnected) return;
    this.menuPreview.replaceChildren();
    const profile = this.profile;
    if (!profile) { node('span', this.menuPreview, 'Loading your career...', 'vb-career-menu-meta'); return; }
    const title = this.titleOf(profile);
    art(this.menuPreview, title, 'thumb', 'vb-career-menu-art');
    const copy = node('span', this.menuPreview, '', 'vb-career-menu-copy');
    node('span', copy, this.accounts?.user ? 'YOUR CAREER' : 'YOUR GUEST CAREER', 'vb-career-kicker');
    const { level, stars } = this.levelText(profile);
    node('strong', copy, stars ? `${level} ${stars}` : level, 'vb-career-menu-level');
    const span = profile.nextLevel - profile.levelStart, into = profile.xp - profile.levelStart;
    bar(copy, into, span, `${format(into)} of ${format(span)} XP to level ${profile.level + 1}`, 'vb-armory-bar vb-career-menu-bar');
    const goal = nextGoals(profile)[0], item = treeNode(goal?.id);
    node('span', copy, goal ? `NEXT: ${item.name} · ${goal.type === 'level' ? `LV ${item.level} · ${format(goal.remaining)} XP`
      : `${format(goal.current)} / ${format(goal.target)}${goal.unit === 'weapons' ? ' WEAPONS' : ''}`}`
      : `ALL ${CAREER_CATALOG.length} UNLOCKS COMPLETE`, 'vb-career-menu-meta');
    const baseline = this.seen?.baseline, fresh = this.newIds().length;
    const gained = Number.isFinite(baseline) ? Math.max(0, profile.xp - baseline) : 0;
    if (Number.isFinite(baseline) && (gained || fresh)) {
      const parts = [...(gained ? [`+${format(gained)} XP`] : []), ...(fresh ? [`${fresh} NEW UNLOCK${fresh === 1 ? '' : 'S'}`] : [])];
      node('span', copy, `${parts.join(' · ')} SINCE YOUR LAST VISIT`, 'vb-career-menu-since');
    }
    node('span', this.menuPreview, 'ARMORY ›', 'vb-career-menu-link');
  }

  onClose() {
    this.inspector.disposeViewer();
    if (this.profile) this.seen?.setBaseline(this.profile.xp);
    this.renderMenuPreview();
    this.loadout.root.dataset.view = 'slots';
    this.inspector.setSheet(false);
    this.setMusicOpen(false);
    const opener = this.returnFocus;
    this.returnFocus = null;
    if (opener?.isConnected && opener.getClientRects().length) opener.focus();
    else document.getElementById('career-open')?.focus();
  }

  /** A new identity: drop the previous profile before any account-bound request completes. */
  resetIdentity() {
    this.requestVersion = (this.requestVersion || 0) + 1;
    this.profile = null;
    this.seen = null;
    this.inspector.disposeViewer();
    this.inspector.pinned = this.inspector.current = null;
    this.resetting = true;
    try { this.bench?.dispose(); } finally { this.resetting = false; }
    this.bench = null;
    this.benchLoading = null;
    this.panels.weapons.replaceChildren(this.benchNote);
    this.benchNote.textContent = 'LOADING WEAPONS';
    resetLocalPresentation();
    announceCareer(null);
    for (const [id, panel] of Object.entries(this.panels)) if (id !== 'weapons') panel.hidden = id !== this.tab;
    this.rank.replaceChildren();
    this.record.replaceChildren();
    this.stats.textContent = 'Loading career...';
    this.titleName.textContent = '';
    this.xpLeft.textContent = '';
    this.badge.textContent = '';
    this.stale = new Set(TAB_IDS);
    this.syncAccount();
    this.renderMenuPreview();
    this.renderNav();
    this.request().catch(error => this.inspector.setStatus(error.message, 'error'));
  }

  dispose() {
    this.disposed = true;
    this.requestVersion = (this.requestVersion || 0) + 1;
    this.inspector.dispose();
    this.bench?.dispose();
    clearInterval(this.timer);
    this.observer?.disconnect();
    window.removeEventListener('pagehide', this.onPagehide);
    window.removeEventListener('vb-account-change', this.onAccountChange);
    this.dialog.remove(); this.badge.remove(); this.menuPreview?.remove();
    document.getElementById('career-open')?.remove();
  }
}

export { ProgressionTree as ArmoryScreen };
