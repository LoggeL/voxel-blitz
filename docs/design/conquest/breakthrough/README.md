# Breakthrough HUD

Breakthrough (docs/conquest.md, *Breakthrough*) needs the HUD to show which sector is in play, which sectors are taken or locked, the attackers' ticket pool, the defenders' fall-back grace and the overtime.

- `before/`: the Conquest HUD this builds on (desktop capturing and deploy, phone portrait).
- `breakthrough-hud-a/b/c-reference.jpg` + `.prompt.txt`: gpt-image-2 alternatives (the image tool takes no input image, so each prompt describes the current HUD from the `before/` captures).
  - **A (chosen)**: the sector track lives inside the existing top bar. The flag chips group into one box per sector with chevrons between them: taken sectors in the attackers' colour, the active one outlined in yellow, locked ones dimmed with a padlock. Only the attackers' side carries a ticket number; the defenders' side reads HOLD THE LINE.
  - B: compact bar with lost chips struck through, a SECTOR 2 OF 3 pill, a red front line on the minimap and a SECTOR LOST · FALL BACK card. The card and the minimap line were taken over into the implementation.
  - C: a separate ticket panel plus a vertical sector stack in the top right corner. It puts a second panel where the edge-clamped flag markers and (on phones) the weapon card sit.
- `captures/`: the implementation (`node tools/conquest-hud-capture.mjs --only bt-attack,bt-fallback,bt-overtime,bt-deploy --out docs/design/conquest/breakthrough/captures`, converted to JPEG), desktop 1440 × 900, portrait 390 × 844 and landscape 844 × 390. The run reports no overlaps.
  - `bt-attack`: WEST attacks sector 2 (C) after taking A B, 22 of 30 tickets, the SECTOR 1 CAPTURED · +20 TICKETS banner, D and E markers dimmed with padlocks.
  - `bt-fallback`: WEST defends (EAST attacks), sector E D just fell and the player stands behind the new line: FALL BACK 13 tag under the clock and the fall-back card counting the grace down (amber, not the red out-of-bounds blink).
  - `bt-overtime`: the attackers at 0 tickets contesting E: OVERTIME tag and banner.
  - `bt-deploy`: the HQ entry is FORWARD HQ · FLAGS A B, centred between the taken flags, and A and B are marked FORWARD.

Compared with A: same placement and colour roles. The sector names are short `S1`/`S2`/`S3` labels on the box edge instead of `SECTOR 1 · A B` text, so the bar stays as tall as the plain Conquest bar (the banner below it keeps its place) and fits phones. On phones the labels and chevrons drop and only the boxed chips remain. The padlock is the existing `padlock` icon. The banner line under the bar in A is the existing objective banner.

Every value comes from authoritative state: the sector track, roles and grace from `match.conquest.bt` (`decodeBreakthrough`), the flag control from the flag tuples, the front lines from `breakthroughFront` over the map statics, the countdown from `graceEndsAt` and `cq[4]`.
