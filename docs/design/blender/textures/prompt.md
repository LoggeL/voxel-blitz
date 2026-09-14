# Material atlas

Created with the built-in ImageGen tool on 2026-09-13 (Europe/Berlin).
The original generated bitmap is preserved as `material-atlas.png`.

## Prompt

Use case: photorealistic-natural. Asset type: directly usable 3D game material texture atlas for Blender, a single square 2048x2048 bitmap. Create EXACTLY four equal square material samples in a clean 2 by 2 grid, edge to edge, no gaps or borders. Top left quadrant: pale neutral grey powder-coated metal, fine realistic stipple, scattered thin irregular scuff scratches and a few tiny paint chips showing darker steel, restrained weathering. Top right quadrant: medium neutral grey tightly woven ballistic nylon fabric, visible fine regular warp and weft threads, subtle wear and fibers, completely flat. Bottom left quadrant: medium grey molded rubber with fine stippled grain and rubbed patches. Bottom right quadrant: pale neutral grey coarse woven webbing strap textile, visible fine parallel reinforcing fibers and small realistic irregularities. These are flat surface ALBEDO material scans, orthographic face-on, perfectly even diffuse lighting, no perspective, no directional light, no cast shadows, no specular highlights, no objects, no seams, no borders, no letters, no logos, no labels, no watermarks. Each quadrant is a continuous homogeneous patch with micro surface detail all the way to its own edges. Keep average brightness of all quadrants light-to-medium grey so colored materials can tint them in Blender. Not a rendered sheet or board, only the texture pixels themselves.

## Use

Upper left: coated metal. Upper right: ballistic nylon.
Lower left: rubber. Lower right: webbing.
This first atlas is retained as a reference. The final Blender assets use six
separate, more detailed ImageGen textures from `imagegen-prompts.json`.
Blender adds subtle bump and roughness variation from those images. These are
derived approximations, not measured normal or roughness maps.
