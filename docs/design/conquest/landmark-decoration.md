# Frontier landmark dressing
> Retired: this dressing belonged to the 1024 Frontier map. Its module and test were removed by the Frontier v2 redesign; see docs/maps/frontier.md and shared/world/frontier-sites/.

The Iron Valley reference in `map-alternatives.png` sets the industrial district identities. All decoration below is authored voxel geometry written by `shared/world/frontier-landmark-details.js`; the generated reference is never rendered as map geometry.

`decorateFrontierLandmarks({box,disk,floor:10})` accepts the generator's existing inclusive box writer. The disk callback is reserved for compatible future ground dressing. Invoke after the main landmarks and before final road/spawn clearance.

- Relay station A: perimeter fencing with route gaps; a transformer bank at x350..396,z320..330; connected cable poles along z204; glazed control room at x360..383,z210..230 with a roof mounted stepped radar reflector; fuel tank, workbench, service container and sandbag positions. The existing mast remains the main vertical silhouette.
- Rail depot B: two loaded sidings at z434 and z582 with wood sleepers, paired metal rails, wheelsets, railcar chassis, ribbed freight containers and concrete loading edges; stacked stores; two lifting gantries with suspended hooks and pallet loads; glazed dispatch room at x590..604,z438..459.
- Quarry works C: three aggregate storage bins with open loading mouths and stepped stone contents; crusher at x685..700,z801..817; inclined metal conveyor with stone load, orange guard edges and intermediate supports; processing tower at x737..755,z803..820; existing crane counterweight, fuel supply, workshop tools and service container.
- Both bases: compound fencing, fuel farms, glazed guard/workshop rooms, container stores, detailed tool benches, maintenance platforms, camp stores, sandbag cover and floodlights. Positions mirror around x96 and x928 while retaining different paint colours.

Every dressing box is clipped before writing against a 12 metre radius around road centre lines, at every height. Capture centres retain a 25 metre radius around authoritative flag coordinates. This is deliberately wider than the required 17 metre road envelope and 24 metre flag radius. The generator still performs its final spawn clearance. Original geometry remains the map integrator's responsibility.

## Verification

`node tools/frontier-landmark-details-test.mjs` checks placement bounds, material variety, representative machinery/window/railcar coordinates, every authored occupied cell against road and capture corridors, and substantial scene density. The fixture records 6,799 box writes and 105,477 unique touched cells across ten materials. Generator/browser qualification and rendered chunk budget belong to the integrated map check.
