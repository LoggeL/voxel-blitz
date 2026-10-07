/** Shared lobby choices; only server bots consume the behavior values.
 * Conquest-only fields: `countermeasureMs` is the delay between a hull's lock
 * warning (lk >= 2) and the crew's flare/smoke reflex; `spotMs` is how long a
 * bot keeps a recognised enemy before it may call it out again. */
export const DEFAULT_BOT_DIFFICULTY = 'easy';
export const BOT_DIFFICULTIES = Object.freeze({
  easy: Object.freeze({ label: 'Easy', sightRange: 104, reactionMs: 320, recognition: 0.8,
    aimError: 1.4, turnRate: 3, skillCeiling: 0.65, burstPauseMs: 420, searchMs: 3000,
    countermeasureMs: 800, spotMs: 9000 }),
  normal: Object.freeze({ label: 'Normal', sightRange: 120, reactionMs: 230, recognition: 1,
    aimError: 1, turnRate: 3.8, skillCeiling: 0.85, burstPauseMs: 300, searchMs: 4000,
    countermeasureMs: 550, spotMs: 7000 }),
  hard: Object.freeze({ label: 'Hard', sightRange: 140, reactionMs: 160, recognition: 1.3,
    aimError: 0.65, turnRate: 4.6, skillCeiling: 1, burstPauseMs: 200, searchMs: 5000,
    countermeasureMs: 300, spotMs: 5000 }),
});
/** Aircraft crews look out of a canopy over open sky: one range for every difficulty. */
export const BOT_AIRCRAFT_SIGHT_RANGE = 250;
export const isBotDifficulty = value => typeof value === 'string' && Object.hasOwn(BOT_DIFFICULTIES, value);
export const botDifficulty = value => BOT_DIFFICULTIES[isBotDifficulty(value) ? value : DEFAULT_BOT_DIFFICULTY];
