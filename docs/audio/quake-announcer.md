# Quake announcer

The game uses seven unchanged recordings from the classic male "Quake Sounds"
pack: Double Kill, Triple Kill, Multi Kill, Ultra Kill, Monster Kill, Rampage
and Godlike. Runtime files and SHA-256 provenance are under
`public/assets/audio/announcer/quake/`. Generated TTS auditions are not shipped.

Source: [SFX Pack [Quake Sounds]!](https://staredit.net/files/2142/), uploaded by
Original-Hydra on April 18, 2010. The source does not identify the author or a
redistribution license. `sources.json` records the archive and selected members.

The server counts enemy kills on its simulation clock. Consecutive kills within
four seconds trigger Double Kill (2), Triple Kill (3), Multi Kill (4), Ultra Kill
(5) and Monster Kill (6). Ten kills in one life trigger Rampage, twenty Godlike.
Streak milestones take precedence when both thresholds are reached together.
Death and authoritative respawn reset both counters. Teamkills, suicides,
posthumous kills, non-live phases and TTT do not advance the counters.

Only the living local killer hears the selected cue. An 80 ms window combines
simultaneous kills into the strongest announcement. Higher calls replace the
current voice; lower calls cannot interrupt it. Death, respawn, leaving and
hiding the tab stop speech. Locked audio and missing samples stay silent, with
no delayed replay. Volume follows the existing master control.

The `/audio-preview.html` page contains a Quake card for every clip.
`npm run audio:test` covers server counters, event deduplication, feedback
routing, audio lifecycle and original hashes. `node tools/static-server-test.mjs`
checks the WAV MIME type and unchanged response bytes for all seven clips.

Local browser verification on September 24, 2026 used an isolated server and the
real client. Server-triggered Double Kill, Triple Kill and Monster Kill events
started decoded Web Audio sources. Six same-tick kills started only Monster
Kill. Death and authoritative respawn stopped the active voice, including a
respawn while already alive. All 114 built-in samples decoded without failures.
