import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clickById as click, screenshotTo } from './lib/browser-helpers.mjs';
import { launchCdpSession } from './lib/cdp-session.mjs';
import { startServer, stopServer, waitForHttp } from './lib/server-process.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const artifacts = path.join(root, '.artifacts/stress-acoustics');
const fixture = startServer({ entry: 'tools/lib/stress-acoustics-fixture.mjs', ipc: true,
  failureContext: 'live stress and room acoustics browser test' });
const screenshot = async (page, name) => {
  await page.send('Page.bringToFront');
  if (name !== 'failure.png') assert.equal(await page.evaluate('window.__vb.stats.settingsOpen'), false, `${name}: gameplay is unobscured`);
  return screenshotTo(page, artifacts, name);
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let browser;

async function press(page, key, code) {
  for (const type of ['keyDown', 'keyUp']) await page.send('Input.dispatchKeyEvent', { type, key, code });
}

async function setup(page, port) {
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.__liveMessages=[];
    window.__runtimeErrors=[];const nativeError=console.error;
    console.error=(...args)=>{window.__runtimeErrors.push(args.map(v=>v?.stack||String(v)).join(' '));nativeError(...args)};
    const NativeSocket=window.WebSocket;
    window.WebSocket=class extends NativeSocket { constructor(...args) { super(...args);
      this.addEventListener('message',event=>{if(typeof event.data==='string') {
        try { window.__liveMessages.push(JSON.parse(event.data)); } catch {}
      }});
    }};
  ` });
  await page.send('Page.navigate', { url: `http://127.0.0.1:${port}/?debug=1&headless=1&touch=1` });
  await page.waitFor(`document.getElementById('create-lobby-btn')&&!document.getElementById('menu').classList.contains('hidden')`, { label: 'game menu' });
  await page.evaluate(`(async()=>{
    const {ChunkStore}=await import('/js/engine/chunks.js');
    const rebuild=ChunkStore.prototype.rebuildChunk;
    ChunkStore.prototype.rebuildChunk=function(...args){window.__liveChunks=this;return rebuild.apply(this,args)};
    const {WeaponActions}=await import('/js/guns/actions.js');
    window.__liveReloads=[];
    const start=WeaponActions.prototype.startReload,update=WeaponActions.prototype.update;
    WeaponActions.prototype.startReload=function(...args){
      const result=start.apply(this,args);
      if(result){this.__liveCapture={start:args[0],duration:args[1],clicks:[],samples:[]};
        window.__liveReloads.push(this.__liveCapture);
        if(!this.__liveClickWrapped){const click=this._callbacks.onReloadClick;
          this._callbacks.onReloadClick=(...values)=>{if(this.__liveCapture)this.__liveCapture.clicks.push(values[0]);return click(...values)};
          this.__liveClickWrapped=true;}
      }return result;
    };
    WeaponActions.prototype.update=function(...args){
      const capture=this.__liveCapture,active=!!this._reload;
      const result=update.apply(this,args);
      if(capture&&active){const model=args[2],reload=this._reload;
        capture.samples.push({time:args[0],phase:reload?.lastFrac??1,stress:this._stress,
          gripBeat:this._gripBeat,motion:{...this._motion},
          magazine:model?.mag?{position:model.mag.position.toArray(),rotation:model.mag.rotation.toArray().slice(0,3),visible:model.mag.visible}:null});
        if(!reload)capture.end=args[0];
      }return result;
    };
    const {sfx}=await import('/js/audio/sfx.js');
    window.__liveSfx=sfx;window.__acousticShots=[];
    const fire=sfx.fire;
    sfx.fire=function(key,options){const trace=options?.pos?{key,source:options.pos,at:performance.now()}:null;
      if(trace)window.__acousticShots.push(trace);const result=fire.call(this,key,options);
      if(trace)trace.acoustics=sfx.acousticsDiagnostics({source:options.pos});
      return result;};
    window.__recordStart=async()=>{
      await sfx.unlock();
      const {engine}=sfx.objectiveAudio(),destination=engine.ctx.createMediaStreamDestination();
      engine.musicDestination.connect(destination);
      const recorder=new MediaRecorder(destination.stream,{mimeType:'audio/webm;codecs=opus'}),parts=[];
      recorder.ondataavailable=e=>{if(e.data.size)parts.push(e.data)};
      window.__recording={engine,destination,recorder,parts};recorder.start();
    };
    window.__recordStop=async()=>{
      const {engine,destination,recorder,parts}=window.__recording;
      await new Promise(resolve=>{recorder.onstop=resolve;recorder.stop()});
      engine.musicDestination.disconnect(destination);
      destination.stream.getTracks().forEach(track=>track.stop());
      const bytes=await new Blob(parts,{type:'audio/webm'}).arrayBuffer();
      const decoded=await engine.ctx.decodeAudioData(bytes.slice(0));
      const count=decoded.length,rate=decoded.sampleRate,channels=decoded.numberOfChannels;
      const samples=new Float32Array(count);
      for(let c=0;c<channels;c++){const data=decoded.getChannelData(c);for(let i=0;i<count;i++)samples[i]+=data[i]/channels}
      let peak=0,total=0,delta=0,onset=-1;
      for(let i=0;i<count;i++){const v=samples[i];peak=Math.max(peak,Math.abs(v));total+=v*v;
        if(i)delta+=(v-samples[i-1])**2;if(onset<0&&Math.abs(v)>.0008)onset=i;}
      const rms=(from,to)=>{const a=Math.max(0,onset+Math.round(from*rate)),b=Math.min(count,onset+Math.round(to*rate));
        let sum=0;for(let i=a;i<b;i++)sum+=samples[i]**2;return Math.sqrt(sum/Math.max(1,b-a));};
      let binary='';const array=new Uint8Array(bytes);for(let i=0;i<array.length;i+=8192)binary+=String.fromCharCode(...array.subarray(i,i+8192));
      return {webm:btoa(binary),metrics:{peak,rms:Math.sqrt(total/count),brightness:Math.sqrt(delta/Math.max(1,total)),
        onsetMs:1000*onset/rate,duration:count/rate,attackRms:rms(0,.45),tailRms:rms(.75,1.7),rate,channels}};
    };
  })()`);
  await page.waitFor(`window.__vb?.stats.assets.idle&&document.getElementById('create-lobby-btn')?.disabled===false`, { timeoutMs: 30_000, label: 'ready menu assets' });
  await click(page, 'create-lobby-btn', { requireEnabled: true });
  await page.waitFor(`document.getElementById('lobby')?.getAttribute('aria-hidden')==='false'`, { label: 'waiting lobby' });
  await page.evaluate(`(()=>{const select=document.getElementById('bot-count');select.value='0';select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await page.waitFor(`window.__liveMessages.filter(m=>m.t==='lobbyState').at(-1)?.bots===0`, { label: 'zero bots' });
  await click(page, 'lobby-ready-btn');
  await page.waitFor(`document.getElementById('lobby-start-btn')?.disabled===false`, { label: 'ready lobby' });
  await click(page, 'lobby-start-btn');
  await page.waitFor(`window.__vb?.stats?.running&&window.__vb.stats.ringLen>0&&!!window.__liveChunks`, { timeoutMs: 30_000, label: 'live production match' });
  await page.evaluate(`document.documentElement.classList.remove('vb-touch-mode')`);
  const staged = await fixture.request('stage');
  console.log('live room staged');
  await page.waitFor(`window.__liveChunks.getBlock(22,3,20)!==0&&Math.abs(window.__vb.stats.feet.x-19.5)<.1&&Math.abs(window.__vb.stats.feet.y-2)<.1`, { timeoutMs: 30_000, label: 'authoritative room and listener reached client' });
  await page.evaluate(`document.dispatchEvent(new MouseEvent('mousemove',{movementX:(window.__vb.stats.yaw+Math.PI/2)/.003,movementY:window.__vb.stats.pitch/.003,bubbles:true}))`);
  await page.waitFor(`Math.abs(window.__vb.stats.yaw+Math.PI/2)<.02`, { label: 'player looks toward partition' });
  await page.evaluate(`window.__liveSfx.setMenuMusicVolume(0)`);
  await sleep(1200);
  return staged;
}

async function acousticCapture(page, name) {
  // The fixture fires the real remote PlayerEntity through fireOneShot. Its
  // normal network event invokes the production sound graph in the live game.
  const before = await page.evaluate('window.__acousticShots.length');
  await page.evaluate('window.__recordStart()');
  const shot = await fixture.request('shot');
  console.log(`${name}: authoritative shot ${shot.shotSeq}`);
  await page.waitFor(`window.__acousticShots.length>${before}`, { label: `${name}: remote shot reaches client` });
  const audible = await page.evaluate('window.__acousticShots.at(-1)');
  await sleep(2400);
  const captured = await page.evaluate('window.__recordStop()');
  await writeFile(path.join(artifacts, `${name}.webm`), Buffer.from(captured.webm, 'base64'));
  assert.ok(captured.metrics.peak > .0008 && captured.metrics.rms > .00001, `${name}: decoded production output is audible`);
  assert.ok(captured.metrics.peak <= 1, `${name}: limiter bounds PCM`);
  const stats = await page.evaluate('window.__vb.stats');
  await screenshot(page, `${name}.png`);
  console.log(`${name}: decoded PCM peak=${captured.metrics.peak.toFixed(5)}, rms=${captured.metrics.rms.toFixed(5)}`);
  return { shot, audible, metrics: captured.metrics, listener: stats.feet, diagnostics: stats.acoustics };
}

async function reloadCapture(page, name) {
  await page.send('Page.bringToFront');
  await fixture.request(name === 'calm' ? 'calm' : 'hurt');
  await page.waitFor(name === 'calm' ? 'window.__vb.stats.panic<.02&&window.__vb.stats.pain<.02'
    : 'window.__vb.stats.hp===45&&window.__vb.stats.panic>.45&&window.__vb.stats.pain>.45', { label: `${name}: real condition reaches client` });
  const before = await fixture.request('state');
  // The real FIRE control first spends a round, then R starts predicted and
  // authoritative reloads via the normal input packet and server resolver.
  const localShots = await page.evaluate(`window.__liveMessages.flatMap(m=>m.events||[]).filter(e=>e.kind==='shoot'&&e.id===window.__vb.stats.localId).length`);
  await click(page, 'touch-fire');
  await page.waitFor(`window.__liveMessages.flatMap(m=>m.events||[]).filter(e=>e.kind==='shoot'&&e.id===window.__vb.stats.localId).length>${localShots}`, { label: 'real local fire event' });
  const count = await page.evaluate('window.__liveReloads.length');
  await page.evaluate(`(()=>{const stream=document.getElementById('game').captureStream(20);
    const recorder=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp8',videoBitsPerSecond:3500000}),parts=[];
    recorder.ondataavailable=e=>{if(e.data.size)parts.push(e.data)};
    window.__reloadVideo={recorder,stream,parts};recorder.start();})()`);
  await press(page, 'r', 'KeyR');
  await page.waitFor(`window.__liveReloads.length>${count}&&window.__liveReloads.at(-1).samples.some(s=>s.phase>=.60)`, { label: `${name}: actual reload reaches insertion` });
  await screenshot(page, `${name}-reload.png`);
  await page.waitFor(`!!window.__liveReloads.at(-1).end`, { label: `${name}: actual animation completes` });
  let after;
  for (let attempt = 0; attempt < 30; attempt++) {
    after = await fixture.request('state');
    if (!after.reloading && after.authority.at(-1)?.ended) break;
    await sleep(50);
  }
  const animation = await page.evaluate('window.__liveReloads.at(-1)');
  const video = await page.evaluate(`(async()=>{const {recorder,stream,parts}=window.__reloadVideo;
    await new Promise(resolve=>{recorder.onstop=resolve;recorder.stop()});stream.getTracks().forEach(track=>track.stop());
    const bytes=new Uint8Array(await new Blob(parts,{type:'video/webm'}).arrayBuffer());let text='';
    for(let i=0;i<bytes.length;i+=8192)text+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(text);})()`);
  await writeFile(path.join(artifacts,`${name}-reload.webm`),Buffer.from(video,'base64'));
  const authoritative = after.authority.at(-1);
  assert.ok(authoritative?.ended, `${name}: authoritative reload completed`);
  assert.ok(Math.abs(authoritative.seconds - authoritative.expected) < 1e-8, `${name}: authoritative duration uses unchanged reload plan`);
  assert.ok(Math.abs(authoritative.elapsed - authoritative.seconds) <= .075, `${name}: timing follows production tick schedule`);
  assert.equal(authoritative.reserveAfter, authoritative.reserveBefore - 1, `${name}: one spare magazine used`);
  assert.equal(authoritative.magAfter, 30, `${name}: authoritative rifle magazine filled`);
  return { before, after, animation, authoritative };
}

try {
  await mkdir(artifacts, { recursive: true });
  const port = await fixture.port; await waitForHttp(port);
  browser = await launchCdpSession(`http://127.0.0.1:${port}/shared/worlddata.js`, { width: 1280, height: 810, softwareRendering: false,
    headless: process.env.VB_LIVE_HEADED !== '1',
    extraArgs: ['--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows'] });
  const { page } = browser;
  await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await page.send('Page.bringToFront');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 810, deviceScaleFactor: 1, mobile: false });
  const staged = await setup(page, port);
  const closed = await acousticCapture(page, 'closed-wall');
  const doorwayMutation = await fixture.request('doorway');
  await page.waitFor('window.__liveChunks.getBlock(22,3,23)===0&&window.__liveChunks.getBlock(22,3,20)!==0', { label: 'real side-doorway destruction reaches client' });
  await sleep(1600);
  const doorway = await acousticCapture(page, 'side-doorway');
  const breachMutation = await fixture.request('breach');
  await page.waitFor('window.__liveChunks.getBlock(22,3,20)===0', { label: 'real wall destruction reaches client' });
  await sleep(1600);
  const breached = await acousticCapture(page, 'destroyed-wall');
  const outdoorMutation = await fixture.request('outdoors');
  await page.waitFor('window.__liveChunks.getBlock(19,7,20)===0', { label: 'real room roof destruction reaches client' });
  await sleep(2200);
  const outdoors = await acousticCapture(page, 'open-air');
  const profiles = [closed, doorway, breached, outdoors].map(result => result.audible.acoustics.sample);
  assert.ok(profiles.every(Boolean), 'actual positional reports have acoustic samples');
  assert.ok(profiles[0].gain < profiles[2].gain, 'removed wall increases direct sound transmission');
  assert.ok(profiles[0].lowpassHz < profiles[2].lowpassHz, 'removed wall restores high frequencies');
  assert.ok(profiles[1].gain > profiles[0].gain, 'side doorway provides a sound path');
  assert.ok(profiles[2].wet > profiles[3].wet, 'roof and shell destruction reduce room reflection');
  assert.ok(breached.metrics.attackRms > closed.metrics.attackRms * 1.2, 'recorded open-wall gunfire has greater direct energy');
  assert.ok(breached.metrics.brightness > closed.metrics.brightness * 1.05, 'recorded open-wall gunfire restores audible high frequencies');
  assert.ok(breached.metrics.tailRms > outdoors.metrics.tailRms * 1.1, 'recorded room tail exceeds open-air tail');
  for (const result of [doorway, breached, outdoors]) {
    assert.deepEqual(result.audible.source, closed.audible.source, 'same gunfire source for each acoustic condition');
    assert.ok(Math.hypot(result.listener.x-closed.listener.x, result.listener.y-closed.listener.y, result.listener.z-closed.listener.z)<.02,
      'listener stays still between acoustic comparisons');
  }
  await fixture.request('restoreRoom');
  await page.waitFor('window.__liveChunks.getBlock(22,3,20)!==0', { label: 'room restored for weapon captures' });
  await sleep(1000);
  const calm = await reloadCapture(page, 'calm');
  const stressed = await reloadCapture(page, 'stressed');
  assert.ok(calm.animation.samples.every(s => s.stress < .02 && s.gripBeat < .02), 'calm choreography retains its original path');
  assert.ok(stressed.animation.samples.some(s => s.stress > .4 && s.gripBeat > .15), 'actual damage produces a visible stressed regrip');
  assert.deepEqual(stressed.animation.clicks, calm.animation.clicks, 'stress keeps the canonical mechanical contact events');
  const layouts = [];
  for (const [name,width,height] of [['desktop',1280,810],['mobile-landscape',844,390],['mobile-portrait',390,844]]) {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await sleep(250);
    const layout = await page.evaluate(`(()=>{const canvas=document.getElementById('game'),r=canvas.getBoundingClientRect();return {
      width:r.width,height:r.height,glError:canvas.getContext('webgl2').getError(),running:window.__vb.stats.running,
      shaderErrors:window.__vb.stats.shaderErrors,settingsOpen:window.__vb.stats.settingsOpen,error:document.documentElement.dataset.vbLastError||null}})()`);
    assert.equal(layout.running,true); assert.equal(layout.glError,0); assert.equal(layout.error,null);
    assert.equal(layout.settingsOpen,false);
    assert.equal(layout.width,width); assert.equal(layout.height,height); assert.deepEqual(layout.shaderErrors,[]);
    layouts.push({name,...layout}); await screenshot(page,`${name}.png`);
  }
  // Full desktop Chromium requests a favicon for the initial module URL. The
  // production game does not ship that optional icon; every runtime/asset error
  // apart from this exact browser-initiated request remains a failure.
  assert.deepEqual(page.errors.filter(error=>!error.endsWith(`(http://127.0.0.1:${port}/favicon.ico)`)), []);
  assert.deepEqual(await page.evaluate('window.__runtimeErrors'), []);
  const evidence = { staged, closed, doorwayMutation, doorway, breachMutation, breached, outdoorMutation, outdoors, calm, stressed, layouts };
  await writeFile(path.join(artifacts,'live-evidence.json'), JSON.stringify(evidence,null,2));
  await Promise.all(['failure.json','failure.png'].map(file=>rm(path.join(artifacts,file),{force:true})));
  console.log(JSON.stringify({ acousticProfiles:profiles, pcm:Object.fromEntries([['closed',closed],['doorway',doorway],['breached',breached],['outdoors',outdoors]].map(([name,r])=>[name,r.metrics])),
    reloads:[calm.authoritative,stressed.authoritative],layouts,artifacts },null,2));
  console.log('STRESS ACOUSTICS LIVE BROWSER: OK');
} catch (error) {
  if (browser) {
    await screenshot(browser.page,'failure.png').catch(()=>{});
    await writeFile(path.join(artifacts,'failure.json'), JSON.stringify(await browser.page.evaluate(`({stats:window.__vb?.stats,
      shots:window.__acousticShots,reloads:window.__liveReloads,errors:document.documentElement.dataset.vbLastError,consoleErrors:window.__runtimeErrors,
      shoots:window.__liveMessages?.flatMap(m=>m.events||[]).filter(e=>e.kind==='shoot'),
      latest:window.__liveMessages?.slice(-2)})`).catch(()=>({})),null,2));
  }
  throw error;
} finally {
  await browser?.close(); await stopServer(fixture);
}
