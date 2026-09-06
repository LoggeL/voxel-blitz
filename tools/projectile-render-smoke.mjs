import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { launchCdpSession } from './lib/cdp-session.mjs';
import { startServer, stopServer, waitForHttp } from './lib/server-process.mjs';

const server = startServer({ cwd: fileURLToPath(new URL('..', import.meta.url)) });
let browser;
try {
  const port = await server.port;
  await waitForHttp(port);
  browser = await launchCdpSession(`http://127.0.0.1:${port}/`);
  const result = await browser.page.evaluate(`(async () => {
    const THREE = await import('/js/vendor/three.module.js');
    const {ProjectileFX} = await import('/js/weapons/projectiles.js');
    const renderer = new THREE.WebGLRenderer(); renderer.setSize(960,540);
    document.body.replaceChildren(renderer.domElement);
    const camera = new THREE.PerspectiveCamera(65,960/540,.1,100);
    camera.position.set(0,10,22); camera.lookAt(0,2,0);
    const scene = new THREE.Scene(); scene.background = new THREE.Color(0x202830);
    scene.add(new THREE.AmbientLight(0xffffff,1));
    const floor = new THREE.Mesh(new THREE.BoxGeometry(45,1,45), new THREE.MeshStandardMaterial({color:0x777777}));
    scene.add(floor);
    const fx = new ProjectileFX(scene,()=>0,{camera});
    for(let i=0;i<192;i++) fx.launch({pid:String(i),type:'rocket',chaos:2,
      o:[(i%16-7.5)*1.2,2+Math.floor(i/16)*.35,-Math.floor(i/16)],v:[0,0,-1],fuse:20000});
    fx.update(1/60); renderer.render(scene,camera); renderer.getContext().finish();
    const samples=[];
    for(let i=0;i<24;i++) {
      const start=performance.now(); fx.update(1/60); renderer.render(scene,camera);
      renderer.getContext().finish(); samples.push(performance.now()-start);
    }
    samples.sort((a,b)=>a-b);
    let lights=0; scene.traverse(o=>{if(o.isPointLight)lights++});
    return {rockets:fx.projectiles.size,lights,medianFrameMs:samples[12],
      drawCalls:renderer.info.render.calls,glError:renderer.getContext().getError()};
  })()`);
  assert.equal(result.rockets, 192);
  assert.equal(result.lights, 4);
  assert.ok(result.drawCalls <= 5, 'rocket draw submissions remain constant');
  assert.equal(result.glError, 0);
  if (process.env.PROJECTILE_SCREENSHOT) {
    const capture = await browser.page.send('Page.captureScreenshot', {format:'png'});
    await writeFile(process.env.PROJECTILE_SCREENSHOT, Buffer.from(capture.data, 'base64'));
  }
  console.log(JSON.stringify(result));
} finally {
  await browser?.close();
  await stopServer(server);
}
