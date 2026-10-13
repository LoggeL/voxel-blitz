# Ashfall: design references

The dedicated Titanfall (Attrition) map, spec in `docs/titanfall.md` §14.

## Alternatives (ImageGen, gpt-image-2)

Each sheet has a top-down tactical plan and an atmosphere view; the exact
prompts are next to the images.

| Sheet | Prompt | Concept |
|---|---|---|
| `layout-a-reference.jpg` | `layout-a.prompt.txt` | Ruined smelter colony at dusk: team yards on the west and east edges, ring roads and boulevards for titans, four habitat blocks with wallrun alleys and high skybridges, a broken cooling-tower ring as the central arena |
| `layout-b-reference.jpg` | `layout-b.prompt.txt` | Wrecked orbital spaceport: a 64 m landing pad with a crashed dropship, a terminal concourse in the north, hangar rows in the south |
| `layout-c-reference.jpg` | `layout-c.prompt.txt` | Refinery town split by a 20 m dry canal, two titan ramps and a pilot footbridge |

## Choice: Layout A

- It separates the two Titanfall layers most cleanly: wide, readable titan
  lanes (yards, ring roads, boulevards, streets, arena) wrap compact pilot
  blocks whose alleys, doors and low bridges no hull fits through, and the
  high bridges let a pilot cross the block band without touching a lane.
- It works on the flat street-level route graph the titanfall bots use. Layout
  C's sunken canal would split that graph into two levels joined only by
  ramps; Layout B's single central pad gives titans one open bowl and few
  pilot routes on the flanks.
- The broken cooling ring gives the middle a landmark silhouette and cover at
  titan height, with four breaches so titans are never funnelled into one
  choke.

Implementation differences from the sheet: the plan is exactly point-symmetric,
the ring is a voxel cylinder with stepped, broken tops up to 20 m
instead of a smooth hyperboloid, the sky has no gas giant (the sky renderer has
only a sun disc), and the canyon rim around the map is the red mesa backdrop
from `map-atmosphere.js`.

## Feature pass (2026-10): concept sheets

The second pass gave the map Titanfall-specific features. `features/base.txt` describes the
then-current map (from a real capture) and is shared by the three prompts; each sheet has
an arena view and a street view.

| Sheet | Prompt | Concept |
|---|---|---|
| `features/concept-a.png` | `features/concept-a.prompt.txt` | **The Pour**: a molten crucible inside the broken cooling ring fed by ladles hanging from a pipe-rack walkway over the arena; a blast-wall wallrun slalom and a raised ore dock in the approach yards; steel perches beside the lanes |
| `features/concept-b.png` | `features/concept-b.prompt.txt` | **Crane Yards**: a toppled gantry crane across a boulevard, derailed slag-pot cars as lane medians, scaffold perches, stacks and a gas giant on the skyline |
| `features/concept-c.png` | `features/concept-c.prompt.txt` | **Terraces**: stepped retaining walls, billboard gantries, a battery nook under a terrace |

### Choice: A, with pieces of B and C

- A gives the middle a signature that changes play, not only the look: the molten pool and
  its two runners split the arena floor (titans burn in slag too), the Pour Line walkway gives
  pilots a high route straight across the map, and the ladles and pour columns glow at dusk.
- From B: the toppled crane (its jib is a pilot bridge over the north and south boulevards),
  the slag-car medians (sightline breakers that split the boulevards and ring roads into two
  carriageways) and scaffold-framed perch stairs.
- From C: the battery cache nooks and (review pass) the billboard gantry over a cross street.
- From B, review pass: smelter stacks and cooling towers on the skyline. The terrain backdrop
  now draws them with the industrial builder (`map-backdrop.js` STYLES.terrain, `stacks` /
  `towers` / `industry` in the Ashfall entry of `map-atmosphere.js`). The first version of this
  README said the terrain backdrop had no industry; that was wrong.
- Not built: B's gas giant (the sky shader has only a sun disc) and C's terraces (they would
  split the flat street graph the bots use).

### Captures of the feature pass

`captures/` (muted CDP renders, JPEG): `desktop-*.jpg` at 1920 x 1080 for the-pour,
pour-line, slalom, crane, yard-tower and perch next to the older shots; `mobile-*.jpg` at
390 x 844 (portrait) and 844 x 390 (`*-landscape.jpg`).

Compared with concept A (feature pass): the crucible was much smaller than in the painting
(a 4.4 m pool inside a 3 m rim, hidden from the floor), and the runners stopped at the inner
ring wall. The review pass below changed that. The Pour Line is a flat steel walkway with edge
rails instead of A's round pipe bundle; the blast walls carry the yellow hazard band and work
lamps of A2; the dusk is darker than the first pass but lighter than the painting so the
alleys stay readable.

## Review pass (2026-10-13)

No new ImageGen sheets: the changes follow concept sheets A, B and C above. Numbers are in
`docs/titanfall.md` §14.

- The Pour (A): a 7 m pool inside a 2 m rim of radius 8.5 m, so the slag shows over the rim from
  the floor and from a titan's eye. The runners run through culverts in the ring wall into slag
  pits outside it, as in the painting. `desktop-the-pour.jpg` now looks across the pool at the
  rim sign; the pool reads at about the painting's scale, though it is still smaller relative to
  the ring.
- Titan cover: staggered lane cover (container stacks, revetments, ingot piles) in the
  carriageways, more slag cars on the boulevards, and six hull-down ingot stacks in the arena's
  outer band (`desktop-ring-road.jpg`, `desktop-boulevard.jpg`, `desktop-cooling-ring.jpg`).
- Billboard gantry from C over the west cross street, a wallrun chain across it
  (`desktop-billboards.jpg`, `mobile-billboards-landscape.jpg`).
- Skyline stacks and cooling towers from B (`desktop-hero.jpg`, `desktop-slalom.jpg`).
- Spawn overlooks: enclosed ring-road galleries, clad yard towers with a deck booth, shutters and
  roof boards (`desktop-yard-tower.jpg`, `desktop-ring-road.jpg`).
- Blocks: sign boards, balconies, AC units, shuttered panes and interior furniture.
- The perch shot was re-aimed so the deck and its stair are in view (`desktop-perch.jpg`).

## Captures (real renders)

`captures/` holds muted CDP renders of the finished map
(`node tools/render-map-scenes.mjs --map ashfall`, converted to JPEG). Every capture was
re-rendered in the review pass:

- `desktop-*.jpg` (1920 x 1080): hero, overview (orthographic top-down plan), the-pour,
  pour-line, slalom, crane, yard-tower, perch, ring-road, billboards, cooling-ring, militia-yard,
  hab-alley, skybridge, relay-nest, boulevard;
- `mobile-*.jpg` at 390 x 844 (portrait phone): hero, the-pour, ring-road, cooling-ring, slalom,
  hab-alley; at 844 x 390 (`*-landscape.jpg`): perch, billboards, boulevard, pour-line;
- `overview-square.jpg` (1100 x 1100).

The lobby preview `public/assets/maps/ashfall.webp` (1440 x 900) is the current hero render.
