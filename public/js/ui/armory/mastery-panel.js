// MASTERY: one ladder per weapon, arsenal rewards and the long combat chase.
import { MASTERY_RULES_TEXT, MASTERY_TIERS, PROGRESSION_TREE, careerItemState, combatScore, treeNode } from '../../../../shared/career.js';
import { weaponImagePath } from '../hud-support.js';
import { format, masteryCards, tileState } from './armory-model.js';
import { art, bar, button, glyph, node } from './inspector.js';
import { focusKey, restoreFocus, rovingKeys, rovingSync } from './focus-nav.js';

const ARSENAL = PROGRESSION_TREE.filter(item => item.arsenal);
const CHASE = PROGRESSION_TREE.filter(item => item.combatScore);

export class MasteryPanel {
  constructor(panel, host) {
    this.panel = panel;
    this.host = host;
    this.sort = 'closest';
    this.expanded = null;
    node('p', panel, MASTERY_RULES_TEXT, 'vb-mastery-rules');
    this.arsenal = node('section', panel, '', 'vb-arsenal');
    const sort = node('div', panel, '', 'vb-mastery-sort');
    sort.setAttribute('role', 'group');
    sort.setAttribute('aria-label', 'Sort weapons');
    this.sortButtons = [['closest', 'CLOSEST TO NEXT TIER'], ['all', 'ALL WEAPONS']].map(([id, label]) => {
      const control = button(sort, label, 'vb-mastery-sort-button', () => { this.sort = id; this.render(); });
      control.dataset.masterySort = id;
      control.dataset.focusKey = `sort:${id}`;
      return control;
    });
    this.grid = node('ul', panel, '', 'vb-mastery-grid');
    this.grid.id = 'armory-mastery-grid';
    this.grid.setAttribute('aria-label', 'Weapon mastery');
    rovingKeys(this.grid, '.vb-mastery-card');
    this.detail = node('section', panel, '', 'vb-mastery-detail');
    this.detail.id = 'armory-mastery-detail';
    this.detail.hidden = true;
    // Tiles inspect; owned ones equip through #armory-action.
    panel.addEventListener('click', event => {
      const tile = event.target.closest?.('[data-mastery-node]');
      if (tile) host.inspector.inspect(tile.dataset.masteryNode, { pin: true, reveal: true });
    });
    panel.addEventListener('pointerover', event => {
      const tile = event.target.closest?.('[data-mastery-node]');
      if (tile) host.inspector.preview(tile.dataset.masteryNode);
    });
    // Leaving the arsenal list or a ladder reverts to the pinned target.
    for (const list of [this.arsenal, this.detail]) {
      list.addEventListener('pointerleave', () => host.inspector.revert());
      list.addEventListener('focusout', event => {
        if (!event.relatedTarget || !list.contains(event.relatedTarget)) host.inspector.revert();
      });
    }
  }

  get profile() { return this.host.profile; }

  render() {
    const profile = this.profile;
    if (!profile) return;
    const key = focusKey(this.panel);
    for (const control of this.sortButtons) control.setAttribute('aria-pressed', String(control.dataset.masterySort === this.sort));
    this.renderArsenal(profile);
    this.renderGrid(profile);
    this.renderDetail(profile);
    restoreFocus(this.panel, key);
  }

  renderArsenal(profile) {
    this.arsenal.replaceChildren();
    node('h3', this.arsenal, 'ARSENAL');
    const list = node('ul', this.arsenal, '', 'vb-arsenal-list');
    for (const item of [...ARSENAL, ...CHASE]) {
      const tile = tileState(profile, item.id);
      const requirement = careerItemState(profile, item).requirements[1];
      const row = node('li', list, '', 'vb-arsenal-row');
      const control = button(row, '', 'vb-arsenal-tile');
      control.dataset.masteryNode = item.id;
      control.dataset.state = tile.state;
      control.dataset.focusKey = `mastery-node:${item.id}`;
      if (this.host.isNew(item.id)) control.dataset.new = item.id;
      art(control, item, 'thumb');
      const copy = node('span', control, '', 'vb-arsenal-copy');
      node('strong', copy, item.name);
      const line = item.arsenal
        ? `${format(requirement.current)} / ${format(requirement.target)} WEAPONS AT ${MASTERY_TIERS.find(tier => tier.id === item.arsenal.tier).name}`
        : `COMBAT SCORE ${format(combatScore(profile))} / ${format(item.combatScore)}`;
      node('span', copy, line, 'vb-arsenal-line');
      bar(copy, requirement.current, requirement.target, `${item.name}: ${format(requirement.current)} of ${format(requirement.target)}`);
      stateTag(control, tile, true);
    }
  }

  renderGrid(profile) {
    this.grid.replaceChildren();
    for (const card of masteryCards(profile, this.sort)) {
      const item = node('li', this.grid, '', 'vb-mastery-item');
      const control = button(item, '', 'vb-mastery-card', () => this.toggle(card.weapon));
      control.dataset.weaponMastery = card.weapon;
      control.dataset.focusKey = `mastery:${card.weapon}`;
      control.setAttribute('aria-expanded', String(this.expanded === card.weapon));
      control.setAttribute('aria-controls', 'armory-mastery-detail');
      const fresh = card.rewards.filter(reward => this.host.isNew(reward.id)).map(reward => reward.id);
      if (fresh.length) { control.dataset.new = card.weapon; control.newIds = fresh; }
      const icon = node('img', control, '', 'vb-mastery-icon');
      icon.src = weaponImagePath(card.weapon);
      icon.alt = '';
      icon.loading = 'lazy';
      const copy = node('span', control, '', 'vb-mastery-copy');
      node('strong', copy, card.name, 'vb-mastery-name');
      const pips = node('span', copy, '', 'vb-mastery-pips');
      for (const tier of card.tiers) {
        const pip = node('span', pips, tier.numeral, 'vb-mastery-pip');
        pip.dataset.reached = String(tier.reached);
        pip.style.setProperty('--tier-color', tier.color);
        pip.setAttribute('title', `${tier.name}${tier.reached ? ' reached' : ''}`);
      }
      node('span', pips, `, ${card.tierId ? MASTERY_TIERS[card.tier].name : 'no tier yet'}`, 'vb-sr');
      const target = card.next?.score ?? MASTERY_TIERS.at(-1).score;
      node('span', copy, card.next ? `${format(card.score)} / ${format(target)} SCORE` : `${format(card.score)} SCORE · MASTER`, 'vb-mastery-score');
      bar(copy, card.score, target, `${card.name}: ${format(card.score)} of ${format(target)} mastery score`);
      node('span', copy, card.nextReward ? `NEXT: ${card.nextReward.name}` : 'ALL TIERS COMPLETE', 'vb-mastery-next');
    }
    rovingSync(this.grid, '.vb-mastery-card', this.expanded ? this.grid.querySelector(`[data-weapon-mastery=${this.expanded}]`) : null);
  }

  toggle(weapon) {
    this.expanded = this.expanded === weapon ? null : weapon;
    this.render();
    if (this.expanded) {
      const card = masteryCards(this.profile, 'all').find(entry => entry.weapon === weapon);
      this.host.inspector.inspect(card.next?.reward || card.rewards.at(-1)?.id, { pin: true });
    }
  }

  /** Deep link: expand one weapon's ladder and scroll it into view. */
  show(weapon) {
    this.expanded = weapon;
    this.render();
    this.detail.scrollIntoView?.({ block: 'nearest', behavior: 'instant' });
  }

  renderDetail(profile) {
    this.detail.replaceChildren();
    const card = this.expanded && masteryCards(profile, 'all').find(entry => entry.weapon === this.expanded);
    this.detail.hidden = !card;
    if (!card) return;
    node('h3', this.detail, `${card.name} MASTERY`);
    const ladder = node('ol', this.detail, '', 'vb-mastery-ladder');
    MASTERY_TIERS.forEach((tier, at) => {
      const row = node('li', ladder, '', 'vb-mastery-tier');
      row.dataset.tier = tier.id;
      row.dataset.reached = String(card.tier >= at);
      row.style.setProperty('--tier-color', tier.color);
      const head = node('div', row, '', 'vb-mastery-tier-head');
      node('h4', head, `${tier.numeral} · ${tier.name}`);
      node('span', head, `${format(tier.score)} SCORE`, 'vb-mastery-threshold');
      const tiles = node('div', row, '', 'vb-mastery-tiles');
      const rewards = card.rewards.filter(reward => reward.tierId === tier.id);
      for (const reward of rewards) {
        const item = treeNode(reward.id);
        const tile = tileState(profile, reward.id);
        const control = button(tiles, '', 'vb-mastery-tile');
        control.dataset.masteryNode = reward.id;
        control.dataset.state = tile.state;
        control.dataset.focusKey = `mastery-node:${reward.id}`;
        if (this.host.isNew(reward.id)) control.dataset.new = reward.id;
        art(control, item, 'thumb');
        node('span', control, item.name, 'vb-mastery-tile-name');
        stateTag(control, tile);
      }
    });
    const stats = node('dl', this.detail, '', 'vb-mastery-stats');
    for (const [label, value] of [['HUMAN KILLS', card.kills], ['BOT KILLS', card.botKills], ['HEADSHOTS', card.headshots], ['SCORE', card.score]]) {
      const entry = node('div', stats);
      node('dt', entry, label);
      node('dd', entry, format(value));
    }
    const tune = button(this.detail, 'TUNE IN WEAPONS', 'vb-btn', () => this.host.open({ tab: 'weapons', weapon: card.weapon }));
    tune.dataset.openWeapon = card.weapon;
  }
}

/** State glyph plus word; `plain` tiles already print their progress line. */
function stateTag(parent, tile, plain = false) {
  const tag = node('span', parent, '', 'vb-armory-chip');
  const open = tile.state === 'owned' || tile.state === 'equipped';
  glyph(tag, tile.state === 'equipped' ? 'equipped' : open ? 'owned' : tile.state);
  const closed = plain ? (tile.state === 'next' ? 'NEXT UP' : 'LOCKED') : tile.chip || 'LOCKED';
  node('span', tag, tile.state === 'equipped' ? 'EQUIPPED' : open ? 'UNLOCKED' : closed);
  return tag;
}

