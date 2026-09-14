# GRENADES — build report

One Blender study holding all five Voxel Blitz throwables. The roster, ids and
every timing stay exactly as `shared/grenade-rules.js` defines them; this task
only replaces the procedural three.js bodies with authored geometry.

Looks follow the shop illustrations in `public/assets/grenades/hud`
(`public/assets/grenades/SOURCES.md`): M-4 FRAG as a dark faceted steel body
with bronze rib bands and an amber fuse cap, the CLAYMORE/LIMPET as a copper
disc on four footed pads with an orange rim and a red sensor lens, PULSE SHOCK
as a cyan faceted core inside a dark three-meridian cage, M-18 SMOKE as a satin
steel canister with a pale band, and the molotov as a labelled bottle of petrol
with a rag plug and a hanging wick.

## Delivered files

- `grenades.blend` — editable source, textures packed, own scene
  (`GRENADES | Voxel Blitz throwables study`).
- `grenades.glb` — portable model with embedded colour maps.
- `public/assets/blender/grenades.gltf` + `.bin` — game delivery; the five
  types are five separate nodes, textures are the shared delivered JPEGs.
- `manifest.json` — parts, triangles, materials, anchors, budgets.
- `validation.json` — independent re-import audit of the delivery.
- `render-<type>-{hero,front,rear}.png` and `render-lineup.png` — Cycles stills.

## Built geometry

109 modelled source objects, batched into 23 glTF primitives (one per type and
material), 7662 triangles in total — inside the 4k–24k budget for a five-model
study and 23 of the 32 allowed primitives.

| type    | source parts | triangles | primitives (material groups)                                  |
|---------|--------------|-----------|---------------------------------------------------------------|
| frag    | 36           | 2164      | grenade steel, bronze, fuse cap, hardware                      |
| limpet  | 17           | 1164      | copper, grenade steel, hardware, orange rim, rubber, sensor lens |
| pulse   | 25           | 2148      | grenade steel, hardware, pulse core                            |
| molotov | 12           | 1046      | glass, fuel, label, rag, grenade steel                         |
| smoke   | 19           | 1140      | smoke shell, smoke band, grenade steel, hardware, fuse cap     |

Fifteen materials over the six delivered ImageGen scans — no new texture files.
Tints and UV scales carry the look; the four glow parts (fuse cap, sensor lens,
orange rim, pulse core) carry a plain emissive colour that the exporter writes
as glTF `emissiveFactor`, and the bottle glass is the one blended material.

## Frozen frame

Every type is authored in the frame the first-person held model already used,
so nothing in flight, bounce, sticking or the hand pose moved:

- metres, y up, body centred on the origin;
- fuze block on top with the safety lever on +x and the pin lug at the
  procedural pin socket `(-0.024, 0.088, 0.019)` (frag, pulse, smoke);
- limpet faces +z with its magnetic feet on the wall plane `z = -0.041` and the
  sensor lens looking down the laser, which is what `_poseMine`'s look-at wants;
- the bottle stands on the origin plane with its wick tip at
  `(-0.037, 0.303, 0)`, where the runtime hangs the wick flame.

## Runtime use

`public/js/engine/blender-assets.js` loads `grenades` with the rest of the
library. Both consumers take the authored node and keep their procedural
builder as the fallback when the template did not load:

- `public/js/guns/throwable-hands.js` mounts the node verbatim in the held
  frame (fuze, lever and the pin ring anchor included).
- `public/js/weapons/projectiles.js` scales it to the footprint of the
  procedural prop it replaces (`AUTHORED_WORLD_SCALE`: frag 1.9, limpet 2.2,
  pulse 2.0, molotov 1.5, smoke 1.85), because the thrown props have always
  read a little larger than life so they stay visible mid-flight. The fuse
  indicators stay runtime-owned: the frag and smoke fuse-cap material clone is
  the strobe, the claymore keeps its lit lens box and laser, the pulse keeps an
  additive back-side aura around the cage, and the bottle keeps its wick flame
  on the authored anchor.

## Verification

`validate-grenades.py` re-imports the GLB into an empty factory scene and
checks the five nodes, identity transforms, per-type footprints, the pin lug,
lever reach and fuze top, the claymore wall plane and sensor, the wick tip, the
triangle and primitive budgets, then reads the runtime glTF as JSON to confirm
the same five nodes, the shared texture URIs, the glow/glass extras and the
`.bin` length. Result: `validation.json`, `"passed": true`, no advisories.

Browser: `node tools/blender-assets-browser-test.mjs` (five authored nodes,
held-frame bounds, and every thrown prop built from the authored body at world
scale) and `node tools/throwable-browser-test.mjs` (hold, cues, live molotov,
`.artifacts/<type>-prepare.png`). The integration test also writes
`.artifacts/blender-integration/grenades-world.png`, the in-world line-up of all
five thrown props.

## Rebuild

    blender --background --factory-startup --python tools/blender/grenades/build-grenades.py
    blender --background --factory-startup --python tools/blender/grenades/export-game-assets.py
    blender --background --factory-startup --python tools/blender/grenades/validate-grenades.py
    blender --background --factory-startup docs/design/blender/grenades/grenades.blend \
        --python tools/blender/grenades/render-grenades.py
    node tools/blender-assets-browser-test.mjs
