# TB-4 THUNDERBOLT

The rounded Blender revision follows the [second modelling reference](concept-blender-v2.png), generated with the built-in ImageGen tool from the earlier actual model and [concept A](concept-a.png). Its exact prompt is in [prompt-blender-v2.md](prompt-blender-v2.md). [Concept B](concept-b.png) and the [original prompts](prompts.md) retain the first design comparison.

The runtime now loads geometry authored in the [editable Blender source](../blender/thunderbolt/thunderbolt.blend): a tapered receiver, rounded shoulder pad and grips, a deep four-cell drum, ceramic collars and actual copper windings around the open accelerator rails. Bevels and smooth weighted normals shape the surfaces. A portable [GLB](../blender/thunderbolt/thunderbolt.glb) contains the same geometry and all surface images.

Six UV-mapped images cover ceramic, phosphated steel, machined steel, copper, molded polymer and pebbled rubber. The new ceramic surface was generated with built-in ImageGen, with the [texture prompt](prompt-ceramic-v2.md) recorded alongside the reference. The other five maps use the existing material library. Per-gun materials preserve the source tints and emission; decoded images and geometry remain shared. The export has 39,976 triangles and 24 material/animation batches. A procedural fallback remains for asset-load failure and DOM-free simulation tests. The browser checks require the actual Blender asset.

The [orb refinement](orbs/concept-a.png) uses a small white-cyan nucleus and branched discharges inside dark translucent cobalt fields. The [alternate study](orbs/concept-b.png), [before image](orbs/before.png) and [built-in ImageGen prompts](orbs/prompts.md) preserve the design comparison. The Blender source has five dedicated `tbOrb` spheres and a procedural volume preview; the white equator and meridian meshes are gone. The game applies one animated plasma shader pass to each authored sphere, with separate phases, internal depth attenuation and a restrained field edge. Rail and sight materials remain separate. Reduced motion freezes the idle field while preserving ammo and mechanical animation. Portable glTF/GLB retains the geometry and a dark blue material fallback; its animated field is implemented by the game.

[Build/export instructions and coordinate contract](../blender/thunderbolt/README.md) reproduce the source and game asset. The updated HUD icon is rendered from the same Blender geometry. [Before-Blender captures](captures/before-blender/hero.png) preserve the comparison.

The inner rotor turns 90 degrees in 0.3 seconds per accepted shot. Each successive cell arrives at the same feed station. Orb visibility follows WeaponState ammunition, including server corrections. Reload choreography can move and seat an empty carrier but cannot refill it; ammunition state controls replacement charges. Remote avatars read the existing authoritative magazine snapshot. The discharge uses its own arc geometry instead of a powder muzzle flash.

TB-4 has a dedicated procedural launch report, capacitor reload sounds and mechanism contacts at 0.06, 0.17 and 0.30 seconds. It no longer selects SKIPJACK samples. [Rendered audio measurements](audio-verification.json) show no clipping for TB-4.

## Verification

- `npm run thunderbolt:test`: four-shot consumption, quarter-turn indexing at 30/60/120 fps, corrections, reload interruption/completion, weapon switching, third-person snapshots and death cleanup. Export checks verify actual Blender geometry, UV direction, normals, muzzle and sight clearance, feed alignment, budgets and runtime/portable GLB parity.
- The same command includes `thunderbolt-plasma-test.mjs`: five separately owned shader materials, one clock update per frame, reduced-motion behavior, correction/reload pulse cleanup and per-gun disposal.
- `npm run thunderbolt:browser`: actual decoded maps, curved normals, per-gun material ownership, disposal and Blender orb feed alignment; [material report](../blender/thunderbolt/browser-materials-report.json). Also 27 state captures at 1920x1080, 390x844 and 844x390, plus a [studio view of the actual model](captures/verified/hero.png). Checks ammo against the HUD, mounted display and visible charges; no browser errors. [Report](captures/verified/report.json).
- The browser command also renders the actual plasma spheres to a WebGL target: 6,408 pixels change after 0.41 seconds, reduced motion and rollback preserve exact pixels, and both linear and exponential fog fully conceal the fields. [Shader report](plasma-browser-report.json).
- `node tools/thunderbolt-orb-capture.mjs`: [animated drum close-up](orbs/plasma.gif) from 48 real renderer frames, played forwards and backwards for a continuous documentation loop. [Still frame](orbs/drum.png).
- Three additional [aim-down-sights captures](captures/ads/capture-report.json) passed at the same viewport sizes; the sight line remains open.
- `node tools/titanfall-at-weapons-test.mjs`: 726 checks passed, including unchanged orb gameplay, sight clearance and muzzle alignment.
- `node tools/titanfall-weapon-display-test.mjs`: 225 checks passed.
- `node tools/audio-contract-test.mjs`: 72 checks passed, including a loaded SKIPJACK bank that must not replace TB-4 sounds.
- Reload state, real-server reload protocol, animation and presentation regression tests passed. Avatar pose and lifecycle checks passed.
- Module preload validation and scoped whitespace checks passed.

The portrait frame keeps all four cells and HUD ammo visible. The mounted weapon display remains outside that narrow camera frame, so the HUD ammunition card remains active. Desktop and landscape retain the mounted display.

The full repository suite was not rerun for this Blender revision. Earlier full audio-audit results remain archived in the audio verification report; its four TB-4 checks passed.

This is a local implementation and verification record, not a deployment record.
