# Conquest HUD cards and the touch VIEW face: design references and prompts

This pass closes the gap "weapon and health cards not restyled" from `../redesign/captures/comparison.md`. It restyles the game-wide `#ammo`, `#grenade-count` and `#healthbar` cards toward `../redesign/hud/gameplay-hud-reference.jpg` Alternative 2 while the Conquest HUD is up, and gives the touch VIEW button (V on a keyboard: the seat's camera views) a face that names the active view.

## References (2026-10-20, gpt-image-2 through the Codex image endpoint)

The image endpoint takes text only, so each prompt describes the current HUD as captured before this pass (`captures/before-*.jpg`): the Conquest panel colours, the minimap and squad list, the INTEGRITY health card at the bottom left, and the separate grenade Ready Card above the weapon card at the bottom right.

| Reference | Prompt | Alternatives | Chosen |
|---|---|---|---|
| `cards-desktop-reference.jpg` | `cards-desktop.prompt.txt` | A unified loadout stack · B split rail · C matched pair | **A** |
| `cards-touch-reference.jpg` | `cards-touch.prompt.txt` | A three cards with an own-blue accent, green VIEW · B joined strip, amber VIEW · C angled corners, round VIEW | **A** |

**Why A (desktop).** It is Alt 2 of the gameplay reference: weapon, grenade and health read as one block in one corner, so the eye checks one place for ammo and HP. B hides the HP number in a corner of a 4 px rail, and its grenade tab floats above the card. C keeps the health card under the minimap, which is what the old layout did, and it splits the two readouts a player checks most across the screen.

**Why A (touch).** The phone layout is fixed by the thumb zones (HP card top left, grenade and weapon cards top right, MAP / SPOT / VIEW in the left column), so only the card faces change. A keeps them as three separate cards, which is what the layout already is. B's joined strip would need the grenade and weapon cards to move together, and C's angled corners clash with the rounded HUD (the same reason the gameplay reference's Alt 3 was rejected).

## Implemented

`public/styles/conquest-cards.css`, loaded after the shared card sheets. Every rule is scoped with `body:has(> .vb-conquest-hud:not([hidden]))`, so the other modes keep their cards. The DOM and the values are unchanged; they still come from the authoritative HUD state:

| Element | Desktop (1440 × 900) | Touch | Value source |
|---|---|---|---|
| Health row | bottom right, 408 × 38: green cross, 8 px bar, "74 HP", J key badge + MEDKIT ×1 | top-left HP card with a green cross before HP | `hp` (`#healthbar[data-hp]`); medkit `remaining` and the `medkit` binding (`.vb-medkit-inventory[data-key]`, new) |
| Weapon card | above the row, 266 × 92: name and trigger tag on top, weapon art, 46 px magazine / spare magazines | unchanged layout, Conquest panel | `wid` → `WEAPONS[wid].mode` (`#ammo[data-fire-mode]`, new), `wname`, `mag`, `reserve` |
| Grenade tile | right of the weapon card, 136 × 92: G key, icon, ×2; name; pouch dots, H POUCH | unchanged compact card, Conquest panel | the self row's `grenades` and the ready type |
| Vehicle panel (seated) | stands on the health row, 408 wide | unchanged | snapshot vehicle row |
| VIEW button | – | camera glyph over the active view's name | `VehicleCamera.viewState()` → touch context `vehicleViewLabel` |

The weapon and grenade cards stand on the measured health row height: `ConquestHud` writes `--cq-health-h` on the body from its ResizeObserver, so pain, panic or armour rows push them up. `healthCardLayout` drops the minimap floor to 22 px while the row is docked right. In the tank driver's periscope view the console fills the bottom centre, so the health row moves back to the bottom left under the minimap. In phone portrait the out-of-bounds countdown starts below VIEW while VIEW shows (before this pass the two overlapped in `before-portrait-jet-oob.jpg`, the only overlap the capture run reported).

## Comparison with the references

| Capture | Reference | Matches | Differs |
|---|---|---|---|
| `captures/desktop-capturing.jpg` (before: `before-desktop-capturing.jpg`) | desktop A | one bottom-right stack; name + AUTO tag; big 30 / 5; grenade tile with G, ×2, dots, H POUCH; docked health row with cross, bar, HP and the J MEDKIT ×1 chip; minimap and squad list on the bottom edge | the weapon art is the game's grey HUD silhouette, darker than the reference's; the bar is solid green (red below 30 HP) instead of green-to-amber |
| `captures/desktop-medic-heal.jpg` | desktop A | 72 HP row, "+2.5 HP" heal tick in the open left of the row | – |
| `captures/desktop-tank-driver.jpg`, `desktop-jet.jpg` | – (seated is not in the reference) | the vehicle panel takes the weapon card's place on the health row | – |
| `captures/desktop-tank-periscope.jpg` | – | health row bottom left, clear of the periscope console | – |
| `captures/portrait-capturing.jpg`, `landscape-capturing.jpg` (before: `before-portrait-capturing.jpg`) | touch A | three charcoal cards with a blue left accent, cross on the HP card | the reference's cards are taller and its MAP / SPOT sit side by side under the minimap; the existing column layout stays |
| `captures/landscape-tank-driver.jpg`, `portrait-tank-driver.jpg`, `landscape-heli-gunner.jpg` (before: `before-landscape-tank-driver.jpg`) | touch A | VIEW with a green outline, camera glyph and HATCH / SIGHT | the reference puts VIEW in the bottom-left corner; ours stays under MAP and SPOT, clear of the move stick |
| `captures/portrait-jet-oob.jpg` (before: `before-portrait-jet-oob.jpg`) | – | the countdown sits below VIEW | this fixture's stub camera reports no view state, so the button shows the plain VIEW fallback |

## Verification

```
node tools/conquest-hud-capture.mjs --out <dir>      # wrapped in the GPU slot runner, muted CDP
node tools/conquest-hud-cards-test.mjs               # in npm run conquest:test
```

The capture run on 2026-10-20 rendered 102 states (34 fixtures × desktop 1440 × 900, portrait 390 × 844, landscape 844 × 390) with 0 overlaps and 0 page errors (`captures/capture-summary.json`; the run before this pass had 1 overlap). The fixture page now gives every seated fixture without its own camera stub the seat's default view, so the VIEW face shows in the captures.

## Gaps

- No live-match capture of the new cards: the static fixture page uses the real HUD classes and sheets, but nothing played a real Frontier match with them.
- Desktop windows narrower than about 800 px put the 408 px stack next to the squad list; no fixture covers that size.
- The trigger tag is hidden on touch (the 132 px card has no room); the tag reads the weapon table, so a weapon without `mode` shows none.
