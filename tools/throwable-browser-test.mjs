import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { launchCdpSession } from './lib/cdp-session.mjs';
import { startServer, stopServer } from './lib/server-process.mjs';

const server = startServer();
let browser;
try {
  const port = await server.port;
  browser = await launchCdpSession(`http://127.0.0.1:${port}/weapon-feel-preview.html`);
  const { page } = browser;
  await page.waitFor(`document.documentElement.dataset.previewReady === 'true'`);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  const result = await page.evaluate(`(async () => {
    const THREE = await import('/js/vendor/three.module.js');
    const { ViewmodelRig } = await import('/js/guns/viewmodel.js');
    const { ProjectileFX } = await import('/js/weapons/projectiles.js');
    const { FireFieldFX } = await import('/js/weapons/fire-fields.js');
    const { sfx } = await import('/js/audio/sfx.js');
    const renderer = new THREE.WebGLRenderer({antialias:true}); renderer.setSize(1280,800);
    Object.assign(renderer.domElement.style,{position:'fixed',inset:'0',zIndex:'1000'});
    document.body.append(renderer.domElement);
    const scene = new THREE.Scene(); scene.background = new THREE.Color(0x263c52);
    const camera = new THREE.PerspectiveCamera(75,1280/800,.01,200); camera.position.set(0,1.62,2); scene.add(camera);
    scene.add(new THREE.HemisphereLight(0xd0e7ff,0x514132,2.2));
    const light = new THREE.DirectionalLight(0xffeed6,3); light.position.set(-3,6,4); scene.add(light);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(80,80),new THREE.MeshStandardMaterial({color:0x425362}));
    floor.rotation.x=-Math.PI/2; scene.add(floor,new THREE.GridHelper(80,40,0x8998a2,0x596b78));
    const rig = new ViewmodelRig(camera); rig.setWeapon('rifle');
    const cues = []; rig.onGrenadeCue = event => cues.push(event);
    const fire = new FireFieldFX(scene);
    const projectile = new ProjectileFX(scene,()=>0,{camera});
    const context = {grounded:true,speed:0,aimSwayScale:0};
    function show(type,seconds) {
      rig.cancelGrenade(); cues.length=0;
      rig.grenadeCharge(0,type,0,true);
      for(let i=0;i<Math.ceil(seconds*120);i++) {
        rig.grenadeCharge(Math.min(1,i/144),type,i*1000/120,true); rig.update(1/120,context);
      }
      renderer.render(scene,camera); renderer.getContext().finish();
      const hand=rig._throwableHands;
      const box=new THREE.Box3().setFromObject(hand.models[type]);
      const projected=box.getCenter(new THREE.Vector3()).project(camera);
      return {cues:cues.map(event=>event.cue),visible:hand.models[type].visible&&hand.grip.visible,
        firearm:rig.content.visible,projected:projected.toArray(),pin:hand.pin.visible,
        lit:hand.wickFlame.visible,active:rig.grenadeActive};
    }
    window.throwableCheck={renderer,scene,camera,rig,fire,projectile,show};
    await sfx.unlock(); sfx.grenadeDraw(); sfx.molotovIgnite(); sfx.explosion([0,0,-3],'molotov');
    return show('frag',1.4);
  })()`);
  assert.equal(result.visible, true);
  assert.equal(result.firearm, false);
  assert.deepEqual(result.cues, ['draw', 'pin', 'ready']);
  assert.ok(result.projected.every(Number.isFinite));
  assert.ok(Math.abs(result.projected[0]) < 1 && Math.abs(result.projected[1]) < 1, 'held grenade stays inside viewport');
  await mkdir('.artifacts', { recursive: true });
  async function capture(name) {
    const image = await page.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(`.artifacts/${name}.png`, Buffer.from(image.data, 'base64'));
  }
  await capture('grenade-hold');
  for (const type of ['frag', 'limpet', 'pulse', 'molotov']) {
    const pin = await page.evaluate(`window.throwableCheck.show('${type}',.32)`);
    assert.equal(pin.visible, true);
    assert.ok(pin.cues.includes(type === 'molotov' ? 'ignite' : 'pin'));
    await capture(`${type}-prepare`);
  }
  const burning = await page.evaluate(`(() => {
    const {show,fire,renderer,scene,camera,projectile}=window.throwableCheck;
    show('molotov',1.4);
    const cells=[]; for(let x=-2;x<=2;x++)for(let z=-5;z<=-1;z++)if(Math.hypot(x,z+3)<2.6)cells.push([x,.04,z]);
    fire.sync([{id:'fire-test',ownerId:'test',x:0,y:.04,z:-3,radius:3.2,createdAt:0,expiresAt:6500,cells}],1000);
    fire.update(.1);
    projectile.launch({pid:'bottle',type:'molotov',o:[-1,1.3,-2],v:[0,0,0],fuse:3000});
    renderer.render(scene,camera); renderer.getContext().finish();
    return {instances:fire.geometry.instanceCount,cells:cells.length,gl:renderer.getContext().getError(),
      valid:renderer.info.programs.every(p=>p.diagnostics?.runnable!==false)};
  })()`);
  assert.equal(burning.instances, burning.cells * 2);
  assert.equal(burning.gl, 0);
  assert.equal(burning.valid, true);
  await capture('molotov-fire');
  const cleaned = await page.evaluate(`(() => {
    const {fire,rig}=window.throwableCheck;
    fire.update(10); rig.grenadeThrow(1,'molotov');
    for(let i=0;i<60;i++)rig.update(1/60,{grounded:true});
    return {instances:fire.geometry.instanceCount,fields:fire.fields.size,active:rig.grenadeActive,gun:rig.content.visible};
  })()`);
  assert.deepEqual(cleaned, { instances: 0, fields: 0, active: false, gun: true });
  assert.deepEqual(page.errors, []);
  await page.send('Page.navigate', { url: `http://127.0.0.1:${port}/?debug=1&headless=1` });
  await page.waitFor(`window.__vb && document.getElementById('create-lobby-btn')`);
  await page.evaluate(`document.getElementById('create-lobby-btn').click()`);
  await page.waitFor(`document.getElementById('lobby')?.getAttribute('aria-hidden') === 'false'`);
  await page.evaluate(`(() => {
    for (const [id,value] of [['game-mode-select','fun'],['map-select','depot'],['bot-count','0']]) {
      const select=document.getElementById(id); select.value=value; select.dispatchEvent(new Event('change',{bubbles:true}));
    }
  })()`);
  await page.waitFor(`document.getElementById('map-select').value === 'depot' && document.getElementById('bot-count').value === '0'`);
  await page.evaluate(`document.getElementById('lobby-ready-btn').click()`);
  await page.waitFor(`!document.getElementById('lobby-start-btn').disabled`);
  await page.evaluate(`document.getElementById('lobby-start-btn').click()`);
  await page.waitFor(`window.__vb.stats.running && window.__vb.stats.throwable.counts.length === 4`, { timeoutMs: 30000 });
  async function key(type, name, code, keyCode) {
    await page.send('Input.dispatchKeyEvent', { type, key: name, code, windowsVirtualKeyCode: keyCode });
  }
  for (let i = 0; i < 3; i++) {
    await key('keyDown', 'h', 'KeyH', 72); await key('keyUp', 'h', 'KeyH', 72);
  }
  await page.waitFor(`window.__vb.stats.throwable.type === 'molotov'`);
  await key('keyDown', 'g', 'KeyG', 71);
  await page.waitFor(`window.__vb.stats.throwable.visible && window.__vb.stats.throwable.armed`, { label: 'live bottle raised and lit' });
  await capture('molotov-live-hold');
  await key('keyUp', 'g', 'KeyG', 71);
  await page.waitFor(`window.__vb.stats.throwable.counts[3] === 0`, { label: 'authoritative Molotov inventory consumed' });
  await page.waitFor(`window.__vb.stats.fireFields > 0`, { timeoutMs: 10000, label: 'actual thrown bottle produces authoritative ground fire in browser' });
  await page.waitFor(`!window.__vb.stats.throwable.active`, { timeoutMs: 3000, label: 'throw follow-through completes even on an immediate nearby impact' });
  await capture('molotov-live-impact');
  await page.waitFor(`window.__vb.stats.fireFields === 0`, { timeoutMs: 10000, label: 'live ground fire expires' });
  assert.deepEqual(page.errors, []);
  console.log('Throwable WebGL: all four preparations, visible hold, pin/ignition cues, bottle, ground flames, shader compilation and expiry passed.');
} finally {
  if (browser) await browser.close();
  await stopServer(server);
}
