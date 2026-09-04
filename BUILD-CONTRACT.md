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
  `shared/noise.js`. `shared/grenade-rules.js` is the shared throwable roster
  (`frag`, `limpet`, `pulse`), per-type inventory, charge/cook, clamp,
  throw-profile, and flight-integrator contract; `shared/rocket-rules.js` is the
  shared rocket launch/flight/blast contract, and `shared/bolt-rules.js` is the
  shared bolt launch/flight/ricochet contract.
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
  behavior in Fun, TDM, S&D, and Gun Game.
- Standard `npm test` runs `tools/atlastest.mjs`, `tools/smoke.mjs`,
  `tools/lobby-smoke.mjs`, `npm run modes:lobby`, and `npm run modes:bots`, in
  that order.
- `npm run browser:smoke` drives the connected touch-mode menu → Quick Play →
  live match, validates joystick/look/fire pointer lifecycles, then completes
  the pause/resume → quit flow in Chromium. `BROWSER_SMOKE_WIDTH`,
  `BROWSER_SMOKE_HEIGHT`, and `BROWSER_SMOKE_SCREENSHOT` opt into mobile visual
  capture. `npm run maps:capture`,
  `npm run weapons:capture`, and
  `npm run avatars:capture` produce deterministic Chromium review matrices;
  `npm run audio:audit` inventories and analyzes every bundled OGG;
  `npm run audio:mix` renders the production sample + synth + echo + limiter
  fire graph for every weapon in Chromium; and
  `npm run container:smoke` validates HTTP plus WebSocket behavior against
  `BASE_URL` or localhost.
- Push/pull-request CI runs only `npm test`. Scheduled/manual extended QA runs
  audio, visual captures, and the built-container smoke separately so the fast
  contract gate does not accumulate browser/container test bloat.

## Protocol (WebSocket; JSON text except the map)
### Client → server
The first non-binary frame is exactly one admission shape:
- `{t:'join',name:string,bots?:number}` selects quick play. It joins the first
  live shared Fun room with capacity or creates one. `bots` defaults to zero and
  applies only to a newly created quick room. Fresh quick rooms rotate between
  `foundry`, `depot`, `solstice`, and `caldera`.
- `{t:'create',name:string,bots:number,gameMode?:'fun'|'tdm'|'snd'|'gungame'|'training',
  map?:'foundry'|'depot'|'citadel'|'solstice'|'caldera'|'killhouse'}` creates a public waiting lobby.
  Omitted values default to `fun` and the first compatible map. An explicitly
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
  viewAge:number,throwGrenade?:boolean,grenadeCharge?:number,grenadeType?:number,
  grenadeCook?:number,switchTo?:number}`
  routes only to this member's live room. A grenade throw is release-edge
  triggered after holding `G`; authority clamps `grenadeCharge` to `0–1`, maps
  it to the shared throw-speed/lift profile, clamps `grenadeType` into
  `GRENADE_TYPE_IDS` (`0` frag, `1` limpet, `2` pulse), clamps `grenadeCook`
  (held milliseconds, timed fuses only) to the type's fuse, and consumes one
  grenade of that type for the current life only when the mode permits firing.
  A `grenadeCook` at or beyond the frag fuse detonates the grenade in the hand.
  `wantFire` held on a `charge`-mode weapon (LONGARC, VOLTLANCE) charges the
  capacitor and the shot leaves on release or when the hold reaches `holdMaxMs`.
  `viewAge` is the client's current presentation buffer plus measured RTT and
  is clamped by authority to `50–450 ms` before hit rewind.
  Weapon slots clamp to `0–9`; keyboard digits are `1–9` with `0` for the
  tenth slot.
- `{t:'ping',nonce:safe-integer}` receives `{t:'pong',nonce}` from the same
  socket so the client can measure application-level round-trip time.
- `{t:'buy',weapon:'rifle'|'smg'|'shotgun'|'sniper'|'lmg'|'revolver'|'longarc'|'rocket'|'lance'|'knife'}` requests
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
  Fun uses `live`; TDM and Gun Game use `live|'post'`; S&D uses
  `prep|'live'|'post'`. Gun Game's winner is a player id. Bomb state is
  `'carried'|'dropped'|'planted'|'defused'|'exploded'`.
- Each player row has exactly
  `{id,name,x,y,z,yaw,pitch,hp,panic,pain,exhaustion,spawnProtected,weapon,
  score,kills,deaths,state,respawnAt,firing,ads,crouch,mag,reserve,reloading,
  team,credits,owned,bomb,interaction,grenades,charge}`.
  `team` is `'alpha'|'bravo'|null`; `owned` is an array of weapon ids;
  `grenades` is the remaining per-type count array in `GRENADE_TYPE_IDS` order;
  `charge` is the normalized `0–1` capacitor charge of a held `charge`-mode
  weapon (`0` otherwise);
  `interaction` is `{kind:'plant'|'defuse',site,progress}` or `null`; `bomb`
  marks the carrier. `state` is `'alive'|'dead'`; `respawnAt` is the finite
  authoritative server deadline for an automatic respawn and otherwise
  `null`. `reserve` is a count of full spare magazines, not loose bullets.
  Panic, pain, and exhaustion are authoritative normalized values and are not
  HUD meters.
- Gameplay and mode events live in `tick.events`; they are not separate
  top-level deliveries. Combat events remain:
  - `{t:'ev',kind:'shoot',id,o:[x,y,z],d:[x,y,z],w,spread:[x,y,z],charge?}`
    (`charge` only on `charge`-mode weapons)
  - `{t:'ev',kind:'hit',attacker,victim,dmg,hs,vx,vy,vz}`
  - `{t:'ev',kind:'kill',killer,victim,w,hs}`
  - `{t:'ev',kind:'block',x,y,z,v:0,from}`; the same mutation appears in
    `tick.blocks` at `i=(y*SZ+z)*SX+x`
  - `{t:'ev',kind:'projectileLaunch',id,pid,type,o:[x,y,z],v:[x,y,z],fuse}`,
    with bolts additionally carrying `bn` (reflections left: 1 at a tap, 3 at a
    full charge), `{t:'ev',kind:'projectileStick',id,pid,x,y,z,to,fuse}` (a
    limpet on terrain has `to:null`, on a player `to` is that id), and
    `{t:'ev',kind:'projectileExplode',id,pid,type,x,y,z,radius}` where `type`
    is `'frag'|'limpet'|'pulse'|'rocket'|'bolt'`; a `'bolt'` explosion is the
    harmless fizzle (radius 0.5, no blast, no knockback)
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
panic/pain/exhaustion and stance, with only the documented aim tolerance. It
never accepts client damage claims.

## Module APIs (exact)
### shared/networking.js
Exports the frozen `NETWORK_PRESENTATION` bounds used by both client smoothing
and server rewind: buffer `65–180 ms` (default `80`), extrapolation at most
`75 ms`, and reported view age `50–450 ms` (legacy default `100`).

### shared/worlddata.js
Exports block ids `AIR` through `PALE`, `BLOCK_HP`, `GRENADE_RESISTANCE`, `SX`,
`SZ`, `SY`, `GROUND`,
`SEED`, the default-Foundry functions `getBlock`, `setBlock`, `heightAt`,
`findSpawns(n)`, `serializeWorld()`, `deserializeWorld(buf)`,
`rebuildHeightMap()`, `generateWorld()`, and
`createWorldState(serializedBytes?)`. It also exports `getMapMeta(id)` and
`createMapState(id,serializedBytes?)`.

`createMapState` accepts `foundry`, `depot`, `citadel`, `solstice`, `caldera`, or `killhouse` and returns an
independent `{mapId,meta,getBlock,setBlock,heightAt,findSpawns,serializeWorld,
rebuildHeightMap}`. Templates are generated and cached once, then cloned for
each room. `meta` is deeply frozen and has
`{id,name,modes,spawns:{fun,tdm:{alpha,bravo},snd:{attackers,defenders}},
sites,landmarks}`. Serialized map dimensions/header remain common across maps;
the map id travels in JSON. `createWorldState` remains the default Foundry API.

### shared/modes.js
Exports immutable `MODE_IDS=['fun','tdm','snd','gungame','training']`,
`TEAM_IDS=['alpha','bravo']`, `MAP_IDS=['foundry','depot','citadel','solstice','caldera','killhouse']`,
`MODE_RULES`, `MAP_MODE_COMPATIBILITY`, S&D credit constants,
`WEAPON_PRICES`, defaults, validators/normalizers for mode/team/map/weapon ids,
`isTeamMode(modeId)`, and `isModeMapCompatible(modeId,mapId)`. This is the browser/server source of
truth for mode ids, map compatibility, timings, and economy. `MAP_MODE_COMPATIBILITY.caldera`
covers every mode id.
`MAP_MODE_COMPATIBILITY.killhouse` covers only training.

### shared/combatmath.js
Exports `WEAPONS`, `WEAPON_IDS`, `CONDITION_RULES`, `GRAVITY`, `PLAYER_HALF`,
`EYE_HEIGHT`, `HEADSHOT_Y_FRAC`, `damageAtDistance(def,dist)`,
`chargeProfile(def)`, `chargeFromHold(def,heldMs)`, `chargeDamageMult(def,charge01)`,
`sampleSpreadDir(fwd,rng,halfAngleDeg)`,
`samplePelletDirection(def,fwd,rng,halfAngleDeg,pelletIndex)`,
`angleBetweenDeg(a,b)`, and
`computeSpreadConeDeg(def,bloomDeg,speedXZ,adsT,panic=0,exhaustion=0,
crouching=false,pain=0)`.
`CONDITION_RULES` is the single source for panic/pain/exhaustion gain, decay, and
recovery. The condition penalty is exactly
`(panic*0.85 + exhaustion*1.15 + pain*1.65) * (1 - adsT*0.45)` degrees;
crouching also applies each weapon's `crouchSpreadMult` to base spread/bloom.

The slot roster is exactly
`['rifle','smg','shotgun','sniper','lmg','revolver','longarc','rocket','lance','knife']`:

| slot/key | display name | mode | rpm | mag/spare mags | close→far damage @ end | head | pellets | hip/ADS cone | mass |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|
| 0 `rifle` | VK-77 RAPTOR | auto | 660 | 30/6 | 25→15 @ 65 | 1.85× | 1 | 1.35°/0.28° | 3.4 kg |
| 1 `smg` | HORNET SMG | auto | 900 | 36/6 | 19→10 @ 42 | 1.70× | 1 | 1.90°/0.75° | 2.3 kg |
| 2 `shotgun` | M-DOCK 12 | pump | 90 | 7/6 | 14.5→5 @ 50 | 1.35× | 9 | 3.60°/1.45° | 3.6 kg |
| 3 `sniper` | LONGSHOT MK-II | bolt | 42 | 5/6 | 95→68 @ 120 | 2.10× | 1 | 5.50°/0.02° | 5.2 kg |
| 4 `lmg` | BASTION LMG | auto | 720 | 60/4 | 22→14 @ 75 | 1.70× | 1 | 1.65°/0.48° | 8.4 kg |
| 5 `revolver` | IRONCLAD .44 | semi | 300 | 6/8 | 54→35 @ 80 | 1.90× | 1 | 1.15°/0.12° | 1.4 kg |
| 6 `longarc` | LN-03 LONGARC | charge | 160 | 8/6 | 88→62 @ 95 | 2.00× | 1 | 1.60°/0.08° | 4.1 kg |
| 7 `rocket` | RX-8 HAVOC | semi | 45 | 1/5 | projectile | 1.00× | 1 | 1.10°/0.25° | 9.6 kg |
| 8 `lance` | CL-9 VOLTLANCE | charge | 100 | 4/5 | 130→95 @ 95 | 2.00× | 1 | 1.20°/0.05° | 3.8 kg |
| 9 `knife` | K-7 RIPPER | melee | 120 | 0/0 | 58→58 (flat) | 1.00× | 1 | 0°/0° | 0.9 kg |

Damage is flat to 20 world units by default; the shotgun starts falloff at 12
and the lance at 45. It then falls linearly to the table's far value at the
listed end.

The LONGARC is the `charge` mode: holding the trigger charges the capacitor
over `charge.ms` (850) and the bolt leaves on release, or on its own at
`charge.holdMaxMs` (2200). Damage scales linearly from `minDamageMult` (0.40) at
a tap to the table value at full charge. The LONGARC is `projectile:'bolt'`: its
shot event carries no hitscan; `shared/bolt-rules.js` owns the ricochet rules —
a tap bolt reflects off walls once, a full charge three times (`boltBounces`),
bolts never pierce a body or a wall, and the bolt fizzles (a small
`projectileExplode` pop with no blast) once the reflections run out or its
lifetime expires. The `rocket` is `projectile:'rocket'`:
its shot event carries no hitscan; `shared/rocket-rules.js` owns the launch
(speed 42, gravity 2.4, 4000 ms lifetime), the direct-hit bonus (100), the
splash (96 @ 4.8 radius, 0.55 self), knockback (11, 15.5 self), and the carve
(radius 3.1, power 145, 80 blocks). All remaining cadence, bloom, recoil, ADS,
reload, deploy, tracer, mass, and SFX fields are read from `WEAPONS`; do not
duplicate them.

The VOLTLANCE (`lance`) is the second `charge` mode: it charges over
`charge.ms` (1150), vents itself at `charge.holdMaxMs` (2400), and taps for
`minDamageMult` (0.35). Its pierce profile is 6 players / 2 walls with
`playerFalloff` 0.9 and `wallFalloff` 0.72 — a charged lance spears up to six
enemies on the line, and only a FULL charge (`charge.wallPierceAt` 1) crosses
up to two walls. Weapon chains are deleted from the game: the lance carries no
`chain` profile and no unreachable sentinels — `chargeProfile` for both charge
weapons exposes only `ms`, `holdMaxMs`, `minDamageMult`, and `wallPierceAt`.

The RIPPER (`knife`) is the `melee` mode: `magSize` 0 and `spareMags` 0 mean a
swing consumes no ammunition and the reload path never engages (`reloadPlan`
seats 0 rounds). The swing arc (`melee.reach` 2.2, `melee.coneDeg` 110)
replaces ballistics — no tracer, flat 58 damage with no falloff, `headMult` 1.0
so there are no headshots, and no block damage. When the strike lands from
behind the victim's facing (`dot(victimForward, swingDir)` above
`melee.backstabDot` 0.4) the damage multiplies by `melee.backstabMult` (2.5).

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
  humans. Quick play bypasses readiness, rotates Foundry/Depot/Solstice/Caldera for
  fresh rooms, and starts a new room immediately.
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
  `networkStats`, and `dirty`. Welcome, lobby, snapshots, rows, match data, and
  events are immutable copies. `latestLobbyState` is
  `{code,host,phase,bots,gameMode,map,members,selfId}`.
- `on(type,fn)` returns an unsubscribe function; `off(type,fn)` removes it.
  Observable types are `open`, `close`, `welcome`, `lobby`, `serverError`,
  `tick`, `chat`, and every combat/mode event `kind`.
- `isOpen()`, `sendInput(input)`, `setReady(boolean)`, `requestStart()`,
  `buyWeapon(id)`, and `close()` return or act on the current socket. Send
  methods return `true` only when handed to an open socket and a valid request.
- `interpolate(renderNowMs,delayMs?)` returns
  `{players:Map<id,row>,events,match}`. It excludes the local row, shortest-arc
  interpolates yaw, selects authoritative match state, and emits/drains each
  visible event once. With no override it uses the measured arrival jitter to
  adapt within a bounded 65–180 ms buffer and extrapolates at most 75 ms at a
  capped remote speed; state discontinuities snap to authority. Server tick
  time is mapped onto the local clock with bounded drift correction so packet
  bursts cannot compress authoritative movement into a speed spike.

### HUD
- `buildMenu(onAction)` builds Quick Play/Create/Join and calls
  `onAction({mode:'quick'|'create'|'join',gameMode,map,name,bots,sensitivity,
  code})`. Create uses the selected compatible mode/map. Quick uses shared Fun
  admission with five takeover bots and automatic Foundry/Depot/Solstice/Caldera
  rotation; Join uses the code and inherits the room selection. Names trim to
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
- `setupWeaponWheel({onPick,onCancel})`, `ensureWeaponWheel()`,
  `setWeaponWheelState({open,entries,x,y,step,highlight,setHighlight,
  pointerInteractive})`, `isWeaponWheelOpen()`, `requestWheelCancel()` (a
  guarded onCancel), and the additive `weaponWheelHighlight()` getter own the
  radial weapon wheel. Entries are `{id,name,cls,icon,key,ammo,owned,current}`
  with wheel index == weapon slot; all ten render, unowned entries render
  locked, and `pointerInteractive` enables the touch pointer-capture path
  (drag to highlight, release to pick).
- `setMatchState(match,selfRow,players,serverNow)` renders mode/map, team scores,
  phase clock, S&D round/role/bomb state, interaction progress, credits, and the
  compact alive/dead player status strip from authoritative state. Team colors
  apply to HUD and scoreboard.
- `setupSettings({sensitivity,volume,fov,options?,device?,onChange,onResume})`,
  `setDeviceInfo({touch,pointerKind,trackpadDetected,padActive})`,
  `openSettings()`, `closeSettings()`, and getter `settingsOpen` own settings.
  Settings, buy, and lobby dialogs are mutually exclusive and suppress gameplay.
  `onChange` receives the full `{sensitivity,volume,fov}` object plus the device
  options `{adsMode,pointerMode,padSensitivity,aimAssist,touchSensitivity,
  touchSize,touchHand}`; device rows show by capability (pointer/ADS on
  desktop, layout rows on touch, pad sensitivity while a pad is active).
- `buildHUD()`, `menuDone()`, and
  `setState({hp,mag,reserve,wname,wid,bloomPx,reloading01,yawDeg,adsT01,alive,
  grenades,grenadeType,grenadeCharge,grenadeCharging,grenadeCook01,
  grenadeCookLeftMs,charge01})`
  own the live HUD. `spreadFromBloom(deg)`, `setSpread(px)`,
  `hideCrosshairForAds(boolean)`, `setReloadProgress(t01|null,staged?)`,
  `updateCompass(yawDeg)`, `pushEvent(ev)`,
  `hitmark(headshot|'body'|'head'|'kill'|'killHead')` (a kill mark is never
  downgraded by a trailing hit), `setOwnDamage(intensity01|{intensity,angleDeg})`,
  `setDead(dead,killerName?,recap?)`,
  `spawnDamage(amount,x,y,visible?,headshot?,stackKey?)` (hits sharing a
  `stackKey` inside 420 ms merge into one growing number),
  `spawnDamage(amount,sx,sy,visible?,headshot?)`, `setScoreboard(boolean)`,
  `setPlayers(rows)`, `setScope(boolean)`, and `dispose()` are the remaining
  live-HUD surface used by the game.

The game must not build, pointer-lock, or start live gameplay for a public room
until `lobbyState.phase === 'live'`. Quick play proceeds directly; a public
late join whose welcome/state is already live also proceeds directly.

### Input, rendering, effects, and viewmodel
- `new Input(canvas).start(canvas,onLockChange)`; poll `getKeys()` for movement
  plus held `interact`, read `yaw`/`pitch`, and drain fire, reload, weapon, and
  buy-menu edge consumers. `getGrenadeCharge(now?)` and `getGrenadeHoldMs(now?)`
  expose live HUD progress; `consumeGrenadeThrow()` returns the released
  `{charge,cookMs,type}` or `null`; `forceGrenadeRelease(now?)` lets the
  presentation release a fuse cooked to the end. `getGrenadeType()`,
  `setGrenadeType(i)`, and `cycleGrenadeType(dir)` own the selected throwable:
  `H` cycles it, and the wheel (or pad `Y`) cycles it while `G` is held instead
  of switching weapons. `E` holds interact; `B` toggles the buy menu;
  `1–9`/`0`/wheel/`Q` select weapons.
  The radial weapon wheel drains `takeWheelOpenRequest()` (Q held
  `WHEEL_HOLD_MS=180`, a middle-mouse press, pad `Y` held
  `PAD_WHEEL_HOLD_MS=260`, or a touch `wheel` pulse; a quicker Q press still
  swaps to the previous weapon and a quicker Y tap still swaps or cycles the
  throwable), `takeWheelRelease()` (the opening control released while open),
  `takeWheelCancelRequest()` (`Esc`, right mouse, or pad `B` while open),
  `takeWheelVector()` (normalized selection motion where `1` equals
  `WHEEL_VECTOR_RADIUS_PX=90` raw mouse px, pad look scaled by the same
  radius), `takeWheelSteps()` (wheel scroll plus d-pad up/down while open),
  and `takeWheelDirectSlot()` (`1`–`9` and `0` while open; `0–9` or `null`).
  `setWeaponWheelOpen(open)` reroutes devices while the wheel is up: look
  deltas feed the wheel instead of the camera, fire/ADS/reload/grenade/zoom/
  buy/interact edges are suppressed, movement keys stay live,
  `wantFireHeld`/`wantAdsHeld` read false, and `clearTransient()` resets all
  wheel state; `isWeaponWheelOpen()` reports the seam state.
  `setGameplayEnabled(boolean)` gates input around lobby, settings, buy, death,
  and teardown.
- `TouchControls` owns coarse-pointer DOM and pointer lifecycles behind the
  `Input` seam. Touch mode is selected by touch capability, a coarse primary
  pointer, or the `?touch=1` QA override; it never requests pointer lock. Its
  joystick, swipe-look, hold, and pulse callbacks feed the same canonical input
  state and draining edges as keyboard/mouse, including charged grenades, the
  `grenadeType` chip that cycles the throwable, and the S&D buy menu. The
  weapon chip keeps its quick-tap `weapon` pulse (next weapon) and pulses
  `wheel` instead when a press is held past `WHEEL_TOUCH_HOLD_MS`; a
  `wheelOpen` context collapses `visibleTouchActions` to the pause-only set.
  The look zone is the full screen beneath the other
  controls; the joystick base floats to the touchdown point; the FIRE button
  forwards drag deltas to look while held; a look-zone touch shorter than
  `TOUCH_TAP_FIRE_MS` and stiller than `TOUCH_TAP_FIRE_TRAVEL_PX` pulses
  `fireTap` (one queued shot); ADS and crouch use `resolveToggleRelease` (tap
  under `TOUCH_TOGGLE_TAP_MS` latches, long press holds). The first enabled
  gesture requests fullscreen and a landscape lock (both best-effort, never
  thrown), presses vibrate through `navigator.vibrate` when present, and
  disabling gameplay releases every captured, held, or latched control.
- `new WorldView({getBlock})`; call `await ready()` before rendering,
  `applyDeltas([{x,y,z,v}])`, `update(dt)`, camera ray helpers, and `dispose()`.
- `new CombatPostProcess(renderer,options)` owns the bounded scene render target
  and full-screen combat shader. Call `setSize(width,height,pixelRatio)`, then
  `render(scene,camera,{time,panic,pain,scopeActive})`; any shader failure must
  permanently fall back to a direct scene render. Its target pixel ratio caps
  at `1.35` (`1.0` on devices reporting at most 4 GB), and `?shader=off` is the
  deterministic manual fallback.
- `new Effects(scene,camera,worldGetBlockFn,{getEntityPosition?})` exposes
  `shoot(ev,{local?})` (a local rocket shot also spawns the predicted rocket),
  `impact(evHit)`, `explodeBlock(x,y,z,blockId)`, `spawnBrass(pos,velocity)`,
  `projectileLaunch(ev,{local?,fromSelf?})`, `projectilePreview(launch|null)`,
  `projectileStick(ev)`, `projectileExplode(ev)`, `update(dt)`,
  `shake(amount)`, getter `currentShakeXY`, and `dispose()`.
- `new ViewmodelRig(camera)` exposes `setWeapon(id)`, `fire()`, `ads(t01)`,
  `setCharge(t01)` (held capacitor charge: coil glow floor plus a rearward
  squeeze), `reload(dur,type)`, `pumpAnim()`, `boltAnim()`,
  `update(dt,{speed,grounded,verticalVelocity?,lateralSpeed?,forwardSpeed?,
  isSprinting?,crouch?,panic?,pain?,exhaustion?,aimSwayScale?})`, `bobAmt`,
  and `turnLag` (`{yaw,pitch,roll,x,y,speed,maxSpeed,...}`).
  It builds ten procedural models — one `build()` per weapon id from the
  `guns/models/*.js` registry wired in `guns/assemble.js`, adding
  `models/lance.js` (cell whine, violet lance glow) and `models/knife.js`
  (a compact blade with no reload or charge furniture). Its internal angular
  follower observes the
  completed camera orientation, caps weapon rotation speed and acceleration by
  `weightKg`, tightens toward the sight line with ADS, folds lag beyond its
  weight budget back into the pose (no hidden unwind), and affects only the
  rig—never camera or authority aim. `lateralSpeed`/`forwardSpeed` are body
  velocity in the camera frame and drive a mass-scaled lean/surge spring; the
  kick and body springs scale by `kickMassScale(weightKg)` from `guns/defs.js`.
- **Throwables and rockets:** `shared/grenade-rules.js` owns `GRENADE_TYPE_IDS`,
  `GRENADE_TYPES` (per-type fuse, cook/impact/sticky flags, blast, knockback,
  concussion, carve, colour, and physics), `freshGrenadeLoadout()`,
  `clampGrenadeType`, `clampGrenadeCook`, `grenadeFuseAfterCook`,
  `grenadeLaunch({x,y,z,eyeY,vx,vy,vz,dir,charge,type})`,
  `stepGrenade(g,dt,isSolid)`, and `predictGrenadePath(launch,isSolid,opts)`;
  `shared/rocket-rules.js` owns `ROCKET_RULES`, `rocketLaunch({x,y,z,dir})`, and
  `stepRocket(r,dt,raycast)`; `shared/bolt-rules.js` owns `BOLT_RULES` (speed
  52, gravity 3.0, radius 0.1, lifetimeMs 3000, bouncesTap 1 / bouncesCharged 3
  at `chargedAt` 1, blockDamage 18 per destructible wall contact, colour
  '#7dfcff'), `boltBounces(charge01)`, `boltLaunch({x,y,z,dir,charge01})`, and
  `stepBolt(bolt,dt,raycast)` — one swept reflection walk so prediction,
  presentation, and authority ricochet identically (clients derive bounce FX
  from the step's `bounced` flag). The server `ProjectileSystem`
  (`server/sim/projectiles.js`, `PROJECTILE_RULES`), the client `ProjectileFX`
  (`public/js/weapons/projectiles.js`), and the charge preview all run those
  integrators. `Effects.projectileLaunch(ev,{local?,fromSelf?})` spawns a
  predicted local projectile on release (and `Effects.shoot` does the same for
  a local rocket shot), and the authority `projectileLaunch` for the local id
  adopts the oldest pending prediction of that type (no pop, no double spawn;
  unconfirmed predictions time out after 1 s). `Effects.projectilePreview`
  draws the type-coloured dotted arc and landing ring while charging; sticky
  and impact previews stop at the first contact. `ProjectileFX` rides a limpet
  stuck to a player through `getEntityPosition(id)`. `LocalPlayer`
  `consumeLocalGrenadeThrow()` (`{charge,cookMs,type,at}`) and
  `grenadeLaunchState(charge,type)` feed that presentation; the composition
  root forces the release when a frag has been held for its whole fuse so
  authority detonates it in the hand. `ViewmodelRig.grenadeCharge(t01)` /
  `grenadeThrow(charge)` play the wind-up and lunge; `sfx.grenadePin()`,
  `sfx.grenadeThrow(charge)`, `sfx.explosion(pos,type)`, and
  the sustained `sfx.weaponCharge(level01,active)` whine cue them. HUD state
  renders one chip per throwable with remaining pips, the selected type name,
  `is-full` at max charge, `is-cooking`/`is-critical` with a `COOKING · n.ns`
  hint, and the LONGARC/VOLTLANCE coil meter (`charge01`).
- `LocalPlayer.addRecoil(pitchRad, yawRad, weightKg?)` drives a velocity-impulse
  camera spring that peaks at the requested kick ~40–60 ms after the shot and
  recovers on a weight-scaled spring (slower for heavy guns), adds a coupled
  camera roll, and keeps 18% of the pitch kick on the authoritative aim so
  sustained fire must be controlled. `lookScale` exposes the live ADS look
  multiplier (`adsLookScale(liveFov, baseFov)` from `input-settings.js`).
- `new AimSway()` exposes `update(dt,{alive,grounded,stationary,shift,
  crouching,panic,pain})`, `reset()`, and its stable `readModel`. It applies
  deterministic stationary sway; crouching reduces it, while holding Shift
  when stationary suppresses it until the pain/panic-limited breath budget is
  spent.

### Audio
`sfx` exports:
`init():Promise`, `unlock():Promise<boolean>`, `dispose():Promise<void>`,
`setMasterVolume(value)`, `startMenuMusic(fetchImpl?)`,
`stopMenuMusic(fadeSeconds?)`, `loadSamples(manifest,fetchImpl?)`,
`fire(key,{muffled?:boolean,pos?:[x,y,z]}|[x,y,z]?)`,
`impact(kind:'stone'|'wood'|'glass'|'metal'|'flesh',volume,
{muffled?:boolean,pos?:[x,y,z]}|[x,y,z]?)`,
`reloadClick(step:1|2|3,weaponKey)`, `hitmark(headshot)`,
`killConfirm(headshot)`, `lowHealthPulse(level01,nowMs)` (rate-limited
heartbeat; silent at zero), `deathFar(volume?)`, `footstep(volume?)`, `draw(weaponKey)`,
`bulletWhiz(volume?)`, and `setListener({fwd:[x,y,z],pos:[x,y,z]})`.
All sound methods are safe before initialization. `init()` and `unlock()` are
idempotent, every voice routes through the clamped master volume and limiter,
and `dispose()` closes the owned context and clears voices/timers. Fire and
impact support HRTF positions; the engine caps 48 voices total and 16
positional voices.
`BUILTIN_SAMPLE_MANIFEST` is the exact licensed local fire/reload asset set.
Sample decode/fetch failures retain procedural fallbacks. The menu uses the
licensed local loop through the same master bus; the offline audit inventories
every shipped OGG and checks fire onset, runtime peak headroom, RMS/crest
sanity, clipping ratio, and the weapon duration/brightness profile. The browser
mix audit additionally renders the complete local fire graph through the shared
master/echo module and asserts onset, limiter behavior, RMS, tail, and weapon
weight ordering.

### Server bots
`attachBots(engine,n)` returns a `BotManager`. Bots are direct engine entities,
submit through `applyInput`, do not consume human capacity, and exist only while
their room is live. They obey target eligibility and friendly-fire rules, use
mode-specific spawn pools, avoid fire during S&D prep, buy affordable S&D
weapons, recover/escort/plant/guard/defuse the bomb, and dispose their engine
step listener with the room.

## Runtime gameplay contracts
- **Fun (`fun`):** free-for-all target eligibility, complete ten-weapon
  loadouts, friendly-fire/team logic not applicable, no score-limit reset, and
  `1500 ms` respawn. Shared quick rooms allow join in progress with no ready
  gate.
- **Team Deathmatch (`tdm`):** persistent `alpha`/`bravo` assignment chooses the
  lower human+bot population; friendly fire is disabled and every player owns
  the complete ten-weapon loadout. Enemy kills increment the killer's team
  score. First to `40` enters a `5000 ms` post phase, then team/player scores
  reset and all players respawn. Live deaths respawn after `3000 ms` at the
  player's team spawn pool.
- **Gun Game (`gungame`):** free-for-all target eligibility and `1500 ms`
  respawn. Players progress through the immutable shared order rifle, SMG,
  shotgun, sniper, LMG, revolver, longarc, rocket, lance, knife; a kill with
  the RIPPER knife wins. The winner is shown during a `5000 ms` post phase
  before progression and scores reset.
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
  16000. Prices are revolver 0, knife 500, SMG 1250, shotgun 1800, rifle 2700,
  longarc 3500, lance 3800, LMG 4000, rocket 4300, sniper 4750. Only alive
  participants buy during prep. A purchase owns,
  selects, and refills that weapon. New/dead players start the next round with
  revolver; survivors retain purchases and remaining ammunition.
- **Training (`training`):** exclusive to `killhouse` — a weapon-test firing
  range with 17 respawning dummies that never shoot back, humans cannot hurt
  each other, a 4-stage timed killhouse run whose metal gates open as stages
  clear, all 10 guns unlocked, and zero combat bots (the bot slider does not
  apply).
- **Map compatibility:** `foundry` supports Fun/TDM/S&D/Gun Game; `depot`
  supports Fun/TDM/Gun Game; `citadel`, `solstice`, and `caldera` support
  Fun/TDM/S&D/Gun Game; `killhouse` supports Training only. Foundry has A/B
  sites, Depot is a compact point-symmetric cargo map, Citadel has Courtyard A
  and elevated Compound B, Solstice is a desert solar observatory with a
  biodome, broken heliostat ring, turbine hall, compact linked lanes, and A/B
  sites, Caldera is a volcanic caldera with obsidian gate A, elevated refinery
  B, and a central vent, and Killhouse is a weapon-test firing range with
  respawning dummies and a timed 4-stage course. Every declared spawn
  has solid footing and two-block headroom.
- **Settings:** sensitivity defaults to `0.003` rad/px, clamps to
  `0.0008–0.012`, and persists as `vb-sens-v2` (`SENSITIVITY_PREF_KEY`; the
  old `vb-sens` scale is ignored rather than clamped). Touch look runs at 1.4×
  the mouse value times the persisted touch multiplier (`vb-touch-sens`,
  0.5–2.5); trackpad look runs at 2.4× with a 72%-per-frame release filter.
  Device options persist under `INPUT_PREF_KEYS` (`vb-ads-mode` hold/toggle or
  auto, `vb-pointer-mode` auto/mouse/trackpad, `vb-pad-sens` 0.6–4.5 rad/s,
  `vb-aim-assist`, `vb-touch-size`, `vb-touch-hand`). Wheel switching follows
  `wheelSwitchStep`: line notches are whole steps, pixel deltas accumulate to a
  48 px notch, reversals reset the bank, and steps are limited to one per
  120 ms; three pixel-mode deltas of 40 px or less mark the pointer as a
  trackpad, which also defaults ADS to toggle. Look input is multiplied by `adsLookScale` while zoomed; master volume defaults to `0.80`, clamps to `0–1`, and
  persists as `vb-volume`; FOV defaults to `75`, clamps to `65–100`, and
  persists as `vb-fov`. Changes apply immediately. Escape opens the in-game
  settings overlay; Resume closes it and returns pointer-lock gameplay.
- **Scope:** only `sniper` at `adsT01 >= 0.72` receives the transitioning
  full-screen 5× circular optic through `HUD.setState`. Its outside mask is
  opaque; the reticle has crosshairs, mildots, and range ticks. The viewmodel
  hides only while fully scoped.
- **Audio:** licensed local fire/reload recordings and the menu loop augment the
  procedural WebAudio layers. Missing or undecodable samples fall back to the
  procedural implementation. Weapon reports, reloads, impacts, hitmarks,
  distant deaths, footsteps, draws, bullet whizzes, echo, music, and positional
  listener updates all route through `sfx` and the terminal limiter.
- **Authority:** one room engine simulates movement, ammo, reloads, spread,
  hits, grenades, rockets, destruction, death, score, and respawn at 20 Hz. The client
  predicts feel/FX but accepted shots and all damage are server decisions.
  Shooter-side rewind uses the client's bounded `viewAge` within a 500 ms
  history window so hit authority matches the target state actually rendered.
- **Throwables:** every fresh life carries 2 frag, 1 limpet, and 2 pulse.
  Holding `G` charges the throw for up to 1200 ms; releasing queues one throw
  edge with the shared `0–1` charge profile, the selected type, and the held
  cook time, which the server clamps before owning trajectory, fuse, blast
  damage/line of sight, knockback, and a resistance-limited terrain carve.
  `frag` (M-4 FRAG): 2600 ms fuse that starts at the pin pull, so the hold
  cooks it and a hold past the fuse detonates in the hand; 115 damage @ 5.4,
  0.72 self, carve radius 3.6 / power 150 / 110 blocks. `limpet` (LIMPET
  CHARGE): sticks to the first wall or player it touches (riding a player),
  arms a 1500 ms fuse on contact (3500 ms flight cap), a stuck player takes the
  full 140 @ 4.2 blast, carve radius 4.6 / power 200 / 160 blocks. `pulse`
  (PULSE SHOCK): detonates on impact, 38 @ 6.5, knockback 17, no carve, and a
  1600 ms concussion that slows the victim to 60% speed and adds 0.55 panic.
  Every blast sympathetically detonates other live explosives within 80% of
  its radius with line of sight. Metal is blast-proof.
- **Rockets:** the RX-8 HAVOC fires one authoritative rocket per tube (shot
  event plus `projectileLaunch`) that detonates on the first voxel or body it
  meets; a direct body hit adds 100 before the splash. The owner's own blast
  launches them with the stronger self knockback (rocket jump) at 0.55 self
  damage. Bots hold a `charge` trigger to ~90% and release, and buy the rocket
  after the LMG.
- **Hit confirmation:** shooter-side hitmarks, their confirmation sound, and
  world-anchored damage numbers share one camera-to-impact voxel visibility
  decision; intervening cover suppresses the complete confirmation. A kill by
  the local player promotes the mark to `kill`/`killHead` with `killConfirm`,
  damage numbers stack per victim, local damage carries the attacker bearing
  (`bearingDeg`), death shows `deathRecapText`, and the spectator camera opens
  on the killer for `KILL_CAM_MS` (2600) before its normal rotation.
- **Reload:** magazine weapons follow `reloadPlan(def,mag)` in one step.
  Weapons with `reloadStages` (shotgun: start 0.42 s, 0.36 s per round, end
  0.22 s) keep chambered rounds, hand one spare over as loose rounds at the
  first seat, seat rounds one at a time, and yield to the trigger with every
  seated round kept; the loose remainder is forfeited. Server and client mirror
  the same plan, and the client keeps a locally started reload for
  `RELOAD_ACK_GRACE_MS` (400) before a not-reloading snapshot may clear it.
- **Recoil recovery:** `WEAPONS[id].recoil.recovery` (0.48–0.72) is the
  fraction of accumulated aim climb (18% of pitch kicks, 10% of yaw kicks)
  walked back at 11/s once fire pauses for `resetMs`; look-input compensation
  during the spray is subtracted from the owed climb first.
- **Reconciliation:** corrections above 0.12 m move the predicted body by 28%
  per snapshot (snaps beyond 3.2 m land fully); the camera carries the negated
  correction as an offset clamped to 1.6 m that decays at 13/s (7/s after a
  snap), so corrections never pop.
- **Gamepad:** standard mapping via `readGamepadFrame`; sticks use
  `stickCurve` (move dead zone 0.18 linear, look dead zone 0.12 with expo
  1.75); button edges fold into the same Input queues as the keyboard; a pad
  counts as active for 2.5 s after input. Aim assist (`setAimAssist`) applies
  only to pad and touch look and slows it by at most 50%.
- **Touch context:** `visibleTouchActions(context)` decides which buttons
  exist; hiding a held or latched button releases it first.
- **Death:** snapshot `state`/`respawnAt` plus `die`/`respawn` events are
  authoritative.
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
  `0.18/s`. Pain gains `damage*0.016 + (headshot ? 0.28 : 0)`, decays at
  `0.65/s` toward `0.60*(1-hp/100)`, and clamps to `0–1`. All three reset on
  death/respawn, add deterministic tremor/breathing and shot-cone penalty, and
  remain snapshot-only—not HUD meters. Stationary Shift hold suppresses sway
  for 2.4 seconds when calm, falling as low as 0.7 seconds with pain/panic;
  crouching scales sway to 55%.
- **Weapon lag:** the procedural gun owns a separate angular orientation that
  follows the immediate camera with weight-limited speed and acceleration.
  Heavier weapons trail farther and settle more slowly; camera/authority aim is
  never delayed or altered.
- **Worlds:** Foundry, Depot, Citadel, Solstice, and Caldera are deterministic 128×40×96 templates.
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
