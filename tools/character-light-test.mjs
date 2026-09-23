// Blob contact shadows and character lighting without a GPU: ground search,
// culling, the pool cap and cache invalidation of ContactShadows, and the
// per-draw near switch that gives only the viewmodel and own body the camera
// probe (a remote avatar at knife range keeps its own light).
import assert from 'node:assert/strict';
import * as THREE from '../public/js/vendor/three.module.js';
import { AIR, STONE, MC_WATER } from '../shared/worlddata.js';
import { ContactShadows, CONTACT_SHADOW } from '../public/js/engine/contact-shadows.js';
import {
  characterLightUniforms, isNearCharacterObject, patchCharacterMaterial, setCharacterNearRoots,
} from '../public/js/engine/character-light.js';
import { WorldView } from '../public/js/engine/worldview.js';

let checks = 0;
const check = (fn) => { fn(); checks++; };

/** Flat stone floor with its top face at y = 10; a water pool at x 20..23. */
function makeWorld() {
  const blocks = new Map();
  const key = (x, y, z) => `${x},${y},${z}`;
  const getBlock = (x, y, z) => {
    const set = blocks.get(key(x, y, z));
    if (set !== undefined) return set;
    if (y > 9) return AIR;
    if (y === 9 && x >= 20 && x < 24) return MC_WATER;
    return STONE;
  };
  return { getBlock, setBlock: (x, y, z, v) => blocks.set(key(x, y, z), v) };
}

const blobY = (shadows, i) => shadows.mesh.instanceMatrix.array[i * 16 + 13];
const blobSize = (shadows, i) => shadows.mesh.instanceMatrix.array[i * 16];
const blobAlpha = (shadows, i) => shadows.mesh.instanceColor.array[i * 3];

// --- blob on flat ground ---------------------------------------------------------
{
  const world = makeWorld();
  const shadows = new ContactShadows(world.getBlock);
  shadows.begin();
  check(() => assert.equal(shadows.add(1.5, 10, 1.5, 0.5, 0.7), true));
  shadows.end();
  check(() => assert.equal(shadows.mesh.count, 1));
  check(() => assert.ok(Math.abs(blobY(shadows, 0) - (10 + CONTACT_SHADOW.lift)) < 1e-6, 'sits on the floor face'));
  check(() => assert.ok(Math.abs(blobSize(shadows, 0) - 1) < 1e-6, 'diameter = 2 * radius on the ground'));
  check(() => assert.ok(Math.abs(blobAlpha(shadows, 0) - 0.7) < 1e-6, 'full strength on the ground'));
  check(() => assert.equal(shadows.material.customProgramCacheKey(), 'contact-shadow-v1'));
  check(() => assert.ok(shadows.mesh.instanceColor, 'instanced colour exists before the first compile'));
  shadows.dispose();
}

// --- height fade: fainter and wider in the air, gone before the scan depth ------
{
  const shadows = new ContactShadows(makeWorld().getBlock);
  shadows.begin();
  shadows.add(1.5, 10, 1.5, 0.5, 0.7);
  shadows.add(1.5, 11.2, 1.5, 0.5, 0.7);
  check(() => assert.ok(blobAlpha(shadows, 1) < blobAlpha(shadows, 0), 'fades with height'));
  check(() => assert.ok(blobSize(shadows, 1) > blobSize(shadows, 0), 'widens with height'));
  check(() => assert.equal(shadows.add(1.5, 12.9, 1.5, 0.5, 0.7), false, 'an avatar blob is culled near 2.5 m'));
  check(() => assert.equal(shadows.add(1.5, 10 + CONTACT_SHADOW.reach + 0.2, 1.5, 0.5, 1), false, 'beyond reach'));
  check(() => assert.equal(shadows.add(1.5, 9.8, 1.5, 0.5, 1), true, 'feet sunk a little into the floor still count'));
  shadows.dispose();
}

// --- fluids, out of reach, distance and invalid input -----------------------------
{
  const shadows = new ContactShadows(makeWorld().getBlock);
  shadows.begin({ x: 0, y: 11, z: 0 });
  check(() => assert.equal(shadows.add(21.5, 10, 1.5, 0.5, 0.7), false, 'no blob on water'));
  check(() => assert.equal(shadows.add(1.5, 30, 1.5, 0.5, 0.7), false, 'nothing solid within reach'));
  check(() => assert.equal(shadows.add(CONTACT_SHADOW.maxDistance + 2, 10, 0.5, 0.5, 0.7), false, 'beyond draw distance'));
  check(() => assert.equal(shadows.add(Number.NaN, 10, 0.5, 0.5, 0.7), false));
  check(() => assert.equal(shadows.add(1.5, 10, 1.5, 0, 0.7), false, 'zero radius'));
  check(() => assert.equal(shadows.count, 0));
  shadows.strength = 0;
  check(() => assert.equal(shadows.add(1.5, 10, 1.5, 0.5, 0.7), false, 'global strength 0 hides blobs'));
  shadows.dispose();
}

// --- pool cap -----------------------------------------------------------------
{
  const shadows = new ContactShadows(makeWorld().getBlock);
  shadows.begin();
  let added = 0;
  for (let i = 0; i < CONTACT_SHADOW.capacity + 8; i++) if (shadows.add(0.5 + (i % 16), 10, 0.5 + Math.floor(i / 16), 0.4, 0.5)) added++;
  shadows.end();
  check(() => assert.equal(added, CONTACT_SHADOW.capacity));
  check(() => assert.equal(shadows.mesh.count, CONTACT_SHADOW.capacity));
  shadows.begin();
  shadows.end();
  check(() => assert.equal(shadows.mesh.count, 0, 'an empty frame draws nothing'));
  check(() => assert.equal(shadows.mesh.visible, true, 'but the mesh stays in the scene for warm-up'));
  shadows.dispose();
}

// --- the per-slot ground cache only refreshes on invalidate() ----------------------
{
  const world = makeWorld();
  const shadows = new ContactShadows(world.getBlock);
  const frame = () => { shadows.begin(); shadows.add(1.5, 10, 1.5, 0.5, 0.7); shadows.end(); return blobY(shadows, 0); };
  check(() => assert.ok(Math.abs(frame() - 10.018) < 1e-4));
  world.setBlock(1, 9, 1, AIR);
  check(() => assert.ok(Math.abs(frame() - 10.018) < 1e-4, 'stale until the terrain is invalidated'));
  shadows.invalidate();
  check(() => assert.ok(Math.abs(frame() - 9.018) < 1e-4, 'new floor after invalidate()'));
  shadows.dispose();
}

// --- WorldView.rebuildDeltas invalidates the blob cache -----------------------------
{
  const shadows = new ContactShadows(makeWorld().getBlock);
  const noop = () => {};
  const view = {
    chunkStore: { applyBlockDelta: noop },
    grassTufts: { applyBlockDelta: noop },
    lightVolume: { applyDeltas: noop, touchEmitters: noop },
    mapSigns: { refresh: noop },
    mapLights: { stats: { visible: 0 }, refresh: noop, emitters: () => [] },
    contactShadows: shadows,
  };
  const before = shadows.generation;
  WorldView.prototype.rebuildDeltas.call(view, []);
  check(() => assert.equal(shadows.generation, before, 'no deltas, cache kept'));
  WorldView.prototype.rebuildDeltas.call(view, [{ x: 1, y: 9, z: 1, v: AIR }]);
  check(() => assert.equal(shadows.generation, before + 1, 'terrain deltas invalidate the blobs'));
  shadows.dispose();
}

// --- character light: one program key, near switch per draw ----------------------
{
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  scene.add(camera);
  const shared = new THREE.MeshStandardMaterial({ color: 0x444444 });
  check(() => assert.equal(patchCharacterMaterial(shared), true));
  check(() => assert.equal(patchCharacterMaterial(shared), false, 'patched once'));
  check(() => assert.equal(shared.customProgramCacheKey(), 'character-lit-v1'));
  const lambert = new THREE.MeshLambertMaterial();
  patchCharacterMaterial(lambert);
  check(() => assert.equal(lambert.customProgramCacheKey(), shared.customProgramCacheKey(), 'one constant key'));

  // The shader patch replaces every hook it relies on.
  for (const [material, lib] of [[shared, THREE.ShaderLib.standard], [lambert, THREE.ShaderLib.lambert]]) {
    const shader = { uniforms: {}, vertexShader: lib.vertexShader, fragmentShader: lib.fragmentShader };
    material.onBeforeCompile(shader);
    check(() => assert.ok(shader.fragmentShader.includes('characterLightAt( vVoxelWorld')));
    check(() => assert.ok(shader.fragmentShader.includes('charProbeMix.x * charProbeMix.y')));
    check(() => assert.ok(shader.fragmentShader.includes('charLight.z * ( 1.0 - charProbeMix.y )'), 'no rim on near draws'));
    check(() => assert.ok(shader.vertexShader.includes('vVoxelWorld = voxelWorld.xyz')));
    check(() => assert.equal(shader.uniforms.charProbeMix, characterLightUniforms.charProbeMix));
  }

  // Viewmodel under the camera, own body as a near root, and an enemy at knife
  // range, all drawn with the same shared gun material.
  const viewmodel = new THREE.Group();
  camera.add(viewmodel);
  const vmGun = new THREE.Mesh(new THREE.BoxGeometry(), shared);
  viewmodel.add(vmGun);
  const ownBody = new THREE.Group();
  const ownLeg = new THREE.Mesh(new THREE.BoxGeometry(), shared);
  ownBody.add(ownLeg);
  const enemy = new THREE.Group();
  enemy.position.set(0, 0, -1.1);
  const enemyGun = new THREE.Mesh(new THREE.BoxGeometry(), shared);
  enemy.add(enemyGun);
  scene.add(ownBody, enemy);
  const nearRoots = [ownBody];
  setCharacterNearRoots(nearRoots);
  check(() => assert.equal(isNearCharacterObject(vmGun, camera), true, 'viewmodel is near'));
  check(() => assert.equal(isNearCharacterObject(ownLeg, camera), true, 'own body is near'));
  check(() => assert.equal(isNearCharacterObject(enemyGun, camera), false, 'enemy at 1.1 m is not'));
  check(() => assert.equal(isNearCharacterObject(vmGun, new THREE.PerspectiveCamera()), false,
    'another camera (killcam) does not own the main viewmodel'));

  let unbinds = 0;
  const renderer = { state: { useProgram(program) { if (program === null) unbinds++; return true; } } };
  const mix = characterLightUniforms.charProbeMix.value;
  const draw = (object) => { object.material.onBeforeRender(renderer, scene, camera, object.geometry, object, null); return mix.y; };
  mix.y = 0;
  check(() => assert.equal(draw(enemyGun), 0));
  check(() => assert.equal(unbinds, 0, 'no flip, no forced upload'));
  check(() => assert.equal(draw(vmGun), 1));
  check(() => assert.equal(unbinds, 1, 'a flip drops the bound program so the value uploads'));
  check(() => assert.equal(draw(ownLeg), 1));
  check(() => assert.equal(unbinds, 1, 'consecutive near draws keep the program'));
  check(() => assert.equal(draw(enemyGun), 0));
  check(() => assert.equal(unbinds, 2));

  // A material with its own onBeforeRender keeps it and still gets the switch.
  let own = 0;
  const custom = new THREE.MeshStandardMaterial();
  custom.onBeforeRender = () => { own++; };
  patchCharacterMaterial(custom);
  const customMesh = new THREE.Mesh(new THREE.BoxGeometry(), custom);
  viewmodel.add(customMesh);
  check(() => assert.equal(draw(customMesh), 1));
  check(() => assert.equal(own, 1, 'existing hook still runs'));
  setCharacterNearRoots(null);
  check(() => assert.equal(isNearCharacterObject(ownLeg, camera), false, 'roots cleared'));
  mix.y = 0;
}

console.log(`character-light-test: ${checks} checks passed`);
