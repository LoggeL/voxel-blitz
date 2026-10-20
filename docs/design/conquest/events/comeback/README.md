# Comeback call-in: designator and warning UI

Rules: docs/conquest.md "Comeback call-in". Code: `public/js/ui/conquest/map-events/comeback.js`
(presenter, READY pill, full-map designator), `public/styles/conquest-callin.css`,
`public/js/fx/map-events/comeback.js` (red smoke, visual jet).

## Alternatives (gpt-image-2, 1536x1024, prompts beside each image)

- **A, strike strip** (`comeback-a-reference.png`): a strip under the full map's header with
  CALL-IN READY, the deficit and two cards (BOMBER RUN, ARTILLERY); the red dashed bomb line
  previewed under the cursor; a CALL-IN READY · M pill top left of the HUD. **Chosen.**
- **B, side console** (`comeback-b-reference.png`): a console right of the map. Clear, but it
  widens the panel past the map on desktop and has no room on a phone.
- **C, bottom tray** (`comeback-c-reference.png`): a segmented switch replacing the legend.
  It hides the legend and puts the choice far from the header hint the player reads first.

A keeps the panel's width (the map decides it), reads top to bottom (hint, choice, map) and folds
onto phones without a new layout.

## Implementation against the reference

- The strip, cards, hint and pill follow A. The map shrinks by the strip's height so the panel
  still fits the window (desktop map 626 px at 1440x900).
- Default kind is ARTILLERY (it fits infantry on a flag, the common case); the capture shows
  BOMBER RUN picked to show the line.
- The preview paints over the flag markers (in A it sat in open ground), so a line over a
  flag stays readable: 2.4 px line, a dot per bomb, an arrow past the last bomb and an 80 % dashed
  approach from the caller's HQ side. Refused spots preview grey and the hint names why.
- Touch: the top row is full (HP, grenade, ammo), so there is no pill. The MAP button turns amber
  with a red dot for a squad leader and the READY banner drops "(M)". In phone portrait the cards
  sit under the title; in phone landscape the strip stands right of the map as a column, so the
  map keeps its height.
- INCOMING (target side) is the objective banner in the danger tone with the IMPACT IN
  countdown, the kind's glyph and the world marker "ARTILLERY · 4 S". A banner raised from the
  snapshot (a joiner mid-telegraph) names the kind too.

## Captures (muted CDP, `tools/conquest-hud-capture.mjs`)

`captures/{desktop,portrait,landscape}-callin-{ready,map,incoming}.png`, recaptured with

```
node tools/conquest-hud-capture.mjs --only callin-ready,callin-map,callin-incoming --out docs/design/conquest/events/comeback/captures
```

Fixtures: `public/js/capture/comeback-hud-fixtures.js`. No overlaps reported at any size.
