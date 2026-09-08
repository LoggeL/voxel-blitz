# Dust 2

Dust 2 recreates the CS:GO remaster's measured layout in Voxel Blitz's
128 x 96 x 40 voxel world. Select **Dust 2** in a custom lobby for Fun, Chaos Lab,
Team Deathmatch, Search and Destroy or Gun Game.

## Geometry reference and scale

The reconstruction uses `de_dust2_custom.vmf` and its matching NAV from the
`de_dust2_new` directory in the collection linked by 3kliksphilip's
[Editable Official CS:GO Maps](https://www.youtube.com/watch?v=pw8yiiIlJRU).
The archive dates the VMF to 8 May 2018. This is the 2017 CS:GO remaster,
not a claim to reproduce the current CS2 revision. The VMF was decompiled with
BSPSource and prepared by a community mapper; it is not a Valve-published
editable source release. The source has 9,292 solid definitions and its matching
NAV describes 1,120 navigation areas.

Original coordinates use one uniform scale of 48 Source units per voxel on all
three axes. The transform is:

```text
worldX = 64 + (sourceX + 212.5) / 48
worldZ = 48 - (sourceY - 975) / 48
worldY = 15 + sourceZ / 48
```

Floor voxels use `round(worldY) - 1`. The measured walkable footprint spans about
84 x 90 voxels, leaving room for surrounding buildings within the existing world.
This preserves the map's proportions. Integer voxels quantize slopes, arches and
angles. Static models use voxel proxies at their original positions and angles,
with eight purpose-made voxel materials. Their small details and dimensions are
approximations; the original model meshes and artwork are not included.

## Routes and elevation

T spawn is a raised southern terrace with routes down toward the tunnel court,
top mid and outside Long. The central road descends beside the higher catwalk.
The catwalk bends toward Short, whose staircase climbs again before reaching A.
Mid Doors open onto the low CT side. The CT route passes beneath Short beside
the A platform, then climbs toward Long. Long's broad ascent to A and its recessed
pit retain separate levels.

Upper Tunnels lead to B through the narrow site entrance. A separate turning
staircase descends into Lower Tunnels and lower mid. B has an asymmetric courtyard,
rear platform, stacked cover, doors and a separate raised window connecting to
the CT approach.

Representative architectural levels measured from the matching NAV are shown
below. These are Source elevations before voxel rounding; uneven floors and
ramps span additional intermediate values.

| Area | Source Z | World walking height before rounding |
| --- | ---: | ---: |
| Pit bottom | about -204 | 10.75 |
| CT spawn / lower mid | about -128 | 12.33 |
| Lower Tunnels | about -112 | 12.67 |
| Top mid / catwalk / Long | about 0 | 15 |
| Upper Tunnels | about 32 | 15.67 |
| Short | about 96 | 17 |
| A platform | about 128 | 17.67 |
| Rear T terrace | about 128 to 164 | 17.67 to 18.42 |

All authoritative terrain and cover are generated through
`shared/world/flatmap-dust2.js` and serialized by the existing server protocol.
Painted signs depend on their supporting wall voxels and disappear when those
blocks break. Gameplay spawns and objective anchors use the corresponding
walkable levels, including inside covered passages.

## Visual references and captures

[Valve's remaster comparison](https://www.counter-strike.net/dust2/) provides the
A/CT crossing, Short staircase, mid/catwalk, upper tunnel and B-site views.
[Dave Johnston's making-of](https://www.johnsto.co.uk/design/making-dust2/)
documents the original ramps, B platform and window, half-circular tunnel stairs
and the purpose of arches and roads. The modern geometry and matching NAV remain
the dimensional reference; older screenshots provide context for shared features.

Eight capture views cover the full footprint, Long and pit, the mid/catwalk
height difference, T terrace, upper tunnel, lower tunnel stairs, A above CT and
B's asymmetric courtyard/window. The two site views also show S&D markers.
Several positions derive from the spectator cameras included in the source archive.

Validation commands:

```sh
npm run maps:test
node tools/atlastest.mjs
npm run powerups:test
npm run maps:browser
npm run maps:capture -- --map dust2
```

## Rebuilding the geometry

The checked-in `shared/world/dust2-reference-data.js` is a compact deterministic
run-length encoding. No downloads, Python or external services are needed to play.
For authoring, extract the referenced VMF and run:

```sh
python3 -m venv .artifacts/dust2-python
.artifacts/dust2-python/bin/pip install numpy
.artifacts/dust2-python/bin/python tools/compile-dust2-reference.py path/to/de_dust2_custom.vmf
```

The compiler requires the source SHA-256
`5e692292eb59b5ad73e3036bfa074527acf4dab6157d50b822efbac5415090a1`.
It imports 9,234 world/detail brushes, their displaced surfaces and 471 positioned
voxel props. Runtime generation restores the matching NAV floor clearance and
removes disconnected fragments created by voxel rounding. Walking steps apply
only to adjacent reference terrain levels, on both client and server; crates
and other maps retain their usual collision behavior.

`node tools/dust2-movement-test.mjs` additionally checks actual ramp ascents,
low-ceiling rejection and ordinary-collision behavior.
