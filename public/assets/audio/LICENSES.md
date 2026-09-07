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

- Track: **Foundry Aftermath** (`music/menu-industrial.ogg`)
- Original procedural composition for this project; no external samples.
- Source: `tools/generate-menu-music.mjs` (deterministic synthesis).
- 120 BPM, 32 bars, 64 seconds, stereo Opus at 128 kbit/s.
- Regenerate from the repository root with `node tools/generate-menu-music.mjs` (requires ffmpeg with libopus).
- Used as the menu and lobby loop; the main menu's music switch saves its state locally.

## Generated grenades, handling and continuous weapons

- Source: ElevenLabs Sound Effects, generated in the user's account on 2026-09-07.
- Used for frag, limpet, pulse and rocket explosions, grenade pin and throw cues,
  the minigun shot, pickaxe swing (`weapons/knife/fire.ogg`) and flamethrower loop.
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
- The minigun asset contains one isolated report from its generated burst. The
  game supplies the firing cadence. The API MP3s were decoded to WAV for analysis;
  this does not recover an uncompressed original from the lossy source.
- Historical Kenney CC0 grenade provenance remains in `grenades/sources.json`,
  explicitly marked as replaced. `tools/prepare-grenade-audio.py` rebuilds that
  historical recipe only into `.artifacts/grenade-audio-source/legacy-output/`.

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
