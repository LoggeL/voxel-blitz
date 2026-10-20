/**
 * Engineer FPV kamikaze drone (Conquest, contract v7): the deployable's rules,
 * its flight model, the signal curve and the row codec. The Engineer with
 * gadget 2 (KITS.engineer.gadgets) sends the `fpv` intent: the server launches
 * an `fpv` hull above him (server/sim/fpv-drones.js) and from then on reads
 * his ordinary input as the drone's controls while his body crouches where it
 * stood. The drone carries a shaped charge that goes off on impact or on the
 * trigger through the projectile system's explosion path (kill key `fpv`).
 * Pure data and pure math, shared by the server, the bots and the client feed,
 * so the HUD's signal bars and the server's link loss read the same curve.
 *
 * Flight is mouse-aim: the drone faces where the operator looks (input yaw
 * and pitch), W drives it along that line (pitch down and W dives), S brakes
 * and backs off, A/D slide sideways, jump climbs, crouch sinks. With no key
 * held it brakes to a hover. The battery and the link carry it; past either
 * it drops like a stone and the charge fires `cutFuseMs` later.
 */
const freeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
};
const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));

/**
 * Kit and lifecycle. `drones` per life; a Support aura hands one back at most
 * every `resupplyMs` (never past `drones`). A new launch waits `relaunchMs`
 * after the last drone ended. The drone spawns `launchUp` m over the
 * operator's feet and `launchForward` m ahead along his look, climbing at
 * `launchSpeed` m/s; contact with the ground or a body only fires the charge
 * once `armMs` have passed. Taking damage or a second press of the gadget key
 * cuts the link: the drone falls and fires `cutFuseMs` later.
 */
export const FPV_RULES = freeze({
  type: 'fpv', killKey: 'fpv', gadget: 2,
  drones: 2, resupplyMs: 30000, relaunchMs: 1500,
  launchUp: 2.1, launchForward: 0.6, launchSpeed: 4, armMs: 500,
  cutFuseMs: 1000,
  hp: 8,
  /** Battery (ms of flight) and the radio link (m from the operator's body). */
  batteryMs: 40000,
  signal: Object.freeze({ range: 350, degradeFrom: 250, bars: 4 }),
  /**
   * Flight (m, m/s, m/s²). `topSpeed` along the look, `strafeSpeed` sideways,
   * `climbSpeed` up and down, `reverse` the share of topSpeed S backs off at.
   * The frame reaches its wish at `accel` and brakes to a hover at `brake`;
   * an unpowered drone falls with `gravity` and `dragFall`.
   */
  flight: Object.freeze({ topSpeed: 28, strafeSpeed: 14, climbSpeed: 10, reverse: 0.35, accel: 24, brake: 12,
    gravity: 9.81, dragFall: 0.4, pitchLimit: 1.4,
    // Presentation attitude: the frame noses down with forward speed and banks into slides and turns.
    tilt: 0.45, bank: 0.55, yawBank: 0.08 }),
  /** Contact: a voxel at `impactSpeed` m/s or more fires the charge (slower it only stops); bodies within `bodyRadius`. */
  impactSpeed: 5, bodyRadius: 0.55,
  /**
   * The shaped charge. `direct` lands on the struck hull at the `at` class
   * (the RX-8's class, so the tank's thin roof, engine deck and rear plates
   * are the bonus: two drones on the top or the rear kill a tank) times
   * `armor[class]` (an airframe takes ×2.1, so one drone kills a helicopter
   * or a transport); `splash` reaches hulls within `radius` m. Infantry take
   * `infantry` at the centre, falling linearly to 0 at `radius` (after the
   * ×0.8 combat scale: lethal within 2 m, about 55 at 3 m). The crater is
   * the RX-8's size.
   */
  charge: Object.freeze({ direct: 400, splash: 60, radius: 4, infantry: 280, infantryDirect: 120,
    armor: Object.freeze({ light: 1, medium: 1, heavy: 1, air: 2.1, drone: 1 }),
    terrainRadius: 1.8, terrainPower: 110, maxDestroyedBlocks: 18, knockback: 12 }),
  /** The mobile AA's radar shows a drone inside this range (it never takes a STINGER lock). */
  radarRange: 150,
  /** HUD: the feed's horizontal field of view (degrees) and the static floor once the link degrades. */
  fov: 104,
});

/**
 * Bots: `share` of a team's engineers (stable by id) deploy with the drone.
 * Every `checkMs` one on foot and out of a fight looks for a target: an enemy
 * armoured or crewed hull `minRange`..`maxRange` m away (with chance
 * `hullChance`), else, rarely (`clusterChance`), `minCluster`+ enemies within
 * `clusterRadius` m of each other on a fought-over flag. The flight climbs to
 * `cruise` m over the target, closes in until it is within `diveRatio` of its
 * height away, then dives at the top of the target; it gives up (and dives at
 * whatever is below) when the battery falls under `bingoMs`. Any bot shoots an
 * enemy drone in sight within `shootRange` m (`closeRange` m even mid-fight).
 */
export const FPV_BOT_RULES = freeze({
  share: 0.34, checkMs: 4000, hullChance: 0.6, clusterChance: 0.12,
  minRange: 60, maxRange: 300, clusterRadius: 7, minCluster: 3,
  cruise: 24, diveRatio: 1.15, bingoMs: 6000, retargetMs: 500,
  shootRange: 70, closeRange: 35, scanMs: 400, giveUpMs: 4000, fireError: 0.06,
});

/**
 * Signal of a link `distance` m long: quality 1 out to `degradeFrom`, falling
 * linearly to 0 at `range`; `bars` 0..signal.bars; `lost` past the range.
 */
export function fpvSignal(distance, rules = FPV_RULES) {
  const s = rules.signal, d = finite(distance, Infinity);
  const quality = d <= s.degradeFrom ? 1 : d >= s.range ? 0 : 1 - (d - s.degradeFrom) / (s.range - s.degradeFrom);
  return { quality, bars: d > s.range ? 0 : Math.max(1, Math.ceil(quality * s.bars)), degraded: d > s.degradeFrom, lost: d > s.range };
}

/** Unit look vector of a yaw / pitch (yaw 0 faces -Z, positive yaw turns toward -X). */
export function fpvLook(yaw, pitch) {
  const c = Math.cos(pitch);
  return [-Math.sin(yaw) * c, Math.sin(pitch), -Math.cos(yaw) * c];
}

/**
 * The control wish of one input frame: `{ forward, strafe, lift, yaw, pitch }`
 * from input keys `{f, b, l, r, jump, crouch}` (the server's input frame).
 */
export function fpvControls(input) {
  const k = input?.keys ?? {};
  return {
    forward: (k.f ? 1 : 0) - (k.b ? 1 : 0),
    strafe: (k.r ? 1 : 0) - (k.l ? 1 : 0),
    lift: (k.jump ? 1 : 0) - (k.crouch ? 1 : 0),
    yaw: finite(input?.yaw),
    pitch: clamp(finite(input?.pitch), -FPV_RULES.flight.pitchLimit, FPV_RULES.flight.pitchLimit),
  };
}

/** Wish velocity [vx, vy, vz] of a control wish (forward along the look, slides along the flat right, lift straight up). */
export function fpvWishVelocity(controls, rules = FPV_RULES) {
  const f = rules.flight, look = fpvLook(controls.yaw, controls.pitch);
  const along = controls.forward > 0 ? f.topSpeed : controls.forward < 0 ? -f.topSpeed * f.reverse : 0;
  const right = [Math.cos(controls.yaw), 0, -Math.sin(controls.yaw)];
  const v = [0, 1, 2].map(i => look[i] * along + right[i] * controls.strafe * f.strafeSpeed);
  v[1] += controls.lift * f.climbSpeed;
  const speed = Math.hypot(...v);
  return speed > f.topSpeed ? v.map(n => n * f.topSpeed / speed) : v;
}

/**
 * One flight step of a drone `{vx, vy, vz}` (mutated) over `dt` s. Powered,
 * the velocity moves toward the wish at `accel` (toward a hover at `brake`);
 * unpowered, gravity and drag take over. Returns the new velocity.
 */
export function stepFpvVelocity(drone, controls, dt, powered = true, rules = FPV_RULES) {
  const f = rules.flight, v = [finite(drone.vx), finite(drone.vy), finite(drone.vz)];
  if (!powered) {
    const keep = Math.exp(-f.dragFall * dt);
    v[0] *= keep; v[2] *= keep; v[1] = v[1] * keep - f.gravity * dt;
  } else {
    const wish = fpvWishVelocity(controls, rules);
    const idle = !controls.forward && !controls.strafe && !controls.lift;
    const delta = wish.map((n, i) => n - v[i]), gap = Math.hypot(...delta);
    const step = (idle ? f.brake : f.accel) * dt;
    const k = gap > step ? step / gap : 1;
    for (let i = 0; i < 3; i++) v[i] += delta[i] * k;
  }
  [drone.vx, drone.vy, drone.vz] = v;
  return v;
}

/**
 * Presentation attitude of a drone flying `velocity` with look yaw `yaw`: the
 * frame noses down with its forward speed and banks with its sideways speed
 * and the yaw rate. Returns { pitch, roll }.
 */
export function fpvAttitude(velocity, yaw, yawRate = 0, rules = FPV_RULES) {
  const f = rules.flight;
  const forward = -(velocity[0] * Math.sin(yaw) + velocity[2] * Math.cos(yaw));
  const side = velocity[0] * Math.cos(yaw) - velocity[2] * Math.sin(yaw);
  return { pitch: clamp(-f.tilt * forward / f.topSpeed, -0.6, 0.6), roll: clamp(-f.bank * side / f.topSpeed - f.yawBank * finite(yawRate), -0.7, 0.7) };
}

/** Drone link states on the wire (`fpv[1]`): flying, link cut (falling, the fuse burning). */
export const FPV_LINK = freeze({ live: 0, cut: 1 });

/**
 * Snapshot extras of an `fpv` row: `own` (the operator's id, as on the
 * mortar) and `fpv = [batteryPct, link, look100?]`: battery left 0..100, the
 * FPV_LINK state and, while flying, the operator's look pitch ×100 (the
 * client's camera for spectators and the operator's own reconnect).
 */
export function encodeFpvRow(drone, now) {
  const battery = Math.round(clamp((finite(drone.batteryUntil) - now) / FPV_RULES.batteryMs, 0, 1) * 100);
  const link = drone.cutAt != null ? FPV_LINK.cut : FPV_LINK.live;
  return link === FPV_LINK.live ? [battery, link, Math.round(finite(drone.lookPitch) * 100)] : [battery, link];
}

/** `{ battery: 0..1, link: 'live'|'cut', lookPitch, ownerId }` of a row, or null for another type. */
export function decodeFpvRow(row) {
  if (row?.type !== FPV_RULES.type) return null;
  const f = Array.isArray(row.fpv) ? row.fpv : [];
  return { battery: clamp(finite(f[0], 100) / 100, 0, 1), link: f[1] === FPV_LINK.cut ? 'cut' : 'live',
    lookPitch: finite(f[2]) / 100, ownerId: row.own != null ? String(row.own) : null };
}

/** The live drone row `ownerId` flies among `vehicles` (snapshot rows), or null. */
export function fpvRowOf(vehicles, ownerId) {
  if (ownerId == null) return null;
  for (const row of vehicles ?? []) {
    if (row?.type === FPV_RULES.type && String(row.own) === String(ownerId) && row.hp > 0) return row;
  }
  return null;
}

/** Drones left on a player row (`cqf`, only on an Engineer with the FPV gadget), else null. */
export const fpvDronesOf = self => Number.isInteger(self?.cqf) ? self.cqf : null;
