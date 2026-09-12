# Harbor

Harbor is a 192 by 144 voxel arena with 16 authored spawn positions per team.
The two dock objectives sit west and east of the freight gantry. Warehouse
interiors, open cargo containers, loading shelters and passages beneath the
catwalk provide covered ways between the spawn yards and docks. Spawn shelters
leave the original standing positions and exits clear. Exterior lamps and
supported signs identify the working areas without blocking the main passages.

The bot ground network runs at standing height above `GROUND`. Its two-metre
grid has at most 6,912 nodes. Edges sweep the full standing player body, and
start/goal connections must have the same clearance. A visible lookahead of up
to twelve metres skips redundant intermediate nodes while retaining blocked
corners. The movement controller turns toward the selected waypoint before
walking and only sprints toward sufficiently distant, aligned waypoints.

Block changes at floor and standing-body height update a bounded navigation
change journal. Doorway destruction and missing floor tiles invalidate cached
routes immediately; overhead decoration and solid material repainting do not.
A route that cannot reach its destination holds position rather than steering
straight through the obstruction. The existing navigation behavior on maps
without a ground-network height is unchanged.

## Checked routes

`tools/large-map-navigation-test.mjs` checks all 32 spawn bodies and every spawn
to both objective centres. Each edge must have uninterrupted standing-body
clearance and ground support. Additional samples cross warehouse interiors,
the western shed, three open containers, Dock A and the catwalk underpass.
The container at x=72.5 has a clear northern portal; a mirrored barrier that
blocked that portal was removed during this check.

The authoritative movement check sends 31 bots in a full 32-player room toward
each site with combat disabled. All 31 reach both objectives within 60 simulated
seconds. This uses the actual bot steering, engine collision and movement code,
not just a route-exists assertion. Separate two-seed TDM checks require at least
100 shots, five kills and twenty bots sustaining an engagement within a minute.

The September 12 qualification used seed 12345, a fixed 20 Hz simulation and
one stationary human plus 31 bots:

| Measurement over 60 simulated seconds | Previous map/navigation | Revised map/navigation |
| --- | ---: | ---: |
| Authoritative shots | 0 | 782 |
| Authoritative kills | 0 | 29 |
| Bots reaching site A with combat disabled | 12 / 31 | 31 / 31 |
| Bots reaching site B with combat disabled | 18 / 31 | 31 / 31 |

The previous state was captured from commit
`dadd82a9f41b7d5b037a2a98973a4aeeac3fc52f`. These values compare the combined
geometry, perception, steering and navigation changes; they do not isolate one
subsystem's contribution. Controlled objective runs have no circling or stalled
five-second windows. Turning, searching and combat strafing can still produce
low-displacement windows in a live match.

Run the checks with:

```bash
node tools/large-map-navigation-test.mjs
node tools/large-maps-test.mjs
node tools/large-map-navigation-probe.mjs > navigation-metrics.json
```

The probe records actual player/bot counts, the geometry SHA-256, per-bot travel
and engagement metrics. `VB_PROBE_ROOT` can point at a preserved repository
snapshot for a baseline comparison; `VB_PROBE_SECONDS` sets the simulation time.
