import assert from 'node:assert/strict';
import { launchCdpSession } from './lib/cdp-session.mjs';
import { startServer, stopServer } from './lib/server-process.mjs';
import { runKillcamBrowserFixture } from './lib/killcam-browser-fixture.mjs';

const server = startServer();
let browser;
try {
  const port = await server.port;
  browser = await launchCdpSession(`http://127.0.0.1:${port}/shared/worlddata.js`);
  const result = await browser.page.evaluate(`(${runKillcamBrowserFixture.toString()})()`);
  assert.deepEqual(browser.page.errors, []);
  console.log(JSON.stringify(result));
  console.log('Killcam WebGL: historical terrain, damage, debris, hitmarkers, isolated live updates, skip and completion passed.');
} finally {
  await browser?.close();
  await stopServer(server);
}
