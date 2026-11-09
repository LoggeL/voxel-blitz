# KV-9 VANGUARD

Slot 21 `vanguard`, Blender asset VANGUARD (`vanguard`), accent steel blue `#9fd0ff`.

A semi-auto precision battle rifle (DMR): three taps down torso at mid range, two headshots to
kill, and `hmg` vehicle class — light hulls take full damage, aircraft 60%, heavies are scratched.
It fills the 40–120 m dead zone between the VK-77 RAPTOR and the LONGSHOT, and carries its own
vehicle tax without an Engineer gadget.

## Rules

Canonical values live in `WEAPONS.vanguard` (`shared/combatmath.js`). Viewmodel feel is in
`TIMERS.vanguard` (`public/js/guns/defs.js`); hands in `HANDS.vanguard` (`shared/avatar-hands.js`);
sight in `SIGHT_HEIGHT.vanguard` (`shared/player-hitboxes.js`).

- **Tap:** semi-auto, 255 rpm, 20-round magazine, 5 spare mags. Body damage 48 (×0.8 applied),
  36 at 85 m; headshots ×2.0.
- **Vehicle tax:** `damageClass: 'hmg'` — light ×1.0, heavy ×0.03, air ×0.6, medium ×0.3
  (`shared/vehicle-armor.js`).
- **Optic:** LPVO 1.6×, ADS 0.18 s, ADS spread 0.12°; hip 1.6°.
- **Scale:** 4.6 kg, handling 52 (mid-weight flank mobility).
- **Issue:** Assault variant 1 in Conquest (`shared/conquest-contract.js`); free in every roster
  (no `gadgetOnly`).
