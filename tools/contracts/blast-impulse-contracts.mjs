import { ProjectileSystem, PROJECTILE_RULES } from '../../server/sim/projectiles.js';
import { PlayerPhysics } from '../../public/js/player-physics.js';
import { makeSnapshot } from '../../server/protocol/snapshot.js';

export function runBlastImpulseContracts(ok) {
  const system = new ProjectileSystem();
  function blast(type, distance, { self = false, harmless = false, blocked = false } = {}) {
    const target = { id: 'target', state: 'alive', x: distance, y: 0, z: 0,
      vx: 0, vy: 0, vz: 0, grounded: true, coyote: 0.08, vault: {}, panic: 0,
      hp: 1000, takeDamage(damage) { this.hp -= damage; return false; } };
    const owner = self ? target : { id: 'owner' };
    const events = [];
    system._damagePlayers(owner, [0, 1.05, 0], PROJECTILE_RULES[type], { type }, {
      now: 1, grenadeDamage: !harmless, entities: new Map([['target', target]]),
      canDamage: () => true, getBlock: (x) => blocked && x === 1 ? 3 : 0,
      pushEvent: (event) => events.push(event), killPlayer() {},
    });
    return { target, events };
  }
  const pulse = blast('pulse', 2, { harmless: true });
  const rocket = blast('rocket', 2);
  const selfRocket = blast('rocket', 2, { self: true });
  ok(pulse.target.vx > 30 && pulse.target.vy > 24 && pulse.target.hp === 1000
    && pulse.events.length === 0, 'Gun Game pulse launches players strongly without damage or hit events');
  ok(rocket.target.vx > 23 && rocket.target.vy > 18 && selfRocket.target.vx > rocket.target.vx,
    'rocket pressure launches bystanders and gives its owner a stronger rocket jump');
  ok(!pulse.target.grounded && pulse.target.coyote === 0 && pulse.target.vault === null,
    'pressure releases grounding and cancels vaulting instead of losing the launch');
  ok(blast('pulse', 3, { blocked: true }).target.vx === 0
    && blast('rocket', 5).target.vx === 0,
    'solid cover and the blast radius still bound pressure');
  const row = makeSnapshot([pulse.target], [], [], 1).players[0];
  const physics = new PlayerPhysics();
  physics.vault = {};
  ok(physics.adoptImpulse(row.impulse) && physics.vel.x > 30 && physics.vault === null,
    'the authoritative launch velocity reaches client prediction');
  physics.vel.x = 10;
  ok(!physics.adoptImpulse(row.impulse) && physics.vel.x === 10,
    'repeated snapshots cannot apply the same launch twice');
}
