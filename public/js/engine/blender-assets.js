import * as THREE from '../vendor/three.module.js';
import { GLTFLoader } from '../vendor/loaders/GLTFLoader.js';
import { loadingScreen } from '../ui/loading-screen.js';

const ASSET_IDS = Object.freeze(['rivet', 'kestrel', 'peregrine', 'bison', 'fang', 'halo', 'hydra', 'ifrit', 'mastiff', 'pike', 'talon', 'torch', 'wasp', 'skua', 'hands', 'grenades']);

// Geometry and decoded ImageGen maps belong to the page, not to a player or a
// preview. Only materials are cloned, so one skin/fade cannot affect another rig.
const templates = new Map();
const textures = new Map();
let loading;

export function imagegenMap(name) {
  return textures.get(`textures/${name}.jpg`) || null;
}

export function loadBlenderAssets() {
  return loading ??= (async () => {
    // The sixteen models share 22 texture files. three.js only reuses a
    // response through its loader cache, so enable it for the library load and
    // release the raw buffers afterwards (decoded textures stay on the GPU).
    const cacheWasEnabled = THREE.Cache.enabled;
    THREE.Cache.enabled = true;
    const manager = new THREE.LoadingManager();
    let items = 0;
    manager.onStart = (url, loaded, total) => { items = Math.max(items, total); report(loaded, total); };
    manager.onProgress = (url, loaded, total) => { items = Math.max(items, total); report(loaded, total); };
    const loader = new GLTFLoader(manager);
    loadingScreen?.step('models', { status: 'active', done: 0, total: 1, detail: 'REQUESTING MODEL LIBRARY' });
    const results = await Promise.allSettled(ASSET_IDS.map(async id => {
      const gltf = await loader.loadAsync(new URL(`../../assets/blender/${id}.gltf`, import.meta.url).href);
      gltf.scene.traverse(object => {
        if (object.geometry) object.geometry.userData.pageOwned = true;
        for (const material of [].concat(object.material || [])) {
          if (material.userData.glass) material.depthWrite = false;
          const map = material.map;
          if (!map) continue;
          const key = map.name;
          if (textures.has(key)) material.map = textures.get(key);
          else {
            map.userData.pageOwned = true;
            map.anisotropy = 4;
            textures.set(key, map);
          }
          // The material library uses the same shared scan as a small height
          // detail map. Reusing the canonical texture avoids a second GPU copy.
          const bumpScale = material.userData.textureBumpScale;
          if (Number.isFinite(bumpScale) && bumpScale > 0) {
            material.bumpMap = material.map;
            material.bumpScale = bumpScale;
          }
        }
      });
      templates.set(id, gltf.scene);
    }));
    let missing = 0;
    for (const result of results) {
      if (result.status === 'rejected') { missing++; console.warn('[vb] Blender asset unavailable; using procedural model', result.reason); }
    }
    loadingScreen?.step('models', { status: missing === results.length ? 'failed' : 'done',
      detail: `${results.length - missing} / ${results.length} MODELS` });
    THREE.Cache.clear();
    THREE.Cache.enabled = cacheWasEnabled;
  })();
}

function report(loaded, total) {
  if (!Number.isFinite(total) || total <= 0) return;
  loadingScreen?.step('models', { done: loaded, total, detail: `${loaded} / ${total} FILES` });
}

/** Select rigid parts in gameplay joint coordinates; every returned material has one owner. */
export function createBlenderParts(id, { names, materialFor } = {}) {
  const template = templates.get(id);
  if (!template) return null;
  const materials = new Map();
  const parts = {};
  for (const source of template.children) {
    if (names && !names.includes(source.name)) continue;
    const part = new THREE.Group();
    part.name = source.name;
    part.userData.blenderAsset = id;
    // Flatten glTF's primitive wrapper so arm extension scales each rigid mesh.
    // The runtime export writes translation-only intermediate nodes (rounds,
    // gate leaves, cover leaves); the loader splits multi-primitive meshes and
    // sanitizes names, so accumulate every ancestor translation onto the mesh
    // and match meshes by normalized name downstream. Vertices stay untouched.
    const zero = new THREE.Vector3();
    source.traverse(object => {
      if (!object.isMesh) return;
      const mesh = object.clone(false);
      const offset = zero.clone();
      for (let node = object.parent; node; node = node.parent) {
        if (node.position) offset.add(node.position);
        if (node === source) break;
      }
      mesh.position.add(offset);
      const clone = original => {
        if (!materials.has(original)) materials.set(original, materialFor?.(original) || original.clone());
        return materials.get(original);
      };
      mesh.material = Array.isArray(object.material) ? object.material.map(clone) : clone(object.material);
      part.add(mesh);
    });
    parts[source.name] = part;
  }
  return parts;
}

// All synchronous builders (match, killcam, armory and capture pages) see the
// same loaded templates. The boot overlay is already visible during this await.
// Node simulation tests keep their DOM-free procedural models.
if (typeof window !== 'undefined' && /^https?:$/.test(globalThis.location?.protocol)) {
  await loadBlenderAssets();
}
