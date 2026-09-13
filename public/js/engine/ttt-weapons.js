import * as THREE from '../vendor/three.module.js';
import { buildGun, disposeGunModels } from '../guns/assemble.js';
import { MaterialCache } from '../guns/kit.js';
import { TTT_WEAPONS } from '../../../shared/ttt.js';
export class TttWeaponView {
  constructor() { this.group=new THREE.Group();this.items=new Map(); }
  sync(rows=[]) {
    const retained=new Set();
    for (const row of rows.slice(0,96)) {
      if (!TTT_WEAPONS.includes(row.weapon)) continue;
      retained.add(row.id);
      if (!this.items.has(row.id)) {
        const cache=new MaterialCache(), model=buildGun(row.weapon,cache);
        model.root.traverse(o=>{if(o.name==='hand_r'||o.name==='hand_l')o.visible=false;});
        model.root.rotation.set(0,0,Math.PI/2);model.root.scale.setScalar(1.4);
        const root=new THREE.Group();root.add(model.root);this.group.add(root);
        this.items.set(row.id,{root,model,cache});
      }
      this.items.get(row.id).root.position.set(row.x,row.y+.35,row.z);
    }
    for (const [id,item] of this.items) if (!retained.has(id)) {
      disposeGunModels([item.model],item.cache);item.root.removeFromParent();this.items.delete(id);
    }
  }
  dispose() { this.sync([]);this.group.removeFromParent(); }
}
