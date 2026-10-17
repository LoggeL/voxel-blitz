# RX-8 HAVOC redesign (TORCH revision 3)

> Superseded by [revision 4 (RIDGEBACK)](../havoc-rev4/README.md). This file is
> kept as the revision-3 design record.

The HAVOC's revision 2 model read as a blocky slab with a flat white top plank
and an oversized bucket venturi that filled the first-person view. This pass
rebuilds the Blender asset `torch` from an ImageGen concept, ships an authored
rocket round, and shows the chambered warhead from authoritative ammunition.

## References

- [`before/`](before/index.html): the in-game weapon render matrix before the
  change (`npm run weapons:capture -- --weapon rocket`).
- [Concept A, VANGUARD](concept-a.png) (selected) and
  [Concept B, BREACHER](concept-b.png); the exact prompts and the selection
  reasoning are in [prompts.md](prompts.md). Concept B contributes the
  orange-tipped right-flank arming lever.
- Blender renders and articulation poses: `docs/design/blender/torch/`
  (`render-*.png`, `pose-*.png`); the build record is
  [build-report.md](../blender/torch/build-report.md).

## What changed in game

- Model: sculpted olive receiver, slotted forward jacket, castellated muzzle
  crown, low sight bridge with an open U-notch rear sight, and a compact fluted
  venturi no wider than the receiver (rim radius 0.083, was 0.096). The
  sight view keeps the front post and notch clear.
- Round: the Blender `round | <material>` leaves become two groups. The
  chambered warhead sits at `ROCKET_SEAT` (game `[0, 0.075, -0.55]`) and is
  visible only while the authoritative or predicted magazine holds a rocket
  (`syncRocketAmmo`), or once the reload shove has seated it. A clone runs the
  reload path and hands off to the chambered copy at `timeline.home`. Firing,
  cancelling, swapping and death all restore the authoritative state; remote
  avatars use the same rule.
- Reload framing: on portrait screens the rig passes a `narrow` factor
  (0 at aspect ≥ 1, 1 at aspect ≤ 0.46) and the round is staged nearer the bore
  and further from the camera, so the whole run-in stays on screen. Landscape
  and desktop keep the original wide run-in.
- Node fallback: without the Blender template (headless tests) the slot still
  builds no launcher body, only procedural reload props, so the choreography
  stays testable.

Gameplay values (damage, reload time, magazine) are unchanged.

## Captures

All captures are unedited muted headless CDP renders of `weapon-capture.html`
(states are presentation fixtures, not a network match).

- [`after/`](after/index.html): desktop 1600×800, all ten states (swap,
  held, scoped, firing, vaulting, reload open/load/charge).
- [`after-mobile/`](after-mobile/): portrait 390×844 for held, scoped,
  firing and the three reload beats. Swap-stow is not captured in portrait:
  the stowed gun leaves the frame empty, which the capture tool rejects.

```sh
node tools/render-weapon-scenes.mjs --weapon rocket --out-dir docs/design/havoc/after
node tools/render-weapon-scenes.mjs --weapon rocket --state held --width 390 --height 844 --out-dir <dir>
node tools/havoc-reload-test.mjs
```

`tools/havoc-reload-test.mjs` (in `weapons:reload:test`) checks ammo sync,
the reload choreography and cues, cancel and swap recovery, the portrait
frustum fit of the round over the reload, `WeaponState` integration and the
remote avatar reload.
