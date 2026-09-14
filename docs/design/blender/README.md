# Blender assets: RIVET, KESTREL and PEREGRINE

Blender 5.2.1 LTS and Blender MCP 1.9.1 were installed locally on 2026-09-13.
The requested first asset is a character, followed by a weapon. A map was not
modeled after that choice.

## Files

- `rivet/rivet.blend`: editable operator, 149 named parts, 20-bone rig.
- `rivet/rivet.glb`: merged skin mesh with Idle and Walk clips.
- `kestrel/kestrel.blend`: editable original game carbine and part rig.
- `kestrel/kestrel.glb`: merged skin mesh, Reload_Study clip, muzzle/grip/support markers.
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

Run `tools/blender/build-character.py`, then `tools/blender/build-weapon.py`,
then `tools/blender/texture-and-export.py` inside Blender. Each build script
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

Build the browser files from the packed study (Blender 5.2):

```sh
blender --background docs/design/blender/kestrel/kestrel.blend \
  --python tools/blender/export-game-assets.py
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

`validation.json` records a fresh Blender import of both final GLBs. Both pass:
one imported skin mesh, normalized vertex weights, embedded material images,
valid UV references and actual evaluated mesh motion for each animation.
RIVET has 19,320 triangles, 20 bones and six embedded images. KESTREL has 16,488
triangles, four bones and four embedded images. The clips are isolated to their
own models: Idle/Walk for the character and Reload_Study for the weapon.
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

## HANDS (first-person gloves), revision 2

HANDS supplies the first-person glove hands that `kit.glove()` mounts on every
weapon's `hand_r` / `hand_l` group (the procedural box mitt remains the offline
fallback). Two right-hand poses, `grip` (fist wrapped around a pistol grip,
thumb laid across the index and middle stalls) and `support` (open cradle with
relaxed fingers and an extended thumb); the support glove is the same geometry
mirrored in x. Revision 2 replaces the first study, whose fingers left the palm
without flexing at the base knuckle, wore ball joints that read as warts and
whose 3.6 tiles/m webbing cuff looked like wicker at first-person size. The hand
now matches RIVET: graphite half-finger gloves with bare middle and distal
phalanges, an orange knuckle plate with four ribs, an ivory tendon plate and
finger armor, a sand webbing wrist strap with buckle, the petrol suit sleeve
widening toward the elbow and the ivory forearm bracer with its orange inset.
88 authored parts, 14,912 triangles, 14 runtime primitives (one per pose and
material), six shared ImageGen maps, each material at its own texture density
(`uv_scale`, 4 to 15 tiles/m).

Glove-local frame (consumed verbatim, `GAME` is the identity): palm centre at
the origin, back of the hand +y, knuckles -z, thumb -x, wrist, strap, sleeve
and bracer at z > 0.018, nothing beyond a 0.25 m radius. Base knuckle line at
z -0.040 (pinky) to -0.049 (middle); thumb root at (-0.036, -0.004, 0.012).

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

Rebuild (headless, about 20 s including six Cycles stills):

    blender --background --factory-startup --python tools/blender/hands/build-hands.py
    blender --background --factory-startup --python tools/blender/hands/export-game-assets.py
    node tools/blender-assets-browser-test.mjs

Build gates: palm spans the origin, cuff parts stay past z 0.018, 0.25 m reach,
every finger ends in a bare distal phalanx, every part touches its pose (1 mm
BVH contact audit) and neighbouring proximal stalls keep >= 1.5 mm of air.
`docs/design/blender/hands/render-{grip,support}-{side,rear-quarter,palm}.png`
are the study stills; `.artifacts/blender-integration/hands-*.png` are the
in-game captures (rifle, revolver and knife held, revolver cylinder open).
