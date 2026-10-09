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
| Restricted zones | Leaving the combat area, or an enemy entering an HQ, starts a 10 s countdown, then death (kill key `restricted`). Aircraft use the map-edge guidance instead (see Controls). |

The flag states are `idle`, `capturing`, `neutralizing`, `contested` and `restoring`. The server emits `flag_state` on every state change, plus exactly one `flag_neutralized` or `flag_captured` per transition. The legacy `flag_capture` event no longer exists. `ticket_low` fires once each at 25 % and at 10 %.

## Deploy, squads and kits

The round starts with everyone at their HQ. After each death, the **deploy screen** replaces the spectator overlay. It shows the map with every valid spawn, a kit picker (the picked class's variant toggle and, for the Engineer, gadget toggle sit in one loadout slot under the class row, so picking a class never moves the rows or the Deploy button), a killer card and a countdown to the respawn time (6 s). If no choice arrives within 15 s of that time, the server deploys the player at the last valid choice, or else at HQ.

Spawn options come from `deployOptions` in `shared/conquest.js`. The server validates choices with the same function the client uses to list them.

- **HQ**: always available, with 2 s of spawn protection.
- **Flag**: a flag your team owns that isn't being neutralized or contested and has no enemy inside it. The server picks one of the flag's 12 spawn cells. It skips cells an enemy within 40 m can see and prefers cells away from enemy-held flags.
- **Squad mate**: a squad mate who is alive, not damaged in the last 4 s, and not on a flag being taken from your team. You spawn 1.5–3.5 m behind them, or just outside the hull when they ride a ground vehicle; if no cell there is free, the choice is refused as `busy`. Each mate can be spawned on once per 10 s. A mate in an aircraft seats you in that aircraft instead (a free seat, else a seat a bot holds; "IN ATTACK HELI · GUNNER"); with no such seat the mate is `busy`.
- **Vehicle seat**: a free seat in a friendly hull that is neither destroyed nor disabled. A human may also pick a seat a friendly **bot** holds: the deploy screen lists it as "TAKE SEAT · BOT-7" (a dashed TAKE chip per bot seat), and deploying there puts the bot out (see *Seat takeover*). Without a named seat a free seat comes first, then the first bot seat in F-key order. Bots never deploy into a bot seat, and nobody ever takes a human's seat.

**Redeploy (RESPAWN).** While alive in a live Conquest match, the in-game menu (Esc, the touch pause button) shows a **RESPAWN** button between RESUME and QUIT ("Counts as a death · opens deploy"). It sends the `redeploy` intent and closes the menu without re-locking the pointer. The server (`ConquestPolicy.redeploy`) kills the player where they are with the kill key `redeploy`: an ordinary death that costs 1 ticket, counts on the scoreboard and uses the normal respawn delay. The body is not revivable. If an enemy damaged the player within the last 5 s (`FALL_DAMAGE.creditMs`, the fall-death rule), that enemy gets the kill, so a redeploy never denies a kill; otherwise there is no killer. The kill feed shows the redeploy icon (two circling arrows) and the killer card reads "YOU DIED · REDEPLOYED" (or names the credited enemy). A seated player dies in the seat: the seat is freed like any crew death and the hull carries on (an aircraft without its pilot flies on as after an ejection). The deploy screen opens on the death and frees the mouse. The server refuses a redeploy while dead or down, outside the live phase, and within 10 s of the last one (`CONQUEST_RULES.redeployCooldownMs`). A refused send brings the menu back after 1.5 s. Only Conquest offers the button.

An invalid choice returns `deploy_refused {reason}` and keeps the screen open. The possible reasons are `invalid`, `contested`, `enemy`, `busy`, `cooldown`, `seat` and `locked` (a class above the player's career level; the event adds `kit` and `level`, shown as "CLASS LOCKED · LV 5"). A flag whose spawn cells are all buried or cratered is refused as `invalid`; `enemy` means usable cells exist but enemies can see them.

Squads of up to 4 are filled automatically in join order. The longest-standing member leads.

Nine kits (`KITS` in `shared/conquest-contract.js`, tuning in `KIT_ROLE_RULES` in `shared/conquest-kits.js`). Five base kits are always open; four more open with the career level (the curve is `level = 1 + floor(sqrt(xp / 100))`, so LV 3 = 400 XP, LV 5 = 1,600, LV 7 = 3,600, LV 9 = 6,400).

| Kit | Unlock | Primary (variant 0 / 1) | Extra | Grenades | Ability |
|---|---|---|---|---|---|
| Assault | base | VK-77 RAPTOR (rifle) / M-DOCK 12 (shotgun) | – | frag 2, pulse 1 | **Adrenaline** (passive): an enemy infantry kill while alive and on foot re-arms a spent medkit (the J heal) and returns 1 frag (up to the kit count), at most once per 10 s. The only kit with the RAPTOR; no team utility. |
| Medic | base | HORNET SMG / LN-03 LONGARC | – | smoke 2, frag 1 | **Revive**: hold Interact for 1.2 s within 2 m of a downed mate. They get up at 40 % HP and the ticket is refunded. The `revive` award (100, and its career XP) is paid only for a body an enemy made: a fall or an own grenade can still be revived, but pays nothing, so self-inflicted deaths cannot be farmed. **Heal aura**: every 1 s each living, on-foot teammate within 6 m gets 5 HP (the Medic itself 2.5), never inside 3 s of taking damage (a hit a damage hook cancels, such as fire on a Pyro, does not count); one pulse per mate per second however many Medics stand near. A spent medkit in the aura comes back at most every 30 s per mate. `heal` (10) per 50 HP given to others. Off while seated or down. |
| Engineer | base | smg / shotgun | gadget 0: RX-8 HAVOC AT launcher (1 + 4) · gadget 1: AX-9 STINGER AA launcher (1 + 2) | smoke 1, frag 1 | **Repair**: hold Interact within 3.5 m of a friendly hull. Repairs 8 % of max HP per second and clears DISABLED above 30 %. |
| Support | base | lmg / minigun | – | frag 2, molotov 1 | **Resupply aura**: every 4 s, gives one magazine and one grenade to each teammate within 8 m (any kit's primary: flame tanks, SKIPJACK cassettes, SUDSBLASTER mags, VOLTLANCE cells; the RIPTIDE has no reserve). |
| Recon | base | sniper / longarc | – | claymore 2, pulse 1 | **Spotting**: 400 m range and 8 s marks. Other kits get 300 m and 5 s. The sniper round flies with drop (460 m/s, zeroed 100 m): hold over with the scope's drop ladder past 150 m and lead movers (docs/development.md, *Sniper ballistics*). |
| Pyro | LV 3 | F-4 FIRESTORM (flamethrower) / M-DOCK 12 | – | molotov 2, smoke 1 | **Fireproof** (passive): no damage from the `fire` class (flame packets, molotov fields and the burn, anyone's, its own included); never shows as burning. The roles tick raises `entity.fireImmune` on a living Pyro, and the flame stream and molotov fields pass it by: no hit marker, burn or panic, and the stream carries on to whoever stands behind it. Lava still burns. Explosives, bullets and AT hurt normally. Fire is light 0.3 / heavy 0 / air 0, so it burns jeeps and exposed crew but not tanks or aircraft. |
| Grenadier | LV 5 | GL-3 SKIPJACK (mgl) / SB-1 SUDSBLASTER (bubble) | – | frag 2, smoke 1 | **Ordnance** (passive): every 20 s a living, on-foot Grenadier refills itself one magazine (one 3-round cassette or one SUDSBLASTER mag, capped) and one grenade of the largest deficit. No award. |
| Raider | LV 7 | GV-4 RIPTIDE (glaive) / HORNET SMG | – | frag 1, claymore 1 | **Ghost** (passive): firing on foot never auto-spots it (a hull it drives still does), and any mark on it lasts at most 2.5 s. Manual spotting still works. |
| Marksman | LV 9 | CL-9 VOLTLANCE (lance) / LN-03 LONGARC | – | pulse 1, smoke 1 | **Overwatch** (passive): a damaging primary hit on an enemy player (or an effective hit on an enemy hull) marks it for the team for 4 s; teammates' kills on it pay the Marksman `spot_assist`. Default 300 m / 5 s manual spotting. |

**Unlocks.** The server holds the level: admission reads it from the profile (`meta.careerLevel`), the lobby stamps `entity.careerLevel` at admission and at match start, and every level-up during play is pushed to the live entity (levels never drop). Guests without a career are level 1; bots ignore the gate. The server announces the open kits with `kit_unlocks {id, level, unlocked, newly}` (on join, at match start, on a rematch and on a level-up that opens a kit); the client keeps the latest own event, buffered from the first snapshots while the map still loads, and the server restates it on every human death (when the deploy screen opens). Only a later rise of an already stamped level fills `newly`: joining at level 9 announces the open kits without a banner. A deploy intent with a locked kit is refused (`locked`); a remembered locked kit (a taken-over bot's) falls back to the Assault, at a timed deploy and at every respawn the policy issues itself (rematch, lobby team change). A level gained mid-match applies at the next deploy, and `newly` shows the banner "NEW CLASS UNLOCKED · PYRO" (while the deploy screen is open, its UNLOCKS header and the header status say "NEW CLASS · PYRO" instead, the status until the class is picked or the screen closes, and a tap on that status scrolls to the UNLOCKS row; HUD banners stay hidden under the screen). The career page lists the four unlocks as display-only level rewards. Conquest teamplay earns career XP (`CAREER_REWARDS.conquestObjective`): 15 XP per revive, capture, neutralize and defend, 3 XP per heal, repair and resupply award (at most 30 XP per minute), on top of the kill, minute and match XP.

**Deploy picker.** The deploy screen shows the kits as a two-row strip under the map and the spawn list (`KIT_MENU_ORDER`): CLASSES (Assault, Medic, Engineer, Support, Recon) and UNLOCKS (Pyro, Grenadier, Raider, Marksman); phones use a two-column grid inside the panel's own scroller. A locked card is dimmed and dashed with a padlock, "LV n" and a thin XP bar ("1,240 / 1,600 XP" from the career view); clicking it says "GRENADIER UNLOCKS AT LV 5 · 1,240 / 1,600 XP" in the class info line under the base row for 4 s and selects nothing, and gamepad LB / RB skip it. A stored locked preference falls back to the Assault. The class info line shows the ability hint of the hovered, focused or selected class, formatted from `KIT_ROLE_RULES` (`kitAbilityHint`). A class a level-up just opened carries a NEW corner badge until picked. Layout: on desktop the map and spawn list shrink with the window height, and DEPLOY sits beside the UNLOCKS row, so everything fits a 1280×720 window; below 1024 px wide DEPLOY drops to its own row under the UNLOCKS row (which then takes the full width) and the loadout strip drops its class name; in phone landscape the classes are a third column that scrolls on its own beside the map and spawns; in phone portrait the map is smaller, the spawn list scrolls, the picked class spans both columns and the header (under the pause button) stays put while the panel scrolls. The status line (refusals, revive wait, auto-deploy, a class unlocked while the screen is open) sits in the header; on phones in portrait it keeps a fixed two-line row even while empty, so a status appearing mid-choice never moves the classes. Design references and captures: `docs/design/conquest/classes/`.

**Medic HUD.** Only a Medic gets the revive hold; anyone else over a downed mate sees "MERCER NEEDS A MEDIC" (no key). A Medic sees downed mates up to 60 m (others 40 m), a green cross over mates under 60 % HP within 40 m and a dashed heal-aura ring around itself on the minimap. A healed player sees a short green "+5 HP" on the health card, driven by the server `heal {id, by, hp}` event. While down, the deploy status names the nearest friendly Medic and its distance ("AWAITING REVIVE · NEAREST MEDIC BRANNOCK · 23 M"). An Assault whose medkit comes back sees "ADRENALINE · MEDKIT RE-ARMED".

**Bots** ignore the unlocks and fill each squad from the shared slot table `BOT_SQUAD_SLOTS`: Assault, Medic, Engineer and one flex kit picked per team, squad and match from `BOT_FLEX_POOL` (Support twice, Recon, Pyro, Grenadier, Raider, Marksman). Variants split by a stable id hash (Pyro bots always carry the flamethrower). Kit slots count the squad's bots only, so a human in the squad does not cost it its Medic, and bots that just spawned take their slot kit as soon as the roster is complete (their opening life is not the default Assault). Medic bots look for bodies within 25 m and walk the last metres shooting on the move even mid-fight (they never stand still short of the body), stop once well inside the 2 m reach, and finish a revive before a low-HP fallback; with no body, a Medic walks to the most hurt teammate under 90 % HP within 45 m (12 m while it stands in a flag being taken or fought over) and stands by it inside the heal aura, and otherwise keeps about 4 m behind its squad leader when that spot is inside the zone it was sent to. Over 32 seeded 180 s rounds the bots revive about as often as the Assault revivers did before the Medic (137 against 140) and the Medics heal about 160 HP per round between them; Pyro bots duel at the stream's reach whatever is drawn (they close to about 19 m), sprint at an infantry contact within 55 m with the flamethrower out, burn inside 31 m of the 32 m reach in 0.6-1.2 s sweeps (`FLAME_FIRE_RANGE`), draw it again from the revolver inside 30 m and take the revolver only past 38 m when not closing in; Assault bots use the medkit below 50 HP after 2 s without contact.

Every kit also carries the revolver and the melee weapon.

**Engineer gadgets.** With the Engineer picked, the loadout slot has a second toggle beside the primaries: **AT** (RX-8 HAVOC) or **AA** (AX-9 STINGER). The choice rides the deploy intent as `gadget` (0 or 1, default 0, so older clients keep the AT launcher) and the server issues exactly that launcher: an AA Engineer owns no AT rockets and the other way round (`KITS.engineer.gadgets`, `kitLoadout(kit, variant, gadget)` in `shared/conquest-kits.js`). Kits without a choice refuse `gadget: 1`. The Support aura also hands back one gadget round per mate at most every 12 s (`KIT_ROLE_RULES.gadgetResupplyMs`), up to the issued total. Key 3 raises whichever gadget the kit carries (see *Controls*).

- **RX-8 HAVOC (AT)**: dumb-fire, 42 m/s with a little drop. Aiming down sights enters its 2.5× launcher sight: a rangefinder readout (distance to the terrain, hull or soldier under the aim point; water is ranged through) and holdover bars for 50 / 100 / 150 m (a centre hold falls about 1.8 / 6.9 / 15.4 m; the rocket self-destructs at about 167 m), plus an impact diamond where the rocket would land (docs/development.md, *RX-8 launcher sight*). A direct hit deals 320 + 60 splash at the `at` class (`CONQUEST_ROCKET_PROFILE`), so a full tank takes **4 hits from the front, 3 on the side and 2 in the rear** (the first rear hit also disables it). A jeep dies to one hit, a helicopter to three (air ×0.8). Infantry splash is ×0.7.
- **AX-9 STINGER (AA)**: kit-only (`WEAPONS.stinger.gadgetOnly`, never in a free roster or weapon wheel). Aim down the sights at an airborne enemy aircraft to build the lock (320 m, 7° cone, 1.4 s). The trigger only releases on a complete lock; client and server both refuse an unlocked launch. The missile (120 m/s, no gravity, proportional navigation, 3 m proximity fuse, `STINGER_RULES` in `shared/vehicle-defs.js`) deals per-airframe damage at the `aa` class: helicopter 360, transport 330, jet 170, so **2 hits kill a helicopter or a transport and 3 a jet**. Flares decoy it. It never damages ground hulls. A killed player stays **down** for 8 s and can be revived until they deploy. Nobody can be revived after dying in an exploding vehicle, from `restricted`, or by falling into the void.

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
- **Shoving wrecks.** A driven or coasting tank or jeep shoves a solid ground wreck in its way (`VehicleSystem.pushWrecks`, numbers in `VEHICLE_MASS`, `WRECK_PUSH_RULES` and `VEHICLE_RAM`). The impact is perfectly inelastic along the contact normal (jeep 2.5 t, tank 45 t), so the pusher slows by the mass it picks up, and neither hull ever ends faster than the pusher alone (wrecks at most 14 m/s). While the driver holds throttle, the loaded push force (tank 600, jeep 0 t·m/s²) keeps shoving against the wreck's ground drag (1.2 g). A tank carries a jeep wreck at full speed and shoves a tank wreck at under 1 m/s² of acceleration. A jeep only nudges a jeep wreck on impact (8 m/s moves it about 2 m) and is stopped by a tank wreck as by a wall (`maxPushMass` 3 t). A released wreck slides on with friction (`slideWreck`), slides along walls, stops at them, falls off edges, pushes infantry aside (a body pinned against a wall stops it) and sleeps again once at rest. Glancing contacts (under 0.2 alignment), live hulls and aircraft still stop the pusher as before. Aircraft wrecks are not solid, so there is nothing to shove. Clients smooth the moved wreck like any hull row.
- **Hull-on-hull crashes.** A ground hull blocked by another hull (live or wreck) is not hitting a wall: the crash is perfectly inelastic along the contact normal, so each hull feels its mass share of the closing speed, Δv = v_close · m_other / (m_self + m_other) (`VehicleSystem.hullCrash`, `HULL_CRASH_RULES`). Each live hull loses (Δv − 4) / 40 of its max hp, a pair of one team a quarter of that, and a pair crashes at most once per 0.75 s. A tank rear-ending a jeep at 13 m/s feels 0.7 m/s and keeps its hull; the jeep feels 12.3 m/s and loses 67 hp (17 friendly). Two jeeps head-on at 24 m/s each lose 160 hp. Damage to an enemy hull credits the rammer; the rammer's own damage credits the other driver only if that hull drove into it.
- **Ramming blocks.** A moving ground hull whose path is blocked by voxels breaks them when *every* voxel in its way breaks for it (`ramVoxels`). Otherwise it stops as before. Voxels in the bottom layer that don't break are steps and are ignored. A glancing hit (less than 30° into the wall, `RAM_RULES.glancingNormal`) scrapes along the wall as before and breaks only brush, so a tank brushing past a house doesn't carve it. What breaks is `RAM_CLASS` (`shared/world/blocks.js`) against the hull's minimum speed per class (`VEHICLE_RAM.classes`):

  | Class | Blocks | Jeep | Tank |
  |---|---|---|---|
  | brush | leaves, hedges, pine leaves, glass | 2 m/s | 1 m/s |
  | wood | planks, timber fences, crates, wooden props | 8 m/s | 2 m/s |
  | thin | painted siding, accent panels | never | 3 m/s |
  | masonry | white plaster, brick, soot brick, roof tiles | never | 7 m/s |

  Anything else never breaks: terrain, stone, cobble walls, concrete, metal, sandbags, bedrock and bridges, as well as every block inside an HQ base radius or within 5 m of a flag. Each broken block costs `0.15 · hardness / mass` m/s (a jeep loses 1.1 m/s per plank and 0.1 m/s per leaf block, a tank 0.2 m/s per plaster block) and `(hardness − armor) · 0.5` collision HP (jeep armour 12, tank 55, so a fence post costs a jeep 10 HP and masonry costs a tank 2.5–7.5 HP per block). A hull breaks at most 8 (tank) or 4 (jeep) blocks per server tick, drawn from a budget of 40 (12) refilled at 16 (6) per second. When the tick's cap is spent, the hull waits in place with its speed. When the budget is spent, the wall stops it. Broken blocks go through the projectile context's `destroyBlock`, the same path as a rocket crater: `tickBlocks`, `blockRevision` (bot navigation relabels and parked hulls wake), and the client `block` event with debris and the material's break sound. No new audio is involved. Bots don't aim at buildings: their routes avoid them. A bot whose route runs into a hedge or fence simply drives through it. Infantry runover is unchanged.
- Hulls stop every flying projectile, not just rockets. Grenades and unarmed SKIPJACK rounds bounce off them, an armed SKIPJACK round detonates on them as a direct hit, and bolts stop at the face.
- Aircraft collisions only count the speed into the obstacle: a graze slides along the wall, a head-on hit destroys the airframe. Taxiing jets ignore bumps below 15 m/s.

**Tank shells.** The tank's main gun fires real cannon shells, not rockets (`VEHICLE_WEAPON_META` presentation `shell`, numbers in `VEHICLE_WEAPONS`). Both rounds fly the shared `stepRocket` integrator with true ballistic drop (gravity 9.8 m/s²) and reload 3.5 s as before.

| Round | Muzzle velocity | Drop at 200 m / 400 m | Hull hit (direct + splash, AT/HE class) | Splash | Terrain |
|---|---|---|---|---|---|
| 120 mm AP | 250 m/s (flat) | 3.1 m / 12.5 m | 400 + 60, `at` | 2.5 m | small crater |
| 120 mm HE | 160 m/s (visible arc) | 7.7 m / 30.6 m | 160 + 120, `he` | 5.5 m | 4 m crater |

Hits-to-kill per armour zone are unchanged (an AP front hit deals 345, a rear hit 690). On the wire a shell is `projectileLaunch`/`projectileExplode` `type:'shell'` with `vehicleWeapon` and `g`, and the mounted `shoot` carries `w:'shell'`. The client draws a bright tracer streak with its own light (no rocket body, exhaust or smoke trail, no motor loop); the shooter gets the muzzle flash, smoke ring, ground dust cone and a muzzle-overpressure dust ring, recoil and camera shake. Impacts use the `shell` blast style. With the Conquest sound bank loaded, they play the recorded AP or HE impact, and a shell passing close to the camera plays its crack (AP) or incoming whistle (HE). Without the bank they fall back to the rocket's heavy blast sound (see `docs/audio/conquest-sfx.md`). HE was kept slower on purpose: at 200 m/s, bot tanks shelled capturing infantry so reliably that the action gate's flag flow dropped (seeds 1–6 averaged 2.3 flag transitions against 6.3 before); at 160 m/s the average is 4.2.

The driver's gun reticle shows where the shell will land. The impact marker is where the arc from the barrel meets solid terrain (marched against the world every frame with `WorldView.pickSolidRay`, which like the server's shell cast flies through water, lava and ghost blocks, so over a river it marks the bed), with a range readout. If the arc meets nothing within the shell's 4 s lifetime, the marker sits on the airburst point instead and reads `AIRBURST NNN M`. A range ladder marks the arc every 100 m (labelled 1–5) below the bore line. Bots aim with `ballisticAim` and the same speed and gravity.

**Locks and countermeasures.**

- The Engineer's AX-9 STINGER locks onto airborne enemy aircraft: aim down sights within 320 m and a 7° cone for 1.4 s. The RX-8 AT rocket no longer locks.
- The jet's AA missile locks onto air targets: 350 m, 10° cone, 1.5 s.
- The target's HUD shows *locking*, *locked* and *missile inbound* (row `lk`) for both lockers. The locker sees a box with a progress ring on the aircraft, "LOCKING n %" then a red "LOCKED", plus the seeker tone (acquire beeps, steady lock tone).
- Flares (both helicopters and the jet) burn for 3 s with an 18 s cooldown. Tank smoke lays a fan of three 4.5 m smoke fields 6 m in front of the hull that last 12 s, with a 25 s cooldown. Both break locks, and smoke also blocks spotting and line of sight.
- Only the driver or pilot fires the countermeasure (X, LB, or the FLARES/SMOKE touch button). Its readiness shows in the vehicle panel; the jeep has none.

**Seats.** F1…F5 address seats in the table order (F1 is always the driver or pilot). Outside a hull, F*n* enters the nearby friendly hull straight into seat *n* if it is free or held by a bot; T enters the first free seat, else the first bot seat. Seated, F*n* moves you to that seat at once: a free seat directly, a bot's seat by swapping places with the bot; the server refuses seats humans hold. Leaving the driver seat this way stops the engine; for 5 s the last driver is still credited with anything the coasting hull runs over. The F keys are fixed (not rebindable) and are swallowed while you are near or inside a hull, so F5 never reloads the page. On touch, SEAT moves to the next free seat; on a gamepad, D-pad up does.

**Seat takeover.** A human who deploys into, enters (T or F*n*) a seat held by a friendly bot takes it (`VehicleSystem.botTakeover`, the same rule on the server and in the shared `deployOptions`). The bot leaves through the normal exit: beside the hull on the ground, or bailing out of an airborne aircraft, where it opens its parachute itself (a jet's bot pilot leaves on the ejection seat). A bot never takes a human's seat and a human never puts out another human. Taking the pilot seat of an airborne aircraft hands over without a lurch: until the new pilot's client sends its first mounted control packet (at most `SEAT_TAKEOVER_GRACE_SECONDS` = 1 s), the server flies neutral stick, keeping attitude, altitude hold and throttle, so the hull neither drops nor turns toward a stale camera.

### Bots riding with humans

A hull that a living human drives or pilots takes nearby bots aboard (`BotCommander.planHitches`, part of the 2 Hz plan; the rules live in the `HITCH_*` constants in `server/bot-commander.js`).

- **Seats**: free seats only, gunner seats first (jeep HMG, tank commander RWS, helicopter chin gun, transport door guns), then passenger seats. A bot never takes a seat a human holds, and never the driver or pilot seat. A seat already given to a crew or a squad ride is skipped.
- **Who**: first the driver's squad mates within 60 m, as many as there are seats. Squad mates booked on a squad ride that has not left yet switch to the human's ride. Then the nearest other teammates within 45 m, with at most ceil(team bots / 4) of them riding with humans per team. A bot stays where it is while it stands in a flag it is taking or one that is being fought over, holds a threatened flag (it stands in it, or its squad defends it and it is within 60 m), is on an all-in home defence, is crewing a hull, or is running a revive or repair.
- **When**: bots only set out for a ground hull moving slower than 3 m/s, or an aircraft on the ground. A hull standing at a flag the bots want takes nobody new. A booked bot that has not boarded within 20 s, or falls more than 80 m behind, gives up.
- **Riding**: riders man their mounts while the human drives (passengers sit). In the air they stay aboard until landing; if the human bails out, the pilotless rule applies (they bail out after 1.5 s).
- **Getting out**: once the hull stops (below 0.8 m/s; aircraft landed) within the radius + 12 m of a flag they want (not owned by the team, threatened, or their squad's order flag), the riders get out. They also get out when the human leaves the driver seat, or when the hull has stood still for 30 s away from such a flag. A dropped rider walks for 30 s (60 s after the idle drop) before it hitches again.

### Bots waiting for humans

A bot that drives or pilots a hull on an order (a crew, or a squad ride's driver) waits for a human teammate who runs to it, like a Battlefield squad mate (`BotCommander.planWaits` in the 2 Hz plan; the drivers read `holdFor` every tick; the rules live in the `WAIT_*` constants in `server/bot-commander.js`).

- **Who is waited for**: a living human of the team on foot within 50 m (and 12 m in height) who closes in at 1.2 m/s or more, moving toward the hull (at least 60 % of the speed points at it) or looking at it (within 0.6 rad). The hull needs a seat the human may take besides the driver's: free, or held by a bot (seat takeover). The jet has no such seat and never waits. One wait per hull and per human; the driver's squad mates come first, then the nearest human.
- **Which hulls wait**: a ground hull standing still, or one that has gone less than 10 m since it last stood still (it brakes to a stop); a hull farther along never stops or turns back. An aircraft only on the ground: a held transport or helicopter keeps its rotors idle on the ground (no lift) until the wait ends. An airborne aircraft never waits.
- **While waiting**: the driver brakes and stands; every gun keeps working. A squad ride's departure, a tank's overwatch move and a takeoff are put off.
- **End**: the human boards (the hull leaves at once: `holdFor` lets go on the next tick, without waiting for the plan), dies or goes down, gets into another hull, walks away (1 m/s or faster away from the hull, outside 8 m), drifts beyond 60 m, or stops closing in for 1.5 s while outside 8 m (standing within 8 m counts as boarding). Otherwise the wait ends after 8 s, or 12 s for the driver's squad mate. A human given up on (timed out, turned away, took another hull) is not waited for again for 30 s, so nobody can park a bot by standing next to it.
- A squad ride no longer waits for a booked rider whose seat someone else (the human) took, so the ride leaves as soon as the human is aboard. If the human takes the driver seat instead, seat takeover applies and the bots aboard ride with the human (above).

### Falling, parachutes and the ejection seat

All values live in `shared/parachute.js`; the server (`server/sim/movement.js`) and the client prediction (`public/js/player-physics.js`) run the same state machine.

- **Fall damage** (`FALL_DAMAGE`): landing damage from the downward impact speed `v` (gravity 24 m/s², a fall of h m lands at √(48·h)). Up to 16.5 m/s (≈5.7 m: jumps, stairs, 3–4 m terrace drops even when jumped off) is free; above it damage is `100·(v − 16.5)/(26.5 − 16.5)`: 10 m ≈ 54, 15 m and more is lethal. Water at least 2 blocks deep under the landing point cushions it completely; an open canopy lands at 5 m/s and never hurts. A lethal fall within 5 s of damage from an enemy credits that enemy (kill feed "ENEMY ⤓ FELL VICTIM"), otherwise it is a self death (killer `''`, "⤓ FELL VICTIM", killer card "YOU DIED · FELL"). Both use the kill key `fall` (`CONQUEST_DEATH_KEYS`); the body stays revivable.
- **Parachute** (`PARACHUTE`): press Jump while falling with at least 6 m of air below (Space, the pad's jump, or the touch JUMP button, which reads CHUTE when it would open one). The canopy sinks at 5 m/s, glides 3 m/s along the look direction and WASD adds up to 4 m/s, so look and keys steer it. Jump again cuts it (it can be reopened while still 6 m up); landing or water closes it. A ledge grab wins over opening it, and the coyote window after walking off an edge never opens it. No weapon fires and no sights open under the canopy (`ConquestPolicy.canFire`); the HUD prompt shows "OPEN PARACHUTE" / "CUT PARACHUTE" with the Jump key. Leaving any aircraft in flight, or any long fall, works this way.
- **Ejection seat** (`EJECTION`, jet only): the pilot leaving an airborne jet (T) is fired out along the airframe's up axis blended with world up at 26 m/s, keeps 60 % of the jet's velocity (≤ 30 m/s horizontally), rides the seat ballistic for 1 s (no air control, a 0.6 s rocket plume) and then the canopy opens automatically. The canopy glass flies off and a pilot's first-person camera gets a short shake. The empty jet flies on and crashes like any crewless aircraft. On the ground (landed and below 4 m/s) the jet is an ordinary exit.
- **Crashes**: crew of a hull wrecked by its own collision or fall (no enemy damage behind it) die with the kill key `crash` and no killer ("⤓ CRASHED VICTIM"), instead of a "ROADKILL" credited to their own driver.
- **Bots** open their canopy themselves once a fall would hurt (falling faster than 10 m/s with at least 2.5 m below and a predicted impact above the safe speed), never cut it, and land unhurt. Riders bail out of an airborne aircraft that has had no pilot for 1.5 s (`BAIL_PILOTLESS_MS`, e.g. after a human pilot ejected). Bot crews stay aboard a burning aircraft: a long canopy ride out of the fight cost the action gate more infantry kills than the quick redeploy.
- **Presentation**: every body under a canopy shows a voxel canopy with suspension lines (own team blue, enemy orange), the seat ride shows a seat with a smoke and flame plume, and the seat tumbles away when the canopy opens (`public/js/vehicles/parachute-fx.js`, owned by `VehicleFx`). In first person the own canopy rides 2.2 m higher and 1.3 m behind the eye (`PARACHUTE_FX.firstPerson`): a level view shows only the thin risers, looking up shows the canopy. The viewmodel stows the gun muzzle-down out of the frame while under the canopy or on the seat (`stowed` in the rig context).

### Controls

| Key | Infantry | In a vehicle |
|---|---|---|
| T (tap) | enter the nearest friendly hull (a bot's seat if none is free) | exit (never fails: 8 directions, then the roof, then a forced eject). Leaving an aircraft that is airborne or rolling faster than 4 m/s ejects you; the jet pilot leaves on the ejection seat |
| T (hold) | revive or repair the target in the prompt | – |
| F1…F5 | enter straight into that seat (free or a bot's) | switch to that seat (free, or swap with a bot) |
| Space | jump; while falling ≥ 6 m up, open / cut the parachute | brake (ground) or climb / pitch up (aircraft; Space alone lifts a helicopter off) |
| Mouse / LMB | aim / fire | aim the seat's mount / fire it; jeep and transport passengers fire their own infantry weapon. Pilots fly with the mouse (mouse aim by default, see below); the jet's guns fire along the nose |
| RMB | aim down sights | optics: tank driver 3×, chin gun 4×, jeep HMG, commander RWS and door guns 1.5× |
| Q | lean | next weapon (tank AP → HE → coax, jet cannon ↔ missiles). For pilots Q/E is the rudder, so the jet picks its weapon with 1 and 2 |
| 1 / 2 / 3 / 4 | kit weapons: 1 primary, 2 IRONCLAD .44, 3 gadget (Engineer AT launcher or STINGER; nothing for other kits), 4 IRON PICK. 5…0 do nothing | pick that seat weapon directly (tank: 1 AP, 2 HE, 3 coax) |
| V | quick pickaxe hit | next camera view (see Vehicle cameras) |
| G / H / J, mouse wheel, K (hold) | grenade, grenade pouch, medkit, cycle weapons, kit weapon wheel | – |
| X | prone | flares or smoke (driver or pilot) |
| C (hold) | crouch | free look |
| Y | spot | spot |
| M | full map | full map |

**Kit-relative number keys.** In Conquest the weapon slot keys (Settings → Controls, `slot1`…`slot4`, digits 1–4 by default) pick kit roles instead of the global weapon slots used in other modes: `KIT_DIGIT_ROLES` and `kitDigitWeapon(owned, index)` in `shared/conquest-kits.js` map them over the snapshot's authoritative `owned` list (`WeaponState._directSlot`), so every kit, variant, gadget choice and redeploy is right without a client table. Rebinding a slot key moves that kit role with it. Until the first `owned` list arrives the keys do nothing. The kit weapon wheel shows the same 1–4 badges and a key pressed while it is open picks the matching segment. Seated, the slot keys still pick the seat's weapons and F1…F5 still switch seats (`VehicleController`); infantry key presses are drained while seated.

WASD drives ground vehicles and Space brakes.

**Aircraft pilots on desktop fly with mouse aim by default** (Settings → Controls → AIRCRAFT CONTROLS: MOUSE AIM, MOUSE STICK or KEYBOARD FLIGHT; stored as `vb-flight-controls`. The old `vb-flight-mode` is read once: only an explicit KEYBOARD FLIGHT choice carries over, since the old default MOUSE STICK was written by every settings save):

| MOUSE AIM | Jet | Attack and transport helicopter |
|---|---|---|
| Mouse | moves the aim circle; the jet banks, turns and pitches its nose onto it and levels its wings once there | X: the aim the nose turns to; Y: looks up and down (camera only) |
| W/S | throttle up/down (persistent); at take-off speed a level or higher aim rotates for the take-off | forward / back: tilts the disk while held |
| A/D | roll override (holds the bank while pressed) | strafe left / right: banks the disk while held |
| released W/S/A/D | – | auto-hover: the disk tilts against the drift and the helicopter settles into a hover within a few seconds |
| Space/Shift | pull up / push down | climb / descend; released, the collective holds the altitude. Space alone takes off |
| Q/E | nudge the aim left / right | nudge the aim left / right |
| Ctrl | airbrake | hover brake |
| C (hold) | free look (the aim stays put) | free look |

Mouse aim is a War Thunder-style instructor. The mouse moves a free world aim direction (`VehicleController.flightAim`, ±1.3 rad pitch; Q/E turn it at 0.9 rad/s); MOUSE FLIGHT SENSITIVITY and INVERT MOUSE FLIGHT PITCH apply to it. The chase camera looks along the aim with no hull lag (the hull rides a little below the centre), so the screen centre is the aim circle. The HUD draws the nose marker where the hull and its fixed guns point (the jet's gun cross with its funnel, the helicopter's rocket pip, a small cross for the transport), joined to the circle by a dotted line, and hides the infantry crosshair. Nothing new travels on the wire: the aim is the ordinary input `yaw`/`pitch`. The jet sends no stick axes, so the server's attitude autopilot in `shared/vehicle-handling/plane.js` (`AIM_INSTRUCTOR`) flies it: a bank whose coordinated turn rate closes the heading error (damped by the turn already under way), a short rudder trim inside 0.12 rad, the elevator onto the aim pitch, and a stall guard that keeps the nose near the flight path when the airspeed it is heading for drops toward the stall. A/D (`vehicleSteer`) override the bank. The helicopters send pitch/roll axes (W/S as `vehicleThrottle`, A/D as `vehicleRollControl`) but no yaw axis, so the nose follows the aim yaw at the pedal rate. This instructor runs on the server because it closes its loop on the exact hull state; a client loop would steer on a snapshot 100–200 ms old.

The helicopters' manual cyclic is assisted for every human layout except the mouse stick: a deflection commands a disk tilt (full deflection = the pitch or bank limit, `assistResponse`), and a released axis is the auto-hover (`hoverGain`, `hoverDamping` in `HELICOPTER_RULES`): the disk tilts against the drift along that hull axis and a little extra drag damps it, so a cruise of 25–34 m/s settles into a level hover in about 3–4 s. The collective is unchanged: Space/Shift command a climb or sink rate and a released collective holds the altitude.

| MOUSE STICK | Jet | Attack and transport helicopter |
|---|---|---|
| Mouse Y | pitch (mouse up = nose up) | pitch (mouse down = nose down) |
| Mouse X | roll | yaw (pedals) |
| A/D | rudder | bank (strafe) |
| W/S | throttle up/down | collective up/down |
| Q/E | rudder | pedals |
| Space/Shift | pitch up/down | climb/descend |
| Ctrl or C | airbrake | hover brake (counters drift) |

In MOUSE STICK the mouse is a spring-centred stick (`MOUSE_FLIGHT` and `stepMouseFlightStick` in `public/js/session/vehicle-controller.js`): mouse motion deflects it, a steady 2 rad/s of look motion (at flight sensitivity 1) holds full deflection, and it springs back to centre with a 125 ms time constant when the mouse stops. The stick commands a rate, so total attitude change follows mouse travel. `main.js` hands the controller the real frame time (capped at 0.25 s) that the frame's pointer motion covers, and the exact first-order spring keeps gain and re-centring frame-rate independent down to 4 fps. MOUSE FLIGHT SENSITIVITY (0.25–3×, `vb-flight-sens`) scales it on top of the look sensitivity, and INVERT MOUSE FLIGHT PITCH (`vb-flight-invert`) flips pitch relative to the look direction. The jet keeps whatever attitude a centred stick leaves. A stick-flown helicopter sends `vehicleAttitudeHold: true`; the server then keeps rate commands and holds the pitch the pilot set, drifting back toward level only at `HELICOPTER_RULES.holdLeveling` (0.06 /s per radian, a 17 s time constant) instead of snapping level. The hold covers only a pitch the pilot set: `state.attitudeHeld` arms when a hold input deflects the cyclic and disarms on any assisted step (boundary autopilot, bot), the hover brake (Ctrl or the map-edge brake), a non-hold input or ground contact. Roll on A/D still levels when released. Free look (hold C) turns the camera and centres the stick. The client only sends the resulting stick axes (`vehiclePitchControl`, `vehicleRollControl`, `vehicleYawControl`, each averaged over the 20 Hz send; `main.js` averages only the axes the seat actually sends) through the normal control path. The server clamps them, so a raw mouse value never reaches the physics.

KEYBOARD FLIGHT (`keyboard`) keeps the older layout: helicopter W/S tilt (assisted, with the auto-hover), the jet's W/S throttle, Space/Shift climb or pitch, A/D bank, Q/E rudder, and the mouse nudges pitch and bank. Gamepad and touch pilots always use this layout: the look stick or drag pitches and banks, and the left stick tilts or throttles. Mouse aim and the mouse stick switch off while a pad is in use (`Input.flightOptions`). Gunners, door gunners and passengers aim with the mouse as before. On touch, contextual buttons cover MAP, SPOT, DEPLOY, SEAT, FLARES/SMOKE, FIRE, UP/DOWN and BRAKE.

**Pilot HUD** (design references `docs/design/conquest/flight/flight-hud-a-reference.jpg`, chosen, and `-b`; captures in `docs/design/conquest/flight/captures/`): every pilot seat shows an airspeed tape (KM/H) on the left with the jet's throttle bar (`THR %`, the snapshot's persistent `throttle`) on its inner side, and a height-above-ground tape (AGL M, a straight-down `pickSolidRay` from the hull; ALT M, the absolute height, only without a world cast) on the right with the climb rate under it. A stalled jet (`stalled` in the snapshot) shows a red STALL · NOSE DOWN chip above the aim and turns the vehicle card's telemetry red; the card reads e.g. `230 KM/H · AGL 94 M · THR 85%`. On phones the tapes are narrower (portrait) and shorter and lower (landscape, clear of the vehicle card). The first three times a desktop player takes an aircraft's pilot seat (per aircraft type and flight mode, `vb-flight-hint-v1`), a pill at the bottom centre names the mode's controls for 9 s, e.g. `MOUSE AIM · W S THROTTLE · A D ROLL · CTRL AIRBRAKE` or `MOUSE AIM · SPACE SHIFT UP / DOWN · W A S D MOVE · RELEASE = HOVER` (`public/js/ui/conquest/flight-hint.js`). X (flares or smoke) no longer toggles a prone that waited for the pilot on exit.

**Map edges.** `VehicleSystem.advanceAircraft` steers aircraft back from the map edge in two layers. A soft steer blends in only near an edge the aircraft is moving toward: a jet needs its turn radius × (1 − sin a) to turn parallel to an edge it approaches at angle a from the normal (nothing when skimming along it, the whole radius head-on) plus its roll-in travel, and the steer ramps in over the 60 m + 0.5 s of travel before that. It pulls a mouse-aim (or bot attitude) request toward the map centre, blends a centre-turn bank (and, deep in, a level-flight elevator) into a manual stick, and a fast jet heading steeply out airbrakes (`speedBrake`, which leaves the throttle setting alone). Rotors hover-brake once their outward drift needs the room left. The hard safety pilot (which takes the controls) engages only inside 60 % of the jet's need, or for a rotor 8 m from the edge after a second's travel, keeps a turn already begun, levels the wings of a jet scrubbed slow, and hands back on a course the soft steer would leave alone, with the pilot's own throttle restored. From the middle of Frontier a full-speed jet keeps its controls on every heading; only head-on toward an edge does the soft steer begin to blend in.

On a gamepad, D-pad left works like T: a tap enters or exits and a hold revives or repairs. D-pad right spots, and R3 toggles the full map when you are not scoped. In a vehicle, D-pad up switches to the next free seat, LB fires flares or smoke, Y selects the next weapon and D-pad down cycles the camera view (the grenade pouch stays shut while seated). On the deploy screen, D-pad up and down pick the spawn, LB and RB pick the kit and A deploys.

### Vehicle cameras

V (rebindable as *Vehicle camera view* in the vehicle context; on foot the same key stays the quick pickaxe hit, and seated frames drain it so it never swings) or the pad's D-pad down cycles the current seat's views. The list is `views` in `seatCameras` (`shared/vehicle-defs.js`), the first entry is the default, and `VehicleCamera` (`public/js/session/vehicle-camera.js`) remembers the last choice per hull type and seat in `localStorage` (`vb-vehicle-view-v1`, `{ type: { seatId: view } }`; read and write are wrapped, so blocked storage only loses the memory).

| Seat | Views |
|---|---|
| Jeep driver | CHASE, ACTION, FIRST PERSON |
| Tank driver | CHASE, ACTION, HATCH |
| Attack helicopter, transport and jet pilot | CHASE, ACTION, COCKPIT, FLYBY |
| Chin gunner | SIGHT, FIRST PERSON |
| Jeep HMG, tank commander RWS, door guns | GUN, FIRST PERSON |
| Passengers | ORBIT, FIRST PERSON |

- **CHASE** is the established camera: ground drivers orbit behind their look (the tank's gun aim), pilots get a lagged chase with a level horizon aimed at the guns' boresight (or, in mouse-aim flight, along the flight aim).
- **ACTION** is the same chase at 62 % of the distance with a lower focus.
- **COCKPIT / HATCH / FIRST PERSON** puts the camera at the seat's eye (`eye`, in the hull frame, the turret frame or behind the seat's gun). Pilots and the jeep driver look out along the hull and roll and pitch with it; the chase views stay level. In an aircraft the view centre stays on the boresight from the eye, a mouse-aim pilot's head turns toward the aim (up to 1.2 rad), and free look (C) turns the head up to 2.5 rad either way. The jeep driver's mouse turns the head relative to the jeep (±1.75 rad), and the look turns with the jeep. The tank driver looks out of the turret hatch along the gun aim, so the shell marker and range ladder stay correct, and RMB still drops into the 3× gunner's sight. Gunners and passengers look along their aim.
- **FLYBY** (aircraft): the camera holds a point 2.4 s ahead of and beside the flight path (30–170 m, line of sight checked against the world), tracks the aircraft past it with a zoom that keeps the airframe readable, then picks a new point on the other side.

First person hides the local player's head, chest and upper arms (forearms and hands stay on the stick, wheel or grips), fades the hull glass to 7 % (`VEHICLE_VIEW.insideGlassOpacity`), folds the jeep windscreen frame away (`model.firstPersonHidden`) and shows a cockpit dressing for the local hull only (`public/js/vehicles/cockpit-overlay.js`: thin canopy bow and sills, instrument panel with lit displays, HUD glass, stick and throttle in the jet; panels, displays and controls in both helicopters; a gauge plate in the jeep). Seated, `main.js` presents the hulls before posing the camera, so a cockpit eye rides the hull's pose of the same frame. All HUD reticles project world points (boresight, pods pip, shell impact, mount aim) through the posed camera, so they stay correct in every view and with roll. The camera's near plane is 0.05 m; the eyes are authored at least 0.2 m clear of the hull voxels around them.

After a view change the HUD shows the seat's views under the ticket bar for 1.6 s with the active one underlined (`public/js/ui/conquest/view-strip.js`; hidden in phone portrait, where that row is taken). Design references: `docs/design/conquest/views/` (view strip alternatives A and B, B chosen; the cockpit reference) with captures in `docs/design/conquest/views/captures/`.

## HUD and audio

- **Top centre**: ticket bars with ▼ bleed rate, time left and five flag chips.
- **Below the crosshair**: the capture ring ("CAPTURING 3 vs 1"), the score ticker and the revive or repair hold ring.
- **World markers**: flags with letter, distance and progress arc, plus squad mates, downed mates and spotted enemies.
- **Bottom left**: rotating, heading-up minimap (M for the full map). On desktop a short "M MAP · Y SPOT" caption sits above it until you have used both keys or 30 s have passed. On touch the minimap shrinks and moves to the top left, beside the MAP and SPOT buttons.
- **Edge markers**: off-screen flags clamp to the nearest screen edge and are spread along it so they keep clear of each other and of the fixed HUD panels.
- **Overlays**: the deploy screen while dead, the full map (M), the out-of-bounds countdown, the squad-grouped scoreboard (Tab, which hides the world markers while open) and the result screen.
- **Bottom right**: the vehicle panel when seated. It shows the seat strip, hull silhouette with hit-zone flash, HP and status badges (DISABLED, BURNING, IMMOBILIZED), ammo, heat and reload per weapon, and countermeasure readiness.
- **Reticles**: tank shell impact (with drop, range readout and a 100 m range ladder), helicopter pod pip, chin-gun gimbal, door-gun arcs, and the jet's gun funnel with lead pipper.
- **Objective audio**: recorded flag cues from the lazily loaded Conquest sound bank, falling back to procedural stingers until the bank loads; a capture tick loop while you stand in a moving zone; announcer lines such as "Objective Charlie captured" (offline-synthesized WAVs in `public/assets/audio/announcer/objective/`).
- **Sound**: recorded vehicle, weapon, blast, impact and ambience banks (`public/assets/audio/conquest/`). Their wiring, sources and CC BY credits are in `docs/audio/conquest-sfx.md`.

## Protocol (contract: `shared/conquest-contract.js`, frozen; changes only through integration)

The browser sends `contract: CONQUEST_CONTRACT_VERSION` (currently 3) in its admission frame. A socket whose frame lacks it or carries another version (an open tab from before a deploy) cannot create or join a Conquest room ("Voxel Blitz was updated. Reload the page to play Conquest.", close 4010), and a host cannot switch a lobby with such a member to Conquest (the error names who must reload, and each such member is told to reload too); the other modes stay open to it. A rejoin refused with 4010 ends the reconnect loop at once with "Voxel Blitz was updated. Reload the page to rejoin lobby X.", and neither the client nor the server treats a 4010 close as a reconnectable drop. Bump the version whenever the kit table or the `cq` row changes meaning.

- **Server → client snapshot**
  - `match.conquest = { v:2, tickets, maxTickets, bleed, endsAt, flags:[[id, control100, owner, state, atk, def]], squads:[[team, squadId, leaderId]] }`. The client merges this with the map statics through `decodeConquestMatch(match.conquest, mapMeta.conquest)`.
  - `players[].cq = [kitIndex, squadId, down, spotted, restrictedDs, lockProgress, actionProgress, chute?]` and `players[].cqs = [objective, vehiclesDestroyed, revives, captures]`. Decode them with `decodeConquestPlayer` and `decodeConquestStats`. The 8th `cq` entry is the parachute state (1 canopy, 2 ejection seat) and is only appended while a body is under one, so grounded rows keep 7 entries (2 extra bytes per airborne body). `kitIndex` indexes `KIT_IDS` (contract v3: 0-3 assault, engineer, support, recon as before, then 4 medic, 5 pyro, 6 grenadier, 7 raider, 8 marksman; -1 none). No new player field: the medkit and grenades the abilities change already ride the row.
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
  - Players: `score`, `deploy_refused`, `revive`, `heal`, `kit_unlocks`, `spot`.
  - Vehicles: `vehicle_hit`, `vehicle_disabled`, `vehicle_repaired`, `countermeasure` (type in `cm`), `ejection` `{id, vehicleId, pos, vel, yaw}` (a jet pilot fired out on the ejection seat).
  - Kills: `kill.w` is the weapon or one of `CONQUEST_DEATH_KEYS` (`restricted`, `vehicle`, `fall`, `crash`, `redeploy`).
  - Existing events gain fields: `vehicle_destroyed` gets `{type, attacker, assists, crewKilled}`, and `shoot` gets `{vehicleId, mount, vehicleWeapon, tracer}`.

  `public/js/session/session.js` forwards all of them to the HUD (`ConquestHud`), the vehicle effects (`VehicleFx`) and the objective audio (`createObjectiveCues`).
- **Client → server**
  - `{t:'conquest', deploy | spot | support | redeploy}` carries exactly one intent per frame:
    - deploy: `{spawn:'hq'|'flag:A'…|'squad:<id>'|'vehicle:<id>[:<seat>]', kit, variant, gadget?}`; `gadget` is 0 (default, AT) or 1 (STINGER, Engineer only);
    - spot: `1`;
    - support: `{type:'revive'|'repair', targetId}`, re-sent at 4 Hz or more while held;
    - redeploy: `1` (the in-game menu RESPAWN, see *Deploy, squads and kits*).

    It is sent with `net.sendConquest()`, which allows 4 deploys, 2 spots, 10 supports and 1 redeploy per second. The lobby enforces the same limits. The route is `server/index.js` → `LobbyManager.conquest` → `GameEngine.conquestIntent` → `ModeController.conquestIntent` → `ConquestPolicy`.
  - `input.vehicleAction` is one of `enter {vehicleId, seatId?}`, `exit`, `seat {seatId}`, `cm` or `weapon {index}`. `vehicleActionFrame` in `netclient.js` whitelists the same exact-key shapes that `parseVehicleAction` accepts.
- **Bot director**: `server/bot-commander.js` registers `{goalFor, deployFor}` through `mode.setBotDirector` when bots attach. `deployFor` also returns the Engineer `gadget`: while enemy aircraft are in play (crewed or airborne) a stable share of the team's engineers takes the STINGER (40 % for one aircraft, 60 % for two or more, at least one), the rest keep the AT launcher. AT engineers lead moving hulls with the rocket; AA engineers watch the sky out to the lock range, hold the seeker on the hull and fire only once locked.

## Loading Frontier

Joining a Conquest match takes about 0.7 s locally from the JOIN click to the first live frame (it took 5 s), plus the map transfer over the internet. The pipeline is in [docs/development.md](development.md) (*Joining a large map*, *Map frames and the map cache*):

- **Map cache.** The browser keeps Frontier's pristine voxels (2.0 MB, 0.5 MB deflated) in Cache Storage under the server's template fingerprint and announces it at admission. The server then sends a 20-byte reference plus 5 bytes per changed cell (craters, built blocks) instead of the map. Partial block damage still rides the welcome. A server whose Frontier generator changed sends the new template under a new fingerprint. The cache keeps at most 3 MB of templates (memory and storage, oldest evicted first), so the new Frontier template pushes the stale one out.
- **Spawn first.** Only the 9 × 9 chunks around the spawn are meshed before play; the rest of the detail range streams in nearest first while the deploy screen or the first seconds of play run (the far terrain covers it meanwhile).
- **Off the main thread.** The light volume is classified and baked in a worker from a copy of the voxels; the Frontier metadata is derived in a worker while the menu is idle.
- **Server.** A join into a damaged map costs O(changed cells) instead of re-encoding 47 M voxels on the tick thread.

Measure with `npm run join:profile` (one muted headless browser; through `.conquest-work/heavy.sh` on a shared machine).

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

- `npm run conquest:test` runs every Conquest Node suite: mode, deploy, score, kits, classes (`tools/conquest-classes-test.mjs`: the nine kits and wire order, unlocks and the `locked` refusal, Medic revive and heal aura, every passive ability, teamplay career XP, bot slots, the deploy picker), class bots (`tools/conquest-class-bots-test.mjs`: a Medic bot revives inside a fight and at panic HP, a Pyro bot draws and burns the flamethrower at close range, a Medic bot walks to a hurt mate and heals it, squad Medics), spotting, vehicles, seats, locks, bots, terrain, sites, rendering, client, HUD and FX. The §9 action gate `tools/conquest-action-test.mjs` runs last. Each suite is also a plain script, so a single area runs on its own, for example `node tools/conquest-vehicle-seats-test.mjs` or `node tools/conquest-ui-test.mjs`.
- `npm run conquest:action` runs only the action gate: 16 bots for 180 s on Frontier.
  - It requires a first kill within 35 s, a first capture within 60 s, at least 25 infantry kills, vehicle fire with 4 or more weapons, and 3 or more flag transitions.
  - It also requires a tick p95 of at most 10 ms and an average snapshot of at most 27 KB.
  - Pass `--seed N` or `--difficulty easy|normal|hard` to vary the run.
- `node tools/conquest-airborne-test.mjs` (server) and `node tools/conquest-airborne-ui-test.mjs` (fake DOM) cover fall damage, parachutes, the ejection seat, bot auto-chutes and bail-outs, bot seat takeover (deploy, enter, swap, airborne pilot handover) and the presentation.
- `node tools/conquest-bot-hitch-test.mjs` covers bots riding with humans: a human-driven jeep, tank and transport get their gunner seats filled, riders stay aboard while the human drives, get out when the human leaves or at a wanted flag, no bot ever holds a human's seat, and a bot holding a threatened flag stays.
- `node tools/conquest-vehicle-ram-test.mjs` covers shoving wrecks (tank pushes a jeep wreck, a jeep only nudges one and can't move a tank wreck, a pushed wreck stops at a wall and sleeps again) and ramming (fence, plank wall, plaster at speed, the per-tick cap, speed loss and damage, stone, concrete and brick for the jeep, flag guard).
- `node tools/conquest-bot-wait-test.mjs` covers bot drivers waiting for humans: a bot-driven jeep squad ride, tank crew, transport squad ride and attack helicopter hold while a human runs to them and leave after the human boards; no wait for a human walking away or standing 28 m off; the 8 s timeout (12 s for a squad mate) and the 30 s cooldown; a ride already well on its way drives on; an airborne helicopter never waits.
- `node tools/conquest-redeploy-test.mjs` (protocol and policy) and `node tools/conquest-redeploy-ui-test.mjs` (fake DOM) cover the in-game menu RESPAWN.
- `node tools/conquest-scale-test.mjs` checks the snapshot budgets: at most 260 B per vehicle row, 27 KB per tick and 400 B for `match.conquest`.
- `node tools/atlastest.mjs` pins the Frontier world fingerprint. Re-pin it after any map geometry change.
- `node tools/map-loading-test.mjs` covers V3 map frames (template, reference, patch), the admission `mapCache`, the server's per-client frame choice, the browser map cache, and checks that the load-time fast paths (raw-voxel light classification, the distant shell's layer window, far-terrain probes, spawn-ring meshing, primed Frontier metadata) give exactly the old results.

Captures (one muted headless CDP browser at a time, never in parallel, no game audio):

- `npm run conquest:capture` (`tools/conquest-capture.mjs [--only world,vehicles,hud]`) runs the three static capture pages in sequence. Output goes to `docs/design/conquest/redesign/captures/<area>/`.
  - World: `node tools/render-map-scenes.mjs --map frontier --shot <id> --vehicles --width 1440 --height 900`; the `overview` shot is 1024 × 1024 and is also the minimap and full-map base.
  - Vehicles: `node tools/conquest-vehicle-capture.mjs [--type tank] [--list]` renders 45 shots on `public/vehicle-capture.html` and fails if the WEST/EAST hues at 150 m are not separated.
  - HUD: `node tools/conquest-hud-capture.mjs [--only id,id] [--sizes desktop,portrait,landscape]` renders 22 fixture states at 1440 × 900, 390 × 844 and 844 × 390 on `public/conquest-hud-capture.html`. It fails on any page error or any overlap between named HUD panels or edge markers (`capture-report.json`).
- Before/after/reference notes for all areas are in `docs/design/conquest/redesign/captures/comparison.md`.

Live smoke:

- `npm run conquest:live` (`tools/conquest-live-smoke.mjs [--seconds 120] [--bots 15] [--out <dir>] [--network] [--software]`) plays a real Frontier match in one muted headless browser against 15 bots. It walks through the lobby, HQ spawn, a walk toward a vehicle and then flag A, the full map, a frag explosion and death, and the deploy screen. It then tries to deploy into a jeep driver seat and drive to flag C. If the jeep is taken (bots often crew it first), it falls back to HQ, as the latest saved run did. It ends on the scoreboard.
  - It fails on any page exception, console error, failed request or server stderr line.
  - It writes screenshots and `live-smoke-report.json` (steps, timeline, FPS, chunk stats) to `docs/design/conquest/redesign/captures/live/`.
  - It always closes the browser and the server.
  - It renders on the hardware GPU (ANGLE/Metal flags). With SwiftShader (`--software`) Frontier draws at about 2 fps, the page cannot drain the 60 Hz snapshot socket, and the server's heartbeat drops the client within a minute.
- `node tools/conquest-mouse-flight-smoke.mjs [--bots 0] [--out <dir>] [--software]` checks MOUSE STICK flight in a real Frontier match (one muted headless browser; it selects the stick and reloads, since mouse aim is the default). It cooks off a frag, deploys into the WEST jet from the deploy screen and flies it with W and mouse motion only: an in-page hand turns a wanted stick deflection into `mousemove` events each frame. The jet takes off, climbs, banks right onto an eastbound course and levels out. The run fails unless the authoritative hull climbs more than 25 m, banks past 0.6 rad, turns more than 1 rad and ends with roll under 0.15 rad, vertical speed under 4 m/s and speed above 50 m/s. A jet held at 48 m/s means the flight-boundary autopilot took over. Screenshots and `mouse-flight-report.json` go to `docs/design/conquest/redesign/captures/mouseflight/`. The Node test `tools/conquest-mouse-flight-test.mjs` (in `npm run conquest:test`) flies the same profile, plus a helicopter lift-off, held tilt, pedal turn and level-out. It drives the real Input → VehicleController → NetClient path against the server sim on a flat 4 km map. It also checks the stick at 4–144 fps, mouse aim (the jet turns 1.2 rad onto a moved aim, banking into the turn and rolling out with the nose on it; the helicopter lifts off on Space alone, holds its height, flies forward on W and hovers within 5 s of letting go, turns to mouse X and sinks on Shift), the mode migration, and that both helicopter layouts end level and slow after the map-edge brake on a 768 m map. `tools/conquest-flight-authority-test.mjs` flies two minutes on the real Frontier map with a stick pilot and with a mouse-aim pilot who keeps aiming out of the map: the soft steer does the turning, the jet never leaves the map or takes damage, and no full-speed heading from the map centre triggers a takeover.

Browser runs are not part of `npm test`: they need a local Chromium and a GPU. Every browser the tools start runs headless with `--mute-audio`. Never use a visible browser flow for Conquest, because it plays game audio.
