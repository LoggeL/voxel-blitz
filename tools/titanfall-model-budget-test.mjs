// Titan models and rig (docs/titanfall.md §7, §11.1; WP5). Every real titan model in
// TITAN_MODEL_FACTORIES (types still on the WP0 placeholder are skipped), both teams:
//   - budget: ≤ 24 draws and ≤ 30 k triangles, one draw per voxel mesh
//   - contract: walker rig, mount rig, muzzle on the server's mountPose, seat anchor, lights,
//     fire/cookoff emitters, contacts, rodeo/battery/hatch anchors, break-away fragments, wreck
//   - rig determinism: two models fed the same rows end bit-identical
//   - IK: stance feet stay planted (drift < 0.05 m) and reach their targets (a swing foot may
//     hang short of its arc for a frame); the gait at
//     30 Hz and 120 Hz frame rates lands the feet in the same places (< 0.05 m); the walk's
//     pelvis excursion stays under 0.3 m (art review 2: no crouch-waddle) and RONIN's idle
//     knee flex under 12°
//   - presentation (stage C): embark / titanfall-landing poses deterministic, the embark pilot
//     proxy rides the palm into the hatch, eject blows the hatch off as its own fragment, doom
//     fire, battery glow gated by batteryOut, rider anchor, cockpit overlay pinned to the hull
//     frame, titan projectile views fly through ProjectileFX, titan shots in VehicleFx, ability FX
//   - review 3: the muzzle stays on mountPose while walking, sprinting and doomed; doom sparks
//     at any frame rate; the ION beam on its core anchor; afterimages skip the cockpit overlay;
//     every titan FX/cockpit program has a hidden warm-up mesh
//   - cockpit (titan-cockpit.js): closed in every look direction (sphere ray grid) and over every
//     pixel at 16:9, 21:9, 4:3 and phone portrait/landscape × FOV 65-117 × sway extremes; the
//     crosshair area is glass and the viewport ≥ 35 % of a 16:9 screen; ≤ 8 draws / 14 k triangles,
//     warmed programs, shared cached geometry freed with the last cockpit, near-depth view model
//     placed on the camera (hidden from other cameras), doom / lock / core / hit lamps
//   - ability events (stage D): a real server match feeds its rows and events to the client:
//     tripwire mines/trigger, tether pod + cable for the root, incendiary canister lit by
//     thermite, firewall / arc wave / flame core lines on the server's ground path over steps,
//     drops and walls, melee punch + execution, phase dash, laser/power/vortex-throw shots from
//     event.o without a gun tracer, vortex catch + throw, gun shield / thermal shield on the
//     server guard sphere, Laser Core along the server anchorAim; tuning pinned to the server
// Headless and audio-free (node + three, no WebGL).
import assert from 'node:assert/strict';
import * as THREE from '../public/js/vendor/three.module.js';
import { VehicleView } from '../public/js/engine/vehicle-view.js';
import { createVehicleFragments } from '../public/js/vehicles/vehicle-fragments.js';
import { TITAN_MODEL_FACTORIES, createModel, setTitanWorld, frame as presentationFrame, onEvent as presentationEvent,
  riderAnchor, dispose as disposePresentation, TITAN_WARMUP_MATERIALS } from '../public/js/titanfall/titan-presentation.js';
import * as abilityFx from '../public/js/titanfall/titan-ability-fx.js';
import { PROJECTILE_VIEWS, frame as projectileViewsFrame } from '../public/js/titanfall/titan-projectile-views.js';
import { hasCockpitOverlay, makeCockpitOverlay } from '../public/js/vehicles/cockpit-overlay.js';
import { TITAN_COCKPIT, TITAN_COCKPIT_WARMUP_MATERIALS, cockpitFrustum, cockpitScale, makeTitanCockpit, titanCockpitCabin,
  titanCockpitCacheSize } from '../public/js/titanfall/titan-cockpit.js';
import { VehicleFx } from '../public/js/vehicles/vehicle-fx.js';
import { COCKPIT_HUD, COCKPIT_HUD_WARMUP_MATERIALS, createCockpitHud, cockpitHudLive, publishCockpitHud, resetCockpitHud,
  setCockpitHudStock } from '../public/js/titanfall/titan-cockpit-hud.js';
import { COCKPIT_HUD_STATES, stage as stageCockpitHud } from '../public/js/capture/titan-cockpit-hud-capture.js';
import { titanModel } from '../public/js/titanfall/titan-hud-state.js';
import { ProjectileFX } from '../public/js/weapons/projectiles.js';
import { TITAN_TYPE_IDS, TITAN_PHASE, TITAN_ABILITIES } from '../shared/titan-contract.js';
import { vehicleMountOrder, VEHICLE_STATUS } from '../shared/conquest-contract.js';
import { vehicleDef, mountPose } from '../shared/vehicle-defs.js';
import { TITAN_RULES } from '../shared/vehicle-handling/titan.js';
import { titanFrame } from '../shared/vehicle-handling/titan.js';
import { vehicleLocalPoint } from '../shared/vehicle-defs.js';
import * as titanPresentation from '../public/js/titanfall/titan-presentation.js';
import * as abilityEvents from '../public/js/titanfall/titan-ability-events.js';
import * as dropFx from '../public/js/titanfall/titanfall-drop-fx.js';
import { GameEngine } from '../server/game.js';
import { getMapMeta, createMapState } from '../shared/world/templates.js';
import { TICK_MS, TICK_RATE_HZ } from '../server/protocol/admission.js';
import { AIR, STONE } from '../shared/world/blocks.js';
import { aimAngles } from '../server/sim/player.js';
import { ABILITY_TUNING, guardSphere as serverGuardSphere, anchorAim, surfaceNear as serverSurfaceNear } from '../server/sim/titanfall/titan-abilities.js';

// Crew avatars draw a name label on a canvas: stub only that.
globalThis.document ??= { createElement: () => ({ getContext: () => new Proxy({}, { get: (o, k) => o[k] ?? (() => {}) }) }) };

const MAX_DRAWS = 24, MAX_TRIANGLES = 30000, MAX_DRIFT = 0.05;
let checks = 0;
const check = fn => { fn(); checks++; };
const near = (a, b, tolerance, label) => assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) <= tolerance,
  `${label}: ${a.map(v => v.toFixed(3))} vs ${b.map(v => v.toFixed(3))}`);
const types = TITAN_TYPE_IDS.filter(type => Object.hasOwn(TITAN_MODEL_FACTORIES, type));
check(() => assert.ok(types.includes('titan_ion'), 'ION is registered in TITAN_MODEL_FACTORIES'));
const summary = [];

/**
 * Drive a bare model (root group at the hull pose) through a scripted row stream at a
 * presentation rate of 1/dt. The hull path is integrated once on a fine 1/960 s clock
 * and sampled at the frame times, so every rate sees the same trajectory.
 */
const TRACK_HZ = 960;
function track(script, chassis) {
  const walk = TITAN_RULES.frames[chassis].walk, out = [];
  let x = 0, z = 0, yaw = 0;
  for (const leg of script) {
    const n = Math.round(leg.seconds * TRACK_HZ), speed = (leg.speed ?? 0) * walk, turn = leg.turn ?? 0;
    for (let i = 0; i < n; i++) {
      yaw += turn / TRACK_HZ;
      x -= Math.sin(yaw) * speed / TRACK_HZ; z -= Math.cos(yaw) * speed / TRACK_HZ;
      out.push({ x, z, yaw, speed: Math.abs(speed), leg });
    }
  }
  return out;
}
function drive(model, script, dt, onFrame = null) {
  const root = new THREE.Group();
  root.add(model.group);
  const path = track(script, vehicleDef(model.rig.type).chassis);
  const frames = Math.floor(path.length / (dt * TRACK_HZ) + 1e-6);
  for (let k = 1; k <= frames; k++) {
    const t = k * dt, { x, z, yaw, speed, leg } = path[Math.min(path.length - 1, Math.round(t * TRACK_HZ) - 1)];
    root.position.set(x, 0, z); root.rotation.set(0, yaw, 0);
    const events = [];
    model.animate(dt, { speed, visualSteer: 0, grounded: true, wreck: false,
      tw: [0, 20, 0, leg.doom ? 50 : 0, leg.bits ?? 0, leg.phase ?? TITAN_PHASE.idle], phase: leg.phase ?? TITAN_PHASE.idle,
      mounts: [[yaw + (leg.aim ?? 0), leg.pitch ?? 0, 20, 0, 0, 0]], legYaw: yaw, yaw, events, x, y: 0, z });
    root.updateMatrixWorld(true);
    onFrame?.(t, events);
  }
  return root;
}
const WALK = [
  { seconds: 1 }, { seconds: 4, speed: 1 }, { seconds: 2, speed: 1, turn: 0.6 }, { seconds: 1.5, speed: 1.43 },
  { seconds: 1, speed: -0.6 }, { seconds: 1.5, speed: 0, turn: -1.2 }, { seconds: 2 },
];

for (const type of types) {
  const def = vehicleDef(type);
  // ---- budget and contract, both teams ----------------------------------------------------
  for (const team of ['alpha', 'bravo']) {
    const model = createModel(type, { team });
    const label = `${type} ${team}`;
    let meshes = 0;
    model.group.traverse(o => { if (o.isMesh) meshes++; });
    check(() => assert.ok(model.stats.draws <= MAX_DRAWS, `${label}: ${model.stats.draws} draws > ${MAX_DRAWS}`));
    check(() => assert.ok(model.stats.triangles <= MAX_TRIANGLES, `${label}: ${model.stats.triangles} triangles > ${MAX_TRIANGLES}`));
    check(() => assert.equal(meshes, model.stats.draws, `${label}: one draw per mesh`));
    check(() => assert.ok(model.walker && model.titanRig && typeof model.animate === 'function', `${label}: walker rig`));
    const order = vehicleMountOrder(type);
    for (const key of order) {
      const rig = model.mounts[key];
      check(() => assert.ok(rig?.yawNode && rig.pitchNode && rig.recoilNode && rig.muzzle, `${label}: mount rig ${key}`));
    }
    check(() => assert.ok(model.seatAnchors.driver, `${label}: driver seat anchor`));
    check(() => assert.ok(model.emitters.lights.length >= 3, `${label}: light sprites`));
    check(() => assert.ok(model.emitters.fire?.length >= 1 && model.emitters.cookoff?.length >= 1, `${label}: fire emitters`));
    check(() => assert.ok(model.emitters.dust?.length === 2 && Array.isArray(model.emitters.thrusters), `${label}: foot dust and thrusters`));
    check(() => assert.ok(Array.isArray(model.contacts) && model.contacts.length >= 2, `${label}: foot contacts`));
    for (const anchor of ['rodeo', 'battery', 'hatch']) check(() => assert.ok(model.anchors?.[anchor]?.isObject3D, `${label}: ${anchor} anchor`));
    check(() => assert.ok(model.firstPersonHidden?.length >= 3, `${label}: cockpit view hides the upper body`));
    const tags = model.fragmentSources().map(source => source.tag);
    for (const tag of ['hatch', 'battery']) check(() => assert.ok(tags.includes(tag), `${label}: break-away ${tag}`));
    check(() => assert.ok(createVehicleFragments(model, { maxPieces: 64 }).length === tags.length));
    const triangles = () => { let n = 0; model.group.traverse(o => { if (o.isMesh && o.geometry.userData.vehicleVoxel) n += o.geometry.userData.triangles; }); return n; };
    const intact = triangles();
    model.setWreck(true);
    check(() => assert.ok(triangles() < intact, `${label}: wreck loses its break-away parts`));
    model.setWreck(false);
    check(() => assert.equal(triangles(), intact, `${label}: respawn restores the intact geometry`));
    if (team === 'alpha') summary.push(`${type.replace('titan_', '')} ${model.stats.draws}d/${model.stats.triangles}t`);
  }

  // ---- rendered muzzle against the server's mountPose (through VehicleView) -------------
  {
    const view = new VehicleView();
    const order = vehicleMountOrder(type);
    const cases = [[0.4, 0, 0.1], [1.3, 0.2, -0.3], [-2.2, 0.3, 0.45]];
    const rows = cases.map(([yaw, aim, pitch], i) => ({
      id: `${type}-${i}`, type, team: i % 2 ? 'bravo' : 'alpha', x: i * 30, y: 12, z: -5, yaw, pitch: 0, roll: 0, speed: 0,
      hp: def.hp, st: VEHICLE_STATUS.engine | VEHICLE_STATUS.grounded, grounded: true,
      mounts: order.map(() => [yaw + aim, pitch, 20, 0, 0, 0]), tw: [0, 20, 0, 0, 0, TITAN_PHASE.idle],
    }));
    for (let i = 0; i < 90; i++) { view.sync(rows, [], null); view.update(1 / 60, null); }
    // 1.5 s without a shot or aim input: the weapon sits in the low-ready carry, yet the muzzle
    // anchors (shots, flashes, tracers) stay on the server's mountPose.
    const carry = view.item(rows[0].id).model.nodes.carry;
    check(() => assert.ok(carry.rotation.x < -0.1, `${type}: low-ready carry after a quiet spell (${carry.rotation.x.toFixed(2)})`));
    for (const row of rows) for (const key of order) {
      const [seatId, mountId] = key.split(':');
      const rendered = view.mountWorldPose(row.id, key);
      const server = mountPose(row, seatId, mountId);
      check(() => near(rendered.origin, server.origin, 0.15, `${type} ${key} muzzle (yaw ${row.yaw})`));
      check(() => assert.ok(rendered.dir.reduce((s, v, i) => s + v * server.dir[i], 0) > 0.995, `${type} ${key} barrel direction`));
    }
    // A shot snaps the weapon up (0.12 s).
    view.item(rows[0].id).model.rig.raise(true);
    for (let i = 0; i < 12; i++) { view.sync(rows, [], null); view.update(1 / 60, null); }
    check(() => assert.ok(Math.abs(carry.rotation.x) < 0.01, `${type}: a shot raises the weapon (${carry.rotation.x.toFixed(3)})`));
    view.dispose();
  }
  // ---- the muzzle stays on mountPose while walking, sprinting and doomed (presented hull pose) ----
  {
    const walk = TITAN_RULES.frames[def.chassis].walk, order = vehicleMountOrder(type), yaw = 0.7;
    for (const [state, speed, doom] of [['walk', 1, false], ['sprint', 1.43, false], ['doomed', 0, true], ['doomed walk', 1, true]]) {
      const view = new VehicleView();
      let x = 0, z = 0, err = 0, dot = 1;
      for (let i = 0; i < 240; i++) {
        x -= Math.sin(yaw) * speed * walk / 60; z -= Math.cos(yaw) * speed * walk / 60;
        const row = { id: 'm', type, team: 'alpha', x, y: 12, z, yaw, pitch: 0, roll: 0, speed: speed * walk, hp: def.hp,
          st: VEHICLE_STATUS.engine | VEHICLE_STATUS.grounded, grounded: true, mounts: order.map(() => [yaw + 0.2, 0.05, 20, 0, 0, 0]),
          tw: [0, 20, 0, doom ? 50 : 0, 0, doom ? TITAN_PHASE.doomed : TITAN_PHASE.idle] };
        view.sync([row], [], null); view.update(1 / 60, null);
        if (i < 60) continue;
        const root = view.item('m').root;
        const presented = { ...row, x: root.position.x, y: root.position.y, z: root.position.z, yaw: root.rotation.y };
        for (const key of order) {
          const [seatId, mountId] = key.split(':');
          const rendered = view.mountWorldPose('m', key), server = mountPose(presented, seatId, mountId);
          err = Math.max(err, Math.hypot(...rendered.origin.map((v, k) => v - server.origin[k])));
          dot = Math.min(dot, rendered.dir.reduce((sum, v, k) => sum + v * server.dir[k], 0));
        }
      }
      view.dispose();
      check(() => assert.ok(err <= 0.15, `${type} ${state}: muzzle ${err.toFixed(3)} m off mountPose`));
      check(() => assert.ok(dot > 0.995, `${type} ${state}: barrel direction ${dot.toFixed(4)}`));
    }
  }

  // ---- determinism: two models, the same rows, identical transforms ----------------------
  {
    const a = createModel(type, { team: 'alpha' }), b = createModel(type, { team: 'alpha' });
    const pose = model => { const out = []; model.group.traverse(o => { out.push(...o.position.toArray(), ...o.quaternion.toArray()); }); return out; };
    const sa = [], sb = [];
    drive(a, WALK, 1 / 60, () => sa.push(pose(a)));
    drive(b, WALK, 1 / 60, () => sb.push(pose(b)));
    check(() => assert.deepEqual(sa, sb, `${type}: the rig is deterministic`));
  }

  // ---- IK: planted stance feet, reached targets, frame-rate independence ----------------
  {
    const model = createModel(type, { team: 'alpha' });
    const feet = [model.legs.left.foot, model.legs.right.foot];
    const start = [null, null], v = new THREE.Vector3();
    let drift = 0, miss = 0, steps = 0, excursion = 0;
    drive(model, WALK, 1 / 60, t => {
      // Excursion over the steady straight walk (1 s in, before the turns and the reverse).
      if (t > 2 && t < 5) excursion = Math.max(excursion, model.rig.debug.excursion ?? 0);
      feet.forEach((foot, i) => {
        if (!model.rig.debug.stance[i]) { start[i] = null; return; }
        miss = Math.max(miss, model.rig.debug.miss[i] || 0);
        foot.getWorldPosition(v);
        if (!start[i]) start[i] = v.clone();
        else drift = Math.max(drift, v.distanceTo(start[i]));
      });
    });
    steps = model.rig.stepCount;
    check(() => assert.ok(steps >= 10, `${type}: the walk takes steps (${steps})`));
    check(() => assert.ok(drift < MAX_DRIFT, `${type}: stance foot drift ${drift.toFixed(4)} m`));
    check(() => assert.ok(miss < MAX_DRIFT, `${type}: stance IK reach miss ${miss.toFixed(4)} m`));
    check(() => assert.ok(excursion <= 0.3, `${type}: straight-walk pelvis excursion ${excursion.toFixed(3)} m`));
    if (type === 'titan_ronin') {
      const idle = createModel(type, { team: 'alpha' });
      let knee = 0;
      for (let i = 0; i < 240; i++) {
        idle.animate(1 / 60, { speed: 0, x: 0, y: 0, z: 0, yaw: 0, grounded: true, tw: [0, 20, 0, 0, 0, 0] });
        if (i > 120) for (const leg of [idle.legs.left, idle.legs.right]) knee = Math.max(knee, Math.abs(leg.knee.rotation.x));
      }
      check(() => assert.ok(knee < 12 * Math.PI / 180, `${type}: idle knee flex ${(knee * 180 / Math.PI).toFixed(1)}°`));
    }
    // 30 Hz vs 120 Hz presentation: the fixed 1/120 s rig clock lands the feet alike.
    const sample = rate => {
      const m = createModel(type, { team: 'alpha' }), out = [];
      let next = 0.5;
      drive(m, WALK, 1 / rate, t => {
        if (t + 1e-6 < next) return;
        next += 0.5;
        out.push([m.legs.left.foot, m.legs.right.foot].map(foot => foot.getWorldPosition(new THREE.Vector3()).toArray()));
      });
      return out;
    };
    const slow = sample(30), fast = sample(120);
    let worst = 0;
    for (let i = 0; i < Math.min(slow.length, fast.length); i++) for (let k = 0; k < 2; k++) {
      worst = Math.max(worst, Math.hypot(...slow[i][k].map((value, j) => value - fast[i][k][j])));
    }
    check(() => assert.ok(slow.length >= 20 && Math.abs(slow.length - fast.length) <= 1, `${type}: frame-rate samples`));
    check(() => assert.ok(worst < MAX_DRIFT, `${type}: feet at 30 Hz vs 120 Hz differ by ${worst.toFixed(4)} m`));
    // Doom spark bursts (two per `doomSparkEvery`) fire at the same rate at any frame rate.
    const sparks = rate => {
      let n = 0;
      drive(createModel(type, { team: 'alpha' }), [{ seconds: 10, doom: true, phase: TITAN_PHASE.doomed }], 1 / rate,
        (t, events) => { n += events.filter(event => event.type === 'sparks').length; });
      return n;
    };
    const bursts = [30, 60, 144].map(sparks);
    check(() => assert.ok(bursts.every(n => Math.abs(n - 50) <= 3), `${type}: doom sparks at 30/60/144 Hz ${bursts.join('/')} (50 expected)`));
    summary.push(`${type.replace('titan_', '')} ${steps} steps, drift ${drift.toFixed(4)} m, excursion ${excursion.toFixed(3)} m, 30/120 Hz ${worst.toFixed(4)} m`);
  }
}

// ---- presentation (stage C) ------------------------------------------------------------------
{
  const finiteVec = v => Array.isArray(v) && v.every(Number.isFinite);
  for (const type of types) {
    const model = createModel(type, { team: 'alpha' });
    for (const anchor of ['palmL', 'seat']) check(() => assert.ok(model.anchors[anchor]?.isObject3D, `${type}: ${anchor} anchor`));
    check(() => assert.ok(model.emitters.lights.some(light => light.kind === 'battery'), `${type}: battery glow light`));
    check(() => assert.ok(model.group.userData.titanHull, `${type}: hull frame tag`));
    // Embark and titanfall-landing poses are deterministic like the walk.
    const script = [{ seconds: 0.5, phase: TITAN_PHASE.landed }, { seconds: 1.4, phase: TITAN_PHASE.embark }, { seconds: 0.5 }];
    const a = createModel(type, { team: 'alpha' }), b = createModel(type, { team: 'alpha' });
    const pose = m => { const out = []; m.group.traverse(o => { out.push(...o.position.toArray(), ...o.quaternion.toArray()); }); return out; };
    const sa = [], sb = [];
    let embarkPeak = 0, heroPeak = 0;
    drive(a, script, 1 / 60, () => { sa.push(pose(a)); embarkPeak = Math.max(embarkPeak, a.rig.embark); heroPeak = Math.max(heroPeak, a.rig.hero); });
    drive(b, script, 1 / 60, () => sb.push(pose(b)));
    check(() => assert.deepEqual(sa, sb, `${type}: embark / landing poses are deterministic`));
    check(() => assert.ok(embarkPeak > 0.99 && heroPeak > 0.9, `${type}: embark ${embarkPeak.toFixed(2)} hero ${heroPeak.toFixed(2)}`));
    // Cockpit overlay: built for every titan, pinned to the hull frame (not the swaying torso).
    check(() => assert.ok(hasCockpitOverlay(type), `${type}: cockpit overlay`));
    const overlay = makeCockpitOverlay(type);
    model.body.add(overlay.group);
    model.body.rotation.x = 0.3; model.body.position.y += 0.4;
    const root = new THREE.Group(); root.position.set(3, 10, -2); root.add(model.group); root.updateMatrixWorld(true);
    check(() => assert.ok(overlay.group.matrixWorld.equals(model.group.matrixWorld), `${type}: cockpit overlay in the hull frame`));
    check(() => assert.deepEqual(overlay.group.children.filter(c => !c.userData.cockpitFx).map(c => c.name.replace(/^.*?-(hud-)?(?=[a-z]+$)/, (m, hud) => hud ?? '')).sort(),
      ['accent', 'glass', 'hud-brow', 'hud-feed', 'hud-glass', 'hud-pods', 'keys', 'screens', 'shell', 'sparks', 'warn'], `${type}: overlay meshes (cabin + diegetic HUD)`));
    check(() => assert.deepEqual(overlay.group.children.filter(c => c.userData.cockpitFx).map(c => c.name.replace(/^.*-fx-/, '')).sort(),
      ['banner', 'breach', 'cablesL', 'cablesR', 'fires', 'holeL', 'holeR', 'plateL', 'plateR', 'shutterBottom', 'shutterTop', 'smoke'], `${type}: cockpit damage and transit meshes`));
    overlay.dispose();
  }
  check(() => assert.ok(!hasCockpitOverlay('tank') && hasCockpitOverlay('plane'), 'cockpit overlays of other hulls unchanged'));
  cockpitChecks();

  // Walker update through VehicleView with FX sinks: embark proxy, eject, doom fire, battery, rider anchor.
  const counts = {}, emitters = new Set();
  const fx = {
    emit: (kind, pos) => { assert.ok(finiteVec(pos), `particle ${kind} at a finite position`); counts[kind] = (counts[kind] || 0) + 1; },
    addEmitter: params => { const handle = { ...params }; emitters.add(handle); return handle; },
    removeEmitter: handle => emitters.delete(handle),
  };
  const audio = {}, calls = {};
  for (const name of ['titanFootfall', 'titanLanding', 'titanDash', 'titanShot', 'titanCue']) audio[name] = () => { calls[name] = (calls[name] || 0) + 1; };
  audio.sfx = { ejectionSeat: () => { calls.ejectionSeat = (calls.ejectionSeat || 0) + 1; } };
  const scene = new THREE.Group(), view = new VehicleView({ getBlock: (x, y) => (y < 10 ? 1 : 0) });
  const camera = new THREE.PerspectiveCamera(); camera.position.set(12, 14, 12);
  let trauma = 0;
  setTitanWorld({ getBlock: (x, y) => (y < 10 ? 1 : 0), fx, shake: { add: t => { trauma += t; } }, scene, audio, view, camera,
    selfId: () => 'viewer', teamOf: () => 'alpha' });
  for (const type of types) {
    const def = vehicleDef(type);
    const row = { id: `p-${type}`, type, team: 'alpha', x: 0, y: 10, z: 0, yaw: 0.4, pitch: 0, roll: 0, speed: 0, hp: def.hp,
      st: VEHICLE_STATUS.engine | VEHICLE_STATUS.grounded, grounded: true, mounts: [[0.4, 0, 20, 0, 0, 0]],
      tw: [0, 20, 0, 0, 0, TITAN_PHASE.dropping], seatOccupants: { driver: 'pilot' }, occupantId: 'pilot' };
    const run = (frames, patch = {}) => { Object.assign(row, patch); for (let i = 0; i < frames; i++) { view.sync([row], [], null); view.update(1 / 60, camera); presentationFrame(1 / 60, { camera }); } };
    run(20);
    const before = { ...calls };
    run(30, { tw: [0, 20, 0, 0, 0, TITAN_PHASE.landed] });
    check(() => assert.ok((calls.titanLanding || 0) > (before.titanLanding || 0), `${type}: titanfall slam`));
    run(36, { tw: [0, 20, 0, 0, 0, TITAN_PHASE.embark] });
    const item = view.item(row.id);
    const pilot = scene.children.find(o => o.name === 'titan-embark-pilot');
    check(() => assert.ok(pilot?.visible, `${type}: embark pilot proxy mid-embark`));
    const palm = item.model.anchors.palmL.getWorldPosition(new THREE.Vector3());
    check(() => assert.ok(pilot.position.distanceTo(palm) < 0.05, `${type}: the pilot rides the palm (${pilot.position.distanceTo(palm).toFixed(3)} m)`));
    run(40);
    check(() => assert.ok(!scene.children.some(o => o.name === 'titan-embark-pilot' && o.visible), `${type}: the pilot is in the hatch`));
    run(10, { tw: [0, 20, 0, 0, 16, TITAN_PHASE.idle] });
    const anchor = riderAnchor(row.id);
    check(() => assert.ok(anchor && [anchor.x, anchor.y, anchor.z].every(Number.isFinite), `${type}: rider anchor`));
    run(10, { tw: [0, 20, 0, 50, 0, TITAN_PHASE.doomed] });
    check(() => assert.ok(item.titanFx.fire.length >= 3, `${type}: doom fire emitters`));
    presentationEvent({ t: 'ev', kind: 'titan_eject', id: 'pilot', vehicleId: row.id });
    check(() => assert.ok(item.model.rig.hatchBlown && scene.children.some(o => o.name === 'titan-blown-hatch'), `${type}: the hatch blows off`));
    check(() => assert.ok(!createVehicleFragments(item.model).some(piece => piece.name === 'hatch'), `${type}: the wreck skips the blown hatch`));
    run(5, { hp: 0, wreck: true, st: VEHICLE_STATUS.wreck });
    check(() => assert.equal(item.titanFx?.fire.length ?? 0, 0, `${type}: doom fire stops on the wreck`));
    view.sync([], [], null); view.update(1 / 60, camera); presentationFrame(1 / 60, { camera });
    check(() => assert.ok(!scene.children.some(o => o.name === 'titan-embark-pilot'), `${type}: no proxy left behind`));
  }
  check(() => assert.ok(calls.ejectionSeat === types.length && trauma > 0, 'eject audio and shake'));
  presentationEvent({ t: 'ev', kind: 'titanfall_drop', owner: 'viewer', vehicleId: 'x', x: 0, y: 10, z: 0, at: 0, landsAt: 3000 });
  check(() => assert.equal(abilityFx.stats().beams, 1, 'titanfall marker beam'));
  disposePresentation();
  check(() => assert.equal(scene.children.length, 0, 'dispose clears the presentation'));
  view.dispose();

  // Titanfall drop (titanfall-drop-fx.js; captures/models.md "Titanfall drop"): the hull falls
  // out of the sky on dropLift against the server clock (event landsAt), slams once on the landed
  // row (dust wave, voxel chunks, particles, shake by distance), vents on the rise and cleans up.
  {
    const getBlock = (x, y) => (y < 10 ? 1 : 0);
    const dropScene = new THREE.Group(), dropView = new VehicleView({ getBlock });
    const dropCamera = new THREE.PerspectiveCamera(); dropCamera.position.set(15, 11.6, 0);
    const dropCounts = {}, dropEmitters = new Set();
    let dropTrauma = 0;
    setTitanWorld({ getBlock, scene: dropScene, audio, view: dropView, camera: dropCamera, selfId: () => 'viewer', teamOf: () => 'alpha',
      fx: { emit: (kind, pos) => { assert.ok(finiteVec(pos), `drop particle ${kind} at a finite position`); dropCounts[kind] = (dropCounts[kind] || 0) + 1; },
        addEmitter: params => { const handle = { ...params }; dropEmitters.add(handle); return handle; }, removeEmitter: handle => dropEmitters.delete(handle) },
      shake: { add: t => { dropTrauma += t; } } });
    const total = TITAN_RULES.drop.markerMs + TITAN_RULES.drop.fallMs;
    const row = { id: 'drop-ion', type: 'titan_ion', team: 'alpha', x: 0, y: 10, z: 0, yaw: 0.3, pitch: 0, roll: 0, speed: 0, hp: vehicleDef('titan_ion').hp,
      st: VEHICLE_STATUS.engine | VEHICLE_STATUS.grounded, grounded: true, mounts: [[0.3, 0, 20, 0, 0, 0]], tw: [0, 20, 0, 0, 0, TITAN_PHASE.dropping] };
    let nowMs = 0;
    const step = (ms, patch = {}) => {
      Object.assign(row, patch);
      for (const end = nowMs + ms; nowMs < end;) {
        nowMs += 1000 / 60;
        presentationFrame(1 / 60, { camera: dropCamera, nowMs });
        dropView.sync([row], [], null); dropView.update(1 / 60, dropCamera);
      }
    };
    presentationEvent({ t: 'ev', kind: 'titanfall_drop', owner: 'mate', vehicleId: row.id, x: 0, y: 10, z: 0, at: 0, landsAt: total });
    check(() => assert.ok(dropFx.stats().falling === 1 && dropFx.inspect(row.id)?.markerVisible, 'drop: a record and its countdown ring'));
    const lifts = [];
    for (const at of [500, 1500, 2500]) {
      step(at - nowMs);
      const item = dropView.item(row.id), seen = dropFx.inspect(row.id);
      const expected = dropFx.dropLift((total - nowMs) / 1000);
      lifts.push(item.root.position.y - row.y);
      check(() => assert.ok(Math.abs(seen.lift - expected) < 2 && Math.abs(item.root.position.y - row.y - seen.lift) < 0.01,
        `drop: hull ${seen.lift.toFixed(1)} m up at ${at} ms (dropLift ${expected.toFixed(1)})`));
      check(() => assert.ok(seen.fallVisible && !seen.impacted && dropFx.stats().chunks === 0 && (at > 2000 || dropTrauma === 0), `drop: falling, no impact yet at ${at} ms`));
    }
    check(() => assert.ok(lifts[0] > 150 && lifts[0] > lifts[1] && lifts[1] > lifts[2] && lifts[2] > 0, `drop: a high fall coming down (${lifts.map(v => v.toFixed(0)).join(' > ')} m)`));
    check(() => assert.equal(abilityFx.stats().beams, 1, 'drop: the marker beam stands through the fall'));
    // The visual touchdown comes before the landed row: the impact, the beam's flash-out and the
    // landing pose start on that frame, with the row still dropping.
    step(total - nowMs + 40);
    const hit = dropFx.inspect(row.id), impactDust = dropCounts.dust || 0, impactDebris = dropCounts.debris || 0;
    const viewer = dropCamera.position.distanceTo(new THREE.Vector3(row.x, row.y + 1.6, row.z));
    check(() => assert.ok(hit?.impacted && dropFx.stats().impacted === 1, 'drop: the visual touchdown slams before the landed row'));
    check(() => assert.ok(dropView.item(row.id).model.rig.hero >= dropFx.TITANFALL_DROP_FX.heroSnap && !dropView.item(row.id).model.rig.airborne,
      `drop: the landing pose from the touchdown frame (hero ${dropView.item(row.id).model.rig.hero.toFixed(2)})`));
    check(() => assert.equal(abilityFx.stats().beams, 0, 'drop: the marker beam flashes out at impact'));
    step(100, { tw: [0, 20, 0, 0, 0, TITAN_PHASE.landed] });
    check(() => assert.ok(dropFx.stats().impacted === 1 && (dropCounts.debris || 0) === impactDebris, 'drop: the landed row adds no second slam'));
    check(() => assert.ok(dropFx.stats().chunks === dropFx.TITANFALL_DROP_FX.chunks && dropScene.getObjectByName('titanfall-drop-chunks')?.visible,
      `drop: ${dropFx.stats().chunks} voxel chunks`));
    check(() => assert.ok(impactDust > 40 && impactDebris > 0 && (dropCounts.spark || 0) > 0 && dropEmitters.size === 1, 'drop: dust, debris, sparks and lingering dust'));
    check(() => assert.ok(Math.abs(hit.trauma - dropFx.dropShakeTrauma(viewer)) < 1e-9 && dropTrauma >= hit.trauma, `drop: shake ${hit.trauma.toFixed(2)} at ${viewer.toFixed(1)} m`));
    check(() => assert.ok(dropView.item(row.id).root.position.distanceTo(new THREE.Vector3(row.x, row.y, row.z)) < 0.01, 'drop: the hull stands on the landed row'));
    step(500);
    check(() => assert.ok((dropCounts.debris || 0) === impactDebris && dropFx.stats().impacted === 1, 'drop: one impact per drop'));
    step(4500, { tw: [0, 20, 0, 0, 0, TITAN_PHASE.idle] });
    check(() => assert.ok(dropFx.stats().drops === 0 && dropFx.stats().chunks === 0 && !dropScene.getObjectByName('titanfall-drop-chunks')?.visible,
      `drop: the record and chunks clean up (${JSON.stringify(dropFx.stats())})`));
    check(() => assert.ok(!dropScene.children.some(o => o.visible && o.name !== 'titanfall-drop-chunks' && o.name.startsWith('titanfall-drop')), 'drop: no fall rig left in the scene'));
    disposePresentation();
    check(() => assert.equal(dropScene.children.length, 0, 'drop: dispose clears the drop FX'));
    dropView.dispose();
    setTitanWorld({});
    // Shake and FOV punch by distance (strong within 20 m, felt to 60 m); the fall height at the server's drop time.
    for (const [d, trauma] of [[0, 1], [10, 0.9], [20, 0.8], [40, 0.4], [60, 0], [90, 0]]) {
      check(() => assert.ok(Math.abs(dropFx.dropShakeTrauma(d) - trauma) < 1e-9, `drop shake at ${d} m: ${dropFx.dropShakeTrauma(d)}`));
    }
    check(() => assert.ok(dropFx.dropFovPunch(0) === dropFx.TITANFALL_DROP_FX.fovPunch && dropFx.dropFovPunch(8) > 0 && dropFx.dropFovPunch(16) === 0, 'drop FOV punch inside 16 m'));
    const fall = dropFx.dropLift(total / 1000);
    check(() => assert.ok(fall >= 150 && fall <= 260 && dropFx.dropLift(0) === 0, `drop height ${fall.toFixed(0)} m over ${total} ms`));
  }

  // Ability FX: the defensive and core bits light their parts on the hull.
  {
    const fxView = new VehicleView({ getBlock: (x, y) => (y < 10 ? 1 : 0) });
    const fxScene = new THREE.Group();
    abilityFx.setSinks({ scene: fxScene, fx, getBlock: (x, y) => (y < 10 ? 1 : 0) });
    for (const type of types) {
      const def = vehicleDef(type);
      const row = { id: `a-${type}`, type, team: 'bravo', x: 0, y: 10, z: 0, yaw: 0, pitch: 0, roll: 0, speed: 0, hp: def.hp, grounded: true,
        st: VEHICLE_STATUS.engine | VEHICLE_STATUS.grounded, mounts: [[0, 0, 20, 0, 0, 0]], tw: [0, 20, 100, 0, 1 | 2, TITAN_PHASE.idle] };
      const total = () => Object.values(counts).reduce((a, b) => a + b, 0), before = total();
      for (let i = 0; i < 10; i++) { fxView.sync([row], [], null); fxView.update(1 / 60, null); abilityFx.updateTitan(fxView.item(row.id), row, 1 / 60); abilityFx.frame(1 / 60); }
      // Every kit lights at least one mesh; particle-only bits (the Scorch Flame Core, the Northstar
      // Flight Core; art review: no core aura) and the Ronin blade afterimages count once.
      const shown = abilityFx.stats().meshes + (abilityFx.stats().ghosts > 0 ? 1 : 0) + (total() > before + 10 ? 1 : 0);
      check(() => assert.ok(shown >= 2, `${type}: defensive and core FX (${abilityFx.stats().meshes} meshes)`));
      fxView.sync([], [], null); fxView.update(1 / 60, null); abilityFx.frame(1 / 60);
    }
    // ION Laser Core: the beam leaves the contract's core anchor (where the server fires it),
    // standing and doomed (slumped, listing torso), within 0.15 m.
    for (const doom of [false, true]) {
      const row = { id: `laser-${doom}`, type: 'titan_ion', team: 'alpha', x: 0, y: 12, z: 0, yaw: 0.5, pitch: 0, roll: 0, speed: 0, hp: 5000,
        grounded: true, st: VEHICLE_STATUS.engine | VEHICLE_STATUS.grounded, mounts: [[0.5, 0, 20, 0, 0, 0]],
        tw: [0, 20, 0, doom ? 50 : 0, 1, doom ? TITAN_PHASE.doomed : TITAN_PHASE.idle] };
      for (let i = 0; i < 60; i++) { fxView.sync([row], [], null); fxView.update(1 / 60, null); abilityFx.updateTitan(fxView.item(row.id), row, 1 / 60); }
      const beam = fxScene.children.find(o => o.material?.name === 'titan-laser-beam-fx' && o.visible);
      const server = new THREE.Vector3(...TITAN_ABILITIES.titan_ion.core.anchor).applyMatrix4(fxView.item(row.id).root.matrixWorld);
      check(() => assert.ok(beam && beam.position.distanceTo(server) <= 0.15 + 1e-6, `ION laser beam on the core anchor${doom ? ' (doomed)' : ''}: ${beam?.position.distanceTo(server).toFixed(3)} m`));
      fxView.sync([], [], null); fxView.update(1 / 60, null); abilityFx.frame(1 / 60);
    }
    // A first-person RONIN dash afterimage copies only the hull's cached voxel meshes, never the
    // pilot's own cockpit overlay (its geometry is freed when the pilot leaves).
    {
      const row = { id: 'ghost', type: 'titan_ronin', team: 'alpha', x: 0, y: 12, z: 0, yaw: 0, pitch: 0, roll: 0, speed: 0, hp: 5000,
        grounded: true, st: VEHICLE_STATUS.engine | VEHICLE_STATUS.grounded, mounts: [[0, 0, 20, 0, 0, 0]], tw: [0, 20, 0, 0, 0, TITAN_PHASE.idle],
        seatOccupants: { driver: 'me' }, occupantId: 'me' };
      fxView.setLocalView({ id: 'ghost', seatId: 'driver' });
      for (let i = 0; i < 10; i++) { fxView.sync([row], [], null); fxView.update(1 / 60, null); }
      const item = fxView.item('ghost');
      const cockpit = new Set();
      item.cockpit?.group.traverse(o => { if (o.geometry) cockpit.add(o.geometry); });
      abilityFx.dashStreak(item, [0, 0, -1]);
      const ghost = fxScene.children.find(o => o.name === 'titan-phase-ghost');
      let meshes = 0, bad = 0;
      ghost?.traverse(o => { if (o.isMesh) { meshes++; if (cockpit.has(o.geometry) || !o.geometry.userData.cached) bad++; } });
      check(() => assert.ok(cockpit.size > 0 && meshes > 5 && bad === 0, `RONIN first-person afterimage: ${meshes} meshes, ${bad} cockpit/uncached`));
      fxView.setLocalView(null);
      fxView.sync([], [], null); fxView.update(1 / 60, null); abilityFx.frame(1);
    }
    abilityFx.clear();
    fxView.dispose();
  }
  // Shader warm-up: the presentation sinks carry a hidden mesh of every titan FX and cockpit program.
  {
    const warmScene = new THREE.Group();
    setTitanWorld({ scene: warmScene });
    const names = new Set();
    let visible = 0;
    warmScene.traverse(o => { if (o.material?.name) names.add(o.material.name); });
    warmScene.traverseVisible(o => { if (o.isMesh) visible++; });
    const missing = TITAN_WARMUP_MATERIALS.filter(name => !names.has(name));
    check(() => assert.ok(missing.length === 0 && visible === 0, `titan shader warm-up: missing ${missing.join(', ') || 'none'}, ${visible} visible`));
    setTitanWorld({});
    check(() => assert.equal(warmScene.children.length, 0, 'titan shader warm-up leaves with the sinks'));
  }

  // VehicleFx: titan shots are visual-only branches; the battery glow follows batteryOut.
  {
    const fxView = new VehicleView({ getBlock: () => 0 });
    const vfx = new VehicleFx({ fx, vehicleView: fxView, getBlock: () => 0 });
    const row = { id: 'v-ion', type: 'titan_ion', team: 'alpha', x: 0, y: 10, z: 0, yaw: 0, pitch: 0, roll: 0, speed: 0, hp: 5000, grounded: true,
      st: VEHICLE_STATUS.engine | VEHICLE_STATUS.grounded, mounts: [[0, 0, 20, 0, 0, 0]], tw: [0, 20, 0, 0, 0, TITAN_PHASE.idle],
      seatOccupants: { driver: 'pilot' }, occupantId: 'pilot' };
    let battery = 0;
    const push = vfx.sprites.push.bind(vfx.sprites);
    vfx.sprites.push = (pos, color, size) => { if (size === 0.42 && color[1] > color[0] * 3 && color[1] > color[2] * 2) battery++; return push(pos, color, size); };
    const tick = () => { fxView.sync([row], [], null); fxView.update(1 / 60, null); vfx.update(1 / 60, null, [row]); };
    tick(); tick();
    const lit = battery; battery = 0;
    row.tw = [0, 20, 0, 0, 16, TITAN_PHASE.idle]; tick();
    check(() => assert.ok(lit > 0 && battery === 0, `battery glow lit ${lit}, out ${battery}`));
    const mount = vehicleMountOrder('titan_ion')[0];
    for (const weapon of ['splitter', 'railgun', 'leadwall', 't203', 'predatorClose']) {
      check(() => assert.equal(vfx.handleEvent({ kind: 'shoot', vehicleId: 'v-ion', mount, vehicleWeapon: weapon, id: 'pilot', o: [0, 15, -3], d: [0, 0, -1],
        paths: [[{ end: [0, 15, -40] }]], tracer: true }), true, `VehicleFx ${weapon} shot`));
    }
    vfx.dispose?.(); fxView.dispose();
  }

  // Projectile views: registered and flown by ProjectileFX's shared rocket integrator.
  {
    const pfx = new ProjectileFX(new THREE.Scene(), () => 0);
    for (const [i, type] of ['t203', 'leadwall', 'cluster', 'flightRocket'].entries()) {
      check(() => assert.equal(typeof PROJECTILE_VIEWS[type]?.launch, 'function', `projectile view ${type}`));
      check(() => assert.ok(pfx.launch({ type, pid: `tp${i}`, o: [0, 20, 0], v: [0, 0, -60], g: type === 't203' ? 12 : 0 }), `${type} launches`));
    }
    for (let i = 0; i < 30; i++) { pfx.update(1 / 60); projectileViewsFrame(1 / 60); }
    for (const [i, type] of ['t203', 'leadwall', 'cluster', 'flightRocket'].entries()) {
      const p = pfx.projectiles.get(`tp${i}`);
      check(() => assert.ok(p && Math.abs(p.z + 30) < 0.5 && (type === 't203' ? p.y < 20 : Math.abs(p.y - 20) < 1e-6), `${type} flight (${p?.z.toFixed(2)}, ${p?.y.toFixed(2)})`));
      pfx.explode({ pid: `tp${i}`, type, x: p.x, y: p.y, z: p.z });
    }
    check(() => assert.equal(pfx.projectiles.size, 0, 'projectile views end on explode'));
  }
}

// Server events -> client (stage D, WP5 ability presentation): a real GameEngine titanfall match on a
// flattened harbour arena; each tick its snapshot rows and events feed VehicleView, VehicleFx and the
// presentation (fake particle/shake sinks), and the client effects are held to the server state.
{
  const expect = (cond, msg) => check(() => assert.ok(cond, msg));
  const finiteVec = v => Array.isArray(v) && v.every(Number.isFinite);
  const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const TPS = 1000 / TICK_MS, ticks = s => Math.round(s * TPS);
  const DROP_TICKS = Math.ceil((TITAN_RULES.drop.markerMs + TITAN_RULES.drop.fallMs) / TICK_MS) + 2;
  const G = 10, ARENA = { minX: 30, maxX: 160, minZ: 40, maxZ: 104 };

  function arena() {
    const f = { events: [], last: null, pending: [] };
    f.engine = new GameEngine({ mode: 'titanfall', mapMeta: getMapMeta('harbor'), world: createMapState('harbor'),
      broadcast: s => { f.last = s; for (const e of s.events ?? []) { f.events.push(e); f.pending.push(e); } } });
    f.policy = f.engine.mode.policy; f.titans = f.engine.vehicles.titans; f.vehicles = f.engine.vehicles;
    for (const [id, team] of [['a1', 'alpha'], ['a2', 'alpha'], ['b1', 'bravo'], ['b2', 'bravo']]) { f.engine.addClient(id, id.toUpperCase()); f.policy.setLobbyTeam(id, team); f.policy.deployNow(id); }
    const w = f.engine.world, sy = w.dimensions.sy;
    for (let x = ARENA.minX; x < ARENA.maxX; x++) for (let z = ARENA.minZ; z < ARENA.maxZ; z++) for (let y = 0; y < sy; y++) w.setBlock(x, y, z, y < G ? STONE : AIR);
    f.engine.blockRevision++;
    f.p = id => f.engine.entities.get(id);
    // Client side: the view and the presentation read the server's own voxels.
    const getBlock = (x, y, z) => w.getBlock(x, y, z);
    f.counts = {}; f.particles = {};
    f.fx = { emit: (kind, pos, opts) => { assert.ok(finiteVec(pos), `particle ${kind} at a finite position`); f.counts[kind] = (f.counts[kind] || 0) + 1; f.particles[kind] = (f.particles[kind] || 0) + (opts?.count ?? 1); },
      addEmitter: params => ({ ...params }), removeEmitter: () => {} };
    f.scene = new THREE.Group();
    f.view = new VehicleView({ getBlock });
    f.camera = new THREE.PerspectiveCamera(); f.camera.position.set(60, 30, 100);
    f.trauma = 0;
    titanPresentation.setTitanWorld({ getBlock, fx: f.fx, shake: { add: t => { f.trauma += t; } }, scene: f.scene, view: f.view, camera: f.camera,
      selfId: () => 'a1', teamOf: id => f.p(id)?.team ?? null });
    f.vfx = new VehicleFx({ fx: f.fx, vehicleView: f.view, getBlock });
    f.client = () => {
      const rows = f.last?.vehicles ?? [];
      f.view.sync(rows, f.last?.players ?? [], { id: 'a1', team: 'alpha' });
      f.view.update(TICK_MS / 1000, f.camera);
      for (const e of f.pending.splice(0)) { titanPresentation.onEvent(e); f.vfx.handleEvent(e, 'a1'); }
      titanPresentation.frame(TICK_MS / 1000, { camera: f.camera });
    };
    f.step = (n = 1, each = null) => { for (let i = 0; i < n; i++) { each?.(i); f.engine.step(TICK_MS); f.client(); } };
    f.step(2);
    for (const p of f.engine.entities.values()) if (p.state === 'alive') p.spawnProtectedUntil = Infinity;
    f.ability = (kind, extra = {}) => f.events.filter(e => e.kind === 'titan_ability' && e.ability === kind && Object.entries(extra).every(([k, v]) => e[k] === v));
    return f;
  }
  function place(p, x, z, yaw = 0) {
    Object.assign(p, { x, y: G, z, vx: 0, vy: 0, vz: 0, grounded: true, yaw, pitch: 0, spawnProtectedUntil: 0, spawnProtected: false });
    p.input = { ...(p.input || {}), keys: {}, yaw, pitch: 0 }; p.hist = [];
  }
  function park(f, p) { if (p.state === 'alive') f.engine.killPlayer(p, null, 'world', false); p.respawnAt = Infinity; }
  function landTitan(f, owner, type, x, z, yaw) {
    const v = f.titans.spawnDrop(owner, x, G, z, type, yaw);
    assert.ok(v, `spawnDrop ${type}`);
    f.step(DROP_TICKS + ticks(1.1));
    return v;
  }
  function embark(f, p, v) {
    place(p, v.x + Math.sin(v.yaw) * (titanFrame(v).hl + 1.2), v.z + Math.cos(v.yaw) * (titanFrame(v).hl + 1.2), v.yaw);
    f.vehicles.action(p, { type: 'enter', vehicleId: v.id });
    f.step(ticks(TITAN_RULES.embark.animMs / 1000) + 2);
    assert.ok(p.vehicleId === v.id, `${p.id} embarks ${v.type}`);
  }
  const drive = (p, { throttle = 0, steer = 0, yaw, pitch = 0, hold = 0, fire = false } = {}) => {
    p.input = { ...(p.input || {}), keys: {}, vehicleThrottle: throttle, vehicleSteer: steer, yaw, pitch, titanHold: hold, wantFire: fire };
  };
  function aimTitan(p, v, point, extra = {}) {
    const seat = vehicleDef(v).seats[0], pose = mountPose(v, seat.id, seat.mounts[0]);
    const a = aimAngles(pose?.pivot ?? [v.x, v.y + titanFrame(v).eye, v.z], point);
    drive(p, { yaw: a.yaw, pitch: a.pitch, ...extra });
  }
  const centre = v => [v.x, v.y + titanFrame(v).height * 0.65, v.z];
  function duel(type, targetType, gap = 16, x = 60, z = 72) {
    const f = arena();
    const [a1, b1] = ['a1', 'b1'].map(f.p);
    for (const id of ['a2', 'b2']) park(f, f.p(id));
    place(b1, 40, 100, 0);
    const shooter = landTitan(f, a1, type, x, z, -Math.PI / 2);
    embark(f, a1, shooter);
    const target = landTitan(f, b1, targetType, x + gap, z, Math.PI / 2);
    embark(f, b1, target);
    drive(a1, { yaw: -Math.PI / 2 }); drive(b1, { yaw: Math.PI / 2 });
    f.step(ticks(0.5));
    return { f, a1, b1, shooter, target };
  }
  const done = f => { f.engine.stop(); titanPresentation.dispose(); f.vfx.dispose?.(); f.view.dispose(); };

  // ---- 1. ION tripwire on a walking SCORCH; laser shot from the chest; ----------------------
  {
    const { f, a1, b1, shooter: ion, target } = duel('titan_ion', 'titan_scorch', 24);
    f.titans.ability(ion, a1, 'tac');
    f.step(1);
    const placed = f.ability('tripwire')[0];
    expect(placed?.mines?.length === 3, 'server tripwire event');
    let d = abilityEvents.inspect().deployables.find(x => x.id === placed.id);
    expect(d && d.kind === 'tripwire' && d.points.every((p, i) => dist3(p, placed.mines[i]) < 1e-9), 'client mines at the server mines');
    expect(abilityEvents.stats().props === 3, `3 mine props (${abilityEvents.stats().props})`);
    f.step(ticks(4), () => drive(b1, { yaw: Math.PI / 2, throttle: 1 }));
    expect(f.ability('tripwireTrigger', { id: placed.id }).length === 1, 'server tripwireTrigger');
    expect(!abilityEvents.inspect().deployables.some(x => x.id === placed.id), 'triggered mines removed');
    expect((f.counts.fire ?? 0) > 20, 'three blasts');
    // Laser Shot: rays from the chest anchor (event.o), vehicle-fx draws no tracer for it.
    ion.tfAbility.energy = ABILITY_TUNING.energy.max;
    aimTitan(a1, ion, centre(target)); drive(b1, { yaw: Math.PI / 2 });
    f.step(2);
    const tracers = f.vfx.counts.tracer ?? 0;
    f.titans.ability(ion, a1, 'ord');
    f.step(1);
    const shoot = f.events.filter(e => e.kind === 'shoot' && e.ability === 'laserShot').at(-1);
    const shot = abilityEvents.inspect().shots.find(s => s.ability === 'laserShot');
    expect(shoot && shot && dist3(shot.o, shoot.o) < 1e-9 && dist3(shot.ends[0], shoot.paths[0][0].end) < 1e-9, 'laser shot ray from the anchor to the server end');
    expect((f.vfx.counts.tracer ?? 0) === tracers, 'no stand-in tracer from the gun');
    done(f);
  }

  // ---- 2. NORTHSTAR tethers an ION: pod, cable to the caught hull for the root, then gone ------
  {
    const { f, a1, b1, shooter: ns, target: ion } = duel('titan_northstar', 'titan_ion', 14);
    f.titans.ability(ns, a1, 'def');
    f.titans.ability(ns, a1, 'def');
    f.step(1);
    const placed = f.ability('tether');
    expect(placed.length === 2, 'two tether events');
    f.step(2);
    const trig = f.ability('tetherTrigger');
    expect(trig.length >= 1 && f.ability('deployableEnd', { deployable: 'tether' }).length >= trig.length, 'server trigger + end');
    const live = abilityEvents.inspect().deployables.filter(d => d.cable);
    expect(live.length === trig.length && live.every(d => String(d.cable.target) === String(ion.id)), `cable to the caught ION (${live.length})`);
    expect(live.every(d => Math.abs(d.cable.life - TITAN_ABILITIES.titan_northstar.defensive.rootSeconds) < 1e-6), 'cable lasts the root');
    expect(abilityEvents.stats().rays > 4, 'cable drawn');
    f.step(ticks(3.4));
    expect(abilityEvents.inspect().deployables.length === 0, 'pods gone after the root');
    done(f);
  }

  // ---- 3. SCORCH: incendiary trap lit by thermite; firewall and flame core over steps --------
  {
    const f = arena();
    const [a1, b1] = ['a1', 'b1'].map(f.p);
    for (const id of ['a2', 'b2']) park(f, f.p(id));
    place(b1, 40, 100, 0);
    const scorch = landTitan(f, a1, 'titan_scorch', 60, 60, -Math.PI / 2);
    embark(f, a1, scorch);
    const ion = landTitan(f, b1, 'titan_ion', 60, 96, 0);
    embark(f, b1, ion);
    // Terrain ahead (+X): a 2 m step up at x 70, a 3 m drop at x 76 (to G - 1), a 4 m wall at x 84.
    const w = f.engine.world;
    for (let z = 40; z < 80; z++) {
      for (let x = 70; x < 76; x++) for (let y = G; y < G + 2; y++) w.setBlock(x, y, z, STONE);
      for (let x = 76; x < 84; x++) w.setBlock(x, G - 1, z, AIR);
      for (let y = G - 1; y < G + 3; y++) w.setBlock(84, y, z, STONE);
    }
    f.engine.blockRevision++;
    drive(a1, { yaw: -Math.PI / 2 });
    f.step(2);
    const server = new Map();
    const record = () => { for (const line of scorch.tfAbility.lines) server.set(line, line.points.map(p => [...p])); };
    f.titans.ability(scorch, a1, 'ord');
    f.step(ticks(1.5), record);
    const firewall = [...server.entries()].find(([l]) => l.kind === 'firewall')?.[1];
    const client = abilityEvents.inspect().lines.find(l => l.kind === 'firewall');
    // (the event carries x, z and yaw to 0.01: the client path may drift 0.03 m sideways over 30 m)
    const same = (a, b) => a.length === b.length && a.every((p, i) => p[1] === b[i][1] && Math.hypot(p[0] - b[i][0], p[2] - b[i][2]) < 0.05);
    expect(firewall && client && same(firewall, client.points),
      `firewall follows the server's ground line (${firewall?.length} vs ${client?.points.length} points)`);
    expect(client.stopped && client.travelled < 29 && client.points.at(-1)[0] < 84, `the wall stops the line (${client.travelled.toFixed(1)} m)`);
    expect(Math.max(...client.points.map(p => p[1])) === G + 2 && Math.min(...client.points.map(p => p[1])) === G - 1, 'up the step and down the drop');
    // Flame Core: 3 lines over the same terrain.
    scorch.tfAbility.core = 1;
    server.clear();
    f.titans.ability(scorch, a1, 'core');
    f.step(ticks(1.1), record);
    const cores = [...server.entries()].filter(([l]) => l.kind === 'flameCore').map(([, pts]) => pts);
    const clientCores = abilityEvents.inspect().lines.filter(l => l.kind === 'flameCore');
    expect(cores.length === 3 && clientCores.length === 3, 'three flame core lines');
    for (const pts of cores) {
      const c = clientCores.find(l => dist3(l.points.at(-1), pts.at(-1)) < 0.1);
      expect(c && same(pts, c.points), `flame core line on the server path (${pts.length} vs ${c?.points.length})`);
    }
    const scorchItem = f.view.item(scorch.id);
    expect(scorchItem.titanEventLines != null, 'the row-bit fallback lines stand down');
    // Thermal Shield sized and placed from the server's guard sphere.
    f.step(ticks(1));
    f.titans.ability(scorch, a1, 'def');
    f.step(3);
    const guard = scorch.tfAbility.guard, sphere = serverGuardSphere(scorch, guard);
    const wall = f.scene.children.find(o => o.material?.name === 'titan-fire-wall-fx' && o.visible && Math.abs(o.scale.x - sphere[3]) < 1e-6);
    expect(wall && Math.hypot(wall.position.x - sphere[0], wall.position.z - sphere[2]) < 0.05, `thermal wall on the guard sphere (${wall ? Math.hypot(wall.position.x - sphere[0], wall.position.z - sphere[2]).toFixed(3) : 'none'})`);
    f.step(ticks(4.5));
    // Incendiary trap: placed, then lit by thermite.
    f.titans.ability(scorch, a1, 'tac');
    f.step(1);
    const trap = scorch.tfAbility.deployables.find(d => d.kind === 'incendiary');
    expect(trap && abilityEvents.inspect().deployables.some(d => d.kind === 'incendiary' && dist3(d.points[0], trap.at) < 0.01), 'canister at the trap');
    f.step(ticks(1), () => aimTitan(a1, scorch, trap.at));
    aimTitan(a1, scorch, trap.at, { fire: true });
    f.step(1);
    drive(a1, { yaw: a1.input.yaw, pitch: a1.input.pitch });
    f.step(ticks(1.5));
    expect(trap.lit && f.ability('trapIgnite').length === 1, 'server ignites the trap');
    expect(!abilityEvents.inspect().deployables.some(d => d.kind === 'incendiary'), 'canister burst');
    done(f);
  }

  // ---- 4. RONIN: arc wave on the server path, phase dash blink, melee punch, execution -------
  {
    const f = arena();
    const [a1, b1] = ['a1', 'b1'].map(f.p);
    for (const id of ['a2', 'b2']) park(f, f.p(id));
    place(b1, 40, 100, 0);
    const ronin = landTitan(f, a1, 'titan_ronin', 60, 72, -Math.PI / 2);
    embark(f, a1, ronin);
    const ion = landTitan(f, b1, 'titan_ion', 60 + titanFrame('titan_ronin').hl + titanFrame('titan_ion').hl + 2, 72, Math.PI / 2);
    embark(f, b1, ion);
    drive(a1, { yaw: -Math.PI / 2 }); drive(b1, { yaw: Math.PI / 2 });
    f.step(ticks(0.5));
    const server = new Map();
    f.titans.ability(ronin, a1, 'tac');
    f.step(ticks(0.8), () => { for (const line of ronin.tfAbility.lines) server.set(line, line.points.map(p => [...p])); });
    const arc = [...server.values()][0], client = abilityEvents.inspect().lines.find(l => l.kind === 'arcWave');
    expect(arc && client && arc.length === client.points.length && arc.every((p, i) => p[1] === client.points[i][1] && Math.hypot(p[0] - client.points[i][0], p[2] - client.points[i][2]) < 0.05),
      `arc wave on the server path (${arc?.length} vs ${client?.points.length})`);
    // Melee: the punch starts on the titanMelee shoot, strikes the ION's hull.
    f.step(ticks(1.5));
    ion.shield = 0;
    f.titans.ability(ronin, a1, 'melee');
    f.step(1);
    let swing = abilityEvents.inspect().swings.find(s => s.key === String(ronin.id));
    expect(swing && swing.kind === 'melee' && String(swing.target) === String(ion.id), 'melee swing on the target');
    const item = f.view.item(ronin.id), rest = item.model.nodes.upperL.quaternion.clone();
    f.step(ticks(0.25));
    swing = abilityEvents.inspect().swings.find(s => s.key === String(ronin.id));
    expect(swing?.struck && swing.at && Math.hypot(swing.at[0] - ion.x, swing.at[2] - ion.z) < 4, 'the punch lands on the ION');
    expect(item.model.nodes.upperL.quaternion.angleTo(rest) > 0.3, 'the left arm swings');
    f.step(ticks(0.6));
    expect(!abilityEvents.inspect().swings.length, 'the swing ends');
    // Execution of the doomed ION from the front.
    f.step(ticks(1));
    f.vehicles.damage(ion.id, ion.hp + 1, a1, { cls: 'titan', point: centre(ion) });
    f.step(2);
    f.titans.ability(ronin, a1, 'melee');
    f.step(1);
    expect(f.ability('execution').length === 1, 'server execution');
    swing = abilityEvents.inspect().swings.find(s => s.key === String(ronin.id));
    expect(swing?.kind === 'execution' && String(swing.target) === String(ion.id), 'execution finisher');
    const sparks = f.particles.spark ?? 0;
    f.step(ticks(1.2));
    expect((f.particles.spark ?? 0) - sparks > 60, 'the finisher rips sparks out of the hull');
    // Phase Dash: a blink from the old to the new spot.
    f.step(ticks(1));
    f.titans.ability(ronin, a1, 'ord');
    f.step(1);
    const dash = f.ability('phaseDash').at(-1);
    expect(dash && abilityEvents.inspect().shots.some(s => s.kind === 'blink'), 'phase dash blink');
    done(f);
  }

  // ---- 5. LEGION gun shield and power shots; ION vortex catches LEGION rounds, throws them ---
  {
    const { f, a1, b1, shooter: legion, target: ion } = duel('titan_legion', 'titan_ion', 20);
    f.titans.ability(legion, a1, 'def');
    f.step(3);
    const sphere = serverGuardSphere(legion, legion.tfAbility.guard);
    const shield = f.scene.children.find(o => o.material?.name === 'titan-shield-fx' && o.visible);
    expect(shield && shield.position.distanceTo(new THREE.Vector3(...sphere)) < 0.2 && Math.abs(shield.scale.x - sphere[3]) < 1e-6,
      `gun shield on the guard sphere (${shield?.position.distanceTo(new THREE.Vector3(...sphere)).toFixed(3)} m)`);
    f.step(ticks(5.2));
    aimTitan(a1, legion, centre(ion));
    f.step(ticks(1));
    f.titans.ability(legion, a1, 'ord');
    f.step(1);
    const close = f.events.filter(e => e.kind === 'shoot' && e.ability === 'powerShot').at(-1);
    const shot = abilityEvents.inspect().shots.find(s => s.ability === 'powerShot');
    expect(close && shot && shot.ends.length === close.paths.length && close.paths.length > 1 && dist3(shot.o, close.o) < 1e-9, `power shot: ${shot?.ends.length} rays from the shoulder`);
    done(f);
  }
  {
    const { f, a1, b1, shooter: ion, target: legion } = duel('titan_ion', 'titan_legion', 18);
    drive(a1, { yaw: -Math.PI / 2, hold: 2 });
    f.titans.ability(ion, a1, 'def');
    f.step(3, () => drive(a1, { yaw: -Math.PI / 2, hold: 2 }));
    const guard = ion.tfAbility.guard, sphere = serverGuardSphere(ion, guard);
    const dish = f.scene.children.find(o => o.material?.name === 'titan-vortex-fx' && o.visible);
    expect(dish && dish.position.distanceTo(new THREE.Vector3(...sphere)) < 0.2, `vortex dish on the catch sphere (${dish?.position.distanceTo(new THREE.Vector3(...sphere)).toFixed(3)} m)`);
    f.step(ticks(1.5), () => { drive(a1, { yaw: -Math.PI / 2, hold: 2 }); aimTitan(b1, legion, centre(ion), { fire: true }); });
    const held = abilityEvents.stats().caught;
    expect(guard.caught.length > 0 && held > 0, `vortex holds the caught rounds (server ${guard.caught.length}, client ${held})`);
    drive(b1, { yaw: Math.PI / 2 });
    f.step(2, () => drive(a1, { yaw: -Math.PI / 2, hold: 0 }));
    f.step(ticks(0.4), () => drive(a1, { yaw: -Math.PI / 2, hold: 0 }));
    const thrown = f.events.filter(e => e.kind === 'shoot' && e.ability === 'vortexThrow').at(-1);
    expect(thrown && abilityEvents.stats().caught === 0 && f.events.some(e => e.kind === 'titan_ability' && e.ability === 'vortexThrow'), 'the throw-back releases the rounds');
    done(f);
  }

  // ---- 6. ION Laser Core aimed at the server's anchorAim point ------------------------------
  {
    const { f, a1, b1, shooter: ion, target } = duel('titan_ion', 'titan_legion', 24);
    // Aim the gun at the target's flank: the anchor-along-aim beam misses it, the server hits.
    aimTitan(a1, ion, [target.x, target.y + titanFrame(target).height * 0.55, target.z + titanFrame(target).hw * 0.7]);
    f.step(ticks(1), () => aimTitan(a1, ion, [target.x, target.y + titanFrame(target).height * 0.55, target.z + titanFrame(target).hw * 0.7]));
    ion.tfAbility.core = 1;
    f.titans.ability(ion, a1, 'core');
    f.step(ticks(0.5), () => aimTitan(a1, ion, [target.x, target.y + titanFrame(target).height * 0.55, target.z + titanFrame(target).hw * 0.7]));
    const anchor = TITAN_ABILITIES.titan_ion.core.anchor;
    const origin = vehicleLocalPoint(ion, ...anchor);
    const want = anchorAim(f.titans, ion, origin, TITAN_ABILITIES.titan_ion.core.range);
    const beam = f.scene.children.find(o => o.material?.name === 'titan-laser-beam-fx' && o.visible);
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(beam.quaternion);
    const angle = dir.angleTo(new THREE.Vector3(...want));
    const length = beam.scale.z;
    expect(angle < 0.6 * Math.PI / 180, `laser beam along the server's anchorAim (${(angle * 180 / Math.PI).toFixed(2)}°)`);
    expect(length < 30 && length > 15, `the beam ends on the target hull (${length.toFixed(1)} m)`);
    const dealt = target.damageLog?.get('a1')?.dmg ?? 0;
    expect(dealt > 0, `server core hits the target (${dealt.toFixed(0)})`);
    done(f);
  }

  // ---- 7. Pinned numbers, the client surface probe, warmup programs, dispose -----------------
  {
    const T = ABILITY_TUNING, E = abilityEvents.TITAN_EVENT_FX, S = abilityFx.TITAN_GUARD_SPHERES;
    expect(E.line.sample === T.line.sample && E.line.rise === T.line.rise && E.line.fall === T.line.fall && E.line.tickHz === TICK_RATE_HZ, 'line sampling = server');
    for (const k of ['firewall', 'arcWave', 'flameCore']) expect(E[k].speed === T[k].speed && E[k].width === T[k].width, `${k} speed/width = server`);
    expect(E.tripwire.blastRadius === T.tripwire.blastRadius && E.tether.triggerRadius === T.tether.triggerRadius && E.incendiary.igniteRadius === T.incendiary.igniteRadius, 'trap radii = server');
    expect(S.thermal.ahead === T.thermal.ahead && S.thermal.radius === T.thermal.radius && S.gunShield.ahead === T.gunShield.ahead && S.gunShield.radius === T.gunShield.radius, 'guard spheres = server');
    // The client surface probe agrees with the server's on a rough patch of voxels.
    const f = arena();
    const w = f.engine.world;
    let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 300; i++) { const x = 40 + Math.floor(rnd() * 40), z = 50 + Math.floor(rnd() * 40), h = Math.floor(rnd() * 6); for (let y = G; y < G + h; y++) w.setBlock(x, y, z, STONE); }
    for (let i = 0; i < 60; i++) { const x = 40 + Math.floor(rnd() * 40), z = 50 + Math.floor(rnd() * 40); for (let y = G - 4; y < G; y++) w.setBlock(x, y, z, AIR); }
    let same = 0;
    for (let i = 0; i < 2000; i++) {
      const x = 40 + rnd() * 40, z = 50 + rnd() * 40, y = G + rnd() * 4;
      if (serverSurfaceNear(f.titans, x, z, y, T.line.rise, T.line.fall) === abilityEvents.surfaceNear(x, z, y, T.line.rise, T.line.fall)) same++;
    }
    expect(same === 2000, `client surfaceNear = server (${same}/2000)`);
    const names = new Set(); abilityEvents.warmupRoot().traverse(o => o.material && names.add(o.material.name));
    for (const name of abilityEvents.TITAN_EVENT_FX_WARMUP_MATERIALS) expect(names.has(name) && titanPresentation.TITAN_WARMUP_MATERIALS.includes(name), `warmup carries ${name}`);
    done(f);
    expect(f.scene.children.length === 0 && abilityEvents.stats().deployables === 0 && abilityEvents.stats().lines === 0, `dispose empties the scene (${f.scene.children.length})`);
  }
}

const skipped = TITAN_TYPE_IDS.filter(type => !types.includes(type));
/**
 * Titan cockpit (public/js/titanfall/titan-cockpit.js; docs/titanfall.md §7.2): rays from the eye must hit
 * cockpit geometry or the viewport glass in every direction of the sphere and over every pixel of every
 * screen shape at every reachable FOV (settings 65-100, + speed widening 8, + titanfall punch 9) and sway
 * extreme; the crosshair area looks through the glass and the viewport is big enough to fight through;
 * budget, shared geometry, dispose, live lamp state and the view-model placement.
 */
function cockpitChecks() {
  const SIZES = [[1920, 1080], [1280, 720], [2560, 1080], [3440, 1440], [1024, 768], [844, 390], [390, 844], [360, 800]];
  const FOVS = [65, 75, 100, 108, 117];
  const sway = TITAN_COCKPIT.sway.max + TITAN_COCKPIT.sway.jolt;
  const SWAYS = [[0, 0], [sway, sway], [-sway, sway], [sway, -sway], [-sway, -sway]];
  const results = [];
  for (const type of TITAN_TYPE_IDS) {
    const cabin = titanCockpitCabin(type);
    // Triangles (eye at the origin) with a bounding cone each, glass flagged.
    const tris = [], glass = [];
    for (const [kind, geometry] of Object.entries(cabin.geometries)) {
      const pos = geometry.attributes.position;
      for (let i = 0; i < pos.count; i += 3) { tris.push(...[0, 1, 2].flatMap(k => [pos.getX(i + k), pos.getY(i + k), pos.getZ(i + k)])); glass.push(kind === 'glass'); }
    }
    const n = glass.length, T = Float32Array.from(tris), cone = new Float32Array(n * 4);
    for (let t = 0; t < n; t++) {
      let cx = 0, cy = 0, cz = 0;
      for (let k = 0; k < 3; k++) { const o = t * 9 + k * 3, l = Math.hypot(T[o], T[o + 1], T[o + 2]); cx += T[o] / l; cy += T[o + 1] / l; cz += T[o + 2] / l; }
      const l = Math.hypot(cx, cy, cz) || 1; cx /= l; cy /= l; cz /= l;
      let cos = 1;
      for (let k = 0; k < 3; k++) { const o = t * 9 + k * 3, v = Math.hypot(T[o], T[o + 1], T[o + 2]); cos = Math.min(cos, (T[o] * cx + T[o + 1] * cy + T[o + 2] * cz) / v); }
      cone.set([cx, cy, cz, cos - 1e-4], t * 4);
    }
    // Nearest hit along a unit ray from the eye: 0 none, 1 cockpit, 2 glass.
    const cast = (dx, dy, dz) => {
      let best = Infinity, hit = 0;
      for (let t = 0; t < n; t++) {
        const c = t * 4;
        if (dx * cone[c] + dy * cone[c + 1] + dz * cone[c + 2] < cone[c + 3]) continue;
        const o = t * 9;
        const e1x = T[o + 3] - T[o], e1y = T[o + 4] - T[o + 1], e1z = T[o + 5] - T[o + 2];
        const e2x = T[o + 6] - T[o], e2y = T[o + 7] - T[o + 1], e2z = T[o + 8] - T[o + 2];
        const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
        const det = e1x * px + e1y * py + e1z * pz;
        if (Math.abs(det) < 1e-12) continue;
        const inv = 1 / det, sx = -T[o], sy = -T[o + 1], sz = -T[o + 2];
        const u = (sx * px + sy * py + sz * pz) * inv;
        if (u < -1e-5 || u > 1 + 1e-5) continue;
        const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
        const v = (dx * qx + dy * qy + dz * qz) * inv;
        if (v < -1e-5 || u + v > 1 + 1e-5) continue;
        const d = (e2x * qx + e2y * qy + e2z * qz) * inv;
        if (d > 0.05 && d < best) { best = d; hit = glass[t] ? 2 : 1; }
      }
      return { hit, distance: best };
    };
    // 1. The whole sphere (any look direction, any hull lag): closed.
    let holes = 0, rays = 0, closest = Infinity;
    for (let el = -89; el <= 89; el += 4) for (let az = 0; az < 360; az += 4) {
      const e = el * Math.PI / 180, a = az * Math.PI / 180, r = cast(Math.cos(e) * Math.sin(a), Math.sin(e), -Math.cos(e) * Math.cos(a));
      rays++; if (!r.hit) holes++; else closest = Math.min(closest, r.distance);
    }
    for (const dy of [-1, 1]) { rays++; if (!cast(0, dy, 0).hit) holes++; }
    check(() => assert.equal(holes, 0, `${type} cockpit: ${holes}/${rays} sphere rays leave the cabin`));
    check(() => assert.ok(closest > 0.25, `${type} cockpit: nearest surface ${closest.toFixed(3)} m clears the near plane`));
    // 2. Every pixel of every screen shape, FOV and sway: cockpit or viewport glass.
    let screenHoles = 0, screenRays = 0;
    for (const [w, h] of SIZES) {
      const aspect = w / h, own = cockpitFrustum(aspect);
      // The cockpit's own frustum is FOV independent: the view-space scale maps every FOV onto it.
      for (const fov of FOVS) {
        const camera = new THREE.PerspectiveCamera(fov, aspect, 0.05, 400), { kx, ky } = cockpitScale(camera);
        const tanV = Math.tan(fov * Math.PI / 360);
        check(() => assert.ok(Math.abs(tanV * aspect / kx - own.tanH) < 1e-9 && Math.abs(tanV / ky - own.tanV) < 1e-9, `${type} ${w}x${h} fov ${fov}: cockpit frustum`));
      }
      const cols = 40, rows = Math.max(12, Math.round(cols / aspect));
      for (const [yaw, pitch] of SWAYS) {
        const rot = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ')).invert(), d = new THREE.Vector3();
        for (let i = 0; i <= cols; i++) for (let j = 0; j <= rows; j++) {
          d.set((i / cols * 2 - 1) * own.tanH, (j / rows * 2 - 1) * own.tanV, -1).normalize().applyMatrix4(rot);
          screenRays++; if (!cast(d.x, d.y, d.z).hit) screenHoles++;
        }
      }
    }
    check(() => assert.equal(screenHoles, 0, `${type} cockpit: ${screenHoles}/${screenRays} screen rays see past the cabin`));
    // 3. The viewport at 16:9: the crosshair area is glass, and enough of the screen to fight through.
    const own = cockpitFrustum(16 / 9);
    let glassRays = 0, all = 0, blocked = 0;
    for (let i = 0; i <= 64; i++) for (let j = 0; j <= 36; j++) {
      const u = i / 32 - 1, v = j / 18 - 1, r = cast(...new THREE.Vector3(u * own.tanH, v * own.tanV, -1).normalize().toArray());
      all++; if (r.hit === 2) glassRays++;
      if (Math.abs(u) <= 0.45 && Math.abs(v) <= 0.3 && r.hit !== 2) blocked++;
    }
    const share = glassRays / all;
    check(() => assert.equal(blocked, 0, `${type} cockpit: ${blocked} rays of the crosshair area (|u| ≤ 0.45, |v| ≤ 0.3) blocked`));
    check(() => assert.ok(share >= 0.35, `${type} cockpit: viewport ${(share * 100).toFixed(0)} % of a 16:9 screen`));
    results.push(`${type.slice(6)} ${(share * 100).toFixed(0)}%`);
    cabin.release();
  }
  // Budget, shared geometry, materials, dispose.
  for (const type of TITAN_TYPE_IDS) {
    const a = makeTitanCockpit(type), b = makeTitanCockpit(type);
    const meshes = [], materials = new Set();
    let triangles = 0;
    let fxMeshes = 0, fxTriangles = 0;
    a.group.traverse(o => {
      if (!o.isMesh) return;
      materials.add(o.material.name);
      // Damage and transit dressing (titan-cockpit-fx.js): hidden until needed, budgeted apart.
      if (o.userData.cockpitFx) { fxMeshes++; fxTriangles += o.geometry.attributes.position.count / 3; check(() => assert.equal(o.visible, false, `${o.name} hidden by default`)); return; }
      meshes.push(o); triangles += o.geometry.attributes.position.count / 3;
    });
    check(() => assert.ok(meshes.length <= 11 && triangles <= 14000, `${type} cockpit budget: ${meshes.length} draws, ${triangles} triangles`));
    check(() => assert.ok(fxMeshes <= 12 && fxTriangles <= 6000, `${type} cockpit fx budget: ${fxMeshes} draws, ${fxTriangles} triangles`));
    check(() => assert.deepEqual([...materials].sort(), [...TITAN_COCKPIT_WARMUP_MATERIALS].sort(), `${type} cockpit programs are the warmed ones`));
    const shared = a.group.children.filter(o => o.name.endsWith('-shell'))[0].geometry === b.group.children.filter(o => o.name.endsWith('-shell'))[0].geometry;
    check(() => assert.ok(shared, `${type} cockpit geometry is cached and shared`));
    const all = []; a.group.traverse(o => { if (o.isMesh) all.push(o); });
    check(() => assert.ok(all.every(m => m.frustumCulled === false && !m.castShadow), `${type} cockpit meshes: no culling, no shadows`));
    a.dispose();
    check(() => assert.equal(titanCockpitCacheSize(), 1, `${type} cockpit: geometry kept while another cockpit uses it`));
    b.dispose();
    check(() => assert.equal(titanCockpitCacheSize(), 0, `${type} cockpit: geometry freed with the last cockpit`));
  }
  // The near-depth view model: the vertex shader is compressed into the front of the depth range.
  {
    const cockpit = makeTitanCockpit('titan_ion');
    const shell = cockpit.group.children.find(o => o.name.endsWith('-shell'));
    const shader = { vertexShader: 'void main() {\n#include <project_vertex>\n}' };
    shell.material.onBeforeCompile(shader);
    check(() => assert.ok(/gl_Position\.z = mix\(-gl_Position\.w, gl_Position\.z/.test(shader.vertexShader), 'cockpit draws in front of the depth range'));
    // Placement: locked to the camera through its own frustum; hidden from cameras away from the eye.
    const root = new THREE.Group(); root.position.set(4, 20, -3); root.rotation.y = 0.7; root.add(cockpit.group); root.updateMatrixWorld(true);
    const camera = new THREE.PerspectiveCamera(100, 16 / 9, 0.05, 400);
    camera.position.copy(cockpit.group.localToWorld(shell.position.clone())); camera.rotation.set(-0.6, 1.1, 0, 'YXZ'); camera.updateMatrixWorld(true);
    const renderer = { info: { render: { frame: 1 } } };
    shell.onBeforeRender(renderer, null, camera);
    const { kx, ky } = cockpitScale(camera);
    const expected = camera.matrixWorld.clone().multiply(new THREE.Matrix4().makeScale(kx, ky, 1));
    check(() => assert.ok(shell.matrixWorld.elements.every((v, i) => Math.abs(v - expected.elements[i]) < 1e-6), 'cockpit locked to the camera (pitch -0.6) through its own frustum'));
    camera.position.x += 10; camera.updateMatrixWorld(true); renderer.info.render.frame = 2;
    shell.onBeforeRender(renderer, null, camera);
    check(() => assert.ok(shell.matrixWorld.elements.slice(0, 11).every(v => v === 0), 'cockpit hidden from a camera away from the eye'));
    // Live state from the row: doom flashes the warning lamps, a ready core lifts the accent, a hit sparks.
    const row = { type: 'titan_ion', hp: 2500, yaw: 0, tw: [500, 20, 40, 0, 0, TITAN_PHASE.idle], mounts: [[0, 0, 20, 0, 0, 0]], ab: [100, 50, 100, 2] };
    const mat = name => cockpit.group.children.find(o => o.name.endsWith(`-${name}`)).material;
    cockpit.update(row, 1000);
    const calm = mat('warn').color.r, base = mat('accent').color.r + mat('accent').color.g + mat('accent').color.b;
    cockpit.update({ ...row, hp: 1200, tw: [0, 20, 40, 0, 0, TITAN_PHASE.idle] }, 1100);
    const sparks = cockpit.group.children.find(o => o.name.endsWith('-sparks')).geometry.attributes.color.array.some(v => v > 0);
    check(() => assert.ok(sparks, 'a hull hit throws sparks in the cockpit'));
    const doomFlash = [0, 170, 340, 510].map(ms => { cockpit.update({ ...row, hp: 300, tw: [0, 20, 40, 50, 0, TITAN_PHASE.doomed] }, 5000 + ms); return mat('warn').color.r; });
    check(() => assert.ok(Math.max(...doomFlash) > calm * 3 && Math.min(...doomFlash) < calm, `doom flashes the warning lamps: ${doomFlash.map(v => v.toFixed(2))}`));
    check(() => assert.ok(mat('shell').color.g < 0.85, 'doom tints the cabin red'));
    const ready = [0, 120, 240].map(ms => { cockpit.update({ ...row, tw: [500, 20, 100, 0, 0, TITAN_PHASE.idle] }, 9000 + ms); const c = mat('accent').color; return c.r + c.g + c.b; });
    check(() => assert.ok(Math.max(...ready) > base * 1.3, 'a ready core glows the accent strips'));
    cockpit.dispose();
    disposePresentation?.();
  }
  // Diegetic HUD (titan-cockpit-hud.js): every HUD field drawn on the cockpit's pods, brow, feed screen and glass, from
  // the model titan-ui publishes (the capture states stage it), the row as fallback; rate caps; glass placement; dispose.
  {
    const stubDocument = globalThis.document, logs = new Map();
    globalThis.document = { createElement: () => {
      const texts = [], canvas = { width: 0, height: 0 };
      const ctx = new Proxy({}, { get: (o, k) => (k === 'fillText' ? (v => texts.push(String(v))) : k === 'measureText' ? (v => ({ width: String(v).length * 10 })) : o[k] ?? (() => {})) });
      canvas.getContext = () => ctx; logs.set(canvas, texts);
      return canvas;
    } };
    const drawn = (canvas, value) => logs.get(canvas)?.includes(String(value));
    const makeHud = type => {
      const group = new THREE.Group(); group.updateMatrixWorld(true);
      const hud = createCockpitHud({ type, group, eye: [0, 1, 0], eyeTolerance: 0.5 });
      group.add(...hud.meshes, hud.glass);
      return { group, hud };
    };
    const renderer = { getRenderTarget: () => null, getDrawingBufferSize: v => v.set(1920, 1080) };
    const eyeCamera = (aspect = 16 / 9) => { const c = new THREE.PerspectiveCamera(70, aspect, 0.05, 400); c.position.set(0, 1, 0); c.updateMatrixWorld(true); return c; };
    let fields = 0;
    for (const type of TITAN_TYPE_IDS) for (const id of Object.keys(COCKPIT_HUD_STATES)) {
      const { hud } = makeHud(type);
      const params = stageCockpitHud(id, type), model = params.model, s = model.titan, top = model.top, label = `${type} ${id} HUD`;
      const rowModel = titanModel({ type, ...params.row }, { now: 1000 });
      check(() => assert.ok(hud.meshes.every(m => COCKPIT_HUD_WARMUP_MATERIALS.includes(m.material.name)) && COCKPIT_HUD_WARMUP_MATERIALS.includes(hud.glass.material.name), `${label}: warmed programs`));
      hud.update(rowModel, 10, params.row);
      hud.glass.onBeforeRender(renderer, null, eyeCamera());
      const d = hud.debug(), { pods, panels, glass } = d.canvases;
      check(() => assert.equal(d.view.titan, s, `${label}: the published model drives the cockpit`));
      check(() => assert.equal(d.view.top, top, `${label}: score from the published model`));
      check(() => assert.ok(d.glass.width > 8 && d.glass.height > 8, `${label}: glass sized to the buffer (${d.glass.width}x${d.glass.height})`));
      const expect = [
        // Pods: weapon, core (+ badge), status (dash / hull / shield / doom + eject), abilities (+ keys) and smoke.
        [pods, s.weapon.label], [pods, s.core.label], [pods, s.core.active ? 'ON' : `${s.core.pct}%`], [pods, s.core.key], [pods, 'LV 14 · KADE'],
        [pods, s.dash.key], [pods, s.smoke.key],
        ...s.abilities.flatMap(a => [[pods, a.key], [pods, a.state === 'ready' ? 'READY' : a.state === 'active' ? 'ON' : `${a.readyPct}%`]]),
        ...(s.doomed ? [[pods, 'DOOMED'], [pods, `PRESS ${s.eject.key} ×3 · EJECT`]] : [[pods, s.healthText], [pods, String(Math.ceil(s.shield))]]),
        // Brow and feed screen: score, clock, every kill feed row.
        [panels, top.own.score], [panels, top.enemy.score], [panels, top.clock], ...d.feed.flatMap(r => [[panels, r.killer], [panels, r.victim], [panels, r.weapon]]),
        // Glass: hull, ammo, dash key, doom + eject, lock warnings, core cue, the alert line.
        [glass, s.healthText], [glass, (s.weapon.reload ?? 0) > 0 && s.weapon.ammo === 0 ? 'RELOAD' : s.weapon.ammoText], [glass, s.dash.key],
        ...(s.doomed ? [[glass, 'DOOMED'], [glass, `PRESS ${s.eject.key} ×3 · EJECT`]] : []),
        ...(s.lock && s.lock.state < 3 ? [[glass, s.lock.label]] : []),
        ...(s.core.ready && !s.doomed ? [[glass, `CORE READY · ${s.core.key}`]] : []),
        ...(d.glass.alert ? [[glass, d.glass.alert]] : []),
      ];
      for (const [canvas, value] of expect) { fields++; check(() => assert.ok(drawn(canvas, value), `${label}: "${value}" drawn`)); }
      check(() => assert.equal(d.feed.length, COCKPIT_HUD_STATES[id].feed ?? 0, `${label}: kill feed rows`));
      const alert = s.doomed ? '' : s.lock?.state === 3 ? s.lock.label : model.rider || (s.batteryOut ? 'BATTERY STOLEN' : '');
      if (alert) check(() => assert.equal(d.glass.alert, alert, `${label}: alert line`));
      check(() => assert.equal(d.glass.hit, COCKPIT_HUD_STATES[id].hit ?? 0, `${label}: hit marker on the glass`));
      // Fallback: a stale, a missing or another hull's model leaves the cockpit on its own row.
      publishCockpitHud({ ...model, titan: s }, {}, performance.now() - COCKPIT_HUD.modelMs - 100);
      hud.update(rowModel, 11, params.row);
      check(() => assert.equal(hud.debug().view.titan, rowModel, `${label}: stale model falls back to the row`));
      hud.dispose();
    }
    summary.push(`cockpit HUD ${fields} fields`);
    // Another hull's model; no model; rate caps; placement; portrait; dispose.
    {
      const params = stageCockpitHud('idle', 'titan_ion');
      const { group, hud } = makeHud('titan_scorch');
      const rowModel = titanModel({ type: 'titan_scorch', ...params.row }, { now: 1000 });
      hud.update(rowModel, 1, params.row);
      check(() => assert.equal(hud.debug().view.titan, rowModel, "another hull's model is ignored"));
      resetCockpitHud();
      hud.update(null, 2, null);
      check(() => assert.equal(hud.debug().view.titan, null, 'no model, no row: standby'));
      check(() => assert.ok(!cockpitHudLive(), 'HUD not live before the glass is drawn'));
      // Gauges redraw at most COCKPIT_HUD.podHz however fast the frames come and the values change.
      const before = hud.debug().draws;
      for (let i = 0; i < 120; i++) hud.update(titanModel({ type: 'titan_scorch', ...params.row, hp: 4000 - i * 20 }, { now: 1000 }), 3 + i / 120, null);
      const after = hud.debug().draws;
      check(() => assert.ok(after.pods - before.pods <= COCKPIT_HUD.podHz + 1, `pods capped at ${COCKPIT_HUD.podHz} Hz: ${after.pods - before.pods}`));
      check(() => assert.ok(after.pods - before.pods >= 10, `gauges at least 10 Hz: ${after.pods - before.pods}`));
      check(() => assert.ok(after.glass - before.glass <= COCKPIT_HUD.glassHz + 1, `glass capped at ${COCKPIT_HUD.glassHz} Hz: ${after.glass - before.glass}`));
      const settled = hud.debug().draws;
      const still = titanModel({ type: 'titan_scorch', ...params.row, hp: 1600 }, { now: 1000 });
      for (let i = 0; i < 60; i++) hud.update(still, 10 + i / 60, null);
      const quiet = hud.debug().draws;
      const quietPods = quiet.pods - settled.pods;
      check(() => assert.ok(quietPods <= 1 && quiet.panels - settled.panels <= 4 && quiet.glass - settled.glass <= 1, `no uploads while nothing changes: ${JSON.stringify(quiet)}`));
      // The glass sits on the view axis in front of the camera at the seat eye; away from it, it hides.
      const camera = eyeCamera();
      hud.glass.onBeforeRender(renderer, null, camera);
      check(() => assert.ok(cockpitHudLive(), 'glass drawn: HUD live (titan-ui hides the DOM HUD)'));
      const p = new THREE.Vector3().setFromMatrixPosition(hud.glass.matrixWorld).applyMatrix4(camera.matrixWorldInverse);
      check(() => assert.ok(p.z < 0 && p.z > -1.5 && Math.abs(p.x) < 0.1, `glass in front of the eye: ${p.toArray().map(v => v.toFixed(3))}`));
      camera.position.x += 5; camera.updateMatrixWorld(true);
      hud.glass.onBeforeRender(renderer, null, camera);
      check(() => assert.ok(hud.glass.matrixWorld.elements.slice(0, 11).every(v => v === 0), 'glass hidden from a camera away from the eye'));
      check(() => assert.ok(!cockpitHudLive(performance.now() + COCKPIT_HUD.liveMs + 50), 'HUD stops being live once the glass stops drawing'));
      check(() => assert.deepEqual(hud.meshes.map(m => m.userData.portraitDark), [true, false, true], 'portrait darkens the pods and the feed, keeps the brow'));
      let freed = 0;
      for (const m of [...hud.meshes, hud.glass]) m.geometry.addEventListener('dispose', () => freed++);
      hud.dispose();
      check(() => assert.ok(freed === 4 && group.children.length === 0, `HUD dispose frees its geometry (${freed}/4)`));
    }
    resetCockpitHud(); setCockpitHudStock(null);
    globalThis.document = stubDocument;
  }
  summary.push(`cockpit viewports ${results.join(', ')}`);
}

console.log(`Titan models: ${checks} checks passed (${summary.join('; ')})${skipped.length ? `; placeholder: ${skipped.join(', ')}` : ''}.`);
