#!/usr/bin/env node
/**
 * ARCHER model and reload review through the real ViewmodelRig, with authoritative
 * ammo fixtures. Browser errors fail the run. Chromium is muted by cdp-session.
 *
 * node tools/archer-design-capture.mjs [--out docs/design/archer/after]
 *   [--sizes desktop,landscape,portrait] [--states full,empty,ads,fire,open,incoming,aligned,seated,latched,complete]
 *   [--no-hero] [--write-icon]
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchCdpSession } from './lib/cdp-session.mjs';
import { startServer, stopServer } from './lib/server-process.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const arg = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1] ?? fallback;
};
const outDir = path.resolve(root, arg('--out', 'docs/design/archer/after'));
const sizes = {
  desktop: { width: 1920, height: 1080, mobile: false },
  landscape: { width: 844, height: 390, mobile: true },
  portrait: { width: 390, height: 844, mobile: true },
};
const states = {
  full: { state: 'full' },
  empty: { state: 'empty' },
  ads: { state: 'locked', ads: 1 },
  fire: { state: 'full', fire: true, fireElapsed: 0.035 },
  open: { state: 'reload', reloadProgress: 0.25 },
  incoming: { state: 'reload', reloadProgress: 0.45 },
  aligned: { state: 'reload', reloadProgress: 0.62 },
  seated: { state: 'reload', reloadProgress: 0.84 },
  latched: { state: 'reload', reloadProgress: 0.94 },
  complete: { state: 'reload', reloadProgress: 1, mag: 1 },
};
const chosen = (flag, source) => {
  const names = arg(flag, Object.keys(source).join(',')).split(',').map(value => value.trim()).filter(Boolean);
  for (const name of names) if (!source[name]) throw new Error(`unknown ${flag}: ${name}`);
  return names;
};

// Run in the browser so this uses the exact same builder, material kit and THREE
// revision as gameplay. The overview has no camera-parented rig or gloves.
async function hero() {
  const THREE = await import('/js/vendor/three.module.js');
  const { buildGun } = await import('/js/guns/assemble.js');
  const { MaterialCache } = await import('/js/guns/kit.js');
  const { applyWeaponDisplay, weaponDisplayModel } = await import('/js/guns/weapon-display.js');
  const { WEAPONS } = await import('/shared/combatmath.js');
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;z-index:2000';
  document.body.append(canvas);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(innerWidth, innerHeight, false);
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.setClearColor(0x172127, 1);
  const scene = new THREE.Scene();
  const bundle = buildGun('archer', new MaterialCache());
  for (const name of ['hand_l', 'hand_r']) {
    const hand = bundle.root.getObjectByName(name);
    if (hand) hand.visible = false;
  }
  bundle.flash.grp.visible = false;
  bundle.uni.uHeat.value = 0;
  applyWeaponDisplay(bundle, 'archer', weaponDisplayModel({ wid: 'archer', mag: 1, reserve: 3,
    reloading01: null, ready01: 1, adsT01: 0, lock: 0 }, { mode: 'titanfall', lock: 0 }));
  scene.add(bundle.root);
  scene.add(new THREE.HemisphereLight(0xe3f3ff, 0x3b3329, 1.7));
  const key = new THREE.DirectionalLight(0xffe5c8, 3.5);
  key.position.set(-2, 4, -3);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x83dfff, 2.2);
  rim.position.set(3, 2, 2);
  scene.add(rim);
  bundle.root.updateMatrixWorld(true);
  const bounds = new THREE.Box3();
  bundle.root.traverseVisible(object => {
    if (!object.isMesh) return;
    object.geometry.computeBoundingBox();
    bounds.union(object.geometry.boundingBox.clone().applyMatrix4(object.matrixWorld));
  });
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const camera = new THREE.PerspectiveCamera(36, innerWidth / innerHeight, 0.01, 30);
  const extent = size.length();
  camera.position.copy(center).add(new THREE.Vector3(-1.0, 0.63, -0.87).normalize().multiplyScalar(extent * 1.40));
  camera.lookAt(center);
  renderer.render(scene, camera);
  const title = document.createElement('div');
  title.style.cssText = 'position:fixed;left:64px;top:48px;z-index:2001;color:#e6ece9;font:600 28px sans-serif;letter-spacing:4px';
  title.textContent = WEAPONS.archer.name;
  document.body.append(title);
  const subtitle = document.createElement('div');
  subtitle.style.cssText = 'position:fixed;left:64px;top:92px;z-index:2001;color:#92aab3;font:15px sans-serif;letter-spacing:2px';
  subtitle.textContent = 'IN-GAME MODEL · THREE-QUARTER VIEW';
  document.body.append(subtitle);
  return { bounds: { min: bounds.min.toArray(), max: bounds.max.toArray() }, meshes: renderer.info.render.calls };
}

// Render the inventory silhouette with the same ImageGen maps as the live model.
async function hudIcon() {
  const THREE = await import('/js/vendor/three.module.js');
  const { buildGun, disposeGunModels } = await import('/js/guns/assemble.js');
  const { MaterialCache } = await import('/js/guns/kit.js');
  const cache = new MaterialCache();
  const bundle = buildGun('archer', cache);
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setSize(480, 240);
  renderer.setClearColor(0, 0);
  renderer.toneMapping = THREE.NeutralToneMapping;
  try {
    for (const name of ['hand_l', 'hand_r']) bundle.root.getObjectByName(name).visible = false;
    bundle.flash.grp.visible = false;
    bundle.root.traverse(object => { if (object.material?.isShaderMaterial) object.visible = false; });
    bundle.root.updateMatrixWorld(true);
    const bounds = new THREE.Box3();
    bundle.root.traverseVisible(object => {
      if (!object.isMesh) return;
      object.geometry.computeBoundingBox();
      bounds.union(object.geometry.boundingBox.clone().applyMatrix4(object.matrixWorld));
    });
    const center = bounds.getCenter(new THREE.Vector3()), size = bounds.getSize(new THREE.Vector3());
    const width = Math.max(size.z, size.y * 2) * 1.06;
    const camera = new THREE.OrthographicCamera(-width / 2, width / 2, width / 4, -width / 4, 0.01, 10);
    camera.position.set(2, center.y, center.z);
    camera.lookAt(center);
    const scene = new THREE.Scene();
    scene.add(bundle.root, new THREE.HemisphereLight(0xe2edff, 0x646055, 2.0));
    const key = new THREE.DirectionalLight(0xfff0d8, 3);
    key.position.set(3, 4, -2); scene.add(key);
    renderer.render(scene, camera);
    return renderer.domElement.toDataURL('image/png').split(',')[1];
  } finally {
    renderer.dispose();
    disposeGunModels([bundle], cache);
  }
}

async function main() {
  const selectedSizes = chosen('--sizes', sizes);
  const selectedStates = chosen('--states', states);
  await mkdir(outDir, { recursive: true });
  const report = { generated: new Date().toISOString(), shots: [], errors: [] };
  const server = startServer({ entry: 'tools/capture-server.mjs', failureContext: 'ARCHER design capture' });
  let session;
  try {
    session = await launchCdpSession(`http://127.0.0.1:${await server.port}/titanfall-weapon-capture.html`, { width: 1920, height: 1080 });
    const page = session.page;
    await page.waitFor('window.__tfw?.ready === true', { timeoutMs: 90000, label: 'weapon capture page' });
    const save = async (name, size) => {
      const png = name.endsWith('.png');
      const shot = await page.send('Page.captureScreenshot', { format: png ? 'png' : 'jpeg', ...(png ? {} : { quality: 90 }),
        clip: { x: 0, y: 0, width: size.width, height: size.height, scale: 1 } });
      const file = path.join(outDir, name);
      await writeFile(file, Buffer.from(shot.data, 'base64'));
      return path.relative(root, file);
    };
    for (const sizeName of selectedSizes) {
      const size = sizes[sizeName];
      await page.send('Emulation.setDeviceMetricsOverride', { ...size, deviceScaleFactor: 1 });
      for (const stateName of selectedStates) {
        const fixture = { weapon: 'archer', touch: size.mobile, ...states[stateName] };
        const result = await page.evaluate(`window.__tfw.render(${JSON.stringify(fixture)})`);
        const file = await save(`${sizeName}-${stateName}.jpg`, size);
        report.shots.push({ ...result, size: sizeName, state: stateName, file });
        console.log(`${sizeName} ${stateName}: ammo=${result.ammo}, gate=${JSON.stringify(result.archer?.gate?.rotation)}, incoming=${result.archer?.incoming?.visible}`);
        if (stateName === 'fire' && result.fired !== true) report.errors.push(`${sizeName}: fire fixture rejected by ViewmodelRig`);
      }
    }
    if (!process.argv.includes('--no-hero')) {
      await page.send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, mobile: false, deviceScaleFactor: 1 });
      const result = await page.evaluate(`(${hero.toString()})()`);
      report.hero = { file: await save('hero.png', sizes.desktop), ...result };
    }
    if (process.argv.includes('--write-icon')) {
      const data = await page.evaluate(`(${hudIcon.toString()})()`);
      const file = path.join(root, 'public/assets/weapons/hud/archer.png');
      await writeFile(file, Buffer.from(data, 'base64'));
      report.icon = path.relative(root, file);
    }
  } catch (error) {
    report.errors.push(String(error?.stack ?? error));
  } finally {
    if (session) {
      report.errors.push(...(session.page.errors ?? []));
      await session.close();
    }
    await stopServer(server);
  }
  await writeFile(path.join(outDir, 'capture-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  if (report.errors.length) throw new Error(report.errors.join('\n'));
  console.log(`${report.shots.length} first-person captures${report.hero ? ' + hero' : ''} -> ${path.relative(root, outDir)}`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
