import * as THREE from '../vendor/three.module.js';
import { isTeamMode } from '../../../shared/modes.js';

const CAMERA_DISTANCE = 4.2;
const CAMERA_HEIGHT = 2.45;
const CAMERA_SHOULDER = 1.35;
const CAMERA_LOOK_AHEAD = 1.35;
const WALL_MARGIN = 0.28;
/** How long the kill cam follows the killer before the spectator rotation takes over. */
export const KILL_CAM_MS = 2600;

function rowId(row) {
  return row?.id == null ? null : String(row.id);
}

function livingCandidates(players, self, mode) {
  const selfId = rowId(self);
  const teamOnly = isTeamMode(mode) && self?.team;
  return (Array.isArray(players) ? players : [])
    .filter((row) => rowId(row) !== selfId && row?.state === 'alive')
    .filter((row) => !teamOnly || row.team === self.team)
    .map((row) => ({
      id: rowId(row),
      name: String(row.name || 'OPERATOR'),
      row,
    }));
}

/** Selects legal living targets, presents respawn state, and drives a collision-safe chase camera. */
export class SpectatorCamera {
  constructor({ camera, raycast, now, onPresent } = {}) {
    if (!camera) throw new TypeError('SpectatorCamera requires a camera');
    this.camera = camera;
    this.raycast = typeof raycast === 'function' ? raycast : () => null;
    this.now = typeof now === 'function' ? now : () => performance.now();
    this.onPresent = typeof onPresent === 'function' ? onPresent : () => {};

    this.active = false;
    this.targetId = null;
    this.candidates = [];
    this.killCam = null; // { id, until } - the killer is followed first
    this.mode = 'fun';
    this.phase = 'live';
    this.serverNow = null;
    this.observedAt = 0;
    this.respawnAt = null;
    this._cameraSeeded = false;
    this._lastPresentationKey = '';
    this._focus = new THREE.Vector3();
    this._lookAt = new THREE.Vector3();
    this._desired = new THREE.Vector3();
    this._direction = new THREE.Vector3();

    this._onKeyDown = (event) => {
      if (!this.active || event.repeat) return;
      if (event.code === 'ArrowLeft' || event.code === 'KeyQ') {
        event.preventDefault();
        this.cycle(-1);
      } else if (event.code === 'ArrowRight' || event.code === 'KeyE') {
        event.preventDefault();
        this.cycle(1);
      }
    };
    document.addEventListener('keydown', this._onKeyDown);
  }

  sync({ self, players, match, serverNow } = {}) {
    const wasActive = this.active;
    this.active = self?.state === 'dead';
    this.mode = match?.mode || 'fun';
    this.phase = match?.phase || 'live';
    this.serverNow = Number.isFinite(serverNow) ? serverNow : null;
    this.observedAt = this.now();
    this.candidates = livingCandidates(players, self, this.mode);

    if (!this.active) {
      this.targetId = null;
      this.respawnAt = null;
      this._cameraSeeded = false;
      this._present();
      return;
    }

    // The authoritative deadline is part of the local player's wire row.
    // Null also intentionally covers round-based modes such as S&D.
    this.respawnAt = Number.isFinite(self?.respawnAt) ? self.respawnAt : null;

    if (!wasActive) {
      this._cameraSeeded = false;
    }

    const killCam = this.killCam;
    if (killCam && this.observedAt >= killCam.until) this.killCam = null;
    if (this.killCam && this.candidates.some((candidate) => candidate.id === this.killCam.id)) {
      if (this.targetId !== this.killCam.id) {
        this.targetId = this.killCam.id;
        this._cameraSeeded = false;
      }
    } else if (!this.candidates.some((candidate) => candidate.id === this.targetId)) {
      this.targetId = this.candidates[0]?.id || null;
      this._cameraSeeded = false;
    }
    this._present();
  }

  /** Kill cam: follow the killer for `ms` before the normal spectator rotation. */
  focusKiller(killerId, ms = KILL_CAM_MS) {
    const id = killerId == null ? null : String(killerId);
    if (!id) {
      this.killCam = null;
      return false;
    }
    this.killCam = { id, until: this.now() + Math.max(0, Number(ms) || 0) };
    if (this.active && this.candidates.some((candidate) => candidate.id === id)) {
      this.targetId = id;
      this._cameraSeeded = false;
      this._present();
    }
    return true;
  }

  cycle(direction = 1) {
    if (!this.active || this.candidates.length < 2) return false;
    this.killCam = null;
    const current = this.candidates.findIndex((candidate) => candidate.id === this.targetId);
    const next = (Math.max(0, current) + (direction < 0 ? -1 : 1) + this.candidates.length)
      % this.candidates.length;
    this.targetId = this.candidates[next].id;
    this._cameraSeeded = false;
    this._present();
    return true;
  }

  /** Keep the selected third-person target renderable while interpolation catches up. */
  ensureTargetPresent(interpolatedPlayers) {
    const hasPlayers = interpolatedPlayers
      && typeof interpolatedPlayers.get === 'function'
      && typeof interpolatedPlayers.has === 'function';
    if (!this.active || !this.targetId) return hasPlayers ? interpolatedPlayers : null;
    const players = hasPlayers ? interpolatedPlayers : new Map();
    if (players.has(this.targetId)) return players;
    const fallback = this.candidates.find((candidate) => candidate.id === this.targetId)?.row;
    if (!fallback) return players;
    const presented = new Map(players);
    presented.set(this.targetId, fallback);
    return presented;
  }

  update(interpolatedPlayers, dt) {
    if (!this.active) return false;
    const target = interpolatedPlayers?.get?.(this.targetId)
      || this.candidates.find((candidate) => candidate.id === this.targetId)?.row;
    if (!target || ![target.x, target.y, target.z, target.yaw].every(Number.isFinite)) {
      this._present();
      return false;
    }

    const yaw = target.yaw;
    this._focus.set(target.x, target.y + 1.35, target.z);
    this._lookAt.set(
      target.x - Math.sin(yaw) * CAMERA_LOOK_AHEAD,
      target.y + 1.35,
      target.z - Math.cos(yaw) * CAMERA_LOOK_AHEAD,
    );
    this._desired.set(
      target.x + Math.sin(yaw) * CAMERA_DISTANCE + Math.cos(yaw) * CAMERA_SHOULDER,
      target.y + CAMERA_HEIGHT,
      target.z + Math.cos(yaw) * CAMERA_DISTANCE - Math.sin(yaw) * CAMERA_SHOULDER,
    );
    this._direction.copy(this._desired).sub(this._focus);
    const distance = this._direction.length();
    if (distance > 0.001) {
      this._direction.multiplyScalar(1 / distance);
      const hit = this.raycast(this._focus, this._direction, distance);
      if (hit && Number.isFinite(hit.t) && hit.t < distance) {
        this._desired.copy(this._focus).addScaledVector(
          this._direction,
          Math.max(0.45, hit.t - WALL_MARGIN),
        );
      }
    }

    if (!this._cameraSeeded) {
      this.camera.position.copy(this._desired);
      this._cameraSeeded = true;
    } else {
      this.camera.position.lerp(this._desired, 1 - Math.exp(-Math.max(0, dt) * 9));
    }
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this._lookAt);
    this._present();
    return true;
  }

  reset() {
    this.active = false;
    this.targetId = null;
    this.killCam = null;
    this.candidates = [];
    this.respawnAt = null;
    this._cameraSeeded = false;
    this._lastPresentationKey = '';
    this._present();
  }

  dispose() {
    document.removeEventListener('keydown', this._onKeyDown);
    this.reset();
    this.camera = null;
    this.raycast = null;
    this.onPresent = null;
  }

  _estimatedServerNow() {
    if (this.serverNow === null) return null;
    return this.serverNow + Math.max(0, this.now() - this.observedAt);
  }

  _respawnText() {
    if (this.phase === 'post' && this.mode !== 'snd') return 'MATCH OVER';
    if (this.mode === 'bastion') return 'RETURN AT NEXT SUPPLY';
    if (this.mode === 'snd') return this.phase === 'prep' ? 'ROUND STARTING' : 'RESPAWN NEXT ROUND';
    const estimated = this._estimatedServerNow();
    if (estimated === null || this.respawnAt === null) return 'RESPAWNING';
    const seconds = Math.max(0, (this.respawnAt - estimated) / 1000);
    return `RESPAWN IN ${seconds.toFixed(1)}s`;
  }

  _present() {
    const target = this.candidates.find((candidate) => candidate.id === this.targetId) || null;
    const state = {
      active: this.active,
      targetName: target?.name || '',
      hasTarget: !!target,
      killCam: !!(target && this.killCam && this.killCam.id === target.id),
      canCycle: this.candidates.length > 1,
      teamOnly: isTeamMode(this.mode),
      respawnText: this.active ? this._respawnText() : '',
    };
    const key = Object.values(state).join('|');
    if (key === this._lastPresentationKey) return;
    this._lastPresentationKey = key;
    this.onPresent?.(state);
  }
}
