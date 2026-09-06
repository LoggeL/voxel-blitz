# Nuketown

A handcrafted voxel interpretation of the classic Nuketown test-town layout.
Reference: [Activision's Nuketown map snapshot](https://blog.activision.com/pt/call-of-duty/2019-10/Call-of-Duty-Mobile-Map-Snapshot-Nuketown).
The implementation uses original procedural geometry and textures; dimensions and furnishings are adapted to the game's one-metre voxel grid, not an exact asset reconstruction.

Select **Nuketown** when creating a lobby. Supports FFA, Chaos, Team Deathmatch, Search & Destroy and Gun Game.

- Yellow and teal houses have furnished living rooms, kitchens, bedrooms, garages, internal voxel stairs, rear balconies and external voxel stairs. Ascend stairs using the game's jump/vault controls.
- A school bus and open moving truck split the street. Cars, moving crates, garden sheds, picnic furniture, planting beds, mailboxes and trees provide additional detail and cover.
- Six block materials: yellow siding, teal siding, asphalt, roof shingles, bus yellow and truck red. All have atlas textures, mining costs and blast resistance; siding also supports bullet destruction.
- Antennas, slim balcony rails, mannequins and sign lettering are non-blocking client decoration. The neighbouring houses, desert and distant mesas are scenery outside the playable voxel world.
- Gameplay geometry is generated in `shared/world/flatmap-nuketown.js` and serialized by the existing world protocol. Decorative meshes are released by WorldView disposal.

Validation:

- `npm run maps:test`: serialization, material coverage, connected standing positions with one-block jumps, all spawns, rooms and plant areas; real server admission and live match startup for all five modes.
- `npm run maps:capture -- --map nuketown`: fixed cameras for overview, street, both facades, interior rooms, backyard and both bomb sites.
- `node tools/pickaxe-test.mjs`: all registered mining materials.

The walking graph checks connectivity; it is not a substitute for competitive multiplayer balance testing.
