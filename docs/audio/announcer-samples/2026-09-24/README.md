# Multikill announcer samples

Selected direction: the classic male "Quake Sounds" announcer pack.

Listen to `quake-classic/quake-classic-preview.mp3` for Double Kill, Triple Kill,
Multi Kill, Ultra Kill, Monster Kill, Rampage and Godlike in that order.
The unmodified individual WAV files are in `quake-classic/originals/`.
The preview adjusts peak levels to -2 dBFS and adds 650 ms between clips.
It does not change the voices or pitch.

Source: [SFX Pack [Quake Sounds]!](https://staredit.net/files/2142/), uploaded by
Original-Hydra on April 18, 2010. The archive's author field says "Not Given".
`quake-classic/source.json` records the download, archive members and SHA-256
hashes. The source page does not identify a redistribution license for the
recordings. The seven selected WAVs have been copied unchanged into
`public/assets/audio/announcer/quake/` at the user's request.

`quake-classic/validation.json` records durations, peak levels and clipping
counts. The clips decode as 11,025 Hz, 16-bit mono PCM.

## Earlier Gemini auditions

Both WAVs were generated through the Google AI Studio UI in Brave with Gemini
3.8 Flash TTS. The original user tab was preserved. The prompts and voice names
are recorded in `gemini-prompts.json`.

- `01-dark-arena-algenib.wav`: first deep, gravelly arena direction.
- `02-berserker-mako.wav`: more aggressive direction following feedback.

The user chose the classic Quake announcer after these auditions.
The generated WAVs remain auditions only. The game uses the classic recordings.

## Game integration

The server counts enemy kills on its simulation clock. Consecutive kills within
four seconds trigger Double Kill (2), Triple Kill (3), Multi Kill (4), Ultra Kill
(5) and Monster Kill (6). Ten kills in one life trigger Rampage, twenty Godlike.
Streak milestones take precedence if both thresholds are reached together.
Death and authoritative respawn reset both counters. Teamkills, suicides,
posthumous kills, non-live phases and TTT do not advance the counters.

Only the living local killer hears the server-selected cue. An 80 ms window
coalesces simultaneous kills into the strongest announcement. Higher calls
replace the current voice; lower calls cannot interrupt it. Death, respawn,
leaving and hiding the tab stop speech. Locked audio and missing samples are
silent, with no delayed replay. Volume follows the existing master control.

The existing `/audio-preview.html` page contains a Quake card for each clip.
`node tools/announcer-test.mjs` covers the server, transport deduplication,
feedback routing, audio lifecycle and source hashes. No deployment was made.

Local browser verification used an isolated test server and the real game
client. Server-triggered Double Kill, Triple Kill and Monster Kill events
started decoded Web Audio sources. Six same-tick kills started only Monster
Kill. Death and an authoritative respawn of an already living player stopped
the active voice. The built-in bank decoded all 114 samples with zero failures,
including the seven original announcer clips. Static delivery tests verify the
WAV MIME type and unchanged response bytes for every clip.
