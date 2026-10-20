// Conquest supply crates (server authority; docs/conquest.md "Infantry supply"):
// the Support's AMMO CRATE and the Medic's MEDICAL CRATE, placed with the
// `crate` intent. ConquestPolicy owns one instance; the hitscan walk and the
// melee swing ask it for an enemy crate on their path (`ctx.nearestGadget`,
// `ctx.meleeGadget`), every blast of the tick reaches it through
// `projectileExplode`, and its pulses pay through ConquestRoles.supply. Rules
// and the wire codec live in shared/supply-crates.js.

import { GRENADE_TYPES } from '../../../shared/grenade-rules.js';
import { KIT_ROLE_RULES, kitCrate } from '../../../shared/conquest-kits.js';
import { SUPPLY_CRATE_RULES, crateCenter, encodeSupplyCrates, inCrateReach, placeCrate, rayCrate } from '../../../shared/supply-crates.js';
import { AIR } from '../../../shared/worlddata.js';
import { PROJECTILE_RULES } from '../../sim/projectiles.js';

const idOf = value => value && typeof value === 'object' ? String(value.id ?? '') : String(value ?? '');
/** Blast types that never hurt a crate (clouds, fire fields, the Recon gadgets). */
const HARMLESS_BLASTS = new Set(['smoke', 'molotov', 'sensor', 'beacon', 'glaive']);
const R = SUPPLY_CRATE_RULES;

export class SupplyCrates {
  /** `policy` is the owning ConquestPolicy (clock, teams, entities, engine, roles, award, emit). */
  constructor(policy) {
    this.policy = policy;
    this._nextId = 1;
    this.reset();
  }

  reset() {
    /** id -> {kind, id, ownerId, team, x, y, z, yaw, mount, hp, placedAt, expiresAt, nextPulseAt} */
    this.crates = new Map();
    /** playerId -> sim ms before which a new placement is refused */
    this.readyAt = new Map();
    /** `${crateKind}:${mateId}` -> last gadget round / bandage given */
    this._lastExtra = new Map();
    /** `${ownerId}:${mateId}` -> last resupply award */
    this._awards = new Map();
    /** ownerId -> HP healed toward the next heal award */
    this._healCredit = new Map();
  }

  get now() { return this.policy?.now ?? 0; }
  get engine() { return this.policy?.engine ?? null; }

  _entity(id) { return this.policy?._entity?.(id) ?? this.engine?.entities?.get?.(String(id)) ?? null; }
  _teamOf(entity) { return entity ? this.policy?.teamFor?.(entity) ?? entity.team ?? null : null; }
  _solidAt() {
    const engine = this.engine;
    return engine?.solidAt ?? (engine?.world ? (x, y, z) => engine.world.getBlock(x, y, z) !== AIR : null);
  }

  _emit(crate, state, extra = {}) {
    this.policy?._emit?.('supply_crate', { id: crate.id, crate: crate.kind, owner: crate.ownerId, team: crate.team, state,
      pos: crateCenter(crate).map(v => Math.round(v * 100) / 100), ...extra });
  }

  _refuse(entity, kind, reason, waitMs = null) {
    this.policy?._emit?.('supply_crate', { id: null, crate: kind, owner: idOf(entity), team: this._teamOf(entity), state: 'refused', reason,
      ...(Number.isFinite(waitMs) ? { waitMs: Math.ceil(waitMs) } : {}) });
    return null;
  }

  crateOf(ownerId) {
    const id = String(ownerId);
    for (const crate of this.crates.values()) if (crate.ownerId === id) return crate;
    return null;
  }

  // --- placement -------------------------------------------------------------

  /**
   * The `crate` intent: a living on-foot Support (AMMO CRATE) or Medic
   * (MEDICAL CRATE) places his crate on the ground ahead (shared placeCrate).
   * One per owner: an earlier one moves here. Returns the crate or null
   * (refused with a `supply_crate` event).
   */
  place(entity) {
    const policy = this.policy;
    if (!entity || policy?.phase !== 'live') return null;
    const kind = kitCrate(policy.roles?.kitOf?.(entity) ?? 'assault', policy.roles?.gadgetOf?.(entity) ?? 0);
    if (!kind) return this._refuse(entity, null, 'kit');
    if (entity.state !== 'alive' || entity.vehicleId || entity.chute || entity.grounded === false || policy.roles?.isDown?.(entity) === true) {
      return this._refuse(entity, kind, 'state');
    }
    const team = this._teamOf(entity);
    if (!team) return this._refuse(entity, kind, 'state');
    const ownerId = idOf(entity), now = this.now;
    const wait = (this.readyAt.get(ownerId) ?? -Infinity) - now;
    if (wait > 0) return this._refuse(entity, kind, 'cooldown', wait);
    const spot = placeCrate(entity, this._solidAt());
    if (spot.reason) return this._refuse(entity, kind, spot.reason);
    const prior = this.crateOf(ownerId);
    if (prior) this.crates.delete(prior.id);
    const crate = { kind, id: `sc${this._nextId++}`, ownerId, team, x: spot.x, y: spot.y, z: spot.z, yaw: spot.yaw, mount: spot.mount,
      hp: R.hp, placedAt: now, expiresAt: null, nextPulseAt: now };
    this.crates.set(crate.id, crate);
    this.readyAt.set(ownerId, now + R.replaceCooldownMs);
    entity.spawnProtectedUntil = 0;
    entity.spawnProtected = false;
    this._emit(crate, prior ? 'moved' : 'placed', prior ? { from: prior.id } : {});
    return crate;
  }

  // --- damage ----------------------------------------------------------------

  _hostile(crate, attacker) {
    const team = attacker ? this._teamOf(attacker) : null;
    return !team || team !== crate.team;
  }

  /** Nearest enemy crate on a round's path: `{gadget, t}` or null. */
  nearest(shooter, origin, direction, limit, minT = 0, radius = 0) {
    if (this.policy?.phase !== 'live' || !this.crates.size) return null;
    let best = null;
    for (const crate of this.crates.values()) {
      if (!this._hostile(crate, shooter)) continue;
      const t = rayCrate(crate, origin, direction, best?.t ?? limit, minT, radius);
      if (t !== null) best = { gadget: crate, t };
    }
    return best;
  }

  /** Damage from an enemy (bullets, blasts, melee); destroyed at 0 HP, the destroyer paid `gadget_destroyed`. */
  damage(crate, amount, attacker = null) {
    if (!crate || !(amount > 0) || this.policy?.phase !== 'live' || !this.crates.has(crate.id)) return false;
    if (!this._hostile(crate, attacker)) return false;
    crate.hp -= amount;
    if (crate.hp > 0) return false;
    const by = attacker ? idOf(attacker) : null;
    this.remove(crate, 'destroyed', by ? { by } : {});
    if (by && this._entity(by)) this.policy?.award?.(by, 'gadget_destroyed');
    return true;
  }

  _blast(event) {
    const radius = Number(event.radius);
    if (!(radius > 0) || HARMLESS_BLASTS.has(event.type)) return;
    const rules = GRENADE_TYPES[event.type] ?? PROJECTILE_RULES[event.type] ?? null;
    const base = rules ? (Number(rules.damage) || 0) + (Number(rules.directDamage) || 0) : R.blastDamage;
    if (!(base > 0)) return;
    const origin = [Number(event.x), Number(event.y), Number(event.z)];
    if (!origin.every(Number.isFinite)) return;
    const attacker = event.id ? this._entity(event.id) : null;
    for (const crate of [...this.crates.values()]) {
      const c = crateCenter(crate);
      const d = Math.hypot(c[0] - origin[0], c[1] - origin[1], c[2] - origin[2]);
      if (d < radius) this.damage(crate, base * (1 - d / radius), attacker);
    }
  }

  // --- life cycle -------------------------------------------------------------

  remove(crate, state = 'removed', extra = {}) {
    if (!this.crates.delete(crate?.id)) return false;
    this._emit(crate, state, extra);
    return true;
  }

  /** The owner's crate (leaving, team change). */
  removeOwner(ownerId, state = 'removed') {
    const crate = this.crateOf(ownerId);
    if (crate) this.remove(crate, state);
    this.readyAt.delete(String(ownerId));
  }

  /** The owner died: the crate lingers lingerMs, then goes. */
  onDeath(entity) {
    const crate = entity ? this.crateOf(idOf(entity)) : null;
    if (crate && !Number.isFinite(crate.expiresAt)) crate.expiresAt = this.now + R.lingerMs;
  }

  rename(priorId, nextId) {
    const prior = String(priorId), next = String(nextId);
    for (const crate of this.crates.values()) if (crate.ownerId === prior) crate.ownerId = next;
    if (this.readyAt.has(prior)) { this.readyAt.set(next, this.readyAt.get(prior)); this.readyAt.delete(prior); }
  }

  /** Per-tick upkeep (live phase): blasts, lost floors and owners, expiry, then the pulses. */
  tick(now = this.now) {
    if (!this.crates.size) return;
    for (const ev of Array.isArray(this.engine?.tickEvents) ? this.engine.tickEvents : []) {
      if (ev?.kind === 'projectileExplode') this._blast(ev);
    }
    const getBlock = this.engine?.world ? (x, y, z) => this.engine.world.getBlock(x, y, z) : null;
    for (const crate of [...this.crates.values()]) {
      const owner = this._entity(crate.ownerId);
      if (!owner || this._teamOf(owner) !== crate.team) { this.remove(crate, 'removed'); continue; }
      if (getBlock && crate.mount && getBlock(...crate.mount) === AIR) { this.remove(crate, 'destroyed'); continue; }
      if (Number.isFinite(crate.expiresAt) && now >= crate.expiresAt) { this.remove(crate, 'expired'); continue; }
      if (now < crate.nextPulseAt) continue;
      crate.nextPulseAt = now + (crate.kind === 'medcrate' ? R.med.intervalMs : R.ammo.intervalMs);
      if (crate.kind === 'medcrate') this._healPulse(crate, owner, now);
      else this._ammoPulse(crate, owner, now);
    }
  }

  /** Living, on-foot teammates of the crate within reach (owner included). */
  *_mates(crate) {
    for (const mate of this.engine?.entities?.values?.() ?? []) {
      if (!mate || mate.npcRole || mate.state !== 'alive' || mate.vehicleId || this.policy?.roles?.isDown?.(mate) === true) continue;
      if (this._teamOf(mate) !== crate.team || !inCrateReach(crate, mate)) continue;
      yield mate;
    }
  }

  _ammoPulse(crate, owner, now) {
    const roles = this.policy?.roles;
    for (const mate of this._mates(crate)) {
      const key = `ammocrate:${idOf(mate)}`;
      const gadgetRound = now - (this._lastExtra.get(key) ?? -Infinity) >= R.ammo.gadgetRoundMs;
      const given = roles?.supply?.(mate, { mags: R.ammo.mags, grenades: R.ammo.grenades, gadgetRound });
      if (!given?.any) continue;
      if (given.gadget) this._lastExtra.set(key, now);
      if (idOf(mate) === crate.ownerId) continue;
      // The aura's award rule: one `resupply` per owner and mate per resupplyAwardCooldownMs.
      const awardKey = `${crate.ownerId}:${idOf(mate)}`;
      if (now - (this._awards.get(awardKey) ?? -Infinity) < KIT_ROLE_RULES.resupplyAwardCooldownMs) continue;
      this._awards.set(awardKey, now);
      this.policy?.award?.(crate.ownerId, 'resupply');
    }
  }

  _healPulse(crate, owner, now) {
    const roles = this.policy?.roles;
    for (const mate of this._mates(crate)) {
      const key = `medcrate:${idOf(mate)}`;
      if (now - (this._lastExtra.get(key) ?? -Infinity) >= R.med.bandageMs
          && roles?.supply?.(mate, { mags: 0, grenades: 0, bandages: 1 })?.bandages > 0) this._lastExtra.set(key, now);
      if (now - (roles?.damagedAt?.(mate) ?? -Infinity) < R.med.hurtQuietMs) continue;
      const max = Number.isFinite(mate.maxHp) && mate.maxHp > 0 ? mate.maxHp : 100;
      const hp = Number.isFinite(mate.hp) ? mate.hp : max;
      const amount = Math.min(max - hp, R.med.hp);
      if (!(amount > 0)) continue;
      mate.hp = hp + amount;
      this.policy?._emit?.('heal', { id: idOf(mate), by: crate.ownerId, hp: Math.round(amount * 10) / 10 });
      if (idOf(mate) === crate.ownerId) continue;
      // The aura's award rule: one `heal` per healAwardHp restored to others.
      let credit = (this._healCredit.get(crate.ownerId) ?? 0) + amount;
      while (KIT_ROLE_RULES.healAwardHp > 0 && credit >= KIT_ROLE_RULES.healAwardHp - 1e-6) {
        credit -= KIT_ROLE_RULES.healAwardHp;
        this.policy?.award?.(crate.ownerId, 'heal');
      }
      this._healCredit.set(crate.ownerId, credit);
    }
  }

  // --- snapshot ---------------------------------------------------------------

  /** `match.conquest.crates` (shared/supply-crates.js encodeSupplyCrates), or null while empty. */
  snapshot(now = this.now) { return encodeSupplyCrates(this.crates.values(), now); }
}
