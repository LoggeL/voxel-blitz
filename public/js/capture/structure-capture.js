// Static, muted capture of a scripted structural collapse (docs/structural-physics.md):
// a roof whose pillars were shot away, a wooden platform on a broken post and
// a lintel that crumbles, played through the live client pieces (WorldView
// terrain mesher and mask, StructureFx, ParticleField, ImpactFX) on a fixed
// 60 Hz step with the server's wire events. No network, audio or game loop.
//
// ?t=<ms> presented time after the creak (default 300), ?quality=low|medium|high|ultra,
// ?delay=<ms> presentation delay behind the snapshot arrivals (default 70),
// ?post=0 the raw scene, ?view=hero|close|top.
import * as THREE from '../vendor/three.module.js';
import { createMapState } from '../../../shared/worlddata.js';
import { AIR, BRICK, CONCRETE, PLANK, WOOD } from '../../../shared/world/blocks.js';
import { STRUCTURE_RULES } from '../../../shared/structure.js';
import { WorldView } from '../engine/worldview.js';
import { CombatPostProcess } from '../engine/combat-post-process.js';
import { rendererCapabilities, resolveGraphicsProfile } from '../engine/graphics-quality.js';
import { StructureFx } from '../fx/structure-fx.js';
import { ParticleField } from '../fx/particle-field.js';
import { particleCapacityForTier } from '../fx/presets.js';
import { ImpactFX } from '../weapons/impacts.js';

const params = new URLSearchParams(location.search);
const target = Number(params.get('t') ?? 300);
const delay = Number(params.get('delay') ?? 70);
const view = params.get('view') || 'hero';
const MAP = 'canyon';
const GROUND = 14;
const STEP = 1000 / 60;

const canvas = document.getElementById('capture');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
renderer.toneMapping = THREE.NeutralToneMapping;
const graphics = resolveGraphicsProfile(params.get('quality') || 'high', rendererCapabilities(renderer));
const post = params.get('post') === '0' ? null : new CombatPostProcess(renderer, {
  maxPixelRatio: 1, msaa: graphics.msaa, hdr: graphics.hdr, bloomLevels: graphics.bloomLevels,
  fxaa: graphics.msaa === 0, ssao: graphics.ssao,
});
renderer.setPixelRatio(1);
renderer.setSize(innerWidth, innerHeight, false);
post?.setSize(innerWidth, innerHeight, 1);

// ------------------------------------------------------------------ the set
const world = createMapState(MAP);
const { sx: SX, sz: SZ } = world.dimensions;
const index = (x, y, z) => x + SX * (z + SZ * y);
const box = (x0, x1, y0, y1, z0, z1, t) => {
  const out = [];
  for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) out.push({ x, y, z, t });
  return out;
};
const place = cells => { for (const c of cells) world.setBlock(c.x, c.y, c.z, c.t); };
// Clear the air above the open sand, then build.
for (let y = GROUND + 1; y < world.dimensions.sy; y++) for (let z = 38; z < 84; z++) for (let x = 70; x < 118; x++) world.setBlock(x, y, z, AIR);
for (let z = 38; z < 84; z++) for (let x = 70; x < 118; x++) if (world.getBlock(x, GROUND, z) === AIR) world.setBlock(x, GROUND, z, world.getBlock(95, GROUND, 55));
const pillars = [[90, 50], [98, 50], [90, 58], [98, 58]].flatMap(([x, z]) => box(x, x, GROUND + 1, GROUND + 6, z, z, BRICK));
const roof = [...box(90, 98, GROUND + 7, GROUND + 7, 50, 58, CONCRETE), ...box(90, 98, GROUND + 8, GROUND + 8, 50, 50, BRICK),
  ...box(90, 90, GROUND + 8, GROUND + 8, 51, 58, BRICK)];
const post_ = box(84, 84, GROUND + 1, GROUND + 4, 60, 60, WOOD);
const platform = box(83, 85, GROUND + 5, GROUND + 5, 59, 61, PLANK);
const columns = [...box(104, 104, GROUND + 1, GROUND + 4, 54, 54, BRICK), ...box(108, 108, GROUND + 1, GROUND + 4, 54, 54, BRICK)];
const lintel = box(104, 108, GROUND + 5, GROUND + 5, 54, 54, BRICK);
place([...pillars, ...roof, ...post_, ...platform, ...columns, ...lintel]);

// ------------------------------------------------------------- wire events
const encode = (cells) => {
  let mx = Infinity, my = Infinity, mz = Infinity;
  for (const c of cells) { mx = Math.min(mx, c.x); my = Math.min(my, c.y); mz = Math.min(mz, c.z); }
  return { o: [mx, my, mz], b: cells.flatMap(c => [c.x - mx, c.y - my, c.z - mz, c.t]), n: cells.length };
};
const g = STRUCTURE_RULES.gravity, fall = STRUCTURE_RULES.creakMs;
const tick = (ms) => Math.ceil(ms / STEP) * STEP;
function collapse(id, k, cells, drop, v, w) {
  let px = 0, py = 0, pz = 0;
  for (const c of cells) { px += c.x + 0.5; py += c.y + 0.5; pz += c.z + 0.5; }
  const p = [px / cells.length, py / cells.length, pz / cells.length];
  const land = Math.sqrt(2 * drop / g) * 1000;
  return { t: 'ev', kind: 'collapse', id, k, at: fall, ...encode(cells), p, v, w, g, land };
}
const removal = cells => cells.map(c => ({ i: index(c.x, c.y, c.z), v: AIR }));
const roofFall = collapse('c1', 'k1', roof, 6, [0, 0, 0], [0.16, 0, -0.11]);
const platformFall = collapse('c2', 'k2', platform, 4, [0.62, 0, 0.28], [0.45, 0, -1.0]);
/** Rubble the server settles: part of the bottom layer, dropped onto the sand. */
function rubbleFor(event, cells, drop, count) {
  const dx = Math.round(event.v[0] * event.land / 1000), dz = Math.round(event.v[2] * event.land / 1000);
  const bottom = cells.filter(c => !cells.some(o => o.x === c.x && o.z === c.z && o.y === c.y - 1));
  const keep = c => ((Math.imul(c.x * 73856093 ^ c.z * 83492791, 0x9e3779b1) >>> 0) / 4294967296) < 0.42;
  return bottom.filter(keep).slice(0, count)
    .map(c => ({ x: c.x + dx, y: GROUND + 1, z: c.z + dz, t: c.t }));
}
const roofRubble = rubbleFor(roofFall, roof, 6, 24), platformRubble = rubbleFor(platformFall, platform, 4, 3);
const landing = (event, cells, rubble) => ({
  at: tick(event.at + event.land),
  events: [{ t: 'ev', kind: 'collapseLand', id: event.id, at: tick(event.at + event.land),
    x: event.p[0] + event.v[0] * event.land / 1000, y: event.p[1] - (cells === roof ? 6 : 4), z: event.p[2] + event.v[2] * event.land / 1000,
    n: cells.length, r: rubble.length, speed: g * event.land / 1000 }],
  blocks: rubble.map(c => ({ i: index(c.x, c.y, c.z), v: c.t })),
});
// Snapshots in arrival order (server time = arrival time here; the view presents `delay` behind).
const snapshots = [
  // A rocket takes the pillars, the post and one lintel column.
  { at: -STEP, events: [], blocks: removal([...pillars, ...post_, ...columns.slice(4)]) },
  { at: 0, events: [
    { t: 'ev', kind: 'creak', id: 'k1', at: 0, fall, ...encode(roof) },
    { t: 'ev', kind: 'creak', id: 'k2', at: 0, fall, ...encode(platform) },
    { t: 'ev', kind: 'creak', id: 'k3', at: 0, fall, ...encode(lintel) },
  ], blocks: [] },
  { at: fall, events: [roofFall, platformFall, { t: 'ev', kind: 'crumble', id: 'k3', at: fall, ...encode(lintel) }],
    blocks: removal([...roof, ...platform, ...lintel]) },
  landing(roofFall, roof, roofRubble),
  landing(platformFall, platform, platformRubble),
].sort((a, b) => a.at - b.at);

// --------------------------------------------------------------- the view
const camera = new THREE.PerspectiveCamera(58, innerWidth / innerHeight, 0.05, 400);
const views = {
  hero: { from: [79, GROUND + 8, 76], at: [95, GROUND + 3.5, 55] },
  close: { from: [86, GROUND + 4.5, 69], at: [94, GROUND + 4, 55] },
  top: { from: [94, GROUND + 24, 80], at: [94, GROUND + 1, 55] },
};
const shot = views[view] || views.hero;
camera.position.fromArray(shot.from);
camera.lookAt(new THREE.Vector3().fromArray(shot.at));
camera.updateProjectionMatrix();

const store = { getBlock: world.getBlock, meta: world.meta };
const worldview = new WorldView(store, world.meta, { graphics, renderer });
post?.setGrade(worldview.palette.grade);
worldview.setViewPosition(camera.position);
await worldview.ready();
await worldview.skyUpdate.ready;
worldview.scene.add(camera);
const effects = new THREE.Group();
worldview.scene.add(effects);
const particles = new ParticleField({ scene: effects, capacity: particleCapacityForTier(graphics.tier) });
const impacts = new ImpactFX(effects, camera, world.getBlock);
const fx = new StructureFx({ parent: effects, mesher: worldview.chunkStore, getBlock: world.getBlock,
  dimensions: world.dimensions, fx: particles, chips: impacts, audio: null, tier: graphics.tier });
worldview.syncFarFog();

// ------------------------------------------------------- run to the shot
let next = 0;
let maxHidden = 0;
const start = performance.now();
for (let receive = -12 * STEP; receive - delay <= target + 1e-6; receive += STEP) {
  while (next < snapshots.length && snapshots[next].at <= receive + 1e-6) {
    const snapshot = { ...snapshots[next], serverNow: snapshots[next].at };
    fx.receive(snapshot);
    const touched = [];
    for (const { i, v } of snapshot.blocks) {
      const x = i % SX, z = Math.floor(i / SX) % SZ, y = Math.floor(i / (SX * SZ));
      world.setBlock(x, y, z, v);
      touched.push({ x, y, z, v });
    }
    worldview.applyDeltas(touched);
    next++;
  }
  worldview.update(STEP / 1000, camera);
  fx.update(STEP / 1000, receive - delay);
  particles.update(STEP / 1000, camera);
  impacts.update(STEP / 1000);
  maxHidden = Math.max(maxHidden, worldview.chunkStore.hidden.size);
}
const simulateMs = performance.now() - start;
const frame = () => (post ? post.render(worldview.scene, camera, { time: target / 1000, adaptInstant: true }) : renderer.render(worldview.scene, camera));
frame();
frame();

document.documentElement.dataset.captureReady = 'true';
document.documentElement.dataset.captureT = String(target);
document.documentElement.dataset.captureView = view;
window.__vbStructure = Object.freeze({
  t: target, delay, view, graphics: graphics.tier, counts: fx.counts, stats: { ...fx.stats }, maxHidden, simulateMs,
  hidden: worldview.chunkStore.hidden.size, particles: particles.stats,
  exportPng: () => { frame(); return canvas.toDataURL('image/png'); },
});
