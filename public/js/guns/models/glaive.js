import * as THREE from '../../vendor/three.module.js';
import { COL, GLOW_ACCENT } from '../kit.js';
import { BOLT_HOME, BREACH_Z, D2R, TRIGGER_Z } from './common.js';
import { buildSkua } from './skua.js';

// GV-4 RIPTIDE: forearm-braced disc launcher. A toothed magenta disc rides the launch
// spindle between two catch horns; the flywheel in the drum behind it flings the disc
// out and the horns clamp it when it comes home. The SKUA Blender asset owns the real
// forms; this procedural fallback keeps the Node contracts (muzzle, heat band, ADS
// centre ray, hitbox sight height) running on the same anchors: spindle tip exactly on
// T.muzzle, sight line 0.150, disc centre (0, 0, -0.22) tilted 6 degrees front-up.
const SIGHT_HEIGHT = 0.150;
const SIGHT_Z = -0.34;
const DISC_R = 0.11;
const DISC_T = 0.024;
const DISC_TILT = 6 * D2R;
const DISC_CENTER = new THREE.Vector3(0, 0, -0.22);
const HORN_HINGE_X = 0.05;
const HORN_HINGE_Z = -0.33;
const HORN_TIP = [0.10, -0.46];
const HORN_Y = 0.03;
const SPARE_HOME = new THREE.Vector3(0, -0.078, -0.15);
const IVORY = 0xd9d2bf;
const ORANGE = 0xe8661e;

/** Per-rig emissive material the presentation dims and brightens; flagged by role. */
export function glaiveGlowMaterial(role, intensity = 1) {
  const material = new THREE.MeshStandardMaterial({
    color: 0x3a0a2e, emissive: GLOW_ACCENT.glaive, emissiveIntensity: intensity,
    roughness: 0.4, metalness: 0.2, flatShading: true,
  });
  material.userData.glaiveGlow = role;
  material.userData.baseEmissive = intensity;
  return material;
}

/** One toothed disc: steel body, spoke cut-outs, 24 polished teeth, glow rim, hub. */
function discMesh(kit, parent, glow) {
  const { box, mat } = kit;
  const body = new THREE.Mesh(new THREE.CylinderGeometry(DISC_R - 0.006, DISC_R - 0.006, DISC_T, 24),
    mat(0x8d949c, 0.35, 0.8));
  parent.add(body);
  for (let i = 0; i < 3; i++) {
    const a = i * Math.PI * 2 / 3;
    box(parent, 0.034, DISC_T + 0.002, 0.050, Math.sin(a) * 0.055, 0, Math.cos(a) * 0.055, COL.polymer,
      { ry: a });
  }
  for (let i = 0; i < 24; i++) {
    const a = i * Math.PI * 2 / 24;
    box(parent, 0.016, DISC_T * 0.55, 0.012, Math.sin(a) * (DISC_R - 0.002), 0, Math.cos(a) * (DISC_R - 0.002),
      0xc7ccd2, { ry: a + 0.35, rg: 0.25, mt: 0.9 });
  }
  const rim = new THREE.Mesh(new THREE.TorusGeometry(DISC_R - 0.014, 0.003, 4, 32), glow);
  rim.rotation.x = Math.PI / 2;
  rim.position.y = DISC_T / 2;
  parent.add(rim);
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.020, 0.020, DISC_T + 0.006, 12), mat(COL.gunmetal, 0.5, 0.7));
  parent.add(hub);
}

export function build({ kit, T, groups }) {
  if (buildSkua({ kit, T, groups })) return;
  const { box, cylZ, mat } = kit;
  const { body, mag, bolt, trigger, extra } = groups;
  const muzzleZ = T.muzzle[2];
  const breachZ = BREACH_Z.glaive;
  const discGlow = glaiveGlowMaterial('disc');
  const hornGlow = glaiveGlowMaterial('horn', 0.6);
  const stripGlow = glaiveGlowMaterial('strip', 0.1);

  // Brace cuff: half-ring strap segments behind the grip with a brass buckle.
  for (let i = 0; i < 5; i++) {
    const a = -Math.PI / 2 + i * Math.PI / 4;
    box(body, 0.022, 0.030, 0.050, Math.cos(a) * 0.050, -0.030 + Math.sin(a) * 0.020, 0.135, COL.polyDark,
      { rz: a });
  }
  box(body, 0.024, 0.018, 0.020, 0.052, -0.030, 0.150, COL.brass, { rg: 0.42, mt: 0.7 });

  // Low ivory receiver slab ending at the spindle breech.
  const slabLength = 0.12 - breachZ;
  box(body, 0.070, 0.070, slabLength, 0, -0.005, 0.12 - slabLength / 2, IVORY, { rg: 0.6, mt: 0.1 });
  box(body, 0.074, 0.010, slabLength - 0.02, 0, 0.032, 0.12 - slabLength / 2, COL.polyDark);

  // Flywheel housing: open drum on the bore axis (the wheel spins inside), cooling fins,
  // a brass fab gauge on the left face and the rear notch post up to the sight line.
  cylZ(body, 0.056, 0.10, 0, 0, 0.07, COL.gunmetal, { seg: 14, open: true });
  for (let i = 0; i < 8; i++) {
    const a = i * Math.PI / 4;
    box(body, 0.006, 0.014, 0.090, Math.cos(a) * 0.062, Math.sin(a) * 0.062, 0.07, COL.steel, { rz: a });
  }
  const gauge = new THREE.Group();
  gauge.name = 'glaive_fab_gauge';
  gauge.position.set(-0.068, 0.012, 0.07);
  body.add(gauge);
  const face = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.008, 12), mat(COL.brass, 0.42, 0.7));
  face.rotation.z = Math.PI / 2;
  gauge.add(face);
  const needle = new THREE.Group();
  needle.name = 'glaive_fab_needle';
  needle.position.x = -0.006;
  gauge.add(needle);
  box(needle, 0.002, 0.018, 0.003, 0, 0.008, 0, COL.shellRed);
  const post = 0.056;
  box(body, 0.014, 0.118 - post, 0.016, 0, (post + 0.118) / 2, 0.07, COL.gunmetal);
  box(body, 0.040, 0.008, 0.018, 0, 0.118, 0.07, COL.polyDark);
  for (const side of [-1, 1]) box(body, 0.012, 0.032, 0.018, side * 0.014, SIGHT_HEIGHT - 0.016, 0.07, COL.polyDark);

  // Launch spindle breech -> tip; the chamfer face lands exactly on T.muzzle.
  const chamfer = 0.015;
  const rodLength = Math.abs(muzzleZ - breachZ) - chamfer;
  cylZ(body, 0.0155, rodLength, 0, 0, breachZ - rodLength / 2, COL.gunmetal, { seg: 12, rg: 0.4, mt: 0.75 });
  cylZ(body, 0.0155, chamfer, 0, 0, muzzleZ + chamfer / 2, COL.steel, { seg: 12, rTop: 0.0155, rBot: 0.009 });

  // Rail under the disc plane with two polished guide lips.
  box(body, 0.050, 0.008, 0.26, 0, -0.034, -0.23, COL.gunmetal, { rg: 0.45, mt: 0.7 });
  for (const side of [-1, 1]) box(body, 0.006, 0.010, 0.20, side * 0.030, -0.026, -0.23, 0xc7ccd2, { rg: 0.25, mt: 0.9 });

  // Fork arms above the disc, orange bridge at z -0.33, ring sight on a post, and the
  // support-hand stub under the rail.
  for (const side of [-1, 1]) {
    box(body, 0.016, 0.016, 0.26, side * 0.085, 0.042, -0.21, ORANGE);
    box(body, 0.016, 0.040, 0.016, side * 0.085, 0.022, -0.09, ORANGE);
  }
  box(body, 0.186, 0.020, 0.030, 0, 0.045, HORN_HINGE_Z, ORANGE);
  const ringR = 0.016;
  const ring = new THREE.Mesh(new THREE.TorusGeometry(ringR, 0.0035, 6, 20), mat(ORANGE));
  ring.name = 'glaive_ring_sight';
  ring.position.set(0, SIGHT_HEIGHT, SIGHT_Z);
  body.add(ring);
  const postTop = SIGHT_HEIGHT - ringR - 0.0035;
  box(body, 0.006, postTop - 0.055, 0.006, 0, (postTop + 0.055) / 2, SIGHT_Z, ORANGE);
  box(body, 0.040, 0.050, 0.050, 0, -0.063, -0.30, COL.polyDark);
  box(body, 0.012, 0.030, 0.140, 0, -0.050, -0.20, COL.polyDark);

  // Vertical pistol grip with rib wrap, and the trigger blade at its zero.
  box(body, 0.042, 0.105, 0.050, 0, -0.092, 0.04, COL.polyDark, { rx: -0.08 });
  for (let i = 0; i < 4; i++) box(body, 0.046, 0.006, 0.052, 0, -0.060 - i * 0.022, 0.04, COL.polymer, { rx: -0.08 });
  box(body, 0.040, 0.006, 0.060, 0, -0.045, 0.010, COL.polyDark);
  box(trigger, 0.008, 0.028, 0.008, 0, -0.030, TRIGGER_Z.glaive, ORANGE, { rx: -0.2 });

  // Skeletal cassette under the receiver with its fabricate progress strip.
  box(body, 0.012, 0.030, 0.23, -0.10, -0.078, -0.15, COL.polyDark);
  box(body, 0.012, 0.030, 0.23, 0.10, -0.078, -0.15, COL.polyDark);
  box(body, 0.20, 0.010, 0.012, 0, -0.096, -0.04, COL.polyDark);
  box(body, 0.20, 0.010, 0.012, 0, -0.096, -0.26, COL.polyDark);
  box(body, 0.004, 0.008, 0.18, -0.107, -0.078, -0.15, 0, { mat: stripGlow });

  // Seated disc (mag): pivot at the disc centre, tilted front-up, spinner inside.
  const disc = new THREE.Group();
  disc.name = 'glaive_disc';
  disc.position.copy(DISC_CENTER);
  disc.rotation.x = DISC_TILT;
  const discSpin = new THREE.Group();
  discSpin.name = 'glaive_disc_spin';
  disc.add(discSpin);
  discMesh(kit, discSpin, discGlow);
  mag.add(disc);

  // Flywheel drive wheel (bolt) inside the open drum, spinning about the bore axis.
  const flywheel = new THREE.Group();
  flywheel.name = 'glaive_flywheel';
  flywheel.position.set(0, 0, BOLT_HOME.glaive);
  cylZ(flywheel, 0.047, 0.028, 0, 0, 0, COL.steel, { seg: 16, rg: 0.35, mt: 0.85 });
  for (let i = 0; i < 6; i++) {
    const a = i * Math.PI / 3;
    box(flywheel, 0.010, 0.040, 0.034, Math.cos(a) * 0.028, Math.sin(a) * 0.028, 0, COL.brass, { rz: a + Math.PI / 2 });
  }
  bolt.add(flywheel);

  // Catch horns (extra): hinge-local leaves sweeping to the tips, glow prong at each tip.
  const horns = [];
  for (const side of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.name = side < 0 ? 'glaive_horn_left' : 'glaive_horn_right';
    pivot.position.set(side * HORN_HINGE_X, HORN_Y, HORN_HINGE_Z);
    const dx = side * (HORN_TIP[0] - HORN_HINGE_X);
    const dz = HORN_TIP[1] - HORN_HINGE_Z;
    const length = Math.hypot(dx, dz);
    box(pivot, 0.014, 0.022, length, dx / 2, 0, dz / 2, ORANGE, { ry: Math.atan2(dx, dz) });
    box(pivot, 0.012, 0.012, 0.024, dx, 0, dz, 0, { mat: hornGlow });
    extra.add(pivot);
    horns.push({ pivot, side });
  }

  // Spare disc in the cassette: the extra round the cassette lift slides onto the spindle.
  const spare = new THREE.Group();
  spare.name = 'glaive_spare_disc';
  spare.position.copy(SPARE_HOME);
  discMesh(kit, spare, discGlow);
  spare.userData.homePosition = spare.position.clone();
  extra.add(spare);
  extra.userData.reloadRounds = spare;

  extra.userData.glaive = {
    disc, discSpin, flywheel, horns, spare, needle,
    seat: DISC_CENTER.clone(), tilt: DISC_TILT,
    glow: [discGlow], hornGlow: [hornGlow], strip: [stripGlow],
  };
  body.userData.sightHeight = SIGHT_HEIGHT;
}
