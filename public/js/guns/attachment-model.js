import * as THREE from '../vendor/three.module.js';
import { normalizeAttachments } from '../../../shared/weapon-attachments.js';
import { HANDS } from './defs.js';
import { disposeObjectTrees } from '../engine/dispose.js';

/** One replaceable group, shared by the workshop and first-person presentation. */
export function applyAttachmentModel(model, id, value) {
  const config = normalizeAttachments(id, value);
  const key = `${config.optic}/${config.grip}`;
  if (model.attachmentKey === key) return;
  model.attachmentKey = key;
  if (model.attachmentGroup) {
    disposeObjectTrees([model.attachmentGroup]);
    model.attachmentGroup.removeFromParent();
  }
  model.body.traverse(o => { if (o.name === 'factory-optic') o.visible = config.optic === 'standard'; });
  const group = new THREE.Group(); group.name = 'attachments';
  model.attachmentGroup = group; model.body.add(group);
  const metal = new THREE.MeshStandardMaterial({ color: 0x26303c, roughness: 0.55, metalness: 0.55 });
  const rubber = new THREE.MeshStandardMaterial({ color: 0x10161e, roughness: 0.88 });
  const amber = new THREE.MeshStandardMaterial({ color: 0xffbd52, roughness: 0.45, metalness: 0.3 });
  const materials = [metal, rubber, amber];
  const box = (w,h,d,x,y,z,mat=metal,angle=0) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w,h,d), mat);
    m.position.set(x,y,z); m.rotation.x = angle; group.add(m); return m;
  };
  const baseHeight = model.body.userData.sightHeight || 0.155;
  const height = Math.max(baseHeight, 0.18);
  model.attachmentSightOffset = config.optic === 'standard' ? 0 : height - baseHeight;
  if (config.optic !== 'standard') {
    const z = -0.13;
    box(0.068,0.018,0.11,0,height-0.054,z);
    box(0.03,0.037,0.07,0,height-0.032,z,rubber);
    if (config.optic === 'reflex') {
      box(0.009,0.064,0.04,-0.035,height,z);
      box(0.009,0.064,0.04,0.035,height,z);
      box(0.079,0.009,0.04,0,height+0.032,z);
      box(0.079,0.009,0.04,0,height-0.032,z,amber);
    } else {
      const length = config.optic === 'scope10' ? 0.38 : config.optic === 'scope4' ? 0.26 : 0.14;
      for (const x of [-1,1]) box(0.012,0.07,length,x*0.037,height,z,rubber);
      for (const y of [-1,1]) box(0.085,0.012,length,0,height+y*0.035,z,rubber);
      box(0.03,0.025,0.038,0,height+0.05,z);
      box(0.09,0.012,0.025,0,height+0.041,z-length/2+0.02,amber);
    }
    const glass = new THREE.Mesh(new THREE.PlaneGeometry(0.058,0.053),
      new THREE.MeshBasicMaterial({ color: 0x72cadd, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false }));
    glass.position.set(0,height,z-0.019); group.add(glass);
    const dot = new THREE.Mesh(new THREE.CircleGeometry(0.0018,8),new THREE.MeshBasicMaterial({color:0xff543f,side:THREE.DoubleSide}));
    dot.position.set(0,height,z-0.018); group.add(dot);
  }
  if (config.grip !== 'standard') {
    const z = HANDS[id]?.support?.z || -0.35;
    const y = id === 'lmg' ? -0.1 : -0.045;
    box(0.075,0.025,0.09,0,y,z);
    const angled = config.grip === 'angled';
    box(0.052,angled ? 0.105 : 0.155,0.047,0,y-0.076,z,rubber,angled ? -0.6 : 0);
    box(0.06,0.017,0.055,0,y-0.13,z+ (angled ? 0.03 : 0),amber);
    if (config.grip === 'precision') box(0.11,0.019,0.07,0,y-0.155,z,metal);
  }
  // Materials that a particular configuration did not use have no tree owner.
  const used = new Set(); group.traverse(o => { if (o.material) used.add(o.material); });
  for (const material of materials) if (!used.has(material)) material.dispose();
}
