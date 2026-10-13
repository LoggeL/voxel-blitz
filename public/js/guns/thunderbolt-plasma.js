import * as THREE from '../vendor/three.module.js';

const installed = new WeakMap();

// Trace through the authored sphere in its own coordinates. The cofactor basis
// also handles the non-uniform scale used by viewmodels without a per-draw CPU
// camera update. Positions in Blender's meshes are already baked into gun space.
const VERTEX = `
uniform vec3 uCenter;
uniform float uRadius;
varying vec3 vPoint;
varying vec3 vRay;
#include <fog_pars_vertex>
void main() {
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  mat3 basis = mat3(modelViewMatrix);
  vec3 a = cross(basis[1], basis[2]);
  vec3 b = cross(basis[2], basis[0]);
  vec3 c = cross(basis[0], basis[1]);
  float determinant = dot(basis[0], a);
  determinant = determinant < 0.0 ? min(determinant, -0.00000001) : max(determinant, 0.00000001);
  vPoint = (position - uCenter) / uRadius;
  vRay = vec3(dot(a, mvPosition.xyz), dot(b, mvPosition.xyz), dot(c, mvPosition.xyz)) / determinant;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const FRAGMENT = `
uniform float uTime;
uniform float uPhase;
uniform float uPulse;
varying vec3 vPoint;
varying vec3 vRay;
#include <fog_pars_fragment>

float hash(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}
float noise(vec3 p) {
  vec3 cell = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash(cell), hash(cell + vec3(1, 0, 0)), f.x),
                 mix(hash(cell + vec3(0, 1, 0)), hash(cell + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(hash(cell + vec3(0, 0, 1)), hash(cell + vec3(1, 0, 1)), f.x),
                 mix(hash(cell + vec3(0, 1, 1)), hash(cell + vec3(1, 1, 1)), f.x), f.y), f.z);
}
vec3 direction(float seed) {
  return normalize(vec3(sin(seed * 2.31 + 0.6), sin(seed * 3.73 + 2.2), cos(seed * 1.91 + 0.4)));
}

// Each short discharge segment has a narrow hot center and a wider blue halo.
// Distance to the viewing ray gives a real internal filament, rather than a
// painted surface line. Rear segments lose contrast through the cobalt gas.
vec2 filament(vec3 entry, vec3 ray, float path, vec3 a, vec3 b, float pixel) {
  vec3 segment = b - a;
  vec3 offset = entry - a;
  float vv = max(dot(segment, segment), 0.00001);
  float uv = dot(ray, segment);
  float alongRay = (uv * dot(segment, offset) - vv * dot(ray, offset)) /
    max(vv - uv * uv, 0.00001);
  float alongSegment = clamp((dot(segment, offset) + uv * alongRay) / vv, 0.0, 1.0);
  alongRay = clamp(dot(a + segment * alongSegment - entry, ray), 0.0, path);
  float distance = length(entry + ray * alongRay - a - segment * alongSegment);
  float depth = alongRay / max(path, 0.001);
  float width = 0.0024 + depth * 0.0012;
  float core = 1.0 - smoothstep(0.0, width + pixel * 0.38, distance);
  float halo = exp(-distance * distance * (420.0 - depth * 160.0));
  return vec2(core, halo) * (1.0 - depth * 0.43);
}

vec3 branchPoint(vec3 start, vec3 end, float t, float seed, float time) {
  vec3 axis = normalize(end - start);
  vec3 across = normalize(cross(axis, direction(seed + 2.1)));
  vec3 up = cross(axis, across);
  float x = sin(t * 10.0 + seed + time * 0.27) * 0.10 +
            sin(t * 29.0 + seed * 3.1 - time * 0.15) * 0.032;
  float y = cos(t * 13.0 + seed * 1.7 - time * 0.19) * 0.085 +
            sin(t * 34.0 + seed * 2.1 + time * 0.23) * 0.026;
  return mix(start, end, t) + (across * x + up * y) * sin(t * 3.14159265);
}

void main() {
  vec3 ray = normalize(vRay);
  float projection = dot(vPoint, ray);
  float discriminant = projection * projection - dot(vPoint, vPoint) + 1.0;
  if (discriminant <= 0.0) discard;
  float halfPath = sqrt(discriminant);
  float path = halfPath * 2.0;
  vec3 entry = vPoint + ray * (-projection - halfPath);
  float pixel = max(length(fwidth(vPoint)), 0.004);
  float time = uTime + uPhase * 2.3;
  vec3 nucleus = direction(uPhase + 1.2) * 0.065;

  float mist = 0.0;
  for (int sampleIndex = 0; sampleIndex < 6; sampleIndex++) {
    vec3 p = entry + ray * (path * (float(sampleIndex) + 0.5) / 6.0);
    float gas = noise(p * 4.1 + vec3(time * 0.09, -time * 0.055, uPhase));
    mist += gas * gas * max(0.0, 1.0 - dot(p, p));
  }
  mist *= path / 6.0;

  vec2 discharge = vec2(0.0);
  for (int arm = 0; arm < 5; arm++) {
    float seed = float(arm) * 4.71 + uPhase * 1.37 + 0.8;
    vec3 end = direction(seed) * (0.91 + 0.035 * sin(seed * 1.6));
    vec3 previous = nucleus;
    for (int point = 1; point <= 9; point++) {
      float t = float(point) / 9.0;
      vec3 next = branchPoint(nucleus, end, t, seed, time);
      discharge = max(discharge, filament(entry, ray, path, previous, next, pixel));
      previous = next;
    }
    vec3 fork = branchPoint(nucleus, end, 0.55, seed, time);
    vec3 forkEnd = normalize(end + direction(seed + 9.2) * 0.6) * 0.94;
    previous = fork;
    for (int point = 1; point <= 4; point++) {
      float t = float(point) / 4.0;
      vec3 next = branchPoint(fork, forkEnd, t, seed + 7.1, time);
      discharge = max(discharge, filament(entry, ray, path, previous, next, pixel) * (0.64 - t * 0.2));
      previous = next;
    }
  }

  float centerDistance = length(entry + ray * clamp(dot(nucleus - entry, ray), 0.0, path) - nucleus);
  float core = exp(-centerDistance * centerDistance * 175.0);
  float coreGlow = exp(-centerDistance * centerDistance * 19.0);
  float breathing = 0.94 + 0.06 * sin(time * 1.7);
  float energy = 1.0 + uPulse * 0.38;
  // Optical thickness supplies the dark, translucent body. Its edge fades, with
  // no reflected glass highlight and no opaque blue surface hiding the volume.
  float bodyAlpha = 0.72 * (1.0 - exp(-path * 1.1));
  float edge = exp(-halfPath * halfPath * 18.0) *
    (0.15 + 0.85 * noise(entry * 8.0 + vec3(time * 0.1, uPhase, 0.0)));
  float glow = (discharge.y * 0.70 + coreGlow * 0.75 + mist * 0.15 + edge * 0.38) * breathing;
  float hot = clamp((discharge.x * 0.95 + core * 2.1) * energy, 0.0, 1.0);
  float alpha = clamp(bodyAlpha + glow * 0.24 + hot * 0.57 + edge * 0.35, 0.0, 0.99);
  float silhouette = smoothstep(0.0, max(pixel * 1.5, 0.018), path);
  vec3 color = vec3(0.001, 0.005, 0.044) + vec3(0.005, 0.10, 0.72) * glow;
  color += vec3(0.30, 0.85, 1.30) * discharge.x * energy;
  color += vec3(4.2, 5.0, 5.6) * core * energy;
  color += vec3(0.015, 0.25, 2.0) * edge;
  gl_FragColor = vec4(color, alpha * silhouette);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

/** Replace only the charge spheres; the copper cage, rail light and sights keep
 * their authored materials. The controller owns no geometry or global clock. */
export function installThunderboltPlasma(parts) {
  if (!parts || typeof parts !== 'object') return null;
  if (installed.has(parts)) return installed.get(parts);
  const materials = [];
  const replaced = new Set();
  const roots = [...(Array.isArray(parts.rounds) ? parts.rounds : []), parts.energy];
  for (let index = 0; index < roots.length; index++) {
    const root = roots[index];
    if (!root?.traverse) continue;
    const legacyArcs = [];
    root.traverse(mesh => {
      if (!mesh.isMesh) return;
      const originals = [].concat(mesh.material || []);
      if (root !== parts.energy && originals.length && originals.every(material => material.userData?.tbArc)) {
        legacyArcs.push(mesh);
        return;
      }
      if (!originals.some(material => material.userData?.tbOrb || material.userData?.tbEnergy)) return;
      const geometry = mesh.geometry;
      if (!geometry?.attributes?.position) return;
      if (!geometry.boundingBox) geometry.computeBoundingBox();
      const center = geometry.boundingBox.getCenter(new THREE.Vector3());
      const size = geometry.boundingBox.getSize(new THREE.Vector3());
      const radius = Math.max(size.x, size.y, size.z) * 0.5;
      if (![center.x, center.y, center.z, radius].every(Number.isFinite) || radius <= 0) return;
      const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
        uCenter: { value: center },
        uRadius: { value: radius },
        uTime: { value: 0 },
        uPhase: { value: 0.73 + index * 1.61803399 },
        uPulse: { value: 0 },
      }]);
      const material = new THREE.ShaderMaterial({
        name: 'TB-4 volumetric plasma',
        uniforms,
        vertexShader: VERTEX,
        fragmentShader: FRAGMENT,
        transparent: true,
        blending: THREE.NormalBlending,
        depthWrite: false,
        side: THREE.FrontSide,
        toneMapped: true,
        fog: true,
      });
      material.userData.thunderboltPlasma = true;
      materials.push(material);
      for (const original of originals) {
        if (original.userData?.tbOrb && !original.userData?.tbEnergy) replaced.add(original);
      }
      mesh.material = Array.isArray(mesh.material) ? originals.map(original =>
        original.userData?.tbOrb || original.userData?.tbEnergy ? material : original) : material;
    });
    for (const arc of legacyArcs) arc.removeFromParent();
  }
  for (const material of replaced) material.dispose();
  let time = 0;
  const controller = {
    materials,
    get time() { return time; },
    update(dt, { reducedMotion = false } = {}) {
      if (reducedMotion || !Number.isFinite(dt) || dt <= 0) return;
      time = (time + Math.min(dt, 60)) % 3600;
      for (const material of materials) material.uniforms.uTime.value = time;
    },
    setPulse(value) {
      const pulse = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
      for (const material of materials) material.uniforms.uPulse.value = pulse;
    },
  };
  installed.set(parts, controller);
  return controller;
}
