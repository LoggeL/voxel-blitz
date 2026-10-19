# Ribbons, medals and the result debrief

Spec: [docs/conquest.md](../../../conquest.md), *Ribbons and medals*.

The references were made with ImageGen (`gpt-image-2`, 1536×1024, quality medium; prompts in `prompts/`). The prompts describe the existing HUD and result screen as the captures in `docs/design/conquest/redesign/captures/hud/` show them (top ticket panel, minimap, score ticker, result hero, ticket graph, category MVPs).

## Toast

| Variant | File | Idea | Verdict |
|---|---|---|---|
| A | `toast-a.jpg` | Service ribbon bar panel under the ticket bar: striped bar, RIBBON EARNED, name, reason, +50, ×2, a glint line | **chosen**: the panel language of the top bar and banners, legible on bright terrain, one lane with the flag banners |
| B | `toast-b.jpg` | Card stack on the right edge above the ammo card | rejected: the right edge is the touch FIRE / JUMP / AIM column on phones, and it pulls the eye away from the centre |
| C | `toast-c.jpg` | Vertical drape medallion under the score ticker | rejected: sits on the aim line and the ticker, too loud for an award that can come every few seconds |

## Result screen

| Variant | File | Idea | Verdict |
|---|---|---|---|
| A | `result-a.jpg` | Three panels under the graph: MVP per team plus top squad, YOUR MATCH category bars with the total, RIBBONS & MEDALS with the career bar | **chosen**: every block maps to one results-row field, and it reflows to two columns and then one on phones |
| B | `result-b.jpg` | Tall personal card beside the graph, a stacked category bar, MVP tiles under the graph | rejected: the stacked bar hides small categories, and the tall card leaves no room for the rosters |
| C | `result-c.jpg` | Podium band with a match MVP, top-squad band, ribbon rack and a circular XP ring | rejected: three bands are taller than a 900 px card allows, and portraits and squad emblems would need assets the game does not have |

## Implementation against the reference

Captures (muted CDP, `node tools/conquest-hud-capture.mjs --only ribbon,ribbon-banner,result,result-medals --out docs/design/conquest/ribbons/captures`) at 1440×900, 390×844 and 844×390, with no overlaps between named HUD panels (`captures/capture-report.json`):

- `*-ribbon.png`: MEDIC RIBBON ×2 with the ticker. It matches variant A: amber left edge, striped bar with the cross glyph, eyebrow, name, reason, +50 and ×2, and the glint along the bottom. The ribbon bar is drawn with CSS stripes and an icon from `icons.js` instead of the reference's fabric texture.
- `*-ribbon-banner.png`: a capture banner and a CONQUEST RIBBON at once. The toast steps below the banner (+76 px on desktop, +58 px on touch).
- `*-result.png`: the debrief for a mid-table player with no medal (NO MEDALS line) and a partial level bar.
- `*-result-medals.png`: VALOR and SERVICE medals and a level-up (LEVEL UP · LV 5 → LV 6, a bar that fills from the new level's floor).

Differences from variant A: the full-width graph of the reference stays the existing graph plus the five category MVPs (MVP, TOP GUN, OBJECTIVE, TANK BUSTER, MEDIC). The top squad lists its members in two columns, without portraits or a squad emblem. Unearned ribbons are dashed placeholders with their glyph, as in the reference. The card scrolls with the vote footer pinned, so the rosters stay reachable under the debrief at every size.
