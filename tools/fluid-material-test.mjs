// Fluid surfaces: one shared clock, per-kind presets, chunk buckets and disposal.
import assert from 'node:assert/strict';
import * as THREE from '../public/js/vendor/three.module.js';
import { createFluidMaterial, tickFluidMaterials, fluidMaterialCount, fluidClock } from '../public/js/engine/fluid-material.js';
import { ChunkStore } from '../public/js/engine/chunks.js';
import { faceTile, tileRect } from '../public/js/engine/atlas.js';
import { MC_WATER, MC_LAVA, MC_STONE, AIR } from '../shared/world/blocks.js';

const before = fluidMaterialCount();
const water = createFluidMaterial('water', { tileRect: tileRect(faceTile(MC_WATER, 2)) });
const lava = createFluidMaterial('lava', { tileRect: tileRect(faceTile(MC_LAVA, 2)) });
assert.equal(fluidMaterialCount(), before + 2);
assert.ok(water.transparent && !water.depthWrite, 'water blends over the sea floor');
assert.ok(!lava.transparent && lava.depthWrite, 'lava is opaque');
assert.ok(lava.uniforms.glow.value > 0 && water.uniforms.glow.value === 0, 'only lava glows');
assert.ok(water.fog && water.vertexColors && water.side === THREE.DoubleSide, 'fog, mesher shade and underside views apply');
assert.match(water.vertexShader, /waveHeight/);
assert.match(water.fragmentShader, /fresnel/);
assert.throws(() => createFluidMaterial('slime'), /unknown fluid/);
const rect = water.uniforms.tileRect.value;
assert.ok(rect.x < rect.z && rect.y < rect.w, 'tile rect is min/max ordered for wrapped sampling');

// One clock moves every live material; a disposed one leaves the registry.
const start = fluidClock();
tickFluidMaterials(0.5);
assert.equal(water.uniforms.time.value, lava.uniforms.time.value);
assert.ok(water.uniforms.time.value > start);
tickFluidMaterials(NaN); tickFluidMaterials(-1);
assert.equal(water.uniforms.time.value, lava.uniforms.time.value, 'invalid deltas are ignored');
lava.dispose();
assert.equal(fluidMaterialCount(), before + 1);
tickFluidMaterials(0.25);
assert.notEqual(lava.uniforms.time.value, water.uniforms.time.value, 'a disposed material is no longer driven');
water.dispose();
assert.equal(fluidMaterialCount(), before);

// The mesher routes each fluid into its own animated bucket.
const blocks = new Map([['2,4,2', MC_WATER], ['3,4,2', MC_WATER], ['5,4,5', MC_LAVA], ['2,3,2', MC_STONE], ['5,3,5', MC_STONE]]);
const getBlock = (x, y, z) => blocks.get(`${x},${y},${z}`) ?? AIR;
const scene = new THREE.Scene();
const store = new ChunkStore(scene, { texture: () => ({}), tileRect, faceTile }, getBlock);
assert.equal(fluidMaterialCount(), before + 2, 'the store owns one water and one lava material');
store.rebuildChunk(0, 0);
const names = scene.children[0].children.map((mesh) => mesh.name).sort();
assert.deepEqual(names, ['lava', 'opaque', 'water']);
const waterMesh = scene.children[0].children.find((mesh) => mesh.name === 'water');
assert.equal(waterMesh.material.userData.fluid, 'water');
assert.equal(waterMesh.renderOrder, 3, 'water draws after glass');
assert.equal(waterMesh.geometry.attributes.color.count, waterMesh.geometry.attributes.position.count, 'mesher shade travels as vertex colour');
store.dispose();
assert.equal(fluidMaterialCount(), before, 'disposing the store releases its fluid materials');
console.log('fluid materials: presets, shared clock, chunk buckets and disposal passed');
