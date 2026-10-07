# Conquest v2 world rendering: design references and prompts

Work package WP5 of the Conquest "Frontier" redesign (spec §2 F8, §4.6). This page covers how the Frontier v2 valley is rendered: light, atmosphere and weather, the far terrain and horizon, ambience, the 3D flags and the capture shots.

## References used

No ImageGen tool was available in the WP5 sessions (2026-10-07). Following spec §0.8, the world look was designed from these existing references instead of new generated alternatives:

| Reference | What we took from it |
|---|---|
| `docs/design/conquest/map-alternatives.png`, "Iron Valley" (left) | The chosen mood: a lived-in valley seen from a raised base. It has warm low sun, ochre and olive ground, dark green tree clumps, grey rock benches, roads cut into the relief and mountains closing every horizon. The ground-view inset fixes the eye height and density for the street-level shots. |
| `docs/design/conquest/map-alternatives.png`, "Coastal Works" (right) | Rejected as a whole (Frontier v2 has a river, not a coast). Its water tone and bridge silhouettes informed the river at C. |
| `docs/design/conquest/frontier-fleet-hero.png` | The warm three-quarter light on hulls, the haze depth behind them and the sky gradient |
| `docs/design/conquest/hud-alternatives.png` Option 2 | Team colours for the world objects: own blue `#4cc3ff`, enemy orange `#ff8a3d`, neutral `#d8d8d8` (flag cloth, beam and ring) |
| Spec §1, first 60 seconds | Chimney smoke at E, wreck smoke columns along the river, mountains on the horizon, warm low-sun light |

The "before" state is the existing captures in `docs/design/conquest/` (the old 1024 Frontier). The scratchpad baselines named in the spec were lost when the machine rebooted.

## Chosen direction and how it maps to the code

- **Golden hour (default weather).** Sun from the west-south-west at about 35° (`sunDir [-62, 52, 38]`), warm sun `#ffd09a`, cool sky fill, a warm horizon glow and haze `#dcc3a0`.
  - The coarse voxel light volume gives real shadows. Lee slopes and interiors go dark: in the frontier-light-test, the lee flank of the D ridge gets 0.57× the sun of the sunward flank.
  - Code: `map-atmosphere.js` `FRONTIER_PRESETS.golden` and `voxel-light.js`.
- **Mist and overcast.** Two alternative moods, chosen through `mapMeta.conquest.weather` or `?weather=` on captures.
  - They change uniforms only: fog colour and density scale, sky colours, overcast deck, sun strength, grade and the air-particle kind (pollen, mist or sparse).
- **Horizon.** A ring of ridged voxel peaks 40–460 m beyond the map edge (`map-backdrop.js`, style `terrain`, shape `peaks`).
  - Grass benches below, rock above 72 m.
  - The peaks melt into the haze colour of the current weather.
- **Far ground.** One 8 m tile mesh sampled from the real voxel surface. It climbs natural ground only, so towers and trees never make tents. It uses the painter colours of the surface block, with slope shade toward rock grey.
  - Above it sits one 2 m voxel shell for structures, trees and terrain steps. Ground under the shell floor is buried and never drawn.
- **Ambience.**
  - Plumes from the two Kessler Works chimneys lean downwind (the same wind as the flag cloths).
  - Five wreck props carry black smoke columns with embers.
  - Off-map artillery flashes land just beyond the east and west edges, and sometimes the north and south.
  - All of it goes through WP6's shared `ParticleField`.
- **Objectives.** Battlefield-style flags:
  - a mast whose cloth is hoisted by the authoritative control;
  - an owner-colour beam (HDR, fog-reduced) that pulses while contested;
  - a dashed ring at the capture radius on the ground;
  - a letter marker that draws over terrain beyond 60 m.

## Prompts for a later ImageGen pass

Keep any images that this pass produces in this folder, next to the prompts.

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
