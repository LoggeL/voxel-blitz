// Pilot AT projectile views (docs/titanfall.md §6.1, owned by WP4): `archer`, `arcball`.
//
// Each view inserts a record into ProjectileFX's own flight table, flown by its
// vehicle-shell branch (the shared rocket integrator `stepRocket` with gravity 0);
// authority corrects it with `projectileUpdate` (the archer's guidance turns) and
// ends it with `projectileExplode`. The ARCHER is a slim grey missile with tan
// band, cyan seeker tip and an orange motor (ProjectileFX adds its smoke trail);
// the THUNDERBOLT arc orb is a white-blue core in an additive shell and a slowly
// turning wire cage that crackles sparks. Authoritative `arcZap` events
// ({ pid, o, to: [[x, y, z]...] }) draw short jagged arcs from the orb to every
// struck target. Meshes share module geometry and materials (never in
// `authoredMaterials`, so ProjectileFX never disposes them).
//
//   PROJECTILE_VIEWS        { [eventType]: { launch(fx, event, { local, fromSelf }) -> boolean } },
//                           merged by projectile-views.js and consulted by ProjectileFX.launch
//   client-module contract  init?(app, client), tick(snapshot, dt), frame(dt, ctx), onEvent(event), dispose()
import * as THREE from '../vendor/three.module.js';

/** Presentation tuning (fuse fallbacks in seconds when the event has no `fuse`). */
export const PILOT_PROJECTILE_LOOK = Object.freeze({
  archer: Object.freeze({ fuse: 3.4, flameRate: 34 }),
  arcball: Object.freeze({ fuse: 2.7, sparkRate: 26 }),
  arc: Object.freeze({ life: 0.18, segments: 9, jitter: 0.32, pool: 16, burst: 5, burstReach: 3 }),
});
const ARC = PILOT_PROJECTILE_LOOK.arc;

const sinks = { particles: null, scene: null };
const tracked = new Map();     // record id -> { fx, record, type, carry }
let arcs = [];                 // pooled arc lines { line, positions, from, to, age, seed }
let arcCursor = 0;
let sfx = null;

let kit = null;
/** Shared geometry and materials (built on first launch). */
function parts() {
  if (kit) return kit;
  const glow = (color, opacity) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending,
    depthWrite: false, toneMapped: false });
  // Cylinders/cones along -Z: ProjectileFX._orientRocket aims -Z (the stock rocket nose) along the velocity.
  const along = geometry => geometry.rotateX(-Math.PI / 2);
  kit = {
    body: along(new THREE.CylinderGeometry(0.075, 0.075, 0.8, 10)),
    band: along(new THREE.CylinderGeometry(0.078, 0.078, 0.1, 10)).translate(0, 0, -0.18),
    nose: along(new THREE.ConeGeometry(0.075, 0.24, 10)).translate(0, 0, -0.52),
    seeker: new THREE.SphereGeometry(0.03, 8, 6).translate(0, 0, -0.64),
    fin: new THREE.BoxGeometry(0.012, 0.24, 0.14).translate(0, 0, 0.32),
    flame: along(new THREE.ConeGeometry(0.1, 0.75, 8, 1, true)).rotateY(Math.PI).translate(0, 0, 0.78),
    orbCore: new THREE.IcosahedronGeometry(0.15, 2),
    orbShell: new THREE.IcosahedronGeometry(0.34, 2),
    orbCage: new THREE.IcosahedronGeometry(0.5, 0),
    casing: new THREE.MeshLambertMaterial({ color: 0x4a5058 }),
    tan: new THREE.MeshLambertMaterial({ color: 0xb09a72 }),
    cyan: new THREE.MeshBasicMaterial({ color: 0x4ee6ff, toneMapped: false }),
    motor: glow(0xff9a40, 0.85),
    core: new THREE.MeshBasicMaterial({ color: new THREE.Color(0xe8f0ff).multiplyScalar(2.2), toneMapped: false }),
    shell: glow(0x7aa8ff, 0.45),
    cage: new THREE.MeshBasicMaterial({ color: 0xb8ccff, wireframe: true, transparent: true, opacity: 0.55,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
    arc: new THREE.LineBasicMaterial({ color: new THREE.Color(0xc8dcff).multiplyScalar(2), transparent: true, opacity: 1,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
  };
  return kit;
}

function build(type) {
  const k = parts(), group = new THREE.Group();
  group.name = `pilot-projectile-${type}`;
  const mesh = (geometry, material) => { const m = new THREE.Mesh(geometry, material); group.add(m); return m; };
  if (type === 'archer') {
    mesh(k.body, k.casing); mesh(k.band, k.tan); mesh(k.nose, k.casing); mesh(k.seeker, k.cyan);
    for (let i = 0; i < 4; i++) mesh(k.fin, k.casing).rotation.z = Math.PI / 4 + i * Math.PI / 2;
    group.userData.exhaust = mesh(k.flame, k.motor);
  } else {
    mesh(k.orbCore, k.core);
    group.userData.shell = mesh(k.orbShell, k.shell);
    group.userData.cage = mesh(k.orbCage, k.cage);
  }
  return group;
}

function launcher(type) {
  return {
    launch(fx, event, { local = false } = {}) {
      if (!fx?.projectiles || !fx.scene || !Array.isArray(event?.o) || !Array.isArray(event?.v)) return false;
      const values = [...event.o, ...event.v].map(Number);
      if (values.length !== 6 || !values.every(Number.isFinite)) return false;
      if (!local && (event.pid == null || fx.projectiles.has(String(event.pid)))) return false;
      const id = local ? `local-${++fx._localSeq}` : String(event.pid);
      const group = build(type);
      group.position.set(values[0], values[1], values[2]);
      fx.scene.add(group);
      if (!sinks.scene) sinks.scene = fx.scene;
      const fuseMs = Number(event.fuse), g = Number(event.g);
      const record = {
        id, type, group, capMaterial: null,
        x: values[0], y: values[1], z: values[2], vx: values[3], vy: values[4], vz: values[5],
        age: 0, fuse: Number.isFinite(fuseMs) && fuseMs > 0 ? fuseMs / 1000 : PILOT_PROJECTILE_LOOK[type].fuse,
        bouncesLeft: 0, launchBounceBudget: 0, chaos: 0, child: false, armAge: 0, local, stuck: false,
        // Flown by ProjectileFX's vehicle-shell branch (stepRocket, straight: gravity 0).
        gravity: Number.isFinite(g) ? g : 0, vehicleShell: true,
        // The missile leaves ProjectileFX's smoke trail; the orb never does.
        trailAt: type === 'archer' ? 0 : Infinity,
      };
      fx.projectiles.set(id, record);
      fx._orientRocket?.(record);
      tracked.set(id, { fx, record, type, carry: 0 });
      return true;
    },
  };
}

let warm = null;
/** Hidden copies of every pilot projectile view and a zap arc: titan-presentation.js hangs them in the shader warm-up. */
export function warmupRoot() {
  if (warm) return warm;
  warm = new THREE.Group();
  warm.name = 'pilot-projectile-shader-warmup';
  warm.visible = false;
  for (const type of ['archer', 'arcball']) warm.add(build(type));
  warm.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 1, 0)]), parts().arc));
  warm.traverse(node => { node.frustumCulled = false; });
  return warm;
}

export const PROJECTILE_VIEWS = Object.freeze({
  archer: Object.freeze(launcher('archer')),
  arcball: Object.freeze(launcher('arcball')),
});

/** { particles? (ParticleField), scene? (THREE.Object3D for the arcs) }: the match sets them in init(). */
export function setProjectileSinks({ particles = null, scene = null } = {}) {
  sinks.particles = particles || null;
  sinks.scene = scene || null;
}

const emit = (kind, pos, params) => sinks.particles?.emit?.(kind, pos, params);
const hash = id => { let h = 2166136261; for (const c of String(id)) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };
const BLUE_SPARK = Object.freeze({ color0: [0.75, 0.9, 2.4], color1: [0.3, 0.5, 1.6] });

/** One pooled arc (built lazily into the arc scene). */
function takeArc() {
  if (!sinks.scene) return null;
  if (arcs.length < ARC.pool) {
    const positions = new Float32Array((ARC.segments + 1) * 3);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const line = new THREE.Line(geometry, parts().arc);
    line.frustumCulled = false;
    line.visible = false;
    sinks.scene.add(line);
    arcs.push({ line, positions, from: [0, 0, 0], to: [0, 0, 0], age: 0, seed: 1 });
  }
  const arc = arcs[arcCursor++ % arcs.length];
  return arc;
}

/** Re-jitter one arc: a jagged polyline from `from` to `to`, fattest in the middle. */
function shapeArc(arc) {
  const [ax, ay, az] = arc.from, [bx, by, bz] = arc.to;
  const length = Math.hypot(bx - ax, by - ay, bz - az) || 1;
  const n = ARC.segments;
  let seed = arc.seed = (Math.imul(arc.seed ^ (arc.seed >>> 13), 1274126177) + 0x9e3779b9) >>> 0;
  const rand = () => ((seed = Math.imul(seed ^ (seed >>> 15), 2246822519) >>> 0) / 4294967296 - 0.5);
  for (let i = 0; i <= n; i++) {
    const t = i / n, amp = i === 0 || i === n ? 0 : ARC.jitter * Math.min(1, length / 3) * Math.sin(Math.PI * t) * 2;
    arc.positions[i * 3] = ax + (bx - ax) * t + rand() * amp;
    arc.positions[i * 3 + 1] = ay + (by - ay) * t + rand() * amp;
    arc.positions[i * 3 + 2] = az + (bz - az) * t + rand() * amp;
  }
  arc.line.geometry.attributes.position.needsUpdate = true;
}

function fireArc(from, to, seed) {
  const arc = takeArc();
  if (!arc) return;
  arc.from = from.slice(0, 3);
  arc.to = to.slice(0, 3);
  arc.age = 0;
  arc.seed = seed >>> 0 || 1;
  arc.line.visible = true;
  shapeArc(arc);
}

export function init(app, client) {
  setProjectileSinks({ particles: app?.particleField ?? null, scene: app?.liveEffectsGroup ?? null });
  if (app) import('../audio/sfx.js').then(module => { if (sinks.particles || sinks.scene) sfx = module.sfx ?? null; }).catch(() => {});
}
export function tick(snapshot, dt) {}

/** Motor flames and orb crackle of the live pilot projectiles, and the arc fade. */
export function frame(dt, ctx) {
  const step = Math.max(0, Math.min(0.25, Number.isFinite(dt) ? dt : 0));
  for (const [id, entry] of tracked) {
    const { fx, record, type } = entry;
    if (fx.projectiles.get(id) !== record) { tracked.delete(id); continue; }
    const pos = [record.x, record.y, record.z];
    if (type === 'archer') {
      const back = Math.hypot(record.vx, record.vy, record.vz) || 1;
      entry.carry += step * PILOT_PROJECTILE_LOOK.archer.flameRate;
      const n = Math.floor(entry.carry); entry.carry -= n;
      if (n) emit('fire', pos, { count: n, dir: [-record.vx / back, -record.vy / back, -record.vz / back], speed: 0.5, scale: 0.35, life: 0.25 });
    } else {
      const { shell, cage } = record.group.userData;
      shell?.scale.setScalar(0.85 + Math.sin(record.age * 47) * 0.12 + Math.sin(record.age * 113) * 0.06);
      if (cage) { cage.rotation.x += step * 2.3; cage.rotation.y += step * 3.1; }
      entry.carry += step * PILOT_PROJECTILE_LOOK.arcball.sparkRate;
      const n = Math.floor(entry.carry); entry.carry -= n;
      if (n) emit('spark', pos, { count: n, speed: 3.5, spread: Math.PI, ...BLUE_SPARK });
    }
  }
  for (const arc of arcs) {
    if (!arc.line.visible) continue;
    arc.age += step;
    if (arc.age >= ARC.life) { arc.line.visible = false; continue; }
    shapeArc(arc);
  }
}

/** `arcZap` arcs and the pilot-projectile explode flourishes. */
export function onEvent(event) {
  if (event?.kind === 'arcZap') {
    const from = Array.isArray(event.o) ? event.o.map(Number) : null;
    if (!from || from.length < 3 || !from.every(Number.isFinite)) return;
    let seed = hash(event.pid ?? '');
    for (const target of Array.isArray(event.to) ? event.to : []) {
      const to = Array.isArray(target) ? target.map(Number) : null;
      if (!to || to.length < 3 || !to.every(Number.isFinite)) continue;
      fireArc(from, to, seed = (seed + 0x6d2b79f5) >>> 0);
      emit('spark', to, { count: 6, speed: 4, spread: 1.2, ...BLUE_SPARK });
    }
    sfx?.arcZap?.(from);
    return;
  }
  if (event?.kind !== 'projectileExplode' || !Object.hasOwn(PROJECTILE_VIEWS, event.type)) return;
  const x = Number(event.x), y = Number(event.y), z = Number(event.z);
  if (![x, y, z].every(Number.isFinite)) return;
  if (event.type === 'arcball') {
    // The orb bursts into a fan of short arcs.
    let seed = hash(event.pid ?? `${x},${z}`);
    const rand = () => ((seed = Math.imul(seed ^ (seed >>> 15), 2246822519) >>> 0) / 4294967296);
    for (let i = 0; i < ARC.burst; i++) {
      const a = rand() * Math.PI * 2, e = (rand() - 0.3) * 1.4, r = ARC.burstReach * (0.5 + rand() * 0.5);
      fireArc([x, y, z], [x + Math.cos(a) * Math.cos(e) * r, y + Math.sin(e) * r, z + Math.sin(a) * Math.cos(e) * r], seed);
    }
    emit('spark', [x, y, z], { count: 16, speed: 7, spread: Math.PI, ...BLUE_SPARK });
  } else {
    emit('spark', [x, y, z], { count: 10, speed: 8, spread: 1.2 });
  }
}

export function dispose() {
  tracked.clear();
  for (const arc of arcs) {
    arc.line.removeFromParent();
    arc.line.geometry.dispose();
  }
  arcs = [];
  arcCursor = 0;
  sinks.particles = null;
  sinks.scene = null;
  sfx = null;
}
