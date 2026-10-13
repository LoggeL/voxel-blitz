/**
 * Titanfall pilot movement (docs/titanfall.md §2.6, §4). Shared and pure: the
 * server's stepMovement and the client's PlayerPhysics.step call the same five
 * hooks, each behind `ctx.pilotRules` / `this.pilotRules`, which is true only
 * in titanfall, so every other mode keeps the stock integrator bit for bit.
 *
 * `body` is the moving entity (server PlayerEntity, or the client physics
 * view with the same field names: x, y, z, vx, vy, vz, grounded, coyote, crouch,
 * sprint); `ctx` carries solidAt(x, y, z), fluidAt?, vehicles and now.
 *
 * In pilot mode the hooks own the whole velocity integration between the
 * stock vault/ladder/swim branches and the shared axis slides:
 *
 *   pilotPreStep     jump press: grapple release, wall-jump, arms the double jump;
 *                    slide entry (boost) and exit
 *   pilotSpeedFor    5.2 / 8.5 / 2.6 m/s pilot speeds (stim ×1.3)
 *   pilotAccel       ground blend (hop window keeps speed for a fresh press), slide friction,
 *                    wallrun tangent, Quake air strafe + soft drag; false on a
 *                    ladder or in water (stock blend)
 *   pilotVertical    ground jump, double jump, wallrun gravity, grapple pull, gravity
 *   pilotPostCollide landing, wallrun entry/exit probes, grapple release, timers,
 *                    horizontal clamp
 *
 * Wall codes (`state.wall`, `tfs[3]`): the axis and sign of the wall's outward
 * normal: ±1 = ±X, ±2 = ±Z. A wall on the runner's +X side is -1.
 * Every operation is plain IEEE arithmetic in a fixed order, so the server and
 * the client produce bit-equal results for equal inputs.
 */
import { PHYSICS, MOVEMENT_RULES, slidePlayerAxis, solidBelow } from './player-movement.js';
import { playerHullContact } from './player-vehicle-collision.js';

export const PILOT_RULES = Object.freeze({
  walk: 5.2, sprint: 8.5, crouch: 2.6,
  clamp: 14, airSoftCap: 11, airDrag: 2,
  // doubleJumpH: the double jump redirects the horizontal velocity to the wish
  // direction, keeping its speed but at least this much.
  doubleJumpVy: 7.4, doubleJumpH: 4, airWishCap: 1.6, airAccel: 60,
  // Entry: airborne, minAir of air under the feet here and 1..`ahead` m along the run (no stairs), a
  // full-height wall within `probe` of the hull, moving along it (tangent >= minTangent, at most
  // maxAngle into it), the wish (if any) not into it past wishDot. A held key is not needed.
  wallrun: Object.freeze({ minAir: 0.9, ahead: 2, probe: 0.3, minLength: 2, minTangent: 3.5, maxAngle: 72 * Math.PI / 180,
    wishDot: -0.95, maxRise: 8,
    // Speed: entry keeps the tangent plus `redirect` of the speed into the wall (never more than the
    // speed it had), at least `speed`; a run along the wish builds by `accel` m/s² up to `top` (a faster
    // entry keeps its speed under the clamp), no wish coasts down by `coast` m/s², a wish back brakes twice that.
    speed: 9, top: 11, accel: 3, coast: 3, redirect: 0.75, blend: 6,
    // Height: entry vy is at least `kick` (a falling catch pops up) and at most entryVy, both × the
    // chain's wallJump.decay; gravity ramps from `gravity` to `gravityEnd` (quadratic in wallT) over
    // the `seconds` the run lasts.
    kick: 1, entryVy: 2, gravity: 2, gravityEnd: 9, seconds: 1.5, roll: 13 * Math.PI / 180,
    // Contact: `stick` m/s pulls the hull flush to the wall; a wall at any of the three probe heights holds
    // the run; a wall one voxel farther (recess) is followed; with no wall the run coasts for `grace` s
    // if the wall resumes within `bridge` m ahead (gaps, windows); a one-voxel step toward the runner is
    // stepped around, at most one per `stepGap` m along the run (a wall angled up to ~30° runs, a 45° voxel
    // staircase ends the run). detachDot: pulling away this hard drops off; endTangent: too slow to hold on.
    stick: 5, grace: 0.25, bridge: 2, stepGap: 1.5, detachDot: 0.7, detachPush: 1.5, endTangent: 2 }),
  // Wall-jump: speed max(run speed, wallrun.speed) + boost (under the clamp), aimed by the wish between
  // minOut and maxOut off the wall (along the wall without a wish); vy decays with the chain, and no
  // wallrun, wall-jump or chained double jump lifts the feet past lastGroundY + wallrun.maxRise.
  wallJump: Object.freeze({ boost: 1, minOut: 30 * Math.PI / 180, maxOut: 65 * Math.PI / 180, vy: 7.6, decay: 0.85, lockout: 0.35 }),
  // steer: rad/s the slide can turn; airGrace: s a slide survives a lip without jumping.
  slide: Object.freeze({ minSpeed: 6.5, boost: 2.5, boostSlack: 0.5, cooldown: 2, friction: 7, uphill: 4, endSpeed: 3, hopWindow: 0.2,
    steer: 1.6, airGrace: 0.25 }),
  // gravityMul: gravity share while pulled; release: metres from the anchor; chest: rope origin above the feet;
  // head: line-of-sight origin above the feet; losGrace: s of lost sight before the hook lets go;
  // lift: vy a pull above the chest starts with off the ground; climb: vy while the pull presses into a
  // ledge below the anchor (the hook drags the pilot up and over cover).
  grapple: Object.freeze({ range: 38, accel: 32, cap: 22, seconds: 1.6, charges: 2, recharge: 6, gravityMul: 0.5, release: 2,
    chest: 1.2, head: 1.6, losStep: 0.5, losGrace: 0.25, lift: 4, climb: 6 }),
  stim: Object.freeze({ seconds: 4, speedMul: 1.3, regen: 30, cooldown: 12 }),
  cloak: Object.freeze({ seconds: 5, cooldown: 15, revealRange: 12, revealSeconds: 1 }),
  regen: Object.freeze({ delay: 5, rate: 20 }),
});

/** The client predicts pilot movement on this fixed step, the server's tick (TICK_RATE_HZ 60). */
export const PILOT_STEP_S = 1 / 60;

const R = PILOT_RULES, W = R.wallrun, WJ = R.wallJump, S = R.slide, G = R.grapple;
const HALF_W = PHYSICS.halfW, GRAVITY = PHYSICS.gravity, TERMINAL_VY = MOVEMENT_RULES.terminalVy;
const WALL_HEIGHTS = [0.3, 1.0, 1.8];

/** Hidden pilot state carried on the body as `body.pilot` (mirrored in the `tfs` frame). */
export function createPilotState() {
  return { wall: 0, wallT: 0, jumpsLeft: 1, slideT: 0, slideCd: 0, grapple: null, chain: 0, lastGroundY: null,
    wallLock: 0, wallLockN: 0, jumpSeqAck: 0, tac: 0,
    // wall plane cell, run speed, the wall-jump lockout plane and the spent wall (until ground)
    wallPlane: 0, wallSpeed: 0, wallLockPlane: 0, wallSpentN: 0, wallSpentPlane: 0,
    // s without wall contact (bridged gaps), the run's signed tangent velocity and tangent coordinate
    // before the axis slides (step-arounds), the metres stepped off the wall on X / Z (camera smoothing) and
    // the tangent coordinate where the last stepped-around voxel begins (null: none on this run)
    wallGap: 0, wallTan: 0, wallFrom: 0, shiftX: 0, shiftZ: 0, wallStepAt: null,
    // per-step inputs (pilotPreStep) read by the later hooks
    press: false, hold: false, crouchHeld: false, wishX: 0, wishZ: 0, env: 0,
    wantDouble: false, jumped: 0, landT: 0, air: false, slideAir: 0, prevY: null, jumpSeqSync: false };
}

/** Clears wallrun, slide and grapple (vault, ride, movement lock, death). Counters and cooldowns stay. */
export function resetPilotMotion(state) {
  if (!state) return;
  state.wall = 0; state.wallT = 0; state.slideT = 0; state.slideAir = 0; state.grapple = null;
  state.wantDouble = false; state.press = false; state.landT = 0;
}

/**
 * Jump-press sequence (§3.6 `jumpSeq`, uint8): true once for every press the
 * authority has not consumed yet. The first value seen (or `syncOnly`) only syncs.
 */
export function pilotJumpSeq(state, seq, syncOnly = false) {
  if (!state || !Number.isInteger(seq)) return false;
  const value = seq & 255;
  if (syncOnly || !state.jumpSeqSync) {
    state.jumpSeqAck = value;
    state.jumpSeqSync = true;
    return false;
  }
  if (state.jumpSeqAck === value) return false;
  state.jumpSeqAck = (state.jumpSeqAck + 1) & 255;
  return true;
}

/** Movement kind for the `tf[0]` row (TITAN_MV ids: 0 ground, 1 sprint, 2 slide, 3 wallrun, 4 air, 5 grapple). */
export function pilotMoveKind(state, body) {
  if (state?.grapple) return 5;
  if (state?.wall) return 3;
  if (state?.slideT > 0) return 2;
  if (body?.grounded === false) return 4;
  return body?.sprint ? 1 : 0;
}

/** Speed target for this step (input: {sprint, crouch, ads, stim}). Stock modifiers (prone, swim, concussion) scale it. */
export function pilotSpeedFor(state, input, base) {
  const stock = input?.crouch ? PHYSICS.crouch : input?.sprint ? PHYSICS.sprint : PHYSICS.walk;
  const pilot = input?.crouch ? R.crouch : input?.sprint ? R.sprint : R.walk;
  let speed = base === stock ? pilot : base * (pilot / stock);
  if (input?.stim) speed *= R.stim.speedMul;
  return speed;
}

/** wallJump.decay ^ (wall-jumps since the last ground): every lift a chain gets shrinks with it. */
function chainDecay(state) {
  let decay = 1;
  for (let i = 0; i < state.chain; i++) decay *= WJ.decay;
  return decay;
}

/** The vy that just reaches lastGroundY + wallrun.maxRise (chains climb no higher), never past it in one step. */
function chainLift(state, body, dt) {
  if (state.lastGroundY === null) return Infinity;
  const room = Math.max(0, state.lastGroundY + W.maxRise - body.y);
  return Math.min(Math.sqrt(2 * GRAVITY * room), dt > 0 ? room / dt : Infinity);
}

const axisOf = wall => (wall === 1 || wall === -1 ? 'x' : 'z');
const tangentOf = wall => (wall === 1 || wall === -1 ? 'z' : 'x');

function endWall(state, spent) {
  if (spent && state.wall) { state.wallSpentN = state.wall; state.wallSpentPlane = state.wallPlane; }
  state.wall = 0;
  state.wallT = 0;
  state.wallGap = 0;
}

/**
 * After the jump edge. input = { jump (held), jumpPressed, crouch, wishX, wishZ, yaw, bot, ladder, swim }
 * (the frozen stub call `{ keys, jumpPressed, ... }` is accepted too). Returns true when it consumed the press.
 */
export function pilotPreStep(state, body, input, ctx, dt) {
  const hold = input?.jump ?? !!input?.keys?.jump;
  const crouch = input?.crouch ?? !!input?.keys?.crouch;
  state.press = !!input?.jumpPressed;
  state.hold = !!hold;
  state.crouchHeld = !!crouch;
  state.wishX = Number.isFinite(input?.wishX) ? input.wishX : 0;
  state.wishZ = Number.isFinite(input?.wishZ) ? input.wishZ : 0;
  state.env = (input?.bot ? 1 : 0) | (input?.ladder ? 2 : 0) | (input?.swim ? 4 : 0);
  state.jumped = 0;
  state.wantDouble = false;

  // Slide: sprint speed plus crouch on the ground; a jump or a long fall ends it.
  const h = Math.hypot(body.vx, body.vz);
  if (state.slideT > 0) {
    if (!body.grounded) state.slideAir += dt; else state.slideAir = 0;
    if (!crouch || h < S.endSpeed || state.slideAir > S.airGrace || state.wall || state.grapple || (state.env & 6)) {
      state.slideT = 0;
      state.slideAir = 0;
    }
  }
  if (state.slideT === 0 && body.grounded && crouch && h >= S.minSpeed && !state.wall && !state.grapple && !(state.env & 6)) {
    if (state.slideCd <= 0 && h <= R.sprint + S.boostSlack) {
      const scale = (h + S.boost) / h;
      body.vx *= scale;
      body.vz *= scale;
      state.slideCd = S.cooldown;
    }
    state.slideT = dt > 0 ? dt : 1e-3;
    state.slideAir = 0;
  }

  if (!state.press) return false;
  if (state.grapple) {
    state.grapple = null;
    state.press = false;
    return true;
  }
  if (state.wall) {
    const n = state.wall > 0 ? 1 : -1, ax = axisOf(state.wall), tx = tangentOf(state.wall);
    const decay = chainDecay(state);
    // Out and forward: the run's speed plus a boost, aimed by the wish between minOut and maxOut off the wall.
    const t = tx === 'x' ? body.vx : body.vz, dir = t >= 0 ? 1 : -1;
    let out = WJ.minOut;
    if (state.wishX !== 0 || state.wishZ !== 0) {
      const wishOut = (ax === 'x' ? state.wishX : state.wishZ) * n, wishAlong = (tx === 'x' ? state.wishX : state.wishZ) * dir;
      out = Math.max(WJ.minOut, Math.min(WJ.maxOut, Math.atan2(wishOut, wishAlong)));
    }
    const speed = Math.min(R.clamp, Math.max(Math.abs(t), W.speed) + WJ.boost);
    const along = dir * speed * Math.cos(out), off = n * speed * Math.sin(out);
    if (ax === 'x') { body.vx = off; body.vz = along; } else { body.vz = off; body.vx = along; }
    body.vy = Math.min(WJ.vy * decay, chainLift(state, body, dt));
    body.grounded = false;
    body.coyote = 0;
    state.chain++;
    state.jumpsLeft = 1;
    state.wallLock = WJ.lockout;
    state.wallLockN = state.wall;
    state.wallLockPlane = state.wallPlane;
    // The jumped-off wall stays spent until ground or another wall: no surfing one wall.
    endWall(state, true);
    state.slideT = 0;
    state.jumped = 2;
    state.press = false;
    return true;
  }
  // Airborne press: a ledge grab (the integrator's vault) wins; pilotVertical
  // spends the double jump only when no vault started.
  if (!body.grounded && !(body.coyote > 0) && state.jumpsLeft > 0) state.wantDouble = true;
  return false;
}

/** wish = { x, z, speed, accel (stock blend factor), ladder?, swim? }. Returns true when it replaced the stock blend. */
export function pilotAccel(state, body, wish, ctx, dt) {
  if (wish?.ladder || wish?.swim || (state.env & 6)) return false;
  const wx = wish.x, wz = wish.z;
  if (state.grapple) return true;
  if (state.wall) {
    const n = state.wall > 0 ? 1 : -1, ax = axisOf(state.wall), tx = tangentOf(state.wall);
    const away = (ax === 'x' ? wx : wz) * n;
    if (away > W.detachDot) {
      if (ax === 'x') body.vx = n * W.detachPush; else body.vz = n * W.detachPush;
      endWall(state, true);
    } else {
      const t = tx === 'x' ? body.vx : body.vz;
      const dir = t >= 0 ? 1 : -1;
      // Running along the wish builds speed toward `top`; no wish coasts, a wish back brakes.
      const along = (tx === 'x' ? wx : wz) * dir;
      if (along > 0.25) { if (state.wallSpeed < W.top) state.wallSpeed = Math.min(W.top, state.wallSpeed + W.accel * dt); }
      else if (wx === 0 && wz === 0) state.wallSpeed = Math.max(0, state.wallSpeed - W.coast * dt);
      else if (along < -0.25) state.wallSpeed = Math.max(0, state.wallSpeed - 2 * W.coast * dt);
      const next = t + (dir * state.wallSpeed - t) * (1 - Math.exp(-W.blend * dt));
      // In contact the hull is pulled flush (a recessed wall is reached in a few ticks).
      const gap = state.wallGap > 0 ? 0 : wallGapOf(body, state);
      const pull = gap > 0.001 ? -n * Math.min(W.stick, gap / dt) : 0;
      if (tx === 'x') { body.vx = next; body.vz = pull; } else { body.vz = next; body.vx = pull; }
      state.wallTan = next;
      state.wallFrom = tx === 'x' ? body.x : body.z;
      return true;
    }
  }
  const h = Math.hypot(body.vx, body.vz);
  // Hop window: after a landing the speed is kept for a fresh jump press (or while
  // jump is up, waiting for one); a jump merely held through the landing gets none.
  const hopKeep = state.landT > 0 && (state.press || !state.hold);
  if (state.slideT > 0 && body.grounded) {
    // Friction along the slide (not inside the landing hop window); the wish turns it slowly.
    if (h > 0) {
      let dx = body.vx / h, dz = body.vz / h;
      if (wx !== 0 || wz !== 0) {
        const cross = dx * wz - dz * wx, dot = dx * wx + dz * wz;
        const turn = Math.max(-S.steer * dt, Math.min(S.steer * dt, Math.atan2(cross, dot)));
        const c = Math.cos(turn), s = Math.sin(turn);
        const ndx = dx * c - dz * s, ndz = dx * s + dz * c;
        dx = ndx; dz = ndz;
      }
      const speed = hopKeep ? h : Math.max(0, h - S.friction * dt);
      body.vx = dx * speed;
      body.vz = dz * speed;
    }
    return true;
  }
  if (body.grounded) {
    if (hopKeep && h > wish.speed) {
      // Hop window: a fresh landing keeps its momentum and only steers.
      if (wx !== 0 || wz !== 0) {
        const nx = body.vx + (wx * h - body.vx) * wish.accel, nz = body.vz + (wz * h - body.vz) * wish.accel;
        const nh = Math.hypot(nx, nz);
        if (nh > 0) { body.vx = nx * (h / nh); body.vz = nz * (h / nh); }
      }
      return true;
    }
    body.vx += (wx * wish.speed - body.vx) * wish.accel;
    body.vz += (wz * wish.speed - body.vz) * wish.accel;
    return true;
  }
  // Air: Quake-style strafe (only the projected wish speed below airWishCap is
  // added). It turns but never builds speed past the soft cap.
  if (wx !== 0 || wz !== 0) {
    const current = body.vx * wx + body.vz * wz;
    const add = R.airWishCap - current;
    if (add > 0) {
      const gain = Math.min(add, R.airAccel * dt);
      body.vx += gain * wx;
      body.vz += gain * wz;
      const limit = Math.max(h, R.airSoftCap), next = Math.hypot(body.vx, body.vz);
      if (next > limit) {
        body.vx *= limit / next;
        body.vz *= limit / next;
      }
    }
  }
  // The soft drag spares a wall-jump chain: walls build momentum, hops and slides do not.
  const air = Math.hypot(body.vx, body.vz);
  if (air > R.airSoftCap && state.chain === 0) {
    const next = Math.max(R.airSoftCap, air - R.airDrag * dt);
    body.vx *= next / air;
    body.vz *= next / air;
  }
  return true;
}

/** Ground jump, double jump, wallrun gravity, grapple pull and gravity. Returns true when it replaced stock gravity. */
export function pilotVertical(state, body, ctx, dt) {
  if (state.env & 6) return false;
  if (state.grapple) {
    const [ax, ay, az] = state.grapple.anchor;
    const dx = ax - body.x, dy = ay - (body.y + G.chest), dz = az - body.z;
    const d = Math.hypot(dx, dy, dz);
    if (d > 1e-6) {
      const k = G.accel * dt / d;
      body.vx += dx * k;
      body.vy += dy * k;
      body.vz += dz * k;
    }
    body.vy -= GRAVITY * G.gravityMul * dt;
    // A hook above the chest lifts a grounded pilot off the floor instead of dragging the feet.
    if ((body.grounded || body.coyote > 0) && dy > 0 && body.vy < G.lift) body.vy = G.lift;
    const s = Math.hypot(body.vx, body.vy, body.vz);
    if (s > G.cap) {
      const k = G.cap / s;
      body.vx *= k; body.vy *= k; body.vz *= k;
    }
    if (body.vy > 0.01) { body.grounded = false; body.coyote = 0; }
    return true;
  }
  if (state.wall) {
    // Low gravity that ramps up toward the end of the run: a slow sink, then the grip goes.
    const k = Math.min(1, state.wallT / W.seconds);
    const vy = Math.max(TERMINAL_VY, body.vy - (W.gravity + (W.gravityEnd - W.gravity) * k * k) * dt);
    body.vy = vy > 0 ? Math.min(vy, chainLift(state, body, dt)) : vy;
    return true;
  }
  if ((state.hold || state.press) && (body.grounded || body.coyote > 0) && body.vy <= 0.01) {
    body.vy = PHYSICS.jump;
    body.grounded = false;
    body.coyote = 0;
    state.jumped = 1;
    // A slide-hop leaves the slide with its speed.
    state.slideT = 0;
    state.slideAir = 0;
  } else if (state.wantDouble && state.jumpsLeft > 0 && !body.grounded) {
    // After wall-jumps the double jump decays with the chain too, so walls
    // that hand it back cannot keep a pilot up for ever.
    const decay = chainDecay(state);
    body.vy = state.chain > 0 ? Math.min(R.doubleJumpVy * decay, chainLift(state, body, dt)) : R.doubleJumpVy * decay;
    state.jumpsLeft--;
    state.jumped = 3;
    const wx = state.wishX, wz = state.wishZ;
    if (wx !== 0 || wz !== 0) {
      const speed = Math.max(Math.hypot(body.vx, body.vz), R.doubleJumpH);
      body.vx = wx * speed;
      body.vz = wz * speed;
    }
  }
  state.wantDouble = false;
  body.vy = Math.max(TERMINAL_VY, body.vy - GRAVITY * dt);
  return true;
}

const solid = (ctx, x, y, z) => !!ctx.solidAt(Math.floor(x), Math.floor(y), Math.floor(z));

/** True when a clear line runs from the pilot's head to the grapple anchor (voxels only). */
export function grappleLineClear(ctx, body, anchor) {
  const ox = body.x, oy = body.y + G.head, oz = body.z;
  const dx = anchor[0] - ox, dy = anchor[1] - oy, dz = anchor[2] - oz;
  const d = Math.hypot(dx, dy, dz);
  // The anchor sits on a voxel face; stop short of it.
  const steps = Math.floor((d - 0.6) / G.losStep);
  for (let i = 1; i <= steps; i++) {
    const t = (i * G.losStep) / d;
    if (solid(ctx, ox + dx * t, oy + dy * t, oz + dz * t)) return false;
  }
  return true;
}

/** The wall's plane cell when a wall with outward normal `code` is within the probe at all three heights, else false. */
function probeWall(ctx, body, code) {
  const ax = axisOf(code), n = code > 0 ? 1 : -1;
  // The wall lies opposite its outward normal.
  const reach = ax === 'x' ? body.x - n * (HALF_W + W.probe) : body.z - n * (HALF_W + W.probe);
  const plane = Math.floor(reach);
  for (let i = 0; i < WALL_HEIGHTS.length; i++) {
    const y = body.y + WALL_HEIGHTS[i];
    if (ax === 'x' ? !solid(ctx, plane, y, body.z) : !solid(ctx, body.x, y, plane)) return false;
  }
  return plane;
}

/** A wall voxel in plane cell `plane` (outward normal `code`) at any of the probe heights, `along` m ahead on the tangent. */
function wallAt(ctx, body, code, plane, along = 0) {
  const xAxis = axisOf(code) === 'x';
  for (let i = 0; i < WALL_HEIGHTS.length; i++) {
    const y = body.y + WALL_HEIGHTS[i];
    if (xAxis ? solid(ctx, plane, y, body.z + along) : solid(ctx, body.x + along, y, plane)) return true;
  }
  return false;
}

/** Metres between the hull and the face of the run's wall plane (0 when flush). */
function wallGapOf(body, state) {
  const n = state.wall > 0 ? 1 : -1, p = axisOf(state.wall) === 'x' ? body.x : body.z;
  // Outward normal +1: the face is the plane cell's +side (plane + 1); -1: its -side (plane).
  const gap = n > 0 ? p - HALF_W - (state.wallPlane + 1) : state.wallPlane - (p + HALF_W);
  return gap > 0 ? gap : 0;
}

/**
 * Contact upkeep on the run: true while the wall (or a recess one voxel farther, which becomes the
 * run's plane) is at any probe height; otherwise the run coasts for `grace` s if the wall resumes
 * within `bridge` m ahead.
 */
function keepWallContact(ctx, body, state, dt) {
  const code = state.wall, n = code > 0 ? 1 : -1, dir = state.wallTan >= 0 ? 1 : -1;
  // Under the hull's middle or its leading edge (a stepped-around wall starts there).
  if (wallAt(ctx, body, code, state.wallPlane) || wallAt(ctx, body, code, state.wallPlane, dir * HALF_W)) {
    state.wallGap = 0;
    return true;
  }
  if (wallGapOf(body, state) <= W.probe && wallAt(ctx, body, code, state.wallPlane - n)) {
    state.wallPlane -= n;
    state.wallGap = 0;
    return true;
  }
  state.wallGap += dt;
  if (state.wallGap > W.grace) return false;
  for (let d = 1; d <= W.bridge; d++) if (wallAt(ctx, body, code, state.wallPlane, dir * d)) return true;
  return false;
}

/**
 * The run was blocked along the wall. A wall that steps one voxel toward the runner (a pillar, a
 * slight angle) is stepped around: the hull moves one voxel off the wall, finishes the step's travel
 * and keeps the run's speed. Anything deeper (an inner corner, a crate), or a second step within
 * `stepGap` m of the last (a steep voxel staircase), ends the run.
 */
function stepAroundWall(ctx, body, state, dt) {
  const code = state.wall, n = code > 0 ? 1 : -1, ax = axisOf(code), tx = tangentOf(code);
  const dir = state.wallTan >= 0 ? 1 : -1, front = dir * (HALF_W + 0.05);
  const closer = state.wallPlane + n;
  if (!wallAt(ctx, body, code, closer, front) || wallAt(ctx, body, code, closer + n, front)) return false;
  // The stepped voxel's near edge along the run.
  const cell = Math.floor((tx === 'x' ? body.x : body.z) + front), edge = dir > 0 ? cell : cell + 1;
  if (state.wallStepAt !== null && (edge - state.wallStepAt) * dir < W.stepGap) return false;
  const position = { x: body.x, y: body.y, z: body.z };
  if (slidePlayerAxis(position, ax, n, ctx.solidAt)) return false;
  const travelled = (tx === 'x' ? body.x : body.z) - state.wallFrom;
  slidePlayerAxis(position, tx, state.wallTan * dt - travelled, ctx.solidAt);
  // The axis slides also collide with live hulls (a parked titan): a step-around never lands in one.
  for (const vehicle of ctx.vehicles || []) if (playerHullContact(position, vehicle)) return false;
  body.x = position.x;
  body.z = position.z;
  if (tx === 'x') body.vx = state.wallTan; else body.vz = state.wallTan;
  if (ax === 'x') state.shiftX += n; else state.shiftZ += n;
  state.wallPlane = closer;
  state.wallStepAt = edge;
  return true;
}

/** No solid within minAir under the feet at (x, z). */
function airBelow(ctx, body, x, z) {
  for (let d = 0.05; d <= W.minAir + 1e-9; d += 0.35) if (solid(ctx, x, body.y - d, z)) return false;
  return !solid(ctx, x, body.y - W.minAir, z);
}

function tryEnterWall(state, body, ctx) {
  if (state.lastGroundY !== null && body.y > state.lastGroundY + W.maxRise) return;
  if (!airBelow(ctx, body, body.x, body.z)) return;
  const wishing = state.wishX !== 0 || state.wishZ !== 0;
  const steep = Math.tan(W.maxAngle);
  let best = 0, bestPlane = 0, bestTangent = 0;
  for (const code of [1, -1, 2, -2]) {
    const tx = tangentOf(code), ax = axisOf(code), n = code > 0 ? 1 : -1;
    const t = tx === 'x' ? body.vx : body.vz;
    if (Math.abs(t) < W.minTangent || Math.abs(t) <= Math.abs(bestTangent)) continue;
    // Moving along the wall: not away from it, at most maxAngle into it.
    const into = -(ax === 'x' ? body.vx : body.vz) * n;
    if (into < -W.detachPush || into > Math.abs(t) * steep) continue;
    // A wish (if any) not into the wall and not back along the run.
    if (wishing && ((ax === 'x' ? state.wishX : state.wishZ) * n < W.wishDot
      || (tx === 'x' ? state.wishX : state.wishZ) * (t > 0 ? 1 : -1) < -0.5)) continue;
    const plane = probeWall(ctx, body, code);
    if (plane === false) continue;
    if (state.wallLock > 0 && state.wallLockN === code && state.wallLockPlane === plane) continue;
    if (state.wallSpentN === code && state.wallSpentPlane === plane) continue;
    // At least minLength voxels of wall along the run direction.
    const step = t > 0 ? 1 : -1, y = body.y + 1.0;
    let long = true;
    for (let k = 1; k < W.minLength; k++) {
      if (tx === 'z' ? !solid(ctx, plane, y, body.z + step * k) : !solid(ctx, body.x + step * k, y, plane)) { long = false; break; }
    }
    if (!long) continue;
    // Air ahead too (every metre up to `ahead`): a stair climb along a wall never starts a run.
    let clear = true;
    for (let d = 1; d <= W.ahead && clear; d++) clear = tx === 'z' ? airBelow(ctx, body, body.x, body.z + step * d) : airBelow(ctx, body, body.x + step * d, body.z);
    if (!clear) continue;
    best = code; bestPlane = plane; bestTangent = t;
  }
  if (!best) return;
  const ax = axisOf(best), into = Math.max(0, -(ax === 'x' ? body.vx : body.vz) * (best > 0 ? 1 : -1));
  state.wall = best;
  state.wallPlane = bestPlane;
  state.wallT = 0;
  state.wallGap = 0;
  state.wallStepAt = null;
  state.wallTan = bestTangent;
  // Momentum is kept: the tangent plus part of the speed into the wall, never more than the speed it had.
  const h = Math.hypot(body.vx, body.vz);
  state.wallSpeed = Math.min(R.clamp, Math.max(W.speed, Math.min(h, Math.abs(bestTangent) + W.redirect * into)));
  state.jumpsLeft = 1;
  state.slideT = 0;
  if (ax === 'x') body.vx = 0; else body.vz = 0;
  // The catch's pop shrinks with the chain like the jumps do (an alley ping-pong comes down).
  const decay = chainDecay(state);
  body.vy = Math.min(W.entryVy * decay, Math.max(body.vy, W.kick * decay));
}

/** After the axis slides: landing, wallrun probes, grapple release, timers and the horizontal clamp. */
export function pilotPostCollide(state, body, ctx, contacts, dt) {
  state.slideCd = Math.max(0, state.slideCd - dt);
  state.wallLock = Math.max(0, state.wallLock - dt);
  state.landT = Math.max(0, state.landT - dt);
  const swimming = (state.env & 4) !== 0;
  if (body.grounded) {
    if (state.air) state.landT = S.hopWindow;
    if (state.wall) endWall(state, false);
    state.jumpsLeft = 1;
    state.chain = 0;
    state.wallSpentN = 0;
    state.lastGroundY = body.y;
  } else if (swimming) {
    if (state.wall) endWall(state, false);
    state.jumpsLeft = 1;
    state.chain = 0;
    state.lastGroundY = body.y;
  }
  if (state.slideT > 0) {
    state.slideT += dt;
    // Each voxel step climbed mid-slide costs `uphill` m/s.
    if (body.grounded && state.prevY !== null && body.y > state.prevY + 0.25) {
      const h = Math.hypot(body.vx, body.vz);
      if (h > 0) {
        const next = Math.max(0, h - S.uphill * Math.ceil(body.y - state.prevY - 0.25));
        body.vx *= next / h;
        body.vz *= next / h;
      }
    }
  }
  if (state.grapple) {
    const g = state.grapple;
    g.t = (g.t || 0) + dt;
    const [ax, ay, az] = g.anchor;
    const d = Math.hypot(ax - body.x, ay - (body.y + G.chest), az - body.z);
    // Pressed into a ledge below the anchor: climb it (the next step rises over the lip).
    if ((contacts?.x || contacts?.z) && ay > body.y + G.chest && body.vy < G.climb) body.vy = G.climb;
    g.blind = grappleLineClear(ctx, body, g.anchor) ? 0 : (g.blind || 0) + dt;
    if (g.t >= G.seconds || d < G.release || g.blind > G.losGrace) state.grapple = null;
  } else if (state.wall) {
    state.wallT += dt;
    const tx = tangentOf(state.wall);
    const blocked = (tx === 'x' ? contacts?.x : contacts?.z) && !stepAroundWall(ctx, body, state, dt);
    const t = tx === 'x' ? body.vx : body.vz;
    if (state.wallT >= W.seconds || state.crouchHeld || blocked || Math.abs(t) < W.endTangent || !keepWallContact(ctx, body, state, dt)) {
      endWall(state, true);
    }
  } else if (!body.grounded && !swimming && !(state.env & 3)) {
    tryEnterWall(state, body, ctx);
  }
  state.air = !body.grounded;
  state.prevY = body.y;
  if (!state.grapple) {
    const h = Math.hypot(body.vx, body.vz);
    if (h > R.clamp) {
      body.vx *= R.clamp / h;
      body.vz *= R.clamp / h;
    }
  }
  // The client's sub-millimetre velocity snap, here for both sides: pilot
  // prediction and authority stay bit-equal at any tick rate.
  if (Math.abs(body.vx) < 0.001) body.vx = 0;
  if (Math.abs(body.vz) < 0.001) body.vz = 0;
}

/** Collide one axis the way both integrators do (voxels only; zero the velocity on contact). */
function slideAxis(body, axis, amount, ctx) {
  const position = { x: body.x, y: body.y, z: body.z };
  const hit = slidePlayerAxis(position, axis, amount, ctx.solidAt);
  body[axis] = position[axis];
  if (hit) body[`v${axis}`] = 0;
  return hit;
}

/**
 * The whole pilot step on its own (parity test and tuning sims): the hooks plus
 * voxel collision and ground bookkeeping in the integrators' order. input =
 * { jump, jumpPressed, crouch, sprint, stim, wishX, wishZ, yaw, base? }, ctx = { solidAt }.
 * Returns the step's jump kind (0 none, 1 ground, 2 wall, 3 double).
 */
export function stepPilot(state, body, input, ctx, dt) {
  if (body.coyote > 0) body.coyote = Math.max(0, body.coyote - dt);
  pilotPreStep(state, body, input, ctx, dt);
  const sprint = !!input.sprint && !input.crouch;
  const base = Number.isFinite(input.base) ? input.base : input.crouch ? PHYSICS.crouch : sprint ? PHYSICS.sprint : PHYSICS.walk;
  const speed = pilotSpeedFor(state, { sprint, crouch: !!input.crouch, stim: !!input.stim }, base);
  const accel = 1 - Math.exp(-(body.grounded ? PHYSICS.accelGround : PHYSICS.accelAir) * dt);
  pilotAccel(state, body, { x: state.wishX, z: state.wishZ, speed, accel }, ctx, dt);
  pilotVertical(state, body, ctx, dt);
  const hitX = slideAxis(body, 'x', body.vx * dt, ctx);
  const hitZ = slideAxis(body, 'z', body.vz * dt, ctx);
  const dy = body.vy * dt;
  const hitY = slideAxis(body, 'y', dy, ctx);
  if (hitY && dy < 0) body.grounded = true;
  else if (body.vy <= 0.001 && solidBelow(ctx.solidAt, body.x, body.y, body.z)) { body.grounded = true; body.vy = 0; }
  else { if (body.grounded) body.coyote = MOVEMENT_RULES.coyoteS; body.grounded = false; }
  pilotPostCollide(state, body, ctx, { x: hitX, z: hitZ, y: hitY, dy }, dt);
  return state.jumped;
}
export const PILOT_STATE_KEYS = Object.freeze(['wall', 'wallT', 'jumpsLeft', 'slideT', 'slideCd', 'grapple', 'tac']);
