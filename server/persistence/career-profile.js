import { CAREER_CATALOG, defaultCosmeticLoadout, reconcileCareerUnlocks } from '../../shared/career.js';
import { WEAPON_IDS } from '../../shared/combatmath.js';
import { normalizeWeaponLoadout } from '../../shared/weapon-attachments.js';

export const CAREER_ID = /^(?:[a-f0-9]{64}|account:[a-f0-9]{32})$/;
export const CAREER_COUNTERS = ['xp', 'credits', 'kills', 'matches', 'pvpKills', 'wins'];
export const emptyProfile = () => ({ xp: 0, credits: 0, kills: 0, matches: 0, pvpKills: 0, wins: 0, mastery: {},
  owned: ['amber', 'rookie'], equipped: { theme: 'amber', title: 'rookie', ...defaultCosmeticLoadout() } });
const counter = value => Number.isSafeInteger(value) && value >= 0;
const record = value => !!value && typeof value === 'object' && !Array.isArray(value);

function validateMastery(value) {
  if (!record(value) || Object.keys(value).some(key => !WEAPON_IDS.includes(key))
    || Object.values(value).some(row => !record(row) || !counter(row.kills) || !counter(row.headshots) || row.headshots > row.kills))
    throw new Error('Invalid career mastery');
  return Object.fromEntries(WEAPON_IDS.filter(weapon => Object.hasOwn(value, weapon))
    .map(weapon => [weapon, { kills: value[weapon].kills, headshots: value[weapon].headshots }]));
}

/** Migrate absent new fields; never invent historical PvP or weapon attribution. */
export function validateProfile(profile) {
  if (!profile || !['xp', 'credits', 'kills', 'matches'].every(key => counter(profile[key]))
    || !['pvpKills', 'wins'].every(key => profile[key] === undefined || counter(profile[key]))
    || !Array.isArray(profile.owned) || new Set(profile.owned).size !== profile.owned.length
    || profile.owned.some(id => !CAREER_CATALOG.some(item => item.id === id))
    || !record(profile.equipped) || !['theme', 'title'].every(kind =>
      profile.owned.includes(profile.equipped[kind]) && CAREER_CATALOG.some(item =>
        item.id === profile.equipped[kind] && item.kind === kind))) throw new Error('Invalid career data');
  const equipped = { ...defaultCosmeticLoadout(), ...profile.equipped, weaponSkins: { ...profile.equipped.weaponSkins } };
  equipped.weaponAttachments = normalizeWeaponLoadout(profile.equipped.weaponAttachments);
  if (profile.equipped.weaponSkins !== undefined && !record(profile.equipped.weaponSkins)) throw new Error('Invalid career cosmetics');
  const validSlot = (id, kind, weapon) => id === 'standard' || profile.owned.includes(id)
    && CAREER_CATALOG.some(item => item.id === id && item.kind === kind && (kind !== 'weaponSkin' || item.weapon === weapon));
  if (Object.entries(equipped.weaponSkins).some(([weapon, id]) => !WEAPON_IDS.includes(weapon) || !validSlot(id, 'weaponSkin', weapon))
    || ['characterSkin', 'signature', 'sound'].some(kind => !validSlot(equipped[kind], kind))) throw new Error('Invalid career cosmetics');
  const migrated = { ...Object.fromEntries(CAREER_COUNTERS.map(key => [key, profile[key] ?? 0])),
    mastery: validateMastery(profile.mastery ?? {}), owned: [...profile.owned], equipped };
  reconcileCareerUnlocks(migrated);
  return migrated;
}

export function normalizeCareerProgress(delta) {
  const result = Object.fromEntries(CAREER_COUNTERS.map(key => [key, delta?.[key] ?? 0]));
  if (!Object.values(result).every(counter)) throw new Error('Invalid career reward');
  result.mastery = validateMastery(delta?.mastery ?? {});
  return result;
}

/** Shared by file and transactional SQL persistence, including overflow checks. */
export function applyCareerProgress(profile, changes) {
  const next = { ...profile, mastery: Object.fromEntries(Object.entries(profile.mastery).map(([key, row]) => [key, { ...row }])) };
  for (const key of CAREER_COUNTERS) {
    next[key] += changes[key];
    if (!counter(next[key])) throw new Error('Career reward exceeds supported progress');
  }
  for (const [weapon, row] of Object.entries(changes.mastery)) {
    const previous = next.mastery[weapon] || { kills: 0, headshots: 0 };
    next.mastery[weapon] = { kills: previous.kills + row.kills, headshots: previous.headshots + row.headshots };
  }
  validateMastery(next.mastery);
  Object.assign(profile, next);
  reconcileCareerUnlocks(profile);
  return profile;
}
