// ParticleField: two instanced draws, GPU-integrated ring buffers, presets,
// emitters, tier capacities, near/ground fade encoding and disposal.
import assert from 'node:assert/strict';
import * as THREE from '../public/js/vendor/three.module.js';
import { ParticleField, FX_KINDS, particleAtlas } from '../public/js/fx/particle-field.js';
import { FX_PRESETS, PARTICLE_CAPACITY, particleCapacityForTier, DUST_TINTS } from '../public/js/fx/presets.js';

let checks = 0;
const check = (fn) => { fn(); checks++; };

// Contract kinds (spec §3.6) and presets.
check(() => assert.deepEqual([...FX_KINDS], ['dust', 'smoke', 'smokeColumn', 'fire', 'spark', 'debris', 'muzzle', 'exhaust', 'flare', 'water', 'ember', 'tracerPuff', 'grit']));
for (const kind of FX_KINDS) {
  const preset = FX_PRESETS[kind];
  check(() => assert.ok(preset, `${kind} has a preset`));
  check(() => assert.ok(['alpha', 'add'].includes(preset.blend)));
  check(() => assert.ok(preset.life[0] > 0 && preset.life[1] >= preset.life[0], `${kind} life range`));
  check(() => assert.ok([0, 1, 2, 3].includes(preset.tile)));
  if (preset.blend === 'add') check(() => assert.ok(Math.max(...preset.color0) > 1, `${kind} additive glow is HDR (> 1)`));
}
check(() => assert.equal(particleCapacityForTier('low'), 2048));
check(() => assert.equal(particleCapacityForTier('medium'), 4096));
check(() => assert.equal(particleCapacityForTier('high'), 8192));
check(() => assert.equal(particleCapacityForTier('unknown'), PARTICLE_CAPACITY.medium));
check(() => assert.ok(Object.values(DUST_TINTS).every(tint => tint.length === 3 && tint.every(v => v >= 0 && v <= 1))));

// Atlas: 2x2 tiles, cached.
const atlas = particleAtlas();
check(() => assert.equal(atlas, particleAtlas(), 'atlas is shared'));
check(() => assert.equal(atlas.image.width, 128));

const scene = new THREE.Scene();
const field = new ParticleField({ scene, capacity: 2048 });
check(() => assert.equal(field.group.parent, scene));
const meshes = [];
field.group.traverse(object => { if (object.isMesh) meshes.push(object); });
check(() => assert.equal(meshes.length, 2, 'exactly two draws: alpha and additive pools'));
check(() => assert.equal(field.stats.draws, 2));
check(() => assert.deepEqual(meshes.map(mesh => mesh.material.name).sort(), ['particle-field-add', 'particle-field-alpha']));
const add = meshes.find(mesh => mesh.material.name === 'particle-field-add');
const alpha = meshes.find(mesh => mesh.material.name === 'particle-field-alpha');
check(() => assert.equal(add.material.blending, THREE.AdditiveBlending));
check(() => assert.equal(alpha.material.blending, THREE.NormalBlending));
check(() => assert.ok(Object.hasOwn(add.material.defines, 'PARTICLE_ADDITIVE')));
for (const mesh of meshes) {
  check(() => assert.equal(mesh.material.depthWrite, false));
  check(() => assert.equal(mesh.material.fog, true, 'particles are fogged'));
  check(() => assert.equal(mesh.frustumCulled, false));
  check(() => assert.ok(mesh.isInstancedMesh, 'one InstancedMesh per blend mode'));
  // GPU integration: the vertex shader reads the spawn state, not CPU positions.
  check(() => assert.match(mesh.material.vertexShader, /uTime - aPos0\.w/));
  check(() => assert.match(mesh.material.vertexShader, /exp\( - drag \* age \)/));
  // Near-camera fade (2.5 m) and the ground-plane fade.
  check(() => assert.match(mesh.material.vertexShader, /smoothstep\( 0\.6, 2\.5, distance\( p, uCamPos \) \)/));
  check(() => assert.match(mesh.material.fragmentShader, /vWorldY - vGround/));
  check(() => assert.doesNotMatch(mesh.material.vertexShader, /inverse\(|transpose\(/, 'WebGL1-safe GLSL'));
}
check(() => assert.equal(alpha.geometry.attributes.aPos0.count + add.geometry.attributes.aPos0.count, 2048, 'capacity split across pools'));

// Emits route to the right pool and write a full record.
check(() => assert.equal(field.emit('nope', [0, 0, 0]), 0, 'unknown kinds emit nothing'));
check(() => assert.equal(field.emit('dust', [NaN, 0, 0]), 0, 'invalid positions emit nothing'));
check(() => assert.equal(field.emit('dust', null), 0));
check(() => assert.equal(field.emit('dust', [1, 2, 3], { count: 0 }), 0));
const written = field.emit('dust', { x: 4, y: 10, z: -2 }, { count: 5, dir: [0, 1, 0], ground: 9.5 });
check(() => assert.equal(written, 5));
field.update(0.016, null);
check(() => assert.equal(alpha.count, 5, 'instance count follows the used slots'));
check(() => assert.equal(add.count, 0));
const pos0 = alpha.geometry.attributes.aPos0.array, vel = alpha.geometry.attributes.aVel.array;
const size = alpha.geometry.attributes.aSize.array, misc = alpha.geometry.attributes.aMisc.array;
const groundAttr = alpha.geometry.attributes.aGround.array;
for (let i = 0; i < 5; i++) {
  check(() => assert.ok(Math.hypot(pos0[i * 4] - 4, pos0[i * 4 + 2] + 2) <= FX_PRESETS.dust.jitter + 1e-6, 'spawn near origin'));
  check(() => assert.equal(pos0[i * 4 + 3], 0, 'birth time is the field clock at emit'));
  check(() => assert.ok(vel[i * 4 + 3] >= FX_PRESETS.dust.life[0] - 1e-6 && vel[i * 4 + 3] <= FX_PRESETS.dust.life[1] + 1e-6));
  check(() => assert.equal(size[i * 4 + 2], Math.fround(FX_PRESETS.dust.gravity)));
  check(() => assert.equal(size[i * 4 + 3], Math.fround(FX_PRESETS.dust.drag)));
  check(() => assert.equal(groundAttr[i], 9.5, 'explicit ground plane'));
  check(() => assert.equal(misc[i * 4], FX_PRESETS.dust.tile + 4, 'near-fade flag packed with the tile'));
  // Velocity stays inside the cone around +Y.
  const v = [vel[i * 4], vel[i * 4 + 1], vel[i * 4 + 2]], len = Math.hypot(...v);
  check(() => assert.ok(v[1] / len >= Math.cos(FX_PRESETS.dust.spread) - 1e-6, 'direction inside the cone'));
}
check(() => assert.ok(alpha.geometry.attributes.aPos0.updateRanges.length === 1, 'only the dirty range uploads'));
check(() => assert.deepEqual({ ...alpha.geometry.attributes.aPos0.updateRanges[0] }, { start: 0, count: 20 }));

const sparks = field.emit('spark', [0, 5, 0], { count: 3, near: true });
field.update(0.016, null);
check(() => assert.equal(sparks, 3));
check(() => assert.equal(add.count, 3, 'additive kinds use the additive pool'));
check(() => assert.equal(add.geometry.attributes.aMisc.array[0], FX_PRESETS.spark.tile + 4, 'near override'));
check(() => assert.ok(add.geometry.attributes.aMisc.array[3] > 0, 'sparks are velocity-streaked'));
check(() => assert.equal(add.geometry.attributes.aGround.array[0] < -9999, true, 'no ground plane unless asked'));

// Inherited velocity and colour overrides.
field.emit('flare', [0, 0, 0], { count: 1, velocity: [100, 0, 0], color: [9, 9, 9], dir: [0, 1, 0], speed: 0 });
field.update(0, null);
check(() => assert.ok(add.geometry.attributes.aVel.array[3 * 4] >= 99, 'inherits the hull velocity'));
check(() => assert.equal(add.geometry.attributes.aCol0.array[3 * 4], 9));

// Ring buffer: overflow overwrites the oldest, never grows.
const ring = new ParticleField({ capacity: 64 });
const alphaCapacity = ring.pools.alpha.capacity;
for (let i = 0; i < 10; i++) ring.emit('smoke', [0, 0, 0], { count: 20 });
ring.update(0.01, null);
check(() => assert.equal(ring.pools.alpha.used, alphaCapacity));
check(() => assert.equal(ring.pools.alpha.cursor, (200) % alphaCapacity));
check(() => assert.ok(ring.stats.alive <= 64));
check(() => assert.equal(ring.emit('smoke', [0, 0, 0], { count: 9999 }), 256, 'one burst is capped'));
// Particles die by age: the clock passes every life.
ring.update(0.25, null);
for (let i = 0; i < 60; i++) ring.update(0.25, null);
check(() => assert.equal(ring.stats.alive, 0, 'every particle expires'));
ring.dispose();

// Continuous emitters: rate per second, live edits, expiry, removal.
const emitterField = new ParticleField({ capacity: 4096 });
let source = [1, 2, 3];
const handle = emitterField.addEmitter({ kind: 'exhaust', pos: () => source, rate: 30 });
check(() => assert.ok(handle?.active));
for (let i = 0; i < 60; i++) emitterField.update(1 / 60, null);
check(() => assert.ok(Math.abs(emitterField.emitsByKind.exhaust - 30) <= 1, `rate holds: ${emitterField.emitsByKind.exhaust}`));
source = [50, 2, 3];
emitterField.update(0.1, null);
const last = (emitterField.pools.alpha.cursor - 1 + emitterField.pools.alpha.capacity) % emitterField.pools.alpha.capacity;
check(() => assert.ok(Math.abs(emitterField.pools.alpha.attributes.aPos0.array[last * 4] - 50) < 1, 'emitter re-reads its position'));
check(() => assert.equal(emitterField.removeEmitter(handle), true));
const before = emitterField.emitted;
for (let i = 0; i < 30; i++) emitterField.update(1 / 60, null);
check(() => assert.equal(emitterField.emitted, before, 'removed emitters stop'));
const timed = emitterField.addEmitter({ kind: 'fire', pos: [0, 0, 0], rate: 100, until: 0.5 });
for (let i = 0; i < 60; i++) emitterField.update(1 / 60, null);
check(() => assert.equal(timed.active, false, 'timed emitters expire'));
check(() => assert.equal(emitterField.addEmitter({ kind: 'unknown', pos: [0, 0, 0] }), null));

// Camera uniform and lighting.
const camera = new THREE.PerspectiveCamera();
camera.position.set(3, 4, 5); camera.updateMatrixWorld();
emitterField.update(0.016, camera);
check(() => assert.deepEqual(emitterField.uniforms.uCamPos.value.toArray(), [3, 4, 5]));
emitterField.setLighting([0.5, 0.6, 0.7]);
check(() => assert.deepEqual(emitterField.uniforms.uLight.value.toArray(), [0.5, 0.6, 0.7]));

// CPU: a heavy frame of emits plus update stays far below the 1.5 ms FX budget per frame.
const bench = new ParticleField({ capacity: 8192 });
const started = performance.now();
const frames = 120;
for (let frame = 0; frame < frames; frame++) {
  for (let i = 0; i < 16; i++) bench.emit(FX_KINDS[(frame + i) % FX_KINDS.length], [i, 1, frame], { count: 4 });
  bench.update(1 / 60, camera);
}
const perFrame = (performance.now() - started) / frames;
check(() => assert.ok(perFrame < 1.5, `64 particles/frame cost ${perFrame.toFixed(3)} ms`));

// clear() and dispose().
emitterField.clear();
check(() => assert.equal(emitterField.stats.alive, 0));
check(() => assert.equal(emitterField.emitters.size, 0));
field.dispose();
check(() => assert.equal(field.group.parent, null));
check(() => assert.equal(field.emit('dust', [0, 0, 0]), 0, 'a disposed field ignores emits'));
field.dispose();
emitterField.dispose(); bench.dispose();
console.log(`Particle field: ${checks} checks passed (2 draws, GPU ring buffers, presets, emitters, ${perFrame.toFixed(3)} ms/frame).`);
