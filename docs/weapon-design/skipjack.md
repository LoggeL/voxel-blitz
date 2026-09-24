# GL-3 SKIPJACK

Compact grenade launcher with a side-swing three-slot cassette on a vertical front hinge. Its 40 mm rounds leave the muzzle at 26 m/s and
follow a gravity arc of 11 m/s². A round arms after 160 ms, bounces from up to
four solid faces, and detonates on an armed body or surface contact. If nothing
stops it, it airbursts after 2.6 seconds.

| Stat | Value |
| --- | ---: |
| Fire rate | 70 rpm |
| Loaded | 3 rounds: 1 chambered + 2 in the cassette |
| Reserve | 3 spare cassettes of 2 rounds |
| Tactical swap (round chambered) | 2.3 s, back to 3 |
| Empty swap (charging stroke) | 2.8 s, back to 2 |
| Splash | 60 raw, 4.5 m radius |
| Direct hit bonus | 20 raw |
| Damage falloff | `(1 - distance / 4.5)^1.15` |
| Self damage | 35% of normal blast damage |
| Terrain damage | None |

The shared 0.8 combat multiplier caps a direct center hit at 64 HP. A nearby
non-contact target takes at most 48 HP at the blast center. Its slow cadence and
visible arcing flight give opponents time to move between shots.

## Chamber and cassette

One round is enclosed in the chamber (`chamber: 1`). The flank cassette only shows
the reserve outside it, filled from the bottom slot: 3 total shows 2, 2 shows 1,
1 or 0 shows none. Firing uses the chambered round; no exterior round travels to the
muzzle. Each cassette carries `magSize - 1` rounds, so the third slot stays empty in
the standard loadout and is filled by the Chaos Lab spare chamber.

`shared/reload.js` applies the rule on the server and in client prediction:

* A tactical swap (a round still chambered) drops the old cassette with its rounds,
  keeps the chambered round and needs no charging stroke: 2.3 s, total `magSize`.
* An empty swap racks the charging pawl, which strips the top fresh round into the
  chamber: 2.8 s, total `magSize - 1`.

Before revision 13, every swap dropped the chambered round too and took 2.8 s,
although a tactical swap has nothing to chamber. The third spare cassette keeps the
life total at nine rounds (`3 + 3 x 2`, the former `3 + 2 x 3`). Burst damage,
radius and cadence are unchanged; a player who empties the launcher now reloads one
more time per life, while a disciplined tactical swap is 0.5 s faster.
`tools/skipjack-ammo-test.mjs` pins the rule, the upgrade and the life total. The 160 ms arm period reduces point-blank
self-detonations; the owner is also protected from contact for the existing 220 ms
projectile grace window. Gun Game keeps the weapon's direct and splash damage enabled,
while ordinary throwable grenade damage remains disabled there.

Chaos Lab upgrades add two ricochets, then increase splash damage by 10% and the radius
to 4.8 m. The final tier adds a round to every cassette: 4 total after a tactical
swap, 3 after an empty swap, with all three exterior slots visible. Even with the blast upgrade, a direct
center hit deals at most 68.8 HP after the global damage scale.
