import { KILLCAM, supportsKillcam } from '../../../shared/killcam-rules.js';
import { copySmokeFields } from '../../../shared/smoke-rules.js';

const POSE_FIELDS = ['id', 'name', 'x', 'y', 'z', 'yaw', 'pitch', 'state', 'hp',
  'weapon', 'firing', 'ads', 'crouch', 'proneT', 'grounded', 'vaulting', 'moveSpeed', 'team', 'charge'];
const EVENT_KINDS = new Set(['shoot', 'projectileLaunch', 'projectileStick', 'projectileExplode']);
const lerp = (a, b, t) => a + (b - a) * t;
const angle = (a, b, t) => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * t;

/** Bounded presentation data, separate from prediction and the live event cursor. */
export class KillcamHistory {
  constructor() { this.frames = []; }
  clear() { this.frames.length = 0; }
  record(snapshot) {
    const time = snapshot?.serverNow;
    if (!Number.isFinite(time)) return;
    if (this.frames.length && time <= this.frames.at(-1).time) return;
    this.frames.push({ time,
      players: (snapshot.players || []).filter(p => p && [p.x, p.y, p.z, p.yaw, p.pitch].every(Number.isFinite))
        .map(p => Object.fromEntries(POSE_FIELDS.map(key => [key, p[key]]))),
      events: structuredClone((snapshot.events || []).filter(e => EVENT_KINDS.has(e?.kind)).slice(0, 256)),
      smokeFields: copySmokeFields(snapshot.smokeFields),
    });
    while (this.frames.length > KILLCAM.maxFrames || (this.frames.length > 2
      && this.frames[1].time < time - KILLCAM.historyMs)) this.frames.shift();
  }
  clip({ killer, victim, w }, mode) {
    if (!supportsKillcam(mode) || !killer || killer === victim) return null;
    const end = this.frames.at(-1)?.time;
    // Never replay a previous life of the attacker or include post-kill movement.
    let frames = this.frames.filter(f => f.time >= end - KILLCAM.historyMs);
    let start = frames.length - 1;
    while (start >= 0 && frames[start].players.some(p => p.id === killer
      && (p.state === 'alive' || start === frames.length - 1))) start--;
    frames = frames.slice(start + 1);
    if (frames.length < 2 || end - frames[0].time < 250) return null;
    return { killer, victim, weapon: w, frames, start: frames[0].time, end,
      name: frames.at(-1).players.find(p => p.id === killer)?.name || 'OPERATOR' };
  }
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
    }
    return [p.id, row];
  }));
  return { time: at, players, smokeFields: a.smokeFields,
    events: frames.filter(f => f.time > previousTime && f.time <= at).flatMap(f => f.events) };
}
