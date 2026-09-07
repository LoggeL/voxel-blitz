import { Vector3 } from '../vendor/three.module.js';
import { fwdFromAngles } from '../util/look.js';

const point = new Vector3();

/** Project the same eye ray used by predicted and authoritative shots. */
export function projectAimReticle(camera, yaw, pitch) {
  if (!camera || !Number.isFinite(yaw) || !Number.isFinite(pitch)) return { x: 0.5, y: 0.5 };
  const direction = fwdFromAngles(yaw, pitch);
  camera.updateMatrixWorld(true);
  point.set(direction.x, direction.y, direction.z).multiplyScalar(100).add(camera.position).project(camera);
  if (![point.x, point.y, point.z].every(Number.isFinite) || point.z > 1) return { x: 0.5, y: 0.5 };
  return { x: (point.x + 1) / 2, y: (1 - point.y) / 2 };
}
