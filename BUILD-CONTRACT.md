# Voxel Blitz — Build Contract

This is the authoritative implementation contract. Reuse the shared modules and
room/client interfaces below; do not fork their logic into a second convention.

## Fixed architecture
- `node server/index.js` serves `/public` statically and hosts `ws` on the same
  port (`PORT`, default `8070`).
- The browser uses plain ES modules and vendored three.js r180; there is no
  bundler or frontend build.
- Shared sim modules imported by both sides are `shared/worlddata.js`,
  `shared/modes.js`, `shared/raycast.js`, `shared/combatmath.js`, and
  `shared/noise.js`.
- One room owns one map clone, `GameEngine`, `ModeController`, optional
  `BotManager`, and room-scoped transports. The server remains authoritative at
  20 Hz.

## Run and contract harnesses
- `npm start` runs `node server/index.js` on `PORT` or `8070`.
- `npm run smoke` runs `tools/smoke.mjs` for the base gameplay protocol.
- `npm run lobby` runs `tools/lobby-smoke.mjs` for room and lobby behavior.
- `npm run modes:lobby` runs `tools/mode-lobby-smoke.mjs` for selected
  mode/map lobby, wire, isolation, and lifecycle behavior.
- `npm run modes:bots` runs `tools/bot-mode-smoke.mjs` for deterministic bot
  behavior in Fun, TDM, and S&D.
- Standard `npm test` runs `tools/atlastest.mjs`, `tools/smoke.mjs`,
  `tools/lobby-smoke.mjs`, `npm run modes:lobby`, and `npm run modes:bots`, in
  that order.

## Protocol (WebSocket; JSON text except the map)
### Client → server
The first non-binary frame is exactly one admission shape:
- `{t:'join',name:string,bots?:number}` selects quick play. It joins the first
  live shared Fun room with capacity or creates one. `bots` defaults to zero and
  applies only to a newly created quick room. Fresh quick rooms rotate between
  `foundry` and `depot`.
- `{t:'create',name:string,bots:number,gameMode?:'fun'|'tdm'|'snd',
  map?:'foundry'|'depot'|'citadel'}` creates a public waiting lobby. Omitted
  values default to `fun` and the first compatible map. An explicitly
  incompatible mode/map pair is malformed.
- `{t:'join',name:string,lobby:string}` joins a public waiting or live lobby and
  inherits its authoritative mode and map.

`bots` is an integer from `0` through `7`. Admission frames reject extra keys.
Names are sanitized to at most 16 characters after admission validation.

After admission:
- `{t:'ready',value:boolean}` sets this human's readiness while a public room is
  waiting.
- `{t:'start'}` starts only for the current host, while waiting, after every
  human member (including the host) is ready.
- `{t:'input',seq:number,keys:{f:boolean,b:boolean,l:boolean,r:boolean,
  jump:boolean,sprint:boolean,crouch:boolean,interact:boolean},yaw:number,
  pitch:number,weapon:number,wantFire:boolean,wantAds:boolean,reload:boolean,
  switchTo?:number}` routes only to this member's live room.
  Weapon slots clamp to `0–5`; keyboard digits are `1–6`.
- `{t:'buy',weapon:'rifle'|'smg'|'shotgun'|'sniper'|'lmg'|'revolver'}` requests
  an S&D prep-phase purchase.
- `{t:'chat',text:string}` broadcasts at most 120 trimmed characters only to
  this member's room.
Client binary frames are ignored. Sockets must admit within 10 seconds, may
send at most 180 messages/s, and may send at most 64 KiB per frame.

### Server → client
- Every successful admission sends
  `{t:'welcome',id,mapBytes,tickRate,spawn:{x,y,z},
  lobby:{code,role:'host'|'member'},phase:'waiting'|'live',gameMode,map}`
  immediately followed by exactly one binary frame of `mapBytes` bytes. The
  binary frame is the admitted room's current mutable map. `welcome.lobby.role`
  is admission-time information; later `lobbyState.host`, `gameMode`, and `map`
  are authoritative.
- Room members receive full replacements
  `{t:'lobbyState',code,host,phase:'waiting'|'live',bots,gameMode,map,
  members:[{id,name,ready,bot}]}` after create/join, readiness changes, start,
  leave, and host migration. Bot rows appear only after the room is live.
- At 20 Hz a live room sends
  `{t:'tick',now,match,players:[...],blocks:[{i,v}],events:[...]}`.
  `match` has exactly
  `{mode,map,phase,phaseEndsAt,scores,winner,round,roundWinner,attackers,
  defenders,bomb}`. Team scores are `{alpha,bravo}` or `null`; S&D `bomb` is
  `{state,carrier,site,x,y,z,explodeAt}` and is `null` in other modes.
  Fun uses `live`; TDM uses `live|'post'`; S&D uses
  `prep|'live'|'post'`. Bomb state is
  `'carried'|'dropped'|'planted'|'defused'|'exploded'`.
- Each player row has exactly
  `{id,name,x,y,z,yaw,pitch,hp,panic,exhaustion,weapon,score,kills,deaths,
  state,firing,ads,mag,reserve,reloading,team,credits,owned,bomb,interaction}`.
  `team` is `'alpha'|'bravo'|null`; `owned` is an array of weapon ids;
  `interaction` is `{kind:'plant'|'defuse',site,progress}` or `null`; `bomb`
  marks the carrier. `state` is `'alive'|'dead'`. Panic and exhaustion are
  authoritative normalized values and are not HUD meters.
- Gameplay and mode events live in `tick.events`; they are not separate
  top-level deliveries. Combat events remain:
  - `{t:'ev',kind:'shoot',id,o:[x,y,z],d:[x,y,z],w,spread:[x,y,z]}`
  - `{t:'ev',kind:'hit',attacker,victim,dmg,hs,vx,vy,vz}`
  - `{t:'ev',kind:'kill',killer,victim,w,hs}`
  - `{t:'ev',kind:'block',x,y,z,v:0,from}`; the same mutation appears in
    `tick.blocks` at `i=(y*SZ+z)*SX+x`
  - `{t:'die',kind:'die',id}` and
    `{t:'respawn',kind:'respawn',id,x,y,z}`
- Mode events use `{t:'ev',kind,at,...fields}`. Their kinds and supplemental
  fields are: `team_assigned`/`team_removed` (`id,team`), `team_score`
  (`team,score`), `phase` (`mode,phase,endsAt,round?`), `match_start`
  (`mode,scores`), `match_end` (`mode,winner,scores`), `round_start`
  (`round,attackers,defenders`), `round_end` (`round,winner,reason,scores`),
  `halftime` (`attackers,defenders`), `credits`
  (`id,amount,credits,reason`), `purchase` (`id,weapon,price,credits`),
  `bomb_assigned` (`id,round`), `bomb_drop` (`id,reason,x,y,z`),
  `bomb_pickup` (`id`), `bomb_plant` (`id,site,x,y,z,explodeAt`),
  `bomb_defuse` (`id,site`), `bomb_explode` (`site,x,y,z`), and
  `interaction_start`/`interaction_cancel` (`id,action,site`).
- Each retained client snapshot and all nested rows, match data, blocks, and
  events are immutable copies. A 32-entry newest-last ring retains tick events
  long enough for interpolation; the client drains each visible event exactly
  once in arrival order and keeps the most recently drained batch in
  `latestEvents`.
- Recoverable command failures send `{t:'error',msg}`. Malformed first frames
  send the error then close `4002`; unknown public lobbies close `4004`; full
  rooms or room-capacity exhaustion close `4005`. Global capacity is 32
  sockets, with 16 active rooms and eight humans per room.

Validation rule: the server recomputes shot direction from stored yaw/pitch and
the shared `computeSpreadConeDeg()` result, including authoritative
panic/exhaustion, with only the documented aim tolerance. It never accepts
client damage claims.

## Module APIs (exact)
### shared/worlddata.js
Exports block ids `AIR` through `PALE`, `BLOCK_HP`, `SX`, `SZ`, `SY`, `GROUND`,
`SEED`, the default-Foundry functions `getBlock`, `setBlock`, `heightAt`,
`findSpawns(n)`, `serializeWorld()`, `deserializeWorld(buf)`,
`rebuildHeightMap()`, `generateWorld()`, and
`createWorldState(serializedBytes?)`. It also exports `getMapMeta(id)` and
`createMapState(id,serializedBytes?)`.

`createMapState` accepts `foundry`, `depot`, or `citadel` and returns an
independent `{mapId,meta,getBlock,setBlock,heightAt,findSpawns,serializeWorld,
rebuildHeightMap}`. Templates are generated and cached once, then cloned for
each room. `meta` is deeply frozen and has
`{id,name,modes,spawns:{fun,tdm:{alpha,bravo},snd:{attackers,defenders}},
sites,landmarks}`. Serialized map dimensions/header remain common across maps;
the map id travels in JSON. `createWorldState` remains the default Foundry API.

### shared/modes.js
Exports immutable `MODE_IDS=['fun','tdm','snd']`,
`TEAM_IDS=['alpha','bravo']`, `MAP_IDS=['foundry','depot','citadel']`,
`MODE_RULES`, `MAP_MODE_COMPATIBILITY`, S&D credit constants,
`WEAPON_PRICES`, defaults, validators/normalizers for mode/team/map/weapon ids,
and `isModeMapCompatible(modeId,mapId)`. This is the browser/server source of
truth for mode ids, map compatibility, timings, and economy.

### shared/combatmath.js
Exports `WEAPONS`, `WEAPON_IDS`, `CONDITION_RULES`, `GRAVITY`, `PLAYER_HALF`,
`EYE_HEIGHT`, `HEADSHOT_Y_FRAC`, `damageAtDistance(def,dist)`,
`sampleSpreadDir(fwd,rng,halfAngleDeg)`, `angleBetweenDeg(a,b)`, and
`computeSpreadConeDeg(def,bloomDeg,speedXZ,adsT,panic=0,exhaustion=0)`.
`CONDITION_RULES` is the single source for panic/exhaustion gain, decay, and
recovery. The condition penalty is exactly
`(panic*0.85 + exhaustion*1.15) * (1 - adsT*0.45)` degrees.

The slot roster is exactly
`['rifle','smg','shotgun','sniper','lmg','revolver']`:

| slot/key | display name | mode | rpm | mag/reserve | close→far damage @ end | head | pellets | hip/ADS cone | mass |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|
| 0 `rifle` | VK-77 RAPTOR | auto | 660 | 30/180 | 25→15 @ 65 | 1.85× | 1 | 1.35°/0.28° | 3.4 kg |
| 1 `smg` | HORNET SMG | auto | 900 | 36/216 | 19→10 @ 42 | 1.70× | 1 | 1.90°/0.75° | 2.3 kg |
| 2 `shotgun` | M-DOCK 12 | pump | 78 | 7/42 | 13→3 @ 24 | 1.35× | 9 | 4.40°/3.10° | 3.6 kg |
| 3 `sniper` | LONGSHOT MK-II | bolt | 42 | 5/30 | 95→68 @ 120 | 2.10× | 1 | 5.50°/0.02° | 5.2 kg |
| 4 `lmg` | BASTION LMG | auto | 720 | 60/240 | 22→14 @ 75 | 1.70× | 1 | 1.65°/0.48° | 8.4 kg |
| 5 `revolver` | IRONCLAD .44 | semi | 300 | 6/48 | 54→35 @ 80 | 1.90× | 1 | 1.15°/0.12° | 1.4 kg |

Damage is flat to 20 world units, then falls linearly to the table's far value
at the listed end. All remaining cadence, bloom, recoil, ADS, reload, deploy,
tracer, mass, and SFX fields are read from `WEAPONS`; do not duplicate them.

### shared/raycast.js
`raycastVoxels(solidAt,ox,oy,oz,dx,dy,dz,maxDist)` returns
`{x,y,z,nx,ny,nz,t}|null`, normalizes any finite nonzero direction, and
enforces `maxDist`; `computeBlockedMuzzle` performs short cover probes.

## Lobby and room lifecycle
- Invite codes are five uppercase characters from
  `ABCDEFGHJKMNPQRSTUVWXYZ23456789`, generated server-side, collision checked,
  and accepted case-insensitively. The share URL is exactly
  `${location.origin}${location.pathname}?lobby=${code}`. Invite admission is
  for public rooms; quick-room codes are not a public join surface.
- A room owns one fresh `createMapState(map)` result, one `GameEngine` with its
  sole `ModeController`, an optional `BotManager`, and transport callbacks
  scoped to its human members. Mode and map stay fixed for the room lifetime.
- Create and waiting-room join add the human to the paused engine and send
  welcome plus the room map immediately. Inputs are ignored until the room is
  live; a live late join is added to the already-running engine.
- Every human, including the host, must be ready. Bots do not count. A valid
  host start changes `waiting` to `live`, attaches configured bots, starts the
  engine, and broadcasts the replacement state.
- Direct quick-play clients share a live Fun room until it reaches eight
  humans. Quick play bypasses readiness, rotates Foundry/Depot for fresh rooms,
  and starts a new room immediately.
- Public live late joins are valid. They receive the current selected-map bytes
  without returning the room to waiting. An S&D live/post late join is assigned
  a balanced team and remains dead until the next round; a prep join may spawn
  and buy.
- The first admitted human is host. If the host leaves, the earliest remaining
  human by admission order is promoted. When no humans remain, the engine is
  stopped, bots are disposed, member metadata is cleared, and the code is
  released. A failed admission rolls back engine, member, host, and metadata
  changes; an empty newly created room is destroyed.
- Chat, input, snapshots, block mutations, gameplay/mode events, lobby state,
  host changes, and map state never broadcast outside their owning room.

`LobbyManager` is constructed with
`{sendJson(meta,obj),sendFrame(meta,bytes),closeClient(meta,code,reason),tickMs}`
and exposes `quickPlay(meta,name,bots?)`,
`create(meta,name,bots,gameMode?,map?)`, `join(meta,name,code)`,
`ready(meta,value)`, `start(meta)`, `input(meta,msg)`, `buy(meta,weapon)`,
`chat(meta,text)`, `leave(meta)`, and `stop()`.

## Browser APIs (exact)
### NetClient
`new NetClient()` is safe to construct/import without a browser WebSocket.

- `connect(url,name,{mode?:'quick'|'create'|'join',bots?:number,lobby?:string,
  gameMode?:string,map?:string})` sends the matching admission frame and
  resolves only after welcome/binary pairing. Assign
  `net.onMap = (bytes) => { ... }` to receive the map before resolution.
  Omitting `mode` means quick.
- State fields are `welcome`, `id`, `mapBytes`, `tickRate`, `spawn`,
  `latestSnapshots`, `latestEvents`, `latestLobbyState`, `latestMatch`, `ping`,
  and `dirty`. Welcome, lobby, snapshots, rows, match data, and events are
  immutable copies. `latestLobbyState` is
  `{code,host,phase,bots,gameMode,map,members,selfId}`.
- `on(type,fn)` returns an unsubscribe function; `off(type,fn)` removes it.
  Observable types are `open`, `close`, `welcome`, `lobby`, `serverError`,
  `tick`, `chat`, and every combat/mode event `kind`.
- `isOpen()`, `sendInput(input)`, `setReady(boolean)`, `requestStart()`,
  `buyWeapon(id)`, and `close()` return or act on the current socket. Send
  methods return `true` only when handed to an open socket and a valid request.
- `interpolate(renderNowMs,delayMs=100)` returns
  `{players:Map<id,row>,events,match}`. It excludes the local row, shortest-arc
  interpolates yaw, selects authoritative match state, and emits/drains each
  visible event once.

### HUD
- `buildMenu(onAction)` builds Quick Play/Create/Join and calls
  `onAction({mode:'quick'|'create'|'join',gameMode,map,name,bots,sensitivity,
  code})`. Create uses the selected compatible mode/map. Quick uses shared Fun
  admission; Join uses the code and inherits the room selection. Names trim to
  16 characters with `PLAYER` fallback; codes normalize to the invite alphabet
  and five characters. `?lobby=CODE` pre-fills and focuses Join.
  `showJoinState(message,tone?)` reports menu admission state.
- `showLobby(state,{onReady,onStart,onLeave})`, `updateLobby(state)`,
  `hideLobby()`, and `showLobbyStatus(message,tone?)` own the waiting UI. It
  renders authoritative mode/map chips, code/link, and full roster; uses a real
  ready toggle with `aria-pressed`; shows Start only to the host; and disables
  Start until every human is ready. Copy uses
  `${location.origin}${location.pathname}?lobby=${code}`;
  `copyInviteLink(url)` returns `Promise<boolean>` and reports through the
  lobby's `aria-live` status. Leave returns to the main menu.
- `setupBuyMenu({onBuy,onClose})`, `setBuyMenuState({open,phase,credits,owned})`,
  `toggleBuyMenu(force?)`, `closeBuyMenuDirect()`, and `isBuyMenuOpen()` own the
  accessible S&D armory. It opens only during prep, displays exact shared
  prices/ownership/affordability, and sends the chosen weapon id.
- `setMatchState(match,selfRow,players,serverNow)` renders mode/map, team scores,
  phase clock, S&D round/role/bomb state, interaction progress, and credits from
  authoritative state. Team colors apply to HUD and scoreboard.
- `setupSettings({sensitivity,volume,fov,onChange,onResume})`,
  `openSettings()`, `closeSettings()`, and getter `settingsOpen` own settings.
  Settings, buy, and lobby dialogs are mutually exclusive and suppress gameplay.
  `onChange` receives the full `{sensitivity,volume,fov}` object.
- `buildHUD()`, `menuDone()`, and
  `setState({hp,mag,reserve,wname,wid,bloomPx,reloading01,yawDeg,adsT01,alive})`
  own the live HUD. `spreadFromBloom(deg)`, `setSpread(px)`,
  `hideCrosshairForAds(boolean)`, `setReloadProgress(t01|null)`,
  `updateCompass(yawDeg)`, `pushEvent(ev)`, `hitmark(headshot)`,
  `setOwnDamage(intensity01)`, `setDead(dead,killerName?)`,
  `spawnDamage(amount,sx,sy,visible?,headshot?)`, `setScoreboard(boolean)`,
  `setPlayers(rows)`, `setScope(boolean)`, and `dispose()` are the remaining
  live-HUD surface used by the game.

The game must not build, pointer-lock, or start live gameplay for a public room
until `lobbyState.phase === 'live'`. Quick play proceeds directly; a public
late join whose welcome/state is already live also proceeds directly.

### Input, rendering, effects, and viewmodel
- `new Input(canvas).start(canvas,onLockChange)`; poll `getKeys()` for movement
  plus held `interact`, read `yaw`/`pitch`, and drain fire, reload, weapon, and
  buy-menu edge consumers. `E` holds interact; `B` toggles the buy menu;
  `1–6`/wheel/`Q` select weapons. `setGameplayEnabled(boolean)` gates input
  around lobby, settings, buy, death, and teardown.
- `new WorldView({getBlock})`; call `await ready()` before rendering,
  `applyDeltas([{x,y,z,v}])`, `update(dt)`, camera ray helpers, and `dispose()`.
- `new Effects(scene,camera,worldGetBlockFn)` exposes
  `shoot(ev,{local?})`, `impact(evHit)`, `explodeBlock(x,y,z,blockId)`,
  `spawnBrass(pos,velocity)`, `update(dt)`, `shake(amount)`,
  getter `currentShakeXY`, and `dispose()`.
- `new ViewmodelRig(camera)` exposes `setWeapon(id)`, `fire()`, `ads(t01)`,
  `reload(dur,type)`, `pumpAnim()`, `boltAnim()`,
  `update(dt,{speed,grounded,panic?,exhaustion?})`, and `bobAmt`.
  It builds six procedural models; turn lag affects only the rig, never
  camera/authority aim.

### Audio
`sfx` exports:
`init():Promise`, `unlock():Promise<boolean>`, `dispose():Promise<void>`,
`setMasterVolume(value)`,
`fire(key,{muffled?:boolean,pos?:[x,y,z]}|[x,y,z]?)`,
`impact(kind:'stone'|'wood'|'glass'|'metal'|'flesh',volume,
{muffled?:boolean,pos?:[x,y,z]}|[x,y,z]?)`,
`reloadClick(step:1|2|3,weaponKey)`, `hitmark(headshot)`,
`deathFar(volume?)`, `footstep(volume?)`, `draw(weaponKey)`,
`bulletWhiz(volume?)`, and `setListener({fwd:[x,y,z],pos:[x,y,z]})`.
All sound methods are safe before initialization. `init()` and `unlock()` are
idempotent, every voice routes through the clamped master volume and limiter,
and `dispose()` closes the owned context and clears voices/timers. Fire and
impact support HRTF positions; the engine caps 48 voices total and 16
positional voices.

### Server bots
`attachBots(engine,n)` returns a `BotManager`. Bots are direct engine entities,
submit through `applyInput`, do not consume human capacity, and exist only while
their room is live. They obey target eligibility and friendly-fire rules, use
mode-specific spawn pools, avoid fire during S&D prep, buy affordable S&D
weapons, recover/escort/plant/guard/defuse the bomb, and dispose their engine
step listener with the room.

## Runtime gameplay contracts
- **Fun (`fun`):** free-for-all target eligibility, complete six-weapon
  loadouts, friendly-fire/team logic not applicable, no score-limit reset, and
  `1500 ms` respawn. Shared quick rooms allow join in progress with no ready
  gate.
- **Team Deathmatch (`tdm`):** persistent `alpha`/`bravo` assignment chooses the
  lower human+bot population; friendly fire is disabled and every player owns
  the complete six-weapon loadout. Enemy kills increment the killer's team
  score. First to `40` enters a `5000 ms` post phase, then team/player scores
  reset and all players respawn. Live deaths respawn after `3000 ms` at the
  player's team spawn pool.
- **Search and Destroy (`snd`):** persistent `alpha`/`bravo` teams map to
  attackers/defenders, friendly fire is disabled, and roles swap after 6
  completed rounds. First to 7 round wins wins the match. Each round is
  `prep 10000 ms`, `live 90000 ms`, and `post 5000 ms`; firing is disabled
  during prep and there is no round respawn. Every participant respawns at
  round start.
- **S&D objective:** one attacker carries the bomb. A carrier holds interact
  inside A/B for `3000 ms` to plant. A defender holds interact within 2 units
  for `5000 ms` to defuse. The fuse is `40000 ms`; dropped-bomb auto-pickup
  radius is 1.4 units. Carrier death/disconnect drops at the last position.
  Tick outcome priority is explosion, completed defuse, elimination, then
  unplanted time expiry. A planted bomb keeps the round live after attacker
  elimination.
- **S&D economy:** players start with 800 credits; kill +300, plant +300, round
  win +3250, and consecutive losses +1400/+1900/+2400/+2900/+3400, capped at
  16000. Prices are revolver 0, SMG 1250, shotgun 1800, rifle 2700, LMG 4000,
  sniper 4750. Only alive participants buy during prep. A purchase owns,
  selects, and refills that weapon. New/dead players start the next round with
  revolver; survivors retain purchases and remaining ammunition.
- **Map compatibility:** `foundry` supports Fun/TDM/S&D; `depot` supports
  Fun/TDM; `citadel` supports Fun/TDM/S&D. Foundry has A/B sites, Depot is a
  compact point-symmetric cargo map, and Citadel has Courtyard A and elevated
  Compound B with separated sightlines and rotation paths. Every declared spawn
  has solid footing and two-block headroom.
- **Settings:** sensitivity defaults to `0.030`, clamps to `0.005–0.08`, and
  persists as `vb-sens`; master volume defaults to `0.80`, clamps to `0–1`, and
  persists as `vb-volume`; FOV defaults to `75`, clamps to `65–100`, and
  persists as `vb-fov`. Changes apply immediately. Escape opens the in-game
  settings overlay; Resume closes it and returns pointer-lock gameplay.
- **Scope:** only `sniper` at `adsT01 >= 0.72` receives the transitioning
  full-screen 5× circular optic through `HUD.setState`. Its outside mask is
  opaque; the reticle has crosshairs, mildots, and range ticks. The viewmodel
  hides only while fully scoped.
- **Audio:** all sound is synthesized procedural WebAudio; there are no media
  files. Weapon reports, reloads, impacts, hitmarks, distant deaths, footsteps,
  draws, bullet whizzes, echo, and positional listener updates all route
  through `sfx`.
- **Authority:** one room engine simulates movement, ammo, reloads, spread,
  hits, destruction, death, score, and respawn at 20 Hz. The client predicts
  feel/FX but accepted shots and all damage are server decisions. Shooter-side
  rewind uses the 100 ms interpolation delay within a 500 ms history window.
- **Death:** snapshot `state` plus `die`/`respawn` events are authoritative.
  Remote avatars collapse for about 1.2–1.5 seconds before hiding; respawn
  restores every transform. Local death applies a deterministic camera
  fall/roll and respawn resets it. Fun respawns after 1500 ms, TDM after
  3000 ms, and S&D only at a round start.
- **Movement:** walk is 4.4, sprint 6.2, and crouch 2.2 m/s; jump velocity is
  8.2; eye height 1.62; ground acceleration 10/s; air control is 30% of that;
  gravity is 24. Sprint has a visibly stronger leg-driven cycle than walk.
- **Hidden conditions:** panic gains `damage*0.012 + (headshot ? 0.22 : 0)`,
  clamps to `0–1`, and decays at `0.20/s` toward the low-health floor
  `0.45*(1-hp/100)`. Exhaustion gains `0.24/s` while sprinting, `0.14` per
  accepted jump, and `0.025` per accepted shot; otherwise it recovers at
  `0.18/s`. It clamps to `0–1`. Both reset on death/respawn, add deterministic
  tremor/breathing and shot-cone penalty, and remain snapshot-only—not HUD
  meters.
- **Weapon lag:** `weightKg` increases procedural turn-lag amplitude and slows
  viewmodel settling. It does not delay or alter camera/authority aim.
- **Worlds:** Foundry, Depot, and Citadel are deterministic 128×40×96 templates.
  Every room mutates an independent clone of its selected map. Block damage and
  serialized late-join state remain local to that room.

## Container deployment

- Runtime is one Node.js 20+ process started with `npm start`; it serves static
  assets and WebSockets on the same `PORT`.
- A Dockerfile or Dokploy service installs from the lockfile, includes
  `server/`, `shared/`, `public/`, `package.json`, and `package-lock.json`, and
  routes HTTP plus WebSocket upgrades to the same internal port. There is no
  frontend build command or sidecar service.
- Rooms and worlds are in-memory. Container replacement clears active lobbies,
  invite codes, maps, and scores; the runtime contract requires no persistent
  volume.
- Hostname, TLS termination, health-check policy, and public URL are deployment
  configuration. This contract contains no environment-specific public URL.

## Done means
Implementations use the exact wire shapes, room boundaries, module names, and
observable behavior above. Contract changes update the relevant harness and
this document in the same change.
