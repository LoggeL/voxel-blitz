# BALLISTA — build report

Fresh, original sniper-rifle model for the Voxel Blitz `sniper` slot. No
geometry reused from the older PEREGRINE study; only the frozen runtime
interface (anchors, part nodes, markers, shared ImageGen maps) is common.

## Design

High-spine siege rifle: enclosed monolithic receiver with the bolt riding in
a top trough on guide rails, full-length HIGH rail spine on two riser blocks,
octagonal barrel shroud (ends y = 0.540, clear of the heat band), smooth bull
barrel at exactly r = 0.0210 across the band, recessed target crown with a
dark muzzle mouth (nothing exceeds 0.0210 at the muzzle), closed thumbhole
stock with a genuine opening, adjustable cheek riser, buttstock ammo sleeve
holding the 3 stripper rounds, short curved 5-round magazine, teardrop bolt
knob on a swept arm reaching x = -0.123, twin-ring cantilever optic on the
0.205 sight line with orange elevation dial, modelled `BALLISTA` / `VB 91`
markings as geometry.

## Verification (all green)

- Build-time anchor contract: muzzle plane, bore axis (0, 0.055), 0.0210
  heat-band radius with no foreign geometry, all four markers, 0.205 sight
  line, trigger tip, bolt home — pass.
- Coplanar-face audit: clean. Part-contact audit: every part meets the
  receiver (119 source parts).
- Fresh-scene GLB reimport (`validate-ballista.py`): **passed**, 0 failures.
  17,196 tris (budget 10k–20k), 19 mesh primitives (budget 24), 7 materials
  (budget 8), 6 embedded images, identity part transforms, rounds centred on
  own origins parented to `extra`, anchors exact to 5 decimals.
- Visual inspection of hero/side/ads/rear renders: no floaters, no z-fighting
  seams at render distance; sight picture clear through both lenses; bolt
  handle, sleeve rounds, turrets and markings all read. One fix applied from
  inspection (`VB 91` moved clear of the armor panel edge).

## Files

- `docs/design/blender/ballista/ballista.blend` — editable source, packed
- `docs/design/blender/ballista/ballista.glb` — portable delivery (2.9 MB)
- `docs/design/blender/ballista/manifest.json`, `validation.json`
- `docs/design/blender/ballista/render-{hero,side,ads,rear}.png`
- `tools/blender/ballista/build-ballista.py`, `render-ballista.py`,
  `validate-ballista.py`

## Method note

Blender MCP's server was up but the GUI/addon socket (127.0.0.1:9876) was
down (connection refused), so authoring ran through headless Blender
(`--background --factory-startup`) — the repository's own convention for long
Blender work and the same Blender Python the MCP bridge executes. No live
session state was touched.

## Not in scope

Runtime `public/assets/blender/ballista.gltf/.bin` wiring, `ballista.js`
model wiring, HUD icon, and in-game pose/ADS check — orchestrator follow-ups.

## Alignment pass (reference: AWM side profile)

Compared against real-steel side profiles (AWM primary, M82/M200 supporting)
and closed the gap wherever the frozen contract allows. AWM two-tone:
olive-drab furniture over blackened metal, both tinted from the delivered
worn-gunmetal map (no new images). Enclosed thumbhole via a lower grip web;
short octagonal shroud with an exposed fluted-look barrel in an open sidewall
channel; two staggered brake-port rows with collar rings (all <= 0.0210);
tapered muzzle 0.0210 -> 0.0190; scope rings spread to y = 0.080 / 0.360 on
an extended cantilever bar so the front ring carries the tube ahead of the
rail; solid mount cradles; slim bells (eyepiece 0.026, objective 0.044,
apertures unchanged); short teardrop bolt; ribbed magazine; buttpad spacers
and folded rear monopod; slim forend and folded-back bipod.
156 source parts, 18,332 tris, 19 prims, 8 materials, all gates green,
fresh reimport passing with zero failures.
Deliberately not aligned: scope axis height (frozen 0.205 sight line), bare
heat band (frozen 0.0210 clearance), muzzle width ceiling (frozen 0.0210),
objective aperture floor (frozen 0.040 clear radius). A true wide brake, a
hugging-low scope and a slimmer barrel need contract changes, not geometry.

## User override (2026-09-14): optic moved 30 mm rearward

Against advice, the whole factory-optic group (tube, bells, both lenses,
rings, cradles, turrets, mount bar, cheeks) plus the high rail and its lugs
were shifted 30 mm toward the butt. Lens planes are now rear y = -0.035 and
front y = 0.475 (game z +0.035 / -0.475) instead of the frozen -0.005 / 0.505
procedural envelope. Consequence: the in-game ADS camera and sight picture no
longer line up with the glass until the runtime envelope is re-tuned to the
new planes. Optical axis height is unchanged (sight marker still valid).
