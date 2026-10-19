# Squad orders and the comm rose

Spec: *Squad orders and the comm rose* in `docs/conquest.md` (contract v6).

- `orders-a/b/c-reference.png` + `prompt-a/b/c.txt`: gpt-image-2 alternatives on the current Frontier HUD (same base prompt, different "NEW ELEMENTS").
  - **A (chosen) "segmented ring rose"**: 8 equal wedges around the crosshair with a COMMS hub, the hovered wedge filled cyan; an ATTACK tag on the ordered flag's marker; an order chip above the squad list; a double ring on the minimap; a NEED MEDIC marker over a mate. The wedges are large mouse / stick targets that also work as touch buttons, and the hub says what releasing does.
  - B "hex tile rose": separate hex tiles with two-line labels and an order pill under the ticket bar. The tiles leave gaps a flick can miss, and the pill crowds the ticket bar, which already carries flags and the timer.
  - C "minimal arc rose": floating labels on a thin circle. It reads clean on a calm frame but loses its labels against bright terrain, and icon-only request badges are too small at phone size.
- `captures/`: the implementation through the muted CDP capture page (`node tools/conquest-hud-capture.mjs --only orders-rose,orders-chip,orders-map --out docs/design/conquest/orders/captures`) at desktop (1440×900), portrait (390×844) and landscape (844×390). `capture-report.json` lists no overlaps.
  - `orders-rose`: a squad leader holds U while looking at C. The ORDER wedge reads ATTACK C – IRON BRIDGE. NEED REPAIR is dimmed (no damaged hull), and Nova's NEED MEDIC marker replaces her squad dot.
  - `orders-chip`: a member under the leader's ATTACK C order, with the order chip, the radio lines ("BRANNOCK · AFFIRMATIVE", "AMMO BRANNOCK RESPONDING") and the ATTACK tag on C's marker.
  - `orders-map`: the full map for a leader with B ordered (double ring) and the pad / locked-pointer cursor on D.

## Compared with A

Placement and structure match A. The rose is centred on the crosshair with its 8 wedges. The labels sit under line icons. The hub reads COMMS / RELEASE TO SEND, and the hovered wedge is filled. The order chip sits above the minimap / squad list, and the ordered flag gets a tag on its world marker and a double ring on the maps. The request marker uses a cross glyph and a distance (`NEED MEDIC 34 M`).

Deviations:

- **Squad green for squad things.** A drew the order tag and the minimap ring in team cyan. The implementation draws the order chip's bar, the ATTACK / DEFEND tag and the double ring in squad green (`#7ef29a`), because cyan already means "friendly flag / own team" on every map, and an order on an own flag (DEFEND) would vanish into the flag's cyan. The hovered wedge stays cyan as in A.
- **ORDER is the last wedge.** It sits at the top-left, as A shows it. Its label names the flag in sight ("ATTACK C" / "DEFEND A"), with the flag's name underneath. For members, or with no flag in sight, it is dimmed with a short reason.
- **Dimmed wedges.** A shows every wedge lit. The implementation dims wedges that the server would refuse right now (NEED REPAIR without a damaged hull, NEED AMMO / RIDE while seated, ORDER for members), so a release never does nothing silently.
- **"YOUR ORDER" for the leader.** The chip header reads YOUR ORDER for the leader and SQUAD ORDER for members.
- **Touch layouts.** A is desktop only. On touch, the COMMS button sits under MAP and SPOT, and a tap on a wedge sends. In portrait, the chip and the last two radio lines stack under the minimap at its width, and the flag name is dropped. In landscape, the chip sits under the ticket bar and the radio sits beside the squad list. The rose shrinks to `min(280px, 72vmin)`.
- **Full map.** A has no full-map state. The map header tells a leader "SQUAD ORDER B · PICK A FLAG · SAME FLAG CLEARS", and members are told that leaders order from it.

## Not covered

- There are no voice lines: radio cues play the existing `cq.amb.squelch` sample only (no ElevenLabs generation for this change).
