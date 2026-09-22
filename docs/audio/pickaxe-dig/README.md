# IRON PICK dig and attack sounds

Built on 2026-09-22 for the IRON PICK redesign (weapon id `knife`). The pickaxe now
sounds the way a block-game pickaxe does:

- **Swing:** the existing light air whoosh (`weapons.knife.fire`, `.fire.2`), unchanged.
- **Mining:** each accepted contact plays the block's own dig take. Contacts before the
  block breaks are quiet and pitched down (gain 0.42, rate 0.76-0.82; glass 0.88-0.94).
  The breaking strike plays a full take near the recorded pitch (gain 1, rate 0.96-1.04).
  Glass tinks while being mined and shatters on the break.
- **Hitting a player:** one attack take per hit kind: `strong`, `crit` (falling hit),
  `knockback` (sprint hit), `backstab`, and `armor` (armour absorbed the whole hit).

## Material groups

`pickaxeDigMaterial(type)` in `public/js/audio/pickaxe.js` resolves ghost blocks to their
solid block first, then uses block-game sound groups. `pickaxeMaterial` still returns its
four coarse classes, which the map tests and the fallback contact use.

| Bank | Blocks | Character | Takes | Mean centroid |
| --- | --- | --- | --- | --- |
| stone | stone, concrete, brick, asphalt, dust rock/tile, cobble, ores, obsidian, netherrack, pool tile, everything unlisted | crisp gritty tick and crumble | 4 ([plot](stone-waveforms.png)) | 4.3 kHz |
| wood | wood, planks, crates, siding, logs, bookshelf, chest, crafting table, plastic slides | hollow knock | 4 ([plot](wood-waveforms.png)) | 1.2 kHz |
| gravel | dirt, clay, gravel | crunchy grains | 3 ([plot](gravel-waveforms.png)) | 2.5 kHz |
| grass | grass, leaves, TNT | soft rustle over a thud | 3 ([plot](grass-waveforms.png)) | 2.3 kHz |
| sand | sand | soft hiss-crunch | 3 ([plot](sand-waveforms.png)) | 3.8 kHz |
| cloth | wool, cloud, cactus, sandbag barricades | muffled puff | 3 ([plot](cloth-waveforms.png)) | 0.3 kHz |
| glass | glass, glowstone | bright tink; shatter on break | 3 + 2 shatters ([plot](glass-waveforms.png), [shatter](break-glass-waveforms.png)) | 4.7 kHz / 7.5 kHz |
| metal | metal, accent, rust, vehicle panels, pool panels, iron/gold/diamond blocks | ringing clank | 3 ([plot](metal-waveforms.png)) | 2.7 kHz |

| Attack | Character | Takes | Mean centroid |
| --- | --- | --- | --- |
| strong | meaty thud with an iron edge | 3 ([plot](attack-strong-waveforms.png)) | 0.6 kHz |
| crit | sharper, heavier crunch with a bright sparkle | 2 ([plot](attack-crit-waveforms.png)) | 2.7 kHz |
| knockback | thud trailed by a whoosh | 2 ([plot](attack-knockback-waveforms.png)) | 0.8 kHz |
| backstab | heavy low crunch | 2 ([plot](attack-backstab-waveforms.png)) | 0.3 kHz |
| armor | dull plate clank with a short low ring | 2 ([plot](attack-armor-waveforms.png)) | 0.5 kHz |

## Sources and credits

`tools/generate-pickaxe-dig-audio.py` (dry run by default; `--generate` spends credits)
asked for 42 candidates (225 credits estimated). The first 13 completed: stone, wood,
gravel and grass ×3 and sand ×1, 65 credits in total. The 14th request returned HTTP 401
`quota_exceeded`. The project key has a 2000-credit quota with 1 credit left. The failed
request was not billed, and its receipt is kept in `failed/`.

The remaining banks are layered from takes that earlier sessions generated with the same
account and never shipped, or that shipped under a different cut: stone/wood/glass/metal
bullet impacts from 2026-09-09, footfalls from 2026-09-16, body/head hits and pickaxe swings
from 2026-09-08. Some layers are seeded numpy synthesis: iron and glass ring partials, body
thumps, cloth puffs and the crit sparkle. Every source layer is checked against its API
receipt hashes before use. [recipes.json](recipes.json) gives every cut, filter, varispeed,
gain and reason.

To get fresh generations once the key has quota again, rerun the generator with `--cue`
and `--start-variant 4`. Completed requests are never repeated.

## QA without listening

No subjective listening approval is asserted. Selection used waveform and spectrogram
plots of 80 Hz high-passed candidates (`.artifacts/elevenlabs-pickaxe-dig-2026-09-22/analysis/`)
and the decoded Opus metrics in the receipt.
`tools/prepare-pickaxe-dig-audio.py process` enforces these limits:

- onset within 6 ms
- strongest 5 ms window within 90 ms (140 ms for knockback, where the whoosh follows)
- no clipping
- DC below 0.002
- final 20 ms RMS below 0.004
- duration up to 0.46 s, or 0.62 s for shatters and knockback

`tools/pickaxe-audio-test.mjs` checks every receipt hash. It also pins the character of
each bank:

- cloth is the darkest (below 600 Hz)
- cloth < wood < stone
- the glass shatter is brighter than the glass tink, which is brighter than metal
- crit is at least 1.5× brighter than strong
- backstab is darker than crit
- knockback carries more late energy than strong

The browser mix audit (`npm run audio:mix`, muted headless CDP, offline render) checks
every bank for:

- one complete take per contact
- mining pitch and break pitch in range
- world or in-head routing
- no repeated take in eight seconds of mining

## Files

- `public/assets/audio/weapons/knife/dig-<material>-<n>.ogg`, `dig-glass-break-<n>.ogg`,
  `attack-<kind>-<n>.ogg`: 39 files, mono 48 kHz Opus at 96 kbit/s, about 200 KB in total.
- `public/assets/audio/elevenlabs-pickaxe-dig-sources.json`: the receipt.
- Rebuild: `.artifacts/audio-analysis-venv/bin/python tools/prepare-pickaxe-dig-audio.py process`
  (`analyze` redraws the candidate sheets).
- Listen: `/audio-preview.html` has one card per bank with *Mining hit*, *Break*, *Mine it*,
  and *Own/Remote hit* for each attack kind.
