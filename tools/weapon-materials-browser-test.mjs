import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { startServer, stopServer } from './lib/server-process.mjs';
import { launchCdpSession } from './lib/cdp-session.mjs';
const out=path.resolve('.artifacts/weapon-materials');
const config=JSON.parse(await readFile('docs/design/blender/material-library/materials.json','utf8'));
const weaponIds={bison:'lmg',fang:'revolver',halo:'longarc',hydra:'minigun',ifrit:'flamethrower',kestrel:'rifle',mastiff:'shotgun',peregrine:'sniper',pike:'lance',talon:'knife',torch:'rocket',wasp:'smg'};
const server=startServer({entry:'tools/capture-server.mjs'});
await mkdir(out,{recursive:true});
let browser;
try {
 const base=`http://127.0.0.1:${await server.port}`;
 browser=await launchCdpSession(`${base}/weapon-capture.html?weapon=sniper&state=held`,{width:1200,height:800});
 const page=browser.page;
 await page.waitFor(`document.documentElement.dataset.captureReady==='true'`,{timeoutMs:30000});
 const result=await page.send('Runtime.evaluate',{awaitPromise:true,returnByValue:true,expression:`(async()=>{
  const T=await import('/js/vendor/three.module.js');
  const {createBlenderParts}=await import('/js/engine/blender-assets.js');
  const {disposeObjectTrees}=await import('/js/engine/dispose.js');
  const {buildGun,disposeGunModels}=await import('/js/guns/assemble.js');
  const {MaterialCache}=await import('/js/guns/kit.js');
  const weaponIds=${JSON.stringify(weaponIds)};
  const must=(v,m)=>{if(!v)throw Error(m)};
  const maps=new Map(),results=[];
  window.__materialGallery={};
  for(const asset of ${JSON.stringify(config.assets)}) {
   const parts=createBlenderParts(asset),root=new T.Group();must(parts,asset+' missing');
   root.add(...Object.values(parts));
   const materials=new Set();
   root.traverse(o=>{
    if(!o.isMesh)return;
    const uv=o.geometry.getAttribute('uv');must(uv&&uv.count>0,asset+' UVs absent');
    for(const m of [].concat(o.material||[]))materials.add(m);
   });
   let mapped=0;
   for(const m of materials)if(m.userData.textureLibrary){
    const key=m.userData.textureLibrary;mapped++;
    must(m.map?.image?.width===1024,key+' delivery resolution');
    must(m.bumpMap===m.map&&m.bumpScale>0,key+' bump missing');
    must(m.map.userData.pageOwned,key+' texture lifetime');
    if(maps.has(key))must(maps.get(key)===m.map,key+' duplicated map');else maps.set(key,m.map);
   }
   must(mapped>0,asset+' untextured');
   const cache=new MaterialCache(),gun=buildGun(weaponIds[asset],cache);
   must(gun.body.userData.blenderAsset===asset,asset+' assembled fallback');
   for(const name of ['hand_l','hand_r']){const hand=gun.root.getObjectByName(name);if(hand)hand.visible=false;}
   gun.root.updateMatrixWorld(true);
   const bounds=new T.Box3();
   gun.root.traverseVisible(o=>{
    if(!o.isMesh||[].concat(o.material).every(m=>m.transparent||m.isShaderMaterial))return;
    o.geometry.computeBoundingBox();bounds.union(o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld));
   });
   const center=bounds.getCenter(new T.Vector3()),size=bounds.getSize(new T.Vector3());
   const span=Math.max(size.z,size.y*1.65),half=span/1.65*.60;
   const camera=new T.OrthographicCamera(-half*1.65,half*1.65,half,-half,.01,10);
   camera.position.set(2,center.y+.15,center.z+.16);camera.lookAt(center);
   const scene=new T.Scene();scene.background=new T.Color(0x252e35);
   scene.add(gun.root,new T.HemisphereLight(0xd3e3f0,0x625a4c,1.5));
   const keylight=new T.DirectionalLight(0xffedd8,2);keylight.position.set(3,5,-4);scene.add(keylight);
   const renderer=new T.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});renderer.setSize(990,600);renderer.render(scene,camera);
   window.__materialGallery[asset]=renderer.domElement.toDataURL('image/png');
   results.push({asset,materials:materials.size,paletteMaterials:mapped,triangles:renderer.info.render.triangles});
   renderer.dispose();disposeObjectTrees([root]);disposeGunModels([gun],cache);
  }
  return {weapons:results,sharedPaletteTextures:maps.size};
 })()`},30000);
 assert.equal(result.exceptionDetails,undefined,JSON.stringify(result.exceptionDetails));
 const report=result.result.value;
 for(const asset of config.assets){
  const data=await page.evaluate(`__materialGallery[${JSON.stringify(asset)}].split(',')[1]`);
  await writeFile(path.join(out,asset+'.png'),Buffer.from(data,'base64'));
 }
 await page.send('Emulation.setDeviceMetricsOverride',{width:1600,height:1800,deviceScaleFactor:1,mobile:false});
 await page.evaluate(`(()=>{document.body.innerHTML='';document.body.style.cssText='margin:0;padding:22px;background:#141d25;color:#e1eaf0;font:20px system-ui;display:grid;grid-template-columns:repeat(3,1fr);gap:18px';
 for(const [name,src]of Object.entries(__materialGallery)){const card=document.createElement('div');card.innerHTML='<div style="padding:8px">'+name.toUpperCase()+'</div>';const img=new Image();img.src=src;img.style.width='100%';card.append(img);document.body.append(card)} })()`);
 await page.waitFor(`Array.from(document.images).every(i=>i.complete&&i.naturalWidth>0)`);
 const shot=await page.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});
 await writeFile(path.join(out,'all-weapons.png'),Buffer.from(shot.data,'base64'));
 assert.deepEqual(page.errors,[]);
 await writeFile(path.join(out,'browser-validation.json'),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify(report,null,2));
}finally{await browser?.close();await stopServer(server)}
