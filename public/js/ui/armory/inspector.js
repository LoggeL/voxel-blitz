// The armory inspector: one stage, one lazy ModelViewer, the item's state, its
// requirements and the single primary action (#armory-action).
import { KIND_LABELS, MASTERY_TIERS, careerItemState, treeNode } from '../../../../shared/career.js';
import { ATTACHMENT_SLOTS } from '../../../../shared/weapon-attachments.js';
import { WEAPON_IDS } from '../../../../shared/combatmath.js';
import { cosmeticArtwork, CosmeticAudition } from '../cosmetic-preview.js';
import { weaponImagePath } from '../hud-support.js';
import { equippable, format, slotOf, weaponName } from './armory-model.js';

export const node = (tag, parent, text = '', className = '') => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  parent?.append(element);
  return element;
};

export const button = (parent, text, className = '', onClick = null) => {
  const element = node('button', parent, text, className);
  element.type = 'button';
  if (onClick) element.addEventListener('click', onClick);
  return element;
};

const GLYPHS = {
  equipped: 'M3 8.5 6.5 12 13 4.5',
  owned: 'M3 8.5 6.5 12 13 4.5',
  next: 'M8 2v12M2 8h12',
  locked: 'M4.5 7V5a3.5 3.5 0 0 1 7 0v2M3.5 7h9v7h-9Z',
  new: 'M8 1.5 9.8 6.2 14.5 8 9.8 9.8 8 14.5 6.2 9.8 1.5 8 6.2 6.2Z',
  star: 'M8 1.5 10 6h4.7l-3.8 2.9 1.5 4.7L8 10.8l-4.4 2.8 1.5-4.7L1.3 6H6Z',
};

/** A decorative state glyph; the paired word carries the meaning. */
export function glyph(parent, name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', `vb-glyph vb-glyph-${name}`);
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', GLYPHS[name] || GLYPHS.next);
  svg.append(path);
  parent.append(svg);
  return svg;
}

/** A standard slot has no catalog node; previews get a neutral stand-in. */
export const standardItem = slot => ({ id: 'standard', kind: slot, name: 'Standard', color: '#b0c6d6', detail: '' });

/** Artwork that can never break the armory, whatever a preview renderer throws. */
export function art(parent, item, size = 'thumb', className = '') {
  const host = node('span', parent, '', `vb-armory-art vb-armory-art-${size}${className ? ` ${className}` : ''}`);
  host.setAttribute('aria-hidden', 'true');
  try { cosmeticArtwork(host, item, '', { size }); }
  catch { node('span', host, (item?.name || 'Standard').slice(0, 2).toUpperCase(), 'vb-armory-art-fallback'); }
  return host;
}

/** A labelled bar; every bar states its value in words. */
export function bar(parent, value, max, text, className = 'vb-armory-bar') {
  const track = node('div', parent, '', className);
  track.setAttribute('role', 'progressbar');
  track.setAttribute('aria-valuemin', '0');
  node('span', track);
  return setBar(track, value, max, text);
}

export function setBar(track, value, max, text) {
  track.setAttribute('aria-valuemax', String(Math.max(1, max)));
  track.setAttribute('aria-valuenow', String(Math.max(0, Math.min(value, max))));
  track.setAttribute('aria-valuetext', text);
  track.firstElementChild.style.width = `${max > 0 ? Math.max(0, Math.min(100, value / max * 100)) : 100}%`;
  return track;
}

/** The shortfall that keeps a node closed, in the player's words. */
export function unlockSummary(state, item) {
  if (state.blockedByParent) return `UNLOCK ${(treeNode(item.parent)?.name || 'THE PREVIOUS NODE').toUpperCase()} FIRST`;
  const pending = state.requirements.find(requirement => !requirement.complete);
  if (!pending) return 'UNLOCKS AUTOMATICALLY';
  if (pending.label === 'Career level') {
    const togo = state.xpToGo ?? 0;
    return togo > 0 ? `LEVEL ${item.level} · ${format(togo)} XP TO GO` : `LEVEL ${item.level} REQUIRED`;
  }
  return `${pending.label.toUpperCase()} · ${format(pending.current)} / ${format(pending.target)}`;
}

/** The same shortfall for the 64px mobile bar: numbers first survive a narrow row. */
export function shortSummary(state, item) {
  const pending = state.requirements.find(requirement => !requirement.complete);
  if (state.blockedByParent || !pending) return unlockSummary(state, item);
  const values = `${format(pending.current)} / ${format(pending.target)}`;
  if (pending.label === 'Career level') return state.xpToGo > 0 ? `LV ${item.level} · ${format(state.xpToGo)} XP` : `LV ${item.level}`;
  const tier = MASTERY_TIERS.find(entry => entry.id === (item.masteryTier || item.arsenal?.tier))?.name;
  if (item.arsenal) return `${tier} · ${values} WEAPONS`;
  return `${tier || 'COMBAT'} · ${values}`;
}

const audienceFor = kind => kind === 'weaponSkin' || kind === 'attachment' ? 'Everyone in the match' : slotOf(kind)?.audience || '';
const WEAPON_DEFAULT = 'rifle';
/** Attachments preview on the selected weapon, or the first weapon that can mount them. */
export function mountWeapon(item, preferred = WEAPON_DEFAULT) {
  if (item?.kind !== 'attachment') return preferred;
  const fits = weapon => ATTACHMENT_SLOTS[weapon]?.[{ optic: 'optics', grip: 'grips', counter: 'counter' }[item.slot]]?.includes(item.part);
  return fits(preferred) ? preferred : WEAPON_IDS.find(fits) || preferred;
}

export class Inspector {
  constructor(root, { host, loadViewer = () => import('../model-viewer.js').then(module => module.ModelViewer) } = {}) {
    this.root = root;
    this.host = host;
    this.loadViewer = loadViewer;
    this.pinned = null;
    this.current = null;
    this.timer = 0;
    this.stageVersion = 0;
    this.audition = new CosmeticAudition(active => this.syncAudition(active));
    root.dataset.sheet = 'closed';
    this.bar = node('div', root, '', 'vb-armory-sheetbar');
    this.thumb = node('span', this.bar, '', 'vb-armory-sheet-thumb');
    this.sheetToggle = button(this.bar, 'DETAILS', 'vb-armory-sheet-toggle', () => this.setSheet(root.dataset.sheet !== 'open'));
    this.sheetToggle.setAttribute('aria-expanded', 'false');
    this.sheetToggle.setAttribute('aria-controls', 'armory-inspector');
    this.stage = node('div', root, '', 'vb-armory-stage');
    this.artHost = node('div', this.stage, '', 'vb-armory-stage-art');
    this.viewerHost = node('div', this.stage, '', 'vb-armory-stage-viewer');
    this.viewerHost.hidden = true;
    this.stageNote = node('p', this.stage, '', 'vb-armory-stage-note');
    this.stageNote.setAttribute('role', 'status');
    this.kicker = node('p', root, '', 'vb-armory-kicker');
    this.name = node('h3', root, '', 'vb-armory-name');
    this.audience = node('p', root, '', 'vb-armory-audience');
    this.detail = node('p', root, '', 'vb-armory-detail');
    this.state = node('p', root, '', 'vb-armory-state');
    this.reqs = node('ul', root, '', 'vb-armory-reqs');
    this.extra = node('div', root, '', 'vb-armory-extra');
    const actions = node('div', root, '', 'vb-armory-actions');
    this.action = button(actions, '', 'vb-btn vb-armory-action', () => this.activate());
    this.action.id = 'armory-action';
    this.status = node('p', actions, '', 'vb-career-status');
    this.status.id = 'armory-status';
    this.status.setAttribute('role', 'status');
    this.status.setAttribute('aria-live', 'polite');
    this.secondary = node('div', root, '', 'vb-armory-secondary');
    this.auditions = node('div', this.secondary, '', 'vb-armory-auditions');
    this.toolbarSlot = node('div', this.secondary, '', 'vb-armory-toolbar');
  }

  get profile() { return this.host?.profile || null; }
  get mobile() { try { return !!globalThis.matchMedia?.('(max-width: 640px)').matches; } catch { return false; } }

  setSheet(open) {
    this.root.dataset.sheet = open ? 'open' : 'closed';
    this.sheetToggle.setAttribute('aria-expanded', String(open));
    this.sheetToggle.textContent = open ? 'CLOSE' : 'DETAILS';
  }

  /** Normalize a target to {id} or {standard:true, slot, weapon?}. */
  resolve(target) {
    if (!target) return null;
    if (typeof target === 'string') return target === 'standard' ? null : treeNode(target) ? { id: target } : null;
    if (target.standard) return { standard: true, slot: target.slot, ...(target.weapon ? { weapon: target.weapon } : {}) };
    return target.id && treeNode(target.id) ? { id: target.id } : null;
  }

  /** Show a target now; `pin` makes it the one hover and focus fall back to;
   * `reveal` (a player's selection) opens the mobile bottom sheet. */
  inspect(target, { pin = false, reveal = false } = {}) {
    const resolved = this.resolve(target);
    clearTimeout(this.timer);
    if (!resolved) return;
    if (pin) this.pinned = resolved;
    if (reveal && this.mobile) this.setSheet(true);
    this.current = resolved;
    this.render();
  }

  /** Hover and focus previews follow after 120 ms, without pinning. */
  preview(target) {
    const resolved = this.resolve(target);
    if (!resolved) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (sameTarget(resolved, this.current)) return;
      this.current = resolved;
      this.render();
    }, 120);
  }

  /** Back to the pinned target once pointer or focus leaves an option list. */
  revert() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (!this.pinned || sameTarget(this.pinned, this.current)) return;
      this.current = this.pinned;
      this.render();
    }, 120);
  }

  /** Re-render the current target against a new profile. */
  refresh() { if (this.current && !this.current.weaponView) this.render(); }

  render() {
    const target = this.current;
    if (!target || !this.profile) return;
    this.audition.stop();
    this.extra.replaceChildren();
    this.action.hidden = false;
    const item = target.standard ? null : treeNode(target.id);
    const kind = item?.kind || target.slot;
    const shown = item || standardItem(target.slot);
    this.root.dataset.featuredItem = item?.id || 'standard';
    this.root.style.setProperty('--item-color', item?.color || '#ffc568');
    this.kicker.textContent = item?.collection ? `${item.collection.toUpperCase()} / ${KIND_LABELS[kind]}` : KIND_LABELS[kind] || 'STANDARD';
    if (item?.weapon && item.kind !== 'weaponSkin') this.kicker.textContent += ` / ${weaponName(item.weapon)}`;
    this.name.textContent = item ? item.name : `Standard ${(slotOf(kind)?.label || KIND_LABELS[kind] || '').toLowerCase()}`.trim();
    const audience = audienceFor(kind);
    this.audience.textContent = audience ? `WHO SEES IT: ${audience}` : '';
    this.audience.hidden = !audience;
    this.detail.textContent = item?.detail || 'The factory look. Always available.';
    this.thumb.replaceChildren();
    art(this.thumb, shown, 'thumb');
    const state = item ? careerItemState(this.profile, item) : null;
    this.renderState(item, state, target);
    this.renderRequirements(state);
    this.renderAction(item, state, target);
    this.renderStage(item, target);
    this.renderAuditions(item, state);
    // Only an owned reward can be seen; a locked one must still read NEW once it opens.
    if (item && state.owned) this.host?.markSeen?.(item.id);
  }

  renderState(item, state, target) {
    this.state.replaceChildren();
    let key, word, short = '';
    if (!item) {
      const equipped = this.standardEquipped(target);
      key = equipped ? 'equipped' : 'owned';
      word = equipped ? 'EQUIPPED' : 'ALWAYS AVAILABLE';
    } else {
      key = state.status;
      word = key === 'equipped' ? 'EQUIPPED' : key === 'owned' ? 'UNLOCKED' : unlockSummary(state, item);
      if (key === 'next' || key === 'locked') short = shortSummary(state, item);
    }
    this.state.dataset.state = key;
    glyph(this.state, key);
    node('span', this.state, word, 'vb-armory-state-word');
    // The mobile bar swaps in the short form; screen readers keep the full sentence.
    if (short && short !== word) {
      this.state.dataset.short = 'true';
      node('span', this.state, short, 'vb-armory-state-short').setAttribute('aria-hidden', 'true');
    } else delete this.state.dataset.short;
  }

  renderRequirements(state) {
    this.reqs.replaceChildren();
    const show = state && !(state.owned && !state.locked);
    this.reqs.hidden = !show;
    if (!show) return;
    for (const requirement of state.requirements) {
      // Level-1 gates (mastery and arsenal roots) are always met; a "4 / 1" row is noise.
      if (requirement.label === 'Career level' && requirement.target <= 1) continue;
      const row = node('li', this.reqs, '', 'vb-armory-req');
      row.dataset.complete = String(requirement.complete);
      node('span', row, requirement.label, 'vb-armory-req-label');
      const values = `${format(requirement.current)} / ${format(requirement.target)}`;
      node('span', row, values, 'vb-armory-req-value');
      bar(row, requirement.current, requirement.target, `${requirement.label}: ${values}${requirement.complete ? ', complete' : ''}`, 'vb-armory-bar vb-armory-req-bar');
    }
  }

  standardEquipped(target) {
    const equipped = this.profile?.equipped || {};
    if (target.slot === 'weaponSkin') return !equipped.weaponSkins?.[target.weapon];
    return (equipped[target.slot] || 'standard') === 'standard';
  }

  renderAction(item, state, target) {
    const action = this.action;
    for (const name of ['item', 'reset', 'weapon', 'part']) delete action.dataset[name];
    action.dataset.featuredItem = item?.id || 'standard';
    action.removeAttribute('aria-describedby');
    const busy = !!this.host?.busy;
    if (!item) {
      const equipped = this.standardEquipped(target);
      action.dataset.reset = target.slot;
      if (target.weapon) action.dataset.weapon = target.weapon;
      action.textContent = equipped ? 'EQUIPPED' : 'USE STANDARD';
      action.disabled = busy || equipped;
      return;
    }
    const open = state.owned && !state.locked;
    if (open && item.kind === 'attachment') {
      const weapon = mountWeapon(item, this.host?.benchWeapon || WEAPON_DEFAULT);
      action.dataset.weapon = weapon;
      action.dataset.part = item.slot;
      action.textContent = `FIT ON ${weaponName(weapon)}`;
      action.disabled = false;
      return;
    }
    if (open && equippable(item)) {
      action.dataset.item = item.id;
      action.textContent = state.equipped ? 'EQUIPPED' : 'EQUIP';
      action.disabled = busy || state.equipped;
      return;
    }
    action.textContent = open ? 'UNLOCKED' : unlockSummary(state, item);
    action.disabled = true;
  }

  activate() {
    const action = this.action;
    if (action.disabled) return;
    if (action.dataset.item) this.host?.equip?.(action.dataset.item);
    else if (action.dataset.reset) this.host?.equip?.({ standard: true, slot: action.dataset.reset, weapon: action.dataset.weapon });
    else if (action.dataset.part) {
      const item = treeNode(this.current?.id);
      this.host?.open?.({ tab: 'weapons', weapon: action.dataset.weapon, part: item?.slot, item: item?.id });
    }
  }

  /** 3D for skins, attachments and the standard operator; artwork for everything else. */
  renderStage(item, target) {
    const kind = item?.kind || target.slot;
    this.stage.dataset.kind = kind || 'standard';
    const version = ++this.stageVersion;
    const equipped = this.profile?.equipped || {};
    let spec = null;
    if (kind === 'characterSkin') spec = { weapon: null, loadout: { characterSkin: item?.id || 'standard' }, label: item?.name || 'Standard operator' };
    else if (kind === 'weaponSkin' && (item?.weapon || target.weapon)) {
      const weapon = item?.weapon || target.weapon;
      spec = { weapon, loadout: { weaponSkins: item ? { [weapon]: item.id } : {} }, attachments: equipped.weaponAttachments?.[weapon],
        label: item?.name || `Standard ${weaponName(weapon)}` };
    } else if (kind === 'attachment') {
      const weapon = mountWeapon(item, this.host?.benchWeapon || WEAPON_DEFAULT);
      spec = { weapon, loadout: { weaponSkins: equipped.weaponSkins || {} },
        attachments: { ...(equipped.weaponAttachments?.[weapon] || {}), [item.slot]: item.part }, label: `${item.name} on ${weaponName(weapon)}` };
    }
    if (spec) spec.mastery = this.profile?.mastery || {};
    if (spec?.weapon && (!item || item.kind === 'attachment')) this.showWeaponArt(spec.weapon);
    else if (!item && kind === 'characterSkin') this.showPlate('STANDARD OPERATOR');
    else this.showArt(item || standardItem(kind));
    if (!spec) { this.stageNote.textContent = ''; this.hideViewer(); return; }
    this.show3d(spec, version);
  }

  showArt(item) {
    this.artHost.replaceChildren();
    art(this.artHost, item, 'stage');
    this.artHost.hidden = false;
  }

  showWeaponArt(weapon) {
    this.artHost.replaceChildren();
    const image = node('img', this.artHost, '', 'vb-armory-weapon-art');
    image.src = weaponImagePath(weapon);
    image.alt = '';
    image.decoding = 'async';
    this.artHost.hidden = false;
  }

  showPlate(text) {
    this.artHost.replaceChildren();
    node('span', this.artHost, text, 'vb-armory-plate');
    this.artHost.hidden = false;
  }

  hideViewer() {
    this.viewerHost.hidden = true;
    this.toolbarSlot.hidden = true;
  }

  show3d(spec, version) {
    const ready = this.viewerInstance && !this.viewerInstance.disposed;
    if (!ready) { this.hideViewer(); this.stageNote.textContent = 'LOADING 3D PREVIEW'; }
    this.viewer().then(viewer => {
      if (version !== this.stageVersion) return;
      this.artHost.hidden = true;
      this.viewerHost.hidden = false;
      this.toolbarSlot.hidden = false;
      this.stageNote.textContent = '';
      viewer.show(spec);
    }).catch(() => {
      if (version !== this.stageVersion) return;
      this.hideViewer();
      this.artHost.hidden = false;
      this.stageNote.textContent = '3D preview unavailable on this device';
    });
  }

  /** The single lazy viewer for the whole dialog; the 3D toolbar moves into the secondary row. */
  viewer() {
    if (this.viewerInstance && !this.viewerInstance.disposed) return Promise.resolve(this.viewerInstance);
    if (!this.host?.dialog?.open) return Promise.reject(new Error('Armory closed'));
    this.viewerPromise ||= Promise.resolve().then(() => this.loadViewer()).then(ModelViewer => {
      if (!this.host?.dialog?.open) throw new Error('Armory closed');
      const viewer = new ModelViewer(this.viewerHost);
      const toolbar = viewer.element?.querySelector?.('.vb-model-toolbar');
      if (toolbar) this.toolbarSlot.replaceChildren(toolbar);
      this.viewerInstance = viewer;
      return viewer;
    }).finally(() => { this.viewerPromise = null; });
    return this.viewerPromise;
  }

  /** Called by the WEAPONS bench: its weapon in 3D with the focused option applied. */
  showWeapon({ weapon, skin = null, attachments, mastery, title, kicker, detail, extra } = {}) {
    clearTimeout(this.timer);
    this.audition.stop();
    this.current = { weaponView: true, weapon };
    const item = skin && skin !== 'standard' ? treeNode(skin) : null;
    this.root.dataset.featuredItem = item?.id || 'standard';
    this.root.style.setProperty('--item-color', item?.color || '#ffc568');
    this.kicker.textContent = kicker || `WEAPON / ${weaponName(weapon)}`;
    this.name.textContent = title || weaponName(weapon);
    this.audience.textContent = 'WHO SEES IT: Everyone in the match';
    this.audience.hidden = false;
    this.detail.textContent = detail || '';
    this.state.replaceChildren();
    this.state.dataset.state = 'owned';
    delete this.state.dataset.short;
    this.reqs.replaceChildren();
    this.reqs.hidden = true;
    this.action.hidden = true;
    this.auditions.replaceChildren();
    this.extra.replaceChildren();
    if (extra) this.extra.append(extra);
    this.thumb.replaceChildren();
    art(this.thumb, item || standardItem('weaponSkin'), 'thumb');
    this.stage.dataset.kind = 'weapon';
    const version = ++this.stageVersion;
    if (item) this.showArt(item); else this.showWeaponArt(weapon);
    this.show3d({ weapon, loadout: { weaponSkins: item ? { [weapon]: item.id } : {} }, attachments,
      mastery: mastery || this.profile?.mastery || {}, label: title || weaponName(weapon) }, version);
  }

  renderAuditions(item, state) {
    this.auditions.replaceChildren();
    this.auditions.hidden = item?.kind !== 'sound';
    if (item?.kind !== 'sound') return;
    for (const [cue, label] of [['kill', 'KILL'], ['death', 'DEATH'], ['victory', 'VICTORY']]) {
      const control = button(this.auditions, '', 'vb-btn vb-armory-audition', () => {
        this.audition.play(item, cue).catch(error => this.setStatus(error.message, 'error'));
      });
      control.dataset.audition = `${item.id}:${cue}`;
      control.dataset.cue = cue;
      control.setAttribute('aria-label', `Preview ${item.name} ${label.toLowerCase()} sound`);
      control.setAttribute('aria-pressed', 'false');
      control.textContent = `PLAY ${label}`;
    }
    this.syncAudition(this.audition.active);
  }

  syncAudition(active) {
    for (const control of this.auditions?.querySelectorAll('[data-audition]') || []) {
      const playing = control.dataset.audition === active;
      control.setAttribute('aria-pressed', String(playing));
      control.textContent = `${playing ? 'STOP' : 'PLAY'} ${control.dataset.cue.toUpperCase()}`;
    }
  }

  setStatus(text, tone = 'info') {
    this.status.textContent = text || '';
    this.status.dataset.tone = tone;
  }

  /** Dialog close: stop sound, drop the WebGL context. The pinned target survives. */
  disposeViewer() {
    clearTimeout(this.timer);
    this.audition.stop();
    this.stageVersion++;
    this.viewerInstance?.dispose();
    this.viewerInstance = null;
    this.toolbarSlot.replaceChildren();
    this.hideViewer();
    this.artHost.hidden = false;
  }

  dispose() {
    this.disposeViewer();
    this.pinned = this.current = null;
  }
}

const sameTarget = (a, b) => !!a && !!b && a.id === b.id && !!a.standard === !!b.standard && a.slot === b.slot && a.weapon === b.weapon;

