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
    const { FLAME_RULES } = await import('/shared/flame-rules.js');
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
    fx.muzzleProvider = point=>point.copy(origin);
    let minimumActive = Infinity;
    for (let frame = 0; frame < 144; frame++) {
      if (frame % 6 === 0) fx.shoot({o:origin.toArray(),d:[0,0,-1]}, {local:true});
      fx.setLocalStream(true,[0,0,-1],origin.toArray());
      fx.update(1/120);
      if (frame > 72) minimumActive = Math.min(minimumActive, fx.geometry.instanceCount);
    }
    const continuity = [];
    for (const fps of [30,60,120]) {
      const stream = new FlameFX(scene,()=>0);
      stream.muzzleProvider = point=>point.set(0,4,0);
      let nextShot = 0, maxGap = 0, maxNear = 0, behindMuzzle = false, worstPair = null;
      for (let frame = 0; frame < fps * 1.2; frame++) {
        const time = frame / fps;
        if (time + 1e-9 >= nextShot) {
          stream.shoot({o:[0,4,0],d:[0,0,-1]}, {local:true});
          nextShot += FLAME_RULES.cadence;
        }
        stream.setLocalStream(true,[0,0,-1],[0,4,0]);
        stream.update(1/fps);
        const positions = stream.puffs.filter(p=>!p.ember && p.age<p.life).map(p=>-p.position.z).sort((a,b)=>a-b);
        behindMuzzle ||= positions.some(z=>z<0);
        if (frame > fps*.6) {
          maxNear = Math.max(maxNear,positions[0]);
          for(let i=1;i<positions.length;i++) if(positions[i]-positions[i-1]>maxGap) {maxGap=positions[i]-positions[i-1]; worstPair=[frame,positions[i-1],positions[i]];}
        }
      }
      stream.setLocalStream(false);
      const releasedCursor = stream.cursor;
      stream.update(1/fps);
      const immediateRelease = stream.cursor===releasedCursor;
      stream.update(1);
      const drained = stream.geometry.instanceCount===0;
      continuity.push({fps,maxGap,maxNear,worstPair,behindMuzzle,immediateRelease,drained});
      stream.dispose();
    }
    const active = fx.geometry.instanceCount;
    const farthest = Math.max(...fx.puffs.filter(p=>p.age<p.life).map(p=>p.position.distanceTo(origin)));
    const flameScene = new THREE.Scene();
    const onlyFlame = new FlameFX(flameScene,()=>0);
    onlyFlame.shoot({o:[0,1,-1],d:[0,0,-1]}); onlyFlame.update(.01);
    renderer.render(flameScene,camera);
    const drawCalls = renderer.info.render.calls;
    onlyFlame.dispose();
    const clipped = new FlameFX(scene,(x,y,z)=>z < -2 ? 1 : 0);
    clipped.shoot({o:[0,1,0],d:[0,0,-1]});
    clipped.update(.08);
    const wallClipped = clipped.geometry.instanceCount === 0;
    clipped.dispose();
    const nozzleBlocked = new FlameFX(scene,(x,y,z)=>z < -1 ? 1 : 0);
    nozzleBlocked.muzzleProvider = point=>point.set(0,1,-3);
    nozzleBlocked.shoot({o:[0,1,0],d:[0,0,-1]}, {local:true}); nozzleBlocked.update(.01);
    const closeWallBlocked = nozzleBlocked.geometry.instanceCount===0;
    nozzleBlocked.dispose();
    const followed = new FlameFX(scene,()=>0);
    followed.muzzleProvider = point=>point.set(3,2,1);
    followed.shoot({o:[0,0,0],d:[0,0,-1]}, {local:true});
    const followsMuzzle = followed.puffs[0].position.x===3;
    const remoteStart = followed.cursor;
    followed.shoot({o:[9,2,1],d:[0,0,-1]});
    const remoteOrigin = followed.puffs[remoteStart].position.x===9;
    for(let i=0;i<1000;i++) followed.shoot({o:[0,1,0],d:[0,0,-1]});
    followed.update(.01);
    const bounded = followed.puffs.length===512 && followed.geometry.instanceCount<=512;
    followed.update(2);
    const stalledExpired = followed.geometry.instanceCount===0;
    followed.dispose();
    const nearMuzzle = Math.min(...fx.puffs.filter(p=>p.age<p.life).map(p=>p.position.distanceTo(origin)));
    fx.setLocalStream(false);
    const keepalive = new FlameFX(scene,()=>0);
    keepalive.setLocalStream(true,[0,0,-1]); keepalive.update(.01);
    const requiresShot = keepalive.cursor===0;
    keepalive.shoot({o:[0,1,0],d:[0,0,-1]},{local:true});
    keepalive.setLocalStream(true,[0,0,-1]);
    keepalive.update(.1);
    const expiredCursor = keepalive.cursor;
    keepalive.update(.01);
    const keepaliveExpired = keepalive.cursor===expiredCursor;
    keepalive.dispose();
    const cursorAtRelease = fx.cursor;
    // Show the flowing particles before advancing the release check.

    const post = new CombatPostProcess(renderer); post.setSize(1100,650,1);
    post.render(scene,camera,{time:2,burning:1,panic:.95,pain:.3});
    renderer.getContext().finish();
    window.flameSmoke = fx;
    const glError=renderer.getContext().getError();
    const programs=renderer.info.programs.map(p=>p.diagnostics?.runnable !== false);
    return {continuity,active,minimumActive,farthest,nearMuzzle,drawCalls,requiresShot,keepaliveExpired,closeWallBlocked,wallClipped,followsMuzzle,remoteOrigin,bounded,stalledExpired,cursorAtRelease,glError,programs};
  })()`);
  assert.ok(result.active > 40); assert.ok(result.minimumActive > 40); assert.ok(result.farthest > 16); assert.ok(result.nearMuzzle < .4);
  for (const sample of result.continuity) {
    assert.ok(sample.maxGap < .31, 'Continuous particle spacing at '+sample.fps+' fps: '+sample.maxGap);
    assert.ok(sample.maxNear <= .3, 'Muzzle continuity at '+sample.fps+' fps');
    assert.equal(sample.behindMuzzle,false);
    assert.equal(sample.immediateRelease,true);
    assert.equal(sample.drained,true);
  }
  assert.equal(result.drawCalls,1);
  for (const check of ['requiresShot','keepaliveExpired','closeWallBlocked','wallClipped','followsMuzzle','remoteOrigin','bounded','stalledExpired']) assert.equal(result[check],true,check);
  assert.equal(result.glError,0); assert.ok(result.programs.every(Boolean));
  const capture = await browser.page.send('Page.captureScreenshot', {format:'png'});
  await mkdir(path.join(root,'.artifacts'),{recursive:true});
  await writeFile(path.join(root,'.artifacts/flamethrower-stream.png'),Buffer.from(capture.data,'base64'));
  const release = await browser.page.evaluate(`(() => {
    const fx = window.flameSmoke;
    for (let i=0;i<90;i++) fx.update(1/120);
    const result = {active:fx.geometry.instanceCount,cursor:fx.cursor};
    fx.dispose();
    return result;
  })()`);
  assert.equal(release.active,0);
  assert.equal(release.cursor,result.cursorAtRelease);
  assert.deepEqual(browser.page.errors,[]);
  console.log('Flamethrower WebGL model, flame pool and burning shader:', result);
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
}
