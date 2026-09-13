import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { launchCdpSession } from './lib/cdp-session.mjs';
import { waitForHttp } from './lib/server-process.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const artifacts = path.join(root, '.artifacts/ttt-investigation');

async function click(page, id) {
  const point = await page.evaluate(`(() => {
    const element=document.getElementById(${JSON.stringify(id)});
    element?.scrollIntoView({block:'center'});
    const r=element?.getBoundingClientRect();
    return r?.width&&r?.height?{x:r.left+r.width/2,y:r.top+r.height/2}:null;
  })()`);
  assert.ok(point, `visible #${id}`);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await page.send('Input.dispatchMouseEvent', {
      type, ...point, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1,
    });
  }
}

async function screenshot(page, name) {
  const capture = await page.send('Page.captureScreenshot', {
    format: 'png', captureBeyondViewport: false,
  }, 15_000);
  await writeFile(path.join(artifacts, name), Buffer.from(capture.data, 'base64'));
}

function startFixture() {
  const child = fork('tools/lib/ttt-browser-fixture.mjs', [], {
    cwd: root, env: { ...process.env, PORT: '0' }, silent: true,
  });
  let output = '', requestId = 0;
  const port = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Fixture startup timeout: ${output}`)), 10_000);
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = /voxel-blitz listening on .*:(\d+)\b/.exec(output);
      if (match) { clearTimeout(timeout); resolve(Number(match[1])); }
    });
    child.stderr.on('data', chunk => { output += chunk; });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Fixture exited ${code}: ${output}`)); });
  });
  return {
    port,
    request(command) {
      const id = ++requestId;
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { child.off('message', receive); reject(new Error(`Fixture ${command} timeout`)); }, 5_000);
        const receive = message => {
          if (message.requestId !== id) return;
          clearTimeout(timeout); child.off('message', receive);
          if (message.error) reject(new Error(message.error)); else resolve(message.result);
        };
        child.on('message', receive); child.send({ requestId: id, command });
      });
    },
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise(resolve => {
        const timeout = setTimeout(() => child.kill('SIGKILL'), 2_000);
        child.once('exit', () => { clearTimeout(timeout); resolve(); });
        child.kill('SIGTERM');
      });
    },
  };
}

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
 await fixture.request('stage');await fixture.request('grenade');
 await page.waitFor(`document.getElementById('ttt-pickup').textContent.includes('SMOKE')&&!document.getElementById('ttt-pickup').disabled`);
 await click(page,'ttt-pickup');
 await page.waitFor(`window.__tttMessages.filter(m=>m.t==='tick').at(-1)?.players.find(p=>p.ttt)?.grenades[4]===1`);
 await fixture.request('reveal');
 const ally=await fixture.request('ally');
 await page.waitFor(`document.querySelector('.vb-ttt-contact[data-live=true]:not([hidden])')`);
 assert.equal(await page.evaluate(`document.querySelector('.vb-ttt-radar-panel').hidden`),true,'allies are visible without buying radar');
 assert.ok((await page.evaluate(`document.querySelector('.vb-ttt-contact[data-live=true]').textContent`)).includes(ally.name));
 for(let i=0;i<4;i++)for(const type of ['keyDown','keyUp'])await page.send('Input.dispatchKeyEvent',{type,key:'h',code:'KeyH'});
 await page.send('Input.dispatchKeyEvent',{type:'keyDown',key:'g',code:'KeyG'});
 await page.evaluate(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`);
 await page.send('Input.dispatchKeyEvent',{type:'keyUp',key:'g',code:'KeyG'});
 await page.waitFor(`window.__tttMessages.filter(m=>m.t==='tick').at(-1)?.players.find(p=>p.ttt)?.grenades[4]===0`);
 assert.ok(await page.evaluate(`window.__tttMessages.some(m=>m.events?.some(e=>e.kind==='projectileLaunch'&&e.type==='smoke'))`),'unarmed grenade throw reaches authority');
 await page.waitFor(`!window.__vb.stats.throwable.active`);
 for(const type of ['keyDown','keyUp'])await page.send('Input.dispatchKeyEvent',{type,key:'b',code:'KeyB'});
 await page.waitFor(`document.getElementById('buy-menu')?.getAttribute('aria-hidden')==='false'&&document.querySelector('[data-ttt-item=c4]')`);
 await page.evaluate(`document.querySelector('[data-ttt-item=c4]').click()`);await click(page,'ttt-buy');
 await page.waitFor(`!document.getElementById('ttt-c4').hidden&&!document.getElementById('ttt-c4').disabled`);
 await screenshot(page,'c4-shop-desktop.png');
 await click(page,'ttt-c4');
 await page.waitFor(`document.getElementById('ttt-c4').disabled`);
 await page.evaluate(`document.querySelector('.vb-ttt-shop .vb-buy-close-btn').click()`);
 await page.waitFor(`document.querySelector('.vb-ttt-contact[data-bomb=true]:not([hidden])')`);
 await screenshot(page,'allies-c4-desktop.png');

 await page.waitFor(`document.getElementById('ttt-controls').textContent.includes('TRAITOR')`);
 const victim=await fixture.request('corpse');
 await page.waitFor(`document.getElementById('ttt-inspect')&&!document.getElementById('ttt-inspect').hidden`);
 assert.equal(await page.evaluate(`document.getElementById('killfeed').hidden`),false);
 assert.equal(await page.evaluate(`document.querySelectorAll('#killfeed .kf-row').length`),0);
 assert.ok(await page.evaluate(`document.getElementById('ttt-inspect').textContent.includes('Unbekannte Leiche')`));
 assert.equal(await page.evaluate(`window.__tttMessages.filter(m=>m.t==='tick').at(-1).match.corpses[0].role`),undefined);
 assert.equal(await page.evaluate(`window.__tttMessages.filter(m=>m.t==='tick').some(m=>m.events?.some(e=>e.kind==='kill'))`),false);
 await screenshot(page,'unidentified-desktop.png');
 await page.evaluate(`document.activeElement?.blur()`);
 for(const type of ['keyDown','keyUp'])await page.send('Input.dispatchKeyEvent',{type,key:'e',code:'KeyE'});
 await page.waitFor(`!document.getElementById('ttt-body-report').hidden&&document.getElementById('ttt-body-report').textContent.includes('TRAITOR')`);
 assert.ok((await page.evaluate(`document.getElementById('ttt-body-report').textContent`)).includes(victim.name));
 await page.evaluate(`document.dispatchEvent(new MouseEvent('mousemove',{movementX:524,movementY:320,bubbles:true}))`);
 await page.evaluate(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`);
 await page.waitFor(`document.querySelector('#killfeed .kf-body-found')`);
 assert.ok((await page.evaluate(`document.querySelector('#killfeed .kf-body-found').textContent`)).includes(victim.name));
 await page.waitFor(`document.querySelector('#scores tr[data-pid="${victim.id}"] .vb-sb-state')?.textContent === 'TOT'`);
 assert.equal(await page.evaluate(`document.querySelectorAll('#killfeed .kf-row').length`),1);
 assert.equal(await page.evaluate(`document.querySelector('#killfeed .kf-body-found').getBoundingClientRect().width > 0`),true);
 await screenshot(page,'identified-desktop.png');
 await fixture.request('finish');
 await page.waitFor(`document.getElementById('match-result-screen').getAttribute('aria-hidden')==='false'`);
 assert.ok((await page.evaluate(`document.getElementById('match-result-traitors').textContent`)).includes(victim.name));
 assert.equal(await page.evaluate(`document.querySelectorAll('#match-result-scores .vb-ttt-role-badge[data-role=traitor]').length`),2);
 for(const [name,width,height] of [['desktop',1280,810],['mobile',390,844]]) {
  await page.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
  await page.evaluate(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`);
  const bounds=await page.evaluate(`(()=>{const e=document.getElementById('match-result-traitors'),r=e.getBoundingClientRect();return{left:r.left,right:r.right,width:e.scrollWidth,client:e.clientWidth};})()`);
  assert.ok(bounds.left>=0&&bounds.right<=width+1&&bounds.width<=bounds.client+1,JSON.stringify(bounds));
  await screenshot(page,`post-${name}.png`);
 }
 assert.deepEqual(page.errors,[]);
 console.log('TTT browser: persistent body, E inspection, hidden identity, body announcement, confirmed death in scoreboard and desktop/mobile post-match traitor reveal passed.');
}finally{await browser?.close();await fixture.close();}
