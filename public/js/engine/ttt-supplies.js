import * as THREE from '../vendor/three.module.js';
const colors={frag:0x73905b,smoke:0xb9ced5,molotov:0x916a3f,c4:0xb24f41};
/** Ground equipment and placed C4, visible normally in the world. */
export class TttSupplyView {
  constructor(){this.group=new THREE.Group();this.group.name='ttt-supplies';this.items=new Map();}
  sync(rows=[]){
    const keep=new Set();
    for(const row of rows){
      const type=row.grenade||'c4',id=String(row.id);keep.add(id);
      let item=this.items.get(id);
      if(!item){
        const root=new THREE.Group();const resources=[];
        const box=(w,h,d,color,x,y,z)=>{const geo=new THREE.BoxGeometry(w,h,d),mat=new THREE.MeshStandardMaterial({color,roughness:.7});const mesh=new THREE.Mesh(geo,mat);mesh.position.set(x,y,z);root.add(mesh);resources.push(geo,mat);};
        if(type==='c4'){
          box(.65,.18,.42,colors.c4,0,.1,0);box(.48,.04,.12,0x222a2d,0,.21,0);box(.1,.03,.06,0xff3b29,.13,.245,0);
        }else{
          box(.25,.34,.25,colors[type]||colors.frag,0,.2,0);
          box(.12,.12,.12,0x252e2c,0,.43,0);
          box(.035,.29,.06,0xb6b9a8,.14,.35,0);
        }
        item={root,resources};this.items.set(id,item);this.group.add(root);
      }
      item.root.position.set(row.x,row.y,row.z);
    }
    for(const [id,item]of this.items)if(!keep.has(id)){item.root.removeFromParent();item.resources.forEach(r=>r.dispose());this.items.delete(id);}
  }
  dispose(){this.sync([]);this.group.removeFromParent();}
}
