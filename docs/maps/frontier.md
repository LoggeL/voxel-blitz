# Frontier v2 / Iron Valley

Frontier is the Conquest battlefield: a 768 × 80 × 768 voxel river valley (47.2 M voxels). A river runs north to south through the middle, and the two HQ plateaus face each other across it, 624 m apart. The layout is point-symmetric about (384, 384). Five flag sites sit on the valley floor. Each site has a landmark that can be seen from both HQs.

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
3. **River.** The `FRONTIER_PLAN.river` spline is 12 m wide, with the bed at y18/19 and water at y19–21. The two fords lift the bed to y20 (one voxel of water) across 14 m and have gentle banks. After the clamp, water finds its level: any dry cell below y21 that touches the river (a ford bank or road shoulder graded down to the ford bed) is flooded too, so no water face ever stands over open ground.
4. **Roads.** Each road is graded by envelope relaxation between pins (decks, fords, pads, plateaus and earlier roads) to 2/3 of 1 voxel per 3 m. This keeps the rasterised cells at no more than 1 voxel per 3 m along the road and 1 voxel across it.
   - The paved axis runs HQ-W → C → HQ-E and is 10 m wide.
   - The gravel tracks are 7 m wide: HQ→A, HQ→B, A→C, B→C, A→D over ford-north, the north loop over bridge-north, and their EAST mirrors (E→B over ford-south, the south loop over bridge-south).
5. **Drivability clamp.** Neighbouring cells differ by at most 1 voxel everywhere, except two kinds of cliff: the mountains outside the combat area and six authored rock outcrops. These are the only steps of 2 voxels or more.
6. **Surfaces.**
   - MEADOW and DRY_GRASS by moisture.
   - FIELD_WHEAT and plough strips in 14 fields.
   - MUD and MC_CLAY on the banks.
   - GRAVEL tracks and hardstand.
   - STONE, DUST_ROCK and scree on slopes and in the mountains.
   - PINE_NEEDLES under the forests.
   - Shell-churned MUD and SCORCHED_EARTH around C and D.
   - DIRT tracks and patches.
   - Pre-carved craters.

## Sites (`frontier-sites/`)

| Flag | Site (module) | Hard point | Landmark (top y) |
|---|---|---|---|
| A Kestrel Farm (232, 248) | `farm.js`: timber barn with hay loft, field-stone barn, plaster farmhouse, haystacks, hedged lanes, wheat strips | stone barn | grain silo (y61), windmill (y54) |
| B St. Aldric (272, 520) | `village.js`: two-storey plaster houses with stepped terracotta roofs, walled yards, alleys, cobbled square, well | church nave | church spire (y78) |
| C Iron Bridge (384, 384) | `bridge.js`: bowstring truss over a CONCRETE deck on a METAL core, brick toll house, warehouse shell, ruins, quays, sandbagged bridgeheads | toll house | truss crown (y45), water tower (y50) |
| D Ridge Bunkers (496, 248) | `bunkers.js`: zig-zag trenches 2 deep with duckboards, sandbag lips and timber revetments; 2 concrete pillboxes; tank traps; MG nests | west pillbox | observation tower (y59), radar dome (y43) |
| E Kessler Works (536, 520) | `works.js`: enterable smelter hall with furnaces, gantry and crane rail; conveyor; rail yard with wagons; coal heaps; pump house; blast walls | smelter hall | two chimneys (y78), cooling tower (y65) |
| HQ ×2 | `hq-airfield.js`: 312 m runway along z, 2 helipads, arched hangar with roundel (WEST blue, EAST red), control tower with ladder, fuel farm, motor pool, command bunker, AA pits | command bunker | hangar ridge (y50) |

Every flag has the following, and `tools/frontier-sites-test.mjs` verifies each item:

- an enterable, roofed hard building that can be walked into from the flag's spawns (a 2.5D flood from the spawns reaches at least 60 % of the floor of every enterable building within 60 m of the flag);
- two infantry lanes with cover;
- a road and a flag-bound vehicle pad;
- at least 3 AT ambush points that overlook a road 15–90 m away;
- 12 dry, standable spawn cells.

`tools/frontier-terrain-test.mjs` checks that every flag has cover (2-high solids, a berm or a trench) in at least 6 of 8 directions within 10–35 m. All five flags currently have cover in all 8.

Map-wide content:

- **Forests (`forest.js`).** Ashgrove (south-west) and Blackwood (north-east) each hold 532 Poisson-disk trees: pine, oak and birch, at a minimum spacing of 4.6 m. Blackwood is built through the point-mirrored kit, so it is an exact voxel mirror of Ashgrove. The burnt stand behind D holds 39 snags. The total of 1103 trees is under the cap of 1800. No tree stands in a road corridor + 3 m, inside a flag radius, on a pad, plateau, river or cliff, or near the bunker works and wrecks.
- **Dressing (`dressing.js`).** 5 wrecks: tanks near C and D, trucks near C and B, and a crashed helicopter by D. Hedgerows and dry-stone walls cross the open fields between the flags, authored for WEST and mirrored for EAST. There are 18 pre-carved craters.
- **Roadside (`roadside.js`).** Built after the sites, only on open ground that no site claimed, outside every flag zone and HQ (radius + 14 m), and only where the point-mirrored cell on the EAST bank is open too. The paved axis gets a dashed centre line, a worn gravel verge and 8 m telegraph poles on its north side. Along every road: tyre ruts cutting into the grass, shrub clumps, timber fence runs 4 m off the edge, and toward the front (x >= 236 on the WEST bank) scorch marks with scattered wreckage and one-high sandbag nests. Nothing stands within 1.5 m of a road edge, and nothing but the poles is taller than 2 voxels.
- **Entrance steps.** Buildings on a slope stand on a level foundation at the highest ground of their footprint, so a downhill doorway can open several voxels above the ground. `buildEntrances` in `generate.js` finds every doorway cell (two clear voxels above the floor in the outer wall ring) of every enterable building and runs a flight of one-voxel steps straight out until it meets the ground. It never cuts through another structure, a road, the river or a ford. Without it the Kestrel stone barn (A) and the Kessler smelter hall (E), both hard points, could not be walked into.
- **Cleanup pass.** After all set pieces and entrances are built, `generate.js` reopens 5 voxels of headroom over every road and ford cell. It then clears every reserved footprint: spawn cells, vehicle pads, the runway and the helipads.

## Metadata contract (`getMapMeta('frontier')`, spec §3.2)

The metadata is frozen and terrain-derived, and it is built without allocating voxels. Coordinates are world voxel units, `y` is the feet height (top voxel + 1.02) and `yaw` is in radians, with forward = (−sin yaw, −cos yaw).

**Top-level fields:**

- `navigation: { mode: 'surface', cell: 4, maxStep: 1 }`
- `navigationFloor: null`
- `groundLevel: 24`
- `spawnBounds: { minX: 24, maxX: 743, minZ: 24, maxZ: 743, minY: 20, maxY: 79 }`
- `spawns.conquest`, which equals the base spawns
- `ladders`: both tower ladders and the observation tower
- `landmarks`: the flags plus the site landmark tops, each with `primary` set for the one per site that is checked from both HQs

**`conquest`:**

- `version: 2`
- `flags`: `{ id, name, site, x, y, z, radius, home, spawns ×12 }`
- `bases`: `{ alpha|bravo: { id, name, x, y, z, radius: 56, spawns ×8 } }`
- `combatArea`
- `vehicleSpawns`: 15 hulls
- `airfields`: today's shape, with terrain y
- `roads`: `{ id, kind, width, points: [[x, y, z]] }`, resampled every 10 m or less
- `crossings`: `{ id, kind, x, y, z, width }`
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
| `alpha-tank` | (126.5, 424.5) |
| `alpha-helicopter` | helipad (112.5, 300.5) |
| `alpha-transport` | helipad (112.5, 468.5) |
| `alpha-plane` | runway start (44, 532), yaw 0 (EAST yaw π) |
| `flag-A-jeep` (alpha) | (248.5, 237.5) |
| `flag-B-jeep` (alpha) | (256.5, 520.5) |
| `flag-D-jeep` (bravo) | (510.5, 250.5) |
| `flag-E-jeep` (bravo) | (520.5, 532.5) |
| `flag-C-tank` (team null, `flag: 'C'`) | west bank (346.5, 392.5); alternate east-bank pad `altX/altZ` (421.5, 375.5) |

**Crossings:**

| Crossing | Position | y |
|---|---|---:|
| bridge-north | (396, 150) | 25.02 |
| ford-north | (392, 270) | 21.02 |
| iron-bridge | (384, 384) | 26.02 |
| ford-south | (376, 498) | 21.02 |
| bridge-south | (372, 618) | 25.02 |

`FRONTIER_ROADS` (polylines of control points `[[x, z]]`), `FRONTIER_AIRFIELDS` and `FRONTIER_CONQUEST` are still exported. The last two are read-only views that resolve on first access, so importing the layout never builds the terrain. `FRONTIER_FLOOR` has been removed.

## Budgets (2026-10-07, after the WP4 review)

- Server generation is about 0.45 s (terrain 0.26 s plus voxels 0.17 s). The budget is 1.5 s.
- The run-length payload is 1,720,449 bytes, against a budget of 3.0 MB. The FNV-1a fingerprint is `84043d53`, pinned in `tools/atlastest.mjs`.
- Map memory: 47.2 MB of blocks, 1.2 MB of heights and about 6 MB of retained terrain arrays, against 52.4 MB of blocks and heights for the old 1024 × 48 × 1024 map. The terrain builder keeps its scratch arrays few and narrow (Int16 envelopes, no second relief buffer), because a process keeps freed typed-array pages resident.
- Process RSS, head to head (generator plus template plus one match state, `node --expose-gc`): old generator +121.7 MiB, Frontier v2 +128–130 MiB, so +5–7 % against the +10 % limit. The scripts are `.conquest-work/wp4/review/rss-old.mjs` (the retired generator, from `.conquest-work/wp4/retired/`) and `.conquest-work/wp4/review/rss-new.mjs`.
- The top surface:
  - DRY_GRASS 26.5 % is the largest share;
  - 10 materials are above 2 %;
  - the terrain height standard deviation is 6.3 inside the combat area.

## Validation

Run each file on its own (on the shared development machine, through `.conquest-work/heavy.sh <timeout> node <file>`):

```
node tools/frontier-terrain-test.mjs     # pads, grades, jeep/tank drive along every road and ford, river, sight lines, cover, budgets
node tools/frontier-sites-test.mjs       # per-flag gameplay contract, landmarks, forests, dressing
node tools/frontier-map-test.mjs         # §3.2 shape, terrain y everywhere, 15-hull fleet, round trip
node tools/frontier-airfields-test.mjs   # runway, corridor, helipads, roundel, tower ladder, mirroring
node tools/frontier-fleet-capacity-test.mjs  # parked hulls, pivots, pickup routes, bay exits, aircraft departures
node tools/conquest-world-protocol-test.mjs  # V2 RLE header, Frontier payload, client decode
node tools/large-maps-test.mjs           # Frontier far-edge network, destruction, fire, mesh
node tools/atlastest.mjs                 # fingerprint and metadata invariants
```

## Map images

`public/assets/maps/frontier-overview.png` and `public/assets/maps/frontier.jpg` are renders of the game. Regenerate them with muted CDP captures, never with live match pages. Run the commands in the serialized capture phase:

```
node tools/render-map-scenes.mjs --map frontier --shot overview --vehicles --out-dir .conquest-work/captures/wp4 --width 1024 --height 1161
node tools/render-map-scenes.mjs --map frontier --shot vista --vehicles --out-dir .conquest-work/captures/wp4 --width 1440 --height 1037
sips -g pixelWidth -g pixelHeight .conquest-work/captures/wp4/frontier-overview.png   # must be 1024 x 1024
cp .conquest-work/captures/wp4/frontier-overview.png public/assets/maps/frontier-overview.png
sips -s format jpeg -s formatOptions 88 .conquest-work/captures/wp4/frontier-vista.png --out public/assets/maps/frontier.jpg
```

The `overview` shot is orthographic and north-up: x = 0 is on the left, z = 0 is at the top, and its scale is 768.
