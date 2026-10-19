# Conquest vehicle upgrades: design references

Generated with `codex_images.py --model gpt-image-2 --size 1536x1024 --quality high` from the prompts next to each image. Each prompt describes the current deploy screen (classes strip, spawn list, map) and the requested change: one upgrade pick per hull type, with career-level locks.

| Reference | Prompt | Idea |
|---|---|---|
| `upgrades-a-reference.jpg` | `upgrades-a.prompt.txt` | **Chosen.** A CLASSES / VEHICLES tab pair (with the career "LV n") above the class strip. VEHICLES swaps the strip for a 3x2 grid of hull cards: JEEP, AT JEEP, TANK, ATTACK HELI, TRANSPORT, JET. Each card has a chip row (STOCK plus 2-3 upgrades); locked chips are dashed with a padlock and "LV n". An info line describes the focused chip. Phone: one column of the same cards. |
| `upgrades-b-reference.jpg` | `upgrades-b.prompt.txt` | A third "VEHICLE LOADOUT" column with an accordion row per hull. Rejected: it narrows the spawn list on desktop, and on the phone it adds a second collapsible surface between the spawns and the classes. |
| `upgrades-c-reference.jpg` | `upgrades-c.prompt.txt` | A spawn-aware hull chip row under the spawn list that feeds the class loadout bar. Rejected: you only see one hull's choices at a time, and the loadout bar can't take a second segment at 1024 px. |

Implementation captures are in `captures/`: desktop 1440x900, phone portrait 390x844 and phone landscape 844x390. They were made with muted CDP via `node tools/conquest-hud-capture.mjs --out docs/design/conquest/upgrades/captures --only deploy-vehicles,tank-commander`. `deploy-vehicles` is the VEHICLES tab at LV 4, spawning into the tank; `tank-commander` shows the driver's REACTIVE badge on the vehicle panel. `captures/deploy-layout-report.json` is the DOM check at 1280x720, 1440x900, 1024x768, 1100x700 and both phone sizes. In each, the DEPLOY button overlaps no hull card or info line, no chip clips its label, and the page does not scroll sideways.

Differences from the chosen reference:
- The tab reads CLASSES (the existing section name), not CLASS.
- The hull cards use the existing small vehicle glyphs, not large silhouettes.
- The info line has no "i" icon and sits beside the DEPLOY button, which stays in its footer place, as in the classes redesign.
- Unlock levels come from `shared/vehicle-upgrades.js`, not the reference: ECM JAMMER and EXTRA MISSILE are LV 6, HEAVY DOOR GUNS is LV 5.
- The card for the hull the picked spawn would put you in gets an amber edge (TANK in the capture). The reference had no spawn link.
