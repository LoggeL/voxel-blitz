import { normalizeCosmeticLoadout } from '../../../shared/career.js';
import { KILLCAM, supportsKillcam, killcamWeaponAllowed } from '../../../shared/killcam-rules.js';
import { copySmokeFields } from '../../../shared/smoke-rules.js';

const POSE_FIELDS = ['id', 'name', 'x', 'y', 'z', 'yaw', 'pitch', 'state', 'hp',
  'weapon', 'firing', 'ads', 'adsT', 'scopeZoom', 'attachments', 'reloading', 'deploying', 'grenadeHandling', 'crouch', 'proneT', 'leanT', 'grounded', 'vaulting', 'swimming', 'moveSpeed', 'team', 'charge',
  // Conquest/Titanfall: the seat a body rides (hidden avatar, seat camera) and the titanfall pilot state
  // (`tf`: wallrun, slide, grapple, cloak, rodeo) the replay poses from.
  'vehicleId', 'vehicleSeatId', 'tf', 'chute'];
/** Vehicle and titan row fields interpolated between frames (the rest switch at their frame). */
const VEHICLE_LINEAR = ['x', 'y', 'z'];
const VEHICLE_ANGLES = ['yaw', 'pitch', 'roll', 'legYaw', 'turretYaw'];
/** A hull farther apart than this between two frames jumped (respawn, drop start): no path between. */
const VEHICLE_JUMP_M = 40;
const EVENT_KINDS = new Set(['shoot', 'bullet', 'hit', 'kill', 'mine', 'block', 'blockDamage',
  'projectileLaunch', 'projectileUpdate', 'projectileStick', 'projectileExplode',
  // Structural collapses (docs/structural-physics.md): replays drop the same chunks.
  'creak', 'collapse', 'collapseLand', 'crumble']);
const lerp = (a, b, t) => a + (b - a) * t;
const angle = (a, b, t) => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * t;

/** Bounded presentation data, separate from prediction and the live event cursor. */
export class KillcamHistory {
  constructor(terrain = null) { this.frames = []; this.terrain = terrain; }
  clear() { this.frames.length = 0; }
  record(snapshot) {
    const time = snapshot?.serverNow;
    if (!Number.isFinite(time)) return;
    // Boot can flush snapshots already represented by the initial terrain copy.
    if (this.terrain && time <= this.terrain.time) return;
    if (this.frames.length && time <= this.frames.at(-1).time) return;
    let effects = 0;
    this.frames.push({ time,
      players: (snapshot.players || []).filter(p => p && [p.x, p.y, p.z, p.yaw, p.pitch].every(Number.isFinite))
        .map(p => ({ ...Object.fromEntries(POSE_FIELDS.map(key => [key, p[key]])), cosmetics: normalizeCosmeticLoadout(p.cosmetics) })),
      // Large explosions must not crowd out the killer's confirmed hits.
      events: structuredClone((snapshot.events || []).filter(e => EVENT_KINDS.has(e?.kind)
        && (e.kind === 'hit' || e.kind === 'kill' || effects++ < 256))),
      // Conquest hulls and Titanfall titans (VehicleView rows): a shallow copy per frame.
      vehicles: Array.isArray(snapshot.vehicles) ? snapshot.vehicles
        .filter(v => v && v.id != null && [v.x, v.y, v.z].every(Number.isFinite)).map(v => ({ ...v })) : [],
      smokeFields: copySmokeFields(snapshot.smokeFields),
      // Titanfall minions (compact `match.titanfall.npc` rows; a snapshot without them keeps the last list).
      npcs: Array.isArray(snapshot.match?.titanfall?.npc) ? snapshot.match.titanfall.npc.slice() : this.frames.at(-1)?.npcs ?? null,
      terrain: this.terrain?.record(snapshot) || [],
    });
    const clip = this.activeClip;
    if (clip && time > clip.killTime && time <= clip.end && clipContinues(clip, clip.frames.at(-1))) {
      clip.frames.push(this.frames.at(-1));
    }
    while (this.frames.length > KILLCAM.maxFrames || (this.frames.length > 2
      && this.frames[1].time < time - KILLCAM.historyMs)) this.frames.shift();
  }
  /**
   * The replay of one `kill` event, or null. `kv`/`ks` (server killcam focus): the hull the
   * kill came from and the killer's seat in it. With a seat the camera rides the killer
   * (seat camera while seated, first person on foot); without one (an auto-titan, a crush by
   * an empty titan) it follows that hull from behind.
   */
  clip({ killer, victim, w, kv = null, ks = null }, mode) {
    if (!supportsKillcam(mode) || !killer || killer === victim || !killcamWeaponAllowed(w)) return null;
    const end = this.frames.at(-1)?.time;
    const focus = kv != null && kv !== '' ? { vehicleId: String(kv), seatId: ks != null && ks !== '' ? String(ks) : null } : null;
    const follow = focus && !focus.seatId ? 'vehicle' : 'player';
    const probe = { killer, focus, follow };
    // Never replay a previous life; append only the bounded post-kill window.
    let frames = this.frames.filter(f => f.time >= end - KILLCAM.historyMs);
    let start = frames.length - 1;
    while (start >= 0 && (start === frames.length - 1 ? clipSubject(probe, frames[start]) : clipContinues(probe, frames[start]))) start--;
    frames = frames.slice(start + 1);
    if (frames.length < 2 || end - frames[0].time < 250) return null;
    return this.activeClip = { killer, victim, weapon: w, focus, follow, frames, start: frames[0].time, killTime: end, end: end + KILLCAM.postKillMs,
      terrain: this.terrain?.clip(frames) || null,
      name: frames.at(-1).players.find(p => p.id === killer)?.name || 'OPERATOR' };
  }
}

/** The clip's subject is in this frame (alive or not: the kill frame may show it dying). */
function clipSubject(clip, frame) {
  if (clip.follow === 'vehicle') return frame.vehicles?.some(v => String(v.id) === clip.focus.vehicleId) === true;
  return frame.players.some(p => p.id === clip.killer);
}

/** The clip's subject is alive in this frame: the killer's life, or the followed hull. */
function clipContinues(clip, frame) {
  if (clip.follow === 'vehicle') return frame.vehicles?.some(v => String(v.id) === clip.focus.vehicleId && !(v.hp <= 0) && !v.wreck) === true;
  return frame.players.some(p => p.id === clip.killer && p.state === 'alive');
}

const VEHICLE_ROW_DEFAULTS = Object.freeze([]);
/** Interpolated hull rows of one replay instant (sampleKillcam). */
function sampleVehicles(a, b, t) {
  const next = new Map((b.vehicles || VEHICLE_ROW_DEFAULTS).map(v => [String(v.id), v]));
  return new Map((a.vehicles || VEHICLE_ROW_DEFAULTS).map(v => {
    const q = next.get(String(v.id)), row = { ...v };
    if (q && (q.type ?? q.kind) === (v.type ?? v.kind) && Math.hypot(q.x - v.x, q.y - v.y, q.z - v.z) < VEHICLE_JUMP_M) {
      for (const key of VEHICLE_LINEAR) row[key] = lerp(v[key], q[key], t);
      for (const key of VEHICLE_ANGLES) if (Number.isFinite(v[key]) && Number.isFinite(q[key])) row[key] = angle(v[key], q[key], t);
    }
    return [String(v.id), row];
  }));
}

/** Interpolate recorded poses; discrete state takes effect at its own frame. */
export function sampleKillcam(clip, time, previousTime = -Infinity) {
  const frames = clip.frames;
  const at = Math.max(clip.start, Math.min(clip.end, time));
  let i = 0;
  while (i < frames.length - 1 && frames[i + 1].time <= at) i++;
  const a = frames[i], b = frames[Math.min(i + 1, frames.length - 1)];
  const t = b.time === a.time ? 0 : (at - a.time) / (b.time - a.time);
  const next = new Map(b.players.map(p => [p.id, p]));
  const players = new Map(a.players.map(p => {
    const q = next.get(p.id), row = { ...p };
    // A respawn/teleport is a discontinuity, never a path through walls.
    if (q && p.state === q.state && Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z) < 8) {
      for (const key of ['x', 'y', 'z', 'pitch']) row[key] = lerp(p[key], q[key], t);
      row.yaw = angle(p.yaw, q.yaw, t);
      if (Number.isFinite(p.adsT) && Number.isFinite(q.adsT)) row.adsT = lerp(p.adsT, q.adsT, t);
    }
    return [p.id, row];
  }));
  const crossed = frames.filter(f => f.time > previousTime && f.time <= at);
  return { time: at, players, vehicles: sampleVehicles(a, b, t), npcs: a.npcs || b.npcs ? { a: a.npcs, b: b.npcs, t } : null,
    smokeFields: a.smokeFields,
    // The terrain copy already includes the first frame.
    terrain: crossed.filter(f => f.time > clip.start).flatMap(f => f.terrain),
    events: crossed.flatMap(f => f.events),
    hitmark: sampleHitmark(clip, Math.max(clip.start, time)) };
}

function sampleHitmark(clip, time) {
  let mark = null;
  for (const frame of clip.frames) {
    if (frame.time > time) break;
    if (frame.time < time - 520) continue;
    for (const event of frame.events) {
      const kill = event.kind === 'kill' && event.killer === clip.killer;
      const hit = event.kind === 'hit' && event.attacker === clip.killer;
      if ((!kill && !hit) || event.victim === clip.killer) continue;
      if (mark?.kill && frame.time < mark.until && !kill) continue;
      mark = { kind: kill ? (event.hs ? 'killHead' : 'kill') : (event.hs ? 'head' : 'body'),
        kill, time: frame.time, until: frame.time + (kill ? 520 : 210) };
    }
  }
  return mark && time < mark.until ? mark : null;
}
