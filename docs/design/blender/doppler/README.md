# SP-2 DOPPLER Blender asset

The `doppler` slot (`docs/weapon-design/doppler.md`). The first weapon built on
the baked-atlas pipeline in `tools/blender/lib/`: a mid-poly script-authored
study, layered Cycles surfaces, and one base colour / normal / ORM atlas that
the browser draws with a single opaque material.

| | |
|---|---|
| Concepts | [profile](../../doppler/concepts/concept-a-profile-reference.jpg), [three-quarter](../../doppler/concepts/concept-b-threequarter-reference.jpg), prompts beside them (gpt-image-2.5-flare through the Codex image helper) |
| Source | [doppler.blend](doppler.blend), authored by `tools/blender/doppler/geometry.py` |
| Proof renders | [hero](render-hero.png), [side](render-side.png), [left](render-left.png), [rear](render-rear.png), [first person](render-fp.png) |
| Runtime | `public/assets/blender/doppler.{gltf,bin}`, `doppler-world.{gltf,bin}`, `textures/doppler/*.webp` |
| Reports | [build-report.json](build-report.json), [export-report.json](export-report.json) |

## Reproduce

Blender 5.2 LTS, Python 3 with Pillow, `cwebp` and Node.js, from the repository root:

```sh
tools/blender/doppler/rebuild.sh            # decals, study, bake, runtime export
tools/blender/doppler/rebuild.sh --fast     # AABB packing and few samples, for shape work
blender --background --factory-startup docs/design/blender/doppler/doppler.blend \
  --python tools/blender/doppler/render-doppler.py      # studio proof renders
node tools/render-gun-views.mjs --weapon doppler        # the runtime bundle under game daylight
node tools/render-hud-icon.mjs --weapon doppler
node tools/doppler-test.mjs
node tools/doppler-live-smoke.mjs                       # muted CDP: fire, aim, reload in a real match
```

`tools/blender/doppler/preview.py` renders untextured clay views in seconds.

## What is different from the older studies

The earlier weapons sample one tiling ImageGen scan per material through
planar UVs, ship scalar metal and roughness, and draw one primitive per
material and part (18 to 26 draws).

1. **Hard-surface kit** (`tools/blender/lib/hardsurface.py`). Everything is
   authored in game gun space. Plates are filleted 2D outlines with holes,
   extruded and chamfered; round parts are lathed profiles; grips, pads and the
   magazine are lofted superellipse sections. Chamfers are real geometry with
   weighted normals, so the model carries its own rounded silhouette.
2. **Layered surfaces** (`tools/blender/lib/pbr_bake.py`). Each source material
   is a coating over a base metal: tonal mottle, cavity grime from ambient
   occlusion, edge wear found with the bevel node (pointiness paints whole
   faces on mid-poly plates), scratches and smudges from three ImageGen masks
   (`docs/design/doppler/textures/`), and markings projected in gun space from
   PIL-drawn masks (`docs/design/doppler/decals/`, `make-decals.py`). All
   projections use object coordinates, so nothing depends on the UV layout.
3. **One atlas.** Every opaque part is joined, smart-projected, weighted by a
   per-part texel factor (the chassis walls that carry the markings get 2×)
   and packed once. Base colour, tangent normal, roughness, metal and
   occlusion are baked and packed into three 2048 px WebP maps.
4. **Runtime writer** (`tools/blender/lib/runtime_gltf.py`). One node per rig
   part, one primitive per material, identity transforms, and the authoring
   contract in `asset.extras.contract`. `engine/blender-assets.js` keeps the
   baked maps page-owned and hands the contract out through `blenderContract`.

Albedo and metalness are tuned against the game's daylight (hemisphere 0.78,
sun 1.35, environment 0.45), which `tools/render-gun-views.mjs` reproduces. A
physically pure metal reads near black there, so coatings stay mostly
dielectric.

## Parts and contract

| Node | Role |
|---|---|
| `body` | carrier chassis, lower, grip, stock, rail, backup sights, guide rod, port glass |
| `unit` | recoiling receiver, barrel, gas block, rod brackets, brake, cable runs |
| `bolt` | carrier and left charging handle (rides the unit and the rig's bolt stroke) |
| `trigger` | blade, pivoted at (0, -0.038, -0.130) by the wrapper |
| `mag` | smoke magazine body and ribs, floor plate, latch, feed lips |
| `rounds` | one cartridge; the wrapper instances it from `roundMatrices` |
| `follower` | orange follower, moved along `followerPath` |
| `pulley` | both cable sheaves, turned about the `pulley` marker |
| `spring` | buffer spring, scaled from the `spring` marker |
| `factory-optic` | prism sight; hidden when a replacement optic is fitted |

| Contract | Game coordinates |
|---|---|
| Muzzle | (0, 0.050, -0.660) |
| Sight line | y = 0.142, reticle at z = -0.180 |
| Grip / support markers | (0.045, 0.015, -0.090) / (-0.050, -0.020, -0.410) |
| Unit travel | 0.016 m toward the shooter |
| Sheave axle | (0, 0.050, -0.028) |
| Spring stop | (0, 0.012, -0.352), free length 0.104 m |
| Magazine | 30 rounds, canted 9° with the floor toward -x |

The smoke magazine, the port glass and the lenses are three blended materials
without depth writes; they are not in the atlas.

## World model

`doppler-world.gltf` is the same atlas on a reduced mesh for remote players
(`buildGun(id, cache, { lod: 'world' })` from `avatar/avatar-weapon.js`). The
export drops parts that cannot be seen at arm's length and beyond (screws,
pins, the buffer spring, rail lugs, sheave webs, inlays) and collapses the
rest. The first-person rig, the ARMORY viewer and the HUD icon use the full
model.
