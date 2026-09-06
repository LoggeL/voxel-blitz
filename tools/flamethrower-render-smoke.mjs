import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchCdpSession } from './lib/cdp-session.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const server = createServer(async (req, res) => {
  if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<body style="margin:0"></body>'); return; }
  try {
    const file = path.resolve(root, '.' + (req.url.startsWith('/shared/') ? '' : '/public') + new URL(req.url, 'http://localhost').pathname);
    if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream');
    res.end(await readFile(file));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await launchCdpSession(`http://127.0.0.1:${server.address().port}/`);
  const result = await browser.page.evaluate(`(async () => {
    const THREE = await import('/js/vendor/three.module.js');
    const { buildGun } = await import('/js/guns/assemble.js');
    const { MaterialCache } = await import('/js/guns/kit.js');
    const { FlameFX } = await import('/js/weapons/flame.js');
    const { CombatPostProcess } = await import('/js/engine/combat-post-process.js');
    const renderer = new THREE.WebGLRenderer({antialias:true}); renderer.setSize(1100,650);
    document.body.replaceChildren(renderer.domElement);
    const scene = new THREE.Scene(); scene.background = new THREE.Color(0x18252e);
    scene.add(new THREE.HemisphereLight(0xcbe8ff,0x39251c,3));
    const light = new THREE.DirectionalLight(0xffdbac,4); light.position.set(1,4,4); scene.add(light);
    const camera = new THREE.PerspectiveCamera(65,1100/650,.01,100);
    camera.position.set(0,1.6,2); scene.add(camera);
    const gun = buildGun('flamethrower',new MaterialCache());
    gun.root.position.set(.3,-.26,-.4); camera.add(gun.root);
    const floor = new THREE.Mesh(new THREE.BoxGeometry(24,.5,24),new THREE.MeshStandardMaterial({color:0x667079}));
    floor.position.y=-.25; scene.add(floor);
    for (let i=0;i<5;i++) {
      const box = new THREE.Mesh(new THREE.BoxGeometry(1,2,1),new THREE.MeshStandardMaterial({color:0x445763}));
      box.position.set((i-2)*2,1,-8); scene.add(box);
    }
    scene.updateMatrixWorld(true);
    const origin = new THREE.Vector3(); gun.muzzleMarker?.getWorldPosition(origin);
    // Model bundles expose the actual muzzle under the body by name.
    gun.root.getObjectByName('muzzle').getWorldPosition(origin);
    const fx = new FlameFX(scene,()=>0);
    fx.shoot({o:origin.toArray(),d:[0,0,-1]}); fx.update(.16);
    const post = new CombatPostProcess(renderer); post.setSize(1100,650,1);
    post.render(scene,camera,{time:2,burning:1,panic:.95,pain:.3});
    renderer.getContext().finish();
    const active=fx.puffs.filter(p=>p.sprite.visible).length;
    const glError=renderer.getContext().getError();
    const programs=renderer.info.programs.map(p=>p.diagnostics?.runnable !== false);
    return {active,glError,programs};
  })()`);
  assert.ok(result.active > 0); assert.equal(result.glError,0); assert.ok(result.programs.every(Boolean));
  const capture = await browser.page.send('Page.captureScreenshot', {format:'png'});
  await mkdir(path.join(root,'.artifacts'),{recursive:true});
  await writeFile(path.join(root,'.artifacts/flamethrower.png'),Buffer.from(capture.data,'base64'));
  assert.deepEqual(browser.page.errors,[]);
  console.log('Flamethrower WebGL model, flame pool and burning shader:', result);
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
}
