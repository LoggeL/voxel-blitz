# Sluice weir HUD

Feature: turning the Frontier sluice weir's wheel floods both fords for two minutes (docs/conquest.md "Sluice weir"). The HUD has to say that the gates are opening (clear the fords), that the fords are flooded (vehicles take the bridges) and for how long, and where the water stands.

- `weir-a/b/c-reference.jpg` + `.prompt.txt`: gpt-image-2 alternatives made from the current HUD.
  - **A (chosen)**: the framework's objective banner in red, "SLUICE WEIR · FORDS FLOODED", detail "VEHICLES CROSS AT THE BRIDGES" with a draining countdown, blue hatched flood patches over both fords on the minimap, and the hexagon event badge at the weir.
  - B: a persistent driver chip ("FORD FLOODED · REROUTE") on the vehicle card. Dropped: it needs a per-driver wire field, and the banner plus the map already say it.
  - C: FORD tags next to the flood patches on the full map. Dropped for now: the fords are not drawn as markers of their own, and the patches read without them.
- `captures/`: the implementation (`node tools/conquest-hud-capture.mjs --only weir-flooded,weir-flooded-map --out docs/design/conquest/events/weir/captures`, muted CDP), desktop, portrait and landscape, no overlaps.

Compared with A: same banner placement, tone and countdown (it drains with the authoritative `endsAt` of the `map_event` event, or the `ev` row's time left for a joiner). The countdown label reads RECEDES IN, followed by the bearing to the weir. The flood patches cover each ford's flooded rows (taper included) on the minimap and the full map. Their strength follows the server's flood gauge, so they fill while the surge rises and fade as it recedes, with a hatch that drifts downstream. The wheel marker uses its own sluice wheel glyph (`event-weir`); the event badge keeps the framework's flood glyph. The overview image under the maps predates the weir, which is too small to read at that scale anyway.
