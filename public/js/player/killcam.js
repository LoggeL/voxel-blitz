import { bindingLabel, matchesBinding, isTypingTarget } from '../keybindings.js';
import * as THREE from '../vendor/three.module.js';
import { KillcamHistory, sampleKillcam } from './killcam-history.js';
import { KillcamTerrain } from './killcam-terrain.js';
import { AvatarRoster } from '../avatar/avatar-roster.js';
import { TracerFX } from '../weapons/ballistics.js';
import { ProjectileFX } from '../weapons/projectiles.js';
import { ImpactFX, blockSoundFor } from '../weapons/impacts.js';
import { ViewmodelRig } from '../guns/viewmodel.js';
import { EYE_HEIGHT, WEAPON_IDS } from '../../../shared/combatmath.js';
import { stanceEye } from '../../../shared/player-stance.js';
import { WEAPON_NAMES, THROWABLE_NAMES } from '../ui/hud-support.js';

/** Recorded attacker view. Live simulation keeps running and owns respawn. */
export class Killcam {
  constructor({ scene, getBlock, worldview = null, mapBytes = null, blockDamage = [],
    terrainTime = -Infinity, audio = null, now = () => performance.now() }) {
    this.scene = scene;
    this.getBlock = (x, y, z) => this.clip?.terrain
      ? this.clip.terrain.getBlock(x, y, z) : getBlock(x, y, z);
    this.worldview = worldview;
    this.audio = audio;
    this.now = now;
    this.history = new KillcamHistory(mapBytes ? new KillcamTerrain(mapBytes, blockDamage, terrainTime) : null);
    this.active = false;
    this.group = new THREE.Group();
    this.group.name = 'killcam-replay';
    this.group.visible = false;
    scene.add(this.group);
    this.camera = new THREE.PerspectiveCamera(80, 1, 0.04, 1500);
    this.camera.rotation.order = 'YXZ';
    this.group.add(this.camera);
    this.root = document.createElement('section');
    this.root.className = 'vb-killcam hidden';
    this.root.id = 'killcam-replay';
    this.root.setAttribute('aria-label', 'Killcam replay');
    this.root.innerHTML = `<div class="vb-killcam-hitmarker" aria-hidden="true"></div>
      <div class="vb-killcam-top"><span>REPLAY</span><b>KILLCAM</b><span class="vb-killcam-time"></span></div>
      <div class="vb-killcam-bottom"><span class="vb-killcam-name"></span><span class="vb-killcam-weapon"></span>
      <button type="button" id="killcam-skip">SKIP REPLAY <small>SPACE / A</small></button>
      <div class="vb-killcam-progress"><i></i></div></div>`;
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

  start(deathEvent, mode) {
    const clip = this.history.clip(deathEvent, mode);
    if (!clip) return false;
    this.stop();
    this.clip = clip;
    this.worldview?.setReplayTerrain(clip.terrain);
    this.previousTime = clip.start - 1;
    this.sample = null;
    this.active = true;
    this.group.visible = true;
    this.root.classList.remove('hidden');
    this.root.querySelector('#killcam-skip small').textContent = `${bindingLabel('skipReplay')} / A`;
    document.body.classList.add('is-replaying');
    this.root.querySelector('.vb-killcam-name').textContent = clip.name;
    this.root.querySelector('.vb-killcam-weapon').textContent =
      WEAPON_NAMES[clip.weapon] || THROWABLE_NAMES[clip.weapon] || 'ELIMINATED';
    this.roster = new AvatarRoster({ scene: this.group, getBlock: this.getBlock, getMyId: () => clip.killer });
    this.tracers = new TracerFX(this.group, this.getBlock, () => {});
    this.projectiles = new ProjectileFX(this.group, this.getBlock, { camera: this.camera });
    this.impacts = new ImpactFX(this.group, this.camera, this.getBlock);
    this.rig = new ViewmodelRig(this.camera);
    this.weapon = null;
    this.padHeld = true;
    this.started = this.now();
    return true;
  }

  update(dt, aspect, fov) {
    if (!this.active) return false;
    const elapsed = this.now() - this.started;
    const duration = this.clip.end - this.clip.start;
    if (elapsed >= duration + 300) { this.stop(); return false; }
    const pads = typeof navigator !== 'undefined' ? navigator.getGamepads?.() || [] : [];
    const pressed = Array.from(pads).some(pad => pad?.buttons?.[0]?.pressed);
    if (pressed && !this.padHeld) { this.stop(); return false; }
    this.padHeld = pressed;
    const sample = sampleKillcam(this.clip, this.clip.start + elapsed, this.previousTime);
    this.previousTime = sample.time;
    this.sample = sample;
    this.clip.terrain?.apply(sample.terrain);
    this.worldview?.updateReplayTerrain(sample.terrain);
    const target = sample.players.get(this.clip.killer);
    if (!target) { this.stop(); return false; }
    this.camera.position.set(target.x, target.y + stanceEye(EYE_HEIGHT, target.crouch, target.proneT), target.z);
    this.camera.rotation.set(target.pitch, target.yaw, 0, 'YXZ');
    if (this.camera.aspect !== aspect || this.camera.fov !== fov) {
      this.camera.aspect = aspect; this.camera.fov = fov; this.camera.updateProjectionMatrix();
    }
    this.rig.setCosmetics(target.cosmetics);
    const weapon = WEAPON_IDS[target.weapon] || 'rifle';
    if (weapon !== this.weapon) { this.rig.setWeapon(weapon); this.weapon = weapon; }
    this.rig.ads(target.ads ? 1 : 0);
    this.rig.update(dt, { speed: target.moveSpeed, crouch: target.crouch, proneT: target.proneT,
      grounded: target.grounded, shotYaw: target.yaw, shotPitch: target.pitch });
    this.audio?.setListener({ pos: [target.x, this.camera.position.y, target.z],
      fwd: [-Math.sin(target.yaw) * Math.cos(target.pitch), Math.sin(target.pitch), -Math.cos(target.yaw) * Math.cos(target.pitch)] });
    for (const event of sample.events) {
      if (event.kind === 'shoot') {
        this.tracers.shoot(event);
        if (event.id === this.clip.killer) this.rig.fire();
        this.audio?.fire(event.w, { pos: event.o });
      } else if (event.kind === 'projectileLaunch') this.projectiles.launch(event);
      else if (event.kind === 'projectileUpdate') this.projectiles.updateAuthority(event);
      else if (event.kind === 'projectileStick') this.projectiles.stick(event);
      else if (event.kind === 'projectileExplode') {
        this.projectiles.explode(event);
        this.audio?.explosion?.([event.x, event.y, event.z], event.type);
      } else if (event.kind === 'hit') {
        this.impacts.impact(event);
        this.roster.hit(event.victim, event);
        if (event.attacker === this.clip.killer && event.victim !== this.clip.killer) this.audio?.hitmark?.(event.hs);
      } else if (event.kind === 'kill') {
        this.roster.death(event.victim, undefined, event);
        if (event.killer === this.clip.killer && event.victim !== this.clip.killer) this.audio?.killConfirm?.(!!event.hs);
      } else if (event.kind === 'blockDamage') this.impacts.chipBlock(event);
      else if (event.kind === 'mine') {
        this.impacts.mine(event);
        this.audio?.mine?.(event.from, event.progress >= 1, [event.x + 0.5, event.y + 0.5, event.z + 0.5]);
      } else if (event.kind === 'block' && event.v === 0 && event.from) {
        this.impacts.explodeBlock(event.x, event.y, event.z, event.from);
        this.audio?.impact?.(blockSoundFor(event.from), 0.8, [event.x, event.y, event.z]);
      }
    }
    const mark = sample.hitmark;
    this.hitmarker.dataset.kind = mark?.kind || '';
    this.hitmarker.classList.toggle('vb-show', !!mark);
    this.hitmarker.classList.toggle('vb-kill', !!mark?.kill);
    this.hitmarker.classList.toggle('vb-hs', mark?.kind === 'head' || mark?.kind === 'killHead');
    this.tracers.update(dt);
    this.projectiles.update(dt);
    this.impacts.update(dt);
    this.roster.sync(sample.players, dt, this.now());
    this.roster.hideLabels();
    this.timeLabel.textContent = `${Math.max(0, (duration - elapsed) / 1000).toFixed(1)}s`;
    this.progress.style.transform = `scaleX(${Math.min(1, elapsed / duration)})`;
    return true;
  }

  stop() {
    if (this.active) this.worldview?.setReplayTerrain(null);
    this.active = false;
    this.group.visible = false;
    this.root.classList.add('hidden');
    document.body.classList.remove('is-replaying');
    this.roster?.dispose(); this.tracers?.dispose(); this.projectiles?.dispose(); this.rig?.dispose(); this.impacts?.dispose();
    this.roster = this.tracers = this.projectiles = this.rig = this.impacts = null;
    this.hitmarker.classList.remove('vb-show', 'vb-kill', 'vb-hs');
    this.hitmarker.dataset.kind = '';
    this.sample = this.clip = null;
  }

  dispose() {
    this.stop();
    this.history.clear();
    this.history.terrain = null;
    this.group.removeFromParent();
    this.root.remove();
    document.removeEventListener('keydown', this._onKey);
  }
}
