import * as THREE from '../vendor/three.module.js';
import { createBlenderParts } from '../engine/blender-assets.js';

export function buildRivet({ suit, dark, armor, visor, skin }) {
  const parts = createBlenderParts('rivet', { materialFor(original) {
    const slot = original.userData.slot;
    if (slot === 'skin') return skin;
    if (slot === 'suit' || slot === 'dark') {
      const target = slot === 'suit' ? suit : dark;
      target.map = original.map;
      target.needsUpdate = true;
      return target;
    }
    if (original.userData.paletteColor === 0x26323b) { armor.copy(original); armor.transparent = true; return armor; }
    if (original.userData.paletteColor === 0x6aa5af) { visor.copy(original); visor.transparent = true; return visor; }
    const material = original.clone();
    material.transparent = true;
    return material;
  } });
  if (!parts) return null;
  for (const side of ['l', 'r']) {
    const leg = new THREE.Group();
    const skeleton = new THREE.Group();
    const thigh = parts[`${side}Thigh`], knee = parts[`${side}Knee`], boot = parts[`${side}Boot`];
    thigh.name = 'operator_thigh'; knee.name = 'operator_knee'; boot.name = 'operator_boot';
    leg.add(skeleton); skeleton.add(thigh); thigh.add(knee); knee.add(boot);
    knee.position.y = boot.position.y = -.325;
    leg.userData.joints = { skeleton, thigh, knee, boot };
    parts[`${side}Leg`] = leg;
    const arm = parts[`${side}Arm`], elbow = parts[`${side}Elbow`], hand = parts[`${side}Hand`];
    arm.add(elbow); elbow.add(hand);
    elbow.position.y = hand.position.y = -.34;
    hand.name = 'operator_hand';
  }
  parts.pack.position.set(0, .20, .18);
  parts.pouches.position.set(0, -.075, -.19);
  parts.pack.name = 'operator_pack'; parts.pouches.name = 'operator_pouches';
  parts.torso.add(parts.pack, parts.pouches);
  return parts;
}
