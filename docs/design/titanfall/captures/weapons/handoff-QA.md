# Titan primary sound and feel capture QA

The sound and feel pass retains [cockpit A](../../cockpit/cockpit-a-reference.jpg) and
[titan HUD option 2](../../hud-titan.png), the existing selected ImageGen references. The armoured
window, instrument displays, amber reticle and hull arc still follow those references. This pass
adds the destruction confirmation to the existing glass display and verifies charge/spin states.

The muted CDP capture helper produced 90 screenshots, with one browser and one capture slot held
at a time. It steps the simulation clock explicitly rather than waiting for animation frames.

| Folder | Captures | Coverage |
|---|---|---|
| [handoff](handoff/capture-report.json) | 72 | All five primaries, ION split and Railgun tap, idle/fire pairs, cockpit/chase |
| [handoff-readouts](handoff-readouts/capture-report.json) | 12 | Railgun charge/ready and Predator spin/ready at 50/100 |
| [handoff-confirms](handoff-confirms/capture-report.json) | 6 | Own doom and destruction confirmations |

Each set covers desktop 1920×1080, mobile landscape 844×390 and portrait 390×844. Reviewed samples
include the desktop Railgun discharge, portrait Predator fire, landscape T-203 chase view, portrait
Railgun charge, landscape Predator ready state, desktop doom and portrait destruction confirmation.
The compact portrait readouts and confirmation label remain inside the window and leave the aim
point visible. Muzzle colour, beam/tracer differences and the expanded shot reticle are visible in
the fire fixtures. The deterministic spring, recovery, FOV and held-shake behavior are also checked
by `tools/titanfall-weapon-feel-test.mjs`.

These are presentation fixtures with server-shaped events and authoritative mount-row fields,
not recordings of a live network match. No audio was played. Chromium's real OfflineAudioContext
decoded all 58 selected Opus files separately; Gemini heard the exact encoded files through the
audio judging helper. Scores and the remaining Predator spin-down exception are in
[the judging report](../../../../audio/titan-weapons-judging.md).
