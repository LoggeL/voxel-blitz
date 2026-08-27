#!/usr/bin/env node
// tools/bot.mjs — standalone load/protocol-test client for Voxel Blitz.
//
// Usage:
//   node tools/bot.mjs [--name BotWarrior] [--host ws://localhost:8070] [--skill 0..1]
//
// Connects a REAL ws client to a running server, plays crude-but-working
// FPS behavior (roam waypoints -> spot enemies -> aim/fire in bursts ->
// predictively reload), and exercises the exact production protocol:
// JSON text frames plus the single binary map frame pushed after join.
//
// ---------------------------------------------------------------------------
// AIM CONVENTION (documented assumption block, required by BUILD-CONTRACT):
// CONFIRMED 2026-08-26 against server/game.js header + fwdFromYawPitch/
// aimAngles source, which existed on disk at bot build time:
//
//     fwdFromYawPitch(yaw, pitch)
//       = { x: -Math.sin(yaw) * cosP, y: Math.sin(pitch), z: -Math.cos(yaw) * cosP }
//
//     steering inverse ("look from A toward B"):
//       yaw   = Math.atan2(-(bx - ax), -(bz - az))
//       pitch = Math.atan2(by - ay, Math.hypot(bx - ax, bz - az))
//
// i.e. yaw = 0 faces -Z, positive yaw turns toward -X (CCW seen from +Y),
// pitch > 0 looks up, ALL angles radians. This exact pair is used for BOTH
// roam steering and combat aiming so the bot stays self-consistent; if the
// server ever flips a sign here, patching these two helpers fixes everything.
// ---------------------------------------------------------------------------
//
// Robustness notes:
// - The binary map frame is paired with the welcome by ARRIVAL ORDER on the
//   same socket, exactly like the browser client does. A map frame arriving
//   before any textual tick is handled; a map arriving before its welcome is
//   stashed and consumed once the welcome lands. Ticks without a map degrade
//   gracefully (no LOS => pure roam).
// - Backpressure is intentionally ignored (fire-and-forget ws.send).
// - Block deltas from tick.blocks are folded into the local voxel store so
//   line-of-sight checks see the destructed battlefield.

import { WebSocket } from 'ws';
import {
  AIR,
  SX, SZ,
  getBlock, setBlock,
  findSpawns,
  deserializeWorld,
} from '../shared/worlddata.js';
import { raycastVoxels } from '../shared/raycast.js';
import { WEAPONS, WEAPON_IDS, EYE_HEIGHT } from '../shared/combatmath.js';

const INPUT_MS = 66;        // input cadence (~15 Hz; per harness spec)
const THINK_MS = 200;       // decision tick
const DEAD_WAIT_MS = 2600;  // server respawns at 2500; wait a bit longer
const AIM_TURN_BASE = 4;    // rad/s at skill 1
const ROAM_TURN_RATE = 3;   // rad/s waypoint steering
const ENGAGE_DIST = 55;
const LOS_DIST = 80;
const BURST_ON_MS = 350;
const BURST_OFF_MS = 250;
const ARRIVE_DIST = 3;
const WEAPON_HOLD_MS = 6000; // rotate the complete roster during sustained load runs

function parseArgs(argv) {
  const opts = { name: 'BotWarrior', host: 'ws://localhost:8070', skill: 0.5 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--name' && argv[i + 1]) opts.name = String(argv[++i]);
    else if (a === '--host' && argv[i + 1]) opts.host = String(argv[++i]);
    else if (a === '--skill' && argv[i + 1]) {
      const v = Number(argv[++i]);
      opts.skill = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.5;
    }
  }
  return opts;
}

const rand = Math.random;
const gauss = () => (rand() + rand() + rand()) / 1.5 - 1; // rough bell in [-1, 1]
const dist2d = (ax, az, bx, bz) => Math.hypot(bx - ax, bz - az);
function wrapAngle(a) { return Math.atan2(Math.sin(a), Math.cos(a)); }
function approachAngle(cur, target, maxStep) {
  let d = wrapAngle(target - cur);
  if (d > maxStep) d = maxStep;
  if (d < -maxStep) d = -maxStep;
  return wrapAngle(cur + d);
}
function shuffle(arr) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
const lerp = (a, b, t) => a + (b - a) * t;

/** Solidity callback for shared/raycastVoxels: any non-AIR voxel blocks. */
const solidAt = (x, y, z) => getBlock(x, y, z) !== AIR;

/** Free line of sight between two [x,y,z] points through the voxel grid. */
function losClear(a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  const len = Math.hypot(dx, dy, dz);
  if (len < 0.001) return true;
  const maxDist = Math.min(len - 0.15, LOS_DIST);
  return !raycastVoxels(solidAt, a[0], a[1], a[2], dx, dy, dz, maxDist);
}

/**
 * Steering inverse of the documented game.js convention (see header block):
 * yaw/pitch that look from `from` toward `to`.
 */
function aimAnglesToward(ax, ay, az, bx, by, bz) {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  return { yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(dy, Math.hypot(dx, dz) || 1e-9) };
}

class Bot {
  constructor(ws, opts) {
    this.ws = ws;
    this.opts = opts;
    this.skill = opts.skill;

    this.id = null;
    this.tickRate = 20;
    this.welcomed = false;
    this.hasMap = false;
    this.pendingBinary = null; // map frame stashed pre-welcome (arrival-order robustness)
    this.lastLogByKey = new Map();

    // Two-snapshot interpolation ring (same shape idea as netclient's).
    this.prevSnap = null; // { now, rows: Map(id->row) }
    this.curSnap = null;

    this.myRow = null;
    this.wasAlive = true;
    this.deadUntil = 0;

    this.firstSeenAt = 0;       // wall clock of first authoritative tick row
    this.myRow = null;
    this.wasAlive = true;
    this.myPos = null;          // latest authoritative feet pos [x,y,z]
    this.yaw = 0;
    this.pitch = 0;

    // Behavior flags consumed by the input loop, written by think().
    this.strafeDir = rand() < 0.5 ? -1 : 1;
    this.nextFlipAt = 0;
    this.sprinting = false;
    this.crouching = false;
    this.jumpLatchedUntil = 0;
    this.stuckCount = 0;
    this.posSample = null;      // { t, x, z } for stuck detection

    this.roamQueue = [];        // shuffled spawn waypoints
    this.roamTarget = null;
    this.enemy = null;          // { pos:[x,y,z], row }
    this.fireUntil = 0;
    this.pauseUntil = 0;
    this.bursting = false;      // mid-burst trigger window
    this.engagedNow = false;    // enemy visible this think cycle
    this.nextThinkAt = 0;

    // Predictive ammo model (server stays authoritative; this only paces us).
    // A live bot rotates every canonical slot so load runs exercise the full
    // roster rather than silently pinning every client to the rifle.
    this.weaponSlot = 0;
    this.def = WEAPONS[WEAPON_IDS[this.weaponSlot]];
    this.mag = this.def.magSize;
    this.nextWeaponAt = Date.now() + WEAPON_HOLD_MS;
    this.reloadUntil = 0;
    this.lastShotAt = 0;
    this.triggerSent = false;
    this.seq = 0;
  }

  log(msg) { console.log('[bot]', msg); }

  throttledLog(key, ms, fn) {
    const now = Date.now();
    if ((this.lastLogByKey.get(key) || 0) > now - ms) return;
    this.lastLogByKey.set(key, now);
    fn();
  }

  // ------------------------------------------------------------ ws lifecycle
  start() {
    this.ws.on('open', () => {
      this.log(`connected, joining as "${this.opts.name}"`);
      this.ws.send(JSON.stringify({ t: 'join', name: this.opts.name }));
    });
    this.ws.on('message', (data, isBinary) => this.onMessage(data, isBinary));
    this.ws.on('close', (code) => this.log(`socket closed (${code})`));
    this.ws.on('error', (err) => this.log(`socket error: ${err.message}`));

    this.inputTimer = setInterval(() => this.sendInput(), INPUT_MS);
  }

  stop() {
    clearInterval(this.inputTimer);
    try { this.ws.close(); } catch { /* already down */ }
  }

  // ------------------------------------------------------------- inbound ---
  onMessage(data, isBinary) {
    if (isBinary) return this.onMapFrame(data);

    let msg;
    try { msg = JSON.parse(data.toString('utf8')); } catch { return; }
    if (!msg || typeof msg !== 'object') return;

    switch (msg.t) {
      case 'welcome': this.onWelcome(msg); break;
      case 'tick': this.onTick(msg); break;
      case 'respawn': break; // covered by tick row state flips
      case 'die': break;
      case 'ev': this.onEvent(msg); break;
      default: break;
    }
  }

  onWelcome(msg) {
    this.id = msg.id;
    this.tickRate = msg.tickRate || 20;
    this.welcomed = true;
    const s = msg.spawn || {};
    this.myPos = [s.x || 0, s.y || 0, s.z || 0];
    // Face the arena center with the confirmed convention.
    const aim = aimAnglesToward(this.myPos[0], this.myPos[1] + EYE_HEIGHT, this.myPos[2], 64, 16, 48);
    this.yaw = aim.yaw;
    this.pitch = 0;
    if (this.pendingBinary) {
      const buf = this.pendingBinary;
      this.pendingBinary = null;
      this.applyMap(buf);
    }
    this.refillRoamTargets();
    this.log(
      `welcome id=${this.id} tickRate=${this.tickRate} mapBytes=${msg.mapBytes}` +
      (this.hasMap ? '' : ' (map pending)')
    );
  }

  /** Binary frames: the world payload (first one) or anything we drop later. */
  onMapFrame(data) {
    if (!this.hasMap) {
      if (!this.welcomed) {
        // Ordering robustness: map can legally beat textual ticks; before a
        // welcome it must be the map frame either way. Stash latest, consume
        // on welcome.
        this.pendingBinary = Buffer.from(data);
        return;
      }
      this.applyMap(data);
    }
    // Later binaries are unexpected in this protocol; ignore silently.
  }

  applyMap(data) {
    try {
      deserializeWorld(new Uint8Array(Buffer.from(data)));
      this.hasMap = true;
      this.refillRoamTargets(); // spawns query terrain; refresh post-load
      this.throttledLog('map', 5000, () => this.log('map frame applied'));
    } catch (err) {
      this.log(`map apply failed: ${err.message}`);
    }
  }

  onTick(msg) {
    for (const ev of msg.events || []) this.onEvent(ev);

    // Rotate the two-snapshot ring.
    this.prevSnap = this.curSnap;
    this.curSnap = { now: msg.now || Date.now(), rows: new Map() };
    for (const row of msg.players || []) this.curSnap.rows.set(row.id, row);

    // Fold world deltas into the local voxel store (index = (y*SZ+z)*SX+x).
    if (this.hasMap) {
      for (const b of msg.blocks || []) {
        const x = b.i % SX;
        const q = (b.i - x) / SX;
        const z = q % SZ;
        const y = (q - z) / SZ;
        setBlock(x, y, z, b.v);
      }
    }

    const mine = this.id != null ? this.curSnap.rows.get(this.id) : undefined;
    if (mine) {
      this.myRow = mine;
      this.myPos = [mine.x, mine.y, mine.z];
      if (Array.isArray(mine.mag) && Number.isFinite(mine.mag[this.weaponSlot])) {
        this.mag = mine.mag[this.weaponSlot];
      }
      if (this.firstSeenAt === 0) {
        this.firstSeenAt = Date.now();
        this.log(`spawned at ${mine.x.toFixed(1)}, ${mine.y.toFixed(1)}, ${mine.z.toFixed(1)} (server pos)`);
      }
      if (mine.state !== 'alive' && this.wasAlive) {
        this.wasAlive = false;
        this.deadUntil = Date.now() + DEAD_WAIT_MS;
        this.enemy = null;
        this.roamTarget = null;
        this.fireUntil = this.pauseUntil = 0;
        this.bursting = false;
        this.engagedNow = false;
        this.triggerSent = false;
        this.log('died');
      } else if (mine.state === 'alive' && !this.wasAlive) {
        this.wasAlive = true;
        this.mag = Array.isArray(mine.mag) && Number.isFinite(mine.mag[this.weaponSlot])
          ? mine.mag[this.weaponSlot]
          : this.def.magSize;
        this.reloadUntil = 0;
        this.triggerSent = false;
        this.posSample = null;
        this.stuckCount = 0;
        this.log(`respawned at ${mine.x.toFixed(1)},${mine.z.toFixed(1)}`);
      }
    }
  }

  /** Minimal event interest: personal killfeed lines, heavily rate-limited. */
  onEvent(ev) {
    if (!ev || ev.kind !== 'kill') return;
    const killer = String(ev.killer ?? '');
    const victim = String(ev.victim ?? '');
    if (killer === this.id && victim !== this.id) {
      this.throttledLog('frag', 5000, () => this.log(`frag scored ${ev.hs ? '(headshot)' : ''}`));
    }
  }

  // ---------------------------------------------------------- perception ---
  /** Interpolated copy of a remote player row at wall-clock `nowMs`. */
  interpolatedRow(row, nowMs) {
    if (!this.prevSnap || !this.curSnap) return row;
    const prev = this.prevSnap.rows.get(row.id);
    if (!prev) return row;
    const span = this.curSnap.now - this.prevSnap.now;
    if (!(span > 0)) return row;
    // alpha=1 right at cur arrival, drifting slightly past it until the next
    // snapshot lands (clamped extrapolation compensates one tick of latency).
    const alpha = Math.min(1.25, Math.max(0, (nowMs - this.prevSnap.now) / span));
    return {
      ...row,
      x: lerp(prev.x, row.x, alpha),
      y: lerp(prev.y, row.y, alpha),
      z: lerp(prev.z, row.z, alpha),
      yaw: (() => { // shortest-path angle lerp
        const d = wrapAngle(row.yaw - prev.yaw);
        return prev.yaw + d * alpha;
      })(),
      pitch: lerp(prev.pitch, row.pitch, alpha),
    };
  }

  refillRoamTargets() {
    this.roamQueue = shuffle(findSpawns(9));
    this.roamTarget = null;
  }

  nextRoamTarget() {
    if (this.roamQueue.length === 0) this.refillRoamTargets();
    // Pop sequentially from the shuffled list: random order, never the same
    // point twice before the whole ring is walked. Walked until within 3 u
    // (arrival is checked in think()).
    const cand = this.roamQueue.shift() || { x: 64, y: 16, z: 48 };
    this.roamTarget = cand;
  }

  /**
   * Scan interpolated remote players; closest visible living enemy wins.
   * Visibility = plain range gate AND voxel LOS between eye points.
   */
  scanForEnemy(nowMs) {
    if (!this.curSnap || !this.myPos) return null;
    let best = null;
    let bestD = Infinity;
    const eye = [this.myPos[0], this.myPos[1] + EYE_HEIGHT, this.myPos[2]];
    for (const row of this.curSnap.rows.values()) {
      if (row.id === this.id || row.state !== 'alive') continue;
      const interp = this.interpolatedRow(row, nowMs);
      const dx = interp.x - this.myPos[0];
      const dy = interp.y - this.myPos[1];
      const dz = interp.z - this.myPos[2];
      const d = Math.hypot(dx, dy, dz);
      if (d > ENGAGE_DIST || d >= bestD) continue;
      const theirEye = [interp.x, interp.y + EYE_HEIGHT, interp.z];
      const theirChest = [interp.x, interp.y + 1.3, interp.z]; // aim point (see contract CHEST_Y note)
      if (losClear(eye, theirEye) || losClear(eye, theirChest)) {
        best = { row, pos: theirChest, d };
        bestD = d;
      }
    }
    return best;
  }

  // -------------------------------------------------------------- think ----
  think(nowMs) {
    const dt = THINK_MS / 1000;

    if (nowMs >= this.nextWeaponAt) {
      this.weaponSlot = (this.weaponSlot + 1) % WEAPON_IDS.length;
      this.def = WEAPONS[WEAPON_IDS[this.weaponSlot]];
      this.mag = Array.isArray(this.myRow?.mag) && Number.isFinite(this.myRow.mag[this.weaponSlot])
        ? this.myRow.mag[this.weaponSlot]
        : this.def.magSize;
      this.reloadUntil = 0;
      this.triggerSent = false;
      this.nextWeaponAt = nowMs + WEAPON_HOLD_MS;
      this.log(`switching to ${this.def.name} (slot ${this.weaponSlot + 1}/${WEAPON_IDS.length})`);
    }

    // Strafe rhythm: flip ±1 every ~1.2 s.
    if (nowMs >= this.nextFlipAt) {
      if (rand() < 0.7) this.strafeDir *= -1;
      this.nextFlipAt = nowMs + 700 + rand() * 700;
    }

    // Stuck detection over ~1 s windows.
    if (this.posSample == null) {
      this.posSample = { t: nowMs, x: this.myPos ? this.myPos[0] : 0, z: this.myPos ? this.myPos[2] : 0 };
    } else if (nowMs - this.posSample.t >= 1000) {
      const moved = this.myPos ? dist2d(this.posSample.x, this.posSample.z, this.myPos[0], this.myPos[2]) : 99;
      if (moved < 0.05) {
        this.stuckCount++;
        if (this.stuckCount % 2 === 1) this.jumpLatchedUntil = nowMs + 450; // hop
        if (this.stuckCount >= 3) { this.nextRoamTarget(); this.stuckCount = 0; } // unstick waypoint
      } else {
        this.stuckCount = 0;
      }
      this.posSample = { t: nowMs, x: this.myPos ? this.myPos[0] : 0, z: this.myPos ? this.myPos[2] : 0 };
    }

    // Waypoint upkeep.
    if (!this.roamTarget && this.hasMap) this.nextRoamTarget();
    if (this.roamTarget && this.myPos &&
        dist2d(this.myPos[0], this.myPos[2], this.roamTarget.x, this.roamTarget.z) < ARRIVE_DIST) {
      this.roamTarget = null;
      this.sprinting = false;
    }

    // Combat scan (interpolated positions + voxel LOS).
    this.enemy = this.scanForEnemy(nowMs);

    if (this.enemy) {
      // --- aim: lerp toward enemy chest, error shrinks with skill.
      const turnRate = AIM_TURN_BASE * (0.2 + 0.8 * this.skill);
      const errSigmaRad = ((1 - this.skill) * 3 * Math.PI) / 180;
      const wanderErr = gauss() * errSigmaRad * 0.5 + Math.sin(nowMs / 900) * errSigmaRad * 0.4;
      const tgt = aimAnglesToward(
        this.myPos[0], this.myPos[1] + EYE_HEIGHT, this.myPos[2],
        this.enemy.pos[0], this.enemy.pos[1], this.enemy.pos[2]
      );
      this.yaw = approachAngle(this.yaw, tgt.yaw + wanderErr, turnRate * dt);
      this.pitch = approachAngle(this.pitch, Math.max(-1.45, Math.min(1.45, tgt.pitch + wanderErr * 0.5)), turnRate * dt);

      // --- burst discipline: 350 ms trigger held, then a 250 ms breath.
      // Two-phase latch so windows never extend back-to-back.
      if (!this.bursting && nowMs >= this.pauseUntil) {
        this.bursting = true;
        this.fireUntil = nowMs + BURST_ON_MS;
      } else if (this.bursting && nowMs >= this.fireUntil) {
        this.bursting = false;
        this.pauseUntil = nowMs + BURST_OFF_MS;
      }

      // --- flavor posture.
      this.sprinting = false;
      this.crouching = this.enemy.d < 14 && this.skill < 0.75;
      this.engagedNow = true;
      this.throttledLog('engage', 5000, () =>
        this.log(`engaging ${this.enemy.row.name || this.enemy.row.id} @ ${this.enemy.d.toFixed(1)}u`));
    } else {
      // --- roam: steer at the waypoint, level pitch toward horizon.
      this.crouching = false;
      this.engagedNow = false;
      this.bursting = false;
      if (this.roamTarget && this.myPos) {
        const tgt = aimAnglesToward(
          this.myPos[0], this.myPos[1], this.myPos[2],
          this.roamTarget.x, this.roamTarget.y, this.roamTarget.z
        );
        this.yaw = approachAngle(this.yaw, tgt.yaw, ROAM_TURN_RATE * dt);
        this.pitch = approachAngle(this.pitch, 0, ROAM_TURN_RATE * dt); // flatten to horizon
        this.sprinting = dist2d(this.myPos[0], this.myPos[2], this.roamTarget.x, this.roamTarget.z) > 25;
      }

    }
  }
  // ------------------------------------------------------------- output ----
  sendInput() {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    const now = Date.now();

    // Slow-think scheduling lives in the fast loop for a single timer.
    if (this.welcomed && now >= this.nextThinkAt && this.myPos) {
      this.nextThinkAt = now + THINK_MS;
      this.think(now);
    }

    const inp = {
      t: 'input',
      seq: ++this.seq,
      keys: { f: false, b: false, l: false, r: false, jump: false, sprint: false, crouch: false },
      yaw: this.yaw,
      pitch: Math.max(-1.55, Math.min(1.55, this.pitch)),
      weapon: this.weaponSlot,
      wantFire: false,
      wantAds: false,
      reload: false,
    };
    const k = inp.keys;

    if (!this.welcomed || now < this.deadUntil) {
      // Dead/spawn-wait or pre-spawn: send cleared movement only.
      this.ws.send(JSON.stringify(inp));
      return;
    }

    // Predictive ammo pacing: spend rounds while firing, force reload at empty.
    // Non-auto weapons emit a real release frame between presses; holding a
    // semi trigger must never be mistaken for repeated authoritative edges.
    const shotInterval = 60000 / this.def.rpm;
    const wantTrigger = this.engagedNow && this.bursting;
    const readyShot = wantTrigger && now - this.lastShotAt >= shotInterval;
    if (this.reloadUntil > 0) {
      inp.reload = true;
      this.triggerSent = false;
      if (now >= this.reloadUntil) {
        this.reloadUntil = 0;
        this.mag = this.def.magSize;
      }
    } else if (this.def.mode === 'auto') {
      inp.wantFire = wantTrigger && this.mag > 0;
      this.triggerSent = inp.wantFire;
      if (readyShot && this.mag > 0) {
        this.lastShotAt = now;
        this.mag--;
      }
    } else if (this.triggerSent) {
      this.triggerSent = false;
    } else if (readyShot && this.mag > 0) {
      inp.wantFire = true;
      this.triggerSent = true;
      this.lastShotAt = now;
      this.mag--;
    }
    if (this.mag <= 0 && this.reloadUntil <= 0) {
      this.reloadUntil = now + this.def.reloadTime * 1000 + 150;
      inp.wantFire = false;
      inp.reload = true;
      this.triggerSent = false;
    }
    inp.wantAds = this.engagedNow && this.enemy != null && this.enemy.d > 28 && this.skill > 0.55;

    // Movement.
    k.f = true; // wishdir normalization keeps diagonal legal server-side
    if (!this.engagedNow && this.strafeDir > 0) k.r = true;
    else if (!this.engagedNow && this.strafeDir < 0) k.l = true;
    else if (this.engagedNow && this.strafeDir > 0) k.r = true; // combat jink
    else if (this.engagedNow && this.strafeDir < 0) k.l = true;
    k.sprint = this.sprinting;
    k.crouch = this.crouching;
    if (now < this.jumpLatchedUntil) k.jump = true;

    this.ws.send(JSON.stringify(inp));
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  let host = opts.host.replace(/\/+$/, '');
  if (!/^wss?:\/\//.test(host)) host = `ws://${host}`;

  const ws = new WebSocket(host);
  const bot = new Bot(ws, opts);
  bot.start();

  // Give up cleanly if the server never welcomes us.
  const welcomeWatchdog = setTimeout(() => {
    if (!bot.welcomed) {
      bot.log('no welcome within 10 s — aborting');
      cleanupAndExit(2);
    }
  }, 10000);

  let exiting = false;
  function cleanupAndExit(code) {
    if (exiting) return;
    exiting = true;
    clearTimeout(welcomeWatchdog);
    bot.stop();
    setTimeout(() => process.exit(code), 120); // let the close frame flush
  }

  ws.on('close', () => cleanupAndExit(bot.welcomed ? 0 : 2));

  process.once('SIGINT', () => {
    bot.log('SIGINT — closing');
    cleanupAndExit(0);
  });
  process.once('SIGTERM', () => cleanupAndExit(0));
}

main().catch((err) => {
  console.error('[bot] fatal:', err.message);
  process.exit(1);
});
