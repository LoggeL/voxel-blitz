# Audio asset sources

The weapon and handling `.ogg` samples were trimmed, filtered, normalized,
downmixed to mono, and encoded as Opus for VOXEL BLITZ. Fire samples are aligned
to their initial report transients so their onset matches recoil and muzzle
flash. Procedural audio remains the
fallback whenever a browser cannot fetch or decode a sample. The menu loop is encoded as stereo Opus.

## Weapon reports

- Source: **Gunshot Sounds** by Tabasco
- Original files: `cz.wav`, `mosin.wav`, `shotty.wav`, `sks.wav`
- License: Creative Commons Zero (CC0)
- Source page: https://opengameart.org/content/gunshot-sounds
- Used for the six weapon fire samples.

## Weapon handling

- Source: **Gun reload sounds** by SpringySpringo
- Original files: `gunreload1.wav`, `assaultriflereload1.wav`, `shotguncock.wav`
- License: Creative Commons Zero (CC0)
- Source page: https://opengameart.org/content/gun-reload-sounds
- Used for selected magazine/bolt/pump reload layers.

Attribution is not required by CC0, but the source record is kept here so the
origin and license of every bundled recording remain auditable.

## Menu music

- Track: **Foundry Assault** (`music/menu-foundry-assault.ogg`).
- Generated from an original project prompt with Google Lyria 3.5 in Google AI Studio on
  2026-09-08 (Europe/Berlin), then prepared as the menu and lobby loop.
- This generated recording is separate from the CC0 assets above. Google
  account/service terms govern its use; no CC0 license is asserted.
- `music/menu-foundry-assault.prompt.txt` preserves the exact generation prompt.
  `music/menu-foundry-assault.sources.json` records original and shipped hashes,
  the source location, processing commands and decoded measurements.
- 57.600 seconds decoded, stereo 48 kHz Opus at 160 kbit/s VBR. The generated
  ending taper and silence are removed, and an 80 ms circular overlap connects
  the final phrase to the opening. Linear normalization gives -17.00 LUFS and
  -4.03 dBTP. The main menu's music switch saves its state locally.

### Legacy procedural menu music

- Track: **Foundry Aftermath** (`music/menu-industrial.ogg`)
- Original procedural composition for this project; no external samples.
- Source: `tools/generate-menu-music.mjs` (deterministic synthesis).
- 120 BPM, 32 bars, 64 seconds, stereo Opus at 128 kbit/s.
- Regenerate from the repository root with `node tools/generate-menu-music.mjs` (requires ffmpeg with libopus).
- Retained with its deterministic generator as the earlier menu track.

## Generated grenades, handling and continuous weapons

- Source: ElevenLabs Sound Effects, generated in the user's account on 2026-09-07.
- Used for frag, limpet, pulse and rocket explosions, grenade pin and throw cues,
  pickaxe swing and flamethrower loop. The original minigun and pickaxe recordings
  are superseded by the variants below.
- The four explosion groups were generated in the browser. The other five groups
  were generated through the ElevenLabs API; their original MP3 responses and
  receipts are retained locally in `.artifacts/elevenlabs-effects-2026-09-07/api-source/`.
- These generated recordings are separate from the CC0 assets above; no CC0
  license is asserted for them. Account/service terms govern their use.
- `elevenlabs-effects-sources.json` records selected candidate filenames, original
  and output SHA-256 hashes, trims, filters, fades, normalization and final decoded
  measurements. Each effect was selected from four generated candidates.
- Rebuild with `python tools/prepare-elevenlabs-effects.py process` using ffmpeg,
  NumPy, SciPy, Matplotlib and the local raw WAVs and `recipes.json` in
  `.artifacts/elevenlabs-effects-2026-09-07/`. The `analyze` command regenerates
  candidate waveform and spectrogram sheets there.
- Shipped files are mono 48 kHz Opus at 96 kbit/s. One-shots have trimmed onsets
  and faded tails. The flamethrower uses a 200 ms equal-power overlap; the decoded
  Opus loop boundary is measured and plotted during preparation.
- The historical minigun recipe now writes to `legacy-output` in its artifact
  directory. The API MP3s were decoded to WAV for analysis;
  this does not recover an uncompressed original from the lossy source.
- Historical Kenney CC0 grenade provenance remains in `grenades/sources.json`,
  explicitly marked as replaced. `tools/prepare-grenade-audio.py` rebuilds that
  historical recipe only into `.artifacts/grenade-audio-source/legacy-output/`.

## Heavy rotary minigun reports

- Source: ElevenLabs Sound Effects API, generated in the user's account on 2026-09-08.
- Three reports selected from eight candidates replace the earlier 55 ms shot.
  They last 160-180 ms, with equal decoded RMS levels, low-mid body and controlled
  high-frequency energy. The game alternates the recordings at natural speed.
  A shared leading attack and a 25 ms decay constant keep each shot distinct at
  1200 RPM; 90% of each report's energy resolves within the 50 ms shot interval.
  Rotor modulation follows the same 20 Hz cadence at full speed.
- `elevenlabs-minigun-sources.json` records prompts, selected original/decoded
  hashes, processing recipes, final Opus hashes and measurements.
- Rebuild with `python tools/prepare-minigun-audio.py`; `--analyze` also regenerates
  the candidate waveform and spectrum sheets. Original API responses and receipts
  remain in `.artifacts/elevenlabs-minigun-2026-09-08/`.
- Mono 48 kHz Opus, 96 kbit/s. Account/service terms govern these generated assets;
  no CC0 license is asserted.

## Hit confirmations and body impacts

- Source: ElevenLabs Sound Effects API, generated in the user's account on 2026-09-08.
- Eight candidates produced separate body/head hit confirmations, body/head kill
  confirmations and a muted flesh impact. The 139-144 ms kill cues remain active;
  the hit and flesh cues are superseded by the physical foley below. Their old
  rebuild recipes now write into the local artifact directory's `legacy-output`.
- Account/service terms govern these generated assets; no CC0 license is asserted.
- `elevenlabs-hit-sources.json` records selected sources, API prompts, original and
  decoded hashes, processing recipes and actual decoded Opus measurements.
- Rebuild with `python tools/prepare-hit-audio.py`; add `--analyze` for candidate
  waveform and spectrum sheets. Local API responses, WAVs and receipts remain in
  `.artifacts/elevenlabs-hit-audio-2026-09-08/`.

## Generated energy weapons and rocket launch

- Source: ElevenLabs Sound Effects, generated in the user's account on 2026-09-06.
- LONGARC: railgun variant #4. VOLTLANCE: electric lance variant #3.
  Rocket launch: shoulder-fired rocket variant #4.
- These generated recordings are separate from the CC0 assets above; no CC0
  license is asserted for them. Account/service terms govern their use.
- `weapons/elevenlabs-sources.json` records original filenames, SHA-256 hashes,
  trims, mono conversion, filters, fades and normalization.
- Rebuild: `python3 tools/prepare-elevenlabs-audio.py <downloaded-wav-directory>`.
- Original WAVs and the twelve-variant analysis are retained locally in
  `.artifacts/elevenlabs-audio/`. The shipped files are mono 48 kHz Opus, 96 kbit/s.
- LONGARC and VOLTLANCE sample gain follows charge; procedural reports remain
  a quiet layer and the fallback if sample loading fails.

## GV-4 RIPTIDE throw

- Source: original procedural synthesis for this project (numpy/scipy, fixed seed);
  no recordings, sample libraries or generated-audio services are involved.
- `weapons/glaive/fire.ogg`: a pneumatic spindle thunk, a blade whine rising to
  about 2 kHz and an inharmonic steel "shing" tail, 0.62 s.
- `weapons/glaive/sources.json` records the layer recipe, seed, normalization,
  output SHA-256 and decoded measurements. Rebuild with
  `python3 tools/generate-glaive-audio.py`.
- Mono 48 kHz Opus, 96 kbit/s (the local ffmpeg has no libvorbis). Not auditioned
  by ear; checked with signal metrics and `tools/analyze-weapon-audio.mjs`.
- The in-flight whirr, return, catch, embed, pickup and fabricate cues are
  procedural WebAudio graphs in `public/js/audio/`, not samples.

## Pickaxe swing and mining contacts

- Source: ten ElevenLabs API candidates generated on 2026-09-08 (60 credits).
- Two air swings and two stone contact recordings replace the previous swing and
  synthetic mining chirps. Contact files include original damped resonance synthesis
  for low-mid weight. Material filtering and debris are applied by the game.
- `elevenlabs-pickaxe-sources.json` contains source hashes, prompts, selection,
  processing and final measurements. Rebuild with `python tools/prepare-pickaxe-audio.py`
  using retained sources in `.artifacts/elevenlabs-pickaxe-2026-09-08/`.
- Mono 48 kHz Opus at 96 kbit/s. Account/service terms govern generated recordings;
  no CC0 license is asserted. Historical swing rebuilding writes to `legacy-output`.

## IRON PICK dig and attack sets

- Sources: 13 new ElevenLabs API candidates generated on 2026-09-22 (65 credits;
  the key then reached its quota), plus unused takes from this project's own
  2026-09-08, 2026-09-09 and 2026-09-16 generations. Seeded numpy synthesis adds
  iron/glass ring partials, body thumps, cloth puffs and the crit sparkle.
- Original foley in the style of block-game dig and attack sounds; no Mojang or
  other game recordings were used or imitated file-for-file.
- `weapons/knife/dig-<material>-<n>.ogg` (stone, wood, gravel, grass, sand,
  cloth, glass, metal), `dig-glass-break-<n>.ogg` and
  `attack-<strong|crit|knockback|backstab|armor>-<n>.ogg`.
- `elevenlabs-pickaxe-dig-sources.json` records every layer, prompt, receipt,
  source/output hash and decoded measurement. Rebuild with
  `.artifacts/audio-analysis-venv/bin/python tools/prepare-pickaxe-dig-audio.py process`
  from retained sources; recipes in `docs/audio/pickaxe-dig/recipes.json`.
- Mono 48 kHz Opus at 96 kbit/s. Account/service terms govern generated recordings;
  no CC0 license is asserted.

## Physical hit foley

- Source: six original ElevenLabs API candidates generated on 2026-09-08 (30 credits).
- Body/head confirmations and incoming flesh impact use new physical foley. These
  are original generated sounds, not copied Counter-Strike or other game recordings.
- `elevenlabs-tactical-hit-sources.json` records sources, prompts, processing,
  hashes and decoded measurements. Rebuild with `python tools/prepare-tactical-hit-audio.py`
  using retained sources in `.artifacts/elevenlabs-hits-2026-09-08/`.
- Mono 48 kHz Opus at 96 kbit/s. Account/service terms govern their use;
  no CC0 license is asserted. Existing kill confirmations remain active.

## Close bullet flyby

- Source: ["Bullet passbys.wav"](https://freesound.org/people/Audionautics/sounds/134024/) by
  Audionautics, [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/). Attribution:
  "Bullet passbys.wav" by Audionautics, CC BY 3.0; cut, filtered, level-adjusted and encoded as Opus.
- The uploader made the whizzes from pitched and time-shifted layers of their own car pass-bys.
  The Freesound HQ preview (Ogg Vorbis) was used, because the original download needs a login.
- Three single whizzes: `combat/bullet-whiz.ogg` (7.12–7.37 s), `combat/bullet-whiz-2.ogg`
  (11.59–11.84 s) and `combat/bullet-whiz-3.ogg` (12.62–12.89 s). Mono 48 kHz Opus at 96 kbit/s,
  high-pass 120 Hz, the loudest 50 ms set near -20 dBFS RMS like the clips they replace,
  2 ms fade-in and 40 ms fade-out.
- `bullet-flyby-sources.json` records the source, its sha256, the cuts, gains and output hashes.
  Rebuild with `python3 -I tools/prepare-bullet-flyby.py` from the retained preview in
  `.conquest-work/wip/sfx/downloads/fs-134024/`.
- **Replaced on 2026-10-08:** the previous excerpts of
  `https://www.youtube.com/watch?v=8hVB1kChbvA` ("Free SFX") were under the standard YouTube
  license (yt-dlp license field `NA`), with only a "royalty-free" note in the description. They
  and their build script were removed.

## Conquest sound banks

- Folders: `conquest/vehicles/` (80 files), `conquest/explosions/` (68) and
  `conquest/atmosphere/` (35). They are loaded only for a Conquest match, except the nine
  structural-collapse takes below.
- Structural collapses (every mode, `STRUCTURE_SAMPLE_MANIFEST` in
  `public/js/audio/conquest-bank.js`) reuse `conquest/atmosphere/industrial-creak-clank.ogg`
  (Freesound 489442 "Creaking Metal.wav", Soapuel, CC0 1.0) and
  `conquest/explosions/debris-{stone,wood,metal,glass}-{1,2}.ogg` (credited per file in
  `docs/audio/conquest-sfx.md`). No new recordings were added for them.
- Sources, by license:
  - CC0 1.0 and CC BY 3.0/4.0 recordings from Freesound (the HQ previews; original
    downloads need a login).
  - U.S. federal government works from official U.S. Navy, Marines and Army YouTube
    channels. Their YouTube license field reads "Creative Commons Attribution license
    (reuse allowed)", checked per video with yt-dlp.
  - Original synthesis made by the build scripts.
- No ElevenLabs credits were used, and no game or film recordings were used.
- Build scripts: `tools/conquest-sfx/` (recipes, encoding, `sources.json` and credit generation).
- Layers from the Freesound user *craigsmith* were removed because the origin of that
  library is doubtful.
- Also removed on 2026-10-08 after a license audit: Freesound 855244 ("Distant Gunfire 3",
  an excerpt of NATO b-roll that NATO licenses only under its own terms) from both battle beds,
  and Freesound 611449 ("M61A2 Minigun", labelled CC0 while the uploader's profile restricts it
  to non-commercial use) from `vehicles/jet-cannon-burst.ogg`, which is now cut from a U.S. Navy
  Phalanx CIWS video (M61A1 20 mm, YouTube CC BY).
- Each folder's `sources.json` records, for every file:
  - source URL, title, author and license, and the retrieval date;
  - the sha256 of the downloaded source;
  - in/out cut seconds and the processing chain;
  - the output sha256 and decoded measurements (duration, LUFS, peak, loop seams).
- `docs/audio/conquest-sfx.md` has the full table, the in-game wiring and the mix notes.
- Mono 48 kHz Opus at 96 kbit/s; the stereo ambience beds at 128 kbit/s (libopus, bitexact).

## CC BY credits

These recordings are used under Creative Commons Attribution licenses. Changes were made:
cut, filtered, level-normalized, looped and/or layered, and encoded as Opus. The same list
is served at `/assets/audio/conquest/CREDITS.txt`.

- "Incoming Artillery.wav" by bendodge (https://freesound.org/people/bendodge/sounds/170991/), CC BY 3.0 — https://creativecommons.org/licenses/by/3.0/. Cut, filtered, level-normalized, looped or layered and encoded as Opus. Used in: vehicles/shell-incoming-he.ogg.
- "Distant_gunfire_01.wav" by CGEffex (https://freesound.org/people/CGEffex/sounds/158979/), CC BY 4.0 — https://creativecommons.org/licenses/by/4.0/. Cut, filtered, level-normalized, looped or layered and encoded as Opus. Used in: atmosphere/battle-bed-high.ogg, atmosphere/battle-bed-low.ogg.
- "Distant WW2 Gunfire Kent.wav" by Cheeseheadburger (https://freesound.org/people/Cheeseheadburger/sounds/170478/), CC BY 4.0 — https://creativecommons.org/licenses/by/4.0/. Cut, filtered, level-normalized, looped or layered and encoded as Opus. Used in: atmosphere/battle-bed-high.ogg, atmosphere/battle-bed-low.ogg.
- "WAR-TANK, LEOPARD-ENGINE STAND BY-Leopard 2A4 48000 cc diesel engine close by-0003.wav" by JoniHeinonen (https://freesound.org/people/JoniHeinonen/sounds/161897/), CC BY 3.0 — https://creativecommons.org/licenses/by/3.0/. Cut, filtered, level-normalized, looped or layered and encoded as Opus. Used in: vehicles/tank-engine-idle.ogg.
- "Distant explosion.wav" by juskiddink (https://freesound.org/people/juskiddink/sounds/108640/), CC BY 4.0 — https://creativecommons.org/licenses/by/4.0/. Cut, filtered, level-normalized, looped or layered and encoded as Opus. Used in: explosions/distant-boom-2.ogg.
- "Apache AH-64 close 1223 PM 240501_0707" by klankbeeld (https://freesound.org/people/klankbeeld/sounds/734126/), CC BY 4.0 — https://creativecommons.org/licenses/by/4.0/. Cut, filtered, level-normalized, looped or layered and encoded as Opus. Used in: vehicles/heli-rotor-distant.ogg.
- "FlareGun_SizzleLoop01.wav" by marb7e (https://freesound.org/people/marb7e/sounds/674378/), CC BY 4.0 — https://creativecommons.org/licenses/by/4.0/. Cut, filtered, level-normalized, looped or layered and encoded as Opus. Used in: explosions/cookoff-1.ogg, vehicles/flares-salvo-1.ogg, vehicles/flares-salvo-2.ogg.
- "Demolition Range" by Marines (https://www.youtube.com/watch?v=gGsJk41G5_A), CC BY 3.0 (YouTube Creative Commons Attribution license) (U.S. federal government work, public domain in the U.S.; YouTube license field CC BY) — https://creativecommons.org/licenses/by/3.0/. Cut, filtered, level-normalized, looped or layered and encoded as Opus. Used in: explosions/frag-3.ogg, explosions/limpet-1.ogg.
- "Post Blast" by Marines (https://www.youtube.com/watch?v=nMwFtsxM__Q), CC BY 3.0 (YouTube Creative Commons Attribution license) (U.S. federal government work, public domain in the U.S.; YouTube license field CC BY) — https://creativecommons.org/licenses/by/3.0/. Cut, filtered, level-normalized, looped or layered and encoded as Opus. Used in: explosions/rocket-2.ogg.
- "Car driving through a ford.Wav" by NeilSeggar (https://freesound.org/people/NeilSeggar/sounds/335622/), CC BY 4.0 — https://creativecommons.org/licenses/by/4.0/. Cut, filtered, level-normalized, looped or layered and encoded as Opus. Used in: vehicles/vehicle-wade-loop.ogg.
- "Salute_Cannons.MP3" by nofeedbak (https://freesound.org/people/nofeedbak/sounds/95129/), CC BY 4.0 — https://creativecommons.org/licenses/by/4.0/. Cut, filtered, level-normalized, looped or layered and encoded as Opus. Used in: atmosphere/artillery-distant-1.ogg, atmosphere/artillery-distant-2.ogg, atmosphere/artillery-distant-3.ogg, atmosphere/artillery-distant-4.ogg, atmosphere/artillery-distant-5.ogg, atmosphere/battle-bed-high.ogg, atmosphere/battle-bed-low.ogg.
- "UH-1 "Huey" Iroquois Helicopter" by OroborosNZ (https://freesound.org/people/OroborosNZ/sounds/157722/), CC BY 4.0 — https://creativecommons.org/licenses/by/4.0/. Cut, filtered, level-normalized, looped or layered and encoded as Opus. Used in: vehicles/rotor-spool-up.ogg, vehicles/transport-rotor-ext.ogg.
- "DISTANT EXPLOSION 01.wav" by sandyrb (https://freesound.org/people/sandyrb/sounds/86291/), CC BY 4.0 — https://creativecommons.org/licenses/by/4.0/. Cut, filtered, level-normalized, looped or layered and encoded as Opus. Used in: explosions/distant-boom-4.ogg.
- "car going through ford 1.mp3" by soundmary (https://freesound.org/people/soundmary/sounds/194967/), CC BY 4.0 — https://creativecommons.org/licenses/by/4.0/. Cut, filtered, level-normalized, looped or layered and encoded as Opus. Used in: vehicles/vehicle-wade-splash.ogg.
- "Live Claymore" by The U.S. Army (https://www.youtube.com/watch?v=KJiqP8hurLU), CC BY 3.0 (YouTube Creative Commons Attribution license) (U.S. federal government work, public domain in the U.S.; YouTube license field CC BY) — https://creativecommons.org/licenses/by/3.0/. Cut, filtered, level-normalized, looped or layered and encoded as Opus. Used in: explosions/tank-he-3.ogg.
- "Eurofighter Typhoon Flyby 005 – Close Proximity" by TimoSchmied (https://freesound.org/people/TimoSchmied/sounds/640505/), CC BY 4.0 — https://creativecommons.org/licenses/by/4.0/. Cut, filtered, level-normalized, looped or layered and encoded as Opus. Used in: vehicles/jet-flyby-1.ogg.
- "CIWS Shoot Aboard GHWB" by U.S. Navy (https://www.youtube.com/watch?v=mlB5YtGP5LA), CC BY 3.0 (YouTube Creative Commons Attribution license) (U.S. federal government work, public domain in the U.S.; YouTube license field CC BY) — https://creativecommons.org/licenses/by/3.0/. Cut, filtered, level-normalized, looped or layered and encoded as Opus. Used in: vehicles/jet-cannon-burst.ogg.
- "MK 38 25mm gun live fire exercise" by U.S. Navy (https://www.youtube.com/watch?v=hWjXYw9eHRM), CC BY 3.0 (YouTube Creative Commons Attribution license) (U.S. federal government work, public domain in the U.S.; YouTube license field CC BY) — https://creativecommons.org/licenses/by/3.0/. Cut, filtered, level-normalized, looped or layered and encoded as Opus. Used in: vehicles/chin-cannon-1.ogg, vehicles/chin-cannon-2.ogg, vehicles/chin-cannon-3.ogg.
- "GAU-17 "Vulcan" Minigun Training From USS USS John P. Murtha" by U.S. Navy (https://www.youtube.com/watch?v=6tnUDX0WT8Q), CC BY 3.0 (YouTube Creative Commons Attribution license) (U.S. federal government work, public domain in the U.S.; YouTube license field CC BY) — https://creativecommons.org/licenses/by/3.0/. Cut, filtered, level-normalized, looped or layered and encoded as Opus. Used in: vehicles/transport-cabin.ogg.
- "What a sea mine explosion looks like" by U.S. Navy (https://www.youtube.com/watch?v=27Ia83p6rA4), CC BY 3.0 (YouTube Creative Commons Attribution license) (U.S. federal government work, public domain in the U.S.; YouTube license field CC BY) — https://creativecommons.org/licenses/by/3.0/. Cut, filtered, level-normalized, looped or layered and encoded as Opus. Used in: explosions/explosion-water-1.ogg.
- "Panssarivaunut maastossa / Tanks on terrain, tracks creaking" by YleArkisto (https://freesound.org/people/YleArkisto/sounds/386661/), CC BY 4.0 — https://creativecommons.org/licenses/by/4.0/. Cut, filtered, level-normalized, looped or layered and encoded as Opus. Used in: vehicles/tank-tracks-pivot.ogg.
- "Panssarivaunu ohi / Tank passing by and reversing back on sand, tracks creaking" by YleArkisto (https://freesound.org/people/YleArkisto/sounds/386590/), CC BY 4.0 — https://creativecommons.org/licenses/by/4.0/. Cut, filtered, level-normalized, looped or layered and encoded as Opus. Used in: vehicles/tank-tracks.ogg.
- "Helikopteri, lento, laskeutuminen, sisä / Helicopter, flying, starting to land, landing, engine shuts down slowly, rotor blade spins, interior, AB 412 Agusta, a 1986 model" by YleArkisto (https://freesound.org/people/YleArkisto/sounds/324971/), CC BY 4.0 — https://creativecommons.org/licenses/by/4.0/. Cut, filtered, level-normalized, looped or layered and encoded as Opus. Used in: vehicles/rotor-spool-down.ogg.
- "Pakettiauto, auton ovi, liukuovi / Sliding door of a van, car, open and close, exterior, Toyota Hiace, a 1990 model" by YleArkisto (https://freesound.org/people/YleArkisto/sounds/332853/), CC BY 4.0 — https://creativecommons.org/licenses/by/4.0/. Cut, filtered, level-normalized, looped or layered and encoded as Opus. Used in: vehicles/hatch-heli-door.ogg.
