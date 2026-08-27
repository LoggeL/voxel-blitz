import { computeSpreadConeDeg } from '../../../shared/combatmath.js';

/** Canonical look convention (client + server + bots): yaw=0 faces -Z, +yaw LEFT,
 *  +pitch UP. fwd = (-sin(yaw)*cos(pitch), sin(pitch), -cos(yaw)*cos(pitch)). */
export function fwdFromAngles(yaw, pitch) {
  const cp = Math.cos(pitch);
  return { x: -Math.sin(yaw) * cp, y: Math.sin(pitch), z: -Math.cos(yaw) * cp };
}

export function currentConeDeg(
  def,
  bloomDeg,
  speedXZ,
  adsT,
  panic = 0,
  exhaustion = 0,
  crouching = false,
  pain = 0,
) {
  return computeSpreadConeDeg(
    def,
    bloomDeg,
    speedXZ,
    adsT,
    panic,
    exhaustion,
    crouching,
    pain,
  );
}
