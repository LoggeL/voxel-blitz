import { NETWORK_PRESENTATION } from '../../../shared/networking.js';

const MAX_REMOTE_SPEED = 10;
const TELEPORT_DISTANCE = 3.2;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function writeCurrentTransform(out, current) {
  out.x = Number(current?.x) || 0;
  out.y = Number(current?.y) || 0;
  out.z = Number(current?.z) || 0;
  out.yaw = Number(current?.yaw) || 0;
  out.pitch = Number(current?.pitch) || 0;
  return out;
}

export function shortestAngleDelta(a, b) {
  return (((b - a) % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2) - Math.PI;
}

/** Interpolate radians over the shortest arc across the +/-PI seam. */
export function angleLerpShortest(a, b, t) {
  return a + shortestAngleDelta(a, b) * t;
}

export function findSnapshotWindow(snapshots, targetMs, out = [null, null]) {
  if (!Array.isArray(snapshots) || snapshots.length === 0) {
    out[0] = null;
    out[1] = null;
    return out;
  }
  let before = null;
  for (let i = 0; i < snapshots.length; i++) {
    const snapshot = snapshots[i];
    if (snapshot.now <= targetMs) before = snapshot;
    else {
      out[0] = before || snapshot;
      out[1] = snapshot;
      return out;
    }
  }
  const newest = snapshots[snapshots.length - 1];
  out[0] = snapshots.length > 1 ? snapshots[snapshots.length - 2] : newest;
  out[1] = newest;
  return out;
}

/**
 * Sample one remote transform. Ordinary frames interpolate; a late packet may
 * extrapolate at most 75 ms and 10 m/s. State transitions and implausible
 * displacements snap to authority instead of smearing a respawn across space.
 */
export function sampleRemoteTransform(
  previous,
  current,
  targetMs,
  previousMs,
  currentMs,
  out = {},
) {
  if (!previous || !current || !(currentMs > previousMs)) {
    return writeCurrentTransform(out, current);
  }
  if (!Number.isFinite(previous.x) || !Number.isFinite(previous.y) ||
      !Number.isFinite(previous.z) || !Number.isFinite(previous.yaw) ||
      !Number.isFinite(previous.pitch) || !Number.isFinite(current.x) ||
      !Number.isFinite(current.y) || !Number.isFinite(current.z) ||
      !Number.isFinite(current.yaw) || !Number.isFinite(current.pitch) ||
      previous.state !== current.state) {
    return writeCurrentTransform(out, current);
  }

  const dx = current.x - previous.x;
  const dy = current.y - previous.y;
  const dz = current.z - previous.z;
  const distance = Math.hypot(dx, dy, dz);
  if (distance > TELEPORT_DISTANCE) return writeCurrentTransform(out, current);

  const spanMs = currentMs - previousMs;
  if (targetMs <= currentMs) {
    const alpha = clamp((targetMs - previousMs) / spanMs, 0, 1);
    out.x = previous.x + dx * alpha;
    out.y = previous.y + dy * alpha;
    out.z = previous.z + dz * alpha;
    out.yaw = angleLerpShortest(previous.yaw, current.yaw, alpha);
    out.pitch = previous.pitch + (current.pitch - previous.pitch) * alpha;
    return out;
  }

  const extraMs = clamp(
    targetMs - currentMs,
    0,
    NETWORK_PRESENTATION.maxExtrapolationMs,
  );
  const spanSeconds = spanMs / 1000;
  let vx = dx / spanSeconds;
  let vy = dy / spanSeconds;
  let vz = dz / spanSeconds;
  const speed = Math.hypot(vx, vy, vz);
  if (speed > MAX_REMOTE_SPEED) {
    const scale = MAX_REMOTE_SPEED / speed;
    vx *= scale;
    vy *= scale;
    vz *= scale;
  }
  const extraSeconds = extraMs / 1000;
  const angleRate = clamp(shortestAngleDelta(previous.yaw, current.yaw) / spanSeconds, -7, 7);
  const pitchRate = clamp((current.pitch - previous.pitch) / spanSeconds, -5, 5);
  out.x = current.x + vx * extraSeconds;
  out.y = current.y + vy * extraSeconds;
  out.z = current.z + vz * extraSeconds;
  out.yaw = current.yaw + angleRate * extraSeconds;
  out.pitch = clamp(current.pitch + pitchRate * extraSeconds, -Math.PI / 2, Math.PI / 2);
  return out;
}
