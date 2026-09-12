# Career cosmetics

The first collection contains three weapon skins, two character skins, three death signatures and three original sound kits. Every weapon remains playable in every mode where that mode permits it. Gun Game uses its own weapon order and applies the player's equipped skin to each matching weapon.

| Item | Slot | Level | Additional requirement |
| --- | --- | ---: | --- |
| Ignition | Death signature | 5 | None |
| Arcade | Sound kit | 10 | None |
| Overdrive | Rifle skin | 15 | 250 rifle PvP kills |
| Salvager | Character skin | 25 | None |
| Circuit | Death signature | 25 | None |
| High Noon | Revolver skin | 35 | 1,000 revolver PvP kills |
| High Noon | Sound kit | 35 | None |
| Overdrive | Sound kit | 50 | None |
| Foundry | Minigun skin | 75 | 5,000 minigun PvP kills |
| Sovereign | Death signature | 75 | None |
| Revenant | Character skin | 100 | 10,000 PvP kills |

All listed requirements must be satisfied. Earned items are granted automatically and cost no career credits. Original HUD themes and callsigns keep their existing prices. The career page previews locked items, exposes each requirement separately, and supports an independent weapon skin per weapon plus a character, signature and sound kit. Each slot can return to standard.

The existing XP curve is unchanged: level N starts at `(N - 1)^2 * 100` XP. Level 50 requires 240,100 XP, level 100 requires 980,100 XP. These are initial content gates, not a measured play-time promise. The mastery display marks 250, 1,000, 5,000 and 10,000 human kills. Only explicit catalog entries grant items; the other tier markers are progress milestones.

## Attribution and persistence

The server counts accepted kill events, including the actual weapon used before a Gun Game stage advance. Training, bots, self-kills and teammate kills do not count toward PvP mastery. Bots still award their original reduced career XP and credits. Wins count completed matches; individual Search and Destroy round wins do not count as match wins.

Existing XP, credits, kills, matches, purchases and equipment are preserved. Historical PvP attribution and weapon mastery start at zero because earlier profiles did not record them. File-backed profiles migrate when read. PostgreSQL adds immutable migration 2 (`schema-cosmetics.sql`) after checking the existing migration checksum; mastery, PvP kills and wins persist through account adoption and restart.

Equipment is checked against the server's catalog and owned inventory. Client-provided item URLs or arbitrary model IDs are never used. Live snapshots carry the authoritative loadout for each player; kill events carry the killer's loadout for the death signature. Cached loadouts refresh after admission, profile reads, rewards, equip and reset. The simulation does not query the database every tick. Revoked identities return to standard presentation.

## Rendering

Each skin is an individual module under `public/js/cosmetics/skins/`. `SkinLayer` clones changed materials and owns added details so equipping one player cannot recolor another. Removing a skin restores original materials and releases its added GPU resources. Gun details remain attached to their existing magazine, bolt and rotor parents. Team-colored character cloth is retained. Hitboxes, handling, damage, muzzle markers and sight anchors are unchanged.

The local gun, third-person carried gun and killcam use the same skin modules. Character palettes also affect local gun gloves and the visible local body. Added character details participate in normal death fades. The inventory images are rendered from these actual models, not separate illustrations.

`/cosmetic-preview.html` provides an inspection view, standard comparison, first-person weapon view, character rear view and PNG export. This page only previews models; it cannot grant or equip inventory.

## Audio

Each kit contains `kill.ogg`, `death.ogg`, `victory.ogg` and `sources.json`. Original ElevenLabs requests, request IDs when provided, reported character costs, source/output hashes and mastering settings are retained in each manifest; generation scripts read the existing Keychain credential without storing it in the project.

The killer hears their short kill confirmation. The victim hears the killer's death sting, which stops on respawn. At a completed match, the winner's kit plays; team wins use the highest-kill human on the winning team, with player ID breaking a tie. Joining during a result screen does not replay the anthem. Late kill confirmations cannot interrupt victory music.

Cosmetic channels share the gameplay master bus and also have separate volume/mute controls in the career page. Only one cosmetic cue plays at a time. Suspended or unloaded cues are skipped rather than queued, death/reset/disconnect clears voices, and hiding the page stops them. Locked kits can be auditioned in the collection; changing selection or closing it stops that preview.

Audio is checked for codec, duration, peaks, clipping and provenance. Signal checks do not replace a listening review.

## Validation

- `npm run career:test`: legacy career behavior, new authority and persistence contracts, UI state and sound preview lifecycle, runtime material isolation and bounded audio.
- `node tools/cosmetics-career-test.mjs --postgres`: isolated real PostgreSQL migration and restart checks.
- `npm test`: repository regression suite.
- Browser verification: real model inspection and first-person views, locked/earned inventory, equip/reset, sound previews and responsive layout.

Completed checks and the limits of the browser/audio review are recorded in [the validation note](design/cosmetics/validation.md).
