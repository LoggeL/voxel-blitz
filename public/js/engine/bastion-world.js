import * as THREE from '../vendor/three.module.js';
import { BastionStructureView } from './bastion-structures.js';

// Visual peers of the authoritative Bastion layout (`mapMeta.bastion`): one
// objective model per stage, ingress fields, lane beacons, the active build
// zone, the extraction ring and the player-built structures. Everything reads
// `match.bastion` defensively so a partial snapshot never throws.
const COLOR = { future: 0x5a6670, held: 0x3f8f5a, teal: 0x55ead0, amber: 0xffae45, red: 0xff4d40, zone: 0x46ddb1, laneOff: 0x332315, laneOn: 0xff6a1f, laneWarn: 0xff2a2a };
const LANE_WARNING_MS = 5000, EXTRACT_FINAL_MS = 15000;
const EMPTY_LAYOUT = Object.freeze({ ingress: [], solids: [], lanes: [], stages: [] });
// The scene blends in linear light (combat-post-process renders into a linear
// target), where the old sRGB-tuned alphas read about three times as strong over
// dark walls but weaker over pale concrete. The volumetric field only needs a hint;
// the floor cues (build zone, extraction ring) keep enough alpha to read on light floors.
const OVERLAY_OPACITY = Object.freeze({ field: 0.025, zone: 0.1, ring: 0.16, ringIdle: 0.1, ringPulse: [0.12, 0.07] });
// Distance every overlay keeps from the integer voxel planes it would otherwise share.
const OVERLAY_INSET = 0.05;

export class BastionWorld {
  constructor(scene, layout) {
    this.layout = layout && typeof layout === 'object' ? layout : EMPTY_LAYOUT;
    this.group = new THREE.Group(); this.group.name = 'bastion-objectives'; scene?.add(this.group);
    this.materials = []; this.geometries = []; this.textures = []; this.lanes = new Map(); this.stages = [];
    this.clock = 0; this.lastWave = null; this.laneRedUntil = 0; this.holdRemainingMs = null; this.phase = null;
    this.structures = new BastionStructureView(); this.group.add(this.structures.group);
    this.metal = this.material(0x24394b); this.pale = this.material(0xd2e7df); this.dark = this.material(0x1a2430);
    const stages = Array.isArray(this.layout.stages) ? this.layout.stages : [];
    const floorY = stages[0]?.objective?.y ?? 15.02;
    // Ingress fields sit OVERLAY_INSET inside every block plane, so walls hide them
    // by depth instead of z-fighting with them; only the openings stay tinted.
    const field = this.overlay(0xff9d4b, OVERLAY_OPACITY.field, 1), fieldBase = Math.floor(floorY);
    for (const b of this.layout.ingress ?? []) this.box(this.group, [(b.minX + b.maxX) / 2, fieldBase + 4, (b.minZ + b.maxZ) / 2],
      [b.maxX - b.minX - 2 * OVERLAY_INSET, 8 - 2 * OVERLAY_INSET, b.maxZ - b.minZ - 2 * OVERLAY_INSET], field);
    for (const lane of this.layout.lanes ?? []) {
      const e = lane.entry ?? { x: 0, y: floorY, z: 0 }, material = this.material(0x80684f, COLOR.laneOff);
      this.box(this.group, [e.x, e.y + 5.5, e.z], [0.4, 2, 0.4], material);
      const label = this.label(lane.name ?? lane.id ?? 'LANE', [e.x, e.y + 7, e.z], 0xffcf70, 6);
      this.lanes.set(lane.id, { material, label });
    }
    for (const stage of stages) if (stage?.objective) this.stages.push(this.buildStage(stage));
  }

  buildStage(stage) {
    const o = stage.objective, root = new THREE.Group(); root.position.set(o.x, o.y, o.z); this.group.add(root);
    const glow = this.material(COLOR.future, COLOR.future), s = { id: stage.id, stage, root, glow, discs: [], strobe: null, ring: null, ringMat: null, state: 'future' };
    let top = 3.6;
    switch (o.model) {
      case 'pump':
        this.box(root, [0, 0.15, 0], [2.8, 0.3, 2.8], this.metal);
        this.mesh(root, new THREE.CylinderGeometry(1.1, 1.1, 1.6, 20), glow, [0, 1.1, 0]);
        for (const z of [-0.9, 0.9]) this.box(root, [0, 1.2, z], [3.2, 0.4, 0.4], this.metal);
        this.box(root, [0, 2.0, 0], [1.2, 0.2, 1.2], this.pale); top = 2.4; break;
      case 'generator':
        this.box(root, [0, 0.9, 0], [2.2, 1.8, 2.2], this.metal);
        for (const x of [-1.2, 1.2]) { const g = new THREE.CylinderGeometry(0.7, 0.7, 0.15, 16); g.rotateZ(Math.PI / 2); s.discs.push(this.mesh(root, g, glow, [x, 1.0, 0])); }
        this.box(root, [0, 1.9, 0], [1.6, 0.2, 1.6], this.pale); top = 2.4; break;
      case 'tower':
        this.box(root, [0, 0.15, 0], [2.4, 0.3, 2.4], this.metal);
        this.box(root, [0, 3.0, 0], [0.6, 6, 0.6], this.pale);
        { const dish = new THREE.ConeGeometry(0.9, 0.5, 16, 1, true); dish.rotateZ(-Math.PI / 2); this.mesh(root, dish, this.metal, [0.75, 5.2, 0]); }
        this.box(root, [0, 6.15, 0], [0.3, 0.3, 0.3], glow); top = 6.6; break;
      case 'beacon':
        this.box(root, [0, 0.1, 0], [1.6, 0.2, 1.6], this.metal);
        this.box(root, [0, 1.8, 0], [0.4, 3.2, 0.4], this.pale);
        { const torus = new THREE.TorusGeometry(0.6, 0.06, 8, 24); torus.rotateX(Math.PI / 2); s.strobe = this.mesh(root, torus, glow, [0, 3.4, 0]); }
        { const r = stage.extractRadius ?? 8; s.ringMat = this.overlay(COLOR.amber, OVERLAY_OPACITY.ring, -1);
          const ring = new THREE.RingGeometry(Math.max(0.5, r - 0.35), r, 48); ring.rotateX(-Math.PI / 2); s.ring = this.mesh(root, ring, s.ringMat, [0, Math.floor(o.y) - o.y + OVERLAY_INSET, 0]); s.ring.visible = false; }
        top = 3.9; break;
      default: // 'core': the reactor stack
        this.box(root, [0, 0.22, 0], [2.8, 0.44, 2.8], this.metal);
        this.box(root, [0, 1.7, 0], [1.7, 2.8, 1.7], glow);
        for (const x of [-1.15, 1.15]) for (const z of [-1.15, 1.15]) this.box(root, [x, 1.8, z], [0.35, 3.6, 0.35], this.pale);
        this.box(root, [0, 3.4, 0], [2.8, 0.4, 2.8], this.metal);
        this.box(root, [0, 3.68, 0], [1.8, 0.16, 1.8], glow); top = 4.2;
    }
    s.label = this.label(stage.name ?? o.name ?? 'OBJECTIVE', [o.x, o.y + top + 1.2, o.z], 0x66ffdc, 3);
    if (stage.supply) {
      const p = stage.supply, supply = new THREE.Group(); supply.position.set(p.x, p.y, p.z); this.group.add(supply);
      this.box(supply, [0, 0.5, 0], [2, 1, 1.5], this.metal);
      s.supplyGlow = this.material(0x45716c, 0x102b29); this.box(supply, [0, 1.1, 0], [1.7, 0.2, 1.2], s.supplyGlow);
      s.supplyLabel = this.label('SUPPLY', [p.x, p.y + 3.2, p.z], 0x83f0dd, 3.5);
    }
    const z = stage.buildZone;
    if (z && [z.minX, z.maxX, z.minZ, z.maxZ].every(Number.isFinite)) {
      const w = z.maxX - z.minX + 1, d = z.maxZ - z.minZ + 1;
      const zoneMat = this.overlay(COLOR.zone, OVERLAY_OPACITY.zone, -1);
      const plane = new THREE.PlaneGeometry(w, d); plane.rotateX(-Math.PI / 2);
      s.zone = this.mesh(this.group, plane, zoneMat, [z.minX + w / 2, Math.floor(o.y) + OVERLAY_INSET, z.minZ + d / 2]); s.zone.visible = false;
    }
    return s;
  }

  /** Low-alpha zone cue; `offset` 1 yields to coplanar-adjacent geometry, -1 wins over the floor below it. */
  overlay(color, opacity, offset) {
    const m = new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: offset, polygonOffsetUnits: offset });
    this.materials.push(m); return m;
  }
  material(color, emissive = 0) { const m = new THREE.MeshStandardMaterial({ color, emissive, emissiveIntensity: 0.8, roughness: 0.55, metalness: 0.4 }); this.materials.push(m); return m; }
  mesh(parent, geometry, material, pos) { this.geometries.push(geometry); const mesh = new THREE.Mesh(geometry, material); mesh.position.set(...pos); parent.add(mesh); return mesh; }
  box(parent, pos, size, material) { return this.mesh(parent, new THREE.BoxGeometry(...size), material, pos); }
  label(text, pos, color, width) {
    const material = new THREE.SpriteMaterial({ depthTest: true, transparent: true }); this.materials.push(material);
    if (typeof document !== 'undefined') {
      const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 80;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = 'rgba(10,20,30,0.88)'; ctx.fillRect(0, 0, 512, 80);
      ctx.strokeStyle = '#' + color.toString(16).padStart(6, '0'); ctx.lineWidth = 4; ctx.strokeRect(2, 2, 508, 76);
      ctx.fillStyle = ctx.strokeStyle; ctx.font = 'bold 31px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(text), 256, 40);
      const texture = new THREE.CanvasTexture(canvas); this.textures.push(texture); material.map = texture;
    } else material.color.setHex(color);
    const sprite = new THREE.Sprite(material); sprite.position.set(...pos); sprite.scale.set(width, width * 80 / 512, 1); this.group.add(sprite); return sprite;
  }

  /** Optional event hook (main.js may forward `bastion_lane`); wave changes light the lane on their own. */
  event(kind, now = Date.now()) { if (kind === 'bastion_lane') this.laneRedUntil = now + LANE_WARNING_MS; }

  /** `serverNow` is the snapshot's server clock; `holdEndsAt` lives in that domain, never in the local one. */
  sync(match, now = Date.now(), serverNow = now) {
    this.group.visible = match?.mode === 'bastion'; const b = match?.bastion; if (!b || typeof b !== 'object') return;
    const phase = this.phase = match.phase, index = Number.isFinite(b.stage?.index) ? b.stage.index : 0;
    const held = new Set(Array.isArray(b.held) ? b.held : []);
    if (b.wave !== this.lastWave) { if (this.lastWave !== null && phase === 'live') this.laneRedUntil = now + LANE_WARNING_MS; this.lastWave = b.wave; }
    const active = this.stages[index] ?? null;
    const maxHp = b.core?.maxHp ?? active?.stage.objective.hp ?? 1, hp = Number.isFinite(b.core?.hp) ? b.core.hp : maxHp;
    const activeColor = hp <= maxHp * 0.25 ? COLOR.red : hp <= maxHp * 0.5 ? COLOR.amber : COLOR.teal;
    this.holdRemainingMs = Number.isFinite(b.stage?.holdEndsAt) && Number.isFinite(serverNow) ? b.stage.holdEndsAt - serverNow : null;
    for (const [i, s] of this.stages.entries()) {
      const state = s.state = i === index ? 'active' : held.has(s.id) || i < index ? 'held' : 'future';
      const color = state === 'active' ? activeColor : state === 'held' ? COLOR.held : COLOR.future;
      s.glow.color.setHex(color); s.glow.emissive.setHex(color); s.glow.emissiveIntensity = state === 'active' ? 0.8 : 0.3;
      s.label.material.opacity = state === 'active' ? 1 : 0.35;
      if (s.zone) s.zone.visible = state === 'active' && (phase === 'prep' || phase === 'supply');
      if (s.ring) s.ring.visible = state === 'active' && s.stage.kind === 'extract' && phase !== 'post';
      if (s.supplyGlow) {
        const open = state === 'active' && !!b.supply?.active;
        s.supplyGlow.emissive.setHex(open ? 0x22ddaa : 0x102b29); s.supplyLabel.material.opacity = open ? 1 : state === 'active' ? 0.4 : 0.15;
      }
    }
    const activeLane = active?.stage.lane ?? null, lanes = Array.isArray(b.lanes) ? b.lanes : [];
    for (const [id, lane] of this.lanes) {
      const lit = phase !== 'post' && (activeLane ? id === activeLane : lanes.includes(id));
      lane.material.emissive.setHex(!lit ? COLOR.laneOff : now < this.laneRedUntil ? COLOR.laneWarn : COLOR.laneOn);
      lane.label.material.opacity = lit ? 1 : 0.3;
    }
    this.structures.sync(Array.isArray(b.structures) ? b.structures : []);
  }

  /** Per-frame motion: turbine discs, beacon strobe and the pulsing extraction ring. */
  update(dt = 0) {
    this.clock += dt; this.structures.update(dt);
    if (this.holdRemainingMs !== null) this.holdRemainingMs -= dt * 1000;
    for (const s of this.stages) {
      for (const disc of s.discs) disc.rotation.x += dt * (s.state === 'active' ? 4 : s.state === 'held' ? 1 : 0);
      if (s.strobe) { s.strobe.rotation.y += dt * (s.state === 'active' ? 3 : 0.5); s.glow.emissiveIntensity = s.state === 'active' ? 0.7 + 0.5 * Math.abs(Math.sin(this.clock * 4)) : 0.3; }
      if (s.ring?.visible) {
        const live = this.phase === 'live', final = live && this.holdRemainingMs !== null && this.holdRemainingMs <= EXTRACT_FINAL_MS;
        s.ringMat.color.setHex(final ? COLOR.zone : COLOR.amber);
        s.ringMat.opacity = live ? OVERLAY_OPACITY.ringPulse[0] + OVERLAY_OPACITY.ringPulse[1] * Math.sin(this.clock * (final ? 6 : 2.5)) : OVERLAY_OPACITY.ringIdle;
      }
    }
  }

  dispose() {
    this.structures.dispose(); this.group.removeFromParent(); this.group.clear();
    for (const g of this.geometries) g.dispose(); for (const m of this.materials) m.dispose(); for (const t of this.textures) t.dispose();
    this.geometries = []; this.materials = []; this.textures = []; this.stages = []; this.lanes.clear();
  }
}
