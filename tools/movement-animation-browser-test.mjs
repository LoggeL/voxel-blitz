import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { launchCdpSession } from './lib/cdp-session.mjs';
import { startServer, stopServer, waitForHttp } from './lib/server-process.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = new URL('../.artifacts/animations/vault-sequence.png', import.meta.url);
const server = startServer({ cwd: root, entry: 'tools/capture-server.mjs' });
let browser;
try {
  const port = await server.port;
  await waitForHttp(port);
  browser = await launchCdpSession(`http://127.0.0.1:${port}/weapon-capture.html?weapon=rifle&state=held&headless=1`,
    { width: 1504, height: 740 });
  const page = browser.page;
  await page.waitFor(`document.documentElement.dataset.captureReady === 'true'`);
  await page.evaluate(`(async () => {
    const THREE = await import('/js/vendor/three.module.js');
    const { Input } = await import('/js/engine/input.js');
    const { PlayerPhysics } = await import('/js/player-physics.js');
    const { ViewmodelRig } = await import('/js/guns/viewmodel.js');
    const { VAULT_SECONDS } = await import('/shared/player-movement.js');
    const canvas = document.createElement('canvas');
    document.body.replaceChildren(canvas);
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    renderer.setSize(480, 270);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x6588a5);
    scene.add(new THREE.HemisphereLight(0xe1efff, 0x575345, 2));
    const sun = new THREE.DirectionalLight(0xfff0d5, 2.5);
    sun.position.set(-5, 10, 4); scene.add(sun);
    const camera = new THREE.PerspectiveCamera(75, 480/270, .01, 100);
    camera.rotation.order = 'YXZ'; camera.rotation.y = -Math.PI/2; scene.add(camera);
    const floor = new THREE.Mesh(new THREE.BoxGeometry(20,1,20), new THREE.MeshStandardMaterial({color:0x485d50}));
    floor.position.y = -.5; scene.add(floor);
    const blockGeometry = new THREE.BoxGeometry(.995,.995,.995);
    const stones = [0x73828a,0x87959a,0x636f77].map(color => new THREE.MeshStandardMaterial({color,roughness:1}));
    for(let x=1;x<5;x++) for(let y=0;y<3;y++) for(let z=-2;z<4;z++) {
      const block = new THREE.Mesh(blockGeometry, stones[(x+y+z+6)%3]);
      block.position.set(x+.5,y+.5,z+.5); scene.add(block);
    }
    const physics = new PlayerPhysics();
    physics.solid = (x,y,z) => y<0 || x>=1 && x<5 && y<3 && z>=-2 && z<4;
    physics.pos = {x:.5,y:0,z:.5}; physics.grounded = true;
    const input = new Input(canvas); input.bind(); input.setGameplayEnabled(true);
    const rig = new ViewmodelRig(camera); rig.setWeapon('rifle');
    for(let i=0;i<120;i++) rig.update(1/60,{grounded:true,aimSwayScale:0});
    const images = [];
    const render = label => {
      camera.position.set(physics.pos.x, physics.eyeY(), physics.pos.z);
      renderer.render(scene,camera);
      images.push({label,src:canvas.toDataURL('image/png')});
    };
    const step = () => {
      const keys = input.getKeys();
      physics.step(1/60,{x:0,z:0},4.4,keys.jump,0,-Math.PI/2);
      rig.update(1/60,{grounded:physics.grounded,verticalVelocity:physics.vel.y,
        vaulting:!!physics.vault,vaultProgress:physics.vault?.elapsed/VAULT_SECONDS,aimSwayScale:0});
    };
    window.__motion = {physics,input,rig,renderer,scene,camera,images,render,step};
    render('Ready below a three-block cliff');
  })()`);
  const key = type => page.send('Input.dispatchKeyEvent', { type, key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
  await key('keyDown');
  assert.equal(await page.evaluate(`__motion.step(); __motion.physics.vel.y > 0 && !__motion.physics.vault`), true,
    'first Space jumps normally');
  await key('keyUp');
  assert.equal(await page.evaluate(`(() => { for(let i=0;i<30 && __motion.physics.pos.y<1.1;i++) __motion.step();
    __motion.render('Jump toward the ledge'); return !__motion.physics.grounded && __motion.physics.pos.y>1; })()`), true);
  await key('keyDown');
  assert.equal(await page.evaluate(`__motion.step(); !!__motion.physics.vault && __motion.physics.vault.to.y===3`), true,
    'second Space while airborne grabs a reachable cliff without holding a movement key');
  await key('keyUp');
  const result = await page.evaluate(`(() => {
    for(let i=0;i<7;i++) __motion.step(); __motion.render('Reach and grab');
    const handsVisible = __motion.rig._vaultHands.root.visible;
    for(let i=0;i<8;i++) __motion.step(); __motion.render('Brace and pull up');
    for(let i=0;i<9;i++) __motion.step(); __motion.render('Push over the edge');
    for(let i=0;i<65;i++) __motion.step(); __motion.render('Weapon returns, standing on top');
    const p=__motion.physics;
    return {handsVisible,landed:p.grounded && !p.vault && p.pos.y===3,
      handsHidden:!__motion.rig._vaultHands.root.visible,position:p.pos,glError:__motion.renderer.getContext().getError()};
  })()`);
  assert.ok(result.handsVisible && result.handsHidden && result.landed, JSON.stringify(result));
  assert.equal(result.glError, 0);
  await page.evaluate(`(() => {
    __motion.input.dispose();
    document.body.innerHTML='<h1>Midair vault animation</h1><p>Space to jump. Press Space again within reach of the cliff to grab and climb.</p><main></main>';
    const style=document.createElement('style');
    style.textContent='html,body{margin:0;width:100%;height:auto;overflow:auto;background:#111c27;color:#edf3fa;font:14px system-ui}body{padding:20px;box-sizing:border-box}h1{font-size:22px;margin:0 0 5px}p{color:#b2c4d4;margin:0 0 18px}main{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}figure{margin:0;background:#213141}img{display:block;width:100%}figcaption{padding:10px}';
    document.head.append(style);
    for(const entry of __motion.images){const f=document.createElement('figure'),i=document.createElement('img'),c=document.createElement('figcaption');i.src=entry.src;c.textContent=entry.label;f.append(i,c);document.querySelector('main').append(f);}
  })()`);
  await page.waitFor(`Array.from(document.images).every(image=>image.complete)`);
  const capture = await page.send('Page.captureScreenshot', { format: 'png' });
  await mkdir(new URL('.', output), { recursive: true });
  await writeFile(output, Buffer.from(capture.data, 'base64'));
  assert.deepEqual(page.errors, [], 'browser renders the full animation sequence without errors');
  console.log(`Browser movement animation passed: actual Space press/release/repress, current-height cliff climb, hands, recovery, WebGL. ${output.pathname}`);
} finally {
  await browser?.close();
  await stopServer(server);
}
