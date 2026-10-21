import * as THREE from '../vendor/three.module.js';
import { decodeMapEvents } from '../../../shared/conquest-map-events.js';
import { DAM_TUNING } from '../../../shared/map-events/dam.js';
import { buildChargeModel, chargeLedOn, disposeChargeModel } from './charge-model.js';

// The planted charges in the world (design docs/design/interact-anims/,
// reference B): the S&D bomb where it was planted (or dropped, unlit) and the
// Conquest map-event charges (the Redrock dam's armed charges from the event's
// mask, any other event's `charge` points while it is armed). The LED is
// team-neutral red and blinks faster as the known fuse runs down
// (chargeBlink). Presentation only: where and whether is the snapshot's.

/**
 * The charges a match view shows: [{key, x, y, z, big, armed, leftMs}].
 * `match` is the snapshot match (mode, bomb, conquest.ev), `serverNow` the
 * server clock (ms) for the S&D fuse.
 */
export function plantedCharges(match, mapId, serverNow = null, defs = undefined, decoded = null) {
  const out = [];
  const bomb = match?.mode === 'snd' ? match.bomb : null;
  if (bomb && ['planted', 'dropped', 'defused'].includes(bomb.state) && [bomb.x, bomb.y, bomb.z].every(Number.isFinite)) {
    const armed = bomb.state === 'planted';
    out.push({ key: 'snd-bomb', x: bomb.x, y: bomb.y, z: bomb.z, big: true, armed,
      leftMs: armed && Number.isFinite(bomb.explodeAt) && Number.isFinite(serverNow) ? Math.max(0, bomb.explodeAt - serverNow) : null });
  }
  const ev = match?.conquest?.ev ?? null;
  if (ev && mapId) {
    // `decoded` (optional) memoizes the decode on the `ev` array: snapshots replace it only when it changes.
    let events = decoded?.ev === ev && decoded.mapId === mapId ? decoded.events : null;
    if (!events) {
      events = decodeMapEvents(ev, null, mapId, defs).events;
      if (decoded) Object.assign(decoded, { ev, mapId, events });
    }
    for (const event of events) {
      if (event.phase !== 'armed' && event.phase !== 'warning') continue;
      const leftMs = event.phase === 'warning' ? 0 : event.leftMs;
      if (event.def.id === 'dam') {
        const mask = Number(event.extra?.[0]) | 0;
        DAM_TUNING.charges.forEach((c, i) => {
          if (mask & (1 << i)) out.push({ key: `dam:${c.id}`, x: c.x, y: c.y, z: c.z, big: false, armed: true, leftMs });
        });
        continue;
      }
      for (const p of event.def.points) {
        if (p.glyph !== 'charge' || /DEFUSE/.test(p.verb)) continue;
        out.push({ key: `${event.def.id}:${p.id}`, x: p.x, y: p.y, z: p.z, big: false, armed: true, leftMs });
      }
    }
  }
  return out;
}

let haloTexture = null;
function halo() {
  if (haloTexture || !globalThis.document?.createElement) return haloTexture;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 32;
  const c = canvas.getContext('2d');
  if (!c) return null;
  const g = c.createRadialGradient(16, 16, 0, 16, 16, 16);
  g.addColorStop(0, 'rgba(255,90,70,1)'); g.addColorStop(0.35, 'rgba(255,40,25,0.45)'); g.addColorStop(1, 'rgba(255,20,10,0)');
  c.fillStyle = g; c.fillRect(0, 0, 32, 32);
  haloTexture = new THREE.CanvasTexture(canvas);
  return haloTexture;
}

export class InteractProps {
  constructor({ scene }) {
    this.group = new THREE.Group();
    this.group.name = 'interact-props';
    scene?.add(this.group);
    this.items = new Map();
    this._decoded = { ev: null, mapId: null, events: [] };
    this._haloMaterial = new THREE.SpriteMaterial({ map: halo(), color: 0xffffff, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, toneMapped: false });
  }

  _make(spec) {
    const model = buildChargeModel({ big: spec.big, name: `charge-${spec.key}` });
    model.root.position.set(spec.x, spec.y, spec.z);
    // A stable, seeded yaw so a charge never spins between snapshots.
    let h = 0; for (const ch of spec.key) h = (h * 31 + ch.charCodeAt(0)) | 0;
    model.root.rotation.y = ((h >>> 0) % 628) / 100;
    model.halo = new THREE.Sprite(this._haloMaterial.clone());
    model.halo.scale.setScalar(spec.big ? 0.42 : 0.32);
    model.halo.position.copy(model.led.position);
    model.root.add(model.halo);
    this.group.add(model.root);
    return model;
  }

  /** One frame: `match` the snapshot match, `serverNow` the server clock (ms), `nowMs` the blink clock. */
  update({ match = null, mapId = null, serverNow = null, nowMs = 0 } = {}) {
    const want = plantedCharges(match, mapId, serverNow, undefined, this._decoded);
    const keep = new Set();
    for (const spec of want) {
      keep.add(spec.key);
      let model = this.items.get(spec.key);
      if (!model) { model = this._make(spec); this.items.set(spec.key, model); }
      model.root.position.set(spec.x, spec.y, spec.z);
      const lit = spec.armed && chargeLedOn(nowMs, spec.leftMs);
      model.setLed(lit, 1);
      model.halo.visible = lit;
    }
    for (const [key, model] of this.items) {
      if (keep.has(key)) continue;
      model.halo.material.dispose();
      disposeChargeModel(model);
      this.items.delete(key);
    }
    return want.length;
  }

  clear() {
    for (const model of this.items.values()) { model.halo.material.dispose(); disposeChargeModel(model); }
    this.items.clear();
    this.group.removeFromParent();
    this._haloMaterial.dispose();
  }
}
