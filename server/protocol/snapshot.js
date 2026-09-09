import { WEAPON_IDS } from '../../shared/combatmath.js';
import { GRENADE_TYPE_IDS } from '../../shared/grenade-rules.js';
import {
  DEFAULT_MODE_ID,
  MAX_CREDITS,
  isTeamId,
  isWeaponId,
} from '../../shared/modes.js';
import { isRecord } from './admission.js';
import { copyBlockDamage } from './block-damage.js';
import { POWERUP_RULES, POWERUP_TYPES } from '../../shared/powerups.js';
import { MOLOTOV_FIRE } from '../../shared/molotov-rules.js';

const D2 = 100, D3 = 1000;

function round(v, d) {
  return Number.isFinite(v) ? Math.round(v * d) / d : 0;
}

function ammoCopy(values) {
  const src = Array.isArray(values) ? values : [];
  return WEAPON_IDS.map((_, i) => {
    const value = src[i];
    return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
  });
}

function grenadeCopy(values) {
  const src = Array.isArray(values) ? values : [];
  return GRENADE_TYPE_IDS.map((_, i) => {
    const value = src[i];
    return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
  });
}

function weaponSlot(value) {
  const slot = Number.isFinite(value) ? Math.trunc(value) : 0;
  return Math.max(0, Math.min(WEAPON_IDS.length - 1, slot));
}

function ownedWeapons(values) {
  if (values === undefined) return WEAPON_IDS.slice();
  if (!Array.isArray(values)) return [];
  const seen = new Set();
  const owned = [];
  for (const value of values) {
    if (isWeaponId(value) && !seen.has(value)) {
      seen.add(value);
      owned.push(value);
    }
  }
  return owned;
}

function interactionCopy(value) {
  if (!isRecord(value) || (value.kind !== 'plant' && value.kind !== 'defuse')) return null;
  return {
    kind: value.kind,
    site: typeof value.site === 'string' ? value.site : null,
    progress: round(Math.max(0, Math.min(1, Number.isFinite(value.progress) ? value.progress : 0)), D3),
  };
}

function wireCopy(value, seen = new WeakSet()) {
  if (value == null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'object' || seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) {
    const copy = value.map((item) => wireCopy(item, seen));
    seen.delete(value);
    return copy;
  }
  const copy = {};
  for (const [key, item] of Object.entries(value)) copy[key] = wireCopy(item, seen);
  seen.delete(value);
  return copy;
}

function defaultMatchSnapshot() {
  return {
    mode: DEFAULT_MODE_ID,
    map: null,
    phase: 'live',
    phaseEndsAt: null,
    scores: null,
    winner: null,
    round: null,
    roundWinner: null,
    attackers: null,
    defenders: null,
    bomb: null,
  };
}

/**
 * Build one wire snapshot from live engine data.
 * Player rows carry the exact contracted field set; positions are 2-decimal,
 * angles 3-decimal so payloads stay small and floats stay finite.
 */
export function makeSnapshot(playersArr, blockDeltas, eventsArr, nowMs, match = undefined, blockDamage = [], powerups = [], fireFields = []) {
  const matchSnapshot = match === undefined
    ? defaultMatchSnapshot()
    : (isRecord(match) ? wireCopy(match) : defaultMatchSnapshot());
  return {
    t: 'tick',
    now: round(nowMs, 1),
    match: matchSnapshot,
    players: (playersArr || []).map((p) => ({
      id: String(p.id),
      name: String(p.name),
      x: round(p.x, D2),
      y: round(p.y, D2),
      z: round(p.z, D2),
      yaw: round(p.yaw, D3),
      pitch: round(p.pitch, D3),
      hp: round(p.hp, 1),
      armor: round(Math.max(0, Math.min(POWERUP_RULES.maxArmor, Number.isFinite(p.armor) ? p.armor : 0)), 1),
      burning: round(Math.max(0, p.burning || 0, p.molotovBurning || 0), D3),
      panic: round(Math.max(0, Math.min(1, Number.isFinite(p.panic) ? p.panic : 0)), D3),
      pain: round(Math.max(0, Math.min(1, Number.isFinite(p.pain) ? p.pain : 0)), D3),
      exhaustion: round(Math.max(0, Math.min(1, Number.isFinite(p.exhaustion) ? p.exhaustion : 0)), D3),
      spawnProtected: !!p.spawnProtected,
      weapon: weaponSlot(p.weapon),
      score: p.score | 0,
      kills: p.kills | 0,
      deaths: p.deaths | 0,
      impulse: p.impulseSeq > 0 && [p.vx, p.vy, p.vz].every(Number.isFinite)
        ? { seq: p.impulseSeq, velocity: [round(p.vx, D2), round(p.vy, D2), round(p.vz, D2)] }
        : null,
      ping: Number.isFinite(p.ping) ? Math.max(0, Math.round(p.ping)) : null,
      state: p.state === 'dead' ? 'dead' : 'alive',
      // Only dead players with an automatic respawn publish a deadline.
      // Round-based modes deliberately expose null instead of Infinity.
      respawnAt: p.state === 'dead' && Number.isFinite(p.respawnAt)
        ? round(p.respawnAt, 1)
        : null,
      firing: !!p.firing,
      ads: !!p.ads,
      crouch: !!p.crouch,
      grounded: !!p.grounded,
      vaulting: !!p.vault,
      proneT: p.proneT || 0,
      moveSpeed: round(Math.hypot(p.vx || 0, p.vz || 0), D2),
      mag: ammoCopy(p.mag),
      reserve: ammoCopy(p.reserve),
      minigun: p.minigun ? { ...p.minigun } : undefined,
      reloading: !!p.reloading,
      reloadAck: p.reloadAck || 0,
      reloadState: p.reloading && p.reloadState ? { ...p.reloadState } : null,
      team: isTeamId(p.team) ? p.team : null,
      credits: Number.isFinite(p.credits)
        ? Math.max(0, Math.min(MAX_CREDITS, Math.trunc(p.credits)))
        : 0,
      owned: ownedWeapons(p.owned),
      ...(p.chaosUpgrades ? { chaosUpgrades: { ...p.chaosUpgrades } } : {}),
      bomb: !!p.bomb,
      interaction: interactionCopy(p.interaction),
      grenades: grenadeCopy(p.grenades),
      charge: round(Math.max(0, Math.min(1, Number.isFinite(p.charge) ? p.charge : 0)), D3),
    })),
    // Engines clear these scratch arrays after broadcasting, so snapshots must
    // not retain either source array.
    blocks: (blockDeltas || []).map((b) => ({ i: b.i | 0, v: b.v | 0 })),
    blockDamage: copyBlockDamage(blockDamage),
    powerups: (Array.isArray(powerups) ? powerups : []).filter((pickup) =>
      pickup && typeof pickup.id === 'string' && Object.hasOwn(POWERUP_TYPES, pickup.type)
        && [pickup.x, pickup.y, pickup.z, pickup.expiresAt].every(Number.isFinite))
      .map(({ id, type, x, y, z, expiresAt }) => ({ id, type,
        x: round(x, D2), y: round(y, D2), z: round(z, D2), expiresAt: round(expiresAt, 1) })),
    fireFields: (Array.isArray(fireFields) ? fireFields : []).filter(field => field
      && typeof field.id === 'string'
      && [field.x, field.y, field.z, field.radius, field.createdAt, field.expiresAt].every(Number.isFinite))
      .slice(0, MOLOTOV_FIRE.maxFields)
      .map(({ id, ownerId, x, y, z, radius, createdAt, expiresAt, cells }) => ({
        id, ownerId: String(ownerId || ''), x: round(x, D2), y: round(y, D2), z: round(z, D2),
        radius: round(radius, D2), createdAt: round(createdAt, 1), expiresAt: round(expiresAt, 1),
        cells: (Array.isArray(cells) ? cells : []).filter(cell => Array.isArray(cell)
          && cell.length === 3 && cell.every(Number.isFinite)).slice(0, MOLOTOV_FIRE.maxCells)
          .map(cell => cell.map(value => round(value, D2))),
      })),
    events: (eventsArr || []).slice(),
  };
}
