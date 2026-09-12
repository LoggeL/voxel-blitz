import { CAREER_CATALOG } from '../../shared/career.js';

export const CAREER_ID = /^(?:[a-f0-9]{64}|account:[a-f0-9]{32})$/;
export const emptyProfile = () => ({ xp: 0, credits: 0, kills: 0, matches: 0,
  owned: ['amber', 'rookie'], equipped: { theme: 'amber', title: 'rookie' } });

/** Reject damaged or unsupported data rather than replacing earned progress. */
export function validateProfile(profile) {
  if (!profile || !['xp', 'credits', 'kills', 'matches'].every(key =>
    Number.isSafeInteger(profile[key]) && profile[key] >= 0)
    || !Array.isArray(profile.owned) || new Set(profile.owned).size !== profile.owned.length
    || profile.owned.some(id => !CAREER_CATALOG.some(item => item.id === id))
    || !profile.equipped || !['theme', 'title'].every(kind =>
      profile.owned.includes(profile.equipped[kind]) && CAREER_CATALOG.some(item =>
        item.id === profile.equipped[kind] && item.kind === kind))) throw new Error('Invalid career data');
  return { xp: profile.xp, credits: profile.credits, kills: profile.kills, matches: profile.matches,
    owned: [...profile.owned], equipped: { theme: profile.equipped.theme, title: profile.equipped.title } };
}
