# Iron Valley environment dressing
> Retired: this dressing belonged to the 1024 Frontier map. Its module and test were removed by the Frontier v2 redesign; see docs/maps/frontier.md and shared/world/frontier-sites/.

The selected left-hand Iron Valley reference in `map-alternatives.png` guides the warm sandstone outcrops, sparse green groves, rusted industrial structures and marked roads. These details are actual solid voxel geometry emitted by `shared/world/frontier-environment-details.js`.

Call `decorateFrontierEnvironment({box,disk,floor:10})` after terrain and landmarks, before final road and spawn clearance. `box` uses the generator's inclusive `(x0,y0,z0,x1,y1,z1,material)` signature; `disk(x,z,r,material)` paints the existing floor. The function returns cluster and write counts.

A fixed xorshift seed selects 56 irregularly separated clusters with ruined farm walls and partial roofs, broken fences, utility cabinets, timber observation platforms, stepped sandstone and dark rock caps, multi-tier tree canopies, shrubs and dry grass patches. Road-distance rejection protects all authored road segments. Roadside details follow route tangents: flush white dashed paint, reflector posts, sign frames, culvert mouths, rusted static wrecks and timber utility poles with sagging metal wires. Static wrecks are world geometry, with no vehicle entity or physics registration.

Every bounded elevated primitive preserves a 17-block radius around road centerlines. Every detail preserves at least 104 blocks around flag and base centers, including independent forward spawns. This module owns no capture rules, flag values, spawns or landmark compound interiors. Conservatively rejected primitives can create broken silhouettes appropriate for abandoned structures.

The algorithm performs 420 placement attempts at most, with small cluster loops and fixed road stations; it does not scan the world or consume random numbers per terrain cell. Details cover all 64 sectors in a 128-block footprint audit.

Validation: `node tools/frontier-environment-details-test.mjs` passes. It compares full call-sequence hashes across two runs, checks every emitted box footprint against roads and hub reservations, checks integer/world/height bounds, checks material and sector spread, and asserts meaningful elevated detail and flush road paint. Current audit: 56 clusters, 4,932 primitive writes, 11 materials, 45,727 emitted elevated footprint samples and 1,385 road paint samples. Counts describe writes and may include overlaps, rather than unique occupied voxels. Visual acceptance belongs to the integrated map screenshots.
