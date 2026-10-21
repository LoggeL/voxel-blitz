import { EQUIPPABLE_SLOTS, LOADOUT_SLOTS, defaultCosmeticLoadout, reconcileCareerUnlocks, resolveCatalogId, treeNode } from '../../shared/career.js';
import { WEAPON_IDS } from '../../shared/combatmath.js';
import { normalizeWeaponLoadout } from '../../shared/weapon-attachments.js';

export const CAREER_ID = /^(?:[a-f0-9]{64}|account:[a-f0-9]{32})$/;
export const CAREER_COUNTERS = ['xp', 'kills', 'matches', 'pvpKills', 'wins'];
export const emptyProfile = () => ({ xp: 0, kills: 0, matches: 0, pvpKills: 0, wins: 0, mastery: {},
  owned: ['amber', 'rookie'], equipped: { theme: 'amber', title: 'rookie', ...defaultCosmeticLoadout() } });
const counter = value => Number.isSafeInteger(value) && value >= 0;
const record = value => !!value && typeof value === 'object' && !Array.isArray(value);

/** Rows carry human-only `kills`/`headshots` plus optional weighted-in `botKills`.
 * `botKills` is emitted only when positive, so legacy rows round-trip identically. */
function validateMastery(value) {
  if (!record(value) || Object.keys(value).some(key => !WEAPON_IDS.includes(key))
    || Object.values(value).some(row => !record(row) || !counter(row.kills) || !counter(row.headshots) || row.headshots > row.kills
      || (row.botKills !== undefined && !counter(row.botKills))))
    throw new Error('Invalid career mastery');
  return Object.fromEntries(WEAPON_IDS.filter(weapon => Object.hasOwn(value, weapon))
    .map(weapon => [weapon, { kills: value[weapon].kills, headshots: value[weapon].headshots,
      ...(value[weapon].botKills > 0 ? { botKills: value[weapon].botKills } : {}) }]));
}
/** Detached per-weapon kill counts for the admission welcome payload. Empty
 * rows are dropped so matches without mastery history send no extra bytes. */
export function masteryView(mastery) {
  if (!record(mastery)) return {};
  const result = {};
  for (const weapon of WEAPON_IDS) {
    const row = mastery[weapon];
    if (record(row) && counter(row.kills) && counter(row.headshots) && row.headshots <= row.kills
      && (row.kills > 0 || row.headshots > 0)) result[weapon] = { kills: row.kills, headshots: row.headshots };
  }
  return result;
}

const LOCAL_SLOTS = LOADOUT_SLOTS.filter(slot => !slot.wire).map(slot => slot.id);
const catalogKind = (id, kind) => treeNode(id)?.kind === kind;
/** Retired catalog ids are renamed through CATALOG_ALIASES before the strict checks below. */
function resolveAliases(profile) {
  if (!profile || !Array.isArray(profile.owned) || new Set(profile.owned).size !== profile.owned.length || !record(profile.equipped)) return profile;
  const equipped = { ...profile.equipped };
  for (const slot of [...LOCAL_SLOTS, ...EQUIPPABLE_SLOTS]) if (typeof equipped[slot] === 'string') equipped[slot] = resolveCatalogId(equipped[slot]);
  if (record(equipped.weaponSkins)) equipped.weaponSkins = Object.fromEntries(Object.entries(equipped.weaponSkins)
    .map(([weapon, id]) => [weapon, typeof id === 'string' ? resolveCatalogId(id) : id]));
  return { ...profile, owned: [...new Set(profile.owned.map(id => typeof id === 'string' ? resolveCatalogId(id) : id))], equipped };
}

/** Migrate absent new fields; never invent historical PvP or weapon attribution. */
export function validateProfile(profile) {
  // A legacy `credits` field is accepted and dropped: `migrated` is rebuilt from
  // CAREER_COUNTERS, so the dead currency never survives a read.
  // Raw duplicates stay invalid; duplicates created only by alias resolution merge.
  if (profile && Array.isArray(profile.owned) && new Set(profile.owned).size !== profile.owned.length) throw new Error('Invalid career data');
  profile = resolveAliases(profile);
  if (!profile || !['xp', 'kills', 'matches'].every(key => counter(profile[key]))
    || !['pvpKills', 'wins'].every(key => profile[key] === undefined || counter(profile[key]))
    || !Array.isArray(profile.owned) || profile.owned.some(id => !treeNode(id))
    || !record(profile.equipped) || !LOCAL_SLOTS.every(kind =>
      profile.owned.includes(profile.equipped[kind]) && catalogKind(profile.equipped[kind], kind))) throw new Error('Invalid career data');
  const equipped = { ...defaultCosmeticLoadout(), ...profile.equipped, weaponSkins: { ...profile.equipped.weaponSkins } };
  equipped.weaponAttachments = normalizeWeaponLoadout(profile.equipped.weaponAttachments);
  if (profile.equipped.weaponSkins !== undefined && !record(profile.equipped.weaponSkins)) throw new Error('Invalid career cosmetics');
  const validSlot = (id, kind, weapon) => id === 'standard' || profile.owned.includes(id)
    && catalogKind(id, kind) && (kind !== 'weaponSkin' || treeNode(id).weapon === weapon);
  if (Object.entries(equipped.weaponSkins).some(([weapon, id]) => !WEAPON_IDS.includes(weapon) || !validSlot(id, 'weaponSkin', weapon))
    || EQUIPPABLE_SLOTS.some(kind => !validSlot(equipped[kind], kind))) throw new Error('Invalid career cosmetics');
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

/** Shared by file and transactional SQL persistence, including overflow checks.
 * Newly granted ids are pushed into `granted` for the post-match frame follow-up. */
export function applyCareerProgress(profile, changes, granted = []) {
  const next = { ...profile, mastery: Object.fromEntries(Object.entries(profile.mastery).map(([key, row]) => [key, { ...row }])) };
  for (const key of CAREER_COUNTERS) {
    next[key] += changes[key];
    if (!counter(next[key])) throw new Error('Career reward exceeds supported progress');
  }
  for (const [weapon, row] of Object.entries(changes.mastery)) {
    const previous = next.mastery[weapon] || { kills: 0, headshots: 0 };
    const merged = { kills: previous.kills + row.kills, headshots: previous.headshots + row.headshots };
    const botKills = (previous.botKills || 0) + (row.botKills || 0);
    if (botKills) merged.botKills = botKills;
    if (!Object.values(merged).every(counter)) throw new Error('Career reward exceeds supported progress');
    next.mastery[weapon] = merged;
  }
  validateMastery(next.mastery);
  Object.assign(profile, next);
  granted.push(...reconcileCareerUnlocks(profile));
  return profile;
}
