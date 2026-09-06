// Lance/knife seam: shared-definition contracts for the CL-9 VOLTLANCE charge
// rail-lance and the K-7 RIPPER melee knife. Presentation (viewmodels, swing
// arcs, SFX) is verified visually by the orchestrator; here we pin the roster
// shape and shared math every consumer (client prediction, server authority,
// HUD, wheel) relies on.

export async function runLanceKnifeContracts(ok) {
  const { WEAPONS, WEAPON_IDS, chargeProfile, chargeDamageMult, chargeShotProfile, reloadPlan, damageAtDistance } =
    await import('../../shared/combatmath.js');
  const { GUN_GAME_WEAPON_ORDER, WEAPON_PRICES } = await import('../../shared/modes.js');
  const { BOLT_RULES, boltBounces } = await import('../../shared/bolt-rules.js');
  const { wheelAngleForSlot, wheelSlotFromVector } = await import('../../public/js/ui/weapon-wheel.js');

  ok(WEAPON_IDS.length === 10 && WEAPON_IDS[8] === 'lance' && WEAPON_IDS[9] === 'knife',
    'the roster holds ten weapons with VOLTLANCE and RIPPER in the last two slots');

  const lance = WEAPONS.lance;
  ok(lance && lance.name === 'CL-9 VOLTLANCE' && lance.mode === 'charge',
    'the VOLTLANCE is a named charge-mode weapon');
  ok(lance.magSize === 1 && lance.spareMags === 5,
    'the VOLTLANCE carries one shot per cell plus five spares');
  ok(lance.rpm === 100 && JSON.stringify(lance.damage) === JSON.stringify([300, 220, 95])
      && lance.falloffStart === 45,
    'the VOLTLANCE spears for 300 body damage at rpm 100 with falloff starting at 45 units');
  const lanceCharge = lance.charge;
  ok(lanceCharge.ms === 2800 && lanceCharge.holdMaxMs === 2800
      && lanceCharge.minDamageMult === 0.08,
    'the VOLTLANCE reaches full power at 2800 ms and allows early releases');
  ok(lanceCharge.wallPierceAt === 0,
    'terrain piercing is available even on an early release');
  ok(lance.pierce.players === 6 && lance.pierce.walls === 8
      && lance.pierce.playerFalloff === 0.9 && lance.pierce.wallFalloff === 0.9,
    'a charged lance spears up to six enemies on the line and crosses up to eight blocks, decaying 0.9 per body and wall');

  const tap = chargeShotProfile(lance, 0), half = chargeShotProfile(lance, 0.5);
  const full = chargeShotProfile(lance, 1);
  ok(tap.walls === 1 && half.walls === 4 && full.walls === 8
      && tap.hitRadius < half.hitRadius && half.hitRadius < full.hitRadius
      && tap.size < half.size && half.size < full.size
      && Math.round(chargeDamageMult(lance, 0.5) * 300) === 93,
    'rail charge grows damage, body radius, beam size and terrain penetration together');

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

  ok(GUN_GAME_WEAPON_ORDER.length === 10 && GUN_GAME_WEAPON_ORDER[6] === 'longarc'
      && GUN_GAME_WEAPON_ORDER[7] === 'lance' && GUN_GAME_WEAPON_ORDER[9] === 'knife',
    'Gun Game puts the VOLTLANCE right after the LONGARC and the RIPPER last in a ten-step ladder');

  ok(WEAPON_PRICES.lance === 3800 && WEAPON_PRICES.knife === 500,
    'the VOLTLANCE costs 3800 credits and the RIPPER 500 in the S&D armory');

  // Guard the defaults: the LONGARC keeps its charge profile inside the shared
  // defaults (no lance-style wall piercing, no chain arc anywhere in the game)
  // and launches bouncing bolts from shared/bolt-rules.js.
  const longarc = chargeProfile(WEAPONS.longarc);
  ok(longarc.wallPierceAt === 0 && chargeProfile(lance).chainAt === undefined
      && longarc.chainAt === undefined,
    'the LONGARC never pierces walls and the chain-arc thresholds are deleted from both charge profiles');
  ok(WEAPONS.longarc.projectile === 'bolt' && WEAPONS.longarc.magSize === 8
      && JSON.stringify(WEAPONS.longarc.damage) === JSON.stringify([88, 62, 95]),
    'the LONGARC launches bouncing bolts with its unchanged 88/62/95 damage and 8-round cell');
  ok(BOLT_RULES.bouncesTap === 1 && BOLT_RULES.bouncesCharged === 1
      && boltBounces(0) === 1 && boltBounces(0.99) === 1 && boltBounces(1) === 1,
    'bolt reflections follow bolt-rules.js: exactly one bounce for every shot');
  ok(BOLT_RULES.speed === 52 && BOLT_RULES.gravity === 3.0
      && BOLT_RULES.blockDamage === 18 && BOLT_RULES.lifetimeMs === 3000,
    'bolts fly at 52 u/s under gravity 3.0, chew 18 damage per wall contact, and fizzle after 3000 ms');
  ok(BOLT_RULES.color === '#7dfcff',
    'bolts and their shared color come from bolt-rules.js');

  // Wheel geometry stays count-agnostic: a ten-slot wheel just tightens the
  // wedge angle; slot 9 sits at -90 + 324, normalized to 234 degrees.
  ok(wheelAngleForSlot(9, 10) === 234,
    'a ten-slot wheel puts slot 9 at 234 degrees in atan2 space');
  ok(wheelSlotFromVector(Math.sin((9 * Math.PI) / 5), -Math.cos((9 * Math.PI) / 5), 10) === 9,
    'the ten-slot wheel resolves its own slot 9 angle back to slot 9');
}
