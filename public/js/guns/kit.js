// Shared procedural gun-building resources. Kept independent of defs.js so its fixed export
// surface remains private to the viewmodel facade.
import * as THREE from '../vendor/three.module.js';
import { createBlenderParts } from '../engine/blender-assets.js';

// Per-silhouette identity palette. These values are part of the visual contract.
export const COL = {
  steel: 0x3c4046, polyDark: 0x22252a, wood: 0x4b3621, amber: 0xff8c1a,
  tan: 0xb09a72, polymer: 0x15171a, blued: 0x2b3038, walnut: 0x5a3d24,
  cerakote: 0x37413a, greenSteel: 0x2e3830, fluteDark: 0x232b25,
  olive: 0x4a5137, parkerized: 0x343a34, gunmetal: 0x454b52,
  brake: 0x24282e, brass: 0xc9a227, shellRed: 0xa33327, flash: 0xffd977,
};

export const GLOW_ACCENT = {
  rifle: 0xffa03c, smg: 0x59e8ff, shotgun: 0xff7433, sniper: 0x7dfcff,
  minigun: 0xff9f32, lmg: 0xffb02e, revolver: 0xff6f45, longarc: 0x35e0ff, rocket: 0xff7a1c,
  lance: 0xc9a2ff, knife: 0xb8c4d4, flamethrower: 0xff7518, glaive: 0xff3fd0,
};

// Materials are shared across every rig, while each MaterialCache instance represents one rig's
// ownership. This preserves both cross-rig identity and one reference per material per rig.
const MATERIALS = new Map();
const MATERIAL_REFS = new Map();
const MATERIAL_KEYS = new Map();
const EMPTY_OPTIONS = Object.freeze({});
const TEN_SEGMENTS = Object.freeze({ seg: 10 });

// Gun-space placement of the Blender-authored gloves (HANDS study). The
// geometry is authored glove-local: back of the hand +y, knuckles -z, thumb
// -x, forearm +z. `back` is where the back of the hand faces in gun space,
// `fingers` the wrist-to-knuckle direction (orthogonalised against `back`),
// `offset` a palm-centre nudge from the shared anchor sheet. The support
// glove is the same right-hand geometry mirrored in x before this frame
// applies, so its thumb side is +x_local.
const BLENDER_HAND_FRAMES = Object.freeze({
  grip: { back: [0.90, 0.25, 0.35], fingers: [0.05, 0.40, -0.91], offset: [-0.030, -0.085, -0.010] },
  support: { back: [-0.60, -0.62, 0.30], fingers: [0.42, 0.70, -0.58], offset: [0.012, -0.028, 0.0] },
});

// Per-weapon palm-centre nudges where the shared anchor sheet was tuned for
// the old box mitt rather than a wrapped fist: short revolver grip; the IRON
// PICK fist slides ~2.9 sprite pixels down the stick from HANDS.knife.grip, the
// stick running through the curled fingers with a pixel of butt below them.
const BLENDER_HAND_OFFSETS = Object.freeze({
  revolver: { grip: [-0.025, -0.045, 0.0] },
  knife: { grip: [-0.012, -0.100, 0.050] },
});
// Per-weapon glove scale: the one-handed pick reads as a big fist on a small item.
const BLENDER_HAND_SCALES = Object.freeze({ knife: { grip: 1.3 } });

// Per-weapon basis overrides. The IRON PICK stick leans 20 degrees forward of
// vertical (models/iron-pickaxe.js PICKAXE_TILT), so the fist turns its wrap
// axis onto the stick instead of the raked pistol grip (a 47 degree turn).
const BLENDER_HAND_WEAPON_FRAMES = Object.freeze({
  knife: { grip: { back: [0.926, 0.127, 0.349], fingers: [0.204, -0.333, -0.916] } },
});

// Character-skin palette keys per HANDS material (see cosmetics/skins.js);
// the procedural mitt exposes the same three colours through its palette.
const BLENDER_HAND_PALETTE = Object.freeze({
  'glove leather': 0x22252a, 'ceramic armor': 0x15171a, webbing: 0xb09a72,
});

function orientBlenderHand(group, pose, weaponId) {
  const frame = BLENDER_HAND_WEAPON_FRAMES[weaponId]?.[pose] || BLENDER_HAND_FRAMES[pose];
  const z = new THREE.Vector3().fromArray(frame.fingers).normalize().negate();
  const y = new THREE.Vector3().fromArray(frame.back);
  y.addScaledVector(z, -y.dot(z)).normalize();
  const x = new THREE.Vector3().crossVectors(y, z);
  group.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
  const offset = BLENDER_HAND_OFFSETS[weaponId]?.[pose] || frame.offset;
  group.position.x += offset[0];
  group.position.y += offset[1];
  group.position.z += offset[2];
}

function refMaterial(material, sharedMaterials) {
  if (!MATERIAL_REFS.has(material) || sharedMaterials.has(material)) return;
  sharedMaterials.add(material);
  MATERIAL_REFS.set(material, MATERIAL_REFS.get(material) + 1);
}

export class MaterialCache {
  constructor() {
    this.sharedMaterials = new Set();
  }

  mat(hex, rough = 0.78, metal = 0.22) {
    const key = hex + '|' + rough + '|' + metal;
    let material = MATERIALS.get(key);
    if (!material) {
      material = new THREE.MeshStandardMaterial({
        color: hex,
        flatShading: true,
        roughness: rough,
        metalness: metal,
      });
      MATERIALS.set(key, material);
      MATERIAL_REFS.set(material, 0);
      MATERIAL_KEYS.set(material, key);
    }
    return material;
  }

  /** Register all cached materials in a newly built model, once for this rig. */
  refModel(root, sharedMaterials = this.sharedMaterials) {
    root.traverse((object) => {
      if (Array.isArray(object.material)) {
        for (const material of object.material) refMaterial(material, sharedMaterials);
      } else {
        refMaterial(object.material, sharedMaterials);
      }
    });
    return sharedMaterials;
  }

  /** Release a rig's cached-material ownership. Safe to call repeatedly after the Set is cleared. */
  releaseRig(sharedMaterials = this.sharedMaterials) {
    for (const material of sharedMaterials) {
      const refs = MATERIAL_REFS.get(material);
      if (refs > 1) {
        MATERIAL_REFS.set(material, refs - 1);
        continue;
      }
      if (refs === undefined) continue;
      MATERIALS.delete(MATERIAL_KEYS.get(material));
      MATERIAL_REFS.delete(material);
      MATERIAL_KEYS.delete(material);
      material.dispose();
    }
    sharedMaterials.clear();
  }
}

/** Create the procedural primitives bound to one rig's material owner. */
export function makeKit(cache) {
  const mat = (hex, rough = 0.78, metal = 0.22) => cache.mat(hex, rough, metal);

  function box(parent, w, h, d, x, y, z, color, options = EMPTY_OPTIONS) {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(w, h, d),
      options.mat || cache.mat(color, options.rg ?? 0.78, options.mt ?? 0.22),
    );
    mesh.position.set(x, y, z);
    if (options.rx) mesh.rotation.x = options.rx;
    if (options.ry) mesh.rotation.y = options.ry;
    if (options.rz) mesh.rotation.z = options.rz;
    parent.add(mesh);
    return mesh;
  }

  /** Cylinder aligned to local Z (the bore direction). */
  function cylZ(parent, radius, length, x, y, z, color, options = EMPTY_OPTIONS) {
    const geometry = new THREE.CylinderGeometry(
      options.rTop ?? radius,
      options.rBot ?? radius,
      length,
      options.seg ?? 10,
      1,
      options.open === true,
    );
    geometry.rotateX(Math.PI / 2);
    const mesh = new THREE.Mesh(
      geometry,
      cache.mat(color, options.rg ?? 0.65, options.mt ?? 0.45),
    );
    mesh.position.set(x, y, z);
    parent.add(mesh);
    return mesh;
  }

  function brakeRings(parent, radius, x, y, zTip, count, gap, ringLength, color) {
    for (let i = 0; i < count; i++) {
      const z = zTip + 0.012 + gap * (i + 1) + ringLength * i;
      cylZ(parent, radius, ringLength, x, y, z, color ?? COL.brake, TEN_SEGMENTS);
    }
  }

  /**
   * Build a readable rear notch and front blade around one shared sight line.
   * `height` is the local-space aim point; ADS profiles place that point on the camera axis.
   */
  function ironSights(parent, {
    rearZ,
    frontZ,
    height,
    width = 0.046,
    gap = 0.014,
    color = COL.polyDark,
    accent = COL.amber,
  }) {
    parent.userData.sightHeight = height;
    const sights = new THREE.Group(); sights.name = "factory-optic";
    parent.add(sights); parent = sights;
    const earWidth = Math.max(0.008, (width - gap) / 2);
    const earX = gap / 2 + earWidth / 2;
    const earHeight = 0.032;
    const bladeHeight = 0.030;
    box(parent, width, 0.008, 0.018, 0, height - earHeight, rearZ, color);
    box(parent, earWidth, earHeight, 0.018, -earX, height - earHeight / 2, rearZ, color);
    box(parent, earWidth, earHeight, 0.018, earX, height - earHeight / 2, rearZ, color);
    box(parent, 0.030, 0.008, 0.014, 0, height - bladeHeight, frontZ, color);
    box(parent, 0.008, bladeHeight, 0.014, 0, height - bladeHeight / 2, frontZ, accent);
  }

  /** Static glove pose: deliberately no runtime IK or per-frame work. */
  function glove(parent, anchorX, anchorY, anchorZ, kind, mirror, weaponId = null) {
    const group = new THREE.Group();
    group.position.set(anchorX, anchorY, anchorZ);
    group.rotation.set(
      kind === 'support' ? -1.35 : -1.15,
      mirror * 0.22,
      kind === 'support' ? 0.15 : 0.05,
    );
    const pose = kind === 'support' ? 'support' : 'grip';
    const blenderNode = createBlenderParts('hands', { names: [pose] })?.[pose];
    if (blenderNode) {
      // Blender-authored glove hand: the meshes are cloned straight in and the
      // group takes the pose's own gun-space basis instead of the mitt's
      // Euler angles. Negative X scale mirrors the right-hand pose for the
      // left hand (three.js flips frontFace for negative determinants). The
      // delivered materials stay as exported (their maps and tints are the
      // design); only the skin-palette key is attached so character skins can
      // recolour leather, armor and webbing exactly like the mitt. The
      // procedural body below stays as the offline fallback. The meshes live
      // inside the hand group, so remote-avatar hiding is unaffected.
      group.userData.blenderAsset = 'hands';
      group.userData.handPose = pose;
      if (mirror < 0) group.scale.x = -1;
      group.scale.multiplyScalar(BLENDER_HAND_SCALES[weaponId]?.[pose] || 1);
      orientBlenderHand(group, pose, weaponId);
      for (const mesh of blenderNode.children) {
        for (const material of [].concat(mesh.material)) {
          const key = BLENDER_HAND_PALETTE[material.userData.partMaterial];
          if (key !== undefined) material.userData.paletteColor = key;
        }
      }
      group.add(...blenderNode.children);
      parent.add(group);
      return group;
    }
    box(group, 0.05, 0.03, 0.06, 0, 0, 0, COL.polyDark, { rg: 0.9, mt: 0.05 });
    for (let i = 0; i < 3; i++) {
      box(
        group,
        0.011,
        0.011,
        0.045,
        (i - 1) * 0.014 * mirror,
        -0.014,
        -0.035 + i * 0.004 * mirror,
        COL.polymer,
        { rg: 0.95, mt: 0.02 },
      );
    }
    box(group, 0.014, 0.012, 0.032, mirror * -0.024, -0.004, 0.012, COL.polymer);
    box(group, 0.052, 0.02, 0.02, 0, 0.004, 0.036, COL.tan, { rg: 0.95, mt: 0.03 });
    // Forearm: wrist plus a short tapered sleeve from the cuff toward the
    // elbow (gun-space down-back). The hand group is pitched steeply, so local
    // +z points skyward — aim a subgroup along the true elbow direction
    // instead. Lives inside the hand group, so remote avatars (which hide
    // hand_l/hand_r) are unaffected; the assemble glove-map pass textures it
    // like the mitt. Static geometry only.
    const elbow = new THREE.Vector3(0, -0.85, 0.5).normalize()
      .applyQuaternion(new THREE.Quaternion().setFromEuler(group.rotation).invert());
    const arm = new THREE.Group();
    arm.position.set(0, 0.004, 0.036);
    arm.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), elbow);
    box(arm, 0.044, 0.024, 0.04, 0, 0, 0.02, COL.polyDark, { rg: 0.9, mt: 0.05 });
    box(arm, 0.054, 0.032, 0.11, 0, 0, 0.085, COL.tan, { rg: 0.95, mt: 0.03 });
    box(arm, 0.056, 0.034, 0.022, 0, 0, 0.145, COL.polyDark, { rg: 0.9, mt: 0.05 });
    group.add(arm);
    parent.add(group);
    return group;
  }

  // mat is exposed to builders that need a cached material for a custom THREE primitive.
  return { mat, box, cylZ, brakeRings, glove, ironSights };
}

const FX_VERTEX_SHADER = `varying vec3 vN; varying vec3 vW;
void main(){
  vN = normalize(normalMatrix * normal);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vW = wp.xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const FX_FRAGMENT_SHADER = `uniform float uGlow; uniform float uHeat; uniform float uT;
uniform vec3 uAccent; uniform vec3 uBase;
varying vec3 vN; varying vec3 vW;
void main(){
  float rim = pow(1.0 - abs(normalize(vN).z), 1.5) * 0.35;
  vec3 col = uBase * 0.2 + uAccent * (uGlow * (0.75 + rim));
  float shim = 0.60 + 0.40 * sin(uT * 22.0 + vW.y * 140.0);
  vec3 ember = mix(vec3(0.02, 0.0, 0.0), vec3(0.85, 0.12, 0.03), clamp(uHeat * shim, 0.0, 1.0));
  col += ember * uHeat;
  gl_FragColor = vec4(col, clamp(uGlow + uHeat, 0.0, 1.0));
}`;

export function makeFx(id, accent = GLOW_ACCENT[id]) {
  const uniforms = {
    uGlow: { value: 0 },
    uHeat: { value: 0 },
    uT: { value: 0 },
    uAccent: { value: new THREE.Color(accent) },
    uBase: { value: new THREE.Color(COL.polyDark) },
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: FX_VERTEX_SHADER,
    fragmentShader: FX_FRAGMENT_SHADER,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  return { uniforms, material };
}

export function makeFlash() {
  const group = new THREE.Group();
  const makePlane = () => new THREE.Mesh(
    new THREE.PlaneGeometry(0.14, 0.14),
    new THREE.MeshBasicMaterial({
      color: COL.flash,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  const first = makePlane();
  const second = makePlane();
  second.rotation.z = Math.PI / 2;
  group.add(first);
  group.add(second);
  const light = new THREE.PointLight(COL.flash, 0, 6);
  // Illumination is copied into the fixed scene pool; this source never renders.
  light.visible = false;
  group.add(light);
  group.visible = false;
  return { grp: group, mats: [first.material, second.material], light };
}

/** Procedural circle-and-mildot texture; null keeps headless model construction usable. */
export function makeReticleTexture() {
  try {
    if (typeof document === 'undefined') return null;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 64;
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.clearRect(0, 0, 64, 64);
    context.strokeStyle = 'rgba(136,255,204,0.55)';
    context.lineWidth = 2;
    context.beginPath();
    context.arc(32, 32, 22, 0, Math.PI * 2);
    context.stroke();
    context.fillStyle = 'rgba(136,255,204,0.65)';
    const dotX = [32, 32, 18, 46];
    const dotY = [18, 46, 32, 32];
    for (let i = 0; i < 4; i++) {
      context.beginPath();
      context.arc(dotX[i], dotY[i], 1.6, 0, Math.PI * 2);
      context.fill();
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    return texture;
  } catch (_error) {
    return null;
  }
}
