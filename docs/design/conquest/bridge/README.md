# Iron Bridge collapse HUD

Feature: the Iron Bridge at Frontier flag C can be blown down (docs/conquest.md "Iron Bridge collapse"). The HUD has to say when the bridge is damaged, when it is about to fall (get off it) and that it is gone (vehicles take the fords).

- `before/`: the HUD before this change (`capturing` and `big-map` fixtures, desktop).
- `bridge-a/b/c-reference.jpg` + `.prompt.txt`: gpt-image-2 alternatives.
  - **A (chosen)**: the existing objective banner in an amber hazard tone, "IRON BRIDGE COLLAPSING · GET OFF THE SPAN · 3 S" with a draining countdown bar, hazard stripes over the bridge on the minimap, a warning badge on the C chip.
  - B (its map part taken over for the `down` stage): the full map shows the gap with break marks either side of C and "IRON BRIDGE · DOWN" in red; its persistent status card in the top right was dropped (the corner holds the ammo and vehicle cards on phones, and the banner plus the map already say it). The FORD tags were dropped too: the fords are not drawn as their own markers today.
  - C: a world-space structure marker with a segmented integrity bar over the span (sits on top of the C flag marker, and the integrity is only coarse on the wire).
- `captures/`: the implementation (`node tools/conquest-hud-capture.mjs --only bridge-failing,bridge-down --out docs/design/conquest/bridge/captures`), desktop, portrait and landscape, no overlaps.

Compared with A: same banner placement, tone and countdown bar (the bar drains with the authoritative `fallAt` from the `bridge` event; the seconds in the detail count down with it). The minimap span is about 6 px wide at its 170 m range and the C diamond covers it, so the hazard also shows as two jagged break marks on the road either side of the diamond (amber and pulsing while the span fails, white once it is down) and a badge at the diamond's lower right; the world-space stripes and the water patch stay under the markers for the larger deploy and full maps. The badge on the top-bar chip is a zero-width sibling of the chip (the rotated chip clips its children), amber while damaged or collapsing and red once the bridge is down.
