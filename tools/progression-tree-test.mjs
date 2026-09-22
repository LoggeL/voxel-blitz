import assert from 'node:assert/strict';
import { PROGRESSION_TREE, PROGRESSION_BRANCHES, CAREER_CATALOG, CAREER_REWARDS, careerItemState,
  reconcileCareerUnlocks, unlockedParts, careerView, careerLevel, equipCareerItem, treeNode,
  childrenOf, branchRoots, defaultCosmeticLoadout, EQUIPPABLE_SLOTS, LOADOUT_SLOTS, xpForLevel, MASTERY_TIERS,
  masteryTier, LEGACY_NODE_IDS, upcomingUnlocks, masteryTracks, nextGoals, cosmeticLoadout } from '../shared/career.js';
import { OPTICS, GRIPS, COUNTERS, ATTACHMENT_SLOTS } from '../shared/weapon-attachments.js';
import { WEAPON_IDS } from '../shared/combatmath.js';
import { emptyProfile, validateProfile, CAREER_COUNTERS } from '../server/persistence/career-profile.js';
import { allowedWeaponLoadout, assertUnlockedAttachments } from '../server/weapon-loadouts.js';

const profile = (level, extra = {}) => validateProfile({ ...emptyProfile(), xp: xpForLevel(level), ...extra });

// ---------- structure ----------
const ids = PROGRESSION_TREE.map(node => node.id);
assert.equal(new Set(ids).size, ids.length, 'node IDs are unique');
assert.deepEqual(PROGRESSION_BRANCHES.map(branch => branch.id), ['weapons', 'character', 'presentation', 'mastery']);
for (const branch of PROGRESSION_BRANCHES) assert.ok(['level', 'mastery'].includes(branch.track), `${branch.id} names its track`);
assert.equal(PROGRESSION_TREE.length, 108, 'the catalog holds 53 level-track and 55 mastery nodes');
assert.equal(PROGRESSION_TREE.filter(node => node.branch === 'mastery').length, 55);
assert.equal(LEGACY_NODE_IDS.length, 34);
assert.deepEqual(EQUIPPABLE_SLOTS, ['characterSkin', 'signature', 'sound', 'reticle', 'nameplate'], 'wire slots keep their value and order');
assert.deepEqual(EQUIPPABLE_SLOTS, LOADOUT_SLOTS.filter(slot => slot.wire).map(slot => slot.id));
const REQUIRED = { theme: ['color'], nameplate: ['badge', 'color'], reticle: ['reticle'], sound: ['audio'], attachment: ['slot', 'part'], weaponSkin: ['weapon'] };
const extraGates = node => ['masteryTier', 'combatScore', 'arsenal'].filter(key => node[key] !== undefined);
const CATALOGS = { optic: OPTICS, grip: GRIPS, counter: COUNTERS };
for (const [at, node] of PROGRESSION_TREE.entries()) {
  assert.ok(PROGRESSION_BRANCHES.some(branch => branch.id === node.branch), `${node.id} names a real branch`);
  assert.ok(Number.isInteger(node.level) && node.level >= 1, `${node.id} has a level`);
  assert.ok(node.name && node.detail, `${node.id} has copy`);
  assert.equal(node.price, undefined, `${node.id} carries no price`);
  assert.equal(node.masteryKills, undefined, `${node.id} carries no legacy masteryKills gate`);
  assert.equal(node.pvpKills, undefined, `${node.id} carries no legacy pvpKills gate`);
  for (const field of REQUIRED[node.kind] || []) assert.notEqual(node[field], undefined, `${node.id} carries ${field}`);
  if (node.kind === 'reticle') assert.ok(['dot', 'chevron', 'halo', 'gap', 'bracket', 'diamond'].includes(node.reticle), `${node.id} names a real reticle`);
  const gates = extraGates(node);
  assert.ok(gates.length <= 1, `${node.id} has at most one extra gate`);
  if (node.masteryTier !== undefined) {
    assert.ok(MASTERY_TIERS.some(tier => tier.id === node.masteryTier), `${node.id} names a real mastery tier`);
    assert.ok(WEAPON_IDS.includes(node.weapon), `${node.id} names a mastery weapon`);
  }
  if (node.branch === 'mastery') assert.ok(node.parent === null && node.level === 1 && gates.length === 1, `${node.id} is a gated level-1 root`);
  // A gated node has exactly one real gate: its level is its parent's (or 1 for a root).
  if (gates.length) assert.equal(node.level, node.parent === null ? 1 : treeNode(node.parent).level, `${node.id} stacks no level gate`);
  if (node.parent !== null) {
    const parent = treeNode(node.parent);
    assert.ok(parent, `${node.id} resolves its parent`);
    // The single-pass grant loop depends on this ordering, and an out-of-order
    // node would only delay its grant -- invisible without an explicit check.
    assert.ok(ids.indexOf(node.parent) < at, `${node.id} is declared after its parent`);
    assert.ok(parent.level <= node.level, `${node.id} never opens before its parent`);
    assert.equal(parent.branch, node.branch, `${node.id} stays in its branch`);
  }
  if (node.kind === 'weaponSkin') assert.ok(WEAPON_IDS.includes(node.weapon), `${node.id} names a real weapon`);
  if (node.kind === 'attachment') {
    assert.ok(CATALOGS[node.slot], `${node.id} names a real slot`);
    assert.ok(CATALOGS[node.slot][node.part], `${node.id} names a real part`);
    assert.ok(WEAPON_IDS.some(weapon => ATTACHMENT_SLOTS[weapon][node.slot === 'optic' ? 'optics' : node.slot === 'grip' ? 'grips' : 'counter'].includes(node.part)),
      `${node.id} is mountable on at least one weapon`);
  }
  // Only leaves may carry an extra gate, so a mastery grind can never dead-end a branch.
  if (gates.length) assert.equal(childrenOf(node.id).length, 0, `${node.id} gates progress for other nodes`);
}
for (const branch of PROGRESSION_BRANCHES) assert.ok(branchRoots(branch.id).length >= 1, `${branch.id} has a root`);
assert.equal(CAREER_CATALOG, PROGRESSION_TREE, 'the flat catalog is the tree itself');

// ---------- grants ----------
const fresh = emptyProfile();
assert.deepEqual(fresh.owned, ['amber', 'rookie'], 'a new career starts on the two roots');
assert.equal(fresh.credits, undefined, 'a new career has no currency');
assert.equal(CAREER_COUNTERS.includes('credits'), false);
for (const reward of Object.values(CAREER_REWARDS)) assert.equal(reward.credits, undefined, 'rewards pay XP only');

for (const node of PROGRESSION_TREE) {
  if (node.parent === null) continue;
  // Meeting every own requirement is not enough while the parent is closed.
  const orphan = { ...emptyProfile(), xp: xpForLevel(node.level), pvpKills: node.combatScore || 0, kills: node.combatScore || 0,
    mastery: node.masteryTier ? { [node.weapon]: { kills: masteryTier(node.masteryTier).score, headshots: 0 } } : {} };
  orphan.owned = ['amber', 'rookie'].filter(id => id !== node.parent);
  const state = careerItemState(orphan, node);
  if (!orphan.owned.includes(node.parent)) {
    assert.equal(state.blockedByParent, true, `${node.id} reports its parent gate`);
    assert.equal(state.eligible, false, `${node.id} cannot open before its parent`);
  }
}

const maxed = { ...emptyProfile(), xp: xpForLevel(100), pvpKills: 10000, kills: 10000,
  mastery: Object.fromEntries(WEAPON_IDS.map(weapon => [weapon, { kills: 10000, headshots: 0 }])) };
const granted = reconcileCareerUnlocks(maxed);
assert.equal(maxed.owned.length, PROGRESSION_TREE.length, 'one pass opens every node for a complete profile');
assert.ok(granted.length > 0);
assert.deepEqual(reconcileCareerUnlocks(maxed), [], 'grants are idempotent');

const returning = { ...emptyProfile(), xp: xpForLevel(36) };
const cascade = reconcileCareerUnlocks(returning);
assert.ok(cascade.length > 10, 'a long absence opens a whole chain in one pass');
assert.ok(cascade.includes('optic-scope10'), 'deep spine nodes cascade behind their parents');

// Exact boundaries, for every mastery and combat gate the tree declares (arsenal
// gates are pinned in cosmetics-career-test).
for (const node of PROGRESSION_TREE.filter(node => node.masteryTier || node.combatScore)) {
  const ready = { ...emptyProfile(), xp: xpForLevel(100), pvpKills: 10000, kills: 10000,
    mastery: Object.fromEntries(WEAPON_IDS.map(weapon => [weapon, { kills: 10000, headshots: 0 }])) };
  reconcileCareerUnlocks(ready);
  const short = { ...ready, owned: ready.owned.filter(id => id !== node.id),
    pvpKills: node.combatScore ? node.combatScore - 1 : ready.pvpKills, kills: node.combatScore ? node.combatScore - 1 : ready.kills,
    mastery: { ...ready.mastery, ...(node.masteryTier ? { [node.weapon]: { kills: masteryTier(node.masteryTier).score - 1, headshots: 0 } } : {}) } };
  assert.equal(careerItemState(short, node).eligible, false, `${node.id} needs its exact gate`);
  reconcileCareerUnlocks(short);
  assert.equal(short.owned.includes(node.id), false, `${node.id} is not granted one short`);
}

// ---------- ownership is permanent ----------
const legacy = validateProfile({ xp: 100, credits: 87, kills: 5, matches: 1,
  owned: ['amber', 'rookie', 'arctic'], equipped: { theme: 'arctic', title: 'rookie', ...defaultCosmeticLoadout() } });
assert.equal(legacy.credits, undefined, 'a legacy credits field is accepted and dropped');
assert.ok(legacy.owned.includes('arctic'), 'a purchased item stays owned');
assert.equal(careerItemState(legacy, 'arctic').locked, false, 'an owned node is never re-locked by the tree');
assert.equal(legacy.equipped.theme, 'arctic', 'the equipped legacy theme survives migration');

// Forged ownership still cannot bypass a requirement gate.
const forged = { ...emptyProfile(), xp: xpForLevel(100), owned: ['amber', 'rookie', 'rifle-overdrive'] };
assert.equal(careerItemState(forged, 'rifle-overdrive').locked, true, 'forged ownership does not satisfy mastery');
assert.equal(careerItemState(forged, 'rifle-overdrive').status, 'locked', 'forged ownership reads as locked');
assert.throws(() => equipCareerItem(forged, 'rifle-overdrive'), /not been unlocked/);
assert.throws(() => equipCareerItem(maxed, 'optic-scope4'), /armory/, 'attachments are not cosmetic slots');
for (const slot of EQUIPPABLE_SLOTS) assert.ok(Object.hasOwn(defaultCosmeticLoadout(), slot), `${slot} has a loadout entry`);

// ---------- status, gate and xpToGo ----------
const levelTwo = profile(2);
const stateOf = id => careerItemState(levelTwo, id);
assert.equal(stateOf('amber').status, 'equipped');
assert.equal(stateOf('arctic').status, 'owned');
assert.equal(stateOf('orchid').status, 'next', 'a child of an owned node is next');
assert.equal(stateOf('orchid').xpToGo, xpForLevel(3) - xpForLevel(2));
assert.equal(stateOf('mint').status, 'locked', 'a grandchild stays locked');
assert.equal(stateOf('arctic').xpToGo, 0);
assert.equal(stateOf('amber').gate, 'level');
assert.equal(stateOf('rifle-overdrive').gate, 'mastery');
assert.equal(stateOf('revenant').gate, 'combat');
assert.equal(stateOf('armorer').gate, 'arsenal');
assert.equal(stateOf('mastery-rifle-1').status, 'next', 'mastery roots are always next until earned');
assert.deepEqual(stateOf('rifle-overdrive').requirements.map(value => value.label), ['Career level', 'Raptor mastery · SPECIALIST']);
assert.deepEqual(stateOf('revenant').requirements.map(value => value.label), ['Career level', 'Combat score']);
assert.deepEqual(stateOf('armorer').requirements.map(value => value.label), ['Career level', 'Weapons at SPECIALIST']);
assert.deepEqual(careerItemState(levelTwo, 'missing'), { owned: false, equipped: false, locked: true, eligible: false,
  blockedByParent: false, progress: 0, requirements: [], status: 'locked', gate: 'level', xpToGo: 0 });

// `locked`/`eligible` keep their exact legacy meaning on the pre-redesign fixtures.
const legacyFixtures = [emptyProfile(), levelTwo, profile(12), profile(18), profile(36),
  { ...profile(15), mastery: { rifle: { kills: 250, headshots: 0 } } },
  { ...emptyProfile(), xp: xpForLevel(100), owned: ['amber', 'rookie', 'rifle-overdrive', 'optic-reflex'] }];
for (const fixture of legacyFixtures) for (const id of LEGACY_NODE_IDS) {
  const state = careerItemState(fixture, id), node = treeNode(id);
  const blocked = !fixture.owned.includes(id) && node.parent !== null && !fixture.owned.includes(node.parent);
  assert.equal(state.blockedByParent, blocked, `${id} parent gate`);
  assert.equal(state.eligible, !blocked && state.requirements.every(value => value.complete), `${id} eligibility`);
  assert.equal(state.locked, !state.eligible, `${id} lock`);
  assert.equal(state.owned, fixture.owned.includes(id));
}
// Pinned by hand from the pre-redesign rules, so a wrong gate evaluation cannot pass by
// agreeing with itself. None of these fixtures reaches a lowered gate.
const EARLY = ['optic-reflex', 'grip-angled', 'counter-stattrak', 'optic-scope2', 'grip-vertical', 'ignition', 'amber', 'arctic',
  'reticle-dot', 'orchid', 'mint', 'rookie', 'pathfinder', 'vanguard', 'veteran', 'reticle-chevron', 'arcade'];
const LEGACY_ELIGIBLE = [
  ['amber', 'rookie'],
  ['optic-reflex', 'amber', 'arctic', 'rookie', 'pathfinder'],
  EARLY,
  [...EARLY.slice(0, 5), 'optic-scope4', ...EARLY.slice(5), 'nameplate-ranger'],
  [...EARLY.slice(0, 5), 'optic-scope4', 'grip-precision', 'optic-scope10', 'ignition', 'salvager', 'circuit', ...EARLY.slice(6),
    'nameplate-ranger', 'nameplate-aegis', 'high-noon'],
  [...EARLY.slice(0, 5), 'rifle-overdrive', ...EARLY.slice(5), 'nameplate-ranger'],
  ['optic-reflex', 'grip-angled', 'optic-scope2', 'ignition', 'amber', 'arctic', 'reticle-dot', 'rookie', 'pathfinder'],
];
legacyFixtures.forEach((fixture, at) => assert.deepEqual(LEGACY_NODE_IDS.filter(id => careerItemState(fixture, id).eligible), LEGACY_ELIGIBLE[at],
  `legacy fixture ${at} keeps its eligible set`));
// The documented lowered gates, one step either side.
const lowered = (level, mastery, extra = {}) => ({ ...profile(level), mastery, ...extra });
assert.equal(careerItemState(lowered(12, { rifle: { kills: 50, headshots: 0, botKills: 800 } }), 'rifle-overdrive').eligible, true, 'L12 + rifle score 250');
assert.equal(careerItemState(lowered(12, { rifle: { kills: 50, headshots: 0, botKills: 799 } }), 'rifle-overdrive').eligible, false, 'rifle score 249 stays locked');
assert.equal(careerItemState(lowered(11, { rifle: { kills: 250, headshots: 0 } }), 'rifle-overdrive').eligible, false, 'level 11 stays locked');
assert.equal(careerItemState(lowered(34, { revolver: { kills: 999, headshots: 0 } }), 'revolver-high-noon').eligible, false, 'revolver score 999 stays locked');
assert.equal(careerItemState(lowered(34, { revolver: { kills: 1000, headshots: 0 } }), 'revolver-high-noon').eligible, true);
assert.equal(careerItemState(lowered(44, { minigun: { kills: 2499, headshots: 0 } }), 'minigun-foundry').eligible, false, 'minigun score 2,499 stays locked');
assert.equal(careerItemState(lowered(44, { minigun: { kills: 2500, headshots: 0 } }), 'minigun-foundry').eligible, true);
assert.equal(careerItemState(lowered(25, {}, { kills: 9999, pvpKills: 9999 }), 'revenant').eligible, false, 'combat score 9,999 stays locked');
assert.equal(careerItemState(lowered(24, {}, { kills: 10000, pvpKills: 10000 }), 'revenant').eligible, false, 'level 24 stays locked');
assert.equal(careerItemState(lowered(25, {}, { kills: 10000, pvpKills: 10000 }), 'revenant').eligible, true);

// Upcoming unlocks and goals.
const upcoming = upcomingUnlocks(levelTwo, 50);
assert.ok(upcoming.length > 0 && upcoming.every(node => careerItemState(levelTwo, node).status === 'next' && careerItemState(levelTwo, node).gate === 'level'));
assert.ok(upcoming.every(node => node.branch !== 'mastery'), 'upcoming unlocks are level-track only');
for (let at = 1; at < upcoming.length; at++) assert.ok(upcoming[at - 1].level <= upcoming[at].level, 'upcoming unlocks sort by XP');
assert.equal(upcomingUnlocks(levelTwo).length, 6);
const goals = nextGoals(levelTwo);
assert.deepEqual(goals.map(goal => goal.type), ['level', 'mastery', 'chase']);
assert.deepEqual(goals[0], { type: 'level', id: upcoming[0].id, current: levelTwo.xp, target: xpForLevel(upcoming[0].level),
  remaining: xpForLevel(upcoming[0].level) - levelTwo.xp, unit: 'xp' });
assert.deepEqual(goals[1], { type: 'mastery', id: 'mastery-rifle-1', weapon: 'rifle', current: 0, target: 50, remaining: 50, unit: 'score' });
assert.deepEqual(goals[2], { type: 'chase', id: 'revenant', current: 0, target: 10000, remaining: 10000, unit: 'score' });
const smgFan = { ...levelTwo, mastery: { smg: { kills: 40, headshots: 0, botKills: 20 } } };
assert.equal(nextGoals(smgFan)[1].weapon, 'smg', 'the closest weapon tier is the mastery goal');
assert.equal(nextGoals(smgFan)[1].current, 45);
const tracks = masteryTracks(smgFan);
assert.deepEqual(tracks.map(track => track.weapon), WEAPON_IDS);
const smg = tracks.find(track => track.weapon === 'smg');
assert.deepEqual({ score: smg.score, kills: smg.kills, botKills: smg.botKills, tier: smg.tier, tierId: smg.tierId, next: smg.next.id, progress: smg.progress },
  { score: 45, kills: 40, botKills: 20, tier: -1, tierId: null, next: 'initiated', progress: 45 / 50 });
assert.deepEqual(tracks[0].rewards.map(reward => reward.id), ['mastery-rifle-1', 'rifle-overdrive', 'mastery-rifle-2', 'mastery-rifle-3', 'mastery-rifle-master']);
for (const track of tracks) assert.ok(track.rewards.filter(reward => reward.id.startsWith('mastery-')).length === 4, `${track.weapon} pays out on every tier`);

// ---------- theme/title reset ----------
const reset = profile(4);
equipCareerItem(reset, 'mint'); equipCareerItem(reset, 'vanguard');
equipCareerItem(reset, { id: 'standard', kind: 'theme' });
equipCareerItem(reset, { id: 'standard', kind: 'title' });
assert.equal(reset.equipped.theme, 'amber', 'a theme reset returns to amber');
assert.equal(reset.equipped.title, 'rookie', 'a title reset returns to rookie');
assert.throws(() => equipCareerItem(reset, { id: 'standard', kind: 'attachment' }), /valid cosmetic slot/);

// ---------- profile size ----------
const everything = { ...emptyProfile(), xp: xpForLevel(200), kills: 1e6, pvpKills: 1e6, wins: 1e5, matches: 1e5,
  mastery: Object.fromEntries(WEAPON_IDS.map(weapon => [weapon, { kills: 1e6, headshots: 1e5, botKills: 1e6 }])) };
reconcileCareerUnlocks(everything);
assert.equal(everything.owned.length, 108);
for (const node of PROGRESSION_TREE) if (node.kind !== 'attachment' && node.kind !== 'theme' && node.kind !== 'title') equipCareerItem(everything, node.id);
assert.ok(JSON.stringify(validateProfile(everything)).length < 16384, 'a profile owning every id fits the import cap');
assert.equal(cosmeticLoadout(everything).nameplate, 'nameplate-arsenal', 'the last nameplate equipped wins');

// ---------- attachment gating ----------
assert.deepEqual(unlockedParts(emptyProfile()), { optic: ['standard'], grip: ['standard'], counter: ['standard'] },
  'a new career owns only factory parts');
const scoped = profile(18);
assert.ok(unlockedParts(scoped).optic.includes('scope4'), 'reaching level 18 opens the 4x scope');
assert.equal(unlockedParts(scoped).optic.includes('scope10'), false, 'a deeper optic stays closed');
assert.deepEqual(careerView(scoped).unlockedParts, unlockedParts(scoped), 'the armory receives the unlocked parts');
for (const level of [1, 2, 18, 51, 52, 100]) {
  const view = careerView(profile(level));
  assert.equal(view.level, level);
  assert.equal(view.levelStart, xpForLevel(level), `level ${level} starts at xpForLevel`);
  assert.equal(view.nextLevel, xpForLevel(level + 1), `level ${level} ends at xpForLevel(level + 1)`);
}

// A stored selection is preserved and only filtered on delivery.
const saved = validateProfile({ ...profile(2), equipped: { ...profile(2).equipped,
  weaponAttachments: { rifle: { optic: 'scope4', grip: 'standard', counter: 'standard' } } } });
assert.equal(saved.equipped.weaponAttachments.rifle.optic, 'scope4', 'storage keeps the locked part');
assert.equal(allowedWeaponLoadout(saved).rifle, undefined, 'delivery downgrades a locked optic to factory');
assert.throws(() => assertUnlockedAttachments(saved, 'rifle', { optic: 'scope4', grip: 'standard', counter: 'standard' }),
  /Unlock this attachment/, 'the write path refuses a locked part');
const opened = validateProfile({ ...saved, xp: xpForLevel(18) });
assert.equal(allowedWeaponLoadout(opened).rifle.optic, 'scope4', 'the saved setup returns once the node opens');

console.log(`Progression tree: ${PROGRESSION_TREE.length} nodes across ${PROGRESSION_BRANCHES.length} branches, topological single-pass grants, permanent ownership, forgery rejection and attachment gating passed.`);
