import * as THREE from '../vendor/three.module.js';
import { REACTOR_LAYOUT as L, REACTOR_INGRESS } from '../../../shared/world/reactor-layout.js';

/** Reactor and ingress beacons are visual peers of the authoritative objective. */
export class BastionWorld {
  constructor(scene) {
    this.group = new THREE.Group(); this.group.name='bastion-objectives'; scene.add(this.group);
    this.materials=[]; this.geometries=[]; this.textures=[]; this.lanes=new Map();
    const metal=this.material(0x24394b), pale=this.material(0xd2e7df), glow=this.material(0x55ead0,0x25c6b0);
    this.coreGlow=glow;
    const field=new THREE.MeshBasicMaterial({color:0xff9d4b,transparent:true,opacity:.12,depthWrite:false,side:THREE.DoubleSide});this.materials.push(field);
    for(const b of REACTOR_INGRESS) this.box(this.group,[(b.minX+b.maxX)/2,L.core.y+4,(b.minZ+b.maxZ)/2],[b.maxX-b.minX,8,b.maxZ-b.minZ],field);
    const core=new THREE.Group(); core.position.set(L.core.x,L.core.y,L.core.z);this.group.add(core);
    this.box(core,[0,0.22,0],[2.8,0.44,2.8],metal);
    this.box(core,[0,1.7,0],[1.7,2.8,1.7],glow);
    for(const x of [-1.15,1.15]) for(const z of [-1.15,1.15]) this.box(core,[x,1.8,z],[0.35,3.6,0.35],pale);
    this.box(core,[0,3.4,0],[2.8,0.4,2.8],metal);
    this.box(core,[0,3.68,0],[1.8,0.16,1.8],glow);
    this.coreLabel=this.label('REACTOR CORE',[L.core.x,L.core.y+5.4,L.core.z],0x66ffdc,3);
    this.supply=new THREE.Group();this.supply.position.set(L.supply.x,L.supply.y,L.supply.z);this.group.add(this.supply);
    this.box(this.supply,[0,0.5,0],[2,1,1.5],metal);
    this.supplyGlow=this.material(0x45716c,0x102b29);this.box(this.supply,[0,1.1,0],[1.7,0.2,1.2],this.supplyGlow);
    this.supplyLabel=this.label('SERVICE BAY',[L.supply.x,L.supply.y+3.5,L.supply.z],0x83f0dd,4);
    for(const lane of L.lanes) {
      const material=this.material(0x80684f,0x332315);
      this.box(this.group,[lane.entry.x,lane.entry.y+5.5,lane.entry.z],[0.4,2,0.4],material);
      const label=this.label(lane.name,[lane.entry.x,lane.entry.y+7,lane.entry.z],0xffcf70,6);
      this.lanes.set(lane.id,{material,label});
    }
  }
  material(color,emissive=0) { const m=new THREE.MeshStandardMaterial({color,emissive,emissiveIntensity:0.8,roughness:0.55,metalness:0.4});this.materials.push(m);return m; }
  box(parent,pos,size,material) { const g=new THREE.BoxGeometry(...size);this.geometries.push(g);const mesh=new THREE.Mesh(g,material);mesh.position.set(...pos);parent.add(mesh);return mesh; }
  label(text,pos,color,width) {
    const canvas=document.createElement('canvas');canvas.width=512;canvas.height=80;
    const ctx=canvas.getContext('2d');ctx.fillStyle='rgba(10,20,30,0.88)';ctx.fillRect(0,0,512,80);
    ctx.strokeStyle='#'+color.toString(16).padStart(6,'0');ctx.lineWidth=4;ctx.strokeRect(2,2,508,76);
    ctx.fillStyle=ctx.strokeStyle;ctx.font='bold 31px monospace';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(text,256,40);
    const texture=new THREE.CanvasTexture(canvas);this.textures.push(texture);
    const material=new THREE.SpriteMaterial({map:texture,depthTest:true});this.materials.push(material);
    const sprite=new THREE.Sprite(material);sprite.position.set(...pos);sprite.scale.set(width,width*80/512,1);this.group.add(sprite);return sprite;
  }
  sync(match) {
    this.group.visible=match?.mode==='bastion';const b=match?.bastion;if(!b)return;
    const color=b.core.hp<=250?0xff4d40:b.core.hp<=500?0xffae45:0x55ead0;
    this.coreGlow.color.setHex(color);this.coreGlow.emissive.setHex(color);
    this.supplyGlow.emissive.setHex(b.supply.active?0x22ddaa:0x102b29);
    this.supplyLabel.material.opacity=b.supply.active?1:0.4;
    for(const [id,lane] of this.lanes) {
      const active=b.lanes.includes(id)&&match.phase!=='post';
      lane.material.emissive.setHex(active?0xff6a1f:0x332315);lane.label.material.opacity=active?1:0.3;
    }
  }
  dispose() { this.group.removeFromParent();this.group.clear();for(const g of this.geometries)g.dispose();for(const m of this.materials)m.dispose();for(const t of this.textures)t.dispose(); }
}
