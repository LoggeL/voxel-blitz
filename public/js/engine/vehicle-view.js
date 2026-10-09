import * as THREE from '../vendor/three.module.js';
import { vehicleStatus } from '../../../shared/conquest-contract.js';
import { vehicleDef, mountAim, vehicleDirection } from '../../../shared/vehicle-defs.js';
import { vehicleOccupiedSeats } from '../../../shared/vehicle-seats.js';
import { groundAttitude } from '../../../shared/vehicle-attitude.js';
import { makeJeepModel } from '../vehicles/models/jeep.js';
import { makeTankModel } from '../vehicles/models/tank.js';
import { makeHelicopterModel } from '../vehicles/models/helicopter.js';
import { makeTransportModel } from '../vehicles/models/transport.js';
import { makePlaneModel } from '../vehicles/models/plane.js';
import { JeepDriver } from '../vehicles/jeep-driver.js';
import { AircraftPilot } from '../vehicles/aircraft-pilot.js';
import { hasCockpitOverlay, makeCockpitOverlay } from '../vehicles/cockpit-overlay.js';
import { createVehicleFragments, fragmentMaterial } from '../vehicles/vehicle-fragments.js';
import { createVehicleMaterial, createVehicleGlassMaterial, createRotorBlurMaterial, setVehicleMaterialState } from '../vehicles/voxel-model/material.js';
import { canonicalMountKey, isAircraftType, rowMaxHp, mountIndex } from '../vehicles/voxel-model/anchors.js';

const angleDelta = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
const finite = value => Number.isFinite(value) ? value : 0;
const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));
export const VEHICLE_MODEL_FACTORIES = Object.freeze({
  jeep: makeJeepModel, tank: makeTankModel, helicopter: makeHelicopterModel, transport: makeTransportModel, plane: makePlaneModel,
});
const modelFactories = VEHICLE_MODEL_FACTORIES;

/** Presentation tuning (no gameplay values). */
export const VEHICLE_VIEW = Object.freeze({
  follow: 18,              // position/yaw smoothing rate
  mountSlew: 14,           // presented mount smoothing toward the authoritative aim
  attitudeRate: 7,         // ground attitude smoothing
  attitudeResample: 0.2,   // seconds between voxel support refits at rest
  spring: 70, damping: 0.55,
  tankRock: 0.035,         // 2 degrees of hull rock per main-gun shot
  rockImpulse: 18.5,       // spring velocity per radian of rock (peak ~= tankRock)
  tankRecoil: 0.6,         // barrel recoil travel, metres
  recoilReturn: 0.22,      // seconds time constant
  hpBarRange: 80,          // friendly crewed hulls only
  wreckTilt: 0.09,
  // NetClient keeps this many raw snapshots for event draining (RING_LEN). A
  // destruction whose owning snapshot left that ring undrained (long boot,
  // hidden tab) can never be presented, so the hull turns into a wreck then.
  destructionHorizon: 32,
  insideGlassOpacity: 0.07, // canopy glass seen from the local first-person seat
});

const destructionEvent = event => event?.kind === 'vehicle_destroyed' || (event?.kind === 'explosion' && event.type === 'vehicle');
const eventKey = event => Number.isFinite(event?.seq) ? `${event.kind}:${event.seq}` : event;
function eventFeet(event, kind) {
  const pos = Array.isArray(event?.pos) ? event.pos : event?.pos && [event.pos.x, event.pos.y, event.pos.z];
  if (!pos || pos.length !== 3 || !pos.every(Number.isFinite)) return null;
  const height = vehicleDef(kind)?.height ?? 2;
  return new THREE.Vector3(pos[0], pos[1] - (event.kind === 'explosion' ? height * 0.5 : 0), pos[2]);
}
const teamKey = team => team === 'alpha' || team === 'bravo' ? team : 'neutral';

const hpBarMaterial = new THREE.MeshBasicMaterial({ vertexColors: true, depthWrite: false, transparent: true, opacity: 0.92, fog: false });
hpBarMaterial.name = 'vehicle-hp-bar';
function createHpBar() {
  const geometry = new THREE.BufferGeometry();
  // Background quad then fill quad; the fill's right edge moves with HP.
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    -0.75, -0.07, 0, 0.75, -0.07, 0, -0.75, 0.07, 0, 0.75, 0.07, 0,
    -0.7, -0.04, 0.001, 0.7, -0.04, 0.001, -0.7, 0.04, 0.001, 0.7, 0.04, 0.001,
  ], 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(new Array(24).fill(0.1), 3));
  geometry.setIndex([0, 1, 2, 2, 1, 3, 4, 5, 6, 6, 5, 7]);
  const mesh = new THREE.Mesh(geometry, hpBarMaterial);
  mesh.name = 'vehicle-hp-bar';
  mesh.renderOrder = 4;
  mesh.visible = false;
  mesh.frustumCulled = false;
  return mesh;
}
function setHpBar(mesh, ratio) {
  const position = mesh.geometry.attributes.position, color = mesh.geometry.attributes.color;
  const right = -0.7 + 1.4 * clamp(ratio, 0, 1);
  position.setX(5, right); position.setX(7, right);
  const c = ratio > 0.5 ? [0.39, 0.89, 0.63] : ratio > 0.25 ? [1, 0.72, 0.3] : [1, 0.33, 0.33];
  for (let i = 4; i < 8; i++) color.setXYZ(i, c[0], c[1], c[2]);
  for (let i = 0; i < 4; i++) color.setXYZ(i, 0.06, 0.08, 0.08);
  position.needsUpdate = true; color.needsUpdate = true;
}

function clearCrew(item) {
  for (const actor of item.crew.values()) actor.dispose();
  item.crew.clear(); item.driver = null;
}

/**
 * Snapshot-driven Conquest hulls: voxel models in team camouflage, mount rigs
 * following the authoritative aim, ground attitude with spring suspension,
 * damage and wreck states from hp/st, visible exposed crew, and a contact
 * blob per wheel or track pair. Independent of terrain chunk visibility.
 */
export class VehicleView {
  constructor({ getBlock = null } = {}) {
    this.group = new THREE.Group(); this.group.name = 'conquest-vehicles';
    this.items = new Map();
    this.getBlock = typeof getBlock === 'function' ? getBlock : null;
    this.selfId = null; this.selfTeam = null;
    /** The local player's first-person seat { id, seatId } (setLocalView), or null. */
    this.localView = null;
    this._disposed = false;
    this._position = new THREE.Vector3();
    this._quaternion = new THREE.Quaternion(); this._cameraRotation = new THREE.Quaternion();
    this._direction = new THREE.Vector3(); this._vector = new THREE.Vector3();
    this._warmup = this._createWarmup();
  }

  /** The group to register with worldview.addCharacterRoots (voxel lighting). */
  lightingRoot() { return this.group; }

  setGetBlock(getBlock) { this.getBlock = typeof getBlock === 'function' ? getBlock : null; }

  /** Retired: hulls are voxel models in team camouflage, not a painted texture. */
  setPaintTexture(texture, { owned = false } = {}) { if (owned) texture?.dispose?.(); }
  async loadPaintTexture() { return null; }

  /**
   * One hidden mesh per program variant (hull, instanced wheels, glass, rotor
   * blur, HP bar, charred chunks). three.js compiles hidden objects too, so
   * warmShaders links them all at load instead of on the first destruction.
   */
  _createWarmup() {
    const group = new THREE.Group();
    group.name = 'vehicle-shader-warmup';
    group.visible = false;
    const glassMaterial = createVehicleGlassMaterial(), blurMaterial = createRotorBlurMaterial();
    const model = makeJeepModel({ team: 'neutral', material: createVehicleMaterial({ name: 'vehicle-warmup' }), glass: glassMaterial, blur: blurMaterial });
    const fragment = new THREE.Mesh(model.kit.parts[0].mesh.geometry, fragmentMaterial());
    fragment.name = 'vehicle-warmup-fragment';
    const blur = new THREE.Mesh(new THREE.CircleGeometry(1, 8), blurMaterial);
    const glass = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), glassMaterial);
    const bar = createHpBar();
    bar.visible = true;
    group.add(model.group, fragment, blur, glass, bar);
    this.group.add(group);
    return { group, model, materials: [model.kit.material, blur.material, glass.material], geometries: [blur.geometry, glass.geometry, bar.geometry] };
  }

  sync(rows = [], players = [], self = null, { events = [], snapSeq = null } = {}) {
    if (this._disposed) return;
    const seq = Number.isFinite(snapSeq) ? snapSeq : null;
    if (self) { this.selfId = self.id != null ? String(self.id) : null; this.selfTeam = self.team ?? null; }
    const destructions = new Map();
    for (const event of Array.isArray(events) ? events : []) {
      if (!destructionEvent(event) || event.vehicleId == null || !Object.hasOwn(modelFactories, event.vehicleType) || !eventFeet(event, event.vehicleType)) continue;
      const id = String(event.vehicleId);
      if (!destructions.has(id)) destructions.set(id, []);
      destructions.get(id).push(event);
    }
    const occupants = new Map((players instanceof Map ? [...players.values()] : Array.isArray(players) ? players : [])
      .filter(player => player?.id != null).map(player => [String(player.id), player]));
    if (self?.id != null) occupants.set(String(self.id), self);
    const retained = new Set();
    for (const source of Array.isArray(rows) ? rows : []) {
      const row = source && { ...source, kind: source.type ?? source.kind };
      if (!row || !Object.hasOwn(modelFactories, row.kind) || row.id == null || ![row.x, row.y, row.z, row.yaw].every(Number.isFinite)) continue;
      const aircraft = isAircraftType(row.kind);
      row.pitch = finite(row.pitch); row.roll = finite(row.roll);
      const id = String(row.id); retained.add(id);
      let item = this.items.get(id);
      // A pad capture repaints the hull: camouflage is baked per team.
      if (item && (item.kind !== row.kind || item.team !== teamKey(row.team))) { this.remove(id); item = null; }
      const created = !item;
      if (!item) {
        item = this.create(row.kind, teamKey(row.team));
        item.id = id;
        this.items.set(id, item); this.group.add(item.root);
        item.root.position.set(row.x, row.y, row.z);
        item.root.rotation.set(aircraft ? row.pitch : 0, row.yaw, aircraft ? row.roll : 0, 'YXZ');
      }
      item.row = { ...row, ...(row.seatOccupants ? { seatOccupants: { ...row.seatOccupants } } : {}) };
      const wreck = !!row.wreck || row.hp <= 0 || vehicleStatus(row).wreck;
      // A respawn received before the view clock catches up cancels that life.
      if (!wreck && item.pendingDestruction) this._cancelDestruction(item);
      const owningEvents = (destructions.get(id) || []).filter(event => event.vehicleType === row.kind);
      if (wreck && !item.wreck && !item.pendingDestruction && owningEvents.length) {
        const primary = owningEvents.find(event => event.kind === 'vehicle_destroyed') || owningEvents[0];
        const position = eventFeet(primary, row.kind);
        if (created) item.root.position.copy(position);
        item.pendingDestruction = { position, quaternion: item.root.quaternion.clone(), keys: new Set(owningEvents.map(eventKey)), snapSeq: seq, age: 0 };
      } else if (item.pendingDestruction && this._destructionExpired(item.pendingDestruction, seq)) {
        // Its owning snapshot was evicted before presentation: the blast will
        // never be drained. Wreck the hull now and reject any stray copy.
        this._cancelDestruction(item);
      }
      // Raw hp updates arrive before NetClient presents their effect events.
      // Retain the intact, frozen visible hull until that exact event is drained.
      if (item.pendingDestruction) continue;
      this._damagePresentation(item, row, wreck);
      this._syncCrew(item, row, wreck, occupants, id);
    }
    for (const id of this.items.keys()) if (!retained.has(id)) this.remove(id);
  }

  /** Snapshots consumed since the owning one (snapSeq when present, else a count). */
  _destructionExpired(pending, seq) {
    pending.age++;
    const elapsed = seq != null && pending.snapSeq != null ? seq - pending.snapSeq : pending.age;
    return elapsed >= VEHICLE_VIEW.destructionHorizon;
  }

  _cancelDestruction(item) {
    for (const key of item.pendingDestruction.keys) {
      item.cancelledDestructions.add(key);
      if (item.cancelledDestructions.size > 128) item.cancelledDestructions.delete(item.cancelledDestructions.values().next().value);
    }
    item.pendingDestruction = null;
  }

  _syncCrew(item, row, wreck, occupants, id) {
    const visibleSeats = new Map();
    const def = vehicleDef(row.kind);
    if (!wreck) for (const seat of vehicleOccupiedSeats(row)) {
      const seatDef = def?.seats.find(entry => entry.id === seat.id) || seat;
      // Sealed ground crew stay hidden inside the hull; aircraft crew show through glass.
      if (!seatDef.exposed && !isAircraftType(row.kind)) continue;
      const player = occupants.get(seat.occupantId);
      if (player?.state !== 'alive' || player.hp <= 0 ||
          (player.vehicleId != null && String(player.vehicleId) !== id) ||
          (player.vehicleSeatId != null && player.vehicleSeatId !== seat.id)) continue;
      visibleSeats.set(seat.id, { seat: seatDef, player });
    }
    for (const [seatId, actor] of item.crew) {
      const occupant = visibleSeats.get(seatId);
      if (!occupant || actor.playerId !== String(occupant.player.id)) { actor.dispose(); item.crew.delete(seatId); }
    }
    for (const [seatId, { seat, player }] of visibleSeats) {
      let actor = item.crew.get(seatId);
      if (!actor) {
        const rig = Object.values(item.model.mounts).find(mount => mount.seatId === seatId && mount.grips) || null;
        actor = seat.exposed
          ? new JeepDriver(item.model, player, seat, item.model.seatAnchors[seatId], rig)
          : new AircraftPilot(item.model, player, seat);
        item.crew.set(seatId, actor);
      } else actor.sync(player);
      actor.update(finite(item.row.visualSteer));
    }
    item.driver = item.crew.get('driver') || null;
  }

  create(kind, team = 'neutral') {
    const root = new THREE.Group();
    root.name = `conquest-${kind}`;
    const materials = { material: createVehicleMaterial(), glass: createVehicleGlassMaterial(), blur: createRotorBlurMaterial() };
    const model = modelFactories[kind]({ team, ...materials });
    root.add(model.group);
    const hpBar = createHpBar();
    hpBar.position.y = (vehicleDef(kind)?.height ?? 2.5) + 0.7;
    root.add(hpBar);
    // Rest pose of every articulated mount, so a hull without aim data looks right.
    const restYaw = new Map();
    for (const mount of Object.values(model.mounts)) restYaw.set(mount.yawNode, mount.yawNode.rotation.y);
    return {
      kind, team, root, model, materials, hpBar, hull: model.group, turret: model.turret, gun: model.gun,
      wheels: model.wheels, row: null, wreck: false, wreckAge: 0, lampLevel: 1,
      crew: new Map(), driver: null, pendingDestruction: null, cancelledDestructions: new Set(),
      mounts: new Map(), restYaw, recoil: new Map(),
      attitude: { pitch: 0, roll: 0, targetPitch: 0, targetRoll: 0, x: NaN, z: NaN, yaw: NaN, age: Infinity, seeded: false },
      spring: { pitch: 0, roll: 0, heave: 0, vp: 0, vr: 0, vh: 0, speed: 0, yaw: 0, seeded: false },
    };
  }

  _damagePresentation(item, row, wreck) {
    const status = vehicleStatus(row);
    if (wreck !== item.wreck) {
      item.wreck = wreck;
      item.wreckAge = 0;
      item.root.userData.wreck = wreck;
      item.model.setWreck(wreck);
      if (wreck) clearCrew(item);
    }
    const ratio = clamp(Number.isFinite(row.hp) ? row.hp / rowMaxHp(row) : 1, 0, 1);
    // Scorch blotches spread below three-quarters HP (half the hull by the
    // time it burns); a wreck is charred all over.
    const soot = wreck ? 1 : Math.max(0, (0.75 - ratio) / 0.75) * 0.55 + (status.burning ? 0.15 : 0);
    const occupied = vehicleOccupiedSeats(row).length > 0;
    const engine = status.engine || row.engineOn === true || occupied;
    item.lampLevel = wreck ? 0 : engine ? 1 : 0.18;
    setVehicleMaterialState(item.materials.material, { soot, lamps: item.lampLevel });
    item.ratio = ratio;
    item.status = status;
    item.occupied = occupied;
    // A ground wreck slumps onto its burst left side: the right wheels or
    // track stay on the ground instead of the hull hovering above it. A
    // landed aircraft wreck has lost its gear or skids and sits on its belly.
    const aircraft = isAircraftType(item.kind);
    const tilt = wreck && !aircraft ? VEHICLE_VIEW.wreckTilt : 0;
    const grounded = row.grounded ?? (row.st != null ? status.grounded : true);
    const belly = wreck && aircraft && grounded ? finite(item.model.wreckDrop) : 0;
    item.model.group.rotation.z = tilt;
    item.model.group.position.y = -Math.sin(tilt) * (vehicleDef(item.kind)?.collider?.halfWidth ?? 1) - belly;
  }

  /** Recoil and hull rock from an authoritative shot (VehicleFx calls this). */
  kick(id, mount, strength = 1) {
    const item = this.items.get(String(id));
    if (!item || item.wreck) return false;
    const key = canonicalMountKey(item.kind, mount);
    const rig = key && item.model.mounts[key];
    if (!rig) return false;
    if (rig.recoilNode) item.recoil.set(key, VEHICLE_VIEW.tankRecoil * clamp(strength, 0, 2));
    if (item.kind === 'tank' && rig.recoilNode) {
      // Rock the hull away from the barrel: the turret's local yaw picks the axis.
      const yaw = item.model.turret?.rotation.y ?? 0;
      item.spring.vp += Math.cos(yaw) * VEHICLE_VIEW.tankRock * VEHICLE_VIEW.rockImpulse * strength;
      item.spring.vr += -Math.sin(yaw) * VEHICLE_VIEW.tankRock * VEHICLE_VIEW.rockImpulse * strength;
    }
    return true;
  }

  update(dt = 0, camera = null) {
    const step = Math.max(0, Math.min(0.1, finite(dt))), alpha = 1 - Math.exp(-step * VEHICLE_VIEW.follow);
    if (camera) camera.getWorldQuaternion(this._cameraRotation);
    const cameraPosition = camera ? camera.getWorldPosition(this._vector) : null;
    for (const item of this.items.values()) {
      const row = item.row; if (!row) continue;
      if (item.pendingDestruction) { this._billboard(item, camera); continue; }
      const root = item.root, aircraft = isAircraftType(item.kind);
      root.position.lerp(this._position.set(row.x, row.y, row.z), alpha);
      const yaw = root.rotation.y + angleDelta(row.yaw, root.rotation.y) * alpha;
      if (aircraft) {
        root.rotation.set(root.rotation.x + angleDelta(row.pitch, root.rotation.x) * alpha, yaw,
          root.rotation.z + angleDelta(row.roll, root.rotation.z) * alpha, 'YXZ');
      } else {
        this._groundAttitude(item, row, step);
        root.rotation.set(item.attitude.pitch, yaw, item.attitude.roll, 'YXZ');
        this._suspension(item, row, step);
      }
      if (item.wreck) item.wreckAge += step;
      setVehicleMaterialState(item.materials.material, { burn: item.wreck ? Math.max(0, 1 - item.wreckAge / 40) : item.status?.burning ? 0.5 : 0 });
      root.updateMatrixWorld(true);
      if (!item.wreck) this._aimMounts(item, row, step);
      this._recoil(item, step);
      const railIndex = item.kind === 'plane' ? mountIndex('plane', 'rails') : -1;
      item.model.animate(step, {
        speed: finite(row.speed), visualSteer: finite(row.visualSteer),
        leftTrackSpeed: finite(row.leftTrackSpeed ?? row.speed), rightTrackSpeed: finite(row.rightTrackSpeed ?? row.speed),
        rotorSpeed: this._rotorSpeed(item, row), grounded: row.grounded ?? (row.st != null ? item.status?.grounded : true),
        wreck: item.wreck, railAmmo: railIndex >= 0 && Array.isArray(row.mounts?.[railIndex]) ? row.mounts[railIndex][2] : null,
      });
      const local = this.localView, inside = !!local && local.id === item.id;
      for (const actor of item.crew.values()) {
        actor.update(finite(row.visualSteer));
        // First person from this seat: the own head and chest would fill the near plane.
        actor.setFirstPerson?.(inside && local.seatId === actor.seatId);
      }
      // From inside, the canopy glass is a faint tint instead of the exterior sheen.
      const glass = item.materials.glass;
      glass.userData.baseOpacity ??= glass.opacity;
      const opacity = inside ? VEHICLE_VIEW.insideGlassOpacity : glass.userData.baseOpacity;
      if (glass.opacity !== opacity) glass.opacity = opacity;
      this._cockpitOverlay(item, inside && !item.wreck);
      // A mount sight (chin gimbal, tank gunner's sight) looks from inside the
      // gun: the own hull, crew and rotor would fill the lens, so they hide.
      const sight = inside && local.sight === true && !item.wreck;
      if (item.model.group.visible === sight) item.model.group.visible = !sight;
      this._hpBar(item, row, cameraPosition);
      this._billboard(item, camera);
    }
  }

  _rotorSpeed(item, row) {
    if (!(item.kind === 'helicopter' || item.kind === 'transport') || item.wreck) return 0;
    if (Number.isFinite(row.rotorSpeed)) return clamp(row.rotorSpeed, 0, 1);
    // Authoritative rows (they always carry `st` for aircraft) omit a zero
    // rotorSpeed: a stopped rotor must not spin up from the crew heuristic.
    if (row.st != null) return 0;
    const running = item.occupied || row.airborne || Math.abs(row.speed || 0) > 0.1 || Math.abs(row.verticalSpeed || 0) > 0.1;
    item.fallbackRotor = finite(item.fallbackRotor) + ((running ? 1 : 0) - finite(item.fallbackRotor)) * 0.05;
    return item.fallbackRotor;
  }

  /** Pitch and roll fitted to the voxel support (the server's own function). */
  _groundAttitude(item, row, step) {
    const state = item.attitude;
    state.age += step;
    if (this.getBlock && !item.wreck) {
      const moved = Math.hypot(row.x - state.x, row.z - state.z) > 0.05 || Math.abs(angleDelta(row.yaw, state.yaw)) > 0.01;
      if (moved || state.age >= VEHICLE_VIEW.attitudeResample || !Number.isFinite(state.x)) {
        const fit = groundAttitude(this.getBlock, item.kind, row.x, row.z, row.yaw, row.y);
        state.targetPitch = fit.pitch; state.targetRoll = fit.roll;
        state.x = row.x; state.z = row.z; state.yaw = row.yaw; state.age = 0;
      }
    } else {
      // Without a world (captures, tests) trust the row's published attitude.
      state.targetPitch = finite(row.pitch); state.targetRoll = finite(row.roll);
    }
    const k = state.seeded ? 1 - Math.exp(-step * VEHICLE_VIEW.attitudeRate) : 1;
    state.pitch += (state.targetPitch - state.pitch) * k;
    state.roll += (state.targetRoll - state.roll) * k;
    state.seeded = true;
  }

  /** Spring body over the running gear: squat, dive, lean and shot rock. */
  _suspension(item, row, step) {
    const spring = item.spring, body = item.model.body;
    if (!body || item.wreck) { if (body) body.rotation.set(0, 0, 0); return; }
    const speed = finite(row.speed);
    if (!spring.seeded) { spring.speed = speed; spring.yaw = row.yaw; spring.seeded = true; }
    if (step <= 0) return;
    const accel = clamp((speed - spring.speed) / step, -20, 20);
    const yawRate = angleDelta(row.yaw, spring.yaw) / step;
    spring.speed = speed; spring.yaw = row.yaw;
    const scale = item.kind === 'tank' ? 0.5 : 1;
    const targetPitch = clamp(accel * 0.004 * scale, -0.05, 0.05);
    const targetRoll = clamp(-yawRate * speed * 0.004 * scale, -0.06, 0.06);
    const k = VEHICLE_VIEW.spring, c = 2 * Math.sqrt(k) * VEHICLE_VIEW.damping;
    spring.vp += (k * (targetPitch - spring.pitch) - c * spring.vp) * step;
    spring.vr += (k * (targetRoll - spring.roll) - c * spring.vr) * step;
    spring.pitch = clamp(spring.pitch + spring.vp * step, -0.12, 0.12);
    spring.roll = clamp(spring.roll + spring.vr * step, -0.12, 0.12);
    body.rotation.set(spring.pitch, 0, spring.roll);
  }

  /** Slew every articulated mount toward the authoritative world aim. */
  _aimMounts(item, row, step) {
    const k = 1 - Math.exp(-step * VEHICLE_VIEW.mountSlew);
    const driven = new Set();
    for (const rig of Object.values(item.model.mounts)) {
      if (rig.fixed) continue;
      const aim = mountAim(row, rig.mountId);
      if (!aim) continue;
      const state = item.mounts.get(rig.key) || { yaw: 0, pitch: 0, seeded: false };
      item.mounts.set(rig.key, state);
      // World aim -> the yaw node's parent frame.
      const dir = vehicleDirection(aim.yaw, aim.pitch);
      rig.yawNode.parent.getWorldQuaternion(this._quaternion).invert();
      this._direction.set(dir[0], dir[1], dir[2]).applyQuaternion(this._quaternion);
      const localYaw = Math.atan2(-this._direction.x, -this._direction.z);
      const localPitch = Math.atan2(this._direction.y, Math.hypot(this._direction.x, this._direction.z));
      if (!state.seeded) { state.yaw = localYaw; state.pitch = localPitch; state.seeded = true; }
      else { state.yaw += angleDelta(localYaw, state.yaw) * k; state.pitch += (localPitch - state.pitch) * k; }
      if (!driven.has(rig.yawNode)) {
        rig.yawNode.rotation.y = state.yaw;
        rig.yawNode.updateWorldMatrix(false, true);
        driven.add(rig.yawNode);
      }
      if (rig.pitchNode !== rig.yawNode) { rig.pitchNode.rotation.x = state.pitch; rig.pitchNode.updateWorldMatrix(false, true); }
    }
  }

  _recoil(item, step) {
    for (const [key, amount] of item.recoil) {
      const rig = item.model.mounts[key];
      if (!rig?.recoilNode) { item.recoil.delete(key); continue; }
      const base = rig.recoilNode.userData.restZ ??= rig.recoilNode.position.z;
      const next = amount * Math.exp(-step / VEHICLE_VIEW.recoilReturn);
      rig.recoilNode.position.z = base + next;
      if (next < 0.002) { rig.recoilNode.position.z = base; item.recoil.delete(key); }
      else item.recoil.set(key, next);
    }
  }

  /** Friendly crewed hulls within range show HP; never your own or parked ones. */
  _hpBar(item, row, cameraPosition) {
    const own = this.selfId != null && vehicleOccupiedSeats(row).some(seat => seat.occupantId === this.selfId);
    const friendly = this.selfTeam != null && row.team === this.selfTeam;
    const near = cameraPosition ? cameraPosition.distanceTo(item.root.position) <= VEHICLE_VIEW.hpBarRange : true;
    const show = !item.wreck && item.occupied && !own && friendly && near && item.ratio < 0.999;
    item.hpBar.visible = show;
    if (show) setHpBar(item.hpBar, item.ratio);
  }

  _billboard(item, camera) {
    if (!camera || !item.hpBar.visible) return;
    item.root.getWorldQuaternion(this._quaternion);
    item.hpBar.quaternion.copy(this._quaternion.invert().multiply(this._cameraRotation));
  }

  /** First-person cockpit dressing (frames, panel, displays) on the local hull only, built on first use. */
  _cockpitOverlay(item, wanted) {
    if (wanted && !item.cockpit && hasCockpitOverlay(item.kind)) {
      item.cockpit = makeCockpitOverlay(item.kind);
      if (item.cockpit) (item.model.body || item.model.group).add(item.cockpit.group);
    }
    if (item.cockpit) item.cockpit.group.visible = wanted;
    // Frames that would box in a first-person seat (the jeep windscreen) fold away.
    for (const node of item.model.firstPersonHidden || []) node.visible = !wanted;
  }

  /**
   * The local player's seat while its camera is first person (VehicleCamera
   * cockpit view or a mount sight): { id, seatId, sight } or null. That seat's
   * crew avatar drops its head from the next update on; with `sight` the
   * whole hull model hides (the camera looks from inside the gun).
   */
  setLocalView(view = null) {
    this.localView = view && view.id != null && view.seatId
      ? { id: String(view.id), seatId: String(view.seatId), sight: view.sight === true } : null;
  }

  presentedRow(id) {
    const item = this.items.get(String(id));
    return item?.row ? { ...item.row, x: item.root.position.x, y: item.root.position.y, z: item.root.position.z,
      yaw: item.root.rotation.y, pitch: item.root.rotation.x, roll: item.root.rotation.z } : null;
  }

  /** World muzzle pose of a mount from the rendered rig: { origin, dir }. */
  mountWorldPose(id, mount, { side = 0 } = {}) {
    const item = this.items.get(String(id));
    const key = item && canonicalMountKey(item.kind, mount);
    const rig = key && item.model.mounts[key];
    if (!rig) return null;
    const muzzle = rig.muzzles[side % rig.muzzles.length] || rig.muzzle;
    muzzle.updateWorldMatrix(true, false);
    const origin = muzzle.getWorldPosition(new THREE.Vector3());
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(muzzle.getWorldQuaternion(new THREE.Quaternion()));
    return { origin: origin.toArray(), dir: dir.toArray(), key };
  }

  /** The rendered item (model, emitters, presented root) for FX consumers. */
  item(id) { return this.items.get(String(id)) || null; }

  fragmentSource(id) { const item = this.items.get(String(id)); return item?.row ? { root: item.root, row: item.row } : null; }

  destructionFragments(id, options = {}) {
    const item = this.items.get(String(id)); if (!item?.row) return [];
    const event = options.event;
    if (event && item.cancelledDestructions.has(eventKey(event))) return false;
    if (!event) return createVehicleFragments(item.model, options);
    const position = eventFeet(event, item.kind); if (!position) return [];
    const pending = item.pendingDestruction;
    // Extract the tagged chunks at the blast's authoritative position, before
    // the wreck geometry drops them.
    item.root.position.copy(position);
    if (pending) item.root.quaternion.copy(pending.quaternion);
    item.root.updateMatrixWorld(true);
    const pieces = createVehicleFragments(item.model, options);
    item.pendingDestruction = null;
    this._damagePresentation(item, { ...item.row, hp: 0 }, true);
    return pieces;
  }

  /** Contact blobs per wheel or track pair (ContactShadows.add). */
  addContactShadows(shadows) {
    for (const item of this.items.values()) {
      if (!item.row || !item.root.visible) continue;
      const yaw = item.root.rotation.y;
      for (const contact of item.model.contacts || []) {
        this._vector.set(contact.x, 0, contact.z).applyQuaternion(item.root.quaternion).add(item.root.position);
        shadows.add(this._vector.x, item.root.position.y + 0.1, this._vector.z, contact.radius,
          (contact.strength ?? 0.5) * (item.wreck ? 0.8 : 1), contact.stretch ?? 1, yaw + (contact.across ? Math.PI / 2 : 0));
      }
    }
  }

  remove(id) {
    id = String(id); const item = this.items.get(id); if (!item) return;
    clearCrew(item);
    item.cockpit?.dispose(); item.cockpit = null;
    item.hpBar.geometry.dispose();
    for (const mesh of item.model.kit.extraMeshes) if (mesh.userData.ownedGeometry) mesh.geometry.dispose();
    for (const material of Object.values(item.materials)) material.dispose();
    item.root.removeFromParent(); this.items.delete(id);
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    for (const id of [...this.items.keys()]) this.remove(id);
    for (const material of this._warmup.materials) material.dispose();
    for (const geometry of this._warmup.geometries) geometry.dispose();
    this._warmup.group.removeFromParent();
    this.group.removeFromParent();
  }
}
