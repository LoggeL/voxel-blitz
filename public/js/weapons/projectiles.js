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
const PROJECTILE_LIGHT_LIMIT = 4;
const ROCKET_TRAILS_PER_SECOND = 360;
const ROCKET_TRAIL_BURST = 12;

/** Blast presentation per projectile type: colour, growth, and life of the flash sphere. */
const BLAST_STYLE = Object.freeze({
  frag: Object.freeze({ color: 0xff9f1c, grow: 0.38, life: 0.42, ring: true, ringColor: 0xffc56b }),
  limpet: Object.freeze({ color: 0xffd9a8, grow: 0.46, life: 0.5, ring: true, ringColor: 0xff5a3c }),
  pulse: Object.freeze({ color: 0x59e8ff, grow: 0.65, life: 0.42, wireframe: true, ring: true, ringColor: 0x9ff4ff }),
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
  constructor(scene, getBlock = () => 0, { getEntityPosition = null, onTrail = null, onBounce = null, camera = null } = {}) {
    this.scene = scene;
    this.getBlock = getBlock;
    this.getEntityPosition = typeof getEntityPosition === 'function' ? getEntityPosition : null;
    this.onTrail = typeof onTrail === 'function' ? onTrail : null;
    this.onBounce = typeof onBounce === 'function' ? onBounce : null;
    this.projectiles = new Map();
    this.blasts = [];
    this.camera = camera;
    this._aimTarget = new THREE.Vector3();
    this._lightCandidates = [];
    this._trailCandidates = [];
    this._trailCursor = 0;
    this._trailTokens = 0;
    // Keep the light count fixed: changing it recompiles lit scene shaders.
    this._lights = Array.from({ length: PROJECTILE_LIGHT_LIMIT }, () => {
      const light = new THREE.PointLight(0xffa040, 0, 7);
      this.scene.add(light);
      return light;
    });
    this._localSeq = 0;
    this.isSolid = (x, y, z) => this.getBlock(Math.floor(x), Math.floor(y), Math.floor(z)) !== 0;
    this.raycast = (ox, oy, oz, dx, dy, dz, max) => raycastVoxels(
      (x, y, z) => this.getBlock(x, y, z) !== 0, ox, oy, oz, dx, dy, dz, max,
    );

    this.fragGeometry = new THREE.BoxGeometry(0.26, 0.26, 0.26);
    this.grenadeRibGeometry = new THREE.BoxGeometry(0.29, 0.035, 0.29);
    this.grenadeBandGeometry = new THREE.TorusGeometry(0.19, 0.018, 4, 16);
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

    // Submit rocket bodies, noses and exhausts in three instanced draws per pass.
    this._rocketCapacity = 256;
    this._rocketBatches = this._createRocketBatches(this._rocketCapacity);

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

  _createRocketBatches(capacity) {
    return [
      [this.rocketBodyGeometry, this.rocketMaterial],
      [this.rocketNoseGeometry, this.rocketNoseMaterial],
      [this.exhaustGeometry, this.exhaustMaterial],
    ].map(([geometry, material]) => {
      const mesh = new THREE.InstancedMesh(geometry, material, capacity);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      mesh.count = 0;
      this.scene.add(mesh);
      return mesh;
    });
  }

  _updateRocketBatches() {
    let count = 0;
    for (const p of this.projectiles.values()) if (p.type === 'rocket') count++;
    if (count > this._rocketCapacity) {
      for (const mesh of this._rocketBatches) { this.scene.remove(mesh); mesh.dispose(); }
      while (this._rocketCapacity < count) this._rocketCapacity *= 2;
      this._rocketBatches = this._createRocketBatches(this._rocketCapacity);
    }
    let index = 0;
    for (const p of this.projectiles.values()) {
      if (p.type !== 'rocket') continue;
      p.group.updateMatrixWorld(true);
      for (let part = 0; part < this._rocketBatches.length; part++) {
        this._rocketBatches[part].setMatrixAt(index, p.group.children[part].matrixWorld);
      }
      index++;
    }
    for (const mesh of this._rocketBatches) {
      mesh.count = count;
      if (count) mesh.instanceMatrix.needsUpdate = true;
    }
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
      group.add(body, nose, exhaust);
      group.userData.exhaust = exhaust;
    } else if (type === 'limpet') {
      const disc = new THREE.Mesh(this.limpetGeometry, this.limpetMaterial);
      capMaterial = new THREE.MeshBasicMaterial({ color: 0xff5a3c, toneMapped: false });
      const led = new THREE.Mesh(this.capGeometry, capMaterial);
      led.scale.set(0.7, 0.7, 0.7);
      led.position.set(0, 0.07, 0);
      group.add(disc, led);
      for (let i = 0; i < 4; i++) {
        const foot = new THREE.Mesh(this.capGeometry, this.fragMaterial);
        const angle = i * Math.PI / 2;
        foot.position.set(Math.cos(angle) * 0.17, -0.015, Math.sin(angle) * 0.17);
        foot.rotation.y = -angle;
        group.add(foot);
      }
      const rim = new THREE.Mesh(this.grenadeBandGeometry, capMaterial);
      rim.rotation.x = Math.PI / 2;
      group.add(rim);
    } else if (type === 'pulse') {
      const core = new THREE.Mesh(this.pulseGeometry, this.pulseMaterial);
      capMaterial = new THREE.MeshBasicMaterial({
        color: 0x9ff4ff, transparent: true, opacity: 0.5, toneMapped: false,
        blending: THREE.AdditiveBlending, depthWrite: false,
      });
      const halo = new THREE.Mesh(this.pulseGeometry, capMaterial);
      halo.scale.setScalar(1.55);
      group.add(core, halo);
      for (let i = 0; i < 2; i++) {
        const band = new THREE.Mesh(this.grenadeBandGeometry, this.fragMaterial);
        band.rotation.x = i * Math.PI / 2;
        group.add(band);
      }
      group.userData.halo = halo;
    } else if (type === 'bolt') {
      // Coilgun bolt: thin emissive core, additive glow shell, cyan light.
      const core = new THREE.Mesh(this.capGeometry, this.boltCoreMaterial);
      core.scale.set(0.7, 0.7, 2.6);
      const glow = new THREE.Mesh(this.pulseGeometry, this.boltGlowMaterial);
      glow.scale.setScalar(1.1);
      group.add(core, glow);
    } else {
      const body = new THREE.Mesh(this.fragGeometry, this.fragMaterial);
      body.rotation.set(0.35, 0.45, 0.12);
      capMaterial = new THREE.MeshBasicMaterial({ color: CAP_LIT, toneMapped: false });
      const cap = new THREE.Mesh(this.capGeometry, capMaterial);
      cap.position.set(0, 0.17, 0);
      group.add(body, cap);
      for (const height of [-0.09, 0, 0.09]) {
        const rib = new THREE.Mesh(this.grenadeRibGeometry, this.limpetMaterial);
        rib.position.y = height;
        group.add(rib);
      }
      const lever = new THREE.Mesh(this.capGeometry, this.fragMaterial);
      lever.scale.set(0.65, 3.6, 0.65);
      lever.position.set(0.16, 0.035, 0);
      lever.rotation.z = 0.2;
      group.add(lever);
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
      if (fromSelf && !event.child && this._adoptLocal(String(event.pid), type, values, fuse)) {
        const adopted = this.projectiles.get(String(event.pid));
        adopted.bouncesLeft = bouncesLeft;
        adopted.chaos = event.chaos || 0;
        if (type === 'rocket' && event.chaos) adopted.group.scale.setScalar(2.2);
        return true;
      }
    }
    const id = local ? `local-${++this._localSeq}` : String(event.pid);
    const { group, capMaterial } = this._buildVisual(type);
    group.position.set(values[0], values[1], values[2]);
    if (type === 'rocket' && event.chaos) group.scale.setScalar(2.2);
    if (type !== 'rocket') this.scene.add(group);
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
      chaos: event.chaos || 0,
      child: !!event.child,
      local,
      stuck: false,
      stuckTo: null,
      stickOffset: null,
      trailAt: 0,
    });
    if (type === 'rocket' || type === 'bolt') this._orientRocket(this.projectiles.get(id));
    return true;
  }

  updateAuthority(event) {
    const p = this.projectiles.get(String(event.pid));
    if (!p || !Array.isArray(event.o) || !Array.isArray(event.v) || ![...event.o, ...event.v].every(Number.isFinite)) return false;
    [p.x, p.y, p.z] = event.o;
    [p.vx, p.vy, p.vz] = event.v;
    if (Number.isFinite(event.bn)) p.bouncesLeft = event.bn;
    p.group.position.set(p.x, p.y, p.z);
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
    // Cluster salvos and bumper bombs share a bounded visual budget.
    if (this.blasts.length >= 96) {
      const oldest = this.blasts.shift();
      this.scene.remove(oldest.mesh);
      oldest.material.dispose();
      if (oldest.ring) { this.scene.remove(oldest.ring.mesh); oldest.ring.material.dispose(); }
    }
    const material = new THREE.MeshBasicMaterial({
      color: style.color,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    material.wireframe = !!style.wireframe;
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
    const target = this._aimTarget.set(
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
    this._trailCandidates.length = 0;
    this._trailTokens = Math.min(ROCKET_TRAIL_BURST, this._trailTokens + step * ROCKET_TRAILS_PER_SECOND);
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
        projectile.group.position.set(projectile.x, projectile.y, projectile.z);
        this._orientRocket(projectile);
        const flicker = 0.8 + Math.sin(projectile.age * 90) * 0.2;
        projectile.group.userData.exhaust.scale.set(flicker, flicker, 0.8 + flicker * 0.4);
        if (this.onTrail && projectile.age - projectile.trailAt >= ROCKET_TRAIL_INTERVAL_S) {
          this._trailCandidates.push(projectile);
        }
        if (projectile.hit && !projectile.local && !projectile.chaos) projectile.fuse = Math.min(projectile.fuse, projectile.age + 0.25);
      } else if (projectile.type === 'bolt') {
        stepBolt(projectile, step, this.raycast, {
          onBounce: (contact) => {
            this._spawnBlast(contact.x, contact.y, contact.z, BLAST_STYLE.bolt, 0.6);
            this.onBounce?.(contact.x, contact.y, contact.z);
          },
        });
        this._orientRocket(projectile);
        // Authority owns bolt death (projectileExplode); the local view just keeps flying.
        if (projectile.hit && !projectile.local && !projectile.chaos) {
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

    const trails = this._trailCandidates;
    const emissions = Math.min(trails.length, Math.floor(this._trailTokens));
    for (let i = 0; i < emissions; i++) {
      const p = trails[(this._trailCursor + i) % trails.length];
      if (!this.projectiles.has(p.id)) continue;
      p.trailAt = p.age;
      this.onTrail(p.x, p.y, p.z, p);
      this._trailTokens--;
    }
    this._trailCursor = trails.length ? (this._trailCursor + emissions) % trails.length : 0;
    this._updateRocketBatches();
    this._updateLights();

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

  _updateLights() {
    const nearest = this._lightCandidates;
    nearest.length = 0;
    const eye = this.camera?.position;
    for (const p of this.projectiles.values()) {
      if (p.type !== 'rocket' && p.type !== 'pulse' && p.type !== 'bolt') continue;
      p.lightDistance = eye
        ? (p.x - eye.x) ** 2 + (p.y - eye.y) ** 2 + (p.z - eye.z) ** 2 : 0;
      let i = nearest.length;
      while (i > 0 && nearest[i - 1].lightDistance > p.lightDistance) i--;
      if (i >= PROJECTILE_LIGHT_LIMIT) continue;
      nearest.splice(i, 0, p);
      if (nearest.length > PROJECTILE_LIGHT_LIMIT) nearest.pop();
    }
    for (let i = 0; i < this._lights.length; i++) {
      const light = this._lights[i], p = nearest[i];
      light.intensity = 0;
      if (!p) continue;
      light.position.set(p.x, p.y, p.z);
      light.color.setHex(p.type === 'rocket' ? 0xffa040 : p.type === 'pulse' ? 0x59e8ff : 0x7dfcff);
      light.distance = p.type === 'rocket' ? 7 : p.type === 'pulse' ? 5 : 4;
      light.intensity = p.type === 'rocket' ? 1.84 + Math.sin(p.age * 90) * 0.16
        : p.type === 'pulse' ? 0.9 : 1;
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
    for (const mesh of this._rocketBatches) { this.scene.remove(mesh); mesh.dispose(); }
    for (const light of this._lights) this.scene.remove(light);
    this._lightCandidates.length = 0;
    this._trailCandidates.length = 0;
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
      this.grenadeRibGeometry, this.grenadeBandGeometry,
      this.rocketBodyGeometry, this.rocketNoseGeometry, this.exhaustGeometry,
      this.blastGeometry, this.ringGeometry,
    ]) geometry.dispose();
    for (const material of [
      this.fragMaterial, this.limpetMaterial, this.pulseMaterial, this.rocketMaterial,
      this.rocketNoseMaterial, this.exhaustMaterial, this.boltCoreMaterial, this.boltGlowMaterial,
    ]) material.dispose();
  }
}
