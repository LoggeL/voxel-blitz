#!/usr/bin/env node
/**
 * Muted CDP captures of the pilot wallrun camera on Ashfall (docs/titanfall.md §4.1-4.2;
 * references docs/design/titanfall/wallrun/). The runs are played in Node through the client
 * path: LocalPlayer (keys on Input, the fixed-step pilot prediction, pilotLerp) with the real
 * PilotCamera, and LocalPlayer.updateCamera composes each frame's camera (eye, roll, FOV).
 * Two runs: a sprint-jump along the Hab alley's annex face, a wall-jump across to the tower
 * face and the catch there; and a run along the curved tank wall at x 130 (z 84-97), which
 * the body steps around twice. capture.html (?probe=1) renders the chosen frames at the real
 * voxel world. Writes one JPEG per beat and a labelled sheet per run and size (3 columns
 * landscape, 2 portrait). Chromium runs with --mute-audio and the page creates no
 * AudioContext. Holds one of the three .titan-capture.lock slots (waits up to --wait s).
 *
 *   node tools/titanfall-wallrun-capture.mjs [--out <dir>] [--sizes desktop,landscape,portrait] [--quality high] [--wait 600]
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchCdpSession } from './lib/cdp-session.mjs';
import { startServer, stopServer } from './lib/server-process.mjs';
import { ashfallSolid } from './titanfall-wallrun-measure.mjs';
import { PilotCamera } from '../public/js/titanfall/pilot-camera.js';
import { PILOT_RULES } from '../shared/pilot-movement.js';
import { PlayerPhysics } from '../public/js/player-physics.js';
import { LocalPlayer } from '../public/js/player/local-player.js';
import { Input } from '../public/js/engine/input.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const arg = (name, fallback = null) => {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};
const outDir = path.resolve(root, arg('--out', 'docs/design/titanfall/wallrun/captures'));
const SIZES = Object.freeze({
  desktop: { width: 1920, height: 1080 },
  landscape: { width: 844, height: 390 },
  portrait: { width: 390, height: 844 },
});
const sizes = arg('--sizes', 'desktop,landscape,portrait').split(',').filter(s => SIZES[s]);
const quality = arg('--quality', 'high');
const waitSeconds = Number(arg('--wait', 600));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function acquireSlot() {
  const until = Date.now() + waitSeconds * 1000;
  for (;;) {
    for (const suffix of ['', '2', '3']) {
      const dir = path.join(root, `.titan-capture.lock${suffix}`);
      try { mkdirSync(dir); } catch { continue; }
      const release = () => rmSync(dir, { recursive: true, force: true });
      process.once('exit', release);
      for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { release(); process.exit(130); });
      return release;
    }
    if (Date.now() > until) throw new Error('all three .titan-capture.lock slots are held');
    await sleep(5000);
  }
}

const DT = 1 / 60, DEG = Math.PI / 180, T = 14;
const yawToward = (dx, dz) => Math.atan2(-dx, -dz);

const KEY_CODES = Object.freeze({ forward: 'KeyW', sprint: 'ShiftLeft', jump: 'Space' });

/**
 * A sprint-jump from `start` (feet, on the ground) at `angle` off +z, played through LocalPlayer at
 * 60 Hz frames. `script(state)` returns each frame's { yaw, jump } (state: frame, wall, walls,
 * wallSince, jumped); forward and sprint stay held. Returns the camera of every frame.
 */
export function clientPoses(solid, start, angle, script, frames = 150) {
  const input = new Input({});
  input.fallback = true;
  const physics = new PlayerPhysics();
  physics.solid = solid;
  physics.pilotRules = true;
  Object.assign(physics.pos, start);
  Object.assign(physics.vel, { x: PILOT_RULES.sprint * Math.sin(angle), y: 0, z: PILOT_RULES.sprint * Math.cos(angle) });
  physics.grounded = true;
  physics.pilot.lastGroundY = start.y;
  const player = new LocalPlayer({ input, physics });
  player.pilotCamera = new PilotCamera();
  const camera = { position: { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } },
    rotation: { order: 'YXZ', x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } },
    fov: 79, updateProjectionMatrix() {} };
  const weapon = { id: 'rifle', adsFov: 55 };
  const intents = { fireAllowed: true, sendInput: () => true };
  const held = { forward: false, sprint: false, jump: false };
  const press = (key, down) => {
    if (held[key] === down) return;
    held[key] = down;
    const event = { code: KEY_CODES[key], repeat: false, preventDefault() {} };
    if (down) input._onKeyDown(event); else input._onKeyUp(event);
  };
  const poses = [], state = { frame: 0, wall: 0, walls: 0, wallSince: -1, jumped: false };
  let now = 1000, lastWall = 0;
  player.view.yaw = yawToward(Math.sin(angle), Math.cos(angle));
  try {
    player.setGameplayInputEnabled(true);
    press('forward', true);
    press('sprint', true);
    for (let i = 0; i < frames; i++) {
      const s = physics.pilot;
      if (s.wall !== lastWall) { if (s.wall) { state.walls++; state.wallSince = i; } lastWall = s.wall; }
      Object.assign(state, { frame: i, wall: s.wall });
      const step = script(state);
      if (Number.isFinite(step.yaw)) player.view.yaw = step.yaw;
      if (step.jump) state.jumped = state.frame > 0 || state.jumped;
      press('jump', !!step.jump);
      now += DT * 1000;
      player.update(DT, now, intents);
      player.updateCamera(DT, camera, weapon, 0, 75);
      poses.push({ i, t: i * DT, x: camera.position.x, y: camera.position.y, z: camera.position.z, pitch: camera.rotation.x,
        yaw: camera.rotation.y, roll: camera.rotation.z, fov: camera.fov, wall: s.wall, wallT: s.wallT, shiftX: s.shiftX,
        speed: Math.hypot(physics.vel.x, physics.vel.z), walls: state.walls });
      if (i > 5 && physics.grounded) break;
    }
  } finally { player.dispose(); input.dispose(); }
  return poses;
}

/**
 * The Hab alley run: sprint-jump at 12° along the annex face (x 60), 0.55 s on it, a
 * wall-jump aimed 50° across to the tower face (x 55), then that run.
 */
export async function wallrunPoses(solid = null) {
  solid ??= await ashfallSolid();
  const a = 12 * DEG, across = yawToward(-Math.sin(50 * DEG), Math.cos(50 * DEG));
  return clientPoses(solid, { x: 60 - 0.32 - 0.4, y: T + 1, z: 38.5 }, a, s => {
    if (s.frame === 0) return { jump: true };
    if (s.wall && s.walls === 1 && (s.frame - s.wallSince) * DT >= 0.55) return { yaw: across, jump: !s.jumped };
    if (s.wall) return { yaw: Math.PI };   // look along the run (+z)
    return { yaw: s.jumped ? across : undefined };
  });
}

/** The tank arc: a sprint-jump along the curved wall at x 130 (z 84-97), stepped around twice. */
export async function arcPoses(solid = null) {
  solid ??= await ashfallSolid();
  return clientPoses(solid, { x: 130 - 0.32 - 0.4, y: T + 1, z: 84.5 }, 12 * DEG,
    s => (s.frame === 0 ? { jump: true } : { yaw: s.wall ? Math.PI : undefined }), 120);
}

/** Six beats of the run: before the catch, the roll easing in, settled, the wall-jump, mid-air, the other wall. */
export function pickBeats(poses) {
  const first = poses.findIndex(p => p.wall);
  const leave = poses.findIndex((p, k) => k > first && !p.wall);
  const second = poses.findIndex((p, k) => k > leave && p.wall);
  const at = k => poses[Math.max(0, Math.min(poses.length - 1, k))];
  return [
    ['approach', at(first - 3)], ['catch +0.10 s', at(first + 6)], ['run +0.45 s', at(first + 27)],
    ['wall-jump', at(leave + 2)], ['across', at(Math.round((leave + second) / 2) + 1)], ['other wall +0.25 s', at(second + 15)],
  ];
}

/** Three beats of the arc run: easing out before the first step-around, its frame, and 0.2 s on. */
export function pickArcBeats(poses) {
  const step = poses.findIndex((p, k) => k > 0 && p.shiftX !== poses[k - 1].shiftX);
  const at = k => poses[Math.max(0, Math.min(poses.length - 1, k))];
  return [['arc: before the step', at(step - 9)], ['arc: step-around', at(step)], ['arc: step +0.2 s', at(step + 12)]];
}

/** Runtime.evaluate with a long CDP timeout (software GL renders a 1080p frame in seconds). */
async function evaluateLong(page, expression, timeoutMs = 900000) {
  const result = await page.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeoutMs);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
}

async function main() {
  const solid = await ashfallSolid();
  const runs = [['', pickBeats(await wallrunPoses(solid))], ['arc-', pickArcBeats(await arcPoses(solid))]];
  const release = await acquireSlot();
  await mkdir(outDir, { recursive: true });
  const server = startServer({ entry: 'tools/capture-server.mjs', failureContext: 'wallrun capture' });
  const report = { generated: new Date().toISOString(), beats: runs.flatMap(([run, beats]) => beats.map(([label, p]) => ({ run: run || 'hab-',
    label, t: +p.t.toFixed(3), roll: +(p.roll / DEG).toFixed(2), fov: +p.fov.toFixed(2), speed: +p.speed.toFixed(2), wall: p.wall,
    eye: [+p.x.toFixed(3), +p.y.toFixed(3), +p.z.toFixed(3)] }))), shots: [], errors: [] };
  try {
    const port = await server.port;
    for (const sizeId of sizes) {
      const size = SIZES[sizeId];
      const url = `http://127.0.0.1:${port}/capture.html?map=ashfall&shot=hab-alley&probe=1&quality=${quality}`;
      const session = await launchCdpSession(url, size);
      try {
        const page = session.page;
        await page.waitFor("document.documentElement.dataset.captureReady === 'true'", { timeoutMs: 240000, label: 'ashfall capture page' });
        for (const [run, beats] of runs) {
        const shots = await evaluateLong(page, `(async () => {
          const { camera, worldview, frame } = window.__vbProbe;
          const canvas = document.getElementById('capture');
          const beats = ${JSON.stringify(beats.map(([label, p]) => ({ label, ...p })))};
          const W = canvas.width, H = canvas.height, cols = W >= H ? 3 : 2, rows = Math.ceil(beats.length / cols);
          const sheet = document.createElement('canvas');
          const cell = W >= H ? { w: 640, h: Math.round(640 * H / W) } : { w: 390, h: Math.round(390 * H / W) };
          sheet.width = cell.w * cols; sheet.height = cell.h * rows;
          const g = sheet.getContext('2d');
          const frames = [];
          for (let k = 0; k < beats.length; k++) {
            const b = beats[k];
            camera.position.set(b.x, b.y, b.z);
            camera.rotation.order = 'YXZ';
            camera.rotation.set(b.pitch, b.yaw, b.roll);
            camera.fov = b.fov;
            camera.aspect = W / H;
            camera.updateProjectionMatrix();
            worldview.setViewPosition(camera.position);
            await worldview.ready?.();
            worldview.update(0, camera);
            frame(); frame();
            frames.push(canvas.toDataURL('image/jpeg', 0.88));
            const cx = (k % cols) * cell.w, cy = Math.floor(k / cols) * cell.h;
            g.drawImage(canvas, cx, cy, cell.w, cell.h);
            g.fillStyle = 'rgba(8,10,14,0.72)';
            g.fillRect(cx, cy, cell.w, 26);
            g.fillStyle = '#ffab2e';
            g.font = '600 15px system-ui, sans-serif';
            g.fillText(b.label + '  ·  roll ' + (b.roll * 180 / Math.PI).toFixed(1) + '°  ·  fov ' + b.fov.toFixed(1) + '  ·  ' + b.speed.toFixed(1) + ' m/s', cx + 8, cy + 18);
            // Crosshair and a level reference: the roll reads against the screen edges.
            const mx = cx + cell.w / 2, my = cy + cell.h / 2;
            g.strokeStyle = 'rgba(255,255,255,0.85)'; g.lineWidth = 1.5;
            g.beginPath(); g.moveTo(mx - 7, my); g.lineTo(mx + 7, my); g.moveTo(mx, my - 7); g.lineTo(mx, my + 7); g.stroke();
          }
          return { frames, sheet: sheet.toDataURL('image/jpeg', 0.9) };
        })()`);
        const slug = label => label.replace(/[^a-z0-9]+/gi, '-').replace(/-+$/, '').toLowerCase();
        for (let k = 0; k < shots.frames.length; k++) {
          const name = `${sizeId}-${run}${String(k + 1).padStart(2, '0')}-${slug(beats[k][0].replace(/^arc: /, ''))}.jpg`;
          await writeFile(path.join(outDir, name), Buffer.from(shots.frames[k].split(',')[1], 'base64'));
          report.shots.push(name);
        }
        const sheetName = `${sizeId}-${run}sheet.jpg`;
        await writeFile(path.join(outDir, sheetName), Buffer.from(shots.sheet.split(',')[1], 'base64'));
        report.shots.push(sheetName);
        console.log(`${sizeId} ${run || 'hab-'}: ${shots.frames.length} frames + sheet`);
        }
      } catch (error) {
        report.errors.push(`${sizeId}: ${error.message}`);
        console.error(`${sizeId}: ${error.message}`);
      } finally {
        await session.close();
      }
    }
  } finally {
    await stopServer(server);
    release();
  }
  await writeFile(path.join(outDir, 'capture-report.json'), `${JSON.stringify(report, null, 1)}\n`);
  if (report.errors.length) process.exit(1);
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  main().catch(error => { console.error(error); process.exit(1); });
}
