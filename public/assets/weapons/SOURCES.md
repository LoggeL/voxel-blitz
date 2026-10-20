# Weapon model references

## Heavy weapon inventory illustrations

`hud/minigun-illustrated.png` and `hud/flamethrower-illustrated.png` were generated
with the built-in Imagegen tool on 2026-09-08, using the existing procedural side
renders as references. Brighter lighting and metal edge highlights make the weapons
readable on dark inventory panels. The original model renders remain alongside them.

The Chaos shop, weapon wheel, HUD and kill feed use these illustrations through
`weaponImagePath()` in `public/js/ui/hud-support.js`. The exact prompts are stored in
[`hud/heavy-imagegen-prompts.json`](./hud/heavy-imagegen-prompts.json).

## Conquest deployables

`hud/fpv.png` (the Engineer's FPV drone) and `hud/mortar.png` (the Support's M-81
MORTAR) were generated with gpt-image-2 through the Codex image helper on 2026-10-20
and processed by `tools/imagegen-hud-icon.py` (alpha cleanup, fit to the launchers'
box on 480 by 240, 256-colour quantize). They are not weapon slots: `DEPLOYABLE_ART` in
`public/js/ui/hud-support.js` hands them to the kit wheel, the deploy-screen gadget
toggles, the touch button and the kill feed. Prompts and the rejected alternatives are in
`docs/design/conquest/fpv/icons/` and `docs/design/conquest/mortar/icons/`.

## Model reference images

The eight HUD illustrations in [`hud/`](./hud/) are the canonical visual
references for the procedural weapon models:

- `rifle.png`
- `smg.png`
- `shotgun.png`
- `sniper.png`
- `lmg.png`
- `revolver.png`
- `longarc.png` (side-profile render of the procedural `longarc` model, 480 px wide)
- `rocket.png` (side-profile render of the TORCH Blender model — BULWARK
  revision 2 — via `node tools/render-hud-icon.mjs --weapon rocket`, 480 px wide)

Model changes should preserve the recognizable side-profile proportions,
materials, furniture, sights, feeding system, and muzzle treatment shown in the
matching illustration. The same geometry is rendered in first-person and on
remote avatars, so it must also remain fully visible in the deterministic
weapon and avatar capture matrices.

Weapon audio sources are recorded in
[`../audio/LICENSES.md`](../audio/LICENSES.md); the GV-4 RIPTIDE (`glaive`) throw
report is original procedural synthesis (`tools/generate-glaive-audio.py`).

Runtime contracts take precedence over ornamental detail: the muzzle tip,
grip and sight axes, animated bolt/pump/trigger groups, and reload handles must
continue to use the anchors documented in `public/js/guns/models/common.js`.
