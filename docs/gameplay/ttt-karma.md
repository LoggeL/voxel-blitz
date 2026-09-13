# TTT Classic karma

Source checked on 2026-09-13: [Facepunch karma.lua](https://github.com/Facepunch/garrysmod/blob/master/garrysmod/gamemodes/terrortown/gamemode/karma.lua), [player.lua](https://github.com/Facepunch/garrysmod/blob/master/garrysmod/gamemodes/terrortown/gamemode/player.lua), and [C4](https://github.com/Facepunch/garrysmod/blob/master/garrysmod/gamemodes/terrortown/entities/entities/ttt_c4/shared.lua).

Uses Classic defaults, not TTT2 or community-server presets:

| Setting | Value |
| --- | --- |
| Starting / maximum | 1000 / 1000 |
| Friendly damage ratio | 0.001 |
| Friendly kill equivalent damage | 15 |
| Round increment / clean bonus | 5 / 30 |
| Traitor damage reward ratio | 0.0003 |
| Traitor kill equivalent damage | 40 |
| Strict damage curve | enabled |
| Minimum outgoing damage factor | 10% |
| Automatic removal threshold | ≤450 after round rewards |
| Temporary ban | 60 minutes |
| Disk persistence | disabled |

Friendly damage costs victim live karma × min(damage × 0.001, 1). Only remaining victim HP counts. Innocents damaging traitors earn 1000 × min(damage × 0.0003, 1); a traitor kill therefore gives 12 karma. Traitors attacking innocents earn nothing.

For base karma below 1000, outgoing damage uses 1 + 0.0007k − 0.000002k², where k = base karma − 1000, clamped to 0.1–1. Knife and self damage are exempt. Traitor-on-traitor C4 damage and deaths have no karma penalty.

Round-end rewards update base karma; the next round applies its damage factor. Only base karma is public during play, so individual karma changes do not disclose hidden roles. Session memory uses the server-established account or guest profile, never the player name. It survives reconnections and lobby changes, but not server restarts, matching the original persistence default. Browser guests have no Steam identity; deleting their guest identity is equivalent to using another account.

The game retains its own HP, armor, weapons and damage balance. Karma formulas and default values follow the cited sources.
