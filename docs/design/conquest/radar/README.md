# Flag radar HUD

Three gpt-image-2 alternatives (medium, 1536x1024) from the current Conquest HUD and the radar
rules (docs/conquest.md "Flag radars"); prompts beside each reference.

- `radar-a-reference.jpg`: a top-right chip for the swept side (ENEMY RADAR D / SWEEP IN 6 S with a
  draining orange bar), the enemy radar's ring and sweep wedge on the minimap, a RADAR D hexagon
  marker over the dome. **Chosen**: it adds one small panel only while it matters (a hull inside an
  enemy ring) and reuses the map and marker language.
- `radar-b-reference.jpg`: the owner's full map with the cyan 240 m ring, the dashed 400 m air ring
  and the sweep. Taken for the maps (both sides' rings, owner colour).
- `radar-c-reference.jpg`: a red RADAR · SWEPT / SPOTTED 5 S state. Taken as the chip's second state.

Implementation: `public/js/ui/conquest/map-events/radar.js`, `public/styles/conquest-radar.css`,
fixtures in `public/js/capture/radar-hud-fixtures.js`. Muted CDP captures
(`node tools/conquest-hud-capture.mjs --only radar-sweep,radar-swept,radar-map,radar-down --sizes desktop,portrait`)
are in `captures/`.

Against the reference: the chip matches A (orange left rule, glyph, two lines, draining bar) but sits
under the career badge and network meter at the top right (desktop) and under the vehicle card on
phones; the glyph is a radar scope instead of A's dish (the dish did not read at the 11 px map badge
size). The minimap ring and wedge read as in A; on the full map the 240 m rings take about a third of
the map's width, so the fill is kept faint. The snapshot never banners an ONLINE radar to a joiner.
