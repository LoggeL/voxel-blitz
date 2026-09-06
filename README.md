# VOXEL BLITZ

Browser multiplayer voxel arena shooter. One Node process serves the game **and**
runs the authoritative 20 Hz simulation over WebSockets; clients are plain
three.js ES modules (no bundler). Ten hand-tuned weapons with a full "gun UX"
stack: procedural viewmodels, staged timer-driven animations, bloom/recoil,
ADS, tracers, shell ejects, muzzle flash + barrel heat shader, block-shatter,
damage numbers, hitmarkers, killfeed, a full-screen sniper optic, a radial
weapon wheel, synthesized WebAudio layers, transient-aligned licensed firearm
samples, and menu music.
Every weapon has a dedicated generated HUD silhouette. With `?debug=1`, the HUD
shows round-trip history, arrival jitter, the adaptive snapshot buffer, and FPS.
The live HUD shows three kinds of server-authoritative throwables per life: cookable frags,
sticky limpet charges, and concussive pulse shocks.

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
  in the browser URL. The host can change mode, compatible map and `0–7` bots
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
lobby frames. The client retains the password in memory for automatic reconnect;
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
npm test             # atlas/world, smoke, lobby, mode-lobby, then bot-mode smoke
npm run container:smoke # HTTP + WebSocket check against BASE_URL or localhost
npm run browser:smoke   # connected touch-mode menu, play, input, pause, and quit flow
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
front, profile, firing, ADS-profile, and crouched-profile views, plus one
representative ally-spectator shot. The focused 51-frame matrix is written to
`.artifacts/avatar-renders/`.

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
  authoritative 20 Hz engine. A human may join a live public room later and
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
- Capacity is eight humans per room, 16 active rooms per server process, and 32
  WebSocket connections globally. Bots do not consume human slots.

Malformed admission closes with code `4002`, an unknown invite with `4004`,
and a full room or 16-room exhaustion with `4005`; the server sends a JSON
`{t:'error',msg}` first.

## Game modes and maps

### Fun

Fun is a free-for-all with no teams, no score-limit reset, the complete
ten-weapon loadout, and a **1500 ms** respawn. Quick Play uses shared live Fun
rooms with join in progress and no ready gate.

### Team Deathmatch

Team Deathmatch assigns each player to the lower-population `alpha` or `bravo`
team, disables friendly fire, provides the complete ten-weapon loadout, and
uses team-specific spawn pools. Enemy kills increment the team score. The first
team to **40** wins; a **5000 ms** post-match phase follows, then team and player
scores reset and everyone respawns. Deaths respawn after **3000 ms** during the
live phase.

### Search and Destroy

Search and Destroy assigns persistent `alpha`/`bravo` teams to attacker and
defender roles and disables friendly fire. Roles swap after **6 completed
rounds**; the first persistent team to **7 round wins** wins the match. Each
round is **10000 ms prep**, **90000 ms live**, and **5000 ms post**. Players do
not respawn during a round; late joins during live spectate until the next
round.

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
VOLTLANCE, and finally the RIPPER knife. A kill with the RIPPER wins; a
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

### Map compatibility

| map id | modes | identity |
|---|---|---|
| `foundry` | Fun, TDM, S&D, Gun Game | industrial Foundry with A/B sites |
| `depot` | Fun, TDM, Gun Game | point-symmetric cargo Depot |
| `citadel` | Fun, TDM, S&D, Gun Game | Citadel with Courtyard A and elevated Compound B |
| `solstice` | Fun, TDM, S&D, Gun Game | desert solar observatory with a biodome, heliostat ring, and turbine hall |
| `caldera` | Fun, TDM, S&D, Gun Game | volcanic caldera with Obsidian Gate A and elevated Ember Refinery B |
| `killhouse` | Training | weapon-test firing range with respawning dummies and a timed 4-stage killhouse course |

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
| `Shift` while stationary | hold breath until the pain/panic-limited budget is spent |
| `Space` | jump; climb up while touching a ladder |
| `Ctrl` / `C` | crouch; climb down while touching a ladder |
| mouse1 / mouse2 | fire / ADS (`F` also aims; ADS is hold or toggle per the settings panel, toggle by default on trackpads) |
| `Z` / wheel while scoped | sniper zoom step (5× ↔ 2.5×) |
| `R` | reload; shotgun shells seat one at a time and firing interrupts the load |
| hold/release `G` | charge and throw the selected throwable; longer holds throw farther, and a frag cooks while held (hold past the fuse and it goes off in your hand) |
| `H`, or wheel while holding `G` | cycle the throwable: M-4 FRAG (2), LIMPET CHARGE (1, sticks to walls and players), PULSE SHOCK (2, impact concussion) |
| hold/release mouse1 with the LONGARC | charge the coilgun; release fires a bouncing bolt — a tap ricochets off one wall, a full charge ricochets three times |
| hold/release mouse1 with the VOLTLANCE | charge the rail-lance; release fires a lance that spears up to six enemies on the line, and only a full charge crosses up to two walls |
| mouse1 with the K-7 RIPPER | swing freely: swipes consume no ammo and never reload, and a strike from behind an enemy's facing backstabs for 2.5x |
| `1-9` / `0` / wheel | weapon slots (`1-9` and `0` also pick directly while the weapon wheel is open) |
| `Q` | previous weapon; hold instead opens the weapon wheel; while dead, previous spectator target |
| hold `Q` / middle mouse | open the radial weapon wheel: aim freezes, mouse motion or scroll highlights a wedge, releasing the held control or clicking equips it, and a centered release, `Esc`, or right mouse cancels |
| `E` | hold S&D interaction; while dead, next spectator target |
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
`Back` shows the scoreboard, and `Start` pauses. Pad sensitivity (radians per
second at full deflection) and aim assist live in the settings panel; aim
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
| **K-7 RIPPER** | melee | 120 rpm | no ammo — swings are free | free-swinging fighting knife: short-arc swipes that never reload, 2.5x backstabs from behind, and infinite ammo |

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
damped vertical spring while aim stays immediate. Damage builds panic and pain,
while sprinting, jumping, and firing build exhaustion. Those authoritative,
normalized conditions subtly add deterministic tremor/breathing and widen the
shot cone, but are deliberately hidden rather than exposed as HUD meters. They
reset on respawn. Crouching reduces stationary sway; standing still and holding
Shift holds breath for 2.4 seconds when calm, with pain and panic reducing that
budget as low as 0.7 seconds.

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
server/    HTTP/ws host, room manager, authoritative 20 Hz sim, modes, bots
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

Foundry, Depot, Citadel, Solstice, Caldera, and Killhouse are deterministic templates. Every room receives a
fresh mutable clone of its selected map. The current room map is serialized in
the single binary admission frame; subsequent block destruction is room-scoped
and streams as index deltas inside immutable client snapshots. Each tick also
carries authoritative `match` state and player `team`, `credits`, `owned`,
`bomb`, and interaction fields. Mode and combat events remain attached to their
owning snapshots and are dispatched once by the interpolation/event drain.
Measured RTT pings are independent of tick-arrival jitter. Remote transforms
use an adaptive 65–180 ms presentation buffer, shortest-arc interpolation, and
strictly capped extrapolation through short packet gaps. Server tick time is
mapped onto the page clock, and bounded hit rewind follows the target age the
client actually presented.

## Container deployment

Voxel Blitz needs one Node.js 20+ process and one HTTP port. A Dockerfile or
Dokploy service uses `npm start`, passes the runtime `PORT`, and routes both HTTP
and WebSocket upgrade traffic to that same internal port. There is no frontend
build step and no second service. Rooms, maps, scores, and invite codes live in
process memory, so a container restart clears active matches; no persistent
volume is part of the current runtime contract. Deployment-specific hostnames,
TLS, health checks, and public URLs remain platform configuration rather than
repository constants.
