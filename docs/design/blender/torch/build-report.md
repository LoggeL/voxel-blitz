# TORCH — RX-8 HAVOC rocket launcher, revision 3

Study name: **VANGUARD**. Blender asset id `torch`, game slot `rocket`,
display name RX-8 HAVOC. Revision 3 replaces revision 2 (BULWARK: squared
breech, half cage, flat white top deck, oversized bucket venturi) with the
ImageGen Concept A in `docs/design/havoc/` (prompts, selection and in-game
captures in `docs/design/havoc/README.md`), plus Concept B's orange-tipped
right-flank arming lever.

## Design intent

- **Sculpted receiver** — two octagonal olive-drab shells with chamfered
  upper shoulder fairings, a belly fairing, three gunmetal collar bands with
  orange accent rings, flank armour plates, dark polymer service pockets and
  modelled `RX-8` / `HAVOC` ivory stencils on both flanks.
- **Slotted forward jacket** — a gunmetal jacket with six axial cooling ribs
  and black slot voids, an orange band and a taper down to the bare 0.0620
  launch tube across the heat band.
- **Castellated muzzle crown** — blast collar, orange warning band and six
  crown lugs (the top quadrant stays free for the front sight riser). The
  seated warhead's ivory/orange nose sits in the mouth.
- **Low-profile sight bridge** — a gunmetal rail on three stanchions under
  the 0.175 sight line, an open U-notch rear sight (no crossbar in the sight
  window) and a hooded front post with an orange tip.
- **Compact fluted venturi** — the breech gate is a De Laval cone of outer
  radius 0.068 at the throat to 0.079 at the rear, a 0.083 rim bumper and eight
  flute ribs: no wider than the receiver, so the hip and sight views look past
  it (revision 2's rim reached 0.096). Two knuckles on the vertical left-flank
  pin, joined to the cone by knuckle arms; orange cam latch on the right.
- **Furniture** — raked polymer pistol grip with rubber panels and finger
  swells, a vertical foregrip around the support marker, a left-flank shoulder
  pad clear of the gate swing, and the underslung ignition canister (`mag`).
- **Authored rocket round** — ogive warhead (orange tip, ivory ogive, orange
  band), olive shoulder and motor body, orange aft ring, steel nozzle and four
  swept fins within radius 0.051, nose at game z -0.245 and nozzle at +0.150
  relative to its seat.

## Part contract

Authoring space +Y forward, +Z up, +X right; game map `game_x = x,
game_y = z, game_z = -y` (the glTF exporter's +Y-up conversion is the same
map). Anchors (game space): muzzle `[0, 0.075, -0.78]`, grip
`[0.045, -0.02, -0.08]`, support `[-0.06, -0.03, -0.40]`, sight
`[0, 0.175, -0.34]`. Bore axis x 0 / y 0.075, exposed radius 0.0620 across
the heat band z [-0.752, -0.528], clear bore radius 0.0555.

- `body`: tube core, bore liner and blast baffle, receiver, jacket, muzzle
  crown, sight bridge and sights, grips, shoulder pad, hinge hardware, latch
  keeper and markings.
- `mag`: the fixed underslung ignition canister.
- `bolt`: right-flank arming lever at game z -0.040; the runtime rotates the
  group +0.55 rad about the gun origin while the breech is open.
- `trigger`: blade (tip at z -0.055), shoe and guard at z -0.11.
- `extra`: the breech gate leaves (`gate | gunmetal`, `gate | orange paint`,
  `gate | cavity black`) with hinge-local geometry and node translation
  exactly `[-0.104, 0.075, -0.135]`, and the rocket round leaves
  (`round | <material>`, five materials) with seat-local geometry and node
  translation `[0, 0.075, -0.55]`. The runtime shows one copy as the
  chambered warhead (driven by authoritative ammunition) and drives a clone
  along the reload path.

## Commands

```sh
blender --background --factory-startup --python tools/blender/torch/build-torch.py
blender --background --factory-startup docs/design/blender/torch/torch.blend --python tools/blender/torch/export-game-assets.py
blender --background --factory-startup --python tools/blender/torch/validate-torch.py
blender --background --factory-startup docs/design/blender/torch/torch.blend --python tools/blender/torch/render-torch.py
blender --background --factory-startup docs/design/blender/torch/torch.blend --python tools/blender/torch/pose-torch.py
```

`concepts/` keeps revision 2's blockout alternatives (ANVIL, CAGE, BULWARK)
for history; the revision 3 references live in `docs/design/havoc/`.

## Counts (measured, final build, 2026-10-16)

- 151 authored source parts, 22 material batches (draw calls, budget 28),
  19,716 triangles (budget 8k-22k; build GLB and runtime glTF agree).
- Per primitive: body 13,780 · mag 648 · bolt 216 · trigger 312 ·
  gate 3,400 · round 1,360.
- 7 materials: gunmetal → phosphated-steel, olive drab → olive-paint,
  orange paint → orange-paint, ivory coating → ivory-ceramic, polymer →
  molded-polymer, rubber → pebbled-rubber (shared 1024px palette JPEGs from
  `tools/blender/material-library.py`); cavity black untextured.
- Bounds (game space): x -0.136..+0.114, y -0.131..+0.196,
  z -0.795..+0.048. UV density 3.6 tiles/m, analytic projection.
- Files: torch.blend 1.33 MB (varies slightly between identical runs) ·
  torch.glb 3.33 MB · torch.gltf 20 kB · torch.bin 1.34 MB.

## Checks actually executed

1. **anchor contract** (fails the build): muzzle plane, bore axis, exposed
   0.0620 radius across the heat band, all four markers, the 0.175 sight line
   with no non-sight vertex inside |x| < 0.02 reaching it, trigger blade and
   arming lever home position.
2. **heat-band clearance** (fails the build): only the bore assembly and the
   seated round nose enter the band.
3. **coplanar-face audit** (fails the build): clean.
4. **floating-part audit** (fails the build): clean. Revision 3's first build
   only passed because the oversized cone grazed the lever boss; the knuckle
   arms now run into their knuckle eyes (2.5 mm short of the pin).
5. **gate sweep** (fails the build): 1,728 gate vertices × 38 angles
   (0..1.85 rad). Closed venturi bounds x ±0.083; open bore-axis clearance
   0.093 (need 0.055); tightest swing gap 9.6 mm (throat collar vs trigger
   guard at 0.3 rad).
6. **fresh-import validation** (`validate-torch.py`, both files,
   `validation.json` `passed: true`): node names, gate and round translations,
   round local bounds -0.245..+0.150, anchors, UVs, embedded palette images,
   budgets, no negative scales or non-finite coordinates.
7. **browser** (`npm run weapons:blender:browser`, muted headless CDP): the
   runtime loader builds TORCH with its palette materials.

## Limitations

- Scalar metallic/roughness only: no baked normal, occlusion or roughness maps.
- Single LOD; no mobile GPU profiling.
