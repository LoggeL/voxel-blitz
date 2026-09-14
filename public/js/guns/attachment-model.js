import * as THREE from '../vendor/three.module.js';
import { normalizeAttachments } from '../../../shared/weapon-attachments.js';
import { HANDS } from './defs.js';
import { disposeObjectTrees } from '../engine/dispose.js';
import { imagegenMap } from '../engine/blender-assets.js';

/** Blender-grade PBR twins of the authored gun metals, so bolt-on optics and
 *  grips read as part of the textured receiver instead of flat placeholder
 *  boxes. Maps are page-owned and shared; each gun still owns its materials. */
function attachmentMaterials() {
  const gunmetal = imagegenMap('worn-gunmetal');
  const rubber = imagegenMap('worn-rubber');
  const metal = new THREE.MeshStandardMaterial({ color: 0x8f979e, roughness: 0.52, metalness: 0.78 });
  if (gunmetal) { metal.map = gunmetal; metal.color.setHex(0xd7dce2); }
  const grip = new THREE.MeshStandardMaterial({ color: 0x3a3f45, roughness: 0.9, metalness: 0.05 });
  if (rubber) { grip.map = rubber; grip.color.setHex(0xffffff); }
  const amber = new THREE.MeshStandardMaterial({ color: 0xffbd52, roughness: 0.45, metalness: 0.3,
    emissive: 0xff9d2e, emissiveIntensity: 0.35 });
  // Cyber-scope glow cells. Flagged for the viewmodel charge drive: emissive
  // intensity follows the lance cell while the geometry stays static.
  const cyber = new THREE.MeshStandardMaterial({ color: 0x0b2b33, roughness: 0.4, metalness: 0.6,
    emissive: 0x35f0ff, emissiveIntensity: 0.9 });
  cyber.userData.chargeGlow = true;
  return [metal, grip, amber, cyber];
}

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
  const [metal, rubber, amber, cyber] = attachmentMaterials();
  const materials = [metal, rubber, amber, cyber];
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
    } else if (config.optic === 'cyber') {
      // CY-9 cyber scope: squat digital hood on the shared rail+saddle, cyan
      // glow rails and charge cells, cyan objective glass. Optical center
      // stays on `height` exactly like every other optic.
      box(0.082,0.05,0.11,0,height-0.026,z);
      box(0.06,0.012,0.12,0,height+0.006,z,rubber);
      box(0.06,0.045,0.02,0,height-0.026,z+0.06,rubber);
      for (const side of [-1, 1]) {
        box(0.004,0.02,0.09,side*0.043,height-0.026,z,cyber);
        box(0.012,0.004,0.02,side*0.018,height+0.014,z,cyber);
      }
      box(0.012,0.004,0.02,0,height+0.014,z,cyber);
      const cyberGlass = new THREE.Mesh(new THREE.PlaneGeometry(0.058,0.05),
        new THREE.MeshBasicMaterial({ color: 0x7dfcff, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false }));
      cyberGlass.position.set(0,height,z-0.019); group.add(cyberGlass);
      const cyberDot = new THREE.Mesh(new THREE.CircleGeometry(0.0022,12),
        new THREE.MeshBasicMaterial({ color: 0x9ffbff, side: THREE.DoubleSide }));
      cyberDot.position.set(0,height,z-0.018); group.add(cyberDot);
      const cyberRing = new THREE.Mesh(new THREE.RingGeometry(0.008,0.010,24),
        new THREE.MeshBasicMaterial({ color: 0x35f0ff, transparent: true, opacity: 0.8, side: THREE.DoubleSide }));
      cyberRing.position.set(0,height,z-0.018); group.add(cyberRing);
    } else {
      const length = config.optic === 'scope10' ? 0.38 : config.optic === 'scope4' ? 0.26 : 0.14;
      for (const x of [-1,1]) box(0.012,0.07,length,x*0.037,height,z,rubber);
      for (const y of [-1,1]) box(0.085,0.012,length,0,height+y*0.035,z,rubber);
      box(0.03,0.025,0.038,0,height+0.05,z);
      box(0.09,0.012,0.025,0,height+0.041,z-length/2+0.02,amber);
    }
    if (config.optic !== 'cyber') {
      const glass = new THREE.Mesh(new THREE.PlaneGeometry(0.058,0.053),
        new THREE.MeshBasicMaterial({ color: 0x72cadd, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false }));
      glass.position.set(0,height,z-0.019); group.add(glass);
      const dot = new THREE.Mesh(new THREE.CircleGeometry(0.0018,8),new THREE.MeshBasicMaterial({color:0xff543f,side:THREE.DoubleSide}));
      dot.position.set(0,height,z-0.018); group.add(dot);
    }
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
