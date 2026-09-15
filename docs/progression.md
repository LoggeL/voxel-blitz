# Career progression

Progression is a single unlock tree. A node opens automatically when every
requirement it lists is complete **and** the node before it is already open.
Nothing is bought, there is no currency, and no choice can be spent wrongly.

`shared/career.js` owns the tree and is imported unchanged by both the client
and the server. `CAREER_CATALOG` remains exported as the flat, pre-order view of
the same frozen array, so every existing consumer that only asks "does this ID
exist" or "list every sound kit" keeps working.

## Branches

| Branch | Contents |
| --- | --- |
| `weapons` | Optics, grips, the StatTrak counter and the weapon skins |
| `character` | Operator skins and death signatures |
| `presentation` | HUD themes, callsigns, reticles, nameplates and sound kits |

Each branch spine carries **only** level gates. Every node with an extra
requirement — weapon mastery or lifetime PvP kills — is a leaf, so a long grind
can never dead-end a branch for the rewards behind it. `progression-tree-test`
asserts this property rather than trusting the layout.

## Nodes

| Node | Kind | Level | Parent | Extra requirement |
| --- | --- | ---: | --- | --- |
| Reflex sight | attachment | 2 | — | — |
| Angled foregrip | attachment | 5 | Reflex sight | — |
| 2× tube sight | attachment | 8 | Reflex sight | — |
| StatTrak counter | attachment | 10 | Angled foregrip | — |
| Vertical foregrip | attachment | 12 | 2× tube sight | — |
| Overdrive | rifle skin | 15 | Vertical foregrip | 250 rifle PvP kills |
| 4× combat scope | attachment | 18 | Vertical foregrip | — |
| Precision grip | attachment | 26 | 4× combat scope | — |
| 10× precision scope | attachment | 34 | Precision grip | — |
| High Noon | revolver skin | 35 | 10× precision scope | 1,000 revolver PvP kills |
| CY-9 cyber scope | attachment | 44 | 10× precision scope | — |
| Foundry | minigun skin | 75 | CY-9 cyber scope | 5,000 minigun PvP kills |
| Ignition | signature | 5 | — | — |
| Salvager | character skin | 25 | Ignition | — |
| Circuit | signature | 25 | Ignition | — |
| Sovereign | signature | 75 | Circuit | — |
| Revenant | character skin | 100 | Salvager | 10,000 PvP kills |
| Amber | HUD theme | 1 | — | — |
| Arctic | HUD theme | 2 | Amber | — |
| Dot reticle | reticle | 3 | Amber | — |
| Orchid | HUD theme | 3 | Arctic | — |
| Mint | HUD theme | 4 | Orchid | — |
| Rookie | callsign | 1 | — | — |
| Pathfinder | callsign | 2 | Rookie | — |
| Vanguard | callsign | 4 | Pathfinder | — |
| Veteran | callsign | 6 | Vanguard | — |
| Chevron reticle | reticle | 9 | Dot reticle | — |
| Arcade | sound kit | 10 | Veteran | — |
| Ranger nameplate | nameplate | 14 | Veteran | — |
| Aegis nameplate | nameplate | 30 | Ranger nameplate | — |
| High Noon | sound kit | 35 | Arcade | — |
| Halo reticle | reticle | 40 | Chevron reticle | — |
| Overdrive | sound kit | 50 | High Noon | — |
| Eclipse nameplate | nameplate | 60 | Aegis nameplate | — |

Amber and Rookie are the two roots of the presentation branch and are the
equipment a new career starts with.

The XP curve is unchanged: level N starts at `(N - 1)^2 * 100` XP. Level 50
requires 240,100 XP and level 100 requires 980,100 XP. These are content gates,
not a measured play-time promise.

## Grants

Nodes are declared in topological order — a parent always precedes its children
— which is what lets `reconcileCareerUnlocks` grant an entire chain in a single
forward pass. A returning player who last logged in at level 1 receives every
node up to their current level the first time their profile is read, not one per
read. Module load throws if any node is declared before its parent, before its
parent's level, or outside its parent's branch, because an out-of-order node
would merely delay a grant and stay invisible at runtime.

**A grant is permanent.** Ownership is never revoked, so inserting a parent above
an existing node cannot strip a cosmetic a player already equipped. The
requirement gates still apply to owned nodes, so a forged `owned` entry cannot
equip a mastery reward the profile has not actually earned.

## No currency

Career credits are gone: from `CAREER_REWARDS`, from `CAREER_COUNTERS`, from the
profile, from the HTTP surface and from the UI. Rewards pay XP only (human kill
25, bot kill 10, active minute 20, objective 75, completed match 100, win 50).

A legacy `credits` field is accepted on read and dropped, because
`validateProfile` rebuilds the profile from `CAREER_COUNTERS`. The PostgreSQL
`credits` column stays in the schema and keeps its historical values: it is
omitted from the `INSERT` column list (it is `NOT NULL DEFAULT 0`) and from the
`DO UPDATE SET` clause, so it is never read and never written again. **No new
migration is required.**

In-match economies are a separate system and are untouched: Search and Destroy
(`server/modes/snd/economy.js`), TTT (`shared/ttt.js`), Chaos
(`shared/chaos.js`), Bastion (`shared/bastion.js`) and `WEAPON_PRICES` in
`shared/modes.js`.

## HTTP

`POST /api/career/equip` equips an owned, unlocked node, or resets a slot with
`{ item: 'standard', slot, weapon }`. It keeps the existing career identity and
the `X-VB-Career: 1` same-origin header. `POST /api/career/purchase` stays routed
as a compatibility alias so a cached client bundle keeps working across a
deploy; it is removable after one release. An `equipOnly` field in the body is
accepted and ignored. `careerView` additionally carries `unlockedParts` so the
armory can show locked attachments with their gate.

## Runtime

Reticles are local presentation only and never cross the wire: the equipped node
sets `data-reticle` on the document element, and `public/style.css` restyles the
existing `#crosshair` arms through the custom properties they already use.
Nameplates ride the existing per-player `cosmetics` object in the tick snapshot
and render as one more badge in the scoreboard's `.vb-sb-name` cell.

## Validation

- `npm run career:test` — the tree's structural invariants, single-pass grants,
  permanent ownership, forgery rejection, attachment gating, career authority,
  persistence, UI state and cosmetic audio.
- `npm run weapons:handling:test` — attachment compatibility, that ownership did
  not leak into the shared derivation, and that a locked part cannot be saved.
- `npm run accounts:test` — guest-to-account transfer of a legacy profile.
- `node tools/cosmetics-career-test.mjs --postgres` — real migration and restart.
