# AT-12 ARCHER

The launcher uses a hollow octagonal tube, short tan armor saddles, an open ring sight and a compact cheek seeker. The full missile has a pale body, pointed nose, amber collar and folded fins.

The upper receiver opens on its right hinge. The support hand presents the missile broadside, aligns it above the trough, lowers it and pushes it forward before closing the lid. The magazine group no longer swaps a battery. A generic receiver glow cap is excluded so it cannot float inside the open trough.

## ImageGen references and materials

- Selected design: [concept-a.png](concept-a.png). Exact design prompts and the failed alternative generation are recorded in [prompts.md](prompts.md).
- Olive painted metal: [original PNG](textures/olive-painted-metal.png), runtime `public/assets/blender/textures/archer-olive.jpg`.
- Tan composite armor: [original PNG](textures/tan-composite.png), runtime `public/assets/blender/textures/archer-tan.jpg`.
- [Exact texture prompts](textures/prompts.md). All three delivered images were generated with the built-in ImageGen tool.

Runtime materials use 1024 × 1024 sRGB JPEGs with subtle bump detail. Octagonal shells have circumferential UVs with complete wraps and a shared longitudinal origin across the hinged seam. Decoded maps are shared for the page lifetime; each model owns its mutable materials. Headless builds retain the same geometry and readable flat colors when no images are available.

The HUD icon is rendered from the textured model with `--write-icon`, rather than retaining the previous slab silhouette.

## State and timing

Capacity, damage, lock behavior, projectile rules, muzzle and ADS axis remain sourced from the existing weapon definitions. The three-second reload keeps its 18%, 84% and 92% mechanical cues. The traveling missile is a presentation prop; seating it never grants ammunition. Loaded visibility follows WeaponState and server ammunition, including rejection, cancellation, death and weapon swaps.

Remote avatars use the same moving parts and reload action, and their support hand follows the missile. Remote snapshots supply a reload flag without elapsed time to this renderer, so remote choreography begins at the first observed reload edge. A delayed flag cannot loop the completed animation or grant ammunition.

Portrait framing pulls the hip/reload pose back sufficiently to keep the complete missile and loading trough visible. The adjustment blends away in ADS and leaves the model's gameplay muzzle anchor unchanged.

## Verification

The [before captures](before/) show the previous model. [Final captures](after/) contain 30 frames at desktop 1920 × 1080, landscape 844 × 390 and portrait 390 × 844, plus a studio view. These render the production ViewmodelRig with deterministic state fixtures over a map still; they are visual tests, not a recorded network match.

The capture script settles the equip/ADS pose before beginning the reload, then samples the requested phase. The original capture order allowed the complete reload to elapse before taking its picture.

```sh
node tools/archer-design-capture.mjs --write-icon
npm run weapons:reload:test
node tools/archer-texture-test.mjs
node tools/titanfall-at-weapons-test.mjs
node tools/titanfall-weapon-display-test.mjs
node tools/titanfall-weapon-feel-test.mjs
node tools/weapon-aim-test.mjs
node tools/weapon-swap-test.mjs
node tools/avatar-motion-test.mjs
node tools/avatar-pose-test.mjs
node tools/client-refactor-test.mjs
```

The Archer reload tests include dense/sparse cue timing, elapsed reload recovery, corrected ammunition, real WeaponState death/rejection/switch flows and portrait missile-frustum checks. The avatar test covers authoritative counts, delayed flags and lifecycle cleanup. The texture browser test verifies 13 mapped meshes, UVs, decoded images, material isolation and map lifetime across disposed rigs.

Changes are local to this checkout. No publication or deployment was performed.
