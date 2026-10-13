import * as THREE from '../vendor/three.module.js';

const parts = new WeakMap();
const COLD = new THREE.Color(0x5a1410);
const RED = new THREE.Color(0xff3510);
const HOT = new THREE.Color(0xffe2a0);
const AMBER = new THREE.Color(0xff6a12);

/** Both perspectives use the weapon's live charge, including released charge decay. */
export function animateChargeRifle(body, charge = 0, time = 0, reducedMotion = false) {
  let cached = parts.get(body);
  if (!cached) {
    cached = { cells: [], halos: [], ribbons: [], heat: new Set(), light: null };
    body.traverse(object => {
      if (object.userData.chargeCell) cached.cells.push({ collar: object,
        material: object.children[0].material, ...object.userData.chargeCell });
      if (object.userData.chargeHalo) cached.halos.push(object);
      if (object.userData.chargeRibbon) cached.ribbons.push(object);
      if (object.name === 'chargerifle_charge_light') cached.light = object;
      if (object.material?.userData.chargeHeat) cached.heat.add(object.material);
    });
    parts.set(body, cached);
  }
  const level = Math.max(0, Math.min(1, Number(charge) || 0));
  const overload = Math.max(0, (level - 0.75) / 0.25) ** 2;
  const pulse = reducedMotion ? 1 : 1 + overload *
    (0.10 * Math.sin(time * 37) + 0.04 * Math.sin(time * 61));
  for (const { collar, material, stage, homeZ } of cached.cells) {
    // Mirrored pairs fill successively. An empty front pair stays visibly cold.
    const fill = Math.max(0, Math.min(1, level * 3 - stage));
    material.color.copy(COLD).lerp(RED, fill);
    material.emissive.copy(AMBER).lerp(HOT, 0.25 * fill + overload * 0.75);
    material.emissiveIntensity = 0.02 + fill * (2.8 + overload * 7) * pulse;
    collar.position.z = homeZ - fill * 0.007;
  }
  for (const material of cached.heat) {
    const role = material.userData.chargeHeat;
    const isCore = role === 'core' || role === 'emitter';
    material.emissive.copy(RED).lerp(isCore ? HOT : AMBER, overload * (isCore ? 0.65 : 0.35));
    material.emissiveIntensity = 0.02 + level ** (role === 'emitter' ? 3 : 2) *
      (isCore ? 1.2 + overload * 3.2 : 0.3 + overload * 0.5) * pulse;
  }
  for (const ribbon of cached.ribbons) {
    ribbon.visible = level > 0;
    ribbon.material.opacity = Math.min(1, level ** 2 * (0.32 + overload * 0.68) * pulse);
  }
  if (cached.light) {
    cached.light.color.copy(RED).lerp(AMBER, level);
    cached.light.intensity = level ** 2 * (0.018 + overload * 0.10) * pulse;
  }
  for (const sprite of cached.halos) {
    const { stage, size } = sprite.userData.chargeHalo;
    const fill = stage === null ? level ** 2 : Math.max(0, Math.min(1, level * 3 - stage));
    sprite.visible = fill > 0;
    const cellHalo = stage !== null;
    sprite.material.opacity = Math.min(cellHalo ? 0.85 : 1, fill * (0.5 + overload * 0.75) * pulse);
    sprite.scale.setScalar(size * (0.6 + fill * 0.4 + overload * (cellHalo ? 0.25 : 0.4) * pulse));
  }
}
