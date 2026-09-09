import * as THREE from '../vendor/three.module.js';
import { BASTION_ENEMIES } from '../../../shared/bastion.js';

/** Role equipment preserves the standard combat body and its hit volumes. */
export function updateBastionAvatar(avatar,remote) {
  const role=remote.npcRole;if(!BASTION_ENEMIES[role])return;
  if(!avatar.bastionRole) {
    avatar.bastionRole=role;
    const color=role==='runner'?0xd69b3e:role==='breacher'?0xf26743:0x9d73cc;
    avatar.suitMaterial.color.setHex(color);avatar.darkMaterial.color.setHex(0x252c36);
    const material=new THREE.MeshStandardMaterial({color,emissive:0x000000,transparent:true,roughness:.6});
    avatar.bastionSignal=material;avatar.fadeMaterials.push(material);
    const add=(parent,x,y,z,w,h,d)=>{const mesh=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),material);mesh.position.set(x,y,z);parent.add(mesh);};
    if(role==='breacher') for(const x of [-.18,.18]) add(avatar.torso,x,.18,.45,.17,.95,.18);
    if(role==='heavy') for(const x of [-.38,.38]) add(avatar.torso,x,.28,0,.2,.23,.55);
    if(role==='runner') add(avatar.head,0,.07,-.19,.28,.07,.06);
  }
  avatar.bastionSignal.emissive.setHex(remote.npcAttack==='charging'?0xff5500:remote.npcAttack==='cooldown'?0x174052:0x000000);
}
