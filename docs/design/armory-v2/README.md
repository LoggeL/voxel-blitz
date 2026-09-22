# ARMORY v2 design record

The single-dialog ARMORY (`dialog#career-shop`: LOADOUT, WEAPONS, PROGRESS,
MASTERY) replaces the career page and the separate weapon workshop recorded in
[../armory/README.md](../armory/README.md). The authoritative behaviour is
[spec.md](spec.md); player-facing rules are in
[docs/progression.md](../../progression.md), [docs/cosmetics.md](../../cosmetics.md)
and [docs/weapon-customization.md](../../weapon-customization.md).

## Design references: not generated

AGENTS.md asks for ImageGen alternatives before a substantial UI change.
**ImageGen was not available in the integration session (2026-09-22)**, so no
alternative or chosen reference image exists, and none was fabricated:
`alt-a|b|c-desktop.png`, `alt-a|b|c-mobile.png` and `chosen-*.png` are absent on
purpose. [prompts.json](prompts.json) holds the three prompts that would have
been sent (workbench grid, progress-first journey, mastery ladder wall, each at
1440x900 and 390x844; `{shared}` stands for the shared style block in the same
file). A follow-up with ImageGen should generate them from the screenshots
below, pick one, and record the comparison here.

In their absence the layout follows spec §5 directly and keeps the existing
armory palette (dark slate panels, steel borders, `--career-accent`).

## Implemented screenshots

Captured by `npm run armory:browser` (muted, headless CDP through
`tools/lib/cdp-session.mjs`) from a level-4 guest fixture with 40 rifle and 12
SMG kills, and copied from `.artifacts/armory/`:

| Tab | Desktop 1440x900 | Mobile 390x844 |
| --- | --- | --- |
| Main menu | not kept (1.3 MB of key art) | [main](screenshots/main-390x844.png) |
| LOADOUT | [loadout](screenshots/loadout-1440x900.png) | [slots](screenshots/loadout-390x844.png), [options](screenshots/loadout-options-390x844.png) |
| WEAPONS | [weapons](screenshots/weapons-1440x900.png) | [weapons](screenshots/weapons-390x844.png) |
| PROGRESS | [progress](screenshots/progress-1440x900.png) | [progress](screenshots/progress-390x844.png) |
| MASTERY | [mastery](screenshots/mastery-1440x900.png) | [mastery](screenshots/mastery-390x844.png) |
| Mobile inspector sheet | — | [sheet](screenshots/sheet-390x844.png) |

The same run also checks 1280x720 and 360x780 for overflow; those captures stay
in `.artifacts/armory/`.

## Review notes (screenshots against spec §5)

Checked by eye at both sizes: no horizontal overflow, BACK visible on every
tab, locked items dashed at full contrast, every state paired with a glyph and a
word, and no store words. Fixed during integration:

- The mobile bottom sheet stayed open across tab switches and covered the next
  tab's list; a tab switch now closes it and clears the previous tab's status.
- A stray `}` in `armory-bench.css` dropped the `.vb-bench` grid rule, so the
  WEAPONS tab rendered as one stacked column.
- The standard nameplate thumbnail printed a clipped "NO BADG"; thumbnails now
  show an empty dashed badge.
- The 3D drag hint sat under the operator model's feet; it now has a backdrop
  and sits above the canvas.
- The journey's YOU card took 72% of the mobile rail; it is now compact so the
  next stop is visible.
- The mobile header music control is a 44 px speaker button that opens the
  slider in a popover (§5.9), and the mobile bottom bar shows a short state
  (`INITIATED · 40 / 50`) so the numbers are never cut off.

Known differences from spec §5 that remain:

- The mobile bottom bar shows `#armory-action` only while it is enabled (EQUIP);
  a disabled action (EQUIPPED, a lock summary) appears in the expanded sheet.
- The LOADOUT option grid holds 3-4 cards at 1440 px because the cards are
  about 160 px wide; the spec estimated 5 columns of 132 px.
- The inspector hides a level-1 career requirement (mastery and arsenal
  rewards), so it lists only the gate that matters.
