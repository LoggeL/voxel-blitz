import { WEAPON_IDS } from '../../shared/combatmath.js';
import {
  DEFAULT_MODE_ID,
  MAX_CREDITS,
  isTeamId,
  isWeaponId,
} from '../../shared/modes.js';
import { isRecord } from './admission.js';

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
export function makeSnapshot(playersArr, blockDeltas, eventsArr, nowMs, match = undefined) {
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
      panic: round(Math.max(0, Math.min(1, Number.isFinite(p.panic) ? p.panic : 0)), D3),
      pain: round(Math.max(0, Math.min(1, Number.isFinite(p.pain) ? p.pain : 0)), D3),
      exhaustion: round(Math.max(0, Math.min(1, Number.isFinite(p.exhaustion) ? p.exhaustion : 0)), D3),
      spawnProtected: !!p.spawnProtected,
      weapon: weaponSlot(p.weapon),
      score: p.score | 0,
      kills: p.kills | 0,
      deaths: p.deaths | 0,
      state: p.state === 'dead' ? 'dead' : 'alive',
      firing: !!p.firing,
      ads: !!p.ads,
      mag: ammoCopy(p.mag),
      reserve: ammoCopy(p.reserve),
      reloading: !!p.reloading,
      team: isTeamId(p.team) ? p.team : null,
      credits: Number.isFinite(p.credits)
        ? Math.max(0, Math.min(MAX_CREDITS, Math.trunc(p.credits)))
        : 0,
      owned: ownedWeapons(p.owned),
      bomb: !!p.bomb,
      interaction: interactionCopy(p.interaction),
    })),
    // Engines clear these scratch arrays after broadcasting, so snapshots must
    // not retain either source array.
    blocks: (blockDeltas || []).map((b) => ({ i: b.i | 0, v: b.v | 0 })),
    events: (eventsArr || []).slice(),
  };
}
