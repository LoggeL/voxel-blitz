// Pure armory models: tree lanes, journey, goals, slot options, mastery cards and
// the per-viewer NEW-flag store.
import assert from 'node:assert/strict';
import {
  LEGACY_NODE_IDS, MASTERY_TIERS, PROGRESSION_BRANCHES, PROGRESSION_TREE, careerView, defaultCosmeticLoadout,
  nextGoals, reconcileCareerUnlocks, treeNode, upcomingUnlocks, xpForLevel,
} from '../shared/career.js';
import { WEAPON_IDS } from '../shared/combatmath.js';
import {
  branchLanes, journey, laneIds, loadoutModel, masteryCards, slotOptions, tileState,
} from '../public/js/ui/armory/armory-model.js';
import { INTRO_KEY, SEEN_PREFIX, SeenStore } from '../public/js/ui/armory/seen-store.js';

const view = (level, extra = {}) => {
  const profile = { xp: xpForLevel(level), kills: 0, pvpKills: 0, wins: 0, matches: 0, owned: ['amber', 'rookie'],
    equipped: { theme: 'amber', title: 'rookie', ...defaultCosmeticLoadout(), weaponAttachments: {} }, mastery: {}, ...extra };
  reconcileCareerUnlocks(profile);
  return careerView(profile);
};

// ---------- branchLanes ----------
const levelBranches = PROGRESSION_BRANCHES.filter(branch => branch.track === 'level');
for (const branch of levelBranches) {
  const lanes = branchLanes(branch.id);
  const ids = laneIds(lanes);
  const expected = PROGRESSION_TREE.filter(item => item.branch === branch.id).map(item => item.id);
  assert.equal(ids.length, new Set(ids).size, `${branch.id}: every node appears once`);
  assert.deepEqual([...ids].sort(), [...expected].sort(), `${branch.id}: lanes cover the branch`);
  const walk = (steps, parentLevel = 0) => {
    let previous = parentLevel;
    for (const step of steps) {
      const level = treeNode(step.id).level;
      assert.ok(level >= previous, `${branch.id}: level never decreases along a lane (${step.id})`);
      previous = level;
      for (const side of step.sides) walk(side, level);
    }
  };
  lanes.forEach(lane => walk(lane));
}
const weaponLanes = branchLanes('weapons');
assert.equal(weaponLanes.length, 1, 'the weapons branch has one root');
assert.deepEqual(weaponLanes[0].map(step => step.id),
  ['optic-reflex', 'optic-scope2', 'grip-vertical', 'optic-scope4', 'grip-precision', 'optic-scope10', 'optic-cyber', 'minigun-foundry'],
  'the weapons spine follows the largest subtree');
const sides = Object.fromEntries(weaponLanes[0].filter(step => step.sides.length).map(step => [step.id, step.sides.map(lane => lane.map(entry => entry.id))]));
assert.deepEqual(sides, {
  'optic-reflex': [['grip-angled', 'counter-stattrak']],
  'grip-vertical': [['rifle-overdrive']],
  'optic-scope10': [['revolver-high-noon']],
});
assert.deepEqual(branchLanes('presentation').map(lane => lane[0].id), ['amber', 'rookie'], 'one lane per root, in declaration order');
assert.deepEqual(branchLanes('presentation')[1].map(step => step.id).slice(0, 5), ['rookie', 'pathfinder', 'vanguard', 'veteran', 'nameplate-ranger'],
  'subtree ties resolve in declaration order');

// ---------- journey ----------
const level12 = view(12, { xp: xpForLevel(12) + 900 });
const trip = journey(level12);
assert.equal(trip.level, 12);
assert.equal(trip.complete, false);
assert.ok(trip.stops.length > 0 && trip.stops.length <= 6);
const levels = trip.stops.map(stop => stop.level);
assert.deepEqual(levels, [...levels].sort((a, b) => a - b), 'stops ascend');
assert.equal(new Set(levels).size, levels.length, 'one stop per level');
assert.ok(levels[0] > 12);
for (const stop of trip.stops) {
  assert.equal(stop.xpToGo, xpForLevel(stop.level) - level12.xp, 'xpToGo = xpForLevel - xp');
  for (const id of stop.items) assert.ok(!treeNode(id).masteryTier && !treeNode(id).combatScore, 'the journey only lists level-gated rewards');
}
assert.deepEqual(trip.stops[0], { level: 14, target: xpForLevel(14), xpToGo: xpForLevel(14) - level12.xp, items: ['nameplate-ranger'] });
assert.deepEqual(journey(level12, 2).stops.map(stop => stop.level), levels.slice(0, 2));
const veteran = journey(view(124));
assert.equal(veteran.complete, true, 'the complete state appears once every level reward is owned');
assert.deepEqual(veteran.stops, []);
assert.equal(veteran.stars, 4);
assert.ok(trip.progress > 0 && trip.progress < 1);

// ---------- upcomingUnlocks / nextGoals ----------
const upcoming = upcomingUnlocks(level12, 20);
const gaps = upcoming.map(item => xpForLevel(item.level) - level12.xp);
assert.deepEqual(gaps, [...gaps].sort((a, b) => a - b), 'upcoming unlocks sort by XP');
assert.ok(upcoming.every(item => !item.masteryTier && !item.combatScore && !item.arsenal), 'never a gated node');
assert.ok(upcoming.every(item => item.branch !== 'mastery'));
const goals = nextGoals(view(12, { mastery: { rifle: { kills: 40, headshots: 3, botKills: 80 } }, kills: 400, pvpKills: 100 }));
assert.deepEqual(goals.map(goal => goal.type), ['level', 'mastery', 'chase']);
for (const goal of goals) {
  assert.deepEqual(Object.keys(goal).filter(key => !['weapon'].includes(key)).sort(), ['current', 'id', 'remaining', 'target', 'type', 'unit']);
  assert.equal(goal.remaining, goal.target - goal.current);
  assert.ok(treeNode(goal.id), `${goal.type} goal names a catalog node`);
}
assert.deepEqual({ ...goals[1] }, { type: 'mastery', id: 'mastery-rifle-2', weapon: 'rifle', current: 60, target: 250, remaining: 190, unit: 'score' },
  'bot kills count a quarter toward the rifle goal');
assert.equal(goals[0].unit, 'xp');

// ---------- tileState / slotOptions ----------
const level2 = view(2);
assert.equal(tileState(level2, 'orchid').state, 'next');
assert.equal(tileState(level2, 'orchid').chip, 'LV 3');
assert.equal(tileState(level2, 'mint').state, 'locked');
assert.equal(tileState(level2, 'arctic').state, 'owned');
assert.equal(tileState(level2, 'amber').state, 'equipped');
assert.equal(tileState(view(12, { mastery: { rifle: { kills: 180 } } }), 'rifle-overdrive').chip, 'SPECIALIST · 180 / 250');
const rank = { equipped: 0, owned: 0, next: 1, locked: 2 };
for (const slot of ['characterSkin', 'signature', 'sound', 'theme', 'title', 'reticle', 'nameplate']) {
  const options = slotOptions(view(30, { mastery: { rifle: { kills: 60 } } }), slot);
  const standard = ['theme', 'title'].includes(slot) ? 0 : 1;
  if (standard) assert.equal(options[0].id, 'standard', `${slot}: STANDARD first`);
  else assert.equal(options.some(option => option.id === 'standard'), false, `${slot}: resets to its root, no STANDARD card`);
  const rest = options.slice(standard);
  const states = rest.map(option => rank[option.state]);
  assert.deepEqual(states, [...states].sort((a, b) => a - b), `${slot}: owned, then next, then locked`);
  for (let at = 1; at < rest.length; at++) {
    if (rank[rest[at].state] !== rank[rest[at - 1].state]) continue;
    const order = PROGRESSION_TREE.indexOf(rest[at].item) - PROGRESSION_TREE.indexOf(rest[at - 1].item);
    assert.ok(order > 0, `${slot}: declaration order inside a state`);
  }
  assert.equal(rest.length, PROGRESSION_TREE.filter(item => item.kind === slot).length);
}
const nameplates = slotOptions(view(30, { mastery: { rifle: { kills: 60 } } }), 'nameplate');
assert.equal(nameplates.find(option => option.id === 'mastery-rifle-1').state, 'owned', 'a reached tier owns its nameplate');
assert.equal(nameplates.find(option => option.id === 'mastery-rifle-1').group, 'mastery');
assert.equal(nameplates.find(option => option.id === 'nameplate-ranger').group, 'career');

// ---------- loadoutModel / masteryCards ----------
const model = loadoutModel(level12, id => id === 'arctic');
assert.deepEqual(model.slots.map(slot => slot.id), ['characterSkin', 'signature', 'sound', 'theme', 'title', 'reticle', 'nameplate']);
const theme = model.slots.find(slot => slot.id === 'theme');
assert.equal(theme.equippedName, 'Amber');
assert.equal(theme.unlocked, 4);
assert.equal(theme.total, PROGRESSION_TREE.filter(item => item.kind === 'theme').length);
assert.equal(theme.isNew, true);
assert.equal(model.slots.find(slot => slot.id === 'characterSkin').equippedName, 'Standard');
assert.equal(model.weapons.length, WEAPON_IDS.length);
assert.equal(model.weapons[0].summary, 'Standard · Factory sights · Factory grip');
const fitted = loadoutModel(view(12, { equipped: { theme: 'amber', title: 'rookie', ...defaultCosmeticLoadout(),
  weaponAttachments: { rifle: { optic: 'reflex', grip: 'angled', counter: 'standard' } } } }));
assert.equal(fitted.weapons[0].summary, 'Standard · Reflex · Angled');
const cards = masteryCards(view(12, { mastery: { rifle: { kills: 40 }, smg: { kills: 240 }, sniper: { kills: 2600 } } }));
assert.equal(cards.length, 13);
assert.equal(cards[0].weapon, 'smg', 'closest to its next tier first');
assert.equal(cards.at(-1).weapon, 'sniper', 'MASTER goes last');
assert.equal(cards[0].nextReward.id, 'mastery-smg-2');
assert.deepEqual(cards[0].tiers.map(tier => tier.score), MASTERY_TIERS.map(tier => tier.score));
assert.deepEqual(masteryCards(view(1), 'all').map(card => card.weapon), WEAPON_IDS);

// ---------- seen-store ----------
const memory = () => {
  const store = new Map();
  return { store, getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value)), removeItem: key => store.delete(key) };
};
const upgraded = view(40);
const storage = memory();
const seen = new SeenStore(null, storage);
assert.equal(seen.isNew('tactician'), false, 'no flags before the first sync');
assert.deepEqual(seen.sync(upgraded), { firstRun: true });
const seeded = JSON.parse(storage.getItem(`${SEEN_PREFIX}guest`));
assert.deepEqual(seeded.ids.sort(), upgraded.owned.filter(id => LEGACY_NODE_IDS.includes(id)).sort(), 'seeds owned ∩ LEGACY_NODE_IDS');
assert.equal(seeded.xp, upgraded.xp);
const fresh = upgraded.owned.filter(id => !LEGACY_NODE_IDS.includes(id));
assert.ok(fresh.includes('tactician') && fresh.includes('ember'));
assert.deepEqual(seen.newIds(upgraded), fresh, 'only ids this redesign adds read NEW');
assert.equal(seen.isNew('arctic'), false);
assert.equal(seen.showIntro, true, 'the intro card shows when the upgrade granted something');
assert.deepEqual(new SeenStore(null, storage).sync(upgraded), { firstRun: false }, 'seeding happens once');
seen.markSeen('tactician');
assert.equal(new SeenStore(null, storage).isNew('tactician'), false, 'seen marks persist');
assert.equal(new SeenStore(null, storage).isNew('ember'), true);
seen.setBaseline(upgraded.xp + 500);
assert.equal(new SeenStore(null, storage).baseline, upgraded.xp + 500);
seen.dismissIntro();
assert.equal(storage.getItem(INTRO_KEY), '1');
assert.equal(new SeenStore(null, storage).showIntro, false);
seen.markAllSeen(upgraded);
assert.deepEqual(new SeenStore(null, storage).newIds(upgraded), []);
const account = new SeenStore('user-7', storage);
account.sync(view(2));
assert.ok(storage.getItem(`${SEEN_PREFIX}user-7`), 'keys are per account');
assert.equal(account.showIntro, false, 'a new player with only legacy starters sees no intro');
const later = view(16);
assert.deepEqual(account.newIds(later), later.owned.filter(id => !view(2).owned.includes(id)), 'later grants read NEW');
// Throwing or missing storage: no flags, no errors.
const throwing = { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('QuotaExceeded'); } };
const blind = new SeenStore(null, throwing);
assert.deepEqual(blind.sync(upgraded), { firstRun: false });
assert.equal(blind.isNew('tactician'), false);
assert.deepEqual(blind.newIds(upgraded), []);
assert.equal(blind.markSeen('tactician'), false);
assert.equal(blind.baseline, null);
assert.equal(blind.showIntro, false);
blind.setBaseline(5); blind.dismissIntro();
const none = new SeenStore(null, null);
assert.deepEqual(none.sync(upgraded), { firstRun: false });
assert.equal(none.isNew('tactician'), false);
const saved = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
Object.defineProperty(globalThis, 'localStorage', { get() { throw new Error('SecurityError'); }, configurable: true });
try { assert.equal(new SeenStore().isNew('tactician'), false, 'a throwing localStorage getter is survived'); }
finally { if (saved) Object.defineProperty(globalThis, 'localStorage', saved); else delete globalThis.localStorage; }
// A lowered gate that just opened a legacy reward reads NEW; one the old rules had granted does not.
const opened = view(20, { mastery: { rifle: { kills: 100, headshots: 0, botKills: 600 } } });
assert.ok(opened.owned.includes('rifle-overdrive'), 'fixture: the lowered Specialist gate grants the skin');
const openedSeen = new SeenStore(null, memory());
openedSeen.sync(opened);
assert.deepEqual(openedSeen.newIds(opened).filter(id => LEGACY_NODE_IDS.includes(id)), ['rifle-overdrive'], 'a newly opened legacy reward reads NEW');
assert.equal(openedSeen.showIntro, true);
const earned = view(20, { mastery: { rifle: { kills: 250, headshots: 0 } } });
const earnedSeen = new SeenStore(null, memory());
earnedSeen.sync(earned);
assert.equal(earnedSeen.isNew('rifle-overdrive'), false, 'a reward the old gates had granted is seeded as seen');
const corrupt = memory();
corrupt.setItem(`${SEEN_PREFIX}guest`, '{nope');
assert.deepEqual(new SeenStore(null, corrupt).sync(upgraded), { firstRun: true }, 'a corrupt value reseeds');

console.log('Armory model: lanes, journey, goals, slot options, mastery cards and seen-store passed.');
