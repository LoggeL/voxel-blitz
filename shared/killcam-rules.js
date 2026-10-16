import { TITAN_KILL_KEYS, TITAN_WEAPON_META } from './titan-contract.js';

export const KILLCAM = Object.freeze({ historyMs: 3000, postKillMs: 1000, respawnMs: 4800, maxFrames: 100 });
export function supportsKillcam(mode) {
  return ['fun', 'duel', 'chaos', 'tdm', 'gungame', 'conquest', 'titanfall'].includes(mode);
}

/** Kill keys that never replay: a Conquest in-game RESPAWN is the victim's own choice, even when an enemy is credited. */
export const KILLCAM_SKIPPED_KEYS = Object.freeze(['redeploy']);
export const killcamWeaponAllowed = key => !KILLCAM_SKIPPED_KEYS.includes(String(key ?? ''));

/**
 * Titanfall kill keys dealt by a titan hull (its mounts, abilities, melee, crush and the
 * titanfall drop). A killer who is not seated when one of them kills (an auto-titan, a drop or
 * leg crush of an empty hull) is replayed from that titan. `rodeo` (a pilot on the hull) and
 * `titan_doom` (the doomed hull's own end) stay with the pilot.
 */
const TITAN_HULL_KEYS = new Set([...Object.keys(TITAN_WEAPON_META), ...Object.keys(TITAN_KILL_KEYS)]
  .filter(key => key !== 'rodeo' && key !== 'titan_doom'));
export const isTitanHullKillKey = key => TITAN_HULL_KEYS.has(String(key ?? ''));

/**
 * Server: the human-replay decision for one kill (docs: killcam). A replay needs a supported
 * mode, a human victim and a different killer that is a player (no Titanfall minion), an
 * allowed kill key, and for an auto-titan stand-in a hull to follow (`focus`).
 * `focus` = { v: vehicle id, s: seat id or null } from killcamFocus, or null.
 */
export function killcamEligible({ mode, victim, killer, weapon, focus = null }) {
  if (!supportsKillcam(mode) || !victim || victim.bot || !killer) return false;
  if (String(killer.id) === String(victim.id) || killer.tfNpc) return false;
  if (!killcamWeaponAllowed(weapon)) return false;
  return !killer.standIn || !!focus;
}
