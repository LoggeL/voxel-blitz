// Conquest airborne / takeover presentation: deploy seats a bot holds ("TAKE"),
// the Interact prompt on a bot-crewed hull, F-key requests for bot seats, the
// fall kill key in the feed and killer card, the parachute prompt and touch
// label, and the canopy / ejection-seat effects. Fake DOM, no browser.
import assert from 'node:assert/strict';
import * as THREE from '../public/js/vendor/three.module.js';
import { installFakeDom } from './lib/conquest-ui-dom.mjs';
import { CHUTE, EJECTION } from '../shared/parachute.js';

const { document } = installFakeDom({ width: 1440, height: 900 });
const state = await import('../public/js/ui/conquest-hud-state.js');
const { DeployScreen } = await import('../public/js/ui/conquest/deploy-screen.js');
const { VehicleController } = await import('../public/js/session/vehicle-controller.js');
const { WEAPON_NAMES, isVehicleKillKey } = await import('../public/js/ui/hud-support.js');
const { KILL_KEY_ICONS, ICON_PATHS } = await import('../public/js/ui/conquest/icons.js');
const { ParachuteFx, PARACHUTE_FX } = await import('../public/js/vehicles/parachute-fx.js');
const { VehicleFx } = await import('../public/js/vehicles/vehicle-fx.js');
const { conquestHudFixtures, fixtureMapMeta, FIXTURE_NOW } = await import('../public/js/capture/conquest-hud-fixtures.js');
let checks = 0;
const check = (value, message) => { assert(value, message); checks++; };

const deploy = conquestHudFixtures().find(f => f.id === 'deploy');
const cq = state.readConquest(deploy.match, fixtureMapMeta());
const bots = [{ id: 'bot-7', name: 'BOT-7', team: 'alpha', state: 'alive', hp: 100, x: 100, y: 40, z: 380 },
  { id: 'bot-8', name: 'BOT-8', team: 'alpha', state: 'alive', hp: 100, x: 101, y: 40, z: 381 }];
const jeep = { ...deploy.vehicles[0], id: 'alpha-jeep', type: 'jeep', hp: 320,
  seatOccupants: { driver: 'bot-7', gunner: 'tm1', 'front-passenger': 'tm1', 'rear-left': 'bot-8' } };
const players = [...deploy.players, ...bots], vehicles = [...deploy.vehicles, jeep];

// --- deploy model and screen ----------------------------------------------------------
{
  const model = state.deployModel({ cq, self: deploy.self, players, vehicles, nowMs: FIXTURE_NOW, selection: { spawn: 'vehicle:alpha-jeep' } });
  const option = model.options.find(o => o.spawn === 'vehicle:alpha-jeep');
  check(option.ok && option.detail === 'TAKE SEAT · BOT-7', `a full jeep with bots offers its seats (${option.detail})`);
  check(option.seatChoices.join() === 'driver,rear-left' && option.takeoverNames['rear-left'] === 'BOT-8', 'bot seats in F-key order with names');
  check(model.valid && model.seatId === 'driver', 'deploying to the hull takes the first bot seat');
  const screen = new DeployScreen(document.createElement('div'), {});
  screen.selection = { ...screen.selection, spawn: 'vehicle:alpha-jeep' };
  screen.setOpen(true, null);
  screen.update({ cq, self: deploy.self, players, vehicles, nowMs: FIXTURE_NOW, mapItems: [], meta: null });
  const chips = screen.spawnList.querySelectorAll('.cq-spawn-seat').filter(chip => chip.classList.contains('is-takeover'));
  check(chips.map(chip => chip.textContent).join() === 'TAKE DRIVER,TAKE REAR L', `takeover chips (${chips.map(c => c.textContent)})`);
  chips[1].click();
  check(screen.selection.spawn === 'vehicle:alpha-jeep:rear-left', 'a takeover chip picks that seat');
  screen.update({ cq, self: deploy.self, players, vehicles, nowMs: FIXTURE_NOW, mapItems: [], meta: null });
  check(screen.model.valid && screen.model.seatId === 'rear-left', 'the picked bot seat is a valid deploy');
  const rows = screen.spawnList.querySelectorAll('.cq-spawn');
  check(!rows.some(row => row.textContent.includes('TARGET IS BUSY')), 'no "target is busy" for a bot-crewed hull');
}

// --- Interact prompt and F-keys on a bot-crewed hull ---------------------------------------
{
  const self = { ...deploy.self, state: 'alive', hp: 100, x: jeep.x, y: jeep.y, z: jeep.z };
  const prompt = state.interactModel({ self, players, vehicles, nearbyVehicle: jeep, seated: null });
  check(prompt?.type === 'enter' && prompt.takeover === true && prompt.seatId === 'driver' && prompt.label.includes('BOT-7'),
    `Interact takes the bot driver seat (${prompt?.label})`);
  const controller = new VehicleController({ eventTarget: null });
  controller.sync({ self, vehicles: [jeep], enabled: true });
  check(controller.nearest?.id === 'alpha-jeep', 'a hull with only bot seats left is still enterable');
  check(controller.requestSeat(0) && controller.consumeAction()?.seatId === 'driver', 'F1 asks for the bot driver seat');
  check(controller.requestSeat(1) === false, 'F2 on a human seat is refused locally');
}

// --- fall deaths in the feed and on the killer card ---------------------------------------
{
  check(WEAPON_NAMES.fall === 'FELL' && isVehicleKillKey('fall') && ICON_PATHS[KILL_KEY_ICONS.fall], 'the fall key has a name and a vector icon');
  check(WEAPON_NAMES.crash === 'CRASHED' && isVehicleKillKey('crash') && ICON_PATHS[KILL_KEY_ICONS.crash], 'so does the crash key');
  const own = state.killerCard({ kind: 'kill', killer: '', victim: 'me', w: 'fall' }, 'me', []);
  check(own.self && own.name === 'FELL', 'a self fall reads YOU DIED · FELL');
  const credited = state.killerCard({ kind: 'kill', killer: 'en9', victim: 'me', w: 'fall' }, 'me', deploy.players);
  check(!credited.self && credited.weaponName === 'FELL', 'a credited fall names the enemy and the fall');
  check(state.chutePromptModel('ready')?.binding === 'jump' && state.chutePromptModel('open').label === 'CUT PARACHUTE'
    && state.chutePromptModel(null) === null, 'parachute prompt follows the predicted state');
}

// --- canopy and ejection-seat effects --------------------------------------------------------
{
  const group = new THREE.Group(), emitters = new Set(), emits = [];
  const fx = { addEmitter: e => { emitters.add(e); return e; }, removeEmitter: e => emitters.delete(e), emit: (kind) => emits.push(kind) };
  let shake = 0;
  const chutes = new ParachuteFx({ group, fx, cameraShake: { add: v => { shake += v; } } });
  const rows = [{ id: 'me', team: 'alpha', state: 'alive', x: 0, y: 50, z: 0, yaw: 0 },
    { id: 'en1', team: 'bravo', state: 'alive', x: 10, y: 60, z: 0, yaw: 1, cq: [0, 1, 0, 0, 0, 0, 0, CHUTE.open] },
    { id: 'tm1', team: 'alpha', state: 'alive', x: 20, y: 70, z: 0, yaw: 0, cq: [0, 1, 0, 0, 0, 0, 0, CHUTE.seat] },
    { id: 'tm2', team: 'alpha', state: 'alive', x: 30, y: 2, z: 0, yaw: 0, cq: [0, 1, 0, 0, 0, 0, 0] }];
  const local = { pos: { x: 1, y: 49, z: 1 }, yaw: 0.5, chute: CHUTE.open };
  chutes.sync(rows, { selfId: 'me', selfTeam: 'alpha', local, positionOf: id => (id === 'en1' ? { x: 11, y: 61, z: 1 } : null), dt: 0.016 });
  check(chutes.count === 3, 'own predicted canopy, an enemy canopy and a seat ride; grounded rows draw nothing');
  check(chutes.bodies.get('en1').rel === 'enemy' && chutes.bodies.get('me').rel === 'own', 'canopies take team-relative colours');
  check(chutes.bodies.get('en1').root.position.x === 11, 'remote canopies ride the presented avatar');
  const own = chutes.bodies.get('me'), fp = PARACHUTE_FX.firstPerson;
  check(own.firstPerson && own.canopy.position.y === fp.lift && own.canopy.position.z === fp.back
    && !chutes.bodies.get('en1').firstPerson && chutes.bodies.get('en1').canopy.position.y === 0,
    'the own canopy sits higher and behind the eye; other bodies carry it overhead');
  // From the eye (1.6 m) a level view never meets the own canopy: its lowest front rim is far above the frame top.
  const span = PARACHUTE_FX.arcDegrees * Math.PI / 360, rimY = PARACHUTE_FX.apex - PARACHUTE_FX.arcRadius * (1 - Math.cos(span)) + fp.lift;
  const rimZ = -PARACHUTE_FX.depth / 2 + fp.back;
  check(rimZ > 0 || Math.atan2(rimY - 1.6, -rimZ) > 50 * Math.PI / 180, 'a level first-person view keeps the canopy out of the frame');
  check(chutes.bodies.get('tm1').seat.visible && !chutes.bodies.get('tm1').canopy.visible && emitters.size === 2, 'the seat rides on a rocket plume');
  for (let i = 0; i < 60; i++) chutes.sync(rows, { selfId: 'me', selfTeam: 'alpha', local, dt: 1 / 60 });
  check(emitters.size === 0, `the plume burns out after ${EJECTION.rocketSeconds} s`);
  rows[2] = { ...rows[2], cq: [0, 1, 0, 0, 0, 0, 0, CHUTE.open] };
  chutes.sync(rows, { selfId: 'me', selfTeam: 'alpha', local, dt: 0.016 });
  check(chutes.bodies.get('tm1').canopy.visible && chutes.debris.length === 1, 'the pilot separates: canopy opens, the seat falls away');
  check(chutes.eject({ kind: 'ejection', id: 'me', pos: [0, 50, 0], vel: [0, 26, -30], yaw: 0 }, 'me') && shake > 0 && chutes.debris.length === 2,
    'the ejection throws the canopy glass and shakes the pilot camera');
  chutes.sync([], { selfId: 'me', dt: 0.016 });
  check(chutes.count === 0, 'bodies without a canopy row are dropped');
  chutes.dispose();
  // VehicleFx owns one and routes the ejection event to it.
  const vfx = new VehicleFx({ fx, vehicleView: { items: new Map(), item: () => null }, scene: new THREE.Group() });
  check(vfx.handleEvent({ kind: 'ejection', id: 'x', pos: [0, 40, 0], vel: [0, 20, 0], yaw: 0 }, 'me') === true && vfx.stats.ejection === 1,
    'VehicleFx handles the ejection event');
  vfx.dispose();
}

console.log(`conquest-airborne-ui-test: ${checks} checks passed`);
