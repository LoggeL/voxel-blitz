// Image-based light for PBR surfaces (weapons, hands, props, bastion kit):
// a prefiltered environment baked ONCE per map from the atmosphere palette.
// The bake is synchronous and happens before any world material compiles, so
// the ENVMAP program define never flips mid-match. The panorama is not used:
// it loads asynchronously and would force a recompile when it lands.

import * as THREE from '../vendor/three.module.js';

const ENV_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const ENV_FRAG = /* glsl */ `
uniform vec3 topColor;
uniform vec3 horizonColor;
uniform vec3 groundColor;
uniform vec3 sunColor;
uniform vec3 sunDir;
uniform float sunStrength;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  vec3 sky = mix(horizonColor, topColor, pow(max(d.y, 0.0), 0.6));
  // Ground bounce: darker and warmer than the sky, with a soft horizon band.
  vec3 ground = mix(horizonColor * 0.55, groundColor, smoothstep(0.0, 0.35, -d.y));
  vec3 color = d.y >= 0.0 ? sky : ground;
  float s = max(dot(d, sunDir), 0.0);
  color += sunColor * (pow(s, 64.0) * 6.0 + pow(s, 6.0) * 0.35) * sunStrength;
  gl_FragColor = vec4(color, 1.0);
}`;

/**
 * @returns {{texture:THREE.Texture, dispose:()=>void}|null} null without a
 *   renderer (headless tests) so callers simply skip scene.environment.
 */
export function bakeEnvironment(renderer, palette, sunDir) {
  if (!renderer || typeof renderer.getRenderTarget !== 'function') return null;
  const scene = new THREE.Scene();
  const material = new THREE.ShaderMaterial({
    uniforms: {
      topColor: { value: new THREE.Color(palette.skyTop) },
      horizonColor: { value: new THREE.Color(palette.skyHorizon) },
      groundColor: { value: new THREE.Color(palette.groundLight) },
      sunColor: { value: new THREE.Color(palette.sun) },
      sunDir: { value: sunDir.clone().normalize() },
      sunStrength: { value: palette.sunDisc ?? 1 },
    },
    vertexShader: ENV_VERT,
    fragmentShader: ENV_FRAG,
    side: THREE.BackSide,
    depthWrite: false,
  });
  const sphere = new THREE.Mesh(new THREE.SphereGeometry(40, 32, 16), material);
  scene.add(sphere);
  const generator = new THREE.PMREMGenerator(renderer);
  let target = null;
  try {
    target = generator.fromScene(scene, 0.02, 0.1, 100, { size: 128 });
  } catch {
    target = null;
  } finally {
    generator.dispose();
    sphere.geometry.dispose();
    material.dispose();
  }
  if (!target) return null;
  target.texture.name = 'map-environment';
  return { texture: target.texture, dispose: () => target.dispose() };
}
