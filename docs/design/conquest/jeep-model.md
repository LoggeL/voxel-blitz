# Jeep model

The open utility Jeep uses a narrow flat hood, seven-slot grille, exposed passenger compartment, two front seats, rear bench and a square roll cage. A rear spare, jerrycan, mirrors, tow hooks, step plates and antenna give each viewing angle recognizable landmarks. Twelve-sided chunky rubber tires have separate tread blocks, steel hubs and painted center caps. Paint uses the supplied material so the integration layer can apply its generated armor texture.

Coordinates use meters, ground at Y=0 and forward along local -Z. Bounds are approximately 2.23 m wide and 4.17 m long. The cage tops out at 2.17 m; only the thin antenna rises to 2.82 m. The model has 84 mesh objects, including five instanced tread meshes, and no generated ground shadow.

`makeJeepModel(materials)` returns the hull, four road-wheel spin groups, two front steering pivot groups and empty turret/gun groups for the renderer contract. Animate `wheels[].rotation.x` for rolling and `frontWheels[].rotation.y` for steering. The spare is deliberately excluded from animated wheels. The model does not set gameplay values or HP and does not scale the full hull.

Run `node tools/conquest-jeep-model-test.mjs` for geometry, axle, wheel-animation, landmark and detail-budget checks. Integrated browser appearance and handling remain the parent task's validation responsibility.
