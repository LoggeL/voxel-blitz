# SL-2 SELVEDGE

The Selvedge lays a line of light between two points on voxel terrain. Pin the floor on either side of a doorway and the pulse sweeps across the opening. The pulse starts at the first pin, so the order of the taps determines which side it reaches first.

## Using the stitcher

- Tap a solid surface within 50 m to set the first pin. It holds for six seconds.
- Tap another surface 2 to 18 m from the pin. A clear path between them sends a pulse along the filament at 16 m/s. Each exposed opponent in its path can take one hit, worth 88 damage before armor. The basic sweep reaches 0.9 m to either side of the line.
- An obstructed, short, or overlong pairing makes the second surface the new starting point. The HUD briefly shows why the pin moved, then resumes the countdown. An empty-air tap leaves the first pin in place.
- A direct tag deals up to 24.8 body damage before armor and leaves a waiting pin in place. Each tap uses one of the eight pins in the cassette.
- Swapping away, dying, or losing the surface supporting a pin cancels that pin.

The stitcher occupies wire slot 21. It is available on the free weapon wheel, as Recon's alternate primary in Conquest, and for $2,900 in Search and Destroy. In Chaos Lab, Holdfast gives the first pin ten seconds, Long Stitch extends the span to 26 m, and Broad Weave increases the pulse radius by half.

The base values live in `WEAPONS.selvedge` in `shared/combatmath.js`. The server checks pins, obstructions and moving contacts in `server/sim/selvedge.js`.
