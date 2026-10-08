// RX-8 HAVOC launcher sight: holdover marks against the authoritative rocket
// integrator, the rangefinder (water ignored, hulls and bodies, out of range,
// 10 Hz throttle), the impact estimate, and that the launcher reticle only
// shows while the RX-8 is scoped.
import assert from 'node:assert/strict';
import { WEAPONS, isScopedWeapon, SNIPER_SCOPE_ADS_THRESHOLD } from '../shared/combatmath.js';
import { configuredWeapon } from '../shared/weapon-attachments.js';
import {
  ROCKET_RULES, ROCKET_SIGHT, ROCKET_FLIGHT_STEP_S, rocketLaunch, stepRocket,
  rocketSightMarks, rocketReachM, rocketElevation,
} from '../shared/rocket-rules.js';
import { VEHICLE_DEFS } from '../shared/vehicle-defs.js';
import { AIR, STONE, MC_WATER } from '../shared/world/blocks.js';
import { isScopeActive } from '../public/js/guns/scope-state.js';
import { installFakeDom } from './lib/conquest-ui-dom.mjs';

let checks = 0;
const ok = (condition, label) => { assert.ok(condition, label); checks++; };

/* --------------------------------------------------- holdover vs. the integrator */

/** Fly a rocket from the eye at `pitch` over open air; height at horizontal `range`. */
function simulatedHeight(pitch, range) {
  const dir = { x: 0, y: Math.sin(pitch), z: -Math.cos(pitch) };
  const rocket = rocketLaunch({ x: 0, y: 0, z: 0, dir });
  const life = ROCKET_RULES.lifetimeMs / 1000;
  let prev = { z: rocket.z, y: rocket.y };
  for (let t = 0; t < life + 1e-9; t += ROCKET_FLIGHT_STEP_S) {
    stepRocket(rocket, ROCKET_FLIGHT_STEP_S, () => null);
    if (-rocket.z >= range) {
      const f = (range + prev.z) / (prev.z - rocket.z);
      return { y: prev.y + (rocket.y - prev.y) * f, t: t + ROCKET_FLIGHT_STEP_S };
    }
    prev = { z: rocket.z, y: rocket.y };
  }
  return null;  // self-destructed first
}

const marks = rocketSightMarks();
const reach = rocketReachM();
ok(ROCKET_SIGHT.ranges.join() === '50,100,150,200', 'sight ladder candidates are 50/100/150/200 m');
ok(marks.map(m => m.range).join() === ROCKET_SIGHT.ranges.filter(r => r <= reach).join(),
  `only ranges inside the rocket's reach get a mark (reach ${reach.toFixed(1)} m)`);
ok(Math.abs(reach - ROCKET_RULES.speed * ROCKET_RULES.lifetimeMs / 1000) < 3,
  'reach is about speed x lifetime (no motor, no drag)');
for (const mark of marks) {
  const pitch = Math.atan(mark.mil / 1000);
  const flown = simulatedHeight(pitch, mark.range);
  ok(flown, `${mark.range} m: the rocket reaches the mark range`);
  // The mark puts the rocket back on the sight line: |miss| well under a rocket radius.
  ok(Math.abs(flown.y) < 0.05, `${mark.range} m mark lands on the sight line (miss ${flown.y.toFixed(3)} m)`);
  const level = simulatedHeight(0, mark.range);
  ok(Math.abs(-level.y - mark.dropM) < 0.02, `${mark.range} m drop of a centre hold matches (${mark.dropM.toFixed(2)} m)`);
  ok(Math.abs(flown.t - mark.flightS) < ROCKET_FLIGHT_STEP_S + 1e-6, `${mark.range} m flight time matches`);
}
ok(marks.every((m, i) => i === 0 || m.mil > marks[i - 1].mil), 'marks step down the ladder with range');
ok(rocketElevation(200) === null && simulatedHeight(Math.atan(0.14), 200) === null,
  '200 m is past the rocket lifetime: no mark, and the integrator agrees');
const mark100 = marks.find(m => m.range === 100);
ok(mark100.mil > 65 && mark100.mil < 75 && mark100.dropM > 6.5 && mark100.dropM < 7.3,
  `100 m hold ~70 mil / ~6.9 m drop (got ${mark100.mil.toFixed(1)} mil, ${mark100.dropM.toFixed(2)} m)`);

/* ------------------------------------------------------------- scoped weapon */

ok(isScopedWeapon(WEAPONS.rocket) && WEAPONS.rocket.zoom === 2.5, 'factory RX-8 sight is a 2.5x scoped optic');
const scopedFov = 2 * Math.atan(Math.tan(37.5 * Math.PI / 180) / WEAPONS.rocket.zoom) * 180 / Math.PI;
ok(Math.abs(WEAPONS.rocket.adsFov - scopedFov) < 1, 'adsFov matches the 2.5x view of the 75 deg base');
ok(!isScopedWeapon(configuredWeapon('rocket', { rocket: { optic: 'reflex' } })), 'reflex RX-8 stays an open sight');
ok(isScopedWeapon(configuredWeapon('rocket', { rocket: { optic: 'scope2' } })), '2x tube RX-8 also uses the launcher sight');
ok(!isScopeActive({ weapon: 'rocket', scoped: true, ads: SNIPER_SCOPE_ADS_THRESHOLD - 0.01 }), 'hip / early ADS: no sight');
ok(isScopeActive({ weapon: 'rocket', scoped: true, ads: SNIPER_SCOPE_ADS_THRESHOLD }), 'ADS past the threshold: sight up');
ok(!isScopeActive({ weapon: 'rocket', scoped: true, ads: 1, reloading: true }), 'reloading drops the sight');

/* --------------------------------------------------------------- rangefinder */

const { rangefinderReading, rocketImpactEstimate, LauncherRangefinder } = await import('../public/js/ui/launcher-rangefinder.js');
const { WorldView } = await import('../public/js/engine/worldview.js');

// A flat stone floor (y < 0), a pond of water standing 0..3 between z -20 and -40,
// and an optional wall at z = wallZ. Eye at 1.62 m, looking down -z.
function world({ wallZ = -80, pond = true } = {}) {
  const getBlock = (x, y, z) => {
    if (y < 0) return STONE;
    if (pond && y <= 3 && z <= -20 && z > -40) return MC_WATER;
    if (wallZ != null && z <= wallZ && z > wallZ - 2 && y < 20) return STONE;
    return AIR;
  };
  return {
    solid: (o, d, m) => WorldView.prototype.pickSolidRay.call({ store: { getBlock } }, o, d, m),
    camera: (o, d, m) => WorldView.prototype.pickCameraRay.call({ store: { getBlock } }, o, d, m),
  };
}
const eye = { x: 0.5, y: 1.62, z: 0.5 };
const ahead = { x: 0, y: 0, z: -1 };
{
  const { solid, camera } = world();
  const reading = rangefinderReading({ origin: eye, dir: ahead, pickSolid: solid });
  ok(reading?.target === 'terrain' && Math.abs(reading.distance - 79.5) < 0.01,
    `water is ranged through: wall at 79.5 m (got ${reading?.distance})`);
  const wet = rangefinderReading({ origin: eye, dir: ahead, pickSolid: camera });
  ok(wet && wet.distance < 21, 'a water-stopping picker would have read the pond instead');
}
{
  const { solid } = world({ wallZ: -400, pond: false });
  ok(rangefinderReading({ origin: eye, dir: ahead, pickSolid: solid }) === null,
    `no return inside ${ROCKET_SIGHT.rangefinderMaxM} m reads null`);
  ok(rangefinderReading({ origin: eye, dir: { x: 0, y: 1, z: 0 }, pickSolid: solid }) === null, 'open sky reads null');
}
{
  const { solid } = world();
  const tank = { id: 'v1', type: 'tank', x: 0.5, y: 0, z: -50, yaw: 0, hp: 1000 };
  const hull = rangefinderReading({ origin: eye, dir: ahead, pickSolid: solid, hulls: [tank] });
  const front = 50.5 - VEHICLE_DEFS.tank.collider.halfLength;
  ok(hull?.target === 'vehicle' && hull.distance < 50.5 && hull.distance > front - 1.5,
    `a hull in front of the wall ranges at its face (${hull?.distance?.toFixed(2)} m)`);
  ok(rangefinderReading({ origin: eye, dir: ahead, pickSolid: solid, hulls: [tank], ignoreVehicleId: 'v1' }).target === 'terrain',
    'the shooter\'s own hull is ignored');
  ok(rangefinderReading({ origin: eye, dir: ahead, pickSolid: solid, hulls: [{ ...tank, hp: 0 }] }).target === 'terrain',
    'a burnt-out (non-solid) wreck does not range');
  const body = rangefinderReading({ origin: eye, dir: ahead, pickSolid: solid, hulls: [tank], bodies: [{ x: 0.5, y: 0, z: -30 }] });
  ok(body?.target === 'player' && Math.abs(body.distance - 30.1) < 0.05, `a standing body ranges first (${body?.distance})`);
}
{
  // Impact estimate: holding the 100 m mark on a wall at 100 m puts the rocket into it at eye height.
  const { solid } = world({ wallZ: -99.5, pond: false });
  const pitch = Math.atan(mark100.mil / 1000);
  const impact = rocketImpactEstimate({ origin: eye, dir: { x: 0, y: Math.sin(pitch), z: -Math.cos(pitch) }, pickSolid: solid });
  ok(impact && !impact.airburst && Math.abs(impact.point[1] - eye.y) < 0.35 && Math.abs(impact.range - 100) < 0.6,
    `100 m hold hits a 100 m wall at sight height (y ${impact?.point[1].toFixed(2)}, range ${impact?.range.toFixed(2)})`);
  const level = rocketImpactEstimate({ origin: eye, dir: ahead, pickSolid: world({ wallZ: null, pond: false }).solid });
  ok(level && !level.airburst && level.point[1] < 0.3 && level.range > 30 && level.range < 60,
    `a level shot over flat ground drops into the floor short of 60 m (${level?.range.toFixed(1)} m)`);
  const sky = rocketImpactEstimate({ origin: eye, dir: { x: 0, y: 0.5, z: -0.866 }, pickSolid: world({ wallZ: null, pond: false }).solid });
  ok(sky?.airburst && Math.abs(sky.time - ROCKET_RULES.lifetimeMs / 1000) < 1e-6, 'a shot into the sky self-destructs at its lifetime');
}
{
  const finder = new LauncherRangefinder();
  const { solid } = world();
  let built = 0;
  const input = () => { built++; return { origin: eye, dir: ahead, pickSolid: solid }; };
  ok(finder.sample(0, false, input) === null && built === 0, 'inactive: nothing sampled or built');
  const first = finder.sample(1000, true, input);
  for (let t = 1001; t < 1100; t += 16) finder.sample(t, true, input);
  ok(built === 1 && Math.abs(first.reading.distance - 79.5) < 0.01, 'one sample per 100 ms window');
  finder.sample(1100, true, input);
  ok(built === 2, 'resamples at 10 Hz');
  // Held over into the sky: the last return stays up, flagged, for memoryMs.
  const skyInput = { origin: eye, dir: { x: 0, y: 1, z: 0 }, pickSolid: solid };
  const held = finder.sample(1200, true, skyInput);
  ok(held.reading?.held === true && Math.abs(held.reading.distance - 79.5) < 0.01, 'a lost return is held');
  ok(finder.sample(1100 + ROCKET_SIGHT.memoryMs + 100, true, skyInput).reading === null, 'the held return expires');
  ok(finder.sample(9000, true, input).reading?.held === undefined, 'a fresh return is live again');
  ok(finder.sample(9100, false, input) === null && finder.reading === null, 'dropping the sight forgets the reading');
  ok(finder.sample(9200, true, skyInput).reading === null, 'no memory survives the sight dropping');
}

/* ----------------------------------------------------------- sight overlay */

const dom = installFakeDom({ width: 1280, height: 720 });
const { createSniperScope, updateScopeOptics, updateLauncherSight, scopeReticleKind, rangefinderText,
  LAUNCHER_SIGHT_MARKS, LAUNCHER_STADIA_WIDTH_M } = await import('../public/js/ui/sniper-scope.js');
ok(LAUNCHER_STADIA_WIDTH_M === 2 * VEHICLE_DEFS.tank.collider.halfWidth, 'stadia bars span the tank collider width');
ok(scopeReticleKind(WEAPONS.rocket) === 'launcher' && scopeReticleKind(WEAPONS.sniper) === 'sniper'
  && scopeReticleKind(configuredWeapon('rifle', { rifle: { optic: 'scope4' } })) === 'sniper', 'only the RX-8 gets the launcher reticle');
ok(rangefinderText(null) === '---' && rangefinderText({ distance: 87.6 }) === '88', 'readout text');
const scope = createSniperScope(dom.document.body);
const bars = scope.querySelectorAll('.launcher-bar');
ok(bars.length === LAUNCHER_SIGHT_MARKS.length && bars.map(b => b.dataset.range).join() === '50,100,150',
  'one ladder bar per reachable range');
ok(bars[1].style.top === `calc(50% + ${mark100.mil.toFixed(3)} * var(--scope-mil, 0.33vh))`, 'bars sit at the holdover in mils');
updateScopeOptics(scope, scopedFov, null, 720, 'launcher');
ok(scope.classList.contains('launcher-sight'), 'the RX-8 scope carries the launcher sight');
const readout = scope.querySelector('.launcher-readout');
const value = scope.querySelector('.launcher-readout-value');
updateLauncherSight(scope, { reading: { distance: 87.4, target: 'terrain' }, impact: null });
ok(value.textContent === '87' && readout.dataset.state === 'in-reach', 'in-reach reading');
updateLauncherSight(scope, { reading: { distance: 240, target: 'terrain' }, impact: null });
ok(value.textContent === '240' && readout.dataset.state === 'beyond'
  && scope.querySelector('.launcher-readout-note').textContent === 'OUT OF REACH', 'beyond reach is flagged');
updateLauncherSight(scope, { reading: { distance: 98, target: 'vehicle', held: true }, impact: null });
ok(value.textContent === '98' && readout.dataset.held === 'true' && scope.querySelector('.launcher-readout-tag').textContent === 'RANGE · HELD',
  'a held return is marked');
updateLauncherSight(scope, { reading: null, impact: null });
ok(value.textContent === '---' && readout.dataset.state === 'none' && readout.dataset.held === 'false', 'no return reads ---');
const impactNode = scope.querySelector('.launcher-impact');
updateLauncherSight(scope, { reading: null, impact: { point: [0, 0, -50], airburst: false }, screen: { x: 0.5, y: 0.62, behind: false } });
ok(!impactNode.hidden && impactNode.style.top === '62.00%', 'impact diamond placed in screen space');
updateLauncherSight(scope, { reading: null, impact: { point: [0, 0, -50], airburst: false }, screen: { x: 0.5, y: 0.5, behind: true } });
ok(impactNode.hidden, 'an impact behind the camera hides the diamond');
updateScopeOptics(scope, 17.5, { speed: 1 }, 720, 'sniper');
ok(!scope.classList.contains('launcher-sight') && value.textContent === '---', 'a rifle scope drops the launcher sight and its reading');

// Full gameplay HUD: the launcher sight shows only while the RX-8 is scoped.
let hudChecked = false;
try {
  const { HUD } = await import('../public/js/ui/hud.js');
  const hud = new HUD();
  hud.buildHUD();
  const base = { hp: 100, alive: true, wname: 'RX-8 HAVOC', mag: 1, reserve: 4, crosshairX: 0.5, crosshairY: 0.5,
    launcherSight: { reading: { distance: 123.2, target: 'terrain' }, impact: null } };
  hud.setState({ ...base, wid: 'rocket', adsT01: 0.3, scopeActive: false });
  const hipScope = hud.gameplay.dom.scope;
  ok(!hipScope || !hipScope.classList.contains('active'), 'hip fire: no launcher sight');
  hud.setState({ ...base, wid: 'rocket', adsT01: 1, scopeActive: true, scopeFovDeg: scopedFov, scopeZoom: 2.5 });
  const live = hud.gameplay.dom.scope;
  ok(live.classList.contains('active') && live.classList.contains('launcher-sight')
    && live.querySelector('.launcher-readout-value').textContent === '123', 'scoped RX-8: launcher sight with the live range');
  hud.setState({ ...base, wid: 'sniper', adsT01: 1, scopeActive: true, scopeFovDeg: 17.5, scopeZoom: 5 });
  ok(live.classList.contains('active') && !live.classList.contains('launcher-sight'), 'sniper keeps its own reticle');
  hudChecked = true;
} catch (error) {
  if (!/is not a function|is not defined|Cannot read properties/.test(String(error?.message))) throw error;
  console.warn(`[rocket-sight] gameplay HUD skipped under the fake DOM: ${error.message}`);
}

console.log(`RX-8 launcher sight: ${checks} checks passed (marks ${marks.map(m => `${m.range} m ${m.mil.toFixed(1)} mil / ${m.dropM.toFixed(2)} m drop`).join(', ')}; reach ${reach.toFixed(1)} m${hudChecked ? '; gameplay HUD wiring' : ''}).`);
