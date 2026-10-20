# Mobile AA HUD

Task: a mobile AA vehicle for Conquest on Frontier. The driver fires twin 35 mm proximity-fused flak and needs to find aircraft, lead them and manage heat.

- `aa-hud-a/b/c-reference.png` + `.prompt.txt`: gpt-image-2 alternatives, each built on the current Conquest HUD (ticket bar, minimap, squad list, vehicle panel, EXIT pill).
  - **A (chosen)**: a round heading-up radar scope (200/400 m rings, sweep wedge, enemy orange and friendly blue triangles, gun wedge) centred above the EXIT pill, captioned `AA RADAR · 400 M · 2 CONTACTS`. It adds a heat arc on the right of the reticle (`HEAT 46%`) and an orange `TRK 312 M` box on the tracked aircraft, with a dashed line to the lead diamond.
  - B: a flat bearing/elevation radar strip under the ticket bar and a heat bar under the reticle. It puts the radar where the eye isn't, and the strip competes with the flag chips and the view strip.
  - C: the radar is a square screen inside a taller vehicle panel, with off-screen contacts as chevrons on a large dashed reticle. The panel would grow past its phone budget and the radar would sit in the corner.
- `aa-model.prompt.txt` + `aa-model-reference.png`: the hull reference for `makeAaModel` (tank-style tracked hull, boxy turret with twin side cannons, a spinning search radar on the turret rear, a .50 RWS).
- `captures/`: the implementation in real browser captures (muted CDP: `node tools/conquest-hud-capture.mjs --only aa-driver,aa-overheat --out docs/design/conquest/aa/captures`) at desktop 1440×900, phone portrait 390×844 and phone landscape 844×390. `aa-driver` is heat 46 % with an enemy helicopter tracked at 322 m. `aa-overheat` is overheated with the contacts off the gun line. `capture-report.json` lists no overlaps.

Compared with A: the layout matches (scope centred above the EXIT pill, the heat arc hugging the reticle, the TRK box with range and a dashed lead line to the diamond). The colours follow the HUD's team palette: enemy orange, friendly cyan, scope green, heat amber, then orange above 75 %, then red `OVERHEAT`. The vehicle panel stays the standard one, which shows the 35MM FLAK heat bar and SMOKE READY rather than the reference's segmented bar.

Phone sizes:
- In portrait the scope shrinks to r 54 and sits below the EXIT pill, between the move stick and the SMOKE button.
- In landscape it shrinks to r 44 and sits left of the EXIT pill, at the bottom.
- On desktop it sits higher (r 66 at h−276), so it clears the EXIT pill.
- The scope rect goes into the reticle `reserved` list, so the edge markers keep clear of it.

The HUD capture page draws no vehicle models, so the gun barrels from the reference appear only in game.
