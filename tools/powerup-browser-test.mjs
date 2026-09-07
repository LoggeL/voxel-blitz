import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { launchCdpSession } from './lib/cdp-session.mjs';
import { waitForHttp } from './lib/server-process.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const artifacts = path.join(root, '.artifacts/powerups');

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
  const child = fork('tools/lib/powerup-browser-fixture.mjs', [], {
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

async function gallery(page) {
  return page.evaluate(`(async () => {
    const THREE=await import('/js/vendor/three.module.js');
    const {PowerupView}=await import('/js/engine/powerup-view.js');
    const {PowerupHud}=await import('/js/ui/powerup-hud.js');
    document.body.replaceChildren();
    const css=document.createElement('link');css.rel='stylesheet';css.href='/style.css';
    document.head.append(css);await new Promise(resolve=>css.onload=resolve);
    document.head.insertAdjacentHTML('beforeend','<style>body{display:block;overflow:hidden;padding:36px;background:#0c1420;color:#eef7ff;font:16px system-ui}h1{font:700 28px system-ui;letter-spacing:0;margin:0 0 8px}p{color:#9eb1c7;margin:0 0 20px}.stage{border:1px solid #2a4058;border-radius:14px;overflow:hidden;width:100%;height:430px}.stage canvas{position:static!important;display:block;width:100%!important;height:430px!important}.demo-status{position:relative;padding:22px;margin-top:18px;border:1px solid #2a4058;border-radius:14px;min-height:104px}.demo-health{width:240px}.demo-status .vb-powerup-toast{top:30px;left:auto;right:24px;transform:none}</style>');
    document.body.innerHTML='<h1>Map power-ups</h1><p>Armor, medkit and ammo. Distinct symbols, colors and names at exposed map locations.</p><div class="stage"></div><div class="demo-status"><div class="demo-health"></div></div>';
    const renderer=new THREE.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});
    renderer.setSize(1208,430);document.querySelector('.stage').append(renderer.domElement);
    const scene=new THREE.Scene();scene.background=new THREE.Color(0x111e2f);
    scene.add(new THREE.HemisphereLight(0xe9f6ff,0x233147,2.5));
    const light=new THREE.DirectionalLight(0xffffff,2);light.position.set(2,7,6);scene.add(light);
    const camera=new THREE.PerspectiveCamera(34,1208/430,.1,100);
    camera.position.set(0,3.8,9);camera.lookAt(0,1,0);
    const view=new PowerupView();scene.add(view.group);
    view.sync(['armor','health','ammo'].map((type,i)=>({id:type,type,x:(i-1)*2.7,y:0,z:0})));
    view.update(.1);renderer.render(scene,camera);
    const hud=new PowerupHud();hud.build(document.querySelector('.demo-status'),document.querySelector('.demo-health'));
    hud.update(50,true);hud.collected({type:'armor',amount:50});
    const allocations={geometries:new Set(),materials:new Set(),textures:new Set()};
    for(const item of view.items.values()) {
      item.root.traverse(object=>{if(object.isMesh)allocations.geometries.add(object.geometry)});
      item.materials.forEach(material=>allocations.materials.add(material));allocations.textures.add(item.texture);
    }
    const disposed={geometries:0,materials:0,textures:0};
    for(const key of Object.keys(allocations))for(const object of allocations[key])object.addEventListener('dispose',()=>disposed[key]++);
    window.__powerupGallery={renderer,view,hud,scene,allocations,disposed};
    const gl=renderer.getContext();gl.finish();
    const pixels=new Uint8Array(1208*430*4);gl.readPixels(0,0,1208,430,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
    let coloredPixels=0;for(let i=0;i<pixels.length;i+=4)if(Math.max(pixels[i],pixels[i+1],pixels[i+2])-Math.min(pixels[i],pixels[i+1],pixels[i+2])>65)coloredPixels++;
    return {types:[...view.items.keys()],colors:[...view.items.values()].map(item=>item.materials[0].color.getHex()),
      meshes:[...view.items.values()].map(item=>item.body.children.length),coloredPixels,drawCalls:renderer.info.render.calls,
      glError:gl.getError(),armor:document.getElementById('armor-status').textContent,toast:document.getElementById('powerup-toast').textContent};
  })()`);
}

async function live(page, port, fixture) {
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.__powerupMessages=[];
    const NativeSocket=window.WebSocket;
    window.WebSocket=class extends NativeSocket {constructor(...args){super(...args);
      this.addEventListener('message',event=>{if(typeof event.data==='string'){
        try{window.__powerupMessages.push(JSON.parse(event.data));}catch{}
      }});
    }};
  ` });
  await page.send('Page.navigate', { url: `http://127.0.0.1:${port}/?debug=1&headless=1&touch=1` });
  await page.waitFor(`document.getElementById('create-lobby-btn')&&!document.getElementById('menu').classList.contains('hidden')`, { label: 'menu' });
  await page.evaluate(`(async()=>{
    const {PowerupView}=await import('/js/engine/powerup-view.js');
    const {PowerupHud}=await import('/js/ui/powerup-hud.js');
    const sync=PowerupView.prototype.sync,dispose=PowerupView.prototype.dispose;
    const collected=PowerupHud.prototype.collected;
    PowerupView.prototype.sync=function(...args){window.__livePowerupView=this;return sync.apply(this,args)};
    PowerupView.prototype.dispose=function(...args){window.__powerupDisposed=true;return dispose.apply(this,args)};
    window.__powerupHudEvents=[];
    PowerupHud.prototype.collected=function(...args){
      window.__livePowerupHud=this;
      const result=collected.apply(this,args);
      const entry={event:args[0],at:performance.now(),until:this.until,hidden:this.toast?.hidden,text:this.toast?.textContent};
      window.__powerupHudEvents.push(entry);
      requestAnimationFrame(()=>{entry.nextFrame={at:performance.now(),hidden:this.toast?.hidden,text:this.toast?.textContent};});
      return result;
    };
  })()`);
  await click(page, 'create-lobby-btn');
  await page.waitFor(`document.getElementById('lobby')?.getAttribute('aria-hidden')==='false'`, { label: 'waiting lobby' });
  await page.evaluate(`(()=>{const select=document.getElementById('game-mode-select');select.value='chaos';select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await page.waitFor(`document.getElementById('lobby-mode-val').textContent.includes('CHAOS')`, { label: 'authoritative Chaos lobby' });
  await page.evaluate(`(()=>{const select=document.getElementById('bot-count');select.value='0';select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await page.waitFor(`window.__powerupMessages.filter(m=>m.t==='lobbyState').at(-1)?.bots===0`, { label: 'zero bots' });
  await click(page, 'lobby-ready-btn');
  await page.waitFor(`document.getElementById('lobby-start-btn')?.disabled===false`, { label: 'ready lobby' });
  await click(page, 'lobby-start-btn');
  await page.waitFor(`window.__vb?.stats?.running&&window.__vb.stats.ringLen>0&&!!window.__livePowerupView`, { timeoutMs: 30_000, label: 'live production game' });
  const staged = await fixture.request('stage');
  await page.waitFor(`window.__powerupMessages.filter(m=>m.t==='tick').at(-1)?.powerups?.length===3&&window.__livePowerupView.items.size===3`, { label: 'real server snapshots render all three pickups' });
  const before = await page.evaluate(`({types:[...window.__livePowerupView.items.values()].map(item=>item.type),armorHidden:document.getElementById('armor-status').hidden})`);
  const collected = await fixture.request('collect');
  await page.waitFor(`window.__powerupMessages.some(m=>m.t==='tick'&&m.events?.some(e=>e.kind==='powerup'&&e.pickupId==='browser-armor'))&&window.__livePowerupView.items.size===2&&!document.getElementById('armor-status').hidden&&document.querySelector('#armor-status b').textContent==='50'`, { label: 'native simulation collection updates live model and armor HUD' });
  await page.waitFor(`!document.getElementById('powerup-toast').hidden&&document.getElementById('powerup-toast').textContent==='ARMOR +50'`, { label: 'interpolated collection feedback appears' });
  const after = await page.evaluate(`(()=>{
    const ticks=window.__powerupMessages.filter(m=>m.t==='tick');
    const event=ticks.flatMap(m=>m.events||[]).find(e=>e.pickupId==='browser-armor');
    return {event,armor:document.querySelector('#armor-status b').textContent,
      toast:document.getElementById('powerup-toast').textContent,
      models:[...window.__livePowerupView.items.values()].map(item=>item.type),
      wireArmor:ticks.at(-1).players.find(p=>p.id===event.id).armor,
      glError:document.getElementById('game').getContext('webgl2').getError(),
      shaderError:window.__vb.stats.shader.lastError,
      hudEvents:window.__powerupHudEvents};
  })()`);
  await screenshot(page, 'live-armor.png');
  // Keep the actual collection feedback visible while comparing layout sizes.
  await page.evaluate(`window.__livePowerupHud.until=performance.now()+60000`);
  const layouts = [];
  for (const [name, width, height, touch] of [
    ['desktop', 1280, 810, false], ['portrait', 390, 844, true], ['landscape', 844, 390, true],
  ]) {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await page.evaluate(`document.documentElement.classList.toggle('vb-touch-mode',${touch})`);
    const layout = await page.evaluate(`new Promise(resolve=>requestAnimationFrame(()=>{
      const rect=id=>{const el=document.getElementById(id),r=el.getBoundingClientRect();return {
        left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height,
        visible:!el.hidden&&getComputedStyle(el).display!=='none'&&r.width>0&&r.height>0};};
      resolve({mode:document.getElementById('hud').dataset.mode,health:rect('healthbar'),economy:rect('econ-cluster'),armor:rect('armor-status'),toast:rect('powerup-toast')});
    }))`);
    assert.equal(layout.mode, 'chaos', `${name}: real Chaos HUD`);
    const { health, economy } = layout;
    assert.ok(health.visible && economy.visible, `${name}: health and economy visible`);
    assert.ok(health.right <= economy.left || economy.right <= health.left
      || health.bottom <= economy.top || economy.bottom <= health.top, `${name}: economy does not overlap armor/health`);
    for (const key of ['armor', 'toast']) {
      const r = layout[key];
      assert.ok(r.visible && r.left >= 0 && r.top >= 0 && r.right <= width && r.bottom <= height, `${name}: ${key} fits viewport`);
    }
    layouts.push({ name, width, height, ...layout });
    await screenshot(page, `chaos-armor-${name}.png`);
  }
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 810, deviceScaleFactor: 1, mobile: false });
  await page.evaluate(`document.documentElement.classList.add('vb-touch-mode')`);
  for (const type of ['keyDown', 'keyUp']) await page.send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape' });
  await page.waitFor(`document.getElementById('settings-leave-btn')?.getBoundingClientRect().width>0`, { label: 'quit control' });
  await click(page, 'settings-leave-btn');
  await page.waitFor(`!document.getElementById('menu').classList.contains('hidden')&&window.__powerupDisposed`, { label: 'quit disposes world pickups' });
  const quit = await page.evaluate(`({models:window.__livePowerupView.items.size,children:window.__livePowerupView.group.children.length,
    detached:window.__livePowerupView.group.parent===null,armorHidden:document.getElementById('armor-status')?.hidden??true,
    toastHidden:document.getElementById('powerup-toast')?.hidden??true,error:document.documentElement.dataset.vbLastError||null})`);
  return { staged, before, collected, after, layouts, quit };
}

const fixture = startFixture();
let browser;
try {
  await mkdir(artifacts, { recursive: true });
  const port = await fixture.port; await waitForHttp(port);
  browser = await launchCdpSession(`http://127.0.0.1:${port}/shared/powerups.js`, { width: 1280, height: 810 });
  const rendered = await gallery(browser.page);
  assert.deepEqual(rendered.types, ['armor', 'health', 'ammo']);
  assert.equal(new Set(rendered.colors).size, 3);
  assert.equal(new Set(rendered.meshes).size, 3, 'distinct model silhouettes');
  assert.ok(rendered.coloredPixels > 1_000, 'visible colored symbols');
  assert.ok(rendered.drawCalls > 20);
  assert.equal(rendered.glError, 0);
  assert.match(rendered.armor, /50/);
  assert.equal(rendered.toast, 'ARMOR +50');
  await screenshot(browser.page, 'powerups.png');
  const disposal = await browser.page.evaluate(`(()=>{
    const g=window.__powerupGallery;g.view.dispose();g.hud.dispose();g.renderer.dispose();
    return {expected:Object.fromEntries(Object.entries(g.allocations).map(([key,set])=>[key,set.size])),disposed:g.disposed,
      empty:g.view.items.size===0&&g.view.group.children.length===0,detached:g.view.group.parent===null,
      hudRemoved:!document.getElementById('armor-status')&&!document.getElementById('powerup-toast')};
  })()`);
  assert.deepEqual(disposal.disposed, disposal.expected);
  assert.ok(disposal.empty && disposal.detached && disposal.hudRemoved);
  const production = await live(browser.page, port, fixture);
  assert.equal(production.before.armorHidden, true);
  assert.equal(production.after.wireArmor, 50);
  assert.equal(production.after.event.id, production.collected.playerId);
  assert.equal(production.after.event.amount, 50);
  assert.equal(production.after.toast, 'ARMOR +50');
  assert.equal(production.after.glError, 0);
  assert.equal(production.after.shaderError, '');
  assert.deepEqual(production.after.models, ['health', 'ammo']);
  assert.deepEqual(production.quit, { models: 0, children: 0, detached: true, armorHidden: true, toastHidden: true, error: null });
  assert.deepEqual(browser.page.errors, []);
  await writeFile(path.join(artifacts, 'browser-evidence.json'), JSON.stringify({ rendered, disposal, production }, null, 2));
  console.log(JSON.stringify({ rendered, disposal, production, screenshot: path.join(artifacts, 'powerups.png') }));
  console.log('POWERUP BROWSER: OK');
} catch (error) {
  if (browser) {
    await screenshot(browser.page, 'failure.png').catch(() => {});
    console.error(await browser.page.evaluate(`JSON.stringify({errors:document.documentElement.dataset.vbLastError,stats:window.__vb?.stats,
      hudEvents:window.__powerupHudEvents,toast:{hidden:document.getElementById('powerup-toast')?.hidden,text:document.getElementById('powerup-toast')?.textContent,until:window.__livePowerupHud?.until,now:performance.now()},
      collectionEvents:window.__powerupMessages?.flatMap(m=>m.events||[]).filter(e=>e.kind==='powerup'),messages:window.__powerupMessages?.slice(-2)})`).catch(() => ''));
  }
  throw error;
} finally {
  await browser?.close(); await fixture.close();
}
