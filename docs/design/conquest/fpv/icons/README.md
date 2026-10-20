# FPV drone slot art

Request: proper images for the Engineer's FPV drone wherever the UI pictures it, in the style of the other weapon and gadget art (the RX-8 and STINGER side profiles in `public/assets/weapons/hud/`).

Before: the drone had no slot art. The kit wheel drew its one-colour glyph (`ICON_PATHS.fpv`, the quad from above) as an SVG data URL, the kill feed showed the same glyph, the deploy-screen toggle and the touch FPV / CUT button were text only.

- `prompt-*.txt` + `ref-*.jpg`: gpt-image-2 alternatives (`~/.codex/skills/codex-imagegen-models/scripts/codex_images.py --model gpt-image-2 --size 1536x1024 --quality high`, returned 1774×887). The endpoint has no image input, so the prompts describe the existing slot art (olive drab, gunmetal, beveled voxel inventory style, readable at 64 px on a navy panel). The refs are shown on the HUD navy.
  - **A (chosen)**: low three-quarter side view, nose right. The four rotors read as a quadcopter even at kill-feed size, and the olive warhead with its yellow bands says "kamikaze" and matches the launchers' palette.
  - B: steep top view. The clearest X, but the prop blur discs took the magenta key colour and it reads as a toy at small sizes.
  - C: flat profile. Mostly warhead: at 38 px it is mistaken for a rocket.
- Processing (`tools/imagegen-hud-icon.py <source.png> <out.png> [key]`): alpha under 24 cut (a magenta chroma key for the outputs that came back opaque), cropped to the alpha box, fitted into the launchers' 446×188 box on a 480×240 canvas, then quantized to 256 colours (19 KB). Output: `public/assets/weapons/hud/fpv.png`.
- `captures/`: muted CDP captures of the static Conquest HUD page (kit wheel with the FPV segment, the deploy-screen gadget toggles, the kill feed), desktop 1440×900 and phone portrait 390×844.

The glyph stays for the map markers, the vehicle card and the FPV strip, where every hull is a one-colour glyph.
