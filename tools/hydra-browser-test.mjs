import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { startServer, stopServer } from './lib/server-process.mjs';
import { launchCdpSession } from './lib/cdp-session.mjs';

// Node model tests use the procedural fallback. This regression deliberately loads
// the shipped glTF in Chromium and measures a vertex on the visible barrel itself.
const out = path.resolve('docs/design/blender/hydra/captures');
const server = startServer({ entry: 'tools/capture-server.mjs', failureContext: 'HYDRA browser regression' });
let browser;

async function checkImportedHydra() {
  const THREE = await import('/js/vendor/three.module.js');
  const { buildGun, disposeGunModels } = await import('/js/guns/assemble.js');
  const { MaterialCache } = await import('/js/guns/kit.js');
  const { animateHeavyWeapon } = await import('/js/guns/heavy-weapon-animation.js');
  const { ViewmodelRig } = await import('/js/guns/viewmodel.js');
  const { AvatarWeaponModel } = await import('/js/avatar/avatar-weapon.js');
  const { fwdFromAngles } = await import('/js/util/look.js');
  const must = (value, message) => { if (!value) throw new Error(message); };
  const close = (a, b, message) => must(Math.abs(a - b) < 1e-6, message);
  const meshes = (root) => {
    const result = [];
    root.traverseVisible(object => { if (object.isMesh) result.push(object); });
    return result;
  };
  const mats = (root, predicate) => [...new Set(meshes(root)
    .flatMap(mesh => [].concat(mesh.material || [])).filter(predicate))];
  const materialRoles = (root) => ({
    thermal: mats(root, material => material.userData.thermal),
    lamps: mats(root, material => Number.isFinite(material.userData.heatIndicator))
      .sort((a, b) => a.userData.heatIndicator - b.userData.heatIndicator),
  });
  const barrelsOf = (body) => {
    must(body.userData.blenderAsset === 'hydra', 'HYDRA must load from glTF, never use the procedural fallback');
    const rotor = body.getObjectByName('minigun_rotor');
    must(rotor, 'HYDRA has the runtime rotor pivot');
    const barrelMeshes = meshes(rotor).filter(mesh => mesh.userData.rotorKind === 'barrel'
      || /^minigun_barrel_[0-5](?:_|$)/.test(mesh.name));
    const indices = new Set(barrelMeshes.map(mesh => mesh.name.match(/minigun_barrel_([0-5])/)[1]));
    must(indices.size === 6, 'all six separately authored barrel meshes are visible children of the rotor');
    must(barrelMeshes.every(mesh => mesh.geometry.attributes.position.count > 20), 'the rotating barrels contain real geometry');
    return { rotor, barrels: barrelMeshes };
  };
  const vertex = (mesh) => mesh.localToWorld(new THREE.Vector3().fromBufferAttribute(mesh.geometry.attributes.position, 0));
  const cache = new MaterialCache();
  const gun = buildGun('minigun', cache), coldGun = buildGun('minigun', cache);
  const rig = new ViewmodelRig(new THREE.PerspectiveCamera(75, 16 / 9, 0.01, 100));
  const aimCamera = new THREE.PerspectiveCamera(75, 16 / 9, 0.01, 100);
  aimCamera.rotation.order = 'YXZ';
  const aimRig = new ViewmodelRig(aimCamera);
  const remote = new AvatarWeaponModel();
  try {
    const { rotor, barrels } = barrelsOf(gun.body);
    close(rotor.position.x, 0, 'rotor x aligns with bore');
    close(rotor.position.y, gun.T.muzzle[1], 'rotor y aligns with authoritative muzzle');
    const receiver = meshes(gun.body).find(mesh => !meshes(rotor).includes(mesh)
      && ![].concat(mesh.material).some(material => material.isShaderMaterial || Number.isFinite(material.userData.heatIndicator)));
    must(receiver, 'fixed receiver has visible geometry');
    gun.root.updateMatrixWorld(true);
    const before = vertex(barrels[0]), fixedBefore = vertex(receiver);
    const center = rotor.getWorldPosition(new THREE.Vector3());
    must(Math.hypot(before.x - center.x, before.y - center.y) > 0.035, 'sampled barrel vertex lies off the rotation axis');
    animateHeavyWeapon(gun.body, { dt: 0.1, minigun: { spin: 1, heat: 0 } });
    gun.root.updateMatrixWorld(true);
    const after = vertex(barrels[0]);
    must(after.distanceTo(before) > 0.03, 'visible barrel geometry moves when the rotor spins');
    close(after.z, before.z, 'barrel rotates around the bore rather than orbiting lengthwise');
    close(Math.hypot(after.x - center.x, after.y - center.y),
      Math.hypot(before.x - center.x, before.y - center.y), 'barrel rotation preserves radius');
    must(vertex(receiver).distanceTo(fixedBefore) < 1e-8, 'receiver stays fixed while the barrels turn');
    close(rotor.rotation.z, 4.2, 'rotor uses full elapsed frame time');
    animateHeavyWeapon(gun.body, { dt: 0.25, minigun: { spin: 0, heat: 0 } });
    gun.root.updateMatrixWorld(true);
    must(vertex(barrels[0]).distanceTo(after) < 1e-8, 'spin zero stops actual barrel geometry');

    const hot = materialRoles(gun.body), cold = materialRoles(coldGun.body);
    must(hot.thermal.length > 0 && hot.lamps.length === 5, 'imported barrels and five heat cells have animation materials');
    must(hot.thermal.every(material => !cold.thermal.includes(material)), 'each gun owns its thermal materials');
    must(new Set(hot.lamps).size === 5, 'each temperature cell owns its threshold material');
    animateHeavyWeapon(coldGun.body, { minigun: { spin: 0, heat: 0 } });
    animateHeavyWeapon(gun.body, { minigun: { spin: 0, heat: 0.82 } });
    must(hot.thermal.every(material => material.emissiveIntensity > 1), 'authoritative heat warms actual barrel material');
    must(hot.lamps.filter(material => material.emissiveIntensity > 1).length === 4, 'heat 0.82 lights four of five cells');
    must(cold.thermal.every(material => material.emissiveIntensity === 0)
      && cold.lamps.every(material => material.emissiveIntensity < 0.1), 'heating one gun leaves the second gun cold');
    animateHeavyWeapon(gun.body, { minigun: { spin: 0, heat: 1, overheated: true } });
    must(hot.lamps.every(material => material.emissiveIntensity > 1 && material.emissive.getHex() === 0xff3020), 'overheat lights all cells red');
    animateHeavyWeapon(gun.body, { minigun: { spin: 0, heat: 0 } });
    must(hot.thermal.every(material => material.emissiveIntensity === 0)
      && hot.lamps.every(material => material.emissiveIntensity < 0.1), 'cooling clears barrel emission and temperature cells');
    must(!meshes(gun.body).some(mesh => mesh.geometry.type === 'CylinderGeometry'
      && [].concat(mesh.material).some(material => material.isShaderMaterial)), 'no central procedural heat sleeve floats between the real barrels');
    must(!meshes(gun.bolt).some(mesh => [].concat(mesh.material).some(material => material.isShaderMaterial)),
      'no generic glowing bolt cap floats behind the rotary receiver');

    rig.setWeapon('minigun');
    const local = barrelsOf(rig._cur.body);
    rig.setMinigun({ spin: 1, heat: 0.82 });
    rig.update(0.1);
    close(local.rotor.rotation.z, 4.2, 'ViewmodelRig drives the imported rotor');
    must(materialRoles(rig._cur.body).thermal.every(material => material.emissiveIntensity > 1), 'ViewmodelRig drives imported heat');
    remote.update({ weapon: 'minigun', minigun: { spin: 0.5, heat: 0.4 }, dt: 0.1 });
    const avatar = barrelsOf(remote._model.body);
    close(avatar.rotor.rotation.z, 2.1, 'AvatarWeaponModel drives the same imported rotor at authoritative spin');
    const avatarHeat = materialRoles(remote._model.body);
    must(avatarHeat.lamps.filter(material => material.emissiveIntensity > 1).length === 2, 'remote heat controls its own two cells');
    remote.update({ weapon: 'minigun', minigun: { spin: 0, heat: 0 }, dt: 0.1 });
    close(avatar.rotor.rotation.z, 2.1, 'remote spin zero stops the rotor');
    must(materialRoles(rig._cur.body).thermal.every(material => material.emissiveIntensity > 1), 'remote cooling leaves local hot barrels intact');
    // Check the real exported barrel end rings against the same angles used by
    // ballistics. A turning rotor alone cannot detect a cosmetically yawed gun.
    aimRig.setWeapon('minigun');
    const aimed = barrelsOf(aimRig._cur.body);
    const barrelEnds = aimed.barrels.map(mesh => {
      const positions = mesh.geometry.attributes.position;
      mesh.geometry.computeBoundingBox();
      const { min, max } = mesh.geometry.boundingBox;
      must(max.z - min.z > 0.4, 'authored barrel has distinct front and rear end rings');
      const front = new THREE.Vector3(), rear = new THREE.Vector3();
      const frontVertices = new Map(), rearVertices = new Map();
      for (let i = 0; i < positions.count; i++) {
        const point = new THREE.Vector3().fromBufferAttribute(positions, i);
        const key = point.toArray().map(value => value.toFixed(7)).join(',');
        if (Math.abs(point.z - min.z) < 1e-6) frontVertices.set(key, point);
        if (Math.abs(point.z - max.z) < 1e-6) rearVertices.set(key, point);
      }
      must(frontVertices.size >= 6 && rearVertices.size >= 6, 'barrel direction is measured from visible end-ring vertices');
      for (const point of frontVertices.values()) front.add(point);
      for (const point of rearVertices.values()) rear.add(point);
      return { mesh, front: front.divideScalar(frontVertices.size), rear: rear.divideScalar(rearVertices.size) };
    });
    const barrelAlignment = [];
    for (const ads of [0, 0.5, 1]) {
      aimRig.ads(ads);
      for (const [name, cameraYaw, cameraPitch] of [['level', 0, 0], ['up-turned', 1.2, Math.PI / 3], ['down-turned', -0.8, -Math.PI / 3]]) {
        aimCamera.rotation.set(cameraPitch, cameraYaw, 0);
        const shotYaw = cameraYaw + 0.15, shotPitch = cameraPitch - 0.11;
        const ctx = { grounded: true, aimSwayScale: 0, reducedMotion: true, shotYaw, shotPitch };
        for (let frame = 0; frame < 180; frame++) aimRig.update(1 / 60, ctx);
        aimCamera.updateMatrixWorld(true);
        const expected = new THREE.Vector3().copy(fwdFromAngles(shotYaw, shotPitch));
        const barrelError = Math.max(...barrelEnds.map(({ mesh, front, rear }) =>
          mesh.localToWorld(front.clone()).sub(mesh.localToWorld(rear.clone())).normalize().angleTo(expected)));
        const muzzleError = new THREE.Vector3(0, 0, -1)
          .transformDirection(aimRig._cur.muzzleMarker.matrixWorld).angleTo(expected);
        barrelAlignment.push({ ads, camera: name, barrelErrorDegrees: THREE.MathUtils.radToDeg(barrelError),
          muzzleErrorDegrees: THREE.MathUtils.radToDeg(muzzleError) });
      }
    }
    must(barrelAlignment.every(sample => sample.barrelErrorDegrees < 0.001 && sample.muzzleErrorDegrees < 0.001),
      `visible barrel and muzzle axes must follow the authoritative shot ray: ${JSON.stringify(barrelAlignment)}`);
    return { asset: gun.body.userData.blenderAsset, visibleBarrels: barrels.length,
      rotorChildren: meshes(rotor).length, barrelVertexBefore: before.toArray(), barrelVertexAfter: after.toArray(),
      barrelVertexTravel: before.distanceTo(after), fixedReceiverTravel: vertex(receiver).distanceTo(fixedBefore),
      localRotorRadians: local.rotor.rotation.z, remoteRotorRadians: avatar.rotor.rotation.z,
      thermalMaterials: hot.thermal.length, heatIndicators: hot.lamps.length, barrelAlignment };
  } finally {
    rig.dispose(); aimRig.dispose(); remote.dispose(); disposeGunModels([gun, coldGun], cache);
  }
}

async function installCaptureHarness() {
  const THREE = await import('/js/vendor/three.module.js');
  const { ViewmodelRig } = await import('/js/guns/viewmodel.js');
  const { buildGun, disposeGunModels } = await import('/js/guns/assemble.js');
  const { MaterialCache } = await import('/js/guns/kit.js');
  const { animateHeavyWeapon } = await import('/js/guns/heavy-weapon-animation.js');
  const { WEAPONS } = await import('/shared/combatmath.js');
  document.body.replaceChildren();
  document.body.style.cssText = 'margin:0;overflow:hidden';
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  document.body.append(renderer.domElement);
  let cleanup = () => {};
  const pose = { speed: 0, grounded: true, aimSwayScale: 0 };
  const lights = (scene) => {
    scene.add(new THREE.HemisphereLight(0xd4e6ff, 0x3c332c, 1.25));
    for (const [color, power, position] of [[0xffedd8, 2.4, [3, 5, -4]], [0x84baff, 1.4, [-3, 2, 1]]]) {
      const light = new THREE.DirectionalLight(color, power);
      light.position.set(...position); scene.add(light);
    }
  };
  const metrics = (model, camera, arms = null) => {
    model.root.updateMatrixWorld(true); camera.updateMatrixWorld(true);
    const rotor = model.body.getObjectByName('minigun_rotor');
    let finite = true, inFrameRotorVertices = 0;
    const rayTargets = [], heatCells = [];
    model.root.traverse(part => { finite &&= part.matrixWorld.elements.every(Number.isFinite); });
    model.root.traverseVisible(part => {
      if (!part.isMesh) return;
      const materials = [].concat(part.material || []);
      if (materials.some(material => Number.isFinite(material.userData.heatIndicator))) heatCells.push(part);
      if (!materials.every(material => material.transparent || material.isShaderMaterial)) rayTargets.push(part);
    });
    rotor.traverseVisible(part => {
      if (!part.isMesh) return;
      const positions = part.geometry.attributes.position;
      for (let i = 0; i < positions.count; i += 12) {
        const projected = part.localToWorld(new THREE.Vector3().fromBufferAttribute(positions, i)).project(camera);
        if (Math.abs(projected.x) <= 1 && Math.abs(projected.y) <= 1 && Math.abs(projected.z) <= 1) inFrameRotorVertices++;
      }
    });
    const heatCellVisibility = heatCells.map(cell => {
      cell.geometry.computeBoundingBox();
      const center = cell.localToWorld(cell.geometry.boundingBox.getCenter(new THREE.Vector3()));
      const projected = center.clone().project(camera);
      const inFrame = Math.abs(projected.x) <= 1 && Math.abs(projected.y) <= 1 && Math.abs(projected.z) <= 1;
      const positions = cell.geometry.attributes.position;
      let fullyInFrame = true;
      for (let i = 0; i < positions.count; i++) {
        const point = cell.localToWorld(new THREE.Vector3().fromBufferAttribute(positions, i)).project(camera);
        fullyInFrame &&= Math.abs(point.x) <= 1 && Math.abs(point.y) <= 1 && Math.abs(point.z) <= 1;
      }
      const ray = new THREE.Raycaster(); ray.setFromCamera(new THREE.Vector2(projected.x, projected.y), camera);
      const hit = ray.intersectObjects(rayTargets, false)[0];
      return { name: cell.name, inFrame, fullyInFrame, visible: inFrame && hit?.object === cell,
        projectedCenter: projected.toArray(),
        occluder: hit && hit.object !== cell ? hit.object.name : null };
    });
    const cameraBounds = (root) => {
      if (!root) return null;
      const bounds = new THREE.Box3();
      let nearPlaneMeshes = 0, eyePlaneMeshes = 0;
      root.traverseVisible(part => {
        if (!part.isMesh) return;
        part.geometry.computeBoundingBox();
        const local = part.geometry.boundingBox.clone()
          .applyMatrix4(camera.matrixWorldInverse.clone().multiply(part.matrixWorld));
        bounds.union(local);
        if (local.min.z < -camera.near && local.max.z > -camera.near) nearPlaneMeshes++;
        if (local.min.z < 0 && local.max.z > 0) eyePlaneMeshes++;
      });
      return { min: bounds.min.toArray(), max: bounds.max.toArray(), nearPlaneMeshes, eyePlaneMeshes };
    };
    const sightRay = new THREE.Raycaster(); sightRay.setFromCamera(new THREE.Vector2(0, 0), camera);
    const sightHit = sightRay.intersectObjects(rayTargets, false)[0];
    const sightBlocker = sightHit?.object.name || null;
    return { asset: model.body.userData.blenderAsset, finite, cameraFov: camera.fov ?? null, inFrameRotorVertices, heatCellVisibility,
      armCameraBounds: cameraBounds(arms), attachmentCameraBounds: cameraBounds(model.attachmentGroup), sightBlocker,
      sightHit: sightHit ? { name: sightHit.object.name, geometry: sightHit.object.geometry.type,
        localPoint: model.root.worldToLocal(sightHit.point.clone()).toArray() } : null,
      rotorRadians: rotor.rotation.z, drawCalls: renderer.info.render.calls, triangles: renderer.info.render.triangles };
  };
  window.__hydraCapture = (options) => {
    cleanup(); cleanup = () => {};
    renderer.setSize(options.width, options.height);
    const scene = new THREE.Scene(); scene.background = new THREE.Color(0x263542); lights(scene);
    let camera, model, arms = null;
    if (options.kind === 'viewmodel') {
      const weaponDef = WEAPONS.minigun;
      const framePose = { ...pose, weaponDef };
      camera = new THREE.PerspectiveCamera(options.state === 'scoped' ? weaponDef.adsFov : 75,
        options.width / options.height, 0.01, 100);
      camera.position.set(0, 1.62, 0); scene.add(camera);
      const fill = new THREE.PointLight(0xfff1dc, 2.4, 3.5, 1.4);
      fill.position.set(-0.35, 0.45, 0.25); camera.add(fill);
      const rig = new ViewmodelRig(camera); rig.setWeapon('minigun'); model = rig._cur;
      arms = rig._arms.root;
      rig.ads(options.state === 'scoped' ? 1 : 0);
      for (let i = 0; i < 300; i++) rig.update(1 / 60, framePose);
      if (options.state === 'firing') {
        rig.setMinigun({ spin: 1, heat: 0.82 });
        if (!rig.fire()) throw new Error('settled HYDRA viewmodel must fire');
        rig.update(1 / 60, framePose);
      }
      if (options.state.startsWith('reload-')) {
        rig.reload(1, 'magswap');
        const frames = options.state === 'reload-eject' ? 80 : 192;
        for (let i = 0; i < frames; i++) rig.update(0.005, framePose);
      }
      const target = new THREE.Mesh(new THREE.RingGeometry(0.16, 0.20, 24), new THREE.MeshBasicMaterial({ color: 0xffa031 }));
      target.position.set(0, 1.62, -8); scene.add(target);
      cleanup = () => { rig.dispose(); target.geometry.dispose(); target.material.dispose(); };
    } else {
      const cache = new MaterialCache(); model = buildGun('minigun', cache);
      for (const name of ['hand_l', 'hand_r']) {
        const hand = model.root.getObjectByName(name); if (hand) hand.visible = false;
      }
      animateHeavyWeapon(model.body, { dt: options.spinSeconds || 0,
        minigun: { spin: options.spinSeconds ? 1 : 0, heat: options.heat || 0, overheated: options.heat === 1 } });
      scene.add(model.root); model.root.updateMatrixWorld(true);
      const bounds = new THREE.Box3();
      model.root.traverseVisible(object => {
        if (!object.isMesh || [].concat(object.material).every(material => material.transparent || material.isShaderMaterial)) return;
        object.geometry.computeBoundingBox();
        bounds.union(object.geometry.boundingBox.clone().applyMatrix4(object.matrixWorld));
      });
      const center = bounds.getCenter(new THREE.Vector3());
      const front = options.angle === 'rotor';
      const half = front ? 0.18 : 0.49;
      camera = new THREE.OrthographicCamera(-half * options.width / options.height,
        half * options.width / options.height, half, -half, 0.01, 10);
      if (front) {
        camera.position.set(0.08, 0.10, -2.0); camera.lookAt(0, 0.055, -0.72);
      } else {
        camera.position.copy(center).add(new THREE.Vector3(1.4, 0.60, -1.25)); camera.lookAt(center);
      }
      scene.add(camera);
      cleanup = () => disposeGunModels([model], cache);
    }
    window.__hydraAdvance = (dt, minigun) => {
      animateHeavyWeapon(model.body, { dt, minigun });
      renderer.render(scene, camera);
      return metrics(model, camera, arms);
    };
    renderer.render(scene, camera); renderer.render(scene, camera);
    return metrics(model, camera, arms);
  };
}

try {
  await mkdir(out, { recursive: true });
  const base = `http://127.0.0.1:${await server.port}`;
  browser = await launchCdpSession(`${base}/weapon-capture.html?weapon=minigun&state=held`, { width: 1600, height: 900 });
  const page = browser.page;
  await page.send('Network.enable');
  // Reload after CDP attaches so an early module exception cannot be missed.
  await page.send('Page.reload');
  try {
    await page.waitFor(`document.documentElement.dataset.captureReady === 'true'`, { timeoutMs: 30000 });
  } catch (error) {
    const failedRequests = page.events.filter(event => event.method === 'Network.loadingFailed'
      || event.method === 'Network.responseReceived' && event.params.response.status >= 400)
      .map(event => event.method === 'Network.loadingFailed'
        ? event.params.errorText : `${event.params.response.status} ${event.params.response.url}`);
    throw new Error(`${error.message}\n${[...page.errors, ...failedRequests].join('\n')}`, { cause: error });
  }
  const report = { dynamic: await page.evaluate(`(${checkImportedHydra.toString()})()`), captures: {} };
  await page.evaluate(`(${installCaptureHarness.toString()})()`);
  const capture = async (name, options) => {
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: options.width, height: options.height, deviceScaleFactor: 1, mobile: options.width < 500,
    });
    const result = await page.evaluate(`window.__hydraCapture(${JSON.stringify(options)})`);
    assert.equal(result.asset, 'hydra', `${name}: uses authored asset`);
    assert.equal(result.finite, true, `${name}: finite transforms`);
    assert.ok(result.inFrameRotorVertices > 0, `${name}: actual rotor projects into the frame`);
    const screenshot = await page.send('Page.captureScreenshot', { format: 'png' });
    const bytes = Buffer.from(screenshot.data, 'base64');
    assert.ok(bytes.length > 10000, `${name}: rendered screenshot`);
    await writeFile(path.join(out, `${name}.png`), bytes);
    report.captures[name] = { ...options, ...result, bytes: bytes.length };
    if (options.kind === 'viewmodel' && ['held', 'firing', 'scoped'].includes(options.state)) {
      assert.equal(result.heatCellVisibility.filter(cell => cell.visible && cell.fullyInFrame).length, 5,
        `${name}: all five temperature cells are in frame and unoccluded: ${JSON.stringify(result.heatCellVisibility)}`);
    }
    if (options.kind === 'viewmodel' && options.state === 'scoped') {
      assert.equal(result.sightHit, null, `${name}: braced aim keeps the center target clear`);
      const mildZoomFov = 2 * Math.atan(Math.tan(75 * Math.PI / 360) / 1.15) * 180 / Math.PI;
      assert.ok(Math.abs(result.cameraFov - mildZoomFov) < 1e-6, `${name}: braced aim uses the 1.15x camera zoom`);
    }
    assert.ok(result.triangles > 1000, `${name}: substantial model geometry rendered`);
  };
  const viewports = [{ name: 'desktop', width: 1600, height: 900 }, { name: 'mobile', width: 390, height: 844 }];
  for (const viewport of viewports) {
    for (const state of ['held', 'scoped', 'firing', 'reload-eject', 'reload-charge']) {
      await capture(`${viewport.name}-${state}`, { ...viewport, kind: 'viewmodel', state });
    }
  }
  for (const [name, angle, heat, spinSeconds] of [
    ['hero-cold', 'hero', 0, 0], ['hero-hot', 'hero', 1, 0],
    ['rotor-idle', 'rotor', 0, 0], ['rotor-spinning', 'rotor', 0, 0.017],
  ]) await capture(name, { width: 1400, height: 900, kind: 'model', angle, heat, spinSeconds });
  // Optional review artifact: actual browser renders, using the same runtime
  // animator as the dynamic checks. Frames stay outside the delivered docs.
  if (process.env.HYDRA_CAPTURE_ANIMATION === '1') {
    const frameDir = path.resolve('.artifacts/hydra-rotor-frames');
    await mkdir(frameDir, { recursive: true });
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: 960, height: 640, deviceScaleFactor: 1, mobile: false,
    });
    await page.evaluate(`window.__hydraCapture({width:960,height:640,kind:'model',angle:'hero',heat:0.65})`);
    const samples = [];
    for (let frame = 0; frame < 48; frame++) {
      const spin = Math.min(1, frame / 18);
      const sample = await page.evaluate(`window.__hydraAdvance(${frame ? 1 / 24 : 0}, {spin:${spin},heat:0.65})`);
      samples.push({ frame, spin, angle: sample.rotorRadians });
      const shot = await page.send('Page.captureScreenshot', { format: 'png' });
      await writeFile(path.join(frameDir, `${String(frame).padStart(3, '0')}.png`), Buffer.from(shot.data, 'base64'));
    }
    const encode = promisify(execFile);
    const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
    const input = path.join(frameDir, '%03d.png');
    await encode(ffmpeg, ['-y', '-loglevel', 'error', '-framerate', '24', '-i', input,
      '-frames:v', '48', '-c:v', 'libx264', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
      path.join(out, 'rotor-preview.mp4')]);
    await encode(ffmpeg, ['-y', '-loglevel', 'error', '-framerate', '24', '-i', input,
      '-filter_complex', 'split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer',
      '-frames:v', '48', '-loop', '0', path.join(out, 'rotor-preview.gif')]);
    report.animation = { frames: 48, fps: 24, seconds: 2, heat: 0.65, samples };
  }
  assert.deepEqual(page.errors, [], 'browser must have no runtime errors');
  await writeFile(path.join(out, 'browser-validation.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close(); await stopServer(server);
}
