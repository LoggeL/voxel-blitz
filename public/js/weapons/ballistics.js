// Tracer and remote muzzle-flash pools for the weapon-effects facade.
import * as THREE from '../vendor/three.module.js';
import { WEAPONS, HITSCAN_REACH, chargeShotProfile } from '../../../shared/combatmath.js';
import { raycastVoxels } from '../../../shared/raycast.js';
import { ballisticLaunch, ballisticPoint, ballisticProfile, traceBallistic } from '../../../shared/bullet-ballistics.js';
import { FLUID_BLOCKS, isSolidBlock } from '../../../shared/world/blocks.js';
import { freeOldestIndex, hideInstance } from './instancing.js';
import { FLASH_FRAMES, FLASH_GAIN, flashAtlasTexture } from '../guns/kit.js';

const TAU = Math.PI * 2;
const TRACER_POOL_SIZE = 96;
const FLASH_POOL_SIZE = 24;
const NEG_Z = new THREE.Vector3(0, 0, -1);
const EMPTY_OPTIONS = Object.freeze({});
const NO_BLOCK = () => 0;
// Linear HDR gain on the def tracer colour: > 1 so HDR tiers bloom the head.
const TRACER_HDR = 2.6;
// Narrowest on-screen ribbon in buffer pixels; wider-than-true ribbons dim to match.
const TRACER_MIN_PIXELS = 2.5;
// Flying rounds (def.ballistic): streak length behind the head, the distance over
// which the streak eases from the visible barrel onto the true arc, and the life
// phase that shows the whole ribbon (head lit, tail on, see TRACER_VERTEX).
const ROUND_STREAK_M = 26;
const ROUND_CONVERGE_M = 30;
const ROUND_PHASE = 0.32;
const MAX_ROUNDS = 24;

// Camera-facing tracer ribbon. The instance matrix keeps the box-era semantics
// (translation = muzzle start, rotation maps -Z onto the flight direction, scale =
// (width, width, streak length)); its unused projective slots carry the 0..1 life
// phase ([0][3]) and the remote "pinned" flag ([1][3]) without a second attribute.
// Local streaks shoot out and the tail chases the head; remote streaks keep their
// shooter end at the muzzle for the whole life (like the old shrinking box), so the
// line always points back at the enemy, and fade out instead.
// Additive output fades toward black with the scene fog (see ADDITIVE_FOG_FRAGMENT).
const TRACER_VERTEX = `
  #include <fog_pars_vertex>
  uniform float viewportHeight;
  uniform float minPixels;
  varying vec3 tracerColor;
  varying float tracerSide;
  varying float tracerAlong;
  varying float tracerHead;
  varying float tracerTail;
  varying float tracerLength;
  varying float tracerFade;
  varying float tracerFloor;
  void main() {
    vec3 axisFull = -(modelMatrix * vec4(instanceMatrix[2].xyz, 0.0)).xyz;
    float len = length(axisFull);
    float width = length(instanceMatrix[0].xyz);
    if (len < 1e-5 || width < 1e-7) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
    float phase = instanceMatrix[0].w;
    float pinned = step(0.5, instanceMatrix[1].w);
    vec3 axis = axisFull / len;
    vec3 start = (modelMatrix * vec4(instanceMatrix[3].xyz, 1.0)).xyz;
    float along = -position.z;
    vec3 point = start + axisFull * along;
    vec3 side = cross(axis, cameraPosition - point);
    float sideLength = length(side);
    side = sideLength > 1e-6 ? side / sideLength
      : normalize(cross(axis, abs(axis.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
    vec4 viewPoint = viewMatrix * vec4(point, 1.0);
    float depth = isOrthographic ? 1.0 : max(-viewPoint.z, 1e-3);
    float pixel = 2.0 * depth / (projectionMatrix[1][1] * viewportHeight);
    float trueHalf = width * 0.9;
    float ribbonHalf = max(trueHalf, minPixels * 0.5 * pixel);
    tracerFade = clamp(trueHalf / ribbonHalf, 0.3, 1.0)
      * (1.0 - pinned * smoothstep(0.45, 1.0, phase));
    point += side * position.x * ribbonHalf;
    vec4 mvPosition = viewMatrix * vec4(point, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
    #ifdef USE_INSTANCING_COLOR
      tracerColor = instanceColor;
    #else
      tracerColor = vec3(1.0);
    #endif
    tracerSide = position.x;
    tracerAlong = along;
    tracerLength = len;
    // Head reaches the far end at 30% of life. Local: the tail leaves the muzzle at
    // 35% and chases it. Remote: the tail stays on the muzzle and the shooter end
    // keeps a brighter body floor so it reads.
    tracerHead = clamp(phase / 0.3, 0.0, 1.0);
    tracerTail = (1.0 - pinned) * clamp((phase - 0.35) / 0.65, 0.0, 1.0);
    tracerFloor = mix(0.16, 0.45, pinned);
  }
`;

// Additive effects fade toward black in fog, not toward fogColor: run the scene's
// own fog chunk (exp/exp2 plus the global far fade) and take its colour back out,
// leaving rgb * (1 - fogFactor). Program keys follow scene.fog, fixed at map load.
const ADDITIVE_FOG_FRAGMENT = `
    #include <fog_fragment>
    #ifdef USE_FOG
      gl_FragColor.rgb = max(gl_FragColor.rgb - fogColor * fogFactor, vec3(0.0));
    #endif
`;

const TRACER_FRAGMENT = `
  #include <fog_pars_fragment>
  uniform float intensity;
  varying vec3 tracerColor;
  varying float tracerSide;
  varying float tracerAlong;
  varying float tracerHead;
  varying float tracerTail;
  varying float tracerLength;
  varying float tracerFade;
  varying float tracerFloor;
  void main() {
    float span = max(tracerHead - tracerTail, 1e-4);
    float headSoft = 0.08 / tracerLength;
    float visible = smoothstep(tracerTail - headSoft, tracerTail + headSoft * 4.0, tracerAlong)
      * (1.0 - smoothstep(tracerHead - headSoft, tracerHead, tracerAlong));
    if (visible <= 0.0) discard;
    float u = clamp((tracerAlong - tracerTail) / span, 0.0, 1.0);
    float body = tracerFloor + (1.0 - tracerFloor) * u * u;
    float head = exp(-max(tracerHead - tracerAlong, 0.0) * tracerLength / 0.45);
    float s2 = tracerSide * tracerSide;
    float core = exp(-s2 * 9.0);
    float halo = exp(-s2 * 2.6) * 0.3;
    vec3 hot = mix(tracerColor, vec3(1.0), clamp(core * (0.35 + head * 0.5), 0.0, 1.0));
    float energy = (core + halo) * (body + head * 1.6) * visible * tracerFade;
    gl_FragColor = vec4(hot * intensity * energy, 1.0);
    #include <colorspace_fragment>
    ${ADDITIVE_FOG_FRAGMENT}
  }
`;

// Billboarded remote muzzle stars: one draw for the whole pool. Per instance the
// matrix carries position and size; flashState = (roll, atlas column, opacity).
const WORLD_FLASH_VERTEX = `
  #include <fog_pars_vertex>
  attribute vec3 flashState;
  varying vec2 flashUv;
  varying float flashAlpha;
  void main() {
    float size = length(instanceMatrix[0].xyz);
    if (size < 1e-6 || flashState.z <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
    vec4 mvPosition = modelViewMatrix * vec4(instanceMatrix[3].xyz, 1.0);
    float c = cos(flashState.x), s = sin(flashState.x);
    mvPosition.xy += mat2(c, s, -s, c) * position.xy * size;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
    flashUv = vec2((uv.x + flashState.y) / ${FLASH_FRAMES.toFixed(1)}, uv.y * 0.5);
    flashAlpha = flashState.z;
  }
`;

const WORLD_FLASH_FRAGMENT = `
  #include <fog_pars_fragment>
  uniform sampler2D map;
  uniform vec3 tint;
  varying vec2 flashUv;
  varying float flashAlpha;
  void main() {
    vec4 texel = texture2D(map, flashUv);
    gl_FragColor = vec4(texel.rgb * tint, texel.a * flashAlpha);
    #include <colorspace_fragment>
    ${ADDITIVE_FOG_FRAGMENT}
  }
`;

function directionInto(target, value) {
  if (Array.isArray(value)) return target.set(value[0], value[1], value[2]);
  return target.set(value.x, value.y, value.z);
}

/** Water-entry probe of a bullet path: radius (m) around the listener, minimum distance from the muzzle. */
export const WATER_PROBE = Object.freeze({ radius: 50, minT: 0.5 });

export class TracerFX {
  constructor(scene, worldGetBlockFn, onWallImpact) {
    this.scene = scene;
    this.getBlockFn = worldGetBlockFn || NO_BLOCK;
    // Fluids, portals and ghost blocks never stop authoritative bullets either.
    this.solidAt = (x, y, z) => isSolidBlock(this.getBlockFn(x, y, z));
    this.onWallImpact = typeof onWallImpact === 'function' ? onWallImpact : null;
    // Optional water entry hook (point, local) for rounds that cross a fluid surface
    // (rounds pass through water, so wall impacts never report it). `waterFocus`
    // returns the listener [x, y, z]: only the stretch of a path within
    // WATER_PROBE.radius of it is probed.
    this.onWaterImpact = null;
    this.waterFocus = null;
    this.fluidAt = (x, y, z) => FLUID_BLOCKS.has(this.getBlockFn(x, y, z));

    this._matrix = new THREE.Matrix4();
    this._rotation = new THREE.Quaternion();
    this._position = new THREE.Vector3();
    this._scale = new THREE.Vector3();
    this._direction = new THREE.Vector3();
    this._muzzle = new THREE.Vector3();
    // Optional (ownerId, out) => out|null: remote streaks and flashes anchor to
    // the shooter's rendered barrel tip instead of the server eye approximation.
    this.remoteMuzzleProvider = null;

    // Ribbon strip: x = side (-1..1), z = 0 at the muzzle to -1 at the far end.
    const tracerGeometry = new THREE.BufferGeometry();
    tracerGeometry.setAttribute('position', new THREE.Float32BufferAttribute([
      -1, 0, 0, 1, 0, 0, -1, 0, -1, 1, 0, -1,
    ], 3));
    tracerGeometry.setIndex([0, 1, 2, 2, 1, 3]);
    this._viewport = new THREE.Vector2();
    const tracerMaterial = new THREE.ShaderMaterial({
      uniforms: {
        ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
        viewportHeight: { value: 1080 },
        minPixels: { value: TRACER_MIN_PIXELS },
        intensity: { value: TRACER_HDR },
      },
      vertexShader: TRACER_VERTEX,
      fragmentShader: TRACER_FRAGMENT,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      // Additive needs no back-then-front split: one draw, one program.
      forceSinglePass: true,
      toneMapped: false,
      fog: true,
    });
    this.tracerMesh = new THREE.InstancedMesh(
      tracerGeometry,
      tracerMaterial,
      TRACER_POOL_SIZE,
    );
    this.tracerMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.tracerMesh.frustumCulled = false;
    // The minimum pixel width needs the height of whatever buffer the scene renders to.
    this.tracerMesh.onBeforeRender = (renderer) => {
      const target = renderer.getRenderTarget();
      tracerMaterial.uniforms.viewportHeight.value = target
        ? target.height
        : Math.max(1, renderer.getDrawingBufferSize(this._viewport).y);
    };
    this.tracers = new Array(TRACER_POOL_SIZE);
    for (let i = 0; i < TRACER_POOL_SIZE; i++) {
      const tracer = {
        active: false,
        t: 0,
        life: 0.06,
        len: 20,
        w: 0.03,
        anchored: false,
        pinned: false,
        round: null,
        color: new THREE.Color(0xffffff),
      };
      this.tracers[i] = tracer;
      this.tracerMesh.setColorAt(i, tracer.color);
      hideInstance(this.tracerMesh, i);
    }
    scene.add(this.tracerMesh);

    // Remote muzzle stars: one always-present instanced draw, so its program is
    // compiled with the first frame instead of on the first remote shot. Idle slots
    // are zero-scale instances culled in the vertex shader.
    this.flashTexture = flashAtlasTexture();
    const flashGeometry = new THREE.PlaneGeometry(1, 1);
    this.flashState = new THREE.InstancedBufferAttribute(new Float32Array(FLASH_POOL_SIZE * 3), 3);
    this.flashState.setUsage(THREE.DynamicDrawUsage);
    flashGeometry.setAttribute('flashState', this.flashState);
    this.flashMesh = new THREE.InstancedMesh(flashGeometry, new THREE.ShaderMaterial({
      uniforms: {
        ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
        map: { value: this.flashTexture },
        // Same atlas and HDR gain as the first-person flash.
        tint: { value: new THREE.Color().setScalar(FLASH_GAIN) },
      },
      vertexShader: WORLD_FLASH_VERTEX,
      fragmentShader: WORLD_FLASH_FRAGMENT,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
      fog: true,
    }), FLASH_POOL_SIZE);
    this.flashMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.flashMesh.frustumCulled = false;
    this.flashes = new Array(FLASH_POOL_SIZE);
    for (let i = 0; i < FLASH_POOL_SIZE; i++) {
      this.flashes[i] = { active: false, t: 0, life: 0.05, x: 0, y: 0, z: 0, size: 0.55 };
      hideInstance(this.flashMesh, i);
    }
    scene.add(this.flashMesh);

    this.stats = { shots: 0 };
    /** Flying rounds in presentation, oldest first (see launchRound). */
    this.rounds = [];
    this._disposed = false;
  }

  /** Shot-time muzzle origin for local tracers; null restores the fixed camera-space spawn. */
  setMuzzleProvider(fn) {
    this.muzzleProvider = typeof fn === 'function' ? fn : null;
  }

  /**
   * First water surface a straight path (`origin`, unit `direction`, `length`)
   * enters near the listener: calls onWaterImpact(point, local). A path that
   * starts in water reports nothing.
   */
  probeWater(origin, direction, length, local) {
    if (!this.onWaterImpact || !(length > WATER_PROBE.minT)) return false;
    const focus = typeof this.waterFocus === 'function' ? this.waterFocus() : null;
    if (!Array.isArray(focus) || !focus.every(Number.isFinite)) return false;
    const [ox, oy, oz] = origin;
    const norm = Math.hypot(direction.x, direction.y, direction.z);
    if (!(norm > 0) || ![ox, oy, oz].every(Number.isFinite)) return false;
    const dx = direction.x / norm, dy = direction.y / norm, dz = direction.z / norm;
    const t = Math.max(0, Math.min(length, (focus[0] - ox) * dx + (focus[1] - oy) * dy + (focus[2] - oz) * dz));
    const miss = Math.hypot(ox + dx * t - focus[0], oy + dy * t - focus[1], oz + dz * t - focus[2]);
    if (miss > WATER_PROBE.radius) return false;
    const reach = Math.sqrt(WATER_PROBE.radius * WATER_PROBE.radius - miss * miss);
    const from = Math.max(0, t - reach), to = Math.min(length, t + reach);
    const sx = ox + dx * from, sy = oy + dy * from, sz = oz + dz * from;
    if (from > 0 && this.fluidAt(Math.floor(sx), Math.floor(sy), Math.floor(sz))) return false;
    const hit = raycastVoxels(this.fluidAt, sx, sy, sz, dx, dy, dz, to - from);
    if (!hit || hit.y < 0 || from + hit.t < WATER_PROBE.minT || !this.fluidAt(hit.x, hit.y, hit.z)) return false;
    this.onWaterImpact([sx + dx * hit.t, sy + dy * hit.t, sz + dz * hit.t], local);
    return true;
  }

  /**
   * Consume the server shot wire shape without changing its array/object
   * direction conventions. Only the first terrain hit emits wall feedback.
   */
  shoot(event, options = EMPTY_OPTIONS) {
    this.stats.shots++;
    const definition = WEAPONS[event.w];
    const pelletDirections = event.pellets;
    const usePellets = pelletDirections && pelletDirections.length > 1;
    const directionCount = usePellets ? pelletDirections.length : 1;
    const limit = Math.min(directionCount, definition ? definition.pellets * (event.chaos && event.w === 'shotgun' ? 2 : 1) : 1);
    let ox = event.o[0];
    let oy = event.o[1];
    let oz = event.o[2];
    const local = !!options.local;
    if (!local && this.remoteMuzzleProvider) {
      const m = this.remoteMuzzleProvider(event.id, this._muzzle);
      // Sanity cap: a desynced avatar never drags a streak across the map.
      if (m && Math.hypot(m.x - ox, m.y - oy, m.z - oz) < 3) {
        ox = m.x; oy = m.y; oz = m.z;
      }
    }

    // The SUDSBLASTER releases a soap film, never a powder flash.
    if (!local && definition?.projectile !== 'bubble') this.spawnFlash([ox, oy, oz], event.d);
    if (definition && !definition.tracer) return;
    const ballistic = ballisticProfile(definition);
    if (ballistic) { this.launchRound(event, definition, ballistic, local, ox, oy, oz); return; }
    if (Array.isArray(event.paths)) { this.resolvedShot(event, { pinned: !local }); return; }

    for (let i = 0; i < limit; i++) {
      const rawDirection = usePellets
        ? pelletDirections[i]
        : (event.spread || event.d);
      const direction = directionInto(this._direction, rawDirection);
      let length = definition ? definition.tracer.len : 22;
      const hit = raycastVoxels(
        this.solidAt,
        ox,
        oy,
        oz,
        direction.x,
        direction.y,
        direction.z,
        HITSCAN_REACH,
      );
      if (i === 0) this.probeWater([ox, oy, oz], direction, hit ? hit.t : HITSCAN_REACH, local);
      if (hit) {
        if (i === 0 && this.onWallImpact) this.onWallImpact(hit, local);
        // Prediction stops at the first contact; authority supplies continuation paths.
        length = Math.max(0.1, Math.min(length, hit.t) - 0.35);
      }
      // Local shots anchor to the live rig muzzle and converge on this eye-ray
      // endpoint; remote shots start at the shooter's rendered barrel tip when
      // the roster resolves one, else the server's presentation origin.
      const aimDistance = hit ? hit.t : 180;
      const endpoint = local && this.muzzleProvider
        ? [ox + direction.x * aimDistance, oy + direction.y * aimDistance, oz + direction.z * aimDistance]
        : null;
      this.spawnTracer([ox, oy, oz], direction, length, definition, endpoint, event.charge ?? 1, 0.35, !local);
    }
  }

  /** Server-resolved segments include penetration exits and reflected directions. */
  resolvedShot(event, { continuationsOnly = false, pinned = false } = {}) {
    const definition = WEAPONS[event.w];
    if (!definition?.tracer) return;
    for (const path of event.paths || []) {
      for (let i = continuationsOnly ? 1 : 0; i < path.length; i++) {
        const segment = path[i];
        const direction = this._direction.set(
          segment.end[0] - segment.o[0], segment.end[1] - segment.o[1], segment.end[2] - segment.o[2]);
        const distance = direction.length();
        if (distance > 0.001) {
          direction.multiplyScalar(1 / distance);
          this.probeWater(segment.o, direction, distance, false);
          this.spawnTracer(segment.o, direction, Math.min(distance, definition.tracer.len), definition, null, event.charge ?? 1, 0, pinned);
        }
        if (segment.hit && this.onWallImpact) this.onWallImpact(segment.hit, false);
      }
    }
  }

  /**
   * A flying round (`def.ballistic`): the streak rides the shared arc from the
   * trigger until its first predicted voxel contact, where it leaves wall
   * feedback. `event.o` is the eye for local shots and the server muzzle
   * (eye − 0.15 m, 0.25 m forward) for remote ones; the visible start
   * (`vx, vy, vz`: rig or avatar barrel) eases onto the true arc.
   */
  launchRound(event, definition, profile, local, vx, vy, vz) {
    const raw = event.spread || event.d;
    const direction = directionInto(this._direction, raw).normalize();
    const d = { x: direction.x, y: direction.y, z: direction.z };
    const eye = local ? event.o
      : [event.o[0] - d.x * 0.25, event.o[1] + 0.15 - d.y * 0.25, event.o[2] - d.z * 0.25];
    const launch = ballisticLaunch(profile, eye, d);
    const flight = traceBallistic(profile, launch, this.solidAt);
    let sx = vx, sy = vy, sz = vz;
    if (local) {
      const m = this.muzzleProvider?.(this._muzzle);
      if (m) { sx = m.x; sy = m.y; sz = m.z; } else { sx = eye[0] + d.x * 0.35; sy = eye[1] + d.y * 0.35; sz = eye[2] + d.z * 0.35; }
    }
    if (this.rounds.length >= MAX_ROUNDS) this._endRound(0, false);
    const index = this._claimTracer();
    const tracer = this.tracers[index];
    tracer.active = true;
    tracer.t = 0;
    tracer.life = Infinity;
    tracer.pinned = false;
    tracer.w = 0.028 * definition.tracer.width;
    tracer.color.set(definition.tracer.color);
    const round = {
      index, launch, profile, local, ownerId: String(event.id ?? ''), w: event.w,
      t: 0, end: flight.t, hit: flight.hit,
      ox: sx - eye[0], oy: sy - eye[1], oz: sz - eye[2],
    };
    tracer.round = round;
    this.tracerMesh.setColorAt(index, tracer.color);
    if (this.tracerMesh.instanceColor) this.tracerMesh.instanceColor.needsUpdate = true;
    this.rounds.push(round);
    this._placeRound(round);
  }

  /**
   * The server settled a flying round (`bullet` event). A round that stopped
   * before the predicted wall (a body, a hull, a mine) ends there; legs past
   * its first contact (penetration, ricochet) draw as resolved streaks.
   * `local` marks the viewer's own round: its predicted launch carries no
   * shooter id, so it matches the oldest local round of that weapon.
   */
  settleRound(event, { local = false } = {}) {
    const path = Array.isArray(event?.paths) ? event.paths[0] : null;
    if (!Array.isArray(path) || !path.length) return;
    let distance = 0, stop = path.length - 1;
    for (let i = 0; i < path.length; i++) {
      const segment = path[i];
      distance += Math.hypot(segment.end[0] - segment.o[0], segment.end[1] - segment.o[1], segment.end[2] - segment.o[2]);
      if (segment.hit) { stop = i; break; }
    }
    const id = String(event.id);
    const round = this.rounds.find(item => item.w === event.w && (local ? item.local || item.ownerId === id : item.ownerId === id));
    if (round) {
      const stopT = distance / round.profile.speed;
      if (round.end > stopT + 0.02) {
        round.end = Math.max(round.t, stopT);
        round.hit = path[stop].hit || null;
      }
    }
    const definition = WEAPONS[event.w];
    if (!definition?.tracer) return;
    for (let i = stop + 1; i < path.length; i++) {
      const segment = path[i];
      const direction = this._direction.set(
        segment.end[0] - segment.o[0], segment.end[1] - segment.o[1], segment.end[2] - segment.o[2]);
      const length = direction.length();
      if (length > 0.001) {
        direction.multiplyScalar(1 / length);
        this.spawnTracer(segment.o, direction, Math.min(length, definition.tracer.len), definition, null, 1, 0, false);
      }
      if (segment.hit && this.onWallImpact) this.onWallImpact(segment.hit, false);
    }
  }

  /** A free tracer slot, else the most expired streak (flying rounds never expire by age). */
  _claimTracer() {
    for (let i = 0; i < this.tracers.length; i++) if (!this.tracers[i].active) return i;
    const index = freeOldestIndex(this.tracers);
    const stolen = this.tracers[index].round;
    const at = stolen ? this.rounds.indexOf(stolen) : -1;
    if (at >= 0) this.rounds.splice(at, 1);
    this.tracers[index].round = null;
    return index;
  }

  _endRound(i, impact) {
    const round = this.rounds[i];
    this.rounds.splice(i, 1);
    const tracer = this.tracers[round.index];
    if (tracer.round === round) {
      tracer.round = null;
      tracer.active = false;
      tracer.t = 0;
      hideInstance(this.tracerMesh, round.index);
      this.tracerMesh.instanceMatrix.needsUpdate = true;
    }
    if (impact && round.hit && this.onWallImpact) this.onWallImpact(round.hit, round.local);
  }

  /** Streak from the tail point to the head point of the arc at the round's age. */
  _placeRound(round) {
    const speed = round.profile.speed;
    const head = ballisticPoint(round.profile, round.launch, round.t, this._roundHead || (this._roundHead = { x: 0, y: 0, z: 0 }));
    const tailT = Math.max(0, round.t - ROUND_STREAK_M / speed);
    const tail = ballisticPoint(round.profile, round.launch, tailT, this._roundTail || (this._roundTail = { x: 0, y: 0, z: 0 }));
    const headEase = Math.max(0, 1 - round.t * speed / ROUND_CONVERGE_M);
    const tailEase = Math.max(0, 1 - tailT * speed / ROUND_CONVERGE_M);
    const hx = head.x + round.ox * headEase, hy = head.y + round.oy * headEase, hz = head.z + round.oz * headEase;
    const tx = tail.x + round.ox * tailEase, ty = tail.y + round.oy * tailEase, tz = tail.z + round.oz * tailEase;
    const length = Math.hypot(hx - tx, hy - ty, hz - tz);
    const tracer = this.tracers[round.index];
    if (length < 1e-4) { hideInstance(this.tracerMesh, round.index); return; }
    this._position.set((hx - tx) / length, (hy - ty) / length, (hz - tz) / length);
    this._rotation.setFromUnitVectors(NEG_Z, this._position);
    this._scale.set(tracer.w, tracer.w, length);
    this._matrix.compose(this._position.set(tx, ty, tz), this._rotation, this._scale);
    this._matrix.elements[3] = ROUND_PHASE;
    this._matrix.elements[7] = 0;
    this.tracerMesh.setMatrixAt(round.index, this._matrix);
    this.tracerMesh.instanceMatrix.needsUpdate = true;
  }

  updateRounds(dt) {
    for (let i = this.rounds.length - 1; i >= 0; i--) {
      const round = this.rounds[i];
      if (this.tracers[round.index].round !== round) { this.rounds.splice(i, 1); continue; }
      round.t += dt;
      if (round.t >= round.end) { this._endRound(i, true); continue; }
      this._placeRound(round);
    }
  }

  /** `pinned` (remote fire) keeps the streak's shooter end on the muzzle for its whole life. */
  spawnTracer(origin, direction, length, definition, endpoint = null, charge = 1, muzzleOffset = 0.35, pinned = false) {
    if (definition && !definition.tracer) return;
    let index = -1;
    for (let i = 0; i < this.tracers.length; i++) {
      if (!this.tracers[i].active) {
        index = i;
        break;
      }
    }
    if (index < 0) index = this._claimTracer();

    const tracer = this.tracers[index];
    tracer.active = true;
    tracer.t = 0;
    tracer.round = null;
    tracer.anchored = false;
    tracer.pinned = !!pinned;
    // Local shots snapshot the rig muzzle and aim toward the
    // eye-ray endpoint, so the streak starts at the visible barrel tip and converges
    // on the crosshair impact. A degenerate muzzle-on-target falls back to the eye ray.
    let dirX = direction.x;
    let dirY = direction.y;
    let dirZ = direction.z;
    if (endpoint) {
      const m = this.muzzleProvider(this._muzzle);
      const ex = endpoint[0] - m.x;
      const ey = endpoint[1] - m.y;
      const ez = endpoint[2] - m.z;
      const beam = Math.hypot(ex, ey, ez);
      if (beam > 0.05) {
        dirX = ex / beam;
        dirY = ey / beam;
        dirZ = ez / beam;
        length = Math.min(length, beam);
        tracer.anchored = true;
      }
    }
    tracer.life = 0.055 + length * 0.0006;
    tracer.len = length;
    tracer.w = definition ? 0.028 * definition.tracer.width * chargeShotProfile(definition, charge).size : 0.03;
    tracer.color.set(definition ? definition.tracer.color : '#ffd27a');

    this._position.set(dirX, dirY, dirZ).normalize();
    this._rotation.setFromUnitVectors(NEG_Z, this._position);
    const px = tracer.anchored ? this._muzzle.x : origin[0] + direction.x * muzzleOffset;
    const py = tracer.anchored ? this._muzzle.y : origin[1] + direction.y * muzzleOffset;
    const pz = tracer.anchored ? this._muzzle.z : origin[2] + direction.z * muzzleOffset;
    this._scale.set(tracer.w, tracer.w, length);
    this._matrix.compose(
      this._position.set(px, py, pz),
      this._rotation,
      this._scale,
    );
    this._matrix.elements[3] = 0; // life phase (see TRACER_VERTEX)
    this._matrix.elements[7] = tracer.pinned ? 1 : 0;
    this.tracerMesh.setMatrixAt(index, this._matrix);
    this.tracerMesh.setColorAt(index, tracer.color);
    tracer.px = px;
    tracer.py = py;
    tracer.pz = pz;
    tracer.qx = this._rotation.x;
    tracer.qy = this._rotation.y;
    tracer.qz = this._rotation.z;
    tracer.qw = this._rotation.w;
    this.tracerMesh.instanceMatrix.needsUpdate = true;
    if (this.tracerMesh.instanceColor) {
      this.tracerMesh.instanceColor.needsUpdate = true;
    }
  }

  spawnFlash(origin, rawDirection, muzzleOffset = 0.35) {
    let index = -1;
    for (let i = 0; i < this.flashes.length; i++) {
      if (!this.flashes[i].active) {
        index = i;
        break;
      }
    }
    if (index < 0) {
      index = 0;
      for (let i = 1; i < this.flashes.length; i++) {
        if (this.flashes[i].t >= this.flashes[index].t) index = i;
      }
    }

    const flash = this.flashes[index];
    const direction = directionInto(this._direction, rawDirection);
    flash.active = true;
    flash.t = 0;
    flash.life = 0.045;
    flash.x = origin[0] + direction.x * muzzleOffset;
    flash.y = origin[1] + direction.y * muzzleOffset;
    flash.z = origin[2] + direction.z * muzzleOffset;
    // A spiky star covers less area than the old soft disc, so it runs a little larger.
    flash.size = 0.55 + Math.random() * 0.35;
    this._matrix.makeScale(flash.size, flash.size, flash.size).setPosition(flash.x, flash.y, flash.z);
    this.flashMesh.setMatrixAt(index, this._matrix);
    this.flashState.setXYZ(index, Math.random() * TAU, Math.floor(Math.random() * FLASH_FRAMES), 1);
    this.flashMesh.instanceMatrix.needsUpdate = true;
    this.flashState.needsUpdate = true;
  }

  updateTracers(dt) {
    let dirty = false;
    for (let i = 0; i < this.tracers.length; i++) {
      const tracer = this.tracers[i];
      if (!tracer.active || tracer.round) continue;
      dirty = true;
      tracer.t += dt;
      if (tracer.t >= tracer.life) {
        tracer.active = false;
        hideInstance(this.tracerMesh, i);
        continue;
      }
      // A fired streak stays in world space while the barrel recoils or turns; only
      // its life phase advances (see TRACER_VERTEX for the local/remote shapes).
      this._position.set(tracer.px, tracer.py, tracer.pz);
      this._scale.set(tracer.w, tracer.w, tracer.len);
      this._rotation.set(tracer.qx, tracer.qy, tracer.qz, tracer.qw);
      this._matrix.compose(this._position, this._rotation, this._scale);
      this._matrix.elements[3] = tracer.t / tracer.life;
      this._matrix.elements[7] = tracer.pinned ? 1 : 0;
      this.tracerMesh.setMatrixAt(i, this._matrix);
    }
    if (dirty) this.tracerMesh.instanceMatrix.needsUpdate = true;
  }

  updateFlashes(dt) {
    let dirty = false;
    for (let i = 0; i < this.flashes.length; i++) {
      const flash = this.flashes[i];
      if (!flash.active) continue;
      dirty = true;
      flash.t += dt;
      if (flash.t >= flash.life) {
        flash.active = false;
        hideInstance(this.flashMesh, i);
        this.flashState.setZ(i, 0);
        continue;
      }
      this.flashState.setZ(i, 1 - flash.t / flash.life);
    }
    if (dirty) {
      this.flashMesh.instanceMatrix.needsUpdate = true;
      this.flashState.needsUpdate = true;
    }
  }

  update(dt) {
    this.updateRounds(dt);
    this.updateTracers(dt);
    this.updateFlashes(dt);
  }

  reset() {
    this.rounds.length = 0;
    for (let i = 0; i < this.tracers.length; i++) {
      this.tracers[i].round = null;
      this.tracers[i].active = false;
      this.tracers[i].t = 0;
      hideInstance(this.tracerMesh, i);
    }
    this.tracerMesh.instanceMatrix.needsUpdate = true;
    for (let i = 0; i < this.flashes.length; i++) {
      const flash = this.flashes[i];
      flash.t = 0;
      flash.active = false;
      hideInstance(this.flashMesh, i);
      this.flashState.setZ(i, 0);
    }
    this.flashMesh.instanceMatrix.needsUpdate = true;
    this.flashState.needsUpdate = true;
    this.stats.shots = 0;
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.scene.remove(this.tracerMesh);
    this.tracerMesh.dispose();
    this.tracerMesh.geometry.dispose();
    this.tracerMesh.material.dispose();
    this.scene.remove(this.flashMesh);
    this.flashMesh.dispose();
    this.flashMesh.geometry.dispose();
    this.flashMesh.material.dispose();
    // The atlas is shared with every first-person flash; it is page-owned.
  }
}
