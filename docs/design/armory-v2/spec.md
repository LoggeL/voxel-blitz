# Armory & Progression Redesign: Final Implementable Spec

Design spec for the armory and progression redesign (branch `redesign/armory-progression`).

**Base proposal.** This spec starts from Proposal 2 because it has the highest summed judge total: P2 87, P1 81, P3 79. It grafts in:
- from P3: the XP curve, the bot-weighted mastery score, the legacy-gate test, `CATALOG_ALIASES`, the slot table, and the store split with seen-flag seeding;
- from P1: goals, mastery tiers that pay out on all 13 weapons, dense level-track content, and the no-re-lock brute-force test.

Every must-fix from the three judgments is applied.

---

## 0. Decisions taken (these close every open question)

| # | Question | Decision |
|---|---|---|
| D1 | XP curve | Identical to today through level 51. After 51, a flat 9,900 XP per level. Service stars are derived and never stored. |
| D2 | Level cap | No cap. Content runs to level 100. After 100 there is 1 service star per 5 levels, display only. |
| D3 | Stacked level+kill gates | Removed. A reward with a kill or mastery gate has `level` equal to its parent's level, so each reward has one real gate. |
| D4 | Bots and mastery | Bot and Bastion NPC kills count toward mastery at 1/4 weight, capped at 40 bot kills per weapon per match. Training, self-kills and team kills pay nothing. `mastery[w].kills` stays human-only, so StatTrak and `masteryView` do not change. |
| D5 | Mastery tiers | `MASTERY_TIERS` move to shared data at 50 / 250 / 1,000 / 2,500 score. Every tier grants a reward on every one of the 13 weapons. |
| D6 | Revenant | Stays a long chase. The gate becomes combat score ≥ 10,000, where combat score = PvP kills + ¼ of bot kills. Its level drops to its parent's level, 25. |
| D7 | New art-bearing kinds | None: no generated finishes, colorways, new signatures, new sounds or new character skins. New content is titles, themes, nameplates and 3 CSS reticles, all data-only or CSS. |
| D8 | NEW flags | Kept per viewer in localStorage, seeded with `owned ∩ LEGACY_NODE_IDS`. No DB migration and no `/api/career/seen` route. |
| D9 | Post-match XP frame | Deferred to a follow-up (see §4.6). The "since your last visit" line on the menu card covers the reward moment in this ship. |
| D10 | Two dialogs | Merged. The attachment workshop becomes the WEAPONS tab of the single `#career-shop` ARMORY dialog. `#workshop-open` and `dialog#weapon-customization` are removed. |
| D11 | HTTP contract | Unchanged. `/api/career/purchase` alias, `equipOnly` accepted and ignored, `X-VB-Career: 1`, 2,048-byte cap, no-store. There is no new route. |
| D12 | Gate re-check on owned nodes | Kept (anti-forgery). Because every gate only goes down, it cannot re-lock anything a player legitimately earned. |
| D13 | Theme/title reset | `{item:'standard', slot:'theme'}` resets to `amber`; `slot:'title'` resets to `rookie`. |
| D14 | Wire/snapshot | Unchanged shape. New nameplate ids ride the existing `nameplate` slot. `weaponSkins` is not trimmed. |
| D15 | Attachment saving | Save-on-select: 250 ms debounce, latest wins, optimistic with rollback on 4xx or 503. |
| D16 | Reticle bug | `:root[data-reticle]` is set from the authoritative self snapshot row in a match, and from `careerView.equipped` in the menu. |
| D17 | Gamepad, letter shortcuts, Q/E tab switching | Deferred or not added. Only arrow keys, Home, End, Enter and Space. |
| D18 | Idle poll | Stays at 15 s while the dialog is closed and the tab is visible. It updates only the menu card, nav badge, HUD badge and local presentation, never the hidden dialog DOM. |
| D19 | `bastion-armory.js` and the in-match S&D buy "armory" | Untouched. No new id uses the `buy-` prefix. |
| D20 | Veteran level jump | Applies only above 250,000 XP. For example, 980,100 XP goes from level 100 to level 124. It is explained in a one-time intro card, `docs/progression.md` and the commit/release note. The legacy formula lives in shared code as `legacyCareerLevel` and is tested. |

---

## 1. Vision

The ARMORY is one screen for everything you earn and wear. It has four tabs:
- **LOADOUT** shows every slot you can equip, what is in it now, who else can see it, and a live preview.
- **WEAPONS** puts one weapon's skin, optic, grip, kill counter, handling and mastery together.
- **PROGRESS** shows your next three goals, a level journey, and an unlock tree drawn as a real tree.
- **MASTERY** shows a ladder for each of the 13 weapons.

Something unlocks at least every 3 levels up to 50 and at least every 5 levels up to 100. Service stars continue after 100. Every weapon has four mastery tiers that pay out, and bot and PvE play advance them, so solo players are never locked out. Nothing is bought. Cosmetics never change combat stats. Nobody loses anything they own. Every number on screen comes from `careerView` plus `shared/career.js`.

---

## 2. Progression rules

### 2.1 Invariants kept
- All 34 existing node ids keep their `kind`, `branch`, `parent` and `weapon`. Declaration order stays topological. `amber` and `rookie` stay the level-1 roots and the starting owned set.
- Grants are permanent. Gates are re-checked on owned nodes.
- There is no currency. `CAREER_REWARDS` stays exactly: `kill 25, botKill 10, objective 75, activeMinute 20, match 100, victory 50`, XP only.
- `EQUIPPABLE_SLOTS` value and order stay `['characterSkin','signature','sound','reticle','nameplate']`.
- The wire loadout shape does not change.
- The attachment ownership gate stays in `server/weapon-loadouts.js`, never in `shared/weapon-attachments.js`.
- Load-time topology checks stay: parent declared first, same branch, `parent.level <= child.level`.

### 2.2 XP curve
```
xpForLevel(L) = L <= 51 ? (L-1)^2 * 100 : 250000 + (L-51) * 9900
careerLevel(xp): x = max(0, finite(xp) ? xp : 0)
  x < 250000  -> 1 + floor(sqrt(x/100))
  x >= 250000 -> 51 + floor((x - 250000) / 9900)
legacyCareerLevel(xp) = 1 + floor(sqrt(max(0,xp)/100))   // frozen copy, for the intro card and tests
serviceStars(level) = max(0, floor((level - 100) / 5))
```
- The curve is continuous at level 51 (250,000 XP).
- For L ≥ 52 the new threshold is at or below the old `(L-1)^2*100`. At L52 it is 259,900 against 260,100, and the gap grows. So `careerLevel(xp) >= legacyCareerLevel(xp)` for every xp.
- The pins still hold: 0→1, 99→1, 100→2, 400→3, and a level-34 fixture is still `(34-1)^2*100`.

Pacing at about 3,000 XP/h:

| Level | XP | Time |
|---|---:|---:|
| 10 | 8,100 | ~3 h |
| 25 | 57,600 | ~19 h |
| 50 | 240,100 | ~80 h |
| 75 | 487,600 | ~160 h |
| 100 | 735,100 | ~245 h (was 980,100) |

### 2.3 Branches and gate kinds
`PROGRESSION_BRANCHES` has 4 entries in this order. Each entry gets a `track` field.

| id | name | track | detail |
|---|---|---|---|
| weapons | WEAPONS | level | Optics, grips and weapon rewards. |
| character | CHARACTER | level | Operator skins and death signatures. |
| presentation | PRESENTATION | level | HUD, callsigns, reticles, nameplates and sound kits. |
| mastery | MASTERY | mastery | Weapon mastery and arsenal rewards. |

Every node has `level` (the career-level gate, always present) and at most ONE extra gate:
- `masteryTier: 'initiated'|'specialist'|'elite'|'master'` plus `weapon`. Complete when `masteryScore(profile.mastery[weapon]) >= tier.score`.
- `combatScore: n`. Complete when `combatScore(profile) >= n`.
- `arsenal: {tier, count}`. Complete when `arsenalCount(profile, tier) >= count`.

The fields `masteryKills` and `pvpKills` are removed from the catalog.

**Load-time rules.** These are enforced and throw at module load. The first two replace today's "only leaves may carry masteryKills/pvpKills":
1. A node with an extra gate is a leaf. Its `level` equals its parent's level, or 1 for a root.
2. Any `masteryTier` must exist in `MASTERY_TIERS`. A node with `masteryTier` needs `weapon ∈ WEAPON_IDS`.
3. Required fields per kind:

   | Kind | Required fields |
   |---|---|
   | theme | `color` |
   | nameplate | `badge`, `color` |
   | reticle | `reticle ∈ {dot, chevron, halo, gap, bracket, diamond}` |
   | sound | `audio` |
   | attachment | `slot` and `part` |
   | weaponSkin | `weapon` |

4. `amber` and `rookie` are level-1 roots.
5. Mastery-branch nodes are roots with `level: 1`.

### 2.4 Mastery (new file `shared/career-mastery.js`, re-exported by `shared/career.js`)
```
MASTERY_TIERS = [
  {id:'initiated',  name:'INITIATED',  numeral:'I',   score:50,   color:'#c98a4b'},
  {id:'specialist', name:'SPECIALIST', numeral:'II',  score:250,  color:'#c8d2dc'},
  {id:'elite',      name:'ELITE',      numeral:'III', score:1000, color:'#ffd23f'},
  {id:'master',     name:'MASTER',     numeral:'IV',  score:2500, color:'#b98cff'} ]
BOT_MASTERY_DIVISOR = 4
BOT_MASTERY_CAP_PER_MATCH = 40      // bot kills per weapon per match that count
COMBAT_SCORE_BOT_DIVISOR = 4
masteryScore(row) = (row?.kills||0) + floor((row?.botKills||0) / 4)
combatScore(profile) = (profile.pvpKills||0) + floor(max(0,(profile.kills||0)-(profile.pvpKills||0)) / 4)
arsenalCount(profile, tierId) = # of WEAPON_IDS with masteryScore >= tier(tierId).score
MASTERY_BADGES = { rifle:'RAPTOR', smg:'HORNET', shotgun:'M-DOCK', sniper:'LONGSHOT', lmg:'BASTION',
  revolver:'IRONCLAD', longarc:'LONGARC', rocket:'HAVOC', lance:'VOLTLANCE', knife:'PICK',
  minigun:'FURNACE', flamethrower:'FIRESTORM', glaive:'RIPTIDE' }
```
- `masteryScore >= kills` and `combatScore >= pvpKills` always hold. This is what makes every legacy kill gate monotonic (see §2.8).
- About 10 human kills per match reaches INITIATED in about 5 matches and MASTER in about 250.
- A bot-only lobby gives at most 10 score per weapon per match.

### 2.5 Full node table

Notation: `[L]` = legacy node (new values in bold where they changed). `[N]` = new node. `→ x` names the parent. All `[N]` presentation nodes are appended at the END of the presentation section in the row order below, so their parents are always declared first.

**WEAPONS** (12 nodes, all legacy)

| id | kind | level | parent | extra gate |
|---|---|---:|---|---|
| optic-reflex [L] | attachment optic/reflex | 2 | — | — |
| grip-angled [L] | attachment grip/angled | 5 | optic-reflex | — |
| counter-stattrak [L] | attachment counter/stattrak | 10 | grip-angled | — |
| optic-scope2 [L] | attachment optic/scope2 | 8 | optic-reflex | — |
| grip-vertical [L] | attachment grip/vertical | 12 | optic-scope2 | — |
| rifle-overdrive [L] | weaponSkin rifle | **12** (was 15) | grip-vertical | **masteryTier specialist (250)**; was 250 rifle PvP kills |
| optic-scope4 [L] | attachment optic/scope4 | 18 | grip-vertical | — |
| grip-precision [L] | attachment grip/precision | 26 | optic-scope4 | — |
| optic-scope10 [L] | attachment optic/scope10 | 34 | grip-precision | — |
| revolver-high-noon [L] | weaponSkin revolver | **34** (was 35) | optic-scope10 | **masteryTier elite (1,000)**; was 1,000 kills |
| optic-cyber [L] | attachment optic/cyber | 44 | optic-scope10 | — |
| minigun-foundry [L] | weaponSkin minigun | **44** (was 75) | optic-cyber | **masteryTier master (2,500)**; was 5,000 kills |

**CHARACTER** (5 nodes, all legacy)

| id | kind | level | parent | extra gate |
|---|---|---:|---|---|
| ignition [L] | signature | 5 | — | — |
| salvager [L] | characterSkin | 25 | ignition | — |
| circuit [L] | signature | 25 | ignition | — |
| sovereign [L] | signature | 75 | circuit | — |
| revenant [L] | characterSkin | **25** (was 100) | salvager | **combatScore 10,000**; was 10,000 pvpKills |

**PRESENTATION** (17 legacy nodes unchanged, plus 19 new)

Legacy, unchanged:

| id | kind | level | parent |
|---|---|---:|---|
| amber | theme | 1 | — |
| arctic | theme | 2 | amber |
| reticle-dot | reticle | 3 | amber |
| orchid | theme | 3 | arctic |
| mint | theme | 4 | orchid |
| rookie | title | 1 | — |
| pathfinder | title | 2 | rookie |
| vanguard | title | 4 | pathfinder |
| veteran | title | 6 | vanguard |
| reticle-chevron | reticle | 9 | reticle-dot |
| arcade | sound | 10 | veteran |
| nameplate-ranger | nameplate | 14 | veteran |
| nameplate-aegis | nameplate | 30 | nameplate-ranger |
| high-noon | sound | 35 | arcade |
| reticle-halo | reticle | 40 | reticle-chevron |
| overdrive | sound | 50 | high-noon |
| nameplate-eclipse | nameplate | 60 | nameplate-aegis |

New (declared in this order):

| id | kind | level | parent | data |
|---|---|---:|---|---|
| tactician | title | 16 | veteran | color #9fb4c8, rarity uncommon |
| ember | theme | 21 | mint | color #ff7a3d |
| reticle-gap | reticle | 23 | reticle-chevron | reticle 'gap', color #b8f0ff |
| operator | title | 28 | tactician | color #8fd0ff |
| nameplate-bulwark | nameplate | 32 | nameplate-aegis | badge BULWARK, color #a0b8d0, rarity rare |
| jade | theme | 37 | ember | color #3ddc97 |
| sentinel | title | 42 | operator | color #77b6ff |
| reticle-bracket | reticle | 47 | reticle-gap | reticle 'bracket', color #ffc27a |
| warden | title | 53 | sentinel | color #7fd4a0, rarity epic |
| cobalt | theme | 56 | jade | color #5a8cff |
| nameplate-onyx | nameplate | 64 | nameplate-eclipse | badge ONYX, color #8a8f9c, rarity epic |
| commander | title | 68 | warden | color #ffb347 |
| crimson | theme | 72 | cobalt | color #ff5a5a |
| reticle-diamond | reticle | 80 | reticle-bracket | reticle 'diamond', color #ff9ad5 |
| legend | title | 85 | commander | color #dca0ff, rarity legendary |
| solar | theme | 90 | crimson | color #ffd23f |
| nameplate-centurion | nameplate | 95 | nameplate-onyx | badge CENTURION, color #e0c080 |
| immortal | title | 100 | legend | color #f4d77a, rarity legendary |
| nameplate-zenith | nameplate | 100 | nameplate-centurion | badge ZENITH, color #fff1a8, rarity legendary |

Detail copy:
- Titles: "A new callsign on your career badge."
- Themes: "<Color> HUD and reticle."
- Reticles: one-sentence shape description.
- Nameplates: "A <color> badge beside your name on the scoreboard."

**MASTERY** (55 nodes, generated in `shared/career.js` from `WEAPON_IDS`, `MASTERY_BADGES` and `MASTERY_TIERS`. All are roots, `level: 1`, `branch: 'mastery'`)

For each weapon `w` in `WEAPON_IDS` order, with badge `B = MASTERY_BADGES[w]` and title-case name `Bt`:

| id | kind | gate | data |
|---|---|---|---|
| `mastery-${w}-1` | nameplate | masteryTier initiated | badge `${B} I`, color #c98a4b, name `${Bt} I nameplate` |
| `mastery-${w}-2` | nameplate | masteryTier specialist | badge `${B} II`, color #c8d2dc, name `${Bt} II nameplate` |
| `mastery-${w}-3` | nameplate | masteryTier elite | badge `${B} III`, color #ffd23f, name `${Bt} III nameplate` |
| `mastery-${w}-master` | title | masteryTier master | color #b98cff, name `${Bt} Master` |

Every mastery node also carries `weapon: w` and `collection: 'Mastery'`.

Arsenal (appended after the weapons, roots, level 1):

| id | kind | gate | data |
|---|---|---|---|
| armorer | title | arsenal {specialist, 5} | color #c8d2dc, name "Armorer" |
| nameplate-arsenal | nameplate | arsenal {elite, 13} | badge ARSENAL, color #ffd23f |
| armsmaster | title | arsenal {master, 13} | color #b98cff, name "Armsmaster", rarity legendary |

**Totals.**
- Level-track nodes (weapons + character + presentation): 12 + 5 + 36 = **53**.
- Mastery branch: **55**.
- Catalog: **108**.
- Preview PNGs stay 5. Sound kits stay 3 (9 cues).

Copy changes to legacy nodes (text only):
- rifle-overdrive: "Violet reactor rails and carbon armor for your rifle. A rifle Specialist mastery reward."
- revolver-high-noon: "... An Elite revolver mastery reward."
- minigun-foundry: "... A Master minigun mastery reward."
- revenant: "Obsidian armor and violet energy channels for players with 10,000 combat score."

### 2.6 Level track (level-gated rewards only)

| L | Rewards |
|---|---|
| 1 | amber, rookie |
| 2 | arctic, pathfinder, optic-reflex |
| 3 | orchid, reticle-dot |
| 4 | mint, vanguard |
| 5 | grip-angled, ignition |
| 6 | veteran |
| 8 | optic-scope2 |
| 9 | reticle-chevron |
| 10 | counter-stattrak, arcade |
| 12 | grip-vertical |
| 14 | nameplate-ranger |
| 16 | tactician |
| 18 | optic-scope4 |
| 21 | ember |
| 23 | reticle-gap |
| 25 | salvager, circuit |
| 26 | grip-precision |
| 28 | operator |
| 30 | nameplate-aegis |
| 32 | nameplate-bulwark |
| 34 | optic-scope10 |
| 35 | high-noon |
| 37 | jade |
| 40 | reticle-halo |
| 42 | sentinel |
| 44 | optic-cyber |
| 47 | reticle-bracket |
| 50 | overdrive |
| 53 | warden |
| 56 | cobalt |
| 60 | nameplate-eclipse |
| 64 | nameplate-onyx |
| 68 | commander |
| 72 | crimson |
| 75 | sovereign |
| 80 | reticle-diamond |
| 85 | legend |
| 90 | solar |
| 95 | nameplate-centurion |
| 100 | immortal, nameplate-zenith |
| 105+ | ★ service star every 5 levels |

The largest gap is 3 levels up to 50 and 5 levels up to 100. After level 6, a new title arrives every 12–17 levels, so the badge title keeps changing.

### 2.7 Reward values
- `CAREER_REWARDS` does not change.
- New shared table `CAREER_REWARD_RULES` (UI copy only):
  ```
  [{id:'kill',label:'Human kill'},{id:'botKill',label:'Bot kill'},{id:'activeMinute',label:'Active minute'},
   {id:'objective',label:'Bomb plant or defuse'},{id:'match',label:'Completed match (10 s active)'},{id:'victory',label:'Win bonus'}]
  ```
- Mastery rules text is generated from the constants: "Human kills count 1. Bot and Bastion kills count ¼, up to 40 per weapon per match. Training, team kills and self-kills do not count."

### 2.8 Legacy compatibility (proof that every existing id survives with ownership preserved)
Every one of the 34 ids survives with the same id, kind, branch, parent and weapon, so `validateProfile` never meets an unknown id. No row maps to a new id. `CATALOG_ALIASES = {}` is added for future renames.

| id | old gate | new gate | relation |
|---|---|---|---|
| optic-reflex, grip-angled, counter-stattrak, optic-scope2, grip-vertical, optic-scope4, grip-precision, optic-scope10, optic-cyber | L2, 5, 10, 8, 12, 18, 26, 34, 44 | same | equal |
| rifle-overdrive | L15 + rifle kills ≥ 250 | L12 + rifle masteryScore ≥ 250 | lower (score ≥ kills) |
| revolver-high-noon | L35 + revolver kills ≥ 1,000 | L34 + score ≥ 1,000 | lower |
| minigun-foundry | L75 + minigun kills ≥ 5,000 | L44 + score ≥ 2,500 | lower |
| ignition, salvager, circuit, sovereign | L5, 25, 25, 75 | same | equal |
| revenant | L100 + pvpKills ≥ 10,000 | L25 + combatScore ≥ 10,000 | lower (combatScore ≥ pvpKills) |
| amber, arctic, reticle-dot, orchid, mint, rookie, pathfinder, vanguard, veteran, reticle-chevron, arcade, nameplate-ranger, nameplate-aegis, high-noon, reticle-halo, overdrive, nameplate-eclipse | L1, 2, 3, 3, 4, 1, 2, 4, 6, 9, 10, 14, 30, 35, 40, 50, 60 | same | equal |

**Proof of "no re-lock, no lost ownership".**
1. `careerLevel(xp) >= legacyCareerLevel(xp)` for all xp (§2.2).
2. Each level gate is ≤ its old value.
3. `masteryScore(row) >= row.kills`, and `combatScore(p) >= p.pvpKills` because `floor(max(0,·)/4) >= 0`.
4. Parents are unchanged, and owned nodes still bypass the parent gate.
5. The theme/title validity check is unchanged, and amber and rookie stay theme/title.

So every node that was eligible for a profile under the old rules is still eligible, and `cosmeticLoadout`, `unlockedParts` and `equipCareerItem` keep everything. Items newly granted by lowered gates or new nodes arrive on the next read through `reconcileCareerUnlocks`:
- file mode: `CareerService.profile()`;
- Postgres: the `lockedProfile` write-back on `owned` growth (postgres.js:178).

A profile owning all 108 ids serializes to about 2.5 KB, far under the 16,384-byte import cap. This is pinned by a test.

---

## 3. `shared/career.js` API

Kept exports (same names, compatible semantics; every current importer keeps working):

| Export | Notes |
|---|---|
| `PROGRESSION_BRANCHES` | now 4 entries, each `{id,name,detail,track}` |
| `PROGRESSION_TREE`, `CAREER_CATALOG` | still `===`; 108 frozen nodes |
| `treeNode(id)`, `childrenOf(id)`, `branchRoots(branch)` | unchanged |
| `EQUIPPABLE_SLOTS` | derived `LOADOUT_SLOTS.filter(s=>s.wire).map(s=>s.id)` = same 5 in the same order |
| `CAREER_REWARDS` | unchanged |
| `careerLevel(xp)` | new curve (§2.2) |
| `defaultCosmeticLoadout()`, `normalizeCosmeticLoadout(value)` | unchanged |
| `careerItemState(profile, idOrItem)` | existing fields unchanged in meaning (see below); adds `status`, `gate`, `xpToGo` |
| `reconcileCareerUnlocks(profile)` | returns granted ids, idempotent; uses a `Set` of owned plus one per-pass mastery context |
| `unlockedParts(profile)`, `cosmeticLoadout(profile)` | unchanged semantics |
| `equipCareerItem(profile, value)` | adds the theme→amber and title→rookie reset for `{id:'standard', kind:'theme'|'title'}` |
| `careerView(profile)` | same shape; `levelStart = xpForLevel(level)`, `nextLevel = xpForLevel(level+1)` |

New exports:
```js
export const LEGACY_NODE_IDS            // frozen array of the 34 current ids, in current declaration order
export const CATALOG_ALIASES = Object.freeze({})     // retiredId -> successorId
export function resolveCatalogId(id)    // CATALOG_ALIASES[id] ?? id
export function xpForLevel(level)
export function legacyCareerLevel(xp)
export function serviceStars(level)
export const SERVICE_STARS = Object.freeze({ from: 100, every: 5 })
export const KIND_LABELS = Object.freeze({ weaponSkin:'WEAPON SKIN', characterSkin:'OPERATOR SKIN', signature:'DEATH SIGNATURE',
  sound:'SOUND KIT', theme:'HUD THEME', title:'CALLSIGN', attachment:'ATTACHMENT', reticle:'RETICLE', nameplate:'NAMEPLATE' })
export const LOADOUT_SLOTS = Object.freeze([   // UI order; `standard` = reset target; wire = rides snapshots
  {id:'characterSkin', label:'OPERATOR SKIN',   group:'operator', standard:'standard', wire:true,  audience:'Everyone in the match'},
  {id:'signature',     label:'DEATH SIGNATURE', group:'operator', standard:'standard', wire:true,  audience:'Players you eliminate, on their death card'},
  {id:'sound',         label:'SOUND KIT',       group:'operator', standard:'standard', wire:true,  audience:'You on kills, your victims on death, the lobby when you win'},
  {id:'theme',         label:'HUD THEME',       group:'hud',      standard:'amber',    wire:false, audience:'Only you: HUD accent and crosshair'},
  {id:'title',         label:'CALLSIGN',        group:'hud',      standard:'rookie',   wire:false, audience:'Only you: career badge and menu card'},
  {id:'reticle',       label:'RETICLE',         group:'hud',      standard:'standard', wire:true,  audience:'Only you: your crosshair'},
  {id:'nameplate',     label:'NAMEPLATE',       group:'hud',      standard:'standard', wire:true,  audience:'Everyone, beside your name on the scoreboard'} ])
export const CAREER_REWARD_RULES        // §2.7
// re-exported from ./career-mastery.js:
export { MASTERY_TIERS, MASTERY_BADGES, BOT_MASTERY_DIVISOR, BOT_MASTERY_CAP_PER_MATCH, COMBAT_SCORE_BOT_DIVISOR,
         masteryScore, combatScore, arsenalCount, masteryTierIndex /* (score) -> -1..3 */ }
export function upcomingUnlocks(profile, limit = 6)
  // nodes with status 'next' and gate 'level', level track only, sorted by xpToGo then declaration order
export function masteryTracks(profile)
  // WEAPON_IDS.map(w => ({ weapon:w, badge, score, kills, botKills, headshots, tier:-1..3, tierId|null,
  //   next:{id,score}|null, progress:0..1, rewards:[{id, tierId, status}] }))
export function nextGoals(profile)
  // up to 3: [{type:'level', id, current:xp, target:xpForLevel(lvl), remaining, unit:'xp'},
  //           {type:'mastery', id, weapon, current:score, target, remaining, unit:'score'},   // weapon with highest progress toward its next tier; tie -> higher score, then WEAPON_IDS order
  //           {type:'chase', id, current, target, remaining, unit:'score'|'weapons'}]        // unowned revenant/arsenal node with highest progress
```

`careerItemState` return value:
```
{ owned, equipped, eligible, blockedByParent, locked, progress, requirements,   // unchanged meanings
  status: 'equipped'|'owned'|'next'|'locked',
  gate: 'level'|'mastery'|'combat'|'arsenal',
  xpToGo }
```
- `requirements[]` items stay `{label, current, target, complete}`. Labels:
  - `'Career level'` (in levels, as today);
  - `` `${Bt} mastery · ${TIER}` `` (score);
  - `'Combat score'`;
  - `` `Weapons at ${TIER}` ``.
- Status rules:
  - `equipped` = owned && !locked && equipped;
  - `owned` = owned && !locked && !equipped;
  - `next` = !owned && (parent === null || parent owned);
  - `locked` = everything else, including owned && locked (forged ownership).
- `xpToGo = max(0, xpForLevel(item.level) - xp)`.
- `locked`/`eligible` semantics must stay byte-for-byte what `unlockedParts`, `cosmeticLoadout` and `equipCareerItem` rely on. This is pinned by a test.

`validateProfile` (server) uses `resolveCatalogId` on owned and equipped ids before the strict unknown-id check, then dedupes.

Consumers needing edits: only `public/js/ui/progression.js`, which is rewritten. Every other importer (scoreboard, model-viewer, viewmodel-arms, vault-hands, skins, killcam-history, signature, cosmetics/preview, audio/cosmetics, server/*, tools/*) is unaffected.

---

## 4. Server, persistence, HTTP and wire

### 4.1 `server/persistence/career-profile.js`
- `validateMastery`: each row requires `kills`, `headshots` (`headshots <= kills`) and an optional `botKills` safe non-negative integer. The output row is `{kills, headshots}` plus `botKills` only when present and > 0, so legacy rows round-trip identically.
- `normalizeCareerProgress`: unchanged apart from using the new `validateMastery`.
- `applyCareerProgress`: the per-weapon merge becomes `{kills: a.kills+b.kills, headshots: a.headshots+b.headshots, botKills: (a.botKills||0)+(b.botKills||0)}`, and `botKills` is dropped when 0. Overflow is checked with `counter`. Add an optional third parameter `granted = []` into which the reconcile result is pushed. Return value unchanged. This prepares the follow-up in §4.6.
- `validateProfile`: alias resolution first. The theme/title check iterates `LOADOUT_SLOTS.filter(s => !s.wire)` with the same semantics.
- `emptyProfile`, `CAREER_COUNTERS`, `masteryView` (still `{kills, headshots}` only) and `CAREER_ID`: unchanged.

### 4.2 `server/career.js`
- `observe()`:
  - On a non-team kill of a bot victim (includes Bastion NPCs) with `WEAPON_IDS.includes(event.w)`: if `(state.botMastery[w] ||= 0) < BOT_MASTERY_CAP_PER_MATCH`, then `state.botMastery[w]++` and `(reward.mastery[w] ||= {kills:0, headshots:0}).botKills = (… .botKills || 0) + 1`.
  - `botKill` XP and `kills++` behave exactly as today. `pvpKills` is untouched.
  - `state.botMastery = {}` is initialized with the session state. It is reset when the post phase ends: replace `else if (match.phase !== 'post') state.post = false;` with `else if (match.phase !== 'post' && state.post) { state.post = false; state.botMastery = {}; }`.
  - Human-kill handling and every other reward are unchanged.
- One `CAREER_ROUTES = Object.freeze({'/api/career':'GET','/api/career/equip':'POST','/api/career/purchase':'POST','/api/career/attachments':'POST'})` drives both allowlist checks.
- Behavior is otherwise identical: `/purchase` alias, `equipOnly` ignored, header and cross-site check, 2,048-byte cap, 401/403/413/503 semantics, guest cookie.
- `equip`: builds `{id:'standard', kind: selection.slot, weapon}` as today. `theme` and `title` are now accepted slots (D13).

### 4.3 `server/persistence/postgres.js`
- No schema change. The migration list stays `[schema.sql, schema-cosmetics.sql, schema-email-recovery.sql, schema-keybindings.sql]`, versions 1–4. No version 5.
- `applyProgress` passes a `granted` array through to `applyCareerProgress` (unused for now).
- Clarification on the risk the judges flagged: only `applyProgress` sets the sticky `rewardError`. Equip and attachment saves are serialized by the transaction queue and never set it.

### 4.4 Unchanged files
`server/weapon-loadouts.js`, `server/protocol/snapshot.js`, `server/protocol/welcome.js`, `server/index.js`, `server/career-identity.js`, `server/persistence/import-json.js`, all SQL files, and `public/js/engine/netclient.js`.

### 4.5 Wire
- Unchanged. Snapshot `cosmetics` keeps the full `weaponSkins` map.
- New nameplate ids are valid catalog ids of kind `nameplate`.
- Welcome `mastery` stays human-only (StatTrak).
- `careerView` over HTTP carries `mastery[w].botKills` where present.

### 4.6 Follow-up, not in this ship: post-match career frame
When built:
- send a `{t:'career', reason:'summary', …}` frame through a raw socket send, NOT `sendJson`, which runs `decorateSnapshot` and `observe` on every object (server/index.js:111-130);
- add a `'career'` case and field whitelist entry to netclient (switch at 725-793);
- wait for the in-flight `applyProgress` promise before reporting `granted` (collected through the §4.1 out-array).

---

## 5. Armory UI

One dialog `dialog#career-shop` owned by `ProgressionTree` in `public/js/ui/progression.js`, with 4 tabs.

AGENTS.md process (WP5 phase 0): first create 3 ImageGen alternatives (desktop 1440x900 and mobile 390x844) from current screenshots plus this spec, pick one, then implement it and compare.

### 5.1 Entry points
- **Main nav** (`#menu .vb-main-nav`): `#career-open` is kept as the id and relabelled `ARMORY` (aria-haspopup=dialog). It opens the LOADOUT tab and is the focus-return target.
  - Unseen count badge: `<span class="vb-nav-badge" aria-hidden="true">3</span>`, with button `aria-label="Armory, 3 new unlocks"`. The badge is hidden at 0.
  - `#workshop-open`, `mountArmoryButton` (main.js) and `WeaponCustomization.mount` are deleted.
- **Menu card** `#career-menu-preview` (button in `.vb-menu-showcase`) opens the PROGRESS tab, or the MASTERY tab if the first NEW item is a mastery node. Content:
  - 48px callsign art;
  - `LEVEL 12 / Veteran`, plus ` ★2` when stars > 0;
  - XP bar `role=progressbar` with `aria-valuetext="1,000 of 2,300 XP to level 13"`;
  - `NEXT: 4x combat scope · LV 18 · 3,100 XP` from `nextGoals()[0]`;
  - when a baseline exists and something changed: `+1,240 XP · 2 NEW UNLOCKS SINCE YOUR LAST VISIT`;
  - footer `ARMORY ›`.
- **HUD badge** `#career-badge`: text `LV n · Title`, plus ` ★s` past 100. It is shown while `#hud` is visible (display:block).

### 5.2 Dialog DOM (desktop ≥1100px)
```
dialog#career-shop.vb-career.vb-armory[aria-labelledby=career-title][data-tab=loadout|weapons|progress|mastery]
  header.vb-armory-header                       (sticky, 56px)
    span.vb-armory-brand "VOXEL BLITZ"
    h2#career-title "ARMORY"                    (only h2)
    div.vb-armory-tabs[role=tablist][aria-label="Armory sections"]
      button#armory-tab-loadout|weapons|progress|mastery[role=tab][data-tab][aria-selected][aria-controls=armory-panel-*][tabindex=0|-1]
        "LOADOUT" "WEAPONS" "PROGRESS" "MASTERY"  (+ span.vb-tab-new dot when a panel holds NEW items)
    div.vb-armory-music                          (existing music control mounts here; [data-music-volume] stays inside #career-shop)
    button#career-close "BACK"
  section.vb-armory-strip[aria-label="Your career"]    (64px row)
    span.vb-career-rank-art                      (40px equipped callsign art)
    div.vb-armory-identity
      p.vb-career-player                         (username | "GUEST PLAYER")
      p.vb-career-title-name "LEVEL 12 / Veteran"  (+ span.vb-armory-stars "★2")
    div.vb-armory-xp
      p.vb-career-stats "LEVEL 12 · 8,900 XP"
      div.vb-armory-bar[role=progressbar][aria-valuemin=0][aria-valuemax][aria-valuenow][aria-valuetext] > span
      p.vb-armory-xp-left "1,300 XP TO LEVEL 13"
    dl.vb-armory-record  (PVP KILLS · WINS · ALL KILLS · MATCHES; dt 11px, dd 15px)
    div.vb-career-account > p "Guest career stays in this browser. Log in to keep it." + button#career-account "SAVE YOUR CAREER"|"MANAGE ACCOUNT"
    button.vb-armory-strip-toggle[aria-expanded]   (mobile only)
  div.vb-armory-body                             (grid: minmax(0,1fr) 400px)
    section#armory-panel-loadout.vb-armory-panel[role=tabpanel][aria-labelledby=armory-tab-loadout]
    section#armory-panel-weapons  …[hidden]      (body owned by WeaponBench, WP4)
    section#armory-panel-progress …[hidden]
    section#armory-panel-mastery  …[hidden]
    aside#armory-inspector.vb-armory-inspector.vb-career-feature[aria-label="Inspector"][data-featured-item=<id>]
      div.vb-armory-stage[data-kind]             (16:10, max 300px tall; ModelViewer host .vb-model-viewer or art)
      p.vb-armory-kicker "COLLECTION / KIND"     (11px)
      h3.vb-armory-name                          (28px)
      p.vb-armory-audience "WHO SEES IT: …"      (from LOADOUT_SLOTS)
      p.vb-armory-detail                         (14px)
      p.vb-armory-state[data-state]              (svg glyph + word: "EQUIPPED" / "UNLOCKED" / "LEVEL 18 · 3,100 XP TO GO" / "UNLOCK VERTICAL FOREGRIP FIRST")
      ul.vb-armory-reqs > li (label · "current / target" · bar with aria-valuetext)   (only when not owned)
      div.vb-armory-actions
        button#armory-action.vb-armory-action[data-featured-item=<id>]
            [data-item=<id>] only when owned && !locked && equippable → "EQUIP" | "EQUIPPED"(disabled)
            [data-reset=<slot>][data-weapon?] for a STANDARD target → "USE STANDARD"
            attachments → "FIT ON <WEAPON>" (switches to WEAPONS with weapon+part selected)
            locked → disabled, label = unlockSummary(), no data-item
        p#armory-status.vb-career-status[role=status][aria-live=polite]
      div.vb-armory-secondary                    ([data-audition][data-cue] KILL/DEATH/VICTORY for sounds;
                                                  [data-viewer-action=zoom-in|zoom-out|reset|standard] toolbar for 3D)
```
- The dialog contains no `<main>`.
- Headings: h2 for the dialog, h3 for panel sections and the inspector name, h4 for branches, cards and groups.
- Escape closes. Focus returns to the opener (`#career-open` or `#career-menu-preview`).
- `keydown` stopPropagation stays.

**Inspector behavior**
- Preview follows focus and hover, debounced 120 ms. When pointer or focus leaves an option list, it reverts to the pinned target (the selected slot's equipped item).
- Selecting (click, Enter, Space) pins the target.
- There is one lazy `ModelViewer` for the whole dialog. It is disposed on close. It is rebuilt only when the model or skin key changes.
- Before 3D loads, show static art plus "LOADING 3D PREVIEW". On WebGL failure, show art plus "3D preview unavailable on this device".
- Stage renderers by kind (all implemented by `cosmeticArtwork` in WP4 except 3D):

| Kind | Renderer |
|---|---|
| weaponSkin, characterSkin | 3D |
| attachment | 3D, mounted on the currently selected weapon (rifle default) |
| theme | Mini HUD mock (crosshair, ammo pill, badge) tinted with `item.color` |
| title | Legacy 8 use atlas cells; new titles use a typographic plate in `item.color` |
| reticle | Live `.vb-reticle-preview[data-reticle]` using the real reticle CSS |
| nameplate | Scoreboard-row mock with a real `.vb-sb-nameplate` |
| signature | Existing death-card mock |
| sound | Existing record art |

### 5.3 LOADOUT tab (default from `#career-open`)
```
section#armory-panel-loadout > div.vb-armory-loadout   (grid: 280px 1fr)
  nav.vb-armory-slots[aria-label="Loadout slots"]
    h4 "OPERATOR"  ul > li > button.vb-armory-slot[data-slot=characterSkin|signature|sound][aria-current=true?]
    h4 "HUD"       … [data-slot=theme|title|reticle|nameplate]
       slot button (64px): 44px thumb · label 11px caps · equipped name 15px bold ("Standard") · "2 / 3 UNLOCKED" · span.vb-new-dot
    h4 "WEAPONS"   ul > li > button.vb-armory-weapon-row[data-weapon-row=<w>]  (HUD icon, WEAPON_NAMES[w], "Overdrive · Reflex · Angled")
                   -> activates WEAPONS tab with that weapon
  div.vb-armory-options
    h3#armory-options-title "<SLOT LABEL>"   p.vb-armory-audience
    div.vb-armory-grid[role=listbox][aria-labelledby=armory-options-title]   (auto-fill, 132px cards)
      button.vb-armory-option[role=option][data-option=<id|standard>][aria-selected][data-state=equipped|owned|next|locked][data-new?]
        thumb (cosmeticArtwork thumb) · name · state chip
    (nameplate/title slots: CAREER group first, then <details> "MASTERY" with one sub-group per weapon)
    (sound slot only: details.vb-armory-cue-volume "CUE VOLUME" — the existing per-cue sliders, same localStorage keys and 'vb-cosmetic-volume' event)
```
- Option order: STANDARD card (only where `slot.standard === 'standard'`), then owned in declaration order, then next, then locked.
- Chips: `EQUIPPED` + check svg; `NEW`; `LV 18`; `ELITE · 180 / 1,000`; lock svg.
- Locked cards: dashed border, lock glyph, full-contrast text. Never fade with opacity.
- Activating an owned option equips it:
  - the option gets `aria-busy`;
  - `request(id, true)` is called; resets use `request('standard', true, {slot, weapon})`;
  - on success only that listbox, the slot button, the strip and the inspector are patched, and focus is restored via `data-focus-key`;
  - the status reads `"<Name> equipped"` or `"<SLOT LABEL> set to standard"`.
- Activating a locked option only inspects it; the status gives the requirement.
- Errors: revert the card and put the server error in `#armory-status`.
- Default inspector target on open: the equipped `characterSkin` (Standard operator model when `standard`).

### 5.4 WEAPONS tab (body built by `WeaponBench`, WP4; lazy)
```
section#armory-panel-weapons > div.vb-bench   (grid: 200px 1fr)
  nav#armory-weapon-rail[aria-label="Weapons"] > button.vb-bench-weapon[data-weapon=<w>][aria-pressed]
      (HUD icon via weaponImagePath, WEAPON_NAMES[w], tier pip "II" in tier color)
  div.vb-bench-options
    h3 "<WEAPON NAME>"
    section.vb-bench-group[data-group=skin]    h4 "SKIN"         div[role=group] > button.vb-bench-option[data-skin-option=<id|standard>][aria-pressed][data-state]
    section.vb-bench-group[data-group=optic]   h4 "OPTIC"        button[data-optic=<part>][aria-pressed][data-locked?][aria-disabled?]
    section.vb-bench-group[data-group=grip]    h4 "GRIP"         button[data-grip=<part>] …
    section.vb-bench-group[data-group=counter] h4 "KILL COUNTER" button[data-counter=<part>] …
    div.vb-bench-footer: button[data-factory] "FACTORY SETUP" · p.vb-bench-note "Setups apply when you join your next match."
```
- Weapons with no skins show "No skins for this weapon yet. Mastery rewards: see MASTERY."
- Locked parts use `aria-disabled` plus `data-locked`, stay focusable, and show `LV 18`.
- The inspector shows 3D of the weapon with the focused option applied, plus an extra block built by the bench:
  - HANDLING: 4 `<meter>`s (ergonomics, sway, vertical and horizontal recoil) with deltas against the equipped setup, shown as glyph, word and color;
  - turn ceiling and zoom;
  - MASTERY: `RAPTOR · 132 human · 48 bot · 12 headshots`, a tier meter, and `NEXT: Raptor II nameplate · 144 / 250`.
- `#armory-action` is hidden in this tab; the options are the controls.
- Activating a part: optimistic `aria-pressed`, debounced 250 ms latest-wins, then `saveAttachments(weapon, {optic, grip, counter})`.
  - On failure, roll back to the last confirmed `profile.equipped.weaponAttachments[weapon]` and show the error.
  - On success the status reads `"<WEAPON NAME> setup saved"`.
- Skins equip through `request(id, true)`. `FACTORY SETUP` saves standard ×3.
- There are no drafts and no SAVE SETUP button.
- Deep links: `open({tab:'weapons', weapon, part})` from `[data-open-weapon]`, attachment tiles, or LOADOUT weapon rows.

### 5.5 PROGRESS tab (default from `#career-menu-preview`)
```
section#armory-panel-progress
  section.vb-armory-goals  h3 "NEXT UP"   ol > li > button.vb-goal-card[data-goal=level|mastery|chase][data-target=<id>]
      (art, name, "LV 18 · 3,100 XP" / "RAPTOR II · 144 / 250" / "COMBAT SCORE 2,310 / 10,000", bar)
  section.vb-armory-intro[hidden unless first run]  "ARMORY UPGRADED — 14 new rewards are waiting." (+ "Your level was recalculated: 100 → 124." only when legacyCareerLevel ≠ careerLevel)
      button[data-dismiss-intro] "GOT IT"   (localStorage 'vb-armory-intro:v1')
  section.vb-armory-journey h3 "LEVEL JOURNEY"
    ol.vb-journey: li.vb-journey-you "YOU · LV 12" (partial bar) + li.vb-journey-stop[data-level] ×≤6
        (level circle, "3,100 XP AWAY", chips button.vb-journey-chip[data-journey=<id>])
    complete state: "ALL LEVEL REWARDS UNLOCKED · LEVEL n ★s"
  section.vb-armory-tree h3 "UNLOCK TREE"
    div.vb-tree-filters > button[data-filter=all|weapons|character|presentation][aria-pressed]
    p.vb-tree-summary "12 / 53 UNLOCKED"
    div#progression-tree.vb-tree
      section.vb-tree-branch[data-branch] h4 name · p "x of y unlocked · detail"
        ul[role=tree][aria-label="<Branch> unlock tree"]
          li.vb-tree-item[role=treeitem][aria-level][aria-selected][tabindex][data-state=unlocked|next|locked][data-equipped?][data-upcoming?][data-new?][data-lane]
            div.vb-tree-node[data-node=<id>][data-cosmetic=<id>]
                (level badge · 32px thumb · name 14px · "HUD THEME · LV 3" 11px · state glyph + span.vb-sr "Equipped."|"Unlocked."|"Next up."|"Locked." · chip "UP NEXT"|"NEW")
            ul[role=group] (side lanes)
  details.vb-armory-earn  summary "HOW TO EARN XP"  table: CAREER_REWARD_RULES[i].label | `+${CAREER_REWARDS[id].xp} XP`
  p.vb-armory-fairness  "Cosmetics never change combat stats. Nothing is bought."
```
- The tree shows only `track:'level'` branches. `[data-cosmetic]` exists only inside `#progression-tree`, one per node; under ALL that is 53.
- `data-state` mapping: equipped and owned → `unlocked` (plus `data-equipped="true"` when equipped); `next` → `next`; `locked` → `locked`.
- `data-upcoming` goes only on the top 3 `upcomingUnlocks`.
- Lanes come from `branchLanes()` (spine compression): the spine follows the child with the largest subtree, ties go to declaration order, and other children are nested side lanes. Levels never decrease along a lane.
- Activating a node inspects it in the inspector; the page does not scroll.
- Journey chips and goal cards select the node, clear the filter if it hides the node, and scroll it into view. This replaces JUMP TO NEXT UNLOCK.
- Desktop: 3 branch columns aligned at the top.

### 5.6 MASTERY tab
```
section#armory-panel-mastery
  p.vb-mastery-rules    (generated rule text §2.7)
  section.vb-arsenal h3 "ARSENAL"  ul > li[data-mastery-node=armorer|nameplate-arsenal|armsmaster] ("4 / 5 WEAPONS AT SPECIALIST", bar, state) + li revenant chase ("COMBAT SCORE 2,310 / 10,000")
  div.vb-mastery-sort > button[data-mastery-sort=closest|all][aria-pressed]   (default closest)
  div#armory-mastery-grid.vb-mastery-grid[role=list]
    button.vb-mastery-card[role=listitem? no: li wrapper][data-weapon-mastery=<w>][aria-expanded]
       (HUD icon, WEAPON_NAMES[w], 4 tier pips I–IV with numeral text, "132 / 250 SCORE", bar aria-valuetext, "NEXT: Raptor II nameplate")
  section#armory-mastery-detail[hidden]  h3 "<WEAPON NAME> MASTERY"
    ol tier ladder: 4 rows, each tier name + threshold + reward tiles button[data-mastery-node=<id>][data-state] (+ legacy skin tile where it applies)
    dl stats: HUMAN KILLS · BOT KILLS · HEADSHOTS · SCORE
    button[data-open-weapon=<w>] "TUNE IN WEAPONS"
```
Wrap each card in an `li` inside a `ul`, so there is no role hacking. Tiles inspect in the inspector, and owned ones can be equipped through `#armory-action`. Grid columns: 3 at ≥1100px, 2 at ≥641px, 1 below.

### 5.7 NEW flags (`public/js/ui/armory/seen-store.js`)
- Key: `vb-armory-seen:v1:<accounts.user?.id || 'guest'>`. Value: `{ids:[…], xp}`. Every access is in try/catch; with no storage there are simply no flags.
- On first run, seed `ids = owned ∩ LEGACY_NODE_IDS` and `xp = current xp`, and show the intro card if `owned − ids` is non-empty.
- NEW = `owned − ids`. An item is marked seen when shown in the inspector or on `MARK ALL SEEN` (button in the intro card and in the PROGRESS goals header).
- The `xp` baseline updates on dialog close. The "since your last visit" line uses it.

### 5.8 States, type, copy and accessibility
- States always pair an SVG glyph with a word; never color alone. No emoji glyphs.
- Minimum text 11px; body 13–14px. Contrast AA. Locked items are not faded.
- `aria-valuetext` on every bar and meter.
- Roving tabindex on the tablist (Left/Right/Home/End), slot list, option grid, weapon rail and mastery grid.
- ARIA tree keys: Up/Down move, Right goes to the side lane, Left goes to the parent.
- `prefers-reduced-motion` disables the model idle spin and transitions. `forced-colors` keeps borders.
- Touch targets ≥ 44px at ≤640px.
- Copy is terse uppercase kickers plus one-sentence details. The words credit, buy, purchase, price and shop are banned (tested with `/credit|buy|purchase|price|shop/i` inside `#career-shop`).
- `account-menu.js` copy becomes: "Accounts keep your XP, level and unlocks across devices."

### 5.9 Layout breakpoints
- **≥1100px (1440x900 target).** Dialog `width:min(1440px,100vw - 32px)`, `height:calc(100dvh - 32px)`. Header 56px, strip 64px. Body grid `minmax(0,1fr) 400px`: only the panel scrolls, and the inspector scrolls on its own. LOADOUT is `280px | 1fr`, which gives about 5 option columns.
- **641–1099px.** The inspector column is 340px, the slot rail 220px, tree branches stack in 1 column, and the mastery grid has 2 columns.
- **≤640px (390x844, 360x780).** Full screen, 16px side gutter, no horizontal page scroll.
  - Header row 1 (48px): `#career-close` BACK on the left, `ARMORY`, and the music control as an icon button.
  - Header row 2: tablist of 4 equal 44px tabs. Both rows are sticky.
  - The strip collapses to one 48px row (level circle, bar, `1,300 XP TO 13`). A `▾` toggle expands the identity, record and account parts, which stay in the DOM so `.vb-career-stats` text is always present.
  - The inspector becomes a sticky bottom bar (64px: thumb, name, state, `#armory-action`, status line). Tapping `DETAILS` or selecting an item expands it into a bottom sheet (`[data-sheet=open]`, max 72dvh) with the stage (220px) and details.
  - LOADOUT: full-width slot list. Tapping a slot pushes the options view (2-column grid) with a sticky `← ALL SLOTS` that restores scroll and focus. Back/Escape inside that view returns to the list first.
  - WEAPONS: horizontal scroll-snap rail (`touch-action:pan-x`) above the groups. Handling sits in the sheet.
  - PROGRESS: goals in 1 column. The journey is a horizontal snap rail. The tree shows one branch, defaulting to the branch of the top upcoming unlock; ALL stacks the branches.
  - MASTERY: 1-column rows.
  - The model canvas uses `touch-action:pan-y` via `.vb-armory-stage .vb-model-stage canvas`, which fixes the swipe trap.

### 5.10 Ids and hooks
- **Kept:**
  - dialog and entry: `#career-shop`, `#career-open` (label ARMORY), `#career-close`, `#career-title`, `#career-menu-preview`, `#career-badge`, `#career-account`, `#progression-tree`;
  - classes: `.vb-career-status`, `.vb-career-stats`, `.vb-career-title-name`, `.vb-career-player`, `.vb-career-account p`, `.vb-career-feature` (on the inspector), `.vb-tree`, `.vb-tree-branch[data-branch]`, `.vb-tree-item[data-state]`;
  - data attributes: `[data-node]`, `[data-cosmetic]`, `[data-filter][aria-pressed]`, `[data-item]`, `[data-featured-item]`, `[data-audition][data-cue]`, `[data-viewer-action]`, `[data-weapon][aria-pressed]`, `[data-optic|data-grip|data-counter]`, `data-locked`;
  - viewer: `.vb-model-viewer`, `.vb-model-stage canvas[data-ready][data-skin]`;
  - globals: `--career-accent`, `vb-career-change`, `vb-account-change`, `vb-cosmetic-volume`;
  - exports: `ProgressionTree` (plus alias `ArmoryScreen`), `progressionActionState`, `unlockSummary`, and `ProgressionTree.prototype.request(item=null, equipOnly=false, reset={})` with identical semantics: stale → null, `/session changed/`, dispatches `vb-career-change`, body `{item, equipOnly:true, slot?, weapon?}`.
- **Removed:** `#workshop-open`, `dialog#weapon-customization`, `#workshop-close`, `#workshop-save`, `.vb-workshop-*`, `#career-mastery-weapon`, `[data-inspect]`, the loadout reset links, and the always-rifle-overdrive featured default.
- **New:** `#armory-tab-*`, `#armory-panel-*`, `#armory-inspector`, `#armory-action`, `#armory-status`, `#armory-weapon-rail`, `#armory-mastery-grid`, `#armory-mastery-detail`, `[data-tab]`, `[data-slot]`, `[data-option]`, `[data-weapon-row]`, `[data-skin-option]`, `[data-journey]`, `[data-goal]`, `[data-upcoming]`, `[data-new]`, `[data-factory]`, `[data-reset]`, `[data-weapon-mastery]`, `[data-mastery-node]`, `[data-open-weapon]`, `.vb-nav-badge`.

### 5.11 Client state
- `ProgressionTree` is the single profile store.
- Network logic lives in `public/js/ui/career-store.js` as functions over a host object, so the tests that call `request` on a bare `{profile, requestVersion, render, accounts?}` keep working.
- The WEAPONS tab reads `this.profile` and does no separate GET.
- `local-presentation.js` (WP2) is called on every profile update to apply the theme accent and reticle.
- Refresh happens:
  - at boot (`career.start()` before the socket; cookie bootstrap unchanged);
  - on dialog open;
  - on `vb-account-change`, after a full reset;
  - on return to the menu (`career.refresh()` from main.js);
  - on the 15 s idle poll (D18).

---

## 6. Work packages

There are 4 parallel packages plus integration. No file appears in two packages. Unlisted files are unchanged.

**Order:** WP1 publishes its `shared/career.js` export surface first as a stub (names and signatures from §3, real data) within its first commit. WP2, WP3 and WP4 code against §3 in parallel. WP5 phase 0 (design references) runs first and in parallel. Its chosen reference must land before WP3/WP4 finalize CSS.

### WP1: Rules, server and persistence
- **Files:**
  - `shared/career.js`
  - `shared/career-mastery.js` (new)
  - `server/career.js`
  - `server/persistence/career-profile.js`
  - `server/persistence/postgres.js`
  - `tools/progression-tree-test.mjs`
  - `tools/career-gates-test.mjs` (new)
  - `tools/career-test.mjs`
  - `tools/cosmetics-career-test.mjs`
  - `tools/weapon-customization-test.mjs`
  - `tools/account-career-test.mjs`
  - `tools/postgres-test.mjs`
  - `tools/lib/postgres-reward-contracts.mjs`
  - `tools/career-websocket-test.mjs`
- **Delivers:** §2, §3 and §4 in full, including load-time integrity rules, alias resolution, the bot-mastery cap and the theme/title reset.
- **Provides:** the §3 exports.
- **Consumes:** nothing new.

### WP2: In-match presentation and boot wiring
- **Files:**
  - `public/js/main.js`
  - `public/js/cosmetics/local-presentation.js` (new)
  - `public/style.css`
  - `public/styles/cosmetics.css`
  - `public/js/ui/account-menu.js`
  - `tools/cosmetics-runtime-test.mjs`
- **Delivers:**
  - `local-presentation.js` exports:
    - `applyTheme(themeId)`: sets `--career-accent` from `treeNode(id).color`, falling back to amber;
    - `applyReticle(reticleId)`: sets `document.documentElement.dataset.reticle = treeNode(id)?.reticle` and deletes it for `'standard'` or unknown ids;
    - `applyLocalPresentation(equipped)`: calls both;
    - `resetLocalPresentation()`.
  - main.js:
    - call `applyReticle(self.cosmetics.reticle)` where `rig.setCosmetics(self.cosmetics)` runs (about line 476), only when the value changes;
    - `resetLocalPresentation()` plus reapply from `career.profile` on return to the menu;
    - call `career.refresh()` on menu return;
    - delete `mountArmoryButton`, the `WeaponCustomization` import and construction, and the `customization` references;
    - AccountMenu `onOpen` closes only `career.dialog`;
    - `assets.define('armory', () => Promise.all([import('./ui/armory/weapon-bench.js'), import('./ui/model-viewer.js')]))` as a prewarm.
  - style.css:
    - reticle rules for `gap`, `bracket` and `diamond`;
    - every reticle rule's selector list extended with `.vb-reticle-preview[data-reticle='x'] .vb-reticle-crosshair …`;
    - base `.vb-reticle-crosshair` styles mirroring `#crosshair` (4 `.ch-arm` children plus ::before/::after).
  - cosmetics.css receives the in-match globals moved out of career.css: the `:root{--career-accent:#ffb347}` default, `#career-badge` rules, the `#crosshair .ch-arm` accent rule, and `.vb-sb-nameplate`.
  - account-menu.js copy fix.
- **Provides:** `local-presentation.js`, and the reticle-preview DOM contract `div.vb-reticle-preview[data-reticle] > div.vb-reticle-crosshair > span.ch-arm ×4`.
- **Consumes:** WP1 `treeNode`; WP3 `career.refresh()`, `career.profile`, `career.dialog`.

### WP3: Armory shell, store, LOADOUT, PROGRESS and MASTERY
- **Files:**
  - `public/js/ui/progression.js` (rewrite)
  - `public/js/ui/career-store.js` (new)
  - `public/js/ui/armory/armory-model.js` (new, pure, no DOM)
  - `public/js/ui/armory/inspector.js` (new)
  - `public/js/ui/armory/loadout-panel.js` (new)
  - `public/js/ui/armory/progress-panel.js` (new)
  - `public/js/ui/armory/mastery-panel.js` (new)
  - `public/js/ui/armory/focus-nav.js` (new)
  - `public/js/ui/armory/seen-store.js` (new)
  - `public/styles/armory.css` (new: shell, strip, tabs, panels, inspector, menu card, nav badge, mobile sheet)
  - `public/styles/career.css` (delete)
  - `tools/cosmetics-ui-test.mjs`
  - `tools/armory-model-test.mjs` (new)
  - `tools/armory-dom-contract-test.mjs` (new)
  - `tools/lib/fake-dom.mjs` (new)
- **Delivers:**
  - §5.1–5.3 and §5.5–5.11, plus `#career-badge` and menu-card rendering.
  - `armory-model.js` exports: `branchLanes(branchId)`, `journey(profile, limit=6)`, `loadoutModel(profile)`, `slotOptions(profile, slotId)`, `tileState(profile, id)`, `masteryCards(profile, sort)`.
  - `career-store.js` exports:
    - `careerRequest(host, item, equipOnly, reset)`, which carries today's `request()` body verbatim in behavior;
    - `careerSaveAttachments(host, weapon, attachments)`: POST `/api/career/attachments`, same header, account-refresh and `requestVersion` discipline, stale → null;
    - `announceCareer(profile)`, which dispatches `vb-career-change`.
  - `ProgressionTree` methods:
    - `request(...)` delegates to `careerRequest(this, ...)`;
    - `saveAttachments(weapon, attachments)`;
    - `open({tab, weapon, part, item} = {})`, `refresh()`, `start()`;
    - `profile` and `dialog` properties.
- **Provides to WP4:** the `Inspector` instance and the host contract below.
- **Consumes:** WP1 exports; WP2 `applyLocalPresentation`; WP4 `cosmeticArtwork` and `WeaponBench`.
- **Inspector API** (`inspector.js`):
  ```
  class Inspector {
    constructor(root, { host })                  // host = ProgressionTree
    inspect(target, { pin = false } = {})         // target: catalog id | {standard:true, slot, weapon?}
    showWeapon({ weapon, skin, attachments, mastery, title, kicker, detail, extra /* HTMLElement */ }) // 3D weapon, hides #armory-action
    revert()                                      // back to pinned target
    setStatus(text, tone = 'info' /* 'error' */)
    viewer(): Promise<ModelViewer>                // single lazy instance, disposed by dispose()
    dispose()
  }
  ```

### WP4: Weapon bench, previews and model viewer
- **Files:**
  - `public/js/ui/armory/weapon-bench.js` (new, ported from weapon-customization.js)
  - `public/js/ui/weapon-customization.js` (delete)
  - `public/js/ui/weapon-preview.js`
  - `public/js/ui/model-viewer.js`
  - `public/js/ui/cosmetic-preview.js`
  - `public/styles/model-viewer.css`
  - `public/styles/armory-bench.css` (new: bench, art tiles, theme mock, nameplate mock, reticle-preview frame, `[data-locked]` option style)
  - `public/styles/weapon-customization.css` (delete)
  - `tools/armory-preview-test.mjs` (new)
- **Delivers:**
  - §5.4.
  - `cosmeticArtwork(parent, item, className='', {size:'thumb'|'stage'}={})` renders non-empty art for every kind (§5.2 table), with sizes 44/132/stage. `COSMETIC_AUDIO`, `cosmeticVolume`, `CosmeticAudition`, `LEGACY_ART` order and the "preview unavailable" fallback are kept exactly.
  - ModelViewer:
    - public API unchanged (`show({weapon, loadout, attachments, label, mastery})`, `reset`, `zoomBy`, `render`, `dispose`);
    - horizontal-drag orbit only;
    - a `prefers-reduced-motion` guard;
    - the `touch-action:pan-y` stage rule.
  - WeaponBench API:
    ```
    export class WeaponBench {
      constructor({ panel /* #armory-panel-weapons */, inspector /* Inspector */, host /* ProgressionTree */ })
      setProfile(careerView)          // re-render groups; keeps optimistic pending state
      select(weapon, { part } = {})   // part: 'optic'|'grip'|'counter'|'skin'
      dispose()
    }
    ```
    It calls `host.saveAttachments` (debounced 250 ms latest-wins) and `host.request(id, true)` / `host.request('standard', true, {slot:'weaponSkin', weapon})`.
- **Consumes:** WP1 exports, WP3 Inspector and host, WP2's reticle-preview DOM contract.

### WP5: Integration, docs, design and browser tests (final)
- **Files:**
  - `public/index.html`: links drop `career.css` and `weapon-customization.css` and add `armory.css` and `armory-bench.css`; modulepreload regenerated with `npm run preload:build`, including `shared/career-mastery.js`, `career-store.js`, `local-presentation.js` and the `armory/*` boot modules; `weapon-bench.js` and `model-viewer.js` stay lazy.
  - `package.json`: `career:test` adds `career-gates-test`, `armory-model-test`, `armory-dom-contract-test`, `armory-preview-test`.
  - Tests: `tools/cosmetics-assets-test.mjs` (derive counts), `tools/armory-browser-test.mjs`, `tools/career-browser-test.mjs`, `tools/model-viewer-browser-test.mjs`, `tools/menu-first-boot-test.mjs`, `tools/accounts-browser-test.mjs`, `tools/postgres-browser-test.mjs`, `tools/postgres-container-test.mjs`, `tools/music-volume-browser-test.mjs`.
  - Docs: `docs/progression.md` (rewrite: curve, level jump note, gate kinds, full node table, mastery, legacy compatibility, reticle runtime correction), `docs/cosmetics.md` (LOADOUT_SLOTS audience table, MASTERY_TIERS from shared data, remove the stale collection-cards and "never cross the wire" reticle notes), `docs/weapon-customization.md` (WEAPONS tab, save-on-select), `BUILD-CONTRACT.md` (Career progression section: one ARMORY dialog, no `#workshop-open`, gate kinds, monotonic-gate rule, new tests).
  - Design: `docs/design/armory-v2/` (README, `prompts.json`, `alt-a|b|c-desktop.png`, `alt-a|b|c-mobile.png`, `chosen-*.png`, `screenshots/*.png`); `docs/design/armory/README.md` (mark superseded).
- **Phase 0:**
  - ImageGen alternatives from current screenshots plus this spec.
  - Choose one and record why in the README.
  - If ImageGen is unavailable in the session, say so in the README and do not fabricate references.
- **Final:**
  - Run §7.
  - Commit only this redesign's paths on `redesign/armory-progression`. The commit message states the level-jump note (D20) and ends with the required Co-Authored-By line.
  - `git push -u origin redesign/armory-progression`.

---

## 7. Test plan

### 7.1 Node suites (all must pass)
Run with `set -o pipefail` and never pipe `npm test` through `tail` without it.
- `npm run career:test`: progression-tree, career-gates (new), career, career-websocket, cosmetics-career, cosmetics-ui, cosmetics-runtime, cosmetics-assets, armory-model (new), armory-dom-contract (new), armory-preview (new).
- `npm run accounts:test` (accounts-ui, account-career).
- `npm run weapons:handling:test` (includes weapon-customization-test).
- `npm run static:test` and `node tools/build-module-preload.mjs --check`, after `npm run preload:build`.
- `node tools/cosmetics-career-test.mjs --postgres` and `npm run postgres:test`, when Docker or Postgres is available.
- Finally `npm test`.

### 7.2 Updates and additions

| Test | Owner | Assertions |
|---|---|---|
| progression-tree-test | WP1 | Branch ids `[weapons,character,presentation,mastery]`, each with a `track`. Gated nodes are leaves with `level === parent.level` (or 1 for roots). No `price`, `masteryKills` or `pvpKills` fields. Every `masteryTier` is valid. Required per-kind fields present. `CAREER_CATALOG === PROGRESSION_TREE`. 108 nodes. `emptyProfile().owned` is `['amber','rookie']`. Forged `owned:['rifle-overdrive']` gives `locked` and `status:'locked'`. `status`/`gate`/`xpToGo` values. `locked`/`eligible` unchanged for the legacy fixtures. Level-36 cascade includes optic-scope10. scope4 opens at 18 and scope10 does not. `unlockedParts` pins. `xpForLevel` imported, not hand-coded; equals `careerView.levelStart`/`nextLevel`. Theme/title reset to amber/rookie. `JSON.stringify` of a profile owning every id is < 16,384 bytes. |
| career-gates-test (new) | WP1 | An inline frozen `LEGACY_GATES` table of the 34 ids `{kind, branch, parent, weapon?, level, masteryKills?, pvpKills?}`: every id exists with the same kind, branch, parent and weapon; new level ≤ old. `careerLevel(xp) >= legacyCareerLevel(xp)` for xp in `[0, 3e6]` stepped plus boundaries 249,999/250,000/259,899/259,900. Brute force over 2,000 seeded random legacy profiles: every node eligible under an inline copy of the old `careerItemState` and curve is eligible now. `masteryScore >= kills` and `combatScore >= pvpKills` hold on the random rows. |
| career-test | WP1 | careerLevel 0/99/100/400 unchanged, plus 249,999→50, 250,000→51, 259,899→51, 259,900→52, 735,100→100. `serviceStars(104)=0`, `(105)=1`. Reward totals unchanged. The bot kill adds `mastery[w].botKills`, and the cap stops at 40 per match and resets after post. `/purchase` alias still honored. Bare-object `request` stale test unchanged. |
| cosmetics-career-test | WP1 | Legacy credits profile migration unchanged (ignition and arcade granted by level 15, rifle-overdrive not). Tier boundaries at score 49/50, 249/250, 999/1,000, 2,499/2,500 including botKills weighting (e.g. kills 200 + botKills 199 gives 249). Combat score 9,999/10,000 for revenant. Arsenal 4/5 and 5/5. botKills round-trips through validate, apply and Postgres jsonb. The `--postgres` migrations pin fixed to `[1,2,3,4]`. decorateSnapshot shape unchanged. |
| weapon-customization-test | WP1 | Level-34 optic list exactly `['standard','reflex','scope2','scope4','scope10']` via `xpForLevel(34)`. The same attachments POSTed twice is idempotent. |
| account-career-test, postgres-test | WP1 | orchid, pathfinder and arctic flows unchanged. Rename the `bought` wording. |
| cosmetics-ui-test | WP3 | `request()` body deep-equals `{item:'standard', equipOnly:true, slot, weapon}`, plus header, same-origin, stale null, `/session changed/`, event dispatch. `saveAttachments` has the same discipline. `progressionActionState` never matches /credit/. Existing `cosmeticArtwork`/`CosmeticAudition`/`cosmeticVolume`/LEGACY_ART pins kept. |
| armory-model-test (new) | WP3 | `branchLanes` covers each level-track node once, and levels never decrease on a lane; the weapons branch equals the §5.5 spine (reflex→scope2→vertical→scope4→precision→scope10→cyber→foundry, side lanes angled→stattrak, overdrive, high-noon). `journey` stops ascending with `xpToGo = xpForLevel - xp`, and the complete state appears. `upcomingUnlocks` sorts by XP and never returns a gated node. `nextGoals` shape. `slotOptions` order is standard, owned, next, locked. seen-store seeds `owned ∩ LEGACY_NODE_IDS`, survives a throwing localStorage, and flags only new ids. |
| armory-dom-contract-test (new) | WP3 | Fake DOM (`tools/lib/fake-dom.mjs`), fixture careerView, fake fetch. Kept ids present. Tablist and tabpanel roles. `[data-cosmetic]` count under ALL equals the level-track node count and per filter equals `PROGRESSION_TREE.filter(branch)`. `[data-upcoming]` ≤ 3. orchid is `next` at level 2. A locked node has no `[data-item]`. Equip leaves "Arctic equipped" in `#armory-status` with focus on the same `data-focus-key`. HOW TO EARN XP numbers equal `CAREER_REWARDS`. Mastery tier thresholds equal `MASTERY_TIERS`. No `/credit|buy|purchase|price|shop/i`. |
| armory-preview-test (new) | WP4 | `cosmeticArtwork` returns non-empty art for every catalog item and every kind. The reticle preview uses the `data-reticle` DOM contract. The bench debounce is latest-wins with rollback on a rejected save. |
| cosmetics-runtime-test | WP2 | `applyReticle('reticle-dot')` sets `dataset.reticle='dot'`; `'standard'` removes it. `applyTheme('arctic')` sets `#72e6ff`. Existing pins kept. |
| cosmetics-assets-test | WP5 | Preview and sound counts derived from `CAREER_CATALOG` (still 5 and 3 kits). The 1200x800 and Opus hash pins are kept. |

### 7.3 Browser verification
Use CDP and muted captures only (`tools/lib/cdp-session.mjs`). Never use the unmuted Chromium flow.

- **`npm run armory:browser`**, viewports `[1440,900], [1280,720], [390,844 mobile:true], [360,780 mobile:true]`:
  - menu: `#career-open` "ARMORY" in the viewport at ≥760px and no `#workshop-open`;
  - `#account-mobile-open` visible at 390;
  - open ARMORY: LOADOUT tab selected; equipping `vanguard` from the callsign slot gives `.vb-career-status` "Vanguard equipped", with the status inside the inspector or mobile bottom bar;
  - `.vb-career-stats` includes "LEVEL 4";
  - tab switching by click and arrow keys;
  - PROGRESS filters with derived counts, and a journey chip jumping to a filtered node;
  - WEAPONS: the rifle `[data-optic=reflex]` save persists across reload;
  - MASTERY grid shows 13 cards;
  - no horizontal overflow on `#career-shop` or `#menu` at any viewport;
  - `#career-close` stays visible while scrolling;
  - no banned words;
  - screenshots per tab at 1440x900 and 390x844 to `.artifacts/armory/`, copied to `docs/design/armory-v2/screenshots/` and compared against `chosen-desktop.png` and `chosen-mobile.png`, with the differences noted in the README.
- **`career:browser`:**
  - orchid `data-state=next` at level 2;
  - equipping arctic sets `--career-accent` to `#72e6ff` and disables the button;
  - equipping reticle-dot sets `:root[data-reticle=dot]`;
  - Escape returns focus to `#career-open`;
  - in a match, `#crosshair .ch-arm` is rgb(114,230,255), `#career-badge` is display:block, and `data-reticle` follows the snapshot.
- **`models:browser`:**
  - the viewer loads in LOADOUT;
  - WEAPONS rifle skin option rifle-overdrive is locked at the level-100 fixture without mastery;
  - `[data-optic=scope4]` save-on-select;
  - `[data-viewer-action=reset|standard]`;
  - no POST while inspecting;
  - the viewer is disposed on dialog close;
  - no overflow at 360.
- **`boot:test`:** `#career-open` present at first paint and enabled while assets load.
- **`accounts:browser`, `postgres:browser`, music-volume:** repointed to the kept ids. `[data-music-volume]` is inside `#career-shop` and usable at 390.