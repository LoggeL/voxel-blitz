import * as THREE from '../vendor/three.module.js';
import { createMapState } from '../../../shared/worlddata.js';
import { findMapCaptureShot, resolveMapCaptureShot } from '../../../shared/map-capture-shots.js';
import { FRONTIER_PLAN } from '../../../shared/conquest-contract.js';
import { WorldView } from '../engine/worldview.js';
import { CombatPostProcess } from '../engine/combat-post-process.js';
import { rendererCapabilities, resolveGraphicsProfile } from '../engine/graphics-quality.js';

// Static, muted map captures: no game loop, network, audio or HUD. Optional
// layers: ?vehicles=1 parks the authored fleet (plus a shot's staged hull),
// voxel-lit through VehicleView.lightingRoot(); ?weather=golden|mist|overcast
// overrides the Frontier mood; ?ambience=1 adds the Conquest chimney plumes,
// wreck columns and off-map salvos through the shared ParticleField;
// ?avatars=1 and ?explosion= as before. Any failed request fails the capture.

const params = new URLSearchParams(location.search);
const map = params.get('map') || 'foundry';
const shotId = params.get('shot') || 'hero';
const authored = findMapCaptureShot(map, shotId);

if (!authored) throw new Error(`unknown map capture: ${map}/${shotId}`);

const canvas = document.getElementById('capture');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
renderer.toneMapping = THREE.NeutralToneMapping;
// Captures review the live look: the same tier knobs and post chain as a match.
// ?quality=low|medium|high|ultra picks a tier (default high), ?post=0 the raw scene.
const graphics = resolveGraphicsProfile(params.get('quality') || 'high', rendererCapabilities(renderer));
const post = params.get('post') === '0' ? null : new CombatPostProcess(renderer, {
  maxPixelRatio: 1,
  msaa: graphics.msaa,
  hdr: graphics.hdr,
  bloomLevels: graphics.bloomLevels,
  fxaa: graphics.msaa === 0,
  ssao: graphics.ssao,
});
renderer.setPixelRatio(1);
renderer.setSize(innerWidth, innerHeight, false);
post?.setSize(innerWidth, innerHeight, 1);

const world = createMapState(map);

/** Standing height of the loaded world's ground (the first open cell above the ground column). */
function worldSurface(x, z) {
  const { sy } = world.dimensions;
  const ix = Math.floor(x), iz = Math.floor(z);
  let y = Math.max(0, Math.min(sy - 1, (Number.isFinite(world.meta?.groundLevel) ? world.meta.groundLevel : 1) - 1));
  if (world.getBlock(ix, y, iz) !== 0) {
    while (y < sy - 1 && world.getBlock(ix, y + 1, iz) !== 0) y++;
    return y + 1;
  }
  while (y > 0 && world.getBlock(ix, y - 1, iz) === 0) y--;
  return y;
}

// Frontier cameras stand on the planned terrain; a world that is not the
// planned one yet (other dimensions) is measured directly instead.
const plan = FRONTIER_PLAN.dimensions;
const planned = world.dimensions.sx === plan.sx && world.dimensions.sy === plan.sy && world.dimensions.sz === plan.sz;
const shot = authored.anchor
  ? resolveMapCaptureShot(authored, { surfaceY: planned ? null : worldSurface, meta: world.meta })
  : authored;

const overview = shot.kind === 'orthographic';
const far = map === 'frontier' ? 3000 : 400;
const camera = overview
  ? new THREE.OrthographicCamera(-shot.scale / 2, shot.scale / 2, shot.scale / 2, -shot.scale / 2, 0.05, far)
  : new THREE.PerspectiveCamera(shot.fov, innerWidth / innerHeight, 0.05, far);
if (overview) camera.up.set(0, 0, -1);
camera.position.fromArray(shot.position);
camera.lookAt(new THREE.Vector3().fromArray(shot.target));
camera.updateProjectionMatrix();

const worldview = new WorldView({ getBlock: world.getBlock, meta: world.meta }, world.meta, {
  graphics, renderer, captureTerrainStep: overview ? 8 : null, weather: params.get('weather'),
});
post?.setGrade(worldview.palette.grade);
// Detail streams around a point a little ahead of the camera, so both the
// foreground and the subject of a long view are drawn at full resolution.
const lookFrom = new THREE.Vector3().fromArray(shot.position), lookAt = new THREE.Vector3().fromArray(shot.target);
const detailCenter = overview ? lookAt : lookFrom.clone().lerp(lookAt, Math.min(0.5, 96 / Math.max(1, lookFrom.distanceTo(lookAt))));
worldview.setViewPosition(detailCenter);
await worldview.ready();
await worldview.skyUpdate.ready;
worldview.setGameMode(shot.mode);
// Conquest objectives show the round-start state the server sets
// (server/modes/conquest/capture.js reset): home flags owned at full control,
// every other flag neutral, as the v2 wire rows a match snapshot carries.
if (shot.mode === 'conquest' && Array.isArray(world.meta?.conquest?.flags)) {
  const { encodeConquestFlag, teamSign } = await import('../../../shared/conquest.js');
  const home = (flag) => (flag.home === 'alpha' || flag.home === 'bravo' ? flag.home : null);
  worldview.setMatch({ conquest: { v: 2, flags: world.meta.conquest.flags.map((flag) => encodeConquestFlag({
    id: flag.id, owner: home(flag), control: teamSign(home(flag)), state: 'idle', alpha: 0, bravo: 0,
  })) } });
}
worldview.scene.add(camera);

// Optional parked vehicles use the same models, materials and authored spawns
// as a match; a shot may stage one hull in the air (heli-river, jet-sky).
let vehicles = null;
// The overview is the minimap/big-map base image: the HUD paints live hulls on it.
if (params.get('vehicles') === '1' && world.meta?.conquest && !overview) {
  const [{ VehicleView }, { vehicleDef }, { VEHICLE_STATUS, vehicleMountOrder }] = await Promise.all([
    import('../engine/vehicle-view.js'), import('../../../shared/vehicle-defs.js'), import('../../../shared/conquest-contract.js'),
  ]);
  vehicles = new VehicleView({ getBlock: world.getBlock });
  // Parked, uncrewed hulls on their authored pads, engines off; a flag pad's
  // hull (flag:'C') stands where its spawn is authored.
  const rows = world.meta.conquest.vehicleSpawns.map((spawn) => {
    const def = vehicleDef(spawn.type);
    return {
      id: spawn.id, type: spawn.type, team: spawn.team ?? null, x: spawn.x, y: spawn.y, z: spawn.z,
      yaw: spawn.yaw, pitch: 0, roll: 0, turretYaw: spawn.yaw, turretPitch: 0, speed: 0,
      hp: def.hp, st: VEHICLE_STATUS.grounded, mounts: vehicleMountOrder(spawn.type).map(() => [spawn.yaw, 0, 1, 0, 0]),
      seatOccupants: {}, occupantId: null, grounded: true, enginePower: 0, rotorSpeed: 0,
      ...(spawn.flag ? { flag: spawn.flag } : {}),
    };
  });
  if (shot.stage) {
    const staged = rows.find(row => row.id === shot.stage.vehicle);
    if (staged) {
      [staged.x, staged.y, staged.z] = shot.stage.position;
      staged.yaw = staged.turretYaw = shot.stage.yaw ?? staged.yaw;
      staged.mounts = staged.mounts.map(() => [staged.yaw, 0, 1, 0, 0]);
      staged.speed = 30; staged.throttle = 0.8; staged.grounded = false; staged.enginePower = 0.8;
      staged.rotorSpeed = staged.type === 'helicopter' || staged.type === 'transport' ? 1 : 0;
      staged.st = VEHICLE_STATUS.engine;
    }
  }
  const self = { id: 'capture', team: 'alpha' };
  vehicles.sync(rows, [], self);
  worldview.scene.add(vehicles.group);
  worldview.addCharacterRoots(vehicles.lightingRoot());
  worldview.dynamicShadows?.addCasterRoot(vehicles.group, { coarse: true });
  // Settle suspension, ground attitude and rotors with fixed steps.
  for (let i = 0; i < 90; i++) { vehicles.sync(rows, [], self); vehicles.update(1 / 60, camera); }
}

// Conquest ambience: chimney plumes, wreck columns and off-map salvos through
// the shared particle field, simulated forward so plumes have formed.
let ambience = null, particles = null;
// The north-up overview is the minimap and lobby image: no smoke over the flags.
if (shot.mode === 'conquest' && params.get('ambience') === '1' && world.meta?.conquest && !overview) {
  const [{ ParticleField }, { particleCapacityForTier }, { ConquestAmbience }] = await Promise.all([
    import('../fx/particle-field.js'), import('../fx/presets.js'), import('../engine/conquest-ambience.js'),
  ]);
  particles = new ParticleField({ scene: worldview.scene, capacity: particleCapacityForTier(graphics.tier) });
  ambience = new ConquestAmbience({ scene: worldview.scene, fx: particles, mapMeta: world.meta,
    weather: worldview.weather || 'golden', getBlock: world.getBlock });
  for (let i = 0; i < 16 * 30; i++) { ambience.update(1 / 30, camera); particles.update(1 / 30, camera); }
}
// Opt-in blast review: ?explosion=frag|limpet|rocket|pulse|molotov|shell (tank HE blast plus an AP tracer in flight), ?explosionAge=s, ?explosionAt=x,y,z.
const explosion = params.get('explosion') ? (await import('./explosion-capture.js')).stageCaptureExplosion({
  type: params.get('explosion'), age: params.get('explosionAge') ?? 0.12, at: params.get('explosionAt'),
  scene: worldview.scene, camera, getBlock: world.getBlock,
}) : null;

// Two synchronous frames let sky callbacks and matrices settle without
// introducing gameplay, network, avatar, HUD, weapon state, or a headless
// requestAnimationFrame dependency before the document load event.
// ?avatars=1 stands a few static avatars in the shot (character light, contact shadows).
const captureAvatars = params.get('avatars') === '1'
  ? await (await import('./capture-avatars.js')).placeCaptureAvatars(worldview, camera, world.getBlock, params) : null;
if (!captureAvatars && vehicles) {
  worldview.presentCharacters({ camera, dt: 0, roster: typeof vehicles.addContactShadows === 'function' ? vehicles : null, bodyPosition: null });
}
// Keep capture detail centered on the subject, including aerial camera positions.
worldview.update(0);
// Flags settle on their authored state; markers size for this camera.
worldview.conquest?.update(10, camera);
if (overview) {
  // A map, not a view: no fog, no cloud puffs or air motes drawn over the flags,
  // and no flag markers, beams or rings: the minimap and big map paint the live
  // flag state over this image, so a baked round-start ownership would lie.
  worldview.scene.fog = null;
  if (worldview.conquest?.group) worldview.conquest.group.visible = false;
  const sky = worldview.scene.getObjectByName('sky');
  for (const child of sky?.children || []) if (child.name !== 'skydome') child.visible = false;
  if (worldview.ambience?.points) worldview.ambience.points.visible = false;
}
// Late roots (vehicles, particles) take the large-world far fade before the first frame.
worldview.syncFarFog();
const frame = () => (post ? post.render(worldview.scene, camera, { time: 0, adaptInstant: true }) : renderer.render(worldview.scene, camera));
frame();
frame();

// ?probe=1: scene handles for scripted render probes (hide a layer, re-export).
if (params.get('probe') === '1') window.__vbProbe = { scene: worldview.scene, camera, worldview, frame, THREE };
document.documentElement.dataset.captureReady = 'true';
document.documentElement.dataset.captureMap = map;
document.documentElement.dataset.captureShot = shotId;
window.__vbCapture = Object.freeze({
  map,
  shot: shotId,
  mode: shot.mode,
  position: shot.position,
  target: shot.target,
  fov: shot.fov,
  weather: worldview.weather,
  projection: overview ? 'orthographic' : 'perspective',
  extent: overview ? [0, 0, shot.scale, shot.scale] : null,
  terrain: worldview.farTerrain?.stats || null,
  light: worldview.lightVolume?.stats || null,
  backdrop: worldview.backdrop?.stats || null,
  tufts: worldview.grassTufts?.stats || null,
  conquest: worldview.conquest?.stats || null,
  ambience: ambience?.stats || null,
  particles: particles?.stats || null,
  vehicles: vehicles ? world.meta.conquest.vehicleSpawns.length : 0,
  graphics,
  post: post?.stats || null,
  avatars: captureAvatars,
  explosion,
  // Export the renderer's complete frame at its real buffer size. Browser panel
  // screenshots can clip a tall emulated viewport to the visible panel height.
  exportPng: () => { frame(); return canvas.toDataURL('image/png'); },
});
