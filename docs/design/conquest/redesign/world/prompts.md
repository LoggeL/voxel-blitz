# Conquest v2 world rendering: design references and prompts

Work package WP5 of the Conquest "Frontier" redesign (spec §2 F8, §4.6). This page covers how the Frontier v2 valley is rendered: light, atmosphere and weather, the far terrain and horizon, ambience, the 3D flags and the capture shots.

## References used

### Generated references (2026-10-07)

The four references in this folder were generated with gpt-image-2 through the Codex image endpoint on 2026-10-07. Each prompt sits next to its image as `*.prompt.txt`:

| Reference | Prompt | What it fixes |
|---|---|---|
| `vista-reference.jpg` | `vista.prompt.txt` (Prompt A) | The chosen mood: crisp, saturated golden-hour light, a readable mid-distance, tall layered mountains, dark smoke columns and a dark, reflective river |
| `weather-moods-reference.jpg` | `weather-moods.prompt.txt` (Prompt B) | Golden hour, valley mist and overcast as three distinct moods over the same valley |
| `flag-closeup-reference.jpg` | `flag-closeup.prompt.txt` (Prompt C) | The capture point: team-coloured beam, dashed ring at the capture radius and a floating letter |
| `horizon-study-reference.jpg` | `horizon-study.prompt.txt` (Prompt D) | Detail falloff, haze only toward the horizon, and smoke readable at 300–600 m |

Before this pass, the live captures (`../captures/world/`) showed a heavy peach haze that washed out everything beyond 150 m, a flat peach sky with a few blocky beige cloud slabs, low grey stair-stepped horizon slabs, a flat pastel-blue river, Minecraft-green grass and faint, thin smoke.

### Changes made to match them

All changes are scoped to Frontier. Other maps keep their look: every new sky, water and backdrop knob defaults to off, and the new atlas tile is used only through Frontier's surface remap.

- **Haze.** Golden hour halves the ground fog (`fogScale` 0.65 → 0.36), so 150–400 m keeps its contrast and colour and the haze builds only toward the horizon. The airborne fog is unchanged (it still veils the far LOD from aircraft). The post grade is warmer and more saturated (saturation 1.10, contrast 1.06), and shadows lean cool.
- **Sky** (`sky.js`, uniform-only, off for every other map).
  - The gradient has three stops: an orange-gold horizon (`#f7b062`), a pale gold middle (`skyMid`) and a soft blue-violet zenith. A straight orange-to-blue mix passes through dusty pink, which is why the sky read salmon before.
  - `sunGlow` adds a wide warm band that burns brightest under the sun's azimuth.
  - `cloudLayer` paints a few large, coherent cloud banks that gather toward the horizon and leave the zenith mostly clear.
    - The view direction is snapped to a 0.4° grid, so the clouds keep the voxel look.
    - Thin edges and the side facing the sun glow warm; thick cores keep a dusty shade.
  - The blocky voxel cloud puffs are off on Frontier.
- **Mountains** (`map-backdrop.js` `ranges` + `FRONTIER_SCENERY.backdrop`).
  - Three ranges are stacked in depth beyond the map edge:
    - forested foothills, 40–190 m out: dark green, unhazed;
    - mid ridges, 150–320 m out: warm brown-violet, light baked haze;
    - tall far peaks, 280–470 m out: snow caps, the most blue-violet haze.
  - A one-sided slope limit (`slope`) turns each peak into a stepped pyramid with a sunlit flank and a shaded flank, with valleys between the peaks. The back of the ring may fall away sheer, since it is never seen.
  - Faces are shaded with a warm sun and a cool sky fill (`light`). A curved height cap (`risePow`, `maxRise` 0.85) keeps the ring low near the map edge.
  - The geometry stays under the 260 k-vertex budget.
- **River.** Through `palette.water` (`applyWaterPalette`), the water uses a dark slate-teal body (`#2f4a55` / `#132a33`), a weaker pixel-art tile and a stronger sun glint. It mirrors the orange-violet sky at grazing angles.
- **Palette.** These are atlas changes; the blocks are Frontier-only.
  - MEADOW is now olive, with green only in the clover hollows.
  - DRY_GRASS is golden ochre.
  - Generic LEAVES (hedges, shrubs, oak and birch crowns) are remapped on Frontier to a new olive `FRONTIER_LEAVES` tile.
  - The far terrain and the distant voxel shell apply the same map remap, so the LODs match the chunks.
- **Smoke** (`conquest-ambience.js`). Chimney and wreck columns are about 2.5× wider and darker (wreck puffs grow from 4 m to 19 m), so they read as dark columns at 300–600 m. Emitters still come from map metadata: all 4 chimney landmarks and all 8 wreck dressing rows. The worst-case load is 390 live particles, within the 480 budget.
- **Mist and overcast.** Each mood has its own sky, haze, cloud cover, water and mountain light. The mountain ring takes more of the scene fog in these moods (`backdropAirFog`, `backdropBaseHaze`), so it melts into the valley haze. In mist, the haze also reaches higher up the mountains (`backdropHazeHeight`), which softens the hard top edge of the valley mist. Overcast's ground fog is thinner (0.75), so the valley still reads under the grey deck, as in the reference.

### What intentionally differs

- **Sun position.** All four generated images put the sun in frame when looking east. Prompt A asks for the sun behind the camera, and the gameplay lighting needs it high enough: at 24–29° elevation the sun shines into the bunker and church interiors, which fails `tools/frontier-light-test.mjs`. The sun therefore stays at about 35° from the west-south-west, and the eastward capture shots are front-lit (warm and saturated). The disc and glow show when looking west, from the EAST HQ, and slightly upward.
- **Mountain shapes.** Mountains stay voxel steps (14 m cells, 4 m rises) rather than the painterly ridges in the images.
- **Mist.** It is a fog density plus the low mist particle sheet, not volumetric mist.
- **Flags.** The beam, dashed ring and letter marker already match `flag-closeup-reference.jpg` in structure and team colours, so they are unchanged. The beam stays deliberately slim.

### Earlier references (WP5)

Before the generated set existed, the world look was designed from these existing references:

| Reference | What we took from it |
|---|---|
| `docs/design/conquest/map-alternatives.png`, "Iron Valley" (left) | The chosen mood: a lived-in valley seen from a raised base. It has warm low sun, ochre and olive ground, dark green tree clumps, grey rock benches, roads cut into the relief and mountains closing every horizon. |
| `docs/design/conquest/frontier-fleet-hero.png` | The warm three-quarter light on hulls and the sky gradient |
| `docs/design/conquest/hud-alternatives.png` Option 2 | Team colours for the world objects: own blue `#4cc3ff`, enemy orange `#ff8a3d`, neutral `#d8d8d8` |

## Chosen direction and how it maps to the code

- **Golden hour (default weather).** The sun comes from the west-south-west at about 35° (`sunDir [-62, 52, 38]`), with a warm sun `#ffc888` and a cool sky fill `#a3b3d8`. The sky runs from an orange-gold horizon through pale gold to a blue-violet zenith, with lit cloud banks, and the ground haze is thin (`#dcb88e`).
  - The coarse voxel light volume gives real shadows. Lee slopes and interiors go dark: in the frontier-light-test, the lee flank of the D ridge gets 0.57× the sun of the sunward flank.
  - Code: `map-atmosphere.js` `FRONTIER_PRESETS.golden` and `voxel-light.js`.
- **Mist and overcast.** Two alternative moods, chosen through `mapMeta.conquest.weather` or `?weather=` on captures.
  - They change the fog, sky, cloud cover, sun, grade, water, mountain light and haze, and the air-particle kind (pollen, mist or sparse).
- **Horizon.** Three ranges of stepped voxel peaks 40–470 m beyond the map edge (`map-backdrop.js` `ranges`): forested foothills, mid ridges, and tall snow-capped far peaks. Each range carries more baked haze toward the blue-violet haze colour of the current weather.
- **Far ground.** One 8 m tile mesh sampled from the real voxel surface. It climbs natural ground only, so towers and trees never make tents. It uses the painter colours of the surface block (with the map remap) and shades slopes toward rock grey.
  - Above it sits one 2 m voxel shell for structures, trees and terrain steps. Ground under the shell floor is buried and never drawn.
- **Ambience.**
  - Plumes from the Kessler Works chimneys lean downwind (the same wind as the flag cloths).
  - The wreck props carry broad black smoke columns with embers.
  - Off-map artillery flashes land just beyond the east and west edges, and sometimes the north and south.
  - All of it goes through WP6's shared `ParticleField`, and the sources are read from map metadata.
- **Objectives.** Battlefield-style flags:
  - a mast whose cloth is hoisted by the authoritative control;
  - an owner-colour beam (HDR, fog-reduced) that pulses while contested;
  - a dashed ring at the capture radius on the ground;
  - a letter marker that draws over terrain beyond 60 m.

## Prompts

These prompts produced the generated references above. The exact text that was sent is in the `*.prompt.txt` files.

### Prompt A: vista (chosen mood)

Use case: stylized-concept. Asset type: environment key art for a browser voxel shooter.

Primary request:
- The view: from the edge of a raised military plateau (runway and hangar just out of frame on the left), looking east down into a wide river valley at golden hour.
- Built from 1 m voxels with crisp ambient occlusion and flat-shaded faces.
- In view:
  - a steel truss bridge with two arches over a slow river in the centre;
  - a village on a hill to the right with white plaster houses, terracotta stepped roofs and a church spire;
  - an industrial works far right with a smelter hall, a cooling tower and two tall brick chimneys trailing grey smoke that leans north-east;
  - a ridge on the left with bunkers, trenches and a radar dome;
  - dark pine forests, wheat strips and dry grass meadows;
  - three burnt-out tank and truck wrecks along the river, each with a black smoke column.
- Ridged mountains ring the horizon in warm haze. The low sun comes from behind the camera's left shoulder. The shadow sides of the ridge are clearly darker, with long shadows.
- No text, no UI.

### Prompt B: weather moods

The same vista three times, side by side:
- golden hour (warm, long shadows);
- valley mist (low white mist lying in the river valley, a soft sun, denser haze, ridges fading into the mist);
- overcast (a flat grey cloud deck, no sun disc, cool even light, muted colours).

Same composition and voxel style as prompt A.

### Prompt C: objective flag close-up

Use case: game prop design. A Conquest capture point on a gravel square at a ruined bridgehead:
- a slim grey steel mast on a concrete plinth;
- a team flag half-hoisted, cloth rippling;
- a tall translucent light beam rising from the mast, in sky blue (own team) or orange (enemy);
- a dashed ring of light on the ground marking a 24 m capture radius;
- a large letter "C" marker floating above the mast.

Show three states left to right: neutral (grey cloth low), being captured by blue (cloth halfway, blue beam pulsing), and owned by orange (cloth at the top, orange beam). Voxel environment, golden-hour light.

### Prompt D: horizon and far terrain study

An aerial view from 70 m over the west HQ looking across the whole 768 m valley to the east. It shows how detail falls off:
- crisp voxels near the camera;
- simplified 2 m blocks in the middle distance;
- smooth tinted terrain far away;
- a ring of hazy voxel mountains beyond the map edge, with artillery flashes glowing just beyond the far ridge;
- chimney smoke and wreck smoke columns readable at 600 m.

## Capture verification

The live look is checked with muted CDP captures of the new shots (`shared/map-capture-shots.js`): vista, farm, village-street, bridge, trenches, works, tank-forest, heli-river, jet-sky, wreck-column and overview.

The commands and the comparison plan are in `.conquest-work/reports/WP5-impl.md` and the WP5 structured report. Finals go to `docs/design/conquest/redesign/captures/world/`.

## Content pass to match the generated references (2026-10-07)

The world references in this folder (`vista-reference.jpg`, `horizon-study-reference.jpg`, `weather-moods-reference.jpg`, `flag-closeup-reference.jpg`, prompts in the `*.prompt.txt` next to them) were generated with gpt-image-2 through the Codex image endpoint on 2026-10-07. Against them the Frontier valley read as empty ("die Welt sieht langweilig aus"). This pass changed the generated content only (shared world generator, no client rendering, rules or server code). The layout facts are in [docs/maps/frontier.md](../../../../maps/frontier.md).

| Reference shows | Content change |
|---|---|
| Dark pine forests on the slopes and along the banks | `frontierWoodDensity()` drives 1976 trees (was 1103): 17 point-mirrored woods (valley rim, Kestrel upland, copses between the roads) plus clumpy tree lines along both banks, bushes on the wood edges. Pines are stacked square tiers like the reference's voxel pines. Roads, flags (82 m), crossings, fields, runway approaches and HQ landmark sight lines stay clear. |
| Golden wheat strips, dry meadows | Four more wheat strips either side of the paved axis (18 fields). |
| A wide, meandering river with sandbars, islands and reeds | 24–30 m open reaches with `sin²` meanders between the crossings, six gravel islands with grassy crowns, gravel and sand beaches on the inside of each bend, reed tufts, natural mud/clay/meadow banks. The 3 bridges and 2 fords keep the 12 m channel and remain the only vehicle crossings. |
| A dense hill village with a spire | 16 closed plaster houses on stone plinths up the west rise and down the south slope behind the square, stepped cobble lanes, walled garden plots, cypresses, a white-plastered bell tower under the terracotta spire. The east and north approaches stay open for attackers. |
| Burnt-out wrecks along the river, rubble, ruins, hedgehogs, sandbags | 8 burning wrecks (3 new at ford-north, ford-south, bridge-south, all published as `conquest.dressing` smoke anchors), 8 cold hulks, 8 ruined cottages, czech hedgehogs and sandbag lines at the north crossings and their mirrors, 22 shell scars. |
| Industrial works with a cooling tower and several tall chimneys | Two boiler stacks (y70, y66) on a boiler house east of the smelter hall, published as `chimney` landmarks so the ambience smokes all four stacks; sleeper stacks along the rail lane. |

What was tried and backed out:

- A ragged falloff around the flag pads, to break the concentric "Minecraft terraces": it moved site foundations (the smelter hall floor rose and its entrance stair trapped bots) and the radar dome. The terraces remain a known gap; the woods now cover much of the relief.
- Dug craters on the approaches and closed houses on B's east slope: both cut the flag turnover in `conquest-action-test` by half. The craters are scorch scars now and the east slope is open.
- Round tree crowns and denser woods: over the distant-shell quad budget (170 000). That budget is what limits the woodland.

Captures after the look and content passes: `docs/design/conquest/redesign/captures/world/` (regenerated with `node tools/conquest-capture.mjs --only world`). The before state is the same folder at commit `f4bbd23`.
