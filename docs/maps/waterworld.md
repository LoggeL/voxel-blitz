# Waterworld

Waterworld is a block-for-block replica of `ttt_waterworld`, the Garry's Mod
Trouble in Terrorist Town map set in Leith Waterworld, the leisure pool in
Leith, Edinburgh (Steam Workshop item 157420728, map version 4 of 19 July
2014). Select **Waterworld** in a custom lobby for Fun, TTT, 1v1, Chaos Lab,
Team Deathmatch or Gun Game. It has no bomb sites, so Search and Destroy is
not offered.

## Geometry reference and scale

The reconstruction reads `ttt_waterworld.bsp` (VBSP version 20, 32,936,888
bytes, SHA-256
`4d496725ab6e4bc5ac7a21f0539de12f567c604399d244e803b748ae0dedfc97`),
downloaded on 2026-09-15 as `ttt_waterworld.bsp.bz2` (SHA-256
`5b4b040c590e642fc8cdf4f651ac6e8c0adc647faf3abd890cb76e922111b3e4`) from the
community FastDL mirror <https://ctbs.dev/files/gmod/ttt/fastdl/maps/>. The
mirror used for Minecraft B5 (`fastdl.friendlyplayers.com`) does not carry
the map. The BSP is an offline authoring input and is not committed;
`tools/compile-waterworld-reference.py` regenerates
`shared/world/waterworld-data.js` from it in about ten seconds with plain
Python.

Unlike Minecraft B5 the map is ordinary Source architecture: 1860 world
brushes, two thirds of them not axis-aligned (the flume tubes), plus 4 to 20
unit walls, floors, railings and stair treads. The compiler samples every
brush at 32 Source units per voxel, the same scale as Minecraft B5, so a
player keeps its 72-unit proportions and door frames stay three voxels tall.
A cell is filled when the accumulated brush volume covers at least 45 % of it;
an axis-aligned slab thinner than a voxel snaps to the cell holding its centre
plane when it covers half of the cell's cross-section; a tilted panel claims
every cell its projection along its thin axis passes through; and a shell
brush (tilted on two axes and filling little of its own bounding box, as the
flume panels do) is pushed out to voxel thickness before sampling, which keeps
the tubes continuous. A water layer thinner than a voxel (the flume splash
lane holds twelve units over a thin floor) snaps like a slab to the cell
holding its centre plane, or to the cell above when a floor slab owns it.

The transform is:

```text
worldX = (sourceX + 3392) / 32
worldZ = (960 - sourceY) / 32
worldY = (sourceZ + 544) / 32
```

The world is 200 x 188 x 36 voxels. The hull walls (Source x -3328 to 2944,
y -3328 to 896) keep a two-voxel margin; the entrance foyer to the south and
its skybox-walled forecourt run to y = -4992. The pool deck and the foyer
floor sit at voxel y = 8 (Source z = -256), the pool surface one voxel below
the deck, the deep end five voxels under that, the cafe mezzanine at y = 19,
the flume tower platform at y = 30 and the hall roof at y = 34.

## What is reproduced

- **World brushes** become the centre's finishes: glazed blue pool tiles
  (`POOL_TILE_BLUE`), small white deck tiles (`POOL_TILE_WHITE`), beige
  ceramic floors (`POOL_FLOOR`), painted steel cladding for the hull, the roof
  and the cafe block (`POOL_PANEL`), dark steel for columns, roof trusses,
  vents, grates and railings (`METAL`), concrete, plaster, glass and the blue
  and yellow plastic flumes (`SLIDE_BLUE`, `SLIDE_YELLOW`). Floors take the
  material of their top face.
- **Water**: the three pool volumes (the wave pool with its deep lobe, the
  lazy river and the east pool) are `MC_WATER` under the deck. A beach cell
  half filled by the pool bed and half by water stays water, so the paddling
  areas keep their depth. Players swim with the shared fluid rules; bullets
  and projectiles pass through.
- **Flumes**: both tubes wind from the tower platform down to the shared
  splash lane as hollow voxel tubes, and both are rides. The compiler takes
  the 25 `trigger_push` volumes that carry riders (170 units per second; the
  lazy river and whirlpool currents push slower and are not rides), chains
  them by following each push direction to the volume whose entry face lies
  nearest, and exports every chain as a slide in `meta.slides`: an `id`
  (`west-flume`, the spiral round the tower; `east-flume`, along the south
  wall), the `speed` in voxels per second and a `path` of centreline waypoints
  from a mouth on the tower (four voxels up the tube from the first push
  volume, at the platform floor) through every push-volume centre to a point
  over the splash lane. The lane is one wide push volume shared by both
  flumes with a divider between its two channels, so there each ride keeps
  its own channel. Along every path the compiler carves a rider-sized bore
  (cells whose centre lies within 1.25 voxels of the path, two voxels tall,
  1.6 voxels at the bends) and closes the tube shell around it (a yellow
  floor and blue walls and roof wherever the voxel tube leaks), leaving the
  mouths and the lane open. At 32 units per voxel the original tubes were one
  cell wide with gaps, so the bore is what keeps a rider inside plastic.
  `shared/slide-rules.js` rides the path on both the server and the client:
  a body whose feet stand within 1.4 voxels of a segment near the rail height
  (1.1 voxels under the centreline) is on rails, accelerated along the
  segment to 1.5 times the push speed (8 voxels per second), held to the rail
  height instead of falling, steered up to half a voxel across the tube by
  the side keys, pulled back to the centreline, lying prone, ignoring jumps
  and never colliding with the tube; past the end of the last segment the
  body keeps its velocity and drops into the lane water, where swimming
  takes over. The west flume takes about 19 seconds, the east about 15. The
  two `ttt_logic_role` trigger volumes on the flumes (the original traitor
  tester: ride the flume and the beam rig on the tower shows the verdict) are
  recorded as `meta.tester.volumes`, and the rig itself is drawn from
  `meta.tester.beams`; each ride passes through its own volume.
- **Traitor room**: the room above the north-east deck keeps its layout; its
  button-operated door is an open doorway (there is no traitor-only door in
  this engine) and the always-on `trigger_teleport` inside it is a map portal
  whose arrival stands on the far west deck with the authored heading.
- **Breakable windows** along the south wall of the hall are `GLASS`.
- **Foyer**: the entrance building with its curved glass canopy and the
  concrete forecourt; the skybox brushes that close the forecourt become
  concrete walls and the sky above stays open.
- **Decoration**: 125 lockers, benches, cafe tables, vending machines,
  barrels, crates, bins and cooling tanks from the original physics and static
  prop placements are drawn as oriented boxes, and all 71 doors are drawn
  swung open against their frames, by `public/js/engine/waterworld-details.js`.
- **Spawns**: all 66 `info_player_deathmatch` entities stand on the foyer
  floor and remain the Trouble in Terrorist Town pool (`meta.spawns.ttt`).
  The other modes use generated spawns: from the standing cells reachable on
  foot from the foyer the compiler keeps every cell with a flat, dry 3 x 3
  floor, air in the 3 x 3 body space two voxels high, a third voxel of head
  room, no water beside it, no flume bore within two voxels and at least
  eight voxels from the hull, thinned to a checkerboard lattice, then spreads
  them by farthest-point sampling with height counted three times so the
  raised rooms and the tower landings are chosen next to the decks, never
  closer than nine voxels to one another. Fun, Gun Game, 1v1 and Chaos Lab
  share 24 points on the decks, the east pool side, the changing rooms, the
  mezzanine and the flume tower stairs; Team Deathmatch puts alpha's twelve
  in the foyer, its forecourt and the south end of the hall (z >= 112) and
  bravo's twelve north of z = 60 around the wave pool, cafe, tower and traitor
  room, at least 55 voxels apart.
- **Sealing**: the compiled BSP's own solid leaves (the void outside the
  sealed hull) and every air pocket unreachable from a spawn, the teleport
  arrival or the open sky become a backing course of the adjacent finish over
  bedrock, so mining a wall never opens onto an empty shell.

## What is not reproduced

- The traitor traps: the pool shutter ("Pools Closed!"), the chlorine steam
  leak, the soda machine teleport and the hot pool. Their entities start
  disabled or closed in the original and are omitted.
- The `trigger_push` currents in the lazy river and the whirlpool, the
  `func_door` traitor room door, the buttons and the weapon and ammo
  placement entities.
- The 3D skybox, the `env_steam` vents, spotlights, valves, pipe clusters,
  rocks and the exterior skybox buildings.
- Power-up pads: every candidate pad sits under the metal roof or the glass
  canopy, so the shared open-sky rule offers none. Chaos cash still floods
  the deck.
- Player-clip ramps over stairs. The visible treads voxelise into one-voxel
  steps, which are jumps in this engine.

## Provenance

- Steam Workshop: <https://steamcommunity.com/sharedfiles/filedetails/?id=157420728>
- FastDL mirror used for the compile: <https://ctbs.dev/files/gmod/ttt/fastdl/maps/ttt_waterworld.bsp.bz2>

The original map is community work; the block textures in the game are
procedural 16 px tiles painted in `public/js/engine/atlas.js`, not the map's
own texture files.

## Verification

`node tools/waterworld-test.mjs` pins the compiled data (dimensions, run
coverage, material registration, pool water and depth, the 66 original spawns
on the foyer floor, the generated pools with their counts, dry flat footing,
head room, spread, levels and team separation, connectivity from the foyer to
the deck, pools, flume tower, tester volumes, traitor room and changing rooms,
the teleport on the authority, swimming and the bot ground graph) and rides
both flumes: a body dropped into each mouth with no input passes every
segment, lies prone, stays inside the bore, passes its tester volume, never
stalls and splashes down in the lane water within 25 seconds, prediction
matches the authority tick for tick, a held jump changes nothing and steering
across the tube still ends in the lane. `node tools/waterworld-lobby-test.mjs` checks admission
and live matches in TTT, Team Deathmatch and Fun over the wire.
`npm run maps:capture -- --map waterworld` renders the hall, flumes, wave
pool, foyer and traitor room views.
