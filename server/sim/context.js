import { damageBlock, destroyBlockDirect } from './combat.js';

/**
 * Room-scoped ports into the engine. Callbacks are allocated once, including
 * terrain operations called hundreds of times by a blast. Live getters keep a
 * retained context current when the clock, mode, or engine state changes.
 */
export function createSimulationContexts(engine) {
  const combat = {
    get now() { return engine.now; },
    get entities() { return engine.entities; },
    get blockHp() { return engine.blockHp; },
    get flames() { return engine.flames; },
    solidAt: engine.solidAt,
    getBlock: (x, y, z) => engine.world.getBlock(x, y, z),
    setBlock: (x, y, z, value) => engine.world.setBlock(x, y, z, value),
    canFire: (player) => engine.mode.canFire(player),
    canBurn: () => engine.mode.phase === 'live',
    canUseWeapon: (player, weapon) => engine.mode.canUseWeapon(player, weapon),
    canDamage: (attacker, target) => engine.mode.canDamage(attacker, target),
    killPlayer: (victim, killer, weapon, headshot, markers) => (
      engine.killPlayer(victim, killer, weapon, headshot, markers)
    ),
    pushBlockDelta: (x, y, z, value) => engine.pushBlockDelta(x, y, z, value),
    pushEvent: (event) => engine.tickEvents.push(event),
    computeConeDeg: (player) => engine.computeConeDeg(player),
    chaosBlast: (player, origin, type, radius, damage, knockback) => (
      engine.projectiles.chaosBlast(player, origin, type, radius, damage, knockback, projectiles)
    ),
    launchRocket: (player, dir) => engine.projectiles.launchRocket(player, projectiles, dir),
    launchBolt: (player, dir, charge) => engine.projectiles.launchBolt(player, projectiles, dir, charge),
  };
  const projectiles = {
    get now() { return engine.now; },
    get entities() { return engine.entities; },
    get grenadeDamage() { return engine.mode.mode !== 'gungame'; },
    solidAt: combat.solidAt,
    getBlock: combat.getBlock,
    canAffectWorld: combat.canBurn,
    canThrow: (player) => !player.vault && engine.mode.canFire(player),
    canDamage: combat.canDamage,
    killPlayer: combat.killPlayer,
    pushEvent: combat.pushEvent,
    destroyBlock: (x, y, z) => destroyBlockDirect(x, y, z, null, combat),
    damageBlock: (x, y, z, type, damage) => damageBlock(x, y, z, type, damage, combat),
  };
  const movement = {
    get now() { return engine.now; },
    get mapMeta() { return engine.mapMeta; },
    solidAt: combat.solidAt,
    movementLocked: false,
    onFall: (entity, reason) => {
      if (reason === 'invalid') engine.forceRespawn(entity);
      else engine.killPlayer(entity, null, 'world', false);
    },
  };
  return { combat, projectiles, movement };
}
