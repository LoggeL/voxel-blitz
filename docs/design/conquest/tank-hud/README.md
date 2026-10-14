# Tank hull indicator

Feedback: "Panzer muss anzeigen, wo geradeaus ist, wenn die Kanone dreht."

- `before/`: the tank HUD before this change (driver, commander; desktop, portrait, landscape).
- `tank-hud-a/b/c-reference.jpg` + `.prompt.txt`: gpt-image-2 alternatives.
  - **A (chosen)**: Battlefield-style top-down tank under the reticle, turret up, hull turned by its offset, `HULL 310°` + `◀ 50°` readouts.
  - B: compass ring around the reticle with a hull chevron, plus a rotating silhouette in the vehicle card (the ring crowds the range ladder and flag markers).
  - C: heading tape under the ticket bar with a hull caret (eyes leave the reticle; the top bar is already busy).
- `captures/`: the implementation (`node tools/conquest-hud-capture.mjs --only tank-driver,tank-commander --out docs/design/conquest/tank-hud/captures`). The tank-driver fixture's hull is turned 50° left of the gun and crawls forward; the commander looks 0.3 rad left of the hull (hull reads `▶ 17°`).

Compared with A: same placement (centred above the `EXIT TANK` pill), same colour split (white hull, green turret, green offset readout) and the travel wedge. The heading uses the HUD's own compass convention, so the fixture reads `HULL 024°`. The generated image drew the hull turned the wrong way for its own `◀` label; the implementation turns it to the side the arrow names.
