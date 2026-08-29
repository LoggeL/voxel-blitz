# Map preview sources

All previews use the same production map pipeline as the game. The source
captures were rendered without players, weapons, networking, or HUD via
`npm run maps:capture`, then passed to OpenAI's built-in image generation tool
as strict geometry references. No external source assets were used.

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

All generated PNGs were converted locally to WebP at quality 82 with metadata
removed. The original generated files remain in the Codex image output folder.
