# ARMORY icon set (2026-10-21)

Generated icon art for the ARMORY slots that showed a dashed placeholder, a flat
CSS glyph or plain text. Shipped as 42 transparent 128 px WebP files in
`public/assets/ui/armory/icons/` (about 214 KB in total, 3 to 7 KB each, listed
with hashes in its `sources.json`). Icons are decoration only: every slot still
prints the item's name, state glyph and word, and all values come from the
career state.

## Tool and model

Codex ImageGen (`~/.codex/skills/codex-imagegen-models/scripts/codex_images.py`),
`--size 1024x1024 --quality high`. The endpoint returned 1254x1254 RGBA PNGs
with the background already transparent, so no colour keying was needed. Six calls in total:

| Call | Model | Prompt | Output |
| --- | --- | --- | --- |
| 1 | gpt-image-2 | `sheet-a-loadout.prompt.txt` | `compare-sheet-a-gpt-image-2.webp` |
| 2 | gpt-image-2.5-flare | `sheet-a-loadout.prompt.txt` | `compare-sheet-a-gpt-image-2.5-flare.webp` (shipped as sheet A) |
| 3 | gpt-image-2.5-flare | `sheet-b-callsigns.prompt.txt` | `sheet-b-callsigns.webp` |
| 4 | gpt-image-2.5-flare | `sheet-c-nameplates.prompt.txt` | `sheet-c-nameplates.webp` |
| 5 | gpt-image-2.5-flare | `sheet-d-attachments.prompt.txt` | `sheet-d-attachments.webp` |
| 6 | gpt-image-2.5-flare | `sheet-e-tiers-classes.prompt.txt` | `sheet-e-tiers-classes.webp` |

Every prompt asks for a 3x3 grid in the style of the existing callsign atlas
(`public/assets/ui/armory/cosmetics-atlas.webp`): chunky voxel cubes, bevelled
gunmetal, one emissive accent colour per icon taken from the catalog's
`item.color`, with a bold silhouette that stays readable at 40 px. Raw sheets are stored
here as WebP (quality 92), not as the original 1.4 MB PNGs.

## Model comparison

`compare-sheet-a-small-sizes.webp` shows the same prompt from both models at
96, 44 and 32 px. Both kept the grid and the transparent cells. **gpt-image-2.5-flare
was chosen**: its voxel edges are crisper, and the details that matter at 44 px
read better (the speaker cone and waves, the dog tag notch, the five blades in
the Armsmaster crest, the segmented equalizer bars). gpt-image-2 drew a flatter
speaker and a softer crest.

Alternative cells that were not shipped: B9 (round Weapon Master medal; the diamond
blade medal B8 was kept so it does not repeat the tier IV badge), C9 (chevron
Arsenal plate; the crate C8 reads as "arsenal"), E9 (crowned Master tier; the
winged medal E4 continues the Elite wings).

## Slicing

`python3 tools/slice-armory-icons.py` (PIL, numpy, scipy) labels every opaque
area of a sheet and assigns it to the cell that holds its centre, so wings that
cross a cell edge stay with their icon. It then trims each icon, centres it on a
square with 4% margin and writes 128 px WebP (quality 80, alpha 85) plus
`sources.json`. `tools/armory-preview-test.mjs` checks that the file list matches
`ARMORY_ICONS`, that the hashes match `sources.json`, that each file is under
12 KB and the set under 300 KB, and that every slot below resolves to a shipped file.

## Slots replaced

| Where | Before | Now |
| --- | --- | --- |
| LOADOUT rail and option cards: Standard operator skin, death signature, sound kit | dashed `STANDARD` plate | `std-operator`, `std-signature`, `std-sound` |
| LOADOUT, Standard nameplate | dashed empty badge | `std-nameplate` |
| Callsign thumbs for the 20 non-legacy titles (tactician … immortal, Armorer, Armsmaster, 15 weapon Master titles) | two flat lines (typographic plate shrunk to 44 px) | `title-*`, weapon Master titles share `title-weapon-master` |
| Nameplate thumbs (8 career/arsenal nameplates) | coloured bar | `nameplate-*` |
| Nameplate thumbs (52 weapon mastery nameplates) | coloured bar | their tier badge `tier-initiated/specialist/elite/master` |
| Sound kit thumbs (Arcade, High Noon, Overdrive) | generic CSS record | `sound-*` |
| Attachment thumbs (9 optics, grips, counter) in PROGRESS journey/tree/goals | CSS rectangle glyph | `part-*` |
| MASTERY tier pips I–IV (cards and WEAPONS rail pip) | text box | tier badge next to the numeral (grey until reached) |
| MASTERY ladder tier headings | text only | 26 px tier badge |
| PROGRESS Conquest class rows (Pyro, Grenadier, Raider, Marksman) | check/lock glyph only | `class-*` icon; the state glyph moved next to the word |
| Inspector stage for titles, attachments (before 3D), standard plates | plate text / CSS glyph | icon above the plate text |

Kept as they were: weapon HUD renders, 3D operator/weapon previews, the
legacy callsign atlas (Rookie, Pathfinder, Vanguard, Veteran and the four
atlas HUD themes), the CSS HUD theme mocks, reticle previews, death signature
emblems, skin renders and the scoreboard nameplate mock on the stage.

If an icon fails to load, the thumb drops `data-icon` and shows the original
plate underneath it.
