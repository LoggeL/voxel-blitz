/** Shared lobby choices; only server bots consume the behavior values. */
export const DEFAULT_BOT_DIFFICULTY = 'easy';
export const BOT_DIFFICULTIES = Object.freeze({
  easy: Object.freeze({ label: 'Easy', sightRange: 104, reactionMs: 320, recognition: 0.8,
    aimError: 1.4, turnRate: 3, skillCeiling: 0.65, burstPauseMs: 420, searchMs: 3000 }),
  normal: Object.freeze({ label: 'Normal', sightRange: 120, reactionMs: 230, recognition: 1,
    aimError: 1, turnRate: 3.8, skillCeiling: 0.85, burstPauseMs: 300, searchMs: 4000 }),
  hard: Object.freeze({ label: 'Hard', sightRange: 140, reactionMs: 160, recognition: 1.3,
    aimError: 0.65, turnRate: 4.6, skillCeiling: 1, burstPauseMs: 200, searchMs: 5000 }),
});
export const isBotDifficulty = value => typeof value === 'string' && Object.hasOwn(BOT_DIFFICULTIES, value);
export const botDifficulty = value => BOT_DIFFICULTIES[isBotDifficulty(value) ? value : DEFAULT_BOT_DIFFICULTY];
