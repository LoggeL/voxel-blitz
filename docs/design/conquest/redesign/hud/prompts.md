# Conquest v2 HUD: design references and prompts

Work package WP7 of the Conquest "Frontier" redesign (spec §2 F5–F6, §7). This page covers the objective HUD, the deploy screen, the world markers, the vehicle HUD and reticles, and the touch layout.

## References used

### Generated references (2026-10-07)

On 2026-10-07 the four references in this folder were generated with **gpt-image-2 through the Codex image endpoint**. The exact prompt for each image is in the `.prompt.txt` file next to it.

| Reference | Prompt | Chosen | What we took from it |
|---|---|---|---|
| `gameplay-hud-reference.jpg` | `gameplay-hud.prompt.txt` | **Alternative 2, "bolder wide ticket panel"** | The wide ticket panel with large numbers and thick bars. The round minimap at the bottom left with a **squad list beside it** (kit glyph + name). The capture ring and score ticker below the crosshair. Alt 1 is too thin over bright sky. Alt 3's angled panels clash with the existing rectangular HUD cards. |
| `objective-markers-reference.jpg` | `objective-markers.prompt.txt` | One sheet showing three states (capturing, contested/neutralizing, defending), used as a whole | The **yellow hatched ring** for a contested flag. Diamond flag markers with the distance and a progress arc. The edge arrow when a marker is clamped to the screen edge. Green squad name tags, blue team dots, the red cross over a downed teammate with the distance, and red diamonds over spotted enemies. |
| `deploy-screen-reference.jpg` | `deploy-screen.prompt.txt` | **Alternative 1, map left, kits right** | The current deploy screen already follows it. This pass keeps flag names readable above the spawn badges. |
| `vehicle-reticles-reference.jpg` | `vehicle-reticles.prompt.txt` | One sheet of six panels, used as a whole | It confirms the existing seat reticles: tank reload arc, rocket pip, chin gimbal box with heat, door-gun arc limit, jet tapes and lead pipper, inbound-missile bearing. This pass does not change them. |

### Earlier references

The first WP7 sessions had no ImageGen tool. Following spec §0.8, they designed the HUD from the existing references:

| Reference | What we took from it |
|---|---|
| `docs/design/conquest/hud-alternatives.png`, **Option 2 / Immersive Command** (chosen) | A wide top panel with ticket counts and progress bars on both sides of the flag diamonds. A circular minimap at the bottom left with a compass ring. The vehicle readout above the weapon card. A context prompt just below the centre. |
| `docs/design/conquest/aircraft/hud-alternatives.png`, **Alt 2 / detailed flight instruments** | The jet speed and altitude readouts, rebuilt as moving tapes on both sides of the gun funnel. A boxed hull readout. The amber-on-charcoal instrument style. |
| `docs/design/conquest/aircraft/hud-alternatives.png`, **Alt 3 / mobile portrait** | Large rounded touch buttons with amber borders for the flight controls, reused for the SEAT, FLARES/SMOKE, MAP, SPOT and DEPLOY buttons. |

The implementation departs from the references in these places:

- **Team-relative colours.** The references colour teams as ALPHA blue and BRAVO red. The implementation always shows your own team in blue `#4cc3ff` on the left and the enemy in orange `#ff8a3d` on the right, with neutral `#d8d8d8`. The labels are the display names WEST and EAST. An EAST player sees EAST in blue on the left.
- **Five chips.** The older references show three flag diamonds. Frontier v2 has five flags (A–E). Gameplay Alt 2 draws them as circles. We keep diamonds so they match the world markers and the map. Each chip is tinted by its owner. A fill bar shows control toward the leaning side, and a yellow hatch marks a contested flag.
- **Bleed and clock.** Each ticket side shows `▼ 1/3s` while that team loses tickets to bleed. The time left (`endsAt`) sits under the chips. Alt 2 puts the clock between the numbers. We keep it under the chips so the panel stays as wide as before.
- **Squad list content.** Alt 2 lists four callsigns. We list the squadmates from their authoritative rows: the kit glyph, the hull glyph while seated, or a red cross while down. Each row has the name and DOWN / DEAD. The leader gets a star, and the header is the squad name (`ALPHA SQUAD`). The local player is not listed. Health values and other invented per-mate readouts are left out.
- **Weapon and health cards.** Alt 2 shows one combined weapon card with the HP bar under it. Conquest keeps the game-wide `#ammo`, `#grenade-count` and `#healthbar` cards that every mode shares. They already show the authoritative magazine, reserve, grenade stock and HP. A Conquest-only restyle would fork them for a cosmetic difference.
- **No permanent keybind line.** Aircraft Alt 1 has a `W/S MOVE … T EXIT` strip, which is dropped (spec §2 F6). The full-map and spot keys show as a short onboarding caption above the minimap on desktop only; it disappears after 30 s in the match or once the player has used M or Y. Seat keys F1–F5 appear only in the seat strip.
- **Prompt key.** The references show `X ENTER JEEP`. The real Interact key is T (X is prone, and X is also the vehicle countermeasure). The prompt reads the live binding.

## Polish pass against the generated references (2026-10-07)

| Gap | Change | Where |
|---|---|---|
| No squad list beside the minimap | A new `SquadList` beside the minimap, fed by `squadListModel()` from the authoritative rows: `cq` kit/squad/down, `hp`/`state`, `vehicleId` → hull type, and `match.conquest` squads for the leader. Desktop: right of the 184 px minimap. Phone landscape: compact, right of the HP card and above MAP / SPOT. Phone portrait: hidden, because MAP / SPOT fill the space beside the minimap. Hidden while dead, behind the held scoreboard, and it counts as an obstacle for edge markers. | `public/js/ui/conquest/squad-list.js`, `conquest-hud-state.js`, `conquest.css` |
| Off-screen flag markers piled at a screen edge | `spreadEdgeMarkers` keeps a 10 px gap (`EDGE_MARKER_GAP`) between neighbours. A marker slides away from its nearest neighbour on the same border, so the order along the edge follows the clamp (bearing) order. When no slot clears the HUD panels, a marker still takes a slot clear of the other markers instead of stacking. | `conquest-hud-state.js` |
| Vehicle icons covered place names on the big map and the deploy map | Flag names are painted last, on a dark plate. They try below, above, right and left of the flag and avoid badges, HQs and other names. Hull and squad/vehicle spawn badges that land on a flag, an HQ or each other move up to 30 px aside (`declutter`), with a leader line to their true spot. A hull that has a spawn badge is drawn once. Spawn hit-testing uses the drawn position. | `public/js/ui/conquest/big-map.js` |
| Lobby map name truncated (`FRONTIER · 768 × 768 · 16 PLAY…`) | The map menu option drops the trailing `W × H` size (`FRONTIER · 16 PLAYERS`). The capacity line under the menu still reads `… · FRONTIER · 768 × 768`. | `public/js/ui/lobby-settings.js` |
| Ticket panel weaker than Alt 2 | Ticket numbers 26 → 30 px, bars 6 → 8 px. | `conquest.css` |
| Contested flag hard to read | The capture ring track turns into a yellow hatched ring while contested (objective-markers panel 2). The contested chip hatch is stronger. | `conquest.css` |

Captures before this pass are in git history (`docs/design/conquest/redesign/captures/hud/` at `58a7a0c`). The captures after it replace them in the same folder.

## Layout implemented (desktop 1440×900)

- **Top centre:** own ticket bar · 5 chips plus clock · enemy ticket bar. The objective banner sits under it.
- **Centre:** the capture ring (letter, state label, `own vs enemy`) 70 px below the crosshair. The score ticker, the revive/repair hold ring and the interact prompt are below the ring. The lock warning sits above the crosshair with a bearing arrow around it.
- **World layer:** flag diamonds with a progress arc, the distance, and an edge arrow when clamped to the screen edge. Squad names are green, team dots blue, downed crosses red within 40 m, and spotted enemies red diamonds.
- **Bottom left:** a 184 px circular heading-up minimap with N/E/S/W riding the rim, and the squad list to its right.
- **Bottom right:** the infantry weapon card. In a vehicle it is replaced by the vehicle panel: seat strip, hull silhouette with zone flash, HP bar, badges, weapon rows with ammo/heat/reload, and a countermeasure pip.
- **Overlays:** the full map (M), the deploy screen while dead, and the out-of-bounds/restricted countdown.

On touch (390×844 and 844×390), the minimap shrinks to 104 px and moves to the top left under the top bar. The squad list shows only in landscape, in compact form right of the HP card. That keeps the bottom corners for the move stick and the fire cluster. The capture ring, ticker and interact prompt stack below the centre. The vehicle panel compacts to a narrow card above the right cluster. The deploy screen stacks map, spawn list and kits, and the touch DEPLOY button replaces the panel button.

## Prompts

The exact prompts sent to gpt-image-2 are in `gameplay-hud.prompt.txt`, `objective-markers.prompt.txt`, `deploy-screen.prompt.txt` and `vehicle-reticles.prompt.txt` in this folder. They replace the inline briefs that earlier versions of this page kept for a later ImageGen pass.

## Verification

The static capture page `public/conquest-hud-capture.html` renders every fixture state from `public/js/capture/conquest-hud-fixtures.js`. It uses the real `ConquestHud`, kill feed, scoreboard, result overlay and touch controls, with no WebGL, audio or server. Captures and the mobile bounding-box overlap check run in the serialized capture phase:

```
node tools/conquest-hud-capture.mjs --out docs/design/conquest/redesign/captures/hud
```

It writes `<size>-<state>.png` for desktop 1440×900 (window 1440×1037), portrait 390×844 and landscape 844×390, plus `capture-report.json`. It exits 1 on any browser error. It also exits 1 when any fixed HUD panel overlaps another one, an edge-clamped flag marker or a visible touch button. The panels it checks include the minimap, the squad list, the vehicle panel, the capture ring and the interact prompt. Comparison notes against Option 2 and aircraft Alt 2 are in `docs/design/conquest/redesign/captures/comparison.md`.
