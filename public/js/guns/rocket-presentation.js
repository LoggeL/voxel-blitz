// RX-8 HAVOC presentation: ammo authority on the seated warhead and the
// fraction-driven breech/reload choreography. Gameplay state never lives here;
// `authoritativeMag` is copied from WeaponState, and animation completion alone
// never grants a warhead. The first-person rig and the remote avatar mount both
// call syncRocketAmmo(), so they agree on what is chambered.

/** The seated HAVOC warhead shows when loaded or after the reload shove reaches its seat. */
export function syncRocketAmmo(rocket, mag) {
  if (!rocket) return;
  rocket.authoritativeMag = Math.max(0, Math.trunc(Number(mag) || 0));
  if (rocket.chambered) {
    rocket.chambered.visible = (rocket.reloading && rocket.seated)
      || (!rocket.reloading && rocket.authoritativeMag > 0);
  }
}

/** Restore the gate, the traveling round and ammo authority to their rest pose. */
export function resetRocketReload(rocket) {
  if (!rocket) return;
  rocket.reloading = false;
  rocket.seated = false;
  rocket.gate.position.copy(rocket.hinge);
  rocket.gate.rotation.set(0, 0, 0);
  syncRocketAmmo(rocket, rocket.authoritativeMag);
}

/**
 * RX-8 HAVOC reload staging, all six beats under the camera: PRESENT the
 * breech, OPEN the blast brake by hand on its left-flank pin, LOAD the round
 * up from lower-right clear of the open gate, SEAT it with an accelerating
 * shove along the bore axis, CLOSE the gate by hand again and latch it, COCK
 * the arming lever. One support hand runs the gate and the round the whole
 * way. The choreography is a pure function of `frac`; the rest pose is owned
 * by resetRocketReload().
 */
export class RocketPresentation {
  constructor(actions) {
    this.actions = actions;
  }

  update(frac, model, out) {
    const actions = this.actions;
    const reload = actions._reload;
    const timeline = model.T.magTimeline;
    const parts = model.extra.userData.rocketReload;
    // PRESENT: turn the breech toward the camera from 0.02 so every later action
    // happens under the lens — the gate opens on the LEFT flank (the side facing
    // the lens), so the gun yaws its rear in, rides a little left and low, and
    // rolls its top away so the open breech and the round's run-in stay framed —
    // then settle the view before the slam. The seat and latch contacts keep the
    // two heavy clicks felt in the hands.
    const presented = actions._phase(frac, 0.02, 0.20) * (1 - actions._phase(frac, 0.88, 1.00));
    const seat = actions._contact(frac, timeline.home, 0.07);
    const latch = actions._contact(frac, timeline.clickAt, 0.05);
    out.yaw = -0.30 * presented;
    out.roll = 0.10 * presented;
    out.x = -0.06 * presented;
    out.dip = 0.06 * presented + 0.03 * seat;
    out.rock = 0.12 * presented - 0.10 * seat - 0.03 * latch;
    out.push = -0.10 * seat;
    // SWING: the gate swings open about its vertical side pin (no slide; the
    // group sits on the hinge the template exported) so the rear stands fully
    // open, clear of the bore axis, before the round starts to rise. Negative
    // rotation.y carries the blast-brake tail out to -x, the player-facing flank.
    parts.gate.position.copy(parts.hinge);
    const open = actions._phase(frac, 0.20, 0.32) * (1 - actions._phase(frac, 0.875, 0.925));
    // The hinge-stop bounce at 0.31 overshoots the swing with weight; CLOSE lets
    // the returning hand swing the gate shut from 0.875 and a smaller rebound at
    // 0.92 reopens it a hair as the latch takes the impact (cue 3). Both decays
    // end before 0.94 so the rest value is exactly 0 (a closed gate can never
    // rotate past its block face).
    const swing = parts.swing * open + 0.07 * actions._contact(frac, 0.31, 0.12)
      + 0.05 * actions._contact(frac, 0.92, 0.02);
    parts.gate.rotation.y = swing > 0 ? -swing : 0;
    // Clamp grab: the palm rides the blast-brake collar (rest offset from the pin),
    // rotated with the live swing so the hand stays on the handle it operates.
    const grabOff = [0.1044, 0.05, 0.1783];
    const cos = Math.cos(parts.gate.rotation.y), sin = Math.sin(parts.gate.rotation.y);
    const grab = [
      parts.hinge.x + grabOff[0] * cos + grabOff[2] * sin,
      parts.hinge.y + grabOff[1],
      parts.hinge.z - grabOff[0] * sin + grabOff[2] * cos,
    ];
    // COCK: the arming lever tips while the breech stands open and snaps home
    // exactly on cue 3.
    model.bolt.rotation.x = 0.55 * open * (1 - actions._phase(frac, 0.88, timeline.clickAt));
    // LOAD: the round rises from lower-right close to the camera — the
    // gate-free flank, clear of the open blast brake — yawed across the bore
    // with its nose cantled toward the tube mouth, then squares onto the tube
    // axis. Loading from the gate's own (-x) flank parked the nose inside the
    // collar's screen silhouette under the present yaw; the +x entry keeps the
    // round and the open gate on opposite halves of the lens for the whole load,
    // so the nose reads as leading into the mouth.
    const round = model.extra.userData.reloadRounds;
    const raise = actions._phase(frac, 0.36, 0.56);
    const align = actions._phase(frac, 0.56, 0.68);
    // SEAT: an accelerating shove drives the round home — at insert = 1 its
    // origin reaches parts.seat (game z -0.55) — and the support hand rides it
    // the whole way. Once seated at timeline.home (0.84), `round` hands off to
    // `chambered` while the gate closes and the arming lever cocks.
    // A portrait lens is too narrow for the wide run-in, so `narrow` (set by the
    // rig from the camera aspect) stages the round nearer the bore and further
    // from the camera; the nose still clears the tube's rear end before it aligns.
    const insert = actions._phase(frac, 0.70, timeline.home);
    const narrow = parts.narrow || 0;
    const stageZ = parts.rearZ + 0.42 - 0.20 * narrow;
    parts.reloading = true;
    parts.seated = frac >= timeline.home;
    round.visible = frac >= 0.36 && frac < timeline.home;
    round.position.set(0.30 * (1 - 0.75 * narrow) * (1 - align), parts.axisY - 0.55 * (1 - 0.6 * narrow) * (1 - raise),
      stageZ + (parts.seat.z - stageZ) * insert * insert);
    round.rotation.y = 0.45 * (1 - 0.55 * narrow) * (1 - align);
    syncRocketAmmo(parts, parts.authoritativeMag);
    // HAND: one support hand runs the whole story — pull the gate open, take the
    // rocket and shove it home, then swing the gate shut and latch it. Targets
    // blend between the swing-following gate grab and the round's grip point.
    const grip = [round.position.x - 0.04, round.position.y - 0.04, round.position.z + 0.075];
    let target = grab;
    if (frac >= 0.34 && frac < 0.42) target = actions._blendTargets(grab, grip, actions._phase(frac, 0.34, 0.42));
    else if (frac >= 0.42 && frac < 0.845) target = grip;
    else if (frac >= 0.845 && frac < 0.875) target = actions._blendTargets(grip, grab, actions._phase(frac, 0.845, 0.875));
    actions._moveReloadHand(model, target[0], target[1], target[2],
      actions._phase(frac, 0.06, 0.18) * (1 - actions._phase(frac, 0.96, 1)), true);
    for (const [at, click] of [[timeline.start, 1], [timeline.home, 2], [timeline.clickAt, 3]]) {
      if (frac >= at && reload.lastFrac < at) actions._callbacks.onReloadClick(click);
    }
  }
}
