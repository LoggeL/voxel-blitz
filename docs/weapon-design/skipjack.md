# GL-3 SKIPJACK

Compact grenade launcher with a side-swing three-slot cassette on a vertical front hinge. Its 40 mm rounds leave the muzzle at 32 m/s and
follow a gravity arc of 11 m/s². A round arms after 160 ms, bounces from up to
four solid faces, and detonates on an armed body contact or on the next surface
after its bounce budget runs out. If nothing stops it, it airbursts after 1.8
seconds. A bank retains 65% of the normal impact speed before wall or floor
damping, so aimed wall and floor shots carry useful momentum.

| Stat | Value |
| --- | ---: |
| Fire rate | 115 rpm |
| Loaded | 3 rounds: 1 chambered + 2 in the cassette |
| Reserve | 2 spare cassettes of 3 rounds |
| Tactical swap (round chambered) | 2.3 s, back to 3 |
| Empty swap (charging stroke) | 2.8 s, back to 3 |
| Splash | 60 raw, 4.5 m radius |
| Direct hit bonus | 20 raw |
| Damage falloff | `(1 - distance / 4.5)^1.15` |
| Self damage | 35% of normal blast damage |
| Terrain damage | 2.8 m radius, 145 power, up to 32 blocks |

The shared 0.8 combat multiplier caps a direct center hit at 64 HP. A nearby
non-contact target takes at most 48 HP at the blast center. Three quick shots
can pressure a corner while the visible arc and short fuse reward a deliberate
bank angle. In the stationary ideal-aim simulation, two direct hits at 10 m
kill in 0.8 s; the lower arc still registers hits at 50 m, while 56 m misses
before the 1.8 s fuse expires.

## Chamber and cassette

One round is enclosed in the chamber (`chamber: 1`). The flank cassette shows
the rounds outside it, packed from the top: 3 total shows 2, 2 shows 1, and
1 or 0 shows none. On each shot, the chambered round fires, the next exposed
round lifts to the feed port and slides into the chamber, and the remaining
rounds move up to the top slots. A fresh three-round cassette fills all three
external slots during an empty reload. The charging stroke moves its top round
into the chamber and leaves two visible.

`shared/reload.js` applies the rule on the server and in client prediction:

* A tactical swap (a round still chambered) drops the old cassette with its rounds,
  keeps the chambered round and needs no charging stroke: 2.3 s, three total
  with two in the new cassette.
* An empty swap racks the charging pawl, which lifts and slides the top fresh
  round into the chamber: 2.8 s, three total with two left in the cassette.

The starting load and two spare three-round cassettes provide nine shots per
life. `tools/skipjack-ammo-test.mjs` pins the reload rule, the upgrade and that
life total. The 160 ms arm period reduces point-blank self-detonations; the
owner is also protected from contact for the existing 220 ms projectile grace
window. Gun Game keeps the weapon's direct and splash damage enabled, while
ordinary throwable grenade damage remains disabled there.

An MGL detonation can also breach terrain within 2.8 m, with 145 nominal power
and a 32-block limit per blast. The server applies material resistance, line of
sight, world bounds and protected-block rules before sending block changes.
The client uses those changes to spawn material-matched debris from its shared
particle pool.

Chaos Lab upgrades add two ricochets, then increase splash damage by 10% and
the radius to 4.8 m. The final tier adds a round to every cassette: 4 total
after either reload, with at most 3 exterior rounds visible in the modeled
cassette. Even with the blast upgrade, a direct center hit deals at most 68.8
HP after the global damage scale.
