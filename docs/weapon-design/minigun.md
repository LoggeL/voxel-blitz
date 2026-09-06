# M-6 FURNACE

The playable weapon uses six rotating barrels and a 180-round drum at 900 RPM.
The rotor needs 0.7 seconds to reach firing speed. Each shot adds 1.8% heat.
Damage increases with heat, reaching +65% at 65% heat. The bonus plateaus there,
so short pauses can hold the sweet spot without forcing an overheat.
At 100% heat the gun locks until it cools to 30%, then needs to spin up again.
Heat survives switching weapons; a new life resets it.

The HUD marks the 65% threshold and shows the current damage bonus or cooling lock.
The server owns the thermal state and damage; the client predicts local feedback.
Remote avatars receive the same rotor and heat state through snapshots.

`npm run minigun:test` checks the thermal lifecycle and model animation.

## Visual reference

`minigun-concept.png` was generated with the built-in Image-Gen tool as a shape,
material and silhouette reference for the procedural Three.js model. Numbers and
specification labels invented in the concept image are decorative and are not
game balance values. Canonical values live in `shared/combatmath.js` and
`shared/minigun.js`. The game renders the model, not this concept image.

### Generation prompt

Use case: stylized-concept. Asset type: 3D voxel shooter weapon design reference. Design one original industrial six-barrel minigun for a browser voxel arena shooter, named M-6 FURNACE. A clean concept sheet on dark slate backdrop with a large three-quarter side view and a smaller first-person view from behind on the right. Strong readable silhouette: six clearly separated long rotating dark steel barrels, two chunky barrel clamps, compact stepped receiver rather than a giant rectangular box, exposed curved brass ammunition belt, drum magazine, rear pistol grip and a low carrying handle that leaves the crosshair clear. Existing game palette: dark gunmetal, charcoal polymer, restrained orange enamel panels and brass bullets. Low-poly chunky voxel construction, crisp solid geometry, no photorealistic microtextures. One small inset shows hot barrel surfaces glowing orange-red during overheat. Lighting reveals mechanical forms. Functional shapes that can be built with boxes and low-segment cylinders in Three.js. No characters, no decorative weapon spikes, no floating assembly pieces, no extra weapons, no watermark.
