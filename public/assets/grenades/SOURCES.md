# Grenade inventory artwork

The frag, limpet and pulse inventory illustrations in `hud/` were generated with the built-in
Imagegen tool on 2026-09-08 for the Chaos Lab shop. Each illustration has its own
prompt in [`hud/imagegen-prompts.json`](./hud/imagegen-prompts.json).

- `frag.png`: M-4 FRAG, dark metal body, bronze ribs and amber fuse cap.
- `limpet.png`: LIMPET CHARGE, copper magnetic disc with four feet and an orange rim.
- `pulse.png`: PULSE SHOCK, cyan faceted energy core in a dark metal cage.

The silhouettes and accent colors follow `public/js/weapons/projectiles.js` and
`shared/grenade-rules.js`. These are shop illustrations; the existing procedural
models remain the in-world projectiles. Those three PNGs are 512 by 512 pixels,
resampled from the generated original while retaining its alpha channel.

`hud/molotov.png` is a transparent 480 by 480 pixel render of the game's own
procedural Molotov bottle, generated on 2026-09-08 by
`node tools/render-molotov-icon.mjs`. It uses no external image source.

- `hud/limpet.svg`: hand-authored vector icon of the wall-mounted Claymore, used by the shop.
