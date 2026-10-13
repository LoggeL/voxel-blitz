# M-6 FURNACE rotary model

Generated with the built-in ImageGen tool. `prompt.txt` is the exact prompt;
`furnace-options.png` contains alternatives A, B and C. The input reference was
the previous HYDRA contact sheet at `../contact-hydra.png`.

Selected: A. Its compact cylindrical receiver, exposed six-barrel cluster,
open collars and skeletal shoulder brace give the minigun a distinct silhouette.
The drum, feed belt, foregrip and existing hand and muzzle anchors remain part
of the Blender model. The sight channel stays clear above the bearing.

The concept is a modeling reference. Spin, heat and overheat presentation use
the existing game state. The runtime rotates the actual barrels and collars;
heated barrel materials and individually controlled temperature cells belong
to each weapon instance.

Review the actual browser captures in `../captures/` against alternative A.
The regression command is `node tools/hydra-browser-test.mjs` and covers the
loaded Blender asset, visible vertex movement, heat isolation, first-person
and avatar rigs, and desktop/mobile framing.
