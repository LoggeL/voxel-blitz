import * as THREE from '../vendor/three.module.js';

/** Small, non-blocking set dressing; gameplay cover lives in the shared voxel map. */
export function buildNuketownDetails() {
  const group = new THREE.Group();
  group.name = 'nuketown-details';
  const geometry = new THREE.BoxGeometry(1,1,1);
  const boxes = [];
  const add = (x,y,z,sx,sy,sz,color) => boxes.push({x,y,z,sx,sy,sz,color});
  // Inaccessible neighbouring test homes continue the suburb beyond the fence.
  for(const [x,z,color] of [[-12,22,0xcdb48c],[-12,70,0xa3b9af],[141,17,0xc5ba9d],[141,76,0xc5a18e]]) {
    add(x,18,z,17,8,13,color);
    add(x,22.5,z,19,1,15,0x665748);
    add(x,23.5,z,17,1,11,0x665748);
    add(x,24.5,z,15,1,7,0x665748);
    add(x,25.5,z,13,1,3,0x665748);
    for(const dx of [-5,5]) add(x+dx,18.5,z+6.52,3,2,.1,0x809caa);
    add(x,16,z+6.52,2,4,.1,0x6b5949);
  }
  // Test-site mannequins, deliberately slim enough to distinguish from players.
  for(const [x,z,shirt] of [[40,35,0xc07159],[92,62,0x759cbd],[47,79,0xe0ba72],[80,16,0x97bb9b]]) {
    for(const dx of [-.17,.17]) add(x+dx,14.48,z,.18,.95,.2,0x766b60);
    add(x,15.23,z,.57,.7,.3,shirt);
    add(x,15.85,z,.31,.39,.3,0xe0c4a1);
    for(const dx of [-.39,.39]) add(x+dx,15.18,z,.14,.78,.16,0xe0c4a1);
  }
  // Aerials and overhead porch lights.
  for(const flip of [false,true]) {
    const b=(x,y,z,sx,sy,sz,c)=>add(flip?128-x:x,y,flip?96-z:z,sx,sy,sz,c);
    b(54,34,68,.09,6,.09,0x4c4942);
    b(54,36,68,5,.08,.08,0x6a665c);
    for(const x of [52,53,54,55,56]) b(x,36,68,.06,.06,2,0x6a665c);
    b(60.5,18.7,60.85,.6,.3,.25,0xffe3a4);
    b(63.5,18,76.1,.3,.55,.25,0xffe3a4);
    // Balcony rails and slender spindles leave the door and stair landing open.
    b(57,22.5,79.7,2,.12,.12,0xf2e4cd); b(65,22.5,79.7,3,.12,.12,0xf2e4cd);
    for(const x of [56.2,57,57.8,63.5,64.5,65.5,66.4]) b(x,22,79.7,.1,1,.1,0xf2e4cd);
  }
  const material=new THREE.MeshLambertMaterial();
  const mesh=new THREE.InstancedMesh(geometry,material,boxes.length);
  const matrix=new THREE.Matrix4();
  boxes.forEach((b,i)=>{
    matrix.makeScale(b.sx,b.sy,b.sz); matrix.setPosition(b.x,b.y,b.z);
    mesh.setMatrixAt(i,matrix); mesh.setColorAt(i,new THREE.Color(b.color));
  });
  mesh.instanceMatrix.needsUpdate=true;
  mesh.instanceColor.needsUpdate=true;
  group.add(mesh);
  const textures=[], materials=[material], geometries=[geometry];
  const desertGeo=new THREE.PlaneGeometry(700,700);
  const desertMat=new THREE.MeshLambertMaterial({color:0xc4ad83});
  const desert=new THREE.Mesh(desertGeo,desertMat);
  desert.rotation.x=-Math.PI/2;desert.position.set(64,13.9,48);group.add(desert);
  geometries.push(desertGeo);materials.push(desertMat);
  const mountainMat=new THREE.MeshLambertMaterial({color:0xa79078});
  materials.push(mountainMat);
  for(let i=0;i<18;i++) {
    const angle=i*Math.PI*2/18, height=10+(i*7)%17;
    const geo=new THREE.CylinderGeometry(14+(i*3)%14,45+(i*11)%26,height,6,1);
    const mountain=new THREE.Mesh(geo,mountainMat);
    mountain.position.set(64+Math.cos(angle)*235,13+height/2,48+Math.sin(angle)*235);
    mountain.rotation.y=i*.7;group.add(mountain);geometries.push(geo);
  }
  const label=(text,x,y,z,w,h,background,ink,rotation=0)=>{
    const canvas=document.createElement('canvas'); canvas.width=1024; canvas.height=256;
    const ctx=canvas.getContext('2d'); ctx.fillStyle=background;ctx.fillRect(0,0,1024,256);
    ctx.strokeStyle=ink;ctx.lineWidth=9;ctx.strokeRect(15,15,994,226);
    ctx.fillStyle=ink;ctx.textAlign='center';ctx.textBaseline='middle';ctx.font='bold 100px Georgia';
    ctx.fillText(text,512,136,960);
    const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;
    const mat=new THREE.MeshBasicMaterial({map:texture,side:THREE.DoubleSide});
    const geo=new THREE.PlaneGeometry(w,h), plane=new THREE.Mesh(geo,mat);
    plane.position.set(x,y,z);plane.rotation.y=rotation;group.add(plane);
    textures.push(texture);materials.push(mat);geometries.push(geo);
  };
  label('WELCOME TO NUKETOWN',34,19.5,33.015,11,2.6,'#3e776a','#fff1ca');
  label('POPULATION: 00',34,18.2,33.025,6,.55,'#3e776a','#fff1ca');
  label('SCHOOL BUS',55.5,20.55,48.015,9,.62,'#e4ab24','#242525');
  label('WESTERN MOVING',80,18.65,56.015,10,1.3,'#a7342c','#fff0d6');
  return {group,dispose(){ mesh.dispose();textures.forEach(t=>t.dispose());materials.forEach(m=>m.dispose());geometries.forEach(g=>g.dispose());group.clear(); }};
}
