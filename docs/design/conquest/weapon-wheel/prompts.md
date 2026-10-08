# Conquest weapon wheel

Request: make the weapon wheel much simpler in Conquest. A kit carries 3 or 4
weapons (primary, Engineer gadget, IRONCLAD .44, IRON PICK). The old wheel
listed all 15 to 16 weapons in the game and marked most of them LOCKED
(`before/desktop-engineer-aa.jpg`).

## Alternatives (ImageGen, gpt-image-2, 1536x1024, text-to-image, 2026-10-08)

- **A: four-quadrant ring** (`option-a.jpg`): a donut split into one big segment per carried weapon, a glowing amber edge on the hovered segment, a hub with the name and how to confirm.
- **B: four-card cross** (`option-b.jpg`): four large cards around the crosshair, plus a read-only throwables row.
- **C: compact arc** (`option-c.jpg`): four icon tiles on a faint circle with a wedge pointer.

## Choice: A

- **The segments are the hit areas.** `wheelSlotFromVector` already splits the circle into equal sectors. In A each sector is drawn as a segment, so a flick toward a segment selects it. In B and C the cards cover only part of their sector.
- **It is closest to Battlefield.** It also keeps the existing ring, hub, amber cursor and commit ring, so the mouse, gamepad and touch paths stay as they are.
- **It scales to phones.** A 4-segment donut stays readable at 335 px. B's cards collide in its own phone inset.
- **No throwables row.** The kit's grenades already have the pouch (G / H) and the Ready Card. A second, read-only row (B) would repeat that and add clutter.

The design changes that the implementation follows:

- A kit without a gadget has three 120° segments.
- The role caption shows the gadget's role (`GADGET · AT` or `GADGET · AA`).
- Touch hides the key badges.
- The hub reads `RELEASE K TO EQUIP / ESC CANCEL` on desktop and `LIFT TO EQUIP` on touch.

## Implementation

- `public/js/session/weapon-wheel-controller.js`, `kitEntries()`: in Conquest with an authoritative `owned` list, the wheel lists exactly those weapons in the order primary, gadget, sidearm, melee.
  - Ammo comes from the live weapon state.
  - `key` is the digit that equips the weapon outside the wheel. The launcher digit also equips the STINGER. The FURNACE has no digit, so it shows no badge.
  - Digits pressed while the wheel is open map through `directIndex()`.
- `public/js/ui/weapon-wheel.js`: entries that carry a `role` turn on the `is-kit` layout: segments, conic hover wedge, role captions and the hub copy.
- `public/style.css`, section *Conquest kit wheel*.
- Other modes keep the full wheel without changes.

## Verification

`node tools/conquest-weapon-wheel-capture.mjs` uses the real overlay and the session controller on `public/conquest-hud-capture.html` with muted CDP and no live match. It renders:

- desktop 1440x900, portrait 390x844 and landscape 844x390;
- Engineer AT, Engineer AA (STINGER), Assault and Support FURNACE;
- TDM, which must stay the full 15-slot wheel.

It checks the segment roles and keys, that no locked segments appear, that exactly one weapon is marked equipped, and the viewport bounds. It then flicks to every segment and checks what gets equipped. Screenshots are in `after/`.

## Prompts

### Option A

```text
Use case: ui-mockup. Asset type: in-game HUD design reference for VOXEL BLITZ, a blocky browser voxel first-person shooter, Conquest mode (Battlefield-style). Background: first-person view of a sunny blocky voxel industrial battlefield (gray stone, rust metal, olive scrub, blue sky) heavily dimmed and slightly blurred behind the overlay, a voxel rifle in the lower right of the view. Existing UI identity to match exactly: charcoal translucent panels (rgba 11,14,18 at ~75%), slim 1px steel-gray borders, warm amber accent #ffcf5c for highlight and equipped state, condensed bold uppercase sans-serif labels with wide letter spacing, monospace ammo numbers, ally team blue #4cc3ff only as a tiny accent, no gradients beyond subtle vignette. The image shows a DESKTOP 16:10 landscape screen with a small PHONE PORTRAIT inset in the lower-right corner showing the same overlay adapted for touch (bigger hit areas, no key hints). Content: a strongly simplified weapon wheel that shows ONLY the four items the Engineer kit carries: PRIMARY "HORNET SMG" ammo "30 / 4" key [2] (EQUIPPED), GADGET "AX-9 STINGER" ammo "1 / 2" key [8], SIDEARM "IRONCLAD .44" ammo "6 / 8" key [6], MELEE "IRON PICK" ammo "∞" key [0]. Each item has a large side-view voxel weapon silhouette icon, weapon name, small role caption (PRIMARY / GADGET / SIDEARM / MELEE), ammo, and the slot key badge. The GADGET segment is highlighted (hovered) in amber. No locked weapons, no prices, no shop, no class tabs, no extra panels, no logos, no watermark, legible crisp CSS-like rendering, practical HTML/CSS implementation. 
Layout variant A, "Four-quadrant ring": a centered donut ring about 46% of screen height, divided into four large equal 90-degree segments with thin gaps: PRIMARY at the top, GADGET on the right, SIDEARM at the bottom, MELEE on the left. Each segment contains its big icon, name, ammo and key badge centered inside the segment. The hovered segment fills with translucent amber and its outer edge glows amber; the equipped segment carries a small amber EQUIPPED tag. A small dark center hub shows the hovered weapon name large in amber and the line "RELEASE K TO EQUIP · ESC CANCEL". A small amber dot cursor sits inside the hovered segment, offset from center toward it.
```

### Option B

```text
Use case: ui-mockup. Asset type: in-game HUD design reference for VOXEL BLITZ, a blocky browser voxel first-person shooter, Conquest mode (Battlefield-style). Background: first-person view of a sunny blocky voxel industrial battlefield (gray stone, rust metal, olive scrub, blue sky) heavily dimmed and slightly blurred behind the overlay, a voxel rifle in the lower right of the view. Existing UI identity to match exactly: charcoal translucent panels (rgba 11,14,18 at ~75%), slim 1px steel-gray borders, warm amber accent #ffcf5c for highlight and equipped state, condensed bold uppercase sans-serif labels with wide letter spacing, monospace ammo numbers, ally team blue #4cc3ff only as a tiny accent, no gradients beyond subtle vignette. The image shows a DESKTOP 16:10 landscape screen with a small PHONE PORTRAIT inset in the lower-right corner showing the same overlay adapted for touch (bigger hit areas, no key hints). Content: a strongly simplified weapon wheel that shows ONLY the four items the Engineer kit carries: PRIMARY "HORNET SMG" ammo "30 / 4" key [2] (EQUIPPED), GADGET "AX-9 STINGER" ammo "1 / 2" key [8], SIDEARM "IRONCLAD .44" ammo "6 / 8" key [6], MELEE "IRON PICK" ammo "∞" key [0]. Each item has a large side-view voxel weapon silhouette icon, weapon name, small role caption (PRIMARY / GADGET / SIDEARM / MELEE), ammo, and the slot key badge. The GADGET segment is highlighted (hovered) in amber. No locked weapons, no prices, no shop, no class tabs, no extra panels, no logos, no watermark, legible crisp CSS-like rendering, practical HTML/CSS implementation. 
Layout variant B, "Four-card cross": no full ring; four large rounded-rectangle charcoal cards arranged as a plus/cross around the crosshair at a comfortable distance (PRIMARY top, GADGET right, SIDEARM bottom, MELEE left), each card roughly 200 by 110 pixels with a wide icon window on top, name, role caption and ammo below, the key badge in the card corner. A thin dashed amber circle passes through the four cards to show the flick radius. The hovered GADGET card has an amber border and slightly larger scale; the equipped card shows an amber top bar and EQUIPPED tag. A compact center hub circle reads the hovered weapon name and "RELEASE K · ESC CANCEL". Below the cross, a slim secondary read-only row of the kit throwables: "FRAG x1  SMOKE x1   [G] THROW  [H] POUCH" in small muted text.
```

### Option C

```text
Use case: ui-mockup. Asset type: in-game HUD design reference for VOXEL BLITZ, a blocky browser voxel first-person shooter, Conquest mode (Battlefield-style). Background: first-person view of a sunny blocky voxel industrial battlefield (gray stone, rust metal, olive scrub, blue sky) heavily dimmed and slightly blurred behind the overlay, a voxel rifle in the lower right of the view. Existing UI identity to match exactly: charcoal translucent panels (rgba 11,14,18 at ~75%), slim 1px steel-gray borders, warm amber accent #ffcf5c for highlight and equipped state, condensed bold uppercase sans-serif labels with wide letter spacing, monospace ammo numbers, ally team blue #4cc3ff only as a tiny accent, no gradients beyond subtle vignette. The image shows a DESKTOP 16:10 landscape screen with a small PHONE PORTRAIT inset in the lower-right corner showing the same overlay adapted for touch (bigger hit areas, no key hints). Content: a strongly simplified weapon wheel that shows ONLY the four items the Engineer kit carries: PRIMARY "HORNET SMG" ammo "30 / 4" key [2] (EQUIPPED), GADGET "AX-9 STINGER" ammo "1 / 2" key [8], SIDEARM "IRONCLAD .44" ammo "6 / 8" key [6], MELEE "IRON PICK" ammo "∞" key [0]. Each item has a large side-view voxel weapon silhouette icon, weapon name, small role caption (PRIMARY / GADGET / SIDEARM / MELEE), ammo, and the slot key badge. The GADGET segment is highlighted (hovered) in amber. No locked weapons, no prices, no shop, no class tabs, no extra panels, no logos, no watermark, legible crisp CSS-like rendering, practical HTML/CSS implementation. 
Layout variant C, "Compact arc": a minimal partial wheel: four large icon tiles evenly spaced on an invisible circle around the crosshair (top, right, bottom, left) connected by a thin faint ring line, with a narrow amber wedge pointer from the center toward the hovered tile. Tiles are square-ish 150 px, icon dominant, name and ammo underneath in small text, the key badge as a small chip above. Hovered GADGET tile is scaled up 1.15 with an amber outline and amber name; equipped tile has a short amber underline. Nothing in the center except a small amber dot and the hovered weapon's role caption. Extremely clean, lots of empty space.
```

