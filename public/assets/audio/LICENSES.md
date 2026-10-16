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

## Announcer voices (Gemini TTS)

- Folders: `announcer/titanfall/` (13 Titanfall calls) and `announcer/objective/` (18 Conquest calls).
- AI-generated speech: Google Gemini TTS (`gemini-3.8-flash-tts`) with the prebuilt voices Charon
  (Titanfall cockpit intercom) and Alnilam (Conquest radio operator), generated on 2026-10-16 through
  the Gemini API by `tools/synthesize-announcer-gemini.mjs`. Every line is original project wording from
  `shared/announcer.js`; no game, film or voice-actor recordings were used or imitated.
- Processing: silence trim, pack filter (intercom band and chirp, or field-radio band and seeded squelch),
  loudness gain to -13 LUFS, -1.9 dBFS limiter, mono 16-bit 24 kHz WAV.
- `sources.json` in each folder records per clip: text, model, voice, style prompt, seed, raw and shipped
  sha256, the filter chain, measured loudness and the Gemini audio-judge verdict (`gemini-3.8-flash`).
- Google account and API terms govern the generated audio; no CC0 or CC license is asserted.
  Voice choice and judging: `docs/audio/announcer.md`.
- `announcer/quake/` is different: unchanged classic "Quake Sounds" recordings, see
  `docs/audio/quake-announcer.md`.

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

<!-- titan-sfx:licenses:begin -->
## Titan weapon sound bank

- Folder: `titan/` (58 files in `splitter/`, `t203/`, `railgun/`, `leadwall/`, `predator/`, `common/`). Loaded only by
  the Titanfall client (`TITAN_SAMPLE_MANIFEST` in `public/js/audio/titan-bank.js`), never at boot.
- Sources: individually checked CC0 1.0 and CC BY 4.0 recordings from Freesound (HQ previews) or OpenGameArt,
  plus original synthesis by the build script. No BBC, game or film recordings. The inherited YouTube take
  was replaced because its licence could not be reverified without signing in.
- `titan/sources.json` records per file: source URL, title, author, license, retrieval date, the sha256 of the
  downloaded source, the in/out cut, the processing chain, the output sha256 and decoded measurements.
- Build scripts: `tools/titan-sfx/`. Details and the per-file table: `docs/audio/titan-sfx.md`.

Credits for every source, including CC0 (also served at `/assets/audio/titan/CREDITS.txt`):

- "50 cal shot.wav" by ajhartman42295 (https://freesound.org/people/ajhartman42295/sounds/668071/), CC0 1.0, https://creativecommons.org/publicdomain/zero/1.0/. Cut, filtered, pitched, level-normalized and/or layered and encoded as Opus. Used in: railgun/fire-1.ogg, railgun/fire-3.ogg, railgun/impact-2.ogg.
- "Mossberg 500A - 1 shot and pump" by AnthonyChan0 (https://freesound.org/people/AnthonyChan0/sounds/159710/), CC0 1.0, https://creativecommons.org/publicdomain/zero/1.0/. Cut, filtered, pitched, level-normalized and/or layered and encoded as Opus. Used in: leadwall/fire-3.ogg.
- "Big robot footstep 003" by AudioPapkin (https://freesound.org/people/AudioPapkin/sounds/813054/), CC0 1.0, https://creativecommons.org/publicdomain/zero/1.0/. Cut, filtered, pitched, level-normalized and/or layered and encoded as Opus. Used in: common/doom-confirm-1.ogg, common/kill-confirm-1.ogg, railgun/impact-2.ogg.
- "bullet ricochet.wav" by aust_paul (https://freesound.org/people/aust_paul/sounds/30932/), CC0 1.0, https://creativecommons.org/publicdomain/zero/1.0/. Cut, filtered, pitched, level-normalized and/or layered and encoded as Opus. Used in: leadwall/ricochet-1.ogg, leadwall/ricochet-2.ogg, leadwall/ricochet-3.ogg.
- "Railgun_ChargeLoop" by BaggoNotes (https://freesound.org/people/BaggoNotes/sounds/785400/), CC0 1.0, https://creativecommons.org/publicdomain/zero/1.0/. Cut, filtered, pitched, level-normalized and/or layered and encoded as Opus. Used in: railgun/hold-1.ogg.
- "shell load.ogg" by CeebFrack (https://freesound.org/people/CeebFrack/sounds/108793/), CC0 1.0, https://creativecommons.org/publicdomain/zero/1.0/. Cut, filtered, pitched, level-normalized and/or layered and encoded as Opus. Used in: leadwall/reload-1.ogg, splitter/reload-1.ogg, t203/mech-2.ogg.
- "Chain Gun Wind Down v2.flac" by CGEffex (https://freesound.org/people/CGEffex/sounds/94101/), CC BY 4.0, https://creativecommons.org/licenses/by/4.0/. Cut, filtered, pitched, level-normalized and/or layered and encoded as Opus. Used in: predator/spin-down-1.ogg.
- ".30 Shell Bouncing" by Danwardvs (https://freesound.org/people/Danwardvs/sounds/205126/), CC0 1.0, https://creativecommons.org/publicdomain/zero/1.0/. Cut, filtered, pitched, level-normalized and/or layered and encoded as Opus. Used in: predator/casings-3.ogg.
- "Metal pipe on concrete.wav" by deleted_user_2104797 (https://freesound.org/people/deleted_user_2104797/sounds/164572/), CC0 1.0, https://creativecommons.org/publicdomain/zero/1.0/. Cut, filtered, pitched, level-normalized and/or layered and encoded as Opus. Used in: predator/casings-2.ogg, predator/casings-3.ogg.
- "Metal Sheet Hit" by dmitryleeo (https://freesound.org/people/dmitryleeo/sounds/492177/), CC0 1.0, https://creativecommons.org/publicdomain/zero/1.0/. Cut, filtered, pitched, level-normalized and/or layered and encoded as Opus. Used in: leadwall/fire-1.ogg, leadwall/impact-1.ogg, leadwall/impact-2.ogg, leadwall/pump-1.ogg, leadwall/ricochet-1.ogg, splitter/impact-2.ogg, splitter/reload-1.ogg, t203/fire-2.ogg.
- "Tesla Tower Zap - Electric Zap Short - Game SFX" by el_boss (https://freesound.org/people/el_boss/sounds/853286/), CC0 1.0, https://creativecommons.org/publicdomain/zero/1.0/. Cut, filtered, pitched, level-normalized and/or layered and encoded as Opus. Used in: splitter/fire-3.ogg, splitter/impact-2.ogg.
- "MetalImpactAgainstRock07" by falcospizaetus (https://freesound.org/people/falcospizaetus/sounds/489924/), CC0 1.0, https://creativecommons.org/publicdomain/zero/1.0/. Cut, filtered, pitched, level-normalized and/or layered and encoded as Opus. Used in: common/hit-confirm-2.ogg, leadwall/impact-3.ogg.
- "high-voltage-discharge-2.wav" by follytowers (https://freesound.org/people/follytowers/sounds/415962/), CC0 1.0, https://creativecommons.org/publicdomain/zero/1.0/. Cut, filtered, pitched, level-normalized and/or layered and encoded as Opus. Used in: leadwall/fire-1.ogg, leadwall/fire-3.ogg, railgun/fire-1.ogg, railgun/fire-2.ogg, railgun/fire-3.ogg, splitter/impact-1.ogg, splitter/impact-2.ogg, splitter/impact-3.ogg.
- "road flare ignite burns.wav" by frankelmedico (https://freesound.org/people/frankelmedico/sounds/348767/), CC0 1.0, https://creativecommons.org/publicdomain/zero/1.0/. Cut, filtered, pitched, level-normalized and/or layered and encoded as Opus. Used in: t203/burn-1.ogg, t203/fire-1.ogg, t203/fire-2.ogg, t203/fire-3.ogg, t203/impact-1.ogg, t203/impact-3.ogg.
- "Tank fire Mixed.wav" by GaryQ (https://freesound.org/people/GaryQ/sounds/127845/), CC0 1.0, https://creativecommons.org/publicdomain/zero/1.0/. Cut, filtered, pitched, level-normalized and/or layered and encoded as Opus. Used in: leadwall/fire-1.ogg, leadwall/fire-2.ogg.
- "Shooting a Shotgun - SM57 - With Tail" by Geoff-Bremner-Audio (https://freesound.org/people/Geoff-Bremner-Audio/sounds/724945/), CC BY 4.0, https://creativecommons.org/licenses/by/4.0/. Cut, filtered, pitched, level-normalized and/or layered and encoded as Opus. Used in: leadwall/fire-1.ogg, leadwall/tail-1.ogg.
- "Brass bullet shell casing drop onto concrete, multiple takes" by GrayJoy (https://freesound.org/people/GrayJoy/sounds/210102/), CC0 1.0, https://creativecommons.org/publicdomain/zero/1.0/. Cut, filtered, pitched, level-normalized and/or layered and encoded as Opus. Used in: predator/casings-2.ogg.
- "snd_metal_smash.wav" by gristi (https://freesound.org/people/gristi/sounds/562198/), CC0 1.0, https://creativecommons.org/publicdomain/zero/1.0/. Cut, filtered, pitched, level-normalized and/or layered and encoded as Opus. Used in: common/doom-confirm-1.ogg, leadwall/ricochet-1.ogg, leadwall/ricochet-2.ogg, leadwall/ricochet-3.ogg, railgun/impact-2.ogg.
- "JacobsLadderSingle2.flac" by Halleck (https://freesound.org/people/Halleck/sounds/19487/), CC BY 4.0, https://creativecommons.org/licenses/by/4.0/. Cut, filtered, pitched, level-normalized and/or layered and encoded as Opus. Used in: railgun/fire-1.ogg, railgun/fire-3.ogg, railgun/impact-2.ogg.
- "Sci-Fi Charge Up.wav" by Hemplock (https://freesound.org/people/Hemplock/sounds/558679/), CC0 1.0, https://creativecommons.org/publicdomain/zero/1.0/. Cut, filtered, pitched, level-normalized and/or layered and encoded as Opus. Used in: splitter/reload-1.ogg.
- "fire-whoosh.wav" by hnhnh (https://freesound.org/people/hnhnh/sounds/244926/), CC0 1.0, https://creativecommons.org/publicdomain/zero/1.0/. Cut, filtered, pitched, level-normalized and/or layered and encoded as Opus. Used in: t203/fire-1.ogg, t203/fire-3.ogg.
- "massive explosion" by Hugofski (https://freesound.org/people/Hugofski/sounds/177556/), CC0 1.0, https://creativecommons.org/publicdomain/zero/1.0/. Cut, filtered, pitched, level-normalized and/or layered and encoded as Opus. Used in: leadwall/fire-3.ogg, t203/impact-1.ogg, t203/impact-2.ogg, t203/impact-3.ogg.
- "Thunder, Very Close, No Rain, C.wav" by InspectorJ (https://freesound.org/people/InspectorJ/sounds/321654/), CC BY 4.0, https://creativecommons.org/licenses/by/4.0/. Cut, filtered, pitched, level-normalized and/or layered and encoded as Opus. Used in: railgun/fire-3.ogg, railgun/tail-2.ogg.
- "Electric Motor Whir.aif" by jasonLON (https://freesound.org/people/jasonLON/sounds/125401/), CC0 1.0, https://creativecommons.org/publicdomain/zero/1.0/. Cut, filtered, pitched, level-normalized and/or layered and encoded as Opus. Used in: leadwall/pump-1.ogg, leadwall/pump-2.ogg, leadwall/reload-1.ogg, predator/reload-1.ogg, predator/spin-1.ogg, predator/spin-down-1.ogg, predator/spin-up-1.ogg, railgun/charge-1.ogg, t203/mech-1.ogg.
- "sizzle" by jbdelgado (https://freesound.org/people/jbdelgado/sounds/569609/), CC0 1.0, https://creativecommons.org/publicdomain/zero/1.0/. Cut, filtered, pitched, level-normalized and/or layered and encoded as Opus. Used in: t203/burn-1.ogg, t203/impact-2.ogg.
- "ELECTRIC_ZAP_001.wav" by JoelAudio (https://freesound.org/people/JoelAudio/sounds/136542/), CC0 1.0, https://creativecommons.org/publicdomain/zero/1.0/. Cut, filtered, pitched, level-normalized and/or layered and encoded as Opus. Used in: splitter/fire-2.ogg.
- "Explosion, Medium Blast" by Kinoton (https://freesound.org/people/Kinoton/sounds/516914/), CC0 1.0, https://creativecommons.org/publicdomain/zero/1.0/. Cut, filtered, pitched, level-normalized and/or layered and encoded as Opus. Used in: t203/impact-1.ogg.
- "Explosion004.wav" by klangfabrik (https://freesound.org/people/klangfabrik/sounds/220062/), CC0 1.0, https://creativecommons.org/publicdomain/zero/1.0/. Cut, filtered, pitched, level-normalized and/or layered and encoded as Opus. Used in: t203/impact-3.ogg.
- "UTS-15 Shotgun with pump action 4takes.wav" by klangfabrik (https://freesound.org/people/klangfabrik/sounds/233044/), CC0 1.0, https://creativecommons.org/publicdomain/zero/1.0/. Cut, filtered, pitched, level-normalized and/or layered and encoded as Opus. Used in: leadwall/fire-1.ogg, leadwall/fire-2.ogg.
- "fireworks firecrackers close nice fizzle and pops various right side onmic.flac" by kyles (https://freesound.org/people/kyles/sounds/404999/), CC0 1.0, https://creativecommons.org/publicdomain/zero/1.0/. Cut, filtered, pitched, level-normalized and/or layered and encoded as Opus. Used in: t203/burn-1.ogg, t203/fire-1.ogg, t203/fire-2.ogg, t203/fire-3.ogg, t203/impact-1.ogg, t203/impact-2.ogg, t203/impact-3.ogg.
- "door metal big heavy close kinda slam thud echo offmic.wav" by kyles (https://freesound.org/people/kyles/sounds/406197/), CC0 1.0, https://creativecommons.org/publicdomain/zero/1.0/. Cut, filtered, pitched, level-normalized and/or layered and encoded as Opus. Used in: common/kill-confirm-1.ogg, leadwall/pump-1.ogg, predator/reload-1.ogg, splitter/reload-1.ogg, t203/mech-1.ogg.
- "flare fire real dull crack slap.wav" by kyles (https://freesound.org/people/kyles/sounds/450837/), CC0 1.0, https://creativecommons.org/publicdomain/zero/1.0/. Cut, filtered, pitched, level-normalized and/or layered and encoded as Opus. Used in: t203/impact-1.ogg, t203/impact-2.ogg, t203/impact-3.ogg.
- "Grenade Launcher" by LeMudCrab (https://freesound.org/people/LeMudCrab/sounds/163458/), CC0 1.0, https://creativecommons.org/publicdomain/zero/1.0/. Cut, filtered, pitched, level-normalized and/or layered and encoded as Opus. Used in: t203/fire-2.ogg.
- "Shotgun Shot 01.wav" by LilMati (https://freesound.org/people/LilMati/sounds/405504/), CC0 1.0, https://creativecommons.org/publicdomain/zero/1.0/. Cut, filtered, pitched, level-normalized and/or layered and encoded as Opus. Used in: leadwall/fire-2.ogg.
- "Shotgun Shot 02.wav" by LilMati (https://freesound.org/people/LilMati/sounds/408099/), CC0 1.0, https://creativecommons.org/publicdomain/zero/1.0/. Cut, filtered, pitched, level-normalized and/or layered and encoded as Opus. Used in: leadwall/tail-2.ogg.
- "Rifle Gun Shot 01.wav" by LilMati (https://freesound.org/people/LilMati/sounds/433858/), CC0 1.0, https://creativecommons.org/publicdomain/zero/1.0/. Cut, filtered, pitched, level-normalized and/or layered and encoded as Opus. Used in: splitter/fire-2.ogg.
- "Shotgun Shot 03.wav" by LilMati (https://freesound.org/people/LilMati/sounds/473846/), CC0 1.0, https://creativecommons.org/publicdomain/zero/1.0/. Cut, filtered, pitched, level-normalized and/or layered and encoded as Opus. Used in: leadwall/fire-3.ogg.
- "Rifle Gun Shot 02.wav" by LilMati (https://freesound.org/people/LilMati/sounds/484036/), CC0 1.0, https://creativecommons.org/publicdomain/zero/1.0/. Cut, filtered, pitched, level-normalized and/or layered and encoded as Opus. Used in: splitter/fire-3.ogg.
- "Closeup Thunder Strike 01" by loganzsound (https://freesound.org/people/loganzsound/sounds/840628/), CC0 1.0, https://creativecommons.org/publicdomain/zero/1.0/. Cut, filtered, pitched, level-normalized and/or layered and encoded as Opus. Used in: leadwall/tail-1.ogg, railgun/fire-1.ogg.
- "gongcrash 1 short" by Logicogonist (https://freesound.org/people/Logicogonist/sounds/799184/), CC0 1.0, https://creativecommons.org/publicdomain/zero/1.0/. Cut, filtered, pitched, level-normalized and/or layered and encoded as Opus. Used in: common/doom-confirm-1.ogg, common/kill-confirm-1.ogg, railgun/ready-1.ogg.
- "Basic Fire Whoosh 2" by LookIMadeAThing (https://freesound.org/people/LookIMadeAThing/sounds/260555/), CC0 1.0, https://creativecommons.org/publicdomain/zero/1.0/. Cut, filtered, pitched, level-normalized and/or layered and encoded as Opus. Used in: t203/burn-1.ogg, t203/fire-2.ogg, t203/impact-1.ogg, t203/impact-2.ogg, t203/impact-3.ogg, t203/tail-1.ogg.
- "Laser Charge Up (Stronger)" by magnuswaker (https://freesound.org/people/magnuswaker/sounds/592573/), CC0 1.0, https://creativecommons.org/publicdomain/zero/1.0/. Cut, filtered, pitched, level-normalized and/or layered and encoded as Opus. Used in: railgun/charge-1.ogg.
- "Heavy Metal Impact" by magnuswaker (https://freesound.org/people/magnuswaker/sounds/614062/), CC0 1.0, https://creativecommons.org/publicdomain/zero/1.0/. Cut, filtered, pitched, level-normalized and/or layered and encoded as Opus. Used in: common/doom-confirm-1.ogg, common/kill-confirm-1.ogg, leadwall/fire-2.ogg, leadwall/pump-2.ogg, leadwall/reload-1.ogg, leadwall/ricochet-3.ogg, predator/impact-2.ogg, predator/spin-down-1.ogg, predator/spin-up-1.ogg, railgun/fire-1.ogg, railgun/fire-2.ogg, railgun/fire-3.ogg, splitter/impact-1.ogg, splitter/split-1.ogg, splitter/split-2.ogg, t203/fire-1.ogg, t203/mech-2.ogg.
- "Foley bullet hit metal 02.wav" by martian (https://freesound.org/people/martian/sounds/182263/), CC0 1.0, https://creativecommons.org/publicdomain/zero/1.0/. Cut, filtered, pitched, level-normalized and/or layered and encoded as Opus. Used in: common/hit-confirm-3.ogg, splitter/impact-2.ogg.
- "Electric zap.wav" by michael_grinnell (https://freesound.org/people/michael_grinnell/sounds/512471/), CC0 1.0, https://creativecommons.org/publicdomain/zero/1.0/. Cut, filtered, pitched, level-normalized and/or layered and encoded as Opus. Used in: splitter/fire-1.ogg, splitter/fire-4.ogg, splitter/split-1.ogg, splitter/split-2.ogg.
- "bullet impacts" by pushkin (https://freesound.org/people/pushkin/sounds/144444/), CC0 1.0, https://creativecommons.org/publicdomain/zero/1.0/. Cut, filtered, pitched, level-normalized and/or layered and encoded as Opus. Used in: leadwall/impact-1.ogg, leadwall/impact-2.ogg, predator/impact-2.ogg.
- "Railgun - Extremely LOUD Cannon" by qubodup (https://freesound.org/people/qubodup/sounds/162260/), CC0 1.0, https://creativecommons.org/publicdomain/zero/1.0/. Cut, filtered, pitched, level-normalized and/or layered and encoded as Opus. Used in: railgun/fire-1.ogg, railgun/fire-2.ogg.
- "M203 Grenade Launcher 1.flac" by qubodup (https://freesound.org/people/qubodup/sounds/162402/), CC0 1.0, https://creativecommons.org/publicdomain/zero/1.0/. Cut, filtered, pitched, level-normalized and/or layered and encoded as Opus. Used in: t203/fire-1.ogg.
- "Explosive 1 v1 [DOD 130303].flac" by qubodup (https://freesound.org/people/qubodup/sounds/182432/), CC0 1.0, https://creativecommons.org/publicdomain/zero/1.0/. Cut, filtered, pitched, level-normalized and/or layered and encoded as Opus. Used in: t203/impact-2.ogg.
- "Mk 19 Auto Grenade Launcher.flac" by qubodup (https://freesound.org/people/qubodup/sounds/182792/), CC0 1.0, https://creativecommons.org/publicdomain/zero/1.0/. Cut, filtered, pitched, level-normalized and/or layered and encoded as Opus. Used in: t203/fire-3.ogg.
- "M-327 Mortar Shots.flac" by qubodup (https://freesound.org/people/qubodup/sounds/187542/), CC0 1.0, https://creativecommons.org/publicdomain/zero/1.0/. Cut, filtered, pitched, level-normalized and/or layered and encoded as Opus. Used in: t203/fire-2.ogg, t203/fire-3.ogg, t203/tail-1.ogg.
- "Clang" by qubodup (https://freesound.org/people/qubodup/sounds/812592/), CC0 1.0, https://creativecommons.org/publicdomain/zero/1.0/. Cut, filtered, pitched, level-normalized and/or layered and encoded as Opus. Used in: predator/fire-3.ogg, railgun/ready-1.ogg.
- "Autocannon Three Shot Burst" by qubodup (https://freesound.org/people/qubodup/sounds/854186/), CC0 1.0, https://creativecommons.org/publicdomain/zero/1.0/. Cut, filtered, pitched, level-normalized and/or layered and encoded as Opus. Used in: predator/fire-3.ogg, predator/tail-1.ogg, predator/tail-2.ogg.
- "120mm Mortar Shell Shot 2" by qubodup (https://freesound.org/people/qubodup/sounds/854478/), CC0 1.0, https://creativecommons.org/publicdomain/zero/1.0/. Cut, filtered, pitched, level-normalized and/or layered and encoded as Opus. Used in: t203/fire-1.ogg, t203/tail-1.ogg.
- "Sniper Shot in Field 3 (M2010 Enhanced Sniper Rifle ESR)" by qubodup (https://freesound.org/people/qubodup/sounds/855608/), CC0 1.0, https://creativecommons.org/publicdomain/zero/1.0/. Cut, filtered, pitched, level-normalized and/or layered and encoded as Opus. Used in: railgun/fire-2.ogg, splitter/fire-1.ogg, splitter/fire-4.ogg, splitter/split-1.ogg, splitter/split-2.ogg.
- "Shotgun rack and shell drop" by rammbostein (https://freesound.org/people/rammbostein/sounds/436074/), CC0 1.0, https://creativecommons.org/publicdomain/zero/1.0/. Cut, filtered, pitched, level-normalized and/or layered and encoded as Opus. Used in: t203/mech-1.ogg.
- "metal_collision.wav" by RichieMcMullen (https://freesound.org/people/RichieMcMullen/sounds/386798/), CC0 1.0, https://creativecommons.org/publicdomain/zero/1.0/. Cut, filtered, pitched, level-normalized and/or layered and encoded as Opus. Used in: common/hit-confirm-1.ogg, leadwall/impact-3.ogg, leadwall/reload-1.ogg, leadwall/ricochet-2.ogg, predator/impact-2.ogg, predator/reload-1.ogg, predator/spin-1.ogg, predator/spin-down-1.ogg, predator/spin-up-1.ogg, splitter/impact-3.ogg.
- "Tesla ascending-m.wav" by Rmutt (https://freesound.org/people/Rmutt/sounds/145506/), CC0 1.0, https://creativecommons.org/publicdomain/zero/1.0/. Cut, filtered, pitched, level-normalized and/or layered and encoded as Opus. Used in: railgun/charge-1.ogg, railgun/hold-1.ogg.
- "Laser Impact" by SeanSecret (https://freesound.org/people/SeanSecret/sounds/440668/), CC0 1.0, https://creativecommons.org/publicdomain/zero/1.0/. Cut, filtered, pitched, level-normalized and/or layered and encoded as Opus. Used in: railgun/impact-2.ogg, splitter/impact-1.ogg, splitter/impact-2.ogg, splitter/impact-3.ogg.
- "A ruger 10/22LR rifle being shot further away w/ forest reverb" by serøutōnin--deprivəd (https://freesound.org/people/ser%C3%B8ut%C5%8Dnin--depriv%C9%99d/sounds/723532/), CC0 1.0, https://creativecommons.org/publicdomain/zero/1.0/. Cut, filtered, pitched, level-normalized and/or layered and encoded as Opus. Used in: splitter/tail-1.ogg.
- "Inserting a rocket into an RPG-7 rocket launcher; full sequence" by serøutōnin--deprivəd (https://freesound.org/people/ser%C3%B8ut%C5%8Dnin--depriv%C9%99d/sounds/725401/), CC0 1.0, https://creativecommons.org/publicdomain/zero/1.0/. Cut, filtered, pitched, level-normalized and/or layered and encoded as Opus. Used in: predator/reload-1.ogg, splitter/reload-1.ogg, t203/mech-2.ogg.
- "12 Gauge Shotgun Chamber Round Slowly.mp3" by shelbyshark (https://freesound.org/people/shelbyshark/sounds/513351/), CC0 1.0, https://creativecommons.org/publicdomain/zero/1.0/. Cut, filtered, pitched, level-normalized and/or layered and encoded as Opus. Used in: leadwall/reload-1.ogg.
- "08 - Weaponry - Ultra-Heavy Cannon A" by Snoops_Audio1 (https://freesound.org/people/Snoops_Audio1/sounds/807664/), CC0 1.0, https://creativecommons.org/publicdomain/zero/1.0/. Cut, filtered, pitched, level-normalized and/or layered and encoded as Opus. Used in: railgun/fire-3.ogg.
- "laser-charge.wav" by StavSounds (https://freesound.org/people/StavSounds/sounds/701702/), CC0 1.0, https://creativecommons.org/publicdomain/zero/1.0/. Cut, filtered, pitched, level-normalized and/or layered and encoded as Opus. Used in: railgun/charge-1.ogg.
- "Plasma Rifle Gun Shots - Various" by synthy95 (https://freesound.org/people/synthy95/sounds/331240/), CC0 1.0, https://creativecommons.org/publicdomain/zero/1.0/. Cut, filtered, pitched, level-normalized and/or layered and encoded as Opus. Used in: splitter/fire-1.ogg, splitter/fire-2.ogg, splitter/fire-3.ogg, splitter/fire-4.ogg, splitter/split-1.ogg, splitter/split-2.ogg, splitter/tail-1.ogg.
- "Doomsday Laser Cannon Sound Effect (short)" by TAD (https://opengameart.org/content/doomsday-laser-cannon-sound-effect), CC0 1.0, https://creativecommons.org/publicdomain/zero/1.0/. Cut, filtered, pitched, level-normalized and/or layered and encoded as Opus. Used in: railgun/fire-1.ogg, railgun/fire-2.ogg, railgun/fire-3.ogg, railgun/tail-2.ogg.
- "Fire Crackle and Flames 001" by TheWoodlandNomad (https://freesound.org/people/TheWoodlandNomad/sounds/363093/), CC0 1.0, https://creativecommons.org/publicdomain/zero/1.0/. Cut, filtered, pitched, level-normalized and/or layered and encoded as Opus. Used in: t203/burn-1.ogg, t203/impact-1.ogg, t203/impact-2.ogg, t203/impact-3.ogg.
- "Remington 870 12 gauge shotgun pump racking cha chock" by TotallyPhilip (https://freesound.org/people/TotallyPhilip/sounds/755495/), CC0 1.0, https://creativecommons.org/publicdomain/zero/1.0/. Cut, filtered, pitched, level-normalized and/or layered and encoded as Opus. Used in: leadwall/pump-1.ogg.
- "sheet metal sound four: Bang.wav" by trijohnstone (https://freesound.org/people/trijohnstone/sounds/547979/), CC0 1.0, https://creativecommons.org/publicdomain/zero/1.0/. Cut, filtered, pitched, level-normalized and/or layered and encoded as Opus. Used in: leadwall/fire-3.ogg, leadwall/pump-2.ogg, t203/fire-3.ogg.
- "200817 Thunder, pretty close crack 4pm.flac" by TRP (https://freesound.org/people/TRP/sounds/567945/), CC0 1.0, https://creativecommons.org/publicdomain/zero/1.0/. Cut, filtered, pitched, level-normalized and/or layered and encoded as Opus. Used in: leadwall/tail-2.ogg, railgun/fire-2.ogg, railgun/tail-2.ogg, splitter/tail-1.ogg.
- "VisceralBulletImpacts.wav" by u1769092 (https://freesound.org/people/u1769092/sounds/423301/), CC0 1.0, https://creativecommons.org/publicdomain/zero/1.0/. Cut, filtered, pitched, level-normalized and/or layered and encoded as Opus. Used in: splitter/impact-3.ogg.
- "M406 HE shell explosion on gravel" by vabadus (https://freesound.org/people/vabadus/sounds/151076/), CC0 1.0, https://creativecommons.org/publicdomain/zero/1.0/. Cut, filtered, pitched, level-normalized and/or layered and encoded as Opus. Used in: t203/impact-3.ogg.
- "Welding_Electric Sparks.wav" by weaveofkev (https://freesound.org/people/weaveofkev/sounds/396240/), CC0 1.0, https://creativecommons.org/publicdomain/zero/1.0/. Cut, filtered, pitched, level-normalized and/or layered and encoded as Opus. Used in: railgun/tail-2.ogg, splitter/impact-1.ogg, splitter/impact-3.ogg.
- "Pump Action Shotgun Cycle" by Zott820 (https://freesound.org/people/Zott820/sounds/370344/), CC0 1.0, https://creativecommons.org/publicdomain/zero/1.0/. Cut, filtered, pitched, level-normalized and/or layered and encoded as Opus. Used in: leadwall/pump-2.ogg.
<!-- titan-sfx:licenses:end -->

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
