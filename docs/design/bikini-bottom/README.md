# Bikini Bottom and SB-1 SUDSBLASTER: design record

The map `bikini_bottom` and the weapon `bubble` (SB-1 SUDSBLASTER) were built
together on 2026-09-22. Both are original procedural work inspired by the
cartoon: no assets, meshes, textures, logos, audio or character likenesses
are copied, and place names are used only as labels.

No image-generation tool was available in the session that built them. The
AGENTS.md reference step therefore uses real renders of the implementation
instead of generated alternatives. The design choice was made on paper:
several concepts were scored in the specs, and the build followed the winner.

## Concept notes

- **Map.** A cartoon undersea town on the standard 128 × 96 grid. Two
  restaurants face each other as the S&D sites: the wooden Krusty Krab (A,
  ground floor, roofed) against the raised metal Chum Bucket (B, deck at y17).
  The Boating School in mid has a deck and a flume that shoots riders into
  Goo Lagoon. Conch Street houses (Pineapple, Moai House, Rock Home) line the
  north, with Wreck Cove, the Coral Pinnacle, the Treedome and Jellyfish Fields
  in the south. Gameplay footprints are point-symmetric. The underwater look
  comes from the palette, fog and client details only, because a real sea
  surface or water volume would kill power-ups and movement.
- **Weapon.** The only rising projectile in the roster. A tap fires a Soap
  Shot, a hold blows a Big Bubble, and every pop splashes, shoves upward and
  soaks the victim without touching terrain. It was chosen over a hitscan
  jellyfish zapper (the documented fallback in the spec) for distinctness and
  theme fit.

## Files

| File | Content |
|---|---|
| [map-spec.md](map-spec.md) | Final map build spec: judging, global rules, regions R1–R5, metadata, client details, tests |
| [reference-model.py](reference-model.py) | Python mirror of every collision-relevant voxel; `python3 reference-model.py --ascii` prints the verified layout |
| [layout-ascii.txt](layout-ascii.txt) | Top-down layout from the model (1 char = 1 voxel) |
| [weapon-spec.md](weapon-spec.md) | Final weapon build spec: judging, rules, server, client, audio, HUD, balance, tests |
| `renders/` | Actual map captures (`node tools/render-map-scenes.mjs --map bikini_bottom`, muted headless CDP): hero, Conch Street, both sites, Boating School, flume, Treedome, Goo Lagoon, S&D site views |
| `sudsblaster/` | Actual weapon captures: held, firing and scoped at desktop size, held at mobile portrait size, third-person profile, flying bubbles and a pop in the world |

## Deviations from the specs during the build

- Atlas slots are 84–93 (79–83 were already taken).
- The flume path y values were raised (20.3 → 20.16, lip 20.7) so the rider
  stays above the trough floor and leaves the lip airborne; the x/z points and
  the trough voxels are unchanged. The copies of the path in `map-spec.md` and
  `reference-model.py` still show the original heights; the model only uses
  x/z.
- The Goo Lagoon sandcastle sits at z78–80 to keep the flume corridor clear.
- Client details: sky flowers, the boat-car lane and fish schools fly higher
  than specified so the 40-high reef wall and tall landmarks do not hide them;
  caustics sit on the floor surface at y15.03.
- Weapon: the soap tank became a bottle under the receiver and the squeeze
  bulb leans to the right, so neither blocks the nozzle, the support hand or
  the sight picture.

## Validation

See `docs/maps/bikini-bottom.md` and `docs/weapon-design/bubble.md`.
