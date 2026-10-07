/**
 * Conquest airborne rules shared by the authority (server/sim/movement.js) and
 * client prediction (public/js/player-physics.js): fall damage, the parachute
 * and the jet's ejection seat. Every number is data; change it here.
 *
 * Chute state on a body (`chute`, snapshot `cq[7]`, omitted at 0):
 *   0 none, 1 canopy open, 2 riding the ejection seat (`chuteT` seconds left,
 *   then the canopy opens by itself).
 */
import { GRAVITY } from './combatmath.js';

export const CHUTE = Object.freeze({ none: 0, open: 1, seat: 2 });

/**
 * Landing damage from the vertical impact speed (gravity 24 m/s²): a fall of
 * h metres lands at sqrt(48·h). Jumps, stairs and 3-4 m terrace drops (even
 * jumped off, +1.4 m apex) stay under `safeSpeed` (≈5.7 m); 10 m lands at
 * 21.9 m/s (≈54 damage); 15 m (26.8 m/s) or more is lethal. Water at least `waterDepth` blocks deep under
 * the landing point cushions the fall completely. A fall within `creditMs` of
 * enemy damage credits that enemy.
 */
export const FALL_DAMAGE = Object.freeze({ safeSpeed: 16.5, lethalSpeed: 26.5, maxDamage: 100, waterDepth: 2, creditMs: 5000 });

/**
 * Parachute: Jump while falling with at least `minHeight` metres of air below
 * opens it; Jump again cuts it; landing, water or a ladder closes it. The
 * canopy sinks at `descent` m/s, glides `glide` m/s along the look direction
 * and the movement keys add up to `steer` m/s. No weapon fires under it.
 * Bots open it on their own once the remaining fall would hurt (`botMinHeight`).
 */
export const PARACHUTE = Object.freeze({
  descent: 5, verticalResponse: 3, glide: 3, steer: 4, horizontalResponse: 1.2,
  minHeight: 6, botMinHeight: 2.5, botOpenSpeed: 10, scanDepth: 64,
});

/**
 * Jet ejection seat: the pilot leaves along the airframe's up axis (blended with
 * world up) at `launchSpeed`, keeps `carry` of the jet's velocity (at most
 * `maxCarry` m/s horizontally), rides the seat for `seatSeconds`, then the
 * canopy opens automatically. Only hull types listed in `types` have one.
 */
export const EJECTION = Object.freeze({ types: Object.freeze(['plane']), seatSeconds: 1, launchSpeed: 26, carry: 0.6, maxCarry: 30, rocketSeconds: 0.6 });

/** Damage for a landing at `speed` m/s downward (0 when safe). */
export function fallDamage(speed) {
  const { safeSpeed, lethalSpeed, maxDamage } = FALL_DAMAGE;
  if (!(speed > safeSpeed)) return 0;
  return Math.min(maxDamage, maxDamage * (speed - safeSpeed) / (lethalSpeed - safeSpeed));
}

/** Free height under feet at (x, y, z): distance to the first solid or fluid
 * top below, Infinity when nothing is found within `depth` blocks. */
export function groundClearance(solidAt, fluidAt, x, y, z, depth = PARACHUTE.scanDepth) {
  if (![x, y, z].every(Number.isFinite)) return 0;
  const bx = Math.floor(x), bz = Math.floor(z), top = Math.floor(y - 1e-4);
  for (let by = top; by >= top - depth; by--) {
    if (by < 0) return y;
    if (solidAt(bx, by, bz) || (typeof fluidAt === 'function' && fluidAt(bx, by, bz))) return y - (by + 1);
  }
  return Infinity;
}

/** Fluid blocks stacked from the landing block upward (water landing depth). */
export function waterDepthAt(fluidAt, x, y, z, max = FALL_DAMAGE.waterDepth) {
  if (typeof fluidAt !== 'function') return 0;
  const bx = Math.floor(x), bz = Math.floor(z);
  let depth = 0;
  for (let by = Math.floor(y + 0.05); depth < max && fluidAt(bx, by, bz); by++) depth++;
  return depth;
}

/**
 * One step of the chute state machine (pure; both sides run it identically).
 * `body` = { chute, chuteT, grounded, vy, x, y, z }; returns the next
 * { chute, chuteT, toggled }. `blocked` (swimming, ladder, slide, vault)
 * closes the chute; `jumpPressed` toggles it for players, `auto` (bots) opens
 * it once a fall would hurt.
 */
export function stepChuteState(body, { jumpPressed = false, blocked = false, auto = false, dt = 0, solidAt, fluidAt } = {}) {
  let chute = body.chute | 0, chuteT = Number.isFinite(body.chuteT) ? body.chuteT : 0, toggled = false;
  if (chute === CHUTE.seat) {
    chuteT -= dt;
    if (chuteT <= 0) { chute = CHUTE.open; chuteT = 0; toggled = true; }
  }
  if (blocked || body.grounded) return { chute: CHUTE.none, chuteT: 0, toggled: chute !== CHUTE.none };
  if (chute === CHUTE.seat) return { chute, chuteT, toggled };
  if (auto) {
    if (chute === CHUTE.none && body.vy < -PARACHUTE.botOpenSpeed) {
      const clearance = groundClearance(solidAt, fluidAt, body.x, body.y, body.z);
      const impact = Math.sqrt(body.vy * body.vy + 2 * GRAVITY * Math.min(clearance, 200));
      if (clearance >= PARACHUTE.botMinHeight && impact > FALL_DAMAGE.safeSpeed) return { chute: CHUTE.open, chuteT: 0, toggled: true };
    }
    return { chute, chuteT, toggled };
  }
  if (!jumpPressed) return { chute, chuteT, toggled };
  if (chute === CHUTE.open) return { chute: CHUTE.none, chuteT: 0, toggled: true };
  if (groundClearance(solidAt, fluidAt, body.x, body.y, body.z) >= PARACHUTE.minHeight) return { chute: CHUTE.open, chuteT: 0, toggled: true };
  return { chute, chuteT, toggled };
}

/** True when Jump would open a chute right now (HUD prompt). */
export function chuteAvailable(body, solidAt, fluidAt) {
  return !body.grounded && (body.chute | 0) === CHUTE.none
    && groundClearance(solidAt, fluidAt, body.x, body.y, body.z) >= PARACHUTE.minHeight;
}

/**
 * Canopy flight velocity for one step: sink toward `descent`, glide along the
 * look yaw and steer with the normalized wish direction (wx, wz).
 * `vel` = { x, y, z } is updated in place.
 */
export function stepChuteVelocity(vel, yaw, wx, wz, dt) {
  const v = 1 - Math.exp(-PARACHUTE.verticalResponse * dt), h = 1 - Math.exp(-PARACHUTE.horizontalResponse * dt);
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
  const tx = fx * PARACHUTE.glide + wx * PARACHUTE.steer, tz = fz * PARACHUTE.glide + wz * PARACHUTE.steer;
  vel.y += (-PARACHUTE.descent - vel.y) * v;
  vel.x += (tx - vel.x) * h;
  vel.z += (tz - vel.z) * h;
  return vel;
}
