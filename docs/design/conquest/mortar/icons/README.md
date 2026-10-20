# M-81 mortar slot art

Request: proper images for the Support's M-81 MORTAR wherever the UI pictures it, in the style of the other weapon and gadget art (`public/assets/weapons/hud/`).

Before: the kit wheel drew the one-colour glyph (`ICON_PATHS.mortar`) as an SVG data URL, the kill feed (`mortarHE`) showed the same glyph, the deploy-screen toggle and the touch MORTAR button were text only.

- `prompt-*.txt` + `ref-*.jpg`: gpt-image-2 alternatives, made and processed like the drone's (`../../fpv/icons/README.md`).
  - A: slim side profile. Clean, but at 38 px the thin tube and bipod vanish.
  - B: three-quarter view with a bomb in front. Round baseplate and a busy silhouette; it reads as a field gun.
  - **C (chosen)**: chunky voxel side profile, tube up to the right with the orange band, square baseplate, ammunition crate and the green sight. Closest to the in-world model (`docs/design/conquest/mortar/model/`), and the thick blocks survive the small sizes.
- Output: `public/assets/weapons/hud/mortar.png` (480×240 with alpha, 13 KB).
- `captures/`: the kit wheel's MORTAR segment and the touch MORTAR button (`mortar-ready`), desktop and phone portrait. The kill feed's mortar row is in `../../fpv/icons/captures/desktop-killfeed.jpg`.
