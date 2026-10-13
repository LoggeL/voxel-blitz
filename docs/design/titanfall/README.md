# Titanfall references

These are the ImageGen concept references for the `titanfall` mode (Attrition). They cover the five titans, the pilot HUD, the titan cockpit HUD and the loadout screen. The workflow follows `AGENTS.md`: generate alternatives, pick one with reasons, then implement and compare live captures against the pick.

All images were generated on 2026-10-12 through the Codex image endpoint (`~/.codex/skills/codex-imagegen-models/scripts/codex_images.py`, `--size 1536x1024 --quality high`). The endpoint picked its own aspect ratio for some of them, so not every image is 1536×1024.

- The exact prompt for each image is in the `*.prompt.txt` file next to it.
- The [prompt appendix](#appendix-exact-prompts) repeats every prompt verbatim.
- No real game names or brands appear in any prompt. The titans are described only by silhouette.

## Style anchor

Before writing the prompts, these game visuals were checked:

- `docs/design/conquest/frontier-fleet-hero.png`
- `docs/design/conquest/vehicles/tank-front-repaired.png`
- `docs/design/conquest/redesign/captures/live/03-vehicle-deployed.png` and `deploy-screen.png`
- `docs/design/conquest/redesign/vehicles/fleet-sheet-reference.jpg`
- `docs/design/conquest/hud-alternatives.png`
- the tokens in `public/style.css`
- `TEAM_SCHEMES` in `public/js/vehicles/voxel-model/material.js`

The resulting style block, used in every model prompt:

- **Voxels:** 0.2 m cubes, with 0.1 m cubes for heads, hands and optics. Faces are greedy-meshed, flat and bevel-free. Round shapes are stepped staircases.
- **Shading:** baked AO in concave corners, a thin light lip on every convex edge, matte paint with low metalness.
- **Camouflage:** blocky blots 0.5–1.2 m across.
  - WEST: woodland, white stripe, blue roundel in a white ring.
  - EAST: desert, black stripe, orange roundel in a black ring.
- **Frame and glow:** the frame and weapons are dark gunmetal. Emissives are flat and bright.

**HUD identity:**

- charcoal glass `#0b0e12` at 93% opacity, 1 px `#3a4250` borders and chamfers;
- amber `#ff9f1c`;
- condensed uppercase Rajdhani with wide tracking;
- own team `#38bdf8`, enemy `#fb923c`, OK `#7fd069`, danger `#ff3355`.

## Files

| File | Prompt | Model | What it is |
|---|---|---|---|
| `titan-lineup-a.png` | `titan-lineup-a.prompt.txt` | gpt-image-2 | Lineup A: grounded military proportions, WEST woodland, studio, with a back-view strip |
| `titan-lineup-b.png` | `titan-lineup-b.prompt.txt` | gpt-image-2.5-sunburst | Lineup B: chunky "readable at 60 m" proportions, two-tone plate breakup, team accent bands, EAST desert, in-world. **Selected** |
| `titan-turnaround-ion.png` | `titan-turnaround-ion.prompt.txt` | gpt-image-2.5-sunburst | ION front / side / back / ¾, joint markers, part breakdown, palette |
| `titan-turnaround-scorch.png` | `titan-turnaround-scorch.prompt.txt` | gpt-image-2.5-sunburst | SCORCH, as above, plus hatch and battery detail crops |
| `titan-turnaround-northstar.png` | `titan-turnaround-northstar.prompt.txt` | gpt-image-2.5-sunburst | NORTHSTAR, as above |
| `titan-turnaround-ronin.png` | `titan-turnaround-ronin.prompt.txt` | gpt-image-2.5-sunburst | RONIN, as above |
| `titan-turnaround-legion.png` | `titan-turnaround-legion.prompt.txt` | gpt-image-2.5-sunburst | LEGION, as above |
| `hud-pilot.png` | `hud-pilot.prompt.txt` | gpt-image-2 | Pilot HUD, Option 1 and Option 2, desktop plus mobile portrait. **Option 2 selected** |
| `hud-titan.png` | `hud-titan.prompt.txt` | gpt-image-2 | Titan cockpit HUD, Option 1 and Option 2, desktop plus mobile portrait. **Option 2 selected** |
| `loadout.png` | `loadout.prompt.txt` | gpt-image-2 | Loadout screen: pilot primary, anti-titan and tactical, plus five titan cards and the kit strip. Single reference, adopted with corrections |
| `cockpit/cockpit-{a,b,c}-reference.jpg` | `cockpit/cockpit-{a,b,c}.prompt.txt` | gpt-image-2 | Titan cockpit interiors: A armoured hatch (**selected**), B segmented canopy, C sensor pit. Choice, iterations and captures: `cockpit/notes.md` |
| `wrist/wrist-{a,b,c}-reference.jpg` | `wrist/wrist-{a,b,c}.prompt.txt` | gpt-image-2 | Pilot wrist display (tactical on the left forearm): A armoured bracer slab (**selected**), B round wrist puck, C forearm LED strip. Choice, comparison and captures: `wrist/README.md` |
| `weapon-displays/halo/option-h{1,2,3}-*-reference.jpg` | same names, `.prompt.txt` | gpt-image-2 | On-gun ammo counters: H1 rear deck counter (**selected**), H2 rear cap, H3 digits only; the earlier flank-panel options A–C sit beside them in `weapon-displays/`. Spec: `docs/titanfall.md` §8.6 |
| `wallrun/wallrun-{a,b,c}-reference.jpg` | `wallrun/wallrun-{a,b,c}.prompt.txt` | gpt-image-2 | Wallrun first-person view: B (13° roll away from the wall, wall 40–50 % of the frame) **selected**. Captures: `wallrun/captures/`, spec §4.2 |
| `map/features/concept-{a,b,c}.png` | `map/features/concept-{a,b,c}.prompt.txt` | gpt-image-2 | Ashfall features: A (the Pour, Pour Line, slalom, ore dock, perches) **selected**, crane, medians and stairs from B, caches from C. Comparison: `map/README.md`, spec §14 |

## Selections

### Titan lineup: B selected; A supplies the back hatch and stripe placement

**Lineup B** was selected for these reasons:

- **Readable at combat range.** The silhouettes read at 60 m, which is the distance that matters in play. B has bigger hands, forearms and weapons, larger emissive optics, and a clear split between camo armour plates and a dark gunmetal inner frame and joints. This gives every titan depth and shows the IK-animated joints.
- **Team accent bands.** Bands across the chest and around both shins carry team identity even from behind and at an angle. That matters because roundels are small.
- **Stryder legs.** The digitigrade Stryder leg reads clearly on NORTHSTAR, and all five titans stay distinct as black shapes.
- **Fits the game.** B looks more like the existing game world (blocky concrete, rust girders, cartoon sky) than A's studio render.

**Taken from lineup A:**

- the back-view strip, which settles the battery hatch: a yellow-black frame at the top centre of the back with a green cell, about 1.0 × 1.2 m, between the shoulder blades;
- the WEST stripe and roundel placement: white stripe on the left pauldron and front of the thigh, roundel on the right pauldron;
- slightly leaner OGRE legs than B, so the heavy frame does not look stubby in the side view.

**Team accent band colours.** These are new `team` palette keys:

| Team | Accent band | Matches |
|---|---|---|
| WEST | sky blue | `--team-alpha` |
| EAST | orange | `--team-bravo` |

This matches the roundel family and the HUD's own/enemy colours.

**Implementation constraint: camo hue.** The camo must stay team-tinted, so that the vehicle-test hue rule still separates the teams: WEST 55–140°, EAST 15–50°.

### Turnarounds: one per titan, all follow lineup B

All five are usable as modelling sheets. Known deviations, which the modelling notes below override:

- **RONIN** is drawn with straight legs. It shares NORTHSTAR's Stryder skeleton, so model the same digitigrade shin and give RONIN only different shells.
- **LEGION's left-side view** shows the cannon on the near side, which is a perspective cheat. The cannon is the titan's **right** forearm, as the front and ¾ views show. The folded gun-shield plate from the prompt is missing; add it from the notes.
- **SCORCH** draws its dome reaching about 7.8 m. Clamp the dome top to 7.4 m.
- **ION's** shoulder exhaust stacks reach about 7.3 m. They are fine above the 7.0 m head.
- **NORTHSTAR's** rail cannon is drawn at about 4.3 m. Use 5.0 m.
- **Emissive swatches** in the sheets vary. Use the palette in the notes.

### Pilot HUD: Option 2

The Option 2 layout:

- top bar with per-team progress;
- hexagonal **TITAN %** gauge bottom left beside INTEGRITY, turning into a `U CALL TITAN` chip when ready;
- tactical chip with charge pips just off the crosshair;
- radial `HOLD T · RIPPING BATTERY` progress;
- a BATTERY CARRIED chip by health.

The hexagon reads instantly as the titan state without crowding the weapon panel. The top bar matches the existing Conquest ticket panel (score and progress bars). Mobile keeps every element in the safe areas next to the existing touch cluster.

**Taken from Option 1:**

- the plain `T RODEO` context chip in the lower centre, which is the existing interact-prompt style;
- the weapon panel with the anti-titan weapon and its charge bar under the primary.

The tactical key chip `Q` is a placeholder. The final key comes from the keybindings decision (`docs/titanfall.md`).

### Titan cockpit HUD: Option 2, with thinner struts

The Option 2 layout:

- the health arc under the reticle, with the blue shield segments overlaid on green;
- `CORE %` as a radial tile in the upper-right strut;
- `DOOMED` plus `HOLD X EJECT` on the right strut;
- dash chevrons on the left strut;
- Q / E / G cooldown tiles with radial fill on the lower-right strut;
- weapon ammo on the upper-left strut.

Keeping health and shield next to the reticle suits titan combat, where you watch the target and your own shield at once. Integrating the tiles into the struts sells "inside a 7 m mech" more than floating panels do.

**Corrections:**

- Struts must be at most about 6% of screen width on desktop, so the view stays wide.
- The core tile gets its `V` key chip.
- On mobile, use Option 1's bottom ability row (dash, Q, E, G) and put the DOOMED / EJECT chip above it. Both mobile options already do roughly this.

### Loadout screen: adopted with corrections

The layout is adopted as drawn:

- the LOADOUT title and team/mode sub-line;
- RESPAWN IN at top right;
- the PILOT column with primary, anti-titan and tactical chips and a one-line description;
- five tall titan cards and a kit strip with HEALTH / SPEED / DASH bars;
- the amber DEPLOY button.

**Corrections:**

- Card portraits must be live renders of the real titan models, not the concept art. The concept's NORTHSTAR card wrongly shows blades.
- The kit-strip frame label must be data-driven: ION is an ATLAS *balanced* frame, not "heavy".
- On mobile, stack the screen vertically in a scroll container, not in an overlapping phone frame.

## Modelling notes

### Shared rules

**Coordinates.** Hull metres, ground y = 0, forward −Z (the voxel DSL convention). "Right" means the titan's own right.

**Box notation.** Boxes are given as `w × h × d` with their centre or y-range. Use `mirrorX` for symmetric limbs with `-left`/`-right` tags.

**Resolution:**

- 0.2 m voxels for shells and limbs.
- `userData.scale = 0.5` (0.1 m voxels) for heads, hands, optics, vents, battery hatch and weapon detail.

**Rig.** Every frame has the same rigid part list, which is also the IK and fragment list:

- pelvis
- waist (twist pivot)
- torso with the chest hatch as its own part, so it can open and blow off on eject
- head
- per side: pauldron, upper arm, forearm, hand
- per side: thigh, shin, foot
- the weapon and its recoil node
- back kit

That is about 20 rigid parts, within the decided budget of 24 or fewer draws and 30k or fewer triangles. Bake into one rigid-skinned mesh if the shadow pass doubles draws past budget.

**Joint pivots.** Joints sit at gunmetal "ball" blocks:

| Joint | Ball size |
|---|---|
| hip, knee, shoulder | 0.6 m |
| ankle, elbow | 0.4 m |

The camo plates float 0.2 m proud of the frame, so the AO lip separates them.

**Shared parts on every titan:**

- **Chest hatch:** a `panel` plate 0.2 m proud, with hinge seams (`dark` 0.1 m grooves) and a `screen` slit 0.6 × 0.1 m.
- **Battery hatch:** on the back, between the shoulder blades:
  - a frame 1.0 w × 1.2 h of alternating `hazard` and `dark` 0.1 m checker;
  - two `gunmetal` grab handles 0.1 × 0.6 m;
  - a `screen` (green) cell 0.2 × 0.6 m visible in the seam;
  - the rodeo seat anchor sits 0.5 m behind it.

**Team identity:**

- `stripe` (WEST white / EAST black): a 0.4 m-wide vertical band on the left pauldron and front of the left thigh.
- `roundel` in a `ring`: 0.8 m across, on the right pauldron.
- New `accent` team key: a 0.2 m chest band across the hatch and a 0.3 m band around each shin.
  - WEST is sky blue, about `0x3aa8e8`. EAST is orange, about `0xf07a2a`.
  - Keep its rough/metal equal to `stripe`.

**Palette.** Existing entries are `paint`/`panel` for camo plates, `gunmetal` `0x41464a` for the frame, joints and weapons, plus `dark`, `hazard`, `screen` and `steel`. New entries:

| Entry | Colour | Emissive |
|---|---|---|
| `opticIon` | `0xd8f0ff` | negative, constant glow |
| `energyBlue` | `0x3a8cff` | negative |
| `opticCyan` | `0x48e8ff` | negative |
| `opticOrange` | `0xff9a3a` | negative |
| `opticRed` | `0xff3a24` | negative |
| `fuel` | `0xb8432a` | none (reuse `marking` if identical) |
| `clothRed` | `0x8f2a22` | none, rough 0.95 |
| `blade` | `0xc9ced2` | none, metal 0.7, rough 0.35 |

Doom state uses the existing `vehicleState` soot and burn plus spark emitters.

**Readability rule.** At 60 m a titan is about 60–80 px tall. Only these survive at that size:

- the outline;
- one or two emissive spots;
- the weapon length and shape;
- the team bands.

Every titan below is defined by exactly these.

### ION (Atlas frame, 7.0 m)

**Silhouette:** a wide box chest over a narrow waist, a small head sunk between square pauldrons, and one big round eye. Proportions are balanced and upright.

**Legs:**

- **Foot:** 1.2 × 0.6 × 1.8 (toe 1.1 forward of the ankle, heel 0.5 back). Ankle pivot at y 0.6.
- **Shin:** 1.0 × 1.8 × 1.0, y 0.6–2.4, with the accent band at y 1.1–1.4. Knee pivot at y 2.4, with a knee plate 0.8 × 0.6 0.2 m proud.
- **Thigh:** 0.9 × 1.0 × 0.9, y 2.4–3.4. Hip pivots at x ±0.65, y 3.4.

**Torso:**

- **Pelvis:** 1.8 × 0.8 × 1.2, y 3.2–4.0.
- **Waist:** `gunmetal` 1.4 × 0.4 × 1.0. Twist pivot at y 4.1.
- **Chest:** 2.6 × 2.0 × 1.8, y 4.2–6.2, slightly wider at the top (prism).
- **Hatch:** 1.6 × 1.4 on the front at y 4.6–6.0, with the accent band at y 5.4.

**Head:**

- 0.9 × 0.8 × 0.8, y 6.2–7.0, recessed 0.2 m behind the pauldron front faces.
- **Optic:** a 0.6 m disc (0.1 m voxels), `opticIon` core of radius 0.2 inside an `energyBlue` ring, protruding 0.1.

**Arms:**

- **Pauldrons:** 1.2 × 1.2 × 1.4 centred at x ±1.6, y 6.1. They carry three slatted `dark`/`gunmetal` vent fins 0.1 m apart on top. Shoulder pivot at y 5.9.
- **Upper arm:** 0.6 × 1.2. Elbow at y 4.7.
- **Forearm:** 0.8 × 0.8 × 1.3. Wrist at y 3.6.
- **Hand:** three-finger 0.6 m block. The left palm carries an `energyBlue` disc of radius 0.2 (the vortex emitter).

**Back:** the battery hatch at y 5.0–6.2, flanked by two `gunmetal` exhaust stacks 0.3 × 0.8 at x ±0.9, rising to y 7.3.

**Weapon (Splitter Rifle):**

- 4.0 m long, section 0.45 × 0.55, held two-handed at hip height (muzzle at about y 4.0 forward).
- Four square `energyBlue` cells (0.3 m each) along the right side.
- A slotted `dark` muzzle 0.6 m long.

**Reads as ION by:** the one round blue-white eye, the box chest, and the long rifle with a row of four blue squares.

### SCORCH (Ogre frame, 7.4 m)

**Silhouette:** a round stepped dome with no head, huge squared pauldrons, a wide low stance, and a stubby launcher. Red canisters show on the back.

**Legs:**

- **Feet:** 1.5 × 0.7 × 2.0 at x ±1.1. Ankle at y 0.7.
- **Shin:** 1.3 × 1.5 × 1.3, y 0.7–2.2, with the accent band at y 1.2–1.5. Knee guard 1.0 × 0.8, 0.4 m proud.
- **Thigh:** 1.2 × 1.0. Hips at x ±0.85, y 3.2. These legs are slightly longer than in lineup B, per lineup A.

**Torso:**

- **Pelvis:** 2.2 × 0.8 × 1.4, y 3.0–3.8.
- **Dome torso:** `loft` from y 3.8 to 7.4, half-width 1.6 at y 5.6 tapering to 0.6 at the top, depth 3.0, stepped. No separate head.
- **Visor:** an `opticOrange` slit 1.0 × 0.2 at y 6.9 on the front.
- **Hatch:** 1.4 × 1.2 at y 5.0–6.2, with the accent band at y 5.8 across the dome front.

**Arms:**

- **Pauldrons:** 1.6 × 1.6 × 1.8 centred at x ±2.1, y 6.2, slightly drooped outward.
- **Arms:** upper arm 0.8; forearm 1.0 × 1.0 × 1.4.
- **Left forearm:** carries the thermal-shield plate 0.3 × 1.4 × 1.2 with two vertical `opticOrange` slots of 0.1 × 1.0.
- **Hands:** big 0.7 m blocks.
- **Hip vents:** two `opticOrange` 0.4 × 0.4 grilles at y 4.2.

**Back:** two `fuel` cylinders (radius 0.35, h 1.2) flanking the battery hatch, plus one on the right hip. `gunmetal` 0.1 m hoses loop into the dome.

**Weapon (Thermite Launcher):**

- 3.0 m long, carried in the right hand at the hip.
- Square bore 0.8 m with a `dark` mouth.
- A 0.4 m `opticOrange`-tinted `hazard` band (not emissive) at two-thirds length.
- A box magazine 0.5 × 0.6 below, and a top handle.

**Reads as SCORCH by:** the dome with an orange slit, the widest shoulders of the five, red canisters, and a short fat orange-banded tube.

### NORTHSTAR (Stryder frame, 7.6 m)

**Silhouette:** tall stick legs with a digitigrade bend, a narrow chest, a wedge head, and a very long glowing rail. Pods sit on the back and calves.

**Legs (Stryder skeleton, also used by RONIN):**

- **Foot:** 0.8 × 0.5 × 2.0, pointed toe, raised heel. Ankle at y 0.9, z +0.4.
- **Shin:** 0.7 × 0.7, angled from the ankle up and forward to the knee at y 2.6, z −0.3. The `gunmetal` inner strut is exposed, with a camo shin plate on the front and the accent band at y 1.6.
- **Thigh:** 0.8 × 1.2, from the knee to the hip at y 3.8. Hips at x ±0.5.

**Torso:**

- **Pelvis:** 1.4 × 0.7 × 1.0.
- **Waist:** `gunmetal` 0.9 m.
- **Chest:** 2.0 × 1.8 × 1.4, y 4.6–6.4, tapering to the waist. Hatch 1.2 × 1.0, with the accent band at y 5.2.

**Head:**

- A wedge 0.7 × 0.6 × 1.0 at y 6.5–7.1, nose forward.
- An `opticCyan` visor slit 0.5 × 0.1.

**Arms:**

- **Pauldrons:** 1.0 × 1.0 × 1.1 at x ±1.3, y 6.3.
- **Arms:** slim; forearm 0.6 × 0.6 × 1.2.
- **Missile pod:** on the right pauldron, 0.9 × 0.9 × 0.8, with a 3 × 3 grid of `dark` tube mouths on its front face. Top at y 7.6.

**Back and calves:**

- **Back pods:** two hover pods 0.6 × 1.6 × 0.6, vertical, at x ±0.8, y 5.0–6.8. `opticCyan` nozzles 0.4 × 0.2 at the bottom are the dash and hover emitter anchors.
- **Calf pods:** 0.4 × 0.8 × 0.4 on the outside of each calf, with cyan nozzles.

**Weapon (Plasma Railgun):**

- 5.0 m long, section 0.35 × 0.4, held long and low.
- An `opticCyan` rail strip 0.1 × 3.4 along its right side.
- A box scope 0.3 × 0.3 × 0.8 on top.
- A square muzzle shroud.

**Reads as NORTHSTAR by:** the thin digitigrade legs (the only bent-back legs besides RONIN's), the longest weapon of the five, the cyan line, and the square pod on the shoulder.

### RONIN (Stryder frame, 7.6 m)

**Silhouette:** the slim Stryder legs (the same skeleton as NORTHSTAR), two tall swept fins on the head, a sword diagonal across the back, and a red skirt.

**Legs and torso:**

- Legs as NORTHSTAR, with slimmer, pointed-toe foot plates.
- The chest is NORTHSTAR's at 1.9 m wide.
- **Pauldrons:** lamellar, three stacked 0.2 m slabs 1.2 wide, each stepping 0.1 m outward and down.

**Head:**

- 0.6 × 0.6 × 0.7 at y 6.4–7.0, with an `opticRed` visor slit 0.4 × 0.1.
- **Two fins:** each 0.2 × 1.2 × 0.2, rising from the head top and angled back and out 20°. Tips at about y 8.0.

**Tassets:** `clothRed` hanging panels on the front and back of the pelvis, 1.0 × 1.4 × 0.2, y 2.6–4.0, with a stepped, ragged lower edge.

**Weapons:**

- **Leadwall shotgun:** in the right hand, 2.0 × 0.4 × 0.5, with a `dark` drum (radius 0.35) under the receiver.
- **Sword:** 4.5 m long, stowed on the back from the left shoulder to the right hip, beside the battery hatch.
  - Blade: `blade` 0.2 × 0.4 cross-section, 3.6 m long.
  - Guard: `gunmetal` 0.6 × 0.2 square.
  - Hilt: `clothRed`/`dark` wrapped, 0.8 m.
- **Sword Core:** add a negative-emissive edge on the blade (arc-wave tint).

**Reads as RONIN by:** the horned head, the sword sticking out over the shoulder, the red skirt, and a short gun.

### LEGION (Ogre frame, 7.4 m)

**Silhouette:** the bulky Ogre legs and stance, but with a boxier chest than SCORCH and a small separate dome head. The giant rotary cannon replaces the right forearm, which makes the titan strongly asymmetric. An ammo drum sits on the back.

**Legs and torso:**

- Legs and pelvis as SCORCH.
- **Chest:** `loft` with a high power (squarer than SCORCH), 3.0 w × 2.4 h × 2.2 d, y 4.0–6.4.
- **Hatch:** 1.4 × 1.2, with a `screen` slit and the accent band at y 5.9.

**Head:** a dome 0.9 × 0.7 × 0.8, sitting low at y 6.4–7.0 between the pauldrons. On its front, a 2 × 2 cluster of `opticRed` 0.2 m squares.

**Arms:**

- **Pauldrons:** as SCORCH.
- **Left arm:** a normal heavy arm with a 0.7 m hand.
- **Right arm (cannon):** the right upper arm ends in the Predator Cannon. It needs a `spin` node for barrel rotation.
  - Receiver 1.0 × 1.0 × 1.4.
  - Six `gunmetal` barrels of radius 0.12 on a ring of radius 0.35, 3.5 m total length.
  - Two `hazard`/`dark` hazard bands of 0.3 m.
- **Gun shield:** a folded plate 1.2 × 0.2 × 1.6 on top of the receiver. It unfolds forward for Gun Shield.

**Back:**

- An ammo drum of radius 0.7 and width 0.6 on the back right beside the battery hatch.
- A segmented belt of `gunmetal` 0.3 m links runs over the right shoulder into the receiver.

**Reads as LEGION by:** the one-sided gatling arm (no other titan is asymmetric), the four red dots, and the drum on the back.

### Frame summary

| Titan | Frame | Height | Shoulder width | Hip height | Dash pips | Key emissive |
|---|---|---|---|---|---|---|
| ION | Atlas | 7.0 m | 4.4 m | 3.4 m | 2 | blue-white round eye, blue cells |
| SCORCH | Ogre | 7.4 m | 5.8 m | 3.2 m | 2 | orange visor slit, hip vents |
| NORTHSTAR | Stryder | 7.6 m | 3.6 m | 3.8 m | 3 | cyan visor, rail, thruster nozzles |
| RONIN | Stryder | 7.6 m (fins 8.0) | 3.6 m | 3.8 m | 3 | red visor slit |
| LEGION | Ogre | 7.4 m | 5.8 m | 3.2 m | 2 | 2 × 2 red optics |

## Appendix: exact prompts

### titan-lineup-a

```text
Use case: stylized-concept. Asset type: character lineup design sheet for giant voxel battle mechs in a browser voxel shooter. Primary request: one wide sheet showing five different giant piloted battle mechs standing side by side in a straight row on a neutral grey studio ground, all in the same three-quarter front hero view at the same scale, warm low sun from the left with soft long shadows. A 1.8 m voxel infantry pilot in the same blocky style (boxy helmet, plate carrier, compact rifle) stands at the far left for scale, so the mechs read as about four times his height. Faint horizontal height marker lines at 2, 4, 6 and 8 metres in the background. All five in the WEST woodland team scheme with the white team stripe on the left shoulder and thigh and the blue roundel on the shoulder. Proportions are grounded and military: small heads, broad shoulders, leg length about half the total height, the cockpit hatch reading clearly on every chest. Under each mech a small clean uppercase label: ION, SCORCH, NORTHSTAR, RONIN, LEGION. A thin bottom strip shows each mech from directly behind as a small thumbnail so the battery hatch on the back reads.

The five titans, all giant bipedal piloted battle mechs about 7 metres tall, built on three frames:
1. ION, balanced medium frame about 7.0 m: boxy armoured chest that is wider than the hips, a small recessed head between the shoulders carrying one single large round blue-white glowing optic eye, a long energy rifle with glowing blue cells held in both hands, slatted heat vents on top of both shoulders.
2. SCORCH, heavy frame about 7.4 m: very bulky and wide, a round stepped-voxel dome cockpit torso with a narrow horizontal visor slit instead of a separate head, huge squared shoulders, thick short legs, a stubby large-bore orange-banded thermite grenade launcher, two red-orange fuel canisters strapped to the back and hip, faint orange glow from vents.
3. NORTHSTAR, light frame about 7.6 m: slim and tall with long legs and a backward-bent digitigrade-feeling lower leg and long feet, a narrow torso, a small wedge head with a cyan visor, a very long scoped rail cannon with a cyan glowing rail, flat hover thruster pods on the back and on the outside of the calves.
4. RONIN, light frame about 7.6 m: same slim long-legged frame, a small head with two swept-back blade-like fins like a samurai helmet crest, a short broad pump shotgun in one hand and a very long straight broad sword of bright steel with a red hilt carried on the back, a red cloth-like hip panel accent.
5. LEGION, heavy frame about 7.4 m: same bulky heavy frame as SCORCH but its right forearm is replaced by a huge multi-barrel rotary cannon with a drum magazine and yellow-black hazard bands, an armoured dome head with a cluster of four small red-orange optics, a gun shield plate folded on the cannon.
Every titan has its cockpit hatch on the chest front: a clearly outlined armour plate with hinge seams and a small glass or screen slit, big enough for a pilot to climb in. Every titan has a square battery hatch on the upper back between the shoulder blades: a yellow-black framed panel with two grab handles and a glowing green battery cell visible in its seam, so an enemy pilot can ride on the back and rip it out.

Visual style, matching the existing browser voxel shooter exactly: every model is built from 0.2 m cubic voxels (heads, hands, optics and small fittings from finer 0.1 m voxels) with greedy-meshed flat faces and absolutely no bevels or smooth curves; round shapes are stepped voxel staircases; crisp baked ambient occlusion darkens every concave corner; a thin light edge highlight runs along every convex edge; matte painted steel, low metalness. Camouflage is blocky per-voxel blots 0.5 to 1.2 m across. WEST team scheme: woodland camouflage with olive ground coat, mid-green and black-green blots and a small olive-brown share, a white vertical team stripe and a blue roundel in a white ring. EAST team scheme: desert camouflage with sand ground coat, tan and dark khaki blots, a black team stripe and an orange roundel in a black ring. Bare metal joints, pistons and weapon bodies are dark gunmetal. Emissive optics, energy cells and vents glow flat and bright with a soft bloom.

No branding, no logos, no text except the five labels. Each silhouette must be instantly distinct from the others even as a black shape.
```

### titan-lineup-b

```text
Use case: stylized-concept. Asset type: character lineup design sheet for giant voxel battle mechs in a browser voxel shooter. Primary request: one wide sheet with the same five giant piloted battle mechs, but designed for maximum readability at 60 metres in a fast game: chunkier heroic proportions, oversized shoulder armour and forearms, larger hands and weapons, bigger brighter emissive optics, strong two-tone plate breakup (large plain armour plates in the team camouflage over darker gunmetal inner frame and joints) and a bright team accent band across the chest and both shins. They stand side by side in a slightly staggered row on blocky voxel concrete in a sunny industrial voxel world (grey concrete blocks, rust-red girders, sandstone banks, blue sky with soft cartoon clouds), three-quarter front view, the same scale. A 1.8 m voxel infantry pilot in the same blocky style stands at the front for scale. All five in the EAST desert team scheme with the black team stripe and orange roundel. Under each mech a small clean uppercase label: ION, SCORCH, NORTHSTAR, RONIN, LEGION.

The five titans, all giant bipedal piloted battle mechs about 7 metres tall, built on three frames:
1. ION, balanced medium frame about 7.0 m: boxy armoured chest that is wider than the hips, a small recessed head between the shoulders carrying one single large round blue-white glowing optic eye, a long energy rifle with glowing blue cells held in both hands, slatted heat vents on top of both shoulders.
2. SCORCH, heavy frame about 7.4 m: very bulky and wide, a round stepped-voxel dome cockpit torso with a narrow horizontal visor slit instead of a separate head, huge squared shoulders, thick short legs, a stubby large-bore orange-banded thermite grenade launcher, two red-orange fuel canisters strapped to the back and hip, faint orange glow from vents.
3. NORTHSTAR, light frame about 7.6 m: slim and tall with long legs and a backward-bent digitigrade-feeling lower leg and long feet, a narrow torso, a small wedge head with a cyan visor, a very long scoped rail cannon with a cyan glowing rail, flat hover thruster pods on the back and on the outside of the calves.
4. RONIN, light frame about 7.6 m: same slim long-legged frame, a small head with two swept-back blade-like fins like a samurai helmet crest, a short broad pump shotgun in one hand and a very long straight broad sword of bright steel with a red hilt carried on the back, a red cloth-like hip panel accent.
5. LEGION, heavy frame about 7.4 m: same bulky heavy frame as SCORCH but its right forearm is replaced by a huge multi-barrel rotary cannon with a drum magazine and yellow-black hazard bands, an armoured dome head with a cluster of four small red-orange optics, a gun shield plate folded on the cannon.
Every titan has its cockpit hatch on the chest front: a clearly outlined armour plate with hinge seams and a small glass or screen slit, big enough for a pilot to climb in. Every titan has a square battery hatch on the upper back between the shoulder blades: a yellow-black framed panel with two grab handles and a glowing green battery cell visible in its seam, so an enemy pilot can ride on the back and rip it out.

Visual style, matching the existing browser voxel shooter exactly: every model is built from 0.2 m cubic voxels (heads, hands, optics and small fittings from finer 0.1 m voxels) with greedy-meshed flat faces and absolutely no bevels or smooth curves; round shapes are stepped voxel staircases; crisp baked ambient occlusion darkens every concave corner; a thin light edge highlight runs along every convex edge; matte painted steel, low metalness. Camouflage is blocky per-voxel blots 0.5 to 1.2 m across. WEST team scheme: woodland camouflage with olive ground coat, mid-green and black-green blots and a small olive-brown share, a white vertical team stripe and a blue roundel in a white ring. EAST team scheme: desert camouflage with sand ground coat, tan and dark khaki blots, a black team stripe and an orange roundel in a black ring. Bare metal joints, pistons and weapon bodies are dark gunmetal. Emissive optics, energy cells and vents glow flat and bright with a soft bloom.

No branding, no logos, no text except the five labels. Each silhouette must be instantly distinct from the others even as a black shape.
```

### titan-turnaround-ion

```text
Use case: stylized-concept. Asset type: orthographic character turnaround model sheet for a giant voxel battle mech, detailed enough for a 3D modeller to rebuild it from boxes. Layout: light grey background with a faint 1 metre grid; four full-body views in a row at exactly the same scale and height, feet on one common ground line: FRONT, LEFT SIDE, BACK, THREE-QUARTER FRONT, each with a small uppercase label below. A vertical height ruler at the left marked 0, 2, 4, 6, 8 m, and a dark grey 1.8 m human pilot silhouette next to it for scale. In the side view, small white circle markers sit on the hip, knee, ankle, shoulder and elbow pivots. Neutral even studio light, flat orthographic camera with no perspective in the first three views. A thin bottom strip shows an exploded part breakdown as small thumbnails (head, torso with chest cockpit hatch, shoulder armour, upper arm, forearm and hand, thigh, shin, foot, main weapon) and a row of flat colour swatches for the paint: camo ground, camo blots, gunmetal frame, team accent, emissive glow. The cockpit hatch on the chest front is a clearly outlined armour plate with hinge seams and a small screen slit; the square battery hatch on the upper back has a yellow-black frame, two grab handles and a glowing green cell visible in its seam. No branding, no logos, no text except the short view labels and part labels.

Subject: ION, a balanced medium-frame piloted battle mech, 7.0 m tall. Boxy armoured chest about 2.6 m wide, wider than the hips, with the cockpit hatch filling its front; a small box head sunk between the shoulders carrying one single large round blue-white glowing optic eye about 0.6 m across; square shoulder armour blocks with slatted heat vents on top; medium arms with blocky three-finger hands, the left palm carrying a round blue glowing emitter disc; legs about half the total height with plain knee plates and wide flat feet; two short exhaust stacks on the back beside the battery hatch. Main weapon: a long boxy energy rifle about 4 m long, held in both hands, with four square blue glowing energy cells along its side and a slotted muzzle.

Visual style, matching the existing browser voxel shooter exactly: built from 0.2 m cubic voxels (head, hands, optics and small fittings from finer 0.1 m voxels) with greedy-meshed flat faces and absolutely no bevels or smooth curves; round shapes are stepped voxel staircases; crisp baked ambient occlusion in concave corners; a thin light edge highlight on every convex edge; matte painted steel, low metalness. Design direction: chunky heroic proportions readable at 60 metres, large plain armour plates in team camouflage over a darker gunmetal inner frame, pistons and joints, oversized bright emissive optics, a bright team accent band across the chest and around both shins. Shown in the WEST team scheme: woodland camouflage plates (olive ground coat, mid-green and black-green blots 0.5 to 1.2 m across, a small olive-brown share), a white vertical team stripe on the left shoulder, a blue roundel in a white ring on the right shoulder, and the accent bands in sky blue.
```

### titan-turnaround-scorch

```text
Use case: stylized-concept. Asset type: orthographic character turnaround model sheet for a giant voxel battle mech, detailed enough for a 3D modeller to rebuild it from boxes. Layout: light grey background with a faint 1 metre grid; four full-body views in a row at exactly the same scale and height, feet on one common ground line: FRONT, LEFT SIDE, BACK, THREE-QUARTER FRONT, each with a small uppercase label below. A vertical height ruler at the left marked 0, 2, 4, 6, 8 m, and a dark grey 1.8 m human pilot silhouette next to it for scale. In the side view, small white circle markers sit on the hip, knee, ankle, shoulder and elbow pivots. Neutral even studio light, flat orthographic camera with no perspective in the first three views. A thin bottom strip shows an exploded part breakdown as small thumbnails (head, torso with chest cockpit hatch, shoulder armour, upper arm, forearm and hand, thigh, shin, foot, main weapon) and a row of flat colour swatches for the paint: camo ground, camo blots, gunmetal frame, team accent, emissive glow. The cockpit hatch on the chest front is a clearly outlined armour plate with hinge seams and a small screen slit; the square battery hatch on the upper back has a yellow-black frame, two grab handles and a glowing green cell visible in its seam. No branding, no logos, no text except the short view labels and part labels.

Subject: SCORCH, a heavy-frame piloted battle mech, 7.4 m tall, very bulky and wide stance. The torso is a large round stepped-voxel dome cockpit with a narrow horizontal orange glowing visor slit instead of a separate head, the cockpit hatch on the front of the dome; huge squared shoulder armour; thick arms with big blocky hands, the left forearm carrying a flat heat shield emitter plate with orange glowing slots; thick short legs with heavy knee guards and very wide feet; orange glowing vents on the hips. Two red-orange fuel canisters strapped to the back flanking the battery hatch and one on the right hip, connected by dark hoses. Main weapon: a stubby large-bore thermite grenade launcher about 3 m long with a broad orange band around the barrel and a box magazine.

Visual style, matching the existing browser voxel shooter exactly: built from 0.2 m cubic voxels (head, hands, optics and small fittings from finer 0.1 m voxels) with greedy-meshed flat faces and absolutely no bevels or smooth curves; round shapes are stepped voxel staircases; crisp baked ambient occlusion in concave corners; a thin light edge highlight on every convex edge; matte painted steel, low metalness. Design direction: chunky heroic proportions readable at 60 metres, large plain armour plates in team camouflage over a darker gunmetal inner frame, pistons and joints, oversized bright emissive optics, a bright team accent band across the chest and around both shins. Shown in the WEST team scheme: woodland camouflage plates (olive ground coat, mid-green and black-green blots 0.5 to 1.2 m across, a small olive-brown share), a white vertical team stripe on the left shoulder, a blue roundel in a white ring on the right shoulder, and the accent bands in sky blue.
```

### titan-turnaround-northstar

```text
Use case: stylized-concept. Asset type: orthographic character turnaround model sheet for a giant voxel battle mech, detailed enough for a 3D modeller to rebuild it from boxes. Layout: light grey background with a faint 1 metre grid; four full-body views in a row at exactly the same scale and height, feet on one common ground line: FRONT, LEFT SIDE, BACK, THREE-QUARTER FRONT, each with a small uppercase label below. A vertical height ruler at the left marked 0, 2, 4, 6, 8 m, and a dark grey 1.8 m human pilot silhouette next to it for scale. In the side view, small white circle markers sit on the hip, knee, ankle, shoulder and elbow pivots. Neutral even studio light, flat orthographic camera with no perspective in the first three views. A thin bottom strip shows an exploded part breakdown as small thumbnails (head, torso with chest cockpit hatch, shoulder armour, upper arm, forearm and hand, thigh, shin, foot, main weapon) and a row of flat colour swatches for the paint: camo ground, camo blots, gunmetal frame, team accent, emissive glow. The cockpit hatch on the chest front is a clearly outlined armour plate with hinge seams and a small screen slit; the square battery hatch on the upper back has a yellow-black frame, two grab handles and a glowing green cell visible in its seam. No branding, no logos, no text except the short view labels and part labels.

Subject: NORTHSTAR, a light-frame piloted battle mech, 7.6 m tall, slim and tall. Long legs with a digitigrade-feeling lower leg (knee forward, long backward-angled shin, raised heel, long feet), a narrow torso with the cockpit hatch, a small wedge-shaped head with a cyan glowing visor; slim arms; two flat hover thruster pods on the back flanking the battery hatch and one thruster pod on the outside of each calf, nozzles glowing cyan; a small box cluster-missile pod with a grid of tube mouths on the right shoulder. Main weapon: a very long scoped rail cannon about 5 m long with a box scope on top and a cyan glowing rail along the barrel.

Visual style, matching the existing browser voxel shooter exactly: built from 0.2 m cubic voxels (head, hands, optics and small fittings from finer 0.1 m voxels) with greedy-meshed flat faces and absolutely no bevels or smooth curves; round shapes are stepped voxel staircases; crisp baked ambient occlusion in concave corners; a thin light edge highlight on every convex edge; matte painted steel, low metalness. Design direction: chunky heroic proportions readable at 60 metres, large plain armour plates in team camouflage over a darker gunmetal inner frame, pistons and joints, oversized bright emissive optics, a bright team accent band across the chest and around both shins. Shown in the WEST team scheme: woodland camouflage plates (olive ground coat, mid-green and black-green blots 0.5 to 1.2 m across, a small olive-brown share), a white vertical team stripe on the left shoulder, a blue roundel in a white ring on the right shoulder, and the accent bands in sky blue.
```

### titan-turnaround-ronin

```text
Use case: stylized-concept. Asset type: orthographic character turnaround model sheet for a giant voxel battle mech, detailed enough for a 3D modeller to rebuild it from boxes. Layout: light grey background with a faint 1 metre grid; four full-body views in a row at exactly the same scale and height, feet on one common ground line: FRONT, LEFT SIDE, BACK, THREE-QUARTER FRONT, each with a small uppercase label below. A vertical height ruler at the left marked 0, 2, 4, 6, 8 m, and a dark grey 1.8 m human pilot silhouette next to it for scale. In the side view, small white circle markers sit on the hip, knee, ankle, shoulder and elbow pivots. Neutral even studio light, flat orthographic camera with no perspective in the first three views. A thin bottom strip shows an exploded part breakdown as small thumbnails (head, torso with chest cockpit hatch, shoulder armour, upper arm, forearm and hand, thigh, shin, foot, main weapon) and a row of flat colour swatches for the paint: camo ground, camo blots, gunmetal frame, team accent, emissive glow. The cockpit hatch on the chest front is a clearly outlined armour plate with hinge seams and a small screen slit; the square battery hatch on the upper back has a yellow-black frame, two grab handles and a glowing green cell visible in its seam. No branding, no logos, no text except the short view labels and part labels.

Subject: RONIN, a light-frame piloted battle mech, 7.6 m tall, slim long-legged duelist frame. A small head with two tall swept-back blade-like fins like a samurai helmet crest and a red glowing visor slit; narrow torso with the cockpit hatch; slim shoulder plates layered like lamellar armour; a red cloth-like hanging hip panel (tassets) front and back; long legs with knee guards and pointed feet. Weapons: a short broad pump shotgun with a drum magazine in the right hand, and a very long straight broad sword about 4.5 m long of bright steel with a red-wrapped hilt and square guard, stowed diagonally on the back in a clip beside the battery hatch.

Visual style, matching the existing browser voxel shooter exactly: built from 0.2 m cubic voxels (head, hands, optics and small fittings from finer 0.1 m voxels) with greedy-meshed flat faces and absolutely no bevels or smooth curves; round shapes are stepped voxel staircases; crisp baked ambient occlusion in concave corners; a thin light edge highlight on every convex edge; matte painted steel, low metalness. Design direction: chunky heroic proportions readable at 60 metres, large plain armour plates in team camouflage over a darker gunmetal inner frame, pistons and joints, oversized bright emissive optics, a bright team accent band across the chest and around both shins. Shown in the WEST team scheme: woodland camouflage plates (olive ground coat, mid-green and black-green blots 0.5 to 1.2 m across, a small olive-brown share), a white vertical team stripe on the left shoulder, a blue roundel in a white ring on the right shoulder, and the accent bands in sky blue.
```

### titan-turnaround-legion

```text
Use case: stylized-concept. Asset type: orthographic character turnaround model sheet for a giant voxel battle mech, detailed enough for a 3D modeller to rebuild it from boxes. Layout: light grey background with a faint 1 metre grid; four full-body views in a row at exactly the same scale and height, feet on one common ground line: FRONT, LEFT SIDE, BACK, THREE-QUARTER FRONT, each with a small uppercase label below. A vertical height ruler at the left marked 0, 2, 4, 6, 8 m, and a dark grey 1.8 m human pilot silhouette next to it for scale. In the side view, small white circle markers sit on the hip, knee, ankle, shoulder and elbow pivots. Neutral even studio light, flat orthographic camera with no perspective in the first three views. A thin bottom strip shows an exploded part breakdown as small thumbnails (head, torso with chest cockpit hatch, shoulder armour, upper arm, forearm and hand, thigh, shin, foot, main weapon) and a row of flat colour swatches for the paint: camo ground, camo blots, gunmetal frame, team accent, emissive glow. The cockpit hatch on the chest front is a clearly outlined armour plate with hinge seams and a small screen slit; the square battery hatch on the upper back has a yellow-black frame, two grab handles and a glowing green cell visible in its seam. No branding, no logos, no text except the short view labels and part labels.

Subject: LEGION, a heavy-frame piloted battle mech, 7.4 m tall, very bulky and wide stance, the same heavy frame as a dome-cockpit brawler. An armoured dome head sitting low between the shoulders with a 2 by 2 cluster of small red-orange glowing optics; broad chest with the cockpit hatch; huge squared shoulder armour; the right forearm is replaced entirely by a huge six-barrel rotary cannon about 3.5 m long with yellow-black hazard bands and a folded rectangular gun shield plate on top; a large ammo drum on the back beside the battery hatch feeding the cannon through a segmented belt over the right shoulder; the left arm has a normal big blocky hand; thick legs with heavy knee guards and very wide feet.

Visual style, matching the existing browser voxel shooter exactly: built from 0.2 m cubic voxels (head, hands, optics and small fittings from finer 0.1 m voxels) with greedy-meshed flat faces and absolutely no bevels or smooth curves; round shapes are stepped voxel staircases; crisp baked ambient occlusion in concave corners; a thin light edge highlight on every convex edge; matte painted steel, low metalness. Design direction: chunky heroic proportions readable at 60 metres, large plain armour plates in team camouflage over a darker gunmetal inner frame, pistons and joints, oversized bright emissive optics, a bright team accent band across the chest and around both shins. Shown in the WEST team scheme: woodland camouflage plates (olive ground coat, mid-green and black-green blots 0.5 to 1.2 m across, a small olive-brown share), a white vertical team stripe on the left shoulder, a blue roundel in a white ring on the right shoulder, and the accent bands in sky blue.
```

### hud-pilot

```text
Use case: ui-mockup. Asset type: gameplay HUD design reference for the pilot (infantry) side of a giant-mech team deathmatch mode in an existing browser voxel shooter. Create one wide image containing two clearly separate alternative HUD layouts side by side, labelled OPTION 1 and OPTION 2, each showing a desktop landscape 16:9 screen and below it a smaller mobile portrait 9:16 inset of the same layout. Existing HUD identity to match exactly: near-black charcoal glass panels (#0b0e12 at 93% opacity) with slim 1 px slate borders (#3a4250) and small chamfered corners, amber accent #ff9f1c, condensed uppercase Rajdhani-style typography with wide letter spacing, team colours sky blue #38bdf8 for own team and orange #fb923c for enemy, health green #7fd069, danger red #ff3355. The game world behind is the actual blocky voxel world: sunny blue sky with soft cartoon clouds, grey concrete voxel ground, rust-red steel girders, sandstone banks, everything made of visible cubes; first-person view holding a chunky voxel rifle at lower right; in the mid-distance an enemy giant 7 m voxel battle mech in desert camouflage, and a friendly one in woodland camouflage further away.
Functional HUD elements, all compact and practical for HTML/CSS:
- top centre attrition score bar: MILITIA 142 in blue left, IMC 128 in orange right, two thin progress bars toward the limit 300, match timer 08:41 between them;
- titan meter: a segmented charge gauge labelled TITAN 72% with a small mech head icon; next to it a ready state example reading U CALL TITAN in amber;
- pilot tactical ability: GRAPPLE with two charge pips (one full, one refilling) and key chip Q;
- weapon panel lower right: primary rifle 24 | 120 with the existing icon style, below it the anti-titan weapon CHARGE RIFLE with a small charge bar and key chip 3;
- health bar lower left labelled INTEGRITY 100;
- context prompt above the crosshair zone, lower centre: T RODEO for an enemy mech close by, and a held variant RIPPING BATTERY with a radial progress ring; a small battery icon chip BATTERY CARRIED near the health bar;
- small killfeed top right with mech kill rows.
Option 1: minimal edge-anchored panels, titan meter as a horizontal segmented bar bottom centre under the crosshair, score as a compact top strip.
Option 2: titan meter as a hexagonal radial gauge bottom left beside health, score as a wider top bar with per-team progress, tactical pips around the crosshair.
Keep the centre of the screen clear for aiming. Mobile insets keep the same elements in safe areas with touch buttons for jump, slide, tactical and call titan. No real game branding, no logos, no chat panels, no fictional extra metrics, only the listed labels.
```

### hud-titan

```text
Use case: ui-mockup. Asset type: in-cockpit HUD design reference for piloting a giant 7 m battle mech in an existing browser voxel shooter. Create one wide image containing two clearly separate alternative cockpit HUD layouts side by side, labelled OPTION 1 and OPTION 2, each showing a desktop landscape 16:9 screen and below it a smaller mobile portrait 9:16 inset of the same layout. Existing HUD identity to match exactly: near-black charcoal glass panels (#0b0e12 at 93% opacity) with slim 1 px slate borders (#3a4250) and small chamfered corners, amber accent #ff9f1c, condensed uppercase Rajdhani-style typography with wide letter spacing, sky blue #38bdf8 for own team and shields, orange #fb923c for enemy, health green #7fd069, danger red #ff3355. View: first person from inside the mech cockpit looking out over the actual blocky voxel world (sunny sky with soft cartoon clouds, grey concrete voxel ground, rust-red girders, sandstone banks, everything made of visible cubes) at an enemy mech in desert camouflage 60 m away. The cockpit frame is part of the HUD: dark gunmetal voxel struts angling in from the screen corners and a thin top brace, with faint panel seams and small multi-function display tiles, leaving a wide clear view in the middle.
Functional HUD elements, compact and practical for HTML/CSS:
- hull health: a long segmented bar with a blue shield overlay on top of the green health segments, readout 7200 / 10000 and SHIELD 1500;
- dash pips: three small chevron pips, two full and one refilling;
- ability cooldown tiles with key chips: Q VORTEX SHIELD (ready), E LASER TRIPWIRE (cooldown ring 40%), G LASER SHOT (ready);
- core meter: CORE 86% with key chip V, glowing when full;
- primary weapon ammo: SPLITTER RIFLE 34 | energy bar;
- titan crosshair: a larger bracket reticle with range readout;
- doom warning example: a red flashing banner DOOMED with a draining red bar and a prompt HOLD X EJECT in a chip;
- small attrition score strip at top centre MILITIA 142 / IMC 128 and timer.
Option 1: clean edge panels, health bar bottom centre, abilities bottom right, core gauge as a vertical bar on the right strut.
Option 2: elements integrated into the cockpit struts as glowing display tiles, health as an arc under the reticle, core as a radial ring around the reticle.
Mobile insets keep the cockpit struts thin and place dash, abilities, core and eject as touch buttons in safe areas. No real game branding, no logos, no chat panels, no fictional extra metrics, only the listed labels.
```

### loadout

```text
Use case: ui-mockup. Asset type: full-screen loadout menu design reference for a giant-mech team deathmatch mode in an existing browser voxel shooter, shown on spawn and after death. One wide desktop 16:9 screen, with a small mobile portrait 9:16 inset in the lower right corner showing the same screen stacked vertically. Match the existing deploy menu exactly: a dimmed blurred voxel battlefield behind, near-black charcoal glass panels (#0b0e12 at 93% opacity) with slim 1 px slate borders (#3a4250) and small chamfered corners, big spaced-out white uppercase title at top left, condensed uppercase Rajdhani-style type with wide letter spacing, sky blue #38bdf8 for the selected item border and team label, amber #ff9f1c to #ffb84d gradient for the primary button, muted grey sub-labels, simple flat line icons.
Content:
- top left title LOADOUT, sub-line MILITIA · ATTRITION, top right a small panel RESPAWN IN 3.0;
- left column PILOT: three rows of selectable cards. PRIMARY with five weapon chips (RIFLE, SMG, SHOTGUN, LMG, KRABER) with one selected; ANTI-TITAN with four chips (CHARGE RIFLE, ARCHER, THUNDERBOLT, MGL); TACTICAL with three chips (GRAPPLE, STIM, CLOAK), each chip has a small flat weapon or ability silhouette icon; a one-line description under the selected tactical;
- right side TITAN: five tall portrait cards in a row, each showing a small rendered voxel battle mech in woodland camouflage made of visible cubes on a dark backdrop, with its name and frame: ION ATLAS, SCORCH OGRE, NORTHSTAR STRYDER, RONIN STRYDER, LEGION OGRE. The selected card (ION) has a blue border and a glow; below the cards a detail strip for the selected titan with its kit as small labelled tiles: SPLITTER RIFLE, VORTEX SHIELD, LASER TRIPWIRE, LASER SHOT, LASER CORE, and three tiny stat bars HEALTH, SPEED, DASH;
- bottom right a large amber button DEPLOY · 3.0.
The mech portraits: ION boxy chest with one round blue optic and a long rifle; SCORCH bulky dome cockpit with a stubby orange-banded launcher; NORTHSTAR slim tall with a long cyan rail cannon; RONIN slim with a long sword and two head fins; LEGION bulky with a huge rotary cannon arm.
No real game branding, no logos, no currency, no shop, no chat, only the listed labels.
```
