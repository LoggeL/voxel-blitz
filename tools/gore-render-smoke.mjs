import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { launchCdpSession } from './lib/cdp-session.mjs';
import { startServer, stopServer, waitForHttp } from './lib/server-process.mjs';

const server = startServer({ cwd: fileURLToPath(new URL('..', import.meta.url)) });
let browser;
try {
  const port = await server.port;
  await waitForHttp(port);
  browser = await launchCdpSession('http://127.0.0.1:' + port + '/');
  await browser.page.evaluate(`(async () => {
    const THREE = await import('/js/vendor/three.module.js');
    const { GoreFX } = await import('/js/weapons/gore.js');
    const { makeAvatar, beginAvatarDeath, updateAvatarDeath, resetAvatarPose } = await import('/js/avatar/avatar.js');
    const renderer = new THREE.WebGLRenderer({antialias:true});
    renderer.setSize(1100,700);
    document.body.replaceChildren(renderer.domElement);
    const camera = new THREE.PerspectiveCamera(60,1100/700,.1,100);
    camera.position.set(11,10,18); camera.lookAt(0,2,0);
    const scene = new THREE.Scene(); scene.background = new THREE.Color(0x222b36);
    scene.add(new THREE.HemisphereLight(0xffffff,0x778899,3));
    const floor = new THREE.Mesh(new THREE.BoxGeometry(60,1,60),new THREE.MeshLambertMaterial({color:0x999a91}));
    floor.position.y = -.5; scene.add(floor);
    const fx = new GoreFX(scene,camera,(_x,y)=>y<0?1:0);
    const avatar = makeAvatar('splatter-demo','Splatter');
    scene.add(avatar.group);
    beginAvatarDeath(avatar,0,{hs:true});
    fx.gore({vx:0,vy:1.6,vz:0,hs:true},{lethal:true});
    window.goreDemo = {fx,avatar,renderer,scene,camera,updateAvatarDeath,resetAvatarPose};
  })()`);
  await mkdir('.artifacts/gore', {recursive:true});
  for (const [name,frames] of [['burst',18],['bounce',90]]) {
    const result = await browser.page.evaluate(`(() => {
      const {fx,avatar,renderer,scene,camera,updateAvatarDeath} = window.goreDemo;
      for(let i=0;i<${frames};i++) { fx.update(1/60); updateAvatarDeath(avatar,1/60,0.5); }
      renderer.render(scene,camera);
      return {glError:renderer.getContext().getError(),stains:fx.goreStains.filter(p=>p.active).length};
    })()`);
    assert.equal(result.glError,0);
    if(name==='bounce') assert.ok(result.stains>0);
    const capture = await browser.page.send('Page.captureScreenshot',{format:'png'});
    await writeFile('.artifacts/gore/'+name+'.png',Buffer.from(capture.data,'base64'));
  }
  const result = await browser.page.evaluate(`(() => {
    const {fx,avatar,renderer,scene,camera,resetAvatarPose} = window.goreDemo;
    scene.remove(avatar.group);
    for(let i=0;i<40;i++) fx.gore({vx:0,vy:1.6,vz:0,hs:true},{lethal:true});
    fx.update(1/60); renderer.render(scene,camera);
    const calls=renderer.info.render.calls;
    const finite=fx.goreMeshes.every(m=>m.instanceMatrix.array.every(Number.isFinite));
    for(let i=0;i<360;i++) fx.update(.1);
    const expired=[fx.goreChunks,fx.goreDroplets,fx.goreStains,fx.goreMist].every(pool=>pool.every(p=>!p.active));
    resetAvatarPose(avatar);
    const restored=avatar.limbStates.every(l=>l.object.position.equals(l.basePosition));
    return {calls,finite,expired,restored,glError:renderer.getContext().getError()};
  })()`);
  assert.ok(result.calls<=6,'gore draw calls stay bounded during repeated kills');
  assert.ok(result.finite);
  assert.ok(result.expired);
  assert.ok(result.restored);
  assert.equal(result.glError,0);
  console.log('gore render smoke passed',result);
} finally {
  await browser?.close();
  await stopServer(server);
}
