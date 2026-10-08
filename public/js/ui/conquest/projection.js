/**
 * Pure camera math for screen-space Conquest markers and reticles. It reads
 * the column-major matrices of a THREE camera (or an equivalent plain pose
 * built by cameraPose) and never imports THREE, so the read model stays
 * testable in Node.
 */

const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;

/** Canonical look convention: yaw 0 faces -Z, +yaw turns left, +pitch looks up. */
export function forwardFromAngles(yaw, pitch = 0) {
  const cp = Math.cos(pitch);
  return [-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp];
}

/**
 * A camera-equivalent pose from position and angles: the same
 * matrixWorldInverse / projectionMatrix element layout THREE uses
 * (perspective, YXZ Euler with yaw about Y and pitch about X).
 */
export function cameraPose({ x = 0, y = 0, z = 0, yaw = 0, pitch = 0, fov = 75, aspect = 16 / 9, near = 0.05, far = 2000 } = {}) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
  // World rotation R = Ry(yaw) * Rx(pitch); columns are the camera right, up and back axes.
  const right = [cy, 0, -sy];
  const up = [sy * sp, cp, cy * sp];
  const back = [sy * cp, -sp, cy * cp];
  const t = [x, y, z];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  // Inverse of [R | t] is [R^T | -R^T t], stored column-major.
  const inverse = [
    right[0], up[0], back[0], 0,
    right[1], up[1], back[1], 0,
    right[2], up[2], back[2], 0,
    -dot(right, t), -dot(up, t), -dot(back, t), 1,
  ];
  const f = 1 / Math.tan((fov * Math.PI / 180) / 2);
  const projection = [
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) / (near - far), -1,
    0, 0, (2 * far * near) / (near - far), 0,
  ];
  return {
    position: { x, y, z }, yaw, pitch, fov, aspect,
    matrixWorldInverse: { elements: inverse },
    projectionMatrix: { elements: projection },
  };
}

/** Camera world yaw / pitch from a camera-like object (THREE or cameraPose). */
export function cameraAngles(camera) {
  if (!camera) return null;
  if (Number.isFinite(camera.yaw) && Number.isFinite(camera.pitch)) return { yaw: camera.yaw, pitch: camera.pitch };
  const inv = camera.matrixWorldInverse?.elements;
  if (!inv) return null;
  // Row 2 of the inverse rotation is the camera back axis in world space.
  const bx = inv[2], by = inv[6], bz = inv[10];
  return { yaw: Math.atan2(bx, bz), pitch: Math.asin(Math.max(-1, Math.min(1, -by))) };
}

/** Camera world position from a camera-like object. */
export function cameraPosition(camera) {
  if (!camera) return null;
  const p = camera.position;
  if (p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z) && !camera.matrixWorld) return { x: p.x, y: p.y, z: p.z };
  const world = camera.matrixWorld?.elements;
  if (world) return { x: world[12], y: world[13], z: world[14] };
  const inv = camera.matrixWorldInverse?.elements;
  if (!inv) return p ? { x: finite(p.x), y: finite(p.y), z: finite(p.z) } : null;
  // position = -R t, with R^T stored in the upper 3x3 of the inverse.
  const tx = inv[12], ty = inv[13], tz = inv[14];
  return {
    x: -(inv[0] * tx + inv[1] * ty + inv[2] * tz),
    y: -(inv[4] * tx + inv[5] * ty + inv[6] * tz),
    z: -(inv[8] * tx + inv[9] * ty + inv[10] * tz),
  };
}

/**
 * Build a projector over a viewport in CSS pixels. project([x,y,z]) returns
 * {x, y, depth, behind, inside} where x/y are CSS pixels; points behind the
 * camera are mirrored so edge clamping points the right way.
 */
export function createProjector(camera, width, height) {
  const view = camera?.matrixWorldInverse?.elements;
  const proj = camera?.projectionMatrix?.elements;
  if (!view || !proj || !(width > 0) || !(height > 0)) return null;
  const v = view, p = proj;
  return {
    width, height,
    project(x, y, z) {
      const vx = v[0] * x + v[4] * y + v[8] * z + v[12];
      const vy = v[1] * x + v[5] * y + v[9] * z + v[13];
      const vz = v[2] * x + v[6] * y + v[10] * z + v[14];
      const behind = vz >= 0;
      // Clip space for a perspective matrix; w = -vz.
      const cx = p[0] * vx + p[4] * vy + p[8] * vz + p[12];
      const cy = p[1] * vx + p[5] * vy + p[9] * vz + p[13];
      const w = p[3] * vx + p[7] * vy + p[11] * vz + p[15];
      let ndcX, ndcY;
      if (behind || Math.abs(w) < 1e-6) {
        // Direction only: mirror across the view so the edge arrow points toward the target.
        const len = Math.hypot(vx, vy) || 1;
        ndcX = (vx / len) * 4;
        ndcY = (vy / len) * 4;
        if (Math.abs(vx) < 1e-6 && Math.abs(vy) < 1e-6) ndcY = -4;
      } else {
        ndcX = cx / w;
        ndcY = cy / w;
      }
      const sx = (ndcX * 0.5 + 0.5) * width;
      const sy = (-ndcY * 0.5 + 0.5) * height;
      const inside = !behind && ndcX >= -1 && ndcX <= 1 && ndcY >= -1 && ndcY <= 1;
      return { x: sx, y: sy, depth: -vz, behind, inside };
    },
  };
}

/**
 * Clamp a projected point inside an inset rectangle. Off-screen points slide
 * to the border along the ray from the screen centre; `angle` (radians,
 * 0 = up, clockwise) points from the clamped marker toward the target.
 */
export function clampToEdge(point, width, height, { top = 72, bottom = 96, left = 40, right = 40 } = {}) {
  const cx = width / 2, cy = height / 2;
  const minX = left, maxX = width - right, minY = top, maxY = height - bottom;
  const insideRect = point.inside && point.x >= minX && point.x <= maxX && point.y >= minY && point.y <= maxY;
  if (insideRect) return { x: point.x, y: point.y, edge: false, angle: 0 };
  let dx = point.x - cx, dy = point.y - cy;
  if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) dy = 1;
  const scaleX = dx > 0 ? (maxX - cx) / dx : dx < 0 ? (minX - cx) / dx : Infinity;
  const scaleY = dy > 0 ? (maxY - cy) / dy : dy < 0 ? (minY - cy) / dy : Infinity;
  const scale = Math.max(0, Math.min(scaleX, scaleY));
  return { x: cx + dx * scale, y: cy + dy * scale, edge: true, angle: Math.atan2(dx, -dy) };
}

/** Heading-up local frame used by the minimap: +x right of view, +forward ahead. */
export function localPlanar(dx, dz, yaw) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return { right: dx * c - dz * s, forward: -dx * s - dz * c };
}

/** Constant-gravity ballistic point after `distance` metres of horizontal travel (null if it never gets there). */
export function ballisticPoint(origin, dir, speed, gravity, distance) {
  const [ox, oy, oz] = origin;
  const [dx, dy, dz] = dir;
  const horizontal = Math.hypot(dx, dz);
  if (!(speed > 0)) return [ox + dx * distance, oy + dy * distance, oz + dz * distance];
  if (horizontal < 1e-4) return null;
  const t = distance / (speed * horizontal);
  return [ox + dx * speed * t, oy + dy * speed * t - 0.5 * gravity * t * t, oz + dz * speed * t];
}

/** Constant-gravity ballistic point `seconds` after launch (where a timed-out shell airbursts). */
export function ballisticAtTime(origin, dir, speed, gravity, seconds) {
  return [origin[0] + dir[0] * speed * seconds, origin[1] + dir[1] * speed * seconds - 0.5 * gravity * seconds * seconds,
    origin[2] + dir[2] * speed * seconds];
}

/**
 * Where a ballistic round first meets the world: the arc is marched in
 * `step`-second chords, each tested with `raycast(origin, dir, length)` (a
 * SOLID-block picker like the server's shell cast, so water, lava and ghost
 * blocks are flown through: `{x,y,z}` vectors, returns `{t}` or null). Returns
 * `{ point, range, time }` (range = horizontal metres) or null when nothing is
 * hit within `maxSeconds`.
 */
export function ballisticImpact(origin, dir, speed, gravity, raycast, { maxSeconds = 4, step = 0.05 } = {}) {
  if (typeof raycast !== 'function' || !(speed > 0) || !origin || !dir) return null;
  const [ox, oy, oz] = origin;
  const vx = dir[0] * speed, vy = dir[1] * speed, vz = dir[2] * speed;
  const from = { x: ox, y: oy, z: oz }, way = { x: 0, y: 0, z: 0 };
  // Chords between exact parabola points (the server's 60 Hz steps stay within a few cm of it).
  for (let t = 0; t < maxSeconds; t += step) {
    const n = Math.min(maxSeconds, t + step);
    const x = ox + vx * n, y = oy + vy * n - 0.5 * gravity * n * n, z = oz + vz * n;
    const dx = x - from.x, dy = y - from.y, dz = z - from.z, length = Math.hypot(dx, dy, dz);
    if (!(length > 1e-6)) return null;
    way.x = dx / length; way.y = dy / length; way.z = dz / length;
    const hit = raycast(from, way, length);
    if (hit && Number.isFinite(hit.t)) {
      const k = Math.max(0, Math.min(length, hit.t)) / length;
      const point = [from.x + dx * k, from.y + dy * k, from.z + dz * k];
      return { point, range: Math.hypot(point[0] - ox, point[2] - oz), time: t + (n - t) * k };
    }
    from.x = x; from.y = y; from.z = z;
  }
  return null;
}

/**
 * Lead pipper: where to aim so a projectile of `speed` meets a target moving
 * at constant velocity (first-order intercept). Hitscan (speed 0) returns the
 * target itself.
 */
export function leadPoint(shooter, target, velocity, speed) {
  const tx = target[0] - shooter[0], ty = target[1] - shooter[1], tz = target[2] - shooter[2];
  if (!(speed > 0)) return { point: [...target], tof: 0 };
  const [vx, vy, vz] = velocity;
  const a = vx * vx + vy * vy + vz * vz - speed * speed;
  const b = 2 * (tx * vx + ty * vy + tz * vz);
  const c = tx * tx + ty * ty + tz * tz;
  let t;
  if (Math.abs(a) < 1e-6) t = b !== 0 ? -c / b : 0;
  else {
    const disc = b * b - 4 * a * c;
    if (disc < 0) t = Math.sqrt(c) / speed;
    else {
      const r = Math.sqrt(disc);
      const t1 = (-b - r) / (2 * a), t2 = (-b + r) / (2 * a);
      t = Math.min(...[t1, t2].filter(value => value > 0), Infinity);
      if (!Number.isFinite(t)) t = Math.sqrt(c) / speed;
    }
  }
  t = Math.max(0, t);
  return { point: [target[0] + vx * t, target[1] + vy * t, target[2] + vz * t], tof: t };
}

/** Angle in radians between a direction and the vector from `from` to `to`. */
export function angleTo(dir, from, to) {
  const vx = to[0] - from[0], vy = to[1] - from[1], vz = to[2] - from[2];
  const len = Math.hypot(vx, vy, vz), dl = Math.hypot(dir[0], dir[1], dir[2]);
  if (!(len > 0) || !(dl > 0)) return Math.PI;
  const cos = (vx * dir[0] + vy * dir[1] + vz * dir[2]) / (len * dl);
  return Math.acos(Math.max(-1, Math.min(1, cos)));
}
