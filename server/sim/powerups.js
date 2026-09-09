import { WEAPON_IDS, WEAPONS } from '../../shared/combatmath.js';
import { chaosWeaponDef } from '../../shared/chaos.js';
import { SX, SY, SZ } from '../../shared/worlddata.js';
import { POWERUP_RULES, POWERUP_TYPES } from '../../shared/powerups.js';
import { raycastVoxels } from '../../shared/raycast.js';

const TYPES = Object.keys(POWERUP_TYPES);

/** Floor support and clearance are checked again after every terrain update. */
export function validPowerupSite(site, solidAt) {
  if (!site || ![site.x, site.y, site.z].every(Number.isFinite)) return false;
  const x = Math.floor(site.x), y = Math.floor(site.y), z = Math.floor(site.z);
  return x > 0 && x < SX - 1 && z > 0 && z < SZ - 1 && y > 0 && y < SY - 1
    && solidAt(x, y - 1, z) && !solidAt(x, y, z) && !solidAt(x, y + 1, z);
}

/** Return the actual benefit; zero leaves the pickup available to others. */
export function applyPowerup(player, type) {
  if (player?.state !== 'alive') return 0;
  if (type === 'armor' || type === 'health') {
    const key = type === 'armor' ? 'armor' : 'hp';
    const maximum = type === 'armor' ? POWERUP_RULES.maxArmor : POWERUP_RULES.maxHealth;
    const boost = type === 'armor' ? POWERUP_RULES.armorAmount : POWERUP_RULES.healthAmount;
    const current = Number.isFinite(player[key]) ? Math.max(0, player[key]) : 0;
    const amount = Math.max(0, Math.min(boost, maximum - current));
    if (amount > 0) player[key] = current + amount;
    return amount;
  }
  if (type !== 'ammo' || player.infiniteMagazines || !Array.isArray(player.reserve)) return 0;
  const owned = new Set(Array.isArray(player.owned) ? player.owned : []);
  let amount = 0;
  for (let slot = 0; slot < WEAPON_IDS.length; slot++) {
    const id = WEAPON_IDS[slot];
    if (!owned.has(id)) continue;
    const base = WEAPONS[id];
    const def = slot === player.weapon && player.def?.id === id
      ? player.def : chaosWeaponDef(player, base);
    if (def.mode === 'melee') continue;
    const maximum = Math.max(0, Math.trunc((def.spareRounds ?? def.spareMags) || 0));
    const current = Number.isFinite(player.reserve[slot])
      ? Math.max(0, player.reserve[slot]) : 0;
    const restored = Math.max(0, maximum - current);
    if (restored > 0) player.reserve[slot] = current + restored;
    amount += restored;
  }
  return amount;
}

/** Room-owned pickups. Time, RNG, terrain and candidate selection are injectable. */
export class PowerupSystem {
  constructor({ solidAt, findSites, isSupported, rng = Math.random, now = 0 }) {
    this.solidAt = solidAt;
    this.findSites = findSites;
    this.isSupported = isSupported || ((site) => validPowerupSite(site, solidAt));
    this.rng = rng;
    this.active = new Map();
    this.nextSpawnAt = now + POWERUP_RULES.firstSpawnMs;
    this.epoch = null;
    this.sequence = 0;
    this.lastSite = null;
  }

  clear() {
    this.active.clear();
    this.nextSpawnAt = null;
    this.epoch = null;
    this.lastSite = null;
  }

  random() {
    const value = this.rng();
    return Number.isFinite(value) ? Math.max(0, Math.min(1 - Number.EPSILON, value)) : 0;
  }

  snapshot() {
    return Array.from(this.active.values(), ({ id, type, x, y, z, expiresAt }) =>
      ({ id, type, x, y, z, expiresAt }));
  }

  step({ now, mode, phase, round = null, entities, pushEvent }) {
    if (!POWERUP_RULES.modes.includes(mode) || phase !== 'live') {
      this.clear();
      return;
    }
    const epoch = `${mode}:${round ?? ''}`;
    if (this.epoch !== null && this.epoch !== epoch) this.clear();
    this.epoch = epoch;
    this.nextSpawnAt ??= now + POWERUP_RULES.firstSpawnMs;

    for (const [id, pickup] of this.active) {
      if (now >= pickup.expiresAt || !this.isSupported(pickup)) {
        this.active.delete(id);
        continue;
      }
      for (const player of entities.values()) {
        if (player.state !== 'alive' || ![player.x, player.y, player.z].every(Number.isFinite)) continue;
        const dx = pickup.x - player.x, dz = pickup.z - player.z;
        if (Math.abs(player.y - pickup.y) > POWERUP_RULES.collectHeight
          || Math.hypot(dx, dz) > POWERUP_RULES.collectRadius) continue;
        // A short waist-height ray excludes adjacent rooms and other floors,
        // while allowing collection when standing directly over the pickup.
        const startY = player.y + 0.65, dy = pickup.y + 0.65 - startY;
        const distance = Math.hypot(dx, dy, dz);
        if (distance > 1e-6 && raycastVoxels(this.solidAt,
          player.x, startY, player.z, dx, dy, dz, distance)) continue;
        const amount = applyPowerup(player, pickup.type);
        if (!amount) continue;
        this.active.delete(id);
        pushEvent({ t: 'ev', kind: 'powerup', id: String(player.id),
          pickupId: id, type: pickup.type, amount });
        break;
      }
    }

    if (now < this.nextSpawnAt) return;
    // Long/paused ticks never create a burst of overdue pickups.
    this.nextSpawnAt = now + POWERUP_RULES.spawnMinMs
      + this.random() * (POWERUP_RULES.spawnMaxMs - POWERUP_RULES.spawnMinMs);
    if (this.active.size >= POWERUP_RULES.maxActive) return;
    const candidates = this.findSites().filter((site) => this.isSupported(site)
      && !Array.from(this.active.values()).some((pickup) =>
        Math.hypot(pickup.x - site.x, pickup.z - site.z) < POWERUP_RULES.minimumSeparation));
    const alternatives = candidates.filter((site) => !this.lastSite
      || Math.hypot(site.x - this.lastSite.x, site.z - this.lastSite.z) >= POWERUP_RULES.minimumSeparation);
    const pool = alternatives.length ? alternatives : candidates;
    if (!pool.length) return;
    const site = pool[Math.floor(this.random() * pool.length)];
    const type = this.lastSite ? TYPES[Math.floor(this.random() * TYPES.length)] : 'armor';
    const id = `powerup-${++this.sequence}`;
    this.active.set(id, { id, type, x: site.x, y: site.y, z: site.z,
      expiresAt: now + POWERUP_RULES.lifetimeMs });
    this.lastSite = { ...site };
  }
}
