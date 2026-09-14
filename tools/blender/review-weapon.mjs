import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { startServer, stopServer } from '../lib/server-process.mjs';
import { launchCdpSession } from '../lib/cdp-session.mjs';

// Independent review of an OMP-delivered asset. No runtime factory is changed.
const asset = 'public/assets/blender/omp-weapon/weapon.glb';
const out = '.artifacts/omp-weapon/review';
await mkdir(out, { recursive: true });
const bytes = await readFile(asset);
if (bytes.readUInt32LE(0) !== 0x46546c67 || bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length) {
  throw new Error('Invalid glTF 2 binary header');
}
const doc = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString());
const file = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
  externalImages: (doc.images || []).filter(image => image.uri && !image.uri.startsWith('data:')).map(image => image.uri),
  images: (doc.images || []).length, animations: (doc.animations || []).map(a => a.name),
  generator: doc.asset.generator };
const server = startServer({ entry: 'tools/capture-server.mjs' });
let browser;
try {
  const origin = `http://127.0.0.1:${await server.port}`;
  const response = await fetch(origin + '/assets/blender/omp-weapon/weapon.glb');
  file.gameServer = { status: response.status, contentType: response.headers.get('content-type') };
  await response.arrayBuffer();
  browser = await launchCdpSession(`${origin}/weapon-capture.html?weapon=rifle&state=held`,
    { width: 1280, height: 800 });
  const page = browser.page;
  await page.waitFor(`document.documentElement.dataset.captureReady === 'true'`, { timeoutMs: 20000 });
  const result = await page.evaluate(`(async () => {
    const T = await import('/js/vendor/three.module.js');
    const { GLTFLoader } = await import('/js/vendor/loaders/GLTFLoader.js');
    // Parse the exact bytes so the asset audit is independent of the server's
    // extension allowlist. Serving the GLB is a separate integration gate.
    const data = Uint8Array.from(atob(${JSON.stringify(bytes.toString('base64'))}), c => c.charCodeAt(0));
    const gltf = await new GLTFLoader().parseAsync(data.buffer, '');
    const root = gltf.scene;
    root.updateMatrixWorld(true);
    const meshes = [], materials = new Set(), maps = new Set();
    const issues = [];
    let triangles=0, invalidValues=0, invalidIndices=0, invertedTriangles=0, degenerateTriangles=0, invalidNormals=0;
    const points = [new T.Vector3(),new T.Vector3(),new T.Vector3()];
    const edge = new T.Vector3(), normal = new T.Vector3(), stored = new T.Vector3();
    root.traverse(o => {
      if (!o.matrixWorld.elements.every(Number.isFinite) || o.matrixWorld.determinant() <= 0) issues.push('Invalid/reflected transform: '+o.name);
      if (!o.isMesh) return;
      meshes.push(o);
      const g=o.geometry, positions=g.attributes.position, index=g.index, n=g.attributes.normal;
      for (const attr of Object.values(g.attributes)) for(const value of attr.array) if(!Number.isFinite(value)) invalidValues++;
      if(index) for(const value of index.array) if(value<0 || value>=positions.count) invalidIndices++;
      const count=index ? index.count : positions.count;
      triangles += count/3;
      if(!g.attributes.uv) issues.push('Missing UV: '+o.name);
      if(n) for(let i=0;i<n.count;i++) {
        const length=stored.fromBufferAttribute(n,i).length();
        if(Math.abs(length-1)>.02) invalidNormals++;
      }
      for(let i=0;i<count;i+=3) {
        const ids=[0,1,2].map(k=>index?index.getX(i+k):i+k);
        ids.forEach((v,k)=>points[k].fromBufferAttribute(positions,v));
        normal.subVectors(points[1],points[0]).cross(edge.subVectors(points[2],points[0]));
        if(normal.lengthSq()<1e-18) {degenerateTriangles++;continue;}
        if(n) {
          const average=new T.Vector3();ids.forEach(v=>average.add(stored.fromBufferAttribute(n,v)));
          if(normal.normalize().dot(average.normalize())<-.1) invertedTriangles++;
        }
      }
      for(const m of [].concat(o.material)) {
        materials.add(m);if(m.map) maps.add(m.map);
        if(m.transparent) m.depthWrite=false;
      }
    });
    const required=['body','mag','bolt','trigger','factory-optic','muzzle','grip','support','sight'];
    const missing=required.filter(name=>!root.getObjectByName(name));
    const bounds=new T.Box3().setFromObject(root), size=bounds.getSize(new T.Vector3()), center=bounds.getCenter(new T.Vector3());
    const expected={muzzle:[-.012,.045,-.598],grip:[.045,.015,-.09],support:[-.055,.005,-.40]};
    const anchors={};
    for(const name of ['muzzle','grip','support','sight']) {
      const node=root.getObjectByName(name);if(!node) continue;
      const p=node.getWorldPosition(new T.Vector3());
      let nearest=Infinity;
      for(const mesh of meshes) {
        const g=mesh.geometry, pos=g.attributes.position, idx=g.index;
        for(let i=0;i<(idx?idx.count:pos.count);i+=3) {
          for(let k=0;k<3;k++) points[k].fromBufferAttribute(pos,idx?idx.getX(i+k):i+k).applyMatrix4(mesh.matrixWorld);
          const closest=new T.Triangle(...points).closestPointToPoint(p,new T.Vector3());
          nearest=Math.min(nearest,p.distanceTo(closest));
        }
      }
      anchors[name]={position:p.toArray(),expectedError:expected[name]?p.distanceTo(new T.Vector3(...expected[name])):null,nearestSurface:nearest};
    }
    const sightRays=[];
    for(const x of [-.006,0,.006]) for(const dy of [-.004,0,.004]) {
      const ray=new T.Raycaster(new T.Vector3(x,.145+dy,.5),new T.Vector3(0,0,-1),0,2);
      const hits=ray.intersectObject(root,true).filter(hit => {
        const m=Array.isArray(hit.object.material)?hit.object.material[hit.face.materialIndex]:hit.object.material;
        if(m.transparent || /reticle|dot/i.test(hit.object.name)) return false;
        for(let n=hit.object;n;n=n.parent) if(!n.visible) return false;
        return true;
      });
      sightRays.push({x,y:.145+dy,hits:hits.slice(0,4).map(h=>({name:h.object.name,position:h.point.toArray()}))});
    }
    document.body.replaceChildren();document.body.style.margin='0';
    const renderer=new T.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});
    renderer.setSize(1280,800);renderer.outputColorSpace=T.SRGBColorSpace;
    renderer.toneMapping=T.ACESFilmicToneMapping;renderer.toneMappingExposure=1.15;
    document.body.append(renderer.domElement);
    const scene=new T.Scene();scene.background=new T.Color(0x17232d);scene.add(root);
    scene.add(new T.HemisphereLight(0xe5efff,0x44342c,2.0));
    for(const [intensity,color,pos] of [[3.5,0xffe4c5,[2,4,2]],[2.5,0x84b9f5,[-3,1,-1]]]) {
      const light=new T.DirectionalLight(color,intensity);light.position.set(...pos);scene.add(light);
    }
    const camera=new T.PerspectiveCamera(38,1280/800,.005,20);
    const captures=[];
    const capture=name=>{renderer.render(scene,camera);captures.push({name,png:renderer.domElement.toDataURL('image/png').split(',')[1]});};
    const fit=Math.max(size.z,size.y)*1.7;
    camera.position.copy(center).add(new T.Vector3(fit,.45*fit,.75*fit));camera.lookAt(center);capture('hero');
    // A second view with studio reflections distinguishes the asset's surface
    // work from the game's current lighting, which has no environment map.
    const room=new T.Scene();room.background=new T.Color(.28,.28,.28);
    for(const [color,pos,scale] of [[0xffffff,[0,4,0],[4,.1,4]],[0xc9dfff,[-4,1,0],[.1,4,5]],[0xffe1b4,[4,2,2],[.1,3,3]]]) {
      const panel=new T.Mesh(new T.BoxGeometry(...scale),new T.MeshBasicMaterial({color}));panel.position.set(...pos);room.add(panel);
    }
    const environment=new T.PMREMGenerator(renderer).fromScene(room,.04).texture;
    scene.environment=environment;capture('hero-studio');
    camera.position.copy(center).add(new T.Vector3(fit,0,0));camera.lookAt(center);capture('side-studio');
    camera.position.set(.12,.22,.06);camera.lookAt(0,.145,-.187);capture('optic-closeup');
    scene.environment=null;
    camera.position.copy(center).add(new T.Vector3(fit,0,0));camera.lookAt(center);capture('right-side');
    camera.position.copy(center).add(new T.Vector3(-fit,0,0));camera.lookAt(center);capture('left-side');
    camera.fov=60;camera.updateProjectionMatrix();camera.position.set(0,.145,.68);camera.lookAt(0,.145,-2);
    const target=new T.Group();
    const paint=new T.MeshBasicMaterial({color:0xffa031});
    for(const [w,h] of [[.15,.012],[.012,.15]]) {const bar=new T.Mesh(new T.BoxGeometry(w,h,.01),paint);bar.position.set(0,.145,-2);target.add(bar);}
    scene.add(target);capture('ads');scene.remove(target);
    camera.fov=38;camera.updateProjectionMatrix();camera.position.copy(center).add(new T.Vector3(fit,.45*fit,.75*fit));camera.lookAt(center);
    const mag=root.getObjectByName('mag'), bolt=root.getObjectByName('bolt'), trigger=root.getObjectByName('trigger');
    const motion={};
    if(mag) {
      const before=new T.Box3().setFromObject(mag).getCenter(new T.Vector3());
      mag.position.y-=.22;root.updateMatrixWorld(true);
      const after=new T.Box3().setFromObject(mag).getCenter(new T.Vector3());
      motion.magazineDelta=after.sub(before).toArray();
    }
    if(bolt) bolt.position.z+=.085;
    if(trigger) trigger.rotation.x+=.2;
    capture('parts-moved');
    return {triangles,meshes:meshes.length,materials:materials.size,drawCalls:renderer.info.render.calls,
      maps:[...maps].map(m=>({name:m.name,width:m.image.width,height:m.image.height})),
      missing,issues,invalidValues,invalidIndices,invalidNormals,invertedTriangles,degenerateTriangles,
      bounds:{min:bounds.min.toArray(),max:bounds.max.toArray(),size:size.toArray()},anchors,sightRays,motion,captures};
  })()`);
  for(const capture of result.captures) await writeFile(path.join(out,capture.name+'.png'),Buffer.from(capture.png,'base64'));
  delete result.captures;
  result.file=file;result.browserErrors=page.errors;
  await writeFile(path.join(out,'inspection.json'),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result,null,2));
} finally { await browser?.close(); await stopServer(server); }
