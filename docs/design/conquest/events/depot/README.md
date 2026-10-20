# Hollin Fuel Depot HUD

Feature: the Hollin Fuel Depot (Frontier, east of the e-c road between E, C and the East HQ) goes up in a chain reaction once one of its three tanks is shot open (docs/conquest.md "Hollin Fuel Depot"). The HUD has to say that the chain is running (get out of the 20 m blast), that the depot burns and that its smoke column blocks spotting and locks.

- `depot-a/b/c-reference.png` + `.prompt.txt`: gpt-image-2 alternatives.
  - **A (chosen)**: the framework's objective banner in the amber hazard tone, "HOLLIN FUEL DEPOT · CHAIN REACTION / GET OUT OF THE DEPOT · 2 S · 120 M E" with its countdown bar, the event hexagon as a world marker and a dashed amber blast circle around the hexagon on the minimap.
  - B (taken over for the `active` stage): the same banner in red, "HOLLIN FUEL DEPOT · ABLAZE / BURNING GROUND · SMOKE BLOCKS SPOTTING AND LOCKS", the marker reading "DEPOT · FIRE 42 S", burning discs and a dark smoke disc on the minimap.
  - C: a separate world pin with an integrity bar over every tank. Dropped: three more pins on top of the event marker and the E flag marker clutter the view at range, and the integrity is only coarse on the wire (the `ev` row carries a per-tank percentage; the most damaged tank shows as the progress arc around the event hexagon instead).
- `captures/`: the implementation (`node tools/conquest-hud-capture.mjs --only depot-chain,depot-ablaze --out docs/design/conquest/events/depot/captures`, muted CDP), desktop and portrait; `minimap-ablaze.png` is a 3x crop of the desktop minimap.

Compared with A and B: same banner placement, tones and countdown bar (from the authoritative phase time left). At the minimap's 170 m range the depot is about 13 px across and the event hexagon covers it, so the blast ring, the column disc and the fires keep a minimum screen size there: the ring sits just outside the hexagon, the column is a dark disc behind it and the separate burning discs merge into one flickering orange halo around it; on the full map (larger scale) the per-tank discs and the canopy show on their own.
