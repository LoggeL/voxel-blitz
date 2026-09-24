# GL-3 SKIPJACK, revision 12

The model follows the large side view in
`concepts/revision11/rounded-direction-b.png`. `reference-geometry.py` records
the sampled image contours and their conversion to authoring coordinates.
The receiver, long stock with a narrow neck, single forward grip, flank
cassette and compact optic use those contours and proportions. The rear and
opposite side are completed as a coherent 3D object; the generated reference
does not specify every hidden surface.

`skipjack-hero.png` and `skipjack-side.png` are renders of the actual Blender
model. `reference-comparison.html` puts the selected reference next to the
model. No generated concept image is used as a model proof.

## Geometry and materials

The receiver has continuous shading across its rounded shoulder. The stock
has recessed thumb pockets and a curved rubber pad. The barrel jacket has
four rounded ventilation openings cut through its wall. The short reflex
hood has a real aperture, tapered side housings and orange adjustment dials.
The cassette is a continuous frame with retaining collars and flat capped
rounds. Small recessed screw sockets and grip inserts follow the reference.

The olive and graphite surface maps are retained, with finer texture scale
and reduced bump strength. Their source PNGs and prompts are in `textures/`.
The browser, portable GLB and editable Blender file share the material maps.

## Game integration

The grip and support anchors now match the single forward grip and support
position below the barrel. The optic is at authoring Z 0.216 m, with the ADS
offset and runtime sight height using the same value. The new cassette hinge
is used by both the runtime and the Blender reload proofs. Hip and ADS
placement put the longer stock below the first-person view.

One round is enclosed in the chamber. The authoritative magazine count is
the total in the weapon; only its reserve is shown outside:

| Total rounds | Visible reserve rounds |
| ---: | ---: |
| 4, with upgrade | 3 |
| 3, standard full load | 2 |
| 2 | 1 |
| 1 or 0 | 0 |

Slots empty from top to bottom. Firing does not translate an exterior round
toward the barrel. The three-round cassette and charging handle keep their
separate reload motion.

## Optimization and verification

The first detailed pass evaluated to 36,592 triangles. The delivered model
has 25,232 triangles, 20 runtime draws, 9 materials and 7 textured materials.
The reduction is approximately 31 percent, mainly from small bevels, hidden
surfaces and contour sampling. The model is below the hard 26,000 triangle
budget. The advisory 20,000 triangle target remains exceeded and is recorded
in `validation.json`.

The Blender build gates and fresh imports of the GLB and glTF passed.
`npm run weapons:blender:browser` passed the 540-pose integration sweep and
material checks. Its SKIPJACK checks compare the exported hand anchors to
the runtime hands, compare the optic height to ADS, raycast through the
actual exported sight opening and verify ammunition visibility.
`npm run weapons:reload:test` passed the state, network, animation and
presentation checks. `node tools/skipjack-browser-test.mjs` captured held,
firing, ADS and reload states plus the mobile held view in `review/browser/`.
