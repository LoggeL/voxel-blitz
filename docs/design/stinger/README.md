# AX-9 Stinger

The selected ImageGen direction is [field cassette](concept-a-field-cassette.png). The [alternate shrouded pod](concept-b-shrouded-pod.png) is retained for comparison. [Concept prompts](prompts.md) and [texture prompts](texture-prompts.md) record the built-in ImageGen requests.

The runtime model uses a complete removable launch canister, two hinged metal clamps, a fixed receiver and battery, layered olive panels, a rubber shoulder pad and a compact seeker. The five seeker lamps read the current lock progress; firing, an empty tube, reload and weapon switching clear ready feedback. Reload releases the clamps, lifts the spent tube, introduces a replacement, seats it and closes the clamps. The support hand follows the canister's position and rotation.

Generated olive paint, brushed steel and rubber are used as actual runtime material maps. Original PNGs are in `textures/`; JPEG delivery copies are in `public/assets/weapons/textures/stinger/`. Surface grain and wear come from those maps; seams, bevels and clamps remain modeled geometry. Textures are shared per page, while materials remain isolated per gun.

Damage, lock rules, ammo capacity and the 3.4-second reload remain unchanged. The server retains launch authority. The existing acquisition and lock audio is reused.

## Verification

`npm run stinger:test` covers whole-canister movement, fixed receiver, material isolation, frame-supplied lock and ammo, rejected and accepted launches through WeaponState, reload cancellation, switching, and equal-time animation at 30/60/120 FPS. It also checks that the heat sleeve travels with the canister and no generic bolt glow floats in the empty receiver.

`npm run stinger:browser` renders 21 real browser captures: desktop 1600 × 800, landscape 844 × 390, portrait 390 × 844 and three inspection angles. It checks actual decoded texture maps, lock/empty states, clamp phases, insertion clearance and browser errors. [Browser report](browser-report.json).

Also checked: reload-state, reload-animation, reload-presentation, viewmodel-arms, weapon-swap, weapon-aim, conquest-vehicle-locks, client-refactor and module preload consistency. This is local runtime validation, not a production deployment or physical-device test.

## Images

[Original model](before/stinger-held.png) · [Runtime model](inspection/stinger-hero.png) · [Held](desktop/stinger-held.png) · [Lock ready](desktop/stinger-lock-ready.png) · [Reload](desktop/stinger-reload-load.png) · [Mobile](mobile/stinger-held.png)
