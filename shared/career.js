export const CAREER_CATALOG = Object.freeze([
  { id: 'amber', name: 'Amber', kind: 'theme', price: 0, level: 1, color: '#ffb347', detail: 'Warm amber HUD and reticle' },
  { id: 'arctic', name: 'Arctic', kind: 'theme', price: 100, level: 2, color: '#72e6ff', detail: 'Ice blue HUD and reticle' },
  { id: 'orchid', name: 'Orchid', kind: 'theme', price: 250, level: 3, color: '#dca0ff', detail: 'Violet HUD and reticle' },
  { id: 'mint', name: 'Mint', kind: 'theme', price: 400, level: 4, color: '#80ffc0', detail: 'Mint green HUD and reticle' },
  { id: 'rookie', name: 'Rookie', kind: 'title', price: 0, level: 1, detail: 'Your starting callsign' },
  { id: 'pathfinder', name: 'Pathfinder', kind: 'title', price: 150, level: 2, detail: 'A new callsign on your career badge' },
  { id: 'vanguard', name: 'Vanguard', kind: 'title', price: 350, level: 4, detail: 'A new callsign on your career badge' },
  { id: 'veteran', name: 'Veteran', kind: 'title', price: 700, level: 6, detail: 'A new callsign on your career badge' },
]);
export const CAREER_REWARDS = Object.freeze({
  kill: { xp: 25, credits: 10 }, botKill: { xp: 10, credits: 4 },
  objective: { xp: 75, credits: 30 }, activeMinute: { xp: 20, credits: 8 },
  match: { xp: 100, credits: 40 }, victory: { xp: 50, credits: 20 },
});
export function careerLevel(xp) { return 1 + Math.floor(Math.sqrt(Math.max(0, xp) / 100)); }
export function careerView(profile) {
  const level = careerLevel(profile.xp);
  return { ...profile, owned: [...profile.owned], equipped: { ...profile.equipped }, level,
    levelStart: (level - 1) ** 2 * 100, nextLevel: level ** 2 * 100 };
}
