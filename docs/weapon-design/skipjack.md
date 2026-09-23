# GL-3 SKIPJACK

Compact grenade launcher with a side-swing three-round cassette. Its 40 mm rounds leave the muzzle at 26 m/s and
follow a gravity arc of 11 m/s². A round arms after 160 ms, bounces from up to
four solid faces, and detonates on an armed body or surface contact. If nothing
stops it, it airbursts after 2.6 seconds.

| Stat | Value |
| --- | ---: |
| Fire rate | 70 rpm |
| Cassette | 3 rounds |
| Reserve | 2 spare cassettes |
| Reload | 2.8 s |
| Splash | 60 raw, 4.5 m radius |
| Direct hit bonus | 20 raw |
| Damage falloff | `(1 - distance / 4.5)^1.15` |
| Self damage | 35% of normal blast damage |
| Terrain damage | None |

The shared 0.8 combat multiplier caps a direct center hit at 64 HP. A nearby
non-contact target takes at most 48 HP at the blast center. The launcher has a
three-round cassette and two spare cassettes, but its slow cadence and visible arcing flight
give opponents time to move between shots. The 160 ms arm period reduces point-blank
self-detonations; the owner is also protected from contact for the existing 220 ms
projectile grace window. Gun Game keeps the weapon's direct and splash damage enabled,
while ordinary throwable grenade damage remains disabled there.

Chaos Lab upgrades add two ricochets, then increase splash damage by 10% and the radius
to 4.8 m. The final tier adds a fourth seated round. Even with the blast upgrade, a direct
center hit deals at most 68.8 HP after the global damage scale.
