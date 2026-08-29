# Voxel Blitz issue tracker

This file is the durable feature-to-evidence index for agent-led changes. Keep
the fast acceptance path focused; heavyweight visual, audio, and container
evidence belongs to Extended QA.

| ID | Scope | Acceptance evidence | Status |
| --- | --- | --- | --- |
| VB-029-A | S&D bomb fuse uses the real `explodeAt` wire field | HUD contract consumes a server-built snapshot and asserts the visible fuse | Verified in `84354b9` |
| VB-029-B | Quick Play advertises server-owned map rotation and keeps at least five bots | HUD contract plus connected browser smoke | Verified in `84354b9` |
| VB-029-C | Respawn countdown is authoritative | Snapshot/mode smoke and spectator contract assert `respawnAt`; S&D remains round-based | Verified in `84354b9` |
| VB-029-D | Remote weapon alignment follows weapon-specific grip/support and sight anchors plus ADS, crouch, pitch, and firing state | Avatar contracts and the full avatar capture matrix | Verified in `84354b9` |
| VB-029-E | Hitmarker, confirmation sound, and damage number respect voxel cover | Combat-feedback visibility contract | Verified in `84354b9` |
| VB-029-F | Map previews remain derived from production geometry | Production map captures, map source ledger, and matching generated previews | Verified in `84354b9` |
| VB-029-G | Audio roster and profiles remain complete | Thirteen-asset inventory plus waveform, headroom, crest, clipping, and spectral audit | Verified in `84354b9` |
| VB-029-H | Connected menu, create details, Quick Play, pause/resume, and quit flow remains usable | Chromium CDP browser smoke including compact-width and focus checks | Verified in `84354b9` |
| VB-029-I | Fast and extended validation are enforced without test bloat | Fast CI plus scheduled/manual Extended QA workflows | Verified in `84354b9` |
| VB-029-J | Build contract matches current runtime interfaces | `BUILD-CONTRACT.md`, `README.md`, protocol keys, and shared mode helpers agree | Verified in `84354b9` |
| VB-030-A | Grenades charge while G is held and throw on release with authority-clamped distance | Input/netclient contracts plus authoritative grenade smoke | Verified in `5130cbe` |
| VB-030-B | HUD shows remaining grenade icons and live charge progress | Focused HUD contract plus connected browser inspection | Verified in `5130cbe` |
| VB-030-C | Killfeed identifies the weapon and the top strip shows team, alive state, and points | Focused HUD contract plus connected live-bot inspection | Verified in `5130cbe` |
| VB-030-D | Solstice is a deterministic all-mode solar-observatory arena with truthful preview art | Template invariants, six production capture views, iterative visual QA, and final production-rendered preview | Verified in `5130cbe` |
| VB-030-E | New behavior preserves modular seams without expanding the test-file count | Shared grenade rules, dedicated status-strip module, existing focused contracts, full suite, browser flow, and container smoke | Verified in `5130cbe` |

## VB-029 release evidence

- Baseline: `c05382669aa72303a86a4e361fa49f7ac2e13270`
- Feature commit: `84354b98e3f62335ac116c054926a17338ada232`
- Production: verified at `https://voxel.logge.top` on
  `2026-08-29T13:16:48Z`; the live Foundry preview matched the committed SHA-256,
  and the production HTTP/WebSocket smoke completed through map, lobby, and tick.

## VB-030 release evidence

- Baseline: `70687866af4b8dd56b3455a438afcfb54384d039`
- Feature commit: `5130cbe9569d9924c93af219340c0c2bcb85335d`
- Production: verified at `https://voxel.logge.top` on
  `2026-08-29T15:48:54Z`; the live Solstice preview matched committed SHA-256
  `983211daf1b4d2da3c69972796dd891673c1f2afa587d84f646b24b1061abab8`,
  the charged-grenade/status modules were present, the production menu rendered
  Solstice, and the HTTP/WebSocket smoke completed through map, lobby, and tick.
