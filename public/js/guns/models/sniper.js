import * as THREE from '../../vendor/three.module.js';
import { COL, makeReticleTexture } from '../kit.js';
import { BOLT_HOME, BREACH_Z, D2R, TRIGGER_Z } from './common.js';

/** Build the sniper silhouette and its stripper-round reload parts. */
export function build({ kit, T, groups }) {
  const { box, cylZ, brakeRings, mat } = kit;
  const { body, mag, bolt, trigger, extra } = groups;

  box(body, 0.075, 0.105, 0.44, 0, 0.02, -0.18, COL.cerakote);
  box(body, 0.06, 0.03, 0.10, 0, 0.085, 0.02, COL.greenSteel);
  box(body, 0.05, 0.05, 0.10, 0, -0.03, -0.36, COL.cerakote);
  for (let i = 0; i < 10; i++) {
    box(body, 0.062, 0.010, 0.036, 0, 0.080, -0.02 - i * 0.045,
      i % 2 ? COL.polyDark : COL.greenSteel);
  }

  const barrelY = T.muzzle[1];
  const barrelLength = Math.abs(T.muzzle[2] - BREACH_Z.sniper);
  cylZ(body, 0.020, barrelLength, 0, barrelY,
    (T.muzzle[2] + BREACH_Z.sniper) / 2, COL.greenSteel);
  for (let i = 0; i < 4; i++) {
    const angle = (45 + i * 90) * D2R;
    const radius = 0.0235;
    box(body, 0.007, 0.007, 0.34, Math.cos(angle) * radius,
      barrelY + Math.sin(angle) * radius, -0.47, COL.fluteDark);
  }
  brakeRings(body, 0.028, 0, barrelY, T.muzzle[2], 2, 0.010, 0.016);
  cylZ(body, 0.023, 0.012, 0, barrelY, T.muzzle[2] + 0.006, COL.brake);

  // Scope rings, tube, objective bell, ocular, glass, and reticle are the optic silhouette cues.
  for (const z of [-0.245, -0.375]) {
    box(body, 0.014, 0.10, 0.022, 0, 0.132, z, COL.polyDark);
  }
  cylZ(body, 0.028, 0.26, 0, 0.205, -0.30, COL.polyDark);
  cylZ(body, 0.028, 0.07, 0, 0.205, -0.475, COL.polyDark,
    { rTop: 0.028, rBot: 0.044 });
  cylZ(body, 0.032, 0.05, 0, 0.205, -0.135, COL.polymer);

  const glass = new THREE.Mesh(
    new THREE.CircleGeometry(0.041, 16),
    new THREE.MeshBasicMaterial({
      color: 0x88ffcc,
      transparent: true,
      opacity: 0.12,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  glass.position.set(0, 0.205, -0.507);
  body.add(glass);

  const reticleTexture = makeReticleTexture();
  const reticle = new THREE.Mesh(
    new THREE.PlaneGeometry(0.052, 0.052),
    reticleTexture
      ? new THREE.MeshBasicMaterial({
        map: reticleTexture,
        transparent: true,
        opacity: 0.85,
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
  reticle.position.set(0, 0.205, -0.500);
  body.add(reticle);

  for (const side of [-1, 1]) {
    box(body, 0.010, 0.10, 0.016, side * 0.022, barrelY - 0.075, -0.40,
      COL.fluteDark, { rx: 1.35 });
  }
  box(mag, 0.04, 0.09, 0.075, 0, -0.075, -0.235, COL.cerakote);

  for (let i = 0; i < 3; i++) {
    const cartridge = box(extra, 0.012, 0.012, 0.05, 0, 0.115 + i * 0.016,
      -0.235, COL.brass);
    cartridge.visible = false;
    extra.userData.cartridges.push(cartridge);
  }

  const handleGeometry = new THREE.CylinderGeometry(0.008, 0.008, 0.095, 8);
  handleGeometry.rotateZ(Math.PI / 2);
  const handle = new THREE.Mesh(handleGeometry, mat(COL.steel));
  handle.position.set(-0.075, 0.105, BOLT_HOME.sniper);
  bolt.add(handle);
  box(bolt, 0.026, 0.026, 0.026, -0.128, 0.105, BOLT_HOME.sniper, COL.steel);
  box(trigger, 0.008, 0.03, 0.008, 0, -0.02, TRIGGER_Z.sniper, COL.amber);
  box(trigger, 0.03, 0.006, 0.05, 0, -0.045, TRIGGER_Z.sniper, COL.polyDark);
}
