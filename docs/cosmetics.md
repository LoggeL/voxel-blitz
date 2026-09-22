# Career cosmetics

Cosmetics are nodes on the career unlock tree; see [progression](progression.md) for the tree itself, its branches and the full node table. This note covers how the cosmetics render, sound and persist.

The first collection contains three weapon skins, two character skins, three death signatures and three original sound kits. The redesign adds only data or CSS rewards: callsigns, HUD themes, nameplates and three CSS reticles. Every weapon remains playable in every mode where that mode permits it. Gun Game uses its own weapon order and applies the player's equipped skin to each matching weapon.

| Item | Slot | Level | Additional requirement |
| --- | --- | ---: | --- |
| Ignition | Death signature | 5 | None |
| Arcade | Sound kit | 10 | None |
| Overdrive | Rifle skin | 12 | Rifle mastery SPECIALIST (score 250) |
| Salvager | Character skin | 25 | None |
| Circuit | Death signature | 25 | None |
| Revenant | Character skin | 25 | Combat score 10,000 |
| High Noon | Revolver skin | 34 | Revolver mastery ELITE (score 1,000) |
| High Noon | Sound kit | 35 | None |
| Foundry | Minigun skin | 44 | Minigun mastery MASTER (score 2,500) |
| Overdrive | Sound kit | 50 | None |
| Sovereign | Death signature | 75 | None |

Every requirement must be satisfied, and so must the node before each item in the tree. Every item is granted automatically; nothing is bought.

## Slots and who sees them

`LOADOUT_SLOTS` in `shared/career.js` is the single slot table. The ARMORY's LOADOUT tab lists it in this order and prints the audience line for each slot. `wire` slots ride the snapshot `cosmetics` object (`EQUIPPABLE_SLOTS` is derived from it and keeps its five ids and order); theme and callsign stay local.

| Slot | Label | Standard reset | On the wire | Who sees it |
| --- | --- | --- | --- | --- |
| `characterSkin` | OPERATOR SKIN | standard | yes | Everyone in the match |
| `signature` | DEATH SIGNATURE | standard | yes | Players you eliminate, on their death card |
| `sound` | SOUND KIT | standard | yes | You on kills, your victims on death, the lobby when you win |
| `theme` | HUD THEME | amber | no | Only you: HUD accent and crosshair |
| `title` | CALLSIGN | rookie | no | Only you: career badge and menu card |
| `reticle` | RETICLE | standard | yes | Only you: your crosshair |
| `nameplate` | NAMEPLATE | standard | yes | Everyone, beside your name on the scoreboard |

Weapon skins are chosen per weapon on the WEAPONS tab (`equipped.weaponSkins[weapon]`), with a per-weapon standard reset. Resetting the theme equips Amber and resetting the callsign equips Rookie.

## Mastery tiers

Tiers come from `MASTERY_TIERS` in `shared/career-mastery.js`: INITIATED 50, SPECIALIST 250, ELITE 1,000 and MASTER 2,500 mastery score, where score is human kills plus a quarter of bot and Bastion kills (at most 40 counted per weapon per match). Every tier pays a reward on all 13 weapons: three mastery nameplates and a Master callsign each, plus the three arsenal rewards. The legacy weapon skins above are mastery rewards too. See [progression](progression.md#mastery).

## Attribution and persistence

The server counts accepted kill events, including the actual weapon used before a Gun Game stage advance. Training, self-kills and teammate kills never count. Human kills add to `mastery[w].kills` (which StatTrak shows); bot and Bastion kills add to `mastery[w].botKills` at a quarter weight toward the mastery score and still award their reduced career XP. Wins count completed matches; individual Search and Destroy round wins do not count as match wins.

Existing XP, kills, matches, unlocks and equipment are preserved; a legacy `credits` field is dropped on read and previously purchased items stay owned. Historical PvP attribution and weapon mastery start at zero because earlier profiles did not record them. File-backed profiles migrate when read. PostgreSQL adds immutable migration 2 (`schema-cosmetics.sql`) after checking the existing migration checksum; mastery, PvP kills and wins persist through account adoption and restart.

Equipment is checked against the server's tree and owned inventory. Client-provided item URLs or arbitrary model IDs are never used. Live snapshots carry the authoritative loadout for each player; kill events carry the killer's loadout for the death signature. Cached loadouts refresh after admission, profile reads, rewards, equip and reset. The simulation does not query the database every tick. Revoked identities return to standard presentation.

## Rendering

Each skin is an individual module under `public/js/cosmetics/skins/`. `SkinLayer` clones changed materials and owns added details so equipping one player cannot recolor another. Removing a skin restores original materials and releases its added GPU resources. Gun details remain attached to their existing magazine, bolt and rotor parents. Team-colored character cloth is retained. Hitboxes, handling, damage, muzzle markers and sight anchors are unchanged.

The local gun, third-person carried gun and killcam use the same skin modules. Character palettes also affect local gun gloves and the visible local body. Added character details participate in normal death fades. The inventory images are rendered from these actual models, not separate illustrations.

The ARMORY inspector uses one interactive 3D viewer for the whole dialog: weapon and character skins, attachments on the selected weapon, and the WEAPONS tab's bench. Drag sideways to rotate (vertical swipes scroll the page, `touch-action: pan-y`), scroll or pinch to zoom; zoom buttons and **RESET VIEW** sit under the inspector. With the canvas focused, arrow keys rotate and tilt, plus/minus zoom, and Home or R resets the camera. **SHOW STANDARD** compares the original model while preserving the angle and attachments. Locked skins can be inspected without granting or equipping them.

Model geometry, materials and attachments come from the gameplay builders. The viewer is created lazily, rebuilt only when the model or skin changes, renders only on interaction/resize, honours `prefers-reduced-motion`, and releases its WebGL context when the ARMORY closes. Before 3D loads the stage shows static art and "LOADING 3D PREVIEW"; without WebGL it keeps the art and says "3D preview unavailable on this device". Every other kind previews with `cosmeticArtwork`: a mini HUD for themes, atlas art or a typographic plate for callsigns, a live `.vb-reticle-preview` using the real reticle CSS, and a scoreboard row with a real `.vb-sb-nameplate`.

`npm run models:browser` checks actual models, mouse/touch/keyboard interaction, standard comparison, saved and draft attachments, locked preview without inventory writes, responsive framing, context restoration and close/reopen cleanup. References, prompts and browser captures are recorded in [the viewer design note](design/model-viewer/README.md).

`/cosmetic-preview.html` provides an inspection view, standard comparison, first-person weapon view, character rear view and PNG export. This page only previews models; it cannot grant or equip inventory.

## Audio

Each kit contains `kill.ogg`, `death.ogg`, `victory.ogg` and `sources.json`. Original ElevenLabs requests, request IDs when provided, reported character costs, source/output hashes and mastering settings are retained in each manifest; generation scripts read the existing Keychain credential without storing it in the project.

The killer hears their short kill confirmation. The victim hears the killer's death sting, which stops on respawn. At a completed match, the winner's kit plays; team wins use the highest-kill human on the winning team, with player ID breaking a tie. Joining during a result screen does not replay the anthem. Late kill confirmations cannot interrupt victory music.

Cosmetic channels share the gameplay master bus and also have separate volume/mute controls (CUE VOLUME, under the ARMORY's SOUND KIT slot). Only one cosmetic cue plays at a time. Suspended or unloaded cues are skipped rather than queued, death/reset/disconnect clears voices, and hiding the page stops them. Locked kits can be auditioned from the inspector; changing selection or closing it stops that preview.

Audio is checked for codec, duration, peaks, clipping and provenance. Signal checks do not replace a listening review.

## Validation

- `npm run career:test`: legacy career behavior, new authority and persistence contracts, UI state and sound preview lifecycle, runtime material isolation and bounded audio.
- `node tools/cosmetics-career-test.mjs --postgres`: isolated real PostgreSQL migration and restart checks.
- `npm test`: repository regression suite.
- Browser verification: real model inspection and first-person views, locked/earned inventory, equip/reset, sound previews and responsive layout.

Completed checks and the limits of the browser/audio review are recorded in [the validation note](design/cosmetics/validation.md).
