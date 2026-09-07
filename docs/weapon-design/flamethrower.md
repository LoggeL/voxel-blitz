# F-4 FIRESTORM

The model is a compact industrial torch with cream and orange pressure housing,
an octagonal vent cage, a bronze nozzle that glows with heat, and a visible blue
pilot flame. A rear-facing pressure dial moves its needle as the gun fires. One
transverse red fuel tank drops with the reload animation, with thick black hoses
connecting the housing to its manifold.

The flamethrower rewards staying close and tracking the target with a travelling
jet. It launches twenty packets per second at 30 metres per second. A 160-unit
tank supplies eight seconds of continuous fire, with five spare tanks. Empty
reloads take 2.8 seconds; tactical reloads take 2.3 seconds.

Each packet deals four direct damage within five metres, equivalent to 80 direct
DPS while every packet connects. Damage falls linearly to 1.25 per packet at the
28-metre stream reach, or 25 direct DPS. Flames have no headshot multiplier.
Flight time gives targets a chance to leave the stream at longer distances.

One graze starts a 0.75-second afterburn. Further contacts add 0.16 seconds to its
remaining duration, up to three seconds, while normal time decay continues.
Continuous contact reaches the cap after about one second. There is only one
afterburn per target and it always deals eight DPS: six total tail damage after
an isolated graze, up to 24 after a fully built burn. Repeated contacts preserve
pending burn damage and credit the most recent attacker. An attacker's death
does not cancel fire already in flight or an existing afterburn.

The burn's panic floor follows its remaining duration. A graze starts near 46%;
a full burn reaches 95%. Normal damage and low-health panic still apply. The
client predicts the same burn floor from the shared rule.

Packets stop at the first damageable body or wall. Growing collision volumes
still require an unobstructed line to an actual body surface, so the wider flame
edge cannot pull damage through cover. Spawn protection, team rules, round end,
death, and respawn retain their existing checks and cleanup behavior.

Canonical values live in `shared/combatmath.js` and `shared/flame-rules.js`.
`npm run flamethrower:test` covers damage, burn buildup, ownership, flight and
cover, snapshot prediction, continuous fuel use, and audio lifecycle.
