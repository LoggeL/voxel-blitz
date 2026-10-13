# Pilot wrist display

Request: move the pilot's tactical readout (grapple charges, recharge, reel, stim / cloak timers) off the floating
DOM chip and onto a diegetic device on the first-person left forearm. Spec: `docs/titanfall.md` §8.7 (Wrist display).
Code: `public/js/titanfall/pilot-wrist.js`.

## Concepts (ImageGen, gpt-image-2, 1672×941)

Each concept was generated as an edit of a live capture of the pilot HUD in the Ashfall alley before the wrist
(rifle, grapple with one charge; the same framing as `baseline/`). Prompts are next to each image (`*.prompt.txt`).

| | Concept | Idea |
|---|---|---|
| A | `wrist-a-reference.jpg` | **Chosen.** Armoured bracer slab: a rectangular screen in a gunmetal bezel strapped behind the glove. Glyph and name on the left, two tall charge cells on the right, big seconds under them, a coloured LED edge. Insets: reeling (cyan chevrons), stim (green drain bar), cloak cooldown. |
| B | `wrist-b-reference.jpg` | Round puck on the back of the wrist: charges as a ring, seconds in the middle. |
| C | `wrist-c-reference.jpg` | Forearm LED strip: a long thin bar of segments along the sleeve with a small label. |

**Why A.** The slab is the only one whose type stays legible at phone sizes: its glass is a 1.6:1 rectangle that can
hold a 2-line layout (name, big digits) at roughly 80 px wide. B's ring wastes the corners, and its centre digits
shrink to a few pixels on a phone. C needs a long stretch of visible forearm, which most weapon poses hide behind the
gun, and its text is tiny. A also matches the cockpit pods (`../cockpit/diegetic/`) and the gun panels
(`../weapon-displays/`): same dark glass, amber ink, LED edge.

## Implementation against the reference

Comparison of `wrist-a-reference.jpg` with `captures/desktop-rifle-grapple-1-crop.png` and
`captures/desktop-rifle-stim-active-crop.png`:

- **Kept:** layout (glyph + name + key cap left, two charge cells right, seconds under the cells), the tone per state
  (amber ready, dimmed amber cooling, cyan reeling with chevrons, green stim drain, ice-blue cloak), the LED edge, the
  strap seat behind the glove, the screen turned toward the eye.
- **Changed:** the slab is smaller (glass 0.11 × 0.069 m; about 154 × 115 px at 1920×1080, FOV 75, rifle; the
  reference's glass is about twice as wide) so it does not cover the lower-left floor when sprinting. There is no
  wrap-around armour cuff: the slab is one merged box mesh (bezel, back plate, lugs, a 0.03 m cradle down to the
  sleeve and two strap bands with their sides) to keep it at one draw. Stim and cloak reuse the charge-cell slot as
  one wide drain bar instead of the reference's thin progress line, so they read at the same size as the grapple
  cells. The glyphs are the loadout screen's tactical icons (`TACTICAL_GLYPHS`), not the reference's pickaxe-like hook.
- **Added:** `IN RANGE` under the name (the server's grapple test on the client voxels: shot aim, 38 m, release from
  the chest, head line of sight), a stand-in left fist for weapons built without a support glove (SMG, revolver,
  knife) that follows the gun at half strength, touch layouts drop the key cap, and the compact face for a glass under
  140 px wide (every phone size): no key cap, bigger name and timer, IN RANGE as a cyan frame.

## Review fixes (2026-10-13)

An independent review found the slab hidden behind the receiver in ADS while the DOM chip stayed hidden, the stand-in
fist appearing mid-reload on two-handed guns and the slab jumping between anchors, the live flag set while the glass
was off screen, unreadable phone text with the rifle covering the second cell at FOV 100, more portrait fallbacks than
documented, and a stand-in fist frozen in screen space. Now:

- ADS on a gun's own support arm (blend > 0.5) and a glass less than 75 % inside the viewport are not live: the DOM
  chip returns the same frame (`captures/ads/`).
- The stand-in is chosen per built weapon; a one-handed gun's reload hand takes the arm through a ~0.15 s ease, the
  slab off during it. Reload sweeps in `tools/titanfall-wrist-test.mjs` check that the slab never moves further than
  its forearm seat.
- Phone sizes draw the compact face; a grown slab grows leftward from its right edge, off the gun body. Per-weapon
  seats for the LMG, ARCHER and THUNDERBOLT; portrait adds a back-of-hand seat before falling back.
- All 11 pilot weapons are captured at the three sizes (`captures/weapons/`).

## Captures

`node tools/titanfall-wrist-capture.mjs` (muted CDP, `public/titanfall-wrist-capture.html`, one `.titan-capture.lock`
slot; the real `ViewmodelRig` with the Blender arms over `../map/captures/desktop-hab-alley.jpg`, the stock HUD,
TitanHud and the touch buttons on phones):

| Folder | Shots |
|---|---|
| `baseline/` | Before the wrist (`--no-wrist`): rifle, grapple 1, at desktop 1920×1080, landscape 844×390, portrait 390×844 |
| `captures/` | Rifle × grapple-2, grapple-1, grapple-0, grapple-reel, grapple-range, stim-active, cloak-cooldown × the three sizes, each with a `-crop` of the screen |
| `captures/weapons/` | grapple-1 with the other 10 pilot weapons (SMG, shotgun, LMG, KRABER, CR-6 chargerifle, ARCHER, THUNDERBOLT, SKIPJACK mgl, revolver, knife) × the three sizes |
| `captures/fov/` | grapple-1 with rifle, revolver, mgl at FOV 65 and 100 × the three sizes |
| `captures/ads/` | grapple-1 aiming down sights (`--ads 1`) with rifle, shotgun, SMG, ARCHER × the three sizes: the support-arm guns hand back to the DOM chip, the SMG's stand-in stays live |

Glass size on screen (px, from the capture reports; "compact" is the phone face):

| | Desktop 1920×1080 | Landscape 844×390 | Portrait 390×844 |
|---|---|---|---|
| Rifle, FOV 75 | 154 × 115 | 84 × 63 compact | 84 × 61 compact |
| SMG / revolver (stand-in fist), FOV 75 | 220 × 177 | 121 × 96 compact | 120 × 86 compact |
| LMG / KRABER, FOV 75 | 137 × 102 / 131 × 97 compact | 74 × 56 / 71 × 53 compact | 76 × 56 / 73 × 53 compact |
| Rifle, FOV 65 | 185 × 139 | 101 × 76 compact | DOM chip |
| Rifle, FOV 100 | 126 × 95 compact | 69 × 53 compact | 69 × 50 compact |

**Fallbacks seen in the captures.** Portrait at FOV 75: only the shotgun (its pump hand is under the touch button
cluster even at the back-of-hand seat). Portrait at FOV 65: rifle, shotgun, LMG, charge rifle, ARCHER, THUNDERBOLT
and SKIPJACK (KRABER, SMG, revolver and knife keep the wrist). Portrait at FOV 100: none. In each fallback the wrist
hides and the floating DOM chip returns. Per-weapon seats (`weaponShift`, [wide, portrait] m): SKIPJACK −0.055 /
−0.16, LMG −0.05 / −0.065, ARCHER 0 / −0.075, THUNDERBOLT 0 / −0.055.
