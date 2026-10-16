# Titan embark: hatch close and cockpit boot

Feedback: "Bei Titanfall baut sich beim Einsteigen in den Titan der Screen aus verschiedenen Elementen zusammen: Zwei Teile kommen von einer Seite, eins von der anderen, sie setzen sich zusammen, und erst dann geht der Screen an."

- `embark-a/b/c-reference.jpg` + `.prompt.txt`: gpt-image-2 storyboards (four first-person frames each, inside the existing cockpit).
  - **A (chosen)**: two plates slide in from the left (upper, then lower), one plate from the right whose pointed edge closes the gap; the three lock along a Y seam with a cyan flash and sparks; the cabin goes dark; the closed hatch's inside powers on like a monitor, a bright line across the middle opening into the outside feed, NEURAL LINK on the glass, the pods coming up one by one. It is the sequence the feedback describes, and every beat maps onto parts the cockpit already has (glass shader, power stages, banner, sparks).
  - B: two scissor plates hinge in from the left, a wedge from the right, red seam lamps turn cyan, and the picture resolves from coarse voxel blocks. The block resolve suits the art style, but the hinged plates sweep through the cabin's pods and the mosaic hides the crosshair area longest.
  - C: three trapezoid segments close like an iris (two from the top left, one from the bottom right), a SYSTEM CHECK screen, then a diagonal wipe. It looks good, but the iris reads as a camera shutter, not as two plates from one side and one from the other, and the wipe hides one side of the view longer.
- `captures/`: the implementation, held at each beat with `pinTransit` (`node tools/titanfall-cockpit-fx-capture.mjs --titans ion,legion,northstar --sizes desktop,landscape,portrait --states hatch-closing,hatch-right,hatch-lock,screen-line,screen-open,screen-settle,boot-hud,exit,exit-plates --out docs/design/titanfall/embark/captures`): ATLAS (ION), OGRE (LEGION) and STRYDER (NORTHSTAR) cabins at 1920×1080, 844×390 and 390×844.

| State | t (s after `titan_embark`) | Shows |
|---|---|---|
| `hatch-closing` | 1.10 | upper left plate nearly home, lower left plate sliding in, daylight through the rest |
| `hatch-right` | 1.21 | the right plate arriving, a narrow chevron of daylight along the seam |
| `hatch-lock` | 1.30 | all three home, the Y seam flashing cyan, the cabin dark, lamps cyan |
| `screen-line` | 1.45 | black screen, the bright line across the middle, NEURAL LINK |
| `screen-open` | 1.56 | the feed opening, cyan tint with scanlines and rolling bands, MFDs coming on |
| `screen-settle` | 1.70 | the feed settling into the plain glass, pods on |
| `boot-hud` | 1.95 | glass HUD up, LINK ESTABLISHED / PILOT ONLINE |
| `exit` | 0.03 after `titan_disembark` | screen cut to black, HATCH OPEN |
| `exit-plates` | 0.10 after `titan_disembark` | the plates parting (right plate gone, the left ones leaving) |

Compared with A: the implementation has the same plate order and directions, the same Y seam with hazard bands on the leading edges, the cyan seam flash, the dark beat, the line-to-picture power-on with a cyan feed tint and NEURAL LINK on the glass, and the staggered pods. The differences:

- The plates are the cockpit's dark gunmetal with ribs and bolts instead of A's lighter panels.
- The seam sparks come from the cockpit's spark emitter at the moment of the lock, so held captures do not show them (`tools/titanfall-model-budget-test.mjs` checks them).
- The STRYDER side panes have no plates; they go dark and power on with the main screen.
- A drew the screen pods already lit during the close. Here they stay dark until after the screen is on, so the sequence reads close, lock, dark, power-on.

Timeline and rules: `docs/titanfall.md` §7.2, Embark and disembark (`public/js/titanfall/titan-embark-boot.js`).
