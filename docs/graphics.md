# Graphics pipeline

How a frame of the voxel world is lit, shaded and finished, and which knobs
each graphics tier turns. Everything that changes a shader program key is
decided at map load and never mid-match (see "Program-key rules").

## Graphics tiers

`public/js/engine/graphics-quality.js` resolves the DISPLAY → GRAPHICS QUALITY
setting (`vb-graphics-quality`, default AUTO) into a profile before every map.
AUTO is LOW on touch or ≤4 GB devices, HIGH on ≥8 GB, otherwise MEDIUM. The
GPU's real capabilities clamp the tier (no MSAA without multisampled targets,
no HDR without renderable half floats, never MSAA on touch).

| Knob | LOW | MEDIUM | HIGH | ULTRA |
|---|---|---|---|---|
| Render scale cap | 1.0 | 1.0 | 1.35 | 2.0 |
| Anti-aliasing | FXAA | MSAA 2× | MSAA 4× | MSAA 4× |
| Scene target | sRGB8 | RGBA16F | RGBA16F | RGBA16F |
| Bloom mips / eye adaptation | – | 3 / on | 5 / on | 5 / on |
| Image-based light (PMREM) | – | on | on | on |
| Anisotropy | 4 | 4 | 8 | 16 |
| Edge lip / pixel normal maps | – / – | on / – | on / on | on / on |
| Grass tufts | – | 45 % | full | full |
| Ambient particles | 250 | 600 | 1200 | 1500 |
| Dynamic sun shadows (avatars, props) | – | – | 2048 | 4096 |
| SSAO | – | – | – | on |

Always on: voxel light volume, per-map atmosphere and grade, contact blobs,
muzzle/tracer/explosion effects, backdrops, shader warm-up.

## Frame structure

1. **Scene pass** into the post target (`combat-post-process.js`). The scene
   never renders straight to the canvas: switching would change every
   material's output colour space and recompile the scene mid-fight.
2. **Post chain**: optional SSAO (ULTRA), eye adaptation (log-luminance mip
   average, brighten-only up to 1.75×), bloom (soft-knee bright pass above 1.0,
   dual-filter mips), then the composite: highlight roll-off (identity below
   0.76), FXAA or MSAA-resolved detail recovery, per-map grade, vignette,
   condition feedback (panic, pain, burning) and volumetric smoke.
3. The canvas pixel ratio equals the target ratio, so the browser does the
   only resample.

`?shader=off` keeps the target but turns grading, bloom and adaptation off.
Any post shader failure falls back to direct rendering for good
(`shader-warmup.js` `ShaderErrorMonitor` also catches silent GLSL link errors).

## Terrain

- **Textures** (`atlas.js`): procedural 16 px painters built on tile-wrapped
  value noise, uploaded as a `DataArrayTexture` (one layer per tile) so mips
  never bleed between tiles. HIGH/ULTRA add a pixel normal array derived from
  each layer's luminance. The 2D sheet remains for fluids, debris and props.
- **Mesher** (`chunks.js`): face-local UVs through a per-block hashed rotation
  (tops) or mirror (sides), 11-voxel macro tone, wall-base grime and ceiling
  soot, vertex AO, convex-edge mask (a one-texel highlight lip), emissive flag
  for glowstone and portals, perimeter facade skins and per-map tile remaps.
- **Grass tufts** (`grass-tufts.js`): ≤0.22 m crossed blades on exposed grass,
  merged per 64×64 region, lit by the voxel volume.

## Voxel light volume

`voxel-light.js` bakes one RGBA8 cell per voxel at load:

- **R sky light**: Minecraft-style flood, so roofs, tunnels and rooms darken.
  Enclosed space swaps most of the directional sky/ground hemisphere for a
  neutral bounce with a per-face cue (floors 4.2, walls 0.83, ceilings 0.62
  times the hemisphere mean); a fifth of the hemisphere always stays. Tiers
  without eye adaptation (LDR) get a static stand-in: the shader reads the
  sky level at the camera and lifts indirect light for the whole view by up
  to `LDR_VIEW_EXPOSURE` (+90 %) when the camera is deep inside, so the
  occlusion contrast within the frame is kept.
- **G sun visibility**: one sweep along sheared sun columns gives
  block-exact shadows from roofs, walls and trees (75 % strength by default).
- **B/A block light and hue**: glowstone, lava, portals and map lamps.

Block deltas rebuild a ±16-voxel region and the affected sun columns, at most
every 120 ms. Terrain, tufts, props and characters sample the same volume
(`patchVoxelLitMaterial`, `character-light.js`); the viewmodel and own body use
a camera probe. `lightVolume.sample()` is the CPU trilinear lookup.

## Atmosphere per map

`map-atmosphere.js` holds each map's mood: sky and fog colours, hemisphere and
sun colours, `sunDir` (elevation ≥ ~45°), `sunDisc`, the post `grade`,
`light.minSky` and `envIntensity`. Fog takes 60 % of the panorama's horizon
tone and always saturates before the 400 m far plane (`fog-chunk.js`).
`environment-map.js` bakes a PMREM environment from the palette once per map
for PBR weapons and props. `map-backdrop.js` adds one merged silhouette mesh
beyond the arena walls; `map-ambience.js` one point-sprite draw of dust, embers,
pollen, mist or drizzle.

## Effects

- Muzzle flashes: procedural pixel-art atlas, HDR cores that bloom.
- Tracers: camera-facing gaussian ribbons with a bright head; remote tracers
  stay pinned to the shooter's muzzle.
- Explosions (`explosion-fx.js`, `scorch-decals.js`): blasts take the
  highest-priority slot in the fixed four projectile point lights, instanced
  fireball and lingering smoke sprites, ground scorch that fades over ~20 s.
- Contact shadows (`contact-shadows.js`): one instanced draw of soft blobs under
  avatars, vehicles and pickups; HIGH/ULTRA add a camera-following sun shadow
  map for dynamic casters only (`dynamic-shadows.js`).

## Program-key rules

- The point-light count is fixed (2 muzzle + 4 projectile lights).
- Shadows, environment map, fog, MSAA, HDR, bloom, SSAO, normal maps and every
  `onBeforeCompile` cache key are chosen at map load.
- `shader-warmup.js` compiles the scene, characters and every post pass with
  the real render targets bound before the match starts (1.5 s budget).
- Runtime effects change uniforms and instance attributes only.

## Checks

- `npm run graphics:test`: tier rules, post pass structure, lighting math.
- `node tools/atlastest.mjs`: client contracts including the mesher.
- `npm run maps:capture`: renders every map shot through the live post chain;
  `capture.html?quality=low|medium|high|ultra` selects a tier.
