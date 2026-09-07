import { writeFile } from 'node:fs/promises';
import { launchCdpSession } from './lib/cdp-session.mjs';
import { startServer, stopServer } from './lib/server-process.mjs';

const server = startServer();
let browser;
try {
  browser = await launchCdpSession(`http://127.0.0.1:${await server.port}/weapon-feel-preview.html`);
  const data = await browser.page.evaluate(`(async () => {
    const THREE = await import('/js/vendor/three.module.js');
    const {ProjectileFX}=await import('/js/weapons/projectiles.js');
    const scene=new THREE.Scene();
    const camera=new THREE.OrthographicCamera(-.43,.43,.52,-.34,.01,10);
    camera.position.set(0,.15,2); camera.lookAt(0,.15,0);
    scene.add(new THREE.HemisphereLight(0xffefd1,0x3b4627,2));
    const light=new THREE.DirectionalLight(0xffe2a9,3);light.position.set(-2,3,4);scene.add(light);
    const fx=new ProjectileFX(scene);fx.launch({pid:'icon',type:'molotov',o:[0,0,0],v:[0,0,0],fuse:5000});
    fx.projectiles.get('icon').group.rotation.z=-.18;
    const renderer=new THREE.WebGLRenderer({alpha:true,antialias:true,preserveDrawingBuffer:true});
    renderer.setSize(480,480);renderer.setClearColor(0,0);renderer.render(scene,camera);
    const data=renderer.domElement.toDataURL('image/png').split(',')[1];fx.dispose();renderer.dispose();return data;
  })()`);
  await writeFile('public/assets/grenades/hud/molotov.png', Buffer.from(data, 'base64'));
  console.log('Rendered transparent Molotov shop icon from the in-game projectile model.');
} finally {
  if (browser) await browser.close();
  await stopServer(server);
}
