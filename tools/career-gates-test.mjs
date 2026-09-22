import assert from 'node:assert/strict';
import { PROGRESSION_TREE, LEGACY_NODE_IDS, careerItemState, careerLevel, legacyCareerLevel, xpForLevel, treeNode,
  reconcileCareerUnlocks, unlockedParts, cosmeticLoadout, masteryScore, combatScore, CATALOG_ALIASES, resolveCatalogId,
  serviceStars } from '../shared/career.js';
import { WEAPON_IDS } from '../shared/combatmath.js';
import { emptyProfile, validateProfile } from '../server/persistence/career-profile.js';

/** The pre-redesign catalog gates, frozen by hand. Never derive this from shared code:
 * it is the contract that no id disappears and no gate ever goes up. */
const LEGACY_GATES = Object.freeze({
  'optic-reflex': { kind: 'attachment', branch: 'weapons', parent: null, level: 2 },
  'grip-angled': { kind: 'attachment', branch: 'weapons', parent: 'optic-reflex', level: 5 },
  'counter-stattrak': { kind: 'attachment', branch: 'weapons', parent: 'grip-angled', level: 10 },
  'optic-scope2': { kind: 'attachment', branch: 'weapons', parent: 'optic-reflex', level: 8 },
  'grip-vertical': { kind: 'attachment', branch: 'weapons', parent: 'optic-scope2', level: 12 },
  'rifle-overdrive': { kind: 'weaponSkin', branch: 'weapons', parent: 'grip-vertical', weapon: 'rifle', level: 15, masteryKills: 250 },
  'optic-scope4': { kind: 'attachment', branch: 'weapons', parent: 'grip-vertical', level: 18 },
  'grip-precision': { kind: 'attachment', branch: 'weapons', parent: 'optic-scope4', level: 26 },
  'optic-scope10': { kind: 'attachment', branch: 'weapons', parent: 'grip-precision', level: 34 },
  'revolver-high-noon': { kind: 'weaponSkin', branch: 'weapons', parent: 'optic-scope10', weapon: 'revolver', level: 35, masteryKills: 1000 },
  'optic-cyber': { kind: 'attachment', branch: 'weapons', parent: 'optic-scope10', level: 44 },
  'minigun-foundry': { kind: 'weaponSkin', branch: 'weapons', parent: 'optic-cyber', weapon: 'minigun', level: 75, masteryKills: 5000 },
  ignition: { kind: 'signature', branch: 'character', parent: null, level: 5 },
  salvager: { kind: 'characterSkin', branch: 'character', parent: 'ignition', level: 25 },
  circuit: { kind: 'signature', branch: 'character', parent: 'ignition', level: 25 },
  sovereign: { kind: 'signature', branch: 'character', parent: 'circuit', level: 75 },
  revenant: { kind: 'characterSkin', branch: 'character', parent: 'salvager', level: 100, pvpKills: 10000 },
  amber: { kind: 'theme', branch: 'presentation', parent: null, level: 1 },
  arctic: { kind: 'theme', branch: 'presentation', parent: 'amber', level: 2 },
  'reticle-dot': { kind: 'reticle', branch: 'presentation', parent: 'amber', level: 3 },
  orchid: { kind: 'theme', branch: 'presentation', parent: 'arctic', level: 3 },
  mint: { kind: 'theme', branch: 'presentation', parent: 'orchid', level: 4 },
  rookie: { kind: 'title', branch: 'presentation', parent: null, level: 1 },
  pathfinder: { kind: 'title', branch: 'presentation', parent: 'rookie', level: 2 },
  vanguard: { kind: 'title', branch: 'presentation', parent: 'pathfinder', level: 4 },
  veteran: { kind: 'title', branch: 'presentation', parent: 'vanguard', level: 6 },
  'reticle-chevron': { kind: 'reticle', branch: 'presentation', parent: 'reticle-dot', level: 9 },
  arcade: { kind: 'sound', branch: 'presentation', parent: 'veteran', level: 10 },
  'nameplate-ranger': { kind: 'nameplate', branch: 'presentation', parent: 'veteran', level: 14 },
  'nameplate-aegis': { kind: 'nameplate', branch: 'presentation', parent: 'nameplate-ranger', level: 30 },
  'high-noon': { kind: 'sound', branch: 'presentation', parent: 'arcade', level: 35 },
  'reticle-halo': { kind: 'reticle', branch: 'presentation', parent: 'reticle-chevron', level: 40 },
  overdrive: { kind: 'sound', branch: 'presentation', parent: 'high-noon', level: 50 },
  'nameplate-eclipse': { kind: 'nameplate', branch: 'presentation', parent: 'nameplate-aegis', level: 60 },
});
const LEGACY_ORDER = Object.keys(LEGACY_GATES);

// ---------- every legacy id survives unchanged in shape; gates only go down ----------
assert.equal(LEGACY_ORDER.length, 34);
assert.deepEqual([...LEGACY_NODE_IDS], LEGACY_ORDER, 'LEGACY_NODE_IDS keeps the shipped declaration order');
for (const [id, old] of Object.entries(LEGACY_GATES)) {
  const node = treeNode(id);
  assert.ok(node, `${id} still exists`);
  for (const key of ['kind', 'branch', 'parent']) assert.equal(node[key], old[key], `${id} keeps its ${key}`);
  assert.equal(node.weapon, old.weapon, `${id} keeps its weapon`);
  assert.ok(node.level <= old.level, `${id} level gate never rises (${node.level} > ${old.level})`);
  assert.equal(node.masteryKills, undefined);
  assert.equal(node.pvpKills, undefined);
}
const declared = PROGRESSION_TREE.map(node => node.id);
for (let at = 1; at < LEGACY_ORDER.length; at++) assert.ok(declared.indexOf(LEGACY_ORDER[at - 1]) < declared.indexOf(LEGACY_ORDER[at]),
  'legacy nodes keep their relative declaration order');
assert.deepEqual(CATALOG_ALIASES, {}, 'no id has been retired');
assert.equal(resolveCatalogId('arctic'), 'arctic');

// ---------- the curve never drops a level ----------
const boundaries = [0, 1, 99, 100, 399, 400, 249999, 250000, 259899, 259900, 735100, 980100, 3e6];
for (let xp = 0; xp <= 3e6; xp += 37) assert.ok(careerLevel(xp) >= legacyCareerLevel(xp), `curve drops a level at ${xp} XP`);
for (const xp of boundaries) assert.ok(careerLevel(xp) >= legacyCareerLevel(xp), `curve drops a level at ${xp} XP`);
assert.equal(careerLevel(249999), 50);
assert.equal(careerLevel(250000), 51);
assert.equal(careerLevel(259899), 51);
assert.equal(careerLevel(259900), 52);
assert.equal(legacyCareerLevel(980100), 100);
assert.equal(careerLevel(980100), 124, 'the documented veteran level jump');
for (let level = 1; level <= 200; level++) {
  assert.equal(careerLevel(xpForLevel(level)), level, `xpForLevel(${level}) opens level ${level}`);
  assert.equal(careerLevel(xpForLevel(level) - 1), Math.max(1, level - 1), `one XP short of level ${level}`);
  assert.ok(xpForLevel(level) <= (level - 1) ** 2 * 100, `level ${level} costs no more than before`);
}
assert.deepEqual([99, 100, 104, 105, 109, 110, 124].map(serviceStars), [0, 0, 0, 1, 1, 2, 4]);

// ---------- brute force: everything eligible before is eligible now ----------
const legacyLevel = xp => 1 + Math.floor(Math.sqrt(Math.max(0, Number.isFinite(xp) ? xp : 0) / 100));
/** An inline copy of the pre-redesign careerItemState eligibility rule. */
function legacyEligible(profile, id) {
  const gate = LEGACY_GATES[id];
  const requirements = [legacyLevel(profile.xp) >= gate.level];
  if (gate.masteryKills) requirements.push((profile.mastery?.[gate.weapon]?.kills || 0) >= gate.masteryKills);
  if (gate.pvpKills) requirements.push((profile.pvpKills || 0) >= gate.pvpKills);
  const owned = profile.owned.includes(id);
  const blockedByParent = !owned && gate.parent !== null && !profile.owned.includes(gate.parent);
  return !blockedByParent && requirements.every(Boolean);
}

let seed = 0x5eed1e55;
const random = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const int = max => Math.floor(random() * (max + 1));
const skewed = max => Math.floor(random() ** 3 * (max + 1));
let checked = 0, gained = 0;
for (let run = 0; run < 2000; run++) {
  const pvpKills = skewed(14000), kills = pvpKills + skewed(40000);
  const mastery = {};
  for (const weapon of WEAPON_IDS) if (random() < 0.6) {
    const humans = skewed(6000);
    mastery[weapon] = { kills: humans, headshots: int(humans), ...(random() < 0.5 ? { botKills: skewed(12000) } : {}) };
  }
  const owned = ['amber', 'rookie', ...LEGACY_ORDER.filter(id => !['amber', 'rookie'].includes(id) && random() < 0.3)];
  const profile = { xp: random() < 0.1 ? [0, 99, 249999, 250000, 259899, 259900, 980100][int(6)] : skewed(1.5e6),
    kills, pvpKills, matches: 0, wins: 0, mastery, owned,
    equipped: { theme: 'amber', title: 'rookie', weaponSkins: {}, characterSkin: 'standard', signature: 'standard',
      sound: 'standard', reticle: 'standard', nameplate: 'standard' } };
  for (const row of Object.values(mastery)) assert.ok(masteryScore(row) >= row.kills, 'mastery score never drops below human kills');
  assert.ok(combatScore(profile) >= pvpKills, 'combat score never drops below PvP kills');
  assert.ok(careerLevel(profile.xp) >= legacyLevel(profile.xp));
  for (const id of LEGACY_ORDER) {
    const before = legacyEligible(profile, id), now = careerItemState(profile, id).eligible;
    if (before) assert.equal(now, true, `${id} re-locked for ${JSON.stringify(profile)}`);
    else if (now) gained++;
    checked++;
  }
  // The consumers of eligibility keep every legitimately earned item.
  const parts = unlockedParts(profile);
  for (const id of LEGACY_ORDER.filter(id => treeNode(id).kind === 'attachment' && owned.includes(id) && legacyEligible(profile, id)))
    assert.ok(parts[treeNode(id).slot].includes(treeNode(id).part), `${id} stays mountable`);
  const loadout = cosmeticLoadout({ ...profile, equipped: { ...profile.equipped,
    weaponSkins: Object.fromEntries(['rifle-overdrive', 'revolver-high-noon', 'minigun-foundry'].filter(id => owned.includes(id) && legacyEligible(profile, id))
      .map(id => [treeNode(id).weapon, id])),
    characterSkin: ['revenant', 'salvager'].find(id => owned.includes(id) && legacyEligible(profile, id)) || 'standard' } });
  for (const id of ['rifle-overdrive', 'revolver-high-noon', 'minigun-foundry'])
    if (owned.includes(id) && legacyEligible(profile, id)) assert.equal(loadout.weaponSkins[treeNode(id).weapon], id, `${id} stays equipped`);
  // Reconcile only ever adds, and a legacy profile always validates.
  const reconciled = validateProfile(profile);
  for (const id of owned) assert.ok(reconciled.owned.includes(id), `${id} ownership survives a read`);
  assert.deepEqual(reconcileCareerUnlocks(reconciled), [], 'a validated profile is fully reconciled');
}
assert.ok(checked === 2000 * 34 && gained > 0, 'lowered gates open new items for some profiles');

// Legacy mastery rows round-trip byte-for-byte: `botKills` only appears once earned.
const legacyRow = validateProfile({ ...emptyProfile(), mastery: { rifle: { kills: 3, headshots: 1 } } });
assert.deepEqual(legacyRow.mastery, { rifle: { kills: 3, headshots: 1 } });
assert.deepEqual(validateProfile({ ...emptyProfile(), mastery: { rifle: { kills: 3, headshots: 1, botKills: 0 } } }).mastery, { rifle: { kills: 3, headshots: 1 } });
assert.throws(() => validateProfile({ ...emptyProfile(), mastery: { rifle: { kills: 3, headshots: 1, botKills: -1 } } }), /mastery/);

console.log(`Career gates: 34 legacy ids keep shape with gates that only go down, the curve never drops a level to 3M XP, and ${checked} seeded legacy eligibility checks never re-lock (${gained} newly opened).`);
