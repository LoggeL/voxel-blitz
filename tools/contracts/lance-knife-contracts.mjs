// Lance/knife seam: shared-definition contracts for the CL-9 VOLTLANCE charge
// rail-lance and the K-7 RIPPER melee knife. Presentation (viewmodels, swing
// arcs, SFX) is verified visually by the orchestrator; here we pin the roster
// shape and shared math every consumer (client prediction, server authority,
// HUD, wheel) relies on.

export async function runLanceKnifeContracts(ok) {
  const { WEAPONS, WEAPON_IDS, chargeProfile, chargeDamageMult, reloadPlan, damageAtDistance } =
    await import('../../shared/combatmath.js');
  const { GUN_GAME_WEAPON_ORDER, WEAPON_PRICES } = await import('../../shared/modes.js');
  const { wheelAngleForSlot, wheelSlotFromVector } = await import('../../public/js/ui/weapon-wheel.js');

  ok(WEAPON_IDS.length === 10 && WEAPON_IDS[8] === 'lance' && WEAPON_IDS[9] === 'knife',
    'the roster holds ten weapons with VOLTLANCE and RIPPER in the last two slots');

  const lance = WEAPONS.lance;
  ok(lance && lance.name === 'CL-9 VOLTLANCE' && lance.mode === 'charge',
    'the VOLTLANCE is a named charge-mode weapon');
  ok(lance.magSize === 5 && lance.spareMags === 6,
    'the VOLTLANCE carries five charges per cell plus six spares');
  const lanceCharge = lance.charge;
  ok(lanceCharge.ms === 620 && lanceCharge.holdMaxMs === 1800
      && lanceCharge.minDamageMult === 0.45,
    'the VOLTLANCE charges in 620 ms, vents itself at 1800 ms, and taps for 45% damage');
  ok(lanceCharge.wallPierceAt > 1 && lanceCharge.chainAt > 1,
    'the VOLTLANCE disables wall piercing and chain arcs with unreachable above-range sentinels');
  ok(lance.pierce.players === 3 && lance.pierce.walls === 0
      && lance.pierce.playerFalloff === 0.82,
    'a charged lance spears up to three enemies on the line and dies on the first wall');

  const knife = WEAPONS.knife;
  ok(knife && knife.name === 'K-7 RIPPER' && knife.mode === 'melee',
    'the RIPPER is a named melee-mode weapon');
  ok(knife.magSize === 0 && knife.spareMags === 0,
    'the RIPPER holds no ammunition and never reloads');
  ok(knife.tracer === null,
    'the RIPPER fires no projectile line: the swing arc is presentation-only');
  const melee = knife.melee;
  ok(melee.reach === 2.2 && melee.coneDeg === 110
      && melee.backstabMult === 2.5 && melee.backstabDot === 0.4,
    'the RIPPER swings a 2.2-unit 110-degree arc and backstabs for 2.5x past a 0.4 facing dot');

  ok(chargeDamageMult(lance, 0) === 0.45
      && chargeDamageMult(lance, 0.25) < chargeDamageMult(lance, 0.5)
      && chargeDamageMult(lance, 0.5) < chargeDamageMult(lance, 0.75)
      && chargeDamageMult(lance, 1) === 1,
    'lance charge damage ramps monotonically from the 0.45 tap floor to full at one');

  ok(reloadPlan(knife, 0).rounds === 0,
    'the RIPPER reload plan seats zero rounds, so the reload path never engages');
  ok(reloadPlan(lance, 0).seconds === 2.4,
    'an empty VOLTLANCE cell swaps in one 2.4 s step');

  ok(damageAtDistance(knife, 2) === 58,
    'a RIPPER swing deals flat 58 inside its reach with no falloff');

  ok(GUN_GAME_WEAPON_ORDER.length === 10 && GUN_GAME_WEAPON_ORDER[6] === 'longarc'
      && GUN_GAME_WEAPON_ORDER[7] === 'lance' && GUN_GAME_WEAPON_ORDER[9] === 'knife',
    'Gun Game puts the VOLTLANCE right after the LONGARC and the RIPPER last in a ten-step ladder');

  ok(WEAPON_PRICES.lance === 3800 && WEAPON_PRICES.knife === 500,
    'the VOLTLANCE costs 3800 credits and the RIPPER 500 in the S&D armory');

  // Guard the sentinel approach: the LONGARC charge thresholds must stay inside
  // the 0-1 range so the lance's above-range defaults cannot leak back into it.
  const longarc = chargeProfile(WEAPONS.longarc);
  ok(longarc.wallPierceAt === 0.6 && longarc.chainAt === 0.85,
    'the LONGARC keeps piercing walls at 0.60 charge and chaining at 0.85');

  // Wheel geometry stays count-agnostic: a ten-slot wheel just tightens the
  // wedge angle; slot 9 sits at -90 + 324, normalized to 234 degrees.
  ok(wheelAngleForSlot(9, 10) === 234,
    'a ten-slot wheel puts slot 9 at 234 degrees in atan2 space');
  ok(wheelSlotFromVector(Math.sin((9 * Math.PI) / 5), -Math.cos((9 * Math.PI) / 5), 10) === 9,
    'the ten-slot wheel resolves its own slot 9 angle back to slot 9');
}
