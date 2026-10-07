# Local Conquest verification

Initial ground stage checked on 2026-10-05: Frontier, Jeep and Tank. The dated follow-ups below add bot driving, helicopters and jets.

## Implemented map

Frontier is 1024 × 48 × 1024 voxels with two bases, three capture objectives, an inner road loop and outer bypasses. It includes 15 furnished interiors, 96 additional tactical fixture groups, industrial landmark equipment and 56 dispersed environment clusters. Final terrain fingerprint: `3a6ee911`; RLE payload: 1,537,784 bytes. Roads, all spawn pads and oriented vehicle exits pass the generated-world collision checks.

The lobby image and 1024 × 1024 minimap background were exported from the actual game renderer after the final decoration and flag integration. Local HTTP read-back matched the saved bytes for both map images and the consumed armor texture. The [capture guide](../frontier-actual-map-captures.md) reproduces them. [ImageGen prompts and references](prompts.md) record the chosen map/HUD concepts and the consumed armor texture.

## Automated checks

The full `npm test` run passed. After adding world flag visuals, all 23 Conquest tests and the graphics, static-server, client-refactor, network lifecycle, session lifecycle and HUD checks passed again. The module preload graph is current at 176 modules. The final capture export was also read back in the browser and the static-server checks passed afterward.

The scale test runs 16 infantry bots for 120 simulated seconds on the final decorated world. Every bot moves and both teams capture objectives. This checks local simulation, not internet latency or a production server fleet.

## Browser checks

Desktop: 1440 × 900, one human and 15 bots. The final world maintained about 60 rendered FPS in the local browser, with 169 resident detailed chunks and no shader errors. The Jeep moved from x=120.5 to x=165.87 and stopped with Space. Live flag ownership, contention and ticket changes were visible. Sample CPU frame time was approximately 4 to 5.8 ms; this is not a GPU timing or a guarantee for other hardware.

Touch layout: 390 × 844 in the local browser. Both contextual entry/exit buttons work above the aim surface. Infantry ammo and inventory disappear while seated. The Jeep exposes Brake; the Tank exposes Fire and Brake with hull health and the server cannon cooldown. Touch braking reduced Jeep speed from 8.81 to 0.74 m/s in 0.45 seconds. Touch Fire produced a Tank shell and an authoritative cooldown of 2.04 seconds while rifle ammo remained unchanged. The camera stays above the chassis, and the portrait minimap no longer overlaps the medkit area. These are emulated touch-layout checks, not physical-phone testing.

Checked browser frames are saved locally under `.artifacts/conquest/`: `desktop-final.png`, `desktop-jeep-final.png`, `mobile-jeep.png` and `mobile-tank.png`. The checked [relay workshop frame](frontier-workshop.jpg) is retained with these design notes.

The local server runs on port 8094. Changes are local; this work has not been committed, pushed or deployed.


## Follow-up checked on 2026-10-06

Jeep drivers now use full seated characters for humans and bots, with identity, cosmetics, steering hand anchors and lifecycle cleanup. Infantry cannot walk through the oriented chassis. Vehicle contacts push safely or stop at terrain; enemy runovers use the actual driver and combat team policy. Partial ground support lets vehicles cross small holes, and gravity lowers unsupported hulls toward the actual floor. The support test carves a crater into the generated Frontier and checks ordinary forward and reverse recovery.

Bots reserve friendly vehicles and drive toward capture objectives. Transport destinations stay fixed during a trip, so allied captures do not send a convoy into a mid-route U-turn. Bots recognize hostile occupied hulls through their normal perception gates; infantry can damage them and Tank drivers aim and fire while navigating. Human seat priority and reservation cleanup are tested.

Every command in `npm test` passed across the initial run and the resumed suffix after fixing an Alpha Tank arrival failure. The strict test still requires all four vehicles to enter a real flag radius within 120 simulated seconds. After the final support refinement, all 29 Conquest tests, static delivery and legacy prone, traversal and water checks passed again. Preload is current at 176 modules. Local logs are `/tmp/voxel-conquest-followup-full.log`, `/tmp/voxel-conquest-followup-suffix.log` and `/tmp/voxel-conquest-followup-final.log`.

The final 60 Hz driving fixture reaches flags in 30.62 and 31.70 seconds for Jeeps, and 50.53 and 50.63 seconds for Tanks. The separate 16-bot scale run measures a median simulation tick of 1.257 ms and p95 of 2.205 ms, with a 22,009-byte snapshot. Its cold maximum is 64.505 ms, including first-use navigation work in the fixture. These local measurements are higher than the earlier infantry-only median of 0.125 ms and p95 of 0.507 ms, and are not a hardware-independent performance guarantee.

The root browser check confirms the full human Jeep driver at 1440 × 900 and 390 × 844, about 60 rendered FPS and no shader errors. Exit removes the seated actor. Holding movement into the Jeep stops both client prediction and authoritative position at x=118.06. Frames are saved under `.artifacts/conquest/jeep-driver-fix.png` and `jeep-driver-touch.png`; [the driver crop](jeep-driver.jpg) is retained here. The portrait check uses an emulated touch layout.

A fresh live match on the final server, with one human and 15 bots, confirms that bots board all four vehicles through normal inputs. Both Jeep drivers appear as seated characters. The vehicles travel at least 268 metres from their spawns and each reaches within 13 metres of an actual capture-point centre. Jeeps dismount at objectives, and another bot later takes the Bravo Jeep onward. Vehicle combat destroys the Alpha Jeep and lowers the Bravo Tank to 168.62 of 850 HP in the recorded samples. The browser remains at about 60 rendered FPS with no shader errors. Read-only snapshots are saved in `.artifacts/conquest/live-bot-transport.json`. Human-occupied vehicle targeting is separately covered by the real-engine combat tests; the live convoy samples establish bot transport and vehicle battle activity.

## Aircraft expansion checked on 2026-10-06

Each team now has a Helicopter and Jet alongside its Jeep and Tank. Separate model and handling modules provide visible seated pilots, spinning rotors, jet exhaust and authoritative landing gear. Aircraft use swept, pitched and banked compound hulls for terrain, vehicle, infantry and ray collision. Mounted rockets and cannon retain real player ownership, team policy and cooldowns without consuming infantry ammunition. Aircraft require a real landing to capture flags. Airborne exit inherits velocity and ordinary player gravity; horizontal world boundaries remain solid above voxel height.

Both airfields have 354-metre runways, helipads, furnished maintenance and avionics hangars, fuel equipment, towers with usable ladders and runway lights. Two optional sheds and two old lamps that intersected the flight approaches are omitted completely, avoiding cut walls and floating caps. All 15 established furnished interiors, 96 tactical fixtures and 56 environment clusters retain their strict checks. Final terrain fingerprint: `d416a025`; RLE payload: 1,555,104 bytes. The lobby image and 1024-square minimap were regenerated from this actual game terrain. [The parked jet](aircraft/jet-parked.png) and [airfield](aircraft/frontier-airfield.png) are actual renderer captures.

All 40 Conquest checks, atlas, static serving and the 177-module preload graph pass after the final collision, boundary and portrait layout changes. The complete `npm test` commands passed across the initial run, the repaired boot-camera fixture and the resumed suffix; affected Conquest checks were repeated after each later refinement. The final 829-file source manifest remained unchanged during qualification. Evidence: `/tmp/voxel-aircraft-final-authority.log`, `/tmp/voxel-aircraft-final-authority-before.json`, `/tmp/voxel-aircraft-final-authority-after.json` and `/tmp/voxel-aircraft-final-map-assets.json`.

Real-engine flight tests cover hover, runway takeoff, stall, landing, unoccupied gravity, ejection, crashes, roof rotation, banked wing hits, blast cover, gear visibility and physical parity. Three 90-second fixed-heading Jet flights remain airborne with full health through automatic boundary recovery. Helicopter recovery also keeps the exact hull clear. The 16-bot fixture sends all eight vehicles through normal seating and inputs: ground vehicles still reach flags in 30.62 to 50.63 simulated seconds, helicopters cruise and land, and jets take off and make frontline passes. Mounted helicopter projectiles damage and destroy a human-occupied enemy Tank through the actual combat pipeline.

The final 16-bot scale fixture measures a median simulation tick of 3.587 ms, p95 of 5.757 ms and a 24,599-byte snapshot. Its cold maximum is 102.494 ms, including first-use navigation work in this fixture. These are local measurements. The [HUD references and prompt](aircraft/prompts.md) record the built-in ImageGen design alternatives; gameplay values come from authoritative snapshots.

Browser flight checks run with music and sound effects set to zero. Procedural aircraft audio is covered by muted graph tests; no listening acceptance was performed. Touch checks use browser emulation rather than a physical phone. Changes remain local, with no commit, push or deployment.

On the final server, normal keyboard inputs and the contextual entry button take the Jet from its runway to y=43.63 metres at 52.95 m/s, with 450/450 HP and retracted gear. Continuing the flight through repeated boundary recovery retains 72 m/s, full HP and a clear hull inside the 180-metre ceiling; a recorded browser sample is y=176.65 metres. Mouse fire produces an authoritative 0.09-second remaining cannon cooldown. The seated pilot is visible. The 1440 × 900 browser reports about 60 rendered FPS and no shader errors. [Jet flight](aircraft/jet-flight.png) is captured directly from this game.

Actual touch UP and DOWN holds lift and lower the Helicopter; touch FIRE produces a server rocket cooldown of 0.51 seconds without sound. The final portrait telemetry sits below the visible hull, and the landscape minimap clears the telemetry and HP panel. Portrait 390 × 844 and landscape 844 × 390 frames are [saved here](aircraft/helicopter-touch.png) and [here](aircraft/helicopter-touch-landscape.png). The phone layout follows the compact mobile ImageGen reference. The landscape-only positioning was refined after the full Conquest run, then the aircraft controls, static delivery and preload checks were repeated. All flight tests use ordinary input events and read-only snapshot observations, with no position overrides.
