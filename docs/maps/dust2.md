# Dust 2

Dust 2 is a voxel adaptation of Counter-Strike's desert map, built for Voxel Blitz's
movement, destructible cover and existing 128 x 96 x 40 world. Select **Dust 2** in
a custom lobby for Fun, Chaos Lab, Team Deathmatch, Search and Destroy or Gun Game.

T spawn sits in the south, with routes through B Tunnels, Mid and Long A.
Short/Catwalk climbs from Mid to the raised A site. Mid's double doors lead to
CT spawn, which connects both sites along the north. B has an enclosed courtyard,
tunnel entrance, doors and window; Long A includes a pit and a ramp onto A.

Sandstone walls, pale plaster, blue shutters, arches, wooden doors and stacked
crates establish the desert setting. The layout and scenery take inspiration from
[Valve's Dust II reference](https://www.counter-strike.net/dust2/). Geometry is
authored locally in voxels; this is an adaptation to this game's scale and rules.

All architecture and cover are generated in `shared/world/flatmap-dust2.js` and
serialized by the existing server protocol. Painted signs follow their backing
voxels and disappear when those blocks break. The lobby thumbnail is a render of
the playable map.

Spawns use the ground floor, including below tunnel roofs. The server restricts
expanded and recovery spawns to that floor inside the outer wall. Both plant
rectangles remain clear, and the four exposed supply pads use the common mode,
distance and floor-support checks.

Validation commands:

```sh
npm run maps:test
node tools/atlastest.mjs
npm run powerups:test
npm run maps:browser
npm run maps:capture -- --map dust2
```

Capture views cover the overview, Long A, Mid Doors, Catwalk, B Tunnels, B courtyard
and both S&D plant sites.
