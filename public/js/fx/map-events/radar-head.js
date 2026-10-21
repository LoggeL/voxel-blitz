/**
 * The flag radars' rotating antenna and sweep wave (docs/conquest.md "Flag
 * radars"): three.js meshes only, never map voxels (the structure's cells
 * are pinned by the map fingerprints). ./radar.js drives them from the `ev`
 * row; this file only builds and poses them.
 *
 *   head   a pedestal on the dome's or the mast's top voxel (the site's
 *          `mount`) and a rotor over it: a turntable, a curved reflector of
 *          seven slabs tilted back with accent bars along its top and bottom
 *          edges, the feed horn on its arm, a counterweight and a beacon. The
 *          accent and the beacon carry the owner's colour.
 *   wave   one flat ring (a soft band, bright at its leading edge) and, from
 *          the medium tier up, one open cylinder shell hanging under it:
 *          both unit-sized and scaled each frame, one draw each, no
 *          allocation per frame. Additive, no depth write, faded near the
 *          camera so a passing shell never fills the screen.
 */
import * as THREE from '../../vendor/three.module.js';
import { mergeGeometries } from '../../vendor/utils/BufferGeometryUtils.js';

/** Presentation tuning of the head (metres, the head's own frame at scale 1; the reflector faces +z at angle 0). */
export const RADAR_HEAD_RULES = Object.freeze({
  rotorY: 0.8,
  /** Neutral accent (an idle radar) and the body palette. */
  idle: '#7c838b',
  steel: '#3b4046', gun: '#5c636b', dark: '#4a5057', pale: '#c9ccc9', slat: '#8d9399',
});

const box = (w, h, d, x, y, z, color, rx = 0) => {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rx) g.rotateX(rx);
  g.translate(x, y, z);
  const c = new THREE.Color(color), n = g.attributes.position.count, colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return g;
};

/** The reflector's tilt back from vertical (radians), its centre in the rotor frame and its horizontal curve. */
const TILT = -0.26, PANEL = Object.freeze({ y: 1.3, z: 0.32 }), CURVE = Object.freeze({ radius: 2.8, segments: 7, width: 0.54, height: 1.2 });

/** The curved reflector as `segments` slabs on an arc concave toward +z, and the accent bars along its top and bottom edges. */
function reflector(R) {
  const body = [], accent = [];
  const n = CURVE.segments, step = CURVE.width / CURVE.radius;
  for (let i = 0; i < n; i++) {
    const phi = (i - (n - 1) / 2) * step, x = Math.sin(phi) * CURVE.radius, z = (1 - Math.cos(phi)) * CURVE.radius;
    // Posed in the reflector's frame (x across, y up its face, z out of it), then tilted back and moved onto the rotor.
    const place = (g, dy = 0, dz = 0) => g.translate(0, dy, dz).rotateY(-phi).translate(x, 0, z).rotateX(TILT).translate(0, PANEL.y, PANEL.z);
    body.push(place(box(CURVE.width + 0.02, CURVE.height, 0.12, 0, 0, 0, R.pale)));
    for (let k = 0; k < 4; k++) body.push(place(box(CURVE.width + 0.02, 0.05, 0.05, 0, 0, 0, R.slat), -0.42 + k * 0.28, 0.08));
    body.push(place(box(CURVE.width + 0.02, 0.1, 0.2, 0, 0, 0, R.dark), 0, -0.1));
    for (const dy of [CURVE.height / 2 + 0.07, -CURVE.height / 2 - 0.07]) accent.push(place(new THREE.BoxGeometry(CURVE.width + 0.02, 0.14, 0.2), dy, 0));
  }
  return { body, accent };
}

let shared = null;
/** Geometries and the body material every head shares (built once). */
function sharedParts() {
  if (shared) return shared;
  const R = RADAR_HEAD_RULES;
  const pedestal = mergeGeometries([
    box(1.2, 0.2, 1.2, 0, 0.1, 0, R.steel),
    box(0.5, 0.6, 0.5, 0, 0.5, 0, R.gun),
  ]);
  const ref = reflector(R);
  const rotor = mergeGeometries([
    box(0.9, 0.15, 0.9, 0, 0.075, 0, R.gun),
    box(0.22, 1.0, 0.22, 0, 0.6, 0, R.gun),
    box(0.18, 0.18, 1.15, 0, 1.0, -0.15, R.dark),
    box(0.7, 0.45, 0.35, 0, 1.0, -0.72, R.dark),
    // The feed: an arm out from the turntable to a horn at the reflector's focus.
    box(0.1, 0.1, 1.6, 0, 0.62, 1.0, R.dark, -0.3),
    box(0.3, 0.24, 0.26, 0, 0.86, 1.78, R.gun),
    ...ref.body,
  ]);
  const accent = mergeGeometries([...ref.accent, new THREE.BoxGeometry(0.72, 0.1, 0.36).translate(0, 1.0, -0.72)]);
  const beacon = new THREE.BoxGeometry(0.26, 0.26, 0.26).translate(0, 1.36, -0.72);
  const body = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0.35, name: 'radar-head' });
  shared = { pedestal, rotor, accent, beacon, body };
  return shared;
}

const WAVE_VERTEX = /* glsl */`
  varying vec2 vLocal;
  varying float vV;
  varying float vDepth;
  void main() {
    vLocal = position.xz;
    vV = uv.y;
    vec4 view = modelViewMatrix * vec4(position, 1.0);
    vDepth = -view.z;
    gl_Position = projectionMatrix * view;
  }
`;
// Ring: the band from uInner to 1 of the unit radius, brightest at the leading edge.
const RING_FRAGMENT = /* glsl */`
  uniform vec3 uColor;
  uniform float uAlpha;
  uniform float uInner;
  varying vec2 vLocal;
  varying float vV;
  varying float vDepth;
  void main() {
    float r = length(vLocal);
    float k = clamp((r - uInner) / (1.0 - uInner), 0.0, 1.0);
    float a = uAlpha * (pow(k, 3.0) * 0.85 + 0.15 * k) * smoothstep(1.0, 0.985, r) * smoothstep(3.0, 14.0, vDepth);
    if (a < 0.002) discard;
    gl_FragColor = vec4(uColor * a, a);
  }
`;
// Shell: faint body, a bright lip at its top where it meets the ring.
const SHELL_FRAGMENT = /* glsl */`
  uniform vec3 uColor;
  uniform float uAlpha;
  uniform float uInner;
  varying vec2 vLocal;
  varying float vV;
  varying float vDepth;
  void main() {
    float a = uAlpha * (0.18 + 0.82 * pow(vV, 5.0)) * smoothstep(3.0, 14.0, vDepth);
    if (a < 0.002) discard;
    gl_FragColor = vec4(uColor * a, a);
  }
`;

function waveMaterial(fragmentShader) {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(1, 1, 1) }, uAlpha: { value: 0 }, uInner: { value: 0.84 } },
    vertexShader: WAVE_VERTEX, fragmentShader, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, toneMapped: false,
  });
}

/**
 * One radar's head and wave meshes in `scene`. `site` the shared radar site
 * (its `mount`), `pivot` {hinge [x, y, z], axis [x, z]} of a toppling part
 * or null, `shell` false on the low tier.
 */
export class RadarHead {
  constructor(scene, site, { shell = true, segments = 128 } = {}) {
    const S = sharedParts(), m = site.mount, scale = m.scale ?? 1;
    this.scene = scene;
    this.mount = m;
    // fall: the frame every pose hangs from (at the mount; a topple turns it about the hinge).
    this.fall = new THREE.Group();
    this.fall.name = `radar-head:${site.name}`;
    this.root = new THREE.Group();
    this.root.position.set(m.x, m.y, m.z);
    this.root.scale.setScalar(scale);
    this.tilt = new THREE.Group();
    this.rotor = new THREE.Group();
    this.rotor.position.y = RADAR_HEAD_RULES.rotorY;
    this.accentMaterial = new THREE.MeshBasicMaterial({ color: RADAR_HEAD_RULES.idle, toneMapped: false });
    this.beaconMaterial = new THREE.MeshBasicMaterial({ color: RADAR_HEAD_RULES.idle, toneMapped: false });
    const pedestal = new THREE.Mesh(S.pedestal, S.body);
    const rotor = new THREE.Mesh(S.rotor, S.body);
    const accent = new THREE.Mesh(S.accent, this.accentMaterial);
    const beacon = new THREE.Mesh(S.beacon, this.beaconMaterial);
    for (const mesh of [pedestal, rotor]) { mesh.castShadow = true; mesh.receiveShadow = true; }
    this.rotor.add(rotor, accent, beacon);
    this.tilt.add(pedestal, this.rotor);
    this.root.add(this.tilt);
    this.fall.add(this.root);
    scene.add(this.fall);

    this.ringMaterial = waveMaterial(RING_FRAGMENT);
    const ringGeometry = new THREE.RingGeometry(this.ringMaterial.uniforms.uInner.value, 1, segments, 1).rotateX(-Math.PI / 2);
    this.ring = new THREE.Mesh(ringGeometry, this.ringMaterial);
    this.ring.name = 'radar-wave-ring';
    this.ring.renderOrder = 5;
    this.ring.frustumCulled = false;
    this.ring.visible = false;
    this.shellMaterial = shell ? waveMaterial(SHELL_FRAGMENT) : null;
    this.shell = shell ? new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, segments, 1, true).translate(0, -0.5, 0), this.shellMaterial) : null;
    if (this.shell) { this.shell.name = 'radar-wave-shell'; this.shell.renderOrder = 4; this.shell.frustumCulled = false; this.shell.visible = false; scene.add(this.shell); }
    scene.add(this.ring);
    this._color = new THREE.Color();
    this._axis = new THREE.Vector3();
  }

  /**
   * Pose from ./radar.js's model: `angle` the rotor's heading, `tilt` [x, z]
   * small lean (radians), `accent` / `beacon` colours with a brightness,
   * `fall` {angle, axis [x, z], hinge [x, y, z]} or {drop} or null, `visible`,
   * `wave` {r, alpha, shellAlpha, shellM, color} or null.
   */
  pose(p) {
    this.fall.visible = !!p.visible;
    this.rotor.rotation.y = p.angle;
    this.tilt.rotation.set(p.tilt?.[0] ?? 0, 0, p.tilt?.[1] ?? 0);
    this.accentMaterial.color.set(p.accent).multiplyScalar(p.accentGain ?? 1);
    this.beaconMaterial.color.set(p.accent).multiplyScalar(p.beaconGain ?? 1);
    const f = p.fall, m = this.mount;
    if (f?.hinge) {
      this.fall.position.set(f.hinge[0], f.hinge[1], f.hinge[2]);
      this.root.position.set(m.x - f.hinge[0], m.y - f.hinge[1], m.z - f.hinge[2]);
      this.root.rotation.z = 0;
      this._axis.set(f.axis[0], 0, f.axis[1]);
      this.fall.quaternion.setFromAxisAngle(this._axis, f.angle);
    } else {
      this.fall.position.set(0, -(f?.drop ?? 0), 0);
      this.fall.quaternion.identity();
      this.root.position.set(m.x, m.y, m.z);
      this.root.rotation.z = f?.roll ?? 0;
    }
    const w = p.wave;
    this.ring.visible = !!w && w.alpha > 0.002;
    if (this.shell) this.shell.visible = !!w && w.shellAlpha > 0.002;
    if (!w) return;
    this._color.set(w.color);
    this.ring.position.set(m.x, m.y + 1, m.z);
    this.ring.scale.setScalar(Math.max(0.01, w.r));
    this.ringMaterial.uniforms.uColor.value.copy(this._color);
    this.ringMaterial.uniforms.uAlpha.value = w.alpha;
    if (this.shell) {
      this.shell.position.set(m.x, m.y + 1, m.z);
      this.shell.scale.set(Math.max(0.01, w.r), w.shellM, Math.max(0.01, w.r));
      this.shellMaterial.uniforms.uColor.value.copy(this._color);
      this.shellMaterial.uniforms.uAlpha.value = w.shellAlpha;
    }
  }

  /** Off the scene; the shared geometries and body material stay for the next map. */
  dispose() {
    this.scene?.remove?.(this.fall);
    this.scene?.remove?.(this.ring);
    if (this.shell) this.scene?.remove?.(this.shell);
    this.ring.geometry.dispose(); this.ringMaterial.dispose();
    this.shell?.geometry.dispose(); this.shellMaterial?.dispose();
    this.accentMaterial.dispose(); this.beaconMaterial.dispose();
    this.scene = null;
  }
}
