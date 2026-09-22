# TORCH — RX-8 HAVOC rocket launcher, revision 2

Study name: **BULWARK** (design alternative 3 of `concepts/`). Blender asset
id `torch`, game slot `rocket`, display name RX-8 HAVOC. Revision 2 is a
from-scratch redo: the old AT4-style disposable-tube study (thin smooth tube,
flared orange warning cone) is deleted along with its renders.

## Design intent

A heavy sci-fi shoulder launcher that reads as ordnance, not a painted pipe:

- **Squared breech housing** — an octagonal receiver block and an olive
  cladding shell with bolted gunmetal cheek panels, orange bolt bosses, latch,
  a black vent slot and modelled `RX-8` / `HAVOC` stencil geometry.
- **Half-cage braces** — four converging struts from the housing to a front
  collar over the bare tube, the launch tube visible through the gap.
- **Seated warhead nose** — a rocket nose peeking from the tube mouth
  (ivory ogive, orange band, black tip on a gunmetal boom inside the mouth,
  rubber obturator seating it). Per the runtime owner the tip sits 0.018 m
  proud of the muzzle plane at radius ≤ 0.047: the muzzle marker is where the
  game spawns the flying rocket and the flash, so nothing slim may project
  well forward of the plane.
- **Industrial panels and handles** — cheek panels, a forward hand hold around
  the support marker, a left-flank shoulder brace with a ribbed rubber pad
  clear of the gate swing (the gate never leaves |x| ≤ 0.099), a fixed
  underslung control canister in `mag`, pistol grip with finger ribs.
- **Visible breech separation** — the tilting back-blast venturi gate (two
  clamshell leaves under clamp and warning rings, throat liner, knuckles,
  latch) hangs on hinge pins with a 6 mm seam gap to the breech block.
- **Unobstructed sight window** — flip-up ladder sights bracket the 0.175
  sight line (rear notch bar at game z -0.02, hooded front post at z -0.768);
  nothing but the sights touches the line inside |x| < 0.02.
- The heat band z [-0.752, -0.528] is bare 0.0620 tube (the runtime's 0.0625
  glow sleeve and the support hand own that span); the seated nose nests
  inside the bore there at radius ≤ 0.047, which is the single exception.

## Design alternatives and choice

`concepts/` holds three blockout alternatives with their generating prompts
(`concept-prompts.md`, geometry in `concept-blockouts.py`): ANVIL (squared
armour slab), CAGE (open exoskeleton lattice) and BULWARK (hybrid squared
breech + half cage). **Chosen: BULWARK** — best fit to the frozen contract and
the quality bar: it is the only alternative carrying every brief element at
once (squared tube, cage braces, visible warhead, industrial panels/handles)
and its layered mid-body survives the first-person close-up best. Two
refinements came with the choice: the warhead finish from ANVIL's ivory/orange
palette, and the proud warhead of the blockout tightened to the runtime
owner's seated-nose spec (flash/spawn point at the muzzle plane).

## Part contract

Authoring space +Y forward, +Z up, +X right; game map `game_x = x,
game_y = z, game_z = -y` (the glTF exporter's +Y-up conversion is the same
map). Anchors (game space): muzzle `[0, 0.075, -0.78]`, grip
`[0.045, -0.02, -0.08]`, support `[-0.06, -0.03, -0.40]`, sight
`[0, 0.175, -0.34]`. Bore axis x 0 / y 0.075, exposed radius 0.0620 from the
breech z -0.22 to the muzzle plane z -0.78, clear bore radius 0.0555 so the
runtime reload round (r ≤ 0.046, seats nose at z ≈ -0.58) slides through from
z +0.36.

- `body`: tube core + bore liner, breech block, housing shell, cage, deck,
  sights, grips, shoulder brace, markings and the seated warhead nose.
- `mag`: the fixed underslung control canister (runtime owner: the group IS
  the canister; the old shoe-only look would read as a missing part).
- `bolt`: side arming lever at game z -0.040; the runtime rotates the group
  +0.55 rad about the gun origin (tips while the breech is open, snaps home on
  the cocking cue).
- `trigger`: blade (tip at z -0.055) + shoe + guard at z -0.11.
- `extra`: ONLY the breech gate leaves (`gate | gunmetal`, `gate | orange
  paint`, `gate | cavity black`), hinge-local geometry with node translation
  exactly `[-0.104, 0.075, -0.135]` (the vertical left-flank pin); the runtime
  swings the venturi 1.75 rad open sideways about that pin (Carl Gustaf M3
  style; hinge-stop bounce on the drop, slam at the seat cue). No loose reload
  round: the runtime spawns it.

## Commands

```sh
# design alternatives (blockout renders + prompts under docs/design/blender/torch/concepts/)
blender --background --factory-startup --python docs/design/blender/torch/concepts/concept-blockouts.py
# authoring (headless; all four build checks gate the build)
blender --background --factory-startup --python tools/blender/torch/build-torch.py
# authoring through the live Blender MCP session (creates its own scene, saves with copy=True)
"$HOME/Library/Application Support/VoxelBlitz/blender-mcp/.venv/bin/python" \
  tools/blender/mcp-client.py execute_blender_code --code-file <wrapper> --arguments '{}'
"$HOME/Library/Application Support/VoxelBlitz/blender-mcp/.venv/bin/python" \
  tools/blender/mcp-client.py get_viewport_screenshot --arguments '{}' \
  --image-output docs/design/blender/torch/mcp-viewport.png
# browser delivery, fresh-import validation, proof renders, articulation stills
blender --background --factory-startup docs/design/blender/torch/torch.blend --python tools/blender/torch/export-game-assets.py
blender --background --factory-startup --python tools/blender/torch/validate-torch.py
blender --background --factory-startup docs/design/blender/torch/torch.blend --python tools/blender/torch/render-torch.py
blender --background --factory-startup docs/design/blender/torch/torch.blend --python tools/blender/torch/pose-torch.py
```

`<wrapper>` is a one-line execute_code shim that sets `__file__` to the build
script path before `exec` (MCP `execute_blender_code` evaluates text without a
module file). The live-session read-back is `mcp-viewport.png`.

## Counts (measured, final build)

- 108 authored source parts, 17 material batches (draw calls), 15,140
  triangles (build GLB and runtime glTF agree exactly).
- Triangles per group: body 11,824 · mag 328 · bolt 208 · trigger 312 ·
  extra (gate) 2,468.
- 7 materials (frozen names): gunmetal, olive drab, orange paint, ivory
  coating, polymer, rubber, cavity black — six mapped onto the shared 1024px
  palette JPEGs by the material-library pass
  (`gunmetal` → phosphated-steel, `olive drab` → olive-paint, `orange paint` →
  orange-paint, `ivory coating` → ivory-ceramic, `polymer` → molded-polymer,
  `rubber` → pebbled-rubber; `cavity black` untextured), with the
  `textureLibrary` / `textureBumpScale` extras every other weapon delivery
  carries. No new images were generated;
  `docs/design/blender/torch/material-library.json` is the pass record.
- Bounds (authoring space): x -0.136..+0.122, y -0.052..+0.798,
  z -0.129..+0.209. UV density 3.6 tiles/m, analytic per-face projection.
- File sizes (final run): torch.blend 2,689,726 B (varies by tens of kB
  between identical runs) · torch.glb 1,972,884 B · torch.gltf 15,790 B ·
  torch.bin 1,010,576 B.

## Checks actually executed

Every run below was executed for this delivery (not assumed):

1. **anchor contract** (build-torch.py, fails the build): muzzle plane rows,
   forward-most bore vertex at 0.780, bore axis x/z, exposed 0.0620 radius
   across the whole heat band (measured on the tube core), all four marker
   positions, the 0.175 sight line (marker + sight clearance assertion: no
   non-sight vertex inside |x| < 0.02 reaches z 0.175), trigger blade y 0.110
   with tip at z -0.055 ± 1e-4, arming lever home at y 0.040 with knob reach
   x = 0.122, rear sight post y 0.020, front sight post y 0.768.
2. **heat-band clearance** (fails the build): nothing but the bore assembly
   enters z [0.528, 0.752]; nothing stands proud of the 0.0620 sleeve there;
   the seated nose stays inside radius 0.050. Measured: band max radius
   0.0620 over 872 vertices, no intruders.
3. **coplanar-face audit** (fails the build): clean — no flush overlapping
   faces between parts (they would z-fight once same-material parts merge).
4. **floating-part audit** (fails the build): clean — every part crosses,
   touches within 1 mm or sits inside another; one connected cluster.
5. **fresh-import validation** (`validate-torch.py`, both torch.glb and
   torch.gltf, writes validation.json with `passed: true`): node and marker
   names, `extras.blenderAsset`, gate-leaf node translations exactly
   `[0, 0.075, -0.06]` with hinge-local mesh centres, `extra` children = the
   gate leaves only, anchors, group identity, UV references (TEXCOORD_0 on
   every primitive, counts match positions), material images (the six shared
   palette maps, 6 textured materials), `textureLibrary`/`textureBumpScale`
   extras, seven material names, primitive budget 17 ≤ 24,
   triangle budget 15,140 in 8k-20k, muzzle tip in [0.778, 0.800], heat-band
   radius 0.0620, no negative scale, no nonfinite coordinates, no
   inward-facing surfaces (signed-volume test per mesh).
6. **material-library browser gate** (`node tools/weapon-materials-browser-test.mjs`
   over the runtime loader): torch row reports materials 7, paletteMaterials 6,
   triangles 15,172 — every mapped material resolves its shared 1024px palette
   map with bump, deduped across the twelve weapon assets.

## Assumptions (stated, not checked)

- Gate articulation axis: the runtime swings `gate.rotation.y` (1.75 rad)
  about the vertical left-flank pin at (-0.104, 0.075, -0.135); the leaves are
  shaped for that motion
  (confirmed with the runtime owner during the redo).
- Hand fit: the grip and support palms sit on the contract points and the
  furniture is built around them, but no third-person pose test was run.
- The seated warhead nose inside the bore is the one geometry the strict
  reading of "no vertex other than the bore may enter the heat band" would
  exclude; the runtime owner explicitly freed the mouth region for it
  (radius ≤ ~0.045, tip ≤ 0.02 proud) because the reload round never seats
  past z ≈ -0.58 and the hand clearance is radial around the sleeve.

## Limitations

- Scalar metallic/roughness only: no baked normal, occlusion or roughness maps.
- Single LOD; no mobile GPU profiling.
- The runtime reload round is procedural and was not rendered here; the clear
  bore (0.0555) and rear-breech envelope were built to its stated sweep.
