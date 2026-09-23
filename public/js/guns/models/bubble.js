import * as THREE from '../../vendor/three.module.js';
import { COL } from '../kit.js';
import { makeSoapFilm } from '../soap-film.js';
import { BOLT_HOME, BREACH_Z, TRIGGER_Z } from './common.js';

// SB-1 SUDSBLASTER: a toy-like bubble launcher, original procedural work inspired by the
// show's underwater bubble motif. Pastel yellow receiver with brass portholes, a teal
// nozzle wrapped in a cream net sock ending in the lilac bubble-wand ring, a screw-in
// soap bottle canted out under the receiver toward the camera, a coral squeeze bulb
// leaning off the top right, a bamboo foregrip and a spatula for a stock (and for the
// rear sight).
// Contracts: the bell lip sits exactly on T.muzzle (the wand ring centre), the ADS centre
// ray runs along x = 0, y = SIGHT_HEIGHT through the spatula notch and the front ring
// aperture, and only sight parts reach y >= 0.124. The films, glass and charge bubbles are
// transparent, so they never block the opaque-only centre ray.
// Animated parts (bulb, film, suds, fizz, handoff) are exposed on extra.userData.bubble for
// the presentation; the tank is the only child of `mag` (the reload moves it whole).
const SIGHT_HEIGHT = 0.140;
const AXIS_Y = 0.030;
const RECEIVER_R = 0.046;
const P = Object.freeze({
  yellow: 0xffe07a, yellowShade: 0xf2c65a, teal: 0x5fd3c6, tealDark: 0x3fb3a6,
  coral: 0xff8fa8, bubblegum: 0xf07aa5, lilac: 0xb9a4ff, cream: 0xfff4d6,
  pole: 0xd9b77a, poleNode: 0xb08a4e, soap: 0xff9fd6, steel: 0xc9d2da,
  spatHandle: 0x9c3f35, porthole: 0x1d4f5a,
});
// Surface finishes: glossy toy plastic, soft rubber, dry bamboo, brushed spatula steel.
const PLASTIC = { rg: 0.55, mt: 0.05 };
const RUBBER = { rg: 0.92, mt: 0 };
const BAMBOO = { rg: 0.8, mt: 0 };
const STEEL = { rg: 0.35, mt: 0.5 };   // less metal than spec 0.75: reads as bright steel without an env map
// Soap bottle under the receiver: glass centre, cant (bottom swings out to the left) and size.
const TANK_CANT = -0.32;
const TANK_UP = [Math.sin(-TANK_CANT), Math.cos(TANK_CANT)];
const TANK_POS = [-0.022, -0.078, -0.105];
const TANK_R = 0.036;
const TANK_H = 0.096;
const SUDS_H = 0.090;

/** Unit-circle point on the receiver skin at angle `a` (0 = +x, pi/2 = top). */
function onReceiver(a, lift = 0) {
  const r = RECEIVER_R + lift;
  return [Math.cos(a) * r, AXIS_Y + Math.sin(a) * r];
}

function mesh(parent, geometry, material, x = 0, y = 0, z = 0) {
  const object = new THREE.Mesh(geometry, material);
  object.position.set(x, y, z);
  parent.add(object);
  return object;
}

/** Five-point star outline (the tank label's sticker), centred on the origin in XY. */
function starGeometry(outer, inner) {
  const shape = new THREE.Shape();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? inner : outer;
    const a = Math.PI / 2 + i * Math.PI / 5;
    if (i === 0) shape.moveTo(Math.cos(a) * r, Math.sin(a) * r);
    else shape.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  shape.closePath();
  return new THREE.ShapeGeometry(shape);
}

export function build({ kit, T, groups }) {
  const { box, cylZ, mat } = kit;
  const { body, mag, bolt, trigger, extra } = groups;
  const muzzleZ = T.muzzle[2];
  const breachZ = BREACH_Z.bubble;
  const plastic = (hex) => mat(hex, PLASTIC.rg, PLASTIC.mt);

  // --- Receiver: yellow toy shell, rear dome, tapered front shoulder -----------------
  cylZ(body, RECEIVER_R, 0.26, 0, AXIS_Y, -0.05, P.yellow, { seg: 20, ...PLASTIC });
  const dome = mesh(body, new THREE.SphereGeometry(RECEIVER_R, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2),
    plastic(P.yellow), 0, AXIS_Y, 0.08);
  dome.rotation.x = Math.PI / 2;
  cylZ(body, 0.035, 0.12, 0, AXIS_Y, -0.24, P.yellowShade, { rTop: RECEIVER_R, rBot: 0.024, seg: 20, ...PLASTIC });
  // A cream trim band where the shell meets the shoulder.
  cylZ(body, RECEIVER_R + 0.0015, 0.010, 0, AXIS_Y, -0.174, P.cream, { seg: 20, ...PLASTIC });

  // Twin cream racing stripes laid on the top of the shell.
  for (const side of [-1, 1]) {
    const x = side * 0.020;
    const y = AXIS_Y + Math.sqrt(RECEIVER_R ** 2 - x * x) + 0.0015;
    box(body, 0.008, 0.004, 0.22, x, y, -0.05, P.cream, PLASTIC);
  }

  // Two brass portholes on the camera-facing left flank, dark teal glass behind the rim.
  const portGlass = mat(P.porthole, 0.2, 0.1);
  for (const z of [0.030, 0.065]) {
    const rim = mesh(body, new THREE.TorusGeometry(0.011, 0.0028, 6, 16), mat(COL.brass, 0.35, 0.8),
      -RECEIVER_R - 0.001, 0.035, z);
    rim.rotation.y = Math.PI / 2;
    const glass = mesh(body, new THREE.CircleGeometry(0.0095, 16), portGlass, -RECEIVER_R + 0.0005, 0.035, z);
    glass.rotation.y = -Math.PI / 2;
    // Cartoon glint in the porthole.
    const glint = mesh(body, new THREE.CircleGeometry(0.0028, 8), mat(0xffffff, 0.3, 0), -RECEIVER_R - 0.0002,
      0.039, z - 0.004);
    glint.rotation.y = -Math.PI / 2;
  }

  // Brass seam rivets along the lower left seam.
  const rivet = new THREE.SphereGeometry(0.0035, 6, 4);
  const brass = mat(COL.brass, 0.35, 0.8);
  const [seamX, seamY] = onReceiver(Math.PI * 1.11);
  for (let i = 0; i < 6; i++) mesh(body, rivet, brass, seamX, seamY, -0.14 + i * 0.04);

  // --- Nozzle: teal tube, cream ribs, flared bell with a cream lip on T.muzzle --------
  const bellLength = 0.025;
  const tubeLength = breachZ - (muzzleZ + bellLength);
  cylZ(body, 0.022, tubeLength, 0, AXIS_Y, breachZ - tubeLength / 2, P.teal, { seg: 12, ...PLASTIC });
  for (const z of [-0.33, -0.36, -0.39]) cylZ(body, 0.0245, 0.006, 0, AXIS_Y, z, P.cream, { seg: 12, ...PLASTIC });
  cylZ(body, 0.028, bellLength, 0, AXIS_Y, muzzleZ + bellLength / 2, P.teal,
    { rTop: 0.024, rBot: 0.032, seg: 16, ...PLASTIC });
  mesh(body, new THREE.CircleGeometry(0.026, 16), mat(P.porthole, 0.4, 0), 0, AXIS_Y, muzzleZ - 0.0004)
    .rotation.y = Math.PI;
  mesh(body, new THREE.TorusGeometry(0.032, 0.004, 6, 24), plastic(P.cream), 0, AXIS_Y, muzzleZ);

  // The bubble-wand ring facing -z around the muzzle, four spokes back to the bell lip.
  const lilac = mat(P.lilac, 0.4, 0.05);
  mesh(body, new THREE.TorusGeometry(0.056, 0.0075, 8, 32), lilac, 0, AXIS_Y, muzzleZ);
  for (let i = 0; i < 4; i++) {
    const a = Math.PI / 4 + i * Math.PI / 2;
    box(body, 0.004, 0.024, 0.004, Math.cos(a) * 0.044, AXIS_Y + Math.sin(a) * 0.044, muzzleZ, P.lilac,
      { rz: a + Math.PI / 2, rg: 0.4, mt: 0.05 });
  }
  // Little lilac beads on the ring at the spoke roots, like a toy wand's moulding.
  const bead = new THREE.SphereGeometry(0.0095, 8, 6);
  for (let i = 0; i < 4; i++) {
    const a = Math.PI / 4 + i * Math.PI / 2;
    mesh(body, bead, lilac, Math.cos(a) * 0.056, AXIS_Y + Math.sin(a) * 0.056, muzzleZ);
  }

  // Cream net sock over the nozzle: rim, eight tapered strands, two cross rings.
  const cream = plastic(P.cream);
  mesh(body, new THREE.TorusGeometry(0.034, 0.003, 6, 24), cream, 0, AXIS_Y, -0.47);
  const strand = new THREE.BoxGeometry(0.0025, 0.0025, 0.14);
  for (let i = 0; i < 8; i++) {
    const spoke = new THREE.Group();
    spoke.position.set(0, AXIS_Y, 0);
    spoke.rotation.z = i * Math.PI / 4;
    const s = mesh(spoke, strand, cream, 0, 0.0285, -0.40);
    s.rotation.x = 0.078;
    body.add(spoke);
  }
  for (const [r, z] of [[0.0305, -0.43], [0.027, -0.37]]) {
    mesh(body, new THREE.TorusGeometry(r, 0.002, 4, 20), cream, 0, AXIS_Y, z);
  }

  // Bamboo foregrip on two teal hangers under the nozzle.
  cylZ(body, 0.016, 0.17, 0, -0.030, -0.345, P.pole, { seg: 8, ...BAMBOO });
  for (const z of [-0.29, -0.345, -0.40]) cylZ(body, 0.018, 0.008, 0, -0.030, z, P.poleNode, { seg: 8, ...BAMBOO });
  cylZ(body, 0.0165, 0.004, 0, -0.030, -0.4315, P.poleNode, { seg: 8, ...BAMBOO });
  for (const z of [-0.28, -0.41]) box(body, 0.012, 0.022, 0.012, 0, -0.003, z, P.tealDark, PLASTIC);

  // Clear air line from the squeeze bulb to the nozzle (the presentation's air bead runs
  // on it) and the teal soap feed hose from the tank socket into the nozzle root.
  const beadCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0.030, 0.082, 0.032), new THREE.Vector3(0.028, 0.075, -0.10),
    new THREE.Vector3(0.020, 0.060, -0.25), new THREE.Vector3(0.010, 0.050, -0.30),
  ]);
  const airLine = new THREE.MeshStandardMaterial({
    color: 0xe6fbff, transparent: true, opacity: 0.35, roughness: 0.1, metalness: 0, depthWrite: false,
  });
  mesh(body, new THREE.TubeGeometry(beadCurve, 24, 0.004, 6, false), airLine);
  for (const z of [-0.05, -0.17]) {
    const t = beadCurve.getPoint(z === -0.05 ? 0.3 : 0.62);
    box(body, 0.012, 0.004, 0.006, t.x, t.y - 0.004, t.z, P.cream, PLASTIC);
  }
  const feedCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-0.036, 0.000, -0.15), new THREE.Vector3(-0.047, -0.012, -0.21),
    new THREE.Vector3(-0.030, -0.004, -0.27), new THREE.Vector3(-0.012, 0.014, -0.305),
  ]);
  mesh(body, new THREE.TubeGeometry(feedCurve, 20, 0.006, 6, false), plastic(P.tealDark));
  mesh(body, new THREE.SphereGeometry(0.009, 8, 6), plastic(P.tealDark), -0.036, 0.000, -0.15);

  // --- Grip: bubblegum pistol grip with coral finger bands and a bubble pommel -------
  const grip = new THREE.Group();
  grip.position.set(0, -0.058, 0.012);
  grip.rotation.x = -0.22;
  body.add(grip);
  box(grip, 0.036, 0.100, 0.046, 0, 0, 0, P.bubblegum, RUBBER);
  for (let i = 0; i < 4; i++) box(grip, 0.040, 0.006, 0.048, 0, 0.028 - i * 0.02, 0, P.coral, RUBBER);
  mesh(body, new THREE.SphereGeometry(0.022, 12, 8), lilac, 0, -0.112, 0.024);
  const guard = mesh(body, new THREE.TorusGeometry(0.024, 0.004, 6, 16, Math.PI), cream, 0, -0.012, -0.030);
  guard.rotation.set(0, Math.PI / 2, Math.PI);

  // --- Spatula stock: red handle, slotted steel blade, brass rivets -------------------
  box(body, 0.022, 0.022, 0.10, 0, -0.005, 0.14, P.spatHandle, { rx: 0.18, rg: 0.7, mt: 0.05 });
  box(body, 0.008, 0.075, 0.10, 0, -0.02, 0.23, P.steel, STEEL);
  for (const dy of [-0.02, 0, 0.02]) box(body, 0.0085, 0.008, 0.06, 0, -0.02 + dy, 0.235, COL.polyDark);
  for (const dy of [0.012, -0.012]) mesh(body, new THREE.SphereGeometry(0.004, 6, 4), brass, -0.005, -0.012 + dy, 0.185);

  // --- Sights: spatula-blade notch at the rear, lilac ring aperture up front ---------
  box(body, 0.010, 0.028, 0.008, 0, 0.090, 0.020, P.spatHandle, { rg: 0.7, mt: 0.05 });
  mesh(body, new THREE.SphereGeometry(0.003, 6, 4), brass, -0.0055, 0.088, 0.020);
  for (const side of [-1, 1]) {
    box(body, 0.019, 0.036, 0.004, side * 0.0155, 0.122, 0.020, P.steel, STEEL);
    box(body, 0.0025, 0.020, 0.005, side * 0.0155, 0.122, 0.0205, COL.polyDark);
  }
  box(body, 0.050, 0.006, 0.004, 0, 0.107, 0.020, P.steel, STEEL);
  box(body, 0.006, 0.0712, 0.006, 0, 0.0876, -0.36, P.lilac, { rg: 0.4, mt: 0.05 });
  box(body, 0.006, 0.0168, 0.010, 0, 0.1316, -0.36, P.coral, RUBBER);
  mesh(body, new THREE.TorusGeometry(0.014, 0.0028, 6, 20), lilac, 0, SIGHT_HEIGHT, -0.36);
  body.userData.sightHeight = SIGHT_HEIGHT;

  // --- Soap tank (the "mag"): a bottle screwed up into a socket under the receiver,
  // canted out to the camera-facing left so the pink suds column reads at a glance.
  // Local +y is the bottle neck; the group origin is the glass centre.
  const socket = mesh(body, new THREE.CylinderGeometry(0.030, 0.030, 0.024, 16), plastic(P.yellowShade),
    TANK_POS[0] + TANK_UP[0] * 0.068, TANK_POS[1] + TANK_UP[1] * 0.068, TANK_POS[2]);
  socket.rotation.z = TANK_CANT;
  const tank = new THREE.Group();
  tank.name = 'bubble_tank';
  tank.position.set(TANK_POS[0], TANK_POS[1], TANK_POS[2]);
  tank.rotation.order = 'ZYX'; // a presentation thread turn (rotation.y) spins about the bottle axis
  tank.rotation.z = TANK_CANT;
  mag.add(tank);
  const tankGlass = new THREE.MeshStandardMaterial({
    color: 0xe6fbff, transparent: true, opacity: 0.28, roughness: 0.08, metalness: 0, depthWrite: false,
  });
  mesh(tank, new THREE.CylinderGeometry(TANK_R, TANK_R, TANK_H, 20, 1, true), tankGlass);
  // A painted-on window glint down the camera side of the glass.
  const glintMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, depthWrite: false });
  mesh(tank, new THREE.BoxGeometry(0.002, 0.066, 0.006), glintMat, -TANK_R + 0.0015, 0.004, 0.013);
  mesh(tank, new THREE.BoxGeometry(0.002, 0.022, 0.004), glintMat, -TANK_R + 0.0015, 0.026, 0.003);
  // Neck: yellow thread collar into the socket, brass seal ring.
  mesh(tank, new THREE.CylinderGeometry(0.039, 0.039, 0.012, 20), plastic(P.yellow), 0, TANK_H / 2 + 0.006, 0);
  mesh(tank, new THREE.CylinderGeometry(0.022, 0.026, 0.016, 16), plastic(P.yellow), 0, TANK_H / 2 + 0.020, 0);
  mesh(tank, new THREE.TorusGeometry(0.022, 0.002, 4, 16), brass, 0, TANK_H / 2 + 0.026, 0).rotation.x = Math.PI / 2;
  // Base: lilac cap with grip ridges and a coral drain button.
  mesh(tank, new THREE.CylinderGeometry(0.038, 0.034, 0.018, 20), lilac, 0, -TANK_H / 2 - 0.009, 0);
  const ridge = new THREE.BoxGeometry(0.004, 0.016, 0.004);
  for (let i = 0; i < 12; i++) {
    const a = i * Math.PI / 6;
    mesh(tank, ridge, lilac, Math.cos(a) * 0.037, -TANK_H / 2 - 0.008, Math.sin(a) * 0.037).rotation.y = -a;
  }
  mesh(tank, new THREE.CylinderGeometry(0.010, 0.010, 0.008, 12), mat(P.coral, RUBBER.rg, RUBBER.mt),
    0, -TANK_H / 2 - 0.021, 0);
  // Cream label band facing the camera with a soap-pink star sticker.
  const labelArc = 1.7;
  mesh(tank, new THREE.CylinderGeometry(TANK_R + 0.0006, TANK_R + 0.0006, 0.030, 12, 1, true,
    Math.PI * 1.5 - labelArc / 2, labelArc), plastic(P.cream), 0, -0.012, 0);
  const star = mesh(tank, starGeometry(0.011, 0.0047), mat(P.bubblegum, 0.5, 0), -TANK_R - 0.0008, -0.012, 0);
  star.rotation.y = -Math.PI / 2;

  // Suds column: grows from the tank floor, `scale.y` is the level (the presentation
  // follows the authoritative mag). Opaque, so the HUD icon keeps a pink column.
  const suds = new THREE.Group();
  suds.name = 'bubble_suds';
  suds.position.y = -TANK_H / 2;
  suds.userData.height = SUDS_H;
  tank.add(suds);
  mesh(suds, new THREE.CylinderGeometry(TANK_R - 0.004, TANK_R - 0.004, SUDS_H, 16), mat(P.soap, 0.3, 0),
    0, SUDS_H / 2, 0);
  const foam = new THREE.Group();
  foam.name = 'bubble_foam';
  foam.position.y = -TANK_H / 2 + SUDS_H;
  tank.add(foam);
  mesh(foam, new THREE.CylinderGeometry(TANK_R - 0.003, TANK_R - 0.003, 0.006, 16), cream);
  const foamBall = new THREE.SphereGeometry(1, 8, 6);
  for (const [x, z, r] of [[-0.016, 0.008, 0.009], [0.011, -0.014, 0.007], [0.014, 0.012, 0.008],
    [-0.005, -0.018, 0.006], [-0.018, -0.007, 0.006]]) {
    mesh(foam, foamBall, cream, x, 0.003, z).scale.setScalar(r);
  }
  const fizzMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7, depthWrite: false });
  const fizz = [];
  for (let i = 0; i < 5; i++) {
    const a = i * 2.4;
    const f = mesh(tank, foamBall, fizzMat, Math.cos(a) * 0.018, -0.036 + i * 0.015, Math.sin(a) * 0.018);
    f.scale.setScalar(0.003 + (i % 3) * 0.0015);
    f.userData.home = f.position.clone();
    fizz.push(f);
  }

  // --- Bolt and trigger: bulb plunger rod, squeeze-bulb trigger -----------------------
  cylZ(bolt, 0.006, 0.03, 0.024, 0.068, BOLT_HOME.bubble, P.steel, { seg: 8, ...STEEL });
  const triggerGroup = new THREE.Group();
  triggerGroup.position.set(0, -0.022, TRIGGER_Z.bubble);
  triggerGroup.rotation.x = -0.25;
  trigger.add(triggerGroup);
  box(triggerGroup, 0.008, 0.026, 0.010, 0, 0, 0, P.coral, RUBBER);
  mesh(triggerGroup, new THREE.SphereGeometry(0.0055, 8, 6), mat(P.coral, RUBBER.rg, RUBBER.mt), 0, -0.014, -0.002);

  // --- Extra: squeeze bulb, wand film, bulge, charge/handoff/idle bubbles, air bead ---
  const bulb = new THREE.Group();
  bulb.name = 'bubble_bulb';
  bulb.position.set(0.024, 0.066, 0.062);
  bulb.rotation.z = -0.5; // leans out to the right: the ADS picture stays clear
  extra.add(bulb);
  const ball = mesh(bulb, new THREE.SphereGeometry(0.028, 16, 12), mat(P.coral, RUBBER.rg, RUBBER.mt), 0, 0.025, 0);
  ball.scale.set(1, 0.9, 1.3);
  mesh(bulb, new THREE.CylinderGeometry(0.012, 0.014, 0.012, 12), mat(P.bubblegum, RUBBER.rg, RUBBER.mt), 0, 0.004, 0);
  // Rubber shine dot, up-left on the bulb.
  mesh(bulb, new THREE.SphereGeometry(0.006, 8, 6), mat(0xffd6e0, 0.6, 0), -0.014, 0.041, 0.012).scale.set(1, 0.6, 1.4);

  const wand = makeSoapFilm({ alpha: 0.85, phase: 0 });
  const film = mesh(extra, new THREE.CircleGeometry(0.0485, 24), wand.material, 0, AXIS_Y, muzzleZ - 0.001);
  film.name = 'bubble_film';
  film.renderOrder = 3;
  const bulgeGeometry = new THREE.SphereGeometry(0.0485, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2);
  bulgeGeometry.rotateX(-Math.PI / 2); // dome faces -z, so scale.z inflates it off the ring
  const bulge = mesh(extra, bulgeGeometry, wand.material, 0, AXIS_Y, muzzleZ - 0.001);
  bulge.name = 'bubble_bulge';
  bulge.scale.z = 0.001;
  bulge.renderOrder = 3;

  const chargeFilm = makeSoapFilm({ alpha: 0.7, phase: 0.2 });
  // Built at the smallest charge radius (the presentation scales by geometry radius), so
  // hidden it never inflates Box3.setFromObject bounds of the gun (avatar framing).
  const charge = mesh(extra, new THREE.SphereGeometry(0.02, 20, 14), chargeFilm.material, 0, AXIS_Y, muzzleZ - 0.02);
  charge.name = 'bubble_charge';
  charge.visible = false;
  charge.renderOrder = 4;
  const handoffFilm = makeSoapFilm({ alpha: 0.75, phase: 0.5 });
  const handoff = mesh(extra, new THREE.SphereGeometry(0.045, 16, 12), handoffFilm.material, 0, AXIS_Y, muzzleZ - 0.045);
  handoff.name = 'bubble_handoff';
  handoff.visible = false;
  handoff.renderOrder = 4;
  // Each idle bubble fades on its own clock, so each gets its own film.
  const idleFilms = [];
  const idle = [];
  const idleGeometry = new THREE.SphereGeometry(0.012, 10, 8);
  for (let i = 0; i < 3; i++) {
    idleFilms.push(makeSoapFilm({ alpha: 0.8, phase: 0.35 + i * 0.2 }));
    const b = mesh(extra, idleGeometry, idleFilms[i].material, 0, AXIS_Y + 0.056, muzzleZ);
    b.name = 'bubble_idle';
    b.visible = false;
    b.renderOrder = 4;
    idle.push(b);
  }
  const airBead = mesh(extra, new THREE.SphereGeometry(0.005, 8, 6),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthWrite: false }));
  airBead.name = 'bubble_airbead';
  airBead.position.copy(beadCurve.getPoint(0));
  airBead.visible = false;

  extra.userData.bubble = {
    bulb, film, bulge, charge, handoff, bead: airBead, beadCurve, hoseCurve: feedCurve, suds, foam, fizz, tank,
    idle, muzzle: new THREE.Vector3(0, AXIS_Y, muzzleZ),
    filmMats: { wand, charge: chargeFilm, handoff: handoffFilm, idle: idleFilms },
  };
}
