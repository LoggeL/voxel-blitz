// Pure armory view models over `careerView` and shared/career.js. No DOM.
import {
  PROGRESSION_BRANCHES, PROGRESSION_TREE, LOADOUT_SLOTS, MASTERY_TIERS, MASTERY_BADGES,
  careerItemState, childrenOf, branchRoots, masteryTracks, treeNode, xpForLevel, serviceStars,
} from '../../../../shared/career.js';
import { WEAPON_IDS } from '../../../../shared/combatmath.js';
import { OPTICS, GRIPS, COUNTERS, normalizeAttachments } from '../../../../shared/weapon-attachments.js';
import { WEAPON_NAMES } from '../hud-support.js';

export const format = value => Number(value || 0).toLocaleString('en-US');
const INDEX = new Map(PROGRESSION_TREE.map((item, at) => [item.id, at]));
const TRACKS = new Map(PROGRESSION_BRANCHES.map(branch => [branch.id, branch.track]));
export const levelTrack = item => TRACKS.get(item?.branch) === 'level';
export const LEVEL_BRANCHES = PROGRESSION_BRANCHES.filter(branch => branch.track === 'level');
const SLOT_IDS = LOADOUT_SLOTS.map(slot => slot.id);
export const slotOf = id => LOADOUT_SLOTS.find(slot => slot.id === id) || null;
export const weaponName = weapon => WEAPON_NAMES[weapon] || String(weapon || '').toUpperCase();
const titleCase = text => text.toLowerCase().replace(/(^|[^a-z])([a-z])/g, (_, lead, letter) => lead + letter.toUpperCase());
export const badgeName = weapon => titleCase(MASTERY_BADGES[weapon] || weapon);
/** Kinds the LOADOUT tab equips; weapon skins and attachments live on the WEAPONS tab. */
export const equippable = item => !!item && (item.kind === 'weaponSkin' || SLOT_IDS.includes(item.kind));

const subtreeSize = new Map();
for (const item of [...PROGRESSION_TREE].reverse()) {
  subtreeSize.set(item.id, 1 + childrenOf(item.id).reduce((sum, id) => sum + subtreeSize.get(id), 0));
}

/** Spine compression: each lane follows the child with the largest subtree (ties
 * in declaration order); every other child starts a side lane nested under the
 * node it branches from. Returns one lane per root: [{id, lane, sides:[lane…]}]. */
export function branchLanes(branchId) {
  let counter = 0;
  const lane = start => {
    const index = counter++, steps = [];
    for (let id = start; id;) {
      const children = childrenOf(id);
      const spine = children.reduce((best, child) => !best || subtreeSize.get(child) > subtreeSize.get(best) ? child : best, null);
      const step = { id, lane: index, sides: [] };
      steps.push(step);
      step.sides = children.filter(child => child !== spine).map(child => lane(child));
      id = spine;
    }
    return steps;
  };
  return branchRoots(branchId).map(root => lane(root));
}

/** Flattened lane order, for counting and for tests. */
export function laneIds(lanes) {
  const ids = [];
  const walk = steps => { for (const step of steps) { ids.push(step.id); step.sides.forEach(walk); } };
  lanes.forEach(walk);
  return ids;
}

/** Level journey: the next reward levels, ascending, grouped by level. */
export function journey(profile, limit = 6) {
  const xp = Math.max(0, Number(profile?.xp) || 0), level = profile?.level || 1;
  const owned = new Set(profile?.owned || []);
  const pending = PROGRESSION_TREE.filter(item => levelTrack(item) && !item.masteryTier && !item.combatScore && !item.arsenal && !owned.has(item.id));
  const levels = [...new Set(pending.map(item => item.level))].sort((a, b) => a - b);
  const stops = levels.slice(0, Math.max(0, limit)).map(at => ({
    level: at, target: xpForLevel(at), xpToGo: Math.max(0, xpForLevel(at) - xp),
    items: pending.filter(item => item.level === at).map(item => item.id),
  }));
  const start = profile?.levelStart ?? xpForLevel(level), next = profile?.nextLevel ?? xpForLevel(level + 1);
  return { level, xp, stars: serviceStars(level), progress: next > start ? Math.min(1, Math.max(0, (xp - start) / (next - start))) : 1,
    stops, complete: levels.length === 0 };
}

function gateChip(item, state) {
  const pending = state.requirements.find(requirement => !requirement.complete);
  if (state.blockedByParent || !pending) return state.blockedByParent ? `AFTER ${treeNode(item.parent)?.name.toUpperCase() || 'PARENT'}` : '';
  if (pending.label === 'Career level') return `LV ${item.level}`;
  if (item.masteryTier) return `${pending.label.split(' · ')[1]} · ${format(pending.current)} / ${format(pending.target)}`;
  if (item.arsenal) return `${format(pending.current)} / ${format(pending.target)} AT ${pending.label.split(' at ')[1] || ''}`.trim();
  return `COMBAT ${format(pending.current)} / ${format(pending.target)}`;
}

/** One reward tile: status word, chip text and progress for the nearest missing gate. */
export function tileState(profile, id) {
  const item = treeNode(id);
  const state = careerItemState(profile, id);
  const chip = state.status === 'equipped' ? 'EQUIPPED' : state.status === 'owned' ? '' : gateChip(item, state);
  const word = { equipped: 'Equipped.', owned: 'Unlocked.', next: 'Next up.', locked: 'Locked.' }[state.status];
  return { id, item, state: state.status, chip, word, gate: state.gate, xpToGo: state.xpToGo, progress: state.progress,
    requirements: state.requirements, blockedByParent: state.blockedByParent, owned: state.owned && !state.locked };
}

const itemsForSlot = slotId => PROGRESSION_TREE.filter(item => item.kind === slotId);
const equippedIn = (profile, slotId) => profile?.equipped?.[slotId] || slotOf(slotId)?.standard || 'standard';
export const itemName = id => id === 'standard' ? 'Standard' : treeNode(id)?.name || 'Standard';

/** Options for one slot: STANDARD (only for empty-able slots), then owned, next and
 * locked, each in declaration order. Titles and nameplates tag mastery rewards. */
export function slotOptions(profile, slotId) {
  const slot = slotOf(slotId);
  if (!slot) return [];
  const current = equippedIn(profile, slotId);
  const rank = { equipped: 0, owned: 0, next: 1, locked: 2 };
  const options = itemsForSlot(slotId).map(item => ({ ...tileState(profile, item.id),
    group: item.branch === 'mastery' ? 'mastery' : 'career', weapon: item.weapon || null }))
    .sort((a, b) => rank[a.state] - rank[b.state] || INDEX.get(a.id) - INDEX.get(b.id));
  if (slot.standard !== 'standard') return options;
  const standard = current === 'standard';
  return [{ id: 'standard', item: null, state: standard ? 'equipped' : 'owned', chip: standard ? 'EQUIPPED' : '',
    word: standard ? 'Equipped.' : 'Unlocked.', group: 'career', weapon: null, owned: true, requirements: [] }, ...options];
}

/** LOADOUT rail: each slot with its equipped item and unlock count, plus one row per weapon. */
export function loadoutModel(profile, isNew = () => false) {
  const slots = LOADOUT_SLOTS.map(slot => {
    const items = itemsForSlot(slot.id), equipped = equippedIn(profile, slot.id);
    const unlocked = items.filter(item => tileState(profile, item.id).owned).length;
    return { ...slot, equipped, equippedName: itemName(equipped), unlocked, total: items.length,
      isNew: items.some(item => isNew(item.id)) };
  });
  const weapons = WEAPON_IDS.map(weapon => {
    const skin = profile?.equipped?.weaponSkins?.[weapon] || 'standard';
    const parts = normalizeAttachments(weapon, profile?.equipped?.weaponAttachments?.[weapon]);
    const summary = [itemName(skin),
      parts.optic === 'standard' ? 'Factory sights' : OPTICS[parts.optic].name.replace(/ (sight|scope)$/i, ''),
      parts.grip === 'standard' ? 'Factory grip' : GRIPS[parts.grip].name.replace(/ (foregrip|grip)$/i, ''),
      ...(parts.counter !== 'standard' ? [COUNTERS[parts.counter].name.replace(/ counter$/i, '')] : [])].join(' · ');
    return { weapon, name: weaponName(weapon), skin, attachments: parts, summary };
  });
  return { slots, weapons };
}

/** Mastery cards. `closest` puts the weapon nearest its next tier first; MASTER rows go last. */
export function masteryCards(profile, sort = 'closest') {
  const cards = masteryTracks(profile).map(track => ({ ...track, name: weaponName(track.weapon), badgeName: badgeName(track.weapon),
    nextReward: track.next ? treeNode(track.next.reward) : null, tiers: MASTERY_TIERS.map((tier, at) => ({ ...tier, reached: track.tier >= at })) }));
  if (sort !== 'closest') return cards;
  return cards.sort((a, b) => (!a.next) - (!b.next) || b.progress - a.progress || b.score - a.score
    || WEAPON_IDS.indexOf(a.weapon) - WEAPON_IDS.indexOf(b.weapon));
}

/** Which tabs show a given reward, for the per-tab NEW dots. */
export const TAB_HOLDS = Object.freeze({
  loadout: item => SLOT_IDS.includes(item?.kind),
  weapons: item => item?.kind === 'attachment' || item?.kind === 'weaponSkin',
  progress: item => levelTrack(item),
  mastery: item => item?.branch === 'mastery' || !!item?.masteryTier || !!item?.combatScore,
});
