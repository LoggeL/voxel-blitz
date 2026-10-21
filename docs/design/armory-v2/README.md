# ARMORY v2 design references

`spec.md` is the source of truth for the ARMORY / progression redesign (rules,
gates, layout, DOM contract). This folder holds the image references made for
the rebuild on current main (2026-10-21) and the browser captures of the result.

## Alternatives (gpt-image-2)

Each `alt-*-reference.jpg` sits next to the prompt that produced it
(`alt-*.prompt.txt`). The prompts start from the current game UI (dark navy
panels, amber accents, monospace labels, voxel art) and the spec's four tabs.

| Alt | Idea | Verdict |
| --- | --- | --- |
| A, Workbench | Slot rail, option grid, persistent inspector; on phones a slot list with a sticky bottom bar | **Chosen** |
| B, Showroom | A large 3D stage with a filmstrip of options under it | Rejected: weak for kinds without a 3D model (HUD themes, callsigns, sounds), hides the slot overview |
| C, Dossier | Full-width PROGRESS page, details in a slide-in drawer | Rejected: no persistent inspector, which the spec requires for every tab |

A matches the spec's layout (slot rail | options | inspector) and keeps one
inspector shared by all four tabs. The mobile reference invents slots and
values that do not exist in the game; only its layout pattern (stacked slot
list, sticky selected-item bar with DETAILS) was taken.

## Implementation vs reference A

- Desktop keeps the three columns, the header strip (level, XP bar, PvP kills,
  wins, all kills, matches, SAVE YOUR CAREER) and the inspector with the 3D
  viewer, name, WHO SEES IT, requirement and one action button.
- Slot rows put "n / m UNLOCKED" under the current value instead of a
  right-aligned count with a chevron per row; the counts come from the live
  career view.
- Locked options use dashed frames with the real gate ("AFTER IGNITION",
  "LV 12"), not invented level numbers. Option art comes from the shipped
  previews and the model viewer; slots without real art use the generated
  icon set in `icons/` (see below).
- The phone layout follows the mobile pattern: a scrolling slot list, the
  current item in a sticky bottom bar with DETAILS opening the sheet.

## Icons

`icons/README.md` covers the generated icon set (gpt-image-2.5-flare, 42 WebP
files in `public/assets/ui/armory/icons/`) that replaced the dashed Standard
plates, the flat title and nameplate thumbs, the CSS attachment glyphs, the
text-only tier pips and the bare Conquest class rows.

## Captures

`screenshots/` holds muted CDP captures from `npm run armory:browser`
(`tools/armory-browser-test.mjs`): LOADOUT, WEAPONS, PROGRESS and MASTERY at
1440x900 and 390x844, plus the phone details sheet. `icons-*.png` are extra
captures of the icon slots those shots do not reach (nameplate and callsign
options, the mastery ladder, the Conquest class rows). The full set (also
1280x720 and 360x780, the option and signed-in states) is written to
`.artifacts/armory/` on every run.
