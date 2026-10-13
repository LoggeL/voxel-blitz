// Titanfall pilot wallrun measurements (docs/titanfall.md §4.1, WP1). Headless and
// audio-free: drives the authoritative integrator (server/sim/movement.js
// stepMovement with the shared pilot hooks) at 60 Hz over synthetic voxel walls
// and the real Ashfall facades, and prints what a wallrun does:
//
//   entry      which approach angles and speeds attach (airborne and from a
//              ground jump), with and without a held movement key
//   profile    speed, height and time on the wall of one sprint-jump run
//   irregular  1-3 voxel gaps, a window hole, a facade of windows, a pillar,
//              1-voxel steps and slight angles, inner and outer corners
//   chain      wall-to-wall chains across 4-14 m streets: jump-off angle and
//              speed, catches, whether the double jump comes back
//   false +    stairs, ledges and low walls that must never wallrun
//   camera     roll, FOV and eye of PilotCamera over a chain and irregular walls
//   ashfall    Hab alley, the cross street and the smelter / annex facades
//
//   node tools/titanfall-wallrun-measure.mjs [--json out.json]
//
// The pilot movement test (tools/titanfall-pilot-movement-test.mjs) imports the
// scenario runners to pin the behaviour; this file only measures.
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { PILOT_RULES, createPilotState } from '../shared/pilot-movement.js';
import { PlayerEntity } from '../server/sim/player.js';
import { stepMovement } from '../server/sim/movement.js';
import { PilotCamera } from '../public/js/titanfall/pilot-camera.js';
import { PlayerPhysics } from '../public/js/player-physics.js';

const DT = 1 / 60;
const G = 10;                 // synthetic floor: y < 10 is solid, feet stand at 10
const HALF = 0.32;
const DEG = Math.PI / 180;
const yawToward = (dx, dz) => Math.atan2(-dx, -dz);   // forward = (-sin yaw, -cos yaw)

/** A pilot body on the authoritative integrator. */
export function pilotBody(solid, at, { vx = 0, vy = 0, vz = 0, grounded = true, groundY = null } = {}) {
  const p = new PlayerEntity('pilot', 'Pilot', { ...at }, false);
  Object.assign(p, { grounded, deployT: 0, vx, vy, vz, coyote: 0 });
  p.pilot = createPilotState();
  p.pilot.lastGroundY = groundY ?? (grounded ? at.y : G);
  p.jumpGroundY = p.pilot.lastGroundY;
  p.input = { yaw: 0, pitch: 0, viewYaw: 0, keys: {} };
  const ctx = { solidAt: solid, fluidAt: null, mapMeta: null, now: 0, pilotRules: true, onFall: () => {} };
  return {
    p,
    step(keys = {}) {
      const { forward = false, back = false, left = false, right = false, jump = false, crouch = false, sprint = false, yaw = 0 } = keys;
      Object.assign(p.input.keys, { f: forward, b: back, l: left, r: right, jump, crouch, sprint, prone: false });
      p.input.yaw = yaw;
      p.input.viewYaw = yaw;
      if (p.coyote > 0) p.coyote -= DT;   // updateTimers runs before integrate in GameEngine.step
      ctx.now += DT * 1000;
      stepMovement(p, DT, ctx);
    },
  };
}

const hspeed = p => Math.hypot(p.vx, p.vz);

/* ------------------------------------------------------------------ worlds */

/** The base lane: a wall plane at x = 30 (z 0..199, up to y 40); the runner is on its -X side running +z. */
export function wallWorld(feature = 'plain', at = 36) {
  return (x, y, z) => {
    if (y < G) return true;
    if (z < 0 || z >= 200 || y >= 40) return false;
    switch (feature) {
      case 'gap1': if (z === at && x === 30) return false; break;
      case 'gap2': if (z >= at && z < at + 2 && x === 30) return false; break;
      case 'gap3': if (z >= at && z < at + 3 && x === 30) return false; break;
      case 'window': if (z >= at && z < at + 2 && y >= G + 2 && y < G + 4 && x === 30) return false; break;
      case 'facade': if (z >= at - 8 && ((z - at) % 4 + 4) % 4 < 2 && y >= G + 2 && y < G + 4 && x === 30) return false; break;
      case 'pillar': if (z === at && x === 29) return true; break;
      case 'recess': if (z >= at) return x === 31; break;
      case 'stepout': if (z >= at) return x === 29; break;
      case 'angle-away': if (z >= at) return x === 30 + Math.floor((z - at) / 6) + 1; break;
      case 'angle-toward': if (z >= at) return x === 30 - Math.floor((z - at) / 6) - 1; break;
      // Voxel staircases toward the runner: 1 voxel per 2 m (27°) and per 1 m (45°).
      case 'slant2': if (z >= at) return x === 30 - Math.floor((z - at) / 2) - 1; break;
      case 'slant1': if (z >= at) return x === 30 - (z - at) - 1; break;
      case 'outer': if (z >= at) return false; break;
      case 'inner': if (z >= at && z < at + 2 && x >= 20 && x <= 30) return true; if (z >= at) return false; break;
      default: break;
    }
    return x === 30;
  };
}

/** Two parallel walls `width` voxels apart: A at x = 30 (runner on its -X side), B at x = 29 - width. */
export function streetWorld(width) {
  const b = 29 - width;
  return (x, y, z) => y < G || ((x === 30 || x === b) && z >= 0 && z < 400 && y < 60);
}

/** Stairs and ledges along a side wall (the pilot movement test's stair lanes plus ledges and a low wall). */
export function falsePositiveWorld(x, y, z) {
  if (y < G) return true;
  if (z >= 70 && z < 74 && x >= 10 && x < 30) return y < G + 1 + (x - 10);           // 1 m steps up +x
  if (z === 74 && x >= 0 && x < 40 && y < 40) return true;
  if (z >= 80 && z < 84 && x >= 10 && x < 30) return y < G + 1 + Math.floor((x - 10) / 2);   // 2 m steps
  if (z === 84 && x >= 0 && x < 40 && y < 40) return true;
  if (z >= 90 && z < 94 && x >= 10 && x < 40 && x % 3 === 0) return y < G + 1;      // 1-voxel crates every 3 m
  if (z >= 90 && z < 94 && x >= 10 && x < 40 && x % 5 === 1) return y < G + 2;      // 2-voxel crates
  if (z === 94 && x >= 0 && x < 50 && y < 40) return true;
  if (z === 104 && x >= 0 && x < 50 && y < G + 2) return true;                      // a 2 m low wall
  if (z >= 110 && z < 114 && x >= 10 && x < 30) return y < G + 1 + (29 - x);        // stairs down +x
  if (z === 114 && x >= 0 && x < 40 && y < 40) return true;
  return false;
}

/* ------------------------------------------------------------------ helpers */

/** Run until `until(p, i)` or `ticks`; `keys(p, i)` decides the input. Returns the trace of the authoritative body. */
function drive(body, keys, ticks, until = null) {
  const trace = [];
  for (let i = 0; i < ticks; i++) {
    body.step(keys(body.p, i));
    const p = body.p, s = p.pilot;
    trace.push({ i, x: p.x, y: p.y, z: p.z, vx: p.vx, vy: p.vy, vz: p.vz, grounded: p.grounded, wall: s.wall, wallT: s.wallT,
      jumpsLeft: s.jumpsLeft, chain: s.chain, jumped: s.jumped, vault: !!p.vault, shiftX: s.shiftX ?? 0, shiftZ: s.shiftZ ?? 0 });
    if (until?.(p, i)) break;
  }
  return trace;
}

/** Wall segments of a trace: [{ from, to, wall, seconds, z0, z1, y0, y1, yMax, yMin, vMax, v0, v1 }]. */
function wallSegments(trace) {
  const out = [];
  let cur = null;
  for (const t of trace) {
    if (t.wall && (!cur || cur.wall !== t.wall)) {
      if (cur) out.push(cur);
      cur = { from: t.i, to: t.i, wall: t.wall, z0: t.z, z1: t.z, x0: t.x, y0: t.y, y1: t.y, yMax: t.y, yMin: t.y,
        v0: Math.hypot(t.vx, t.vz), v1: 0, vMax: 0, endWallT: 0 };
    }
    if (t.wall && cur) {
      cur.to = t.i; cur.z1 = t.z; cur.y1 = t.y; cur.yMax = Math.max(cur.yMax, t.y); cur.yMin = Math.min(cur.yMin, t.y);
      const v = Math.hypot(t.vx, t.vz);
      cur.vMax = Math.max(cur.vMax, v); cur.v1 = v; cur.endWallT = t.wallT;
    }
    if (!t.wall && cur) { out.push(cur); cur = null; }
  }
  if (cur) out.push(cur);
  for (const s of out) s.seconds = (s.to - s.from + 1) * DT;
  return out;
}

const r2 = v => Math.round(v * 100) / 100;

/* ------------------------------------------------------------------ entry */

/** Airborne approach: `gap` m from the wall face, speed `speed` at `angle` (deg) toward it, vy `vy`. */
export function airborneEntry({ speed, angle, vy = 0, key = true, gap = 0.3, solid = wallWorld() }) {
  const a = angle * DEG;
  const body = pilotBody(solid, { x: 30 - HALF - gap, y: G + 3, z: 10.5 },
    { vx: speed * Math.sin(a), vz: speed * Math.cos(a), vy, grounded: false, groundY: G });
  const yaw = yawToward(Math.sin(a), Math.cos(a));
  const trace = drive(body, () => ({ forward: key, sprint: key, yaw }), 90, p => p.pilot.wall !== 0 || p.grounded);
  const last = trace.at(-1);
  return { attached: !!last.wall, ticks: trace.length, speed: r2(Math.hypot(last.vx, last.vz)), vy: r2(last.vy) };
}

/** Ground approach: sprinting at `angle` (deg) toward the wall, `gap` m out, jump on the first tick. */
export function groundEntry({ angle, gap, speed = PILOT_RULES.sprint, key = true, solid = wallWorld() }) {
  const a = angle * DEG;
  const body = pilotBody(solid, { x: 30 - HALF - gap, y: G, z: 10.5 }, { vx: speed * Math.sin(a), vz: speed * Math.cos(a) });
  const yaw = yawToward(Math.sin(a), Math.cos(a));
  const trace = drive(body, (p, i) => ({ forward: key || i === 0, sprint: true, jump: i === 0, yaw }), 90,
    (p, i) => p.pilot.wall !== 0 || (i > 2 && p.grounded));
  const last = trace.at(-1);
  return { attached: !!last.wall, t: r2(trace.length * DT), height: r2(last.y - G) };
}

function entryReport() {
  const angles = [5, 10, 15, 20, 30, 45, 60, 70, 80];
  const speeds = [5, 6.5, 8.5, 11, 14];
  const air = {};
  for (const key of [true, false]) for (const vy of [3, 0, -6]) {
    const rows = {};
    for (const s of speeds) rows[s] = angles.map(a => (airborneEntry({ speed: s, angle: a, vy, key }).attached ? 1 : 0));
    air[`${key ? 'key' : 'nokey'} vy${vy}`] = rows;
  }
  const ground = {};
  for (const gap of [0.05, 0.5, 1, 2]) ground[gap] = angles.map(a => groundEntry({ angle: a, gap }));
  return { angles, speeds, air, ground };
}

/* ------------------------------------------------------------------ profile */

/** One sprint-jump run: sprint at 15 degrees toward the wall from 0.5 m out, jump, hold forward along the wall. */
export function runProfile({ angle = 15, gap = 0.5, solid = wallWorld(), key = true } = {}) {
  const a = angle * DEG;
  const body = pilotBody(solid, { x: 30 - HALF - gap, y: G, z: 4.5 }, { vx: PILOT_RULES.sprint * Math.sin(a), vz: PILOT_RULES.sprint * Math.cos(a) });
  const yaw = yawToward(Math.sin(a), Math.cos(a)), along = Math.PI;
  const trace = drive(body, (p, i) => ({ forward: key || i === 0, sprint: true, jump: i === 0, yaw: p.pilot.wall ? along : yaw }), 240,
    (p, i) => i > 5 && p.grounded);
  const seg = wallSegments(trace)[0];
  if (!seg) return { attached: false };
  const samples = [];
  for (let k = seg.from; k <= seg.to; k += 6) {
    const t = trace[k];
    samples.push({ t: r2((k - seg.from) * DT), v: r2(Math.hypot(t.vx, t.vz)), h: r2(t.y - seg.y0), vy: r2(t.vy) });
  }
  const after = trace[seg.to + 1];
  const reason = !after ? 'trace end' : after.grounded ? 'ground' : seg.endWallT >= PILOT_RULES.wallrun.seconds - DT * 1.5 ? 'time' : 'contact/speed';
  return {
    attached: true, entryHeight: r2(seg.y0 - G), entryDelay: r2(seg.from * DT), seconds: r2(seg.seconds),
    distance: r2(seg.z1 - seg.z0), v0: r2(seg.v0), vMax: r2(seg.vMax), v1: r2(seg.v1),
    rise: r2(seg.yMax - seg.y0), endDrop: r2(seg.y1 - seg.y0), reason, samples,
  };
}

/* ------------------------------------------------------------------ irregular walls */

/** Start attached-ready next to the wall at z 30 (9.5 m/s along +z, 2.5 m up) with the feature at z 36. */
export function irregularRun(feature, { speed = 9.5, y = G + 2.5 } = {}) {
  const solid = wallWorld(feature, 36);
  const body = pilotBody(solid, { x: 30 - HALF - 0.05, y, z: 30.5 }, { vz: speed, grounded: false, groundY: G });
  const trace = drive(body, () => ({ forward: true, sprint: true, yaw: Math.PI }), 200, (p, i) => i > 3 && p.grounded);
  const segs = wallSegments(trace);
  const first = segs[0];
  const total = segs.reduce((sum, s) => sum + s.seconds, 0);
  return {
    attached: !!first, segments: segs.length, seconds: r2(first?.seconds ?? 0), total: r2(total),
    passed: !!first && first.z1 > 38.5, detachZ: r2(first?.z1 ?? 0), vEnd: r2(first?.v1 ?? 0),
  };
}

function irregularReport() {
  const out = {};
  for (const f of ['plain', 'gap1', 'gap2', 'gap3', 'window', 'facade', 'pillar', 'recess', 'stepout', 'angle-away', 'angle-toward', 'slant2', 'slant1',
    'outer', 'inner']) {
    out[f] = irregularRun(f);
  }
  return out;
}

/* ------------------------------------------------------------------ chains */

/**
 * Wall-to-wall chain across a street `width` m wide. After `runT` s on a wall the
 * pilot looks across at `aim` degrees off the wall and jumps; in the air it holds
 * forward at that heading and spends the double jump (`double`) once falling faster than `djVy`.
 */
export function chainRun({ width, aim = 45, runT = 0.2, double = true, djVy = 0, solid = null, start = null, startWall = -1, ticks = 900,
  groundY = null }) {
  const world = solid ?? streetWorld(width);
  const at = start ?? { x: 30 - HALF - 0.5, y: G, z: 2.5 };
  // groundY: start airborne at `at` (a drop into the street from above), running along +z.
  const body = groundY === null
    ? pilotBody(world, at, { vx: Math.sin(15 * DEG) * -startWall * PILOT_RULES.sprint, vz: PILOT_RULES.sprint * Math.cos(15 * DEG) })
    : pilotBody(world, at, { vx: -startWall * 1.5, vz: PILOT_RULES.sprint, grounded: false, groundY });
  let heading = yawToward(Math.sin(15 * DEG) * -startWall, Math.cos(15 * DEG)), held = false, doubled = false;
  const hops = [], catches = [];
  let lastWall = 0, wallSince = -1;
  const trace = drive(body, (p, i) => {
    const s = p.pilot;
    if (s.wall !== lastWall) {
      if (s.wall) {
        wallSince = i;
        doubled = false;
        catches.push({ i, wall: s.wall, speed: r2(s.wallSpeed), height: r2(p.y - G), jumpsLeft: s.jumpsLeft, x: r2(p.x), z: r2(p.z) });
      }
      lastWall = s.wall;
    }
    let jump = i === 0;
    if (s.wall && (i - wallSince) * DT >= runT) {
      // Look across: the other wall lies along the outward normal (code ±1 = ±X).
      const n = s.wall > 0 ? 1 : -1, a = aim * DEG;
      heading = yawToward(n * Math.sin(a), Math.cos(a));
      jump = !held;
    } else if (!s.wall && !p.grounded && double && !doubled && p.vy < djVy && s.jumpsLeft > 0 && i > 2) {
      jump = !held;
      if (jump) doubled = true;
    }
    held = jump;
    return { forward: true, sprint: true, jump, yaw: heading };
  }, ticks, (p, i) => i > 5 && p.grounded);
  for (let k = 1; k < trace.length; k++) {
    const t = trace[k];
    if (t.jumped === 2) hops.push({ i: t.i, speed: r2(Math.hypot(t.vx, t.vz)), out: r2(Math.atan2(Math.abs(t.vx), Math.abs(t.vz)) / DEG), vy: r2(t.vy), jumpsLeft: t.jumpsLeft });
  }
  const air = trace.length * DT;
  return { width, aim, walls: catches.length, hops, catches, air: r2(air), topSpeed: r2(Math.max(...trace.map(t => Math.hypot(t.vx, t.vz)))),
    peak: r2(Math.max(...trace.map(t => t.y)) - at.y), trace };
}

function chainReport() {
  const out = {};
  for (const width of [4, 6, 8, 10, 12, 14]) {
    let best = null;
    for (const aim of [30, 45, 60, 65]) for (const runT of [0.1, 0.25, 0.5]) for (const djVy of [null, 0, -3, -6]) {
      const r = chainRun({ width, aim, runT, double: djVy !== null, djVy: djVy ?? 0 });
      const score = r.walls * 100 + r.topSpeed;
      if (!best || score > best.score) best = { score, aim, runT, djVy, walls: r.walls, topSpeed: r.topSpeed, peak: r.peak, air: r.air,
        hop: r.hops[0] ?? null, catches: r.catches.slice(0, 6).map(c => `${c.speed}@${c.height}m dj${c.jumpsLeft}`) };
    }
    const plain = chainRun({ width, aim: 45, runT: 0.25, double: true });
    out[width] = { best, at45: { walls: plain.walls, topSpeed: plain.topSpeed, hops: plain.hops.slice(0, 4), catches: plain.catches.slice(0, 5).map(c => c.speed) } };
  }
  return out;
}

/* ------------------------------------------------------------------ false positives */

export function falsePositiveRuns() {
  const out = {};
  const run = (label, at, dir, extra = {}) => {
    let walled = 0, top = 0, entries = 0, entryHeight = null;
    for (const deg of [5, 15, 25]) {
      const a = deg * DEG, d = { x: dir.x * Math.cos(a) + dir.sx * Math.sin(a), z: dir.z * Math.cos(a) + dir.sz * Math.sin(a) };
      const body = pilotBody(falsePositiveWorld, at);
      const yaw = yawToward(d.x, d.z);
      for (let i = 0; i < 300; i++) {
        const was = body.p.pilot.wall;
        body.step({ forward: true, sprint: true, jump: extra.hold ? true : i % 20 < 2, yaw });
        if (body.p.pilot.wall) walled++;
        if (body.p.pilot.wall && !was) { entries++; entryHeight = Math.min(entryHeight ?? Infinity, r2(body.p.y - G)); }
        top = Math.max(top, body.p.y - G);
      }
    }
    out[label] = { wallTicks: walled, climbed: r2(top), entries, entryHeight };
  };
  // Up the stairs (+x), angled at the side wall (+z).
  run('stairs 1 m (held jump)', { x: 8.5, y: G, z: 72.5 }, { x: 1, z: 0, sx: 0, sz: 1 }, { hold: true });
  run('stairs 1 m (taps)', { x: 8.5, y: G, z: 72.5 }, { x: 1, z: 0, sx: 0, sz: 1 });
  run('stairs 2 m (held jump)', { x: 8.5, y: G, z: 82.5 }, { x: 1, z: 0, sx: 0, sz: 1 }, { hold: true });
  run('crates along a wall', { x: 8.5, y: G, z: 92.5 }, { x: 1, z: 0, sx: 0, sz: 1 }, { hold: true });
  run('2 m low wall', { x: 2.5, y: G, z: 102.5 }, { x: 1, z: 0, sx: 0, sz: 1 }, { hold: true });
  run('stairs down', { x: 8.5, y: G + 20, z: 112.5 }, { x: 1, z: 0, sx: 0, sz: 1 }, { hold: true });
  return out;
}

/* ------------------------------------------------------------------ mantle */

/**
 * Mantle checks: (a) airborne at 8 m/s into a ledge whose top is `rise` m above the feet
 * (a roof edge after a wall-jump, far above the takeoff), forward held; (b) a wallrun along a
 * 3-voxel wall (top 3 m above the floor) that steers into it after 0.3 s.
 */
export function mantleRun({ rise = 1.2, from = 'air' } = {}) {
  if (from === 'air') {
    const top = G + 6;
    const solid = (x, y, z) => y < G || (x >= 40 && x < 50 && y < top);
    const body = pilotBody(solid, { x: 37.5, y: top - rise, z: 10.5 }, { vx: 8, vy: 0, grounded: false, groundY: G });
    const trace = drive(body, () => ({ forward: true, sprint: true, yaw: -Math.PI / 2 }), 120, (p, i) => i > 3 && p.grounded);
    const last = trace.at(-1), vaulted = trace.some(t => t.vault);
    return { mantled: vaulted && last.y >= top - 0.01, onTop: last.y >= top - 0.01, seconds: r2(trace.length * DT) };
  }
  const solid = (x, y, z) => y < G || (x === 30 && z >= 0 && z < 60 && y < G + 3);
  const body = pilotBody(solid, { x: 30 - HALF - 0.4, y: G, z: 4.5 }, { vx: PILOT_RULES.sprint * Math.sin(12 * DEG), vz: PILOT_RULES.sprint * Math.cos(12 * DEG) });
  let walled = false;
  const trace = drive(body, (p, i) => {
    if (p.pilot.wall) walled = true;
    const into = walled && p.pilot.wallT > 0.3 ? 40 * DEG : 12 * DEG;
    return { forward: true, sprint: true, jump: i === 0, yaw: yawToward(Math.sin(into), Math.cos(into)) };
  }, 180, (p, i) => i > 5 && p.grounded);
  const last = trace.at(-1);
  return { walled, mantled: trace.some(t => t.vault), onTop: last.y >= G + 3 - 0.01, seconds: r2(trace.length * DT) };
}

/* ------------------------------------------------------------------ camera */

/**
 * PilotCamera over a trace, frames at `hz` (the sim steps at 60 Hz; frames present the
 * state between steps as LocalPlayer does with pilotLerp). Reports the roll (deg), its
 * rate and acceleration, overshoot past the target, rate reversals while the target holds
 * (jitter), the FOV, and the eye's sideways speed (a step-around pops the body a voxel).
 */
export function cameraFromTrace(trace, { hz = 144, catchTick = null } = {}) {
  const cam = new PilotCamera();
  const physics = { pilot: { wall: 0, slideT: 0, grapple: null, chain: 0, jumpsLeft: 1, shiftX: 0, shiftZ: 0 },
    vel: { x: 0, y: 0, z: 0 }, pos: { x: 0, y: 0, z: 0 } };
  const player = { physics, view: { yaw: 0 }, alive: true, adsT: 0, deathCamMotion: 1 };
  const rolls = [], fovs = [], eyes = [];
  const frames = Math.floor(trace.length * DT * hz);
  let heading = Math.PI;
  for (let f = 0; f < frames; f++) {
    const t = f / hz, k = Math.min(trace.length - 1, Math.floor(t / DT)), s = trace[k], prev = trace[Math.max(0, k - 1)];
    const behind = 1 - (t - k * DT) / DT;
    Object.assign(physics.pilot, { wall: s.wall, chain: s.chain, jumpsLeft: s.jumpsLeft, shiftX: s.shiftX ?? 0, shiftZ: s.shiftZ ?? 0 });
    Object.assign(physics.vel, { x: s.vx, y: s.vy, z: s.vz });
    if (Math.hypot(s.vx, s.vz) > 1) heading = yawToward(s.vx, s.vz);
    player.view.yaw = heading;
    const view = cam.update(1 / hz, player);
    rolls.push(view.roll / DEG);
    fovs.push(view.fov);
    // Presented eye: the step's position minus the unstepped share of its delta, plus the camera offset.
    // A step-around's shift is left out of the presented step (PlayerPhysics.stepPilotFixed).
    eyes.push({ x: s.x - (s.x - prev.x - (s.shiftX - prev.shiftX)) * behind + view.ox,
      z: s.z - (s.z - prev.z - (s.shiftZ - prev.shiftZ)) * behind + view.oz });
  }
  let rate = 0, accel = 0, reversals = 0, prevRate = 0, overshoot = 0, eyeSide = 0;
  for (let i = 1; i < rolls.length; i++) {
    const r = (rolls[i] - rolls[i - 1]) * hz;
    if (i > 1) accel = Math.max(accel, Math.abs(r - prevRate) * hz);
    if (i > 1 && Math.sign(r) !== Math.sign(prevRate) && Math.abs(r) > 2 && Math.abs(prevRate) > 2) reversals++;
    rate = Math.max(rate, Math.abs(r));
    prevRate = r;
  }
  // Roll beyond its resting value on each wall: the largest |roll| above the settled one.
  for (const seg of wallSegments(trace)) {
    const a = Math.floor(seg.from * DT * hz), b = Math.min(rolls.length - 1, Math.floor(seg.to * DT * hz));
    if (b - a < hz * 0.4) continue;
    const settled = Math.abs(rolls[b]);
    for (let i = a; i <= b; i++) overshoot = Math.max(overshoot, Math.abs(rolls[i]) - settled);
  }
  for (let i = 1; i < eyes.length; i++) {
    const s = trace[Math.min(trace.length - 1, Math.floor(i / hz / DT))];
    const side = Math.abs(s.wall) === 1 ? eyes[i].x - eyes[i - 1].x : Math.abs(s.wall) === 2 ? eyes[i].z - eyes[i - 1].z : 0;
    eyeSide = Math.max(eyeSide, Math.abs(side) * hz);
  }
  let fovRate = 0;
  for (let i = 1; i < fovs.length; i++) fovRate = Math.max(fovRate, Math.abs(fovs[i] - fovs[i - 1]) * hz);
  const first = Math.round((catchTick ?? trace.findIndex(t => t.wall)) * DT * hz);
  return {
    maxRoll: r2(Math.max(...rolls.map(Math.abs))), maxRate: r2(rate), maxAccel: Math.round(accel), overshoot: r2(overshoot), reversals,
    rollAt100ms: r2(Math.abs(rolls[first + Math.round(0.1 * hz)] ?? 0)), rollAt250ms: r2(Math.abs(rolls[first + Math.round(0.25 * hz)] ?? 0)),
    fovMax: r2(Math.max(...fovs)), fovRate: r2(fovRate), eyeSideSpeed: r2(eyeSide),
  };
}

/**
 * The client camera path along an irregular wall (`irregularRun` start): PlayerPhysics.stepPilotFixed
 * on frames of `hz` and PilotCamera on top, composed as LocalPlayer.updateCamera does (pos +
 * pilotLerp + offset). Counts frames whose eye is inside a solid voxel and the least horizontal
 * clearance from the eye to a solid voxel at eye height (the 0.05 m near plane is ~0.075 m wide).
 */
export function cameraEyeRun(feature, { hz = 144 } = {}) {
  const solid = wallWorld(feature, 36);
  const physics = new PlayerPhysics();
  physics.solid = solid;
  physics.pilotRules = true;
  Object.assign(physics.pos, { x: 30 - HALF - 0.05, y: G + 2.5, z: 30.5 });
  Object.assign(physics.vel, { x: 0, y: 0, z: 9.5 });
  physics.grounded = false;
  physics.pilot.lastGroundY = G;
  physics.pilotInput = { sprint: true, crouch: false, ads: false, stim: false };
  const cam = new PilotCamera();
  const player = { physics, view: { yaw: Math.PI }, alive: true, adsT: 0, deathCamMotion: 1 };
  let frames = 0, wallFrames = 0, inside = 0, clearance = Infinity, maxOffset = 0, side = 0, lastX = null;
  for (let f = 0; f < hz * 2.5; f++) {
    physics.stepPilotFixed(1 / hz, { x: 0, z: 1 }, PILOT_RULES.sprint, false, 1, Math.PI);
    const view = cam.update(1 / hz, player);
    const lerp = physics.pilotLerp;
    const ex = physics.pos.x + lerp.x + view.ox, ey = physics.eyeY() + lerp.y + view.oy, ez = physics.pos.z + lerp.z + view.oz;
    frames++;
    if (physics.pilot.wall) wallFrames++;
    maxOffset = Math.max(maxOffset, Math.hypot(view.ox, view.oz));
    if (lastX !== null) side = Math.max(side, Math.abs(ex - lastX));
    lastX = ex;
    const cy = Math.floor(ey);
    for (let cx = Math.floor(ex) - 1; cx <= Math.floor(ex) + 1; cx++) {
      for (let cz = Math.floor(ez) - 1; cz <= Math.floor(ez) + 1; cz++) {
        if (!solid(cx, cy, cz)) continue;
        const d = Math.hypot(Math.max(cx - ex, 0, ex - cx - 1), Math.max(cz - ez, 0, ez - cz - 1));
        if (d === 0) inside++;
        clearance = Math.min(clearance, d);
      }
    }
    if (physics.grounded && f > hz * 0.2) break;
  }
  return { frames, wallSeconds: r2(wallFrames / hz), inside, clearance: Math.round(clearance * 1000) / 1000, maxOffset: r2(maxOffset),
    eyeSideStep: Math.round(side * 1000) / 1000, shift: physics.pilot.shiftX };
}

export function cameraRun({ width = 8, hz = 144 } = {}) {
  const chain = chainRun({ width, aim: 45, runT: 0.3, double: true });
  return { walls: chain.walls, ...cameraFromTrace(chain.trace, { hz }) };
}

/** The camera along an irregular wall run (`irregularRun` geometry). */
export function cameraIrregular(feature, hz = 144) {
  const body = pilotBody(wallWorld(feature, 36), { x: 30 - HALF - 0.05, y: G + 2.5, z: 30.5 }, { vz: 9.5, grounded: false, groundY: G });
  const trace = drive(body, () => ({ forward: true, sprint: true, yaw: Math.PI }), 120, (p, i) => i > 3 && p.grounded);
  return cameraFromTrace(trace, { hz });
}

/* ------------------------------------------------------------------ Ashfall */

export async function ashfallSolid() {
  const { createMapState } = await import('../shared/world/templates.js');
  const { isSolidBlock } = await import('../shared/world/blocks.js');
  const world = createMapState('ashfall');
  return (x, y, z) => isSolidBlock(world.getBlock(x, y, z));
}

/** A sprint-jump run along an Ashfall face: wall plane `plane` on the runner's `side` (+1 = +X), running +z from `z`. */
export function ashfallRun(solid, { plane, side, z, ground = 14, angle = 12, gap = 0.4 }) {
  const a = angle * DEG, x = side > 0 ? plane - HALF - gap : plane + 1 + HALF + gap;
  const body = pilotBody(solid, { x, y: ground + 1, z }, { vx: side * PILOT_RULES.sprint * Math.sin(a), vz: PILOT_RULES.sprint * Math.cos(a) });
  const yaw = yawToward(side * Math.sin(a), Math.cos(a));
  const trace = drive(body, (p, i) => ({ forward: true, sprint: true, jump: i === 0, yaw: p.pilot.wall ? Math.PI : yaw }), 240,
    (p, i) => i > 5 && p.grounded);
  const segs = wallSegments(trace);
  const first = segs[0];
  return { attached: !!first, seconds: r2(first?.seconds ?? 0), distance: r2(first ? first.z1 - first.z0 : 0), segments: segs.length,
    total: r2(segs.reduce((sum, s) => sum + s.seconds, 0)), vMax: r2(first?.vMax ?? 0) };
}

async function ashfallReport() {
  const solid = await ashfallSolid();
  const T = 14;
  return {
    'Hab alley, annex face (x 60)': ashfallRun(solid, { plane: 60, side: 1, z: 38.5, ground: T }),
    'Hab alley, tower face (x 55)': ashfallRun(solid, { plane: 55, side: -1, z: 38.5, ground: T }),
    'annex east facade, windows (x 68)': ashfallRun(solid, { plane: 68, side: -1, z: 36.5, ground: T }),
    'smelter west face, door (x 83)': ashfallRun(solid, { plane: 83, side: 1, z: 36.5, ground: T }),
    'Hab alley chain (4 m)': bestChain({ width: 4, solid, start: { x: 60 - HALF - 0.4, y: T + 1, z: 38.5 } }),
    'cross street chain (14 m)': bestChain({ width: 14, solid, start: { x: 83 - HALF - 0.4, y: T + 1, z: 37.5 } }),
    'cross street chain, dropped in 6 m up': bestChain({ width: 14, solid, start: { x: 83 - HALF - 0.2, y: T + 7, z: 37.5 }, groundY: T + 13 }),
  };
}

/** The best chain over the policy grid of chainReport (most walls, then top speed). */
function bestChain(options) {
  let best = null;
  for (const aim of [30, 45, 60, 65]) for (const runT of [0.1, 0.25, 0.5]) for (const djVy of [null, 0, -3, -6]) {
    const r = chainRun({ ...options, aim, runT, double: djVy !== null, djVy: djVy ?? 0 });
    if (!best || r.walls * 100 + r.topSpeed > best.walls * 100 + best.topSpeed) best = { ...r, aim, runT, djVy };
  }
  return { walls: best.walls, aim: best.aim, runT: best.runT, djVy: best.djVy, topSpeed: best.topSpeed, peak: best.peak, air: best.air,
    catches: best.catches.map(c => `${c.speed}@${r2(c.height - (options.start.y - G))}m`) };
}

/* ------------------------------------------------------------------ report */

export async function measureWallrun() {
  return {
    rules: { wallrun: PILOT_RULES.wallrun, wallJump: PILOT_RULES.wallJump },
    entry: entryReport(),
    profile: runProfile(),
    profileNoKey: runProfile({ key: false }),
    irregular: irregularReport(),
    chain: chainReport(),
    falsePositives: falsePositiveRuns(),
    mantle: { air08: mantleRun({ rise: 0.8 }), air12: mantleRun({ rise: 1.2 }), air18: mantleRun({ rise: 1.8 }), wallrun: mantleRun({ from: 'wall' }) },
    camera: { chain144: cameraRun({ hz: 144 }), chain60: cameraRun({ hz: 60 }), facade144: cameraIrregular('facade'),
      angleToward144: cameraIrregular('angle-toward'), gap2_144: cameraIrregular('gap2'),
      eye: Object.fromEntries(['pillar', 'stepout', 'angle-toward', 'slant2', 'slant1'].flatMap(f => [30, 144, 240].map(hz => [`${f}@${hz}`, cameraEyeRun(f, { hz })]))) },
    ashfall: await ashfallReport(),
  };
}

function printReport(r) {
  const { entry } = r;
  console.log(`entry, airborne 0.3 m out, 3 m up (1 = attaches); angle off the wall: ${entry.angles.join(' ')}`);
  for (const [label, rows] of Object.entries(entry.air)) {
    for (const [speed, row] of Object.entries(rows)) console.log(`  ${label.padEnd(10)} ${String(speed).padStart(4)} m/s  ${row.join('  ')}`);
  }
  console.log('entry, sprint + ground jump at the wall (attach time s / feet height m, - = none):');
  for (const [gap, row] of Object.entries(entry.ground)) {
    console.log(`  ${String(gap).padStart(4)} m out  ${row.map(e => (e.attached ? `${e.t}/${e.height}` : '-')).join('  ')}`);
  }
  for (const [label, p] of [['profile', r.profile], ['profile, no key', r.profileNoKey]]) {
    if (!p.attached) { console.log(`${label}: no wallrun`); continue; }
    console.log(`${label}: attach ${p.entryDelay} s after the jump at ${p.entryHeight} m, ${p.seconds} s on the wall, ${p.distance} m, speed ${p.v0} -> max ${p.vMax} -> ${p.v1} m/s, rise ${p.rise} m, end ${p.endDrop} m, ends by ${p.reason}`);
    console.log(`  t/v/h: ${p.samples.map(s => `${s.t}:${s.v}/${s.h}`).join(' ')}`);
  }
  console.log('irregular walls (feature at z 36, 9.5 m/s): first-run seconds, passed, total wall seconds, segments');
  for (const [f, v] of Object.entries(r.irregular)) console.log(`  ${f.padEnd(13)} ${v.seconds}s passed=${v.passed} detachZ=${v.detachZ} total=${v.total}s segs=${v.segments} vEnd=${v.vEnd}`);
  console.log('street chains (best of aim 30/45/60/65, run 0.1/0.25/0.5 s, double jump none / at vy 0, -3, -6):');
  for (const [w, v] of Object.entries(r.chain)) {
    const b = v.best;
    console.log(`  ${String(w).padStart(2)} m: ${b.walls} walls (aim ${b.aim}, run ${b.runT}, dj at vy ${b.djVy}) top ${b.topSpeed} m/s peak ${b.peak} m; hop ${b.hop ? `${b.hop.speed} m/s at ${b.hop.out} deg vy ${b.hop.vy} dj ${b.hop.jumpsLeft}` : '-'}; catches ${b.catches.join(', ')}`);
    console.log(`        at 45/0.25/dj: ${v.at45.walls} walls, top ${v.at45.topSpeed}, hops ${v.at45.hops.map(h => `${h.speed}@${h.out}°`).join(' ')}, catch speeds ${v.at45.catches.join(' ')}`);
  }
  console.log('false positives (wall ticks over 3 angles x 5 s):');
  for (const [k, v] of Object.entries(r.falsePositives)) {
    console.log(`  ${k.padEnd(24)} wall ticks ${v.wallTicks} (${v.entries} runs${v.entries ? `, lowest entry ${v.entryHeight} m up` : ''}), climbed ${v.climbed} m`);
  }
  for (const [k, v] of Object.entries(r.mantle)) console.log(`mantle ${k}: ${JSON.stringify(v)}`);
  for (const [k, v] of Object.entries(r.camera)) console.log(`camera ${k}: ${JSON.stringify(v)}`);
  console.log('Ashfall:');
  for (const [k, v] of Object.entries(r.ashfall)) console.log(`  ${k.padEnd(36)} ${JSON.stringify(v)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await measureWallrun();
  printReport(report);
  const at = process.argv.indexOf('--json');
  if (at > 0 && process.argv[at + 1]) {
    for (const v of Object.values(report.chain)) delete v.trace;
    writeFileSync(process.argv[at + 1], JSON.stringify(report, null, 1));
  }
}
