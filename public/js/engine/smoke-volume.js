import * as THREE from '../vendor/three.module.js';
import { SMOKE, smokeShape } from '../../../shared/smoke-rules.js';

// Integrate only up to the visible surface, including when the eye is inside a
// cloud. Depth keeps nearby walls and the held weapon in front of the smoke.
export const SMOKE_GLSL = /* glsl */ `
uniform sampler2D sceneDepth;
uniform mat4 smokeProjectionInverse;
uniform mat4 smokeCameraWorld;
uniform vec3 smokeEye;
uniform int smokeCount;
uniform vec4 smokeSpheres[${SMOKE.maxFields}];
uniform float smokeDensity[${SMOKE.maxFields}];

vec3 smokeColor(vec3 color, vec2 uv, float clock) {
  if (smokeCount == 0) return color;
  float depth = texture2D(sceneDepth, uv).x;
  vec4 point = smokeProjectionInverse * vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  point /= point.w;
  vec3 end = (smokeCameraWorld * point).xyz;
  vec3 ray = end - smokeEye;
  float distance = length(ray);
  ray /= max(distance, 0.0001);
  float optical = 0.0;
  float billow = 0.0;
  for (int i = 0; i < ${SMOKE.maxFields}; i++) {
    if (i >= smokeCount) break;
    vec3 offset = smokeEye - smokeSpheres[i].xyz;
    float b = dot(offset, ray);
    float disc = b * b - dot(offset, offset) + smokeSpheres[i].w * smokeSpheres[i].w;
    if (disc <= 0.0) continue;
    float root = sqrt(disc);
    float entry = max(0.0, -b - root);
    float exit = min(distance, -b + root);
    float span = max(0.0, exit - entry);
    if (span <= 0.0) continue;
    // Sparse volume samples soften the boundary and give moving, uneven lobes.
    // The core stays dense; turbulence changes the fringe, never opens sight holes.
    for (int sampleIndex = 0; sampleIndex < 10; sampleIndex++) {
      float travel = entry + span * (float(sampleIndex) + 0.5) / 10.0;
      vec3 p = smokeEye + ray * travel - smokeSpheres[i].xyz;
      float swirl = sin(p.x * 2.1 + sin(p.z * 1.7 + clock * 0.3))
        * sin(p.y * 2.6 - clock * 0.25 + sin(p.x + p.z));
      float boundary = smokeSpheres[i].w - length(p) - (0.45 + swirl * 0.45);
      float localDensity = smoothstep(0.0, 0.8, boundary);
      optical += span * 0.1 * smokeDensity[i] * localDensity;
      billow += swirl * localDensity * min(1.0, span) * 0.004;
    }
  }
  float opacity = 1.0 - exp(-optical * 1.6);
  return mix(color, vec3(0.46, 0.50, 0.51) + billow, opacity);
}
`;

export function smokeUniforms(depth) {
  return {
    sceneDepth: { value: depth }, smokeCount: { value: 0 },
    smokeSpheres: { value: Array.from({ length: SMOKE.maxFields }, () => new THREE.Vector4()) },
    smokeDensity: { value: new Float32Array(SMOKE.maxFields) },
    smokeProjectionInverse: { value: new THREE.Matrix4() },
    smokeCameraWorld: { value: new THREE.Matrix4() },
    smokeEye: { value: new THREE.Vector3() },
  };
}

export function updateSmokeUniforms(uniforms, fields, now, camera) {
  let count = 0;
  for (const field of fields || []) {
    if (count >= SMOKE.maxFields) break;
    const { radius, density } = smokeShape(field, now);
    if (!(radius > 0 && density > 0)) continue;
    uniforms.smokeSpheres.value[count].set(field.x, field.y, field.z, radius);
    uniforms.smokeDensity.value[count++] = density;
  }
  uniforms.smokeCount.value = count;
  if (count) {
    camera.updateMatrixWorld();
    uniforms.smokeProjectionInverse.value.copy(camera.projectionMatrixInverse);
    uniforms.smokeCameraWorld.value.copy(camera.matrixWorld);
    uniforms.smokeEye.value.setFromMatrixPosition(camera.matrixWorld);
  }
  return count;
}
