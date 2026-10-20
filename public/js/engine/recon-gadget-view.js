// World view of the Conquest Recon gadgets (docs/conquest.md "Recon gadgets"):
// laid SPAWN BEACONS and settled MOTION SENSORS drawn where the authority
// says they are (match.conquest.recon, decoded by shared/recon-gadgets.js).
// Everyone sees every gadget in the world (they are physical objects); the
// lamp is team-relative: cyan for the viewer's team, red for the enemy. A
// beacon's lamp blinks while it is ready and stays dim while it cools down.
// The same models serve the in-flight sensor and the beacon placement ghost
// (public/js/weapons/projectiles.js) through buildReconGadgetModel.
import * as THREE from '../vendor/three.module.js';
import { decodeReconGadgets } from '../../../shared/recon-gadgets.js';

const OWN_LAMP = 0x58e6ff, ENEMY_LAMP = 0xff4b4b;
const BLINK_HZ = 1.4;

let shared = null;
/** Geometries and body materials shared by every model (never disposed per instance). */
function parts() {
  if (shared) return shared;
  const body = new THREE.MeshStandardMaterial({ color: 0x4a535c, roughness: 0.6, metalness: 0.35 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x1f262c, roughness: 0.75, metalness: 0.2 });
  const steel = new THREE.MeshStandardMaterial({ color: 0xa9b6c0, roughness: 0.3, metalness: 0.8 });
  shared = {
    body, dark, steel,
    caseGeometry: new THREE.BoxGeometry(0.34, 0.2, 0.24),
    panelGeometry: new THREE.BoxGeometry(0.26, 0.05, 0.01),
    footGeometry: new THREE.BoxGeometry(0.4, 0.03, 0.3),
    mastGeometry: new THREE.CylinderGeometry(0.012, 0.016, 0.52, 6),
    lampGeometry: new THREE.SphereGeometry(0.04, 10, 8),
    puckGeometry: new THREE.CylinderGeometry(0.12, 0.13, 0.07, 14),
    lensGeometry: new THREE.CylinderGeometry(0.045, 0.045, 0.02, 12),
  };
  return shared;
}

/**
 * A beacon (feet at the group origin: case, mast, lamp) or a sensor (puck and
 * lens). `lamp` is the instance's own lamp material (the caller disposes it).
 */
export function buildReconGadgetModel(kind, lampColor = OWN_LAMP) {
  const p = parts();
  const group = new THREE.Group();
  group.name = `recon-${kind}`;
  const lamp = new THREE.MeshBasicMaterial({ color: lampColor, toneMapped: false });
  if (kind === 'beacon') {
    const foot = new THREE.Mesh(p.footGeometry, p.dark); foot.position.y = 0.015;
    const box = new THREE.Mesh(p.caseGeometry, p.body); box.position.y = 0.13;
    const panel = new THREE.Mesh(p.panelGeometry, p.dark); panel.position.set(0, 0.15, 0.121);
    const mast = new THREE.Mesh(p.mastGeometry, p.steel); mast.position.set(0.1, 0.49, 0);
    const bulb = new THREE.Mesh(p.lampGeometry, lamp); bulb.position.set(0.1, 0.77, 0);
    group.add(foot, box, panel, mast, bulb);
  } else {
    const puck = new THREE.Mesh(p.puckGeometry, p.body); puck.position.y = 0.035;
    const lens = new THREE.Mesh(p.lensGeometry, lamp); lens.position.y = 0.075;
    group.add(puck, lens);
  }
  return { group, lamp, disposables: [] };
}

export class ReconGadgetView {
  constructor(scene) {
    this.group = new THREE.Group();
    this.group.name = 'recon-gadgets';
    this.views = new Map();
    this.viewerTeam = null;
    this.time = 0;
    this.disposed = false;
    scene?.add(this.group);
  }

  setViewerTeam(team) {
    this.viewerTeam = team === 'alpha' || team === 'bravo' ? team : null;
    for (const view of this.views.values()) view.lamp.color.setHex(this._lampColor(view.team));
  }

  _lampColor(team) {
    return !this.viewerTeam || team === this.viewerTeam ? OWN_LAMP : ENEMY_LAMP;
  }

  /** Raw `match.conquest.recon` or its decoded form; a missing block clears every gadget. */
  sync(recon) {
    if (this.disposed) return;
    const decoded = recon && Array.isArray(recon.beacons) ? recon : decodeReconGadgets(recon);
    const seen = new Set();
    for (const g of [...decoded.beacons, ...decoded.sensors]) {
      if (![g.x, g.y, g.z].every(Number.isFinite)) continue;
      seen.add(g.id);
      let view = this.views.get(g.id);
      if (!view) {
        const built = buildReconGadgetModel(g.kind, this._lampColor(g.team));
        view = { ...built, kind: g.kind, team: g.team, phase: this.views.size * 0.37 };
        this.views.set(g.id, view);
        this.group.add(view.group);
      }
      if (view.team !== g.team) { view.team = g.team; view.lamp.color.setHex(this._lampColor(g.team)); }
      view.group.position.set(g.x, g.y, g.z);
      view.cooling = g.kind === 'beacon' && g.cooldownMs > 0;
    }
    for (const [id, view] of this.views) {
      if (seen.has(id)) continue;
      this.group.remove(view.group);
      view.lamp.dispose();
      this.views.delete(id);
    }
  }

  /** Blink the lamps. */
  update(dt = 0) {
    if (this.disposed) return;
    this.time += Math.max(0, Number(dt) || 0);
    for (const view of this.views.values()) {
      const on = view.kind === 'sensor' || (!view.cooling && Math.sin((this.time * BLINK_HZ + view.phase) * Math.PI * 2) > -0.2);
      view.group.children.at(-1).visible = on || view.cooling;
      view.lamp.opacity = 1;
      if (view.cooling) view.lamp.color.setHex(this._lampColor(view.team)).multiplyScalar(0.35);
      else view.lamp.color.setHex(this._lampColor(view.team));
    }
  }

  get count() { return this.views.size; }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const view of this.views.values()) view.lamp.dispose();
    this.views.clear();
    this.group.removeFromParent();
    this.group.clear();
  }
}
