import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { launchCdpSession } from './lib/cdp-session.mjs';
import { startServer, stopServer } from './lib/server-process.mjs';
const server = startServer({ cwd: process.cwd(), failureContext: 'bot difficulty browser' });
let browser, guest;
try {
  const base = `http://127.0.0.1:${await server.port}`;
  browser = await launchCdpSession(base + '/js/ui/hud-support.js');
  const page = browser.page;
  await page.evaluate(`localStorage.setItem('vb-mode','tdm');localStorage.setItem('vb-map','harbor');localStorage.setItem('vb-bots','3')`);
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `
    const Native = WebSocket; window.rosters = [];
    window.WebSocket = class extends Native { constructor(...args) { super(...args);
      this.addEventListener('message', event => { if(typeof event.data !== 'string') return;
        const frame = JSON.parse(event.data); if(frame.t === 'lobbyState') window.rosters.push(frame);
      }); } };` });
  await page.send('Page.navigate', { url: base + '/?headless=1&debug=1' });
  await page.waitFor(`document.getElementById('create-lobby-btn')`);
  await page.evaluate(`document.getElementById('create-lobby-btn').click()`);
  await page.waitFor(`document.querySelectorAll('.vb-bot-difficulty').length === 3`);
  const set = async (selector, value) => page.evaluate(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});node.value = ${JSON.stringify(value)};node.dispatchEvent(new Event('change'));
  })()`);
  await set('[data-bot-id="bot-0"]', 'hard');
  await page.waitFor(`window.rosters.at(-1).members.find(row=>row.id==='bot-0').difficulty==='hard'`);
  await set('[data-bot-id="bot-1"]', 'normal');
  await page.waitFor(`window.rosters.at(-1).members.find(row=>row.id==='bot-1').difficulty==='normal'`);
  const code = await page.evaluate(`window.rosters.at(-1).code`);
  guest = await launchCdpSession(base + `/?lobby=${code}&headless=1&debug=1`);
  await guest.page.waitFor(`document.getElementById('lobby-browser')?.open && document.getElementById('join-code-input')?.value === '${code}'`);
  await guest.page.evaluate(`document.getElementById('join-lobby-btn').click()`);
  await guest.page.waitFor(`document.querySelectorAll('.vb-bot-difficulty-label').length === 3`);
  assert.equal(await guest.page.evaluate(`document.querySelectorAll('.vb-bot-difficulty').length`), 0, 'guest has no selectors');
  assert.deepEqual(await guest.page.evaluate(`[...document.querySelectorAll('.vb-bot-difficulty-label')].map(node=>node.textContent)`), ['Hard','Normal','Easy']);
  await page.evaluate(`document.getElementById('lobby-ready-btn').click()`);
  await page.waitFor(`document.getElementById('lobby-ready-btn').getAttribute('aria-pressed')==='true'`);
  await set('[data-bot-id="bot-2"]', 'hard');
  await page.waitFor(`document.getElementById('lobby-ready-btn').getAttribute('aria-pressed')==='false'`);
  await set('#map-select', 'canyon');
  await page.waitFor(`window.rosters.at(-1).map === 'canyon'`);
  assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('.vb-bot-difficulty')].map(node=>node.value)`), ['hard','normal','hard']);
  await mkdir('.artifacts/bot-difficulty', { recursive: true });
  for (const [width,height] of [[1440,900],[390,844]]) {
    await page.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
    await page.evaluate(`document.querySelector('[data-bot-id="bot-0"]').scrollIntoView({block:'center'})`);
    const shot = await page.send('Page.captureScreenshot',{format:'png'});
    await writeFile(`.artifacts/bot-difficulty/lobby-${width}.png`,Buffer.from(shot.data,'base64'));
    const overflow = await page.evaluate(`[...document.querySelectorAll('#lobby *')].filter(node => {
      const r=node.getBoundingClientRect();return r.width && (r.right > innerWidth+1 || r.left < -1);
    }).slice(0,12).map(node=>({tag:node.tagName,cls:node.className,width:node.getBoundingClientRect().width}))`);
    assert.equal(await page.evaluate(`document.getElementById('lobby').scrollWidth<=innerWidth`),true,`${width}px lobby fits: ${JSON.stringify(overflow)}`);
  }
  await page.evaluate(`document.getElementById('lobby-ready-btn').click()`);
  await guest.page.evaluate(`document.getElementById('lobby-ready-btn').click()`);
  await page.waitFor(`!document.getElementById('lobby-start-btn').disabled`);
  await page.evaluate(`document.getElementById('lobby-start-btn').click()`);
  await page.waitFor(`window.__vb?.stats?.running`,{timeoutMs:30000});
  const started = await page.evaluate(`window.rosters.findLast(frame=>frame.phase==='live').members.filter(row=>row.bot).map(row=>row.difficulty)`);
  assert.deepEqual(started,['hard','normal','hard']);
  assert.deepEqual([...page.errors,...guest.page.errors].filter(error=>!/favicon|pointer.?lock/i.test(error)),[]);
  console.log('Bot difficulty browser: individual host choices, member read-only state, readiness reset, map persistence, responsive layout and live launch passed.');
} finally { await guest?.close(); await browser?.close(); await stopServer(server); }
