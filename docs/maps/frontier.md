# Frontier v2 / Iron Valley

Frontier is the Conquest battlefield: a 768 × 80 × 768 voxel river valley (47.2 M voxels). A river runs north to south through the middle, and the two HQ plateaus face each other across it, 624 m apart. The layout is point-symmetric about (384, 384). Five flag sites sit on the valley floor. Each site has a landmark that can be seen from both HQs. Four named places between the flags (Kestrel Halt, Hollin Fuel Depot, Aldric Quarry, Signal Rock) carry landmarks of their own.

The generator is pure and deterministic, with one constant seed:

- `shared/world/frontier-terrain.js` builds the heightfield and its surfaces. It has no voxels.
- `shared/world/frontier-sites/*.js` adds the set pieces on top.
- `shared/world/frontier-layout.js` publishes the metadata. It re-exports `shared/world/frontier-sites/layout.js`.

All plan values (dimensions, HQs, flags, river, crossings and reference heights) come from `FRONTIER_PLAN` in `shared/conquest-contract.js`.

## Terrain (`frontier-terrain.js`)

`frontierTerrain()` returns `{ heights: Int16Array, surface: Uint8Array, drivable: Uint8Array, water, ground, kind, roadIndex, crater, roads }` for the 768² columns. It is memoised and takes about 0.3 s. `FRONTIER_TERRAIN` is a lazy view of the same arrays.

- `heights[i]` is the y of the top solid terrain voxel: the river bed, the ground, a road or a bridge deck.
- `frontierSurfaceY(x, z)` is the standing height, `heights + 1`.
- Metadata feet positions are `frontierTopY(x, z) + 1.02`.

The pipeline:

1. **Relief.** Fractal noise, plus authored hill masses: St. Aldric's hill and its mirror under Ridge Bunkers, a north-west upland and a south-west shoulder. The valley rim rises toward the restricted edge, then into ridged mountains up to y60 outside the combat area (24…744). The relief is blended point-symmetric.
2. **Pads.**
   - Flag pads have a radius of flag radius + 12, a 20 m smoothstep falloff, and these levels: farm 27, village 33, bridge 25, bunkers 33, works 27.
   - The HQ plateaus are flat at y36: x 26–146 by z 200–568 for WEST, mirrored for EAST.
   - Each runway approach stays level for 90 m and then climbs at 1:5.
3. **River.** The river is a waterway the patrol boats can run end to end (2026-10-20; it was 12 m at the crossings and 24–30 m between them, 3 m deep). The `FRONTIER_PLAN.river` spline (`width` 20, `depth` 4.5, `surfaceY` 21) keeps a 20 m channel at the five crossings (`riverHalfAt(z)` is 10 there) and widens to 36–44 m on the open reaches between them (`riverReach(z)`: full width 46 m from a bridge or ford, 66 m from the Iron Bridge, whose quays run ±44 m). `riverMeander(z)` bends each reach (±9–15 m, `sin²` so every crossing stays square to the banks; zero within 48 m of the Iron Bridge); the south reaches are the point mirror of the north ones.
   - The water face is y22 (water voxels up to y21). The bed is y17 (4 m of water), y16 (5 m) down the middle half of a wide reach, and shelves to y18 (3 m) and y19 (2 m) over the last 3 m before each bank: the channel averages about 4.5 m, the whole river 4.05 m. Deep beds are gravel, the shelves mud.
   - The two fords lift the bed to y20 (one voxel, 1 m of water) across the whole 20 m channel for 14 m along it, with gentle banks. Jeeps and tanks drive through on the bed; a boat floats over it with 0.55 m under the keel but scrapes (`BOAT_RULES.shallowDepth`), so it crosses at 5 m/s at most.
   - Six gravel islands (`FRONTIER_ISLANDS`, three authored, three mirrored) stand 10–11.5 m off the centreline in the wide reaches (at least 6 m clear of it, so the boat lane down the middle stays open): a y21 gravel/sand rim round a y22 grassy crown. They keep kind RIVER (not drivable) with no water above them.
   - The inside of every bend carries a gravel/sand beach one voxel above the water (a beach flush with the surface trapped swimming bots); the rest of the bank climbs one voxel per metre as before.
   - After the clamp, water finds its level: any dry cell below y21 that touches the river (a ford bank or road shoulder graded down to the ford bed) is flooded too, so no water face ever stands over open ground.
   - Vehicles still cross only at the 3 bridges and 2 fords: the bed sits 3–6 voxels under every bank.
   - Bridge decks keep the river bed under them: a road shoulder never fills an arch (before the widening, the south loop's shoulder had filled the west arch of bridge-south up to the deck).
4. **Roads.** Each road is graded by envelope relaxation between pins (decks, fords, pads, plateaus and earlier roads) to 2/3 of 1 voxel per 3 m. This keeps the rasterised cells at no more than 1 voxel per 3 m along the road and 1 voxel across it.
   - The paved axis runs HQ-W → C → HQ-E and is 10 m wide.
   - The gravel tracks are 7 m wide: HQ→A, HQ→B, A→C, B→C, A→D over ford-north, the north loop over bridge-north, and their EAST mirrors (E→B over ford-south, the south loop over bridge-south).
5. **Drivability clamp.** Neighbouring cells differ by at most 1 voxel everywhere, except two kinds of cliff: the mountains outside the combat area and six authored rock outcrops. These are the only steps of 2 voxels or more.
6. **Surfaces.**
   - MEADOW and DRY_GRASS by moisture.
   - FIELD_WHEAT and plough strips in 14 fields.
   - MUD, MC_CLAY and patches of meadow on the banks; GRAVEL and SAND on the bend beaches and island rims.
   - GRAVEL tracks and hardstand.
   - STONE, DUST_ROCK and scree on slopes and in the mountains.
   - PINE_NEEDLES under the woods (`frontierWoodDensity() > 0.4`, sampled on a 2 m lattice), SCORCHED_EARTH and dry grass in the burnt stand.
   - Shell-churned MUD and SCORCHED_EARTH around C and D.
   - DIRT tracks and patches.
   - Pre-carved craters (18 dug bowls) and 22 shell scars (scorched and churned, not dug out).
   - FIELD_WHEAT and plough strips in 18 fields (four golden strips either side of the paved axis were added in the 2026-10-07 content pass).

## Sites (`frontier-sites/`)

| Flag | Site (module) | Hard point | Landmark (top y) |
|---|---|---|---|
| A Kestrel Farm (232, 248) | `farm.js`: timber barn with hay loft, field-stone barn, plaster farmhouse, haystacks, hedged lanes, wheat strips | stone barn | grain silo (y61), windmill (y54) |
| B St. Aldric (272, 520) | `village.js`: two-storey plaster houses with stepped terracotta roofs, walled yards, alleys, cobbled square, well; 16 closed hill houses (1–3 storeys, timber doors) on stone plinths up the west rise and down the south slope, stepped cobble lanes, walled garden plots, cypresses; white-plastered bell tower with stone quoins | church nave | church spire (y78) |
| C Iron Bridge (384, 384) | `bridge.js`: bowstring truss over a CONCRETE deck on a METAL core, brick toll house, warehouse shell, ruins, quays, sandbagged bridgeheads | toll house | truss crown (y45), water tower (y50) |
| D Ridge Bunkers (496, 248) | `bunkers.js`: zig-zag trenches 2 deep with duckboards, sandbag lips and timber revetments; 2 concrete pillboxes; tank traps; MG nests | west pillbox | observation tower (y59), radar dome (y43) |
| E Kessler Works (536, 520) | `works.js`: enterable smelter hall with furnaces, gantry and crane rail; conveyor; rail yard with wagons and sleeper stacks; coal heaps; pump house; boiler house; blast walls | smelter hall | two chimneys (y78), two boiler stacks (y70, y66), cooling tower (y65) |
| HQ ×2 | `hq-airfield.js`: 312 m runway along z, 2 helipads, arched hangar with roundel (WEST blue, EAST red), control tower with ladder, fuel farm, motor pool, command bunker, AA pits | command bunker | hangar ridge (y50) |

The Iron Bridge spans the 20 m channel (x 374–393) with one pier pair on the centreline (x 383–384), so both arches are 9 m wide; the truss feet stand on the banks at x 366 and 401 (35 m apart, crown y45), and the bridgehead stands back from the water: quay lanes at x 370 and 397 with their walls at x 366 and 401, the toll house, warehouse and ruins 4 m further out than before, the C tank pads at (346.5, 392.5) and (421.5, 375.5), whole on the y25 bridgehead. The flag radius stays 24 m, so 14 m of each bank lies in the zone; the 12 spawn cells stand 20–25 m from the flag, six on each bank, at least 13 m off the centreline. The end bridges stand at y26 (deck underside y25, 3 m over the water face) so a boat passes under them as under the Iron Bridge (underside y24). Their decks are squared to a rectangle over the water (the bent loop roads left a stepped edge and a notch of open water at the deck ends), and the bank 2 m beyond each side of the deck stands flush with it, railed along its water edge.

In Conquest the Iron Bridge span can be blown down: supports, stages, the fall into the river and the bots' fords are in [docs/conquest.md "Iron Bridge collapse"](../conquest.md#iron-bridge-collapse). The truss geometry (`IRON_ARCH`) lives in `shared/conquest-bridge.js` and is shared by `bridge.js` and the collapse, so the voxels and the falling box cannot drift apart. Bots attack it when one side gains more than 100 road metres by its fall (four flags against one: ±362 m) and the other side holds the bridgeheads at (365.5, 26.02, 384.5) and (403.5, 26.02, 384.5) (`IRON_BRIDGE.heads`; docs/conquest.md "Levolutions").

### Places between the flags (`locations.js`)

Four non-objective locations fill the empty pockets between the flags. Their positions are point mirrors in pairs, so each team finds the same kind of ground at the same distance from its flags, while the themes differ (as A/E and B/D do). Each has a landmark that reads from 300 m, cover and an interior up close, and a gravel or concrete drive from the nearest road. They are built last among the set pieces, after the woodland (which keeps out of their footprints) and the roadside dressing. The roadside pass leaves their footprints bare but still treats those cells as open in every placement decision, so its random sequence, and the dressing everywhere else, is exactly what it is without the places (an earlier order shifted debris map-wide, and the changed routes sent a bot into a dead-end corner of the D trench in `large-map-navigation-test`).

| Place (centre) | Between | What is there | Landmark (top y) |
|---|---|---|---|
| Kestrel Halt (258, 330) | A, C and the West HQ, east of the a-c road | single-track siding on a gravel ballast bed (x 218–290), a stone platform, a two-storey plaster station house (doors to the platform, the yard and the west lane), two boxcars with walk-through doors, a derailed boxcar on its side up the line, sleeper stacks, a buffer stop | timber grain elevator with a drive-through bay and a spout to the siding (y54) |
| Hollin Fuel Depot (500, 432) | E, C and the East HQ, east of the e-c road | concrete forecourt with a pump canopy, a brick garage office with three doors, three squat fuel tanks inside a 2 m earth bund with three breaches, a pipe rack, a burnt-out tanker, sandbags | steel sign pylon with an orange board (y49) |
| Aldric Quarry (270, 598) | B and bridge-south, north of the south loop | a pit dug into the slope: a y24 gravel floor, a y28 rock bench along the high west and north faces with a ramp onto it, banded stone faces, the floor ramping out to the natural ground on the open south and east sides; a crusher tower on steel legs, a feed conveyor from a hopper on the bench, a stacker conveyor to a gravel cone by the road, a dump truck, loose blocks, a site hut on the bench | crusher tower (y45) |
| Signal Rock (470, 166) | D and bridge-north, south of the north loop | a lattice radio mast with two platforms on the rock knoll, a concrete relay bunker (three doors, a dish on the roof), a generator shed, sandbagged MG pits round the knoll, aerial poles | radio mast (y62) |

Rules the places keep, tested in `tools/frontier-sites-test.mjs`:

- Every building stands more than 80 m from every flag, so a squad staging point (50–76 m out) never lands on a roof.
- Every enterable, closed building can be walked into from the nearest road, and every quarry floor cell connects to the road. No building has a single door, and the boxcars and the elevator bay are open through.
- Each landmark tops out at its published y and rises at least 15 m above its ground.
- They stay off the roads, fields, the river and the crossings, outside the runway corridors and clear of the HQ sight lines to the site landmarks (`frontier-terrain-test`).
- A one-voxel plinth or kerb runs under every roof overhang (station house, relay bunker, pump canopy, crusher). A transport (3 × 7 m hull) checks only its touchdown spot, so without it a transport could set down beside a wall and then climb into the eaves (`conquest-bot-aircraft-test` drops a squad at (264, 344), next to the station house).
- The quarry is dug below the planned terrain. Its props read the dug level (a kit view whose `top()` returns it), and the woodland and roadside dressing skip its footprint.

The Hollin Fuel Depot is also a map event (docs/conquest.md *Hollin Fuel Depot*): its three tanks (`DEPOT_TANKS` in `shared/map-events/depot.js`, centres (506.5, 421.5), (517.5, 421.5) and (512.5, 431.5), radius 4.2) can be shot open and go up in a chain reaction that cuts three craters into the bund, drops the pump canopy and the pipe rack and leaves a smoke column over the forecourt. The generated depot is unchanged (runtime block deltas only, so the map fingerprints stay), and `tools/conquest-map-event-depot-test.mjs` fails if the tanks move. The event breaks the point symmetry for now: the depot's mirror is Kestrel Halt, which has no event (its grain elevator topple was cut; the planned WEST service depot on the existing siding, bound to A, restores the symmetry).

Signal Rock and Aldric Quarry carry no map event any more (the relay scan, the mast topple and the quarry rockslide were cut, docs/conquest.md *Map events*); the bunker, the mast and the pit stay as cover.

The metadata publishes each place twice in `landmarks`: a row `{ id, kind: 'place', name, x, y, z }` (feet height; for map labels) and its landmark top `{ id, kind, place, x, y, z }`. The big map does not label places yet.

Every flag has the following, and `tools/frontier-sites-test.mjs` verifies each item:

- an enterable, roofed hard building that can be walked into from the flag's spawns (a 2.5D flood from the spawns reaches at least 60 % of the floor of every enterable building within 60 m of the flag);
- two infantry lanes with cover;
- a road and a flag-bound vehicle pad;
- at least 3 AT ambush points that overlook a road 15–90 m away;
- 12 dry, standable spawn cells.

`tools/frontier-terrain-test.mjs` checks that every flag has cover (2-high solids, a berm or a trench) in at least 6 of 8 directions within 10–35 m. All five flags currently have cover in all 8.

Map-wide content:

- **Woodland (`forest.js`).** `frontierWoodDensity(x, z)` (terrain module, point-symmetric) combines 17 authored woods (`FRONTIER_WOODS`: Ashgrove/Blackwood, the Kestrel upland pinewood, the valley-rim woods, copses between the roads) with clumpy tree lines 2–26 m back from both river banks that open at every crossing. Trunks are placed on a 5.7 m jittered grid on the west half where the density allows and planted again through the point-mirrored kit, so the east half is an exact mirror (`plan.west` / `plan.east`). 1952 trees in total (cap 4200): mostly pines, oak and birch mixed in, more broadleaf along the banks; 44 burnt snags in the stand behind D; 224 bush clumps along the wood edges.
  - Trees are stacked square tiers (the classic voxel pine): square tiers merge into a few faces in the greedy meshers. A round crown cost about three times the faces; the distant shell budget (`tools/distant-voxel-shell-test.mjs`, < 170 000 quads) is what limits the tree count.
  - Exclusions (pure, tested on both halves): road corridor + 3 m, 82 m around every flag (the bot commander stages squads and sets transports down 42–76 m out, which must not be canopy), pads, plateaus, the runway approach corridors (36 m either side of each runway line), fields, river, cliffs, every site footprint, lane and ambush point, the four places between the flags (+2 m), the bunker trenches, wrecks and hulks, hedges and walls, 18 m round every crossing, the C bridgehead (58 m) and the meadow between ford-north and C, and every eye-to-landmark sight line from both HQs.
  - Trees are planted after the sites and only fill air, so they never cut a wall.
- **Dressing (`dressing.js`).**
  - 8 burning wrecks (published as smoke anchors in `conquest.dressing`; the client ambience smokes up to 8): tanks near C and D, trucks near C and B, a crashed helicopter by D, and a tank, a truck and a tank at ford-north, ford-south and bridge-south.
  - 8 cold burnt-out hulks (tanks and trucks) in the open middle, authored WEST and mirrored.
  - 8 roofless ruined cottages with rubble spill (4 + mirrors).
  - Czech hedgehogs on the banks beside bridge-north and ford-north (and their mirrors) and one-high sandbag lines on the bank tops.
  - Reed beds (dry-grass tufts) along the beaches and island rims.
  - Hedgerows and dry-stone walls cross the open fields between the flags, authored for WEST and mirrored for EAST.
  - 18 pre-carved craters plus 22 mirrored shell scars kept 6 m off every road. The scars are not dug: extra pits on the approaches made bots go to ground instead of pushing flags (fewer flag transitions in `conquest-action-test`).
- **Roadside (`roadside.js`).** Built after the sites, only on open ground that no site claimed, outside every flag zone and HQ (radius + 14 m), and only where the point-mirrored cell on the EAST bank is open too. The paved axis gets a dashed centre line, a worn gravel verge and 8 m telegraph poles on its north side. Along every road: tyre ruts cutting into the grass, shrub clumps, timber fence runs 4 m off the edge, and toward the front (x >= 236 on the WEST bank) scorch marks with scattered wreckage and one-high sandbag nests. Nothing stands within 1.5 m of a road edge, and nothing but the poles is taller than 2 voxels.
- **Entrance steps.** Buildings on a slope stand on a level foundation at the highest ground of their footprint, so a downhill doorway can open several voxels above the ground. `buildEntrances` in `generate.js` finds every doorway cell (two clear voxels above the floor in the outer wall ring) of every enterable building and runs a flight of one-voxel steps straight out until it meets the ground. It never cuts through another structure, a road, the river or a ford. Without it the Kestrel stone barn (A) and the Kessler smelter hall (E), both hard points, could not be walked into.
- **Cleanup pass.** After all set pieces and entrances are built, `generate.js` reopens 5 voxels of headroom over every road and ford cell. It then clears every reserved footprint: spawn cells, vehicle pads, the runway and the helipads.

### Ford sluices (`weir.js`)

Two concrete weirs, one above each ford, both the Conquest ford sluices (docs/conquest.md *Ford sluices*; geometry `WEIR` / `WEIR_SOUTH` in `shared/map-events/weir.js`, built by `buildWeir`).

- **North sluice**: across the north reach, z 254-257 (the platform to z 261), 6 m upstream of ford-north's first row. It has abutments on both banks (x 374-379, x 400-404), piers at x 383 and x 394, a 3 m west gate bay and a 5 m east gate bay with shut RUST leaves under steel gantries, and the 10 m navigation pass between the piers. The boat lane runs through the pass at x 389, under the 2 m railed walkway at deck y25. A platform with the (inert) sluice wheel stands over the pass, downstream of the walkway. Infantry step onto the deck from the west bank and down a step to the lower east bank. The tank wreck dressing at ford-north stands just west of the west abutment.
- **South sluice**: the smaller twin above ford-south, z 477-480 (the platform to z 483), abutments x 359-363 and x 386-390, piers at x 369 and x 380 around the 10 m pass (x 370-379), gate bays x 364-368 and x 381-385, the walkway at z 478-479.
- **Ponds**: each weir holds the reach one voxel up (water face y23 against y22). The north pond runs x 350-415, z 205-254 (1700 water cells), the south one x 350-400, z 470-477 (193 cells; kept short of the alpha boat mooring at (361, 464)). A stone sill (`sillStone`) closes each pond upstream at z 203-204 and z 468-469 except for an 11 m boat chute (north x 375-385, south x 367-377), so the only open water faces are the spill over the pass and the chute. Boats ride the 1 m step at the chute and the spill (`BOAT_RULES.waterStep` 1.1).
- No hull fits on a walkway. Trees and roadside props keep out of both footprints (`WEIR_KEEP_OUT`, `WEIR_SOUTH_KEEP_OUT`).

The north sluice has stood since the locations pass and is on one side of the map only; the south one restores the point symmetry about (384, 384) for the lanes, though not for the voxels (the two weirs differ in size and the south pond is shorter).

## Metadata contract (`getMapMeta('frontier')`, spec §3.2)

The metadata is frozen and terrain-derived, and it is built without allocating voxels. Coordinates are world voxel units, `y` is the feet height (top voxel + 1.02) and `yaw` is in radians, with forward = (−sin yaw, −cos yaw).

**Top-level fields:**

- `navigation: { mode: 'surface', cell: 4, maxStep: 1 }`
- `navigationFloor: null`
- `groundLevel: 24`
- `spawnBounds: { minX: 24, maxX: 743, minZ: 24, maxZ: 743, minY: 20, maxY: 79 }`
- `spawns.conquest`, which equals the base spawns
- `ladders`: both tower ladders and the observation tower
- `landmarks`: the flags, the four places (`kind: 'place'`, with a name) and the site and place landmark tops, each site top with `primary` set for the one per site that is checked from both HQs

**`conquest`:**

- `version: 2`
- `flags`: `{ id, name, site, x, y, z, radius, home, spawns ×12 }`
- `bases`: `{ alpha|bravo: { id, name, x, y, z, radius: 56, spawns ×8 } }`
- `combatArea`
- `vehicleSpawns`: 23 hulls
- `airfields`: today's shape, with terrain y
- `roads`: `{ id, kind, width, points: [[x, y, z]] }`, resampled every 10 m or less
- `crossings`: `{ id, kind, x, y, z, width }`
- `waterways`: one boat lane, `{ id: 'river', kind: 'boat-lane', width: 5, points: [[x, 22, z]] }` with 89 points at the water face, every 8 m from z 32 to z 736: the whole river inside the combat area, 729 m. It follows the river's centreline (the deep channel, at least 6 m off every island), crosses both fords and swings 5 m off the centreline under each bridge, clear of the piers: the east arch of bridge-north (x 401) and of the Iron Bridge (x 389), the west arch of bridge-south (x 367). Away from the Iron Bridge the lane is its own point mirror. The patrol bots sail it, and tests read it to check that a boat can get from mooring to mooring and from one end of the river to the other (`frontier-river-test`).
- `weather: 'golden'`
- `dressing`: the wreck smoke anchors

| Flag | x | y | z | radius | home |
|---|---:|---:|---:|---:|---|
| A Kestrel Farm | 232 | 28.02 | 248 | 22 | alpha |
| B St. Aldric | 272 | 34.02 | 520 | 20 | alpha |
| C Iron Bridge | 384 | 26.02 | 384 | 24 | – |
| D Ridge Bunkers | 496 | 34.02 | 248 | 22 | bravo |
| E Kessler Works | 536 | 28.02 | 520 | 22 | bravo |

**HQs:** WEST (72, 37.02, 384) and EAST (696, 37.02, 384).

**Fleet (spec §4.4).** Each pad is listed for WEST first; the EAST pad is its point mirror.

| Hulls | Pad, WEST (EAST is the point mirror) |
|---|---|
| `alpha-jeep` | (126.5, 404.5) |
| `alpha-jeep_at` | (126.5, 414.5) |
| `alpha-tank` | (126.5, 424.5) |
| `alpha-aa` (mobile AA) | south motor-pool bay (126.5, 433.5) |
| `alpha-helicopter` | helipad (112.5, 300.5) |
| `alpha-transport` | helipad (112.5, 468.5) |
| `alpha-plane` | runway start (44, 532), yaw 0 (EAST yaw π) |
| `flag-A-jeep` (alpha) | (248.5, 237.5) |
| `flag-B-jeep` (alpha) | (256.5, 520.5) |
| `flag-D-jeep` (bravo) | (510.5, 250.5) |
| `flag-E-jeep` (bravo) | (520.5, 532.5) |
| `flag-C-tank` (team null, `flag: 'C'`) | west bank (346.5, 392.5); alternate east-bank pad `altX/altZ` (421.5, 375.5) |
| `alpha-boat-north` / `bravo-boat-south` | moored at (373, 236), yaw −2.83, above ford-north / EAST mirror (395, 532) |
| `alpha-boat-south` / `bravo-boat-north` | moored at (361, 464), yaw 0.28, below the Iron Bridge / EAST mirror (407, 304) |

Boats float at y 21.57 (water face 22 minus the 0.45 m draft, plus 0.02). Each mooring lies where a reach narrows toward a crossing, about 5 m off the west bank (boarding range from the bank) and 9 m beside the boat lane. Each boat pad is named for where it sits on the river, so the EAST mirror of WEST's north boat is `bravo-boat-south`. Every pad clears a full pivot (32 yaws), and a boat crewed from the bank gets under way (`frontier-fleet-capacity-test`). Boats are left out of the HQ walking-route checks.

**Crossings:**

| Crossing | Position | y |
|---|---|---:|
| bridge-north | (396, 150) | 27.02 |
| ford-north | (392, 270) | 21.02 |
| iron-bridge | (384, 384) | 26.02 |
| ford-south | (376, 498) | 21.02 |
| bridge-south | (372, 618) | 27.02 |

`FRONTIER_ROADS` (polylines of control points `[[x, z]]`), `FRONTIER_AIRFIELDS` and `FRONTIER_CONQUEST` are still exported. The last two are read-only views that resolve on first access, so importing the layout never builds the terrain. `FRONTIER_FLOOR` has been removed.

## Budgets (2026-10-07, after the world content pass)

- Server generation is about 0.55 s (terrain 0.30 s plus voxels 0.25 s; the four places add about 3 ms; it was 0.49 s before the content pass). The budget is 1.5 s.
- The run-length payload is 2,015,699 bytes (2,012,784 before the ford sluices' ponds, sills and south weir, 2,012,889 while the cut quarry rockslide's charges and plunger stood in the north face, 2,011,664 before the sluice weir, 2,011,579 before the bridgeheads were squared, 2,000,764 before the river was widened, 1,986,604 before the locations pass, 1,720,449 before the content pass), against a budget of 3.0 MB. The FNV-1a fingerprint is `6ba1b900` (`9ba4890a` before the ford sluices), pinned in `tools/atlastest.mjs`.
- The distant voxel shell (medium profile) draws 165 629 greedy quads against the 170 000 budget (165 632 before the bridgeheads were squared, 166 611 before the river was widened, 165 476 before the locations pass, 151 414 before the content pass). Trees and bushes are about 51 000 of them; this budget, not the payload, caps the woodland. The four places cost about 2 000 quads, of which about 650 come back from the trees their footprints displace.
- Map memory: 47.2 MB of blocks, 1.2 MB of heights and about 6 MB of retained terrain arrays, against 52.4 MB of blocks and heights for the old 1024 × 48 × 1024 map. The terrain builder keeps its scratch arrays few and narrow (Int16 envelopes, no second relief buffer), because a process keeps freed typed-array pages resident.
- Process RSS, head to head (generator plus template plus one match state, `node --expose-gc`): old generator +121.7 MiB, Frontier v2 +128–130 MiB, so +5–7 % against the +10 % limit. The scripts are `.conquest-work/wp4/review/rss-old.mjs` (the retired generator, from `.conquest-work/wp4/retired/`) and `.conquest-work/wp4/review/rss-new.mjs`.
- The top surface:
  - DRY_GRASS 21 % is the largest share;
  - 12 materials are above 2 %;
  - the terrain height standard deviation is 6.55 inside the combat area.

## Validation

Run each file on its own (on the shared development machine, through `.conquest-work/heavy.sh <timeout> node <file>`):

```
node tools/frontier-terrain-test.mjs     # pads, grades, jeep/tank drive along every road and ford, river, sight lines, cover, budgets
node tools/frontier-sites-test.mjs       # per-flag gameplay contract, landmarks, forests, dressing
node tools/frontier-map-test.mjs         # §3.2 shape, terrain y everywhere, 23-hull fleet, boat lane, round trip
node tools/frontier-river-test.mjs       # channel widths and depths, fords, deck clearance, bot boats end to end (through both sluice ponds), C from both banks, boats through the fallen span
node tools/frontier-airfields-test.mjs   # runway, corridor, helipads, roundel, tower ladder, mirroring
node tools/frontier-fleet-capacity-test.mjs  # parked hulls, pivots, pickup routes, bay exits, aircraft departures
node tools/conquest-world-protocol-test.mjs  # V2 RLE header, Frontier payload, client decode
node tools/large-maps-test.mjs           # Frontier far-edge network, destruction, fire, mesh
node tools/atlastest.mjs                 # fingerprint and metadata invariants
```

## Map images

`public/assets/maps/frontier-overview.png` and `public/assets/maps/frontier.jpg` are renders of the game. Regenerate them with muted CDP captures, never with live match pages. Run the commands in the serialized capture phase:

```
node tools/render-map-scenes.mjs --map frontier --shot overview --vehicles --out-dir .conquest-work/captures/wp4 --width 1024 --height 1024
node tools/render-map-scenes.mjs --map frontier --shot vista --vehicles --out-dir .conquest-work/captures/wp4 --width 1440 --height 900
sips -g pixelWidth -g pixelHeight .conquest-work/captures/wp4/frontier-overview.png   # must be 1024 x 1024
cp .conquest-work/captures/wp4/frontier-overview.png public/assets/maps/frontier-overview.png
sips -s format jpeg -s formatOptions 88 .conquest-work/captures/wp4/frontier-vista.png --out public/assets/maps/frontier.jpg
```

The `overview` shot is orthographic and north-up: x = 0 is on the left, z = 0 is at the top, and its scale is 768.

## Map events

- **Comeback call-in** (docs/conquest.md "Comeback call-in"): the trailing side's squad leader marks a bomber run or an artillery barrage on the full map; no geometry of its own. Bomber headings come from the caller's HQ: WEST over A 50°, B 124°, C 90°, D 72°, E 106°; EAST over A 286°, B 252°, C 270°, D 304°, E 230°. A run over C crosses the Iron Bridge along the deck: 3 of the 7 bombs burst on the truss (40–46 m) instead of the deck, and the call-in never wears the bridge supports down. Measured with 12 enemies standing around a flag: C bomber 7 kills, C artillery 6, D bomber 3, D artillery 1.
- **Ford sluices** (docs/conquest.md "Ford sluices"): blowing a sluice's piers and gate leaves (a 500 pool: 5 RX-8 rockets) drops its walkway and gantries, drains its pond as a bore down 120 m of reach and scours its ford two voxels deeper: 3 m of water, closed to every hull for the round (a tank stops under the 4 m east wall of ford-north). Closing ford-north lengthens the A-D drive from 268 to 427 road metres. The walkway leaves 14 stepping-stone columns for infantry.
