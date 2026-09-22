import { WEAPON_IDS } from './combatmath.js';
import { MASTERY_TIERS, MASTERY_BADGES, masteryTier, masteryScore, combatScore, masteryTierIndex } from './career-mastery.js';

export { MASTERY_TIERS, MASTERY_BADGES, BOT_MASTERY_DIVISOR, BOT_MASTERY_CAP_PER_MATCH, COMBAT_SCORE_BOT_DIVISOR,
  MASTERY_RULES_TEXT, masteryTier, masteryScore, combatScore, arsenalCount, masteryTierIndex } from './career-mastery.js';

/** Career progression is one tree. A node opens when its career level, at most
 * one extra gate (mastery tier, combat score or arsenal) and its parent are all
 * complete; nothing is ever bought. Branch spines carry only level gates, so a
 * mastery reward can never dead-end the tree: every gated node is a leaf. */
export const PROGRESSION_BRANCHES = Object.freeze([
  Object.freeze({ id: 'weapons', name: 'WEAPONS', track: 'level', detail: 'Optics, grips and weapon rewards.' }),
  Object.freeze({ id: 'character', name: 'CHARACTER', track: 'level', detail: 'Operator skins and death signatures.' }),
  Object.freeze({ id: 'presentation', name: 'PRESENTATION', track: 'level', detail: 'HUD, callsigns, reticles, nameplates and sound kits.' }),
  Object.freeze({ id: 'mastery', name: 'MASTERY', track: 'mastery', detail: 'Weapon mastery and arsenal rewards.' }),
]);

const node = (branch, value) => Object.freeze({ parent: null, ...value, branch });
const optic = (id, part, level, parent, name, detail) => node('weapons', { id, kind: 'attachment', slot: 'optic', part, level, parent, name, detail });
const grip = (id, part, level, parent, name, detail) => node('weapons', { id, kind: 'attachment', slot: 'grip', part, level, parent, name, detail });
const title = (id, level, parent, name, color, rarity) => node('presentation', { id, kind: 'title', level, parent, color,
  ...(rarity ? { rarity } : {}), name, detail: 'A new callsign on your career badge.' });
const theme = (id, level, parent, name, color, shade) => node('presentation', { id, kind: 'theme', level, parent, color, name, detail: `${shade} HUD and reticle.` });
const nameplate = (id, level, parent, badge, color, shade, rarity) => node('presentation', { id, kind: 'nameplate', level, parent, badge, color,
  ...(rarity ? { rarity } : {}), name: `${badge[0]}${badge.slice(1).toLowerCase()} nameplate`, detail: `A ${shade} badge beside your name on the scoreboard.` });
const reticle = (id, shape, level, parent, color, name, detail) => node('presentation', { id, kind: 'reticle', level, parent, reticle: shape, color, name, detail });
const titleCase = text => text.toLowerCase().replace(/(^|[^a-z])([a-z])/g, (_, lead, letter) => lead + letter.toUpperCase());

/** Per-weapon mastery rewards, one per tier. Roots at level 1: the tier is the only real gate. */
const masteryNodes = WEAPON_IDS.flatMap(weapon => {
  const badge = MASTERY_BADGES[weapon], name = titleCase(badge);
  return MASTERY_TIERS.map((tier, at) => at < 3
    ? node('mastery', { id: `mastery-${weapon}-${at + 1}`, kind: 'nameplate', weapon, level: 1, masteryTier: tier.id,
      badge: `${badge} ${tier.numeral}`, color: tier.color, collection: 'Mastery', name: `${name} ${tier.numeral} nameplate`,
      detail: `The ${name} ${titleCase(tier.name)} mastery badge beside your name on the scoreboard.` })
    : node('mastery', { id: `mastery-${weapon}-master`, kind: 'title', weapon, level: 1, masteryTier: tier.id,
      color: tier.color, collection: 'Mastery', name: `${name} Master`, detail: `A callsign for players who mastered the ${name}.` }));
});

export const PROGRESSION_TREE = Object.freeze([
  // WEAPONS -- the spine is pure handling, opened by career level alone.
  optic('optic-reflex', 'reflex', 2, null, 'Reflex sight', 'An open red dot for close targets, on every compatible weapon.'),
  grip('grip-angled', 'angled', 5, 'optic-reflex', 'Angled foregrip', 'Faster turns, slightly less recoil control.'),
  node('weapons', { id: 'counter-stattrak', kind: 'attachment', slot: 'counter', part: 'stattrak', level: 10, parent: 'grip-angled',
    name: 'StatTrak counter', detail: 'An LED tally of confirmed human kills. Changes no handling.' }),
  optic('optic-scope2', 'scope2', 8, 'optic-reflex', '2x tube sight', 'More reach with a small handling cost.'),
  grip('grip-vertical', 'vertical', 12, 'optic-scope2', 'Vertical foregrip', 'Less upward recoil, slower turns.'),
  node('weapons', { id: 'rifle-overdrive', kind: 'weaponSkin', weapon: 'rifle', level: 12, parent: 'grip-vertical', masteryTier: 'specialist',
    color: '#ba82ff', rarity: 'rare', collection: 'Overdrive', preview: '/assets/cosmetics/rifle-overdrive.png',
    name: 'Overdrive', detail: 'Violet reactor rails and carbon armor for your rifle. A rifle Specialist mastery reward.' }),
  optic('optic-scope4', 'scope4', 18, 'grip-vertical', '4x combat scope', 'A clear magnified view for distant targets.'),
  grip('grip-precision', 'precision', 26, 'optic-scope4', 'Precision grip', 'Calmer sway and side drift, heavier handling.'),
  optic('optic-scope10', 'scope10', 34, 'grip-precision', '10x precision scope', 'Long-range precision for the sniper rifle.'),
  node('weapons', { id: 'revolver-high-noon', kind: 'weaponSkin', weapon: 'revolver', level: 34, parent: 'optic-scope10', masteryTier: 'elite',
    color: '#edbc68', rarity: 'epic', collection: 'High Noon', preview: '/assets/cosmetics/revolver-high-noon.png',
    name: 'High Noon', detail: 'Engraved brass, dark steel and a carved grip. An Elite revolver mastery reward.' }),
  optic('optic-cyber', 'cyber', 44, 'optic-scope10', 'CY-9 cyber scope', 'Railgun-tuned digital sight with a live charge readout.'),
  node('weapons', { id: 'minigun-foundry', kind: 'weaponSkin', weapon: 'minigun', level: 44, parent: 'optic-cyber', masteryTier: 'master',
    color: '#ff7846', rarity: 'legendary', collection: 'Foundry', preview: '/assets/cosmetics/minigun-foundry.png',
    name: 'Foundry', detail: 'Industrial hazard armor and furnace vents. A Master minigun mastery reward.' }),

  // CHARACTER
  node('character', { id: 'ignition', kind: 'signature', level: 5, parent: null, color: '#ff954f', rarity: 'uncommon', collection: 'Foundry',
    name: 'Ignition', detail: 'An angular ember signature on your opponent\'s death card.' }),
  node('character', { id: 'salvager', kind: 'characterSkin', level: 25, parent: 'ignition', color: '#dbae61', rarity: 'rare', collection: 'Foundry',
    preview: '/assets/cosmetics/salvager.png', name: 'Salvager', detail: 'Layered salvage armor, reinforced gauntlets and scavenged hardware.' }),
  node('character', { id: 'circuit', kind: 'signature', level: 25, parent: 'ignition', color: '#a682ff', rarity: 'rare', collection: 'Overdrive',
    name: 'Circuit', detail: 'A violet circuit pattern signs your eliminations.' }),
  node('character', { id: 'sovereign', kind: 'signature', level: 75, parent: 'circuit', color: '#f4d77a', rarity: 'legendary', collection: 'High Noon',
    name: 'Sovereign', detail: 'A gold crest for the arena\'s most persistent players.' }),
  node('character', { id: 'revenant', kind: 'characterSkin', level: 25, parent: 'salvager', combatScore: 10000, color: '#bb91ff', rarity: 'legendary',
    collection: 'Overdrive', preview: '/assets/cosmetics/revenant.png',
    name: 'Revenant', detail: 'Obsidian armor and violet energy channels for players with 10,000 combat score.' }),

  // PRESENTATION -- two roots: the starting HUD theme and the starting callsign.
  node('presentation', { id: 'amber', kind: 'theme', level: 1, parent: null, color: '#ffb347', name: 'Amber', detail: 'Warm amber HUD and reticle.' }),
  node('presentation', { id: 'arctic', kind: 'theme', level: 2, parent: 'amber', color: '#72e6ff', name: 'Arctic', detail: 'Ice blue HUD and reticle.' }),
  node('presentation', { id: 'reticle-dot', kind: 'reticle', level: 3, parent: 'amber', reticle: 'dot', color: '#ffd479',
    name: 'Dot reticle', detail: 'A single center dot with no arms. An unobstructed view of your target.' }),
  node('presentation', { id: 'orchid', kind: 'theme', level: 3, parent: 'arctic', color: '#dca0ff', name: 'Orchid', detail: 'Violet HUD and reticle.' }),
  node('presentation', { id: 'mint', kind: 'theme', level: 4, parent: 'orchid', color: '#80ffc0', name: 'Mint', detail: 'Mint green HUD and reticle.' }),
  node('presentation', { id: 'rookie', kind: 'title', level: 1, parent: null, name: 'Rookie', detail: 'Your starting callsign.' }),
  node('presentation', { id: 'pathfinder', kind: 'title', level: 2, parent: 'rookie', name: 'Pathfinder', detail: 'A new callsign on your career badge.' }),
  node('presentation', { id: 'vanguard', kind: 'title', level: 4, parent: 'pathfinder', name: 'Vanguard', detail: 'A new callsign on your career badge.' }),
  node('presentation', { id: 'veteran', kind: 'title', level: 6, parent: 'vanguard', name: 'Veteran', detail: 'A new callsign on your career badge.' }),
  node('presentation', { id: 'reticle-chevron', kind: 'reticle', level: 9, parent: 'reticle-dot', reticle: 'chevron', color: '#9fe8ff',
    name: 'Chevron reticle', detail: 'A downward-open angle instead of four arms.' }),
  node('presentation', { id: 'arcade', kind: 'sound', level: 10, parent: 'veteran', audio: '/assets/audio/cosmetics/arcade/',
    color: '#65e8d5', rarity: 'uncommon', collection: 'Arcade', name: 'Arcade', detail: 'Original chiptune kill accent, death sting and victory music.' }),
  node('presentation', { id: 'nameplate-ranger', kind: 'nameplate', level: 14, parent: 'veteran', badge: 'RANGER', color: '#7fd4a0',
    name: 'Ranger nameplate', detail: 'A green service badge beside your name on the scoreboard.' }),
  node('presentation', { id: 'nameplate-aegis', kind: 'nameplate', level: 30, parent: 'nameplate-ranger', badge: 'AEGIS', color: '#77b6ff',
    name: 'Aegis nameplate', detail: 'A blue shield badge beside your name on the scoreboard.' }),
  node('presentation', { id: 'high-noon', kind: 'sound', level: 35, parent: 'arcade', audio: '/assets/audio/cosmetics/high-noon/',
    color: '#edbc68', rarity: 'epic', collection: 'High Noon', name: 'High Noon', detail: 'Original western kill accent, death sting and victory music.' }),
  node('presentation', { id: 'reticle-halo', kind: 'reticle', level: 40, parent: 'reticle-chevron', reticle: 'halo', color: '#ffb0f0',
    name: 'Halo reticle', detail: 'A thin ring with a center dot that widens with your spread.' }),
  node('presentation', { id: 'overdrive', kind: 'sound', level: 50, parent: 'high-noon', audio: '/assets/audio/cosmetics/overdrive/',
    color: '#ba82ff', rarity: 'epic', collection: 'Overdrive', name: 'Overdrive', detail: 'Original electronic kill accent, death sting and victory music.' }),
  node('presentation', { id: 'nameplate-eclipse', kind: 'nameplate', level: 60, parent: 'nameplate-aegis', badge: 'ECLIPSE', color: '#c69bff',
    name: 'Eclipse nameplate', detail: 'A violet badge beside your name on the scoreboard.' }),
  // Level-track content to 100: data and CSS only, appended so parents stay declared first.
  title('tactician', 16, 'veteran', 'Tactician', '#9fb4c8', 'uncommon'),
  theme('ember', 21, 'mint', 'Ember', '#ff7a3d', 'Ember orange'),
  reticle('reticle-gap', 'gap', 23, 'reticle-chevron', '#b8f0ff', 'Gap reticle', 'Four short arms around a wide open center that keeps the target clear.'),
  title('operator', 28, 'tactician', 'Operator', '#8fd0ff'),
  nameplate('nameplate-bulwark', 32, 'nameplate-aegis', 'BULWARK', '#a0b8d0', 'steel blue', 'rare'),
  theme('jade', 37, 'ember', 'Jade', '#3ddc97', 'Jade green'),
  title('sentinel', 42, 'operator', 'Sentinel', '#77b6ff'),
  reticle('reticle-bracket', 'bracket', 47, 'reticle-gap', '#ffc27a', 'Bracket reticle', 'Two corner brackets frame your target instead of four arms.'),
  title('warden', 53, 'sentinel', 'Warden', '#7fd4a0', 'epic'),
  theme('cobalt', 56, 'jade', 'Cobalt', '#5a8cff', 'Cobalt blue'),
  nameplate('nameplate-onyx', 64, 'nameplate-eclipse', 'ONYX', '#8a8f9c', 'dark onyx', 'epic'),
  title('commander', 68, 'warden', 'Commander', '#ffb347'),
  theme('crimson', 72, 'cobalt', 'Crimson', '#ff5a5a', 'Crimson red'),
  reticle('reticle-diamond', 'diamond', 80, 'reticle-bracket', '#ff9ad5', 'Diamond reticle', 'A small diamond outline marks the center of your aim.'),
  title('legend', 85, 'commander', 'Legend', '#dca0ff', 'legendary'),
  theme('solar', 90, 'crimson', 'Solar', '#ffd23f', 'Solar gold'),
  nameplate('nameplate-centurion', 95, 'nameplate-onyx', 'CENTURION', '#e0c080', 'bronze gold'),
  title('immortal', 100, 'legend', 'Immortal', '#f4d77a', 'legendary'),
  nameplate('nameplate-zenith', 100, 'nameplate-centurion', 'ZENITH', '#fff1a8', 'pale gold', 'legendary'),

  // MASTERY -- per-weapon tier rewards, then arsenal rewards across all weapons.
  ...masteryNodes,
  node('mastery', { id: 'armorer', kind: 'title', level: 1, arsenal: Object.freeze({ tier: 'specialist', count: 5 }), color: '#c8d2dc',
    collection: 'Mastery', name: 'Armorer', detail: 'A callsign for reaching SPECIALIST with five weapons.' }),
  node('mastery', { id: 'nameplate-arsenal', kind: 'nameplate', level: 1, arsenal: Object.freeze({ tier: 'elite', count: 13 }), badge: 'ARSENAL',
    color: '#ffd23f', collection: 'Mastery', name: 'Arsenal nameplate', detail: 'A gold badge beside your name for reaching ELITE with every weapon.' }),
  node('mastery', { id: 'armsmaster', kind: 'title', level: 1, arsenal: Object.freeze({ tier: 'master', count: 13 }), color: '#b98cff',
    rarity: 'legendary', collection: 'Mastery', name: 'Armsmaster', detail: 'A callsign for reaching MASTER with every weapon.' }),
]);

/** The 34 ids that shipped before the armory redesign, in their declaration order.
 * Every one keeps its kind, branch, parent and weapon; gates only ever go down. */
export const LEGACY_NODE_IDS = Object.freeze(['optic-reflex', 'grip-angled', 'counter-stattrak', 'optic-scope2', 'grip-vertical',
  'rifle-overdrive', 'optic-scope4', 'grip-precision', 'optic-scope10', 'revolver-high-noon', 'optic-cyber', 'minigun-foundry',
  'ignition', 'salvager', 'circuit', 'sovereign', 'revenant', 'amber', 'arctic', 'reticle-dot', 'orchid', 'mint', 'rookie',
  'pathfinder', 'vanguard', 'veteran', 'reticle-chevron', 'arcade', 'nameplate-ranger', 'nameplate-aegis', 'high-noon',
  'reticle-halo', 'overdrive', 'nameplate-eclipse']);
/** retiredId -> successorId. Stored profiles are resolved through it before validation. */
export const CATALOG_ALIASES = Object.freeze({});
export const resolveCatalogId = id => Object.hasOwn(CATALOG_ALIASES, id) ? CATALOG_ALIASES[id] : id;

/** The flat view every catalog consumer already expects. */
export const CAREER_CATALOG = PROGRESSION_TREE;
const ITEMS = new Map(PROGRESSION_TREE.map(item => [item.id, item]));
const INDEX = new Map(PROGRESSION_TREE.map((item, at) => [item.id, at]));
const CHILDREN = new Map();
const TRACKS = new Map(PROGRESSION_BRANCHES.map(branch => [branch.id, branch.track]));
const RETICLES = ['dot', 'chevron', 'halo', 'gap', 'bracket', 'diamond'];
const REQUIRED = { theme: ['color'], nameplate: ['badge', 'color'], reticle: ['reticle'], sound: ['audio'], attachment: ['slot', 'part'], weaponSkin: ['weapon'] };
const extraGates = item => ['masteryTier', 'combatScore', 'arsenal'].filter(key => item[key] !== undefined);
if (ITEMS.size !== PROGRESSION_TREE.length) throw new Error('Progression node IDs must be unique');
PROGRESSION_TREE.forEach((item, at) => {
  if (!TRACKS.has(item.branch)) throw new Error(`Progression node ${item.id} names an unknown branch`);
  if (!Number.isInteger(item.level) || item.level < 1) throw new Error(`Progression node ${item.id} needs a career level`);
  for (const field of REQUIRED[item.kind] || []) if (item[field] === undefined) throw new Error(`Progression node ${item.id} is missing ${field}`);
  if (item.kind === 'reticle' && !RETICLES.includes(item.reticle)) throw new Error(`Progression node ${item.id} names an unknown reticle`);
  const gates = extraGates(item);
  if (gates.length > 1) throw new Error(`Progression node ${item.id} carries more than one extra gate`);
  if (item.masteryTier !== undefined && (!masteryTier(item.masteryTier) || !WEAPON_IDS.includes(item.weapon)))
    throw new Error(`Progression node ${item.id} names an unknown mastery tier or weapon`);
  if (item.combatScore !== undefined && !(Number.isSafeInteger(item.combatScore) && item.combatScore > 0))
    throw new Error(`Progression node ${item.id} has an invalid combat score gate`);
  if (item.arsenal !== undefined && (!masteryTier(item.arsenal.tier) || !Number.isInteger(item.arsenal.count)
    || item.arsenal.count < 1 || item.arsenal.count > WEAPON_IDS.length)) throw new Error(`Progression node ${item.id} has an invalid arsenal gate`);
  if (item.branch === 'mastery' && (item.parent !== null || item.level !== 1)) throw new Error(`Mastery node ${item.id} must be a level-1 root`);
  if (item.parent === null) {
    // A gated root's only real gate is its extra requirement.
    if (gates.length && item.level !== 1) throw new Error(`Progression node ${item.id} stacks a level gate on its extra gate`);
    return;
  }
  const parent = ITEMS.get(item.parent);
  // Parents are declared before their children, so one reconcile pass grants a
  // whole chain and a child can never gate on a level its parent has not reached.
  // Appending a node out of order would only delay its grant by one pass, which
  // is invisible at runtime -- hence the hard failure here.
  if (!parent) throw new Error(`Progression node ${item.id} names an undeclared parent`);
  if (INDEX.get(item.parent) >= at) throw new Error(`Progression node ${item.id} is declared before its parent`);
  if (parent.level > item.level) throw new Error(`Progression node ${item.id} unlocks before its parent`);
  if (parent.branch !== item.branch) throw new Error(`Progression node ${item.id} leaves its branch`);
  if (gates.length && parent.level !== item.level) throw new Error(`Progression node ${item.id} stacks a level gate on its extra gate`);
  CHILDREN.set(item.parent, [...CHILDREN.get(item.parent) || [], item.id]);
});
// Only leaves may carry an extra gate, so a mastery grind can never dead-end a branch.
for (const item of PROGRESSION_TREE) if (extraGates(item).length && CHILDREN.has(item.id)) throw new Error(`Gated node ${item.id} must be a leaf`);
for (const id of ['amber', 'rookie']) if (ITEMS.get(id)?.parent !== null || ITEMS.get(id)?.level !== 1) throw new Error(`${id} must stay a level-1 root`);
for (const id of LEGACY_NODE_IDS) if (!ITEMS.has(id)) throw new Error(`Legacy node ${id} was removed`);

export const treeNode = id => ITEMS.get(id) || null;
export const childrenOf = id => CHILDREN.get(id) || [];
export const branchRoots = branch => PROGRESSION_TREE.filter(item => item.branch === branch && item.parent === null).map(item => item.id);

export const KIND_LABELS = Object.freeze({ weaponSkin: 'WEAPON SKIN', characterSkin: 'OPERATOR SKIN', signature: 'DEATH SIGNATURE',
  sound: 'SOUND KIT', theme: 'HUD THEME', title: 'CALLSIGN', attachment: 'ATTACHMENT', reticle: 'RETICLE', nameplate: 'NAMEPLATE' });
/** UI order. `standard` is the reset target; `wire` slots ride match snapshots. */
export const LOADOUT_SLOTS = Object.freeze([
  { id: 'characterSkin', label: 'OPERATOR SKIN', group: 'operator', standard: 'standard', wire: true, audience: 'Everyone in the match' },
  { id: 'signature', label: 'DEATH SIGNATURE', group: 'operator', standard: 'standard', wire: true, audience: 'Players you eliminate, on their death card' },
  { id: 'sound', label: 'SOUND KIT', group: 'operator', standard: 'standard', wire: true, audience: 'You on kills, your victims on death, the lobby when you win' },
  { id: 'theme', label: 'HUD THEME', group: 'hud', standard: 'amber', wire: false, audience: 'Only you: HUD accent and crosshair' },
  { id: 'title', label: 'CALLSIGN', group: 'hud', standard: 'rookie', wire: false, audience: 'Only you: career badge and menu card' },
  { id: 'reticle', label: 'RETICLE', group: 'hud', standard: 'standard', wire: true, audience: 'Only you: your crosshair' },
  { id: 'nameplate', label: 'NAMEPLATE', group: 'hud', standard: 'standard', wire: true, audience: 'Everyone, beside your name on the scoreboard' },
].map(slot => Object.freeze(slot)));
export const EQUIPPABLE_SLOTS = Object.freeze(LOADOUT_SLOTS.filter(slot => slot.wire).map(slot => slot.id));
const SLOT_IDS = LOADOUT_SLOTS.map(slot => slot.id);
const LOCAL_STANDARD = Object.fromEntries(LOADOUT_SLOTS.filter(slot => !slot.wire).map(slot => [slot.id, slot.standard]));

export const CAREER_REWARDS = Object.freeze({
  kill: { xp: 25 }, botKill: { xp: 10 },
  objective: { xp: 75 }, activeMinute: { xp: 20 },
  match: { xp: 100 }, victory: { xp: 50 },
});
/** UI copy for CAREER_REWARDS; the values always come from CAREER_REWARDS itself. */
export const CAREER_REWARD_RULES = Object.freeze([
  { id: 'kill', label: 'Human kill' }, { id: 'botKill', label: 'Bot kill' }, { id: 'activeMinute', label: 'Active minute' },
  { id: 'objective', label: 'Bomb plant or defuse' }, { id: 'match', label: 'Completed match (10 s active)' }, { id: 'victory', label: 'Win bonus' },
].map(rule => Object.freeze(rule)));

/** Square-root curve to level 51 (250,000 XP), then a flat 9,900 XP per level.
 * Every threshold is at or below the legacy curve, so no one ever loses a level. */
const CURVE_KNEE = 51, CURVE_KNEE_XP = 250000, CURVE_STEP = 9900;
const finiteXp = xp => Math.max(0, Number.isFinite(xp) ? xp : 0);
export function xpForLevel(level) {
  const at = Math.max(1, Math.floor(Number.isFinite(level) ? level : 1));
  return at <= CURVE_KNEE ? (at - 1) ** 2 * 100 : CURVE_KNEE_XP + (at - CURVE_KNEE) * CURVE_STEP;
}
export function careerLevel(xp) {
  const x = finiteXp(xp);
  return x < CURVE_KNEE_XP ? 1 + Math.floor(Math.sqrt(x / 100)) : CURVE_KNEE + Math.floor((x - CURVE_KNEE_XP) / CURVE_STEP);
}
/** The pre-redesign curve, frozen for the level-jump intro card and the monotonic-gate tests. */
export function legacyCareerLevel(xp) { return 1 + Math.floor(Math.sqrt(finiteXp(xp) / 100)); }
export const SERVICE_STARS = Object.freeze({ from: 100, every: 5 });
/** Display only: never stored, never a gate. */
export const serviceStars = level => Math.max(0, Math.floor(((Number.isFinite(level) ? level : 0) - SERVICE_STARS.from) / SERVICE_STARS.every));

export const defaultCosmeticLoadout = () => ({ weaponSkins: {}, characterSkin: 'standard', signature: 'standard', sound: 'standard', reticle: 'standard', nameplate: 'standard' });

/** Only catalog IDs cross the network. Client URLs and wrong weapon slots are discarded. */
export function normalizeCosmeticLoadout(value) {
  const result = defaultCosmeticLoadout();
  for (const weapon of WEAPON_IDS) {
    const item = ITEMS.get(value?.weaponSkins?.[weapon]);
    if (item?.kind === 'weaponSkin' && item.weapon === weapon) result.weaponSkins[weapon] = item.id;
  }
  for (const kind of EQUIPPABLE_SLOTS) {
    const item = ITEMS.get(value?.[kind]);
    if (item?.kind === kind) result[kind] = item.id;
  }
  return result;
}

const badgeName = weapon => titleCase(MASTERY_BADGES[weapon] || weapon);
const gateKind = item => item.masteryTier ? 'mastery' : item.combatScore ? 'combat' : item.arsenal ? 'arsenal' : 'level';

/** Everything a gate reads, computed once. Reconcile reuses one context per pass. */
function gateContext(profile) {
  const xp = finiteXp(profile?.xp);
  const scores = Object.fromEntries(WEAPON_IDS.map(weapon => [weapon, masteryScore(profile?.mastery?.[weapon])]));
  const arsenal = Object.fromEntries(MASTERY_TIERS.map(tier => [tier.id, WEAPON_IDS.filter(weapon => scores[weapon] >= tier.score).length]));
  return { profile, xp, level: careerLevel(xp), owned: new Set(profile?.owned || []), scores, arsenal, combat: combatScore(profile) };
}

function itemState(item, context) {
  const { profile, owned: ownedIds } = context;
  const requirement = (label, current, target) => ({ label, current, target, complete: current >= target });
  const requirements = [requirement('Career level', context.level, item.level)];
  if (item.masteryTier) {
    const tier = masteryTier(item.masteryTier);
    requirements.push(requirement(`${badgeName(item.weapon)} mastery · ${tier.name}`, context.scores[item.weapon] || 0, tier.score));
  }
  if (item.combatScore) requirements.push(requirement('Combat score', context.combat, item.combatScore));
  if (item.arsenal) requirements.push(requirement(`Weapons at ${masteryTier(item.arsenal.tier).name}`, context.arsenal[item.arsenal.tier], item.arsenal.count));
  const owned = ownedIds.has(item.id);
  // A grant is permanent: inserting a parent above an already-owned node must not
  // silently strip the cosmetic a player has equipped for months. The requirement
  // gates below still apply to owned nodes, so a forged `owned` entry cannot
  // equip a mastery reward the profile has not actually earned.
  const parentOwned = item.parent === null || ownedIds.has(item.parent);
  const blockedByParent = !owned && !parentOwned;
  const eligible = !blockedByParent && requirements.every(value => value.complete);
  const locked = !eligible;
  const equipped = item.kind === 'weaponSkin' ? profile?.equipped?.weaponSkins?.[item.weapon] === item.id
    : SLOT_IDS.includes(item.kind) ? profile?.equipped?.[item.kind] === item.id : false;
  const status = owned && !locked ? (equipped ? 'equipped' : 'owned') : !owned && parentOwned ? 'next' : 'locked';
  return { owned, equipped, eligible, blockedByParent, locked,
    progress: Math.min(...requirements.map(value => Math.min(1, value.current / value.target))), requirements,
    status, gate: gateKind(item), xpToGo: Math.max(0, xpForLevel(item.level) - context.xp) };
}

export function careerItemState(profile, value) {
  const item = ITEMS.get(typeof value === 'string' ? value : value?.id);
  if (!item) return { owned: false, equipped: false, locked: true, eligible: false, blockedByParent: false, progress: 0, requirements: [],
    status: 'locked', gate: 'level', xpToGo: 0 };
  return itemState(item, gateContext(profile));
}

/** Permanent grants. One pass suffices because declaration order is topological. */
export function reconcileCareerUnlocks(profile) {
  const granted = [], context = gateContext(profile);
  for (const item of PROGRESSION_TREE) {
    if (!context.owned.has(item.id) && itemState(item, context).eligible) {
      profile.owned.push(item.id);
      context.owned.add(item.id);
      granted.push(item.id);
    }
  }
  return granted;
}

/** Attachment parts the profile has opened. `standard` never needs unlocking.
 * Plain arrays, not Sets: this rides `careerView` to the armory as JSON. */
export function unlockedParts(profile) {
  const result = { optic: ['standard'], grip: ['standard'], counter: ['standard'] };
  const context = gateContext(profile);
  for (const item of PROGRESSION_TREE) {
    if (item.kind === 'attachment' && !itemState(item, context).locked && context.owned.has(item.id)) result[item.slot].push(item.part);
  }
  return result;
}

export function cosmeticLoadout(profile) {
  const loadout = normalizeCosmeticLoadout(profile?.equipped);
  const context = gateContext(profile);
  const allowed = id => {
    const item = ITEMS.get(id);
    if (!item) return false;
    const state = itemState(item, context);
    return state.owned && !state.locked;
  };
  for (const [weapon, id] of Object.entries(loadout.weaponSkins)) if (!allowed(id)) delete loadout.weaponSkins[weapon];
  for (const kind of EQUIPPABLE_SLOTS) if (!allowed(loadout[kind])) loadout[kind] = 'standard';
  return loadout;
}

/** Mutates one owned slot; a standard descriptor resets it. Theme and title have
 * no empty state, so their standard is the starting root. Nothing is ever charged. */
export function equipCareerItem(profile, value) {
  if (value?.id === 'standard') {
    if (value.kind === 'weaponSkin' && WEAPON_IDS.includes(value.weapon)) delete profile.equipped.weaponSkins[value.weapon];
    else if (EQUIPPABLE_SLOTS.includes(value.kind)) profile.equipped[value.kind] = 'standard';
    else if (Object.hasOwn(LOCAL_STANDARD, value.kind)) profile.equipped[value.kind] = LOCAL_STANDARD[value.kind];
    else throw new Error('Choose a valid cosmetic slot');
    return;
  }
  const item = ITEMS.get(typeof value === 'string' ? value : value?.id);
  const state = careerItemState(profile, item);
  if (!item || !state.owned || state.locked) throw new Error('This reward has not been unlocked yet');
  if (item.kind === 'attachment') throw new Error('Attachments are equipped in the armory');
  if (item.kind === 'weaponSkin') profile.equipped.weaponSkins[item.weapon] = item.id;
  else profile.equipped[item.kind] = item.id;
}

export function careerView(profile) {
  const level = careerLevel(profile.xp);
  return { ...profile, owned: [...profile.owned], equipped: { ...profile.equipped, weaponSkins: { ...profile.equipped.weaponSkins } },
    mastery: Object.fromEntries(Object.entries(profile.mastery || {}).map(([weapon, progress]) => [weapon, { ...progress }])),
    pvpKills: profile.pvpKills || 0, wins: profile.wins || 0, level, unlockedParts: unlockedParts(profile),
    levelStart: xpForLevel(level), nextLevel: xpForLevel(level + 1) };
}

const levelTrack = item => TRACKS.get(item.branch) === 'level';

/** Level-gated rewards whose parent is open, soonest first. Never returns a gated node. */
export function upcomingUnlocks(profile, limit = 6) {
  const context = gateContext(profile);
  return PROGRESSION_TREE.filter(item => levelTrack(item) && gateKind(item) === 'level')
    .map(item => ({ item, state: itemState(item, context) }))
    .filter(entry => entry.state.status === 'next')
    .sort((a, b) => a.state.xpToGo - b.state.xpToGo || INDEX.get(a.item.id) - INDEX.get(b.item.id))
    .slice(0, Math.max(0, limit)).map(entry => entry.item);
}

const TIER_INDEX = new Map(MASTERY_TIERS.map((tier, at) => [tier.id, at]));
const MASTERY_REWARDS = new Map(WEAPON_IDS.map(weapon => [weapon, PROGRESSION_TREE
  .filter(item => item.masteryTier && item.weapon === weapon)
  .sort((a, b) => TIER_INDEX.get(a.masteryTier) - TIER_INDEX.get(b.masteryTier) || INDEX.get(a.id) - INDEX.get(b.id))]));
const tierReward = (weapon, index) => `mastery-${weapon}-${index === 3 ? 'master' : index + 1}`;

/** One row per weapon: human-only kills and headshots, weighted bot kills, and every tier reward. */
export function masteryTracks(profile) {
  const context = gateContext(profile);
  return WEAPON_IDS.map(weapon => {
    const row = profile?.mastery?.[weapon];
    const score = context.scores[weapon], tier = masteryTierIndex(score), upcoming = MASTERY_TIERS[tier + 1] || null;
    return { weapon, badge: MASTERY_BADGES[weapon], score, kills: row?.kills || 0, botKills: row?.botKills || 0, headshots: row?.headshots || 0,
      tier, tierId: MASTERY_TIERS[tier]?.id || null,
      next: upcoming && { id: upcoming.id, score: upcoming.score, reward: tierReward(weapon, tier + 1) },
      progress: upcoming ? Math.min(1, score / upcoming.score) : 1,
      rewards: MASTERY_REWARDS.get(weapon).map(item => ({ id: item.id, tierId: item.masteryTier, status: itemState(item, context).status })) };
  });
}

/** Up to three goals: the next level reward, the closest mastery tier, and the closest long chase. */
export function nextGoals(profile) {
  const goals = [], xp = finiteXp(profile?.xp);
  const [level] = upcomingUnlocks(profile, 1);
  if (level) {
    const target = xpForLevel(level.level);
    goals.push({ type: 'level', id: level.id, current: xp, target, remaining: Math.max(0, target - xp), unit: 'xp' });
  }
  const [track] = masteryTracks(profile).filter(entry => entry.next)
    .sort((a, b) => b.progress - a.progress || b.score - a.score || WEAPON_IDS.indexOf(a.weapon) - WEAPON_IDS.indexOf(b.weapon));
  if (track) goals.push({ type: 'mastery', id: track.next.reward, weapon: track.weapon, current: track.score, target: track.next.score,
    remaining: Math.max(0, track.next.score - track.score), unit: 'score' });
  const context = gateContext(profile);
  const [chase] = PROGRESSION_TREE.filter(item => (item.combatScore || item.arsenal) && !context.owned.has(item.id))
    .map(item => ({ item, gate: itemState(item, context).requirements[1] }))
    .filter(entry => !entry.gate.complete)
    .sort((a, b) => b.gate.current / b.gate.target - a.gate.current / a.gate.target || INDEX.get(a.item.id) - INDEX.get(b.item.id));
  if (chase) goals.push({ type: 'chase', id: chase.item.id, current: chase.gate.current, target: chase.gate.target,
    remaining: chase.gate.target - chase.gate.current, unit: chase.item.arsenal ? 'weapons' : 'score' });
  return goals;
}
