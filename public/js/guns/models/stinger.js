import * as THREE from '../../vendor/three.module.js';
import { COL, GLOW_ACCENT } from '../kit.js';
import { BREACH_Z } from './common.js';

/**
 * AX-9 STINGER: the Conquest Engineer's shoulder-fired AA launcher. A long
 * olive launch tube with a frangible front cover, a gripstock under the tube,
 * the coolant/battery unit (BCU, the `mag` group the reload swaps) ahead of the
 * grip, a folding IFF antenna grid on the left and a ring sight on top. The
 * sight line sits at `SIGHT_Y`, which the ADS offset in defs.js centres.
 */
export const STINGER_SIGHT_Y = 0.178;
const TUBE_R = 0.05;
const TUBE_REAR = 0.36;
const YELLOW = 0xd8b23a;
const COVER = 0x2c3a46;

export function build({ kit, T, groups }) {
  const { body, mag, bolt, trigger, extra } = groups;
  const { box, cylZ, mat } = kit;
  const axisY = T.muzzle[1];
  const muzzleZ = T.muzzle[2];
  const accent = GLOW_ACCENT.stinger;

  // Launch tube: rear cap to the front cover, which ends exactly at the muzzle.
  const tubeFront = muzzleZ + 0.04;
  const tubeLength = TUBE_REAR - tubeFront;
  cylZ(body, TUBE_R, tubeLength, 0, axisY, TUBE_REAR - tubeLength / 2, COL.olive, { seg: 12, rg: 0.82, mt: 0.12 });
  // Exposed "barrel" span the heat sleeve maps onto: breech ring to the front cover.
  cylZ(body, TUBE_R + 0.004, 0.03, 0, axisY, BREACH_Z.stinger, COL.polyDark, { seg: 12 });
  cylZ(body, TUBE_R + 0.008, 0.04, 0, axisY, muzzleZ + 0.02, COVER, { seg: 12, rg: 0.5, mt: 0.3 });
  // Front cover disc: flush with the muzzle so the barrel geometry touches T.muzzle.
  cylZ(body, TUBE_R - 0.004, 0.004, 0, axisY, muzzleZ + 0.002, 0x18222b, { seg: 12, rg: 0.35, mt: 0.2 });
  // Rear cap and the end ring.
  cylZ(body, TUBE_R + 0.007, 0.05, 0, axisY, TUBE_REAR - 0.025, COL.polyDark, { seg: 12 });
  // Warhead/flight-motor markings: a yellow band and a brown band near the front.
  cylZ(body, TUBE_R + 0.002, 0.03, 0, axisY, muzzleZ + 0.12, YELLOW, { seg: 12 });
  cylZ(body, TUBE_R + 0.002, 0.018, 0, axisY, muzzleZ + 0.16, 0x6b4a2a, { seg: 12 });
  // Carry-strap lugs and two tube clamps that hold the gripstock.
  for (const z of [-0.26, 0.04]) cylZ(body, TUBE_R + 0.006, 0.024, 0, axisY, z, COL.parkerized, { seg: 12 });
  box(body, 0.014, 0.02, 0.03, TUBE_R + 0.008, axisY + 0.01, 0.22, COL.steel);

  // Gripstock: a rail under the tube from the BCU well to the shoulder pad.
  box(body, 0.05, 0.03, 0.42, 0, axisY - TUBE_R - 0.012, -0.11, COL.polyDark);
  box(body, 0.06, 0.05, 0.11, 0, axisY - TUBE_R - 0.02, 0.27, COL.polymer); // shoulder pad
  // Pistol grip and trigger guard (the dominant hand wraps the grip).
  box(body, 0.034, 0.105, 0.048, 0.006, -0.035, -0.07, COL.polymer, { rx: 0.18 });
  box(body, 0.03, 0.008, 0.07, 0.006, -0.002, -0.115, COL.polyDark);
  const lever = box(trigger, 0.008, 0.026, 0.01, 0.006, 0.006, T.triggerZ ?? -0.11, COL.steel);
  lever.name = 'stinger_trigger';
  // Uncage / safety switch on the right of the grip housing.
  box(body, 0.012, 0.014, 0.014, 0.035, 0.012, -0.07, accent, { mat: mat(accent, 0.4, 0.1) });
  // Forward handle the support hand cups, under the front tube clamp.
  box(body, 0.03, 0.07, 0.035, -0.004, axisY - TUBE_R - 0.05, -0.36, COL.polymer);

  // BCU: the coolant/battery bottle seated in its well ahead of the grip; the
  // magazine timeline lowers it out and slides a fresh one in on reload.
  const bcu = new THREE.Mesh(new THREE.CylinderGeometry(0.019, 0.019, 0.11, 10), mat(0x3a4148, 0.55, 0.45));
  bcu.position.set(0, axisY - TUBE_R - 0.085, -0.2);
  mag.add(bcu);
  const bcuCap = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.016, 10), mat(YELLOW, 0.6, 0.2));
  bcuCap.position.set(0, axisY - TUBE_R - 0.146, -0.2);
  mag.add(bcuCap);

  // Seeker arming switch: the "bolt" slot nudges back on launch.
  box(bolt, 0.022, 0.02, 0.03, 0.03, axisY + TUBE_R - 0.004, -0.02, COL.gunmetal);

  // Folding IFF antenna grid, deployed on the left of the tube.
  const grid = new THREE.Group();
  grid.name = 'stinger_iff_grid';
  grid.position.set(-TUBE_R - 0.05, axisY + 0.02, -0.3);
  box(grid, 0.008, 0.012, 0.012, 0.045, -0.02, 0, COL.steel); // hinge arm to the tube clamp
  const frameColor = COL.gunmetal;
  box(grid, 0.006, 0.17, 0.006, 0, 0.05, -0.07, frameColor);
  box(grid, 0.006, 0.17, 0.006, 0, 0.05, 0.07, frameColor);
  box(grid, 0.006, 0.006, 0.146, 0, 0.135, 0, frameColor);
  box(grid, 0.006, 0.006, 0.146, 0, -0.035, 0, frameColor);
  for (let i = 1; i < 4; i++) box(grid, 0.004, 0.004, 0.14, 0, -0.035 + i * 0.0425, 0, COL.steel);
  for (let i = 1; i < 3; i++) box(grid, 0.004, 0.166, 0.004, 0, 0.05, -0.07 + i * 0.0467, COL.steel);
  body.add(grid);

  // Ring sight on top: rear aperture and the front range ring on one sight line.
  body.userData.sightHeight = STINGER_SIGHT_Y;
  const sights = new THREE.Group();
  sights.name = 'factory-optic';
  body.add(sights);
  // Posts run from the tube top up to each sight's rim, never across the sight line.
  const tubeTop = axisY + TUBE_R;
  const post = (width, depth, top, z) => box(sights, width, top - tubeTop, depth, 0, (top + tubeTop) / 2, z, COL.polyDark);
  post(0.016, 0.012, STINGER_SIGHT_Y - 0.012, -0.02);
  const aperture = new THREE.Mesh(new THREE.TorusGeometry(0.009, 0.004, 4, 10), mat(COL.polyDark));
  aperture.position.set(0, STINGER_SIGHT_Y, -0.02);
  sights.add(aperture);
  post(0.012, 0.01, STINGER_SIGHT_Y - 0.034, -0.42);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.032, 0.0035, 4, 16), mat(COL.polyDark));
  ring.position.set(0, STINGER_SIGHT_Y, -0.42);
  sights.add(ring);
  // Seeker lamp on the ring's rim (off the sight line): lights in the seeker accent.
  box(sights, 0.008, 0.008, 0.006, 0.032, STINGER_SIGHT_Y, -0.42, accent, { mat: mat(accent, 0.3, 0.1) });

  extra.userData.stinger = { grid, sights };
  return true;
}
