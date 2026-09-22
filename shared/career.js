import { WEAPON_IDS, WEAPONS } from './combatmath.js';

/** Career progression is one tree. A node opens when every listed requirement is
 * complete and its parent is already unlocked; nothing is ever bought. Branch
 * spines carry only level gates, so a mastery reward can never dead-end the
 * tree: every node with an extra requirement is a leaf. */
export const PROGRESSION_BRANCHES = Object.freeze([
  Object.freeze({ id: 'weapons', name: 'WEAPONS', detail: 'Optics, grips and weapon rewards.' }),
  Object.freeze({ id: 'character', name: 'CHARACTER', detail: 'Operator skins and death signatures.' }),
  Object.freeze({ id: 'presentation', name: 'PRESENTATION', detail: 'HUD, callsigns, reticles, nameplates and sound kits.' }),
]);

const node = (branch, value) => Object.freeze({ parent: null, ...value, branch });
const optic = (id, part, level, parent, name, detail) => node('weapons', { id, kind: 'attachment', slot: 'optic', part, level, parent, name, detail });
const grip = (id, part, level, parent, name, detail) => node('weapons', { id, kind: 'attachment', slot: 'grip', part, level, parent, name, detail });

export const PROGRESSION_TREE = Object.freeze([
  // WEAPONS -- the spine is pure handling, opened by career level alone.
  optic('optic-reflex', 'reflex', 2, null, 'Reflex sight', 'An open red dot for close targets, on every compatible weapon.'),
  grip('grip-angled', 'angled', 5, 'optic-reflex', 'Angled foregrip', 'Faster turns, slightly less recoil control.'),
  node('weapons', { id: 'counter-stattrak', kind: 'attachment', slot: 'counter', part: 'stattrak', level: 10, parent: 'grip-angled',
    name: 'StatTrak counter', detail: 'An LED tally of confirmed human kills. Changes no handling.' }),
  optic('optic-scope2', 'scope2', 8, 'optic-reflex', '2x tube sight', 'More reach with a small handling cost.'),
  grip('grip-vertical', 'vertical', 12, 'optic-scope2', 'Vertical foregrip', 'Less upward recoil, slower turns.'),
  node('weapons', { id: 'rifle-overdrive', kind: 'weaponSkin', weapon: 'rifle', level: 15, parent: 'grip-vertical', masteryKills: 250,
    color: '#ba82ff', rarity: 'rare', collection: 'Overdrive', preview: '/assets/cosmetics/rifle-overdrive.png',
    name: 'Overdrive', detail: 'Violet reactor rails and carbon armor for your rifle. Earned against human opponents.' }),
  optic('optic-scope4', 'scope4', 18, 'grip-vertical', '4x combat scope', 'A clear magnified view for distant targets.'),
  grip('grip-precision', 'precision', 26, 'optic-scope4', 'Precision grip', 'Calmer sway and side drift, heavier handling.'),
  optic('optic-scope10', 'scope10', 34, 'grip-precision', '10x precision scope', 'Long-range precision for the sniper rifle.'),
  node('weapons', { id: 'revolver-high-noon', kind: 'weaponSkin', weapon: 'revolver', level: 35, parent: 'optic-scope10', masteryKills: 1000,
    color: '#edbc68', rarity: 'epic', collection: 'High Noon', preview: '/assets/cosmetics/revolver-high-noon.png',
    name: 'High Noon', detail: 'Engraved brass, dark steel and a carved grip. Earned against human opponents.' }),
  optic('optic-cyber', 'cyber', 44, 'optic-scope10', 'CY-9 cyber scope', 'Railgun-tuned digital sight with a live charge readout.'),
  node('weapons', { id: 'minigun-foundry', kind: 'weaponSkin', weapon: 'minigun', level: 75, parent: 'optic-cyber', masteryKills: 5000,
    color: '#ff7846', rarity: 'legendary', collection: 'Foundry', preview: '/assets/cosmetics/minigun-foundry.png',
    name: 'Foundry', detail: 'Industrial hazard armor and furnace vents. A long-term minigun mastery reward.' }),
  // BLOCKWORKS -- IRON PICK material tiers. The level tiers chain; mastery tiers are leaves.
  node('weapons', { id: 'pickaxe-timber', kind: 'weaponSkin', weapon: 'knife', level: 3, parent: 'optic-reflex',
    color: '#b08a55', rarity: 'common', collection: 'Blockworks', preview: '/assets/cosmetics/pickaxe-timber.png',
    name: 'Timber', detail: 'A plank-cut pick head for your IRON PICK. Where every dig begins.' }),
  node('weapons', { id: 'pickaxe-cobble', kind: 'weaponSkin', weapon: 'knife', level: 7, parent: 'pickaxe-timber',
    color: '#9a9a9b', rarity: 'uncommon', collection: 'Blockworks', preview: '/assets/cosmetics/pickaxe-cobble.png',
    name: 'Cobble', detail: 'A knapped stone head on a trusty stick. Heavier looking, same swing.' }),
  node('weapons', { id: 'pickaxe-gilded', kind: 'weaponSkin', weapon: 'knife', level: 20, parent: 'pickaxe-cobble',
    color: '#f6d86a', rarity: 'rare', collection: 'Blockworks', preview: '/assets/cosmetics/pickaxe-gilded.png',
    name: 'Gilded', detail: 'Soft polished gold. Impractical underground, glorious in the arena.' }),
  node('weapons', { id: 'pickaxe-deep-diamond', kind: 'weaponSkin', weapon: 'knife', level: 40, parent: 'pickaxe-gilded',
    color: '#74efdc', rarity: 'epic', collection: 'Blockworks', preview: '/assets/cosmetics/pickaxe-deep-diamond.png',
    name: 'Deep Diamond', detail: 'Cyan facets with a faint inner light, cut from the deepest layer.' }),
  node('weapons', { id: 'pickaxe-ashforged', kind: 'weaponSkin', weapon: 'knife', level: 45, parent: 'pickaxe-deep-diamond', masteryKills: 500,
    color: '#9a7f70', rarity: 'legendary', collection: 'Blockworks', preview: '/assets/cosmetics/pickaxe-ashforged.png',
    name: 'Ashforged', detail: 'Near-black alloy on a charred stick. Earned with 500 pick kills against human opponents.' }),
  node('weapons', { id: 'pickaxe-runebound', kind: 'weaponSkin', weapon: 'knife', level: 60, parent: 'pickaxe-deep-diamond', masteryKills: 2500,
    color: '#9a5cff', rarity: 'legendary', collection: 'Blockworks', preview: '/assets/cosmetics/pickaxe-runebound.png',
    name: 'Runebound', detail: 'A diamond pick wrapped in a drifting violet enchantment glint. 2,500 pick kills against human opponents.' }),

  // CHARACTER
  node('character', { id: 'ignition', kind: 'signature', level: 5, parent: null, color: '#ff954f', rarity: 'uncommon', collection: 'Foundry',
    name: 'Ignition', detail: 'An angular ember signature on your opponent\'s death card.' }),
  node('character', { id: 'salvager', kind: 'characterSkin', level: 25, parent: 'ignition', color: '#dbae61', rarity: 'rare', collection: 'Foundry',
    preview: '/assets/cosmetics/salvager.png', name: 'Salvager', detail: 'Layered salvage armor, reinforced gauntlets and workshop hardware.' }),
  node('character', { id: 'circuit', kind: 'signature', level: 25, parent: 'ignition', color: '#a682ff', rarity: 'rare', collection: 'Overdrive',
    name: 'Circuit', detail: 'A violet circuit pattern signs your eliminations.' }),
  node('character', { id: 'sovereign', kind: 'signature', level: 75, parent: 'circuit', color: '#f4d77a', rarity: 'legendary', collection: 'High Noon',
    name: 'Sovereign', detail: 'A gold crest for the arena\'s most persistent players.' }),
  node('character', { id: 'revenant', kind: 'characterSkin', level: 100, parent: 'salvager', pvpKills: 10000, color: '#bb91ff', rarity: 'legendary',
    collection: 'Overdrive', preview: '/assets/cosmetics/revenant.png',
    name: 'Revenant', detail: 'Obsidian armor and violet energy channels for a veteran of 10,000 PvP kills.' }),

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
]);

/** The flat view every catalog consumer already expects. */
export const CAREER_CATALOG = PROGRESSION_TREE;
const ITEMS = new Map(PROGRESSION_TREE.map(item => [item.id, item]));
const INDEX = new Map(PROGRESSION_TREE.map((item, at) => [item.id, at]));
const CHILDREN = new Map();
if (ITEMS.size !== PROGRESSION_TREE.length) throw new Error('Progression node IDs must be unique');
PROGRESSION_TREE.forEach((item, at) => {
  if (item.parent === null) return;
  const parent = ITEMS.get(item.parent);
  // Parents are declared before their children, so one reconcile pass grants a
  // whole chain and a child can never gate on a level its parent has not reached.
  // Appending a node out of order would only delay its grant by one pass, which
  // is invisible at runtime -- hence the hard failure here.
  if (!parent) throw new Error(`Progression node ${item.id} names an undeclared parent`);
  if (INDEX.get(item.parent) >= at) throw new Error(`Progression node ${item.id} is declared before its parent`);
  if (parent.level > item.level) throw new Error(`Progression node ${item.id} unlocks before its parent`);
  if (parent.branch !== item.branch) throw new Error(`Progression node ${item.id} leaves its branch`);
  CHILDREN.set(item.parent, [...CHILDREN.get(item.parent) || [], item.id]);
});
export const treeNode = id => ITEMS.get(id) || null;
export const childrenOf = id => CHILDREN.get(id) || [];
export const branchRoots = branch => PROGRESSION_TREE.filter(item => item.branch === branch && item.parent === null).map(item => item.id);

export const EQUIPPABLE_SLOTS = Object.freeze(['characterSkin', 'signature', 'sound', 'reticle', 'nameplate']);
/** Always-owned profile slots: they hold a real item and have no 'standard' value. */
export const PROFILE_SLOTS = Object.freeze(['theme', 'title']);
export const CAREER_REWARDS = Object.freeze({
  kill: { xp: 25 }, botKill: { xp: 10 },
  objective: { xp: 75 }, activeMinute: { xp: 20 },
  match: { xp: 100 }, victory: { xp: 50 },
});
export function careerLevel(xp) { return 1 + Math.floor(Math.sqrt(Math.max(0, Number.isFinite(xp) ? xp : 0) / 100)); }
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

export function careerItemState(profile, value) {
  const item = ITEMS.get(typeof value === 'string' ? value : value?.id);
  if (!item) return { owned: false, equipped: false, locked: true, eligible: false, blockedByParent: false, progress: 0, requirements: [] };
  const requirement = (label, current, target) => ({ label, current, target, complete: current >= target });
  const requirements = [requirement('Career level', careerLevel(profile?.xp), item.level)];
  if (item.masteryKills) requirements.push(requirement(`${WEAPONS[item.weapon]?.name || item.weapon} PvP kills`, profile?.mastery?.[item.weapon]?.kills || 0, item.masteryKills));
  if (item.pvpKills) requirements.push(requirement('PvP kills', profile?.pvpKills || 0, item.pvpKills));
  const owned = !!profile?.owned?.includes(item.id);
  // A grant is permanent: inserting a parent above an already-owned node must not
  // silently strip the cosmetic a player has equipped for months. The requirement
  // gates below still apply to owned nodes, so a forged `owned` entry cannot
  // equip a mastery reward the profile has not actually earned.
  const blockedByParent = !owned && item.parent !== null && !profile?.owned?.includes(item.parent);
  const eligible = !blockedByParent && requirements.every(value => value.complete);
  const equipped = item.kind === 'weaponSkin' ? profile?.equipped?.weaponSkins?.[item.weapon] === item.id
    : EQUIPPABLE_SLOTS.includes(item.kind) || PROFILE_SLOTS.includes(item.kind) ? profile?.equipped?.[item.kind] === item.id : false;
  return { owned, equipped, eligible, blockedByParent, locked: !eligible,
    progress: Math.min(...requirements.map(value => Math.min(1, value.current / value.target))), requirements };
}

/** Permanent grants. One pass suffices because declaration order is topological. */
export function reconcileCareerUnlocks(profile) {
  const granted = [];
  for (const item of PROGRESSION_TREE) {
    if (!profile.owned.includes(item.id) && careerItemState(profile, item).eligible) {
      profile.owned.push(item.id);
      granted.push(item.id);
    }
  }
  return granted;
}

/** Attachment parts the profile has opened. `standard` never needs unlocking.
 * Plain arrays, not Sets: this rides `careerView` to the armory as JSON. */
export function unlockedParts(profile) {
  const result = { optic: ['standard'], grip: ['standard'], counter: ['standard'] };
  for (const item of PROGRESSION_TREE) {
    if (item.kind === 'attachment' && !careerItemState(profile, item).locked && profile?.owned?.includes(item.id)) result[item.slot].push(item.part);
  }
  return result;
}

export function cosmeticLoadout(profile) {
  const loadout = normalizeCosmeticLoadout(profile?.equipped);
  const allowed = id => {
    const state = careerItemState(profile, id);
    return state.owned && !state.locked;
  };
  for (const [weapon, id] of Object.entries(loadout.weaponSkins)) if (!allowed(id)) delete loadout.weaponSkins[weapon];
  for (const kind of EQUIPPABLE_SLOTS) if (!allowed(loadout[kind])) loadout[kind] = 'standard';
  return loadout;
}

/** Mutates one owned slot; a standard descriptor resets it. Nothing is ever charged. */
export function equipCareerItem(profile, value) {
  if (value?.id === 'standard') {
    if (value.kind === 'weaponSkin' && WEAPON_IDS.includes(value.weapon)) delete profile.equipped.weaponSkins[value.weapon];
    else if (EQUIPPABLE_SLOTS.includes(value.kind)) profile.equipped[value.kind] = 'standard';
    // PROFILE_SLOTS (theme/title) have no standard value, so they cannot be reset.
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
    levelStart: (level - 1) ** 2 * 100, nextLevel: level ** 2 * 100 };
}
