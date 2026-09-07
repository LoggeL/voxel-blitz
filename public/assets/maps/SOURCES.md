# Map preview sources

The eight active map previews are direct captures of the playable voxel maps.
Seven were refreshed on 2026-09-07 after the expanded structures and props pass;
Dust 2 was added on 2026-09-08. They use the same world
generation, lighting, sky and landmark signs as gameplay. No generated scenery,
external assets, compositing or retouching is included in these previews.

| Map | Active file | Source capture |
| --- | --- | --- |
| foundry | `foundry-concept.webp` | `.artifacts/map-rich-pass/foundry-furnace-yard.png` |
| depot | `depot-concept.webp` | `.artifacts/map-rich-pass/depot-freight-truck.png` |
| citadel | `citadel-concept.webp` | `.artifacts/map-rich-pass/citadel-market-tower.png` |
| solstice | `solstice-concept.webp` | `.artifacts/map-rich-pass/solstice-solar-receiver.png` |
| caldera | `caldera-concept.webp` | `.artifacts/map-rich-pass/caldera-reactor-deck.png` |
| nuketown | `nuketown.webp` | `.artifacts/map-rich-pass/nuketown-hero.png` |
| dust2 | `dust2.webp` | `.artifacts/map-renders/dust2-b-site.png` |
| killhouse | `killhouse-range.webp` | `.artifacts/map-rich-pass/killhouse-control-yard.png` |

Capture command:

```sh
node tools/render-map-scenes.mjs --all --width 1200 --height 650 --out-dir .artifacts/map-rich-pass
node tools/render-map-scenes.mjs --map dust2
```

PNGs were converted locally with `cwebp -q 88`. Existing filenames are retained
so the map picker, lobby and training card continue to use the same asset paths.
The `-concept` suffix on several active filenames is historical; their contents
are now production captures.

`killhouse-concept.webp` is retained as an earlier design reference and is not
the active training preview.
