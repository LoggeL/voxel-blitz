import * as THREE from '../vendor/three.module.js';

// The decoded ImageGen maps live for the page. A rig owns only its material
// clones and UV geometry, so fading or disposing a preview cannot affect play.
const textures = new Map();
const SURFACES = Object.freeze({
  paint: { file: 'olive-paint', tileSize: 0.22, bumpScale: 0.0003 },
  steel: { file: 'brushed-steel', tileSize: 0.16, bumpScale: 0.0002 },
  rubber: { file: 'rubber', tileSize: 0.11, bumpScale: 0.0007 },
});
let loading;

export function loadStingerSurfaces() {
  return loading ??= (async () => {
    const loader = new THREE.TextureLoader();
    const results = await Promise.allSettled(Object.entries(SURFACES).map(async ([surface, spec]) => {
      const url = new URL(`../../assets/weapons/textures/stinger/${spec.file}.jpg`, import.meta.url);
      const texture = await loader.loadAsync(url.href);
      texture.name = `stinger/${spec.file}`;
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
      texture.anisotropy = 4;
      texture.userData.pageOwned = true;
      textures.set(surface, texture);
    }));
    for (const result of results) if (result.status === 'rejected') {
      console.warn('[vb] Stinger texture unavailable; using procedural surface', result.reason);
    }
  })();
}

// Project each face in model units, not normalized primitive UVs. A metre of
// tube receives the same texel density as a short clamp or a bevelled panel.
// Triangle-local vertices prevent the dominant-axis seam crossing a triangle.
function planarUV(mesh, tileSize) {
  const original = mesh.geometry;
  const geometry = original.index ? original.toNonIndexed() : original;
  if (geometry !== original) { mesh.geometry = geometry; original.dispose(); }
  const position = geometry.getAttribute('position');
  const uv = new Float32Array(position.count * 2);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const ab = new THREE.Vector3(), ac = new THREE.Vector3();
  mesh.updateMatrix();
  for (let i = 0; i < position.count; i += 3) {
    a.fromBufferAttribute(position, i).applyMatrix4(mesh.matrix);
    b.fromBufferAttribute(position, i + 1).applyMatrix4(mesh.matrix);
    c.fromBufferAttribute(position, i + 2).applyMatrix4(mesh.matrix);
    const normal = ab.subVectors(b, a).cross(ac.subVectors(c, a));
    const nx = Math.abs(normal.x), ny = Math.abs(normal.y), nz = Math.abs(normal.z);
    const axis = nx >= ny && nx >= nz ? 'x' : ny >= nz ? 'y' : 'z';
    let vertex = i;
    for (const point of [a, b, c]) {
      uv[vertex * 2] = (axis === 'z' ? point.x : point.z) / tileSize;
      uv[vertex * 2 + 1] = (axis === 'y' ? point.x : point.y) / tileSize;
      vertex++;
    }
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

/** Apply maps before batching, keeping all material clones local to this rig. */
export function applyStingerSurfaces(roots, palette) {
  if (!textures.size) return;
  const materials = new Map();
  const seen = new Set();
  const select = (material) => {
    const color = material.color?.getHex();
    if (color === palette.olive) return { surface: 'paint', tint: 0xe1e5d5 };
    if (color === palette.panel) return { surface: 'paint', tint: 0xffffff };
    if (color === palette.steel) return { surface: 'steel', tint: 0xd5e3e5 };
    if (color === palette.rubber) return { surface: 'rubber', tint: 0x819399 };
    if (color === palette.dark) return material.roughness >= 0.9
      ? { surface: 'rubber', tint: 0xc0d0d1 }
      : { surface: 'steel', tint: 0x687279 };
    return null;
  };
  const visit = (object) => {
    if (seen.has(object) || object.name === 'factory-optic' || object.userData.stingerUntextured) return;
    seen.add(object);
    const source = object.material;
    if (object.isMesh && source?.isMeshStandardMaterial) {
      const selected = select(source);
      const map = selected && textures.get(selected.surface);
      if (map) {
        if (!materials.has(source)) {
          const material = source.clone();
          material.name = `stinger/${selected.surface}`;
          material.color.setHex(selected.tint);
          material.map = material.bumpMap = map;
          material.bumpScale = SURFACES[selected.surface].bumpScale;
          material.userData.paletteColor = source.color.getHex();
          material.userData.imagegenTexture = map.name;
          materials.set(source, material);
        }
        object.material = materials.get(source);
        planarUV(object, SURFACES[selected.surface].tileSize);
      }
    }
    for (const child of object.children) visit(child);
  };
  for (const root of Array.isArray(roots) ? roots : [roots]) visit(root);
}

// Synchronous gun builders see decoded maps in the browser. Node simulation
// tests keep their procedural surfaces and never need a DOM or image loader.
if (typeof window !== 'undefined' && typeof document !== 'undefined'
  && /^https?:$/.test(globalThis.location?.protocol)) {
  await loadStingerSurfaces();
}
