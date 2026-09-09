import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { launchCdpSession } from './lib/cdp-session.mjs';
import { startServer, stopServer } from './lib/server-process.mjs';
const server = startServer();
let browser;
try {
  const port = await server.port;
  browser = await launchCdpSession(`http://127.0.0.1:${port}/capture.html?map=foundry&shot=hero`);
  const { page } = browser;
  await mkdir('.artifacts/skyboxes', { recursive: true });
  for (const map of ['foundry', 'dust2', 'caldera']) {
    if (map !== 'foundry') await page.send('Page.navigate', { url: `http://127.0.0.1:${port}/capture.html?map=${map}&shot=hero` });
    await page.waitFor(`document.documentElement.dataset.captureReady === 'true' && document.documentElement.dataset.captureMap === '${map}'`);
    const result = await page.evaluate(`(async () => {
      const THREE = await import('/js/vendor/three.module.js');
      const { installSky } = await import('/js/engine/sky.js');
      const { mapAtmosphere } = await import('/js/engine/map-atmosphere.js');
      const scene = new THREE.Scene();
      const update = installSky(scene, mapAtmosphere('${map}'));
      await update.ready;
      const dome = scene.getObjectByName('skydome');
      const texture = dome.material.uniforms.panorama.value;
      const result = { loaded: dome.material.uniforms.panoramaReady.value,
        width: texture?.image.width, height: texture?.image.height,
        cloudsHidden: scene.getObjectByName('sky').children.filter(c => c !== dome).every(c => !c.visible) };
      update.dispose();
      result.disposed = scene.children.length === 0;
      return result;
    })()`);
    assert.equal(result.loaded, true, `${map}: panorama loaded`);
    assert.equal(result.width, result.height * 2, `${map}: spherical aspect ratio`);
    assert.equal(result.cloudsHidden, true);
    assert.equal(result.disposed, true);
    const shot = await page.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(`.artifacts/skyboxes/${map}.png`, Buffer.from(shot.data, 'base64'));
  }
  assert.deepEqual(page.errors, []);
  console.log('Skyboxes: all three textures loaded, map renders, spherical ratios and resource lifecycle passed.');
} finally {
  if (browser) await browser.close();
  await stopServer(server);
}
