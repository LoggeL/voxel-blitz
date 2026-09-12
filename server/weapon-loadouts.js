import { normalizeWeaponLoadout, validateAttachments } from '../shared/weapon-attachments.js';

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
    setProfileAttachments(profile, weapon, selection);
    await store.writeProfile(client, id, profile);
    return profile;
  });
}
