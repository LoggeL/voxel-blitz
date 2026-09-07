import { chaosLevel } from '../../shared/chaos.js';
import { WEAPONS } from '../../shared/combatmath.js';
import { FLAME_RULES } from '../../shared/flame-rules.js';
import { raycastVoxels } from '../../shared/raycast.js';
import { evHit, evShoot } from '../protocol/events.js';

function fan(p, ctx, dir, count, rocket = false, circle = false) {
  for (let i = 0; i < count; i++) {
    const a = circle ? i / count * Math.PI * 2 : (i - (count - 1) / 2) * 0.2;
    const d = { x: dir.x * Math.cos(a) - dir.z * Math.sin(a),
      y: dir.y, z: dir.x * Math.sin(a) + dir.z * Math.cos(a) };
    const length = Math.hypot(d.x, d.y, d.z) || 1;
    d.x /= length; d.y /= length; d.z /= length;
    if (rocket) ctx.launchRocket?.(p, d);
    else ctx.launchBolt?.(p, d, 1);
  }
}

function flameJets(p, ctx, dir) {
  if (!ctx.flames) return;
  const origin = [p.x, p.eyeY, p.z];
  for (const angle of [-0.2, 0.2]) {
    // The normal center packet launches after this hook. Reserve its slot.
    if (ctx.flames.active?.length >= FLAME_RULES.maxProjectiles - 1) break;
    const d = { x: dir.x * Math.cos(angle) - dir.z * Math.sin(angle),
      y: dir.y, z: dir.x * Math.sin(angle) + dir.z * Math.cos(angle) };
    ctx.flames.launch(p, origin, d, ctx);
    const direction = [d.x, d.y, d.z];
    ctx.pushEvent?.({ ...evShoot(p.id, origin, direction, 'flamethrower', direction), chaosFlame: true });
  }
}

export function chaosShot(p, ctx, dir) {
  const id = WEAPONS[p.def.id].id, level = chaosLevel(p, id);
  if (!level) return;
  if (id === 'rifle' && level >= 3 && p.shotSeq % 3 === 0) fan(p, ctx, dir, 1);
  if (id === 'smg') {
    if (p.shotSeq % 3 === 0) fan(p, ctx, dir, level >= 2 ? 2 : 1);
    if (level >= 3 && p.shotSeq % 6 === 0) fan(p, ctx, dir, 1, true);
  }
  if (id === 'shotgun') {
    if (level >= 2) fan(p, ctx, dir, 3);
    if (level >= 3) ctx.chaosBlast?.(p, [p.x + dir.x * 4, p.eyeY + dir.y * 4, p.z + dir.z * 4], 'pulse', 5, 25, 25);
  }
  if (id === 'sniper' && level >= 3) fan(p, ctx, { ...dir, y: Math.min(0.8, dir.y + 0.22) }, 3, true);
  if (id === 'lmg' && p.shotSeq % (level >= 2 ? 3 : 5) === 0) fan(p, ctx, dir, level >= 3 ? 3 : 1, true);
  if (id === 'minigun') {
    if (level >= 2 && p.shotSeq % 10 === 0) fan(p, ctx, dir, 3);
    if (level >= 3 && p.shotSeq % 20 === 0) fan(p, ctx, dir, 8, false, true);
  }
  if (id === 'flamethrower') {
    flameJets(p, ctx, dir);
    if (level >= 2 && p.shotSeq % 10 === 0) {
      // Keep the backdraft on the shooter's side of cover, just like the fire.
      const wall = raycastVoxels(ctx.solidAt, p.x, p.eyeY, p.z, dir.x, dir.y, dir.z, 6);
      const reach = wall ? Math.max(0, wall.t - 0.1) : 6;
      ctx.chaosBlast?.(p, [p.x + dir.x * reach, p.eyeY + dir.y * reach, p.z + dir.z * reach], 'pulse', 4, 18, 20);
    }
    if (level >= 3 && p.shotSeq % 20 === 0) fan(p, ctx, dir, 1, true);
  }
  if (id === 'revolver' && level >= 3) fan(p, ctx, dir, 6, false, true);
  if (id === 'lance' && level >= 3) fan(p, ctx, dir, 8, false, true);
  if (id === 'knife') {
    ctx.chaosBlast?.(p, level >= 2 ? [p.x, p.y + 0.2, p.z] : [p.x + dir.x * 3, p.eyeY, p.z + dir.z * 3], 'pulse', level >= 2 ? 6 : 3, 45, level >= 2 ? 30 : 12);
    if (level >= 3) fan(p, ctx, dir, 3);
  }
}

export function chaosHit(p, victim, point, ctx) {
  const id = p.def.id, level = chaosLevel(p, id);
  if (!level) return;
  if ((id === 'sniper' || id === 'revolver') && level >= 2) ctx.chaosBlast?.(p, point, 'frag', 3.5, 42, 10);
  if (id === 'shotgun' && victim.state === 'alive') {
    const dx = victim.x - p.x, dz = victim.z - p.z, len = Math.hypot(dx, dz) || 1;
    victim.vx += dx / len * 3; victim.vz += dz / len * 3; victim.vy = Math.max(9, victim.vy);
    victim.impulseSeq = (victim.impulseSeq || 0) + 1; victim.grounded = false; victim.vault = null;
  }
  const count = id === 'rifle' ? (level >= 2 ? 4 : 2) : id === 'revolver' ? 2 : id === 'lance' && level >= 2 ? 4 : 0;
  if (!count) return;
  const targets = [...ctx.entities.values()].filter(v => v !== p && v !== victim && v.state === 'alive' && ctx.canDamage(p, v))
    .map(v => ({ v, d: Math.hypot(v.x - point[0], v.eyeY - point[1], v.z - point[2]) }))
    .filter(({ d }) => d > 0.1 && d < 9).sort((a, b) => a.d - b.d);
  let hit = 0;
  for (const { v, d } of targets) {
    const dir = [(v.x - point[0]) / d, (v.eyeY - point[1]) / d, (v.z - point[2]) / d];
    if (raycastVoxels(ctx.solidAt, ...point, ...dir, d - 0.1)) continue;
    ctx.pushEvent({ ...evShoot(p.id, point, dir, 'lance', dir), chaosArc: true, reach: d, charge: 0.35 });
    const lethal = v.takeDamage(28, false);
    ctx.pushEvent(evHit(p.id, v.id, 28, false, [v.x, v.eyeY, v.z], v.lastDamage));
    if (lethal) ctx.killPlayer(v, p, id, false);
    else if (id === 'rifle' && level >= 2) { v.vy = Math.max(v.vy, 12); v.grounded = false; v.vault = null; v.impulseSeq = (v.impulseSeq || 0) + 1; }
    if (++hit >= count) break;
  }
}
