# Conquest v2 vehicles: design references and prompts

Work package WP6 of the Conquest "Frontier" redesign (spec §2 F9, §6). The page covers the voxel hulls, team camouflage, effects and per-seat cameras.

## References used

No ImageGen tool was available in the WP6 sessions (2026-10-07). Following spec §0.8, the hulls were designed from these existing references instead of new generated alternatives:

| Reference | What we took from it |
|---|---|
| `docs/design/conquest/frontier-fleet-hero.png` | Fleet composition and silhouettes: low tank with a long gun, open jeep, gunship, jet |
| `docs/design/conquest/tank-model.md` | Tank proportions: turret ring at y 1.66, gun pivot, sloped glacis, skirts, smoke launchers, belts |
| `docs/design/conquest/jeep-model.md` | Jeep landmarks: flat bonnet, slotted grille, roll bar, spare, jerrycan, antenna |
| `docs/design/conquest/aircraft/prompts.md`, `jet-parked.png`, `helicopter-final-live.png` | Aircraft silhouettes, canopy glass, the rotor blur read |
| `docs/design/conquest/vehicles/tank-driver-live.png` | The live third-person framing for drivers (the starting point for the chase profiles) |

The prompts below are the exact briefs for a later ImageGen pass. Keep them with any images that pass produces in this folder.

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
  - one geometry per rigid part, cached per (type, team, variant).
- **Material:**
  - one `MeshStandardMaterial` per hull with vertex colour plus an `aPal` attribute (roughness, metalness, emissive);
  - patched through `onBeforeCompile` with the constant key `vehicle-voxel-v1`;
  - character voxel lighting composed first;
  - damage presentation (soot, burn, lamps, near fade) is uniform-only, so it never changes the program.
- **Camouflage is baked per team.** WEST woodland greens dominate, so the hulls read green at range. The model test measures a mean hull hue of 55–140° for WEST and 15–50° for EAST, with at least 25° of separation. EAST is desert tan.
- **Team stripe and roundel:** high-contrast and on every type (turret roof, bonnet, tail boom, cabin flanks, wings).
- **Budgets** (alpha team, measured by `tools/conquest-vehicle-model-test.mjs`):

  | Type | Draws | Triangles |
  |---|---|---|
  | Jeep | 6 | 1,666 |
  | Tank | 9 | 4,014 |
  | Helicopter | 7 | 2,324 |
  | Transport | 9 | 2,518 |
  | Plane | 6 | 2,344 |

  Every type is within the limits of ≤ 10 draws and ≤ 12 k triangles.

## Captures (serialized capture phase)

The static, muted capture page is `public/vehicle-capture.html` (`public/js/capture/vehicle-capture.js`). It has no audio code and makes no network calls.

The capture tool `tools/conquest-vehicle-capture.mjs` renders, for each type:
- hero, side, rear and top views;
- WEST and EAST;
- damaged, burning and wreck states;
- the WEST/EAST pair at 150 m. For this pair the page measures each hull's mean hue, and the tool fails if the two hues are not separated.

Command (muted CDP; run only in the dedicated capture phase):

    node tools/conquest-vehicle-capture.mjs                    # all shots -> docs/design/conquest/redesign/captures/vehicles/
    node tools/conquest-vehicle-capture.mjs --type tank        # one type
    node tools/conquest-vehicle-capture.mjs --list             # list shot names

Compare the results against `docs/design/conquest/frontier-fleet-hero.png` and the prompts above in `docs/design/conquest/redesign/captures/comparison.md` (owned by WP9).
