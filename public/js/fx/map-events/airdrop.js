/**
 * Supply airdrop in the world (docs/conquest.md "Map events" > "Supply
 * airdrop"). Presentation only: the transport helicopter (the Conquest
 * transport's voxel model, unpainted), the crate and its canopy (the
 * parachute's voxel canopy and lines, amber) follow `airdropPose` from the
 * decoded `ev` row (landing anchor, heading extra, phase clock), so a joiner
 * sees the drop exactly where it stands. Sound reuses the transport's rotor
 * loop, the canopy snap and a wooden thud; a landed crate trails amber smoke.
 */
import * as THREE from '../../vendor/three.module.js';
import { AIRDROP_TUNING, airdropClock, airdropHeading, airdropPose, airdropSpot } from '../../../../shared/map-events/airdrop.js';
import { makeTransportModel } from '../../vehicles/models/transport.js';
import { PARACHUTE_FX, canopyBoxes, canopyLines, mergedBoxes } from '../../vehicles/parachute-fx.js';

/** Presentation tuning (no gameplay meaning). */
export const AIRDROP_FX_RULES = Object.freeze({
  crate: Object.freeze({ w: 1.2, h: 1.1, wood: 0x8a6a3c, strap: 0x2e3a2a, lamp: 0xffb020 }),
  canopyTint: 0xffb020,
  /** Inner and outer radius (m) of the landing ring. */
  ring: Object.freeze([2.6, 3.0]),
  /** A snapshot clock further off the local one than this snaps it. */
  resyncMs: 300,
  smoke: Object.freeze({ rate: 7, color: Object.freeze([1, 0.72, 0.2]), scale: 1.4 }),
  loopKey: 'airdrop:transport',
});

const CRATE_BOXES = (() => {
  const C = AIRDROP_FX_RULES.crate, h = C.h, w = C.w;
  return [
    { w, h, d: w, x: 0, y: h / 2, z: 0, color: C.wood },
    { w: w + 0.04, h: 0.12, d: 0.16, x: 0, y: h * 0.75, z: 0, color: C.strap },
    { w: 0.16, h: 0.12, d: w + 0.04, x: 0, y: h * 0.25, z: 0, color: C.strap },
    { w: 0.22, h: 0.12, d: 0.22, x: 0, y: h + 0.06, z: 0, color: C.lamp },
  ];
})();

/** One drop's world objects, built on first use and kept for the match. */
class DropView {
  constructor(scene) {
    this.scene = scene;
    this.root = new THREE.Group();
    this.root.name = 'airdrop';
    this.material = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
    this.lineMaterial = new THREE.LineBasicMaterial({ color: PARACHUTE_FX.colors.line });
    this.transport = makeTransportModel({ team: 'neutral' });
    this.transport.group.name = 'airdrop-transport';
    this.crate = new THREE.Group();
    this.crate.add(new THREE.Mesh(mergedBoxes(CRATE_BOXES), this.material));
    this.canopy = new THREE.Group();
    this.canopy.add(new THREE.Mesh(mergedBoxes(canopyBoxes(AIRDROP_FX_RULES.canopyTint)), this.material));
    const lines = new THREE.BufferGeometry();
    lines.setAttribute('position', new THREE.Float32BufferAttribute(canopyLines(PARACHUTE_FX,
      { shoulder: [AIRDROP_FX_RULES.crate.w / 2, AIRDROP_FX_RULES.crate.h, AIRDROP_FX_RULES.crate.w / 2] }), 3));
    this.canopy.add(new THREE.LineSegments(lines, this.lineMaterial));
    this.crate.add(this.canopy);
    // The landing ring on the ground while the crate sinks (design variant A).
    this.ringMaterial = new THREE.MeshBasicMaterial({ color: AIRDROP_FX_RULES.canopyTint, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false });
    this.ring = new THREE.Mesh(new THREE.RingGeometry(AIRDROP_FX_RULES.ring[0], AIRDROP_FX_RULES.ring[1], 40), this.ringMaterial);
    this.ring.rotation.x = -Math.PI / 2;
    this.root.add(this.transport.group, this.crate, this.ring);
    this.root.visible = false;
    scene?.add(this.root);
  }

  dispose() {
    this.root.parent?.remove(this.root);
    this.material.dispose(); this.lineMaterial.dispose(); this.ringMaterial.dispose(); this.ring.geometry.dispose();
  }
}

/**
 * The hook. State per drop: the decoded row's landing point and heading,
 * and a local clock (ms since the warning began) re-synced from the row.
 */
export const AIRDROP_FX = {
  view: null, drop: null, clock: null, last: null, smoke: false,

  sync(event, kit, { fresh } = {}) {
    const ms = airdropClock(event);
    const a = event.anchor && Number.isFinite(event.anchor.y) ? airdropSpot(event.anchor) : null;
    if (ms == null || !a) { this.drop = null; return; }
    const heading = airdropHeading(Array.isArray(event.extra) ? event.extra[0] : 0);
    const same = this.drop && this.drop.x === a.x && this.drop.z === a.z;
    if (!same) { this.drop = { x: a.x, y: a.y, z: a.z, heading }; this.last = null; this.smoke = false; kit.stopEmitter('airdrop:smoke'); }
    const now = performance.now();
    if (!same || fresh || this.clock == null || Math.abs(this.clock.ms + (now - this.clock.at) - ms) > AIRDROP_FX_RULES.resyncMs) this.clock = { ms, at: now };
  },

  update(dt, kit) {
    const drop = this.drop;
    if (!drop || !this.clock) { if (this.view) this.view.root.visible = false; return; }
    const scene = kit.scene?.();
    if (!scene) return;
    this.view ??= new DropView(scene);
    const view = this.view;
    const ms = this.clock.ms + (performance.now() - this.clock.at);
    const pose = airdropPose(drop, drop.heading, ms, AIRDROP_TUNING);
    view.root.visible = true;
    const t = view.transport;
    t.group.visible = pose.plane.visible;
    if (pose.plane.visible) {
      t.group.position.set(pose.plane.x, pose.plane.y, pose.plane.z);
      t.group.rotation.set(-0.08, pose.plane.yaw, 0, 'YXZ');
      t.animate?.(dt, { rotorSpeed: 1 });
      const speed = AIRDROP_TUNING.planeSpeed;
      kit.audio?.vehicleLoop?.(AIRDROP_FX_RULES.loopKey, [pose.plane.x, pose.plane.y, pose.plane.z], 'transport',
        { speed, rotorSpeed: 1, occupied: true, enginePower: 1, velocity: [-Math.sin(pose.plane.yaw) * speed, 0, -Math.cos(pose.plane.yaw) * speed] });
    } else kit.audio?.stopVehicleLoop?.(AIRDROP_FX_RULES.loopKey);
    const c = pose.crate;
    view.crate.visible = c.state !== 'carried';
    view.canopy.visible = c.state === 'falling';
    view.crate.position.set(c.x, c.y, c.z);
    view.crate.rotation.y = drop.heading;
    view.ring.visible = c.state !== 'landed';
    view.ring.position.set(drop.x, drop.y + 0.08, drop.z);
    view.ringMaterial.opacity = 0.55 + 0.35 * Math.abs(Math.sin(ms / 260));
    const at = [c.x, c.y, c.z];
    if (this.last !== c.state) {
      // Edges seen live (a joiner who arrives after one skips its one-shot sound).
      if (this.last === 'carried' && c.state === 'falling') kit.audio?.parachuteOpen?.(at);
      if (this.last === 'falling' && c.state === 'landed') {
        kit.sound.impact(at, { n: 60, speed: 6, material: 'wood' });
        kit.puff('dust', [c.x, c.y + 0.2, c.z], { count: 10, scale: 1.6, speed: 1.2 });
      }
      this.last = c.state;
    }
    if (c.state === 'landed' && !this.smoke) {
      const S = AIRDROP_FX_RULES.smoke;
      kit.emitter('airdrop:smoke', { kind: 'smoke', pos: [c.x, c.y + AIRDROP_FX_RULES.crate.h + 0.2, c.z], rate: S.rate, params: { color: S.color, scale: S.scale } });
      this.smoke = true;
    }
  },

  onEvent(ev, kit) {
    // Claimed: the crate is opened; a short burst where it stood (the row then leaves the snapshot).
    if (ev.reason === 'claimed' && Array.isArray(ev.pos)) kit.puff('dust', [ev.pos[0], ev.pos[1] + 0.5, ev.pos[2]], { count: 8, scale: 1.2 });
    return false;
  },

  end(kit) {
    this.drop = null; this.clock = null; this.last = null; this.smoke = false;
    if (this.view) this.view.root.visible = false;
    kit.audio?.stopVehicleLoop?.(AIRDROP_FX_RULES.loopKey);
  },

  clear(kit) {
    this.end(kit);
    this.view?.dispose();
    this.view = null;
  },
};
