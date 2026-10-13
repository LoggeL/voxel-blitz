// Own-titan prediction (docs/titanfall.md §5.1, owned by WP2): runs the shared
// stepTitanWalk for the local titan and hands the pose to
// app.vehicleView.setPredictedPose(id, pose).
//
//   client-module contract  init?(app, client), tick(snapshot, dt), frame(dt, ctx), onEvent(event), dispose()
//
// The predictor steps the walker at the server's fixed 120 Hz substep (an
// accumulator, so 20/60/120 Hz frame rates reach the same pose) against a world
// adapter that mirrors the server's VehicleSystem.solid for ground hulls, and
// reverts a substep that overlaps another solid hull row (the server's
// TitanSystem.hullBlocked). Each authoritative row is compared with the
// predicted trail around one round trip ago (the row is the server's pose after
// the inputs it had then): only samples whose age lies in
// [rtt - early, rtt + late] are candidates, the nearest of them in space is
// "where we were when the server saw us". An error above blendError is blended
// out over blendMs (the trail shifts with it); above snapError the pose and
// trail jump by the error at once.
//
// Controls: forward/back and strafe from the local keys, aim yaw from the seated
// view (main.js writes the vehicle controller's yaw into player.view before
// frame()), sprint from titanHold bit 1 only (the seated send carries no keys).
// WP6's titan controller may install an exact source with setControlsSource(fn).
// Dash: the server dashes along the movement input it holds when the
// `ability:'dash'` intent lands, so noteDash(controls) takes the controls the
// server will use (WP6 sends the movement input right before the dash intent
// and passes those controls); without them the last observed seated send is
// used. A dash the server would refuse (no pip, already dashing) is dropped at
// the press, and a queued dash is one-shot like the server's dashRequest.
import { stepTitanWalk, titanFrame, createTitanMove } from '../../../shared/vehicle-handling/titan.js';
import { decodeTitanRow, isTitanType, TITAN_PHASE, TITAN_ABILITIES } from '../../../shared/titan-contract.js';
import { hullFootprint, footprintsOverlap, solidHull } from '../../../shared/vehicle-collision.js';
import { VEHICLE_RULES } from '../../../shared/vehicles.js';
import { getBlock, isSolidBlock, getMapDimensions } from '../../../shared/worlddata.js';
import { FLUID_BLOCKS } from '../../../shared/world/blocks.js';

export const PREDICT_RULES = Object.freeze({
  step: 1 / 120, maxFrame: 0.25, blendError: 0.25, blendMs: 150, snapError: 3, historyMs: 600, historySamples: 96,
  dashAdoptMs: 500, restError: 0.02, restSpeed: 0.05,
  /** Round trip assumed until the netclient has measured one. */
  defaultRttMs: 100,
  /**
   * Velocity reconcile: with a matched error above velErrorAt metres, a server
   * velocity (from consecutive rows) that differs from the matched sample's by
   * more than velError m/s is adopted (a dash the server is not running ends).
   */
  velErrorAt: 0.5, velError: 3,
  /**
   * Trail window around the round trip: earlier by jitter, later by a server
   * tick, half a seated send period and jitter. Wider windows let the nearest
   * sample in space hide a real divergence (window × speed).
   */
  matchEarlyMs: 30, matchLateMs: 60,
});
/**
 * Titanfall play areas narrower than the map (mirrors server/sim/titanfall/play-area.js
 * PLAY_AREA_RULES.frontier; titanfall-titan-sim-test pins the equality).
 */
export const PREDICT_PLAY_AREAS = Object.freeze({ frontier: Object.freeze({ minX: 256, maxX: 512, minZ: 256, maxZ: 512 }) });
/** Row phases in which the server walks the hull (piloted idle, auto, doomed). */
const WALKING_PHASES = new Set([TITAN_PHASE.idle, TITAN_PHASE.auto, TITAN_PHASE.doomed]);

const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));

/**
 * The walker world of the client: `solidAt` mirrors VehicleSystem.solid for a
 * ground hull (outside the map or above its height is solid), `fluidAt` reads
 * fluid blocks, bounds are the play area (frontier rectangle or the map).
 * options = { getBlock(x,y,z), dimensions {sx,sy,sz}, mapId? }
 */
export function createWalkerWorld({ getBlock: blockAt, dimensions, mapId = null } = {}) {
  const d = dimensions && [dimensions.sx, dimensions.sy, dimensions.sz].every(Number.isFinite) ? dimensions : null;
  const area = PREDICT_PLAY_AREAS[mapId] ?? null;
  return {
    solidAt(x, y, z) {
      if (d && (x < 0 || z < 0 || x >= d.sx || z >= d.sz || y < 0 || y >= d.sy)) return true;
      return isSolidBlock(blockAt(Math.floor(x), Math.floor(y), Math.floor(z)));
    },
    fluidAt: (x, y, z) => FLUID_BLOCKS.has(blockAt(x, y, z)),
    bounds: area ? { ...area } : d ? { minX: 0, maxX: d.sx, minZ: 0, maxZ: d.sz } : null,
    ceiling: d ? d.sy : Infinity,
    revision: undefined,
  };
}

/** One predicted walker: fixed-step stepTitanWalk plus soft reconciliation toward rows. */
export class TitanPredictor {
  constructor(world, rules = PREDICT_RULES) {
    this.world = world;
    this.rules = rules;
    this.v = null;
    this.acc = 0;
    this.clock = 0;
    this.trail = [];
    this.correction = null;
    this.controls = { fwd: 0, side: 0, aimYaw: 0, aimPitch: 0, sprint: false, dash: false, piloted: true };
    this.dashQueued = false;
    this.dashControls = null;
    this.dashAt = -Infinity;
    this.sent = null;
    this.obstacles = [];
    this.rttMs = rules.defaultRttMs ?? 100;
    this.lastError = 0;
    this.snaps = 0;
  }

  get active() { return !!this.v; }

  /** Start (or restart) from an authoritative row. */
  adopt(row) {
    if (!row || !isTitanType(row.type) || ![row.x, row.y, row.z, row.yaw].every(Number.isFinite)) { this.v = null; return false; }
    const titan = decodeTitanRow(row), f = titanFrame(row.type);
    this.v = { id: row.id, type: row.type, x: row.x, y: row.y, z: row.z, yaw: row.yaw, legYaw: row.yaw,
      vx: 0, vy: 0, vz: 0, speed: 0, grounded: true, dash: titan ? titan.dash : f.pips, dashT: 0, dashX: 0, dashZ: 0,
      tfMove: createTitanMove() };
    this.acc = 0;
    this.trail.length = 0;
    this.correction = null;
    this.dashQueued = false;
    this.dashControls = null;
    this.lastRow = null;
    this.lastError = 0;
    return true;
  }

  /** The predicted pose `{ x, y, z, yaw }`, or null. */
  pose() { const v = this.v; return v ? { x: v.x, y: v.y, z: v.z, yaw: v.yaw } : null; }

  /**
   * The pilot sent `ability:'dash'`. Refused at once where the server's
   * `ability()` refuses (no pip, a dash running); `controls` = { fwd, side,
   * aimYaw } the server dashes with (default: the last noteSent controls).
   */
  noteDash(controls = null) {
    const v = this.v;
    if (!v || !(v.dash >= 1) || v.dashT > 0) return false;
    this.dashQueued = true;
    this.dashControls = controls && typeof controls === 'object' ? { ...controls } : this.sent ? { ...this.sent } : null;
    return true;
  }
  /** The seated movement input just sent to the server carried these controls. */
  noteSent(controls) { this.sent = controls && typeof controls === 'object' ? { ...controls } : null; }
  /**
   * Other hull rows the walker must not overlap: the server's hullBlocked set
   * (solid hulls and wrecks, and pending titan drops), minus the own titan.
   */
  setObstacles(rows, ownId = this.v?.id) {
    const list = this.obstacles;
    list.length = 0;
    if (!Array.isArray(rows)) return;
    for (const row of rows) {
      if (!row || row.id === ownId || !VEHICLE_RULES[row.type] || ![row.x, row.y, row.z].every(Number.isFinite)) continue;
      if (solidHull(row) || (isTitanType(row.type) && decodeTitanRow(row)?.phase === TITAN_PHASE.dropping)) list.push(row);
    }
  }
  /** TitanSystem.overlaps against every obstacle row. */
  blocked(v) {
    const ra = VEHICLE_RULES[v.type];
    if (!ra) return false;
    for (const b of this.obstacles) {
      const rb = VEHICLE_RULES[b.type], yaw = finite(b.yaw);
      if (Math.hypot(v.x - b.x, v.z - b.z) > ra.radius + rb.radius + 0.5) continue;
      if (!(v.y < b.y + rb.height && b.y < v.y + ra.height)) continue;
      if (footprintsOverlap(hullFootprint(v.type, v.x, v.z, v.yaw), hullFootprint(b.type, b.x, b.z, yaw))) return true;
    }
    return false;
  }

  /**
   * Advance `dt` seconds with `input` = { fwd, side, aimYaw, sprint }. Fixed
   * substeps at rules.step; the remainder carries to the next frame.
   */
  step(dt, input = {}) {
    const v = this.v;
    if (!v) return null;
    dt = clamp(finite(dt), 0, this.rules.maxFrame);
    this.applyCorrection(dt);
    const c = this.controls;
    c.fwd = clamp(finite(input.fwd), -1, 1);
    c.side = clamp(finite(input.side), -1, 1);
    c.aimYaw = Number.isFinite(input.aimYaw) ? input.aimYaw : v.yaw;
    c.aimPitch = finite(input.aimPitch);
    c.sprint = !!input.sprint;
    c.piloted = true;
    this.acc += dt;
    const h = this.rules.step;
    while (this.acc >= h - 1e-9) {
      this.acc -= h;
      // One-shot, like the server's dashRequest: a dash that cannot fire on this substep is gone.
      const dash = this.dashQueued, pips = v.dash, px = v.x, pz = v.z, pyaw = v.yaw;
      this.dashQueued = false;
      c.dash = dash;
      const live = dash && this.dashControls ? { fwd: c.fwd, side: c.side, aimYaw: c.aimYaw } : null;
      if (live) {
        const d = this.dashControls;
        c.fwd = clamp(finite(d.fwd), -1, 1); c.side = clamp(finite(d.side), -1, 1);
        if (Number.isFinite(d.aimYaw)) c.aimYaw = d.aimYaw;
      }
      stepTitanWalk(v, c, h, this.world);
      if (live) { c.fwd = live.fwd; c.side = live.side; c.aimYaw = live.aimYaw; }
      if (dash) { this.dashControls = null; if (v.dashT > 0 && v.dash < pips) this.dashAt = this.clock; }
      c.dash = false;
      // The server reverts a substep that overlaps another hull (TitanSystem.advance).
      if ((v.x !== px || v.z !== pz || v.yaw !== pyaw) && this.obstacles.length && this.blocked(v)) {
        v.x = px; v.z = pz; v.yaw = pyaw; v.vx = 0; v.vz = 0; v.speed = 0; v.dashT = 0;
      }
      this.clock += h * 1000;
      this.record();
    }
    return this.pose();
  }

  record() {
    const v = this.v, trail = this.trail;
    trail.push({ t: this.clock, x: v.x, y: v.y, z: v.z, vx: finite(v.vx), vz: finite(v.vz), dashing: v.dashT > 0 });
    const horizon = this.clock - this.rules.historyMs;
    while (trail.length > this.rules.historySamples || (trail.length > 1 && trail[0].t < horizon)) trail.shift();
  }

  /**
   * Blend out part of a pending correction (also shifting the trail): linear
   * over what is left of blendMs, and at least the exponential share with a
   * time constant of blendMs / 3, so rows that replace the correction every
   * frame still close ~95 % of it within blendMs.
   */
  applyCorrection(dt) {
    const k = this.correction;
    if (!k || !this.v) return;
    const ms = dt * 1000;
    const share = k.remaining <= ms ? 1 : Math.max(ms / k.remaining, 1 - Math.exp(-3 * ms / this.rules.blendMs));
    const dx = k.dx * share, dy = k.dy * share, dz = k.dz * share;
    this.v.x += dx; this.v.y += dy; this.v.z += dz;
    for (const s of this.trail) { s.x += dx; s.y += dy; s.z += dz; }
    k.dx -= dx; k.dy -= dy; k.dz -= dz;
    k.remaining -= dt * 1000;
    if (share >= 1) this.correction = null;
  }

  /**
   * Compare an authoritative row with the predicted trail around `rttMs` ago
   * (the netclient's measured round trip). Returns the error (metres) to the
   * matched trail sample and starts a blend or a snap. `rowDt` (server seconds
   * since the previous row) enables the velocity reconcile.
   */
  reconcile(row, rttMs = this.rttMs, rowDt = NaN) {
    const v = this.v;
    if (!v || !row || row.id !== v.id || ![row.x, row.y, row.z].every(Number.isFinite)) return 0;
    const prev = this.lastRow;
    this.lastRow = { x: row.x, z: row.z };
    let best = null, bestD = Infinity;
    const pending = this.correction;
    // Compare against where the trail will be once the pending correction is done.
    const ox = pending ? pending.dx : 0, oy = pending ? pending.dy : 0, oz = pending ? pending.dz : 0;
    const rtt = Number.isFinite(rttMs) && rttMs > 0 ? rttMs : this.rules.defaultRttMs ?? 100;
    const early = rtt - (this.rules.matchEarlyMs ?? 35), late = rtt + (this.rules.matchLateMs ?? 100);
    let nearest = null, nearestGap = Infinity;
    for (const s of this.trail) {
      const age = this.clock - s.t;
      if (age < early || age > late) {
        // Outside the window: only a fallback (a trail shorter than the round trip).
        const gap = age < early ? early - age : age - late;
        if (gap < nearestGap) { nearestGap = gap; nearest = s; }
        continue;
      }
      const d = Math.hypot(row.x - s.x - ox, row.y - s.y - oy, row.z - s.z - oz);
      if (d < bestD) { bestD = d; best = s; }
    }
    if (!best && nearest) { best = nearest; bestD = Math.hypot(row.x - best.x - ox, row.y - best.y - oy, row.z - best.z - oz); }
    if (!best) { bestD = Math.hypot(row.x - v.x, row.y - v.y, row.z - v.z); best = v; }
    this.lastError = bestD;
    const titan = decodeTitanRow(row);
    if (titan) {
      v.tfMove.hoverVy = titan.hover ? 0 : null;
      // Mirror titan-abilities.js syncMove: hover at the row's speedMul, Arc Wave slow, tether root.
      v.tfMove.speedMul = (titan.hover ? TITAN_ABILITIES[v.type]?.tactical?.speedMul ?? 0.5 : 1) * (titan.slowed ? TITAN_ABILITIES.titan_ronin.tactical.speedMul : 1);
      v.tfMove.rooted = titan.rooted;
      if (Math.abs(titan.dash - v.dash) > 0.6 && this.clock - this.dashAt > this.rules.dashAdoptMs) v.dash = titan.dash;
    }
    // The server moves at another velocity than we did then (a slide or dash it never ran, a stop).
    if (prev && best !== v && rowDt > 0 && rowDt <= 0.25 && bestD > (this.rules.velErrorAt ?? Infinity)) {
      const svx = (row.x - prev.x) / rowDt, svz = (row.z - prev.z) / rowDt;
      const dvx = svx - best.vx, dvz = svz - best.vz;
      if (Math.hypot(dvx, dvz) > this.rules.velError) {
        const f = titanFrame(v.type);
        if (v.dashT > 0 && best.dashing && Math.hypot(svx, svz) < 0.5 * f.dash.speed) v.dashT = 0;
        if (!(v.dashT > 0)) { v.vx = finite(v.vx) + dvx; v.vz = finite(v.vz) + dvz; }
      }
    }
    if (bestD > this.rules.snapError) {
      // Jump by the matched error (the pose moves on from where the server had us).
      const dx = row.x - best.x - ox, dy = row.y - best.y - oy, dz = row.z - best.z - oz;
      v.x += dx + ox; v.y += dy + oy; v.z += dz + oz; v.vx = 0; v.vy = 0; v.vz = 0; v.dashT = 0;
      if (best !== v) for (const s of this.trail) { s.x += dx + ox; s.y += dy + oy; s.z += dz + oz; }
      this.correction = null; this.snaps++;
      return bestD;
    }
    // Both at rest: a residual under blendError is settled too (no input lag can explain it).
    const resting = !(finite(v.speed) > this.rules.restSpeed) && !(finite(row.speed) > this.rules.restSpeed) && !pending;
    // The new blend replaces the pending one: it moves the trail sample all the way onto the row.
    if (bestD > (resting ? this.rules.restError : this.rules.blendError)) {
      this.correction = { dx: row.x - best.x, dy: row.y - best.y, dz: row.z - best.z, remaining: this.rules.blendMs };
    }
    return bestD;
  }
}

// ---- module glue ------------------------------------------------------------------

let app = null, client = null, predictor = null, world = null, worldKey = null, controlsSource = null, lastRow = null, lastSendAt;

/** Install an exact controls source `() => ({ fwd, side, aimYaw, aimPitch, sprint })` (WP6), or null. */
export function setControlsSource(fn) { controlsSource = typeof fn === 'function' ? fn : null; }
/**
 * The local pilot sent `ability:'dash'`: predict the dash on the next substep,
 * along `controls` ({ fwd, side, aimYaw }: the movement input the server holds
 * when the intent lands; WP6 sends it right before the intent). Returns false
 * where the server would refuse it.
 */
export function noteDash(controls = null) { return predictor?.noteDash(controls) ?? false; }
/** The active predictor (tests and HUD diagnostics), or null. */
export function activePredictor() { return predictor?.active ? predictor : null; }

export function init(nextApp, nextClient) { app = nextApp ?? null; client = nextClient ?? null; }

function walkerWorld() {
  const mapId = app?.mapMeta?.id ?? null;
  if (world && worldKey === mapId) return world;
  const dimensions = app?.mapMeta?.dimensions ?? (mapId ? getMapDimensions(mapId) : null);
  world = createWalkerWorld({ getBlock, dimensions, mapId });
  worldKey = mapId;
  return world;
}

/** The own titan's row while the local player drives it, else null. */
function ownRow(snapshot) {
  const controller = app?.vehicleController;
  const id = controller?.active ? controller.vehicle?.id : null;
  if (!id || controller.seatId !== 'driver') return null;
  const row = Array.isArray(snapshot?.vehicles) ? snapshot.vehicles.find(item => item?.id === id) : null;
  if (!row || !isTitanType(row.type) || !(row.hp > 0)) return null;
  if (row.own != null && app?.myId != null && String(row.own) !== String(app.myId)) return null;
  return row;
}

function stop() {
  if (predictor?.v && app?.vehicleView) app.vehicleView.setPredictedPose(predictor.v.id, null);
  predictor?.adopt(null);
}

export function tick(snapshot, dt = 0) {
  const row = ownRow(snapshot);
  lastRow = row;
  const phase = decodeTitanRow(row)?.phase;
  if (!row || !WALKING_PHASES.has(phase)) { stop(); return; }
  predictor ??= new TitanPredictor(walkerWorld());
  predictor.world = walkerWorld();
  const rtt = Number(app?.net?.ping);
  predictor.rttMs = Number.isFinite(rtt) && rtt > 0 ? rtt : PREDICT_RULES.defaultRttMs;
  const adopted = !predictor.active || predictor.v.id !== row.id ? predictor.adopt(row) : false;
  predictor.setObstacles(snapshot.vehicles, row.id);
  if (!adopted) predictor.reconcile(row, predictor.rttMs, dt);
}

function localControls() {
  if (controlsSource) return controlsSource() ?? {};
  const enabled = app?.session?.gameplayInputEnabled !== false;
  const keys = enabled && typeof app?.input?.getKeys === 'function' ? app.input.getKeys() || {} : {};
  const on = (a, b) => !!(keys[a] ?? keys[b]);
  const hold = typeof client?.titanHold === 'function' ? client.titanHold() : 0;
  return {
    fwd: Number(on('forward', 'f')) - Number(on('back', 'b')),
    side: Number(on('right', 'r')) - Number(on('left', 'l')),
    aimYaw: app?.player?.view?.yaw ?? app?.vehicleController?.yaw,
    aimPitch: app?.player?.view?.pitch ?? 0,
    // The seated send carries `keys: {}`: the server sprints on titanHold bit 1 only.
    sprint: (hold & 1) !== 0,
  };
}

export function frame(dt) {
  if (!predictor?.active || !lastRow) return;
  const controls = localControls();
  // main.js sends the seated input before frame(): a new send time means these controls went out.
  const sendAt = app?._vehicleSendAt;
  if (sendAt !== lastSendAt) { lastSendAt = sendAt; predictor.noteSent(controls); }
  const pose = predictor.step(dt, controls);
  if (pose) app?.vehicleView?.setPredictedPose?.(predictor.v.id, pose);
}

export function onEvent(event) {
  // A teleport-like event for the own titan (eject, destruction) ends prediction at once.
  if (!predictor?.active || !event) return;
  if ((event.kind === 'vehicle_destroyed' || event.kind === 'titan_eject') && event.vehicleId === predictor.v.id) stop();
}

export function dispose() {
  stop();
  app = client = predictor = world = worldKey = controlsSource = lastRow = null;
  lastSendAt = undefined;
}
