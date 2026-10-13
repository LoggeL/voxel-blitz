// Titan presentation (docs/titanfall.md §7, owned by WP5): the five titan
// models, the walker update that feeds the rig (`item.model.animate(step, state)`)
// and everything a titan shows beyond its pose, all from authoritative rows
// and events:
//   - rig ground probe through the voxel world, footfall dust, camera shake and
//     footstep audio for the own titan and nearby ones, dash thruster bursts
//   - titanfall: re-entry streak while dropping, the marker beam (titanfall_drop),
//     the landing slam (dust ring, shake, the rig's fist-down crouch)
//   - embark: the pilot avatar runs in, rides the left palm up and drops into the
//     open hatch (rig phase 3); disembark vents the hatch
//   - doom sparks, fire and smoke; eject: the hatch blows off as its own fragment
//     and the pilot's launch leaves a smoke trail
//   - battery glow (VehicleFx light sprite) and sparks from an empty socket
//   - rodeo: `riderAnchor(vehicleId)` gives the animated back anchor for rider poses
//   - ability visuals (titan-ability-fx.js) and the titan weapon/footstep audio
//     (VehicleAudio titan methods)
//
// Frozen interface:
//   client-module contract  init?(app, client), tick(snapshot, dt), frame(dt, ctx), onEvent(event), dispose()
//   createModel(type, options) -> model    VehicleView's factory for every TITAN_TYPE_IDS type
//   update(item, row, dt)                  VehicleView's walker branch (replaces ground attitude and
//                                           suspension; the root already carries position and hull yaw)
import * as THREE from '../vendor/three.module.js';
import { decodeTitanRow, TITAN_PHASE, TITAN_WEAPON_META, isTitanType } from '../../../shared/titan-contract.js';
import { TITAN_RULES } from '../../../shared/vehicle-handling/titan.js';
import { vehicleOccupiedSeats } from '../../../shared/vehicle-seats.js';
import { isSolidBlock } from '../../../shared/worlddata.js';
import { makeAvatar, setAvatarTeam, disposeAvatar } from '../avatar/avatar.js';
import { fragmentMaterial } from '../vehicles/vehicle-fragments.js';
import * as abilityFx from './titan-ability-fx.js';
import * as abilityEvents from './titan-ability-events.js';
import * as dropFx from './titanfall-drop-fx.js';
import { makeCockpitOverlay } from '../vehicles/cockpit-overlay.js';
// Installs the detailed titan cockpit into cockpit-overlay.js (setTitanCockpitBuilder).
import { TITAN_COCKPIT_WARMUP_MATERIALS } from './titan-cockpit.js';
import { warmupRoot as pilotProjectileWarmup } from './pilot-projectile-views.js';
import { warmupRoot as titanProjectileWarmup } from './titan-projectile-views.js';
import { makeTitanPlaceholderModel } from '../vehicles/models/titan-placeholder.js';
import { makeIonModel } from '../vehicles/models/titan-ion.js';
import { makeLegionModel } from '../vehicles/models/titan-legion.js';
import { makeNorthstarModel } from '../vehicles/models/titan-northstar.js';
import { makeRoninModel } from '../vehicles/models/titan-ronin.js';
import { makeScorchModel } from '../vehicles/models/titan-scorch.js';
import { forgetBlueprints } from '../vehicles/models/common.js';
import { clearVehicleGeometryCache } from '../vehicles/voxel-model/assemble.js';
import { setWalkerPresentation } from '../engine/vehicle-view.js';
import { setModeProjectileViews } from '../weapons/projectiles.js';
import { titanfallProjectileViews } from './projectile-views.js';
import { embarkPath, EMBARK_PATH } from './titan-embark-path.js';
import { shotFeel, applyShotFeel } from './titan-weapon-feel.js';
import { TITAN_SAMPLE_MANIFEST } from '../audio/titan-bank.js';
import { VEHICLE_WEAPONS } from '../../../shared/vehicle-defs.js';

const finite = value => (Number.isFinite(value) ? value : 0);

/**
 * Real titan models by type (WP5). Types still missing here render the WP0
 * placeholder biped; each model agent adds its factory to this map.
 */
export const TITAN_MODEL_FACTORIES = Object.freeze({
  titan_ion: makeIonModel,
  titan_legion: makeLegionModel,
  titan_northstar: makeNorthstarModel,
  titan_ronin: makeRoninModel,
  titan_scorch: makeScorchModel,
});

/** Presentation tuning (metres, seconds, shake trauma; no gameplay values). */
export const TITAN_PRESENTATION = Object.freeze({
  stepShakeSelf: 0.035, stepShakeNear: 0.11, stepRange: 30,     // footfalls
  landShakeSelf: 0.55, landShakeNear: 0.85, landRange: 48,       // titanfall landing
  ejectShake: 0.4, ejectRange: 30,
  hatchUp: 17, hatchForward: 7, hatchGravity: 22, hatchLife: 7,  // blown hatch
  ejectTrail: 1.2, ejectVy: 30,                                   // launch smoke trail (presentation estimate)
  batterySparkEvery: 0.38,
  wreckSmoke: 8,                                                  // s of smoke column over a fresh wreck
  dropSeconds: (TITAN_RULES.drop.markerMs + TITAN_RULES.drop.fallMs) / 1000,
});

// World hooks: the rig's ground probe, the FX sinks (particles, effects group,
// camera shake, vehicle audio) and match lookups. The match sets them in init();
// the capture page calls setTitanWorld directly.
const world = { getBlock: null, fx: null, shake: null, scene: null, audio: null, view: null, camera: null,
  selfId: () => null, teamOf: () => null };
let probe = null;

/**
 * { getBlock?, fx? (ParticleField), shake? (CameraShake), scene? (effects group),
 *   audio? (VehicleAudio), view? (VehicleView), camera?, selfId?(), teamOf?(playerId) }.
 */
export function setTitanWorld({ getBlock = null, fx = null, shake = null, scene = null, audio = null, view = null, camera = null,
  selfId = null, teamOf = null } = {}) {
  world.getBlock = typeof getBlock === 'function' ? getBlock : null;
  world.fx = fx || null;
  world.shake = shake || null;
  world.scene = scene || null;
  world.audio = audio || null;
  world.view = view || null;
  world.camera = camera || null;
  world.selfId = typeof selfId === 'function' ? selfId : () => null;
  world.teamOf = typeof teamOf === 'function' ? teamOf : () => null;
  probe = world.getBlock ? groundProbe(world.getBlock) : null;
  abilityFx.setSinks({ scene: world.scene, fx: world.fx, getBlock: world.getBlock, view: world.view });
  abilityEvents.setSinks({ scene: world.scene, fx: world.fx, getBlock: world.getBlock, view: world.view, shake: world.shake,
    camera: world.camera, selfId: world.selfId });
  dropFx.setSinks({ scene: world.scene, fx: world.fx, getBlock: world.getBlock, shake: world.shake, camera: world.camera, audio: world.audio,
    view: world.view, selfId: world.selfId });
  // A hidden titan cockpit overlay (canopy tint, MFD accent, frame) so the shader warm-up links
  // its programs before anyone first climbs into a titan.
  if (world.scene) world.scene.add(cockpitWarmup());
  else warmCockpit?.removeFromParent();
}

/** Programs warmed for titanfall: the ability FX and the titan cockpit overlay's own. */
export const TITAN_WARMUP_MATERIALS = Object.freeze([...abilityFx.TITAN_FX_WARMUP_MATERIALS, ...abilityEvents.TITAN_EVENT_FX_WARMUP_MATERIALS,
  ...dropFx.TITANFALL_DROP_WARMUP_MATERIALS, ...TITAN_COCKPIT_WARMUP_MATERIALS]);
let warmCockpit = null;
function cockpitWarmup() {
  if (warmCockpit) return warmCockpit;
  warmCockpit = new THREE.Group();
  warmCockpit.name = 'titan-cockpit-shader-warmup';
  warmCockpit.visible = false;
  const overlay = makeCockpitOverlay('titan_ion');
  if (overlay) warmCockpit.add(overlay.group);
  // The projectile views (titan rounds, ARCHER, THUNDERBOLT orb and arc) link before the first launch.
  warmCockpit.add(pilotProjectileWarmup(), titanProjectileWarmup());
  return warmCockpit;
}

/** Top of the ground column at (x, z) within ±2.5 m of `y`, or null. */
function groundProbe(getBlock) {
  return (x, z, y) => {
    const bx = Math.floor(x), bz = Math.floor(z), top = Math.floor(y + 1.5);
    for (let by = top; by >= Math.floor(y - 2.5); by--) if (isSolidBlock(getBlock(bx, by, bz))) return by + 1;
    return null;
  };
}

export function init(app, client) {
  setTitanWorld({ getBlock: app?.vehicleView?.getBlock ?? null, fx: app?.particleField ?? null, shake: app?.cameraShake ?? null,
    scene: app?.liveEffectsGroup ?? null, audio: app?.vehicleAudio ?? null, view: app?.vehicleView ?? null, camera: app?.camera ?? null,
    selfId: () => app?.myId ?? null,
    teamOf: id => (client?.snapshot?.()?.players || []).find(row => String(row?.id) === String(id))?.team ?? null });
  dropFx.setExplosions(app?.effects?.projectiles?.explosions ?? null);
  // The titan weapon sound bank decodes in the background; the synthesized voices stand in until then.
  void world.audio?.loadTitanBank?.(TITAN_SAMPLE_MANIFEST);
}
export function tick(snapshot, dt) {}

/** Per frame: the camera for shake/audio distances, blown hatches, launch trails, ability FX. */
export function frame(dt, ctx = {}) {
  const step = Math.max(0, Math.min(0.25, finite(dt)));
  if (ctx?.camera) world.camera = ctx.camera;
  stepFragments(step);
  stepTrails(step);
  for (const state of [...hulls]) if (!state.item.root?.parent) release(state);
  abilityFx.frame(step);
  abilityEvents.frame(step, world.camera);
  dropFx.frame(step, world.camera, ctx?.nowMs);
}

/** Authoritative gameplay events (main.js onGameplayEvent fan-out). */
export function onEvent(event) {
  if (!event || typeof event.kind !== 'string') return;
  switch (event.kind) {
    case 'titanfall_drop': {
      const seconds = Number.isFinite(event.landsAt) && Number.isFinite(event.at) ? (event.landsAt - event.at) / 1000 : TITAN_PRESENTATION.dropSeconds;
      const beam = abilityFx.dropBeam({ x: event.x, y: event.y, z: event.z, team: world.teamOf(event.owner) ?? 'neutral', seconds });
      // The fall, countdown ring and incoming roar (titanfall-drop-fx.js); the impact flashes the beam out.
      dropFx.onDrop(event, world.teamOf(event.owner) ?? 'neutral', {
        self: world.selfId() != null && String(event.owner) === String(world.selfId()),
        endBeam: beam ? () => { beam.life = Math.min(beam.life, beam.age - 1e3); } : null,
      });
      return;
    }
    case 'titan_eject': eject(event); return;
    case 'rodeo_rip': case 'rodeo_insert': batteryBurst(event); return;
    // Ability events (WP3 §3.8): deployables, ground lines, melee and execution, blinks.
    case 'titan_ability': abilityEvents.onAbility(event); return;
    case 'core_start': {
      const item = world.view?.item?.(event.vehicleId);
      if (item) world.audio?.titanCue?.('core', item.root.position.toArray(), { self: isSelf(item.row) });
      return;
    }
    case 'shoot': {
      // Ability rays from their anchor, the melee swing, vortex catches (every shoot: pilots' too).
      abilityEvents.onShoot(event);
      const meta = TITAN_WEAPON_META[event.vehicleWeapon];
      if (!meta || event.vehicleId == null) return;
      const item = world.view?.item?.(event.vehicleId);
      const pose = item ? world.view.mountWorldPose?.(event.vehicleId, event.mount) : null;
      // Hitscan abilities sound at their anchor (chest, shoulder, vortex), not at the gun.
      const origin = (event.ability && Array.isArray(event.o) ? event.o : null) ?? pose?.origin ?? (Array.isArray(event.o) ? event.o : null);
      if (!origin) return;
      const mount = item && Array.isArray(item.row?.mounts?.[0]) ? item.row.mounts[0] : null;
      // A shot snaps the weapon up from the low-ready carry (rig, presentation only).
      item?.model?.rig?.raise?.(true);
      const self = item ? isSelf(item.row) : false;
      // The railgun event carries the charge it left at; the row (already reset) is only the fallback.
      const charge = Number.isFinite(event.charge) ? event.charge : mount ? finite(mount[5]) / 100 : 0;
      const split = event.vehicleWeapon === 'splitter' && Array.isArray(event.paths) && event.paths.length > 1;
      world.audio?.titanShot?.(event.vehicleWeapon, origin, { self, charge, split, ability: !!event.ability, vehicleId: event.vehicleId });
      if (event.ability || meta.kind === 'melee') return;
      primaryFeel(event, item, self, origin, { charge, split });
      return;
    }
    case 'vehicle_hit': {
      // Own rounds landing on a hull while piloting a titan: the armour hit confirm.
      if (world.selfId() != null && String(event.attacker) === String(world.selfId()) && event.eff && ownTitan()) world.audio?.titanConfirm?.('hit');
      return;
    }
    case 'titan_doomed': {
      const me = world.selfId(), own = ownTitan();
      if (me == null || String(event.by) !== String(me) || !own || String(own.id) === String(event.vehicleId)) return;
      world.audio?.titanConfirm?.('doom');
      own.cockpit?.confirm?.();
      return;
    }
    case 'vehicle_destroyed': {
      const me = world.selfId(), own = ownTitan();
      if (!isTitanType(event.type) || me == null
        || String(event.attacker) !== String(me) || !own || String(own.id) === String(event.vehicleId)) return;
      world.audio?.titanConfirm?.('kill');
      own.cockpit?.confirm?.('TITAN DESTROYED');
      return;
    }
    default:
  }
}

export function dispose() {
  for (const state of [...hulls]) release(state);
  for (const fragment of [...fragments]) dropFragment(fragment);
  trails.length = 0;
  abilityFx.clear();
  abilityEvents.clear();
  dropFx.clear();
  world.audio?.unloadTitanBank?.();
  setTitanWorld({});
}

/** The own titan's VehicleView item (piloted, not a wreck), or null. */
function ownTitan() {
  for (const item of world.view?.items?.values?.() ?? []) if (item?.walker && !item.wreck && isSelf(item.row)) return item;
  return null;
}

/**
 * A primary shot's feel (titan-weapon-feel.js): the own titan shakes, punches the FOV and kicks the
 * cockpit (the chase view keeps the shake and part of the punch); heavy shots shake nearby viewers.
 * The hitscan rounds sound where they stopped short of their range (they met a voxel, hull or pilot).
 */
function primaryFeel(event, item, self, origin, { charge, split }) {
  const feel = shotFeel(event.vehicleWeapon, { split, charge });
  const cam = world.camera?.position;
  const cockpit = self && item?.cockpit?.group?.visible ? item.cockpit : null;
  applyShotFeel(feel, { self, shake: world.shake, camera: self ? world.camera : null, cockpit, chase: self && !cockpit,
    distance: cam ? Math.hypot(cam.x - origin[0], cam.y - origin[1], cam.z - origin[2]) : Infinity });
  if (TITAN_WEAPON_META[event.vehicleWeapon]?.kind !== 'hitscan') return;
  const range = VEHICLE_WEAPONS[event.vehicleWeapon]?.range ?? 300;
  for (const path of Array.isArray(event.paths) ? event.paths : []) {
    const segment = Array.isArray(path) ? path[0] : null, end = segment?.end;
    if (!Array.isArray(end) || end.length !== 3 || !end.every(Number.isFinite)) continue;
    const length = Math.hypot(end[0] - origin[0], end[1] - origin[1], end[2] - origin[2]);
    if (segment.hit || length < range - 0.5) world.audio?.titanImpact?.(event.vehicleWeapon, end);
  }
}

// ---- registration into the stock views (lazy titanfall client) ------------------------------
// vehicle-view.js and projectiles.js never import titanfall code: this module installs the walker
// presentation and the titanfall projectile views when it is evaluated (the titanfall client,
// capture pages and tests import it), titanfall-client.js create() installs them again and its
// dispose() removes them, so a later match in another mode runs the stock paths only.
const WALKER_PRESENTATION = Object.freeze({ createModel: (type, options) => createModel(type, options), update: (item, row, dt) => update(item, row, dt) });
export function install() {
  setWalkerPresentation(WALKER_PRESENTATION);
  setModeProjectileViews(titanfallProjectileViews);
}
export function uninstall() {
  const walker = setWalkerPresentation(null);
  if (walker && walker !== WALKER_PRESENTATION) setWalkerPresentation(walker);
  const views = setModeProjectileViews(null);
  if (views && views !== titanfallProjectileViews) setModeProjectileViews(views);
}
install();

const isTitanKind = type => typeof type === 'string' && type.startsWith('titan_');
/**
 * Leaving titanfall (titanfall-client.js dispose, after the match's titan hulls left VehicleView):
 * free the page-lifetime GPU copies — the hidden shader warm-up group (cockpit overlay, ability FX,
 * projectile views; the objects stay and are uploaded and linked again by the next titanfall
 * warm-up) — and drop the cached titan part geometries, palette resolvers and blueprints (rebuilt
 * on the next titan). Other vehicle types' caches are untouched. Returns what was released.
 */
export function releaseCaches() {
  dispose();
  const seen = new Set();
  const free = (resource) => { if (!resource || seen.has(resource)) return; seen.add(resource); resource.dispose?.(); };
  const freeMaterial = (material) => {
    if (!material || seen.has(material)) return;
    for (const value of Object.values(material)) if (value?.isTexture) free(value);
    for (const uniform of Object.values(material.uniforms || {})) if (uniform?.value?.isTexture) free(uniform.value);
    free(material);
  };
  dropFx.releasePools();
  const roots = [warmCockpit, abilityFx.warmupRoot(), abilityEvents.warmupRoot(), dropFx.warmupRoot()];
  for (const root of roots) {
    root?.removeFromParent();
    root?.traverse(node => {
      if (node.isInstancedMesh) node.dispose();
      free(node.geometry);
      for (const material of Array.isArray(node.material) ? node.material : [node.material]) freeMaterial(material);
    });
  }
  clearVehicleGeometryCache(isTitanKind);
  forgetBlueprints(isTitanKind);
  return { resources: seen.size };
}

/**
 * World pose of a titan's rodeo anchor (the rider's chest on the animated back)
 * and the hull yaw, for rider poses (WP1 avatars, the HUD); null without the hull.
 */
export function riderAnchor(vehicleId) {
  const item = world.view?.item?.(vehicleId);
  const anchor = item?.model?.anchors?.rodeo;
  if (!anchor || item.wreck) return null;
  anchor.getWorldPosition(_v);
  return { x: _v.x, y: _v.y, z: _v.z, yaw: item.root.rotation.y };
}

/** Model factory for one titan type (WP5 swaps the target here, not in vehicle-view.js). */
export function createModel(type, options = {}) {
  const factory = TITAN_MODEL_FACTORIES[type];
  return factory ? factory(options) : makeTitanPlaceholderModel(type, options);
}

// ---- per-hull state ------------------------------------------------------------------------

const hulls = new Set();        // per-item presentation state (emitters, embark proxy, phase edges)
const fragments = new Set();    // blown hatches in flight
const trails = [];              // ejected pilots' launch smoke
const _v = new THREE.Vector3(), _q = new THREE.Quaternion();
const clamp01 = k => Math.max(0, Math.min(1, k));

function stateFor(item) {
  let state = item.titanFx;
  if (!state) {
    state = item.titanFx = { item, phase: -1, fire: [], batteryAt: 0, dropAt: 0, pilot: null, pilotId: null, wasWreck: !!item.wreck };
    hulls.add(state);
  }
  return state;
}

function stopFire(state, smoke = true) {
  for (const handle of state.fire) world.fx?.removeEmitter?.(handle);
  state.fire.length = 0;
  if (smoke && state.smoke) { world.fx?.removeEmitter?.(state.smoke); state.smoke = null; }
}

function dropPilot(state) {
  if (!state.pilot) return;
  state.pilot.group.removeFromParent();
  try { disposeAvatar(state.pilot); } catch { /* sprites shared with the page */ }
  state.pilot = null; state.pilotId = null;
}

/** Forget a hull that left the view: its emitters and embark proxy go with it. */
function release(state) {
  stopFire(state);
  dropPilot(state);
  hulls.delete(state);
  if (state.item.titanFx === state) state.item.titanFx = null;
}

const occupant = row => vehicleOccupiedSeats(row).find(seat => seat.id === 'driver')?.occupantId ?? null;
function isSelf(row) {
  const self = world.selfId();
  return self != null && row != null && String(occupant(row)) === String(self);
}

/** Camera shake falling off with distance from `pos` (full at the own hull). */
function shake(pos, near, self, selfTrauma, range) {
  if (!world.shake?.add) return;
  if (self) { world.shake.add(selfTrauma); return; }
  const cam = world.camera?.position;
  if (!cam) return;
  const d = Math.hypot(cam.x - pos[0], cam.y - pos[1], cam.z - pos[2]);
  if (d < range) world.shake.add(near * (1 - d / range) ** 2);
}

/** World position of a model anchor (an Object3D) as an array. */
const worldOf = node => node.getWorldPosition(_v).toArray();

/**
 * How far above a flame point its own part's armour tops out (cached per node): the doom
 * points are skeleton-relative and could sit inside a tall pauldron, hiding the flames.
 */
const _ray = new THREE.Raycaster();
function surfaceLift(node) {
  if (Number.isFinite(node.userData.surfaceLift)) return node.userData.surfaceLift;
  let lift = 0;
  const meshes = (node.parent?.children || []).filter(child => child.isMesh && child.visible);
  if (meshes.length) {
    node.updateWorldMatrix(true, false);
    const from = node.getWorldPosition(new THREE.Vector3());
    const y0 = from.y;
    from.y += 2.5;
    _ray.set(from, new THREE.Vector3(0, -1, 0));
    _ray.far = 3;
    const hit = _ray.intersectObjects(meshes, false)[0];
    if (hit && hit.point.y > y0 - 0.05) lift = hit.point.y - y0 + 0.1;
  }
  node.userData.surfaceLift = lift;
  return lift;
}
/** Doom flame sprite scale: 0.7 m puffs (the fire preset is 0.9 m at scale 1). */
const P_DOOM_FLAME = 0.78;

// ---- rig events ----------------------------------------------------------------------------

/** Rig events -> dust, shake, audio: footfalls, landings, skids, dash bursts, doom sparks. */
function presentEvents(item, row, events, self) {
  const fx = world.fx, audio = world.audio, P = TITAN_PRESENTATION;
  for (const event of events) {
    if (event.type === 'footfall' || event.type === 'land' || event.type === 'skid') {
      const strength = finite(event.strength) || 1, at = [event.x, event.y, event.z];
      fx?.emit?.('dust', [event.x, event.y + 0.1, event.z], { count: Math.round(3 + strength * (event.type === 'land' ? 10 : 4)),
        dir: [0, 1, 0], speed: 0.8 + strength * 0.8, scale: 1.1 + strength * 0.5, ground: event.y });
      if (event.type === 'land') {
        shake(at, P.stepShakeNear * 3 * strength, self, P.stepShakeSelf * 4 * strength, P.stepRange);
        audio?.titanLanding?.(at, strength, { self });
      } else {
        shake(at, P.stepShakeNear * strength, self, P.stepShakeSelf * strength, P.stepRange);
        audio?.titanFootfall?.(at, strength, { self, chassis: item.model.chassis, skid: event.type === 'skid' });
      }
    } else if (event.type === 'dash') {
      // Thruster jets: short cyan-white cones (0.4 m wide, ~2.5 m long, 0.15 s) out of the back and
      // side vents against the dash, plus a low soft dust puff at the feet.
      const back = [-event.dir[0], 0, -event.dir[2]];
      for (const thruster of (item.model.emitters?.thrusters || []).slice(0, 4)) {
        const p = worldOf(thruster.node);
        const dir = [back[0] * 0.8 + (thruster.direction?.[0] ?? 0) * 0.2, -0.15, back[2] * 0.8 + (thruster.direction?.[2] ?? 0) * 0.2];
        fx?.emit?.('fire', p, { count: 6, dir, speed: 4.2, spread: 0.12, scale: 0.5, life: 0.3, alpha: 0.7,
          color0: [1.7, 2.3, 2.6], color1: [0.25, 0.75, 1.7] });
      }
      // Art review 2: two 1.8 m thruster streaks (and RONIN's afterimage) on top of the sparks.
      abilityFx.dashStreak(item, event.dir);
      const g = item.root.position;
      fx?.emit?.('dust', [g.x, g.y + 0.15, g.z], { count: 7, dir: [back[0], 0.15, back[2]], speed: 1.6, spread: 0.9, scale: 1.4,
        alpha: 0.35, ground: g.y });
      audio?.titanDash?.(item.root.position.toArray(), { self });
    } else if (event.type === 'sparks') {
      const list = item.model.emitters?.sparks || [];
      const anchor = list[event.index % Math.max(1, list.length)];
      if (anchor) fx?.emit?.('spark', worldOf(anchor), { count: event.burst ? 14 : 6, speed: event.burst ? 4.5 : 3 });
    }
  }
}

/** The titanfall slam: a 10-12 m dust ring, ground-coloured debris, a contact flash and a hard shake. */
function slam(item, self) {
  // The full titanfall impact (shock wave, chunks, shake by distance, boom) lives in titanfall-drop-fx.js.
  if (dropFx.impact(item, self)) return;
  const p = item.root.position, at = [p.x, p.y, p.z], fx = world.fx, P = TITAN_PRESENTATION;
  for (let i = 0; i < 28; i++) {
    const a = (i / 28) * Math.PI * 2;
    fx?.emit?.('dust', [p.x + Math.sin(a) * 3.2, p.y + 0.4, p.z + Math.cos(a) * 3.2],
      { count: 2, dir: [Math.sin(a), 0.12, Math.cos(a)], speed: 5.5, spread: 0.18, scale: 2.6, life: 1.5, alpha: 0.75, ground: p.y });
  }
  fx?.emit?.('dust', [p.x, p.y + 0.5, p.z], { count: 10, dir: [0, 1, 0], speed: 1.2, spread: 1.2, scale: 3, life: 1.2, alpha: 0.6, ground: p.y });
  fx?.emit?.('debris', [p.x, p.y + 0.4, p.z], { count: 22, dir: [0, 1, 0], speed: 1.1, spread: 1.0, scale: 2.8, ground: p.y,
    color0: [0.32, 0.28, 0.22], color1: [0.26, 0.22, 0.17] });
  fx?.emit?.('grit', [p.x, p.y + 0.2, p.z], { count: 18, dir: [0, 1, 0], speed: 5, spread: 1, ground: p.y });
  // A 0.1 s white-orange flash at the contact point.
  fx?.emit?.('fire', [p.x, p.y + 0.6, p.z], { count: 6, speed: 0.2, scale: 4.5, life: 0.25, alpha: 0.8,
    color0: [2.6, 2.1, 1.4], color1: [1.6, 0.7, 0.2] });
  shake(at, P.landShakeNear, self, P.landShakeSelf, P.landRange);
  world.audio?.titanLanding?.(at, 2.2, { self, titanfall: true });
}

/**
 * Doom: 0.7 m flames on the pauldron tops, the upper back and one hip in the TITAN_FLAME
 * gradient (core 0xffc060 → body 0xff6a1a low, body → tip 0x8a1a08 licks above; art review 2),
 * a black smoke column of 0.8-1.2 m puffs rising 6-10 m, until it blows or recovers.
 * A wreck keeps one smoke column for `wreckSmoke` seconds.
 */
function doomFire(state, item, doomed) {
  const fx = world.fx;
  if (!fx?.addEmitter) return;
  if (item.wreck) {
    if (state.fire.length) stopFire(state, false);
    if (!state.wreckSmoke) {
      state.wreckSmoke = true;
      const node = item.model.emitters?.smoke?.[0]?.node;
      if (node) {
        const handle = fx.addEmitter({ kind: 'smoke', pos: () => worldOf(node), rate: 9, until: TITAN_PRESENTATION.wreckSmoke,
          params: { scale: 0.5, speed: 1.3, life: 1.8, dir: [0, 1, 0.1], spread: 0.25, alpha: 0.4, color0: [0.07, 0.065, 0.06], color1: [0.03, 0.03, 0.03] } });
        // Kept apart from the doom fire: it expires on its own (`until`).
        if (handle) state.smoke = handle;
      }
    }
    return;
  }
  state.wreckSmoke = false;
  if (!doomed) { stopFire(state); return; }
  if (state.fire.length) return;
  const e = item.model.emitters || {};
  const points = e.doomFire?.length ? e.doomFire : [...(e.sparks || []).slice(0, 2), ...(e.cookoff || [])];
  for (const node of points) {
    // Low, licking flames that stay on the plates (a slow rise, short life): the additive fire
    // preset otherwise floats off as glare balls above the head. Born on the armour top.
    const lift = surfaceLift(node);
    const F = abilityFx.TITAN_FLAME, gain = c => c.map(v => v * F.gain);
    // (the core layer starts between core and body: stacked additive puffs otherwise burn white)
    const handle = fx.addEmitter({ kind: 'fire', pos: () => { const p = worldOf(node); p[1] += lift; return p; }, rate: 30,
      params: { scale: P_DOOM_FLAME, speed: 0.35, life: 0.9, dir: [0, 1, 0], spread: 0.5, alpha: 0.7, jitter: 0.25,
        color0: gain(F.core.map((c, i) => (c + F.body[i]) / 2)), color1: gain(F.body) } });
    if (handle) state.fire.push(handle);
    const tip = fx.addEmitter({ kind: 'fire', pos: () => { const p = worldOf(node); p[1] += lift + 0.35; return p; }, rate: 18,
      params: { scale: P_DOOM_FLAME * 0.7, speed: 0.5, life: 0.7, dir: [0, 1, 0], spread: 0.5, alpha: 0.7, jitter: 0.3,
        color0: gain(F.body), color1: gain(F.tip) } });
    if (tip) state.fire.push(tip);
  }
  for (const node of points.slice(0, 3)) {
    const lift = surfaceLift(node) + 0.9;
    const handle = fx.addEmitter({ kind: 'smoke', pos: () => { const p = worldOf(node); p[1] += lift; return p; }, rate: 7,
      params: { scale: 0.5, speed: 1.1, life: 1.6, dir: [0, 1, 0.1], spread: 0.25, alpha: 0.55,
        color0: [0.07, 0.065, 0.06], color1: [0.035, 0.035, 0.035] } });
    if (handle) state.fire.push(handle);
  }
}

// ---- embark actor --------------------------------------------------------------------------

/** The boarding pilot's avatar (the server already seats it; this is its walk-in). */
function embarkPilot(state, item, row, rig) {
  const id = occupant(row);
  const inside = world.view?.localView?.id === item.id;
  const scene = world.scene ?? item.root.parent;
  if (!id || !scene || inside || item.wreck) { dropPilot(state); return; }
  if (!state.pilot || state.pilotId !== id) {
    dropPilot(state);
    try {
      const avatar = makeAvatar(id, '', null);
      avatar.weaponModel?.dispose?.(); avatar.weaponModel = null;
      for (const sprite of [avatar.tag, avatar.hpSpr]) if (sprite) { sprite.visible = false; sprite.geometry.userData.pageOwned = true; }
      setAvatarTeam(avatar, world.teamOf(id) ?? row.team ?? null);
      avatar.group.name = 'titan-embark-pilot';
      scene.add(avatar.group);
      state.pilot = avatar; state.pilotId = id;
    } catch { return; }      // no DOM (bare tests)
  }
  const av = state.pilot, u = clamp01(rig.embark);
  const { pos, crouch, hop, face } = embarkPath(item, u);
  av.group.visible = u > 0.002 && u < EMBARK_PATH.hidden;
  av.group.position.set(pos[0], pos[1], pos[2]);
  av.group.rotation.set(0, face, 0);
  av.hips.position.y = 0.84 - crouch * 0.22;
  av.torso.position.y = 1.18 - crouch * 0.24;
  av.head.position.y = 1.66 - crouch * 0.26;
  av.torso.rotation.x = crouch * 0.35 + hop * 0.2;
  av.lLeg.rotation.x = -crouch * 0.6 - hop * 0.7;
  av.rLeg.rotation.x = -crouch * 0.45 + hop * 0.4;
  av.lArm.rotation.x = av.rArm.rotation.x = hop * -1.2 - crouch * 0.4;
}

// ---- eject: blown hatch and launch trail ---------------------------------------------------

function eject(event) {
  const item = world.view?.item?.(event.vehicleId);
  if (!item?.model?.titanRig) return;
  const model = item.model, rig = model.rig, P = TITAN_PRESENTATION;
  item.root.updateMatrixWorld(true);
  const self = String(event.id) === String(world.selfId());
  const yaw = item.root.rotation.y, fwd = [-Math.sin(yaw), 0, -Math.cos(yaw)];
  if (!rig.hatchBlown) {
    const sources = model.fragmentSources().filter(source => source.tag === 'hatch');
    const group = new THREE.Group();
    group.name = 'titan-blown-hatch';
    const pivotWorld = model.anchors.hatch.getWorldPosition(new THREE.Vector3());
    for (const source of sources) {
      const geometry = model.fragmentGeometry?.(source);
      if (!geometry?.opaque || !geometry.center) continue;
      const pivot = source.node.userData.pivot || [0, 0, 0];
      const mesh = new THREE.Mesh(geometry.opaque, fragmentMaterial());
      const m = new THREE.Matrix4().makeTranslation(geometry.center[0] - pivot[0], geometry.center[1] - pivot[1], geometry.center[2] - pivot[2]);
      m.premultiply(source.node.matrixWorld);
      m.decompose(mesh.position, mesh.quaternion, mesh.scale);
      mesh.position.sub(pivotWorld);
      mesh.castShadow = true;
      group.add(mesh);
    }
    rig.blowHatch(true);
    const scene = world.scene ?? item.root.parent;
    if (group.children.length && scene) {
      group.position.copy(pivotWorld);
      scene.add(group);
      fragments.add({ group, vx: fwd[0] * P.hatchForward, vy: P.hatchUp, vz: fwd[2] * P.hatchForward,
        spin: new THREE.Vector3(2.4 + Math.random(), 0.6, 0.9), age: 0, grounded: false });
    }
  }
  const mouth = worldOf(model.anchors.hatch), seat = worldOf(model.anchors.seat);
  world.fx?.emit?.('fire', mouth, { count: 8, speed: 1.2, scale: 2.2, life: 0.35, alpha: 0.7, color0: [2.2, 1.6, 0.9], color1: [1.4, 0.5, 0.1] });
  world.fx?.emit?.('spark', mouth, { count: 22, speed: 9, dir: [fwd[0], 0.8, fwd[2]], spread: 0.8 });
  world.fx?.emit?.('smoke', mouth, { count: 10, speed: 3, scale: 2, dir: [fwd[0], 1, fwd[2]] });
  trails.push({ x: seat[0], y: seat[1], z: seat[2], vy: P.ejectVy, age: 0, carry: 0 });
  shake(mouth, P.ejectShake, self, P.ejectShake, P.ejectRange);
  world.audio?.sfx?.ejectionSeat?.(seat, { self });
  world.audio?.titanCue?.('eject', mouth, { self });
}

function dropFragment(fragment) {
  fragment.group.removeFromParent();   // cached fragment geometry and the shared charred material stay alive
  fragments.delete(fragment);
}

function stepFragments(dt) {
  const P = TITAN_PRESENTATION;
  for (const f of [...fragments]) {
    f.age += dt;
    if (f.age > P.hatchLife) { dropFragment(f); continue; }
    if (f.grounded) continue;
    f.vy -= P.hatchGravity * dt;
    const g = f.group.position;
    const nx = g.x + f.vx * dt, ny = g.y + f.vy * dt, nz = g.z + f.vz * dt;
    const floor = world.getBlock && f.vy < 0 && isSolidBlock(world.getBlock(Math.floor(nx), Math.floor(ny - 0.3), Math.floor(nz)));
    if (floor) {
      g.set(nx, Math.floor(ny - 0.3) + 1.3, nz);
      world.fx?.emit?.('dust', g.toArray(), { count: 6, speed: 2, scale: 1.2 });
      f.grounded = true;
      continue;
    }
    g.set(nx, ny, nz);
    if (f.age > 3 && ny < -64) { dropFragment(f); continue; }
    f.group.rotation.x += f.spin.x * dt; f.group.rotation.y += f.spin.y * dt; f.group.rotation.z += f.spin.z * dt;
    if (f.age < 1.2) world.fx?.emit?.('smoke', g.toArray(), { count: 1, speed: 0.4, scale: 0.9 });
  }
}

function stepTrails(dt) {
  const P = TITAN_PRESENTATION;
  for (let i = trails.length - 1; i >= 0; i--) {
    const t = trails[i];
    t.age += dt;
    t.y += t.vy * dt; t.vy *= Math.exp(-dt * 1.4);
    t.carry += dt * 40;
    const n = Math.floor(t.carry); t.carry -= n;
    if (n > 0) world.fx?.emit?.('exhaust', [t.x, t.y, t.z], { count: n, dir: [0, -1, 0], speed: 2, scale: 1.1 });
    if (t.age > P.ejectTrail) trails.splice(i, 1);
  }
}

/** Rodeo battery rip / insert: a spark shower from the socket. */
function batteryBurst(event) {
  const item = world.view?.item?.(event.vehicleId);
  const anchor = item?.model?.anchors?.battery;
  if (!anchor) return;
  const p = worldOf(anchor);
  world.fx?.emit?.('spark', p, { count: event.kind === 'rodeo_rip' ? 26 : 12, speed: 6, spread: 0.9 });
  if (event.kind === 'rodeo_rip') world.fx?.emit?.('smoke', p, { count: 6, speed: 1.4, scale: 1.2 });
  world.audio?.titanCue?.(event.kind === 'rodeo_rip' ? 'rip' : 'insert', p, { self: String(event.id) === String(world.selfId()) });
}

// ---- walker update -------------------------------------------------------------------------

/**
 * Walker presentation for one VehicleView item. `item.root` is already at the
 * presented position and hull yaw; this poses the rig from the row and drives
 * the hull's own effects (dust, shake, audio, doom fire, embark actor, abilities).
 */
export function update(item, row, dt) {
  const root = item.root;
  // A dropping hull rides its visual fall path (vertical part before the rig, so it reads no ground speed);
  // from the visual touchdown on the rig already poses the landing (the landed row follows a tick or more later).
  const shownPhase = dropFx.place(item, row);
  // Presented ground speed from the root's own motion (rows only carry `speed` when non-zero).
  const last = item.walkerLast;
  let speed = Math.abs(finite(row.speed));
  if (last && dt > 0) speed = Math.max(speed, Math.hypot(root.position.x - last.x, root.position.z - last.z) / dt);
  item.walkerLast = { x: root.position.x, z: root.position.z };
  const titan = decodeTitanRow(row);
  const events = [];
  item.model.animate(dt, {
    speed, visualSteer: 0, grounded: row.grounded ?? true, wreck: item.wreck,
    tw: Array.isArray(row.tw) ? row.tw : null, titan, mounts: Array.isArray(row.mounts) ? row.mounts : null,
    phase: shownPhase ?? titan?.phase ?? 0, legYaw: Number.isFinite(row.legYaw) ? row.legYaw : root.rotation.y, yaw: root.rotation.y,
    events, x: root.position.x, y: root.position.y, z: root.position.z, probe,
  });
  dropFx.afterPose(item);
  const rig = item.model.rig;
  if (!rig) { if (events.length) presentEvents(item, row, events, false); return; }
  // The melee punch and execution over the rig's pose (presentation only, from the events).
  abilityEvents.updateTitan(item, row, dt);
  root.updateMatrixWorld(true);
  const state = stateFor(item), self = isSelf(row), phase = titan?.phase ?? 0, P = TITAN_PRESENTATION;
  if (events.length) presentEvents(item, row, events, self);
  // Phase edges: the titanfall slam, the disembark vent.
  if (state.phase === TITAN_PHASE.dropping && phase !== TITAN_PHASE.dropping && !item.wreck) slam(item, self);
  if (phase === TITAN_PHASE.disembark && state.phase !== TITAN_PHASE.disembark && state.phase !== -1) {
    const mouth = worldOf(item.model.anchors.hatch);
    world.fx?.emit?.('smoke', mouth, { count: 8, speed: 1.6, scale: 1.1, color0: [0.85, 0.87, 0.9], color1: [0.6, 0.62, 0.66] });
    world.audio?.sfx?.vehicleHatch?.(mouth, { self });
  }
  if (phase === TITAN_PHASE.embark && state.phase !== TITAN_PHASE.embark) world.audio?.titanCue?.('embark', worldOf(item.model.anchors.hatch), { self });
  // Rising out of the hero landing: the servos vent once more.
  if (state.phase === TITAN_PHASE.landed && phase !== TITAN_PHASE.landed && !item.wreck) dropFx.rise(item);
  state.phase = item.wreck ? -1 : phase;
  // The re-entry streak, contrail and braking jets of a falling hull: titanfall-drop-fx.js (frame).
  doomFire(state, item, !!titan?.doomed && !item.wreck);
  // An empty battery socket spits sparks.
  if (titan?.batteryOut && !item.wreck) {
    state.batteryAt += dt;
    if (state.batteryAt >= P.batterySparkEvery) {
      state.batteryAt = 0;
      world.fx?.emit?.('spark', worldOf(item.model.anchors.battery), { count: 5, speed: 2.5 });
    }
  } else state.batteryAt = 0;
  if (phase === TITAN_PHASE.embark && rig.embark > 0) embarkPilot(state, item, row, rig);
  else dropPilot(state);
  abilityFx.updateTitan(item, row, dt);
}
