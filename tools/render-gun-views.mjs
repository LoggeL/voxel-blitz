// Inspection renders of a built first-person gun under the game's sky environment.
//   node tools/render-gun-views.mjs --weapon doppler [--out dir] [--views hip,left,ads] [--hands] [--lod world]
// Builds the real runtime bundle (buildGun) inside weapon-capture.html through the muted
// CDP session, so it shows exactly the geometry, maps and materials a match renders;
// `--mag n` and `--stroke 0..1` drive DOPPLER's presentation for stills.
import fs from 'node:fs';
import path from 'node:path';
import { startServer, stopServer } from './lib/server-process.mjs';
import { launchCdpSession } from './lib/cdp-session.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const index = args.indexOf(`--${name}`);
  return index < 0 ? fallback : args[index + 1] ?? true;
};
const weapon = flag('weapon', 'doppler');
const outDir = path.resolve(flag('out', `.artifacts/gun-views/${weapon}`));
const hands = args.includes('--hands');
const mag = flag('mag');
const stroke = flag('stroke');
const lod = flag('lod');
// Gun space: +x right, +y up, -z muzzle. `hip` is the first-person eye (minus HIP in models/common.js).
const VIEWS = {
  hip: { eye: [-0.22, 0.24, 0.45], at: [-0.22, 0.24, -1], fov: 75 },
  left: { eye: [-1.25, 0.06, -0.2], at: [0, 0.02, -0.2], fov: 42 },
  right: { eye: [1.25, 0.06, -0.2], at: [0, 0.02, -0.2], fov: 42 },
  hero: { eye: [-0.62, 0.3, -1.0], at: [0, 0.01, -0.2], fov: 42 },
  rear: { eye: [-0.46, 0.3, 0.72], at: [0, 0.03, -0.14], fov: 42 },
  top: { eye: [0, 1.3, -0.19], at: [0, 0, -0.2], fov: 42, up: [0, 0, -1] },
  below: { eye: [-0.2, -1.1, -0.2], at: [0, 0, -0.2], fov: 42, up: [0, 0, -1] },
  mech: { eye: [-0.32, 0.12, 0.03], at: [0, 0.045, -0.1], fov: 30 },
  mag: { eye: [-0.36, -0.06, -0.46], at: [0, -0.09, -0.215], fov: 30 },
  muzzle: { eye: [-0.2, 0.12, -0.86], at: [0, 0.035, -0.6], fov: 30 },
  ads: { eye: [0, 0.142, 0.3], at: [0, 0.142, -1], fov: 40 },
  eyepiece: { eye: [0, 0.142, 0.02], at: [0, 0.142, -1], fov: 40 },
};
const views = String(flag('views', 'hip,hero,left,right,rear')).split(',').filter(name => VIEWS[name]);
fs.mkdirSync(outDir, { recursive: true });
const server = startServer({ entry: 'tools/capture-server.mjs' });
let browser;
try {
  browser = await launchCdpSession(`http://127.0.0.1:${await server.port}/weapon-capture.html?weapon=rifle&state=held`);
  await browser.page.waitFor(`document.documentElement.dataset.captureReady === 'true'`, { timeoutMs: 30000 });
  const result = await browser.page.evaluate(`(async () => {
    const T = await import('/js/vendor/three.module.js');
    const { buildGun, disposeGunModels } = await import('/js/guns/assemble.js');
    const { MaterialCache } = await import('/js/guns/kit.js');
    const { bakeEnvironment } = await import('/js/engine/environment-map.js');
    const cache = new MaterialCache(), gun = buildGun(${JSON.stringify(weapon)}, cache, { lod: ${JSON.stringify(lod)} }), root = gun.root;
    if (!${hands}) for (const name of ['hand_l', 'hand_r']) { const hand = root.getObjectByName(name); if (hand) hand.visible = false; }
    const doppler = gun.extra.userData.doppler;
    if (doppler) {
      const { dopplerPresentationFor } = await import('/js/guns/doppler-presentation.js');
      const show = dopplerPresentationFor(gun);
      if (${JSON.stringify(mag)} !== null) show.setMag(Number(${JSON.stringify(mag)}), 30);
      if (${JSON.stringify(stroke)} !== null) show._apply(Number(${JSON.stringify(stroke)}));
    }
    const renderer = new T.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setSize(1600, 900);
    renderer.outputColorSpace = T.SRGBColorSpace;
    const scene = new T.Scene();
    scene.background = new T.Color(0x39424d);
    // The DEFAULT daylight palette of engine/map-atmosphere.js, so brightness reads as in a match.
    const sunDir = new T.Vector3(60, 90, 20).normalize();
    const env = bakeEnvironment(renderer, { skyTop: 0x397fc4, skyHorizon: 0xb3ddf5, groundLight: 0x6e7775, sun: 0xfff9f0, sunDisc: 1 }, sunDir);
    scene.environment = env?.texture ?? null;
    scene.environmentIntensity = 0.45;
    const sun = new T.DirectionalLight(0xfff9f0, 1.35); sun.position.copy(sunDir).multiplyScalar(4); scene.add(sun);
    scene.add(new T.HemisphereLight(0xd2e5fa, 0x6e7775, 0.78));
    scene.add(root);
    root.updateMatrixWorld(true);
    const out = {};
    const VIEWS = ${JSON.stringify(Object.fromEntries(views.map(name => [name, VIEWS[name]])))};
    for (const [name, view] of Object.entries(VIEWS)) {
      const camera = new T.PerspectiveCamera(view.fov, 16 / 9, 0.01, 20);
      camera.position.fromArray(view.eye);
      if (view.up) camera.up.fromArray(view.up);
      camera.lookAt(new T.Vector3().fromArray(view.at));
      renderer.render(scene, camera);
      out[name] = renderer.domElement.toDataURL('image/png').split(',')[1];
    }
    const info = { triangles: renderer.info.render.triangles, calls: renderer.info.render.calls,
      asset: gun.body.userData.blenderAsset ?? null, sightHeight: gun.body.userData.sightHeight ?? null };
    env?.dispose(); renderer.dispose(); disposeGunModels([gun], cache);
    return { out, info };
  })()`);
  if (browser.page.errors.length) throw new Error(browser.page.errors.join('\n'));
  for (const [name, png] of Object.entries(result.out)) {
    const file = path.join(outDir, `${weapon}${lod ? `-${lod}` : ''}-${name}.png`);
    fs.writeFileSync(file, Buffer.from(png, 'base64'));
    console.log(file);
  }
  console.log(JSON.stringify(result.info));
} finally {
  await browser?.close();
  await stopServer(server);
}
