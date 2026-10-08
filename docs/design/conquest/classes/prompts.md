# Conquest classes: design references

Generated with `codex_images.py --model gpt-image-2 --size 1536x1024 --quality high` from the prompts next to each image, starting from the deploy screen capture `docs/design/conquest/gadgets/desktop-deploy-aa.png`.

| Reference | Prompt | Idea |
|---|---|---|
| `picker-a-reference.jpg` | `picker-a.prompt.txt` | **Chosen.** Full-width class strip under the map and spawn list: a CLASSES row of five base cards and a compact UNLOCKS row of four; locked cards dimmed with a padlock, "LV n" and a thin XP bar. Phone: two-column grid. |
| `picker-b-reference.jpg` | `picker-b.prompt.txt` | Narrow class column with a detail pane. Rejected: it squeezes the spawn list and needs a second selection surface for the primaries. |
| `medic-hud-reference.jpg` | `medic-hud.prompt.txt` | Medic in-game feedback: downed-mate cross with distance, revive hold ring, green crosses over wounded mates, heal-aura ring on the minimap, "+5 HP" on the health card, HEAL / REVIVE ticker, the downed player's "NEAREST MEDIC" line. |

Implementation captures (muted CDP, `node tools/conquest-hud-capture.mjs --out docs/design/conquest/classes/captures --only deploy,deploy-classes,deploy-locked,deploy-down-medic,medic-heal,revive`) are in `captures/` at desktop 1440x900, phone portrait 390x844 and phone landscape 844x390.

Differences from the chosen reference: the DEPLOY button stays in the footer (not beside the unlocks row) so the touch DEPLOY button and the refusal status keep their places; class cards keep the existing panel style (icon left of the name) instead of the large centred icons; the "+HP" tick sits inside the health card because the card is clipped.
