// Pilot presentation (docs/titanfall.md §4.2, owned by WP1): wires the local
// player's titanfall hooks for the match and poses remote pilots.
//
//   client-module contract  init?(app, client), tick(snapshot, dt), frame(dt, ctx), onEvent(event), dispose()
//   avatarState(row, avatar, dt)  AvatarRoster hook for one live remote pilot row: poses and
//                                 shades `avatar` from tf[0]/tf[3]; returns the applied state or null.
//
// init installs on app.player (LocalPlayer):
//   pilotCamera        pilot-camera.js PilotCamera (wallrun roll, FOV kicks)
//   pilotAnim          pilot-anim.js PilotAnim (first-person wallrun/slide legs)
//   pilotSelfFrameFor  serverNow -> the `tfs` frame of that tick (NetClient.titanfallSelfFor)
// tick sets player.pilotSnapNow to the snapshot's serverNow before main.js
// reconciles it, and every arriving `tfs` frame is offered to
// player.adoptPilotFrame (the frame trails its tick on the socket).
// frame plays the local wallrun footsteps (main.js steps only on the ground).
import { decodeTitanfallPlayer, TITAN_PILOT_PRIMARIES, TITAN_PILOT_AT, TITAN_PILOT_SIDEARM, TITAN_PILOT_MELEE } from '../../../shared/titan-contract.js';
import { getBlock, isSolidBlock } from '../../../shared/worlddata.js';
import { FootstepCadence, footstepSurfaceAt } from '../audio/footsteps.js';
import { PilotCamera } from './pilot-camera.js';
import { PilotAnim, poseRemotePilot, wallSideAt } from './pilot-anim.js';
import { GrappleRopes } from './grapple-ropes.js';

/** Own footfalls on a wall: a quick cadence, as loud as the ground ones (main.js ×0.3). */
export const PILOT_WALL_STEPS = Object.freeze({ cadence: 1.15, volume: 0.3 });

let app = null;
let client = null;
let camera = null;
let anim = null;
let cadence = null;
let sfx = null;
let unsubscribe = null;
let ropes = null;   // GrappleRopes (browser only, built in prepare)
let clockMs = 0;
const tfById = new Map();
const solidAt = (x, y, z) => isSolidBlock(getBlock(x, y, z));

export function init(appRef, clientRef) {
  app = appRef ?? null;
  client = clientRef ?? null;
  camera = new PilotCamera();
  anim = new PilotAnim();
  cadence = new FootstepCadence();
  const player = app?.player;
  if (player) {
    player.pilotCamera = camera;
    player.pilotAnim = anim;
    player.pilotSelfFrameFor = serverNow => app?.net?.titanfallSelfFor?.(serverNow) ?? null;
    player.physics?.resetPilot?.();
  }
  unsubscribe = typeof app?.net?.on === 'function' ? app.net.on('tfs', frame => app?.player?.adoptPilotFrame?.(frame)) : null;
  // Audio only in a browser; the node contract tests import this module.
  if (typeof window !== 'undefined') {
    import('../audio/sfx.js').then(module => { if (app) sfx = module.sfx ?? null; }).catch(() => {});
  }
}

export function tick(snapshot, dt) {
  if (!snapshot) return;
  tfById.clear();
  if (Array.isArray(snapshot.players)) {
    for (const row of snapshot.players) if (row && Array.isArray(row.tf)) tfById.set(row.id, row.tf);
  }
  if (Number.isFinite(snapshot.serverNow)) clockMs = snapshot.serverNow;
  if (app?.player) app.player.pilotSnapNow = Number.isFinite(snapshot.serverNow) ? snapshot.serverNow : null;
}

export function frame(dt, ctx) {
  if (Number.isFinite(ctx?.nowMs)) clockMs = ctx.nowMs;
  const player = app?.player, physics = player?.physics;
  if (ropes) {
    const anchor = physics?.pilotRules && player.alive !== false ? physics.pilot?.grapple?.anchor : null;
    ropes.update(anchor && app?.camera ? { anchor, camera: app.camera.position, yaw: player.view?.yaw } : null);
  }
  if (!physics?.pilotRules || player.alive === false || !physics.pilot?.wall) return;
  const speed = Math.hypot(physics.vel.x, physics.vel.z) * PILOT_WALL_STEPS.cadence;
  const volume = cadence?.update(dt, { speed, grounded: true }) ?? 0;
  if (volume > 0 && sfx?.footstep) {
    const n = physics.pilot.wall > 0 ? 1 : -1, xAxis = Math.abs(physics.pilot.wall) === 1;
    // The struck wall voxel, presented as the "ground" the surface lookup reads.
    const at = { x: physics.pos.x - (xAxis ? n * 0.5 : 0), y: physics.pos.y + 1.06, z: physics.pos.z - (xAxis ? 0 : n * 0.5) };
    try { sfx.footstep(volume * PILOT_WALL_STEPS.volume, { body: physics, surface: footstepSurfaceAt(getBlock, at) }); } catch {}
  }
}

export function onEvent(event) {}

/** Every weapon a titanfall pilot can carry (the third-person models the warm-up links). */
export const PILOT_WARMUP_WEAPONS = Object.freeze([...TITAN_PILOT_PRIMARIES, TITAN_PILOT_SIDEARM, ...TITAN_PILOT_AT, TITAN_PILOT_MELEE]);
let weaponWarmup = null;

/**
 * Load time (titanfall-client prepare, before warmShaders): one hidden third-person model of every
 * pilot weapon under the avatar character root, so the warm-up links their programs with the
 * character-light key and keeps them referenced for the match. Without it the first remote AT
 * weapon (and every one after the last carrier swapped away) linked its programs mid-match.
 */
export async function prepare(appRef) {
  releaseWeaponWarmup();
  const parent = appRef?.liveAvatarsGroup;
  if (!parent || typeof window === 'undefined') return;
  const [{ AvatarWeaponModel }, THREE, avatars, npcView] = await Promise.all([import('../avatar/avatar-weapon.js'),
    import('../vendor/three.module.js'), import('../avatar/avatar.js'), import('./npc-view.js')]);
  if (app !== appRef) return;
  const group = new THREE.Group();
  group.name = 'titanfall-pilot-weapon-warmup';
  group.visible = false;
  const models = [], npcs = [];
  for (const id of PILOT_WARMUP_WEAPONS) {
    const model = new AvatarWeaponModel();
    model.setWeapon(id);
    model.root.traverse(node => { node.frustumCulled = false; });
    group.add(model.root);
    models.push(model);
  }
  // The attrition minions' role layers (transparent kit materials, the spectre eye): one dressed
  // stock avatar per kind, so the first squad (and each one after the last minion died) links nothing.
  for (const kind of npcView.NPC_KINDS ?? []) {
    try {
      const avatar = avatars.makeAvatar(`warmup-${kind}`, '', 'alpha');
      npcView.applyNpcLook(avatar, kind, 'alpha');
      avatar.group.traverse(node => { node.frustumCulled = false; });
      group.add(avatar.group);
      npcs.push(avatar);
    } catch (error) { if (typeof console !== 'undefined') console.warn(`titanfall: ${kind} warm-up failed`, error); }
  }
  parent.add(group);
  // The SKIPJACK (mgl) round and its wake are stock ProjectileFX visuals with their own materials;
  // titanfall hands the launcher out as an anti-titan pick, so its programs are warmed with the
  // match. Hung in the effects group (not a character root: the shared materials keep their key).
  let rounds = null, trailGeometry = null;
  const projectileFx = appRef.effects?.projectiles;
  if (appRef.liveEffectsGroup && typeof projectileFx?._buildVisual === 'function' && projectileFx.mglTrailMaterial) {
    try {
      rounds = new THREE.Group();
      rounds.name = 'titanfall-mgl-round-warmup';
      rounds.visible = false;
      rounds.add(projectileFx._buildVisual('mgl').group);
      trailGeometry = new THREE.BufferGeometry();
      trailGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
      trailGeometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(6), 3));
      rounds.add(new THREE.Mesh(trailGeometry, projectileFx.mglTrailMaterial));
      rounds.traverse(node => { node.frustumCulled = false; });
      appRef.liveEffectsGroup.add(rounds);
    } catch (error) { rounds = null; if (typeof console !== 'undefined') console.warn('titanfall: mgl warm-up failed', error); }
  }
  weaponWarmup = { group, models, npcs, disposeAvatar: avatars.disposeAvatar, rounds, trailGeometry };
  // Grapple ropes: built with the match (visible, empty) so the warm-up links the line program.
  ropes?.dispose();
  ropes = appRef.liveEffectsGroup ? new GrappleRopes(THREE, appRef.liveEffectsGroup) : null;
}

function releaseWeaponWarmup() {
  if (!weaponWarmup) return;
  weaponWarmup.group.removeFromParent();
  for (const model of weaponWarmup.models) { try { model.dispose(); } catch { /* already gone */ } }
  for (const avatar of weaponWarmup.npcs) { try { weaponWarmup.disposeAvatar(avatar); } catch { /* already gone */ } }
  // The round's geometry and materials belong to ProjectileFX: only the hidden group and our trail buffer go.
  weaponWarmup.rounds?.removeFromParent();
  weaponWarmup.trailGeometry?.dispose();
  weaponWarmup = null;
}

export function dispose() {
  releaseWeaponWarmup();
  ropes?.dispose();
  ropes = null;
  const player = app?.player;
  if (player) {
    if (player.pilotCamera === camera) player.pilotCamera = null;
    if (player.pilotAnim === anim) player.pilotAnim = null;
    player.pilotSelfFrameFor = null;
    player.pilotSnapNow = null;
    player.physics?.resetPilot?.();
  }
  unsubscribe?.();
  unsubscribe = null;
  tfById.clear();
  app = client = camera = anim = cadence = sfx = null;
  clockMs = 0;
}

/** AvatarRoster hook: pose and shade one live remote pilot from its row's `tf`. */
export function avatarState(row, avatar, dt) {
  if (!row || !avatar) return null;
  const tf = Array.isArray(row.tf) ? row.tf : tfById.get(row.id);
  if (!tf) return null;
  const decoded = decodeTitanfallPlayer({ tf });
  const self = client?.selfRow?.() ?? null;
  const ally = !!self?.team && row.team === self.team;
  // WP6 request: a cloaked enemy pilot shows no nameplate (AvatarRoster.updateLabels skips disguised avatars;
  // sync resets `disguised` from the row every frame, so it returns when the cloak ends).
  if (decoded.cloaked && !ally) avatar.disguised = true;
  const wallrun = decoded.mv === 3;
  const side = wallrun ? wallSideAt(solidAt, row.x, row.y, row.z, row.yaw) : 0;
  ropes?.setRemote(row.id, avatar.group?.position ?? row, decoded.grapple);
  const state = poseRemotePilot(avatar, { mv: decoded.mv, flags: decoded.flags, side, ally,
    speed: Number.isFinite(avatar.speedEst) ? avatar.speedEst : 0, now: clockMs }, dt);
  if (state?.step > 0 && sfx?.footstep && !state.cloaked) {
    try {
      sfx.footstep(state.step, { pos: [row.x, row.y, row.z], body: avatar,
        surface: footstepSurfaceAt(getBlock, { x: row.x, y: row.y + 1.06, z: row.z }) });
    } catch {}
  }
  return state;
}
