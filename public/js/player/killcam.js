import { createSniperScope, updateScopeOptics, scopeReticleKind } from '../ui/sniper-scope.js';
import { ballisticProfile } from '../../../shared/bullet-ballistics.js';
import { isScopeActive } from '../guns/scope-state.js';
import { configuredWeapon } from '../../../shared/weapon-attachments.js';
import { fovForZoom } from './local-player.js';
import { bindingLabel, matchesBinding, isTypingTarget } from '../keybindings.js';
import * as THREE from '../vendor/three.module.js';
import { KillcamHistory, sampleKillcam } from './killcam-history.js';
import { KILLCAM } from '../../../shared/killcam-rules.js';
import { KillcamTerrain } from './killcam-terrain.js';
import { AvatarRoster } from '../avatar/avatar-roster.js';
import { TracerFX } from '../weapons/ballistics.js';
import { ProjectileFX } from '../weapons/projectiles.js';
import { ImpactFX, blockSoundFor } from '../weapons/impacts.js';
import { ViewmodelRig } from '../guns/viewmodel.js';
import { EYE_HEIGHT, WEAPON_IDS, isScopedWeapon } from '../../../shared/combatmath.js';
import { stanceEye } from '../../../shared/player-stance.js';
import { LEAN, leanEyeOffset, leanPose } from '../../../shared/player-lean.js';
import { WEAPON_NAMES, THROWABLE_NAMES } from '../ui/hud-support.js';
import { StructureFx } from '../fx/structure-fx.js';
import { ParticleField } from '../fx/particle-field.js';
import { VehicleCamera, seatViews } from '../session/vehicle-camera.js';
import { vehicleDef, mountAim } from '../../../shared/vehicle-defs.js';
import { raycastVoxels } from '../../../shared/raycast.js';

/** Replay dust slots: one small particle field while a replay runs. */
const REPLAY_PARTICLES = 1024;

// Replay tail after the clip end, plus slack for the respawn snapshot's latency.
const TAIL_MS = 300;
const RESPAWN_SLACK_MS = 200;
/** Replay view of a seat, best first: the hull stays in the picture (chase), else over the gun, else the seat's own. */
const REPLAY_SEAT_VIEWS = Object.freeze(['chase', 'mount', 'passenger', 'gimbal', 'cockpit']);

/** The seat view a replay uses for (type, seat): see REPLAY_SEAT_VIEWS. */
export function replaySeatView(type, seatId) {
  const views = seatViews(type, seatId);
  return REPLAY_SEAT_VIEWS.find(view => views.includes(view)) ?? views[0] ?? 'chase';
}

/**
 * Where the replay camera rides at one sample: `{ kind: 'seat', row, seatId, aimYaw, aimPitch }`
 * for a seated killer or a followed hull (clip.follow 'vehicle': an auto-titan, an empty
 * titan's crush), `{ kind: 'eye', target }` for a killer on foot, or null (the subject is gone).
 */
export function replaySubject(clip, sample) {
  const target = sample.players.get(clip.killer) || null;
  if (clip.follow === 'vehicle') {
    const row = sample.vehicles?.get(clip.focus.vehicleId);
    if (!row) return null;
    const def = vehicleDef(row.type ?? row.kind);
    const seat = def?.seats.find(entry => entry.drives) ?? def?.seats[0] ?? null;
    const aim = seat?.mounts?.length ? mountAim(row, seat.mounts[0]) : null;
    return { kind: 'seat', row, seatId: seat?.id ?? 'driver', aimYaw: aim?.yaw ?? row.yaw ?? 0, aimPitch: aim?.pitch ?? 0, target };
  }
  if (!target) return null;
  const vehicleId = target.vehicleId != null && target.state === 'alive' ? String(target.vehicleId) : null;
  const row = vehicleId ? sample.vehicles?.get(vehicleId) : null;
  if (row) {
    return { kind: 'seat', row, seatId: target.vehicleSeatId != null ? String(target.vehicleSeatId) : 'driver',
      aimYaw: Number.isFinite(target.yaw) ? target.yaw : row.yaw ?? 0, aimPitch: Number.isFinite(target.pitch) ? target.pitch : 0, target };
  }
  return { kind: 'eye', target };
}

/** Recorded attacker view. Live simulation keeps running and owns respawn. */
/**
 * One replayed `shoot` event. A tank main gun shot (w 'shell') is the cannon
 * report only (the shell itself arrives as a projectileLaunch); anything else
 * draws its tracer, kicks the killer's viewmodel and plays the weapon's fire.
 */
export function playKillcamShot(event, { audio = null, tracers = null, rig = null, killer = null } = {}) {
  if (event.w === 'shell') {
    audio?.vehicleCannon?.(event.o, { weapon: event.vehicleWeapon });
    return 'cannon';
  }
  tracers?.shoot(event);
  if (event.id === killer) rig?.fire();
  audio?.fire(event.w, { pos: event.o });
  return 'fire';
}

export class Killcam {
  /**
   * `createVehicleView({ getBlock })` builds the replay's own hull view (a VehicleView; Conquest hulls and
   * Titanfall titans), `presentation({ parent, getBlock, viewerTeam })` the mode's replay presentation for bodies
   * (Titanfall pilots: `{ avatarState(row, avatar, dt), viewRoll(row, dt), frame(row, camera), dispose() }`).
   */
  constructor({ scene, getBlock, worldview = null, mapBytes = null, blockDamage = [],
    terrainTime = -Infinity, audio = null, now = () => performance.now(), onActivate = null, structureTier = 'medium',
    createVehicleView = null, presentation = null }) {
    this.scene = scene;
    this.getBlock = (x, y, z) => this.clip?.terrain
      ? this.clip.terrain.getBlock(x, y, z) : getBlock(x, y, z);
    this.worldview = worldview;
    this.audio = audio;
    this.now = now;
    this.onActivate = onActivate;
    this.structureTier = structureTier;
    this.createVehicleView = typeof createVehicleView === 'function' ? createVehicleView : null;
    this.presentationFactory = typeof presentation === 'function' ? presentation : null;
    /** The replay's hull view, built on the first replay with a hull and kept for the match. */
    this.vehicles = null;
    this.presentation = null;
    this._baseFov = 80;
    this.history = new KillcamHistory(mapBytes ? new KillcamTerrain(mapBytes, blockDamage, terrainTime) : null);
    this.active = false;
    this.group = new THREE.Group();
    this.group.name = 'killcam-replay';
    this.group.visible = false;
    scene.add(this.group);
    this.camera = new THREE.PerspectiveCamera(80, 1, 0.04, 1500);
    this.camera.rotation.order = 'YXZ';
    this.group.add(this.camera);
    // Seated killers and followed hulls: the stock seat cameras, wall-safe against the replay terrain.
    this.seatCamera = new VehicleCamera({ camera: this.camera, storage: null, getBaseFov: () => this._baseFov,
      raycast: (origin, direction, distance) => raycastVoxels(this.getBlock,
        origin.x, origin.y, origin.z, direction.x, direction.y, direction.z, distance) });
    this._seatKey = null;
    this.root = document.createElement('section');
    this.root.className = 'vb-killcam hidden';
    this.root.id = 'killcam-replay';
    this.root.setAttribute('aria-label', 'Killcam replay');
    this.root.innerHTML = `<div class="vb-killcam-hitmarker" aria-hidden="true"></div>
      <div class="vb-killcam-top"><span>REPLAY</span><b>KILLCAM</b><span class="vb-killcam-time"></span></div>
      <div class="vb-killcam-bottom"><span class="vb-killcam-name"></span><span class="vb-killcam-weapon"></span>
      <button type="button" id="killcam-skip">SKIP REPLAY <small>SPACE / A</small></button>
      <div class="vb-killcam-progress"><i></i></div></div>`;
    this.scope = createSniperScope(this.root, 'killcam-');
    this.scopeActive = false;
    document.body.append(this.root);
    this.timeLabel = this.root.querySelector('.vb-killcam-time');
    this.hitmarker = this.root.querySelector('.vb-killcam-hitmarker');
    this.progress = this.root.querySelector('.vb-killcam-progress i');
    this.root.querySelector('button').addEventListener('click', () => this.stop());
    this._onKey = event => {
      if (this.active && !event.defaultPrevented && !isTypingTarget(event.target) && matchesBinding(event, 'skipReplay')) { event.preventDefault(); this.stop(); }
    };
    document.addEventListener('keydown', this._onKey);
  }

  /**
   * Cut the clip at the kill; with `delayMs` the replay waits (the local death
   * sequence owns the screen meanwhile) and drops just enough lead-in to finish
   * before the server respawn.
   */
  start(deathEvent, mode, { delayMs = 0 } = {}) {
    const clip = this.history.clip(deathEvent, mode);
    if (!clip) return false;
    this.stop();
    this.clip = clip;
    this.history.activeClip = clip;
    const delay = Math.max(0, Number(delayMs) || 0);
    const budget = KILLCAM.respawnMs - delay - TAIL_MS - RESPAWN_SLACK_MS;
    this.replayStart = Math.max(clip.start, Math.min(clip.killTime, clip.end - budget));
    if (delay > 0) {
      this.pendingAt = this.now() + delay;
      return true;
    }
    this._activate();
    return true;
  }

  get pending() { return this.pendingAt != null; }

  _activate() {
    const clip = this.clip;
    this.pendingAt = null;
    this.onActivate?.();
    this.worldview?.setReplayTerrain(clip.terrain);
    this.previousTime = clip.start - 1;
    if (this.replayStart > clip.start) {
      // Skipped lead-in: its block edits still happened, its shots stay silent.
      const skipped = sampleKillcam(clip, this.replayStart, this.previousTime);
      clip.terrain?.apply(skipped.terrain);
      this.worldview?.updateReplayTerrain(skipped.terrain);
      this.previousTime = skipped.time;
    }
    this.sample = null;
    this.active = true;
    this.group.visible = true;
    this.root.classList.remove('hidden');
    this.root.querySelector('#killcam-skip small').textContent = `${bindingLabel('skipReplay')} / A`;
    document.body.classList.add('is-replaying');
    this.root.querySelector('.vb-killcam-name').textContent = clip.name;
    this.root.querySelector('.vb-killcam-weapon').textContent =
      WEAPON_NAMES[clip.weapon] || THROWABLE_NAMES[clip.weapon] || 'ELIMINATED';
    // A followed hull is not the killer's eye: the killer's own body (if anywhere) stays visible.
    const ownId = clip.follow === 'vehicle' ? null : clip.killer;
    try {
      this.presentation = this.presentationFactory?.({ parent: this.group, getBlock: this.getBlock,
        viewerTeam: () => this.sample?.players?.get(clip.killer)?.team ?? null }) ?? null;
    } catch (error) { this.presentation = null; console.warn('[vb] killcam presentation', error); }
    this.roster = new AvatarRoster({ scene: this.group, getBlock: this.getBlock, getMyId: () => ownId, presentation: this.presentation });
    if (!this.vehicles && this.createVehicleView && clip.frames.some(frame => frame.vehicles?.length)) {
      try {
        this.vehicles = this.createVehicleView({ getBlock: this.getBlock });
        this.group.add(this.vehicles.group);
      } catch (error) { this.vehicles = null; console.warn('[vb] killcam vehicles', error); }
    }
    // Large maps stream chunks around the view: load the replay's ground before its first frame.
    const first = replaySubject(clip, sampleKillcam(clip, this.replayStart, this.replayStart));
    const at = first?.kind === 'seat' ? first.row : first?.target;
    if (at && [at.x, at.z].every(Number.isFinite)) this.worldview?.setViewPosition?.({ x: at.x, y: at.y, z: at.z });
    this.tracers = new TracerFX(this.group, this.getBlock, () => {});
    // Replayed discs steer home toward their owner's sampled position (the killer's too).
    this.projectiles = new ProjectileFX(this.group, this.getBlock, { camera: this.camera,
      getEntityPosition: (id) => {
        const player = this.sample?.players?.get(String(id));
        return player ? { x: player.x, y: player.y, z: player.z } : this.roster?.positionOf(id) || null;
      } });
    this.impacts = new ImpactFX(this.group, this.camera, this.getBlock);
    // Recorded collapses: the replay terrain and the events advance together, so no proxies.
    const chunkStore = this.worldview?.chunkStore;
    if (chunkStore && this.worldview.dimensions) {
      this.particles = new ParticleField({ scene: this.group, capacity: REPLAY_PARTICLES });
      this.structure = new StructureFx({ parent: this.group, mesher: chunkStore, getBlock: this.getBlock,
        dimensions: this.worldview.dimensions, fx: this.particles, chips: this.impacts, audio: this.audio,
        tier: this.structureTier, masking: false });
    }
    this.rig = new ViewmodelRig(this.camera);
    this.weapon = null;
    this.padHeld = true;
    this.started = this.now();
  }

  update(dt, aspect, fov) {
    if (this.pendingAt != null) {
      if (this.now() < this.pendingAt) return false;
      this._activate();
    }
    if (!this.active) return false;
    const elapsed = this.now() - this.started;
    const duration = this.clip.end - this.replayStart;
    if (elapsed >= duration + TAIL_MS) { this.stop(); return false; }
    const pads = typeof navigator !== 'undefined' ? navigator.getGamepads?.() || [] : [];
    const pressed = Array.from(pads).some(pad => pad?.buttons?.[0]?.pressed);
    if (pressed && !this.padHeld) { this.stop(); return false; }
    this.padHeld = pressed;
    const sample = sampleKillcam(this.clip, this.replayStart + elapsed, this.previousTime);
    this.previousTime = sample.time;
    this.sample = sample;
    this.clip.terrain?.apply(sample.terrain);
    this.worldview?.updateReplayTerrain(sample.terrain);
    const subject = replaySubject(this.clip, sample);
    if (!subject) { this.stop(); return false; }
    this._baseFov = fov;
    // Hulls first: a seat camera rides this frame's presented pose.
    if (this.vehicles) {
      this.vehicles.sync([...sample.vehicles.values()], [...sample.players.values()], subject.target, {});
      this.vehicles.update(dt, this.camera);
    }
    if (subject.kind === 'seat') return this._updateSeat(dt, aspect, subject, sample, elapsed);
    this._leaveSeat();
    const target = subject.target;
    const lean = leanEyeOffset(target.leanT || 0, target.yaw, target.crouch ? 1 : 0);
    this.camera.position.set(target.x + lean.x, target.y + stanceEye(EYE_HEIGHT, target.crouch, target.proneT) + lean.y,
      target.z + lean.z);
    // A Titanfall pilot's wallrun rolls the view as it did for the killer.
    const pilotRoll = this.presentation?.viewRoll?.(target, dt) ?? 0;
    this.camera.rotation.set(target.pitch, target.yaw, -leanPose(target.leanT || 0) * LEAN.viewRoll + pilotRoll, 'YXZ');
    const weaponId = WEAPON_IDS[target.weapon] || 'rifle';
    const def = configuredWeapon(weaponId, {[weaponId]:target.attachments});
    const ads = target.adsT ?? (target.ads ? 1 : 0);
    this.scopeActive = isScopeActive({weapon:weaponId, scoped:def.scoped, ads,
      alive:target.state === 'alive', vaulting:target.vaulting,
      reloading:target.reloading, deploying:target.deploying, grenadeHandling:target.grenadeHandling});
    const zoom = Math.abs(target.scopeZoom - Math.max(1.5, def.zoom / 2)) < 1e-6
      ? Math.max(1.5, def.zoom / 2) : def.zoom;
    const adsFov = isScopedWeapon(def) || weaponId === 'minigun' ? fovForZoom(zoom, fov) : def.adsFov;
    const replayFov = fov + (adsFov - fov) * (1 - (1 - ads) ** 3);
    if (this.camera.aspect !== aspect || this.camera.fov !== replayFov) {
      this.camera.aspect = aspect; this.camera.fov = replayFov; this.camera.updateProjectionMatrix();
    }
    this.scope.classList.toggle('active', this.scopeActive);
    // The killer's launcher sight replays without a rangefinder return (readout "---").
    updateScopeOptics(this.scope, replayFov, ballisticProfile(def), globalThis.innerHeight, scopeReticleKind(def));
    this.scope.querySelector('.scope-zoom-label').textContent = `${zoom.toFixed(1)}×`;
    this.rig.setCosmetics(target.cosmetics);
    const weapon = WEAPON_IDS[target.weapon] || 'rifle';
    if (weapon !== this.weapon) { this.rig.setWeapon(weapon); this.weapon = weapon; }
    this.rig.ads(ads);
    this.rig.update(dt, { speed: target.moveSpeed, crouch: target.crouch, proneT: target.proneT,
      grounded: target.grounded, shotYaw: target.yaw, shotPitch: target.pitch,
      viewRoll: this.camera.rotation.z });
    this.rig.root.visible = !this.scopeActive;
    this.audio?.setListener({ pos: [target.x, this.camera.position.y, target.z],
      fwd: [-Math.sin(target.yaw) * Math.cos(target.pitch), Math.sin(target.pitch), -Math.cos(target.yaw) * Math.cos(target.pitch)] });
    this.presentation?.frame?.(target, this.camera);
    this._playEvents(dt, sample, duration, elapsed);
    return true;
  }

  /** A seated killer or a followed hull: the seat's replay view (chase where it has one), no viewmodel. */
  _updateSeat(dt, aspect, subject, sample, elapsed) {
    const row = this.vehicles?.presentedRow(subject.row.id) || subject.row;
    const type = row.type ?? row.kind, key = `${type}:${subject.seatId}`;
    if (key !== this._seatKey) {
      this._seatKey = key;
      this.seatCamera.setView(type, subject.seatId, replaySeatView(type, subject.seatId), { remember: false });
    }
    if (this.camera.aspect !== aspect) this.camera.aspect = aspect;
    this.seatCamera.update(dt, { row, seatId: subject.seatId, aimYaw: subject.aimYaw, aimPitch: subject.aimPitch });
    const firstPerson = this.seatCamera.firstPerson || this.seatCamera.sight;
    this.vehicles?.setLocalView(firstPerson ? { id: row.id, seatId: subject.seatId, sight: this.seatCamera.sight } : null);
    this.scopeActive = false;
    this.scope.classList.toggle('active', false);
    if (this.rig) this.rig.root.visible = false;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    const pos = this.camera.position;
    this.audio?.setListener({ pos: [pos.x, pos.y, pos.z], fwd: [fwd.x, fwd.y, fwd.z] });
    this.presentation?.frame?.(null, this.camera);
    this._playEvents(dt, sample, this.clip.end - this.replayStart, elapsed);
    return true;
  }

  _leaveSeat() {
    if (this._seatKey == null) return;
    this._seatKey = null;
    this.seatCamera.end();
    this.vehicles?.setLocalView(null);
  }

  /** Replayed events, hit marker, effects, bodies and the banner of one replay frame. */
  _playEvents(dt, sample, duration, elapsed) {
    for (const event of sample.events) {
      if (event.kind === 'shoot') playKillcamShot(event, { audio: this.audio, tracers: this.tracers, rig: this.rig, killer: this.clip.killer });
      else if (event.kind === 'bullet') this.tracers.settleRound?.(event);
      else if (event.kind === 'projectileLaunch') this.projectiles.launch(event);
      else if (event.kind === 'projectileUpdate') this.projectiles.updateAuthority(event);
      else if (event.kind === 'projectileStick') this.projectiles.stick(event);
      else if (event.kind === 'projectileExplode') {
        this.projectiles.explode(event);
        this.audio?.explosion?.([event.x, event.y, event.z], event.type);
      } else if (event.kind === 'hit') {
        this.impacts.impact(event);
        this.roster.hit(event.victim, event);
        if (event.w === 'knife') {
          // IRON PICK: the same attack cue per kind and crit/backstab stars as live play.
          const kind = Number.isFinite(event.healthDamage) && event.healthDamage <= 0 ? 'armor'
            : (typeof event.mk === 'string' ? event.mk : 'strong');
          const pos = [event.vx, event.vy, event.vz].every(Number.isFinite) ? [event.vx, event.vy, event.vz] : null;
          this.audio?.meleeHit?.({ kind, pos, local: event.attacker === this.clip.killer });
          this.impacts.meleeHit?.(event, kind);
        }
        if (event.attacker === this.clip.killer && event.victim !== this.clip.killer) this.audio?.hitmark?.(event.hs);
      } else if (event.kind === 'kill') {
        this.roster.death(event.victim, undefined, event);
        if (event.killer === this.clip.killer && event.victim !== this.clip.killer) this.audio?.killConfirm?.(!!event.hs);
      } else if (event.kind === 'blockDamage') this.impacts.chipBlock(event);
      else if (event.kind === 'mine') {
        this.impacts.mine(event);
        this.audio?.mine?.(event.from, event.progress >= 1, [event.x + 0.5, event.y + 0.5, event.z + 0.5]);
        if (event.progress >= 1) this._minedBreak = `${event.x},${event.y},${event.z}`;
      } else if (event.kind === 'block' && event.v === 0 && event.from) {
        // A pick break already threw its chip shower and break sound.
        const cell = `${event.x},${event.y},${event.z}`;
        if (this._minedBreak === cell) this._minedBreak = null;
        else {
          this.impacts.explodeBlock(event.x, event.y, event.z, event.from);
          this.audio?.impact?.(blockSoundFor(event.from), 0.8, [event.x, event.y, event.z]);
        }
      }
    }
    if (this.structure) {
      this.structure.receive(sample);
      this.structure.update(dt, sample.time);
    }
    const mark = sample.hitmark;
    this.hitmarker.dataset.kind = mark?.kind || '';
    this.hitmarker.classList.toggle('vb-show', !!mark);
    this.hitmarker.classList.toggle('vb-kill', !!mark?.kill);
    this.hitmarker.classList.toggle('vb-hs', mark?.kind === 'head' || mark?.kind === 'killHead');
    this.tracers.update(dt);
    this.projectiles.update(dt);
    this.impacts.update(dt);
    this.particles?.update(dt, this.camera);
    // Mode bodies that are not player rows (Titanfall minions) join the replay through the presentation.
    const extra = this.presentation?.replayRows?.(sample.npcs) ?? null;
    this.roster.sync(extra?.size ? new Map([...sample.players, ...extra]) : sample.players, dt, this.now());
    this.roster.hideLabels();
    this.timeLabel.textContent = `${Math.max(0, (duration - elapsed) / 1000).toFixed(1)}s`;
    this.progress.style.transform = `scaleX(${Math.min(1, elapsed / duration)})`;
  }

  stop() {
    if (this.active) this.worldview?.setReplayTerrain(null);
    this.clip?.terrain?.release?.();
    this._leaveSeat();
    // The replay hull view stays for the next replay; its hulls go now.
    if (this.vehicles) { try { this.vehicles.sync([], [], null, {}); } catch (error) { console.warn('[vb] killcam vehicles', error); } }
    try { this.presentation?.dispose?.(); } catch (error) { console.warn('[vb] killcam presentation', error); }
    this.presentation = null;
    this.active = false;
    this.pendingAt = null;
    this._minedBreak = null;
    this.history.activeClip = null;
    this.scopeActive = false;
    this.scope.classList.remove('active');
    this.group.visible = false;
    this.root.classList.add('hidden');
    document.body.classList.remove('is-replaying');
    this.roster?.dispose(); this.tracers?.dispose(); this.projectiles?.dispose(); this.rig?.dispose(); this.impacts?.dispose();
    this.structure?.dispose(); this.particles?.dispose();
    this.roster = this.tracers = this.projectiles = this.rig = this.impacts = this.structure = this.particles = null;
    this.hitmarker.classList.remove('vb-show', 'vb-kill', 'vb-hs');
    this.hitmarker.dataset.kind = '';
    this.sample = this.clip = null;
  }

  dispose() {
    this.stop();
    this.vehicles?.dispose();
    this.vehicles = null;
    this.history.clear();
    this.history.terrain = null;
    this.group.removeFromParent();
    this.root.remove();
    document.removeEventListener('keydown', this._onKey);
  }
}
