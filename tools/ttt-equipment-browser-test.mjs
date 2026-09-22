import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { clickById as click, screenshotTo } from './lib/browser-helpers.mjs';
import { launchCdpSession } from './lib/cdp-session.mjs';
import { startServer, stopServer, waitForHttp } from './lib/server-process.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const artifacts = path.join(root, 'docs/design/ttt/shop-equipment');
const screenshot = (page, name) => screenshotTo(page, artifacts, name);
const startFixture = () => startServer({
  entry: 'tools/lib/ttt-browser-fixture.mjs', ipc: true, portTimeout: 10_000, failureContext: 'TTT browser fixture',
});

await mkdir(artifacts,{recursive:true});
const fixture=startFixture();let browser;
try {
 const port=await fixture.port;await waitForHttp(port);
 browser=await launchCdpSession('about:blank',{width:1280,height:810});
 const page=browser.page;
 await page.send('Page.addScriptToEvaluateOnNewDocument',{source:`window.__tttMessages=[];const Socket=window.WebSocket;window.WebSocket=class extends Socket{constructor(...a){super(...a);this.addEventListener('message',e=>{if(typeof e.data==='string'){try{window.__tttMessages.push(JSON.parse(e.data));}catch{}}});}};`});
 await page.send('Page.navigate',{url:`http://127.0.0.1:${port}/?debug=1&headless=1&touch=1`});
 await page.waitFor(`document.getElementById('create-lobby-btn')&&!document.getElementById('menu').classList.contains('hidden')`);
 await click(page,'create-lobby-btn');
 await page.waitFor(`document.getElementById('lobby')?.getAttribute('aria-hidden')==='false'`);
 await page.evaluate(`(()=>{const s=document.getElementById('game-mode-select');s.value='ttt';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
 await page.waitFor(`window.__tttMessages.filter(m=>m.t==='lobbyState').at(-1)?.gameMode==='ttt'`);
 await page.evaluate(`(()=>{const s=document.getElementById('bot-count');s.value='3';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
 await page.waitFor(`window.__tttMessages.filter(m=>m.t==='lobbyState').at(-1)?.bots===3`);
 await click(page,'lobby-ready-btn');await page.waitFor(`!document.getElementById('lobby-start-btn').disabled`);await click(page,'lobby-start-btn');
 await page.waitFor(`window.__vb?.stats?.running&&document.getElementById('ttt-controls')`,{timeoutMs:30000});
 const staged=await fixture.request('stage');
 await page.waitFor(`!document.getElementById('ttt-pickup').disabled`);
 await screenshot(page,'implemented-desktop-prep.png');
 await click(page,'ttt-pickup');
 await page.waitFor(`window.__tttMessages.filter(m=>m.t==='tick').at(-1)?.players.find(p=>p.ttt)?.owned.length===1`);
 await click(page,'ttt-drop');
 await page.waitFor(`window.__tttMessages.filter(m=>m.t==='tick').at(-1)?.players.find(p=>p.ttt)?.owned.length===0`);
 await page.waitFor(`!document.getElementById('ttt-pickup').disabled`);await click(page,'ttt-pickup');
 await fixture.request('reveal');
 await page.waitFor(`document.getElementById('ttt-controls').textContent.includes('TRAITOR')`);
 for(const type of ['keyDown','keyUp'])await page.send('Input.dispatchKeyEvent',{type,key:'b',code:'KeyB'});
 await page.waitFor(`document.getElementById('buy-menu')?.getAttribute('aria-hidden')==='false'`);
 await click(page,'ttt-buy');
 await page.waitFor(`window.__tttMessages.filter(m=>m.t==='tick').at(-1)?.players.find(p=>p.ttt)?.ttt.radar`);
 assert.equal(await page.evaluate(`document.getElementById('ttt-buy').disabled`),true,'owned radar cannot be bought twice');
 await page.evaluate(`document.querySelector('[data-ttt-item=disguiser]').click()`);await click(page,'ttt-buy');
 await page.waitFor(`window.__tttMessages.filter(m=>m.t==='tick').at(-1)?.players.find(p=>p.ttt)?.ttt.disguised===true`);
 assert.equal(await page.evaluate(`document.querySelector('.vb-ttt-credit').textContent`),'0 CREDITS');
 await click(page,'ttt-disguise');
 await page.waitFor(`window.__tttMessages.filter(m=>m.t==='tick').at(-1)?.players.find(p=>p.ttt)?.ttt.disguised===false`);
 await click(page,'ttt-disguise');
 await page.evaluate(`document.querySelector('[data-ttt-item=radar]').click()`);
 for(const [name,width,height] of [['desktop',1280,810],['mobile',390,844]]) {
  await page.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
  await page.evaluate(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`);
  const bounds=await page.evaluate(`(()=>{const p=document.querySelector('.vb-ttt-shop'),r=p.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,overflow:p.scrollWidth>p.clientWidth};})()`);
  assert.ok(bounds.x>=0&&bounds.y>=0&&bounds.right<=width+1&&bounds.bottom<=height+1&&!bounds.overflow,JSON.stringify(bounds));
  await screenshot(page,`implemented-${name}-shop.png`);
 }
 await page.evaluate(`document.querySelector('.vb-ttt-shop .vb-buy-close-btn').click()`);
 await page.waitFor(`!document.getElementById('ttt-radar').hidden&&document.querySelectorAll('.vb-ttt-contact:not([hidden])').length===3`);
 const frozen=await page.evaluate(`window.__tttMessages.filter(m=>m.t==='tick').at(-1).players.find(p=>p.ttt).ttt.radar`);
 await fixture.request('radar-target-move');
 await page.waitFor(`window.__tttMessages.filter(m=>m.t==='tick').at(-1).now>${frozen.scannedAt+200}`);
 const stillFrozen=await page.evaluate(`window.__tttMessages.filter(m=>m.t==='tick').at(-1).players.find(p=>p.ttt).ttt.radar`);
 assert.deepEqual(stillFrozen,frozen,'live motion does not turn radar into live tracking');
 const radarLayout=await page.evaluate(`(()=>{const r=e=>{const b=e.getBoundingClientRect();return{x:b.x,y:b.y,right:b.right,bottom:b.bottom}};return{panel:r(document.querySelector('.vb-ttt-radar-panel')),controls:r(document.getElementById('ttt-controls')),markers:[...document.querySelectorAll('.vb-ttt-contact:not([hidden])')].map(r)};})()`);
 assert.ok(radarLayout.panel.y>=radarLayout.controls.bottom,'radar leaves gadget controls readable');
 assert.ok(radarLayout.panel.bottom<=844,'radar fits portrait viewport');
 for(const r of radarLayout.markers)assert.ok(r.x>=0&&r.right<=391&&r.y>=0&&r.bottom<=844,'contact labels fit viewport');
 for(let i=0;i<radarLayout.markers.length;i++)for(let j=i+1;j<radarLayout.markers.length;j++) {
  const a=radarLayout.markers[i],b=radarLayout.markers[j];
  assert.ok(a.right<=b.x||b.right<=a.x||a.bottom<=b.y||b.bottom<=a.y,'contact labels do not stack on top of each other');
 }
 await screenshot(page,'implemented-mobile-radar.png');
 await page.send('Emulation.setDeviceMetricsOverride',{width:1280,height:810,deviceScaleFactor:1,mobile:false});
 await fixture.request('radar-scan');
 await page.waitFor(`Number(document.getElementById('ttt-radar').dataset.scannedAt)>${frozen.scannedAt}`);
 await screenshot(page,'implemented-desktop-radar.png');
 const after=await page.evaluate(`window.__tttMessages.filter(m=>m.t==='tick').at(-1).players.find(p=>p.ttt).ttt.radar`);
 assert.notDeepEqual(after.contacts,frozen.contacts);
 await fixture.request('teleporter-stage');
 await page.waitFor(`window.__tttMessages.filter(m=>m.t==='tick').at(-1)?.players.find(p=>p.ttt)?.ttt.equipment.length===0`);
 for(const type of ['keyDown','keyUp'])await page.send('Input.dispatchKeyEvent',{type,key:'b',code:'KeyB'});
 await page.waitFor(`document.getElementById('buy-menu').getAttribute('aria-hidden')==='false'`);
 await page.evaluate(`document.querySelector('[data-ttt-item=teleporter]').click()`);await click(page,'ttt-buy');
 await page.waitFor(`!document.getElementById('ttt-mark').hidden`);await click(page,'ttt-mark');
 await page.waitFor(`window.__tttMessages.filter(m=>m.t==='tick').at(-1)?.players.find(p=>p.ttt)?.ttt.teleporter.mark`);
 const mark=await page.evaluate(`window.__tttMessages.filter(m=>m.t==='tick').at(-1).players.find(p=>p.ttt).ttt.teleporter.mark`);
 await fixture.request('teleporter-away');
 await page.waitFor(`Math.abs(window.__vb.stats.feet.x-${mark.x})+Math.abs(window.__vb.stats.feet.z-${mark.z})>5`);
 await click(page,'ttt-recall');
 await page.waitFor(`window.__tttMessages.filter(m=>m.t==='tick').at(-1)?.players.find(p=>p.ttt)?.ttt.teleporter.uses===2`);
 await page.waitFor(`Math.hypot(window.__vb.stats.feet.x-${mark.x},window.__vb.stats.feet.y-${mark.y},window.__vb.stats.feet.z-${mark.z})<.3`);
 assert.equal(await page.evaluate(`document.getElementById('ttt-recall').disabled`),true);
 await screenshot(page,'implemented-teleporter.png');
 await fixture.request('innocent');
 await page.waitFor(`document.getElementById('buy-menu').getAttribute('aria-hidden')==='true'&&document.getElementById('ttt-radar').hidden`);
 assert.deepEqual(page.errors,[]);
 console.log('TTT equipment browser: actual purchases, disguise switch, scan HUD, frozen contact positions, new scan, teleport with client arrival, role revocation, desktop/mobile passed');
}catch(error){if(browser)console.log(await browser.page.evaluate(`({last:window.__tttMessages.filter(m=>m.t==='tick').at(-1)?.players.find(p=>p.ttt),errors:window.__tttMessages.filter(m=>m.t==='error')})`));throw error;}
finally{await browser?.close();await stopServer(fixture);}
