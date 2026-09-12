import * as THREE from '../../vendor/three.module.js';
import { COL, makeReticleTexture } from '../kit.js';
import { BOLT_HOME, BREACH_Z, D2R, TRIGGER_Z } from './common.js';

/** Build the LONGSHOT MK-II silhouette and its stripper-round reload parts. */
export function build({ kit, T, groups }) {
  const { box, cylZ, mat } = kit;
  const { body, mag, bolt, trigger, extra } = groups;
  const barrelY = T.muzzle[1];
  const bodyBoxGeometry = new THREE.BoxGeometry(1, 1, 1);
  const bodyBoxBatches = new Map();

  // Static detail boxes share one draw call per material profile. Dynamic reload/action groups
  // deliberately keep their individual meshes below so animation ownership remains unchanged.
  function bodyBox(w, h, d, x, y, z, color, options = {}) {
    const roughness = options.rg ?? 0.78;
    const metalness = options.mt ?? 0.22;
    const key = `${color}|${roughness}|${metalness}`;
    let batch = bodyBoxBatches.get(key);
    if (!batch) {
      batch = { color, roughness, metalness, instances: [] };
      bodyBoxBatches.set(key, batch);
    }
    batch.instances.push({ w, h, d, x, y, z, options });
  }

  function flushBodyBoxes() {
    const transform = new THREE.Object3D();
    for (const batch of bodyBoxBatches.values()) {
      const mesh = new THREE.InstancedMesh(
        bodyBoxGeometry,
        mat(batch.color, batch.roughness, batch.metalness),
        batch.instances.length,
      );
      mesh.name = 'sniper_static_detail_batch';
      for (let i = 0; i < batch.instances.length; i++) {
        const instance = batch.instances[i];
        transform.position.set(instance.x, instance.y, instance.z);
        transform.rotation.set(
          instance.options.rx || 0,
          instance.options.ry || 0,
          instance.options.rz || 0,
        );
        transform.scale.set(instance.w, instance.h, instance.d);
        transform.updateMatrix();
        mesh.setMatrixAt(i, transform.matrix);
      }
      mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      mesh.instanceMatrix.needsUpdate = true;
      body.add(mesh);
    }
  }

  // Stepped action and slab-sided chassis. Thin side plates keep the side-view silhouette
  // readable without making the first-person receiver excessively wide.
  bodyBox(0.090, 0.112, 0.300, 0, 0.020, -0.105, COL.cerakote);
  bodyBox(0.106, 0.072, 0.205, 0, 0.012, -0.270, COL.greenSteel);
  bodyBox(0.082, 0.034, 0.130, 0, 0.093, -0.035, COL.gunmetal);
  bodyBox(0.070, 0.028, 0.075, 0, -0.045, -0.020, COL.polyDark);
  for (const side of [-1, 1]) {
    bodyBox(0.008, 0.072, 0.220, side * 0.052, 0.028, -0.120,
      COL.gunmetal, { rg: 0.60, mt: 0.50 });
    bodyBox(0.005, 0.034, 0.092, side * 0.057, 0.042, -0.115,
      COL.polyDark);
    bodyBox(0.006, 0.013, 0.070, side * 0.061, 0.020, -0.245,
      COL.amber, { rg: 0.50, mt: 0.35 });
  }

  // Angled pistol grip and enclosed trigger guard mirror the reference's AR-style fire control.
  bodyBox(0.062, 0.138, 0.064, 0, -0.090, -0.085, COL.polymer,
    { rx: -0.20, rg: 0.92, mt: 0.04 });
  bodyBox(0.067, 0.026, 0.070, 0, -0.151, -0.066, COL.polyDark,
    { rx: -0.20 });
  for (let i = 0; i < 3; i++) {
    bodyBox(0.066, 0.009, 0.009, 0, -0.065 - i * 0.026,
      -0.048 + i * 0.005, COL.gunmetal, { rx: -0.20 });
  }
  bodyBox(0.050, 0.010, 0.090, 0, -0.040, -0.175, COL.polyDark);
  bodyBox(0.010, 0.056, 0.010, -0.022, -0.067, -0.206, COL.polyDark,
    { rx: 0.34 });
  bodyBox(0.010, 0.056, 0.010, 0.022, -0.067, -0.206, COL.polyDark,
    { rx: 0.34 });

  // Adjustable skeleton stock: twin chassis struts, open center, cheek riser, and orange pad.
  bodyBox(0.052, 0.030, 0.330, 0, 0.062, 0.205, COL.cerakote,
    { rx: -0.025 });
  bodyBox(0.052, 0.026, 0.300, 0, -0.061, 0.220, COL.greenSteel,
    { rx: 0.22 });
  bodyBox(0.060, 0.034, 0.165, 0, 0.113, 0.205, COL.polymer,
    { rg: 0.93, mt: 0.03 });
  bodyBox(0.048, 0.025, 0.074, 0, 0.084, 0.316, COL.gunmetal);
  bodyBox(0.078, 0.205, 0.034, 0, -0.005, 0.382, COL.polymer,
    { rg: 0.93, mt: 0.03 });
  bodyBox(0.084, 0.208, 0.012, 0, -0.005, 0.405, COL.amber,
    { rg: 0.67, mt: 0.18 });
  bodyBox(0.056, 0.030, 0.045, 0, -0.102, 0.350, COL.gunmetal);
  cylZ(body, 0.010, 0.075, 0, -0.104, 0.305, COL.steel);

  // Vented free-floating handguard, with a continuous rail and inset M-LOK-style slots.
  bodyBox(0.118, 0.084, 0.330, 0, 0.020, -0.430, COL.cerakote);
  bodyBox(0.088, 0.026, 0.338, 0, -0.035, -0.430, COL.polyDark);
  bodyBox(0.102, 0.014, 0.345, 0, 0.088, -0.430, COL.gunmetal);
  bodyBox(0.094, 0.012, 0.315, 0, -0.045, -0.430, COL.gunmetal);
  for (let i = 0; i < 5; i++) {
    const z = -0.315 - i * 0.060;
    for (const side of [-1, 1]) {
      bodyBox(0.006, 0.026, 0.040, side * 0.061, 0.045, z,
        i === 2 ? COL.amber : COL.fluteDark,
        { rx: i % 2 ? 0.10 : -0.10 });
    }
  }
  for (let i = 0; i < 6; i++) {
    bodyBox(0.105, 0.012, 0.034, 0, 0.100, -0.220 - i * 0.061,
      i === 1 ? COL.amber : COL.polyDark);
  }
  bodyBox(0.126, 0.092, 0.024, 0, 0.020, -0.602, COL.gunmetal);

  // Full-length fluted barrel. The cylinder spans BREACH_Z -> T.muzzle exactly so the visual
  // tip and projectile/flash marker cannot drift apart.
  const barrelLength = Math.abs(T.muzzle[2] - BREACH_Z.sniper);
  const barrelCenterZ = (T.muzzle[2] + BREACH_Z.sniper) / 2;
  cylZ(body, 0.020, barrelLength, T.muzzle[0], barrelY, barrelCenterZ,
    COL.greenSteel, { seg: 14, rg: 0.47, mt: 0.70 });
  cylZ(body, 0.027, 0.075, 0, barrelY, -0.297, COL.gunmetal,
    { seg: 14, rg: 0.45, mt: 0.70 });
  for (let i = 0; i < 4; i++) {
    const angle = (45 + i * 90) * D2R;
    const radius = 0.0235;
    bodyBox(0.006, 0.006, 0.335, Math.cos(angle) * radius,
      barrelY + Math.sin(angle) * radius, -0.495, COL.fluteDark);
  }

  // Boxy three-port brake, entirely behind the exact muzzle plane.
  cylZ(body, 0.029, 0.086, 0, barrelY, T.muzzle[2] + 0.043, COL.brake,
    { seg: 12, rg: 0.42, mt: 0.72 });
  for (let i = 0; i < 3; i++) {
    const z = T.muzzle[2] + 0.017 + i * 0.025;
    bodyBox(0.073, 0.052, 0.015, 0, barrelY, z, COL.gunmetal,
      { rg: 0.42, mt: 0.72 });
    bodyBox(0.074, 0.019, 0.009, 0, barrelY, z, COL.polyDark);
  }
  cylZ(body, 0.023, 0.010, 0, barrelY, T.muzzle[2] + 0.005, COL.amber,
    { seg: 12, rg: 0.55, mt: 0.50 });

  const sight = new THREE.Group(); sight.name = "factory-optic"; body.add(sight);
  // Large 5x optic. Rings and feet are separate so the scope reads in both FPS and avatar views.
  body.userData.sightHeight = 0.205;
  for (const z of [-0.118, -0.330]) {
    kit.box(sight, 0.070, 0.074, 0.030, 0, 0.153, z, COL.polyDark);
    kit.box(sight, 0.092, 0.018, 0.054, 0, 0.111, z, COL.gunmetal);
    cylZ(sight, 0.036, 0.018, 0, 0.205, z, COL.gunmetal,
      { seg: 14, rg: 0.45, mt: 0.65 });
  }
  cylZ(sight, 0.029, 0.345, 0, 0.205, -0.215, COL.polyDark,
    { seg: 16, rg: 0.43, mt: 0.55 });
  cylZ(sight, 0.043, 0.090, 0, 0.205, 0.002, COL.polymer,
    { rTop: 0.046, rBot: 0.030, seg: 16, rg: 0.65, mt: 0.35 });
  cylZ(sight, 0.034, 0.103, 0, 0.205, -0.447, COL.polymer,
    { rTop: 0.031, rBot: 0.057, seg: 16, rg: 0.55, mt: 0.45 });
  cylZ(sight, 0.048, 0.014, 0, 0.205, 0.054, COL.amber,
    { seg: 16, rg: 0.52, mt: 0.48 });
  cylZ(sight, 0.059, 0.014, 0, 0.205, -0.505, COL.amber,
    { seg: 16, rg: 0.52, mt: 0.48 });
  cylZ(sight, 0.046, 0.018, 0, 0.205, 0.067, COL.polyDark, { seg: 16 });

  // Elevation and windage turrets with an amber index line.
  const elevation = new THREE.Mesh(
    new THREE.CylinderGeometry(0.022, 0.022, 0.050, 12),
    mat(COL.gunmetal, 0.45, 0.65),
  );
  elevation.position.set(0, 0.254, -0.237);
  sight.add(elevation);
  cylZ(sight, 0.021, 0.048, -0.047, 0.205, -0.237, COL.gunmetal,
    { seg: 12, rg: 0.45, mt: 0.65 });
  kit.box(sight, 0.022, 0.006, 0.042, 0, 0.282, -0.237, COL.amber);
  kit.box(sight, 0.006, 0.030, 0.034, -0.071, 0.205, -0.237, COL.amber);

  const glass = new THREE.Mesh(
    new THREE.CircleGeometry(0.052, 24),
    new THREE.MeshBasicMaterial({
      color: 0x88dfff,
      transparent: true,
      opacity: 0.16,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  glass.position.set(0, 0.205, -0.513);
  sight.add(glass);

  const reticleTexture = makeReticleTexture();
  const reticle = new THREE.Mesh(
    new THREE.PlaneGeometry(0.067, 0.067),
    reticleTexture
      ? new THREE.MeshBasicMaterial({
        map: reticleTexture,
        transparent: true,
        opacity: 0.82,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
      : new THREE.MeshBasicMaterial({
        color: 0x88ffcc,
        transparent: true,
        opacity: 0.22,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
  );
  reticle.position.set(0, 0.205, -0.512);
  sight.add(reticle);

  // Benchrest rail under the fore-end.
  bodyBox(0.070, 0.020, 0.200, 0, -0.055, -0.465, COL.polyDark);
  flushBodyBoxes();

  // Detachable box magazine, with its full detail on the animated mag group.
  box(mag, 0.062, 0.122, 0.078, 0, -0.092, -0.235, COL.cerakote,
    { rx: -0.08 });
  box(mag, 0.067, 0.020, 0.084, 0, -0.033, -0.235, COL.gunmetal);
  box(mag, 0.066, 0.018, 0.083, 0, -0.151, -0.226, COL.polyDark,
    { rx: -0.08 });
  for (const side of [-1, 1]) {
    box(mag, 0.005, 0.088, 0.050, side * 0.033, -0.095, -0.235,
      COL.polyDark, { rx: -0.08 });
  }

  // Stripper rounds stay in the extra group because reload choreography owns their visibility.
  for (let i = 0; i < 3; i++) {
    const cartridge = box(extra, 0.012, 0.012, 0.050, 0, 0.115 + i * 0.016,
      -0.235, COL.brass, { rg: 0.42, mt: 0.68 });
    cartridge.visible = false;
    extra.userData.cartridges.push(cartridge);
  }

  // Long-throw bolt body, swept handle, and knob all move with the existing bolt animation.
  cylZ(bolt, 0.014, 0.150, 0, 0.070, -0.075, COL.steel,
    { seg: 12, rg: 0.38, mt: 0.78 });
  const handleGeometry = new THREE.CylinderGeometry(0.008, 0.008, 0.095, 10);
  handleGeometry.rotateZ(Math.PI / 2);
  const handle = new THREE.Mesh(handleGeometry, mat(COL.steel, 0.38, 0.78));
  handle.position.set(-0.075, 0.105, BOLT_HOME.sniper);
  bolt.add(handle);
  box(bolt, 0.030, 0.030, 0.030, -0.128, 0.105, BOLT_HOME.sniper,
    COL.polymer, { rg: 0.75, mt: 0.18 });
  box(bolt, 0.012, 0.035, 0.012, -0.029, 0.088, BOLT_HOME.sniper,
    COL.amber);

  box(trigger, 0.008, 0.030, 0.008, 0, -0.020, TRIGGER_Z.sniper, COL.amber,
    { rx: -0.22 });
  box(trigger, 0.030, 0.006, 0.050, 0, -0.045, TRIGGER_Z.sniper, COL.polyDark);
}
