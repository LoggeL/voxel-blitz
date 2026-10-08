// Opt-in explosion review for the map capture page. One seeded blast of the
// requested type lands where the camera's view ray meets the ground (or at an
// explicit `x,y,z`, or a single number capping the distance along that ray), then the real ProjectileFX steps at a fixed 60 Hz up to
// the requested age, so the same URL always renders the same frame. The blast
// radius is the authoritative damage radius the server sends in
// projectileExplode; `?explosionRadius=` overrides it (chaos-sized blasts).
import { ProjectileFX } from '../weapons/projectiles.js';
import { raycastVoxels } from '../../../shared/raycast.js';
import { isSolidBlock } from '../../../shared/world/blocks.js';
import { GRENADE_TYPES } from '../../../shared/grenade-rules.js';
import { ROCKET_RULES } from '../../../shared/rocket-rules.js';
import { VEHICLE_WEAPON_META } from '../../../shared/conquest-contract.js';
import { VEHICLE_WEAPONS } from '../../../shared/vehicle-defs.js';

function blastRadius(type, override) {
  const forced = Number(override);
  if (Number.isFinite(forced) && forced > 0) return forced;
  if (type === 'rocket') return ROCKET_RULES.damageRadius;
  if (type === 'shell') return VEHICLE_WEAPONS.tankHE.splashRadius;
  return GRENADE_TYPES[type]?.damageRadius ?? 5;
}

function groundPoint(getBlock, camera, at) {
  const parts = String(at || '').split(',').map(Number);
  if (parts.length === 3 && parts.every(Number.isFinite)) return { x: parts[0], y: parts[1], z: parts[2] };
  // A single number caps the distance along the view ray.
  const reach = parts.length === 1 && parts[0] > 0 ? parts[0] : 120;
  const solid = (x, y, z) => isSolidBlock(getBlock(x, y, z));
  const origin = camera.position;
  const direction = camera.getWorldDirection(camera.position.clone());
  const hit = raycastVoxels(solid, origin.x, origin.y, origin.z, direction.x, direction.y, direction.z, reach);
  const t = hit ? Math.max(0, hit.t - 0.6) : Math.min(reach, 30);
  const x = origin.x + direction.x * t, z = origin.z + direction.z * t;
  let y = Math.floor(origin.y + direction.y * t);
  // Settle onto the first floor below the contact, like a grenade at rest.
  while (y > 0 && !solid(Math.floor(x), y - 1, Math.floor(z))) y--;
  return { x, y: y + 0.25, z };
}

/** Stage a blast in `scene`; returns what it placed for the capture summary. */
export function stageCaptureExplosion({ type = 'frag', age = 0.12, at = null, radius = null, scene, camera, getBlock }) {
  const fx = new ProjectileFX(scene, getBlock, { camera });
  fx.explosions.seed(0x5eed);
  const point = groundPoint(getBlock, camera, at);
  const override = radius ?? (typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('explosionRadius'));
  const size = blastRadius(type, override);
  const dt = 1 / 60;
  const steps = Math.max(1, Math.round(Math.max(0, Number(age) || 0) / dt));
  if (type === 'shell') {
    // An AP round crossing the view: its tracer streak sits near the blast when the frame is taken.
    const right = camera.getWorldDirection(camera.position.clone()).cross({ x: 0, y: 1, z: 0 }).normalize();
    const meta = VEHICLE_WEAPON_META.tankAP;
    const from = [point.x - right.x * 70, point.y + 7, point.z - right.z * 70];
    const to = [point.x + right.x * 40, point.y + 2, point.z + right.z * 40];
    const span = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
    const dir = to.map((n, i) => (n - from[i]) / span);
    fx.launch({ pid: 'capture-shell', type: 'shell', o: from, v: dir.map(n => n * meta.speed), fuse: 4000, vehicleWeapon: 'tankAP', g: meta.gravity });
    const lead = Math.max(0, Math.round(64 / meta.speed / dt) - steps);
    for (let i = 0; i < lead; i++) fx.update(dt);
  }
  fx.explode({ pid: 'capture', type, x: point.x, y: point.y, z: point.z, radius: size, vehicleWeapon: type === 'shell' ? 'tankHE' : undefined });
  for (let i = 0; i < steps; i++) fx.update(dt);
  return {
    type, age: steps * dt, point, radius: size,
    sprites: fx.explosions.activeSprites,
    scorch: fx.explosions.scorch.mesh.count,
    lights: fx._lights.map((light) => Math.round(light.intensity * 100) / 100),
  };
}
