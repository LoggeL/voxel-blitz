// Explosion scorch marks: a small fixed pool of dark radial decals seated on
// the top face of the block under a blast. One instanced draw, multiply
// blended (it only darkens what is already there), fading out over ~20 s.
// A mark follows the crater its own blast digs for a moment, then hides as
// soon as the block that carries it is destroyed or built over.
import * as THREE from '../vendor/three.module.js';

export const SCORCH_CAPACITY = 24;
const SCORCH_LIFE_S = 20;
const SCORCH_HOLD_S = 5;
/** The blast's own block damage lands after the flash; seat the mark behind it. */
const SCORCH_SEAT_DELAY_S = 0.12;
/** Within this window a lost support re-seats onto the crater floor instead of hiding. */
const SCORCH_RESEAT_WINDOW_S = 1.2;
const SCORCH_CHECK_INTERVAL_S = 0.25;
const SCORCH_EMBER_S = 1.6;
const SCORCH_LIFT = 0.012;
/** How far a mark may slide off the blast point to stay in front of a thin wall. */
const SCORCH_WALL_SHIFT = 1.2;
const TEXTURE_SIZE = 128;
// Eight probe directions for measuring a crater's rim.
const RIM_DX = Object.freeze([1, -1, 0, 0, 1, 1, -1, -1]);
const RIM_DZ = Object.freeze([0, 0, 1, -1, 1, -1, 1, -1]);

let scorchPixels = null;

function hash(x, y, seed) {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function noise(x, y, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi, seed), b = hash(xi + 1, yi, seed);
  const c = hash(xi, yi + 1, seed), d = hash(xi + 1, yi + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** Periodic in x (angle) so the radial streaks close without a seam. */
function angularNoise(angle, radius, seed, period) {
  const x = angle * period / (Math.PI * 2);
  const xi = Math.floor(x), xf = x - xi;
  const u = xf * xf * (3 - 2 * xf);
  const y = radius, yi = Math.floor(y), yf = y - yi;
  const v = yf * yf * (3 - 2 * yf);
  const x0 = ((xi % period) + period) % period, x1 = (x0 + 1) % period;
  const a = hash(x0, yi, seed), b = hash(x1, yi, seed);
  const c = hash(x0, yi + 1, seed), d = hash(x1, yi + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** R: soot darkness, G: ember glow mask. Radial char with blast streaks and a ragged rim. */
function scorchData() {
  if (scorchPixels) return scorchPixels;
  const size = TEXTURE_SIZE;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = (x + 0.5) / size * 2 - 1, py = (y + 0.5) / size * 2 - 1;
      const r = Math.hypot(px, py);
      const angle = Math.atan2(py, px);
      let grain = 0, amp = 0.5, norm = 0, f = 3.2;
      for (let o = 0; o < 4; o++) {
        grain += amp * noise(px * f + 11, py * f - 7, 31 + o);
        norm += amp; amp *= 0.5; f *= 2.05;
      }
      grain /= norm;
      const streak = angularNoise(angle, r * 2.2, 5, 23) * 0.6 + angularNoise(angle, r * 5, 9, 57) * 0.4;
      const rim = 0.78 + (streak - 0.5) * 0.2 + (grain - 0.5) * 0.3;
      const t = r / rim;
      // Charred plateau inside, ragged falloff towards the rim.
      const plateau = Math.max(0, Math.min(1, (1 - t) / 0.4));
      let soot = t >= 1 ? 0 : plateau * plateau * (3 - 2 * plateau) * 0.82 + (1 - t) * 0.18;
      soot *= 0.7 + grain * 0.55;
      // Blast rays reach past the rim as thin fading streaks.
      const ray = Math.max(0, streak - 0.55) * 2.2 * Math.max(0, 1 - r) * (1 - Math.min(1, t * 0.4));
      soot = Math.min(1, Math.max(soot, ray * 0.85));
      soot *= Math.min(1, Math.max(0, (0.98 - r) / 0.12));
      const ember = Math.max(0, 1 - r / (0.34 + grain * 0.22)) * Math.max(0, grain * 1.6 - 0.45);
      const i = (y * size + x) * 4;
      data[i] = Math.round(Math.min(1, soot) * 255);
      data[i + 1] = Math.round(Math.min(1, ember) * 255);
      data[i + 2] = 0;
      data[i + 3] = 255;
    }
  }
  scorchPixels = data;
  return data;
}

function createScorchTexture() {
  const texture = new THREE.DataTexture(scorchData(), TEXTURE_SIZE, TEXTURE_SIZE, THREE.RGBAFormat);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

export class ScorchDecals {
  /**
   * @param {THREE.Object3D} parent
   * @param {(x:number, y:number, z:number) => boolean} isSolid world-space solidity (floors itself)
   */
  constructor(parent, isSolid, { capacity = SCORCH_CAPACITY } = {}) {
    this.isSolid = isSolid;
    this.capacity = capacity;
    this.decals = Array.from({ length: capacity }, () => ({
      active: false, seated: false, age: 0, check: 0,
      ox: 0, oy: 0, oz: 0, depth: 0, size: 0, strength: 0, angle: 0,
      x: 0, y: 0, z: 0, bx: 0, by: 0, bz: 0, seatSize: 0,
      // Crater rim marks: a ring (hole = inner radius / half size) on the old surface.
      rim: false, hole: 0, rimPlaced: false, crater: false,
    }));
    this.cursor = 0;
    this._matrix = new THREE.Matrix4();
    this._rotation = new THREE.Matrix4();

    const geometry = new THREE.PlaneGeometry(1, 1);
    geometry.rotateX(-Math.PI / 2);
    this.params = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.params.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('scorch', this.params);
    this.material = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, depthTest: true, toneMapped: false, fog: true,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4,
      // Multiply: result = src * dst, so white leaves the ground untouched.
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.DstColorFactor,
      blendDst: THREE.ZeroFactor,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { scorchMap: { value: null } }]),
      vertexShader: `
        attribute vec3 scorch;
        varying vec2 scorchUv;
        varying vec3 scorchFade;
        #include <fog_pars_vertex>
        void main() {
          scorchUv = uv;
          scorchFade = scorch;
          vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }
      `,
      fragmentShader: `
        uniform sampler2D scorchMap;
        varying vec2 scorchUv;
        varying vec3 scorchFade;
        #include <fog_pars_fragment>
        void main() {
          vec4 mark = texture2D(scorchMap, scorchUv);
          // Rim marks keep only the ring outside the crater they surround.
          float r = length(scorchUv * 2.0 - 1.0);
          float keep = scorchFade.z > 0.0 ? smoothstep(scorchFade.z - 0.02, scorchFade.z + 0.12, r) : 1.0;
          float soot = mark.r * scorchFade.x * keep;
          vec3 tone = mix(vec3(1.0), vec3(0.085, 0.075, 0.07), soot);
          tone += mark.g * scorchFade.y * keep * vec3(2.4, 0.75, 0.12);
          gl_FragColor = vec4(tone, 1.0);
          #include <fog_fragment>
          #ifdef USE_FOG
            // Multiply blend: fog fades the mark towards "no change", not towards a dark hole.
            gl_FragColor = vec4(mix(tone, vec3(1.0), fogFactor), 1.0);
          #endif
        }
      `,
    });
    // Set after the merge: UniformsUtils.merge would clone the texture.
    this.material.uniforms.scorchMap.value = createScorchTexture();
    this.mesh = new THREE.InstancedMesh(geometry, this.material, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    // Drawn first among the transparent effects: it tints the ground under smoke and fire.
    this.mesh.renderOrder = 1;
    this.mesh.name = 'explosion-scorch';
    parent.add(this.mesh);
  }

  /** Queue a scorch under a blast at (x, y, z). `size` is the mark's diameter in metres. */
  place(x, y, z, size, strength = 1, angle = 0, depth = 3) {
    if (![x, y, z, size].every(Number.isFinite) || size <= 0) return null;
    const decal = this._take(null);
    decal.active = true;
    decal.seated = false;
    decal.rim = false;
    decal.rimPlaced = false;
    decal.crater = false;
    decal.hole = 0;
    decal.age = -SCORCH_SEAT_DELAY_S;
    decal.check = 0;
    decal.ox = x; decal.oy = y; decal.oz = z;
    decal.depth = depth;
    decal.size = size;
    decal.strength = Math.max(0, Math.min(1, strength));
    decal.angle = angle;
    return decal;
  }

  /** A free slot, else the oldest mark (never `keep`). */
  _take(keep) {
    for (let i = 0; i < this.capacity; i++) {
      const candidate = this.decals[(this.cursor + i) % this.capacity];
      if (!candidate.active) { this.cursor = (this.cursor + i + 1) % this.capacity; return candidate; }
    }
    let decal = this.decals[this.cursor];
    if (decal === keep) {
      this.cursor = (this.cursor + 1) % this.capacity;
      decal = this.decals[this.cursor];
    }
    this.cursor = (this.cursor + 1) % this.capacity;
    return decal;
  }

  /** Find the ground face under the blast point; false when it hangs too high. */
  _seat(decal) {
    const bx = Math.floor(decal.ox), bz = Math.floor(decal.oz);
    const top = Math.floor(decal.oy + 0.35);
    for (let by = top; by >= top - decal.depth; by--) {
      if (!this.isSolid(bx + 0.5, by + 0.5, bz + 0.5)) continue;
      if (this.isSolid(bx + 0.5, by + 1.5, bz + 0.5)) return false;
      decal.bx = bx; decal.by = by; decal.bz = bz;
      decal.x = decal.ox;
      decal.y = by + 1 + SCORCH_LIFT;
      decal.z = decal.oz;
      // The blast rested on a surface that is gone now: its own crater. The pit
      // mark sits on the crater floor; a ring on the old surface chars the rim.
      // The rim is the highest row above the pit floor that still rings it.
      if (!decal.rimPlaced && by < top - 1) {
        decal.rimPlaced = true;
        for (let level = top - 1; level > by && !decal.crater; level--) decal.crater = !!this._placeRim(decal, level);
      }
      // A blast well above the floor it scorches leaves a smaller mark (not
      // one that dug the pit it now lies in).
      const drop = decal.crater ? 0 : Math.max(0, decal.oy - (by + 1));
      decal.seatSize = this._fit(decal, by, decal.size * (1 - Math.min(0.5, drop / (decal.depth + 1) * 0.5)), 0);
      decal.seated = true;
      return true;
    }
    return false;
  }

  /**
   * Fit a mark of diameter `size` seated on block row `by` (centre at decal.x/z):
   * a ring of neighbours that drops away (a ledge, a step down) caps its reach
   * so it never floats in the air, and a thin wall slides the centre away (up
   * to SCORCH_WALL_SHIFT) or shrinks the mark so the plane does not come out
   * on the floor behind the wall. Wall columns in front merely hide the part
   * of the plane inside them through depth testing. Cells within `holeR` of
   * the blast (a crater rim's own hole) are ignored. Returns the fitted size.
   */
  _fit(decal, by, size, holeR) {
    const bx = decal.bx, bz = decal.bz;
    for (let ring = 1; ring <= 2; ring++) {
      if (size <= ring * 1.1) break;
      let missing = 0, total = 0;
      for (let dx = -ring; dx <= ring; dx++) {
        for (let dz = -ring; dz <= ring; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;
          const x = bx + dx + 0.5, z = bz + dz + 0.5;
          if (holeR > 0 && Math.hypot(x - decal.ox, z - decal.oz) < holeR + 0.5) continue;
          total++;
          if (!this.isSolid(x, by + 0.5, z)) missing++;
        }
      }
      if (total && missing > total * 0.25) { size = Math.min(size, ring * 1.1); break; }
    }
    const half = size * 0.5;
    const cellX = decal.x - bx, cellZ = decal.z - bz;
    const halfX = this._fitAxis(decal, by, half, 1, 0, 1 - cellX, cellX);
    const halfZ = this._fitAxis(decal, by, half, 0, 1, 1 - cellZ, cellZ);
    return 2 * Math.min(halfX, halfZ);
  }

  /** One axis of the thin-wall fit: moves decal.x or decal.z, returns the half extent. */
  _fitAxis(decal, by, half, dx, dz, offsetPos, offsetNeg) {
    let pos = this._wallGap(decal.bx, by, decal.bz, dx, dz, offsetPos, half);
    let neg = this._wallGap(decal.bx, by, decal.bz, -dx, -dz, offsetNeg, half);
    if (pos >= half && neg >= half) return half;
    // Positive shift moves the centre along +axis, away from the nearer thin wall.
    let shift = pos < half && neg < half ? (pos - neg) / 2 : pos < half ? -(half - pos) : half - neg;
    shift = Math.max(-SCORCH_WALL_SHIFT, Math.min(SCORCH_WALL_SHIFT, shift));
    // The side it slides towards now reaches further: look again that far.
    if (shift < 0) neg = this._wallGap(decal.bx, by, decal.bz, -dx, -dz, offsetNeg, half - shift);
    else if (shift > 0) pos = this._wallGap(decal.bx, by, decal.bz, dx, dz, offsetPos, half + shift);
    if (dx) decal.x += shift; else decal.z += shift;
    return Math.max(0.3, Math.min(half, pos - shift, neg + shift));
  }

  /**
   * Distance from the mark's centre to the near face of a wall along one
   * axis, when a plane reaching `limit` would come out behind that wall
   * (a thin wall); Infinity when it never does (open floor or thick wall).
   */
  _wallGap(bx, by, bz, dx, dz, offset, limit) {
    let wall = -1;
    for (let k = 1; k <= 4; k++) {
      const face = offset + k - 1;
      if (face >= limit) break;
      // Cell k spans [face, face + 1] from the centre.
      const x = bx + dx * k + 0.5, z = bz + dz * k + 0.5;
      if (this.isSolid(x, by + 1.5, z)) { if (wall < 0) wall = face; } else if (wall >= 0) return wall;
    }
    return Infinity;
  }

  /**
   * Ring mark on the surface a crater was dug out of. Probes eight directions
   * on row `rimBy` for the first intact surface cell; their distances set the
   * hole (between the mean and the farthest, so little soot hangs over the
   * pit). Skipped unless most directions find a rim (then it is a ledge or a
   * pre-existing drop, not a crater).
   */
  _placeRim(pit, rimBy) {
    const cx = Math.floor(pit.ox), cz = Math.floor(pit.oz);
    let found = 0, far = 0, sum = 0, ax = 0, az = 0;
    for (let d = 0; d < 8; d++) {
      for (let k = 1; k <= 4; k++) {
        const x = cx + RIM_DX[d] * k, z = cz + RIM_DZ[d] * k;
        if (!this.isSolid(x + 0.5, rimBy + 0.5, z + 0.5)) continue;
        if (this.isSolid(x + 0.5, rimBy + 1.5, z + 0.5)) break;
        // Nearest point of that cell to the blast: the pit ends there.
        const nx = Math.max(0, Math.abs(x + 0.5 - pit.ox) - 0.5);
        const nz = Math.max(0, Math.abs(z + 0.5 - pit.oz) - 0.5);
        const reach = Math.hypot(nx, nz);
        far = Math.max(far, reach);
        sum += reach;
        if (!found) { ax = x; az = z; }
        found++;
        break;
      }
    }
    if (found < 5) return null;
    const holeR = (sum / found + far) * 0.5;
    const rim = this._take(pit);
    rim.active = true;
    rim.seated = true;
    rim.rim = true;
    rim.rimPlaced = true;
    rim.crater = false;
    rim.age = pit.age;
    rim.check = SCORCH_CHECK_INTERVAL_S;
    rim.ox = pit.ox; rim.oy = pit.oy; rim.oz = pit.oz;
    rim.depth = 0;
    rim.strength = pit.strength;
    rim.angle = pit.angle + 1.3;
    // Its support is an intact rim cell, not the (gone) cell under the blast.
    rim.bx = ax; rim.by = rimBy; rim.bz = az;
    rim.x = pit.ox; rim.y = rimBy + 1 + SCORCH_LIFT; rim.z = pit.oz;
    // The texture's soot ends near 0.78 of the half size: leave a charred band
    // about as wide as a third of the plain mark beyond the hole.
    rim.size = Math.max(pit.size, 2 * (holeR + Math.max(1, pit.size * 0.3)) / 0.78);
    // Fit around the blast column, but keep the anchor cell as its support.
    rim.bx = cx; rim.bz = cz;
    const size = this._fit(rim, rimBy, rim.size, holeR);
    rim.bx = ax; rim.bz = az;
    rim.seatSize = Math.max(size, 2 * holeR + 0.6);
    rim.hole = Math.min(0.85, holeR / (rim.seatSize * 0.5));
    return rim;
  }

  _supported(decal) {
    const x = decal.bx + 0.5, z = decal.bz + 0.5;
    return this.isSolid(x, decal.by + 0.5, z) && !this.isSolid(x, decal.by + 1.5, z);
  }

  update(dt) {
    const step = Math.max(0, dt);
    let count = 0;
    for (let i = 0; i < this.capacity; i++) {
      const decal = this.decals[i];
      if (!decal.active) continue;
      decal.age += step;
      if (decal.age < 0) continue;
      if (!decal.seated) {
        if (!this._seat(decal)) { decal.active = false; continue; }
      } else {
        decal.check -= step;
        if (decal.check <= 0) {
          decal.check = SCORCH_CHECK_INTERVAL_S;
          if (!this._supported(decal)) {
            // The blast's own crater: follow it down once, early; later losses hide the mark.
            // Rim marks never re-seat: their crater is already accounted for.
            if (decal.rim || decal.age > SCORCH_RESEAT_WINDOW_S || !this._seat(decal)) { decal.active = false; continue; }
          }
        }
      }
      if (decal.age >= SCORCH_LIFE_S) { decal.active = false; continue; }
      const fadeT = Math.max(0, (decal.age - SCORCH_HOLD_S) / (SCORCH_LIFE_S - SCORCH_HOLD_S));
      const fade = decal.strength * (1 - fadeT * fadeT * (3 - 2 * fadeT));
      const grow = Math.min(1, 0.55 + decal.age * 4);
      const ember = Math.max(0, 1 - decal.age / SCORCH_EMBER_S);
      const size = decal.seatSize * grow;
      this._matrix.makeScale(size, 1, size);
      this._matrix.premultiply(this._rotation.makeRotationY(decal.angle));
      this._matrix.setPosition(decal.x, decal.y, decal.z);
      this.mesh.setMatrixAt(count, this._matrix);
      this.params.setXYZ(count, fade, ember * ember * decal.strength, decal.hole);
      count++;
    }
    this.mesh.count = count;
    if (count) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.params.needsUpdate = true;
    }
  }

  get activeCount() {
    let count = 0;
    for (const decal of this.decals) if (decal.active) count++;
    return count;
  }

  clear() {
    for (const decal of this.decals) decal.active = false;
    this.mesh.count = 0;
  }

  dispose() {
    this.clear();
    this.mesh.removeFromParent();
    // Frees the instanceMatrix GL buffer (three only drops it on the mesh's dispose event).
    this.mesh.dispose();
    this.mesh.geometry.dispose();
    this.material.uniforms.scorchMap.value.dispose();
    this.material.dispose();
  }
}
