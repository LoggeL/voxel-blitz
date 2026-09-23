// Thin-film soap material shared by the SB-1 SUDSBLASTER viewmodel (wand film, charge
// bubble, idle bubbles) and the flying world bubble, so both read as the same soap.
// Original procedural shader: a fresnel-weighted rainbow hue cycle with a slow swirl,
// nearly clear face-on and bright at the grazing rim, like a real bubble skin.
// Kept out of kit.js on purpose: the HUD rasterizer and the cosmetic skin layer skip
// ShaderMaterials, and `userData.soapFilm` flags it for anything else that walks a rig.
import * as THREE from '../vendor/three.module.js';

const VERTEX = `varying vec2 vUv; varying vec3 vN; varying vec3 vV;
void main(){
  vUv = uv;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = -mv.xyz;
  gl_Position = projectionMatrix * mv;
}`;

const FRAGMENT = `uniform float uT; uniform float uAlpha; uniform float uThin;
varying vec2 vUv; varying vec3 vN; varying vec3 vV;
void main(){
  float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.2);
  float band = f * 1.7 + vUv.y * 0.6 + uT * 0.18 + uThin;
  vec3 irid = 0.5 + 0.5 * cos(6.2831 * (band + vec3(0.0, 0.33, 0.67)));
  float swirl = 0.5 + 0.5 * sin(vUv.x * 18.0 + uT * 3.0 + sin(vUv.y * 11.0 - uT * 2.0));
  vec3 col = mix(vec3(0.92, 0.98, 1.0), irid, 0.45 + 0.35 * f) + 0.08 * swirl;
  gl_FragColor = vec4(col, uAlpha * (0.12 + 0.75 * f + 0.10 * swirl));
}`;

/** Seconds on the film clock; every film shares it so a rig and its bubbles swirl in step. */
function clockSeconds() {
  return (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
}

/**
 * One soap-film material. `alpha` scales the whole skin, `phase` offsets the hue cycle
 * (`uThin`) so neighbouring films never match. The clock advances itself right before
 * each draw; callers only nudge `uAlpha` and `uThin` (charge drift, fuse tell, ADS dim).
 */
export function makeSoapFilm({ alpha = 0.55, phase = 0 } = {}) {
  const uniforms = {
    uT: { value: clockSeconds() },
    uAlpha: { value: alpha },
    uThin: { value: phase },
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  material.userData.soapFilm = true;
  material.userData.baseAlpha = alpha;
  material.userData.basePhase = phase;
  material.onBeforeRender = () => { uniforms.uT.value = clockSeconds(); };
  return { material, uniforms };
}
