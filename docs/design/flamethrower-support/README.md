# Flamethrower support feedback

The F-4 reaches 32 m (previously 28), with a 16-degree visual cone (previously
12) and 0.047 m/m packet-radius growth (previously 0.035). Its 5-to-28 m damage
falloff, direct damage and afterburn damage are unchanged from the working
balance at the start of this task. One contact now forces 100% panic throughout
the remaining burn. Panic sway also applies while moving, through the existing
visible and transmitted aim direction.

## Reference and choice

`current-game.png` is the actual training HUD before changing the burn shader.
The built-in ImageGen tool generated `variant-a.png` and `variant-b.png` using
that screenshot. Their complete prompts are saved in `prompts.json`.

Variant B was selected for its voxel-like fire border, red/orange layers,
embers and open aiming area. The implementation uses a bounded procedural
shader rather than a full-screen image asset. Compared with the reference,
it has broader flowing shapes and softer heat haze. Fire covers the sides
and bottom; the center remains usable with a mild warm veil. HUD panels and
the 100% panic meter stay readable above the effect.

## Browser comparison

- `implemented-desktop.png`: 1280 x 720, original HUD layout and full panic.
- `implemented-mobile-landscape.png`: 844 x 390 with touch controls, the same effect bounds adapt to the viewport.
- `implemented-mobile-portrait.png`: 390 x 844 with touch controls, central aiming space remains open.

The captures are presentation fixtures in the real training client. Their
HP, burn duration and panic come from a hit calculated by the production
server FlameSystem. That snapshot is held during capture, rather than claiming
a human multiplayer playtest. Independent tests cover server flight, contact,
cover and team controls, snapshots, local prediction and cleanup.

`npm run flamethrower:browser` also checks WebGL compilation, render success,
stream continuity at 30/60/120 FPS, shader-off visibility, reduced-motion freeze
and disappearance after extinguishing. Browser errors fail the test.

Reduced motion disables heat displacement and freezes flames/embers. Disabling
decorative grading retains the gameplay visibility penalty. The runtime still
uses the authoritative/predicted burn duration and fades the effect during its
last half-second; no presentation-only status is added to production.

## Validation

Passed: `npm run flamethrower:test`, `npm run conditions:test`,
`npm run balance:test`, handling/aim tests, refactor tests, all three browser
scripts in `flamethrower:browser`, and the complete `npm test` run.

The first full run stopped at a large-lobby frame-arrival assertion
(`tools/large-lobby-test.mjs:79`, zero map frames observed where two were expected).
That test passed in isolation with both the original flame rules and the new
rules. The complete rerun passed; the initial failure is recorded as an
intermittent test result, without attributing a cause to this change.

Final logs: `.artifacts/flamethrower-tests.log`,
`.artifacts/conditions-browser.log`, `.artifacts/flamethrower-render.log`,
`.artifacts/flamethrower-browser.log`, and
`.artifacts/flamethrower-full-test-retry.log`.
