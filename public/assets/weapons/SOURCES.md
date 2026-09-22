# Weapon model references

## Heavy weapon inventory illustrations

`hud/minigun-illustrated.png` and `hud/flamethrower-illustrated.png` were generated
with the built-in Imagegen tool on 2026-09-08, using the existing procedural side
renders as references. Brighter lighting and metal edge highlights make the weapons
readable on dark inventory panels. The original model renders remain alongside them.

The Chaos shop, weapon wheel, HUD and kill feed use these illustrations through
`weaponImagePath()` in `public/js/ui/hud-support.js`. The exact prompts are stored in
[`hud/heavy-imagegen-prompts.json`](./hud/heavy-imagegen-prompts.json).

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
