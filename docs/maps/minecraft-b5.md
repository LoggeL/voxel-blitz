# Minecraft B5

Minecraft B5 is a block-for-block replica of `ttt_minecraft_b5`, the Garry's Mod
Trouble in Terrorist Town map released on 2 September 2012. Select
**Minecraft B5** in a custom lobby for Fun, TTT, 1v1, Chaos Lab, Team Deathmatch
or Gun Game. It has no bomb sites, so Search and Destroy is not offered.

## Geometry reference and scale

The reconstruction reads `ttt_minecraft_b5.bsp` (VBSP version 20, SHA-256
`e1f8cd3fd35686e43fefab8f3c8fe8afad092bf620c9a6f6a44b93c68e31d491`), the exact
file distributed by the Steam Workshop item 159321088 and mirrored on community
FastDL servers. The map is built entirely from 32-unit cube brushes, so one
Source block is exactly one voxel. No scaling or rounding of the playable
geometry is involved. The BSP is an offline authoring input and is not
committed; `tools/compile-minecraft-b5-reference.py` regenerates
`shared/world/minecraft-b5-data.js` from it in about two seconds with plain
Python.

The transform is:

```text
worldX = 4 + (sourceX + 2688) / 32
worldZ = 4 + (1344 - sourceY) / 32
worldY = 42 + sourceZ / 32
```

The world is 128 x 96 x 88 voxels. A four-voxel sea margin surrounds the
island's occupied footprint (120 x 88 blocks). The island surface sits at
y = 42, the sea surface at y = 37, the lighthouse lamp at y = 71, the clouds at
y = 82 and the Nether between y = 1 and y = 17. Everything between the Nether
ceiling and the sea floor is unbreakable bedrock, as is the world floor.

## What is reproduced

- **World brushes** become their Minecraft material: grass, dirt, stone,
  cobblestone, mossy cobblestone, sand, gravel, clay, logs, leaves, planks,
  glass, bricks, bookshelves, white and red wool, iron, gold and diamond blocks,
  diamond and coal ore, obsidian, netherrack, glowstone, cactus, chests, the
  furnace, crafting table and TNT. A cell is filled when a brush covers at least
  half of it, so the 24-unit water surface and the 30-unit cactus keep their
  original height. Non-axis-aligned brushes are sampled at 64 points.
- **Fluids**: the ocean, the streams and the pond are `MC_WATER`; the Nether's
  lava sea and the incinerator are `MC_LAVA`. Both render through the animated
  fluid shader (swell, drifting ripples, fresnel transparency and sun glints
  for water; a glowing, slowly flowing crust for lava); the sea past the voxel
  edge uses the same material so the horizon matches the shore. Players swim in fluid voxels
  (hold jump to rise, crouch to dive, a climb near the surface lifts onto a
  bank). Lava burns 12 HP every 250 ms. Bullets and projectiles pass through
  fluids.
- **Portals**: the four always-on `trigger_teleport` volumes and their
  `point_teleport` destinations, including the original facing. Entering the
  obsidian frame on the island arrives in the Nether; the Nether frame returns
  to the island. Two more portals sit in the lighthouse basement and the
  traitor room. The purple film is the walk-through `MC_PORTAL` block.
- **Fake blocks**: `func_illusionary` volumes that fill a voxel become ghost
  blocks (`MC_GHOST_*`) that render as their material but never collide. In
  b5 every illusionary brush turned out to be sub-voxel trim (8-unit edge
  strips, torches, flowers, rails and signs), so the compiled data contains no
  ghost cell; the block types remain part of the material contract.
- **Ladders**: `MINECRAFT/LADDER` slabs become climb volumes on the wall face
  they hang from; the client draws wooden rails and rungs there.
- **Doors** are drawn swung open against the wall; the doorway is passable.
- **Decoration**: 32 torches, 17 roses, 164 rail cells, 8 minecarts and 19
  original signs are rendered by `public/js/engine/minecraft-b5-details.js`
  from the compiled prop list. The sea and sea bed continue past the voxel
  edge. Clouds are static voxels at their initial `func_tanktrain` position.
- **Spawns**: all 35 `info_player_start` entities are recorded with their own
  floor level (six in the Nether, two on the lighthouse). A spawn never
  touches fluid: its feet, body and floor cells and the eight horizontal
  neighbours at feet and floor level are clear of water and lava, so the spawn
  push cannot drop a body into the lava sea. Two Source spawns break that rule
  (one wades in the village stream at 70,15, one stands on the Nether lava
  shore at 48,27); the compile moves each to the nearest safe cell (70,18 on
  the bank and 48,28) and `server/sim/spawn.js` applies the same guard at
  runtime, so an expanded or fallback candidate in lava is skipped whenever a
  dry one exists. Free-for-all modes use a 14-spawn subset spread at least 14
  voxels apart (11 on the island, 3 in the Nether) so the shared power-up and
  Chaos cash rules keep pads away from every spawn; Team Deathmatch uses the
  eight westernmost and eight easternmost surface spawns.

The original island is a Source shell: under its grass and stone crust the
space down to the sea is empty and open along the beaches, which made the
replica look hollow from the water and through mined holes. The compiler
therefore fills every air cell above sea level and below a column's lowest
natural-terrain block (grass, dirt, stone, cobble, sand, gravel) with dirt;
piers, houses and the clouds are not terrain, so the air under them stays,
and water, beaches, caves and mines above the crust keep their shape. Sealed
pockets that no player could reach (compiled BSP void and cells unreachable
from the sky, a spawn or a portal arrival) are filled with stone or
netherrack so mining never opens onto an empty shell.

## What is not reproduced

- Traitor traps and buttons (the creeper cart, TNT, the flooding and lava
  traps, the portal trap, the barricades) and the traitor tester logic. The
  trap volumes start disabled in the original and are omitted.
- The End-stone win room above the sky, the diamond-ore teleport traps and the
  weapon and ammo placement entities.
- The 3D skybox, dynamic lights, the moving clouds and the moving carts.
- Invisible `nodraw` collision hulls (fence rails and small ledges) that have
  no visible block; the fence posts and rails themselves are sub-voxel
  decoration and are not drawn.

## Provenance

- Steam Workshop: <https://steamcommunity.com/sharedfiles/filedetails/?id=159321088>
- FastDL mirror used for the compile: <https://fastdl.friendlyplayers.com/ttt/maps/>
- Wiki: <https://trouble-in-terrorist-town.fandom.com/wiki/Minecraft_(Map)>

The original map is community work; the block textures in the game are
procedural 16 px tiles painted in `public/js/engine/atlas.js`, not the map's
own texture files.

## Verification

`node tools/minecraft-b5-test.mjs` pins the compiled data (dimensions, run
coverage, material registration, spawn footing, portal volumes, ladder faces,
swimming, lava damage, ghost passability, connectivity between the village,
lighthouse, Nether and the portals). `node tools/minecraft-b5-lobby-test.mjs`
checks admission and live matches in every offered mode over the wire.
`npm run maps:capture -- --map minecraft_b5` renders the hero, lighthouse,
portal and Nether views.
