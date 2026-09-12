import { WEAPONS, WEAPON_IDS } from './combatmath.js';
import { withWeaponHandling } from './weapon-handling.js';

const item = value => Object.freeze(value);
export const OPTICS = Object.freeze({
  standard: item({ id: 'standard', name: 'Factory sights', detail: 'Original sight and handling.', ergonomics: 0 }),
  reflex: item({ id: 'reflex', name: 'Reflex sight', detail: 'An open red dot for close targets.', zoom: 1.15, ergonomics: 0 }),
  scope2: item({ id: 'scope2', name: '2× tube sight', detail: 'More reach with a small handling cost.', zoom: 2, ergonomics: -1 }),
  scope4: item({ id: 'scope4', name: '4× combat scope', detail: 'A clear magnified view for distant targets.', zoom: 4, ergonomics: -2 }),
  scope10: item({ id: 'scope10', name: '10× precision scope', detail: 'Long-range precision with slower handling.', zoom: 10, ergonomics: -4 }),
});
export const GRIPS = Object.freeze({
  standard: item({ id: 'standard', name: 'Factory grip', detail: 'The original balance.', ergonomics: 0, sway: 1, frequency: 1, vertical: 1, horizontal: 1 }),
  angled: item({ id: 'angled', name: 'Angled foregrip', detail: 'Faster turns, slightly less recoil control.', ergonomics: 8, sway: 1.08, frequency: 1, vertical: 1.06, horizontal: 1.04 }),
  vertical: item({ id: 'vertical', name: 'Vertical foregrip', detail: 'Less upward recoil, slower turns.', ergonomics: -4, sway: 0.88, frequency: 0.94, vertical: 0.75, horizontal: 0.95 }),
  precision: item({ id: 'precision', name: 'Precision grip', detail: 'Calmer sway and side drift, heavier handling.', ergonomics: -7, sway: 0.65, frequency: 0.75, vertical: 0.95, horizontal: 0.72 }),
});
const allGrips = ['standard', 'angled', 'vertical', 'precision'];
const rifles = ['standard', 'reflex', 'scope2', 'scope4'];
export const ATTACHMENT_SLOTS = Object.freeze(Object.fromEntries(WEAPON_IDS.map(id => [id, item({
  optics: Object.freeze(id === 'knife' ? ['standard'] : id === 'sniper' ? [...rifles, 'scope10']
    : ['minigun', 'flamethrower', 'rocket'].includes(id) ? ['standard', 'reflex', 'scope2'] : [...rifles]),
  grips: Object.freeze(['knife', 'revolver', 'minigun', 'flamethrower', 'rocket'].includes(id) ? ['standard'] : [...allGrips]),
})])));
export const DEFAULT_ATTACHMENTS = Object.freeze({ optic: 'standard', grip: 'standard' });
const record = value => value && typeof value === 'object' && !Array.isArray(value);
export function normalizeAttachments(weapon, value) {
  const slots = ATTACHMENT_SLOTS[weapon];
  return Object.freeze({ optic: slots?.optics.includes(value?.optic) ? value.optic : 'standard',
    grip: slots?.grips.includes(value?.grip) ? value.grip : 'standard' });
}
export function validateAttachments(weapon, value) {
  if (!WEAPON_IDS.includes(weapon) || !record(value) || Object.keys(value).some(k => !['optic', 'grip'].includes(k))
    || !ATTACHMENT_SLOTS[weapon].optics.includes(value.optic) || !ATTACHMENT_SLOTS[weapon].grips.includes(value.grip))
    throw new Error('Choose compatible optics and a grip for this weapon.');
  return normalizeAttachments(weapon, value);
}
export function normalizeWeaponLoadout(value) {
  const result = {};
  for (const id of WEAPON_IDS) {
    const selection = normalizeAttachments(id, value?.[id]);
    if (selection.optic !== 'standard' || selection.grip !== 'standard') result[id] = selection;
  }
  return Object.freeze(result);
}
/** Finite cache of immutable catalog combinations; mode upgrades are applied afterwards. */
const cache = new WeakMap();
export function weaponWithAttachments(def, value) {
  const selection = normalizeAttachments(def.id, value);
  if (selection.optic === 'standard' && selection.grip === 'standard') return def;
  const key = selection.optic + '/' + selection.grip;
  let versions = cache.get(def); if (!versions) cache.set(def, versions = new Map());
  if (versions.has(key)) return versions.get(key);
  const optic = OPTICS[selection.optic], grip = GRIPS[selection.grip], h = def.handling;
  const result = withWeaponHandling(def, { ergonomics: h.ergonomics + optic.ergonomics + grip.ergonomics,
    sway: { amplitudeDeg: h.sway.amplitudeDeg * grip.sway, frequencyHz: h.sway.frequencyHz * grip.frequency },
    verticalRecoil: h.verticalRecoil * grip.vertical, horizontalRecoil: h.horizontalRecoil * grip.horizontal });
  if (optic.zoom) {
    result.zoom = optic.zoom;
    result.adsFov = 2 * Math.atan(Math.tan(75 * Math.PI / 360) / optic.zoom) * 180 / Math.PI;
    result.scoped = optic.zoom >= 2;
  }
  result.attachments = selection;
  versions.set(key, result); return result;
}
export function configuredWeapon(id, loadout) { return weaponWithAttachments(WEAPONS[id], loadout?.[id]); }
