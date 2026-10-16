# RX-8 HAVOC redesign concepts

Generated with the built-in `image_gen` tool. Both calls use the following reference images in this order:

1. `docs/design/blender/torch/render-hero.png`: current Blender studio render.
2. `docs/design/havoc/before/rocket-held.png`: current first-person view.

## Concept A (VANGUARD)

Output: `docs/design/havoc/concept-a.png`

Exact prompt:

```text
Use case: stylized-concept
Asset type: implementable 3D weapon design reference sheet for VOXEL BLITZ, Concept A (VANGUARD)
Input images: Image 1 is the current Blender studio render; Image 2 is the current first-person view.
Primary request: Redesign the fictional RX-8 HAVOC shoulder-fired recoilless RPG launcher to replace its blocky slab receiver, flat white top plank, and oversized bucket venturi with a cohesive, sculpted industrial hard-surface design that can be built in Blender. Keep the olive-drab, dark phosphated gunmetal, safety-orange, warm ivory, dark polymer, and black rubber palette. Feature a smooth lofted super-elliptic olive-drab receiver shell with recessed dark polymer service pockets and subtle ivory RX-8 HAVOC markings on the upper shoulder chamfer; a lathed gunmetal launch tube with machined cooling flutes, twin orange-accented barrel collars, an exposed forward metal heat-sleeve section for the support hand, and a slotted muzzle crown cradling a seated ivory-and-orange shaped-charge warhead nose; a compact tapered fluted Carl-Gustaf-style rear venturi breech cone on a left-side vertical hinge pin with an orange right-side cam latch; ergonomic raked pistol grip, forward support grip with underslung ignition canister, padded rubber shoulder rest, and a wide-open low-profile top rangefinder sight bridge with an unobstructed sight channel.
Composition/framing: Clean dark slate studio concept sheet showing a large 3/4 front-left hero view of the launcher, a smaller first-person view in the lower right with a compact rear venturi and clear open sight window, and an open-breech reload inset in the upper right showing a complete sculpted olive-and-orange finned HAVOC rocket round sliding into the open rear breech.
Constraints: Fictional game asset only; no flat white top plank; no giant cylindrical bucket blocking first-person view; no diagram arrows or dimension numbers.
```

## Concept B (BREACHER)

Output: `docs/design/havoc/concept-b.png`

Exact prompt:

```text
Use case: stylized-concept
Asset type: implementable 3D weapon design reference sheet for VOXEL BLITZ, Concept B (BREACHER)
Input images: Image 1 is the current Blender studio render; Image 2 is the current first-person view.
Primary request: A second distinct industrial hard-surface redesign of the fictional RX-8 HAVOC single-shot recoilless rocket launcher. Use a chamfered octagonal gunmetal launch tube wrapped by three sculpted olive-drab armor saddles and twin longitudinal upper spine rails with recessed ivory stencil plates, leaving the forward heat-sleeve tube section exposed above the angled foregrip. Include a 4-port vented muzzle brake ring framing the seated tandem warhead tip, a compact stepped rear De Laval venturi nozzle that swings open on a left vertical hinge pin, a right-flank orange-tipped arming lever, raked ergonomic pistol grip, underslung control module, contoured rubber shoulder pad, and a wide cantilevered ghost-ring / open reflex sight hood with a completely clear central aiming axis.
Composition/framing: Clean dark charcoal studio concept sheet with a large 3/4 side hero render, a smaller open-breech rear-loading inset showing the complete finned rocket cartridge, and a smaller first-person view inset.
Constraints: Fictional game prop only; no flat surfboard top deck; no oversized rear stovepipe; no diagram arrows.
```

## Selection

**Selected: Concept A (VANGUARD)** as the primary geometric reference, incorporating Concept B's right-flank orange-tipped mechanical arming lever (`bolt`).

- **Why Concept A fits best**:
  - Replaces the previous blocky slab receiver and flat white top deck with a sculpted, lofted olive-drab monocoque receiver shell with recessed dark polymer service pockets and flank `RX-8 / HAVOC` ivory markings.
  - Uses a low-profile top sight bridge with an open U-notch rear sight and hooded orange front post, keeping the canonical `0.175 m` sight channel completely unobstructed in first person and ADS.
  - Keeps the cylindrical underslung ignition canister (`mag`), forward support grip (`support`), and raked pistol grip (`grip`) aligned with the frozen runtime hand anchors while leaving the forward `0.0620 m` thermal barrel sleeve (`y = 0.528..0.752`) clear for the heat shader and support glove, crowned at the muzzle (`y = 0.752..0.780`) by a castellated gunmetal blast collar with orange ordnance bands.
  - Pairs a tapered, fluted De Laval venturi breech gate on the canonical left vertical pin `(-0.104, 0.075, -0.135)` with a complete Blender-authored finned HAVOC rocket round (ogive warhead with ivory/orange/gunmetal zones, olive motor tube, steel nozzle, and four swept tail fins) used for both the authoritative chambered warhead and the reload round.
