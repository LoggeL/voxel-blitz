// The same moving parts and thermal cues are visible in both camera and avatar models.
const parts = new WeakMap();

export function animateHeavyWeapon(body, { dt = 0, time = 0, minigun, flameActive = false, fuel = 1 } = {}) {
  let cached = parts.get(body);
  if (!cached) {
    cached = { rotor: body.getObjectByName('minigun_rotor'),
      needle: body.getObjectByName('flamethrower_pressure_needle'),
      thermal: new Set(), indicators: new Set(), nozzle: new Set(), pilot: new Set(), flameHeat: 0 };
    body.traverse(object => {
      const material = object.material;
      if (!material?.emissive) return;
      if (material.userData.thermal) cached.thermal.add(material);
      if (Number.isFinite(material.userData.heatIndicator)) cached.indicators.add(material);
      if (material.userData.flameThermal) cached.nozzle.add(material);
      if (material.userData.pilot) cached.pilot.add(material);
    });
    parts.set(body, cached);
  }
  const heat = Math.max(0, Math.min(1, minigun?.heat || 0));
  if (cached.rotor) cached.rotor.rotation.z += dt * (minigun?.spin || 0) * 42;
  for (const material of cached.thermal) {
    material.emissive.setHex(0xff3808);
    material.emissiveIntensity = heat * heat * 1.8;
  }
  for (const material of cached.indicators) {
    const lit = heat >= material.userData.heatIndicator;
    material.emissive.setHex(minigun?.overheated || heat >= 0.9 ? 0xff3020 : 0xffa52b);
    material.emissiveIntensity = lit ? 1.8 : 0.08;
  }
  cached.flameHeat += ((flameActive ? 1 : 0) - cached.flameHeat) * (1 - Math.exp(-dt * (flameActive ? 5 : 1.6)));
  for (const material of cached.nozzle) {
    material.emissive.setHex(0xff500c);
    material.emissiveIntensity = cached.flameHeat * 1.6;
  }
  for (const material of cached.pilot) {
    material.emissive.setHex(0x419dff);
    material.emissiveIntensity = (flameActive ? 2.2 : 0.65) + Math.sin(time * 29) * 0.12;
  }
  if (cached.needle) {
    const { minAngle = 1.1, maxAngle = -1.1 } = cached.needle.userData;
    const pressure = Math.max(0, Math.min(1, fuel * (flameActive ? 0.9 : 1)));
    cached.needle.rotation.z = minAngle + (maxAngle - minAngle) * pressure + (flameActive ? Math.sin(time * 37) * 0.025 : 0);
  }
}
