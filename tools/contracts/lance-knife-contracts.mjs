import { bulletPower } from '../../shared/bullet-material.js';
// Charge scaling and melee math; roster, prices, firing and reload lifecycle
// are covered by the shared-mode, server-combat and viewmodel contracts.

export async function runLanceKnifeContracts(ok) {
  const { WEAPONS, chargeDamageMult, chargeShotProfile, reloadPlan, damageAtDistance } =
    await import('../../shared/combatmath.js');
  const lance = WEAPONS.lance;
  const tap = chargeShotProfile(lance, 0), half = chargeShotProfile(lance, 0.5);
  const full = chargeShotProfile(lance, 1);
  ok(bulletPower(lance, 0) < bulletPower(lance, 0.5) && bulletPower(lance, 0.5) < bulletPower(lance, 1)
      && tap.hitRadius < half.hitRadius && half.hitRadius < full.hitRadius
      && tap.size < half.size && half.size < full.size
      && Math.round(chargeDamageMult(lance, 0.5) * 300) === 93,
    'rail charge grows damage, body radius, beam size and terrain penetration together');

  const knife = WEAPONS.knife;
  const melee = knife.melee;
  ok(melee.reach === 2.2 && melee.coneDeg === 110
      && melee.backstabMult === 2.5 && melee.backstabDot === 0.4,
    'the RIPPER swings a 2.2-unit 110-degree arc and backstabs for 2.5x past a 0.4 facing dot');

  ok(chargeDamageMult(lance, 0) === 0.08
      && chargeDamageMult(lance, 0.25) < chargeDamageMult(lance, 0.5)
      && chargeDamageMult(lance, 0.5) < chargeDamageMult(lance, 0.75)
      && chargeDamageMult(lance, 1) === 1,
    'lance charge damage ramps monotonically from the 0.08 tap floor to full at one');

  ok(reloadPlan(knife, 0).rounds === 0,
    'the RIPPER reload plan seats zero rounds, so the reload path never engages');
  ok(reloadPlan(lance, 0).seconds === 2.9,
    'an empty VOLTLANCE cell swaps in one 2.9 s step');

  ok(damageAtDistance(knife, 2) === 58,
    'a RIPPER swing deals flat 58 inside its reach with no falloff');

}
