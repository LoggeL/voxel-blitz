// The SL-2 leaves a ferrule in the voxel, then draws a shuttle through a pair of
// pins. Only server contacts create world geometry. Every strand uses scene depth.
import * as THREE from '../vendor/three.module.js';
import { MAX_PLAYERS } from '../../../shared/lobby-limits.js';

const Z = new THREE.Vector3(0, 0, 1);
const TAU = Math.PI * 2;
const AFTERGLOW = 0.34;
const COLORS = {
  copper: new THREE.Color(0xe87e38),
  amber: new THREE.Color(0xffb65c),
  mint: new THREE.Color(0x91efce),
  hot: new THREE.Color(0xffedbe).multiplyScalar(1.7),
  dark: new THREE.Color(0x604335),
};
const PIN_REASONS = new Set(['short', 'long', 'blocked']);
const validPoint = p => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite);
const clamp = THREE.MathUtils.clamp;

function polar(radius, angle, z) {
  return [Math.cos(angle) * radius, Math.sin(angle) * radius, z];
}

// Square-cut thread catches the light on opposite faces. Joining its ribs into
// one indexed geometry keeps a pin, cast or length of stitching to one draw.
class Filaments {
  positions = [];
  colors = [];
  roles = [];
  indices = [];

  strand(a, b, radius, tint, role = 0) {
    const start = new THREE.Vector3(...a), end = new THREE.Vector3(...b);
    const axis = end.clone().sub(start).normalize();
    const side = axis.clone().cross(Math.abs(axis.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : Z).normalize();
    const up = axis.clone().cross(side);
    const first = this.roles.length;
    for (const point of [start, end]) {
      for (let j = 0; j < 4; j++) {
        const angle = j * Math.PI / 2 + Math.PI / 4;
        const corner = point.clone().addScaledVector(side, radius * Math.cos(angle))
          .addScaledVector(up, radius * Math.sin(angle));
        const shade = [1, 0.85, 0.64, 0.8][j];
        this.positions.push(corner.x, corner.y, corner.z);
        this.colors.push(tint.r * shade, tint.g * shade, tint.b * shade);
        this.roles.push(role);
      }
    }
    for (let j = 0; j < 4; j++) {
      const k = (j + 1) % 4;
      this.indices.push(first + j, first + k, first + j + 4, first + k, first + k + 4, first + j + 4);
    }
    this.indices.push(first, first + 2, first + 1, first, first + 3, first + 2,
      first + 4, first + 5, first + 6, first + 4, first + 6, first + 7);
  }

  build() {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(this.colors, 3));
    geometry.setAttribute('role', new THREE.Float32BufferAttribute(this.roles, 1));
    geometry.setIndex(this.indices);
    geometry.computeBoundingSphere();
    return geometry;
  }
}

function makePin() {
  const thread = new Filaments();
  // Four copper feet crimp onto the wall, an enamel registration band stands
  // off the face, and a light sits inside the open eye of the ferrule.
  for (let j = 0; j < 4; j++) {
    const a = j * Math.PI / 2;
    thread.strand(polar(0.31, a, -0.045), polar(0.23, a, 0.07), 0.032, COLORS.copper);
    thread.strand(polar(0.23, a, 0.07), polar(0.23, a + Math.PI / 2, 0.07), 0.028, COLORS.amber);
    thread.strand(polar(0.14, a + 0.16, 0.1), polar(0.14, a + 0.95, 0.1), 0.015, COLORS.mint);
    thread.strand(polar(0.037, a, 0.03), [0, 0, 0.25], 0.026, COLORS.hot);
  }
  return thread.build();
}

function makeSeam(count) {
  const thread = new Filaments();
  for (let j = 0; j < count; j++) {
    const z = j * 0.6;
    // A dashed warp shows both players where the travelling shuttle will go.
    thread.strand([0, 0, z], [0, 0, z + 0.37], 0.019, COLORS.mint);
    // Two angled threads change sides and interlock as the shuttle passes.
    for (const side of [-1, 1]) {
      const x = side * 0.12, tint = side > 0 ? COLORS.amber : COLORS.hot;
      thread.strand([-x, 0.028, z + 0.03], [x, -0.014, z + 0.4], 0.026, tint, 1);
      thread.strand([x, -0.014, z + 0.4], [x, 0.028, z + 0.55], 0.019, COLORS.copper, 1);
    }
  }
  return thread.build();
}

function makeShuttle() {
  const thread = new Filaments();
  // The moving crown outlines the actual sweep radius. Breaks between the
  // four arcs leave a view through the effect from inside the lane.
  for (let j = 0; j < 4; j++) {
    const angle = j * Math.PI / 2;
    for (let i = 0; i < 5; i++) {
      const a = angle + i * 0.22;
      thread.strand(polar(1, a, -0.1), polar(1, a + 0.22, -0.1), 0.026, COLORS.amber);
    }
    const wing = polar(0.4, angle, -0.24);
    thread.strand(wing, [0, 0, 0.09], 0.031, COLORS.hot);
    thread.strand(wing, [0, 0, -0.53], 0.025, COLORS.mint);
    thread.strand(polar(0.95, angle, -0.1), polar(0.79, angle, -0.23), 0.029, COLORS.copper);
  }
  thread.strand([0, 0, -0.52], [0, 0, 0.14], 0.048, COLORS.hot);
  return thread.build();
}

function makeCast() {
  const thread = new Filaments();
  for (let j = 0; j < 20; j++) {
    const angle = j * 0.62;
    const z = j * 0.6;
    const r = 0.034 * Math.sin(Math.PI * j / 20);
    thread.strand(polar(r, angle, z), polar(0.034 * Math.sin(Math.PI * (j + 1) / 20),
      angle + 0.62, z + 0.6), 0.014, j % 4 === 0 ? COLORS.hot : COLORS.amber);
  }
  return thread.build();
}

function makeKnot() {
  const thread = new Filaments();
  for (let j = 0; j < 6; j++) {
    const angle = j * TAU / 6;
    const elbow = polar(0.15, angle, j % 2 ? 0.06 : -0.06);
    thread.strand([0, 0, 0], elbow, 0.022, COLORS.hot);
    thread.strand(elbow, polar(0.28, angle + 0.55, 0.02), 0.015, COLORS.amber);
  }
  return thread.build();
}

const VERTEX = `
  #include <fog_pars_vertex>
  attribute float role;
  varying float vRole;
  varying vec3 vTint;
  varying float vLength;
  void main() {
    vRole = role;
    vTint = color;
    vLength = position.z;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }`;
const FRAGMENT = `
  #include <fog_pars_fragment>
  uniform float fade;
  uniform float designLength;
  uniform float front;
  uniform float duration;
  varying float vRole;
  varying vec3 vTint;
  varying float vLength;
  void main() {
    float alpha = fade;
    float gain = 1.0;
    if (designLength > 0.0) {
      float sincePass = (front - vLength / designLength) * duration;
      float wake = 1.0 - smoothstep(0.04, 0.34, sincePass);
      float lit = smoothstep(-0.04, 0.005, sincePass);
      alpha *= vRole > 0.5 ? lit * (0.12 + 0.88 * wake) : 0.52 + lit * wake * 0.36;
      gain += 1.25 * lit * wake;
    }
    if (alpha < 0.012) discard;
    gl_FragColor = vec4(vTint * gain, alpha);
    #include <colorspace_fragment>
    #include <fog_fragment>
  }`;

function threadMaterial() {
  return new THREE.ShaderMaterial({
    vertexShader: VERTEX, fragmentShader: FRAGMENT, vertexColors: true,
    uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      fade: { value: 1 }, designLength: { value: 0 }, front: { value: 0 }, duration: { value: 1 } },
    fog: true, toneMapped: false, transparent: true, depthTest: true, depthWrite: false,
  });
}

// A broad edge with a tiny hot centre reads as light even on a low tier with
// bloom disabled. The pin's halo lies on the contacted face; the shuttle's
// glow is a small sprite at the centre of its open crown.
function makeGlowTexture() {
  const size = 48;
  const rgba = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = (x + 0.5) * 2 / size - 1, dy = (y + 0.5) * 2 / size - 1;
    const radius = Math.hypot(dx, dy);
    const alpha = Math.max(0, 1 - radius) ** 2.9;
    const offset = (y * size + x) * 4;
    rgba[offset] = 255;
    rgba[offset + 1] = 155 + Math.round(80 * alpha);
    rgba[offset + 2] = 80 + Math.round(115 * alpha);
    rgba[offset + 3] = Math.round(255 * alpha);
  }
  const texture = new THREE.DataTexture(rgba, size, size);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

export class SelvedgeFX {
  constructor(scene, onHem = null) {
    this.scene = scene;
    this.onHem = onHem;
    this.pins = new Map();
    this.seams = new Map();
    this.flashes = [];
    this.geometry = new Map();
    this.freeMeshes = new Map();
    this.glowTexture = null;
    this.clock = 0;
  }

  _mesh(key, make) {
    if (!this.geometry.has(key)) this.geometry.set(key, make());
    if (!this.freeMeshes.has(key)) this.freeMeshes.set(key, []);
    const mesh = this.freeMeshes.get(key).pop() || new THREE.Mesh(this.geometry.get(key), threadMaterial());
    mesh.name = 'selvedge-' + key;
    mesh.userData.pool = key;
    mesh.visible = true;
    mesh.scale.setScalar(1);
    mesh.material.uniforms.fade.value = 1;
    mesh.material.uniforms.front.value = 0;
    this.scene.add(mesh);
    return mesh;
  }

  _glow(key, billboard) {
    if (!this.freeMeshes.has(key)) this.freeMeshes.set(key, []);
    const pool = this.freeMeshes.get(key);
    let glow = pool.pop();
    if (!glow) {
      this.glowTexture ??= makeGlowTexture();
      const options = { map: this.glowTexture, transparent: true, blending: THREE.AdditiveBlending,
        depthTest: true, depthWrite: false, toneMapped: false };
      if (billboard) glow = new THREE.Sprite(new THREE.SpriteMaterial(options));
      else {
        if (!this.geometry.has('wash')) this.geometry.set('wash', new THREE.PlaneGeometry());
        glow = new THREE.Mesh(this.geometry.get('wash'), new THREE.MeshBasicMaterial(options));
      }
      glow.name = 'selvedge-' + key;
      glow.userData.pool = key;
    }
    glow.visible = true;
    glow.material.opacity = 0.7;
    this.scene.add(glow);
    return glow;
  }

  _remove(fx) {
    if (!fx) return;
    for (const mesh of fx.meshes) {
      mesh.removeFromParent();
      const pool = this.freeMeshes.get(mesh.userData.pool);
      if (pool.length < 8) pool.push(mesh);
      else mesh.material.dispose();
    }
  }

  _drop(map, id) {
    this._remove(map.get(id));
    map.delete(id);
  }

  _put(map, id, fx) {
    this._drop(map, id);
    if (map.size >= MAX_PLAYERS) this._drop(map, map.keys().next().value);
    map.set(id, fx);
  }

  stitch(ev) {
    if (!ev || ev.id == null) return;
    if (ev.phase === 'clear') {
      if (ev.part !== 'seam') this._drop(this.pins, ev.id);
      if (ev.part !== 'pin') this._drop(this.seams, ev.id);
      return;
    }
    if (!validPoint(ev.a) || !Number.isFinite(ev.ms) || ev.ms <= 0) return;
    const a = new THREE.Vector3(...ev.a);
    const life = Math.min(30, ev.ms * 0.001);
    const age = Number.isFinite(ev.ageMs) ? Math.max(0, ev.ageMs * 0.001) : 0;
    if (ev.phase === 'pin' && validPoint(ev.n)) {
      if (age >= life) { this._drop(this.pins, ev.id); return; }
      const mesh = this._mesh('pin', makePin);
      mesh.position.copy(a);
      mesh.quaternion.setFromUnitVectors(Z, new THREE.Vector3(...ev.n).normalize());
      mesh.scale.setScalar(0.55);
      const wash = this._glow('pin-glow', false);
      wash.position.copy(a).addScaledVector(new THREE.Vector3(...ev.n), -0.042);
      wash.quaternion.copy(mesh.quaternion);
      wash.scale.setScalar(0.85);
      const reason = PIN_REASONS.has(ev.reason) ? ev.reason : null;
      this._put(this.pins, ev.id, { meshes: [mesh, wash], start: this.clock - age, life, reason });
    } else if (ev.phase === 'sew' && validPoint(ev.b)) {
      const b = new THREE.Vector3(...ev.b), dir = b.clone().sub(a);
      const length = dir.length();
      if (length < 0.01) return;
      this._drop(this.pins, ev.id);
      if (age >= life) { this._drop(this.seams, ev.id); return; }
      // A few reusable pitches accommodate short and long spans. Only the
      // spacing stretches. The width of the fibre stays constant in metres.
      const count = clamp(Math.round(length / 2.4), 1, 12) * 4;
      const warp = this._mesh('seam-' + count, () => makeSeam(count));
      const head = this._mesh('shuttle', makeShuttle);
      warp.position.copy(a);
      warp.quaternion.setFromUnitVectors(Z, dir.normalize());
      warp.scale.z = length / (count * 0.6);
      warp.material.uniforms.designLength.value = count * 0.6;
      warp.material.uniforms.duration.value = life;
      warp.material.uniforms.front.value = age / life;
      head.position.lerpVectors(a, b, age / life);
      head.quaternion.copy(warp.quaternion);
      const radius = Number.isFinite(ev.radius) ? clamp(ev.radius, 0.05, 4) : 0.9;
      head.scale.set(radius, radius, 1);
      const glow = this._glow('shuttle-glow', true);
      glow.position.copy(head.position);
      glow.scale.setScalar(0.79 * radius);
      this._put(this.seams, ev.id, { meshes: [warp, head, glow], a, b, start: this.clock - age, life, arrived: false });
    }
  }

  pinRemainingMs(id) {
    const fx = this.pins.get(id);
    return fx ? Math.max(0, (fx.life - (this.clock - fx.start)) * 1000) : 0;
  }

  pinReason(id) {
    const pin = this.pins.get(id);
    return pin && this.clock - pin.start < 1.3 ? pin.reason : null;
  }

  _flash(fx) {
    if (this.flashes.length >= MAX_PLAYERS * 2) this._remove(this.flashes.shift());
    this.flashes.push(fx);
  }

  shot(ev, visualOrigin) {
    if (!validPoint(ev?.end) || !validPoint(ev.o)) return;
    const origin = new THREE.Vector3(...ev.o);
    if (visualOrigin && visualOrigin.distanceToSquared(origin) < 9) origin.copy(visualOrigin);
    const axis = new THREE.Vector3(...ev.end).sub(origin);
    const length = axis.length();
    if (length < 0.01) return;
    const cast = this._mesh('cast', makeCast);
    cast.position.copy(origin);
    cast.quaternion.setFromUnitVectors(Z, axis.normalize());
    cast.scale.z = length / 12;
    this._flash({ meshes: [cast], start: this.clock, life: 0.13, knot: false });
  }

  tag(point) {
    if (!validPoint(point)) return;
    const knot = this._mesh('knot', makeKnot);
    knot.position.fromArray(point);
    knot.rotation.set(0.6, 0.7, 0.2);
    this._flash({ meshes: [knot], start: this.clock, life: 0.25, knot: true });
  }

  update(dt) {
    if (!Number.isFinite(dt) || dt < 0) return;
    this.clock += dt;
    for (const [id, pin] of this.pins) {
      const age = this.clock - pin.start;
      if (age >= pin.life) { this._drop(this.pins, id); continue; }
      const mesh = pin.meshes[0];
      // A short seating overshoot resolves into a quiet instrument light.
      mesh.scale.setScalar(1 - 0.45 * Math.exp(-age * 18) * Math.cos(age * 27));
      mesh.material.uniforms.fade.value = (0.92 + 0.08 * Math.cos(age * 4))
        * clamp((pin.life - age) / 0.23, 0, 1);
      pin.meshes[1].material.opacity = mesh.material.uniforms.fade.value * (0.55 + 0.35 * Math.exp(-age * 12));
    }
    for (const [id, seam] of this.seams) {
      const age = this.clock - seam.start;
      if (!seam.arrived && age >= seam.life) {
        seam.arrived = true;
        this.onHem?.(seam.b.toArray());
      }
      if (age >= seam.life + AFTERGLOW) { this._drop(this.seams, id); continue; }
      const [warp, head, glow] = seam.meshes;
      const t = age / seam.life;
      warp.material.uniforms.front.value = t;
      warp.material.uniforms.fade.value = clamp(1 - (age - seam.life) / AFTERGLOW, 0, 1);
      head.position.lerpVectors(seam.a, seam.b, Math.min(1, t));
      head.visible = !seam.arrived;
      glow.position.copy(head.position);
      glow.material.opacity = 0.8 * clamp(1 - (age - seam.life) / 0.18, 0, 1);
    }
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const flash = this.flashes[i];
      const t = (this.clock - flash.start) / flash.life;
      if (t >= 1) {
        this._remove(flash);
        this.flashes.splice(i, 1);
        continue;
      }
      const mesh = flash.meshes[0];
      mesh.material.uniforms.fade.value = (1 - t) ** 1.5;
      if (flash.knot) {
        mesh.scale.setScalar(0.4 + t * 1.9);
        mesh.rotation.z = 0.2 + t * 0.65;
      }
    }
  }

  clear() {
    for (const map of [this.pins, this.seams]) {
      for (const fx of map.values()) this._remove(fx);
      map.clear();
    }
    for (const fx of this.flashes) this._remove(fx);
    this.flashes.length = 0;
  }

  dispose() {
    this.clear();
    for (const geometry of this.geometry.values()) geometry.dispose();
    this.geometry.clear();
    this.glowTexture?.dispose();
    this.glowTexture = null;
    for (const pool of this.freeMeshes.values()) for (const mesh of pool) mesh.material.dispose();
    this.freeMeshes.clear();
  }
}
