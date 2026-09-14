orchestrate

Build one new original 3D weapon model for Voxel Blitz using DeepSeek V4.1 Flash.
Use OMP's orchestrate workflow. Keep the orchestrator and every delegated agent
on opencode-go/deepseek-v4.1-flash; do not substitute another model. This is a
concrete authoring task: execute the Blender build, export and render it.

You own ONLY these new directories:
- tools/blender/omp-weapon/
- docs/design/blender/omp-weapon/ (preserve this build-request.md)
- public/assets/blender/omp-weapon/

You are not alone in this checkout. There is substantial existing uncommitted
RIVET/KESTREL work. Do not revert it, overwrite it, change runtime factories,
change shared gameplay rules, commit, push, install software, or modify global
configuration. Adapt your work to the existing code. Other paths are read-only.
Do not inspect or print credentials, authentication stores or secrets.

Create a distinctive compact science-fiction rifle. Choose a fitting original
name. It should have a deliberate silhouette, modeled contours/chamfers, a
convincing grip and stock, visible magazine separation, restrained mechanical
surface detail and an unobstructed sight window. It must be your own geometry,
not a renamed/recolored KESTREL or a stock downloaded model. This is a visual
game prop; no functioning weapon mechanism or manufacturing specification.

The user explicitly requested realistic ImageGen textures. Reuse the six actual
ImageGen textures already in docs/design/blender/textures/ or their compact
1024px JPEG copies in public/assets/blender/textures/. Apply them with usable
UVs and metal/roughness settings. Keep original source images intact. Do not
substitute a generated picture of a weapon for real 3D geometry. Pack textures
into the editable .blend and exported GLB. No additional image API spending.

Read these references before working:
- docs/design/blender/README.md
- tools/blender/kestrel/build-kestrel.py and export-game-assets.py (technique only)
- public/js/guns/defs.js, shared/avatar-hands.js
- public/js/guns/models/common.js, public/js/guns/attachment-model.js

Prefer compatibility with the existing rifle visual coordinate contract:
Three.js +Y up, forward/barrel -Z; muzzle at [-0.012,0.045,-0.598], dominant
palm at [0.045,0.015,-0.09], support at [-0.055,0.005,-0.40], sight height 0.145.
Model the geometry around the actual anchors rather than just placing empties.
Do not change weapon stats or HANDS/TIMERS. If a fitting cannot be achieved,
document the mismatch honestly. Separate animation owners as nodes named body,
mag, bolt, trigger and factory-optic. Include distinct named muzzle, grip,
support and sight markers. A root group may contain these. Avoid negative scales,
nonfinite coordinates, inward-facing surfaces, excessive draw calls, and tiny
details that add no readable value. Target roughly 8k-20k triangles and <=24
material draw batches for the weapon. Editable source parts may be separate.

Blender 5.2.1 LTS is installed at /Applications/Blender.app and the blender CLI
is on PATH. You can execute a script with blender --background --python ...
without touching the open GUI scene. Blender MCP is also installed; if useful,
tools/blender/mcp-client.py runs with the Python environment at
/Users/logge/Library/Application Support/VoxelBlitz/blender-mcp/.venv/bin/python.
Read the helper before calling it. Do not reset or overwrite the open study.
GPU renders may compile slowly; modest CPU Cycles or EEVEE renders are fine.

Required outputs:
1. Reproducible authoring script(s) under your tools directory.
2. docs/design/blender/omp-weapon/weapon.blend, editable and self-contained.
3. public/assets/blender/omp-weapon/weapon.glb, usable browser delivery export.
4. At least hero, side and ADS/sight review renders under your docs directory.
   They must be rendered from the actual model. Inspect the renders yourself.
5. build-report.md with chosen name, design intent, exact build/export/render
   commands, mesh/material/texture/triangle counts, axes, anchors, file sizes,
   checks actually executed and remaining limitations. Clearly separate tested
   results from assumptions. Write a small machine-readable manifest.json too.

Export only the weapon and its markers, not cameras/lights/floor. Reimport the
GLB in a fresh scene and check material textures, bounds, UVs and part names.
Finish the build, then report the output paths. The parent will independently
review the model and decide how it should be used in the game.
