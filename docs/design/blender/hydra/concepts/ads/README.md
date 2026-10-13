# FURNACE aiming pose

`aim-options.png` was generated with the built-in ImageGen tool using the actual
desktop aiming capture and cold hero view. `prompt.txt` records the exact prompt.

The final direction follows the user's clarification: aiming braces the heavy
gun at the side, brings it slightly closer, adds mild zoom and slows look input.
Alternative C represents this framing intent. Its generated geometry is only a
rough composition reference; the shipped Blender model provides the geometry.

The runtime retains a sideways hold in ADS and keeps the center target clear.
It uses 1.15× zoom and a 25% sensitivity reduction beyond zoom compensation.
The five heat cells remain visible on desktop and portrait mobile. No material
or geometry changes were needed for this aiming adjustment.

Compare the implemented `../../captures/desktop-scoped.png` and
`../../captures/mobile-scoped.png`. Run `node tools/hydra-browser-test.mjs` for
fresh real-model captures and the clear-center/visible-temperature checks.
