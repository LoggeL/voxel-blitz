# F-4 FIRESTORM

The model is a compact industrial torch with cream and orange pressure housing,
an octagonal vent cage, a bronze nozzle that glows with heat, and a visible blue
pilot flame. A rear-facing pressure dial moves its needle as the gun fires. One
transverse red fuel tank drops with the reload animation, with thick black hoses
connecting the housing to its manifold.

The flamethrower supports teammates by forcing burning targets into full panic
and obscuring their peripheral vision. Its travelling jet reaches 32 metres,
with a 16-degree visual cone and a packet radius that grows by 0.047 metres
per metre travelled (starting at 0.12 metres). Close tracking still rewards
damage. It launches twenty packets per second at 30 metres per second. A 160-unit
tank supplies eight seconds of continuous fire, with five spare tanks. Empty
reloads take 2.8 seconds; tactical reloads take 2.3 seconds.

Each packet has six base damage within five metres, falling linearly to two at
28 metres, remaining at two through the 32-metre stream reach. After the global
0.8 combat scale, that is 4.8 to 1.6
damage per packet, or 96 to 32 direct DPS while every packet connects.
Flames have no headshot multiplier.
Flight time gives targets a chance to leave the stream at longer distances.

One graze starts a 0.75-second afterburn. Further contacts add 0.16 seconds to its
remaining duration, up to three seconds, while normal time decay continues.
Continuous contact reaches the cap after about one second. There is only one
afterburn per target and it always deals eight base DPS (6.4 after combat scaling):
4.8 total tail damage after an isolated graze, up to 19.2 after a fully built burn.
Repeated contacts preserve pending burn damage and credit the most recent attacker. An attacker's death
does not cancel fire already in flight or an existing afterburn.

Every surviving hit immediately forces 100% panic, held until the afterburn
ends. Normal panic recovery resumes afterward. The client predicts the same
floor from the shared rule. Panic also keeps real aim sway active while moving;
stationary crouch and breath holding still damp it. This affects the shot
direction sent to the server, the weapon and the reticle together.

While burning, voxel-style flames rise along the bottom and both sides of the
view, with embers, peripheral heat distortion and a light central heat veil.
The HUD remains legible. The effect fades over the last half-second of burning,
and death, respawn and leaving a match clear it. Reduced motion freezes the
flames and removes heat motion while retaining the visibility penalty. Turning
off decorative scene grading does not disable the burning effect.

Packets stop at the first damageable body or wall. Growing collision volumes
still require an unobstructed line to an actual body surface, so the wider flame
edge cannot pull damage through cover. Spawn protection, team rules, round end,
death, and respawn retain their existing checks and cleanup behavior.

Canonical values live in `shared/combatmath.js` and `shared/flame-rules.js`.
`npm run flamethrower:test` covers damage, burn buildup, ownership, flight and
cover, snapshot prediction, continuous fuel use, and audio lifecycle.

`npm run flamethrower:browser` checks the live WebGL pass, stream continuity,
reduced motion, grading-off visibility and game/HUD captures at desktop and
mobile sizes. Design alternatives and comparison notes are in
`docs/design/flamethrower-support/`.
