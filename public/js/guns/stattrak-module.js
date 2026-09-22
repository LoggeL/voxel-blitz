import * as THREE from '../vendor/three.module.js';
import { normalizeAttachments } from '../../../shared/weapon-attachments.js';
import { disposeObjectTrees } from '../engine/dispose.js';
import { imagegenMap } from '../engine/blender-assets.js';
// StatTrak kill counter: a riveted LED plate on the receiver flank showing the
// weapon's confirmed human kills. Same replaceable-layer pattern as
// applyAttachmentModel: one keyed group under model.body, rebuilt only when the
// toggle or the displayed count changes, disposed through disposeObjectTrees.
const PLATE = { x: -0.052, y: 0.055, z: -0.02, length: 0.11, height: 0.032, thick: 0.014 };
// The IRON PICK sprite lives in the y-z plane, so its plate straddles the flat
// rear head arm (seat and tilt from body.userData.pickaxe.plate), readable from
// either face; the fallback seat matches the default iron-pickaxe build.
const KNIFE_PLATE = { x: 0.01, y: 0.1406, z: 0.0311, rx: 25 * Math.PI / 180, length: 0.09, height: 0.03, thick: 0.046 };
const MAX_DISPLAY = 999999;

function makeCounterTexture(kills) {
  try {
    if (typeof document === 'undefined') return null;
    const canvas = document.createElement('canvas');
    canvas.width = 256; canvas.height = 72;
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.fillStyle = '#0b0d06'; context.fillRect(0, 0, 256, 72);
    context.strokeStyle = '#4a3410'; context.lineWidth = 4; context.strokeRect(3, 3, 250, 66);
    context.fillStyle = '#8a6a2a'; context.font = '700 15px ui-monospace, Menlo, Consolas, monospace';
    context.textBaseline = 'alphabetic';
    context.fillText('KILLS', 14, 24);
    context.fillStyle = '#ffa62e'; context.font = '700 38px ui-monospace, Menlo, Consolas, monospace';
    context.textAlign = 'right';
    context.fillText(String(Math.min(kills, MAX_DISPLAY)), 242, 60);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    return texture;
  } catch (_error) {
    return null;
  }
}

/** Mount (or refresh/remove) the LED kill tally for one gun bundle. Unknown kill
 * counts render nothing: remote players' mastery never crosses the snapshot wire,
 * so their plates stay off rather than showing a wrong number. */
export function applyStattrakModule(model, id, value, kills) {
  const counter = normalizeAttachments(id, value).counter;
  const count = Number.isSafeInteger(kills) && kills >= 0 ? Math.min(kills, MAX_DISPLAY) : null;
  const key = counter === 'stattrak' && count !== null ? `stattrak/${count}` : 'standard';
  if (model.stattrakKey === key) return;
  model.stattrakKey = key;
  if (model.stattrakGroup) {
    disposeObjectTrees([model.stattrakGroup]);
    model.stattrakGroup.removeFromParent();
    model.stattrakGroup = null;
  }
  if (key === 'standard') return;
  const plate = id === 'knife' ? { ...KNIFE_PLATE, ...model.body.userData.pickaxe?.plate } : PLATE;
  const group = new THREE.Group(); group.name = 'stattrak';
  const gunmetal = imagegenMap('worn-gunmetal');
  const housingMat = new THREE.MeshStandardMaterial({ color: 0x9aa1a8, roughness: 0.6, metalness: 0.5 });
  if (gunmetal) { housingMat.map = gunmetal; housingMat.color.setHex(0x565d64); }
  const housing = new THREE.Mesh(new THREE.BoxGeometry(plate.thick, plate.height + 0.008, plate.length + 0.008),
    housingMat);
  const seat = new THREE.Group();
  seat.position.set(plate.x, plate.y, plate.z);
  seat.rotation.x = plate.rx || 0;
  seat.add(housing);
  group.add(seat);
  const texture = makeCounterTexture(count);
  const faces = id === 'knife' ? [-1, 1] : [-1];
  for (const side of faces) {
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(plate.length, plate.height),
      texture ? new THREE.MeshBasicMaterial({ map: texture, toneMapped: false })
        : new THREE.MeshBasicMaterial({ color: 0xff9a2a }));
    screen.rotation.y = side * Math.PI / 2;
    screen.position.set(side * (plate.thick / 2 + 0.001), 0, 0);
    seat.add(screen);
  }
  model.stattrakGroup = group; model.body.add(group);
}
