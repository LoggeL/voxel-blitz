import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchCdpSession } from './lib/cdp-session.mjs';
import { startServer, stopServer, waitForHttp } from './lib/server-process.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const screenshotPath = process.env.BLOCK_DAMAGE_SCREENSHOT || path.join(root,'.artifacts/block-damage/stages.png');

async function click(page, id) {
  const point = await page.evaluate(`(() => {
    const element = document.getElementById(${JSON.stringify(id)});
    element?.scrollIntoView({block:'center'});
    const rect = element?.getBoundingClientRect();
    return rect?.width && rect?.height ? {x:rect.left+rect.width/2,y:rect.top+rect.height/2} : null;
  })()`);
  assert.ok(point, `visible #${id}`);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await page.send('Input.dispatchMouseEvent', {
      type, ...point, button:'left', buttons:type === 'mousePressed' ? 1 : 0, clickCount:1,
    });
  }
}

async function renderGallery(page) {
  return page.evaluate(`(async () => {
    const THREE = await import('/js/vendor/three.module.js');
    const { ChunkStore } = await import('/js/engine/chunks.js');
    const { buildAtlas } = await import('/js/engine/atlas.js');
    const { AIR, STONE, WOOD, BRICK } = await import('/shared/worlddata.js');
    const renderer = new THREE.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});
    renderer.setSize(360,300);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x17202b);
    scene.add(new THREE.HemisphereLight(0xffffff,0x53647b,2.1));
    const sun = new THREE.DirectionalLight(0xffeccf,1.6);
    sun.position.set(14,18,15); scene.add(sun);
    const camera = new THREE.OrthographicCamera(-.93,.93,.775,-.775,.01,100);
    camera.position.set(10.5,10.1,11.2); camera.lookAt(8.5,8.5,8.5);
    const atlas = buildAtlas();
    let block = STONE, damage = 0;
    const atBlock = (x,y,z) => x===8 && y===8 && z===8;
    const chunks = new ChunkStore(scene,atlas,
      (x,y,z) => atBlock(x,y,z) ? block : AIR,
      (x,y,z) => atBlock(x,y,z) ? damage : 0);
    const stages = [0,.2,.4,.6,.8,.95];
    const materials = [['Stone',STONE],['Wood',WOOD],['Brick',BRICK]];
    document.body.replaceChildren();
    document.head.insertAdjacentHTML('beforeend','<style>body{margin:0;padding:24px 30px;background:#0c121b;color:#e8eef6;font:14px system-ui;box-sizing:border-box}h1{margin:0 0 5px;font-size:22px;font-weight:650}p{margin:0 0 22px;color:#98a7b9}.gallery{display:grid;grid-template-columns:repeat(6,1fr);gap:10px}.card{border:1px solid #293648;border-radius:8px;overflow:hidden;background:#17202b}.card img{display:block;width:100%;height:auto}.label{padding:9px 12px;background:#111a26;display:flex;justify-content:space-between}.label span{color:#8eafcc}</style>');
    document.body.innerHTML = '<h1>Progressive block damage</h1><p>Same block, same texture. Missing chunks accumulate as damage increases.</p><div class="gallery"></div>';
    const gallery = document.querySelector('.gallery');
    const gl = renderer.getContext();
    const pixels = new Uint8Array(360*300*4);
    const hash = array => {
      let result = 2166136261;
      for (let i=0;i<array.length;i++) result = Math.imul(result ^ array[i],16777619);
      return result >>> 0;
    };
    const volume = geometry => {
      const position = geometry.attributes.position;
      const index = geometry.index.array;
      let result = 0;
      for (let i=0;i<index.length;i+=3) {
        const a = index[i], b = index[i+1], c = index[i+2];
        const ax=position.getX(a)-8, ay=position.getY(a)-8, az=position.getZ(a)-8;
        const bx=position.getX(b)-8, by=position.getY(b)-8, bz=position.getZ(b)-8;
        const cx=position.getX(c)-8, cy=position.getY(c)-8, cz=position.getZ(c)-8;
        result += ax*(by*cz-bz*cy)+ay*(bz*cx-bx*cz)+az*(bx*cy-by*cx);
      }
      return Math.abs(result/6);
    };
    const results = [];
    let disposedGeometries = 0;
    for (const [name,id] of materials) {
      block=id;
      let previousPixels = null;
      const samples = [];
      for (const progress of stages) {
        damage=progress;
        chunks.rebuildChunk(0,0);
        const mesh = chunks.group.children[0];
        const geometry = mesh.geometry;
        geometry.addEventListener('dispose',()=>disposedGeometries++);
        renderer.render(scene,camera); gl.finish();
        gl.readPixels(0,0,360,300,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
        let changedPixels=0;
        if (previousPixels) for (let i=0;i<pixels.length;i+=4) {
          if (pixels[i]!==previousPixels[i] || pixels[i+1]!==previousPixels[i+1] || pixels[i+2]!==previousPixels[i+2]) changedPixels++;
        }
        previousPixels=pixels.slice();
        const position=geometry.attributes.position.array;
        samples.push({progress,volume:volume(geometry),vertices:geometry.attributes.position.count,
          geometryHash:hash(new Uint8Array(position.buffer,position.byteOffset,position.byteLength)),
          pixelsHash:hash(pixels),changedPixels,drawCalls:renderer.info.render.calls,
          originalMaterial:mesh.material===chunks.materials.opaque && mesh.material.map===atlas.texture()});
        const card = document.createElement('div'); card.className='card';
        const image = document.createElement('img'); image.src=renderer.domElement.toDataURL('image/png');
        image.alt=name+' at '+Math.round(progress*100)+' percent damage'; card.append(image);
        const label = document.createElement('div'); label.className='label';
        label.innerHTML=name+'<span>'+Math.round(progress*100)+'% damage</span>'; card.append(label); gallery.append(card);
      }
      results.push({name,samples});
    }
    damage=0; block=AIR;
    chunks.applyBlockDelta(8,8,8,AIR); chunks.update();
    const removed=chunks.group.children.length===0;
    const glError=gl.getError();
    const shadersReady=renderer.info.programs.every(program=>program.diagnostics?.runnable!==false);
    chunks.dispose(); atlas.dispose(); renderer.dispose();
    await Promise.all([...document.images].map(image=>image.decode()));
    return {results,removed,disposedGeometries,glError,shadersReady,sceneClean:!scene.children.includes(chunks.group)};
  })()`);
}

async function liveClient(page, port) {
  await page.send('Page.addScriptToEvaluateOnNewDocument', {source: `
    window.__damageSockets=[]; window.__damageMessages=[];
    const NativeSocket=window.WebSocket;
    window.WebSocket=class extends NativeSocket {
      constructor(...args) {
        super(...args); window.__damageSockets.push(this);
        this.addEventListener('message',event=>{
          if(typeof event.data==='string') {
            try { window.__damageMessages.push(JSON.parse(event.data)); } catch {}
          }
        });
      }
    };
  `});
  await page.send('Page.navigate', {url:`http://127.0.0.1:${port}/?debug=1&headless=1&touch=1`});
  await page.waitFor(`document.getElementById('create-lobby-btn') && !document.getElementById('menu').classList.contains('hidden')`, {label:'game menu'});
  await page.evaluate(`(async()=>{
    const {ChunkStore}=await import('/js/engine/chunks.js');
    const rebuild=ChunkStore.prototype.rebuildChunk;
    ChunkStore.prototype.rebuildChunk=function(...args) {
      window.__damageChunks=this;
      return rebuild.apply(this,args);
    };
  })()`);
  await click(page,'create-lobby-btn');
  await page.waitFor(`document.getElementById('lobby')?.getAttribute('aria-hidden')==='false'`, {label:'waiting lobby'});
  await page.evaluate(`(()=>{const select=document.getElementById('bot-count');select.value='0';select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await page.waitFor(`window.__damageMessages.filter(m=>m.t==='lobbyState').at(-1)?.bots===0`, {label:'zero bots'});
  await click(page,'lobby-ready-btn');
  await page.waitFor(`document.getElementById('lobby-start-btn')?.disabled===false`, {label:'ready lobby'});
  await click(page,'lobby-start-btn');
  await page.waitFor(`window.__vb?.stats?.running && window.__vb.stats.ringLen>0 && !!window.__damageChunks`, {timeoutMs:30000,label:'live game'});
  const initial = await page.evaluate(`(async()=>{
    const {AIR,BLOCK_HP,SX,SY,SZ}=await import('/shared/worlddata.js');
    const chunks=window.__damageChunks;
    let target=null;
    for(let y=2;y<SY&&!target;y++) for(let z=1;z<SZ-1&&!target;z++) for(let x=1;x<SX-1&&!target;x++) {
      const v=chunks.getBlock(x,y,z);
      if(v!==AIR && Number.isFinite(BLOCK_HP[v]) && BLOCK_HP[v]>0 && chunks.getBlock(x,y+1,z)===AIR) target={x,y,z,v};
    }
    if(!target) throw new Error('No exposed destructible block');
    window.__damageTarget=target;
    const record=chunks.chunks.get((target.x>>4)+','+(target.z>>4));
    window.__damageOriginalMeshes=record.meshes.slice();
    window.__damageDisposals=0;
    for(const mesh of record.meshes) mesh.geometry.addEventListener('dispose',()=>window.__damageDisposals++);
    window.__damageInject=progress=>{
      const tick=window.__damageMessages.filter(m=>m.t==='tick').at(-1);
      window.__damageSockets.at(-1).dispatchEvent(new MessageEvent('message',{data:JSON.stringify({
        ...tick,blocks:[],events:[],blockDamage:[{...target,progress}],now:tick.now+1,
      })}));
    };
    return {target,damagedBlocks:window.__vb.stats.damagedBlocks,meshes:record.meshes.length};
  })()`);
  await page.evaluate('window.__damageInject(.5)');
  await page.waitFor(`(()=>{const t=window.__damageTarget;return window.__vb.stats.damagedBlocks===1 && window.__damageChunks.getBlockDamage(t.x,t.y,t.z)===.5 && window.__damageDisposals>0;})()`, {label:'damage-only snapshot remeshes live terrain'});
  const halfway = await page.evaluate(`(()=>{
    const t=window.__damageTarget, chunks=window.__damageChunks;
    const record=chunks.chunks.get((t.x>>4)+','+(t.z>>4));
    window.__damageHalfwayMeshes=record.meshes.slice();
    window.__damagePersistence={started:performance.now(),
      ticks:window.__damageMessages.filter(message=>message.t==='tick'&&!message.blockDamage?.length).length};
    return {newMeshes:record.meshes.every(mesh=>!window.__damageOriginalMeshes.includes(mesh)),
      disposed:window.__damageDisposals,blockUnchanged:chunks.getBlock(t.x,t.y,t.z)===t.v,
      geometry:record.meshes.map(mesh=>mesh.geometry.attributes.position.count)};
  })()`);
  await page.waitFor(`(()=>{
    const started=window.__damagePersistence;
    const ticks=window.__damageMessages.filter(message=>message.t==='tick'&&!message.blockDamage?.length).length;
    return performance.now()-started.started>=1300 && ticks-started.ticks>=12;
  })()`, {label:'damage remains visible through ordinary snapshots beyond former overlay lifetime'});
  const persistence=await page.evaluate(`(()=>{
    const t=window.__damageTarget, chunks=window.__damageChunks, started=window.__damagePersistence;
    const record=chunks.chunks.get((t.x>>4)+','+(t.z>>4));
    return {elapsedMs:Math.round(performance.now()-started.started),
      ordinarySnapshots:window.__damageMessages.filter(message=>message.t==='tick'&&!message.blockDamage?.length).length-started.ticks,
      progress:chunks.getBlockDamage(t.x,t.y,t.z),damagedBlocks:window.__vb.stats.damagedBlocks,
      sameMeshes:record.meshes.length===window.__damageHalfwayMeshes.length &&
        record.meshes.every((mesh,index)=>mesh===window.__damageHalfwayMeshes[index])};
  })()`);
  await page.evaluate('window.__damageInject(.9)');
  await page.waitFor(`(()=>{const t=window.__damageTarget;return window.__damageChunks.getBlockDamage(t.x,t.y,t.z)===.9 && window.__damageChunks.stats.queued===0;})()`, {label:'later damage stage applied'});
  const later = await page.evaluate(`(()=>{
    const t=window.__damageTarget, chunks=window.__damageChunks;
    return {geometry:chunks.chunks.get((t.x>>4)+','+(t.z>>4)).meshes.map(mesh=>mesh.geometry.attributes.position.count)};
  })()`);
  await page.evaluate('window.__damageInject(0)');
  await page.waitFor(`(()=>{const t=window.__damageTarget;return window.__vb.stats.damagedBlocks===0 && window.__damageChunks.getBlockDamage(t.x,t.y,t.z)===0 && window.__damageChunks.stats.queued===0;})()`, {label:'reset clears live damage state'});
  return {initial,halfway,persistence,later,reset:true};
}

async function captureRoutes(page,port) {
  const captures=[];
  for(const state of ['mining-low','mining-high']) {
    await page.send('Page.navigate',{url:'http://127.0.0.1:'+port+'/weapon-capture.html?weapon=knife&state='+state});
    await page.waitFor(`document.documentElement.dataset.captureReady==='true' && document.documentElement.dataset.captureState===${JSON.stringify(state)}`,
      {label:state+' weapon capture renders'});
    const capture=await page.evaluate(`(()=>{
      const canvas=document.getElementById('capture');
      return {...window.__vbWeaponCapture,canvasReady:canvas.width>0&&canvas.height>0,
        glError:canvas.getContext('webgl2').getError()};
    })()`);
    assert.equal(capture.weapon,'knife');
    assert.equal(capture.state,state);
    assert.equal(capture.canvasReady,true);
    assert.equal(capture.glError,0);
    captures.push(capture);
  }
  return captures;
}

const server = startServer({cwd:root,failureContext:'block damage browser test'});
let browser;
try {
  const port=await server.port;
  await waitForHttp(port);
  browser=await launchCdpSession(`http://127.0.0.1:${port}/shared/worlddata.js`, {width:1440,height:810});
  const gallery=await renderGallery(browser.page);
  for(const {name,samples} of gallery.results) {
    assert.equal(samples[0].volume,1,`${name}: intact volume`);
    assert.equal(new Set(samples.map(sample=>sample.geometryHash)).size,samples.length,`${name}: distinct geometry at every stage`);
    assert.equal(new Set(samples.map(sample=>sample.pixelsHash)).size,samples.length,`${name}: visible change at every stage`);
    for(let index=0;index<samples.length;index++) {
      const sample=samples[index];
      assert.equal(sample.originalMaterial,true,`${name}: original texture material`);
      assert.equal(sample.drawCalls,1,`${name}: remains one terrain draw submission`);
      if(index>0) {
        assert.ok(sample.volume>0 && sample.volume<samples[index-1].volume,`${name}: pieces are removed cumulatively`);
        assert.ok(sample.changedPixels>80,`${name}: damage has visible screen coverage`);
      }
    }
  }
  assert.equal(gallery.removed,true,'destruction removes damaged geometry');
  assert.equal(gallery.disposedGeometries,18,'superseded damage geometry is disposed');
  assert.equal(gallery.glError,0);
  assert.equal(gallery.shadersReady,true);
  assert.equal(gallery.sceneClean,true);
  const capture=await browser.page.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false},15000);
  await mkdir(path.dirname(screenshotPath),{recursive:true});
  await writeFile(screenshotPath,Buffer.from(capture.data,'base64'));
  const live=await liveClient(browser.page,port);
  assert.equal(live.initial.damagedBlocks,0);
  assert.equal(live.halfway.newMeshes,true);
  assert.equal(live.halfway.blockUnchanged,true);
  assert.equal(live.halfway.disposed,live.initial.meshes);
  assert.ok(live.persistence.elapsedMs>=1300);
  assert.ok(live.persistence.ordinarySnapshots>=12);
  assert.equal(live.persistence.progress,.5);
  assert.equal(live.persistence.damagedBlocks,1);
  assert.equal(live.persistence.sameMeshes,true,'ordinary snapshots retain persistent damaged geometry');
  assert.notDeepEqual(live.halfway.geometry,live.later.geometry,'damage stages rebuild live geometry');
  assert.equal(await browser.page.evaluate('!document.documentElement.dataset.vbLastError'),true);
  const captures=await captureRoutes(browser.page,port);
  assert.deepEqual(browser.page.errors,[]);
  console.log(JSON.stringify({gallery,live,captures,screenshot:screenshotPath}));
  console.log('BLOCK DAMAGE BROWSER: OK');
} finally {
  await browser?.close();
  await stopServer(server);
}
