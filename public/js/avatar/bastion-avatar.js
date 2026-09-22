import * as THREE from '../vendor/three.module.js';
import { BASTION_ENEMIES } from '../../../shared/bastion.js';
import { SkinLayer } from '../cosmetics/skin-layer.js';

// Role silhouettes ride on the standard combat body inside its hitbox
// envelope; the whole body is scaled by `bodyScale` (group scale), which is
// exactly how shared/player-hitboxes.js scales the damage volumes.
const SIGNAL = Object.freeze({ charging: 0xff5500, cooldown: 0x174052, breach: 0xffc400, slam: 0xff2a2a, strike: 0xff3d00 });

/**
 * Rigid role details batched into one mesh per joint (the revenant `panels()`
 * pattern): boxes are baked into a single BufferGeometry so a juggernaut's
 * plating on seven joints costs seven draw calls, not forty.
 */
function panels(layer, parent, name, material) {
  const group = layer.group(parent, `bastion_${name}`);
  const sources = [];
  const transform = new THREE.Object3D();
  const box = (size, position, rotation = [0, 0, 0]) => {
    const geometry = new THREE.BoxGeometry(...size).toNonIndexed();
    transform.position.set(...position); transform.rotation.set(...rotation); transform.updateMatrix();
    geometry.applyMatrix4(transform.matrix);
    sources.push(geometry);
  };
  const finish = () => {
    if (!sources.length) return null;
    const geometry = new THREE.BufferGeometry();
    for (const key of ['position', 'normal']) {
      const total = sources.reduce((n, source) => n + source.attributes[key].array.length, 0);
      const array = new Float32Array(total);
      let offset = 0;
      for (const source of sources) { array.set(source.attributes[key].array, offset); offset += source.attributes[key].array.length; }
      geometry.setAttribute(key, new THREE.BufferAttribute(array, 3));
    }
    for (const source of sources) source.dispose();
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `${group.name}_plates`;
    group.add(mesh);
    return mesh;
  };
  return { group, box, finish };
}

const BUILDERS = {
  // Runner: a visor bar across the face and a slim pack hidden inside the torso envelope.
  runner(av, layer, m) {
    const head = panels(layer, av.head, 'runner_visor', m.signal);
    head.box([0.28, 0.07, 0.06], [0, 0.07, -0.19]); head.finish();
    const torso = panels(layer, av.torso, 'runner_pack', m.dark);
    torso.box([0.28, 0.32, 0.10], [0, 0.10, 0.26]); torso.finish();
  },
  // Breacher: twin rocket tanks on the back at z +0.28.
  breacher(av, layer, m) {
    const p = panels(layer, av.torso, 'breacher_tanks', m.suit);
    for (const x of [-0.10, 0.10]) p.box([0.16, 0.9, 0.16], [x, 0.05, 0.28]);
    p.finish();
    const s = panels(layer, av.torso, 'breacher_signal', m.signal);
    for (const x of [-0.10, 0.10]) s.box([0.10, 0.06, 0.10], [x, 0.52, 0.28]);
    s.finish();
  },
  // Heavy: shoulder pads at x ±0.30 and a chest plate.
  heavy(av, layer, m) {
    const p = panels(layer, av.torso, 'heavy_plates', m.dark);
    for (const x of [-0.30, 0.30]) p.box([0.20, 0.16, 0.34], [x, 0.30, 0]);
    p.box([0.40, 0.36, 0.06], [0, 0.10, -0.30]);
    p.finish();
    const s = panels(layer, av.torso, 'heavy_signal', m.signal);
    s.box([0.18, 0.05, 0.02], [0, 0.20, -0.335]); s.finish();
  },
  // Brute: pauldrons on the arm roots, a heavier chest plate and a helmet crest.
  brute(av, layer, m) {
    for (const [arm, name] of [[av.lArm, 'brute_lpauldron'], [av.rArm, 'brute_rpauldron']]) {
      const p = panels(layer, arm, name, m.dark);
      p.box([0.26, 0.14, 0.30], [0, 0.06, 0]); p.finish();
    }
    const chest = panels(layer, av.torso, 'brute_chest', m.suit);
    chest.box([0.44, 0.5, 0.06], [0, 0.04, -0.31]); chest.finish();
    const crest = panels(layer, av.head, 'brute_crest', m.dark);
    crest.box([0.06, 0.10, 0.30], [0, 0.13, 0]); crest.finish();
    const s = panels(layer, av.torso, 'brute_signal', m.signal);
    s.box([0.22, 0.05, 0.02], [0, 0.22, -0.345]); s.finish();
  },
  // Juggernaut: plating on all seven parts, twin back tanks, a faceplate.
  juggernaut(av, layer, m) {
    const plate = (parent, name, boxes) => { const p = panels(layer, parent, name, m.dark); for (const [size, pos] of boxes) p.box(size, pos); p.finish(); };
    plate(av.head, 'jugg_helm', [[[0.34, 0.10, 0.34], [0, 0.13, 0]], [[0.30, 0.20, 0.05], [0, -0.02, -0.19]]]);
    plate(av.torso, 'jugg_torso', [[[0.50, 0.46, 0.06], [0, 0.06, -0.31]], [[0.06, 0.40, 0.44], [-0.26, 0.04, 0]], [[0.06, 0.40, 0.44], [0.26, 0.04, 0]]]);
    plate(av.hips, 'jugg_hips', [[[0.60, 0.16, 0.06], [0, 0, -0.18]]]);
    plate(av.lArm, 'jugg_larm', [[[0.24, 0.14, 0.26], [0, 0.06, 0]], [[0.18, 0.30, 0.18], [0, -0.28, 0]]]);
    plate(av.rArm, 'jugg_rarm', [[[0.24, 0.14, 0.26], [0, 0.06, 0]], [[0.18, 0.30, 0.18], [0, -0.28, 0]]]);
    plate(av.lLeg, 'jugg_lleg', [[[0.22, 0.30, 0.06], [0, -0.20, -0.12]]]);
    plate(av.rLeg, 'jugg_rleg', [[[0.22, 0.30, 0.06], [0, -0.20, -0.12]]]);
    const tanks = panels(layer, av.torso, 'jugg_tanks', m.suit);
    for (const x of [-0.12, 0.12]) tanks.box([0.18, 0.8, 0.16], [x, 0.02, 0.28]);
    tanks.finish();
    const s = panels(layer, av.torso, 'jugg_signal', m.signal);
    s.box([0.26, 0.06, 0.02], [0, 0.26, -0.345]);
    for (const x of [-0.12, 0.12]) s.box([0.12, 0.06, 0.12], [x, 0.44, 0.28]);
    s.finish();
  },
};

/** `{ role: { suit, dark, scale, build(avatar, layer, materials) } }`; materials = { suit, dark, signal }. */
export const ENEMY_LOOKS = Object.freeze(Object.fromEntries(Object.entries(BASTION_ENEMIES)
  .filter(([, profile]) => !profile.vehicle)
  .map(([role, profile]) => [role, Object.freeze({
    suit: profile.look?.suit ?? 0x9d73cc, dark: profile.look?.dark ?? 0x252c36, scale: profile.scale ?? 1,
    build: BUILDERS[role] || (() => {}),
  })])));


/** Role equipment preserves the standard combat body and its hit volumes. */
export function updateBastionAvatar(avatar, remote) {
  const role = remote.npcRole;
  const look = ENEMY_LOOKS[role];
  if (!look || avatar.vehicle) return;
  if (avatar.bastionRole !== role) {
    avatar._roleLayer?.clear();
    avatar.bastionRole = role;
    avatar.suitMaterial.color.setHex(look.suit); avatar.darkMaterial.color.setHex(look.dark);
    const layer = avatar._roleLayer = new SkinLayer();
    const materials = {
      suit: layer.material(look.suit, { flatShading: false }),
      dark: layer.material(look.dark, { flatShading: false }),
      signal: layer.material(look.suit, { emissive: 0x000000, roughness: 0.6, metalness: 0.1, flatShading: false }),
    };
    avatar.bastionSignal = materials.signal;
    look.build(avatar, layer, materials);
    // Every role material fades with the body and takes the hit flash.
    for (const material of layer.materials) {
      material.transparent = true;
      if (!avatar.fadeMaterials.includes(material)) avatar.fadeMaterials.push(material);
      if (material.emissive && !avatar.flashMaterials.includes(material)) avatar.flashMaterials.push(material);
    }
  }
  const scale = Number.isFinite(remote.npcScale) && remote.npcScale > 0 ? remote.npcScale : look.scale ?? 1;
  avatar.bodyScale = scale;
  applyBastionSignal(avatar, remote);
}

/** Attack tell on the signal material; the roster re-applies it after the hit flash. */
export function applyBastionSignal(avatar, remote) {
  avatar.bastionSignal?.emissive.setHex(SIGNAL[remote.npcAttack] ?? 0x000000);
}
