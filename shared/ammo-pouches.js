// Conquest ammo pouches from the fallen (docs/conquest.md "Infantry supply" ->
// "Ammo pouches"): an infantry soldier killed on foot drops one pouch at the
// body; any living on-foot soldier of either team who walks over it takes one
// primary magazine (ConquestRoles.supply). The server owns the pouches
// (server/modes/conquest/pouches.js); the client draws `match.conquest.pch`.
import { kitLoadout } from './conquest-kits.js';

export const AMMO_POUCH_RULES = Object.freeze({
  /** A pouch lies this long, then goes. */
  lifetimeMs: 30000,
  /** At most this many per room; the oldest goes first. */
  maxActive: 32,
  /** Flat pickup reach (m) and the feet-height window it must share. */
  radius: 1.6,
  height: 1.4,
  /** One pouch pays this: one primary magazine, no grenade. */
  grant: Object.freeze({ mags: 1, grenades: 0 }),
  /**
   * Wire cadence: the `pch` list rides the snapshot only on a tick where the
   * set changed, plus a keyframe this often for late joiners (never per tick).
   */
  keyframeMs: 2000,
  /** Bots: below this primary reserve fraction a bot walks to a pouch within `botReachM` with no enemy in sight. */
  botNeed: 0.5,
  botReachM: 12,
  /** A bot that saw an enemy this recently is still in a fight (no pouch detour). */
  botCalmMs: 1500,
});

const q = v => Math.round(v * 10) / 10;

/** Wire rows of the live pouches: `[[id, x, y, z], ...]` (id an integer, decimetre positions). */
export function encodeAmmoPouches(pouches) {
  const rows = [];
  for (const p of pouches ?? []) if ([p?.x, p?.y, p?.z].every(Number.isFinite)) rows.push([p.id | 0, q(p.x), q(p.y), q(p.z)]);
  return rows;
}

/** Decoded `match.conquest.pch`: `[{id, x, y, z}]`, or null when the field is absent (keep what is shown). */
export function decodeAmmoPouches(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const row of raw.slice(0, AMMO_POUCH_RULES.maxActive)) {
    if (!Array.isArray(row) || row.length < 4) continue;
    const [id, x, y, z] = row.map(Number);
    if (Number.isInteger(id) && [x, y, z].every(Number.isFinite)) out.push({ id, x, y, z });
  }
  return out;
}

/** Primary reserve of `player` as a fraction (0..1) of its kit issue on `loadout {kit, variant, gadget}`; 1 when unknown. */
export function primaryReserveFraction(player, loadout) {
  if (!loadout?.kit || !Array.isArray(player?.reserve)) return 1;
  const issued = kitLoadout(loadout.kit, loadout.variant ?? 0, loadout.gadget ?? 0);
  const cap = issued.reserve[issued.weapon];
  if (!(cap > 0)) return 1;
  return Math.max(0, Math.min(1, (Number(player.reserve[issued.weapon]) || 0) / cap));
}
