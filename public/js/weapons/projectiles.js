import { isSolidBlock } from '../../../shared/world/blocks.js';
import * as THREE from '../vendor/three.module.js';
import { CLAYMORE_RULES, claymoreBeam } from '../../../shared/claymore-rules.js';
import {
  GRENADE_TYPES,
  grenadeEffectRadius,
  predictGrenadePath,
  stepGrenade,
} from '../../../shared/grenade-rules.js';
import { ROCKET_RULES, stepRocket } from '../../../shared/rocket-rules.js';
import { BOLT_RULES, stepBolt } from '../../../shared/bolt-rules.js';
import { GLAIVE_CHEST_DROP, GLAIVE_RULES, glaiveFlip, glaiveSeek, stepGlaive } from '../../../shared/glaive-rules.js';
import { bubbleProfile, stepBubble } from '../../../shared/bubble-rules.js';
import { MGL_RULES, stepMgl } from '../../../shared/mgl-rules.js';
import { EYE_HEIGHT } from '../../../shared/combatmath.js';
import { raycastVoxels } from '../../../shared/raycast.js';
import { createBlenderParts } from '../engine/blender-assets.js';
import { BLAST_STYLE, ExplosionFX, lightWeight } from './explosion-fx.js';
import { makeSoapFilm } from '../guns/soap-film.js';

/** Unconfirmed local launches are dropped after this long without a matching authority event. */
const LOCAL_CONFIRM_TIMEOUT_S = 1.0;
const PREVIEW_MAX_POINTS = 96;
const PREVIEW_BOUNCE_DOTS = 8;
/** Share of the arc (at least one segment) drawn as the dim dotted tail of a mid-air burst. */
const PREVIEW_AIRBURST_TAIL = 0.2;
/** Blocks searched under a mid-air burst for the floor the landing ring sits on. */
const PREVIEW_FLOOR_PROBE = 12;
const CAP_LIT = 0xffd27a;
const CAP_DIM = 0xff5a1c;
const ROCKET_TRAIL_INTERVAL_S = 0.028;
const PROJECTILE_LIGHT_LIMIT = 4;
// GRENADES study -> in-world prop. The authored bodies are held-frame sized
// (0.06-0.12 m); the thrown props have always read a little larger than life so
// they stay visible mid-flight, so each type keeps its procedural footprint.
const AUTHORED_WORLD_SCALE = Object.freeze({ frag: 1.9, limpet: 2.2, pulse: 2.0, molotov: 1.5, smoke: 1.85 });
const MOLOTOV_WICK_TIP = Object.freeze([-0.037, 0.303, 0]);
const ROCKET_TRAILS_PER_SECOND = 360;
const ROCKET_TRAIL_BURST = 12;
// GV-4 RIPTIDE disc: world-prop radius (a touch over the 0.11 m authored plate so
// it reads mid-flight), spin rate, ribbon length and the embedded-pickup presentation.
const GLAIVE_COLOR = 0xff3fd0;
const GLAIVE_DISC_R = 0.14;
const GLAIVE_TEETH = 24;
const GLAIVE_SPIN = 42;
const GLAIVE_TRAIL_POINTS = 28;
const GLAIVE_TRAIL_HALF_WIDTH = 0.075;
const GLAIVE_TRAIL_STEP = 0.18;
/** Embedded disc: the share of the radius left standing proud of the wall. */
const GLAIVE_EMBED_PROUD = 0.45;
/** Owner speed threshold between the out (34 m/s) and back (30 m/s) legs. */
const GLAIVE_BACK_SPEED = (GLAIVE_RULES.speedOut + GLAIVE_RULES.speedBack) / 2;
const GLAIVE_UNPARK_MARGIN = 1.5; // m past the catch reach before a sync un-parks a caught disc
// SB-1 SUDSBLASTER bubble: inflate time off the ring, wobble decay and the rising trail
// cadence (small / big). The shell scales to the authoritative physics radius.
const BUBBLE_INFLATE_S = 0.09;
const BUBBLE_WOBBLE_DECAY_S = 0.4;
const BUBBLE_TRAIL_SMALL_S = 0.06;
const BUBBLE_TRAIL_BIG_S = 0.04;
const BUBBLE_FUSE_TELL_S = 0.25;
/** Phase-shifted soap films shared round-robin by flying bubbles (never cloned per bubble). */
const BUBBLE_FILM_PHASES = Object.freeze([0, 0.25, 0.5, 0.75]);
const UP_Y = new THREE.Vector3(0, 1, 0);
// Cartoon pop lines: six radial white strokes that fly out and fade on every pop, with a
// soap droplet flung past every other stroke. The pool covers a Foam-party pull (a pair
// of pops plus ten minis) without recycling a live burst.
const POP_LINE_POOL = 16;
const POP_LINE_COUNT = 6;
const POP_DROPLETS = 3;
const POP_LINE_GROW_S = 0.11;
const POP_LINE_LIFE_S = 0.2;

// Blast presentation per projectile type (flash, ring, fireball, smoke, light,
// scorch) lives with the instanced ExplosionFX batch in explosion-fx.js.
function styleFor(type) {
  return BLAST_STYLE[type] || BLAST_STYLE.frag;
}

/** Flat 24-tooth saw plate with a hub bore, centred on the origin in the XZ plane. */
/**
 * One cartoon pop stroke in local XY: a kite along +x (x -0.5..0.5) with a needle
 * inner tip and its full width (y ±0.5) near the outer end, so a burst reads as
 * speed lines flying off the torn skin rather than a clock face of bars.
 */
function popStrokeGeometry() {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
    -0.5, 0, 0, 0.22, -0.5, 0, 0.5, 0, 0, 0.22, 0.5, 0,
  ]), 3));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  return geometry;
}

function glaiveDiscGeometry() {
  const shape = new THREE.Shape();
  const root = GLAIVE_DISC_R * 0.84;
  for (let i = 0; i < GLAIVE_TEETH; i++) {
    const a0 = i / GLAIVE_TEETH * Math.PI * 2;
    const a1 = (i + 0.62) / GLAIVE_TEETH * Math.PI * 2;
    // Raked tooth: a root point, then the tip leaning into the spin direction.
    if (i === 0) shape.moveTo(Math.cos(a0) * root, Math.sin(a0) * root);
    else shape.lineTo(Math.cos(a0) * root, Math.sin(a0) * root);
    shape.lineTo(Math.cos(a1) * GLAIVE_DISC_R, Math.sin(a1) * GLAIVE_DISC_R);
  }
  shape.closePath();
  const bore = new THREE.Path();
  bore.absarc(0, 0, 0.018, 0, Math.PI * 2, true);
  shape.holes.push(bore);
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: 0.022, bevelEnabled: false, curveSegments: 8 });
  geometry.translate(0, 0, -0.011);
  geometry.rotateX(-Math.PI / 2);
  return geometry;
}

/** Shared triangle index for a two-vertex-per-point ribbon of `points` samples. */
function glaiveTrailIndex(points) {
  const index = [];
  for (let i = 0; i < points - 1; i++) {
    const a = i * 2;
    index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  return index;
}

/**
 * Predicted presentation for every thrown or launched explosive: frag/limpet/pulse
 * grenades, the rocket, the LONGARC bolt and the GV-4 RIPTIDE disc. Authority `projectileLaunch` events own the truth, but the local
 * player's own launch is spawned immediately (`launch(event, {local:true})`) and later
 * *adopted* by the matching authority event (`{fromSelf:true}`) so nothing pops or doubles.
 * The charge preview draws the same shared integrator's path per grenade type.
 */
export class ProjectileFX {
  constructor(scene, getBlock = () => 0, {
    getEntityPosition = null, onTrail = null, onBounce = null, onGlaiveFlip = null, onGlaiveFlight = null,
    getGlaiveSeekBodies = null, camera = null,
  } = {}) {
    this.scene = scene;
    this.getBlock = getBlock;
    // `getEntityPosition(id)`: a remote RIPTIDE owner's presented position (catch reach).
    this.getEntityPosition = typeof getEntityPosition === 'function' ? getEntityPosition : null;
    this.onTrail = typeof onTrail === 'function' ? onTrail : null;
    // `onBounce(x, y, z, type, contact)`: bolt ricochets and glaive out-leg wall contacts.
    this.onBounce = typeof onBounce === 'function' ? onBounce : null;
    // `onGlaiveFlip(projectile, reason)`: one of the local player's discs turned home.
    this.onGlaiveFlip = typeof onGlaiveFlip === 'function' ? onGlaiveFlip : null;
    // `onGlaiveFlight(disc)`: every frame a disc is airborne (the positional whirr loop).
    this.onGlaiveFlight = typeof onGlaiveFlight === 'function' ? onGlaiveFlight : null;
    // `getGlaiveSeekBodies(disc)`: presented feet positions an out-leg disc may seek.
    this.getGlaiveSeekBodies = typeof getGlaiveSeekBodies === 'function' ? getGlaiveSeekBodies : null;
    this.projectiles = new Map();
    /** Embedded RIPTIDE discs waiting for their owner (or the 4 s fabricate), keyed by pid. */
    this.glaivePickups = new Map();
    this._glaiveTarget = { x: 0, y: 0, z: 0 };
    this._glaiveBasis = new THREE.Matrix4();
    this.camera = camera;
    this._aimTarget = new THREE.Vector3();
    this._lightCandidates = [];
    this._trailCandidates = [];
    this._trailCursor = 0;
    this._trailTokens = 0;
    // Keep the light count fixed: changing it recompiles lit scene shaders.
    this._lights = Array.from({ length: PROJECTILE_LIGHT_LIMIT }, () => {
      const light = new THREE.PointLight(0xffa040, 0, 7);
      this.scene.add(light);
      return light;
    });
    this._localSeq = 0;
    this.isSolid = (x, y, z) => isSolidBlock(this.getBlock(Math.floor(x), Math.floor(y), Math.floor(z)));
    this.raycast = (ox, oy, oz, dx, dy, dz, max) => raycastVoxels(
      (x, y, z) => isSolidBlock(this.getBlock(x, y, z)), ox, oy, oz, dx, dy, dz, max,
    );
    // Instanced flash/ring/fireball/smoke/scorch batch; `blasts` is its live record list.
    this.explosions = new ExplosionFX(this.scene, this.isSolid);
    this.blasts = this.explosions.blasts;

    this.fragGeometry = new THREE.BoxGeometry(0.26, 0.26, 0.26);
    this.grenadeRibGeometry = new THREE.BoxGeometry(0.29, 0.035, 0.29);
    this.grenadeBandGeometry = new THREE.TorusGeometry(0.19, 0.018, 4, 16);
    this.capGeometry = new THREE.BoxGeometry(0.1, 0.08, 0.13);
    this.limpetGeometry = new THREE.BoxGeometry(0.44, 0.28, 0.14);
    this.claymoreLaserGeometry = new THREE.BoxGeometry(1, 1, 1);
    this.claymoreLaserMaterial = new THREE.MeshBasicMaterial({ color: 0xff3428,
      transparent: true, opacity: 0.65, depthWrite: false, toneMapped: false });
    this.pulseGeometry = new THREE.IcosahedronGeometry(0.17, 1);
    this.bottleGeometry = new THREE.CylinderGeometry(0.11, 0.12, 0.34, 8);
    this.bottleNeckGeometry = new THREE.CylinderGeometry(0.042, 0.085, 0.19, 8);
    this.bottleFlameGeometry = new THREE.ConeGeometry(0.055, 0.22, 6);
    this.rocketBodyGeometry = new THREE.CylinderGeometry(0.075, 0.075, 0.52, 10);
    this.rocketBodyGeometry.rotateX(Math.PI / 2);
    this.rocketNoseGeometry = new THREE.ConeGeometry(0.075, 0.18, 10);
    this.rocketNoseGeometry.rotateX(-Math.PI / 2);
    this.exhaustGeometry = new THREE.ConeGeometry(0.11, 0.42, 8, 1, true);
    this.exhaustGeometry.rotateX(Math.PI / 2);
    this.mglBodyGeometry = new THREE.CylinderGeometry(0.09, 0.09, 0.32, 12);
    this.mglBodyGeometry.rotateX(Math.PI / 2);
    this.mglNoseGeometry = new THREE.ConeGeometry(0.09, 0.1, 12);
    this.mglNoseGeometry.rotateX(-Math.PI / 2);
    this.mglBandGeometry = new THREE.TorusGeometry(0.09, 0.012, 5, 12);
    this.fragMaterial = new THREE.MeshStandardMaterial({
      color: 0x20242a, roughness: 0.48, metalness: 0.78,
    });
    this.limpetMaterial = new THREE.MeshStandardMaterial({
      color: 0x526442, roughness: 0.6, metalness: 0.35,
    });
    this.pulseMaterial = new THREE.MeshStandardMaterial({
      color: 0x0f2a33, roughness: 0.3, metalness: 0.85,
      // HDR: > 1 so the pulse core blooms on HDR tiers.
      emissive: 0x59e8ff, emissiveIntensity: 2.2,
    });
    this.bottleMaterial = new THREE.MeshStandardMaterial({
      color: 0x426d2d, roughness: 0.25, metalness: 0.12,
    });
    this.bottleLabelMaterial = new THREE.MeshStandardMaterial({ color: 0xdbbd78, roughness: 0.9 });
    this.rocketMaterial = new THREE.MeshStandardMaterial({
      color: 0x4a4f57, roughness: 0.55, metalness: 0.7,
    });
    this.rocketNoseMaterial = new THREE.MeshStandardMaterial({
      color: 0xff6f1c, roughness: 0.5, metalness: 0.4,
    });
    this.mglBodyMaterial = new THREE.MeshStandardMaterial({ color: 0x44493c, roughness: 0.48, metalness: 0.72 });
    this.mglNoseMaterial = new THREE.MeshStandardMaterial({ color: 0xe8892d, roughness: 0.42, metalness: 0.55 });
    this.mglBandMaterial = new THREE.MeshStandardMaterial({ color: 0xb8cd4d, roughness: 0.4, metalness: 0.38,
      emissive: 0x28320a, emissiveIntensity: 0.6 });
    this.exhaustMaterial = new THREE.MeshBasicMaterial({
      color: 0xffb347, transparent: true, opacity: 0.85,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
      side: THREE.DoubleSide,
    });
    this.boltCoreMaterial = new THREE.MeshStandardMaterial({
      color: 0x0f2a33, roughness: 0.3, metalness: 0.85,
      emissive: 0x7dfcff, emissiveIntensity: 2.6,
    });
    this.boltGlowMaterial = new THREE.MeshBasicMaterial({
      color: 0x7dfcff, transparent: true, opacity: 0.35, toneMapped: false,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    // Energy additives carry HDR colour (> 1.0) so HDR tiers bloom them; LDR clips.
    this.boltGlowMaterial.color.multiplyScalar(2);
    this.exhaustMaterial.color.multiplyScalar(2.2);
    // SUDSBLASTER bubble: a unit sphere scaled to the physics radius, skinned with the
    // viewmodel's soap film (four phase-shifted copies shared round-robin), a faint inner
    // body and a camera-facing cartoon window glint. The last 250 ms of the fuse swap the
    // skin to the two tell films (hue pushed +0.8, bright/dim) at 20 Hz.
    this.bubbleGeometry = new THREE.SphereGeometry(1, 20, 14);
    this.bubbleFilms = BUBBLE_FILM_PHASES.map((phase) => makeSoapFilm({ alpha: 0.85, phase }).material);
    this.bubbleTellFilms = [makeSoapFilm({ alpha: 0.95, phase: 0.8 }).material,
      makeSoapFilm({ alpha: 0.5, phase: 0.8 }).material];
    this._bubbleFilmCursor = 0;
    this.bubbleInnerMaterial = new THREE.MeshBasicMaterial({
      color: 0xdff8ff, transparent: true, opacity: 0.12, depthWrite: false,
    });
    this.bubbleShineGeometry = new THREE.CircleGeometry(1, 16);
    // Pop strokes: a billboarded group of six thin quads per pooled burst (WebGL ignores
    // line widths, so the strokes are unit planes stretched along their ray).
    this.popStrokeGeometry = popStrokeGeometry();
    this._popLines = Array.from({ length: POP_LINE_POOL }, () => {
      const material = new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, toneMapped: false,
        blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      });
      const lines = new THREE.Group();
      for (let i = 0; i < POP_LINE_COUNT; i++) {
        const stroke = new THREE.Mesh(this.popStrokeGeometry, material);
        stroke.renderOrder = 8;
        lines.add(stroke);
      }
      for (let i = 0; i < POP_DROPLETS; i++) {
        const droplet = new THREE.Mesh(this.bubbleShineGeometry, material);
        droplet.renderOrder = 8;
        lines.add(droplet);
      }
      lines.visible = false;
      this.scene.add(lines);
      return { lines, material, age: Infinity, scale: 1, spin: 0 };
    });
    this._popCursor = 0;
    this.bubbleShineMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.85, depthWrite: false, toneMapped: false,
    });
    // RIPTIDE disc: toothed blade plate lying in local XZ (normal +y), hub, razor-glow rim.
    this.glaiveDiscGeometry = glaiveDiscGeometry();
    this.glaiveHubGeometry = new THREE.CylinderGeometry(0.03, 0.03, 0.036, 12);
    this.glaiveRimGeometry = new THREE.TorusGeometry(GLAIVE_DISC_R * 0.72, 0.01, 4, 32);
    this.glaiveRimGeometry.rotateX(Math.PI / 2);
    this.glaiveBladeMaterial = new THREE.MeshStandardMaterial({
      color: 0xc3c8d0, roughness: 0.28, metalness: 0.92,
      emissive: GLAIVE_COLOR, emissiveIntensity: 0.12,
    });
    this.glaiveHubMaterial = new THREE.MeshStandardMaterial({
      color: 0x33363c, roughness: 0.45, metalness: 0.8,
    });
    this.glaiveGlowMaterial = new THREE.MeshBasicMaterial({
      color: GLAIVE_COLOR, transparent: true, opacity: 0.95, toneMapped: false,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    // Ribbon wake: per-vertex colour over additive blending, so black is transparent.
    this.glaiveTrailMaterial = new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, toneMapped: false,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    this._glaiveTrailIndex = glaiveTrailIndex(GLAIVE_TRAIL_POINTS);
    // Owner-only outline of an embedded disc: an inverted hull, plus a faint copy that
    // ignores depth so the owner can find a disc lodged behind cover.
    this.glaiveOutlineMaterial = new THREE.MeshBasicMaterial({
      color: GLAIVE_COLOR, side: THREE.BackSide, toneMapped: false,
    });
    this.glaiveGhostMaterial = new THREE.MeshBasicMaterial({
      color: GLAIVE_COLOR, transparent: true, opacity: 0.22, toneMapped: false,
      blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false,
    });
    this.glaiveCrescentGeometry = new THREE.RingGeometry(0.1, 0.16, 16, 1, Math.PI * 0.15, Math.PI * 0.7);

    // Submit rocket bodies, noses and exhausts in three instanced draws per pass.
    this._rocketCapacity = 256;
    this._rocketBatches = this._createRocketBatches(this._rocketCapacity);

    // Charge preview: dotted arc plus a landing ring, both hidden until the first hold.
    this.previewPositions = new Float32Array(PREVIEW_MAX_POINTS * 3);
    const previewGeometry = new THREE.BufferGeometry();
    previewGeometry.setAttribute('position', new THREE.BufferAttribute(this.previewPositions, 3));
    previewGeometry.setDrawRange(0, 0);
    this.previewMaterial = new THREE.LineDashedMaterial({
      color: 0xffb347,
      transparent: true,
      opacity: 0.85,
      dashSize: 0.22,
      gapSize: 0.16,
      depthWrite: false,
      toneMapped: false,
    });
    this.previewLine = new THREE.Line(previewGeometry, this.previewMaterial);
    this.previewLine.frustumCulled = false;
    this.previewLine.renderOrder = 8;
    this.previewLine.visible = false;
    // The same arc again, faint and depth-blind, so it still reads through cover.
    this.previewGhostMaterial = new THREE.LineDashedMaterial({
      color: 0xffb347, transparent: true, opacity: 0.25, dashSize: 0.22, gapSize: 0.16,
      depthWrite: false, depthTest: false, toneMapped: false,
    });
    this.previewGhost = new THREE.Line(previewGeometry, this.previewGhostMaterial);
    this.previewGhost.frustumCulled = false;
    this.previewGhost.renderOrder = 7;
    this.previewGhost.visible = false;
    // A cooked fuse that bursts before it rests: the final stretch is dim and dotted.
    // It shares the arc's positions and runs its own draw range over them.
    const tailGeometry = new THREE.BufferGeometry();
    tailGeometry.setAttribute('position', previewGeometry.attributes.position);
    tailGeometry.setDrawRange(0, 0);
    this.previewTailMaterial = new THREE.LineDashedMaterial({
      color: 0xffb347, transparent: true, opacity: 0.4, dashSize: 0.05, gapSize: 0.14,
      depthWrite: false, toneMapped: false,
    });
    this.previewTail = new THREE.Line(tailGeometry, this.previewTailMaterial);
    this.previewTail.frustumCulled = false;
    this.previewTail.renderOrder = 8;
    this.previewTail.visible = false;
    this.landingMaterial = new THREE.MeshBasicMaterial({
      color: 0xffb347,
      transparent: true,
      opacity: 0.7,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    // Landing zone: a unit edge ring plus a translucent disc, scaled to the
    // type's effect radius (blast, fire or smoke) from the shared rules.
    this.landingRing = new THREE.Mesh(new THREE.RingGeometry(0.93, 1, 48), this.landingMaterial);
    this.landingRing.rotation.x = -Math.PI / 2;
    this.landingRing.renderOrder = 8;
    this.landingRing.visible = false;
    this.landingDiscMaterial = new THREE.MeshBasicMaterial({
      color: 0xffb347, transparent: true, opacity: 0.14, depthWrite: false,
      side: THREE.DoubleSide, toneMapped: false,
    });
    this.landingDisc = new THREE.Mesh(new THREE.CircleGeometry(0.93, 48), this.landingDiscMaterial);
    this.landingDisc.renderOrder = 8;
    this.landingRing.add(this.landingDisc);
    this.bounceDotMaterial = new THREE.MeshBasicMaterial({
      color: 0xffb347, transparent: true, opacity: 0.9, depthWrite: false, toneMapped: false,
    });
    this.bounceDotGeometry = new THREE.SphereGeometry(0.07, 8, 6);
    this.bounceDots = Array.from({ length: PREVIEW_BOUNCE_DOTS }, () => {
      const dot = new THREE.Mesh(this.bounceDotGeometry, this.bounceDotMaterial);
      dot.renderOrder = 8;
      dot.visible = false;
      return dot;
    });
    this.scene.add(this.previewGhost, this.previewLine, this.previewTail, this.landingRing, ...this.bounceDots);
    this.preview = null;
    this._previewType = '';
    this.minePreview = this._buildVisual('limpet');
    this.minePreview.group.visible = false;
    this.scene.add(this.minePreview.group);
  }

  _createRocketBatches(capacity) {
    return [
      [this.rocketBodyGeometry, this.rocketMaterial],
      [this.rocketNoseGeometry, this.rocketNoseMaterial],
      [this.exhaustGeometry, this.exhaustMaterial],
    ].map(([geometry, material]) => {
      const mesh = new THREE.InstancedMesh(geometry, material, capacity);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      mesh.count = 0;
      this.scene.add(mesh);
      return mesh;
    });
  }

  _updateRocketBatches() {
    let count = 0;
    for (const p of this.projectiles.values()) if (p.type === 'rocket') count++;
    if (count > this._rocketCapacity) {
      for (const mesh of this._rocketBatches) { this.scene.remove(mesh); mesh.dispose(); }
      while (this._rocketCapacity < count) this._rocketCapacity *= 2;
      this._rocketBatches = this._createRocketBatches(this._rocketCapacity);
    }
    let index = 0;
    for (const p of this.projectiles.values()) {
      if (p.type !== 'rocket') continue;
      p.group.updateMatrixWorld(true);
      for (let part = 0; part < this._rocketBatches.length; part++) {
        this._rocketBatches[part].setMatrixAt(index, p.group.children[part].matrixWorld);
      }
      index++;
    }
    for (const mesh of this._rocketBatches) {
      mesh.count = count;
      if (count) mesh.instanceMatrix.needsUpdate = true;
    }
  }

  /**
   * Blender-authored throwable body (GRENADES study, `public/assets/blender/grenades.gltf`),
   * scaled from the authoring/held frame to the in-world prop. Returns null when the
   * template has not loaded, in which case `_buildVisual` keeps its procedural body.
   * Every cloned material is tracked so `_removeProjectile` can release it; the geometry
   * and the shared scans stay page-owned.
   */
  _authoredGrenade(type) {
    const materials = [];
    const model = createBlenderParts('grenades', {
      names: [type],
      materialFor: original => { const clone = original.clone(); materials.push(clone); return clone; },
    })?.[type];
    if (!model) return null;
    model.scale.setScalar(AUTHORED_WORLD_SCALE[type] || 1);
    const part = name => materials.find(material => material.userData?.partMaterial === name) || null;
    return { model, materials, part };
  }

  _buildVisual(type) {
    const group = new THREE.Group();
    let capMaterial = null;
    if (type === 'rocket') {
      const body = new THREE.Mesh(this.rocketBodyGeometry, this.rocketMaterial);
      const nose = new THREE.Mesh(this.rocketNoseGeometry, this.rocketNoseMaterial);
      nose.position.z = -0.35;
      const exhaust = new THREE.Mesh(this.exhaustGeometry, this.exhaustMaterial);
      exhaust.position.z = 0.45;
      group.add(body, nose, exhaust);
      group.userData.exhaust = exhaust;
    } else if (type === 'mgl') {
      const body = new THREE.Mesh(this.mglBodyGeometry, this.mglBodyMaterial);
      const nose = new THREE.Mesh(this.mglNoseGeometry, this.mglNoseMaterial);
      nose.position.z = -0.205;
      const band = new THREE.Mesh(this.mglBandGeometry, this.mglBandMaterial);
      band.position.z = 0.055;
      group.add(body, nose, band);
    } else if (type === 'smoke') {
      const authored = this._authoredGrenade('smoke');
      if (authored) {
        // The authored canister carries its own fuze; the fuse cap is the strobe.
        capMaterial = authored.part('fuse cap');
        group.add(authored.model);
        group.userData.authoredMaterials = authored.materials;
      } else {
        capMaterial = new THREE.MeshStandardMaterial({ color: 0xc7d9db, metalness: 0.45, roughness: 0.6 });
        const body = new THREE.Mesh(this.bottleGeometry, capMaterial);
        const band = new THREE.Mesh(this.bottleGeometry, this.fragMaterial);
        band.scale.set(1.02, 0.22, 1.02);
        group.add(body, band);
      }
    } else if (type === 'molotov') {
      const authored = this._authoredGrenade('molotov');
      capMaterial = new THREE.MeshBasicMaterial({ color: 0xffac30, toneMapped: false });
      if (authored) {
        const scale = AUTHORED_WORLD_SCALE.molotov;
        const wickFlame = new THREE.Mesh(this.bottleFlameGeometry, capMaterial);
        // The study authors the wick tip on the same anchor the held bottle uses.
        wickFlame.position.set(MOLOTOV_WICK_TIP[0] * scale, MOLOTOV_WICK_TIP[1] * scale + 0.05, 0);
        group.add(authored.model, wickFlame);
        group.userData.flame = wickFlame;
        group.userData.authoredMaterials = authored.materials;
        return { group, capMaterial };
      }
      const body = new THREE.Mesh(this.bottleGeometry, this.bottleMaterial);
      const neck = new THREE.Mesh(this.bottleNeckGeometry, this.bottleMaterial);
      neck.position.y = 0.245;
      const label = new THREE.Mesh(this.bottleGeometry, this.bottleLabelMaterial);
      label.scale.set(1.015, 0.43, 1.015);
      const cloth = new THREE.Mesh(this.capGeometry, this.bottleLabelMaterial);
      cloth.scale.set(0.5, 1.4, 0.42);
      cloth.position.set(0.022, 0.365, 0);
      cloth.rotation.z = -0.4;
      const flame = new THREE.Mesh(this.bottleFlameGeometry, capMaterial);
      flame.position.set(0.04, 0.47, 0);
      group.add(body, neck, label, cloth, flame);
      group.userData.flame = flame;
    } else if (type === 'limpet') {
      const authored = this._authoredGrenade('limpet');
      capMaterial = new THREE.MeshBasicMaterial({ color: 0xff5a3c, toneMapped: false });
      const led = new THREE.Mesh(this.capGeometry, capMaterial);
      if (authored) {
        // Authored claymore: wall plate at -z, sensor lens at +z, same as the
        // procedural housing, so `_poseMine`'s look-at keeps working. The lens
        // itself stays runtime-lit so the arming colour reads at range.
        led.scale.set(0.45, 0.55, 0.16);
        led.position.set(0, 0, 0.070);
        group.add(authored.model, led);
        group.userData.authoredMaterials = authored.materials;
      } else {
        const housing = new THREE.Mesh(this.limpetGeometry, this.limpetMaterial);
        led.scale.set(0.28, 0.35, 0.22);
        led.position.set(0, 0, 0.084);
        group.add(housing, led);
        for (const side of [-1, 1]) {
          const bracket = new THREE.Mesh(this.capGeometry, this.fragMaterial);
          bracket.scale.set(0.5, 2.8, 1.25);
          bracket.position.set(side * 0.185, 0, -0.012);
          group.add(bracket);
        }
      }
      const laser = new THREE.Mesh(this.claymoreLaserGeometry, this.claymoreLaserMaterial);
      laser.name = 'claymore-laser';
      laser.visible = false;
      const dot = new THREE.Mesh(this.capGeometry, capMaterial);
      dot.name = 'claymore-laser-dot';
      dot.scale.set(0.32, 0.4, 0.05);
      dot.visible = false;
      group.add(laser, dot);
      group.userData.laser = laser;
      group.userData.laserDot = dot;
    } else if (type === 'pulse') {
      const authored = this._authoredGrenade('pulse');
      capMaterial = new THREE.MeshBasicMaterial({
        color: 0x9ff4ff, transparent: true, opacity: 0.5, toneMapped: false,
        blending: THREE.AdditiveBlending, depthWrite: false,
      });
      const halo = new THREE.Mesh(this.pulseGeometry, capMaterial);
      halo.scale.setScalar(1.55);
      if (authored) {
        // The authored cage already holds the faceted core, so the additive
        // shell only draws its far side: it reads as an aura around the cage
        // instead of washing the metalwork out. The strobe stays runtime-owned.
        capMaterial.side = THREE.BackSide;
        halo.scale.setScalar(1.12);
        group.add(authored.model, halo);
        group.userData.authoredMaterials = authored.materials;
      } else {
        const core = new THREE.Mesh(this.pulseGeometry, this.pulseMaterial);
        group.add(core, halo);
        for (let i = 0; i < 2; i++) {
          const band = new THREE.Mesh(this.grenadeBandGeometry, this.fragMaterial);
          band.rotation.x = i * Math.PI / 2;
          group.add(band);
        }
      }
      group.userData.halo = halo;
    } else if (type === 'glaive') {
      // RIPTIDE disc: the group faces the flight (-z forward, so the plate lies in the
      // plane of travel and the horizontal right), the `spin` child whirls about +y.
      const spin = new THREE.Group();
      spin.add(
        new THREE.Mesh(this.glaiveDiscGeometry, this.glaiveBladeMaterial),
        new THREE.Mesh(this.glaiveHubGeometry, this.glaiveHubMaterial),
        new THREE.Mesh(this.glaiveRimGeometry, this.glaiveGlowMaterial),
      );
      group.add(spin);
      group.userData.spin = spin;
    } else if (type === 'bubble') {
      // Soap bubble: `shell` carries the wobble scale and spin (film skin plus a faint
      // inner body); `shine` is the billboarded window glint, posed toward the camera.
      const shell = new THREE.Group();
      const film = this.bubbleFilms[this._bubbleFilmCursor++ % this.bubbleFilms.length];
      const skin = new THREE.Mesh(this.bubbleGeometry, film);
      skin.renderOrder = 6;
      skin.userData.film = film;
      const inner = new THREE.Mesh(this.bubbleGeometry, this.bubbleInnerMaterial);
      inner.scale.setScalar(0.96);
      inner.renderOrder = 5;
      shell.add(inner, skin);
      const shine = new THREE.Group();
      const glint = new THREE.Mesh(this.bubbleShineGeometry, this.bubbleShineMaterial);
      glint.scale.set(0.25, 0.15, 1);
      glint.position.set(-0.37, 0.45, 0);
      const dot = new THREE.Mesh(this.bubbleShineGeometry, this.bubbleShineMaterial);
      dot.scale.setScalar(0.1);
      dot.position.set(-0.55, 0.2, 0);
      glint.renderOrder = dot.renderOrder = 7;
      shine.add(glint, dot);
      group.add(shell, shine);
      group.userData.shell = shell;
      group.userData.skin = skin;
      group.userData.shine = shine;
    } else if (type === 'bolt') {
      // Coilgun bolt: thin emissive core, additive glow shell, cyan light.
      const core = new THREE.Mesh(this.capGeometry, this.boltCoreMaterial);
      core.scale.set(0.7, 0.7, 2.6);
      const glow = new THREE.Mesh(this.pulseGeometry, this.boltGlowMaterial);
      glow.scale.setScalar(1.1);
      group.add(core, glow);
    } else {
      const authored = this._authoredGrenade('frag');
      if (authored) {
        // Authored M-4 FRAG: dark steel body, bronze ribs, amber fuse cap. The
        // cap material is the fuse strobe the update loop tints.
        capMaterial = authored.part('fuse cap');
        group.add(authored.model);
        group.userData.authoredMaterials = authored.materials;
        return { group, capMaterial };
      }
      const body = new THREE.Mesh(this.fragGeometry, this.fragMaterial);
      body.rotation.set(0.35, 0.45, 0.12);
      capMaterial = new THREE.MeshBasicMaterial({ color: CAP_LIT, toneMapped: false });
      const cap = new THREE.Mesh(this.capGeometry, capMaterial);
      cap.position.set(0, 0.17, 0);
      group.add(body, cap);
      for (const height of [-0.09, 0, 0.09]) {
        const rib = new THREE.Mesh(this.grenadeRibGeometry, this.limpetMaterial);
        rib.position.y = height;
        group.add(rib);
      }
      const lever = new THREE.Mesh(this.capGeometry, this.fragMaterial);
      lever.scale.set(0.65, 3.6, 0.65);
      lever.position.set(0.16, 0.035, 0);
      lever.rotation.z = 0.2;
      group.add(lever);
    }
    return { group, capMaterial };
  }

  /**
   * Spawn a projectile from a `projectileLaunch`-shaped event `{pid?,type,o,v,fuse}`.
   * `local:true` creates an unconfirmed prediction; `fromSelf:true` marks an authority event
   * that should adopt the oldest pending local projectile of the same type.
   */
  launch(event, { local = false, fromSelf = false } = {}) {
    if (!event || !Array.isArray(event.o) || !Array.isArray(event.v)) return false;
    const values = [...event.o, ...event.v].map(Number);
    if (!values.every(Number.isFinite)) return false;
    const type = event.type === 'rocket' || event.type === 'bolt' || event.type === 'glaive' || event.type === 'mgl'
      || event.type === 'bubble' || GRENADE_TYPES[event.type]
      ? event.type
      : 'frag';
    if (type === 'limpet' && (!Array.isArray(event.n) || event.n.length !== 3
      || event.n[1] !== 0 || Math.abs(event.n[0]) + Math.abs(event.n[2]) !== 1)) return false;
    if (type === 'limpet' && !local && this._mineIds && !this._mineIds.has(String(event.pid))) return false;
    const fallbackFuse = type === 'rocket'
      ? ROCKET_RULES.lifetimeMs
      : type === 'mgl' ? MGL_RULES.fuseMs
      : type === 'bolt' ? BOLT_RULES.lifetimeMs
        : type === 'glaive' ? GLAIVE_RULES.lifetimeMs
          : type === 'bubble' ? bubbleProfile(Number(event.charge) || 0, !!event.child).lifetimeMs
            : GRENADE_TYPES[type].fuseMs;
    const fuseMs = Number(event.fuse);
    const fuse = type === 'limpet' ? Infinity
      : Math.max(0.05, (Number.isFinite(fuseMs) && fuseMs > 0 ? fuseMs : fallbackFuse) / 1000);
    // Reflection budget: authority events carry `bn`; otherwise the shared rule applies.
    const bn = Number(event.bn);
    const bouncesLeft = type === 'bolt'
      ? Number.isFinite(bn) ? Math.max(0, Math.floor(bn)) : BOLT_RULES.bounces
      : type === 'glaive' ? Number.isFinite(bn) ? Math.max(0, Math.floor(bn)) : GLAIVE_RULES.bounces
        : type === 'mgl' ? Number.isFinite(bn) ? Math.max(0, Math.floor(bn)) : MGL_RULES.maxBounces
          : 0;

    if (!local) {
      if (!event.pid || this.projectiles.has(String(event.pid))) return false;
      // A Double-bubble twin is authority-only: it must not steal the prediction's slot.
      if (fromSelf && !event.child && !event.twin && this._adoptLocal(String(event.pid), type, values, fuse, event)) {
        const adopted = this.projectiles.get(String(event.pid));
        if (type === 'glaive') {
          // The prediction may already have bounced or turned home: keep its leg.
          this._configureGlaive(adopted, event, true);
          return true;
        }
        adopted.bouncesLeft = bouncesLeft;
        adopted.chaos = event.chaos || 0;
        if (type === 'limpet') this._configureMine(adopted, event);
        if (type === 'rocket' && event.chaos) adopted.group.scale.setScalar(2.2);
        // The release charge is authoritative: re-derive the flight, keep the position.
        if (type === 'bubble') this._configureBubble(adopted, event);
        return true;
      }
    }
    const id = local ? `local-${++this._localSeq}` : String(event.pid);
    const { group, capMaterial } = this._buildVisual(type);
    group.position.set(values[0], values[1], values[2]);
    if (type === 'rocket' && event.chaos) group.scale.setScalar(2.2);
    if (type !== 'rocket') this.scene.add(group);
    this.projectiles.set(id, {
      id,
      type,
      group,
      capMaterial,
      x: values[0], y: values[1], z: values[2],
      vx: values[3], vy: values[4], vz: values[5],
      age: 0,
      fuse,
      bouncesLeft,
      chaos: event.chaos || 0,
      child: !!event.child,
      armAge: type === 'mgl' ? Math.max(0, Number(event.arm) || MGL_RULES.armMs) / 1000 : 0,
      local,
      stuck: type === 'limpet',
      trailAt: 0,
    });
    if (type === 'limpet') this._configureMine(this.projectiles.get(id), event);
    if (type === 'glaive') this._configureGlaive(this.projectiles.get(id), event, local || fromSelf);
    if (type === 'bubble') this._configureBubble(this.projectiles.get(id), event);
    if (type === 'rocket' || type === 'bolt' || type === 'glaive' || type === 'mgl') this._orientRocket(this.projectiles.get(id));
    return true;
  }

  /**
   * RIPTIDE flight state on a fresh or adopted disc. Launch events carry `phase`
   * ('out'|'back'), `flip` (the out-leg ms; a Chaos Long tether lengthens it) and `bn`;
   * anything missing falls back to `GLAIVE_RULES`. `own` marks the local player's
   * discs: they steer toward the camera and raise the flip hook.
   */
  _configureGlaive(disc, event, own) {
    const outMs = Number(event.flip);
    disc.outAge = (Number.isFinite(outMs) && outMs > 0 ? outMs : GLAIVE_RULES.outMs) / 1000;
    const phase = event.phase ?? event.ph;
    if (!disc.phase) disc.phase = phase === 'back' ? 'back' : 'out';
    else if (phase === 'back' && disc.phase === 'out') this._flipGlaive(disc, 'return');
    disc.ownerId = event.id != null ? String(event.id) : disc.ownerId ?? null;
    disc.own = !!own;
    if (Number.isFinite(Number(event.bn)) && disc.phase === 'out') disc.bouncesLeft = Math.max(0, Math.floor(event.bn));
    if (!disc.trail) disc.trail = this._createGlaiveTrail(disc);
  }

  /** Flight profile (drag, rise, radius) of a fresh or adopted bubble from its launch charge. */
  _configureBubble(bubble, event) {
    const profile = bubbleProfile(Number(event.charge) || 0, !!event.child);
    bubble.drag = profile.drag;
    bubble.rise = profile.rise;
    bubble.radius = profile.radius;
    bubble.chargeMix = profile.mix;
    // Presentation only: a per-bubble phase so a stream never wobbles in lockstep.
    if (!Number.isFinite(bubble.wobblePhase)) bubble.wobblePhase = Math.random() * Math.PI * 2;
    this._poseBubble(bubble, 0);
  }

  /**
   * Inflate, squash-and-stretch wobble, clung flattening and the last-250 ms fuse
   * flicker for one bubble, plus its rising micro-bubble trail cadence.
   */
  _poseBubble(bubble, step) {
    const shell = bubble.group.userData.shell;
    if (!shell) return;
    const age = bubble.age;
    const big = bubble.chargeMix > 0.5;
    const omega = big ? 4 * Math.PI * 2 / 7 : 11;
    const amp = 0.04 + 0.08 * Math.max(0, 1 - age / BUBBLE_WOBBLE_DECAY_S);
    const phase = omega * age + (bubble.wobblePhase || 0);
    const inflate = 0.35 + 0.65 * Math.min(1, age / BUBBLE_INFLATE_S);
    const r = (bubble.radius || 0.24) * inflate;
    const flat = bubble.stuck ? 0.85 + 0.05 * Math.sin(age * Math.PI * 1.6) : 1;
    shell.scale.set(
      r * (1 + amp * Math.sin(phase)),
      r * (1 - amp * Math.sin(phase)) * flat,
      r * (1 + 0.7 * amp * Math.sin(1.3 * phase + 1)),
    );
    if (bubble.stuck && bubble.mountNormal) {
      // Clung: shell-local Y lines up with the mount normal, so the flatten above
      // presses the bubble against its wall or ceiling (and it stops spinning).
      shell.quaternion.setFromUnitVectors(UP_Y, bubble.mountNormal);
    } else {
      shell.rotation.y += 0.8 * step;
    }
    // Fuse tell: the skin flickers bright/dim on the hue-shifted tell films.
    const remaining = bubble.fuse - age;
    const { skin, shine } = bubble.group.userData;
    if (skin) {
      skin.material = remaining < BUBBLE_FUSE_TELL_S
        ? this.bubbleTellFilms[Math.sin(age * 20 * Math.PI * 2) < 0 ? 1 : 0]
        : skin.userData.film;
    }
    // Window glint: faces the camera, riding the near side of the skin.
    const eye = this.camera?.position;
    if (shine && eye) {
      const dx = eye.x - bubble.x, dy = eye.y - bubble.y, dz = eye.z - bubble.z;
      const d = Math.hypot(dx, dy, dz) || 1;
      shine.quaternion.copy(this.camera.quaternion);
      shine.position.set(dx / d * r * 0.97, dy / d * r * 0.97, dz / d * r * 0.97);
      shine.scale.setScalar(r);
    }
    const interval = big ? BUBBLE_TRAIL_BIG_S : BUBBLE_TRAIL_SMALL_S;
    if (this.onTrail && !bubble.stuck && age - bubble.trailAt >= interval) this._trailCandidates.push(bubble);
  }

  _createGlaiveTrail(disc) {
    const positions = new Float32Array(GLAIVE_TRAIL_POINTS * 2 * 3);
    const colors = new Float32Array(GLAIVE_TRAIL_POINTS * 2 * 3);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setIndex(this._glaiveTrailIndex);
    geometry.setDrawRange(0, 0);
    const mesh = new THREE.Mesh(geometry, this.glaiveTrailMaterial);
    mesh.frustumCulled = false;
    mesh.renderOrder = 7;
    this.scene.add(mesh);
    // Newest sample first; each keeps the disc's lateral (right) axis at that point.
    return { mesh, geometry, positions, colors, points: [{ x: disc.x, y: disc.y, z: disc.z, rx: 1, rz: 0 }] };
  }

  /** Turn a disc home (predicted timer/bounce, R, or an authority update). */
  _flipGlaive(disc, reason) {
    if (!glaiveFlip(disc, disc.age * 1000, reason)) return false;
    if (disc.own) this.onGlaiveFlip?.(disc, reason);
    return true;
  }

  /**
   * Predict R ("return discs") for the local player: every own disc still on its out
   * leg turns home now. Authority confirms with a `projectileUpdate` per disc.
   */
  returnOwnGlaives() {
    let flipped = 0;
    for (const disc of this.projectiles.values()) {
      if (disc.type === 'glaive' && disc.own && this._flipGlaive(disc, 'return')) flipped++;
    }
    return flipped;
  }

  /** Own discs still flying (predicted or confirmed): HUD pips can read this. */
  ownGlaivesInFlight() {
    let count = 0;
    for (const disc of this.projectiles.values()) if (disc.type === 'glaive' && disc.own && !disc.parked) count++;
    return count;
  }

  updateAuthority(event) {
    const p = this.projectiles.get(String(event.pid));
    if (!p || !Array.isArray(event.o) || !Array.isArray(event.v) || ![...event.o, ...event.v].every(Number.isFinite)) return false;
    let back = false;
    if (p.type === 'glaive') {
      // Updates carry `phase` (and `flip`, the reason, on the flip itself); without it
      // the leg speed tells them apart.
      const phase = event.phase ?? event.ph;
      back = phase ? phase === 'back' : Math.hypot(...event.v) < GLAIVE_BACK_SPEED;
      // An out-leg sync sent before the flip arrives late (Chaos syncs the out leg):
      // the out leg never resumes, so it must not undo the flip and replay its cue.
      if (!back && p.phase === 'back') return true;
      // Syncs sent before the server's own catch trail a predicted catch by about one
      // RTT; only a disc clearly outside the catch reach is still flying.
      if (p.parked && p.caught && p.own && this._glaiveNearOwner(p, event.o)) return true;
    }
    [p.x, p.y, p.z] = event.o;
    [p.vx, p.vy, p.vz] = event.v;
    if (Number.isFinite(event.bn)) p.bouncesLeft = event.bn;
    if (p.type === 'glaive') {
      if (back && p.phase === 'out') {
        this._flipGlaive(p, typeof event.flip === 'string' ? event.flip : 'return');
        [p.vx, p.vy, p.vz] = event.v;
      }
      // An authoritative position means the disc is still flying: undo a predicted park.
      p.parked = false;
      p.group.visible = true;
      if (p.trail) p.trail.mesh.visible = true;
    }
    p.group.position.set(p.x, p.y, p.z);
    return true;
  }

  /**
   * Authoritative terrain cling (a Chaos 2 SUDSBLASTER bubble): freeze the
   * projectile at the reported point and restart its fuse.
   */
  stick(event) {
    const projectile = this.projectiles.get(String(event?.pid || ''));
    if (!projectile) return false;
    const x = Number(event.x), y = Number(event.y), z = Number(event.z);
    if ([x, y, z].every(Number.isFinite)) {
      projectile.x = x; projectile.y = y; projectile.z = z;
    }
    projectile.vx = projectile.vy = projectile.vz = 0;
    projectile.stuck = true;
    const n = Array.isArray(event.n) ? event.n.map(Number) : null;
    if (n && n.length === 3 && n.every(Number.isFinite) && Math.hypot(...n) > 1e-6) {
      projectile.mountNormal = new THREE.Vector3(n[0], n[1], n[2]).normalize();
    }
    const fuseMs = Number(event.fuse);
    if (Number.isFinite(fuseMs) && fuseMs > 0) projectile.fuse = projectile.age + fuseMs / 1000;
    projectile.group.position.set(projectile.x, projectile.y, projectile.z);
    return true;
  }

  /** Legacy alias for the frag-only API. */
  throw(event, options) {
    return this.launch({ type: 'frag', ...event, pid: event?.pid ?? event?.gid }, options);
  }

  /** Number of local launches still waiting for their authority event. */
  get pendingLocal() {
    let count = 0;
    for (const projectile of this.projectiles.values()) if (projectile.local) count++;
    return count;
  }

  _adoptLocal(pid, type, values, fuse, event = null) {
    let oldest = null;
    for (const projectile of this.projectiles.values()) {
      if (projectile.local && projectile.type === type && (!oldest || projectile.age > oldest.age)) {
        oldest = projectile;
      }
    }
    if (!oldest) return false;
    this.projectiles.delete(oldest.id);
    oldest.id = pid;
    oldest.local = false;
    if (type === 'glaive') {
      // A disc flies 34 m/s, so compare against where the launch has carried it by now
      // and leave a prediction that already bounced or turned home on its own leg.
      if (oldest.phase === 'out' && !oldest.flippedAt) {
        oldest.vx = values[3]; oldest.vy = values[4]; oldest.vz = values[5];
        const ex = values[0] + values[3] * oldest.age;
        const ey = values[1] + values[4] * oldest.age;
        const ez = values[2] + values[5] * oldest.age;
        if (Math.hypot(oldest.x - ex, oldest.y - ey, oldest.z - ez) > 0.6) {
          oldest.x = ex; oldest.y = ey; oldest.z = ez;
          oldest.group.position.set(ex, ey, ez);
        }
      }
      oldest.fuse = fuse + oldest.age;
      this.projectiles.set(pid, oldest);
      return true;
    }
    if (type === 'bubble') {
      // Bubbles bleed speed: compare against the authority launch advanced by the
      // prediction's age on the authoritative charge, not against the raw launch state.
      const profile = bubbleProfile(Number(event?.charge) || 0, false);
      const at = { x: values[0], y: values[1], z: values[2], vx: values[3], vy: values[4], vz: values[5],
        drag: profile.drag, rise: profile.rise, radius: profile.radius };
      stepBubble(at, oldest.age, this.raycast);
      oldest.vx = at.vx; oldest.vy = at.vy; oldest.vz = at.vz;
      if (Math.hypot(oldest.x - at.x, oldest.y - at.y, oldest.z - at.z) > 0.6) {
        oldest.x = at.x; oldest.y = at.y; oldest.z = at.z;
        oldest.group.position.set(at.x, at.y, at.z);
      }
      oldest.fuse = fuse + oldest.age;
      this.projectiles.set(pid, oldest);
      return true;
    }
    // Authority and prediction share the integrator, so the states are near-identical;
    // snapping the velocity while keeping the rendered position avoids a visible hop.
    oldest.vx = values[3]; oldest.vy = values[4]; oldest.vz = values[5];
    const drift = Math.hypot(oldest.x - values[0], oldest.y - values[1], oldest.z - values[2]);
    if (drift > 0.6) {
      oldest.x = values[0]; oldest.y = values[1]; oldest.z = values[2];
      oldest.group.position.set(values[0], values[1], values[2]);
    }
    oldest.fuse = fuse + oldest.age;
    this.projectiles.set(pid, oldest);
    return true;
  }

  /**
   * Draw (or hide with `null`) the predicted flight for a launch state
   * `{type?,x,y,z,vx,vy,vz}`. Returns the prediction so HUD/audio glue can read the landing.
   * `fuseMs` limits the horizon (cooked fuse); `effectRadius` sizes the landing zone,
   * falling back to grenadeEffectRadius(type, chaosLevel) from the shared rules.
   */
  setPreview(launch) {
    this.minePreview.group.visible = false;
    if (!launch) {
      if (this.preview) {
        this.preview = null;
        this._hidePreviewArc();
      }
      return null;
    }
    const type = GRENADE_TYPES[launch.type] ? launch.type : 'frag';
    if (type === 'limpet') {
      this._hidePreviewArc();
      this._poseMine(this.minePreview.group, launch, true);
      this.minePreview.group.visible = true;
      this.preview = { rests: true, landing: [launch.x, launch.y, launch.z] };
      return this.preview;
    }
    if (type !== this._previewType) {
      this._previewType = type;
      const color = new THREE.Color(GRENADE_TYPES[type].color);
      for (const material of [this.previewMaterial, this.previewGhostMaterial, this.previewTailMaterial,
        this.landingMaterial, this.landingDiscMaterial, this.bounceDotMaterial]) material.color.copy(color);
    }
    const prediction = predictGrenadePath(launch, this.isSolid, { maxPoints: PREVIEW_MAX_POINTS, fuseMs: launch.fuseMs });
    const count = Math.min(PREVIEW_MAX_POINTS, prediction.points.length);
    for (let i = 0; i < count; i++) {
      const p = prediction.points[i];
      this.previewPositions[i * 3] = p[0];
      this.previewPositions[i * 3 + 1] = p[1];
      this.previewPositions[i * 3 + 2] = p[2];
    }
    const geometry = this.previewLine.geometry;
    geometry.attributes.position.needsUpdate = true;
    // A cook type that would burst in mid-air ends in a dim dotted tail.
    const airburst = !!GRENADE_TYPES[type].cook && !prediction.rests && count > 2;
    const tail = airburst ? Math.max(1, Math.round((count - 1) * PREVIEW_AIRBURST_TAIL)) : 0;
    geometry.setDrawRange(0, count - tail);
    this.previewLine.computeLineDistances();
    this.previewLine.visible = count > 1;
    this.previewGhost.visible = count > 1;
    const tailGeometry = this.previewTail.geometry;
    tailGeometry.setDrawRange(count - 1 - tail, tail + 1);
    if (tail) this.previewTail.computeLineDistances();
    this.previewTail.visible = tail > 0;
    const bounces = prediction.bounces || [];
    for (let i = 0; i < this.bounceDots.length; i++) {
      const dot = this.bounceDots[i];
      const at = bounces[i];
      dot.visible = !!at;
      if (at) dot.position.set(at[0], at[1], at[2]);
    }
    const landing = prediction.landing;
    const radius = Number.isFinite(launch.effectRadius) && launch.effectRadius > 0
      ? launch.effectRadius
      : grenadeEffectRadius(type, launch.chaosLevel || 0);
    // A mid-air end point would show the flat ring edge-on at eye height: drop it onto
    // the floor under the burst instead, or skip it when there is no floor in reach.
    let ringY = landing[1];
    if (!prediction.rests) {
      ringY = null;
      for (let y = Math.floor(landing[1]); y >= Math.floor(landing[1]) - PREVIEW_FLOOR_PROBE; y--) {
        if (this.isSolid(landing[0], y - 0.5, landing[2])) { ringY = y + 0.16; break; }
      }
    }
    this.landingRing.visible = ringY != null;
    if (ringY != null) {
      this.landingRing.position.set(landing[0], ringY - 0.12, landing[2]);
      this.landingRing.scale.set(radius, radius, 1);
    }
    this.landingMaterial.opacity = prediction.rests ? 0.75 : 0.35;
    this.landingDiscMaterial.opacity = prediction.rests ? 0.14 : 0.06;
    this.preview = prediction;
    return prediction;
  }

  _hidePreviewArc() {
    this.previewLine.visible = this.previewGhost.visible = this.previewTail.visible = false;
    this.landingRing.visible = false;
    for (const dot of this.bounceDots) dot.visible = false;
  }

  _configureMine(mine, event) {
    [mine.x, mine.y, mine.z] = event.o;
    mine.n = [...event.n];
    mine.laserRange = Number.isFinite(event.laserRange) ? event.laserRange : CLAYMORE_RULES.laserRange;
    mine.armedAge = mine.age + Math.max(0, event.armMs ?? CLAYMORE_RULES.armMs) / 1000;
    mine.stuck = true;
    mine.fuse = Infinity;
    this._poseMine(mine.group, mine, mine.age >= mine.armedAge);
  }

  _poseMine(group, mine, armed) {
    group.position.set(mine.x, mine.y, mine.z);
    group.lookAt(mine.x + mine.n[0], mine.y, mine.z + mine.n[2]);
    const beam = claymoreBeam(mine, this.isSolid);
    const length = Math.max(0, beam.length - 0.10);
    const laser = group.userData.laser;
    laser.position.set(0, 0, 0.10 + length / 2);
    laser.scale.set(0.012, 0.012, length);
    laser.visible = armed && length > 0;
    const dot = group.userData.laserDot;
    dot.position.set(0, 0, Math.max(0.10, beam.length - 0.008));
    dot.visible = laser.visible && beam.length < (mine.laserRange ?? CLAYMORE_RULES.laserRange);
  }

  syncMines(rows, selfId) {
    if (!Array.isArray(rows)) return;
    this._mineIds = new Set(rows.map(row => String(row.pid)));
    const active = new Set();
    for (const row of rows) {
      const id = String(row.pid);
      this.launch(row, { fromSelf: String(row.id) === String(selfId) });
      const mine = this.projectiles.get(id);
      if (mine?.type !== 'limpet') continue;
      this._configureMine(mine, row);
      active.add(id);
    }
    for (const [id, p] of this.projectiles) {
      if (p.type === 'limpet' && !p.local && !active.has(id)) this._removeProjectile(id);
    }
  }

  /**
   * Authoritative end of a projectile. RIPTIDE discs reuse the channel for every way a
   * disc leaves the air: `caught` (back in the owner's hand), `reason: 'embed'` (lodged
   * in a wall as an owner pickup; optional `n` normal and `ms` lifetime), `picked` (an
   * embedded disc was collected) and any other reason (expiry/owner lost: a fizzle).
   * Embedded discs otherwise leave through `syncGlaivePickups` (the `glaiveStock` event).
   * `options.fromSelf` marks the local player's disc (owner-only outline).
   */
  explode(event, { fromSelf } = {}) {
    const id = String(event?.pid || event?.gid || '');
    const existing = this.projectiles.get(id);
    const type = event?.type || existing?.type || 'frag';
    if (type === 'glaive') return this._endGlaive(event, id, existing, fromSelf ?? existing?.own ?? false);
    this._removeProjectile(id);
    const x = Number(event?.x), y = Number(event?.y), z = Number(event?.z);
    if (![x, y, z].every(Number.isFinite)) return false;
    if (type === 'smoke') return true;
    const style = styleFor(type);
    if (type === 'bubble') {
      // A soap pop is a torn skin, not a fireball: the flash and ring scale with the
      // splash relative to a Soap Shot (2.2 m), not with the full splash radius. A
      // Foam-party mini pops at half scale (its server radius is the 2 m foam splash).
      const scale = existing?.child ? 0.5 : (Number(event.radius) || 2.2) / 2.2;
      this._spawnBlast(x, y, z, style, scale);
      this._spawnPopLines(x, y, z, scale);
      return true;
    }
    this._spawnBlast(x, y, z, style, Number(event.radius) || style.grow * 12);
    return true;
  }

  /** One pooled burst of cartoon pop lines; the oldest burst is reused when all are live. */
  _spawnPopLines(x, y, z, scale) {
    const pop = this._popLines[this._popCursor];
    this._popCursor = (this._popCursor + 1) % this._popLines.length;
    pop.lines.position.set(x, y, z);
    pop.age = 0;
    pop.scale = Math.max(0.35, Math.min(2.2, scale));
    pop.spin = (x * 7.1 + z * 3.3) % (Math.PI * 2);
    pop.lines.visible = true;
    this._posePopLines(pop);
  }

  /** Grow the pop strokes outward in the camera plane for 110 ms, then fade them out. */
  _updatePopLines(step) {
    for (const pop of this._popLines) {
      if (!pop.lines.visible) continue;
      pop.age += step;
      if (pop.age >= POP_LINE_LIFE_S) { pop.lines.visible = false; continue; }
      this._posePopLines(pop);
    }
  }

  /**
   * Strokes snap from r .25-.45 out to .5-.9 (times the pop scale) on an ease-out,
   * thinning as they fly; the droplets ride just past every other stroke and keep
   * drifting while the burst fades.
   */
  _posePopLines(pop) {
    const grow = Math.min(1, pop.age / POP_LINE_GROW_S);
    const ease = 1 - (1 - grow) ** 3;
    if (this.camera) pop.lines.quaternion.copy(this.camera.quaternion);
    const strokes = pop.lines.children;
    for (let i = 0; i < POP_LINE_COUNT; i++) {
      // A slight twist off the even spacing so a burst never reads as a clock face.
      const a = pop.spin + i * Math.PI * 2 / POP_LINE_COUNT + (i % 2 ? 0.16 : -0.08);
      const jitter = (i % 2) * 0.2;
      const inner = (0.25 + jitter + 0.25 * ease) * pop.scale;
      const outer = (0.45 + jitter + (0.45 - jitter) * ease) * pop.scale;
      const stroke = strokes[i];
      const mid = (inner + outer) / 2;
      stroke.position.set(Math.cos(a) * mid, Math.sin(a) * mid, 0);
      stroke.rotation.z = a;
      stroke.scale.set(Math.max(0.01, outer - inner), (0.06 - 0.025 * ease) * pop.scale, 1);
    }
    const drift = Math.min(1, pop.age / POP_LINE_LIFE_S);
    for (let k = 0; k < POP_DROPLETS; k++) {
      const a = pop.spin + (2 * k) * Math.PI * 2 / POP_LINE_COUNT - 0.08;
      const r = (0.5 + 0.55 * ease + 0.15 * drift) * pop.scale;
      const droplet = strokes[POP_LINE_COUNT + k];
      droplet.position.set(Math.cos(a) * r, Math.sin(a) * r, 0);
      droplet.scale.setScalar((0.035 - 0.012 * drift) * pop.scale);
    }
    pop.material.opacity = grow < 1 ? 0.95
      : 0.95 * (1 - (pop.age - POP_LINE_GROW_S) / (POP_LINE_LIFE_S - POP_LINE_GROW_S));
  }

  _endGlaive(event, id, existing, own) {
    const heading = existing ? (() => {
      const speed = Math.hypot(existing.vx, existing.vy, existing.vz) || 1;
      return { x: existing.vx / speed, y: existing.vy / speed, z: existing.vz / speed };
    })() : null;
    this._removeProjectile(id);
    const x = Number(event?.x), y = Number(event?.y), z = Number(event?.z);
    if (event?.picked) {
      const pickup = this.glaivePickups.get(id);
      this.removeGlaivePickup(id);
      const at = [x, y, z].every(Number.isFinite) ? { x, y, z } : pickup;
      if (at) this._spawnBlast(at.x, at.y, at.z, BLAST_STYLE.glaive, 0.5);
      return true;
    }
    if (![x, y, z].every(Number.isFinite)) return false;
    if (event?.caught) {
      // Own catches are the viewmodel's job (horn clamp); others see a ring at the hand.
      if (!own) this._spawnBlast(x, y, z, BLAST_STYLE.glaiveCatch, 0.4);
      return true;
    }
    if (event?.embed || event?.reason === 'embed') {
      const lifeMs = Number(event.ms);
      return this.embedGlaive({ pid: id, ownerId: event.id ?? existing?.ownerId, x, y, z, n: event.n, own, heading,
        lifeMs: Number.isFinite(lifeMs) && lifeMs > 0 ? lifeMs : GLAIVE_RULES.regenMs });
    }
    this._spawnBlast(x, y, z, BLAST_STYLE.glaive, 0.9);
    return true;
  }

  /** One pooled blast (flash, ring, fireball, smoke, light, scorch) at a world point. */
  _spawnBlast(x, y, z, style, radius) {
    return this.explosions.spawn(x, y, z, style, radius, this.camera?.position);
  }

  _orientRocket(projectile) {
    const speed = Math.hypot(projectile.vx, projectile.vy, projectile.vz);
    if (speed < 1e-6) return;
    const target = this._aimTarget.set(
      projectile.x + projectile.vx / speed,
      projectile.y + projectile.vy / speed,
      projectile.z + projectile.vz / speed,
    );
    projectile.group.lookAt(target);
    // lookAt aims +z at the target; the model's nose points -z, so flip.
    projectile.group.rotateY(Math.PI);
  }

  update(dt) {
    const step = Math.max(0, Math.min(0.05, Number(dt) || 0));
    this._trailCandidates.length = 0;
    this._trailTokens = Math.min(ROCKET_TRAIL_BURST, this._trailTokens + step * ROCKET_TRAILS_PER_SECOND);
    for (const [id, projectile] of this.projectiles) {
      projectile.age += step;
      if (projectile.type === 'limpet') {
        this._poseMine(projectile.group, projectile, projectile.age >= projectile.armedAge);
      } else if (projectile.type === 'rocket') {
        stepRocket(projectile, step, this.raycast);
        projectile.group.position.set(projectile.x, projectile.y, projectile.z);
        this._orientRocket(projectile);
        const flicker = 0.8 + Math.sin(projectile.age * 90) * 0.2;
        projectile.group.userData.exhaust.scale.set(flicker, flicker, 0.8 + flicker * 0.4);
        if (this.onTrail && projectile.age - projectile.trailAt >= ROCKET_TRAIL_INTERVAL_S) {
          this._trailCandidates.push(projectile);
        }
        if (projectile.hit && !projectile.local && !projectile.chaos) projectile.fuse = Math.min(projectile.fuse, projectile.age + 0.25);
      } else if (projectile.type === 'mgl') {
        const before = projectile.bouncesLeft;
        stepMgl(projectile, step, this.raycast);
        this._orientRocket(projectile);
        if (projectile.bouncesLeft !== before) this.onBounce?.(projectile.x, projectile.y, projectile.z, 'mgl', projectile.hit);
        if (projectile.hitSolid && projectile.age >= projectile.armAge) {
          projectile.fuse = Math.min(projectile.fuse, projectile.age + 0.25);
        }
      } else if (projectile.type === 'bolt') {
        stepBolt(projectile, step, this.raycast, {
          onBounce: (contact) => {
            this._spawnBlast(contact.x, contact.y, contact.z, BLAST_STYLE.bolt, 0.6);
            this.onBounce?.(contact.x, contact.y, contact.z);
          },
        });
        this._orientRocket(projectile);
        // Authority owns bolt death (projectileExplode); the local view just keeps flying.
        if (projectile.hit && !projectile.local && !projectile.chaos) {
          projectile.fuse = Math.min(projectile.fuse, projectile.age + 0.25);
        }
      } else if (projectile.type === 'glaive') {
        this._stepGlaive(projectile, step);
      } else if (projectile.type === 'bubble') {
        if (!projectile.stuck) stepBubble(projectile, step, this.raycast);
        this._poseBubble(projectile, step);
        // Authority owns the pop (projectileExplode); a remote terrain contact only shortens the wait.
        if (projectile.hit && !projectile.local && !projectile.chaos) {
          projectile.fuse = Math.min(projectile.fuse, projectile.age + 0.25);
        }
      } else if (!projectile.stuck) {
        stepGrenade(projectile, step, this.isSolid);
        const spin = Math.min(1, Math.hypot(projectile.vx, projectile.vy, projectile.vz) / 6);
        projectile.group.rotation.x += step * 7.4 * spin;
        projectile.group.rotation.z += step * 5.2 * spin;
      }
      projectile.group.position.set(projectile.x, projectile.y, projectile.z);
      if (projectile.capMaterial) {
        // Fuse indicator: the cap strobes faster as detonation approaches.
        const remaining = Math.max(0, projectile.fuse - projectile.age);
        const rate = remaining < 0.7 ? 16 : remaining < 1.4 ? 8 : 4;
        const lit = Math.sin(projectile.age * rate * Math.PI) > 0;
        if (projectile.type === 'pulse') {
          projectile.capMaterial.opacity = lit ? 0.6 : 0.25;
          projectile.group.userData.halo.scale.setScalar(1.4 + Math.sin(projectile.age * 14) * 0.2);
        } else if (projectile.type === 'limpet') {
          projectile.capMaterial.color.setHex(projectile.age >= projectile.armedAge ? 0xff3428 : 0xe5ac42);
        } else if (projectile.type === 'molotov') {
          projectile.capMaterial.color.setHex(0xffac30);
          projectile.group.userData.flame.scale.setScalar(0.9 + Math.sin(projectile.age * 35) * 0.18);
        } else {
          projectile.capMaterial.color.setHex(lit ? CAP_LIT : CAP_DIM);
        }
      }
      if (projectile.local && projectile.age > LOCAL_CONFIRM_TIMEOUT_S) this._removeProjectile(id);
      else if (projectile.age > projectile.fuse + 1) this._removeProjectile(id);
    }

    const trails = this._trailCandidates;
    const emissions = Math.min(trails.length, Math.floor(this._trailTokens));
    for (let i = 0; i < emissions; i++) {
      const p = trails[(this._trailCursor + i) % trails.length];
      if (!this.projectiles.has(p.id)) continue;
      p.trailAt = p.age;
      this.onTrail(p.x, p.y, p.z, p);
      this._trailTokens--;
    }
    this._trailCursor = trails.length ? (this._trailCursor + emissions) % trails.length : 0;
    this._updateGlaivePickups(step);
    this._updateRocketBatches();
    // Blasts age first so the light pool sees this frame's envelope.
    this.explosions.update(step, this.camera?.position);
    this._updatePopLines(step);
    this._updateLights();
  }

  /**
   * Predicted RIPTIDE flight. Timers run on the disc's own age (authority updates and
   * `ph` correct a Chaos-lengthened out leg); the return leg steers at the owner's chest.
   * A predicted catch or back-leg wall contact parks the disc: only the authoritative
   * `projectileExplode` (caught/embed) resolves it, so the rig never catches early.
   */
  _stepGlaive(disc, step) {
    const spin = disc.group.userData.spin;
    if (disc.parked) {
      spin.rotation.y += step * GLAIVE_SPIN * 0.5;
      return;
    }
    if (disc.phase === 'out' && disc.age >= disc.outAge) this._flipGlaive(disc, 'time');
    if (disc.phase === 'out') this._seekGlaive(disc, step);
    const target = disc.phase === 'back' ? this._glaiveOwnerTarget(disc) : null;
    stepGlaive(disc, step, this.raycast, target, {
      onBounce: (contact) => {
        if (disc.own) this.onGlaiveFlip?.(disc, 'bounce');
        this._spawnBlast(contact.x, contact.y, contact.z, BLAST_STYLE.glaive, 0.6);
        this._spawnGlaiveCrescent(contact);
        this.onBounce?.(contact.x, contact.y, contact.z, 'glaive', contact);
      },
    });
    if (disc.caught || disc.hit) {
      // Hold here until authority resolves it; a lost event still times the disc out.
      disc.parked = true;
      if (disc.caught) disc.group.visible = disc.trail.mesh.visible = false;
      if (!disc.local) disc.fuse = Math.min(disc.fuse, disc.age + 0.6);
    }
    this._orientRocket(disc);
    // Bank into the return curve a little so the plate reads as a thrown disc.
    if (disc.phase === 'back') disc.group.rotateZ(0.35);
    spin.rotation.y += step * GLAIVE_SPIN;
    this._updateGlaiveTrail(disc);
    if (!disc.parked) this.onGlaiveFlight?.(disc);
  }

  /** Predicted out-leg seeking onto presented bodies; authority syncs correct the rest. */
  _seekGlaive(disc, step) {
    const bodies = this.getGlaiveSeekBodies?.(disc);
    if (!bodies?.length) return;
    glaiveSeek(disc, step, bodies, GLAIVE_RULES, (point) => {
      const dx = point.x - disc.x, dy = point.y - disc.y, dz = point.z - disc.z;
      const distance = Math.hypot(dx, dy, dz);
      return distance <= 0.18 || !this.raycast(disc.x, disc.y, disc.z,
        dx / distance, dy / distance, dz / distance, distance - 0.18);
    });
  }

  /** `point` lies within the catch reach (plus a latency margin) of the disc owner's chest. */
  _glaiveNearOwner(disc, point) {
    const target = this._glaiveOwnerTarget(disc);
    if (!target) return false;
    const reach = GLAIVE_RULES.catchRadius + GLAIVE_UNPARK_MARGIN;
    return Math.hypot(point[0] - target.x, point[1] - target.y, point[2] - target.z) <= reach;
  }

  /** The owner's chest: the camera eye for own discs, the presented avatar otherwise. */
  _glaiveOwnerTarget(disc) {
    const target = this._glaiveTarget;
    if (disc.own && this.camera) {
      target.x = this.camera.position.x;
      target.y = this.camera.position.y - GLAIVE_CHEST_DROP;
      target.z = this.camera.position.z;
      return target;
    }
    const owner = disc.ownerId && this.getEntityPosition ? this.getEntityPosition(disc.ownerId) : null;
    if (!owner) return null;
    target.x = owner.x;
    target.y = owner.y + EYE_HEIGHT - GLAIVE_CHEST_DROP;
    target.z = owner.z;
    return target;
  }

  /**
   * Magenta ribbon behind a disc: flat in the disc plane, fading to the tail. The out
   * leg draws it solid; the return leg breaks it into dashes that pulse and run toward
   * the disc, so a returning (more dangerous) disc reads at a glance.
   */
  _updateGlaiveTrail(disc) {
    const trail = disc.trail;
    if (!trail) return;
    const speed = Math.hypot(disc.vx, disc.vz);
    const rx = speed > 1e-4 ? -disc.vz / speed : 1;
    const rz = speed > 1e-4 ? disc.vx / speed : 0;
    const points = trail.points;
    const head = points[0];
    const moved = Math.hypot(disc.x - head.x, disc.y - head.y, disc.z - head.z);
    if (moved >= GLAIVE_TRAIL_STEP || points.length === 1) {
      points.unshift({ x: disc.x, y: disc.y, z: disc.z, rx, rz });
      if (points.length > GLAIVE_TRAIL_POINTS) points.pop();
    } else {
      head.x = disc.x; head.y = disc.y; head.z = disc.z; head.rx = rx; head.rz = rz;
    }
    const back = disc.phase === 'back';
    const pulse = back ? 0.75 + 0.25 * Math.sin(disc.age * 22) : 1;
    const { positions, colors } = trail;
    const count = points.length;
    let distance = 0;
    for (let i = 0; i < count; i++) {
      const p = points[i];
      if (i > 0) {
        const q = points[i - 1];
        distance += Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
      }
      const fade = count > 1 ? (1 - i / (count - 1)) ** 1.5 : 0;
      const width = GLAIVE_TRAIL_HALF_WIDTH * (0.35 + 0.65 * fade);
      const dash = back ? (Math.sin(distance * 7 + disc.age * 34) > -0.1 ? 1 : 0.12) : 1;
      const k = fade * dash * pulse;
      const o = i * 6;
      positions[o] = p.x + p.rx * width; positions[o + 1] = p.y; positions[o + 2] = p.z + p.rz * width;
      positions[o + 3] = p.x - p.rx * width; positions[o + 4] = p.y; positions[o + 5] = p.z - p.rz * width;
      // #ff3fd0 scaled by the fade; additive blending turns black into clear.
      colors[o] = colors[o + 3] = k;
      colors[o + 1] = colors[o + 4] = k * 0.25;
      colors[o + 2] = colors[o + 5] = k * 0.82;
    }
    trail.geometry.attributes.position.needsUpdate = true;
    trail.geometry.attributes.color.needsUpdate = true;
    trail.geometry.setDrawRange(0, Math.max(0, count - 1) * 6);
  }

  /** Magenta crescent scorch where a disc bit into a wall; fades over two seconds. */
  _spawnGlaiveCrescent(contact) {
    if (!Number.isFinite(contact?.nx)) return;
    this._glaiveDecals ||= [];
    if (this._glaiveDecals.length >= 24) this._disposeGlaiveDecal(this._glaiveDecals.shift());
    const material = new THREE.MeshBasicMaterial({
      color: GLAIVE_COLOR, transparent: true, opacity: 0.9, toneMapped: false,
      depthWrite: false, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    const mesh = new THREE.Mesh(this.glaiveCrescentGeometry, material);
    mesh.position.set(contact.x + contact.nx * 0.01, contact.y + contact.ny * 0.01, contact.z + contact.nz * 0.01);
    mesh.lookAt(mesh.position.x + contact.nx, mesh.position.y + contact.ny, mesh.position.z + contact.nz);
    mesh.rotateZ(Math.random() * Math.PI * 2);
    mesh.renderOrder = 6;
    this.scene.add(mesh);
    this._glaiveDecals.push({ mesh, material, age: 0, life: 2 });
  }

  _disposeGlaiveDecal(decal) {
    this.scene.remove(decal.mesh);
    decal.material.dispose();
  }

  /**
   * An embedded RIPTIDE disc from a `projectileExplode` with `embed`: the plate stands
   * edge-first in the wall at the contact, quivers out its impact and waits for its
   * owner. `n` is the wall normal when the event carries it; otherwise the disc's own
   * last heading stands in. The magenta outline is drawn only when `own`.
   */
  embedGlaive({ pid, ownerId = null, x, y, z, n = null, own = false, lifeMs = GLAIVE_RULES.regenMs, heading = null }) {
    const id = String(pid ?? '');
    if (!id || ![x, y, z].every(Number.isFinite)) return false;
    this.removeGlaivePickup(id);
    let nx = 0, ny = 0, nz = 0;
    if (Array.isArray(n) && n.length === 3 && n.every(Number.isFinite)) [nx, ny, nz] = n;
    else if (heading) { nx = -heading.x; ny = -heading.y; nz = -heading.z; }
    let length = Math.hypot(nx, ny, nz);
    if (!(length > 1e-6)) { nx = 0; ny = 1; nz = 0; length = 1; }
    nx /= length; ny /= length; nz /= length;
    // Plate plane holds the wall normal and a horizontal tangent: the disc stands in
    // the wall the way it flew into it. A floor/ceiling hit uses world x instead.
    const up = Math.abs(ny) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const normal = new THREE.Vector3(nx, ny, nz);
    const tangent = new THREE.Vector3().crossVectors(up, normal).normalize();
    const plateNormal = new THREE.Vector3().crossVectors(normal, tangent).normalize();
    const group = new THREE.Group();
    group.position.set(
      x + nx * GLAIVE_DISC_R * GLAIVE_EMBED_PROUD,
      y + ny * GLAIVE_DISC_R * GLAIVE_EMBED_PROUD,
      z + nz * GLAIVE_DISC_R * GLAIVE_EMBED_PROUD,
    );
    group.quaternion.setFromRotationMatrix(this._glaiveBasis.makeBasis(tangent, plateNormal, normal));
    const quiver = new THREE.Group();
    // Pivot at the wall so the proud half wags about the bite point.
    quiver.position.z = -GLAIVE_DISC_R * GLAIVE_EMBED_PROUD;
    const plate = new THREE.Group();
    plate.position.z = GLAIVE_DISC_R * GLAIVE_EMBED_PROUD;
    plate.add(
      new THREE.Mesh(this.glaiveDiscGeometry, this.glaiveBladeMaterial),
      new THREE.Mesh(this.glaiveHubGeometry, this.glaiveHubMaterial),
      new THREE.Mesh(this.glaiveRimGeometry, this.glaiveGlowMaterial),
    );
    if (own) {
      const outline = new THREE.Mesh(this.glaiveDiscGeometry, this.glaiveOutlineMaterial);
      outline.scale.set(1.14, 2.2, 1.14);
      const ghost = new THREE.Mesh(this.glaiveDiscGeometry, this.glaiveGhostMaterial);
      ghost.renderOrder = 10;
      plate.add(outline, ghost);
    }
    quiver.add(plate);
    group.add(quiver);
    this.scene.add(group);
    const life = Math.max(0.1, (Number(lifeMs) || GLAIVE_RULES.regenMs) / 1000);
    this.glaivePickups.set(id, {
      id, ownerId: ownerId == null ? null : String(ownerId), group, quiver, own: !!own, age: 0, life, x, y, z,
    });
    this._spawnGlaiveCrescent({ x, y, z, nx, ny, nz });
    return true;
  }

  /** Drop an embedded disc (taken by its owner, fabricated away or cleared by authority). */
  removeGlaivePickup(pid) {
    const pickup = this.glaivePickups.get(String(pid ?? ''));
    if (!pickup) return false;
    this.scene.remove(pickup.group);
    this.glaivePickups.delete(pickup.id);
    return true;
  }

  /**
   * One owner's embedded discs from a `glaiveStock` event: rows `{pid, x, y, z, regen}`
   * replace that owner's set (a missing pid was picked up, fabricated away or
   * trimmed); a row not yet shown (late join) is embedded without its wall normal.
   */
  syncGlaivePickups(ownerId, rows, own = false) {
    if (!Array.isArray(rows)) return;
    const owner = ownerId == null ? null : String(ownerId);
    const active = new Set();
    for (const row of rows) {
      const id = String(row?.pid ?? '');
      if (!id) continue;
      active.add(id);
      const regen = Number(row.regen);
      const existing = this.glaivePickups.get(id);
      if (existing) {
        if (Number.isFinite(regen)) existing.life = existing.age + regen / 1000;
        continue;
      }
      this.embedGlaive({ pid: id, ownerId: owner, x: Number(row.x), y: Number(row.y), z: Number(row.z),
        own, lifeMs: Number.isFinite(regen) && regen > 0 ? regen : GLAIVE_RULES.regenMs });
    }
    for (const pickup of [...this.glaivePickups.values()]) {
      if (pickup.ownerId === owner && !active.has(pickup.id)) this.removeGlaivePickup(pickup.id);
    }
  }

  _updateGlaivePickups(step) {
    for (const pickup of this.glaivePickups.values()) {
      pickup.age += step;
      // Decaying twang after the bite, then a faint idle hum so it still reads as live.
      const twang = 0.22 * Math.exp(-pickup.age * 3.2) * Math.sin(pickup.age * 58);
      const hum = 0.012 * Math.sin(pickup.age * 9);
      pickup.quiver.rotation.x = twang + hum;
      pickup.quiver.rotation.y = twang * 0.35;
      // Authority normally removes it (pickup/fabricate); this only guards a lost event.
      if (pickup.age > pickup.life + 1) this.removeGlaivePickup(pickup.id);
    }
    const decals = this._glaiveDecals;
    if (!decals) return;
    for (let i = decals.length - 1; i >= 0; i--) {
      const decal = decals[i];
      decal.age += step;
      decal.material.opacity = 0.9 * Math.max(0, 1 - decal.age / decal.life);
      if (decal.age >= decal.life) {
        this._disposeGlaiveDecal(decal);
        decals.splice(i, 1);
      }
    }
  }

  _updateLights() {
    const nearest = this._lightCandidates;
    nearest.length = 0;
    const eye = this.camera?.position;
    // Candidates rank by what they add to the view: intensity x envelope x
    // range^2 / (range^2 + distance^2), with a strong bonus for blasts. A live
    // rocket blast beats a pop of weak bubble lights at the viewer's feet, a
    // blast at the far end of the map loses to a rocket passing the camera once
    // its flash has decayed, and equal lights still rank nearest first. The
    // pool size never changes. `lightRank` sorts ascending, so it is negated.
    const blasts = this.explosions.blasts;
    for (let b = 0; b < blasts.length; b++) {
      const blast = blasts[b];
      const level = this.explosions.lightLevel(blast);
      if (level <= 0) continue;
      const glow = blast.style.light;
      blast.lightRank = -8 * lightWeight(glow.intensity * level, glow.range, blast, eye);
      this._insertLightCandidate(blast);
    }
    for (const p of this.projectiles.values()) {
      if (p.type !== 'rocket' && p.type !== 'pulse' && p.type !== 'bolt' && p.type !== 'glaive') continue;
      if (p.parked) continue;
      p.lightRank = p.type === 'rocket' ? -lightWeight(1.84, 7, p, eye)
        : p.type === 'pulse' ? -lightWeight(0.9, 5, p, eye) : -lightWeight(p.type === 'glaive' ? 0.8 : 1, 4, p, eye);
      this._insertLightCandidate(p);
    }
    for (let i = 0; i < this._lights.length; i++) {
      const light = this._lights[i], p = nearest[i];
      light.intensity = 0;
      if (!p) continue;
      if (p.isBlast) {
        const glow = p.style.light;
        // Lifted off the burst point so the floor it sits on catches the flash.
        light.position.set(p.x, p.y + 0.6, p.z);
        light.color.setHex(glow.color);
        light.distance = glow.range;
        light.intensity = glow.intensity * this.explosions.lightLevel(p) * (1 + Math.sin(p.age * 70) * 0.08);
        continue;
      }
      light.position.set(p.x, p.y, p.z);
      light.color.setHex(p.type === 'rocket' ? 0xffa040 : p.type === 'pulse' ? 0x59e8ff
        : p.type === 'glaive' ? GLAIVE_COLOR : 0x7dfcff);
      light.distance = p.type === 'rocket' ? 7 : p.type === 'pulse' ? 5 : 4;
      light.intensity = p.type === 'rocket' ? 1.84 + Math.sin(p.age * 90) * 0.16
        : p.type === 'pulse' ? 0.9 : p.type === 'glaive' ? 0.8 : 1;
    }
  }

  /** Sorted insert into the bounded light candidate list, without splice garbage. */
  _insertLightCandidate(candidate) {
    const nearest = this._lightCandidates;
    let i = nearest.length;
    while (i > 0 && nearest[i - 1].lightRank > candidate.lightRank) i--;
    if (i >= PROJECTILE_LIGHT_LIMIT) return;
    const end = Math.min(nearest.length, PROJECTILE_LIGHT_LIMIT - 1);
    for (let j = end; j > i; j--) nearest[j] = nearest[j - 1];
    nearest[i] = candidate;
    if (nearest.length > PROJECTILE_LIGHT_LIMIT) nearest.length = PROJECTILE_LIGHT_LIMIT;
  }

  _removeProjectile(id) {
    const projectile = this.projectiles.get(id);
    if (!projectile) return false;
    this.scene.remove(projectile.group);
    if (projectile.trail) {
      this.scene.remove(projectile.trail.mesh);
      projectile.trail.geometry.dispose();
    }
    projectile.capMaterial?.dispose();
    for (const material of projectile.group.userData.authoredMaterials || []) material.dispose();
    this.projectiles.delete(id);
    return true;
  }

  clear() {
    for (const id of this.projectiles.keys()) this._removeProjectile(id);
    for (const id of [...this.glaivePickups.keys()]) this.removeGlaivePickup(id);
    for (const decal of this._glaiveDecals || []) this._disposeGlaiveDecal(decal);
    if (this._glaiveDecals) this._glaiveDecals.length = 0;
    for (const mesh of this._rocketBatches) mesh.count = 0;
    this.explosions.clear();
    for (const pop of this._popLines) { pop.lines.visible = false; pop.age = Infinity; }
    for (const light of this._lights) light.intensity = 0;
  }

  dispose() {
    for (const mesh of this._rocketBatches) { this.scene.remove(mesh); mesh.dispose(); }
    for (const light of this._lights) this.scene.remove(light);
    this._lightCandidates.length = 0;
    this._trailCandidates.length = 0;
    for (const id of Array.from(this.projectiles.keys())) this._removeProjectile(id);
    for (const id of [...this.glaivePickups.keys()]) this.removeGlaivePickup(id);
    for (const decal of this._glaiveDecals || []) this._disposeGlaiveDecal(decal);
    if (this._glaiveDecals) this._glaiveDecals.length = 0;
    this.explosions.dispose();
    for (const pop of this._popLines) {
      this.scene.remove(pop.lines);
      pop.material.dispose();
    }
    this.popStrokeGeometry.dispose();
    this.scene.remove(this.previewGhost, this.previewLine, this.previewTail, this.landingRing, ...this.bounceDots);
    this.scene.remove(this.minePreview.group);
    this.minePreview.capMaterial.dispose();
    for (const material of this.minePreview.group.userData.authoredMaterials || []) material.dispose();
    this.claymoreLaserGeometry.dispose();
    this.claymoreLaserMaterial.dispose();
    this.previewLine.geometry.dispose();
    this.previewTail.geometry.dispose();
    this.previewMaterial.dispose();
    this.previewGhostMaterial.dispose();
    this.previewTailMaterial.dispose();
    this.landingRing.geometry.dispose();
    this.landingMaterial.dispose();
    this.landingDisc.geometry.dispose();
    this.landingDiscMaterial.dispose();
    this.bounceDotGeometry.dispose();
    this.bounceDotMaterial.dispose();
    for (const geometry of [
      this.fragGeometry, this.capGeometry, this.limpetGeometry, this.pulseGeometry,
      this.grenadeRibGeometry, this.grenadeBandGeometry,
      this.bottleGeometry, this.bottleNeckGeometry, this.bottleFlameGeometry,
      this.rocketBodyGeometry, this.rocketNoseGeometry, this.exhaustGeometry,
      this.mglBodyGeometry, this.mglNoseGeometry, this.mglBandGeometry, this.bubbleGeometry,
      this.bubbleShineGeometry,
      this.glaiveDiscGeometry, this.glaiveHubGeometry, this.glaiveRimGeometry, this.glaiveCrescentGeometry,
    ]) geometry.dispose();
    for (const material of [
      this.fragMaterial, this.limpetMaterial, this.pulseMaterial, this.rocketMaterial,
      this.bottleMaterial, this.bottleLabelMaterial,
      this.rocketNoseMaterial, this.exhaustMaterial, this.boltCoreMaterial, this.boltGlowMaterial,
      this.mglBodyMaterial, this.mglNoseMaterial, this.mglBandMaterial,
      ...this.bubbleFilms, ...this.bubbleTellFilms, this.bubbleInnerMaterial, this.bubbleShineMaterial,
      this.glaiveBladeMaterial, this.glaiveHubMaterial, this.glaiveGlowMaterial, this.glaiveTrailMaterial,
      this.glaiveOutlineMaterial, this.glaiveGhostMaterial,
    ]) material.dispose();
  }
}
