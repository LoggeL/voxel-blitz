// PROGRESS: next goals, the level journey and the unlock tree drawn as a tree.
import {
  CAREER_REWARDS, CAREER_REWARD_RULES, KIND_LABELS, MASTERY_TIERS, PROGRESSION_TREE, legacyCareerLevel, nextGoals, treeNode, upcomingUnlocks,
} from '../../../../shared/career.js';
import { LEVEL_BRANCHES, badgeName, branchLanes, format, journey, levelTrack, tileState } from './armory-model.js';
import { art, bar, button, glyph, node } from './inspector.js';
import { focusKey, restoreFocus, rovingSync, treeKeys } from './focus-nav.js';

const FILTERS = [['all', 'ALL'], ...LEVEL_BRANCHES.map(branch => [branch.id, branch.name])];
const TREE_STATE = { equipped: 'unlocked', owned: 'unlocked', next: 'next', locked: 'locked' };

export class ProgressPanel {
  constructor(panel, host) {
    this.panel = panel;
    this.host = host;
    this.filter = null;
    this.goals = node('section', panel, '', 'vb-armory-goals');
    this.intro = node('section', panel, '', 'vb-armory-intro');
    this.intro.hidden = true;
    this.journey = node('section', panel, '', 'vb-armory-journey');
    this.treeSection = node('section', panel, '', 'vb-armory-tree');
    node('h3', this.treeSection, 'UNLOCK TREE');
    this.filters = node('div', this.treeSection, '', 'vb-tree-filters');
    this.filters.setAttribute('role', 'group');
    this.filters.setAttribute('aria-label', 'Tree branches');
    for (const [id, label] of FILTERS) {
      const control = button(this.filters, label, 'vb-tree-filter', () => this.setFilter(id));
      control.dataset.filter = id;
      control.dataset.focusKey = `filter:${id}`;
    }
    this.summary = node('p', this.treeSection, '', 'vb-tree-summary');
    this.tree = node('div', this.treeSection, '', 'vb-tree');
    this.tree.id = 'progression-tree';
    treeKeys(this.tree, { onMove: item => this.host.inspector.preview(item.dataset.treeNode) });
    this.tree.addEventListener('click', event => {
      const item = event.target.closest?.('[role=treeitem]');
      if (item) this.selectNode(item.dataset.treeNode, { from: item });
    });
    this.tree.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const item = event.target.closest?.('[role=treeitem]');
      if (!item || item !== event.target) return;
      event.preventDefault();
      this.selectNode(item.dataset.treeNode, { from: item });
    });
    this.tree.addEventListener('pointerover', event => {
      const item = event.target.closest?.('[role=treeitem]');
      if (item) this.host.inspector.preview(item.dataset.treeNode);
    });
    this.tree.addEventListener('pointerleave', () => this.host.inspector.revert());
    const earn = node('details', panel, '', 'vb-armory-earn');
    node('summary', earn, 'HOW TO EARN XP');
    const table = node('table', earn, '', 'vb-armory-earn-table');
    const body = node('tbody', table);
    for (const rule of CAREER_REWARD_RULES) {
      const row = node('tr', body);
      row.dataset.reward = rule.id;
      node('th', row, rule.label).setAttribute('scope', 'row');
      node('td', row, `+${format(CAREER_REWARDS[rule.id].xp)} XP`);
    }
    node('p', earn, 'Training does not award XP. Every reward unlocks automatically once its requirements and the reward before it are complete.', 'vb-armory-earn-note');
    node('p', panel, 'Cosmetics never change combat stats. Nothing is bought.', 'vb-armory-fairness');
  }

  get profile() { return this.host.profile; }

  /** Mobile shows one branch, defaulting to the branch of the top upcoming unlock. */
  defaultFilter() {
    if (!this.host.mobile) return 'all';
    return upcomingUnlocks(this.profile, 1)[0]?.branch || 'all';
  }

  setFilter(id) {
    this.filter = id;
    const key = focusKey(this.panel);
    this.renderTree();
    restoreFocus(this.panel, key);
  }

  render() {
    const profile = this.profile;
    if (!profile) return;
    this.filter ??= this.defaultFilter();
    const key = focusKey(this.panel);
    this.renderGoals(profile);
    this.renderIntro(profile);
    this.renderJourney(profile);
    this.renderTree();
    restoreFocus(this.panel, key);
  }

  renderGoals(profile) {
    this.goals.replaceChildren();
    const header = node('div', this.goals, '', 'vb-armory-section-head');
    node('h3', header, 'NEXT UP');
    if (this.host.newIds().length) {
      const mark = button(header, 'MARK ALL SEEN', 'vb-armory-link', () => { this.host.markAllSeen(); this.settleFocus(); });
      mark.dataset.markSeen = 'goals';
      mark.dataset.focusKey = 'mark-seen';
    }
    const goals = nextGoals(profile);
    if (!goals.length) { node('p', this.goals, 'Every reward is unlocked.', 'vb-armory-empty'); return; }
    const list = node('ol', this.goals, '', 'vb-armory-goal-list');
    for (const goal of goals) {
      const item = treeNode(goal.id);
      const card = button(node('li', list), '', 'vb-goal-card', () => this.host.jumpTo(goal.id));
      card.dataset.goal = goal.type;
      card.dataset.target = goal.id;
      card.dataset.focusKey = `goal:${goal.type}`;
      art(card, item, 'thumb');
      const copy = node('span', card, '', 'vb-goal-copy');
      node('span', copy, goal.type === 'level' ? 'NEXT LEVEL REWARD' : goal.type === 'mastery' ? 'CLOSEST MASTERY TIER' : 'LONG CHASE', 'vb-goal-kicker');
      node('strong', copy, item?.name || goal.id, 'vb-goal-name');
      const line = goalLine(goal, item);
      node('span', copy, line, 'vb-goal-line');
      bar(copy, goal.current, goal.target, goalValueText(goal, item), 'vb-armory-bar vb-goal-bar');
    }
  }

  renderIntro(profile) {
    const store = this.host.seen;
    this.intro.replaceChildren();
    this.intro.hidden = !store?.showIntro;
    if (this.intro.hidden) return;
    const fresh = this.host.newIds().length;
    node('h3', this.intro, 'ARMORY UPGRADED');
    node('p', this.intro, fresh ? `${fresh} new reward${fresh === 1 ? ' is' : 's are'} waiting.` : 'Your rewards are all marked seen.');
    const legacy = legacyCareerLevel(profile.xp);
    if (legacy !== profile.level) node('p', this.intro, `Your level was recalculated: ${legacy} → ${profile.level}.`, 'vb-armory-intro-level');
    const actions = node('div', this.intro, '', 'vb-armory-intro-actions');
    if (fresh) {
      const mark = button(actions, 'MARK ALL SEEN', 'vb-btn', () => {
        this.host.markAllSeen();
        // The button is gone after the re-render; GOT IT is the next step.
        const next = this.intro.hidden ? null : this.intro.querySelector('[data-dismiss-intro]');
        if (next) next.focus({ preventScroll: true }); else this.settleFocus();
      });
      mark.dataset.markSeen = 'intro';
    }
    const done = button(actions, 'GOT IT', 'vb-btn', () => { store.dismissIntro(); this.intro.hidden = true; this.settleFocus(); });
    done.dataset.dismissIntro = '';
    done.dataset.focusKey = 'dismiss-intro';
  }

  /** A control that removed itself hands focus to a stable target: the first goal, else the tab. */
  settleFocus() {
    const target = this.goals.querySelector('.vb-goal-card') || this.host.tabs?.progress;
    target?.focus({ preventScroll: true });
  }

  renderJourney(profile) {
    this.journey.replaceChildren();
    node('h3', this.journey, 'LEVEL JOURNEY');
    const model = journey(profile);
    const stars = model.stars ? ` ★${model.stars}` : '';
    if (model.complete) {
      node('p', this.journey, `ALL LEVEL REWARDS UNLOCKED · LEVEL ${model.level}${stars}`, 'vb-journey-complete');
      return;
    }
    const list = node('ol', this.journey, '', 'vb-journey');
    const you = node('li', list, '', 'vb-journey-you');
    node('span', you, `YOU · LV ${model.level}${stars}`, 'vb-journey-label');
    bar(you, Math.round(model.progress * 100), 100, `${format(profile.xp - profile.levelStart)} of ${format(profile.nextLevel - profile.levelStart)} XP to level ${profile.level + 1}`,
      'vb-armory-bar vb-journey-bar');
    for (const stop of model.stops) {
      const row = node('li', list, '', 'vb-journey-stop');
      row.dataset.level = String(stop.level);
      const circle = node('span', row, String(stop.level), 'vb-journey-level');
      circle.setAttribute('aria-label', `Level ${stop.level}`);
      node('span', row, `${format(stop.xpToGo)} XP AWAY`, 'vb-journey-away');
      const chips = node('div', row, '', 'vb-journey-chips');
      for (const id of stop.items) {
        const item = treeNode(id);
        const chip = button(chips, '', 'vb-journey-chip', () => this.host.jumpTo(id));
        chip.dataset.journey = id;
        chip.dataset.focusKey = `journey:${id}`;
        art(chip, item, 'thumb');
        node('span', chip, item.name);
        node('span', chip, `, ${KIND_LABELS[item.kind].toLowerCase()}, level ${stop.level}`, 'vb-sr');
      }
    }
  }

  renderTree() {
    const profile = this.profile;
    if (!profile) return;
    const filter = this.filter || 'all';
    for (const control of this.filters.children) control.setAttribute('aria-pressed', String(control.dataset.filter === filter));
    const upcoming = new Set(upcomingUnlocks(profile, 3).map(item => item.id));
    const branches = LEVEL_BRANCHES.filter(branch => filter === 'all' || branch.id === filter);
    const visible = PROGRESSION_TREE.filter(item => branches.some(branch => branch.id === item.branch));
    const unlocked = visible.filter(item => tileState(profile, item.id).owned).length;
    this.summary.textContent = `${unlocked} / ${visible.length} UNLOCKED`;
    this.tree.replaceChildren();
    for (const branch of branches) {
      const items = PROGRESSION_TREE.filter(item => item.branch === branch.id);
      const section = node('section', this.tree, '', 'vb-tree-branch');
      section.dataset.branch = branch.id;
      const heading = node('h4', section, branch.name);
      heading.id = `tree-branch-${branch.id}`;
      section.setAttribute('aria-labelledby', heading.id);
      const owned = items.filter(item => tileState(profile, item.id).owned).length;
      node('p', section, `${owned} of ${items.length} unlocked · ${branch.detail}`, 'vb-tree-branch-progress');
      const tree = node('ul', section, '', 'vb-tree-lanes');
      tree.setAttribute('role', 'tree');
      tree.setAttribute('aria-label', `${branch.name[0]}${branch.name.slice(1).toLowerCase()} unlock tree`);
      for (const lane of branchLanes(branch.id)) this.renderLane(tree, lane, 1, upcoming, profile);
    }
    rovingSync(this.tree, '[role=treeitem]', this.selected ? this.row(this.selected) : null);
  }

  renderLane(parent, steps, level, upcoming, profile) {
    for (const step of steps) {
      const tile = tileState(profile, step.id);
      const item = tile.item;
      const row = node('li', parent, '', 'vb-tree-item');
      row.setAttribute('role', 'treeitem');
      row.setAttribute('aria-level', String(level));
      row.setAttribute('aria-selected', String(this.selected === step.id));
      row.tabIndex = -1;
      row.dataset.state = TREE_STATE[tile.state];
      row.dataset.lane = String(step.lane);
      row.dataset.treeNode = step.id;
      row.dataset.focusKey = `tree:${step.id}`;
      row.style.setProperty('--item-color', item.color || '#ffbc43');
      if (tile.state === 'equipped') row.dataset.equipped = 'true';
      if (upcoming.has(step.id)) row.dataset.upcoming = 'true';
      const fresh = this.host.isNew(step.id);
      if (fresh) row.dataset.new = step.id;
      const card = node('div', row, '', 'vb-tree-node');
      card.dataset.node = step.id;
      card.dataset.cosmetic = step.id;
      node('span', card, String(item.level), 'vb-tree-marker').setAttribute('aria-hidden', 'true');
      art(card, item, 'thumb');
      const copy = node('span', card, '', 'vb-tree-copy');
      node('strong', copy, item.name, 'vb-tree-name');
      const gate = item.masteryTier ? ` · ${badgeName(item.weapon).toUpperCase()} ${MASTERY_TIERS.find(tier => tier.id === item.masteryTier).name}`
        : item.combatScore ? ` · ${format(item.combatScore)} COMBAT` : '';
      node('small', copy, `${KIND_LABELS[item.kind]} · LV ${item.level}${gate}`, 'vb-tree-meta');
      const state = node('span', card, '', 'vb-tree-state');
      glyph(state, tile.state === 'equipped' ? 'equipped' : row.dataset.state === 'unlocked' ? 'owned' : row.dataset.state);
      node('span', state, tile.word, 'vb-sr');
      if (fresh) { const chip = node('span', card, 'NEW', 'vb-tree-chip vb-new-chip'); row.onSeen = () => chip.remove(); }
      else if (row.dataset.upcoming) node('span', card, 'UP NEXT', 'vb-tree-chip');
      if (step.sides.length) {
        const group = node('ul', row, '', 'vb-tree-side');
        group.setAttribute('role', 'group');
        for (const lane of step.sides) this.renderLane(group, lane, level + 1, upcoming, profile);
      }
    }
  }

  /** Inspect a tree node; the page does not scroll. */
  selectNode(id, { from = null } = {}) {
    if (!treeNode(id)) return;
    this.selected = id;
    for (const row of this.tree.querySelectorAll('[role=treeitem]')) row.setAttribute('aria-selected', String(row.dataset.treeNode === id));
    const row = from || this.row(id);
    if (row) { rovingSync(this.tree, '[role=treeitem]', row); row.focus({ preventScroll: true }); }
    this.host.inspector.inspect(id, { pin: true, reveal: true });
  }

  row(id) { return [...this.tree.querySelectorAll('[role=treeitem]')].find(row => row.dataset.treeNode === id) || null; }

  /** Journey chips and goal cards: clear a hiding filter, select, scroll into view. */
  reveal(id) {
    const item = treeNode(id);
    if (!item || !levelTrack(item)) return false;
    if (this.filter !== 'all' && this.filter !== item.branch) this.setFilter('all');
    const row = this.row(id);
    this.selectNode(id, { from: row });
    row?.scrollIntoView({ block: 'center', behavior: 'instant' });
    return true;
  }
}

function goalLine(goal, item) {
  if (goal.type === 'level') return `LV ${item?.level} · ${format(goal.remaining)} XP`;
  if (goal.type === 'mastery') {
    const tier = MASTERY_TIERS.find(entry => entry.id === item?.masteryTier);
    return `${badgeName(goal.weapon).toUpperCase()} ${tier?.numeral || ''} · ${format(goal.current)} / ${format(goal.target)}`;
  }
  return goal.unit === 'weapons' ? `${format(goal.current)} / ${format(goal.target)} WEAPONS` : `COMBAT SCORE ${format(goal.current)} / ${format(goal.target)}`;
}

function goalValueText(goal, item) {
  if (goal.type === 'level') return `${format(goal.remaining)} XP to level ${item?.level}`;
  return `${format(goal.current)} of ${format(goal.target)} ${goal.unit === 'weapons' ? 'weapons' : 'score'}`;
}
