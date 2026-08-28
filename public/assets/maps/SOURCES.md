# Map preview sources

All previews use the same production map pipeline as the game. The source
captures were rendered without players, weapons, networking, or HUD via
`npm run maps:capture`, then passed to OpenAI's built-in image generation tool
as strict geometry references. No external source assets were used.

## Foundry

- File: `foundry-concept.webp`
- Created: 2026-08-28
- Source capture: `.artifacts/map-renders/foundry-hero.png`
- Prompt intent: preserve the outdoor grass terrain, perimeter walls, industrial
  towers, central crane, forge building, cover, and daylight while refining only
  materials, natural light, ambient occlusion, and anti-aliasing.

## Depot

- File: `depot-concept.webp`
- Created: 2026-08-28
- Source capture: `.artifacts/map-renders/depot-hero.png`
- Prompt intent: preserve the open concrete yard, central crane, loading bays,
  containers, orange safety accents, perimeter walls, and daylight while refining
  only materials, natural light, ambient occlusion, and anti-aliasing.

## Citadel

- File: `citadel-concept.webp`
- Created: 2026-08-28
- Source capture: `.artifacts/map-renders/citadel-hero.png`
- Prompt intent: preserve the keep, crenellated towers, battlement bridge, gate,
  beacon, courtyard, perimeter walls, and daylight while refining only materials,
  natural light, ambient occlusion, and anti-aliasing.

All generated PNGs were converted locally to WebP at quality 82 with metadata
removed. The original generated files remain in the Codex image output folder.
