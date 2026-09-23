# Bikini Bottom

An undersea cartoon town on the standard 128 × 40 × 96 grid (`GROUND = 14`).
The map is original procedural voxel work inspired by the show. No assets,
meshes, textures, logos or audio are copied; place names are used only as
labels, and landmark names avoid character names ("Pineapple", "Moai House",
"Rock Home", "Boating School").

Select **Bikini Bottom** when creating a lobby. It supports every combat mode:
Fun, TTT, 1v1, Chaos Lab, TDM, Search & Destroy and Gun Game, for up to 12
players.

## Layout

North is low z. Bravo, TDM bravo and the S&D defenders spawn on the north strip
(z 3–13); alpha, TDM alpha and the S&D attackers on the south strip (z 82–92).
All gameplay footprints in the core, the outer lanes and the car lots are
point-symmetric about `P(x, z) = (127 - x, 95 - z)`; the landmark art differs.

| Region | Rectangle | Contents |
|---|---|---|
| R1 Conch Street houses | x 15–112, z 14–27 | Kelp Grove, the two-floor Pineapple with a stairwell, the solid Moai House (mid-north blocker), the terraced Rock Home, Anchor Yard |
| R2 Krusty Krab (site A) | x 15–49, z 34–61 | Wooden restaurant with a roofed dining floor (plant area), kitchen and grill, office, front, back and drive-thru portals, the A car lot |
| R3 Boating School (mid) | x 50–77, z 34–61 | Boat hull classroom with a deck at y18, wheelhouse, boat-bus and shake shack, the flume |
| R4 Chum Bucket (site B) | x 78–112, z 34–61 | Raised metal plinth and bucket ring with the deck plant area (floor y17), gatehouse, stairs and ramps, the Chum Lab TTT hideout under the deck, the B car lot |
| R5 South quarter | x 15–112, z 68–81 | Wreck Cove, Goo Lagoon (63 two-deep `MC_WATER` columns) with a lifeguard hut, the Coral Pinnacle, the glass Treedome, Jellyfish Fields |

Conch Street runs east–west between R1 and downtown, Jellyfish Trail between
downtown and R5. Road conch sculptures, spawn-strip cover and the outer-lane
blockers belong to the core (`shared/world/flatmap-bikini-bottom.js`). Each
region builder writes above `GROUND` only inside its own rectangle, and hashed
decoration only swaps the material of already solid cells or recolours floor
paint, so heights stay deterministic and every prop top is either T+1, a
reachable T+2/T+3, or at least T+4 (the bot roam window is
`standHeights [13, 17]`, with no navigation floor).

**Boating School Flume.** `meta.slides` carries one ride (`boating-flume`,
`shared/world/bikini-bottom-data.js`): from the school deck south-west to the
lagoon, on the shared `SLIDE_RULES` rails, prone, identical in prediction and on
the server. The last segment rises into a kicker, so the rider leaves airborne
at about 7.6 m/s and splashes into Goo Lagoon after about 3.2 s. The path's y
values were raised from the original design so the rider's feet stay just
above the y18 trough floor.

**S&D.** Site A is the Krusty Krab dining floor (x 20–31, z 42–53, floor y14),
site B the Chum Bucket deck inside the ring (x 96–107, z 42–53, floor y17).
Both have three entrances.

**Power-ups.** Six pads in point-twin pairs: four road junctions at the lot
mouths and two on the school deck.

**TTT traps.** Grillbrand (Krusty Krab kitchen, one use: ground fire in the
dining room), Flutwelle (lifeguard hut: floods the lagoon beach for 8 s) and
Quallenstich (Treedome drum: electrifies Jellyfish Fields for 10 s). See the
trap table in `docs/development.md`.

## Materials

Ten new destructible blocks, ids 86–95 on atlas slots 84–93, all with
procedural 16 × 16 painters, HP, hardness, blast resistance, mining cost,
footstep and dig groups and impact tints:

| Block | Use |
|---|---|
| `BB_SAND` | seafloor (no grid darkening) |
| `BB_CORAL` | reef boundary, Coral Pinnacle, coral trees |
| `BB_PINEAPPLE` | the Pineapple shell |
| `BB_PINE_LEAF` | pineapple crown (cutout) |
| `BB_KELP` | kelp stalks (cutout) |
| `BB_MOAI` | Moai House |
| `BB_ROCK` | Rock Home, boulders |
| `BB_HULL` | boat hulls, Wreck Cove |
| `BB_CHUM` | Chum Bucket (blast 140: rockets and frags breach it) |
| `BB_ROAD` | Conch Street and Jellyfish Trail (lane dashes are voxel paint) |

Glass and leaves chain-collapse when the block beneath them dies; this is used
on purpose on the Treedome drum. The Chum Lab periscope tile is the one
intentional glass floor.

## Client-only presentation

- **Atmosphere** (`map-atmosphere.js`): a sunlit shallow sea, a teal gradient
  sky with pink "sky flower" clouds, fog density 0.0062 (under the 0.007
  bot-fairness cap) and no skybox.
- **Details** (`public/js/engine/bikini-bottom-details.js`, about 20 draw
  calls): sky flowers, bubble columns, a jellyfish swarm, fish schools, god
  rays, road caustics, a sea-surface sheet, set-piece glows (lamp, lab screen,
  neon ring, dome and flume sheen) and a horizon ring of reef mesas, swaying
  giant kelp, a tiki/barrel/anchor skyline and boat-car traffic. Nothing
  collides; anything that sits on a voxel re-checks `getBlock` and hides when
  that voxel is destroyed.
- **Signs** (`map-signs.js`): THE KRUSTY KRAB, CHUM BUCKET, BOATING SCHOOL and
  GOO LAGOON.

## Files

- `shared/world/flatmap-bikini-bottom.js`: core generator (`generateBikiniBottomInto`).
- `shared/world/setpiece-bikini-bottom-{conch,krab,school,chum,south}.js`: the five regions.
- `shared/world/bikini-bottom-data.js`: flume path and power-up pads.
- `shared/world/metadata.js`, `templates.js`, `traps.js`, `shared/modes.js`,
  `shared/lobby-limits.js`, `shared/powerup-sites.js`,
  `shared/map-capture-shots.js`: registration.
- Menu preview: `public/assets/maps/bikini-bottom.webp` (hero capture, see `public/assets/maps/SOURCES.md`).
- Design record: `docs/design/bikini-bottom/`.

## Validation

- `node tools/bikini-bottom-test.mjs`: serialization round-trip, material
  registration, region discipline and symmetry, walkability (1-voxel steps) to
  every landmark, spawn and site cell, dry spawns and sites, Goo Lagoon water,
  spawn-bound expansion, power-up pads, sightline limits and a full flume ride
  with the real server and prediction physics.
- `node tools/bikini-bottom-lobby-test.mjs`: live admission and first tick in
  all seven modes.
- `node tools/atlastest.mjs`: the byte fingerprint, spawn counts, compatibility
  and signage contract.
- `node tools/ttt-traps-test.mjs`, `node tools/powerup-test.mjs`,
  `node tools/large-map-navigation-test.mjs`, `node tools/chaos-cash-test.mjs`.
- `npm run maps:capture -- --map bikini_bottom`: fixed cameras for the hero
  view, Conch Street, both sites, the Boating School, the flume, Treedome and
  Goo Lagoon.

The walking graph checks connectivity; it is not a substitute for competitive
multiplayer balance testing.
