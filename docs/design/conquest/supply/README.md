# Supply crates slot art

Request: the Support's AMMO CRATE and the Medic's MEDICAL CRATE (docs/conquest.md "Infantry supply") need slot art wherever the UI pictures a gadget: the deploy-card gadget toggle, the kit wheel's gadget segment and the touch AMMO / MED button, in the style of the mortar and FPV art (`public/assets/weapons/hud/`).

- `icons/prompt-*.txt` + `icons/ref-*.jpg`: gpt-image-2 alternatives (`~/.codex/skills/codex-imagegen-models/scripts/codex_images.py --model gpt-image-2 --size 1536x1024 --quality high`), two per crate, shown on the HUD navy. One quick pass.
  - **Ammo A (chosen)**: open olive crate, three-quarter view, brass cartridges and magazines inside, yellow chevron band. The cartridges say "ammo" at 38 px.
  - Ammo B: closed long case with a bullet stencil. Reads as a weapon case.
  - **Medical A (chosen)**: open white crate with red crosses, bandage rolls inside. Pairs with ammo A (same view, same open lid).
  - Medical B: closed white case, one big cross. Clear, but the long flat case does not match the ammo crate.
- Processing: `tools/imagegen-hud-icon.py <render.png> <out.png> key` (magenta key, cropped, fitted into 446x188 on 480x240, 256 colours). Output `public/assets/weapons/hud/ammocrate.png`, `medcrate.png`.
- `captures/`: muted CDP captures of the static Conquest HUD page (`node tools/conquest-hud-capture.mjs --only supply-deploy,supply-crates --sizes desktop`): the Support deploy card with the AMMO CRATE toggle, and the own crate markers with the placed banner.

The map and screen markers reuse the comm rose glyphs (`ammo`, the `revive` cross) in the crate colours; the world models are low-poly boxes (`public/js/engine/supply-crate-view.js`).
