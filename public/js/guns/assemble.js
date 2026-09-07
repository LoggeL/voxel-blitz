// Ten-model registry and shared first-person gun composition root.
import * as THREE from '../vendor/three.module.js';
import { disposeObjectTrees } from '../engine/dispose.js';
import { HANDS, timerFor } from './defs.js';
import { makeFlash, makeFx, makeKit } from './kit.js';
import {
  BARREL_R,
  BOLT_HOME,
  BREACH_Z,
  HIP,
  PUMP_REST,
} from './models/common.js';
import { build as buildRifle } from './models/rifle.js';
import { build as buildSmg } from './models/smg.js';
import { build as buildShotgun } from './models/shotgun.js';
import { build as buildSniper } from './models/sniper.js';
import { build as buildMinigun } from './models/minigun.js';
import { build as buildLmg } from './models/lmg.js';
import { build as buildRevolver } from './models/revolver.js';
import { build as buildLongarc } from './models/longarc.js';
import { build as buildRocket } from './models/rocket.js';
import { build as buildLance } from './models/lance.js';
import { build as buildFlamethrower } from './models/flamethrower.js';
import { build as buildKnife } from './models/knife.js';

const MODELS = Object.freeze({
  rifle: buildRifle,
  smg: buildSmg,
  shotgun: buildShotgun,
  sniper: buildSniper,
  lmg: buildLmg,
  minigun: buildMinigun,
  revolver: buildRevolver,
  longarc: buildLongarc,
  rocket: buildRocket,
  lance: buildLance,
  knife: buildKnife,
  flamethrower: buildFlamethrower,
});

// Glow accents for the two roster ids kit.js's GLOW_ACCENT sheet does not carry yet. makeFx()
// defaults to GLOW_ACCENT[id], so assemble passes the def-tracer-matched colors here and the
// rig, HUD icon rasterizer, and models all agree on one accent per weapon.
const FX_ACCENT = Object.freeze({ lance: 0xc9a2ff, knife: 0xb8c4d4 });

/**
 * Melee bundles have no ballistic muzzle flash, but the flash object is part of the model
 * contract: the rig (revealFlash/flashOff/_decayFx), the avatar mount, and HUD capture all
 * dereference `flash.grp/mats/light` unconditionally. A stub with an empty group and an
 * inert light stand-in keeps every consumer honest while never rendering anything.
 */
function makeMeleeFlash() {
  return { grp: new THREE.Group(), mats: [], light: { intensity: 0 } };
}

/**
 * Assemble one model bundle. MaterialCache is rig-owned; registering the completed hierarchy
 * preserves one shared-material reference per rig even when all ten models are built lazily.
 */
export function buildGun(id, cache) {
  const buildModel = MODELS[id];
  if (!buildModel) throw new RangeError(`Unknown gun model: ${id}`);
  if (!cache || typeof cache.refModel !== 'function') {
    throw new TypeError('buildGun requires a MaterialCache');
  }

  const T = timerFor(id);
  const melee = T.melee === true;
  const hands = HANDS[id];
  const kit = makeKit(cache);
  const root = new THREE.Group();
  root.name = `gun_${id}`;

  const body = new THREE.Group();
  body.name = 'body';
  const mag = new THREE.Group();
  mag.name = 'mag';
  const bolt = new THREE.Group();
  bolt.name = 'bolt';
  const trigger = new THREE.Group();
  trigger.name = 'triggerGroup';
  const pump = id === 'shotgun' ? new THREE.Group() : null;
  if (pump) pump.name = 'pump';
  const extra = new THREE.Group();
  extra.userData.cartridges = [];

  buildModel({
    kit,
    T,
    groups: { body, mag, bolt, pump, trigger, extra },
  });

  const muzzleMarker = new THREE.Object3D();
  muzzleMarker.name = 'muzzle';
  muzzleMarker.position.set(T.muzzle[0], T.muzzle[1], T.muzzle[2]);
  body.add(muzzleMarker);

  const flash = melee ? makeMeleeFlash() : makeFlash();
  flash.grp.position.copy(muzzleMarker.position).add(new THREE.Vector3(0, 0, -0.01));
  body.add(flash.grp);

  const fx = makeFx(id, FX_ACCENT[id]);
  const uni = fx.uniforms;
  const glow = fx.material;
  if (!melee && id !== 'revolver') {
    const capZ = BOLT_HOME[id];
    const cap = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.012), glow);
    cap.position.set(-0.02, 0.07, capZ + 0.052);
    bolt.add(cap);
  }

  const span = (T.heatLen[1] - T.heatLen[0]) * T.barrelLen;
  const startZ = BREACH_Z[id] - T.heatLen[0] * T.barrelLen;
  const heatGeometry = new THREE.CylinderGeometry(
    BARREL_R[id], BARREL_R[id], span, 10, 1, true,
  );
  heatGeometry.rotateX(Math.PI / 2);
  const heat = new THREE.Mesh(heatGeometry, glow);
  heat.position.set(T.muzzle[0], T.muzzle[1], startZ - span / 2);
  body.add(heat);

  const rightHand = kit.glove(
    body,
    hands.grip.x - 0.005,
    hands.grip.y - 0.01,
    hands.grip.z,
    'grip',
    1,
  );
  rightHand.name = 'hand_r';
  if (hands.support) {
    const target = hands.support.on === 'pump' && pump ? pump : body;
    const lx = hands.support.x - (target === pump ? PUMP_REST.x : 0);
    const ly = hands.support.y - (target === pump ? PUMP_REST.y : 0);
    const lz = hands.support.z - (target === pump ? PUMP_REST.z : 0);
    const leftHand = kit.glove(target, lx, ly, lz, 'support', -1);
    leftHand.name = 'hand_l';
  } else if (!melee) {
    const leftHand = kit.glove(extra, -0.10, -0.12, -0.14, 'support', -1);
    leftHand.name = 'hand_l';
    leftHand.visible = false;
  }

  root.add(body);
  root.add(mag);
  root.add(bolt);
  root.add(trigger);
  root.add(extra);
  if (pump) root.add(pump);
  cache.refModel(root);

  return {
    root,
    body,
    mag,
    bolt,
    pump,
    triggerGroup: trigger,
    extra,
    muzzleMarker,
    flash,
    uni,
    T,
    magazines: mag.children.length,
    conditionPhase:
      (id.charCodeAt(0) * 0.017 + id.charCodeAt(id.length - 1) * 0.031) % (Math.PI * 2),
    pivotCam: new THREE.Vector3(
      HIP.x + hands.grip.x,
      HIP.y + hands.grip.y,
      HIP.z + hands.grip.z,
    ),
  };
}

/** Dispose one rig owner's built gun bundles without releasing shared materials twice. */
export function disposeGunModels(models, cache) {
  const bundles = Array.isArray(models) ? models : Object.values(models || {});
  disposeObjectTrees(bundles.map(bundle => bundle?.root), { excludedMaterials: cache?.sharedMaterials });
  for (const bundle of bundles) {
    bundle?.root?.removeFromParent();
    bundle?.root?.clear();
  }
  cache?.releaseRig();
}
