import { WEAPON_IDS } from './combatmath.js';

const earned = (item) => ({ price: 0, unlock: 'earned', ...item });
export const CAREER_CATALOG = Object.freeze([
  { id: 'amber', name: 'Amber', kind: 'theme', price: 0, level: 1, color: '#ffb347', detail: 'Warm amber HUD and reticle' },
  { id: 'arctic', name: 'Arctic', kind: 'theme', price: 100, level: 2, color: '#72e6ff', detail: 'Ice blue HUD and reticle' },
  { id: 'orchid', name: 'Orchid', kind: 'theme', price: 250, level: 3, color: '#dca0ff', detail: 'Violet HUD and reticle' },
  { id: 'mint', name: 'Mint', kind: 'theme', price: 400, level: 4, color: '#80ffc0', detail: 'Mint green HUD and reticle' },
  { id: 'rookie', name: 'Rookie', kind: 'title', price: 0, level: 1, detail: 'Your starting callsign' },
  { id: 'pathfinder', name: 'Pathfinder', kind: 'title', price: 150, level: 2, detail: 'A new callsign on your career badge' },
  { id: 'vanguard', name: 'Vanguard', kind: 'title', price: 350, level: 4, detail: 'A new callsign on your career badge' },
  { id: 'veteran', name: 'Veteran', kind: 'title', price: 700, level: 6, detail: 'A new callsign on your career badge' },
  earned({ id: 'rifle-overdrive', name: 'Overdrive', kind: 'weaponSkin', weapon: 'rifle', level: 15,
    masteryKills: 250, color: '#ba82ff', rarity: 'rare', collection: 'Overdrive', preview: '/assets/cosmetics/rifle-overdrive.png',
    detail: 'Violet reactor rails and carbon armor for your rifle. Earned against human opponents.' }),
  earned({ id: 'revolver-high-noon', name: 'High Noon', kind: 'weaponSkin', weapon: 'revolver', level: 35,
    masteryKills: 1000, color: '#edbc68', rarity: 'epic', collection: 'High Noon', preview: '/assets/cosmetics/revolver-high-noon.png',
    detail: 'Engraved brass, dark steel and a carved grip. Earned against human opponents.' }),
  earned({ id: 'minigun-foundry', name: 'Foundry', kind: 'weaponSkin', weapon: 'minigun', level: 75,
    masteryKills: 5000, color: '#ff7846', rarity: 'legendary', collection: 'Foundry', preview: '/assets/cosmetics/minigun-foundry.png',
    detail: 'Industrial hazard armor and furnace vents. A long-term minigun mastery reward.' }),
  earned({ id: 'salvager', name: 'Salvager', kind: 'characterSkin', level: 25,
    color: '#dbae61', rarity: 'rare', collection: 'Foundry', preview: '/assets/cosmetics/salvager.png',
    detail: 'Layered salvage armor, reinforced gauntlets and workshop hardware.' }),
  earned({ id: 'revenant', name: 'Revenant', kind: 'characterSkin', level: 100, pvpKills: 10000,
    color: '#bb91ff', rarity: 'legendary', collection: 'Overdrive', preview: '/assets/cosmetics/revenant.png',
    detail: 'Obsidian armor and violet energy channels for a veteran of 10,000 PvP kills.' }),
  earned({ id: 'ignition', name: 'Ignition', kind: 'signature', level: 5,
    color: '#ff954f', rarity: 'uncommon', collection: 'Foundry', detail: 'An angular ember signature on your opponent\'s death card.' }),
  earned({ id: 'circuit', name: 'Circuit', kind: 'signature', level: 25,
    color: '#a682ff', rarity: 'rare', collection: 'Overdrive', detail: 'A violet circuit pattern signs your eliminations.' }),
  earned({ id: 'sovereign', name: 'Sovereign', kind: 'signature', level: 75,
    color: '#f4d77a', rarity: 'legendary', collection: 'High Noon', detail: 'A gold crest for the arena\'s most persistent players.' }),
  earned({ id: 'arcade', name: 'Arcade', kind: 'sound', level: 10, audio: '/assets/audio/cosmetics/arcade/',
    color: '#65e8d5', rarity: 'uncommon', collection: 'Arcade', detail: 'Original chiptune kill accent, death sting and victory music.' }),
  earned({ id: 'high-noon', name: 'High Noon', kind: 'sound', level: 35, audio: '/assets/audio/cosmetics/high-noon/',
    color: '#edbc68', rarity: 'epic', collection: 'High Noon', detail: 'Original western kill accent, death sting and victory music.' }),
  earned({ id: 'overdrive', name: 'Overdrive', kind: 'sound', level: 50, audio: '/assets/audio/cosmetics/overdrive/',
    color: '#ba82ff', rarity: 'epic', collection: 'Overdrive', detail: 'Original electronic kill accent, death sting and victory music.' }),
].map(Object.freeze));
const ITEMS = new Map(CAREER_CATALOG.map(item => [item.id, item]));
export const CAREER_REWARDS = Object.freeze({
  kill: { xp: 25, credits: 10 }, botKill: { xp: 10, credits: 4 },
  objective: { xp: 75, credits: 30 }, activeMinute: { xp: 20, credits: 8 },
  match: { xp: 100, credits: 40 }, victory: { xp: 50, credits: 20 },
});
export function careerLevel(xp) { return 1 + Math.floor(Math.sqrt(Math.max(0, Number.isFinite(xp) ? xp : 0) / 100)); }
export const defaultCosmeticLoadout = () => ({ weaponSkins: {}, characterSkin: 'standard', signature: 'standard', sound: 'standard' });

/** Only catalog IDs cross the network. Client URLs and wrong weapon slots are discarded. */
export function normalizeCosmeticLoadout(value) {
  const result = defaultCosmeticLoadout();
  for (const weapon of WEAPON_IDS) {
    const item = ITEMS.get(value?.weaponSkins?.[weapon]);
    if (item?.kind === 'weaponSkin' && item.weapon === weapon) result.weaponSkins[weapon] = item.id;
  }
  for (const kind of ['characterSkin', 'signature', 'sound']) {
    const item = ITEMS.get(value?.[kind]);
    if (item?.kind === kind) result[kind] = item.id;
  }
  return result;
}

export function careerItemState(profile, value) {
  const item = ITEMS.get(typeof value === 'string' ? value : value?.id);
  if (!item) return { owned: false, equipped: false, locked: true, eligible: false, earned: false, progress: 0, requirements: [] };
  const requirement = (label, current, target) => ({ label, current, target, complete: current >= target });
  const requirements = [requirement('Career level', careerLevel(profile?.xp), item.level)];
  if (item.masteryKills) requirements.push(requirement(`${item.weapon} PvP kills`, profile?.mastery?.[item.weapon]?.kills || 0, item.masteryKills));
  if (item.pvpKills) requirements.push(requirement('PvP kills', profile?.pvpKills || 0, item.pvpKills));
  const eligible = requirements.every(value => value.complete);
  const owned = !!profile?.owned?.includes(item.id);
  const equipped = (item.kind === 'weaponSkin' ? profile?.equipped?.weaponSkins?.[item.weapon] : profile?.equipped?.[item.kind]) === item.id;
  return { owned, equipped, eligible, locked: !eligible && (!owned || item.unlock === 'earned'), earned: item.unlock === 'earned',
    progress: Math.min(...requirements.map(value => Math.min(1, value.current / value.target))), requirements };
}

/** Permanent inventory grants, never a second purchase after completing the grind. */
export function reconcileCareerUnlocks(profile) {
  const granted = [];
  for (const item of CAREER_CATALOG) {
    if (item.unlock === 'earned' && !profile.owned.includes(item.id) && careerItemState(profile, item).eligible) {
      profile.owned.push(item.id);
      granted.push(item.id);
    }
  }
  return granted;
}

export function cosmeticLoadout(profile) {
  const loadout = normalizeCosmeticLoadout(profile?.equipped);
  const allowed = id => {
    const state = careerItemState(profile, id);
    return state.owned && !state.locked;
  };
  for (const [weapon, id] of Object.entries(loadout.weaponSkins)) if (!allowed(id)) delete loadout.weaponSkins[weapon];
  for (const kind of ['characterSkin', 'signature', 'sound']) if (!allowed(loadout[kind])) loadout[kind] = 'standard';
  return loadout;
}

/** Mutates one owned slot; a standard descriptor resets it without buying anything. */
export function equipCareerItem(profile, value) {
  if (value?.id === 'standard') {
    if (value.kind === 'weaponSkin' && WEAPON_IDS.includes(value.weapon)) delete profile.equipped.weaponSkins[value.weapon];
    else if (['characterSkin', 'signature', 'sound'].includes(value.kind)) profile.equipped[value.kind] = 'standard';
    else throw new Error('Choose a valid cosmetic slot');
    return;
  }
  const item = ITEMS.get(typeof value === 'string' ? value : value?.id);
  const state = careerItemState(profile, item);
  if (!item || !state.owned || state.locked) throw new Error('This cosmetic has not been earned');
  if (item.kind === 'weaponSkin') profile.equipped.weaponSkins[item.weapon] = item.id;
  else profile.equipped[item.kind] = item.id;
}

export function careerView(profile) {
  const level = careerLevel(profile.xp);
  return { ...profile, owned: [...profile.owned], equipped: { ...profile.equipped, weaponSkins: { ...profile.equipped.weaponSkins } },
    mastery: Object.fromEntries(Object.entries(profile.mastery || {}).map(([weapon, progress]) => [weapon, { ...progress }])),
    pvpKills: profile.pvpKills || 0, wins: profile.wins || 0, level,
    levelStart: (level - 1) ** 2 * 100, nextLevel: level ** 2 * 100 };
}
