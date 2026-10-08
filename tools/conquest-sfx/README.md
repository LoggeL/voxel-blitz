# Conquest SFX build scripts

These scripts build the Conquest banks in `public/assets/audio/conquest/{vehicles,explosions,atmosphere}/`.
`docs/audio/conquest-sfx.md` describes the banks, the in-game wiring and the licensing.

The source downloads and intermediate files are not committed. They live in a work folder, by default
`.conquest-work/wip/sfx/` (git-ignored); set `CONQUEST_SFX_WORK` to use another one. Its layout:
`downloads/<id>/` (one folder per source: `fs-<freesound id>/source.ogg` + `meta.json`, or
`yt-<video id>/source.*` + `source.info.json`), `<bank>/` (built files + `manifest.json`) and
`work-<bank>/parts/` (one provenance record per built file).

1. Fetch the sources listed in each bank's `sources.json`:
   - Freesound: `python3 -I tools/conquest-sfx/vehicles/fs_fetch.py <id> ...` (public HQ previews, no login;
     refuses anything that is not CC0 or CC BY).
   - YouTube: `yt-dlp -f bestaudio --write-info-json -o "<work>/downloads/yt-<id>/source.%(ext)s" <url>`.
     Check that `yt-dlp --print license <url>` reads "Creative Commons Attribution license (reuse allowed)".
   - Compare each download with `download_sha256` in `sources.json`. YouTube re-encodes can differ, so the
     cut times are the reference there.
2. Build: `python3 -I tools/conquest-sfx/<bank>/build.py [file-prefix ...]`, then
   `python3 -I tools/conquest-sfx/<bank>/make_manifest.py`. Every recipe records its cuts in the parts files.
3. Ship: `python3 -I tools/conquest-sfx/integrate/integrate.py` copies the banks and writes `sources.json`;
   `python3 -I tools/conquest-sfx/integrate/gen_docs.py` regenerates `CREDITS.txt` and the credit list and
   source table for the docs.

Files marked "Project original" (lock tones, alarms, flag cues, the radio voices and the shell crack) are
synthesized in `vehicles/recipes.py` and `atmosphere/recipes_synth.py` and need no download.
All encoding uses ffmpeg with libopus (`-fflags +bitexact`). Nothing from a download folder is executed.
Run builds through `.conquest-work/heavy.sh` on the shared development machine.
