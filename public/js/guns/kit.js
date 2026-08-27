// Shared procedural gun-building resources. Kept independent of defs.js so its fixed export
// surface remains private to the viewmodel facade.
import * as THREE from '../vendor/three.module.js';

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
  lmg: 0xffb02e, revolver: 0xff6f45,
};

// Materials are shared across every rig, while each MaterialCache instance represents one rig's
// ownership. This preserves both cross-rig identity and one reference per material per rig.
const MATERIALS = new Map();
const MATERIAL_REFS = new Map();
const MATERIAL_KEYS = new Map();
const EMPTY_OPTIONS = Object.freeze({});
const TEN_SEGMENTS = Object.freeze({ seg: 10 });

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

  /** Static box-mitt pose: deliberately no runtime IK or per-frame work. */
  function glove(parent, anchorX, anchorY, anchorZ, kind, mirror) {
    const group = new THREE.Group();
    group.position.set(anchorX, anchorY, anchorZ);
    group.rotation.set(
      kind === 'support' ? -1.35 : -1.15,
      mirror * 0.22,
      kind === 'support' ? 0.15 : 0.05,
    );
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
    parent.add(group);
    return group;
  }

  // mat is exposed to builders that need a cached material for a custom THREE primitive.
  return { mat, box, cylZ, brakeRings, glove };
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
