import { bulletPower } from '../../shared/bullet-material.js';
// Charge scaling, knife reach and reload plans. Swing target selection,
// backstab kills, wall blocking and charged lance fire are covered in
// tools/atlastest.mjs; the reload lifecycle in tools/reload-*-test.mjs.

export async function runLanceKnifeContracts(ok) {
  const { WEAPONS, WEAPON_IDS, PLAYER_HALF, chargeDamageMult, chargeShotProfile, reloadPlan, damageAtDistance } =
    await import('../../shared/combatmath.js');
  const { combatDamage } = await import('../../shared/combat-balance.js');
  const { GameEngine } = await import('../../server/game.js');
  const { resolveWeaponIntent } = await import('../../server/sim/combat.js');
  const { AIR } = await import('../../shared/worlddata.js');
  const lance = WEAPONS.lance;
  const tap = chargeShotProfile(lance, 0), half = chargeShotProfile(lance, 0.5);
  const full = chargeShotProfile(lance, 1);
  ok(bulletPower(lance, 0) < bulletPower(lance, 0.5) && bulletPower(lance, 0.5) < bulletPower(lance, 1)
      && tap.hitRadius < half.hitRadius && half.hitRadius < full.hitRadius
      && tap.size < half.size && half.size < full.size,
    'rail charge grows damage, body radius, beam size and terrain penetration together');

  const knife = WEAPONS.knife;
  const melee = knife.melee;
  // One authoritative knife swing along +x on an open lane. The victim stands
  // `forward` ahead and `side` to the left; `facing` is its yaw (PI/2 faces
  // the pick, -PI/2 looks along the swing and takes a backstab).
  function swing(forward, side = 0, facing = Math.PI / 2) {
    const engine = new GameEngine();
    for (let x = 36; x <= 48; x++) for (let y = 15; y <= 20; y++) {
      for (let z = 34; z <= 47; z++) engine.world.setBlock(x, y, z, AIR);
    }
    engine.addClient('blade', 'Blade');
    engine.addClient('victim', 'Victim');
    const shooter = engine.entities.get('blade');
    const victim = engine.entities.get('victim');
    Object.assign(shooter, { x: 40, y: 15, z: 40.5, yaw: -Math.PI / 2, pitch: 0,
      weapon: WEAPON_IDS.indexOf('knife'), cooldown: 0, deployT: 0,
      spawnProtected: false, spawnProtectedUntil: 0 });
    Object.assign(victim, { x: 40 + forward, y: 15, z: 40.5 + side, yaw: facing, pitch: 0, hp: 1000,
      spawnProtected: false, spawnProtectedUntil: 0 });
    engine.applyInput('blade', { yaw: shooter.yaw, pitch: 0, wantFire: true });
    engine.tickEvents.length = 0;
    resolveWeaponIntent(shooter, 0.016, engine.contexts.combat);
    const result = { hits: engine.tickEvents.filter((event) => event.kind === 'hit').length,
      damage: 1000 - victim.hp };
    engine.stop();
    return result;
  }
  const front = swing(melee.reach * 0.5);
  const back = swing(melee.reach * 0.5, 0, -Math.PI / 2);
  ok(front.hits === 1 && Math.abs(front.damage - combatDamage(knife.damage[0])) < 1e-9
      && back.hits === 1 && back.damage > front.damage,
    'an IRON PICK swing inside its reach deals base damage and a backstab deals more');
  ok(swing(melee.reach + PLAYER_HALF.x + 0.1).hits === 0,
    'an IRON PICK swing misses a victim beyond its reach');
  const coneProbe = (deg) => swing(melee.reach * 0.6 * Math.cos(deg * Math.PI / 180),
    melee.reach * 0.6 * Math.sin(deg * Math.PI / 180)).hits;
  ok(coneProbe(melee.coneDeg / 4) === 1 && coneProbe(Math.min(89, melee.coneDeg / 2 + 15)) === 0,
    'an IRON PICK swing hits inside its arc and misses a victim beside it');

  ok(0 < chargeDamageMult(lance, 0)
      && chargeDamageMult(lance, 0) < chargeDamageMult(lance, 0.25)
      && chargeDamageMult(lance, 0.25) < chargeDamageMult(lance, 0.5)
      && chargeDamageMult(lance, 0.5) < chargeDamageMult(lance, 0.75)
      && chargeDamageMult(lance, 1) === 1,
    'lance charge damage ramps monotonically from a nonzero tap floor to full at one');

  ok(reloadPlan(knife, 0).rounds === 0,
    'the IRON PICK reload plan seats zero rounds, so the reload path never engages');
  const lanceReload = reloadPlan(lance, 0);
  ok(lanceReload.rounds === 1 && lanceReload.seconds > 0 && lanceReload.seconds === lance.reloadTime,
    'an empty VOLTLANCE cell swaps in one full-reload step');

  ok(damageAtDistance(knife, melee.reach * 0.25) === knife.damage[0]
      && damageAtDistance(knife, melee.reach) === knife.damage[0],
    'an IRON PICK swing deals flat damage inside its reach with no falloff');

}
