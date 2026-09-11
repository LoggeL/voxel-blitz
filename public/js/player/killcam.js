import { bindingLabel, matchesBinding, isTypingTarget } from '../keybindings.js';
import * as THREE from '../vendor/three.module.js';
import { KillcamHistory, sampleKillcam } from './killcam-history.js';
import { AvatarRoster } from '../avatar/avatar-roster.js';
import { TracerFX } from '../weapons/ballistics.js';
import { ProjectileFX } from '../weapons/projectiles.js';
import { ViewmodelRig } from '../guns/viewmodel.js';
import { EYE_HEIGHT, WEAPON_IDS } from '../../../shared/combatmath.js';
import { stanceEye } from '../../../shared/player-stance.js';
import { WEAPON_NAMES, THROWABLE_NAMES } from '../ui/hud-support.js';

/** Recorded attacker view. Live simulation keeps running and owns respawn. */
export class Killcam {
  constructor({ scene, getBlock, audio = null, now = () => performance.now() }) {
    this.scene = scene;
    this.getBlock = getBlock;
    this.audio = audio;
    this.now = now;
    this.history = new KillcamHistory();
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
    this.root.innerHTML = `<div class="vb-killcam-top"><span>REPLAY</span><b>KILLCAM</b><span class="vb-killcam-time"></span></div>
      <div class="vb-killcam-bottom"><span class="vb-killcam-name"></span><span class="vb-killcam-weapon"></span>
      <button type="button" id="killcam-skip">SKIP REPLAY <small>SPACE / A</small></button>
      <div class="vb-killcam-progress"><i></i></div></div>`;
    document.body.append(this.root);
    this.timeLabel = this.root.querySelector('.vb-killcam-time');
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
    this.started = this.now();
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
    this.rig = new ViewmodelRig(this.camera);
    this.weapon = null;
    this.padHeld = true;
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
    const target = sample.players.get(this.clip.killer);
    if (!target) { this.stop(); return false; }
    this.camera.position.set(target.x, target.y + stanceEye(EYE_HEIGHT, target.crouch, target.proneT), target.z);
    this.camera.rotation.set(target.pitch, target.yaw, 0, 'YXZ');
    if (this.camera.aspect !== aspect || this.camera.fov !== fov) {
      this.camera.aspect = aspect; this.camera.fov = fov; this.camera.updateProjectionMatrix();
    }
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
      else if (event.kind === 'projectileStick') this.projectiles.stick(event);
      else if (event.kind === 'projectileExplode') this.projectiles.explode(event);
    }
    this.tracers.update(dt);
    this.projectiles.update(dt);
    this.roster.sync(sample.players, dt, this.now());
    this.roster.hideLabels();
    this.timeLabel.textContent = `${Math.max(0, (duration - elapsed) / 1000).toFixed(1)}s`;
    this.progress.style.transform = `scaleX(${Math.min(1, elapsed / duration)})`;
    return true;
  }

  stop() {
    this.active = false;
    this.group.visible = false;
    this.root.classList.add('hidden');
    document.body.classList.remove('is-replaying');
    this.roster?.dispose(); this.tracers?.dispose(); this.projectiles?.dispose(); this.rig?.dispose();
    this.roster = this.tracers = this.projectiles = this.rig = null;
    this.sample = this.clip = null;
  }

  dispose() {
    this.stop();
    this.history.clear();
    this.group.removeFromParent();
    this.root.remove();
    document.removeEventListener('keydown', this._onKey);
  }
}
