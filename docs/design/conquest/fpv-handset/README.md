# FPV drone launch and link loss

Request: "Add animations to the drone: the character moving a screen to the camera. Noise, then the drone UI. Same on detonation: SIGNAL LOST, then the screen goes down."

- `ref-a/b/c-*.jpg` + `prompt-*.txt`: gpt-image-2 storyboards (raise, SIGNAL LOST, lower) over the current Conquest HUD (navy ticket bar, the FPV strip from `docs/design/conquest/fpv/`).
  - **A (chosen)**: a rugged olive ground-control handset with rubber corner bumpers, a screen in the middle, a stick and a red toggle on the side grips and two stubby antennas, held by both grips. SIGNAL LOST on a navy plate with a red accent bar and NO VIDEO LINK. It is box-built like the guns, and the plate is the HUD's own card style.
  - B: a slim tablet with a sunshade hood and a red SIGNAL LOST in corner brackets. The hood hides the screen in the raise, and the red-on-snow text has no backing.
  - C: a sand box radio with a flip-up screen and one whip antenna, held in one hand. It reads as a toy and covers too little of the view to "fill" it.
- `captures/` (`node tools/fpv-handset-capture.mjs`, muted CDP, desktop 1440×900): the sequence in order. `1-3` the raise (150 / 330 / 440 ms, the screen shows static with CONNECTING), `4-5` the boot static over the feed (boot 0.85 and 0.35), `5b` the clear feed, `6` SIGNAL LOST, `7-8` the lowering (the screen shows SIGNAL LOST), `9` the weapon drawn again 200 ms later, and `third-person-*` an operator holding the handset in third person (`avatar-capture.html?fpv=1`).

Compared with A: the same handset shape, colours and grip hold, and the same SIGNAL LOST plate. The world markers and the reticle markers drop off the lost frame, while the ticket bar and the kill feed stay. The capture pages have no live drone camera, so the feed frames use the usual fixture scene and the handset frames use a map still.

Timing (`FPV_TRANSITION` in `public/js/session/fpv-transition.js`, client presentation only, the server's drone timing unchanged): raise 450 ms (the drone already takes the keys), boot static 250 ms, SIGNAL LOST 600 ms (250 ms when a hit on the operator cut the link), lower 400 ms, then the weapon draws. A drone that ends during the raise skips SIGNAL LOST. Reduced motion drops the raise and the lowering but keeps the static and SIGNAL LOST.
