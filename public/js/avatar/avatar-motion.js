const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));
const follow = (value, target, speed, dt) => value + (target - value) * (1 - Math.exp(-speed * dt));

/** Small secondary motion; the combat pose remains owned by stance and weapon IK. */
export class AvatarMotion {
  constructor(seed = 0) {
    this.seed = seed;
    this.reset();
  }

  reset() {
    this.phase = this.seed;
    this.breath = 0;
    this.air = 0;
    this.landing = 0;
    this.side = 0;
    this.forward = 0;
    this.turn = 0;
    this.gearPitch = 0;
    this.gearRoll = 0;
    this.grounded = true;
    this.fallSpeed = 0;
    this.seeded = false;
  }

  update(dt, {
    stride = 0, swing = 0, grounded = true, verticalSpeed = 0,
    lateralSpeed = 0, forwardSpeed = 0, turnSpeed = 0,
  } = {}) {
    // A suspended tab must not introduce a huge landing impulse or spring step.
    const frameDt = clamp(dt, 0, 0.1);
    if (!frameDt) return;
    this.phase += frameDt * (2.05 + clamp(stride, 0, 1) * 1.25);
    this.breath = Math.sin(this.phase) * (1 - clamp(stride, 0, 1) * 0.5);
    if (this.seeded && grounded && !this.grounded) {
      this.landing = Math.max(this.landing, clamp(this.fallSpeed / 9, 0, 1));
    }
    this.fallSpeed = grounded ? 0 : Math.max(this.fallSpeed, -verticalSpeed);
    this.grounded = !!grounded;
    this.seeded = true;
    this.air = follow(this.air, grounded ? 0 : 1, 11, frameDt);
    this.landing = follow(this.landing, 0, 8, frameDt);
    this.side = follow(this.side, clamp(lateralSpeed / 6, -1, 1), 8, frameDt);
    this.forward = follow(this.forward, clamp(forwardSpeed / 6, -1, 1), 8, frameDt);
    this.turn = follow(this.turn, clamp(turnSpeed / 5, -1, 1), 7, frameDt);
    // The pack and pouches settle after the body, with a restrained step bounce.
    this.gearPitch = follow(this.gearPitch,
      clamp(swing * 0.04 + verticalSpeed * 0.005 + this.landing * 0.11 + this.forward * 0.035, -0.12, 0.12),
      9, frameDt);
    this.gearRoll = follow(this.gearRoll,
      -this.side * 0.075 - this.turn * 0.07 + swing * 0.025, 7, frameDt);
  }
}
