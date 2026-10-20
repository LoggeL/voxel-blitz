/**
 * Redrock Dam breach in the world (docs/conquest.md "Redrock Dam breach"):
 * presentation only, from `map_event` events and the snapshot's `ev` row.
 *
 *   armed    a fuse beep at each planted charge, faster in the last 10 s
 *   warning  the siren (the procedural alarm triad, repeated) across the
 *            dam and a rising rumble with grit off the crest and shake
 *   active   the blast at the crest, a heavy shake, then the flood: the
 *            client's own build of the flood field (shared/world/flood-field.js,
 *            from its world before the breach: the same tables the server runs)
 *            joins LOCAL_FLOOD (the player physics swims in it), the smooth
 *            flood surface (../flood-surface.js) draws the basin, the sheet
 *            through the gap and the canyon wave with the voxel basin clipped
 *            under it, the waterfall and mist emitters stand at the sill, and
 *            spray, shake and rumble ride the wave front
 *   done     the field settles (physics only), the surface and clip go (the
 *            committed voxels show the new water), a thin cascade and mist stay
 *
 * The field's clock is the snapshot's seconds since the breach (ev extra
 * [mask, sinceDs]), so a joiner picks the wave up where it is. No dedicated
 * recording: the alarm, explosion and structure voices stand in
 * (docs/audio/conquest-sfx.md lists the gap).
 */
import { DAM_TUNING } from '../../../../shared/map-events/dam.js';
import { LOCAL_FLOOD, buildDamFlood } from '../../../../shared/world/flood-field.js';
import { getBlock } from '../../../../shared/worlddata.js';
import { riverCentreX } from '../../../../shared/world/redrock-terrain.js';
import { FloodSurface } from '../flood-surface.js';

export const DAM_FX_RULES = Object.freeze({
  beepMs: 1000, beepFastMs: 400, fastUnderMs: 10000,
  sirenMs: 1100, rumbleMs: 700,
  breachTrauma: 0.9, breachRangeM: 360, warnTrauma: 0.05, waveTrauma: 0.18, waveRangeM: 90,
  fall: Object.freeze({ rate: 70, scale: 2.6 }), mist: Object.freeze({ rate: 18, scale: 4.5 }),
  settled: Object.freeze({ rate: 16, scale: 1.8 }),
});

const b = DAM_TUNING.breach;
const GAP = Object.freeze({ x: (b.x0 + b.x1 + 1) / 2, z0: b.z0, z1: 390, sillY: b.y0, crestY: 34 });

const state = { phase: null, lastBeep: 0, lastSiren: 0, lastRumble: 0, front: 0, nowMs: () => performance.now(), event: null,
  field: null, surface: null, startMs: null };

/** Seconds since the breach on the local clock (null before it). */
const floodT = () => (state.startMs == null ? null : Math.max(0, (state.nowMs() - state.startMs) / 1000));

/** The client's field, built once from its world (pristine until the breach; 60-70 ms). */
function ensureField() {
  if (!state.field) state.field = buildDamFlood((x, y, z) => getBlock(x, y, z), DAM_TUNING.flood);
  return state.field;
}

/** The breach started `sinceS` ago: the field runs from then (physics and surface). */
function startFlood(kit, sinceS) {
  const field = ensureField();
  const startMs = state.nowMs() - Math.max(0, sinceS) * 1000;
  // Re-anchor only on a real slip (the wire rounds to 0.1 s and lags a frame or two).
  if (state.startMs == null || Math.abs(state.startMs - startMs) > 400) state.startMs = startMs;
  LOCAL_FLOOD.nowMs = state.nowMs();
  if (LOCAL_FLOOD.get('dam')?.startMs !== state.startMs) LOCAL_FLOOD.add('dam', field, state.startMs);
  const scene = kit.scene?.();
  if (scene && !state.surface) { state.surface = new FloodSurface({ scene }); state.surface.build(field); }
}

/** The water has settled: physics keeps the settled field, the surface and the clip go (the voxels hold it now). */
function settleFlood() {
  if (state.field) LOCAL_FLOOD.add('dam', state.field, -Infinity);
  state.surface?.dispose(); state.surface = null;
}

function stopFlood() {
  LOCAL_FLOOD.remove('dam');
  state.surface?.dispose(); state.surface = null;
  state.startMs = null;
}

/** A random point across the gap at height `y`, `z` (an emitter's pos, re-read every frame). */
const across = (y, z) => () => [b.x0 + 0.5 + Math.random() * (b.x1 - b.x0), y, z];

function startFall(kit, settled = false) {
  const r = settled ? DAM_FX_RULES.settled : DAM_FX_RULES.fall;
  // The cascade off the sill into the canyon, and the mist cloud it throws up.
  kit.emitter('dam:fall', { kind: 'water', pos: across(GAP.sillY + 1.2, GAP.z1 + 0.5), rate: r.rate,
    params: { scale: r.scale, speed: 1.6, dir: [0, -0.35, 1], spread: 0.45, life: 1.3 } });
  kit.emitter('dam:mist', { kind: 'smoke', pos: across(GAP.sillY + 1.5, GAP.z1 + 7), rate: settled ? 4 : DAM_FX_RULES.mist.rate,
    params: { scale: DAM_FX_RULES.mist.scale, color: [0.82, 0.87, 0.9], alpha: 0.4, speed: 0.7, life: 1.6 } });
  // The reservoir pouring into the gap on the upstream side.
  if (!settled) kit.emitter('dam:intake', { kind: 'water', pos: across(GAP.sillY + 2, GAP.z0 - 1), rate: 30,
    params: { scale: 1.6, speed: 1.2, dir: [0, 0.2, 1], spread: 0.6, life: 1 } });
}

export const DAM_FX = Object.freeze({
  onEvent(ev, kit) {
    if (ev.note) return false;
    const at = Array.isArray(ev.pos) ? ev.pos : kit.anchor('dam');
    if (ev.phase === 'warning') {
      state.lastSiren = 0;
      kit.sound.creak([GAP.x, GAP.crestY, 384], { n: 260, seconds: 1.6 });
      return true;
    }
    if (ev.phase === 'active') {
      const crest = [GAP.x, GAP.crestY, 384];
      kit.sound.blast(crest, 'bomb');
      kit.sound.blast([GAP.x - 6, 24, 383.5], 'rocket');
      kit.sound.impact(crest, { n: 420, speed: 14 });
      kit.shake(crest, DAM_FX_RULES.breachTrauma, DAM_FX_RULES.breachRangeM);
      for (let i = 0; i < 14; i++) kit.puff('dust', kit.ring(crest, 10, GAP.crestY), { count: 6, scale: 3, speed: 1.6 });
      for (let i = 0; i < 8; i++) kit.puff('water', kit.ring([GAP.x, 24, GAP.z1 + 2], 8, 24), { count: 10, scale: 2.4, speed: 2 });
      startFall(kit);
      if (kit.scene?.()) startFlood(kit, 0);
      return true;
    }
    if (ev.phase === 'done') { startFall(kit, true); kit.stopEmitter('dam:intake'); settleFlood(); return true; }
    return !!at;
  },

  sync(event, kit, { fresh }) {
    state.event = event;
    const live = !!kit.scene?.();
    // The field is built while the dam still stands (armed, siren), so it reads the pristine canyon.
    if (live && (event.phase === 'armed' || event.phase === 'warning')) ensureField();
    if (fresh || event.phase !== state.phase) {
      // A joiner (or a missed phase) starts the standing sources of what it finds.
      if (event.phase === 'active' && (fresh || state.phase !== 'active')) startFall(kit);
      if (event.phase === 'done') { startFall(kit, true); if (live) { ensureField(); settleFlood(); } }
      state.phase = event.phase;
    }
    const now = state.nowMs();
    const [mask = 0, sinceDs = 0] = event.extra ?? [];
    if (event.phase === 'active' && live) startFlood(kit, sinceDs / 10);
    const t = event.phase === 'active' ? floodT() : null;
    const front = t != null && state.field ? state.field.front(t) : 0;
    if (event.phase === 'armed' && mask && Number.isFinite(event.leftMs)) {
      const every = event.leftMs < DAM_FX_RULES.fastUnderMs ? DAM_FX_RULES.beepFastMs : DAM_FX_RULES.beepMs;
      if (now - state.lastBeep >= every) {
        state.lastBeep = now;
        DAM_TUNING.charges.forEach((c, i) => { if (mask & (1 << i)) kit.audio?.atMineArm?.([c.x, c.y + 0.4, c.z]); });
      }
    }
    if (event.phase === 'warning') {
      if (now - state.lastSiren >= DAM_FX_RULES.sirenMs) {
        state.lastSiren = now;
        kit.audio?.bastionCue?.('bastion_alarm', [GAP.x, GAP.crestY + 8, 384]);
        kit.audio?.bastionCue?.('bastion_alarm', null);
      }
      if (now - state.lastRumble >= DAM_FX_RULES.rumbleMs) {
        state.lastRumble = now;
        kit.sound.creak([GAP.x, GAP.crestY - 4, 384], { n: 180, seconds: 0.9 });
        kit.shake([GAP.x, GAP.crestY, 384], DAM_FX_RULES.warnTrauma, DAM_FX_RULES.breachRangeM);
        kit.puff('grit', kit.ring([GAP.x, GAP.crestY, 384], 9, GAP.crestY - 1), { count: 5, scale: 1.2 });
      }
    }
    if (event.phase === 'active' && front > DAM_TUNING.flood.canyon.z0 && front < DAM_TUNING.flood.canyon.z1 && now - state.lastRumble >= DAM_FX_RULES.rumbleMs) {
      state.lastRumble = now;
      const at = [riverCentreX(front), state.field.rowLevel(front - 4, t) + 0.5, front];
      kit.shake(at, DAM_FX_RULES.waveTrauma, DAM_FX_RULES.waveRangeM);
      for (let i = 0; i < 4; i++) kit.puff('water', kit.ring(at, 9, at[1]), { count: 12, scale: 2.2, speed: 2.4 });
      kit.sound.impact(at, { n: 160, speed: 6, material: 'stone' });
    }
  },

  update() {
    if (!LOCAL_FLOOD.get('dam')) return;
    LOCAL_FLOOD.nowMs = state.nowMs();
    const t = floodT();
    if (state.surface && t != null) state.surface.update(t, state.nowMs());
  },

  end() { stopFlood(); state.phase = null; state.event = null; },
  clear() { stopFlood(); state.field = null; state.phase = null; state.event = null; state.lastBeep = state.lastSiren = state.lastRumble = 0; },
});
