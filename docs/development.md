# VOXEL BLITZ

Browser multiplayer voxel arena shooter. One Node process serves the game **and**
runs the authoritative 60 Hz simulation over WebSockets; clients are plain
three.js ES modules (no bundler). Ten hand-tuned weapons with a full "gun UX"
stack: procedural viewmodels, staged timer-driven animations, bloom/recoil,
ADS, tracers, shell ejects, muzzle flash + barrel heat shader, block-shatter,
damage numbers, hitmarkers, killfeed, a full-screen sniper optic, a radial
weapon wheel, synthesized WebAudio layers, transient-aligned licensed firearm
samples, and menu music.
Every weapon has a dedicated generated HUD silhouette. With `?debug=1`, the HUD
shows round-trip history, arrival jitter, the adaptive snapshot buffer, and FPS.
The live HUD shows four server-authoritative throwables per life: cookable frags,
laser-tripped claymores, concussive pulse shocks, and Molotov cocktails. Holding a
throwable raises it into the hand, then animates pin extraction or bottle ignition
with the matching sound. A Molotov breaks on impact and leaves ground fire for
6.5 seconds. Its 3.2 m footprint follows exposed terrain and deals 24 damage per
second, subject to team rules, cover and spawn protection.

Firearm hit rays have no weapon-specific maximum distance; damage falloff and
terrain cover still apply. The flamethrower jet reaches 28 m. Normal jumps onto
one-block ledges skip automatic vaulting; a deliberate second jump press can
still grab a ledge in the air. Reloads have weapon-specific hand and ammunition
motions, with exchange magazines leaving the view before a replacement enters.
Use `/weapon-feel-preview.html` to inspect reload phases and throwable handling.

## Frame rate

In the in-game menu, open Display to select 30, 60, 90, 120, 144, 165, 240,
or 360 FPS, or Display sync (no game cap, the default). The local preference
persists as `vb-fps-mode`. Caps skip WebGL renders while input, prediction,
animations, and network processing continue on each browser callback.

The FPS toggle shows actual rendered frames per second and a short limit
explanation. The Display panel adds measured browser callback cadence, mean
CPU callback time, and render submission time. Measurements reset after a
mode change, visibility change, a long suspension, and a new match. At least
one second of fresh timing is required before reporting a limit.

The selected cap is known; frame-work pressure is a heuristic. Browser pacing
is observed timing, not detected monitor Hz. The browser normally synchronizes
callbacks to display refresh and may suspend them in hidden tabs
([MDN requestAnimationFrame](https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame)).
GPU execution time is unavailable, so the panel cannot isolate GPU, display,
power-management, and browser-scheduling limits. Non-divisible caps can have
uneven frame spacing. No mode overrides browser synchronization.

Run `npm run fps:test` for pacing across callback cadences, measured render
counts, limit explanations, persistence, and lifecycle resets.

## Map power-ups

Fun, Team Deathmatch and Chaos Lab have pickups on exposed ground across all six
combat maps. Walk over one to collect it. Armor adds 50 protection (up to 100),
Medkits restore 35 HP (up to 100), and Ammo refills spare magazines for owned
weapons without changing the loaded magazine or an ongoing reload.

The first Armor spawns after 12 seconds. Further random pickups spawn every
18 to 28 seconds, expire after 30 seconds, and avoid the previous location when
another pad is available. Full players leave unneeded pickups for others. Bots
can collect them too. Armor absorbs damage before HP and resets on death.
Each map has four exposed sites away from player spawns; damaged or blocked pads
are skipped. S&D, Gun Game and Training do not spawn pickups.

`shared/powerups.js` contains tuning and labels. `shared/powerup-sites.js` checks
current terrain; `server/sim/powerups.js` owns scheduling and collection.
Run `npm run powerups:test` for simulation and protocol checks, and
`npm run powerups:browser` for Chromium rendering and live-client validation.

## Chaos Lab

Create a lobby, select **CHAOS LAB**, ready up and start. The full weapon roster is available.
Start with $600, earn $300 per kill, and open the upgrade shop with **B** (or the touch
BUY button / gamepad D-pad right). All twelve weapons and four throwables each have
three cumulative upgrades costing $300, $600 and $900. Money and upgrades survive
respawns for the current match; joining a new room starts fresh. Kills also restore
one grenade of each type, up to five. The shop does not pause combat. Bots buy upgrades too.

Experiments include Tesla chain hits, shotgun bowling bolts, wall-piercing explosive
sniper rounds, rocket-fed LMG salvos, revolver pinball rings, eight-bounce LONGARC
multiball with explosive bumpers, homing cluster rockets, tunnel rails, pickaxe
shockwaves, frag offspring, long-wire claymores and vacuum-to-launch pulse bombs.
The shop describes all 48 stages before purchase, with artwork for every weapon and
grenade. Cluster children cannot reproduce;
rooms cap live projectiles at 192 and clients retain at most 96 blast visuals.

Flamethrower upgrades add side jets, periodic forward backdraft shockwaves and rockets.
Minigun upgrades add body piercing, periodic ricochet fans and ring salvos. These
effects stack while fuel consumption, spin-up and heat still follow the base weapons.

Validate with `npm run chaos:test` and `node tools/chaos-browser-smoke.mjs`.

Projectile performance checks: `npm run projectiles:test` compares server contact
and homing behavior against frozen reference algorithms, checks the conservative
collision envelope across weapon poses, and reports component timings and update
sizes. It also checks client light/smoke budgets and instanced rocket transforms.
`node tools/projectile-render-smoke.mjs` renders a 192-rocket salvo in WebGL and
checks draw calls and GL errors. Timings are local microbenchmarks, not live match
latency measurements. For live diagnosis use `?debug=1` to compare FPS against
round-trip and arrival jitter during salvos.

Swept rocket/bolt contacts reject distant players before constructing body hitboxes.
Homing checks eligible targets nearest-first and stops at the first visible target;
steering still runs every simulation tick. Correction packets keep their 100 ms
cadence and use the same two-decimal wire precision as launch packets.

## Continuous flamethrower

Hold fire to sustain the F-4 FIRESTORM jet. A 160-unit tank supplies eight seconds
of fire, with 20 authoritative packets per second travelling at 30 m/s up to 28 m.
Packets sweep against terrain and posed player hitboxes, stop on contact, and
ignite victims for four seconds at 7 HP/s. Further hits refresh one burn without
stacking its rate. Burning holds panic at least at 95%; death, respawn and round
boundaries clear it. Already-emitted fire keeps travelling when the trigger is released.

`shared/flame-rules.js` defines shared flight and cadence values. The server bounds
fire to 512 packets. The client renders a fixed 512-particle batch in one draw call;
local emission follows the current nozzle and stops immediately when fire is blocked.
A sustained WebAudio noise loop replaces discrete gun reports and fades on release.

Run `npm run flamethrower:test` for combat, hitbox, client cadence and audio checks.
`node tools/flamethrower-render-smoke.mjs` verifies a sustained stream, nozzle continuity,
range, wall clipping, pool limits, release behavior and WebGL rendering.

## Run

```bash
npm install
npm start            # http://localhost:8070  (PORT env to override)
```

The main menu offers Quick Play, a lobby browser, custom lobbies, room codes, and a Killhouse shortcut:

- **Quick Play** enters the first live shared Fun room with human capacity, or
  creates one immediately. Fresh quick rooms rotate between Foundry, Depot,
  Solstice, and Caldera.
  A fresh room starts with at least five bots; humans replace bots as they join.
  Custom lobby settings do not change quick play.
- **Find a Lobby** lists custom rooms with their host, mode, map, human occupancy,
  match status, and password requirement. Refresh reloads the directory. Join
  directly without typing a code; full rooms are disabled. Quick Play and
  Training rooms are not listed.
- **Create Lobby** immediately creates a joinable waiting room and puts its code
  in the browser URL. The host can change mode, compatible map and `0–31` bots
  while friends join. Changes reset everyone's readiness. Every human, including the host, marks ready;
  the host starts the match after all humans are ready. Expand "Set a lobby
  password" before creating to protect the room, or leave it empty for open access.
- **Join** accepts a five-character invite code and inherits the room's
  authoritative mode and map. It may enter either a waiting lobby or a match
  already in progress. Expand "This lobby has a password" for protected rooms.

**Enter Killhouse** creates a Training lobby directly with your current name and
no combat bots. Ready up and start to enter the covered firing gallery. The
facility has nine respawning range targets, four numbered course rooms with eight
stage targets, skylights, a marked start portal, and a return door beside the finish.
The menu preview is a capture of the same geometry used in the game.

The lobby displays its mode, map, roster, invite code, a QR button, and copyable invite URL,
constructed as `${location.origin}${location.pathname}?lobby=${code}`. Loading
that query preselects Join and pre-fills the normalized code. Codes are
case-insensitive, uppercase on the wire, and use
`ABCDEFGHJKMNPQRSTUVWXYZ23456789`. The QR button opens a large, locally generated
code for the full invite URL. Escape, Close or clicking the backdrop returns to
the lobby without disconnecting.

Lobby passwords are case-sensitive, support up to 64 characters, and are
checked by the server on every join, including invite links. The server keeps
salted scrypt hashes in memory and never includes passwords in directory or
lobby frames. At most two derivations run at once (16 may queue, beyond that
admission closes with 1013), and a room refuses guesses for a minute after 8
wrong passwords. The client retains the password in memory for automatic reconnect;
it is not saved in preferences or invitation URLs.

Headless clients can join quick play from additional shells:

```bash
node tools/bot.mjs --name BotOne
```

The standard verification commands are:

```bash
npm run smoke        # base gameplay/protocol smoke
npm run lobby        # room lifecycle and lobby protocol smoke
npm run modes:lobby  # selected mode/map lobby and wire contracts
npm run modes:bots   # deterministic bot behavior in Fun, TDM, S&D, and Gun Game
npm test             # refactor/weapon/client contracts, gameplay, lobbies, bot modes
npm run refactor:test # hitbox equivalence and RIVET model fit, server contexts/terrain, FX budgets/cleanup
npm run container:smoke # HTTP + WebSocket check against BASE_URL or localhost
npm run browser:smoke   # connected touch-mode menu, play, input, pause, and quit flow
npm run browser:ui      # HUD/shop DOM mutation budgets and session input lifecycle
node tools/client-refactor-test.mjs --browser # shell batching, pixels and GPU cleanup
npm run audio:mix       # actual sample + synth + echo + limiter browser render
```

Visual capture flows run without a multiplayer session and write ignored QA
artifacts under `.artifacts/`:

```bash
npm run maps:capture
npm run weapons:capture
npm run avatars:capture
npm run weapons:capture -- --weapon revolver
npm run weapons:capture -- --state scoped
npm run audio:audit
```

The weapon flow renders every gun in a fixed inspection range in three stable
states: `held`, fully aligned `scoped`/ADS, and `firing` with the real recoil,
muzzle flash, and heat shader advanced to a deterministic frame. The complete
run writes 30 PNGs plus `index.html` and `manifest.json` to
`.artifacts/weapon-renders/` for side-by-side visual review.
The avatar flow renders those same canonical models on remote-player bodies in
front, profile, firing, ADS-profile, crouched-profile, prone-profile and
swim-profile views, plus one representative ally-spectator shot and one
treading-water shot. The matrix is written to `.artifacts/avatar-renders/`.

The project-owned illustrations in `public/assets/weapons/hud/` are the
canonical silhouette and material references for all ten procedural models.
`npm run weapons:icons` regenerates them from the procedural models with a
browser-free software rasterizer (`tools/render-hud-icon.mjs`).
The capture flows validate that each reference-faithful model still fits both
the first-person view and remote-avatar presentation.

The audio audit inventories all 13 shipped fire, reload, and music assets,
measures runtime gain/playback-rate profiles, and writes waveforms,
spectrograms, metrics, and an HTML comparison to `.artifacts/audio-audit/`.
It fails on inventory drift, clipping/loudness anomalies, lost peak headroom,
a fire report missing the 15ms sync budget, or drift in the weapon-weight and
spectral-brightness hierarchy.
`npm run audio:mix` additionally renders every complete local fire graph through
the production sample, synthetic layer, echo, master gain, and limiter in a
Chromium `OfflineAudioContext`; it checks onset, mixed RMS, clipping, tail shape,
and weapon-weight ordering.

Automated browser sessions and captures mute their audio output.

The fast `npm test` suite runs on every push and pull request. Scheduled/manual
extended QA keeps audio, deterministic Chromium captures, and the built
container smoke separate so normal development does not inherit their runtime.

For deterministic manual menu QA, `?debug=1&ui=settings` opens the pause/settings
surface without requiring pointer lock, and `?debug=1&ui=wheel` force-opens the
radial weapon wheel the same way. Main and waiting-lobby
states remain reachable through their normal controls. The 3D scene is graded
through a bounded combat post-process with subtle detail recovery and
pain/panic feedback; DOM HUD stays untouched, and `?shader=off` exercises the
direct-render fallback.

## Multiplayer lifecycle

Every admitted client receives a JSON `welcome` carrying the authoritative
`gameMode` and `map`, immediately followed by exactly one binary frame for that
room's current map. Room members also receive immutable full `lobbyState`
replacements after membership, settings, readiness, phase, or host changes.
Changing the waiting-room arena sends a `lobbyConfig` header with new spawn and
map metadata, then the replacement binary map, then `lobbyState`. Quick rooms remain live and bypass
the waiting UI.

- A created public room remains paused in `waiting`. Every human—including the
  host—must mark ready; bots never participate in readiness. Only the host can
  start, and Start remains gated until all humans are ready.
- Starting changes the room to `live`, attaches its bots, and starts its
  authoritative 60 Hz engine. A human may join a live public room later and
  receives that room's current, already-mutated map before gameplay begins.
  Combat bots fill at most eight total slots; late joins take an available bot
  when the mode permits takeover.
- If the host leaves, the earliest remaining human becomes host. When the last
  human leaves normally, the engine stops, bots are disposed, and the room/code
  is released. After an abnormal last-player disconnect, the room stays available
  for 30 seconds. The client retries connection up to six times. Reconnection is
  a fresh admission with the same name and code, so personal score, loadout and
  host ownership are not reserved; Quick Play re-enters matchmaking.
- Each room owns a fresh map-specific voxel world, `GameEngine`, mode
  controller, optional `BotManager`, and room-scoped broadcasts. Damage, chat,
  ticks, mode events, block deltas, and world mutations never cross room
  boundaries.
- Capacity is 32 participants per room (at most 16 per team), 16 active rooms
  per server process, and 256 WebSocket connections globally. Bots share room
  capacity and can be replaced by humans joining a live match. Duel remains
  limited to two humans and Bastion to four.

Malformed admission closes with code `4002`, an unknown invite with `4004`,
and a full room or 16-room exhaustion with `4005`; the server sends a JSON
`{t:'error',msg}` first.

## Bastion

Bastion (`bastion`) is cooperative linear defense for one to four humans on the
two PvE maps Reactor 9 (`reactor`, three stages) and Causeway (`causeway`, five
stages). Each stage has its own objective, enemy direction, defender points, supply
point, build zone and wave rows; clearing a hold stage pays a stage bonus and
regroups the team at the next line, and the final stage is a 150 s extraction
hold with a last-stand loop. Eight enemy tiers (runner, breacher, heavy, brute,
juggernaut, buggy, APC, walker) scale body, hitboxes and eye height with
`bodyScale`; vehicles are NPC rows with `npcVehicle` and a combat box that follow
the stage's vehicle route and ram destructibles. Between waves defenders build
sandbag lines, barricade walls (`BARRICADE` block 85), sentry turrets and ammo
crates through the ordinary buy frame, gated by the shared `canPlaceStructure`
rules and a per-stage budget (48 voxels, 2 turrets, 1 crate). Enemies breach
built cells through a second cost-weighted navigation field. The layout registry
`shared/world/bastion-layouts.js` feeds the policy, the engine's defender
collision and the client. Human admission stays separate from NPC simulation and
snapshots. Late joins wait for a break, and solo has one emergency return. The
active enemy caps are 6/9/10/10 for one to four players (vehicles 1/1/2/2). See
[the rules and implementation](pve-bastion.md).

Run `npm run bastion:test` for directed simulation on both maps and real WebSocket coverage.

## Game modes and maps

### Fun

Fun is a free-for-all with no teams, no score-limit reset, the complete
ten-weapon loadout, and a **1500 ms** respawn. Quick Play uses shared live Fun
rooms with join in progress and no ready gate.

### Team Deathmatch

Team Deathmatch assigns each player to the lower-population `alpha` or `bravo`
team, disables friendly fire, provides the complete ten-weapon loadout, and
uses team-specific spawn pools. Enemy kills increment the team score. The first
team to **40** wins; the result approval phase follows, then team and player
scores reset and everyone respawns. Deaths respawn after **3000 ms** during the
live phase.

### Search and Destroy

Search and Destroy assigns persistent `alpha`/`bravo` teams to attacker and
defender roles and disables friendly fire. Roles swap after **6 completed
rounds**; the first persistent team to **7 round wins** wins the match. Each
round is **10000 ms prep**, **90000 ms live**, followed by the result approval phase. Players do
not respawn during a round; late joins during live spectate until the next
round.

After a round or match ends in Duel, TDM, Gun Game, S&D, or Bastion, the result
screen shows the final scoreboard and a **Continue** button. At least **40%**
of connected human players must approve, rounded up, before a **five-second**
server countdown starts. Bots do not count. Each player can approve once per
result, including dead players and spectators. Joins and disconnects update
the required count; if approval falls below it, the countdown is cancelled
and restarts with five seconds once enough players approve. Results preserve
players and scores from the round end even if someone leaves. The client sends
`{t: "continue", roundId}` using the token in `match.continuation`; the server
identifies the voter from the admitted socket and rejects old round tokens.

One attacker carries the bomb. An attacker holds **E** inside A or B for
**3000 ms** to plant. A defender holds **E** within 2 world units for **5000 ms**
to defuse. A dropped bomb is picked up by an attacker within 1.4 units, and a
planted bomb explodes after **40000 ms**. Explosion, completed defuse,
elimination, then unplanted time expiry is the outcome priority; a planted bomb
keeps the round live after attacker elimination.

The S&D economy starts at **800 credits** and caps at **16000**. A kill awards
300, a plant 300, and a round win 3250. Consecutive round losses award
1400/1900/2400/2900/3400. Press **B** during prep while alive to buy; buying
owns and refills the weapon:

| weapon | price |
|---|---:|
| revolver | 0 |
| knife | 500 |
| SMG | 1250 |
| shotgun | 1800 |
| rifle | 2700 |
| lance | 3800 |
| LMG | 4000 |
| sniper | 4750 |

Dead/new players begin the next round with the revolver. Round survivors retain
their purchases and remaining ammunition. Weapons cannot fire during prep.

### Gun Game

Gun Game is a free-for-all with a **1500 ms** respawn. Every kill advances the
player through rifle, SMG, shotgun, sniper, LMG, revolver, LONGARC, rocket,
VOLTLANCE, and finally the PIXEL PICK pickaxe. A kill with the PIXEL PICK wins; a
**5000 ms** result phase follows before progression and scores reset.

### Training

Training runs on Killhouse with all ten weapons, nine range targets, and eight
course targets. Range targets respawn after 1200 ms. Course targets respawn
after 4000 ms during practice and stay cleared throughout a timed attempt.
Step onto the start pad to begin the four-stage course. Each cleared stage
opens its gate; crossing the finish records the time and personal best.

The room has one physical course and permits one timed runner at a time.
Other players can use the range while it is occupied, but cannot reset the
runner's gates or clear their course targets. Returning to the start restarts
the attempt. Death or disconnect releases the course for the next runner.

### Trouble in Terrorist Town: traitor traps

Traitor traps are Garry's-Mod-style wall buttons that only living traitors
can press during the live phase. They are pure data in
`shared/world/traps.js` (`MAP_TRAPS[mapId]`, mirrored as `meta.traps`):
`{id, name, detail, button:{x,y,z,face}, uses?|cooldownMs?, effect}`. `button`
is the integer standing cell in front of the wall the plate hangs on (`face`
is `x-|x+|z-|z+`); a trap with `uses` is spent after that many presses, one
with `cooldownMs` re-arms after the pause. Effect kinds, all run by
`server/modes/ttt-traps.js`:

| kind | fields | behaviour |
|---|---|---|
| `explosion` | `x,y,z,radius,damage,terrainRadius,terrainPower,maxDestroyedBlocks` | owner-less blast through `ProjectileSystem.explode` (`projectileExplode` event with `type:'trap'`, terrain carving) |
| `lava` / `flood` | `region,durationMs` | air cells of the inclusive voxel box become `MC_LAVA`/`MC_WATER`, restored after the duration |
| `door_lock` | `region,durationMs` | air cells become `MC_IRON` (cells a living body occupies are skipped), restored after the duration |
| `collapse` | `region,durationMs` | solid non-bedrock cells become air, restored when no body stands in them |
| `electrify` | `regions,durationMs,damage,intervalMs` | feet inside any box take `damage` every `intervalMs` |
| `gas` | `fields,region,durationMs,damage,intervalMs` | smoke fields (`smoke-trap-N`, authored radius) plus the same damage volume |
| `fire` | `points,durationMs` | molotov ground fire ignited at each point, expiry stretched to `durationMs` |

Every block change goes through `pushBlockDelta`, so clients receive the
normal `tick.blocks` deltas and remesh; a round end (`post`) reverts all
changes at once and re-arms the buttons. Trap damage is world damage: hits,
kills and corpses carry the weapon key `trap` and never the traitor. A
traitor within 1.6 m of a button (`TRAP_RULES.useRange`) triggers it with the
interact key (server-side edge on `keys.interact`) or with the buy request
`ttt:trap:<id>`; innocents, dead players, other phases, range, cooldown and
spent uses are refused silently. The traitor's private `ttt.traps` roster
lists every button with `state` (`ready|cooldown|used`), `cooldown` seconds
and `uses`; innocents receive no roster. Clients draw a pulsing emissive
plate on the wall for traitors only (`public/js/engine/ttt-traps.js`), show a
`[E] Falle: …` prompt in range, list the roster in the TTT controls and in the
traitor shop, and play the alarm cue at the effect origin for everyone when a
`trap` event arrives (explosions keep their own blast sound). Traitor bots
walk to a ready button within 28 m and press it when an innocent stands inside
its effect (`trapEffectContains`).

Authored traps (button standing cell → effect):

| map | trap | button | effect |
|---|---|---|---|
| `minecraft_b5` | TNT (1 use) | 59,43,57 (T room, south wall) | explosion at 45.5,51.2,27.5 (mine station), r 8, 140 dmg |
| `minecraft_b5` | Lavaflut (1 use) | 59,43,51 (T room, INCINERATOR wall) | lava over the village square x 66–75, z 24–33, y 42 for 8 s |
| `minecraft_b5` | Lockdown (45 s) | 59,43,56 (T room, west wall) | iron in the corridor gap x 57–58, y 43–44, z 54 for 20 s |
| `waterworld` | Poolstrom (60 s) | 193,11,10 (traitor hall, east wall) | electrify the east pool x 146–190, y 2–8.5, z 34–66 for 12 s |
| `waterworld` | Chlorleck (50 s) | 185,11,24 (traitor hall, west wall) | smoke at 156.5/170.5/184.5, 11, 30.5 plus damage on the deck x 146–194, z 26–34 for 14 s |
| `waterworld` | Tester-Sabotage (40 s) | 183,11,22 (teleport antechamber) | electrify both flume tester volumes for 25 s |
| `foundry` | Abstich (1 use) | 28,13,77 (South Tower) | lava on the North Forge floor x 56–64, y 14, z 23–29 for 8 s |
| `foundry` | Kranladung (1 use) | 24,13,76 (South Tower) | explosion at 65.5,14.8,46.5 (Center Crane), r 8, 130 dmg |
| `foundry` | Turm-Lockdown (45 s) | 28,13,79 (South Tower) | iron in the tower doorway 26, y 12–14, 75 for 20 s |
| `nuketown` | Busbombe (1 use) | 75,16,50 (moving truck) | explosion inside the school bus at 55.5,17,44.5, r 7, 130 dmg |
| `nuketown` | Fallout (50 s) | 75,16,54 (moving truck) | smoke at 46.5/64.5/82.5, 15, 39.5 plus damage on the street x 40–89, z 36–41.5 for 14 s |
| `nuketown` | Gasleitung (40 s) | 85,16,50 (moving truck) | ground fire on the yellow house porch at 60.5,15,58.5 for 12 s |

`node tools/ttt-traps-test.mjs` (part of `npm run ttt:test`) checks every
button on every map (solid floor, air at feet and body, a solid wall behind
the plate, connectivity to the spawn set, effects inside the world and off the
button) and drives a real engine through role, phase and range gating, uses,
cooldowns, block restore, damage volumes, smoke and fire fields, private
state, round reset and bot presses.

### Map compatibility

Harbor, Canyon and Causeway are 192 × 144 × 40 voxels; Minecraft B5 is 128 × 96 × 88 so the Nether fits under the island; Waterworld is 200 × 188 × 36, the whole leisure centre and its foyer at 32 Source units per voxel. Existing maps retain 128 × 96 × 40 dimensions. Binary world headers carry each map's actual dimensions; voxel indices, chunk counts, projectile bounds and spawn pools use those dimensions.

| map id | modes | identity |
|---|---|---|
| `harbor` | Fun, Chaos, TDM, S&D, Gun Game | large cargo dock with permeable warehouses, container lanes and a central crane |
| `canyon` | Fun, Chaos, TDM, S&D, Gun Game | large dry river arena with mesas, ruins and aqueduct arches |
| `reactor` | Bastion | staged core defense: North Gate pump, reactor ring and Service Bay extraction behind three shielded ingress galleries with destructible courtyard cover |
| `causeway` | Bastion | linear five-objective causeway with alternating side breaches and a vehicle road |
| `foundry` | Fun, TDM, S&D, Gun Game | industrial Foundry with A/B sites |
| `depot` | Fun, TDM, Gun Game | point-symmetric cargo Depot |
| `citadel` | Fun, TDM, S&D, Gun Game | Citadel with Courtyard A and elevated Compound B |
| `solstice` | Fun, TDM, S&D, Gun Game | desert solar observatory with a biodome, heliostat ring, and turbine hall |
| `caldera` | Fun, TDM, S&D, Gun Game | volcanic caldera with Obsidian Gate A and elevated Ember Refinery B |
| `nuketown` | Fun, Chaos Lab, TDM, S&D, Gun Game | furnished houses, school bus, moving truck and backyard routes |
| `dust2` | Fun, Chaos Lab, TDM, S&D, Gun Game | Long A, Short/Catwalk, Mid Doors, B Tunnels and raised A site |
| `killhouse` | Training | weapon-test firing range with respawning dummies and a timed 4-stage killhouse course |
| `minecraft_b5` | Fun, TTT, 1v1, Chaos Lab, TDM, Gun Game | block-for-block replica of `ttt_minecraft_b5` (`docs/maps/minecraft-b5.md`): island village, lighthouse, mine rails, swimmable ocean, working Nether portals and the Nether below |
| `waterworld` | Fun, TTT, 1v1, Chaos Lab, TDM, Gun Game | block-for-block replica of `ttt_waterworld` (`docs/maps/waterworld.md`): Leith Waterworld leisure pools, rideable flumes with the tester volumes, changing rooms, cafe mezzanine, traitor room teleport and the glass foyer |

## Mode-specific HUD and scoreboards

The top summary and Tab scoreboard use each mode's own rules:

| Mode | Live summary | Scoreboard |
| --- | --- | --- |
| Free-for-All | Your rank and kills | Rank, player, kills, deaths |
| Team Deathmatch | Team scores and first-to-40 target | Separate team tables with kills and deaths |
| Search & Destroy | Round, clock/fuse, team rounds, attack/defend roles, remaining lives | Separate team tables with kills, deaths, alive/out, and bomb carrier |
| Gun Game | Current weapon level out of ten | Ranked weapon progression and weapon names |
| Training | The existing course HUD | Participants, without competitive counters |

Clocks only appear in the S&D match summary. Final-result countdowns and Training
run timing remain with their respective overlays. The compass and permanent
roster cards are omitted; S&D keeps a compact remaining-lives strip on desktop.

## Controls

| input | action |
|---|---|
| `WASD` | move (`Shift` sprint); `W` / `S` climb up / down while touching a ladder |
| `Shift` while stationary | steady yourself while aiming until the finite breath budget is spent |
| `Space` | jump; press again in midair to grab a reachable ledge; climb up while touching a ladder |
| `Ctrl` / `C` | crouch; climb down while touching a ladder |
| `X` | toggle prone: 0.65 s to lie down, 0.8 s to stand up; crawl at 1.15 m/s; no jumping or sprinting until upright |
| mouse1 / mouse2 | fire / ADS (`F` also aims; ADS is hold or toggle per the settings panel, toggle by default on trackpads) |
| `Z` | sniper zoom step (5× ↔ 2.5×) |
| `R` | reload; shotgun shells seat one at a time and firing interrupts the load |
| hold/release `G` | charge and throw the selected throwable; longer holds throw farther, and a frag cooks while held (hold past the fuse and it goes off in your hand) |
| `H`, or wheel while holding `G` | cycle the throwable: M-4 FRAG (2), LIMPET CHARGE (1, sticks to walls and players), PULSE SHOCK (2, impact concussion), MOLOTOV COCKTAIL (1, ground fire) |
| hold/release mouse1 with the LONGARC | charge the coilgun; release fires a bouncing bolt — a tap ricochets off one wall, a full charge ricochets three times |
| hold/release mouse1 with the VOLTLANCE | charge the rail-lance; release fires a lance that spears up to six enemies on the line, and only a full charge crosses up to two walls |
| mouse1 with the PIXEL PICK | hold to mine nearby blocks; harder materials require more swings. No ammo or reload; melee hits retain 2.5x backstabs |
| `1-9` / `0` / wheel | weapon slots (`1-9` and `0` also pick directly while the weapon wheel is open) |
| `Q` / `E` | strafe left / right (additional to `A` / `D`) |
| `Q` / `E` while dead | previous / next spectator target |
| hold `K` / middle mouse | open the radial weapon wheel: aim freezes, mouse motion or scroll highlights a wedge, releasing the held control or clicking equips it, and a centered release, `Esc`, or right mouse cancels |
| `T` | hold S&D interaction |
| arrow keys while dead | previous / next spectator target |
| `B` | open/close the S&D buy menu |
| `Tab` | scoreboard |
| `Escape` | close an overlay, or open settings / resume / quit to main menu |

A standard-mapping gamepad works alongside the keyboard once the match is live:
left stick moves (`L3` sprints, full deflection auto-sprints), right stick aims
with a dead zone and expo curve, `RT` fires, `LT` aims, `A` jumps, `B` taps to
toggle crouch or holds, `X` reloads, a quick `Y` tap swaps or — while `RB`
grenade is held — cycles the throwable, holding `Y` opens the radial weapon
wheel (d-pad up/down or the right stick highlights a wedge, releasing `Y`
equips it, `B` cancels), `LB` returns to the previous weapon, `RB` holds a
grenade charge, `R3` steps scope zoom, the d-pad cycles
slots (up/down), holds the S&D interaction (left) and opens the armory (right),
`Back` shows the scoreboard, and `Start` pauses. Look Sensitivity scales mouse,
controller and touch look together. Gamepad Base Speed sets the full-stick turn rate
in radians per second at the default Look Sensitivity of 3.0; raising Look
Sensitivity to 6.0 doubles that rate. Both preferences persist across sessions.
These controls and aim assist live in the settings panel; aim
assist only ever slows pad and touch look near a visible enemy and never
touches a mouse.

Trackpads are detected from their scroll stream (or forced under Pointing
Device in settings): look runs 2.4× hotter with a light two-frame smoothing,
two-finger scrolling steps one weapon per flick instead of racing through the
roster, and ADS defaults to toggle so nothing needs to be held with a second
finger. Pointer lock requests raw (unaccelerated) mouse deltas where the
browser offers them. Clicking into desktop play also requests fullscreen.
While gameplay owns the pointer in fullscreen, supported browsers are asked to
capture the game keys through Keyboard Lock, including W with Ctrl or Command.
Game key events cancel browser defaults during play. Escape remains available
to exit, and keyboard capture is released on pause, pointer/fullscreen loss, or
teardown. Browsers may deny or not support capture; C is also available for
crouching without holding Ctrl.

On touch/coarse-pointer devices, the game runs without pointer lock. The left
stick follows your thumb and auto-sprints at its outer edge. Drag the screen to
aim, or drag FIRE to aim while shooting. AIM supports tapping to toggle or holding.
JUMP and FIRE stay near the right thumb; LOAD appears when you can reload. Tap
the ammo panel to swap weapons. USE appears during live S&D rounds and BUY during
S&D prep. Pause stays in the upper-left corner. Controls disappear while dead,
spectating, or in a menu.

The mobile HUD keeps health, ammo, match status, and objectives. Extra grenade,
crouch, zoom, and weapon-wheel touch controls are omitted. A tap on the aim
surface never fires. There are no automatic fullscreen or rotation requests,
rotation banners, or vibration effects. Settings retain control size, handedness,
and look sensitivity. All three sizes keep touch targets at least 44 pixels and
support portrait and landscape. Append `?touch=1` for desktop QA.

## The ten guns

| gun | mode | rate | ammo | feel identity |
|---|---:|---:|---:|---|
| **VK-77 RAPTOR** rifle | automatic | 660 rpm | 30 + 6 mags | climbing-descent burst cadence, amber rail accents |
| **HORNET SMG** | automatic | 900 rpm | 36 + 6 mags | fast springy low-kick spray, tan polymer |
| **M-DOCK 12** shotgun | pump | 90 rpm | 7 + 6 mags | tight ADS buckshot, firm pump shove, staged clack-clack |
| **LONGSHOT MK-II** bolt sniper | bolt | 42 rpm | 5 + 6 mags | 5× full-screen optic, rotary long-throw bolt, canyon echo crack |
| **BASTION LMG** | automatic | 720 rpm | 60 + 4 mags | heavy sustained fire and the slowest viewmodel settling |
| **IRONCLAD .44** revolver | semi-automatic | 300 rpm | 6 + 8 mags | high-damage precision sidearm with fast handling |
| **LN-03 LONGARC** | charge (hold/release) | 160 rpm | 8 + 6 mags | coilgun: a tap flings a quick single-bounce dart, a full charge launches a bolt that ricochets off walls three times — bolts never pierce bodies or terrain and fizzle once the reflections run out, holding too long vents the shot; rising capacitor whine and coil glow |
| **RX-8 HAVOC** | semi-automatic | 45 rpm | 1 + 5 tubes | slow authoritative rocket with splash, terrain carve, direct-hit bonus, and a self-knockback tuned for rocket jumps |
| **CL-9 VOLTLANCE** | charge (hold/release) | 100 rpm | 4 + 5 mags | siege rail-lance: a tap flings a weak dart, a charged lance spears up to six enemies on the line with 0.9-per-body falloff, and only a full charge crosses up to two walls decaying 0.72 per wall; rising cell whine and violet lance glow |
| **PIXEL PICK** | melee | 120 rpm | no ammo — swings are free | pixel pickaxe: material-dependent mining with cracks, cube debris and retro sounds; melee hits and 2.5x backstabs |

Gun timing lives in `public/js/guns/defs.js` (timer table per weapon); shared
ballistics/damage in `shared/combatmath.js`; the LONGARC's bouncing bolts in
`shared/bolt-rules.js`; authoritative resolve in
`server/game.js`. The server re-samples every shot's spread cone itself from
your reported view angles — client damage claims are never trusted.

## Feel and settings
Weapon mass is part of the shared definition: rifle 3.4 kg, SMG 2.3 kg,
shotgun 3.6 kg, sniper 5.2 kg, LMG 8.4 kg, revolver 1.4 kg, longarc 4.1 kg,
rocket 9.6 kg, lance 3.8 kg, and knife 0.9 kg. Mouse aim and
server authority remain immediate. The procedural gun owns a separate angular
orientation with weight-limited speed and acceleration, so heavier weapons trail
farther during a turn and settle more slowly after the mouse has stopped.

Sprinting has a stronger but deliberately slower leg-driven run cycle than
ordinary walking. Jumping and landing move only the carried weapon through a
damped vertical spring while aim stays immediate.

Swimming animates from the authoritative `swimming` snapshot flag plus
`grounded` and `moveSpeed`: floating (swimming without touching the bottom)
blends over ~0.5 s into a swim pose, while wading in shallow water keeps the
walk. `shared/player-stance.js` (`SWIM`, `stepSwim`, `swimCycle`) drives both
bodies. Third-person avatars lean the torso and hips forward, lift the chin,
trail the legs with an alternating flutter kick whose rate follows the stroke
effort, and carry the weapon low and canted with both hands; treading water is
near-upright with a gentle bob and quiet legs, and aiming lifts the gun back to
the sight line. Crouch (the dive input) and prone keep their hitbox-backed
stances underneath. Combat hitboxes deliberately stay in the upright stance
(lag-compensated shots replay poses without the swim flag), so every swim angle
is sized to the standing zone envelope and `tools/hitbox-model-test.mjs` checks
the whole stroke cycle against the RIVET geometry. The first-person body uses
the same cycle with wider angles; `npm run avatars:capture -- --view swim-profile`
(plus `swim-tread`) renders the poses for review.

Incoming hits and nearby
unobstructed enemy shots or explosions build panic; health damage builds pain.
Armor absorbs wounds while retaining a smaller impact cue. Panic recovers fully
at any health, and the pain floor is only 9% at 25 HP. Shared condition rules
keep prediction and authority consistent, with smaller condition spread penalties.
Panic mainly appears as breathing sway and a peripheral pulse; pain produces a
brief directional sting and grunt. The center view and crosshair remain clear.

While grounded and stationary, aim and hold Shift to steady yourself for up to
2.4 seconds and recover panic faster. Crouching improves recovery further.
Movement, jumping, reloading, deployment, and grenade handling cancel the action.
Exhausted breath needs release and recovery before reuse. The server owns the
reserve and sends it with snapshots so the local budget stays synchronized.
Pain and panic meters can be enabled in settings. Reduced motion defaults to the
OS preference, can be overridden in the accessibility settings, and persists as
`vb-display-reducedMotion`. It changes cosmetic motion without changing aim rules.

Near misses are capped and rate-limited, with a slowly replenishing shared
suppression budget. Repeated fire cannot permanently lock panic. Solid cover
blocks suppression, and direct hits do not also receive near-miss panic.

The sniper alone enters its circular full-screen optic at 72% ADS. The outside
mask is opaque and the reticle includes crosshairs, mildots, and range ticks;
the first-person weapon hides only while fully scoped. Authoritative death
state drives a 1.2–1.5 second remote collapse and a deterministic local camera
fall/roll, with every transform restored on respawn.

`Escape` opens the in-game settings panel. Sensitivity (0.0008–0.012 rad per
pixel, default 0.003, shown ×1000 in the UI), master volume (0–1), and field of
view (65–100) apply immediately and persist under `vb-sens-v2`, `vb-volume`, and
`vb-fov`. Look input is scaled by the live zoom while aiming, so a scoped shot
turns at the same on-screen rate per pixel as hip fire. Resume closes the panel and returns to
play; Quit to Main Menu cleanly leaves the active match. While dead, a
collision-safe chase camera follows legal living targets and displays the
authoritative respawn deadline; S&D deaths remain spectators until the next
round. Audio unlocks idempotently after a user
gesture, and routes every sound through the persisted master-volume control.

Reloading drops the active magazine immediately, including its remaining
rounds. Completing the reload consumes one full spare magazine; interrupting it
does not restore the dropped magazine. The HUD and buy menu therefore expose
spare magazine counts instead of a loose reserve-round total. The shotgun is
the exception: its tube keeps every chambered shell, seats one shell every
0.36 s after a 0.42 s start, and a trigger pull interrupts the load with every
seated shell usable (the loose remainder of that spare is lost).

Camera recoil is a deterministic per-weapon pattern with a small jitter. A
fraction of each kick stays on the true aim; once fire pauses for the weapon's
reset window, each gun's recovery fraction (48–72%) walks that climb back over
about 100 ms, while any mouse compensation you applied during the spray is
subtracted first so a controlled spray never over-recovers. Idle sway grows with
the magnification you look through, which is what holding breath is for; a
breath meter appears under the crosshair while aiming and the sniper optic can
step between 5× and 2.5×.

Hit confirmation is layered: body and headshot marks, a heavier red kill mark
with its own confirmation tone, damage numbers that stack into one growing total
per target, a pain vignette that points at the shooter, and a low-health
heartbeat under 35 HP. Dying shows a recap (weapon, markers, range, and the
killer's remaining health) and the spectator camera opens as a 2.6 s kill cam
on the killer before rotating. Remote players show reload and weapon-draw poses
alongside firing, ADS, and crouch.

Server corrections land on the predicted body immediately while the camera
eases through a decaying offset (about 75 ms, 140 ms for a hard snap), and a
locally started reload survives snapshots that predate its input for 400 ms so
reloads never stutter on a slow link.

## Architecture

```
shared/    mode/map rules, movement/collision, world generation, raycasts, weapon/projectile rules
server/    HTTP/ws host, room manager, authoritative 60 Hz sim, modes, bots
public/js/
  engine/  input, snapshots, timing/smoothing, chunk mesher, sky, combat shader
  guns/    defs (feel tables) + viewmodel rig (procedural models, staged anims)
  weapons/ pooled FX: tracers, impacts, shatter, shells, projectiles, ricocheting bolts, shake
  ui/      menu/lobby, match/network HUD, buy dialog, scoreboard, combat feedback
  session/ connection lifecycle and weapon-wheel coordination
  player/  prediction, camera, recoil, aim assist, spectator view
  audio/   sample bank + procedural WebAudio fallback, mix, music, voice limits
tools/     fast contracts plus isolated visual, audio, and container QA flows
```
Client prediction and server movement share `shared/player-movement.js` for
physics constants, body collision, ground probes, and wall sliding. Wheel
coordination lives in `session/weapon-wheel-controller.js`; the DOM overlay
stays in `ui/weapon-wheel.js`. Training progression and gate ownership live in
`server/modes/training/course.js`. Projectile contact checks follow each
flight segment in order, including ricochet legs, and damage falloff uses the
full traveled path.

`server/sim/context.js` creates each room's simulation callbacks once, with live
clock and mode access. Hitbox queries reuse pose calculations and evaluate swept
distances without allocating a point for every sample. Shell casings share one
instanced batch; idle effect pools skip GPU uploads. The HUD and shop update DOM
properties only when their displayed values change, while timed effects keep
animating. `refactor:test` and `browser:ui` protect these behavior and cost limits.

Foundry, Depot, Citadel, Solstice, Caldera, Nuketown, Dust 2, Killhouse, Reactor 9 and Causeway are deterministic templates. Every room receives a
fresh mutable clone of its selected map. The current room map is serialized in
the single binary admission frame; subsequent block destruction is room-scoped
and streams as index deltas inside immutable client snapshots. Each tick also
carries authoritative `match` state and player `team`, `credits`, `owned`,
`bomb`, and interaction fields. Mode and combat events remain attached to their
owning snapshots and are dispatched once by the interpolation/event drain.
Measured RTT pings are independent of tick-arrival jitter. Remote transforms
use an adaptive 30–180 ms presentation buffer, shortest-arc interpolation, and
strictly capped extrapolation through short packet gaps. Server tick time is
mapped onto the page clock, and bounded hit rewind follows the target age the
client actually presented. Hit markers and kills the local player caused
bypass that buffer and surface the frame their snapshot arrives; remote
bodies, gore and everything else keep their delayed, ordered presentation.

Each room serializes a tick snapshot once and hands the same string to every
member, so broadcast cost grows with room size instead of its square. The
server offers `permessage-deflate` with context takeover for frames above
1 KB: consecutive snapshots repeat almost every byte, so a 16-player tick
shrinks from about 20 KB to roughly 1.3 KB on the wire (1.2 MB/s to under
80 KB/s per member at 60 Hz). That headroom is what keeps home and mobile links from
queueing snapshots behind each other, which players otherwise see as rising
ping. Pings, pongs and lobby state stay below the threshold and never wait on
zlib. Clients that decline the extension receive identical plain frames.
`node tools/network-transport-test.mjs` (part of `connection:test`) protects
both properties against a real server.

## Client boot and asset loading

`public/index.html` shows the startup screen as plain HTML, then `js/boot.js`
imports `js/main.js`. The generated `modulepreload` block (`npm run
preload:build`, checked by `npm run static:test`) lists only that static graph:
142 modules, about 0.6 MB on the wire, which is the HUD, session and lobby
code, accounts, career, input, the audio facade and the shared rules. The
startup stages are game systems, account and career; the screen closes and the
menu takes input as soon as `career.start()` resolves (`window.__vbBoot.readyMs`).

Everything else loads through the asset scheduler (`js/boot/asset-scheduler.js`)
after the menu has painted, one task at a time, in the order a match needs it:

1. `models`: `engine/blender-assets.js`, which brings three.js, the glTF loader
   and the fourteen Blender templates with their shared textures (most of the
   bytes).
2. `runtime`: `boot/match-runtime.js`, the world view and chunk mesher, combat
   effects and post-process, weapon and avatar factories, killcam, spectator
   camera and TTT controls.
3. `audio`: the built-in sample bank decoded through `sfx.preloadSamples()`.
   Menu music and UI cues never wait for it, and the join gesture only waits
   for the context to resume.
4. `armory`: the weapon customization dialog. `main.js` mounts the ARMORY menu
   button at once; a click opens the dialog once the module has arrived.
5. `art`: HTTP-cache warm-up for the skyboxes and the HUD weapon and throwable
   icons.

While tasks run the menu shows a small "PREPARING ASSETS n / 5 · stage" line
(`#asset-status`) that hides when the scheduler is idle or a match is running.
Joining or creating a match calls `assets.require(['models', 'runtime',
'audio'])` from `Game.ensureRuntime()`: outstanding tasks become stages of the
arena screen, followed by the mesh sectors, so no frame renders before the
Blender templates exist; tasks that already finished add no stage. A failed task
is retried by the next request. `window.__vbAssets.status` exposes the task
states. `npm run boot:profile` reports the menu-ready point and the background
total; `npm run boot:test` (part of `browser:ui`) parks the Blender and sample
requests at the network layer and proves that the menu responds and that quick
play waits on the arena screen for exactly those assets.

Measured with `npm run boot:profile` (headless Chromium against the local
server): a cold start has an interactive menu after about 120 ms with 166
requests and 0.7 MB on the wire (before: 645 ms with 346 requests and 9.2 MB
ahead of the menu); the background tasks then bring the page to about 400
requests and 9.7 MB. A warm start reaches the menu after about 130 ms with
0.1 MB. Menu music starts after the first paint because `new AudioContext()`
can block on the previous page's context teardown right after a reload.

## Connection diagnostics

In a live match, open **Settings > Connection > Check connection**. The check
records for 60 seconds and continues when settings close. Resume playing to
capture the affected situation, then return to copy the report. Stop saves a
partial report; a disconnected socket also ends recording with a partial report.
Reports remain in memory until the next check or page reload. Nothing is uploaded
automatically. The copied report includes UTC time, host, room code, mode, map,
browser version, server package version, measurements and per-probe samples.

The existing 1.5-second WebSocket echo requests opt into diagnostics only while
recording. Browser RTT uses uncapped timestamps instead of the smoothed HUD value.
Server RTT uses separate, payload-matched WebSocket control frames; stale or
duplicate server measurements are excluded from the RTT summary. Servers without
diagnostic support still provide browser RTT and frame measurements. Missing
server values are shown as unavailable, never zero.

Frame times use actual frame timestamps rather than the simulation's capped
delta. Hidden-tab intervals are excluded from frame statistics and reported
separately; settings-closed frames have their own summary. The report also records
snapshot arrival jitter, interpolation buffer, client/server send queues, room
tick duration and interval maxima over overlapping two-second windows, plus
process CPU and event-loop delay over approximately one-second windows. The
event-loop monitor has 20 ms sampling resolution, so its normal baseline is
around 20 ms. Process CPU uses one full core as 100%. Window percentiles are not
percentiles of all individual ticks. Both RTTs include processing delays.

Each snapshot also records its relative client reception time, original server
timestamp, reception gap and consecutive server-clock step. These clocks have
different origins: compare consecutive steps, not absolute client/server times.
Foreground summaries exclude intervals crossing a visibility change. Raw history
is capped at 2,400 snapshots, with an explicit omitted count. The report compares
arrival gaps with the advertised tick interval and flags burst delivery, larger
server-clock steps, and a buffer staying within 10 ms of its 180 ms maximum in
at least half of ten or more probes. These are observations, not proof of a
specific network fault; browser scheduling can also compress deliveries.

Unanswered echoes over five seconds, late replies, and replies still in flight
at the end are counted separately. They are **not packet-loss percentages**:
WebSockets use TCP, which retransmits lost packets. No route trace is performed.
For persistent issues, compare LAN/WLAN, paused uploads and another connection,
then run `pathping -n HOST` on Windows or TCP MTR to the game's HTTPS port while
the issue occurs. If a proxy fronts the host, that trace reaches the proxy;
operators need separate evidence for the path from the proxy to the game server.

`npm run connection:test` checks recording lifecycle, missing/late measurements,
background timing, uncapped frame/RTT values and the real WebSocket protocol.

For an operator comparison, establish a loopback-only SSH forward to the running
game container, then run:

```sh
node tools/connection-route-check.mjs --public wss://GAME_HOST --direct ws://127.0.0.1:TUNNEL_PORT --output .artifacts/connection-routes.json
```

This creates a temporary password-protected room with two protocol clients and
records both routes simultaneously for 60 seconds after warmup. It saves raw
reports, then closes both clients. No DNS or public port change is needed. The
direct route includes SSH overhead, and Node clients do not measure rendering
or browser frame stalls. A difference narrows the issue to the differing routes;
it does not isolate Cloudflare, the ISP, TLS, or another individual hop.

## Container deployment

The recommended stack is one Node.js game container and one PostgreSQL 18
container. `compose.yaml` connects PostgreSQL only to an internal network, exposes
only the game port, waits for database health, and retains database files in the
named `postgres-data` volume. The game runs as the unprivileged `node` user. HTTP
and WebSocket traffic use the same port; there is no frontend build step. Rooms,
maps, scores, and invite codes remain in memory and reset on a game restart.

Copy `.env.example` to `.env`, set `POSTGRES_PASSWORD` to a generated hexadecimal
password (for example, `openssl rand -hex 32`), and start the stack:

```bash
docker compose up -d --build
docker compose ps
curl --fail http://127.0.0.1:8070/healthz
```

The health response identifies `persistence: "postgres"`. Compose binds the game
to localhost by default; configure `BIND_ADDRESS`, `PORT`, and the HTTPS reverse
proxy for the host. PostgreSQL has no published port. Set `VB_PUBLIC_ORIGIN` to the
public HTTPS origin and preserve `Host` and `X-Forwarded-Proto` through the proxy.
The `.env` file is ignored by Git. PostgreSQL 18 stores its data beneath the
mounted `/var/lib/postgresql` directory, following the [official image's volume
layout](https://hub.docker.com/_/postgres).

Outside Compose, set `DATABASE_URL` and run `npm start`. Schema migration runs
before the HTTP server starts; `npm run db:migrate` also checks/applies it while
the game is stopped. `DATABASE_URL` or `VB_PERSISTENCE=postgres` selects the real
database store. A database connection failure never falls back to JSON. For an
existing deployment without either setting, the legacy JSON store remains
available and logs a migration notice once at startup. This compatibility path
and the Dockerfile's `/app/data` volume preserve existing installations until
their host configuration and data are migrated. Local test fixtures explicitly
use `VB_PERSISTENCE=file`.

Back up PostgreSQL with `docker compose exec -T db pg_dump -U voxel -d voxel -Fc >
voxel-backup.dump`. Keep that private backup outside the repository and verify
restoration on a separate database. A named volume is persistent storage, not a
backup. Do not use `docker compose down -v` on the deployed stack when retaining
accounts and progress.

### Import existing JSON data

Stop the old game writer and take an unchanged backup of its complete data
directory before switching the deployment. The importer accepts guest files,
`accounts/`, `account-careers/`, and `career-claims/`. Point it at the backup and
the new database, while the new game remains stopped:

```bash
docker compose up -d db
docker compose run --rm --no-deps --volume /absolute/backup/data:/legacy:ro game \
  npm run db:import-json -- /legacy
docker compose up -d game
```

For a Node process outside Compose, use `DATABASE_URL=... npm run db:import-json
-- /absolute/backup/data`. Credentials, hashed sessions, recovery codes, careers
and claims retain their existing identities. The importer validates every source
file before a single transaction imports the batch. A checksum manifest makes
an unchanged repeat import a no-op, even when gameplay has since advanced. A
changed previously imported file, malformed profile, duplicate identity or
conflicting target row fails the import. Source files are never modified or
deleted. A legacy claim whose first account-profile write was interrupted
recovers that profile from its saved snapshot. Verify account login, career
totals and equipped cosmetics before completing the host cutover.

`npm run postgres:test` starts its own PostgreSQL container and named volume for
real SQL/HTTP, migration, rollback, timeout, concurrency and restart checks.
`npm run postgres:container` builds the actual Compose stack, checks HTTP/WS,
private database networking and restart persistence. Both harnesses remove only
their own randomly named resources. The dedicated PostgreSQL CI job runs both
commands; ordinary direct simulation fixtures keep their explicit file adapter.

`npm run postgres:browser` checks registration, guest transfer, purchases, SQL
read-back, database/game restart and another browser's login against a real
PostgreSQL container. `npm run armory:browser` checks the responsive menu and
shop, filters, account entry points and purchases. `npm run music:browser`
checks the slider across all six menu screens and measures the actual audio gain.

Weapon scrolling also works while scoped. Switching stows the old weapon before drawing the new one (0.96–1.42 seconds); firing and aiming resume after the swap finishes.


## Career persistence and combat balance

`server/career.js` owns XP, career credits, purchases and equipment. Gameplay snapshots provide kill and objective rewards; active input accumulates play time. Final matches award a completion bonus after at least ten seconds of active participation. Intermediate S&D rounds, training, suicides and idle connections do not award completion bonuses. Career credits are separate from S&D, Chaos and Bastion match currencies.

Guest profiles use a random HttpOnly, SameSite browser cookie. Signed-in profiles use the server-resolved account identity, so the same account shares XP, credits and cosmetics across devices. Only registration transfers the current guest profile, once. Logging in never merges guest profiles. Registration keeps the original guest identity and recovery snapshot privately with the account. PostgreSQL atomically copies the latest committed guest profile into the account and publishes a unique claim, which invalidates the old guest token. If transfer storage is unavailable, the account response carries a visible warning and the career returns 503 until the transfer can finish. Later account reads or logins retry the same transfer, including after a restart. Existing gameplay sockets revalidate their original identity before awarding XP; logout, session expiry, password changes and recovery stop rewards on revoked sessions without interrupting play.

`server/persistence/postgres.js` stores accounts, separate hashed sessions, careers, unique guest claims and reward receipts in PostgreSQL. Auth responses wait for the commit before issuing a cookie or changing the account cache. Purchases serialize balance and ownership checks with their update in one transaction. Gameplay observation stays synchronous at 60 Hz and writes only actual reward deltas. Each reward has a persistent receipt so retries cannot award twice. Transient transaction timeouts, lock conflicts and serialization failures retry the same queued reward before later writes proceed; health reports 503 while it is delayed. Graceful shutdown waits for outstanding writes and reports failure if it cannot finish. Data already committed remains durable across process and database restarts; an abrupt termination can still interrupt work that has not committed.

This runtime supports one game writer per database. A session-level PostgreSQL advisory lock protects the account and claim caches; a second game process or importer is rejected. All transaction statements use the same dedicated connection, as required by [node-postgres](https://node-postgres.com/features/transactions). Losing that connection releases the lease and terminates the game process with a failure exit code. Compose's restart policy starts a new process, acquires the lock and reloads persisted identities. It does not rely on Docker health checks alone to restart the process. A permanent reward error makes persistence unavailable and fails shutdown instead of silently dropping progress.

The compatibility file adapter writes JSON under `VB_DATA_DIR` (default `./data`): guest files at the root, account profiles under `account-careers/`, claims under `career-claims/`, and credentials under `accounts/`. Its purchases flush immediately and rewards flush every second and on graceful shutdown. Preserve the entire directory while using that adapter; unflushed legacy rewards can be lost on abrupt termination.

`server/accounts.js` provides `GET /api/account` and JSON POST endpoints `/api/account/register`, `/login`, `/logout`, `/password` and `/recover`. Usernames contain 3 to 20 ASCII letters, numbers, underscores or hyphens and are unique without case distinctions. Passwords contain 12 to 128 Unicode code points. Registration and recovery return a private recovery code once; only its hash is stored. Accounts and recovery codes work without an email provider.

Optional email recovery uses `server/account-email.js` and the [Resend email API](https://resend.com/docs/api-reference/emails/send-email). Configure `RESEND_API_KEY`, `VB_EMAIL_FROM` (for example, `Voxel Blitz <noreply@your-verified-domain.example>`) and `VB_PUBLIC_ORIGIN` (the exact public HTTPS origin, without a trailing slash). These are server environment variables, never frontend variables or build arguments. Compose passes them to the game container; for direct local Node runs, export them or use `node --env-file=.env server/index.js`. HTTP origins are accepted only on loopback for local tests. Missing configuration leaves code recovery and guest play available and explains email unavailability in the dialog.

Registration accepts an optional `email`. Existing accounts add or replace it through `POST /api/account/email` with `{ email, currentPassword }`. A confirmation email links to `/#account-verify=<token>`; the page removes the token from the address bar and requires an explicit confirmation button, which calls `POST /api/account/verify-email` with `{ token }`. Each account has at most one confirmed recovery email, and confirmed addresses are unique. A replacement stays pending until confirmed; the previous address remains active in the meantime. Provider failure during registration still returns the recovery code and a warning so the player can retry from account settings.

`POST /api/account/forgot-password` accepts `{ email }` and returns the same generic response for verified, unverified and unknown addresses. Mail submission happens independently of the public response; provider failures produce only a redacted server message. Email requests are limited to three per normalized address and fifteen per source IP in ten minutes. `/#account-reset=<token>` opens the new-password form; `POST /api/account/reset-password` accepts `{ token, newPassword }`. Confirmation and reset links expire after 30 minutes, store only purpose-bound SHA-256 hashes, survive restarts and can only be consumed once. New reset requests replace earlier links; password changes and recovery invalidate outstanding links through the account credential version. Email replacement also revokes outstanding reset links. Successful email resets revoke all sessions and require a fresh login. Account email metadata stays separate from the public player identity.

PostgreSQL migration 3 adds the recovery metadata and a unique index on confirmed emails. Existing migrations are unchanged. JSON records without email fields remain valid. Run `npm run accounts:test` for account and email contracts, `npm run accounts:email:postgres` for the same email flow against a temporary real PostgreSQL container, and `npm run postgres:test` for persistence/import regressions. The mail tests use an injected transport, not real player addresses.

Credentials use asynchronous scrypt with `N=131072`, `r=8`, `p=1` and a random salt, following the [OWASP scrypt baseline](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html). [Node's scrypt API](https://nodejs.org/api/crypto.html#cryptoscryptpassword-salt-keylen-options-callback) runs behind a bounded queue (two active jobs and eight queued). Each account keeps up to ten random sessions, stored as hashes with a 30-day expiry. Password changes and recovery revoke all previous sessions. Cookies are HttpOnly, SameSite=Strict and Secure on HTTPS. Account writes require same-origin JSON requests and `X-VB-Account: 1`, with bounded bodies, timeouts, and IP/username attempt limits. Browser WebSockets reject foreign origins. Corrupt credential storage disables account operations without requiring an account to play.

For a TLS reverse proxy, preserve the public `Host` and set `X-Forwarded-Proto: https`; optionally set `VB_PUBLIC_ORIGIN=https://your-game.example` to pin the expected account request origin. Serve production accounts over HTTPS. The limiter uses the socket address rather than trusting a forwarded client IP, so users behind one reverse proxy share its IP limit (60 account writes per ten minutes). Each username also has a 12-attempt limit per ten minutes.

The server applies `shared/combat-balance.js` once at entity impact: rifle and other hitscan shots, melee, bolts, explosions, flame contact, afterburn, ground fire and Chaos chain hits all use a 0.8 damage factor before armor. Terrain destruction and mining retain their own damage rules.

Additional checks:

```bash
npm run balance:test
npm run career:test
npm run career:browser
npm run accounts:test
npm run accounts:browser
npm run keybindings:test
npm run keybindings:browser
npm run lobby:large:test
npm run lobby:large:browser
npm run maps:test
```


## Bot difficulty and distant perception

The lobby host chooses Easy, Normal or Hard separately for each bot. Easy remains
the default. The server validates slot ids and levels, rejects changes after
launch, resets readiness on edits and preserves choices for retained slots across
map and mode changes. Player health, weapon damage and movement physics are shared
with humans on every difficulty.

Sight acquisition limits are 104, 120 and 140 metres. Recognition is probabilistic:
stance-aware voxel/smoke rays estimate exposed body area, and its projected angular
area decreases with squared distance. An exponential evidence threshold is sampled
once per new sighting, then accumulated after the difficulty's minimum reaction
time. This is a game salience model rather than an exact rendered silhouette.
Full cover blocks detection, partial cover delays it, and hidden positions never
refresh a bot's last-seen memory. Difficulty also controls aim error, turn speed,
burst pauses and memory duration.

Run `npm run bots:difficulty:test` for probability, authority and real WebSocket
checks; `npm run bots:difficulty:browser` covers host/member controls, mobile
layout, map changes and a live match start.

### Account keybindings

Signed-in players load keyboard bindings from `GET /api/account/keybindings`. Changes and resets use authenticated, same-origin `POST` requests with the current `userId` and normalized `keybindings`. PostgreSQL migration 4 adds the nullable `vb_accounts.keybindings` JSONB column. Existing accounts adopt the guest browser bindings on first use; subsequent sign-ins load the saved account settings. Guest and account browser caches are separate. Failed synchronization retries while the page remains open.

`npm run keybindings:test` checks input and account synchronization, including account switches and edits during loading. `npm run postgres:test` verifies account isolation, access checks, cross-device reads and persistence after app/database restart.
