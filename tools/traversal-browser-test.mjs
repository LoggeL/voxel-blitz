import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { launchCdpSession } from './lib/cdp-session.mjs';
import { startServer, stopServer, waitForHttp } from './lib/server-process.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = new URL('../.artifacts/traversal/', import.meta.url);
const server = startServer({ cwd: root, entry: 'tools/capture-server.mjs' });
let browser;
try {
  const port = await server.port;
  await waitForHttp(port);
  browser = await launchCdpSession(`http://127.0.0.1:${port}/weapon-capture.html?weapon=rifle&state=held&headless=1`,
    { width: 1100, height: 700 });
  const page = browser.page;
  await page.waitFor(`document.documentElement.dataset.captureReady === 'true'`);
  await page.evaluate(`(async () => {
    const THREE = await import('/js/vendor/three.module.js');
    const { Input } = await import('/js/engine/input.js');
    const { LocalPlayer } = await import('/js/player/local-player.js');
    const { WeaponState } = await import('/js/guns/weapon-state.js');
    const { ViewmodelRig } = await import('/js/guns/viewmodel.js');
    const canvas = document.createElement('canvas');
    document.body.replaceChildren(canvas);
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    renderer.setSize(1100, 700);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x839cae);
    scene.add(new THREE.HemisphereLight(0xf0f5ff, 0x667756, 3));
    const sun = new THREE.DirectionalLight(0xffe5bf, 3);
    sun.position.set(-5, 8, 3); scene.add(sun);
    const camera = new THREE.PerspectiveCamera(75, 1100/700, .01, 100);
    camera.rotation.order = 'YXZ'; scene.add(camera);
    const cube = (x,y,z,color) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(.995,.995,.995), new THREE.MeshStandardMaterial({color}));
      mesh.position.set(x+.5,y+.5,z+.5); scene.add(mesh);
    };
    for(let x=-3;x<10;x++) for(let z=-4;z<5;z++) cube(x,-1,z,0x627458);
    for(let x=1;x<4;x++) for(let y=0;y<3;y++) for(let z=-2;z<=2;z++) {
      if(y===0 && z===0) continue;
      cube(x,y,z,(x+y+z)%2 ? 0x8b9697 : 0x6c7a81);
    }
    const input = new Input(canvas); input.bind(); input.fallback = true;
    const player = new LocalPlayer({input}); player.setGameplayInputEnabled(true);
    const physics = player.physics;
    physics.solid = (x,y,z) => y<0 || (x>=1 && x<4 && y<3 && (y>=1 || z!==0));
    physics.pos = {x:.5,y:0,z:.5}; physics.grounded=true;
    player.view.yaw=-Math.PI/2;
    const rig = new ViewmodelRig(camera);
    rig.setWeapon('rifle');
    let now=2000;
    const weapon = new WeaponState({rig, now:()=>now,
      audio:{draw(){},reloadClick(){},fire(){}},effects:{shoot(){}},feedback:{addExhaustion(){},addRecoil(){}},
      network:{isRunning:()=>true,isCurrentGeneration:()=>true},setTimer:()=>0,clearTimer(){} });
    weapon.resetToLoadout();
    const step = (count=1) => {
      for(let i=0;i<count;i++) {
        now+=1000/60;
        player.update(1/60,now,{weapon,fireAllowed:true,
          onWeaponIntents:intents=>weapon.applyIntents(intents,now,{allowFire:true,alive:true}),
          beforeSend:()=>weapon.tickReload(now)});
        weapon.settleFrame(1/60,{vaulting:!!physics.vault});
        player.updateCamera(1/60,camera,weapon.def,weapon.adsT,75);
        rig.update(1/60,{speed:player.currentSpeedXZ,grounded:physics.grounded,proneT:physics.proneT,
          vaulting:!!physics.vault,vaultProgress:physics.vault?.elapsed/.48});
      }
      renderer.render(scene,camera);
    };
    window.__traversal={input,player,physics,weapon,rig,renderer,step};
    step(90);
  })()`);
  const key = (code, pressed) => page.send('Input.dispatchKeyEvent', {
    type: pressed ? 'keyDown' : 'keyUp', code, key: code === 'Space' ? ' ' : code.slice(-1).toLowerCase(),
  });
  const capture = async name => {
    const shot = await page.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(new URL(name, output), Buffer.from(shot.data, 'base64'));
  };
  await mkdir(output, { recursive: true });
  await key('KeyW', true);
  assert.equal(await page.evaluate(`__traversal.step(60); __traversal.physics.pos.x<.68`), true,
    'standing cannot enter the opening');
  await key('KeyX', true); await key('KeyX', false);
  assert.equal(await page.evaluate(`__traversal.step(130); __traversal.physics.pos.x>2 && __traversal.physics.proneT===1`), true,
    'real X and W inputs crawl inside');
  await key('KeyW', false);
  await key('KeyX', true); await key('KeyX', false);
  await key('Space', true);
  assert.equal(await page.evaluate(`__traversal.step(60); __traversal.physics.proneT===1 && __traversal.physics.pos.y===0`), true,
    'X and Space cannot stand or jump through the ceiling');
  await capture('under-roof.png');
  await key('Space', false); await key('KeyW', true);
  assert.equal(await page.evaluate(`__traversal.step(240); __traversal.physics.pos.x>5 && __traversal.physics.proneT===0`), true,
    'standing resumes outside');
  await key('KeyW', false);
  await page.evaluate(`(() => {
    const t=__traversal;
    t.physics.solid=(x,y)=>y<0 || (x>=1 && x<4 && y<2);
    t.physics.pos={x:.5,y:0,z:.5}; t.physics.vel={x:0,y:0,z:0};t.physics.grounded=true;
    t.weapon._ammo.rifle.mag=5;
  })()`);
  await key('KeyR', true); await key('KeyW', true); await key('Space', true);
  assert.equal(await page.evaluate(`__traversal.step(); __traversal.weapon.isReloading && !__traversal.physics.vault && __traversal.physics.climbBlocked`), true,
    'simultaneous R/W/Space cannot start a climb');
  await key('KeyR', false); await key('Space', false);
  assert.equal(await page.evaluate(`(() => {for(let i=0;i<30;i++){__traversal.step();if(__traversal.physics.vault)return false;}return true;})()`), true,
    'automatic airborne grabs remain blocked during reload');
  await capture('reload-blocked.png');
  await key('KeyW', false);
  await page.evaluate(`(() => {
    const t=__traversal;t.step(180);
    t.weapon.reconcileServer({weapon:0,reloading:false,reloadAck:t.weapon.reloadId,alive:true},10000);
    t.physics.pos={x:.5,y:0,z:.5};t.physics.vel={x:0,y:0,z:0};t.physics.grounded=true;
  })()`);
  await key('KeyW', true); await key('Space', true);
  assert.equal(await page.evaluate(`__traversal.step(); !!__traversal.physics.vault && !__traversal.physics.climbBlocked`), true,
    'completed reload releases climbing');
  assert.equal(await page.evaluate(`__traversal.renderer.getContext().getError()`), 0);
  assert.deepEqual(page.errors, []);
  console.log(`Browser traversal passed: real X/W/Space/R inputs, one-block crawl, blocked stand/jump, first-frame reload lock, automatic grab lock and recovery. ${output.pathname}`);
} finally {
  await browser?.close();
  await stopServer(server);
}
