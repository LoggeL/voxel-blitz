// ARMORY dialog DOM contract on a fake DOM: kept ids and hooks, tab roles, tree
// counts, equip flow with focus restore, earned-XP table, mastery thresholds,
// NEW flags, idle-poll isolation and banned copy. No browser, no network.
import assert from 'node:assert/strict';
import { installFakeDom, fire } from './lib/fake-dom.mjs';

const dom = installFakeDom({ width: 1440 });
const {
  CAREER_REWARDS, CAREER_REWARD_RULES, MASTERY_TIERS, PROGRESSION_BRANCHES, PROGRESSION_TREE,
  careerView, defaultCosmeticLoadout, equipCareerItem, reconcileCareerUnlocks, xpForLevel,
} = await import('../shared/career.js');
const { ProgressionTree } = await import('../public/js/ui/progression.js');
const { SEEN_PREFIX } = await import('../public/js/ui/armory/seen-store.js');

const BANNED = /credit|buy|purchase|price|shop/i;
const flush = async (rounds = 4) => { for (let at = 0; at < rounds; at++) await new Promise(resolve => setTimeout(resolve, 0)); };
const text = element => element?.textContent.replace(/\s+/g, ' ').trim() ?? '';
const $ = selector => document.querySelector(selector);
const $$ = selector => document.querySelectorAll(selector);

function makeProfile(level, extra = {}) {
  const profile = { xp: xpForLevel(level), kills: 0, pvpKills: 0, wins: 0, matches: 3, owned: ['amber', 'rookie'],
    equipped: { theme: 'amber', title: 'rookie', ...defaultCosmeticLoadout(), weaponAttachments: {} }, mastery: {}, ...extra };
  reconcileCareerUnlocks(profile);
  return profile;
}

// Fake server: the same shared rules the real one uses.
let server = makeProfile(2);
const posts = [];
globalThis.fetch = async (url, options = {}) => {
  const respond = (status, payload) => ({ ok: status < 400, status, json: async () => structuredClone(payload) });
  if (options.method === 'POST') {
    const body = JSON.parse(options.body);
    posts.push({ url, body, headers: options.headers });
    try {
      if (url === '/api/career/equip') equipCareerItem(server, body.item === 'standard' ? { id: 'standard', kind: body.slot, weapon: body.weapon } : body.item);
      else if (url === '/api/career/attachments') server.equipped.weaponAttachments = { ...server.equipped.weaponAttachments, [body.weapon]: body.attachments };
    } catch (error) { return respond(400, { error: error.message }); }
  }
  return respond(200, careerView(server));
};

// Menu markup the armory mounts into.
const menu = document.createElement('div');
menu.id = 'menu';
const nav = document.createElement('nav');
nav.className = 'vb-main-nav';
const showcase = document.createElement('div');
showcase.className = 'vb-menu-showcase';
menu.append(nav, showcase);
document.body.append(menu);

const benchCalls = [];
class StubBench {
  constructor({ panel, inspector, host }) {
    benchCalls.push(['construct', panel.id, !!inspector.showWeapon, host]);
    this.panel = panel; this.inspector = inspector;
    const rail = document.createElement('nav');
    rail.id = 'armory-weapon-rail';
    panel.replaceChildren(rail);
  }
  setProfile(profile) { benchCalls.push(['setProfile', profile?.level]); }
  select(weapon, options = {}) { this.weapon = weapon; benchCalls.push(['select', weapon, options.part || null, ...(options.id ? [options.id] : [])]); this.inspector.showWeapon({ weapon, title: weapon.toUpperCase() }); }
  dispose() { benchCalls.push(['dispose']); }
}

const accounts = { user: null, dialog: { open: false }, async refresh() {}, open() {} };
const armory = new ProgressionTree({ accounts, loadViewer: () => Promise.reject(new Error('no WebGL in Node')), loadWeaponBench: async () => StubBench });
await armory.start();
clearInterval(armory.timer);

try {
  // ---------- kept ids and hooks ----------
  for (const id of ['career-shop', 'career-open', 'career-close', 'career-title', 'career-menu-preview', 'career-badge', 'career-account',
    'progression-tree', 'armory-inspector', 'armory-action', 'armory-status', 'armory-mastery-grid', 'armory-mastery-detail']) {
    assert.ok(document.getElementById(id), `#${id} exists`);
  }
  const dialog = $('#career-shop');
  assert.ok(dialog.matches('dialog.vb-career.vb-armory'));
  assert.equal(dialog.getAttribute('aria-labelledby'), 'career-title');
  assert.equal(text($('#career-title')), 'ARMORY');
  assert.equal(dialog.querySelectorAll('h2').length, 1, 'the dialog has one h2');
  assert.equal(dialog.querySelector('main'), null, 'no <main> inside the dialog');
  for (const selector of ['.vb-career-status', '.vb-career-stats', '.vb-career-title-name', '.vb-career-player', '.vb-career-account p', '.vb-career-feature',
    '.vb-armory-music [data-music-volume]', 'section.vb-armory-strip[aria-label="Your career"]', '.vb-armory-strip [role=progressbar][aria-valuetext]']) {
    assert.ok(dialog.querySelector(selector), `${selector} inside #career-shop`);
  }
  assert.equal($('#armory-inspector').matches('aside.vb-armory-inspector.vb-career-feature[aria-label="Inspector"]'), true);
  assert.equal(text($('#career-open .vb-nav-label')), 'ARMORY');
  assert.equal($('#career-open').getAttribute('aria-haspopup'), 'dialog');
  assert.equal($('#workshop-open'), null, 'the separate workshop entry is gone');
  assert.match(text($('#career-badge')), /^LV 2 · Pathfinder$|^LV 2 · Rookie$/);
  assert.equal(text($('.vb-career-stats')), 'Loading career...', 'D18: the closed dialog is not rendered at boot');

  // ---------- menu card ----------
  const card = $('#career-menu-preview');
  assert.match(text(card), /LEVEL 2 \/ Rookie/);
  assert.match(text(card), /NEXT: .+ · LV 3 · 300 XP/, 'the next goal comes from nextGoals()[0]');
  assert.equal(card.querySelector('[role=progressbar]').getAttribute('aria-valuetext'), '0 of 300 XP to level 3');
  assert.match(text(card), /ARMORY ›$/);

  // ---------- open: LOADOUT, tabs and roles ----------
  await armory.open({ tab: 'loadout' }, $('#career-open'));
  await flush();
  assert.equal(dialog.open, true);
  assert.equal(dialog.dataset.tab, 'loadout');
  assert.equal(text($('.vb-career-stats')), 'LEVEL 2 · 100 XP');
  assert.equal(text($('.vb-armory-xp-left')), '300 XP TO LEVEL 3');
  const tabs = dialog.querySelectorAll('[role=tablist][aria-label="Armory sections"] > [role=tab]');
  assert.deepEqual(tabs.map(tab => tab.dataset.tab), ['loadout', 'weapons', 'progress', 'mastery']);
  for (const tab of tabs) {
    const panel = document.getElementById(tab.getAttribute('aria-controls'));
    assert.equal(tab.id, `armory-tab-${tab.dataset.tab}`);
    assert.equal(panel.getAttribute('role'), 'tabpanel');
    assert.equal(panel.getAttribute('aria-labelledby'), tab.id);
    assert.equal(panel.hidden, tab.dataset.tab !== 'loadout');
    assert.equal(tab.getAttribute('aria-selected'), String(tab.dataset.tab === 'loadout'));
    assert.equal(tab.tabIndex, tab.dataset.tab === 'loadout' ? 0 : -1, 'roving tabindex on the tablist');
  }
  assert.deepEqual(dialog.querySelectorAll('.vb-armory-slot').map(slot => slot.dataset.slot),
    ['characterSkin', 'signature', 'sound', 'theme', 'title', 'reticle', 'nameplate']);
  assert.equal(dialog.querySelectorAll('[data-weapon-row]').length, 13);
  assert.equal($('#armory-inspector').dataset.featuredItem, 'standard', 'the default target is the equipped operator skin');
  assert.equal(text($('.vb-armory-audience')).startsWith('WHO SEES IT'), true);

  // Theme slot: arctic is owned at level 2; orchid is next.
  $('.vb-armory-slot[data-slot=theme]').click();
  const grid = $('#armory-panel-loadout [role=listbox][aria-labelledby=armory-options-title]');
  assert.ok(grid, 'the options grid is a listbox labelled by the slot title');
  const order = grid.querySelectorAll('[role=option]').map(option => [option.dataset.option, option.dataset.state]);
  assert.deepEqual(order.slice(0, 3), [['amber', 'equipped'], ['arctic', 'owned'], ['orchid', 'next']], 'owned, then next, then locked');
  assert.equal(order.some(([id]) => id === 'standard'), false, 'the theme slot resets to amber, so it has no STANDARD card');
  const arctic = grid.querySelector('[data-option=arctic]');
  arctic.focus();
  const focusKeyBefore = arctic.dataset.focusKey;
  arctic.click();
  await flush();
  assert.equal(text($('#armory-status')), 'Arctic equipped');
  assert.equal(document.activeElement?.dataset.focusKey, focusKeyBefore, 'focus returns to the same data-focus-key');
  assert.equal(document.activeElement.getAttribute('aria-selected'), 'true');
  assert.equal(document.documentElement.style.getPropertyValue('--career-accent'), '#72e6ff', 'local presentation follows the profile');
  assert.deepEqual(posts.at(-1).body, { item: 'arctic', equipOnly: true });
  assert.equal(posts.at(-1).headers['X-VB-Career'], '1');

  // A collapsed MASTERY group never takes the options grid's only tab stop.
  $('.vb-armory-slot[data-slot=nameplate]').click();
  const masteryGroup = $('#armory-panel-loadout details.vb-armory-mastery-options');
  assert.equal(masteryGroup.open, false, 'MASTERY starts collapsed with nothing owned');
  const careerOptions = $$('#armory-panel-loadout .vb-armory-options > .vb-armory-grid [role=option]');
  careerOptions[0].focus();
  fire(careerOptions[0], 'keydown', { key: 'End' });
  assert.equal(document.activeElement, careerOptions.at(-1), 'End stays out of the collapsed group');
  assert.equal($$('#armory-panel-loadout [role=option]').filter(option => option.tabIndex === 0).length, 1);
  assert.equal(masteryGroup.querySelectorAll('[role=option]').some(option => option.tabIndex === 0), false);

  // STANDARD card resets through the slot.
  $('.vb-armory-slot[data-slot=reticle]').click();
  const reticleOptions = dialog.querySelectorAll('#armory-panel-loadout [role=option]').map(option => option.dataset.option);
  assert.equal(reticleOptions[0], 'standard', 'STANDARD comes first where the slot can be empty');

  // Locked options only inspect; a locked target never carries [data-item].
  const locked = dialog.querySelector('#armory-panel-loadout [role=option][data-state=locked]') || dialog.querySelector('#armory-panel-loadout [role=option][data-state=next]');
  const postCount = posts.length;
  locked.click();
  await flush();
  assert.equal(posts.length, postCount, 'a locked option never POSTs');
  assert.equal($('#armory-action').hasAttribute('data-item'), false);
  assert.equal($('#armory-action').disabled, true);
  assert.equal($('.vb-armory-reqs').hidden, false, 'requirements show while not owned');

  // ---------- tab keys ----------
  $('#armory-tab-loadout').focus();
  fire($('#armory-tab-loadout'), 'keydown', { key: 'ArrowRight' });
  await flush();
  assert.equal(dialog.dataset.tab, 'weapons', 'ArrowRight moves to WEAPONS');
  assert.equal(document.activeElement, $('#armory-tab-weapons'));
  assert.ok($('#armory-weapon-rail'), 'the bench is built lazily into the WEAPONS panel');
  assert.deepEqual(benchCalls[0].slice(0, 3), ['construct', 'armory-panel-weapons', true]);
  assert.equal(benchCalls[0][3], armory, 'the bench gets the ProgressionTree as host');
  assert.deepEqual(benchCalls.find(call => call[0] === 'select'), ['select', 'rifle', null]);
  assert.equal($('#armory-action').hidden, true, '#armory-action is hidden in WEAPONS');
  fire($('#armory-tab-weapons'), 'keydown', { key: 'End' });
  assert.equal(dialog.dataset.tab, 'mastery');
  fire($('#armory-tab-mastery'), 'keydown', { key: 'Home' });
  assert.equal(dialog.dataset.tab, 'loadout');
  assert.equal($('#armory-action').hidden, false);
  armory.open({ tab: 'weapons', weapon: 'sniper', part: 'optic' });
  await flush();
  assert.deepEqual(benchCalls.filter(call => call[0] === 'select').at(-1), ['select', 'sniper', 'optic'], 'deep links select weapon and part');

  // ---------- PROGRESS ----------
  armory.setTab('progress');
  const tree = $('#progression-tree');
  const levelTrack = PROGRESSION_TREE.filter(item => PROGRESSION_BRANCHES.find(branch => branch.id === item.branch).track === 'level');
  assert.equal(levelTrack.length, 53);
  assert.equal(tree.querySelectorAll('[data-cosmetic]').length, levelTrack.length, '[data-cosmetic] under ALL');
  assert.equal(dialog.querySelectorAll('[data-cosmetic]').length, levelTrack.length, '[data-cosmetic] exists only inside the tree');
  assert.equal($('.vb-tree-summary').textContent.endsWith(`/ ${levelTrack.length} UNLOCKED`), true);
  assert.ok(tree.querySelectorAll('[data-upcoming]').length <= 3 && tree.querySelectorAll('[data-upcoming]').length > 0, '[data-upcoming] on at most 3');
  const orchid = tree.querySelector('[data-node=orchid]').closest('.vb-tree-item');
  assert.equal(orchid.dataset.state, 'next', 'orchid is next at level 2');
  assert.equal(orchid.getAttribute('role'), 'treeitem');
  assert.equal(tree.querySelector('[data-node=arctic]').closest('.vb-tree-item').dataset.equipped, 'true');
  for (const branch of tree.querySelectorAll('.vb-tree-branch')) {
    assert.ok(branch.querySelector('h4'), 'branch headings are h4');
    assert.equal(branch.querySelector('ul').getAttribute('role'), 'tree');
  }
  assert.deepEqual(tree.querySelectorAll('.vb-tree-branch').map(branch => branch.dataset.branch), ['weapons', 'character', 'presentation']);
  for (const branch of ['weapons', 'character', 'presentation']) {
    $(`.vb-tree-filter[data-filter=${branch}]`).click();
    assert.equal(tree.querySelectorAll('[data-cosmetic]').length, PROGRESSION_TREE.filter(item => item.branch === branch).length, `${branch} filter count`);
    assert.equal($(`.vb-tree-filter[data-filter=${branch}]`).getAttribute('aria-pressed'), 'true');
  }
  // Side lane: the weapons spine keeps grip-angled in a nested group under optic-reflex.
  $('.vb-tree-filter[data-filter=weapons]').click();
  const reflex = tree.querySelector('[data-tree-node=optic-reflex]');
  assert.ok(reflex.querySelector('ul[role=group] [data-tree-node=grip-angled]'), 'grip-angled sits in a side lane under the reflex sight');
  reflex.focus();
  fire(reflex, 'keydown', { key: 'ArrowRight' });
  assert.equal(document.activeElement.dataset.treeNode, 'grip-angled', 'Right enters the side lane');
  fire(document.activeElement, 'keydown', { key: 'ArrowLeft' });
  assert.equal(document.activeElement.dataset.treeNode, 'optic-reflex', 'Left returns to the parent');
  fire(document.activeElement, 'keydown', { key: 'Enter' });
  assert.equal($('#armory-inspector').dataset.featuredItem, 'optic-reflex', 'Enter inspects the node');
  assert.match(text($('#armory-action')), /^FIT ON LONGSHOT MK-II$/, 'owned attachments fit on the weapon last selected in WEAPONS');
  // A journey chip for a presentation reward clears the weapons filter.
  const chip = [...$$('.vb-journey-chip')].find(control => document.querySelector(`[data-journey="${control.dataset.journey}"]`)
    && PROGRESSION_TREE.find(item => item.id === control.dataset.journey).branch === 'presentation');
  assert.ok(chip, 'the journey offers a presentation reward');
  chip.click();
  assert.equal($('.vb-tree-filter[data-filter=all]').getAttribute('aria-pressed'), 'true', 'the hiding filter is cleared');
  assert.equal(tree.querySelector(`[data-tree-node="${chip.dataset.journey}"]`).getAttribute('aria-selected'), 'true');
  assert.equal(document.scrolledIntoView?.dataset.treeNode, chip.dataset.journey);
  // Journey stops ascend with their XP distance.
  const stops = $$('.vb-journey-stop').map(stop => Number(stop.dataset.level));
  assert.deepEqual(stops, [...stops].sort((a, b) => a - b));
  assert.equal(text($('.vb-journey-stop .vb-journey-away')), `${(xpForLevel(stops[0]) - server.xp).toLocaleString('en-US')} XP AWAY`);
  // HOW TO EARN XP comes from CAREER_REWARDS.
  const rows = $$('.vb-armory-earn tr');
  assert.deepEqual(rows.map(row => row.dataset.reward), CAREER_REWARD_RULES.map(rule => rule.id));
  for (const row of rows) assert.equal(text(row.querySelector('td')), `+${CAREER_REWARDS[row.dataset.reward].xp} XP`);
  assert.ok($$('.vb-goal-card[data-goal]').length >= 2, 'goals render');
  assert.equal($('.vb-goal-card[data-goal=level]').dataset.target, 'reticle-dot', 'level 3 ties resolve in declaration order');

  // ---------- MASTERY ----------
  armory.setTab('mastery');
  assert.equal($$('#armory-mastery-grid > li > .vb-mastery-card[data-weapon-mastery]').length, 13, 'one card per weapon, li-wrapped');
  $('.vb-mastery-card[data-weapon-mastery=rifle]').click();
  assert.equal($('#armory-mastery-detail').hidden, false);
  assert.equal($('.vb-mastery-card[data-weapon-mastery=rifle]').getAttribute('aria-expanded'), 'true');
  assert.deepEqual($$('#armory-mastery-detail .vb-mastery-threshold').map(text), MASTERY_TIERS.map(tier => `${tier.score.toLocaleString('en-US')} SCORE`));
  assert.ok($('#armory-mastery-detail [data-mastery-node=rifle-overdrive]'), 'the legacy rifle skin sits on its tier');
  assert.equal($('#armory-mastery-detail [data-open-weapon]').dataset.openWeapon, 'rifle');
  assert.deepEqual($$('.vb-arsenal [data-mastery-node]').map(tile => tile.dataset.masteryNode), ['armorer', 'nameplate-arsenal', 'armsmaster', 'revenant']);
  assert.match(text($('.vb-mastery-rules')), /Bot and Bastion kills count ¼/);

  // FIT ON <WEAPON> lands on the inspected attachment, not the group's pressed option.
  armory.setTab('progress');
  armory.progress.selectNode('optic-reflex');
  $('#armory-action').click();
  await flush();
  assert.equal(dialog.dataset.tab, 'weapons');
  assert.deepEqual(benchCalls.filter(call => call[0] === 'select').at(-1), ['select', 'sniper', 'optic', 'reflex']);

  // Controls that switch tabs hand focus into the new panel instead of stranding it on <body>.
  const press = control => { control.focus(); control.click(); };
  armory.setTab('mastery');
  press($('#armory-mastery-detail [data-open-weapon=rifle]'));
  await flush();
  assert.equal(dialog.dataset.tab, 'weapons');
  assert.deepEqual(benchCalls.filter(call => call[0] === 'select').at(-1), ['select', 'rifle', null]);
  assert.equal(document.activeElement, $('#armory-tab-weapons'), 'TUNE IN WEAPONS hands focus to WEAPONS (the stub bench has no rail buttons)');
  armory.setTab('loadout');
  press($('.vb-armory-weapon-row[data-weapon-row=sniper]'));
  await flush();
  assert.equal(dialog.dataset.tab, 'weapons');
  assert.deepEqual(benchCalls.filter(call => call[0] === 'select').at(-1), ['select', 'sniper', null]);
  assert.equal(document.activeElement, $('#armory-tab-weapons'), 'a weapon row hands focus to WEAPONS');
  armory.setTab('progress');
  const chaseCard = $$('.vb-goal-card').find(card => card.dataset.goal !== 'level');
  assert.ok(chaseCard, 'a mastery or arsenal goal renders');
  const chaseTarget = chaseCard.dataset.target;
  press(chaseCard);
  assert.equal(dialog.dataset.tab, 'mastery');
  assert.equal(document.activeElement?.dataset.masteryNode, chaseTarget, 'a goal card lands on its reward in MASTERY');
  assert.ok($('#armory-panel-mastery').contains(document.activeElement));

  // ---------- copy, bars ----------
  for (const tab of ['loadout', 'progress', 'mastery']) {
    armory.setTab(tab);
    assert.doesNotMatch(dialog.textContent, BANNED, `no banned words on ${tab}`);
  }
  for (const progress of dialog.querySelectorAll('[role=progressbar]')) assert.ok(progress.getAttribute('aria-valuetext'), 'every bar states its value');

  // ---------- close: focus return, viewer disposal, idle-poll isolation ----------
  dialog.close();
  assert.equal(document.activeElement, $('#career-open'), 'focus returns to the opener');
  const before = text($('#armory-panel-loadout'));
  server.xp = xpForLevel(16);
  reconcileCareerUnlocks(server);
  await armory.request();
  assert.equal(text($('#armory-panel-loadout')), before, 'a closed dialog is not re-rendered by the poll');
  assert.match(text($('#career-badge')), /^LV 16 · /, 'the HUD badge still follows the poll');
  assert.match(text($('#career-menu-preview')), /LEVEL 16/);
  // NEW flags: tactician is new at level 16 (not a legacy id, so first-run seeding never covered it).
  assert.equal($('#career-open .vb-nav-badge').hidden, false);
  assert.match($('#career-open').getAttribute('aria-label'), /^Armory, \d+ new unlocks?$/);
  assert.match(text($('#career-menu-preview')), /NEW UNLOCKS? SINCE YOUR LAST VISIT/);
  const stored = JSON.parse(dom.localStorage.getItem(`${SEEN_PREFIX}guest`));
  assert.ok(stored.ids.includes('amber') && !stored.ids.includes('tactician'));
  await armory.open({ tab: 'progress' }, $('#career-menu-preview'));
  await flush();
  assert.equal(dialog.dataset.tab, 'progress');
  assert.equal($('#progression-tree [data-tree-node=tactician]').dataset.new, 'tactician');
  assert.ok($('#armory-tab-progress .vb-tab-new'), 'the PROGRESS tab carries a NEW dot');
  armory.inspector.inspect('warden', { pin: true });
  armory.inspector.inspect('tactician', { pin: true });
  assert.equal(JSON.parse(dom.localStorage.getItem(`${SEEN_PREFIX}guest`)).ids.includes('warden'), false, 'inspecting a locked reward never pre-marks it seen');
  assert.equal($('#progression-tree [data-tree-node=tactician]').hasAttribute('data-new'), false, 'inspecting marks a reward seen');
  assert.equal(JSON.parse(dom.localStorage.getItem(`${SEEN_PREFIX}guest`)).ids.includes('tactician'), true);
  assert.equal($('#progression-tree [data-tree-node=tactician] .vb-new-chip'), null, 'the NEW chip goes with the dot');
  // A NEW option card turns into an UNLOCKED one in place.
  armory.setTab('loadout');
  $('.vb-armory-slot[data-slot=title]').click();
  const freshTitle = $('#armory-panel-loadout [role=option][data-new]');
  assert.ok(freshTitle && /NEW/.test(text(freshTitle)), 'a new title card reads NEW');
  armory.markSeen(freshTitle.dataset.option);
  assert.equal(freshTitle.hasAttribute('data-new'), false);
  assert.match(text(freshTitle.querySelector('.vb-armory-chip')), /^UNLOCKED$/);
  // MARK ALL SEEN removes itself; focus lands on the first goal.
  armory.setTab('progress');
  $('[data-mark-seen=goals]').click();
  assert.equal(armory.newIds().length, 0);
  assert.ok(document.activeElement?.matches('.vb-goal-card'), 'focus moves to the first goal');
  $('#career-close').click();
  assert.equal(dialog.open, false);
  assert.equal(document.activeElement, $('#career-menu-preview'), 'focus returns to the menu card');
  assert.equal(JSON.parse(dom.localStorage.getItem(`${SEEN_PREFIX}guest`)).xp, server.xp, 'the XP baseline moves on close');

  // ---------- account switch: fresh identity, fresh flags ----------
  const events = [];
  window.addEventListener('vb-career-change', event => events.push(event.detail));
  accounts.user = { id: 'u1', username: 'Tester' };
  window.dispatchEvent(new CustomEvent('vb-account-change', { detail: { user: accounts.user } }));
  assert.equal(events[0], null, 'identity change clears runtime cosmetics first');
  assert.equal(document.documentElement.style.getPropertyValue('--career-accent'), '', 'local presentation resets');
  await flush();
  assert.equal(text($('.vb-career-player')), 'Tester');
  assert.equal(text($('#career-account')), 'MANAGE ACCOUNT');
  assert.ok(dom.localStorage.getItem(`${SEEN_PREFIX}u1`), 'each account keeps its own NEW flags');
  // WEAPONS chosen while no profile has loaded opens the bench once the career arrives.
  window.dispatchEvent(new CustomEvent('vb-account-change', { detail: { user: accounts.user } }));
  assert.equal(armory.profile, null);
  const opening = armory.open({ tab: 'weapons' }, $('#career-open'));
  assert.equal(text($('#armory-panel-weapons')), 'LOADING WEAPONS');
  await opening;
  await flush();
  assert.ok($('#armory-panel-weapons #armory-weapon-rail'), 'the bench replaces LOADING WEAPONS');
  assert.deepEqual(benchCalls.filter(call => call[0] === 'select').at(-1), ['select', 'sniper', null], 'the last chosen weapon');
  dialog.close();

  armory.dispose();
  assert.equal($('#career-shop'), null);
  assert.equal($('#career-open'), null);
} finally {
  armory.dispose?.();
  dom.restore();
}

// ---------- 390px: pushed options view, bottom sheet, one tree branch ----------
const phone = installFakeDom({ width: 390 });
try {
  server = makeProfile(12);
  const mobile = new ProgressionTree({ loadViewer: () => Promise.reject(new Error('no WebGL in Node')), loadWeaponBench: async () => StubBench });
  await mobile.open({ tab: 'loadout' });
  await flush();
  const root = $('.vb-armory-loadout');
  assert.equal(root.dataset.view, 'slots');
  assert.equal($('#armory-inspector').dataset.sheet, 'closed', 'opening never covers the list with the sheet');
  $('#armory-panel-loadout').scrollTop = 300;
  $('.vb-armory-slot[data-slot=title]').click();
  assert.equal(root.dataset.view, 'options', 'a slot pushes its options view');
  assert.equal($('#armory-panel-loadout').scrollTop, 0, 'the options view opens at its heading');
  assert.equal(document.activeElement, $('.vb-armory-back'), 'focus moves to ← ALL SLOTS');
  const option = $('#armory-panel-loadout [data-option=vanguard]');
  option.click();
  await flush();
  assert.equal($('#armory-inspector').dataset.sheet, 'open', 'selecting an item opens the bottom sheet');
  assert.equal(text($('#armory-status')), 'Vanguard equipped');
  $('.vb-armory-sheet-toggle').click();
  assert.equal($('#armory-inspector').dataset.sheet, 'closed');
  const escape = fire($('#armory-panel-loadout [data-option=vanguard]'), 'keydown', { key: 'Escape' });
  assert.equal(escape.defaultPrevented, true, 'Escape inside the options view does not close the dialog');
  assert.equal(root.dataset.view, 'slots', 'Escape returns to the slot list first');
  assert.equal(document.activeElement?.dataset.slot, 'title', 'focus returns to the slot');
  assert.equal($('#armory-panel-loadout').scrollTop, 300, 'the slot list keeps its scroll');
  mobile.setTab('progress');
  const top = (await import('../shared/career.js')).upcomingUnlocks(careerView(server), 1)[0];
  assert.equal($('.vb-tree-filter[aria-pressed=true]').dataset.filter, top.branch, 'mobile shows the branch of the top upcoming unlock');
  assert.equal($$('#progression-tree .vb-tree-branch').length, 1);
  mobile.dispose();
  console.log('Armory DOM contract: kept ids, tabs and panels, tree counts and lanes, equip with focus restore, earned XP, mastery tiers, NEW flags, idle poll isolation, mobile sheet and copy passed.');
} finally {
  phone.restore();
}
