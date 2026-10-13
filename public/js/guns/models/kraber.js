import * as THREE from '../../vendor/three.module.js';
import { COL, GLOW_ACCENT } from '../kit.js';
import { BOLT_HOME, BREACH_Z, TRIGGER_Z } from './common.js';

// KR-50 KRABER (Titanfall anti-materiel bolt rifle, docs/titanfall.md §6). A long
// chassis rifle: a squared steel receiver on a thumbhole stock with an adjustable cheek
// riser and a thick butt pad, a slab fore-end with a folded bipod under it, a fluted
// heavy barrel and a big double-baffle muzzle brake whose front face lands exactly on
// T.muzzle. The high scope sits on a rail; its tube and bells are open shells and the
// lenses are transparent, so the sight axis (0.21, SIGHT_HEIGHT.kraber) stays clear.
// The box magazine is the `mag`, the straight-pull bolt and its knob the `bolt`.
const SIGHT_Y = 0.21;
const AMBER = GLOW_ACCENT.kraber;
const BARREL_R = 0.020;

// Titanfall on-gun ammo counter seat (weapon-display.js): screen centre on the top rear of the receiver, facing back
// toward the eye (Halo-style rear deck counter), size in m; `seat` names the surface it stands on.
export const DISPLAY_MOUNT = Object.freeze({ x: 0.000, y: 0.155, z: 0.110, w: 0.045, h: 0.035, seat: 'deck' });

export function build({ kit, T, groups }) {
  groups.body.userData.displayMount = DISPLAY_MOUNT;
  const { box, cylZ, mat } = kit;
  const { body, mag, bolt, trigger, extra } = groups;
  const [mx, axisY, mz] = T.muzzle;
  const breachZ = BREACH_Z.kraber;
  const glow = mat(AMBER, 0.35, 0.15);

  // Receiver: squared steel action with a scope rail on top and ejection port right.
  box(body, 0.092, 0.084, 0.36, 0, axisY + 0.012, -0.12, COL.steel, { rg: 0.45, mt: 0.65 });
  box(body, 0.060, 0.012, 0.36, 0, axisY + 0.060, -0.12, COL.polyDark);
  for (let i = 0; i < 9; i++) box(body, 0.064, 0.008, 0.016, 0, axisY + 0.069, 0.035 - i * 0.04, COL.gunmetal);
  box(body, 0.004, 0.030, 0.090, 0.047, axisY + 0.026, -0.10, COL.polymer);
  box(body, 0.080, 0.030, 0.30, 0, axisY - 0.040, -0.13, COL.olive, { rg: 0.8, mt: 0.15 });

  // Thumbhole stock: upper comb to the butt, a lower strut closing the thumbhole,
  // an adjustable cheek riser on two posts and a thick butt pad with an amber spacer.
  box(body, 0.058, 0.060, 0.28, 0, axisY + 0.000, 0.19, COL.olive, { rg: 0.8, mt: 0.15 });
  box(body, 0.052, 0.034, 0.36, 0, axisY - 0.130, 0.12, COL.olive, { rg: 0.8, mt: 0.15, rx: 0.04 });
  box(body, 0.054, 0.150, 0.050, 0, axisY - 0.060, 0.315, COL.olive, { rg: 0.8, mt: 0.15 });
  box(body, 0.060, 0.170, 0.034, 0, axisY - 0.062, 0.357, COL.polymer);
  box(body, 0.062, 0.160, 0.008, 0, axisY - 0.062, 0.336, AMBER, { mat: glow });
  for (const z of [0.12, 0.24]) box(body, 0.012, 0.03, 0.012, 0, axisY + 0.044, z, COL.steel);
  box(body, 0.050, 0.022, 0.18, 0, axisY + 0.068, 0.18, COL.polyDark);

  // Pistol grip (raked) joining the lower strut, with amber cap.
  box(body, 0.040, 0.120, 0.050, 0, axisY - 0.110, -0.090, COL.polymer, { rx: -0.32 });
  box(body, 0.044, 0.012, 0.054, 0, axisY - 0.172, -0.070, AMBER, { mat: glow, rx: -0.32 });

  // Fore-end: a long slab with lightening slots and an amber stripe; folded bipod under.
  box(body, 0.072, 0.070, 0.34, 0, axisY - 0.004, -0.47, COL.olive, { rg: 0.8, mt: 0.15 });
  box(body, 0.074, 0.010, 0.34, 0, axisY + 0.032, -0.47, COL.polyDark);
  for (const side of [-1, 1]) {
    for (let i = 0; i < 4; i++) box(body, 0.004, 0.022, 0.05, side * 0.0365, axisY, -0.36 - i * 0.07, COL.polyDark);
    box(body, 0.004, 0.006, 0.30, side * 0.0365, axisY - 0.026, -0.47, AMBER, { mat: glow });
    // Bipod leg folded flat along the fore-end belly, foot forward.
    box(body, 0.012, 0.012, 0.24, side * 0.022, axisY - 0.048, -0.56, COL.gunmetal);
    box(body, 0.020, 0.010, 0.026, side * 0.022, axisY - 0.050, -0.68, COL.polymer);
  }
  box(body, 0.060, 0.020, 0.030, 0, axisY - 0.046, -0.43, COL.steel);

  // Fluted heavy barrel from the breech to the brake.
  const brakeLen = 0.10;
  const barrelLength = Math.abs((mz + brakeLen) - breachZ);
  const barrelMid = (breachZ + mz + brakeLen) / 2;
  cylZ(body, BARREL_R, barrelLength + 0.01, mx, axisY, barrelMid - 0.005, COL.blued, { seg: 14, rg: 0.4, mt: 0.75 });
  for (let i = 0; i < 6; i++) {
    const a = i * Math.PI / 3;
    box(body, 0.004, 0.004, 0.24, mx + Math.cos(a) * (BARREL_R - 0.0015), axisY + Math.sin(a) * (BARREL_R - 0.0015), -0.72,
      COL.fluteDark, { rz: a });
  }

  // Double-baffle brake: a block with two pairs of side ports; its face is the muzzle.
  box(body, 0.064, 0.048, brakeLen, mx, axisY, mz + brakeLen / 2, COL.brake, { rg: 0.45, mt: 0.7 });
  for (const side of [-1, 1]) for (const dz of [0.025, 0.065]) {
    box(body, 0.006, 0.034, 0.022, mx + side * 0.032, axisY, mz + dz, 0x0d0f12, { rg: 0.9, mt: 0.1 });
  }
  box(body, 0.068, 0.006, brakeLen - 0.02, mx, axisY + 0.026, mz + brakeLen / 2, COL.gunmetal);
  box(body, 0.054, 0.040, 0.008, mx, axisY, mz + brakeLen + 0.004, COL.gunmetal);

  // Scope: rail rings, an open main tube with bells, turrets and transparent lenses.
  const sights = new THREE.Group();
  sights.name = 'factory-optic';
  body.add(sights);
  body.userData.sightHeight = SIGHT_Y;
  const tubeR = 0.024, scopeRear = 0.07, scopeFront = -0.30;
  const railTop = axisY + 0.073;
  for (const z of [-0.02, -0.12]) {
    box(sights, 0.030, SIGHT_Y - tubeR - railTop, 0.022, 0, (SIGHT_Y - tubeR + railTop) / 2, z, COL.polyDark);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(tubeR + 0.004, 0.005, 6, 18), mat(COL.polyDark));
    ring.position.set(0, SIGHT_Y, z);
    sights.add(ring);
  }
  cylZ(sights, tubeR, 0.16, 0, SIGHT_Y, -0.06, COL.polymer, { seg: 18, open: true });
  cylZ(sights, tubeR, 0.09, 0, SIGHT_Y, -0.185, COL.polymer, { seg: 18, open: true, rTop: tubeR, rBot: 0.036 });
  cylZ(sights, 0.036, 0.07, 0, SIGHT_Y, scopeFront + 0.035, COL.polymer, { seg: 18, open: true });
  cylZ(sights, 0.038, 0.012, 0, SIGHT_Y, scopeFront + 0.006, AMBER, { seg: 18, open: true });
  cylZ(sights, 0.030, 0.06, 0, SIGHT_Y, scopeRear - 0.03, COL.polymer, { seg: 18, open: true, rTop: 0.030, rBot: tubeR });
  // Turrets: elevation on top, windage right, parallax left.
  const turret = (x, y, rotZ) => {
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.026, 12), mat(COL.gunmetal, 0.5, 0.6));
    cap.position.set(x, y, -0.10);
    cap.rotation.z = rotZ;
    sights.add(cap);
  };
  turret(0, SIGHT_Y + tubeR + 0.012, 0);
  turret(tubeR + 0.012, SIGHT_Y, Math.PI / 2);
  turret(-tubeR - 0.012, SIGHT_Y, Math.PI / 2);
  box(sights, 0.006, 0.004, 0.006, 0, SIGHT_Y + tubeR + 0.026, -0.10, AMBER, { mat: glow });
  const lensMaterial = (color, opacity) => new THREE.MeshStandardMaterial({
    color, transparent: true, opacity, roughness: 0.05, metalness: 0.4, depthWrite: false, side: THREE.DoubleSide,
  });
  const objective = new THREE.Mesh(new THREE.CircleGeometry(0.034, 18), lensMaterial(0x4a2e10, 0.55));
  objective.position.set(0, SIGHT_Y, scopeFront + 0.004);
  sights.add(objective);
  const ocular = new THREE.Mesh(new THREE.CircleGeometry(0.028, 18), lensMaterial(0x0f1a22, 0.45));
  ocular.position.set(0, SIGHT_Y, scopeRear);
  sights.add(ocular);

  // Box magazine ahead of the trigger guard.
  box(mag, 0.046, 0.100, 0.070, 0, axisY - 0.100, -0.245, COL.gunmetal, { rg: 0.5, mt: 0.55, rx: 0.06 });
  box(mag, 0.050, 0.014, 0.074, 0, axisY - 0.152, -0.242, COL.polymer, { rx: 0.06 });
  box(mag, 0.004, 0.050, 0.030, 0.024, axisY - 0.095, -0.245, AMBER, { mat: glow });

  // Bolt: body in the action, handle arm out to the right with a fat knob.
  cylZ(bolt, 0.016, 0.14, 0.0, axisY + 0.018, BOLT_HOME.kraber + 0.03, COL.steel, { seg: 10, rg: 0.35, mt: 0.8 });
  box(bolt, 0.064, 0.012, 0.014, 0.060, axisY + 0.018, BOLT_HOME.kraber + 0.06, COL.steel, { rz: -0.35 });
  const knob = new THREE.Mesh(new THREE.SphereGeometry(0.016, 12, 10), mat(COL.polymer, 0.6, 0.2));
  knob.position.set(0.094, axisY + 0.004, BOLT_HOME.kraber + 0.06);
  bolt.add(knob);

  // Trigger and guard ahead of the grip.
  box(trigger, 0.008, 0.032, 0.008, 0, axisY - 0.072, TRIGGER_Z.kraber, COL.steel, { rx: -0.2 });
  box(trigger, 0.034, 0.007, 0.075, 0, axisY - 0.100, TRIGGER_Z.kraber - 0.008, COL.polyDark);
  box(trigger, 0.034, 0.046, 0.007, 0, axisY - 0.078, TRIGGER_Z.kraber - 0.045, COL.polyDark);

  extra.userData.kraber = { scope: sights };
  return true;
}
