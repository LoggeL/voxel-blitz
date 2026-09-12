import { PlayerEntity } from '../../server/sim/player.js';
import { ProjectileSystem, PROJECTILE_RULES } from '../../server/sim/projectiles.js';

// Measure one real authority explosion. Distance is from the impact to the
// player's damage sample at feet + 1.05 m, not to the body surface.
export function simulateBlast({ distance = 0, direct = false, blocked = false,
  self = false, armor = 0, type = 'rocket' } = {}) {
  if (!Number.isFinite(distance) || distance < 0 || distance > 30)
    throw new Error('Invalid blast distance');
  const owner = new PlayerEntity('blast-owner', 'Owner', { x: 60, y: 20, z: 100 });
  const target = new PlayerEntity('blast-target', 'Target', { x: 100 + distance, y: 20, z: 100 });
  target.armor = armor;
  const system = new ProjectileSystem();
  const shooter = self ? target : owner;
  const projectile = { id: 'blast-fixture', type, owner: shooter, ownerId: shooter.id,
    x: 100, y: 21.05, z: 100, directVictim: direct ? target : null };
  let damage = 0;
  const takeDamage = target.takeDamage.bind(target);
  target.takeDamage = (amount, ...args) => { damage += amount; return takeDamage(amount, ...args); };
  const solidAt = x => blocked && x === 101;
  const ctx = { now: 1000, entities: new Map([[target.id, target]]),
    canDamage: () => true, solidAt, getBlock: x => solidAt(x) ? 3 : 0,
    destroyBlock: () => false, pushEvent() {},
    killPlayer: victim => { victim.state = 'dead'; } };
  system.active.set(projectile.id, projectile);
  system.explode(projectile, ctx);
  return { distance, direct, blocked, self, damage, hpLeft: target.hp, armorLeft: target.armor,
    killed: target.state === 'dead', impulse: Math.hypot(target.vx, target.vy, target.vz) };
}

export function blastProfile() {
  return { rules: PROJECTILE_RULES.rocket, direct: simulateBlast({ direct: true }),
    samples: Array.from({ length: 29 }, (_, i) => simulateBlast({ distance: i / 4 })),
    covered: simulateBlast({ distance: 3, blocked: true }) };
}
