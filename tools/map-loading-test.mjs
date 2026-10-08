// Map loading: V3 map frames (template + patch, or a cached-template
// reference), the admission `mapCache` field and the server's per-client frame
// choice, the browser map cache, and the load-time fast paths that must give
// exactly the old results (light classification over raw voxels, the distant
// shell's layer window, raw-voxel far-terrain probes, killcam copies, spawn-ring
// meshing and the primed Frontier metadata).
import assert from 'node:assert/strict';
import * as THREE from '../public/js/vendor/three.module.js';
import { AIR, GRASS, METAL, RUST, SAND, STONE, MC_GLOWSTONE, createMapState, getMapMeta } from '../shared/worlddata.js';
import { deserializeWorld, worldBlocks, getBlock as singletonBlock } from '../shared/worlddata.js';
import {
  MAP_FRAME_HEADER_BYTES, applyMapPatch, decodeMapFrame, deserializeBlocks, encodeMapFrame, isMapFrame,
  mapFingerprint, parseMapFrame, serializeBlocks,
} from '../shared/world/serialize.js';
import { parseAdmissionFrame } from '../server/protocol/admission.js';
import { MAP_CACHE_BYTE_BUDGET, MapCache } from '../public/js/engine/map-cache.js';
import { KillcamTerrain } from '../public/js/player/killcam-terrain.js';
import { ChunkStore } from '../public/js/engine/chunks.js';
import { buildInitialMesh } from '../public/js/engine/initial-mesh.js';
import { DistantVoxelShell, rawVoxelReader } from '../public/js/engine/distant-voxel-shell.js';
import { FarTerrain } from '../public/js/engine/far-terrain.js';
import { classifyLightRows, classifyVoxelArray, voxelArrayContext } from '../public/js/engine/voxel-light-worker.js';
import { VoxelLightVolume, prewarmLightWorker } from '../public/js/engine/voxel-light.js';
import { createFrontierMetadata } from '../shared/world/frontier-layout.js';
import { primeFrontierMetadata } from '../shared/world/metadata.js';
import { startServer, stopServer } from './lib/server-process.mjs';
import { Client } from './lib/ws-client.mjs';

// --- V3 codec -------------------------------------------------------------------
{
  const dims = { sx: 300, sy: 20, sz: 260 };
  const pristine = new Uint8Array(dims.sx * dims.sy * dims.sz);
  pristine.fill(STONE, 0, dims.sx * dims.sz * 6);
  const template = serializeBlocks(pristine, dims);
  const fingerprint = mapFingerprint(template);
  assert.match(fingerprint, /^[0-9a-f]{16}$/);
  assert.notEqual(mapFingerprint(template.slice(0, -1)), fingerprint, 'fingerprint covers every byte');
  const patch = [[5, AIR], [dims.sx * dims.sz * 7 + 3, GRASS]];
  const full = encodeMapFrame({ template, fingerprint, patch });
  const reference = encodeMapFrame({ template, fingerprint, patch, includeTemplate: false });
  assert(isMapFrame(full) && isMapFrame(reference) && !isMapFrame(template));
  assert.equal(reference.length, MAP_FRAME_HEADER_BYTES + patch.length * 5, 'a reference carries no template');
  const parsed = parseMapFrame(full);
  assert.equal(parsed.fingerprint, fingerprint);
  assert.deepEqual(parsed.template, template);
  const expected = pristine.slice(); expected[5] = AIR; expected[dims.sx * dims.sz * 7 + 3] = GRASS;
  assert.deepEqual(decodeMapFrame(full).blocks, expected);
  assert.deepEqual(decodeMapFrame(reference, { resolveTemplate: fp => (fp === fingerprint ? template : null) }).blocks, expected);
  assert.throws(() => decodeMapFrame(reference), /template unavailable/);
  assert.deepEqual(decodeMapFrame(template).blocks, pristine, 'legacy frames still decode');
  for (const mutate of [
    b => { b[3] = 7; }, b => { new DataView(b.buffer).setUint32(16, 99, true); },
    b => { new DataView(b.buffer).setUint32(12, 0, true); },
  ]) {
    const bad = full.slice(); mutate(bad);
    assert.throws(() => decodeMapFrame(bad));
  }
  // The server's path: the patch written straight from a Set of cells.
  const live = expected.slice();
  assert.deepEqual(encodeMapFrame({ template, fingerprint, cells: new Set(patch.map(([i]) => i)), blocks: live }), full);
  assert.deepEqual(encodeMapFrame({ template, fingerprint, cells: new Set(patch.map(([i]) => i)), blocks: live, includeTemplate: false }), reference);
  assert.throws(() => encodeMapFrame({ template, fingerprint, cells: new Set([1]) }), /invalid map frame/);
  const badPatch = encodeMapFrame({ template, fingerprint, patch: [[pristine.length, 1]] });
  assert.throws(() => decodeMapFrame(badPatch), /invalid map patch/);
  assert.throws(() => applyMapPatch(new Uint8Array(4), new Uint8Array(3)));
}

// --- World state frames: patch = every cell that differs from the template -------
{
  const world = createMapState('foundry');
  const legacy = () => deserializeBlocks(world.serializeWorld()).blocks;
  const template = world.serializeWorld();
  assert.equal(world.templateFingerprint, mapFingerprint(template));
  assert.equal(world.mapFrame({ cached: true }).length, MAP_FRAME_HEADER_BYTES, 'pristine reference is the header only');
  assert.equal(world.mapFrame(), world.mapFrame(), 'frames are cached per mutation');
  const before = world.getBlock(40, 12, 40);
  world.setBlock(40, 12, 40, AIR);
  world.setBlock(41, 30, 40, METAL);
  world.setBlock(42, 12, 40, world.getBlock(42, 12, 40)); // no-op
  const ref = world.mapFrame({ cached: true });
  assert.equal(parseMapFrame(ref).patchCount, before === AIR ? 1 : 2);
  const resolve = fp => (fp === world.templateFingerprint ? template : null);
  assert.deepEqual(decodeMapFrame(ref, { resolveTemplate: resolve }).blocks, legacy(), 'reference + patch = live world');
  assert.deepEqual(decodeMapFrame(world.mapFrame()).blocks, legacy(), 'template + patch = live world');
  // Restoring a cell drops it from the patch.
  world.setBlock(41, 30, 40, AIR);
  world.setBlock(40, 12, 40, before);
  assert.equal(parseMapFrame(world.mapFrame({ cached: true })).patchCount, 0);
  assert.deepEqual(decodeMapFrame(world.mapFrame({ cached: true }), { resolveTemplate: resolve }).blocks, legacy());
}

// --- Admission: optional mapCache (opts in to V3), strictly validated ---------------
{
  const fp = 'a'.repeat(16);
  assert.deepEqual(parseAdmissionFrame({ t: 'join', name: 'A', bots: 3, mapCache: [fp, fp] }).mapCache, [fp]);
  assert.deepEqual(parseAdmissionFrame({ t: 'join', name: 'A', lobby: 'ABCDE', mapCache: [] }).mapCache, []);
  assert.deepEqual(parseAdmissionFrame({ t: 'create', name: 'A', bots: 0, gameMode: 'tdm', map: 'foundry', mapCache: [fp] }).mapCache, [fp]);
  assert.equal('mapCache' in parseAdmissionFrame({ t: 'join', name: 'A', bots: 3 }), false, 'legacy clients keep the old shape');
  for (const bad of [['A'.repeat(16)], ['abc'], [1], 'x', Array(9).fill(fp)]) {
    assert.equal(parseAdmissionFrame({ t: 'join', name: 'A', bots: 3, mapCache: bad }), null, JSON.stringify(bad));
  }
}

// --- Client singleton: V3 decode through the cache resolver; killcam copy ---------
{
  const world = createMapState('depot');
  world.setBlock(20, 14, 20, MC_GLOWSTONE);
  const template = createMapState('depot').serializeWorld();
  const fingerprint = deserializeWorld(world.mapFrame({ cached: true }), { resolveTemplate: () => template });
  assert.equal(fingerprint, world.templateFingerprint);
  assert.equal(singletonBlock(20, 14, 20), MC_GLOWSTONE);
  const { blocks, dimensions } = worldBlocks();
  const killcam = new KillcamTerrain({ blocks, dimensions });
  assert.notEqual(killcam.blocks, blocks, 'the killcam keeps its own copy');
  assert.deepEqual(killcam.blocks, blocks);
  assert.equal(deserializeWorld(world.serializeWorld()), null, 'legacy frames carry no fingerprint');
}

// --- Browser map cache (Cache Storage stand-in) ---------------------------------
{
  const store = new Map();
  const storage = { async open() { return {
    async keys() { return [...store.keys()].map(url => ({ url: `https://game.test${url}` })); },
    async match(request) { const bytes = store.get(new URL(request.url).pathname); return bytes ? new Response(bytes) : undefined; },
    async put(key, response) { store.set(key, new Uint8Array(await response.arrayBuffer())); },
    async delete(key) { return store.delete(typeof key === 'string' ? key : new URL(key.url).pathname); },
  }; } };
  const world = createMapState('foundry');
  const cache = new MapCache({ storage, limit: 2 });
  await cache.load();
  assert.deepEqual(cache.fingerprints(), []);
  assert.equal(cache.remember(world.mapFrame({ cached: true })), null, 'references carry nothing to keep');
  assert.equal(cache.remember(world.mapFrame()), world.templateFingerprint);
  assert.deepEqual(cache.get(world.templateFingerprint), world.serializeWorld());
  const forged = world.mapFrame().slice(); forged[MAP_FRAME_HEADER_BYTES + 20] ^= 1;
  assert.equal(cache.remember(forged), null, 'a template that does not match its fingerprint is rejected');
  for (const id of ['depot', 'citadel']) cache.remember(createMapState(id).mapFrame());
  await cache._writes;
  assert.equal(store.size, 2, 'persisted entries are capped');
  const reloaded = new MapCache({ storage });
  await reloaded.load();
  assert.deepEqual(reloaded.fingerprints(), [createMapState('citadel').templateFingerprint, createMapState('depot').templateFingerprint]);
  // A damaged persisted entry is dropped instead of announced.
  const [first] = store.keys(); store.get(first)[30] ^= 1;
  const damaged = new MapCache({ storage });
  await damaged.load();
  assert.equal(damaged.fingerprints().length, 1);
  assert.equal(damaged.stats.dropped, 1);
  // Byte budget: a new large template (a changed Frontier generator) pushes
  // the stale one out of memory and storage instead of piling up.
  store.clear();
  const big = (seed) => {
    const dims = { sx: 160, sy: 64, sz: 160 }; // V1: 1.6 MB raw
    const blocks = new Uint8Array(dims.sx * dims.sy * dims.sz);
    for (let i = 0; i < blocks.length; i += 97) blocks[i] = (i + seed) % 7 ? STONE : GRASS;
    const template = serializeBlocks(blocks, dims);
    return { fingerprint: mapFingerprint(template), frame: encodeMapFrame({ template, fingerprint: mapFingerprint(template) }) };
  };
  const small = createMapState('depot');
  const oldGen = big(1), newGen = big(2);
  const templateBytes = (frame) => parseMapFrame(frame).template.length;
  // Room for the small map plus one large template, not two large ones.
  const byteBudget = templateBytes(small.mapFrame()) + templateBytes(oldGen.frame) + 1024;
  assert(byteBudget < 2 * templateBytes(oldGen.frame));
  const budgeted = new MapCache({ storage, byteBudget });
  await budgeted.load();
  budgeted.remember(small.mapFrame());
  budgeted.remember(oldGen.frame);
  assert.deepEqual(budgeted.fingerprints(), [oldGen.fingerprint, small.templateFingerprint]);
  budgeted.remember(newGen.frame);
  await budgeted._writes;
  assert.deepEqual(budgeted.fingerprints(), [newGen.fingerprint], 'the new large template evicts everything older past the budget');
  assert.equal(budgeted.stats.evicted, 2);
  assert.deepEqual([...store.keys()].map(k => k.split('/').pop()), [newGen.fingerprint], 'evicted entries leave storage too');
  // A page load deletes persisted entries past the budget without hashing them.
  await (await storage.open()).put(`/__vb-map-template/${oldGen.fingerprint}`, new Response(parseMapFrame(oldGen.frame).template));
  const relaunched = new MapCache({ storage, byteBudget });
  await relaunched.load();
  assert.deepEqual(relaunched.fingerprints(), [oldGen.fingerprint], 'the newest persisted entry wins');
  assert.equal(relaunched.stats.loaded, 1);
  assert.equal(relaunched.stats.evicted, 1);
  assert.equal(store.size, 1);
  assert(MAP_CACHE_BYTE_BUDGET >= 2.5 * 1024 * 1024, 'the default budget holds one Frontier template plus arenas');
  const none = new MapCache({ storage: null });
  await none.load();
  assert.equal(none.remember(world.mapFrame()), world.templateFingerprint, 'without storage the page session still caches');
}

// --- Server: legacy, template and reference frames per client --------------------
{
  const server = startServer({ failureContext: 'map loading test' });
  const clients = [];
  try {
    const port = await server.port;
    const join = async (label, frame) => {
      const client = new Client(port, label, { handshakeTimeout: 30000, frameTimeout: 30000 });
      clients.push(client);
      await client.connect(frame);
      const welcome = await client.waitForJson(m => m.t === 'welcome', `${label} welcome`);
      const binary = await client.waitForFrame(f => f.kind === 'binary', `${label} map`);
      const bytes = new Uint8Array(binary.value);
      assert.equal(bytes.length, welcome.mapBytes, `${label}: welcome announces the frame it pairs with`);
      return { client, welcome, bytes };
    };
    const host = await join('host', { t: 'create', name: 'Host', bots: 0, gameMode: 'tdm', map: 'foundry', mapCache: [] });
    assert(isMapFrame(host.bytes) && parseMapFrame(host.bytes).template, 'a cache-capable client without the map gets the template');
    const template = parseMapFrame(host.bytes).template;
    const code = host.welcome.lobby.code;
    const legacy = await join('legacy', { t: 'join', name: 'Legacy', lobby: code });
    assert(!isMapFrame(legacy.bytes) && legacy.bytes[0] === 86, 'clients without mapCache keep the legacy frame');
    const cached = await join('cached', { t: 'join', name: 'Cached', lobby: code, mapCache: [parseMapFrame(host.bytes).fingerprint] });
    assert.equal(cached.bytes.length, MAP_FRAME_HEADER_BYTES, 'a client holding the template gets a reference');
    assert.deepEqual(decodeMapFrame(cached.bytes, { resolveTemplate: () => template }).blocks, deserializeBlocks(legacy.bytes).blocks);
    // A lobby map change: a frame per member, chosen by what each one holds.
    const mark = host.client.sequence;
    host.client.send({ t: 'configure', gameMode: 'tdm', map: 'depot', bots: 0 });
    const config = await host.client.waitForJsonFrame(m => m.t === 'lobbyConfig', 'configure', mark, 30000);
    const frame = new Uint8Array((await host.client.waitForFrame(f => f.kind === 'binary', 'depot', config.seq, 30000)).value);
    assert.equal(frame.length, config.value.mapBytes);
    assert(parseMapFrame(frame).template, 'a new map ships its template once');
    assert.deepEqual(decodeMapFrame(frame).blocks, deserializeBlocks(createMapState('depot').serializeWorld()).blocks);
  } finally {
    for (const client of clients) await client.close().catch(() => {});
    await stopServer(server);
  }
}

// --- Light classification: raw-voxel kernel == getter kernel ----------------------
{
  const dims = { sx: 70, sy: 30, sz: 50 }, blocks = new Uint8Array(dims.sx * dims.sy * dims.sz);
  let seed = 3; const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296;
  const ids = [AIR, AIR, AIR, STONE, GRASS, 6, 11, 85, MC_GLOWSTONE];
  for (let i = 0; i < blocks.length; i++) blocks[i] = ids[Math.floor(rnd() * ids.length)];
  for (const cell of [1, 2, 3, 4]) {
    const W = Math.ceil(dims.sx / cell), H = Math.ceil(dims.sy / cell), D = Math.ceil(dims.sz / cell);
    const a = new Uint8Array(W * H * D), b = new Uint8Array(W * H * D), ea = new Map(), eb = new Map();
    const getBlock = (x, y, z) => blocks[(y * dims.sz + z) * dims.sx + x];
    classifyLightRows({ cell, W, H, dims, getBlock }, a, ea, 0, D);
    classifyVoxelArray(voxelArrayContext(blocks, dims, { W, H, cell }), b, eb, 0, D);
    assert.deepEqual(b, a, `cell ${cell} classes`);
    assert.deepEqual([...eb].sort(), [...ea].sort(), `cell ${cell} emitters`);
  }
}

// --- Distant shell and far terrain: raw-voxel scans and the layer window -----------
{
  const dims = { sx: 64, sy: 40, sz: 48 }, blocks = new Uint8Array(dims.sx * dims.sy * dims.sz);
  const at = (x, y, z) => (y * dims.sz + z) * dims.sx + x;
  const fill = (x0, y0, z0, x1, y1, z1, id) => {
    for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) blocks[at(x, y, z)] = id;
  };
  fill(0, 0, 0, 63, 10, 47, GRASS); fill(4, 33, 4, 27, 35, 11, RUST); fill(4, 11, 4, 5, 32, 5, METAL);
  fill(40, 11, 30, 50, 20, 40, SAND); fill(20, 11, 20, 20, 11, 20, METAL);
  const getBlock = (x, y, z) => blocks[at(x, y, z)];
  const read = rawVoxelReader(() => ({ blocks, dimensions: dims }), dims);
  assert.equal(read(4, 34, 4), RUST);
  assert.equal(rawVoxelReader(() => ({ blocks: blocks.subarray(1), dimensions: dims }), dims), null);
  const viaGetter = new DistantVoxelShell(new THREE.Scene(), getBlock, dims, { groundHeight: 10 });
  const viaRaw = new DistantVoxelShell(new THREE.Scene(), getBlock, dims, { groundHeight: 10, voxels: () => ({ blocks, dimensions: dims }) });
  // Reference: the full-height sweep (an occupied-layer window of [0, height)).
  const full = new DistantVoxelShell(new THREE.Scene(), getBlock, dims, { groundHeight: 10 });
  full.occupiedLayers = function occupiedLayers(x0, z0, width, depth) {
    for (let y = 0; y < this.height; y++) for (let z = z0; z < z0 + depth; z++) for (let x = x0; x < x0 + width; x++) {
      const id = this.cells[x + z * this.width + y * this.plane]; if (id) return [0, this.height - 1];
    }
    return [0, -1];
  };
  for (const record of full.records.values()) full.buildChunk(record);
  for (const [key, record] of full.records) {
    assert.deepEqual(viaGetter.records.get(key).positions, record.positions, `${key} quads`);
    assert.deepEqual(viaRaw.records.get(key).positions, record.positions, `${key} raw quads`);
    assert.deepEqual(viaGetter.records.get(key).colors, record.colors);
  }
  assert.equal(viaRaw.getBlock, getBlock, 'deltas read through getBlock after the load scan');
  const far = new FarTerrain(new THREE.Scene(), getBlock, dims, { step: 8, silhouetteStep: 2, groundHeight: 10 });
  const farRaw = new FarTerrain(new THREE.Scene(), getBlock, dims, { step: 8, silhouetteStep: 2, groundHeight: 10,
    voxels: () => ({ blocks, dimensions: dims }) });
  assert.deepEqual(farRaw.positions, far.positions);
  assert.deepEqual(farRaw.colors, far.colors);
  assert.equal(farRaw.getBlock, getBlock);
}

// --- Spawn-ring meshing leaves the rest of the working set queued -----------------
{
  const atlas = { texture: () => null, faceTile: () => 0, tileRect: () => ({ u0: 0, u1: 1, v0: 0, v1: 1 }) };
  const dims = { sx: 1024, sy: 4, sz: 1024 };
  const store = new ChunkStore(new THREE.Scene(), atlas, (_x, y) => (y === 0 ? GRASS : AIR), undefined, dims,
    { streamRange: { minRadius: 8, initialRadius: 10, maxRadius: 12 } });
  store.setViewPosition({ x: 100, z: 512 }, { ensureNear: false });
  const wanted = store.initialChunks().length;
  assert.equal(store.initialChunks({ radius: 4 }).length, 81);
  await buildInitialMesh(store, { radius: 4, yieldControl: async () => {} });
  assert.equal(store.stats.chunks, 81);
  assert.equal(store.stats.pendingLoads, wanted - 81, 'the rest streams in through update()');
  const first = store.loadQueue[0], view = store.viewChunk;
  assert.equal(Math.max(Math.abs(first.x - view.cx), Math.abs(first.z - view.cz)), 5, 'nearest queued chunks come first');
  while (store.update()) { /* drain */ }
  assert.equal(store.stats.chunks, wanted);
}

// --- Light bake: a prewarmed worker that failed to load never hangs the bake -------
{
  const dims = { sx: 32, sy: 16, sz: 32 };
  const ground = (_x, y) => (y < 4 ? STONE : AIR);
  const reference = new VoxelLightVolume(ground, dims, { cell: 2, worker: false });
  reference.build();
  const created = [];
  // Every worker fails: the first while it sits prewarmed (no bake listening
  // yet), later ones when posted to.
  globalThis.Worker = class DeadWorker {
    constructor() {
      this.terminated = false;
      created.push(this);
      if (created.length === 1) setTimeout(() => this.onerror?.({ message: 'script failed to load', preventDefault() {} }), 0);
    }
    postMessage() {
      if (this === created[0]) return; // the dead prewarmed worker never answers
      setTimeout(() => this.onerror?.({ message: 'bake failed', preventDefault() {} }), 0);
    }
    terminate() { this.terminated = true; }
  };
  const warn = console.warn; console.warn = () => {};
  try {
    assert.equal(prewarmLightWorker(), true);
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(created[0].terminated, true, 'the failed prewarmed worker is dropped');
    let yields = 0;
    const volume = new VoxelLightVolume(ground, dims, { cell: 2 });
    const bake = volume.buildAsync({ yieldControl: async () => { yields++; }, sliceMs: 0 });
    const outcome = await Promise.race([bake.then(() => 'baked'), new Promise(resolve => setTimeout(() => resolve('hung'), 5000))]);
    assert.equal(outcome, 'baked', 'the bake settles instead of waiting on the dead worker');
    assert.notEqual(created.at(-1), created[0], 'the bake started a fresh worker');
    assert(volume.built, 'the main-thread fallback finished the bake');
    assert(yields > 0, 'the fallback classification yields between slices');
    assert.deepEqual(volume.data, reference.data, 'the fallback bake equals the main-thread bake');
    volume.dispose();
  } finally {
    console.warn = warn;
    delete globalThis.Worker;
  }
  reference.dispose();
}

// --- Terrain warm-up meshes: every terrain program, nothing drawn ------------------
{
  const atlas = { texture: () => null, faceTile: () => 0, tileRect: () => ({ u0: 0, u1: 1, v0: 0, v1: 1 }) };
  const store = new ChunkStore(new THREE.Scene(), atlas, (_x, y) => (y === 0 ? GRASS : AIR), undefined, { sx: 64, sy: 4, sz: 64 });
  const group = store.warmupGroup();
  assert.deepEqual(group.children.map(m => m.material), Object.values(store.materials), 'one mesh per terrain material');
  for (const mesh of group.children) {
    const p = mesh.geometry.attributes.position;
    const a = new THREE.Vector3().fromBufferAttribute(p, 0);
    assert(a.equals(new THREE.Vector3().fromBufferAttribute(p, 1)) && a.equals(new THREE.Vector3().fromBufferAttribute(p, 2)), 'zero-area triangle');
  }
  const cutout = group.children.find(m => m.name === 'terrain-warmup-cutout');
  assert(cutout.geometry.attributes.terrainLayer && cutout.geometry.attributes.terrainAux, 'chunk mesh attributes');
  store.dispose();
}

// --- Frontier metadata computed elsewhere primes the shared memo ------------------
{
  const primed = primeFrontierMetadata(structuredClone(createFrontierMetadata()));
  const meta = getMapMeta('frontier');
  assert.equal(meta, primed, 'getMapMeta returns the primed metadata');
  assert(Object.isFrozen(meta.conquest.flags));
  assert.deepEqual(JSON.parse(JSON.stringify(meta)), JSON.parse(JSON.stringify({ ...createFrontierMetadata(), modes: meta.modes })));
  assert.equal(primeFrontierMetadata({ id: 'frontier', other: true }), meta, 'priming never replaces existing metadata');
}

console.log('map loading test passed');
