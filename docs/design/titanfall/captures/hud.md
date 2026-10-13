# Titanfall HUD captures (WP6)

Browser captures of the Titanfall pilot HUD, titan cockpit HUD, loadout screen
and touch layout. Each one is compared with the selected references:

- `../hud-pilot.png` (Option 2);
- `../hud-titan.png` (Option 2; the frame is WP5's 3D cockpit, see iter5);
- `../loadout.png` (adopted with the README corrections).

## How they are made

```
node tools/titanfall-hud-capture.mjs --out docs/design/titanfall/captures/hud/iterN --sizes desktop,portrait,landscape
```

The capture holds `.titan-capture.lock`, so only one WebGL capture runs at a time. No server match is involved and no AudioContext is created. It runs two muted CDP Chromium sessions, one after the other (never two at once):

1. **Backdrops** (`--backdrop live`, the default): WP5's `vehicle-capture.html?type=titan_*` renders, at each exact viewport, the ION cockpit view (WP5's 3D cockpit overlay: top brace, pillars, MFD dashboard) and a LEGION standing on an open field. The capture label is hidden. `--backdrop map` uses the old static map still instead.
2. **HUD**: `public/titanfall-hud-capture.html` renders every fixture and is given the matching backdrop as a data URL. The titan layout gets the cockpit and the pilot layout gets the field. The HUD is therefore judged over what a player sees behind it: the 3D cockpit in first person, and bright terrain with no Conquest flag markers.

The page renders the snapshot-shaped fixtures from `public/js/capture/titanfall-hud-fixtures.js` through the real components:

- the stock `HUD` (health, ammo, grenades);
- `TitanHud` and `TitanLoadout`;
- `TouchControls` with the Titanfall touch source.

The loadout portraits are live WebGL renders of the five real titan models (`createModel`, team camo, Neutral tonemap), not concept art.

Every state is checked for overlaps between:

- the fixed HUD panels;
- the stock kill feed (four rows in `pilot`, `titan` and `titan-doomed`) and the career badge (always shown);
- the visible touch buttons, including pause;
- the movement stick at rest (`.vb-touch-stick-base`).

Any overlap, or any page error, fails the run. The one designed nesting is `ammo × touch:weapon`, the stock weapon-swap chip inside the ammo card. The stock HP card shows the spawn state (one medkit). The reserve reads `30 / 6` because the server counts the rifle's reserve in magazines (`spareMags`).

Fixtures:

| Fixture | State shown |
|---|---|
| `pilot` | Pilot with the meter at 72 %, grapple 1/2, battery carried, double jump ready, kill feed |
| `wallrun` | Wall-running with the double jump spent (pips); meter 99 % still reads 99, not 100 |
| `pilot-ready` | Meter full, CALL TITAN chip |
| `bay-full` | Meter full but the titan bay is full |
| `embark` | Own titan nearby: HOLD EMBARK prompt with progress, green HULL gauge, touch EMBARK hold ring |
| `rodeo-mount` | Rodeo mount prompt |
| `rodeo-rip` | Rodeo rip with radial progress |
| `oob` | Out of bounds |
| `titan` | ION cockpit, shield, core at 86 %, kill feed, touch EXIT chip |
| `titan-doomed` | Doomed (hull band empty, doom countdown in red), eject count 1/3, kill feed |
| `titan-rider` | Enemy rodeo rider warning |
| `dead` | Loadout on death with RESPAWN IN |

Sizes:

- `desktop`: 1920×1080
- `portrait`: 390×844, touch on
- `landscape`: 844×390, touch on

## Iterations

`iter1`–`iter3` keep only the representative states (pilot, pilot-ready, titan, titan-doomed, dead), as JPEG, to save space. Their `capture-report.json` files still list the original PNG names. `iter4` is the full set before the art-director review (33 PNGs on the map still). `iter5` is the current full set: 36 PNGs over the live backdrops, with no overlaps and no page errors.

### iter1: first pass, desktop and portrait

Overlaps found:

- the titan meter sat over the stock `#healthbar`;
- the AT chip sat over `#grenade-count`;
- on mobile, the banner sat over the top bar;
- the doom panel sat over the health arc;
- the loadout sat under the touch controls (z-index).

The health arc was too flat and too wide, unlike the reference's tight arc under the reticle.

### iter2: fixes

- The meter hexagon moved above INTEGRITY, as in the reference.
- The AT chip moved above the grenade card.
- On mobile, the banner moves below the top bar.
- The doom panel moved under the arc.
- The loadout moved to `z-menu-5`, above the touch controls.
- The arc became the 300 px radius, ±0.58 rad sweep from the reference. The shield is an inner band and the hull an outer segmented band.

Desktop came out clean. The portraits were still small in their cards.

### iter3: phone landscape added

In landscape, the doom panel moved to the right, clear of the ability row.

The struts shrink to ≤6vw and sit behind the tiles, per the README correction.

The touch ability row matches the README correction: DASH Q E G next to FIRE, with SMOKE and CORE above it and EJECT above those when doomed.

### iter4: final

- The portraits fill their cards (`object-fit: cover`, camera distance factor 0.57).
- On touch, the eject key chip is hidden.
- The touch ability buttons now show the ability's short name (VORTEX / TRIPWIRE / LASER; GRAPPLE / STIM / CLOAK for the pilot) instead of Q / E / G. The names come from `titanfallTouchModel().labels`.

- The loadout chips use WP4's real weapon pictures.

All 33 states are ok, with no warnings.

### iter5: art-director review

The review found problems that iter4's check could not see, because it never tested the stick, never filled the kill feed and never put the 3D cockpit behind the HUD. Fixes:

- **Stick:** the overlap check now includes the movement stick, the career badge and a filled kill feed. On phones narrower than 430 px, DASH joins the CORE / SMOKE row, and EJECT / EXIT become one-button chips beside it. Every titan button now sits right of the stick (`portrait-titan*.png`).
- **Battery chip:** BATTERY CARRIED now hangs off the pilot root instead of the meter dock. In landscape it no longer lands on the stick; on touch it sits under the HP card.
- **Right column:** in the desktop titan layout, the career badge sits between the CORE tile and the DOOMED panel, and the kill feed below the DOOMED panel. On phone portrait, the badge clears the AT chip and the CORE tile. On narrow screens the banner moves down to 204 px.
- **Touch embark:** the pilot context button reads EMBARK next to the own titan. Holding it for 300 ms (`TITAN_RULES.embark.holdMs`) sends the enter, and its conic fill is the hold ring. The `HOLD · EMBARK` chip shows above the meter without a key chip. Seated, the same button reads EXIT and a tap disembarks (touch had no way out of a live titan before).
- **Cockpit:** the CSS struts are gone. WP5's 3D cockpit draws the frame, and the chase view has none. The arc label sits at about 73 % of the height on desktop, above the MFD tiles. On portrait the arc is at most 62vw wide, so it fits between the pillars.
- **Gauges:** percentages are floored. A meter at 0.995 reads 99 % with no CALL TITAN; core and abilities likewise.
- **Arc:** a dark glass band sits behind both segment bands, and the numbers sit in a chamfered glass pill (12 px minimum on phones). When doomed, the hull cells are empty and the red fill is the doom countdown.
- **AT chip:** the name and ammo no longer wrap. The chip uses the weapon's def name (CR-6 LONGBOW), as the stock ammo card does, and the `n / m` separator. While the AT weapon is drawn, its ammo is dimmed.
- **Touch prompts:** no key chips. They read `TAP RODEO`, `HOLD RIPPING BATTERY` and `TAP 1/3 EJECT`.
- **Loadout:**
  - The portraits are rendered at the card slot's own aspect, framed around the whole silhouette (weapon and sword included), from the weapon side with a stronger rim light, and shown with `object-fit: contain`. Unselected cards are slightly desaturated.
  - The selected weapon picture is the brightest. The tactical icons are line glyphs (hook, syringe, dashed hood).
  - The pilot column shows the selected primary's DAMAGE / RATE / MAG bars from `WEAPONS`, and both panels share one height.
  - Phone labels are at least 9–10 px. Phone landscape puts pilot and titan side by side, with a compact DEPLOY.
- **Owned gauge:** the hexagon reads `ION · HULL 100%` / `AUTO-TITAN` in green (red when doomed), never the meter's amber.
- **Jump pips:** a `2× JUMP` / `WALL` pip strip mirrors the tactical chip on the left of the crosshair.

All 36 states (12 fixtures × 3 sizes) are ok, with no overlaps and no page errors.

## Comparison with the references

**Pilot HUD** (`desktop-pilot*.png` against hud-pilot Option 2) matches:

- the top bar with per-team progress;
- the hexagonal TITAN % gauge bottom left above INTEGRITY, turning into `E CALL TITAN` when full;
- the tactical chip with charge pips just off the crosshair;
- BATTERY CARRIED;
- the radial rip progress (`rodeo-rip`);
- the plain rodeo context chip (from Option 1);
- the anti-titan chip with its lock ring above the stock weapon card.

The keys follow `docs/titanfall.md` §8.3: E calls the titan, not U.

**Titan HUD** (`desktop-titan*.png` against hud-titan Option 2, now over WP5's 3D cockpit) matches:

- the health arc under the reticle, with blue shield over the green hull;
- the CORE radial tile top right, with its `V` chip;
- dash chevrons on the left;
- the Q/E/G tiles with radial cooldown bottom right;
- the weapon panel top left;
- DOOMED with the eject count;
- the angled cockpit frame (WP5's 3D overlay; no CSS struts on top).

**Loadout** (`*-dead.png` against loadout.png, with the corrections) matches:

- the title and team/mode line;
- RESPAWN IN;
- the PILOT column (primary / anti-titan / tactical plus a description);
- five live-rendered titan cards;
- the kit strip with data-driven frame labels ("ATLAS · BALANCED FRAME");
- the DEPLOY button;
- on mobile, a vertical scroll stack.

## iter6 (review round 2)

`iter6/` adds three fixtures at all three sizes (15 states with `rodeo-rip` and `dead`, all clean):

- `rodeo-doomed`: riding a doomed enemy titan shows `JUMP OFF · TITAN DOOMED` instead of a RIP prompt the server would refuse;
- `battery-far`: a battery carrier 2.5 m from a friendly titan's back (insert reach 2.2 m) sees `BATTERY · MOVE CLOSER` with no key chip, and T is not claimed;
- `loadout-live`: the loadout opened while alive reads `MILITIA · APPLIES NEXT DEPLOY`, because the server equips a pick only at the next respawn.

## Remaining differences (known)

- **Cockpit panels:** on desktop, the weapon, DASH, CORE and DOOMED tiles sit over WP5's side frame and windows, and the kill feed crosses the right amber lamp bar. They stay readable on the dark frame.
- **Eject:** the reference shows `HOLD X EJECT`. The spec (§3.7) uses a triple press, so the panel reads `PRESS 1/3 EJECT`.
- **Titan camo:** the card portraits use the team camo (militia green). The reference shows mixed camo per card.
- **Weapon art:** iter1–iter3 used stand-in icons for WP4's new weapons, and the charge rifle showed a broken image in the stock ammo card. In iter4 WP4's own `assets/weapons/hud/{kraber,chargerifle,archer,thunderbolt}.png` are in, `LOADOUT_ICON_FILES` maps each id to its own picture, and the capture reports no warnings.
- **Live match:** these captures come from the fixture page with rendered backdrops, not from a live match.
- **Backdrop scene:** the pilot backdrop is WP5's flat test field with one LEGION. On phone portrait the titan stands right behind the crosshair.
