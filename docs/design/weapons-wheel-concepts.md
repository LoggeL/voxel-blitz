# Weapons wheel icon normalization

## References

- Current wheel: `weapons-wheel-before.png`
- ImageGen comparison: `weapons-wheel-options.png`
- Selected direction: **A**, a quiet rectangular icon window with one shared size and a restrained active border. It keeps the existing radial layout and leaves the game values and selection behavior in the live UI.

The concept capture had 14 entries. A parallel GL-3 SKIPJACK change appeared during implementation, so the live wheel now has 15 slots. The icon sizing is per weapon and does not depend on the slot count. The new `mgl.png` HUD icon is still absent from that parallel change.

## ImageGen prompt

```text
Use case: ui-mockup
Asset type: a game HUD design exploration board based on the provided Voxel Blitz weapon wheel screenshot.
Input image 1: reference screenshot of the existing first-person voxel shooter and its centered 14-slot weapon wheel. Preserve the game's dark industrial palette, compact radial layout, and orange highlight.
Primary request: create one clean concept board with three clearly separated design alternatives, labeled only A, B, and C, for normalizing weapon icon presentation in this same wheel. The alternatives should differ only in how the icon area is standardized:
A: every gun is fitted to the same consistent rectangular image window, equal apparent scale and padding.
B: each weapon is centered in the same dark circular medallion, equal visible size, with a restrained orange rim on the selected icon.
C: each weapon sits on the same compact dark rectangular tile, consistent silhouette scale, with a thin orange selected edge.
Composition: show the same centered 14-slot radial wheel in each panel against a subdued blurred/dimmed match background. Use the same 14 varied fictional voxel weapon silhouettes and consistent ring spacing in every alternative. Include enough familiar ammunition/name text to show hierarchy, but do not change the underlying game, number of weapons, position, or meaning of values. Make the three panels large and legible, side-by-side in a landscape board, with even margins.
Style/medium: polished, realistic browser-game UI mockup, crisp CSS-like edges, grounded in the existing screenshot, not a marketing image.
Color palette: charcoal and deep navy surfaces, muted steel weapon artwork, warm amber-orange active state, restrained white text.
Constraints: preserve the 14-slot radial wheel, keep all slot icon sizes visually normalized, preserve existing game identity and focus on icon consistency. No extra panels, no new weapons or controls, no decorative title, no brand logos, no watermark.
```
