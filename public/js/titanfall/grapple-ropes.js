// Titanfall grapple ropes (playtest: the grapple pulled with nothing drawn). One LineSegments
// draw for every grappling pilot: a rope from the hand to the replicated anchor (tf[6] for remote
// pilots, physics.pilot.grapple.anchor for the local one) plus a small three-prong hook at the
// anchor. Pure presentation; owned by pilot-client.js (prepare / frame / dispose).

export const GRAPPLE_ROPES = Object.freeze({
  max: 16,            // ropes drawn at once
  hand: 1.32,         // m above the feet a remote pilot's rope starts
  selfDrop: 0.32,     // m under the camera the local rope starts (out of the screen centre)
  selfSide: 0.22,     // m to the right of the camera
  staleMs: 160,       // a remote rope not refreshed this long is dropped
  hook: 0.28,         // m prong length
  color: 0xd9e3ea,
});

const SEGMENTS_PER_ROPE = 4;   // rope + 3 prongs

/** Pure: the vertex list [x,y,z,...] of one rope (from → to) with its hook prongs. */
export function ropeVertices(from, to, out = [], hook = GRAPPLE_ROPES.hook) {
  const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2], len = Math.hypot(dx, dy, dz) || 1;
  const ux = dx / len, uy = dy / len, uz = dz / len;
  out.push(from[0], from[1], from[2], to[0], to[1], to[2]);
  // Prongs: back along the rope and out on three sides of it.
  const sx = Math.abs(uy) < 0.9 ? 0 : 1, sy = Math.abs(uy) < 0.9 ? 1 : 0;
  let px = uy * 0 - uz * sy, py = uz * sx - ux * 0, pz = ux * sy - uy * sx;
  const pl = Math.hypot(px, py, pz) || 1; px /= pl; py /= pl; pz /= pl;
  const qx = uy * pz - uz * py, qy = uz * px - ux * pz, qz = ux * py - uy * px;
  for (let k = 0; k < 3; k++) {
    const a = k * Math.PI * 2 / 3, c = Math.cos(a), s = Math.sin(a);
    const ox = (px * c + qx * s) * 0.8 - ux * 0.6, oy = (py * c + qy * s) * 0.8 - uy * 0.6, oz = (pz * c + qz * s) * 0.8 - uz * 0.6;
    out.push(to[0], to[1], to[2], to[0] + ox * hook, to[1] + oy * hook, to[2] + oz * hook);
  }
  return out;
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class GrappleRopes {
  constructor(THREE, parent) {
    this.remote = new Map();   // id -> { from, to, at }
    this.vertices = [];
    const n = GRAPPLE_ROPES.max * SEGMENTS_PER_ROPE * 2 * 3;
    this.positions = new Float32Array(n);
    this.geometry = new THREE.BufferGeometry();
    this.attribute = new THREE.BufferAttribute(this.positions, 3);
    this.attribute.setUsage?.(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('position', this.attribute);
    this.geometry.setDrawRange(0, 0);
    this.material = new THREE.LineBasicMaterial({ color: GRAPPLE_ROPES.color, transparent: true, opacity: 0.9, depthWrite: false });
    this.lines = new THREE.LineSegments(this.geometry, this.material);
    this.lines.name = 'titanfall-grapple-ropes';
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 2;
    // Visible with an empty draw range: the shader warm-up links its program at load.
    parent?.add(this.lines);
  }

  /** A remote pilot's rope this frame (AvatarRoster hook), or none (`anchor` null). */
  setRemote(id, feet, anchor) {
    const key = String(id);
    if (!Array.isArray(anchor) || !feet || ![feet.x, feet.y, feet.z].every(Number.isFinite)) { this.remote.delete(key); return; }
    let rope = this.remote.get(key);
    if (!rope) { rope = { from: [0, 0, 0], to: [0, 0, 0], at: 0 }; this.remote.set(key, rope); }
    rope.from[0] = feet.x; rope.from[1] = feet.y + GRAPPLE_ROPES.hand; rope.from[2] = feet.z;
    rope.to[0] = anchor[0]; rope.to[1] = anchor[1]; rope.to[2] = anchor[2];
    rope.at = now();
  }

  /** Rebuild the draw: the local rope (camera, yaw, anchor) and every fresh remote one. */
  update(local = null) {
    const out = this.vertices;
    out.length = 0;
    let count = 0;
    if (local && Array.isArray(local.anchor) && local.camera) {
      const c = local.camera, yaw = Number.isFinite(local.yaw) ? local.yaw : 0;
      const from = [c.x + Math.cos(yaw) * GRAPPLE_ROPES.selfSide, c.y - GRAPPLE_ROPES.selfDrop, c.z - Math.sin(yaw) * GRAPPLE_ROPES.selfSide];
      ropeVertices(from, local.anchor, out);
      count++;
    }
    const t = now();
    for (const [id, rope] of this.remote) {
      if (t - rope.at > GRAPPLE_ROPES.staleMs) { this.remote.delete(id); continue; }
      if (count >= GRAPPLE_ROPES.max) break;
      ropeVertices(rope.from, rope.to, out);
      count++;
    }
    this.positions.set(out.length <= this.positions.length ? out : out.slice(0, this.positions.length));
    this.geometry.setDrawRange(0, Math.min(out.length, this.positions.length) / 3);
    if (out.length) { this.attribute.needsUpdate = true; this.geometry.computeBoundingSphere?.(); }
    return count;
  }

  dispose() {
    this.lines.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
    this.remote.clear();
  }
}
