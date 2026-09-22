/** Random bot personalities: fixed-for-the-game behavior variation on top of difficulty. */
export const BOT_PERSONALITIES = Object.freeze({
  rusher: Object.freeze({ label: 'Rusher', far: 14, near: 4, strafeHz: 0.8, aimError: 1.15,
    reaction: 0.85, burst: Object.freeze([2, 4]), burstPause: 0.8, retreatHp: 0.6, hop: 1.6, crouchFire: 0 }),
  skirmisher: Object.freeze({ label: 'Skirmisher', far: 22, near: 6, strafeHz: 1.5, aimError: 1,
    reaction: 1, burst: Object.freeze([3, 5]), burstPause: 1, retreatHp: 1, hop: 1.7, crouchFire: 0.1 }),
  marksman: Object.freeze({ label: 'Marksman', far: 30, near: 12, strafeHz: 0.6, aimError: 0.7,
    reaction: 1.1, burst: Object.freeze([2, 3]), burstPause: 1.3, retreatHp: 1.2, hop: 0.5, crouchFire: 0.4 }),
  anchor: Object.freeze({ label: 'Anchor', far: 24, near: 8, strafeHz: 0.5, aimError: 0.85,
    reaction: 1, burst: Object.freeze([5, 8]), burstPause: 1.1, retreatHp: 1.4, hop: 0.4, crouchFire: 0.35 }),
  sprayer: Object.freeze({ label: 'Sprayer', far: 20, near: 3, strafeHz: 1.2, aimError: 1.3,
    reaction: 0.9, burst: Object.freeze([6, 10]), burstPause: 0.7, retreatHp: 0.8, hop: 1, crouchFire: 0.05 }),
});
export const BOT_PERSONALITY_IDS = Object.freeze(Object.keys(BOT_PERSONALITIES));
export const DEFAULT_BOT_PERSONALITY = 'skirmisher';
export const isBotPersonality = (value) => typeof value === 'string' && Object.hasOwn(BOT_PERSONALITIES, value);

/** Uniform roll that never consumes the caller's gameplay rng stream. */
export function rollBotPersonality(random) {
  const ids = BOT_PERSONALITY_IDS;
  return ids[Math.floor(random() * ids.length) % ids.length];
}
