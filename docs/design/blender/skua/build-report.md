# SKUA: GV-4 RIPTIDE disc launcher, revision 1

Study name: **FORK** (design alternative 1 of `concepts/`). Blender asset id
`skua`, game slot `glaive` (the 13th weapon, `WEAPON_IDS[12]`), display name
GV-4 RIPTIDE. The authoritative weapon spec is the glaive spec, section 6
(SKUA model brief).

## Design intent

A forearm-braced launcher that throws a toothed magenta disc and catches it
again. The seated disc is the hero surface of the first-person view:

- **Seated disc** (`mag`): a 0.22 m blade-steel disc lying flat on the launch
  spindle, tilted 6 degrees front-edge-up so its face reads from the eye. It
  has a hub on an arbor pin, three spokes with windows between them, a rim
  with a magenta razor-glow inlay ring and 24 polished hooked teeth.
- **Launch spindle** (the bore): a bare r 0.0155 gunmetal rod from the
  receiver face (game z -0.10) to a chamfered tip on the muzzle plane
  (z -0.40), over a flat rail with two guide lips. It is the only geometry
  near the axis inside the heat band.
- **Fork**: an orange bridge crosses in front of the disc. It carries the
  ring sight on a post between two protective wings, and two vertical brass-capped
  pins on a gunmetal fork plate. The **catch horns** hinge on those pins and
  sweep forward and outward like mandibles to razor-glow prongs at their
  tips.
- **Flywheel cage**: a gunmetal drum of end plates and twelve fins, open
  between the fins so the polished flywheel (`bolt`) visibly whirls inside. A
  brass RPM/fabricate gauge sits on its left face, and a tapered rear sight
  tower carries the notch on the 0.150 sight line.
- **Receiver**: a low ivory slab with an orange top stripe, side rails and the
  modelled `GV-4` / `RIPTIDE` stencil on the right flank.
- **Pistol grip and brace cuff**: a dark-polymer grip with finger swells and
  a ribbed backstrap. Behind it is a strapped half-ring forearm cuff (seven
  strap segments on a liner, gunmetal rims, brass buckle and a strap tail).
- **Cassette**: a skeletal dark-polymer holder under the receiver around the
  spare disc: a spine, a yoke, four hoop arcs with open slots that show the
  spare's teeth, floor bars and a magenta progress strip on its right arc.

## Design alternatives and choice

`concepts/` holds three blockout alternatives with their prompts
(`concept-prompts.md`, geometry in `concept-blockouts.py`, renders
`concept-{0..3}-*.png`). No image generator is available in this toolset, so
flat Blender blockouts stand in for ImageGen, as they did for TORCH.

- **FORK (chosen):** a fork and spindle. It is the only alternative that keeps
  every contract anchor (spindle muzzle, ring and notch on 0.150, grip,
  support stub) while making the disc the most visible surface from the eye.
  The horns give it a silhouette no other roster weapon has.
- **DRUM (rejected):** a drum magazine above the rail reaches about 0.22 and
  blocks the 0.150 sight line. It also hides the disc, so the discs-in-hand
  state cannot read.
- **BRACER (rejected):** a wrist bracer only has no gun silhouette, no pistol
  grip for the grip anchor and no spindle for the muzzle contract.

Refinements after the choice, driven by live MCP viewport read-backs:

1. The horns were first tall flat slabs. They now taper from a 0.070 root to
   a 0.016 tip with a spine rib, strakes and an inward tip hook.
2. The rear sight thin stick became a tapered tower.
3. The ring sight gained side wings, so it reads as a sight rather than a
   lifting eye.
4. The grip's full-width wrap ribs read as a heat sink. They became finger
   swells plus a backstrap wrap.
5. The lower frame was dropped under the flywheel sweep and extended under
   the receiver, so it no longer reads as a loose slab.

## Part contract

Authoring space is +Y forward, +Z up and +X right. The game map is
`game_x = x, game_y = z, game_z = -y`. Anchors (game space) come from
`TIMERS.glaive`, `HANDS.glaive`, `SIGHT_HEIGHT.glaive` and `common.js`:

| Anchor | Value |
|---|---|
| muzzle | `[0, 0, -0.40]` (spindle tip) |
| bore axis | x 0 / y 0, spindle radius 0.0155 (`BARREL_R.glaive` 0.016 minus 0.5 mm) |
| breech | `BREACH_Z` -0.10 (the spindle starts at -0.098, buried in the receiver) |
| heat band | z -0.34..-0.40 |
| sight | `[0, 0.150, -0.34]` (ring sight centre); rear notch floor at y 0.150, z +0.07 |
| grip | `[0, -0.075, 0.04]` |
| support | `[0, -0.06, -0.30]` (stub under the fork) |
| trigger | blade at z -0.005, tip y -0.066 |
| flywheel hub | `BOLT_HOME` z 0.06 |

**Runtime nodes** (`public/assets/blender/skua.gltf`, `extras.blenderAsset = "skua"`
on every group node):

| Node | Translation (game) | Content |
|---|---|---|
| `body` | identity | Static geometry: 6 primitives (orange paint, dark polymer, gunmetal, razor glow, brass, ivory coating). |
| `mag` | `[0, 0.042, -0.22]` = disc centre | The seated disc, pivot-local, baked with its 6 degree tilt. It spins about the tilted normal `[0, 0.994522, 0.104528]`, which is `pivot.rotation.x = +6 deg`, then spin about local y. 3 primitives: blade steel, polished edge, razor glow. |
| `bolt` | `[0, 0, 0.06]` = flywheel hub | The polished flywheel, pivot-local. It whirls about game z (`rotation.z`) and kicks back 0.012. |
| `trigger` | identity | Blade and guard. |
| `extra` | identity, no mesh | Children: `horn left \| orange paint`, `horn left \| razor glow` at `[-0.05, 0, -0.335]`; `horn right \| orange paint`, `horn right \| razor glow` at `[0.05, 0, -0.335]`; `spare disc \| blade steel`, `spare disc \| polished edge`, `spare disc \| razor glow` at `[0, -0.072, -0.165]` (round node, untilted, centred on its own origin); `gauge needle \| brass` at `[-0.0635, 0, 0.07]`, which spins about game x. |
| markers | as the anchors | `grip`, `muzzle`, `sight`, `support` |

Horn articulation: each horn swings about the vertical pin (game +y) through
its node translation. Outward flare is `rotation.y = -flare` for the right
horn and `+flare` for the left, 0 to 22 degrees. Every horn vertex stays at
game y ≤ 0.071.

## Commands

```sh
# design alternatives (blockout renders + prompts under docs/design/blender/skua/concepts/)
blender --background --factory-startup --python docs/design/blender/skua/concepts/concept-blockouts.py
# authoring (headless; all six build checks gate the build)
blender --background --factory-startup --python tools/blender/skua/build-skua.py
# authoring through the live Blender MCP session (creates its own scene, saves with copy=True)
"$HOME/Library/Application Support/VoxelBlitz/blender-mcp/.venv/bin/python" \
  tools/blender/mcp-client.py execute_blender_code --code-file <wrapper> --arguments '{}'
"$HOME/Library/Application Support/VoxelBlitz/blender-mcp/.venv/bin/python" \
  tools/blender/mcp-client.py get_viewport_screenshot --arguments '{}' \
  --image-output docs/design/blender/skua/mcp-viewport.png
# browser delivery, fresh-import validation, proof renders, articulation stills
blender --background --factory-startup docs/design/blender/skua/skua.blend --python tools/blender/skua/export-game-assets.py
blender --background --factory-startup --python tools/blender/skua/validate-skua.py
blender --background --factory-startup docs/design/blender/skua/skua.blend --python tools/blender/skua/render-skua.py
blender --background --factory-startup docs/design/blender/skua/skua.blend --python tools/blender/skua/pose-skua.py
```

`<wrapper>` is a short `execute_code` shim that sets `__file__` to the build
script path before it calls `exec`.

## Counts (measured, final build)

- 205 authored source parts: body 105, extra 54, mag 30, bolt 14, trigger 2.
- 19 material batches (draw calls) and 15,412 triangles. The build GLB and
  the runtime glTF agree exactly.
- Triangles per group: body 8,568, mag 2,084, bolt 912, trigger 116, extra
  3,732 (horns 1,600, spare disc 2,084, needle 48).
- 8 materials (frozen names): ivory coating, orange paint, gunmetal, dark
  polymer, blade steel, polished edge, brass and `SKUA | razor glow`.
  - Seven are mapped onto the shared 1024px palette JPEGs by the
    material-library pass: gunmetal → phosphated-steel, orange paint →
    orange-paint, ivory coating → ivory-ceramic, dark polymer →
    molded-polymer, blade steel and polished edge → machined-steel, brass →
    aged-brass.
  - Razor glow is untextured: emissive `#ff3fd0` (linear
    `[1, 0.0497, 0.6308]`) at strength 6, with the custom prop
    `emissive_coil`. The glTF carries `emissiveFactor` = the linear colour
    and `extras.cosmeticGlow` / `extras.emissiveStrength: 6`.
- Bounds (authoring space): x -0.128..+0.125, y -0.161..+0.467,
  z -0.140..+0.167.
- File sizes (final run): skua.blend 1,414,457 B, skua.glb 3,323,420 B,
  skua.gltf 18,490 B, skua.bin 1,101,328 B.

## Checks actually executed

Every check below ran for this delivery, in the live MCP session and
headless.

1. **Anchor contract** (build-skua.py, fails the build):
   - the forward-most bore vertex is at 0.400;
   - the bore axis x/z is 0, and the spindle radius over the band is 0.0155;
   - the spindle starts at 0.098, behind the breech;
   - all four markers are in place;
   - the ring sight centre is at z 0.150, y 0.340, and the rear notch floor at z 0.150, y -0.070;
   - the trigger tip is at z -0.066;
   - the flywheel hub is at y -0.060;
   - the disc centre is on its seat;
   - no geometry within |x| < 0.06 lies forward of the muzzle plane (the horn tips are off-axis);
   - no non-sight vertex inside |x| < 0.02 reaches z 0.150.
2. **Heat-band clearance** (fails the build): across y 0.34..0.40, nothing but
   the spindle comes within 0.030 of the axis. The nearest other part is
   0.0406 away.
3. **Coplanar-face audit** (fails the build): clean.
4. **Floating-part audit** (fails the build): clean. Every part is within
   1 mm of, or inside, the spindle cluster. This includes the horns (knuckles
   on the pins), the flywheel (hub on the axle), the seated disc (hub on the
   arbor) and the spare disc (on the cassette boss).
5. **Horn sweep audit** (fails the build): both horns at 0, 11 and 22 degrees
   about their pins.
   - No horn vertex enters any other part.
   - The top of either horn is at z 0.067, below SIGHT_Z - 0.03 = 0.12.
   - The minimum gap (excluding the knuckle running fit) is 2.17 mm.
6. **Disc visibility audit** (fails the build): a 160×160 ray grid over a
   50×50 degree frame from the ADS eye `(0, 0.150, +0.35)`. The seated disc
   owns 4.54 % of the frame (gate 4 %), and its top face owns 2.27 %.
7. **Fresh-import validation** (`validate-skua.py` over skua.glb and
   skua.gltf; writes validation.json with `passed: true`, 140 measured
   entries). It checks:
   - node and marker names, and `extras.blenderAsset`;
   - that the extra leaves are exactly the eight contract nodes;
   - every pivot translation, and that no node is rotated;
   - anchors, UV references and the six palette images for seven textured materials;
   - the eight material names and the razor-glow emissive;
   - the budgets: 19 ≤ 24 primitives, 15,412 triangles within 12k-18k;
   - after import: the on-axis tip at 0.400, spindle radius 0.0155 in the band, heat-band clearance;
   - the 8-material budget, no negative scale, no nonfinite coordinates and no inward-facing surfaces.

The browser suites (`weapon-materials-browser-test.mjs`,
`blender-assets-browser-test.mjs`) were **not** run. They need the `skua`
registration in `ASSET_IDS` and the test tables (owned by other agents), and
they drive Chromium, so they are left to the user.

## Assumptions (stated, not checked)

- **Pivots.** The runtime wrapper (`public/js/guns/models/skua.js`) uses the
  node translations as pivots. The disc centre, flywheel hub, horn pins,
  spare disc centre and gauge centre in the table above are the single source
  of truth.
- **Hand fit.** The grip and support palms sit on the contract points, but no
  third-person pose test was run.
- **Receiver length.** The receiver slab runs from game z +0.03 to -0.10 (the
  flywheel cage takes z +0.02..+0.12 on the same axis, and the rail takes
  over forward of the breech). This differs from the brief's z +0.12..-0.18,
  because a slab reaching -0.18 would cut through the seated disc's rear
  edge.
- **Horn hinge depth.** The horn pins sit at game z -0.335 rather than
  -0.33, which leaves 6 mm between the knuckles and the disc teeth.

## Limitations

- Scalar metallic/roughness only: no baked normal, occlusion or roughness maps.
- Single LOD; no mobile GPU profiling.
- Blade steel and polished edge share the machined-steel palette map, so after
  the material-library pass they differ only by name.
- **One glow material.** The cassette progress strip shares `SKUA | razor
  glow` with the discs and prongs, because the budget allows only 8
  materials. The runtime cannot dim it separately by material name.
- **Throw path.** The seated disc's straight throw path (-0.18 along its
  plane) passes through the horn pins and bridge (see `pose-throw.png`). The
  runtime hides the disc at the end of the slide-out.
- **Flywheel material.** The flywheel is polished edge rather than gunmetal,
  so its spin reads against the gunmetal cage.
- **Needle placement.** The gauge needle ships in `extra` (not `body`) so the
  presentation can sweep it.
