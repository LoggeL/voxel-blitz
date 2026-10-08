/** Transport helicopter: the attack helicopter's assisted flight model with a
 * heavier airframe. Only mass/tuning constants differ; the physical colliders
 * and every geometric field are the attack helicopter's (spec §5.1). */
import { HELICOPTER_RULES, stepHelicopterFlight } from './helicopter.js';

export const TRANSPORT_RULES = Object.freeze({
  ...HELICOPTER_RULES,
  hp: 600,
  speed: 30, reverse: 10, acceleration: 7, brake: 13,
  climb: 7, descent: 6,
  liftAcceleration: 7.5, verticalResponse: 2.1, collectiveRate: 1,
  turn: 0.85, turnAcceleration: 1.7, aimResponse: 2.1,
  pitchRate: 0.6, rollRate: 0.75, maxPitch: 0.36, minPitch: -0.4,
  maxBank: 0.45, cyclicAcceleration: 2, attitudeResponse: 1.9, assistResponse: 3,
  rotorAcceleration: 0.75, rotorDeceleration: 0.5,
  respawnSeconds: 35, fireSeconds: 0,
});

/** Same contract as stepHelicopterFlight; the transport constants apply. */
export function stepTransportFlight(state, input = {}, dt = 0) {
  return stepHelicopterFlight(state, input, dt, TRANSPORT_RULES);
}
