# Conquest

Conquest is a Battlefield-style mode for the Frontier map (768 × 80 × 768, see [docs/maps/frontier.md](maps/frontier.md)). Up to 16 players and bots form two teams. The internal team ids are `alpha` and `bravo`, but the game shows them as **WEST** (own team blue `#4cc3ff`) and **EAST** (enemy orange `#ff8a3d`), so flag "A" is never confused with a team. The server decides everything: capture, tickets, spawns, kits, vehicle damage and score. The client only presents snapshot fields and server events.

Every tuning value is data:

- mode rules: `CONQUEST_RULES` in `shared/conquest-contract.js`;
- kits: `KITS` (contract) and `shared/conquest-kits.js`;
- hulls, seats, mounts and anchors: `shared/vehicle-defs.js`;
- damage multipliers: `shared/vehicle-armor.js`.

Change those tables, not the logic.

## Rules

| | |
|---|---|
| Tickets | 300 per team. A death costs 1 ticket; a revive refunds it. |
| Bleed | Only a team holding at least 3 of the 5 flags drains the other: 1 ticket every 3 s (3 flags), 2 s (4) or 1 s (5). |
| End | A team at 0 tickets loses. After 20 minutes the higher ticket count wins. On equal tickets the team with more flags wins; still equal is a draw. |
| Flags | A and B start WEST, D and E start EAST, C (Iron Bridge) starts neutral. The HQs can't be captured. |
| Capture | Each flag has a control value from −1 to 1. Inside the radius, and within 8 m vertically, the side with more people moves control at `min(1 + 0.5·(net − 1), 2.5)` × the base rate (8 s per half). So 2 v 0 is 1.5×, 3 v 0 is 2×, and 4 v 0 or more is the 2.5× cap; 3 v 1 counts as net 2, so 1.5×. Equal non-zero counts contest the flag and freeze control. An empty flag drifts back toward its owner. Crossing 0 neutralizes the flag; reaching ±1 captures it. Taking an enemy flag alone takes 16 s. |
| Who counts | Living infantry, crew of ground vehicles, and crew of landed aircraft. Airborne aircraft crew and downed players don't count. |
| Restricted zones | Leaving the combat area, or an enemy entering an HQ, starts a 10 s countdown, then death (kill key `restricted`). Aircraft use the flight-boundary handoff instead. |

The flag states are `idle`, `capturing`, `neutralizing`, `contested` and `restoring`. The server emits `flag_state` on every state change, plus exactly one `flag_neutralized` or `flag_captured` per transition. The legacy `flag_capture` event no longer exists. `ticket_low` fires once each at 25 % and at 10 %.

## Deploy, squads and kits

The round starts with everyone at their HQ. After each death, the **deploy screen** replaces the spectator overlay. It shows the map with every valid spawn, a kit picker with a variant toggle, a killer card and a countdown to the respawn time (6 s). If no choice arrives within 15 s of that time, the server deploys the player at the last valid choice, or else at HQ.

Spawn options come from `deployOptions` in `shared/conquest.js`. The server validates choices with the same function the client uses to list them.

- **HQ**: always available, with 2 s of spawn protection.
- **Flag**: a flag your team owns that isn't being neutralized or contested and has no enemy inside it. The server picks one of the flag's 12 spawn cells. It skips cells an enemy within 40 m can see and prefers cells away from enemy-held flags.
- **Squad mate**: a squad mate who is alive, not in an aircraft, not damaged in the last 4 s, and not on a flag being taken from your team. You spawn 1.5–3.5 m behind them, or just outside the hull when they ride a ground vehicle; if no cell there is free, the choice is refused as `busy`. Each mate can be spawned on once per 10 s.
- **Vehicle seat**: a free seat in a friendly hull that is neither destroyed nor disabled.

An invalid choice returns `deploy_refused {reason}` and keeps the screen open. The possible reasons are `invalid`, `contested`, `enemy`, `busy`, `cooldown` and `seat`. A flag whose spawn cells are all buried or cratered is refused as `invalid`; `enemy` means usable cells exist but enemies can see them.

Squads of up to 4 are filled automatically in join order. The longest-standing member leads.

| Kit | Primary (variant 0 / 1) | Extra | Grenades | Ability |
|---|---|---|---|---|
| Assault | rifle / mgl | – | frag 2, smoke 1 | **Revive**: hold Interact for 1.2 s within 2 m of a downed mate. They get up at 40 % HP and the ticket is refunded. |
| Engineer | smg / shotgun | AT rocket (1 + 4) | smoke 1, frag 1 | **Repair**: hold Interact within 3.5 m of a friendly hull. Repairs 8 % of max HP per second and clears DISABLED above 30 %. |
| Support | lmg / minigun | – | frag 2, molotov 1 | **Resupply aura**: every 4 s, gives one magazine and one grenade to each teammate within 8 m. |
| Recon | sniper / longarc | – | claymore 2, pulse 1 | **Spotting**: 400 m range and 8 s marks. Other kits get 300 m and 5 s. |

Every kit also carries the revolver and the melee weapon. A killed player stays **down** for 8 s and can be revived until they deploy. Nobody can be revived after dying in an exploding vehicle, from `restricted`, or by falling into the void.

To spot, press Y (Z on QWERTZ) to mark the enemy player or hull under your crosshair. Smoke and terrain block line of sight. Firing a weapon that isn't suppressed auto-spots the shooter for 2 s.

**Score.** The ledger in `server/modes/conquest/score.js` emits `score {id, pts, reason}` for every award (points in `SCORE_POINTS`). A kill is worth 100, a capture 250 and destroying a vehicle 200. `defend` (100) pays the owners present when a threat ends with the flag back at full control, but only if the threat took at least 0.1 control off the flag, so an enemy stepping in and out of a full flag pays nothing. A small ticker below the crosshair shows each award. The scoreboard groups players by squad. The result screen shows the ticket graph and the MVPs.

## Vehicles

Each team has a jeep, a tank, an attack helicopter, a transport helicopter and a jet at its HQ. Each team also has two flag jeeps (A/B for WEST, D/E for EAST). Iron Bridge has one tank, which spawns for whichever team captures C. Flag pads belong to the flag owner, and an empty hull near its pad changes team when its flag is captured.

| Type | HP | Armour | Seats (F1…F5) | Countermeasure | Respawn |
|---|---|---|---|---|---|
| Jeep | 320 | light | driver · gunner (.50 HMG, exposed) · 2 passengers (exposed, personal weapons) | – | 15 s |
| Tank | 1000 | heavy | driver (120 mm AP/HE + coax MG) · commander (.50 RWS, exposed) | smoke | 30 s |
| Helicopter | 650 | air | pilot (rocket pods) · gunner (25 mm chin cannon) | flares | 35 s |
| Transport | 600 | air | pilot · 2 door gunners (minigun, exposed) · 2 passengers | flares | 35 s |
| Jet | 450 | air | pilot (20 mm cannon + 2 AA missiles) | flares | 40 s |

**Damage.** Damage depends on the weapon class and the armour class (`shared/vehicle-armor.js`). Small arms and MGs do nothing to the tank (its hitmarker is a white spark) but hurt jeeps. Tank armour also depends on the side that is hit: front ×0.75, side ×1, rear ×1.5, top ×1.3, bottom ×1.5.

- A hull at 25 % HP or less, or one hit by an AT round of at least 30 % of its HP on the rear or bottom, is **disabled**. It drives at 40 %, slews at half speed, and burns 2 % of its HP per second until it is destroyed or repaired.
- An undamaged hull regenerates up to 60 % after 8 s.
- Exposed crew can be shot. Crew in a closed hull can't.
- Ground wrecks keep falling until they rest and stay solid for 12 s.
- Hulls stop every flying projectile, not just rockets. Grenades and unarmed SKIPJACK rounds bounce off them, an armed SKIPJACK round detonates on them as a direct hit, and bolts stop at the face.
- Aircraft collisions only count the speed into the obstacle: a graze slides along the wall, a head-on hit destroys the airframe. Taxiing jets ignore bumps below 15 m/s.

**Locks and countermeasures.**

- The Engineer rocket locks onto aircraft: aim down sights within 250 m and a 6° cone for 1.2 s.
- The jet's AA missile locks onto air targets: 350 m, 10° cone, 1.5 s.
- The target's HUD shows *locking*, *locked* and *missile inbound*.
- Flares (both helicopters and the jet) burn for 3 s with an 18 s cooldown. Tank smoke lays a fan of three 4.5 m smoke fields 6 m in front of the hull that last 12 s, with a 25 s cooldown. Both break locks, and smoke also blocks spotting and line of sight.
- Only the driver or pilot fires the countermeasure (X, LB, or the FLARES/SMOKE touch button). Its readiness shows in the vehicle panel; the jeep has none.

**Seats.** F1…F5 address seats in the table order (F1 is always the driver or pilot). Outside a hull, F*n* enters the nearby friendly hull straight into seat *n* if it is free; T enters the first free seat. Seated, F*n* moves you to that free seat at once, and the server refuses taken seats. Leaving the driver seat this way stops the engine; for 5 s the last driver is still credited with anything the coasting hull runs over. The F keys are fixed (not rebindable) and are swallowed while you are near or inside a hull, so F5 never reloads the page. On touch, SEAT moves to the next free seat; on a gamepad, D-pad up does.

### Controls

| Key | Infantry | In a vehicle |
|---|---|---|
| T (tap) | enter the nearest friendly hull | exit (never fails: 8 directions, then the roof, then a forced eject). Leaving an aircraft that is airborne or rolling faster than 4 m/s ejects you |
| T (hold) | revive or repair the target in the prompt | – |
| F1…F5 | enter straight into that seat | switch to that free seat |
| Mouse / LMB | aim / fire | aim the seat's mount / fire it; jeep and transport passengers fire their own infantry weapon |
| RMB | aim down sights | optics: tank driver 3×, chin gun 4×, jeep HMG, commander RWS and door guns 1.5× |
| Q | lean | next weapon (tank AP → HE → coax, jet cannon ↔ missiles). For pilots Q/E is the rudder, so the jet picks its weapon with 1 and 2 |
| 1…3 | weapon slot | pick that seat weapon directly (tank: 1 AP, 2 HE, 3 coax) |
| X | prone | flares or smoke (driver or pilot) |
| C (hold) | crouch | free look |
| Y | spot | spot |
| M | full map | full map |

WASD drives ground vehicles and Space brakes. The helicopter controls are W/S for tilt, Space to climb, Shift to descend and Ctrl or C to brake. The jet controls are W/S for throttle, Space to pitch up, Shift to pitch down and Ctrl or C to brake. Mouse movement pitches and banks both aircraft; A/D banks and Q/E apply rudder. On touch, contextual buttons cover MAP, SPOT, DEPLOY, SEAT, FLARES/SMOKE, FIRE, UP/DOWN and BRAKE.

On a gamepad, D-pad left works like T: a tap enters or exits and a hold revives or repairs. D-pad right spots, and R3 toggles the full map when you are not scoped. In a vehicle, D-pad up switches to the next free seat, LB fires flares or smoke and Y selects the next weapon. On the deploy screen, D-pad up and down pick the spawn, LB and RB pick the kit and A deploys.

## HUD and audio

- **Top centre**: ticket bars with ▼ bleed rate, time left and five flag chips.
- **Below the crosshair**: the capture ring ("CAPTURING 3 vs 1"), the score ticker and the revive or repair hold ring.
- **World markers**: flags with letter, distance and progress arc, plus squad mates, downed mates and spotted enemies.
- **Bottom left**: rotating, heading-up minimap (M for the full map). On desktop a short "M MAP · Y SPOT" caption sits above it until you have used both keys or 30 s have passed. On touch the minimap shrinks and moves to the top left, beside the MAP and SPOT buttons.
- **Edge markers**: off-screen flags clamp to the nearest screen edge and are spread along it so they keep clear of each other and of the fixed HUD panels.
- **Overlays**: the deploy screen while dead, the full map (M), the out-of-bounds countdown, the squad-grouped scoreboard (Tab, which hides the world markers while open) and the result screen.
- **Bottom right**: the vehicle panel when seated. It shows the seat strip, hull silhouette with hit-zone flash, HP and status badges (DISABLED, BURNING, IMMOBILIZED), ammo, heat and reload per weapon, and countermeasure readiness.
- **Reticles**: tank barrel impact, helicopter pod pip, chin-gun gimbal, door-gun arcs, and the jet's gun funnel with lead pipper.
- **Objective audio**: procedural stingers, plus announcer lines such as "Objective Charlie captured" (offline-synthesized WAVs in `public/assets/audio/announcer/objective/`).

## Protocol (contract: `shared/conquest-contract.js`, frozen; changes only through integration)

- **Server → client snapshot**
  - `match.conquest = { v:2, tickets, maxTickets, bleed, endsAt, flags:[[id, control100, owner, state, atk, def]], squads:[[team, squadId, leaderId]] }`. The client merges this with the map statics through `decodeConquestMatch(match.conquest, mapMeta.conquest)`.
  - `players[].cq = [kitIndex, squadId, down, spotted, restrictedDs, lockProgress, actionProgress]` and `players[].cqs = [objective, vehiclesDestroyed, revives, captures]`. Decode them with `decodeConquestPlayer` and `decodeConquestStats`.
  - `vehicles[]` rows are quantized and add these fields:
    - `mounts` (in `vehicleMountOrder` order);
    - `sel`;
    - `st` (`VEHICLE_STATUS` bits);
    - `lk` (0 none, 1 locking, 2 locked, 3 missile inbound);
    - `sp` (spotted);
    - `cmr` (countermeasure readiness);
    - `flag`.

    Rows no longer carry `seatCapacity`, `occupiedSeats`, `weaponSeatId`, `maxHp` or `cooldown`. Use the helpers in `shared/vehicle-seats.js` and `shared/vehicles.js`.
- **Server → client events**: `CONQUEST_EVENT_KINDS`.
  - Objectives: `flag_state`, `flag_neutralized`, `flag_captured`, `ticket_low`.
  - Players: `score`, `deploy_refused`, `revive`, `spot`.
  - Vehicles: `vehicle_hit`, `vehicle_disabled`, `vehicle_repaired`, `countermeasure` (type in `cm`).
  - Existing events gain fields: `vehicle_destroyed` gets `{type, attacker, assists, crewKilled}`, and `shoot` gets `{vehicleId, mount, vehicleWeapon, tracer}`.

  `public/js/session/session.js` forwards all of them to the HUD (`ConquestHud`), the vehicle effects (`VehicleFx`) and the objective audio (`createObjectiveCues`).
- **Client → server**
  - `{t:'conquest', deploy | spot | support}` carries exactly one intent per frame:
    - deploy: `{spawn:'hq'|'flag:A'…|'squad:<id>'|'vehicle:<id>[:<seat>]', kit, variant}`;
    - spot: `1`;
    - support: `{type:'revive'|'repair', targetId}`, re-sent at 4 Hz or more while held.

    It is sent with `net.sendConquest()`, which allows 4 deploys, 2 spots and 10 supports per second. The lobby enforces the same limits. The route is `server/index.js` → `LobbyManager.conquest` → `GameEngine.conquestIntent` → `ModeController.conquestIntent` → `ConquestPolicy`.
  - `input.vehicleAction` is one of `enter {vehicleId, seatId?}`, `exit`, `seat {seatId}`, `cm` or `weapon {index}`. `vehicleActionFrame` in `netclient.js` whitelists the same exact-key shapes that `parseVehicleAction` accepts.
- **Bot director**: `server/bot-commander.js` registers `{goalFor, deployFor}` through `mode.setBotDirector` when bots attach.

## Map metadata (`mapMeta.conquest`, built by `createFrontierMetadata`)

```
{ version: 2,
  flags: [{ id, name, site, x, y, z, radius, home, spawns: [{x,y,z}] ×12 }],      // y = surface feet (+1.02)
  bases: { alpha: { id, name, x, y, z, radius, spawns ×8 }, bravo: … },
  combatArea: { minX, maxX, minZ, maxZ },
  vehicleSpawns: [{ id, team, type, x, y, z, yaw, flag?, altX?, altZ?, walkingRoute?, exitRoute? }],  // 15 hulls
  airfields: […], roads: [{ id, kind, width, points: [[x,y,z]…] }], crossings: [{ id, kind, x, y, z, width }],
  weather: 'golden' | 'mist' | 'overcast' }
```

The top-level metadata adds these fields:

- `navigation: { mode: 'surface', cell: 4, maxStep: 1 }` (the bots' 2.5D surface graph);
- `spawnBounds`;
- `spawns.conquest`;
- `landmarks`.

Tests must read coordinates from this metadata and never hard-code them.

## Testing

Node suites (no browser):

- `npm run conquest:test` runs every Conquest Node suite: mode, deploy, score, kits, spotting, vehicles, seats, locks, bots, terrain, sites, rendering, client, HUD and FX. The §9 action gate `tools/conquest-action-test.mjs` runs last. Each suite is also a plain script, so a single area runs on its own, for example `node tools/conquest-vehicle-seats-test.mjs` or `node tools/conquest-ui-test.mjs`.
- `npm run conquest:action` runs only the action gate: 16 bots for 180 s on Frontier.
  - It requires a first kill within 35 s, a first capture within 60 s, at least 25 infantry kills, vehicle fire with 4 or more weapons, and 3 or more flag transitions.
  - It also requires a tick p95 of at most 10 ms and an average snapshot of at most 27 KB.
  - Pass `--seed N` or `--difficulty easy|normal|hard` to vary the run.
- `node tools/conquest-scale-test.mjs` checks the snapshot budgets: at most 260 B per vehicle row, 27 KB per tick and 400 B for `match.conquest`.
- `node tools/atlastest.mjs` pins the Frontier world fingerprint. Re-pin it after any map geometry change.

Captures (one muted headless CDP browser at a time, never in parallel, no game audio):

- `npm run conquest:capture` (`tools/conquest-capture.mjs [--only world,vehicles,hud]`) runs the three static capture pages in sequence. Output goes to `docs/design/conquest/redesign/captures/<area>/`.
  - World: `node tools/render-map-scenes.mjs --map frontier --shot <id> --vehicles --width 1440 --height 900`; the `overview` shot is 1024 × 1024 and is also the minimap and full-map base.
  - Vehicles: `node tools/conquest-vehicle-capture.mjs [--type tank] [--list]` renders 45 shots on `public/vehicle-capture.html` and fails if the WEST/EAST hues at 150 m are not separated.
  - HUD: `node tools/conquest-hud-capture.mjs [--only id,id] [--sizes desktop,portrait,landscape]` renders 20 fixture states at 1440 × 900, 390 × 844 and 844 × 390 on `public/conquest-hud-capture.html`. It fails on any page error or any overlap between named HUD panels or edge markers (`capture-report.json`).
- Before/after/reference notes for all areas are in `docs/design/conquest/redesign/captures/comparison.md`.

Live smoke:

- `npm run conquest:live` (`tools/conquest-live-smoke.mjs [--seconds 120] [--bots 15] [--out <dir>] [--network] [--software]`) plays a real Frontier match in one muted headless browser against 15 bots. It walks through the lobby, HQ spawn, a walk toward a vehicle and then flag A, the full map, a frag explosion and death, and the deploy screen. It then tries to deploy into a jeep driver seat and drive to flag C. If the jeep is taken (bots often crew it first), it falls back to HQ, as the latest saved run did. It ends on the scoreboard.
  - It fails on any page exception, console error, failed request or server stderr line.
  - It writes screenshots and `live-smoke-report.json` (steps, timeline, FPS, chunk stats) to `docs/design/conquest/redesign/captures/live/`.
  - It always closes the browser and the server.
  - It renders on the hardware GPU (ANGLE/Metal flags). With SwiftShader (`--software`) Frontier draws at about 2 fps, the page cannot drain the 60 Hz snapshot socket, and the server's heartbeat drops the client within a minute.

Browser runs are not part of `npm test`: they need a local Chromium and a GPU. Every browser the tools start runs headless with `--mute-audio`. Never use a visible browser flow for Conquest, because it plays game audio.
