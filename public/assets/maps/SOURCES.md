# Map preview sources

All previews originate from the same production map pipeline as the game. The
source captures were rendered without players, weapons, networking, or HUD via
`npm run maps:capture`. Foundry, Depot, and Citadel then used OpenAI's built-in
image generation tool with those captures as strict geometry references.
Solstice uses its final production render directly after image generation was
used only for art direction. No external source assets were used.

## Foundry

- File: `foundry-concept.webp`
- Created: 2026-08-29
- Source capture: `.artifacts/map-renders/foundry-hero.png`
- Prompt intent: use the current production capture as the strict camera and
  geometry reference; preserve the outdoor terrain, walls, crane, towers, forge,
  cover, and clouds while refining only materials, daylight, shadows, and ambient
  occlusion.

## Depot

- File: `depot-concept.webp`
- Created: 2026-08-29
- Source capture: `.artifacts/map-renders/depot-hero.png`
- Prompt intent: use the current production capture as the strict camera and
  geometry reference; preserve the open yard, gantry crane and hanging load,
  loading bays, rust-red containers, road markings, cover, walls, and clouds while
  refining only materials, daylight, shadows, and ambient occlusion.

## Citadel

- File: `citadel-concept.webp`
- Created: 2026-08-29
- Source capture: `.artifacts/map-renders/citadel-hero.png`
- Prompt intent: use the current production capture as the strict camera and
  geometry reference; preserve the brick-and-stone keep, broken crenellations,
  beacon mast, side compounds, courtyard markings, cover, walls, and clouds while
  refining only materials, daylight, shadows, and ambient occlusion.

## Solstice

- File: `solstice-concept.webp`
- Created: 2026-08-29
- Source capture: `.artifacts/map-renders/solstice-hero.png`
- Art-direction reference: Codex generated-image output (not shipped)
- Prompt intent: preserve the production heliostat, biodome, turbine hall, and
  three-lane layout while exploring a sun-bleached sandstone canyon, warm
  metal accents, solar arrays, vegetation, service details, and tighter cover.
  The generated reference guided voxel revisions; the shipped preview is a
  later capture of the resulting production geometry rather than concept art.

## Caldera

- File: `caldera-concept.webp`
- Created: 2026-09-03
- Source capture: `.artifacts/map-renders/caldera-hero.png`
- Art-direction reference: none (built directly in voxels)
- Prompt intent: none. The shipped preview is the production hero capture
  converted locally to WebP at quality 82 with metadata removed, per the
  Solstice direct-render precedent.

All generated PNGs were converted locally to WebP at quality 82 with metadata
removed. The original generated files remain in the Codex image output folder.
