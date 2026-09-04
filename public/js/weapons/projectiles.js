import * as THREE from '../vendor/three.module.js';
import {
  GRENADE_TYPES,
  predictGrenadePath,
  stepGrenade,
} from '../../../shared/grenade-rules.js';
import { ROCKET_RULES, stepRocket } from '../../../shared/rocket-rules.js';
import { BOLT_RULES, boltBounces, stepBolt } from '../../../shared/bolt-rules.js';
import { raycastVoxels } from '../../../shared/raycast.js';

/** Unconfirmed local launches are dropped after this long without a matching authority event. */
const LOCAL_CONFIRM_TIMEOUT_S = 1.0;
const PREVIEW_MAX_POINTS = 96;
const CAP_LIT = 0xffd27a;
const CAP_DIM = 0xff5a1c;
const ROCKET_TRAIL_INTERVAL_S = 0.028;

/** Blast presentation per projectile type: colour, growth, and life of the flash sphere. */
const BLAST_STYLE = Object.freeze({
  frag: Object.freeze({ color: 0xff9f1c, grow: 0.38, life: 0.42, ring: false }),
  limpet: Object.freeze({ color: 0xffd9a8, grow: 0.46, life: 0.5, ring: true, ringColor: 0xff5a3c }),
  pulse: Object.freeze({ color: 0x59e8ff, grow: 0.16, life: 0.32, ring: true, ringColor: 0x9ff4ff }),
  bolt: Object.freeze({ color: 0x7dfcff, grow: 0.16, life: 0.28, ring: false }),
  rocket: Object.freeze({ color: 0xffb347, grow: 0.5, life: 0.55, ring: true, ringColor: 0xff7a1c }),
});

function styleFor(type) {
  return BLAST_STYLE[type] || BLAST_STYLE.frag;
}

/**
 * Predicted presentation for every thrown or launched explosive: frag/limpet/pulse
 * grenades, the rocket, and the LONGARC bolt. Authority `projectileLaunch` events own the truth, but the local
 * player's own launch is spawned immediately (`launch(event, {local:true})`) and later
 * *adopted* by the matching authority event (`{fromSelf:true}`) so nothing pops or doubles.
 * The charge preview draws the same shared integrator's path per grenade type.
 */
export class ProjectileFX {
  constructor(scene, getBlock = () => 0, { getEntityPosition = null, onTrail = null, onBounce = null } = {}) {
    this.scene = scene;
    this.getBlock = getBlock;
    this.getEntityPosition = typeof getEntityPosition === 'function' ? getEntityPosition : null;
    this.onTrail = typeof onTrail === 'function' ? onTrail : null;
    this.onBounce = typeof onBounce === 'function' ? onBounce : null;
    this.projectiles = new Map();
    this.blasts = [];
    this._localSeq = 0;
    this.isSolid = (x, y, z) => this.getBlock(Math.floor(x), Math.floor(y), Math.floor(z)) !== 0;
    this.raycast = (ox, oy, oz, dx, dy, dz, max) => raycastVoxels(
      (x, y, z) => this.getBlock(x, y, z) !== 0, ox, oy, oz, dx, dy, dz, max,
    );

    this.fragGeometry = new THREE.BoxGeometry(0.26, 0.26, 0.26);
    this.capGeometry = new THREE.BoxGeometry(0.1, 0.08, 0.13);
    this.limpetGeometry = new THREE.CylinderGeometry(0.17, 0.17, 0.09, 10);
    this.pulseGeometry = new THREE.IcosahedronGeometry(0.17, 1);
    this.rocketBodyGeometry = new THREE.CylinderGeometry(0.075, 0.075, 0.52, 10);
    this.rocketBodyGeometry.rotateX(Math.PI / 2);
    this.rocketNoseGeometry = new THREE.ConeGeometry(0.075, 0.18, 10);
    this.rocketNoseGeometry.rotateX(-Math.PI / 2);
    this.exhaustGeometry = new THREE.ConeGeometry(0.11, 0.42, 8, 1, true);
    this.exhaustGeometry.rotateX(Math.PI / 2);
    this.blastGeometry = new THREE.IcosahedronGeometry(1, 2);
    this.ringGeometry = new THREE.TorusGeometry(1, 0.06, 6, 40);
    this.fragMaterial = new THREE.MeshStandardMaterial({
      color: 0x20242a, roughness: 0.48, metalness: 0.78,
    });
    this.limpetMaterial = new THREE.MeshStandardMaterial({
      color: 0x3b2a22, roughness: 0.6, metalness: 0.55,
    });
    this.pulseMaterial = new THREE.MeshStandardMaterial({
      color: 0x0f2a33, roughness: 0.3, metalness: 0.85,
      emissive: 0x59e8ff, emissiveIntensity: 0.9,
    });
    this.rocketMaterial = new THREE.MeshStandardMaterial({
      color: 0x4a4f57, roughness: 0.55, metalness: 0.7,
    });
    this.rocketNoseMaterial = new THREE.MeshStandardMaterial({
      color: 0xff6f1c, roughness: 0.5, metalness: 0.4,
    });
    this.exhaustMaterial = new THREE.MeshBasicMaterial({
      color: 0xffb347, transparent: true, opacity: 0.85,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
      side: THREE.DoubleSide,
    });
    this.boltCoreMaterial = new THREE.MeshStandardMaterial({
      color: 0x0f2a33, roughness: 0.3, metalness: 0.85,
      emissive: 0x7dfcff, emissiveIntensity: 1.2,
    });
    this.boltGlowMaterial = new THREE.MeshBasicMaterial({
      color: 0x7dfcff, transparent: true, opacity: 0.35, toneMapped: false,
      blending: THREE.AdditiveBlending, depthWrite: false,
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
    this._previewType = '';
  }

  _buildVisual(type) {
    const group = new THREE.Group();
    let capMaterial = null;
    if (type === 'rocket') {
      const body = new THREE.Mesh(this.rocketBodyGeometry, this.rocketMaterial);
      const nose = new THREE.Mesh(this.rocketNoseGeometry, this.rocketNoseMaterial);
      nose.position.z = -0.35;
      const exhaust = new THREE.Mesh(this.exhaustGeometry, this.exhaustMaterial);
      exhaust.position.z = 0.45;
      const light = new THREE.PointLight(0xffa040, 1.6, 7);
      light.position.z = 0.3;
      group.add(body, nose, exhaust, light);
      group.userData.exhaust = exhaust;
      group.userData.light = light;
    } else if (type === 'limpet') {
      const disc = new THREE.Mesh(this.limpetGeometry, this.limpetMaterial);
      capMaterial = new THREE.MeshBasicMaterial({ color: 0xff5a3c, toneMapped: false });
      const led = new THREE.Mesh(this.capGeometry, capMaterial);
      led.scale.set(0.7, 0.7, 0.7);
      led.position.set(0, 0.07, 0);
      group.add(disc, led);
    } else if (type === 'pulse') {
      const core = new THREE.Mesh(this.pulseGeometry, this.pulseMaterial);
      capMaterial = new THREE.MeshBasicMaterial({
        color: 0x9ff4ff, transparent: true, opacity: 0.5, toneMapped: false,
        blending: THREE.AdditiveBlending, depthWrite: false,
      });
      const halo = new THREE.Mesh(this.pulseGeometry, capMaterial);
      halo.scale.setScalar(1.55);
      const light = new THREE.PointLight(0x59e8ff, 0.9, 5);
      group.add(core, halo, light);
      group.userData.halo = halo;
    } else if (type === 'bolt') {
      // Coilgun bolt: thin emissive core, additive glow shell, cyan light.
      const core = new THREE.Mesh(this.capGeometry, this.boltCoreMaterial);
      core.scale.set(0.7, 0.7, 2.6);
      const glow = new THREE.Mesh(this.pulseGeometry, this.boltGlowMaterial);
      glow.scale.setScalar(1.1);
      const light = new THREE.PointLight(0x7dfcff, 1.0, 4);
      group.add(core, glow, light);
    } else {
      const body = new THREE.Mesh(this.fragGeometry, this.fragMaterial);
      body.rotation.set(0.35, 0.45, 0.12);
      capMaterial = new THREE.MeshBasicMaterial({ color: CAP_LIT, toneMapped: false });
      const cap = new THREE.Mesh(this.capGeometry, capMaterial);
      cap.position.set(0, 0.17, 0);
      group.add(body, cap);
    }
    return { group, capMaterial };
  }

  /**
   * Spawn a projectile from a `projectileLaunch`-shaped event `{pid?,type,o,v,fuse}`.
   * `local:true` creates an unconfirmed prediction; `fromSelf:true` marks an authority event
   * that should adopt the oldest pending local projectile of the same type.
   */
  launch(event, { local = false, fromSelf = false } = {}) {
    if (!event || !Array.isArray(event.o) || !Array.isArray(event.v)) return false;
    const values = [...event.o, ...event.v].map(Number);
    if (!values.every(Number.isFinite)) return false;
    const type = event.type === 'rocket' || event.type === 'bolt' || GRENADE_TYPES[event.type]
      ? event.type
      : 'frag';
    const fallbackFuse = type === 'rocket'
      ? ROCKET_RULES.lifetimeMs
      : type === 'bolt' ? BOLT_RULES.lifetimeMs : GRENADE_TYPES[type].fuseMs;
    const fuseMs = Number(event.fuse);
    const fuse = Math.max(0.05, (Number.isFinite(fuseMs) && fuseMs > 0 ? fuseMs : fallbackFuse) / 1000);
    // Reflection budget: authority events carry `bn`; local spawns may pass `charge`.
    const bn = Number(event.bn);
    const bouncesLeft = type === 'bolt'
      ? Number.isFinite(bn) ? Math.max(0, Math.floor(bn)) : boltBounces(Number(event.charge ?? 1))
      : 0;

    if (!local) {
      if (!event.pid || this.projectiles.has(String(event.pid))) return false;
      if (fromSelf && this._adoptLocal(String(event.pid), type, values, fuse)) return true;
    }
    const id = local ? `local-${++this._localSeq}` : String(event.pid);
    const { group, capMaterial } = this._buildVisual(type);
    group.position.set(values[0], values[1], values[2]);
    this.scene.add(group);
    this.projectiles.set(id, {
      id,
      type,
      group,
      capMaterial,
      x: values[0], y: values[1], z: values[2],
      vx: values[3], vy: values[4], vz: values[5],
      age: 0,
      fuse,
      bouncesLeft,
      local,
      stuck: false,
      stuckTo: null,
      stickOffset: null,
      trailAt: 0,
    });
    if (type === 'rocket' || type === 'bolt') this._orientRocket(this.projectiles.get(id));
    return true;
  }

  /** Legacy alias for the frag-only API. */
  throw(event, options) {
    return this.launch({ type: 'frag', ...event, pid: event?.pid ?? event?.gid }, options);
  }

  /** Number of local launches still waiting for their authority event. */
  get pendingLocal() {
    let count = 0;
    for (const projectile of this.projectiles.values()) if (projectile.local) count++;
    return count;
  }

  _adoptLocal(pid, type, values, fuse) {
    let oldest = null;
    for (const projectile of this.projectiles.values()) {
      if (projectile.local && projectile.type === type && (!oldest || projectile.age > oldest.age)) {
        oldest = projectile;
      }
    }
    if (!oldest) return false;
    this.projectiles.delete(oldest.id);
    oldest.id = pid;
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
    this.projectiles.set(pid, oldest);
    return true;
  }

  /** A limpet stuck to terrain or to a player (`to`); it now rides that carrier. */
  stick(event) {
    const projectile = this.projectiles.get(String(event?.pid || ''));
    if (!projectile) return false;
    const x = Number(event.x), y = Number(event.y), z = Number(event.z);
    if ([x, y, z].every(Number.isFinite)) {
      projectile.x = x; projectile.y = y; projectile.z = z;
    }
    projectile.vx = projectile.vy = projectile.vz = 0;
    projectile.stuck = true;
    projectile.stuckTo = event.to ? String(event.to) : null;
    if (projectile.stuckTo && this.getEntityPosition) {
      const carrier = this.getEntityPosition(projectile.stuckTo);
      if (carrier) {
        projectile.stickOffset = {
          x: projectile.x - carrier.x,
          y: Math.max(0.3, Math.min(1.6, projectile.y - carrier.y)),
          z: projectile.z - carrier.z,
        };
      }
    }
    const fuseMs = Number(event.fuse);
    if (Number.isFinite(fuseMs) && fuseMs > 0) projectile.fuse = projectile.age + fuseMs / 1000;
    projectile.group.position.set(projectile.x, projectile.y, projectile.z);
    return true;
  }

  /**
   * Draw (or hide with `null`) the predicted flight for a launch state
   * `{type?,x,y,z,vx,vy,vz}`. Returns the prediction so HUD/audio glue can read the landing.
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
    const type = GRENADE_TYPES[launch.type] ? launch.type : 'frag';
    if (type !== this._previewType) {
      this._previewType = type;
      const color = new THREE.Color(GRENADE_TYPES[type].color);
      this.previewMaterial.color.copy(color);
      this.landingMaterial.color.copy(color);
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
    const id = String(event?.pid || event?.gid || '');
    const existing = this.projectiles.get(id);
    const type = event?.type || existing?.type || 'frag';
    this._removeProjectile(id);
    const x = Number(event?.x), y = Number(event?.y), z = Number(event?.z);
    if (![x, y, z].every(Number.isFinite)) return false;
    const style = styleFor(type);
    this._spawnBlast(x, y, z, style, Number(event.radius) || style.grow * 12);
    return true;
  }

  /** One additive flash sphere (plus optional ring) at a world point. */
  _spawnBlast(x, y, z, style, radius) {
    const material = new THREE.MeshBasicMaterial({
      color: style.color,
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
    const blast = { mesh, material, age: 0, life: style.life, radius, grow: style.grow, ring: null };
    if (style.ring) {
      const ringMaterial = new THREE.MeshBasicMaterial({
        color: style.ringColor,
        transparent: true,
        opacity: 0.8,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
      });
      const ring = new THREE.Mesh(this.ringGeometry, ringMaterial);
      ring.position.set(x, y + 0.15, z);
      ring.rotation.x = Math.PI / 2;
      ring.scale.setScalar(0.1);
      ring.renderOrder = 9;
      this.scene.add(ring);
      blast.ring = { mesh: ring, material: ringMaterial };
    }
    this.blasts.push(blast);
  }

  _orientRocket(projectile) {
    const speed = Math.hypot(projectile.vx, projectile.vy, projectile.vz);
    if (speed < 1e-6) return;
    const target = new THREE.Vector3(
      projectile.x + projectile.vx / speed,
      projectile.y + projectile.vy / speed,
      projectile.z + projectile.vz / speed,
    );
    projectile.group.lookAt(target);
    // lookAt aims +z at the target; the model's nose points -z, so flip.
    projectile.group.rotateY(Math.PI);
  }

  update(dt) {
    const step = Math.max(0, Math.min(0.05, Number(dt) || 0));
    for (const [id, projectile] of this.projectiles) {
      projectile.age += step;
      if (projectile.stuckTo && this.getEntityPosition) {
        const carrier = this.getEntityPosition(projectile.stuckTo);
        if (carrier && projectile.stickOffset) {
          projectile.x = carrier.x + projectile.stickOffset.x;
          projectile.y = carrier.y + projectile.stickOffset.y;
          projectile.z = carrier.z + projectile.stickOffset.z;
        }
      } else if (projectile.type === 'rocket') {
        stepRocket(projectile, step, this.raycast);
        this._orientRocket(projectile);
        const flicker = 0.8 + Math.sin(projectile.age * 90) * 0.2;
        projectile.group.userData.exhaust.scale.set(flicker, flicker, 0.8 + flicker * 0.4);
        projectile.group.userData.light.intensity = 1.2 + flicker * 0.8;
        if (this.onTrail && projectile.age - projectile.trailAt >= ROCKET_TRAIL_INTERVAL_S) {
          projectile.trailAt = projectile.age;
          this.onTrail(projectile.x, projectile.y, projectile.z, projectile);
        }
        if (projectile.hit && !projectile.local) projectile.fuse = Math.min(projectile.fuse, projectile.age + 0.25);
      } else if (projectile.type === 'bolt') {
        stepBolt(projectile, step, this.raycast);
        this._orientRocket(projectile);
        // Reflections are client-derived: the shared integrator flags each contact.
        if (projectile.bounced) {
          const contact = projectile.bounced;
          this._spawnBlast(contact.x, contact.y, contact.z, BLAST_STYLE.bolt, 0.6);
          this.onBounce?.(contact.x, contact.y, contact.z);
        }
        // Authority owns bolt death (projectileExplode); the local view just keeps flying.
        if (projectile.hit && !projectile.local) {
          projectile.fuse = Math.min(projectile.fuse, projectile.age + 0.25);
        }
      } else if (!projectile.stuck) {
        stepGrenade(projectile, step, this.isSolid);
        const type = GRENADE_TYPES[projectile.type];
        if (type.sticky && projectile.hitSolid) projectile.stuck = true;
        const spin = Math.min(1, Math.hypot(projectile.vx, projectile.vy, projectile.vz) / 6);
        projectile.group.rotation.x += step * 7.4 * spin;
        projectile.group.rotation.z += step * 5.2 * spin;
      }
      projectile.group.position.set(projectile.x, projectile.y, projectile.z);
      if (projectile.capMaterial) {
        // Fuse indicator: the cap strobes faster as detonation approaches.
        const remaining = Math.max(0, projectile.fuse - projectile.age);
        const rate = remaining < 0.7 ? 16 : remaining < 1.4 ? 8 : 4;
        const lit = Math.sin(projectile.age * rate * Math.PI) > 0;
        if (projectile.type === 'pulse') {
          projectile.capMaterial.opacity = lit ? 0.6 : 0.25;
          projectile.group.userData.halo.scale.setScalar(1.4 + Math.sin(projectile.age * 14) * 0.2);
        } else if (projectile.type === 'limpet') {
          projectile.capMaterial.color.setHex(lit ? 0xff5a3c : 0x3a0f08);
        } else {
          projectile.capMaterial.color.setHex(lit ? CAP_LIT : CAP_DIM);
        }
      }
      if (projectile.local && projectile.age > LOCAL_CONFIRM_TIMEOUT_S) this._removeProjectile(id);
      else if (projectile.age > projectile.fuse + 1) this._removeProjectile(id);
    }

    for (let index = this.blasts.length - 1; index >= 0; index--) {
      const blast = this.blasts[index];
      blast.age += step;
      const t = Math.min(1, blast.age / blast.life);
      const eased = 1 - Math.pow(1 - t, 3);
      blast.mesh.scale.setScalar(0.08 + blast.radius * blast.grow * eased);
      blast.material.opacity = Math.max(0, (1 - t) * (1 - t) * 0.9);
      if (blast.ring) {
        blast.ring.mesh.scale.setScalar(0.1 + blast.radius * 1.1 * eased);
        blast.ring.material.opacity = Math.max(0, (1 - t) * 0.8);
      }
      if (t >= 1) {
        this.scene.remove(blast.mesh);
        blast.material.dispose();
        if (blast.ring) {
          this.scene.remove(blast.ring.mesh);
          blast.ring.material.dispose();
        }
        this.blasts.splice(index, 1);
      }
    }
  }

  _removeProjectile(id) {
    const projectile = this.projectiles.get(id);
    if (!projectile) return false;
    this.scene.remove(projectile.group);
    projectile.capMaterial?.dispose();
    this.projectiles.delete(id);
    return true;
  }

  dispose() {
    for (const id of Array.from(this.projectiles.keys())) this._removeProjectile(id);
    for (const blast of this.blasts) {
      this.scene.remove(blast.mesh);
      blast.material.dispose();
      if (blast.ring) {
        this.scene.remove(blast.ring.mesh);
        blast.ring.material.dispose();
      }
    }
    this.blasts.length = 0;
    this.scene.remove(this.previewLine, this.landingRing);
    this.previewLine.geometry.dispose();
    this.previewMaterial.dispose();
    this.landingRing.geometry.dispose();
    this.landingMaterial.dispose();
    for (const geometry of [
      this.fragGeometry, this.capGeometry, this.limpetGeometry, this.pulseGeometry,
      this.rocketBodyGeometry, this.rocketNoseGeometry, this.exhaustGeometry,
      this.blastGeometry, this.ringGeometry,
    ]) geometry.dispose();
    for (const material of [
      this.fragMaterial, this.limpetMaterial, this.pulseMaterial, this.rocketMaterial,
      this.rocketNoseMaterial, this.exhaustMaterial, this.boltCoreMaterial, this.boltGlowMaterial,
    ]) material.dispose();
  }
}
