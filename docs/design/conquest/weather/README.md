# Conquest dynamic weather

Feature: weather changes during a Conquest match (clear, overcast, fog, storm with rain and lightning) and changes play: spotting range, lock range, bot sight and canopy drift. Rules in [docs/conquest.md, *Weather*](../../../conquest.md#weather).

- `before/`: the Conquest HUD before this change (capturing fixture; desktop, portrait).
- `weather-a/b/c-reference.jpg` + `.prompt.txt`: gpt-image-2 alternatives (text prompts only, generated from a description of the current HUD).
  - **A (chosen)**: a slim tab hung under the ticket bar: glyph, `STORM`, `SPOT 210 M  LOCK 240 M` in amber when shortened, `CLEARING 2:10` in grey.
  - B: a forecast card top right with an intensity bar and `SPOT -30%` / `LOCK -25%` pills (percentages make the player do the maths, and the card competes with the kill feed corner).
  - C: a glyph and state name beside the clock plus a `STORM FRONT` banner on each change (no ranges; the banner fights the flag banners for the same slot).
- `captures/`: the implementation (`node tools/conquest-hud-capture.mjs --only weather-storm,weather-fog --out docs/design/conquest/weather/captures`, muted CDP). `weather-storm` holds a storm with B just captured, so the flag banner shows where it drops below the tab; `weather-fog` is fog lifting into clear weather as an Engineer.
- `captures/world/`: the world look per state (`node tools/render-map-scenes.mjs --map frontier --shot vista --weather <state> [--flash]`; `bridge` for the wet road and river in a storm). The capture page runs the live `ConquestWeatherView` pinned at the state.

Compared with A: same place, same order and the same colour split (white state, amber shortened ranges, grey forecast). The ranges are the server's numbers for the viewer (`CONQUEST_RULES.spotRange`/`spotRangeRecon` and `LOCK_RULES.stinger`, or the jet's AA missile while flying the jet, × the multipliers of the snapshot tuple), so a Recon reads a different SPOT than an Assault. During a transition the forecast reads `→ CLEAR 0:31` (the state it turns into) instead of A's single verb. A lightning strike flashes the tab with the sky. On phones there is no room under the bar (the HP and ammo cards sit there), so the tab collapses into a glyph and the state name beside the clock, as in C. Flag banners move down 28 px while the tab shows.

The generated storm frames are darker and wetter than the voxel world can be without a new tone curve; the storm preset (`map-atmosphere.js`) was darkened toward them (exposure 0.9, slate sky), and rain streaks were thinned after the first render read as white dashes.

After the Conquest wave integration (squad orders, ribbons, mortar and the restyled cards), the captures were redone on the integrated HUD. On desktop the ribbon toast and the view strip under a banner also step down 28 px while the tab shows, the tab yields to the 1.6 s view strip (the periscope heading tape sits right under that slot) and hides under the scoreboard; on phones the banners keep their own touch positions. The portrait `banner × touch:comms` overlap in `capture-report.json` is the known COMMS button layout issue, not the weather tab's.
