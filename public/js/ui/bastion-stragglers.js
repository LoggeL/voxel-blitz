import * as THREE from '../vendor/three.module.js';
import { el } from './hud-support.js';
import { bastionStragglerLabel } from './bastion-hud.js';

const MARK = '#ff554b';   // Bastion urgent red

/**
 * Screen markers for the hostiles the server revealed (`match.bastion.stragglers`)
 * before the withdrawal countdown ends. Positions follow the presented bodies and
 * fall back to the server rows; markers clamp to the screen edge like TttRadar.
 */
export class BastionStragglers {
  constructor() {
    this.root = el('div', 'vb-ttt-radar-layer', document.body, 'bastion-stragglers');
    this.root.hidden = true;
    this.markers = [];
    this.point = new THREE.Vector3();
    this.local = new THREE.Vector3();
    this.eye = new THREE.Vector3();
  }
  update(game) {
    const match = game.matchState, list = match?.bastion?.stragglers || [];
    const active = !!game.running && match?.mode === 'bastion' && match.phase === 'live' && list.length > 0 && !game.hud?.isBuyMenuOpen?.();
    this.root.hidden = !active;
    if (!active || !game.camera) return;
    game.camera.updateMatrixWorld();
    game.camera.getWorldPosition(this.eye);
    const width = window.innerWidth, height = window.innerHeight, occupied = [];
    for (let i = 0; i < list.length; i++) {
      const s = list[i], at = game.roster?.positionOf?.(s.id) || s;
      let marker = this.markers[i];
      if (!marker) { marker = el('div', 'vb-ttt-contact', this.root); this.markers.push(marker); }
      marker.hidden = false; marker.dataset.kind = s.kind;
      // Aim at the chest, not the feet.
      this.point.set(at.x, at.y + 1.2, at.z);
      this.local.copy(this.point).applyMatrix4(game.camera.matrixWorldInverse);
      const behind = this.local.z >= 0, side = this.local.x >= 0 ? 'right' : 'left';
      this.point.project(game.camera);
      let sx = (this.point.x * .5 + .5) * width, sy = (-this.point.y * .5 + .5) * height;
      if (behind) { sx = side === 'right' ? width - 44 : 44; sy = height * .5; }
      const edge = behind || sx < 44 || sx > width - 44 || sy < 90 || sy > height - 100;
      sx = Math.max(88, Math.min(width - 88, sx));
      sy = Math.max(90, Math.min(height - 100, sy));
      for (let attempt = 0; attempt < list.length; attempt++) {
        if (!occupied.some(p => Math.abs(p.x - sx) < 170 && Math.abs(p.y - sy) < 23)) break;
        sy += 24;
        if (sy > height - 100) sy = 90;
      }
      occupied.push({ x: sx, y: sy });
      marker.style.left = `${sx}px`;
      marker.style.top = `${sy}px`;
      marker.style.color = MARK;
      marker.textContent = bastionStragglerLabel(s.kind, this.eye.distanceTo(this.point.set(at.x, at.y + 1.2, at.z)), edge, side);
    }
    for (let i = list.length; i < this.markers.length; i++) this.markers[i].hidden = true;
  }
  dispose() { this.root.remove(); this.markers = []; }
}
