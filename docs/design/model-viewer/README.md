# Armory and skin viewer

Built on 2026-09-13. Two alternatives were generated with the built-in ImageGen tool, using current browser screenshots as visual references:

- `before-armory.png`, `before-collection.png`: the existing UI.
- `reference-inline.png`, `inline.prompt.txt`: viewer integrated beside the existing skin details and unlock requirements.
- `reference-overlay.png`, `overlay.prompt.txt`: a separate character inspection overlay.

The inline design was selected. It keeps the model, requirements and equipment action together and works for both character and weapon skins. The Armory reuses the same controls inside its existing weapon stage. The generated images serve as design references; runtime models and displayed requirements come from the game.

## Implementation

`public/js/ui/model-viewer.js` builds isolated models using `buildGun`, `makeAvatar`, the gameplay skin modules and attachment builder. Its camera orbits the visible model bounds. Instanced geometry uses the instance bounds; hidden hands, muzzle flashes, nameplates and carried character weapons do not affect framing. The controls support two-axis mouse/touch orbit, wheel/pinch zoom, keyboard input, zoom buttons, camera reset and standard/skin comparison. Standard comparison preserves the camera and attachment draft.

The collection creates the viewer lazily when open and keeps one context across model selections. Non-model categories, account changes, closing and disposal release it. A pending import cannot reopen a closed preview. The Armory reads equipped skins from the career profile and shows attachment drafts immediately. Preview controls do not issue inventory writes. WebGL loss displays a recovery message and restoration renders the current model again; an unavailable collection renderer falls back to the existing artwork.

## Validation

- `npm run career:test`: career authority/persistence, unlock gates, inventory UI, isolated material layers, audio contracts and existing assets passed.
- `node tools/weapon-customization-test.mjs`: compatible attachment configurations, client/server parity, account/profile isolation, persistence and admission authority passed.
- `npm run models:browser`: all five catalog skins and all twelve weapon models, actual skin and attachment state, locked inspection without inventory writes, mouse and keyboard orbit, touch drag, pinch and wheel zoom, reset, standard comparison, category changes, close/reopen and pending-close cleanup, and WebGL context restoration passed.
- `node tools/career-browser-test.mjs`: purchase/equip, balance and unlock checks, persistence, desktop/mobile layout, Escape/focus return and entering gameplay passed without browser errors.

Responsive checks cover 1440×900, 1280×720, 390×844 and 360×800. Captures were visually compared with the inline reference: dark panels, thin borders, a readable control strip and adjacent skin requirements were retained. At mobile widths the stage sits above the details; a scroll margin prevents the sticky header from covering the model. Compact desktop attachment rows leave more height for inspection.

Selected actual captures are `actual-collection-desktop.png`, `actual-character-desktop.png`, `actual-character-mobile.png`, `actual-armory-desktop.png`, `actual-armory-compact.png` and `actual-armory-mobile.png`. The complete browser capture set is regenerated under `.artifacts/model-viewer/`.

Browser checks use disposable local profiles and Chromium with software WebGL. Touch was exercised through Chromium's touch input emulation, not on a physical phone. No gameplay values, unlock conditions or persistence schema were changed for this viewer. No full repository test-suite or deployment claim is made by these checks.
