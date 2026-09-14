# Codex Astra review — BALLISTA vs AWM (2026-09-14)

Model: gpt-6-astra via `codex exec`. Inputs: render-side.png + render-hero.png.
Task: review only, prioritized defects vs the Accuracy International AWM.

## P1
- Receiver + scope stack too tall; mount reads as carry handle with an open
  window; rings should sit close to the rail.
- Stock opening too skeletal; missing the integrated AWM thumbhole mass.
- Central body too boxy/deep slab.
- Bolt handle/knob not readable in these views (both show the right flank;
  the bolt lives on the left).
- Bipod not identifiable; reads as a second fore-end.

## P2
- Scope tube long/thin, abrupt oversized objective bell, weak eyepiece.
- Rings read as rail brackets, rear ring crowded at the turrets.
- Turret layout unclear; orange dial + side cylinder near ocular end.
- Cheek pad far below sight axis (a real 0.205 sight line consequence).
- Butt pad thin/hard; no adjustment hardware read.
- Grip crude plank; thumbhole relationship unconvincing.
- Trigger/guard not legible at this distance.
- Fore-end fragmented; barrel root collars read as clamped pipe.
- Barrel too uniform; muzzle tip capped/unresolved.
- Magazine too narrow; magwell transition ambiguous.
- Black dominates; olive mass missing (reviewer saw scattered plates).

## P3 (materials)
- Wear too uniform across metal/polymer/rubber/fabric.
- Olive reads as distressed wood/stone; black metal too rough.
- Orange accents + blunt sleeve rounds distract from AWM.
- Ocular glass opaque, no recess.
- Teal cheek pad fights the palette.
- Micro-detail (labels, scratches) outshines defining shapes.

## Verdict
Readable stylized sniper rifle, weak AWM match: elevated scope platform,
skeletal stock, slab receiver.

## Calibration (author notes, same day)

- "Open window / pillars" was STALE at review time: windowed cradles had been
  replaced with solid blocks; the remaining height is the frozen sight line.
- Bolt/bipod/trigger complaints were partly VIEW SELECTION: the bolt is on
  the left flank, but only right-side views were sent.
- Scope height, barrel diameter, muzzle width, aperture floor are frozen by
  the runtime contract and cannot follow the AWM without breaking the slot.
- Texture sameness is inherent: all parts share six ImageGen maps by contract.

## Round 2 (three views) — NOT HAPPY, two defects

- Trigger opening cramped: deepened (guard bow -0.052 -> -0.070, taller
  opening, air under the blade).
- Rear rail overhang: high rail shortened to end behind the eyepiece, mount
  bar and cheeks flushed with it.

## Round 3 (three views) — HAPPY

No remaining changeable-geometry defects. Frozen items (sight height, bore
radius, muzzle ceiling, shared maps) accepted as out of scope. Loop closed.

## Round 4 — final acceptance (articulation proof) — HAPPY, first pass

Inputs: `contact-articulation.png` (same-camera triptych: pose-home control,
pose-bolt-open at full 0.16 throw + 0.5 rad lift, pose-mag-drop 80 mm +
15 deg tilt) + `contact-angles.png` (five delivered angles). Poses move ONLY
`bolt`/`mag` node transforms about their own content centres
(`tools/blender/ballista/pose-ballista.py`); zero geometry/material/UV edits.
One script iteration before review: rotations re-based from world-origin arcs
to pivot-compensated in-place rolls so the 80 mm drop reads exact.
Verdict: HAPPY — bolt clears the trough with the handle lifted and readable,
daylight between magwell and dropped mag, home matches delivered angles, no
floating/clipping. No P1/P2 outside the frozen contract. Geometry untouched,
fresh GLB reimport still passing (18,236 tris, 19 prims, 0 failures).
