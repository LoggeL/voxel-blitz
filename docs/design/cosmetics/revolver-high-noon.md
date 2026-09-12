# High Noon

Original procedural skin for the IRONCLAD .44. The visual direction is a presentation-grade Western revolver: midnight blued steel, aged brass furniture, walnut grip edges and bevelled ivory-colored inserts. No texture download, font, external image or third-party artwork is required.

## Craft details

- An engraved sun on both brass frame faces, framed by fine border lines and curled acanthus ornament.
- Separate, bevelled ivory-colored side inserts preserve the swept grip profile and visible walnut surround. Carved scrolls sit above and below a blue medallion carrying twelve gold sun rays.
- Paired barrel inlays, five small diamonds on each barrel side, narrow brass collars and a thin open muzzle annulus.
- Six gold lozenge inlays and double rim lines on the midnight cylinder. These accents are children of the original cylinder, so they follow both firing index and crane swing during reload.

All detail is geometry. The fine engraving uses instanced low-sided tubes, grouped by material and animated parent. The complete skin adds 10 mesh draws and approximately 11,176 triangles. There is no per-frame skin logic.

## Integration checks

Headless checks construct a second revolver sharing the material cache and confirm its materials remain unchanged. Both hands retain their original materials. Applying the skin leaves the muzzle marker, cylinder, crane, cases and ejector transforms untouched. Clearing the layer removes the additions and restores every original material.

Added geometry bounds in the resting model are approximately X ±0.0601, Y -0.1474 to 0.0693, Z -0.5058 to 0.0484. All additions remain behind the -0.520 muzzle and below the 0.105 sight axis. Added cylinder details stay on the exterior and do not cover the rear chamber mouths or cartridges.

Browser review should include a close side view for the ivory carving, a three-quarter view for the cylinder filigree, the normal first-person pose, ADS and cylinder reload. Geometric checks alone do not establish the final rendered appearance.
