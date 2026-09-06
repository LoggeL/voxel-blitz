// Server-owned fire status. Repeated hits refresh one burn, never stack DPS.
import { WEAPONS, damageAtDistance } from '../../shared/combatmath.js';
import { playerHitboxes, rayPlayerHitboxes } from '../../shared/player-hitboxes.js';
import { raycastVoxels } from '../../shared/raycast.js';
import { evHit } from '../protocol.js';

// Test the actual stance volumes: the central jet catches close-range head/limb
// hits, while samples across each oriented box cover the widening flame cone.
// Every accepted point has its own terrain ray, including partially exposed bodies.
function flameContact(victim, eye, direction, range, cosHalf, solidAt) {
  function visible(point, checkCone = true) {
    const delta = point.map((v, i) => v - eye[i]);
    const distance = Math.hypot(...delta);
    if (distance > range || distance < 0.001) return null;
    const dir = delta.map(v => v / distance);
    if (checkCone && dir[0] * direction.x + dir[1] * direction.y + dir[2] * direction.z < cosHalf) return null;
    if (raycastVoxels(solidAt, ...eye, ...dir, distance)) return null;
    return { point, distance };
  }
  const direct = rayPlayerHitboxes(eye, direction, victim, range);
  if (direct) {
    const contact = visible([eye[0] + direction.x * direct.t,
      eye[1] + direction.y * direct.t, eye[2] + direction.z * direct.t], false);
    if (contact) return contact;
  }
  for (const box of playerHitboxes(victim)) {
    const center = visible(box.center);
    if (center) return center;
    // Face centers and inset corners retain narrow visible parts at cover edges.
    for (const sample of BOX_SAMPLES) {
      const point = box.center.map((v, axis) => v + sample.reduce((offset, sign, basis) =>
        offset + sign * box.half[basis] * 0.95 * box.basis[basis][axis], 0));
      const contact = visible(point);
      if (contact) return contact;
    }
  }
  return null;
}
const BOX_SAMPLES = [
  [-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1],
  ...[-1, 1].flatMap(x => [-1, 1].flatMap(y => [-1, 1].map(z => [x, y, z]))),
];

export function fireFlame(owner, eye, direction, ctx) {
  const def = owner.def;
  const cosHalf = Math.cos(def.flame.coneDeg * Math.PI / 360);
  for (const victim of ctx.entities.values()) {
    if (victim === owner || victim.state !== 'alive' || !ctx.canDamage(owner, victim)) continue;
    // Cheap conservative reject before constructing the stance hitboxes.
    if (Math.hypot(victim.x - eye[0], victim.y - eye[1], victim.z - eye[2]) > def.range + 3) continue;
    const contact = flameContact(victim, eye, direction, def.range, cosHalf, ctx.solidAt);
    if (!contact) continue;
    const { point, distance } = contact;
    const damage = Math.round(damageAtDistance(def, distance) * 10) / 10;
    const lethal = victim.takeDamage(damage, false);
    ctx.pushEvent(evHit(owner.id, victim.id, damage, false, point));
    if (lethal) { ctx.killPlayer(victim, owner, def.id, false); continue; }
    victim.burn = { owner, remaining: def.flame.duration, elapsed: victim.burn?.elapsed || 0 };
    victim.burning = def.flame.duration;
    victim.panic = Math.max(victim.panic, def.flame.panicFloor);
  }
}

export function updateBurn(victim, dt, ctx) {
  const burn = victim.burn;
  if (!burn) return;
  if (victim.state !== 'alive' || ctx.canBurn?.() === false || !ctx.canDamage(burn.owner, victim)) {
    victim.burn = null;
    victim.burning = 0;
    return;
  }
  const rules = WEAPONS.flamethrower.flame;
  const elapsed = Math.min(burn.remaining, Math.max(0, dt));
  burn.remaining = Math.max(0, burn.remaining - elapsed);
  burn.elapsed += elapsed;
  victim.burning = burn.remaining;
  victim.panic = Math.max(victim.panic, rules.panicFloor);
  // Half-second hit events keep damage feedback and network traffic bounded.
  if (burn.elapsed >= 0.5 - 1e-9 || burn.remaining <= 0) {
    const damage = rules.damagePerS * burn.elapsed;
    burn.elapsed = 0;
    const lethal = victim.takeDamage(damage, false);
    ctx.pushEvent(evHit(burn.owner.id, victim.id, damage, false,
      [victim.x, victim.eyeY, victim.z]));
    if (lethal) ctx.killPlayer(victim, burn.owner, 'flamethrower', false);
  }
  if (burn.remaining <= 0 || victim.state !== 'alive') {
    victim.burn = null;
    victim.burning = 0;
  }
}
