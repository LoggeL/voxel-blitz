import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { launchCdpSession } from './lib/cdp-session.mjs';
import { startServer, stopServer } from './lib/server-process.mjs';

// Verify the shipped Blender asset, not the procedural Node fallback.
const server = startServer({ entry: 'tools/capture-server.mjs', failureContext: 'TB-4 materials' });
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
    const caches = [new MaterialCache(),new MaterialCache()];
    const guns = caches.map(cache=>buildGun('thunderbolt',cache));
    const [a,b] = guns;
    for(const gun of guns) for(const name of ['hand_l','hand_r']) gun.root.getObjectByName(name).visible=false;
    const maps = new Set(), materials = new Set(), secondMaterials = new Set();
    let triangles=0,draws=0,mappedTriangles=0,invalidNormals=0,smoothNormals=0,invalidUVs=0;
    const bounds = new T.Box3();
    a.root.updateMatrixWorld(true);
    a.root.traverseVisible(mesh => {
      if(!mesh.isMesh || !mesh.userData.blenderAsset) return;
      const g=mesh.geometry,p=g.attributes.position,n=g.attributes.normal,uv=g.attributes.uv;
      const count=(g.index?.count ?? p.count)/3;
      draws++;triangles+=count;
      bounds.expandByObject(mesh,true);
      for(let i=0;i<n.count;i++) {
        const length=Math.hypot(n.getX(i),n.getY(i),n.getZ(i));
        if(!Number.isFinite(length)||Math.abs(length-1)>.02)invalidNormals++;
        if(Math.max(Math.abs(n.getX(i)),Math.abs(n.getY(i)),Math.abs(n.getZ(i)))<.98)smoothNormals++;
      }
      for(const material of [].concat(mesh.material)) {
        materials.add(material);
        if(material.map) {
          mappedTriangles+=count; maps.add(material.map);
          if(!uv || !Array.from(uv.array).every(Number.isFinite))invalidUVs++;
        }
      }
    });
    b.root.traverseVisible(mesh => { if(mesh.userData.blenderAsset) for(const m of [].concat(mesh.material||[])) secondMaterials.add(m); });
    const ray=new T.Raycaster(new T.Vector3(0,.1701,1),new T.Vector3(0,0,-1),0,2);
    const sightHits=ray.intersectObject(a.body,true).filter(hit=>{
      for(let o=hit.object;o;o=o.parent) if(!o.visible)return false;
      return !hit.object.material?.transparent && hit.object.name!=='weaponDisplay';
    });
    const parts=a.extra.userData.thunderbolt, animation=thunderboltAnimationFor(a);
    const centers=[];
    for(let i=0;i<4;i++) {
      animation.setState({mag:4-i});
      a.root.updateMatrixWorld(true);
      const center=new T.Box3().setFromObject(parts.rounds[i]).getCenter(new T.Vector3());
      centers.push(center.toArray());
    }
    const materialsIndependent=[...materials].every(m=>!secondMaterials.has(m));
    const mapDetails=[...maps].map(map=>({name:map.name,width:map.image?.width,height:map.image?.height,pageOwned:!!map.userData.pageOwned}));
    let disposedMaps=0,disposedMaterials=0,disposedSecond=0;
    for(const map of maps)map.addEventListener('dispose',()=>disposedMaps++);
    for(const m of materials)m.addEventListener('dispose',()=>disposedMaterials++);
    for(const m of secondMaterials)m.addEventListener('dispose',()=>disposedSecond++);
    const source=a.body.userData.blenderAsset;
    disposeGunModels([a],caches[0]);
    const lifecycle={disposedMaps,disposedMaterials,disposedSecond,materialsIndependent};
    disposeGunModels([b],caches[1]);
    return {source,draws,triangles,mappedTriangles,mapDetails,invalidNormals,smoothNormals,invalidUVs,
      bounds:{min:bounds.min.toArray(),max:bounds.max.toArray()},sightHits:sightHits.length,centers,lifecycle};
  })()`);
  assert.equal(report.source, 'thunderbolt', 'actual Blender model loaded');
  assert.ok(report.draws > 0 && report.draws <= 40, `draw budget: ${report.draws}`);
  assert.ok(report.triangles > 5000 && report.triangles <= 50000, `geometry budget: ${report.triangles}`);
  assert.ok(report.mapDetails.length >= 4, 'distinct real ceramic, steel, copper and grip textures');
  assert.ok(report.mapDetails.every(m => m.width >= 128 && m.height >= 128 && m.pageOwned), 'decoded shared surface images');
  assert.ok(report.mappedTriangles / report.triangles > .6, 'most physical geometry has UV mapped materials');
  assert.equal(report.invalidNormals,0,'finite normalized normals');
  assert.equal(report.invalidUVs,0,'mapped meshes have complete UVs');
  assert.ok(report.smoothNormals>500,'curved surface normals replace cube shading');
  assert.ok(Math.abs(report.bounds.min[2]+.74)<.001,'authored muzzle plane matches gameplay');
  assert.equal(report.sightHits,0,'authored sight line remains open');
  const center=report.centers[0];
  for(const next of report.centers) assert.ok(Math.hypot(...next.map((v,i)=>v-center[i]))<.001,
    'each actual Blender orb reaches the same feed station');
  assert.equal(report.lifecycle.disposedMaps,0,'disposing one gun preserves shared textures');
  assert.equal(report.lifecycle.disposedSecond,0,'disposing one gun preserves the other gun');
  assert.equal(report.lifecycle.materialsIndependent,true,'materials are owned by each gun');
  assert.ok(report.lifecycle.disposedMaterials>0,'owned materials are released');
  assert.deepEqual(page.errors,[]);
  await mkdir('docs/design/blender/thunderbolt',{recursive:true});
  await writeFile('docs/design/blender/thunderbolt/browser-materials-report.json',JSON.stringify(report,null,2)+'\n');
  console.log(`TB-4 Blender runtime: ${report.triangles} triangles, ${report.draws} draws, ${report.mapDetails.length} loaded texture maps; UVs, curves, feed alignment and disposal passed.`);
} finally {
  await session?.close();
  await stopServer(server);
}
