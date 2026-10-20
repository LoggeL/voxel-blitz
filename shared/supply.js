// Conquest infantry supply: one grant of magazines, grenades and bandages for a
// soldier, capped at the kit's issue. Every supply source (the Support aura,
// ammo and medical crates, flag caches, pouches dropped by the fallen) pays
// through grantSupply, so the caps and the bandage count live in one place.
// The server applies it (ConquestRoles.supply); the client only displays.
import { applyResupply, kitLoadout } from './conquest-kits.js';

/**
 * Conquest bandages replace the single full-heal medkit: `count` per life,
 * each heals `hp` after `seconds` standing still (the medkit's cancel rules).
 * The count rides `player.medkit.remaining` (0..count).
 */
export const BANDAGE_RULES = Object.freeze({ count: 2, hp: 40, seconds: 2.5 });

/** Give up to `n` bandages back, capped at `cap`. Returns how many were given. */
export function restockBandages(player, n = 1, cap = BANDAGE_RULES.count) {
  const kit = player?.medkit;
  if (!kit || typeof kit !== 'object' || !(n > 0)) return 0;
  const current = Math.max(0, Math.trunc(Number(kit.remaining) || 0));
  const next = Math.min(cap, current + Math.trunc(n));
  if (next <= current) return 0;
  kit.remaining = next;
  return next - current;
}

/**
 * One supply grant to `player` (its mag/reserve/grenades arrays are the
 * inventory) on loadout `{kit, variant, gadget}`. `mags` primary magazines and
 * `grenades` grenades go through applyResupply one at a time (each capped at
 * the kit maximum); `gadgetRound` also returns one AT/AA round; `bandages`
 * restocks bandages. Returns `{reserve, grenades, gadget, bandages, any}`.
 */
export function grantSupply(player, loadout, { mags = 1, grenades = 1, gadgetRound = false, bandages = 0 } = {}) {
  const given = { reserve: 0, grenades: 0, gadget: 0, bandages: 0, any: false };
  if (!player || !loadout?.kit) return given;
  const steps = Math.max(0, Math.trunc(mags), Math.trunc(grenades), gadgetRound ? 1 : 0);
  const slot = kitLoadout(loadout.kit, loadout.variant ?? 0, loadout.gadget ?? 0).weapon;
  for (let i = 0; i < steps; i++) {
    const primary = i < mags, gadget = gadgetRound && i === 0;
    const before = player.reserve?.[slot];
    const r = applyResupply({ mag: player.mag, reserve: primary || gadget ? player.reserve : null, grenades: i < grenades ? player.grenades : null },
      loadout.kit, loadout.variant ?? 0, loadout.gadget ?? 0, { gadgetRound: gadget });
    // A gadget-only step hands back the AT/AA round but no primary magazine.
    if (!primary && Array.isArray(player.reserve)) player.reserve[slot] = before;
    given.reserve += primary ? r.reserve : 0;
    given.grenades += r.grenade ? 1 : 0;
    given.gadget += r.gadget;
  }
  given.bandages = restockBandages(player, bandages);
  given.any = given.reserve > 0 || given.grenades > 0 || given.gadget > 0 || given.bandages > 0;
  return given;
}
