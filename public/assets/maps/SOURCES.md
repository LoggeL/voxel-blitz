# Map preview sources

The active map previews are direct captures of the playable voxel maps.
Seven were refreshed on 2026-09-07 after the expanded structures and props pass;
Dust 2 was added on 2026-09-08; Causeway and the re-rendered Reactor 9 on 2026-09-22. They use the same world
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
| dust2 | `dust2.webp` | `.artifacts/map-renders/dust2-hero.png` |
| killhouse | `killhouse-range.webp` | `.artifacts/map-rich-pass/killhouse-control-yard.png` |
| minecraft_b5 | `minecraft-b5.webp` | `.artifacts/map-renders/minecraft_b5-hero.png` (2026-09-14, `node tools/render-map-scenes.mjs --map minecraft_b5`) |
| waterworld | `waterworld.webp` | `.artifacts/map-renders/waterworld-hero.png` (2026-09-15, `node tools/render-map-scenes.mjs --map waterworld`) |
| reactor | `reactor-preview.webp` | `.artifacts/map-renders/reactor-hero.png` (2026-09-22, `node tools/render-map-scenes.mjs --map reactor`; re-rendered after the staged Bastion layout, objective pads and route strips) |
| causeway | `causeway.webp` | `.artifacts/map-renders/causeway-hero.png` (2026-09-22, `node tools/render-map-scenes.mjs --map causeway`; low shot west along the corridor from the east gate after the rock faces were skinned in stone strata) |
| bikini_bottom | `bikini-bottom.webp` | `.artifacts/map-renders/bikini_bottom-hero.png` (2026-09-22, `node tools/render-map-scenes.mjs --map bikini_bottom`; `cwebp -q 82 -metadata none`) |

Capture command:

```sh
node tools/render-map-scenes.mjs --all --width 1200 --height 650 --out-dir .artifacts/map-rich-pass
node tools/render-map-scenes.mjs --map dust2
```

PNGs were converted locally with `cwebp -q 88`. Harbor, Canyon and the Reactor 9
preview were converted the same way on 2026-09-14 (1.6 MB PNG each became about
240 KB WebP); every active preview is now WebP. Existing basenames are retained
so the map picker, lobby and training card continue to use the same asset paths.
The `-concept` suffix on several active filenames is historical; their contents
are now production captures.

`killhouse-concept.webp` is retained as an earlier design reference and is not
the active training preview.

Minecraft B5 is compiled from the original `ttt_minecraft_b5.bsp` (see
`docs/maps/minecraft-b5.md`) and Waterworld from the original
`ttt_waterworld.bsp` (see `docs/maps/waterworld.md`); their previews are
in-game captures like the others.
