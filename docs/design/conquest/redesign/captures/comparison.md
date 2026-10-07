# Conquest v2: before, after and reference

This page compares the Conquest "Frontier" redesign with what came before it, area by area.

- **Before**: images of the old 1024 Frontier, the old hulls and the old HUD, already under `docs/design/conquest/`.
- **After**: the new captures in this folder, from the final capture runs on 2026-10-07.
- **Reference**: the redesign itself was built from the earlier ImageGen images (`map-alternatives.png` "Iron Valley", `hud-alternatives.png` Option 2, `aircraft/hud-alternatives.png` Alt 2/3). A reference pass on 2026-10-07 then rendered the prompts with gpt-image-2 through the Codex image endpoint: `../world/*-reference.jpg`, `../vehicles/*-reference.jpg` and `../hud/*-reference.jpg`, each next to its `*.prompt.txt`. The world, vehicles and HUD were adjusted against them; the per-area notes are in `../world/prompts.md`, `../vehicles/prompts.md` and `../hud/prompts.md`.

All paths are relative to this file. "–" means no image exists for that cell.

## World (Frontier 768 × 80 × 768)

| Subject | Before | After | Reference |
|---|---|---|---|
| Valley vista, golden mood | [frontier-fleet-hero.png](../../frontier-fleet-hero.png) (old HQ yard, flat blue sky) | [world/frontier-vista.png](world/frontier-vista.png) | [vista-reference.jpg](../world/vista-reference.jpg), [horizon-study-reference.jpg](../world/horizon-study-reference.jpg) |
| Weather variants | – | [vista-mist](world/frontier-vista-mist.png), [vista-overcast](world/frontier-vista-overcast.png) | [weather-moods-reference.jpg](../world/weather-moods-reference.jpg) |
| Overview / minimap base | – (the retired 1024 overview is kept outside docs in `.conquest-work/wp4/retired/frontier-overview.png`) | [world/frontier-overview.png](world/frontier-overview.png) | [map-alternatives.png](../../map-alternatives.png), map-flow inset |
| Airfield and air space | [aircraft/frontier-airfield.png](../../aircraft/frontier-airfield.png) | [world/frontier-jet-sky.png](world/frontier-jet-sky.png) | [aircraft/hud-alternatives.png](../../aircraft/hud-alternatives.png), background |
| Industrial site (flag E) | [frontier-workshop.jpg](../../frontier-workshop.jpg) (enclosed workshop) | [world/frontier-works.png](world/frontier-works.png) | Iron Valley "Central Rail Depot" |
| Flag sites | – | [farm (A)](world/frontier-farm.png), [village-street (B)](world/frontier-village-street.png), [bridge (C)](world/frontier-bridge.png), [trenches (D)](world/frontier-trenches.png) | Iron Valley ground view |
| Set pieces | – | [tank-forest](world/frontier-tank-forest.png), [heli-river](world/frontier-heli-river.png), [wreck-column](world/frontier-wreck-column.png) | – |

**Reference pass (2026-10-07).** Against `vista-reference.jpg` the valley read as empty and washed out. The look pass halved the ground haze, warmed and saturated the grade, gave Frontier an olive/ochre palette, a gold-to-blue-violet sky with cloud banks, three mountain ranges in depth, a dark reflective river and heavier smoke columns. The content pass widened the river to 24–30 m between the crossings, raised the tree count from 1,103 to 1,976, added wheat fields, a hillside village with a bell tower, wrecks, ruins, hedgehogs and sandbags, and two more chimneys at E. Remaining differences: the sun disc only shows looking west, far peaks are lower than in the reference, and slopes are still terraced.

**Verdict (redesign).** The redesign changes the map's character. It replaces the flat paved yard under a cartoon sky with a river valley: a golden-hour atmosphere, terraced ridges, roads with roadside dressing, five readable flag sites with beams and ground rings, and a horizon backdrop. It is closer to the Iron Valley reference in layout and in having many routes. It is less dense and less vertical than the reference: there are fewer trees and rock faces, and no rail depot.

## Vehicles

| Type | Before | After | Reference |
|---|---|---|---|
| Fleet (reference pass) | – | all hero shots below | [fleet-sheet-reference.jpg](../vehicles/fleet-sheet-reference.jpg), [damage-states-reference.jpg](../vehicles/damage-states-reference.jpg) |
| Jeep | [jeep-driver.jpg](../../jeep-driver.jpg) | [hero WEST](vehicles/jeep-hero-intact-alpha.png), [hero EAST](vehicles/jeep-hero-intact-bravo.png), [side](vehicles/jeep-side-intact-alpha.png) | [hud-alternatives.png](../../hud-alternatives.png), [map-alternatives.png](../../map-alternatives.png) (ground-view jeep) |
| Tank | [vehicles/tank-driver-live.png](../../vehicles/tank-driver-live.png), [vehicles/tank-front-repaired.png](../../vehicles/tank-front-repaired.png) | [hero WEST](vehicles/tank-hero-intact-alpha.png), [hero EAST](vehicles/tank-hero-intact-bravo.png), [top](vehicles/tank-top-intact-alpha.png) | the same two sheets (ground-view tank) |
| Attack helicopter | [aircraft/helicopter-final-live.png](../../aircraft/helicopter-final-live.png) | [hero WEST](vehicles/helicopter-hero-intact-alpha.png), [side](vehicles/helicopter-side-intact-alpha.png) | [aircraft/hud-alternatives.png](../../aircraft/hud-alternatives.png), Alt 1 and 3 |
| Transport helicopter | – (new type) | [hero WEST](vehicles/transport-hero-intact-alpha.png), [rear EAST](vehicles/transport-rear-intact-bravo.png) | – |
| Jet | [aircraft/jet-parked.png](../../aircraft/jet-parked.png), [aircraft/jet-final-live.png](../../aircraft/jet-final-live.png) | [hero WEST](vehicles/plane-hero-intact-alpha.png), [top](vehicles/plane-top-intact-alpha.png) | [aircraft/hud-alternatives.png](../../aircraft/hud-alternatives.png), Alt 2 |
| Damage states | [aircraft/vehicle-explosion-live.png](../../aircraft/vehicle-explosion-live.png), [aircraft/vehicle-multipart-explosion-live.png](../../aircraft/vehicle-multipart-explosion-live.png) | tank [damaged](vehicles/tank-hero-damaged-alpha.png), [burning](vehicles/tank-hero-burning-bravo.png), [wreck](vehicles/tank-hero-wreck-alpha.png); the same three states for every type | – |
| Team read at 150 m | – | [jeep](vehicles/jeep-range-intact-pair.png), [tank](vehicles/tank-range-intact-pair.png), [helicopter](vehicles/helicopter-range-intact-pair.png), [transport](vehicles/transport-range-intact-pair.png), [plane](vehicles/plane-range-intact-pair.png) | – |

**Reference pass (2026-10-07).** Against `fleet-sheet-reference.jpg` every hull got a blotched woodland or desert camo, a white or black team stripe with a blue or orange roundel (replacing the fluorescent IFF panels), round wheels and roadwheels, and type details: slotted muzzle brake, smoke tubes and skirts on the tank, grille, fenders and gun shield on the jeep, stepped canopy, rocket pods and chin gun on the attack helicopter, open doors with a bench on the transport, twin tails and ringed nozzles on the jet. The 150 m team check now samples hull pixels only; the margin is 31–41°.

**Verdict (redesign).** Before, every hull had the same olive paint. Now each team has its own camouflage, with WEST in woodland and EAST in desert, plus fluorescent IFF bands in blue or orange on every type. The vehicles are built from 0.2 m voxels with AO and edge highlights. Each type now has readable damaged, burning and wreck states, and every type is within its budget of 10 draws and 12 k triangles. Next to the references, the hulls are smaller and blockier: the references show more roadwheels, more detail on the rocket pods, and longer and slimmer airframes.

## HUD, desktop (1440 × 900)

| Subject | Before | After | Reference |
|---|---|---|---|
| Objective HUD (tickets, flags, ring, markers, minimap, squad list) | [vehicles/tank-driver-live.png](../../vehicles/tank-driver-live.png) (ALPHA/BRAVO, 3 flags, square minimap) | [hud/desktop-capturing.png](hud/desktop-capturing.png), [contested](hud/desktop-contested.png), [neutralizing](hud/desktop-neutralizing.png), [EAST-relative](hud/desktop-east-relative.png) | [gameplay-hud-reference.jpg](../hud/gameplay-hud-reference.jpg) Alt 2, [objective-markers-reference.jpg](../hud/objective-markers-reference.jpg) |
| Ground vehicle panel | [vehicles/tank-driver-live.png](../../vehicles/tank-driver-live.png) (one text strip) | [tank driver](hud/desktop-tank-driver.png), [tank commander](hud/desktop-tank-commander.png), [enter jeep prompt](hud/desktop-enter-jeep.png) | Option 2 (hull and speed bars, context prompt) |
| Helicopter | [aircraft/helicopter-final-live.png](../../aircraft/helicopter-final-live.png) | [pilot](hud/desktop-heli-pilot.png), [chin gunner](hud/desktop-heli-gunner.png), [transport door](hud/desktop-transport-door.png) | [aircraft/hud-alternatives.png](../../aircraft/hud-alternatives.png), Alt 1 |
| Jet | [aircraft/jet-final-live.png](../../aircraft/jet-final-live.png) | [hud/desktop-jet.png](hud/desktop-jet.png) | [aircraft/hud-alternatives.png](../../aircraft/hud-alternatives.png), Alt 2 |
| Deploy screen | – (the old spectator overlay) | [deploy](hud/desktop-deploy.png), [refused](hud/desktop-deploy-refused.png) | [deploy-screen-reference.jpg](../hud/deploy-screen-reference.jpg) Alt 1 |
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
| In a vehicle, live | [aircraft/helicopter-final-live.png](../../aircraft/helicopter-final-live.png), [aircraft/jet-final-live.png](../../aircraft/jet-final-live.png) | [live/03-vehicle-deployed.png](live/03-vehicle-deployed.png), [live/06-vehicle-at-flag.png](live/06-vehicle-at-flag.png) (jeep driver) |

The final live run (`live/live-smoke-report.json`, after the reference pass) had 0 exceptions, 0 console errors, 0 failed requests and 0 server stderr lines. The game ran at a median of 60 fps (p10 57), and the menu reached a running match in 4.3 s.

## Remaining gaps

**Live coverage**
- In the live smoke, walking on foot gets stuck on hedges and fences: `05-near-flag` stands about 100 m from A.
- `08-explosion-fireball` lands just before the detonation.

**Reference parity**
- The sun disc only shows looking west (lowering the sun lights bunker and church interiors). Far peaks stay under the backdrop height cap, so they are lower than in `vista-reference.jpg`. Slopes still read as terraces.
- The weapon and health cards were not restyled toward `gameplay-hud-reference.jpg`, because every game mode shares them.
- The vehicle weapon effects were not compared against `effects-board-reference.jpg`.

**World**
- In `heli-river` the helicopter is tiny.
- The valley mist still has a fairly hard top edge.
- Bots capture fewer flags on the denser map (about 3–4 per action-gate match instead of 7), and the stuck fraction (0.047) sits just under its 0.05 limit; bots can still get stuck in the water under bridge decks.
- Up close in the live match, flag beams read as bright dashed white columns (`live/09-late-match.png`, `live/10-scoreboard.png`). In the static captures they read as thin lines.
- The world is less dense than Iron Valley.

**Vehicles**
- The attack helicopter keeps side-by-side seats (gameplay data), so its canopy is stepped rather than truly tandem.
- The transport tail rotor is a static "X".
- The tank wreck reads as a slab.
- Embers are blobs.
- Headlights stay on in daylight and on burning hulls.

**HUD**
- The fixture backgrounds are a still of the world vista with the 3D flag beacons baked in. Fixture flag markers therefore sit beside baked beacons: there are two "C" or "D" markers in `desktop-capturing`, `desktop-jet` and `portrait-tank-driver`. The jet and helicopter states also show a ground-level backdrop at 140 m altitude.
- World-anchored markers can still pass behind touch buttons or reticle labels: for example the jet's target-box label crosses the pipper range, and in the portrait tank state "TANK 14% M" sits under the reticle.
- In landscape, crowded edge markers can move to the top or bottom edge, so an arrow can sit on a different edge from its direction. On-screen markers in the same direction can still overlap (`live/06-vehicle-at-flag.png`).
- The landscape deploy map is cramped.
- In the portrait result, "FRONTIER · 768 × 768" wraps onto two lines.
- On phones, the generic touch buttons still overlap the edges of the scoreboard (all modes).

**Robustness**
- Snapshots are about 23 KB raw but about 1.3 KB on the wire (per-connection deflate). Locally, a browser frozen for 20 s keeps its connection. A rejoin after any non-goodbye drop now finds its room for 30 s, and server-side drops log their cause. A client far below 60 Hz on a slow link is still dropped once 4 MB queue up.
