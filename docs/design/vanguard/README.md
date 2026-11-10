# KV-9 VANGUARD

Semi-auto precision battle rifle (DMR). Assault variant 1 in Conquest, free in every other roster
(21 weapons / 16 free). The concept direction is [concept.png](concept.png); material prompts are in
[prompts.md](prompts.md), stats in [spec.md](spec.md).

The runtime model is Blender-authored (`tools/blender/vanguard/`, 90 source meshes): rounded lofted
receiver, ribbed cylindrical shroud, fluted barrel, LPVO optic, arc-bent curved magazine, beveled
stock. Two new Codex `gpt-image-2.5-flare` albedo tiles (`docs/design/blender/textures/vanguard-graphite.png`,
`vanguard-polymer.png`) complement the shared palette (`machined-steel`, `pebbled-rubber`). Export:
14,100 triangles, 13 draws, all 5 parts present. A procedural fallback in
`public/js/guns/models/vanguard.js` serves offline rigs.

## Verification

- `docs/design/blender/vanguard/validation.json`: VANGUARD-VALIDATION-PASSED, 0 failures.
- `tools/render-weapon-scenes.mjs --weapon vanguard`: 7 scenes (held, scoped, firing, reload, swap, vault).
- Browser captures in [shots/](shots/): desktop 1600×800 (held/scoped/firing), mobile 844×390
  (held/firing), avatar front (gripError ≈ 0, weaponInFrame true, Blender asset `vanguard` loaded).
- Contracts: `weapon-handling-test`, `conquest-classes-test` (1098 checks), `titanfall-at-weapons-test`
  (746 checks), `viewmodel-contracts`, `weapon-wheel-contracts`, `blender-assets-browser-test` (exit 0),
  `npm run smoke` (91 checks) — all green.
