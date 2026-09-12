import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { launchCdpSession } from './lib/cdp-session.mjs';
import { startServer, stopServer, waitForHttp } from './lib/server-process.mjs';

const server = startServer({ failureContext: 'large map light browser test' });
let browser;
try {
  const port = await server.port;
  await waitForHttp(port);
  browser = await launchCdpSession(`http://127.0.0.1:${port}/js/engine/map-lights.js`, { width: 1440, height: 900 });
  await mkdir('.artifacts/large-map-light-qa', { recursive: true });
  const results = [];
  for (const map of ['harbor', 'canyon']) {
    const result = await browser.page.evaluate(`(async () => {
      const THREE = await import('/js/vendor/three.module.js');
      const { createMapState, AIR } = await import('/shared/worlddata.js');
      const { WorldView } = await import('/js/engine/worldview.js');
      const { LARGE_MAP_LIGHTS, lightFixtureGeometry } = await import('/shared/world/large-map-lights.js');
      document.body.replaceChildren(); document.body.style.margin = '0';
      const world = createMapState(${JSON.stringify(map)});
      const view = new WorldView({ getBlock: world.getBlock, meta: world.meta });
      await view.ready(); await view.skyUpdate.ready;
      const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
      renderer.setSize(1440, 900); renderer.setPixelRatio(1); document.body.append(renderer.domElement);
      const camera = new THREE.PerspectiveCamera(62, 1440 / 900, .05, 400);
      const light = LARGE_MAP_LIGHTS[${JSON.stringify(map)}][0];
      const fixture = lightFixtureGeometry(light);
      camera.position.set(light.x + 9, 17, light.z + 10);
      camera.lookAt(light.x + .5, ${map === 'harbor' ? 21.5 : 18}, light.z + .5);
      view.update(0); renderer.render(view.scene, camera);
      const stats = { ...view.mapLights.stats };
      const rendered = { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles };
      view.mapLights.group.visible = false; renderer.render(view.scene, camera);
      const without = { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles };
      view.mapLights.group.visible = true; renderer.render(view.scene, camera);
      const lightCount = view.scene.children.filter(child => child.isLight).length;
      const sample = () => {
        const point = new THREE.Vector3().fromArray(fixture.surfaces.find(surface => surface.normal[0] > 0)?.position || fixture.surfaces[0].position);
        point.project(camera);
        const x = Math.round((point.x + 1) * 720), y = Math.round((1 - point.y) * 450);
        const canvas = document.createElement('canvas'); canvas.width = 1440; canvas.height = 900;
        const context = canvas.getContext('2d'); context.drawImage(renderer.domElement, 0, 0);
        return { x, y, rgba: [...context.getImageData(x, y, 1, 1).data] };
      };
      const beforePixel = sample();
      const before = renderer.domElement.toDataURL('image/png');
      const [x, y, z, original] = fixture.cells[0];
      world.setBlock(x, y, z, AIR);
      view.applyDeltas([{ x, y, z, v: AIR }]); view.update(0); renderer.render(view.scene, camera);
      const afterPixel = sample();
      const after = renderer.domElement.toDataURL('image/png');
      const afterStats = { ...view.mapLights.stats };
      world.setBlock(x, y, z, original);
      view.applyDeltas([{ x, y, z, v: original }]); view.update(0); renderer.render(view.scene, camera);
      const restored = { ...view.mapLights.stats };
      view.dispose(); view.dispose(); renderer.dispose(); renderer.forceContextLoss();
      return { map: ${JSON.stringify(map)}, stats, afterStats, restored, rendered, without,
        lightCount, beforePixel, afterPixel, before, after };
    })()`);
    assert.equal(result.afterStats.visible, result.stats.visible - 1);
    assert.equal(result.restored.visible, result.stats.visible);
    assert.equal(result.lightCount, 2, 'only existing sun and hemisphere lights are used');
    assert.equal(result.rendered.calls - result.without.calls, map === 'harbor' ? 2 : 1);
    assert.ok(result.beforePixel.rgba.slice(0, 3).every(value => value > 170), 'lamp face renders bright in the actual WebGL frame');
    assert.ok(result.beforePixel.rgba.slice(0, 3).reduce((sum, value, index) => sum + value - result.afterPixel.rgba[index], 0) > 100,
      'destroyed fixture loses its visible luminous pixels');
    for (const stage of ['before', 'after']) {
      await writeFile(`.artifacts/large-map-light-qa/${map}-${stage}.png`, Buffer.from(result[stage].split(',')[1], 'base64'));
      delete result[stage];
    }
    results.push(result);
    console.log(`${map}: actual WebGL bright-pixel/destruction/restoration, ${result.stats.drawCalls} additional draws and 0 new lights passed.`);
  }
  await writeFile('.artifacts/large-map-light-qa/results.json', JSON.stringify(results, null, 2));
  assert.deepEqual(browser.page.errors, []);
} finally {
  await browser?.close();
  await stopServer(server);
}
