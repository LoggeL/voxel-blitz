# GL-3 SKIPJACK redesign

The selected direction is `concept-industrial.png`: orange armor, gunmetal
mechanisms, a vented muzzle cage, an exposed feed ring and glowing amber shell
bands. The reactor and demolition concepts were also generated for comparison.
All three use the actual baseline browser screenshot as their reference.

`concept-prompts.json` records the full prompts and the selected direction.
The references were generated with the built-in ImageGen tool. They are visual
design references; the browser captures show the implemented game model.

The runtime model adds authored Three.js geometry to the existing Blender
mechanical parts. The original cassette, charging pawl, grip and optic keep
their gameplay anchors. Shell bands belong to the actual round groups, so
remaining rounds and reload presentation follow the current ammo state.

The launcher fires at 115 rpm, launches at 32 m/s, uses a 1.8-second fuse, and
retains more speed when bouncing. Its direct-hit damage cap, self-damage
reduction, chamber/cassette behavior and Chaos upgrades remain in the shared
and server-owned rules. The client uses those launch and flight contracts.

The presentation adds an amber shell wake, directional ricochet sparks,
a short bright blast flash, a pressure ring and a deeper mechanical launch
report. The projectile wake uses bounded buffers and is released with the
projectile.

The firing animation has a quick pawl stroke, a feed index and a short settling
beat. Reloads include hinge overshoot, cassette seating and a charging stroke
when the chamber is empty. The support hand follows the cassette without
allocating temporary target arrays every frame. Focused tests compare the
same pose at 30, 60 and 120 fps, verify settling between full-rate shots, and
check reload contacts and cancellation.

Run `npm run skipjack:test` for gameplay, ammo and animation checks. Run
`npm run skipjack:browser` for the browser review captures and runtime checks.

Baseline captures are in `before-desktop/` and `before-mobile/`.
Final captures are in `after-desktop/` (1280 x 720), `after-mobile/`
(390 x 844) and `after-landscape/` (844 x 390). The browser validation report
is `browser-validation.json`.
