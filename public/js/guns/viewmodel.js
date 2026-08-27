// public/js/guns/viewmodel.js — Agent E: first-person gunfeel rig.
// STRATEGY: single scene/pass; rig is a child of the MAIN camera at (0,0,0) — no vmCamera
// overlay pass. ADS zoom stability via the SCALE TRICK: root counter-scales each frame by
// tan(base/2)/tan(live/2), cancelling WEAPONS.adsFov growth (full note in defs.js header).
// Everything procedural Box/Cylinder + canvas-drawn reticle; zero fetches; no fonts needed.
import * as THREE from '../vendor/three.module.js';
import { TIMERS, BOB, HANDS, DEPLOY, timerFor } from './defs.js';

const D2R = Math.PI / 180;

// Per-silhouette identity palette. Values pinned in the assignment brief; do not drift them.
const COL = {
  steel: 0x3c4046, polyDark: 0x22252a, wood: 0x4b3621, amber: 0xff8c1a,
  tan: 0xb09a72, polymer: 0x15171a, blued: 0x2b3038, walnut: 0x5a3d24,
  cerakote: 0x37413a, greenSteel: 0x2e3830, fluteDark: 0x232b25,
  olive: 0x4a5137, parkerized: 0x343a34, gunmetal: 0x454b52,
  brake: 0x24282e, brass: 0xc9a227, shellRed: 0xa33327, flash: 0xffd977,
};
// Exhaust-glow accent colors (cyan/orange family per assignment), one identity per gun.
const GLOW_ACCENT = {
  rifle: 0xffa03c, smg: 0x59e8ff, shotgun: 0xff7433, sniper: 0x7dfcff,
  lmg: 0xffb02e, revolver: 0xff6f45,
};

// Where the exposed barrel leaves the receiver (gun-local z). Heat bands + lengths measured from here.
const BREACH_Z = {
  rifle: -0.32, smg: -0.21, shotgun: -0.11, sniper: -0.26, lmg: -0.34, revolver: -0.16,
};
// Barrel/housing radii (+tiny) — heat band hugs these so the glow never z-fights.
const BARREL_R = {
  rifle: 0.0175, smg: 0.0385, shotgun: 0.0205, sniper: 0.0215, lmg: 0.0295, revolver: 0.0185,
};
// Rest offsets of moving sub-groups (animation zero points, gun-local).
const BOLT_HOME = {
  rifle: -0.035, smg: -0.020, shotgun: -0.050, sniper: -0.010, lmg: -0.025, revolver: -0.018,
};
const PUMP_REST = new THREE.Vector3(0, 0.038, -0.30);
const TRIGGER_Z = {
  rifle: -0.13, smg: -0.095, shotgun: -0.145, sniper: -0.165, lmg: -0.13, revolver: -0.075,
};
// Hip rest pose of the whole rig in camera space (right shoulder carry; +x is TRUE screen-right).
const HIP = new THREE.Vector3(0.22, -0.24, -0.45);
const VM_FOV_BASE = 75; // mirrors defs.VIEW_LAYERS.baseFov note; kept literal to honor import rule.

const CYCLE_FRACS = {
  pump: { s1: 0.14, s2: 0.50, s3: 0.86 },  // unlock / fully-rear / closed-and-locked
  bolt: { s1: 0.12, s2: 0.50, s3: 0.92 },  // rotary-lift / rear / slam home
};
const PUMP_MS = 430;                        // shotgun hand cycle — snappy but readable.
const SNIPER_BOLT_MIN_S = 0.90;             // floor; TIMERS.sniper.bursts[0][0]/1000 may raise it.

/* ---------------- tiny procedural-primitive helpers (flat-shaded everywhere) --------------- */

const MATS = new Map();
const MAT_REFS = new Map();
const MAT_KEYS = new Map();
function mat(hex, rough = 0.78, metal = 0.22) {
  const key = hex + '|' + rough + '|' + metal;
  let m = MATS.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color: hex, flatShading: true, roughness: rough, metalness: metal });
    MATS.set(key, m);
    MAT_REFS.set(m, 0);
    MAT_KEYS.set(m, key);
  }
  return m;
}

function box(parent, w, h, d, x, y, z, c, o = {}) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), o.mat || mat(c, o.rg ?? 0.78, o.mt ?? 0.22));
  mesh.position.set(x, y, z);
  if (o.rx) mesh.rotation.x = o.rx;
  if (o.ry) mesh.rotation.y = o.ry;
  if (o.rz) mesh.rotation.z = o.rz;
  parent.add(mesh);
  return mesh;
}

/** Cylinder aligned to local Z (bore direction). Extra options passed straight to mat(). */
function cylZ(parent, r, len, x, y, z, c, o = {}) {
  const geo = new THREE.CylinderGeometry(o.rTop ?? r, o.rBot ?? r, len, o.seg ?? 10, 1, o.open === true);
  geo.rotateX(Math.PI / 2); // bake: +y -> +z rear, -z forward bore
  const mesh = new THREE.Mesh(geo, mat(c, o.rg ?? 0.65, o.mt ?? 0.45));
  mesh.position.set(x, y, z);
  parent.add(mesh);
  return mesh;
}

/** Muzzle-brake rings: stacked short fat discs — the at-a-glance silhouette cue on every gun. */
function brakeRings(parent, r, x, y, zTip, count, gap, ringLen, c) {
  for (let i = 0; i < count; i++) {
    const z = zTip + 0.012 + gap * (i + 1) + ringLen * i;
    cylZ(parent, r * 1.0, ringLen, x, y, z, c ?? COL.brake, { seg: 10 });
  }
}

/**
 * Static posed boxy glove baked into the model. DOCUMENTED CHOICE (contract asks explicitly):
 * runtime IK is deliberately FAKE — no solver, no bone chain. Reasons: deterministic frame cost,
 * chunky voxel aesthetic wants box mitts anyway, viewmodel never leaves ~1.2 m of pose space, and
 * the shotgun off-hand just welds to the moving pump group so it rides the action for free.
 */
function glove(parent, ax, ay, az, kind, mirror) {
  const g = new THREE.Group();
  g.position.set(ax, ay, az);
  g.rotation.set(kind === 'support' ? -1.35 : -1.15, mirror * 0.22, kind === 'support' ? 0.15 : 0.05);
  box(g, 0.05, 0.03, 0.06, 0, 0, 0, COL.polyDark, { rg: 0.9, mt: 0.05 });            // palm block
  for (let i = 0; i < 3; i++) {                                                       // curled fingers
    box(g, 0.011, 0.011, 0.045, (i - 1) * 0.014 * mirror, -0.014, -0.035 + i * 0.004 * mirror,
      COL.polymer, { rg: 0.95, mt: 0.02 });
  }
  box(g, 0.014, 0.012, 0.032, mirror * -0.024, -0.004, 0.012, COL.polymer);          // thumb nub
  box(g, 0.052, 0.02, 0.02, 0, 0.004, 0.036, COL.tan, { rg: 0.95, mt: 0.03 });       // cuff strap
  parent.add(g);
  return g;
}

/* ------------------------------ glow / heat shader pair ----------------------------------- */

const FxVert = `varying vec3 vN; varying vec3 vW;
void main(){
  vN = normalize(normalMatrix * normal);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vW = wp.xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

// outColor = base*0.2 + accent*uGlow (+ rim), plus slow uHeat black->ember shimmer band.
const FxFrag = `uniform float uGlow; uniform float uHeat; uniform float uT;
uniform vec3 uAccent; uniform vec3 uBase;
varying vec3 vN; varying vec3 vW;
void main(){
  float rim = pow(1.0 - abs(normalize(vN).z), 1.5) * 0.35;
  vec3 col = uBase * 0.2 + uAccent * (uGlow * (0.75 + rim));
  float shim = 0.60 + 0.40 * sin(uT * 22.0 + vW.y * 140.0);
  vec3 ember = mix(vec3(0.02, 0.0, 0.0), vec3(0.85, 0.12, 0.03), clamp(uHeat * shim, 0.0, 1.0));
  col += ember * uHeat;
  gl_FragColor = vec4(col, clamp(uGlow + uHeat, 0.0, 1.0));
}`;

function gunUniforms(id) {
  return {
    uGlow: { value: 0 },   // capacitor pop: spiked to 1 on fire, exp-decay tau = rechargeDur/3.
    uHeat: { value: 0 },   // slower slot, tau 0.6 s — red-black barrel shimmer tint.
    uT: { value: 0 },      // shimmer clock.
    uAccent: { value: new THREE.Color(GLOW_ACCENT[id]) },
    uBase: { value: new THREE.Color(COL.polyDark) },
  };
}
function fxMat(u) {
  return new THREE.ShaderMaterial({
    uniforms: u, vertexShader: FxVert, fragmentShader: FxFrag,
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
  });
}

/* ---------------------------------- flash + reticle --------------------------------------- */

function makeFlash() {
  const grp = new THREE.Group();
  const mk = () => new THREE.Mesh(
    new THREE.PlaneGeometry(0.14, 0.14),
    new THREE.MeshBasicMaterial({
      color: COL.flash, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    })
  );
  const a = mk(), b = mk();
  b.rotation.z = Math.PI / 2;               // crossed planes = volumetric pop from any angle
  grp.add(a); grp.add(b);
  const light = new THREE.PointLight(COL.flash, 0, 6); // intensity 2.4 spike decays over 80 ms
  grp.add(light);
  grp.visible = false;
  return { grp, mats: [a.material, b.material], light };
}

/** Procedural circle+mildot scope hint drawn onto a tiny canvas. No fetches anywhere. */
function reticleTexture() {
  try {
    if (typeof document === 'undefined') return null;
    const cv = document.createElement('canvas');
    cv.width = cv.height = 64;
    const g = cv.getContext('2d');
    if (!g) return null;
    g.clearRect(0, 0, 64, 64);
    g.strokeStyle = 'rgba(136,255,204,0.55)';
    g.lineWidth = 2;
    g.beginPath(); g.arc(32, 32, 22, 0, Math.PI * 2); g.stroke();     // main circle
    g.fillStyle = 'rgba(136,255,204,0.65)';
    [[32, 18], [32, 46], [18, 32], [46, 32]].forEach(([x, y]) => {    // cardinal mildots
      g.beginPath(); g.arc(x, y, 1.6, 0, Math.PI * 2); g.fill();
    });
    const t = new THREE.CanvasTexture(cv);
    t.minFilter = THREE.LinearFilter;
    t.generateMipmaps = false;
    return t;
  } catch (_e) { return null; } // defensive: headless/offscreen fallback keeps the gun usable
}

/* Builders per silhouette. Each lands its barrel tip EXACTLY at T.muzzle (suite re-checks). */

function buildRifle(b, mg, bolt, _pu, tg, T) {
  box(b, 0.085, 0.11, 0.34, 0, 0.03, -0.22, COL.steel);                       // receiver block
  box(b, 0.075, 0.09, 0.13, 0, -0.005, 0.06, COL.polyDark);                   // stock cheek slab
  box(b, 0.05, 0.10, 0.06, -0.005, -0.075, -0.02, COL.polymer, { rx: 0.35 }); // grippy rake
  for (let i = 0; i < 9; i++) {                                               // angular notched rail
    box(b, 0.07, 0.012, 0.046, 0, 0.088, -0.06 - i * 0.052, i % 2 ? COL.polyDark : COL.steel);
  }
  [0, 2, 4].forEach((i) => box(b, 0.072, 0.006, 0.02, 0, 0.096, -0.06 - i * 0.104, COL.amber)); // accents
  [-1, 1].forEach((s) => [-0.36, -0.44, -0.52].forEach((z) =>
    box(b, 0.006, 0.03, 0.05, s * 0.034, 0.052, z, COL.polyDark)));           // rail-to-barrel ribs
  const bx = T.muzzle[0], by = T.muzzle[1];
  const len = Math.abs(T.muzzle[2] - BREACH_Z.rifle);
  cylZ(b, 0.016, len, bx, by, (T.muzzle[2] + BREACH_Z.rifle) / 2, COL.blued); // exposed barrel
  brakeRings(b, 0.026, bx, by, T.muzzle[2], 2, 0.008, 0.016);                 // twin brake rings
  cylZ(b, 0.02, 0.012, bx, by, T.muzzle[2] + 0.006, COL.brake);               // crown
  box(b, 0.004, 0.03, 0.05, 0.043, 0.05, -0.16, COL.amber);                   // port accent plate
  box(mg, 0.05, 0.11, 0.09, 0, -0.095, -0.205, COL.polymer, { rx: 0.12 });    // curved mag upper
  box(mg, 0.05, 0.09, 0.082, 0, -0.185, -0.170, COL.polymer, { rx: 0.42 });   // curved mag lower
  box(bolt, 0.045, 0.05, 0.03, -0.045, 0.075, BOLT_HOME.rifle, COL.polymer);  // charging block
  box(bolt, 0.02, 0.012, 0.05, -0.062, 0.075, BOLT_HOME.rifle + 0.02, COL.steel);
  box(tg, 0.008, 0.03, 0.008, 0, -0.02, TRIGGER_Z.rifle, COL.amber);          // amber blade
  box(tg, 0.03, 0.006, 0.05, 0, -0.045, TRIGGER_Z.rifle, COL.polyDark);       // guard bar
}

function buildSmg(b, mg, bolt, _pu, tg, T) {
  box(b, 0.075, 0.095, 0.26, 0, 0.01, -0.145, COL.tan);                       // compact tan body
  box(b, 0.07, 0.09, 0.12, 0, -0.045, -0.10, COL.polymer);                    // polymer housing
  box(b, 0.045, 0.095, 0.055, 0, -0.11, -0.045, COL.polymer, { rx: 0.30 });   // grip
  for (let i = 0; i < 5; i++) {
    box(b, 0.06, 0.010, 0.04, 0, 0.062, -0.03 - i * 0.05, i % 2 ? COL.polymer : COL.steel);
  }
  box(b, 0.012, 0.02, 0.12, 0, 0.02, 0.08, COL.steel);                        // folding stock bar
  box(b, 0.05, 0.07, 0.02, 0, -0.005, 0.145, COL.polymer);                    // stock pad
  const by = T.muzzle[1];
  const len = Math.abs(T.muzzle[2] - BREACH_Z.smg);
  cylZ(b, 0.037, len, 0, by, (T.muzzle[2] + BREACH_Z.smg) / 2, COL.polyDark); // fat suppressor shroud
  brakeRings(b, 0.028, 0, by, T.muzzle[2], 1, 0.010, 0.014, COL.amber);       // single amber ring ID
  cylZ(b, 0.026, 0.010, 0, by, T.muzzle[2] + 0.005, COL.brake);
  box(b, 0.03, 0.06, 0.04, 0, -0.055, -0.305, COL.polymer);                   // front hook grip
  box(mg, 0.045, 0.15, 0.068, 0, -0.155, -0.155, COL.polymer);                // straight stick mag
  box(bolt, 0.028, 0.012, 0.07, -0.052, 0.05, BOLT_HOME.smg, COL.steel);      // left charging lever
  box(bolt, 0.02, 0.014, 0.03, -0.052, 0.05, BOLT_HOME.smg + 0.045, COL.amber);
  box(tg, 0.008, 0.026, 0.008, 0, -0.018, TRIGGER_Z.smg, COL.amber);
  box(tg, 0.028, 0.006, 0.045, 0, -0.04, TRIGGER_Z.smg, COL.polymer);
}

function buildShotgun(b, mg, bolt, pump, tg, T) {
  box(b, 0.065, 0.10, 0.16, 0, -0.01, 0.10, COL.walnut);                      // warm walnut stock
  box(b, 0.058, 0.09, 0.02, 0, -0.015, 0.19, COL.polymer);                    // butt pad
  box(b, 0.08, 0.095, 0.10, 0, 0.02, -0.07, COL.blued);                       // compact blued receiver
  for (let r = 0; r < 2; r++) {                                               // DOUBLE shell carrier
    for (let i = 0; i < 3; i++) {
      const z = -0.045 - i * 0.04, y = r ? 0.002 : 0.034;
      cylZ(b, 0.011, 0.028, -0.048, y, z, COL.shellRed, { seg: 8 });          // hull
      cylZ(b, 0.0118, 0.006, -0.048, y, z + 0.016, COL.brass, { seg: 8 });    // brass base
    }
  }
  box(b, 0.03, 0.06, 0.06, 0, 0.045, -0.125, COL.blued);                      // barrel/tube standoff
  const by = T.muzzle[1];
  const blen = Math.abs(T.muzzle[2] - BREACH_Z.shotgun);
  cylZ(b, 0.019, blen, 0, by, (T.muzzle[2] + BREACH_Z.shotgun) / 2, COL.blued);         // long tube
  cylZ(b, 0.014, 0.34, 0, 0.018, -0.29, COL.brake);                                     // mag tube under
  cylZ(b, 0.017, 0.02, 0, 0.018, -0.465, COL.walnut);                                   // tube end cap
  box(b, 0.008, 0.008, 0.008, 0, by + 0.026, T.muzzle[2] + 0.01, COL.amber);            // bead sight
  brakeRings(b, 0.023, 0, by, T.muzzle[2], 1, 0.008, 0.012);                            // nose ring
  // mag group idle-hidden in shotguns (tube gun) but still exists for hierarchy completeness
  box(mg, 0.001, 0.001, 0.001, 0, -0.5, -0.5, COL.brake);
  box(bolt, 0.05, 0.055, 0.05, 0, 0.02, BOLT_HOME.shotgun, COL.steel);                  // breech block
  // pump forend lives in its own group; slides +z on cycle; supports the welded off-hand glove
  box(pump, 0.062, 0.05, 0.13, 0, 0, 0, COL.walnut);
  [-0.03, 0, 0.03].forEach((dz) => box(pump, 0.064, 0.006, 0.012, 0, 0.028, dz, COL.fluteDark));
  cylZ(pump, 0.040, 0.012, 0, 0, -0.062, COL.brass, { seg: 10 });                       // brass nose band
  pump.position.copy(PUMP_REST);
  box(tg, 0.009, 0.03, 0.009, 0, -0.018, TRIGGER_Z.shotgun, COL.amber);
  box(tg, 0.03, 0.006, 0.05, 0, -0.042, TRIGGER_Z.shotgun, COL.polyDark);
}

function buildSniper(b, mg, bolt, _pu, tg, T, extra) {
  box(b, 0.075, 0.105, 0.44, 0, 0.02, -0.18, COL.cerakote);                   // greenCerakote chassis
  box(b, 0.06, 0.03, 0.10, 0, 0.085, 0.02, COL.greenSteel);                   // cheek riser
  box(b, 0.05, 0.05, 0.10, 0, -0.03, -0.36, COL.cerakote);                    // benchrest foregrip
  for (let i = 0; i < 10; i++) {
    box(b, 0.062, 0.010, 0.036, 0, 0.080, -0.02 - i * 0.045, i % 2 ? COL.polyDark : COL.greenSteel);
  }
  const by = T.muzzle[1];
  const blen = Math.abs(T.muzzle[2] - BREACH_Z.sniper);
  cylZ(b, 0.020, blen, 0, by, (T.muzzle[2] + BREACH_Z.sniper) / 2, COL.greenSteel); // long pipe
  for (let k = 0; k < 4; k++) {                                               // FLUTING: 4 long ridges
    const a = (45 + k * 90) * D2R, r = 0.0235;
    box(b, 0.007, 0.007, 0.34, Math.cos(a) * r, by + Math.sin(a) * r, -0.47, COL.fluteDark);
  }
  brakeRings(b, 0.028, 0, by, T.muzzle[2], 2, 0.010, 0.016);                  // flanker brake rings
  cylZ(b, 0.023, 0.012, 0, by, T.muzzle[2] + 0.006, COL.brake);
  // BIG scope: ring posts, main tube, objective bell, ocular, glass + procedural reticle
  [-0.245, -0.375].forEach((z) => box(b, 0.014, 0.10, 0.022, 0, 0.132, z, COL.polyDark));
  cylZ(b, 0.028, 0.26, 0, 0.205, -0.30, COL.polyDark);                        // main tube
  cylZ(b, 0.028, 0.07, 0, 0.205, -0.475, COL.polyDark, { rTop: 0.028, rBot: 0.044 }); // objective bell
  cylZ(b, 0.032, 0.05, 0, 0.205, -0.135, COL.polymer);                        // ocular
  const glass = new THREE.Mesh(
    new THREE.CircleGeometry(0.041, 16),
    new THREE.MeshBasicMaterial({ color: 0x88ffcc, transparent: true, opacity: 0.12, blending: THREE.AdditiveBlending, depthWrite: false })
  );
  glass.position.set(0, 0.205, -0.507); b.add(glass);                         // faint front glass
  const tex = reticleTexture();                                               // circle + mildot hint
  const ret = new THREE.Mesh(
    new THREE.PlaneGeometry(0.052, 0.052),
    tex
      ? new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false })
      : new THREE.MeshBasicMaterial({ color: 0x88ffcc, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false }) // canvas-less fallback
  );
  ret.position.set(0, 0.205, -0.500); b.add(ret);                             // inside the housing
  [-1, 1].forEach((s) => box(b, 0.010, 0.10, 0.016, s * 0.022, by - 0.075, -0.40, COL.fluteDark, { rx: 1.35 })); // folded bipod
  box(mg, 0.04, 0.09, 0.075, 0, -0.075, -0.235, COL.cerakote);                // box mag
  for (let i = 0; i < 3; i++) {                                               // stripper clip rounds
    const cart = box(extra, 0.012, 0.012, 0.05, 0, 0.115 + i * 0.016, -0.235, COL.brass);
    cart.visible = false; extra.userData.cartridges.push(cart);
  }
  (() => { const g = new THREE.CylinderGeometry(0.008, 0.008, 0.095, 8); g.rotateZ(Math.PI / 2);
    const m = new THREE.Mesh(g, mat(COL.steel)); m.position.set(-0.075, 0.105, BOLT_HOME.sniper);
    bolt.add(m); })();
  box(bolt, 0.026, 0.026, 0.026, -0.128, 0.105, BOLT_HOME.sniper, COL.steel); // rotary knob mass
  box(tg, 0.008, 0.03, 0.008, 0, -0.02, TRIGGER_Z.sniper, COL.amber);
  box(tg, 0.03, 0.006, 0.05, 0, -0.045, TRIGGER_Z.sniper, COL.polyDark);
}

function buildLmg(b, mg, bolt, _pu, tg, T, extra) {
  box(b, 0.11, 0.135, 0.39, 0, 0.025, -0.205, COL.parkerized);                  // broad receiver
  box(b, 0.09, 0.105, 0.20, 0, -0.005, 0.075, COL.olive);                      // full shoulder stock
  box(b, 0.07, 0.095, 0.045, 0, -0.005, 0.185, COL.polymer);                   // rubber butt pad
  box(b, 0.055, 0.105, 0.065, 0.005, -0.085, -0.045, COL.polymer, { rx: 0.30 }); // grip
  box(b, 0.105, 0.055, 0.27, 0, 0.015, -0.40, COL.olive);                      // heavy heat shield
  for (let i = 0; i < 5; i++) {
    [-1, 1].forEach((s) => box(b, 0.012, 0.018, 0.045, s * 0.050, 0.018, -0.30 - i * 0.050,
      COL.fluteDark));                                                           // vented shield ribs
  }

  const bx = T.muzzle[0], by = T.muzzle[1];
  const len = Math.abs(T.muzzle[2] - BREACH_Z.lmg);
  cylZ(b, 0.027, len, bx, by, (T.muzzle[2] + BREACH_Z.lmg) / 2, COL.gunmetal, { seg: 12 });
  cylZ(b, 0.036, 0.055, bx, by, T.muzzle[2] + 0.045, COL.parkerized, { seg: 12 }); // gas block
  brakeRings(b, 0.039, bx, by, T.muzzle[2], 2, 0.009, 0.015);
  cylZ(b, 0.029, 0.012, bx, by, T.muzzle[2] + 0.006, COL.brake);
  box(b, 0.006, 0.038, 0.020, bx, by + 0.032, T.muzzle[2] + 0.035, COL.amber);    // tall front blade

  // Carry handle: raised bridge and angled legs make the silhouette unmistakably crew-served.
  box(b, 0.018, 0.105, 0.024, -0.040, 0.135, -0.31, COL.polyDark, { rz: -0.42 });
  box(b, 0.018, 0.105, 0.024, 0.040, 0.135, -0.31, COL.polyDark, { rz: 0.42 });
  box(b, 0.095, 0.022, 0.14, 0, 0.186, -0.31, COL.polymer);
  box(b, 0.078, 0.010, 0.11, 0, 0.198, -0.31, COL.tan);

  // Detachable belt box and visible brass feed run.
  box(mg, 0.13, 0.15, 0.18, -0.038, -0.125, -0.18, COL.olive);
  box(mg, 0.134, 0.018, 0.184, -0.038, -0.050, -0.18, COL.polyDark);
  [-0.095, -0.050, -0.005].forEach((x, i) => {
    cylZ(b, 0.010, 0.045, x, 0.075 - i * 0.010, -0.205, COL.brass, { seg: 8 });
    box(b, 0.021, 0.006, 0.050, x, 0.071 - i * 0.010, -0.205, COL.polyDark);
  });

  const cover = new THREE.Group();
  cover.name = 'belt_cover';
  box(cover, 0.112, 0.022, 0.28, 0, 0.103, -0.24, COL.gunmetal);
  box(cover, 0.070, 0.010, 0.18, 0, 0.118, -0.24, COL.amber);
  extra.add(cover);
  extra.userData.reloadPart = cover;

  box(bolt, 0.052, 0.035, 0.075, -0.055, 0.080, BOLT_HOME.lmg, COL.gunmetal);
  box(bolt, 0.025, 0.018, 0.052, -0.082, 0.082, BOLT_HOME.lmg + 0.025, COL.amber);
  box(tg, 0.010, 0.032, 0.010, 0, -0.020, TRIGGER_Z.lmg, COL.amber);
  box(tg, 0.036, 0.007, 0.055, 0, -0.048, TRIGGER_Z.lmg, COL.polyDark);
}

function buildRevolver(b, mg, bolt, _pu, tg, T, extra) {
  box(b, 0.066, 0.100, 0.20, 0, 0.020, -0.105, COL.gunmetal);                  // compact solid frame
  box(b, 0.054, 0.125, 0.070, 0, -0.080, -0.005, COL.walnut, { rx: 0.34 });    // compact grip
  box(b, 0.059, 0.016, 0.065, 0, -0.025, -0.015, COL.brass);                   // grip heel/backstrap
  box(b, 0.072, 0.025, 0.20, 0, -0.005, -0.275, COL.gunmetal);                // full underlug

  const bx = T.muzzle[0], by = T.muzzle[1];
  const len = Math.abs(T.muzzle[2] - BREACH_Z.revolver);
  cylZ(b, 0.017, len, bx, by, (T.muzzle[2] + BREACH_Z.revolver) / 2, COL.blued, { seg: 12 });
  box(b, 0.050, 0.018, len * 0.72, bx, by + 0.022, -0.34, COL.gunmetal);         // long sight rib
  brakeRings(b, 0.022, bx, by, T.muzzle[2], 1, 0.008, 0.012, COL.gunmetal);
  cylZ(b, 0.018, 0.010, bx, by, T.muzzle[2] + 0.005, COL.brake);
  box(b, 0.007, 0.024, 0.014, bx, by + 0.025, T.muzzle[2] + 0.028, COL.amber);  // front ramp

  // Swing-out six-shot cylinder lives in the mag group so reload and firing can rotate it.
  cylZ(mg, 0.050, 0.078, 0, 0.025, -0.145, COL.gunmetal, { seg: 12 });
  for (let i = 0; i < 6; i++) {
    const a = i * Math.PI / 3;
    cylZ(mg, 0.011, 0.081, Math.cos(a) * 0.031, 0.025 + Math.sin(a) * 0.031,
      -0.146, COL.fluteDark, { seg: 8 });
  }
  box(mg, 0.020, 0.020, 0.092, 0, 0.025, -0.144, COL.brass);                   // axle/ejector star
  box(b, 0.014, 0.020, 0.10, -0.055, 0.010, -0.13, COL.gunmetal);              // exposed crane

  // Cocking hammer is deliberately prominent; the bolt group drives its fire stroke.
  box(bolt, 0.042, 0.055, 0.022, 0, 0.092, BOLT_HOME.revolver, COL.gunmetal, { rx: -0.36 });
  box(bolt, 0.050, 0.012, 0.025, 0, 0.122, BOLT_HOME.revolver + 0.012, COL.brass);
  box(tg, 0.009, 0.032, 0.009, 0, -0.010, TRIGGER_Z.revolver, COL.brass, { rx: 0.20 });
  box(tg, 0.040, 0.007, 0.060, 0, -0.042, TRIGGER_Z.revolver, COL.gunmetal);

  const loader = new THREE.Group();
  loader.name = 'speedloader';
  for (let i = 0; i < 6; i++) {
    const a = i * Math.PI / 3;
    cylZ(loader, 0.007, 0.045, Math.cos(a) * 0.024, Math.sin(a) * 0.024, 0, COL.brass, { seg: 8 });
  }
  cylZ(loader, 0.010, 0.020, 0, 0, 0.025, COL.polymer, { seg: 10 });
  loader.position.set(-0.10, 0.04, -0.145);
  loader.userData.homePosition = loader.position.clone();
  loader.visible = false;
  extra.add(loader);
  extra.userData.reloadRounds = loader;
}

const BUILDERS = {
  rifle: buildRifle, smg: buildSmg, shotgun: buildShotgun,
  sniper: buildSniper, lmg: buildLmg, revolver: buildRevolver,
};

/** Shared post-build: hierarchy wiring, muzzle marker, overlays, hands weld, cache entry. */
function buildGun(id) {
  const T = timerFor(id), H = HANDS[id];
  const root = new THREE.Group(); root.name = 'gun_' + id;
  const uni = gunUniforms(id);
  const body = new THREE.Group(); body.name = 'body';
  const magG = new THREE.Group(); magG.name = 'mag';
  const bolt = new THREE.Group(); bolt.name = 'bolt';
  const triggerGroup = new THREE.Group(); triggerGroup.name = 'triggerGroup';
  const pump = id === 'shotgun' ? new THREE.Group() : null;
  if (pump) pump.name = 'pump';
  const extra = new THREE.Group(); extra.userData.cartridges = [];
  BUILDERS[id](body, magG, bolt, pump, triggerGroup, T, extra);

  const muzzleMarker = new THREE.Object3D();                       // live truth for FX tracers
  muzzleMarker.name = 'muzzle';
  muzzleMarker.position.set(T.muzzle[0], T.muzzle[1], T.muzzle[2]);
  body.add(muzzleMarker);

  const flash = makeFlash();                                       // billboard cross + burst light
  flash.grp.position.copy(muzzleMarker.position).add(new THREE.Vector3(0, 0, -0.01));
  body.add(flash.grp);

  const glow = fxMat(uni);                                         // BOTH overlays share `uni`
  const capZ = BOLT_HOME[id];
  const capGeo = new THREE.BoxGeometry(0.05, 0.05, 0.012);
  const cap = new THREE.Mesh(capGeo, glow);
  cap.position.set(-0.02, 0.07, capZ + 0.052);                     // proud of the bolt rear face
  bolt.add(cap);

  const span = (T.heatLen[1] - T.heatLen[0]) * T.barrelLen;        // fraction-window along barrel
  const startZ = BREACH_Z[id] - T.heatLen[0] * T.barrelLen;
  const heatGeo = new THREE.CylinderGeometry(BARREL_R[id], BARREL_R[id], span, 10, 1, true);
  heatGeo.rotateX(Math.PI / 2);
  const heat = new THREE.Mesh(heatGeo, glow);
  heat.position.set(T.muzzle[0], T.muzzle[1], startZ - span / 2);  // open-ended sleeve, z-fight safe
  body.add(heat);

  const rightHand = glove(body, H.grip.x - 0.005, H.grip.y - 0.01, H.grip.z, 'grip', 1);
  rightHand.name = 'hand_r';
  if (H.support) {
    const target = H.support.on === 'pump' && pump ? pump : body;
    const lx = H.support.x - (target === pump ? PUMP_REST.x : 0);
    const ly = H.support.y - (target === pump ? PUMP_REST.y : 0);
    const lz = H.support.z - (target === pump ? PUMP_REST.z : 0);
    const lh = glove(target, lx, ly, lz, 'support', -1);
    lh.name = 'hand_l';
  }

  root.add(body); root.add(magG); root.add(bolt); root.add(triggerGroup); root.add(extra);
  if (pump) root.add(pump);
  return {
    root, body, mag: magG, bolt, pump, triggerGroup, extra, muzzleMarker, flash, uni,
    T, magazines: magG.children.length,
    conditionPhase: (id.charCodeAt(0) * 0.017 + id.charCodeAt(id.length - 1) * 0.031) % (Math.PI * 2),
    pivotCam: new THREE.Vector3(HIP.x + H.grip.x, HIP.y + H.grip.y, HIP.z + H.grip.z),
  };
}

/* ======================================= THE RIG =========================================== */

export class ViewmodelRig {

  /** Parented to the MAIN camera at (0,0,0). Builds nothing until setWeapon(). */
  constructor(camera) {
    this.camera = camera;
    this.root = new THREE.Group(); root0(this.root);
    this.posG = new THREE.Group();                                 // dynamic translation layer
    this.pivot = new THREE.Group();                                // static pos + dynamic ROTATION
    this.comp = new THREE.Group();                                 // cancels pivot -> rotation about grip
    this.content = new THREE.Group();                              // animated base pose (hip<->ADS)
    camera.add(this.root);
    this.root.add(this.posG); this.posG.add(this.pivot);
    this.pivot.add(this.comp); this.comp.add(this.content);

    this._disposed = false;
    this._models = {};                 // lazily-built gun cache keyed by weapon id
    this._sharedMaterials = new Set();
    this._cur = null;                  // active model bundle
    this._id = null;
    this._now = 0;                     // rig-local clock, advanced only by update()
    this._queue = [];                  // deferred timer-boundary events {at, fn}

    this._spr = { pitch: { p: 0, v: 0 }, yaw: { p: 0, v: 0 }, push: { p: 0, v: 0 } }; // kick springs
    this._sway = { x: 0, y: 0 };       // look-inertia lag (consumed mouse deltas, BOB.swayPxPerUnit px)
    this._phase = 0;                   // walk bob figure-8 phase accumulator
    this._bobVal = 0;                  // public bobAmt readback for HUD/audio glue
    this._yawFlip = 1;                 // alternating yaw kick sign (wobble seeds it)
    this._rngState = 0xB041;           // mulberry-lite seed, reseeded per magazine below

    this._adsTarget = 0; this._adsSmooth = 0; this._fovScale = 1;
    this._depT = 99;                   // deploy timeline cursor (>=1 == settled)
    this._rl = null;                   // reload choreography state
    this._cycle = null;                // pump/bolt staged cycle state
    this._jerk = null;                 // fast non-cycleBack bolt reciprocation
    this._lockUntil = 0;               // rof-referenced fire gate
    this._stallUntil = Infinity;       // anti-wedge: auto-pumps if mode never calls back
    this._flashT = -1; this._lightT = -1;

    // Timing hooks for the effects/UI/audio agents. All optional; invoked strictly at
    // TIMERS boundary crossings so external glue stays decoupled from internals.
    this.onShellEject = null;   // ({pos:[xyz], vel:[xyz], spin:[xyz]}) — world-space toss recipe
    this.onMuzzleFlash = null;  // (posWorld:{x,y,z}, quatWorld) — first-fire-frame world anchor
    this.onBoltClack = null;    // (stepNum: 1|2|3)  — staged mechanical crossing cues
    this.onReloadClick = null;  // (n:int>=1)       — drop/insert/tap or tube thunk counter

    this._tmpV = new THREE.Vector3(); this._tmpQ = new THREE.Quaternion();
  }

  /* ------------------------------------ public API ----------------------------------------- */

  /** Lazily builds `id`, swaps visibility, resets transient motion state, replays equip dip. */
  setWeapon(id) {
    const key = TIMERS[id] ? id : 'rifle';                           // forgiving: bad key stays playable
    if (!this._models[key]) {
      const model = buildGun(key);
      this._models[key] = model;
      model.root.traverse((object) => {
        const objectMaterials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of objectMaterials) {
          if (!MAT_REFS.has(material) || this._sharedMaterials.has(material)) continue;
          this._sharedMaterials.add(material);
          MAT_REFS.set(material, MAT_REFS.get(material) + 1);
        }
      });
    }
    const next = this._models[key];
    this._resetModelPose(next);
    if (this._cur && this._cur !== next) this.content.remove(this._cur.root);
    this._cur = next; this._id = key;
    this.content.add(next.root);
    this.pivot.position.copy(next.pivotCam);
    this.comp.position.copy(next.pivotCam).negate();

    this._spr.pitch = { p: 0, v: 0 }; this._spr.yaw = { p: 0, v: 0 }; this._spr.push = { p: 0, v: 0 };
    this._sway.x = this._sway.y = 0;
    this._queue.length = 0;
    this._cycle = null; this._jerk = null; this._rl = null;
    this._lockUntil = this._now; this._stallUntil = Infinity;
    this._rngState = (0xB041 ^ (key.charCodeAt(0) * 7919)) | 0;      // deterministic-ish per-mag seed
    this._yawFlip = this._rng() < 0.5 ? 1 : -1;
    this._uniSet(1, 0);                                              // fresh draw: glow pop, cold barrel
    this.flashOff(true);
    this._depT = 0;                                                  // replay DEPLOY raise/settle curve
    this._applyBasePose();                                           // snap content pose immediately
  }

  /**
   * One accepted/enqueued shot envelope: spring impulses from WEAPONS canonical viewKick (mirrored
   * into TIMERS by defs.js), glow+heat shader spikes, 60ms billboard flash + 80ms muzzle light,
   * timer-driven choreography enqueues, rof lockout, callback dispatch. Returns false when busy.
   */
  fire() {
    const cur = this._cur; if (!cur) return false;
    const T = cur.T;
    const now = this._now;
    if (this.isBusy(now)) return false;

    const wn = Math.sqrt(T.kick.stiffness);
    const flip = (this._yawFlip = -this._yawFlip);
    const jitter = 0.8 + this._rng() * 0.4;                          // seeded wobble multiplier
    const pr = T.viewKick.pitchDeg * D2R;
    const yr = T.viewKick.yawDeg * D2R * T.kick.yawWobble * jitter * flip;
    this._spr.pitch.v += pr * wn * 0.9;   // velocity-kick scaled by sqrt(k): peak ~= 0.8x input rad
    this._spr.yaw.v += yr * wn * 0.9;
    this._spr.push.v += 0.35 + pr * 1.1;  // meters/sec rearward surge — bigger kicks shove harder

    this._uniSet(1, Math.min(1, cur.uni.uHeat.value + 0.5)); // burst heat accumulator, capped
    this.revealFlash();

    const cycMs = 60000 / T.rof;          // rpm-referenced gate — literally the fire-cap definition
    this._lockUntil = Math.max(this._lockUntil, now + cycMs / 1000);

    if (T.cycleBack) {
      // Mode owns rechambering (rig.pumpAnim()/boltAnim()); deadline prevents a lost event wedging
      // the busy gate forever. The pause document (bursts[0][0]) informs pacing, drives nothing.
      this._stallUntil = now + cycMs / 1000 + 0.15;
    } else {
      this._enqueue(0.010, () => { if (this.onBoltClack) this.onBoltClack(1); }); // rack back
      this._enqueue(0.014, () => { this._startJerk(T.boltTravel, 0.05); });       // snappy reciprocation
      this._enqueue(Math.max(0.030, T.rechargeDur * 0.8), () => {
        if (this.onBoltClack) this.onBoltClack(2);                               // snapped home
      });
      if (T.ejectOnFire) this._enqueue(0.045, () => this._emitShell());          // bolt-clear moment
    }

    if (this.onMuzzleFlash) {
      cur.muzzleMarker.updateWorldMatrix(true, false);
      cur.muzzleMarker.getWorldPosition(this._tmpV);
      cur.muzzleMarker.getWorldQuaternion(this._tmpQ);
      this.onMuzzleFlash(this._tmpV.clone(), this._tmpQ.clone());
    }
    return true;
  }

  /** External button-hold ramp reaches us pre-normalized (0..1); we ease-polish + expose readback. */
  ads(t01) {
    this._adsTarget = Math.max(0, Math.min(1, Number(t01) || 0));
  }

  /** Magazine, belt box, tube, stripper, or cylinder reload choreography. */
  reload(dur, type) {
    if (!this._cur || !(dur > 0)) return;
    const profileType = this._cur.T.magTimeline.type || 'mag';
    const eff = !type || type === 'magswap' ? profileType : type;
    this._rl = { t0: this._now, dur, type: eff, clicks: 0, thunks: 0, lastFrac: 0, done: false };
  }

  /** Manual staged cycles (mode-driven). Ignored when cycling already or gun lacks the linkage. */
  pumpAnim() { this._beginCycle('pump'); }
  boltAnim() { this._beginCycle('bolt'); }

  isBusy(now) { return (now ?? this._now) < this._lockUntil || !!this._cycle; }

  get bobAmt() { return this._bobVal; }              // 0..~1 normalized walk-bob magnitude
  get currentAdsT01() { return this._adsSmooth; }    // HUD scope-opacity readback

  /** Live muzzle world position (uses the actual Object3D — correct through every nested shift). */
  getMuzzleWorldPos(out) {
    const o = out || new THREE.Vector3();
    if (!this._cur) return o.set(0, 0, 0);
    this._cur.muzzleMarker.getWorldPosition(o);
    return o;
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.camera.remove(this.root);

    const geometries = new Set();
    const materials = new Set();
    const textures = new Set();
    const collectMaterial = (material) => {
      if (!material || materials.has(material)) return;
      materials.add(material);
      for (const value of Object.values(material)) {
        if (value?.isTexture) textures.add(value);
      }
      for (const uniform of Object.values(material.uniforms || {})) {
        const value = uniform?.value;
        if (value?.isTexture) textures.add(value);
        else if (Array.isArray(value)) {
          for (const item of value) if (item?.isTexture) textures.add(item);
        }
      }
    };

    const models = Object.values(this._models);
    for (const model of models) {
      model.root.traverse((object) => {
        if (object.geometry) geometries.add(object.geometry);
        if (Array.isArray(object.material)) {
          for (const material of object.material) collectMaterial(material);
        } else {
          collectMaterial(object.material);
        }
      });
    }
    // Cached materials are reference-counted across rigs; only this rig's unique resources
    // can be released before the final shared owner goes away.

    for (const geometry of geometries) geometry.dispose();
    for (const texture of textures) texture.dispose();
    for (const material of materials) {
      if (!MAT_REFS.has(material)) material.dispose();
    }

    for (const model of models) {
      model.root.removeFromParent();
      model.root.clear();
    }
    this.content.clear();
    this.root.clear();
    this._queue.length = 0;
    this._cycle = null;
    this._jerk = null;
    this._rl = null;
    this._models = {};
    this._cur = null;
    this._id = null;
    for (const material of this._sharedMaterials) {
      const refs = MAT_REFS.get(material);
      if (refs > 1) {
        MAT_REFS.set(material, refs - 1);
        continue;
      }
      MATS.delete(MAT_KEYS.get(material));
      MAT_REFS.delete(material);
      MAT_KEYS.delete(material);
      material.dispose();
    }
    this._sharedMaterials.clear();
  }

  /* ------------------------------------- simulation ---------------------------------------- */

  /**
   * @param dt      seconds, clamped hard to 0.033 (tab-refocus spikes never explode springs)
   * @param ctx     {speed, grounded, mouseDX, mouseDY, isSprinting, crouch, panic, exhaustion}
   *                Mouse deltas move only this gun rig; camera aim remains caller-authoritative.
   */
  update(dt, ctx = {}) {
    if (!(dt > 0)) return;
    dt = Math.min(dt, 0.033);
    const cur = this._cur;
    const speed = ctx.speed || 0, grounded = ctx.grounded !== false;
    const sprinting = !!ctx.isSprinting, crouching = !!ctx.crouch;
    this._now += dt;
    this._drainQueue();

    /* fov counter-scale trick — apparent size locked while WEAPONS.adsFov zooms the real camera */
    const live = (this.camera && this.camera.fov) || VM_FOV_BASE;
    const target = Math.tan((VM_FOV_BASE / 2) * D2R) / Math.tan((live / 2) * D2R);
    this._fovScale += (Math.max(0.75, Math.min(3.2, target)) - this._fovScale) * Math.min(1, dt * 18);
    this.root.scale.setScalar(this._fovScale);

    if (!cur) { this._decayFx(dt, null); return; }
    const T = cur.T;

    /* springs: semi-implicit Euler, 4 equal substeps (h <= 8.25ms, omega^2*h safe for k<=300) */
    const K = T.kick.stiffness, C = T.kick.damping;
    const h = dt / 4;
    for (let i = 0; i < 4; i++) {
      this._spring(this._spr.pitch, K, C, h);
      this._spring(this._spr.yaw, K, C, h);
      this._spring(this._spr.push, K * 1.2, C * 1.4, h);            // stiffer shove settles faster
    }

    /*
     * Turn inertia is an impulse with exact exponential decay: integrated mouse travel produces
     * the same deterministic gun-only lag, while weapon mass scales amplitude and settling time.
     */
    const gain = BOB.swayPxPerUnit;
    const weightRatio = Math.max(0.25, Math.min(3, (Number(T.weightKg) || 3.4) / 3.4));
    const turnAmplitude = 0.72 + weightRatio * 0.32;
    const settleRate = 12 / (0.45 + weightRatio * 0.55);
    const turnImpulse = 0.12 * turnAmplitude;
    const turnDecay = Math.exp(-settleRate * dt);
    this._sway.x = (this._sway.x - (Number(ctx.mouseDX) || 0) / gain * turnImpulse) * turnDecay;
    this._sway.y = (this._sway.y + (Number(ctx.mouseDY) || 0) / gain * turnImpulse) * turnDecay;
    this._sway.x = Math.max(-BOB.swayClamp, Math.min(BOB.swayClamp, this._sway.x));
    this._sway.y = Math.max(-BOB.swayClamp, Math.min(BOB.swayClamp, this._sway.y));

    /* walk bob figure-8 (freq scales with speed; sprint lifts freq+amp+cant; crouch dampens) */
    const spdN = Math.min(1, speed / 4.4);                            // normalized to contract walk
    let ampMul = (sprinting ? BOB.sprintAmpMul : 1) * (grounded ? 1 : BOB.airDampen);
    if (crouching) ampMul *= BOB.crouchDampen;
    const freq = sprinting ? BOB.sprintFreq : BOB.walkFreq;
    this._phase += dt * freq * Math.max(spdN, sprinting ? 1 : spdN) ;
    const bp = this._phase * Math.PI * 2;
    const bobX = Math.sin(bp * 0.5) * BOB.walkHorz * ampMul * spdN;   // figure-8: lazy infinity loop
    const bobY = Math.cos(bp) * BOB.walkVert * ampMul * spdN * (sprinting ? 1 : 0.8);
    this._bobVal = Math.min(1, Math.abs(bobY) / (BOB.walkVert * BOB.sprintAmpMul) +
                                Math.abs(bobX) / (BOB.walkHorz * BOB.sprintAmpMul));

    /* ADS polish: approach rate inverted from canonical adsTime, smoothstep the eased value */
    const rate = 2.2 / Math.max(0.05, T.adsTime);
    this._adsSmooth += (this._adsTarget - this._adsSmooth) * Math.min(1, rate * dt);
    const adsE = this._smooth01(this._adsSmooth);

    /* deploy timeline: rise over DEPLOY.raise slice, spring overshoot, quenched by settleBy */
    this._depT = Math.min(1.0001, this._depT + dt / Math.max(0.05, T.deployTime));

    /* Baseline idle life plus hidden condition motion. Both are deterministic rig-clock functions. */
    const panic = Math.max(0, Math.min(1, Number(ctx.panic) || 0));
    const exhaustion = Math.max(0, Math.min(1, Number(ctx.exhaustion) || 0));
    const condDamp = 1 - adsE * 0.35;
    const phase = cur.conditionPhase;
    const breathe = Math.sin(this._now * BOB.idleFreq * Math.PI * 2) * BOB.idleAmp * (1 - adsE * 0.6);
    const exhaustedBreath = Math.sin(this._now * (3.2 + exhaustion * 0.9) + phase) *
      BOB.idleAmp * 1.8 * exhaustion * condDamp;
    const tremorX = (Math.sin(this._now * 41 + phase) * 0.00045 +
      Math.sin(this._now * 67 + phase * 1.7) * 0.00025) * panic * condDamp;
    const tremorY = (Math.sin(this._now * 47 + phase * 0.7) * 0.00040 +
      Math.sin(this._now * 73 + phase * 1.3) * 0.00020) * panic * condDamp;
    const conditionPitch = (Math.sin(this._now * 13 + phase) * 0.0015 * panic +
      Math.sin(this._now * 3.4 + phase) * 0.0030 * exhaustion) * condDamp;
    const conditionYaw = Math.sin(this._now * 19 + phase * 0.8) * 0.0012 * panic * condDamp;

    /* ---------- choreography states ---------- */
    let reloadDip = 0, reloadRock = 0;
    if (this._rl) { const r = this._updateReload(T); reloadDip = r.dip; reloadRock = r.rock; }
    if (this._jerk) this._stepJerk(dt);
    if (this._cycle) this._stepCycle(cur, dt);

    /* sprint cant + counter-roll composition */
    const cant = sprinting ? BOB.sprintTiltZ * Math.min(1, speed / 6.2) * (1 - adsE) : 0;
    const roll = bobX / (BOB.walkHorz || 1) * BOB.counterRoll * (1 - adsE * 0.5);

    /* ---------- compose transforms (condition offsets never touch the authoritative camera) ---------- */
    this.posG.position.set(
      this._sway.x * 0.35 + bobX + tremorX,
      this._sway.y * 0.35 + bobY + breathe + exhaustedBreath + tremorY,
      this._spr.push.p
    );
    this.pivot.rotation.set(
      this._spr.pitch.p + this._sway.y * 0.6 + conditionPitch,
      this._spr.yaw.p + this._sway.x * 0.6 + conditionYaw,
      roll + cant
    );

    /* base hip pose eased toward adsOffset absolute pose; dips layered on top */
    const dep = this._deployOffset();
    this.content.position.set(
      HIP.x + (T.adsOffset.x - HIP.x) * adsE,
      HIP.y + (T.adsOffset.y - HIP.y) * adsE + reloadDip + dep.y,
      HIP.z + (T.adsOffset.z - HIP.z) * adsE
    );
    this.content.rotation.set(dep.rx + reloadRock, 0, 0);

    /* shader slot decays: fast capacitor pop, slower ember heat (tau 0.6s per spec) */
    this._decayFx(dt, cur);

    /* anti-stall catch-up: keeps the busy gate honest even if a server event got dropped */
    if (T.cycleBack && !this._cycle && this._now > this._stallUntil) {
      this._stallUntil = Infinity;
      this._beginCycle(T.cycleKind || 'bolt', true);
    }
  }

  /* ----------------------------------- private internals ----------------------------------- */

  _resetReloadPose(model) {
    if (!model) return;
    model.mag.position.set(0, 0, 0);
    model.mag.rotation.x = 0;
    model.mag.rotation.y = 0;
    const cover = model.extra.userData.reloadPart;
    if (cover) cover.rotation.set(0, 0, 0);
    const rounds = model.extra.userData.reloadRounds;
    if (rounds) {
      rounds.visible = false;
      if (rounds.userData.homePosition) rounds.position.copy(rounds.userData.homePosition);
    }
    model.extra.userData.cartridges.forEach((cartridge, i) => {
      cartridge.visible = false;
      cartridge.position.y = 0.115 + i * 0.016;
    });
  }

  _resetModelPose(model) {
    this._resetReloadPose(model);
    model.mag.rotation.z = 0;
    model.bolt.position.set(0, 0, 0);
    model.bolt.rotation.set(0, 0, 0);
    model.triggerGroup.rotation.set(0, 0, 0);
    if (model.pump) model.pump.position.copy(PUMP_REST);
  }

  _rng() {                                                             // mulberry-lite, seeded per mag
    this._rngState = (this._rngState + 0x6D2B79F5) | 0;
    let t = this._rngState;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  _spring(s, k, c, h) {
    s.v += (-k * s.p - c * s.v) * h;
    s.p += s.v * h;
  }

  _smooth01(t) { return t * t * (3 - 2 * t); }

  _enqueue(delayS, fn) { this._queue.push({ at: this._now + delayS, fn }); }
  _drainQueue() {
    if (!this._queue.length) return;
    this._queue.sort((a, b) => a.at - b.at);
    const keep = [];
    for (const e of this._queue) (e.at <= this._now) ? e.fn() : keep.push(e);
    this._queue = keep;
  }

  _uniSet(glow, heat) {
    if (!this._cur) return;
    this._cur.uni.uGlow.value = glow; this._cur.uni.uHeat.value = heat;
  }

  _decayFx(dt, cur) {
    if (!cur) return;
    const u = cur.uni;
    const tauG = Math.max(0.004, cur.T.rechargeDur / 3);
    u.uGlow.value *= Math.exp(-dt / tauG);
    u.uHeat.value *= Math.exp(-dt / 0.6);
    u.uT.value = this._now;
    if (this._flashT >= 0) {
      this._flashT -= dt;
      const k = Math.max(0, this._flashT / 0.06);                      // linear 60ms fade
      for (const m of cur.flash.mats) m.opacity = k;
      if (this._flashT < 0) this.flashOff(false);
    }
    if (this._lightT >= 0) {
      this._lightT -= dt;
      cur.flash.light.intensity = 2.4 * Math.max(0, this._lightT / 0.08); // 80ms exponential-feel falloff
      if (this._lightT < 0) cur.flash.light.intensity = 0;
    }
  }

  revealFlash() {
    const cur = this._cur; if (!cur) return;
    const g = cur.flash.grp;
    const s = 0.85 + this._rng() * 0.5;                                // seeded size flicker
    g.scale.setScalar(s);
    g.quaternion.copy(this.camera.quaternion);                         // billboard to eye plane
    g.visible = true;
    for (const m of cur.flash.mats) m.opacity = 1;
    cur.flash.light.intensity = 2.4;
    this._flashT = 0.06; this._lightT = 0.08;
  }

  flashOff(all) {
    if (!this._cur) return;
    const f = this._cur.flash;
    f.grp.visible = false;
    for (const m of f.mats) m.opacity = 0;
    if (all) { f.light.intensity = 0; this._flashT = this._lightT = -1; }
  }

  /** World-space shell-toss recipe handed to the effects agent via onShellEject. */
  _emitShell() {
    if (!this._cur || typeof this.onShellEject !== 'function') return;
    const cur = this._cur, T = cur.T;
    const cam = this.camera;
    const right = new THREE.Vector3(), up = new THREE.Vector3(), fwd = new THREE.Vector3();
    right.setFromMatrixColumn(cam.matrixWorld, 0);                     // TRUE screen-right basis
    up.setFromMatrixColumn(cam.matrixWorld, 1);
    fwd.setFromMatrixColumn(cam.matrixWorld, 2).negate();
    const port = this.getMuzzleWorldPos(new THREE.Vector3())
      .addScaledVector(fwd, 0.24)                                      // port sits back along receiver
      .addScaledVector(up, T.portY * 0.35);
    // def.ejectRight sign kept verbatim; emission flips onto true-right so ports fling correctly.
    const vr = Math.abs(T.ejectRight) * 30;
    const vel = new THREE.Vector3()
      .addScaledVector(right, vr)
      .addScaledVector(up, 1.6 + this._rng() * 0.6)
      .addScaledVector(fwd, 0.4);
    const spin = [(this._rng() - 0.5) * 30, (this._rng() - 0.5) * 30, (this._rng() - 0.5) * 20];
    this.onShellEject({ pos: port.toArray(), vel: vel.toArray(), spin });
  }

  _startJerk(travel, dur) {
    const revolver = this._id === 'revolver';
    this._jerk = {
      t: 0,
      dur: revolver ? Math.max(0.11, dur) : dur,
      travel,
      revolver,
      cylinderStart: revolver ? this._cur.mag.rotation.z : 0,
    };
  }
  _stepJerk(dt) {
    const j = this._jerk, cur = this._cur;
    j.t += dt;
    const u = Math.min(1, j.t / j.dur);
    const stroke = Math.sin(Math.PI * u);
    cur.triggerGroup.rotation.x = 0.20 * stroke;
    if (j.revolver) {
      cur.bolt.rotation.x = -0.70 * stroke;                            // exposed hammer cocks and falls
      cur.mag.rotation.z = j.cylinderStart + (Math.PI / 3) * this._smooth01(u); // index one chamber
    } else {
      cur.bolt.position.z = stroke * j.travel;
    }
    if (u >= 1) {
      cur.bolt.position.z = 0;
      cur.bolt.rotation.x = 0;
      cur.triggerGroup.rotation.x = 0;
      this._jerk = null;
    }
  }

  _beginCycle(kind, silentStall) {
    const cur = this._cur;
    if (!cur || !cur.T.cycleBack || this._cycle) return;
    let durMs = kind === 'pump' ? PUMP_MS : cur.T.bursts[0][0] || 900;
    if (kind === 'bolt') durMs = Math.max(SNIPER_BOLT_MIN_S * 1000, durMs);
    this._cycle = { kind, dur: durMs / 1000, t: 0, step: 0, silent: !!silentStall };
    if (!silentStall) this._stallUntil = Infinity;
  }

  _stepCycle(cur, dt) {
    const c = this._cycle, F = CYCLE_FRACS[c.kind], T = cur.T;
    c.t += dt;
    const u = Math.min(1, c.t / c.dur);
    // Boundary crossings — callbacks + shell eject fire EXACTLY once per stage marker.
    if (c.step < 1 && u >= F.s1) { c.step = 1; this._clack(1); }
    if (c.step < 2 && u >= F.s2) {
      c.step = 2;
      this._clack(2);
      if (typeof this.onShellEject === 'function') this._emitShell();
      if (c.kind === 'pump') this._spr.push.v += T.pumpMag * 2.0;      // full frame rock .14 ONCE
    }
    if (c.step < 3 && u >= F.s3) { c.step = 3; this._clack(3); }

    if (c.kind === 'pump' && cur.pump) {
      const travel = 0.10;                                             // hand slide throw meters
      cur.pump.position.z = PUMP_REST.z + Math.sin(Math.PI * u) * travel;
    } else if (c.kind === 'bolt') {
      const travel = T.boltTravel;                                     // long rotary throw (.16 sniper)
      const s1 = F.s1, s3 = F.s3;
      const lift = u < s1 ? 0.45 * (u / s1)
        : u > s3 ? 0.45 * (1 - (u - s3) / (1 - s3))
        : 0.45;                                                        // lifted through the stroke
      cur.bolt.position.z = Math.sin(Math.PI * u) * travel;
      cur.bolt.rotation.z = lift;
    }
    if (u >= 1) {
      cur.bolt.position.z = 0;
      cur.bolt.rotation.z = 0;
      if (cur.pump) cur.pump.position.z = PUMP_REST.z;
      this._cycle = null;
    }
  }

  _clack(n) { if (typeof this.onBoltClack === 'function') this.onBoltClack(n); }

  /** Reload choreography → {dip, rock} written into content pose; click/thunk callbacks at edges. */
  _updateReload(T) {
    const r = this._rl, M = T.magTimeline;
    const frac = Math.min(1, (this._now - r.t0) / r.dur);
    const out = { dip: 0, rock: 0 };

    if (r.type === 'tube') {
      const thunkEvery = (M.repeatMs || 140) / 1000;
      if (frac >= M.start && frac < M.home && this._now - (r.lastThunk || 0) >= thunkEvery) {
        r.lastThunk = this._now;
        r.thunks++;
        if (typeof this.onReloadClick === 'function') this.onReloadClick(((r.thunks - 1) % 3) + 1);
      }
      out.rock = 0.06 * Math.sin(frac * Math.PI);
      r.lastFrac = frac;
      if (frac >= 1) {
        this._resetReloadPose(this._cur);
        this._rl = null;
      }
      return out;
    }

    const tMag = Math.max(0, Math.min(1, (frac - M.start) / Math.max(0.001, M.home - M.start)));
    const pulse = Math.sin(Math.PI * tMag);
    const hasMovingAmmo = this._cur.magazines ? 1 : 0;
    const isBelt = r.type === 'belt';
    const isCylinder = r.type === 'cylinder';
    out.dip = (isBelt ? -0.12 : isCylinder ? -0.035 : -0.095) * pulse *
      (hasMovingAmmo ? 1 : 0.15);
    out.rock = (isBelt ? 0.22 : isCylinder ? 0.16 : 0.35) * pulse;

    if (r.type === 'mag' || isBelt || isCylinder) {
      if (frac >= M.start && r.lastFrac < M.start && typeof this.onReloadClick === 'function') {
        this.onReloadClick(1);
      }
      if (frac >= M.home && r.lastFrac < M.home && typeof this.onReloadClick === 'function') {
        this.onReloadClick(2);
      }
    }

    const magG = this._cur.mag;
    if (magG) {
      if (isCylinder) {
        magG.position.x = -0.075 * pulse * hasMovingAmmo;
        magG.position.y = 0.012 * pulse * hasMovingAmmo;
        magG.rotation.y = -1.05 * pulse * hasMovingAmmo;               // crane swings cylinder left
      } else {
        magG.position.y = (isBelt ? -0.075 : -0.05) * pulse * hasMovingAmmo;
        magG.rotation.x = (isBelt ? 0.20 : 0.30) * pulse * hasMovingAmmo;
      }
    }

    const cover = this._cur.extra.userData.reloadPart;
    if (isBelt && cover) cover.rotation.x = -1.10 * pulse;             // top cover opens over belt box

    const rounds = this._cur.extra.userData.reloadRounds;
    if (isCylinder && rounds) {
      const insert = this._smooth01(Math.max(0, Math.min(1, (frac - M.start) / Math.max(0.001, M.home - M.start))));
      rounds.visible = frac >= M.start && frac < M.home;
      const home = rounds.userData.homePosition;
      rounds.position.set(home.x + insert * 0.052, home.y - insert * 0.012, home.z);
    }

    if (frac >= M.clickAt && r.lastFrac < M.clickAt && !r.done) {
      if (typeof this.onReloadClick === 'function') this.onReloadClick(3);
      r.done = true;
    }
    r.lastFrac = frac;

    if (r.type === 'stripper') {
      const carts = this._cur.extra.userData.cartridges;
      const showAll = frac >= M.start && frac < M.clickAt;
      carts.forEach((cartridge, i) => {
        const feed = this._smooth01(Math.max(0, Math.min(1,
          (frac - M.start) / Math.max(0.001, M.clickAt - M.start) - i * 0.10)));
        cartridge.visible = showAll && feed > 0 && feed < 0.98;
        cartridge.position.y = 0.115 + i * 0.016 - feed * 0.06;
      });
    }

    if (frac >= 1) {
      this._resetReloadPose(this._cur);
      this._rl = null;
    }
    return out;
  }

  /** Equip dip: rise out of DEPLOY.startDrop across `raise` slice, overshoot settle, tilt ease. */
  _deployOffset() {
    const p = this._depT;
    if (p >= 1) return { y: 0, rx: 0 };
    const rise = this._smooth01(Math.min(1, p / DEPLOY.raise));
    const osc = p < DEPLOY.settleBy
      ? Math.sin(((p - DEPLOY.raise) / (DEPLOY.peak - DEPLOY.raise)) * Math.PI * 0.5) *
        Math.exp(-(p - DEPLOY.raise) / (DEPLOY.settleBy - DEPLOY.raise) * 3.2) * (DEPLOY.overshoot - 1)
      : 0;
    const tilt = DEPLOY.startTilt * (1 - rise);
    return { y: DEPLOY.startDrop * (1 - rise) + osc * 0.08, rx: tilt };
  }

  /** Snap base pose without waiting for next update tick (setWeapon-time correctness). */
  _applyBasePose() {
    this.content.position.set(HIP.x, HIP.y, HIP.z);
    this.content.rotation.set(DEPLOY.startTilt, 0, 0);
    this.posG.position.set(0, 0, 0);
  }
}

/* Group-level quirk shim kept minimal and boring (some three builds differ on parenting order). */
function root0(g) { g.matrixAutoUpdate = true; g.renderOrder = 10; }
