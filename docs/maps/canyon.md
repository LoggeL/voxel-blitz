# Canyon

Canyon is a 192 by 144 voxel arena with 16 authored spawn positions per team.
Its two objectives connect through ruined compounds, a dry river and six mesa
tunnels. The aqueduct crosses the river on open arches. Camps, roofed spawn
areas, lanterns and signs provide recognizable places along the routes while
the principal bot passages remain on the common ground plane.

The shared large-map navigation graph checks the full standing player body
along every edge and verifies ground support. Visible lookahead skips short
intermediate nodes without cutting through a corner. Bots face their waypoint
before moving; short corners cannot trigger a sprint around a nearby node.
Destruction at floor/body height invalidates the affected cells and route cache.
An unreachable destination yields a stationary waypoint instead of a direct
command through cover. See [Harbor](harbor.md) for the shared algorithm and
bounded mutation-journal details.

## Checked routes

`tools/large-map-navigation-test.mjs` checks all 32 spawn clearances and 64 routes
from those spawns to the two objective centres. Every segment must fit the
standing collision body and retain supporting floor. Interior samples cross
all six mesa tunnels, three aqueduct arches, the western ruin and its nearby
camp. They exercise traversable interiors rather than total block counts.

With combat disabled, all 31 bots in a full 32-player room reach both objectives
within 60 simulated seconds through the actual movement pipeline. Two live TDM
seeds separately check sustained fire, authoritative kills and broad engagement.
The shared tests also close/open a wall, destroy a floor tile, reject shoulder
clipping around a corner and verify that missed change-journal history triggers
a complete bounded rebuild.

The September 12 qualification used seed 12345, a fixed 20 Hz simulation and
one stationary human plus 31 bots:

| Measurement over 60 simulated seconds | Previous map/navigation | Revised map/navigation |
| --- | ---: | ---: |
| Authoritative shots | 0 | 697 |
| Authoritative kills | 0 | 26 |
| Bots reaching site A with combat disabled | 9 / 31 | 31 / 31 |
| Bots reaching site B with combat disabled | 13 / 31 | 31 / 31 |

The previous state was captured from commit
`dadd82a9f41b7d5b037a2a98973a4aeeac3fc52f`. These are combined map, perception,
steering and navigation results. The controlled objective runs have no circling
or stalled five-second windows; live-match strafing and searching remain part of
normal behavior. The tests use success thresholds rather than fixing random
combat outcomes to these exact sample counts.

```bash
node tools/large-map-navigation-test.mjs
node tools/large-maps-test.mjs
node tools/large-map-navigation-probe.mjs > navigation-metrics.json
```
