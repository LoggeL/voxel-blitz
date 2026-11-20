// The spool pays out through the narrow guide. Both recoil-free guides ring
// briefly after the shuttle pulls the thread taut.
function ramp(t, begin, end) {
  const u = Math.max(0, Math.min(1, (t - begin) / (end - begin)));
  return u * u * (3 - 2 * u);
}

export class SelvedgeMotion {
  constructor(parts) {
    this.parts = parts;
    this.shuttleZ = parts.shuttle.position.z;
    this.indicatorY = parts.indicator.position.y;
    this.reset();
  }

  reset() {
    this.elapsed = Infinity;
    this.index = 0;
    this.wasDrawing = false;
    this.tension = 0;
    this.parts.bobbin.rotation.x = 0;
    this.parts.guide.rotation.x = 0;
    this.parts.leftTine.rotation.y = this.parts.rightTine.rotation.y = 0;
    this.parts.shuttle.position.z = this.shuttleZ;
    this.parts.indicator.position.y = this.indicatorY;
  }

  release() {
    this.elapsed = 0;
    this.index = (this.index + 1) % 8;
  }

  update(dt, draw = 1, reducedMotion = false, pinned = false) {
    const target = pinned ? 1 : 0;
    if (this.elapsed === Infinity && draw >= 1 && !this.wasDrawing && this.tension === target) return;
    this.tension += (target - this.tension) * (1 - Math.exp(-18 * dt));
    if (Math.abs(this.tension - target) < 0.001) this.tension = target;
    this.elapsed += dt;
    const t = this.elapsed;
    const pull = ramp(t, 0, 0.021) * (1 - ramp(t, 0.038, 0.165));
    const pay = ramp(t, 0.015, 0.134);
    const recoil = t < 0.24 ? Math.sin(66 * t) * Math.exp(-15 * t) : 0;
    const preload = 1 - ramp(draw, 0.32, 0.86);
    const angle = Math.PI / 4 * (this.index - 1 + pay);
    const p = this.parts;
    p.bobbin.rotation.x = -angle;
    p.guide.rotation.x = angle * 4;
    p.shuttle.position.z = this.shuttleZ - 0.032 * pull + 0.010 * preload + 0.012 * this.tension;
    const flex = 0.036 * pull + (reducedMotion ? 0 : 0.038 * recoil) - 0.023 * preload - 0.027 * this.tension;
    p.leftTine.rotation.y = flex;
    p.rightTine.rotation.y = -flex;
    p.indicator.position.y = this.indicatorY + 0.004 * pull + 0.015 * this.tension;
    this.wasDrawing = draw < 1;
    if (t >= 0.24) this.elapsed = Infinity;
  }
}

// A straight withdrawal clears the axle before the cassette can turn or drop.
// Pocket travel starts only after that clearance. On insertion the reverse
// sequence brings the axle level before the cassette can slide into its seat.
export function poseSelvedgeReload(actions, model, f, out) {
  const { start, home, clickAt } = model.T.magTimeline;
  const p = model.extra.userData.selvedge;
  const mag = model.mag;
  const open = ramp(f, 0.105, start) * (1 - ramp(f, 0.793, clickAt));
  p.latch.rotation.z = -1.38 * open;
  const clear = ramp(f, 0.222, 0.335) * (1 - ramp(f, 0.651, home));
  const pocket = ramp(f, 0.335, 0.463) * (1 - ramp(f, 0.488, 0.651));
  const reach = ramp(f, 0.025, 0.108) * (1 - ramp(f, clickAt, 0.975));
  const cassetteGrip = ramp(f, start, 0.222) * (1 - ramp(f, 0.747, 0.795));
  const seat = ramp(f, home - 0.024, home) * (1 - ramp(f, home, home + 0.046));
  const click = ramp(f, clickAt - 0.022, clickAt) * (1 - ramp(f, clickAt, clickAt + 0.04));
  mag.position.set(-0.143 * clear - 0.075 * pocket, -0.49 * pocket, 0.16 * pocket);
  mag.rotation.x = -0.48 * pocket;
  mag.rotation.y = -0.20 * pocket;
  mag.visible = f < 0.461 || f > 0.490;

  // Track the reel hub through its tumbling pocket arc. The palm first
  // touches the keeper, rides the reel, then finds the keeper again to close.
  const hub = p.bobbin.position;
  const lever = p.latch.position;
  const leverX = lever.x - 0.029, leverY = lever.y - 0.038;
  const handX = leverX + cassetteGrip * (mag.position.x + hub.x - 0.095 - leverX);
  const handY = leverY + cassetteGrip * (mag.position.y + hub.y - leverY);
  const handZ = lever.z + cassetteGrip * (mag.position.z + hub.z - lever.z);
  actions._moveReloadHand(model, handX, handY, handZ, reach);
  const palm = model.extra.userData.reloadHand?.hand;
  if (palm) {
    palm.rotation.y -= 0.42 * reach;
    palm.rotation.z -= 0.35 * reach + 0.22 * cassetteGrip * pocket;
  }
  const present = ramp(f, 0, 0.164) * (1 - ramp(f, clickAt, 1));
  out.x = -0.063 * present + 0.012 * seat;
  out.dip = 0.047 * present - 0.011 * clear;
  out.push = 0.036 * present - 0.017 * seat;
  out.rock = 0.14 * present - 0.042 * seat;
  out.yaw = -0.16 * present;
  out.roll = -0.46 * present + 0.061 * seat + 0.028 * click;
  const previous = actions._reload.lastFrac;
  if (previous < start && f >= start) actions._callbacks.onReloadClick(1);
  if (previous < home && f >= home) actions._callbacks.onReloadClick(2);
  if (previous < clickAt && f >= clickAt) actions._callbacks.onReloadClick(3);
}

export function selvedgeDrawOffset(f, swapping) {
  const lift = 1 - ramp(f, 0, 0.75);
  const level = 1 - ramp(f, 0.26, 0.93);
  const check = ramp(f, 0.40, 0.70) * (1 - ramp(f, 0.70, 1));
  return {
    x: 0.115 * lift - 0.012 * check,
    y: (swapping ? -0.68 : -0.26) * lift + 0.009 * check,
    z: 0.145 * lift,
    rx: -0.47 * lift + 0.033 * check,
    ry: -0.19 * lift,
    rz: -0.58 * level,
  };
}
