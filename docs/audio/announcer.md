# Announcer voices

The Titanfall (Attrition) and Conquest objective calls are spoken by Gemini TTS
(`gemini-3.8-flash-tts`). They replace the macOS `say` voices used before.
Every line is the original wording from `shared/announcer.js`. The multikill
calls keep the classic Quake recordings (`docs/audio/quake-announcer.md`); a
Gemini arena pack was made and judged but is not shipped (see below).

| Pack | Folder | Voice | Character | Final judge (min / mean) |
|---|---|---|---|---|
| Titanfall | `public/assets/audio/announcer/titanfall/` (13) | Charon | Calm, clipped cockpit tactical AI over the intercom | 9 / 9.23 |
| Objective | `public/assets/audio/announcer/objective/` (18) | Alnilam | Commanding battlefield radio operator | 8 / 9.06 |
| Arena (not shipped) | `docs/audio/announcer-samples/2026-10-16/arena/` (7) | Fenrir | Big, hyped, deep arena announcer | 8 / 8.79 |

## Generation

`node tools/synthesize-announcer-gemini.mjs --pack titanfall,objective` reads the
key from the keychain (`google-api-key`) and builds every clip:

1. **Prompt.** A director's-notes prompt per line: audio profile, scene, style,
   a per-line note ("An urgent but controlled warning."), then the transcript.
   Plain "Say in a … voice: …" prompts made the model read the direction aloud.
   Seeds start at 4100 and go up by one per retake. Each retake also adds a
   different phrasing note.
2. **Processing** (ffmpeg, deterministic). Trim silence, pre-level the take to
   -18 LUFS, then apply the pack character:
   - Titanfall: 250 Hz to 5.2 kHz band, dense compression, 2.5 kHz presence,
     14 ms cabin reflection, a low-pass after the limiter, and the two-tone
     cockpit chirp (1320 Hz, then 1760 Hz) before the line.
   - Objective: 300 Hz to 3.8 kHz radio band, hard compression, light bit
     crush, 1.8 kHz presence, and a seeded static squelch at both ends.
   - Arena: low shelf and presence, glue compression, short room echo.

   Loudness then goes to -13 LUFS in up to three passes, through a -1.9 dBFS
   limiter. The shipped clips measure -12.8 to -14.1 LUFS with peaks of -0.9
   dBFS or lower. The Quake clips measure -11 to -12 LUFS and the old `say`
   clips -11.5 (objective) and -18 (Titanfall). Output is mono 16-bit 24 kHz
   WAV, 0.7 to 2.5 s long, 2.29 MB for both packs (2.27 MB before).
3. **Judging.** `gemini-3.8-flash` hears each processed clip. It returns a
   transcript and 1-10 scores for clarity, energy, fit, artifacts and overall.
   Two deterministic guards cap the score. The transcript must match the line
   letter for letter. The trimmed take must be shorter than 2 s + 0.5 s per
   word. The guards are needed because the judge transcribed a 13 s take that
   read its whole prompt aloud as just the line. A take under 7 is regenerated,
   up to four takes.
4. **Record.** `sources.json` per pack lists text, model, voice, prompt, seed,
   take, raw and shipped sha256, gains, loudness, duration, judge verdict,
   attempts and shootout scores.

Raw takes are cached under `--cache` (by default `<tmpdir>/vb-announcer-gemini`),
keyed by model, voice, prompt and seed. `--offline` reprocesses the recorded
takes without API calls and gives byte-identical WAVs. Add `--rejudge` to
judge the reprocessed audio again. `--cue a,b --shootout 3` renders three
takes of each named line and ships the one the comparative judge prefers.

## Voice casting

Five voices per pack spoke three representative lines through the shipped
chain. Single-clip scores came out at 9 for almost every candidate, which
does not separate them. A comparative judge was used instead: all candidates
for a line went into one request, were scored against each other, and the run
was repeated in reverse order to cancel position bias. Scores below are the
comparative mean, then the single-clip mean. Full results:
`docs/audio/announcer-samples/2026-10-16/judging.json`.

- **Titanfall** (prepare_titanfall, eject, core_online): Charon 6.87 / 9.33,
  Iapetus 6.83 / 9.10, Kore 5.67 / 9.33, Schedar 5.50 / 9.33, Erinome
  5.08 / 9.00. Tie-break on titan_doomed, battery_acquired and match_lose:
  Charon 6.50, Iapetus 4.83. **Charon**: a deeper, clipped, detached cockpit
  cadence.
- **Objective** (under_attack_C, captured_A, victory): Alnilam 7.50 / 9.00,
  Sadaltager 6.23 / 9.00, Gacrux 5.92 / 8.33, Orus 5.87 / 9.00, Algenib
  5.47 / 9.00. **Alnilam**: the most authoritative, punchy radio read.
- **Arena** (doublekill, monsterkill, godlike): Fenrir 7.67 / 9.00, Rasalgethi
  6.50 / 9.00, Orus 6.17 / 9.00, Alnilam 5.83 / 9.00, Algenib 4.83 / 8.33.
  **Fenrir**.

## Final pass

- Retakes from the gate: titan_ready take 0 and losing take 0 read their
  prompt aloud (15.8 s and 12.9 s); take 1 of each passed. Arena triplekill
  take 0 came out too high-pitched and scored 5.
- Shootouts of three takes for the weakest lines picked titan_doomed take 2,
  objective victory take 2 and arena ultrakill take 1. Eject, defeat and
  tickets_low kept take 0.
- Pack consistency (all clips of a pack in one request): Titanfall 10,
  objective 9, arena 8. The arena judge flagged ultrakill as flatter than the
  rest, and the shootout replaced it.
- Old against new (comparative, two orders):

  | Line | Old | New |
  |---|---|---|
  | prepare_titanfall | 5.0 | 9.0 |
  | eject | 6.5 | 6.5 |
  | match_lose | 4.0 | 8.5 |
  | under_attack_C | 6.0 | 8.0 |
  | captured_A | 3.5 | 9.0 |
  | victory | 7.0 | 6.0 |

## Why the Quake recordings stay

In September 2026 the user auditioned Gemini arena voices and chose the classic
Quake recordings instead (`docs/audio/announcer-samples/2026-09-24/README.md`).
The new Fenrir pack clearly beats them only on doublekill (9.0 against 5.0).
It ties on monsterkill (7.75 against 8.0) and godlike (7.0 against 7.0). The
pack is kept as an alternative in `docs/audio/announcer-samples/2026-10-16/arena/`.
To ship it, copy the seven WAVs into `public/assets/audio/announcer/quake/`.
Then update that folder's `sources.json` and the hash and provenance checks in
`tools/announcer-test.mjs`. Note that the built-in sample bank decodes these
clips at boot, so the 24 kHz files add about 0.25 MB.

## Checks

`node tools/announcer-test.mjs` covers both packs. Each cue has exactly one
clip, which must be a RIFF PCM mono WAV under 200 kB with a sha256 matching
`sources.json`. Each clip must also have passed the judge gate with no guard
problems and sit within 1.5 LU of the target level. Licensing:
`public/assets/audio/LICENSES.md`, section "Announcer voices (Gemini TTS)".
