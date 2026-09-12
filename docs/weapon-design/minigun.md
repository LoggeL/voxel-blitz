# M-6 FURNACE

The playable weapon uses six rotating barrels and a 300-round drum at 1200 RPM, with four spare drums.
Its lowered olive and graphite motor armor leaves the steel rotor exposed. Open
barrel collars, an amber index tooth, a bowed brass feed belt, and a large drum
make the rotating assembly readable. A rear-facing five-cell temperature strip
shows heat directly on the weapon.

The rotor needs 0.7 seconds to reach firing speed. Hold aim (right mouse button)
to pre-spin it while keeping the trigger released. Pre-spin consumes no rounds,
adds no heat, and cools at the normal 20 percentage points per second. Once the
rotor reaches full speed, pressing fire starts shooting immediately. Aim can
stay held during trigger pauses to keep the rotor ready.

Each shot adds 1.35% heat below the sweet spot and 0.81% once it reaches 65%.
Damage increases with heat, reaching +30% at 65% heat. The bonus plateaus there,
so short pauses can hold the sweet spot without forcing an overheat.
The slower heat gain gives roughly 2.2 seconds of continuous fire from the
sweet-spot threshold to overheat. The rotor coasts down over 1.2 seconds; a
0.2-second trigger pause needs only about 0.12 seconds to recover full speed.
At 100% heat the gun locks until it cools to 30%, then needs to spin up again.
Pre-spin respects this lock and the same reload, draw, vault, ammunition, and
round-state gates as firing.
Heat survives switching weapons; a new life resets it.

Reduced recoil and a tighter spread keep sustained bursts controllable.

The HUD marks the 65% threshold and shows the current damage bonus or cooling lock.
The server owns the thermal state and damage; the client predicts local feedback.
Remote avatars receive the same rotor and heat state through snapshots.

`npm run minigun:test` checks aim pre-spin, immediate trigger response, ammunition,
cooling, eligibility gates, the thermal lifecycle, and model animation.

## Visual reference

`minigun-concept.png` was generated with the built-in Image-Gen tool as a shape,
material and silhouette reference for the procedural Three.js model. Numbers and
specification labels invented in the concept image are decorative and are not
game balance values. Canonical values live in `shared/combatmath.js` and
`shared/minigun.js`. The game renders the model, not this concept image.

### Generation prompt

Use case: stylized-concept. Asset type: 3D voxel shooter weapon design reference. Design one original industrial six-barrel minigun for a browser voxel arena shooter, named M-6 FURNACE. A clean concept sheet on dark slate backdrop with a large three-quarter side view and a smaller first-person view from behind on the right. Strong readable silhouette: six clearly separated long rotating dark steel barrels, two chunky barrel clamps, compact stepped receiver rather than a giant rectangular box, exposed curved brass ammunition belt, drum magazine, rear pistol grip and a low carrying handle that leaves the crosshair clear. Existing game palette: dark gunmetal, charcoal polymer, restrained orange enamel panels and brass bullets. Low-poly chunky voxel construction, crisp solid geometry, no photorealistic microtextures. One small inset shows hot barrel surfaces glowing orange-red during overheat. Lighting reveals mechanical forms. Functional shapes that can be built with boxes and low-segment cylinders in Three.js. No characters, no decorative weapon spikes, no floating assembly pieces, no extra weapons, no watermark.
