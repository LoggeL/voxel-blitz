# Audio asset sources

The weapon and handling `.ogg` samples were trimmed, filtered, normalized,
downmixed to mono, and encoded as Opus for VOXEL BLITZ. Fire samples begin at
the broadband muzzle transient (5–15ms measured onset after codec pre-roll) so
their report aligns with recoil and muzzle flash. Procedural audio remains the
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

## Grenade explosions

- Source: **Sci-Fi Sounds 1.0** by Kenney
- License: Creative Commons Zero (CC0-1.0)
- Source page: https://kenney.nl/assets/sci-fi-sounds
- Frag: `explosionCrunch_000.ogg` plus `lowFrequency_explosion_001.ogg`.
- Limpet: `explosionCrunch_004.ogg` plus `lowFrequency_explosion_000.ogg`.
- Pulse: `forceField_002.ogg` plus a quieter `lowFrequency_explosion_001.ogg`.
- Each layer is aligned to its onset, mixed in mono, filtered at 35 Hz / 10.5 kHz,
  peak normalized, faded at edit boundaries, and encoded as 96 kbit/s Opus.
- `grenades/sources.json` records exact trims, layer gains and source/output SHA-256 hashes.
- Rebuild with `python3 tools/prepare-grenade-audio.py` (ffmpeg required).
  Before/after spectrograms are kept in `.artifacts/grenade-audio-source/` during preparation.
- Rocket explosions reuse the heavier Limpet sample at 1.08x playback rate.
