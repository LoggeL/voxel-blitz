// ConquestAmbience: chimney plumes, wreck columns and off-map salvos through
// the real shared ParticleField (WP6), sourced from the real Frontier v2
// metadata. Checks sources, the particle budget, draws, CPU, determinism and
// teardown.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import * as THREE from '../public/js/vendor/three.module.js';
import {
  ConquestAmbience, conquestAmbienceSources, findChimneyTops,
  AMBIENCE_CAPS, AMBIENCE_PARTICLE_BUDGET, AMBIENCE_WIND, ARTILLERY_INTERVAL, ARTILLERY_BEYOND,
} from '../public/js/engine/conquest-ambience.js';
import { CONQUEST_WIND_YAW } from '../public/js/engine/conquest-world.js';
import { ParticleField, FX_KINDS } from '../public/js/fx/particle-field.js';
import { FX_PRESETS, PARTICLE_CAPACITY } from '../public/js/fx/presets.js';
import { createFrontierMetadata } from '../shared/world/frontier-layout.js';

/** The real field, recording every emit and emitter so the test can inspect parameters. */
class RecordingField extends ParticleField {
  constructor(options) { super(options); this.log = []; this.added = []; }
  emit(kind, pos, params = {}) {
    if (params.source === 'artillery') this.log.push({ kind, pos, params });
    return super.emit(kind, pos, params);
  }
  addEmitter(spec) { const handle = super.addEmitter(spec); this.added.push({ ...spec, handle }); return handle; }
  aliveNow() { return this.stats.alive; }
}

const meta = createFrontierMetadata();
const works = meta.conquest.flags.find(flag => flag.site === 'works');

// --- Sources: chimney landmarks and the dressing wrecks, nothing invented -----------------
const sources = conquestAmbienceSources(meta);
const chimneyMarks = meta.landmarks.filter(mark => mark.kind === 'chimney');
const wreckRows = meta.conquest.dressing.filter(row => row.kind === 'wreck');
assert.ok(chimneyMarks.length >= 2, 'Frontier lists the Kessler Works chimneys');
assert.ok(wreckRows.length >= 4, 'Frontier dressing lists the wreck props');
assert.deepEqual(sources.chimneys.map(p => [p.x, p.y, p.z]), chimneyMarks.map(m => [m.x, m.y, m.z]), 'one plume per chimney landmark');
assert.deepEqual(sources.wrecks.map(p => [p.x, p.y, p.z]), wreckRows.slice(0, AMBIENCE_CAPS.wrecks).map(w => [w.x, w.y, w.z]),
  'wreck columns rise from the authored smoke anchors');
assert.ok(!sources.chimneys.some(p => Math.hypot(p.x - 508.5, p.z - 557.5) < 3), 'the cooling tower is not a chimney');
for (const p of sources.chimneys) assert.ok(Math.hypot(p.x - works.x, p.z - works.z) < 80, 'plumes stand at the works');
assert.deepEqual(sources.bounds, { minX: 0, maxX: meta.dimensions.sx, minZ: 0, maxZ: meta.dimensions.sz });
assert.deepEqual(conquestAmbienceSources({}).chimneys, [], 'no metadata, no plumes');

// Chimney tops found in the voxel world when the metadata does not list them.
const stack = (x, z) => (vx, vy, vz) => vx >= x && vx <= x + 2 && vz >= z && vz <= z + 2 && vy <= 77;
const stacks = [stack(works.x + 10, works.z - 8), stack(works.x + 20, works.z - 8)];
const tower = (vx, vy, vz) => Math.hypot(vx - works.x + 25, vz - works.z - 10) < 9 && vy <= 74; // wide: not a chimney
const getBlock = (x, y, z) => (y < 30 || stacks.some(s => s(x, y, z)) || tower(x, y, z) ? 1 : 0);
const found = findChimneyTops(getBlock, { cx: works.x, cz: works.z, sx: 768, sz: 768 });
assert.equal(found.length, 2, 'two narrow stacks, the wide tower is ignored');
for (const top of found) assert.equal(top.y, 78);
const probed = conquestAmbienceSources({ ...meta, landmarks: [] }, { getBlock });
assert.equal(probed.chimneys.length, 2);

// --- Emitters on the real field: no draws of its own, valid presets ------------------------
const scene = new THREE.Scene();
const fx = new RecordingField({ scene, capacity: PARTICLE_CAPACITY.low });
const flatRim = (x, y, z) => (y < 40 ? 1 : 0);
const ambience = new ConquestAmbience({ scene, fx, mapMeta: meta, weather: 'golden', getBlock: flatRim });
assert.equal(ambience.stats.draws, 0);
assert.equal(fx.stats.draws, 2, 'the shared field stays at two draws');
assert.equal(fx.added.length, sources.chimneys.length + sources.wrecks.length * 2, 'a plume per chimney, a column and embers per wreck');
assert.equal(fx.emitters.size, fx.added.length, 'every emitter is live in the field');
for (const spec of fx.added) {
  assert.ok(FX_KINDS.includes(spec.kind) && FX_PRESETS[spec.kind], `known kind ${spec.kind}`);
  assert.ok(spec.rate > 0 && spec.rate <= 4, 'modest emitter rates');
  for (const key of ['color0', 'color1']) {
    if (spec.params[key] != null) assert.ok(Array.isArray(spec.params[key]) && spec.params[key].length === 3, 'linear RGB colours');
  }
  assert.ok(spec.params.life > 0 && spec.params.life <= 2, 'life is a preset multiplier, not seconds');
  // Smoke drifts the way the flag cloths stream.
  const [vx, , vz] = spec.params.velocity;
  assert.ok(Math.abs(Math.atan2(-vz, vx) - CONQUEST_WIND_YAW) < 1e-9, 'smoke leans downwind like the flags');
}
const plumes = fx.added.filter(e => e.params.source === 'chimney');
assert.ok(plumes.every(e => e.kind === 'smokeColumn' && e.pos[1] > 78), 'plumes leave the stack tops');
assert.ok(Math.abs(Math.hypot(AMBIENCE_WIND[0], AMBIENCE_WIND[2]) - 1) < 1e-9);

// --- Two simulated minutes: salvos, particle budget, CPU ----------------------------------------
const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.05, 1800);
camera.position.set(150, 50, 400);
let peakAlive = 0;
let ambienceMs = 0, fieldMs = 0, frames = 0;
for (let t = 0; t < 120; t += 1 / 60) {
  let at = performance.now();
  ambience.update(1 / 60, camera);
  ambienceMs += performance.now() - at;
  at = performance.now();
  fx.update(1 / 60, camera);
  fieldMs += performance.now() - at;
  frames++;
  if (t > 30) peakAlive = Math.max(peakAlive, fx.aliveNow());
}
const flashes = fx.log.filter(e => e.kind === 'muzzle');
assert.ok(flashes.length >= 120 / ARTILLERY_INTERVAL[1] * 0.6, `salvos keep coming (${flashes.length})`);
assert.ok(flashes.length <= 120 / ARTILLERY_INTERVAL[0] * 3, 'salvos are bounded');
const { sx, sz } = meta.dimensions;
for (const flash of flashes) {
  const [x, y, z] = flash.pos;
  const beyond = Math.max(-x, x - sx, -z, z - sz);
  assert.ok(beyond >= ARTILLERY_BEYOND[0] - 26 && beyond <= ARTILLERY_BEYOND[1] + 26, `salvos land just beyond the map edge (${beyond.toFixed(1)} m)`);
  assert.ok(y > 40 && y < 40 + 6 + 18 + 4, 'salvos stand on the rim ground');
  assert.ok(Math.max(...flash.params.color) > 1, 'flashes are over-bright for bloom');
}
assert.ok(fx.log.every(e => e.params.source === 'artillery'), 'only the scheduler emits one-shots');
const load = ambience.particleLoad(FX_PRESETS);
assert.ok(load <= AMBIENCE_PARTICLE_BUDGET, `planned ambience load ${load} within ${AMBIENCE_PARTICLE_BUDGET}`);
assert.ok(peakAlive <= AMBIENCE_PARTICLE_BUDGET, `live ambience particles ${peakAlive} within ${AMBIENCE_PARTICLE_BUDGET}`);
assert.ok(peakAlive <= PARTICLE_CAPACITY.low * 0.625 * 0.4, 'vehicle FX keep most of the Low tier alpha pool');
const perFrame = (ambienceMs + fieldMs) / frames;
assert.ok(perFrame <= 0.3, `ambience CPU ${perFrame.toFixed(4)} ms/frame (scheduler + its emitters) stays within 0.3 ms`);

// --- Deterministic for a seed; weather changes the look ------------------------------------------
const replay = new RecordingField({ capacity: PARTICLE_CAPACITY.low });
const again = new ConquestAmbience({ fx: replay, mapMeta: meta, weather: 'golden', getBlock: flatRim });
for (let t = 0; t < 120; t += 1 / 60) again.update(1 / 60);
assert.deepEqual(replay.log.map(e => e.pos), fx.log.map(e => e.pos));
const misty = new RecordingField({ capacity: PARTICLE_CAPACITY.low });
new ConquestAmbience({ fx: misty, mapMeta: meta, weather: 'mist' });
assert.notDeepEqual(misty.added[0].params.color0, plumes[0].params.color0, 'weather tints the smoke');
const fallback = new ConquestAmbience({ fx: new RecordingField({ capacity: 256 }), mapMeta: meta, weather: 'storm' });
assert.equal(fallback.weather, 'golden', 'unknown weather falls back to golden');

// --- Teardown removes every emitter exactly once; no fx means a silent no-op ---------------------
ambience.dispose(); ambience.dispose(); ambience.update(1);
assert.equal(fx.emitters.size, 0);
const silent = new ConquestAmbience({ fx: null, mapMeta: meta });
silent.update(1); silent.dispose();
assert.equal(silent.stats.emitters, 0);
for (const field of [fx, replay, misty]) field.dispose();
console.log(`Conquest ambience passed: ${sources.chimneys.length} chimney plumes and ${sources.wrecks.length} wreck columns from Frontier metadata, `
  + `off-map salvos (${flashes.length} in 120 s), peak ${peakAlive} live particles (budget ${AMBIENCE_PARTICLE_BUDGET}), 2 shared draws, `
  + `${perFrame.toFixed(4)} ms/frame, determinism and teardown.`);
