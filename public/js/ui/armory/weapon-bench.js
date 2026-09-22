import { WEAPONS, WEAPON_IDS } from '../../../../shared/combatmath.js';
import { OPTICS, GRIPS, COUNTERS, ATTACHMENT_SLOTS, normalizeAttachments, normalizeWeaponLoadout, weaponWithAttachments } from '../../../../shared/weapon-attachments.js';
import { HANDLING_LIMITS, weaponTurnProfile } from '../../../../shared/weapon-handling.js';
import { PROGRESSION_TREE, MASTERY_TIERS, careerItemState, masteryTracks, treeNode } from '../../../../shared/career.js';
import { WEAPON_NAMES, weaponImagePath } from '../hud-support.js';

/** Save-on-select: the last choice inside this window wins. */
export const BENCH_SAVE_DELAY = 250;
const PREVIEW_DELAY = 120;
const SVG = 'http://www.w3.org/2000/svg';
const GLYPHS = Object.freeze({
  check: 'M3 8.5 6.5 12 13 4',
  lock: 'M4.5 7.5h7v6h-7zM6 7.5V5.5a2 2 0 0 1 4 0v2',
  up: 'M8 3v10M4 7l4-4 4 4',
  down: 'M8 13V3M4 9l4 4 4-4',
  same: 'M3 6h10M3 10h10',
  new: 'M8 1.5 9.8 6.2 14.5 8 9.8 9.8 8 14.5 6.2 9.8 1.5 8 6.2 6.2Z',
});
const PART_GROUPS = Object.freeze([
  { slot: 'optic', label: 'OPTIC', catalog: OPTICS, list: 'optics' },
  { slot: 'grip', label: 'GRIP', catalog: GRIPS, list: 'grips' },
  { slot: 'counter', label: 'KILL COUNTER', catalog: COUNTERS, list: 'counter' },
]);
const METRICS = Object.freeze([
  { label: 'ERGONOMICS', read: h => h.ergonomics, max: HANDLING_LIMITS.ergonomics[1], unit: '', higher: true },
  { label: 'SWAY', read: h => h.sway.amplitudeDeg, max: HANDLING_LIMITS.swayAmplitudeDeg[1], unit: '°', higher: false },
  { label: 'VERTICAL RECOIL', read: h => h.verticalRecoil, max: HANDLING_LIMITS.verticalRecoil[1], unit: '°', higher: false },
  { label: 'HORIZONTAL RECOIL', read: h => h.horizontalRecoil, max: HANDLING_LIMITS.horizontalRecoil[1], unit: '°', higher: false },
]);
const STANDARD_PARTS = Object.freeze({ optic: ['standard'], grip: ['standard'], counter: ['standard'] });

const el = (tag, parent, text = '', className = '') => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  parent?.append(node);
  return node;
};
const glyph = (parent, name) => {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'vb-bench-glyph');
  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('d', GLYPHS[name]);
  svg.append(path);
  parent.append(svg);
  return svg;
};
const fmt = value => Math.round(value).toLocaleString('en-US');
const decimal = (value, digits = 2) => Number(value.toFixed(digits)).toString();
const titleCase = text => text.toLowerCase().replace(/(^|[\s-])([a-z])/g, (_, gap, letter) => gap + letter.toUpperCase());
const partNode = (slot, part) => PROGRESSION_TREE.find(n => n.kind === 'attachment' && n.slot === slot && n.part === part) || null;
const skinNodes = weapon => PROGRESSION_TREE.filter(n => n.kind === 'weaponSkin' && n.weapon === weapon);
const sameSetup = (a, b) => a.optic === b.optic && a.grip === b.grip && a.counter === b.counter;

/** One-sentence reason a reward is still closed, from the authoritative gate state. */
export function benchLockText(item, state) {
  if (state.blockedByParent) return `${item.name}: unlock ${treeNode(item.parent)?.name || 'the previous reward'} first.`;
  const open = state.requirements.filter(r => !r.complete);
  if (!open.length) return `${item.name}: unlocks on your next career update.`;
  return `${item.name}: ${open.map(r => r.label === 'Career level'
    ? `career level ${r.target} (${fmt(state.xpToGo)} XP to go)` : `${r.label} ${fmt(r.current)} / ${fmt(r.target)}`).join(' and ')}.`;
}

/** Short chip for a locked or next reward: `LV 18` first, then `ELITE · 180 / 1,000`. */
function lockChip(item, state) {
  const [level, gate] = state.requirements;
  if (!level.complete || !gate) return `LV ${item.level}`;
  const tier = MASTERY_TIERS.find(t => t.id === item.masteryTier);
  return `${tier ? tier.name : 'SCORE'} · ${fmt(gate.current)} / ${fmt(gate.target)}`;
}

/** The WEAPONS tab body: rail, skin/optic/grip/counter groups and a handling
 * readout in the shared inspector. Saves on select; never keeps drafts. */
export class WeaponBench {
  constructor({ panel, inspector, host }) {
    Object.assign(this, { panel, inspector, host });
    this.profile = host?.profile || null;
    this.weapon = 'rifle';
    this.pending = new Map();
    this.saveTimers = new Map();
    this.seqs = new Map();
    // Saves still waiting on the server, per weapon: until they settle, the confirmed setup may be overtaken.
    this.inflight = new Map();
    this.busy = new Set();
    // Writes whose answer another career request made stale: {weapon} saves and one skin.
    this.awaiting = new Set();
    this.awaitingSkin = null;
    this.previewKey = null;
    this.root = el('div', null, '', 'vb-bench');
    this.rail = el('nav', this.root, '', 'vb-bench-rail');
    this.rail.id = 'armory-weapon-rail';
    this.rail.setAttribute('aria-label', 'Weapons');
    this.railButtons = new Map();
    for (const weapon of WEAPON_IDS) {
      const button = el('button', this.rail, '', 'vb-bench-weapon');
      button.type = 'button';
      button.dataset.weapon = weapon;
      const icon = el('img', button, '', 'vb-bench-weapon-icon');
      icon.src = weaponImagePath(weapon); icon.alt = ''; icon.decoding = 'async';
      el('span', button, WEAPON_NAMES[weapon] || weapon.toUpperCase(), 'vb-bench-weapon-name');
      button.pip = el('span', button, '', 'vb-bench-pip');
      button.addEventListener('click', () => this.select(weapon));
      this.railButtons.set(weapon, button);
    }
    this.rail.addEventListener('keydown', event => this.railKey(event));
    this.options = el('div', this.root, '', 'vb-bench-options');
    this.title = el('h3', this.options, '', 'vb-bench-title');
    this.groups = el('div', this.options, '', 'vb-bench-groups');
    const footer = el('div', this.options, '', 'vb-bench-footer');
    this.factory = el('button', footer, 'FACTORY SETUP', 'vb-bench-factory');
    this.factory.type = 'button';
    this.factory.dataset.factory = '';
    this.factory.addEventListener('click', () => this.queueSave(this.weapon, normalizeAttachments(this.weapon)));
    el('p', footer, 'Setups apply when you join your next match.', 'vb-bench-note');
    // Preview follows hover and focus; leaving the option list returns to the saved setup.
    const hover = event => { const key = event.target?.closest?.('[data-focus-key]')?.dataset.focusKey; if (key) this.schedulePreview(key); };
    this.groups.addEventListener('pointerover', hover);
    this.groups.addEventListener('focusin', hover);
    this.groups.addEventListener('pointerleave', () => {
      this.schedulePreview(this.groups.contains(document.activeElement) ? document.activeElement.dataset?.focusKey || null : null);
    });
    this.groups.addEventListener('focusout', event => { if (!this.groups.contains(event.relatedTarget)) this.schedulePreview(null); });
    panel.replaceChildren(this.root);
    this.render();
    if (!panel.hidden) this.showPreview(null);
  }

  get active() { return !this.disposed && !this.panel.hidden; }
  unlocked(slot, part) { return (this.profile?.unlockedParts?.[slot] || STANDARD_PARTS[slot]).includes(part); }

  /** Last server-confirmed setup; a part that is locked now shows its legal fallback. */
  confirmed(weapon = this.weapon) {
    const saved = normalizeAttachments(weapon, normalizeWeaponLoadout(this.profile?.equipped?.weaponAttachments)[weapon]);
    const out = { ...saved };
    for (const { slot } of PART_GROUPS) if (!this.unlocked(slot, out[slot])) out[slot] = 'standard';
    return normalizeAttachments(weapon, out);
  }
  selection(weapon = this.weapon) { return this.pending.get(weapon) || this.confirmed(weapon); }
  skin(weapon = this.weapon) { return this.profile?.equipped?.weaponSkins?.[weapon] || 'standard'; }

  setProfile(profile) {
    if (this.disposed) return;
    this.profile = profile || null;
    this.stamp = (this.stamp || 0) + 1;
    this.confirmAwaiting();
    this.render();
    if (this.active) this.showPreview(this.previewKey);
  }

  /** A newer career answer settles writes whose own answer went stale: a save it
   * already contains is confirmed, one it predates is sent again; never a rollback. */
  confirmAwaiting() {
    if (!this.profile) return;
    for (const weapon of [...this.awaiting]) {
      this.awaiting.delete(weapon);
      const pending = this.pending.get(weapon);
      if (!pending || this.saveTimers.has(weapon)) continue;
      if (!sameSetup(pending, this.confirmed(weapon))) { this.flush(weapon); continue; }
      this.pending.delete(weapon);
      this.inspector?.setStatus(`${WEAPON_NAMES[weapon] || weapon} setup saved`);
    }
    const skin = this.awaitingSkin;
    this.awaitingSkin = null;
    if (skin && this.skin(skin.weapon) === skin.id)
      this.inspector?.setStatus(skin.item ? `${skin.item.name} equipped` : `${WEAPON_NAMES[skin.weapon] || skin.weapon} skin set to standard`);
  }

  /** `part` focuses that group; with `id` (a part or skin id) it lands on that option and previews it. */
  select(weapon = this.weapon, { part, id } = {}) {
    if (this.disposed) return;
    this.weapon = WEAPON_IDS.includes(weapon) ? weapon : 'rifle';
    clearTimeout(this.previewTimer);
    this.previewKey = null;
    this.render();
    if (!part) { this.showPreview(null); return; }
    const group = this.groups.querySelector(`[data-group="${part}"]`);
    const chosen = id ? group?.querySelector(`[data-focus-key="${part}:${id}"]`) : null;
    const target = chosen || group?.querySelector('[aria-pressed="true"]') || group?.querySelector('button');
    this.showPreview(chosen ? chosen.dataset.focusKey : null);
    target?.focus?.();
    target?.scrollIntoView?.({ block: 'nearest' });
  }

  railKey(event) {
    const order = [...this.railButtons.values()];
    const at = order.indexOf(event.target?.closest?.('[data-weapon]'));
    if (at < 0) return;
    const next = { ArrowDown: at + 1, ArrowRight: at + 1, ArrowUp: at - 1, ArrowLeft: at - 1, Home: 0, End: order.length - 1 }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    const target = order[(next + order.length) % order.length];
    for (const button of order) button.tabIndex = button === target ? 0 : -1;
    target.focus();
  }

  render() {
    const weapon = this.weapon, tracks = this.profile ? masteryTracks(this.profile) : [];
    for (const [id, button] of this.railButtons) {
      const pressed = id === weapon;
      button.setAttribute('aria-pressed', String(pressed));
      button.tabIndex = pressed ? 0 : -1;
      const track = tracks.find(t => t.weapon === id), tier = MASTERY_TIERS[track?.tier ?? -1];
      button.pip.textContent = tier ? tier.numeral : '';
      button.pip.hidden = !tier;
      if (tier) {
        button.pip.style.setProperty('--tier-color', tier.color);
        button.pip.title = `Mastery ${tier.name}`;
      }
      // A weapon whose new skin waits on another rail entry carries the NEW dot too.
      const fresh = skinNodes(id).filter(item => this.host?.isNew?.(item.id)).map(item => item.id);
      if (fresh.length) { button.dataset.new = id; button.newIds = fresh; } else { button.removeAttribute('data-new'); button.newIds = null; }
      button.setAttribute('aria-label', `${WEAPON_NAMES[id] || id}${tier ? `, mastery ${tier.name}` : ''}${fresh.length ? ', new skin' : ''}`);
    }
    this.title.textContent = WEAPON_NAMES[weapon] || weapon.toUpperCase();
    const focusKey = this.groups.contains(document.activeElement) ? document.activeElement.dataset?.focusKey : null;
    this.groups.replaceChildren();
    this.renderSkins(weapon);
    const selection = this.selection(weapon), pending = this.pending.has(weapon);
    for (const group of PART_GROUPS) this.renderParts(weapon, group, selection, pending);
    if (focusKey) this.groups.querySelector(`[data-focus-key="${focusKey}"]`)?.focus?.({ preventScroll: true });
  }

  group(id, label) {
    const section = el('section', this.groups, '', 'vb-bench-group');
    section.dataset.group = id;
    const heading = el('h4', section, label);
    heading.id = `armory-bench-${id}-title`;
    const list = el('div', section, '', 'vb-bench-list');
    list.setAttribute('role', 'group');
    list.setAttribute('aria-labelledby', heading.id);
    return { section, list };
  }

  option(list, key, name, detail, { pressed, state, chip, chipGlyph, locked, fresh = null, seenChip = '' }) {
    const button = el('button', list, '', 'vb-bench-option');
    button.type = 'button';
    button.dataset.focusKey = key;
    button.dataset.state = state;
    button.setAttribute('aria-pressed', String(!!pressed));
    if (locked) { button.dataset.locked = 'true'; button.setAttribute('aria-disabled', 'true'); }
    if (this.busy.has(key)) button.setAttribute('aria-busy', 'true');
    el('span', button, name, 'vb-bench-option-name');
    if (detail) el('span', button, detail, 'vb-bench-option-detail');
    const setChip = (text, name) => {
      button.querySelector('.vb-bench-chip')?.remove();
      if (!text) return;
      const tag = el('span', button, '', 'vb-bench-chip');
      if (name) glyph(tag, name);
      el('span', tag, text);
    };
    // An owned reward the player has not seen yet: dot plus NEW chip until the host marks it seen.
    if (fresh) {
      button.dataset.new = fresh;
      if (!pressed) { chip = 'NEW'; chipGlyph = 'new'; }
      button.onSeen = () => { if (!pressed) setChip(seenChip, seenChip && 'check'); };
    }
    setChip(chip, chipGlyph);
    return button;
  }

  /** Previewing or choosing an owned reward counts as seeing it. */
  seen(item) {
    if (item && careerItemState(this.profile, item).owned) this.host?.markSeen?.(item.id);
  }

  renderSkins(weapon) {
    const { section, list } = this.group('skin', 'SKIN');
    const skins = skinNodes(weapon);
    if (!skins.length) {
      list.remove();
      el('p', section, 'No skins for this weapon yet. Mastery rewards: see MASTERY.', 'vb-bench-fixed');
      return;
    }
    const current = this.skin(weapon);
    const standard = this.option(list, 'skin:standard', 'Standard', 'Factory finish.', {
      pressed: current === 'standard', state: current === 'standard' ? 'equipped' : 'owned',
      chip: current === 'standard' ? 'EQUIPPED' : '', chipGlyph: 'check' });
    standard.dataset.skinOption = 'standard';
    standard.addEventListener('click', () => this.chooseSkin('standard', standard));
    for (const item of skins) {
      const state = careerItemState(this.profile, item);
      const open = state.status === 'equipped' || state.status === 'owned';
      const button = this.option(list, `skin:${item.id}`, item.name, item.detail, {
        pressed: state.status === 'equipped', state: state.status, locked: !open,
        chip: state.status === 'equipped' ? 'EQUIPPED' : open ? 'UNLOCKED' : lockChip(item, state),
        chipGlyph: open ? 'check' : 'lock', fresh: open && this.host?.isNew?.(item.id) ? item.id : null, seenChip: 'UNLOCKED' });
      button.dataset.skinOption = item.id;
      button.addEventListener('click', () => this.chooseSkin(item.id, button));
    }
  }

  renderParts(weapon, { slot, label, catalog, list: listKey }, selection, pending) {
    const { section, list } = this.group(slot, label);
    const ids = ATTACHMENT_SLOTS[weapon][listKey];
    for (const id of ids) {
      const part = catalog[id], locked = !this.unlocked(slot, id), reward = partNode(slot, id), gate = locked ? reward : null;
      const pressed = selection[slot] === id;
      const button = this.option(list, `${slot}:${id}`, part.name, part.detail, {
        pressed, locked, state: locked ? (gate && careerItemState(this.profile, gate).status === 'next' ? 'next' : 'locked') : pressed ? 'equipped' : 'owned',
        chip: locked ? `LV ${gate?.level ?? '?'}` : pressed ? (pending ? 'SAVING' : 'EQUIPPED') : '',
        chipGlyph: locked ? 'lock' : 'check', fresh: !locked && reward && this.host?.isNew?.(reward.id) ? reward.id : null });
      button.dataset[slot] = id;
      button.addEventListener('click', () => this.choosePart(slot, id));
    }
    if (slot === 'counter') {
      const record = this.profile?.mastery?.[weapon] || {};
      el('p', section, `${fmt(record.kills || 0)} HUMAN KILLS · ${fmt(record.headshots || 0)} HEADSHOTS ETCHED ON THIS WEAPON.`, 'vb-bench-fixed');
    } else if (ids.length === 1) el('p', section, 'This weapon uses its fixed factory mount.', 'vb-bench-fixed');
  }

  choosePart(slot, part) {
    const weapon = this.weapon;
    if (this.unlocked(slot, part)) this.seen(partNode(slot, part));
    else {
      const gate = partNode(slot, part);
      this.inspector?.setStatus(gate ? benchLockText(gate, careerItemState(this.profile, gate)) : 'This part is locked.');
      return;
    }
    if (this.selection(weapon)[slot] === part) return;
    this.queueSave(weapon, normalizeAttachments(weapon, { ...this.selection(weapon), [slot]: part }));
  }

  /** Optimistic: pressed state changes now, the POST goes out after a quiet window. */
  queueSave(weapon, attachments) {
    if (this.disposed) return;
    if (!this.profile) { this.inspector?.setStatus('Loading your career...'); return; }
    if (sameSetup(attachments, this.selection(weapon)) && !this.saveTimers.has(weapon)) return;
    this.pending.set(weapon, attachments);
    clearTimeout(this.saveTimers.get(weapon));
    this.saveTimers.set(weapon, setTimeout(() => this.flush(weapon), BENCH_SAVE_DELAY));
    this.render();
    if (this.active) this.showPreview(this.previewKey);
  }

  async flush(weapon, { quiet = false } = {}) {
    clearTimeout(this.saveTimers.get(weapon));
    this.saveTimers.delete(weapon);
    const attachments = this.pending.get(weapon);
    if (!attachments) return;
    const seq = (this.seqs.get(weapon) || 0) + 1;
    this.seqs.set(weapon, seq);
    // An older response never overrides a newer choice, success or failure.
    const latest = () => !this.disposed && !quiet && this.seqs.get(weapon) === seq && !this.saveTimers.has(weapon);
    // Matching the confirmed setup needs no request, unless an earlier save could still replace it.
    if (sameSetup(attachments, this.confirmed(weapon)) && !this.inflight.get(weapon)) {
      if (latest()) { this.pending.delete(weapon); this.render(); }
      return;
    }
    const stamp = this.stamp;
    this.inflight.set(weapon, (this.inflight.get(weapon) || 0) + 1);
    try {
      let profile;
      try { profile = await this.host.saveAttachments(weapon, attachments); }
      finally {
        const left = this.inflight.get(weapon) - 1;
        if (left > 0) this.inflight.set(weapon, left); else this.inflight.delete(weapon);
      }
      if (!latest()) return;
      // Stale (another career request overlapped): keep the pick until the newer answer lands,
      // or settle it now if that answer already arrived.
      if (!profile) { this.awaiting.add(weapon); if (this.stamp !== stamp) this.confirmAwaiting(); return; }
      this.pending.delete(weapon);
      this.setProfile(profile);
      this.inspector?.setStatus(`${WEAPON_NAMES[weapon] || weapon} setup saved`);
    } catch (error) {
      if (!latest()) return;
      this.pending.delete(weapon);
      this.setProfile(this.profile);
      this.inspector?.setStatus(error?.message || 'Could not save. Try again.', 'error');
    }
  }

  async chooseSkin(id, button) {
    const weapon = this.weapon, key = `skin:${id}`;
    if (this.busy.has(key)) return;
    const item = id === 'standard' ? null : treeNode(id);
    this.seen(item);
    if (item) {
      const state = careerItemState(this.profile, item);
      if (state.locked || !state.owned) { this.inspector?.setStatus(benchLockText(item, state)); return; }
      if (state.equipped) return;
    } else if (this.skin(weapon) === 'standard') return;
    this.busy.add(key);
    button.setAttribute('aria-busy', 'true');
    const stamp = this.stamp;
    try {
      const profile = item ? await this.host.request(id, true) : await this.host.request('standard', true, { slot: 'weaponSkin', weapon });
      if (this.disposed) return;
      // Stale: the newer answer (a bench save) reports the skin once it shows it.
      if (!profile) { this.awaitingSkin = { weapon, id, item }; if (this.stamp !== stamp) this.confirmAwaiting(); return; }
      this.setProfile(profile);
      this.inspector?.setStatus(item ? `${item.name} equipped` : `${WEAPON_NAMES[weapon] || weapon} skin set to standard`);
    } catch (error) {
      if (!this.disposed) this.inspector?.setStatus(error?.message || 'Could not equip. Try again.', 'error');
    } finally {
      this.busy.delete(key);
      button.removeAttribute('aria-busy');
      if (!this.disposed) this.render();
    }
  }

  schedulePreview(key) {
    clearTimeout(this.previewTimer);
    this.previewTimer = setTimeout(() => this.showPreview(key), PREVIEW_DELAY);
  }

  /** The weapon in 3D with the hovered or focused option applied; `null` shows the chosen setup. */
  showPreview(key) {
    if (this.disposed || !this.inspector) return;
    this.previewKey = key;
    const weapon = this.weapon, selection = this.selection(weapon);
    let skin = this.skin(weapon), attachments = selection, previewing = '';
    const [slot, id] = key ? key.split(':') : [];
    if (slot) this.seen(slot === 'skin' ? treeNode(id) : partNode(slot, id));
    if (slot === 'skin' && id !== skin) { skin = id; previewing = id === 'standard' ? 'Standard' : treeNode(id)?.name || id; }
    else if (slot && slot !== 'skin' && selection[slot] !== id) {
      attachments = normalizeAttachments(weapon, { ...selection, [slot]: id });
      previewing = PART_GROUPS.find(g => g.slot === slot)?.catalog[id]?.name || id;
    }
    const skinName = skin === 'standard' ? 'Standard' : treeNode(skin)?.name || skin;
    this.inspector.showWeapon({
      weapon, skin, attachments, mastery: this.profile?.mastery || {},
      title: WEAPON_NAMES[weapon] || weapon.toUpperCase(),
      kicker: previewing ? `PREVIEW / ${previewing.toUpperCase()}` : 'WEAPONS / SETUP',
      detail: `${skinName} skin · ${OPTICS[attachments.optic].name} · ${GRIPS[attachments.grip].name} · ${COUNTERS[attachments.counter].name}.`,
      extra: this.inspectBlock(weapon, attachments),
    });
  }

  /** HANDLING against the equipped setup, plus the weapon's MASTERY line. */
  inspectBlock(weapon, attachments) {
    const block = el('div', null, '', 'vb-bench-inspect');
    const handling = el('section', block, '', 'vb-bench-handling');
    el('h4', handling, 'HANDLING');
    const def = weaponWithAttachments(WEAPONS[weapon], attachments), h = def.handling;
    const equipped = weaponWithAttachments(WEAPONS[weapon], this.confirmed(weapon)).handling;
    for (const metric of METRICS) {
      const value = metric.read(h), delta = value - metric.read(equipped);
      const tone = Math.abs(delta) < 1e-4 ? 'same' : (delta > 0) === metric.higher ? 'better' : 'worse';
      const row = el('div', handling, '', 'vb-bench-stat');
      row.dataset.delta = tone;
      el('span', row, metric.label, 'vb-bench-stat-label');
      el('strong', row, decimal(value) + metric.unit, 'vb-bench-stat-value');
      const change = el('span', row, '', 'vb-bench-delta');
      change.dataset.delta = tone;
      glyph(change, tone === 'same' ? 'same' : delta > 0 ? 'up' : 'down');
      const word = tone === 'same' ? 'SAME' : `${tone.toUpperCase()} ${delta > 0 ? '+' : ''}${decimal(delta)}${metric.unit}`;
      el('span', change, word);
      const meter = el('meter', row, '', 'vb-bench-meter');
      meter.min = 0; meter.max = metric.max; meter.value = value;
      meter.setAttribute('aria-label', metric.label);
      meter.setAttribute('aria-valuetext', `${decimal(value)}${metric.unit}, ${tone === 'same' ? 'same as equipped' : `${tone} than equipped`}`);
    }
    el('p', handling, `TURN CEILING ${Math.round(weaponTurnProfile(h).maxSpeed * 180 / Math.PI)}°/S · ZOOM ${decimal(def.zoom || 1)}×`, 'vb-bench-turn');
    const mastery = el('section', block, '', 'vb-bench-mastery');
    el('h4', mastery, 'MASTERY');
    const track = this.profile ? masteryTracks(this.profile).find(t => t.weapon === weapon) : null;
    const badge = track?.badge || weapon.toUpperCase();
    el('p', mastery, `${badge} · ${fmt(track?.kills || 0)} human · ${fmt(track?.botKills || 0)} bot · ${fmt(track?.headshots || 0)} headshots`, 'vb-bench-mastery-record');
    const score = track?.score || 0, next = track ? track.next : MASTERY_TIERS[0] && { id: MASTERY_TIERS[0].id, score: MASTERY_TIERS[0].score, reward: `mastery-${weapon}-1` };
    const tier = MASTERY_TIERS[track?.tier ?? -1];
    const meter = el('meter', mastery, '', 'vb-bench-meter vb-bench-tier');
    meter.min = 0; meter.max = next ? next.score : 1; meter.value = next ? Math.min(score, next.score) : 1;
    meter.setAttribute('aria-label', `${titleCase(badge)} mastery`);
    if (tier) meter.style.setProperty('--tier-color', tier.color);
    const nextTier = next && MASTERY_TIERS.find(t => t.id === next.id);
    meter.setAttribute('aria-valuetext', next ? `${fmt(score)} of ${fmt(next.score)} score to ${nextTier?.name || next.id}` : `${fmt(score)} score, every tier earned`);
    el('p', mastery, next ? `NEXT: ${treeNode(next.reward)?.name || nextTier?.name} · ${fmt(score)} / ${fmt(next.score)}`
      : `${tier?.name || 'MASTER'} · every tier earned · ${fmt(score)} score`, 'vb-bench-next');
    return block;
  }

  dispose() {
    if (this.disposed) return;
    // A choice made in the last quiet window is still sent; its answer updates nothing.
    for (const weapon of [...this.saveTimers.keys()]) this.flush(weapon, { quiet: true }).catch(() => {});
    this.disposed = true;
    clearTimeout(this.previewTimer);
    this.root.remove();
  }
}
