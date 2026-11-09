// SP-2 DOPPLER presentation: the recoiling firing unit, its cable sheaves and
// buffer spring, and the cartridge stack behind the smoke magazine wall.
// State (rounds in the magazine) always comes from WeaponState; this module
// only animates. Timings follow the shifted-pulse cycle in docs/weapon-design/doppler.md.

/** Seconds after the first round at which the unit meets its buffer (the felt kick). */
export const DOPPLER_BUFFER_S = 0.047;
const RETURN_S = 0.125;
const SINGLE_STROKE = 0.62;   // one round drives the unit only part of the way

const easeOut = u => 1 - (1 - u) * (1 - u);
const smooth = u => u * u * (3 - 2 * u);

/**
 * Unit travel 0..1 `t` seconds after the first round of a pull. Two rounds: the first
 * drives the unit 58 % of its stroke, the second (at `gap`) drives it into the buffer,
 * then the spring returns it. One round stops short of the buffer.
 */
export function dopplerStroke(t, rounds = 2, gap = 0.033) {
  if (!(t >= 0)) return 0;
  if (rounds < 2) {
    const peak = 0.018;
    if (t < peak) return SINGLE_STROKE * easeOut(t / peak);
    const u = (t - peak) / (RETURN_S * 0.8);
    return u >= 1 ? 0 : SINGLE_STROKE * (1 - smooth(u));
  }
  if (t < gap) return 0.58 * easeOut(t / gap);
  const hit = DOPPLER_BUFFER_S - gap;
  if (t < DOPPLER_BUFFER_S) return 0.58 + 0.42 * easeOut((t - gap) / hit);
  const u = (t - DOPPLER_BUFFER_S) / RETURN_S;
  if (u >= 1) return 0;
  // A short bounce off the buffer before the spring carries the unit home.
  return (1 - smooth(u)) * (1 - 0.06 * Math.sin(Math.PI * Math.min(1, u * 4)));
}

/** Cartridges shown for `mag` of `magSize` rounds in a stack modelled with `roundCount` instances. */
export function dopplerVisibleRounds(mag, magSize, roundCount) {
  if (!(magSize > 0) || !(roundCount > 0)) return 0;
  const left = Math.max(0, Math.min(magSize, Number.isFinite(mag) ? mag : 0));
  return Math.max(0, Math.min(roundCount, Math.round(left * roundCount / magSize)));
}

export class DopplerPresentation {
  constructor(parts) {
    this.parts = parts;
    this._t = Infinity;
    this._rounds = 2;
    this._gap = 0.033;
    this._mag = parts.roundCount;
    this._magSize = parts.roundCount;
    this._fresh = -1;          // seconds until a reloading magazine shows its full stack
    this._hold = -1;           // seconds the full stack may outlast the swap while authority catches up
    this._shown = -1;
    this._apply(0);
    this._showRounds(parts.roundCount);
  }

  reset(mag, magSize) {
    this._t = Infinity;
    this._fresh = this._hold = -1;
    this._apply(0);
    this.setMag(mag ?? this._mag, magSize ?? this._magSize);
  }

  /** Authoritative or predicted rounds in the magazine. */
  setMag(mag, magSize) {
    if (Number.isFinite(mag)) this._mag = mag;
    if (magSize > 0) this._magSize = magSize;
    if (this._hold >= 0 && this._fresh < 0 && this._mag >= this._magSize) this._hold = -1;
    if (this._hold < 0) this._showRounds(dopplerVisibleRounds(this._mag, this._magSize, this.parts.roundCount));
  }

  /** One accepted trigger pull spending `rounds` rounds, `gap` seconds apart. */
  fire(rounds = 2, gap = 0.033) {
    this._rounds = rounds >= 2 ? 2 : 1;
    this._gap = gap;
    this._t = 0;
  }

  /** A magazine swap of `seconds`: the fresh magazine arrives full once the spent one is out of sight. */
  reload(seconds, elapsed = 0) {
    this._fresh = Math.max(0, seconds * 0.46 - elapsed);
    this._hold = Math.max(this._fresh, seconds - elapsed) + 0.35;
    this._showRounds(dopplerVisibleRounds(this._mag, this._magSize, this.parts.roundCount));
  }

  cancelReload() {
    this._fresh = this._hold = -1;
    this.setMag(this._mag, this._magSize);
  }

  update(dt) {
    if (this._hold >= 0) {
      this._hold -= dt;
      if (this._fresh >= 0) {
        this._fresh -= dt;
        // The fresh magazine is full; it stays so until authority reports it seated.
        if (this._fresh < 0) this._showRounds(this.parts.roundCount);
      }
      if (this._hold < 0) this.setMag(this._mag, this._magSize);
    }
    if (this._t === Infinity) return 0;
    this._t += dt;
    const stroke = dopplerStroke(this._t, this._rounds, this._gap);
    if (stroke <= 0 && this._t > DOPPLER_BUFFER_S) this._t = Infinity;
    this._apply(stroke);
    return stroke;
  }

  _apply(stroke) {
    const { unit, boltSlide, spring, pulley, travel, sheaveRadius, springLength } = this.parts;
    const z = travel * stroke;
    unit.position.z = z;
    boltSlide.position.z = z;
    spring.scale.z = (springLength - z) / springLength;
    pulley.rotation.x = -z / sheaveRadius;
  }

  _showRounds(count) {
    if (count === this._shown) return;
    this._shown = count;
    const { rounds, follower, followerPath, roundCount } = this.parts;
    rounds.count = count;
    rounds.visible = count > 0;
    const step = followerPath[Math.max(0, Math.min(roundCount, count))];
    if (step) follower.position.set(step[0], step[1], step[2]);
  }
}

export function dopplerPresentationFor(model) {
  const parts = model?.extra.userData.doppler;
  if (!parts) return null;
  return parts.presentation ||= new DopplerPresentation(parts);
}
