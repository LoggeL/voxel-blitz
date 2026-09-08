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
  await page.evaluate(`(async () => {
    const THREE = await import('/js/vendor/three.module.js');
    const { FlameFX } = await import('/js/weapons/flame.js');
    const scene = new THREE.Scene(); scene.background = new THREE.Color(0x263c52);
    const camera = new THREE.PerspectiveCamera(65, 1.6, .01, 100); camera.position.set(3,2,4); camera.lookAt(0,1,-5);
    const renderer = new THREE.WebGLRenderer(); renderer.setSize(960,600);
    Object.assign(renderer.domElement.style,{position:'fixed',inset:'0',zIndex:'1000'}); document.body.append(renderer.domElement);
    const fx = new FlameFX(scene, () => 0);
    window.fireSpriteCheck = { fx, scene, camera, renderer };
  })()`);
  await page.waitFor(`window.fireSpriteCheck.fx.material.uniforms.fireAtlas.value.image?.width > 0`);
  const result = await page.evaluate(`(() => {
    const {fx,scene,camera,renderer} = window.fireSpriteCheck;
    fx.shoot({o:[0,1,0],d:[0,0,-1]}); fx.update(.12);
    renderer.render(scene,camera); renderer.getContext().finish();
    const first = renderer.domElement.toDataURL();
    fx.update(.08); renderer.render(scene,camera); renderer.getContext().finish();
    return {changed:first !== renderer.domElement.toDataURL(), instances:fx.geometry.instanceCount,
      gl:renderer.getContext().getError(), valid:renderer.info.programs.every(p=>p.diagnostics?.runnable!==false)};
  })()`);
  assert(result.changed); assert(result.instances > 0); assert.equal(result.gl,0); assert(result.valid);
  await mkdir('.artifacts',{recursive:true});
  const shot = await page.send('Page.captureScreenshot',{format:'png'});
  await writeFile('.artifacts/flame-sprites.png',Buffer.from(shot.data,'base64'));
  assert.deepEqual(page.errors,[]);
  console.log('Fire sprite WebGL: atlas loads, flame shader compiles, animated frames render, no GL or browser errors.');
} finally {
  if(browser) await browser.close();
  await stopServer(server);
}
