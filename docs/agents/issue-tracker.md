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
| VB-031-A | Coarse-pointer devices can move, aim, fire, ADS, jump, reload, interact, swap, buy, and pause without pointer lock | Existing input contract plus connected touch-mode browser flow | Verified locally; release pending |
| VB-031-B | Mobile controls and HUD remain usable in phone landscape and portrait safe-area layouts | Deterministic 844×390 and 390×844 connected screenshots | Verified locally; release pending |
| VB-031-C | Mobile support remains behind a dedicated DOM/pointer lifecycle module without adding test files | `TouchControls` seam plus expanded input and browser contracts | Verified locally; release pending |
| VB-032-A | Mouse sensitivity uses a shooter-scale range with a versioned preference key and ADS/zoom look scaling | Input and HUD contracts plus the `LocalPlayer` look-scale contract | Verified locally; release pending |
| VB-032-B | Camera recoil is a weight-scaled impulse spring with aim climb and coupled roll | `LocalPlayer` recoil trace contract | Verified locally; release pending |
| VB-032-C | The first-person weapon moves independently of the eye: heavier follower with overshoot, ADS tightening, strafe lean, and mass-scaled kick springs | Viewmodel follower, ADS-lag, and strafe-lean contracts | Verified locally; release pending |
| VB-032-E | Mobile controls: aim anywhere, floating joystick, fire-and-aim drag, tap-toggle ADS, and gesture suppression in gameplay | Touch helper and input contracts plus connected touch browser flow | Verified locally; release pending |
| VB-033-A | Recoil recovery walks back a per-weapon fraction of aim climb after the reset window, net of mouse compensation | `LocalPlayer` recovery and compensation contracts | Verified locally; release pending |
| VB-033-B | Staged shotgun tube reload on server and client: rounds seat one at a time, firing interrupts, seated rounds stay; locally started reloads survive stale snapshots | Server smoke tube-reload checks, `WeaponState` staged/grace contract | Verified locally; release pending |
| VB-033-C | Sniper zoom steps (5×/2.5×) with optic-scaled sway, breath meter, and scope label | `LocalPlayer` zoom, `AimSway` optic, and HUD breath/zoom contracts | Verified locally; release pending |
| VB-033-D | Remote avatars show reload and weapon-draw poses with mass-scaled kick | Avatar weapon pose contract plus preserved mount/sight alignment contract | Verified locally; release pending |
| VB-033-E | Hit confirmation: kill marks with confirmation tone, stacked damage numbers, directional pain vignette, low-health heartbeat, death recap, and kill cam | Combat-feedback, HUD, and spectator kill-cam contracts | Verified locally; release pending |
| VB-033-F | Gamepad support (standard mapping, expo look, toggle crouch, aim assist for pad/touch only) combined with keyboard | Gamepad helper and `Input.poll` contracts | Verified locally; release pending |
| VB-033-G | Contextual mobile buttons (only actions the state allows), touch size/hand/sensitivity options | `visibleTouchActions`, `TouchControls.setContext/setOptions`, and settings-row contracts | Verified locally; release pending |
| VB-033-H | Trackpad handling: detection from the scroll stream, notch-accumulated weapon wheel, hotter smoothed look, toggle ADS default, `F` aim key, raw pointer-lock deltas | Input wheel/trackpad/ADS-mode contracts | Verified locally; release pending |
| VB-033-I | Reconciliation eases the camera through corrections and hard snaps instead of popping | `LocalPlayer` reconcile-offset contracts | Verified locally; release pending |
| VB-032-D | Grenade handling: shared launch/flight integrator, charge trajectory preview, instant local throw adopted by authority, wind-up/throw animation, pin/throw audio, fuse strobe, and max-charge HUD | Shared-rules, `GrenadeFX`, rig, and HUD contracts plus server grenade smoke | Verified locally; release pending |
| VB-034-A | RX-8 HAVOC rocket launcher (8th gun): authoritative projectile with contact detonation, splash, direct-hit bonus, terrain carve, and rocket-jump self knockback; predicted local rocket adopted by authority | Server smoke (flight, wall blast, rocket jump), shared rocket-rules and `ProjectileFX` contracts, eight-model viewmodel contract | Verified locally; release pending |
| VB-034-B | Throwable rework: frag (cookable fuse, in-hand detonation), limpet (sticks to walls/players, breaching carve), pulse (impact concussion, no carve), per-type inventory, chain detonation, type cycling on keyboard/pad, per-type HUD chips and cook hint | Server projectile smoke, shared-rules/`ProjectileFX`/input/netclient/HUD contracts | Verified locally; release pending |
| VB-034-C | LN-03 LONGARC as a charge coilgun: hold-to-charge with vent, charge-scaled damage, wall pierce gated by charge, chain arc from a full-charge body hit, coil glow, capacitor whine, coil meter, remote `charge` row field | Server charge/chain smoke, `WeaponState` charge path, HUD coil-meter contract, protocol key pin | Verified locally; release pending |
| VB-034-D | HUD silhouettes can be regenerated without a browser | `tools/render-hud-icon.mjs` software rasterizer (`npm run weapons:icons`) produced `rocket.png` | Verified locally; release pending |
| VB-035-A | Shared client/server movement constants and collision geometry | Existing gameplay suites plus wall/floor prediction parity contract | Verified locally; release pending |
| VB-035-B | Single-owner Training course, persistent target clears during attempts, and compatible map defaults | Atlas training lifecycle, client admission contracts, connected Training browser flow | Verified locally; release pending |
| VB-035-C | Swept projectile contacts follow ricochet legs and full flight distance; bolts always fizzle | Existing projectile scenarios plus outgoing-leg, embedded-bolt, frame-boundary, and fizzle regressions | Verified locally; release pending |
| VB-035-D | Weapon-wheel coordinator, correct tenth-slot key, touch suppression, and controller disconnect cancellation | Existing input/wheel contracts and connected browser flow | Verified locally; release pending |
| VB-035-E | Aim assist ranks visible enemies and ignores Training humans | Focused combat-feedback contracts | Verified locally; release pending |
| VB-035-F | Static requests are decoded once and checked before directory-index lookup | HTTP regressions with private directory-index fixtures and encoded traversal | Verified locally; release pending |
| VB-035-G | Compact weapon wheel stays legible; short-screen settings and lobby actions remain reachable | Connected browser flows and rendered screenshots at 390×844 and 844×390; natural roster height and scrollable settings | Verified locally; release pending |
| VB-036-A | Compact mobile controls, ammo-panel weapon swap, and essential HUD; removed touch crouch/grenade/zoom buttons, tap-to-fire, long-press wheel, haptics, and forced immersion | Existing input contracts, connected 320×568 and 844×390 browser flows, all size/hand combinations, and all-mode header bounds | Verified locally; release pending |
| VB-036-B | Reserve ammo actually displays and restores after switching away from melee | Existing HUD contract checks displayed reserve count | Verified locally; release pending |
| VB-037-A | Redesigned main menu with a clear play action, real Killhouse preview, dedicated Training shortcut, compact identity/join controls, and no fake telemetry | Existing HUD admission contracts and connected desktop/mobile menu, create, play, and Training flows | Verified locally; release pending |
| VB-037-B | Covered firing gallery, clear floor markings, skylit numbered course rooms, entrance portal, and finish return; no scattered collision debris | Five production camera renders, stable world fingerprint, gate lifecycle and on-foot target reachability contracts | Verified locally; release pending |
| VB-037-C | Indoor Training spawn and target positions use the floor under roofs | Existing map/headroom contracts and live Training handoff | Verified locally; release pending |

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
