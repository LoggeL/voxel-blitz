/**
 * Titanfall pilot loadout (docs/titanfall.md §1, §3.4, §6). WP0 basic body;
 * WP4 owns it. The owned list is [primary, revolver, at, knife]; the four AT
 * ids (chargerifle, archer, thunderbolt, kraber) are real WEAPON_IDS since WP4,
 * so the FALLBACK map (kraber → sniper, any AT → rocket) only covers an id
 * missing from WEAPON_IDS. Every owned id gets a full magazine and its spare
 * magazines (`spareMags`, counted in magazines; KIT_GADGET_AMMO overrides);
 * every other slot is empty. Grenades: frag 2, pulse 1.
 */
import { WEAPON_IDS, WEAPONS } from '../../../shared/combatmath.js';
import { GRENADE_TYPE_IDS } from '../../../shared/grenade-rules.js';
import { KIT_GADGET_AMMO } from '../../../shared/conquest-kits.js';
import { TITAN_PILOT_SIDEARM, TITAN_PILOT_MELEE, unpackTitanLoadout } from '../../../shared/titan-contract.js';

const FALLBACK = Object.freeze({ kraber: 'sniper', chargerifle: 'rocket', archer: 'rocket', thunderbolt: 'rocket' });
const known = id => WEAPON_IDS.includes(id) ? id : WEAPON_IDS.includes(FALLBACK[id]) ? FALLBACK[id] : null;
const GRENADES = Object.freeze({ frag: 2, pulse: 1 });

/** Owned weapon ids for a packed (or unpacked) loadout, in digit order. */
export function titanfallOwned(loadout) {
  const kit = typeof loadout === 'object' && loadout ? loadout : unpackTitanLoadout(loadout);
  const ids = [known(kit.primary) ?? 'rifle', TITAN_PILOT_SIDEARM, known(kit.at) ?? 'rocket', TITAN_PILOT_MELEE];
  return ids.filter((id, i) => WEAPON_IDS.includes(id) && ids.indexOf(id) === i);
}

/** Issue a fresh life's inventory. Returns the unpacked loadout. */
export function applyTitanfallLoadout(p, loadout) {
  const kit = unpackTitanLoadout(loadout);
  const owned = titanfallOwned(kit);
  const mag = WEAPON_IDS.map(() => 0), reserve = WEAPON_IDS.map(() => 0);
  for (const id of owned) {
    const slot = WEAPON_IDS.indexOf(id), def = WEAPONS[id], override = KIT_GADGET_AMMO[id];
    mag[slot] = override?.mag ?? Math.max(0, Math.trunc(def.magSize ?? 0));
    reserve[slot] = override?.reserve ?? Math.max(0, Math.trunc(def.spareRounds ?? def.spareMags ?? 0));
  }
  p.owned = owned;
  p.mag = mag;
  p.reserve = reserve;
  p.grenades = GRENADE_TYPE_IDS.map(type => GRENADES[type] ?? 0);
  p.weapon = WEAPON_IDS.indexOf(owned[0]);
  p.deployT = WEAPONS[owned[0]]?.deployTime ?? p.deployT;
  p.reloading = false;
  p.reloadStage = null;
  p.reloadLoose = 0;
  return kit;
}
