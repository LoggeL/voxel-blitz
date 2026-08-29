# VOXEL BLITZ

Browser multiplayer voxel arena shooter. One Node process serves the game **and**
runs the authoritative 20 Hz simulation over WebSockets; clients are plain
three.js ES modules (no bundler). Six hand-tuned guns with a full "gun UX"
stack: procedural viewmodels, staged timer-driven animations, bloom/recoil,
ADS, tracers, shell ejects, muzzle flash + barrel heat shader, block-shatter,
damage numbers, hitmarkers, killfeed, a full-screen sniper optic, synthesized
WebAudio layers, transient-aligned licensed firearm samples, and menu music.
Every weapon has a dedicated generated HUD silhouette. The live HUD also shows
measured round-trip history, arrival jitter, the adaptive snapshot buffer, FPS,
and two server-authoritative terrain grenades per life.

## Run

```bash
npm install
npm start            # http://localhost:8070  (PORT env to override)
```

The main menu has three admission paths:

- **Quick Play** enters the first live shared Fun room with human capacity, or
  creates one immediately. Fresh quick rooms rotate between Foundry and Depot.
  A fresh room starts with at least five bots; humans replace bots as they join.
  The menu's custom mode and map selectors do not change quick play.
- **Create Lobby** creates a public waiting room with the selected game mode,
  compatible map, and `0–7` bots. Every human, including the host, marks ready;
  the host starts the match after all humans are ready.
- **Join** accepts a five-character invite code and inherits the room's
  authoritative mode and map. It may enter either a waiting lobby or a match
  already in progress.

The lobby displays its mode, map, roster, invite code, and copyable invite URL,
constructed as `${location.origin}${location.pathname}?lobby=${code}`. Loading
that query preselects Join and pre-fills the normalized code. Codes are
case-insensitive, uppercase on the wire, and use
`ABCDEFGHJKMNPQRSTUVWXYZ23456789`.

Headless clients can join quick play from additional shells:

```bash
node tools/bot.mjs --name BotOne
```

The standard verification commands are:

```bash
npm run smoke        # base gameplay/protocol smoke
npm run lobby        # room lifecycle and lobby protocol smoke
npm run modes:lobby  # selected mode/map lobby and wire contracts
npm run modes:bots   # deterministic bot behavior in all four modes
npm test             # atlas/world, smoke, lobby, mode-lobby, then bot-mode smoke
npm run container:smoke # HTTP + WebSocket check against BASE_URL or localhost
npm run browser:smoke   # connected menu, Quick Play, pause/resume, and quit flow
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
run writes 18 PNGs plus `index.html` and `manifest.json` to
`.artifacts/weapon-renders/` for side-by-side visual review.
The avatar flow renders those same canonical models on remote-player bodies in
front, profile, firing, ADS-profile, and crouched-profile views, plus one
representative ally-spectator shot. The focused 31-frame matrix is written to
`.artifacts/avatar-renders/`.

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
surface without requiring pointer lock. Main, create-lobby, and waiting-lobby
states remain reachable through their normal controls. The 3D scene is graded
through a bounded combat post-process with subtle detail recovery and
pain/panic feedback; DOM HUD stays untouched, and `?shader=off` exercises the
direct-render fallback.

## Multiplayer lifecycle

Every admitted client receives a JSON `welcome` carrying the authoritative
`gameMode` and `map`, immediately followed by exactly one binary frame for that
room's current map. Room members also receive immutable full `lobbyState`
replacements after membership, readiness, phase, or host changes; those
replacements retain the room's mode and map. Quick rooms remain live and bypass
the waiting UI.

- A created public room remains paused in `waiting`. Every human—including the
  host—must mark ready; bots never participate in readiness. Only the host can
  start, and Start remains gated until all humans are ready.
- Starting changes the room to `live`, attaches its bots, and starts its
  authoritative 20 Hz engine. A human may join a live public room later and
  receives that room's current, already-mutated map before gameplay begins.
- If the host leaves, the earliest remaining human becomes host. When the last
  human leaves, the engine stops, bots are disposed, and the room/code is
  released.
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
six-weapon loadout, and a **1500 ms** respawn. Quick Play uses shared live Fun
rooms with join in progress and no ready gate.

### Team Deathmatch

Team Deathmatch assigns each player to the lower-population `alpha` or `bravo`
team, disables friendly fire, provides the complete six-weapon loadout, and
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
| SMG | 1250 |
| shotgun | 1800 |
| rifle | 2700 |
| LMG | 4000 |
| sniper | 4750 |

Dead/new players begin the next round with the revolver. Round survivors retain
their purchases and remaining ammunition. Weapons cannot fire during prep.

### Gun Game

Gun Game is a free-for-all with a **1500 ms** respawn. Every kill advances the
player through rifle, SMG, shotgun, sniper, LMG, and finally revolver. A kill
with the revolver wins; a **5000 ms** result phase follows before progression
and scores reset.

### Map compatibility

| map id | modes | identity |
|---|---|---|
| `foundry` | Fun, TDM, S&D, Gun Game | industrial Foundry with A/B sites |
| `depot` | Fun, TDM, Gun Game | point-symmetric cargo Depot |
| `citadel` | Fun, TDM, S&D, Gun Game | Citadel with Courtyard A and elevated Compound B |

## Controls

| input | action |
|---|---|
| `WASD` | move (`Shift` sprint); `W` / `S` climb up / down while touching a ladder |
| `Shift` while stationary | hold breath until the pain/panic-limited budget is spent |
| `Space` | jump; climb up while touching a ladder |
| `Ctrl` / `C` | crouch; climb down while touching a ladder |
| mouse1 / mouse2 | fire / ADS |
| `R` | reload |
| `G` | throw one server-authoritative terrain grenade (2 per life) |
| `1-6` / wheel | weapon slots |
| `Q` | previous weapon; while dead, previous spectator target |
| `E` | hold S&D interaction; while dead, next spectator target |
| arrow keys while dead | previous / next spectator target |
| `B` | open/close the S&D buy menu |
| `Tab` | scoreboard |
| `Escape` | close an overlay, or open settings / resume / quit to main menu |

## The six guns

| gun | mode | rate | ammo | feel identity |
|---|---:|---:|---:|---|
| **VK-77 RAPTOR** rifle | automatic | 660 rpm | 30 + 6 mags | climbing-descent burst cadence, amber rail accents |
| **HORNET SMG** | automatic | 900 rpm | 36 + 6 mags | fast springy low-kick spray, tan polymer |
| **M-DOCK 12** shotgun | pump | 90 rpm | 7 + 6 mags | tight ADS buckshot, firm pump shove, staged clack-clack |
| **LONGSHOT MK-II** bolt sniper | bolt | 42 rpm | 5 + 6 mags | 5× full-screen optic, rotary long-throw bolt, canyon echo crack |
| **BASTION LMG** | automatic | 720 rpm | 60 + 4 mags | heavy sustained fire and the slowest viewmodel settling |
| **IRONCLAD .44** revolver | semi-automatic | 300 rpm | 6 + 8 mags | high-damage precision sidearm with fast handling |

Gun timing lives in `public/js/guns/defs.js` (timer table per weapon); shared
ballistics/damage in `shared/combatmath.js`; authoritative resolve in
`server/game.js`. The server re-samples every shot's spread cone itself from
your reported view angles — client damage claims are never trusted.

## Feel and settings

Weapon mass is part of the shared definition: rifle 3.4 kg, SMG 2.3 kg,
shotgun 3.6 kg, sniper 5.2 kg, LMG 8.4 kg, and revolver 1.4 kg. Mouse aim and
server authority remain immediate; only the procedural gun model trails a turn.
Heavier weapons lag farther and settle more slowly.

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

`Escape` opens the in-game settings panel. Sensitivity (0.005–0.08, default
0.018), master
volume (0–1), and field of view (65–100) apply immediately and persist under
`vb-sens`, `vb-volume`, and `vb-fov`. Resume closes the panel and returns to
play; Quit to Main Menu cleanly leaves the active match. While dead, a
collision-safe chase camera follows legal living targets and displays the
authoritative respawn deadline; S&D deaths remain spectators until the next
round. Audio unlocks idempotently after a user
gesture, and routes every sound through the persisted master-volume control.

Reloading drops the active magazine immediately, including its remaining
rounds. Completing the reload consumes one full spare magazine; interrupting it
does not restore the dropped magazine. The HUD and buy menu therefore expose
spare magazine counts instead of a loose reserve-round total.

## Architecture

```
shared/    mode/map rules, world generation/store, DDA raycast, ballistics
server/    HTTP/ws host, room manager, authoritative 20 Hz sim, modes, bots
public/js/
  engine/  input, snapshots, timing/smoothing, chunk mesher, sky, combat shader
  guns/    defs (feel tables) + viewmodel rig (procedural models, staged anims)
  weapons/ pooled FX: tracers, impacts, shatter, shells, grenades, shake
  ui/      menu/lobby, match/network HUD, buy dialog, scoreboard, combat feedback
  audio/   sample bank + procedural WebAudio fallback, mix, music, voice limits
tools/     fast contracts plus isolated visual, audio, and container QA flows
```

Foundry, Depot, and Citadel are deterministic templates. Every room receives a
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
