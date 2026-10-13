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

/**
 * Conquest objective calls. They speak through the same single announcer voice
 * as the multikill calls but always rank below them (priority < doublekill).
 * IDs are a whitelist like ANNOUNCER_CUES; every entry maps to one offline
 * synthesized WAV under /assets/audio/announcer/objective/<id>.wav.
 */
export const OBJECTIVE_FLAG_IDS = Object.freeze(['A', 'B', 'C', 'D', 'E']);
export const FLAG_CALLSIGNS = Object.freeze({ A: 'Alpha', B: 'Bravo', C: 'Charlie', D: 'Delta', E: 'Echo' });
const objectiveCue = (label, priority) => Object.freeze({ label, priority });
export const OBJECTIVE_CUES = Object.freeze({
  ...Object.fromEntries(OBJECTIVE_FLAG_IDS.flatMap(id => [
    [`captured_${id}`, objectiveCue(`Objective ${FLAG_CALLSIGNS[id]} captured`, 1.2)],
    [`lost_${id}`, objectiveCue(`Objective ${FLAG_CALLSIGNS[id]} lost`, 1.4)],
    [`under_attack_${id}`, objectiveCue(`Objective ${FLAG_CALLSIGNS[id]} under attack`, 1)],
  ])),
  tickets_low: objectiveCue('Reinforcements low', 1.5),
  victory: objectiveCue('Victory', 1.9),
  defeat: objectiveCue('Defeat', 1.9),
});
export const OBJECTIVE_CUE_ROOT = '/assets/audio/announcer/objective';
export const objectiveCueUrl = cue => Object.hasOwn(OBJECTIVE_CUES, cue) ? `${OBJECTIVE_CUE_ROOT}/${cue}.wav` : null;

/**
 * Titanfall (Attrition) calls (docs/titanfall.md §8.4). Original lines, spoken
 * offline by macOS `say` (tools/synthesize-titanfall-announcer.mjs); every entry
 * maps to /assets/audio/announcer/titanfall/<id>.wav. They rank below every
 * multikill call, like the objective calls.
 */
export const TITANFALL_CUES = Object.freeze({
  titanfall_ready: objectiveCue('Titanfall ready', 1.6),
  titan_ready: objectiveCue('Your titan is ready', 1.5),
  prepare_titanfall: objectiveCue('Prepare for titanfall', 1.45),
  core_online: objectiveCue('Core online', 1.55),
  titan_doomed: objectiveCue('Warning: titan doomed', 1.85),
  eject: objectiveCue('Eject, eject, eject', 1.9),
  enemy_titan: objectiveCue('Enemy titanfall incoming', 1.1),
  rodeo_warning: objectiveCue('Warning: rodeo', 1.8),
  battery_acquired: objectiveCue('Battery acquired', 1.3),
  winning: objectiveCue('We are winning this fight', 1.05),
  losing: objectiveCue('We are losing this fight', 1.05),
  match_win: objectiveCue('Mission accomplished', 1.95),
  match_lose: objectiveCue('Mission failed', 1.95),
});
export const TITANFALL_CUE_ROOT = '/assets/audio/announcer/titanfall';
export const titanfallCueUrl = cue => Object.hasOwn(TITANFALL_CUES, cue) ? `${TITANFALL_CUE_ROOT}/${cue}.wav` : null;

/** Every cue a local announcer voice may speak (multikill, objective and titanfall). */
export function announcerCueInfo(cue) {
  if (typeof cue !== 'string') return null;
  if (Object.hasOwn(ANNOUNCER_CUES, cue)) return ANNOUNCER_CUES[cue];
  if (Object.hasOwn(OBJECTIVE_CUES, cue)) return OBJECTIVE_CUES[cue];
  if (Object.hasOwn(TITANFALL_CUES, cue)) return TITANFALL_CUES[cue];
  return null;
}

/**
 * One authoritative event → at most one objective call for the local team.
 * Control must cross neutral before a capture, so an own flag is "lost" at the
 * flag_neutralized event (prev = own team) and an enemy capture of a neutral
 * flag is silent. `ownerBefore` is the flag owner from the latest snapshot,
 * used to tell whether a flag_state concerns one of our flags.
 */
export function objectiveAnnouncerCue(ev, selfTeam, ownerBefore = null) {
  if (!ev || !selfTeam) return null;
  const flag = typeof ev.flag === 'string' && OBJECTIVE_FLAG_IDS.includes(ev.flag) ? ev.flag : null;
  switch (ev.kind) {
    case 'flag_captured':
      return flag && ev.team === selfTeam ? `captured_${flag}` : null;
    case 'flag_neutralized':
      return flag && ev.prev === selfTeam && ev.team !== selfTeam ? `lost_${flag}` : null;
    case 'flag_state':
      if (!flag || ownerBefore !== selfTeam) return null;
      if (ev.state === 'neutralizing' && ev.team && ev.team !== selfTeam) return `under_attack_${flag}`;
      return ev.state === 'contested' ? `under_attack_${flag}` : null;
    case 'ticket_low':
      return ev.team === selfTeam ? 'tickets_low' : null;
    default:
      return null;
  }
}
