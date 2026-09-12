import { Vector3 } from '../vendor/three.module.js';
import { fwdFromAngles } from '../util/look.js';

const point = new Vector3(), local = new Vector3();

/** Project the same eye ray used by predicted and authoritative shots. */
export function projectAimReticle(camera, yaw, pitch) {
  if (!camera || !Number.isFinite(yaw) || !Number.isFinite(pitch)) return { x: 0.5, y: 0.5 };
  const direction = fwdFromAngles(yaw, pitch);
  camera.updateMatrixWorld(true);
  point.set(direction.x, direction.y, direction.z).multiplyScalar(100).add(camera.position);
  const ahead = local.copy(point).applyMatrix4(camera.matrixWorldInverse);
  if (ahead.z >= 0) {
    // A slow weapon can still point behind a 180-degree camera flick. Never
    // invent a centered aiming marker in that case; keep it outside the screen.
    return { x: ahead.x >= 0 ? 1.1 : -0.1, y: 0.5 };
  }
  point.project(camera);
  if (![point.x, point.y, point.z].every(Number.isFinite)) return { x: 0.5, y: 0.5 };
  return { x: (point.x + 1) / 2, y: (1 - point.y) / 2 };
}
