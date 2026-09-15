import { normalizeWeaponLoadout, validateAttachments, normalizeAttachments } from '../shared/weapon-attachments.js';
import { unlockedParts } from '../shared/career.js';

/** Ownership is authorization and stays out of `shared/weapon-attachments.js`:
 * `normalizeAttachments`/`weaponWithAttachments` must keep producing identical
 * definitions for the server sim and client prediction, which have no profile.
 * A separate assert also fails closed -- an optional profile argument on
 * `validateAttachments` would silently skip the gate at any call site that
 * forgot it. */
export function assertUnlockedAttachments(profile, weapon, selection) {
  const parts = unlockedParts(profile);
  const chosen = normalizeAttachments(weapon, selection);
  for (const slot of ['optic', 'grip', 'counter']) {
    if (!parts[slot].includes(chosen[slot])) throw new Error('Unlock this attachment in your career first.');
  }
  return chosen;
}

/** Stored selections are never rewritten on read: a part that unlocks later must
 * restore the setup the player saved. Filtering happens once at delivery. */
export function allowedWeaponLoadout(profile) {
  const parts = unlockedParts(profile);
  const allowed = {};
  for (const [weapon, selection] of Object.entries(normalizeWeaponLoadout(profile?.equipped?.weaponAttachments))) {
    allowed[weapon] = Object.fromEntries(Object.entries(selection)
      .map(([slot, part]) => [slot, parts[slot]?.includes(part) ? part : 'standard']));
  }
  return normalizeWeaponLoadout(allowed);
}

export function setProfileAttachments(profile, weapon, selection) {
  const validated = validateAttachments(weapon, selection);
  const next = normalizeWeaponLoadout({ ...profile.equipped.weaponAttachments, [weapon]: validated });
  profile.equipped = { ...profile.equipped, weaponAttachments: next };
  return profile;
}

/** Use the existing row lock and JSON equipment column for SQL persistence. */
export function saveStoredAttachments(store, id, weapon, selection, authorized) {
  validateAttachments(weapon, selection);
  return store.transaction(async client => {
    const profile = await store.lockedProfile(client, id);
    if (!authorized()) throw new Error('Your session changed. Reopen the armory.');
    if (!profile) throw new Error('Career unavailable.');
    assertUnlockedAttachments(profile, weapon, selection);
    setProfileAttachments(profile, weapon, selection);
    await store.writeProfile(client, id, profile);
    return profile;
  });
}
