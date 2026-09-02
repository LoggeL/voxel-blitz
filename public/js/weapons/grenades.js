import * as THREE from '../vendor/three.module.js';
import {
  GRENADE_FUSE_MS,
  predictGrenadePath,
  stepGrenade,
} from '../../../shared/grenade-rules.js';

/** Unconfirmed local throws are dropped after this long without a matching authority event. */
const LOCAL_CONFIRM_TIMEOUT_S = 1.0;
const PREVIEW_MAX_POINTS = 96;
const CAP_LIT = 0xffd27a;
const CAP_DIM = 0xff5a1c;

/**
 * Predicted presentation for grenade throws and explosions.
 *
 * Projectiles come from authoritative `grenadeThrow` events, but the local player's own
 * throw is spawned immediately (`throw(event, {local:true})`) and later *adopted* by the
 * matching authority event (`{fromSelf:true}`) so the grenade never pops or double-spawns.
 * The charge preview draws the same shared integrator's path so what you see is what
 * the server will fly.
 */
export class GrenadeFX {
  constructor(scene, getBlock = () => 0) {
    this.scene = scene;
    this.getBlock = getBlock;
    this.projectiles = new Map();
    this.blasts = [];
    this._localSeq = 0;
    this.isSolid = (x, y, z) => this.getBlock(Math.floor(x), Math.floor(y), Math.floor(z)) !== 0;

    this.bodyGeometry = new THREE.BoxGeometry(0.26, 0.26, 0.26);
    this.capGeometry = new THREE.BoxGeometry(0.1, 0.08, 0.13);
    this.blastGeometry = new THREE.IcosahedronGeometry(1, 2);
    this.bodyMaterial = new THREE.MeshStandardMaterial({
      color: 0x20242a,
      roughness: 0.48,
      metalness: 0.78,
    });

    // Charge preview: dotted arc plus a landing ring, both hidden until the first hold.
    this.previewPositions = new Float32Array(PREVIEW_MAX_POINTS * 3);
    const previewGeometry = new THREE.BufferGeometry();
    previewGeometry.setAttribute('position', new THREE.BufferAttribute(this.previewPositions, 3));
    previewGeometry.setDrawRange(0, 0);
    this.previewMaterial = new THREE.LineDashedMaterial({
      color: 0xffb347,
      transparent: true,
      opacity: 0.85,
      dashSize: 0.22,
      gapSize: 0.16,
      depthWrite: false,
      toneMapped: false,
    });
    this.previewLine = new THREE.Line(previewGeometry, this.previewMaterial);
    this.previewLine.frustumCulled = false;
    this.previewLine.renderOrder = 8;
    this.previewLine.visible = false;
    this.landingMaterial = new THREE.MeshBasicMaterial({
      color: 0xffb347,
      transparent: true,
      opacity: 0.7,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    this.landingRing = new THREE.Mesh(new THREE.RingGeometry(0.28, 0.42, 24), this.landingMaterial);
    this.landingRing.rotation.x = -Math.PI / 2;
    this.landingRing.renderOrder = 8;
    this.landingRing.visible = false;
    this.scene.add(this.previewLine, this.landingRing);
    this.preview = null;
  }

  /**
   * Spawn a projectile. `local:true` creates an unconfirmed prediction; `fromSelf:true`
   * marks an authority event that should adopt the oldest pending local projectile.
   */
  throw(event, { local = false, fromSelf = false } = {}) {
    if (!event || !Array.isArray(event.o) || !Array.isArray(event.v)) return false;
    const values = [...event.o, ...event.v].map(Number);
    if (!values.every(Number.isFinite)) return false;
    const fuse = Math.max(0.3, (Number(event.fuse) || GRENADE_FUSE_MS) / 1000);

    if (!local) {
      if (!event.gid || this.projectiles.has(String(event.gid))) return false;
      if (fromSelf && this._adoptLocal(String(event.gid), values, fuse)) return true;
    }
    const id = local ? `local-${++this._localSeq}` : String(event.gid);

    const group = new THREE.Group();
    const body = new THREE.Mesh(this.bodyGeometry, this.bodyMaterial);
    body.rotation.set(0.35, 0.45, 0.12);
    const capMaterial = new THREE.MeshBasicMaterial({ color: CAP_LIT, toneMapped: false });
    const cap = new THREE.Mesh(this.capGeometry, capMaterial);
    cap.position.set(0, 0.17, 0);
    group.add(body, cap);
    group.position.set(values[0], values[1], values[2]);
    this.scene.add(group);
    this.projectiles.set(id, {
      id,
      group,
      capMaterial,
      x: values[0], y: values[1], z: values[2],
      vx: values[3], vy: values[4], vz: values[5],
      age: 0,
      fuse,
      local,
    });
    return true;
  }

  /** Number of local throws still waiting for their authority event. */
  get pendingLocal() {
    let count = 0;
    for (const grenade of this.projectiles.values()) if (grenade.local) count++;
    return count;
  }

  _adoptLocal(gid, values, fuse) {
    let oldest = null;
    for (const grenade of this.projectiles.values()) {
      if (grenade.local && (!oldest || grenade.age > oldest.age)) oldest = grenade;
    }
    if (!oldest) return false;
    this.projectiles.delete(oldest.id);
    oldest.id = gid;
    oldest.local = false;
    // Authority and prediction share the integrator, so the states are near-identical;
    // snapping the velocity while keeping the rendered position avoids a visible hop.
    oldest.vx = values[3]; oldest.vy = values[4]; oldest.vz = values[5];
    const drift = Math.hypot(oldest.x - values[0], oldest.y - values[1], oldest.z - values[2]);
    if (drift > 0.6) {
      oldest.x = values[0]; oldest.y = values[1]; oldest.z = values[2];
      oldest.group.position.set(values[0], values[1], values[2]);
    }
    oldest.fuse = fuse + oldest.age;
    this.projectiles.set(gid, oldest);
    return true;
  }

  /**
   * Draw (or hide with `null`) the predicted flight for a launch state
   * `{x,y,z,vx,vy,vz}`. Returns the prediction so HUD/audio glue can read the landing.
   */
  setPreview(launch) {
    if (!launch) {
      if (this.preview) {
        this.preview = null;
        this.previewLine.visible = false;
        this.landingRing.visible = false;
      }
      return null;
    }
    const prediction = predictGrenadePath(launch, this.isSolid, { maxPoints: PREVIEW_MAX_POINTS });
    const count = Math.min(PREVIEW_MAX_POINTS, prediction.points.length);
    for (let i = 0; i < count; i++) {
      const p = prediction.points[i];
      this.previewPositions[i * 3] = p[0];
      this.previewPositions[i * 3 + 1] = p[1];
      this.previewPositions[i * 3 + 2] = p[2];
    }
    const geometry = this.previewLine.geometry;
    geometry.attributes.position.needsUpdate = true;
    geometry.setDrawRange(0, count);
    this.previewLine.computeLineDistances();
    this.previewLine.visible = count > 1;
    const landing = prediction.landing;
    this.landingRing.position.set(landing[0], landing[1] - 0.12, landing[2]);
    this.landingRing.visible = true;
    this.landingMaterial.opacity = prediction.rests ? 0.75 : 0.35;
    this.preview = prediction;
    return prediction;
  }

  explode(event) {
    const id = String(event?.gid || '');
    this._removeProjectile(id);
    const x = Number(event?.x), y = Number(event?.y), z = Number(event?.z);
    if (![x, y, z].every(Number.isFinite)) return false;
    const material = new THREE.MeshBasicMaterial({
      color: 0xff9f1c,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    const mesh = new THREE.Mesh(this.blastGeometry, material);
    mesh.position.set(x, y, z);
    mesh.scale.setScalar(0.08);
    mesh.renderOrder = 9;
    this.scene.add(mesh);
    this.blasts.push({ mesh, material, age: 0, life: 0.42, radius: Number(event.radius) || 5.6 });
    return true;
  }

  update(dt) {
    const step = Math.max(0, Math.min(0.05, Number(dt) || 0));
    for (const [id, grenade] of this.projectiles) {
      grenade.age += step;
      stepGrenade(grenade, step, this.isSolid);
      grenade.group.position.set(grenade.x, grenade.y, grenade.z);
      const spin = Math.min(1, Math.hypot(grenade.vx, grenade.vy, grenade.vz) / 6);
      grenade.group.rotation.x += step * 7.4 * spin;
      grenade.group.rotation.z += step * 5.2 * spin;
      // Fuse indicator: the cap strobes faster as detonation approaches.
      const remaining = Math.max(0, grenade.fuse - grenade.age);
      const rate = remaining < 0.7 ? 16 : remaining < 1.4 ? 8 : 4;
      grenade.capMaterial.color.setHex(Math.sin(grenade.age * rate * Math.PI) > 0 ? CAP_LIT : CAP_DIM);
      if (grenade.local && grenade.age > LOCAL_CONFIRM_TIMEOUT_S) this._removeProjectile(id);
      else if (grenade.age > grenade.fuse + 1) this._removeProjectile(id);
    }

    for (let index = this.blasts.length - 1; index >= 0; index--) {
      const blast = this.blasts[index];
      blast.age += step;
      const t = Math.min(1, blast.age / blast.life);
      const eased = 1 - Math.pow(1 - t, 3);
      blast.mesh.scale.setScalar(0.08 + blast.radius * 0.38 * eased);
      blast.material.opacity = Math.max(0, (1 - t) * (1 - t) * 0.9);
      if (t >= 1) {
        this.scene.remove(blast.mesh);
        blast.material.dispose();
        this.blasts.splice(index, 1);
      }
    }
  }

  _removeProjectile(id) {
    const grenade = this.projectiles.get(id);
    if (!grenade) return false;
    this.scene.remove(grenade.group);
    grenade.capMaterial.dispose();
    this.projectiles.delete(id);
    return true;
  }

  dispose() {
    for (const id of Array.from(this.projectiles.keys())) this._removeProjectile(id);
    for (const blast of this.blasts) {
      this.scene.remove(blast.mesh);
      blast.material.dispose();
    }
    this.blasts.length = 0;
    this.scene.remove(this.previewLine, this.landingRing);
    this.previewLine.geometry.dispose();
    this.previewMaterial.dispose();
    this.landingRing.geometry.dispose();
    this.landingMaterial.dispose();
    this.bodyGeometry.dispose();
    this.capGeometry.dispose();
    this.blastGeometry.dispose();
    this.bodyMaterial.dispose();
  }
}
