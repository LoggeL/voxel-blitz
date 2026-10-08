/**
 * Conquest parachutes and the jet's ejection seat (presentation only; the
 * server owns the state, see shared/parachute.js). Every body whose snapshot
 * row carries `cq[7]` gets a voxel canopy with lines (team-relative tint: own
 * blue, enemy orange) or, while it rides the ejection seat, a seat with a
 * rocket plume. The `ejection` event throws the jet's canopy glass clear.
 * One merged mesh and one line set per body; transient debris is a few boxes.
 */
import * as THREE from '../vendor/three.module.js';
import { CHUTE, EJECTION } from '../../../shared/parachute.js';

export const PARACHUTE_FX = Object.freeze({
  colors: Object.freeze({ own: 0x4cc3ff, enemy: 0xff8a3d, stripe: 0xe9edf0, line: 0x2a2f33, seat: 0x3b4146, glass: 0x9fd4ff }),
  segments: 9, arcRadius: 3, arcDegrees: 110, apex: 5.1, depth: 2.1, thickness: 0.16,
  openSeconds: 0.45, debrisSeconds: 3, maxDebris: 12,
  // First person: the own canopy rides higher and behind the eye, so a level
  // view shows only the risers rising past the frame; looking up shows it all.
  firstPerson: Object.freeze({ lift: 2.2, back: 1.3, shoulder: Object.freeze([0.36, 1.48, -0.28]) }),
});

const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
const chuteOf = row => {
  const value = Array.isArray(row?.cq) ? row.cq[7] : 0;
  return value === CHUTE.open || value === CHUTE.seat ? value : CHUTE.none;
};

/** Merge boxes ({w,h,d, x,y,z, rz, color}) into one vertex-coloured geometry. */
function mergedBoxes(boxes) {
  const positions = [], normals = [], colors = [];
  const matrix = new THREE.Matrix4(), color = new THREE.Color(), rotation = new THREE.Matrix4();
  for (const box of boxes) {
    const geometry = new THREE.BoxGeometry(box.w, box.h, box.d).toNonIndexed();
    matrix.makeTranslation(box.x, box.y, box.z).multiply(rotation.makeRotationZ(box.rz || 0));
    geometry.applyMatrix4(matrix);
    positions.push(...geometry.attributes.position.array);
    normals.push(...geometry.attributes.normal.array);
    color.setHex(box.color);
    // Baked top light (the material is unlit): the canopy's underside, which the
    // jumper sees, stays readable in its team colour instead of going black.
    const normal = geometry.attributes.normal.array;
    for (let i = 0; i < geometry.attributes.position.count; i++) {
      const ny = normal[i * 3 + 1], shade = ny > 0.5 ? 1 : ny < -0.5 ? 0.72 : 0.84;
      colors.push(color.r * shade, color.g * shade, color.b * shade);
    }
    geometry.dispose();
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  merged.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  merged.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  merged.computeBoundingSphere();
  return merged;
}

/** Canopy arc: alternating team and white panels, local origin at the jumper's feet. */
export function canopyBoxes(tint, P = PARACHUTE_FX) {
  const boxes = [], span = P.arcDegrees * Math.PI / 180, centerY = P.apex - P.arcRadius;
  const width = P.arcRadius * span / P.segments + 0.04;
  for (let i = 0; i < P.segments; i++) {
    const a = -span / 2 + span * (i + 0.5) / P.segments;
    boxes.push({ w: width, h: P.thickness, d: P.depth, x: P.arcRadius * Math.sin(a), y: centerY + P.arcRadius * Math.cos(a), z: 0, rz: -a,
      color: i % 2 ? P.colors.stripe : tint });
  }
  return boxes;
}

/**
 * Suspension lines from the canopy skirt to the shoulders (pairs of points),
 * in canopy-local space: `offset` is where the canopy sits relative to the
 * feet and `shoulder` [x, y, z] the riser end relative to the feet.
 */
export function canopyLines(P = PARACHUTE_FX, { offset = [0, 0, 0], shoulder = [0.2, 1.3, 0.12] } = {}) {
  const span = P.arcDegrees * Math.PI / 180, centerY = P.apex - P.arcRadius, points = [];
  for (const a of [-span / 2, -span / 6, span / 6, span / 2]) {
    const x = P.arcRadius * Math.sin(a), y = centerY + P.arcRadius * Math.cos(a) - P.thickness / 2;
    for (const z of [-P.depth / 2 + 0.1, P.depth / 2 - 0.1]) {
      points.push(x, y, z, Math.sign(x) * shoulder[0] - offset[0], shoulder[1] - offset[1], shoulder[2] - offset[2]);
    }
  }
  return points;
}

const SEAT_BOXES = [
  { w: 0.62, h: 0.14, d: 0.62, x: 0, y: 0.42, z: 0.05, color: PARACHUTE_FX.colors.seat },
  { w: 0.62, h: 0.95, d: 0.14, x: 0, y: 0.9, z: 0.36, color: PARACHUTE_FX.colors.seat },
  { w: 0.22, h: 0.3, d: 0.22, x: 0, y: 0.2, z: 0.2, color: 0x1c1f22 },
];

export class ParachuteFx {
  constructor({ group, fx = null, cameraShake = null, sfx = null } = {}) {
    this.group = group || null;
    this.fx = fx;
    this.shake = cameraShake;
    // Optional audio facade: ejection bang, canopy snap and the descent wind loop.
    this.sfx = sfx;
    this.material = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
    this.lineMaterial = new THREE.LineBasicMaterial({ color: PARACHUTE_FX.colors.line });
    this.glassMaterial = new THREE.MeshLambertMaterial({ color: PARACHUTE_FX.colors.glass, transparent: true, opacity: 0.6 });
    this.geometries = {
      own: mergedBoxes(canopyBoxes(PARACHUTE_FX.colors.own)),
      enemy: mergedBoxes(canopyBoxes(PARACHUTE_FX.colors.enemy)),
      seat: mergedBoxes(SEAT_BOXES),
      glass: new THREE.BoxGeometry(1.1, 0.35, 1.7),
    };
    const lines = (points) => {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
      return geometry;
    };
    const fp = PARACHUTE_FX.firstPerson;
    this.firstPersonOffset = [0, fp.lift, fp.back];
    this.geometries.lines = lines(canopyLines());
    this.geometries.firstPersonLines = lines(canopyLines(PARACHUTE_FX, { offset: this.firstPersonOffset, shoulder: fp.shoulder }));
    this.bodies = new Map();   // player id -> { root, canopy, lines, seat, state, rel, age, plume }
    this.debris = [];
    this.time = 0;
    this._disposed = false;
  }

  get count() { return this.bodies.size; }

  _body(id, rel, firstPerson = false) {
    let body = this.bodies.get(id);
    if (body && (body.rel !== rel || body.firstPerson !== firstPerson)) { this._drop(id); body = null; }
    if (body) return body;
    const root = new THREE.Group();
    root.name = `parachute-${id}`;
    const canopy = new THREE.Group();
    canopy.add(new THREE.Mesh(this.geometries[rel], this.material));
    canopy.add(new THREE.LineSegments(firstPerson ? this.geometries.firstPersonLines : this.geometries.lines, this.lineMaterial));
    // The own (first-person) canopy sits higher and behind the eye; everyone else's over the body.
    if (firstPerson) canopy.position.fromArray(this.firstPersonOffset);
    const seat = new THREE.Mesh(this.geometries.seat, this.material);
    root.add(canopy, seat);
    this.group?.add(root);
    body = { id, root, canopy, seat, rel, firstPerson, state: CHUTE.none, age: 0, plume: null, glow: null, pos: [0, 0, 0], seen: true };
    this.bodies.set(id, body);
    return body;
  }

  _endPlume(body) {
    if (body.plume) this.fx?.removeEmitter?.(body.plume);
    if (body.glow) this.fx?.removeEmitter?.(body.glow);
    body.plume = body.glow = null;
  }

  _drop(id) {
    const body = this.bodies.get(id);
    if (!body) return;
    this._endPlume(body);
    if (body.state === CHUTE.open) this.sfx?.stopParachuteDescent?.(`chute:${id}`);
    body.root.removeFromParent();
    this.bodies.delete(id);
  }

  _debris(geometry, material, pos, velocity, spin) {
    if (this.debris.length >= PARACHUTE_FX.maxDebris) { const old = this.debris.shift(); old.mesh.removeFromParent(); }
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(pos[0], pos[1], pos[2]);
    this.group?.add(mesh);
    this.debris.push({ mesh, v: [...velocity], spin: [...spin], age: 0 });
  }

  /**
   * Authoritative `ejection` event: the canopy glass flies off and a local
   * pilot feels the seat fire. Returns true when handled.
   */
  eject(ev, selfId = null) {
    const pos = Array.isArray(ev?.pos) && ev.pos.every(Number.isFinite) ? ev.pos : null;
    if (!pos || this._disposed) return false;
    const vel = Array.isArray(ev.vel) && ev.vel.every(Number.isFinite) ? ev.vel : [0, 0, 0];
    const yaw = finite(ev.yaw), back = [Math.sin(yaw), 0, Math.cos(yaw)];
    this._debris(this.geometries.glass, this.glassMaterial, [pos[0], pos[1] + 0.9, pos[2]],
      [vel[0] * 0.4 + back[0] * 6, 12 + Math.max(0, vel[1] * 0.3), vel[2] * 0.4 + back[2] * 6], [3.1, 0.8, 2.2]);
    this.fx?.emit?.('muzzle', [pos[0], pos[1] + 0.3, pos[2]], { count: 1, scale: 0.9, dir: [0, -1, 0] });
    this.fx?.emit?.('smoke', [pos[0], pos[1], pos[2]], { count: 10, dir: [0, -1, 0], speed: 3, scale: 1.1, spread: 0.6 });
    const self = selfId != null && String(ev.id) === String(selfId);
    if (self) this.shake?.add?.(0.55);
    this.sfx?.ejectionSeat?.(pos, { self });
    return true;
  }

  /**
   * Per frame. `rows` are the latest snapshot rows (they carry cq); remote
   * bodies sit at `positionOf(id)` (the presented avatar), the local one at
   * `local` = { pos:{x,y,z}, yaw, chute } (its predicted state).
   */
  sync(rows, { selfId = null, selfTeam = null, local = null, positionOf = null, dt = 0 } = {}) {
    if (this._disposed) return;
    const step = Math.max(0, Math.min(0.1, finite(dt)));
    this.time += step;
    for (const body of this.bodies.values()) body.seen = false;
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!row || row.state === 'dead' || row.vehicleId) continue;
      const self = selfId != null && String(row.id) === String(selfId);
      const state = self && local ? local.chute | 0 : chuteOf(row);
      if (!state) continue;
      const at = self && local?.pos ? local.pos : positionOf?.(row.id) ?? row;
      if (![at?.x, at?.y, at?.z].every(Number.isFinite)) continue;
      const rel = selfTeam && row.team && row.team !== selfTeam ? 'enemy' : 'own';
      const body = this._body(String(row.id), rel, !!(self && local?.pos));
      body.seen = true;
      this._present(body, state, at, self ? finite(local?.yaw, finite(row.yaw)) : finite(row.yaw), step);
    }
    for (const [id, body] of [...this.bodies]) {
      if (body.seen) continue;
      this._drop(id);
    }
    this._stepDebris(step);
  }

  _present(body, state, at, yaw, step) {
    if (state !== body.state) {
      // Leaving the seat: it tumbles away below the opening canopy.
      if (body.state === CHUTE.seat && state === CHUTE.open) {
        this._debris(this.geometries.seat, this.material, [at.x, at.y + 0.2, at.z], [Math.sin(yaw) * 2, -1, Math.cos(yaw) * 2], [1.6, 0.4, 2.4]);
      }
      if (state !== CHUTE.seat) this._endPlume(body);
      if (state === CHUTE.open) this.sfx?.parachuteOpen?.([at.x, at.y + 3, at.z], { self: body.firstPerson });
      else if (body.state === CHUTE.open) this.sfx?.stopParachuteDescent?.(`chute:${body.id}`);
      body.state = state; body.age = 0;
    }
    body.age += step;
    body.pos[0] = at.x; body.pos[1] = at.y; body.pos[2] = at.z;
    body.root.position.set(at.x, at.y, at.z);
    body.root.rotation.set(0, yaw, 0);
    body.seat.visible = state === CHUTE.seat;
    body.canopy.visible = state === CHUTE.open;
    if (state === CHUTE.open) {
      this.sfx?.parachuteDescent?.(`chute:${body.id}`, [at.x, at.y + 3, at.z], { self: body.firstPerson });
      const open = Math.min(1, 0.15 + body.age / PARACHUTE_FX.openSeconds);
      body.canopy.scale.set(open, Math.min(1, open * 1.2), open);
      // A slow pendulum sway under the canopy.
      body.canopy.rotation.z = Math.sin(this.time * 1.3 + body.pos[0]) * 0.06;
      body.canopy.rotation.x = Math.sin(this.time * 0.9 + body.pos[2]) * 0.04;
    } else if (state === CHUTE.seat) {
      const burning = body.age < EJECTION.rocketSeconds;
      if (burning && !body.plume && this.fx?.addEmitter) {
        const nozzle = () => [body.pos[0], body.pos[1] + 0.1, body.pos[2]];
        body.plume = this.fx.addEmitter({ kind: 'smoke', pos: nozzle, rate: 60, params: { speed: 0.4, scale: 0.55, life: 0.9, spread: Math.PI } }) || null;
        body.glow = this.fx.addEmitter({ kind: 'fire', pos: nozzle, rate: 50, params: { speed: 0.2, scale: 0.45, life: 0.2 } }) || null;
      } else if (!burning) this._endPlume(body);
    }
  }

  _stepDebris(step) {
    for (let i = this.debris.length - 1; i >= 0; i--) {
      const item = this.debris[i];
      item.age += step;
      if (item.age >= PARACHUTE_FX.debrisSeconds) { item.mesh.removeFromParent(); this.debris.splice(i, 1); continue; }
      item.v[1] -= 24 * step;
      item.mesh.position.x += item.v[0] * step; item.mesh.position.y += item.v[1] * step; item.mesh.position.z += item.v[2] * step;
      item.mesh.rotation.x += item.spin[0] * step; item.mesh.rotation.y += item.spin[1] * step; item.mesh.rotation.z += item.spin[2] * step;
    }
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    for (const id of [...this.bodies.keys()]) this._drop(id);
    for (const item of this.debris) item.mesh.removeFromParent();
    this.debris.length = 0;
    for (const geometry of Object.values(this.geometries)) geometry.dispose();
    this.material.dispose(); this.lineMaterial.dispose(); this.glassMaterial.dispose();
  }
}
