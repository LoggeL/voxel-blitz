# Conquest v2 HUD: design references and prompts

Work package WP7 of the Conquest "Frontier" redesign (spec §2 F5–F6, §7). This page covers the objective HUD, the deploy screen, the world markers, the vehicle HUD and reticles, and the touch layout.

## References used

No ImageGen tool was available in the WP7 sessions (2026-10-07). Following spec §0.8, the HUD was designed from the existing references instead of new generated alternatives:

| Reference | What we took from it |
|---|---|
| `docs/design/conquest/hud-alternatives.png`, **Option 2 / Immersive Command** (chosen) | A wide top panel with ticket counts and progress bars on both sides of the flag diamonds. A circular minimap at the bottom left with a compass ring. The vehicle readout above the weapon card. A context prompt just below the centre. |
| `docs/design/conquest/aircraft/hud-alternatives.png`, **Alt 2 / detailed flight instruments** | The jet speed and altitude readouts, rebuilt as moving tapes on both sides of the gun funnel. A boxed hull readout. The amber-on-charcoal instrument style. |
| `docs/design/conquest/aircraft/hud-alternatives.png`, **Alt 3 / mobile portrait** | Large rounded touch buttons with amber borders for the flight controls, reused for the SEAT, FLARES/SMOKE, MAP, SPOT and DEPLOY buttons. |

The implementation departs from the references in these places:

- **Team-relative colours.** The references colour teams as ALPHA blue and BRAVO red. The implementation always shows your own team in blue `#4cc3ff` on the left and the enemy in orange `#ff8a3d` on the right, with neutral `#d8d8d8`. The labels are the display names WEST and EAST. An EAST player sees EAST in blue on the left.
- **Five chips.** The references show three flag diamonds. Frontier v2 has five flags (A–E). Each chip is a filled square tinted by its owner. A fill bar shows control toward the leaning side, and a yellow hatch marks a contested flag.
- **Bleed and clock.** Each ticket side shows `▼ 1/3s` while that team loses tickets to bleed. The time left (`endsAt`) sits under the chips.
- **No permanent keybind line.** Aircraft Alt 1 has a `W/S MOVE … T EXIT` strip, which is dropped (spec §2 F6). The full-map and spot keys show as a short onboarding caption above the minimap on desktop only; it disappears after 30 s in the match or once the player has used M or Y. Seat keys F1–F5 appear only in the seat strip.
- **Prompt key.** The references show `X ENTER JEEP`. The real Interact key is T (X is prone, and X is also the vehicle countermeasure). The prompt reads the live binding.

## Layout implemented (desktop 1440×900)

- **Top centre:** own ticket bar · 5 chips plus clock · enemy ticket bar. The objective banner sits under it.
- **Centre:** the capture ring (letter, state label, `own vs enemy`) 70 px below the crosshair. The score ticker, the revive/repair hold ring and the interact prompt are below the ring. The lock warning sits above the crosshair with a bearing arrow around it.
- **World layer:** flag diamonds with a progress arc, the distance, and an edge arrow when clamped to the screen edge. Squad names are green, team dots blue, downed crosses red within 40 m, and spotted enemies red diamonds.
- **Bottom left:** a 184 px circular heading-up minimap with N/E/S/W riding the rim.
- **Bottom right:** the infantry weapon card. In a vehicle it is replaced by the vehicle panel: seat strip, hull silhouette with zone flash, HP bar, badges, weapon rows with ammo/heat/reload, and a countermeasure pip.
- **Overlays:** the full map (M), the deploy screen while dead, and the out-of-bounds/restricted countdown.

On touch (390×844 and 844×390), the minimap shrinks to 104 px and moves to the top left under the top bar. That keeps the bottom corners for the move stick and the fire cluster. The capture ring, ticker and interact prompt stack below the centre. The vehicle panel compacts to a narrow card above the right cluster. The deploy screen stacks map, spawn list and kits, and the touch DEPLOY button replaces the panel button.

## Prompts for a later ImageGen pass

These are the exact briefs. Keep any images that pass produces in this folder next to this file.

### Prompt A: deploy screen

Use case: ui-mockup. Asset type: VOXEL BLITZ Conquest deploy screen design reference. Primary request: one wide image with three clearly separate alternatives of a deploy screen shown while the player is dead, each with a desktop 16:9 layout and a small phone-portrait inset. Existing identity: charcoal translucent panels, thin slate borders, condensed uppercase typography, own team blue #4cc3ff, enemy orange #ff8a3d, neutral grey, amber highlight for the current selection, blocky voxel river-valley battlefield dimmed behind. Every alternative contains: a north-up map of a 768×768 battlefield with five flags A–E (A and B blue, C neutral, D and E orange), two HQ squares, selectable spawn markers (HQ, held flags, two squadmates, a tank with two free seats, a helicopter with one free seat), one refused spawn greyed with the reason "FLAG IS CONTESTED"; a spawn list; four kit cards ASSAULT, ENGINEER, SUPPORT, RECON, each with two primary weapon variants and its gadget and grenades; a killer card "KILLED BY ROURKE · 120MM AP · 142 M"; a large DEPLOY button with a 3.2 s countdown. Alternative one: map left, kits right. Alternative two: full-height map with a floating kit drawer. Alternative three: spawn list first with a small map. Practical HTML/CSS, readable at phone size. No chat, no fictional currencies, no real game branding.

### Prompt B: capture ring and world markers

Use case: ui-mockup. Asset type: VOXEL BLITZ Conquest objective readability reference. Primary request: one wide image with three alternatives for the in-world objective layer of a first-person voxel shooter, each a desktop crop around the crosshair plus a screen-edge strip. Show: a capture ring under the crosshair with the flag letter, a circular progress arc, the label CAPTURING and the count "3 vs 1"; variants for NEUTRALIZING, CONTESTED (yellow hatch), DEFENDING; diamond flag markers floating over distant flags with the letter, the distance in metres and an arc of capture progress, one marker clamped to the screen edge with a direction arrow; green squadmate name tags, small blue teammate dots, a red cross over a downed teammate 18 m away, red diamonds over two spotted enemies and a spotted enemy tank; a stacking score ticker "+100 KILL / +50 ATTACKER KILL". Own team blue #4cc3ff, enemy orange #ff8a3d, neutral grey #d8d8d8, spotted red. Thin dark outlines so markers read over bright sky and dark voxel ground. No text beyond the labels named here.

### Prompt C: vehicle reticles

Use case: ui-mockup. Asset type: VOXEL BLITZ Conquest vehicle reticle sheet. Primary request: one wide sheet with six panels, each a cropped first-person or chase view over a blocky voxel battlefield with the seat reticle drawn as thin outlined vector strokes: (1) tank gunner: dashed desired-aim circle at the centre, a separate barrel-impact cross where the gun actually points, an amber reload arc filling clockwise, label "120MM AP · LOADING"; (2) attack-helicopter pilot: rocket pip with side ticks at 120 m convergence and "9 RKT · 120 M"; (3) chin gunner: crosshair plus a gimbal box below showing the gun's yaw/pitch envelope with the current pointing dot and a heat bar; (4) transport door gunner: small ring crosshair and an arc bracket showing the traverse window with an end-stop turning red "ARC LIMIT"; (5) jet: green boresight cross, curved gun-funnel walls, an amber lead pipper ahead of a crossing enemy helicopter with range "262 M", a red target box, speed tape left "331 KM/H", altitude tape right "140 ALT M"; (6) incoming lock: "MISSILE INBOUND · 158 M" banner and a red bearing arrow around the crosshair. Amber #ffcf5c, white, red #ff4b4b, green #7ef29a, team blue #4cc3ff. No cockpit interiors, no real aircraft branding.

## Verification

The static capture page `public/conquest-hud-capture.html` renders every fixture state from `public/js/capture/conquest-hud-fixtures.js`. It uses the real `ConquestHud`, kill feed, scoreboard, result overlay and touch controls, with no WebGL, audio or server. Captures and the mobile bounding-box overlap check run in the serialized capture phase:

```
node tools/conquest-hud-capture.mjs --out docs/design/conquest/redesign/captures/hud
```

It writes `<size>-<state>.png` for desktop 1440×900 (window 1440×1037), portrait 390×844 and landscape 844×390, plus `capture-report.json`. It exits 1 on any browser error, or when the minimap, vehicle panel, capture ring, interact prompt and visible touch buttons overlap on a touch layout. Comparison notes against Option 2 and aircraft Alt 2 are in `docs/design/conquest/redesign/captures/comparison.md`.
