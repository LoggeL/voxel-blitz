// One cumulative upgrade ladder per weapon/throwable. Authority owns purchases.
export const CHAOS_START_CREDITS = 600;
export const CHAOS_KILL_CREDITS = 300;
const CHAOS_PRICES = Object.freeze([300, 600, 900]);
const ladder = (...rows) => Object.freeze(rows.map(([name, description], i) => Object.freeze({ name, description, price: CHAOS_PRICES[i] })));
export const CHAOS_UPGRADES = Object.freeze({
  rifle: ladder(['Tesla rounds', 'Hits arc to 2 nearby enemies.'], ['Forklift lightning', 'Lightning forks to 4 enemies and kicks them into the air.'], ['Thunder tax', 'Every third shot also launches a ricocheting energy bolt.']),
  smg: ladder(['Pocket pinball', 'Every third shot spits out a bouncing energy bolt.'], ['Double trouble', 'Every third shot spits out two bolts in a fan.'], ['Bee problem', 'Every sixth shot also launches a homing rocket.']),
  shotgun: ladder(['Confetti cannon', 'Twice the pellets. Hits launch enemies backwards.'], ['Bowling alley', 'Every blast also fires three ricocheting bolts.'], ['Personal space', 'Each trigger pull detonates a forward shockwave.']),
  sniper: ladder(['Wall appointment', 'Rail rounds punch through 3 blocks and 4 bodies.'], ['Exit wound', 'Body hits detonate an explosive charge.'], ['Orbital complaint', 'Each shot fires a three-rocket fan above the sightline.']),
  lmg: ladder(['Belt-fed fireworks', 'Every fifth round launches a rocket.'], ['Demolition subscription', 'Every third round launches a rocket.'], ['Factory recall', 'Those rockets become a three-way homing salvo.']),
  revolver: ladder(['Debt collector', 'Hits chain to 2 nearby enemies.'], ['Six feet under', 'Body hits also explode.'], ['High noon everywhere', 'Each shot spits 6 bolts in a full circle.']),
  longarc: ladder(['Pinball wizard', 'Bolts ricochet 8 times.'], ['Multiball', 'Fire three bolts per shot, each with 8 bounces.'], ['Bumper bombs', 'Every wall bounce emits an explosive shockwave.']),
  rocket: ladder(['Family size', 'Giant rockets carve larger craters and blast a wider area.'], ['Bad GPS', 'Rockets steer toward visible enemies ahead.'], ['Custody battle', 'Detonations scatter six live cluster grenades.']),
  lance: ladder(['Tunnel licence', 'Charged rails punch through up to 24 blocks and 16 bodies.'], ['Tesla tunnel', 'Hits arc to 4 nearby enemies.'], ['Public transport', 'Each shot adds a ring of 8 ricocheting bolts.']),
  knife: ladder(['Air guitar', 'Every pickaxe swing launches a forward shockwave.'], ['Beyblade permit', 'The shockwave surrounds you and throws enemies skyward.'], ['Excavator tantrum', 'Swings also launch three bouncing energy bolts.']),
  minigun: ladder(['Queue shredder', 'Rounds punch through 3 bodies, losing 20% damage per body.'], ['Spin cycle', 'Every tenth round also fires 3 ricocheting bolts.'], ['Rotor riot', 'Every twentieth round also throws 8 bolts in a full circle.']),
  flamethrower: ladder(['Three-alarm fire', 'Two extra travelling flame jets widen every burst.'], ['Backdraft', 'Every tenth burst also erupts in a forward shockwave.'], ['Dragon breath', 'Every twentieth burst also launches a rocket.']),
  frag: ladder(['Kinder surprise', 'Detonation scatters 6 live mini-frags.'], ['Extended family', '12 mini-frags scatter over a wider area.'], ['Popcorn ceiling', 'Mini-frags erupt with extra launch force and larger craters.']),
  limpet: ladder(['Group hug', 'The flying charge steers toward visible enemies.'], ['Clingy friends', 'Detonation scatters 5 sticky charges.'], ['Separation anxiety', 'Sticky children home in too, then explode with a larger blast.']),
  pulse: ladder(['Reverse sneeze', 'The grenade pulls nearby enemies inward before impact.'], ['Space programme', 'Impact launches players high into the air.'], ['Afterparty', 'Impact scatters 8 bouncing pulse bombs with a delayed second launch.']),
  molotov: ladder(['Spill zone', 'Ground fire spreads to a 4.2 metre radius.'], ['Closing time', 'The wider ground fire lasts 10 seconds.'], ['Heat complaint', 'The wider, longer fire deals 40 damage per second.']),
});
function isChaosItem(id) { return typeof id === 'string' && Object.hasOwn(CHAOS_UPGRADES, id); }
export function chaosLevel(player, id) {
  return player?.chaosUpgrades && isChaosItem(id) ? Math.max(0, Math.min(3, player.chaosUpgrades[id] | 0)) : 0;
}
export function chaosPurchaseId(id, level) { return `chaos:${id}:${level + 1}`; }
export function parseChaosPurchase(value) {
  if (typeof value !== 'string') return null;
  const parts = value.split(':');
  if (parts.length !== 3 || parts[0] !== 'chaos' || !isChaosItem(parts[1]) || !/^[1-3]$/.test(parts[2])) return null;
  return { item: parts[1], level: Number(parts[2]) };
}

export function chaosWeaponDef(p, base) {
  const level = chaosLevel(p, base.id);
  if (!level) return base;
  if (base.id === 'shotgun') return { ...base, pellets: base.pellets * 2 };
  if (base.id === 'minigun') return { ...base,
    pierce: { players: 3, walls: 0, minWalls: 0, playerFalloff: 0.8, wallFalloff: 1 } };
  if (base.id === 'sniper' || base.id === 'lance') return { ...base,
    pierce: { players: base.id === 'lance' ? 16 : 4, walls: base.id === 'lance' ? 24 : 3,
      minWalls: base.id === 'lance' ? 3 : 3, playerFalloff: 1, wallFalloff: 1 } };
  return base;
}
