import * as THREE from '../../vendor/three.module.js';
import { IRON_PALETTE } from '../../guns/models/iron-pickaxe.js';

// BLOCKWORKS: material tiers for the IRON PICK. Every tier is a pure role-colour
// remap of the eight sprite roles (models/iron-pickaxe.js), so the silhouette,
// anchors and hitboxes never change. Only the named pickaxe groups are tinted:
// hands, StatTrak plate and the melee flash stub keep their own materials. A tier
// without a `handle` palette keeps the iron build's stick.
const role = (color, roughness, metalness, extra = {}) => ({ color, roughness, metalness, ...extra });
const head = (outline, dark, mid, light, highlight, roughness, metalness, glow = {}) => ({
  'head-outline': role(outline, Math.min(1, roughness + 0.1), metalness * 0.6),
  'head-dark': role(dark, roughness, metalness),
  'head-mid': role(mid, roughness, metalness),
  'head-light': role(light, roughness, metalness, glow.light || {}),
  'head-highlight': role(highlight, Math.max(0.05, roughness - 0.1), metalness, glow.highlight || {}),
});
const stick = (outline, dark, light) => ({
  'handle-outline': role(outline, 0.95, 0), 'handle-dark': role(dark, 0.92, 0), 'handle-light': role(light, 0.9, 0),
});

const DIAMOND = head(0x0c3a3a, 0x168f89, 0x33cfc6, 0x7cf1ea, 0xdafffb, 0.22, 0.18, {
  light: { emissive: 0x0f5c52, emissiveIntensity: 0.35 },
  highlight: { emissive: 0x3ae3cc, emissiveIntensity: 0.45 },
});

export const PICKAXE_TIERS = Object.freeze({
  // Plank-cut head: warm grain, no metal at all.
  timber: { head: head(0x2c1d0b, 0x5b4020, 0x7e5d31, 0xa07c47, 0xbd9a60, 0.9, 0) },
  // Knapped stone: flat, cool greys a clear step darker than iron.
  cobble: { head: head(0x222324, 0x47494c, 0x65686b, 0x828589, 0x9c9fa3, 0.96, 0) },
  // Soft gold: bright, polished, a little orange in the shadows.
  gilded: { head: head(0x5e3a06, 0xb3831a, 0xe2b33a, 0xf6d86a, 0xfff4b6, 0.3, 0.55) },
  // Deep diamond: cyan facets with a faint inner light on the bright pixels.
  'deep-diamond': { head: DIAMOND },
  // Ashforged: near-black alloy with warm bronze highlights on a charred stick.
  ashforged: {
    head: head(0x161315, 0x312a2e, 0x484044, 0x625759, 0xa0826f, 0.5, 0.5),
    handle: stick(0x170f08, 0x33230f, 0x55401f),
  },
  // Runebound: the diamond build carrying a drifting violet enchantment glint.
  runebound: { head: DIAMOND, glint: 0x9a5cff },
});

const GLINT_VERTEX = `varying vec3 vP;
void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
// Two crossing diagonal bands, quantised to half-pixel steps so the shimmer
// reads as pixel light rather than a smooth gradient.
const GLINT_FRAGMENT = `uniform float uTime; uniform float uStep; uniform vec3 uColor; varying vec3 vP;
void main(){
  vec2 p = floor(vP.yz / uStep) * uStep;
  float a = pow(0.5 + 0.5 * sin((p.x - p.y) * 34.0 - uTime * 2.2), 7.0);
  float b = pow(0.5 + 0.5 * sin((p.x * 0.55 + p.y * 1.25) * 21.0 + uTime * 1.5), 9.0);
  gl_FragColor = vec4(uColor * (0.12 + a * 0.7 + b * 0.4), 1.0);
}`;

function tintMap(tier) {
  const map = {};
  for (const [name, hex] of Object.entries(IRON_PALETTE)) {
    const paint = (name.startsWith('head') ? tier.head : tier.handle)?.[name];
    if (paint) map[hex] = paint;
  }
  return map;
}

function addGlint(model, ctx, color) {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uStep: { value: (model.body.userData.pickaxe?.pixel || 0.035) / 2 },
      uColor: { value: new THREE.Color(color) },
    },
    vertexShader: GLINT_VERTEX, fragmentShader: GLINT_FRAGMENT,
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2,
  });
  material.userData.cosmeticGlow = true;
  ctx.materials.add(material);
  // Third-person rigs never tick the viewmodel clock, so each draw reads the page time.
  const tick = () => { material.uniforms.uTime.value = performance.now() / 1000; };
  for (const name of ['pickaxe_head', 'pickaxe_handle']) {
    const part = model.body.getObjectByName(name);
    if (!part) continue;
    const sources = part.children.filter(child => child.isMesh && child.userData.pickaxeRole);
    const layer = ctx.group(part, 'runebound_glint');
    for (const source of sources) {
      // Cloned geometry: the base sprite geometry is page-owned and must survive
      // clear(); the clone is layer-owned. three's copy() shares the userData
      // object, so give the clone its own instead of mutating the shared flag.
      const geometry = source.geometry.clone();
      geometry.userData = {};
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = `runebound_glint_${source.userData.pickaxeRole}`;
      mesh.renderOrder = 2;
      mesh.onBeforeRender = tick;
      layer.add(mesh);
    }
  }
}

export function applyTier(model, ctx, id) {
  const tier = PICKAXE_TIERS[id];
  const palette = tintMap(tier);
  for (const name of ['pickaxe_head', 'pickaxe_handle']) {
    const part = model.body.getObjectByName(name);
    if (part) ctx.tint(part, palette);
  }
  if (tier.glint) addGlint(model, ctx, tier.glint);
}

/** WEAPON_SKINS entries keyed by catalog id (`pickaxe-<tier>`). */
export const PICKAXE_SKINS = Object.freeze(Object.fromEntries(Object.keys(PICKAXE_TIERS)
  .map(id => [`pickaxe-${id}`, Object.freeze({ apply: (model, ctx) => applyTier(model, ctx, id) })])));
