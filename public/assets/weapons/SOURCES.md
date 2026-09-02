# Weapon model references

The seven HUD illustrations in [`hud/`](./hud/) are the canonical visual
references for the procedural weapon models:

- `rifle.png`
- `smg.png`
- `shotgun.png`
- `sniper.png`
- `lmg.png`
- `revolver.png`
- `longarc.png` (side-profile render of the procedural `longarc` model, 480 px wide)

Model changes should preserve the recognizable side-profile proportions,
materials, furniture, sights, feeding system, and muzzle treatment shown in the
matching illustration. The same geometry is rendered in first-person and on
remote avatars, so it must also remain fully visible in the deterministic
weapon and avatar capture matrices.

Runtime contracts take precedence over ornamental detail: the muzzle tip,
grip and sight axes, animated bolt/pump/trigger groups, and reload handles must
continue to use the anchors documented in `public/js/guns/models/common.js`.
