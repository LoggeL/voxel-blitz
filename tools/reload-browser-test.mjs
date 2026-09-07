import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { WEAPON_IDS, WEAPONS } from '../shared/combatmath.js';
import { launchCdpSession } from './lib/cdp-session.mjs';
import { startServer, stopServer } from './lib/server-process.mjs';

const server = startServer();
let browser;
try {
  const port = await server.port;
  browser = await launchCdpSession(`http://127.0.0.1:${port}/weapon-feel-preview.html`);
  const { page } = browser;
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 650, deviceScaleFactor: 1, mobile: false });
  await page.waitFor(`document.documentElement.dataset.previewReady === 'true'`);
  await mkdir('.artifacts/reloads', { recursive: true });
  const captures = [];
  for (const id of WEAPON_IDS.filter(id => WEAPONS[id].mode !== 'melee')) {
    for (const phase of [0.5, 0.74]) {
      await page.evaluate(`(() => {
        const select=document.getElementById('weapon'); select.value=${JSON.stringify(id)}; select.dispatchEvent(new Event('change'));
        const slider=document.getElementById('phase'); slider.value=${phase}; slider.dispatchEvent(new Event('input'));
      })()`);
      await page.waitFor(`document.getElementById('progress').textContent === '${Math.round(phase * 100)}%'`);
      const shot = await page.send('Page.captureScreenshot', { format: 'png' });
      await writeFile(`.artifacts/reloads/${id}-${phase}.png`, Buffer.from(shot.data, 'base64'));
      captures.push({ id, phase, data: shot.data });
    }
  }
  assert.deepEqual(page.errors, []);
  await page.send('Page.navigate', { url: 'about:blank' });
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1900, deviceScaleFactor: 1, mobile: false });
  await page.evaluate(`(() => {
    document.body.style.cssText='margin:0;background:#18232f;color:white;font:18px system-ui;display:grid;grid-template-columns:repeat(4,1fr);gap:10px;padding:10px';
    const captures=${JSON.stringify(captures)};
    for(const capture of captures){
      const card=document.createElement('div'), label=document.createElement('div'),img=document.createElement('img');
      label.textContent=capture.id+' · '+Math.round(capture.phase*100)+'%';
      img.src='data:image/png;base64,'+capture.data; img.style.width='100%'; card.append(label,img);document.body.append(card);
    }
  })()`);
  await page.waitFor(`Array.from(document.images).every(image=>image.complete && image.naturalWidth>0)`);
  const sheet = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  await writeFile('.artifacts/reload-contact-sheet.png', Buffer.from(sheet.data, 'base64'));
  console.log(`Reload browser: ${captures.length} exchange/insertion poses across ${captures.length / 2} weapons rendered without runtime errors.`);
} finally {
  if (browser) await browser.close();
  await stopServer(server);
}
