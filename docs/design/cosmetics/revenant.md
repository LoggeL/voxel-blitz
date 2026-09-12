# Revenant

Legendary endgame character finish for the Overdrive collection. The catalog gate is level 100 and 10,000 human-player kills. The skin module only handles rendering; progression and entitlement remain outside it.

The visual identity is an obsidian ceremonial combat suit. A sealed, faceted respirator replaces the exposed face, with narrow violet eye slots, six machined cheek vents and a repeated broken-diamond glyph. Layered breastplates, articulated shoulder scales, engraved gauntlets, knee plates and segmented greaves follow the existing operator joints. The rear equipment carries an octagonal sealed core between two violet rails, with pale retaining bands and a central etched glyph.

The finish uses purple-gray ceramic faces, brighter polished bevels, pale violet etchings and thin emissive channels. Team-colored cloth remains visible at the helmet, shoulders, chest band and legs. First-person gloves use the same obsidian and violet palette.

## Runtime contract

- 30 added draws, 18,024 non-indexed vertices, 6,008 triangles. Rigid parts are merged by material within each joint; facet colors use vertex attributes.
- The two shared detail materials and cloned base armor/visor materials belong to `SkinLayer` and dispose with it. Every added root is registered with `ctx.group`.
- Base `suitMaterial` and `darkMaterial` retain their identity and color. Team reassignment still controls both.
- Face and chest details follow the head and torso. The rear assembly follows `pack`, gauntlets follow the hands, and shin/boot details follow the knee and boot joints.
- Base pack variant 2 is deeper. Its reactor seats 0.080 units farther back to avoid intersections with that existing pack.
- Emissive materials set `userData.cosmeticGlow` so hit flashes preserve the channels and etchings. All materials participate in the existing fade path.
- No gameplay parameters, weapon anchors, original geometry, limb heights or hitboxes are modified.

## Validation

Node checks exercised all three base operator variants, all finite geometry attributes, the draw budget, team reassignment, original material restoration and single disposal. Standing, crouched and prone poses preserved hand-to-weapon anchors. Front and rear browser inspection uses `/cosmetic-preview.html?id=revenant`; toggle the standard model for comparison.
