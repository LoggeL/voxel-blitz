import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { startServer, stopServer } from './lib/server-process.mjs';
import { launchCdpSession } from './lib/cdp-session.mjs';

const out = path.resolve('.artifacts/sniper-redesign');
await mkdir(out, { recursive: true });
const server = startServer();
let browser;
try {
  const base = `http://127.0.0.1:${await server.port}`;
  browser = await launchCdpSession(`${base}/weapon-capture.html?weapon=sniper&state=held`, { width: 1200, height: 800 });
  const { page } = browser;
  const report = { captures: [], reload: [] };
  const screenshot = async name => {
    const shot = await page.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(path.join(out, `${name}.png`), Buffer.from(shot.data, 'base64'));
    report.captures.push(name);
  };
  for (const [label, width, height, mobile] of [['desktop',1200,800,false],['mobile',896,414,true]]) {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
    for (const state of ['held','scoped','firing']) {
      await page.send('Page.navigate', { url: `${base}/weapon-capture.html?weapon=sniper&state=${state}` });
      await page.waitFor(`document.documentElement.dataset.captureReady === 'true'`, { timeoutMs: 30000 });
      await screenshot(`${label}-${state}`);
    }
  }
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
  await page.send('Page.navigate', { url: `${base}/weapon-feel-preview.html` });
  await page.waitFor(`document.documentElement.dataset.previewReady === 'true'`);
  await page.evaluate(`(async () => {
    const { ViewmodelRig } = await import('/js/guns/viewmodel.js');
    const original = ViewmodelRig.prototype.update;
    ViewmodelRig.prototype.update = function(...args) { window.__sniperReviewRig=this; return original.apply(this,args); };
    const select=document.getElementById('weapon'); select.value='sniper'; select.dispatchEvent(new Event('change'));
  })()`);
  await page.waitFor(`window.__sniperReviewRig?._cur?.body?.userData.blenderAsset === 'peregrine'`);
  for (const phase of [.25,.5,.75,1]) {
    await page.evaluate(`(() => {const slider=document.getElementById('phase');slider.value=${phase};slider.dispatchEvent(new Event('input'));})()`);
    await page.waitFor(`document.getElementById('progress').textContent === '${Math.round(phase*100)}%'`);
    const state = await page.evaluate(`(() => {
      const m=__sniperReviewRig._cur;
      return {phase:${phase}, boltZ:m.bolt.position.z, visibleRounds:m.extra.userData.cartridges.filter(r=>r.visible).length,
        finite:m.bolt.position.toArray().every(Number.isFinite), model:m.body.userData.blenderAsset};
    })()`);
    assert.equal(state.model,'peregrine'); assert.ok(state.finite);
    if (phase===.5) { assert.ok(state.boltZ>.1); assert.equal(state.visibleRounds,3); }
    if (phase===1) { assert.equal(state.boltZ,0); assert.equal(state.visibleRounds,0); }
    report.reload.push(state);
    await screenshot(`reload-${Math.round(phase*100)}`);
  }
  assert.deepEqual(page.errors, []);
  report.browserErrors = page.errors;
  await writeFile(path.join(out, 'browser-validation.json'), JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
} finally {
  await browser?.close();
  await stopServer(server);
}
