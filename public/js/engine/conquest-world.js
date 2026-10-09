import * as THREE from '../vendor/three.module.js';
import { decodeConquestMatch } from '../../../shared/conquest.js';
import { FLAG_STATES } from '../../../shared/conquest-contract.js';
import { patchVoxelLitMaterial } from './voxel-light.js';
import { disposeObjectTree } from './dispose.js';

// Conquest objectives in the world, Battlefield style: a mast whose cloth is
// hoisted and lowered with the authoritative control scalar, a slim tall beam
// in the owner's colour that pulses while the zone is contested (it fades out
// within ~50-170 m of the mast, so it marks the flag from afar and never fills
// the view up close), a dashed ring decal on the ground at the capture radius
// (dropped where it would climb a wall or roof, faded right in front of the
// camera) and a letter marker over the mast. Every value
// shown comes from `match.conquest` (decodeConquestMatch) merged with the
// static `mapMeta.conquest` layout; nothing is predicted here.
//
// Draws: one instanced draw for all masts, one for all cloths, one for all
// beams, one merged ring mesh and one sprite per flag. Colour, height, pulse
// and label changes are instance attributes, uniforms or canvas uploads, so
// no program key ever changes after the map loads.

/** Team-relative palette (spec F6): own blue, enemy orange, neutral grey. */
export const CONQUEST_FLAG_COLORS = Object.freeze({ neutral: 0xd8d8d8, own: 0x4cc3ff, enemy: 0xff8a3d });
export const MAST_HEIGHT = 9;
export const CLOTH_WIDTH = 2.6;
export const CLOTH_HEIGHT = 1.6;
/** Cloth bottom edge above the mast foot when lowered / fully hoisted. */
export const CLOTH_LOW = 0.9;
export const CLOTH_HIGH = MAST_HEIGHT - 0.25 - CLOTH_HEIGHT;
export const BEAM_HEIGHT = 80;
/** Beam radius at its foot and top (m): a slim marker, not a column of light. */
const BEAM_RADIUS = Object.freeze([0.26, 0.1]);
/** Camera distances (m) over which the beam fades in: up close the mast and cloth speak. */
const BEAM_NEAR_FADE = Object.freeze([50, 170]);
/** Beam strength (additive, kept well below 1.0): owned flags, unowned flags. */
const BEAM_GLOW = Object.freeze({ owned: 0.3, neutral: 0.17 });
/** Fraction of BEAM_HEIGHT over which the beam fades out toward its top. */
const BEAM_TAIL = Object.freeze([0.1, 0.6]);
/** Rim falloff exponent: higher reads as a softer, thinner core. */
const BEAM_CORE_POWER = 3.0;
/** Share of the scene fog the beam takes (0 ignores fog, 1 fogs like terrain). */
const BEAM_FOG = 0.5;
/**
 * Yaw of the battlefield wind (radians, three.js Y rotation): cloths stream
 * toward local +X turned by this angle, i.e. world (cos, 0, -sin); the
 * Conquest ambience leans chimney and wreck smoke the same way.
 */
export const CONQUEST_WIND_YAW = 0.6;
/** Beyond this camera distance the letter marker draws over terrain. */
export const LABEL_DEPTH_DISTANCE = 60;
const LABEL_SIZE = 256;
/** Control-arc resolution of the letter marker (label repaints per full hoist). */
const LABEL_ARC_STEPS = 48;
const RING_SEGMENTS = 96;
/** Vertices of one flag's ring: every segment owns its quad, so a step can drop it. */
export const RING_VERTICES_PER_FLAG = RING_SEGMENTS * 4;
const RING_WIDTH = 0.6;
/** A segment whose ends differ by more than this (m) climbs a wall or roof: it is not drawn. */
const RING_MAX_STEP = 1.25;
/** Camera distances (m) over which the ring fades in, so it never fills the view underfoot. */
const RING_NEAR_FADE = Object.freeze([2.5, 10]);
/** Cloth hoist speed of the presentation easing toward the authoritative height (1/s). */
const HOIST_EASE = 6;
const STATE_SET = new Set(FLAG_STATES);

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Number.isFinite(v) ? v : 0));
const teamSign = (team) => (team === 'alpha' ? 1 : team === 'bravo' ? -1 : 0);
const asTeam = (team) => (team === 'alpha' || team === 'bravo' ? team : null);

/**
 * Flag states from a snapshot match: the v2 wire rows through the shared
 * decoder, else the pre-v2 objects ({owner, capturing, progress, contested}),
 * normalised to { id, control -1..1 (+alpha), owner, state, atk, def }.
 */
export function conquestFlagStates(match, layout = null) {
  const raw = match?.conquest;
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.flags)) return null;
  if (raw.flags.some(Array.isArray)) {
    return decodeConquestMatch(raw, layout).flags.map((flag) => ({
      id: String(flag.id).toUpperCase(), control: clamp(flag.control, -1, 1), owner: asTeam(flag.owner),
      state: STATE_SET.has(flag.state) ? flag.state : 'idle', atk: flag.atk | 0, def: flag.def | 0,
    }));
  }
  const out = [];
  for (const flag of raw.flags) {
    if (!flag || typeof flag !== 'object' || flag.id == null) continue;
    const owner = asTeam(flag.owner);
    let control;
    let state = STATE_SET.has(flag.state) ? flag.state : null;
    if (Number.isFinite(flag.control)) control = Math.abs(flag.control) > 1.0001 ? flag.control / 100 : flag.control;
    else {
      const capturing = asTeam(flag.capturing);
      const progress = clamp(flag.progress, 0, 1);
      control = owner ? teamSign(owner) * (capturing && capturing !== owner ? 1 - progress : 1)
        : capturing ? teamSign(capturing) * progress : 0;
      state ??= flag.contested === true ? 'contested'
        : capturing ? (owner && capturing !== owner ? 'neutralizing' : 'capturing') : 'idle';
    }
    out.push({ id: String(flag.id).toUpperCase(), control: clamp(control, -1, 1), owner, state: state || 'idle',
      atk: Math.max(0, flag.atk | 0), def: Math.max(0, flag.def | 0) });
  }
  return out;
}

// ------------------------------------------------------------ geometry
function boxInto(positions, normals, sx, sy, sz, cx, cy, cz) {
  const box = new THREE.BoxGeometry(sx, sy, sz).toNonIndexed();
  box.translate(cx, cy, cz);
  positions.push(...box.attributes.position.array);
  normals.push(...box.attributes.normal.array);
  box.dispose();
}

/** Plinth, mast and finial in one non-indexed geometry (foot at the origin). */
function makeMastGeometry() {
  const positions = [], normals = [];
  boxInto(positions, normals, 1.1, 0.35, 1.1, 0, 0.175, 0);
  boxInto(positions, normals, 0.62, 0.3, 0.62, 0, 0.5, 0);
  boxInto(positions, normals, 0.16, MAST_HEIGHT, 0.16, 0, MAST_HEIGHT / 2, 0);
  boxInto(positions, normals, 0.34, 0.22, 0.34, 0, MAST_HEIGHT + 0.08, 0);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.computeBoundingSphere();
  return geometry;
}

/** Subdivided cloth, hoist edge on the mast (x = 0.08), bottom edge at y = 0. */
function makeClothGeometry() {
  const geometry = new THREE.PlaneGeometry(CLOTH_WIDTH, CLOTH_HEIGHT, 12, 5);
  geometry.translate(CLOTH_WIDTH / 2 + 0.08, CLOTH_HEIGHT / 2, 0);
  return geometry;
}

/** Open tapered tube with a 0..1 height coordinate in uv.y. */
function makeBeamGeometry() {
  const geometry = new THREE.CylinderGeometry(BEAM_RADIUS[1], BEAM_RADIUS[0], BEAM_HEIGHT, 10, 8, true);
  geometry.translate(0, BEAM_HEIGHT / 2, 0);
  return geometry;
}

// ------------------------------------------------------------ materials
const CLOTH_WAVE = /* glsl */ `
#include <begin_vertex>
{
  // Wind ripple grows with the distance from the hoist edge.
  float clothAlong = max( position.x - 0.08, 0.0 );
  float clothPhase = clothAlong * 2.3 - clothTime * 4.2 + position.y * 0.7;
  transformed.z += sin( clothPhase ) * 0.16 * clothAlong / ${CLOTH_WIDTH.toFixed(2)};
  transformed.y -= clothAlong * clothAlong * 0.025;
}
`;

function makeClothMaterial(time, lightUniforms) {
  const material = new THREE.MeshLambertMaterial({ side: THREE.DoubleSide });
  material.name = 'conquest-cloth';
  material.onBeforeCompile = (shader) => {
    shader.uniforms.clothTime = time;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float clothTime;')
      .replace('#include <begin_vertex>', CLOTH_WAVE);
  };
  material.customProgramCacheKey = () => 'conquest-cloth-v1';
  return lightUniforms ? patchVoxelLitMaterial(material, lightUniforms, 'voxel-lit') : material;
}

const BEAM_VERT = /* glsl */ `
attribute vec2 beamParams;
varying float vBeamHeight;
varying vec3 vBeamColor;
varying float vBeamGlow;
varying float vBeamEdge;
varying float vBeamDepth;
varying float vBeamReach;
void main() {
  vec4 local = vec4( position, 1.0 );
  vec4 foot = vec4( 0.0, 0.0, 0.0, 1.0 );
  #ifdef USE_INSTANCING
    local = instanceMatrix * local;
    foot = instanceMatrix * foot;
  #endif
  // Ground distance from the camera to the beam's axis (not view depth, which
  // grows up the beam): the near fade treats the whole beam alike.
  vBeamReach = length( cameraPosition.xz - ( modelMatrix * foot ).xz );
  vec4 world = modelMatrix * local;
  vec4 mvPosition = viewMatrix * world;
  gl_Position = projectionMatrix * mvPosition;
  vBeamHeight = uv.y;
  vBeamColor = vec3( 1.0 );
  #ifdef USE_INSTANCING_COLOR
    vBeamColor = instanceColor;
  #endif
  vBeamGlow = beamParams.x;
  // Soft silhouette: bright where the tube faces the camera, fading at its rim.
  vec3 beamNormal = normal;
  #ifdef USE_INSTANCING
    beamNormal = mat3( instanceMatrix ) * beamNormal;
  #endif
  vec3 worldNormal = normalize( mat3( modelMatrix ) * beamNormal );
  vec3 toCamera = normalize( cameraPosition - world.xyz );
  vBeamEdge = abs( dot( worldNormal, toCamera ) );
  vBeamDepth = -mvPosition.z;
}`;

const BEAM_FRAG = /* glsl */ `
uniform float beamFog;
varying float vBeamHeight;
varying vec3 vBeamColor;
varying float vBeamGlow;
varying float vBeamEdge;
varying float vBeamDepth;
varying float vBeamReach;
#include <fog_pars_fragment>
void main() {
  float lift = smoothstep( 0.0, 0.04, vBeamHeight ) * ( 1.0 - smoothstep( ${BEAM_TAIL[0].toFixed(2)}, ${BEAM_TAIL[1].toFixed(2)}, vBeamHeight ) );
  float core = pow( vBeamEdge, ${BEAM_CORE_POWER.toFixed(2)} );
  float a = lift * core * vBeamGlow;
  // Close to the flag the beam steps aside for the mast, cloth and ring.
  a *= smoothstep( ${BEAM_NEAR_FADE[0].toFixed(1)}, ${BEAM_NEAR_FADE[1].toFixed(1)}, vBeamReach );
  // Fog-reduced: the beam fades with only part of the scene fog, so a far
  // objective still reads through the haze; the far fade still ends it.
  float fade = 1.0;
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      float fogAmount = 1.0 - exp( - fogDensity * fogDensity * vBeamDepth * vBeamDepth );
    #else
      float fogAmount = smoothstep( fogNear, fogFar, vBeamDepth );
    #endif
    fade *= 1.0 - beamFog * fogAmount;
  #endif
  #ifdef VB_FAR_FADE_START
    fade *= 1.0 - smoothstep( VB_FAR_FADE_START, VB_FAR_FADE_END, vBeamDepth );
  #endif
  // Premultiplied additive (ONE, ONE), kept below 1.0 so no tier blooms it: a
  // discreet bearing hint, the HUD markers carry the objective.
  gl_FragColor = vec4( vBeamColor * a * fade, 0.0 );
}`;

function makeBeamMaterial() {
  const material = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { beamFog: { value: BEAM_FOG } }]),
    vertexShader: BEAM_VERT, fragmentShader: BEAM_FRAG,
    transparent: true, depthWrite: false, depthTest: true, fog: true, toneMapped: false,
    side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
    // The fragment writes premultiplied colour with alpha 0: straight-alpha
    // additive blending (SRC_ALPHA, ONE) would multiply it away entirely.
    premultipliedAlpha: true,
  });
  material.name = 'conquest-beam';
  return material;
}

const RING_VERT = /* glsl */ `
attribute vec3 ringColor;
attribute vec2 ringParams;
attribute float ringShow;
varying vec3 vRingColor;
varying vec2 vRingParams;
varying float vRingAcross;
varying float vRingAlong;
varying float vRingDepth;
#include <fog_pars_vertex>
void main() {
  vRingColor = ringColor;
  vRingParams = vec2( ringParams.x * ringShow, ringParams.y );
  vRingAcross = uv.y;
  vRingAlong = uv.x;
  vec4 mvPosition = modelViewMatrix * vec4( position, 1.0 );
  vRingDepth = -mvPosition.z;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const RING_FRAG = /* glsl */ `
varying vec3 vRingColor;
varying vec2 vRingParams;
varying float vRingAcross;
varying float vRingAlong;
varying float vRingDepth;
#include <fog_pars_fragment>
void main() {
  // Dashed band with soft edges; x: opacity, y: pulse 0..1 (contested).
  float edge = smoothstep( 0.0, 0.25, vRingAcross ) * ( 1.0 - smoothstep( 0.75, 1.0, vRingAcross ) );
  float dash = smoothstep( 0.18, 0.3, fract( vRingAlong ) ) * ( 1.0 - smoothstep( 0.7, 0.82, fract( vRingAlong ) ) );
  float alpha = edge * mix( 0.3, 1.0, dash ) * vRingParams.x;
  // A ground decal, not a ribbon: it fades out right in front of the camera.
  alpha *= smoothstep( ${RING_NEAR_FADE[0].toFixed(1)}, ${RING_NEAR_FADE[1].toFixed(1)}, vRingDepth );
  if ( alpha < 0.004 ) discard;
  gl_FragColor = vec4( vRingColor * ( 1.0 + 0.6 * vRingParams.y ), alpha );
  #include <fog_fragment>
}`;

function makeRingMaterial() {
  const material = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog]),
    vertexShader: RING_VERT, fragmentShader: RING_FRAG,
    transparent: true, depthWrite: false, depthTest: true, fog: true,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
  });
  material.name = 'conquest-ring';
  return material;
}

// ------------------------------------------------------------ labels
function cssHex(hex) { return `#${hex.toString(16).padStart(6, '0')}`; }

function paintLabel(flag, colorFor) {
  const ctx = flag.context, center = LABEL_SIZE / 2;
  ctx.clearRect(0, 0, LABEL_SIZE, LABEL_SIZE);
  ctx.beginPath(); ctx.arc(center, center, 98, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(12, 18, 22, 0.8)'; ctx.fill();
  ctx.lineWidth = 9;
  ctx.strokeStyle = cssHex(colorFor(flag.label.owner));
  ctx.stroke();
  // Control arc: the share of the mast the controlling side has hoisted.
  const amount = Math.abs(flag.label.control);
  if (amount > 0.005) {
    ctx.beginPath();
    ctx.arc(center, center, 114, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * amount);
    ctx.lineWidth = 12;
    ctx.strokeStyle = cssHex(colorFor(flag.label.control > 0 ? 'alpha' : 'bravo'));
    ctx.stroke();
  }
  if (flag.label.state === 'contested') {
    ctx.beginPath(); ctx.arc(center, center, 84, 0, Math.PI * 2);
    ctx.lineWidth = 5; ctx.strokeStyle = '#ffd36a'; ctx.stroke();
  }
  ctx.font = '900 150px Arial, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = '#fff8e9'; ctx.fillText(flag.id, center, center + 8);
  flag.texture.needsUpdate = true;
}

const _matrix = new THREE.Matrix4();
const _rotation = new THREE.Matrix4();
const _color = new THREE.Color();
const _camera = new THREE.Vector3();

/** Visible, non-colliding peers of the server's Conquest objectives. */
export class ConquestWorld {
  /**
   * @param {THREE.Object3D|null} scene
   * @param {object} layout mapMeta.conquest ({ flags: [{id, x, y, z, radius}] })
   * @param {{getBlock?:Function, lightUniforms?:object, windYaw?:number}} options getBlock seats
   *   the capture rings on the ground; lightUniforms lights masts and cloths with the voxel volume.
   */
  constructor(scene, layout, { getBlock = null, lightUniforms = null, windYaw = CONQUEST_WIND_YAW } = {}) {
    this.group = new THREE.Group(); this.group.name = 'conquest-objectives';
    this.group.visible = false;
    this.layout = layout || null;
    this.getBlock = typeof getBlock === 'function' ? getBlock : null;
    this.flags = new Map(); this.order = []; this.disposed = false;
    this.viewerTeam = null;
    this.applyPending = true;
    this.time = { value: 0 };
    this.pulse = 0;
    const authored = Array.isArray(layout?.flags) ? layout.flags : [];
    for (const definition of authored) {
      if (!definition || ![definition.x, definition.y, definition.z].every(Number.isFinite)) continue;
      const id = String(definition.id ?? '').toUpperCase();
      if (!id || this.flags.has(id)) continue;
      const radius = Number.isFinite(definition.radius) && definition.radius > 0 ? definition.radius : 20;
      const flag = { id, index: this.order.length, x: definition.x, y: definition.y, z: definition.z, radius,
        owner: null, control: 0, state: 'idle', atk: 0, def: 0, shown: 0, ringDirty: true, label: null };
      this.flags.set(id, flag); this.order.push(flag);
    }
    if (this.order.length) this.build(lightUniforms, windYaw);
    scene?.add(this.group);
  }

  build(lightUniforms, windYaw) {
    const n = this.order.length;
    this.windYaw = windYaw;
    this.mastMaterial = new THREE.MeshLambertMaterial({ color: 0x8b9294 });
    this.mastMaterial.name = 'conquest-mast';
    if (lightUniforms) patchVoxelLitMaterial(this.mastMaterial, lightUniforms, 'voxel-lit');
    this.masts = new THREE.InstancedMesh(makeMastGeometry(), this.mastMaterial, n);
    this.masts.name = 'conquest-masts';
    this.cloths = new THREE.InstancedMesh(makeClothGeometry(), makeClothMaterial(this.time, lightUniforms), n);
    this.cloths.name = 'conquest-cloths';
    this.beams = new THREE.InstancedMesh(makeBeamGeometry(), makeBeamMaterial(), n);
    this.beams.name = 'conquest-beams';
    this.beamParams = new THREE.InstancedBufferAttribute(new Float32Array(n * 2), 2);
    this.beamParams.setUsage(THREE.DynamicDrawUsage);
    this.beams.geometry.setAttribute('beamParams', this.beamParams);
    for (const mesh of [this.cloths, this.beams]) {
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      // Colour attribute exists from the start: its define is part of the program key.
      for (let i = 0; i < n; i++) mesh.setColorAt(i, _color.setHex(CONQUEST_FLAG_COLORS.neutral));
      mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    }
    this.beams.renderOrder = 4;
    for (const flag of this.order) {
      _matrix.makeTranslation(flag.x, flag.y, flag.z);
      this.masts.setMatrixAt(flag.index, _matrix);
      this.beams.setMatrixAt(flag.index, _matrix);
    }
    for (const mesh of [this.masts, this.cloths, this.beams]) {
      mesh.computeBoundingSphere();
      // Cloth heights and beams move inside the authored extent; never cull them early.
      mesh.frustumCulled = mesh !== this.beams;
      this.group.add(mesh);
    }
    this.cloths.frustumCulled = false;
    this.buildRings();
    for (const flag of this.order) this.buildLabel(flag);
    this.applyAll();
  }

  /**
   * One merged band per flag at its capture radius, seated on the ground.
   * Every segment owns its quad (RING_VERTICES_PER_FLAG), so a segment that
   * would climb a wall or a roof is dropped instead of standing up as a sheet.
   */
  buildRings() {
    const n = this.order.length, perFlag = RING_VERTICES_PER_FLAG;
    const positions = new Float32Array(n * perFlag * 3);
    const uvs = new Float32Array(n * perFlag * 2);
    this.ringColors = new THREE.BufferAttribute(new Float32Array(n * perFlag * 3), 3);
    this.ringParams = new THREE.BufferAttribute(new Float32Array(n * perFlag * 2), 2);
    this.ringShow = new THREE.BufferAttribute(new Float32Array(n * perFlag).fill(1), 1);
    this.ringColors.setUsage(THREE.DynamicDrawUsage);
    this.ringParams.setUsage(THREE.DynamicDrawUsage);
    const index = [];
    for (const flag of this.order) {
      const base = flag.index * perFlag;
      const dashes = Math.max(12, Math.round(flag.radius * Math.PI * 2 / 3.2));
      for (let s = 0; s < RING_SEGMENTS; s++) {
        const a = base + s * 4, u0 = s / RING_SEGMENTS * dashes, u1 = (s + 1) / RING_SEGMENTS * dashes;
        uvs.set([u0, 0, u0, 1, u1, 0, u1, 1], a * 2);
        index.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geometry.setAttribute('ringColor', this.ringColors);
    geometry.setAttribute('ringParams', this.ringParams);
    geometry.setAttribute('ringShow', this.ringShow);
    geometry.setIndex(index);
    this.ringPositions = geometry.attributes.position;
    this.rings = new THREE.Mesh(geometry, makeRingMaterial());
    this.rings.name = 'conquest-rings';
    this.rings.renderOrder = 2;
    this.group.add(this.rings);
    for (const flag of this.order) this.seatRing(flag);
    geometry.computeBoundingSphere();
  }

  /**
   * Ground top near (x, z): the open-above surface within a few metres of the
   * flag foot that is closest to `ref` (the neighbouring ring point), so the
   * ring follows the terrain and floors instead of hopping onto roofs.
   */
  groundAt(x, z, near, ref = near) {
    if (!this.getBlock) return near;
    const ix = Math.floor(x), iz = Math.floor(z);
    const high = Math.floor(near) + 8, low = Math.floor(near) - 10;
    let best = null, solidSeen = false;
    for (let y = high; y > low; y--) {
      if (this.getBlock(ix, y - 1, iz) === 0) continue;
      solidSeen = true;
      if (this.getBlock(ix, y, iz) !== 0) continue;
      if (best === null || Math.abs(y - ref) < Math.abs(best - ref)) best = y;
    }
    if (best !== null) return best;
    if (!solidSeen) return near;
    // Buried in a solid column (a wall on the ring): climb to its open top.
    let y = high, climb = 0;
    while (climb < 6 && this.getBlock(ix, y, iz) !== 0) { y++; climb++; }
    return y;
  }

  seatRing(flag) {
    const perFlag = RING_VERTICES_PER_FLAG, base = flag.index * perFlag;
    const array = this.ringPositions.array, show = this.ringShow.array;
    const foot = Math.floor(flag.y + 0.01);
    // Ground under every ring point, each chosen next to the previous one (continuity).
    const grounds = new Float64Array(RING_SEGMENTS + 1);
    let ref = foot;
    for (let s = 0; s <= RING_SEGMENTS; s++) {
      const angle = (s / RING_SEGMENTS) * Math.PI * 2;
      ref = grounds[s] = this.groundAt(flag.x + Math.cos(angle) * flag.radius, flag.z + Math.sin(angle) * flag.radius, foot, ref);
    }
    for (let s = 0; s < RING_SEGMENTS; s++) {
      const visible = Math.abs(grounds[s + 1] - grounds[s]) <= RING_MAX_STEP ? 1 : 0;
      for (let end = 0; end < 2; end++) {
        const angle = ((s + end) / RING_SEGMENTS) * Math.PI * 2;
        const dx = Math.cos(angle), dz = Math.sin(angle), ground = grounds[s + end] + 0.06;
        for (let side = 0; side < 2; side++) {
          const r = flag.radius + (side ? RING_WIDTH / 2 : -RING_WIDTH / 2);
          const v = base + s * 4 + end * 2 + side;
          array.set([flag.x + dx * r, ground, flag.z + dz * r], v * 3);
          show[v] = visible;
        }
      }
    }
    this.ringPositions.needsUpdate = true;
    this.ringShow.needsUpdate = true;
    flag.ringDirty = false;
  }

  buildLabel(flag) {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = LABEL_SIZE;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('2D canvas unavailable for Conquest flag label');
    const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
    const material = new THREE.SpriteMaterial({ map: texture, transparent: true,
      opacity: 0.92, depthTest: true, depthWrite: false, toneMapped: false, fog: false });
    material.name = 'conquest-label';
    const sprite = new THREE.Sprite(material); sprite.name = `conquest-label-${flag.id}`;
    sprite.position.set(flag.x, flag.y + MAST_HEIGHT + 2.2, flag.z); sprite.scale.set(2.2, 2.2, 1);
    sprite.renderOrder = 6;
    this.group.add(sprite);
    flag.sprite = sprite; flag.texture = texture; flag.context = context;
    flag.label = { owner: undefined, control: NaN, state: null };
  }

  /** Team-relative colours once the local player's team is known (WEST blue, EAST orange before). */
  setViewerTeam(team) {
    const next = asTeam(team);
    if (next === this.viewerTeam) return;
    this.viewerTeam = next;
    for (const flag of this.order) if (flag.label) flag.label.owner = undefined;
    this.applyAll();
  }

  colorFor(team) {
    if (!asTeam(team)) return CONQUEST_FLAG_COLORS.neutral;
    if (this.viewerTeam) return team === this.viewerTeam ? CONQUEST_FLAG_COLORS.own : CONQUEST_FLAG_COLORS.enemy;
    return team === 'alpha' ? CONQUEST_FLAG_COLORS.own : CONQUEST_FLAG_COLORS.enemy;
  }

  setMode(mode) {
    this.group.visible = !this.disposed && mode === 'conquest' && this.flags.size > 0;
  }

  sync(match) {
    if (this.disposed) return;
    const states = conquestFlagStates(match, this.layout);
    if (!states) return;
    for (const state of states) {
      const flag = this.flags.get(state.id);
      if (!flag) continue;
      if (flag.owner !== state.owner || flag.control !== state.control || flag.state !== state.state) this.applyPending = true;
      flag.owner = state.owner; flag.control = state.control; flag.state = state.state;
      flag.atk = state.atk; flag.def = state.def;
    }
  }

  /** Re-seat capture rings near destroyed or placed blocks. */
  applyDeltas(deltas) {
    if (this.disposed || !this.getBlock || !deltas?.length) return;
    for (const flag of this.order) {
      if (flag.ringDirty) continue;
      for (const d of deltas) {
        const r = Math.hypot(d.x + 0.5 - flag.x, d.z + 0.5 - flag.z);
        if (Math.abs(r - flag.radius) <= 2) { flag.ringDirty = true; break; }
      }
    }
  }

  /** Height (metres above the mast foot) of the cloth's lower edge for a control share 0..1. */
  static clothHeight(amount) {
    return CLOTH_LOW + (CLOTH_HIGH - CLOTH_LOW) * clamp(amount, 0, 1);
  }

  /** Displayed hoist 0..1 and the side it belongs to. */
  clothState(flag) {
    return { amount: Math.abs(flag.shown), team: flag.shown > 0.002 ? 'alpha' : flag.shown < -0.002 ? 'bravo' : null };
  }

  applyFlag(flag) {
    const { amount, team } = this.clothState(flag);
    _rotation.makeRotationY(this.windYaw);
    _matrix.makeTranslation(flag.x, flag.y + ConquestWorld.clothHeight(amount), flag.z).multiply(_rotation);
    this.cloths.setMatrixAt(flag.index, _matrix);
    this.cloths.setColorAt(flag.index, _color.setHex(this.colorFor(team)));
    const contested = flag.state === 'contested';
    const pulse = contested ? 0.5 + 0.5 * Math.sin(this.pulse * Math.PI * 2 * 1.6) : 0;
    this.beams.setColorAt(flag.index, _color.setHex(this.colorFor(flag.owner)));
    const glow = flag.owner ? BEAM_GLOW.owned : BEAM_GLOW.neutral;
    this.beamParams.setXY(flag.index, contested ? glow * (0.7 + 0.3 * pulse) : glow, pulse);
    const perFlag = RING_VERTICES_PER_FLAG, base = flag.index * perFlag;
    _color.setHex(this.colorFor(flag.owner));
    for (let v = 0; v < perFlag; v++) {
      this.ringColors.setXYZ(base + v, _color.r, _color.g, _color.b);
      this.ringParams.setXY(base + v, contested ? 0.45 + 0.35 * pulse : 0.5, pulse);
    }
    const label = flag.label;
    // The marker arc moves in 1/LABEL_ARC_STEPS steps: a capture repaints and
    // uploads the 256 px label a few dozen times, not on every eased frame.
    const control = Math.round(flag.shown * LABEL_ARC_STEPS) / LABEL_ARC_STEPS;
    if (label && (label.owner !== flag.owner || label.control !== control || label.state !== flag.state)) {
      label.owner = flag.owner; label.control = control; label.state = flag.state;
      paintLabel(flag, (t) => this.colorFor(t));
    }
  }

  applyAll() {
    if (!this.cloths) return;
    for (const flag of this.order) this.applyFlag(flag);
    this.cloths.instanceMatrix.needsUpdate = true;
    this.cloths.instanceColor.needsUpdate = true;
    this.beams.instanceColor.needsUpdate = true;
    this.beamParams.needsUpdate = true;
    this.ringColors.needsUpdate = true;
    this.ringParams.needsUpdate = true;
  }

  /** Ease the hoist toward authority, animate cloth and pulse, depth-test labels by distance. */
  update(dt = 0, camera = null) {
    if (this.disposed || !this.cloths) return;
    const step = Math.max(0, Number(dt) || 0);
    this.time.value += step;
    this.pulse = (this.pulse + step) % 1000;
    const k = step > 0 ? 1 - Math.exp(-step * HOIST_EASE) : 1;
    // Settled flags upload nothing: instance, ring and label buffers change
    // only while a hoist eases, a state changes or a contested zone pulses.
    let changed = this.applyPending;
    this.applyPending = false;
    for (const flag of this.order) {
      const shown = flag.shown;
      flag.shown += (flag.control - flag.shown) * k;
      if (Math.abs(flag.control - flag.shown) < 0.001) flag.shown = flag.control;
      if (flag.shown !== shown || flag.state === 'contested') changed = true;
      if (flag.ringDirty) this.seatRing(flag);
    }
    if (changed) this.applyAll();
    if (camera) {
      camera.getWorldPosition?.(_camera) ?? _camera.copy(camera.position);
      for (const flag of this.order) {
        const sprite = flag.sprite;
        const distance = _camera.distanceTo(sprite.position);
        const far = distance > LABEL_DEPTH_DISTANCE;
        if (sprite.material.depthTest === far) sprite.material.depthTest = !far;
        // Keep the marker legible far away: at least ~2.2 m, growing with distance.
        const size = Math.max(2.2, distance * 0.04);
        sprite.scale.set(size, size, 1);
      }
    }
  }

  get stats() {
    let draws = 0;
    this.group.traverse((object) => { if (object.isMesh || object.isSprite) draws++; });
    return { flags: this.flags.size, draws };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true; this.group.visible = false;
    this.group.removeFromParent();
    for (const mesh of [this.masts, this.cloths, this.beams]) mesh?.dispose();
    disposeObjectTree(this.group);
    this.group.clear(); this.flags.clear(); this.order.length = 0;
  }
}
