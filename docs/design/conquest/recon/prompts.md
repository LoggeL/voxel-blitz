# Conquest Recon gadgets: design references

Generated with `codex_images.py --model gpt-image-2 --size 1536x1024 --quality medium` from the prompts next to each image. The prompts describe the HUD as captured before the change (`before/desktop-deploy-aa.jpg`, `before/desktop-capturing.jpg`).

| Reference | Prompt | Idea |
|---|---|---|
| `beacon-a-reference.jpg` | `beacon-a.prompt.txt` | **Chosen.** Antenna glyph (case, mast, two radio arcs each side) for the SPAWN BEACON in the spawn list, on the deploy map and on the minimap; a dashed 30 m ring around the MOTION SENSOR dot; sensed enemies as red dots with a soft halo; BCN / MSN gadget chips in the Recon loadout row. Closest to the existing flat glyph set. |
| `beacon-b-reference.jpg` | `beacon-b.prompt.txt` | Tower-with-chevron glyph in a diamond, red-tinted sensor disc, hollow triangles for sensed enemies. Rejected: diamonds already mean flags, and a filled disc hides the map under it. |
| `beacon-c-reference.jpg` | `beacon-c.prompt.txt` | Radar-arc glyph, an amber cooldown bar under the beacon row. Its "READY IN n S" countdown is kept as the cooling beacon row's text; the arcs read as the spot / audio cue elsewhere. |

Implementation captures (muted CDP, `node tools/conquest-hud-capture.mjs --out docs/design/conquest/recon/captures --only recon-deploy,recon-sensor`) are in `captures/` at desktop 1440x900, phone portrait 390x844 and phone landscape 844x390.

Differences from the chosen reference: the beacon rows sit at the end of the existing spawn list (no distance column, which the list does not have for any spawn); the minimap keeps its range, so the 30 m ring is small there and reads fully on the full map; the gadget card is the existing grenade Ready Card with the SPAWN BEACON / MOTION SENSOR icons.
