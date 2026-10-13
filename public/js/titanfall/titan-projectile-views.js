// Titan projectile views (docs/titanfall.md §6.1, §7.3, owned by WP5): `t203`,
// `leadwall`, `cluster`, `flightRocket`.
//
// Each view inserts a record into ProjectileFX's own flight table (the shared
// rocket integrator `stepRocket` flies it with the event's gravity, `explode`
// or the fuse removes it), with a WP5 voxel-free body: the thermite shell is a
// molten orange slug with an ember wake, leadwall pellets are hot yellow
// streaks, cluster missiles and flight-core rockets are small rockets with
// orange / ion-blue exhaust. `frame` adds the per-type wakes and the delayed
// cluster sub-bursts; `onEvent(projectileExplode)` adds the thermite splash.
// Meshes share module geometry and materials (never in `authoredMaterials`,
// so ProjectileFX never disposes them).
//
//   PROJECTILE_VIEWS        { [eventType]: { launch(fx, event, { local, fromSelf }) -> boolean } },
//                           merged by projectile-views.js and consulted by ProjectileFX.launch
//   client-module contract  init?(app, client), tick(snapshot, dt), frame(dt, ctx), onEvent(event), dispose()
import * as THREE from '../vendor/three.module.js';
import { TITAN_WEAPON_META, TITAN_ABILITIES } from '../../../shared/titan-contract.js';

/** Presentation tuning per view (fuse fallbacks in seconds when the event has no `fuse`). */
export const TITAN_PROJECTILE_LOOK = Object.freeze({
  t203: Object.freeze({ fuse: 4, emberRate: 34 }),
  leadwall: Object.freeze({ fuse: 1.4 }),
  cluster: Object.freeze({ fuse: 6, flameRate: 30 }),
  flightRocket: Object.freeze({ fuse: 5, flameRate: 40 }),
});
const CLUSTER = TITAN_ABILITIES.titan_northstar.ordnance;   // { bursts, seconds }

const sinks = { particles: null, audio: null };
const tracked = new Map();     // record id -> { fx, record, type, carry }
const pending = [];            // cluster sub-bursts { at, x, y, z }
let clock = 0;

let kit = null;
/** Shared geometry and materials (built on first launch). */
function parts() {
  if (kit) return kit;
  const glow = (color, opacity) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending,
    depthWrite: false, toneMapped: false });
  const solid = color => new THREE.MeshLambertMaterial({ color });
  // Cylinders/cones along -Z (the flight nose): ProjectileFX._orientRocket aims -Z along the velocity.
  const along = geometry => geometry.rotateX(-Math.PI / 2);
  kit = {
    slugCore: new THREE.IcosahedronGeometry(0.2, 1),
    slugGlow: new THREE.IcosahedronGeometry(0.46, 1),
    slugTail: new THREE.BoxGeometry(0.16, 0.16, 1.3).translate(0, 0, 0.62),
    pellet: new THREE.BoxGeometry(0.07, 0.07, 1.7).translate(0, 0, 0.75),
    body: along(new THREE.CylinderGeometry(0.11, 0.11, 0.9, 8)),
    nose: along(new THREE.ConeGeometry(0.11, 0.26, 8)).translate(0, 0, -0.58),
    flame: along(new THREE.ConeGeometry(0.13, 0.7, 8, 1, true)).rotateY(Math.PI).translate(0, 0, 0.8),
    smallBody: along(new THREE.CylinderGeometry(0.08, 0.08, 0.6, 6)),
    smallNose: along(new THREE.ConeGeometry(0.08, 0.2, 6)).translate(0, 0, -0.4),
    smallFlame: along(new THREE.ConeGeometry(0.1, 0.55, 6, 1, true)).rotateY(Math.PI).translate(0, 0, 0.58),
    molten: new THREE.MeshBasicMaterial({ color: 0xffc070, toneMapped: false }),
    thermite: glow(0xff6a1a, 0.5),
    tail: glow(0xff8a2a, 0.6),
    lead: glow(0xffd27a, 0.85),
    casing: solid(0x3a3f46),
    warhead: solid(0xb53a26),
    ionCasing: solid(0x5d6a78),
    ionTip: solid(0xd8e2ee),
    orange: glow(0xff8c3a, 0.85),
    ion: glow(0x8fdcff, 0.9),
  };
  return kit;
}

function build(type) {
  const k = parts(), group = new THREE.Group();
  group.name = `titan-projectile-${type}`;
  const mesh = (geometry, material) => { const m = new THREE.Mesh(geometry, material); group.add(m); return m; };
  if (type === 't203') {
    mesh(k.slugCore, k.molten);
    group.userData.glow = mesh(k.slugGlow, k.thermite);
    mesh(k.slugTail, k.tail);
  } else if (type === 'leadwall') {
    mesh(k.pellet, k.lead);
  } else if (type === 'cluster') {
    mesh(k.body, k.casing); mesh(k.nose, k.warhead);
    group.userData.exhaust = mesh(k.flame, k.orange);
  } else {
    mesh(k.smallBody, k.ionCasing); mesh(k.smallNose, k.ionTip);
    group.userData.exhaust = mesh(k.smallFlame, k.ion);
  }
  return group;
}

function launcher(type) {
  return {
    launch(fx, event, { local = false } = {}) {
      if (!fx?.projectiles || !fx.scene) return false;
      const values = [...event.o, ...event.v].map(Number);
      if (!values.every(Number.isFinite)) return false;
      if (!local && (event.pid == null || fx.projectiles.has(String(event.pid)))) return false;
      const id = local ? `local-${++fx._localSeq}` : String(event.pid);
      const group = build(type);
      group.position.set(values[0], values[1], values[2]);
      fx.scene.add(group);
      const fuseMs = Number(event.fuse), g = Number(event.g);
      const record = {
        id, type, group, capMaterial: null,
        x: values[0], y: values[1], z: values[2], vx: values[3], vy: values[4], vz: values[5],
        age: 0, fuse: Number.isFinite(fuseMs) && fuseMs > 0 ? fuseMs / 1000 : TITAN_PROJECTILE_LOOK[type].fuse,
        bouncesLeft: 0, launchBounceBudget: 0, chaos: 0, child: false, armAge: 0, local, stuck: false,
        // Flown by ProjectileFX's vehicle-shell branch (stepRocket with this gravity).
        gravity: Number.isFinite(g) ? g : TITAN_WEAPON_META[type]?.gravity ?? 0, vehicleShell: true,
        // Rockets leave ProjectileFX's smoke trail; the slug and the pellets never do.
        trailAt: type === 'cluster' || type === 'flightRocket' ? 0 : Infinity,
      };
      fx.projectiles.set(id, record);
      fx._orientRocket?.(record);
      tracked.set(id, { fx, record, type, carry: 0 });
      return true;
    },
  };
}

let warm = null;
/** Hidden copies of every titan projectile view: titan-presentation.js hangs them in the shader warm-up. */
export function warmupRoot() {
  if (warm) return warm;
  warm = new THREE.Group();
  warm.name = 'titan-projectile-shader-warmup';
  warm.visible = false;
  for (const type of ['t203', 'leadwall', 'cluster', 'flightRocket']) warm.add(build(type));
  warm.traverse(node => { node.frustumCulled = false; });
  return warm;
}

export const PROJECTILE_VIEWS = Object.freeze({
  t203: Object.freeze(launcher('t203')),
  leadwall: Object.freeze(launcher('leadwall')),
  cluster: Object.freeze(launcher('cluster')),
  flightRocket: Object.freeze(launcher('flightRocket')),
});

/**
 * { particles? (ParticleField), audio? (VehicleAudio) }: the wake and splash sink and the impact
 * and ricochet sounds (the match sets them in init()).
 */
export function setProjectileSinks({ particles = null, audio = null } = {}) { sinks.particles = particles || null; sinks.audio = audio || null; }

const emit = (kind, pos, params) => sinks.particles?.emit?.(kind, pos, params);
const hash = id => { let h = 2166136261; for (const c of String(id)) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };

export function init(app, client) { setProjectileSinks({ particles: app?.particleField ?? null, audio: app?.vehicleAudio ?? null }); }
export function tick(snapshot, dt) {}

/** Wakes of the live titan projectiles and the cluster sub-bursts. */
export function frame(dt, ctx) {
  const step = Math.max(0, Math.min(0.25, Number.isFinite(dt) ? dt : 0));
  clock += step;
  for (const [id, entry] of tracked) {
    const { fx, record, type } = entry;
    if (fx.projectiles.get(id) !== record) { tracked.delete(id); continue; }
    const pos = [record.x, record.y, record.z];
    const back = Math.hypot(record.vx, record.vy, record.vz) || 1;
    const dir = [-record.vx / back, -record.vy / back, -record.vz / back];
    if (type === 't203') {
      record.group.userData.glow?.scale.setScalar(0.9 + Math.sin(record.age * 40) * 0.15);
      entry.carry += step * TITAN_PROJECTILE_LOOK.t203.emberRate;
      const n = Math.floor(entry.carry); entry.carry -= n;
      if (n) { emit('ember', pos, { count: n, dir, speed: 1.5, spread: 0.6 }); emit('fire', pos, { count: 1, dir, speed: 0.6, scale: 0.4, life: 0.2 }); }
    } else if (type === 'cluster' || type === 'flightRocket') {
      const flame = record.group.userData.exhaust, f = 0.8 + Math.sin(record.age * 90) * 0.2;
      flame?.scale.set(f, f, 0.8 + f * 0.4);
      entry.carry += step * TITAN_PROJECTILE_LOOK[type].flameRate;
      const n = Math.floor(entry.carry); entry.carry -= n;
      if (n) emit('fire', pos, { count: n, dir, speed: 0.4, scale: 0.35, life: 0.3,
        ...(type === 'flightRocket' ? { color0: [0.7, 1.5, 2.6], color1: [0.3, 0.6, 1.6] } : {}) });
    }
  }
  for (let i = pending.length - 1; i >= 0; i--) {
    const burst = pending[i];
    if (clock < burst.at) continue;
    pending.splice(i, 1);
    emit('fire', [burst.x, burst.y, burst.z], { count: 3, speed: 0.6, scale: 1.6, life: 0.3, alpha: 0.7 });
    emit('spark', [burst.x, burst.y, burst.z], { count: 10, speed: 7, spread: 1 });
    emit('smoke', [burst.x, burst.y, burst.z], { count: 3, speed: 1.2, scale: 1.1 });
  }
}

/**
 * projectileExplode of a titan projectile: the thermite splash and burst, the cluster sub-bursts,
 * pellet hits and rocket pops; projectileUpdate of a Leadwall pellet: its ricochet off a voxel.
 */
export function onEvent(event) {
  if (event?.kind === 'projectileUpdate') { ricochet(event); return; }
  if (event?.kind !== 'projectileExplode' || !Object.hasOwn(PROJECTILE_VIEWS, event.type)) return;
  const x = Number(event.x), y = Number(event.y), z = Number(event.z);
  if (![x, y, z].every(Number.isFinite)) return;
  const at = [x, y, z];
  if (event.type === 't203') {
    // Thermite: 0xffb347 core to 0xff5a10 edge, additive capped at 0.55 (no white clipping),
    // 2.5-3.5 m flickering tongues, a grey-black smoke layer and embers.
    const hot = { color0: [1.0, 0.7, 0.28], color1: [1.0, 0.35, 0.06], alpha: 0.55 };
    emit('fire', at, { count: 16, dir: [0, 1, 0], speed: 3, scale: 1.8, spread: 1.1, ...hot });
    emit('ember', at, { count: 26, dir: [0, 1, 0], speed: 6, spread: 1.2 });
    emit('smoke', at, { count: 6, dir: [0, 1, 0], speed: 1.6, scale: 1.4, alpha: 0.5, color0: [0.16, 0.11, 0.08], color1: [0.08, 0.07, 0.06] });
    sinks.particles?.addEmitter?.({ kind: 'fire', pos: at, rate: 30, until: 1.4, params: { dir: [0, 1, 0], speed: 1.6, scale: 2.2, life: 1.6, spread: 0.6, jitter: 0.8, ...hot } });
    sinks.particles?.addEmitter?.({ kind: 'smoke', pos: [x, y + 2.5, z], rate: 5, until: 1.6, params: { dir: [0, 1, 0], speed: 0.9, scale: 0.8, alpha: 0.4, color0: [0.16, 0.11, 0.08], color1: [0.08, 0.07, 0.06] } });
    // The blast flash and a ring of hot slag thrown low.
    emit('muzzle', at, { count: 2, scale: 3.2, near: false, color0: [5, 2.6, 0.8], color1: [2.4, 0.7, 0.1] });
    emit('spark', at, { count: 30, dir: [0, 1, 0], speed: 1.3, spread: 1.5, color0: [4, 2.2, 0.6], color1: [2.2, 0.6, 0.08] });
    sinks.audio?.titanImpact?.('t203', at);
  } else if (event.type === 'cluster') {
    // The cluster keeps bursting around the impact (CLUSTER.bursts over CLUSTER.seconds).
    let seed = hash(event.pid ?? `${x},${z}`);
    const rand = () => ((seed = Math.imul(seed ^ (seed >>> 15), 2246822519) >>> 0) / 4294967296);
    for (let i = 0; i < CLUSTER.bursts; i++) {
      const a = rand() * Math.PI * 2, r = 0.8 + rand() * 2.6;
      pending.push({ at: clock + (i + rand() * 0.6) * (CLUSTER.seconds / CLUSTER.bursts), x: x + Math.cos(a) * r, y: y + 0.3 + rand(), z: z + Math.sin(a) * r });
    }
  } else if (event.type === 'leadwall') {
    // Radius 0: the pellet ran out of range in the air.
    if (!(Number(event.radius) > 0)) return;
    emit('spark', at, { count: 6, speed: 3, spread: 0.9 });
    emit('dust', at, { count: 1, speed: 0.6, scale: 0.4 });
    sinks.audio?.titanImpact?.('leadwall', at);
  } else {
    emit('fire', at, { count: 3, speed: 0.5, scale: 1.2, life: 0.3, alpha: 0.7, color0: [0.7, 1.5, 2.6], color1: [0.3, 0.6, 1.6] });
  }
}

/** A Leadwall pellet off a voxel (projectileUpdate of a tracked pellet): a spark spray and the whine. */
function ricochet(event) {
  const entry = tracked.get(String(event.pid));
  const o = Array.isArray(event.o) ? event.o.map(Number) : null;
  if (entry?.type !== 'leadwall' || !o || !o.every(Number.isFinite)) return;
  const v = Array.isArray(event.v) ? event.v.map(Number) : [0, 1, 0];
  emit('spark', o, { count: 8, dir: v.every(Number.isFinite) ? v : [0, 1, 0], speed: 2.4, spread: 0.6 });
  sinks.audio?.titanRicochet?.(o);
}

export function dispose() {
  tracked.clear();
  pending.length = 0;
  sinks.particles = null;
  sinks.audio = null;
}
