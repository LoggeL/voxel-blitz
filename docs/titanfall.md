# Titanfall mode (Attrition) — implementation spec

This is the single source of truth for the `titanfall` mode. It is a Titanfall 2 style
Attrition mode: pilots wallrun, call titans down from orbit, embark, fight titan against titan,
and rodeo enemy titans. The spec is split into work packages (WPs). **WP0 (spine) lands first and
alone.** After it lands, WP1–WP7 run in parallel (at most 3 at a time, §12) with disjoint file
ownership. WP8 (grunts) is later.

Status: spec rev 2 (2026-10-12, after the integration / gameplay / plan review; see Appendix A).
Design references are in `docs/design/titanfall/` (lineup B, the five turnarounds, HUD option 2
for pilot and titan, and the loadout screen).

Line numbers were checked against the working tree on 2026-10-12. Several touched files are
dirty and edited live by another session, so **always find code by symbol name, not by line
number.** Dirty files at spec time: `package.json`, `public/index.html`, `public/js/main.js`,
`public/js/boot/match-runtime.js`, `public/js/ui/conquest-hud-state.js`, `server/game.js`,
`server/sim/{vehicles,combat,projectiles,context}.js`, `server/modes/{conquest,bastion}.js`,
`server/bot-aircraft.js`, and several conquest/bastion tools.

---

## 0. Non-negotiable rules (apply to every WP)

| # | Rule |
|---|---|
| R1 | **Every existing mode stays bit-identical.** All new behaviour is gated on `mode === 'titanfall'` (or on helpers that are true only for it: `isTitanfall(mode)`, `modeHasVehicles(mode)`, `isCombinedArms(mode)`). Conquest snapshots, row bytes, RNG draws and tick order must not change. **One explicit exception (WP4):** appending 4 ids to `WEAPON_IDS` grows every player row's `mag`/`reserve` arrays by 4 entries each (`ammoCopy` in `server/protocol/snapshot.js` maps over `WEAPON_IDS`) in every mode. WP4 re-checks the row budgets (`conquest-vehicles-test`, `large-lobby-test`, `mode-lobby-smoke`) and the digest scripts exclude `mag`/`reserve` (§11.2). |
| R2 | `MODE_IDS`, `WEAPON_IDS`, `VEHICLE_WEAPON_META` keys and keybinding action lists are **append-only**. `VEHICLE_TYPE_IDS` stays conquest-only. `PLAYER_KEYS` stay exact. Titanfall data rides in the conditional `tf` key. |
| R3 | Edit existing files only with small exact-string edits. Never rewrite an existing file. Never `git stash`, `reset`, `checkout`, `add` or `commit` during a WP. **Do not stage anything.** For every pre-existing file a WP edits, it snapshots the file before its first edit (`cp f $SCRATCH/wpN/pre/<path>`) and after finishing writes its own hunks as a patch (`diff -u pre/<path> <path> > $SCRATCH/wpN/<path>.patch`). The orchestrator commits at integration: new files with a pathspec commit (`git commit -- <paths>`, never a pre-staged index), edits to dirty files through `git apply --cached <wp hunks>.patch` or the detached-worktree replay (memory: push-from-origin-worktree). |
| R4 | Do not touch a file outside your WP's ownership table. A needed change in a foreign file goes through a WP0 hook, or is sent as a hunk patch to the orchestrator. |
| R5 | No browser flow that plays audio. Muted CDP captures (`tools/lib/cdp-session.mjs`) are allowed, **one WebGL capture at a time**, behind the capture lock. Heavy node jobs run behind the heavy lock (§12.4). |
| R6 | Work files go in the session scratchpad, never `/tmp`. |
| R7 | No ripped Titanfall art or audio. Use original synthesis, macOS `say` voices, or CC0/CC-BY assets listed in `sources.json`. Do not use real product names in any shipped string (only the in-game names listed here). |
| R8 | UI and models follow `AGENTS.md`: ImageGen reference first (they exist now in `docs/design/titanfall/`), then implement, then compare a muted capture against the reference at desktop **and** mobile size. |
| R9 | Displayed values come from authoritative state (snapshot rows, `match.titanfall`, the `tfs` frame). The client never computes score, hp or meter on its own (prediction excepted, and it is reconciled). |
| R10 | `npm run preload:build` is run **only by the orchestrator** under the heavy lock. WPs run `node tools/build-module-preload.mjs --check` and report the diff. `public/index.html` is never edited by a WP (titanfall CSS is injected lazily, §8.1). |

---

## 1. Overview and player loop

| Item | Value |
|---|---|
| Mode id | `titanfall` (appended to `MODE_IDS`) |
| Lobby label / match title | `TITANFALL` / `ATTRITION` |
| Teams | `alpha` = MILITIA, `bravo` = IMC (flavour only; colours use the existing team schemes) |
| Score | pilot kill 5, titan destroyed 10 (credited on destruction, not on doom, to the doomer, §5.2), grunt 1, spectre 2 |
| End | first to the scaled score limit, or `timeLimit` 12 min. The higher score wins; a tie is a draw. The limit follows the larger team (`titanfallScoreLimit`: 100 + 80 per pilot, in steps of 25, at least 175, at most `scoreLimit` 750): 1v1 175, 2v2 250, 3v3 350, 4v4 425, 6v6 575, 8v8 750, which is about 8.5 min of bot play at every size (soak 2026-10-13: the leading team had 155 / 238 / 303 / 373 / 601 / 692 points after 8 min). During a live match the limit only rises when players join; `reset()` rescales it. |
| Respawn | 4000 ms, `friendlyFire: false`. No fall damage: `TitanfallPolicy` defines **no** `fallDamage` method, so `ModeController.airborneRules()` stays false and no chute logic runs (double jump keeps the jump key). |
| Capacity | `lobbyCapacity('titanfall', map)` = min(map limit, **16**) → at most 8v8. Concurrent titans per team ≤ ceil(team size / 2); a full meter waits (HUD "TITAN BAY FULL") until a slot frees. |
| Pilot health | 100 hp; regen after 5 s without damage at 20 hp/s (server, `PILOT_RULES.regen`) |
| Loadout | owned loadout (`OWNED_LOADOUT_MODES`); the titanfall loadout screen picks pilot and titan kits |
| Bots | allowed (`modeAllowsBots`), lobby teams (`hasLobbyTeams`) |
| Maps | `frontier`, `harbor`, `canyon`, `ashfall` (the dedicated Attrition map, §14). No conquest vehicles, flags or pads (the `vehicles.reset` gates in `game.js` stay conquest-only, §2.5). |
| Play area | harbor/canyon/ashfall: the whole map, spawns from `mapMeta.spawns.tdm`. **frontier: a titanfall play area** (`server/sim/titanfall/play-area.js`): a 256×256 m rectangle centred on the central river crossings, with its own deterministic spawn sets (two team edges of the rectangle, 16 points each, ground-probed at match start from a fixed seed) and its own OOB bounds. Frontier's `tdm` bases (≈580 m apart) are not used. |
| Killcam | supported (`supportsKillcam`). A human pilot killed by another pilot (bots included) or by a titan sees the replay after the head-flight intro, then the loadout screen (DEPLOY), which stays closed while the replay runs and opens when it ends or is skipped (Space, pad A, SKIP). **Respawn time:** such a death waits `KILLCAM.respawnMs` 4800 ms instead of 4000 ms (`respawnAt = max(respawnAt, now + 4800)` in `GameEngine.killPlayer`), so the DEPLOY countdown and the `DEPLOY_RULES.timeoutMs` idle deploy (counted from `respawnAt`) move 0.8 s later; bots, minion kills (`tfNpc`), world deaths and a stand-in without a hull keep 4000 ms. The kill event carries the replay focus: `kv` (hull id) and `ks` (seat) for a pilot in a titan; `kv` alone for a titan kill without its pilot aboard (auto-titan stand-in, drop or leg crush of an empty titan; any `TITAN_WEAPON_META` / `TITAN_KILL_KEYS` key except `rodeo` and `titan_doom`), then the replay follows that titan. Titans replay from the chase view; pilots on foot from their eye with the wallrun roll; recorded `tf` poses the bodies (wallrun, slide, rodeo, grapple ropes) and recorded minions are drawn dressed. A minion killer gives no replay, only the death cam. |

Player loop:

1. **Spawn as a pilot.** Fast movement (§4) with a pilot primary, revolver, an anti-titan (AT) weapon, knife, frag and pulse grenades, and one tactical. Spawn selection skips points within 35 m of an enemy titan or a pending drop marker.
2. **Fill the titan meter.** It rises 0.9 %/s (binding decision; ≈110 s), plus boosts for kills, pilot damage and titan damage. It fills only while the pilot owns no titan.
3. **Call the titan.** Press `callTitan` (E) with a full meter. The aim ray (≤ 160 m) must hit open, dry, level ground with sky clearance, not within 30 m of an enemy spawn point. A marker beam shows for 2.2 s, then the titan falls for 0.8 s. The impact crushes enemies in its footprint and pushes friendly pilots out.
4. **Embark.** Hold interact (T) within 6 m of your own titan. A locked 1.2 s embark animation plays (the pilot is inside the hull and not hittable; the titan still takes damage), then the cockpit camera takes over. Tap interact to disembark: the pilot exits in front of the hatch (fallback: roof, then rear). A titan without a pilot is an **AUTO-TITAN** guard.
5. **Fight as a titan.** Primary, defensive, tactical, ordnance, core, dash, melee and electric smoke. Shields absorb damage first. The hull turns 1:1 with the mouse.
6. **Doom.** At 0 hp the titan is *doomed*. A doom pool drains over 7 s. Eject (triple-tap X) is accepted **only while doomed**: a ballistic launch (`markLaunched`, no canopy) up to ≤ 38 m/s with 1.5 s of cloak. A pilot who stays in dies with the titan. On destruction the titan explodes into fragments.
7. **Rodeo.** An enemy pilot mounts a titan's back (one enemy rider at a time). They rip its battery once (1.4 s, 15 % of max hp; the titan is then `batteryOut`) or shoot the hatch with their primary or sidearm. A battery inserted into a friendly titan gives +35 % max-hp shield (refused at the shield cap).
8. **Respawn.** A pilot keeps their titan across respawn (one titan per pilot). A destroyed titan leaves a wreck until `wreckSolidSeconds`, then the meter starts filling again.

### 1.1 Lifecycle edge cases (WP0 policy dispatcher + WP2 bodies)

| Event | Handling |
|---|---|
| Owner disconnects | titan removed with no score (no `vehicle_destroyed` credit), pending drop cancelled, rodeo riders released, carried battery dropped |
| Owner switches team | same as disconnect, plus meter = 0 |
| Match / round reset | `titans.reset()` clears titans, pending drops, deployables, fire patches, batteries, riders; every meter = 0 |
| Rider dies or leaves | death and leave hooks clear `p.rodeoVehicleId` and the vehicle's `riderId` |
| Titan destroyed during embark | the embark lock ends (`p.embarkUntil = 0`), the pilot is released at `exitSpot` (fallbacks as in step 4) and takes no crew death |
| Owner dies while titan alive | titan stays as auto-titan; it keeps firing with the owner as credited attacker (§5.2) |
| Titan out of bounds | `stepTitanWalk` clamps the hull to the play area; drop landing out of bounds refunds the meter |

---

## 2. Shared contracts

### 2.1 Mode registry — `shared/modes.js`, `shared/lobby-limits.js` (WP0)

`MODE_RULES` is a frozen object literal and the file has no `deepFreeze` helper, so titanfall is
added **as a literal entry inside the existing `Object.freeze({...})`**:

```js
// shared/modes.js
export const MODE_IDS = [...existing, 'titanfall'];             // append only
// inside MODE_RULES = Object.freeze({ ... }):
  titanfall: Object.freeze({
    label: 'TITANFALL', title: 'ATTRITION', teams: true, friendlyFire: false,
    respawnMs: 4000, scoreLimit: 750, timeLimitMs: 12 * 60_000, allowDraw: true,   // scoreLimit: the 8v8 cap
    scoreScale: Object.freeze({ base: 100, perPilot: 80, step: 25, min: 175 }),   // titanfallScoreLimit(teamSize)
    vehicles: 'titans', points: Object.freeze({ pilot: 5, titan: 10, grunt: 1, spectre: 2 }),
  }),
// MAP_MODE_COMPATIBILITY:
  frontier: Object.freeze(['conquest', 'titanfall']),
  harbor:   Object.freeze([...COMBAT_MODE_IDS, 'titanfall']),
  canyon:   Object.freeze([...COMBAT_MODE_IDS, 'titanfall']),
  ashfall:  Object.freeze(['titanfall']),          // titanfall-only map (§14)
// COMBAT_MODE_IDS / NO_BOMB_SITE_MODE_IDS: unchanged.
// OWNED_LOADOUT_MODES: add 'titanfall' in the array literal.
export const isTitanfall = mode => mode === 'titanfall';
export const modeHasVehicles = mode => mode === 'conquest' || mode === 'titanfall';
export const isCombinedArms = modeHasVehicles;          // bot brain widening (§9)
```

There is no `fallDamage` key: nothing reads it, and no fall damage follows from the policy having
no `fallDamage` method (§1).

`shared/lobby-limits.js`: `hasLobbyTeams` adds `titanfall`; `lobbyCapacity` returns
`Math.min(mapLimit, 16)` for titanfall. `modeAllowsBots` already allows it.

`public/js/ui/hud-support.js`: WP0 adds `MODE_LABELS.titanfall = 'TITANFALL'` (the lobby lists
every `MODE_IDS` entry, `lobby-settings.js` L57). `server/lobby.js`: an equivalent of the
`staleConquestClient` guard (L137, used at L391) rejects configuring titanfall when a member's
client predates the titanfall contract (`hello.titanfall >= TITANFALL_CONTRACT_VERSION`; netclient
sends it).

Pinned tests that WP0 updates in the same change:

| Test | Update |
|---|---|
| `tools/atlastest.mjs` | MODE_IDS, `expectedRules` (titanfall entry, recursively frozen), `expectedCompatibility` (frontier `['conquest','titanfall']`, harbor/canyon `[...COMBAT_MODE_IDS,'titanfall']`) |
| `tools/map-capacity-test.mjs` | titanfall × frontier/harbor/canyon at capacity 16 |
| `tools/conquest-vehicles-test.mjs` | row-budget loop iterates `VEHICLE_TYPE_IDS` |
| `tools/conquest-vehicle-seats-test.mjs` | L34 deep-equal and the L37/L54/L196 loops iterate `VEHICLE_TYPE_IDS` keys only (`VEHICLE_SEATS` is derived from `VEHICLE_DEFS` and picks up titans) |
| any test over `VEHICLE_COLLIDERS`, `VEHICLE_DESTRUCTION_RULES`, `VEHICLE_RULES`, `VEHICLE_HANDLING`, `Object.keys(VEHICLE_WEAPONS)` | WP0 greps `tools/` for each derived registry and restricts conquest assertions to conquest keys |
| `server/lobby.js` preserveTeams | `['tdm','snd','conquest']` → add `'titanfall'` |

### 2.2 `shared/titan-contract.js` (new, WP0; dependency-free)

This module has **no imports** (it would otherwise pull `conquest-contract.js` into a cycle and
grow the preload graph). It is small and deep-frozen. It defines its own `S`/`M` helpers that
produce **exactly** the `VEHICLE_TOPOLOGY` row shape from `conquest-contract.js` L150-151:
`S(id, role, drives, exposed, personalWeapons, mounts)` and `M(id, weapons)`.

```js
export const TITANFALL_CONTRACT_VERSION = 1;
export const TITAN_TYPE_IDS = ['titan_ion', 'titan_scorch', 'titan_northstar', 'titan_ronin', 'titan_legion'];
export const TITAN_CHASSIS = { titan_ion: 'atlas', titan_scorch: 'ogre', titan_northstar: 'stryder',
                               titan_ronin: 'stryder', titan_legion: 'ogre' };
export const TITAN_ARMOR_CLASS = 'titan';
export const TITAN_MV = { ground: 0, sprint: 1, slide: 2, wallrun: 3, air: 4, grapple: 5,
                          rodeo: 6, embarking: 7, piloting: 8, ejecting: 9 };   // tf[0] enum
export const TITAN_ABILITY_SLOTS = ['defensive', 'tactical', 'ordnance', 'core'];
const S = (id, role, drives, exposed, personalWeapons, mounts) => Object.freeze({ id, role, drives, exposed, personalWeapons, mounts: Object.freeze(mounts) });
const M = (id, weapons) => Object.freeze({ id, weapons: Object.freeze(weapons) });
export const TITAN_TOPOLOGY = Object.freeze({   // type -> [seat rows], same as VEHICLE_TOPOLOGY
  titan_ion:       Object.freeze([S('driver', 'pilot', true, false, false, [M('splitter', ['splitter'])])]),
  titan_scorch:    Object.freeze([S('driver', 'pilot', true, false, false, [M('t203', ['t203'])])]),
  titan_northstar: Object.freeze([S('driver', 'pilot', true, false, false, [M('railgun', ['railgun'])])]),
  titan_ronin:     Object.freeze([S('driver', 'pilot', true, false, false, [M('leadwall', ['leadwall'])])]),
  titan_legion:    Object.freeze([S('driver', 'pilot', true, false, false, [M('predator', ['predatorClose', 'predatorLong'])])]),
});
export const TITAN_WEAPON_META = { /* §5.4, same shape as VEHICLE_WEAPON_META */ };
export const TITAN_ABILITIES = { /* §5.5, data over primitives */ };
export const TITAN_KILL_KEYS = { /* key -> label, §2.3 */ };
export const TITAN_PILOT_TACTICALS = ['grapple', 'stim', 'cloak'];
export const TITAN_PILOT_PRIMARIES = ['rifle', 'smg', 'shotgun', 'lmg', 'kraber'];
export const TITAN_PILOT_AT = ['chargerifle', 'archer', 'thunderbolt', 'mgl'];
export const isTitanType = type => Object.hasOwn(TITAN_TOPOLOGY, type);
/** Titanfall kit role by id (not conquest's kitWeaponRole): 'primary'|'sidearm'|'at'|'melee'|null. */
export function titanWeaponRole(id) {}
export const TITANFALL_DIGIT_ROLES = ['primary', 'sidearm', 'at', 'melee'];   // digits 1..4
export function packTitanLoadout({ primary, at, tactical, titan }) { /* §3.4 */ }
export function unpackTitanLoadout(n) { /* inverse; invalid → defaults */ }
export function encodeTitanfallPlayer(p) {}   export function decodeTitanfallPlayer(row) {}
export function encodeTitanfallSelf(p) {}     export function decodeTitanfallSelf(frame) {}
export function encodeTitanRow(v) {}          export function decodeTitanRow(row) {}
```

Legion has **one** mount with two weapons. Mode Switch reuses the existing mount `weapon` select
action and the `sel` row field, so only one Predator fires.

### 2.3 Additive helpers in `shared/conquest-contract.js` (WP0)

The header says the file is frozen at `CONQUEST_CONTRACT_VERSION = 3`. These additions are
**additive only**. Conquest output is unchanged because the conquest types resolve first.

```js
import { TITAN_TOPOLOGY, TITAN_WEAPON_META } from './titan-contract.js';
const topologyOf = type => VEHICLE_TOPOLOGY[type] || TITAN_TOPOLOGY[type];
export const vehicleWeaponMeta = key => VEHICLE_WEAPON_META[key] || TITAN_WEAPON_META[key] || null;
// vehicleMountOrder(type), seatWeaponList(type, seat), and vehicleDriverSeat if it reads
// VEHICLE_TOPOLOGY: change the VEHICLE_TOPOLOGY[type] read to topologyOf(type).
```

`titan-contract.js` stays tiny and import-free, so it adds one small module to the preload graph.

META consumers (WP0):

| Consumer | Change |
|---|---|
| `shared/vehicle-defs.js` `weapon(key, numbers)` | read `vehicleWeaponMeta(key)` |
| `public/js/vehicles/vehicle-fx.js` `_shoot` | read `vehicleWeaponMeta(key)` (it returns false without META) |
| `public/js/ui/hud-support.js` L47 `WEAPON_NAMES`, L61 `VEHICLE_KILL_KEYS` | these iterate `Object.entries(VEHICLE_WEAPON_META)`. Spread `TITAN_WEAPON_META` labels and `TITAN_KILL_KEYS` labels into `WEAPON_NAMES`, and append both key lists to `VEHICLE_KILL_KEYS` |
| `public/js/ui/conquest/icons.js` `KILL_KEY_ICONS` | titan keys mapped to existing glyphs (`splitter`/`predator*` → `mg`, `railgun` → `autocannon`, `t203`/`leadwall` → `shell`, `titanfall`/`titanMelee`/`titan_doom` → `crash`, ability keys → `rocket`); WP5 may add titan glyphs later |
| `public/js/vehicles/voxel-model/anchors.js` | add a separate `TITAN_TYPES`; do not widen `VEHICLE_TYPES` |

Not touched: `vehicle-audio.js` (has no META lookup) and `conquest-hud-state.js` (already falls
back with `|| {}`; dirty file).

`TITAN_KILL_KEYS` (frozen in WP0): `splitter`, `t203`, `railgun`, `leadwall`, `predatorClose`,
`predatorLong`, `titanMelee`, `titanfall` (drop crush), `titan_doom`, `titan_crush` (walk crush),
`rodeo` (battery rip / hatch), `electricSmoke`, `laserShot`, `laserCore`, `tripwire`, `thermalShield`,
`incendiaryTrap`, `firewall`, `flameCore`, `tether`, `cluster`, `flightCore`, `arcWave`,
`powerShot`, `thermite`. `titanfall-contract-test` asserts every key has a `WEAPON_NAMES` entry and
a `KILL_KEY_ICONS` glyph that exists in `ICON_PATHS` (mirrors `conquest-ui-test` L481-495).

Bots (`bot-aircraft.js`, `bot-vehicle-combat.js`, `bot-commander.js`) keep their conquest reads.
WP7 adds titan branches.

### 2.4 Armour — `shared/vehicle-armor.js` (WP0)

`tools/conquest-vehicle-combat-test.mjs:68` deep-equals every `ARMOR_MATRIX` row, so the titan
column lives in a **separate table**:

```js
export const TITAN_ARMOR = Object.freeze({
  small: 0.06, mg: 0.08, hmg: 0.2, autocannon: 0.5, explosive: 0.35, he: 0.6, at: 1.0, aa: 0.3, fire: 0.6,
  titan: 1.0, melee: 1.0, titanfall: 1.0, rodeo: 1.0,
});
export const TITAN_ZONES = Object.freeze({ rear: 1.3, top: 1.15, front: 1.0, side: 1.0 });
// isArmorClass(armor): ARMOR_CLASSES.includes(armor) || armor === 'titan'
// armorMultiplier(cls, armor, zone):
//   if (armor === 'titan') return (TITAN_ARMOR[cls] ?? 0) * (TITAN_ZONES[zone] ?? 1);   // first line
//   ...existing body unchanged
```

**Every titan weapon and titan ability uses cls `'titan'` (1.0)**, so the damage numbers in §5.4
and §5.5 are the numbers dealt (before zone and shield). Pilot weapons keep their infantry classes
(`infantryDamageClass`): small arms are 0.06, AT weapons declare `damageClass: 'at'`. The
titan-only classes (`titan`, `melee`, `titanfall`, `rodeo`) are never passed to `isDamageClass`
or the conquest matrix: only titan hulls exist in titanfall, and titan damage to pilots uses
`infantryDamage` without armour.

### 2.5 Defs — `shared/vehicle-defs.js`, `shared/vehicles.js`, `shared/vehicle-collision.js` (WP0)

```js
import { TITAN_TYPE_IDS } from './titan-contract.js';
import { TITAN_DEFS_INPUT } from './vehicle-handling/titan.js';          // frames, hulls, seats (§5.1)
import { TITAN_WEAPONS } from './vehicle-handling/titan-weapons.js';     // WP0 stub numbers, WP3 tunes
const DEF_TYPE_IDS = [...VEHICLE_TYPE_IDS, ...TITAN_TYPE_IDS];
export const VEHICLE_WEAPONS = freeze({ ...conquestEntries, ...TITAN_WEAPONS });       // L108
export const VEHICLE_DEFS     = freeze(Object.fromEntries(DEF_TYPE_IDS.map(t => [t, buildDef(t)])));
export const VEHICLE_HANDLING = freeze(Object.fromEntries(DEF_TYPE_IDS.map(t => [t, VEHICLE_DEFS[t].handling])));
export const VEHICLE_RULES    = freeze(Object.fromEntries(DEF_TYPE_IDS.map(t => [t, VEHICLE_DEFS[t].rules])));
// LOCK_RULES gets `archer: { range: 180, cone: 6°, seconds: 1.2 }` (consumer is WP4).
```

`VehicleSystem` reads `VEHICLE_RULES[v.type].radius/.height` unguarded (`rayHit`, `projectileHit`,
`hullContains`, `hullCenter`, collision); `VEHICLE_WEAPONS[key]` is read unguarded by
`VehicleMounts.create/tickTimers/select/fire/rows` and `launchVehicleProjectile`. Both registries
must therefore cover titans from WP0 on. Each `TITAN_WEAPONS` stub entry carries every field those
readers use: `cooldown`, `magazine`, `reloadSeconds`, `range`, `spreadDeg`, `lifetimeMs`, `speed`,
`gravity`, `damage`, `infantryDamage`, `cls: 'titan'`.

`buildDef` gets a titan branch that reads `TITAN_DEFS_INPUT`:

| Field | Value |
|---|---|
| `handling` | `'walker'` |
| `armor` | `'titan'` |
| `damageClass` | `'titan'` |
| `openCrew` | false |
| `rules` | `{ height, radius, enterDistance: 6, gravity: 24, seatHeight: eye − 0.6, ceiling: SY }` per frame (§5.1) |
| `collider` | box from `hw × hl × height` |
| `hullBoxes` | legs (2), pelvis, torso, cockpit hatch (front), battery hatch (rear) |
| `seatCameras.driver` | `{ views: ['cockpit', 'chase'], eye: frame.eye, eyeFrame: 'hull' }`. Hull yaw equals aim yaw for a piloted titan (§5.1), so the eye and the gun share the crosshair. |
| `mountAnchors` | per titan primary: `{ pivot, muzzle, yawLimit: [0, 0.35], pitchLimit: [-1.15, 0.7], yawRate: 8, pitchRate: 6 }` (the existing `clampMountAim` handles the twist; no change to `mountAim` or `turretLocal`) |
| `respawnSeconds` | `Infinity` (ephemeral) |
| `destruction` | numeric blast `{ radius: 6, damage: 120, damageFalloffExponent: 1.5 }` (read by `VEHICLE_DESTRUCTION_RULES`, `vehicleDestructionBlast` and `destroy()`); fragments come from the model through the generic `createVehicleFragments(model)` |
| `VEHICLE_MASS` | per frame (§5.1) |
| `VEHICLE_RAM` | none |
| `HULL_CRASH_RULES` | shared default |

- `shared/vehicle-collision.js`: `VEHICLE_COLLIDERS` covers titans automatically. `solidHull(v)` returns **false while `v.dropping`** (`(vehicle.hp > 0 && !vehicle.dropping && vehicle.tw?.[5] !== 1)`: the snapshot row has no `dropping`, so a client row is non-solid by `tw[5] === 1` (phase dropping) and client prediction agrees with the server). `solidWreck()` must return true for titan wrecks (the rules entry makes that work; the contract test asserts it).
- `vehicleEnterDistance(type)` resolves 6 through `VEHICLE_RULES[type].enterDistance`.

`titanfall-contract-test` asserts: `rayHit` and `projectileHit` run without error against a titan
hull and hit it; `VehicleMounts.reset(v)` on a titan does not throw; `solidWreck` is true for a
titan wreck; the titan row budget is average ≤ 280 B, hard max 300 B.

### 2.6 Pilot hooks — `shared/pilot-movement.js` (new, WP0 stub, WP1 owns the body)

The **only** hook list (frozen by WP0, exact names and signatures):

```js
export const PILOT_RULES = Object.freeze({ /* §4.1 */ });
export function createPilotState() {}                       // {wall, wallT, jumpsLeft, slideT, slideCd, grapple, chain, lastGroundY, ...}
export function pilotSpeedFor(state, input, base) {}         // -> speedTarget (input: {sprint, crouch, ads, stim})
export function pilotPreStep(state, body, input, ctx, dt) {} // after the jump edge: double jump / wall-jump / slide entry; -> bool handledJump
export function pilotAccel(state, body, wish, ctx, dt) {}    // -> true when it replaced the accel blend (air strafe, slide, wallrun)
export function pilotVertical(state, body, ctx, dt) {}       // -> true when it replaced gravity (wallrun, grapple)
export function pilotPostCollide(state, body, ctx, contacts, dt) {} // after slideAxis: wall probe, landing, speed clamp
export function stepPilot(state, body, input, ctx, dt) {}    // whole step, for the parity test only
export const PILOT_STATE_KEYS = ['wall', 'wallT', 'jumpsLeft', 'slideT', 'slideCd', 'grapple', 'tac'];
```

WP0 places the five hook calls in `server/sim/movement.js` `stepMovement` and
`public/js/player-physics.js` `PlayerPhysics.step`, each behind `ctx.pilotRules` /
`this.pilotRules` (false everywhere else, so stock movement is untouched). The stubs return
`false` / `base`. **After WP0 lands, both movement files belong to WP1**, which may move the hook
positions (for example around `slideAxis` wall contact or the jump placement asymmetry) as long
as non-titanfall paths stay identical.

---

## 3. Wire protocol

### 3.1 Player row `tf` (public; only when `mode === 'titanfall'`)

`server/protocol/snapshot.js` `playerRow` appends `tf` the same way it appends `cq`/`cqs`.
`PLAYER_KEYS` stays exact.

| idx | field | encoding |
|---|---|---|
| 0 | mv | `TITAN_MV` enum int |
| 1 | titanId | short id `"T<n>"`, or `0` |
| 2 | loadout | packed int (§3.4) |
| 3 | flags | bit 0 carrying battery, 1 cloaked, 2 stimmed, 3 doomed-eject cloak, 4 grappling, 5 OOB warning, 6 waiting for DEPLOY, 7 DEPLOY queued, 8 staged (held off the field without a death: join, match start, team change, bot takeover) |
| 4 | meter100 | 0..100 int |
| 5 | rodeoVehicleId | `"T<n>"`, or `0` |
| 6 | grapple anchor | `[x,y,z]` in tenths, or `0` |
| 7 | titanKills | int (scoreboard column) |

### 3.2 Self-only frame `tfs` (separate per-member message)

`tfs` is **not** merged into the tick through `viewFor` (a per-recipient tick object bypasses the
`decorateSnapshot` WeakMap and the `payloadCache` and costs a full decorate plus stringify per
member at 60 Hz). Instead `lobby._broadcastJson`, after sending a tick, sends each member the
small frame returned by `room.engine?.mode.policy.selfFrame?.(member.id, obj)`:
`{ t: 'tfs', s: <tick seq>, d: [...] }`. Other modes return nothing, so nothing changes for them.
Netclient routes `t:'tfs'` to `onTitanfallSelf`; `LocalPlayer.reconcile` adopts the frame whose
`s` matches the reconciled snapshot.

| idx | field | idx | field |
|---|---|---|---|
| 0 | vx ×100 | 6 | slideT ×100 |
| 1 | vy ×100 | 7 | slideCd ×100 |
| 2 | vz ×100 | 8 | tacCharges |
| 3 | wallN (0, ±1 x, ±2 z) | 9 | tacReady100 |
| 4 | wallT ×100 | 10 | jumpSeqAck |
| 5 | jumpsLeft | 11 | lockProgress100 (AT lock-on) |

`titanfall-mode-test` measures `tfs` frame plus tick serialization cost for a 16-bot lobby and
asserts the tick is stringified once per tick (cache hit for every member).

### 3.3 Vehicle row extras (titans only)

`VehicleSystem.row` calls `this.titans?.rowExtras(v, row)`. That call is the only titan touch in
`row`.

| key | content |
|---|---|
| `tw` | `[shield, dashTenths, core100, doomPhase (0 alive, 1..70 doom tenths left, rounded up so a doomed titan never encodes 0), abilityBits, phase]`; `decodeTitanRow().doomed` is `tw[3] > 0 \|\| phase === 6`. `phase`: 0 idle, 1 dropping, 2 landed-crouch, 3 embark, 4 disembark, 5 auto, 6 doomed, 7 ejected-empty. `abilityBits`: bit 0 core active, 1 defensive up, 2 hover, 3 phased, 4 batteryOut, 5 rider on board, 6 smoke |
| `own` | owner player id |
| `ab` | `[def100, tac100, ord100, smokeCharges]` readiness |

- `row` reads `v.spawn.flag`; titans get `v.spawn = { flag: null }`.
- The row has no `vx`/`vy`/`vz` unless the titan is dropping or hovering.
- Titan mount rows are a 6-tuple `[yaw, pitch, ammo, heat100, reload100, charge100]`; the conquest 5-tuple is unchanged.

`tools/lib/protocol-contract.mjs` (WP0) adds `TITANFALL_PLAYER_EXTRA_KEYS = ['tf']`,
`TITANFALL_SELF_KEYS` (the `tfs` frame), `TITANFALL_MATCH_KEYS = ['titanfall']`,
`TITAN_ROW_EXTRA_KEYS = ['tw', 'own', 'ab']`, and the tuple lengths (`tf` 8, `tfs` 12, `tw` 6,
`ab` 4, titan mount 6).

### 3.4 Loadout pack

The loadout is 4 fields, 4 bits each:

```
primary(0..4) | at(0..3) << 4 | tactical(0..2) << 8 | titan(0..4) << 12
```

`unpackTitanLoadout` clamps every field. An unknown value falls back to the default
`rifle / chargerifle / grapple / titan_ion`.

### 3.5 Match block

`match.titanfall = { v: 1, endsAt, scoreLimit, sc: [alpha, bravo], bat: [[id, x, y, z], ...], bay: [alphaTitans, bravoTitans, cap] }`.
`bat` holds at most 12 dropped batteries, coordinates in tenths. Budget: ≤ 400 B.

### 3.6 Input additions (`applyInput`, titanfall only)

| Field | Type | Meaning |
|---|---|---|
| `jumpSeq` | uint8 | increments on every jump press. **Edge de-duplication only**: the server (60 Hz, `TICK_RATE_HZ`) consumes each new value once, so a double-jump or wall-jump press is not lost or applied twice between input packets. There is no client input replay. |
| `titanHold` | bits | 1 sprint, 2 defensive held, 4 ADS, 8 reload, 16 melee held, 32 core |

- `server/game.js`: widen only `groundNavigation` (L191) and `vehicleAction` (L449) to `modeHasVehicles(mode)`. The two `vehicles.reset` calls (L169, L375) stay conquest-only, so titanfall passes `[]`.
- The keys whitelist accepts `jumpSeq` and `titanHold` only when `isTitanfall(mode)`. Netclient sends `jumpSeq`/`titanHold` only when defined, so `tools/contracts/netclient-contracts.mjs` and `input-contracts.mjs` fixtures stay byte-identical (WP0 asserts it).
- Embark lock: `TitanfallPolicy.canMove(p)` returns false while `p.embarkUntil > now` (game.js L621 recomputes `ctx.movementLocked` from `canMove` every tick).

Walker controls on the wire reuse the seated send (main.js L1184-1230), with a walker branch in
`VehicleController.controls` (WP6): `vehicleThrottle` = forward/back, `vehicleSteer` = strafe,
input `yaw`/`pitch` = aim, `titanHold` bit 1 = sprint. Dash is the reliable intent `ability:'dash'`
(the client predicts it when sending).

### 3.7 Intent `{ t: 'titanfall', ... }`

`server/index.js` → `lobby.titanfall(meta, intent)` (same rate gaps as `lobby.conquest`) →
`engine.titanfallIntent` → `policy.titanfallIntent`. `server/protocol/admission.js` adds
`parseTitanfallIntent` with exactly one key per message:

| key | value | when |
|---|---|---|
| `loadout` | packed int | lobby, deploy screen, or while dead |
| `deploy` | packed int | DEPLOY on the loadout screen: stores the pick and requests the spawn (deploy gate below) |
| `call` | `[x,y,z]` aim hint (the server re-raycasts from the eye) | meter full, no titan, bay slot free |
| `ability` | `'def' \| 'tac' \| 'ord' \| 'core' \| 'smoke' \| 'dash' \| 'melee' \| 'mode'` | piloting |
| `eject` | `1` | piloting **and doomed** (refused otherwise) |
| `tac` | `1` | pilot tactical (grapple aim from input yaw/pitch) |
| `rodeo` | `'mount' \| 'rip' \| 'insert' \| 'dismount'` | near a titan |

**Deploy gate** (`TitanfallPolicy`, humans only; bots keep the plain 4 s timer): a human is never put on
the field without a `deploy` request. Join, match start, rematch, lobby team change and a bot takeover
*stage* the player (state `dead`, no event, no death counted; an alive taken-over bot body leaves its seat
and the field, its titan stays); every death waits for DEPLOY too. `canTimedRespawn` passes once the
respawn time is reached and `deploy` was sent (sent earlier = queued), or `DEPLOY_RULES.timeoutMs`
(20 s, `TITANFALL_DEPLOY_TIMEOUT_MS` in the contract) after the respawn time as an idle / stale-tab
fallback that spawns with the last selection. A *staged* human whose client never sent input (map
still loading at match start, a mid-match join or a takeover) keeps that clock at zero
(`beforeTick`, as Conquest's `_holdDeployClock`), so the 20 s start with the first input.
The spawn is a normal protected respawn with the deployed loadout, so the first life always runs the
pick. Client: the loadout opens while `tf` flag 6 is set; its chip reads `RESPAWN IN n.n` while the
timer runs (not while staged), then `AUTO-DEPLOY IN n S` (respawn time + the timeout); DEPLOY / pad A
sends `deploy`, closes the screen and restores pointer lock inside the click; a queued deploy shows
`DEPLOYING IN x.x` on the dead HUD; main.js skips the death presentation for a staged row.
`policy.deployNow(id)` is the synchronous join spawn for node suites.

Embark and disembark reuse `vehicleAction` `enter` and `exit`. Client:
`public/js/engine/netclient.js` adds `TITANFALL_INTENT_FIELDS`, `sendTitanfall` and the `tfs`
route.

### 3.8 Events (`engine.emit`)

| Event | Payload |
|---|---|
| `titanfall_drop` | `{ owner, vehicleId, x, y, z, landsAt }` |
| `titanfall_refused` | `{ owner, reason: 'meter'\|'sky'\|'range'\|'owned'\|'bay'\|'spawn'\|'fluid'\|'uneven'\|'blocked'\|'enclosed' }` |
| `titan_embark` / `titan_disembark` | `{ id, vehicleId }` |
| `titan_doomed` | `{ vehicleId, by }` |
| `titan_eject` | `{ id, vehicleId }` |
| `titan_destroyed` | reuses `vehicle_destroyed` |
| `rodeo_mount` / `rodeo_rip` / `rodeo_insert` / `rodeo_off` | `{ id, vehicleId }` |
| `battery_drop` / `battery_pickup` | `{ id?, x, y, z }` |
| `core_ready` / `core_start` / `core_end` | `{ vehicleId }` |
| `oob_warning` | `{ id, until }` |
| `titan_ability` | `{ vehicleId, ability, ... }` (WP3, presentation). `ability`: `vortex` / `thermal` / `gunShield` / `block` `{ until }` (null while held); `vortexThrow` `{ caught, damage }`; `laserShot` / `powerShot` `{ o, end }`; `cluster`; `tripwire` `{ id, mines, until }`; `tripwireTrigger` `{ id, mines }`; `incendiaryTrap` `{ id, x, y, z, until }`; `trapIgnite` `{ id, x, y, z }`; `tether` `{ id, x, y, z, until }`; `tetherTrigger` `{ id, target, until }`; `deployableEnd` `{ id, deployable }` (spent, expired or replaced); `firewall` / `arcWave` / `flameCore` `{ x, y, z, yaw, length, until }` (a ground line from x, y, z along yaw); `phaseDash` `{ x, y, z, blink }`; `hover` / `flightCore` `{ until }`; `modeSwitch` `{ weapon }`; `smoke` `{ until }`; `melee` `{ target, executed }`; `execution` `{ target }` |
| `shoot` (ability) | hitscan abilities (`laserShot`, `powerShot`, `vortexThrow`) also send a vehicle `shoot` with `ability` set, `o` the ability anchor, one `paths` entry per ray and `vehicleWeapon` the titan weapon whose look stands in (`railgun`, `predatorClose`, `splitter`) |

Client event fan-out goes through the main.js `onGameplayEvent` hook (§8.5). `shared/titan-contract.js`
exports the kinds as the frozen `TITANFALL_EVENT_KINDS`; `session.js` spreads it into
`GAMEPLAY_EVENT_KINDS` (like `CONQUEST_EVENT_KINDS`), and `titanfall-contract-test` pins it against
every kind the titanfall server code emits and against the real Session subscription.

---

## 4. Pilot movement (WP1)

Gated by `ctx.pilotRules` (server: `server/sim/context.js` movement context `get pilotRules()`
returns `isTitanfall(mode)`) and `physics.pilotRules` (client: `handleTick` sets it next to
`physics.airRules`). Hooks: §2.6. `airRules` stays false in titanfall (no chute, no canopy on an
airborne jump press).

Client prediction lives in `LocalPlayer` (WP1 owns every titanfall-gated branch there):

- `_stepPrediction`: in titanfall it calls `pilotSpeedFor(state, {sprint, crouch, ads, stim}, base)` instead of `moveSpeedFor(keys, ads)` and passes the sprint/crouch state that slide entry needs into `physics.step`.
- `reconcile`: `this.physics.adoptPilot?.(tfs)` next to the existing `adoptChute` call. On a position error above 0.25 m it snaps the hidden pilot state (velocity, wall, jumps, slide) from `tfs` and keeps the existing soft position correction. There is no input replay.
- `_lockMovement` clears pilot state; while `rodeoVehicleId` is set, prediction is off and the pose follows the titan's back anchor.
- `_sendInputMaybe` sends `jumpSeq`.

### 4.1 Numbers (`PILOT_RULES`)

| Rule | Value |
|---|---|
| walk / sprint / crouch | 5.2 / 8.5 / 2.6 m/s |
| speed clamp | horizontal hard clamp 14 m/s outside grapple; airborne soft drag 2 m/s² above 11 m/s (not during a wall-jump chain). Stim does not raise the clamp. |
| jump vy / double jump vy | 8.2 (PHYSICS) / 7.4 |
| air accel | Quake-style air strafe, `airWishCap` 1.6 m/s projected, accel 60 |
| wallrun entry | airborne and near a wall while moving along it, **no held key needed**, an aggressive catch: ≥ 0.75 m of air under the feet here and 1 m and 2 m ahead along the run (stairs never start one); a solid wall within 0.75 m of the hull on ±X or ±Z at feet +0.3, +1.0 **and** +1.8, beside the hull or one voxel ahead (a runner over a one-voxel gap still catches), with at least 2 of the next 3 voxels along the run walled (a lone post or crate is not a wall); tangential speed ≥ 2.5; at most 80° into the wall (not moving away from it faster than 1.5 m/s); a wish, if any, not more than 72° into the wall (dot(wish, wallNormal) ≥ −0.95) and not back along the run; the feet not higher than `lastGroundY + 8`; bots never wallrun. |
| wallrun | 1.5 s. Speed: entry keeps the tangent plus 0.75 × the speed into the wall (never more than the speed it had), at least 9 m/s; running along the wish builds 3 m/s² up to 11 m/s (a faster entry keeps its speed under the clamp); no wish coasts down 3 m/s², a wish back brakes 6 m/s². Height: entry vy clamped to [1, 2] × `0.85^n` (a falling catch pops up), gravity ramps from 2 to 9 m/s² (quadratic in wallT); no wallrun, wall-jump or chained double jump lifts the feet past `lastGroundY + 8`. A full sprint-jump run covers 15.4 m (Ashfall's 16 m faces carry it). Camera roll ±13°. |
| wallrun contact | the catch pulls the hull flush at up to 9 m/s for its first 0.2 s, then at up to 5 m/s; any of the three probe heights holds the run (window rows, door tops); a wall one voxel farther (recess, a slight angle away) becomes the run's plane; with no wall the run coasts up to 0.35 s if the wall resumes within 2 m ahead (1-2 voxel gaps); a wall stepping one voxel toward the runner (pillar, slight angle toward) is stepped around (the hull moves one voxel out, keeps the step's travel and speed; `shiftX/Z` count it for the camera, `wallStepAt` keeps the stepped voxel's near edge), at most one step per 1.5 m along the run (`stepGap`: a 1:2 voxel slant, 27°, runs; a 45° staircase ends at its second step) and never into a live hull (a parked titan); the tangent speed obeys the speed rules, so on a 1:2 slant the ground covered is √5/2 ≈ 1.12 × the run's travel; a 3 m gap, an outer corner (released with the run's speed) or an inner corner/crate ends it; crouch, pulling away (dot > 0.7) or < 2 m/s along the wall end it. |
| wall-jump | speed `max(run speed, 9) + 1` (under the clamp), aimed by the wish between 30° and 65° off the wall (30° without a wish) and forward along the run; vy `7.6 × 0.85^n` (n = wall-jumps since last ground; the chained double jump decays alike); the soft air drag spares a chain (`chain > 0`), so chains build speed to the clamp; restores the double jump; the jumped-off wall is spent until ground or another wall and locked out 0.35 s |
| mantle | an airborne pilot moving forward grabs a ledge whose top is up to 2.05 m above its current feet (stock players reach only from the takeoff ground); the vault then runs as stock (0.48 s). Bots keep the stock grab. |
| slide | entry: sprint + crouch with speed ≥ 6.5; boost +2.5 only when entering at ≤ sprint speed + 0.5 (cooldown 2 s); friction 7 m/s² (≈ 1.1 s, ≈ 9 m from 11 m/s), plus 4 m/s² extra per uphill voxel step; ends below 3 m/s; crouch hitbox; slide-hop keeps the speed if jump comes within 0.2 s of landing (clamp still applies) |
| grapple | range 38 m, needs a solid voxel or a titan; accel 32 toward the anchor, cap 22 m/s, 1.6 s max; 2 charges, 6 s recharge each; releases on jump, on reaching the anchor, or on LOS loss |
| stim | 4 s, speed ×1.3 (under the clamp), regen delay 0 and regen 30 hp/s during stim; cooldown 12 s |
| cloak | 5 s, cooldown 15 s, refraction shimmer (client). Perception rule below. |
| regen | 5 s after the last damage, 20 hp/s (server, reported through the hp row) |
| fall damage | none (policy has no `fallDamage`) |
| OOB | a pilot outside the play area or above `SY + 4` gets a 3 s warning (`tf[3]` bit 5, `oob_warning`) and then dies (key `restricted`); the HUD banner counts down from the event's `until` (`RETURN TO THE BATTLEFIELD · n S`) |

**Wallrun feel, measured** (`node tools/titanfall-wallrun-measure.mjs`, the authoritative integrator at 60 Hz;
before = the first WP1 rules, after = the rules above; pinned by `titanfall-pilot-movement-test.mjs`):

| Measure | Before | After (Titanfall 2 target) |
|---|---|---|
| held key | needed | not needed (no wish: the run coasts 9.7 → 5 m/s) |
| airborne entry angles (8.5 m/s, 0.3 m out) | 5–45° | 5–70° (80° head-on does not attach); 5 m/s without a key 5–60° |
| sprint + ground jump at the wall | attaches 0.22 s after the jump at 1.21 m; from 1 m out only 15–45° | 0.12 s at 0.77 m from up to 1 m out at 15–70° (5°: 0.35 s); from 2 m out 20–70° in 0.17–0.43 s (2026-10-16 aggressive catch; before it 0.15 s at 0.93 m, nothing from 2 m out) |
| speed along the run | 8.2 → 9.0, flat | 8.2 → 11.0 (builds 3 m/s²) |
| height profile | +0.82 m, then sinks 1.14 m below the catch into the floor at 1.65 s | +0.84 m at 0.75 s, −0.59 m at 1.5 s (time limit), end vy −4.5 |
| full run | 14.6 m (ended by the floor) | 15.4 m in 1.5 s |
| 1- / 2-voxel gap, 2 × 2 window, window facade, pillar, recess, 1-voxel step, 9.5° and 27° (1:6, 1:2) angled walls | every one ended the run at the feature (facade after 0.15 s) | all carried through the full 1.5 s; 3 m gaps, corners and a 45° voxel staircase (0.6 s, at its second step) end it |
| wall-jump | 11 m/s at 36°, fixed | run speed + 1 at the aim (30–65°) |
| catch speeds along a 4 m alley chain | 8.2 → 7.7 (lost speed) | 9 → 10.2 → 10.9 → … → 14 (builds) |
| street chain (best of the harness's aim/timing grid), walls caught | 4 m 9, 6 m 4, 8 m 2, 10–14 m 1 | 4 m 20, 6 m 16, 8 m 10, 10 m 6, 12 m 3 (timed double jump), 14 m 1 |
| street chain, untuned (aim 45°, 0.25 s on each wall, double jump falling at 3 m/s) | – | 4 m 20, 6 m 9, 8 m 3, 10–14 m 1 (before the aggressive catch 4 m 17, 6 m 8, 8 m 2); double jump at the apex and a 60° aim: 8 m 5. The grid's 8–12 m numbers need a 60–65° aim after 0.5 s on the wall. |
| double jump after a catch / wall-jump | restored | restored |
| stairs (1 m / 2 m / down), 2 m low wall | 0 wallrun ticks | 0 (stair climbs gained 2 m steps through the mantle) |
| hopping 1–2 m crates beside a tall wall (held jump, 3 angles × 5 s) | – | three runs (248 ticks), the lowest from a hop 2.13 m up: intended catches off the hops, never off a crate top (pinned: at most four, every one entered ≥ 2 m up) |
| eye at a step-around (pillar, 1-voxel step, 1:6 / 1:2 / 1:1 slants; client path at 30 / 144 / 240 Hz) | inside the stepped voxel for 1–9 frames (up to 0.12 m deep), 53 of 228 frames on a 1:2 slant | never inside; ≥ 0.13 m from any voxel at eye height; sideways ≤ 6.6 m/s (0.046 m per 144 Hz frame) |
| camera roll (8 m chain, 144 Hz frames) | 11.3° peak, 105°/s, 15 134°/s² (velocity snap), 7.9° after 0.1 s | 12.4° peak, 73°/s, 2 745°/s² (spring, no overshoot), 5.6° after 0.1 s, 11.7° after 0.25 s; no wobble along a window facade |
| FOV kick | one-frame +3° jump (404°/s) | eases in (66°/s) |
| Ashfall faces (Hab alley ×2, annex window facade, smelter door face) | 1.65 / 1.65 / 0.42 / 0.78 s | 1.52 s and 15.4 m each |
| Ashfall Hab alley chain (4 m) / cross street (14 m) | 6 / 1 walls | 13 / 1 walls (2 dropping in from 6 m up) |

Titanfall 2 for comparison: attach by touching a wall in the air while moving along it, a short kick
then low gravity with a slow sink, momentum kept and built toward a cap, the wall-jump out and
forward, the double jump back after a wallrun, about 10–15° of smooth roll, chains that make speed,
forgiving contact on uneven walls. The run here is 1.5 s instead of 1.75 s so that a full run at
11 m/s fits Ashfall's 16 m faces. The 14 m cross streets are titan lanes: crossing one takes speed
and height (a drop from the bridges), not a ground start.

**Perception** (`server/sim/titanfall/perception.js`, WP1, one helper reused by bots, auto-titans,
Smart Core and the Archer lock): `isPerceivable(observer, target, now)` is true unless the target
is cloaked. A cloaked pilot is perceivable within 12 m (bots then aim with ×3 error), or anywhere
for 1.0 s after the pilot fires, deals damage or takes damage.

### 4.2 Presentation

- The camera roll during a wallrun is applied in `public/js/titanfall/pilot-camera.js`, not in physics: a
  critically damped spring (ω 16 rad/s: 63 % in ~0.13 s, settled in ~0.3 s, no overshoot, no velocity snap
  at a catch or a side switch) toward ±13° × how much the wall lies to the side of the view, away from the
  wall. The run holds through bridged gaps, so the roll does not flicker. FOV: +4° on the wall, up to +5°
  with speed above sprint, a +3° kick on a double jump or wall-jump that eases in at 30/s and decays at 6/s.
  The eye sits 0.24 m off the wall. A step-around moves the body a voxel in one tick: `PlayerPhysics.stepPilotFixed`
  leaves that shift out of the presented step and the camera offset takes it and eases it out (8/s), also when the
  run ends on that tick. The eased offset never carries the eye into the stepped voxel: the camera looks 4 m ahead
  (`physics.solid`, the same probe heights and step rules as `stepAroundWall`) and holds the presented eye
  (pos + `pilotLerp` + offset) behind that voxel's face by at most 0.5 × the distance left to its edge, and 0.15 m
  in front of it once level (the 0.05 m near plane is ~0.075 m wide). The eye starts moving out ~1.2 m before a pillar
  at half the run speed sideways (5–6.6 m/s) instead of jumping. An inner corner or a step the rules refuse ends the run and does not
  move the eye.
- Captures: `node tools/titanfall-wallrun-capture.mjs` plays two runs through the client path in Node
  (`LocalPlayer` with keys on `Input`, fixed-step prediction, PilotCamera; `LocalPlayer.updateCamera` composes
  every frame) and renders the chosen frames through `capture.html` (muted CDP, one `.titan-capture.lock` slot):
  the Hab alley run (catch, run, wall-jump, the other wall; `*-sheet.jpg`) and the curved tank wall at x 130,
  z 84–97, stepped around twice (before the step, the step, +0.2 s; `*-arc-sheet.jpg`). References and prompts
  in `docs/design/titanfall/wallrun/`. No viewmodel and no near-wall motion blur in the probe page.
- Local wallrun/slide poses: `pilot-anim.js`. Remote avatars: WP0 adds one hook in `public/js/avatar/avatar-roster.js` that calls `presentation.avatarState?.(row)`; WP1's `pilot-client.js` returns pose and material flags (wallrun side, slide, cloak shimmer) from `tf[0]` and `tf[3]`.

---

## 5. Titan simulation (WP2 owns this, except §5.4–5.5 which belong to WP3)

### 5.1 Frames — `shared/vehicle-handling/titan.js`

| Frame | hp | Walk | Sprint | Strafe | Back | Leg turn (rad/s) | Dash | Pips | Pip regen | Mass | Collider hw×hl | Height | Eye | Back anchor y |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Atlas | 2500 | 4.6 | 6.6 | 4.2 | 3.4 | 2.6 | 16 m/s, 0.28 s | 2 | 5.5 s | 30 | 1.35×1.1 | 7.0 | 5.6 | 4.6 |
| Ogre | 3200 | 4.0 | 5.8 | 3.6 | 3.0 | 2.2 | 14 m/s, 0.28 s | 2 | 7 s | 38 | 1.55×1.25 | 7.4 | 5.9 | 4.8 |
| Stryder | 2000 | 5.2 | 7.6 | 4.8 | 3.8 | 3.0 | 18 m/s, 0.28 s | 3 | 5 s | 24 | 1.15×0.95 | 7.6 | 6.1 | 5.0 |

```js
export const TITAN_RULES = Object.freeze({
  frames: { atlas, ogre, stryder },             // the table above
  shieldMaxFrac: 0.35, dropShieldFrac: 0.25, batteryShieldFrac: 0.35,
  shieldDelay: 0, shieldRegen: 0,                // shields do not regen in Attrition
  doomPoolFrac: 0.2, doomSeconds: 7, ejectVyMax: 38, ejectCloak: 1.5,
  maxStep: 1.05, maxSlope: 0.75, accel: 18, decel: 22, gravity: 24,
  pitch: [-1.15, 0.7],                           // driver and mount pitch (blind spot < 2.5 m)
  legTwistLimit: 0.35,                           // legs/pelvis lag hull yaw by at most this (rig + auto-titan)
  melee: { damage: 200, infantryDamage: 150, range: 4.5, cooldown: 1.3 },
  smoke: { charges: 2, radius: 7, seconds: 6, riderDps: 250, pilotDps: 60, batteryRecharge: 1 },
  embark: { distance: 6, holdMs: 300, animMs: 1200 }, disembarkMs: 600,
  drop: { range: 160, markerMs: 2200, fallMs: 800, skyClearVoxels: 12, spawnClear: 30, spawnAvoid: 35,
          crushDamage: 1500, crushKey: 'titanfall' },
  crush: { minSpeed: 1.5, key: 'titan_crush' },  // walker leg-box crush
  fluid: { wallDepth: 2, lavaDps: 120 },
  auto: { range: 70, losIntervalMs: 200, aimNoise: 0.04, smokeAfterRiderMs: 1500 },
  rodeo: { reach: 2.2, ripMs: 1400, ripFrac: 0.15, insertMs: 1000, hatchMul: 4, hatchDpsCap: 150, maxEnemyRiders: 1,
    contact: 1.5, upperY: 2.5, hookReach: 2.6, hookMs: 400, remountMs: 900, pushMs: 700, topBand: 0.35 },  // rodeo feel pass
  battery: { pickupRadius: 1.6, lifeMs: 30000, max: 12 },
  meter: { passive: 0.009, pilotKill: 0.10, pilotDamagePerHp: 0.0005, titanDamagePerHp: 0.00008, titanKill: 0.15 },
});
export function stepTitanWalk(v, controls, dt, world, rules) {}   // pure, shared server + client
export function placeWalker(v, x, z, world) {}                     // shared placement (ground probe, step-up, fluid)
```

`stepTitanWalk` is pure and has no allocations in the hot path. Controls:
`{ fwd, side, aimYaw, aimPitch, sprint, dash, piloted }`; it also reads the movement-modifier
block `v.tfMove` (§5.5).

- **Turns.** A **piloted** titan sets hull yaw = `aimYaw` every step (1:1 with the mouse; camera, mount and crosshair agree). The leg/pelvis yaw (`v.legYaw`, presentation and footprint only) chases hull yaw at the frame's leg turn rate, lagging at most `legTwistLimit`. An **auto-titan** turns its hull at the leg turn rate.
- **Moves.** Accelerates a velocity in hull space toward the wish (`walk`/`strafe`/`back`, or `sprint` when forward only). Walkers strafe.
- **Dashes.** A dash spends one pip and sets the velocity to `dash` speed in the wish direction (forward if none) for 0.28 s, then blends back.
- **Steps, slopes, fluids.** Climbs ≤ `maxStep`, refuses slopes above `maxSlope`. Fluid deeper than 2 m is a wall (no entry); lava under the feet deals `lavaDps` with cls `fire`.
- **Bounds.** The hull is clamped to the play area (`[hw, sx − hw]`, `[hl, sz − hl]` or the frontier rectangle). Hover is capped at `SY − height`.
- **Gravity.** Applies when not grounded. Northstar hover overrides it through `v.tfMove.hoverVy`.

**Client prediction.** `public/js/titanfall/titan-predict.js` (WP2) runs `stepTitanWalk` every
frame for the own titan from the local controls and reconciles softly toward the row (error
> 0.25 m: blend over 150 ms; > 3 m: snap). WP0 adds the hook: `VehicleView.setPredictedPose(id, pose)`;
`presentedRow(id)` and the model update use the predicted pose for that id when one is set.
`main.js` calls `this.titanfall?.frame(dt)` per frame (§8.5).

### 5.2 Server — `server/sim/titans.js` `TitanSystem` (new)

`VehicleSystem.reset` decides the profile and owns `this.titans`, because the constructor's reset
runs before the mode is known and a lobby can switch modes:

```js
this.combatProfile = isTitanfall(this.engine.mode?.mode) ? 'titanfall'
  : (this.engine.mode?.mode === 'conquest' || spawns.length ? 'conquest' : null);
this.titans = this.combatProfile === 'titanfall' ? (this.titans ?? new TitanSystem(this)) : null;
this.titans?.reset();
```

Every hook below is one line in `vehicles.js`, added by WP0. Its body lives in `titans.js` (WP2).

| VehicleSystem site | Hook | TitanSystem behaviour |
|---|---|---|
| `reset` | as above | clears titans, drops, deployables, batteries, riders, the id counter |
| `advance`, inside the per-vehicle loop, **after** `damageModel.step` and the driver/`input` lookup, **before** the `handling` branch | `if (this.titans && vehicleDef(v).handling === 'walker') { this.titans.advance(v, p, input, dt); if (v.hp > 0) this.syncCrew(v); continue; }` | `stepTitanWalk`, settle, leg-box crush/push, hull collision, fluids |
| `step` | `updateAttitude` and `checkAbandoned` skip walkers: `if (!isWalker(v)) ...`; after `mounts.step`: `this.titans?.step(dt)` | shields, doom, abilities, auto-titan, rodeo, smoke, drops |
| `enter` | `if (this.titans && !this.titans.canEnter(v, p)) return false` | owner only, distance ≤ 6, not doomed, not dropping; seats the pilot and sets `p.embarkUntil` / `v.embarkUntil` (control gated until then) |
| `exit` | `this.titans?.onExit(v, p)` | places the pilot at `exitSpot` (front of hatch → roof → rear, first free spot), phase 4, auto-titan |
| `eject` / `ejectionSeat` | `if (this.titans?.eject(v, p)) return` | refused unless doomed; vy `min(ejectVyMax, sqrt(2·g·(SY + ceilingPad − 0.5 − feetY)))` (feet apex half a metre under the OOB ceiling, so an eject never warns), 1.5 s cloak, `markLaunched` (ballistic, no canopy) |
| `tryRespawn` | `if (isTitanType(v.type)) return false` | ephemeral: no pad, no respawn |
| `advanceWreck` | `if (this.titans?.wreckDone(v)) this.vehicles.delete(v.id)` | wreck removed after `wreckSolidSeconds` (12) |
| `destroy` | existing path; caller passes `{ crewKey: 'titan_doom' }` for doom; then `this.titans?.onDestroyed(v, by)` | drops a battery if one is carried by a rider, fragments. **No points here.** |
| `row` | `this.titans?.rowExtras(v, row)` | §3.3 |
| `cleanCrew` | existing team check | |

`server/sim/vehicle-damage.js` gets two WP0 hook lines: `step(v, dt)` returns early for
`vehicleDef(v).armor === 'titan'` (no burn, no regen to 60 %), and `apply` delegates titans to
`this.system.titans.applyDamage(...)` (body in `server/sim/titanfall/titan-damage.js`, WP2).

TitanSystem API (frozen by WP0; consumed by the policy, mounts, bots and projectiles):

```js
class TitanSystem {
  constructor(vehicles)               reset()
  call(player, aimPoint) -> {ok, reason}
  spawnDrop(owner, x, y, z, type)     // id `T${++n}`, dropping, solidHull false until landing
  ownedBy(playerId) -> v|null         // one titan per pilot
  canEnter(v, p)  onExit(v, p)  eject(v, p) -> bool
  advance(v, p, input, dt)  step(dt)  rowExtras(v, row)  wreckDone(v)  onDestroyed(v, by)
  applyDamage(v, amount, cls, by, hit) -> dealt
  riderHit(attacker, v, hit, weaponId) -> bool    // §5.2 Hatch; called by combat.js hook
  ability(v, p, slot)                 // forwards to titan-abilities.js (WP3)
  rodeo(p, verb)                      // mount | rip | insert | dismount (rodeo.js)
  killRiders(v, dps, dt)  isDoomed(v)  shieldOf(v)  doomedBy(v)
  pickupBattery(p)  batteries() -> [[id,x,y,z]]
  removeOwned(playerId, reason)       // disconnect / team switch
}
```

**Drop.**

1. The server raycasts from the pilot eye along the input aim, up to 160 m. The ray stops at fluid surfaces.
2. Refusals: no titan bay slot (`bay`); within 30 m of an enemy spawn point (`spawn`); any footprint column top is fluid (`fluid`); footprint ground heights differ by more than `maxStep` (`uneven`); the footprint overlaps a hull or a pending drop footprint (`blocked`); fewer than 12 empty voxels above every footprint column (`sky`); the landed hull cannot walk 10 m out (`placeWalker` at 2, 4, …, 10 m) on any of 16 headings (`enclosed`, `TitanSystem.wayOut`, shared with the bots: harbor's gantry roof grid has sky gaps a hull fits down through but cannot leave).
3. It snaps the titan to the ground via `placeWalker`. `v.dropping = true` until `landsAt` (marker 2.2 s, fall 0.8 s).
4. At `landsAt` it re-runs `placeWalker`. If the ground is gone it falls under gravity; if it lands out of bounds the titan is removed and the meter refunded.
5. On impact: enemy pilots in the footprint plus 0.5 m die (key `titanfall`); friendly pilots are pushed out radially; hulls in the footprint take 1500 (cls `titanfall`); light voxels break through the existing structure path.
6. The landed titan starts with a 25 % hp shield, crouched (phase 2 for 1.0 s).
7. A refusal leaves the meter full and emits `titanfall_refused`.

**Crush.** A walker moving faster than 1.5 m/s kills an enemy pilot whose body overlaps one of
its leg boxes (key `titan_crush`) on the leading side of the hull's motion (body ahead of the hull
centre along this substep's displacement); bodies behind or level with a walking titan (the rodeo
approach) and friendly pilots are pushed. `resolveInfantry` keeps pushing for slow contact.

**Auto-titan.** When a titan has no pilot, every `losIntervalMs` it picks the nearest enemy pilot
or titan within 70 m with LOS that `isPerceivable` allows. It turns its hull toward the target,
sets the mount state's `yaw`/`pitch` directly (plus `aimNoise`), and calls
`mounts.fire(v, seat, attacker, mountId, weaponKey)` when the mount is ready. `attacker` is the
owner entity (kill credit and team checks). If the owner is dead, it uses a frozen stand-in
`{ id: owner.id, team, state: 'alive', input: {}, firing: false }`; if the owner has left, the
titan is already removed (§1.1). It does not walk in v1. Its only ability use is electric smoke
when an enemy rider has been on for ≥ 1.5 s.

**Doom and eject.**

- When hp reaches 0 and the titan is not doomed: `v.doomed = true`, `v.doomedBy` = the attacker, `v.hp = doomPool = 0.2 × max`, emit `titan_doomed`. Damage keeps applying to the doom pool.
- The pool drains `doomPool / 7` per second.
- When the pool hits 0, or the pilot ejects, the titan is destroyed: `destroy(v, v.doomedBy, { crewKey: 'titan_doom' })`. A pilot still inside dies.
- **Credit:** the destroying attacker is `v.doomedBy`, falling back to the last `recordHit` within the assist window. It is never the owner. Points (10) and the +0.15 meter are awarded **only** in `policy.onVehicleEvent('vehicle_destroyed')`.
- There is no eject blast in v1 (kit option, deferred).
- A doomed titan hit by titan melee from the front is destroyed (execution, WP3).

**Rodeo** (`server/sim/titanfall/rodeo.js`, WP2):

- **Mount** (rodeo feel pass, shared `rodeoContact` in `shared/vehicle-handling/titan.js`). The server grabs an **airborne** enemy pilot whose body box comes within `rodeo.contact` (1.5 m) of the titan's upper hull box (hull-local |x| ≤ hw, |z| ≤ hl, from `upperY` 2.5 m above its feet to the top) on the back, a side or the top (feet within 0.35 m of the top or above). Never across the front face below the top (the cockpit sector, centre-relative in footprint-normalised axes). A pilot whose grapple is hooked on the hull (or let go of it less than `hookMs` 400 ms ago) is grabbed within `hookReach` (2.6 m) of any part of it, front included. An enemy pilot standing on the roof is grabbed too. Walking up behind a titan is no mount by itself: a jump does it, and so does `rodeo:'mount'` (T / the touch RODEO chip), which also accepts a grounded pilot in that contact or a chest within `rodeo.reach` (2.2 m) of the back anchor. At most one enemy rider; a second contact is pushed off and not grabbed again for `pushMs` (700 ms). A rider who leaves is not grabbed by the same hull for `remountMs` (900 ms). The client predicts the grab (LocalPlayer holds the body on the drawn hull until the authority's mount, with a ~200 ms camera glide), and the HUD shows RODEO with the jump key when a jump from here (or the current arc, or a double jump) reaches the contact (`rodeoArcMounts`).
- **While mounted.** The rider is posed at the back anchor, offset 0.3 m outside the rear hull box (so other players' rays reach the rider before the hull by distance ordering; the sim test asserts an ally can shoot the rider off). `p.rodeoVehicleId` is set and `integrate` is skipped (game.js WP0 hook).
- **Rip.** Only if not `v.batteryOut` and not doomed: hold 1.4 s, then `0.15 × max` with cls `rodeo`, the rider gets a battery, `v.batteryOut = true` until a battery is inserted.
- **Hatch.** Primary or sidearm shots only (AT, explosive and launcher ids are excluded). `riderHit` applies `raw × TITAN_ARMOR[weaponCls] × hatchMul (4)`, capped at 150 dps per rider (rifle ≈ 66 dps). It returns true so `combat.js` skips the normal hull hit. Hatch damage feeds doom normally.
- **Insert.** A friendly titan accepts `insert` from a battery carrier, 1.0 s: +35 % max-hp shield up to `shieldMaxFrac`, clears `batteryOut`, +1 smoke charge (max 2). Refused (`full`) when the shield is already at the cap.
- **Electric smoke** (WP3, `killRiders`): 2 charges per titan life, +1 per inserted battery; kills riders (250/s), damages pilots within 7 m (60/s), breaks AT locks.
- **Dismount.** `dismount`, a jump, or the titan's death.

**Batteries** (`batteries.js`, WP2). A pilot who dies with a battery drops it as a pickup
(lifetime 30 s, at most 12; the oldest is removed first). A battery is picked up within 1.6 m.
Each pilot holds at most one.

**Meter** (`meter.js`, WP2): passive 0.009/s, +0.10 pilot kill, +0.0005 per hp of pilot damage,
+0.00008 per hp of titan damage, +0.15 titan kill; only while the pilot owns no titan.

### 5.3 Damage — `server/sim/titanfall/titan-damage.js` (WP2)

1. Multiply by `armorMultiplier(cls, 'titan', zone)`. Zone from the hit point in hull space: rear if local z < −0.3 hl, top if y > 0.8 height.
2. `recordHit` (existing assist bookkeeping).
3. Shield absorbs first, then hp, then the doom pool.
4. No disable state, no burn, no regen (the `step` early return covers burn/regen).
5. Meter credit to the attacking pilot (§5.2 Meter).
6. Ronin Sword Core / Sword Block reductions read `v.tfMove.damageTakenMul`.

### 5.4 Titan weapons — `TITAN_WEAPON_META` and numbers (WP3)

WP0 writes the META rows in `titan-contract.js` and stub numbers in
`shared/vehicle-handling/titan-weapons.js`; WP3 owns and tunes the numbers. Every mount weapon uses
**cls `titan` (1.0)**, so "Hull dmg" is the damage dealt. Target: every primary's sustained DPS
(including reload) against a titan is 180–250, so an Atlas with drop shield (3125) dies to one
primary in ≈ 13–17 s.

| key | Titan | kind | Hull dmg | Infantry dmg | Rate (s) | Mag / reload | Burst / sustained DPS vs titan | Special |
|---|---|---|---|---|---|---|---|---|
| `splitter` | ION | hitscan | 48 | 30 | 0.15 | 22 / 2.4 s | 320 / 185 | ADS splits into 3 beams, 3× energy cost |
| `t203` | SCORCH | projectile 60 m/s, g 12 | 260 direct + 120 splash 4 m | 90 | 1.0 | 1 / 1.4 s | — / ≈ 190 direct + fire patch | 3 s fire patch (molotov profile), titan 40 dps |
| `railgun` | NORTHSTAR | hitscan pierce | 150 → 520 at full charge (1.6 s) | 90 → 200 | charge + 0.8 s | 1 / — | — / ≈ 215 | ADS zoom; charge in mount field 6 |
| `leadwall` | RONIN | projectile 120 m/s ×10 pellets, ricochet once | 26 per pellet | 25 | 0.65 | 3 / 2.6 s | 400 / 188 (all pellets) | 12° spread (6° half-angle) |
| `predatorClose` | LEGION | hitscan | 20 | 18 | 0.06 | 100 / 3.5 s (+0.6 s spin) | 333 / 198 | spin-up in field 6 |
| `predatorLong` | LEGION | hitscan | 34 | 22 | 0.12 | shared | 283 / 211 | tight spread; Mode Switch selects |
| `titanMelee` | all | melee 4.5 m cone | 200 | 150 | 1.3 | – | 154 | executes a doomed titan from the front |

`titanfall-titan-weapons-test` asserts each primary's sustained DPS vs a titan is within ±20 % of
its table value.

**Feel (presentation only, no server numbers).** The 2026-10 weapon-feel pass left the table as it was:
measured sustained DPS splitter 193.6, t203 186.3, railgun 216.7, leadwall 210.5, predatorClose 200.0,
predatorLong 224.4. Two event details serve the client:
- A railgun `shoot` event carries `charge` (0..1, two decimals): the charge it fired at. The mount row is
  already reset by the time the event arrives. The crack, the beam, the kick and the report scale with it.
- A Leadwall pellet that runs out of range in the air ends with `projectileExplode` radius **0**. A hit
  on a voxel, hull or pilot uses 0.15. The client draws and plays nothing for radius 0, and no titan
  shell or pellet ever falls back to the frag blast (`sfx.explosion` returns early for `t203` / `leadwall`).

What a primary shot does on the client is tuned in `public/js/titanfall/titan-weapon-feel.js`
(`TITAN_WEAPON_FEEL`, §7.3). The weapons are felt in this order: a full-charge railgun hardest, then
Leadwall, T-203 and Splitter, with the Predator a steady rattle. A railgun tap retains at least
30 % of the cabin shove. The camera aim ray remains fixed; a damped cabin spring recovers within
0.5 s and sustained fire holds shake rather than adding unlimited trauma.

| Primary | Report and mechanical feel | Presentation timing |
|---|---|---|
| Splitter | Crisp electric crack, tight low-mid pulse, three plasma discharges for the split cue; blue muzzle and ion impacts | Short per-round cabin kick; split expands the shove and reticle bloom |
| T-203 | Hollow launcher thump with an aligned mortar body, breech close, thermite burst and sizzle | Breech follows the shot; launch, shell flight and impact remain separate server events |
| Railgun | Rising electric charge, ready ping, heavy supersonic rupture and rolling plasma tail | Charge is 1.6 s from the server definition; the shot consumes the whine, kick and gain scale with event charge |
| Leadwall | Broad ballistic slam, dense pellet hits, gritty armour ricochets and a heavy rack | The ~0.5 s rack starts at 0.10-0.11 s and finishes before the 0.65 s shot cadence |
| Predator | Tight autocannon hammers, torque motor, bearing teeth, heavy brass and short kinetic armour hits | Every authoritative round gets a report at full cadence; actual take length controls overlap, spin-up follows 0.6 s |

The sound/feel pass changes client presentation only. Damage, magazine sizes, cooldowns, charge and
spin thresholds, reload durations and sustained-DPS tolerances are unchanged. Own reload cues are
stretched to server reload duration and joined at the remaining fraction. The recorded bank uses
individually checked CC0 and CC BY 4.0 sources; [audio provenance](audio/titan-sfx.md) and
[Gemini audio judgements](audio/titan-weapons-judging.md) identify every file.

- `fireMountedRay` (`server/sim/combat.js`): one-token WP0 change, `weapon.infantryDamage ?? weapon.damage` for infantry hits.
- Projectile kinds launch through `launchVehicleProjectile`; titan flight/explode behaviour lives in `server/sim/titanfall/titan-projectiles.js`. The WP0 hook in the `ProjectileSystem.step` loop: `if (projectile.tf) { this.titanfall.step(projectile, stepSeconds, substeps, ctx); continue; }`, placed first in the loop body. The router owns explode, `explodeAt` and `outsideWorld` for its projectiles: before delegating it checks `!(ctx.now < explodeAt)` or out of world (the stock bounds incl. `ctx.airLimit`, non-finite positions), then calls the kind's `explodeTitanProjectile` / `explodePilotProjectile(system, projectile, ctx)` once and always deletes the projectile itself; `step*Projectile` sees only live, in-world projectiles and handles impacts (explode, then `system.active.delete`). `ProjectileSystem`'s constructor builds `this.titanfall = new TitanfallProjectiles(this)` (`server/sim/titanfall/index.js`; inert unless a projectile has `tf`).

### 5.5 Abilities — `TITAN_ABILITIES` (WP3, `server/sim/titanfall/titan-abilities.js`)

Abilities are **data over primitives**: `{ slot, primitive, cls, cooldown, charges, ...params }`.
Every ability that damages a titan uses cls `titan` unless the table says otherwise, so the listed
number is the number dealt.

| Primitive | Server implementation |
|---|---|
| `shot` | `launchVehicleProjectile` or hitscan from a named muzzle anchor (not a mount) |
| `frontGuard` | arc-shaped volume in front of the hull: blocks or catches projectiles and rays inside an `arc` cone of `range` |
| `deployable` | placed entity with lifetime: trip-mine, trap, fire wall segments |
| `groundLine` | segments advancing along the ground, damaging what they touch (each target at most once per 0.5 s) |
| `dash` | an extra pip consumer, or a phase blink |
| `hover` | writes `v.tfMove.hoverVy` for `seconds` |
| `toggle` | switches the mount's selected weapon (Legion) or a mode flag |
| `coreBuff` | timed modifier on mounts, movement or damage |

Movement modifiers go through one block on the hull, frozen by WP0:
`v.tfMove = { speedMul, hoverVy (null|number), rooted, phasedUntil, pipRefill, damageTakenMul }`.
`stepTitanWalk` (WP2) only reads it; `titan-abilities.js` (WP3) only writes it.

**Phase Dash** sweeps the walker collider against voxels with `placeWalker`-style collision and
passes only through hulls and players. If the end overlaps a hull it shortens to the last free
sample. The rider stays attached. Phase breaks AT locks.

| Titan | Slot | Ability | Primitive | cls | Cooldown / charges | Key numbers | Total vs Atlas (3125) |
|---|---|---|---|---|---|---|---|
| ION | def | Vortex | frontGuard catch | – | cd 10 s | 3.5 s hold; sphere r 3.2 m centred 2.5 m in front of the cockpit; catches projectiles and hitscan (≤ 40 caught, an AT rocket counts as 5); returns them at their titan-side damage | – |
| | tac | Tripwire | deployable | titan | 350 energy | 3 mines, 15 m line, 260 on trigger | 260 per mine |
| | ord | Laser Shot | shot hitscan | titan | 500 energy (pool 1000, regen 120/s after 1 s) | 400, 150 infantry | 400 |
| | core | Laser Core | coreBuff beam | titan | core | 4 s × 600 dps, 250 dps infantry, 90 m | 2400 |
| SCORCH | def | Thermal Shield | frontGuard block | fire | cd 12 s | 4 s, burns 120 dps (×0.6) 5 m in front | ≈ 290 |
| | tac | Incendiary Trap | deployable | fire | cd 14 s, 1 charge | canister, ignited by thermite → 8 s fire 6 m, 80 dps (×0.6) | ≈ 380 |
| | ord | Firewall | groundLine | fire | cd 12 s | 30 m, 6 s, 120 dps titans (×0.6), 60 dps pilots | ≈ 430 |
| | core | Flame Core | groundLine fan | titan | core | 3 lines, 30 m, 1500 total, ≤ 900 per target | 900 |
| NORTHSTAR | def | Tether | deployable | titan | 2 charges, 10 s recharge each | root 3 s (`rooted`), 200 | 200 |
| | tac | VTOL Hover | hover | – | cd 13 s | 3 s, `hoverVy` 0, 50 % move speed | – |
| | ord | Cluster | shot + sub-explosions | titan | cd 12 s | 6 bursts over 3 s, 80 each | 480 |
| | core | Flight Core | hover + shots | titan | core | 4 s hover, 24 rockets × 70, one per 0.16 s | 1680 |
| RONIN | def | Sword Block | frontGuard reduce | – | no cd | `damageTakenMul` 0.3 to the front while held | – |
| | tac | Arc Wave | groundLine | titan | cd 7 s | 30 m, 250, 1 s slow (`speedMul` 0.5) | 250 |
| | ord | Phase Dash | dash blink | – | cd 8 s | 8 m blink, 0.6 s phased (`phasedUntil`) | – |
| | core | Sword Core | coreBuff melee | titan | core | 8 s: melee 350, pips refill, `damageTakenMul` 0.7 | ≈ 2150 (melee 1.3 s) |
| LEGION | def | Gun Shield | frontGuard block | – | cd 15 s | 1500 hp shield on the gun arc, 5 s | – |
| | tac | Mode Switch | toggle | – | 0.6 s | `predatorClose` ↔ `predatorLong` | – |
| | ord | Power Shot | shot | titan | cd 9 s | 900 close (spread) / 600 long (pierce) | 900 / 600 |
| | core | Smart Core | coreBuff | – | core | 10 s: auto-target (perceivable, 40° cone), no spin-up, Predator damage ×1.15 | ≈ 2500 (close, incl. one reload) |
| all | – | Electric smoke | deployable area | rodeo | 2 charges (+1 per battery) | §5.2 | – |
| all | – | Melee | §5.4 | titan | 1.3 s | 200 | – |

- Core charge: `core += damageDealt / 4000 + dt / 180`; damage dealt during an active core does not count. When full, emit `core_ready`.
- The fire patch for SCORCH reuses `MolotovFireSystem.ignite(projectile, ctx, profileOverride)` (`server/sim/molotov-fire.js`; WP3 adds the optional third parameter). `_burnHulls` uses `armorMultiplier('fire', 'titan')` → 0.6.
- Abilities fire from `TITAN_ABILITIES[type][slot].anchor`, a hull-space offset outside the mount list.
- Smoke, melee and doom execution are WP3's (`titan-abilities.js`), using WP2's `killRiders`, `isDoomed` and `vehicles.destroy`.

### 5.6 Locks (WP4)

`LOCK_RULES.archer` lives in `shared/vehicle-defs.js` (WP0): range 180 m, cone 6°, 1.2 s.
`server/sim/vehicle-locks.js` (WP4): `sourceFor` recognises the archer (`p.def.projectile ===
'archer'` + ADS), and `candidate()` gets a titanfall branch **at the top, before** the
`!isAircraftType(v) || v.grounded` filter: enemy titans that are live, not phased, and
`isPerceivable`. Electric smoke and phase break locks.

---

## 6. AT weapons (WP4)

New `WEAPON_IDS` are appended after `stinger` **in this order**. All are `gadgetOnly`. None are
added to `FREE_WEAPON_IDS`. Target: one AT hit ≈ 10–15 % of an Atlas (2500), and one pilot's AT
weapon alone needs ≥ 20 s of continuous fire to doom an Atlas with drop shield.

| id | Template | Pilot dmg | Titan dmg (cls) | Fire | Ammo | Special |
|---|---|---|---|---|---|---|
| `chargerifle` | lance | 50 | 300 (`at`) | charge 1.1 s, then 2.5 s cooldown; hitscan pierce, 4 m beam | mag 3, reserve 9 | fires at full charge only; early release retains charge for 180 ms, then loses one full charge per 700 ms; pressing again resumes the remaining charge |
| `archer` | stinger | 150 | 400 (`at`) | lock 1.2 s on titans (§5.6), dumb-fire otherwise; reload 3 s | 1, reserve 4 | rocket 90 m/s, turnRate 1.8 rad/s, `tf` projectile |
| `thunderbolt` | mgl/rocket | 40 contact / 15 per zap | 300 contact (4 m) / 60 per zap (`at`) | orb 30 m/s, lifetime 2.5 s, refire 1.2 s; every 0.25 s it zaps ≤ 3 targets within 6 m, each target at most once per interval | 4, reserve 12 | pilot numbers are after `combatDamage` |
| `kraber` | sniper | `damage [200, 160, …]` (far × 0.8 ≥ 100: one-shot) | 200 × `hmg` 0.2 = 40 | ballistic 600 m/s, bolt 1.1 s | 4, reserve 16 | primary slot, `damageClass: 'hmg'` |

`mgl` already exists. In titanfall a grenade deals 70 `at` to titans through a titanfall-only
override in `pilot-projectiles.js` (magnetic: homes within 4 m to titans). If the existing mgl
cadence breaks the ≥ 20 s rule, WP4 lowers the per-grenade number.

`titanfall-at-weapons-test` asserts the ≥ 20 s solo-doom rule for all four AT weapons and the
thunderbolt DPS through a 5-pilot cluster.

**Loadout fill.** `player.js` starts gadgetOnly weapons at mag 0 / reserve 0. The titanfall
loadout resolver (`server/sim/titanfall/loadout.js`, WP4; WP0 stub) sets `mag`/`reserve` for every
owned gadgetOnly weapon on spawn, as conquest kits do. It maps the new ids by name and falls back
to `rifle` + `rocket` while they are absent from `WEAPON_IDS`.

**Bastion leak.** `server/modes/bastion.js:349` accepts any `WEAPON_IDS` purchase except knife and
revolver, and `public/js/ui/bastion-armory.js:26` lists every id except knife, revolver and
stinger. WP4 adds `!WEAPONS[id].gadgetOnly` to both. `bastion-armory.js` is WP4's; `bastion.js` is
dirty, so WP4 sends that one-token hunk to the orchestrator. WP4 runs `npm run bastion:test`.

Every new id must be added to **every per-id table** in the same change:

| Table | File |
|---|---|
| definition, `WEAPON_IDS`, `gadgetOnly`, `damageClass` | `shared/combatmath.js` |
| handling | `shared/weapon-handling.js` |
| attachments | `shared/weapon-attachments.js` |
| hands | `shared/avatar-hands.js` |
| `SIGHT_HEIGHT` | `shared/player-hitboxes.js` |
| `WEAPON_NAMES` (the 4 new ids) | `public/js/ui/hud-support.js` (WP4 region) |
| tint rules (3) + hud-contracts | `public/style.css` |
| `TIMERS` | `public/js/guns/defs.js` |
| `MODELS` + `models/<id>.js`, shared parts | `public/js/guns/assemble.js`, `public/js/guns/models/`, `public/js/guns/models/common.js` |
| `GLOW_ACCENT` | `public/js/guns/kit.js` |
| `SFX_ALIAS` | `public/js/audio/sfx.js` |
| projectile/effect type branches | `public/js/weapons/effects.js`, `public/js/weapons/explosion-fx.js` (type branches only) |
| client projectile views | `public/js/titanfall/pilot-projectile-views.js` (registry, §6.1) |
| HUD icon | `node tools/render-hud-icon.mjs --weapon <id>` for the 4 new ids only (headless node rasterizer; never `--all`, which overwrites Blender-rendered PNGs) |

Tests that pin ids and must be updated in the same change: `tools/smoke.mjs` (ids, weights,
tracer whitelist, unique `yawPattern`), the weapon-wheel contract, `tools/audio-mix-smoke.mjs`,
and the viewmodel contracts. WP4 acceptance is the full `npm test` (§12) because about 45 files
iterate `WEAPON_IDS` (progression tree, hitbox model, customization, definition cache,
conquest-kits, combat-balance, career/cosmetics mastery, bastion-ui, avatar/killcam pose tests,
asset contracts).

`combat.js` `fireOneShot`: the WP0 router line routes ids in `TF_PILOT_PROJECTILES =
['archer', 'thunderbolt', 'mgl']` to `pilot-projectiles.js` **only when `isTitanfall(mode)`**.
`canFire` keeps its stinger gate; the archer gate lives in the `pilot-projectiles` lock check.
`projectiles.js` `launchRocket` (≈ L1080): WP0 widens `combatProfile === 'conquest'` to
`=== 'conquest' || === 'titanfall'`, so rockets in titanfall use the hull profile, not
`_configureChaos`.

### 6.1 Client projectile presentation

`public/js/weapons/projectiles.js` `launch()` turns any unknown `event.type` into `'frag'`. WP0 adds
one line before that fallback: `if (titanfallProjectileViews.has(event.type)) return
titanfallProjectileViews.get(event.type).launch(this, event, opts);`. The registry
(`public/js/titanfall/projectile-views.js`, WP0, frozen) merges `pilot-projectile-views.js` (WP4:
`archer`, `arcball`) and `titan-projectile-views.js` (WP5: `t203`, `leadwall`, `cluster`,
`flightRocket`). Server event types for these kinds use these names.

### 6.2 Kit digits and wheel

`kitWeaponRole` (conquest-kits) is wrong for titanfall (kraber would be a gadget, mgl a primary),
and `shared/conquest-kits.js` is not touched. WP6 uses `titanWeaponRole(id)` and
`TITANFALL_DIGIT_ROLES` from `titan-contract.js` in `weapon-state.js` `_directSlot` and
`weapon-wheel-controller.js` `kitEntries` when `isTitanfall(mode)` (conquest keeps its gate).
Digit order: 1 primary, 2 revolver, 3 AT, 4 knife. The wheel adds an `AT` role label and is
suppressed while seated in a titan. The hud-state test asserts the order for kraber, mgl and
archer loadouts.

---

## 7. Titan models and presentation (WP5)

The models are the headline feature. Reference: `docs/design/titanfall/titan-lineup-b.png`
(selected) and `titan-turnaround-<name>.png`. Lineup A supplies the back hatch and stripe
placement.

| Item | Spec |
|---|---|
| DSL | `public/js/vehicles/voxel-model` (dsl, mesher, material, anchors, assemble). Base voxel 0.2 m; detail parts at 0.1 m (`userData.scale = 0.5`). Emissive optics use negative emissive codes, as in the conquest models. |
| Files | `public/js/vehicles/models/titan-common.js` (frame skeletons, IK rig, shared parts), `titan-ion.js`, `titan-scorch.js`, `titan-northstar.js`, `titan-ronin.js`, `titan-legion.js` |
| Silhouettes | Atlas: boxy torso, single round optic. Ogre: wide shoulders, heavy legs, slit visor. Stryder: slim, tall, reverse-tapered torso, thruster pack. Each kit adds weapon and back silhouette: ION round lens, SCORCH canister pack, NORTHSTAR flight pack, RONIN sword on the back, LEGION shield-gun. |
| Team | camo plates and team stripes from `TEAM_SCHEMES` (`material.js`); dark gunmetal inner frame |
| Budget | ≤ 24 draw calls and ≤ 30 000 triangles per titan, pinned by `tools/titanfall-model-budget-test.mjs` |
| Registry | WP0 adds 5 lazy factories to `VEHICLE_MODEL_FACTORIES` in `public/js/engine/vehicle-view.js` pointing at `titan-placeholder.js`, and a walker branch in `update` before `_groundAttitude`/`_suspension` that calls `titanPresentation.update(item, row, dt)`. WP5 swaps the factory targets inside `public/js/titanfall/titan-presentation.js` and owns that body. **WP5 does not edit `vehicle-view.js`.** |
| Fragments | through the model only (generic `createVehicleFragments(model)`); no edit to `vehicle-fragments.js` |

### 7.1 Procedural animation (`titan-common.js` rig)

The rig keeps the existing call convention `item.model.animate(step, state)`; titan fields ride
inside `state`: `{ speed, visualSteer, ..., tw, mounts, phase, legYaw, events }`. Frozen in WP0's
placeholder.

| Channel | Input | Behaviour |
|---|---|---|
| Two-bone leg IK | hull velocity, `legYaw` | Feet stay planted. A step triggers when a foot is > 0.9 m from its target, alternating feet, step height 0.5 m, 0.35 s per step (×0.7 sprint). Knees bend forward (Atlas, Ogre) or back (Stryder). |
| Pelvis bob | step phase | ±0.12 m, phase-locked to footfalls |
| Torso twist | hull yaw − leg yaw | ±0.35 rad; arms follow aim pitch |
| Recoil | mount fire events | arm kick 0.15 m and torso 2° |
| Dash | `tw[1]` decrease | thruster flare particles, 0.28 s |
| Hatch | phase 3/4 | hatch opens 1.0 s, pilot avatar animated into the seat |
| Landing | phase 2 | knee crouch 1.0 s, dust ring |
| Doom | `tw[3] > 0` | sparks, smoke, red optic flicker, stagger |
| Destruction | `vehicle_destroyed` | fragments from the model, hatch blow-off |
| Drop | phase 1 | marker beam plus `titanfall-drop-fx.js` (`titanfall_drop` event through `onEvent`): countdown ring, the hull drawn falling from ~245 m down the marker beam on the server's `landsAt` clock (re-entry streak, corona, sparks, contrail, braking thrusters, incoming roar), the impact at the visual touchdown with the rig already in its landing pose and the beam flashing out (flash, 22 m dust wave, voxel chunks, scorch, lingering dust, camera shake by distance 1.0 at 0 m / 0.8 at 20 m / 0 at 60 m, FOV punch inside 16 m, boom delayed at 343 m/s), knee/vent steam on landing and rise. Visual only; the server hull stands at the landing spot throughout |

The rig is deterministic from `(row, time)`, independent of frame rate.

### 7.2 Cockpit and camera

- `public/js/vehicles/cockpit-overlay.js` gets builder `'titan'`. `public/js/titanfall/titan-cockpit.js` installs it with `setTitanCockpitBuilder`; without it a titan has no overlay (the slim hatch-frame fallback was removed as dead code). The builder makes a closed, detailed armoured-hatch cabin per frame class (concept A in `docs/design/titanfall/cockpit/`):
  - **ATLAS:** octagonal viewport.
  - **OGRE:** low, wide visor under a heavy brow.
  - **STRYDER:** tall main pane, two side panes and a roof truss.
  - **Every class:** bolted strut rings with hazard edges, an MFD deck, key banks, switches, sticks, cables and vents.
- **View model.** The cabin is built in eye space. Every render places it on the camera through its own frustum (`cockpitFrustum`: 75° base, widened on narrow screens) with slight sway. Any FOV (settings 65–100, + speed 8, + titanfall punch 9) or aspect ratio shows the same closed cabin, and looking around never reveals its outside. It draws in the front 2 % of the depth range. It is hidden from cameras more than 2.5 m from the hull eye.
- **Live MFDs.** The console MFDs are a 12 Hz canvas atlas from `titanModel(row)`: status, radar and core, weapon and abilities, a per-titan aux gauge and a caution grid. They are dark on phone portrait.
- **Diegetic HUD** (`titan-cockpit-hud.js`, concept C "corner pods" in `docs/design/titanfall/cockpit/diegetic/`). In the first-person cockpit the HUD lives in the cabin, and the DOM titan HUD is hidden:
  - **Glass** (camera-locked, pixel-aligned at the aim point): reticle with the spread gap, hit markers, hull and shield arc (the doom countdown when doomed), ammo column and count, charge or heat arc, dash chevrons, core cue, lock warnings, the alert line (missile, rider, battery stolen, out of bounds, toasts, ability-ready) and the doom block with the triple-tap eject prompt.
  - **Pods** on the four diagonal struts: weapon and ammo; core and level badge; dash, hull and shield (doom and eject when doomed); def/tac/ord cooldowns and smoke with rebinding-aware key chips.
  - **Brow** display: score bar and timer. **Right pillar:** the kill feed.
  - **Values.** `titan-ui.js` publishes the `titanHudModel` it computes (`publishCockpitHud`) and the cockpit draws it; a model older than 600 ms or for another hull falls back to `titanModel(row)`. The crosshair, hit marker, kill feed and badge are read from the stock DOM.
  - **DOM switch.** `titan-ui.js` sets `body[data-titanfall-cockpit]` only for the own titan in the first-person view (not sight, chase, on foot or spectating) and only while the glass is drawing (`cockpitHudLive`). `titanfall.css` then hides `.tf-titan`, `.tf-top`, `.tf-banner` and the stock crosshair, hit marker, kill feed and badge. Touch buttons, escape, settings and the scoreboard stay DOM.
  - **Phone portrait.** The pods and the feed screen go dark there. The touch buttons carry the abilities, the brow carries the score, and the glass gets the newest kill feed row plus CORE %.
  - **Rates.** Pods redraw at 15 Hz, the brow at 4 Hz, the glass at 20 Hz and the feed on change, each only when its values change (texture uploads only then).
- **Lamps.** Doom flashes red, a lock flashes amber, a ready core pulses the accent strips, and a hit flickers the cabin, throws sparks and jolts it.
- **Cost.** 11 draws (7 cabin + pods, brow, feed, glass) and about 8 k triangles. Geometry is cached per class, and the programs are warmed with the titan FX.
- **Tests.** The budget test ray-casts the enclosure at every pixel × screen shape × FOV and over the whole sphere. It also checks that the viewport is at least 35 % of a 16:9 screen.
- **Cockpit damage** (`titan-cockpit-fx.js`; references and prompts in `docs/design/titanfall/cockpit/damage/`, chosen: A's cracks, sparks and bent trim escalating into C's smoke, fires and NO SIGNAL, with B's hit side). It shows hits from inside, driven only by the presented row's hull and the `vehicle_hit` events. The damage builds in four stages at 80 / 60 / 40 / 20 % hull (doom is stage 4):
  - **Stage 1:** a star crack in the glass.
  - **Stage 2:** the cable bundles drop from the roof on the side that took the most hits (`vehicle_hit` position in hull space), and the screens on that side glitch.
  - **Stage 3:** a lower ring plate tears loose on that side and swings, the breach rim glows, the smoke gathers under the roof, the hit-side screen cracks and the cabin pulses red below 35 %.
  - **Stage 4:** the radar shows NO SIGNAL, the side consoles burn, and both sides are torn.
  - **Hits:** heavy hull hits (≥ 150) can add a crack, sparks sputter from the torn parts, and every hit swings the loose parts. A fresh hull (> 97 %) starts clean.
  - **Cost:** up to 6 cracks live in the glass shader. The fx meshes are hidden until used: at most 14 draws (the damage parts plus the three hatch plates and their seams, which only show while the hatch closes or parts) and 6 k triangles on top of the cabin.
- **Embark and disembark** (`titan-transit.js`, `titan-embark-path.js`, `titan-embark-boot.js`; storyboards in `docs/design/titanfall/transit/`, the hatch and boot in `docs/design/titanfall/embark/`). Presentation only; every trigger is the `titan_embark` / `titan_disembark` event or the presented rig.
  - **Own embark:** the camera starts at the last on-foot view and rides the walk-in that the others see (the same `embarkPath` as the remote avatar proxy). It runs to the lowered palm, hops on, rides it up with the eyes on the open chest and drops into the seat. At 82 % of the lock it hands over to the cockpit view. The cockpit overlay is drawn from 74 % on.
  - **Hatch and boot** (`titan-embark-boot.js`, a pure timeline in seconds since the `titan_embark` event; `titan-cockpit-fx.js` draws it, `titan-transit.js` plays its beats). The lock is the server's embark lock (`TITAN_RULES.embark.animMs`, 1.2 s) plus 0.06 s of presentation delay, so the hatch locks as control returns:
    - **0.96–1.26 s, plates:** three armour plates behind the glass close the viewport. The upper left plate comes in from the left (0.96–1.14 s), then the lower left (1.02–1.20 s), then one plate from the right (1.08–1.26 s) whose pointed edge meets them in a Y seam just right of the middle. Each plate accelerates in and stops hard, then rocks back 1 cm. The two left plates clunk home (`sfx.vehicleReload`, heavy). The cabin is dim, and the warning lamps blink red.
    - **1.26 s, lock:** the seams flash cyan and spark, the tank hatch slam plays (`sfx.vehicleHatch`), the camera shakes once (`lockShake`) and the cabin jolts. The lamps turn cyan, the cabin goes dark, and the glass reads NEURAL LINK.
    - **1.40–1.76 s, screen:** the hatch's inside comes on as a screen. The glass shader (`screen` uniform) turns black, a bright line draws out across the middle and opens into the outside feed, which is tinted cyan with scanlines and rolling bands and settles into the plain glass. The plates are hidden behind it. The battery-insert tone plays as the power-on (`titanCue('insert')`).
    - **1.40–2.00 s, HUD:** the power comes back in stages. Keys and the cabin light come first, then the MFDs (1.52 s), the strut pods, brow and feed (1.62 s) and the glass HUD (1.76–2.00 s). A scan band sweeps the glass, and the banner reads LINK ESTABLISHED / PILOT ONLINE until 2.18 s, then fades by 2.38 s (`bootSeconds`).
    - **Determinism:** flicker is a hash of the time, so captures repeat. A disembark or a lost seat mid-hatch drops the remaining beats.
    - **Reduced motion** (`displaySettings().reducedMotion`): no plates, line, flicker, band or plate clunks. The glass dims while the hatch would close and fades back in over 0.3 s, the power ramps up steadily, and the lock and power-on sounds still play.
  - **Own exit from the cockpit view:** the cabin stays where the last cockpit view was (anchored). The screen cuts to black (0.04 s), and the closed plates part in reverse order: the right plate (0.04–0.13 s), the lower left (0.06–0.15 s) and the upper left (0.08–0.17 s). They are clear before the camera reaches the glass (about 0.21 s). HATCH OPEN shows, and the glass fades (0.10–0.24 s). The camera leaves forward through the viewport and drops in an arc to the pilot's eye (0.8 s, landing shake). From the chase view the exit is a 0.35 s blend.
  - **Other pilots:** they vault out of the hatch in an arc onto their server spot (0.65 s, tucked legs), through the AvatarRoster `avatarState` hook.
- `seatCameras.driver.views = ['cockpit', 'chase']`. Cockpit is the default. `titanView` (H) toggles. Chase: 9 m back, 3 m up, collides with the world.
- `public/js/session/vehicle-camera.js` is used as-is for chase. If it needs a titan branch, WP5 owns it.

### 7.3 FX and audio

- `vehicle-fx.js` `_shoot` reads `vehicleWeaponMeta` (WP0). WP5 adds `presentation` handlers for `splitter`, `railgun` (charge glow plus beam), `leadwall`, `predator` and `t203`.
- Ability visuals and the drop marker beam: `public/js/titanfall/titan-ability-fx.js` (WP5). The fall, impact, shake and drop sounds: `public/js/titanfall/titanfall-drop-fx.js` (tuning `TITANFALL_DROP_FX`, captures `docs/design/titanfall/captures/titanfall-drop/`, `tools/titanfall-drop-capture.mjs`).
- `vehicle-audio.js` (WP5) adds walker footfalls, servo whine, dash burst and doom alarm, synthesized via `public/js/audio/primitives.js`.
- **Primary weapon feel** (`public/js/titanfall/titan-weapon-feel.js`, called from `titan-presentation.js` for every primary `shoot` event):
  - The own shot raises the shake bus to the weapon's trauma (`holdShake`). It never stacks, so a Predator burst holds a steady rumble instead of saturating the bus.
  - The own shot punches the FOV. The chase view takes 60 % of the punch, and a burst never adds more than +6°.
  - With the cockpit shown, the cabin view model is kicked on a damped spring (`TITAN_COCKPIT.kick`, `stepRecoil` in `titan-cockpit.js`). The camera itself never moves, so the crosshair ray stays on target.
  - The glass reticle blooms (`COCKPIT_HUD.bloom`).
  - T-203, railgun and Leadwall shots shake viewers within 24 m by distance.
  - Railgun values scale with `event.charge`, and the Predator's yaw kick alternates per round.
  - Own hits on a hull play a hit confirm (`vehicle_hit` with `eff`). A titan doomed by the own rounds adds the doom confirm and the glass `TITAN DOOMED` mark (`titan_doomed`, `by`). Confirmed destruction credited to the pilot adds a separate cue and `TITAN DESTROYED` (`vehicle_destroyed`, `attacker` and titan `type`).
- **Primary weapon FX** (`vehicle-fx.js` `TITAN_SHOT_LOOK`, `_titanShot`):
  - Muzzles are tinted per weapon (ION electric blue, rail pale cyan).
  - The rig recoil kick is per weapon. The railgun kick scales with its charge.
  - A coloured muzzle light flashes on each shot.
  - Every ION bolt draws a tracer, one per split path. The Predator keeps the server's every-third tracer.
  - Each hitscan round bursts where it stopped short of its range (sparks; dust and chips on voxels).
  - The Predator throws brass.
  - The T-203 belches flame and embers. The Leadwall throws a wide spark cone.
  - The railgun leaves an ionised wake that gets denser with charge. Its beam is drawn by `titan-ability-events.js` (`TITAN_EVENT_FX.shot.railgun`) from the presented mount pose.
  - `titan-projectile-views.js` adds a T-203 blast flash with slag, Leadwall pellet hits (radius > 0 only) and ricochet sparks (`projectileUpdate` of a tracked pellet). Each also has its titan impact / ricochet sound.
- **Primary weapon audio**: the recorded titan bank `public/js/audio/titan-bank.js` (`public/assets/audio/titan/`, provenance and licences in `docs/audio/titan-sfx.md`, judging in `docs/audio/titan-weapons-judging.md`).
  - `titan-presentation.js` `init()` loads the bank lazily through `VehicleAudio.loadTitanBank`, and `dispose()` unloads it.
  - `TitanSynth` plays fire + tail layers per shot, plus the ION split layer, the T-203 breech and the Leadwall rack after the shot (both within 45 m).
  - Others' shots get a distance low-pass. The Predator plays one round per shot (at most 5 overlapping), brass every 4th round and a tail when the burst stops.
  - The railgun charge whine is stretched to the server's 1.6 s and joined at the row's charge, followed by a ready cue and a hold loop.
  - The Predator plays a spin-up synced to its 0.6 s, a spin loop and a spin-down from mount field 6. Own magazine reloads have their own cue, stretched to the server reload duration and joined at its remaining fraction.
  - Impact, ricochet and confirm sounds are budgeted, and weapon voices have their own 20-voice budget.
  - Until a report, impact or charge/spin loop decodes, its synthesized voice plays. Missing first takes do not hide later decoded variants; a late loop decode replaces the synth, and joining uses a 12 ms fade. Bank unload stops held loops. Levels are set in `TITAN_WEAPON_MIX`.

### 7.4 Verification

- `public/vehicle-capture.html` accepts `?type=titan_ion&phase=<0..1>&pose=walk|idle|dash|doom|embark&team=alpha`.
- `tools/titanfall-model-capture.mjs` runs a muted CDP capture of 5 titans × front/¾/back plus a walk-phase strip into `docs/design/titanfall/captures/`, under the capture lock.
- Comparison notes go in `docs/design/titanfall/captures/models.md` (WP5's own file).
- `tools/titanfall-weapon-fx-capture.mjs` runs muted CDP captures of every primary firing (capture page `pose=fire`: server-shaped shoot events with the pilot as viewer; `view=chase` for the seat's chase camera) next to an idle reference, in the cockpit and chase views at desktop, landscape and portrait, into `docs/design/titanfall/captures/weapons/`. `tools/titanfall-weapon-feel-test.mjs` (in `titanfall:test`) pins the feel tuning, the bank files and licences, and the sampled / synth voices.
- `tools/titanfall-cockpit-fx-capture.mjs` runs muted CDP captures of the cockpit damage stages and the transit beats (held with `pinTransit`) for 3 titans × desktop / landscape / portrait into `docs/design/titanfall/cockpit/damage/captures/`. The hatch and boot beats (`hatch-closing` … `boot-hud`, `exit-plates`) go to `docs/design/titanfall/embark/captures/` with `--out`. The capture page's `settle` steps the page clock, because software GL renders only about one frame per second. Charge/spin and doom/destruction fixtures are captured by `titanfall-weapon-fx-capture.mjs`; `tools/titan-sfx/browser-decode.mjs` decodes every shipped Opus file with a real OfflineAudioContext, without playback.

---

## 8. Client UI (WP6)

References: `hud-pilot.png` option 2, `hud-titan.png` option 2, `loadout.png` (with the
corrections in the design README).

### 8.1 Structure

`public/js/titanfall/titanfall-client.js` is written by WP0 as a **fixed registry and frozen**. It
imports one module per WP, each exporting `{ tick(snapshot, dt), frame(dt, ctx), onEvent(event),
dispose() }`, and fans calls out to them. It also injects `public/styles/titanfall.css` with a
`<link>` on load and removes it on dispose (so `index.html` is never edited).

| Module | Owner | Role |
|---|---|---|
| `pilot-client.js` | WP1 | pilot camera roll, local/remote pilot poses, cloak shimmer, `avatarState` |
| `titan-predict.js` | WP2 | own-titan prediction (§5.1) |
| `titan-presentation.js` | WP5 | model factories, walker update, ability fx, drop beam |
| `titan-ui.js` | WP6 | HUD, loadout, controllers, announcer |

WP6's files (new unless noted):

| File | Role |
|---|---|
| `public/js/titanfall/titan-ui.js` | WP6 registry entry |
| `public/js/titanfall/titan-hud-state.js` | **pure** model: `(snapshot, selfRow, tfsFrame, vehicleRow, now) → model`. No DOM. Unit-tested in node. |
| `public/js/titanfall/titan-hud.js` | thin DOM render (pilot and titan layouts) |
| `public/js/titanfall/titan-loadout.js` | loadout screen (5 primaries, 4 AT, 3 tacticals, 5 titan cards plus kit strip). localStorage key `titanfall.loadout.v1` (try/catch), sent as `{t:'titanfall', loadout}` |
| `public/js/titanfall/titan-controller.js` | capture-phase key handler for the `titan` context (abilities, eject triple-tap, smoke, view, dash) |
| `public/js/titanfall/pilot-controller.js` | capture-phase key handler for the `pilot` context (Q tactical, E callTitan); it consumes the event (`preventDefault`), so `Input` never sees Q/E as lean in titanfall |
| `public/js/titanfall/titanfall-announcer.js` | announcer cue mapping |
| `public/styles/titanfall.css` | HUD styles, `data-mode="titanfall"` selectors, mobile layout |

Pilot HUD: health, titan meter ring ("TITANFALL READY", "TITAN BAY FULL"), tactical charges and
cooldown, AT ammo and lock ring (`tfs[11]`), rodeo prompt and rip progress, battery icon, score
bar, time, OOB warning with its seconds left. (No wallrun / double-jump pips: removed, TF2 has none.)

Titan HUD: hull and shield bar, doom state, dash pips, ability readiness (def/tac/ord/core),
core meter, primary ammo and charge or spin, smoke charges, lock warning, rodeo warning ("ENEMY
PILOT ON BOARD"), eject prompt (press X ×3, shown only while doomed).

**Dispose checklist** (every WP's module): remove DOM and CSS link, deactivate the `pilot`/`titan`
input contexts and listeners, dispose battery pickup meshes, marker beams, ability FX, the walker
rig, prediction state and announcer timers. The hud-state test asserts that after
`titanfallClient.dispose()` no titanfall listener is active and Q resolves to lean.

### 8.2 Keybindings — `public/js/keybindings.js`

Two new contexts; action names appended; defaults unique within each context
(`keybindings-test`). `overlaps()` already treats different contexts as non-conflicting and is
**not** changed. `public/js/engine/input.js` is **not** changed: the controllers consume their keys
in capture phase, as `VehicleController` does. `server/accounts.js` imports
`normalizeKeybindings`, so unknown actions must normalise cleanly.

| Context | Action | Default | Note |
|---|---|---|---|
| `pilot` | `pilotTactical` | Q | consumed by `pilot-controller` (lean suppressed in titanfall) |
| `pilot` | `callTitan` | E | consumed by `pilot-controller` |
| `titan` | `titanDash` | Space | |
| `titan` | `titanDefensive` | Q | held |
| `titan` | `titanTactical` | E | |
| `titan` | `titanOrdnance` | G | |
| `titan` | `titanCore` | V | |
| `titan` | `titanSmoke` | C | |
| `titan` | `titanEject` | X | triple-tap within 0.8 s, only while doomed |
| `titan` | `titanMelee` | F | |
| `titan` | `titanView` | H | |

- Embark is hold-interact (T) for 300 ms, through `VehicleController.queueInteract`, extended for titans.
- `public/js/session/vehicle-controller.js` (WP6): `sync` filters to the own titan (`row.own === selfId`) in titanfall; `controls` gets the walker branch (§3.6); its vehicle-context capture keys (X cm, C freelook, V view, Q next weapon) are suppressed when the seated vehicle is a titan.
- Driver pitch clamp for titans: −1.15..0.7 (matches the mount pitch limit).
- Touch: `public/js/engine/touch-controls.js` (WP6) adds titanfall-gated buttons for callTitan, tactical, titan abilities, smoke, dash and the eject triple-tap. Open: no titan MELEE or ADS button while seated (Ronin's Sword Core, the Splitter split mode and the Northstar zoom need them); adding two buttons needs a touch layout pass (portrait has no free slot clear of the doom panel and arc).

### 8.3 Mode lists to widen (WP6)

| File | Site |
|---|---|
| `public/js/ui/mode-presentation.js` | `MODE_TITLES`, `rankPlayers` (team score) |
| `public/js/ui/match-hud.js` | local `isTeamMode` |
| `public/js/ui/scoreboard.js` | team columns plus titan kills (`tf[7]`) |
| `public/js/ui/match-result-overlay.js` | team result |
| `public/js/ui/lobby-settings.js`, `public/js/ui/lobby-roster.js` | team/mode lists |
| `public/styles/mode-hud.css`, `public/styles/touch-controls.css` | `data-mode` selectors |
| `public/js/guns/weapon-state.js` `_directSlot`, `public/js/session/weapon-wheel-controller.js` `kitEntries` | §6.2 |

(`MODE_LABELS` is WP0's, §2.1.)

### 8.4 Audio and announcer

- `shared/announcer.js`: append `TITANFALL_CUES` (`titanfall_ready`, `titan_ready`, `prepare_titanfall`, `core_online`, `titan_doomed`, `eject`, `enemy_titan`, `rodeo_warning`, `battery_acquired`, `winning`, `losing`, `match_win`, `match_lose`). Add them to `announcerCueInfo` without changing existing cues.
- WAVs go to `public/assets/audio/announcer/titanfall/`, made with macOS `say` (an original voice, e.g. `-v Samantha`, plus filtering in `tools/`). `sources.json` lists the generation command per file.
- The ElevenLabs quota is exhausted: do not plan generation there.

### 8.5 main.js integration (WP0 hooks only)

`public/js/main.js` is dirty and hot. WP0 adds exactly these five hooks (and saves them as a
hunk patch, R3):

1. `bootLive`: `if (welcome.gameMode === 'titanfall') this.titanfall = await (await loadMatchRuntime()).loadTitanfallClient().then(m => m.create(this))`. `match-runtime.js` exports a **loader**, not the module: `export const loadTitanfallClient = () => import('../titanfall/titanfall-client.js');`, so the titanfall client is fetched only for titanfall matches. It also enables `VehicleAudio`, `VehicleDestructionFX` and `VehicleFx` with `modeHasVehicles(welcome.gameMode)` (condition expression only).
2. `handleTick`: `physics.pilotRules = isTitanfall(mode)`; vehicleController enabled for `modeHasVehicles`; `this.titanfall?.tick(snapshot, dt)`.
3. `onGameplayEvent` fan-out (L154): `this.titanfall?.onEvent(event)`.
4. per-frame refresh (next to `conquestHud?.refresh`, ≈ L1318): `this.titanfall?.frame(dt, { camera, nowMs })`; the seated send (L1184-1230) adds `titanHold` from `this.titanfall?.titanHold()`; the `lockReady` feed (L1152) reads `tfs[11]` when titanfall is active.
5. `disposeLiveResources` (L1528): `this.titanfall?.dispose(); this.titanfall = null`.

### 8.6 On-gun displays

Every titanfall pilot gun (`TITAN_PILOT_PRIMARIES`, the `revolver` sidearm and `TITAN_PILOT_AT`: 10 guns; the knife has
none) carries a diegetic ammo counter, and the floating stock ammo card hides while the counter is on screen.
Design: option H1, a Halo MA5-style rear deck counter
(`docs/design/titanfall/weapon-displays/halo/option-h1-rear-deck-reference.jpg`; H2 rear cap and H3 digits only are in
the same folder with their prompts). It replaces the earlier left-flank panel (option A, `option-a-reference.jpg`,
captures in `before/`). Reasons: the counter sits on the gun's centre line behind the rear sight and faces back along
the weapon toward the eye, so it reads from the hip and right under the sight picture while aiming, without a side
panel or screen UI. The earlier objection to a rear deck ("seen at a grazing angle from the hip") does not hold: the
seated screens face the hip eye at cos 0.94–0.97.

- **Module.** `public/js/guns/weapon-display.js`: `weaponDisplayModel(read, { mode, lock }, out)` (null outside
  titanfall and for guns without a counter), `paintWeaponDisplay(context, w, h, model)` and `applyWeaponDisplay(bundle,
  id, model)`, the same replaceable layer as `stattrak-module.js`. One `BufferGeometry` mesh per gun in two groups: the
  housing (flat-shaded `MeshStandardMaterial` `#22262c`, the gun kit's program) and the screen face (`MeshBasicMaterial`
  with a 256 px wide `CanvasTexture`, 256 × 199 for the 0.045 × 0.035 m screen), so two draws per gun. The canvas is
  repainted only when a shown value changes. Progress rings step in 5 % (20 segments), so a held charge or lock
  repaints at most 20 times. The model object is refilled in place every frame (no per-frame allocation).
- **Values.** `WeaponState.readDisplay(out, now)` (new, allocation-free subset of `readModel`): predicted `mag`,
  `reserve`, `reloading01`, `reloadStaged`, the CR-6 capacitor `charge01` and `ready01`, the fire cadence since the
  last shot (`1 - wait / (60000 / rpm)`). A draw pushes `_nextFireAt` up to `_deployUntil`; only a wait past the draw
  counts, so a freshly drawn CR-6 or KRABER shows its magazine ring, not a vent or bolt cycle. The ARCHER lock is
  `tfs[11]` (`lockProgress`). Low ammo uses the stock card's rule (at most 22 % of the magazine,
  `GameplayHud.updateAmmoLow`); a single-round launcher (ARCHER) is low only at 0.
- **Counter.** Compact: no tag, fire mode or labels. The magazine count fills the centre (about half the screen
  height, zero-padded to the magazine's digits, e.g. `05` of 30) in the weapon tint. Around it is a segmented ring
  shaped like a horseshoe open at the bottom. In the opening sits the reserve. The ring drains with the magazine: one
  segment per round up to 20 rounds, otherwise 20 segments. Low: count and ring turn `#ff3355`, and the drained slots
  become warning outlines instead of dim fills. This, plus the drained ring itself, keeps the warning readable without
  colour (the IRONCLAD tint `#ff5277` is close to the warning red). Empty with reserve left: `RELOAD` in red replaces
  the reserve. Reloading: `RELOADING` in white replaces the count while the ring fills white. A staged tube reload
  (M-DOCK, `reloadStages`) keeps the count, which climbs as each shell seats, over the white ring. The ring is also the
  progress ring for the weapon's own state while it runs:
  - CR-6 charge in the tint.
  - ARCHER lock in the tint, full red when `LOCKED` (like the AT chip ring).
  - The CR-6 vent (2.5 s), THUNDERBOLT arc (1.2 s), KRABER bolt (1.1 s) and M-DOCK pump cycle as a dimmed fill.

  `WEAPON_TINT` mirrors the `style.css` `--w-*` palette (the test checks it).
- **Mounts.** Each builder sets `body.userData.displayMount = DISPLAY_MOUNT` (exported from the model file, also on
  the Blender path): `{ x, y, z, w, h, seat, tilt?, yaw?, pod?, adsHidden? }`. Screens are 0.045 × 0.035 m (IRONCLAD
  0.040 × 0.031) in a recessed bezel (3.5 mm, 5.5 mm brow, rim 2.5 mm proud of the screen).
  - **Normal.** It faces halfway between the hip eye and the sight eye of the gun's timing profile. The hip eye is
    minus `T.hipOffset || HIP`, turned by `T.hipYaw`. The sight eye is minus `T.adsOffset`. This fixes the old fixed
    sight-eye z of 0.3. The result is tilted 10–15° up and turned 12–16° toward the hip eye; `tilt`/`yaw` in degrees
    override it.
  - **Seat.** When the counter is built, 5 × 5 rays against the seat axis start 6 mm above or behind the housing's
    front face and run against the built gun (procedural or Blender; gloves excluded): `deck` rays point down, `rear`
    rays point forward. They are not cast from 0.3 m out, so the stock, comb or a scope behind or above never counts.
    The counter moves along the axis until the housing's lowest front corner stands 3 mm off the nearest hit. The pod
    reaches 6 mm past the deepest hit, at most `pod` (default 20 mm) past the nearest, and at least 14 mm behind the
    screen face, so the counter stands on a box that grows out of the gun. Without hits (SKIPJACK in node, where it
    builds no geometry) the mount's centre stands.

  | gun | centre (m) | seat | notes |
  |---|---|---|---|
  | rifle | (0, .086, .068) | deck | on the buffer tube behind the receiver |
  | smg | (−.010, .072, .135) | rear | back plate on the receiver end |
  | shotgun | (−.010, .062, .125) | rear | receiver rear face, under the ghost ring |
  | lmg | (−.026, .123, .150) | rear | under the aperture sight, between the receiver walls |
  | kraber | (0, .155, .110) | deck | cheek riser under the eyepiece |
  | revolver | (0, .058, .050) | rear | frame rear, `pod` 0.04 |
  | chargerifle | (−.050, .093, .050) | rear | rear-left receiver corner (centred, the comb hides it) |
  | archer | (−.020, .158, .120) | deck | housing top, `adsHidden` |
  | thunderbolt | (−.045, .137, .170) | deck | on the rear hump |
  | mgl | (−.015, .138, .030) | deck | receiver deck, `pod` 0.05 |

  On screen at 1920×1080 and FOV 75, the counter is about 80–130 px wide from the hip, with digits about 35–50 px tall.
  While aiming it sits 1.3–4° below the aim point (SKIPJACK 11°). The stock comb hides the reserve row on the rifle and
  the M-DOCK in ADS. The ARCHER counter would cover its rear sight ring, so it keeps `adsHidden`. The SKIPJACK no
  longer needs `adsHidden`. The smg, shotgun, lmg and thunderbolt centres were moved from the first survey so that
  they clear the bottom edge and the bottom-right HUD block from the hip at FOV 65.
- **Gating.** `titan-ui.js` `syncGunDisplay` (per frame, layout `pilot` only) feeds `rig.setWeaponDisplay(model)`.
  `ViewmodelRig.update` applies it to the drawn gun after the StatTrak plate. `setWeaponDisplay(null)` (leaving the
  `pilot` layout: embark, titan, death; `titan-ui` dispose) strips the counter from every built gun, so every other
  mode and a rig without the hook look exactly as before. A drawn weapon without a counter (the knife) strips
  nothing: the rig keeps the last model and each counter paints only its own gun, so a knife round trip rebuilds no
  canvas, texture or geometry. Mid-swap the holstering gun keeps its last paint.
- **Floating card.** `rig.weaponDisplayLive` is true while the drawn gun has a counter, the viewmodel is shown and at
  least 75 % of the counter's screen lies inside the view (`weaponDisplayInView`, `WEAPON_DISPLAY_IN_VIEW`). The rig
  measures that only on a settled pose (no swap, reload, throw, vault, medkit or stow) and keeps the last result
  otherwise, so a reload dip never flickers the card.
  `titan-ui` then sets `body[data-titanfall-gun-display]`, and `titanfall.css` hides `#ammo` (with the weapon icon and
  name) and `#charge-meter` on desktop and touch alike. On a phone (844×390) the counter is about 30 px wide with the
  count still legible. The card comes back whenever the counter is not visible, so there is always a readout:
  - scoped (KRABER), seated, third person and spectating hide the viewmodel;
  - a portrait phone (390×844) holds the gun at the right edge, where every counter except the ARCHER's falls off
    screen (0 % in view at FOV 65 and 75; at FOV 100 the CR-6 and SKIPJACK come back), so the card stays there;
  - the ARCHER aims with `adsHidden` above 50 % ADS.

  Swaps and grenade throws keep the card hidden, so it never flickers. On desktop (wider than 520 px) the grenade card
  moves into the freed corner under the AT chip (`right: 22px`), clear of the counter.
- **AT lock ring.** The AT chip's ring stays a screen element: the ARCHER counter is hidden while aiming, and the ring
  is the one lock cue in the same place for every AT weapon and both input layouts. The chip's own ammo text stays.
- **Captures.** `node tools/titanfall-weapon-display-capture.mjs` (muted CDP via `public/titanfall-weapon-capture.html`;
  holds one `.titan-capture.lock` slot) renders the real `ViewmodelRig` with the Blender guns over the frontier still,
  under the stock HUD, the titanfall pilot HUD and, on phones, the touch buttons. It writes to
  `docs/design/titanfall/weapon-displays/captures/`. The images there still show the flank panel and need
  regenerating. Each shot can take a trial `mount` override (`render({ mount })`) for placement studies.
- **Test.** `tools/titanfall-weapon-display-test.mjs` (in `titanfall:test`, 225 checks) covers:
  - mounts: a top-rear mount on every pilot gun (near the centre line, compact size, `deck`/`rear` seat) and none
    elsewhere; the screen facing the hip and sight eyes (cos > 0.85, tilted up, facing back); the seat (screen clear
    of the gun surface along the seat axis, at most 3 cm off it, pod reaching into it);
  - mode gating: null in all 10 other modes, and no counter on an unhooked rig;
  - model values from a real `WeaponState` (low threshold 7 / 30, reload 50 % → 10 steps, charge, vent, a fresh draw
    showing the magazine, the M-DOCK staged reload with seated shells, lock 0.55 → 11, KRABER bolt);
  - painted texts and colours plus ring segments per state (count and reserve only, zero-padding, low outline cue,
    `RELOAD`, `RELOADING`, white reload and staged rings, charge, lock, locked red, cycle);
  - the mesh: one mesh in two groups, repaint only on change, a swap keeps the paint, strip and dispose (with the rig
    too), and the ARCHER ADS hand-back;
  - on screen from the hip at FOV 65, 75 and 100 in 1920×1080 and 1920×1200: inside the view, below the aim point,
    above y −0.9 (−0.98 at FOV 65, where the rear counter sits nearest the eye) and clear of the bottom-right HUD
    block; in ADS, every counter that is not scoped or `adsHidden` sits below the aim point;
  - off the view's edge at FOV 75: live on phone landscape for every gun, not live on phone portrait except the ARCHER,
    and a rifle reload never flips it;
  - `titan-ui` `syncGunDisplay` on a stub rig and the fake DOM (body flag, `tfs` lock, card back off screen, knife
    keeps the counters, titan strips once, dispose);
  - the tint palette and the CSS rules (card hidden without a touch guard, grenade card moved).
- **Open.** The node test seats the procedural fallbacks of the Blender guns (rifle, smg, shotgun, lmg, revolver), so
  their exact seat is checked in the browser captures only. The stock comb hides the reserve in ADS on the rifle and
  M-DOCK. At FOV 65 the shotgun and smg counters reach y −0.97 / −0.94. The KRABER has no counter while scoped (the card
  returns). Without a `document` (node) the screen is a flat tint.

### 8.7 Wrist display

On foot in titanfall first person, the pilot tactical (grapple, stim or cloak) is read from a diegetic device on the
left forearm, and the floating DOM tactical chip hides while it is on screen. Reference:
`docs/design/titanfall/wrist/wrist-a-reference.jpg` (concept A, armoured bracer slab), chosen over B (round wrist
puck: digits too small on a phone) and C (forearm LED strip: most weapon poses hide the forearm, tiny text). Choice,
comparison and captures: `docs/design/titanfall/wrist/README.md`.

- **Module.** `public/js/titanfall/pilot-wrist.js`: `PilotWrist` (attach to a `ViewmodelRig`, `update(tactical, opts)`
  per frame, `standIn(content, hip, hipYaw)` and `place(arms)` from the rig, `dispose()`), the pure
  `wristFace(tactical, { inRange, touch, compact })`, `wristShown(model, { spectating })`,
  `grappleInRange(solidAt, origin, dir, feet)`, `wristPose(...)`, `weaponShift` and `drawWristFace(ctx, face)`.
  Tuning in the frozen `PILOT_WRIST`.
- **Values.** Everything comes from the HUD model's `pilot.tactical` (`titan-hud-state.js` `tacticalModel`), the same
  object the DOM chip paints. `tacticalModel` now also returns `reeling` (grapple flag), `cooldownLeft` (seconds to
  the next grapple charge, `(1 - tacReady) × recharge 6 s`, or until stim / cloak are ready, `× cooldown 12 / 15 s`;
  null when full), `activeLeft` (a running stim or cloak, `seconds − tacReady × cooldown`, so 4 s / 5 s at
  activation) and `activeFrac`. No new server fields.
- **Screen.** 384 × 240 canvas on a 0.11 × 0.069 m glass. Left: the loadout tactical glyph, the name (`GRAPPLE`,
  `REELING`, `STIM`, `CLOAK`) and the rebinding-aware key cap (none on touch). Right: two charge cells for the grapple
  (full, filling with the recharge, empty), one wide cell for stim / cloak (it fills with the cooldown, and drains
  while the ability runs), the seconds under them (rounded up to 0.1 s) or `READY`. Tones: amber with a charge,
  dimmed amber without, cyan while reeling (chevrons instead of a timer), green stim, ice-blue cloak, plus a status
  LED edge. A glass under 140 px wide on screen (`compactPx`: every phone size; on desktop the LMG, the KRABER, and the rifle and SKIPJACK at FOV 100)
  draws the compact face: no key cap, the name at 50-56 units instead of 38-44, the timer at 84 instead of 74 without
  the `s`, and IN RANGE as a cyan frame round the glass instead of the 24-unit tag (the key cap and tag were 5-6 px
  tall on a phone).
- **IN RANGE.** Shows on a ready grapple (white LED edge, plus the tag or the frame). It is the server's
  `grappleTarget` test (`server/sim/titanfall/pilot-tacticals.js`) on the client world: the first solid voxel along
  the shot aim (`player.shotYaw` / `shotPitch`, what the grapple intent sends, from the camera eye) within 38 m and
  beyond 0.3 m, its anchor 0.05 m off the face at least the release distance (2 m) from the chest (feet + 1.2 m), and
  the pull's line from the head (feet + 1.6 m) clear (`grappleLineClear`, shared with the server). Presentation only,
  sampled at 10 Hz; titan hulls are not tested.
- **Placement.** `ViewmodelRig.armGear` is the hook: the rig calls `standIn(content, hip, hipYaw)` before it poses the
  arms and `place(arms)` after. The slab sits 0.2 m up the left forearm from the wrist joint (0.05 m on a portrait
  screen), on a 0.03 m cradle off the sleeve (0.056 m radius) and turned 75 % from the sleeve normal toward the eye,
  its x axis 75 % toward the screen horizontal. The housing (bezel, back plate, cradle, strap bands with their sides
  down to the sleeve) is one merged mesh. Weapons built without a support glove (no `hand_l`, or only the hidden
  reload glove on `extra`: SMG, revolver, knife) get a stand-in fist (the mirrored Blender grip glove) in a guard
  pose: `ViewmodelArms.offHand` poses the left arm from it, so the display shows with every pilot weapon. The choice is
  per built weapon, so a two-handed gun that hides its support hand mid-reload never shows the stand-in. The fist
  hangs under the rig's grip-pivot frame (bob, sway, kick) and takes 50 % of the gun content's move from its hip rest
  (ADS, recoil, reload rock, stow). When a one-handed gun's own reload hand shows, the left wrist eases to it and back
  at 18/s (`offHandShare`, ~0.15 s); while the share is between 0.05 and 0.95 the slab is off instead of sliding
  across the view. Small viewports and wide FOVs grow the slab (×1.45 for small screens, up to ×1.3 more for FOV
  above 75, capped at ×1.85; ×0.85 in portrait), from its right edge (`growAnchor`), so the growth goes left onto
  the forearm and not into the gun body. Per-weapon seats (`weaponShift`, m along the screen x, [wide, portrait]):
  SKIPJACK −0.055 / −0.16 (the launcher covers the support forearm), LMG −0.05 / −0.065 (bipod stub over the right
  cell), ARCHER 0 / −0.075 and THUNDERBOLT 0 / −0.055 (their bodies cover the portrait hand seat). In the portrait
  touch layout the glass must stay above the button cluster (NDC y −0.53): it slides to the cuff (0.01 m), then over
  the back of the hand (−0.05 m), else it hides and the DOM chip returns. Portrait fallback, all 11 pilot weapons
  captured: FOV 75 only the shotgun (pump hand under the buttons); FOV 65 rifle, shotgun, LMG, charge rifle, ARCHER,
  THUNDERBOLT and SKIPJACK (KRABER, SMG, revolver and knife keep the wrist); FOV 100 none.
- **Gating.** `titan-ui.js` builds the wrist at init on `app.rig` and calls `syncWrist` every frame after the gun
  display: shown only for layout `pilot` and not spectating. The rig root's own visibility (scoped, third person,
  dying, seated) hides it with the weapon. The screen is live when it is placed, at least 75 % of the glass is inside
  the viewport (`inView`; a reload hand that carries it off the bottom of the screen is not) and, on a gun's own
  support arm, the ADS blend is at most 0.5 (`adsHandback`: the receiver covers the slab in every two-handed ADS
  pose; the stand-in fist stays live in ADS, left of the centred gun). Only a live screen stamps its draw time in
  `onBeforeRender`; a slab that turns off or stops being live clears the stamp at once, so the DOM chip comes back the
  same frame. While a live screen drew in the last 250 ms (`wristLive`, bridging the reload ease gap), `titan-ui`
  sets `body[data-titanfall-wrist]` and `titanfall.css` hides `.tf-hud .tf-tactical`. Every other case (titan,
  embark, dead, spectating, scoped, ADS on the support arm, off screen, portrait fallback, no WebGL) keeps the DOM
  chip. While the wrist is not worn the rig gets no stand-in, so a one-handed gun keeps its left arm hidden. Touch
  buttons are unchanged. Dispose removes the meshes, the stand-in fist, the texture, the rig hook and the body flag.
- **Cost.** Two draws (merged housing, screen) plus the stand-in fist's parts while it shows. The canvas repaints only
  when the quantised face changes: cells step in 2.5 % (40 steps), the timer in 0.1 s, at most 12 Hz; a tone, label,
  status, IN RANGE or compact change repaints at once. To find that out each frame builds one small face object and
  its key string; `syncWrist` passes one options object.
- **Readability.** Glass on screen (CSS px, browser captures): desktop 1920×1080 rifle 154 × 115 (FOV 65: 185 × 139,
  FOV 100: 126 × 95, compact), stand-in fist weapons 220 × 177, LMG 137 × 102 and KRABER 131 × 97 (compact);
  landscape 844×390 rifle 84 × 63 (FOV 100: 69 × 53); portrait 390×844 rifle 84 × 61. With the compact face on a
  ~60 px tall glass the name is ~12 px and the timer ~20 px tall.
- **Captures.** `node tools/titanfall-wrist-capture.mjs` (muted CDP, `public/titanfall-wrist-capture.html`, one
  `.titan-capture.lock` slot; `--ads 0,1` for ADS) writes `docs/design/titanfall/wrist/captures/`: rifle × 7 states ×
  desktop, landscape and portrait with screen crops, `weapons/` (the other 10 pilot weapons), `fov/` (FOV 65 and
  100), `ads/` (rifle, shotgun, SMG, ARCHER aiming); `baseline/` is the game before. The capture page sets the body
  flag through `wristLive()` taken at its render, as `syncWrist` does. `--gun` also feeds the drawn gun's on-gun counter (§8.6) and sets
  its body flag from `rig.weaponDisplayLive`, so both diegetic readouts live together:
  `docs/design/titanfall/integration/captures/` (rifle, SMG, CR-6 × grapple and stim × desktop, landscape and
  portrait). They do not overlap: the slab sits on the left forearm left of the receiver, the counter behind the
  rear sight. In portrait the counter is off screen and the ammo card shows (§8.6).
- **Test.** `tools/titanfall-wrist-test.mjs` (in `titanfall:test`, 23 checks): timers over the wrist fixtures
  (`public/js/capture/titanfall-wrist-fixtures.js`), face tones, cells, timer, REEL, IN RANGE gating and touch key,
  `wristShown` per layout, IN RANGE against the server rules (range, release from the chest, the head line of
  sight), the pose facing the eye, `PilotWrist` on a real `ViewmodelRig` (glass on screen at 1080p, the stand-in fist
  with the SMG, no fist and no left sleeve when not worn), ADS handback and the following fist, reload sweeps
  (rifle, LMG, shotgun, SMG, revolver: no stand-in on a two-handed gun, the slab never moves further than its forearm
  seat, live only in view), all 11 pilot weapons at desktop, landscape and portrait (stand-in choice, compact face,
  in view, above the touch buttons), the compact face, the redraw throttle, the live flag, `titan-ui` on a fake DOM
  (body flag on a live draw, ADS, spectating and titan drop it, dispose detaches) and the `titanfall.css` rule.
- **Open.** The stand-in fist is the stock glove, not tinted to the pilot skin. IN RANGE ignores titan hulls and
  entities. The portrait fallbacks above keep the DOM chip. The slab is about half the reference width; the cradle
  and strap sides stand in for the reference's wrap-around cuff. Not yet captured in a live match.

---

## 9. Bots (WP7)

| Item | Spec |
|---|---|
| Brain | `server/bots.js`: replace `mode === 'conquest'` with `isCombinedArms(mode)` **only** where the branch is about vehicles or kits. Commander, flag and capture logic stays conquest-only. Titanfall logic goes in `server/bot-titanfall.js` (new). `TitanfallPolicy.botGoal` returns `{ kind: 'fight' }` like TDM (WP0). **Play area (WP0):** `TitanfallPolicy.botBounds()` returns the frontier rectangle (null on whole-map areas); `BotManager.roamSpot(br, p)` samples roam/retreat/unstick targets inside it and `outsideBotBounds` replaces a roam target outside it. WP7 keeps every new navigation goal (titan call point, embark walk, AT stand-off) inside `botBounds()` too. |
| Loadout | `prepareLoadout`: random titanfall loadout (seeded by bot id); `preferredSlot` picks the AT weapon when the target is a titan within 60 m |
| Call titan | meter full + on ground + not in combat for 1 s → aim at a point 8–20 m ahead (`titans.call`, retry another yaw up to 4 times) |
| Embark | walk to own titan when landed and no enemy is within 15 m; hold-enter through the existing bot `vehicleAction` path |
| Drive | `bot-vehicle-driving.js`: a `WALKER` table next to `GROUND`; `active` accepts walkers; uses `groundNavigation` (WP0 widens its gate) |
| Fight | `bot-vehicle-combat.js` `HULL_THREAT`/`ARMOR_BY_TYPE` get titan entries; gates widen to walkers; `usableSlots` unchanged. Abilities: defensive under 60 % health while taking fire; ordnance on cooldown with LOS; core when ready and an enemy is within 50 m; dash on incoming lock; smoke with a rider |
| Doom | eject at doom start with probability 0.8 (difficulty-scaled) |
| Pilots vs titans | use AT, keep 25 m+, rodeo if within 3 m of an enemy titan's back (difficulty ≥ normal) |
| Cloak | `server/bot-perception.js` (WP7) calls `isPerceivable` (§4.1) when `isTitanfall(mode)`; ×3 aim error inside 12 m |
| Not in v1 | wallrun, grapple and slide (stock movement under `pilotRules`, double jump only) |
| Avoid | `server/bot-aircraft.js` is dirty and is not touched |

Test `tools/titanfall-bots-test.mjs`: headless 6v6 bot lobby on harbor for
`TITANFALL_BOT_SIM_SECONDS` (default 90 in `titanfall:test`; 180 in `npm run titanfall:bots:long`).
Asserts ≥ 2 titans dropped, ≥ 1 embark, ≥ 1 titan damaged by a pilot, no bot stalls > 20 s, no
exceptions. A second, shorter frontier run asserts no `restricted` (out-of-bounds) bot deaths. WP7
merges last among WP1–7 and re-runs the test after WP2, WP3 and WP4 are merged.

---

## 10. Grunts (WP8, later)

- AI infantry as `engine.npcs` (a new server/sim system, not players). Grunt: 100 hp, rifle, 1 point. Spectre: 200 hp, smart pistol shots, 2 points.
- Squads of 4 from dropships at the team side, capped at 12 per team.
- They walk navmesh lanes toward the midfield (`groundNavigation`) and fire at the nearest enemy within 40 m.
- Titans crush them on contact.
- Meter: +0.02 per grunt kill.
- Fire upkeep (2026-10-16 stare-down fix): a minion presses reload when its magazine is empty, and below 40 % (`reloadIdleBelow`) when it has no target. `infiniteMagazines` only refills the reserve. Before this fix the magazine was never reloaded, so after one magazine (30 rifle / 36 smg rounds) a minion stood facing its target without firing until something killed it. Sight, aim and cover are judged from the standing eye. A grunt crouches only between bursts and stands `standLeadMs` (150 ms) before the next one. Cover spots must give the standing eye a line to the target. A target seen again within `recallMs` (1.5 s) of losing sight of it is the same engagement and gets no new reaction delay. Before, a crouched eye behind a waist-high wall lost the target, so every crouch dropped it and re-rolled the reaction delay. `titanfall-grunts-test` checks that minions fire past one magazine, that no minion holds a target longer than reload + pause without a shot, and that a grunt behind waist-high cover keeps its target. The canyon/harbor wave runs hold no target longer than 5 s without a shot (old code: 10-16 s, all with an empty magazine).
- Wire: `match.titanfall.npc = [[id, kind, team, x, y, z, yaw, hp100]]`. Budget 12 B/npc.
- **Not started until WP1–WP7 are merged.**

---

## 11. Tests

### 11.1 Suites

All new tests are node, headless and audio-free. `package.json` (dirty: hunk patch) adds:

```json
"titanfall:test": "node tools/titanfall-contract-test.mjs && node tools/titanfall-mode-test.mjs && node tools/titanfall-pilot-movement-test.mjs && node tools/titanfall-titan-sim-test.mjs && node tools/titanfall-titan-weapons-test.mjs && node tools/titanfall-at-weapons-test.mjs && node tools/titanfall-model-budget-test.mjs && node tools/titanfall-hud-state-test.mjs && node tools/titanfall-bots-test.mjs",
"titanfall:bots:long": "TITANFALL_BOT_SIM_SECONDS=180 node tools/titanfall-bots-test.mjs"
```

`titanfall:test` is appended to `"test"` after `conquest:test`. Until a WP merges, its test file is
a WP0 stub that prints `SKIP <wp>` and exits 0.

| Test | Owner | Asserts |
|---|---|---|
| `titanfall-contract-test.mjs` | WP0 | contract frozen and import-free, ids unique, topology rows have the `S`/`M` shape, every titan resolves through `vehicleMountOrder`/`seatWeaponList`/`vehicleWeaponMeta`/`vehicleDriverSeat`, `VEHICLE_RULES`/`VEHICLE_WEAPONS` cover titans, `rayHit`/`projectileHit`/`mounts.reset` on a titan, `solidWreck`, loadout pack round-trip, `titanWeaponRole`, armour table, `VEHICLE_TYPE_IDS` unchanged, conquest META unchanged, every `TITAN_KILL_KEYS` key has a name and glyph, every WP0 stub module imports with its frozen export names, titan row bytes avg ≤ 280 / max 300 |
| `titanfall-mode-test.mjs` | WP0 | lobby creates the mode on all 3 maps; frontier titanfall has 0 non-titan vehicles and uses the play-area spawns; `tf` only in titanfall; `tfs` frames only to the owner and tick stringified once (16 bots); scoring (pilot 5, titan 10 once, to the doomer); score-limit and time-limit end, draw; respawn 4 s; capacity 16 and bay cap; spawn avoidance and the 30 m `spawn` drop refusal; OOB kill; lifecycle table §1.1; structural conquest invariants (§11.2); in-process A/B conquest digest |
| `titanfall-pilot-movement-test.mjs` | WP1 | wallrun entry/exit timing; stair climb never enters wallrun; alley ping-pong height ≤ 8 m; double jump once; wall-jump restores the jump; slide boost/cooldown and ≈ 1.1 s duration; 30 s scripted slide-hop + strafe never exceeds the clamp; grapple charges; regen; `stepPilot` server/client parity over 2000 random ticks (calls `stepPilot` directly; bit-equal) |
| `titanfall-titan-sim-test.mjs` | WP2 | call/refuse reasons (incl. water, uneven, blocked, spawn, bay); ground destroyed mid-drop; drop crush and friendly push; leg-box crush; shield order; no regen (damage `step` early return); doom 7 s; eject refused when not doomed; eject during doom credits the doomer 10; owner-only enter; destroyed during embark releases the pilot; auto-titan fires and credits the dead owner; auto-titan smoke on rider; rodeo rip 15 % once (`batteryOut`); one enemy rider; insert refused at cap; rider with rifle needs ≥ 15 s to doom an Atlas; ally shoots the rider off; wreck removal; one titan per pilot; titan survives owner respawn; walker step/slope/fluid wall; hits a pilot standing 4 m in front; `stepTitanWalk` server/client parity at 20/60/120 Hz and reconcile convergence < 0.25 m |
| `titanfall-titan-weapons-test.mjs` | WP3 | each primary's sustained DPS vs titan within ±20 %; infantry damage; 6-tuple mount row; every primitive (vortex catch cap, firewall line, hover, phase blink stops at voxels, toggle); core charge excludes core damage; melee execution |
| `titanfall-at-weapons-test.mjs` | WP4 | the 4 ids appended after stinger, gadgetOnly; archer lock on titans only in titanfall; charge rifle needs full charge; each AT weapon needs ≥ 20 s to solo-doom an Atlas; thunderbolt cluster DPS; loadout fill sets mag/reserve; bastion lists exclude gadgetOnly |
| `titanfall-model-budget-test.mjs` | WP5 | ≤ 24 draws and ≤ 30 k tris per titan, rig determinism, IK feet planted (drift < 0.05 m); cockpit fx ≤ 14 draws; the hatch plates, seams, sparks and glass screen through a live cockpit (ION, NORTHSTAR) |
| `titanfall-hud-state-test.mjs` | WP6 | pure model from fixture rows (pilot, titan, doomed, rodeo, meter full, bay full, OOB); key contexts unique; digit order; dispose leaves Q as lean |
| `titanfall-wrist-test.mjs` | wrist display | §8.7: tactical timers over the wrist fixtures, the face per state and the compact face, IN RANGE against the server grapple rules, worn only as a pilot on foot, pose, `PilotWrist` on a real `ViewmodelRig` (stand-in fist per weapon, ADS handback, reload sweeps, all 11 pilot weapons at three sizes), redraw throttle, live flag, `titan-ui` body flag and the CSS rule, dispose |
| `titanfall-weapon-display-test.mjs` | on-gun displays | §8.6: a counter mount and seat on every pilot gun, mode gating, values from a real `WeaponState`, painting, repaint on change, strip and dispose, on screen at FOV 65–100 (and off the portrait phone's edge), `titan-ui` `syncGunDisplay` and the CSS rules |
| `titanfall-bots-test.mjs` | WP7 | §9 (harbor, canyon, frontier and ashfall runs; rodeo scenario on all four) |
| `ashfall-map-test.mjs` (in `maps:test`) | Ashfall | §14 |
| `titanfall-transit-test.mjs` | cockpit transit | embark camera rides the walk-in without jumps onto the seat view, cockpit overlay gating, hatch beats (two plate clunks, lock slam with one shake, power-on) and none after a disembark or lost seat mid-hatch, reduced motion, the hatch / boot timeline (plate order, lock on the embark lock, screen and HUD stages, 1.2–1.8 s length, determinism, reduced motion, exit plates clear before the camera), landing shake, first-person exit arc through the viewport, chase blend, remote vault arc, `pinTransit`, dispose |

### 11.2 Baseline and conquest invariance

- **Before any WP0 edit**, the orchestrator runs the gate commands on the untouched tree and saves the failing-test list plus a conquest digest (seeded conquest match, digest over snapshots excluding `mag`/`reserve`) from a scratch script in the scratchpad. It re-runs the same script after WP0 and diffs, checking with `git diff --stat` that conquest files outside WP0's hunks did not change in between. Pre-existing failures (e.g. atlastest map fingerprints) are not blamed on a WP.
- The committed mode test asserts structural invariants only: no `tf`/`tfs`/`tw`/`ab`/`own` keys outside titanfall; `combatProfile === 'conquest'` in conquest; conquest `VEHICLE_DEFS` entries deep-equal those built from `VEHICLE_TYPE_IDS`; conquest vehicle row bytes unchanged; and an in-process A/B: a seeded conquest match digest, then a titanfall match, then the same conquest match again; both conquest digests match.

### 11.3 Regression gates per WP

```sh
npm run titanfall:test
npm run conquest:test          # heavy lock
node tools/atlastest.mjs; echo "exit=$?"
node tools/build-module-preload.mjs --check   # report the diff; the orchestrator runs preload:build
npm run static:test
npm run modes:lobby && npm run modes:bots     # heavy lock
```

---

## 12. Work packages

### 12.1 Ownership rules

- A file belongs to exactly one WP at a time. Handoffs after WP0 are listed explicitly ("→ WPn").
- Shared hot files (`vehicles.js`, `game.js`, `combat.js`, `projectiles.js`, `context.js`, `main.js`, `match-runtime.js`, `snapshot.js`, `admission.js`, `netclient.js`, `lobby.js`, `vehicle-damage.js`, `vehicle-view.js`, `public/js/weapons/projectiles.js`, `avatar-roster.js`) get **only WP0 hook lines**. A WP that needs another hook asks the orchestrator, which adds it and records it in §13.
- Every WP finishes with: acceptance green; its hunk patches for every pre-existing file it edited (R3); a list of its new files; a status line for §13. No staging, no commit.
- `hud-support.js` regions: WP0 (META spread, titan kill keys, `MODE_LABELS.titanfall`), WP4 (`WEAPON_NAMES` for the 4 new ids). Nobody else.
- `BUILD-CONTRACT.md` hunks: WP0 (wire, registries, `MODE_IDS`), WP1 (movement order and reconciliation, L218-223, L1101), WP4 (`WEAPON_IDS` exports, L317/L354).

### 12.2 WP0 — Spine (first, alone, 1 agent)

Goal: the mode boots on all three maps with stock movement and weapons. Titans can be called,
walk (basic `stepTitanWalk`), be embarked and be destroyed. Every hook exists and delegates to stub
modules with frozen export names. Conquest stays bit-identical.

| Owned files | Change |
|---|---|
| `shared/modes.js`, `shared/lobby-limits.js` | §2.1 |
| `shared/titan-contract.js` (new) | §2.2, full META/topology/kill keys/roles, ability table skeleton |
| `shared/conquest-contract.js` | §2.3 additive helpers |
| `shared/vehicle-armor.js` | §2.4 |
| `shared/vehicle-defs.js`, `shared/vehicles.js`, `shared/vehicle-collision.js` | §2.5 (`VEHICLE_RULES`/`HANDLING`/`WEAPONS` widening, `LOCK_RULES.archer`, titan rules and destruction) |
| `shared/vehicle-handling/titan.js` (new) → WP2 | `TITAN_RULES`, `TITAN_DEFS_INPUT`, basic `stepTitanWalk`/`placeWalker` |
| `shared/vehicle-handling/titan-weapons.js` (new) → WP3 | stub numbers with every field the mount/projectile readers use |
| `shared/pilot-movement.js` (new stub) → WP1 | §2.6 |
| `server/modes/titanfall.js` (new, frozen dispatcher) | `TitanfallPolicy`: TdmPolicy shape (`_players`, scores, `onPlayerDeath` points, `canFire`, `canMove` embark lock, `spawnPoolFor` → play-area spawns, reset, `_finishMatch` with draw, `playerSnapshot` → `tf`, `selfFrame` → `tfs`, `botGoal`, `titanfallIntent`, `onVehicleEvent` (titan points), leave/team-switch/death hooks). **No `fallDamage`.** Intents and per-tick work delegate to the modules below |
| `server/sim/titanfall/play-area.js` (new) | bounds, frontier rectangle and spawns, spawn avoidance, OOB timer |
| stubs (new): `server/sim/titanfall/{pilot-tacticals,perception}.js` → WP1; `server/sim/titans.js`, `server/sim/titanfall/{titan-damage,rodeo,batteries,meter}.js` → WP2; `server/sim/titanfall/{titan-projectiles,titan-abilities}.js` → WP3; `server/sim/titanfall/{pilot-projectiles,loadout}.js` → WP4 | no-op bodies with frozen exports (TitanSystem minimal: call/drop/enter/exit/eject/doom/destroy) |
| `server/sim/titanfall/index.js` (new, frozen) | projectile router (`TitanfallProjectiles`): `step`, `launch(kind)`, delegates to pilot/titan projectile modules |
| `server/modes.js` | dispatch, `chooseSpawn` expand list, `titanfallIntent` passthrough (no `airborneRules` change) |
| `server/sim/vehicles.js` | §5.2 hook lines, `reset` profile + `this.titans` |
| `server/sim/vehicle-damage.js` | two hook lines (§5.2) |
| `server/sim/combat.js` | `infantryDamage ?? damage`; `fireOneShot` router for `TF_PILOT_PROJECTILES` gated by `isTitanfall`; vehicle-hit hook `if (ctx.vehicles?.titans?.riderHit(attacker, v, hit, weaponId)) ...skip hull hit` |
| `server/sim/projectiles.js` | `this.titanfall` in the constructor; `proj.tf` hook with `continue`; rocket profile widening |
| `server/sim/context.js` | `get pilotRules()` |
| `server/sim/movement.js` → WP1 | 5 hook calls (§2.6) |
| `server/game.js` | `groundNavigation` and `vehicleAction` gates; `jumpSeq`/`titanHold` whitelist; integrate skip on `p.rodeoVehicleId`; `titanfallIntent` passthrough. `vehicles.reset` gates unchanged |
| `server/protocol/snapshot.js`, `server/protocol/admission.js`, `server/index.js`, `server/lobby.js` | §3 wire, intent route, `selfFrame` send, preserveTeams, stale-client guard |
| `tools/lib/protocol-contract.mjs` | §3.3 key lists and tuple lengths |
| `public/js/engine/netclient.js` | `TITANFALL_INTENT_FIELDS`, `sendTitanfall`, `tfs` route, optional input fields (fixtures unchanged), hello contract version |
| `public/js/player-physics.js` → WP1 | 5 hook calls, `pilotRules = false`, `adoptPilot` stub |
| `public/js/boot/match-runtime.js`, `public/js/main.js` | §8.5 loader + five hooks |
| `public/js/titanfall/titanfall-client.js` (new, frozen) | registry (§8.1), CSS injection |
| stubs (new): `public/js/titanfall/pilot-client.js` → WP1; `titan-predict.js` → WP2; `titan-presentation.js`, `titan-projectile-views.js` → WP5; `titan-ui.js` → WP6; `pilot-projectile-views.js` → WP4 | `{tick, frame, onEvent, dispose}` no-ops |
| `public/js/titanfall/projectile-views.js` (new, frozen) | registry merging pilot and titan views |
| `public/js/weapons/projectiles.js` | one registry line before the `'frag'` fallback |
| `public/js/engine/vehicle-view.js` | 5 placeholder factories, walker branch calling `titanPresentation.update`, `setPredictedPose` |
| `public/js/vehicles/models/titan-placeholder.js` (new) | box rig with the frozen `animate(step, state)` convention |
| `public/js/avatar/avatar-roster.js` | one `presentation.avatarState?.(row)` hook |
| `public/js/vehicles/vehicle-fx.js`, `public/js/ui/hud-support.js` (WP0 region), `public/js/ui/conquest/icons.js`, `public/js/vehicles/voxel-model/anchors.js` | §2.3 |
| pinned tests: `tools/atlastest.mjs`, `tools/conquest-vehicles-test.mjs`, `tools/conquest-vehicle-seats-test.mjs`, `tools/map-capacity-test.mjs`, other derived-registry tests | §2.1 |
| `package.json` (hunk patch) | `titanfall:test`, `titanfall:bots:long`, the `test` chain |
| `tools/titanfall-*.mjs` | contract and mode tests (real); the other 7 as SKIP stubs |
| `BUILD-CONTRACT.md` (WP0 hunks) | wire, registries |

Acceptance (heavy jobs under the heavy lock):

```sh
node tools/titanfall-contract-test.mjs && node tools/titanfall-mode-test.mjs
npm run conquest:test && npm run bastion:test && node tools/atlastest.mjs
node tools/build-module-preload.mjs --check && npm run static:test   # orchestrator then runs preload:build
npm run modes:lobby && npm run modes:bots && npm run keybindings:test
npm test; echo "exit=$?"     # once, not piped through tail; diff against the §11.2 baseline
```

### 12.3 Parallel WPs (start after WP0 has landed; at most 3 run at once)

| WP | Scope | Owned files (new unless marked *edit*) | Acceptance |
|---|---|---|---|
| **WP1 Pilot movement** | §4: wallrun, wall-jump, double jump, slide, air strafe, clamp, grapple, stim, cloak, regen, perception, camera roll, poses | `shared/pilot-movement.js` (body), *edit* `server/sim/movement.js`, *edit* `public/js/player-physics.js`, *edit* `public/js/player/local-player.js` (every titanfall-gated branch: prediction speed/sprint/crouch, `reconcile` → `adoptPilot`, `_lockMovement`, rodeo attach, `jumpSeq`), `server/sim/titanfall/{pilot-tacticals,perception}.js`, `public/js/titanfall/{pilot-client,pilot-camera,pilot-anim}.js`, `tools/titanfall-pilot-movement-test.mjs`, `BUILD-CONTRACT.md` (movement hunk) | `node tools/titanfall-pilot-movement-test.mjs && npm run animations:test && node tools/contracts/netclient-contracts.mjs && node tools/contracts/input-contracts.mjs`; `npm run conquest:test` under the heavy lock |
| **WP2 Titan server sim** | §5.1–5.3: walker, prediction, drop, crush, auto-titan, doom/eject, rodeo, batteries, meter, damage, wreck, lifecycle bodies | `server/sim/titans.js`, `shared/vehicle-handling/titan.js`, `server/sim/titanfall/{titan-damage,rodeo,batteries,meter}.js`, `public/js/titanfall/titan-predict.js`, `tools/titanfall-titan-sim-test.mjs` | `node tools/titanfall-titan-sim-test.mjs`; `npm run conquest:test` under the heavy lock |
| **WP3 Titan weapons and abilities** | §5.4–5.5: primaries, abilities, core, smoke, melee and execution, mount 6-tuple | `shared/vehicle-handling/titan-weapons.js`, `server/sim/titanfall/{titan-projectiles,titan-abilities}.js`, *edit* `server/sim/vehicle-mounts.js` (titan branch: 6-tuple, charge/spin, toggle), *edit* `server/sim/molotov-fire.js` (profile override param), `tools/titanfall-titan-weapons-test.mjs` | `node tools/titanfall-titan-weapons-test.mjs && npm run flamethrower:test`; `npm run conquest:test` under the heavy lock |
| **WP4 AT pilot weapons** | §6, §5.6: 4 new `WEAPON_IDS`, every per-id table, archer lock, magnetic MGL, loadout fill, bastion filter, gun models, HUD icons | *edit* `shared/combatmath.js`, `shared/weapon-handling.js`, `shared/weapon-attachments.js`, `shared/avatar-hands.js`, `shared/player-hitboxes.js`, `public/js/guns/{defs,assemble,kit}.js`, `public/js/guns/models/common.js`, `public/js/audio/sfx.js`, `public/js/weapons/{effects,explosion-fx}.js` (type branches), `public/js/ui/hud-support.js` (WP4 region), `public/js/ui/bastion-armory.js`, `server/sim/vehicle-locks.js`, `public/style.css` (3 tint blocks); new `public/js/guns/models/{chargerifle,archer,thunderbolt,kraber}.js`, `server/sim/titanfall/{pilot-projectiles,loadout}.js`, `public/js/titanfall/pilot-projectile-views.js`; pinned id tests (`tools/smoke.mjs`, weapon-wheel contract, `tools/audio-mix-smoke.mjs`, viewmodel contracts); `tools/titanfall-at-weapons-test.mjs`; `BUILD-CONTRACT.md` (weapon hunk); **hunk patch for the orchestrator:** `server/modes/bastion.js:349` | `node tools/titanfall-at-weapons-test.mjs && node tools/smoke.mjs && npm run bastion:test`; then under the heavy lock `npm test; echo exit=$?` compared to the baseline; HUD icons via `node tools/render-hud-icon.mjs --weapon <id>` for the 4 ids |
| **WP5 Titan models and presentation** | §7: 5 models, IK rig, cockpit overlay, weapon fx, ability fx, drop beam, audio, capture page, budget | `public/js/vehicles/models/titan-{common,ion,scorch,northstar,ronin,legion}.js`, `public/js/titanfall/{titan-presentation,titan-ability-fx,titan-projectile-views}.js`, *edit* `public/js/vehicles/cockpit-overlay.js`, *edit* `public/js/vehicles/vehicle-fx.js` (presentations, after WP0's META line), *edit* `public/js/vehicles/vehicle-audio.js`, *edit* `public/vehicle-capture.html`, `public/js/session/vehicle-camera.js` (only if needed), `tools/titanfall-model-budget-test.mjs`, `tools/titanfall-model-capture.mjs`, `docs/design/titanfall/captures/` incl. `captures/models.md` | `node tools/titanfall-model-budget-test.mjs && npm run static:test`; `npm run graphics:test` under the heavy lock; capture under the capture lock, compare with the turnarounds |
| **WP6 Client UI, keys, loadout, audio** | §8: HUD state and DOM, loadout, contexts and controllers, walker controls, touch, mode lists, CSS, announcer, kit digits | `public/js/titanfall/{titan-ui,titan-hud-state,titan-hud,titan-loadout,titan-controller,pilot-controller,titanfall-announcer}.js`, `public/styles/titanfall.css`, *edit* `public/js/keybindings.js`, `public/js/session/vehicle-controller.js`, `public/js/engine/touch-controls.js`, `public/js/guns/weapon-state.js`, `public/js/session/weapon-wheel-controller.js`, `public/js/ui/{mode-presentation,match-hud,scoreboard,match-result-overlay,lobby-settings,lobby-roster}.js`, `public/styles/{mode-hud,touch-controls}.css`, `shared/announcer.js` (append), `public/assets/audio/announcer/titanfall/` + `sources.json`, `tools/titanfall-hud-state-test.mjs`, `docs/design/titanfall/captures/hud.md` | `node tools/titanfall-hud-state-test.mjs && npm run keybindings:test && npm run audio:test && npm run static:test`; `npm run menus:test` under the heavy lock (it launches CDP Chromium); HUD capture at 1920×1080 and 390×844 under the capture lock, compared with `hud-*.png` and `loadout.png` |
| **WP7 Bots** | §9 | *edit* `server/bots.js`, `server/bot-vehicle-driving.js`, `server/bot-vehicle-combat.js`, `server/bot-perception.js` (cloak gate only), `server/bot-titanfall.js` (new), `tools/titanfall-bots-test.mjs` | `node tools/titanfall-bots-test.mjs`; `npm run conquest:test && npm run modes:bots` under the heavy lock; re-run after WP2/3/4 merge |
| **WP8 Grunts (later)** | §10 | `server/sim/npcs.js`, `server/sim/titanfall/grunts.js`, `public/js/titanfall/npc-view.js`, `tools/titanfall-grunts-test.mjs` | after WP1–7: `npm run titanfall:test && npm test` |

### 12.4 Locks

Both locks are directories with an owner file and a stale timeout, and are always released
through a trap:

```sh
L=/Users/logge/Documents/Projects/voxel-blitz/.titan-capture.lock   # WebGL captures
# L=/Users/logge/Documents/Projects/voxel-blitz/.titan-heavy.lock   # conquest:test, npm test, menus:test, bot sims, preload:build
until mkdir "$L" 2>/dev/null; do
  age=$(( $(date +%s) - $(cut -d' ' -f2 "$L/owner" 2>/dev/null || date +%s) ))
  [ "$age" -gt 900 ] && rm -rf "$L"     # stale after 15 min
  sleep 5
done
( echo "$$ $(date +%s)" > "$L/owner"; trap 'rm -rf "$L"' EXIT; timeout 540 node tools/<job>.mjs ... )
```

A job that needs both takes the heavy lock first, then the capture lock.

### 12.5 Cross-WP interfaces (frozen by WP0; change only through the orchestrator)

| Interface | Producer | Consumers |
|---|---|---|
| `TITAN_RULES`, `TITAN_ABILITIES`, `TITAN_WEAPON_META`, `TITAN_KILL_KEYS` shapes | WP0 | WP2, WP3, WP5, WP6, WP7 |
| `TitanSystem` method list (§5.2) | WP0 stub → WP2 | WP3 (`ability`, `killRiders`, `isDoomed`), WP7 (`call`, `ownedBy`, `rodeo`) |
| `v.tfMove` block (§5.5) | WP0 | written by WP3, read by WP2 |
| `isPerceivable(observer, target, now)` | WP0 stub → WP1 | WP2 (auto-titan), WP3 (Smart Core), WP4 (archer lock), WP7 (bots) |
| `tf` / `tfs` / `tw` / `ab` / `match.titanfall` encodings | WP0 | WP1, WP5, WP6, WP7 |
| Pilot hook list (§2.6) | WP0 | WP1 |
| Projectile router kinds (`server/sim/titanfall/index.js`) | WP0 | WP3 (`titan:*`), WP4 (`archer`, `thunderbolt`, `mgl`) |
| Client projectile view registry (§6.1) | WP0 | WP4, WP5 |
| Client module contract `{tick, frame, onEvent, dispose}` | WP0 | WP1, WP2, WP5, WP6 |
| Rig `model.animate(step, state)` with titan fields in `state` | WP0 placeholder | WP5 |
| `VehicleView.setPredictedPose(id, pose)` | WP0 | WP2 |
| Policy delegate modules (`pilot-tacticals`, `rodeo`, `batteries`, `meter`, `loadout`, `play-area`) | WP0 | WP1, WP2, WP4 |
| Intent verbs (§3.7) | WP0 | WP2 (server), WP6 (client), WP7 (bots call the policy) |

### 12.6 Merge order

1. **Baseline** (§11.2) on the untouched tree.
2. **WP0**, then the orchestrator runs `preload:build` and commits WP0 (R3).
3. **WP1–WP6 in parallel, at most 3 at a time** (suggested waves: WP2 + WP4 + WP1, then WP3 + WP5 + WP6). WP2 merges before WP3.
4. **WP7 last** among WP1–7, re-tested after WP2/3/4.
5. **Integration.** Orchestrator runs `preload:build`, `npm test; echo exit=$?` under the heavy lock, the WP5 and WP6 captures, and reviews `docs/design/titanfall/captures/*.md`.
6. **WP8.**

---

## 13. Progress

Each WP appends one line when it hands off; the orchestrator merges the lines.

| WP | Status | Date | Notes (hooks requested, deviations) |
|---|---|---|---|
| WP0 | done (stages 1–3: shared + server spine, client spine, tests and acceptance; stage 4: review fixes, §13.1); awaiting orchestrator `preload:build` (only `/shared/titan-contract.js` missing from the block) | 2026-10-13 | clarifications in §13.1. Acceptance green except `build-module-preload --check`/`static:test` (preload, orchestrator). Cross-tree seeded digests of 11 mode/map cases identical to the untouched tree. `conquest-bot-aircraft-test` ("rocket passes") flakes in both trees (pre-existing). Full `npm test` not run because of the preload gate; every baseline segment was run instead. |
| WP1 | done (pilot movement: wallrun/wall-jump/double jump/slide-hop/air strafe, grapple/stim/cloak, perception, exposure + regen, client prediction + `tfs` adoption, camera roll/FOV, local/remote poses, wall footsteps) | 2026-10-13 | `titanfall-pilot-movement-test` 6177 checks (stepPilot and server/client integrators bit-equal over 2000 ticks at 60/20/120 Hz, also through prone; fixed-step client at 75/144/240 Hz with jitter bit-equal to the 60 Hz authority; one-wall surf, alley + double jump, held-jump hop, optimal strafe ≤ 11.5 m/s, rodeo jump-off, seat mid-grapple and grapple-over-cover gates); traversal, animations, netclient/input contracts, titanfall contract/mode and `conquest:test` green; preload block unchanged. Clarifications: wallrun entry `wishDot` -0.75 (spec -0.3 rejected ordinary diagonal approaches); a wall that ran its 1.75 s or was jumped off is spent until grounded or another wall; crouch drops off the wall; wallrun entry restores the double jump; double jump redirects horizontal speed to the wish and decays with the wall-jump chain (`7.4 × 0.8^n`); the 0.2 s hop window (speed kept, slide friction paused) needs a fresh press — jump held through the landing gets the normal ground blend; air strafe never raises speed past the 11 m/s soft cap; slide uphill costs 4 m/s per voxel step; grapple LOS runs from the head (+1.6) with 0.25 s grace, a pull above the chest lifts a grounded pilot (vy 4) and climbs a ledge it presses into (vy 6), anchors inside 2 m or out of the pull's sight are refused without spending a charge; client pilot prediction steps on the fixed 1/60 s (`PILOT_STEP_S`, presses between steps latched, camera/body interpolated via `pilotLerp`); `tfs` adoption never winds a current run's wall/slide timer back; a seated or riding pilot's motion and jump presses are cleared/consumed in `stepPilotTacticals` (policy `beforeTick`, before `stepRodeo` and integrate); tactical cooldowns run from activation; bots never wallrun; pilot mode mirrors the client sub-mm velocity snap. Exposure chains `beforeDamage` after WP2's. Requests: `server/modes/titanfall.js` `titanfallFields` must report `mv` grapple/wallrun/slide from `entity.pilot` (patch in WP1 scratch `requests/`), otherwise remote wallrun/slide poses never trigger; `netclient` drops `tf` from rows (pilot-client reads it from `tick`). |
| WP2 | done (titan sim: call/drop/crush, walker locomotion + slope + fluid/lava + light-voxel ram, leg crush, doom/eject/credit, auto-titan, rodeo, batteries, meter, client prediction) | 2026-10-13 | `titanfall-titan-sim-test` 305 checks (review round 1 fixed); titanfall contract 781 / mode 588 and `conquest:test` green. Clarifications: leg-crush box swept to the collider length; slope = gradient over ±`TITAN_RULES.slopeProbe` (1.5 m, new key); dash blends back at decel; new `TITAN_RULES.ram`/`dropRam`/`dropRamSpeed` (brush/wood/thin only, through `VehicleSystem.ramVoxels`); meter holds while the wreck stands; a dead owner's titan credits a stand-in (`bot:true`, kills/score forwarded to the owner); pilot-damage meter credit chains `beforeDamage` (WP1 must chain, not replace); a rider keeps an unspent battery when the titan dies. Requests: WP6 calls `titan-predict.noteDash()` on a dash and may `setControlsSource(fn)`; WP3 smoke calls `killRiders` and sets `v.tfAbility.smokeUntil` / `activeUntil.defensive` (row bits). Review round 1: deep fluid is a wall however far below the feet (a hole over a river is not a way in); a hull already in deep fluid wades on its bed until out, and a hull with no stance on its own spot settles/falls instead of hanging; riders are ghosted against their own hull (no run-over by a flick) and posed clear of voxels and inside the play area (pulled in to the rear box face, then inside the hull), leaving from a clear exit spot; titan run-over impact counts the yaw at the leg turn rate; eject starts clear of voxels (else the exit spot) with its apex under the first voxel overhead; auto-titan fire always uses the `bot:true` stand-in (no owner-view-age rewind). Prediction: rows match the trail within [rtt − 30, rtt + 60] ms (netclient ping), blends close exponentially (τ = blendMs/3), velocity reconcile from consecutive rows, snapshot hull rows are obstacles, dash refused at the press like `ability()` and one-shot, dash along `noteDash(controls)` or the last observed seated send (`app._vehicleSendAt`), sprint from `titanHold` bit 1 only. Request: WP6 sends the seated movement input right before `ability:'dash'` and calls `noteDash(thoseControls)`. |
| WP3 | done (titan primaries through the mount path, titan projectiles, every ability primitive, core meter, electric smoke, melee and execution, 6-tuple mount rows) | 2026-10-13 | `titanfall-titan-weapons-test` 326 checks (331 with the guard hook), `flamethrower:test`, titanfall sim (305, with the request below), mode 588 and AT 693 green. Sustained DPS vs a titan, measured through `mounts.fire` over 60 s from a cold trigger at 16 m: splitter 194, T-203 186 (direct; the patch adds 40), railgun 217, leadwall 209, Predator close 200 / long 224 (all within ±20 % of §5.4). Duels (primaries only, piloted, 25 m, full hp + drop shield) doom a titan in 8.8–17.7 s; SCORCH is the strongest at range (thermite patch), RONIN the weakest (12° leadwall cone). Files: `titan-weapons.js` (numbers, `TITAN_WEAPON_DPS`), `titan-abilities.js`, `titan-projectiles.js`, new `server/sim/titanfall/titan-mounts.js` (the titan branch `VehicleMounts.step/fire/rows` hand over to; railgun charge and Predator spin also work through `mounts.fire`, so the auto-titan fires them), `molotov-fire.js` (`ignite(projectile, ctx, override)`: radius, durationMs, damagePerSecond, hullDamagePerSecond, key, maxCells ≤ 64, onHullDamage). Clarifications: leadwall reload 2.6 s (2.2 s measures +24 %); a magazine cycle is (magazine − 1) × cooldown + reload; spin-up repeats after each reload; railgun fires on release (a held full charge waits), `fire` calls fire at full charge; titanHold bit 8 reloads; splitter ADS (bit 4) splits a shot into 3 beams of 1/3 damage each (same DPS, a wider hit area; measured 194 sustained, 190 first magazine) for 45 energy from the ION pool (1000, 120/s after 1 s); primary rounds leave along the mount pose (the blind-spot test pins it) while ability shots from the chest/shoulder anchors converge on the mount's aim point. Abilities: hold bits never trigger (the press is the `ability` intent); bit 2 keeps Vortex / Sword Block up and its release drops them (Vortex at least 0.3 s, 3.5 s max; Sword Block 1.5 s if never held); Thermal Shield and Gun Shield ignore the release and run their 4 s / 5 s (or until the Gun Shield breaks); cooldowns start when a guard drops. `tfMove` (damageTakenMul, speedMul, rooted, hoverVy) is synced at once whenever a guard, hover, core, phase, slow or root starts or ends (`syncMove`), and `guardTitanDamage` undoes exactly the Sword Block factor `tfMove` carries (`tfAbility.blockMul`), so the tick of a press or a timed-out block is right. VTOL hover and Flight Core hold their height (`hoverVy` 0, no rise, as §5.5; the predictor's 0 is exact). Vortex throw-back: ≤ 12 rays carrying the caught titan-side sum, kill key `splitter` (no `vortex` key in `TITAN_KILL_KEYS`); thermal / gun shield stop titan rays and projectiles that cross their sphere (`guardRay`); a shot that starts inside a guard sphere (a muzzle at point blank) meets it at once when it heads toward the guarded hull (`guardEntry`, also for pilot shots in `guardTitanDamage`). A Cluster Missile counts 6 × 80 = 480 in the vortex; a cluster at the end of its fuse in flight lets all 6 bursts go. Titan projectiles sweep pilots with point objects (review blocker: arrays made every shell contact the first enemy pilot on foot anywhere on the map); `impact` refuses a non-finite point. Phase Dash: 0.25 m `placeWalker` samples along the wish (forward if none), stops at the first wall, steps back off hull overlaps, breaks locks. Tethers: 2 charges, 4 m trigger, both trigger if placed on one spot. Firewall/arc wave/flame core follow the ground (rise ≤ 2.2 m, a taller wall stops them). Electric smoke arms after 0.5 s (WP2's auto-titan test), then `killRiders` 250/s, pilots ≤ 7 m 60/s, locks broken every 0.5 s; it sets only `smokeUntil` (the smoke bit). Melee: nearest enemy titan in a 50° cone within 4.5 m of the hulls; a doomed one whose front faces the attacker (local dot > 0.5) is executed (`doomedBy` = attacker). Core: `+dealt/4000 + dt/180`, nothing while a core runs; `core_ready` once per charge; thermite-patch and incendiary-trap hull damage credits the lighting titan (`ignite` override `onHullDamage`), and smoke and ground-line pilot damage count too. Additive event `titan_ability` `{ vehicleId, ability, ... }` for presentation (payloads in request `spec-3.8-titan-ability.patch`); deployables carry `id` and `until` and end with `deployableEnd { id, deployable }`; hitscan abilities (laser shot, power shot, vortex throw) also send a vehicle `shoot` (`ability` set, one path per ray, `vehicleWeapon` railgun / predatorClose / splitter as the stand-in look) so vehicle-fx draws their tracers. LEGION: the stock seat weapon select (`weapon` vehicle action, slot keys) goes through the Mode Switch (`selectTitanWeapon`: 0.6 s lockout, tactical cooldown). Requests (WP3 scratch `requests/`): `titan-damage-guard.patch` (WP2: `applyTitanDamage` calls `guardTitanDamage` so pilot shots into a Vortex / Thermal / Gun Shield are stopped and Sword Block is front-only; until it lands Sword Block reduces every direction and pilot shots pass guards), `titan-sim-test-edge-smoke.patch` (WP2 test: the rider-at-the-map-edge case zeroes the auto-titan's smoke, which now kills riders), `titan-move-bits.patch` (orchestrator/WP2: `tw[4]` bits `slowed` 128 / `rooted` 256 and the predictor mirrors hover speedMul, Arc Wave slow and tether root; own-titan drift 0.86 → 0.30 m in hover, 1.14 → 0.46 m on a tether), `spec-3.8-titan-ability.patch` (orchestrator: the event in §3.8), `wp5-titan-ability-presentation.txt` (WP5: draw `titan_ability` deployables, lines, melee and execution; Laser Core beam toward the aim point; Vortex / Gun / Thermal visuals sized from the server spheres). |
| WP4 | done (4 AT ids after stinger + every per-id table, archer lock, pilot projectiles: guided ARCHER, THUNDERBOLT arc orb with zaps, magnetic SKIPJACK; loadout fill; bastion armory filter; procedural gun models, HUD icons, LONGBOW beam, blast styles, pilot projectile views) | 2026-10-13 | `titanfall-at-weapons-test` 714 checks (3 pending orchestrator hunks; 723 with all four requests applied in a scratch copy); `smoke`, `bastion:test` and every `npm test` segment green (conquest:test also green; baseline had it red), row budgets (`conquest-vehicles-test`, `large-lobby-test`, `mode-lobby-smoke`) green; preload block current. Doom times vs a drop-shielded Atlas, front / rear (TITAN_ZONES.rear ×1.3, both asserted ≥ 20 s): archer 27.6 / 21.6 s, thunderbolt 26.7 / 23.1 s (10 m: 30.0 / 22.6 s), charge rifle 36.7 / 29.3 s (with the combat.js hunk), mgl 56.2 / 44.0 s, kraber 131.3 s (front only). Deviations: THUNDERBOLT contact 160 hull splash in 4 m and zap 45 per titan (spec 300/60), ARCHER 330 per hit (spec 400), both so the ≥ 20 s rule also holds from the rear; reload 3.8 s; the LONGBOW's "4 m beam" is the visual, its hit radius is 0.45; LONGBOW pilot damage 50 and titan damage 300 via a new `def.hullDamage`; the magnetic SKIPJACK turns at 12 rad/s inside 4 m; reserves count magazines (`spareMags`); LONGBOW `recoil.resetMs` 2700 (> one shot interval). Requests (WP4 scratch `requests/`): `combat-chargerifle.patch` (full-charge gate + hullDamage), `weapon-state-chargerifle.patch` (client mirror), `bastion-gadget-filter.patch` (bastion.js buy refuses exactly the four AT ids, so the stinger keeps its old server behaviour; **must land in the same change as the `WEAPON_IDS` append**: without it a hand-built Bastion buy gets the four ids, the ARCHER and THUNDERBOLT fire duds there and the KRABER/LONGBOW work as Bastion primaries), `session-arczap.patch` (forward `arcZap` to the client; without it the zap arcs are not drawn); `wp5-titan-projectile-views-nose.patch` (WP5's `titan-projectile-views.js` built rockets with a +Z nose, but ProjectileFX `_orientRocket` aims -Z along the velocity, so `cluster`/`flightRocket` flew tail-first and the `t203`/`leadwall` streaks led; the WP4 ARCHER had the same bug and is fixed, its test now uses the real `_orientRocket`). Also: titan ordnance (`t203`, `cluster`, `flightRocket`, `leadwall`) now has its own blast styles (WP5 open item); `titan-loadout.js` `LOADOUT_ICON_FILES` can point at the new `hud/{chargerifle,archer,thunderbolt,kraber}.png`. |
| WP5 | stages A, B, C done; stage A (`titan-common.js` shared rig and kit, full ION model, titan capture page and tool, budget test); stage B (Scorch/Northstar/Ronin/Legion models, cockpit overlay `titan`, weapon/ability fx, audio) open | 2026-10-13 | `titanfall-model-budget-test` 51 checks: ION 20 draws / 6050 tris; muzzle on `mountPose` at 3 aims; determinism; stance drift 0.0000 m; feet at 30 vs 120 Hz within 0.001 m. `static:test`, `graphics:test` and the titanfall contract test pass, and the preload block is current. Captures and three iteration notes are in `docs/design/titanfall/captures/` (`models.md`). Request: material.js titan palette (`accent`, `opticIon`, `energyBlue`, `opticCyan`, `opticOrange`, `opticRed`, `fuel`, `clothRed`, `blade` + `TEAM_SCHEMES.*.accent`; patch in WP5 scratch `requests/`). Models fall back to existing entries until it lands. Clarifications: the right elbow rides the mount pitch node `elbowBack` behind the pivot (the gun pitches with the forearm); titan camo is sampled at 0.72x hull metres; `vehicle-capture.html` routes `?type=titan_*` to `js/capture/titan-capture.js`. Stage B LEGION done (`titan-legion.js`, registered): 22 draws / 10568 tris; budget test green. It has a spinning `barrels` node (spin-up from mount charge100 or recoil) and a `shield` node (the Gun Shield plate, folded on the receiver's outboard face, swings in front of the gun with the defensive `guard` ramp); `elbowOut` 0 / `elbowBack` 0.9 put the receiver on the cannon axis. The capture `sheet` shot is now 2640 px wide. Notes are in `captures/models.md`. Stage B SCORCH done (`titan-scorch.js`, registered): 22 draws / 10648 tris (EAST 10658); budget test green (201 checks with ION, Northstar and Legion). It overrides the Ogre frame per titan: thigh 1.0 / shin 1.55 (leaner legs), `elbowOut` 0.85 / `elbowBack` 1.1, neck at the visor seat [0, 6.9, -0.7] (the `head` slot is the visor housing; there is no separate head), hatch hinge [0, 6.2, -1.5]. Captures `scorch-*` with 4 iteration sheets. Request: a non-emissive `thermite` orange for the launcher band (falls back to `hazard`), and a deeper `opticOrange` (0xff7418, emissive 1.6; 2.8 tone-maps to salmon) (patch in WP5 scratch `requests/material-scorch-orange.patch`). Stage B RONIN done (`titan-ronin.js`, registered): 24 draws / 7824 tris (EAST 7816); budget test green. Shared Stryder legs, `elbowBack` 1.1; extras `sword` (blade + Sword Core edge glow) and two cloth tassets. `makeRoninModel` wraps `animate`: Sword Block (`defensiveUp`) and Sword Core (`coreActive`, 0.3 s linear ramp to a low-ready left-hand pose) move the sword node from the back into the left fist, the edge glows only during the core, and the tassets swing clear of the thighs. The capture page/tool gained a `core` pose/shot. Captures `ronin-*` with 3 iteration sheets. Request: `opticRed` emissive 1.6 (3.0 tone-maps pink) and `blade` metal 0.25 / rough 0.4 (0.7 renders near-black) (`requests/material-ronin.patch`, on top of the palette patch). Stage C presentation done: `titan-presentation.js` (FX sinks via `setTitanWorld`/`init`: particles, effects group, camera shake, VehicleAudio, view; footfall/landing dust, shake and audio; dash bursts; titanfall drop beam (`titanfall_drop`) and landing slam with the rig's fist-down crouch; embark actor (pilot avatar proxy runs in, rides the left palm `anchors.palmL`, climbs into the hatch); disembark vent; doom fire and smoke; `titan_eject` blows the hatch off as its own fragment (the wreck skips it) plus a launch trail; battery-socket sparks and `rodeo_rip`/`rodeo_insert` bursts; `riderAnchor(vehicleId)` exported for rider poses), `titan-ability-fx.js` (new: vortex, thermal wall, parry, gun shield, tether, hover thrusters, core auras and ION laser beam, phase afterimages, electric smoke, railgun charge), `titan-projectile-views.js` (`t203`, `leadwall`, `cluster`, `flightRocket` flown by ProjectileFX's vehicle-shell integrator; ember/flame wakes, thermite splash, cluster sub-bursts), cockpit overlay `titan` (option 2 struts, MFDs, amber lamps; pinned to the hull frame), VehicleFx titan shots (splitter/railgun/predator tracers, railgun wake, leadwall/T-203 blast, mount kick) and the `battery` light gated by `batteryOut`, VehicleAudio titan branch (synthesized reactor/servo loops for the 2 closest titans in place of the vehicle engine loop; footfall, landing, dash, weapon and cue one-shots). `titan-common.js`: `palmL`/`seat` anchors, the battery cell anchor and light, the embark and hero-landing arm poses, `blowHatch`. `vehicle-camera.js` is unchanged (the cockpit/chase toggle already works through `views`). `titanfall-model-budget-test` 374 checks (adds presentation, cockpit, ability, projectile and VehicleFx checks; drift 0.0000 m). Captures `lineup-*`, `*-embark-strip-*`, `*-cockpit-mobile-*` and refreshed pose shots. Open: the client blast for titan projectiles falls back to the `frag` style (`effects.js`/`projectiles.js` type branches, not WP5), and leadwall pellets need a small `radius` or no explode event (WP3). Art-director round done (2026-10-13): all five models are reworked (accent bands, edged team stripe, 1.0 m roundels, lamp bezels, plate edges, hip drives and a cockpit cavity behind each hatch; Northstar and Ronin legs lengthened; Ronin tassets, sword stow and blade edge; Legion shield, Predator barrels and hazard bands; Scorch pauldrons and tanks; ION splitter and eye). Rig: stride-driven gait, low-ready carry with a fore-grip reach and a shot snap-up (muzzles stay on the mount pose), and the embark palm now tracks the kneeling cockpit. Presentation: doom flames sit on the armour tops; the cockpit gets bevel highlights, an amber fill and portrait MFD scaling; Northstar hover and Flight Core plumes alternate thrusters. The budget test passes with 384 checks (max 24 draws / 11220 tris, drift 0). `static:test` and `graphics:test` pass. Finals for both teams, plus `fallback-palette-*` sheets, are in `captures/`, with notes in `models.md`. Requests: `material-titan-r2.patch` (titan palette incl. `stripeEdge`, `bladeEdge`, `clothDark`) and `assemble-titan-camo.patch` (WP5 scratch `requests/`). Until they land, the models fall back to existing palette entries. Art-director round 2 done (2026-10-13). Values: the capture page lights the scene with the frontier IBL (`env=0` turns it off, `swatch=1` adds value cubes). The r3 palette lifts the coats and the mid-gunmetal `titanFrame`, removes the accent glow, and adds `stripeRim` (EAST stripe without its pale front edge). Camo is sampled at 0.36x. Rig: wider atlas/ogre frames with quicker strides (straight-walk pelvis excursion ≤ 0.3 m is now a budget check), RONIN straighter legs (idle knee 10.4°, checked < 12°), and a three-point hero landing (22° torso, 0.4 s hold). Doom adds a tilt, optic flicker, spark bursts and TITAN_FLAME puffs. The NORTHSTAR hover sweeps the legs back 10°. The embark palm and the pilot's ready spot moved to hip + 1.95 m, outboard of the wider legs (every embark strip reports no clips). Models: hazard diagonals and collars, knee guards and wider legs (SCORCH ±0.6/±0.8). SCORCH gets a rebuilt T-203 launcher (square breech, round barrel, thermite band, shroud). NORTHSTAR gets rebuilt legs and pods. RONIN gets lamellar pauldrons, a belt and buckle, a front tabard, cheek lamps, a 4.4 m sword stowed visibly beside the left leg, and the roundel and stripe on the pauldrons. LEGION gets pauldrons at x 1.3..2.5 and a drum-hub roundel. FX (`titan-ability-fx.js`): no translucent spheres. The ION beam is a 0.3 m core in a 1.2 m sheath with a strobe. Glows are additive flares. The LEGION Gun Shield and RONIN parry are curved hex panels. The SCORCH Flame Core and Thermal Shield are fire sheets over scorch decals. NORTHSTAR hover has cone plumes and a dust ring, and every dash has thruster streaks (plus the RONIN afterimage). Cockpit: canopy tint and vignette, struts, stepped switch panels, amber bars, a per-titan MFD accent, and a phone-portrait squeeze and stretch. Budget test 390 checks (max 24 draws / 11464 tris, drift 0). `static:test`, `graphics:test` and the titanfall contract test (781) pass. Finals for both teams are in `captures/`, iterations are in `captures/iterations/*-ad2r*`, and notes are in `models.md`. Requests (WP5 scratch `requests/`): `material-titan-r3.patch` (supersedes r2; adds `stripeRim`), `assemble-titan-camo.patch`, and `vehicle-view-doom-soot.patch` (caps the HP char at 0.35 on doomed walkers). Review round 3 (2026-10-13): the weapon arm (`mountBase`) no longer drops with the pelvis: it ignores the doom drop, follows at most `TITAN_RIG.mountFollow` 0.05 m of the gait and a quarter of the sway (the scripted weaponless poses, titanfall landing, embark kneel and wreck, still carry it down), so the muzzle stays within 0.15 m of `mountPose` while walking, sprinting and doomed (was up to 0.5 m). Doom spark bursts key off the real previous frame time (50 per 10 s at 30/60/144 Hz). Afterimages copy only cached hull voxel meshes, never the first-person cockpit overlay. The ION Laser Core beam leaves `TITAN_ABILITIES.titan_ion.core.anchor` at the presented hull pose (pulled at most 0.15 m toward the posed torso). Shader warm-up: `setTitanWorld`/`init` add hidden meshes for every ability-FX program (`TITAN_FX_WARMUP_MATERIALS`) and a hidden titan cockpit overlay (`cockpit-canopy-tint`, `cockpit-mfd-accent`); `TITAN_WARMUP_MATERIALS` is exported from `titan-presentation.js` for an optional `expectMaterials` list. Budget test 440 checks (adds walk/sprint/doomed muzzle, spark rate, laser anchor, afterimage and warm-up checks). Doom, walk and ION core captures refreshed. **Stage D (WP3 request `wp5-titan-ability-presentation`)**: new `public/js/titanfall/titan-ability-events.js` consumes `titan_ability` (tripwire / tripwireTrigger, tether / tetherTrigger, incendiaryTrap / trapIgnite, deployableEnd, firewall / arcWave / flameCore lines stepped exactly like the server's `stepLines` over the client voxels, melee / execution, phaseDash, modeSwitch) and the ability `shoot` events (laserShot / powerShot / vortexThrow rays from `event.o`; `vehicle-fx.js` `_titanAbilityShot` draws impacts only, no stand-in tracer); vortex catches; Laser Core aimed at the client copy of `anchorAim`; Vortex / Gun Shield / Thermal Shield placed and sized from the client copy of the server `guardSphere`; rig `teleport()` for the Phase Dash blink (feet follow, measured speed capped at 1.15 × dash). Budget test 496 checks (55 from a real GameEngine match fed into VehicleView/VehicleFx/presentation; tuning pinned to `ABILITY_TUNING`). Capture page `?ability=<shot>` (`public/js/capture/titan-ability-capture.js`, 19 shots, `tools/titanfall-model-capture.mjs --abilities` → `docs/design/titanfall/captures/abilities/`). **Request (orchestrator, foreign file)**: `session.js` `GAMEPLAY_EVENT_KINDS` lists no titanfall event kind, so none of them reaches the titanfall client in a live match. **Cockpits (2026-10-13):** `titan-cockpit.js` is a detailed closed cockpit view model per frame class (§7.2, concept A, notes and 120 + 16 captures in `docs/design/titanfall/cockpit/`, tool `tools/titanfall-cockpit-capture.mjs`). The budget test pins the enclosure (ray grid over every FOV, aspect ratio and sway), the viewport (38–44 %), the draws, dispose and the lamps. |
| WP6 | done (pilot + titan HUD, loadout with live titan portraits, keys, pilot/titan controllers, touch layout, announcer, scoreboard/result/lobby labels); preload block current (198 modules) | 2026-10-13 | `titanfall-hud-state-test` 26 checks, `keybindings:test`, `audio:test`, `static:test`, `menus:test`, conquest UI/deploy/vehicle-touch/digits, lobby-settings and scoreboard tests green. Captures: `tools/titanfall-hud-capture.mjs` (fixture page `titanfall-hud-capture.html`, 11 states × desktop/portrait/landscape, overlap check), 4 iterations in `docs/design/titanfall/captures/hud/`, notes `captures/hud.md`. E2E (scripted ws client, harbor): meter fill → CALL TITAN → drop → EMBARK hold → walk 4.3 m/s, sprint 6.5 m/s, dash (pips 2→1.1, 16 m/s) → abilities → disembark all work; the seated primary did not fire (WP3 note). Clarifications: the call sends `call:1` (server aims); the touch `callTitan` button is the pilot context chip (TITAN / RODEO / RIP / BATTERY); embark is a 300 ms held interact (`WALKER_CONTROLS`), a tap still disembarks; Space is titan dash only while seated; the titan HUD hides `#match-header` for its own top bar; triple-tap eject shows `PRESS n/3 EJECT` (reference said hold); announcer lines are original text spoken offline by macOS `say` (`tools/synthesize-titanfall-announcer.mjs`). Requests (WP6 scratch `requests/`): `wp1-pilot-client-cloak-nameplate.patch` (no nameplate on cloaked enemies), `wp0-meter-floor.patch` (row meter rounds 0.995 to 100, so CALL TITAN shows ~0.5 s early and the first call is refused), `wp3-seated-fire-no-shot.md`. Art-director round (2026-10-13), captures `captures/hud/iter5` (12 fixtures × 3 sizes, 36 clean). Capture tool: it renders each size's backdrop first, in one muted session on WP5's capture page (the ION cockpit behind the titan layout, a field with a LEGION behind the pilot layout), and the overlap check now also covers the touch stick, the career badge and a filled kill feed. Touch: on phones ≤430 px, DASH joins the CORE / SMOKE row and EJECT / EXIT become one-button chips, so nothing sits on the stick; BATTERY CARRIED hangs off the pilot root. Touch context chip: it reads EMBARK next to the own titan (300 ms hold, conic hold ring, `HOLD · EMBARK` chip above the meter) and EXIT while seated (a tap disembarks). Desktop titan layout: the kill feed and career badge move below and between the CORE / DOOMED tiles. Cockpit: the CSS struts are removed (WP5's 3D cockpit is the frame), and the portrait arc is at most 62vw. Gauges: percentages are floored (`pct`). Arc: a glass backing band and a numbers pill; when doomed, the hull cells are empty and the doom countdown is the red fill. AT chip: no wrapping, the `n / m` separator, dimmed ammo while drawn. Touch prompts: TAP / HOLD verbs with no key chips. Owned gauge: reads `ION · HULL` in green. Jump pips: a 2× JUMP / WALL strip (later removed: TF2 has none; the hud-state test asserts the model has no `jumps`). Loadout: portraits at the slot aspect with `contain`, three-quarter view from the weapon side; line-glyph tactical icons; primary stat bars; equal panel heights; a phone-landscape two-column layout; phone labels ≥9–10 px. Clarification: pilot weapon labels (loadout chips, AT chip) now use the def names (`WEAPONS[id].name`, as the stock ammo card does), and `TITANFALL_ITEM_LABELS` only names tacticals and fallbacks. `titanfall-hud-state-test` has 31 checks (floored gauges, EMBARK/EXIT touch context and intents, def names, HULL gauge, jump pips). `static:test`, `menus:test`, `keybindings:test`, the conquest UI / deploy / vehicle-touch / digits tests and the lobby-settings and scoreboard tests pass, and the preload block is current (198 modules). Review round 2 (2026-10-13): key clashes — deviation from §8.2 ("`overlaps()` is not changed"): `overlaps()` now also treats `pilot` as overlapping every `gameplay` action except leanLeft/leanRight, and `titan` as overlapping the walker's live gameplay keys (forward/back/left/right, sprint, fire, reload, interact, slot1–10), so a saved gameplay key wins over a titanfall default in `normalizeKeybindings` and `setKeybinding` reports the clash (defaults unchanged, no clash); `normalizeKeybindings` claims the pilot/titan keys last, so they never take another mode's key (fuzz over 20 000 prefs: every non-titanfall binding identical to the pre-WP6 module). Pilot tactical chip: shows the equipped tactical, not the selection — `tfs.tacKind` when the wire carries it, else titan-ui's `equippedTacticalLatch` (first life = default kit, a respawn equips the selection, an active grapple/stim/cloak flag or 2 charges names the kit); the alive loadout subtitle reads `APPLIES NEXT DEPLOY` (since deploy-before-spawn the live client opens the loadout only while waiting for DEPLOY; the alive model stays for the `loadout-live` capture fixture). Rodeo: no RIP prompt or rip progress on a doomed hull (`TITAN DOOMED · JUMP OFF`); the battery insert claims T / shows the touch BATTERY chip only within `TITAN_RULES.rodeo.reach` (`MOVE CLOSER` in the display slack). Announcer: WAVs decode at init (retried per frame until the AudioContext exists); a call refused by the voice neither starts its gap nor enters `played`, and a call made while decoding is spoken once loaded (≤ 2.5 s old). `titanfall-hud-state-test` 38 checks; new fixtures `rodeo-doomed`, `battery-far`, `loadout-live` (captures `captures/hud/iter6`, 15 states clean). Requests: `wp0-wire-floor-and-equipped-tactical.patch` (floors every readiness percent and dash tenths on the wire, adds `tfs[12]` equipped tactical; supersedes `wp0-meter-floor.patch`; includes the contract-test and TFS-length updates), `wp0-first-spawn-loadout.md` (the first life ignores the pre-start / stored pick).; **deploy before spawn** (2026-10-13, user request: the loadout overlaid live play): humans are held unspawned on the loadout screen at join, match start, bot takeover and after every death until DEPLOY (`{t:'titanfall', deploy: packed}`; 20 s auto-deploy fallback; bots unchanged), see §3.7 deploy gate; supersedes the playability fresh-life first-spawn path as the primary route. Tests: titanfall-mode (no spawn before deploy, first life = pick, respawn needs deploy, early deploy queued, idle timeout, mid-match join, takeover, rematch, bots, tdm/fun unchanged), hud-state (open before spawn, DEPLOY intent, countdown, queued HUD, match end), scripted ws client and muted CDP capture 1920x1080 / 390x844 |
| WP7 | done (titanfall bot layer `server/bot-titanfall.js`: seeded loadout, titan call with aimed open-ground spot and retries, embark, seated titan driving and fighting (cockpit-eye aim, railgun charge, band/strafe, separation, footprint feelers, stuck recovery + detour, edge push), abilities (def/tac/ord/core/dash/melee/smoke), doom eject, rodeo run/jump/mount/rip/hatch, battery insert, stim/cloak; pilots vs titans: AT weapons, archer lock/unguided, thunderbolt lead, 28–42 m stand-off orbit; cloak perception gate) | 2026-10-13 | `titanfall-bots-test` 31 checks (16 bots, harbor 90 s + canyon/frontier 68 s, ~11 s wall; `titanfall:bots:long` 180 s green; 11 of 12 extra seeds green), full `titanfall:test`, `static:test`, preload `--check` (current) green; `conquest:test` green (second run; the first hit the known `rocket passes (0)` aircraft flake, which also fails on the pre-WP7 bot files); `modes:bots` green. Deviations: the test runs 8v8 with a seeded 0.35–0.8 titan meter and a time limit inside the run (passive fill alone takes ~110 s); perception gate is `options.titanfall` on `observeBotTarget` (set by `pickBotThreat`/`applyMountedCombat` in titanfall only); mounted combat reads `vehicleWeaponMeta`; titan aim is solved from `titanCockpitEye`; titanfall-only `bots.js` motion tweaks: rush-travel for embark/rodeo goals, no stop-and-pop and no dance guard against a titan, ledge guard = fluid + botBounds only (no fall damage), hop when pinned or route-less, return-to-area for pilots outside botBounds; bot titans smoke a rider after `auto.smokeAfterRiderMs` + `countermeasureMs` (a 1.4 s rip can win); easy bots never rodeo. Open: titans route on the pilot ground graph (feelers/detour mitigate; no titan nav graph); `spawnSelector.expand` can place a frontier respawn ~1.5 m past botBounds (test counts it apart, bots walk in); a pilot in a carved 2-high slot has no redeploy verb in titanfall (one extra seed); kraber dominates pilot kills; no wallrun/grapple/slide for bots. Review round 1 (2026-10-13): a call spot needs a way out (`wayOut`: the bot's own titan frame stands there and walks 10 m out on one of 16 headings through `placeWalker`), so harbor's roofed gantry cells (open sky over the footprint, beams round a 6-8 m gap) are refused; a stuck hull backs off along the (yaw, heading) pair its footprint walks farthest on (`escapeHeading`: 8 yaws × 16 headings; a piloted hull takes the yaw at once, which frees one wedged between posts where every turning step is refused), and the detour after two recoveries first walks 3.5 s straight out along it; eject at doom start (§9) with the difficulty chance rolled once per hull from bot, hull and match seed (the old 250-900 ms delay outlasted most dooms: 60 % ejects, now 78 % over 18 natural matches); rodeo runs lead the back spot by the hull's velocity (≤ 0.7 s), sprint into the back, jump from 0.6 m + 0.5 s of closing speed (1.2-3 m) from behind the hull, double-jump at the apex or as soon as the pilot is against the back, hop when pinned, keep going hurt within 8 m, go to an unled flank spot (side kept for the run) when in front of a hull and to the lane behind it before the back spot, leave a hull standing > 2 m above them, and leave a stalled or timed-out titan alone 3 s instead of restarting the same run at once. Measured over 18 natural matches (seeds 11-16 × 3 maps, reviewer harness): jumps that mount 24 % → 40-44 %, mounts 28 → 35-37 (the reviewer's 8 in 9 matches was seeds 11-13; seeds 14-16 gave the old code 20); piloted titans with no target that moved < 4 m in a 10 s window 47 % → 26-34 %. `titanfall-bots-test` 43 checks: adds a piloted-titan boxed-in watch (no target, within 4 m of a 30 s window's start; it catches the old drop bug on 3 of 12 extra seeds), the harbor gantry-cell `wayOut` checks, ejects ≥ half the piloted dooms, and a scripted rodeo per map (a normal pilot that chose to rodeo a parked, ownerless enemy titan 12-16 m off mounts it from behind and from in front within 10 s); the match-level mount count is printed, not asserted (~0.6 per short run, seed-sensitive). Extra seed sweep: 11 of 12 green (the known pilot in a carved 2-high slot on frontier). Open: titans still route on the pilot graph (the escape and breakout shorten jams, they do not prevent them: harbor's pocket at 158-162,92 under the roof edge still holds a hull 30-70 s in some matches, and a route that flips between two waypoints can keep a hull pacing in place 30+ s); the titan walker can leave a hull at a yaw whose footprint fits only by a hair between posts (frontier 397.6,26,405.4, RONIN yaw 0.59: every 0.5 m move refused), WP2 territory; rodeo pilots are often leg-crushed by walking or dashing hulls (14-19 deaths per 36 short runs, as before). WP7+WP8 integration (2026-10-13): bots target attrition minions in titanfall only (WP8 request patches: `pickTarget` and `pickBotThreat` walk `engine.combatants`; a minion counts 1.4× farther for a pilot and is skipped beyond 35 m, weight 0.6 for a titan and skipped beyond 40 m; a bot titan does not spend its core on a minion); seeded 120 s 8v8 runs (seeds 0x7174-6): minion deaths by bots harbor 27 / canyon 23 / frontier 18 (pilots 12/11/11, titans 15/12/7) vs 17/10/8 with minions hidden from the bots, minion kills of bots 6 → 0, bot tick 0.58-0.65 ms avg (+0.02-0.1 ms). Root cause of the frontier RONIN "stall" (blamed on 6 friendly minions; minions were incidental): it walked nose to tail into a parked friendly auto-titan, and `TitanSystem.hullBlocked` refuses every move and turn that overlaps a hull, while `escapeHeading` and the feelers probed voxels only, so each recovery picked the heading (and a new yaw) into the parked hull (9 recoveries, 0 m). `escapeHeading` now refuses yaws and steps that overlap another hull, and the feelers feel friendly hulls (enemy titans stay the fight). `titanfall-bots-test` keeps minions on (44 checks): the eject check counts a piloted doom only if it ended in an eject or lasted ≥ 1.3 s (slowest bot reaction; executions and dooms mid-embark, outside the doom guard, cannot be ejected from), a new aggregate check that bots kill minions, minion kills printed per run, `TITANFALL_BOT_SEED` shifts the seeds; green on seeds 0-7 and `titanfall:bots:long`. Note: the harness gives alpha 4 easy + 4 hard bots and bravo 8 normal (difficulty by `i % 4`, team by `i % 2`), which is why bravo wins most test matches with or without minion targeting. |
| WP8 | done (attrition minions: `server/sim/titanfall/grunts.js` `GruntSystem` on `engine.npcs` + its own tick hook; squads of 4 per team every 16 s (first at 6 s, 30 % spectres, cap 12/team) from the team spawn centroid, lanes to midfield then the enemy side; GRUNT 100 hp rifle 1 pt, SPECTRE 200 hp smg 2 pts; fire at the nearest perceivable enemy ≤ 40 m (titans ≤ 55 m) with reaction delay, bursts and aim error, cover crouch, strafe; titans crush on contact (walker ≥ `crush.minSpeed`) and on landing; +0.02 meter per minion kill; `match.titanfall.npc`; client `public/js/titanfall/npc-view.js` on its own AvatarRoster with the stock walk/aim/flinch/burst-death paths, helmeted grunts and one-eyed spectres in team colours) | 2026-10-13 | `titanfall-grunts-test` 83 checks (bodies, scoring + meter + feed, wire rows and client/server decoder parity, killable by pilot hitscan, titan primary, ability blast, leg and drop crush, auto-titan target and owner K/D (owner alive and dead), stand-in hurt aim stays finite, minion fire and cloak gate, waves/cap/reset, 16-bot frontier 45 s (35.5 B/row, mean distance to midfield 109 → 50 m), canyon/harbor 6-bot 90 s waves (0 watchdog removals, pilot kills = pilot-on-pilot kill events); tdm/conquest empty, bastion NPC rows unchanged); full `titanfall:test`, `titanfall-bots-test` 43, `static:test`, `bastion:test`, `modes:bots` and full `npm test` (includes `conquest:test`, `titanfall:test`) green under the heavy lock; preload `--check` current. Captures `docs/design/titanfall/captures/grunts-{hero,lineup,closeup,squad,death}[-mobile].png` (`node tools/titanfall-grunts-capture.mjs`, muted CDP, capture lock). Deviations: no `server/sim/npcs.js` (everything in `grunts.js`); rows are 9-tuples `[serial, kind, team, x, y, z, yaw, hp100, flags]` (flags 1 moving, 2 firing, 4 crouched, 8 dead; ids `tfg<serial>`), ~35 B of JSON each, not 12 B; no dropship, squads appear at the team side; minion kills do not count in pilot `kills` in any phase, including auto-titan kills credited through the owner's stand-in (`tfMinionKills`, server only), and earn no career kill or XP (`server/career.js` skips `tfNpc` victims); a minion kill by a minion scores for its team; `game.js` drops minions from the player rows in titanfall only; `titans.js` auto-titan targets minions (distance ×1.6) and resolves `p:` keys through `combatants`; `titan-abilities.js` `enemyPilots` walks `combatants` (blasts, firewall, arc, Smart Core hit minions); `titanfall-at-weapons-test` and `titanfall-titan-sim-test` disable minions in their scripted arenas (`policy.grunts.enabled = false`; the rifle-rider doom check failed with minions shooting the rider). Open: bots ignore minions until the `server/bots.js` / `server/bot-vehicle-combat.js` target-pool patches land (scratch run: bots kill ~20 minions in 120 s, one 27 ms tick spike); tick cost (seeded 16-bot 180 s on/off pairs, shared machine): +0.1 to +0.6 ms average tick with grunts, p95 1.5-4.5 ms with grunts depending on machine load, grunt hook 0.03-0.09 ms avg, max 4.4 ms; watchdog removals 0 of 260 minions over six seeded 180 s runs (canyon/harbor/frontier × 2 seeds; before the fix 19-23 of 60-68 on canyon) and 0 in the test runs (squads validate a route off their drop point, `_standY` picks the level nearest the spawn, a failed or held route walks straight at the goal, and the watchdog hops, walks a random way out for 1.4 s, then re-routes); client: new minion bodies are built one per frame, minions beyond 90 m drop role details and shadows, a dead row turns dead at its snapshot time + 120 ms so the kill's hit direction and overkill reach the gore; minions rarely kill pilots (weak by design); minion bodies reuse the Rivet operator with the photo texture swapped for the neutral ceramic scan. |
| Playability | done (seated primary fires, crosshair convergence in cockpit and chase views, first-spawn loadout, ground battery insert, live titanfall HUD attach; full-loop E2E probe and one muted CDP browser smoke) | 2026-10-13 | `titanfall:test` green: contract 783, mode 593, pilot movement 6177, titan sim 309, titan weapons 340, AT 723, models 496, HUD state 38 (bots SKIP WP7); `static:test` and the client input tests (conquest vehicle client/integration, mouse flight, aircraft integration, discrete shot, aim punch, killcam) green. Root causes: the primary barrel reaches past the walker collider, so a nose against a wall made `mounts.obstructed` refuse every shot; the mount aimed parallel to the camera (cockpit eye ~1.65 m left of and ~1.4 m above the pivot); a pre-start pick never reached the first life; the insert needed the chest within 2.2 m of the back anchor (4.6–5 m up), which a pilot on the ground never reaches; `GameplayHud.buildHUD` clears `#hud` after `create`, which detached the titanfall HUD in every live match (the fixture capture page never runs it). Deviations: new titanfall-only input field `titanSight` [x, y, z, yaw, pitch] (client camera; `game.js` copies it only in titanfall, `netclient` sends it only when set) used within 24 m of the cockpit eye and 0.8 rad of the input aim, else the cockpit eye along the input aim; the primary slews to the first voxel / hull / pilot under that ray (`titanAimPoint`, 400 m); a muzzle inside voxels fires from the mount pivot; ground lines and placements (`groundAhead`, firewall, flame core) use the pilot's look yaw (`titanLookYaw`); vortex throw-back converges too; insert reach is `batteryInsertGap` (ignores up to 4 m of drop below the anchor), mirrored by the HUD prompt; a `loadout` intent applies at once to a fresh life (≤ 30 s, ≤ 2.5 m from the spawn spot, no shot, full hp, on foot) and the client resends the stored pick on the first row; titan-ui re-attaches its HUD root when it is detached. Captures: `docs/design/titanfall/captures/e2e/` (loadout, pilot HUD, meter ready, drop, landing, embark, cockpit charge/fire, chase fire). Open: harbor alpha spawn yards are walled courtyards (a titan called inside cannot walk out); the loadout subtitle still says APPLIES NEXT DEPLOY on a fresh life; at 1280×720 the loadout READY button covers the titan detail row and NORTHSTAR is clipped; the career badge overlaps the cockpit right strut; mount yaw ±0.35 rad leaves a blind spot left of the gun closer than ~4.6 m; the chase sight uses the shaken camera; WP3 balance items. |
| Integration suite | done (full `npm test` + `menus:test` + `audio-mix-smoke` vs baseline, under `.titan-heavy.lock`; no edits needed) | 2026-10-13 | `build-module-preload --check` current (198 modules). Literal `npm test; echo exit=$?` → **exit=0** (third run); per-segment run: 46/47 segments rc=0, the only red `conquest:test` = the pre-existing `conquest-bot-aircraft` "rocket passes (0)" flake (the 77 conquest sub-tests then all pass one by one; first literal run stopped on the pre-existing `bravo-tank: settles on an overwatch spot`). `titanfall:test`: contract 783, mode 593, pilot movement 6177, titan sim 309, titan weapons 340, AT 723, models 496, HUD state 38, bots 43. `menus:test` green (24/20/41). Flakes, not titanfall: `lobby-smoke` once timed out at "Room B authoritative aim lock" (5 s frame timeout, under load) and then passed 6/6 live and 6/6 on the baseline tree; `tools/audio-mix-smoke.mjs` (not in `npm test`) fails the same tail-timing checks on the baseline tree (footstep sprint cadence, debris evictions, minigun tail, intermittently mining), its roster check passes with the 20 `WEAPON_IDS`. No titanfall-caused reds. |
| Final fixer | done (final-review findings) | 2026-10-13 | Fixed: (1) `session.js` forwarded no titanfall event kind, so in a live match no drop beam, ability FX (deployables were invisible but still dealt damage), eject/battery FX, refusal toast or announcer line reached the client. New frozen `TITANFALL_EVENT_KINDS` in `titan-contract.js`, spread into `GAMEPLAY_EVENT_KINDS`, and pinned in `titanfall-contract-test` against the server's emit kinds and the real `Session._attachGameplayListeners`. A muted CDP harbor run shows `titan_ability`/drop/embark/doom/eject/core events reach `titan-ability-events`. (2) `TitanSystem.call` now refuses `enclosed` when the landed hull cannot walk 10 m out on one of 16 headings (`TitanSystem.wayOut`, which the bots now share). Harbor spawn calls: trapped titans 28/40 → 0/0, 0/16 trapping spawns; canyon and frontier have 0 trapped and about the same acceptance. HUD: NO WAY OUT · MOVE INTO THE OPEN. (3) Leg crush hits only bodies on the leading side of the hull's motion. A pilot sprinting into the back of a walking titan survives (sim-test check); before, it died with `titan_crush`. (4) A `loadout`/`deploy` re-pick no longer refills grenades or the tactical: `tfLife` records the issued counts, and `_kitUntouched` ends the fresh life after a throw or tactical use (mode-test check). (5) `groundAhead` walks the placement back to the farthest spot with a clear voxel line from the hull's chest, so tripwire, incendiary trap and tether never land through walls (weapons-test check for all three). (6) Settings rebinding: a pilot/titan key yields to another mode's action, leaving that titanfall action unbound, instead of blocking it (R1; HUD-state test updated). (7) Shader warm-up: hidden `warmupRoot()` copies of the pilot and titan projectile views (including the THUNDERBOLT arc line) hang in the titan warm-up group. In the CDP run, 0 programs linked after the match went live. Not done (minor): lazy loading of the titan presentation and projectile views in other modes (`vehicle-view.js` and `projectiles.js` still import them statically, about 150 KB gzip); disposal of the page-lifetime warm-up caches (bounded, no growth per match); third-person AT weapon and portrait warm-up; mounting a *walking* titan still needs a well-timed double jump (anchor 4.6 m up, reach 2.2 m). Tests: `titanfall:test` suites green except `titanfall-at-weapons-test` "dumb-fire misses", which is caused by the in-progress WP8 grunts (the in-progress grunt waves damage the titan; the same test passes 723/723 with `spawnSquad` stubbed). The other 46 `npm test` segments are rc=0, including `static:test` with `build-module-preload --check`. `teams:test` failed once inside the chained `npm test` on its ready-timer assertion and passed 3/3 standalone and in the segment run. |
| Client cleanup | done (deploy cover over the stock spectator/death overlays, lazy titanfall client, warm-up gaps, GPU release on leaving titanfall) | 2026-10-13 | (1) `titan-ui.js` `setDeployCover`: while the player is held for DEPLOY (layout `dead`, not `post`: staged at join, on the death loadout, queued deploy) `SpectatorHud.setSuppressed(true)` and `body[data-titanfall-deploy]` hides `#deathnote`/`#deathrecap` (titanfall.css); released when alive, at match end and on dispose. Deviation: also hidden while a DEPLOY is queued, as Conquest does for the whole match (the titanfall dead panel shows DEPLOYING IN). (2) Lazy client: `vehicle-view.js` `setWalkerPresentation()` (titan rows are skipped until installed; titan factories throw without it) and `projectiles.js` `setModeProjectileViews()` replace the static imports; `titan-presentation.js` `install()`/`uninstall()` (self-installs on evaluation for capture pages and tests), `titanfall-client.js` create() installs and dispose() uninstalls. Static boot + match-runtime graph: 0 `/js/titanfall/` modules (was 6 static, ~150 KB gzip, fetched at boot in every mode). Correction (final review): shared titanfall modules still load at boot in every mode — `titan-contract.js`, `pilot-movement.js`, `vehicle-handling/titan.js`, `titan-weapons.js` and the four pilot gun models (~96 KB raw), plus titanfall branches inside shared client files (~60 KB); see Final fixer 2. Muted CDP (tdm → conquest → titanfall → conquest): 0 `/js/titanfall/` requests before titanfall (base 6 at boot), 19 at titanfall load. Preload block unchanged (198). (3) Warm-up: client hook `prepare()` (main.js awaits `this.titanfall.prepare?.()` before `warmShaders`): `titan-ui` renders one 8×8 portrait through a match-lifetime portrait kit (one owned hull material set and tone-map pass, freed by `disposeTitanPortraits()`; before, each of the 5 portraits disposed its material and relinked); `pilot-client` hangs hidden third-person models of every pilot weapon (`PILOT_WARMUP_WEAPONS`) and a dressed GRUNT and SPECTRE under the avatar root, plus a hidden SKIPJACK round and wake (stock ProjectileFX materials) in the effects group. Programs linked after live in a 100 s harbor run with 8 bots and fast meter: base 9 (5 `titan-portrait`, tone-map quad, SKIPJACK round body and two wake sides), now 0 (grunt kit and mgl round were the last). (4) Leaving titanfall: dispose removes walker hulls from VehicleView, uninstalls the hooks, then `titanPresentation.releaseCaches()` frees the warm-up groups (cockpit overlay, ability/event/drop FX, projectile views), drops titan entries from the part geometry cache (`clearVehicleGeometryCache(matchType)`) and the titan blueprints (`forgetBlueprints`). renderer.info at the menu: after conquest 240 geometries / 31 textures / 14 programs; after titanfall base 433 / 32 / 32, now 319 / 34 / 17, unchanged after the next conquest (no growth). The rest (~80) are page-level gun model meshes (lmg, revolver, mgl; shared with other modes) and ~20 titanfall FX shape geometries held by module caches (`titan-ability-fx` shapes, event batches, drop beam). New `tools/titanfall-client-lifecycle-test.mjs` (in `titanfall:test`): static graph, hooks before/after, create/dispose ×2 with cache release, deploy cover, warm-up prep. `titanfall:test` (all 11 suites incl. AT 723 and bots 43), `static:test`, `graphics:test`, `preload:build` (no change) and the client tests (conquest vehicle client/integration/FX/destruction, mouse flight, aircraft integration/view, jeep driver, discrete shot, aim punch, killcam, projectile performance, throwable, claymore, bubble, explosion FX, grenade aim) green. Open: first-person viewmodel warm-up for kit swaps not measured (CDP digit keys did not switch weapons headless); FX shape geometry above stays page-level. |
| Rodeo feel | done (contact mount, grapple mount, client prediction, rider pose, RODEO prompt, simpler bot run) | 2026-10-13 | Mount rule (§5.2): an **airborne** enemy pilot whose body box comes within `rodeo.contact` 1.5 m of the upper hull (feet above `upperY` 2.5 m) on the back, a side or the top is grabbed by the server, with no intent needed. A pilot hooked on the hull (grapple, or released within `hookMs` 400 ms) is grabbed within `hookReach` 2.6 m from any side. The front sector never grabs; standing on the ground is never a grab (jump or T). There is one rider. The pushed-off rider gets a `pushMs` 700 ms cooldown and a leaving rider `remountMs` 900 ms; the smoke and doom rules are unchanged. Shared helpers are `rodeoContact`/`rodeoContactMounts`/`rodeoArcMounts`/`RODEO_BODY` in `shared/vehicle-handling/titan.js`. Client: LocalPlayer predicts the grab 0.3 m inside the server gap, glides to the drawn hull's rider spot, holds it for 600 ms until the server confirms, and then lets it lapse. The HUD shows RODEO · SPACE when a jump (or the current arc, or a double jump) would mount; touch shows JUMP until contact. pilot-anim has a rider leg/knee/lean pose (first and third person). Bots jump when `rodeoArcMounts` says the arc mounts. Scripted mount rates (scratch harness, walking and parked ION): behind single/double jump 25/25, side 24/24, drop from above 20/20, lob 15/15, grapple 15/15; front 0/12. Before: behind 0/25 without the intent and 52 % with it, side 0 %, grapple 27 %. Sim test: behind 18/18, side 12/12, above 8/8, grapple 10/10, front 0/18. 180 s bot sim: 9 mounts, 6 rips, 3 inserts. Tests: titan-sim 339, pilot-movement 6191, hud-state 40, bots 43; the rest of `titanfall:test` and static/bubble/fps/killcam/animations are green. Captures (muted CDP): `docs/design/titanfall/captures/rodeo/rodeo-mount-{behind,grapple}.png`. Open: the rule is generous (any jump within 1.5 m of the back or a side grabs); an unconfirmed predicted grab snaps back after 600 ms; the rider hangs about 0.4 m off the back plate and the first-person view is filled by the plate; the remote rider's legs reach about 0.4 m past its hitbox. |
| Art polish (in-game) | done (art-director pass of the titans in live matches on harbor, canyon and frontier; 2 capture→fix iterations) | 2026-10-13 | Notes and captures in `docs/design/titanfall/captures/models.md` § In-game art pass and `captures/ingame/`. (1) `titan-common.js` palette: `frame` and `gun` use `interior`, because `titanFrame` read pale sky-blue in daylight and made the titans look like toys; `energyBlue` uses `opticIon`, because ION's cells had tone-mapped to lavender. (2) SCORCH: the forearm is slung under the T-203, which sits above the arm with a grip lug, a wider thermite band and a hot muzzle lip, so the launcher reads in hero views (before, the forearm hid it). (3) LEGION: hazard cap on the drum hub; the team roundel moves to the front of the left pauldron, because the barrel cluster covers the right one in game (a deviation from the reference, which puts it on the right), and the stripe goes to the front of the right pauldron. Budget test 496 checks green (max 24 draws, 11,340 tris). Every other mode is untouched (titan model files only). Requests: titan chase camera `shared/vehicle-handling/titan.js` distance 9→~12–13 and height 3→~4.5–5 (at 9 m and 3 m the titan is unreadable); `material.js` `titanFrame` and `energyBlue` are unused by titans now, and alpha camo reads lime in desert light; at 844×390 the cockpit HUD cards cover about 40 % of the canopy. |
| Playtest fixer | done (live playtest findings, muted CDP harbor run with 8 bots, 1280×720 and 390×844) | 2026-10-13 | (1) Result screen TITANS column was 0: `TitanfallMode.resultExtras` sends a `tf` row (titan kills, loadout), which `_finishMatch` freezes before the post-phase reset. (2) Bay full: bots leave one slot per human teammate without a titan (`TitanSystem.humanReserve`, used by `call` and by the bot pre-check); the meter and toast say `BAY FULL n/cap · NEXT TITAN DOWN`. (3) Doom: for 2 s after doom (`TITAN_DOOM_GUARD`) the hp of a titan with a seated pilot (not mid-embark) is held at what the plain drain needs, so focused fire cannot skip the eject window; bots eject after a seeded 450–900 ms reaction (+≤ 400 ms) instead of on the next tick. (4) Rodeo: the rip and hatch damage (`cls: 'rodeo'`) skip the shield; bot rider smoke gets ≤ 700 ms seeded jitter; the rider camera sits 1.5 m out from the hull and 0.9 m up (`PILOT_CAMERA`, `player.rodeoHullFor`), so it is no longer inside the mesh; the rip prompt reads STAY ON. (5) Loadout click-through on death: `LOADOUT_PICK_GUARD` (650 ms arm window; a mouse already clicking in that window must move 8 px before a pick counts; DEPLOY is not guarded). (6) Bot M-DOCK 12: the bot swaps to the sidearm past 22 m, back under 14 m, and never fires it past 28 m (kills were landing at 31–86 m; now ≤ 21 m). Shotgun falloff is unchanged (R1). (7) Killfeed: no titan line when the pilot died with it (the crew kill line has it), titans named, minion-on-minion kills hidden, and at most 3 rows in the cockpit on screens ≤ 860 px tall (5 rows covered SMOKE and the kit tiles). (8) Grapple rope visual (`grapple-ropes.js`: own and remote pilots, one LineSegments). (9) Wallrun camera is pushed 0.24 m off the wall. (10) `titanAimPoint`: with no victim, a hit within 5 m of the cockpit eye converges at 40 m (`TITAN_SIGHT.minConverge/fallback`) instead of slewing the gun to its pitch stop. (11) Embark animation: HUD layout `embark` hides the pilot readouts. (12) Loadout at 1280×720: compact cards, so DEPLOY no longer covers the kit row; NORTHSTAR fits its card at ≤ 1440 px. **Deviation:** `scoreLimit` 300 → 500 (bot-only matches reached 300 in 190–320 s; now 380–490 s) and the score is clamped at the limit. Not done: drop fall visual (drop-FX owner), rodeo mount rules (rodeo owner), vortex/railgun model intrusion in the cockpit (art), ability chips under the reticle and the MGL RELOADING overlap. Tests: `titanfall:test` green (contract 791, mode 665, pilot movement 6191, titan sim 341, titan weapons 347, AT 723, models 525, HUD state 43, lifecycle 6, grunts 83, bots 44); `static:test` green; preload block current (198 modules). |
| Diegetic cockpit HUD | done (Titanfall 2 style HUD inside the first-person cockpit, §7.2) | 2026-10-13 | New `public/js/titanfall/titan-cockpit-hud.js` (pods, brow, feed screen, glass projection), hooked into `titan-cockpit.js` (+4 draws, MFDs 6 → 12 Hz, HUD programs warmed) and `titan-ui.js` (publishes the HUD model and sets `body[data-titanfall-cockpit]`). `titanfall.css` hides the DOM titan HUD and the stock crosshair, hit marker, kill feed and badge only under that flag. Capture states are in `public/js/capture/titan-cockpit-hud-capture.js`, run with `tools/titanfall-cockpit-capture.mjs --diegetic`. Concepts, captures (5 sizes × FOV 65/100 × 7 states, all titans) and notes are in `docs/design/titanfall/cockpit/diegetic/`. The budget test checks every field drawn on the pods, brow, feed and glass equals the published model, the row fallback, rate caps, glass placement and hiding, portrait and dispose. The hud-state test checks the DOM switch (cockpit only, back on sight, chase, another hull and dispose) and the CSS. Open: glass under bloom not checked in a live match; phone landscape touch buttons cover the lower pods and MFDs; radar draws no blips; the kill feed has no team colours. |
| Final fixer 2 | done (second final review: 22 findings verified; fixed or deferred below) | 2026-10-13 | Fixed: (1) **auto-deploy countdown**: after the 4 s timer the loadout chip reads `AUTO-DEPLOY IN n S` (respawn time + `TITANFALL_DEPLOY_TIMEOUT_MS`, new contract constant that `DEPLOY_RULES` uses) instead of a frozen `RESPAWN IN 0.0`; the dead HUD model carries `autoDeployIn`; a staged join shows it too. (2) **deploy clock while loading**: `TitanfallPolicy.beforeTick` holds a staged human's `respawnAt` at now until its first input (Conquest's rule), so a slow map load no longer auto-spawns the player before the screen ever opened (mode test: held past the timeout with no input, deployed one timeout after the first). (3) **eject blast**: `vehicle-destruction.js` skips a body ghosting through the destroyed hull inside its eject cloak (titanfall-only fields), so the ejecting pilot takes no damage from its own titan (sim test: 9 hp pilot survives, open sky and a roof right over the hull). (4) **rodeo dismount**: the hop off keeps the hull's velocity, and `legCrush` skips a body inside its `rodeoCooldown` for that hull, so jumping off a reversing titan lands clear (sim test, ION and NORTHSTAR); a pilot who then stands in the titan's path is still crushed ~1.4 s later. (5) refusal toast cleared by the own accepted `titanfall_drop`. (6) OOB banner counts down from `oob_warning.until`; unused `OOB_SECONDS` dropped. (7) `titanfall_ready` also fires on bay → ready. (8) one short ability name table (`TITAN_ABILITY_SHORT`) for touch faces and cockpit MFD tiles (LASER SHOT → SHOT, INCENDIARY TRAP → TRAP, …). (9) score limit single-sourced: lobby hint, score-bar fallback (`TITANFALL_SCORE_LIMIT`) and HUD fixtures read `MODE_RULES.titanfall.scoreLimit` (500 pending user confirmation); the DOM limit placeholder no longer says 300. (10) cloak hint: `5 S NEAR-INVISIBLE. BOTS SPOT YOU WITHIN 12 M OR WHEN YOU FIRE.` (11) narrow non-touch windows (≤600 px): the touch layout's placements for the AT chip, battery chip, meter dock and rodeo prompt, and no kill feed in titanfall (new `narrow` 390×844 size in `titanfall-hud-capture.mjs`; 13 overlaps before, 0 after); touch BAY FULL text wraps clear of the pouch button. (12) dead code: the slim titan cockpit fallback (~110 lines, tint shader, lamp/bevel/tint/accent builder parts) removed from `cockpit-overlay.js`, whose non-titan path is again identical to HEAD; WP0 stand-in labels `sniper`/`rocket` dropped. Already fixed by the diegetic HUD pass (verified): the MFD eject line (`X ×3 · EJECT`) and the rebound keys in the cockpit model; the portrait roof lamp/handle behind the DOM score bar (the DOM bar hides in the first-person cockpit). Deferred: (a) **client frame cost** (titanfall cockpit ~2.5× a tdm frame, minions as full avatar rigs; `scene.updateMatrixWorld` 2.2 ms/frame): needs a reduced crowd rig with a far LOD and a re-measure with the CDP probe — a dedicated perf work package, not a final fix; (b) shared titanfall modules at boot in every mode (lazy gun builders and hooks for player-physics / vehicle-audio / cockpit-overlay); the Client cleanup row is corrected; (c) first-drop 83–100 ms frame and the `titanfall-drop-streak` program linking live (warm-up key mismatch not reproducible without the live link hook); (d) touch titan MELEE / ADS buttons (§8.2: needs a touch layout pass); (e) score-limit pacing (500 fits 8v8 bot matches in 5.6–8.2 min, 4v4 and 2v2 end on time): user decision. Tests: `titanfall:test` green (mode 666, sim 355, HUD state 45), `static:test`, `menus:test`, lobby-settings, conquest destruction / vehicle-touch / deploy / deploy-ui; preload block current. Captures: `titanfall-hud-capture.mjs` desktop, portrait, landscape and narrow, 16 states each (new `deploy-idle`), no overlaps. |
| Score limit, cockpit damage, embark/disembark | done | 2026-10-13 | Scaled score limit (§1 End, `titanfallScoreLimit`, `TitanfallMode.scoreLimit`, lobby hint "First to 175-750 points"), bot soak 1v1–8v8. Cockpit damage stages and transit dressing (`titan-cockpit-fx.js`), embark/exit camera and remote vault (`titan-transit.js`, shared walk-in `titan-embark-path.js`), `VehicleView.cockpitOverride` hook (§7.2). Tests: `titanfall:test` green (mode 672, HUD state 45, models 2205 incl. the fx budget, new `titanfall-transit-test` 13), `static:test` green, preload block current. Captures: `tools/titanfall-cockpit-fx-capture.mjs`, 81 shots (ion/legion/northstar × desktop/landscape/portrait × hull 75/55/35/15, doom, boot dark/open/glass, exit). Open: the embark and exit camera moves have no browser capture in motion; on phone portrait the roof cables hang down to the brow. |

### 13.1 WP0 clarifications (simplest consistent choices; interfaces otherwise as written)

- **Rear zone** (§5.3): hull space has the nose at local −Z (`classifyHitZone`, `vehicleDirection`), so a titan's rear is local `z > +0.3·hl` and the back anchor sits at `+Z`. `titanHitZone` in `titan-damage.js` implements that; top is `y > 0.8·height`, else front/side by the dominant axis.
- **Times** on titans and pilots are engine milliseconds: `v.landsAt`, `v.landedUntil`, `v.embarkUntil`, `v.disembarkUntil`, `p.embarkUntil`, `p.ejectCloakUntil`, `p.revealUntil`, `p.pilotTac.{cloakUntil, stimUntil, readyAt}`.
- **Body fields**: carrier `p.tfBattery`, rider `p.rodeoVehicleId` / `v.riderId`, pilot movement state `p.pilot` (`createPilotState`), tactical `p.pilotTac` (`resetPilotTactical`), titan owner `v.owner` (player id string). Ability clocks live in `v.tfAbility` (written by `titan-abilities.js`), next to `v.tfMove`.
- **`tfs.s`** is the tick's `now` (ms): a tick carries no sequence number, and `now` identifies it uniquely.
- **`match.titanfall.bay[2]`** is the larger of the two per-team caps (`ceil(team size / 2)`, at least 1).
- **Frontier play area**: x, z ∈ [256, 512], centred on (384, 384) where the east–west road crosses the river; alpha spawns on the west edge, bravo on the east edge (6–24 m inside, seed `0x7174`, 4 m apart, 3 voxels of headroom, never over fluid), facing across the river.
- **Intent `call`** also accepts `1` (no aim hint); the server always re-raycasts from the eye. A `loadout` intent outside the live phase is stored only when the room already has an engine.
- **Admission `titanfall`** is the client's `TITANFALL_CONTRACT_VERSION` (integer, like `contract`); `staleTitanfallClient` refuses tabs with a missing or lower value from titanfall rooms.
- **Loadout fallbacks until WP4 lands the new ids**: `kraber → sniper`, `chargerifle | archer | thunderbolt → rocket`; grenades frag 2, pulse 1.
- **`tools/lib/protocol-contract.mjs`** keeps the file's comma-string style: `TITANFALL_PLAYER_EXTRA_KEYS = 'tf'`, `TITAN_ROW_EXTRA_KEYS = 'ab,own,tw'`, plus `TITANFALL_STATE_KEYS` and the tuple lengths.
- **Wreck lifetime** is `TITAN_WRECK_SECONDS = 12` (`server/sim/titans.js`); `TITAN_RULES` gained `fallProbe: 4` (metres of ground probe under a walker before it falls). `hullBoxes` has a 7th box (head) above the torso.
- **Physical damage** (`cls 'collision'`) reaches titans at ×1 (the titan armour table has no `collision` row).

Client spine (stage 2):

- **Client modules** export `tick(snapshot, dt)`, `frame(dt, ctx)`, `onEvent(event)`, `dispose()` and an optional `init(app, client)` that the registry calls once after `create(app)`. Module state lives at module level and `dispose()` clears it. `titanfall-client.js` fans out, in this order, to `pilot-client`, `titan-predict`, `titan-presentation`, `titan-ui`, `pilot-projectile-views` and `titan-projectile-views` (the two view modules get the lifecycle too, for their pools), and isolates each module's errors (`app.phaseError`). The frozen client object also offers `selfFrame()` (decoded `tfs`), `selfFrameRaw()`, `selfRow()`, `selfTf()` (decoded `tf`), `snapshot()`, `lockProgress()` (`tfs[11]`), `titanHold()` (OR of every module's optional `titanHold()`, masked to 6 bits) and `avatarState(row, avatar, dt)`. `tick`'s `dt` is the server-clock delta between consumed snapshots.
- **CSS**: `public/styles/titanfall.css` exists as an empty WP0 placeholder (→ WP6); the registry links it on `create` (`id="titanfall-styles"`) and removes it on `dispose`.
- **`titan-presentation.js`** exports `createModel(type, options)` (the target of the five `VEHICLE_MODEL_FACTORIES` titan entries) and `update(item, row, dt)`. The walker branch in `VehicleView.update` keeps the root upright at hull yaw, calls `update`, and skips VehicleView's generic `model.animate` call for walkers: `update` calls `item.model.animate(step, state)` itself with `state = { speed, visualSteer, grounded, wreck, tw, titan (decodeTitanRow), mounts, phase, legYaw, yaw, events }`.
- **Placeholder rig** (`public/js/vehicles/models/titan-placeholder.js`): `walker: true`, `legs: { node, left: { hip, knee }, right: { hip, knee } }`, `pelvis`, `upper`, `torso` (= `body`, the mount yaw node), `head`, `hatch`, `arms: { left, right, gun }` (right arm = mount pitch node, gun = recoil node), seat anchors under the torso, emitters `fire/cookoff/smoke/dust`, fragment tags `hatch`, `battery`, `head`, `gun`, `arm`. About 11 draws and 1.1 k triangles per titan.
- **`VehicleView.setPredictedPose(id, { x, y, z, yaw } | null)`**: a predicted walker is presented exactly at that pose (no easing) and `presentedRow(id)` returns it; wrecks ignore it; `remove` clears it.
- **Avatar hook**: `AvatarRoster` takes `presentation` (constructor option or `setPresentation(p)`) and calls `presentation.avatarState?.(row, avatar, dt)` for each live, unseated remote after the stock pose, so WP1 poses and shades the avatar itself. The titanfall client registers itself on `create` and unregisters on `dispose`.
- **Projectile views**: each view module exports `PROJECTILE_VIEWS = { [eventType]: { launch(fx, event, { local, fromSelf }) -> boolean } }`; `projectile-views.js` merges them and throws on a duplicate or on a stock type (`rocket`, `shell`, `bolt`, `glaive`, `mgl`, `bubble`, grenade types).
- **Netclient**: the admission frame always carries `titanfall: TITANFALL_CONTRACT_VERSION` next to `contract` (the `tools/contracts/netclient-contracts.mjs` admission fixtures gained the field; input fixtures are unchanged). `jumpSeq` (`& 255`) and `titanHold` (`& 63`) are sent only when finite. `tfs` frames are kept as `latestTitanfallSelf` and in `titanfallSelfFrames` (last 32), looked up with `titanfallSelfFor(serverNow)`, and delivered to `onTitanfallSelf` and `net.on('tfs', fn)`. `sendTitanfall` uses the lobby's base gaps (loadout 250, call 500, eject 250, others 100 ms).
- **`PlayerPhysics`**: `pilotRules = false`, `pilot = createPilotState()`, `pilotInput = null` (LocalPlayer may set `{ sprint, crouch, ads, stim }`), `pilotNow` (ms, for `ctx.now`). Hooks get a body view with the server field names (`x, y, z, vx, vy, vz, grounded, coyote, crouch, sprint`) and `ctx = { pilotRules, solidAt, fluidAt, vehicles, mapMeta, now }`. `pilotSpeedFor` runs after `speedScale` (as on the server); `pilotVertical` sits before stock gravity, after the client's separate jump block. `adoptPilot(frame)` returns false (WP1).
- **main.js** compares mode strings inline (`=== 'titanfall'`, `conquest || titanfall`) instead of importing `isTitanfall`/`modeHasVehicles`: three tests (`conquest-vehicle-client-test`, `boot-block-replay-test`, `throwable-client-test`) evaluate `class Game` with a fixed set of free names. The seated send adds `titanHold` only while a titanfall client exists.
- **Kill-key glyphs** not named in §2.3: `titan_crush` → `roadkill`, `rodeo` → `crash`, `electricSmoke` and `thermite` → `rocket`. `MODE_TITLES` (mode-presentation) stays WP6's.

Tests and acceptance (stage 3):

- **`titanfall-contract-test`** pins names and shapes only (export names, the TitanSystem/TitanfallPolicy method lists, topology/META/defs/weapon fields, armour, wire tuple lengths, loadout pack, kill-key names and glyphs). It never pins a stub's behaviour, so WP1–WP7 can fill the bodies without editing it. "Resolves through `vehicleDriverSeat`" uses both `vehicleDriverSeatOf` (`vehicle-defs.js`) and `vehicleDriverSeat` (`vehicle-seats.js`); `conquest-contract.js` has no driver-seat helper. Row bytes are measured over dropping, landed, piloted, damaged, doomed and wreck rows of all five titans (≈ 215 B average, 230 B max at WP0).
- **`titanfall-mode-test`** "tick stringified once": `LobbyManager` with a `sendJson` that mirrors `server/index.js`'s tick `payloadCache`, 2 members and 14 bots per map; each member's `tfs` must equal `selfFrame(memberId, tick)`. "Conquest `VEHICLE_DEFS` deep-equal those built from `VEHICLE_TYPE_IDS`" is checked structurally (conquest keys first; rules/handling equal the defs; no titan data in a conquest def; weapon order unchanged); the byte-exact comparison against the untouched tree is the orchestrator's cross-tree digest (§11.2). The in-process A/B digest seeds `Math.random`, pins `Date.now` and drives four scripted pilots for 480 ticks on frontier (vehicle entry included).
- **§1.1 "titan destroyed during embark"** is now implemented in `TitanSystem.destroyDoomed`: a crew member whose `embarkUntil` is still running is released through `onExit` (hatch → roof → rear) before `destroy`, so no `titan_doom` crew death follows. WP2 keeps it.
- **Spawn avoidance** filters the pool points (35 m); `SpawnSelector.expand` then adds points up to 9 m per axis from the clear ones, so a chosen spawn is at least ≈ 22 m from an enemy titan. The filtered pool is a new array, so `expand` is recomputed for each respawn while a hazard is near (not cached); cheap at 16 players.

Review fixes (stage 4):

- **Dropping rows are non-solid on the client**: `solidHull` also treats `tw[5] === 1` as non-solid (§2.5); no new row key. The contract test asserts `solidHull(row) === solidHull(v)` for dropping titans and that landed rows are solid.
- **Projectile router owns expiry** (§5.4): new frozen exports `explodeTitanProjectile` / `explodePilotProjectile(system, projectile, ctx)` (stub no-ops); `index.js` also exports `tfOutsideWorld(p, ctx)`. The contract test pins the router's removal at fuse, outside the world, at a non-finite position and for unknown kinds.
- **Doom encoding**: `tw[3]` rounds up (1..70 while doomed); `decodeTitanRow().doomed` also reads phase 6.
- **Bots stay in the frontier play area** (§9): `TitanfallPolicy.botBounds()` + `BotManager.roamSpot` / `outsideBotBounds` (other modes: same `randSpot` call and rng draws). Frontier spawns are also filtered to the surface-navigation region holding most of the rectangle (`openGround` in `play-area.js`): two seeded spawns sat in walled 5–8-node pockets that the spawn selector kept choosing, trapping bots. 12 bots × 180 s on frontier: 29 kills, 0 `restricted`, 0 samples outside the rectangle (before: 13 of 17 deaths `restricted`). Harbor is unchanged (same kills by weapon as before the fix).
- **Eject apex** sits half a metre under the OOB ceiling (`SY + ceilingPad − 0.5`, feet), so a normal eject no longer warns on harbor/canyon (apex 43.23 with SY 40; frontier stays capped by `ejectVyMax`).

---

## 14. Ashfall (dedicated Attrition map)

`ashfall` ("Ashfall", 224 × 40 × 176 voxels, ground at y 14) is the first map built only for
Titanfall: a ruined smelter colony at dusk inside a red canyon. It is titanfall-only
(`MAP_MODE_COMPATIBILITY.ashfall = ['titanfall']`, `MAP_PLAYER_LIMITS.ashfall = 16`, 8 v 8) and
plays on the whole map with `mapMeta.spawns.tdm` (16 street-level spawns per team, `fun` = both
pools, no S&D sites, no power-up pads). Design references and the choice between three ImageGen
layouts are in `docs/design/titanfall/map/` (README there); real renders in `captures/`.

**Symmetry.** The map is point-symmetric about its centre, (x, z) → (223 − x, 175 − z). MILITIA
(alpha) stages in the west yard (blue roofs, cyan floods), IMC (bravo) in the east yard (orange
roofs, amber floods). Only the team colours in the two yards differ from the rotation.

**Layout** (west/north half; the other half is its rotation):

| Band | Cells | Role |
|---|---|---|
| Team yard | x 3–29 | barracks against the back wall, canopies over the inner spawn column, a drop ring; titan drop zone |
| Ring road | x 30–43 | 14 m titan lane round the colony, split by a median (x 36–37) into two 6 m carriageways |
| Boulevard | z 20–33 | 14 m titan lane along the north edge, median at z 26–27; pipeline and sheds behind it |
| Block band | z 34–69 | Hab Stack (x 44–69: two 5/4-storey towers and a wallrun alley), Smelter Hall (x 83–104: tall hall, mezzanine at y + 12, smokestack), Relay block (x 119–132 + spiral-stair relay tower at (137, 41), decks at y + 12 and y + 20), Tenements (x 155–178: an L of alleys) |
| Streets | x 70–81, 142–153 (12 m), centre street x 106–117 | titan lanes from the boulevards to the arena |
| Approach yards | z 70–105 | containers, tanks and barriers; the blast-wall slalom and the ore dock (below) |
| Cooling Ring | disc r 30 about (112, 88) | broken cooling-tower ring (r 18–20, up to 20 m tall), four diagonal 9 m breaches, The Pour in the middle, a toppled segment and a wrecked hauler on the cardinals |

**Signature features** (`shared/world/ashfall-layout.js` holds every number below):

- **Medians.** A centre line of derailed slag-pot cars (6–7 × 2 m, 7 m tall, slag crust on top):
  four on each boulevard (z 26–27) and two on each ring road (x 36–37), plus two burnt-out runabouts
  (4 × 2 m) per ring road. They split each lane into two 6 m carriageways a titan can sidestep
  between.
- **Lane cover** (`ASHFALL_LANE_COVER`, 26 pieces, 13 per half). Each piece fills one whole 6 m
  carriageway for 5 m and is 7–9 m tall: a 2-high container stack with a third box or a crate row
  on top, a concrete revetment with a hazard band and lifting lugs, or an ingot pile. They alternate
  between the two carriageways (boulevard: 3 outer, 4 inner; ring road: 3 on the yard side, 3 on the
  inner side), so a titan weaves across the median and no line along a boulevard or ring road stays
  clear at titan eye height (y + 6.6) for more than 48 m (`ASHFALL_MAX_SIGHTLINE`; longest 47 m).
  Before this pass every carriageway was clear end to end (136 m ring roads, 164 m boulevards).
- **The Pour** (arena centre). A molten slag pool (radius 7 m, one voxel above the floor) inside a
  2 m crucible rim (radius 8.5 m: no titan steps it, a titan's eye and any pilot on a rise see the
  slag over it), fed by two ladles and two glowing pour columns under the Pour Line. Two 2 m slag
  runners (x 111–112) cut the inner ring floor from the rim, run through 2 m culverts in the ring
  wall and end in slag pits just outside it (radius 20.2–21.5 m), one voxel deep. Slag burns
  everyone: a pilot loses 24 hp in 0.5 s, a titan 36 hp. No slag lies within 20 m of a spawn.
- **Hull-down cover in the arena** (`ASHFALL_ARENA_COVER`). Six ingot stacks (5 × 3 m, 5 m tall:
  titan chest height), three per half, at radius 25–26 m beside the breach mouths and the hauler
  (150°, 210° and 300° about the centre, and their rotation), at least 4 m from the toppled segment
  and the hauler so a titan walks round them. 88 of the outer band's 1288 cells (r 21.5–29.5) are
  solid at chest height (before: 4).
- **Blast-wall slalom** (each approach yard). Four staggered walls, 8 m long, 8 m tall and 1 m thick,
  in two rows 3 m apart (z 73 and z 77), with a yellow hazard band at 5 m and work lamps on top.
  Pilots chain wallruns wall to wall (a single wall jump clears 4 m, so the gap leaves a metre);
  titans use them as hull cover.
- **Billboard gantry** (`ASHFALL_BILLBOARDS`, the west cross street x 70–81 and its rotation). A
  steel beam at y + 17 between the Hab annex and Smelter Hall parapets carries three boards
  (1 m thick, 8 m long, y + 11 to y + 16, 10 m of street under them) at x 71, 75 and 79. A pilot
  crosses the street facade (x 68) → board → board → board → facade (x 83) on gaps of 2, 3, 3 and 3 m.
- **Ore dock** (x 50–68, z 84–95). A 3 m titan platform with ramps west (z 85–91) and south
  (x 56–62) and a battery cache nook. It is the highest ground a titan reaches.
- **The high line** (deck at y + 12, 11 m titan clearance). Yard towers at (26, 56) and (26, 119)
  with gantries over the ring road (decks z 54–58 and 117–121, x 30–44); the Pour Line, a steel walkway
  (x 110–113, z 44–131) over both centre streets and the arena, on bents at z 52 and 77 (and their
  rotation) with ladders up the arena legs (x 106 and 117, z 77); the toppled ladle crane, whose jib
  (x 137–139, z 9–37) falls from 17 m on the outskirts to 13 m at the relay deck across the
  boulevard. With the band skybridges this is one level a pilot crosses the map on.
- **Spawn overlooks.** The high line ends over each team yard, so nothing up there may look into a
  spawn at close range. The ring-road gantries are enclosed galleries (5 m deck, walls to y + 15, a
  roof at y + 16, a 3 m walk inside, a 3 m door into the outer block at x 45). The yard towers are
  clad in corrugated steel on the yard side and both flanks from y + 5 up to the deck, and the deck
  carries a 3 m booth open only toward the gallery. The outer blocks' top-floor windows above a
  gallery are shuttered, and a 5 m roof billboard over each gallery door (x 45 and 178, z 52–60,
  and their rotation) stands at the roof edge so no pilot walks off a block roof onto a gallery roof. Before this pass all 16 spawns
  of a yard were in sight of the tower decks at 6–19 m. Every spot a pilot walks to with its feet
  8 m or more over the street now has no line of sight to any spawn within 24 m (1776 spot-spawn
  pairs checked). The outer blocks' facades and roofs still face the yard from 25 m or more,
  across the ring road.
- **Rodeo perches** (6, three per half: ring road, boulevard, arena north). 3 × 3 steel decks 7 m up
  (a titan's back is 4.6–5 m), 1.5 m from the nearest cell a titan walks; a sprint-jump off the deck
  reaches 7.4 m. A closed two-wide stair inside a scaffold frame leads up (posts every other tread,
  a level top rail at y + 8), so no titan climbs beside the treads.
- **Battery caches** (4, two per half: the ore dock nook (66.5, 90.5) and a rack just inside the
  Hab annex's street door (66.5, 61.5)). Each holds a titan battery from match start; it never
  expires, dropped batteries never evict it, and it refills 60 s after it is taken
  (`BATTERY_CACHE_MS`). Both are on the street route graph (the annex cache used to sit at
  (59.5, 61.5) in the Hab alley, a 28-node island the graph does not reach), so bots fetch them
  (below).

**Titans vs pilots.** Titans walk the yards, ring roads, boulevards, streets, approach yards, the dock
tops and the arena (every frame stands on every lane centre line and walks every breach; every lane
has 9 m of open headroom). No frame climbs above the dock height onto the pilot layer. Pilots own
the rest: the alleys are 4 m wide but gated by low skybridges (4 m clearance) at every mouth, building
doors are 3 × 3, so no hull gets in. The high line and the band skybridges let a pilot cross the
whole map above the titans; alley and street faces are unbroken for wallruns (16–32 m). The slalom
gap (3 m) and the billboard gaps (2–3 m) leave at least a metre to a chained wallrun's reach
(`PILOT_RULES`: 4 m on a wall jump, 6 m with the double jump), so a small retune of the pilot rules
does not break them.

**Navigation.** `navigationFloor` is the street level (the flat ground graph shared by bot pilots,
grunts and auto-titans). The pilot-only spaces are dead ends for that graph (1-high kerbs and crate
rows across alleys and ground floors), so bots never route a titan into them. `mapMeta.climbs`
(one polyline per perch: stair foot → stair top → deck centre), `mapMeta.ladders` (the Pour Line
legs) and `mapMeta.batteryCaches` come from the layout. In `server/bot-navigation.js`
(`climbStep`), a goal on a perch deck routes to its stair foot and then walks the stair; a body on a
stair walks it down before it routes anywhere else. Fluid in the floor cell (the slag runners) is not
floor, so routes go round the runners, and the bot's strafe and step guard never step into them. On a
map with climbs, a goal standing on a raised spot (the dock, a ramp) routes to the nearest floor node
instead of leaving the bot standing.

Bot pilots and perches (`server/bot-titanfall.js`): a pilot out of combat for 3 s rolls every 5 s
(30 %) for the nearest free perch whose stair foot is within 48 m, gives up a trip after 30 s, holds
the deck 8–12 s as overwatch facing the lane (no titan calls, no hull evasion up there), and leaps
onto an enemy titan whose back is within 11 m. After the hold it walks back down the stair (up to
8 s). A pilot that got onto a deck or the stair top some other way (chasing a foe up the stair) is
sent down the nearest stair too: within 3 m of a stair top or deck centre, it has no street route
off. (The hold was 10–16 s; with a slow climb over a stair tread shot out in a fight, one 180 s
soak saw a bot stay within 2 m for more than 20 s.)

Bot pilots and caches: a pilot out of combat for 3 s rolls every 4 s for the nearest stocked cache
within 40 m while a friendly titan's shield is below its cap, one pilot per cache, and gives up a
trip after 25 s. The pickup is automatic; the bot then carries the battery to the titan and
inserts it like a ripped one. Scripted in `titanfall-bots-test.mjs`: pickup after 2.2 s, insert
after 8.0 s.

**Dressing.** `LARGE_MAP_LIGHTS.ashfall`: 58 lamps (8 team floods, 20 warm lanterns, 30 bollard work
lamps on the Pour Line rails, blast-wall tops, perch decks, yard tower decks and the docks; a light's
optional `y` raises it off the street; the arena-north perch lamp stands on the deck corner at
(88, 59), away from x 86, the only deck column in line with the Smelter Hall breach). Signs
(`map-signs.js`): SMELTER 4 twice, painted (`COLORS.ashfall`, soot and warm cream), and THE POUR lit
on both sides of the crucible rim, 2.8 × 1.1 m at (109.5, y + 1.6, 80) and its rotation. Dusk
palette (`map-atmosphere.js`): dark violet sky top `#2c2452`, a low western sun, ambient 0.54, red
mesas, drifting embers. Skyline: six smelter stacks (6–8 m wide, 70–92 m tall) and three cooling
towers (58–62 m tall) between the canyon rim and the mesas, mostly north-west and south-east, in
sooted brick and stained concrete (`stacks`, `towers`, `industry`; `map-backdrop.js` now draws a
terrain backdrop's industry with the industrial builder). The arena floor is an asphalt ring road
with a dashed line at radius 25.5 m around concrete.

Blocks (`dressBlocks`, hash-varied, after every bridge, breach and ruin has cut its openings): on
each block with two or more storeys a 7 m sign board in the wall row over the street storey; under
floor-1 and floor-2 window pairs a balcony (a 2 m ledge with a rail, 2 in 10) or an AC unit (2 in
10), only where the air is open and two cells clear of a titan lane; about one window pane in
seven is shuttered (corrugated steel). Inside, from floor 1 up, crates, lockers and machinery stand
against about 28 % of the wall cells, never in a stair run or in front of an opening. Lobby preview
`public/assets/maps/ashfall.webp` (1440 × 900, from the current hero render).

**Files.** `shared/world/ashfall-layout.js` (constants, spawn anchors, landmarks, lane rects, medians,
lane cover, arena cover, the Pour, slalom, billboards, docks, high line, perches, caches, ladders),
`shared/world/flatmap-ashfall.js` (generator), `shared/world/metadata.js` (climbs, ladders, battery caches), registry rows in
`shared/modes.js`, `shared/world/dimensions.js`, `templates.js`, `shared/lobby-limits.js`,
`shared/world/large-map-lights.js`, `public/js/engine/map-signs.js`, `map-atmosphere.js`,
`map-backdrop.js` (terrain industry), `server/sim/titanfall/batteries.js` (map caches),
`server/bot-navigation.js`, `server/bots.js`, `server/bot-titanfall.js`, `shared/map-capture-shots.js`
(overview, hero, the-pour, pour-line, slalom, crane, yard-tower, perch, ring-road, billboards,
cooling-ring, militia-yard, hab-alley, skybridge, relay-nest, boulevard). Concept sheets and
captures: `docs/design/titanfall/map/`.

**Tests.** `tools/ashfall-map-test.mjs` (in `maps:test`, 126 checks): registry and capacity; exact
point symmetry; 16 + 16 spawns at street level ≥ 4 m apart with ground routes to the arena and the
enemy yard; titan drop points in every yard, lane and the arena; a titan flood per chassis (5 frames,
4 headings, real step and slope rules) that reaches every lane end to end round the lane cover,
both approach yards, the dock tops and both arena halves and never climbs above the docks; 9 m lane
headroom (cover pieces aside); the longest clear line along a boulevard or ring road at titan eye
height (≤ 48 m); chest-height cover in the arena's outer band; no frame inside any alley gate,
low-storey ground floor, the barracks or a Smelter Hall doorway; wallrun walls; a pilot walk search
(stairs and ladders) up to every yard tower, gantry, Pour Line section, the crane jib, the high
bridges, every perch deck and every cache; no raised spot it reaches sees into a spawn within 24 m;
the slalom gap and the billboard gaps each a metre inside a single wall jump under the live
`PILOT_RULES` (and 10 m of street under the boards), and a simulated wall-to-wall slalom (4/4 walls
in each half); perch height, leap reach, spawn distance and a closed stair underside; slag in the
pool and runners, the runners' culverts and pits, the pool seen over the rim from a titan's eye,
slag burns pilots and titans; caches on the street route graph, holding, refilling and never
evicted; every lamp stands. `large-map-light-test.mjs` covers Ashfall's 58 lamps (stems, late join,
3 draw calls, 194 faces of a 200 budget). Also in `atlastest.mjs` (id, name, compatibility,
fingerprint, spawn counts), `map-capacity-test.mjs`, `titanfall-contract-test.mjs`,
`titanfall-mode-test.mjs` (lobby), `titanfall-bots-test.mjs` (8 v 8 bot run with "bots climb to the
rodeo perches"; a scripted perch scenario: a bot walks up the ring-road stair and leaps onto a
titan parked below; a scripted cache scenario), `powerup-test.mjs` and `chaos-test.mjs` (excluded
maps). 180 s bot soaks (seeds 1–6): 15–17 drops, 8–13 dooms, 6–8 ejects, 2–6 rodeo mounts per run,
8–14 bots on a perch deck per run, no stalls, no boxed titans, no bot pilot killed by slag (grunts
still walk into the slag 1–9 times a run).

---

## Appendix A. Review log (rev 2)

All 73 review items were checked against the working tree. Every claim checked held
(`VEHICLE_RULES`/`VEHICLE_HANDLING` built over `VEHICLE_TYPE_IDS` at vehicle-defs L310-311;
unguarded `VEHICLE_WEAPONS[...]` reads in vehicle-mounts and projectiles L1147; `S`/`M` topology
shape at conquest-contract L150-151; `return` inside the advance and projectile loops; game.js
L169/L375 passing conquest spawns; seats-test L34 deep-equal; `damageModel.step` at vehicles.js
L1677; `airborneRules` reads `policy.fallDamage`; `_keyboardAction` first-match; `kitWeaponRole`;
`ammoCopy` over `WEAPON_IDS`; `viewFor` per member; hud-support L47/L61 iterate META;
`launch()` frag fallback; static match-runtime barrel; frozen `MODE_RULES` with no `deepFreeze`;
`canMove` at game.js L621; `destroy(..., { crewKey })`; lobby-settings L57; bastion.js:349 and
bastion-armory.js:26; `candidate()` aircraft filter; `TICK_RATE_HZ = 60`; `supportsKillcam`
excludes titanfall). They were applied as written, except for these partial or adapted fixes:

| Item | Decision | Why |
|---|---|---|
| gameplay: frontier spawns — "or drop frontier from v1" | kept frontier, added a play area with its own spawns (§1) | the binding decisions name frontier as a titanfall map. The decision "spawns via `mapMeta.spawns.tdm`" still holds for harbor and canyon; frontier deviates because its tdm bases are ≈580 m apart. **Flagged for the lead.** |
| gameplay: slow passive fill to 0.0045/s | **rejected**; kept 0.009/s | binding decision ("0.9 %/s → ~110 s"). The titan flood is handled instead by capacity 16 and the per-team bay cap (½ team). Pilot-damage meter credit added as the decisions planned. |
| gameplay: scale `scoreLimit` with team size | **adopted after the bot soak** (2026-10-13): 175 (1v1) to 750 (8v8), `titanfallScoreLimit` | the fixed 300 / 500 ended 8v8 in 5.5–8 min, and small teams never reached it before the 12 min timer; the soak showed that the score rate grows with the team size. |
| gameplay: restore the eject chute | not restored; eject is a ballistic `markLaunched` launch without canopy | the review's integration item shows a chute needs `airRules`, which collides with double jump and wall-jump. No fall damage makes the canopy unnecessary. Deviation from the decisions' "chute" wording, **flagged for the lead**. |
| gameplay: eject blast | removed from v1 | review asked to decide; TF2 makes it a kit option. |
| gameplay: walker crush via rig foot positions | adapted: server leg boxes + speed > 1.5 m/s | the server has no rig; leg hull boxes approximate the feet. |
| integration vs plan: rodeo hatch hook | took the plan's `combat.js` `riderHit` hook; for allies shooting the rider, used a 0.3 m rider offset outside the hull box instead of a new rider hitbox | no extra hook; distance ordering already prefers the nearer body. |
| integration vs plan: auto-titan fire | took the integration fix (TitanSystem calls `mounts.fire` with the owner entity) and dropped the plan's `operatorFor` hook in vehicle-mounts | avoids a WP0 edit in a WP3-owned file. |
| integration: `_keyboardAction` context-aware vs capture-phase controllers | capture-phase controllers; `input.js` unchanged | smaller surface, same mechanism as `VehicleController`. |
| integration: `viewFor` shallow copy vs separate frame | separate `tfs` frame | keeps the tick cache intact; a shallow copy still busts `payloadCache`. |
| integration: pinned conquest digest | replaced by baseline script + structural invariants + in-process A/B | both lenses agreed; a golden digest drifts with the live session. |
| plan: WP5 edits `vehicle-view.js` walker body | moved to `titan-presentation.js` via a WP0 hook | one owner per hot file. |
| plan: WP2 edits `vehicle-damage.js` and `server/modes/titanfall.js` | replaced by WP0 hook lines and WP-owned delegate modules | one writer per file. |
| gameplay: thunderbolt values in decisions ("each tick") | interpreted as a 0.25 s zap interval | "each tick" at 60 Hz gives 3600 dps. |
| gameplay: hatch multiplier 2.5 from decisions | changed to ×4 on the weapon's own armour class plus a 150 dps cap | the decisions' "x2.5 'at'" makes a rifle ≈ 790 dps against titans. The intent (hatch shots hurt a lot more than hull shots) is kept. **Flagged for the lead.** |
