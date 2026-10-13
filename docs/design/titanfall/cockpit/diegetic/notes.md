# Diegetic titan cockpit HUD

Request: "put all the HUD elements into the cockpit". In the first-person titan cockpit, the HUD lives inside the cabin (Titanfall 2 style). No flat DOM panels sit over the cockpit. Spec: `docs/titanfall.md` §7.2 (Diegetic HUD). Code: `public/js/titanfall/titan-cockpit-hud.js`.

## Concepts (ImageGen, gpt-image-2, 1536x1024)

| | Concept | Idea |
|---|---|---|
| A | `concept-a.png` | Holographic glass cluster around the reticle, LED score strip on the brow, kill feed on the right pillar, big console screens. |
| B | `concept-b.png` | Everything on one wide console strip under the viewport. |
| C | `concept-c.png` | **Chosen.** Armoured corner pods on the four diagonal struts, a brow score display and a right-pillar kill feed screen. |

Prompts are next to each image (`*.prompt.txt`).

**Why C.** The corner pods sit on struts that every frame class already has (ATLAS, OGRE, STRYDER). They stay out of the 38–44 % viewport and read at a glance. B puts everything under the viewport, where landscape touch buttons and the console MFDs already sit, and it reads poorly at 21:9. From A we kept only the glass cluster around the reticle: dash chevrons on the left, ammo on the right, the hull/shield arc under it and a projected alert line at the top.

## What moved where

| DOM HUD element | Cockpit location |
|---|---|
| Crosshair, spread gap, hit markers (body / head / armour / kill) | Glass, at the aim point |
| Hull, shield, doom countdown | Glass arc under the reticle, plus the lower-left pod |
| Ammo, magazine, reload, charge / heat / spin | Glass column right of the reticle, plus the upper-left weapon pod |
| Dash pips + key | Glass chevrons left of the reticle, plus the lower-left pod |
| Defensive / tactical / ordnance cooldowns + keys, smoke | Lower-right pod (rebinding-aware key chips) |
| Core % / ready / active + key | Upper-right pod, plus the glass cue "CORE READY · V" |
| Level badge | Upper-right pod |
| Lock warnings (locking, locked, missile) | Glass above the reticle; a missile goes to the alert line |
| Rodeo, battery stolen, out of bounds, toasts, ability ready | Glass alert line (priority: missile > rider > battery > OOB > toast > ability ready) |
| Eject prompt (triple tap) | Glass doom block, plus the lower-left pod |
| Score bar, limit, timer | Brow display |
| Kill feed | Right-pillar screen (newest first, 6 rows) |
| Minimap / radar | Existing console MFD (radar and core) |

These stay DOM: touch buttons, escape, settings, the scoreboard, and every HUD outside the cockpit (chase, on foot, embark/eject, spectate, sight).

**Phone portrait.** The pods and the feed screen go dark, because the cabin is squeezed there. The touch buttons carry the abilities and smoke, and the brow carries the score. The glass adds CORE % and the newest kill feed row, and puts hull and shield on one line.

**Phone landscape.** The glass alert line and doom block move down under the lower brow strut.

## Data flow

- `titan-ui.js` computes `titanHudModel` as before. It now also calls `publishCockpitHud(model, keys)`.
- The cockpit (`titan-cockpit.js` → `createCockpitHud`) draws that model if it is fresh: under 600 ms old, `layout === 'titan'` and the same hull type. Otherwise it draws its own `titanModel(row)`.
- Crosshair position and gap, hit marker, kill feed rows and badge are read from the stock DOM (`#crosshair`, `#hitmarker`, `#killfeed`, `.vb-career-badge`). Element refs are refreshed at 1 Hz, and the feed is parsed only when it changes.
- `body[data-titanfall-cockpit]` is set by `titan-ui.js` when all of these hold: titan layout, the vehicle view's local view is the own titan, not the sight, and the glass drew in the last 400 ms (`cockpitHudLive`). `titanfall.css` hides `.tf-titan`, `.tf-top`, `.tf-banner` and the stock crosshair, hit marker, kill feed and badge only under that flag.

## Budget

| | |
|---|---|
| Draws | 11 per cockpit: 7 cabin + pods, brow, feed, glass (budget test: ≤ 11) |
| Triangles | HUD adds ~600 (pods 392, brow 110, feed 98, glass 2); total 7.7–8.6 k |
| Textures | Pod atlas 1024×528, panel atlas 1024×592, glass canvas sized to the buffer (660×570 layout units × unit, about 710×620 px at 1080p) |
| Redraws | Pods ≤ 15 Hz, brow ≤ 4 Hz, glass ≤ 20 Hz (hit markers and danger blinks immediately), feed on change. Each region redraws only when its values change, and textures upload only then. |
| Allocation | No per-frame allocation in steady state. Signatures are reused arrays, fonts are cached, and the glass canvas is rebuilt only on a buffer resize. |
| Programs | `COCKPIT_HUD_WARMUP_MATERIALS` are part of `TITAN_COCKPIT_WARMUP_MATERIALS`, so they are warmed with the titan FX. |
| Console MFDs | 6 → 12 Hz (gauges ≥ 10 Hz). |

## Captures

`tools/titanfall-cockpit-capture.mjs --diegetic` (muted CDP) stages each state with `public/js/capture/titan-cockpit-hud-capture.js`. The states are idle, firing, doom, core, cooldown, rodeo and feed.

- `captures/`: ION at desktop 1920×1080, ultrawide 2560×1080, small 1280×720, portrait 390×844 and landscape 844×390, at FOV 65 and 100, in all 7 states. `*-composite-ion-*` adds the real DOM layer with the cockpit flag set: the touch buttons on phones, nothing else.
- `captures/titans/`: SCORCH, NORTHSTAR, RONIN and LEGION at FOV 100, every size and state.
- The full matrix (5 titans × 5 sizes × 2 FOV × 7 states + composites, 385 shots) was checked in iteration 5 and kept out of the repo. The PNGs here are quantized to 256 colours.

## Iterations

1. The glass canvas never resized to the buffer, and the pods were stretched. Fix: resize in `onBeforeRender`, and tilt the pods to face the eye.
2. The hull arc hid under the lower hazard band, and the pods were too large. Fix: raise the arc and shrink the pods (0.29 width).
3. All sizes: the arc caps were round, the portrait core line was hidden and landscape text was small. Fix: butt caps, glass layout in CSS px with a text scale up to 1.3 on small screens.
4. Alerts were clipped on OGRE (low brow) and the portrait score line was hidden. Fix: lower alert line and a portrait shift.
5. Full matrix (385 shots). Found three problems. In portrait, DOOMED was clipped under the OGRE brow and the shield line was hidden under the lower strut. Phone landscape clipped the alert line and the doom header. Portrait showed no kill feed.
6. Fix: portrait and phone-landscape doom blocks are compact (the core line yields to them), the phone-landscape alert line moved down, hull and shield share a line in portrait, and the newest feed row rides the top of the portrait glass in place of the score line, which duplicated the brow. Phone sizes were re-captured.

## Open issues

- The glass under bloom and the post chain has not been checked in a live match. It renders with `toneMapped: false` in the cockpit depth slice, and the captures use the capture page's renderer.
- Phone landscape: the touch buttons cover the lower pods and the console MFDs (the capture tool reports the overlaps). Glass values stay visible.
- Pod text is small at 844×390, though the glass carries the same values larger.
- The kill feed screen has no team colours, because the stock rows carry none.
- The radar MFD shows no blips.
- Crosshair, hit marker, kill feed and badge are read from the stock DOM, not from a model.
