import assert from 'node:assert/strict';
import * as THREE from '../public/js/vendor/three.module.js';
import { renderDistanceProfile, AdaptiveChunkRange } from '../public/js/engine/render-distance.js';
import { installFarFog, configureSceneFarFog } from '../public/js/engine/fog-chunk.js';
import { ChunkStore } from '../public/js/engine/chunks.js';
import { FarTerrain } from '../public/js/engine/far-terrain.js';
import { AIR, GRASS, createMapState } from '../shared/worlddata.js';
import { buildMapBackdrop } from '../public/js/engine/map-backdrop.js';
import { mapAtmosphere, resolveWeather, FRONTIER_WEATHER } from '../public/js/engine/map-atmosphere.js';
import { frontierSurfaceY } from '../shared/world/frontier-terrain.js';
import { FRONTIER_PLAN } from '../shared/conquest-contract.js';
import { collectProgramVariants } from '../public/js/engine/shader-warmup.js';

const legacy = renderDistanceProfile('foundry', 'ultra');
assert.deepEqual([legacy.cameraFar, legacy.fadeStart, legacy.fadeEnd], [400, 290, 392]);
assert.equal(legacy.fogGroundDensity, null, 'legacy atmosphere remains palette-owned');
assert.equal(legacy.detail, null, 'legacy chunks remain fully resident');
for (const [tier, ceiling] of [['low',289],['medium',625],['high',841],['ultra',1089]]) {
  const profile = renderDistanceProfile('frontier', tier);
  assert.equal((profile.detail.maxRadius * 2 + 1) ** 2, ceiling);
  assert(profile.fadeEnd < profile.cameraFar);
  assert(profile.cameraFar > Math.hypot(1024, 1024), 'the far plane includes the whole map diagonal');
  const transmittance = Math.exp(-((profile.fogAirDensity * 600) ** 2));
  assert(transmittance > 0.69, 'six-hundred-metre airborne silhouettes remain legible');
}
const profile = renderDistanceProfile('frontier', 'medium');
assert.equal(renderDistanceProfile('frontier', 'invalid'), profile);

// Expensive draws back off; a user-selected 30 FPS cap is respected.
const slow = new AdaptiveChunkRange(profile.detail);
for (let i = 0; i < 600; i++) slow.update(0.04);
assert.equal(slow.radius, profile.detail.minRadius);
const capped = new AdaptiveChunkRange(profile.detail);
for (let i = 0; i < 600; i++) capped.update(1/30, { targetFps:30 });
assert.equal(capped.radius, profile.detail.maxRadius);
const loading = new AdaptiveChunkRange(profile.detail);
for (let i = 0; i < 1200; i++) loading.update(1/60, { pendingLoads:1 });
assert.equal(loading.radius, profile.detail.initialRadius, 'queued detail prevents promotion');
const fast = new AdaptiveChunkRange(profile.detail);
for (let i = 0; i < 1200; i++) fast.update(1/60);
assert.equal(fast.radius, profile.detail.maxRadius);
fast.update(30);
assert.equal(fast.radius, profile.detail.maxRadius, 'resume stall does not lower the range');

// Scene-scoped defines also bind materials added after map construction.
installFarFog();
assert.equal(installFarFog(), false);
assert.match(THREE.ShaderChunk.fog_fragment, /smoothstep\( VB_FAR_FADE_START, VB_FAR_FADE_END/);
const scene = new THREE.Scene();
let chained = 0;
const previous = () => { chained++; };
scene.onBeforeRender = previous;
const material = new THREE.MeshLambertMaterial();
const patch = () => {};
material.onBeforeCompile = patch;
scene.add(new THREE.Mesh(new THREE.BoxGeometry(), material));
const release = configureSceneFarFog(scene, profile);
assert.equal(material.defines.VB_FAR_FADE_START, '1250.0');
assert.equal(material.onBeforeCompile, patch, 'terrain and character shader patches are preserved');
const version = material.version;
const later = new THREE.MeshStandardMaterial();
scene.add(new THREE.Mesh(new THREE.BoxGeometry(), later));
scene.onBeforeRender(null, scene, null, null);
assert.equal(chained,1);
assert.equal(later.defines.VB_FAR_FADE_END, '1760.0');
assert.equal(material.version, version, 'unchanged profiles do not recompile shaders each frame');
release();
assert.equal(scene.onBeforeRender,previous);
assert.equal(material.defines,undefined,'shared materials shed Frontier defines before a legacy map reuses them');
assert.deepEqual(later.defines,{STANDARD:''},'the original PBR shader define is preserved');
const custom = new THREE.MeshLambertMaterial();
custom.defines = { EXISTING_PATCH:'', VB_FAR_FADE_START:'450.0', VB_FAR_FADE_END:'600.0' };
const customScene = new THREE.Scene();
customScene.add(new THREE.Mesh(new THREE.BoxGeometry(), custom));
configureSceneFarFog(customScene,profile)();
assert.deepEqual(custom.defines,{ EXISTING_PATCH:'', VB_FAR_FADE_START:'450.0', VB_FAR_FADE_END:'600.0' },'existing material defines are restored exactly');
const oldScene = new THREE.Scene();
const oldMaterial = new THREE.MeshLambertMaterial();
oldScene.add(new THREE.Mesh(new THREE.BoxGeometry(),oldMaterial));
configureSceneFarFog(oldScene,legacy)();
assert.equal(oldMaterial.defines,undefined, 'legacy materials retain their original program keys');
for (const object of [...scene.children,...oldScene.children,...customScene.children]) { object.geometry.dispose(); object.material.dispose(); }

// Late roots (vehicles, particles) are bound by sync() before warm-up, so the
// first live frame finds the very programs the warm-up compiled.
{
  const lateScene = new THREE.Scene();
  lateScene.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshLambertMaterial()));
  const releaseLate = configureSceneFarFog(lateScene, profile);
  const lateGroup = new THREE.Group();
  const lateMaterial = new THREE.MeshLambertMaterial();
  lateGroup.add(new THREE.Mesh(new THREE.BoxGeometry(), lateMaterial));
  lateScene.add(lateGroup);
  assert.equal(releaseLate.sync(), 1, 'sync binds the late root at once');
  assert.equal(lateMaterial.defines.VB_FAR_FADE_START, '1250.0');
  const warmed = collectProgramVariants(lateScene).variants;
  lateScene.onBeforeRender(null, lateScene, null, null);
  assert.deepEqual([...collectProgramVariants(lateScene).variants].sort(), [...warmed].sort(), 'no program key changes on the first frame');
  assert.equal(releaseLate.sync(), 0, 'a second sync changes nothing');
  releaseLate();
  assert.equal(configureSceneFarFog(new THREE.Scene(), legacy).sync(), 0, 'legacy maps keep the default fade');
  lateScene.traverse(object => { object.geometry?.dispose(); object.material?.dispose(); });
}

// A long match repeatedly creates and destroys fogged corpses/effects. Probe
// the hook's private tracking map so disposal proves immediate reclamation,
// rather than waiting for a nondeterministic garbage collection cycle.
const transientScene = new THREE.Scene();
const NativeMap = globalThis.Map;
const trackedMaps = [];
let releaseTransient;
try {
  globalThis.Map = class extends NativeMap {
    constructor(...args) { super(...args); trackedMaps.push(this); }
  };
  releaseTransient = configureSceneFarFog(transientScene,profile);
} finally {
  globalThis.Map = NativeMap;
}
assert.equal(trackedMaps.length,1);
const tracked = trackedMaps[0];
for (let i=0;i<100;i++) {
  const transientMaterial = new THREE.MeshLambertMaterial();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(),transientMaterial);
  transientScene.add(mesh);
  transientScene.onBeforeRender(null,transientScene,null,null);
  assert.equal(tracked.size,1);
  assert.equal(transientMaterial._listeners.dispose.length,1,'each material has one cleanup listener');
  transientScene.remove(mesh);
  transientMaterial.dispose();
  mesh.geometry.dispose();
  assert.equal(tracked.size,0,'disposed effects leave no retained fog material');
  assert.equal(transientMaterial.defines,undefined,'disposal restores the original shader defines');
  assert.equal(transientMaterial._listeners.dispose.length,0,'disposal removes the cleanup listener');
}
assert.equal(transientScene.children.length,0);
const shared = new THREE.MeshLambertMaterial();
const sharedMesh = new THREE.Mesh(new THREE.BoxGeometry(),shared);
transientScene.add(sharedMesh);
transientScene.onBeforeRender(null,transientScene,null,null);
assert.equal(tracked.size,1);
releaseTransient();
assert.equal(tracked.size,0,'scene teardown releases remaining live materials');
assert.equal(shared._listeners.dispose.length,0,'teardown removes remaining disposal listeners');
assert.equal(shared.defines,undefined,'live shared materials also regain legacy defines');
sharedMesh.geometry.dispose(); shared.dispose();

// Actual streamed detail grows beyond the old 169-chunk working set, then
// releases evicted geometry when frame pressure lowers its range.
const atlas = {texture:()=>null,faceTile:()=>0,tileRect:()=>({u0:0,u1:1,v0:0,v1:1})};
const dimensions = {sx:1024,sy:2,sz:1024};
const store = new ChunkStore(new THREE.Scene(),atlas,(_x,y,_z)=>y===0?GRASS:AIR,undefined,dimensions,{streamRange:profile.detail});
store.setViewPosition({x:512,z:512},{ensureNear:false});
assert.equal(store.initialChunks().length,441);
store.buildAll();
assert.equal(store.stats.chunks,441);
assert.equal(store.stats.maxChunks,625);
store.applyBlockDelta(512,0,512);
assert.equal(store.stats.queued,4);
assert.equal(store.update(Infinity),4,'explicit replay flush drains all recorded edits');
let disposals=0;
for (const mesh of store.group.children) mesh.geometry.addEventListener('dispose',()=>disposals++);
for (let i=0;i<600;i++) store.updateStreamingRange(0.04);
assert.equal(store.stats.detailRadius,128);
assert.equal(store.stats.chunks,289);
assert(disposals>0);
store.setViewPosition({x:16,z:16});
store.buildAll();
assert.equal(store.stats.chunks,100,'edge coverage remains clipped to map extents');
store.dispose();
assert.equal(store.stats.chunks,0);

// Coarse ground survives pending loads; detail holes and eviction stay aligned
// even when a 16m chunk covers four 8m ground cells.
const terrainScene = new THREE.Scene();
const raised = (x,y,z) => y===10 || (x>=4 && x<=10 && z>=4 && z<=10 && y===30) ? GRASS : AIR;
const terrain = new FarTerrain(terrainScene,raised,{sx:32,sy:48,sz:32},{step:8,groundHeight:11});
assert.equal(terrain.stats.tiles,16);
assert(terrain.positions.every((value,i)=>i%3!==1 || value===0 || Math.abs(value-10.96)<0.001), 'overhead voxels never lift the broad ground into ramps');
terrain.syncChunks({chunks:new Map([['0,0',{meshes:[]}]])});
assert.equal(terrain.stats.hidden,4);
assert.equal(terrain.stats.visible,12);
terrain.syncChunks({chunks:new Map()});
assert.equal(terrain.stats.visible,16);
assert.throws(()=>new FarTerrain(terrainScene,raised,{sx:32,sy:48,sz:32},{step:32}),/must divide/);
assert(terrain.geometry.boundingSphere.containsPoint(new THREE.Vector3(0,48,0)), 'culling bounds include future height mutations');
terrain.dispose();
assert.equal(terrainScene.children.length,0);

// --- The real Frontier v2 world: far terrain relief, horizon ring, weather ---------------------
const world = createMapState('frontier');
assert.deepEqual(world.dimensions, FRONTIER_PLAN.dimensions);
const { sx, sy, sz } = world.dimensions;
for (const tier of ['low', 'medium', 'high', 'ultra']) {
  const tierProfile = renderDistanceProfile('frontier', tier);
  assert(tierProfile.cameraFar > Math.hypot(sx, sz) + 2 * 260, `${tier}: the far plane reaches across the map and its horizon ring`);
}
const farScene = new THREE.Scene();
const far = new FarTerrain(farScene, world.getBlock, world.dimensions, { step: profile.terrainStep, groundHeight: world.meta.groundLevel });
assert.equal(far.stats.tiles, (sx / profile.terrainStep) * (sz / profile.terrainStep));
assert.equal(far.stats.draws, 1, 'the far terrain is one draw');
assert(far.stats.bytes < 3 * 1024 * 1024, `far terrain geometry ${far.stats.bytes} B stays below 3 MiB`);
let farMeshes = 0;
farScene.traverse(object => { if (object.isMesh) farMeshes++; });
assert.equal(farMeshes, 1);
const relief = far.heightStats();
assert(relief.variance > 20, `sampled relief has height variance (${relief.variance.toFixed(1)})`);
assert(relief.max <= FRONTIER_PLAN.heights.ridgeMax + 1.5, `no tower, spire or chimney lifts the far ground into a tent (max ${relief.max.toFixed(1)})`);
assert(relief.min >= FRONTIER_PLAN.heights.waterSurface - 1, 'the river surface is the lowest far ground');
// Tile corners follow the authored terrain (sites carve trenches and craters locally).
let matched = 0, corners = 0;
for (let tile = 0; tile < far.tiles; tile += 7) {
  const offset = tile * 9 * 3;
  const x = far.positions[offset], y = far.positions[offset + 1], z = far.positions[offset + 2];
  if (x >= sx || z >= sz || far.empty[tile]) continue;
  corners++;
  if (Math.abs(y + 0.04 - frontierSurfaceY(x, z)) <= 1.01) matched++;
}
assert(matched / corners > 0.9, `far ground matches frontierSurfaceY at ${(100 * matched / corners).toFixed(1)} % of corners`);
const tones = new Set();
for (let i = 0; i < far.colors.length; i += 27) tones.add(`${far.colors[i]},${far.colors[i + 1]},${far.colors[i + 2]}`);
assert(tones.size > 50, `painter colours and slope shade vary the far ground (${tones.size} tones)`);
far.dispose();

// Horizon mountain ring: one draw beyond every map edge, inside the far fade.
for (const weather of FRONTIER_WEATHER) {
  const backdrop = buildMapBackdrop(mapAtmosphere('frontier', { weather }), world.dimensions);
  assert(backdrop, `${weather}: Frontier has a horizon ring`);
  let draws = 0;
  backdrop.group.traverse(object => { if (object.isMesh || object.isPoints) draws++; });
  assert.equal(draws, 1);
  assert.equal(backdrop.stats.draws, 1);
  assert(backdrop.stats.vertices < 260000, `${weather}: ring geometry is bounded (${backdrop.stats.vertices})`);
  const mesh = backdrop.group.children.find(object => object.isMesh) || backdrop.group.children[0];
  mesh.geometry.computeBoundingBox();
  const box = mesh.geometry.boundingBox;
  assert(box.min.x < -100 && box.min.z < -100 && box.max.x > sx + 100 && box.max.z > sz + 100, `${weather}: the ring surrounds the map`);
  const reach = Math.hypot(Math.max(-box.min.x, box.max.x - sx), Math.max(-box.min.z, box.max.z - sz)) + Math.hypot(sx, sz) / 2;
  assert(reach < profile.cameraFar, `${weather}: the ring stays inside the camera far plane`);
  assert(box.max.y > sy, `${weather}: peaks rise above the map's highest voxel`);
  backdrop.dispose();
}

// Weather: authored in mapMeta, overridable for captures, uniforms only.
assert.equal(resolveWeather(world.meta), world.meta.conquest.weather || 'golden');
assert.equal(resolveWeather(world.meta, 'mist'), 'mist');
assert.equal(resolveWeather(world.meta, 'blizzard'), 'golden', 'unknown moods fall back to golden');
const moods = FRONTIER_WEATHER.map(weather => mapAtmosphere('frontier', { weather }));
assert.deepEqual(moods.map(m => m.weather), [...FRONTIER_WEATHER]);
for (const mood of moods) {
  // Optional fields (horizon glow, overcast deck) are sky uniforms with defaults, never defines.
  assert.deepEqual(Object.keys(mood.light).sort(), Object.keys(moods[0].light).sort(), `${mood.weather}: light uniforms only`);
  assert.equal(mood.backdrop.style, moods[0].backdrop.style, 'one backdrop program for every mood');
  assert(Number.isFinite(mood.fogScale) && mood.fogScale > 0, 'moods scale the profile ground fog');
  // From the air the far LOD stays as veiled as the profile sets it.
  assert((mood.airFogScale ?? mood.fogScale) >= 1, 'moods never thin the airborne fog below the profile');
}
assert(moods[0].fogScale < 1, 'golden thins the ground haze so landmarks read across the valley');
assert(moods[1].fogScale > moods[2].fogScale && moods[2].fogScale > moods[0].fogScale, 'mist is denser than overcast, overcast than golden');
console.log('Frontier render distance passed: full-map fade, map-scoped shader defines, FPS-aware adaptive detail, bounded geometry disposal, legacy profile, '
  + `real-terrain far LOD (variance ${relief.variance.toFixed(1)}, ${tones.size} tones, ${(far.stats.bytes / 1048576).toFixed(2)} MiB), horizon ring and weather moods.`);
