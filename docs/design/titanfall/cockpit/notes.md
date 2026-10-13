# Titan cockpits: notes

The interior a pilot sees from a titan's cockpit seat. Code: `public/js/titanfall/titan-cockpit.js`. Spec: `docs/titanfall.md` §7.2. Tests: `tools/titanfall-model-budget-test.mjs`, cockpit block. Captures: `tools/titanfall-cockpit-capture.mjs`.

## Concepts

Three concepts were made with ImageGen (gpt-image-2 through `codex_images.py`). Each one's prompt is in the `.prompt.txt` file next to it.

| Concept | Idea |
|---|---|
| `cockpit-a-reference.jpg`, **ARMOURED HATCH** (chosen) | An octagonal hatch viewport in a heavy bolted strut ring with hazard edges. A console with three MFDs, side key banks and control sticks. OGRE has a low, wide visor under a heavy brow. STRYDER has a tall trapezoid with side panes. |
| `cockpit-b-reference.jpg`, segmented canopy | Three canopy panes on thin mullions. Lighter, more aircraft-like. |
| `cockpit-c-reference.jpg`, sensor pit | A tunnel-like pit with a narrow slit and screens all round. |

**Why A was chosen:**

- It matches the titan HUD reference (`../hud-titan.png`, option 2). There, the DOM weapon tile and core tile sit on the upper diagonal struts, and A has exactly those struts.
- It gives each frame class the clearest silhouette.
- The idea suits a closed hull that has to stay closed at every FOV.

**What was borrowed from the others:**

- STRYDER's side panes, from B.
- The grab bar and the red roof beacon, from C.
- Every concept viewport was enlarged to make room for gameplay.

## How it works

**A view model, not world geometry.**

- The cabin is built in eye space and placed on the camera on every render: `camera.matrixWorld × scale(kx, ky, 1) × sway`.
- The scale maps any camera FOV or aspect onto the cockpit's own frustum, `cockpitFrustum(aspect)`. That frustum has a 75° base and widens on narrow screens.
- Because of this, the settings FOV (65–100), speed widening (+8), the titanfall punch (+9), 21:9 screens and phones all frame the same closed cabin. No gap can open.
- Sway: the cabin lags the look by ≤ 0.016 rad, and a hit jolts it by up to 0.012 rad.
- Depth: the vertex shader squeezes the cockpit into the front 2 % of the depth range, so neither the world nor the titan's own hull pokes through.
- Any camera more than 2.5 m from the hull eye gets a zero-scale cockpit. This covers chase cams, other players and captures.

**Draws and geometry.**

- 7 draws: shell (baked vertex lighting), keys, warn, accent, screens, glass and sparks. That is about 7–8 k triangles.
- Geometry is cached per frame class and reference-counted. All programs are in `TITAN_WARMUP_MATERIALS`.

**Live MFDs.**

- One 1024×512 canvas atlas, redrawn at 6 Hz from `titanModel(row)`. That is the same model the DOM titan HUD reads, so nothing on the console can drift from the game state.
- **Status:** hull, shield, doom and eject, plus dash pips.
- **Radar:** heading and core ring.
- **Weapon:** ammo, reload, ability tiles, smoke and lock.
- **Aux:** a per-titan gauge: ENERGY / THERMAL / RAIL CHARGE / SHELLS / BARREL.
- **Caution grid:** SHLD / HULL / CORE / DOOM / BATT / RIDR.
- On phone portrait (aspect < 0.8) the screens stay dark, because the touch layout owns that band.

**Reactive lamps.**

| Trigger | Effect |
|---|---|
| Doom | Red lamps flash at 3 Hz, the cabin pulses red, sparks fall every 0.7 s, and the glass gets a red pulse. |
| Lock | The lamps flash amber. |
| Core ready | The accent strips pulse. |
| Core active | The accent strips glow brighter. |
| Hit (hull + shield drop > 40) | Everything flickers for 0.22 s, sparks fly and the cabin jolts. |

## Iterations (scratch captures, 1920×1080 unless noted)

1. **First build.**
   - Hazard stripes were missing on half the ring: the quad winding was wrong, and `ccw()` reversed the shared window arrays in place.
   - The MFD gradient crashed under the node test stub.
   - All three were fixed.
2. **Detail pass.**
   - Added: plating panels kept clear of every window, side consoles, cables, vents and the per-class brow, truss and handles.
3. **All sizes, plus HUD composites.**
   - OGRE's MFDs were cut off at the bottom, so its viewport bottom was raised to −0.27.
   - The aux gauge sat off-screen, so it moved onto the deck at u −0.66.
   - No MFD overlapped a fixed DOM panel at any size.
4. **Viewport and depth.**
   - The ray test measured only 26–30 % of a 16:9 screen as glass. The straight reveal of the 0.12 m bulkhead plus the 0.1 m ring ate the window.
   - Fix: the main ring is now a thin face plate, and the ring body behind it opens along the eye rays. The bulkhead is a thin skin with the hole scaled by distance. The frame still reads as a thick hatch, but there is no visible reveal.
   - The viewport is now **ION 44 %, OGRE 39 %, STRYDER 38 %**.
   - OGRE's MFDs z-fought with their bezels: the screen face was coplanar with the bezel front, and the near-depth trick leaves little precision. Screens now float 8 mm proud of the bezel, and the caution and aux screens 7 mm.

## Final captures (`captures/`)

`tools/titanfall-cockpit-capture.mjs --hud ion,legion`, muted CDP, one capture slot:

- **Cockpit shots:** `<size>-<titan>-<state>-fov<N>.png`
  - all five titans;
  - sizes desktop 1920×1080, ultrawide 2560×1080, portrait 390×844 and landscape 844×390;
  - settings FOV 65 and 100;
  - states idle, doom and core ready;
  - 120 shots in total.
- **HUD composites:** `<size>-hud-<titan>-<state>.png`. These show the stock titan HUD fixture page over the cockpit at FOV 75.
- **Report:** `capture-report.json`.

**Overlap check.** Each MFD rect is projected through the cockpit frustum and compared with each fixed DOM HUD panel.

- No fixed panel overlaps at any size.
- Landscape: the weapon MFD sits under the DASH and DEFENSIVE touch buttons. This is reported but not fatal, because touch buttons sit over everything.
- Portrait: the screens are dark by design.

## Open points

- Eye adaptation: the post chain is centre-weighted and only brightens. It has not been checked in a live match with the cabin filling the screen edges.
- Sway, jolt and sparks are not visible in static captures. The node test covers their state.
- At 1280×720 the MFD text is small. The DOM HUD stays the authoritative read-out.
- Landscape phones: the touch buttons cover the weapon MFD.
