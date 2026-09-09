import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { launchCdpSession } from './lib/cdp-session.mjs';
import { startServer, stopServer, waitForHttp } from './lib/server-process.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = new URL('../.artifacts/animations/stance-sequence.png', import.meta.url);
const server = startServer({ cwd: root, entry: 'tools/capture-server.mjs' });
let browser;
try {
  const port = await server.port;
  await waitForHttp(port);
  browser = await launchCdpSession(`http://127.0.0.1:${port}/avatar-capture.html?weapon=rifle&view=profile`,
    { width: 1440, height: 800 });
  const page = browser.page;
  await page.waitFor(`document.documentElement.dataset.captureReady === 'true'`);
  const result = await page.evaluate(`(async () => {
    const THREE = await import('/js/vendor/three.module.js');
    const { makeAvatar, updateAvatarWeaponPose, updateAvatarStancePose } = await import('/js/avatar/avatar.js');
    const renderer = new THREE.WebGLRenderer({antialias:true, preserveDrawingBuffer:true});
    renderer.setSize(460,330);
    const scene = new THREE.Scene(); scene.background = new THREE.Color(0x17202a);
    scene.add(new THREE.HemisphereLight(0xd7e9ff,0x31281f,2));
    const sun = new THREE.DirectionalLight(0xffead0,3.2); sun.position.set(-3,6,-4);scene.add(sun);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(20,20),new THREE.MeshStandardMaterial({color:0x31414b}));
    floor.rotation.x=-Math.PI/2;scene.add(floor);
    const camera = new THREE.PerspectiveCamera(38,460/330,.01,100);
    camera.position.set(3.7,1.6,-1.7);camera.lookAt(0,.8,.35);
    const av=makeAvatar('stance-preview','Stance','alpha'); av.tag.visible=false;av.hpSpr.visible=false;scene.add(av.group);
    const shots=[['Standing',0,false,0,0],['Crouch',0,true,0,0],['Crouch walk',0,true,.35,.4],
      ['Lowering',.4,false,0,0],['Extending legs',.7,false,0,0],['Prone',1,false,0,0],
      ['Crawl left',1,false,.18,.2],['Crawl right',1,false,-.18,.2]];
    const images=[];
    for(const [label,proneT,crouching,swing,stride] of shots){
      updateAvatarWeaponPose(av,{weapon:'rifle',proneT,crouching,swing,stride,blend:1});
      updateAvatarStancePose(av,{swing,stride});renderer.render(scene,camera);
      images.push({label,src:renderer.domElement.toDataURL('image/png')});
    }
    document.body.innerHTML='<h1>Crouch and prone animation poses</h1><main></main>';
    const style=document.createElement('style');style.textContent='html,body{margin:0;background:#111c27;color:#edf3fa;font:14px system-ui;overflow:auto}body{padding:16px}h1{font-size:20px;margin:0 0 12px}main{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}figure{margin:0;background:#213141}img{display:block;width:100%}figcaption{padding:10px}';document.head.append(style);
    for(const entry of images){const f=document.createElement('figure'),i=document.createElement('img'),c=document.createElement('figcaption');i.src=entry.src;c.textContent=entry.label;f.append(i,c);document.querySelector('main').append(f);}
    return {glError:renderer.getContext().getError(),count:images.length};
  })()`);
  assert.equal(result.glError,0);
  assert.equal(result.count,8);
  await page.waitFor(`Array.from(document.images).every(image=>image.complete)`);
  const capture = await page.send('Page.captureScreenshot', { format: 'png' });
  await mkdir(new URL('.', output), {recursive:true});
  await writeFile(output,Buffer.from(capture.data,'base64'));
  assert.deepEqual(page.errors,[]);
  console.log(`Stance browser render passed: eight poses, no WebGL or browser errors. ${output.pathname}`);
} finally {
  await browser?.close();
  await stopServer(server);
}
