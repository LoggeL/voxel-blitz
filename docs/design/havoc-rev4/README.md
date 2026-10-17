# RX-8 HAVOC revision 4 (RIDGEBACK)

Revision 4 replaces the VANGUARD octagonal receiver with a lofted
super-elliptic shell, a perforated forward shroud, a low left-flank ballistic
computer and a four-port blast-brake breech gate. The frozen runtime anchors,
reload hinge, round seat and 0.175 m sight line are unchanged.

## References

- [Concept RIDGEBACK](concept-ridgeback.png) (selected), generated with
  `gpt-image-2.5-flare` from `prompts/ridgeback.txt`.
- [Concept SIEGEBREAK](concept-siegebreak.png) and
  [Concept BRUTUS](concept-brutus.png) were generated from the same brief for
  comparison. RIDGEBACK won on first-person silhouette: its perforated shroud
  gives the launcher an identity without adding rear mass or blocking the
  sight channel.
- Blender studio renders: `docs/design/blender/torch/render-*.png`.

## What changed

- Receiver: a lofted super-elliptic olive-drab monocoque with a low dorsal
  spine, recessed polymer service pockets, three gunmetal collar bands with
  orange accent rings and modelled `RX-8` / `HAVOC` stencils.
- Forward shroud: sixteen gunmetal hexagonal frames over a cavity-black
  sleeve, four longitudinal rails and orange warning collars. The frames are
  real rings, so the cells read as cooling ports without booleans.
- Furniture: the left-flank carry handle of the concept became a low ballistic
  computer so the ADS silhouette stays clean; the raked pistol grip, angled
  foregrip, shoulder pad and underslung ignition canister are retained.
- Breech: the De Laval bucket is replaced by four tapered blast-brake lobes
  with dark port floors and a central gunmetal hub. It swings on the same
  left vertical pin, inside the old 0.083 m envelope.
- Materials: the exposed launch tube is gunmetal; the muzzle collar uses the
  machined-steel palette entry for a small, intentional highlight.

## Commands

```sh
blender --background --factory-startup --python tools/blender/torch/build-torch.py
blender --background --factory-startup docs/design/blender/torch/torch.blend \
  --python tools/blender/torch/export-game-assets.py
blender --background --factory-startup --python tools/blender/torch/validate-torch.py
blender --background --factory-startup docs/design/blender/torch/torch.blend \
  --python tools/blender/torch/render-torch.py
```

## In-game captures

All captures are unedited muted headless CDP renders of `weapon-capture.html`
(presentation fixtures, not a network match).

- [`after/`](after/index.html): desktop 1600×800 — swap, held, scoped, firing,
  vaulting and the three reload beats.
- [`after-mobile/`](after-mobile/index.html): portrait 390×844 — held, scoped,
  reload-open and reload-load.

## Checks

- Build gate: 0 contract, 0 heat-band, 0 coplanar, 0 floating, 0 gate-sweep
  failures. 180 source parts, 23 material batches, 21,848 triangles.
- Fresh-import validation: `validation.json` `passed: true` for the GLB and the
  browser glTF.
- Runtime contract: hinge `[-0.104, 0.075, -0.135]`, round seat
  `[0, 0.075, -0.55]`, muzzle `[0, 0.075, -0.78]`, sight height `0.175`,
  exposed bore radius `0.0620`.
