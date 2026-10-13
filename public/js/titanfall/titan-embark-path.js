// The embark walk-in (docs/titanfall.md §7.2, Embark and disembark): where the boarding pilot is at
// a point of the embark lock, from the posed titan rig. The remote avatar proxy
// (titan-presentation.js embarkPilot) and the own first-person camera (titan-transit.js) follow the
// same path, so the camera rides the palm the others see. Presentation only.
import * as THREE from '../vendor/three.module.js';

const _w = new THREE.Vector3();
const smooth = k => k * k * (3 - 2 * k);
const clamp01 = k => Math.max(0, Math.min(1, k));
const lerp = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
const worldOf = node => node.getWorldPosition(_w).toArray();
const hullToWorld = (item, p) => item.model.group.localToWorld(_w.set(p[0], p[1], p[2])).toArray();

/** Path phases as shares of the embark lock (u = rig.embark, 0..1). */
export const EMBARK_PATH = Object.freeze({ run: 0.12, hop: 0.25, ride: 0.62, board: 0.8, hidden: 0.925 });

/**
 * Feet position and body pose of the boarding pilot at `u` of the embark lock, from the posed
 * rig of a titan VehicleView item: { pos: [x, y, z], crouch, hop, face (yaw), start, ready, palm,
 * entry, seat }. The rig and root must be posed this frame (matrixWorld current).
 */
export function embarkPath(item, u) {
  const model = item.model, skel = model.skeleton, k = clamp01(u), P = EMBARK_PATH;
  const hl = skel.def.collider.halfLength, yaw = item.root.rotation.y;
  // Run in from the front-left to a spot outboard of the left leg, under the lowered palm.
  const outX = -(Math.abs(skel.hipL[0]) + 0.7 + 1.25);
  const start = hullToWorld(item, [outX - 1.5, 0, -(hl + 4.0)]);
  const ready = hullToWorld(item, [outX - 0.3, 0, -(hl * 0.35) - 1.2]);
  // Feet on the palm top (the palm anchor sits on the palm face, which faces up while it carries).
  const palm = worldOf(model.anchors.palmL);
  // The cockpit seat (torso frame) and the point 1.3 m in front of the cavity opening, both
  // following the kneeling, bowing torso; the pilot ends half sunk behind the coaming.
  const cockpit = model.anchors.cockpit ?? model.anchors.seat;
  const seat = cockpit.localToWorld(_w.set(0, -0.3, 0)).toArray();
  const entry = cockpit.localToWorld(_w.set(0, 0.45, -1.3)).toArray();
  // 0-12 % run in, 12-25 % hop onto the low palm, 25-62 % ride it up, 62-80 % step off the palm in
  // front of the cavity and drop into the seat (never over the open hatch plate), then crouch
  // inside; hidden once the hatch is half closed (92.5 %).
  let pos, crouch = 0, hop = 0, face = yaw + Math.PI;
  if (k < P.run) pos = lerp(start, ready, smooth(k / P.run));
  else if (k < P.hop) {
    const j = (k - P.run) / (P.hop - P.run);
    if (j < 0.3) { pos = ready; crouch = Math.sin((j / 0.3) * Math.PI) * 0.8; }
    else { const s = smooth((j - 0.3) / 0.7); pos = lerp(ready, palm, s); pos[1] += Math.sin(s * Math.PI) * 1.2; hop = 1; }
  } else if (k < P.ride) { pos = palm; crouch = 0.55; face = yaw + Math.PI * (k < 0.45 ? 1 : 1 - smooth((k - 0.45) / 0.17)); }
  else if (k < P.board) {
    const j = smooth((k - P.ride) / (P.board - P.ride));
    const via = lerp(palm, entry, 0.6); via[1] = Math.max(palm[1], entry[1]) + 0.35;
    pos = j < 0.45 ? lerp(palm, via, j / 0.45) : j < 0.75 ? lerp(via, entry, (j - 0.45) / 0.3) : lerp(entry, seat, (j - 0.75) / 0.25);
    hop = j < 0.75 ? 1 : 0.4; face = yaw;
  } else { pos = seat; crouch = 1; face = yaw + Math.PI; }
  return { pos, crouch, hop, face, start, ready, palm, entry, seat };
}
