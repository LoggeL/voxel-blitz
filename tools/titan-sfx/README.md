# Titan weapon SFX build scripts

These scripts build the titan weapon bank in `public/assets/audio/titan/` (the files listed in
`TITAN_SAMPLE_GROUPS`, `public/js/audio/titan-bank.js`). `docs/audio/titan-sfx.md` describes the bank and
its licensing; `docs/audio/titan-weapons-judging.md` describes the model judging.

The source downloads and intermediate files stay outside the repository, by default
`~/voxel-blitz-sfx-handoff/sfx-work-20261013/`; set `TITAN_SFX_WORK` to use another one, and `TITAN_SFX_DL`
for the downloads (default `<work>/downloads`). Layout: `downloads/fs-<freesound id>/source.ogg` + `meta.json`
or `downloads/oga-<name>/source.wav` + `meta.json`, `titan/<dir>/<name>.ogg` (built files) and
`parts/<dir>__<name>.ogg.json` (one provenance record per built file).

1. Fetch the sources named in `public/assets/audio/titan/sources.json`:
   - Freesound: `python3 -I tools/titan-sfx/fs_fetch.py <id> ...` (public HQ previews, no login; refuses
     anything that is not CC0 or CC BY and skips the user craigsmith). `fs_search.py "query" [cc0|by|both]`
     searches with the same licence filter.
   - OpenGameArt: download the linked audio file only after checking its individual page licence. Store
     its title, author, page URL, file URL, licence URL and download hash in `meta.json`.
   - Compare each download with `download_sha256` in `sources.json`. The inherited YouTube take was
     replaced because the service required sign-in before its licence could be verified again.
2. Build: `python3 -I tools/titan-sfx/build.py [file-prefix or group ...]`. `recipes.py` has one recipe per
   file and records every cut. Takes of a group are levelled together (within 1 LU of the quietest take
   that reaches its target under the peak cap and limiter allowance).
3. Check: `python3 tools/titan-sfx/sheet.py <png-dir>` draws waveform + spectrogram contact sheets (needs
   matplotlib, so no `-I`); `python3 -I tools/titan-sfx/judge_all.py <out-dir> [file-prefix ...]` asks the
   model judge about each file, sequentially with a 2.5 s pause. `judge.py` invokes
   `/Users/logge/voxel-blitz-sfx-handoff/gemini-audio.py` (override `TITAN_GEMINI_AUDIO_HELPER`), which sends
   the audio to `gemini-3.8-flash` and keeps the Keychain key process-local. Verdicts include output SHA-256. `TITAN_JUDGE_REUSE=<round-dir>` reuses only exact-byte verdicts.
   `render_synth_baseline.py` renders the old TitanSynth voices for a before/after comparison and
   `scan.py` lists the transients of downloaded sources.
   `node tools/titan-sfx/browser-decode.mjs <report.json>` verifies every shipped file with Chromium's
   real `OfflineAudioContext`. It uses the muted CDP helper and a capture slot, with no audio playback.
4. Ship: `python3 -I tools/titan-sfx/integrate.py` checks the selected file list against `titan-bank.js`, copies the
   bank, writes `sources.json` and `CREDITS.txt`, and rewrites the generated blocks in
   `public/assets/audio/LICENSES.md` and `docs/audio/titan-sfx.md`.
   `python3 -I tools/titan-sfx/publish_judging.py <baseline-dir> <round-dir> ...` publishes the selected
   exact-byte answers into `docs/audio/titan-weapons-verdicts.json` and regenerates the judging tables.
   Rejected candidates stay outside the repository. Only selected takes ship; obsolete bank audio files
   are removed after all selected hashes and licences pass. Predator fire and impacts use the strongest
   recorded foundation with runtime pitch variation. The other fire banks retain several recorded takes.

The sub thumps, ready and kill chime partials and the hold-loop hum are synthesized in `recipes.py` and
need no download. All encoding uses ffmpeg with libopus (`-fflags +bitexact`). Nothing from a download
folder is executed. Source folders under the repository are rejected. Do not audition audio during an unattended run.
