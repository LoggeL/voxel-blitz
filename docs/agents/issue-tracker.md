# Voxel Blitz issue tracker

This file is the durable feature-to-evidence index for agent-led changes. Keep
the fast acceptance path focused; heavyweight visual, audio, and container
evidence belongs to Extended QA.

| ID | Scope | Acceptance evidence | Status |
| --- | --- | --- | --- |
| VB-029-A | S&D bomb fuse uses the real `explodeAt` wire field | HUD contract consumes a server-built snapshot and asserts the visible fuse | Implemented; release verification pending |
| VB-029-B | Quick Play advertises server-owned map rotation and keeps at least five bots | HUD contract plus connected browser smoke | Implemented; release verification pending |
| VB-029-C | Respawn countdown is authoritative | Snapshot/mode smoke and spectator contract assert `respawnAt`; S&D remains round-based | Implemented; release verification pending |
| VB-029-D | Remote weapon alignment follows weapon-specific grip/support and sight anchors plus ADS, crouch, pitch, and firing state | Avatar contracts and the full avatar capture matrix | Implemented; release verification pending |
| VB-029-E | Hitmarker, confirmation sound, and damage number respect voxel cover | Combat-feedback visibility contract | Implemented; release verification pending |
| VB-029-F | Map previews remain derived from production geometry | Production map captures, map source ledger, and matching generated previews | Implemented; release verification pending |
| VB-029-G | Audio roster and profiles remain complete | Thirteen-asset inventory plus waveform, headroom, crest, clipping, and spectral audit | Implemented; release verification pending |
| VB-029-H | Connected menu, create details, Quick Play, pause/resume, and quit flow remains usable | Chromium CDP browser smoke including compact-width and focus checks | Implemented; release verification pending |
| VB-029-I | Fast and extended validation are enforced without test bloat | Fast CI plus scheduled/manual Extended QA workflows | Implemented; release verification pending |
| VB-029-J | Build contract matches current runtime interfaces | `BUILD-CONTRACT.md`, `README.md`, protocol keys, and shared mode helpers agree | Implemented; release verification pending |

## Release evidence

- Baseline: `c05382669aa72303a86a4e361fa49f7ac2e13270`
- Target commit: pending
- Production: pending at `https://voxel.logge.top`
