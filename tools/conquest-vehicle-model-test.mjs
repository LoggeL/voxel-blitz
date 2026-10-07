// Voxel vehicle pipeline (DSL, greedy mesher with AO and edge lip, class
// material) and the five Conquest hulls: draw and triangle budgets, contract
// mount rigs, seat anchors against vehicleSeats(), muzzles against the
// server's mountPose, team camouflage hue separation, wreck and fragments.
import assert from 'node:assert/strict';
import * as THREE from '../public/js/vendor/three.module.js';
import { VoxelPart, VOXEL, snap } from '../public/js/vehicles/voxel-model/dsl.js';
import { meshVoxelPart } from '../public/js/vehicles/voxel-model/mesher.js';
import { createPaletteResolver, createVehicleMaterial, setVehicleMaterialState, VEHICLE_MATERIAL_KEY, TEAM_SCHEMES, camoIndex } from '../public/js/vehicles/voxel-model/material.js';
import { createVehicleFragments, fragmentMaterial } from '../public/js/vehicles/vehicle-fragments.js';
import { VEHICLE_MODEL_FACTORIES, VehicleView } from '../public/js/engine/vehicle-view.js';
import { VEHICLE_TYPE_IDS, vehicleMountOrder } from '../shared/conquest-contract.js';
import { vehicleSeats } from '../shared/vehicle-seats.js';
import { vehicleDef, mountPose } from '../shared/vehicle-defs.js';
import { vehicleSeatPose } from '../shared/vehicles.js';
import { CHARACTER_LIGHT_KEY } from '../public/js/engine/shader-warmup.js';

// Crew avatars draw a name label on a canvas: stub only that.
globalThis.document ??= { createElement: () => ({ getContext: () => new Proxy({}, { get: (o, k) => o[k] ?? (() => {}) }) }) };

let checks = 0;
const check = (fn) => { fn(); checks++; };
const near = (a, b, tolerance, label) => assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) <= tolerance,
  `${label}: ${a.map(v => v.toFixed(3))} vs ${b.map(v => v.toFixed(3))}`);

// --- DSL ---------------------------------------------------------------------------
check(() => assert.equal(VOXEL, 0.2));
check(() => assert.equal(snap(0.31), 0.4));
const cube = new VoxelPart('cube').box([0, 0, 0], [0.6, 0.6, 0.6], 'steel');
check(() => assert.equal(cube.size, 27, '0.6 m cube = 3x3x3 voxels'));
cube.carve([0.2, 0.2, 0.2], [0.4, 0.4, 0.4]);
check(() => assert.equal(cube.size, 26, 'carve removes the core'));
cube.paint([0, 0, 0], [0.2, 0.6, 0.6], 'dark');
check(() => assert.equal([...cube.voxels()].filter(v => v[3] === 'dark').length, 9));
const half = new VoxelPart('half').box([0, 0, 0], [0.4, 0.2, 0.2], 'paint', { tag: 'door-right' }).mirrorX();
check(() => assert.equal(half.size, 4, 'mirrorX doubles the voxels'));
check(() => assert.deepEqual(half.tags().sort(), ['door-left', 'door-right'], 'mirrorX swaps left/right tags'));
const wedge = new VoxelPart('wedge').wedge([0, 0, 0], [1, 1, 1], 'paint', { from: 1, to: 0.2 });
const columnHeight = z => [...wedge.voxels()].filter(v => v[2] === z && v[0] === 0).length;
check(() => assert.ok(columnHeight(0) > columnHeight(4), 'wedge tapers along its axis'));
const cylinder = new VoxelPart('cyl', { grid: [0.1, 0, 0] }).cyl([0, 0, 0], 0.33, 0.6, 'x', 'rubber');
check(() => assert.ok(cylinder.size > 0 && cylinder.bounds().max[0] - cylinder.bounds().min[0] === 3, 'cylinder spans its length'));
const roof = new VoxelPart('roof').box([-1, 0, -1], [1, 0.2, 1], 'paint').roundel([0, 0.2, 0], 0.6, [0, 1, 0]);
check(() => assert.ok([...roof.voxels()].some(v => v[3] === 'roundel') && [...roof.voxels()].some(v => v[3] === 'ring'), 'roundel paints disc and ring'));

// --- Greedy mesher: AO, merge, winding, palette attributes ---------------------------
const resolve = createPaletteResolver('alpha');
const solid = new VoxelPart('solid').box([0, 0, 0], [0.6, 0.6, 0.6], 'steel');
const meshed = meshVoxelPart(solid, resolve);
check(() => assert.equal(meshed.triangles, 12, 'a uniform cube merges to 6 quads'));
check(() => assert.equal(meshed.glass, null));
for (const name of ['position', 'normal', 'color', 'aPal', 'aLip', 'aEdge']) check(() => assert.ok(meshed.opaque.attributes[name], `${name} attribute`));
check(() => assert.ok([...meshed.opaque.attributes.aEdge.array].every(mask => mask === 15), 'cube faces have four convex edges (lip)'));
{
  // Outward winding: every triangle's geometric normal agrees with its attribute normal.
  const g = meshed.opaque, p = g.attributes.position, n = g.attributes.normal, index = g.index.array;
  for (let t = 0; t < index.length; t += 3) {
    const [a, b, c] = [index[t], index[t + 1], index[t + 2]].map(i => new THREE.Vector3().fromBufferAttribute(p, i));
    const face = b.clone().sub(a).cross(c.clone().sub(a));
    check(() => assert.ok(face.dot(new THREE.Vector3().fromBufferAttribute(n, index[t])) > 0, 'faces wind outward'));
  }
}
const pal = meshed.opaque.attributes.aPal.array;
check(() => assert.ok(Math.abs(pal[0] - 0.5) < 1e-6 && Math.abs(pal[1] - 0.45) < 1e-6, 'steel roughness and metalness in aPal'));
// An L-shape darkens the inner corner (ambient occlusion in vertex colour).
const corner = new VoxelPart('corner').box([0, 0, 0], [0.4, 0.2, 0.2], 'steel').box([0, 0.2, 0], [0.2, 0.4, 0.2], 'steel');
const cornerMesh = meshVoxelPart(corner, resolve).opaque;
const shades = new Set(); for (let i = 0; i < cornerMesh.attributes.color.count; i++) shades.add(cornerMesh.attributes.color.getX(i).toFixed(4));
check(() => assert.ok(shades.size > 1, 'AO produces more than one shade'));
// Glass voxels mesh separately; faces between glass and opaque are culled.
const canopy = new VoxelPart('canopy').box([0, 0, 0], [0.4, 0.2, 0.2], 'paint').box([0, 0.2, 0], [0.4, 0.4, 0.2], 'glass');
const canopyMesh = meshVoxelPart(canopy, resolve);
check(() => assert.ok(canopyMesh.glass && canopyMesh.opaque, 'glass gets its own geometry'));
// Pivot: parts mesh about their pivot so rigs rotate in place.
const pivoted = meshVoxelPart(new VoxelPart('p', { pivot: [1, 1, 1] }).box([1, 1, 1], [1.2, 1.2, 1.2], 'steel'), resolve).opaque;
pivoted.computeBoundingBox();
check(() => assert.deepEqual(pivoted.boundingBox.min.toArray().map(v => +v.toFixed(6)), [0, 0, 0]));

// --- Class material --------------------------------------------------------------------
const material = createVehicleMaterial();
check(() => assert.ok(material.isMeshStandardMaterial && material.vertexColors));
check(() => assert.ok(material.customProgramCacheKey().startsWith(VEHICLE_MATERIAL_KEY)));
check(() => assert.ok(material.customProgramCacheKey().includes(CHARACTER_LIGHT_KEY), 'character light composed into the program'));
check(() => assert.equal(createVehicleMaterial({ soot: 1 }).customProgramCacheKey(), material.customProgramCacheKey(), 'one constant key per class'));
check(() => assert.equal(material.fog, true, 'hulls are fogged, aircraft included'));
{
  const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader };
  material.onBeforeCompile(shader, null);
  check(() => assert.match(shader.vertexShader, /attribute vec3 aPal;/));
  check(() => assert.match(shader.fragmentShader, /vehicleLip\(\)/));
  check(() => assert.match(shader.fragmentShader, /roughnessFactor = mix\( vVehPal\.x/));
  check(() => assert.match(shader.fragmentShader, /metalnessFactor = mix\( vVehPal\.y/));
  check(() => assert.match(shader.fragmentShader, /voxelLight|charLight/, 'character lighting patch applied first'));
  check(() => assert.equal(shader.uniforms.vehicleState, material.userData.vehicleState));
}
setVehicleMaterialState(material, { soot: 2, lamps: 0.5, burn: 0.3, nearFade: true });
check(() => assert.deepEqual(material.userData.vehicleState.value.toArray(), [1, 0.5, 0.3, 1], 'state is uniform-only and clamped'));
check(() => assert.equal(fragmentMaterial().userData.vehicleState.value.w, 1, 'fragments fade within 2.5 m of the camera'));

// Camo is deterministic and continuous in the hull frame.
check(() => assert.equal(camoIndex(TEAM_SCHEMES.alpha.body, 1.1, 0.5, -2), camoIndex(TEAM_SCHEMES.alpha.body, 1.1, 0.5, -2)));

// --- Hulls -------------------------------------------------------------------------------
const hueOf = (geometries) => {
  let x = 0, y = 0, n = 0;
  const hsl = {}, color = new THREE.Color();
  for (const geometry of geometries) {
    const c = geometry.attributes.color;
    for (let i = 0; i < c.count; i++) {
      color.setRGB(c.getX(i), c.getY(i), c.getZ(i)).getHSL(hsl);
      if (hsl.s < 0.12) continue;
      x += Math.cos(hsl.h * Math.PI * 2) * hsl.s; y += Math.sin(hsl.h * Math.PI * 2) * hsl.s; n++;
    }
  }
  return { hue: ((Math.atan2(y, x) / (Math.PI * 2)) + 1) % 1 * 360, n };
};
const summary = [];
for (const type of VEHICLE_TYPE_IDS) {
  const def = vehicleDef(type);
  const hues = {};
  for (const team of ['alpha', 'bravo']) {
    const model = VEHICLE_MODEL_FACTORIES[type]({ team });
    const { draws, triangles } = model.stats;
    check(() => assert.ok(draws <= 10, `${type} ${team}: ${draws} draws`));
    check(() => assert.ok(triangles <= 12000, `${type} ${team}: ${triangles} triangles`));
    // Draws counted by the kit match what three would actually submit.
    let meshes = 0;
    model.group.traverse(object => { if (object.isMesh) meshes++; });
    check(() => assert.equal(meshes, draws, `${type} draw count matches the scene graph`));
    // One class material per hull (glass and rotor blur aside).
    const lit = new Set();
    model.group.traverse(object => { if (object.isMesh && object.material.vertexColors && !object.material.transparent) lit.add(object.material); });
    check(() => assert.equal(lit.size, 1, `${type} uses one lit voxel material`));
    // Contract mounts: every id has a yaw node, a pitch node and a muzzle.
    const order = vehicleMountOrder(type);
    check(() => assert.deepEqual(Object.keys(model.mounts).sort(), [...order].sort(), `${type} mount keys`));
    for (const key of order) {
      const rig = model.mounts[key];
      check(() => assert.ok(rig.yawNode?.isObject3D && rig.pitchNode?.isObject3D && rig.muzzle?.isObject3D, `${type} ${key} rig`));
      check(() => assert.ok(rig.pitchNode === rig.yawNode || isDescendant(rig.pitchNode, rig.yawNode), `${type} ${key} pitch rides yaw`));
    }
    // Seat anchors within 0.15 m of the shared seat hips.
    model.group.updateMatrixWorld(true);
    const seats = vehicleSeats(type);
    check(() => assert.deepEqual(Object.keys(model.seatAnchors), seats.map(seat => seat.id)));
    const row = { type, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0, turretYaw: 0, turretPitch: 0 };
    for (const seat of seats) {
      const anchor = model.seatAnchors[seat.id].getWorldPosition(new THREE.Vector3()).toArray();
      const pose = vehicleSeatPose(row, seat.id);
      check(() => near(anchor, [pose.x, pose.y, pose.z], 0.15, `${type} ${seat.id} seat anchor`));
      check(() => near(anchor, seat.position, 0.15, `${type} ${seat.id} hip`));
    }
    if (type === 'tank') check(() => assert.equal(model.seatAnchors.commander.parent, model.turret, 'commander rides the turret ring'));
    // Emitters the FX layer relies on.
    check(() => assert.ok(model.emitters.lights.length >= 3, `${type} has light sprites`));
    check(() => assert.ok(model.emitters.fire?.length >= 1 && model.emitters.cookoff?.length >= 1));
    check(() => assert.ok(Array.isArray(model.contacts) && model.contacts.length >= 2, `${type} contact blobs per wheel or track pair`));
    if (def.countermeasure === 'flares') check(() => assert.ok(model.emitters.flares.length >= 2));
    if (def.countermeasure === 'smoke') check(() => assert.equal(model.emitters.smoke.length, 2, 'tank smoke banks'));
    // Team stripe or roundel present in the vertex colours.
    const teamColor = new THREE.Color().setHex(TEAM_SCHEMES[team].roundel);
    let found = false;
    model.group.traverse(object => {
      const c = object.geometry?.attributes?.color;
      if (!c || found) return;
      for (let i = 0; i < c.count && !found; i++) {
        if (Math.abs(c.getX(i) / Math.max(1e-3, c.getY(i)) - teamColor.r / Math.max(1e-3, teamColor.g)) < 0.05 && c.getZ(i) > 0) found = true;
      }
    });
    check(() => assert.ok(found, `${type} ${team} carries its roundel colour`));
    // Wreck geometry drops the break-away tags; fragments come out posed.
    const sources = model.fragmentSources();
    check(() => assert.ok(sources.length >= 2, `${type} has break-away chunks`));
    const pieces = createVehicleFragments(model, { maxPieces: 64 });
    check(() => assert.equal(pieces.length, sources.length));
    const expectedOrder = sources.map((source, index) => ({ source, index }))
      .sort((a, b) => b.source.priority - a.source.priority || a.index - b.index).map(entry => entry.source.tag);
    check(() => assert.deepEqual(pieces.map(piece => piece.name), expectedOrder, 'highest priority first'));
    check(() => assert.ok(pieces.every(piece => piece.object.material === fragmentMaterial())));
    const capped = createVehicleFragments(model, { maxPieces: 2 });
    check(() => assert.equal(capped.length, 2));
    let intactTriangles = 0, wreckTriangles = 0;
    model.group.traverse(o => { if (o.isMesh && o.visible && o.geometry.userData.vehicleVoxel && !o.isInstancedMesh) intactTriangles += o.geometry.userData.triangles; });
    model.setWreck(true);
    model.group.traverse(o => { if (o.isMesh && o.visible && o.geometry.userData.vehicleVoxel && !o.isInstancedMesh) wreckTriangles += o.geometry.userData.triangles; });
    check(() => assert.ok(wreckTriangles < intactTriangles, `${type} wreck loses its break-away parts`));
    model.setWreck(false);
    let restored = 0;
    model.group.traverse(o => { if (o.isMesh && o.visible && o.geometry.userData.vehicleVoxel && !o.isInstancedMesh) restored += o.geometry.userData.triangles; });
    check(() => assert.equal(restored, intactTriangles, 'respawn restores the cached intact geometry'));
    // Camo hue of the hull body.
    const body = [];
    model.group.traverse(o => { if (o.isMesh && !o.isInstancedMesh && o.geometry.attributes.color && !o.material.transparent) body.push(o.geometry); });
    hues[team] = hueOf(body);
    if (team === 'alpha') summary.push(`${type} ${draws}d/${triangles}t`);
  }
  const delta = Math.abs(hues.alpha.hue - hues.bravo.hue);
  check(() => assert.ok(Math.min(delta, 360 - delta) >= 25, `${type} WEST ${hues.alpha.hue.toFixed(0)} vs EAST ${hues.bravo.hue.toFixed(0)} deg`));
  check(() => assert.ok(hues.alpha.hue > 55 && hues.alpha.hue < 140, `${type} WEST reads woodland green (${hues.alpha.hue.toFixed(0)})`));
  check(() => assert.ok(hues.bravo.hue > 15 && hues.bravo.hue < 50, `${type} EAST reads desert tan (${hues.bravo.hue.toFixed(0)})`));
}

function isDescendant(node, ancestor) {
  for (let p = node.parent; p; p = p.parent) if (p === ancestor) return true;
  return false;
}

// --- Rendered muzzles agree with the server's mountPose ---------------------------------
const view = new VehicleView();
const rows = VEHICLE_TYPE_IDS.map((type, i) => {
  const order = vehicleMountOrder(type), def = vehicleDef(type);
  const yaw = 0.6 + i * 0.3;
  return { id: `${type}-1`, type, team: i % 2 ? 'bravo' : 'alpha', x: i * 20, y: 12, z: -5, yaw, pitch: 0, roll: 0, hp: def.hp,
    turretYaw: yaw + 0.8, turretPitch: 0.1,
    mounts: order.map((key, index) => {
      const mount = def.mounts[key.split(':')[1]];
      const centre = mount.yawLimit ? mount.yawLimit[0] : 0;
      return [yaw + centre + 0.3 - index * 0.1, 0.12, 1, 0, 0];
    }) };
});
view.sync(rows, [], null);
view.update(1 / 60, null);
for (const row of rows) {
  const def = vehicleDef(row.type);
  for (const key of vehicleMountOrder(row.type)) {
    const [seatId, mountId] = key.split(':');
    const sides = def.mounts[mountId].sides?.length || 1;
    for (let side = 0; side < sides; side++) {
      const rendered = view.mountWorldPose(row.id, key, { side });
      const server = mountPose(row, seatId, mountId, { side });
      check(() => near(rendered.origin, server.origin, 0.15, `${row.type} ${key}#${side} muzzle`));
      if (!def.mounts[mountId].fixed) check(() => assert.ok(rendered.dir.reduce((s, v, i) => s + v * server.dir[i], 0) > 0.995, `${row.type} ${key} barrel direction`));
    }
  }
}
view.dispose();

console.log(`Vehicle models: ${checks} checks passed (${summary.join(', ')}).`);
