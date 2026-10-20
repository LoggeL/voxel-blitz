# Redrock Canyon

Redrock Canyon is the second Conquest battlefield: a 768 × 80 × 768 red-rock desert (47.2 M voxels, the same extent as [Frontier](frontier.md)). A river runs north to south through the middle, held back by **Redrock Dam** at the centre of the map. North of the dam the river widens into a reservoir (surface y26); south of it the river (surface y19) runs in a canyon about 12 m deep with banded red walls. The two HQ plateaus face each other across the river, 624 m apart.

Frontier is point-symmetric about (384, 384). Redrock is **mirror-symmetric about x = 384** (WEST ↔ EAST), so each team owns one flag on the reservoir side and one on the canyon side. Only the river's meander is not mirrored, and it stays more than 100 m from every flag.

The map is Conquest-only (`MAP_MODE_COMPATIBILITY.redrock = ['conquest']`, 16 players). Frontier stays the default Conquest map; the host picks Redrock in the lobby map list.

The design reference is `docs/design/conquest/map2/map2-a-redrock-dam.png` (prompt in `prompt-a-redrock-dam.txt`). The two alternatives (`map2-b-high-pass`, `map2-c-salt-mesa`) were rejected: a mountain pass gives tanks too few routes, and a salt flat has no river for the crossing play. Real captures are in `docs/design/conquest/map2/captures/`.

The generator is pure and deterministic: it uses Frontier's noise with one constant salt, so the relief never repeats Frontier's.

- `shared/world/redrock-plan.js` holds `REDROCK_PLAN`: dimensions, HQs, flags, the river and reservoir, crossings and reference heights. It is dependency-free data, like `FRONTIER_PLAN`.
- `shared/world/redrock-terrain.js` builds the heightfield and its surfaces. It has no voxels.
- `shared/world/redrock-sites/*.js` add the set pieces on top.
- `shared/world/redrock-sites/layout.js` publishes the metadata (`createRedrockMetadata`).

Redrock reuses Frontier's architecture instead of copying it:

- the site kit (`frontier-sites/kit.js`);
- the HQ airfields (`frontier-sites/hq-airfield.js`): the plateaus are Frontier's, so runways, helipads, motor pools and every aircraft departure are shared;
- the entrance, road and reserved-cell passes (`frontier-sites/generate.js`);
- the cell kinds, noise, chamfer relax and graded-road solve of `frontier-terrain.js`;
- the road clearance and spawn-cell picking of `frontier-sites/plan.js`;
- the HQ, airfield, pad, road, crossing and landmark builders of `shared/world/battlefield-layout.js`, which `frontier-sites/layout.js` uses too.

`shared/world/battlefields.js` lists the battlefields (`BATTLEFIELD_MAP_IDS = ['frontier', 'redrock']`, `isBattlefieldMap`, names and lobby taglines). Everything that used to test `map === 'frontier'` for the large-map render path now tests `isBattlefieldMap`: far terrain, the airspace apron, render distance, scorch pools, metadata prewarm, the HQ structure warm list and bot navigation cells. `conquestPlanFor(mapId)` in `shared/world/battlefield-plans.js` returns the plan of either map.

## Flags and HQs

| Flag | Name | Site | Position | Radius | Home |
|---|---|---|---|---|---|
| A | Palmera Oasis | oasis | 236, 236 | 22 | WEST |
| B | Copperhead Mine | mine | 250, 540 | 22 | WEST |
| C | Redrock Dam | dam | 384, 384 | 32 | neutral |
| D | Mesa Radar | radar | 532, 236 | 22 | EAST |
| E | Sulphur Railhead | railhead | 518, 540 | 22 | EAST |

- **West HQ** (72, 384) and **East HQ** (696, 384), radius 56, on Frontier's y36 plateaus.
- Every flag has 12 forward spawns and every HQ 8, all on terrain feet height (`redrockTopY + 1.02`). `tools/redrock-map-test.mjs` checks each one in the generated voxels: standable, dry, with 3 voxels of headroom.

### The sites

- **A · Palmera Oasis.** A spring pool ringed by date palms, adobe houses round a plaza, a mission bell tower (primary landmark, 23 m) and a windpump. The palms and walls give short sight lines; the plaza is open.
- **B · Copperhead Mine.** A steel headframe (primary landmark, 28 m) over the shaft, an ore mill, hoppers, a haul road and tailings heaps.
- **C · Redrock Dam.** The dam body spans the river from x344 to x424. Its crest road (y34) is the central crossing and the paved axis.
  - Two intake towers (top y47, primary landmark) stand on the reservoir side, with a gantry crane between them.
  - The spillway steps down the canyon face (x376–391).
  - A gallery at y23 runs through the dam body, with portals at x370 and x396. It is the covered route across.
  - The control house (WEST) and the turbine hall (EAST) are hard cover at either end.
  - The flag radius is 32, so the whole crest and both abutments count. The flag pad radius is the flag radius + 16.
- **D · Mesa Radar.** A radome and a lattice dish tower (primary landmark, rise 26) on the east mesa, plus an ops block, Quonset huts and a generator.
- **E · Sulphur Railhead.** A water tower (primary landmark, rise 24), the station with its east canopy, an engine shed, a freight office, sulphur heaps, the main rail at z588 and a siding with boxcars.

### Places

Four named places between the flags carry landmarks of their own: **Coyote Well** (208, 408, windmill), **Juniper Trading Post** (560, 408, sign), **Arch Rock** (340, 470, a natural span) and **Signal Butte** (428, 470, radio mast, rise 35). The mesas are Anvil Mesa, Saddle Butte, Broken Mesa, The Needle and Cairn Butte, mirrored east.

## River and crossings

Vehicles cross the river only at five points:

| Crossing | Kind | z | Deck or bed |
|---|---|---|---|
| bridge-north | bridge | 100 | deck y30 |
| ford-north | ford | 178 | bed y25, one voxel of water |
| redrock-dam | dam crest | 384 | y34 |
| trestle | rail and road trestle | 500 | deck y32 over the canyon |
| wash-ford | ford | 640 | canyon floor |

- North of the dam the whole reach stands at the reservoir level (y26), so the north bridge spans it and the north ford is one voxel deep. The basin itself (z214–378) is wide and deep; boats are not part of the fleet, so infantry swim and vehicles go round. The vehicle wading cue reads the same two levels (`riverSurfaceAt` in `shared/world/battlefield-plans.js`).
- South of the dam the canyon floor (y20) is reachable from two gullies on each side (`CANYON_GULLIES`, z452 and z590), so infantry can work along the river under the trestle.

## Dam breach

The dam can be blown (rules in [conquest.md](../conquest.md), *Redrock Dam breach*; data in `shared/map-events/dam.js`). Map-side facts:

- The two charges sit in the gallery's portal passages (west x371, east x397, z388, floor y24), not in the middle of the gallery: the bots' surface graph (2.5D, one standing height a cell) cannot reach the gallery under the crest, but it reaches the portal mouths. So the gallery is not a bot route either, whatever the *Bots* paragraph below suggests for players.
- The breach cuts x374–393 (z378–403) from a raised sill (y24, which stays) to y37; both abutments stand, and flag C's 12 spawn cells sit 6 on each abutment (radii 27–48 m from the flag centre, two picks a side). The intake towers stay. The spillway face (x376–391, y20–33, z390–404) is the bombable second way in.
- The water is a flood field (`shared/world/flood-field.js`) built from the template's column floors. The basin (12 664 columns, z214–377, x150–618, surface y27) falls to the y24 sill over about a minute (75 % of its 3 m in 30 s); a riffle at its head (z214–236) holds the north river's level, so the north bridge, ford-north and the north river keep their water and the drained basin keeps a channel at least 2.77 m deep (no lake-bed crossing for tanks). The canyon (z391–767, x300–468) takes a 1-D wave: 6.2 m over the floor at the dam foot, at the trestle (z500) after 16 s and 5.8 m deep (under the y32 deck), at the wash ford (z640) after 38 s, at the south edge after 58 s; it settles 2.2–2.5 m over its y20 floor (surface y23.2–23.5), so the wash ford and the canyon floor drown every hull for the round. Vehicles cross at the trestle and the north bridge.
- Only settled water becomes voxels: 332 jobs of one 16 x 16 tile (36 402 basin cells removed as the level passes them, 30 302 canyon cells added once a row has settled), at most 4 jobs a second. A joiner after the breach gets a 343 KB map-cache patch (101 KB deflated) and runs the field from the snapshot's seconds since the breach.
- Changes are runtime voxel edits only; the pristine template and its fingerprint are unchanged, and a rematch restores them.

## Terrain (`redrock-terrain.js`)

`redrockTerrain()` returns the same arrays as `frontierTerrain()` (`heights`, `surface`, `drivable`, `water`, `ground`, `kind`, …). It is memoised. `redrockSurfaceY(x, z)` is the standing height (`heights + 1`); `redrockTopY` is the top voxel.

The pipeline:

1. **Relief.** Fractal noise with its own salt, so it never repeats Frontier. The plain is y27–34, and the rim rises to y62 mesas outside the combat area (24…744).
2. **Pads and plateaus.** Flag pads, Frontier's HQ plateaus and runway approaches.
3. **Water.** The reservoir north of the dam and the canyon south of it, with a meander per reach.
4. **Mesas and buttes** (`REDROCK_MESAS`): flat-topped, steep-sided, banded.
5. **Roads.** Graded like Frontier's: a 10 m paved axis HQ-W → dam crest → HQ-E, plus 7 m gravel tracks HQ→A/B/D/E, A→C, B→C, D→C, E→C, the north loop over bridge-north, A→D over ford-north, B→E over the trestle and the south loop over wash-ford. The test samples every road every 2 m: at least 90 % drivable, and no step over 2 voxels away from a crossing.
6. **Drivability clamp and cliffs.** As Frontier, plus the canyon walls and mesa sides.
7. **Surfaces.** Red sand, dust rock, gravel washes, dry grass and sage near water, and banded strata (`strataAt(y)`) in every cliff.

## Look and sound

- **Atmosphere** (`public/js/engine/redrock-atmosphere.js`): weather `desert` (the default: high, hard afternoon sun, pale blue zenith over a warm dust horizon) or `dusk` (low red sun, violet zenith, denser haze). The backdrop ranges are red sandstone, and the airspace apron (`AIRSPACE.redrock`) adds two kinds, `DESERT` and `RED_ROCK`, appended to `APRON_KIND`. Only uniforms and baked colours change, never a program key.
- **Atlas.** Four tiles are appended to `TILE` (`REDROCK_STRATA`, `REDROCK_SAND`, `REDROCK_BAND`, `REDROCK_SAGE`), and `MAP_SURFACES.redrock` remaps sand, dust rock, sandstone and leaves.
- **Soundscape** (`public/js/audio/conquest-soundscape.js`): the zones are placed from `REDROCK_PLAN`, using the same takes as Frontier. Birds play at the oasis palms (A) and the reservoir (C), the mission bell at A and the machinery drone at the mine (B). The desert wind factor is 1.9. No new audio was generated: a desert wind bed and a dam-water roar are open gaps.
- **Minimap and big map** draw `public/assets/maps/redrock-overview.png` (1024², the orthographic `redrock/overview` capture). The lobby preview is `public/assets/maps/redrock.jpg` (the `redrock/vista` capture).

## Server and client loading

- The server builds Frontier at boot. It builds Redrock's template after it starts listening, on the first room tick, so boot time does not grow; `VOXEL_BATTLEFIELD_WARM=0` skips that and builds it on first use.
- The pristine template is about 1.56 MB run-length encoded (Frontier: 2.0 MB), well under the 3 MB payload budget that `tools/redrock-map-test.mjs` checks. The browser map cache (`MAP_CACHE_BYTE_BUDGET`, 4 MB) holds it next to Frontier's, so switching between the battlefields re-sends neither template.
- The client derives Redrock's metadata in the metadata worker (`frontier-meta-worker.js` with `{ map: 'redrock' }`) as soon as a lobby picks the map, so joining skips the heightfield build.
- The menu boot preloads 16 more modules (about 39 KB gzipped).

## Bots

Bots use the same surface navigation graph as Frontier (`mapMeta.navigation`: 4 m cells, 1-voxel steps) and the same commander. The dam crest is the shortest route to C, and the gallery and the canyon gullies are the alternatives. Vehicle routes come from the road graph, so tanks and jeeps cross at the bridges, the dam, the trestle and the fords.

Measured with `node tools/conquest-action-test.mjs --map redrock` (16 bots, 180 s, normal; seeds 1–3, compared with Frontier):

| | Redrock | Frontier |
|---|---|---|
| kills | 28–49 | — |
| infantry kills | 17–39 | 34–38 |
| flag transitions | 5–7 | 2–3 |
| vehicles destroyed | 7–9 | — |
| seated fraction | 0.33–0.36 | — |
| stuck fraction | about 0.01 | — |

Flags change hands more often on Redrock, but the open desert gives fewer infantry fights: the foot-fight fraction is about 0.21, and the median foot distance to the nearest enemy is about 107 m. Some seeds fall under the gate's 25 infantry kills (seed 1 has 17). This is a known gap: more cover between B and C and between E and C would help.

## Captures

```
node tools/render-map-scenes.mjs --map redrock --width 1440 --height 900          # vista, oasis, mine, dam, dam-crest, radar, railhead, trestle, reservoir, overview
node tools/render-map-scenes.mjs --map redrock --shot overview --width 1024 --height 1024
node tools/render-map-scenes.mjs --map redrock --shot vista --weather dusk
node tools/conquest-hud-capture.mjs --map redrock --out <dir>                      # HUD fixtures over Redrock's flags and overview
node tools/conquest-hud-capture.mjs --map redrock --only dam-armed,dam-breached --sizes desktop,portrait --out docs/design/conquest/events/dam/captures
```

The shots are in `shared/redrock-capture-shots.js` and stand on `redrockSurfaceY`. They all run in a muted headless browser.

The waiting lobby with Conquest and Redrock picked is captured in `captures/lobby-redrock-desktop.jpg` (1536 × 1024) and `captures/lobby-redrock-mobile.jpg` (390 × 844, no horizontal scroll). On the phone's two-column grid the closed map menu cuts the label to "REDROCK CANY…", as it cuts Frontier's; the capacity line under it carries the full name.

## Tests

`node tools/redrock-map-test.mjs` (in `npm run conquest:test`) checks:

- the map id, the lobby compatibility and capacity, and the plan;
- the `mapMeta.conquest` v2 shape, with flags and HQs agreeing with the plan, and the mirror symmetry;
- that every y comes from the terrain;
- the crossings, the reservoir and the canyon;
- the 19-hull fleet (Frontier's HQ fleet with the mobile AA, no boats), with point-mirrored HQ pads and the C tank's west and east pads;
- that the roads stay drivable;
- the landmarks and named places;
- standable, dry spawns with headroom in the generated voxels;
- the payload size and an exact round trip, and that the browser map cache keeps Frontier and Redrock together;
- the wading cue at both fords (reservoir level north of the dam, canyon level south);
- the presentation wiring: preview, label, capture shots, weather, apron colours and soundscape sites;
- the deploy options on the real map, including an accepted flag deploy and a refused enemy flag;
- a 60 s, 12-bot match: flags move, the dam is contested, bots fight and crew the fleet, nobody drowns or wedges in the canyon.

`node tools/conquest-map-event-dam-test.mjs` (in `npm run conquest:test`) covers the dam breach on the real world (see conquest.md *Testing*).

`node tools/redrock-lobby-test.mjs` (also in `npm run conquest:test`) runs the lobby over the real server: Conquest offers Redrock with Frontier as the default, other modes refuse it, the host's client receives Redrock's authoritative voxels, and the live match runs on Redrock's fleet and flags. `tools/lobby-settings-test.mjs` checks the lobby map menu and hint.

`tools/atlastest.mjs` pins the template fingerprint (`53094777`, 1 561 884 bytes) and the spawn counts. Re-pin them after any change to Redrock's geometry.

## Map events

- **Comeback call-in** (docs/conquest.md "Comeback call-in"): the same call-in as Frontier, with no geometry of its own; targets keep 8 m inside the combat area and off both HQ circles. Bomber headings from the caller's HQ: WEST over A 48°, B 131°, C 90°, D 72°, E 109°; EAST over A 288°, B 251°, C 270°, D 312°, E 229°. Shells around C land both on the river floor (21–23 m) and up the banks (34–47 m). Measured with 12 enemies standing around a flag: C bomber 3 kills, C artillery 4, D bomber 4, B artillery 0 (7 hurt).
