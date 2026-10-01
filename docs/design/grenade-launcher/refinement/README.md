# GL-3 SKIPJACK refinement

The selected reference is [Alternative A](concept-connected-stock.png). It keeps
the twin stock rails and joins them with a continuous central bridge and
transverse brackets. Bolts sit flush at supported joints. The orange receiver,
side cassette, optic and muzzle direction follow the existing launcher.
[Alternative B](concept-braced-stock.png) and the exact generation prompts in
[concept-prompts.json](concept-prompts.json) record the design comparison.

The cassette and chamber show the real ammunition state. A full launcher has
one round in the chamber and two visible at its side. On an empty reload,
three fresh rounds rise in the side cassette. At the top of that shift, the
leading round slides through the feed into the chamber and leaves two visible. A
tactical reload retains the chambered round and replaces the two side rounds.
The starting load plus two spare three-round cassettes keeps the life budget at
nine rounds. The moving shell groups, support hand and reload contacts are
driven by that sequence, with cancellation restoring the closed pose.

The grenade has a small terrain breach: 2.8 m radius, 145 nominal power and a
32-block cap per blast. The server still applies material resistance, line of
sight, world bounds and protected-block rules before it emits voxel changes.
The client presents those authoritative block changes with the existing
512-particle debris pool. [The destruction test](../../../../tools/skipjack-destruction-test.mjs)
checks resistant cover, protected floor blocks, voxel events and the cap.

The `before-angle-*.png` captures show the unsupported rear details. Compare
[the selected reference](concept-connected-stock.png) with the
[final stock angle](after-angle-hero.png), the [desktop firing pose](after-desktop/mgl-firing.png),
the [mobile incoming cassette](after-mobile/mgl-reload-incoming.png), and the
[desktop chamber feed](after-desktop/mgl-reload-slide.png). The
[browser validation report](browser-validation.json) records 47 static captures
across desktop, mobile and landscape, six inspection angles, finite feed and
reload transforms, and bounded FX cleanup. Its live Killhouse run confirms a
three-to-two magazine transition, one MGL launch and detonation, six server
block removals with matching client readback, 84 material-matched debris
particles, and zero browser errors. The [live breach capture](after-desktop/mgl-killhouse-breach.png)
shows the result.
