import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { launchCdpSession } from './lib/cdp-session.mjs';
import { startServer, stopServer } from './lib/server-process.mjs';

// Render the actual shipped sphere meshes and materials. Pixel readback proves
// that the WebGL field moves, freezes and responds to authority corrections.
const server = startServer({ entry: 'tools/capture-server.mjs', failureContext: 'TB-4 plasma WebGL' });
let session;
try {
  session = await launchCdpSession(`http://127.0.0.1:${await server.port}/titanfall-weapon-capture.html`);
  const page = session.page;
  await page.waitFor('window.__tfw?.ready', { timeoutMs: 90000 });
  const report = await page.evaluate(`(async () => {
    const T = await import('/js/vendor/three.module.js');
    const { buildGun, disposeGunModels } = await import('/js/guns/assemble.js');
    const { MaterialCache } = await import('/js/guns/kit.js');
    const { thunderboltAnimationFor } = await import('/js/guns/thunderbolt-animation.js');
    const cache = new MaterialCache(), gun = buildGun('thunderbolt', cache);
    const parts = gun.extra.userData.thunderbolt;
    const animation = thunderboltAnimationFor(gun);
    const width = 640, height = 192;
    const renderer = new T.WebGLRenderer({ antialias: false });
    renderer.setSize(width,height);
    renderer.setClearColor(0x0b0d15,1);
    renderer.outputColorSpace = T.SRGBColorSpace;
    renderer.debug.checkShaderErrors = true;
    const target = new T.WebGLRenderTarget(width,height);
    const scene = new T.Scene();
    const camera = new T.PerspectiveCamera(20,width/height,.001,2);
    camera.position.set(0,0,.27);
    camera.lookAt(0,0,0);
    let fields = 0;
    for (const [index, group] of [...parts.rounds,parts.energy].entries()) {
      group.traverse(source => {
        if(!source.isMesh || !parts.plasma.materials.includes(source.material)) return;
        // Exported positions are baked in gun space. Center the actual geometry
        // for this diagnostic gallery without cloning or editing its vertices.
        const center = source.geometry.boundingBox.getCenter(new T.Vector3());
        const mesh = new T.Mesh(source.geometry,source.material);
        mesh.position.set((index-2)*.052-center.x,-center.y,-center.z);
        scene.add(mesh);
        fields++;
      });
    }
    const frame = () => {
      renderer.setRenderTarget(target);
      renderer.render(scene,camera);
      const pixels = new Uint8Array(width*height*4);
      renderer.readRenderTargetPixels(target,0,0,width,height,pixels);
      return pixels;
    };
    const difference = (a,b) => {
      let pixels=0,total=0,maximum=0;
      for(let i=0;i<a.length;i+=4) {
        const delta=Math.max(Math.abs(a[i]-b[i]),Math.abs(a[i+1]-b[i+1]),Math.abs(a[i+2]-b[i+2]));
        if(delta>1)pixels++;
        total+=delta; maximum=Math.max(maximum,delta);
      }
      return {pixels,total,maximum};
    };
    try {
      const initial=frame(), startTime=parts.plasma.time;
      animation.update(.41);
      const moving=frame(), movingTime=parts.plasma.time;
      animation.update(.5,{reducedMotion:true});
      const still=frame(), frozenTime=parts.plasma.time;
      animation.fire(); animation.setState({mag:3});
      const discharge=frame();
      animation.setState({mag:4});
      const corrected=frame();
      const baseProgramCount=renderer.info.programs.length;
      // Remote weapons render inside the world's fog. Dense fog must erase the
      // field against an equal-colored background, not leave a visible beacon.
      for(const mesh of scene.children)mesh.visible=false;
      const background=frame();
      for(const mesh of scene.children)mesh.visible=true;
      const fog=[];
      for(const kind of ['linear','exponential']) {
        scene.fog=kind==='linear' ? new T.Fog(0x0b0d15,0,.02) : new T.FogExp2(0x0b0d15,100);
        const dense=frame();
        scene.fog=kind==='linear' ? new T.Fog(0x0b0d15,1,2) : new T.FogExp2(0x0b0d15,0);
        const clear=frame();
        fog.push({kind,dense:difference(background,dense),clear:difference(corrected,clear)});
      }
      scene.fog=null;
      const unfogged=frame();
      let visiblePixels=0;
      for(let i=0;i<initial.length;i+=4) {
        if(Math.max(Math.abs(initial[i]-initial[0]),Math.abs(initial[i+1]-initial[1]),Math.abs(initial[i+2]-initial[2]))>5)visiblePixels++;
      }
      const gl=renderer.getContext();
      return {source:gun.body.userData.blenderAsset,fields,visiblePixels,startTime,movingTime,frozenTime,
        movement:difference(initial,moving),freeze:difference(moving,still),
        discharge:difference(still,discharge),rollback:difference(still,corrected),
        baseProgramCount,fog,removeFog:difference(corrected,unfogged),
        programs:renderer.info.programs.map(program=>({linked:gl.getProgramParameter(program.program,gl.LINK_STATUS),
          runnable:program.diagnostics?.runnable ?? true})),glError:gl.getError()};
    } finally {
      scene.clear(); target.dispose(); disposeGunModels([gun],cache); renderer.dispose();
    }
  })()`);
  assert.equal(report.source,'thunderbolt','the WebGL test uses the shipped Blender asset');
  assert.equal(report.fields,5,'all five authored plasma spheres render');
  assert.ok(report.visiblePixels>1000,`plasma has visible output (${report.visiblePixels} pixels)`);
  assert.equal(report.baseProgramCount,1,'all five fields share one compiled shader program');
  assert.equal(report.programs.length,3,'unfogged, linear and exponential fog each use one shared program');
  assert.ok(report.programs.every(program=>program.linked&&program.runnable),'plasma shaders compile and link');
  assert.equal(report.glError,0,'rendering produces no WebGL errors');
  assert.ok(Math.abs(report.movingTime-report.startTime-.41)<1e-8,'controller advances actual shader time once');
  assert.equal(report.frozenTime,report.movingTime,'reduced motion freezes actual shader time');
  assert.ok(report.movement.pixels>100,`elapsed time changes the rendered field (${report.movement.pixels} pixels)`);
  assert.equal(report.freeze.pixels,0,'reduced motion preserves the rendered field');
  assert.ok(report.discharge.pixels>100,`firing visibly energizes the field (${report.discharge.pixels} pixels)`);
  assert.equal(report.rollback.pixels,0,'authority rollback removes the rendered discharge');
  for(const fog of report.fog) {
    assert.ok(fog.dense.maximum<=1,`${fog.kind} fog conceals remote fields at world depth`);
    assert.ok(fog.clear.maximum<=1,`${fog.kind} clear fog preserves field colors`);
  }
  assert.equal(report.removeFog.pixels,0,'leaving world fog restores the unfogged field');
  assert.deepEqual(page.errors,[],'browser remains free of load and runtime errors');
  await mkdir('docs/design/thunderbolt',{recursive:true});
  await writeFile('docs/design/thunderbolt/plasma-browser-report.json',JSON.stringify(report,null,2)+'\n');
  console.log(`TB-4 plasma WebGL: ${report.fields} fields, one program per fog variant, ${report.movement.pixels} animated pixels; reduced motion, discharge, rollback and both world fog modes passed.`);
} finally {
  await session?.close();
  await stopServer(server);
}
