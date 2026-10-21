/**
 * Flag radars in the world (docs/conquest.md "Flag radars"): presentation
 * only, from the snapshot's `ev` row and the `map_event` events. The
 * structural system draws the structure: the groan's creak (the server's
 * `creak` of its cells shakes them and plays the structure creak), the
 * chunks' fall and the landing.
 *
 *   antenna  a rotating head on every radar of the map (./radar-head.js, a
 *            three.js model on the site's `mount`, never map voxels): parked
 *            with a grey accent while the flag is neutral (no row), spinning
 *            up to a turn every 3.75 s with the owner's colour on its accent
 *            bar and beacon while a side holds it, labouring and wobbling
 *            once the pool is below half, stopped, leaning and blinking
 *            through the groan, and down with its part as the radar falls (a
 *            quarter turn over the topple hinge, or a drop with a collapse in
 *            place); a joiner sees a fallen radar's antenna gone
 *   wave     every sweep a ring in the owner's colour runs out from the
 *            antenna to the 400 m air ring and fades (the 240 m ground ring
 *            at about half strength), a faint shell hanging under it, and the
 *            beacon flashes. The sweep moment is the row's: `leftMs` to the
 *            next sweep counts down between rows and wraps to 15 s as it
 *            fires, so every client shows the server's sweep (no wire of its own)
 *   warning  a light shake and grit off the structure as it starts to groan
 *   done     a heavier shake as it goes, dust round its foot
 *
 * Low tier: the ring only, no shell, fewer segments. Reduced motion: the
 * ring dimmer and no shell, the antenna at 40 % speed without jitter.
 * Colours are the HUD's (cyan own side, orange enemy, from the viewer).
 * No sweep sound: there is no recording for it (docs/audio/conquest-sfx.md).
 */
import { RADAR_SITES, RADAR_TUNING as T, radarMountPart, radarOnline } from '../../../../shared/map-events/radar.js';
import { RADAR_COLORS } from '../../ui/conquest/map-events/radar.js';
import { RadarHead, RADAR_HEAD_RULES } from './radar-head.js';

export const RADAR_FX_RULES = Object.freeze({ groanTrauma: 0.08, fallTrauma: 0.35, rangeM: 160, grit: 6, dust: 10, ringM: 7 });

/** The antenna's and the wave's presentation tuning (no gameplay meaning). */
export const RADAR_HEAD_FX = Object.freeze({
  /** rad/s while a side owns it (four turns a sweep), its spin-up and spin-down (rad/s²). */
  spin: Math.PI * 2 / 3.75, spinAccel: 1.4,
  /** Below `damagedShare` of its pool: the spin labours to this share and the head wobbles (rad). */
  damagedSpin: 0.7, wobble: 0.05,
  /** Through the groan: the lean toward the fall line (rad) and its jitter. */
  groanTilt: 0.16, groanJitter: 0.03,
  /** The fall: its start after `done` (the structure's creak), the topple's quarter turn (s), a collapse's gravity, the last rest before it goes. */
  fallDelayS: 0.5, toppleS: 2.2, dropG: 14, restS: 0.25,
  /** Reduced motion: the spin's share. */
  reducedSpin: 0.4,
  /** The beacon's flash as a sweep fires (ms). */
  flashMs: 450,
  wave: Object.freeze({ ms: 3200, radiusM: T.airM, ringAlpha: 0.75, shellAlpha: 0.2, shellM: 34, reducedAlpha: 0.6 }),
});

/** The colour of `team`'s radar for a viewer on `selfTeam` (a spectator: alpha as own). */
export function radarSideColor(team, selfTeam) {
  if (!team) return RADAR_COLORS.neutral;
  const own = selfTeam ? team === selfTeam : team === 'alpha';
  return own ? RADAR_COLORS.own : RADAR_COLORS.enemy;
}

/** A fresh antenna state (also after a map change or a match end). */
export function radarHeadState() {
  return { phase: null, t: 0, leftMs: null, since: 0, angle: 0, speed: 0, groanT: 0, fallT: null, restT: 0, gone: false };
}

/**
 * One frame of one antenna: advances `st` by `dt` seconds from the decoded
 * row (null while the flag is neutral) and returns its pose
 * {visible, angle, tilt, accent, accentGain, beaconGain, fall, wave, waveAge, puff}.
 */
export function stepRadarHead(st, row, dt, site, { selfTeam = null, reducedMotion = false, tier = 'medium' } = {}) {
  const R = RADAR_HEAD_FX, W = R.wave, part = radarMountPart(site), m = site.mount;
  const phase = row?.phase ?? 'idle';
  if (st.phase === null && phase === 'done') st.gone = true;                       // a joiner: already down
  else if (phase === 'done' && st.phase !== 'done' && !st.gone) { st.fallT = -R.fallDelayS; st.restT = 0; }
  else if (phase !== 'done' && st.phase === 'done') Object.assign(st, { gone: false, fallT: null, angle: 0, speed: 0 }); // a rematch
  st.groanT = phase === 'warning' ? st.groanT + dt : 0;
  st.phase = phase;
  st.t += dt;
  // The sweep clock: the row's 0.1 s countdown, run on between rows.
  if (row && Number.isFinite(row.leftMs)) {
    if (row.leftMs !== st.leftMs) { st.leftMs = row.leftMs; st.since = 0; } else st.since += dt * 1000;
  } else { st.leftMs = null; st.since = 0; }
  const online = radarOnline(row), damaged = online && row.progress >= 1 - T.damagedShare;
  const waveAge = online && st.leftMs != null ? T.everyMs - (st.leftMs - st.since) : Infinity;

  let target = online ? R.spin : 0;
  if (damaged) target *= R.damagedSpin * (0.75 + 0.25 * Math.sin(st.t * 2.3));
  if (reducedMotion) target *= R.reducedSpin;
  const step = R.spinAccel * dt;
  st.speed += Math.max(-step, Math.min(step, target - st.speed));
  st.angle = (st.angle + st.speed * dt) % (Math.PI * 2);

  const dir = part?.topple?.dir ?? null;
  const tilt = [0, 0];
  if (phase === 'warning') {
    const lean = R.groanTilt * Math.min(1, st.groanT / (T.groanMs / 1000));
    const jitter = reducedMotion ? 0 : Math.sin(st.t * 31) * R.groanJitter;
    tilt[0] = (dir ? dir[1] * lean : lean * 0.5) + jitter;
    tilt[1] = (dir ? -dir[0] * lean : 0) + jitter * 0.6;
  } else if (damaged && !reducedMotion) {
    tilt[0] = Math.sin(st.t * 7) * R.wobble;
    tilt[1] = Math.cos(st.t * 5.3) * R.wobble * 0.6;
  }

  const team = row?.team ?? null;
  const accent = online || phase === 'warning' ? radarSideColor(team, selfTeam) : RADAR_HEAD_RULES.idle;
  let accentGain = online ? 1.05 : 0.6, beaconGain = online ? 1.2 : 0.4;
  if (phase === 'warning') accentGain = beaconGain = Math.sin(st.t * 18) > 0 ? 1.6 : 0.3;
  if (phase === 'done') accentGain = beaconGain = 0.2;
  if (waveAge >= 0 && waveAge < R.flashMs * 4) beaconGain += 3 * Math.exp(-waveAge / R.flashMs);

  // The fall with its part: a quarter turn over the hinge, or a drop to the part's foot.
  let fall = null, puff = null;
  if (st.fallT != null && !st.gone) {
    st.fallT += dt;
    const t = Math.max(0, st.fallT);
    if (part?.topple) {
      const [ux, uz] = part.topple.dir, angle = Math.min(Math.PI / 2, 0.5 * (Math.PI / R.toppleS ** 2) * t * t);
      fall = { hinge: part.topple.hinge, axis: [uz, -ux], angle };
      if (angle >= Math.PI / 2) st.restT += dt;
    } else {
      const floor = Math.min(...(part?.boxes ?? [{ y0: m.y - 6 }]).map(b => b.y0));
      const drop = Math.min(m.y - floor, 0.5 * R.dropG * t * t);
      fall = { drop, roll: Math.min(0.6, t * 0.5) };
      if (drop >= m.y - floor) st.restT += dt;
    }
    if (st.restT >= R.restS) {
      st.gone = true;
      const h = part?.topple?.hinge;
      puff = h ? [h[0] + part.topple.dir[0] * (m.y - h[1]), h[1] + 1, h[2] + part.topple.dir[1] * (m.y - h[1])]
        : [m.x, Math.min(...(part?.boxes ?? [{ y0: m.y - 6 }]).map(b => b.y0)) + 1, m.z];
    }
  }

  let wave = null;
  if (waveAge >= 0 && waveAge < W.ms) {
    const k = waveAge / W.ms, fade = Math.min(1, k * 10) * (1 - k) ** 1.4;
    wave = { r: W.radiusM * (1 - (1 - k) ** 2), color: radarSideColor(team, selfTeam),
      alpha: W.ringAlpha * fade * (reducedMotion ? W.reducedAlpha : 1),
      shellAlpha: tier === 'low' || reducedMotion ? 0 : W.shellAlpha * fade, shellM: W.shellM };
  }
  return { visible: !st.gone, angle: st.angle, tilt, accent, accentGain, beaconGain, fall, wave, waveAge, puff };
}

const RADAR_EVENT_FX = Object.freeze({
  onEvent(ev, kit) {
    if (ev.note) return true;
    const at = Array.isArray(ev.pos) ? ev.pos : kit.anchor(ev.event);
    if (!at) return true;
    const R = RADAR_FX_RULES;
    if (ev.phase === 'warning') {
      kit.shake(at, R.groanTrauma, R.rangeM);
      for (let i = 0; i < R.grit; i++) kit.puff('grit', kit.ring(at, 3, at[1]), { count: 3, scale: 1.2, speed: 0.8 });
    } else if (ev.phase === 'done') {
      kit.shake(at, R.fallTrauma, R.rangeM);
      for (let i = 0; i < R.dust; i++) kit.puff('dust', kit.ring(at, R.ringM, at[1] - 6), { count: 4, scale: 2.4, speed: 1.2 });
    }
    return true;
  },
});

/** The hook of one radar id: its antenna and wave every frame, the shared phase effects. */
export function radarFx(id) {
  const site = RADAR_SITES[id];
  const hook = {
    id,
    state: radarHeadState(),
    head: null,
    pose: null,
    onEvent: RADAR_EVENT_FX.onEvent,
    update(dt, kit) {
      if (kit.mapId !== site.map) { if (this.head) this.clear(kit); return; }
      const row = kit.events?.find?.(e => e.id === id) ?? null;
      const opts = { selfTeam: kit.selfTeam ?? null, reducedMotion: !!kit.reducedMotion, tier: kit.tier ?? 'medium' };
      const pose = this.pose = stepRadarHead(this.state, row, Math.max(0, Math.min(0.25, dt || 0)), site, opts);
      if (pose.puff) for (let i = 0; i < 4; i++) kit.puff('dust', kit.ring(pose.puff, 2, pose.puff[1]), { count: 3, scale: 1.4, speed: 0.9 });
      const scene = kit.scene?.() ?? null;
      if (!this.head && scene) this.head = new RadarHead(scene, site, { shell: opts.tier !== 'low', segments: opts.tier === 'low' ? 64 : 128 });
      this.head?.pose(pose);
    },
    clear() {
      this.head?.dispose();
      this.head = null;
      this.pose = null;
      this.state = radarHeadState();
    },
  };
  return hook;
}

/** The FX hook of every radar id (the FX registry spreads it into its radar slot): one per id, each driving its own antenna. */
export const RADAR_FX_HOOKS = Object.freeze(Object.fromEntries(Object.keys(RADAR_SITES).map(id => [id, radarFx(id)])));
/** The phase effects alone (shake, grit, dust), as every radar's hook runs them. */
export const RADAR_FX = RADAR_EVENT_FX;
