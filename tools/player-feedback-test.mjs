import assert from 'node:assert/strict';
import { launchCdpSession } from './lib/cdp-session.mjs';
import { startServer, stopServer, waitForHttp } from './lib/server-process.mjs';
const server = startServer({cwd:process.cwd()});
let browser;
try {
  const port=await server.port;await waitForHttp(port);
  browser=await launchCdpSession(`http://127.0.0.1:${port}/`);
  const result=await browser.page.evaluate(`(async()=>{
    const THREE=await import('/js/vendor/three.module.js');
    const {Scoreboard}=await import('/js/ui/scoreboard.js');
    const {AvatarRoster}=await import('/js/avatar/avatar-roster.js');
    const {MuzzleLights}=await import('/js/engine/muzzle-lights.js');
    const {makeFlash}=await import('/js/guns/kit.js');
    const {raycastVoxels}=await import('/shared/raycast.js');
    let checks=0;const check=(v,m)=>{if(!v)throw Error(m);checks++};
    const parent=document.createElement('div');const sb=new Scoreboard();sb.build(parent);
    const rows=[{id:'self',name:'Me',team:'alpha',ping:42},{id:'enemy',name:'Enemy',team:'bravo',ping:null}];
    for(const mode of ['fun','chaos','training','tdm','snd','gungame']) {
      sb.update(rows,{mode},'self');
      check([...parent.querySelectorAll('thead tr')].every(r=>r.lastChild.textContent==='PING'),'ping header '+mode);
      check(parent.querySelector('[data-pid="self"]').lastChild.textContent==='42 ms','ping cell '+mode);
      check(parent.querySelector('[data-pid="enemy"]').lastChild.textContent==='—','unknown ping '+mode);
    }
    rows[0].ping=78;sb.update(rows,{mode:'fun'},'self');check(parent.querySelector('[data-pid="self"]').lastChild.textContent==='78 ms','ping refresh');sb.dispose();
    const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera();camera.position.set(.5,1.5,.5);
    const roster=new AvatarRoster({scene});
    const avatar={alive:true,team:'bravo',group:new THREE.Group(),head:new THREE.Object3D(),tag:new THREE.Sprite(),hpSpr:new THREE.Sprite()};
    avatar.group.add(avatar.head);avatar.head.position.set(.5,1.5,-4.5);roster._avatars.set('enemy',avatar);
    let wall=true;const ray=(o,d,n)=>raycastVoxels((x,y,z)=>wall&&z===-2?1:0,o.x,o.y,o.z,d.x,d.y,d.z,n);
    roster.updateLabels(camera,ray,'tdm','alpha');check(!avatar.tag.visible&&!avatar.hpSpr.visible,'wall hides labels');check(avatar.tag.material.color.getHex()===0xff4055,'enemy red');
    wall=false;roster.updateLabels(camera,ray,'tdm','alpha');check(avatar.tag.visible,'destroyed wall reveals enemy');
    roster.updateLabels(camera,ray,'tdm','bravo');check(avatar.tag.material.color.getHex()===0x69cfff,'teammate blue');
    roster.updateLabels(camera,ray,'fun','bravo');check(avatar.tag.material.color.getHex()===0xff4055,'FFA red regardless of team');
    avatar.alive=false;roster.updateLabels(camera,ray,'fun',null);check(!avatar.tag.visible,'dead label hidden');
    const renderer=new THREE.WebGLRenderer();renderer.setSize(100,100);camera.position.set(0,0,5);
    scene.add(new THREE.Mesh(new THREE.BoxGeometry(),new THREE.MeshStandardMaterial()));
    const pool=new MuzzleLights(scene);const flashes=Array.from({length:3},()=>makeFlash());for(const f of flashes)scene.add(f.grp);
    flashes.forEach(f=>{f.grp.visible=true});pool.update(null,new Map(),camera);renderer.render(scene,camera);const programs=renderer.info.programs.length;
    for(let mask=0;mask<8;mask++) {
      flashes.forEach((f,i)=>{f.grp.visible=!!(mask&(1<<i));f.light.intensity=f.grp.visible?2:0});
      pool.update(flashes[0].light,new Map(),camera);renderer.render(scene,camera);
      check(renderer.info.programs.length===programs,'firing does not compile a new shader '+mask);
    }
    const fixedPrograms=renderer.info.programs.length;
    flashes.forEach(f=>{f.light.visible=true});
    for(let mask=0;mask<8;mask++) {
      flashes.forEach((f,i)=>{f.grp.visible=!!(mask&(1<<i))});renderer.render(scene,camera);
    }
    const dynamicPrograms=renderer.info.programs.length;
    check(dynamicPrograms>fixedPrograms,'old changing light count reproduces shader variants');
    pool.dispose();check(!scene.children.some(o=>o.isPointLight),'pool disposed');renderer.dispose();
    return {checks,fixedPrograms,dynamicPrograms};
  })()`);
  assert.ok(result.checks>=30);console.log(result);
} finally {await browser?.close();await stopServer(server);}
