import * as THREE from '../vendor/three.module.js';
import { el } from './hud-support.js';

/** Frozen server scan positions; only their projection follows the local camera. */
export class TttRadar {
  constructor() {
    this.root = el('div', 'vb-ttt-radar-layer', document.body, 'ttt-radar');
    this.root.hidden = true;
    this.panel = el('div', 'vb-ttt-radar-panel', this.root);
    el('span', 'vb-ttt-eyebrow', this.panel).textContent = 'LEBENSZEICHEN';
    this.canvas = el('canvas', '', this.panel); this.canvas.width = this.canvas.height = 160;
    this.canvas.setAttribute('aria-label', 'Radar: Kontakte relativ zu deiner Blickrichtung. Rot: Mit-Traitors.');
    this.status = el('p', '', this.panel, 'ttt-radar-status');
    this.markers = [];
    this.point = new THREE.Vector3();
    this.local = new THREE.Vector3();
  }
  update(game) {
    const scan = game.selfRow?.ttt?.radar;
    const active = game.running && game.matchState?.mode === 'ttt' && game.matchState.phase === 'live'
      && game.selfRow?.state === 'alive' && game.selfRow.ttt.role === 'traitor' && scan
      && !game.hud.isBuyMenuOpen() && game.session.gameplayInputEnabled;
    this.root.hidden = !active;
    if (!active) return;
    const elapsed = Math.max(0, performance.now() - (game._tttSnapshotAt || performance.now()));
    const now = (game.serverNow || 0) + elapsed;
    const remaining = Math.max(0, Math.ceil((scan.nextScanAt - now) / 1000));
    const contacts = scan.contacts || [];
    this.status.textContent = `${contacts.length} KONTAKTE · SCAN IN ${remaining} S`;
    this.root.dataset.scannedAt = String(scan.scannedAt);
    const ctx = this.canvas.getContext('2d'), center = 80, radius = 68;
    ctx.clearRect(0, 0, 160, 160);
    ctx.strokeStyle = '#63778266'; ctx.lineWidth = 1;
    for (const r of [23,45,68]) { ctx.beginPath(); ctx.arc(center,center,r,0,Math.PI*2);ctx.stroke(); }
    ctx.beginPath();ctx.moveTo(12,80);ctx.lineTo(148,80);ctx.moveTo(80,12);ctx.lineTo(80,148);ctx.stroke();
    ctx.fillStyle='#edf4f6';ctx.beginPath();ctx.moveTo(80,72);ctx.lineTo(75,86);ctx.lineTo(85,86);ctx.closePath();ctx.fill();
    game.camera.updateMatrixWorld();
    const { x, y, z } = game.player.pos, yaw = game.player.view.yaw;
    const width = window.innerWidth, height = window.innerHeight;
    this.panel.style.top = width <= 700 ? `${Math.max(350,game.tttControls.root.getBoundingClientRect().bottom+12)}px` : '';
    const occupied = [], panelRect = this.panel.getBoundingClientRect();
    for (let i = 0; i < contacts.length; i++) {
      const c = contacts[i];
      const dx = c.x-x, dz = c.z-z;
      const rx = dx*Math.cos(yaw)-dz*Math.sin(yaw), forward = -dx*Math.sin(yaw)-dz*Math.cos(yaw);
      const scale = radius/Math.max(120,Math.hypot(rx,forward));
      const color = c.ally ? '#ff6868' : '#ffcb65';
      ctx.fillStyle=color;ctx.beginPath();ctx.arc(80+rx*scale,80-forward*scale,3,0,Math.PI*2);ctx.fill();
      let marker = this.markers[i];
      if (!marker) { marker=el('div','vb-ttt-contact',this.root);this.markers.push(marker); }
      marker.hidden=false;marker.dataset.ally=String(c.ally);
      this.point.set(c.x,c.y,c.z);
      this.local.copy(this.point).applyMatrix4(game.camera.matrixWorldInverse);
      this.point.project(game.camera);
      const behind = this.local.z >= 0;
      let sx = (this.point.x*.5+.5)*width, sy=(-this.point.y*.5+.5)*height;
      if (behind) { sx=rx>=0?width-44:44;sy=height*.5; }
      const edge = behind || sx<44 || sx>width-44 || sy<90 || sy>height-100;
      sx = Math.max(44,Math.min(width-44,sx));
      sy = Math.max(90,Math.min(height-100,sy));
      if (sx > panelRect.left-30 && sy > panelRect.top-15 && sy < panelRect.bottom+15) sy=panelRect.bottom+20;
      for (let attempt=0;attempt<contacts.length;attempt++) {
        if (!occupied.some(p=>Math.abs(p.x-sx)<80&&Math.abs(p.y-sy)<23)) break;
        sy += 24;
        if (sy>height-100) sy=90;
      }
      occupied.push({x:sx,y:sy});
      marker.style.left = `${sx}px`;
      marker.style.top = `${sy}px`;
      marker.style.color=color;
      marker.textContent=`${edge ? (rx >= 0 ? '›' : '‹') : '◇'} ${Math.round(Math.hypot(dx,c.y-y,dz))} m`;
      marker.title=c.ally?'Mit-Traitor · Letzter Scan':'Lebenszeichen · Letzter Scan';
    }
    for (let i=contacts.length;i<this.markers.length;i++)this.markers[i].hidden=true;
  }
  dispose() { this.root.remove();this.markers=[]; }
}
