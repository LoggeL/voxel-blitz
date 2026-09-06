import { GRENADE_TYPES } from '../../shared/grenade-rules.js';
import { WEAPONS } from '../../shared/combatmath.js';
import { shuffledGunGameOrder } from '../../server/modes/gungame.js';
import { ProjectileSystem } from '../../server/sim/projectiles.js';

export function runGunGameRulesContracts(ok) {
  const order = Object.keys(WEAPONS);
  const a = shuffledGunGameOrder(order, () => 0);
  const b = shuffledGunGameOrder(order, () => 0.99);
  ok(a.at(-1) === 'knife' && b.at(-1) === 'knife' && new Set(a).size === order.length
    && a.join(',') !== b.join(','), 'Gun Game shuffle varies the full ladder while keeping knife last');
  const grenadeSystem = new ProjectileSystem();
  const victim = { id: 'self', state: 'alive', x: 0, y: 0, z: 0, hp: 100, vx: 0, vy: 0, vz: 0, panic: 0,
    takeDamage() { throw new Error('Gun Game grenade dealt player damage'); } };
  for (const type of ['frag', 'limpet', 'pulse']) {
    grenadeSystem._damagePlayers(victim, [0, 1, 0], GRENADE_TYPES[type], { type }, {
      now: 0, getBlock: () => 0, grenadeDamage: false, entities: new Map([['self', victim]]),
    });
  }
  ok(victim.hp === 100 && victim.vy > 30, 'Gun Game grenades cannot damage even their owner');
}
