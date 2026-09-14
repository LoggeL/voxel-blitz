# PEREGRINE — Blender-authored sniper rifle for Voxel Blitz

Orchestrator-authored brief. **Frozen contract: every agent works to this file.**
Archived verbatim as the record of the request; do not rewrite it while building.

## 0. Request

> Use the blender mcp to design the sniper rifle gun model.

Deliverable: one new, original, Blender-MCP-authored sniper rifle model, exported
into the game's browser delivery format and wired into the existing `sniper` slot
(LONGSHOT MK-II), following the precedent set by KESTREL, which supplies the
existing `rifle` slot.

## 1. What exists, and what must not change

- Blender 5.2.1 LTS at `/Applications/Blender.app` is running with its MCP add-on
  (protocol 5) listening on `127.0.0.1:9876`. Verified connected.
- `tools/blender/mcp-client.py` drives that server through the MCP Python SDK.
- KESTREL is the working precedent: `tools/blender/build-weapon.py` (authoring),
  `tools/blender/export-game-assets.py` (runtime glTF writer),
  `public/js/engine/blender-assets.js` (loader),
  `public/js/guns/models/kestrel.js` (runtime part wiring),
  `public/js/guns/models/rifle.js` (fallback entry point),
  `tools/blender/render-hud.mjs` (browser HUD icon).
- Read `docs/design/blender/README.md` and `docs/design/blender/omp-weapon/build-report.md`
  first: they record the material/UV/export method and the traps already found.
- Unchanged, by scope: weapon stats, inventory IDs, server hitboxes, `TIMERS`,
  `HANDS`, `BREACH_Z`, `BOLT_HOME`, `TRIGGER_Z`, `BARREL_R`, the six existing
  ImageGen textures, and the currently displayed weapon name.

## 2. Coordinates

Authoring is Blender-native (**+Y forward/barrel, +Z up, +X right**). glTF export
applies the standard Y-up conversion, giving runtime **-Z forward, +Y up, +X right**:

```
game_x = x,   game_y = z,   game_z = -y
```

All runtime anchors below are **gun-local, in metres**, in that runtime frame.

## 3. Frozen runtime contract

| Item | Value | Source |
| --- | --- | --- |
| `muzzle` (marker + forward-most vertex) | `(0, 0.055, -0.760)` | `TIMERS.sniper.muzzle` |
| Bore axis | `x = 0`, `y = 0.055` | `TIMERS.sniper.muzzle` |
| Breech (bore start inside receiver) | `z = -0.26` | `BREACH_Z.sniper` |
| Exposed bore radius | `0.0210` (sleeve is `0.0215`) | `BARREL_R.sniper` |
| `grip` marker (dominant palm) | `(0.045, 0.020, -0.13)` | `HANDS.sniper.grip` |
| `support` marker (support palm) | `(-0.055, -0.010, -0.48)` | `HANDS.sniper.support` |
| Bolt handle home | `z = -0.010`, protruding to `-x` (gun left) | `BOLT_HOME.sniper` |
| Trigger blade | `z = -0.165`, blade tip `y ~ -0.020` | `TRIGGER_Z.sniper` |
| Optical axis / `sightHeight` | `y = 0.205` (scope axis exactly here) | `body.userData.sightHeight`, `adsOffset.y = -0.205` |
| Rear eyepiece lens plane | `z = +0.005` | procedural envelope |
| Front objective lens plane | `z = -0.505` | procedural envelope |
| Objective clear radius | `>= 0.040` | procedural envelope |

### 3.1 Parts the game animates (top-level glTF nodes)

| Node | Contents | Driven by |
| --- | --- | --- |
| `body` | receiver, stock, grip, handguard, barrel, muzzle, bipod | static |
| `mag` | magazine only | reload slides/rotates `model.mag` |
| `bolt` | bolt body, handle, knob, shroud | `boltAnim`/reload: `position.z += up to 0.16`, `rotation.z` |
| `trigger` | trigger blade and guard | trigger pull |
| `factory-optic` | scope tube, rings, turrets, bells, lenses | hidden when a replacement optic is attached |
| `extra` | 3 stripper rounds | reload choreography |

Markers `muzzle`, `grip`, `support`, `sight` are emitted as additional named
non-mesh nodes for authoring/validation only.

### 3.2 Stripper rounds (`extra`) — exact runtime behaviour

`public/js/guns/actions.js` writes, every reload frame:

```js
cartridge.visible = ...;
cartridge.position.y = 0.115 + i * 0.016 + (1 - feed) ** 2 * 0.80 - feed * 0.06;
```

`position.x`/`position.z` are never written, and the cartridge meshes must be
**direct children of `extra`**, each a mesh whose geometry is **centred on its own
origin** (a round pointing along the bore axis: 12 mm x 12 mm x 50 mm). The runtime
builder sets `x = 0`, `z = -0.235`, `y = 0.115 + i * 0.016` once, then hides them.
No parent between `extra` and the round may carry a transform.

### 3.3 Heat band

`assemble.js` adds an additive glow sleeve of radius `0.0215` spanning
`z = -0.56 .. -0.72` (from `heatLen` `[0.60, 0.92]`, `barrelLen 0.50`). The bore
must therefore be **bare metal of radius 0.0210 over that whole span**, and the
muzzle device must not exceed radius `0.0210` or enclose the bore, or the glow
hides inside it (the defect documented for SHRIKE).

### 3.4 Added by the game, never by the model

`assemble.js` adds the `muzzle` marker object, the muzzle flash, that heat sleeve,
a glow cap on the `bolt` group at `(-0.02, 0.07, +0.042)`, and both gloves placed
at the `HANDS` anchors. Model none of these.

## 4. Design intent (locked)

**Asset name: PEREGRINE** (bird-of-prey family already used for KESTREL, VK-77
Raptor, VK-41 SHRIKE). The in-game display name stays `LONGSHOT MK-II`; the model
carries small `PEREGRINE` / `VB 88` markings as geometry.

Identity: **long-spine precision rifle — a straight low receiver spine carrying a
fully exposed fluted bore, an open skeletal stock and a wide benchrest fore-end.**
It must be unmistakably not a KESTREL: KESTREL is a short chunky carbine with a
shrouded barrel; PEREGRINE is long, low, open and reaches.

Required readable forms:

1. **Exposed bore.** Receiver/handguard end by `z = -0.30`; the bore then runs
   bare at radius `0.0210` for 0.46 m to the tip, with 6 helical flutes. This is
   the dominant silhouette line and the heat band lands on real metal.
2. **Muzzle.** Constant-radius crown with 3 radial port cuts, nothing wider than
   `0.0210`, no geometry beyond `z = -0.760`.
3. **Open skeletal stock.** Twin chassis struts with a genuine see-through
   triangle, an adjustable cheek riser, a thin recoil pad and a sling loop.
   Nothing dangling; the butt is the rearmost geometry.
4. **Wide benchrest fore-end** with a flat underside, an accessory rail and a
   *folded* slim bipod tucked under the fore-end (`z >= -0.58`, `y >= -0.045`),
   clear of the support palm at `z = -0.48`.
5. **Raked pistol grip** wrapping the `grip` marker, with finger grooves and a
   palm swell, half-width `~0.031` so the `x = 0.045` palm sits just outboard.
6. **Magazine vs grip contrast.** A deep, narrow, flared box magazine dropping to
   `y ~ -0.170`, distinctly not a second grip.
7. **Long-throw bolt**, handle on `-x` at `z = -0.010`, `~0.095` long, with a
   knurled knob and a bolt shroud; visibly geared for a 0.16 m throw.
8. **5x-class optic** on a one-piece machined mount, axis exactly `y = 0.205`,
   optically clear on both ends, unobstructed aim line, no iron sights.
9. **Restrained mechanical detail** that reads at gameplay distance: ejection port,
   top rail with lugs, side relief slots, heat ribs, magazine release, safety
   selector, sling points, `PEREGRINE` / `VB 88` geometry markings.

Avoid: negative scales, non-finite coordinates, inward-facing surfaces, flush
coplanar faces between parts (they z-fight once same-material parts share a draw
call), tiny details that add no readable value, and any wide muzzle brake.

Budget: **10k–20k triangles**, **<= 24 draw primitives**, **<= 8 materials**.

## 5. Materials and textures

Reuse the six existing ImageGen maps. **No new image generation, no image API
spend, and the source images stay byte-identical.**

Sources (use these, they are already the delivered 1024 px JPEGs):
`public/assets/blender/textures/{worn-gunmetal,orange-painted-metal,ivory-armor,
petrol-ballistic-fabric,tan-webbing,worn-rubber}.jpg`, with the PNG originals under
`docs/design/blender/textures/` untouched.

Plausible assignment: worn gunmetal for receiver/bore/bolt/stock; worn rubber for
grip, recoil pad, cheek pad, bipod feet; petrol ballistic fabric for the cheek
rest and side inserts; tan webbing for the sling wrap; ivory coating for the
mount and a coating band; chipped orange paint for the magazine plate, selector,
mag release and stripe.

Metalness stays moderate (gunmetal `~0.35`, paint `~0.12`, dielectrics `0.0`):
the runtime scene has no environment map, so high metalness renders black.

Every material samples its map through an analytic per-face planar UV projection at
a constant real-world density (3.2 to 4 tiles per metre). Every mesh must carry a
UV layer; no zero-area or inverted islands.

## 6. Delivery files

| Purpose | Path |
| --- | --- |
| Editable source | `docs/design/blender/peregrine/peregrine.blend` |
| Portable GLB | `docs/design/blender/peregrine/peregrine.glb` |
| Runtime glTF | `public/assets/blender/peregrine.gltf` |
| Runtime binary | `public/assets/blender/peregrine.bin` |
| Reimport evidence | `docs/design/blender/peregrine/validation.json` |
| Machine record | `docs/design/blender/peregrine/manifest.json` |
| Report | `docs/design/blender/peregrine/build-report.md` |
| Renders | `hero`, `side`, `ads`, `rear` PNGs in the same directory |
| Authoring scripts | `tools/blender/peregrine/` |

Runtime glTF rules: buffer `peregrine.bin` referenced as a sibling URI; images
referenced as `textures/<stem>.jpg` (the runtime map cache keys on exactly that
string, so the loader must set `image.uri` and `texture.source` accordingly);
identity node transforms with vertices baked into gun-local space; one node per
contract part with one primitive per material.

## 7. Blender MCP rules

```sh
MCP_PYTHON="$HOME/Library/Application Support/VoxelBlitz/blender-mcp/.venv/bin/python"
"$MCP_PYTHON" tools/blender/mcp-client.py list
"$MCP_PYTHON" tools/blender/mcp-client.py get_addon_status
"$MCP_PYTHON" tools/blender/mcp-client.py execute_code --code-file <script.py>
"$MCP_PYTHON" tools/blender/mcp-client.py get_scene_info --arguments '{"user_prompt":""}'
"$MCP_PYTHON" tools/blender/mcp-client.py get_viewport_screenshot --image-output <png>
```

- Check the real tool schema with `list` before relying on an argument name.
- Authoring, scene read-back and viewport evidence go through MCP.
- The live Blender session currently holds a factory-default scene. The build must
  **create its own scene** and must never reset, overwrite or re-save another study.
- Save with `bpy.ops.wm.save_as_mainfile(filepath=..., copy=True)` so the running
  session is not re-pointed at the new file.
- Long renders may run through `blender --background <file> --python <script>`
  (the repository's own convention); keep each MCP call under ~3 minutes.

## 8. Verification each agent must actually run

The build owns: anchor assertions at build time (muzzle tip, all four markers,
the 0.205 sight line), a coplanar-face audit, a fresh-scene GLB reimport check,
self-containment of the `.blend`, and visual inspection of every render.

Nobody runs formatters, linters or whole-project test suites mid-flight; the
orchestrator does that once at the end.
