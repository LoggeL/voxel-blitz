# Conquest sound effects

Conquest now plays recorded sound for its vehicles, explosions, impacts and ambience. The
flag cues, lock tones, alarms and the radio voices are synthesized by the build scripts. The banks are in `public/assets/audio/conquest/{vehicles,explosions,atmosphere}/`.
Each bank folder has a `sources.json` with the full provenance of every file. All files
are Ogg Opus at 48 kHz made with libopus (`-fflags +bitexact`): mono at 96 kbit/s, and the
stereo beds at 128 kbit/s. No Vorbis is used, because the local ffmpeg has no libvorbis.

The sounds were checked with spectrograms, loudness and peak measurements and loop-seam
measurements. **Nobody has listened to them in the game yet**, so treat the mix levels in
`CONQUEST_MIX` and `CONQUEST_TRIM_DB` (`public/js/audio/sfx.js`) and `SOUNDSCAPE`
(`public/js/audio/conquest-soundscape.js`) as first estimates. `CONQUEST_TRIM_DB` evens out takes
whose loudest 100 ms sit far from their group (coax and HMG rounds, the AA airbursts, the jet
burst); the 120 mm main gun is mixed above the 25 mm chin gun.

## Loading

- `public/js/audio/conquest-bank.js` lists the decoded groups (`cq.<group>.<n>`) and the
  streamed beds. Only the match runtime imports it, so the menu never loads it, and nothing
  from it is in `BUILTIN_SAMPLE_MANIFEST`.
- When a Conquest match boots, `main.js` calls `sfx.loadConquestBank(CONQUEST_SAMPLE_MANIFEST)`.
  The bank decodes in the background. Until a group has decoded, its cue keeps the old
  procedural voice, so other modes and a slow connection sound the same as before.
  Files that fail to fetch or decode are retried after 5 s and 20 s (`CONQUEST_BANK_RETRIES`).
  `sfx.unloadConquestBank()` frees the decoded audio when the match ends.
- On the low graphics tier (phones, weak laptops) `main.js` loads `CONQUEST_SAMPLE_MANIFEST_LITE`
  instead: only the first take of each group, about 58 instead of 85 MB of decoded audio.
- 183 files, 13.5 MiB in total:
  - The decoded part is 172 files and 5.4 MiB. Decoded, it takes about 85 MB of
    48 kHz float32 audio.
  - The 11 long stereo and mono beds (24 to 96 s, 8.1 MiB) play through `<audio>` elements.
    Each bed is fetched once into a Blob, so it can restart without HTTP Range requests, and it
    is never decoded to PCM. A bed is only fetched once the listener is in its range.
    Media elements do not loop sample-accurately, so each bed has two elements on the same Blob
    that hand over with a 0.6 s equal-power crossfade (`STREAM_CROSSFADE`) shortly before the
    end. Nobody has listened to the handover in a browser yet.
  - Static assets are served with `Cache-Control: no-cache` (`server/static.js`), so each
    Conquest boot revalidates the 172 decoded files and re-fetches the beds it needs. This is the
    policy for every asset; immutable, hashed URLs for the banks would avoid it.
- `tools/conquest-sfx-bank-test.mjs` enforces two budgets: under 14.5 MiB to download and
  under 95 MB decoded.

## What plays where

All cues come from authoritative events or snapshot fields. Positional cues use the shared
`VoicePool`, with HRTF, the 'near' (170 m) or 'far' (400 m) range, and its priorities. The
ambience zones mix through their own bus, using a distance gain and stereo pan, so they never
take one of the 24 positional voices.

| Trigger | Cue | Bank group(s) |
|---|---|---|
| `VehicleAudio` engine loop, tank | idle and rev crossfaded by speed and pitched with it; tracks by track speed; pivot squeal when the tracks run faster than the hull | `cq.tank.idle/rev/tracks/pivot` |
| … jeep | idle and drive crossfaded, revving through four gear bands; gravel tyres and suspension rattle by speed | `cq.jeep.idle/drive/tyres/rattle` |
| … helicopter / transport | outside loop pitched by `rotorSpeed`, crossfading to the distant thump from 60 to 150 m; cockpit or cabin loop for the crew (`self`, in the head); Doppler from `vx/vy/vz` | `cq.heli.*`, `cq.transport.*` |
| … plane | low and full turbine crossfaded by `enginePower`; afterburner layer above 80 %; low-passed for the pilot; Doppler | `cq.jet.ext/low/burner` |
| `rotorSpeed` leaves rest / slows on an empty rotor | spool-up / spool-down | `cq.rotor.spoolUp/Down` |
| Plane closest approach within 110 m and 4.6 s | flyby with its loudest moment aligned to the pass | `cq.jet.flyby` (peaks in `JET_FLYBY_PEAKS`) |
| Change in main-gun yaw relative to the hull (`mountAim`) | servo loop scaled by traverse rate; stop clunk | `cq.tank.turret`, `cq.tank.turretStop` |
| Hull in the river corridor of `FRONTIER_PLAN.river` | entry splash and churn loop | `cq.wade.splash/loop` |
| Jeep yaw rate ≥ 1.1 rad/s at ≥ 7 m/s | gravel skid | `cq.jeep.skid` |
| Shoot `tankAP/tankHE` | near crack-boom (≤ 260 m); recorded distant report past 150 m, delayed by distance / 343 m/s; between 150 and 260 m the near take is delayed the same way and fades out (`nearHandover`), so one shot never sounds twice; interior take for the crew | `cq.cannon.near/distant/interior` |
| Shell `projectileLaunch` passing ≤ 14 m from the camera | AP crack or HE incoming whistle, timed to the pass; cancelled if the shell bursts before the pass | `cq.shell.ap/he` |
| Shoot `coaxMG`/`hmg` | one recorded round per shot, random take, at most 3 overlapping; per-take trims (`CONQUEST_TRIM_DB`) lift them toward the infantry guns | `cq.gun.coaxMG/hmg` |
| Shoot `doorMinigun` | motor loop while firing; spin-down after the last round | `cq.gun.doorMinigun(Stop)` |
| Shoot `planeCannon` | burst take, or the ground-heard take past 120 m; restarts every 1.2 s, fades when firing stops | `cq.gun.planeCannon(Far)` |
| Shoot `chinCannon` / pods / `aaMissile` | 25 mm pop / rocket ripple / rail launch | `cq.chin`, `cq.pod`, `cq.aa.launch` |
| AA missile in flight | motor loop | `cq.aa.flight` |
| `projectileExplode` | frag, limpet, rocket, AA airburst, 25 mm pop, tank AP (2.5 m radius or `vehicleWeapon`) and HE; water geyser over a fluid block; distant boom past 150 m, aligned with the near take between 150 and 260 m; the distant boom holds its voice for 3 s (`FAR_BOOM_HOLD`) so gunfire can take the voice back. AA airbursts are trimmed up toward the rocket blasts | `cq.blast.*`, `cq.distant` |
| `vehicle_destroyed` / cook-off | blast per class (tank, jeep, helicopter or transport breakup, jet); cook-off crackle | `cq.destroy.*`, `cq.cookoff` |
| `block` break | stone, wood, metal or glass debris, at most 5 per 150 ms | `cq.debris.*` |
| Bullet wall impact (`TracerFX` → `Effects.onWallImpact`, also for vehicle hitscan guns through `VehicleFx._impact`) | dirt, stone, wood or metal hit within 45 m, at most 8 per 250 ms; 12 % ricochet off stone and metal. Rounds pass through water, so `TracerFX.probeWater` looks for the water entry on the part of each path within 50 m of the listener | `cq.bullet.*`, `cq.ricochet` |
| `vehicle_hit` | AT/HE/AA crunch (interior take for the crew); armour ping; jeep sheet metal; at most 4 per 250 ms (6 for the own hull, `HULL_HIT_SOUND`) | `cq.hull.*` |
| Countermeasure / hatch / reload | flares, smoke launcher; hatch per hull class; breech or feed tray | `cq.flares/smoke`, `cq.hatch.*`, `cq.reload.*` |
| Lock and alarm loops | seeker growl and lock, hull locking and locked, missile inbound; ground klaxon or air master caution | `cq.cue.*` |
| Burning hull or fresh wreck | fire roar loop, one variant per hull | `cq.burning` |
| `ejection`, `cq[7]` canopy | ejection seat; canopy snap; descent wind loop | `cq.eject`, `cq.chute.*` |
| Objective events (`objective-cues.js`) | synthesized capture-start, neutralized, captured, lost and low-tickets cues; a capture tick loop while the player stands in a moving zone (radius and, like the server, within `presenceDy` of the flag height from the map metadata). The announcer lines stay, and victory and defeat stay procedural | `cq.flag.*` |
| `ConquestSoundscape` | battle bed (low and high crossfaded by flag activity, kills and blasts); wind by weather and height; river and ford rapids; birds at A and B (silenced by nearby combat, scatter after a blast); crows; church bell (three tolls at match start and end, occasional single tolls); Kessler Works drone, steam and clanks; fire crackle at wreck props; radio chatter near the own HQ or in a vehicle | streams + `cq.amb.*` |
| `ConquestAmbience` salvo flash (`onArtillery`) | distant artillery boom delayed by distance / 343 m/s, attenuated over 900 m down to a 0.15 floor (no second range fade, so salvos past 600 m stay audible) | `cq.amb.artillery` |

## Licensing

Only these are used:

- **CC0 1.0** (Freesound).
- **CC BY 3.0/4.0** (Freesound).
- **U.S. federal government works** uploaded by official U.S. Navy, Marines and Army
  YouTube channels. Each YouTube license field was checked with yt-dlp and reads
  "Creative Commons Attribution license (reuse allowed)".
- **Original synthesis** made by the build scripts.

No game or film rips and no ElevenLabs credits were used. The key cannot read its
remaining balance, so nothing was generated with it.

Freesound files are the public HQ previews (Ogg Vorbis), because the original downloads
need a login. `download_sha256` in `sources.json` is the hash of that retrieved preview.

**Removed before shipping:** every layer from the Freesound user *craigsmith* was dropped. His
uploads are labelled CC0, but at least one of them is a TV-series excerpt ("Ricochets from
Bonanza TV series"), so the origin of his library is doubtful. The affected files were rebuilt
from other CC0 or CC BY material:

| File | Replacement source |
|---|---|
| jeep drive loop | Toyota Hilux diesel 4x4 rev |
| flares | fire whoosh |
| ejection seat | U.S. government rocket launch |
| parachute snap 2 | second take of the CC0 coat foley |
| burning loop 2 | later section of the CC0 car fire |
| battle beds | rebuilt without the howitzer layer |
| artillery 4 and 5 | other shots of the CC BY salute cannons |

**Removed after the license audit (2026-10-08):**

| File | Problem | Fix |
|---|---|---|
| battle beds (low and high) | MG layer from Freesound 855244 ("Distant Gunfire 3", qubodup), labelled CC0 but cut from NATO b-roll, which NATO licenses only under its own terms | rebuilt with the remaining CC0 and CC BY gunfire layers |
| `vehicles/jet-cannon-burst.ogg` | Freesound 611449 ("M61A2 Minigun", Seidhepriest), labelled CC0 while the uploader's profile restricts all files to non-commercial use | recut from the U.S. Navy video "CIWS Shoot Aboard GHWB" (Phalanx M61A1 20 mm, YouTube CC BY, U.S. federal work) |
| `combat/bullet-whiz*.ogg` (all modes) | standard YouTube license | recut from Audionautics' "Bullet passbys.wav" (Freesound, CC BY 3.0); see `public/assets/audio/LICENSES.md` |

Two files were dropped entirely:

- The jet cockpit loop. The pilot now hears the low turbine loop through a low-pass filter.
- The three-toll bell file. The single toll is scheduled three times instead, which saves
  3.5 MB of decoded audio.

The build scripts are in `tools/conquest-sfx/` (see its README): the per-file recipes with
every cut, the synthesis of the project-original cues (`atmosphere/recipes_synth.py`,
the lock tones and alarms in `vehicles/recipes.py`), the encoding, `integrate/integrate.py`
(copies the banks and writes `sources.json`) and `integrate/gen_docs.py` (credits and the
table below). The source downloads and analysis sheets are not committed; they stay in the
git-ignored work folder `.conquest-work/wip/sfx/` and can be fetched again from the URLs in
`sources.json`.

## Credits

The following recordings are used under Creative Commons Attribution licenses. For all of
them, changes were made: they were cut, filtered, level-normalized, looped or layered and
encoded as Opus. The same list is served as `/assets/audio/conquest/CREDITS.txt` and repeated
in `public/assets/audio/LICENSES.md`. The game has no in-game credits screen; if one is added,
it should link `CREDITS.txt`.

- "Incoming Artillery.wav" by bendodge (https://freesound.org/people/bendodge/sounds/170991/), CC BY 3.0 — https://creativecommons.org/licenses/by/3.0/. Cut, filtered, level-normalized, looped or layered and encoded as Opus. Used in: vehicles/shell-incoming-he.ogg.
- "Distant_gunfire_01.wav" by CGEffex (https://freesound.org/people/CGEffex/sounds/158979/), CC BY 4.0 — https://creativecommons.org/licenses/by/4.0/. Cut, filtered, level-normalized, looped or layered and encoded as Opus. Used in: atmosphere/battle-bed-high.ogg, atmosphere/battle-bed-low.ogg.
- "Distant WW2 Gunfire Kent.wav" by Cheeseheadburger (https://freesound.org/people/Cheeseheadburger/sounds/170478/), CC BY 4.0 — https://creativecommons.org/licenses/by/4.0/. Cut, filtered, level-normalized, looped or layered and encoded as Opus. Used in: atmosphere/battle-bed-high.ogg, atmosphere/battle-bed-low.ogg.
- "WAR-TANK, LEOPARD-ENGINE STAND BY-Leopard 2A4 48000 cc diesel engine close by-0003.wav" by JoniHeinonen (https://freesound.org/people/JoniHeinonen/sounds/161897/), CC BY 3.0 — https://creativecommons.org/licenses/by/3.0/. Cut, filtered, level-normalized, looped or layered and encoded as Opus. Used in: vehicles/tank-engine-idle.ogg.
- "Distant explosion.wav" by juskiddink (https://freesound.org/people/juskiddink/sounds/108640/), CC BY 4.0 — https://creativecommons.org/licenses/by/4.0/. Cut, filtered, level-normalized, looped or layered and encoded as Opus. Used in: explosions/distant-boom-2.ogg.
- "Apache AH-64 close 1223 PM 240501_0707" by klankbeeld (https://freesound.org/people/klankbeeld/sounds/734126/), CC BY 4.0 — https://creativecommons.org/licenses/by/4.0/. Cut, filtered, level-normalized, looped or layered and encoded as Opus. Used in: vehicles/heli-rotor-distant.ogg.
- "FlareGun_SizzleLoop01.wav" by marb7e (https://freesound.org/people/marb7e/sounds/674378/), CC BY 4.0 — https://creativecommons.org/licenses/by/4.0/. Cut, filtered, level-normalized, looped or layered and encoded as Opus. Used in: explosions/cookoff-1.ogg, vehicles/flares-salvo-1.ogg, vehicles/flares-salvo-2.ogg.
- "Demolition Range" by Marines (https://www.youtube.com/watch?v=gGsJk41G5_A), CC BY 3.0 (YouTube Creative Commons Attribution license) (U.S. federal government work, public domain in the U.S.; YouTube license field CC BY) — https://creativecommons.org/licenses/by/3.0/. Cut, filtered, level-normalized, looped or layered and encoded as Opus. Used in: explosions/frag-3.ogg, explosions/limpet-1.ogg.
- "Post Blast" by Marines (https://www.youtube.com/watch?v=nMwFtsxM__Q), CC BY 3.0 (YouTube Creative Commons Attribution license) (U.S. federal government work, public domain in the U.S.; YouTube license field CC BY) — https://creativecommons.org/licenses/by/3.0/. Cut, filtered, level-normalized, looped or layered and encoded as Opus. Used in: explosions/rocket-2.ogg.
- "Car driving through a ford.Wav" by NeilSeggar (https://freesound.org/people/NeilSeggar/sounds/335622/), CC BY 4.0 — https://creativecommons.org/licenses/by/4.0/. Cut, filtered, level-normalized, looped or layered and encoded as Opus. Used in: vehicles/vehicle-wade-loop.ogg.
- "Salute_Cannons.MP3" by nofeedbak (https://freesound.org/people/nofeedbak/sounds/95129/), CC BY 4.0 — https://creativecommons.org/licenses/by/4.0/. Cut, filtered, level-normalized, looped or layered and encoded as Opus. Used in: atmosphere/artillery-distant-1.ogg, atmosphere/artillery-distant-2.ogg, atmosphere/artillery-distant-3.ogg, atmosphere/artillery-distant-4.ogg, atmosphere/artillery-distant-5.ogg, atmosphere/battle-bed-high.ogg, atmosphere/battle-bed-low.ogg.
- "UH-1 "Huey" Iroquois Helicopter" by OroborosNZ (https://freesound.org/people/OroborosNZ/sounds/157722/), CC BY 4.0 — https://creativecommons.org/licenses/by/4.0/. Cut, filtered, level-normalized, looped or layered and encoded as Opus. Used in: vehicles/rotor-spool-up.ogg, vehicles/transport-rotor-ext.ogg.
- "DISTANT EXPLOSION 01.wav" by sandyrb (https://freesound.org/people/sandyrb/sounds/86291/), CC BY 4.0 — https://creativecommons.org/licenses/by/4.0/. Cut, filtered, level-normalized, looped or layered and encoded as Opus. Used in: explosions/distant-boom-4.ogg.
- "car going through ford 1.mp3" by soundmary (https://freesound.org/people/soundmary/sounds/194967/), CC BY 4.0 — https://creativecommons.org/licenses/by/4.0/. Cut, filtered, level-normalized, looped or layered and encoded as Opus. Used in: vehicles/vehicle-wade-splash.ogg.
- "Live Claymore" by The U.S. Army (https://www.youtube.com/watch?v=KJiqP8hurLU), CC BY 3.0 (YouTube Creative Commons Attribution license) (U.S. federal government work, public domain in the U.S.; YouTube license field CC BY) — https://creativecommons.org/licenses/by/3.0/. Cut, filtered, level-normalized, looped or layered and encoded as Opus. Used in: explosions/tank-he-3.ogg.
- "Eurofighter Typhoon Flyby 005 – Close Proximity" by TimoSchmied (https://freesound.org/people/TimoSchmied/sounds/640505/), CC BY 4.0 — https://creativecommons.org/licenses/by/4.0/. Cut, filtered, level-normalized, looped or layered and encoded as Opus. Used in: vehicles/jet-flyby-1.ogg.
- "CIWS Shoot Aboard GHWB" by U.S. Navy (https://www.youtube.com/watch?v=mlB5YtGP5LA), CC BY 3.0 (YouTube Creative Commons Attribution license) (U.S. federal government work, public domain in the U.S.; YouTube license field CC BY) — https://creativecommons.org/licenses/by/3.0/. Cut, filtered, level-normalized, looped or layered and encoded as Opus. Used in: vehicles/jet-cannon-burst.ogg.
- "MK 38 25mm gun live fire exercise" by U.S. Navy (https://www.youtube.com/watch?v=hWjXYw9eHRM), CC BY 3.0 (YouTube Creative Commons Attribution license) (U.S. federal government work, public domain in the U.S.; YouTube license field CC BY) — https://creativecommons.org/licenses/by/3.0/. Cut, filtered, level-normalized, looped or layered and encoded as Opus. Used in: vehicles/chin-cannon-1.ogg, vehicles/chin-cannon-2.ogg, vehicles/chin-cannon-3.ogg.
- "GAU-17 "Vulcan" Minigun Training From USS USS John P. Murtha" by U.S. Navy (https://www.youtube.com/watch?v=6tnUDX0WT8Q), CC BY 3.0 (YouTube Creative Commons Attribution license) (U.S. federal government work, public domain in the U.S.; YouTube license field CC BY) — https://creativecommons.org/licenses/by/3.0/. Cut, filtered, level-normalized, looped or layered and encoded as Opus. Used in: vehicles/transport-cabin.ogg.
- "What a sea mine explosion looks like" by U.S. Navy (https://www.youtube.com/watch?v=27Ia83p6rA4), CC BY 3.0 (YouTube Creative Commons Attribution license) (U.S. federal government work, public domain in the U.S.; YouTube license field CC BY) — https://creativecommons.org/licenses/by/3.0/. Cut, filtered, level-normalized, looped or layered and encoded as Opus. Used in: explosions/explosion-water-1.ogg.
- "Panssarivaunut maastossa / Tanks on terrain, tracks creaking" by YleArkisto (https://freesound.org/people/YleArkisto/sounds/386661/), CC BY 4.0 — https://creativecommons.org/licenses/by/4.0/. Cut, filtered, level-normalized, looped or layered and encoded as Opus. Used in: vehicles/tank-tracks-pivot.ogg.
- "Panssarivaunu ohi / Tank passing by and reversing back on sand, tracks creaking" by YleArkisto (https://freesound.org/people/YleArkisto/sounds/386590/), CC BY 4.0 — https://creativecommons.org/licenses/by/4.0/. Cut, filtered, level-normalized, looped or layered and encoded as Opus. Used in: vehicles/tank-tracks.ogg.
- "Helikopteri, lento, laskeutuminen, sisä / Helicopter, flying, starting to land, landing, engine shuts down slowly, rotor blade spins, interior, AB 412 Agusta, a 1986 model" by YleArkisto (https://freesound.org/people/YleArkisto/sounds/324971/), CC BY 4.0 — https://creativecommons.org/licenses/by/4.0/. Cut, filtered, level-normalized, looped or layered and encoded as Opus. Used in: vehicles/rotor-spool-down.ogg.
- "Pakettiauto, auton ovi, liukuovi / Sliding door of a van, car, open and close, exterior, Toyota Hiace, a 1990 model" by YleArkisto (https://freesound.org/people/YleArkisto/sounds/332853/), CC BY 4.0 — https://creativecommons.org/licenses/by/4.0/. Cut, filtered, level-normalized, looped or layered and encoded as Opus. Used in: vehicles/hatch-heli-door.ogg.

## All sources

Every source of every shipped file, with the cut taken from it (seconds). Rows titled "Original procedural synthesis" are layers made by the build scripts.

| Source | Author | License | Retrieved | Used in (cut) |
|---|---|---|---|---|
| [Falling scrap metal](https://freesound.org/people/13FPansk%C3%A1_Tolar_David/sounds/378670/) | 13FPanská_Tolar_David | CC0 1.0 | 2026-10-08 | `explosions/hull-hit-heavy-int-1.ogg` (0.000-1.500 s); `explosions/vehicle-destruction-tank.ogg` (0.000-3.000 s) |
| [Glass Shattering and Falling](https://freesound.org/people/221Beimesche/sounds/336425/) | 221Beimesche | CC0 1.0 | 2026-10-08 | `explosions/vehicle-destruction-jeep.ogg` (0.000-2.600 s) |
| [Parachute Opening 2 Options](https://freesound.org/people/2create/sounds/620310/) | 2create | CC0 1.0 | 2026-10-08 | `vehicles/parachute-open-1.ogg` (0.350-1.600 s); `vehicles/parachute-open-2.ogg` (1.950-3.300 s) |
| [4WD Engine & Rev.wav](https://freesound.org/people/Alex_hears_things/sounds/379914/) | Alex_hears_things | CC0 1.0 | 2026-10-08 | `vehicles/jeep-engine-drive.ogg` (50.000-56.600 s) |
| [metal crash 2.wav](https://freesound.org/people/AuDRoger/sounds/471192/) | AuDRoger | CC0 1.0 | 2026-10-08 | `explosions/vehicle-destruction-jet.ogg` (0.000-1.400 s) |
| [bullet hits the car](https://freesound.org/people/BorekPL/sounds/399550/) | BorekPL | CC0 1.0 | 2026-10-08 | `explosions/hull-hit-small-4.ogg` (0.116-0.720 s); `explosions/hull-hit-small-5.ogg` (1.746-2.350 s) |
| [Wind-Gusts-late-autumn.wav](https://freesound.org/people/BudJillett/sounds/109485/) | BudJillett | CC0 1.0 | 2026-10-08 | `atmosphere/wind-gust-swell.ogg` (3.000-13.000 s); `atmosphere/wind-valley-gusty.ogg` (78.000-144.600 s) |
| [Distant_gunfire_01.wav](https://freesound.org/people/CGEffex/sounds/158979/) | CGEffex | CC BY 4.0 | 2026-10-08 | `atmosphere/battle-bed-high.ogg` (0.170-1.600 s); `atmosphere/battle-bed-low.ogg` (0.170-1.600 s) |
| [Distant WW2 Gunfire Kent.wav](https://freesound.org/people/Cheeseheadburger/sounds/170478/) | Cheeseheadburger | CC BY 4.0 | 2026-10-08 | `atmosphere/battle-bed-high.ogg` (44.000-68.500 s, 16.000-42.000 s, 4.000-36.000 s, 14.000-44.000 s, 2.000-30.000 s, 40.000-68.500 s); `atmosphere/battle-bed-low.ogg` (14.000-44.000 s, 2.000-30.000 s, 40.000-68.500 s, 44.000-68.500 s, 16.000-42.000 s, 4.000-36.000 s) |
| [Solo Skydive Interior Plane and Freefall](https://freesound.org/people/DangerLaef/sounds/811077/) | DangerLaef | CC0 1.0 | 2026-10-08 | `vehicles/parachute-descent.ogg` (120.500-126.000 s) |
| [SFX_wood_cracking.wav](https://freesound.org/people/EricsSoundschmiede/sounds/669457/) | EricsSoundschmiede | CC0 1.0 | 2026-10-08 | `explosions/bullet-wood-1.ogg` (1.566-1.720 s); `explosions/bullet-wood-2.ogg` (1.306-1.460 s) |
| [Jeep Door Open-Close](https://freesound.org/people/Filmscore/sounds/828775/) | Filmscore | CC0 1.0 | 2026-10-08 | `vehicles/hatch-jeep-close.ogg` (5.120-5.950 s); `vehicles/hatch-jeep-open.ogg` (0.740-1.750 s) |
| [river flowing](https://freesound.org/people/Garuda1982/sounds/690137/) | Garuda1982 | CC0 1.0 | 2026-10-08 | `atmosphere/river-flow.ogg` (40.000-77.600 s) |
| [Combust.wav](https://freesound.org/people/GrimGrum/sounds/412558/) | GrimGrum | CC0 1.0 | 2026-10-08 | `explosions/cookoff-3.ogg` (0.000-2.400 s) |
| [Pebbles into a pond.wav](https://freesound.org/people/HenKonen/sounds/682165/) | HenKonen | CC0 1.0 | 2026-10-08 | `explosions/explosion-water-1.ogg` (1.996-5.000 s); `explosions/explosion-water-2.ogg` (4.996-8.000 s) |
| [(Distant)rumbling battle1](https://freesound.org/people/Jim-Bretherick/sounds/823852/) | Jim-Bretherick | CC0 1.0 | 2026-10-08 | `atmosphere/battle-bed-high.ogg` (4.000-89.600 s); `atmosphere/battle-bed-low.ogg` (4.000-101.600 s) |
| [Jet fighter flyby over Bardenas Reales Spain](https://freesound.org/people/JoanCalsina/sounds/851222/) | JoanCalsina | CC0 1.0 | 2026-10-08 | `vehicles/jet-flyby-3.ogg` (22.000-32.000 s) |
| [WAR-TANK, LEOPARD-ENGINE STAND BY-Leopard 2A4 48000 cc diesel engine close by-0003.wav](https://freesound.org/people/JoniHeinonen/sounds/161897/) | JoniHeinonen | CC BY 3.0 | 2026-10-08 | `vehicles/tank-engine-idle.ogg` (18.000-26.000 s) |
| [Radio Static](https://freesound.org/people/JovianSounds/sounds/524204/) | JovianSounds | CC0 1.0 | 2026-10-08 | `atmosphere/radio-chatter-2.ogg` (0.500-3.500 s); `atmosphere/radio-chatter-4.ogg` (1.800-5.400 s); `atmosphere/radio-squelch-2.ogg` (2.000-3.000 s) |
| [Radio Sign Off / Squelch](https://freesound.org/people/JovianSounds/sounds/524205/) | JovianSounds | CC0 1.0 | 2026-10-08 | `atmosphere/radio-chatter-3.ogg` (0.000-1.150 s); `atmosphere/radio-squelch-2.ogg` (0.000-1.150 s) |
| [Tank Reload](https://freesound.org/people/KieranKeegan/sounds/418882/) | KieranKeegan | CC0 1.0 | 2026-10-08 | `vehicles/tank-cannon-interior.ogg` (0.270-0.520 s); `vehicles/tank-turret-stop.ogg` (0.270-0.520 s) |
| [Explosion, Medium Blast](https://freesound.org/people/Kinoton/sounds/516914/) | Kinoton | CC0 1.0 | 2026-10-08 | `explosions/rocket-1.ogg` (0.246-3.550 s); `explosions/vehicle-destruction-jet.ogg` (0.246-3.050 s) |
| [distant explosions](https://freesound.org/people/Kostrava/sounds/320788/) | Kostrava | CC0 1.0 | 2026-10-08 | `atmosphere/battle-bed-high.ogg` (42.085-45.705 s, 30.075-33.695 s, 21.614-25.234 s, 34.712-38.332 s, 15.014-18.634 s, 26.193-29.813 s); `atmosphere/battle-bed-low.ogg` (21.614-25.234 s, 15.014-18.634 s, 42.085-45.705 s); `explosions/distant-boom-1.ogg` (28.996-34.600 s) |
| [Rocket Thrust 02](https://freesound.org/people/LilMati/sounds/515122/) | LilMati | CC0 1.0 | 2026-10-08 | `vehicles/aa-missile-flight.ogg` (20.000-23.400 s) |
| [Basic Fire Whoosh 2](https://freesound.org/people/LookIMadeAThing/sounds/260555/) | LookIMadeAThing | CC0 1.0 | 2026-10-08 | `explosions/vehicle-destruction-jeep.ogg` (0.000-3.000 s); `vehicles/flares-salvo-1.ogg` (0.000-0.800 s); `vehicles/flares-salvo-2.ogg` (0.000-0.800 s) |
| [Walkie-talkie end of transmission](https://freesound.org/people/LukaCafuka/sounds/760245/) | LukaCafuka | CC0 1.0 | 2026-10-08 | `atmosphere/radio-chatter-1.ogg` (0.000-0.400 s); `atmosphere/radio-chatter-4.ogg` (0.000-0.400 s) |
| [Demolition Range](https://www.youtube.com/watch?v=gGsJk41G5_A) | Marines | CC BY 3.0 (YouTube) + U.S. gov. work | 2026-10-08 | `explosions/frag-3.ogg` (21.296-22.450 s); `explosions/limpet-1.ogg` (74.196-77.600 s) |
| [Post Blast](https://www.youtube.com/watch?v=nMwFtsxM__Q) | Marines | CC BY 3.0 (YouTube) + U.S. gov. work | 2026-10-08 | `explosions/rocket-2.ogg` (0.296-3.900 s) |
| [djeep_idle.wav](https://freesound.org/people/Mihacappy/sounds/840649/) | Mihacappy | CC0 1.0 | 2026-10-08 | `vehicles/jeep-engine-idle.ogg` (0.300-4.600 s) |
| [Hooded Crow: Cawing](https://freesound.org/people/Mish7913/sounds/741366/) | Mish7913 | CC0 1.0 | 2026-10-08 | `atmosphere/crow-caw-1.ogg` (0.100-1.650 s) |
| [Car driving through a ford.Wav](https://freesound.org/people/NeilSeggar/sounds/335622/) | NeilSeggar | CC BY 4.0 | 2026-10-08 | `vehicles/vehicle-wade-loop.ogg` (3.600-6.400 s) |
| [SingleKnock_Wood](https://freesound.org/people/NoisyRedFox/sounds/742356/) | NoisyRedFox | CC0 1.0 | 2026-10-08 | `explosions/bullet-wood-1.ogg` (0.026-0.200 s); `explosions/bullet-wood-3.ogg` (0.026-0.200 s); `explosions/debris-wood-1.ogg` (0.016-0.200 s) |
| [Explosion_Debris_Short_Stereo.wav](https://freesound.org/people/Nox_Sound/sounds/560510/) | Nox_Sound | CC0 1.0 | 2026-10-08 | `explosions/tank-he-2.ogg` (2.996-7.400 s); `explosions/vehicle-destruction-tank.ogg` (7.996-12.800 s) |
| [Foley_Rocks_Stones_Impacts_Mono.wav](https://freesound.org/people/Nox_Sound/sounds/567701/) | Nox_Sound | CC0 1.0 | 2026-10-08 | `explosions/bullet-stone-1.ogg` (0.081-0.385 s); `explosions/bullet-stone-2.ogg` (1.556-1.860 s); `explosions/bullet-stone-3.ogg` (4.111-4.415 s); `explosions/bullet-stone-4.ogg` (6.411-6.715 s) |
| [Tires on Gravel Road 2](https://freesound.org/people/OBXJohn/sounds/251662/) | OBXJohn | CC0 1.0 | 2026-10-08 | `vehicles/jeep-tyres-gravel.ogg` (6.000-10.400 s) |
| [UH-1 "Huey" Iroquois Helicopter](https://freesound.org/people/OroborosNZ/sounds/157722/) | OroborosNZ | CC BY 4.0 | 2026-10-08 | `vehicles/rotor-spool-up.ogg` (18.000-20.500 s); `vehicles/rotor-spool-up.ogg` (2.000-4.600 s); `vehicles/transport-rotor-ext.ogg` (70.000-76.600 s) |
| [End radio transmission](https://freesound.org/people/ReadeOnly/sounds/47646/) | ReadeOnly | CC0 1.0 | 2026-10-08 | `atmosphere/radio-chatter-2.ogg` (0.000-0.400 s) |
| [metal_collision.wav](https://freesound.org/people/RichieMcMullen/sounds/386798/) | RichieMcMullen | CC0 1.0 | 2026-10-08 | `explosions/hull-hit-heavy-1.ogg` (0.946-2.650 s); `explosions/hull-hit-heavy-2.ogg` (0.946-2.650 s); `explosions/hull-hit-heavy-int-1.ogg` (0.946-2.650 s); `explosions/hull-hit-heavy-int-2.ogg` (0.946-2.650 s); `explosions/tank-ap-2.ogg` (0.896-2.500 s) |
| [Sharp Explosion 4 (of 5)](https://freesound.org/people/Rudmer_Rotteveel/sounds/336011/) | Rudmer_Rotteveel | CC0 1.0 | 2026-10-08 | `explosions/frag-1.ogg` (0.000-0.350 s); `explosions/frag-3.ogg` (0.000-0.300 s); `explosions/hull-hit-heavy-1.ogg` (0.000-0.300 s); `explosions/hull-hit-heavy-2.ogg` (0.000-0.300 s); `explosions/hull-hit-heavy-int-1.ogg` (0.000-0.300 s); `explosions/hull-hit-heavy-int-2.ogg` (0.000-0.300 s); `explosions/rocket-1.ogg` (0.000-0.300 s); `explosions/rocket-airburst-2.ogg` (0.000-0.300 s); `explosions/tank-ap-1.ogg` (0.000-0.350 s); `explosions/tank-ap-2.ogg` (0.000-0.300 s) |
| [20260420_23h30 Church bell half hour mark](https://freesound.org/people/Sadiquecat/sounds/852491/) | Sadiquecat | CC0 1.0 | 2026-10-08 | `atmosphere/church-bell-toll.ogg` (0.400-14.500 s) |
| [Scrap metal dropping / crashing](https://freesound.org/people/SamsterBirdies/sounds/587443/) | SamsterBirdies | CC0 1.0 | 2026-10-08 | `explosions/debris-metal-2.ogg` (4.776-5.530 s); `explosions/hull-hit-heavy-2.ogg` (0.036-1.240 s); `explosions/hull-hit-heavy-int-2.ogg` (0.036-1.240 s); `explosions/hull-hit-heavy-int-2.ogg` (2.536-4.040 s); `explosions/vehicle-destruction-heli.ogg` (8.086-10.490 s); `explosions/vehicle-destruction-jet.ogg` (10.816-12.820 s); `explosions/vehicle-destruction-tank.ogg` (0.036-2.240 s) |
| [Helicopter interior recording](https://freesound.org/people/Sanderboah/sounds/702748/) | Sanderboah | CC0 1.0 | 2026-10-08 | `vehicles/heli-cockpit.ogg` (20.000-26.600 s) |
| [Heavy steal door closing and locking.WAV](https://freesound.org/people/Sandermotions/sounds/275441/) | Sandermotions | CC0 1.0 | 2026-10-08 | `vehicles/breech-heavy-1.ogg` (4.150-4.750 s); `vehicles/hatch-canopy-close.ogg` (4.150-4.750 s); `vehicles/hatch-tank-close.ogg` (4.150-4.750 s) |
| [CrashingMetalObjects.wav](https://freesound.org/people/Sclolex/sounds/178202/) | Sclolex | CC0 1.0 | 2026-10-08 | `explosions/vehicle-destruction-heli.ogg` (0.000-2.600 s) |
| [Creaking Metal.wav](https://freesound.org/people/Soapuel/sounds/489442/) | Soapuel | CC0 1.0 | 2026-10-08 | `atmosphere/industrial-creak-clank.ogg` (16.600-18.900 s) |
| [wood breaking.aiff](https://freesound.org/people/SoundCollectah/sounds/109359/) | SoundCollectah | CC0 1.0 | 2026-10-08 | `explosions/bullet-wood-3.ogg` (0.331-0.515 s); `explosions/debris-wood-1.ogg` (1.026-1.580 s) |
| [Metal Sheet Hit](https://freesound.org/people/Stereo%20Surgeon/sounds/262516/) | Stereo Surgeon | CC0 1.0 | 2026-10-08 | `explosions/limpet-1.ogg` (0.000-1.200 s) |
| [121003 Pigeon flock fly away, wing flaps, Toronto.wav](https://freesound.org/people/TRP/sounds/616623/) | TRP | CC0 1.0 | 2026-10-08 | `atmosphere/birds-scatter.ogg` (1.100-5.600 s) |
| [Live Claymore](https://www.youtube.com/watch?v=KJiqP8hurLU) | The U.S. Army | CC BY 3.0 (YouTube) + U.S. gov. work | 2026-10-08 | `explosions/tank-he-3.ogg` (34.296-37.500 s) |
| [Fire Crackle and Flames 001](https://freesound.org/people/TheWoodlandNomad/sounds/363093/) | TheWoodlandNomad | CC0 1.0 | 2026-10-08 | `atmosphere/wreck-fire-crackle.ogg` (2.000-26.900 s) |
| [Afterburner](https://freesound.org/people/TiesWijnen/sounds/413312/) | TiesWijnen | CC0 1.0 | 2026-10-08 | `vehicles/jet-afterburner-lightoff.ogg` (0.000-2.300 s) |
| [Eurofighter Typhoon Flyby 005 – Close Proximity](https://freesound.org/people/TimoSchmied/sounds/640505/) | TimoSchmied | CC BY 4.0 | 2026-10-08 | `vehicles/jet-flyby-1.ogg` (1.000-10.500 s) |
| [What a sea mine explosion looks like](https://www.youtube.com/watch?v=27Ia83p6rA4) | U.S. Navy | CC BY 3.0 (YouTube) + U.S. gov. work | 2026-10-08 | `explosions/explosion-water-1.ogg` (0.196-3.600 s) |
| [GAU-17 "Vulcan" Minigun Training From USS USS John P. Murtha](https://www.youtube.com/watch?v=6tnUDX0WT8Q) | U.S. Navy | CC BY 3.0 (YouTube) + U.S. gov. work | 2026-10-08 | `vehicles/transport-cabin.ogg` (8.000-14.600 s) |
| [MK 38 25mm gun live fire exercise](https://www.youtube.com/watch?v=hWjXYw9eHRM) | U.S. Navy | CC BY 3.0 (YouTube) + U.S. gov. work | 2026-10-08 | `vehicles/chin-cannon-1.ogg` (3.990-4.750 s); `vehicles/chin-cannon-2.ogg` (6.760-7.520 s); `vehicles/chin-cannon-3.ogg` (9.830-10.590 s) |
| [CIWS Shoot Aboard GHWB](https://www.youtube.com/watch?v=mlB5YtGP5LA) | U.S. Navy | CC BY 3.0 (YouTube) + U.S. gov. work | 2026-10-08 | `vehicles/jet-cannon-burst.ogg` (36.600-39.900 s) |
| Original procedural synthesis (work-atmosphere/recipes_synth.py) | VOXEL BLITZ build script | Project original (no third-party audio) | 2026-10-08 | `atmosphere/flag-capture-progress-loop.ogg` (—) |
| Original procedural synthesis (work-atmosphere/recipes_synth.py) | VOXEL BLITZ build script | Project original (no third-party audio) | 2026-10-08 | `atmosphere/flag-capture-start.ogg` (—) |
| Original procedural synthesis (work-atmosphere/recipes_synth.py) | VOXEL BLITZ build script | Project original (no third-party audio) | 2026-10-08 | `atmosphere/flag-captured.ogg` (—) |
| Original procedural synthesis (work-atmosphere/recipes_synth.py) | VOXEL BLITZ build script | Project original (no third-party audio) | 2026-10-08 | `atmosphere/flag-lost.ogg` (—) |
| Original procedural synthesis (work-atmosphere/recipes_synth.py) | VOXEL BLITZ build script | Project original (no third-party audio) | 2026-10-08 | `atmosphere/flag-neutralized.ogg` (—) |
| Original procedural synthesis (work-atmosphere/recipes_synth.py) | VOXEL BLITZ build script | Project original (no third-party audio) | 2026-10-08 | `atmosphere/radio-chatter-1.ogg` (—) |
| Original procedural synthesis (work-atmosphere/recipes_synth.py) | VOXEL BLITZ build script | Project original (no third-party audio) | 2026-10-08 | `atmosphere/radio-chatter-2.ogg` (—) |
| Original procedural synthesis (work-atmosphere/recipes_synth.py) | VOXEL BLITZ build script | Project original (no third-party audio) | 2026-10-08 | `atmosphere/radio-chatter-3.ogg` (—) |
| Original procedural synthesis (work-atmosphere/recipes_synth.py) | VOXEL BLITZ build script | Project original (no third-party audio) | 2026-10-08 | `atmosphere/radio-chatter-4.ogg` (—) |
| Original procedural synthesis (work-atmosphere/recipes_synth.py) | VOXEL BLITZ build script | Project original (no third-party audio) | 2026-10-08 | `atmosphere/tickets-low-urgency.ogg` (—) |
| Original procedural layer (this project build script) | VOXEL BLITZ build script | Project original (no third-party audio) | 2026-10-08 | `explosions/autocannon-impact-1.ogg` (—) |
| Original procedural layer (this project build script) | VOXEL BLITZ build script | Project original (no third-party audio) | 2026-10-08 | `explosions/autocannon-impact-2.ogg` (—) |
| Original procedural layer (this project build script) | VOXEL BLITZ build script | Project original (no third-party audio) | 2026-10-08 | `explosions/explosion-water-1.ogg` (—) |
| Original procedural layer (this project build script) | VOXEL BLITZ build script | Project original (no third-party audio) | 2026-10-08 | `explosions/explosion-water-2.ogg` (—) |
| Original procedural layer (this project build script) | VOXEL BLITZ build script | Project original (no third-party audio) | 2026-10-08 | `explosions/frag-1.ogg` (—) |
| Original procedural layer (this project build script) | VOXEL BLITZ build script | Project original (no third-party audio) | 2026-10-08 | `explosions/frag-2.ogg` (—) |
| Original procedural layer (this project build script) | VOXEL BLITZ build script | Project original (no third-party audio) | 2026-10-08 | `explosions/frag-3.ogg` (—) |
| Original procedural layer (this project build script) | VOXEL BLITZ build script | Project original (no third-party audio) | 2026-10-08 | `explosions/hull-hit-heavy-1.ogg` (—) |
| Original procedural layer (this project build script) | VOXEL BLITZ build script | Project original (no third-party audio) | 2026-10-08 | `explosions/hull-hit-heavy-2.ogg` (—) |
| Original procedural layer (this project build script) | VOXEL BLITZ build script | Project original (no third-party audio) | 2026-10-08 | `explosions/hull-hit-heavy-int-1.ogg` (—) |
| Original procedural layer (this project build script) | VOXEL BLITZ build script | Project original (no third-party audio) | 2026-10-08 | `explosions/hull-hit-heavy-int-2.ogg` (—) |
| Original procedural layer (this project build script) | VOXEL BLITZ build script | Project original (no third-party audio) | 2026-10-08 | `explosions/limpet-1.ogg` (—) |
| Original procedural layer (this project build script) | VOXEL BLITZ build script | Project original (no third-party audio) | 2026-10-08 | `explosions/limpet-2.ogg` (—) |
| Original procedural layer (this project build script) | VOXEL BLITZ build script | Project original (no third-party audio) | 2026-10-08 | `explosions/rocket-1.ogg` (—) |
| Original procedural layer (this project build script) | VOXEL BLITZ build script | Project original (no third-party audio) | 2026-10-08 | `explosions/rocket-2.ogg` (—) |
| Original procedural layer (this project build script) | VOXEL BLITZ build script | Project original (no third-party audio) | 2026-10-08 | `explosions/tank-ap-1.ogg` (—) |
| Original procedural layer (this project build script) | VOXEL BLITZ build script | Project original (no third-party audio) | 2026-10-08 | `explosions/tank-ap-2.ogg` (—) |
| Original procedural layer (this project build script) | VOXEL BLITZ build script | Project original (no third-party audio) | 2026-10-08 | `explosions/tank-he-1.ogg` (—) |
| Original procedural layer (this project build script) | VOXEL BLITZ build script | Project original (no third-party audio) | 2026-10-08 | `explosions/tank-he-2.ogg` (—) |
| Original procedural layer (this project build script) | VOXEL BLITZ build script | Project original (no third-party audio) | 2026-10-08 | `explosions/tank-he-3.ogg` (—) |
| Original procedural layer (this project build script) | VOXEL BLITZ build script | Project original (no third-party audio) | 2026-10-08 | `explosions/vehicle-destruction-heli.ogg` (—) |
| Original procedural layer (this project build script) | VOXEL BLITZ build script | Project original (no third-party audio) | 2026-10-08 | `explosions/vehicle-destruction-jeep.ogg` (—) |
| Original procedural layer (this project build script) | VOXEL BLITZ build script | Project original (no third-party audio) | 2026-10-08 | `explosions/vehicle-destruction-jet.ogg` (—) |
| Original procedural layer (this project build script) | VOXEL BLITZ build script | Project original (no third-party audio) | 2026-10-08 | `explosions/vehicle-destruction-tank.ogg` (—) |
| Original procedural synthesis (this project) | VOXEL BLITZ build script | Project original (no third-party audio) | 2026-10-08 | `vehicles/alarm-air-caution.ogg` (—) |
| Original procedural synthesis (this project) | VOXEL BLITZ build script | Project original (no third-party audio) | 2026-10-08 | `vehicles/alarm-ground-klaxon.ogg` (—) |
| Original procedural synthesis (this project) | VOXEL BLITZ build script | Project original (no third-party audio) | 2026-10-08 | `vehicles/lock-hull-locked.ogg` (—) |
| Original procedural synthesis (this project) | VOXEL BLITZ build script | Project original (no third-party audio) | 2026-10-08 | `vehicles/lock-hull-locking.ogg` (—) |
| Original procedural synthesis (this project) | VOXEL BLITZ build script | Project original (no third-party audio) | 2026-10-08 | `vehicles/lock-missile-inbound.ogg` (—) |
| Original procedural synthesis (this project) | VOXEL BLITZ build script | Project original (no third-party audio) | 2026-10-08 | `vehicles/lock-seeker-growl.ogg` (—) |
| Original procedural synthesis (this project) | VOXEL BLITZ build script | Project original (no third-party audio) | 2026-10-08 | `vehicles/lock-seeker-locked.ogg` (—) |
| Original procedural synthesis (this project) | VOXEL BLITZ build script | Project original (no third-party audio) | 2026-10-08 | `vehicles/shell-flyby-ap.ogg` (—) |
| [Knock_wood](https://freesound.org/people/Weak_Hero/sounds/584941/) | Weak_Hero | CC0 1.0 | 2026-10-08 | `explosions/bullet-wood-2.ogg` (0.996-1.220 s) |
| [Helikopteri, lento, laskeutuminen, sisä / Helicopter, flying, starting to land, landing, engine shuts down slowly, rotor blade spins, interior, AB 412 Agusta, a 1986 model](https://freesound.org/people/YleArkisto/sounds/324971/) | YleArkisto | CC BY 4.0 | 2026-10-08 | `vehicles/rotor-spool-down.ogg` (191.000-197.600 s) |
| [Pakettiauto, auton ovi, liukuovi / Sliding door of a van, car, open and close, exterior, Toyota Hiace, a 1990 model](https://freesound.org/people/YleArkisto/sounds/332853/) | YleArkisto | CC BY 4.0 | 2026-10-08 | `vehicles/hatch-heli-door.ogg` (13.400-16.450 s) |
| [Panssarivaunu ohi / Tank passing by and reversing back on sand, tracks creaking](https://freesound.org/people/YleArkisto/sounds/386590/) | YleArkisto | CC BY 4.0 | 2026-10-08 | `vehicles/tank-tracks.ogg` (50.000-55.000 s) |
| [Panssarivaunut maastossa / Tanks on terrain, tracks creaking](https://freesound.org/people/YleArkisto/sounds/386661/) | YleArkisto | CC BY 4.0 | 2026-10-08 | `vehicles/tank-tracks-pivot.ogg` (66.000-70.500 s) |
| [Start-up Sound - U.S. Army M1A1 Tank - Gas Turbine Engine.mp3](https://freesound.org/people/adr1911/sounds/542582/) | adr1911 | CC0 1.0 | 2026-10-08 | `vehicles/tank-engine-rev.ogg` (10.000-16.600 s) |
| [Distant Three Round Burst](https://freesound.org/people/adrilahan/sounds/337242/) | adrilahan | CC0 1.0 | 2026-10-08 | `atmosphere/battle-bed-high.ogg` (0.000-1.400 s); `atmosphere/battle-bed-low.ogg` (0.000-1.400 s) |
| [fire ambience, flames, crackles, pops, burning](https://freesound.org/people/ahriik/sounds/508110/) | ahriik | CC0 1.0 | 2026-10-08 | `atmosphere/wreck-fire-crackle.ogg` (1.000-25.900 s) |
| [Browning M2 chamber](https://freesound.org/people/areniporgen/sounds/737219/) | areniporgen | CC0 1.0 | 2026-10-08 | `vehicles/breech-heavy-2.ogg` (0.030-0.450 s); `vehicles/feed-tray-clack.ogg` (0.030-0.750 s) |
| [bullet ricochet.wav](https://freesound.org/people/aust_paul/sounds/30932/) | aust_paul | CC0 1.0 | 2026-10-08 | `explosions/bullet-stone-4.ogg` (0.986-1.590 s); `explosions/hull-hit-small-3.ogg` (1.621-2.225 s); `explosions/ricochet-3.ogg` (0.986-1.590 s) |
| [Incoming Artillery.wav](https://freesound.org/people/bendodge/sounds/170991/) | bendodge | CC BY 3.0 | 2026-10-08 | `vehicles/shell-incoming-he.ogg` (0.300-2.820 s) |
| [.22 ricochet.mp3](https://freesound.org/people/cedarstudios/sounds/148827/) | cedarstudios | CC0 1.0 | 2026-10-08 | `explosions/ricochet-1.ogg` (1.851-2.655 s); `explosions/ricochet-2.ogg` (2.926-3.730 s) |
| [Walkie_Talkie_Static.aif](https://freesound.org/people/crcavol/sounds/154654/) | crcavol | CC0 1.0 | 2026-10-08 | `atmosphere/radio-chatter-1.ogg` (1.000-3.200 s); `atmosphere/radio-chatter-3.ogg` (4.000-5.700 s); `atmosphere/radio-squelch-1.ogg` (6.000-6.600 s) |
| [Smash.ogg](https://freesound.org/people/egomassive/sounds/536777/) | egomassive | CC0 1.0 | 2026-10-08 | `explosions/debris-wood-2.ogg` (0.000-0.850 s) |
| [Wind blowing in an antenna on the High Atlas mountain (Morocco).](https://freesound.org/people/felix.blume/sounds/160469/) | felix.blume | CC0 1.0 | 2026-10-08 | `atmosphere/wind-ridge-whistle.ogg` (30.000-90.100 s) |
| [Big dynamite explosion in an open mine (Chile)](https://freesound.org/people/felix.blume/sounds/475780/) | felix.blume | CC0 1.0 | 2026-10-08 | `explosions/distant-boom-2.ogg` (1.996-8.000 s); `explosions/distant-boom-3.ogg` (0.000-6.600 s) |
| [Fire Auto - car on fire](https://freesound.org/people/florianreichelt/sounds/563765/) | florianreichelt | CC0 1.0 | 2026-10-08 | `vehicles/vehicle-burning-1.ogg` (4.000-10.600 s); `vehicles/vehicle-burning-2.ogg` (10.800-17.400 s) |
| [snd_metal_smash.wav](https://freesound.org/people/gristi/sounds/562198/) | gristi | CC0 1.0 | 2026-10-08 | `explosions/hull-hit-heavy-1.ogg` (0.000-1.300 s); `explosions/hull-hit-heavy-int-1.ogg` (0.000-1.300 s); `explosions/limpet-2.ogg` (0.000-1.300 s); `explosions/tank-ap-2.ogg` (0.000-1.200 s); `explosions/vehicle-destruction-jeep.ogg` (0.000-1.600 s) |
| [fire-whoosh.wav](https://freesound.org/people/hnhnh/sounds/244926/) | hnhnh | CC0 1.0 | 2026-10-08 | `explosions/cookoff-2.ogg` (0.096-2.100 s); `explosions/vehicle-destruction-heli.ogg` (0.146-2.550 s); `explosions/vehicle-destruction-jet.ogg` (0.146-3.150 s); `explosions/vehicle-destruction-tank.ogg` (0.146-3.550 s) |
| [Bricks/Stones/Rocks/Gravel Falling](https://freesound.org/people/iwanPlays/sounds/567249/) | iwanPlays | CC0 1.0 | 2026-10-08 | `explosions/debris-stone-2.ogg` (1.996-2.600 s); `explosions/frag-3.ogg` (0.796-1.400 s); `explosions/tank-he-1.ogg` (0.196-2.800 s); `explosions/tank-he-3.ogg` (0.296-2.900 s) |
| [Stones Falling](https://freesound.org/people/iwanPlays/sounds/567251/) | iwanPlays | CC0 1.0 | 2026-10-08 | `explosions/bullet-dirt-1.ogg` (1.196-1.400 s); `explosions/bullet-dirt-2.ogg` (1.596-1.800 s); `explosions/bullet-dirt-3.ogg` (1.996-2.200 s); `explosions/bullet-dirt-4.ogg` (2.396-2.600 s); `explosions/debris-stone-1.ogg` (0.996-1.600 s); `explosions/frag-1.ogg` (0.996-1.700 s); `explosions/frag-2.ogg` (1.996-2.600 s) |
| [AMBBird_Birds In Rural Area Early Spring Morning_Jaku5.wav](https://freesound.org/people/jakubp.jp/sounds/566147/) | jakubp.jp | CC0 1.0 | 2026-10-08 | `atmosphere/birds-countryside-bed.ogg` (118.000-180.100 s) |
| [Distant explosion.wav](https://freesound.org/people/juskiddink/sounds/108640/) | juskiddink | CC BY 4.0 | 2026-10-08 | `explosions/distant-boom-2.ogg` (0.096-4.000 s) |
| [EXPLODE_FIRECRACKER.wav](https://freesound.org/people/keng-wai-chane-chick-te/sounds/462363/) | keng-wai-chane-chick-te | CC0 1.0 | 2026-10-08 | `explosions/autocannon-impact-3.ogg` (0.366-0.570 s); `explosions/frag-2.ogg` (0.366-0.670 s); `explosions/rocket-2.ogg` (0.366-0.670 s) |
| [Explosion004.wav](https://freesound.org/people/klangfabrik/sounds/220062/) | klangfabrik | CC0 1.0 | 2026-10-08 | `explosions/limpet-2.ogg` (0.000-3.600 s) |
| [rpg launcher  three shots.wav](https://freesound.org/people/klangfabrik/sounds/249298/) | klangfabrik | CC0 1.0 | 2026-10-08 | `vehicles/ejection-seat-1.ogg` (0.095-0.355 s); `vehicles/ejection-seat-2.ogg` (3.940-4.200 s); `vehicles/rocket-pod-1.ogg` (0.095-1.805 s); `vehicles/rocket-pod-2.ogg` (3.940-5.650 s); `vehicles/rocket-pod-3.ogg` (7.855-9.565 s) |
| [F15 Eagle flyover.wav](https://freesound.org/people/klangfabrik/sounds/324370/) | klangfabrik | CC0 1.0 | 2026-10-08 | `vehicles/jet-flyby-2.ogg` (5.500-15.500 s) |
| [Apache AH-64 close 1223 PM 240501_0707](https://freesound.org/people/klankbeeld/sounds/734126/) | klankbeeld | CC BY 4.0 | 2026-10-08 | `vehicles/heli-rotor-distant.ogg` (4.000-10.600 s) |
| [fireworks firecrackers close nice fizzle and pops various right side onmic.flac](https://freesound.org/people/kyles/sounds/404999/) | kyles | CC0 1.0 | 2026-10-08 | `explosions/cookoff-2.ogg` (9.316-10.720 s); `explosions/cookoff-3.ogg` (31.376-33.280 s) |
| [door metal big heavy close kinda slam thud echo offmic.wav](https://freesound.org/people/kyles/sounds/406197/) | kyles | CC0 1.0 | 2026-10-08 | `explosions/hull-hit-heavy-2.ogg` (0.276-2.080 s); `explosions/hull-hit-heavy-int-2.ogg` (0.276-2.080 s); `vehicles/breech-heavy-2.ogg` (0.280-1.000 s); `vehicles/ejection-seat-1.ogg` (0.280-0.900 s); `vehicles/ejection-seat-2.ogg` (0.280-0.900 s) |
| [metal heavy dungeon prison door unlatch open close thud rattle and hatch open close slide squeak various ext perspective on offmic +bg hostel kitchen sounds2.wav](https://freesound.org/people/kyles/sounds/407323/) | kyles | CC0 1.0 | 2026-10-08 | `vehicles/breech-heavy-1.ogg` (32.350-33.300 s); `vehicles/hatch-tank-close.ogg` (32.350-33.900 s); `vehicles/hatch-tank-open.ogg` (26.250-28.300 s) |
| [flare fire real dull crack slap.wav](https://freesound.org/people/kyles/sounds/450837/) | kyles | CC0 1.0 | 2026-10-08 | `explosions/cookoff-1.ogg` (0.000-0.800 s); `vehicles/flares-salvo-1.ogg` (0.040-0.600 s); `vehicles/flares-salvo-2.ogg` (0.040-0.600 s) |
| [auto truck jeep onboard driving rough terrain dirt rock various speeds slow to stop and pull up MS.wav](https://freesound.org/people/kyles/sounds/451044/) | kyles | CC0 1.0 | 2026-10-08 | `vehicles/jeep-suspension-rattle.ogg` (12.000-16.400 s) |
| [industrial steam pipes hiss hum.flac](https://freesound.org/people/kyles/sounds/453462/) | kyles | CC0 1.0 | 2026-10-08 | `atmosphere/industrial-drone.ogg` (10.000-37.600 s) |
| [mountain wind heavy strong gusts Swiss Alps.flac](https://freesound.org/people/kyles/sounds/454092/) | kyles | CC0 1.0 | 2026-10-08 | `atmosphere/wind-valley-bed.ogg` (78.000-136.100 s) |
| [noisy industrial factory ambience2 with releases.flac](https://freesound.org/people/kyles/sounds/455816/) | kyles | CC0 1.0 | 2026-10-08 | `atmosphere/industrial-drone.ogg` (6.000-33.600 s); `atmosphere/industrial-steam-release.ogg` (33.200-38.800 s) |
| [auto car or van stop brake skid gravel short.flac](https://freesound.org/people/kyles/sounds/637161/) | kyles | CC0 1.0 | 2026-10-08 | `vehicles/jeep-skid-gravel.ogg` (0.000-1.100 s) |
| [water splashes big hand slaps spray and wave.flac](https://freesound.org/people/kyles/sounds/637974/) | kyles | CC0 1.0 | 2026-10-08 | `explosions/explosion-water-2.ogg` (0.496-1.700 s); `explosions/explosion-water-2.ogg` (5.756-6.960 s) |
| [Concrete Breaks Several Denoised](https://freesound.org/people/loganzsound/sounds/843339/) | loganzsound | CC0 1.0 | 2026-10-08 | `explosions/debris-stone-1.ogg` (3.196-3.900 s); `explosions/debris-stone-2.ogg` (6.156-6.860 s) |
| [Rotating tank turret planetary electric motor](https://freesound.org/people/lorefold/sounds/607310/) | lorefold | CC0 1.0 | 2026-10-08 | `vehicles/tank-turret-stop.ogg` (49.000-50.400 s); `vehicles/tank-turret-traverse.ogg` (12.000-15.500 s) |
| [Radio Buzz / Squelch 1](https://freesound.org/people/magnuswaker/sounds/522164/) | magnuswaker | CC0 1.0 | 2026-10-08 | `atmosphere/radio-squelch-1.ogg` (0.000-0.300 s) |
| [FlareGun_SizzleLoop01.wav](https://freesound.org/people/marb7e/sounds/674378/) | marb7e | CC BY 4.0 | 2026-10-08 | `explosions/cookoff-1.ogg` (0.000-2.100 s); `vehicles/flares-salvo-1.ogg` (0.000-2.100 s); `vehicles/flares-salvo-2.ogg` (0.000-2.100 s) |
| [Foley bullet hit metal 02.wav](https://freesound.org/people/martian/sounds/182263/) | martian | CC0 1.0 | 2026-10-08 | `explosions/bullet-metal-1.ogg` (2.676-3.060 s); `explosions/bullet-metal-2.ogg` (4.456-4.840 s); `explosions/bullet-metal-3.ogg` (7.281-7.665 s); `explosions/hull-hit-small-2.ogg` (0.106-0.370 s); `explosions/hull-hit-small-3.ogg` (7.281-7.585 s) |
| [glass break 3.wav](https://freesound.org/people/mccormick_iain/sounds/371092/) | mccormick_iain | CC0 1.0 | 2026-10-08 | `explosions/debris-glass-2.ogg` (0.056-0.860 s) |
| [Grenade Open Field High Quality 2](https://freesound.org/people/modusmogulus/sounds/752629/) | modusmogulus | CC0 1.0 | 2026-10-08 | `explosions/frag-1.ogg` (0.446-2.350 s); `explosions/frag-2.ogg` (0.000-2.200 s); `explosions/tank-ap-1.ogg` (0.596-1.800 s) |
| [tank_engine.wav](https://freesound.org/people/monosfera/sounds/572294/) | monosfera | CC0 1.0 | 2026-10-08 | `vehicles/tank-engine-rev.ogg` (28.750-35.350 s) |
| [Flowing Water - River Wid](https://freesound.org/people/naturenotesuk/sounds/520077/) | naturenotesuk | CC0 1.0 | 2026-10-08 | `atmosphere/river-ford-rapids.ogg` (100.000-131.600 s) |
| [crow.wav](https://freesound.org/people/nigelcoop/sounds/75162/) | nigelcoop | CC0 1.0 | 2026-10-08 | `atmosphere/crow-caw-2.ogg` (0.060-2.300 s) |
| [Salute_Cannons.MP3](https://freesound.org/people/nofeedbak/sounds/95129/) | nofeedbak | CC BY 4.0 | 2026-10-08 | `atmosphere/artillery-distant-1.ogg` (22.879-27.609 s); `atmosphere/artillery-distant-2.ogg` (32.987-37.717 s); `atmosphere/artillery-distant-3.ogg` (48.826-53.556 s); `atmosphere/artillery-distant-4.ogg` (7.238-11.968 s); `atmosphere/artillery-distant-5.ogg` (38.228-42.958 s); `atmosphere/battle-bed-high.ogg` (32.997-37.617 s, 22.889-27.509 s, 48.836-53.456 s, 7.248-11.868 s, 38.238-42.858 s, 13.028-17.648 s, 17.911-22.531 s); `atmosphere/battle-bed-low.ogg` (32.997-37.617 s, 48.836-53.456 s, 27.959-32.579 s, 7.248-11.868 s, 17.911-22.531 s, 13.028-17.648 s) |
| [hydraulics.wav](https://freesound.org/people/nuckan/sounds/212941/) | nuckan | CC0 1.0 | 2026-10-08 | `vehicles/hatch-canopy-close.ogg` (4.450-5.750 s) |
| [20220801 - Two Apache helicopters passing - Waalre NL  - Field-recording](https://freesound.org/people/peter1955/sounds/645371/) | peter1955 | CC0 1.0 | 2026-10-08 | `vehicles/heli-rotor-ext.ogg` (18.000-24.600 s) |
| [Explosion](https://freesound.org/people/qubodup/sounds/182429/) | qubodup | CC0 1.0 | 2026-10-08 | `explosions/explosion-water-2.ogg` (0.000-1.750 s); `explosions/frag-1.ogg` (0.000-1.750 s); `explosions/vehicle-destruction-jeep.ogg` (0.000-1.750 s) |
| [Explosive 1 v1 [DOD 130303].flac](https://freesound.org/people/qubodup/sounds/182432/) | qubodup | CC0 1.0 | 2026-10-08 | `explosions/autocannon-impact-1.ogg` (1.126-1.390 s); `explosions/autocannon-impact-2.ogg` (1.391-1.945 s); `explosions/hull-hit-heavy-1.ogg` (1.126-1.390 s); `explosions/hull-hit-heavy-int-1.ogg` (1.126-1.390 s); `explosions/tank-ap-1.ogg` (1.126-1.390 s); `explosions/vehicle-destruction-jet.ogg` (0.456-1.110 s) |
| [Mk 19 Auto Grenade Launcher.flac](https://freesound.org/people/qubodup/sounds/182792/) | qubodup | CC0 1.0 | 2026-10-08 | `vehicles/smoke-launcher-1.ogg` (0.860-1.470 s); `vehicles/smoke-launcher-2.ogg` (0.640-1.470 s) |
| [Rocket Launch.flac](https://freesound.org/people/qubodup/sounds/182794/) | qubodup | CC0 1.0 | 2026-10-08 | `vehicles/aa-missile-launch-1.ogg` (0.560-6.600 s); `vehicles/aa-missile-launch-2.ogg` (7.250-13.500 s); `vehicles/ejection-seat-1.ogg` (0.560-3.000 s); `vehicles/ejection-seat-2.ogg` (7.250-9.550 s) |
| [Distant Tank Shots.flac](https://freesound.org/people/qubodup/sounds/184275/) | qubodup | CC0 1.0 | 2026-10-08 | `vehicles/tank-cannon-distant.ogg` (9.000-11.950 s) |
| [Tanks Shooting.flac](https://freesound.org/people/qubodup/sounds/189344/) | qubodup | CC0 1.0 | 2026-10-08 | `vehicles/tank-cannon-interior.ogg` (3.820-6.300 s); `vehicles/tank-cannon-near-1.ogg` (21.295-24.005 s); `vehicles/tank-cannon-near-2.ogg` (28.550-31.560 s); `vehicles/tank-cannon-near-3.ogg` (14.655-17.865 s) |
| [Jet Turbine Noise.flac](https://freesound.org/people/qubodup/sounds/205581/) | qubodup | CC0 1.0 | 2026-10-08 | `vehicles/jet-engine-ext-low.ogg` (63.200-67.000 s); `vehicles/jet-engine-ext.ogg` (20.000-25.400 s) |
| [A-10.ogg](https://freesound.org/people/qubodup/sounds/205582/) | qubodup | CC0 1.0 | 2026-10-08 | `vehicles/jet-cannon-ground.ogg` (79.250-80.750 s) |
| [50 Cal MG](https://freesound.org/people/qubodup/sounds/239138/) | qubodup | CC0 1.0 | 2026-10-08 | `vehicles/hmg50-shot-1.ogg` (0.511-1.060 s); `vehicles/hmg50-shot-2.ogg` (1.791-2.450 s); `vehicles/hmg50-shot-3.ogg` (3.291-3.680 s) |
| [Big Water Splash](https://freesound.org/people/qubodup/sounds/442773/) | qubodup | CC0 1.0 | 2026-10-08 | `explosions/explosion-water-1.ogg` (0.000-2.200 s); `explosions/explosion-water-2.ogg` (0.000-2.200 s) |
| [Machine Gun Burst](https://freesound.org/people/qubodup/sounds/482121/) | qubodup | CC0 1.0 | 2026-10-08 | `vehicles/coax762-shot-2.ogg` (1.101-1.188 s) |
| [Clean Machine Gun Burst](https://freesound.org/people/qubodup/sounds/482122/) | qubodup | CC0 1.0 | 2026-10-08 | `vehicles/coax762-shot-1.ogg` (1.336-1.560 s); `vehicles/coax762-shot-3.ogg` (0.991-1.077 s) |
| [Explosion 1 (Burning Car rec by Ñado)](https://freesound.org/people/qubodup/sounds/843247/) | qubodup | CC0 1.0 | 2026-10-08 | `explosions/autocannon-impact-3.ogg` (0.000-0.600 s); `explosions/vehicle-destruction-jeep.ogg` (0.000-0.700 s) |
| [Explosion 2 (Burning Car rec by Ñado)](https://freesound.org/people/qubodup/sounds/843248/) | qubodup | CC0 1.0 | 2026-10-08 | `explosions/hull-hit-heavy-2.ogg` (0.000-0.500 s); `explosions/hull-hit-heavy-int-2.ogg` (0.000-0.500 s) |
| [Explosion 3 (Burning Car rec by Ñado)](https://freesound.org/people/qubodup/sounds/843249/) | qubodup | CC0 1.0 | 2026-10-08 | `explosions/cookoff-3.ogg` (0.000-0.550 s) |
| [Explosion 4 (Burning Car rec by Ñado)](https://freesound.org/people/qubodup/sounds/843250/) | qubodup | CC0 1.0 | 2026-10-08 | `explosions/cookoff-2.ogg` (0.000-0.400 s) |
| [Mortar Shell Loading Slide 3](https://freesound.org/people/qubodup/sounds/854481/) | qubodup | CC0 1.0 | 2026-10-08 | `vehicles/breech-heavy-1.ogg` (0.000-0.600 s) |
| [Minigun Burst Audio](https://freesound.org/people/rob762x51/sounds/165042/) | rob762x51 | CC0 1.0 | 2026-10-08 | `vehicles/door-minigun-loop.ogg` (10.000-13.400 s); `vehicles/door-minigun-spindown.ogg` (31.050-32.700 s) |
| [Springtime birdsong with soft wind ambiance](https://freesound.org/people/rubindaniel/sounds/847380/) | rubindaniel | CC0 1.0 | 2026-10-08 | `atmosphere/birds-meadow-bed.ogg` (140.000-198.100 s) |
| [DISTANT EXPLOSION 01.wav](https://freesound.org/people/sandyrb/sounds/86291/) | sandyrb | CC BY 4.0 | 2026-10-08 | `explosions/distant-boom-4.ogg` (0.000-6.500 s) |
| [firecrackers.wav](https://freesound.org/people/sbarncar/sounds/121557/) | sbarncar | CC0 1.0 | 2026-10-08 | `explosions/cookoff-1.ogg` (0.596-2.500 s) |
| [Water being splashed // A pebble being thrown into a stagnant rain water stream, almost cartoonish sounding // 3 takes](https://freesound.org/people/ser%C3%B8ut%C5%8Dnin--depriv%C9%99d/sounds/854496/) | serøutōnin--deprivəd | CC0 1.0 | 2026-10-08 | `explosions/bullet-water-1.ogg` (1.040-1.620 s); `explosions/bullet-water-2.ogg` (2.905-3.485 s); `explosions/bullet-water-3.ogg` (4.850-5.430 s) |
| [car going through ford 1.mp3](https://freesound.org/people/soundmary/sounds/194967/) | soundmary | CC BY 4.0 | 2026-10-08 | `vehicles/vehicle-wade-splash.ogg` (21.000-24.400 s) |
| [Eurofighter afterburner woomph](https://freesound.org/people/surrey_film/sounds/162242/) | surrey_film | CC0 1.0 | 2026-10-08 | `vehicles/jet-afterburner-loop.ogg` (10.300-14.100 s) |
| [Two metallic clangs](https://freesound.org/people/tomwilkinson/sounds/568787/) | tomwilkinson | CC0 1.0 | 2026-10-08 | `atmosphere/industrial-creak-clank.ogg` (0.620-2.900 s) |
| [sheet metal sound four: Bang.wav](https://freesound.org/people/trijohnstone/sounds/547979/) | trijohnstone | CC0 1.0 | 2026-10-08 | `explosions/debris-metal-1.ogg` (5.581-6.385 s); `explosions/hull-hit-heavy-1.ogg` (13.426-14.830 s); `explosions/hull-hit-heavy-int-1.ogg` (13.426-14.830 s); `explosions/limpet-2.ogg` (17.406-18.810 s); `explosions/tank-ap-2.ogg` (13.426-14.630 s) |
| [Glass Break](https://freesound.org/people/unfa/sounds/221528/) | unfa | CC0 1.0 | 2026-10-08 | `explosions/debris-glass-1.ogg` (0.316-1.170 s) |
| [Grenade Explosion SFX (medium-sized, meaty, realistic)](https://freesound.org/people/unfa/sounds/609587/) | unfa | CC0 1.0 | 2026-10-08 | `explosions/frag-2.ogg` (0.000-1.800 s); `explosions/frag-3.ogg` (0.346-1.850 s) |
| [Three Outdoor Clean Explosions (Fireworks on New Year's Eve 2021)](https://freesound.org/people/unfa/sounds/613673/) | unfa | CC0 1.0 | 2026-10-08 | `explosions/rocket-airburst-1.ogg` (12.476-15.380 s); `explosions/rocket-airburst-2.ogg` (42.736-45.640 s); `explosions/vehicle-destruction-heli.ogg` (12.476-14.880 s) |
| [HeavyBulletPing.mp3](https://freesound.org/people/wilhellboy/sounds/351371/) | wilhellboy | CC0 1.0 | 2026-10-08 | `explosions/bullet-metal-4.ogg` (0.016-0.400 s); `explosions/hull-hit-small-1.ogg` (0.016-0.420 s); `explosions/limpet-1.ogg` (0.016-0.420 s) |
| [Single Rock hit Dirt.wav](https://freesound.org/people/worthahep88/sounds/319222/) | worthahep88 | CC0 1.0 | 2026-10-08 | `explosions/bullet-dirt-1.ogg` (0.261-0.545 s); `explosions/bullet-dirt-2.ogg` (0.811-1.095 s); `explosions/tank-ap-1.ogg` (0.261-0.565 s); `explosions/vehicle-destruction-heli.ogg` (0.261-0.565 s) |
| [Single Rock hit dirt 2.wav](https://freesound.org/people/worthahep88/sounds/319229/) | worthahep88 | CC0 1.0 | 2026-10-08 | `explosions/autocannon-impact-1.ogg` (0.326-0.580 s); `explosions/autocannon-impact-2.ogg` (0.326-0.580 s); `explosions/autocannon-impact-3.ogg` (0.326-0.580 s); `explosions/bullet-dirt-3.ogg` (0.326-0.610 s); `explosions/bullet-dirt-4.ogg` (0.636-0.920 s) |
| [Heavy explosion in forest debris tree falling.flac](https://freesound.org/people/wyskoj/sounds/530163/) | wyskoj | CC0 1.0 | 2026-10-08 | `explosions/tank-he-1.ogg` (0.000-4.600 s) |
| [Fall debris (crash)](https://freesound.org/people/xkeril/sounds/703248/) | xkeril | CC0 1.0 | 2026-10-08 | `explosions/vehicle-destruction-heli.ogg` (0.000-2.600 s); `explosions/vehicle-destruction-jeep.ogg` (0.000-2.400 s); `explosions/vehicle-destruction-tank.ogg` (0.000-3.000 s) |
