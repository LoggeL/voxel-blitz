import * as THREE from '../vendor/three.module.js';

/** Gun-owned induction surfaces fitted to PIKE, or the DOM-free procedural model. */
export function addVoltlanceGlow({ kit, T, groups, authored = false }) {
  const { body } = groups;
  const { box, cylZ } = kit;
  const violet = 0x792dff;
  const owned = new Map();
  for (const group of Object.values(groups)) group?.traverse(object => {
    if (!object.material) return;
    const replace = original => {
      if (original.userData.voltlanceGlow) return original;
      if (!original.userData.cosmeticGlow && original.color?.getHex() !== 0xc9a2ff) return original;
      if (!owned.has(original)) {
        const material = original.clone();
        material.userData.voltlanceGlow = { role: 'housing' };
        delete material.userData.chargeGlow;
        owned.set(original, material);
      }
      return owned.get(original);
    };
    object.material = Array.isArray(object.material) ? object.material.map(replace) : replace(object.material);
  });
  const material = (role, stage = null) => {
    const m = new THREE.MeshStandardMaterial({ color: 0x170c2d, roughness: 0.36,
      metalness: 0.18, emissive: violet, emissiveIntensity: 0.025 });
    m.userData.voltlanceGlow = { role, stage };
    return m;
  };
  const edge = material('edge'), core = material('core');
  const texture = (width, height, paint) => {
    const pixels = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      pixels.set(paint(x, y).map(v => Math.round(v * 255)), (y * width + x) * 4);
    }
    const map = new THREE.DataTexture(pixels, width, height);
    map.minFilter = map.magFilter = THREE.LinearFilter;
    map.needsUpdate = true;
    return map;
  };
  const bandMap = texture(4, 64, (x, y) => {
    const hot = Math.exp(-(((y - 31.5) / 10) ** 2));
    return [0.12 + hot * 0.60, 0.015 + hot ** 2 * 0.92, 0.48 + hot * 0.52, 1];
  });
  const auraMap = texture(32, 32, (x, y) => [1, 1, 1,
    Math.max(0, 1 - Math.hypot(x - 15.5, y - 15.5) / 16) ** 2]);
  const featherMap = texture(32, 16, (x, y) => [1, 1, 1,
    Math.exp(-(((x - 15.5) / 6) ** 2)) * Math.min(1, y / 2, (15 - y) / 2)]);
  // Do not dispose Three's global Sprite geometry with an individual gun.
  const plane = new THREE.PlaneGeometry(1, 1);
  const aura = (parent, position, size, stage = null) => {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: auraMap, color: 0x833bff,
      transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthTest: true,
      depthWrite: false, toneMapped: false }));
    sprite.geometry = plane;
    sprite.position.set(...position);
    sprite.scale.setScalar(size);
    sprite.userData.voltlanceAura = { stage, size };
    sprite.visible = false;
    sprite.raycast = () => {};
    parent.add(sprite);
    return sprite;
  };
  const strip = (position, length, normal, direction, width = 0.005) => {
    const up = new THREE.Vector3(...direction), n = new THREE.Vector3(...normal);
    const rotation = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(
      new THREE.Vector3().crossVectors(up, n), up, n));
    for (const [w, depth, m] of [[width, 0.0018, edge], [width * 0.25, 0.0024, core]]) {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, length, depth), m);
      mesh.quaternion.copy(rotation);
      mesh.position.set(...position).addScaledVector(n, depth / 2);
      body.add(mesh);
    }
    const feather = new THREE.Mesh(plane, new THREE.MeshBasicMaterial({ map: featherMap,
      color: violet, transparent: true, opacity: 0, blending: THREE.AdditiveBlending,
      depthWrite: false, depthTest: true, toneMapped: false, side: THREE.DoubleSide }));
    feather.quaternion.copy(rotation);
    feather.position.set(...position).addScaledVector(n, 0.0026);
    feather.scale.set(width * 6, length + 0.009, 1);
    feather.userData.voltlanceFeather = true;
    feather.visible = false;
    feather.raycast = () => {};
    body.add(feather);
  };

  const positions = authored ? [-0.266, -0.312, -0.356] : [-0.426, -0.544, -0.661];
  const radius = authored ? 0.0306 : 0.0346;
  positions.forEach((z, stage) => {
    const coil = new THREE.Group();
    coil.name = `voltlance_coil_${stage}`;
    coil.position.set(0, T.muzzle[1], z);
    coil.userData.voltlanceCoil = { stage, homeZ: z };
    body.add(coil);
    const surface = cylZ(coil, radius, 0.032, 0, 0, 0, violet, { seg: 32 });
    surface.material = material('coil', stage);
    surface.material.emissiveMap = bandMap;
    if (stage === 0 && authored) {
      for (const offset of [-0.018, 0.018]) {
        cylZ(coil, radius + 0.0015, 0.003, 0, 0, offset, 0x614534, { seg: 24, mt: 0.55 });
      }
    }
    for (const side of [-1, 1]) aura(coil, [side * 0.034, 0.018, 0], 0.092, stage);
  });

  for (const side of [-1, 1]) {
    // Copper stays exposed beside its inset electrical conductor.
    strip([side * 0.045, 0.0625, -0.206], 0.43, [0, 1, 0], [0, 0, -1], 0.004);
    strip([side * 0.0461, 0.021, -0.085], 0.21, [side, 0, 0], [0, 0, -1]);
    strip([side * 0.0461, 0.000, 0.025], 0.041, [side, 0, 0], [0, 1, 0], 0.004);
    // Fine rear-facing trim and optic accents do not enter the aperture.
    strip([side * 0.012, 0.064, authored ? 0.0781 : 0.071], 0.040, [0, 0, 1], [0, 1, 0], 0.004);
    strip([side * 0.0145, 0.127, authored ? 0.0801 : 0.108], 0.029, [0, 0, 1], [0, 1, 0], 0.002);
    strip([side * 0.017, 0.0655, 0.17], 0.10, [0, 1, 0], [0, 0, -1], 0.003);
    aura(body, [side * 0.042, 0.074, -0.12], 0.11);
  }
  // Keep the floating accelerator spine fitted to its authored risers.
  strip([0, authored ? 0.0861 : 0.081, -0.5585], 0.259, [0, 1, 0], [0, 0, -1], 0.008);
  const emitter = new THREE.Mesh(new THREE.TorusGeometry(0.014, 0.0012, 6, 32), core);
  emitter.position.set(T.muzzle[0], T.muzzle[1], T.muzzle[2] + 0.0013);
  body.add(emitter);
  aura(body, [-0.018, T.muzzle[1] + 0.014, T.muzzle[2] + 0.002], 0.12);
  // The emitter is seen from behind its copper cage. A tiny exposed corona at
  // the rim keeps the discharge point visible without filling the sight line.
  const tip = aura(body, [-0.028, T.muzzle[1] + 0.022, T.muzzle[2] + 0.002], 0.062);
  tip.material.color.setHex(0xb4dfff).multiplyScalar(3);

  // Short containment filaments stay beside the coils, outside the aiming line.
  for (const side of [-1, 1]) for (let stage = 0; stage < 2; stage++) {
    const z = positions[stage], end = positions[stage + 1];
    const points = Array.from({ length: 7 }, (_, i) => new THREE.Vector3(
      side * (radius + 0.003 + (i % 2) * 0.003), T.muzzle[1] + 0.009,
      z + (end - z) * i / 6));
    const arc = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points),
      new THREE.LineBasicMaterial({ color: 0x80dfff, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthTest: true, depthWrite: false, toneMapped: false }));
    arc.userData.voltlanceArc = true;
    arc.visible = false;
    arc.raycast = () => {};
    body.add(arc);
  }
  const light = new THREE.PointLight(0x8b6dff, 0, 0.95, 2);
  light.name = 'lance_charge_light';
  light.position.set(-0.095, 0.125, -0.24);
  light.visible = false;
  body.add(light);
}
