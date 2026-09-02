// Shared silhouette geometry and animation zero-points. Weapon timing/muzzle profiles remain in
// defs.js; do not mirror or export them from here.
import * as THREE from '../../vendor/three.module.js';

export const D2R = Math.PI / 180;

// Exposed barrel start in gun-local Z. Builders must land the opposite tip exactly at T.muzzle.
export const BREACH_Z = {
  rifle: -0.32,
  smg: -0.21,
  shotgun: -0.11,
  sniper: -0.26,
  lmg: -0.34,
  revolver: -0.16,
  longarc: -0.30,
};

// Heat-sleeve radii include the existing tiny clearance that prevents z-fighting.
export const BARREL_R = {
  rifle: 0.0175,
  smg: 0.0385,
  shotgun: 0.0205,
  sniper: 0.0215,
  lmg: 0.0295,
  revolver: 0.0185,
  longarc: 0.020,
};

export const BOLT_HOME = {
  rifle: -0.035,
  smg: -0.020,
  shotgun: -0.050,
  sniper: -0.010,
  lmg: -0.025,
  revolver: -0.018,
  longarc: -0.030,
};

export const PUMP_REST = new THREE.Vector3(0, 0.038, -0.30);

export const TRIGGER_Z = {
  rifle: -0.13,
  smg: -0.095,
  shotgun: -0.145,
  sniper: -0.165,
  lmg: -0.13,
  revolver: -0.075,
  longarc: -0.14,
};

// Camera-space hip carry; +x is true screen-right.
export const HIP = new THREE.Vector3(0.22, -0.24, -0.45);
export const VM_FOV_BASE = 75;

export const CYCLE_FRACS = {
  pump: { s1: 0.14, s2: 0.50, s3: 0.86 },
  bolt: { s1: 0.12, s2: 0.50, s3: 0.92 },
};

export const PUMP_MS = 430;
export const SNIPER_BOLT_MIN_S = 0.90;

/**
 * @typedef {Object} BuilderContext
 * @property {Object} kit Material-bound {mat, box, cylZ, brakeRings, glove} primitives.
 * @property {Object} T The selected private timer/profile object from defs.js.
 * @property {Object} groups The only scene-graph mutation targets available to a builder.
 * @property {THREE.Group} groups.body
 * @property {THREE.Group} groups.mag
 * @property {THREE.Group} groups.bolt
 * @property {?THREE.Group} groups.pump
 * @property {THREE.Group} groups.trigger
 * @property {THREE.Group} groups.extra
 */

/**
 * Builder contract:
 * - `build(ctx)` must make barrel geometry touch `ctx.T.muzzle` exactly.
 * - Children may be added only to the six groups supplied in `ctx.groups`.
 * - Reload animation handles live only at `extra.userData.cartridges`, `reloadPart`, or
 *   `reloadRounds` (with `reloadRounds.userData.homePosition` where applicable).
 * - A model imports only three.module.js, kit.js, common.js, and (when needed) defs.js.
 */
