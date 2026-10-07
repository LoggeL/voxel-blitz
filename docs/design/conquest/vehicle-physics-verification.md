# Vehicle physics and distance verification

## Changes

Destroyed hulls publish one authoritative blast with cover, team rules, crew death and bounded chain reactions. The client consumes both destruction events through the actual NetClient and Session event pipeline, deduplicates their visual burst, and retains a scorched wreck until respawn. Air wrecks retain impact velocity and fall against the same compound collision geometry.

Live vehicles retain momentum when their seat is released. Ground vehicles coast under drag and ordinary terrain/hull collision. Recent-driver runover credit expires after five seconds and cannot cross life or team changes. Environmental blast chains preserve their original team policy and null ownership, including occupied secondary wrecks.

Helicopters accelerate through rotor tilt and keep world-space momentum while the yaw pedals turn the body. Jets use one physical flight model for people, bots and boundary guidance: angular rates, retained attitude, banked turns, rudder slip, airspeed/angle-of-attack lift and recoverable stalls. Automatic gear deployment waits until the expanded hull fits. The physical ceiling constrains the hull's top while allowing horizontal travel and a descending escape.

Frontier uses a 1,800-metre camera range and a skyline fade from 1,250 to 1,760 metres. Tiered detailed chunk limits are 289/625/841/1,089. An eight-metre ground layer and a 2 by 1 by 2 metre shell derive distant silhouettes from authoritative voxels, preserving overhead gaps and the boundary between coarse and exact geometry. The initial physics qualification measured two distant draws and about 30 MiB of retained CPU buffers. This is a local diagnostic, not a physical-phone memory measurement.

## Initial physics browser observations

All tests use ordinary keyboard or pointer events and read-only game snapshots. Music and sound effects remain at zero. Touch checks use browser emulation.

- An empty Jeep moved from x=139.65 to x=136.21 over 1.1 seconds while slowing from -5.13 to -1.23 metres per second. Its seat remained empty.
- Helicopter collective raised it to 36.76 metres ASL. Forward cyclic produced nose-down tilt and acceleration. After the pedals turned yaw to -1.63 radians, the existing northward velocity remained -9.53 metres per second, demonstrating independent body heading and momentum.
- A low flight into the real rail depot destroyed the helicopter once: hull zero, seat empty, pilot dead, one accepted burst, 18 debris pieces and 40 embers. [Crash frame](aircraft/vehicle-explosion-live.png).
- Touch collective raised the helicopter to 40.38 metres. DOWN reduced altitude from 46.36 to 37.60 metres over 2.2 seconds. A continuous drag produced actual pitch and bank, with full hull health and finite motion.
- Desktop 1440 by 900, portrait 390 by 844 and landscape 844 by 390 showed about 60 rendered FPS and no shader errors on this machine. [Desktop flight](aircraft/helicopter-inertia-range.png), [portrait](aircraft/helicopter-inertia-touch.png), [landscape](aircraft/helicopter-inertia-touch-landscape.png). The landscape telemetry sits below the airframe.

## Regression and review

Focused regressions cover destruction and chain ownership, coasting, the actual event-delivery pipeline, particle budgets and disposal, angular hull sweeps, blocked gear deployment, ceiling recovery, flight rate consistency at 30/60/144 Hz, real-map bot flight/combat, adaptive detail, mixed-LOD seams and fog material cleanup. Independent review reproduced the defects in event subscriptions, environmental chain credit, obstructed gear, terrain seams, disposed-material retention and ceiling flight, and checked their fixes.

## Shared crew, model parts and fleet expansion

The final Frontier world has sixteen hulls, two of each type per team. Eight hulls and 22 seats per team cover the default 8-versus-8 match. New reserve parking bays, four helipads and four clear runways preserve the detailed map. Its RLE is 1,515,124 bytes with fingerprint `ff0db807`. The lobby hero and square overview were exported again from the real renderer, at 1440 × 900 and 1024 × 1024.

Jeeps and Helicopters have four real seats, Tanks have an enclosed driver and gunner, and Jets have one pilot. Seats are authoritative and independent. A mounted player is shielded from direct infantry weapon and burn paths; hull destruction kills each crew member once. Driver exit preserves motion; passenger exit preserves the driver. Late mounted fire packets and held mouse, touch and pad fire across an exit acknowledgement cannot become an infantry shot. Fresh presses work immediately and existing reload progress survives.

The repaired Tank uses outward armor faces, separated road/end wheels and return rollers, with 118 meshes and 22 wheel pivots. The turret and cannon retain their authoritative muzzle alignment. [Actual repaired front](vehicles/tank-front-repaired.png), [live driver](vehicles/tank-driver-live.png).

Destruction extracts actual model assemblies: 40 Jeep, 64 Tank, 64 Helicopter and 62 Jet fragments at the normal detail budget. Low detail caps each burst at 32; the global pool caps fragments at 1024 and expires them after 14 seconds. Originals detach when the interpolated explosion presents. Fragments use the blast position and the retained visible orientation; later wreck motion cannot move the source early. Snapshot-only late-join wrecks still render immediately, and respawn invalidates stale explosions.

The muted two-browser Tank test showed both seats occupied, driver motion at 7.41 metres per second, independent gunner aim and cannon cooldown. The gunner exited while the driver remained seated and continued moving. A final Helicopter flight used cyclic/bank input and physical hover braking at 46.89 metres ASL. A flight into the real tower destroyed the hull and pilot once, emptied every seat, and produced one accepted burst with 64 model fragments, 36 secondary debris pieces and 40 embers. The immediate death-camera frame is close to the scattering assemblies. [Actual burst](aircraft/vehicle-multipart-explosion-live.png), [final flight](aircraft/helicopter-final-live.png).

Desktop 1440 × 900 and a 390 × 844 responsive crew HUD were inspected. [Mobile crew HUD](vehicles/crew-hud-mobile.png) shows the actual seated Jeep driver. The full sixteen-vehicle scene measured about 60 rendered FPS on this machine, with no retained shader errors; this is not a physical phone measurement. All browser playtests kept music and effects at zero.

The initial complete final suite passed all 50 Conquest commands, atlas, static/preload, actual connection/discrete-shot/reload network checks and the graphics suite. After seat-input and delayed-explosion fixes, 17 focused commands passed at stable source digest `49ff33d9a6d6a9d711dcd110110047f5ef91311b3d076830df0ce1878f485861`. Full-map bot flight entered and traveled in all sixteen hulls, with zero terrain hits, four successful helicopter landings/exits and all four Jets in sustained loiter. Preload resolves 177 modules.

A longer live Jet flight subsequently exposed a boundary-guidance latch: continuous pursuit of the moving map center could settle into a permanent banked orbit and suppress manual controls. Independent Frontier simulation reproduced the exact captured pose for 120 seconds. Boundary recovery now has a physical bank-unwind phase along a fixed inward course, after checking clear interior travel. The physical handoff released the captured orbit in 1.27 seconds. Independent checks covered eight mirrored quadrants and six speed/bank cases, all with full hull health and legal compound bounds. The related held-hover-brake recovery now temporarily owns the brake while turning, then restores the user's original lift, brake and yaw inputs. Its captured case handed control back in 8.72 seconds and resumed climbing.

The final local server loaded `server/sim/vehicles.js` SHA256 `dce5a290292c5eb45c9e3f6e2c428878431463ef99a8c213c998939fe03c7a43`. A fresh ordinary-input Jet flight recorded 107 browser samples during W+Space and then 3.5 seconds of Shift input. Applying the authoritative compound collider offline to the observed poses found a maximum hull top of 179.99999 metres, 40 ceiling-contact samples and 202.51 metres of continued movement during adjacent ceiling samples, with no zero-movement pairs and full 450 hull health. After another boundary recovery, Shift reduced pitch from 0.0028 to -0.4726 radians and altitude from 147.89 to 94.24 metres. Sustained descent later hit terrain and emitted one crash burst. [Read-only flight samples and collider analysis](aircraft/final-flight-samples.json), [actual flight frame](aircraft/jet-final-live.png). The shader error list remained empty and sound-effects volume remained zero.

Final qualification after both boundary fixes passed all 50 Conquest commands again, plus atlas and current static/preload checks. The source remained unchanged during the run at digest `d517a586cc6163c3cd0a7e842d568cc29bd7be80d5117963b0c488b16dbd2aea`; code-only digest is `887cf97b1233fa34348ba9c82086b7da5c13797ceb0dd9e759e32e5dfb4a318f`. Full-map bot flight again entered and traveled in all sixteen hulls without terrain hits, landed and exited all four Helicopters, and sustained loiter in all four Jets. The minimum longest Jet loiter was 14.18 seconds. The boundary regression recorded 13 handoffs over 120 seconds, with the longest recovery 9.17 seconds. [Final machine-readable qualification](qualification-final.json).

Changes remain local. No commit, push or deployment was requested.
