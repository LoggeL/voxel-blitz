import * as THREE from '../vendor/three.module.js';
import { makeAvatar, disposeAvatar } from '../avatar/avatar.js';

/** Persistent bodies use authoritative positions, including for late joiners. */
export class TttCorpseView {
  constructor() { this.group=new THREE.Group();this.group.name='ttt-corpses';this.items=new Map(); }
  sync(rows=[]) {
    const retained=new Set();
    for (const row of rows) {
      retained.add(row.id);
      let item=this.items.get(row.id);
      if (!item) {
        const avatar=makeAvatar(`corpse-${row.id}`,'');
        avatar.tag.visible=avatar.hpSpr.visible=avatar.weaponModel.root.visible=false;
        // Lay the existing operator model on its back, centered on the death site.
        avatar.group.rotation.x=-Math.PI/2;
        avatar.group.position.set(0,.28,.85);
        const root=new THREE.Group();root.add(avatar.group);this.group.add(root);
        item={root,avatar};this.items.set(row.id,item);
      }
      item.root.position.set(row.x,row.y,row.z);
      item.root.rotation.y=row.yaw||0;
    }
    for (const [id,item] of this.items) if (!retained.has(id)) {
      disposeAvatar(item.avatar);item.root.removeFromParent();this.items.delete(id);
    }
  }
  dispose() { this.sync([]);this.group.removeFromParent(); }
}
