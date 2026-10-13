/**
 * Titan hull damage (docs/titanfall.md §5.3). WP0 ships a working basic body
 * (zone, armour, shield, hp, doom pool, assist bookkeeping); WP2 owns it.
 * Called only through TitanSystem.applyDamage, which vehicle-damage.js
 * delegates to for every hull whose def armour is 'titan'.
 */
import { armorMultiplier, armorEffective } from '../../../shared/vehicle-armor.js';
import { vehicleDef, vehicleWorldToLocal } from '../../../shared/vehicle-defs.js';
import { meterCredit } from './meter.js';
import { guardTitanDamage } from './titan-abilities.js';
import { TITAN_RULES } from '../../../shared/vehicle-handling/titan.js';

const idOf = player => player?.id == null ? null : String(player.id);

/**
 * Doomed-window floor (playtest): for `graceMs` after doom starts, hits cannot take
 * the doom hp below what the plain drain still needs for the rest of that window,
 * so focused fire never kills a doomed pilot before a (triple-tap) eject is possible.
 * Only a hull with a seated pilot (not one mid-embark, who cannot eject) is guarded.
 * Rodeo damage (battery rip, hatch shots) skips the shield and hits the hull.
 */
export const TITAN_DOOM_GUARD = Object.freeze({ graceMs: 2000 });

/**
 * Facing zone of a world point on a titan: rear when the hull-local z is
 * behind 0.3 × halfLength (the nose is local −Z, so "behind" is +Z), top above
 * 0.8 × height, else front/side by the dominant local axis.
 */
export function titanHitZone(v, point) {
  const def = vehicleDef(v);
  if (!def || !Array.isArray(point) || point.length !== 3 || !point.every(Number.isFinite)) return 'side';
  const [lx, ly, lz] = vehicleWorldToLocal(v, point), hl = def.collider.halfLength, hw = def.collider.halfWidth;
  if (lz > 0.3 * hl) return 'rear';
  if (ly > 0.8 * def.height) return 'top';
  return Math.abs(lz) / hl >= Math.abs(lx) / hw ? 'front' : 'side';
}

/**
 * One hit on a titan. Returns false when refused (friendly, dead, invalid),
 * otherwise the damage dealt after armour (0 for a spark).
 * hit = { point, origin, impactVelocity, sourceTeam }.
 */
export function applyTitanDamage(titans, v, amount, cls, by, hit = {}) {
  const system = titans.vehicles, engine = system.engine;
  if (!v || !(v.hp > 0) || v.dropping || !Number.isFinite(amount) || amount <= 0 || typeof cls !== 'string') return false;
  if (by && (system.teamOf(by) === v.team || engine.mode?.canDamage?.(by, v) === false)) return false;
  if (!by && hit?.sourceTeam != null && hit.sourceTeam === v.team) return false;
  // WP3 guards: Vortex / Thermal / Gun Shield stop pilot shots crossing them; Sword Block is front-only.
  amount = guardTitanDamage(titans, v, amount, cls, by, hit);
  if (!(amount > 0)) return 0;
  const def = vehicleDef(v), now = system.nowMs();
  const at = Array.isArray(hit?.point) ? hit.point : Array.isArray(hit?.origin) ? hit.origin : null;
  const zone = at ? titanHitZone(v, at) : 'side';
  const base = cls === 'collision' ? 1 : armorMultiplier(cls, 'titan', zone);
  const taken = Number.isFinite(v.tfMove?.damageTakenMul) ? v.tfMove.damageTakenMul : 1;
  const dealt = amount * base * taken;
  if (cls !== 'collision') {
    system.damageModel.recordHit(v, by, dealt, zone, cls, armorEffective(base), at ?? [v.x, v.y + def.height / 2, v.z], now);
  }
  if (!(dealt > 0)) return 0;
  v.lastDamagedAt = now;
  if (by) {
    const id = idOf(by), entry = v.damageLog.get(id) || { dmg: 0, at: now, player: by };
    entry.dmg += dealt; entry.at = now; entry.player = by;
    v.damageLog.set(id, entry);
    meterCredit(engine.mode?.policy, by, 'titanDamage', dealt);
  }
  let left = dealt;
  if (v.shield > 0 && cls !== 'rodeo') { const absorbed = Math.min(v.shield, left); v.shield -= absorbed; left -= absorbed; }
  if (!(left > 0)) return dealt;
  const graceLeft = v.doomed && Number.isFinite(v.doomedAt) ? TITAN_DOOM_GUARD.graceMs - (now - v.doomedAt) : 0;
  if (graceLeft > 0 && v.doomPool > 0 && titans.vehicles.crew(v).some(p => !(p.embarkUntil > titans.now))) {
    const floor = v.doomPool * (graceLeft / 1000) / TITAN_RULES.doomSeconds + 1e-6;
    v.hp = Math.max(Math.min(v.hp, floor), v.hp - left);
    return dealt;
  }
  v.hp = Math.max(0, v.hp - left);
  if (v.hp > 0) return dealt;
  if (!v.doomed) titans.doom(v, by);
  else titans.destroyDoomed(v);
  return dealt;
}
