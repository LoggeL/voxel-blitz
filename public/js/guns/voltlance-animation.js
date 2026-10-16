import * as THREE from '../vendor/three.module.js';

const parts = new WeakMap();
const VIOLET = new THREE.Color(0x792dff);
const ICE = new THREE.Color(0xbcefff);

/** Shared local/snapshot presentation, driven only by actual stored charge. */
export function animateVoltlance(body, charge = 0, time = 0, reducedMotion = false) {
  let cached = parts.get(body);
  if (!cached) {
    cached = { materials: new Set(), auras: [], feathers: [], arcs: [], light: null };
    body.traverse(object => {
      for (const material of [].concat(object.material || [])) {
        if (material.userData.voltlanceGlow) cached.materials.add(material);
      }
      if (object.userData.voltlanceAura) cached.auras.push(object);
      if (object.userData.voltlanceFeather) cached.feathers.push(object);
      if (object.userData.voltlanceArc) cached.arcs.push(object);
      if (object.name === 'lance_charge_light') cached.light = object;
    });
    parts.set(body, cached);
  }
  const level = Math.max(0, Math.min(1, Number(charge) || 0));
  const overload = Math.max(0, (level - 0.72) / 0.28) ** 2;
  const pulse = reducedMotion ? 1 : 1 + overload * (0.08 * Math.sin(time * 37) + 0.035 * Math.sin(time * 59));
  const stageFill = stage => Math.max(0, Math.min(1, level * 3 - stage));
  for (const material of cached.materials) {
    const { role, stage } = material.userData.voltlanceGlow;
    const coil = role === 'coil', core = role === 'core';
    const fill = coil ? stageFill(stage) : level ** 2;
    material.emissive.copy(VIOLET).lerp(ICE, coil ? 0.45 + overload * 0.55 : core ? 0.22 + overload * 0.68 : overload * 0.08);
    material.emissiveIntensity = 0.025 + fill * pulse * (coil ? 2.4 + overload * 6.0
      : core ? 0.9 + overload * 3.4 : role === 'edge' ? 0.3 + overload * 0.65 : 0.14 + overload * 0.38);
  }
  for (const aura of cached.auras) {
    const { stage, size } = aura.userData.voltlanceAura;
    const fill = stage === null ? level ** 2 : stageFill(stage);
    aura.visible = fill > 0;
    aura.material.opacity = Math.min(0.85, fill * (0.25 + overload * 0.60) * pulse);
    aura.scale.setScalar(size * (0.65 + fill * 0.35 + overload * 0.2 * pulse));
  }
  for (const feather of cached.feathers) {
    feather.visible = level > 0;
    feather.material.opacity = Math.min(1, level ** 2 * (0.32 + overload * 0.68) * pulse);
  }
  for (const arc of cached.arcs) {
    arc.visible = overload > 0;
    arc.material.opacity = Math.min(0.85, overload * 0.8 * pulse);
  }
  if (cached.light) {
    cached.light.color.copy(VIOLET).lerp(ICE, 0.38 + overload * 0.20);
    cached.light.intensity = level ** 2 * (0.02 + overload * 0.14) * pulse;
  }
}
