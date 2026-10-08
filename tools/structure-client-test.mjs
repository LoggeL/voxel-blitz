// Client presentation of structural collapses (public/js/fx/structure-fx.js,
// docs/structural-physics.md "Client"): event -> proxy/chunk bookkeeping on a
// real ChunkStore, visibility in sync with the block deltas and the terrain
// rebuilds (every block drawn exactly once at every step), disposal, graphics
// tier caps, killcam replay, kill feed, Bastion refusal, wiring and the
// server's template warm-up.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import * as THREE from '../public/js/vendor/three.module.js';
import { ChunkStore } from '../public/js/engine/chunks.js';
import { StructureFx, STRUCTURE_FX, STRUCTURE_FX_TIERS, dominantMaterial } from '../public/js/fx/structure-fx.js';
import { FX_KINDS, FX_PRESETS } from '../public/js/fx/presets.js';
import {
  collapseMatrix, collapsePoint, structureEventCells, STRUCTURE_EVENT_KINDS, STRUCTURE_RULES, COLLAPSE_WEAPON,
} from '../shared/structure.js';
import { AIR, STONE, PLANK, CONCRETE, BRICK, GLASS } from '../shared/world/blocks.js';
import { KillcamHistory } from '../public/js/player/killcam-history.js';
import { WEAPON_NAMES, isVehicleKillKey } from '../public/js/ui/hud-support.js';
import { KILL_KEY_ICONS, ICON_PATHS } from '../public/js/ui/conquest/icons.js';
import { STRUCTURE_SAMPLE_MANIFEST, CONQUEST_SAMPLE_MANIFEST } from '../public/js/audio/conquest-bank.js';
import { NetClient } from '../public/js/engine/netclient.js';
import { createMapState } from '../shared/worlddata.js';
import { SupportField } from '../server/sim/structure-field.js';
import { warmStructureTemplates } from '../server/sim/structure.js';
import { GameEngine, afterRoomTick } from '../server/game.js';

let checks = 0;
const check = (fn, label) => { try { fn(); checks++; } catch (error) { error.message = `${label}: ${error.message}`; throw error; } };

// ------------------------------------------------------------------ helpers
const dims = { sx: 48, sy: 24, sz: 48 };
const SX = dims.sx, SZ = dims.sz;
const idx = (x, y, z) => x + SX * (z + SZ * y);
const atlas = { texture: () => null, faceTile: (id, face) => id * 6 + face, tileRect: () => ({ u0: 0, u1: 1, v0: 1, v1: 0 }) };

function makeWorld() {
  const blocks = new Uint8Array(dims.sx * dims.sy * dims.sz);
  const getBlock = (x, y, z) => (x < 0 || y < 0 || z < 0 || x >= dims.sx || y >= dims.sy || z >= dims.sz ? AIR : blocks[idx(x, y, z)]);
  for (let z = 0; z < dims.sz; z++) for (let x = 0; x < dims.sx; x++) { blocks[idx(x, 0, z)] = STONE; blocks[idx(x, 1, z)] = STONE; }
  const scene = new THREE.Scene();
  const store = new ChunkStore(scene, atlas, getBlock, () => 0, dims);
  for (let cz = 0; cz < 3; cz++) for (let cx = 0; cx < 3; cx++) store.rebuildChunk(cx, cz);
  const set = (x, y, z, v) => { blocks[idx(x, y, z)] = v; };
  /** Apply wire deltas like applySnapshotBlocks: store first, then the mesher marks. */
  const apply = (deltas) => {
    for (const { i, v } of deltas) {
      const x = i % SX, z = Math.floor(i / SX) % SZ, y = Math.floor(i / (SX * SZ));
      blocks[i] = v; store.applyBlockDelta(x, y, z);
    }
  };
  return { blocks, getBlock, scene, store, set, apply };
}

function fakes() {
  const fx = { emits: {}, emit(kind, pos, params) { assert(FX_PRESETS[kind], `preset ${kind}`); this.emits[kind] = (this.emits[kind] || 0) + (params?.count ?? 1); return params?.count ?? 1; } };
  const chips = { count: 0, spawnParticles(x, y, z, count) { assert([x, y, z].every(Number.isFinite)); this.count += count; } };
  const audio = { calls: [], structureCreak(pos, o) { this.calls.push(['creak', pos, o]); }, structureImpact(pos, o) { this.calls.push(['impact', pos, o]); },
    structureCrumble(pos, o) { this.calls.push(['crumble', pos, o]); } };
  const shake = { total: 0, add(v) { assert(v >= 0 && v <= 1); this.total += v; } };
  const camera = { position: new THREE.Vector3(10, 4, 10) };
  return { fx, chips, audio, shake, camera };
}

function makeFx(world, f, options = {}) {
  return new StructureFx({ parent: world.scene, mesher: world.store, getBlock: world.getBlock, dimensions: dims,
    fx: f.fx, chips: f.chips, audio: f.audio, cameraShake: f.shake, getCamera: () => f.camera, tier: 'high',
    meshBudgetMs: Infinity, ...options });
}

/** Encode cells like the server: origin = min corner, b = [dx, dy, dz, type]. */
function encode(cells) {
  let mx = Infinity, my = Infinity, mz = Infinity;
  for (const c of cells) { mx = Math.min(mx, c.x); my = Math.min(my, c.y); mz = Math.min(mz, c.z); }
  const b = [];
  for (const c of cells) b.push(c.x - mx, c.y - my, c.z - mz, c.t);
  return { o: [mx, my, mz], b, n: cells.length };
}
function box(x0, x1, y0, y1, z0, z1, t) {
  const out = [];
  for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) out.push({ x, y, z, t });
  return out;
}
const creakEvent = (id, at, cells) => ({ t: 'ev', kind: 'creak', id, at, fall: STRUCTURE_RULES.creakMs, ...encode(cells) });
function collapseEvent(id, k, at, cells, { drop = 6, v = [0, 0, 0], w = [0.3, 0, -0.2] } = {}) {
  const e = encode(cells);
  let px = 0, py = 0, pz = 0;
  for (const c of cells) { px += c.x + 0.5; py += c.y + 0.5; pz += c.z + 0.5; }
  const land = Math.sqrt(2 * drop / STRUCTURE_RULES.gravity) * 1000;
  return { t: 'ev', kind: 'collapse', id, k, at, ...e, p: [px / cells.length, py / cells.length, pz / cells.length], v, w,
    g: STRUCTURE_RULES.gravity, land };
}
const removal = (cells) => cells.map(c => ({ i: idx(c.x, c.y, c.z), v: 0 }));

function visibleMeshes(root) {
  const out = [];
  root.updateMatrixWorld(true);
  root.traverse((node) => {
    if (!node.isMesh) return;
    for (let n = node; n; n = n.parent) if (!n.visible) return;
    out.push(node);
  });
  return out;
}

/**
 * Quads drawn on the top face (y = y0 + 1) of each cell, by source. Every
 * top-exposed cell of a structure must be drawn exactly once at every step.
 */
function topCoverage(world, cells) {
  const want = new Map(cells.map(c => [`${c.x},${c.z}`, c.y + 1]));
  const terrain = new Map(), proxies = new Map();
  const v = new THREE.Vector3();
  for (const mesh of visibleMeshes(world.scene)) {
    const isTerrain = mesh.parent === world.store.group;
    const position = mesh.geometry.attributes.position, normal = mesh.geometry.attributes.normal;
    for (let q = 0; q < position.count; q += 4) {
      if (normal.getY(q) < 0.99) continue;
      let cx = 0, cy = 0, cz = 0;
      for (let k = 0; k < 4; k++) { v.fromBufferAttribute(position, q + k).applyMatrix4(mesh.matrixWorld); cx += v.x; cy += v.y; cz += v.z; }
      cx /= 4; cy /= 4; cz /= 4;
      const key = `${Math.floor(cx)},${Math.floor(cz)}`;
      const top = want.get(key);
      if (top === undefined || Math.abs(cy - top) > 0.2) continue;
      const map = isTerrain ? terrain : proxies;
      map.set(key, (map.get(key) || 0) + 1);
    }
  }
  return { terrain, proxies };
}
function assertDrawnOnce(world, cells, label) {
  const tops = cells.filter(c => !cells.some(o => o.x === c.x && o.z === c.z && o.y === c.y + 1));
  const { terrain, proxies } = topCoverage(world, tops);
  for (const c of tops) {
    const key = `${c.x},${c.z}`;
    const total = (terrain.get(key) || 0) + (proxies.get(key) || 0);
    assert.equal(total, 1, `${label}: cell ${key} top drawn ${total} times (terrain ${terrain.get(key) || 0}, proxy ${proxies.get(key) || 0})`);
  }
  return { terrain: [...terrain.values()].reduce((a, b) => a + b, 0), proxies: [...proxies.values()].reduce((a, b) => a + b, 0) };
}
function assertNotDrawn(world, cells, label) {
  const { terrain, proxies } = topCoverage(world, cells);
  assert.equal(terrain.size + proxies.size, 0, `${label}: removed cells still drawn`);
}
/** One browser frame: terrain rebuild budget, then the fx on the presented clock. */
function frame(world, fx, clock, budget = Infinity) { world.store.update(budget); fx.update(1 / 60, clock); }

// ------------------------------------------------------------ motion helper
check(() => {
  const out = new Float64Array(12);
  for (let trial = 0; trial < 60; trial++) {
    const r = (k) => Math.sin(trial * 12.9898 + k * 78.233) * 0.5;
    const event = { p: [10 + r(1), 8 + r(2), 6 + r(3)], v: [r(4), 0, r(5)], w: trial % 5 ? [r(6) * 2, r(7), r(8) * 2] : [0, 0, 0],
      g: STRUCTURE_RULES.gravity, land: 400 + trial * 3 };
    for (const t of [-50, 0, 120, 333, event.land, event.land + 500]) {
      const m = collapseMatrix(event, t, out);
      for (const point of [[10, 8, 6], [11.5, 9.5, 5.5], [9, 7, 8]]) {
        const ref = collapsePoint(event, point, t);
        const got = [0, 1, 2].map(row => m[row * 4] * point[0] + m[row * 4 + 1] * point[1] + m[row * 4 + 2] * point[2] + m[row * 4 + 3]);
        for (let a = 0; a < 3; a++) assert(Math.abs(got[a] - ref[a]) < 1e-9, `collapseMatrix matches collapsePoint (${trial}, ${t})`);
      }
    }
  }
}, 'collapseMatrix');

// ------------------------------------------------- mesher mask and cell meshes
check(() => {
  const world = makeWorld();
  const cells = box(4, 9, 8, 8, 4, 9, PLANK);
  for (const c of cells) world.set(c.x, c.y, c.z, c.t);
  world.store.rebuildChunk(0, 0);
  assertDrawnOnce(world, cells, 'slab in terrain');
  const before = world.store.serial;
  world.store.hideCells(cells.map(c => idx(c.x, c.y, c.z)));
  assert(!world.store.cellsRebuiltSince(cells.map(c => idx(c.x, c.y, c.z)), before), 'hidden cells wait for a rebuild');
  world.store.update(Infinity);
  assert(world.store.cellsRebuiltSince(cells.map(c => idx(c.x, c.y, c.z)), before));
  assertNotDrawn(world, cells, 'hidden slab');
  // The store still holds the blocks: showing them remeshes.
  assert.equal(world.store.showCells(cells.map(c => idx(c.x, c.y, c.z))), cells.length);
  world.store.update(Infinity);
  assertDrawnOnce(world, cells, 'shown slab');
  // Showing cells that are air in the store needs no remesh.
  world.store.hideCells([idx(4, 8, 4)]);
  world.set(4, 8, 4, AIR);
  assert.equal(world.store.showCells([idx(4, 8, 4)]), 0);
  assert.equal(world.store.hidden.size, 0);
  // Reference counts: two holders, the cell stays hidden until both let go.
  world.store.hideCells([idx(5, 8, 5)]); world.store.hideCells([idx(5, 8, 5)]);
  world.store.showCells([idx(5, 8, 5)]);
  assert.equal(world.store.hidden.get(idx(5, 8, 5)), 1);
  world.store.showCells([idx(5, 8, 5)]);
  assert(!world.store.hidden.has(idx(5, 8, 5)));
}, 'chunk store mask');

check(() => {
  // A proxy built with the live store looks exactly like the terrain's own faces for those cells.
  const world = makeWorld();
  const cells = box(20, 23, 6, 7, 20, 22, BRICK);
  for (const c of cells) world.set(c.x, c.y, c.z, c.t);
  world.set(21, 8, 21, CONCRETE);  // a neighbour above that hides faces and darkens AO
  const isolated = new ChunkStore(new THREE.Scene(), atlas, (x, y, z) => (cells.some(c => c.x === x && c.y === y && c.z === z) || (x === 21 && y === 8 && z === 21) || y < 2 ? world.getBlock(x, y, z) : AIR), () => 0, dims);
  isolated.rebuildChunk(1, 1);
  const flat = cells.flatMap(c => [c.x, c.y, c.z, c.t]);
  const meshes = world.store.meshCells(flat, world.getBlock);
  const quads = (list, filter) => {
    const out = new Map();
    for (const mesh of list) {
      const p = mesh.geometry.attributes.position, col = mesh.geometry.attributes.color, aux = mesh.geometry.attributes.terrainAux;
      for (let q = 0; q < p.count; q += 4) {
        const key = [0, 1, 2, 3].map(k => `${p.getX(q + k)},${p.getY(q + k)},${p.getZ(q + k)}`).join('|');
        const cx = (p.getX(q) + p.getX(q + 2)) / 2, cy = (p.getY(q) + p.getY(q + 2)) / 2, cz = (p.getZ(q) + p.getZ(q + 2)) / 2;
        if (!filter(cx, cy, cz)) continue;
        out.set(key, [0, 1, 2, 3].map(k => `${col.getX(q + k).toFixed(5)},${col.getY(q + k).toFixed(5)},${aux.getX(q + k)}`).join('|'));
      }
    }
    return out;
  };
  const inCells = (x, y, z) => x > 19.9 && x < 24.1 && y > 5.9 && y < 8.1 && z > 19.9 && z < 23.1;
  const proxy = quads(meshes, inCells);
  const terrain = quads(isolated.group.children, (x, y, z) => inCells(x, y, z) && !(x > 20.9 && x < 22.1 && y > 7.9 && z > 20.9 && z < 22.1 && y > 8));
  assert(proxy.size > 0);
  assert.deepEqual([...proxy.keys()].sort(), [...terrain.keys()].sort(), 'same faces as the terrain mesher');
  for (const [key, colors] of proxy) assert.equal(colors, terrain.get(key), 'same AO, shade and edge mask');
  // A loose chunk (only its own blocks as neighbours) has its outer surface only: internal faces culled.
  const slab = box(0, 7, 10, 15, 0, 7, CONCRETE);
  const local = new Set(slab.map(c => idx(c.x, c.y, c.z)));
  const loose = world.store.meshCells(slab.flatMap(c => [c.x, c.y, c.z, c.t]), (x, y, z) => (local.has(idx(x, y, z)) ? CONCRETE : AIR));
  const vertices = loose.reduce((sum, mesh) => sum + mesh.geometry.attributes.position.count, 0);
  assert.equal(vertices / 4, 2 * (8 * 6 + 8 * 8 + 6 * 8), '384-block chunk: surface quads only');
  // Cheap: 384 blocks well under a frame on this machine.
  const times = [];
  for (let i = 0; i < 9; i++) {
    const start = performance.now();
    const built = world.store.meshCells(slab.flatMap(c => [c.x, c.y, c.z, c.t]), (x, y, z) => (local.has(idx(x, y, z)) ? CONCRETE : AIR));
    times.push(performance.now() - start);
    for (const mesh of built) mesh.geometry.dispose();
  }
  times.sort((a, b) => a - b);
  console.log(`  384-block chunk mesh: median ${times[4].toFixed(2)} ms`);
  assert(times[4] < 12, `384-block chunk meshes in ${times[4].toFixed(2)} ms`);
}, 'cell mesher');

// --------------------------------------------- creak -> collapse -> land, live
check(() => {
  const world = makeWorld(), f = fakes();
  const slab = box(4, 9, 8, 8, 4, 9, PLANK);
  for (const c of slab) world.set(c.x, c.y, c.z, c.t);
  world.store.rebuildChunk(0, 0);
  const fx = makeFx(world, f);
  const geometries = new Set();
  const created = () => { fx.root.traverse(n => { if (n.isMesh) geometries.add(n.geometry); }); };

  // Creak arrives (server 1000); the presented clock is still behind it.
  fx.receive({ serverNow: 1000, events: [creakEvent('k1', 1000, slab)], blocks: [] });
  assert.equal(fx.counts.holds, 1);
  assert.equal(fx.counts.heldCells, slab.length);
  assert.equal(world.store.hidden.size, slab.length, 'held cells leave the terrain mesh');
  // Before the terrain rebuilt, the old terrain mesh draws them and the proxy waits.
  fx.update(1 / 60, 900);
  assertDrawnOnce(world, slab, 'creak received, terrain not rebuilt');
  // Rebuild budget of 0 this frame: still the terrain.
  frame(world, fx, 916, 0);
  assertDrawnOnce(world, slab, 'no rebuild yet');
  frame(world, fx, 933);
  const swap = assertDrawnOnce(world, slab, 'proxy after rebuild');
  assert(swap.proxies > 0 && swap.terrain === 0, 'the proxy draws the slab once the terrain dropped it');
  created();
  // Presented creak: shake, grit, sound.
  for (let t = 1000; t < 1440; t += 16.7) frame(world, fx, t);
  const hold = fx.holds[0];
  assert(hold.group.position.length() > 0 && hold.group.position.length() < STRUCTURE_FX.shake[1] * 1.8, 'subtle shake');
  assert(f.fx.emits.grit > 0, 'grit trickles');
  assert.equal(f.audio.calls.filter(c => c[0] === 'creak').length, 1, 'one creak sound');
  assert.equal(f.audio.calls[0][2].material, 'wood');
  assertDrawnOnce(world, slab, 'shaking');

  // The collapse snapshot (server 1450): receive, then its deltas remove the slab from the store.
  const collapse = collapseEvent('c1', 'k1', 1450, slab, { drop: 6 });
  fx.receive({ serverNow: 1450, events: [collapse], blocks: removal(slab) });
  world.apply(removal(slab));
  created();
  assert.equal(fx.counts.chunks, 1);
  assert.equal(fx.counts.chunkMeshes, 1);
  frame(world, fx, 1440);
  assertDrawnOnce(world, slab, 'deltas applied, presentation before the fall');
  // Fall starts on the presented clock: proxy -> chunk in the same frame.
  frame(world, fx, 1451);
  const start = assertDrawnOnce(world, slab, 'fall start');
  assert(start.proxies > 0 && start.terrain === 0);
  assert.equal(fx.counts.heldCells, 0, 'the chunk took every cell');
  assert.equal(world.store.hidden.size, 0, 'no mask left (the store is air there)');
  // Mid-fall: posed by the shared motion model.
  for (let t = 1451; t < 1650; t += 16.7) frame(world, fx, t);
  frame(world, fx, 1450 + 200);
  const chunk = fx.chunks[0];
  const corner = collapsePoint(collapse, [4, 8, 4], 200);
  const m = chunk.group.matrix.elements;
  const moved = new THREE.Vector3(4, 8, 4).applyMatrix4(chunk.group.matrix);
  for (let a = 0; a < 3; a++) assert(Math.abs(moved.getComponent(a) - corner[a]) < 1e-6, 'chunk posed with collapsePoint');
  assert(moved.y < 8 - 0.1 && m.length === 16, 'falling');
  assert(f.fx.emits.dust > 0, 'trailing dust on high');
  assertNotDrawn(world, slab, 'mid-fall: nothing at the old place');

  // Landing snapshot with rubble under the chunk (arrives before its presentation).
  const landAt = 1450 + Math.ceil(collapse.land / 16.67) * 16.67;
  const rubble = [{ x: 6, y: 2, z: 6, t: PLANK }, { x: 7, y: 2, z: 6, t: PLANK }];
  const landEvent = { t: 'ev', kind: 'collapseLand', id: 'c1', at: landAt, x: collapse.p[0], y: collapse.p[1] - 6, z: collapse.p[2], n: slab.length, r: 2, speed: 10.8 };
  const rubbleDeltas = rubble.map(c => ({ i: idx(c.x, c.y, c.z), v: c.t }));
  fx.receive({ serverNow: landAt, events: [landEvent], blocks: rubbleDeltas });
  world.apply(rubbleDeltas);
  frame(world, fx, 1450 + collapse.land - 20);
  assertNotDrawn(world, rubble, 'rubble hidden until the chunk lands');
  const chipsBefore = f.chips.count;
  frame(world, fx, 1450 + collapse.land + 1, 0);
  assert(f.chips.count > chipsBefore, 'the chunk breaks into chips');
  assert(chunk.group && chunk.group.visible, 'landed chunk stays until the rubble is drawn');
  frame(world, fx, 1450 + collapse.land + 17);
  assertDrawnOnce(world, rubble, 'rubble drawn by the terrain');
  assert.equal(chunk.group, null, 'chunk mesh released');
  frame(world, fx, landAt + 1);
  assert(f.audio.calls.some(c => c[0] === 'impact' && c[2].n === slab.length), 'impact sound');
  assert(f.shake.total > 0, 'camera shake near the impact');
  assert(f.fx.emits.debris > 0, 'debris bits');
  for (let t = landAt; t < landAt + 1200; t += 16.7) frame(world, fx, t);
  assert.deepEqual(fx.counts, { holds: 0, sections: 0, sectionMeshes: 0, chunks: 0, chunkMeshes: 0, heldCells: 0, creaks: 0, lands: 0, crumbles: 0 });
  assert.equal(world.store.hidden.size, 0);
  assert(geometries.size >= 2);
  assert.equal(fx.root.children.length, 0, 'nothing left under the fx root');
}, 'creak, collapse and landing');

// Disposal is observable: count dispose() calls on geometries the fx made.
check(() => {
  const world = makeWorld(), f = fakes();
  const slab = box(30, 33, 10, 10, 30, 33, CONCRETE);
  for (const c of slab) world.set(c.x, c.y, c.z, c.t);
  world.store.rebuildChunk(1, 1); world.store.rebuildChunk(2, 1); world.store.rebuildChunk(1, 2); world.store.rebuildChunk(2, 2);
  const fx = makeFx(world, f);
  const made = new Set(), freed = new Set();
  const track = () => fx.root.traverse(n => {
    if (!n.isMesh || made.has(n.geometry)) return;
    made.add(n.geometry);
    n.geometry.addEventListener('dispose', (e) => freed.add(e.target));
  });
  fx.receive({ serverNow: 0, events: [creakEvent('k2', 0, slab)], blocks: [] }); track();
  // The slab spans four terrain columns (x 30..33 and z 30..33 cross 32): sections swap per column.
  assert.equal(fx.holds[0].sections.length, 4);
  world.store.update(1); fx.update(1 / 60, -10);
  const partial = assertDrawnOnce(world, slab, 'one column rebuilt');
  assert(partial.proxies > 0 && partial.terrain > 0, 'sections swap per terrain column');
  frame(world, fx, -5); track();
  const collapse = collapseEvent('c2', 'k2', 450, slab, { drop: 8 });
  fx.receive({ serverNow: 450, events: [collapse], blocks: removal(slab) }); world.apply(removal(slab)); track();
  for (let t = -5; t < 450 + collapse.land + 400; t += 16.7) { frame(world, fx, t); track(); assertDrawnOnceOrFalling(t); }
  function assertDrawnOnceOrFalling(t) { if (t < 450) assertDrawnOnce(world, slab, `t=${t.toFixed(0)}`); }
  assert(made.size > 0);
  assert.equal(freed.size, made.size, 'every fx geometry disposed');
  fx.dispose();
  assert.equal(fx.root.parent, null);
}, 'per-column swap and disposal');

// ----------------------------------------------------- a creak that is saved
check(() => {
  const world = makeWorld(), f = fakes();
  const beam = box(10, 13, 9, 9, 10, 10, BRICK);
  for (const c of beam) world.set(c.x, c.y, c.z, c.t);
  world.store.rebuildChunk(0, 0);
  const fx = makeFx(world, f);
  fx.receive({ serverNow: 0, events: [creakEvent('k3', 0, beam)], blocks: [] });
  frame(world, fx, -1);
  assertDrawnOnce(world, beam, 'held');
  // Later ticks arrive without a collapse (a pillar was placed in time).
  const release = STRUCTURE_RULES.creakMs + STRUCTURE_FX.releaseGraceMs;
  fx.receive({ serverNow: release + 50, events: [], blocks: [] });
  frame(world, fx, release - 1);
  assert.equal(fx.counts.heldCells, beam.length, 'held through the grace');
  fx.update(1 / 60, release + 1);
  assert.equal(world.store.hidden.size, 0, 'cells handed back to the terrain');
  assertDrawnOnce(world, beam, 'release before the rebuild: the proxy still draws');
  frame(world, fx, release + 17);
  const back = assertDrawnOnce(world, beam, 'saved');
  assert.equal(back.proxies, 0);
  assert.equal(fx.counts.holds, 0);
  assert.equal(f.chips.count, 0);
}, 'saved creak');

// ----------------------------------- a rocket takes a held block during the creak
check(() => {
  const world = makeWorld(), f = fakes();
  const beam = box(10, 13, 9, 9, 10, 10, BRICK);
  for (const c of beam) world.set(c.x, c.y, c.z, c.t);
  world.store.rebuildChunk(0, 0);
  const fx = makeFx(world, f);
  fx.receive({ serverNow: 0, events: [creakEvent('k4', 0, beam)], blocks: [] });
  frame(world, fx, 0);
  const shot = [{ i: idx(10, 9, 10), v: 0 }];
  fx.receive({ serverNow: 100, events: [], blocks: shot });
  world.apply(shot);
  frame(world, fx, 50);
  assertNotDrawn(world, [beam[0]], 'shot block gone from the proxy at once');
  assertDrawnOnce(world, beam.slice(1), 'rest still held');
  assert.equal(world.store.hidden.has(idx(10, 9, 10)), false);
}, 'unrelated delta');

// ------------------------------------------ collapse without its creak (late join)
check(() => {
  const world = makeWorld(), f = fakes();
  const block = box(26, 27, 12, 12, 6, 6, PLANK);
  for (const c of block) world.set(c.x, c.y, c.z, c.t);
  world.store.rebuildChunk(1, 0);
  const fx = makeFx(world, f);
  const collapse = collapseEvent('c5', 'k5', 2000, block, { drop: 10 });
  fx.receive({ serverNow: 2000, events: [collapse], blocks: removal(block) });
  world.apply(removal(block));
  assert.equal(fx.holds[0].kind, 'cover');
  fx.update(1 / 60, 1900);
  assertDrawnOnce(world, block, 'cover waits for the rebuild');
  frame(world, fx, 1917);
  assertDrawnOnce(world, block, 'cover drawn, terrain dropped it');
  frame(world, fx, 2001);
  assertDrawnOnce(world, block, 'chunk took over');
  assert.equal(fx.counts.holds, 0);
}, 'cover proxy');

// ----------------------------------------------------------------- crumble
check(() => {
  const world = makeWorld(), f = fakes();
  const heap = box(2, 5, 12, 13, 30, 33, CONCRETE);
  for (const c of heap) world.set(c.x, c.y, c.z, c.t);
  for (let cz = 0; cz < 3; cz++) world.store.rebuildChunk(0, cz);
  const fx = makeFx(world, f);
  fx.receive({ serverNow: 0, events: [creakEvent('k6', 0, heap)], blocks: [] });
  frame(world, fx, 0);
  fx.receive({ serverNow: 450, events: [{ t: 'ev', kind: 'crumble', id: 'k6', at: 450, ...encode(heap) }], blocks: removal(heap) });
  world.apply(removal(heap));
  frame(world, fx, 440);
  assertDrawnOnce(world, heap, 'crumble pending');
  frame(world, fx, 451);
  assertNotDrawn(world, heap, 'crumbled');
  assert(f.chips.count > 0 && f.fx.emits.dust > 0);
  assert(f.audio.calls.some(c => c[0] === 'crumble'));
  for (let t = 451; t < 1200; t += 16.7) frame(world, fx, t);
  assert.equal(fx.counts.holds, 0);
  assert.equal(world.store.hidden.size, 0);
}, 'crumble');

// ------------------------------- a mass support loss: meshing over many frames
check(() => {
  // 36 creaks arrive in one snapshot; with no meshing budget each frame meshes
  // one queued item (chunks first), so sections stay pending for many frames,
  // a collapse claims some still-pending ones (meshed at once) and some
  // chunks start before their queued mesh was built (built at the start).
  // Every block is drawn exactly once in every frame throughout.
  const world = makeWorld(), f = fakes();
  const slabs = [];
  for (let b = 0; b < 6; b++) for (let a = 0; a < 6; a++) slabs.push(box(8 * a + 2, 8 * a + 5, 8, 8, 8 * b + 2, 8 * b + 5, a % 2 ? BRICK : PLANK));
  const all = slabs.flat();
  for (const c of all) world.set(c.x, c.y, c.z, c.t);
  for (let cz = 0; cz < 3; cz++) for (let cx = 0; cx < 3; cx++) world.store.rebuildChunk(cx, cz);
  let tick = 0;
  const fx = makeFx(world, f, { meshBudgetMs: 0, now: () => tick++ });
  fx.receive({ serverNow: 1000, events: slabs.map((cells, i) => creakEvent(`k${i}`, 1000, cells)), blocks: [] });
  assert.equal(fx.counts.heldCells, all.length, 'every creak cell is owned by a proxy');
  assert.deepEqual(fx.pending, { sections: 36, chunks: 0 }, 'no meshing on receipt past the budget');
  assert.equal(world.store.hidden.size, 0, 'pending cells stay in the terrain mesh');
  assertDrawnOnce(world, all, 'creaks received, nothing meshed');
  let clock = 1000;
  for (let i = 0; i < 26; i++, clock += 16.7) { frame(world, fx, clock, 1); assertDrawnOnce(world, all, `frame ${i}`); }
  const left = fx.pending.sections;
  assert(left > 0 && left < 36, `sections meshed one per frame (${left} left)`);
  // The collapse of the last six slabs (still pending) arrives just before its presentation.
  const falling = slabs.slice(30), staying = slabs.slice(0, 30).flat();
  const events = falling.map((cells, i) => collapseEvent(`c${i}`, `k${30 + i}`, 1450, cells, { drop: 6 }));
  const deltas = falling.flatMap(removal);
  fx.receive({ serverNow: 1450, events, blocks: deltas });
  world.apply(deltas);
  assert(fx.stats.forcedSections > 0, 'pending sections a collapse claims are meshed at once');
  assert.equal(fx.pending.chunks, 6, 'chunk meshes wait for the budget');
  for (; clock < 1450; clock += 16.7) { frame(world, fx, clock, 1); assertDrawnOnce(world, all, `before the fall ${clock.toFixed(0)}`); }
  frame(world, fx, clock, 1);
  assert(fx.stats.forcedChunks > 0 && fx.stats.deferredChunks > 0, 'chunks meshed ahead within the budget or at their start');
  assert.equal(fx.pending.chunks, 0);
  assertDrawnOnce(world, all, 'fall start: the chunks took their cells, the rest held');
  assert(fx.chunks.every(chunk => chunk.group?.visible), 'every chunk falls with its mesh');
  for (const end = clock + 200; clock < end; clock += 16.7) frame(world, fx, clock, 1);
  assertNotDrawn(world, falling.flat(), 'mid-fall: nothing at the old place');
  assertDrawnOnce(world, staying, 'mid-fall: the rest held');
  // The remaining creaks are saved: back to the terrain, still exactly once per frame.
  fx.receive({ serverNow: 3000, events: [], blocks: [] });
  for (let i = 0; i < 160; i++, clock += 16.7) {
    frame(world, fx, clock, 1);
    if (i % 4 === 0) assertDrawnOnce(world, staying, `saving ${i}`);
  }
  assertDrawnOnce(world, staying, 'saved');
  assert.deepEqual(fx.pending, { sections: 0, chunks: 0 });
  assert.deepEqual(fx.counts, { holds: 0, sections: 0, sectionMeshes: 0, chunks: 0, chunkMeshes: 0, heldCells: 0, creaks: 0, lands: 0, crumbles: 0 });
  assert.equal(world.store.hidden.size, 0, 'no mask left');
  assert(fx.stats.deferredSections > 0);
}, 'budgeted meshing');

// A default budget keeps receipt cheap: 200 creaks cost a bounded slice of meshing.
check(() => {
  const world = makeWorld(), f = fakes();
  const slabs = [];
  for (let b = 0; b < 6; b++) for (let a = 0; a < 6; a++) for (let y = 3; y < 23; y += 4) slabs.push(box(8 * a + 1, 8 * a + 6, y, y, 8 * b + 1, 8 * b + 6, CONCRETE));
  for (const c of slabs.flat()) world.set(c.x, c.y, c.z, c.t);
  for (let cz = 0; cz < 3; cz++) for (let cx = 0; cx < 3; cx++) world.store.rebuildChunk(cx, cz);
  const events = slabs.map((cells, i) => creakEvent(`m${i}`, 0, cells));
  const fx = makeFx(world, f, { meshBudgetMs: STRUCTURE_FX.meshBudgetMs });
  const started = performance.now();
  fx.receive({ serverNow: 0, events, blocks: [] });
  const ms = performance.now() - started;
  // The same receipt meshing everything at once, for comparison.
  const other = makeWorld();
  for (const c of slabs.flat()) other.set(c.x, c.y, c.z, c.t);
  const all = makeFx(other, fakes());
  const t0 = performance.now();
  all.receive({ serverNow: 0, events, blocks: [] });
  const allMs = performance.now() - t0;
  console.log(`  ${slabs.length} creaks received in ${ms.toFixed(2)} ms with the ${STRUCTURE_FX.meshBudgetMs} ms budget`
    + ` (${fx.stats.sections - fx.pending.sections} of ${fx.stats.sections} sections meshed), ${allMs.toFixed(2)} ms meshing all at once`);
  all.dispose();
  assert(fx.pending.sections > 0, 'the rest waits for later frames');
  for (let i = 0; i < 400 && fx.pending.sections; i++) frame(world, fx, -100 + i);
  assert.equal(fx.pending.sections, 0, 'and drains');
}, 'receipt budget');

// ------------------------------------------------------------- tier caps
check(() => {
  for (const tier of ['low', 'medium', 'high', 'ultra']) {
    const world = makeWorld(), f = fakes();
    const fx = makeFx(world, f, { tier });
    const events = [], removed = [];
    for (let i = 0; i < 10; i++) {
      const cells = box(2 + i * 4, 3 + i * 4, 10, 10, 2, 3, CONCRETE);
      for (const c of cells) world.set(c.x, c.y, c.z, c.t);
      events.push(collapseEvent(`c${i}`, 'k', 100, cells, { drop: 8 }));
      removed.push(...removal(cells));
    }
    world.store.update(Infinity);
    fx.receive({ serverNow: 100, events, blocks: removed });
    world.apply(removed);
    const cap = STRUCTURE_FX_TIERS[tier].maxChunks;
    assert.equal(fx.counts.chunkMeshes, Math.min(10, cap), `${tier}: chunk mesh cap`);
    assert.equal(fx.stats.overCap, Math.max(0, 10 - cap));
    for (let t = 90; t < 250; t += 16.7) frame(world, fx, t);
    const trail = fx.stats.trailPuffs;
    if (STRUCTURE_FX_TIERS[tier].trails) assert(trail > 0, `${tier}: dust trails`);
    else assert.equal(trail, 0, `${tier}: no dust trails`);
    if (10 > cap) assert(f.chips.count > 0, `${tier}: over the cap chunks burst in place`);
    fx.dispose();
    assert.equal(world.store.hidden.size, 0);
  }
  // Particle budgets scale with the tier.
  const burst = (tier) => {
    const world = makeWorld(), f = fakes();
    const fx = makeFx(world, f, { tier });
    const heap = box(2, 9, 10, 13, 2, 9, BRICK);
    for (const c of heap) world.set(c.x, c.y, c.z, c.t);
    world.store.update(Infinity);
    fx.receive({ serverNow: 0, events: [{ t: 'ev', kind: 'crumble', id: 'k', at: 0, ...encode(heap) }], blocks: removal(heap) });
    world.apply(removal(heap));
    frame(world, fx, 1);
    return f.chips.count;
  };
  assert(burst('low') < burst('high'), 'low tier: fewer particles');
}, 'graphics tiers');

// ------------------------------------------------------- replay (no masking)
check(() => {
  const world = makeWorld(), f = fakes();
  const slab = box(4, 7, 8, 8, 4, 7, PLANK);
  for (const c of slab) world.set(c.x, c.y, c.z, c.t);
  world.store.rebuildChunk(0, 0);
  let hidden = 0;
  const mesher = { meshCells: world.store.meshCells.bind(world.store), hideCells: () => { hidden++; } };
  const fx = new StructureFx({ parent: world.scene, mesher, getBlock: world.getBlock, dimensions: dims, fx: f.fx, chips: f.chips,
    audio: f.audio, tier: 'medium', masking: false });
  fx.receive({ events: [creakEvent('k7', 0, slab)] });
  fx.update(1 / 60, 10);
  assert.equal(fx.counts.holds, 0, 'replays draw no proxies');
  assert(f.audio.calls.some(c => c[0] === 'creak'));
  const collapse = collapseEvent('c7', 'k7', 450, slab);
  world.apply(removal(slab));
  fx.receive({ events: [collapse] });
  fx.update(1 / 60, 450);
  world.store.update(Infinity);
  assertDrawnOnce(world, slab, 'replay: chunk appears with the recorded terrain');
  for (let t = 450; t < 450 + collapse.land + 100; t += 16.7) fx.update(1 / 60, t);
  assert.equal(hidden, 0);
  assert.equal(fx.counts.chunks, 0);
  fx.dispose();
}, 'killcam replay');

check(() => {
  const history = new KillcamHistory();
  const slab = box(1, 2, 3, 3, 1, 1, BRICK);
  history.record({ serverNow: 1, players: [], events: [creakEvent('k', 1, slab), collapseEvent('c', 'k', 1, slab),
    { t: 'ev', kind: 'collapseLand', id: 'c', at: 1, x: 1, y: 1, z: 1, n: 2, r: 0, speed: 3 }, { t: 'ev', kind: 'crumble', id: 'k', at: 1, ...encode(slab) }] });
  assert.deepEqual(history.frames[0].events.map(e => e.kind), ['creak', 'collapse', 'collapseLand', 'crumble']);
  for (const kind of STRUCTURE_EVENT_KINDS) assert(history.frames[0].events.some(e => e.kind === kind));
  assert.deepEqual(structureEventCells(history.frames[0].events[1]).length, 2);
}, 'killcam history');

// ------------------------------------------------------------ kill feed & UI
check(() => {
  assert.equal(WEAPON_NAMES[COLLAPSE_WEAPON], 'COLLAPSE');
  assert(isVehicleKillKey(COLLAPSE_WEAPON), 'collapse draws a vector icon');
  assert(ICON_PATHS[KILL_KEY_ICONS[COLLAPSE_WEAPON]], 'collapse icon path');
}, 'kill feed');

const { BuildController, BUILD_REASON_TEXT, BUILD_REFUSAL_MS } = await import('../public/js/player/build-controller.js');
check(() => {
  let now = 1000;
  const controller = new BuildController({ input: { setBuildMode() {} }, getBlock: () => 0, getWorldview: () => null, getCamera: () => null,
    getPlayer: () => null, getMatch: () => null, getSelfRow: () => null, getMapMeta: () => null, purchase: () => true, now: () => now });
  assert.equal(controller.refused('unsupported'), false, 'not in build mode: the caller banners it');
  controller.active = true; controller.visible = true; controller.result = { ok: true, reason: null };
  assert.equal(controller.refused('unsupported'), true);
  assert.equal(controller.readModel().reason, BUILD_REASON_TEXT.unsupported);
  assert.equal(controller.readModel().ok, false);
  now += BUILD_REFUSAL_MS + 1;
  assert.equal(controller.readModel().reason, null);
  assert.equal(controller.readModel().ok, true);
}, 'bastion refusal');

// ------------------------------------------------------------------ wiring
check(() => {
  const main = readFileSync(new URL('../public/js/main.js', import.meta.url), 'utf8');
  const tick = main.slice(main.indexOf('  handleTick(snapshot'), main.indexOf('  queueAuthoritativeSnapshot('));
  assert(tick.indexOf('this.structureFx?.receive(snapshot)') >= 0 && tick.indexOf('this.structureFx?.receive(snapshot)') < tick.indexOf('applySnapshotBlocks?.(snapshot'),
    'proxies take their cells before the deltas apply');
  const loop = main.slice(main.indexOf('  loop(generation'));
  assert(loop.indexOf('this.worldview.update(dt') < loop.indexOf('this.structureFx?.update('), 'fx swaps after the terrain rebuild budget');
  assert(main.includes('this.net?.presentedServerTime?.(performance.now())'));
  assert(main.includes('this.structureFx?.dispose(); this.structureFx = null;'));
  assert(main.indexOf('this.structureFx?.dispose()') < main.indexOf('this.particleField?.dispose()'), 'fx before its particle field');
  assert(main.includes('onActivate: () => this.structureFx?.clear()'), 'the killcam takes the terrain back first');
  assert(main.indexOf('this.structureFx = new rt.StructureFx(') < main.indexOf('rt.warmShaders('), 'built before shader warm-up');
  assert(main.includes("event.kind === 'bastion_build_refused'"));
  const session = readFileSync(new URL('../public/js/session/session.js', import.meta.url), 'utf8');
  assert(session.includes("'bastion_build_refused'"));
  const runtime = readFileSync(new URL('../public/js/boot/match-runtime.js', import.meta.url), 'utf8');
  for (const name of ['StructureFx', 'STRUCTURE_SAMPLE_MANIFEST', 'BUILD_REASON_TEXT']) assert(runtime.includes(name), `runtime exports ${name}`);
  assert(FX_KINDS.includes('grit'));
  assert.equal(dominantMaterial([PLANK, PLANK, CONCRETE]), 'wood');
  assert.equal(dominantMaterial([GLASS, GLASS]), 'glass');
}, 'wiring');

check(() => {
  // Licensed Conquest files reused, already credited (docs/audio/conquest-sfx.md).
  const credits = readFileSync(new URL('../docs/audio/conquest-sfx.md', import.meta.url), 'utf8');
  const conquestUrls = new Set(Object.values(CONQUEST_SAMPLE_MANIFEST));
  assert(Object.keys(STRUCTURE_SAMPLE_MANIFEST).length >= 5);
  for (const [slot, url] of Object.entries(STRUCTURE_SAMPLE_MANIFEST)) {
    assert(slot.startsWith('structure.'));
    assert(conquestUrls.has(url), `${url} is a Conquest bank file`);
    assert(existsSync(new URL(`../public${url}`, import.meta.url)), `${url} exists`);
    assert(credits.includes(url.split('/').slice(-2).join('/')), `${url} credited`);
  }
  assert(credits.includes('structure.'), 'conquest-sfx.md documents the collapse slots');
}, 'collapse samples');

check(() => {
  // The presented clock maps the drain target back to server time through the newest snapshot.
  const net = new NetClient();
  net.latestSnapshots.push({ now: 5000, serverNow: 1000, snapSeq: 1, events: [{ kind: 'creak', at: 1000 }] });
  net.latestSnapshots.push({ now: 5017, serverNow: 1017, snapSeq: 2, events: [] });
  assert.equal(net.presentedServerTime(5100, 40), 1060);
  assert.equal(net.presentedServerTime(5039, 40), 999);
  assert.equal(new NetClient().presentedServerTime(1), null);
}, 'presented clock');

// --------------------------------------------------- server template warm-up
await (async () => {
  // Slices: a fake clock that advances 1 ms per read ends every slice after a
  // couple of build steps, so big maps take many slices; maps without a
  // template (null) are skipped; each slot runs one slice.
  const queue = [];
  let clock = 0;
  const worlds = [createMapState('foundry'), () => createMapState('reactor'), () => null, () => createMapState('harbor')];
  const done = warmStructureTemplates(worlds, { schedule: (fn) => queue.push(fn), now: () => clock++, sliceMs: 2 });
  let slots = 0;
  while (queue.length) { queue.shift()(); slots++; assert(queue.length <= 1, 'one slice per slot'); }
  const timings = await done;
  assert.deepEqual(timings.map(row => row.map), ['foundry', 'reactor', 'harbor']);
  assert(timings.every(row => row.slices > 1 && !row.error), 'every build is spread over several slices');
  assert(slots >= timings.reduce((sum, row) => sum + row.slices, 0), 'a slot runs at most one slice');
  const start = performance.now();
  SupportField.forWorld(createMapState('foundry'));
  assert(performance.now() - start < 5, 'a warmed template forks instead of building');
  checks++;

  // A room created on a map whose warm-up is half done finishes that build
  // itself; the field equals a from-scratch build and the warm-up moves on.
  const later = [];
  const pending = warmStructureTemplates([() => createMapState('waterworld'), () => createMapState('causeway')],
    { schedule: (fn) => later.push(fn), now: () => clock++, sliceMs: 2 });
  for (let i = 0; i < 4; i++) later.shift()();
  const world = createMapState('waterworld');
  assert(!SupportField.templateReady(world), 'waterworld is still warming');
  const forked = SupportField.forWorld(world);
  assert(SupportField.templateReady(world), 'the room finished the build');
  const rebuilt = SupportField.build(world.dimensions, (x, y, z) => world.getBlock(x, y, z));
  assert.deepEqual(forked.pinKeys().sort((a, b) => a - b), rebuilt.pinKeys().sort((a, b) => a - b), 'same pins as a one-shot build');
  let differ = 0;
  const { sx, sy, sz } = world.dimensions;
  for (let y = 1; y < sy; y += 3) for (let z = 0; z < sz; z += 2) for (let x = 0; x < sx; x += 2) if (forked.read(x, y, z) !== rebuilt.read(x, y, z)) differ++;
  assert.equal(differ, 0, 'same support as a one-shot build');
  while (later.length) later.shift()();
  const rows = await pending;
  assert.deepEqual(rows.map(row => row.map), ['waterworld', 'causeway']);
  assert(SupportField.templateReady(createMapState('causeway')), 'the warm-up continues with the next map');
  checks++;

  const index = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
  assert(index.indexOf('prepareStructureTemplate(world)') > 0 && index.indexOf('prepareStructureTemplate(world)') < index.indexOf('server.listen('),
    'Frontier field prepared before accepting players');
  assert(index.indexOf('warmStructureTemplates(') > index.indexOf('server.listen('), 'the other maps warm after listening');
  assert(index.includes('schedule: afterRoomTick'), 'slices run right after a room tick, also while rooms exist');
  assert(index.includes('sort((a, b) => volume(a) - volume(b))'), 'smallest maps first');
  checks++;

  // afterRoomTick: at once with no ticking room; else in the gap after a tick.
  const order = [];
  await new Promise((resolve) => afterRoomTick(() => { order.push('idle'); resolve(); }));
  const engine = new GameEngine({ world: createMapState('foundry') });
  engine.start(5);
  await new Promise((resolve) => afterRoomTick(() => { order.push(engine.tickTiming ? 'after-tick' : '?'); resolve(); }));
  engine.stop();
  assert.deepEqual(order, ['idle', 'after-tick']);
  checks++;
})();

console.log(`structure client checks passed (${checks})`);
