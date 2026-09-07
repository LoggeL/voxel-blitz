import { COL, GLOW_ACCENT } from '../kit.js';
import { BOLT_HOME, BREACH_Z, TRIGGER_Z } from './common.js';

// RX-8 HAVOC: shoulder-fired rocket launcher. One fat launch tube with a rear venturi,
// a pistol grip and a forward handle under the tube, flip-up ladder sights on a top rail,
// and a side-mounted arming lever (bolt group) that drops after each launch. The reload
// opens the rear breech and inserts a fresh rocket along the tube axis. The tube is built from
// BREACH_Z.rocket to T.muzzle so the tube mouth lands exactly on T.muzzle; the sight line
// (0.175) matches the ADS offset.
export function build({ kit, T, groups }) {
  const { box, cylZ, ironSights } = kit;
  const { body, bolt, trigger, extra } = groups;
  const mag = body; // The underslung control canister stays fixed during a rocket reload.
  const ORANGE = GLOW_ACCENT.rocket;

  const muzzleX = T.muzzle[0];
  const muzzleY = T.muzzle[1];
  const muzzleZ = T.muzzle[2];
  const breachZ = BREACH_Z.rocket;
  const tubeLength = Math.abs(muzzleZ - breachZ);
  const tubeMid = (muzzleZ + breachZ) / 2;
  const TUBE_R = 0.061;

  // Launch tube: olive composite over a gunmetal liner, breech -> muzzle exactly.
  cylZ(body, TUBE_R, tubeLength, muzzleX, muzzleY, tubeMid, COL.olive, { seg: 14, rg: 0.82, mt: 0.18 });
  cylZ(body, TUBE_R - 0.004, 0.02, muzzleX, muzzleY, muzzleZ + 0.010, COL.brake, { seg: 14, rg: 0.5, mt: 0.6 });
  cylZ(body, TUBE_R + 0.006, 0.024, muzzleX, muzzleY, muzzleZ + 0.022, COL.gunmetal, { seg: 14, rg: 0.5, mt: 0.6 });
  // Reinforcing bands along the tube, one hazard-orange.
  for (let i = 0; i < 4; i++) {
    const z = breachZ - tubeLength * (0.18 + i * 0.2);
    cylZ(body, TUBE_R + 0.005, 0.018, muzzleX, muzzleY, z, i === 1 ? ORANGE : COL.parkerized, { seg: 14, rg: 0.6, mt: 0.4 });
  }
  // Rear breech block and venturi (back-blast cone) behind the shooter's shoulder.
  cylZ(body, TUBE_R + 0.01, 0.16, muzzleX, muzzleY, breachZ + 0.08, COL.gunmetal, { seg: 14, rg: 0.55, mt: 0.55 });
  const gate = new THREE.Group();
  gate.name = 'rocket_rear_breech';
  gate.position.set(muzzleX, muzzleY, breachZ + 0.16);
  extra.add(gate);
  cylZ(gate, TUBE_R + 0.004, 0.2, 0, 0, 0.10, COL.brake, {
    seg: 14, rg: 0.5, mt: 0.6, rTop: TUBE_R - 0.012, rBot: TUBE_R + 0.03,
  });
  cylZ(gate, TUBE_R + 0.034, 0.014, 0, 0, 0.20, COL.steel, { seg: 14, rg: 0.5, mt: 0.6 });
  extra.userData.reloadPart = gate;
  extra.userData.rocketReload = { gate, axisY: muzzleY, rearZ: breachZ + 0.16 };
  const reloadRound = new THREE.Group();
  reloadRound.name = 'rocket_reload_round';
  cylZ(reloadRound, 0.039, 0.28, 0, 0, 0, COL.olive, { seg: 10 });
  cylZ(reloadRound, 0.046, 0.11, 0, 0, -0.19, ORANGE, { seg: 10, rTop: 0.005, rBot: 0.046 });
  cylZ(reloadRound, 0.042, 0.02, 0, 0, 0.14, COL.steel, { seg: 10 });
  for (const side of [-1, 1]) {
    box(reloadRound, 0.017, 0.074, 0.065, side * 0.038, 0, 0.11, COL.gunmetal);
    box(reloadRound, 0.074, 0.017, 0.065, 0, side * 0.038, 0.11, COL.gunmetal);
  }
  reloadRound.visible = false;
  reloadRound.userData.homePosition = reloadRound.position.clone();
  extra.add(reloadRound);
  extra.userData.reloadRounds = reloadRound;
  // Shoulder rest hanging under the breech.
  box(body, 0.06, 0.05, 0.12, 0, -0.005, breachZ + 0.14, COL.polymer, { rx: 0.1 });
  box(body, 0.07, 0.014, 0.13, 0, -0.03, breachZ + 0.14, COL.polyDark, { rx: 0.1 });

  // Under-tube spine, pistol grip and forward carry handle.
  box(body, 0.05, 0.028, 0.58, 0, 0.012, -0.40, COL.polyDark);
  box(body, 0.06, 0.09, 0.05, 0, -0.045, -0.06, COL.polymer, { rx: -0.28 });
  box(body, 0.062, 0.08, 0.054, 0, -0.11, -0.04, COL.polyDark, { rx: -0.22 });
  box(body, 0.064, 0.018, 0.06, 0, -0.156, -0.026, ORANGE, { rx: -0.18 });
  [-0.07, -0.098, -0.126].forEach((y, i) => {
    box(body, 0.004, 0.008, 0.036, 0.033, y, -0.05 + i * 0.008, COL.steel, { rx: -0.22 });
    box(body, 0.004, 0.008, 0.036, -0.033, y, -0.05 + i * 0.008, COL.steel, { rx: -0.22 });
  });
  box(body, 0.046, 0.075, 0.05, 0, -0.045, -0.40, COL.polymer, { rx: 0.12 });
  box(body, 0.05, 0.02, 0.056, 0, -0.088, -0.394, COL.polyDark, { rx: 0.12 });
  box(body, 0.052, 0.008, 0.058, 0, -0.1, -0.39, ORANGE, { rx: 0.12 });

  // Top rail, flip-up ladder sights around the shared sight line, and a housing frame.
  for (let i = 0; i < 8; i++) {
    const z = -0.06 - i * 0.07;
    box(body, 0.05, 0.01, 0.04, 0, muzzleY + TUBE_R + 0.006, z, i % 3 === 1 ? COL.steel : COL.polyDark);
  }
  ironSights(body, {
    rearZ: -0.02,
    frontZ: -0.66,
    height: 0.175,
    width: 0.04,
    gap: 0.016,
    color: COL.polyDark,
    accent: ORANGE,
  });
  // Riser posts tie both sight bars down to the rail so nothing floats in profile.
  box(body, 0.03, 0.02, 0.026, 0, muzzleY + TUBE_R + 0.02, -0.02, COL.polyDark);
  box(body, 0.024, 0.02, 0.02, 0, muzzleY + TUBE_R + 0.02, -0.66, COL.polyDark);
  // Protective hood above the sight line: side walls plus a crossbar well clear of the axis.
  box(body, 0.006, 0.05, 0.05, 0.024, 0.16, -0.02, COL.gunmetal);
  box(body, 0.006, 0.05, 0.05, -0.024, 0.16, -0.02, COL.gunmetal);
  box(body, 0.054, 0.006, 0.05, 0, 0.19, -0.02, COL.polyDark);

  // Side electronics: range dial and a warning strip with orange status lamps.
  box(body, 0.012, 0.04, 0.08, TUBE_R + 0.004, 0.07, -0.16, COL.gunmetal, { rg: 0.5, mt: 0.6 });
  cylZ(body, 0.016, 0.012, TUBE_R + 0.012, 0.07, -0.16, COL.steel, { seg: 12 });
  for (let i = 0; i < 3; i++) {
    box(body, 0.008, 0.008, 0.012, -(TUBE_R + 0.004), 0.06, -0.12 - i * 0.03, i === 0 ? ORANGE : COL.amber);
  }
  box(body, 0.008, 0.02, 0.1, -(TUBE_R + 0.002), 0.09, -0.15, COL.polyDark);
  // Cable run from the grip electronics to the breech.
  box(body, 0.006, 0.006, 0.22, -(TUBE_R - 0.004), -0.01, -0.12, COL.blued, { ry: -0.04 });
  box(body, 0.01, 0.014, 0.02, -(TUBE_R - 0.004), -0.01, breachZ - 0.02, COL.brass, { rg: 0.42, mt: 0.7 });

  // Rocket nose peeking out of the tube mouth (static: the shot itself is a projectile).
  cylZ(body, 0.045, 0.06, muzzleX, muzzleY, muzzleZ + 0.04, ORANGE, { seg: 12, rg: 0.5, mt: 0.4, rTop: 0.02, rBot: 0.045 });

  // Fixed control canister under the breech. Ammunition enters through the rear gate.
  box(mag, 0.07, 0.09, 0.11, 0, -0.06, breachZ - 0.06, COL.blued, { rx: 0.06 });
  box(mag, 0.074, 0.016, 0.114, 0, -0.112, breachZ - 0.058, ORANGE, { rx: 0.06 });
  box(mag, 0.04, 0.012, 0.004, 0, -0.04, breachZ - 0.118, ORANGE, { rx: 0.06 });
  box(mag, 0.012, 0.014, 0.012, 0.028, -0.008, breachZ - 0.06, COL.brass);
  box(mag, 0.012, 0.014, 0.012, -0.028, -0.008, breachZ - 0.06, COL.brass);

  // Arming lever on the right side at bolt home; the post-launch jerk drops it.
  box(bolt, 0.014, 0.06, 0.03, TUBE_R + 0.008, 0.03, BOLT_HOME.rocket, COL.steel, { rg: 0.45, mt: 0.65, rx: 0.3 });
  box(bolt, 0.018, 0.018, 0.034, TUBE_R + 0.01, 0.06, BOLT_HOME.rocket, ORANGE, { rx: 0.3 });

  // Trigger blade plus 3-piece guard at the rocket trigger zero.
  box(trigger, 0.008, 0.03, 0.008, 0, -0.022, TRIGGER_Z.rocket, ORANGE, { rx: -0.22 });
  box(trigger, 0.038, 0.007, 0.068, 0, -0.047, TRIGGER_Z.rocket + 0.004, COL.polyDark);
  box(trigger, 0.038, 0.025, 0.007, 0, -0.036, TRIGGER_Z.rocket - 0.031, COL.polyDark);
  box(trigger, 0.038, 0.025, 0.007, 0, -0.036, TRIGGER_Z.rocket + 0.039, COL.polyDark);
}
import * as THREE from '../../vendor/three.module.js';
