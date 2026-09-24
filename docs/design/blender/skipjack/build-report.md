# GL-3 SKIPJACK, revision 13

Revision 13 rebuilds the model against the approved side view
`concepts/revision11/rounded-direction-b.png`. All images in this folder are
real Blender or browser renders of the delivered asset. The concept image only
appears as the reference in `reference-comparison.html` and `comparison.png`.

## Starting point (revision 12)

The largest visible gap to the reference was form, not detail. The receiver and
stock were side profiles extruded across X with an edge bevel. From the side
the outline matched, but from above, in the ADS view and in first person both
read as flat-sided slabs with rounded edges. The stock's dark thumb recess was a
shallow displacement with a thin overlay, so it read like a sticker. The
receiver had no dark chin or keel, and the right side carried a flat dark plate.

Presentation and rules had these defects:

* `beginReload` set `mag = 0` for every magazine swap. On SKIPJACK the chambered
  round disappeared too, and the cassette emptied the moment R was pressed,
  while it was still closed on the gun.
* The fresh cassette came back with the old, empty count and filled only at
  the end of the reload.
* Tactical and empty swaps both took 2.8 s, both with a charging stroke.
* The cassette tipped about a lateral rear trunnion, so its front dropped out
  of view instead of opening toward the shooter.
* A generic glowing bolt-face cap (`assemble.js`) sat outside the narrow stock
  and lit up bright green after each shot. The baseline capture shows it too.

## Geometry

`tools/blender/skipjack/reference-geometry.py` authors every volume:

* **Receiver and stock**: one lofted shell. Its side profile (top, bottom) and
  half widths are traced from the reference at 20 knots and resampled with
  smoothing. Cross-sections are super-ellipses, rounder on top
  (n 2.1–2.4) than underneath (n 2.2–2.9). The dark keel (chin below the
  barrel collar, a thin belly strip, the stock underside) is split along a seam
  row whose angle is solved per ring. The colour break therefore follows the
  surface without stair steps. The shell has cylindrical arc-length UVs.
* **Pockets**: exact Boolean differences transfer the dark finish to the pocket
  walls, which are then separated into the keel/pocket part. The pockets are the
  flat cassette bay on the left flank, both stock thumb scoops traced from the
  reference, and the right service cover that seats the charging track. The
  scoop floors run parallel to the curved stock at 13.5 mm depth. They are
  filled by a constrained Delaunay triangulation over an even grid, so the
  smooth-shaded floor has no sliver fans.
* **Barrel**: one closed lathe profile with the rear pole, the rubber nose ring
  and the orange collar band, three rounded rib bands, the stepped muzzle brake
  with crown and lip, the brake chamber and the 40 mm bore with its floor. The
  brake has eight radial capsule vents.
* **Grip and pad**: a lofted, raked grip made from horizontal super-elliptic
  sections, with three finger swells and a heel cap, and the orange trigger blade
  in front of it, as in the reference. The rubber shoulder pad is lofted as a
  rounded rectangle.
* **Cassette**: a true frame ring with rounded inner and outer corners (no
  Boolean cap across the window). Retainer pegs, detent studs, the top slot bar,
  the pull ring and the orange release paddle are separate parts. The cassette
  now hangs on a **vertical hinge hub at its front edge**, at the position of
  the round boss in the reference. Two receiver knuckles on a pin carry it. The
  cassette has no back plate. The bay floor is dark, so the empty top slot reads
  as in the reference and the rounds stay visible when the cassette is open.
* **Details**: two panel seams (the receiver/stock joint, the nose cover), screws
  seated on the local shell normal, and the sight rail with slots. The compact
  reflex hood keeps its open aperture.

Material: the olive tint is now a deeper, greener olive (`ASSET_TINTS` 0.34,
0.44, 0.29), and the round colours are darker. They use the existing palette maps
`skipjack-olive-armor`, `skipjack-dark-steel`, `skipjack-shell`,
`molded-polymer` and `pebbled-rubber`.

## Optimization

The first complete draft exported 22,930 triangles in 22 draws. Screw heads
became two-radius cones without bevel modifiers, the lathe went from 32 to 28
segments with four-point ribs, pocket floors use a coarser even grid, and a few
small rings and slots were simplified. After a check that the silhouette and
pocket rims were unchanged, the delivery has **19,254 triangles, 21 runtime
draws, 9 materials, 7 textured**. That is below the 20,000 target and the
26,000 hard limit (revision 12: 25,232 / 20).

## Runtime and rules

* `public/js/guns/models/skipjack.js`: `CASSETTE_HINGE` = game (-0.142, 0.020,
  -0.306), the vertical hub axis.
* `actions.js` `_updateSkipjackReload`: present the flank, trip the paddle
  (click 1), swing the rear edge out 53° about the hub with a small overshoot,
  lift 5 cm off the pin, carry it away (hidden 0.46–0.56), bring the loaded
  cassette onto the pin and swing it shut (click 2). An empty swap then racks the
  pawl and strips the top fresh round into the chamber (click 3). A tactical swap
  only pats the closed cassette. The left hand follows the paddle, the
  cassette's rear edge and the pawl.
* `viewmodel.js`: `reload()` records the pre-swap reserve, the fresh load and
  whether a round is chambered. Until the cassette leaves the hand the slots show
  the old reserve, then the fresh load. Cancel, weapon swap, death and completion
  clear the plan and show the authoritative reserve again. The cassette pose and
  the pawl reset.
* `shared/reload.js` / `combatmath.js`: `chamber: 1`, `tacTime` 2.3 s, three
  spare cassettes. The balance rationale is in `docs/weapon-design/skipjack.md`.
  Server and client prediction share the rule.

Visible exterior rounds, with one round in the chamber:

| Total rounds | Visible reserve |
| ---: | ---: |
| 4, upgrade | 3 |
| 3, after a tactical swap | 2 |
| 2, after an empty swap | 1 |
| 1 or 0 | 0 |

## Verification

* The Blender build gates pass: anchors, muzzle tip, heat band, sight channel,
  non-empty parts, contact audit, outward surfaces, round contract.
* `validate-skipjack.py` (fresh GLB and glTF import) passed.
* `npm run weapons:blender:browser` passed. The gate now also samples real
  runtime swaps: tactical, empty and upgrade slot sequences, the hinge swing,
  cancel, and a weapon swap in the middle of a reload.
* `npm run weapons:reload:test` passed, including the new
  `tools/skipjack-ammo-test.mjs`.
* `node tools/skipjack-browser-test.mjs` passed and wrote `review/browser/`
  (desktop held/4 rounds/after shot/ADS, the four reload beats, mobile held and
  ADS).

The renders in this folder are `skipjack-hero.png`, `skipjack-side.png`,
`review/final/*.png` (including `front-quarter` and `rear-quarter`) and
`pose-*.png`. The HUD icon `public/assets/weapons/hud/mgl.png` is
rendered from the runtime model on the cassette side (`tools/render-hud-icon.mjs`
sets `side: 'left'` for `mgl` only and mirrors the image, so the muzzle points
right like every other icon). `comparison.png` shows the reference, the revision 12 model and
revision 13 side by side.

## Remaining limits

* The reference is a single generated concept. Hidden surfaces (the right side,
  the underside, the inside of the bay) are designed to fit it; the image does
  not specify them.
* The surface maps are the shared palette textures with a tint. There is no
  baked normal, AO or edge-wear map, so painted edge wear like in the
  reference is not present.
* The reload hand is the shared support glove, moved by position only. It does
  not change its grip shape per beat.
* Balance is covered by deterministic tests (damage, TTK, life total, swap
  times), not by playtests.
