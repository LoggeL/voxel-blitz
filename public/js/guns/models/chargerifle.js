import * as THREE from '../../vendor/three.module.js';
import { COL, GLOW_ACCENT } from '../kit.js';
import { BOLT_HOME, BREACH_Z, TRIGGER_Z } from './common.js';

// CR-6 LONGBOW (Titanfall anti-titan charge rifle, docs/titanfall.md §6). A long, flat
// gunmetal receiver carries a six-cell capacitor bank (three cells a side, red charge
// bands) ahead of a skeletal stock; forward of the handguard the bore runs out between
// an open emitter fork whose two prongs cradle three red focusing rings, and the bore
// rod and the crown both end exactly on T.muzzle. The capacitor cell is the `mag`, the
// charging sled the `bolt`. Sight line 0.165 (SIGHT_HEIGHT.chargerifle).
const SIGHT_Y = 0.165;
const RED = GLOW_ACCENT.chargerifle;
const DARK_RED = 0x5a1410;

// Titanfall on-gun ammo counter seat (weapon-display.js): screen centre on the top rear of the receiver, facing back
// toward the eye (Halo-style rear deck counter), size in m; `seat` names the surface it stands on.
export const DISPLAY_MOUNT = Object.freeze({ x: -0.050, y: 0.093, z: 0.050, w: 0.045, h: 0.035, seat: 'rear' });

export function build({ kit, T, groups }) {
  groups.body.userData.displayMount = DISPLAY_MOUNT;
  const { box, cylZ, mat, ironSights } = kit;
  const { body, mag, bolt, trigger } = groups;
  const [mx, my, mz] = T.muzzle;
  const breachZ = BREACH_Z.chargerifle;
  const heatMaterial = role => {
    const material = mat(DARK_RED, 0.35, 0.1).clone();
    material.emissive.setHex(RED);
    material.emissiveIntensity = 0.02;
    material.userData.chargeHeat = role;
    return material;
  };
  const glow = heatMaterial('channel');
  const core = heatMaterial('core');
  const emitter = heatMaterial('emitter');
  // The existing fixed light pool copies this source. Keeping it invisible avoids
  // introducing another light/shader variant for every equipped charge rifle.
  const chargeLight = new THREE.PointLight(0xff6618, 0, 0.85, 2);
  chargeLight.name = 'chargerifle_charge_light';
  chargeLight.position.set(-0.105, 0.145, -0.10);
  chargeLight.visible = false;
  body.add(chargeLight);

  // Axial temperature gradient: white-hot centre, amber glass, deep red edges.
  // A broad uniformly emissive collar clips to white and loses its cylindrical form.
  const bandPixels = new Uint8Array(4 * 64 * 4);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 4; x++) {
    const p = (y * 4 + x) * 4;
    const hot = Math.exp(-(((y - 31.5) / 11) ** 2));
    bandPixels[p] = Math.round(255 * (0.16 + 0.84 * hot));
    bandPixels[p + 1] = Math.round(255 * (0.004 + 0.75 * hot ** 2));
    bandPixels[p + 2] = Math.round(255 * 0.24 * hot ** 4);
    bandPixels[p + 3] = 255;
  }
  const bandMap = new THREE.DataTexture(bandPixels, 4, 64);
  bandMap.magFilter = bandMap.minFilter = THREE.LinearFilter;
  bandMap.needsUpdate = true;

  // A soft local aura also works on Low and in captures without postprocessing.
  // One gun-owned radial map serves the whole bank and is disposed with it.
  const pixels = new Uint8Array(32 * 32 * 4);
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
    const p = (y * 32 + x) * 4;
    pixels[p] = pixels[p + 1] = pixels[p + 2] = 255;
    pixels[p + 3] = Math.round(255 * Math.max(0, 1 - Math.hypot(x - 15.5, y - 15.5) / 16) ** 2);
  }
  const haloMap = new THREE.DataTexture(pixels, 32, 32);
  haloMap.magFilter = haloMap.minFilter = THREE.LinearFilter;
  haloMap.needsUpdate = true;
  const haloGeometry = new THREE.PlaneGeometry(1, 1);
  const halo = (parent, x, y, z, size, stage = null) => {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: haloMap,
      color: 0xff6514, transparent: true, opacity: 0, blending: THREE.AdditiveBlending,
      depthWrite: false, depthTest: true, toneMapped: false }));
    sprite.name = 'chargerifle_charge_halo';
    sprite.geometry = haloGeometry;
    sprite.position.set(x, y, z);
    sprite.scale.setScalar(size);
    sprite.userData.chargeHalo = { stage, size };
    sprite.visible = false;
    sprite.raycast = () => {}; // cosmetic aura cannot obstruct a sight or hit test
    parent.add(sprite);
    return sprite;
  };

  // Surface-aligned light feathers keep the orange fringe attached to the actual
  // conductors, including on Low. Depth testing still occludes them behind walls.
  const ribbonPixels = new Uint8Array(32 * 16 * 4);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 32; x++) {
    const p = (y * 32 + x) * 4;
    const edge = Math.exp(-(((x - 15.5) / 6) ** 2));
    const end = Math.min(1, y / 2, (15 - y) / 2);
    ribbonPixels[p] = ribbonPixels[p + 1] = ribbonPixels[p + 2] = 255;
    ribbonPixels[p + 3] = Math.round(255 * edge * end);
  }
  const ribbonMap = new THREE.DataTexture(ribbonPixels, 32, 16);
  ribbonMap.magFilter = ribbonMap.minFilter = THREE.LinearFilter;
  ribbonMap.needsUpdate = true;
  const ribbon = (x, y, z, width, length, normal = [0, 1, 0], direction = [0, 0, -1]) => {
    const material = new THREE.MeshBasicMaterial({ map: ribbonMap, color: 0xff4608,
      transparent: true, opacity: 0, blending: THREE.AdditiveBlending,
      depthWrite: false, depthTest: true, toneMapped: false, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(haloGeometry, material);
    const up = new THREE.Vector3(...direction);
    const n = new THREE.Vector3(...normal);
    mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(
      new THREE.Vector3().crossVectors(up, n), up, n));
    mesh.position.set(x, y, z);
    mesh.scale.set(width, length, 1);
    mesh.userData.chargeRibbon = true;
    mesh.visible = false;
    mesh.raycast = () => {};
    body.add(mesh);
  };

  // Receiver: long flat body with an upper deck, side plates and a rear cap that hides
  // the bolt glow cap; it runs back to z +0.04 where the stock takes over.
  box(body, 0.094, 0.086, 0.35, 0, 0.050, -0.135, COL.gunmetal);
  box(body, 0.098, 0.026, 0.33, 0, 0.104, -0.14, COL.polyDark);
  box(body, 0.070, 0.010, 0.31, 0, 0.122, -0.14, COL.steel);
  box(body, 0.086, 0.040, 0.20, 0, -0.012, -0.17, COL.polymer);
  for (const side of [-1, 1]) {
    box(body, 0.004, 0.050, 0.27, side * 0.049, 0.056, -0.14, COL.polymer);
    // Red seam along the deck edge.
    box(body, 0.004, 0.006, 0.30, side * 0.049, 0.090, -0.14, RED, { mat: glow });
    box(body, 0.001, 0.002, 0.296, side * 0.0515, 0.090, -0.14, RED, { mat: core });
    ribbon(side * 0.0521, 0.090, -0.14, 0.042, 0.32, [side, 0, 0]);
  }
  // Fine rear-facing outlines continue the hot circuit around the counter seat.
  // All stay below the sight line and leave the display's black backing readable.
  box(body, 0.086, 0.004, 0.002, 0, 0.110, 0.026, RED, { mat: glow });
  box(body, 0.082, 0.001, 0.001, 0, 0.110, 0.0275, RED, { mat: core });
  ribbon(0, 0.110, 0.0281, 0.026, 0.096, [0, 0, 1], [1, 0, 0]);
  box(body, 0.042, 0.003, 0.002, 0.019, 0.078, 0.041, RED, { mat: glow });
  box(body, 0.038, 0.001, 0.001, 0.019, 0.078, 0.0425, RED, { mat: core });
  ribbon(0.019, 0.078, 0.0431, 0.024, 0.052, [0, 0, 1], [1, 0, 0]);

  // Three paired charge stages, rear to front. These materials belong to this gun:
  // animating a local cell must never light another player's capacitor bank.
  const cellMaterials = Array.from({ length: 3 }, () => {
    const material = mat(DARK_RED, 0.35, 0.1).clone();
    material.emissive.setHex(RED);
    material.emissiveIntensity = 0.02;
    material.emissiveMap = bandMap;
    return material;
  });
  // Capacitor bank: three cells per side. Broad moving collars and top windows
  // expose the same stored charge even when the side is foreshortened in ADS.
  for (const side of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      const z = -0.07 - i * 0.075;
      const x = side * 0.064;
      cylZ(body, 0.019, 0.064, x, 0.052, z, COL.blued, { seg: 24, rg: 0.38, mt: 0.6 });
      const collar = new THREE.Group();
      collar.name = `chargerifle_cell_${side < 0 ? 'left' : 'right'}_${i}`;
      collar.position.set(x, 0.052, z);
      collar.userData.chargeCell = { stage: i, homeZ: z };
      body.add(collar);
      const band = cylZ(collar, 0.021, 0.021, 0, 0, 0, DARK_RED, { seg: 24 });
      band.material = cellMaterials[i];
      cylZ(collar, 0.022, 0.004, 0, 0, -0.014, COL.brake, { seg: 24 });
      cylZ(collar, 0.022, 0.004, 0, 0, 0.014, COL.brake, { seg: 24 });
      box(collar, 0.008, 0.004, 0.012, side * 0.007, 0.020, 0.021, DARK_RED, { mat: cellMaterials[i] });
      halo(collar, side * 0.025, 0.029, 0, 0.105, i);
      cylZ(body, 0.016, 0.006, x, 0.052, z - 0.034, COL.steel, { seg: 12 });
      cylZ(body, 0.016, 0.006, x, 0.052, z + 0.034, COL.steel, { seg: 12 });
    }
    // Bus bar tying the cells into the emitter.
    box(body, 0.006, 0.008, 0.26, side * 0.085, 0.052, -0.145, COL.brass, { rg: 0.4, mt: 0.7 });
    box(body, 0.024, 0.010, 0.010, side * 0.072, 0.052, -0.282, COL.brass, { rg: 0.4, mt: 0.7 });
    box(body, 0.004, 0.006, 0.25, side * 0.089, 0.057, -0.145, RED, { mat: glow });
    box(body, 0.001, 0.002, 0.246, side * 0.0915, 0.057, -0.145, RED, { mat: core });
    ribbon(side * 0.0921, 0.057, -0.145, 0.026, 0.27, [side, 0, 0]);
    // Exposed conductor spine connects the bank to the hot handguard vents.
    box(body, 0.006, 0.004, 0.30, side * 0.045, 0.118, -0.14, RED, { mat: glow });
    box(body, 0.006, 0.004, 0.21, side * 0.036, 0.100, -0.42, RED, { mat: glow });
    box(body, 0.002, 0.001, 0.296, side * 0.045, 0.1205, -0.14, RED, { mat: core });
    box(body, 0.002, 0.001, 0.206, side * 0.036, 0.1025, -0.42, RED, { mat: core });
    ribbon(side * 0.045, 0.1211, -0.14, 0.032, 0.32);
    ribbon(side * 0.036, 0.1031, -0.42, 0.032, 0.23);
    halo(body, side * 0.055, 0.105, -0.28, 0.14);
  }

  // Skeletal stock: top strut, raked lower strut, butt plate and a cheek riser.
  box(body, 0.032, 0.026, 0.22, 0, 0.072, 0.15, COL.polyDark);
  box(body, 0.026, 0.022, 0.25, 0, -0.022, 0.15, COL.polyDark, { rx: 0.24 });
  box(body, 0.044, 0.150, 0.030, 0, 0.022, 0.262, COL.polymer);
  for (const side of [-1, 1]) box(body, 0.004, 0.120, 0.026, side * 0.023, 0.022, 0.262, DARK_RED);
  box(body, 0.036, 0.030, 0.10, 0, 0.098, 0.15, COL.polymer);
  box(body, 0.010, 0.002, 0.09, 0, 0.114, 0.15, RED, { mat: glow });
  box(body, 0.002, 0.001, 0.086, 0, 0.1155, 0.15, RED, { mat: core });
  ribbon(0, 0.1161, 0.15, 0.040, 0.11);

  // Raked pistol grip with a red heel and ribbed sides (the dominant hand wraps it).
  box(body, 0.070, 0.050, 0.13, 0, -0.016, -0.025, COL.polymer);   // grip housing under the receiver tail
  box(body, 0.054, 0.090, 0.048, 0, -0.072, -0.046, COL.polymer, { rx: -0.30 });
  box(body, 0.057, 0.070, 0.050, 0, -0.134, -0.024, COL.polyDark, { rx: -0.24 });
  box(body, 0.060, 0.014, 0.056, 0, -0.174, -0.010, RED, { rx: -0.18 });
  for (const side of [-1, 1]) for (let i = 0; i < 3; i++) {
    box(body, 0.004, 0.008, 0.034, side * 0.029, -0.092 - i * 0.026, -0.036 + i * 0.008, COL.steel, { rx: -0.24 });
  }

  // Handguard: a long slab ahead of the receiver with vent slots and a support cup.
  box(body, 0.080, 0.070, 0.22, 0, 0.052, -0.42, COL.polyDark);
  box(body, 0.084, 0.012, 0.22, 0, 0.092, -0.42, COL.gunmetal);
  for (const side of [-1, 1]) for (let i = 0; i < 4; i++) {
    const z = -0.34 - i * 0.05;
    box(body, 0.004, 0.030, 0.026, side * 0.041, 0.054, z, RED, { mat: glow });
    box(body, 0.001, 0.022, 0.006, side * 0.0435, 0.054, z, RED, { mat: core });
  }
  box(body, 0.050, 0.034, 0.080, 0, 0.004, -0.44, COL.polymer);

  // Bore: one blued tube from the breech to the muzzle (the heat sleeve rides on it).
  const boreLength = Math.abs(mz - breachZ);
  cylZ(body, 0.014, boreLength, mx, my, (mz + breachZ) / 2, COL.blued, { seg: 12, rg: 0.42, mt: 0.75 });

  // Emitter fork: two prongs off a yoke at the handguard nose, run out to the crown.
  box(body, 0.096, 0.050, 0.030, 0, my, -0.545, COL.gunmetal, { rg: 0.5, mt: 0.6 });
  for (const side of [-1, 1]) {
    box(body, 0.014, 0.036, 0.25, side * 0.040, my, -0.68, COL.gunmetal, { rg: 0.5, mt: 0.6 });
    box(body, 0.004, 0.018, 0.23, side * 0.0325, my, -0.68, RED, { mat: emitter });
    box(body, 0.004, 0.001, 0.23, side * 0.040, my + 0.0185, -0.68, RED, { mat: core });
    ribbon(side * 0.040, my + 0.0191, -0.68, 0.025, 0.245);
    halo(body, side * 0.044, my, -0.66, 0.12);
    // Prong tips swept inward toward the crown.
    box(body, 0.012, 0.030, 0.030, side * 0.034, my, -0.795, COL.steel, { ry: side * 0.35 });
  }
  // Three focusing rings between the prongs.
  for (let i = 0; i < 3; i++) {
    const z = -0.60 - i * 0.07;
    const ring = cylZ(body, 0.026, 0.014, mx, my, z, RED, { seg: 14 });
    ring.material = cellMaterials[2];
    cylZ(body, 0.029, 0.004, mx, my, z - 0.010, COL.brake, { seg: 14 });
    cylZ(body, 0.029, 0.004, mx, my, z + 0.010, COL.brake, { seg: 14 });
  }
  // Crown: a stepped emitter cap whose front face lands on T.muzzle.
  cylZ(body, 0.022, 0.024, mx, my, mz + 0.012, COL.brake, { seg: 14, rg: 0.4, mt: 0.7 });
  const crown = cylZ(body, 0.017, 0.024, mx, my, mz + 0.012, RED, { seg: 12 });
  crown.material = emitter;
  halo(body, mx, my, mz + 0.018, 0.15);

  // Sights: rear notch on the receiver, front blade on the fork yoke, with risers.
  const sight = new THREE.Group(); sight.name = 'factory-optic'; body.add(sight);
  ironSights(sight, {
    rearZ: 0.0, frontZ: -0.545, height: SIGHT_Y, width: 0.036, gap: 0.016, color: COL.polyDark, accent: RED,
  });
  for (const side of [-1, 1]) {
    box(sight, 0.002, 0.023, 0.001, side * 0.013, SIGHT_Y - 0.017, 0.0095, RED, { mat: glow });
  }
  box(sight, 0.040, 0.012, 0.036, 0, SIGHT_Y - 0.038, 0.0, COL.gunmetal);
  box(sight, 0.020, SIGHT_Y - 0.030 - 0.085, 0.014, 0, (SIGHT_Y - 0.030 + 0.085) / 2, -0.545, COL.polyDark);
  body.userData.sightHeight = SIGHT_Y;

  // Capacitor cell (the `mag`): a slab seated under the receiver ahead of the grip.
  box(mag, 0.056, 0.090, 0.070, 0, -0.072, -0.185, COL.blued, { rx: 0.05 });
  box(mag, 0.060, 0.014, 0.074, 0, -0.122, -0.180, RED, { mat: glow, rx: 0.05 });
  for (let i = 0; i < 3; i++) box(mag, 0.040, 0.006, 0.004, 0, -0.050 - i * 0.02, -0.222, RED, { mat: glow });

  // Charging sled on the deck: reciprocates on recharge.
  box(bolt, 0.050, 0.020, 0.050, 0, 0.122, BOLT_HOME.chargerifle - 0.02, COL.steel, { rg: 0.45, mt: 0.65 });
  box(bolt, 0.016, 0.022, 0.020, 0.034, 0.120, BOLT_HOME.chargerifle - 0.02, RED, { mat: glow });

  // Trigger blade and guard.
  box(trigger, 0.008, 0.030, 0.008, 0, -0.050, TRIGGER_Z.chargerifle, COL.steel, { rx: -0.22 });
  box(trigger, 0.034, 0.007, 0.070, 0, -0.078, TRIGGER_Z.chargerifle - 0.004, COL.polyDark);
  box(trigger, 0.034, 0.044, 0.007, 0, -0.058, TRIGGER_Z.chargerifle - 0.038, COL.polyDark);
  return true;
}
