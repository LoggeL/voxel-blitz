// Titan ability shots for the titan capture page (vehicle-capture.html?ability=<name>;
// docs/design/titanfall/captures/models.md "Ability events"; WP5). Each shot stages a titan (and a
// target titan) from synthetic rows and feeds server-shaped events through the real presentation
// (titan_ability, the stock vehicle `shoot` events, row bits for the guards and cores) in the
// order and timing the server sends them, then frames the effect at `at` seconds.
//
// The event shapes follow server/sim/titanfall/titan-abilities.js (emitAbility / pushAbilityShoot):
// placements carry id + until, lines x/y/z/yaw/length/until, shots o/end plus a shoot event with
// one path per ray from the anchor. Muted, deterministic (the page seeds Math.random).
import * as THREE from '../vendor/three.module.js';
import { TITAN_ABILITIES, TITAN_ABILITY_BITS, TITAN_PHASE } from '../../../shared/titan-contract.js';
import { vehicleLocalPoint, vehicleDef, mountPose } from '../../../shared/vehicle-defs.js';
import { titanFrame } from '../../../shared/vehicle-handling/titan.js';
import { vehicleMountOrder, VEHICLE_STATUS } from '../../../shared/conquest-contract.js';
import { guardSphere } from '../titanfall/titan-ability-fx.js';
import { stats as eventStats } from '../titanfall/titan-ability-events.js';

const STEP = 1 / 60;
const BITS = TITAN_ABILITY_BITS;
/** The server's placement and shot numbers (ABILITY_TUNING in titan-abilities.js; pinned by titanfall-model-budget-test). */
export const ABILITY_TUNING_VIEW = Object.freeze({
  tripwireAhead: 10, tripwireLifeMs: 30000, incendiaryAhead: 12, tetherAhead: 14, closeRays: 9, closeSpreadDeg: 4,
  lineSpeed: Object.freeze({ firewall: 30, arcWave: 45, flameCore: 30 }),
});

// ---- terrain: stone boxes the ground lines climb (getBlock reads abilityBlock) ---------------
const boxes = [];
const terrain = new THREE.Group();
terrain.name = 'titan-ability-terrain';
const stone = new THREE.MeshStandardMaterial({ color: 0x8d8a82, roughness: 0.92, metalness: 0 });
/** 1 when (x, y, z) is inside a staged terrain box (the capture page's getBlock adds it). */
export function abilityBlock(x, y, z) {
  for (const b of boxes) if (x >= b[0] && x < b[3] && y >= b[1] && y < b[4] && z >= b[2] && z < b[5]) return 1;
  return 0;
}
function setTerrain(scene, list) {
  boxes.length = 0;
  for (const mesh of [...terrain.children]) { mesh.geometry.dispose(); mesh.removeFromParent(); }
  for (const b of list) {
    boxes.push(b);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(b[3] - b[0], b[4] - b[1], b[5] - b[2]), stone);
    mesh.position.set((b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2);
    mesh.castShadow = mesh.receiveShadow = true;
    terrain.add(mesh);
  }
  if (!terrain.parent) scene.add(terrain);
}

// ---- the server's geometry, client side ------------------------------------------------------
const round2 = n => Math.round(n * 100) / 100;
const r2 = p => p.map(round2);
const fwd = yaw => [-Math.sin(yaw), 0, -Math.cos(yaw)];
const add3 = (a, d, t) => [a[0] + d[0] * t, a[1] + d[1] * t, a[2] + d[2] * t];
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm = v => { const l = Math.hypot(...v) || 1; return v.map(n => n / l); };
const anchorOf = (row, type, slot) => vehicleLocalPoint(row, ...TITAN_ABILITIES[type][slot].anchor);
const centreOf = row => [row.x, row.y + titanFrame(row.type).height * 0.55, row.z];
/** groundAhead on the flat capture field (+ terrain): `ahead` m along the look yaw, `side` m right. */
function groundAhead(G, row, ahead, side = 0) {
  const f = fwd(row.yaw);
  const x = row.x + f[0] * ahead - f[2] * side, z = row.z + f[2] * ahead + f[0] * side;
  let y = G;
  for (const b of boxes) if (x >= b[0] && x < b[3] && z >= b[2] && z < b[5]) y = Math.max(y, b[4]);
  return [x, y, z];
}
/** A unit direction inside `cone` around `dir` (server spreadDir). */
function spreadDir(dir, cone, u, w) {
  const a = u * Math.PI * 2, r = Math.sqrt(w) * Math.tan(cone);
  const up = Math.abs(dir[1]) < 0.95 ? [0, 1, 0] : [1, 0, 0];
  const s = norm([dir[1] * up[2] - dir[2] * up[1], dir[2] * up[0] - dir[0] * up[2], dir[0] * up[1] - dir[1] * up[0]]);
  const t = [dir[1] * s[2] - dir[2] * s[1], dir[2] * s[0] - dir[0] * s[2], dir[0] * s[1] - dir[1] * s[0]];
  return norm(dir.map((n, i) => n + (s[i] * Math.cos(a) + t[i] * Math.sin(a)) * r));
}
/** Where a ray from `o` along `d` enters the sphere [x, y, z, r], else null. */
function sphereEntry(o, d, s) {
  const m = sub3(o, s), b = m[0] * d[0] + m[1] * d[1] + m[2] * d[2], c = m[0] ** 2 + m[1] ** 2 + m[2] ** 2 - s[3] ** 2, disc = b * b - c;
  if (disc < 0) return null;
  const t = -b - Math.sqrt(disc);
  return t > 0 ? add3(o, d, t) : null;
}
/** Where a ray from `o` along `d` meets the hull box of `row` (a loose capsule: centre column), else the point at `range`. */
function hullEnd(o, d, row, range = 120) {
  if (!row) return add3(o, d, range);
  const f = titanFrame(row.type), c = [row.x, row.y + f.height * 0.55, row.z];
  const hit = sphereEntry(o, d, [...c, Math.max(f.hw, f.hl) * 0.95]);
  return hit ?? add3(o, d, range);
}
function aimAt(row, from, point) {
  const d = sub3(point, from), yaw = Math.atan2(-d[0], -d[2]), pitch = Math.atan2(d[1], Math.hypot(d[0], d[2]));
  row.mounts = row.mounts.map(m => [yaw, pitch, ...m.slice(2)]);
}

// ---- shots ----------------------------------------------------------------------------------
/**
 * name -> { type, target?: { type, z, x?, yaw?, doomed? }, at: capture time (s), terrain?, aim?,
 *           script(ctx): [[time s, action(ctx)], ...], eye, look, fov }
 * The shooter stands at the origin facing -Z (yaw 0); the target faces it.
 */
export const TITAN_ABILITY_SHOTS = Object.freeze({
  'ion-tripwire': {
    type: 'titan_ion', target: { type: 'titan_scorch', z: -24, x: 4 }, at: 1.8, eye: [12, 10, 9], look: [0, 1.5, -10], fov: 52,
    script: () => [[0.3, c => c.ability('tripwire', tripwire(c))]],
  },
  'ion-tripwire-trigger': {
    type: 'titan_ion', target: { type: 'titan_scorch', z: -13, x: 3 }, at: 1.8, eye: [14, 9, 8], look: [0, 2, -11], fov: 50,
    script: () => [[0.3, c => c.ability('tripwire', c.mines = tripwire(c))],
      [1.6, c => { c.ability('tripwireTrigger', { id: c.mines.id, mines: c.mines.mines }); c.ability('deployableEnd', { id: c.mines.id, deployable: 'tripwire' }); }]],
  },
  'ion-laser-shot': {
    type: 'titan_ion', target: { type: 'titan_legion', z: -26, x: -3 }, at: 1.06, eye: [9, 6.5, 6], look: [-1, 5, -12], fov: 50,
    script: () => [[0.2, c => c.aimAtTarget()], [1.0, c => c.shot('laserShot', 'ordnance', 'railgun', 1, 0)]],
  },
  'ion-vortex': {
    type: 'titan_ion', target: { type: 'titan_legion', z: -24, x: 2 }, at: 1.9, eye: [10, 6.5, -20], look: [0, 4.5, -2], fov: 46,
    script: () => [[0.3, c => c.bits(BITS.defensive, true)], ...Array.from({ length: 12 }, (_, i) => [0.5 + i * 0.1, c => c.enemyFire('predatorClose', 3)])],
  },
  'ion-vortex-throw': {
    type: 'titan_ion', target: { type: 'titan_legion', z: -24, x: 2 }, at: 1.95, eye: [11, 7, 7], look: [0, 4.5, -11], fov: 50,
    script: () => [[0.2, c => c.aimAtTarget()], [0.3, c => c.bits(BITS.defensive, true)],
      ...Array.from({ length: 12 }, (_, i) => [0.5 + i * 0.1, c => c.enemyFire('predatorClose', 3)]),
      [1.9, c => c.vortexThrow()]],
  },
  'ion-laser-core': {
    type: 'titan_ion', target: { type: 'titan_legion', z: -22, x: 7, yaw: Math.PI * 0.8 }, at: 1.6, eye: [24, 9, -6], look: [3, 4.5, -11.5], fov: 52,
    script: () => [[0.2, c => c.aimAtTarget()], [0.5, c => c.bits(BITS.core, true)]],
  },
  'scorch-thermal-shield': {
    type: 'titan_scorch', target: { type: 'titan_ion', z: -22, x: 2 }, at: 1.8, eye: [-11, 7, -19], look: [0, 3.5, -4], fov: 50,
    script: () => [[0.3, c => c.bits(BITS.defensive, true)], ...Array.from({ length: 8 }, (_, i) => [0.6 + i * 0.14, c => c.enemyFire('splitter', 1)])],
  },
  'scorch-incendiary': {
    type: 'titan_scorch', at: 1.5, eye: [10, 8, 6], look: [0, 1.5, -10], fov: 48,
    script: () => [[0.3, c => c.ability('incendiaryTrap', c.trap = c.place('incendiary', ABILITY_TUNING_VIEW.incendiaryAhead))]],
  },
  'scorch-trap-ignite': {
    type: 'titan_scorch', at: 1.78, eye: [12, 9, 6], look: [0, 2, -11], fov: 50,
    script: () => [[0.3, c => c.ability('incendiaryTrap', c.trap = c.place('incendiary', ABILITY_TUNING_VIEW.incendiaryAhead))],
      [1.5, c => { c.ability('trapIgnite', { id: c.trap.id, x: c.trap.x, y: c.trap.y, z: c.trap.z }); c.ability('deployableEnd', { id: c.trap.id, deployable: 'incendiary' }); }]],
  },
  'scorch-firewall': {
    type: 'titan_scorch', target: { type: 'titan_ion', z: -30, x: 9 }, at: 1.25, terrain: true, eye: [16, 11, 4], look: [0, 2, -15], fov: 52,
    script: () => [[0.3, c => c.line('firewall', 'ordnance', 0, 6)]],
  },
  'scorch-flame-core': {
    type: 'titan_scorch', at: 1.0, terrain: true, eye: [15, 12, 7], look: [0, 2, -14], fov: 54,
    script: () => [[0.3, c => { c.bits(BITS.core, true); for (let i = 0; i < 3; i++) c.line('flameCore', 'core', (i - 1) * 0.26); }]],
  },
  'ronin-arc-wave': {
    type: 'titan_ronin', target: { type: 'titan_ion', z: -28, x: -2 }, at: 0.66, terrain: true, eye: [13, 8, 3], look: [0, 2.5, -12], fov: 50,
    script: () => [[0.3, c => c.line('arcWave', 'tactical', 0)]],
  },
  'ronin-phase-dash': {
    type: 'titan_ronin', at: 1.07, eye: [14, 7, 0], look: [0, 3.5, -5], fov: 50,
    script: () => [[1.0, c => c.dash(8)]],
  },
  'ronin-melee': {
    type: 'titan_ronin', target: { type: 'titan_ion', z: -7.6 }, at: 0.78, eye: [10, 6, -1], look: [0, 5, -4], fov: 46,
    script: () => [[0.55, c => c.melee(false)]],
  },
  'ronin-execution': {
    type: 'titan_ronin', target: { type: 'titan_ion', z: -7.6, doomed: true }, at: 0.95, eye: [10, 6.5, -1.5], look: [0, 5, -4], fov: 46,
    script: () => [[0.55, c => c.melee(true)]],
  },
  'ronin-execution-rip': {
    type: 'titan_ronin', target: { type: 'titan_ion', z: -7.6, doomed: true }, at: 1.58, eye: [10, 6.5, -1.5], look: [0, 5, -4], fov: 46,
    script: () => [[0.55, c => c.melee(true)]],
  },
  'legion-gun-shield': {
    type: 'titan_legion', target: { type: 'titan_ion', z: -22, x: -2 }, at: 1.7, eye: [9, 6, -14], look: [0, 4, -2], fov: 46,
    script: () => [[0.3, c => c.bits(BITS.defensive, true)], ...Array.from({ length: 10 }, (_, i) => [0.5 + i * 0.12, c => c.enemyFire('splitter', 1)])],
  },
  'legion-power-shot': {
    type: 'titan_legion', target: { type: 'titan_ion', z: -20, x: 2 }, at: 1.05, eye: [9, 6, 6], look: [0, 4, -10], fov: 50,
    script: () => [[0.2, c => c.aimAtTarget()], [1.0, c => c.shot('powerShot', 'ordnance', 'predatorClose', ABILITY_TUNING_VIEW.closeRays, ABILITY_TUNING_VIEW.closeSpreadDeg)]],
  },
  'northstar-tether': {
    type: 'titan_northstar', target: { type: 'titan_ion', z: -15.5, x: 1, yaw: Math.PI * 0.95 }, at: 1.7, eye: [12, 8, 4], look: [0, 3, -12], fov: 50,
    script: () => [[0.3, c => c.ability('tether', c.pod = c.place('tether', ABILITY_TUNING_VIEW.tetherAhead))],
      [0.5, c => c.ability('tether', c.pod2 = c.place('tether', ABILITY_TUNING_VIEW.tetherAhead - 2, -6))],
      [1.2, c => { c.ability('tetherTrigger', { id: c.pod.id, target: c.target.id, until: c.now() + TITAN_ABILITIES.titan_northstar.defensive.rootSeconds * 1000 });
        c.ability('deployableEnd', { id: c.pod.id, deployable: 'tether' }); c.targetBits(BITS.rooted, true); }]],
  },
});

/** ION mines: 3 points across the look line, `ahead` m out (placeDeployable). */
function tripwire(c) {
  const row = TITAN_ABILITIES.titan_ion.tactical;
  const mines = [-1, 0, 1].map(k => r2(groundAhead(c.G, c.row, ABILITY_TUNING_VIEW.tripwireAhead, k * row.length / 2)));
  return { id: c.nextId(), mines, until: c.now() + ABILITY_TUNING_VIEW.tripwireLifeMs };
}

/**
 * Run `name` on the page: `ctx` = { makeRow(type, team, id, pilot), step(rows, players), event(e), scene, view, G, at? }.
 * Returns { rows, players, shot, stats } after `shot.at` seconds of frames.
 */
export function runAbilityShot(name, team, ctx) {
  const shot = TITAN_ABILITY_SHOTS[name];
  if (!shot) throw new Error(`unknown titan ability shot ${name}`);
  const G = ctx.G, other = team === 'bravo' ? 'alpha' : 'bravo';
  setTerrain(ctx.scene, shot.terrain ? [
    // A 1 m and a 2 m step, then a 4 m wall the lines stop at; off to the side a 2 m drop is the field edge.
    [-14, G, -12, 14, G + 1, -6], [-14, G, -18, 14, G + 2, -12], [-14, G, -30, 14, G + 1, -18], [-14, G, -38, 14, G + 4, -37],
  ] : []);
  const row = ctx.makeRow(shot.type, team, 'tf-shooter', 'pilot');
  const rows = [row], players = [{ id: 'pilot', name: 'PILOT', team, state: 'alive', hp: 100, vehicleId: row.id, vehicleSeatId: 'driver' }];
  let target = null;
  if (shot.target) {
    target = ctx.makeRow(shot.target.type, other, 'tf-target', 'pilot-b');
    Object.assign(target, { x: shot.target.x ?? 0, z: shot.target.z, yaw: shot.target.yaw ?? Math.PI });
    target.mounts = target.mounts.map(m => [target.yaw, 0.02, ...m.slice(2)]);
    let ty = G;
    for (const b of boxes) if (target.x >= b[0] && target.x < b[3] && target.z >= b[2] && target.z < b[5]) ty = Math.max(ty, b[4]);
    target.y = ty;
    if (shot.target.doomed) { target.hp = vehicleDef(target.type).hp * 0.12; target.tw[5] = TITAN_PHASE.doomed; target.tw[3] = 50; }
    rows.push(target);
    players.push({ id: 'pilot-b', name: 'PILOT', team: other, state: 'alive', hp: 100, vehicleId: target.id, vehicleSeatId: 'driver' });
  }
  let clock = 0, seq = 0;
  const now = () => 100000 + Math.round(clock * 1000);
  const c = {
    G, row, target, now, nextId: () => `${row.id}:${++seq}`,
    ability: (ability, fields = {}) => ctx.event({ t: 'ev', kind: 'titan_ability', at: now(), vehicleId: row.id, ability, ...fields }),
    bits: (bit, on) => { row.tw[4] = on ? row.tw[4] | bit : row.tw[4] & ~bit; },
    targetBits: (bit, on) => { if (target) target.tw[4] = on ? target.tw[4] | bit : target.tw[4] & ~bit; },
    aimAtTarget: () => {
      // The pilot's crosshair on the target: the primary mount aims from its pivot (aimTitan).
      const seat = vehicleDef(row.type).seats[0], pose = mountPose(row, seat.id, seat.mounts[0]);
      if (target) aimAt(row, pose?.pivot ?? anchorOf(row, shot.type, 'ordnance'), centreOf(target));
    },
    place: (kind, ahead, side = 0) => {
      const at = r2(groundAhead(G, row, ahead, side));
      return { id: c.nextId(), x: at[0], y: at[1], z: at[2], until: now() + (kind === 'incendiary' ? 45000 : 30000) };
    },
    /** A ground line from the slot's anchor along the look yaw (+ fan), as startLine emits it. */
    line: (kind, slot, fan = 0, seconds = null) => {
      const start = anchorOf(row, shot.type, slot), yaw = row.yaw + fan, length = TITAN_ABILITIES[shot.type][slot].length ?? 30;
      const speed = ABILITY_TUNING_VIEW.lineSpeed[kind];
      c.ability(kind, { x: round2(start[0]), y: G, z: round2(start[2]), yaw: round2(yaw), length,
        until: now() + (seconds != null ? seconds * 1000 : (length / speed + 0.2) * 1000) });
    },
    /** A hitscan ability shot from the slot's anchor: the titan_ability event and its shoot event. */
    shot: (ability, slot, look, rays, spreadDeg) => {
      const o = anchorOf(row, shot.type, slot), aim = norm(sub3(target ? centreOf(target) : add3(o, fwd(row.yaw), 50), o));
      const ends = [];
      for (let i = 0; i < rays; i++) {
        const dir = i === 0 ? aim : spreadDir(aim, spreadDeg * Math.PI / 180, Math.random(), Math.random());
        ends.push(r2(hullEnd(o, dir, target)));
      }
      c.ability(ability, { o: r2(o), end: ends[0] });
      ctx.event(shootEvent(row, o, aim, look, ends, ability));
    },
    /** The target's gun firing at the shooter: hitscan paths ending on the guard sphere (or the hull). */
    enemyFire: (look, rays) => {
      if (!target) return;
      const item = ctx.view.item(row.id), kind = shot.type === 'titan_ion' ? 'vortex' : shot.type === 'titan_scorch' ? 'thermal' : 'gunShield';
      const sphere = item ? guardSphere(item, item.row, kind) : null;
      const o = [target.x + Math.sin(target.yaw) * -2, target.y + titanFrame(target.type).height * 0.62, target.z - Math.cos(target.yaw) * 2];
      const ends = [];
      for (let i = 0; i < rays; i++) {
        const aimPoint = sphere ? [sphere[0] + (Math.random() - 0.5) * sphere[3] * 1.1, sphere[1] + (Math.random() - 0.5) * sphere[3] * 0.9, sphere[2]] : centreOf(row);
        const d = norm(sub3(aimPoint, o));
        ends.push(r2((sphere && sphereEntry(o, d, sphere)) ?? hullEnd(o, d, row)));
      }
      ctx.event(shootEvent(target, o, norm(sub3(ends[0], o)), look, ends, null, 'pilot-b'));
    },
    vortexThrow: () => {
      const item = ctx.view.item(row.id), sphere = item ? guardSphere(item, item.row, 'vortex') : null;
      if (!sphere) return;
      const aimDir = norm(sub3(centreOf(target), sphere)), o = add3(sphere, aimDir, sphere[3] + 0.2);
      const caught = eventStats().caught, rays = Math.max(1, Math.min(12, caught));
      const ends = Array.from({ length: rays }, () => r2(hullEnd(o, spreadDir(aimDir, 3 * Math.PI / 180, Math.random(), Math.random()), target)));
      c.bits(BITS.defensive, false);
      c.ability('vortexThrow', { caught, damage: caught * 60 });
      ctx.event(shootEvent(row, o, aimDir, 'splitter', ends, 'vortexThrow'));
    },
    dash: blink => {
      const from = [row.x, row.y, row.z], f = fwd(row.yaw);
      row.x += f[0] * blink; row.z += f[2] * blink;
      c.bits(BITS.phased, true);
      c.ability('phaseDash', { x: round2(row.x), y: round2(row.y), z: round2(row.z), blink: round2(Math.hypot(row.x - from[0], row.z - from[2])) });
    },
    melee: execute => {
      ctx.event(shootEvent(row, anchorOf(row, shot.type, 'ordnance'), fwd(row.yaw), 'titanMelee', null));
      if (execute) {
        // destroyDoomed: the executed hull is a wreck from this tick on.
        c.ability('execution', { target: target.id });
        Object.assign(target, { hp: 0, wreck: true, own: null, occupantId: null, seatOccupants: { driver: null } });
        target.st = (target.st & ~VEHICLE_STATUS.engine) | VEHICLE_STATUS.wreck;
        players.pop();
      }
      c.ability('melee', { target: target?.id ?? null, executed: !!execute });
    },
  };
  const script = shot.script(c).sort((a, b) => a[0] - b[0]);
  let next = 0;
  const frames = Math.round((Number.isFinite(ctx.at) ? ctx.at : shot.at) / STEP);
  for (let i = 0; i < frames; i++) {
    clock = i * STEP;
    while (next < script.length && script[next][0] <= clock + 1e-9) script[next++][1](c);
    ctx.step(rows, players);
  }
  return { rows, players, shot, stats: eventStats() };
}

function shootEvent(row, o, d, look, ends, ability, shooter = 'pilot') {
  const event = { t: 'ev', kind: 'shoot', id: shooter, w: look, o: r2(o), d: d.map(n => Math.round(n * 1000) / 1000), spread: d.map(n => Math.round(n * 1000) / 1000),
    vehicleId: String(row.id), mount: vehicleMountOrder(row.type)[0], vehicleWeapon: look, tracer: look !== 'titanMelee' };
  if (ends?.length) event.paths = ends.map(end => [{ o: event.o, end }]);
  if (ability) event.ability = ability;
  return event;
}
