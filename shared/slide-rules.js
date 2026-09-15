/**
 * Water slide rides shared by prediction and authority.
 *
 * A map authors `meta.slides`: each slide is an ordered polyline `path` of
 * tube centreline waypoints (voxel units) from the mouth at the top to the
 * splash-down at the bottom, and a `speed` in voxels per second (the original
 * trigger_push chain, see tools/compile-waterworld-reference.py). A rider's
 * feet travel SLIDE_RULES.feetDrop under the centreline.
 *
 * A body starts a ride when its feet stand inside a segment (within the entry
 * reach of the centreline and near the rail height) and keeps riding while it
 * stays within the wider hold reach. While riding the body is on rails: it is
 * accelerated along the segment direction up to the ride speed, held to the
 * rail height instead of falling, steered a little by the side input, pulled
 * back to the centreline, and it never collides with the tube. Jumping does
 * nothing and the body lies prone. The ride ends once the body passes the end
 * of the last segment (or drifts out of reach); it then keeps its velocity and
 * the ordinary gravity or swim rules take over in the splash lane.
 */
export const SLIDE_RULES = Object.freeze({
  feetDrop: 1.1,      // rider's feet under the tube centreline (tools/compile-waterworld-reference.py SLIDE_FEET_DROP)
  boost: 1.5,         // ride speed over the authored push speed (170 Source units/s -> 8 voxels/s)
  accel: 9,           // 1/s blend of the along-tube speed toward the ride speed
  steer: 1.5,         // voxels/s of lateral movement from a full side input
  steerLimit: 0.5,    // voxels either side of the centreline a rider may drift
  centring: 4,        // 1/s pull back to the centreline
  settle: 10,         // voxels/s the feet may move vertically toward the rail
  entryReach: 1.4,    // horizontal distance to the centreline that starts a ride
  holdReach: 2.4,     // horizontal distance that keeps a ride going
  entryAbove: 1.2, entryBelow: 1.6,   // feet window around the rail feet height to start
  holdAbove: 2.5, holdBelow: 2.5,     // feet window that keeps a ride going
});

const segmentCache = new WeakMap();

function segmentsOf(slide) {
  let segments = segmentCache.get(slide);
  if (segments) return segments;
  segments = [];
  const path = Array.isArray(slide?.path) ? slide.path : [];
  for (let i = 0; i + 1 < path.length; i++) {
    const [ax, ay, az] = path[i];
    const [bx, by, bz] = path[i + 1];
    const dx = bx - ax, dz = bz - az;
    const length = Math.hypot(dx, dz);
    if (!(length > 1e-6)) continue;
    const hx = dx / length, hz = dz / length;
    segments.push({ ax, ay, az, by, length, hx, hz, px: -hz, pz: hx });
  }
  segmentCache.set(slide, segments);
  return segments;
}

function railFeet(segment, t) {
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  return segment.ay + (segment.by - segment.ay) * clamped - SLIDE_RULES.feetDrop;
}

function probe(segment, x, y, z) {
  const dx = x - segment.ax, dz = z - segment.az;
  const along = dx * segment.hx + dz * segment.hz;
  return { along, t: along / segment.length, lateral: dx * segment.px + dz * segment.pz,
    rise: y - railFeet(segment, along / segment.length) };
}

/**
 * The slide segment carrying a body whose feet are at (x, y, z), or null.
 * `active` is the body's current ride ({ id, index }) so a rider keeps its
 * slide and only moves forward through the segments; without one every
 * segment of every slide may start a ride.
 */
export function slideContact(mapMeta, x, y, z, active = null) {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  const slides = Array.isArray(mapMeta?.slides) ? mapMeta.slides : [];
  if (!slides.length) return null;
  const rules = SLIDE_RULES;
  if (active) {
    const slide = slides.find((candidate) => candidate.id === active.id);
    const segments = slide ? segmentsOf(slide) : [];
    const first = Math.max(0, active.index | 0);
    for (let index = first; index < segments.length && index <= first + 2; index++) {
      const segment = segments[index];
      const hit = probe(segment, x, y, z);
      if (hit.along > segment.length + (index === segments.length - 1 ? 0 : 0.5)) continue;
      if (hit.along < -0.5 || Math.abs(hit.lateral) > rules.holdReach
        || hit.rise > rules.holdAbove || hit.rise < -rules.holdBelow) return null;
      return { slide, segment, index, t: hit.t, lateral: hit.lateral };
    }
    return null;
  }
  let best = null;
  for (const slide of slides) {
    const segments = segmentsOf(slide);
    for (let index = 0; index < segments.length; index++) {
      const segment = segments[index];
      const hit = probe(segment, x, y, z);
      if (hit.along < 0 || hit.along > segment.length || Math.abs(hit.lateral) > rules.entryReach
        || hit.rise > rules.entryAbove || hit.rise < -rules.entryBelow) continue;
      if (!best || Math.abs(hit.lateral) < Math.abs(best.lateral)) {
        best = { slide, segment, index, t: hit.t, lateral: hit.lateral };
      }
    }
  }
  return best;
}

/**
 * Advance a riding body one step. `position` and `velocity` are {x, y, z}
 * objects updated in place; `wish` is the normalised horizontal input
 * direction (its component across the tube steers). Returns the ride state to
 * remember for the next step.
 */
export function stepSlideRide(position, velocity, ride, dt, wish = null) {
  const rules = SLIDE_RULES;
  const { segment, slide } = ride;
  const along = velocity.x * segment.hx + velocity.z * segment.hz;
  const blend = 1 - Math.exp(-rules.accel * dt);
  const target = (Number.isFinite(slide.speed) ? slide.speed : 5) * rules.boost;
  const nextAlong = along + (target - along) * blend;
  const lateral = (position.x - segment.ax) * segment.px + (position.z - segment.az) * segment.pz;
  const input = wish ? Math.max(-1, Math.min(1, wish.x * segment.px + wish.z * segment.pz)) : 0;
  const drift = input * rules.steer - lateral * rules.centring;
  const nextLateral = Math.max(-rules.steerLimit, Math.min(rules.steerLimit, lateral + drift * dt));
  const lateralSpeed = dt > 0 ? (nextLateral - lateral) / dt : 0;
  velocity.x = segment.hx * nextAlong + segment.px * lateralSpeed;
  velocity.z = segment.hz * nextAlong + segment.pz * lateralSpeed;
  position.x += velocity.x * dt;
  position.z += velocity.z * dt;
  const advanced = (position.x - segment.ax) * segment.hx + (position.z - segment.az) * segment.hz;
  const feet = railFeet(segment, advanced / segment.length);
  const limit = rules.settle * dt;
  const dy = Math.max(-limit, Math.min(limit, feet - position.y));
  velocity.y = dt > 0 ? dy / dt : 0;
  position.y += dy;
  return { id: slide.id, index: ride.index };
}
