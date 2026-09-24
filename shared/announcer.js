export const MULTIKILL_WINDOW_MS = 4000;

// Whitelisted cue IDs are the wire contract; clients never accept a sound URL.
export const ANNOUNCER_CUES = Object.freeze({
  doublekill: Object.freeze({ label: 'Double Kill', priority: 2 }),
  triplekill: Object.freeze({ label: 'Triple Kill', priority: 3 }),
  multikill: Object.freeze({ label: 'Multi Kill', priority: 4 }),
  ultrakill: Object.freeze({ label: 'Ultra Kill', priority: 5 }),
  monsterkill: Object.freeze({ label: 'Monster Kill', priority: 6 }),
  rampage: Object.freeze({ label: 'Rampage', priority: 10 }),
  godlike: Object.freeze({ label: 'Godlike', priority: 20 }),
});

export function killAnnouncerCue(combo, streak) {
  if (streak === 20) return 'godlike';
  if (streak === 10) return 'rampage';
  return ({ 2: 'doublekill', 3: 'triplekill', 4: 'multikill', 5: 'ultrakill', 6: 'monsterkill' })[combo] || null;
}
