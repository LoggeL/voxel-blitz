# BIKINI BOTTOM: final BUILD SPEC (map judge + architect)

- **Map:** `bikini_bottom`, "Bikini Bottom", label `BIKINI BOTTOM`.
- **Size:** 128×40×96 with `GROUND = 14`. `dimensions.js` needs no change.
- **Modes:** `COMBAT_MODE_IDS`, capacity 12.
- **Salt:** `20260922`.

All geometry is original, procedural voxel work inspired by the show. No assets, meshes, textures, logos or audio are copied. Place names are used only as labels. Landmark names avoid character names ("Pineapple", "Moai House", "Rock Home", "Boating School").

**Verified reference model:** `reference-model.py` (this folder)
- It is a Python mirror of every collision-relevant voxel in this spec.
- Run it with `python3 model.py --ascii`.
- On this spec it reports:
  - 0 cross-region writes and 0 overlaps;
  - every spawn anchor open-sky, with nothing solid within Chebyshev 2;
  - 6/6 power-ups pass (pad, sky, spawn distance ≥ 13.0, open directions 10–14 of 16);
  - 4/4 signs have solid non-glass backing with air in front;
  - 3/3 TTT buttons are valid and reachable;
  - all 14 landmarks are reachable;
  - 0 bot-roam columns are unreachable under `standHeights [13,17]`;
  - the longest open chest-height axis line outside the spawn strips is 57.

Implementers should treat the model as the tie-breaker when prose is ambiguous, and must keep their JS consistent with it. They must not edit it into disagreement.

---

## 0. Judging

| Concept | Creativity & delight | Landmark detail | Competitive play | Engine feasibility | Boot cost | Σ |
|---|---|---|---|---|---|---|
| **map-competitive** | 7 | 7 | 9 | 8 | 9 | **40** (winner, base) |
| map-fidelity | 8 | 10 | 6 | 6 | 7 | 37 |
| map-playful | 10 | 8 | 5 | 5 | 6 | 34 |

**competitive** was the only concept with rigorous point symmetry, equal site access, rotation timings, and a sightline and prop-height discipline that respects `heightAt` and bot roaming. Defects I found and fixed in the synthesis:

| Defect | Fix |
|---|---|
| x48 and x79 were fully open 68-voxel N-S lines through both lots, missed by its own audit. | Crate/barrel stacks added in both lots. |
| Defender anchor (48,21) was 2 cells from the pineapple shell. | Moved to (50,22). |
| Conch-sculpture ring tops at T+3 and the lobster-tank top at T+2 were unreachable roam targets. | Retopped. |
| The kelp checkerboard created sealed 1-cell pockets. | Staggered pattern. |
| Dome glass spilled into the road and the spawn strip. | Glass clamped to `d<7.3`, and the Treedome centre moved to (87, 74.5). |
| The fields coral-tree crowns sat 2 cells from fun anchor (101,73). | Trees re-seated. |
| "Tiki Head" is a character-adjacent name. | Now "Moai House". |
| The school sign title "MRS. PUFF'S" is a character name. | Now "BOATING SCHOOL". |

**fidelity** had the best silhouettes: pineapple floors and crown, moai face, a rock lid you can stand under, a lobster-trap Krusty Krab with a flag, a bucket with a handle, a treedome with ribs, a galleon, and boat-cars. Its layout was lopsided and costly:
- The Krusty Krab faced the defenders.
- The Rock Bottom trench dropped to −3.
- A power-up sat on a swim-only island.
- Several props shared cells.

**playful** had the best toys: a flume, bus portals, ladders and Rock Bottom. However:
- The portals and a 40-deep underground carve are invisible to bots and expensive.
- The flume was reachable by ladder only.
- Its `standHeights` ≤21 rule was fragile.

**Grafted into the winner**

| Source | Graft |
|---|---|
| fidelity | Pineapple interior (two floors, props, portholes, a crown of 8 blades plus a spike, and "eye" nubs) |
| fidelity | Moai face (lips, nose awning, eyes, brow, ears, moss) |
| fidelity | Rock Home terraces with a propped lid, a weathervane and a mailbox |
| fidelity | Krusty Krab gable roof with lattice skylights, ridge, chimney, mast and voxel flag |
| fidelity | Treedome PALE meridian ribs, glass "zipper" collapse and oak crown |
| fidelity | Wreck cove sail and mast |
| fidelity | Boat-car detail |
| fidelity | Sky flowers, anglerfish lures and the lab-screen glow in the details module |
| playful | **Boating School flume**: `meta.slides`, from the school deck into Goo Lagoon, redesigned so it needs no ladder and all trough voxels sit at y≥18, which is outside bot roam |
| playful | **Chum Lab** under the Chum Bucket plinth: a dead-end TTT hideout with a GLASS periscope tile in the site-B floor |
| playful | Beach toys, boat traffic outside the wall, and flume sheen as client-only details |

**Left out on purpose**

- Rock Bottom (trench or portal), because of bot and portal cost and asymmetry.
- Ladders.
- Catwalk perches.
- A voxel `BB_JELLY` block; the jellies are client-only and animated.
- `LARGE_MAP_LIGHTS`, which are an optional phase 2 in §12.

---

## 1. Global rules (every implementer)

### 1.1 Coordinates and heights

- `T = GROUND = 14`. "h n" / "T+n" means voxel **y = 14+n**. A player standing on top of T+n has feet at `14+n+1.02`.
- North is low z.
  - Bravo, TDM-bravo and S&D defenders are **north** (z 3-13).
  - Alpha, TDM-alpha and S&D attackers are **south** (z 82-92).
- `P(x,z) = (127-x, 95-z)` is the point twin (Caldera `mirroredBox`). All gameplay footprints in the core, the lanes and the lots are P-symmetric. Landmark art differs.
- The playable interior is x 3..124, z 3..92. The METAL shell comes from `generateFlatBase`, and only its inner face cells (x=2, x=125, z=2, z=93) are re-dressed (§3.2).

### 1.2 Bot roam and the prop-height rule

The map meta sets `standHeights: [GROUND - 1, GROUND + 3]`, which is **[13, 17]**. It sets no `navigationFloor`, so the map goes in the legacy list at `tools/large-map-navigation-test.mjs:158`.

With that roam window, every **free-standing top** of a voxel column must be one of these:
- **T+1** (y15);
- **T+2 or T+3** (y16-17) **only if** it is reachable by 1-voxel steps from ground;
- **≥ T+4** (y ≥ 18).

The last case is not a roam target: the school deck (y18), the flume (y18-19), roofs, lids, canopies and tall props.

Glass, water and leaves count as tops (`heightAt` is "top non-AIR").

### 1.3 Clearances and keep-outs

- **Spawn anchors:** nothing solid above y14 within Chebyshev 2 of any anchor, and the anchor column stays open to the sky. Polish and scatter skip Chebyshev ≤ 3.
- **Power-up pads:** the 3×3 pad stays solid, with 2 air above. The centre column is AIR up to y39.
- **Landmark cells:** each landmark cell keeps 2 air above its `floorY`.

### 1.4 Determinism and materials

- **Determinism:** no `Math.random`. For per-voxel variation use `hashBB(x,y,z,salt)`, a clone of `hashC` in `setpiece-caldera.js:21-32`. Each file gets its own salt:

  | File | Salt |
  |---|---|
  | core | 20260922 |
  | R1 | 20260923 |
  | R2 | 20260924 |
  | R3 | 20260925 |
  | R4 | 20260926 |
  | R5 | 20260927 |

  Hashed decoration may **only swap the material of an already-solid cell or recolour floor paint**. It never changes a height.
- **Region discipline:** a region builder writes y > 14 **only inside its own rectangle** (§2). All region builders may write y ≤ 14 (floor paint, water carve) inside their own rectangle only.
- **Glass and leaves:** they chain-collapse upward when the block under them dies (`combat.js:412-421`). That is used on purpose on the Treedome drum and the lobster tank. Never put gameplay-critical floors on GLASS, except the Chum Lab periscope tile, which is intentional.

### 1.5 Helper snippet

Paste this local helper into each region file; there is no shared helper module, so parallel work stays independent:

```js
import { GROUND } from './blocks.js';
import { fillBox, paintFloor } from './flatmaps.js';
const T = GROUND;
const SALT = 2026092X;                       // per-file salt, see 1.4
function hashBB(x, y, z) {                   // clone of setpiece-caldera.js hashC with SALT
  let h = (SALT ^ Math.imul(x + 1013, 0x27d4eb2f) ^ Math.imul(y + 7919, 0x9e3779b1) ^ Math.imul(z + 31337, 0x85ebca6b)) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d); h = Math.imul(h ^ (h >>> 12), 0x297a2d39); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}
/** Inclusive box, heights relative to GROUND (h0/h1 are "T+n"). */
const tbox = (w, x0, h0, z0, x1, h1, z1, m) => fillBox(w, Math.min(x0, x1), T + Math.min(h0, h1), Math.min(z0, z1),
  Math.max(x0, x1), T + Math.max(h0, h1), Math.max(z0, z1), m);
const P = (x, z) => [127 - x, 95 - z];
```

---

## 2. Build regions, owners, order

| Owner | File / exported function | Bounds (inclusive) | Contents |
|---|---|---|---|
| **CORE** | `shared/world/flatmap-bikini-bottom.js`, `generateBikiniBottomInto(world, blocks, heights)` plus local `dressReefBoundary`, `paintSeafloor`, `buildOuterLanes`, `buildRoadSculptures`, `buildSpawnStrips`, `polishBikiniBottom` | everything not in R1-R5: spawn strips z3-13 and z82-92 (all x); roads z28-33 and z62-67 (x3-124); outer lanes x3-14 and x113-124 (all z); shell faces | base, reef boundary, seafloor and road paint, lane blockers, conch sculptures, spawn-strip coral heads and tide rocks, polish |
| **R1 North, "Conch Street houses"** | `shared/world/setpiece-bikini-bottom-conch.js`, `buildConchStreetHouses(world)` | x15-112, z14-27 | Kelp Grove, Pineapple, Moai House, yard hedges, Rock Home, Anchor Yard |
| **R2 West downtown, "Krusty Krab" (site A)** | `shared/world/setpiece-bikini-bottom-krab.js`, `buildKrustyKrab(world)` | x15-49, z34-61 | Krusty Krab, back lot, front patio, A lot |
| **R3 Mid, "Boating School"** | `shared/world/setpiece-bikini-bottom-school.js`, `buildBoatingSchool(world)` | x50-77, z34-61, **plus the flume corridor** (§8.6) | school hull, deck, wheelhouse, stairs, boat-bus, shake shack, bus-stop pole, flume trough and stilts |
| **R4 East downtown, "Chum Bucket" (site B)** | `shared/world/setpiece-bikini-bottom-chum.js`, `buildChumBucket(world)` | x78-112, z34-61 | plinth, bucket ring, gatehouse, handle, stairs, lab, B lot |
| **R5 South quarter** | `shared/world/setpiece-bikini-bottom-south.js`, `buildSouthQuarter(world)` | x15-112, z68-81 | Wreck Cove, Goo Lagoon, Coral Pinnacle, Treedome, Jellyfish Fields |
| **Data** (CORE creates it first) | `shared/world/bikini-bottom-data.js` (no imports) | — | `BIKINI_BOTTOM_FLUME` constant, used by the R3 geometry and by `metadata.js` |

**Flume corridor (R3-exclusive).**
- R3 owns every cell in the trough footprint listed in §8.6 at **y ≥ 17**, which is x43-58, z57-77. R3 also owns the three stilt columns (55,60), (50,68) and (47,75) at all heights.
- R2, R5 and CORE must write **nothing above y14** in the corridor rows below, apart from their own floor paint:

  | Rows | x range |
  |---|---|
  | z57-61 | x51-58 |
  | z62-67 | x47-56 (CORE road; paint only) |
  | z68-77 | x43-52 |

**Build order** in `generateBikiniBottomInto`:
1. `generateFlatBase`
2. `dressReefBoundary`
3. `paintSeafloor`
4. `buildOuterLanes`
5. `buildRoadSculptures`
6. `buildSpawnStrips`
7. `buildConchStreetHouses`
8. `buildKrustyKrab`
9. `buildBoatingSchool`
10. `buildChumBucket`
11. `buildSouthQuarter`
12. `polishBikiniBottom` (LAST)

Regions are disjoint, so the order among the R builders does not matter. Every R builder runs after the core paint, so R builders overwrite core floor paint inside their rectangles.

**Suggested assignment for 4 parallel implementers**

| Agent | Scope |
|---|---|
| **A1 CORE and integration** | `blocks.js` and every registration in §3.1, landed **first**. `bikini-bottom-data.js`. `flatmap-bikini-bottom.js`. All metadata and registry edits (§10). Signs, atmosphere, traps, shots, HUD labels, tests, preload, docs, pins. |
| **A2 Landscape** | R1 and R5. |
| **A3 Sites** | R2 and R4. |
| **A4 Mid and client** | R3, the flume, and `public/js/engine/bikini-bottom-details.js` plus the `worldview.js` wiring (§11). |

Before A1's `blocks.js` lands, A2-A4 code against the `BB_*` names from §3.1 and run only the Python model.

### 2.1 Region ownership overview (1 char = 2×2 voxels)

```
      0    1    2    3    4    5    6    7    8    9    0    1    2   
z00   ################################################################
z02   ################################################################
z04   ##LLLLLLsssssssssssssssssssssssssssssssssssssssssssssssssLLLLLL#
z06   ##LLLLLLsssssssssssssssssssssssssssssssssssssssssssssssssLLLLLL#
z08   ##LLLLLLsssssssssssssssssssssssssssssssssssssssssssssssssLLLLLL#
z10   ##LLLLLLsssssssssssssssssssssssssssssssssssssssssssssssssLLLLLL#
z12   ##LLLLLLsssssssssssssssssssssssssssssssssssssssssssssssssLLLLLL#
z14   ##LLLLLL1111111111111111111111111111111111111111111111111LLLLLL#
z16   ##LLLLLL1111111111111111111111111111111111111111111111111LLLLLL#
z18   ##LLLLLL1111111111111111111111111111111111111111111111111LLLLLL#
z20   ##LLLLLL1111111111111111111111111111111111111111111111111LLLLLL#
z22   ##LLLLLL1111111111111111111111111111111111111111111111111LLLLLL#
z24   ##LLLLLL1111111111111111111111111111111111111111111111111LLLLLL#
z26   ##LLLLLL1111111111111111111111111111111111111111111111111LLLLLL#
z28   ##=============================================================#
z30   ##=============================================================#
z32   ##=============================================================#
z34   ##LLLLLL2222222222222222233333333333333444444444444444444LLLLLL#
z36   ##LLLLLL2222222222222222233333333333333444444444444444444LLLLLL#
z38   ##LLLLLL2222222222222222233333333333333444444444444444444LLLLLL#
z40   ##LLLLLL2222222222222222233333333333333444444444444444444LLLLLL#
z42   ##LLLLLL2222222222222222233333333333333444444444444444444LLLLLL#
z44   ##LLLLLL2222222222222222233333333333333444444444444444444LLLLLL#
z46   ##LLLLLL2222222222222222233333333333333444444444444444444LLLLLL#
z48   ##LLLLLL2222222222222222233333333333333444444444444444444LLLLLL#
z50   ##LLLLLL2222222222222222233333333333333444444444444444444LLLLLL#
z52   ##LLLLLL2222222222222222233333333333333444444444444444444LLLLLL#
z54   ##LLLLLL2222222222222222233333333333333444444444444444444LLLLLL#
z56   ##LLLLLL2222222222222222233fff333333333444444444444444444LLLLLL#
z58   ##LLLLLL222222222222222223ffff333333333444444444444444444LLLLLL#
z60   ##LLLLLL22222222222222222fffff333333333444444444444444444LLLLLL#
z62   ##=======================ffff==================================#
z64   ##======================ffff===================================#
z66   ##======================fff====================================#
z68   ##LLLLLL555555555555555ffff555555555555555555555555555555LLLLLL#
z70   ##LLLLLL555555555555555fff5555555555555555555555555555555LLLLLL#
z72   ##LLLLLL55555555555555ffff5555555555555555555555555555555LLLLLL#
z74   ##LLLLLL55555555555555ffff5555555555555555555555555555555LLLLLL#
z76   ##LLLLLL55555555555555fff55555555555555555555555555555555LLLLLL#
z78   ##LLLLLL5555555555555555555555555555555555555555555555555LLLLLL#
z80   ##LLLLLL5555555555555555555555555555555555555555555555555LLLLLL#
z82   ##LLLLLLsssssssssssssssssssssssssssssssssssssssssssssssssLLLLLL#
z84   ##LLLLLLsssssssssssssssssssssssssssssssssssssssssssssssssLLLLLL#
z86   ##LLLLLLsssssssssssssssssssssssssssssssssssssssssssssssssLLLLLL#
z88   ##LLLLLLsssssssssssssssssssssssssssssssssssssssssssssssssLLLLLL#
z90   ##LLLLLLsssssssssssssssssssssssssssssssssssssssssssssssssLLLLLL#
z92   ##LLLLLLsssssssssssssssssssssssssssssssssssssssssssssssssLLLLLL#
z94   ################################################################
```

**Legend**

| Char | Meaning |
|---|---|
| `#` | shell |
| `s` | CORE spawn strip |
| `L` | CORE outer lane |
| `=` | CORE road |
| `1` … `5` | R1 … R5 |
| `f` | R3 flume corridor |

---

## 3. CORE

### 3.1 New blocks

New block ids are 86-95, on atlas slots 79-88. Painters are pure 16×16 `(x,y)=>[r,g,b,a]` functions in the Waterworld cartoon style, using the helpers `dustColor` and `dustGrain` from `atlas.js`.

| id | const | tile slot | HP / hardness / blast / mining | render | footstep / dig | impact tint | painter |
|---|---|---|---|---|---|---|---|
| 86 | `BB_SAND` | 79 | 70 / 16 / 16 / 2 | opaque | sand / sand (SOFT) | `0xe8dcb0` | cream `#e8dcb0` with 2×2 `dustGrain` ±3 and a ±4 ripple `sin((x+y)*0.4)`; faint 2×2 shell tints (hash on x>>1, y>>1): `<0.02` `#ced8ce`, `<0.04` `#eed0c0` |
| 87 | `BB_CORAL` | 80 | 220 / 65 / 82 / 5 | opaque | stone / stone | `0xe87a8c` | pink `#e87a8c` with faint mottling; one pore candidate per staggered 4 px cell, kept where the cell hash < 0.6 and nudged ±1 px, colour `#b8566a`, with a `#f6a0ae` rim on the pixel above; soft 0.96 edge ring |
| 88 | `BB_PINEAPPLE` | 81 | 120 / 32 / 42 / 4 | opaque | wood / wood (SOFT) | `0xf0a030` | orange `#f0a030`; diamond lattice where `(x+y)%8==0 \|\| (x-y+16)%8==0` in `#c97a1c`; cream dot `#fff1bf` where `(x+y)%8==4 && (x-y+16)%8==4` |
| 89 | `BB_PINE_LEAF` | 82 | 30 / 8 / 10 / 1 | **CUTOUT** | grass / grass (SOFT) | `0x3f9a4a` | blades on columns `x%4∈{1,2}` in `#3f9a4a`, midrib `x%4==2` in `#6cc070`; alpha 0 elsewhere and where `y < (x*7)%5` (ragged tips) |
| 90 | `BB_KELP` | 83 | 10 / 4 / 6 / 1 | **CUTOUT** | grass / grass (SOFT) | `0x2f6f3a` | ribbon: opaque where `abs(x-7.5-2*sin(y*0.8)) < 4.5`, colour `#2f6f3a`, midrib `#4f9a5a` within 1 px of the centre, gold bladder `#c9b44a` where `y%8==3` on the centre; alpha 0 outside |
| 91 | `BB_MOAI` | 84 | 320 / 90 / 110 / 7 | opaque | stone / stone | `0x7d93a6` | blue-grey `#7d93a6` with `dustGrain` ±8, pits (`hash<0.06`) `#5f7385` |
| 92 | `BB_ROCK` | 85 | 380 / 100 / 120 / 8 | opaque | stone / stone | `0x8a5a3c` | 3-tone brown mottle (`dustGrain(x>>2, y>>1)` over `#80543a`/`#8a5a3c`/`#946242`), 2×1 speckles `#a8764f`, short hash-placed cracks `#5e3b27` kept off the tile edges; soft 0.96 edge ring |
| 93 | `BB_HULL` | 86 | 110 / 30 / 40 / 3 | opaque | wood / wood (SOFT) | `0x6b5238` | 4 px planks `#6b5238` with seam `y%4==0` in `#4a3826`, teal stripe `y%8==2` in `#3f8f8a`, nails `x%8==1&&y%4==2` in `#2e241a` |
| 94 | `BB_CHUM` | 87 | 420 / 110 / 140 / 8 | opaque | metal / metal (HARD_METAL) | `0x5d6b70` | gunmetal `#5d6b70`, bevel `x==0\|\|y==0` in `#7a8a90`, shadow `x==15\|\|y==15` in `#3e484c`, rivets at (2,2), (13,2), (2,13), (13,13) in `#c9d2d6` |
| 95 | `BB_ROAD` | 88 | 300 / 85 / 112 / 8 | opaque | stone / stone | `0x9fb4c0` | warm blue-grey `#8492a0` with `dustGrain` ±6, sparse dark grit (`hash<0.02`) `#707c88`; lane dashes are voxel paint (PALE) |

- Blast 140 on `BB_CHUM` means rockets (210) and frags (165) can breach the bucket. Hardness ≥ 50 ricochets bullets on coral, moai, rock, chum and road.

**Registration checklist** (guide §1.8):
- `blocks.js`: consts, `BLOCK_HP`, `BLOCK_HARDNESS`, `GRENADE_RESISTANCE` and `MINING_HITS`.
- `worlddata.js` re-export.
- `atlas.js`: import, `TILE`, `TILE_PAINTERS`, `DEFAULT_BLOCK_TILES` (all faces the same tile), and `NO_RING_DARKEN` for `BB_PINE_LEAF` and `BB_KELP`.
- `chunks.js` `CUTOUT`: add `BB_PINE_LEAF` and `BB_KELP`. There are no TRANSLUCENT additions.
- `impacts.js` `BLOCK_TINTS`.
- `footsteps.js`.
- `pickaxe.js` `SOFT`, `HARD_METAL` and `DIG_GROUPS`.
- `tools/pickaxe-audio-test.mjs:133`: `type <= 85` becomes `type <= 95`, and `digGroups` gets the new names.
- `BUILD-CONTRACT.md:1113` "28 destructible materials" becomes 38.

None of the new blocks are passable.

### 3.2 `dressReefBoundary`

For each inner shell face cell (x=2 and x=125 for z 3..92; z=2 and z=93 for x 2..125) and each y from 15 to 32, let `rise = y-14` and `along` = x for the z faces or z for the x faces. Apply these rules in order; later rules override earlier ones:

1. Let `n` be smooth 2D value noise over (along/7, rise/4) from the core hash, plus `0.2*(hash(x,y,z) - 0.5)` for a ragged edge. Use `BB_CORAL` where `n > 0.8`, `BB_MOAI` where `n < 0.15` and `rise ≤ 9` (low boulders), and `BB_ROCK` elsewhere. This gives coral and stone patches, not straight bands (post-review; the old rule painted coral at exactly rise 7, 8 and 13 all the way round).
2. Kelp stands in hash-picked columns (about 9%, sometimes two adjacent): `BB_KELP` from above the sand line up to a rise of 5-14.
3. The `PALE` sand line is rise 1, drifting up to rise 2 in hash-picked 4-cell runs.

The client remaps the untouched `METAL` shell (the y33-39 parapet and the cells behind wall kelp) to the `BB_ROCK` tile through `MAP_SURFACES.bikini_bottom`, which is safe because the map places no `METAL` inside the reef (asserted in `tools/bikini-bottom-test.mjs`).

### 3.3 `paintSeafloor` (y = 14 only)

1. Paint `BB_SAND` over x3-124, z3-92.
2. Paint `BB_ROAD` over x3-124 on the **north road "Conch Street" z28-33** and the **south road "Jellyfish Trail" z62-67**.
3. Add `PALE` centre dashes at z31 and z64 where `x%8<4`.
4. Add `PALE` crosswalk bars on alternate z rows:

   | Road | Rows | Crossing | x |
   |---|---|---|---|
   | North | z28, 30, 32 | KK back door | x24-27 |
   | North | z28, 30, 32 | B north stair | x100-103 |
   | South | z63, 65, 67 | KK front | x24-27 |
   | South | z63, 65, 67 | B south stair | x100-103 |
   | South | z63, 65, 67 | B SE stair | x107-109 |

### 3.4 `buildOuterLanes` (west side authored; every item also placed at its P twin)

| Item | West cells | Build |
|---|---|---|
| Kelp thicket | x10-14, z18-22 | `BB_KELP` 1×1 columns T+1..T+8 where `(x%2==0 && z%4==0) \|\| (x%2==1 && z%4==2)` (staggered; every x column has a stalk, no sealed pockets). Twin x113-117, z73-77 |
| Reef boulder | x3-8, z29-33 | `BB_ROCK` terraces: x3-4 T+1..T+3, x5-6 T+1..T+2, x7-8 T+1. Twin x119-124, z62-66 (x123-124 T+3, x121-122 T+2, x119-120 T+1) |
| Giant clam | x5-9, z48-51 | lower shell `PALE` T+1 over x5-9 z48-51; upper shell `BB_CORAL` x5 T+2..T+6 and x6 T+5..T+6; pearl `PALE` (7, T+2, 49-50). Twin x118-122, z44-47 |
| Overturned rowboat | x9-14, **z62-67** | `BB_HULL` T+1; keel `BB_HULL` T+2 on x10-13, z64-65. Twin x113-118, z28-33 |
| Urchin mound | x3-7, z74-78 | `BB_CORAL` T+1; spikes `BB_CORAL` T+2..T+5 where `(x+z)%3==0`. Twin x120-124, z17-21 |

### 3.5 `buildRoadSculptures`: conch shells on the road centres

- N1 is x60-62, z28-31. N2 is x65-67, z30-33.
- Twins: S1 = P(N1) is x65-67, z64-67. S2 = P(N2) is x60-62, z62-65.

For each box `(a0,b0)-(a1,b1)`:
- `PALE` T+1..T+4 over the full footprint;
- a `BB_CORAL` band at T+2 over the full footprint;
- a `PALE` spire T+5..T+6 on `(a0+1..a1, b0+1..b1-1)`;
- a `BB_CORAL` tip at T+7 on `(a0+1, b0+1)`.

Every column top is ≥ T+4. The shells split both roads at the centre.

### 3.6 `buildSpawnStrips`

- **Coral heads** break the spawn-row sightlines. Each head is 2×3 cells: `BB_CORAL` T+1..T+4 with a `PALE` "polyp" top at T+4.

  | Row | x pairs | z |
  |---|---|---|
  | North | 12-13, 27-28, 41-42, 58-59, 68-69, 85-86, 99-100 | 7-9 |
  | South (their P twins) | 114-115, 99-100, 85-86, 68-69, 58-59, 41-42, 27-28 | 86-88 |

- **Tide rocks:** 1-high `BB_ROCK` at T+1 on x26-29, x44-47, x80-83 and x98-101, at z12 and at z83.

### 3.7 `polishBikiniBottom` (LAST)

- **Recolour only.** Change only y14 cells that are `BB_SAND` or `BB_ROAD` and have AIR at y15.
- **Skips:** Chebyshev ≤ 3 of every spawn anchor (all pools), ≤ 2 of every power-up pad centre and landmark cell, and all road cells within 1 of a PALE dash.
- **Sand ripple:** where `(x + 2*round(3*sin(z*0.35))) % 7 == 0` on `BB_SAND` outside the fields and lagoon rectangles, recolour to `PALE` if `hash<0.5`.
- **Scatter:** use `mulberry32(20260922)` for 260 draws. On sand, recolour to `BB_CORAL` (6%) or `GRASS` (10%, as a "sea-grass tuft"). On road, recolour to `STONE` (5%).
- Polish never adds height.

### 3.8 Generator skeleton

```js
// shared/world/flatmap-bikini-bottom.js
import { mulberry32 } from '../noise.js';
import { GROUND, SX, SZ, SY, AIR, PALE, STONE, GRASS, BB_SAND, BB_ROAD, BB_ROCK, BB_CORAL, BB_KELP, BB_HULL } from './blocks.js';
import { fillBox, generateFlatBase, paintFloor } from './flatmaps.js';
import { MAP_SPAWN_ANCHORS } from './metadata.js';     // safe: metadata.js does not import flatmaps
import { buildConchStreetHouses } from './setpiece-bikini-bottom-conch.js';
import { buildKrustyKrab } from './setpiece-bikini-bottom-krab.js';
import { buildBoatingSchool } from './setpiece-bikini-bottom-school.js';
import { buildChumBucket } from './setpiece-bikini-bottom-chum.js';
import { buildSouthQuarter } from './setpiece-bikini-bottom-south.js';
export function generateBikiniBottomInto(world, blocks, heights) {
  generateFlatBase(world, blocks, heights);
  dressReefBoundary(world); paintSeafloor(world); buildOuterLanes(world);
  buildRoadSculptures(world); buildSpawnStrips(world);
  buildConchStreetHouses(world); buildKrustyKrab(world); buildBoatingSchool(world);
  buildChumBucket(world); buildSouthQuarter(world);
  polishBikiniBottom(world);
}
```

```js
// shared/world/bikini-bottom-data.js  (no imports; read by metadata.js and setpiece-bikini-bottom-school.js)
export const BIKINI_BOTTOM_FLUME = Object.freeze({
  id: 'boating-flume', speed: 5.4,   // ride = 5.4 * SLIDE_RULES.boost 1.5 ≈ 8.1 v/s
  path: Object.freeze([[56.5, 20.1, 55.5], [56.5, 20.0, 58.5], [53.5, 19.8, 62.5], [50.5, 19.6, 66.5],
    [49.0, 19.4, 71.0], [47.5, 19.3, 74.5], [44.5, 19.2, 75.5]].map(Object.freeze)),
});
```

---

## 4. Top-down map (1 char = 1 voxel, rows z3..92)

Each cell shows the **top-most** block of its column, so roofs, crowns and domes hide what is under them.

```
       0         1         2         3         4         5         6         7         8         9         0         1         2       
       01234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456789012345678901234567
z=3    ###..........................................................................................................................###
z=4    ###..........................................................................................................................###
z=5    ###..........................................................................................................................###
z=6    ###..........................................................................................................................###
z=7    ###.........pp.............pp............pp...............pp........pp...............pp............pp........................###
z=8    ###.....*...pp....N........pp.......N....pp...........N...pp....*...pp...N...........pp....N.......pp........N...............###
z=9    ###.........pp.............pp............pp...............pp........pp...............pp............pp........................###
z=10   ###..........................................................................................................................###
z=11   ###..........................................................................................................................###
z=12   ###.......................oooo..............oooo........d..............d........oooo..............oooo.......................###
z=13   ###..........................................................................................................................###
z=14   ###........................................................MMMMMMMMMM...........................rr........ww.................###
z=15   ###................|....|....|........PPPPP................MMMMMMMMMM..................ooo......rr........ww.................###
z=16   ###................||...||...||.....PPPPlPPPP..............MMMMMMMMMM................ooooooo....rr........ww.rrr.............###
z=17   ###................................PlPPPlPPPlP.............MMMMMMMMMM...............ooooooooo...rrrrrrrrrrrrrr.r........yyyyy###
z=18   ###........|.|...|.................PPlPPlPPlPP.............MMMMMMMMMM..............ooooooooooo..rrrrrrrrrrrrrr.r........yyyyy###
z=19   ###..............||...............PPPPlPlPlPPPP...........MMMMMMMMMMMM.............oooooaooooo..rr........ww.rrr........yyyyy###
z=20   ###.......|.|.|...................PPPPPlllPPPPP...........MMMMMMMMMMMM............ooooooooooooo.rr........ww............yyyyy###
z=21   ###...............................PlllllllllllP...........MMMMMMMMMMMM.........d..ooooooooooooo.rr........ww............yyyyy###
z=22   ###........|.|.....|......*.......PPPPPlllPPPPP...d........MMMMMMMMMM.............ooooooooooooo......d.......................###
z=23   ###................||.............PPPPlPlPlPPPP............MMMMMMMMMM..............ooooooooooo...............rrr.............###
z=24   ###.............ooo.....d..........PPlPPlPPlPP.............MMMMMMMMMM..............ooooooooooo........*.....wrrr.............###
z=25   ###.............ooo................PlPPPlPPPlP..............MMMMMMMM................ooooooooo................rrr.............###
z=26   ###.............ooo.................PPPPlPPPP....yyyyy.........MM.........yyyyy......ooooooo.................................###
z=27   ###...................................PPPPP.h.........................................hooo...................................###
z=28   ###=========================================================ppp==================================================hhhhhh======###
z=29   ###oooooo===================================================pyp==================================================hhhhhh======###
z=30   ###oooooo===================================================ppp==ppp=============================================hhhhhh======###
z=31   ###oooooo---====----====----====----====----=+==----====----ppp=-pyp====----====--+-====----====----====----====-hhhhhh=----=###
z=32   ###oooooo========================================================ppp=============================================hhhhhh======###
z=33   ###oooooo========================================================ppp=============================================hhhhhh======###
z=34   ###.........................rrrr...........................cccccccccc..........................kkk..CCCC.....................###
z=35   ###.............w...........rrrr...w......................pcccccccccc..........................kkk..CCCC.....................###
z=36   ###............KKKKKKKKKKKKKKKKKKKKKKK..................w.pcccccccccc...............................CCCC.....................###
z=37   ###............KKKKKKKKKKKKKKKKKKKKKKK.........www........pcccccccccc......................CCCCCCCCrrrrrrCCCCCCCC............###
z=38   ###............KKKKKKKKKKKKKKKKaaKKKKK.........www.........cccccccccc.................yyy..CCCCCrrrrrrrrrrrrCCCCC............###
z=39   ###............KKKKKKKKKKKKKKKKaaKKKKK.................pppppphhhhhhpppppp.............y|y..CCCCrrrCCCCCCCCrrrCCCC............###
z=40   ###............KKKKKKKKKKKKKKKKKKKKKKK................pkkkkkkkkkkkkkkkkkkp............yyy..CCCrrCCCCCCCCCCCCrrCCC............###
z=41   ###.......*....KKKKKKKKKKKKKKKKKKKKKKK..ccccc.........pkkkkkkkkkkkkkkkkkkhpppp...ccc.......CCrrCCCCCCCCCCCCCCrrCC............###
z=42   ###............KKKKKKKKKKKKKKKKKKKKKKK..cgggc.........pkk+kkkkkkkkkkkkkkkhpppp...cgc.......CrrCCppppppppgpppCCrrC............###
z=43   ###............k..........hhhh......k...ccccc.........pkkkkkkkkkkkkkkkkkkhpppp...cgc.......CrrCCppppppppCgCpCCrrC............###
z=44   ###............kkkkkkkkkkkkkkkkkkkkkkk................pkkkkkkkkkkkkkkkkkkhpppp...cgc.......CrCCCprrpppppppppCCCrC.....pppyy..###
z=45   ###............k.....kk.........ww..k.................pkkkkkkhhhhhhkkkkkkp.......ccc.CCCCCCrrCCCppppppppppppCCCrr.....pppyy..###
z=46   ###............kkkkkkkkkkkkkkkkkkkkkkk................pkkkkkkhhhhhhkkkkkkp...........CCCCCCrrCCCppppprrpppppCCCrr.....pppyy..###
z=47   ###............wwwwwwwwwwwccccwwwwwwww.......*........pkkkkkkhhaahhkkkkkkp...........CCCCCCrrrrrrrrrrrrrrrrrrrrrr.....pppyy..###
z=48   ###..yyppp.....wwwwwwwwwwwwwwwwwwwwwww................pkkkkkkhhaahhkkkkkkp........*..CCCCCCrrrrrrrrrrrrrrrrrrrrrr............###
z=49   ###..yyppp.....k.........gg.........k.................pkkkkkkhhhhhhkkkkkkp...........CCCCCCrrCCCppppprrpppppCCCrr............###
z=50   ###..yyppp.....kkkkkkkkkkkkkkkkkkkkkkk......ccc.......pkkkkkkhhhhhhkkkkkkp...........CCCCCCrrCCCrrppppppppppCCCrr............###
z=51   ###..yyppp.....k.....kk.............k.......cgc...pppphkkkkkkkkkkkkkkkkkkp.................CrCCCrrrppppppprpCCCrC............###
z=52   ###............kkkkkkkkkkkkkkkkkkkkkkk......cgc...pppphkkkkkkkkkkkkkkkkkkp.........ccccc...CrrCCpppgpppppgppCCrrC............###
z=53   ###............KKKKKKKKKKKKKKKKKKKKKKK......cgc...pppphkkkkkkkkkkkkkkk+kkp.........cgggc...CrrCCppppppppppppCCrrC............###
z=54   ###............KKKKKKKKKKKKKKKKKKKKKKK......ccc...pppphkkkkkkkkkkkkkkkkkkp.........ccccc...CCrrCCCCCCCCCCCCCCrrCC....*.......###
z=55   ###............KKKKKKKKKKKKKKKKKKKKKKK.yyy............pkkkkkkkkkkkkkkkkkkp.................CCCrrCCCCCCCCCCCCrrCCC............###
z=56   ###............KKKKKKKKKKKKKKKKKKKKKKK.y|y.............hhhppphhhhhhpppppp..................CCCCrrrCCCCCCCCrrrCCCC............###
z=57   ###............KKKKKKKKKKKKKKKKKKKKKKK.yyy............fffffpypypypyyy.........ccc..........CCCCCrrrrrrrrrrrrCCCCC............###
z=58   ###............KKKKKKKKKKKKKKKKKKKKKKK...............ffffffpypypypyyyp........ccc..........CCCCCCCCrrrrrrCCCCCCCC............###
z=59   ###............KKKKKKKKKKKKKKKKKKKKKKK..............fffffffpypypypyyyp.....................................CCC...............###
z=60   ###.............xx............kkk.rrr..............ffffffffpypypypyyyp..........................rrrr.......CCC...............###
z=61   ###...........................kkk..................fffffff.pypypypyyy...........................rrrr.......CCC...............###
z=62   ###======hhhhhh===================================fffffff===ppp========================================================oooooo###
z=63   ###======hhhhhh==================================fffffff====pyp========================================================oooooo###
z=64   ###-====-hhhhhh=----====----====----====----=+==ffffffff----ppp=-ppp====----====--+-====----====----====----====----===oooooo###
z=65   ###======hhhhhh=================================fffffff=====ppp==pyp===================================================oooooo###
z=66   ###======hhhhhh=================================ffffff===========ppp===================================================oooooo###
z=67   ###======hhhhhh================================ffffff============ppp=========================================================###
z=68   ###..................................wkkkkk....ffffff...............................gggpggg..................................###
z=69   ###..................................pkkkkk....fffff...........yy..................ggggpgggg.................ooo.............###
z=70   ###.............xxx..............pyp.ppp......ffffff...........yy.................ppgggpgggpp..............llloo.............###
z=71   ###.............xxxw.....*.......ypy...~......ffffff.......yyyyyyyyyy............ggppggpggppgg............llyllo.............###
z=72   ###.............xxx..............pyp~~~~~~~..ffffff........yyyyyyyyyy............ggggggpgggggg............lyyyl..............###
z=73   ###................................~~~~~~~~~fffffff........yyyyyyyyyy...........gggggggpggggggg......*....llyll...|.|........###
z=74   ###yyyyy............ww........ww...~~~~~~~~~fffffff......yyyyyyyyyyyyyy.........ppgggggpgggggpp............lllll.............###
z=75   ###yyyyy............ww........ww..~~~~~~~~~~~fffff.......yyyyyyyyyyyyyy.........ppgggggpgggggpp.............llyll|.|.|.......###
z=76   ###yyyyy........www.ww........ww...~~~~~~~~~fffff........yyyyyyyyyyyyyy.........gggggggpggggggg.............lyyyl............###
z=77   ###yyyyy........w.whhhhhhhhhhhww...~~~~~~~~~.ff...sss......yyyyyyyyyy............ggggggpgggggg...lll..lll..lllyll.|.|........###
z=78   ###yyyyy........w.whhhhhwhhhhhww....~~~~~~~.......sss......yyyyyyyyyy............ggppggpggppgg..llyllllyllllylll.............###
z=79   ###.............www.ww..p.....ww.......~..pyp.....sss......yyyyyyyyyy.............ppgggpgggpp...lyyyllyyyllyyyl..............###
z=80   ###.................ww..p.....ww..........ypy..............yyyyyyyyyy..............ggggpgggg....llyllllyllllyll..............###
z=81   ###.................ww........ww..........pyp..............yyyyyyyyyy...............gggpggg......lll..lll..lll...............###
z=82   ###..........................................................................................................................###
z=83   ###.......................oooo..............oooo................................oooo..............oooo.......................###
z=84   ###..........................................................................................................................###
z=85   ###..........................................................................................................................###
z=86   ###........................pp............pp...............pp........pp...............pp............pp.............pp.........###
z=87   ###...............A.^......pp.....^.A....pp.....^.....A...pp...*....pp...A.....^.....pp....A.^.....pp......^.A....pp...*.....###
z=88   ###........................pp............pp...............pp........pp...............pp............pp.............pp.........###
z=89   ###..........................................................................................................................###
z=90   ###..........................................................................................................................###
z=91   ###..........................................................................................................................###
z=92   ###..........................................................................................................................###
```

**Legend**

| Char | Meaning |
|---|---|
| `#` | shell |
| `.` | sand floor |
| `=` | BB_ROAD |
| `-` | PALE road dash |
| `P` | BB_PINEAPPLE |
| `l` | BB_PINE_LEAF or LEAVES |
| `M` | BB_MOAI |
| `o` | BB_ROCK |
| `\|` | BB_KELP |
| `y` | BB_CORAL |
| `h` | BB_HULL |
| `C` | BB_CHUM |
| `r` | RUST |
| `p` | PALE, POOL_TILE_WHITE or ASPHALT |
| `k` | PLANK |
| `w` | WOOD or DUST_WOOD |
| `K` | ROOF |
| `c` | vehicle colours |
| `x` | crate or chest |
| `g` | GLASS |
| `f` | flume |
| `~` | water |
| `a` | ACCENT |
| `i` | MC_IRON |
| `s` | raised sand |

**Spawn and pickup markers**

| Char | Meaning |
|---|---|
| `*` | fun spawn |
| `N` | TDM bravo |
| `A` | TDM alpha |
| `d` | S&D defender |
| `^` | S&D attacker |
| `+` | power-up |

**Lanes, from the attacker (south) view**

| Lane | Route |
|---|---|
| A-Long | West lane x3-14 → z58-61 apron → KK front door (x24-27, z58) |
| A-Short | A lot x37-49 → KK drive-thru (x36, z46-49) |
| Mid | School (doors, deck, or bus/shack roofs as bridges) |
| B-Short | B lot x78-90 → west ramp (x85-90, z45-50) → ring west door |
| B-Long | East lane x113-124 → SE stair (x107-109, z59-61) → deck → ring south door |

**Defender entrances**
- KK back door (x24-27, z37).
- B north stair (x100-103, z34-36) → gatehouse door.

**Rotations**
- Through the school: about 60 voxels, about 9.7 s.
- Conch Street: about 95 voxels, about 15 s.
- Jellyfish Trail: about 93 voxels, about 15 s.

---

## 5. R1 North, "Conch Street houses" (x15-112, z14-27): `buildConchStreetHouses`

**Keep-outs**
- Anchors: def (24,24), (50,22), (79,21), (101,22); fun (26,22), (102,24).
- Landmark cells: (22,20), (40,21) (inside the ground room), (64,27), (88,23) (floor y17) and (103,21).

### 5.1 Kelp Grove (x15-33)

**Stalks** are `BB_KELP` 1×1 columns from T+1 to T+h, with `h = 7 + floor(hashBB(x,1,z)*5)`. They sit at:
- (29,16), (24,16), (19,16);
- (17,19), (19,23).

These are the P-images of the R5 coral trees.

Each stalk also gets:
- a frond at (x+1, T+5, z);
- a frond at (x, T+h-2, z-1).

**Coral boulder**, `BB_ROCK`, climbable:

| Cells | Height |
|---|---|
| x18, z24-26 | T+1 |
| x17 | T+1..T+2 |
| x16 | T+1..T+3 |

**Floor paint:** sand ripples.

### 5.2 Pineapple, centre (40,21)

With `d = hypot(x-40, z-21)` on integer cell coordinates, and loops over x33-47, z14-27:

- **Radius table** `r(h)`:

  | h | 1 | 2 | 3-9 | 10 | 11 | 12 | 13 | 14 | 15 |
  |---|---|---|---|---|---|---|---|---|---|
  | r | 5.5 | 6.0 | 6.5 | 6.2 | 5.8 | 5.2 | 4.4 | 3.4 | 2.2 |

- **Shell:** for h 1..10, cells with `r-1.2 < d ≤ r` are `BB_PINEAPPLE`.
- **Cap:** for h 11..15, the solid disc `d ≤ r` is `BB_PINEAPPLE`. The top is y29.
- **"Eye" nubs:** a shell cell becomes `DUST_WOOD` where `(h + round(atan2(z-21,x-40)*16/(2π))) % 4 == 0`. Apply this before the windows.
- **Upper floor slab:** h4 (y18), `PLANK`, for `d ≤ 5.3`. Stair hole: air at x43-44, z20-22, h4.
- **Stair:** `PLANK` solid fills.

  | z (at x43-44) | Top |
  |---|---|
  | 22 | h1 |
  | 21 | h2 |
  | 20 | h3 |

  From z20 you step onto the slab at z19.
- **Rooms:** the ground room is air at h1..h3 and the upper room is air at h5..h10.
- **Doors:** air at h1..h3 on x39-41. North door z14-17; south door z25-27. Any door column whose h4 cell is shell becomes a `WOOD` lintel.
- **Windows:** turn shell cells in these boxes to `GLASS`:

  | Heights | Boxes |
  |---|---|
  | h6..h7 (upper perch) | x39-41 z25-27 (south, watches Conch Street and the A lot); x34-35 z20-22 (west); x45-46 z20-22 (east) |
  | h2..h3 (ground portholes) | x34 and x46 at z20-21 |

- **Crown:** `BB_PINE_LEAF`.
  - Base x39-41, z20-22, h16..h17. Spike (40, h16..h23, 21), which tops out at y37.
  - 4 cardinal blades: for k=1..5, `(40+dx*k, h, 21+dz*k)` with h = 16, 17, 18, 18, 17.
  - 4 diagonal blades: for k=1..4, h = 16, 17, 17, 16.
- **Props** (all at `d ≤ 5`, clear of the door lanes x39-41 and the stair x43-44 z19-22):
  - Ground room:
    - TV: `PALE` x36-37, z18, h1..h2.
    - Coral lamp: `BB_CORAL` (36, h1..h2, 24).
    - Anchor armchair: `RUST` x42-43, z17, h1.
    - Floor paint: a `TRUCK_RED` rug of radius 2 at (40,21), y14.
  - Upper room:
    - Boat bed: `BB_HULL` x37-39, z18-20, h5, with `TRUCK_RED` covers on its z19 row.
    - Snail bowl: `POOL_TILE_BLUE` (43, h5, 24).
- **Mailbox:** `WOOD` (44, h1..h4, 27) with a `BB_HULL` box at h5.
- The cap and crown make `heightAt` ≥ y29, so the inside is never a roam target or a spawn.

### 5.3 Moai House (solid; the mid-north blocker)

All parts are `BB_MOAI` except where stated.

| Part | Cells | Height |
|---|---|---|
| Body | x59-68, **z14-24** | h1..h12 |
| Head | x60-67, z16-23 | h13..h16 (top y30) |
| Brow | x60-67, z25 | h10..h11 |
| Lips | x61-66, z25 | h4 |
| Nose | x63-64, z25-26 | h5..h9 (awning over the door) |
| Ears | x58 and x69, z19-21 | h6..h10 |
| Eyes | x60-61 and x66-67, z24 | h7..h8, `GLASS` (backed by solid body) |
| Door | x63-64, z24 | h1..h3, flush `DUST_WOOD` |
| Tube-coral pots | (61, h1..h2, 25) and (66, h1..h2, 25) | `BB_CORAL` |

- **Mottling:** body cells with `hash<0.12` become `STONE`. Top cells at h16 with `hash<0.06` become `MC_MOSSY`.
- Everything under the brow, nose and ears keeps air at h1..h3, so the front yard at z25-27 is walkable.

### 5.4 Yard hedges

1-high `BB_CORAL` at T+1 on z26, at x49-53 and at x74-78.

### 5.5 Rock Home, centre (88,21)

**Terraces:** with `d = hypot(x-88, z-21)`, fill `BB_ROCK` from T+1 up to the height below. Cells with `hash<0.1` get `BB_CORAL` spots.

| Distance | Height |
|---|---|
| d < 1.5 | T+4 |
| d < 3 | T+3 |
| d < 4.5 | T+2 |
| d < 6.3 | T+1 |

**Lid:** `BB_ROCK` 1 thick, for `hypot(x-88, z-19) < 3.5`. It sits at y21 where z ≥ 19 and at y22 where z < 19. The lid is propped open toward Conch Street.

**Props:**
- Stick: `WOOD` (89, y19..20, 22).
- Weathervane: `WOOD` (88, y22..25, 19) with an `ACCENT` tip at y26.
- Mailbox: `WOOD` (86, h1..h4, 27) with a `BB_HULL` box at h5.

This is Bravo's climbable T+3 perch over the B lot. The cells under the lid are sheltered, and their `heightAt` is the lid, so they are not roam targets.

### 5.6 Anchor Yard (x96-112, z14-25)

The anchor lies flat. Its heightfield is the exact P-twin of the Wreck Cove (§9.1).

| Part | Cells | Height | Material |
|---|---|---|---|
| Shank | x98-108, z17-18 | h1..h2 | `RUST` |
| Arms | x96-97, z14-21 | h1 | `RUST` |
| Flukes | x96-97, z14-15 and z20-21 | h2 | `RUST` |
| Stock | x106-107, z14-16 and z19-21 | h1 | `DUST_WOOD` |
| Eye ring | x109-111, z16-19; centre (110, 17-18) left as AIR | h1 | `RUST` |
| Chum barrels | x109-111, z23-25, with a step at (108,24) h1 `WOOD` | h1..h2 | `RUST` |

---

## 6. R2 West downtown, "Krusty Krab" (x15-49, z34-61): `buildKrustyKrab`

**Keep-outs**
- Anchor: fun (45,47).
- Landmark: (25,47).
- Trap button: (21, y16, 38) with its wall (21, y16..17, 37).
- Fire-point cells: (23,15,44), (27,15,47) and (24,15,51).
- Sign backing: x22-28, y19-21, z58, with the air front at z59.

### 6.1 Walls

The walls are 1 thick: x=15 and x=36 for z37..58, and z=37 and z=58 for x15..36.

- **Materials:**
  - h1..h3: `BB_HULL`.
  - h4: `WOOD` rail.
  - h5..h9: lobster-trap lattice. Take `along` = z on the x-walls and x on the z-walls. Cells where `along%3==0` are `WOOD` posts. Otherwise h5, h7 and h9 are `PLANK` slats, and h6 and h8 are `GLASS` netting.
- **Sign backing override:** x22-28, z58, h5..h7 is solid `PLANK`.
- **Doors:** air at h1..h3, with the h4 `WOOD` rail kept as the lintel.

  | Door | Cells |
  |---|---|
  | Front (south) | z58, x24-27, with `TRUCK_RED` frame columns at x23 and x28, h1..h3 |
  | Back (north) | z37, x24-27, with `WOOD` frame columns at x23 and x28; a step well (floor level, `DUST_WOOD`) at x24-27, z38 keeps the kitchen-deck step clear of the lintel |
  | Drive-thru (east) | x36, z46-49 |

  **Exactly three portals.**
- **Portholes:** on x=15 around z0 ∈ {42, 47, 52}. A `PALE` rim covers z0-1..z0+2 at h1..h4. The `GLASS` pane is 2×2 at z0..z0+1, h2..h3.
- **Order window:** `GLASS` at x36, z52-53, h2..h3.
- **Gable infill:** `PLANK` on x=15 and x=36 from y24 up to the roof height minus 1.

### 6.2 Roof (every roof cell is y ≥ 24)

For z36..59 and x15..37:
- `zd = |z-47.5|`, and the roof height is `y = 24 + min(3, floor((12-zd)/3))`.
- Where `zd<5`, the roof is `PLANK` on even z and **AIR on odd z**. These skylight slots make the dining floor open-sky, so it becomes a roam target, and let grenades drop in. Elsewhere the roof is `ROOF`.

**Roof fixtures**

| Part | Cells | Material |
|---|---|---|
| Ridge | x15-37, z47-48, y28 | `WOOD` |
| Chimney | x31-32, z38-39, y24..33 | `RUST` |
| Chimney cap | y34 | `ACCENT` |
| Mast | (25, y29..36, 47) | `WOOD` |
| Voxel flag | x26-29, y33-35, z47 | `TRUCK_RED` |
| Flag centre | x27-28, y34, z47 | `PALE` |

### 6.3 Interior

- **Floor paint:** `PLANK` at x16-35, z38-57, with a `DUST_WOOD` border ring. `ACCENT` ticks at the site corners (20,42), (31,42), (20,53) and (31,53).
- **Kitchen:**
  - Deck: `PLANK` h1 over x16-35, z38-40, one step up.
  - Grill: `RUST` x18-20, z38, h2, with `ACCENT` on x19; hood x18-20, z38-39, y20 and a duct at x19 (moved off the back-door line).
  - Fryer: `RUST` x29-30, z38, h2.
  - Safe: `MC_IRON` x33-34, z38, h2..h3.
- **Counter:** z41, x16-35, with `BB_HULL` at h1 and a `PLANK` top at h2. Gaps are air at x22-23 and x30-31. Players in the kitchen stand at h1, so this is the elevated A head-glitch.
- **Register boat:** `BB_HULL` h1 at x26-29, z42-43, with an `ACCENT` cash box at (27, h2, 42).
- **Site cover** (each 2×2 `PLANK` table is h1):
  - Tables at (21-22, 45-46), (21-22, 50-51) and (29-30, 47-48).
  - Lobster tank: x25-26, z49-50, with `BB_HULL` at **h1..h2** and `GLASS` at **h3..h4**. It is the central hard piece, and the glass pops when the hull dies.
  - East barrel stack: `WOOD` x32-33, z44-45, h1..h2, with a `WOOD` step at (34,44) h1.
- **Office:**
  - Partition: `BB_HULL` x22, z54-57, h1..h4, with a door gap (air at h1..h3) at z55-56.
  - Desk: `PLANK` x17-19, z57, h1.
- **Vestibule:** queue posts, `WOOD` h1, at (29,55) and (32,55).

### 6.4 Outside and the A lot

**Outside the Krusty Krab**

| Item | Cells | Height | Material |
|---|---|---|---|
| Grease barrels | x28-30, z34-35 | h1..h2 | `RUST` |
| Grease-barrel step | x31, z34-35 | h1 | `RUST` |
| Dock pylons | (16,35) and (35,35) | h1..h4 | `WOOD`, with a `PALE` rope band at h3 |
| Picnic table | x30-32, z60-61 | h1 | `PLANK` |
| Patty crates | x16, z59-60 | h1..h2 | `DUST_CRATE` |
| Patty-crate step | x17, z59-60 | h1 | `DUST_CRATE` |
| Leaning anchor, shank | (35, h1..h5, 60) | h1..h5 | `RUST` |
| Leaning anchor, arms | x34-36, z60 | h1 | `RUST` |

**A lot**

| Item | Cells | Build |
|---|---|---|
| Boat-car 1 | x40-44, z41-43 | `TRUCK_RED` h1; `GLASS` cabin at x41-43 z42 h2; tail fin `TRUCK_RED` (40, h2, 42); `PALE` bumper paint on the x44 face |
| Boat-car 2 | x44-46, z50-54 | `BUS_YELLOW` h1; `GLASS` cabin x45 z51-53 h2; fin (45, h2, 54) |
| Planter | x39-41, z55-57 | `BB_CORAL` h1, with `BB_KELP` at (40, h2..h6, 56) |
| **Delivery trap stack** | x47-49, z37-38 | `DUST_CRATE` h1..h3 with a `WOOD` top at h4. It cuts the x47-49 N-S line; its twin is the R4 barrel pallet. |

---

## 7. R4 East downtown, "Chum Bucket" (x78-112, z34-61): `buildChumBucket`

**Keep-outs**
- Anchor: fun (82,48).
- Landmark: (98,47), floor y17.
- Sign backing: x98-104, y22-23, z38, with the air front at z37.

### 7.1 Plinth and deck

- **Plinth:** `box(91,T+1,37, 112,T+3,58, BB_CHUM)`. The deck top is y17.
- **Rivets:** `RUST` at h2 on every 3rd outer-face cell.
- **Deck edge:** an `ACCENT` hazard stripe at y17 on alternate cells.
- **Site B floor paint:** `POOL_TILE_WHITE` over x96-107, z42-53, y17, with `ACCENT` corner ticks.

### 7.2 Bucket ring

Centre (101.5, 47.5), with `d = hypot(x-101.5, z-47.5)` and angle `a = atan2(z-47.5, x-101.5)` in degrees, taken mod 360.

- **Wall:** cells with `9 ≤ d < 10` at h4..h12 (y18-26) are `BB_CHUM`. The hoops at h6 and h11 are `RUST`.
- **Lip:** cells with `9.5 ≤ d < 11` at h13 (y27) are `RUST`.
- **Doors** (air at h4..h6). **Exactly three portals.**

  | Door | Rule | Cells |
  |---|---|---|
  | West | `\|a-180\|<17` | x92, z45-50 |
  | South | `\|a-90\|<15` | z57, x100-103 (on the south stair's line) |
  | North (gatehouse) | box x96-107, z38-39, h4..h11 in `BB_CHUM` (2 thick; it also seals the ring ends) | air at x100-103, z38-39, h4..h6 |

  The gatehouse sign face is z38, with air at z37.
- **East portholes:** ring cells at x111, z46-49, h5..h6 are `GLASS`. Defenders use them to watch B-Long.
- **Handle:** `RUST` cells in the plane z47-48 where `|hypot(x-101.5, y-27) - 10.5| < 0.6` and y ≥ 27. The top is y37, which is the skyline read.

### 7.3 Site B interior (floor y17)

| Item | Cells | Height | Material |
|---|---|---|---|
| Chum vat | x100-103, z46-49 minus the 4 corners | h4..h6 | `RUST`, with a `TRUCK_RED` "goo" top on x101-102, z47-48, h6 |
| Wall computer | x104-106, z43 | h4..h6 | `BB_CHUM`, with a `GLASS` screen at (105, h5..h6, 43) |
| Console | x104-106, z44 | h4 | `PALE` |
| 1-high barrels | (97,44), (98,44) and (106,51) | h4 | `RUST` |
| Barrel stack | x96-97, z50-51 | h4..h5 | `RUST` |
| Stack step | (98,51) | h4 | `RUST` |
| Test tubes | (99,52) and (104,42) | h4..h5 | `GLASS` |
| Rail posts | 1×1 on every 3rd deck-edge cell | h4 | `RUST` |

Rail posts skip the stair landings: x100-103 at z37, x100-103 and x107-109 at z58, and the whole west edge x91.

### 7.4 Stairs and outside

**Stairs** (`BB_CHUM` fills, with `ACCENT` nosing on the top cell)

| Stair | Cells | Tops |
|---|---|---|
| West ramp | x85-90, z45-50 | x85-86 h1, x87-88 h2, x89-90 h3 |
| North stair | x100-103 | z34 h1, z35 h2, z36 h3 |
| South stair | x100-103 | z61 h1, z60 h2, z59 h3 |
| SE stair | x107-109 | z61 h1, z60 h2, z59 h3 |
| Stepped base | west x89 h1 / x90 h2 (z37-58); north z35 h1 / z36 h2 and south z60 h1 / z59 h2 (x89-112, skipping the flights) | h1..h2 |

Bots on this map steer in straight lines (no ground graph). Post-review, the back door, the south stair and door, and the stepped base put an entrance on the direct line from every spawn row, so 11 TDM bots reach each plant zone (≥ 9/11 on seeds 1-6, `tools/large-map-navigation-test.mjs`). The west-ramp lamp posts moved to x88.

**Outside**

| Item | Cells | Height | Material |
|---|---|---|---|
| North table | x95-97, z34-35 | h1 | `PLANK` |
| South barrels | x97-99, z60-61 | h1..h2 | `RUST` |
| South-barrel step | x96, z60-61 | h1 | `RUST` |

### 7.5 Chum Lab (a TTT hideout under the deck; graft from playful)

- **Rooms:** carve AIR at x104-110, z51-56, h1..h2. The corridor is AIR at x111-112, z52-53, h1..h2 and opens in the east plinth face (x112) onto B-Long.
- **Periscope:** a `GLASS` tile at (105, h3, 52), in the site-B floor, ringed by a `RUST` collar at h3 and a raised collar lip at h4 on the 8 cells around it. If the pane is shot, it becomes a 1×1 peek and shoot-up hole. It is not a route: the landing cells sit 4 voxels above the lab floor, beyond a jump plus an airborne vault grab (a 3-voxel rise was climbable that way).
- **Props:**
  - Machinery: `MC_IRON` at x109-110, z55-56, h1..h2.
  - Lab screen: `POOL_TILE_BLUE` at (104, h2, 52).

### 7.6 B lot (P-images of the A lot)

| Item | Cells | Build |
|---|---|---|
| Boat-car | x83-87, z52-54 | `TEAL_SIDING` h1; `GLASS` cabin x84-86 z53 h2; fin (87, h2, 53) |
| Boat-car | x81-83, z41-45 | `POOL_TILE_BLUE` h1; `GLASS` cabin x82 z42-44 h2; fin (82, h2, 41) |
| Planter | x86-88, z38-40 | `BB_CORAL` h1, with `BB_KELP` at (87, h2..h6, 39) |
| **Chum barrel pallet** | x78-80, z57-58 | `RUST` h1..h3 with a `TRUCK_RED` top at h4 (twin of the A-lot trap stack) |

---

## 8. R3 Mid, "Boating School" (x50-77, z34-61 plus the flume corridor): `buildBoatingSchool`

**Keep-outs**
- Power-up pads on the deck: x56-58, z41-43 and x69-71, z52-54. Keep the y18 slab, air at y19-20, and open sky above the pad centres (57,42) and (70,53).
- Landmark: (57,48), floor y18.
- Sign backing: x61-65, y21-22, z50, with the air front at z51.

### 8.1 Hull (x54-73, z39-56)

- **Perimeter walls:** h1 `BB_HULL`, h2 `PALE`, h3 `TEAL_SIDING` stripe.
- **Deck slab:** h4 (y18) over the whole footprint. `PLANK` inside, with a `BB_HULL` perimeter.
- **Gunwale:** `PALE` at h5 (y19) on the perimeter.
- **Chamfered corners:** (54,39), (73,39), (54,56) and (73,56) are AIR at h1..h5.
- **Gunwale gaps** (air at h5):

  | Gap | Cells |
  |---|---|
  | W stair | x54, z51-54 |
  | E stair | x73, z41-44 |
  | Bus bridge | z39, x61-66 |
  | Shack bridge | z56, x61-66 |
  | **Flume mouth** | z56, x55-57 |

- **Doors** (air at h1..h3):

  | Door | Cells |
  |---|---|
  | W | x54, z43-45 |
  | E | x73, z50-52 |
  | N | z39, x55-57 |
  | S | z56, x70-72 |

- **Portholes:** `GLASS` 1×1 at h2, at x60, 64 and 68 on z39, and at x59, 63 and 67 on z56.
- **Chalkboard:** `ASPHALT` at x54, z47-50, h2..h3.

### 8.2 Classroom

- **Instructor desk:** x62-65, z46-49, with `BB_HULL` at h1 and `PLANK` at h2. It kills the W-door to E-door diagonal.
- **Pillars:** `PALE` h1..h3 at (59,44) and (68,51).
- **Boat desks:** `PLANK` h1 at x57-60 z42, x57-60 z50, x67-70 z45 and x67-70 z53.
- **Floor paint:** a `POOL_TILE_WHITE` / `PALE` checker at y14.

### 8.3 Wheelhouse (x61-66, z45-50)

- **Walls:** `PALE` h5..h9 (y19-23), with an AIR interior at x62-65, z46-49.
- **Windows:** `GLASS` in a **single row at h6 (y20)** on every wall except the corners.
- **Doors:** air at h5..h7, at x61 z46-47 and at x66 z48-49.
- **Roof:** `BB_HULL` at h10 (y24).
- **Lamp:** `GLASS` x63-64, z47-48, h11..h12, with an `ACCENT` cap at h13.
- It blocks W-E lines across the deck.

### 8.4 Stairs to the deck

`PALE` solid fills, with `ACCENT` nosing on each top cell.

| Stair | Cells | Tops | Main user |
|---|---|---|---|
| W | z51-54 | x50 h1, x51 h2, x52 h3, x53 h4 | attackers |
| E | z41-44 | x77 h1, x76 h2, x75 h3, x74 h4 | defenders |

### 8.5 Boat-bus (north) and shake shack (south, the P-twin)

**Boat-bus** (x58-68, z34-38)

| Part | Cells | Height | Material |
|---|---|---|---|
| Bumper | x58, z35-37 | h1 | `PALE` |
| Hood | x59-60, z34-38 | h1..h2 | `BUS_YELLOW` |
| Body skirt | x61-68, z34-38 | h1 | `BUS_YELLOW` |
| Body | x61-68, z34-38 | h2..h3 | `POOL_TILE_BLUE` |
| Windows | x62, 64 and 66 on the z34 and z38 faces | h2 | `GLASS` |
| Wheels | x61 and x68 on z34 and z38 | h1 | `BB_ROCK` |
| Bus-stop pole | (56, h1..h5, 36) | h1..h5 | `WOOD` |

The roof (h3, y17) is a walkable roam top. It bridges to the deck through the z39 gap.

**Shake shack** (x59-69, z57-61)

| Part | Cells | Height | Material |
|---|---|---|---|
| Bumper | x69, z58-60 | h1 | `PALE` |
| Awning step | x67-68, z57-61 | h1..h2 | `BB_CORAL` |
| Body | x59-66, z57-61 | h1..h3 | `BB_CORAL` |
| Awning stripes | every other x, x59-65 | h3 | `PALE` |
| Serving window | x60-65, z61 | h2 | `GLASS` |

The shack roof bridges to the deck through the z56 gap.

### 8.6 Boating School Flume (the signature toy)

- **Path:** `BIKINI_BOTTOM_FLUME.path` from `bikini-bottom-data.js`. The rider's feet sit 1.1 below the centreline and run from 19.0 down to 18.1.
- **Mouth:** on the deck at the z56 gap. Mark it with `ACCENT` arrow paint on the deck (y18) at x55-57, z54-55. Standing on the deck at x55-57, z55-56 starts the ride.
- **Lip:** at (44.5, 75.5), heading west. The rider leaves at about 8 v/s, falls about 3 voxels in about 0.5 s and lands around x40-41 in Goo Lagoon's 2-deep water. There is no fall damage.
- **Trough construction** (only for cells with z ≥ 57; the deck itself is the trough on z ≤ 56):

  ```js
  for each segment A→B of path (A=path[i], B=path[i+1]):
    L = hypot(Bx-Ax, Bz-Az); (hx,hz) = ((Bx-Ax)/L, (Bz-Az)/L); (px,pz) = (-hz, hx)
    for i in 0..n (n = floor(L/0.2)+1): t=i/n; c = A + (B-A)*t
      floorCells += floor(c + p*off) for off in -1.5..+1.5 step 0.25
      wallCells  += floor(c + p*off) for off in {-2.2,-2.0,+2.0,+2.2}
  wallCells -= floorCells
  walls: SLIDE_BLUE at y19; floor: SLIDE_YELLOW at y18   (walls first, then floor)
  ```

  This gives 99 floor columns and 32 wall columns, spanning x43-58 and z57-77. Every trough voxel is at y ≥ 18, so it is never a roam target. Players pass under it at ground level: y15-17 are free, including under the Jellyfish Trail span z62-67.

  Per-row x extents (floor and wall together), so neighbours can keep clear:

  | z | 57 | 58 | 59 | 60 | 61 | 62 | 63 | 64 | 65 | 66 | 67 | 68 | 69 | 70 | 71 | 72 | 73 | 74 | 75 | 76 | 77 |
  |---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
  | x | 54-58 | 53-58 | 52-58 | 51-58 | 51-57 | 50-56 | 49-55 | 48-55 | 48-54 | 48-53 | 47-52 | 47-52 | 47-51 | 46-51 | 46-51 | 45-50 | 43-50 | 44-50 | 44-49 | 44-48 | 45-46 |

- **Stilts:** `BB_CORAL` 1×1 at y15-17, at (55,60), (50,68) and (47,75).
- **Meta:** `slides: [structuredClone(BIKINI_BOTTOM_FLUME)]` (A1, §10.4).

---

## 9. R5 South quarter (x15-112, z68-81): `buildSouthQuarter`

**Keep-outs**
- Anchors: fun (25,71) and (101,73).
- Landmarks: (46,80), (64,68), (84,77), (103,75) and (25,74).
- Trap buttons:
  - (36, y15, 69), whose wall is the hut at (37, y15..16, 69);
  - (95, y15, 74), whose wall is the drum at (94, y15..16, 74).
- Sign backing: x37-39, y16-17, z68, with the air front at z67.
- The flume corridor (§2) at y ≥ 17, and the three stilt columns.

### 9.1 Wreck Cove (x15-31): the exact P-twin heightfield of the Anchor Yard

| Part | Cells | Height | Material |
|---|---|---|---|
| Keel and hull | x19-29, z77-78 | h1..h2 | `BB_HULL`, with `DUST_WOOD` trim on the h2 edge cells |
| Ribs | x30-31, z74-81 | h1 | `WOOD` |
| Stern and bow posts | x30-31, z74-75 and z80-81 | h2 | `WOOD` |
| Broken mast | x20-21, z74-76 and z79-81 | h1 | `WOOD` |
| Rope coil | x16-18, z76-79; (17, 77-78) left as AIR | h1 | `DUST_WOOD` |
| Cargo | x16-18, z70-72 | h1..h2 | `DUST_CRATE`, with an `MC_CHEST` replacing (17, h2, 71) |
| Cargo step | (19,71) | h1 | `WOOD` |
| Mast stump | (24, h1..h6, 78) | h1..h6 | `WOOD` |
| Tattered sail | x24, z79-80, h3..h6 | h3..h6 | `PALE`, skipping the cells where `(h+z)%3==0` |

### 9.2 Goo Lagoon

- **Pool:** the ellipse `((x-39)/5)^2 + ((z-75)/4)^2 ≤ 1` covers x34-44, z71-79, 63 columns. `MC_WATER` fills y13-14 over a `BB_SAND` floor at y12. It is 2 deep, and the surface is flush with the ground.
- **Beach paint** (y14):
  - `BB_SAND` over the ellipse rx 6.8, rz 5.8.
  - Towels: `TRUCK_RED` and `BUS_YELLOW` stripes at x32-33, z77-80 and x45-46, z71-74.
- **Lifeguard hut:**

  | Part | Cells | Height | Material |
  |---|---|---|---|
  | Hut | x37-39, z68-70 | h1..h3 | `PLANK`, with a `TEAL_SIDING` band at h2 |
  | Roof platform | x37-39, z68-70 | h4 (y18) | `PLANK` |
  | Railing | x37, z69-70 and x38-39, z70 | h5 | `PALE` |
  | Chair | (37, h5..h6, 68) | h5..h6 | `WOOD` |
  | Stair (2 wide) | z68-69 | x42 h1, x41 h2, x40 h3 | `PLANK` |

- **Umbrellas:** `WOOD` poles at h1..h4 at (34,71) and (43,80). Each has a 3×3 canopy at h5 (y19), checkered `BB_CORAL` and `PALE`.
- **Sandcastle:** `BB_SAND` x50-52, z77-79 at h1, with corner towers at h2.

### 9.3 Coral Pinnacle (x57-70, z69-81): the P-twin of the Moai House

All parts are `BB_CORAL`.

| Part | Cells | Height |
|---|---|---|
| Base | x59-68, **z71-81** | h1..h8 |
| Lumps, centre (61,73) | cells with d ≤ 3.2 | h9..h14 |
| Lumps, centre (66,77) | cells with d ≤ 3.2 | h9..h17 (top y31) |
| Lumps, centre (63,76) | cells with d ≤ 2.2 | h9..h12 |
| Lumps, centre (66,72) | cells with d ≤ 2.2 | h9..h11 |
| Arms | x57-58, z74-76 | h9..h11 |
| Arms | x69-70, z74-76 | h12..h14 |
| Ledge (the nose twin) | x63-64, z69-70 | h5..h9 |

Decorative 1-deep face pits are allowed only at h ≥ 4.

### 9.4 Treedome, centre (87, 74.5)

Here `d = hypot(x-87, z-74.5)`. The dome fits exactly inside x80-94, z68-81.

- **Drum:** cells with `6.3 ≤ d < 7.3`. `PALE` at h1..h3, with an `ACCENT` band at h4 (y18).
- **Dome:** only for `d < 7.3` and y ≥ 19. Cells where `|hypot(d, y-18) - 7| < 0.6` are `GLASS`. The top is y25.
- **Ribs:** where `atan2(z-74.5, x-87)` in degrees, mod 45, is `< 5` or `> 40`, the dome cell is `PALE` instead of glass.
- Shooting a drum cell collapses the glass column above it (the zipper). Rockets open whole sectors.
- **Airlocks:** air at h1..h3 on x86-88, at z68 (north, onto Jellyfish Trail) and z81 (south, onto the Alpha strip).
- **Floor:** `GRASS` paint where d < 6.3.
- **Oak:**
  - Trunk: `WOOD` x86-87, z74-75, h1..h9.
  - Crown: `LEAVES` in the y21-23 cells whose centres fall inside the ellipsoid centred (87, 22, 75) with rx = rz = 3.5 and ry = 1.5, and only in AIR cells. The crown stays inside the glass.
- **Tree platform:** `PLANK` at h4 (y18), x85-89, z72-77, except the trunk cells. A `PLANK` railing at h5 runs round the platform edge, except the landing at x85, z73-74.
- **Stair:** `PLANK` at z73-74: x82 h1, x83 h2, x84 h3, then the platform. The platform is Alpha's perch facing north, the twin of the pineapple upper floor.
- **Props:**
  - Picnic table: `PLANK` h1 at x90-91, z76-77.
  - Training dummy: `WOOD` (82, h1..h5, 78).
- The dome makes `heightAt` ≥ y19 inside, so there is no roam or spawn capture. The landmark uses a `floorY`.

### 9.5 Jellyfish Fields (x95-112)

- **Floor paint:** `GRASS` over x95-112, z68-81 at y14, with `BB_SAND` patches where `hash<0.25`.
- **Coral trees** (the P-images of the kelp stalks) at (98,79), (103,79), (108,79), (110,76) and (108,72):
  - trunk `BB_CORAL` h1..h4;
  - crown `BB_PINE_LEAF` at h5 over cells with `dx²+dz² ≤ 5`;
  - cap `BB_CORAL` at h6 over cells with `dx²+dz² ≤ 1`.
- **Boulder** (the twin of the kelp-grove boulder), `BB_ROCK`:

  | Cells | Height |
  |---|---|
  | x109, z69-71 | h1 |
  | x110 | h1..h2 |
  | x111 | h1..h3 |

- The jellyfish themselves are client-only (§11).

---

## 10. Metadata and integration (owner A1)

### 10.1 `MAP_SPAWN_ANCHORS.bikini_bottom`

```js
bikini_bottom: {
  fun: [[8, 8], [64, 8], [119, 87], [63, 87], [10, 41], [117, 54], [26, 22], [101, 73], [102, 24], [25, 71], [45, 47], [82, 48]],
  tdm: {
    alpha: [[18, 87], [36, 87], [54, 87], [73, 87], [91, 87], [109, 87]],
    bravo: [[18, 8], [36, 8], [54, 8], [73, 8], [91, 8], [109, 8]],
  },
  snd: {
    attackers: [[20, 87], [34, 87], [48, 87], [79, 87], [93, 87], [107, 87]],
    defenders: [[24, 24], [50, 22], [56, 12], [71, 12], [79, 21], [101, 22]],
  },
},
```

- The fun set is P-closed, and alpha is P-twinned with bravo.
- Every anchor is open-sky ground, so no third element is needed.
- The atlastest counts are 12 / 6 / 6 / 6 / 6.

### 10.2 `MAP_SITE_LAYOUTS.bikini_bottom`

```js
bikini_bottom: [
  { id: 'A', minX: 20, maxX: 31, minZ: 42, maxZ: 53, y: GROUND + 1.02 },  // Krusty Krab dining floor (roofed, skylights)
  { id: 'B', minX: 96, maxX: 107, minZ: 42, maxZ: 53, y: GROUND + 4.02 }, // Chum Bucket deck (top y17), inside the ring (corner d 7.8 < 9)
],
```

In the model, 120 of 144 site-A cells and 116 of 144 site-B cells are plantable; the rest are cover. Standing on 1-high cover still satisfies `|Δy| ≤ 1.5`.

### 10.3 `MAP_LANDMARKS.bikini_bottom` (always pass `floorY`)

```js
[
  { id: 'conch', name: 'Conch Street', x: 64, z: 31, floorY: GROUND },
  { id: 'pineapple', name: 'Pineapple', x: 40, z: 21, floorY: GROUND },
  { id: 'moai', name: 'Moai House', x: 64, z: 27, floorY: GROUND },
  { id: 'rock', name: 'Rock Home', x: 88, z: 23, floorY: GROUND + 3 },
  { id: 'kelp', name: 'Kelp Grove', x: 22, z: 20, floorY: GROUND },
  { id: 'anchors', name: 'Anchor Yard', x: 103, z: 21, floorY: GROUND },
  { id: 'krab', name: 'Krusty Krab', x: 25, z: 47, floorY: GROUND },
  { id: 'school', name: 'Boating School', x: 57, z: 48, floorY: GROUND + 4 },
  { id: 'chum', name: 'Chum Bucket', x: 98, z: 47, floorY: GROUND + 3 },
  { id: 'lagoon', name: 'Goo Lagoon', x: 46, z: 80, floorY: GROUND },
  { id: 'pinnacle', name: 'Coral Pinnacle', x: 64, z: 68, floorY: GROUND },
  { id: 'treedome', name: 'Treedome', x: 84, z: 77, floorY: GROUND },
  { id: 'fields', name: 'Jellyfish Fields', x: 103, z: 75, floorY: GROUND },
  { id: 'wreck', name: 'Wreck Cove', x: 25, z: 74, floorY: GROUND },
]
```

### 10.4 `createMapMetadata` spread (next to the nuketown spread)

```js
...(id === 'bikini_bottom' ? {
  spawnBounds: { minX: 4, maxX: 123, minZ: 4, maxZ: 91, minY: GROUND + 1, maxY: GROUND + 1.1 },
  standHeights: [GROUND - 1, GROUND + 3],
  slides: [structuredClone(BIKINI_BOTTOM_FLUME)],   // import from './bikini-bottom-data.js'
} : {}),
```

- `spawnBounds` is ground-level only, like nuketown, because all anchors are on the ground.
- Keep `navigationFloor` unset, and add `'bikini_bottom'` to the legacy list at `tools/large-map-navigation-test.mjs:158`.
- Portals: none. Ladders: none, so the ternary is unchanged.

### 10.5 Power-ups (`shared/powerup-sites.js`, `[x, topSolidY, z]`)

```js
bikini_bottom: [[45, 14, 31], [82, 14, 64], [82, 14, 31], [45, 14, 64], [57, 18, 42], [70, 18, 53]],
```

| Pad | Location | Model: min spawn distance | Model: open directions |
|---|---|---|---|
| (45,31) | road junction at the A-lot mouth | 16.0 | 10/16 |
| (82,64) | road junction at the B-lot mouth | 16.0 | 12 |
| (82,31) | road junction at the B-lot mouth | 17.0 | 13 |
| (45,64) | road junction at the A-lot mouth | 17.0 | 12 |
| (57,42) | school deck | 13.0 | 14 |
| (70,53) | school deck | 13.0 | 14 |

The pads come in P-pairs.

### 10.6 Signs (`map-signs.js`, 4 signs, KK first)

```js
bikini_bottom: [
  ['THE KRUSTY KRAB', 'FINE UNDERSEA DINING', 25.5, 20.5, 59, 5.6, 1.6, '+z'],  // backing PLANK x22-28 y19-21 z58 (single-thickness, breakable), air z59
  ['CHUM BUCKET', 'NOW SERVING · SITE B', 101.5, 23, 38, 7, 1.6, '-z'],        // gatehouse BB_CHUM x98-104 y22-23 z38, air z37
  ['BOATING SCHOOL', 'STUDENT DRIVERS AHEAD', 63.5, 22.5, 51, 5, 1.2, '+z'],   // wheelhouse south wall PALE x61-65 y21-22 z50 (windows only y20), air z51
  ['GOO LAGOON', 'NO SWIMMING AFTER CHUM', 38.5, 16.5, 68, 2.6, 1.0, '-z'],   // hut north wall PLANK x37-39 y16-17 z68, air z67 (road)
],
// COLORS
bikini_bottom: ['#fff1c9', '#1d5f86'],
```

### 10.7 TTT traps (`shared/world/traps.js`)

```js
bikini_bottom: [
  { id: 'grill-flare', name: 'Grillbrand', detail: 'Die Grillplatte der Krabbenküche flammt auf und setzt den Speisesaal in Brand.',
    button: { x: 21, y: 16, z: 38, face: 'z-' }, uses: 1,              // on kitchen deck (y15), wall = KK back wall (21,16..17,37)
    effect: { kind: 'fire', points: [{ x: 23.5, y: 15.05, z: 44.5 }, { x: 27.5, y: 15.05, z: 47.5 }, { x: 24.5, y: 15.05, z: 51.5 }], durationMs: 12000 } },
  { id: 'high-tide', name: 'Flutwelle', detail: 'Die Goo Lagoon läuft über und flutet den Strand für kurze Zeit.',
    button: { x: 36, y: 15, z: 69, face: 'x+' }, cooldownMs: 45000,     // wall = lifeguard hut (37,15..16,69)
    effect: { kind: 'flood', region: box(37, 15, 71, 45, 16, 80), durationMs: 8000 } },
  { id: 'jelly-sting', name: 'Quallenstich', detail: 'Ein Quallenschwarm setzt die Jellyfish Fields 10 Sekunden unter Strom.',
    button: { x: 95, y: 15, z: 74, face: 'x-' }, cooldownMs: 40000,     // wall = Treedome drum (94,15..16,74)
    effect: { kind: 'electrify', regions: [box(96, 14.5, 68, 112, 17, 81)], durationMs: 10000, damage: 7, intervalMs: 450 } },
],
```

- The model verifies floor, air, the 2-high wall, BFS reach from `fun[0]`, and fire points in air on solid ground.
- The flood lasts 8 s, which equals the drown timer, so it is threatening but survivable.

### 10.8 Capture shots (`shared/map-capture-shots.js`)

```js
shot('bikini_bottom', 'hero', [64.5, 34, 93.5], [64, 16, 40], 75),
shot('bikini_bottom', 'conch-street', [8.5, 21, 30.5], [60, 20, 21], 72),
shot('bikini_bottom', 'krusty-krab', [44.5, 21, 66.5], [26, 19, 52], 70),
shot('bikini_bottom', 'chum-bucket', [82.5, 26, 30.5], [101.5, 21, 47.5], 70),
shot('bikini_bottom', 'boating-school', [40.5, 24, 30.5], [63.5, 19, 47.5], 70),
shot('bikini_bottom', 'flume', [36.5, 22, 64.5], [52, 18, 66], 72),
shot('bikini_bottom', 'treedome', [70.5, 22, 64.5], [87, 19, 74.5], 70),
shot('bikini_bottom', 'goo-lagoon', [55.5, 24, 64.5], [39, 15, 75], 72),
shot('bikini_bottom', 'snd-site-a', [33.5, 19.5, 56.5], [24.5, 15.5, 46.5], 70, 'snd'),   // KK vestibule, under the roof
shot('bikini_bottom', 'snd-site-b', [101.5, 31, 59.5], [101.5, 18, 47.5], 70, 'snd'),    // above the lip (y27) south of the ring
```

### 10.9 Atmosphere (`map-atmosphere.js` PALETTES)

```js
// Sunlit shallow sea: teal gradient, pink puff clouds read as "sky flowers", soft overhead surface glow.
bikini_bottom: { skybox: null, skyTop: '#0b5a86', skyHorizon: '#46c2d4', fog: '#3aa8bf', density: 0.0062,
  skyLight: '#c8f6ff', groundLight: '#d8c48c', sun: '#eafcff', ambient: 0.98, sunlight: 1.05, cloud: '#ffd6ec',
  sunDisc: 0.35, sunDir: [20, 120, 10],
  grade: { shadowTint: [-0.01, 0.008, 0.02], highlightTint: [0.0, 0.01, 0.012], saturation: 1.1 },
  light: { minSky: 0.4 }, envIntensity: 0.55 },
```

- `skybox: null` must be explicit, because the DEFAULT skybox would hide the clouds.
- Fog density is ≤ 0.007, the bot-fairness cap.

### 10.10 Registry and presentation checklist

Follow the integration guide §1.2-1.12 exactly. For this map:

- **Registries:**
  - `templates.js` dispatch;
  - `MAP_NAMES`;
  - `MAP_IDS` (append);
  - `MAP_MODE_COMPATIBILITY: COMBAT_MODE_IDS`;
  - `lobby-limits` 12.
- **HUD:** `MAP_LABELS` `'BIKINI BOTTOM'`, and `MAP_DESCRIPTIONS`: "Undersea town: Krusty Krab vs Chum Bucket, a boating-school flume into Goo Lagoon."
- **Previews and backdrop:** `MAP_PREVIEWS` `'./assets/maps/bikini-bottom.webp'` and `MENU_BACKDROPS`.
- **Atlastest pins:** ids, compatibility, names, the hash (computed), and the spawn counts.
- **New tests:** `tools/bikini-bottom-test.mjs` (§13) and `tools/bikini-bottom-lobby-test.mjs`, both added to the `maps:test` line.
- **Preload:** rerun it, since there are 7 new shared modules.
- **Docs:** `docs/maps/bikini-bottom.md` with the originality statement, the README and development map tables, the `BUILD-CONTRACT` map sections, and the lobby-roster capacity table.
- **Preview image:** render with `node tools/render-map-scenes.mjs --map bikini_bottom` (muted CDP), then `cwebp -q 82`.

---

## 11. Client details (A4): `public/js/engine/bikini-bottom-details.js`

**Export:** `buildBikiniBottomDetails(meta, getBlock)` returns `{ group, dispose, update(dt) }`.

**Wiring in `worldview.js`:**
- Import it next to lines 17-19.
- Add a branch to the ternary at lines 174-176: `: meta?.id === 'bikini_bottom' ? buildBikiniBottomDetails(meta, visualBlock)`. `visualBlock` is the constructor-local getter at line 124.
- Add `this.mapDetails?.update?.(dt);` inside `update(dt)` (line 289+).

**Rules:**
- No collision and no hash change.
- Nothing is attached to destructible voxels.
- Anything visually "on" a voxel re-checks `getBlock` every 1 s and hides when that voxel is gone.
- Use instancing and one shared geometry and material per system. Target at most 30 draw calls in total.
- All motion is time-based. Randomness comes from `mulberry32(20260922)`.

**Systems**

1. **Sky flowers** (the signature): 22 flat 5- and 6-petal `ShapeGeometry` flowers with a darker centre ring.
   - Palette: `#ffb3d9 #b3f0ff #d4ffb3 #ffe9a8 #e0c3ff`.
   - Placed on a ring of radius 180-260 around (64,48), at y 60-110, facing the centre.
   - Spin 0.02 rad/s. Material: `fog:false, depthWrite:false`, opacity 0.55, `renderOrder -1`.
2. **Bubble columns:** instanced spheres rising at 1.5-3 v/s with a wobble, respawning at the base.

   | Source | Position | Visibility check |
   |---|---|---|
   | KK chimney | (31.5, 35, 38.5) | chimney cap (31,34,38) |
   | Chum vat | (101.5, 21, 47.5) | (101,20,47) |
   | Pineapple crown | (40.5, 38, 21.5) | — |
   | Moai crown | (64, 31, 19.5) | — |
   | Lagoon floor | (38.5, 13, 75.5) and (41.5, 13, 74.5) | — |
   | Seabed vents | 6 in the Kelp Grove and Jellyfish Fields | — |
   | Flume lip splash | burst when a rider passes (44.5, 18, 75.5) | — |

3. **Jellyfish swarm:** 24 instanced pink bells (`#ff8fc8`, emissive `#ff7fcf`) with 4 ribbon tentacles each.
   - Pulse: scale 0.9-1.1 at 1.3 Hz.
   - Paths: Lissajous over the fields (x95-112, z68-81, y20-30), 4 drifting over the south road, and 2 in the Chum Lab (y15-16, dim).
   - Never above a power-up pad column.
   - Brighter while any `jelly-sting` trap effect is live, if the client knows it. Otherwise skip this.
4. **Fish schools:** 3 boids-lite schools of 20 instanced low-poly fish, circling at y30-38 over the north houses, mid and the south quarter.
5. **God rays:** 7 additive tapered quads (`depthWrite:false`) slanting from `sunDir`, fading slowly, over mid, both lots and the Treedome.
6. **Caustics:** one additive scrolling decal plane at y14.03 (`polygonOffset`) over the roads and lots only (z28-33, z62-67, x37-49, x78-90). Distance fade. It keeps the site interiors readable.
7. **Surface sheet:** a large translucent plane at y≈78 (DoubleSide, opacity 0.15) with a slowly scrolling ripple texture.
8. **Horizon ring** beyond the shell (x < -10, x > 138, z < -10, z > 106):
   - rock mesas and swaying giant kelp (vertex shader);
   - a skyline of tiki-, barrel- and anchor-shaped buildings;
   - 3 boat-car silhouettes looping on a ring road at y26, with bubble wakes.
9. **Set-piece animation:**
   - Wheelhouse lamp pulse: an emissive quad at (63.5, 25.5, 47.5); hide it if (63,25,47) is gone.
   - Chum lab screen glow at (104.5, 16, 52.6).
   - Chum Bucket lip neon: a thin emissive torus of radius 10.2 at y27.6. Hide it if fewer than 60% of the lip cells survive, checked every 2 s.
   - Treedome sheen: a Fresnel shell of radius 7.7 around (87, 18, 74.5). Hide it if fewer than 50% of the glass survives.
   - Flume sheen: a scrolling translucent strip along `meta.slides[0].path` at the trough floor + 0.05.
   - Lagoon toys: a beach ball and a ring float bobbing at y15.1 over the pool.
   - Anglerfish lures: 3 in the Chum Lab.

---

## 12. Optional phase 2 (not required)

- **Sea lanterns.** Add `LARGE_MAP_LIGHTS.bikini_bottom` sea lanterns (`kind: 'lantern'`, `color: 'cyan'`). This changes the hash, so re-pin it.

  | Row | Positions |
  |---|---|
  | North road apron | (20,27), (76,27), (108,27) |
  | Their P-twins | (107,68), (51,68), (19,68) |

  Each position must be checked against the region keep-outs.
- **Skybox.** A pastel sky-flower sea-surface skybox at `public/assets/skyboxes/bikini-bottom-sea.webp`, with its ImageGen prompt under `docs/design/bikini-bottom/`.
- **More traps.** `dome-crack` (a `collapse` of the Treedome glass for 6 s) or `lab-lockdown` (a `door_lock` of the lab corridor, box(111,15,52,112,16,53), for 20 s), to rotate against a trap above. The map keeps at most 3 traps.

---

## 13. `tools/bikini-bottom-test.mjs`: assertions (A1)

Model the file on `nuketown-test.mjs` and `waterworld-test.mjs`:

1. **Round trip and blocks.** The serialize round trip works. Every block type present has a tile, a painter, `GRENADE_RESISTANCE > 0`, `MINING_HITS > 0` and a hardness.
2. **Roam reachability.** A BFS in the `ttt-traps-test` style starts from `spawns.fun[0]`. It allows 1-voxel up-steps with head clearance, any drop, and swimming in water. Every column with `heightAt ∈ [13,17]`, a non-fluid top and 2 air above must be reached. The model result is 0 misses.
3. **Reach.** Every landmark `(x, floorY+1, z)`, every spawn and every plantable site cell is reached.
4. **Portals.** Site A has exactly 3 air portals in its outer walls at y15-17. Site B has exactly 3 in its ring at y18-20.
5. **Water.** `MC_WATER` appears only inside the lagoon ellipse, at y13-14: 63 columns. No spawn anchor is within 2 cells of water.
6. **Flume.** The meta has one slide. Every `SLIDE_YELLOW` and `SLIDE_BLUE` voxel is at y ≥ 18. Under the first path point the deck cell at y18 is solid, with air at y19-20. The lip end (44.5, 75.5) has `MC_WATER` within 5 voxels to the west.
7. **Power-ups.** All 6 survive `findPowerupSites` on the pristine map.
8. **Sightlines.**
   - No chest-height (y16) axis-aligned air run longer than 60 inside z14-81.
   - There is no unobstructed straight segment at y16.6 between any site-A cell centre and any site-B cell centre.
9. **Symmetry (soft).** For the outer lanes, roads and lots (x3-14, x113-124, z28-33, z62-67, x37-49 with x78-90 at z34-61), the top heights at (x,z) and at P(x,z) are equal.

---

## 14. Boot cost

- About 38k authored voxels above ground in the model.
- Every loop is bounded by its bounding box. The largest are the dome (15×16×21) and the pineapple (15×15×23).
- The flume sampling is about 130 samples × 17 offsets.
- Expected cost is ≤ 10 ms, the same order as Caldera. Verify it with the atlastest timing only; `boot:profile` is the user's to run.
