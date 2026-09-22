import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { clickById as click, screenshotTo } from './lib/browser-helpers.mjs';
import { launchCdpSession } from './lib/cdp-session.mjs';
import { startServer, stopServer, waitForHttp } from './lib/server-process.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const artifacts = path.join(root, 'docs/design/ttt');
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
 await page.evaluate(`document.querySelector('[data-ttt-item=armor]').click();document.getElementById('ttt-buy').click()`);
 await page.waitFor(`document.querySelector('.vb-ttt-credit').textContent==='1 CREDIT'`);
 assert.equal(await page.evaluate(`window.__tttMessages.filter(m=>m.t==='tick').at(-1).players.find(p=>p.ttt).armor`),50);
 for(const [name,width,height] of [['desktop',1280,810],['mobile',390,844]]) {
  await page.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
  await page.evaluate(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`);
  const rect=await page.evaluate(`(()=>{const r=document.querySelector('.vb-ttt-shop').getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,scroll:document.querySelector('.vb-ttt-shop').scrollHeight,height:r.height};})()`);
  assert.ok(rect.x>=0&&rect.y>=0&&rect.right<=width+1&&rect.bottom<=height+1,JSON.stringify(rect));
  await screenshot(page,`implemented-${name}-shop.png`);
 }
 await fixture.request('innocent');
 await page.waitFor(`document.getElementById('buy-menu').getAttribute('aria-hidden')==='true'`);
 const overlap=await page.evaluate(`(()=>{const a=document.getElementById('healthbar').getBoundingClientRect(),b=document.getElementById('ttt-controls').getBoundingClientRect();return a.right>b.left&&a.left<b.right&&a.bottom>b.top&&a.top<b.bottom;})()`);
 assert.equal(overlap,false,'mobile controls leave health readable');
 await screenshot(page,'implemented-mobile-innocent.png');
 await page.evaluate(`document.activeElement?.blur()`);
 for(const type of ['keyDown','keyUp'])await page.send('Input.dispatchKeyEvent',{type,key:'l',code:'KeyL'});
 await page.waitFor(`window.__tttMessages.filter(m=>m.t==='tick').at(-1)?.players.find(p=>p.ttt)?.owned.length===0`);
 for(const type of ['keyDown','keyUp'])await page.send('Input.dispatchKeyEvent',{type,key:'t',code:'KeyT'});
 await page.waitFor(`window.__tttMessages.filter(m=>m.t==='tick').at(-1)?.players.find(p=>p.ttt)?.owned.length===1`);
 const errors=page.errors||[];assert.deepEqual(errors,[]);
 console.log('TTT browser: lobby, world pickup, drop, secret shop purchase, innocent rejection and desktop/mobile bounds passed');
}catch(e){if(browser)console.log(await browser.page.evaluate(`({messages:window.__tttMessages.slice(-2),errors:window.__tttMessages.filter(m=>m.t==='error'),button:document.getElementById('ttt-pickup')?.outerHTML})`));throw e;}finally{await browser?.close();await stopServer(fixture);}
