FINAL DESIGN: QUICK-DRAW POUCH (with grafts from Bandolier, Three Pockets and Pin & Pitch)

Pitch: you always have one ready grenade, and it is always one you actually own. Tap G to throw it straight away at a useful range. Hold G to aim with a live arc and a landing zone sized to the blast. Scroll to set the range and press R to put the pin back. To change grenade, tap H for the next one you own, or hold H to open a small five-slot pouch at the crosshair and flick toward the one you want. Nothing can change while a grenade is in your hand, and empty types can never be picked.

Where I departed from the judges:
- **Power model: Pouch.** Power comes from remembered steps, not from how long you hold. That separates frag range from frag cook, which none of the other designs fix.
- **Pad layout: Bandolier.** The pouch goes on the D-pad-down tap/hold. LB stays as last weapon with no added delay.
- **Cut** because they add mid-hold modifiers or new failure modes: RMB lob, LMB throw-now, LT cancel, loadout pockets, throw styles and the wire additions.

======================================================================
1. CONTROLS
======================================================================

KEYBOARD / MOUSE (keybindings.js; action ids are kept so saved `vb-keybindings-v1` and account prefs need no migration)

- **`grenade` (KeyG)**, relabel to "Throw ready grenade (tap / hold to aim)".
  - Tap (released within GRENADE_TAP_MS=170): quick throw of the ready type at that type's remembered power (default 0.6). Cook is 0.
  - Hold: draw the grenade, show the arc and landing zone, pin pulls at GRENADE_PIN_MS=240. Release throws.
  - The type is locked at key-down. Nothing can change it until the throw or a cancel.
- **While G is held:**
  - Mouse wheel steps power through GRENADE_POWER_STEPS [0.2 LOB, 0.4, 0.6, 0.8, 1.0], up = farther. The step is remembered per type for the session. The wheel never switches weapons or types during a hold.
  - `reload` (R) or the new `grenadeCancel` (default unbound) = PIN BACK. Nothing is thrown or spent, the cook resets, and the hands play a re-pin.
  - The swallowed R must not queue a reload.
  - LMB and RMB do nothing. They are already blocked by grenadeHandling, as today.
- **`grenadeType` (KeyH)**, relabel to "Grenade pouch (tap: next / hold: pouch)".
  - Tap (released within GRENADE_POUCH_HOLD_MS=200): ready the next STOCKED type in GRENADE_TYPE_IDS order, wrapping. If nothing else is stocked, the card shakes.
  - Hold (200 ms or longer): opens the pouch radial.
    - Mouse movement steers `_wheelVecX/Y`; the camera does not turn. The scroll wheel steps through the slots.
    - Releasing H readies the hovered stocked slot.
    - Pressing G while the pouch is open readies the slot AND starts the hold, so flick-then-G is one gesture.
    - Esc or RMB closes the pouch without a change.
    - The pointer can never select an empty slot; it snaps to the nearest stocked one.
  - H presses are ignored while G is held.
- **`grenadePrevious`** (new, unbound): ready the previous stocked type.
- **`grenadeFrag`, `grenadeClaymore`, `grenadePulse`, `grenadeMolotov`, `grenadeSmoke`** (new, unbound, listed in settings): ready that type and begin the hold in one press (tap = quick throw). They are ignored if that type is empty, which gives the dry-click feedback.
  - Default keys stay unbound on purpose. Digits belong to the weapon slots, KeyZ is zoom, and keyCodeLabel shows the physical code, so KeyY would be labelled "Y" on the key printed Z on QWERTZ.
- **Weapon wheel** (K / MMB): opening it mid-hold still cancels, now through `cancelGrenade('wheel')`. The pouch and the weapon wheel are mutually exclusive.
- **Build mode (Bastion):** `setBuildMode(true)` cancels the hold and closes the pouch. G, H and the quick keys are ignored while build mode is on.

GAMEPAD (gamepad.js PAD_BUTTONS; the indices do not change, only the meanings)

- **RB (5) `grenade`:** tap = quick throw, hold = aim, release = throw.
- **While RB is held:**
  - D-pad up (12) / D-pad down (13): power step up / down.
  - X (2, reload): PIN BACK.
  - Y, LB, LT and RT: no grenade meaning.
- **Y (3):** weapons only. Delete the "cycles the throwable while RB is held" branches (input.js poll around 621-632 and the release branch around 645). Tap swaps weapon; holding for PAD_WHEEL_HOLD_MS (260) opens the weapon wheel.
- **D-pad down (13)**, when no grenade is held and the weapon wheel is closed:
  - Tap: next stocked grenade.
  - Hold for PAD_WHEEL_HOLD_MS: opens the pouch. The right stick feeds `_wheelVecX/Y`, using the same code path as input.js:668-674.
  - Release: ready the hovered slot. RB while the pouch is open readies it and begins the hold. B closes it.
  - Losing slotDown costs almost nothing: it was a duplicate of the Y tap (both do `_switchQueue += 1`), and D-pad up still steps backwards. While the weapon wheel is open, D-pad down still steps the wheel.
- **LB (4):** stays `lastWeapon`, with no added delay.
- **Pad disconnect:** cancel (pin back), as today.
- **Rename the key** `slotDown: 13` to `grenadePouch: 13` in PAD_BUTTONS and update the comments.

TOUCH (touch-controls.js)

- **New `grenade` button** above reload. Its face shows the ready type's icon and count.
  - Tap = quick throw. Press and hold = aim; lifting throws.
  - While held, two things appear:
    - A vertical 5-chip power strip beside the button. The other thumb taps a stop to set power; there is no drag-to-dial.
    - A red "PIN BACK" chip. Sliding the grenade thumb onto it and lifting cancels.
- **New `pouch` button**, a small bag. Tapping it opens the pouch full-size at screen centre; tap a slot to ready it, or tap outside to close. There are no hidden long-presses.
- **Visibility:** both buttons show only when `context.canThrow && context.grenadeTotal > 0`, and they hide while the wheel or pouch is open (except the pouch's own slots).

======================================================================
2. HUD
======================================================================

A) READY CARD. It replaces the chip strip, keeps the element id `#grenade-count` and the same anchor left of #ammo, and stays a sibling of #ammo because of the clip-path.

```
┌──────────────────────────────────┐
│ [G]  (icon 28px)  M-4 FRAG   ×2  │  name 11px, count 16px mono
│      ● ● ○ ● ●   [H] POUCH       │  5 fixed-order pouch dots: lit = stocked,
└──────────────────────────────────┘  ring = ready; role-tinted
```

- Icons come from one `GRENADE_HUD_ICONS` map in hud-support.js: frag.png, limpet.svg, pulse.png, molotov.png, smoke.svg. buy-menu.js:156 and the killfeed also use this map, which replaces the '◆' in combat-hud.js:141-157.
- Key badges use `bindingLabel('grenade')` / `bindingLabel('grenadeType')`, or pad glyphs 'RB' / 'D▼'.
- Delete the hardcoded 'G' / 'H · SWITCH' / 'RB + Y · SWITCH' block in hud.js `setDeviceInfo` (lines 99-109). It becomes `this.gameplay.setDeviceLabels(device)`, which works out the labels from bindings or the pad.
- States:
  - `.is-charging`, `.is-cooking` and `.is-critical` keep their names so the contracts migrate easily.
  - `.is-empty-pouch`: dimmed card reading "POUCH EMPTY".
  - `.is-denied`: a 150 ms shake when G is pressed with nothing stocked or during the cooldown.
  - `.is-advanced`: the new icon slides in from the right with a 180 ms "NEXT · M-18 SMOKE" flash.
  - `.is-thrown`: a 120 ms pop when the authoritative count drops.
- The pouch dots are tinted by the new `role` field (lethal = amber, tactical = cyan, gadget = red). This takes the Three Pockets role grouping for the HUD only.
- Touch: remove `#grenade-count{display:none}` (touch-controls.css:117) and add a compact variant showing icon plus count only.

B) READIED TAG (from Bandolier), `#grenade-readied`. A 14px icon plus count, 30px below the crosshair.
- It fades in for 1.2 s whenever the ready type changes (H tap, pouch, auto-advance, quick key, pickup or respawn), and stays visible while G is held.
- On auto-advance it shows "→ SMOKE"; on pin back it shows a grey "PIN BACK" pulse.

C) POUCH RADIAL, `#grenade-pouch` (new public/js/ui/grenade-pouch.js). Body-level, about 240px on desktop and 200px on mobile, centred on the crosshair.
- 5 wedges at `wheelAngleForSlot(i, 5)` in GRENADE_TYPE_IDS order: frag at the top, then clockwise claymore, pulse, molotov, smoke. The angles are fixed so muscle memory builds.
- Each wedge shows its icon, count and the quick-key label if one is bound.
- Empty wedges are at 25% opacity, hatched, and cannot be picked. The hovered wedge scales to 1.08 in the type colour. The current ready type has an outer tick.
- The centre shows the name plus one role line generated from GRENADE_TYPES: cook/fuseMs, impact, damageRadius or the effect radius (e.g. "Timed fuse · cookable · 7.5 m blast"). Nothing is hand-written.
- The game keeps running while it is open. Fire is blocked, the same as the weapon wheel today.

D) AIM RETICLE, `#grenade-aim`, near the crosshair and only while a grenade is held. It replaces the shared 2px bar.
- POWER: a 5-notch arc to the lower left of the crosshair; the lit notch is the current step, and the 0.2 step reads "LOB".
- FUSE (only for cook types): a ring to the lower right that drains from the pin pull, with "1.8s" beside it. It gets `.is-critical` at 70% or more.
- Hint line, 10px, generated from bindingLabel: "RELEASE · THROW   SCROLL · RANGE   R · PIN BACK". The pad version reads "D↕ · RANGE   X · PIN BACK".
- Claymore: no power arc. It shows a bracket "[ MOUNT ]" in green when placement is valid, and "[ NO WALL · 2.2m ]" in grey when it is not.
- The Ready Card keeps a thin `.vb-grenade-charge` mirror bar for peripheral vision. It shows power, or the fuse for frag.

E) WORLD PREVIEW (ProjectileFX.setPreview, projectiles.js:229-264 and 735-778)
- The landing marker becomes a unit ring plus a translucent disc, scaled to `grenadeEffectRadius(typeId, chaosLevel)`.
- Bounce dots, from a pool of 8, at the new `bounces` output of predictGrenadePath.
- A second copy of the line with depthTest:false at 0.25 opacity, so the arc reads through walls.
- For cook types, the last segment is dimmed and dotted when `rests` is false, meaning it would explode in mid-air.
- The claymore ghost is unchanged.

F) SOUND (sfx.js, synthesized first). Each item is mapped through the `rig.onGrenadeCue` hook in main.js:326-330.

| New sound | When it plays |
| --- | --- |
| `grenadeEmpty` (dry click) | Denied press |
| `grenadeReady` (soft spoon click) | 'ready' cue |
| `grenadePinBack` | 'cancel' cue |
| `grenadeFuseTick` | 'cook' tick every 500 ms while cooking, every 250 ms under 800 ms left |
| `claymoreClamp` | Replaces `sfx.grenadeDraw` on placement (main.js:644) |

Quick-tap cue spacing (from Pin & Pitch): the pin sound plays at once and the whoosh is delayed about 70 ms, so the two no longer land in the same frame.

======================================================================
3. RULE CHANGES: shared/grenade-rules.js (authoritative, used by client and server)
======================================================================

GRENADE_TYPE_IDS order, perLife, freshGrenadeLoadout and all clamps are UNCHANGED.

New exports:

```js
export const GRENADE_TAP_MS = 170;
export const GRENADE_PIN_MS = 240;            // == THROWABLE_TIMING.arm*1000; throwable-hands imports it
export const GRENADE_POUCH_HOLD_MS = 200;
export const GRENADE_POWER_STEPS = Object.freeze([0.2, 0.4, 0.6, 0.8, 1.0]);
export const GRENADE_DEFAULT_POWER_INDEX = 2; // 0.6
export const GRENADE_THROW_COOLDOWN_MS = 450; // authority minimum interval between throws
export const GRENADE_ROLES = Object.freeze({ frag:'lethal', molotov:'lethal', pulse:'tactical', smoke:'tactical', limpet:'gadget' });

export function grenadeCookFromHold(heldMs, type)   // type.cook ? max(0, heldMs - GRENADE_PIN_MS) : 0
export function grenadePowerAt(index)               // GRENADE_POWER_STEPS[clamp(index)]
export function nextStockedGrenade(counts, from, dir = 1) // next index with count>0 (wrapping, excludes `from`), else -1
export function autoReadyGrenade(counts, current, preferred)
  // 1) current if stocked; 2) preferred (last manual pick) if stocked;
  // 3) first stocked type with the same GRENADE_ROLES role as current (TTT frag→molotov);
  // 4) first stocked in GRENADE_TYPE_IDS order (smoke is last, so the Bastion armory pick wins); else -1
export function grenadeEffectRadius(typeId, chaosLevel = 0)
  // frag/pulse/limpet: damageRadius; molotov: molotovFireProfile(level).radius (shared/molotov-rules.js);
  // smoke: smokeProfile(level).radius (shared/smoke-rules.js). No import cycle (neither imports grenade-rules).
```

- `predictGrenadePath` also returns `bounces: [[x,y,z], ...]`. A point is recorded whenever `stepGrenade` reports `hitSolid` without stopping. The existing return keys stay the same, and the server does not call it.
- Fix the stale header comment (five types, no sticky limpet).
- GRENADE_CHARGE_MS stays exported. It is still used for the hands' wind-up timing, but the input no longer reads it for power.

Semantics that change inside existing wire fields (client-chosen):
- **`grenadeCharge`** = `grenadePowerAt(powerIndex[type])`, on a tap and on a hold alike. The server already takes any clamped 0..1, so speed and lift use the unchanged grenadeThrowProfile.
- **`grenadeCook`** = `grenadeCookFromHold(heldMs, type)`.
  - Cooked frags now effectively last 240 ms longer. This is intended, so the fuse matches the visible pin; note it in the patch notes.
  - The forced release happens at `cook >= fuseMs`, i.e. held for 240 + 2600 ms. The server still detonates in the hand when `cook >= fuseMs`.
- **Types the player has none of are never sent**, and neither are cancels. A cancel only drops grenadeHandling, like today's wheel-cancel path.
- **Claymore released without a valid wall:** treated as a pin back on the client. No packet is sent, the rig does not throw, and "NO WALL" is shown. This removes the client/server placement mismatch.
- **Type lock for the whole hold**, which removes the cross-type cook-carry detonation bug.

Authority, the only server change (small, no wire change). In server/sim/projectiles.js `step()` (around lines 163-184), after the count check:

```js
if (ctx.now < (player.nextThrowAt || 0)) continue;  // dropped, nothing spent
... throw/detonateInHand ...
player.nextThrowAt = ctx.now + GRENADE_THROW_COOLDOWN_MS;
```

- Initialise `this.nextThrowAt = 0` in PlayerEntity.spawn, next to the queued fields at server/sim/player.js:150-156, and reset it in takeoverBot (server/game.js:331-336).
- The client mirrors the cooldown: a press within 450 ms of the last release is denied (card shake plus dry click), so the client never predicts a throw that the server will drop.

======================================================================
4. WIRE PROTOCOL
======================================================================

- **Input packet: no change.** It stays throwGrenade (rising edge), grenadeHandling, grenadeCharge 0..1, grenadeType int, grenadeCook ms and grenadeAim. netclient.js:530-539, server/game.js:394-454 and tools/lib/ws-client.mjs are all untouched.
- **Snapshot:** no change. PLAYER_KEYS (tools/lib/protocol-contract.mjs) is untouched.
- **Events:** no change.
- **Server:** only the `nextThrowAt` cooldown described above.

Phase 2, out of scope: a sanitized `grenadeHeldType` in the snapshot, for third-person models and the killcam.

======================================================================
5. FILE-BY-FILE CHANGES
======================================================================

1. **shared/grenade-rules.js**: the constants and helpers from section 3, the `bounces` return in predictGrenadePath, and the header comment fix.

2. **public/js/keybindings.js** (KEYBINDING_ACTIONS):
   - Relabel `grenade` and `grenadeType`.
   - Add `grenadeCancel`, `grenadePrevious`, `grenadeFrag`, `grenadeClaymore`, `grenadePulse`, `grenadeMolotov` and `grenadeSmoke`, all defaulting to [] with the gameplay context.
   - normalizeKeybindings already fills in defaults for new ids.

3. **public/js/engine/gamepad.js**: change `slotDown: 13` to `grenadePouch: 13` and update the comments for weapon (3) and grenade (5).

4. **public/js/engine/input.js**, grenade core (replaces 887-947):
   - State:
     - `_readyGrenade` (index, or -1);
     - `_preferredGrenade`;
     - `_grenadeCounts`;
     - `_grenadeHoldType`;
     - `_grenadePower = Array(5).fill(GRENADE_DEFAULT_POWER_INDEX)`;
     - `_lastGrenadeReleaseAt`;
     - `_grenadeUiEvents` (the queue of 'denied' / 'advanced' / 'cancel' / 'readied' events);
     - `_pouchOpen`, `_pouchSlot`, `_pouchKeyDownAt`, `_padPouchDownAt`.
   - `setGrenadeCounts(counts)`: main.js calls it every frame. It runs autoReadyGrenade and emits 'advanced' or 'readied'.
   - `_beginGrenadeHold(at, typeIndex = _readyGrenade)` returns false and emits 'denied' when the type has no stock, while build mode is on, or during the cooldown. Otherwise it locks `_grenadeHoldType`.
   - `_releaseGrenade(at)` queues `{charge: grenadePowerAt(_grenadePower[t]), cookMs: grenadeCookFromHold(held, type), type: t}`. It is the same for a tap and a hold, so the consumeGrenadeThrow contract is kept.
   - Other API:
     - `cancelGrenade(reason)`: pin back; clears the hold and queues nothing.
     - `selectGrenadeType(i, {manual})`: rejects empty types.
     - `cycleGrenadeType(dir)`: stocked types only, via nextStockedGrenade; ignored while a grenade is held.
     - `stepGrenadePower(dir)`.
     - `getGrenadePower()`, `getGrenadePowerIndex()`, `getGrenadeCookMs(now)`, `getGrenadeHoldType()`.
     - `isGrenadePouchOpen()`, `getGrenadePouchHover()`, `setGrenadePouchOpen(open, {confirm})`, `consumeGrenadeUiEvents()`.
   - `getGrenadeType()` returns the held type while a grenade is held and the ready type otherwise.
   - `forceGrenadeRelease` is unchanged; its caller now compares the cook.
   - Delete the silent cycle at 1169.

5. **input.js routing:**
   - `_onKeyDown`:
     - `grenade`: if the pouch is open, confirm and begin; otherwise begin.
     - `grenadeType`: start the tap/hold timer (the pouch opens in `poll` once 200 ms have passed).
     - The quick keys: select, then begin.
     - `grenadePrevious`.
     - `reload` / `grenadeCancel`: while a grenade is held, cancel and `break` before `_reloadQueued`.
     - `Escape`: closes the pouch.
   - `_onKeyUp`:
     - `grenadeType`: before 200 ms, cycleGrenadeType(+1); if the pouch is open, confirm.
     - The quick keys release like `grenade`, and only if they started the hold.
   - `_onMouseMove`: while the pouch is open, route the movement into `_wheelVecX/Y`.
   - `_onMouseDown`: while the pouch is open, LMB confirms and RMB closes.
   - `_onWheel`: pouch open steps the slot, a held grenade steps power, otherwise the weapon switch runs. Remove the cycleGrenadeType branch.
   - Pad `poll`:
     - Remove the Y grenade branches.
     - While RB is held, `pressed.slotUp`/`grenadePouch` step power and `pressed.reload` cancels. These run before the existing reload and slot handlers and suppress them.
     - Otherwise, the `grenadePouch` tap/hold split.
     - With the pouch open, the right stick feeds `_wheelVec` and RB confirms and begins.
   - Opening the weapon wheel closes the pouch and vice versa. `setWeaponWheelOpen(true)` calls `cancelGrenade('wheel')`.
   - `clearTransient`, `setBuildMode(true)` and pad disconnect call cancelGrenade and close the pouch.
   - `wantFireHeld` / `wantAdsHeld` return false while the pouch is open.
   - `_onTouchHold('grenade')` begins or releases.
   - `_onTouchPulse` handles 'grenadeCancel', 'grenadePower:<i>', 'pouch' and 'pouchSlot:<i>'.

6. **public/js/ui/grenade-pouch.js** (new): a `GrenadePouchController` modelled on the ui/weapon-wheel.js WeaponWheelController.
   - Methods: idempotent `ensure()`, `setState({open, hover, ready, counts, device, labels, chaos})` and `dispose()`.
   - It reuses `wheelAngleForSlot`, `wheelSlotFromVector` and `WHEEL_DEAD_ZONE` from ui/weapon-wheel.js with count 5, plus an empty-slot snap.
   - Touch: tapping a slot calls onPick.
   - Styles go in the new public/styles/grenade-pouch.css, linked the same way as the other styles in index.html.

7. **public/js/main.js:**
   - `presentGrenadeHandling` (598-646):
     - First call `input.setGrenadeCounts(selfRow.grenades)`.
     - Use `getGrenadeHoldType()` and `getGrenadeCookMs()` for cook01, cookLeft, the force-release (`cookMs >= type.fuseMs`) and the preview fuse (`grenadeFuseAfterCook(cookMs)`).
     - The preview charge becomes `getGrenadePower()`, and the preview carries `effectRadius`.
     - A claymore release with an invalid placement calls `input.cancelGrenade('noWall')` BEFORE the throw is consumed.
     - Handle the UI events (HUD flags and sfx).
     - Emit a 'cook' tick every 500 ms.
     - On a cancel, call `rig.cancelGrenade({reseat:true})`.
   - `selectedGrenadeCount` reads the held or ready type.
   - Construct GrenadePouchController next to `this.weaponWeaponWheel` (around line 97; the session controller lives in public/js/session/weapon-wheel-controller.js). Extend it or add a sibling session controller.
   - `isAuthoritativeFireAllowed` is false while the pouch is open.
   - `onGrenadeCue` (326-330) adds ready, cancel, clamp and cook.
   - HUD fields (around 907-913) add:
     - grenadeReady, grenadePower, grenadePowerIndex, grenadeCookLeftMs;
     - grenadePouchOpen, grenadePouchHover;
     - grenadeDenied, grenadeAdvancedTo, grenadeReadiedAt;
     - device labels.
   - `syncTouchContext` (652) adds `canThrow` and `grenadeTotal`, plus `pouchOpen` to hide the other buttons.

8. **public/js/player/local-player.js** (634-649): latch only if `(this.input.getGrenadeCount?.(t) ?? 1) > 0`, as a second defence behind input. There is no payload change.

9. **public/js/guns/throwable-hands.js:**
   - `THROWABLE_TIMING.arm = GRENADE_PIN_MS/1000`, imported instead of the hardcoded 0.24.
   - `setCharge` ignores a type change while held; keep it as a guard.
   - Cock-back is scaled by power.
   - At power 0.2 the swing is underhand: a lower, forward throw branch.
   - New `cancel({reseat})`, 0.22 s: the left hand returns the pin to its socket and the hands drop. It emits the 'cancel' cue.
   - Limpet: a 'clamp' plant with no pin reach and no 'pin' cue.
   - A quick-tap `throw()` emits pin at once and a 'throw' cue about 70 ms later, which drives the whoosh.
   - **public/js/guns/viewmodel.js**: `cancelGrenade(opts)` forwards the options, and `grenadeCharge` passes power.

10. **public/js/audio/sfx.js** (near 1007-1060): add grenadeEmpty, grenadeReady, grenadePinBack, grenadeFuseTick(rate) and claymoreClamp, synthesized.

11. **public/js/ui/gameplay-hud.js** (170-203 build, 283-287 relabel, 377-434 paint):
    - Build the Ready Card, `#grenade-readied` and `#grenade-aim`.
    - Add `setDeviceLabels(device)`.
    - Keep the `#grenade-count` data-type, `--nade`, is-charging/is-cooking/is-critical and `.vb-grenade-charge`.
    - **public/js/ui/hud.js** `setDeviceInfo` (99-109): delegate to `setDeviceLabels`.
    - **public/js/ui/hud-support.js**: add GRENADE_HUD_ICONS.
    - **combat-hud.js** (141-157): use the killfeed icon.
    - **buy-menu.js** (151-156): use GRENADE_HUD_ICONS and GRENADE_TYPE_IDS instead of the hardcoded ids and extensions.

12. **public/style.css**: replace 2375-2636, 3480, the mobile rules at 3920 and 4513. **public/styles/touch-controls.css**: drop the hide at :117; add the compact card, grenade and pouch buttons, the power strip and PIN BACK chip styles.

13. **public/js/weapons/projectiles.js** and **effects.js** (244-247, projectilePreview pass-through): the preview disc and ring scaled by effectRadius, the bounce-dot pool, the depthTest:false ghost line, and the dotted end when `!rests`.

14. **public/js/engine/touch-controls.js**:
    - Add 'grenade' and 'pouch' to TOUCH_ACTIONS.
    - visibleTouchActions: show both when `context.canThrow && context.grenadeTotal > 0`.
    - `_button` / `_bindHold` for grenade, with a PIN BACK chip hit-test on lift and the power-strip chips as pulses.
    - A pouch button pulse.
    - Use pointer capture as the fire button does.

15. **server/sim/projectiles.js** step, **server/sim/player.js** spawn and **server/game.js** takeoverBot: the `nextThrowAt` cooldown.

16. **Docs**: add a short docs/grenades.md (controls per device, the semantic changes, the cooldown). Update any 'H · SWITCH' mentions and the Bastion build-mode note in docs/pve-bastion.md.

Shared worktree: stage only these paths and never stash. public/js/guns/actions.js, weapon-capture* and blender-assets-browser-test.mjs are already modified by another session, so do not touch them.

======================================================================
6. TESTS
======================================================================

New (Node, added to `throwables:test` in package.json):
- **tools/grenade-pouch-rules-test.mjs:**
  - grenadeCookFromHold: 0 for non-cook types; max(0, h - 240) for frag.
  - nextStockedGrenade wraps and skips empty types, including dir -1, and returns -1 when nothing is stocked.
  - autoReadyGrenade ordering:
    - current is kept if stocked;
    - then preferred;
    - then same role (TTT [0,0,0,2,1] from frag → molotov);
    - then belt order (Bastion [0,0,1,0,1] → pulse, not smoke).
  - grenadeEffectRadius: frag 7.5, molotov 3.2 (4.2 at chaos 1), smoke 4 (5 at chaos 1).
  - The predictGrenadePath `bounces` output is non-empty for a frag thrown at a floor.
- **tools/grenade-pouch-input-test.mjs** (mock DOM events, like keybindings-test):
  - an H tap moves to the next stocked type, and an H hold of 200 ms or more opens the pouch;
  - a vector pick snaps away from an empty slot;
  - G in the pouch confirms and begins;
  - a tap throws at 0.6, and a hold after wheel +2 throws at 1.0;
  - the wheel neither switches weapons nor cycles types while held;
  - R while held cancels, queues no reload and no throw;
  - the type locks, so H and the quick keys are ignored mid-hold;
  - the cook is measured from the pin;
  - forced release happens at cook ≥ fuse;
  - auto-advance on a count drop;
  - an empty or cooldown press returns 'denied';
  - build mode gating;
  - weapon wheel open → cancel;
  - pad: RB tap/hold, D-pad power while held, X cancel, D-pad-down tap/hold pouch, Y never touching grenades.
- **Server cooldown** (in grenade-handling-test or smoke.mjs): two edges 100 ms apart produce one launch and a count drop of only one.

Update:
- **tools/contracts/hud-contracts.mjs** (750-780): the Ready Card DOM, the icons, the aim reticle, and the hints 'RELEASE · THROW', 'COOKING · 0.7s' (the cook is now from the pin, so feed cookLeft directly) and 'NO WALL'. Remove the 5-chip `.vb-grenade-type` assertion; keep data-type and the state classes.
- **tools/contracts/input-contracts.mjs** and **weapon-wheel-contracts.mjs**: pouch/wheel exclusivity, and the wheel branch no longer cycles grenades.
- **tools/session-refactor-test.mjs** (68-100): grenadeReady and the pouch dots replace the chip is-selected/is-empty checks.
- **tools/keybindings-test.mjs** (36-39) and account-keybindings-test: a remapped G gives a 0.6 tap and the step power on a hold; the new actions default to []; there are no default overlaps.
- **tools/grenade-handling-test.mjs**: extend the mock input with setGrenadeCounts; an empty press never latches; a cancel sends no edge while grenadeHandling clears; a quick tap still blocks fire, switch and reload.
- **tools/grenade-aim-test.mjs**: the cook offset.
- **tools/smoke.mjs** (316-330): the charge/cook fuse expectations. The forged-input clamps stay as they are.
- **tools/throwable-animation-test.mjs**: the pin cue at GRENADE_PIN_MS, the cancel/reseat pose plus the 'cancel' cue, the limpet 'clamp' with no 'pin', and quick-tap cue spacing.
- **tools/throwable-client-test.mjs**.
- **tools/grenade-feedback-audio-test.mjs**: the new sfx.
- **Browser tests** (edit only; do not run the audible Chromium flow):
  - tools/throwable-browser-test.mjs:110: a KeyH tap is now "next stocked".
  - tools/ttt-investigation-browser-test.mjs:101: replace the 4× KeyH loop with one `selectGrenadeType(4)` through page.evaluate, or with the count of H taps between stocked types.

Run: npm run throwables:test, npm run keybindings:test, node tools/grenade-aim-test.mjs, node tools/smoke.mjs, the hud and input contracts, then npm test. Pipe npm's exit code; do not rely on `| tail`.

======================================================================
7. AGENTS.md DESIGN PASS
======================================================================

1. Capture the current HUD with the muted CDP helper (tools/lib/cdp-session.mjs) at 1440x900 and 390x844.
2. Generate 3 alternatives into docs/design/grenade-pouch/, with the prompts in prompts.json.
3. Implement the chosen one.
4. Compare CDP captures at both sizes (these are muted; never use the audible Chromium smoke).

ImageGen prompt (base; for each variant swap the last sentence for "variant B: angular military stencil" or "variant C: soft glass HUD"):

"First-person voxel arena shooter HUD, 16:9 gameplay screenshot, blocky voxel warehouse interior with crates and a doorway, a chunky voxel assault rifle viewmodel lowered at the bottom right while the right hand holds a green frag grenade with its pin pulled. Centre: a thin crosshair. Just below it, a small readied tag with a frag icon and 'x2'. Lower left of the crosshair, a 5-notch curved power gauge with the third notch lit amber; lower right, a thin circular fuse ring draining red-orange with '1.8s'. Under them, a small hint line in a condensed monospace: 'RELEASE · THROW   SCROLL · RANGE   R · PIN BACK'. In the world, a dashed amber arc runs from the hand through the doorway with three small bounce dots, ending in a translucent amber ground disc about 7 metres wide with a crisp edge ring. Bottom right: the ammo panel, and immediately to its left a compact dark 'ready card' with a 'G' key badge, a detailed frag grenade icon, 'M-4 FRAG ×2', and a row of five small dots (amber, red, cyan, orange, grey-cyan) with one ringed, plus an 'H POUCH' badge. Inset top-right: the same scene showing a compact five-wedge radial pouch around the crosshair, with wedges frag (top), claymore, pulse, molotov, smoke clockwise, each with icon and count, the molotov wedge hatched and greyed as empty, the frag wedge highlighted amber, and the centre reading 'M-4 FRAG · Timed fuse · cookable · 7.5 m blast'. Clean readable tactical UI, 11px-equivalent minimum text, high contrast on dark translucent panels, no clutter, consistent with a stylised voxel game. Variant A: rounded industrial panels with amber accents."

======================================================================
8. RISKS AND DEFERRED IDEAS
======================================================================

Risks:
- **Feel changes:** a tap now throws at 0.6 instead of a minimum lob; power is a remembered step rather than hold time; frags cook 240 ms longer. The 450 ms server cooldown offsets tap-spam. Playtest.
- **Free cooked-frag pin back:** if it proves too forgiving, the fallback is a one-line rule that allows cancel only before GRENADE_PIN_MS for cook types.
- **Pad D-pad down loses slotDown:** it was a duplicate of the Y tap, and it still steps the weapon wheel while that is open.
- **Test churn:** the DOM and string contracts must migrate in the same change.

Deferred to phase 2:
- throw styles (underhand/roll with rolling physics);
- an incoming-grenade indicator on the damage ring;
- a floating fuse label at the rest point;
- a snapshot `grenadeHeldType`;
- default-bound quick keys once a layout-aware label exists (keyCodeLabel does not use getLayoutMap);
- honouring `_scopeZoomMode` on the wheel.

Verified against the code (read-only):
- public/js/keybindings.js:13-14, 101-109
- public/js/engine/gamepad.js:12-30
- public/js/engine/input.js:49 (PAD_WHEEL_HOLD_MS=260), 606-674, 887-947, 1071-1094, 1140-1260, 1296-1314
- public/js/ui/weapon-wheel.js (wheelAngleForSlot, wheelSlotFromVector, WHEEL_DEAD_ZONE)
- public/js/session/weapon-wheel-controller.js
- public/js/main.js:97, 326, 586-646, 652
- public/js/player/local-player.js:634-651
- public/js/ui/hud.js:99-109
- public/js/ui/buy-menu.js:151-156
- public/js/engine/touch-controls.js:65-91, 217-233
- public/js/guns/throwable-hands.js:5
- public/js/guns/viewmodel.js:383-403
- shared/grenade-rules.js, shared/molotov-rules.js (molotovFireProfile), shared/smoke-rules.js (smokeProfile)
- server/sim/projectiles.js:163-184 (ctx.now)
- server/sim/player.js:150-156
- server/game.js:331, 394-454
- public/assets/grenades/hud/ (frag.png, limpet.png/.svg, pulse.png, molotov.png, smoke.svg)
- package.json throwables:test and keybindings:test