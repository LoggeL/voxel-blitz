# Structural physics

Every mode and map runs structural integrity on the authoritative server:
when blocks lose their support, they warn (`creak`), break loose and fall as
rigid chunks (`collapse`), crush whatever is under them, and leave rubble
where they land (`collapseLand`). This document is the contract between the
server (`server/sim/structure.js`, `server/sim/structure-field.js`) and
clients that present it. Shared rules and the motion model live in
`shared/structure.js`; material tuning lives in `shared/world/blocks.js`.

## Support rules

* **Anchors.** Natural ground (`STRUCTURE_GROUND`: bedrock, grass, dirt,
  stone, sand, rock, the Minecraft island and Nether materials, Bikini
  Bottom sand and reef rock, and the Frontier meadow, field, mud, gravel and
  needle ground) never needs support and fully supports what rests on it.
  Load-time pins (below) are anchors too.
* **Structural blocks** are every other solid block. Their support `s` is in
  `1..254` (`STRUCTURE_RULES.supportMax`); `0` means unsupported.
  * Straight up from a supported block: no loss (`s(above) = s(below)`).
  * Sideways, or hanging under a supported block: lose
    `STRUCTURE_SIDE_COST[type]` of the block being supported. A material's
    **span** is how many such steps it reaches from the last supported
    block.
* Passable blocks (air, water, lava, portals, Minecraft ghost blocks) neither
  need nor give support.

| Class (`STRUCTURE_CLASS`) | Examples | Span | Density | Rubble |
|---|---|---|---|---|
| `glass` | GLASS, MC_GLASS | 0 (rests only on the block below) | 0.3 | no |
| `foliage` | leaves, pine leaves, kelp, cactus, clouds | 4 | 0.1 | no |
| `wood` | WOOD, PLANK, crates, logs, timber, slides, wool | 4 | 0.5 | yes |
| `thin` | siding, ACCENT | 3 | 0.4 | yes |
| `masonry` (default) | BRICK, PALE, plaster, roof tiles, cobble, coral, BARRICADE | 6 | 1 | yes |
| `heavy` | CONCRETE, METAL, RUST, ASPHALT, steel, pool panels, vehicle props | 10 | 1.5 | yes |

Steps are counted per block face (Manhattan): a 5x5 plank roof on four
corner posts stands (the centre is 4 steps from a post); a 7x7 one loses its
middle. A concrete deck reaches 10 blocks from a pier, so a 24-block bridge
needs its middle pier. The field is the unique fixpoint
`s(b) = max(0, max over neighbours n of s(n) - cost(n -> b))`; up edges cost
0, all others > 0, so there are no zero-cost cycles.

The old fragile rule stays: shooting a block also shatters the GLASS/LEAVES
stacked directly above it at once (`destroyBlock`), with the usual per-block
`block` events.

## Map stability at load (pins)

Each map template computes its field once per process (cached per template,
`SupportField.forWorld`). Any structural block left at `0` is **pinned**: it
becomes an anchor, chosen lowest block first, preferring blocks touching
supported ones, so the fewest pins hold the authored shape (Waterworld
platforms, Bikini Bottom props, Minecraft B5 clouds, cantilevered roofs).
Pins never change voxels: map fingerprints and V3 frames are untouched, and
`tools/structure-maps-test.mjs` asserts zero collapse events at load on every
map. A pinned block is still an ordinary destructible block; when it is
destroyed, what only it held creaks and falls, so damage next to authored
floating geometry behaves like damage anywhere else.

Pins per map today: foundry 19, depot 160, citadel 25, solstice 644, caldera
44, nuketown 110, dust2 177, reactor 18, killhouse 25, harbor 598, canyon 234,
minecraft_b5 179, waterworld 2270, causeway 4, bikini_bottom 195, frontier
1210.

## Server algorithm

* **Storage.** One byte per structural voxel in 8^3 chunks, allocated only
  where structural blocks exist (`255` marks a pin). Rooms fork the template
  field copy-on-write: an untouched room owns no chunks. Template fields:
  0.1-1.1 MB per small map, 3.9 MB for Frontier (shared by all its rooms);
  a Frontier room after a minute of heavy combat owned 1.5 MB.
* **Every mutation** reaches the system through the world's block listener
  (`world.onBlockChange`, `shared/world/state.js`): explosions, rockets, tank
  shells, bullets, mining, vehicle ramming, Bastion building and NPC breaching,
  TTT traps and restores, training gates, rubble. No call site has to opt in.
* **Additions** raise support at once (max-relaxation over a bucket queue).
* **Removals** queue a pass that runs under `tickBudget` (1500 cell visits per
  tick) and resumes next tick: invalidate every block whose support was
  derived from a removed one (transitively), re-seed them from intact
  neighbours, refill, then cluster the blocks still at 0. Clustering is
  budgeted too. The incremental result equals a rebuild from scratch (the
  test suite checks this after every scenario and fuzz round).
* **Collapse.** Each unsupported 6-connected cluster creaks, and
  `creakMs` (450 ms) later its blocks that are still unsupported (a pillar
  placed in time rescues them) are removed as ordinary block deltas, at most
  `maxRemovalsPerTick` (512) per tick. A tick announces at most
  `maxCreaksPerTick` (16) creaks listing at most `maxCreakCellsPerTick`
  (1024) blocks (always at least one creak); further clusters are doomed at
  once but creak in the following ticks, each falling `creakMs` after its own
  creak. A mass support loss (Frontier's three largest buildings losing every
  ground contact in one tick: 212 clusters) then creaks over about 30 ticks at
  most 16 creaks / 12 KB per tick instead of up to 70 creaks / 23 KB. A cluster becomes chunks of at most
  `maxChunkCells` (384) blocks (8^3 grid split), at most
  `maxChunksPerCluster` (12) per cluster and `maxActiveChunks` (32) per room;
  the rest crumbles in place.
* **Falling.** The landing is computed at release: the chunk drops straight by
  the smallest air gap under its bottom blocks (the drop is an integer
  number of blocks); small chunks (<= 64 blocks) drift 0.2-0.9 m/s away from
  the removed support when the neighbour columns are open, else they fall
  straight. Spin is visual only. Everything is seeded (mulberry32 over the
  chunk serial and origin), so equal games give equal events.
* **Crush damage.** Each tick the server sweeps every falling chunk's blocks
  between the previous and current time against body boxes and hull boxes;
  each body is hit once per chunk:
  `min(250, 2.2 * sqrt(mass) * max(0, speed - 2))`, or at the landing tick
  at least `30 * sqrt(mass)` for anyone buried under it (mass = sum of block
  densities). Hulls take three times that as `collision` damage. Only during
  the `live` phase; spawn-protected bodies are skipped.
* **Kill credit.** The cause is the combatant id of whoever destroyed the
  support (`destroyBlockDirect(..., cause)`, `damageBlock(..., cause)`:
  bullets, rockets and grenades via their owner, the pickaxe user, the ram
  driver, Bastion NPCs). Every removal carries its own attribution (cause,
  origin cell, scripted or not) through the support pass: the blocks it
  invalidates inherit it, and a cluster is credited to its first-invalidated
  block's removal (if that was a scripted edit, to the first other removal
  among its blocks). Removals by different players, or a world event, in the
  same tick or the same multi-tick pass never borrow each other's credit.
  The credit stays on the server (the wire names nobody). A kill goes through
  `engine.killPlayer` with weapon `collapse`; an unknown cause (or one that
  has left) is a world death (killer `''`). A chunk whose cause the mode does
  not allow to damage a body (a team-mate without friendly fire) passes
  through it without damage, like that player's shots would, and a hull the
  hull model refuses for the cause (own team) takes nothing either; there is
  no world-damage fallback. A suicide by your own collapse hurts and scores
  as one.
* **Landing.** The chunk damages the structural blocks it lands on
  (`6 * speed * min(4, sqrt(mass))` each, attributed to its cause), so a
  falling slab breaks a plank floor and the floor collapses in turn. Then up
  to 40% of its bottom layer (max 24 blocks, non-glass, non-foliage) settles
  as **one layer** of rubble: each block drops up to 6 cells onto something
  solid and is skipped when it would touch a body (0.25 m clearance), a hull
  or a structure objective, so rubble never traps anyone (one-block steps
  only). Rubble is a normal block delta and normal structural material.
* **Chain reactions** fall out of the same rules: impacts break blocks,
  rubble on a doomed block is itself unsupported, and every removal (any
  path) runs the same pass.

## Scripted geometry

Mode scripts that move authored geometry (the Killhouse training course
gates, through the mode context's `blocks.set`) run inside
`engine.structure.authored(fn)`: a cluster those edits would leave
unsupported (the lintel over an opened gate) is pinned where it stands
instead of collapsing. Only clusters whose every block lost its support to
scripted edits are pinned: a player's demolition in the same tick still
falls. TTT traps are not scripted geometry in this sense: their collapse
trap and explosions bring structures down like any blast.

## Round resets

Conquest and Bastion rematches and every TTT round (as Garry's Mod TTT cleans
the map each round) call `engine.restoreWorld()`: every changed voxel goes
back to the template as ordinary block deltas in that tick's snapshot (so
clients need nothing special), and `structure.reset()` returns to the
template field with nothing creaking or falling. TTT restores after its
traps reverted their own fills, at the switch from `post` to the next
round's `prep`.

## Placement

Bastion building (the only player construction) runs the shared
`canPlaceStructure` predicate. It accepts an optional `supported(cells)`
callback; the server passes `engine.structure.canSupport(cells, BARRICADE)`
and refuses unsupported block placements with reason `unsupported` (after
`floor`, before `occupied`). The client ghost cannot see support, so the
server also emits a mode event to the room:

```json
{ "t": "ev", "kind": "bastion_build_refused", "at": 1791488077942, "id": "p1",
  "reason": "unsupported", "x": 60, "y": 15, "z": 60, "type": "wall" }
```

`id` is the builder, `type` the requested structure kind; show
`BUILD_REASON_TEXT.unsupported` (`'NO STRUCTURAL SUPPORT'`,
`public/js/player/build-controller.js`) to that player.
Today's Bastion build zones only allow placement on the ground floor, so this
refusal is a safety net.

## Disabling

On by default in every mode. Off with `new GameEngine({ structural: false })`,
a mode policy whose `rules.structural === false`, or `VOXEL_STRUCTURAL=0` in
the server environment. Engines whose world is not a state-API world
(ad-hoc test stubs) stay inert.

## Wire format

All four are `tick.events` entries (`t: 'ev'`). `at` is the server clock (ms)
of the tick that carries the event, equal to that snapshot's `now`. Blocks are
`o` (integer origin, the minimum corner of the listed cells) plus `b`, a flat
integer list of `[dx, dy, dz, type]` per block relative to `o` (decode with
`structureEventCells(event)`); `n` is the total block count (`b` is capped at
`eventCells`, 1024 blocks). Keys per kind are pinned in
`tools/lib/protocol-contract.mjs` (`STRUCTURE_EVENT_KEYS`).

### `creak` — support lost, the fall follows

```json
{ "t": "ev", "kind": "creak", "id": "k3", "at": 1791488077492, "fall": 450,
  "n": 3, "o": [31, 15, 40], "b": [0,0,0,7, 1,0,0,7, 2,0,0,7] }
```

`id` names the cluster (`k…`), `fall` is the ms until it drops. Present a
shake, dust trickle and creak sound on the listed blocks. Blocks that regain
support stay, so stop at `at + fall` whether or not a `collapse` follows.

### `collapse` — a rigid chunk falls

```json
{ "t": "ev", "kind": "collapse", "id": "c7", "k": "k3", "at": 1791488077942,
  "n": 3, "o": [31, 15, 40], "b": [0,0,0,7, 1,0,0,7, 2,0,0,7],
  "p": [32.5, 15.5, 40.5], "v": [0, 0, 0], "w": [0.12, 0, -0.31],
  "g": 24, "land": 289 }
```

* `k` the creak cluster it came from. No structure event names who brought
  it down (that would tell TTT bystanders who the traitor is); the credit
  shows only through the mode's own `hit` / `kill` rules.
* The same tick's `tick.blocks` already set these cells to air (no per-block
  `block` events are sent for collapses, so no per-block debris either).
* Motion, `t` ms after `at`, clamped to `land`:
  `d(t) = v t + (0, -g t^2 / 2, 0)` (seconds inside), and a rotation of
  `|w| t` radians about the unit axis `w / |w|` through the pivot `p`. A
  block centre `c` is drawn at `p + d(t) + R(t) (c - p)`. Use
  `collapsePoint(event, point, tMs)`, `collapseOffset` and
  `collapseRotation` from `shared/structure.js`. Rotation is visual; the
  server collides the unrotated blocks.
* At `land` the chunk is on the ground: the server's `collapseLand` arrives in
  that tick together with the rubble block deltas. Replace the chunk by
  debris then.

### `collapseLand` — impact

```json
{ "t": "ev", "kind": "collapseLand", "id": "c7", "at": 1791488078231,
  "x": 32.5, "y": 11.5, "z": 40.5, "n": 3, "r": 1, "speed": 9.8 }
```

Impact point (the pivot at landing), the chunk's block count, rubble blocks
left (they arrive as `tick.blocks` in the same snapshot) and impact speed in
m/s: drive the dust burst, debris amount, impact sound and camera shake.

### `crumble` — blocks removed without falling

```json
{ "t": "ev", "kind": "crumble", "id": "k3", "at": 1791488077942,
  "n": 900, "o": [60, 11, 60], "b": [ ... ] }
```

Cluster blocks past the chunk caps, or with nowhere to fall. They were
removed by `tick.blocks`; burst them in place (dust, a few debris pieces).

### Damage and kills

Crushes are ordinary `hit` events (`attacker` the credited id or `''`) and
`kill` events with `w: "collapse"` (the kill-feed icon/label key,
`COLLAPSE_WEAPON`).

### Late joiners and reconnects

Collapses are ordinary block deltas: the V3 map frame (template + patch) and
`serializeWorld()` always carry the final voxels, including rubble. Chunks
in flight are not replayed; a client joining mid-fall simply sees the cells
already empty and the rubble appear on landing.

## Client presentation

`public/js/fx/structure-fx.js` (`StructureFx`) presents the four events in every
mode; `main.js` owns one per match, the killcam one per replay.

### Timing: deltas arrive before their events

`tick.blocks` apply the moment a snapshot arrives; its events are drained one
presentation delay later (30-180 ms, `NetClient.interpolate`). A collapse whose
blocks simply vanished on arrival would leave a gap until the chunk is drawn.
So the Game hands every snapshot to `StructureFx.receive(snapshot)` *before*
`applySnapshotBlocks` (`main.js` `handleTick`: live phase, not during a
replay), and the fx animates on the presented server clock
(`NetClient.presentedServerTime(now)`, the clock events are drained on):

* **Proxies.** Cells a structure event will move are hidden from the terrain
  mesher (`ChunkStore.hideCells`, reference counted: the mesher draws them as
  air) and drawn by proxy meshes built with the terrain mesher itself
  (`ChunkStore.meshCells` with the live store as neighbourhood, so faces, AO,
  macro tone and edge lips match the chunk exactly). Proxies are world-aligned
  8^3 sections (each inside one 16 x 16 terrain column, the grid the server
  splits big clusters on); a section becomes visible in the frame its terrain
  column was rebuilt without those cells (`rec.serial`, checked after
  `WorldView.update` drained the rebuild budget). Until then the old terrain
  mesh still draws them: no gap, no double.
* **`creak`** (on arrival): its cells go under a proxy. On the presented
  clock, from `at` to `at + fall`, the proxy shakes (0.8 to 3 cm, rising),
  grit (`grit` particles) trickles from the cluster's underside, faster toward
  the fall, and `sfx.structureCreak` plays at the cluster centre.
* **`collapse`** (on arrival): the chunk mesh is built from `b` with
  `meshCells` and only the chunk's own blocks as neighbours (internal faces
  culled; 384 blocks mesh in about 0.6 ms in Node on an M-series Mac) and kept
  hidden; its cells are claimed from the creak proxy, or covered by a new
  proxy when no creak was seen (late join). At `at` on the presented clock the
  chunk takes its cells from the proxies in the same frame and is posed every
  frame with `collapseMatrix` (an allocation-free 3x4 form of
  `collapsePoint`, `shared/structure.js`) as its matrix. It shares the terrain
  materials, which sample the voxel light at the moved position (`modelMatrix`
  in the terrain vertex shader, identity for terrain chunks). Medium tier and
  up leave a dust trail. At `at + land` it breaks into block-coloured chips
  (`ImpactFX`).
* **`collapseLand`** (on arrival): rubble deltas of the same snapshot inside
  the chunk's landing box are hidden until the chunk lands, so rubble never
  appears under a chunk still in the air; the landed chunk stays until the
  terrain rebuilt with the rubble. On the presented clock at `at`: a dust ring
  rolling out over the footprint plus a slower billow, debris bits, camera
  shake (trauma up to 0.7, falling off over 10 + 4 sqrt(n) m, capped at 70 m)
  and `sfx.structureImpact` (debris takes of the chunk's material, a
  procedural slam scaled by `n` and `speed`, a far rumble for big chunks).
* **`crumble`** (on arrival): cells are claimed like a collapse; at `at` the
  proxies let go and the blocks burst into chips, dust and grit with
  `sfx.structureCrumble`.
* **Saved blocks.** Creak cells nobody claimed by `at + fall + 200 ms` (and
  once snapshots up to then have arrived) go back to the terrain; the proxy
  stays until that rebuild. Any other delta into a proxy cell (a rocket during
  the creak) drops it from the proxy at once.

### Replays, kill feed, Bastion

* The killcam history keeps the four kinds (`killcam-history.js`). A replay
  runs its own `StructureFx` without proxies (`masking: false`): the replay
  terrain and the events advance together, so chunks appear in the frame their
  blocks leave, with dust from a small replay particle field. The live fx
  clears (every cell back to the terrain) when a replay starts.
* Crush kills (`w: "collapse"`) read COLLAPSE in the kill feed with a falling
  blocks glyph (`KILL_KEY_ICONS.collapse`), in the death recap, on the deploy
  card and on the killcam banner.
* `bastion_build_refused` for the local builder shows
  `BUILD_REASON_TEXT.unsupported` in the build prompt for 2.2 s
  (`BuildController.refused`), or as a Bastion banner when build mode is
  closed.

### Meshing budget

Proxy sections and chunk meshes are built within `STRUCTURE_FX.meshBudgetMs`
(3 ms) per frame, receipts included, oldest first (chunks before sections).
A creak section past the budget stays *pending*: it owns its cells but has
not hidden them, so the terrain keeps drawing them until a later frame
meshes the section and hides them (then the usual swap on rebuild). Nothing
that the store loses waits: a cover proxy is meshed on receipt, a pending
section whose cells a collapse or crumble claims is meshed when that
snapshot arrives, and a chunk whose mesh is still queued at its start is
built then. If a section is not shown yet when a chunk or crumble takes its
cells (its terrain column has not rebuilt since, a starved rebuild budget),
that column is rebuilt at once, so a block is never drawn twice or missing.
180 creaks over 36 columns: 6 ms to receive with the budget (20 of 180
sections meshed, the rest over the next frames) instead of 27 ms meshing
everything at once (Node, M-series Mac).

### Graphics tiers and budgets

| | LOW | MEDIUM | HIGH | ULTRA |
|---|---|---|---|---|
| Live chunk meshes (more burst in place) | 6 | 12 | 24 | 32 |
| Particle share (grit, dust, chips) | 35 % | 65 % | 100 % | 100 % |
| Falling dust trails | – | on | on | on |

Proxies and chunks share the terrain materials (no new shader program). Dust
uses the match's `ParticleField` (now created in every mode: the tier's
capacity in Conquest, at most 2048 slots elsewhere), chips the `ImpactFX`
pool. Geometries are disposed when a section or chunk goes; the per-frame
update allocates nothing in steady state (index loops, a preallocated matrix
and position and emit-parameter scratch). Sound: `docs/audio/conquest-sfx.md`
("Structural collapses"); outside Conquest `sfx.loadStructureBank` decodes the
nine licensed takes it uses.

### Captures

`node tools/structure-capture.mjs` (muted CDP, `public/structure-capture.html`)
replays a scripted collapse on Canyon through the live pieces: a roof whose
pillars were shot away, a wooden platform on a broken post and a crumbling
lintel. The frames are in `docs/design/structure/captures/`.

## Performance

`npm run structure:bench` (`tools/structure-bench.mjs`, 60 s of 2 rockets/s
plus 12 block breaks/s aimed at built-up voxels, M-series Mac):

| Map | structure time per tick p50 / p95 / p99 / max | support units p95 / max |
|---|---|---|
| foundry | 0 / 9 / 35 / 680 us | 41 / 1141 |
| frontier | 2 / 34 / 85 / 340 us | 73 / 1476 |

The max column is single ticks (JIT warm-up, GC, a cluster release);
production (VoxelBox Haswell) is roughly 3-4x slower. A 9x9x20 concrete
tower whose base is removed in one tick (1539 falling blocks) spreads over
about 11 ticks at 30-400 us each (12 chunks, the rest crumbles). Template
field build (once per process): 2-54 ms per small map, about 110 ms for
Frontier (about 400 ms on the production host). Built at a room's creation,
it stalled every running room's ticks, so the server prepares them ahead
(`server/index.js`, `server/sim/structure.js`): Frontier's in its boot
preparation before listening (the field takes 150-190 ms there under load;
`listening` came after 1.36-1.37 s instead of 1.25-1.31 s with
`VOXEL_STRUCTURAL=0`, niced, on a Mac), the other maps' (2-50 ms each) after
listening, smallest first, in slices (`warmStructureTemplates`;
`VOXEL_STRUCTURE_WARM=0` skips it). The field build is a resumable generator
(`SupportField.buildSteps`, yielding about every 4096 cell visits); each
slice advances it for at most 2 ms and runs right after a room tick
completed (`afterRoomTick` in `server/game.js`: setImmediate after the ticks
due in that event-loop turn, one slice per gap), or at once while no room
ticks. Rooms keep running during it, and a room created on a map whose build
is half done finishes that build itself. The first room on a warmed map
forks a ready field (0.1 ms, 4 ms Frontier). Measured with three 60 Hz rooms
running (`.conquest-work/wip/collapse-fix/f6-tick-intervals.mjs`): the
sliced warm-up (154 ms of work in 79 slices over about 1 s, longest slice
4.9 ms) left the tick interval at p99 18.0 / max 18.4 ms (17.5-17.8 ms
without warm-up), where building each map whole in one macrotask stretched
an interval to 57 ms (Waterworld, 46 ms).

## Tests

* `tools/structure-test.mjs`: material spans, roof and pillars, bridge pier,
  chain reaction through a plank floor, budget spreading and chunk caps,
  determinism, a randomized fuzz against rebuilds, crush damage with kill
  credit, environmental crush and rubble clearance, explosion attribution and
  hull damage, glass sills, placement refusal, the disabled flag, late-join
  map frames, the bot terrain journal, the wire contract (no attacker in any
  structure event), per-removal credit in one tick and across a multi-tick
  pass, scripted edits next to a demolition, no friendly crush (bodies and
  hulls, no world fallback, suicides stay) and the per-tick creak caps.
* `tools/ttt-traps-test.mjs`: a TTT round's craters are restored at the next
  round's start and reach clients as block deltas.
* `tools/structure-maps-test.mjs`: every map loads with zero collapses,
  unchanged fingerprints and bounded memory; damage around pins settles and
  matches a rebuild.
* `tools/structure-client-test.mjs`: the client presentation on a real
  `ChunkStore`: every block drawn exactly once (terrain, proxy or chunk) at
  every step from creak to rubble, per-column swaps, saved creaks, cover
  proxies, crumbles, rubble held until the landing, geometry disposal, tier
  caps, replays, kill feed, the Bastion refusal, the wiring, the meshing
  budget (36 creaks meshed one per frame, a collapse claiming pending
  sections, chunks built at their start, exactly once in every frame) and
  the server's sliced template warm-up (resumable from a room creation,
  equal to a one-shot build, `afterRoomTick`).
* All three run in `npm run blocks:test` (`npm run structure:test`).
