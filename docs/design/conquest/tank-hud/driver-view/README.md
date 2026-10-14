# Tank DRIVER view

Feedback: "Zusätzlich hätte ich gerne noch eine Kameraansicht für den Panzerfahrer mit dem HUD und den Informationen drauf, damit alles schön integriert ist."

- `before/`: the tank driver's HATCH (`cockpit`) and CHASE views before this change, desktop 1440×900, phone portrait 390×844 and landscape 844×390 (`node tools/conquest-tank-driver-capture.mjs --views cockpit,chase --out docs/design/conquest/tank-hud/driver-view/before`).
- `driver-view-a/b/c-reference.jpg` + `.prompt.txt`: gpt-image-2 alternatives.
  - A: an armoured vision block with a heavy bezel and analogue gauges (immersive, but the bezel eats a third of a phone screen and hides the flag markers).
  - **B (chosen)**: a clean digital periscope display: corner brackets, a heading tape under the ticket bar with the hull heading boxed, and one instrument bar at the bottom (speed + gear, turret against hull, shell + reload, hull integrity + smoke). It reuses the HUD's panel style and leaves the window clear.
  - C: a monochrome vision-TV feed with scan lines (reads as a sensor, not a driver's view, and the tint fights the team colours).
- `captures/{desktop,portrait,landscape}-driver.png`: the implementation on the vehicle capture page (real VehicleView and VehicleCamera; `node tools/conquest-tank-driver-capture.mjs --views driver`). Gun 34° right of the hull, 23 km/h.
- `captures/hud/`: the full Conquest HUD fixtures `tank-driver`, `tank-commander` and `tank-periscope` (`node tools/conquest-hud-capture.mjs --only tank-driver,tank-commander,tank-periscope --out docs/design/conquest/tank-hud/driver-view/captures/hud`), checked for overlaps with the ticket bar, V view strip, squad list, minimap, exit prompt and touch buttons.

Compared with B: same structure (brackets, tape with the boxed heading, four-cell bottom bar). The tape sits under the V view strip instead of under the ticket bar, and the bar keeps right of the squad list, so on 1440 px it is 30 px right of centre. Phones have no room for a bottom bar beside the stick and FIRE, so the four cells become a 2×2 panel in the vehicle card's place (the card hides in this view); portrait drops the tape for a `DRIVER · HDG` header. The generated image showed the glacis at the bottom and the barrel overhead; from the periscope eye (front left of the glacis, clear of the turret at every yaw) no own hull or barrel is in frame, so the view is the window and the instruments alone.
