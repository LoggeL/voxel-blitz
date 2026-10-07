# Tank handling

The tank reaches 13 m/s forward and 5 m/s backwards. Forward acceleration is
3.8 m/s². Opposite throttle applies 8 m/s² braking until the hull stops, then
accelerates in the requested direction. Released throttle coasts at 1.5 m/s².

`stepTankDrive(state, { throttle, steer, brake }, dt)` mutates `speed`, `yaw`,
`yawRate`, `leftTrackSpeed`, and `rightTrackSpeed`. Inputs lie in [-1, 1].
Brake lies in [0, 1], overrides throttle, and scales the 8 m/s² deceleration.
It holds zero speed while allowing differential steering pivots.
Positive steer means right (D); positive world yaw means left. Differential
tracks permit a stationary pivot. Turn speed builds and decays at 1.7 rad/s²,
with 0.72 rad/s stationary and 0.85 rad/s moving limits. Substeps are at most
1/120 s. Invalid and negative time advances nothing; a single update is capped
at 0.25 s to bound delayed-frame movement.

`stepTankTurret(state, { yaw, pitch }, dt)` mutates `turretYaw` and
`turretPitch`. Aim is in world space, independent of hull yaw. Horizontal aim
uses the shortest path at 1.05 rad/s, with unrestricted full rotation. Vertical
aim moves at 0.65 rad/s and stays between -0.18 and 0.55 rad. Missing or invalid
aim retains the last valid orientation. Fire direction must use the simulated
turret pose, never the requested mouse pose.

The hull footprint is 5.1 by 3.7 m, with 2.65 m height and a conservative
2.65 m collision radius. Seat height is 1.9 m. Collision and positional movement
are handled by the caller using authoritative terrain and hull state.

Run `node tools/conquest-tank-handling-test.mjs` for acceleration, braking,
reverse, left/right pivot, track direction, hull inertia, turret seam and pitch
limits, frame rate agreement, and invalid-number coverage.
