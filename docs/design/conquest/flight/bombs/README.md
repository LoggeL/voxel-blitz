# Jet bombs: CCIP sight

Design references for the jet's STRIKE loadout (2 free-fall bombs), generated
2026-10-16 with gpt-image-2 from the prompts beside them. Each one shows the
existing flight HUD (tapes, aim circle, vehicle card with three weapon rows)
in a 26° dive with bombs selected.

| Variant | Idea | |
| --- | --- | --- |
| `bombs-a-reference.jpg` | classic CCIP: pipper with wings at the impact point, dashed fall line from the gun cross, fall time / slant range above, bombs left below | **chosen** |
| `bombs-b-reference.jpg` | blast-radius ellipse on the ground plus a vertical release-cue bar | |
| `bombs-c-reference.jpg` | corner-bracket dive box on the impact point with a re-arm bar | |

A was chosen: it is the smallest addition to the jet's existing symbology (the
same pipper language as the gun funnel), reads at phone size, and needs no
second instrument. B's ellipse would need a ground-plane projection that
flickers over voxel terrain, and its release cue implies a target the game
does not designate. C hides the impact point inside a large box.

Implementation: `_ccip` in `public/js/ui/conquest/reticles.js`, model
`bombImpactCue` in `public/js/ui/conquest-hud-state.js`. Captures of the
`jet` and `jet-bomb` fixtures (`node tools/conquest-hud-capture.mjs --only
jet-bomb,jet --out docs/design/conquest/flight/bombs/captures`) are in
`captures/` for desktop, phone portrait and phone landscape. Compared with A,
the implementation keeps the tapes' fixed positions and uses the game's
mint/amber palette; the pipper is drawn from the authoritative jet row and the
world raycast, so in the capture it falls just short of flag C. On phones the
exit prompt moves above the aim (portrait) or beside the top bar (landscape)
while the bomb sight is up, because a dive puts the pipper where the prompt
normally sits.
