# Jeep handling

`shared/vehicle-handling/jeep.js` owns the Jeep driving tune. Its frozen `JEEP_RULES` replaces the Jeep entry in `VEHICLE_RULES`. The collision dimensions are a 2.1 metre radius and 2.25 metre height, with a 1.35 metre seat offset.

Call `stepJeepDrive(vehicle, { throttle, steer, brake }, dt)` before integrating position. Throttle and steer range from -1 to 1; optional brake ranges from 0 to 1. Positive throttle drives forward, positive steer turns right. Opposite throttle brakes to zero before engaging the other direction. Brake overrides throttle. The function mutates `speed` (metres per second), `yaw` (radians), `visualSteer` (front wheel angle in radians) and `yawRate` (signed radians per second). Position, terrain placement and collision response remain with the server vehicle system. A collision can set speed to zero directly.

Forward speed caps at 24 metres per second and reverse at 7. Acceleration tapers as speed rises. Coasting uses rolling resistance plus speed dependent drag. Steering uses bicycle curvature with a reduced front wheel angle at high speed and a yaw rate cap of 1.4 radians per second. The approximate full lock turning radius is 7.5 metres at 8 metres per second and 21.4 metres at maximum speed. A stationary Jeep cannot turn. Reverse steering follows wheel direction.

Finite positive time steps are capped at 0.25 seconds and internally split into steps no larger than 1/240 second. The outer vehicle system still needs collision substeps so walls cannot be crossed. Invalid controls are neutral, invalid initial speed/yaw are repaired to zero, and invalid time steps leave state unchanged.

Run `node tools/conquest-jeep-handling-test.mjs`. It checks launch, speed caps, coast, service braking, directional braking, reversing, turning radii, stationary steering, equivalence at 30/60/120 Hz and malformed input boundaries. Browser handling acceptance still requires a driven Jeep on terrain and around obstacles.
