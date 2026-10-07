# Conquest v2 vehicles: design references and prompts

Work package WP6 of the Conquest "Frontier" redesign (spec §2 F9, §6). The page covers the voxel hulls, team camouflage, effects and per-seat cameras.

## References used

The three references in this folder were generated with gpt-image-2 through the Codex image endpoint on 2026-10-07. The exact prompt for each image is in the `*.prompt.txt` file next to it, and prompts A–C below repeat them.

| Reference | Prompt | Used for |
|---|---|---|
| `fleet-sheet-reference.jpg` | `fleet-sheet.prompt.txt` (prompt A) | Silhouettes, detail, camouflage and team markings of all five hulls |
| `damage-states-reference.jpg` | `damage-states.prompt.txt` (prompt B) | The intact, damaged, burning and wreck presentation |
| `effects-board-reference.jpg` | `effects-board.prompt.txt` (prompt C) | The vehicle effects (not changed in this pass, see below) |

The first WP6 pass (before these images existed) was designed from `docs/design/conquest/frontier-fleet-hero.png`, `docs/design/conquest/tank-model.md`, `docs/design/conquest/jeep-model.md` and the aircraft notes in `docs/design/conquest/aircraft/`.

### Prompt A: fleet sheet (chosen direction)

Use case: stylized-concept. Asset type: vehicle design sheet for a browser voxel shooter. Primary request: one wide sheet showing five military vehicles built from 0.2 m voxels with greedy-meshed flat faces, crisp ambient occlusion and a thin light edge highlight on every convex edge:
- a main battle tank with an angular turret, a long gun with a slotted muzzle brake, a remote weapon station on the turret roof, two banks of three smoke launchers, segmented side skirts and visible roadwheels inside the belts;
- an open utility jeep with a pintle-mounted heavy machine gun and a small gun shield;
- an attack helicopter with a stepped tandem canopy, stub wings carrying two rocket pods and a chin gun turret;
- a utility transport helicopter with wide open side doors, a door gun on each side and a bench cabin;
- a twin-tail strike jet with wing rails carrying two missiles, twin nozzles and a bubble canopy.

Show every vehicle twice: WEST in woodland camouflage (olive and dark green blots with a small olive-brown share, white team stripe, blue roundel) and EAST in desert camouflage (sand, tan and dark khaki blots, black team stripe, orange roundel). Three-quarter hero view, warm low sun, neutral grey ground. No branding, no text except small labels.

### Prompt B: damage states

The same tank and transport, each in four states left to right: intact; damaged (soot creeping across the paint, a smoke trail from the engine deck); burning (flames and embers from the engine, dark smoke); and wreck (fully charred, lamps dark, turret or rotor torn off, a tall smoke column). Voxel style as in prompt A.

### Prompt C: effects board

A board of the vehicle effects, voxel-friendly with soft particle sprites:
- the tank main-gun muzzle flash with a smoke ring and side jets from the brake, plus a ground dust cone;
- HMG tracers;
- a rocket pod salvo with smoke trails;
- flares;
- a tank smoke screen;
- rotor wash over dust and over water;
- an afterburner and contrails;
- tyre and track marks;
- hull hit sparks: a white spark for no effect, an orange spark with a scorch mark for an effective hit.

## Chosen direction and implementation notes

- **Voxel pipeline** (`public/js/vehicles/voxel-model/`):
  - 0.2 m voxels authored in hull metres;
  - a greedy mesher with exact per-vertex AO and an edge "lip" highlight;
  - one geometry per rigid part, cached per (type, team, variant);
  - wheels are authored at twice their size and meshed at half scale (0.1 m voxels), with flat faces so the instanced wheel stays cheap.
- **Material:**
  - one `MeshStandardMaterial` per hull with vertex colour plus an `aPal` attribute (roughness, metalness, emissive);
  - patched through `onBeforeCompile` with the constant key `vehicle-voxel-v2`;
  - character voxel lighting composed first;
  - damage presentation (soot, burn, lamps, near fade) is uniform-only, so it never changes the program.
- **Camouflage is baked per team** (`TEAM_SCHEMES`, `camoIndex` in `material.js`). Each palette is a ground coat plus independent blot fields, each with its own warped noise stretched along the hull, so blots are about 0.5–1.2 m and step per voxel like the reference.
  - WEST woodland: olive ground, mid-green and black-green blots, a small olive-brown share.
  - EAST desert: sand ground, tan and dark khaki blots, a few pale highlights.
  - `panel` uses the same blots in a slightly lighter coat; `drab` is the plain base coat for wheel dishes and fittings.
  - The model test checks a mean hull hue of 55–140° for WEST and 15–50° for EAST, with at least 25° between them.
- **Team markings, as on the fleet sheet:** a vertical stripe (WEST white, EAST black) and a roundel (WEST blue in a white ring, EAST orange in a black ring) on every type. The saturated blue/orange recognition panels of the first pass are gone. Blue and orange as own/enemy colours stay a HUD concept.
- **Per vehicle:**
  - *Tank:* low hull with a long glacis; arrow-head turret cheeks around a recessed mantlet; bustle with a stowage basket; a 0.4 m gun with a thermal collar, a fume extractor and a slotted muzzle brake; RWS with a sensor head; two banks of three stepped smoke tubes; segmented skirts raised so the painted roadwheels show; sprocket and idler; antenna whips; stripes on the skirts and turret flanks.
  - *Jeep:* flat bonnet over a slotted grille with corner lamps; flared fenders and wide rear quarters; half doors with the stripe; a two-pane windscreen; a roll cage; a pintle HMG with a gun shield, ammo can and grips; spare wheel, jerrycan and two whips; olive-rimmed wheels.
  - *Attack helicopter:* a narrow fuselage with a stepped, framed canopy (low front, tall rear); side nacelles; a rocket-pod face with tube mouths; wingtip rails with two missiles each; a chin gun with a flash hider; wheeled gear instead of skids; 0.4 m chord blades with painted tips.
  - *Transport:* glazed nose split into framed panes; open doors with slid-back panels, door guns on sill posts and a rear bench; twin roof engines; a split stabilizer clear of the tail rotor; wheeled gear under the cockpit.
  - *Jet:* grey radome; a boxy raked intake with dark mouths; a dorsal spine; tall twin fins with rudders; a fuselage stripe band; nozzles with petal rims; white missiles with seeker heads and red bands.
- **Damage:**
  - The char keeps a ghost of the camouflage, with stronger ash on upward faces.
  - Tank wrecks keep their belts and right skirt; the left skirt, turret, gun, RWS and stowage tear off.
  - Transport wrecks keep the tail boom; rotors, doors, engines, stabilizer halves and gear tear off.
- **Intentional differences from the references:**
  - The attack helicopter seats stay side by side (the seat hips in `shared/vehicle-defs.js` are gameplay data). The canopy is stepped front to back rather than truly tandem.
  - The hull dimensions, seat hips and mount pivots are unchanged, so the barrels, rotors and wheels sit where physics and cameras expect them.
  - The lighting is the game's, not the reference's warm low sun.
  - The weapon effects (muzzle flash, tracers, salvo, flares, smoke screen, rotor wash, afterburner, marks, hit sparks) were not changed: the capture page cannot show them.
- **Budgets** (alpha team, measured by `tools/conquest-vehicle-model-test.mjs`; the first pass is in brackets):

  | Type | Draws | Triangles |
  |---|---|---|
  | Jeep | 6 | 2,528 (2,878) |
  | Tank | 9 | 6,016 (4,040) |
  | Helicopter | 7 | 2,770 (2,382) |
  | Transport | 9 | 3,006 (2,592) |
  | Plane | 6 | 2,966 (2,308) |

  Every type is within the limits of ≤ 10 draws and ≤ 12 k triangles. Most of the tank's increase is its twelve round roadwheels (164 triangles each).

## Captures (serialized capture phase)

The static, muted capture page is `public/vehicle-capture.html` (`public/js/capture/vehicle-capture.js`). It has no audio code and makes no network calls.

The capture tool `tools/conquest-vehicle-capture.mjs` renders, for each type:
- hero, side, rear and top views;
- WEST and EAST;
- damaged, burning and wreck states;
- the WEST/EAST pair at 150 m. For this pair the page renders a hull-only mask (opaque hull voxels, no crew, glass, rotor disc, particles or ground). It then measures the saturation-weighted mean hue of the masked pixels, and the tool fails unless WEST is at least 20° above EAST. Before the mask, the box around a helicopter's rotor was mostly grass. The latest run measured jeep 80/42°, tank 69/38°, helicopter 81/40°, transport 79/45° and plane 75/38°.

Command (muted CDP; run only in the dedicated capture phase):

    node tools/conquest-vehicle-capture.mjs                    # all shots -> docs/design/conquest/redesign/captures/vehicles/
    node tools/conquest-vehicle-capture.mjs --type tank        # one type
    node tools/conquest-vehicle-capture.mjs --list             # list shot names

Compare the results against `fleet-sheet-reference.jpg` and `damage-states-reference.jpg` in this folder, and the prompts above, in `docs/design/conquest/redesign/captures/comparison.md` (owned by WP9).
