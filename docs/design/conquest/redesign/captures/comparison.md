# Conquest v2: before, after and reference

This page compares the Conquest "Frontier" redesign with what came before it, area by area.

- **Before**: images of the old 1024 Frontier, the old hulls and the old HUD, already under `docs/design/conquest/`.
- **After**: the new captures in this folder, from the final capture runs on 2026-10-07.
- **Reference**: ImageGen was not available during the redesign, so no new design alternatives were generated. The references are the earlier ImageGen images:
  - `map-alternatives.png` ("Iron Valley");
  - `hud-alternatives.png` (Option 2, Immersive Command, was chosen);
  - `aircraft/hud-alternatives.png` (Alt 2 for instruments, Alt 3 for touch).
  
  The prompts for a later ImageGen pass are in `../world/prompts.md`, `../vehicles/prompts.md` and `../hud/prompts.md`.

All paths are relative to this file. "–" means no image exists for that cell.

## World (Frontier 768 × 80 × 768)

| Subject | Before | After | Reference |
|---|---|---|---|
| Valley vista, golden mood | [frontier-fleet-hero.png](../../frontier-fleet-hero.png) (old HQ yard, flat blue sky) | [world/frontier-vista.png](world/frontier-vista.png) | [map-alternatives.png](../../map-alternatives.png), Iron Valley |
| Weather variants | – | [vista-mist](world/frontier-vista-mist.png), [vista-overcast](world/frontier-vista-overcast.png) | – |
| Overview / minimap base | – (the retired 1024 overview is kept outside docs in `.conquest-work/wp4/retired/frontier-overview.png`) | [world/frontier-overview.png](world/frontier-overview.png) | [map-alternatives.png](../../map-alternatives.png), map-flow inset |
| Airfield and air space | [aircraft/frontier-airfield.png](../../aircraft/frontier-airfield.png) | [world/frontier-jet-sky.png](world/frontier-jet-sky.png) | [aircraft/hud-alternatives.png](../../aircraft/hud-alternatives.png), background |
| Industrial site (flag E) | [frontier-workshop.jpg](../../frontier-workshop.jpg) (enclosed workshop) | [world/frontier-works.png](world/frontier-works.png) | Iron Valley "Central Rail Depot" |
| Flag sites | – | [farm (A)](world/frontier-farm.png), [village-street (B)](world/frontier-village-street.png), [bridge (C)](world/frontier-bridge.png), [trenches (D)](world/frontier-trenches.png) | Iron Valley ground view |
| Set pieces | – | [tank-forest](world/frontier-tank-forest.png), [heli-river](world/frontier-heli-river.png), [wreck-column](world/frontier-wreck-column.png) | – |

**Verdict.** The redesign changes the map's character. It replaces the flat paved yard under a cartoon sky with a river valley: a golden-hour atmosphere, terraced ridges, roads with roadside dressing, five readable flag sites with beams and ground rings, and a horizon backdrop. It is closer to the Iron Valley reference in layout and in having many routes. It is less dense and less vertical than the reference: there are fewer trees and rock faces, and no rail depot.

## Vehicles

| Type | Before | After | Reference |
|---|---|---|---|
| Jeep | [jeep-driver.jpg](../../jeep-driver.jpg) | [hero WEST](vehicles/jeep-hero-intact-alpha.png), [hero EAST](vehicles/jeep-hero-intact-bravo.png), [side](vehicles/jeep-side-intact-alpha.png) | [hud-alternatives.png](../../hud-alternatives.png), [map-alternatives.png](../../map-alternatives.png) (ground-view jeep) |
| Tank | [vehicles/tank-driver-live.png](../../vehicles/tank-driver-live.png), [vehicles/tank-front-repaired.png](../../vehicles/tank-front-repaired.png) | [hero WEST](vehicles/tank-hero-intact-alpha.png), [hero EAST](vehicles/tank-hero-intact-bravo.png), [top](vehicles/tank-top-intact-alpha.png) | the same two sheets (ground-view tank) |
| Attack helicopter | [aircraft/helicopter-final-live.png](../../aircraft/helicopter-final-live.png) | [hero WEST](vehicles/helicopter-hero-intact-alpha.png), [side](vehicles/helicopter-side-intact-alpha.png) | [aircraft/hud-alternatives.png](../../aircraft/hud-alternatives.png), Alt 1 and 3 |
| Transport helicopter | – (new type) | [hero WEST](vehicles/transport-hero-intact-alpha.png), [rear EAST](vehicles/transport-rear-intact-bravo.png) | – |
| Jet | [aircraft/jet-parked.png](../../aircraft/jet-parked.png), [aircraft/jet-final-live.png](../../aircraft/jet-final-live.png) | [hero WEST](vehicles/plane-hero-intact-alpha.png), [top](vehicles/plane-top-intact-alpha.png) | [aircraft/hud-alternatives.png](../../aircraft/hud-alternatives.png), Alt 2 |
| Damage states | [aircraft/vehicle-explosion-live.png](../../aircraft/vehicle-explosion-live.png), [aircraft/vehicle-multipart-explosion-live.png](../../aircraft/vehicle-multipart-explosion-live.png) | tank [damaged](vehicles/tank-hero-damaged-alpha.png), [burning](vehicles/tank-hero-burning-bravo.png), [wreck](vehicles/tank-hero-wreck-alpha.png); the same three states for every type | – |
| Team read at 150 m | – | [jeep](vehicles/jeep-range-intact-pair.png), [tank](vehicles/tank-range-intact-pair.png), [helicopter](vehicles/helicopter-range-intact-pair.png), [transport](vehicles/transport-range-intact-pair.png), [plane](vehicles/plane-range-intact-pair.png) | – |

**Verdict.** Before, every hull had the same olive paint. Now each team has its own camouflage, with WEST in woodland and EAST in desert, plus fluorescent IFF bands in blue or orange on every type. The vehicles are built from 0.2 m voxels with AO and edge highlights. Each type now has readable damaged, burning and wreck states, and every type is within its budget of 10 draws and 12 k triangles. Next to the references, the hulls are smaller and blockier: the references show more roadwheels, more detail on the rocket pods, and longer and slimmer airframes.

## HUD, desktop (1440 × 900)

| Subject | Before | After | Reference |
|---|---|---|---|
| Objective HUD (tickets, flags, ring, markers, minimap) | [vehicles/tank-driver-live.png](../../vehicles/tank-driver-live.png) (ALPHA/BRAVO, 3 flags, square minimap) | [hud/desktop-capturing.png](hud/desktop-capturing.png), [contested](hud/desktop-contested.png), [neutralizing](hud/desktop-neutralizing.png), [EAST-relative](hud/desktop-east-relative.png) | [hud-alternatives.png](../../hud-alternatives.png), Option 2 |
| Ground vehicle panel | [vehicles/tank-driver-live.png](../../vehicles/tank-driver-live.png) (one text strip) | [tank driver](hud/desktop-tank-driver.png), [tank commander](hud/desktop-tank-commander.png), [enter jeep prompt](hud/desktop-enter-jeep.png) | Option 2 (hull and speed bars, context prompt) |
| Helicopter | [aircraft/helicopter-final-live.png](../../aircraft/helicopter-final-live.png) | [pilot](hud/desktop-heli-pilot.png), [chin gunner](hud/desktop-heli-gunner.png), [transport door](hud/desktop-transport-door.png) | [aircraft/hud-alternatives.png](../../aircraft/hud-alternatives.png), Alt 1 |
| Jet | [aircraft/jet-final-live.png](../../aircraft/jet-final-live.png) | [hud/desktop-jet.png](hud/desktop-jet.png) | [aircraft/hud-alternatives.png](../../aircraft/hud-alternatives.png), Alt 2 |
| Deploy screen | – (the old spectator overlay) | [deploy](hud/desktop-deploy.png), [refused](hud/desktop-deploy-refused.png) | – (prompt A was not rendered) |
| Full map, revive, out of bounds | – | [big map](hud/desktop-big-map.png), [revive](hud/desktop-revive.png), [out of bounds](hud/desktop-out-of-bounds.png) | – |
| Scoreboard and result | – | [scoreboard](hud/desktop-scoreboard.png), [result](hud/desktop-result.png) | – |

## HUD, mobile (portrait 390 × 844, landscape 844 × 390, touch)

| Subject | Before | After | Reference |
|---|---|---|---|
| Infantry objective HUD | [vehicles/crew-hud-mobile.png](../../vehicles/crew-hud-mobile.png) | [portrait](hud/portrait-capturing.png), [landscape](hud/landscape-capturing.png) | [hud-alternatives.png](../../hud-alternatives.png), Option 2 mobile inset |
| Ground vehicle | [vehicles/crew-hud-mobile.png](../../vehicles/crew-hud-mobile.png) | [portrait tank](hud/portrait-tank-driver.png), [landscape tank](hud/landscape-tank-driver.png) | Option 2 mobile inset |
| Helicopter, touch | [aircraft/helicopter-touch.png](../../aircraft/helicopter-touch.png), [aircraft/helicopter-touch-landscape.png](../../aircraft/helicopter-touch-landscape.png) | [portrait](hud/portrait-heli-pilot.png), [landscape](hud/landscape-heli-pilot.png) | [aircraft/hud-alternatives.png](../../aircraft/hud-alternatives.png), Alt 3 |
| Jet, touch | – | [portrait](hud/portrait-jet.png), [landscape](hud/landscape-jet.png) | Alt 3 |
| Deploy, touch | – | [portrait](hud/portrait-deploy.png), [landscape](hud/landscape-deploy.png) | – |
| Scoreboard and result, touch | – | [portrait board](hud/portrait-scoreboard.png), [landscape result](hud/landscape-result.png) | – |

**HUD verdict.** The layout follows Option 2:
- the wide ticket panel with bars on either side of the flag chips;
- the round heading-up minimap with a compass ring;
- the vehicle card at the bottom right;
- the context prompt under the crosshair.

It departs from the reference on purpose:
- Colours are team-relative: your own team is always blue on the left, the enemy orange on the right.
- The labels are WEST and EAST, not ALPHA and BRAVO.
- There are five flag chips, not three.
- There is no permanent keybind strip, which aircraft Alt 1 had.
- The prompt key is T, not X.

The jet instruments follow Alt 2 as speed and altitude tapes around the gun funnel. The touch buttons follow the rounded amber style of Alt 3. The final HUD capture run had 60 states, 0 overlaps and 0 page errors (`hud/capture-report.json`).

## Live match (real client, 1280 × 720, Metal GPU, 15 bots)

| Subject | Before | After |
|---|---|---|
| Lobby and loading | – | [live/00-lobby.png](live/00-lobby.png), [live/01-loading.png](live/01-loading.png) |
| HQ spawn, on foot | [vehicles/tank-driver-live.png](../../vehicles/tank-driver-live.png) (old map, old HUD) | [live/02-hq-spawn.png](live/02-hq-spawn.png) |
| Near a flag | – | [live/05-near-flag.png](live/05-near-flag.png) |
| Mid match, combat HUD | – | [live/09-late-match.png](live/09-late-match.png) |
| Full map | – | [live/07-big-map.png](live/07-big-map.png) |
| Explosion | [aircraft/vehicle-explosion-live.png](../../aircraft/vehicle-explosion-live.png) (vehicle) | [08-explosion-fireball](live/08-explosion-fireball.png), [08-explosion](live/08-explosion.png), [08-explosion-2](live/08-explosion-2.png) (frag, infantry) |
| Deploy screen | – | [live/deploy-screen.png](live/deploy-screen.png), [live/deploy-screen-vehicle.png](live/deploy-screen-vehicle.png) |
| Scoreboard | – | [live/10-scoreboard.png](live/10-scoreboard.png) |
| In a vehicle, live | [aircraft/helicopter-final-live.png](../../aircraft/helicopter-final-live.png), [aircraft/jet-final-live.png](../../aircraft/jet-final-live.png) | – (see gaps) |

The final live run (`live/live-smoke-report.json`, 2026-10-07T07:14Z) had 0 exceptions, 0 console errors, 0 failed requests and 0 server stderr lines. The game ran at a median of 60 fps (p10 59), and the menu reached a running match in 4.4 s.

## Remaining gaps

**Live coverage**
- No live in-vehicle shot in the saved set. In the final live run the bots had taken the HQ tank and jeep, and the deploy-into-jeep choice stayed "TARGET IS BUSY", so the player deployed at HQ. `03-vehicle-deployed`, `04-vehicle-driving` and `06-vehicle-at-flag` came from earlier runs and are not on disk. The in-vehicle HUD is only covered by the static fixtures.
- In the live smoke, walking on foot gets stuck on hedges and fences: `05-near-flag` stands about 100 m from A.
- `08-explosion-fireball` lands just before the detonation.

**Reference parity**
- No new ImageGen alternatives exist for the world, vehicles, deploy screen, objective markers or reticles. Prompts A–C in `../*/prompts.md` were never rendered, so the deploy screen, the markers and the reticles have no image reference.

**World**
- Cloud puffs are flat beige boxes.
- The horizon backdrop looks layered and soft beyond about 500 m.
- In `heli-river` the helicopter is tiny, and `wreck-column` has only faint smoke.
- Up close in the live match, flag beams read as bright dashed white columns (`live/09-late-match.png`, `live/10-scoreboard.png`). In the static captures they read as thin lines.
- The world is less dense than Iron Valley.

**Vehicles**
- The aircraft team-hue margin is thin: 21–22 against a threshold of 20.
- The helicopter is stubby, and its rotor mast reads as a black chimney.
- The transport tail rotor is a static "X".
- The tank wreck reads as a slab.
- Embers are blobs.
- Headlights stay on in daylight and on burning hulls.

**HUD**
- The fixture backgrounds are a still of the world vista with the 3D flag beacons baked in. Fixture flag markers therefore sit beside baked beacons: there are two "C" or "D" markers in `desktop-capturing`, `desktop-jet` and `portrait-tank-driver`. The jet and helicopter states also show a ground-level backdrop at 140 m altitude.
- World-anchored markers can still pass behind touch buttons or reticle labels: for example the jet's target-box label crosses the pipper range, and in the portrait tank state "TANK 14% M" sits under the reticle.
- Vehicle icons on the deploy screen and the full map cover site labels ("IRON BR…GE" in `live/deploy-screen-vehicle.png`).
- In the portrait result, "FRONTIER · 768 × 768" wraps onto two lines.
- In the lobby, the map select text is truncated.
- On phones, the generic touch buttons still overlap the edges of the scoreboard (all modes).

**Robustness**
- A client that cannot keep up with 60 Hz snapshots of about 27 KB is disconnected after 30–60 s (SwiftShader, slow devices). The fix needs a server send-rate or backpressure policy, which is a protocol decision.
