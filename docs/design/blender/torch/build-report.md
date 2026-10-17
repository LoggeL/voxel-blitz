# TORCH — RX-8 HAVOC rocket launcher, revision 4

Study name: **RIDGEBACK**. Blender asset id `torch`, game slot `rocket`,
display name RX-8 HAVOC. Revision 4 replaces the revision-3 VANGUARD octagonal
receiver with the GPT Image 2.5 concept study in
`docs/design/havoc-rev4/concept-ridgeback.png` (prompts and selection in that
directory).

## Design intent

- **Lofted super-elliptic receiver** — a rounded-rectangle olive-drab shell
  with a low dorsal spine, chamfered flank armor, recessed polymer service
  pockets, three gunmetal collar bands with orange accent rings, and modelled
  `RX-8` / `HAVOC` ivory stencils on raised plates.
- **Perforated forward shroud** — sixteen gunmetal hexagonal frames over a
  cavity-black sleeve, two staggered rows, four longitudinal rails and orange
  warning collars. The cells are real frames, so they read as cooling ports
  without a boolean pass.
- **Low left-flank ballistic computer** — a polymer box with an orange lens,
  kept below the 0.175 m sight line so the ADS silhouette stays clean.
- **Castellated muzzle crown** — machined-steel blast collar, orange warning
  band and six crown lugs; the seated ivory/orange warhead noses into the mouth.
- **Four-port blast-brake breech gate** — four tapered lobes with 18-degree
  gaps, dark port floors, a central gunmetal hub and orange warning bands. It
  swings on the same vertical left-flank pin as revision 3 and stays inside the
  same 0.083 m envelope.
- **Furniture** — raked polymer pistol grip with rubber panels and finger
  swells, angled foregrip around the support marker, left-flank shoulder pad,
  underslung ignition canister (`mag`), right-flank arming lever (`bolt`) and
  the trigger assembly (`trigger`).
- **Authored rocket round** — unchanged contract: ivory/orange ogive, olive
  motor body, orange aft ring, steel nozzle and four swept fins within radius
  0.051.

## Part contract

Authoring space +Y forward, +Z up, +X right; game map `game_x = x,
game_y = z, game_z = -y`. Anchors (game space): muzzle `[0, 0.075, -0.78]`,
grip `[0.045, -0.02, -0.08]`, support `[-0.06, -0.03, -0.40]`, sight
`[0, 0.175, -0.34]`. Bore axis x 0 / y 0.075, exposed radius 0.0620 across
the heat band z [-0.752, -0.528], clear bore radius 0.0555.

- `body`: launch tube, bore liner and blast baffle, receiver, perforated
  shroud, muzzle crown, sight bridge and sights, grips, shoulder pad, hinge
  hardware, ballistic computer and markings.
- `mag`: the fixed underslung ignition canister.
- `bolt`: right-flank arming lever at game z -0.040.
- `trigger`: blade, shoe and guard.
- `extra`: the four blast-brake lobes, port floors, hub, hinge knuckles and
  latch (`gate | <material>`), plus the rocket round leaves
  (`round | <material>`) at seat-local geometry and node translation
  `[0, 0.075, -0.55]`.

## Commands

```sh
blender --background --factory-startup --python tools/blender/torch/build-torch.py
blender --background --factory-startup docs/design/blender/torch/torch.blend --python tools/blender/torch/export-game-assets.py
blender --background --factory-startup --python tools/blender/torch/validate-torch.py
blender --background --factory-startup docs/design/blender/torch/torch.blend --python tools/blender/torch/render-torch.py
blender --background --factory-startup docs/design/blender/torch/torch.blend --python tools/blender/torch/pose-torch.py
```

## Counts (measured, final build, 2026-10-17)

- 180 authored source parts, 23 material batches (draw calls, budget 28),
  21,848 triangles (budget 8k-22k).
- Per primitive: body 15,700 · mag 648 · bolt 216 · trigger 312 · gate 3,612 ·
  round 1,360.
- 8 materials: gunmetal → phosphated-steel, olive drab → olive-paint,
  orange paint → orange-paint, ivory coating → ivory-ceramic, polymer →
  molded-polymer, rubber → pebbled-rubber, machined steel → machined-steel;
  cavity black untextured. Shared 1024px palette JPEGs from
  `tools/blender/material-library.py`.
- Bounds (game space): x -0.136..+0.114, y -0.131..+0.196, z -0.795..+0.048.
  UV density 3.6 tiles/m, analytic projection.
- Files: torch.blend 1.58 MB · torch.glb 3.85 MB · torch.gltf 20 kB ·
  torch.bin 1.49 MB.

## Checks actually executed

1. **Anchor contract** (fails the build): muzzle plane, bore axis, exposed
   0.0620 radius across the heat band, all four markers, the 0.175 sight line,
   trigger blade and arming lever home position.
2. **Heat-band clearance** (fails the build): only the bore assembly and the
   seated round nose enter the band.
3. **Coplanar-face audit** (fails the build): clean.
4. **Floating-part audit** (fails the build): clean. The shroud hex frames
   overlap the cavity-black sleeve; the ballistic computer overlaps the
   receiver; the gate knuckles run within 0.5 mm of the hinge pin.
5. **Gate sweep** (fails the build): 1,864 gate vertices × 38 angles
   (0..1.85 rad). Open bore-axis clearance 0.0928 m (need 0.055); tightest
   swing gap 9.5 mm (front lip vs trigger guard at 0.3 rad); closed bounds
   x ±0.0799, y -0.048..0.112, z ±0.0799 about the bore.
6. **Fresh-import validation** (`validate-torch.py`, both files,
   `validation.json` `passed: true`): node names, gate and round translations,
   round local bounds -0.245..+0.150, anchors, UVs, embedded palette images,
   budgets, no negative scales or non-finite coordinates.
7. **Browser** (`npm run weapons:blender:browser`): the runtime loader builds
   TORCH with its palette materials.

## Limitations

- Scalar metallic/roughness only: no baked normal, occlusion or roughness maps.
- Single LOD; no mobile GPU profiling.
