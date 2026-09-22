# Career progression

Progression is a single unlock tree plus a per-weapon mastery ladder. A node
opens automatically when its requirements are complete **and** its parent is
already open. Nothing is bought, there is no currency, cosmetics never change
combat stats, and nobody loses anything they own.

`shared/career.js` owns the tree and is imported unchanged by both the client
and the server; the mastery tiers, badges and score formulas live in
`shared/career-mastery.js` and are re-exported through it. `CAREER_CATALOG`
remains the flat, pre-order view of the same frozen array (`=== PROGRESSION_TREE`,
108 nodes), so every consumer that only asks "does this ID exist" keeps working.
Every number the ARMORY shows comes from `careerView` plus these shared modules.

## XP curve

```
xpForLevel(L) = L <= 51 ? (L - 1)^2 * 100 : 250000 + (L - 51) * 9900
careerLevel(xp) = xp < 250000 ? 1 + floor(sqrt(xp / 100)) : 51 + floor((xp - 250000) / 9900)
legacyCareerLevel(xp) = 1 + floor(sqrt(xp / 100))        // frozen old curve, for the intro card and tests
serviceStars(level) = max(0, floor((level - 100) / 5))    // derived, never stored
```

The curve is identical to the old one through level 51 (250,000 XP) and then
costs a flat 9,900 XP per level. There is no level cap: content runs to level
100 and every 5 levels after that adds a display-only service star (`★n` on the
HUD badge, strip and menu card).

| Level | XP | At about 3,000 XP/h |
| ---: | ---: | ---: |
| 10 | 8,100 | ~3 h |
| 25 | 57,600 | ~19 h |
| 50 | 240,100 | ~80 h |
| 75 | 487,600 | ~160 h |
| 100 | 735,100 | ~245 h (was 980,100) |

### Veteran level jump

For every L ≥ 52 the new threshold is at or below the old `(L - 1)^2 * 100`, so
`careerLevel(xp) >= legacyCareerLevel(xp)` for every XP value and no level ever
goes down. Players above 250,000 XP move **up**: for example 980,100 XP was level
100 and is now level 124. The ARMORY's one-time intro card says so
("Your level was recalculated: 100 → 124.") whenever `legacyCareerLevel` and
`careerLevel` differ.

## Branches and gate kinds

| id | Name | Track | Contents |
| --- | --- | --- | --- |
| `weapons` | WEAPONS | level | Optics, grips and weapon rewards |
| `character` | CHARACTER | level | Operator skins and death signatures |
| `presentation` | PRESENTATION | level | HUD, callsigns, reticles, nameplates and sound kits |
| `mastery` | MASTERY | mastery | Weapon mastery and arsenal rewards |

Every node has a career-level gate (`level`) and **at most one** extra gate:

- `masteryTier` (+ `weapon`): complete when `masteryScore(mastery[weapon]) >= tier.score`;
- `combatScore: n`: complete when `combatScore(profile) >= n`;
- `arsenal: {tier, count}`: complete when at least `count` weapons have reached `tier`.

The old `masteryKills` and `pvpKills` fields are gone. Module load throws when:

1. a node with an extra gate is not a leaf, or its `level` differs from its
   parent's level (1 for a root), so each reward has exactly one real gate;
2. a `masteryTier` is unknown or its `weapon` is not in `WEAPON_IDS`;
3. a kind misses its required data (`theme`: color; `nameplate`: badge and color;
   `reticle`: one of dot, chevron, halo, gap, bracket, diamond; `sound`: audio;
   `attachment`: slot and part; `weaponSkin`: weapon);
4. `amber` or `rookie` stop being level-1 roots, or a mastery-branch node is not a
   level-1 root;
5. a node is declared before its parent, below its parent's level or outside its
   parent's branch (unchanged topology rules).

## Mastery

| Tier | Numeral | Score | Color |
| --- | --- | ---: | --- |
| INITIATED | I | 50 | #c98a4b |
| SPECIALIST | II | 250 | #c8d2dc |
| ELITE | III | 1,000 | #ffd23f |
| MASTER | IV | 2,500 | #b98cff |

```
masteryScore(row) = row.kills + floor(row.botKills / 4)
combatScore(profile) = pvpKills + floor(max(0, kills - pvpKills) / 4)
```

Human kills count 1. Bot and Bastion kills count ¼, up to 40 per weapon per
match. Training, team kills and self-kills do not count. The ARMORY prints this
sentence from the constants (`MASTERY_RULES_TEXT`). `mastery[w].kills` stays
human-only, so StatTrak and the welcome frame's `mastery` are unchanged; bot
kills are stored beside it as `mastery[w].botKills` (only when above 0).

Every one of the 13 weapons pays out at every tier. Badges come from
`MASTERY_BADGES` (rifle RAPTOR, smg HORNET, shotgun M-DOCK, sniper LONGSHOT, lmg
BASTION, revolver IRONCLAD, longarc LONGARC, rocket HAVOC, lance VOLTLANCE, knife
PICK, minigun FURNACE, flamethrower FIRESTORM, glaive RIPTIDE):

| id | Kind | Gate | Reward |
| --- | --- | --- | --- |
| `mastery-<w>-1` | nameplate | INITIATED | `<BADGE> I` badge |
| `mastery-<w>-2` | nameplate | SPECIALIST | `<BADGE> II` badge |
| `mastery-<w>-3` | nameplate | ELITE | `<BADGE> III` badge |
| `mastery-<w>-master` | callsign | MASTER | `<Badge> Master` |
| `armorer` | callsign | 5 weapons at SPECIALIST | Armorer |
| `nameplate-arsenal` | nameplate | 13 weapons at ELITE | ARSENAL badge |
| `armsmaster` | callsign | 13 weapons at MASTER | Armsmaster |

That is 52 per-weapon and 3 arsenal nodes: 55 in the mastery branch. The three
legacy weapon skins are also mastery rewards (see the WEAPONS table).

## Level-track nodes

53 nodes: 12 WEAPONS, 5 CHARACTER, 36 PRESENTATION. Something unlocks at least
every 3 levels up to 50 and at least every 5 levels up to 100.

### WEAPONS

| Node | id | Kind | Level | Parent | Extra gate |
| --- | --- | --- | ---: | --- | --- |
| Reflex sight | `optic-reflex` | optic | 2 | — | — |
| Angled foregrip | `grip-angled` | grip | 5 | Reflex sight | — |
| StatTrak counter | `counter-stattrak` | counter | 10 | Angled foregrip | — |
| 2x tube sight | `optic-scope2` | optic | 8 | Reflex sight | — |
| Vertical foregrip | `grip-vertical` | grip | 12 | 2x tube sight | — |
| Overdrive | `rifle-overdrive` | rifle skin | 12 | Vertical foregrip | RAPTOR SPECIALIST (250) |
| 4x combat scope | `optic-scope4` | optic | 18 | Vertical foregrip | — |
| Precision grip | `grip-precision` | grip | 26 | 4x combat scope | — |
| 10x precision scope | `optic-scope10` | optic | 34 | Precision grip | — |
| High Noon | `revolver-high-noon` | revolver skin | 34 | 10x precision scope | IRONCLAD ELITE (1,000) |
| CY-9 cyber scope | `optic-cyber` | optic | 44 | 10x precision scope | — |
| Foundry | `minigun-foundry` | minigun skin | 44 | CY-9 cyber scope | FURNACE MASTER (2,500) |

### CHARACTER

| Node | id | Kind | Level | Parent | Extra gate |
| --- | --- | --- | ---: | --- | --- |
| Ignition | `ignition` | death signature | 5 | — | — |
| Salvager | `salvager` | operator skin | 25 | Ignition | — |
| Circuit | `circuit` | death signature | 25 | Ignition | — |
| Sovereign | `sovereign` | death signature | 75 | Circuit | — |
| Revenant | `revenant` | operator skin | 25 | Salvager | combat score 10,000 |

### PRESENTATION

| Node | id | Kind | Level | Parent |
| --- | --- | --- | ---: | --- |
| Amber | `amber` | HUD theme | 1 | — |
| Arctic | `arctic` | HUD theme | 2 | Amber |
| Dot reticle | `reticle-dot` | reticle | 3 | Amber |
| Orchid | `orchid` | HUD theme | 3 | Arctic |
| Mint | `mint` | HUD theme | 4 | Orchid |
| Rookie | `rookie` | callsign | 1 | — |
| Pathfinder | `pathfinder` | callsign | 2 | Rookie |
| Vanguard | `vanguard` | callsign | 4 | Pathfinder |
| Veteran | `veteran` | callsign | 6 | Vanguard |
| Chevron reticle | `reticle-chevron` | reticle | 9 | Dot reticle |
| Arcade | `arcade` | sound kit | 10 | Veteran |
| Ranger nameplate | `nameplate-ranger` | nameplate | 14 | Veteran |
| Aegis nameplate | `nameplate-aegis` | nameplate | 30 | Ranger nameplate |
| High Noon | `high-noon` | sound kit | 35 | Arcade |
| Halo reticle | `reticle-halo` | reticle | 40 | Chevron reticle |
| Overdrive | `overdrive` | sound kit | 50 | High Noon |
| Eclipse nameplate | `nameplate-eclipse` | nameplate | 60 | Aegis nameplate |
| Tactician | `tactician` | callsign | 16 | Veteran |
| Ember | `ember` | HUD theme | 21 | Mint |
| Gap reticle | `reticle-gap` | reticle | 23 | Chevron reticle |
| Operator | `operator` | callsign | 28 | Tactician |
| Bulwark nameplate | `nameplate-bulwark` | nameplate | 32 | Aegis nameplate |
| Jade | `jade` | HUD theme | 37 | Ember |
| Sentinel | `sentinel` | callsign | 42 | Operator |
| Bracket reticle | `reticle-bracket` | reticle | 47 | Gap reticle |
| Warden | `warden` | callsign | 53 | Sentinel |
| Cobalt | `cobalt` | HUD theme | 56 | Jade |
| Onyx nameplate | `nameplate-onyx` | nameplate | 64 | Eclipse nameplate |
| Commander | `commander` | callsign | 68 | Warden |
| Crimson | `crimson` | HUD theme | 72 | Cobalt |
| Diamond reticle | `reticle-diamond` | reticle | 80 | Bracket reticle |
| Legend | `legend` | callsign | 85 | Commander |
| Solar | `solar` | HUD theme | 90 | Crimson |
| Centurion nameplate | `nameplate-centurion` | nameplate | 95 | Onyx nameplate |
| Immortal | `immortal` | callsign | 100 | Legend |
| Zenith nameplate | `nameplate-zenith` | nameplate | 100 | Centurion nameplate |

Amber and Rookie are the presentation roots and the equipment a new career
starts with. The 19 new presentation nodes are data or CSS only: titles, themes,
nameplates and three CSS reticles (gap, bracket, diamond). Preview PNGs stay 5
and sound kits stay 3 (9 cues).

## Legacy compatibility

All 34 pre-redesign ids (`LEGACY_NODE_IDS`) keep their id, kind, branch, parent
and weapon; no row maps to a new id. `CATALOG_ALIASES = {}` exists for future
renames and `validateProfile` resolves aliases before its unknown-id check.

| id | Old gate | New gate |
| --- | --- | --- |
| rifle-overdrive | L15 + 250 rifle kills | L12 + rifle score 250 |
| revolver-high-noon | L35 + 1,000 revolver kills | L34 + score 1,000 |
| minigun-foundry | L75 + 5,000 minigun kills | L44 + score 2,500 |
| revenant | L100 + 10,000 PvP kills | L25 + combat score 10,000 |
| the other 30 | unchanged | unchanged |

**Monotonic gates.** Every gate only goes down: `careerLevel >= legacyCareerLevel`,
every level gate is at or below its old value, `masteryScore >= kills` and
`combatScore >= pvpKills`. Parents are unchanged and owned nodes bypass the
parent gate. So everything a profile was eligible for before stays eligible, and
the anti-forgery re-check of gates on owned nodes can never re-lock a legitimate
reward. New grants from lowered gates arrive on the next profile read through
`reconcileCareerUnlocks` (file: `CareerService.profile()`; PostgreSQL: the
write-back on `owned` growth). `career-gates-test` pins a frozen copy of the old
gates and checks 2,000 seeded random legacy profiles against the old rules.

## Grants

Nodes are declared parent-before-child, which lets `reconcileCareerUnlocks` grant
a whole chain in one forward pass with one shared gate context per pass. A grant
is permanent. Gates still apply to owned nodes, so a forged `owned` entry cannot
equip an unearned reward: `careerItemState` reports it as `status: 'locked'`.

`careerItemState` also returns `status` (`equipped`, `owned`, `next` or
`locked`), `gate` (`level`, `mastery`, `combat` or `arsenal`) and `xpToGo`
(`xpForLevel(item.level) - xp`, at least 0). `upcomingUnlocks`, `masteryTracks`
and `nextGoals` feed the ARMORY's goals, journey and mastery ladder.

## Rewards and bots

`CAREER_REWARDS` is unchanged and pays XP only: human kill 25, bot kill 10,
active minute 20, bomb plant or defuse 75, completed match 100, win 50
(`CAREER_REWARD_RULES` holds the UI labels). A non-team kill of a bot or Bastion
NPC with a real weapon also adds `mastery[w].botKills`, capped at 40 per weapon
per match; the cap resets when the post-match phase ends. It is kept per
profile and match engine, so reconnecting to the same match keeps the count.
Fun/FFA and Chaos never enter a post phase, so there the cap window is 10
minutes of match time. `pvpKills` and the
human `kills` in mastery rows are untouched by bots.

Career credits are gone from rewards, counters, profile, HTTP and UI. A legacy
`credits` field is accepted on read and dropped; the PostgreSQL `credits` column
stays in the schema and is never read or written. The migration list stays at
versions 1-4: the redesign needs no schema change. In-match economies (S&D, TTT,
Chaos, Bastion, `WEAPON_PRICES`) are a separate system and are untouched.

## HTTP

`GET /api/career`, `POST /api/career/equip`, `POST /api/career/attachments` and
the compatibility alias `POST /api/career/purchase` are one `CAREER_ROUTES`
table. Equip takes an owned, unlocked node, or `{item:'standard', slot, weapon?}`
to reset a slot; `theme` resets to `amber` and `title` to `rookie`. `equipOnly`
is accepted and ignored, the `X-VB-Career: 1` same-origin header and the
2,048-byte body cap stay, and responses are `no-store`.

## Runtime

- Reticles: the ARMORY applies `careerView.equipped.reticle` to
  `:root[data-reticle]` in the menu. In a match the crosshair follows the
  authoritative self snapshot row's `cosmetics.reticle` instead (the idle poll
  only re-tints the accent there), and leaving the match resets and reapplies
  the menu loadout. The old note that reticles "never cross the wire" was wrong:
  `reticle` rides the snapshot `cosmetics` object like every wire slot.
- Themes set `--career-accent`; HUD themes and callsigns are local only.
- Nameplates ride the snapshot `cosmetics.nameplate` and render as a
  `.vb-sb-nameplate` badge in the scoreboard name cell.
- `public/js/cosmetics/local-presentation.js` owns `applyTheme`, `applyReticle`,
  `applyLocalPresentation` and `resetLocalPresentation`.

## Validation

- `npm run career:test`: tree invariants and gate rules (`progression-tree-test`),
  legacy gates and no re-lock (`career-gates-test`), curve pins, bot mastery cap
  and HTTP (`career-test`), persistence and tier boundaries
  (`cosmetics-career-test`), the ARMORY model, DOM contract and previews
  (`armory-model-test`, `armory-dom-contract-test`, `armory-preview-test`).
- `npm run weapons:handling:test`: attachment compatibility and gating.
- `npm run accounts:test`: guest-to-account transfer of a legacy profile.
- `node tools/cosmetics-career-test.mjs --postgres` and `npm run postgres:test`:
  real migration, jsonb `botKills` round trip and restart (needs Docker).
- Browser (CDP, muted): `npm run armory:browser`, `npm run career:browser`,
  `npm run models:browser`.
