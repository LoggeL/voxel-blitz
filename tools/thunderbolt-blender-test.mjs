import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import crypto from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeRoot = path.join(root, 'public/assets/blender');
const docsRoot = path.join(root, 'docs/design/blender/thunderbolt');
const readJSON = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const [doc, binary, portableBytes, report, manifest] = await Promise.all([
  readJSON(path.join(runtimeRoot, 'thunderbolt.gltf')),
  fs.readFile(path.join(runtimeRoot, 'thunderbolt.bin')),
  fs.readFile(path.join(docsRoot, 'thunderbolt.glb')),
  readJSON(path.join(docsRoot, 'export-report.json')),
  readJSON(path.join(runtimeRoot, 'manifest.json')),
]);
const parts = ['body', 'bolt', 'trigger', 'rotor', 'orb0', 'orb1', 'orb2', 'orb3', 'energy', 'arcs', 'optic'];
const near = (a, b, epsilon = 1e-6) => Math.abs(a - b) <= epsilon;
const magnitude = v => Math.hypot(...v);
const sub = (a, b) => a.map((n, i) => n - b[i]);
const dot = (a, b) => a.reduce((sum, n, i) => sum + n * b[i], 0);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

assert.equal(doc.asset.version, '2.0');
assert.equal(doc.buffers.length, 1);
assert.equal(doc.buffers[0].byteLength, binary.length);
const topNodes = doc.scenes[doc.scene].nodes.map(i => doc.nodes[i]);
assert.deepEqual(topNodes.map(n => n.name), parts, 'all independently animated parts must be scene roots');
for (const node of doc.nodes) {
  for (const property of ['matrix', 'translation', 'rotation', 'scale']) {
    assert.equal(node[property], undefined, `${node.name}: vertices are exported in global gun coordinates`);
  }
}
for (const part of topNodes) {
  assert.equal(part.mesh, undefined, `${part.name}: top-level wrapper must be a Group`);
  assert.ok(part.children.length, `${part.name}: group must contain meshes`);
  for (const index of part.children) {
    const child = doc.nodes[index];
    assert.equal(child.extras.part, part.name);
    assert.ok(Number.isInteger(child.mesh));
    assert.equal(doc.meshes[child.mesh].primitives.length, 1, 'one material per child prevents loader renaming wrappers');
  }
}

const dimensions = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
function readAccessor(index) {
  const access = doc.accessors[index];
  const view = doc.bufferViews[access.bufferView];
  assert.equal(view.buffer, 0);
  assert.ok(access.componentType === 5126 || access.componentType === 5125);
  const width = dimensions[access.type];
  const stride = view.byteStride ?? width * 4;
  const start = (view.byteOffset || 0) + (access.byteOffset || 0);
  assert.ok(start >= 0 && start + (access.count - 1) * stride + width * 4 <= binary.length, 'accessor stays in buffer');
  return Array.from({ length: access.count }, (_, row) => Array.from({ length: width }, (_, column) => {
    const offset = start + row * stride + column * 4;
    return access.componentType === 5126 ? binary.readFloatLE(offset) : binary.readUInt32LE(offset);
  }));
}

let triangles = 0, draws = 0, texturedTriangles = 0, mappedTriangles = 0;
const perPart = new Map();
for (const part of topNodes) {
  const vertices = [], faces = [];
  for (const ni of part.children) {
    const primitive = doc.meshes[doc.nodes[ni].mesh].primitives[0];
    const pos = readAccessor(primitive.attributes.POSITION);
    const norm = readAccessor(primitive.attributes.NORMAL);
    const uv = readAccessor(primitive.attributes.TEXCOORD_0);
    const idx = readAccessor(primitive.indices).flat();
    const material = doc.materials[primitive.material];
    const uvSample = report.primitives[`${part.name} | ${material.name}`].uv_source_sample;
    assert.ok(uvSample && Math.abs(uvSample.blender_uv[1] - 0.5) > 1e-3, 'UV source sample distinguishes image origins');
    assert.ok(near(uv[uvSample.vertex][0], uvSample.blender_uv[0]) &&
      near(uv[uvSample.vertex][1], 1 - uvSample.blender_uv[1]), 'runtime UV must convert Blender bottom-left origin to glTF top-left origin');
    assert.equal(norm.length, pos.length);
    assert.equal(uv.length, pos.length);
    assert.equal(idx.length % 3, 0);
    assert.ok(pos.flat().every(Number.isFinite) && uv.flat().every(Number.isFinite));
    assert.ok(norm.every(n => near(magnitude(n), 1, 1e-4)), 'split corner normals stay unit length');
    assert.ok(idx.every(i => i < pos.length), 'all indices reference present vertices');
    const acc = doc.accessors[primitive.attributes.POSITION];
    for (let axis = 0; axis < 3; axis++) {
      assert.ok(near(Math.min(...pos.map(v => v[axis])), acc.min[axis]), 'accessor minimum matches actual vertices');
      assert.ok(near(Math.max(...pos.map(v => v[axis])), acc.max[axis]), 'accessor maximum matches actual vertices');
    }
    let uvValid = 0;
    for (let i = 0; i < idx.length; i += 3) {
      const [a, b, c] = idx.slice(i, i + 3).map(j => uv[j]);
      if (Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) > 2e-12) uvValid++;
      const face = idx.slice(i, i + 3).map(j => pos[j]);
      assert.ok(magnitude(cross(sub(face[1], face[0]), sub(face[2], face[0]))) > 1e-12, 'export omits collapsed source triangles');
      faces.push(face);
    }
    assert.ok(uvValid > 0, `${part.name}: UV map must have nonzero area`);
    if (material.pbrMetallicRoughness.baseColorTexture) {
      texturedTriangles += idx.length / 3;
      mappedTriangles += uvValid;
      const tint = material.pbrMetallicRoughness.baseColorFactor;
      assert.ok(tint.length === 4 && tint.every(v => Number.isFinite(v) && v >= 0 && v <= 1), 'texture tint is a valid linear RGBA multiplier');
      assert.deepEqual(tint, report.material_surfaces[material.name].baseColorFactor, 'palette map retains its authored multiply tint');
    }
    draws++;
    triangles += idx.length / 3;
    vertices.push(...pos);
  }
  const bound = { min: [0, 1, 2].map(i => Math.min(...vertices.map(v => v[i]))),
    max: [0, 1, 2].map(i => Math.max(...vertices.map(v => v[i]))) };
  perPart.set(part.name, { bound, vertices, faces });
  assert.deepEqual(Object.keys(report.part_bounds[part.name]), ['min', 'max']);
  for (const type of ['min', 'max']) bound[type].forEach((value, i) => assert.ok(near(value, report.part_bounds[part.name][type][i])));
}
assert.ok(triangles <= 40000, `triangle budget: ${triangles} > 40000`);
assert.ok(draws <= 35, `draw budget: ${draws} > 35`);
assert.ok(texturedTriangles > triangles * 0.6, 'most of the weapon surface uses actual texture images');
assert.ok(mappedTriangles / texturedTriangles > 0.98, 'textured triangles have usable UV area');
assert.ok(doc.images.length >= 4, 'receiver, insulation, conductors and grips have real surface maps');
const imageBytes = await Promise.all(doc.images.map(async image => {
  assert.match(image.uri, /^textures\/[a-z0-9/_-]+\.(?:jpg|jpeg|png)$/);
  const bytes = await fs.readFile(path.join(runtimeRoot, image.uri));
  assert.ok(bytes.length > 4000, `${image.uri}: real texture data`);
  if (image.uri.endsWith('.png')) {
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${image.uri}: PNG signature`);
    assert.ok(bytes.readUInt32BE(16) >= 128 && bytes.readUInt32BE(20) >= 128, 'texture resolution is usable');
  } else assert.equal(bytes.readUInt16BE(0), 0xffd8, `${image.uri}: JPEG signature`);
  return bytes;
}));
const energyMaterial = doc.materials.filter(m => m.extras?.tbEnergy);
assert.equal(energyMaterial.length, 1, 'one shared pulse material controls rails and sight lights');
assert.ok(doc.materials.some(m => m.extras?.tbArc));
assert.ok(energyMaterial[0].emissiveFactor.some(c => c > 0));
assert.ok(energyMaterial[0].extensions.KHR_materials_emissive_strength.emissiveStrength >= 1);
const orbMaterial = doc.materials.filter(m => m.extras?.tbOrb);
assert.equal(orbMaterial.length, 1, 'all five spheres use one dedicated orb material');
assert.equal(orbMaterial[0].extras.tbEnergy, undefined, 'animated plasma material is isolated from static rail lights');
assert.equal(orbMaterial[0].extras.tbArc, undefined, 'orb surfaces are separate from accelerator arc meshes');
assert.equal(orbMaterial[0].pbrMetallicRoughness.baseColorTexture, undefined, 'plasma color is not modulated by a structural surface texture');
assert.deepEqual(report.orb_source_meshes.map(o => o.part).sort(), ['energy', 'orb0', 'orb1', 'orb2', 'orb3'],
  'exactly five source meshes carry the dedicated orb material');
for (const name of ['energy', 'orb0', 'orb1', 'orb2', 'orb3']) {
  const group = topNodes.find(n => n.name === name);
  assert.equal(group.children.length, 1, `${name}: a single sphere has no equator or meridian decoration`);
  const primitive = doc.meshes[doc.nodes[group.children[0]].mesh].primitives[0];
  assert.equal(doc.materials[primitive.material], orbMaterial[0], `${name}: sphere uses the dedicated orbital effect`);
  assert.equal(report.source_parts_per_group[name], 1, `${name}: one authored sphere per effect`);
}

// Independent orb meshes must sit at the four feed cells of the animated rotor.
const contract = doc.asset.extras.contract;
contract.muzzle.forEach((v, i) => assert.ok(near(v, [0, 0.07, -0.74][i]), 'authoritative muzzle contract'));
assert.ok(near(contract.sightHeight, 0.17));
contract.rotorPivot.forEach((v, i) => assert.ok(near(v, [-0.103, 0.009, -0.22][i]), 'runtime rotor pivot'));
for (let i = 0; i < 4; i++) {
  const { bound } = perPart.get(`orb${i}`);
  const center = bound.min.map((v, axis) => (v + bound.max[axis]) / 2);
  const angle = Math.PI / 4 - i * Math.PI / 2;
  const expected = [contract.rotorPivot[0] + Math.cos(angle) * 0.052,
    contract.rotorPivot[1] + Math.sin(angle) * 0.052, contract.rotorPivot[2] + 0.059];
  center.forEach((v, axis) => assert.ok(near(v, expected[axis], 0.002), `orb${i}: authored center must match runtime pivot`));
  assert.ok(bound.max[0] - bound.min[0] > 0.03, 'charge is a visible orb mesh');
  const radii = perPart.get(`orb${i}`).vertices.map(v => magnitude(sub(v, expected)));
  assert.ok(Math.max(...radii) - Math.min(...radii) < 2e-5, `orb${i}: the only surface is spherical`);
}
const coreRadii = perPart.get('energy').vertices.map(v => magnitude(sub(v, contract.energyPivot)));
assert.ok(Math.max(...coreRadii) - Math.min(...coreRadii) < 2e-5, 'accelerator core has a spherical effect surface');
const bodyBound = perPart.get('body').bound;
assert.ok(near(bodyBound.min[2], contract.muzzle[2], 0.026), 'physical accelerator ends at the authoritative muzzle');
assert.ok(bodyBound.max[2] > 0.18 && bodyBound.max[2] < 0.3, 'stock stays in the established weapon envelope');

// Start just ahead of the front sight, then test the full forward sight ray.
function rayHits(triangle, origin = [0, 0.17, -0.585], direction = [0, 0, -1]) {
  const [a, b, c] = triangle, edge1 = sub(b, a), edge2 = sub(c, a);
  const h = cross(direction, edge2), determinant = dot(edge1, h);
  if (Math.abs(determinant) < 1e-12) return false;
  const inverse = 1 / determinant, s = sub(origin, a), u = inverse * dot(s, h);
  if (u < 0 || u > 1) return false;
  const q = cross(s, edge1), v = inverse * dot(direction, q);
  if (v < 0 || u + v > 1) return false;
  const distance = inverse * dot(edge2, q);
  return distance > 1e-6 && distance < 1;
}
for (const [name, part] of perPart) {
  if (name === 'energy' || name === 'arcs') continue;
  assert.ok(!part.faces.some(face => rayHits(face)), `${name}: forward ADS sight channel must stay clear`);
}

assert.equal(portableBytes.readUInt32LE(0), 0x46546c67);
assert.equal(portableBytes.readUInt32LE(4), 2);
assert.equal(portableBytes.readUInt32LE(8), portableBytes.length);
assert.equal(portableBytes.readUInt32LE(16), 0x4e4f534a);
const jsonLength = portableBytes.readUInt32LE(12);
const portable = JSON.parse(portableBytes.subarray(20, 20 + jsonLength).toString());
assert.equal(portableBytes.readUInt32LE(24 + jsonLength), 0x004e4942);
const embedded = portableBytes.subarray(28 + jsonLength);
assert.ok(embedded.subarray(0, binary.length).equals(binary), 'portable and runtime geometry must be byte-identical');
for (const key of ['nodes', 'meshes', 'accessors', 'scenes', 'materials', 'textures']) {
  assert.deepEqual(portable[key], doc[key], `portable ${key} match runtime`);
}
portable.images.forEach((image, i) => {
  assert.equal(image.uri, undefined, 'portable GLB embeds every image');
  assert.equal(image.mimeType, doc.images[i].uri.endsWith('.png') ? 'image/png' : 'image/jpeg');
  const view = portable.bufferViews[image.bufferView];
  assert.ok(embedded.subarray(view.byteOffset, view.byteOffset + view.byteLength).equals(imageBytes[i]), 'portable image pixels match runtime texture');
});
assert.equal(report.geometry_sha256, crypto.createHash('sha256').update(binary).digest('hex'));
assert.equal(report.triangles, triangles);
assert.equal(report.draws, draws);
const entry = manifest.assets.find(a => a.asset === 'thunderbolt');
assert.ok(entry, 'runtime asset manifest includes TB-4');
assert.equal(entry.triangles, triangles);
assert.equal(entry.draws, draws);
console.log(JSON.stringify({ passed: true, triangles, draws, materials: doc.materials.length,
  textures: doc.images.length, usableTexturedUVs: mappedTriangles / texturedTriangles,
  portableGeometryParity: true, fourOrbs: true, dedicatedOrbSpheres: 5, sightClear: true }, null, 2));
