# Blender assets: RIVET, KESTREL and PEREGRINE

Blender 5.2.1 LTS and Blender MCP 1.9.1 were installed locally on 2026-09-13.
The requested first asset is a character, followed by a weapon. A map was not
modeled after that choice.

## Files

- `rivet/rivet.blend`: editable operator, 149 named parts, 20-bone rig.
- `rivet/rivet.glb`: merged skin mesh with Idle and Walk clips.
- `kestrel/kestrel.blend`: editable VK-77 RAPTOR carbine, revision 2 (part rig, see the
  KESTREL section below). The rigged first study was removed and lives only in git history.
- `kestrel/kestrel.glb`: portable GLB with the KESTREL part rig and markers.
- `peregrine/peregrine.blend`: editable original precision rifle and part rig.
- `peregrine/peregrine.glb`: portable GLB with the PEREGRINE part rig and markers.
- `public/assets/blender/peregrine.gltf` and its sibling `peregrine.bin`: browser
  delivery of that model, with vertices baked into gun-local space.
- `peregrine/validation.json` and `peregrine/manifest.json`: fresh-reimport evidence
  and the study's mesh statistics.
- `peregrine/hero.png`, `side.png`, `ads.png`, `rear.png`: renders of the finished model.
- `tools/blender/peregrine/`: the PEREGRINE authoring, export, validation and render scripts.
- `textures/`: six original ImageGen material textures, the initial atlas, and all prompts.
- Per-asset manifests record the original study mesh statistics.
- `public/assets/blender/`: compact glTF runtime geometry and six shared JPEG maps.

RIVET now supplies the standard operator, including the visible first-person
body. KESTREL supplies the existing `rifle` slot (VK-77 Raptor). PEREGRINE
supplies the existing `sniper` slot (LONGSHOT MK-II): a long-spine precision
rifle with a fully exposed fluted bore, an open skeletal stock and a wide
benchrest fore-end. It replaces only the silhouette; the in-game display name,
weapon stats, inventory IDs, server hitboxes and reload/bolt/trigger timings are
unchanged. All three appear in matches, training, killcam and the existing
armory/collection model viewer through the same `buildGun` and `makeAvatar`
factories. Saved skins and attachments still apply. Team panels use the
authoritative alpha/bravo palette.

The game export places the authored armor in the existing rigid joint frames.
The game owns walking, two-bone arm IK, crouching, prone, death, recoil and
reload motion. It does not play the limited Idle/Walk/Reload_Study clips over
the gameplay pose. Magazine, bolt, trigger and factory optic are separate parts.
The reflex lens is transparent and aligned to the existing ADS line.

PEREGRINE exposes the same part contract against the sniper's own anchors: a
static `body`, an animated `mag`, a long-throw `bolt`, a `trigger` group, a
`factory-optic` hidden whenever a replacement optic is fitted, and an `extra`
group holding the three stripper rounds that the reload choreography positions
and reveals. Its optical axis sits at the sniper's authored 0.205 m sight line,
which is the same `body.userData.sightHeight` value the procedural model set, so
aim, ADS and avatar mounting are unaffected by the swap.

The browser loads all three templates before constructing models. Meshes share
geometry and the six decoded textures for the page lifetime; each owner gets
its own materials, opacity and skin layers. Closing a viewer or removing a
player cannot dispose another player's maps. A failed asset request logs the
load failure: if `peregrine.gltf` cannot be fetched or has no template, the
sniper slot builds nothing (the procedural fallback is removed) and warns,
never a half-populated mount.

## Material method

The six final textures were generated individually with built-in ImageGen:
chipped orange paint, worn ivory coating, petrol ballistic fabric, scratched
gunmetal, tan webbing and rubbed rubber. Their original pixels are preserved.
Each material samples the matching image through rest-space planar UVs.
The original compact atlas is reference material only.

Blender derives restrained bump and roughness variation from the images. This
is an artistic approximation, not a measured PBR scan. The portable GLB embeds
base-color textures and uses scalar metallic/roughness values; it excludes the
Blender-only bump chain. The browser uses 1024px JPEG delivery copies at quality
84, approximately 1.76 MB for all six maps. Both runtime meshes together use
approximately 1.47 MB of indexed vertex/index buffers. No stock 3D model or
external asset library is used. Baked normal/roughness maps and distance LODs
remain future art optimizations, not features of this integration.

PEREGRINE reuses those same six maps under the same per-face planar projection.
No new image was generated for it, and the delivered sources stay byte-identical.

## Local MCP setup

- Blender: `/Applications/Blender.app`
- MCP checkout: `~/Library/Application Support/VoxelBlitz/blender-mcp`
- Source: <https://github.com/ahujasid/blender-mcp>
- Pinned checkout: `5f8ddaf6e987c4aa0c3467fcc548838b28f64477`
- Dependency environment: `uv sync --frozen --python 3.12`
- Add-on: `~/Library/Application Support/Blender/5.2/scripts/addons/blender_mcp.py`
- Codex server name: `blender`, registered with `codex mcp add`.
- Connection: `127.0.0.1:9876`, with telemetry disabled in both the server environment and Blender preferences.
- Local `src/blender_mcp/config.py` supplies the git-ignored telemetry configuration
  expected by the upstream editable checkout, with `enabled=False` and no destination.

Blender must be open with its add-on enabled. The installed add-on starts its
local connection automatically. If Codex has not refreshed its tool catalog,
restart the MCP server in Settings > MCP servers, as described in the
[official MCP setup guide](https://learn.chatgpt.com/docs/extend/mcp).

The helper `tools/blender/mcp-client.py` reads the registered server configuration
and calls it through the MCP Python SDK. Modeling and texturing in this study
were executed through this protocol, with scene/viewport read-back.

```sh
MCP_PYTHON="$HOME/Library/Application Support/VoxelBlitz/blender-mcp/.venv/bin/python"
"$MCP_PYTHON" tools/blender/mcp-client.py get_addon_status
"$MCP_PYTHON" tools/blender/mcp-client.py get_scene_info --arguments '{"user_prompt":""}'
```

## Rebuilding

Run `tools/blender/build-character.py`, then `tools/blender/texture-and-export.py`
inside Blender for RIVET; the rifle has its own scripts under `tools/blender/kestrel/`. Each build script
creates its own scene and preserves existing scenes. For a clean rebuild, start
in a fresh Blender file. These scripts expect `__file__` to point at the script:

```python
from pathlib import Path
p = Path('/absolute/path/to/voxel-blitz/tools/blender/build-character.py')
exec(compile(p.read_text(), str(p), 'exec'), {'__file__': str(p)})
```

`render-previews.py` renders the character, character detail/back, or weapon.
`STUDY` chooses the view; `FORCE_CPU=True` avoids initial Metal compilation.
These are actual Blender renders, not ImageGen pictures of the finished models.

Build the browser files from the packed study (Blender 5.2). The root
`export-game-assets.py` exports the rigged RIVET study; the delivered `rifle`
slot comes from `tools/blender/kestrel/export-game-assets.py` (see the KESTREL
section):

```sh
blender --background docs/design/blender/kestrel/kestrel.blend \
  --python tools/blender/kestrel/export-game-assets.py
node tools/blender-assets-browser-test.mjs
npm run models:browser
npm run avatars:capture -- --weapon rifle --view front
npm run weapons:capture -- --weapon rifle --state scoped
node tools/render-hud-icon.mjs --weapon rifle
```

`export-game-assets.py` composes stored object transforms explicitly because
Blender does not refresh `matrix_world` for the hidden authoring collection.
It batches geometry by material and animated joint and writes ordinary glTF
2.0. The vendored GLTFLoader and BufferGeometryUtils are from Three.js 0.180.0,
matching the existing renderer, under the included MIT license.

PEREGRINE has its own scripts under `tools/blender/peregrine/`.
`build-peregrine.py` authors the model in a scene of its own, `render-views.py`
renders the hero/side/ads/rear views, `validate-glb.py` writes
`peregrine/validation.json`, and `export-game-assets.py` (the PEREGRINE one, not
the KESTREL script of the same name) writes the browser delivery:

```sh
blender --background docs/design/blender/peregrine/peregrine.blend \
  --python tools/blender/peregrine/export-game-assets.py
node tools/blender-assets-browser-test.mjs
npm run avatars:capture -- --weapon sniper --view front
npm run weapons:capture -- --weapon sniper --state scoped
node tools/render-hud-icon.mjs --weapon sniper
```

`tools/render-hud-icon.mjs` draws the imported slots from the delivered geometry
and maps through the browser renderer (`rifle` from KESTREL, `sniper` from
PEREGRINE); every other weapon still goes through the software rasterizer.

## Verification

`validation.json` records a fresh Blender import of the RIVET GLB: one imported
skin mesh, normalized vertex weights, embedded material images, valid UV
references and actual evaluated mesh motion for each animation. RIVET has
19,320 triangles, 20 bones and six embedded images, with the Idle/Walk clips
isolated to the character. KESTREL revision 2 is validated by
`tools/blender/kestrel/validate-kestrel.py` (see its section below).
`peregrine/validation.json` records the same fresh-import evidence for the sniper,
and `peregrine/manifest.json` its study mesh statistics.

Full figure, face/material detail, rear equipment and weapon studio renders
are provided beside the editable files. The runtime browser test checks 432
pose combinations with the imported geometry, both team colors, owner-isolated
fade/disposal, actual magazine movement, replacement optics and the local body.
It also starts a real Training match with 17 RIVET targets and KESTREL equipped.
The sniper slot is read back the same way: the avatar-and-build markers must
report `blenderAsset === 'peregrine'` (a template fallback would leave the
procedural model and fail the check), the authored 0.205 m sight line must
survive, the three stripper rounds must sit hidden directly under `extra`, and a
fitted `reflex` optic must hide the authored `factory-optic`. Held, scoped and
firing captures are written for both imported slots, plus a front avatar capture
with the sniper. Screenshots and measured results are written to
`.artifacts/blender-integration/`.
The original capture commands now wait for decoded textures and completed
renders via CDP rather than relying on a virtual-time DOM dump.

## BISON (lmg slot), revision 2

BISON supplies the existing `lmg` slot (BASTION LMG). Revision 2 replaces the
first blocky study with a detailed M249-class silhouette: a riveted slab
receiver with an open feed tray under a hinged feed cover, ghost-ring rear
sight and hooded front post around the 0.155 m sight line, a slotted handguard
with side rails, gas block and regulator, a folding barrel-change handle, the
bare heavy barrel across the heat band with a six-prong birdcage, a 200-round
box in a fabric pouch with webbing straps and a hanging belt, a contoured grip,
a skeleton stock on a buffer tube with a cheek riser, and a folded bipod.
213 authored parts, 17,928 triangles, 20 runtime primitives, the same six
ImageGen maps. Display name, stats, hitboxes and the reload timeline are
unchanged.

The study was authored through the live Blender MCP session (protocol 5) with
`tools/blender/bison/build-bison.py`, which creates its own scene and saves
with `copy=True`; the runtime export, validation and renders run headless.

Animated parts (`public/js/guns/models/bison.js`, `public/js/guns/actions.js`):

- `mag`: ammunition box, bracket and the hanging belt, so the belt leaves with
  the spent box.
- `bolt`: charging handle assembly, racked at the end of the belt reload.
- `extra`: the feed cover leaves (custom prop `cover`; lid, ribs, latch, pawls)
  ship as world-baked nodes and are re-hung on the authored hinge pin
  (`COVER_HINGE` = game (0, 0.145, -0.206)) as `extra.userData.reloadPart`; the
  belt lead (custom prop `belt_lead`; five linked rounds across the tray) ships
  as two origin-centred nodes and becomes `extra.userData.beltLead` with its
  tray home in `userData.homePosition`.

The belt reload (`WeaponActions._updateBeltReload`) unlatches and throws the
cover open before the box drops, lifts the spent lead out with the box, seats
the fresh box, lays its lead across the tray, slams the cover on the canonical
third click and racks the charging handle, with the support hand routed
between latch, box, lead, cover and handle. Third-person avatars open the cover
for the length of the swap. `weapon-capture.html` offers `reload-open`,
`reload-eject`, `reload-load` and `reload-charge` stills for the lmg.

Build-time gates added in revision 2: the closed cover (and everything riding
it) must stay under z 0.152, and nothing but the ghost ring and the front hood
may touch the 0.155 line inside |x| < 0.018.

```sh
# author (headless alternative to the MCP session)
blender --background --factory-startup --python tools/blender/bison/build-bison.py
# browser delivery, fresh-import validation, proof renders, articulation stills
blender --background docs/design/blender/bison/bison.blend --python tools/blender/bison/export-game-assets.py
blender --background --factory-startup --python tools/blender/bison/validate-bison.py
blender --background --factory-startup docs/design/blender/bison/bison.blend --python tools/blender/bison/render-bison.py
blender --background --factory-startup docs/design/blender/bison/bison.blend --python tools/blender/bison/pose-bison.py
node tools/render-hud-icon.mjs --weapon lmg
node tools/blender-assets-browser-test.mjs
npm run weapons:reload:test
```

`docs/design/blender/bison/validation.json` records the fresh import (belt
lead nodes under `extra`, cover primitives under the 0.152 ceiling, anchors,
heat band, 10k–30k triangle budget). The browser test builds the lmg, checks
the cover hinge, the belt lead home and the whole belt choreography at four
reload fractions, and writes `bison-*.png` captures to
`.artifacts/blender-integration/`. The lmg HUD icon now comes from the
delivered BISON geometry through the browser renderer.

## KESTREL (rifle slot), revision 2

KESTREL supplies the existing `rifle` slot (VK-77 RAPTOR). Revision 2 replaces
the first chunky study with a detailed M4-class carbine: a slab upper receiver
whose right wall carries an open ejection port (the bolt carrier is seen moving
through it), brass deflector, hanging dust cover and forward assist; a
full-length top rail with a stowed folding rear sight and the factory reflex
sight centred on the 0.145 m sight line; a left-side reciprocating charging
handle with a ribbed knob; a lower receiver with a flared magwell, selector,
bolt catch and magazine release; an open trigger guard; a raked pistol grip
with texture ribs, rubber backstrap and amber base plug; an octagonal
free-float M-LOK handguard with rail slots on every facet, an amber ribbed rail
cover on the support side and the gas tube inside; a low gas block carrying an
A-frame front sight post that co-witnesses through the reflex window; the bare
0.0170 m barrel across the heat band with a six-prong birdcage; a curved
30-round magazine with witness ribs, a brass round window and an amber
baseplate; and a six-position collapsible stock on a buffer tube with a cheek
riser and ribbed rubber butt pad. 200 authored parts, 12,532 triangles, 18
runtime primitives, eight materials on the shared palette (gunmetal, polymer,
petrol paint, orange paint, ivory coating, rubber, brass, optic glass).
Display name, stats, inventory id, hitboxes, `sightHeight` 0.145 and the
reload/bolt/trigger timings are unchanged.

The study was authored through the live Blender MCP session (protocol 5,
`execute_blender_code`) with `tools/blender/kestrel/build-kestrel.py`, which
creates its own scene and saves with `copy=True`; the runtime export,
validation and renders run headless. `kestrel/mcp-viewport.png` is the live
viewport read-back.

Part contract (`public/js/guns/models/kestrel.js`, unchanged):

- `body`: receivers, rail, rear sight, grip, stock, handguard, gas block, front
  sight, barrel and hider, markings.
- `mag`: the whole magazine; the rifle reload drops it on the `rifle` exit path
  and brings a fresh one in on the entry path.
- `bolt`: bolt carrier, bolt head and the charging handle; home at game z
  -0.035, reciprocates 0.085 m per shot and on the reload rack. The carrier is
  visible through the ejection port while it moves.
- `trigger`: amber blade and guard.
- `factory-optic`: the reflex sight (mount, petrol housing, lens, emitter,
  battery cap, brightness buttons). `kestrel.js` still adds the emissive dot at
  game (0, 0.145, -0.187), which lies inside the housing behind the lens; a
  fitted replacement optic hides the whole group.
- `extra`: ships empty (no loose rounds for a magazine reload).

Geometry conventions: the bore sits 6 mm left of the receiver centreline
because the contract muzzle is at x -0.012, while every sight sits on x = 0
where the ADS camera looks; the ejection port and the charging-handle slot are
real through-holes in the wall plates (`solid()` with an inner profile), not
recessed panels.

Build-time gates: muzzle plane, bore axis and the exposed 0.0170 m radius over
the whole 0.460..0.572 heat band, all four markers, the trigger blade, the
bolt handle home and its -x protrusion, nothing but the reflex lens and the
front post/wings on the 0.145 line inside |x| < 0.018, rail furniture behind
the reflex under z 0.125, the grip flank inboard of the 0.045 palm, the guard
underside on the support palm, coplanar-face and part-contact audits.

```sh
# author (headless alternative to the MCP session)
blender --background --factory-startup --python tools/blender/kestrel/build-kestrel.py
# browser delivery (also drops foreign scenes from the saved study), fresh-import validation, proof renders
blender --background docs/design/blender/kestrel/kestrel.blend --python tools/blender/kestrel/export-game-assets.py
blender --background --factory-startup --python tools/blender/kestrel/validate-kestrel.py
blender --background --factory-startup docs/design/blender/kestrel/kestrel.blend --python tools/blender/kestrel/render-kestrel.py
node tools/render-hud-icon.mjs --weapon rifle
node tools/blender-assets-browser-test.mjs
npm run weapons:capture -- --weapon rifle --state scoped
npm run avatars:capture -- --weapon rifle --view front
```

`docs/design/blender/kestrel/validation.json` records the fresh import (nodes,
markers, identity transforms, muzzle tip, heat band radius, sight channel,
lens span, 18 primitives, 10k-30k triangle budget) and the runtime glTF
contract (node names, `textures/` image URIs, one blend material, buffer URI).
`render-hero/side/left/ads/rear.png` are the Cycles proof renders and
`build-report.md` the build record. The rigged first study and its authoring
script were removed; the root `export-game-assets.py`, `render-previews.py`
and `validate-import.py` now serve RIVET only.

## HANDS (first-person gloves and arms), revision 3

HANDS supplies the first-person glove hands that `kit.glove()` mounts on every
weapon's `hand_r` / `hand_l` group (the procedural box mitt remains the offline
fallback). Two right-hand poses, `grip` (fist wrapped around a pistol grip,
thumb laid across the index and middle stalls) and `support` (open cradle with
relaxed fingers and an extended thumb); the support glove is the same geometry
mirrored in x. Revision 2 replaces the first study, whose fingers left the palm
without flexing at the base knuckle, wore ball joints that read as warts and
whose 3.6 tiles/m webbing cuff looked like wicker at first-person size. The hand
matches RIVET: graphite half-finger gloves with bare middle and distal
phalanges, an orange knuckle plate with four ribs, an ivory tendon plate and
finger armor, and a sand webbing wrist strap with buckle.

Revision 3 takes the sleeve off the glove and adds three rigid arm segments as
their own nodes, so the first-person hands reach back to the player's own body
instead of ending at a cut cuff: `forearm` (leather cuff over the glove hem,
petrol suit sleeve widening toward the elbow, webbing strap, ivory bracer with
its orange inset, rounded leather elbow pad), `upperarm` (leather elbow cap,
sleeve, webbing band, ivory plate with orange inset) and `shoulder` (suit cap,
orange pauldron on an ivory rim, gunmetal rivet). 96 authored parts,
16,416 triangles, 26 runtime primitives (one per node and material), six
shared ImageGen maps, each material at its own texture density (`uv_scale`, 4
to 15 tiles/m).

Glove-local frame (consumed verbatim, `GAME` is the identity): palm centre at
the origin, back of the hand +y, knuckles -z, thumb -x, wrist and strap at
z > 0.018, nothing beyond a 0.25 m radius. Base knuckle line at z -0.040
(pinky) to -0.049 (middle); thumb root at (-0.036, -0.004, 0.012).

Each arm segment is authored in its own joint frame: the proximal joint at the
origin, the distal joint on +z, +y the back of the forearm and the outer side
of the upper arm and shoulder. The forearm's wrist joint meets the glove at
glove-local z 0.070, six millimetres inside the glove's own hem, so the seam
cannot open. Forearm 0.31 m, upper arm 0.34 m, both inside a 0.08 m radius.

Runtime placement (`public/js/guns/kit.js`, `BLENDER_HAND_FRAMES`): each pose
takes a gun-space basis from a back-of-hand direction and a wrist-to-knuckle
direction plus a palm-centre nudge from the shared anchor sheet. The fist sits
0.085 m under the rifle-class grip anchor with its palm face on the grip's
right side, so the fingertips and thumb come round the grip's left face; the
support cradle sits under the handguard's left edge with the forearm running
down and back. `BLENDER_HAND_OFFSETS` holds the revolver and knife nudges.
The delivered materials are kept as exported: `assemble.js` skips its glove
re-texture pass for `userData.blenderAsset === 'hands'`, and `glove()` attaches
the character-skin palette key per material name (`glove leather` 0x22252a,
`ceramic armor` 0x15171a, `webbing` 0xb09a72) so skins recolour exactly the
parts the mitt exposed. Reload choreography moves `hand_l` by position and adds
its small pitch on top of the pose quaternion, unchanged.

The arms are posed by `public/js/guns/viewmodel-arms.js`, which hangs a group
off the same camera-local, fov-counter-scaled rig root the gun uses, so they
ride every bob, kick and aim move with it. Each frame it reads the final world
transform of `hand_r` / `hand_l`, takes the wrist point from it and solves one
analytic two-bone chain back to a shoulder fixed on the player's body (0.25 m
out, 0.23 m below and 0.06 m behind the eye, rotating against 70 % of the
camera pitch so the spine bends rather than the whole body). A viewmodel gun is
carried further out than a real one, so an out-of-reach hand first pulls the
shoulder up to 0.25 m toward itself and only then stretches the arm, the
forearm by at most 1.25x. A hidden or absent support glove (revolver, SMG,
knife) takes its whole arm with it, and holstering the gun for a grenade or the
medkit hides both. Segment materials carry the same three palette keys as the
gloves, so a character skin recolours hands and arms together.

Rebuild (headless, about 30 s including nine Cycles stills):

    blender --background --factory-startup --python tools/blender/hands/build-hands.py
    blender --background --factory-startup --python tools/blender/hands/export-game-assets.py
    node tools/blender-assets-browser-test.mjs

Build gates: palm spans the origin, cuff parts stay past z 0.018, 0.25 m reach,
every finger ends in a bare distal phalanx, each arm segment spans its own two
joints inside the 0.08 m radius, every part meets its group (surfaces cross, or
a vertex within 1 mm) and neighbouring proximal stalls keep >= 1.5 mm of air.
`docs/design/blender/hands/render-{grip,support}-{side,rear-quarter,palm}.png`
and `render-{forearm,upperarm,shoulder}-side.png` are the study stills; `.artifacts/blender-integration/hands-*.png` are the
in-game captures (rifle, revolver and knife held, revolver cylinder open).

## GRENADES (throwables), revision 1

One study for all five throwables of `shared/grenade-rules.js` — `frag`,
`limpet`, `pulse`, `molotov`, `smoke` — delivered as five nodes in one asset
(`public/assets/blender/grenades.gltf`, registered in
`public/js/engine/blender-assets.js` as `grenades`). Looks follow the shop
illustrations in `public/assets/grenades/hud`: M-4 FRAG as a dark faceted steel
body with three bronze rib bands and an amber fuse cap, the CLAYMORE as a
copper disc on four footed pads with an orange rim and a red sensor lens, PULSE
SHOCK as a cyan faceted core inside a dark three-meridian cage, M-18 SMOKE as a
satin steel canister with a pale band, and the molotov as a labelled bottle of
petrol with a rag plug and a hanging wick. 109 authored parts, 7662 triangles,
23 runtime primitives, fifteen materials over the same six ImageGen maps — no
new textures. Ids, timings, damage, physics and the server are untouched.

Every type is authored in the frame the first-person hands already used
(metres, y up, body centred on the origin): the fuze block sits on top with its
safety lever on +x and the pin lug at the procedural pin socket
(-0.024, 0.088, 0.019) for `frag`, `pulse` and `smoke`; the claymore faces +z
with its magnetic feet on the wall plane z -0.041 and the sensor lens looking
down the laser, which is what `ProjectileFX._poseMine`'s look-at expects; the
bottle stands on the origin plane with its wick tip at (-0.037, 0.303, 0),
where both consumers hang the wick flame.

Both consumers keep their procedural builder as the fallback when the template
is unavailable. `public/js/guns/throwable-hands.js` mounts the node verbatim.
`public/js/weapons/projectiles.js` scales it to the footprint of the procedural
prop it replaces (`AUTHORED_WORLD_SCALE`: frag 1.9, limpet 2.2, pulse 2.0,
molotov 1.5, smoke 1.85) — the thrown props read larger than life so they stay
visible mid-flight — and keeps the fuse indicators runtime-owned: the frag and
smoke fuse-cap material clone is the strobe the update loop tints, the claymore
keeps its lit lens box and laser, the pulse keeps an additive back-side aura
around the cage, and the bottle keeps its wick flame.

Build-time gates: the five nodes exist with identity transforms, each type
spans the origin and stays inside its per-type footprint box, the fuze types
keep a pin lug and a lever past x 0.050 under a fuze top at y >= 0.095, the
claymore keeps its wall plane and sensor depth, the bottle keeps its wick tip,
and the study stays inside 32 primitives and 4k–24k triangles. The validator
re-imports the GLB into an empty factory scene and then reads the runtime glTF
as JSON to confirm the same five nodes, the shared texture URIs, the
glow/glass material extras and the `.bin` length.

`docs/design/blender/grenades/render-<type>-{hero,front,rear}.png` and
`render-lineup.png` are the study stills, `validation.json` the audit and
`build-report.md` the record. `.artifacts/blender-integration/grenades-world.png`
(written by `tools/blender-assets-browser-test.mjs`) shows the five thrown
props in a WebGL scene; `.artifacts/<type>-prepare.png`
(from `tools/throwable-browser-test.mjs`) shows each one held.

```sh
# author (headless alternative to the MCP session)
blender --background --factory-startup --python tools/blender/grenades/build-grenades.py
# browser delivery, fresh-import validation, proof renders
blender --background --factory-startup --python tools/blender/grenades/export-game-assets.py
blender --background --factory-startup --python tools/blender/grenades/validate-grenades.py
blender --background --factory-startup docs/design/blender/grenades/grenades.blend \
    --python tools/blender/grenades/render-grenades.py
# runtime proof
node tools/blender-assets-browser-test.mjs
node tools/throwable-browser-test.mjs
```

## TORCH (rocket slot), revision 2

TORCH supplies the existing `rocket` slot (RX-8 HAVOC). Revision 2 is a
from-scratch redo (design study "BULWARK", chosen from three documented
alternatives in `torch/concepts/`): the first AT4-style study — thin smooth
tube with a flared orange warning cone — is deleted. Revision 2 is a heavy
sci-fi launcher: a squared breech housing with bolted cheek panels and
modelled `RX-8` / `HAVOC` stencils, half-cage braces to a front collar over
the bare tube, industrial handles (pistol grip, forward hand hold, left-flank
shoulder brace with rubber pad), a fixed underslung control canister, a
rocket nose peeking from the tube mouth, and a visibly separated breech whose
back-blast venturi gate tilts open for the reload. 108 authored parts, 15,140
triangles, 17 runtime primitives, seven frozen materials with six sampling the
shared palette maps through the material-library pass. Display name, stats,
hitboxes and the reload timeline are unchanged.

The study was authored through the live Blender MCP session (protocol 5) with
`tools/blender/torch/build-torch.py`, which creates its own scene and saves
with `copy=True`; the runtime export, validation and renders run headless.

Animated parts (runtime model `torch.js`):

- `mag`: the fixed underslung control canister — it stays put during reload.
- `bolt`: side arming lever at game z -0.040, rotated about the gun origin for
  the post-launch jerk stroke.
- `trigger`: blade (tip z -0.055) and guard at z -0.11.
- `extra`: ONLY the breech gate leaves (`gate | gunmetal`, `gate | orange
  paint`, `gate | cavity black`) with hinge-local geometry and node translation
  exactly `[-0.104, 0.075, -0.135]` (the vertical left-flank pin); the runtime
  re-parents them under a gate group on that pin (BISON cover-leaf convention)
  and reload swings the venturi 1.75 rad open sideways about the pin
  (Carl Gustaf M3 style; hinge-stop bounce on the drop, slam at the seat
  cue). No loose reload round ships: the
  runtime spawns it procedurally.

The launch tube is bare 0.0620 tube across the heat band z [-0.752, -0.528]
(the runtime 0.0625 glow sleeve and the support hand own that span) with a
clear bore of radius 0.0555 from the venturi mouth through the tube's rear
half so the reload round (seats nose at z ≈ -0.58) slides through. Ladder
sights bracket the 0.175 sight line at z -0.02 and z -0.768.

Build-time gates (all four fail the build on violation): the anchor contract
(muzzle plane, bore axis and exposed 0.0620 radius across the whole heat band,
all four markers, the 0.175 sight line, trigger blade and arming lever home),
heat-band clearance (only the bore and the seated nose inside radius 0.050),
the coplanar-face audit and the floating-part audit.

```sh
# author (headless alternative to the MCP session)
blender --background --factory-startup --python tools/blender/torch/build-torch.py
# browser delivery, fresh-import validation, proof renders, articulation stills
blender --background --factory-startup docs/design/blender/torch/torch.blend --python tools/blender/torch/export-game-assets.py
blender --background --factory-startup --python tools/blender/torch/validate-torch.py
blender --background --factory-startup docs/design/blender/torch/torch.blend --python tools/blender/torch/render-torch.py
blender --background --factory-startup docs/design/blender/torch/torch.blend --python tools/blender/torch/pose-torch.py
```

`docs/design/blender/torch/validation.json` records the fresh import of both
`torch.glb` and `public/assets/blender/torch.gltf` (gate-leaf translations at
the hinge, anchors, bounds, UV references, material images, no negative scale,
no nonfinite coordinates). `torch/build-report.md` carries the design
alternatives, the BULWARK choice and the measured counts.

## SKUA (glaive slot), revision 1

SKUA supplies the new `glaive` slot (GV-4 RIPTIDE, the 13th weapon). It is
design study "FORK", chosen from three documented alternatives in
`skua/concepts/`. It is a forearm-braced disc launcher with these parts:

- a 0.22 m toothed blade disc seated flat on a launch spindle, tilted
  6 degrees toward the eye, with a magenta razor-glow inlay ring and 24
  polished teeth;
- an orange fork bridge carrying a winged ring sight and two hinged catch
  horns that sweep forward to glowing prongs;
- an open flywheel cage with a polished drive wheel, a brass gauge and a
  tapered rear notch tower;
- a low ivory receiver with the modelled `GV-4` / `RIPTIDE` stencil;
- a pistol grip, and a strapped brace cuff with a brass buckle;
- a skeletal cassette under the receiver that shows the spare disc and a
  magenta progress strip.

It has 205 authored parts, 15,412 triangles, 19 runtime primitives and eight
frozen materials. Seven of them sample the shared palette maps; the eighth,
`SKUA | razor glow`, is the untextured `#ff3fd0` emissive.

The study was authored through the live Blender MCP session (protocol 5) with
`tools/blender/skua/build-skua.py`, which creates its own scene and saves with
`copy=True`. The runtime export, validation and renders run headless.

Animated parts (runtime model `skua.js`). Every moving part ships pivot-local,
with its pivot as the node translation:

- `mag`: the seated disc, with its pivot at the disc centre `[0, 0.042, -0.22]`.
  The geometry is baked with the 6 degree tilt, so it spins about
  `[0, cos 6, sin 6]`.
- `bolt`: the flywheel, with its pivot at the hub `[0, 0, 0.06]` (`BOLT_HOME`).
  It whirls about game z and kicks back 0.012.
- `trigger`: the blade (tip y -0.066) and the guard, at z -0.005.
- `extra`: pivot-local leaves:
  - `horn left | orange paint` and `horn left | razor glow` at `[-0.05, 0, -0.335]`;
  - `horn right | …` at `[0.05, 0, -0.335]`. Each horn swings about its
    vertical pin: right `rotation.y = -flare`, left `+flare`, 0 to 22 degrees;
  - the spare-disc round node `spare disc | blade steel / polished edge /
    razor glow` at `[0, -0.072, -0.165]`;
  - `gauge needle | brass` at `[-0.0635, 0, 0.07]`, which spins about game x.

The spindle is bare r 0.0155 rod across the heat band z [-0.40, -0.34]. The
horns and the fork pass that band off-axis, with nothing but the spindle
inside radius 0.030. The ring sight (z -0.34) is centred on the 0.150 sight
line. The rear notch (z +0.07) has its floor 5.5 mm below it, so from the ADS
eye the whole ring aperture shows above the floor, between the ears.

Build-time gates (each fails the build on violation):

- the anchor contract;
- heat-band clearance;
- the coplanar-face audit;
- the floating-part audit;
- the horn sweep audit: at 0, 11 and 22 degrees the horns clear every part
  and stay below the sight line minus 0.03;
- the disc path audit: the throw/catch slide (the disc shrinks to 0.25 by
  42 % of the slide, clearing the horn hinge knuckles and pins) and the
  cassette lift (the spare shrinks in place, the next disc grows on the seat)
  cut no part the disc does not already touch at rest;
- the rear notch gate: from the ADS eye the notch floor sits below the ring
  aperture's lower edge;
- disc visibility: the seated disc covers at least 4 % of a 50 degree ADS
  frame from the eye, and its top face shows. The measured coverage is 4.54 %.

```sh
blender --background --factory-startup --python docs/design/blender/skua/concepts/concept-blockouts.py
blender --background --factory-startup --python tools/blender/skua/build-skua.py
blender --background --factory-startup docs/design/blender/skua/skua.blend --python tools/blender/skua/export-game-assets.py
blender --background --factory-startup --python tools/blender/skua/validate-skua.py
blender --background --factory-startup docs/design/blender/skua/skua.blend --python tools/blender/skua/render-skua.py
blender --background --factory-startup docs/design/blender/skua/skua.blend --python tools/blender/skua/pose-skua.py
```

`docs/design/blender/skua/validation.json` records the fresh import of both
`skua.glb` and `public/assets/blender/skua.gltf` (`passed: true`). It covers
pivots, anchors, UVs, palette images, the razor-glow emissive and the budgets.
`skua/build-report.md` has the alternatives, the FORK choice, the node table
and the measured counts. The poses are `pose-home`, `pose-throw`,
`pose-horns-open`, `pose-empty` and `pose-cassette-lift`.

## SKIPJACK (mgl slot), revision 13

SKIPJACK supplies the existing `mgl` slot (GL-3 SKIPJACK). Revision 13 rebuilds
the CITADEL study against the approved side view
`skipjack/concepts/revision11/rounded-direction-b.png`. The earlier revisions
extruded side plates and read as slabs from above and in ADS. Revision 13 uses
rounded volumes (`tools/blender/skipjack/reference-geometry.py`):

- one lofted receiver/stock shell with super-elliptic sections traced from the
  reference outline. The dark keel (chin under the barrel collar, belly, stock
  underside) is split on an exact row seam;
- exact Boolean pockets with conformal, Delaunay-filled floors: the flat
  cassette bay, both thumb scoops and the right service cover;
- a lathed launch tube with rib bands, collar, crown and eight vented brake
  slots, a lofted raked grip with finger swells and a lofted rubber pad;
- a frame ring cassette on a vertical front hinge hub, carried by two receiver
  knuckles on a pin; three slots, rounds `round 1..3` from top to bottom.

19.3k triangles, 21 runtime draws, nine materials with seven sampling the
shared palette maps. Anchors, `sightHeight` 0.216 and the node contract are
unchanged.

Animated parts (runtime model `skipjack.js`):

- `mag`: frame, hub, pull ring, release paddle and the three round groups, hung
  on `CASSETTE_HINGE` = game (-0.142, 0.020, -0.306), the vertical hub axis. The
  reload swings the rear edge out about that axis, lifts the cassette off the pin,
  exchanges it (hidden 0.46–0.56), drops the fresh one on the pin and swings it
  shut at the home click. Slots show the reserve outside the chambered round;
  during a swap `skipjack.reload` (set by `ViewmodelRig.reload`) keeps the old
  count until the cassette leaves and the fresh load after it returns.
- `bolt`: the charging pawl in the right service pocket, racked 25 mm rearward
  only on an empty swap, where it strips one fresh round into the chamber.
- `trigger`: orange blade and pivot pin in front of the grip.
- `extra`: selector dial, chamber witness and the phosphor sight emitter.

Build-time gates (each fails the build on violation): the four frozen anchors,
the muzzle tip on the bore axis at the contract plane, heat-band clearance for
the runtime glow sleeve (r 0.046 clearance over game z [-0.752, -0.603]), an
unobstructed sight channel down the ADS line, non-empty parts, a floating-part
contact audit, outward-surface signed volume (per closed part, and jointly for
the open shell/keel pair), and the round-name contract.

```sh
# author (headless alternative to the MCP session)
blender --background --factory-startup --python tools/blender/skipjack/build-skipjack.py
# browser delivery, fresh-import validation, proof renders, reload pose stills
blender --background docs/design/blender/skipjack/skipjack.blend --python tools/blender/skipjack/export-game-assets.py
blender --background --factory-startup --python tools/blender/skipjack/validate-skipjack.py
blender --background --factory-startup docs/design/blender/skipjack/skipjack.blend --python tools/blender/skipjack/render-skipjack.py
blender --background --factory-startup docs/design/blender/skipjack/skipjack.blend --python tools/blender/skipjack/pose-skipjack.py
```

`docs/design/blender/skipjack/validation.json` records the fresh import of both
`skipjack.glb` and `public/assets/blender/skipjack.gltf` (`passed: true`). It
covers the nine-node contract, batch extras and round names, anchors, UVs,
outward normals, the muzzle tip and the budgets (fail above 32 draws / 26,000
triangles / 10 materials). `skipjack/build-report.md` has the design
rebuild notes and the measured counts; the poses are `pose-home`, `pose-open`,
`pose-lift`, `pose-exchange`, `pose-insert`, `pose-seated` and `pose-rack`.
