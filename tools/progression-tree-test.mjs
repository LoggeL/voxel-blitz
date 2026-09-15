import assert from 'node:assert/strict';
import { PROGRESSION_TREE, PROGRESSION_BRANCHES, CAREER_CATALOG, CAREER_REWARDS, careerItemState,
  reconcileCareerUnlocks, unlockedParts, careerView, careerLevel, equipCareerItem, treeNode,
  childrenOf, branchRoots, defaultCosmeticLoadout, EQUIPPABLE_SLOTS } from '../shared/career.js';
import { OPTICS, GRIPS, COUNTERS, ATTACHMENT_SLOTS } from '../shared/weapon-attachments.js';
import { WEAPON_IDS } from '../shared/combatmath.js';
import { emptyProfile, validateProfile, CAREER_COUNTERS } from '../server/persistence/career-profile.js';
import { allowedWeaponLoadout, assertUnlockedAttachments } from '../server/weapon-loadouts.js';

const xpForLevel = level => (level - 1) ** 2 * 100;
const profile = (level, extra = {}) => validateProfile({ ...emptyProfile(), xp: xpForLevel(level), ...extra });

// ---------- structure ----------
const ids = PROGRESSION_TREE.map(node => node.id);
assert.equal(new Set(ids).size, ids.length, 'node IDs are unique');
assert.deepEqual(PROGRESSION_BRANCHES.map(branch => branch.id), ['weapons', 'character', 'presentation']);
const CATALOGS = { optic: OPTICS, grip: GRIPS, counter: COUNTERS };
for (const [at, node] of PROGRESSION_TREE.entries()) {
  assert.ok(PROGRESSION_BRANCHES.some(branch => branch.id === node.branch), `${node.id} names a real branch`);
  assert.ok(Number.isInteger(node.level) && node.level >= 1, `${node.id} has a level`);
  assert.ok(node.name && node.detail, `${node.id} has copy`);
  assert.equal(node.price, undefined, `${node.id} carries no price`);
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
  if (node.masteryKills || node.pvpKills) assert.equal(childrenOf(node.id).length, 0, `${node.id} gates progress for other nodes`);
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
  const orphan = { ...emptyProfile(), xp: xpForLevel(node.level), pvpKills: node.pvpKills || 0,
    mastery: node.masteryKills ? { [node.weapon]: { kills: node.masteryKills, headshots: 0 } } : {} };
  orphan.owned = ['amber', 'rookie'].filter(id => id !== node.parent);
  const state = careerItemState(orphan, node);
  if (!orphan.owned.includes(node.parent)) {
    assert.equal(state.blockedByParent, true, `${node.id} reports its parent gate`);
    assert.equal(state.eligible, false, `${node.id} cannot open before its parent`);
  }
}

const maxed = { ...emptyProfile(), xp: xpForLevel(100), pvpKills: 10000,
  mastery: Object.fromEntries(WEAPON_IDS.map(weapon => [weapon, { kills: 10000, headshots: 0 }])) };
const granted = reconcileCareerUnlocks(maxed);
assert.equal(maxed.owned.length, PROGRESSION_TREE.length, 'one pass opens every node for a complete profile');
assert.ok(granted.length > 0);
assert.deepEqual(reconcileCareerUnlocks(maxed), [], 'grants are idempotent');

const returning = { ...emptyProfile(), xp: xpForLevel(36) };
const cascade = reconcileCareerUnlocks(returning);
assert.ok(cascade.length > 10, 'a long absence opens a whole chain in one pass');
assert.ok(cascade.includes('optic-scope10'), 'deep spine nodes cascade behind their parents');

// Exact boundaries, for every gate the tree declares.
for (const node of PROGRESSION_TREE.filter(node => node.masteryKills || node.pvpKills)) {
  const ready = { ...emptyProfile(), xp: xpForLevel(100), pvpKills: 10000,
    mastery: Object.fromEntries(WEAPON_IDS.map(weapon => [weapon, { kills: 10000, headshots: 0 }])) };
  reconcileCareerUnlocks(ready);
  const short = { ...ready, owned: ready.owned.filter(id => id !== node.id),
    pvpKills: node.pvpKills ? node.pvpKills - 1 : ready.pvpKills,
    mastery: { ...ready.mastery, ...(node.masteryKills ? { [node.weapon]: { kills: node.masteryKills - 1, headshots: 0 } } : {}) } };
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
assert.throws(() => equipCareerItem(forged, 'rifle-overdrive'), /not been unlocked/);
assert.throws(() => equipCareerItem(maxed, 'optic-scope4'), /armory/, 'attachments are not cosmetic slots');
for (const slot of EQUIPPABLE_SLOTS) assert.ok(Object.hasOwn(defaultCosmeticLoadout(), slot), `${slot} has a loadout entry`);

// ---------- attachment gating ----------
assert.deepEqual(unlockedParts(emptyProfile()), { optic: ['standard'], grip: ['standard'], counter: ['standard'] },
  'a new career owns only factory parts');
const scoped = profile(18);
assert.ok(unlockedParts(scoped).optic.includes('scope4'), 'reaching level 18 opens the 4x scope');
assert.equal(unlockedParts(scoped).optic.includes('scope10'), false, 'a deeper optic stays closed');
assert.deepEqual(careerView(scoped).unlockedParts, unlockedParts(scoped), 'the armory receives the unlocked parts');

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
