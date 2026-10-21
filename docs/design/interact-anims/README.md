# Hold-to-use interaction animations

Request: "außerdem will ich animationen für die special points (hacken, bombe planten, ...)": animations for the hold interactions.

- `ref-a-field-kit.jpg` + `prompt-a-field-kit.txt`: gpt-image-2 first-person storyboard (place a device, first aid, repair, hack). Earlier wordings with explosives, bombs and wire cutters were refused by moderation, so the prompts describe a neutral "objective device".
- `ref-b-world-and-third-person.jpg` + `prompt-b-world-and-third-person.txt`: third-person poses (kneel and plant, medic over a mate, engineer at a jeep) and the device prop's blink states (SLOW, FAST, FINAL) with the bigger timer variant.
- Both sheets were used, one for each half. A gives the gloves on the work with the gun stowed, the tablet and the wrench with spark cubes. B gives the one-knee kneel with the torso leaning over the hands, and the olive-tan block with black tape, a grey keypad and a red LED on top (the big variant is the S&D bomb).
- `captures/` (`node tools/interact-anims-capture.mjs --sizes desktop,portrait`, muted CDP, the real ViewmodelRig and avatar on `public/interact-anim-capture.html`):
  - `desktop-*`: each kind mid-hold plus its finishing beat, and a plant cancelled 90 ms after the release.
  - `portrait-*`: plant and revive at 390×844.
  - `third-*`: the third-person poses.
  - `world-charge`: the world props (the lit S&D bomb with its halo, plus a small charge).

Compared with the references, the hands, props and poses follow A and B in the game's box-built style. The scene is a flat capture floor, not a map. The revive mate in the first-person shot is a stand-in avatar lying on its back, so it sits higher than a real corpse. The capture page has no HUD. In the game the hold ring sits under the crosshair, above the hands.
