# Grenades: the quick-draw pouch

You always have one **ready** grenade, and it is always a type you own. Tap to
throw it at a useful range, or hold to aim with a live arc. A small five-slot
pouch changes the ready type. Nothing can change while a grenade is in your
hand, and an empty type can never be picked.

`shared/grenade-rules.js` owns every value on this page. The client and the
server import it unchanged; the numbers below are its current defaults.

## Types

The pouch order is `GRENADE_TYPE_IDS`: frag, claymore, pulse, molotov, smoke.
It is fixed, so the pouch wedges never move.

| Type | Role | Fuse | Notes |
| --- | --- | --- | --- |
| M-4 FRAG | lethal | 5 s timed | Cookable, 7.5 m blast |
| CLAYMORE | gadget | tripwire | Mounts on a wall, no power step |
| PULSE SHOCK | tactical | impact | 7.2 m blast |
| MOLOTOV COCKTAIL | lethal | impact | Fire radius from `molotovFireProfile` |
| M-18 SMOKE | tactical | 1.8 s | Cloud radius from `smokeProfile` |

The role (`GRENADE_ROLES`) tints the pouch dots on the HUD. It also drives
auto-ready: when the ready type runs out, `autoReadyGrenade` keeps your last
manual pick if it is stocked, then a stocked type with the same role (TTT frag
goes to molotov), then the first stocked type in pouch order.

## Controls

### Keyboard and mouse

| Input | Action |
| --- | --- |
| `G` tap (under 170 ms) | Quick throw of the ready type at its remembered power |
| `G` hold | Draw and aim; the pin pulls at 240 ms; release throws |
| Wheel while `G` is held | Power step: LOB 0.2, 0.4, 0.6, 0.8, 1.0 (up = farther) |
| `R` while `G` is held | Pin back: nothing thrown or spent, no reload queued |
| `H` tap (under 200 ms) | Ready the next stocked type |
| `H` hold | Open the pouch; the mouse steers, releasing `H` readies the slot |
| `G` while the pouch is open | Ready the hovered slot and start the hold |
| `Esc` / right mouse in the pouch | Close it without a change |

Unbound by default, and listed in the settings: `grenadeCancel` (pin back),
`grenadePrevious`, and one quick key per type (`grenadeFrag`,
`grenadeClaymore`, `grenadePulse`, `grenadeMolotov`, `grenadeSmoke`). A quick
key readies that type and starts the hold in one press. The existing `grenade`
and `grenadeType` action ids are kept, so saved bindings need no migration.

The power step is remembered per type for the session; the default is 0.6.
`H`, the quick keys and the wheel never change the type during a hold. Opening
the weapon wheel cancels a held grenade, and the pouch and the weapon wheel
are never open together.

### Gamepad

| Input | Action |
| --- | --- |
| `RB` tap / hold | Quick throw / aim; release throws |
| D-pad up / down while `RB` is held | Power step up / down |
| `X` while `RB` is held | Pin back |
| D-pad down tap | Ready the next stocked type |
| D-pad down hold | Open the pouch; the right stick steers, release readies |
| `RB` while the pouch is open | Ready the hovered slot and start the hold |
| `B` in the pouch | Close it |

`Y` is weapons only: it no longer cycles grenades. `LB` stays last weapon.
A pad disconnect pins the grenade back.

### Touch

A grenade button above reload shows the ready type and its count. Tap throws,
press and hold aims, lifting throws. While it is held, a five-chip power strip
appears beside it and a red PIN BACK chip: slide onto the chip and lift to
cancel. A separate pouch button opens the pouch at the screen centre; tap a
slot to ready it, or tap outside to close.

### Bastion build mode

Entering build mode pins a held grenade back and closes the pouch. `G`, `H`
and the quick keys are ignored until build mode is off.

## What changed from the charge model

The wire fields are the same; only what the client puts in them changed.

- **`grenadeCharge`** is the power step (`grenadePowerAt`) on a tap and on a
  hold alike. It no longer grows with hold time, so a tap throws at 0.6
  instead of a minimum lob.
- **`grenadeCook`** is measured from the pin pull:
  `grenadeCookFromHold(heldMs, type)` = `heldMs - 240` for cookable types, 0
  otherwise. A cooked frag therefore lasts 240 ms longer than before, so the
  fuse matches the visible pin. A frag held for 240 + 5000 ms is released
  automatically and detonates in the hand, exactly as the server has always
  done for `cook >= fuseMs`.
- The type is locked for the whole hold, which removes the cross-type
  cook-carry detonation.
- A cancel sends no throw; it only drops `grenadeHandling`. An empty type is
  never sent.
- A claymore released with no valid wall is treated as a pin back on the
  client: no packet, no throw animation, and the HUD shows NO WALL.

## Server throw cooldown

The server accepts at most one throw per `GRENADE_THROW_COOLDOWN_MS` (450 ms)
per player. In `server/sim/projectiles.js` `step()`, a throw edge that arrives
before `player.nextThrowAt` is dropped and spends nothing. A launch or an
in-hand detonation sets `nextThrowAt = now + 450`. The field starts at 0 on
every spawn (`PlayerEntity.applySpawn`) and on a bot takeover.

The client mirrors the cooldown: a press within 450 ms of the last release is
denied with a card shake and a dry click, so it never predicts a throw that
the server will drop.

Tests: `tools/grenade-pouch-rules-test.mjs` (rules), the server cooldown block
in `tools/grenade-handling-test.mjs`, and the grenade section of
`tools/smoke.mjs`. `npm run throwables:test` runs the Node suites.
