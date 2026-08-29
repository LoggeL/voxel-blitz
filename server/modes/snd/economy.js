import { WEAPONS, WEAPON_IDS } from '../../../shared/combatmath.js';
import { WEAPON_PRICES } from '../../../shared/modes.js';

const WEAPON_SET = new Set(WEAPON_IDS);

export function weaponId(value) {
  if (typeof value === 'string' && WEAPON_SET.has(value)) return value;
  if (Number.isFinite(value)) return WEAPON_IDS[Math.trunc(value)] || null;
  return null;
}

/** Owns S&D credits, purchases and loadout/ammo mutations. */
export class SndEconomy {
  constructor(policy) {
    this.policy = policy;
  }

  applyRespawnLoadout(entity, state) {
    if (!entity || !state) return false;
    if (!Array.isArray(entity.mag)) entity.mag = WEAPON_IDS.map(() => 0);
    if (!Array.isArray(entity.reserve)) entity.reserve = WEAPON_IDS.map(() => 0);
    for (let i = 0; i < WEAPON_IDS.length; i++) {
      const id = WEAPON_IDS[i];
      if (!state.owned.has(id)) {
        entity.mag[i] = 0;
        entity.reserve[i] = 0;
      }
    }
    const selected = weaponId(entity.weapon);
    if (!selected || !state.owned.has(selected)) {
      entity.weapon = WEAPON_IDS.indexOf(this.policy._defaultWeapon);
    }
    this.policy._syncPlayer(entity, state);
    return true;
  }

  buy(entity, state, weapon) {
    const id = weaponId(weapon);
    if (this.policy.phase !== 'prep' || !entity || !state || !id) return false;
    if (!state.participating || entity.state !== 'alive') return false;

    const price = WEAPON_PRICES[id];
    if (!Number.isFinite(price) || state.credits < price) return false;
    state.credits -= price;
    state.owned.add(id);
    this.refillWeapon(entity, id);
    entity.weapon = WEAPON_IDS.indexOf(id);
    entity.reloading = false;
    entity.reloadT = 0;
    entity.deployT = WEAPONS[id].deployTime;
    this.policy._syncPlayer(entity, state);
    this.policy._emit('purchase', {
      id: String(entity.id),
      weapon: id,
      price,
      credits: state.credits,
    });
    return true;
  }

  refillWeapon(entity, id) {
    const slot = WEAPON_IDS.indexOf(id);
    if (slot < 0) return;
    if (!Array.isArray(entity.mag)) entity.mag = WEAPON_IDS.map(() => 0);
    if (!Array.isArray(entity.reserve)) entity.reserve = WEAPON_IDS.map(() => 0);
    entity.mag[slot] = WEAPONS[id].magSize;
    entity.reserve[slot] = WEAPONS[id].spareMags;
  }

  addCredits(entity, state, amount, reason) {
    const before = state.credits;
    state.credits = Math.min(this.policy.rules.maxCredits, Math.max(0, before + amount));
    this.policy._syncPlayer(entity, state);
    if (state.credits !== before) {
      this.policy._emit('credits', {
        id: String(entity.id),
        amount: state.credits - before,
        credits: state.credits,
        reason,
      });
    }
  }
}
