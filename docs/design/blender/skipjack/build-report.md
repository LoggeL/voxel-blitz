# GL-3 SKIPJACK — build report (revision 8, design study "CITADEL")

A from-scratch redo of the GL-3 SKIPJACK grenade-launcher model. The revision 7
study it replaces read as an assembly of unrelated slabs: a stepped riser tower
carrying a wire-cage reflex, three oversized bottles bolted on an open bracket
outside the receiver wall, ski rails floating on a thin barrel, and a bent-wire
release tap dangling below. This revision rebuilds the weapon around one
continuous silhouette and a bayed ammunition cassette.

The in-game weapon is unchanged in every gameplay respect: display name
GL-3 SKIPJACK, id `mgl`, stats, hitboxes, `sightHeight` 0.291, HANDS anchors,
TIMERS and the reload timeline are all untouched.

## Design

Three alternatives were authored as real-geometry Blender blockouts and judged
from their renders before any production geometry was made; the prompts, the
renders and the full reasoning live in `concepts/concept-prompts.md` and
`concepts/concept-blockouts.py`. **Alternative 1, "CITADEL", was chosen**: one
continuous faceted armoured wedge with a bayed cassette. Two refinements were
taken from the losers — TREBUCHET's ladder language (the tall 0.291 m sight line
now reads as arc-range hardware, not a tower of plates) and its muzzle
authority (an octagonal chamfered crown nut with slot vents).

The delivered forms:

- A faceted wedge receiver flowing along one diagonal top ridge from the stock
  comb to the muzzle nut, with chamfered cheek panels and a belly rail.
- A bare 40 mm launch tube across the runtime heat band (game z -0.752 to
  -0.603, where the firing glow sleeve rides at r 0.0415), an octagonal shroud
  with machined collars and an orange datum band behind it, and the crowned
  muzzle with a visible hollow bore.
- A three-grenade cassette bayed on the left flank: each 40 mm grenade has a
  brass base, olive body, orange arming band, machined shoulder and ogive nose,
  held between machined rims in a gunmetal frame (spine, lower bar, posts) that
  mounts on the receiver's bay plate. A transverse trunnion pin rides in two
  receiver saddles; an orange release paddle sits at the frame's lower rear.
- The arc-range ladder sight: two swept fins rising from the top rail that ARE
  the reflex housing wings, three orange range dots and a cursor bar, a hooded
  micro reflex with a cyan lens pane and the emissive dot at the frozen sight
  marker. The ADS sight window down the axis is completely open.
- A tapered olive stock with cheek comb, butt plate and rubber pad; a raked
  pistol grip with rubber backstrap and base cap at the grip anchor; a swept
  trigger guard with orange blade in line with the grip; a slim angled support
  fore-grip with hand stop and orange index at the support anchor.
- Right cheek: the charging pawl in its track (reciprocating `bolt` part), a
  brass fire selector and a phosphor round counter.

## Contract

Authoring space is +Y muzzle, +Z up, +X right; the delivery maps game
(x, y, z) = (x, z, -y) — a proper rotation, so normals map like positions.

Frozen anchors (authoring → game):

| marker | authoring | game |
| --- | --- | --- |
| muzzle | (0, 0.782, 0.075) | (0, 0.075, -0.782) |
| grip | (0.047, 0.056, -0.203) | (0.047, -0.203, -0.056) |
| support | (-0.058, 0.373, -0.184) | (-0.058, -0.184, -0.373) |
| sight | (0, 0.332, 0.291) | (0, 0.291, -0.332) |

Runtime nodes: exactly nine top-level nodes — the `body` / `mag` / `bolt` /
`trigger` / `extra` group empties and the four gameplay mount markers — with
per-(part, material) merged batches named `<part> | <key>` and the three
vertex-coloured rounds merged as `mag | round 1..3` (`extras.ammoRound` 1..3,
`RoundColor` preserved as COLOR_0). Node chains are translation-only and
geometry is baked in game space.

Animated parts (`public/js/guns/models/skipjack.js`,
`public/js/guns/actions.js`):

- `mag`: the whole cassette — bay plate, frame, rims, trunnion pin, release
  paddle and lever, and the three named grenade meshes. The runtime hangs them
  on a hinge group at `CASSETTE_HINGE` = game **(-0.163, 0.055, -0.30)** (the
  trunnion pin line); revision 7 used (-0.276, -0.049, -0.289). The reload tips
  the cassette down-left about the pin, exchanges it in the 0.47–0.60 window
  and seats it at the home click.
- `bolt`: the charging pawl at game (0.094, 0.113, -0.175), racked 25 mm
  rearward at the end of the reload. The left hand returns to it at the existing
  pawl target.
- `trigger`: swept guard, pivot pin and orange blade in line with the grip axis
  (the blade tips about the gun origin on the tactile trigger animation).
- `extra`: fire selector, round counter and the phosphor sight emitter.
- Round visibility follows the authoritative magazine count
  (`viewmodel.setSkipjack`): a spent round disappears and its chamber reads
  empty.

One choreography constant moved with the redesign: the left hand's `release`
target in `_updateSkipjackReload` is now **[-0.19, -0.10, -0.12]** (game), the
new orange release paddle position; revision 7's paddle sat at
[-0.29, -0.125, -0.30] on its wider frame. Everything else in the reload
timeline is untouched.

## Counts (measured)

| metric | revision 8 | revision 7 |
| --- | --- | --- |
| source parts | 99 | 262 |
| runtime draws | 20 | 29 |
| triangles | 11,228 | 25,696 |
| geometry bytes (skipjack.bin) | 549,848 | 1,219,544 |
| materials | 10 (nine palette keys + `round colors`) | same |
| textured materials | 7 | 7 |

Draw budgets fail above 32 draws / 26,000 triangles / 10 materials and target
26 draws / 20,000 triangles; revision 8 lands under both targets. Each grenade
merges to one vertex-coloured draw (six finishes per round in a `RoundColor`
corner layer), so the three live rounds cost three draws.

## Files

- `tools/blender/skipjack/build-skipjack.py` — authoring (geometry, materials,
  markers, ten build gates) and the study save.
- `tools/blender/skipjack/export-game-assets.py` — browser delivery
  (`public/assets/blender/skipjack.gltf` + `.bin`), portable GLB, manifests,
  shared material finalizer and the SKIPJACK tint pass.
- `tools/blender/skipjack/validate-skipjack.py` — fresh-import audit
  (`validation.json`).
- `tools/blender/skipjack/render-skipjack.py` — hero/side proofs and the review
  views; `tools/blender/skipjack/pose-skipjack.py` — reload-choreography stills.
- `docs/design/blender/skipjack/skipjack.blend` — editable study (source parts
  with bevel/weighted-normal modifiers, studio gear excluded from delivery).
- `docs/design/blender/skipjack/skipjack.glb` — portable twin of the same
  geometry (1,895,284 bytes, textures embedded).
- `skipjack-hero.png`, `skipjack-side.png`, `review/final/{right-side,muzzle,rear,top,ads}.png`,
  `pose-{home,open,exchange,seated}.png` — Cycles proofs rendered from the
  actual model.
- `manifest.json` (revision 8) and `material-library.json`.

## Commands executed

```sh
# authoring: the live Blender MCP session (execute_blender_code) runs
#   exec(compile(Path('tools/blender/skipjack/build-skipjack.py').read_text(), ...))
# the headless fallback is:
blender --background --factory-startup --python tools/blender/skipjack/build-skipjack.py
# browser delivery + manifests + material finalizer
blender --background docs/design/blender/skipjack/skipjack.blend \
    --python tools/blender/skipjack/export-game-assets.py
# fresh-import validation
blender --background --factory-startup --python tools/blender/skipjack/validate-skipjack.py
# proof renders and reload pose stills
blender --background --factory-startup docs/design/blender/skipjack/skipjack.blend \
    --python tools/blender/skipjack/render-skipjack.py
blender --background --factory-startup docs/design/blender/skipjack/skipjack.blend \
    --python tools/blender/skipjack/pose-skipjack.py
```

The concept study was also authored through Blender MCP
(`concepts/concept-blockouts.py`), producing the seven renders in `concepts/`.

## Checks executed (tested, not assumed)

Build gates in `build-skipjack.py` — all ten pass, and each raises on violation:

1–4. the four frozen anchors, exact to 1e-6;
5. muzzle tip: forward-most geometry at the contract plane with the tip band
   centroid on the bore axis (176 vertices at y = 0.782);
6. heat band: no part but the launch tube intrudes within r 0.046 of the bore
   axis over the glow-sleeve span;
7. sight channel: nothing but the lens and emitter within r 0.025 of the ADS
   line between the eye and the lens;
8. floating parts: every part's bounds touch a neighbour within 4 mm;
9. outward surfaces: per-part signed volume (the exact math of the delivery
   normal audit) is positive — this gate caught an inverted-winding bug in the
   profile/extrude helper during development;
10. round contract: all 18 grenade parts named `round N | <finish>`.

`validate-skipjack.py` re-imports both the portable GLB and the runtime glTF
into an empty factory scene: **passed: true, zero failures, zero advisory**
(`validation.json`). It checks the nine-node top-level contract, batch naming
and extras, `mag | round 1..3` with `ammoRound` and runtime round names, UVs on
every mesh, positive signed volume per batch, the muzzle tip at game
(0, 0.075, -0.782), translation-only node chains, finite accessor bounds,
material key names, and the draw/triangle/material budgets.

## Runtime integration (browser-tested)

Every command below ran against the delivered files in a real browser session
and passed:

| command | evidence |
| --- | --- |
| `node tools/blender-assets-browser-test.mjs` | 540-pose sweep across all 15 weapons including `mgl`, plus a live Training match |
| `node tools/weapon-materials-browser-test.mjs` | asserts `buildGun('mgl').body.userData.blenderAsset === 'skipjack'` (a procedural fallback would fail it) **and** per-asset UVs, palette texture delivery and no duplicated maps; skipjack row: materials 10, palette materials 7, triangles 11,260 |
| `node tools/render-hud-icon.mjs --weapon mgl` | `public/assets/weapons/hud/mgl.png` (44,115 bytes) rendered from the delivered glTF through the browser renderer |
| `node tools/render-weapon-scenes.mjs --weapon mgl` | 10 states — swap-stow/draw/ready, held, vaulting, scoped, firing, reload-open/load/charge — in `.artifacts/weapon-renders/mgl-*.png` |
| `npm run weapons:reload:test` | reload state/network/animation/presentation suites, every firearm including `mgl` |
| `node tools/reload-browser-test.mjs` | 28 exchange/insertion poses across 14 weapons, `.artifacts/reloads/mgl-0.5.png` and `mgl-0.74.png` |

The delivered glTF carries 11,228 triangles; runtime tooling counts 11,260 for
the assembled `buildGun` model — the 32-triangle delta is the runtime's own
helper geometry (the legacy bolt-glow cap and the heat sleeve)
[INFERENCE: consistent across both runtime tools, not directly attributed].

The reload capture beats (`reload-open`, `reload-load`, `reload-charge`) were
added to `shared/weapon-capture-shots.js` for this weapon, following the
registry's own criterion of feed systems with visible mechanism work.
`reload-charge` settles to the same rest pose as `held` — the pawl rack is a
brief mid-beat and the capture freezes after it, matching the rocket's
final-beat convention.

Two other runtime tools fail on **pre-existing menu/career UI drift that never
loads a weapon model** (no `mgl`/`skipjack` assertion in either path, both
reproduced deterministically and root-caused to their own UI contract):

- `tools/weapon-wheel-browser-test.mjs` clicks `#create-lobby-btn` (line 46)
  while the play gate still holds it disabled, so the click is swallowed
  (`public/js/ui/menu-lobby.js:211`) and the lobby wait times out. The sibling
  integration test waits for `create-lobby-btn.disabled === false` first
  (`tools/blender-assets-browser-test.mjs:323-326`); this one must too
  (`tools/weapon-wheel-browser-test.mjs:41-46`).
- `tools/armory-browser-test.mjs:56` asserts the whole 17-row career unlock
  branch fits inside the capped `#career-shop` scrollport after one
  `scrollIntoView` — unsatisfiable for the current 40-item catalog
  (`public/styles/career.css:2,250-251`); the predicate must test that the
  branch is reachable by scrolling, per its own failure message.

## Remaining limitations

- The delivered glTF carries base-colour textures with scalar metallic and
  roughness values; Blender-only bump chains stay out of the runtime, as with
  every other weapon asset. The renders are Cycles stills of the study, not
  in-game frames.
- `assemble.js` adds its legacy bolt-glow cap at game (-0.02, 0.07, 0.017),
  which sits inside the receiver wedge (invisible). This matches KESTREL's
  shipped behaviour and revision 7; it was not addressed here.
- The launcher has no modelled ejection port: GL-3 fires caseless arcing rounds
  with `ejectOnFire: false`, and the reload swaps the whole cassette, so the
  existing `portY` / `ejectRight` values only place transient eject FX.
- Trigger and guard animation pivot about the gun origin like every other
  weapon; at extreme angles the blade can visually clip the grip's front strap.
