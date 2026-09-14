# Sniper redesign reference

User request: "design it with imagegen and then rebuild it after the sample"

Generated with the built-in ImageGen tool. Selected concept A in `concepts.png`.

## Prompt

Use case: stylized-concept. Asset type: 3D game weapon concept selection sheet for Voxel Blitz. Create one landscape sheet with THREE alternative fictional bolt-action sniper rifles in clean side profile, each facing right, stacked vertically and labeled A, B, C. The attached images are reference only: first shows the flawed old rifle proportions; second shows actual voxel game materials and hands. Redesign rather than copy the awkward old assembly. Style: deliberately low-poly, bold chamfered blocky forms, readable game prop, plausible connected external construction, restrained detail. Use charcoal gunmetal, muted petrol-teal panels, warm ivory inserts and small safety-orange accents already in the game. Clean mostly solid materials with very subtle wear, never uniform noisy scratches. Every option must have a continuous long fore-end extending far enough to be held by the forward hand, a solid integrated receiver, pistol grip, short box magazine, connected adjustable stock with cheek pad, long exposed barrel and large but compact scope on two short connected mounts. Different silhouettes: A an angular sporting precision chassis with open triangular stock; B a heavier slab-sided expedition rifle with enclosed stock; C a sleek futuristic precision chassis with sculpted shoulder stock. Keep barrel and scope obviously separate parallel axes, scope around one third of rifle length, realistic-looking external hollow scope openings. No bipod, no sling, no floating pieces, no real manufacturer marks, no human, no weapon internals, no dimensions or build instructions. Neutral soft grey studio background, evenly lit, crisp flat facets, all three rifles fully visible with generous separation. Small labels only A, B, C.

## Implementation direction

Match A's open triangular shoulder stock, teal cheek pad, graphite receiver, long teal fore-end with recessed slots, ivory scope rings, short magazine with orange floorplate, and faceted exposed barrel. Preserve the game's existing muzzle, grip, support, sight height and animation owners. Adapt the scope and receiver proportions to those game-space anchors. Build hollow scope walls and place the support surface at the actual support anchor.
