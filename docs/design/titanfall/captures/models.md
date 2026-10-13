# Titan model captures (WP5)

Captured with `node tools/titanfall-model-capture.mjs` (muted headless Chromium over CDP, one
WebGL context, `.titan-capture.lock`). The page is `public/vehicle-capture.html?type=titan_*`
(`public/js/capture/titan-capture.js`): the real `VehicleView` and `titan-presentation.js` rig,
fed synthetic rows on a fixed 1/60 s clock with a seeded `Math.random`.

```
node tools/titanfall-model-capture.mjs --type titan_ion                 # every shot, WEST and EAST
node tools/titanfall-model-capture.mjs --type titan_ion --team alpha --shot sheet,hero,face
node tools/titanfall-model-capture.mjs ... --overlay js/vehicles/voxel-model/material.js=<patched copy>
node tools/titanfall-model-capture.mjs --list                           # file names only
```

Shots per team: `sheet` (ortho front, left, back + perspective 3/4 on the studio backdrop, 1 m
ruler), `hero`, `front`, `side`, `right`, `back`, `threequarter`, `face` (head and chest
close-up), `walk-strip` (8 ortho cells over one gait cycle from a left footfall), `walk-hero`,
`sprint-hero`, `dash`, `guard` (Vortex up), `core` (core bit set; RONIN draws the sword), `embark` (kneel, hatch open), `landing` (titanfall
crouch), `doom` (red optic, doom pool), `wreck`, `aim-up`, `range` (60 m), `cockpit`,
`cockpit-mobile` (720 x 1280), `embark-strip` (6 perspective cells across the embark lock).
Once per run: `lineup` (all five titans side by side with a pilot for scale; file
`lineup-<team>.png`). Stage C presentation notes are at the end of this file.

The titan palette entries (`accent`, `opticIon`, `energyBlue`, ...) are a pending request patch
to `material.js` (not a WP5 file). The `ion-*` captures use the patched palette via
`--overlay`. `fallback-palette-ion-sheet-*.png` shows what the shipped tree renders until the
patch lands: the accent band falls back to the roundel blue/orange, and the optics and cells
fall back to white `strobe`.

## ION (titan_ion), references `titan-turnaround-ion.png`, `titan-lineup-b.png`

Final: 20 draws, 6050 triangles (WEST), 6004 (EAST). Budget: 24 draws, 30 k triangles.

### Iteration 1 (`iterations/ion-sheet-alpha-i1.png`)
Differences from the turnaround:
- The head was sunk into the chest and the eye read pink. The doom eye was visible, because
  VehicleView's `firstPersonHidden` loop sets every listed mesh visible again outside the
  cockpit. The warm `head` lamp sprite also sat on the lens.
- The legs were short-thighed (thigh 1.05 / shin 1.85), with deep knee bends. The feet were 2.6 m
  planks with toes sticking out.
- A stray white stripe sat on the left thigh.
- The camo was busy: fine (0.1 m) parts sampled the camo field at doubled coordinates, so it
  flecked against the 0.2 m plates.
- The Splitter's four cells were only on the inboard face, and the right forearm hid most of
  the barrel. The gun read as a stubby black block.
- The left hand pointed forward, palm up.

Fixes:
- The head is a 1.0 m cube standing proud of the chest (6.35 to 7.3 m), with a 0.42 m socket
  and an energy-blue ring around the white-blue lens.
- `firstPersonHidden` now lists the head, hatch and arm nodes, so the rig alone toggles eye
  and eyeDoom.
- The lamps moved under the pauldrons.
- Atlas legs are 1.3 / 1.55. The feet are 2.0 m with blunt split toes.
- Parts are sealed before meshing (`sealTitanPart`): one hull-metre camo field for 0.2 m and
  fine parts, at `TITAN_CAMO_SCALE` 0.72, so blots run about 1 to 1.6 m.

### Iteration 2 (`iterations/ion-sheet-alpha-i2.png`)
Differences:
- The eye lens was white with a dark ring. The energy ring cylinder sat between 0.1 m layers
  and came out empty.
- Lamp sprites on the chest read as a second pair of eyes.
- The rifle was still covered by the forearm.

Fixes:
- The lens cylinders were moved onto the 0.1 m lattice.
- The lamps went under the pauldron corners.
- New frame value `elbowBack` (Atlas 1.2): the right elbow rides the mount pitch node 1.2 m
  behind the pivot. The hand grips the receiver, and the cells sit between the shroud and the
  hand on both faces.
- The hand gained a `twist` pose value: idle has the palm turned in, and the guard pose has
  the palm forward (fingers up).
- A cool fill light was added to the capture page so the shadowed flank reads.

### Iteration 3 (`iterations/ion-sheet-alpha-i4.png`, then final)
Differences:
- The outboard cells snapped under their housings (half-voxel boxes).
- The left arm still reached forward (upper arm is now 1.97 m).
- The thigh tops showed the dark hip frame.
- The chest hatch had no readable vision slit; three overlapping 0.05 m boxes collapsed.

Fixes:
- The cells are whole 0.1 m voxels, 0.1 m proud.
- The idle wrist is [-2.0, 2.85, -0.3], arm nearly straight.
- The thigh shell runs up to the hip, with an outer tasset.
- The hatch has a gunmetal brow lip over a glowing blue slot.
- Fixed the doom capture row: hp is the draining doom pool, not 0. It rendered as a charred
  wreck before.

### Final read against the reference
Matches:
- Box chest with a raised hatch and blue slot.
- Cube head with one big blue-white eye.
- Square two-tone pauldrons: roundel on the right, team stripe on the left.
- Chest and shin accent bands.
- Two exhaust stacks; battery hatch with a hazard checker and green cell on the back.
- Long Splitter with four cells per side.
- Gunmetal upper arms; camo forearms and fists; blocky feet with split toes.
- Glowing palm emitter.

Known gaps:
- The reference carries the rifle diagonally across the body. Ours points along the server
  mount (hull frame, right side) and only reaches the turnaround's port-arms look when aimed
  up (`ion-aim-up-*`).
- The cockpit view had no interior frame until stage C (see the end of this file).
- The camo still has small flecks from material.js's second noise octave.
- All titans share the default camo seed until assemble.js `SEEDS` gets titan entries.

## NORTHSTAR (titan_northstar), references `titan-turnaround-northstar.png`, `titan-lineup-b.png`

Final: 20 draws, 7516 triangles (WEST and EAST). Budget: 24 draws, 30 k triangles. Frame
overrides: `elbowBack` 1.3 (the hand grips the receiver, so the whole rail stays in view) and
`neck` [0, 6.6, -0.1]. The head geometry sits about 0.3 m ahead of the chest front.

### Iteration 1 (`iterations/northstar-sheet-alpha-i1.png`)
Differences from the turnaround:
- The rail clamps cut the cyan core into four segments, so the railgun read as ION's cell row.
- The head (y 6.5-7.1, as in the notes) was buried between the collar, the missile pod and
  the back pods, and its outline disappeared from the side.
- The knee plate reached up to 3.0 m and stuck forward like a second shin.
- The back pods ended at the pauldron tops and didn't stand out from behind.
- The roundel looked like a plus sign under four pauldron bolts.

Fixes:
- The core is one unbroken 3.4 m cyan line, with cooling slots on the upper rail instead.
- The neck is raised to 6.6 m. The head is 0.9 m wide, with the visor wrapping both sides,
  a brow lip, a crest ridge and ear fins.
- The knee plate is shorter. The pods rise to 7.6 m with angled gunmetal caps.
- The roundel uses r 0.42.

### Iteration 2 (`iterations/northstar-sheet-alpha-i2.png`)
Differences:
- In the side view the head still lined up with the shoulder missile pod.
- The stock was a large open bracket behind the body.

Fixes:
- The head moved forward 0.3 m, so the nose projects ahead of the chest like the turnaround.
- The stock is a tapered solid block with a thumbhole.

### Iteration 3 (`iterations/northstar-sheet-alpha-i3.png`)
Differences:
- The two lamp sprites beside the hatch slit made the chest read as a second face.
- The feet were a stair-stepped pile, with no visible raised hock.
- The pauldron bolts covered the roundel.

Fixes:
- The head lamps moved into housings on the front pelvis corners.
- The foot is a flat camo foot: a wide ball, three toes (the middle one pointed with a
  claw), a gunmetal hock post from 0.9 m down to the instep, an ankle guard and a raised
  heel spur.
- The right pauldron has no bolts.

### Iteration 4 (`iterations/northstar-sheet-alpha-i4.png`, then final)
Differences:
- The dark top caps on the knee plates read as holes.

Fix:
- They were replaced with a vertical gunmetal ridge.

### Final read against the reference
Matches:
- Tall legs with a forward knee, a back-swept shin and a raised hock over long three-toed feet.
- Exposed gunmetal strut and achilles piston behind the shin; calf thruster pods with
  cyan nozzles.
- Narrow chest tapering to the waist; chest hatch with a cyan slit and the accent band.
- Wedge head with a cyan visor.
- Square pauldrons: roundel on the right, team stripe on the left (WEST white, EAST black).
- 3 x 3 cluster-missile pod on the right pauldron.
- Two tall hover pods with cyan nozzles flanking the battery hatch.
- 5.1 m railgun: a square shroud with a glowing bore, a split rail around a continuous cyan
  core, a box scope with a cyan lens, capacitor fins and a tapered stock.
- `aim-up` gives the turnaround's diagonal carry.

Known gaps:
- The reference rests the rail muzzle-down along the right leg. Ours points along the server
  mount at hip height, the same constraint as ION.
- The left hand only hangs: Tether Trap has no guard pose (`guard: null`).
- From behind under the front-lit capture rig, the back and pods read very dark.
- `walk-strip` cells show a lamp sprite trailing behind the titan. ION's strip shows it too,
  so it comes from the strip capture, not the model.
- The cockpit view has no interior frame yet, and the titans share the default camo seed.

## LEGION (titan_legion), references `titan-turnaround-legion.png`, `titan-lineup-b.png`

Final: 22 draws, 10568 triangles (WEST), 10554 (EAST). Budget: 24 draws, 30 k triangles.
`titan-legion.js` builds on `titan-common.js` with no rig changes. Two extra nodes hang off
the recoil node: `barrels` and `shield`. The model wraps `animate` to drive them:

- **Barrel spin:** charge100 (spin-up) or a recoil kick, 26 rad/s at full spin.
- **Gun shield:** follows the rig's defensive `guard` ramp.

The sheet shot is now 2640 px wide in `titanfall-model-capture.mjs`, so a 5.8 m Ogre fits
its ortho cells. That changes the sheet framing for every titan.

Build:
- **Skeleton:** Ogre frame, with hips at x ±1.0 for the wide turnaround stance, thigh 1.15,
  shin 1.4 and ankle 0.7. The right elbow sits on the cannon axis 0.9 m behind the mount
  pivot (`elbowOut` 0, `elbowBack` 0.9).
- **Predator Cannon:** 3.5 m, from the elbow at z 0.55 to the muzzle at −2.75. Parts:
  - **Receiver:** 1.0 × 1.0 × 1.4, the `foreR` slot.
  - **Rear barrel collar:** hazard band 1.
  - **Barrels (spin node):** six barrels with steel tips and black bores, a mid clamp, and the
    muzzle clamp with hazard band 2, whose stripes show the spin.
- **Gun shield:** a 1.2 × 1.6 plate, folded on the receiver's outboard face. Gun Shield swings
  it 90° about Y in front of the gun, and the barrels pass through it like a gun port.
- **Ammo drum:** on the back right. Its belt runs over the right pauldron top, down its outer
  face and down the upper arm into the feed chute.

### Iteration 1 (`iterations/legion-sheet-alpha-i1.png`)
Differences from the turnaround:
- The sheet cells clipped the cannon and the right pauldron, because the titan is 6.2 m wide.
- `opticRed` (emissive 3.0) tone-mapped the four optics to pink.
- Two lamp glows sat on the chest cheek plates and read as a second pair of eyes.
- The muzzle face was a dark hazard disc; the barrels didn't read.
- Under the hatch, the gunmetal skirt plus the waist made a 1 m black band.

Fixes:
- Sheet width 2640.
- Optics use `lampRed`. The doom eye keeps two optics lit red and two dead (`soot`).
- The lamps moved to the outer pauldron fronts.
- The clamps moved back. The barrels stand 0.4 m clear, with steel tips and black bores.
- The skirt is a camo plate with centre vents.

### Iteration 2 (`iterations/legion-sheet-alpha-i2.png`)
Differences:
- The pauldrons sat level with the chest top (5.4–7.0), so the upper body read as one wide
  slab. In the turnaround the pauldrons rise above the chest and the head sits low between
  them.
- The abdomen was still dark.
- The drum and belt were nearly black from behind.

Fixes:
- The pauldrons are 2.0 m tall (5.2–7.2). The roundel, stripe, grille, belt and drum (top at
  7.4) moved up with them.
- Camo abdomen plates with a centre groove.

### Iteration 3 (`iterations/legion-sheet-alpha-i3.png`, then final)
Differences:
- The drum links and belt pins were the same dark as the frame.

Fixes:
- The drum rim alternates gunmetal and steel link sectors, and the belt pins are steel, so
  the chain reads in the side and back views.

### Final read against the reference
Matches:
- One-sided Gatling arm with two hazard bands, and the muzzle cluster.
- Low dome head with a 2 × 2 red optic cluster under a visor brim.
- Huge squared pauldrons: roundel on the right, stripe on the left.
- Chest hatch with the green screen slit and the accent band.
- Drum on the back right with the chain over the right shoulder.
- Battery hatch with hazard checker, green cell and handles.
- Heavy left fist; wide stepped feet; knee guards; shin accent bands.

Known gaps:
- The cannon is level at idle. The turnaround angles it down, but the server mount pivot
  (y 4.44) fixes the cannon height.
- The deployed shield is a plate in front of the gun, not an energy dome. An ability-fx dome
  can be layered on it.
- Aiming down below about −0.8 rad lifts the receiver's rear into the right pauldron.
- The upper-arm belt rides the arm's aim, so at extreme pitch it parts a little from the
  pauldron belt.
- From behind, the front-lit capture rig leaves the back and legs very dark (as on ION).
- The walk strip shows deep knee bends at walk speed. That comes from the Ogre gait
  parameters.

## SCORCH (titan_scorch), references `titan-turnaround-scorch.png`, `titan-lineup-b.png`

Final: 22 draws, 10648 triangles (WEST), 10658 (EAST). Budget: 24 draws, 30 k triangles.
The captures use the titan palette overlay plus two extra entries from the SCORCH request
(`thermite`, a non-emissive orange for the launcher band, and a deeper `opticOrange`:
0xff7418 at emissive 1.6). `fallback-palette-scorch-sheet-alpha.png` shows the shipped tree
without them: the visor and slots fall back to the warm `head` lamp, the band to hazard yellow.

Frame overrides: thigh 1.0 / shin 1.55 (the leaner Ogre legs from lineup A; the shared Ogre
1.05 / 1.62 folds the knees deeply), `elbowOut` 0.85 and `elbowBack` 1.1 (the launcher hangs
inboard of the forearm), neck [0, 6.9, -0.7] (the "head" is the visor housing in the dome
brow, pitching about its own seat), hatch hinge [0, 6.2, -1.5].

### Iteration 1 (`iterations/scorch-sheet-alpha-i1.png`)
Differences from the turnaround:
- The dome did not read as a dome. A gunmetal bezel ring round the visor, gunmetal hatch
  jambs and a frame skirt made a dark column down the whole front.
- The dome narrowed too early (an ellipse profile): only a thin cap showed above the
  pauldrons, where the reference has a full round crown.
- `opticOrange` at emissive 2.8 tone-mapped to pale salmon. The bore ember read as a lit
  screen in the launcher's mouth.
- The back carried too much gunmetal (saddle bars, lower-back plate). The tank hazard labels
  read as windows.
- The feet were as narrow as the shins.

Fixes:
- Superellipse dome profile (q 2.6, 1.9 m up and 1.5 m down from y 5.6): crown 1.27 m wide
  at 7.0 m, top layer at 7.4 m.
- The visor housing is camo, with only a 1.4 × 0.4 gunmetal rim round the slit.
- No hatch jambs. The skirt is plate at the front and gunmetal at the back.
- `opticOrange` 0xff7418 at emissive 1.6. The ember is a 0.3 m core at the back of a
  0.4 m deep dark bore.
- Short tank brackets and a gunmetal spine on the back. Gauges instead of labels.
- Feet are 1.6 m wide (0.2 m more outboard), with three toes.

### Iteration 2 (`iterations/scorch-sheet-alpha-i2.png`)
Differences:
- The left-thigh stripe was missing, and the leg shells sat 0.1 m behind their joints. Odd
  z extents on a part centred only in x round on the 0.2 m lattice, so the stripe skin
  missed the plate.
- The hatch blended into the dome.
- The idle arm hung dead straight, with the fist at 2.0 m (the reference has it near 2.8 m).
- In the guard pose the forearm pointed straight ahead, so the shield showed edge-on.

Fixes:
- Thigh and shin are centred on x and z, and the foot on x, y and z.
- The hatch base is the lighter plate, with a camo inner panel.
- Idle wrist [-2.35, 3.3, -0.55]: a bent elbow with the forearm forward. A shorter fist.
- Guard wrist [-0.3, 5.2, -2.0]: the forearm crosses the chest.

### Iteration 3 (`iterations/scorch-sheet-alpha-i3.png`, then `-i4` final)
Differences:
- From behind, the calf frame and piston covered the shin accent band.

Fix:
- The accent band goes on after the calf, so it wraps the frame and piston.

### Final read against the reference
Matches:
- A stepped round dome with no head, and the orange visor slit in a gunmetal rim under a
  plate brow.
- A camo chest hatch with an orange vision slit and side clamps. The accent band runs
  across the hatch and the dome.
- The widest squared pauldrons (5.8 m), drooping outward and two-tone, with outer fins and
  bolts. Roundel on the right pauldron, stripe on the left pauldron and left thigh.
- Two orange hip-vent grilles at 4.2 m on the front and back of the abdomen.
- Back: red fuel tanks with straps, caps and valves flanking the hazard-checker battery
  hatch, hoses into the back and pauldrons, and a red canister on the right hip.
- Left forearm heat shield with two glowing vertical slots.
- The T-203: a stubby 3 m square tube with a breech hazard ring, an orange band, a muzzle
  block with a dark 0.7 m bore and an ember, a box magazine, a carry handle and a sight pip.
- Wide stepped feet, big knee guards, accent bands that wrap the shins, pistons on thigh,
  calf, upper arm and forearm.
- At 60 m (`scorch-range-*`): the dome outline, the orange slit, the roundel and both
  accent bands.

Known gaps:
- The bore is 0.7 m, not 0.8 m. The pivot sits on a 0.1 m cell centre, so only odd widths
  centre on it.
- The launcher points along the server mount at hip height. The reference's downward hip
  carry only shows when aiming down.
- The shield plate is on the outer face, so in the guard pose it shows at an angle, not
  face-on. The Thermal Shield effect itself is the ability presentation's job.
- The camo has small dark flecks on the dome front, as on ION (material.js noise octave).

## RONIN (titan_ronin), references `titan-turnaround-ronin.png`, `titan-lineup-b.png`

Final: 24 draws, 7824 triangles (WEST), 7816 (EAST). Budget: 24 draws, 30 k triangles. The
`ronin-*` captures use the titan palette overlay plus `material-ronin.patch` (WP5 scratch
`requests/`): `opticRed` at emissive 1.6 (3.0 tone-mapped the visor to salmon pink) and `blade`
at metal 0.25 / rough 0.4 (metal 0.7 rendered the sword near-black without an env map).

Build: the shared Stryder skeleton (same legs as NORTHSTAR, the turnaround's straight legs are
ignored per README), `elbowBack` 1.1 so the fist grips the Leadwall behind the drum. Extras on
top of the 20 rig slots: `sword` (blade + a Sword Core edge-glow part, 2 draws) and the two
cloth tassets (`clothFront`, `clothBack`, 1 draw each). `makeRoninModel` wraps `animate`:
- Sword Block (`defensiveUp`, rig guard ramp) or Sword Core (`coreActive`, own 0.3 s linear
  ramp) re-parents the sword node from the back (rotated 0.42 rad, hilt over the left shoulder,
  tip at the right hip) into the left fist. The core ramp blends the left-hand idle pose into a
  low ready stance; the energy-blue edge shows only while the core is active.
- The front tasset hangs until the forward thigh reaches it (`max(thigh) − 0.3` rad), the back
  one swings back with the trailing thigh, so neither clips the legs.
- Two empty stowage clamps (left ear strap, lower-back clamp) stay on the back when drawn.

### Iteration 1 (`iterations/ronin-sheet-alpha-i1.png`)
Differences from the turnaround:
- The visor and the gun's red dot read salmon pink; the sword blade read dark grey/black.
- The fins were 1-voxel sticks with black tips; the head sat sunk between the pauldron caps.
- The chest flood lamps sat at the bottom corners of the chest and read as a second pair of eyes.
- The front tasset jutted forward at the thighs' rest angle (0.56 rad) like a red tongue.
- The front between chest and pelvis was a black band (gunmetal skirt and abdomen).
- First-pass 0.2 m boxes used half-cell values (±0.5, 0.7) that rounded asymmetrically; all
  0.2 m coordinates were moved onto their lattices before the first render.
Fixes: Ronin material patch (red, blade); fins 0.2 m thick for 7 of 10 rows with a plate leading
edge; head lifted 0.2 m on a neck with cables; lamps under the lowest lamellar slab (as ION);
front tasset rule changed; plate abdomen plates and a plate skirt with vents under the hatch.

### Iteration 2 (`iterations/ronin-sheet-alpha-i2.png`)
Differences:
- The head was still narrow (0.6) next to 1.0 m pauldron caps; the turnaround helmet is about as
  wide as the hatch, with a wide visor.
- The back view of the legs was all gunmetal (strut, piston, hock).
- The guard pose held the blade up and back over the shoulder, not across the body.
Fixes: helmet 0.8 m with 0.1 m cheek guards and a 0.6 m visor slit (collar guards narrowed);
camo calf plates either side of the calf piston with a frame band; guard pose searched for a
blade rising diagonally across the chest, edge forward (`hand -0.7, twist -0.3`).

### Iteration 3 (`iterations/ronin-sheet-alpha-i3.png`, then final)
Matches: horned helmet with a red visor slit and V mouth guard; lamellar pauldrons, roundel
right, stripe left (front, top, back); chest hatch with the blue slit and the accent band; red
front and back tassets with ragged hems; shin accent bands; digitigrade legs with pointed toe
plates and an outer claw; sword hilt (red/black wrap, square guard, brass collar) over the left
shoulder, blade across the back beside the battery hatch, green cell visible; short black
Leadwall with drum and four red bars; Sword Core blade glow (`ronin-core-*`), Sword Block
(`ronin-guard-*`).

Known gaps:
- The turnaround holds the shotgun muzzle-down at the hip; ours points along the server mount.
- The sword is in the LEFT fist (the right forearm rides the gun mount); there is no swing
  animation for sword melee yet (that belongs to the ability presentation).
- The cockpit view hides the left arm, so the drawn sword is not visible from the cockpit.
- The back views are shadowed (key light from the front), so the blade reads grey there.
- Legs are slimmer than the turnaround's (Stryder spec, 0.6 m shells on the 0.2 lattice).

## Stage C: presentation (all titans)

Shots re-captured with the stage C presentation, using the merged palette overlay (titan palette
plus the SCORCH and RONIN request entries): `lineup`, `cockpit`, `cockpit-mobile`, `embark`,
`embark-strip`, `landing`, `doom`, `guard`, `core`, `dash`, `back`, for every titan and both teams.

### Lineup (`lineup-*.png`, reference `titan-lineup-b.png`)
Iteration 1 (`iterations/lineup-alpha-i1.png`) had the order mirrored, because a lineup facing the
camera puts +X on the left. The camera was also too far back, so the titans filled a third of the
frame. Final: ION, SCORCH, NORTHSTAR, RONIN and LEGION left to right, 6.6 m apart, with a pilot in
front of NORTHSTAR. This matches the reference composition. The silhouettes read as in the
reference: ION is square with its rifle across the hips, SCORCH a wide ogre with the launcher,
NORTHSTAR tall with the shoulder pod, RONIN slim with antennae and a tabard, and LEGION a wide
ogre with the gun shield. The pilot reaches about knee to thigh height, as in the reference.
Remaining difference: the reference titans are tan with orange; ours use the team camo.

### Cockpit (`*-cockpit-*.png`, design `hud-titan.png` option 2)
Iteration 1 (`iterations/cockpit-ion-alpha-i1.png`) set the frame 0.95 m from the eye. That was
too heavy: thick struts, big lamp bars in front of the camera and MFDs below the view. Final: the
frame sits 1.2 m out with 5 cm struts. It has a top beam, chamfered corner struts, pillars with
amber strips, a sill, hood plates in the upper corners, and a console with two tilted MFDs in
bezels plus a small caution panel. The centre stays clear for the HUD reticle. On phone portrait
(`cockpit-mobile`), the top beam, the sill and the console centre show, and the pillars fall
outside the view. The overlay is in the hull frame (pinned to the model group), so the torso
sway does not move it against the camera. The HUD content is WP6.

### Embark (`*-embark-strip-*.png`, `*-embark-*.png`)
The pilot proxy, a real avatar in the team colours, runs in from 4 m ahead of the left hand. It
hops onto the palm while the hand reaches down, which happens at 30 % of the lock. It rides the
palm up to the hatch mouth (30–72 %), climbs into the hatch and drops into the seat. It hides at
97 %, as the server's lock ends. Iteration 1 (`iterations/embark-strip-ion-alpha-i1.png`) showed
stale proxies from an earlier shot, because the capture page never ran the presentation `frame`.
It also used a side camera that cut off the run-in. The page now steps `frame` like the match,
and the strip uses a front-left camera.

### Effects
- `landing`: the titanfall slam (dust ring, debris, grit, shake) on the dropping-to-landed edge,
  with the rig's fist-down hero crouch.
- `doom`: fire on the shoulder spark points and the back cook-off point, plus dark smoke from the
  neck. The rig's `fire` emitters sit inside the torso for the wreck, and in iteration 1 the fire
  burned unseen inside the armour.
- `guard` and `core`: ability FX (`titan-ability-fx.js`). The ION Vortex dome and laser core
  beam, the SCORCH thermal wall with flames, the RONIN parry cap and the LEGION gun shield. Each
  core also gets an energy aura, and the NORTHSTAR core adds the muzzle glow. NORTHSTAR's hover
  thrusters need the hover bit, which these poses do not set, so no capture shows them. Iteration
  1 drew the SCORCH fire wall with additive blending, and it read acid green over the grass; it
  now uses normal blending with an orange core.
- `back`: the battery glow (the VehicleFx light sprite `battery`). It is off while `batteryOut`
  is set, and the empty socket sparks instead.


## Art-director round (all titans)

Fixes from the art-director findings, compared over three render rounds (`iterations/*-ad1..3.png`,
then the finals in this folder for both teams). The captures use the palette overlay from the
pending `material.js` request (titan palette plus the new `stripeEdge` and `bladeEdge` entries).
Without the overlay, the `fallback-palette-*-sheet-*.png` sheets show the fallback colours.
Budgets (budget test, WEST): ION 20 draws / 5784 tris, SCORCH 22 / 11220, NORTHSTAR 20 / 7552,
RONIN 24 / 7920, LEGION 22 / 10888. All are within 24 draws and 30k tris.

### Shared (titan-common, presentation, cockpit)
- Every titan gets a 0.4 m chest accent band and its hatch strip, plus the team stripe on the
  left pauldron, now framed by a contrasting `stripeEdge` border. In round 1 the alpha stripe
  and roundel ring merged into one pale panel. The roundel is a 1.0 m disc in a 0.15 m ring. The
  flood lamps and red tail lamps use the `lamp()` bezel helper. `plateEdges` dark edges are on
  the thighs and pauldrons, `hipDrive` actuators on the pelvis, and a `cockpitCavity` behind each
  hatch, so the open hatch shows a seat pocket.
- Gait: the swing time follows the stride length (`stride`/`reach` per frame). The walk strips
  show strides of about 3 m with no foot sliding. Stance drift is 0.0000 m.
- Low-ready carry: the weapon dips after a quiet spell, and the left hand reaches the fore-grip
  (ION and NORTHSTAR). A shot snaps it up (`raise(true)`). The muzzles stay on the server mount
  pose, so tracers never come from the lowered barrel.
- Embark (`*-embark-strip-*`): in round 2 the palm rose to a fixed 5 m hull height while the
  titan knelt 1.5 m. The pilot stood on the titan's head, then dropped through the hatch roof
  (`iterations/ronin-embark-strip-alpha-ad2.png`). The lift now tracks the cockpit point on the
  kneeling torso: the palm stops level with the cockpit floor, about 1.3 m in front of the open
  hatch, and the pilot steps across into the seat. In round 1 the torso bow flipped past 60 %
  because `smooth()` was unclamped; it is clamped now.
- Doom (`*-doom-strip-*`): in round 2 the strip showed almost no fire
  (`iterations/ion-doom-strip-alpha-ad2.png`). There were two causes. The capture page steps
  many frames between renders, and the particle field uploads only the last flush's slots, so
  the page now re-uploads every slot before each render (capture only; the match renders every
  frame). Also, the flame points sat inside the taller pauldrons. Each flame is now lifted onto
  its own part's armour top (a one-time ray cast down onto that slot's meshes). The final strip
  shows 1.2–2 m orange flames on both pauldrons plus black smoke, building from 0.5 s.
- Cockpit (`*-cockpit*`): in round 1 the frame was near-black. Round 2 added unlit bevel
  highlight bars on the struts, seams and bolt rows, plus a faint amber fill on the frame. On
  phone portrait, the MFDs scale to 0.68 about the console (`cockpit-mobile`, which cut them off
  in round 1).
- `aim-up` holds the weapon raised (aim input). `hover` and `hover-back` (NORTHSTAR) frame the
  hull 3 m up. The hover plumes had been emitted from the first thruster only (one particle a
  frame), and now go round-robin over all thrusters, as do the Flight Core cones.

### ION
The splitter rifle has 4 × 0.3 m cells with gunmetal dividers. The knee guard sits on a
gunmetal bracket. The eye has a gunmetal ring, the lens and a core. The fore-grip carry is
{pitch −0.35, yaw 0.3}. Round 1 read: the strides were good, but the stripe plus ring made a
pale slab (fixed). Final: the stripe frames cleanly on both teams.

### SCORCH
The pauldrons are rebuilt as 1.2 m boxes on a gunmetal yoke. The fuel tanks are 1.6 m with
straps, filler rings and valves. The stripe border is at −2.8…−2.0. The carry is {pitch −0.45,
yaw 0.25}. Final: the tanks clear the pauldron tops in the side view, and the launcher reads
orange.

### NORTHSTAR
The legs are longer (hip 4.4, thigh 1.8, shin 1.95). The pelvis is 1.6 m wide and raised, and
the chest prism is narrowed to ±0.8. The railgun has a continuous cyan core, and the scope lens
is cyan at the rear. The carry is {pitch −0.6, yaw 0.3, fore-grip}. Final: a tall, narrow
silhouette, and the plumes show in `hover-back`.

### RONIN
The legs are 0.4 m longer (hip 4.2, thigh 1.45, shin 2.1), and the pelvis and tasset pivots are
raised to match. The cloth tassets are 0.4 m deep, with 3-step ragged hems and a darker
`clothDark` trim, and hang flared 10° out. The sword is stowed 0.3 m higher and 0.15 rad steeper,
so the hilt rises clear behind the left pauldron. The blade has a 0.1 m bright `bladeEdge` along
one edge. The carry is {pitch −0.35, yaw 0.25}. Final: in the walk strip the front tasset swings
with the leading thigh, and the back one trails.

### LEGION
The Gun Shield rests on the inboard face of the receiver and swings in front with `guard`. The
Predator cannon is 4 m long: six P.gun barrels on a 0.5 m ring, with black bores and steel lips.
The hazard bands have a 0.6 m period. The carry is rotation-only {pitch −0.25, yaw 0.2}. Final:
the barrel cluster reads at range, and `aim-up` lifts it clear of the shield.

## Art-director round 2 (all titans)

Fixes from the second art-director pass (values, gait, silhouettes, markings, ability FX,
cockpit), compared over three render rounds per titan (`iterations/*-ad2r1..3.png`, then the
finals in this folder for both teams). The captures use the palette overlay from the pending
`material-titan-r3.patch` (WP5 scratch `requests/`, it supersedes `material-titan-r2.patch`),
and the capture page now lights the scene with the frontier IBL (`env=0` turns it off,
`swatch=1` adds four value cubes for colour checks).

### Values and colour (blocker)
- The diagnosis: a plain 0x687341 cube renders about (80, 80, 21) under the capture's warm
  sun, so the dark read came from the palette and the missing environment light, not from the
  vehicle shader. The r3 palette lifts the titan coats (WEST titanBody 0x7a8650 ground with
  0x56703c / 0x6b5a3a / 0x34422a blots, EAST 0xc9a066 sand), and makes `titanFrame` a mid
  gunmetal 0x68717b (rough 0.65, metal 0.1), so joints no longer read as holes. Camo blots are
  sampled at 0.36 of hull metres (0.28 was too uniform).
- Team accent: no glow any more (WEST 0x4a8cc8, EAST 0xc8501e). SCORCH optic and thermite
  are 0xffa23a. The EAST stripe drops its pale edge on front faces (`stripeRim` = sand ground
  coat) and keeps it on top faces.

### Gait and stance (shared rig)
- The atlas/ogre frames are wider (hips 0.9 / 1.05 m) with shorter, quicker strides, so the
  walk is no longer a crouch-waddle. The budget test now checks the straight-walk pelvis
  excursion stays ≤ 0.3 m (ION 0.175, SCORCH 0.173, NORTHSTAR 0.232, RONIN 0.224, LEGION
  0.175 m), and RONIN's idle knee flex stays under 12° (10.4°).
- Titanfall landing: a three-point superhero pose. The left fist goes to the ground, the right
  knee drops to 0.4 m, the torso pitches 22° with the head up, and the pose holds 0.4 s and
  then releases over 0.5 s.
- Doom: the torso tilts 6° to the damaged side, the optics flicker (on about 70 % of the time,
  8 Hz), and two joints throw spark bursts every 0.4 s. The flames are 0.7 m puffs in the
  TITAN_FLAME gradient (core 0xffc060, body 0xff6a1a, tip 0x8a1a08). Soot comes from
  vehicle-view's HP char (about 0.46 at doom HP). The 0.35 cap is a request
  (`vehicle-view-doom-soot.patch`).
- Hover: the capture holds NORTHSTAR 4 m up. The hanging legs sweep back 10°, two cyan cone
  plumes (2.5 m, 0.5 m at the nozzle) burn from the back pods, and a 4 m dust ring rolls out
  under them.
- Dash: the torso leans 15° into the dash. Two 1.8 m thruster streaks fire from the back/hip
  nozzles (cyan on RONIN and NORTHSTAR, white-orange on the heavier frames), and RONIN leaves a
  0.25 s afterimage at about 30 %.
- Embark: the pilot runs to a spot outboard of the left leg and rides the palm up. It then
  steps 1.3 m in front of the cavity and drops into the seat, and is hidden at 92.5 %. The
  capture tool reports pilot-versus-leg overlaps (`embark clips`). The wider legs of this round
  put the old palm spot (hip + 1.3 m) inside the shin box at 11-47 % on every titan, so the palm
  and the pilot's ready spot now sit at hip + 1.95 m. All ten embark strips report
  `clips none`.

### Ability FX (`titan-ability-fx.js`)
- No translucent spheres remain. The ION Laser Core beam has a 0.3 m white core in a 1.2 m cyan
  sheath, dims along its length, and strobes for 0.15 s as it lights. The chest, impact,
  Legion/Northstar core muzzle and railgun charge glows are camera-facing additive flares
  (radius 0.8 m, no rim).
- LEGION Gun Shield: a curved 3.0 × 2.4 m hex panel 1.4 m ahead of the muzzle, facing the aim.
  It has a team tint at 0.35 opacity, a bright 0.08 m edge and a fresnel rim. The RONIN Sword
  Block field is the same panel (2.4 × 2.8 m), faint cyan with no hex cells.
- SCORCH Flame Core: the ring and the three fire lines burn as normal-blended fire sheets (the
  Thermal Shield's shader). Additive orange puffs over grass read lemon-green
  (`iterations/scorch-core-bravo-ad2r1/r2`). Embers and a few puffs sit on top, lifted 0.6 m,
  over dark ground scorch decals (a ring and a strip under each line). The Thermal Shield wall
  fades out at its base, ends in the dark-red tip colour, and leaves a scorch arc.

### Cockpit (`cockpit-overlay.js`)
- A 3 % blue-grey canopy tint with a soft vignette over the outer 0.15 of the width. Two thin
  struts at ±0.35 of the viewport width. Three stepped dash panels: the raised side panels
  carry switch rows, and the centre has two small amber status bars. Each titan has its own
  MFD accent bezel (ION blue, SCORCH orange, NORTHSTAR teal, RONIN violet-blue, LEGION
  yellow-green).
- Phone portrait: the frame is pulled in about the eye so the pillars sit at 92 % of the
  visible half-width, with the diagonals in view. It is also stretched 1.25× in height, so the
  top bar stays within about 10 % of the screen. The MFDs follow the stretch and keep their
  0.68 scale. Landscape renders unchanged.

### Final read per titan (`*-hero-*`, `*-sheet-*`, `lineup-*`)
- ION (`ion-hero-*`, `ion-core-*`, `ion-landing-*`): mid-value green and sand coats with a
  readable gunmetal frame. The left hand carries at the rifle's fore-grip, and the cyan rifle
  cells and chest optic are the brightest marks. Knee guards and the wider stance make the legs
  read as armour rather than pipes. The Laser Core beam is a white core in a cyan sheath with
  no sphere at the chest.
- SCORCH (`scorch-hero-*`, `scorch-core-*`): the widest frame (thighs ±0.6, shins ±0.8). The
  rebuilt launcher has a square breech with a hazard diagonal, a round barrel, a thermite band
  and a muzzle shroud, and it is carried 0.5 rad across the body. From the hero angle the
  forearm still hides part of the barrel. Flame Core now burns as orange fire sheets over
  dark scorch decals, not lemon-green puffs.
- NORTHSTAR (`northstar-hero-*`, `northstar-hover-*`): the slimmest silhouette, with a
  one-handed rail gun, rebuilt digitigrade legs and back pods. The roundel sits on the outer
  pauldron face. The hover holds 4 m up with legs swept back, two cyan cone plumes, and the
  dust ring.
- RONIN (`ronin-hero-*`, `ronin-sheet-*`): straighter legs (idle knee 10.4°), lamellar
  pauldrons, a belt with a brass buckle, and a front tabard. The roundel is on the left
  pauldron, the stripe crosses the right pauldron cap, and the lamps sit on the cheeks. The
  4.4 m sword is stowed on the back with its tip beside the left leg, so it reads in the front
  view.
- LEGION (`legion-hero-*`, `legion-guard-*`): wide pauldrons (x 1.3..2.5) with hazard collars
  and diagonals, the drum gun carried low and level, and a team-tinted hex Gun Shield 1.4 m
  ahead of the muzzle. The drum-hub roundel shows only from the right and back; the pauldron
  hides it in hero views.

## Ability events (stage D, `captures/abilities/*.png`)

`node tools/titanfall-model-capture.mjs --abilities [--shot name,...] [--at s]` renders the 19
shots of `public/js/capture/titan-ability-capture.js` through `vehicle-capture.html?ability=<shot>`
(muted CDP, capture lock, one Chromium). Each shot stages the titan at the origin facing −Z, an
enemy titan where the ability needs one, and feeds server-shaped events (the `emitAbility` /
`pushAbilityShoot` fields, `at`/`until` on the engine clock) through the real
`titan-presentation.onEvent` and `VehicleFx.handleEvent`, with row bits for guards and cores.
`terrain` shots add 1 m and 2 m steps and a 4 m wall (`abilityBlock` joins the page's
`getBlock`) so the ground lines climb, drop and stop as the server's `stepLines` does. The
node half of the check is the budget test's stage D: a real `GameEngine` titanfall match whose
rows and events feed the client, with every line, mine, pod, guard sphere and Laser Core end
held to the server's numbers.

| Shot | Reads as | Notes |
|---|---|---|
| `ion-tripwire` | three lensed mines, a thin cyan laser fence with a pulse running along it | mines from the event `mines`, fence at 0.95 m |
| `ion-tripwire-trigger` | three blue-white blasts, thin shock rings, soft ragged burns left on the ground | burns fade over 8 s (cap 12) |
| `ion-laser-shot` | a thick cyan ray from the chest anchor (`event.o`) to the hull, hit flare | `vehicle-fx` draws impacts only, no gun tracer |
| `ion-vortex` | the dish on the server catch sphere with the caught rounds orbiting in it | rounds caught from the enemy's hitscan paths that end on the sphere |
| `ion-vortex-throw` | 12 amber rays converging from the sphere front on the target | rounds released from the dish |
| `ion-laser-core` | beam from the chest anchor to the target hull at the client `anchorAim` point | the capture aims the gun from its pivot, like a pilot's crosshair |
| `scorch-thermal-shield` | a two-sheet fire wall on the front of the guard sphere, smoke veil | sheet height sized so the flames pass the sphere centre |
| `scorch-incendiary` / `scorch-trap-ignite` | canister with an amber trigger ring; ignite = fireball plus fire bursts over the 6 m radius | the lingering fire is the server's molotov cells |
| `scorch-firewall` | fire sheet over a burning strip climbing the 1 m and 2 m steps | stops where the server line stops |
| `scorch-flame-core` | three fanned fire lines over the steps, the stage-C ring at the feet | the static stand-in lines stand down once events arrive |
| `ronin-arc-wave` | a cyan ground blade with bolts at its head reaching the ION | trail fades behind the head |
| `ronin-phase-dash` | upright RONIN at the new spot, phase ghost at the old one | rig `teleport()`: feet follow the blink |
| `ronin-melee` | left-arm punch with a cyan slash, struck flash on the target | starts on the `titanMelee` shoot |
| `ronin-execution`, `-rip` | the punch into the doomed hull (a wreck at once, as on the server), then the rip: fire, sparks, flash | |
| `legion-gun-shield` | the hex cap on the server sphere 1.4 m ahead of the muzzle | |
| `legion-power-shot` | nine orange rays from the arm anchor converging on the hull | close mode, 4° spread |
| `northstar-tether` | two pods with trigger rings; the sprung one holds a crackling cable and snare arcs on the ION for the root time | cable outlives `deployableEnd` until the root ends |

Open: the particle fire (blasts, trap ignite) is the shared particle field's fire, which still
reads yellow over bright grass; the Thermal Shield sheet keeps the stage-C fire shader.

## In-game art pass (live matches, `captures/ingame/*.png`)

The earlier rounds judged the titans on the studio page. This pass judged them in real
titanfall matches: a local server on a free port with bots that cycle all five titan types, a
muted CDP session (`tools/lib/cdp-session.mjs`, capture lock, one Chromium) and a free camera
hooked into the post chain that follows a titan item, checks the line of sight against the
world blocks, and hides the HUD and viewmodel. A staging mode injects lineups of all five per
team, team pairs at 10/30/80 m and a walker circling at walk speed into `VehicleView.sync` on an
open, flat spot. That staging needs room, so it ran on frontier and canyon; harbor has too few
open spots. Maps: harbor (auto, ultra), canyon (auto, low), frontier (auto, sunset).
Viewports: 1600×900, plus 844×390 for mobile landscape. File names: `before-*` are the
baseline pass, everything else is after the fixes, `studio-*` are the capture page after the
fixes.

### Iteration 1: baseline (`before-*`)

- **Frame material read as pale sky-blue in daylight.** `titanFrame` (0x68717b) picked up
  the harbor and canyon sky fill. Joints, guns and armour gaps went light blue-grey, and the
  titans read as toys with no dark frame between the camo plates (`before-harbor-*-hero-*`).
  Frontier's warm sunset hid the problem.
- **SCORCH's T-203 was hidden behind the forearm** from pilot eye height in front and
  three-quarter views (`before-harbor-scorch-hero-bravo`). The confirmed known item.
- **LEGION's drum roundel showed only from the back** (`before-harbor-legion-hero-bravo`),
  the other confirmed known item.
- **ION's energy cells** (`energyBlue` 0x3a8cff) tone-mapped to pale lavender, so the class
  colour was lost (`before-harbor-ion-hero-alpha`).
- **Chase camera** (`before-harbor-chase-fire`): at 9 m back and 3 m up the frame shows mostly
  pauldron tops and the back. See Open below.
- Read correctly: team colours at 10 and 30 m (alpha green/blue, bravo tan/orange), foot
  planting (below), cockpit framing and impacts, doom (sparks and smoke) and the wreck (crumpled
  hull, embers).

### Fixes

- `titan-common.js` `TITAN_PALETTE`: `frame` and `gun` both use `interior`, the dark
  gunmetal. Frame joints, gaps and guns now read as dark mechanism between the camo plates
  on every map and tier. `energyBlue` now uses `opticIon` (strobe fallback), which keeps its
  cyan through the tone mapper. The `titanFrame` and `energyBlue` entries in `material.js` are
  no longer used by titans.
- `titan-scorch.js`: the right forearm is now a gauntlet slung under the launcher axis, and
  the hand is a fist on a side grip under the barrel (the gun gets a grip lug). The launcher
  now sits above the arm, so the drum, thermite band (widened) and a new hot orange muzzle lip
  read from the front and three-quarter views. 22 draws, 11,340 tris.
- `titan-legion.js`: the drum hub gets a hazard ring cap with a frame boss. The team roundel
  moves to the front of the left pauldron, and the stripe decal goes on the right pauldron
  front. On the right pauldron (front and outer face, both tried in game) the Predator barrel
  cluster covers the roundel from pilot eye height. The left pauldron is clear from every
  front angle. 22 draws, 10,160 tris.

### Iteration 2: after the fixes (`frontier-*`, `canyon-*`, `harbor-ultra-*`, `mobile-*`, `studio-*`)

- Frame and guns read dark on harbor (ultra), canyon (low and auto) and frontier, so the camo
  plates stand off a mechanical skeleton (`harbor-ultra-*-hero-*`, `canyon-low-teams-10m`).
- SCORCH: launcher, drum and orange muzzle lip are visible in front and three-quarter hero
  views on both teams (`frontier-scorch-hero-*`, `studio-scorch-hero-alpha`).
- LEGION: the roundel shows on the left pauldron from the front and three-quarter views, and
  the hazard hub cap marks the drum from the side (`frontier-legion-hero-*`,
  `studio-legion-sheet-bravo`).
- ION cells read cyan in daylight (`canyon-low-teams-10m`, `harbor-ultra-ion-hero-alpha`).
- Teams: 10 m and 30 m read clearly. At 80 m the titans are a few pixels tall, but canyon fog
  and the frontier sunset still keep the team hue (`frontier-teams-*`, `canyon-low-teams-*`).
- Scale: next to a pilot (`mobile-harbor-pilot-at-feet`, `studio-lineup-*`) the titans stand
  roughly four pilot heights tall. That matches `titan-lineup-b.png`.
- Feet: the stage walker on frontier slid 0.012/0.006 m over 241 frames, and on canyon low
  0.12/0.08 m, with gap 0 throughout. Bots walking on canyon slid ≤ 0.14 m with gap 0. Large
  per-frame "slides" in the fleet probe are a dash skid (by design in `_fixed`), a teleport or
  NORTHSTAR hover. One harbor-ultra SCORCH sample reported a −0.28/−0.90 m gap while its row
  was dooming, and one sample is not enough to say more.
- Cockpit and chase while firing, plus doom and wreck, read on all three maps
  (`*-cockpit-fire`, `*-chase-fire`, `*-doom-*`, `*-wreck-*`). At 844×390 the cockpit view
  stays readable through the canopy, but the HUD cards cover about the lower 40 %
  (`mobile-harbor-cockpit-fire`).
- Budget: `node tools/titanfall-model-budget-test.mjs` passes 496 checks (ION 20d/5,814t,
  SCORCH 22d/11,340t, NORTHSTAR 20d/7,188t, RONIN 24d/7,704t, LEGION 22d/10,160t).

### Open (not in the titan model files)

- Chase camera (`shared/vehicle-handling/titan.js` `camera: { distance: 9, height: 3 }`):
  the titan fills the frame top-down and its silhouette is lost. About 12–13 m back and
  4.5–5 m up would show the whole titan and its gun.
- `material.js`: the `titanFrame` and `energyBlue` entries are now unused by titans and could
  be retuned or dropped (a frame of about 0x4a5056, roughness 0.8, if it should differ from
  `interior`). Alpha camo reads lime in desert light (canyon), so a slightly less saturated
  alpha olive would help.
- Mobile 844×390 cockpit: the HUD cards cover much of the canopy (WP6 layout).
- The studio sheets in this folder (`*-sheet-*`, `*-hero-*`, `lineup-*`) predate the frame
  palette change. `ingame/studio-*` are the current renders.

## Titanfall drop (`captures/titanfall-drop/*.png`)

Request: the titan falls out of the sky, hits, the ground shakes and the dust rolls. Module
`public/js/titanfall/titanfall-drop-fx.js` (tuning `TITANFALL_DROP_FX`), hooked into
`titan-presentation.js` (event, frame, walker update, slam, rise, warm-up, dispose). The server
is unchanged: the hull stands at the landing spot while `dropping` (marker 2.2 s + fall 0.8 s),
and the client draws it falling on the event's `landsAt` against the server clock estimate.

Captures: `node tools/titanfall-drop-capture.mjs` (inside a capture slot) renders
`public/titanfall-drop-capture.html`, a deterministic muted scene (voxel field, ION drop called
by a teammate, ExplosionFX, ParticleField, CameraShake, a LEGION cockpit 21 m away). Strips are
12 frames from -2.6 s to +4.0 s around impact: `strip-pilot15`, `strip-pilot40`,
`strip-caller`, `strip-cockpit`, `strip-wide`, `strip-skyward`; key frames `fall-wide`,
`fall-caller`, `burn-pilot15`, `impact-pilot15`, `shockwave-pilot40`, `impact-cockpit`,
`dust-caller`, `settle-top`, `impact-mobile` (720×1280), and `strip-landing-pose` (side view,
`bare`: no effects, -0.1 s to +1.6 s, the pose through the touchdown). Ad-hoc review frames:
`--frame view@seconds[@bare]` (views also `side`, `front`).

What it shows:
- **Fall** (whole countdown): `dropLift(tau)` puts the hull ~245 m up at the call, cruising at
  85 m/s and braking to 40 m/s over the last 0.45 s, down along the marker beam (7° slant from
  the titan's front). Orange-white re-entry streak (trail + core), a bow-shock rim on the lower
  hull and a camera-facing corona (so a pilot right under the beam sees the fireball), hottest
  from 1.5 s out; fire puffs along the path, a light smoke contrail, sparks and embers torn off.
  Shell and corona give way to the hull over the last ~0.5 s. Countdown ring fills to impact.
- **Burn** (last 0.6 s): four blue thruster jets out of the back vents pointing down, plume
  particles riding with the hull, a burst ring when they light, ground wash under it.
- **Touchdown** (client side, on the server's `landsAt`, once per drop): the rig is handed the
  landed phase on that frame (the landed row follows a tick or more later) with the hero pose
  already 60 % in, so it goes from the hanging fall pose straight into the three-point landing
  (`strip-landing-pose`). The marker beam is cut and flashes out in a white column (0.28 s).
- **Impact**: ExplosionFX flash + light + 7 m scorch (no
  fireball or smoke ball), a dirt-coloured dust burst and 22 m rolling dust wave/wall, a dust
  column, 34 instanced voxel chunks in the ground's colour that bounce on the voxels, debris,
  grit, sparks, a pressure ring seen from above (cockpits, roofs), dust that hangs for ~3 s.
  Steam out of the knees and back vents at +0.22 s, +0.77 s and on the rise.
- **Shake** for every viewer (CameraShake trauma, visual only, aim unaffected):
  1.0 at 0 m, 0.8 at 20 m, 0.4 at 40 m, 0 at 60 m, plus a 1.1 s rumble tail and thruster
  rumble inside 45 m before impact; the caller gets at least 0.85. FOV punch up to 9° inside
  16 m (the camera's own FOV easing takes it back).
- **Audio** (synthesized through the TitanSynth engine, positional): rising incoming
  roar/whistle over the countdown, the burn, an impact boom delayed by distance (343 m/s) with a
  dry thump close in, steam hiss. Not heard in these captures (muted).

Iterations (scratch only): 1 green dust (grass tint) and a white comet blob; 2 earthier dust
(40 % block tint, 60 % dirt), longer contrail; 3 slanted approach and the skyward view, jets
were white slabs; 4 instant dust burst, marker fades in 0.14 s, the flat explosion/pressure
ring read as a bright line at eye height; 5–6 no explosion ring, pressure ring faded by viewer
elevation, plume particles with the hull velocity, taller dust column and wall; 7 the plasma
shell lit its face (a white egg over the titan), now a rim only; the fire wake spawns behind
the hull; the ExplosionFX fire/smoke sprites (pink puffs, grey ball) dropped; softer dust-wall
silhouette. 8–10 (orchestrator review): the landing pose starts on the touchdown frame (it
showed hanging/folded legs until the landed row), the beam flashes out at impact (it stood
until +0.35 s), the approach is near-vertical over the beam with a hotter orange streak, the
corona and sparks (it read as grey smoke and came in from the side); the flash column was
thinned twice and the corona/shell fade late in the burn so the hull reads.

Open:
- The pose itself is the art-directed three-point landing in `titan-common.js` (22° torso
  lean); from the front it reads more upright than from the side.
- At 40 m the impact jolt (0.4 trauma) decays within ~0.4 s; noticeable but short.
- Audio not verified in a browser (no audio-playing flows on this machine). Not captured in
  a live match yet.
