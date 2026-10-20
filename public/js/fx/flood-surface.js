// The moving water of a flood field (shared/world/flood-field.js) drawn as
// one smooth surface (docs/conquest.md "Redrock Dam breach" -> Rendering;
// design docs/design/conquest/events/dam/flood-a-reference.png): a grid mesh
// over every column the field can wet, its heights evaluated from the field
// on the CPU each frame (one level per lattice row and kind, so a frame costs
// a few thousand lookups), foam from how fast the water rises (the white
// front), its slope (the over-sill fall) and the flow (streaks), the
// canyon's old stream hidden until the water stands over it.
//
// The voxel water it replaces is clipped by the chunk water material
// (fluid-material.js setFloodClip): the basin's voxels above the level are not
// drawn, the canyon's new cells only arrive (commits) once they lie under the
// settled level. Presentation only.
import * as THREE from '../vendor/three.module.js';
import { FLOOD_KIND } from '../../../shared/world/flood-field.js';
import { fluidClock, setFloodClip, setFloodClipLevel, waterPalette } from '../engine/fluid-material.js';

export const FLOOD_SURFACE_RULES = Object.freeze({
  /** Lattice step (m) by graphics tier: Low draws a coarser plane. */
  step: Object.freeze({ low: 4, medium: 2, high: 2, ultra: 2 }),
  /** The canyon surface shows once it stands this far (m) over the old stream (no z-fight with its voxels). */
  showOver: 0.12,
  /** Foam: m/s of rise for full foam, m of drop per lattice step for full foam, the over-sill sheet's floor. */
  riseFull: 2.4, slopeFull: 1.2, gapFoam: 0.4,
  /** Updates a second (the field tables run at 10 Hz; between them the heights interpolate). */
  hz: 30,
  /** Turbid flood water (silt), mixed over the map's water colours. */
  silt: 0x8a6a46, siltShare: 0.16,
});

const VERT = /* glsl */`
#include <common>
#include <fog_pars_vertex>
attribute vec3 aDyn;    // alpha, foam, flow speed (m/s)
attribute vec2 aFlow;   // flow direction (unit, xz)
varying vec3 vWorld;
varying vec3 vDyn;
varying vec2 vFlow;
void main() {
  vec4 worldPosition = modelMatrix * vec4(position, 1.0);
  vWorld = worldPosition.xyz;
  vDyn = aDyn;
  vFlow = aFlow;
  vec4 mvPosition = viewMatrix * worldPosition;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const FRAG = /* glsl */`
#include <common>
#include <fog_pars_fragment>
uniform float time;
uniform vec3 sunDir;
uniform vec3 shallowColor;
uniform vec3 deepColor;
uniform vec3 skyColor;
uniform vec3 horizonColor;
uniform vec3 siltColor;
uniform float siltShare;
varying vec3 vWorld;
varying vec3 vDyn;
varying vec2 vFlow;
float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float n2(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), f.x), mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0)), f.x), f.y);
}
void main() {
  float alpha = vDyn.x;
  if (alpha < 0.02) discard;
  vec3 view = normalize(cameraPosition - vWorld);
  vec3 dx = dFdx(vWorld), dz = dFdy(vWorld);
  vec3 normal = normalize(cross(dz, dx));
  if (normal.y < 0.0) normal = -normal;
  // Flow-aligned coordinates: streaks stretch along the current and run with it.
  vec2 dir = length(vFlow) > 0.01 ? normalize(vFlow) : vec2(0.0, 1.0);
  vec2 side = vec2(-dir.y, dir.x);
  float speed = vDyn.z;
  vec2 q = vec2(dot(vWorld.xz, side) * 0.9, dot(vWorld.xz, dir) * 0.22 - time * speed * 0.3);
  float streak = n2(q) * 0.6 + n2(q * 2.7 + 13.0) * 0.4;
  float rip = n2(vWorld.xz * 1.3 + dir * time * speed * 0.5);
  normal = normalize(normal + vec3(rip - 0.5, 0.0, streak - 0.5) * (0.12 + 0.04 * min(speed, 6.0)));
  float facing = abs(dot(normal, view));
  float fresnel = pow(1.0 - facing, 3.0);
  vec3 water = mix(deepColor, shallowColor, fresnel * 0.45);
  water = mix(water, siltColor, siltShare);
  vec3 sun = normalize(sunDir);
  float diffuse = 0.62 + 0.38 * max(dot(normal, sun), 0.0);
  vec3 color = water * diffuse;
  vec3 reflected = reflect(-view, normal);
  vec3 sky = mix(horizonColor, skyColor, smoothstep(0.0, 0.6, reflected.y));
  color = mix(color, sky, clamp((0.02 + 0.98 * pow(1.0 - facing, 5.0)) * 0.5, 0.0, 0.4));
  color += vec3(pow(max(dot(normal, normalize(sun + view)), 0.0), 80.0) * 0.6);
  // Foam: the front and the fall (vDyn.y), plus streaks where the current runs fast.
  // Broken, not painted: the churn noise eats into the front's foam band.
  float churn = n2(vWorld.xz * 0.9 + dir * time * 1.3) * 0.6 + n2(vWorld.xz * 3.1 - time * 0.7) * 0.4;
  float foam = clamp(vDyn.y * smoothstep(0.3, 0.75, churn + vDyn.y * 0.2)
    + smoothstep(0.62, 0.9, streak) * clamp(speed / 7.0, 0.0, 1.0) * 0.6, 0.0, 1.0);
  color = mix(color, vec3(0.86, 0.9, 0.92) * diffuse, foam * 0.85);
  gl_FragColor = vec4(color, alpha * mix(0.8, 0.97, max(foam, fresnel)));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

const KIND_PRIORITY = { [FLOOD_KIND.gap]: 3, [FLOOD_KIND.lake]: 2, [FLOOD_KIND.canyon]: 1 };

/**
 * One flood field's surface. `build(field)` once (the lattice over its
 * columns), then `update(t)` every frame with the field's seconds since the
 * start; `dispose()` when the field goes.
 */
export class FloodSurface {
  constructor({ scene = null, tier = 'high', sunDir = null } = {}) {
    this.scene = scene; this.step = FLOOD_SURFACE_RULES.step[tier] ?? 2;
    this.field = null; this.mesh = null; this.lastT = null; this.lastUpdate = -Infinity;
    this.sunDir = sunDir;
  }

  build(field) {
    this.dispose();
    this.field = field;
    const s = this.step, b = field.bounds;
    const NX = Math.ceil((b.x1 - b.x0 + 1) / s) + 1, NZ = Math.ceil((b.z1 - b.z0 + 1) / s) + 1;
    const vertexOf = new Int32Array(NX * NZ).fill(-1);
    const kinds = [], xs = [], zs = [], rowOf = [], flow = [];
    const mouth = field.gapMouth;
    const vertex = (i, j) => {
      const key = j * NX + i;
      if (vertexOf[key] >= 0) return vertexOf[key];
      const x = b.x0 + i * s, z = b.z0 + j * s;
      // The vertex takes the strongest kind of the columns around its corner (the gap's sheet over the lake's edge).
      let kind = 0;
      for (const [cx, cz] of [[x - 1, z - 1], [x, z - 1], [x - 1, z], [x, z]]) {
        const k = field.kindAt(cx, cz);
        if (k && (KIND_PRIORITY[k] ?? 0) > (KIND_PRIORITY[kind] ?? 0)) kind = k;
      }
      const id = kinds.length;
      vertexOf[key] = id;
      kinds.push(kind); xs.push(x); zs.push(z); rowOf.push(j);
      if (kind === FLOOD_KIND.lake) {
        const dx = mouth.x - x, dz = mouth.z - z, d = Math.hypot(dx, dz) || 1;
        flow.push(dx / d, dz / d);
      } else flow.push(0, 1);
      return id;
    };
    const index = [];
    for (let j = 0; j < NZ - 1; j++) for (let i = 0; i < NX - 1; i++) {
      // A cell with any wet-able column under it gets its quad.
      let any = false;
      const cx0 = b.x0 + i * s, cz0 = b.z0 + j * s;
      for (let dz = 0; dz < s && !any; dz++) for (let dx = 0; dx < s && !any; dx++) if (field.kindAt(cx0 + dx, cz0 + dz)) any = true;
      if (!any) continue;
      const a = vertex(i, j), c = vertex(i + 1, j), d = vertex(i + 1, j + 1), e = vertex(i, j + 1);
      index.push(a, e, c, c, e, d);
    }
    const n = kinds.length;
    this.kinds = Uint8Array.from(kinds); this.xs = Float32Array.from(xs); this.zs = Float32Array.from(zs);
    this.rowOf = Int32Array.from(rowOf); this.NZ = NZ;
    this.levels = { lake: new Float32Array(NZ), gap: new Float32Array(NZ), canyon: new Float32Array(NZ), prev: new Float32Array(NZ), speed: new Float32Array(NZ) };
    const pos = new Float32Array(n * 3), dyn = new Float32Array(n * 3);
    for (let v = 0; v < n; v++) { pos[v * 3] = xs[v]; pos[v * 3 + 1] = field.spec.canyon.initial - 0.5; pos[v * 3 + 2] = zs[v]; }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('aDyn', new THREE.BufferAttribute(dyn, 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('aFlow', new THREE.BufferAttribute(Float32Array.from(flow), 2));
    geometry.setIndex(n > 65535 ? new THREE.Uint32BufferAttribute(index, 1) : new THREE.Uint16BufferAttribute(index, 1));
    geometry.boundingBox = new THREE.Box3(new THREE.Vector3(b.x0, 10, b.z0), new THREE.Vector3(b.x1 + 1, 40, b.z1 + 1));
    geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(new THREE.Sphere());
    const palette = waterPalette();
    const material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
        time: { value: 0 }, sunDir: { value: new THREE.Vector3(0.4, 0.8, 0.3) },
        shallowColor: { value: new THREE.Color(palette.shallowColor ?? 0xb4dcff) }, deepColor: { value: new THREE.Color(palette.deepColor ?? 0x3a74d6) },
        skyColor: { value: new THREE.Color(palette.skyColor ?? 0x397fc4) }, horizonColor: { value: new THREE.Color(palette.horizonColor ?? 0xb3ddf5) },
        siltColor: { value: new THREE.Color(FLOOD_SURFACE_RULES.silt) }, siltShare: { value: FLOOD_SURFACE_RULES.siltShare },
      }]),
      vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: true,
    });
    if (this.sunDir) material.uniforms.sunDir.value.copy(this.sunDir);
    material.name = 'flood-surface';
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.name = 'flood-surface';
    this.mesh.renderOrder = 3;
    this.mesh.frustumCulled = true;
    this.scene?.add(this.mesh);
    // The basin's voxel water above the level stops drawing (the mask: the lake's columns).
    const l = field.spec.lake, W = l.x1 - l.x0 + 1, H = l.z1 - l.z0 + 1, mask = new Uint8Array(W * H * 4);
    for (let z = 0; z < H; z++) for (let x = 0; x < W; x++) if (field.kindAt(l.x0 + x, l.z0 + z) === FLOOD_KIND.lake) mask[(z * W + x) * 4] = 255;
    this.mask = new THREE.DataTexture(mask, W, H, THREE.RGBAFormat);
    this.mask.magFilter = this.mask.minFilter = THREE.NearestFilter;
    this.mask.needsUpdate = true;
    setFloodClip({ box: { x0: l.x0, z0: l.z0, x1: l.x1, z1: l.z1 }, level: l.top, sill: l.sill, h0: l.h0, top: l.top, riffle: l.riffle, mask: this.mask });
    this.lastT = null;
    return { vertices: n, triangles: index.length / 3 };
  }

  /** Heights and foam at `t` s since the start (nowMs for the throttle). */
  update(t, nowMs = performance.now()) {
    const field = this.field, mesh = this.mesh;
    if (!field || !mesh || !(t >= 0)) return false;
    if (nowMs - this.lastUpdate < 1000 / FLOOD_SURFACE_RULES.hz) { mesh.material.uniforms.time.value = fluidClock(); return false; }
    const dt = this.lastT == null ? 0 : Math.max(1e-3, t - this.lastT);
    this.lastUpdate = nowMs;
    const L = this.levels, b = field.bounds, s = this.step, initial = field.spec.canyon.initial, r = FLOOD_SURFACE_RULES;
    const lake = field.lakeLevel(t), gap = field.gapLevel(t), cz0 = field.cz0;
    for (let j = 0; j < this.NZ; j++) {
      const z = b.z0 + j * s;
      L.prev[j] = L.canyon[j];
      L.lake[j] = Math.max(lake, field.lakeFinal(z));
      L.canyon[j] = z >= cz0 ? field.rowLevel(z, t) : NaN;
      L.gap[j] = z >= cz0 ? Math.max(gap, L.canyon[j]) : gap;
      L.speed[j] = z >= cz0 ? Math.abs(field.rowVelocity(z, t)) : 0;
    }
    const pos = mesh.geometry.attributes.position.array, dyn = mesh.geometry.attributes.aDyn.array;
    const sheet = Math.sqrt(9.81 * Math.max(0, lake - field.spec.lake.sill));
    for (let v = 0; v < this.kinds.length; v++) {
      const j = this.rowOf[v], k = this.kinds[v];
      let y, alpha = 1, foam = 0, speed = 0;
      if (k === FLOOD_KIND.lake) {
        y = L.lake[j];
        const d = Math.hypot(this.xs[v] - field.gapMouth.x, this.zs[v] - field.gapMouth.z);
        speed = sheet * Math.min(1, 8 / Math.max(1, d));
        foam = Math.max(0, 1 - d / 14) * 0.6 * Math.min(1, sheet / 3);
      } else if (k === FLOOD_KIND.gap) {
        y = L.gap[j]; speed = Math.max(sheet, L.speed[j]); foam = r.gapFoam * Math.min(1, sheet / 2);
      } else if (k === FLOOD_KIND.canyon) {
        y = L.canyon[j];
        const over = y - initial;
        alpha = Math.min(1, Math.max(0, (over - r.showOver) / 0.25));
        speed = L.speed[j];
        const rise = dt > 0 ? (y - L.prev[j]) / dt : 0;
        const ahead = j + 1 < this.NZ ? L.canyon[j + 1] : y;
        const f = Math.max(0, rise / r.riseFull) + Math.max(0, (y - ahead) / r.slopeFull) * 0.6;
        foam = Math.min(1, f * f * 1.5);
      } else { y = initial - 0.5; alpha = 0; }
      if (!(y === y)) { y = initial - 0.5; alpha = 0; }
      pos[v * 3 + 1] = y; dyn[v * 3] = alpha; dyn[v * 3 + 1] = foam; dyn[v * 3 + 2] = speed;
    }
    mesh.geometry.attributes.position.needsUpdate = true;
    mesh.geometry.attributes.aDyn.needsUpdate = true;
    mesh.material.uniforms.time.value = fluidClock();
    setFloodClipLevel(lake);
    this.lastT = t;
    return true;
  }

  dispose() {
    if (this.mesh) {
      this.scene?.remove(this.mesh);
      this.mesh.geometry.dispose(); this.mesh.material.dispose();
    }
    this.mask?.dispose?.();
    if (this.field) setFloodClip(null);
    this.mesh = null; this.field = null; this.mask = null; this.lastT = null;
  }
}
