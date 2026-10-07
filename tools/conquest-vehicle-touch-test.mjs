// Conquest touch controls (WP7): per-seat button sets (drive, fly, fire, seat
// cycle, countermeasure, map, spot), Conquest button routing through the HUD
// to the vehicle controller, the seat-change release and the seated HUD flag.
import assert from 'node:assert/strict';
import { installFakeDom } from './lib/conquest-ui-dom.mjs';
import { COUNTERMEASURES, VEHICLE_TOPOLOGY, seatWeaponList } from '../shared/conquest-contract.js';

const dom = installFakeDom({ width: 844, height: 390 });
const { document } = dom;
const { TouchControls, visibleTouchActions, TOUCH_ACTIONS, CONQUEST_TOUCH_ACTIONS, CONQUEST_TOUCH_EVENT } = await import('../public/js/engine/touch-controls.js');
const { ConquestHud } = await import('../public/js/ui/conquest-hud.js');
const state = await import('../public/js/ui/conquest-hud-state.js');
const { cameraPose } = await import('../public/js/ui/conquest/projection.js');
const { conquestHudFixtures, fixtureMapMeta, FIXTURE_NOW } = await import('../public/js/capture/conquest-hud-fixtures.js');

const fixtures = conquestHudFixtures();
const mapMeta = fixtureMapMeta();
const fixture = id => fixtures.find(f => f.id === id);
const infantry = { alive: true, canFire: true, canReload: true, canBuy: false, canMedkit: true, canBuild: false, canThrow: true, grenadeTotal: 3, weaponCount: 3 };

/** The touch context the integrator builds for a seat, plus the HUD's Conquest fields. */
function seatContext(type, seatId, { cmr = 100 } = {}) {
  const seat = VEHICLE_TOPOLOGY[type].find(s => s.id === seatId);
  const row = { id: `alpha-${type}`, type, team: 'alpha', hp: 100, cmr, seatOccupants: { [seatId]: 'me' } };
  return {
    ...infantry, vehicleSeated: true, vehicleType: type, vehicleId: row.id, vehicleSeatId: seatId, vehicleRole: seat.role,
    vehicleCanDrive: seat.drives, vehicleCanFire: seatWeaponList(type, seatId).length > 0,
    ...state.conquestTouchFields({ active: true, seated: { row, seat } }),
  };
}
const actions = ctx => [...visibleTouchActions(ctx)].sort();

/* ------------------------------------------------------- per-seat sets */

{
  assert.equal(new Set(TOUCH_ACTIONS).size, TOUCH_ACTIONS.length);
  assert.ok(TOUCH_ACTIONS.length <= 31, 'visibility mask fits a 32-bit int');
  for (const action of CONQUEST_TOUCH_ACTIONS) assert.ok(TOUCH_ACTIONS.includes(action));

  const expected = {
    'tank:driver': ['bigMap', 'countermeasure', 'fire', 'jump', 'spot', 'vehicleSeat'],
    'tank:commander': ['bigMap', 'fire', 'spot', 'vehicleSeat'],
    'helicopter:driver': ['bigMap', 'countermeasure', 'fire', 'flightBrake', 'flightDown', 'flightUp', 'spot', 'vehicleSeat'],
    'helicopter:gunner': ['bigMap', 'fire', 'spot', 'vehicleSeat'],
    'transport:driver': ['bigMap', 'countermeasure', 'flightBrake', 'flightDown', 'flightUp', 'spot', 'vehicleSeat'],
    'transport:door-left': ['bigMap', 'fire', 'spot', 'vehicleSeat'],
    'transport:rear-right': ['bigMap', 'spot', 'vehicleSeat'],
    'plane:driver': ['bigMap', 'countermeasure', 'fire', 'flightBrake', 'flightDown', 'flightUp', 'spot'],
    'jeep:driver': ['bigMap', 'jump', 'spot', 'vehicleSeat'],
    'jeep:gunner': ['bigMap', 'fire', 'spot', 'vehicleSeat'],
  };
  for (const [key, list] of Object.entries(expected)) {
    const [type, seatId] = key.split(':');
    assert.deepEqual(actions(seatContext(type, seatId)), list, key);
  }
  // Countermeasures belong to types that carry one (COUNTERMEASURES) and to the driving seat.
  for (const [type, cm] of Object.entries(COUNTERMEASURES)) {
    assert.equal(seatContext(type, 'driver').vehicleCountermeasure, cm, `${type} countermeasure kind`);
  }
  assert.equal(seatContext('tank', 'driver', { cmr: 40 }).vehicleCountermeasureReady, false);
  // On foot in Conquest: infantry set plus MAP and SPOT; elsewhere no Conquest buttons.
  assert.deepEqual(actions({ ...infantry, conquest: true }).filter(a => CONQUEST_TOUCH_ACTIONS.includes(a)), ['bigMap', 'spot']);
  assert.deepEqual(actions(infantry).filter(a => CONQUEST_TOUCH_ACTIONS.includes(a)), []);
  assert.equal(visibleTouchActions({ ...seatContext('tank', 'driver'), alive: false }).size, 0, 'dead: nothing but pause');
  assert.deepEqual(actions({ alive: false, deployOpen: true }), ['deploy']);
}

/* --------------------------------------------- DOM: labels and release */

{
  const moves = [], holds = [];
  const touch = new TouchControls({ documentRef: document, onMove: v => moves.push(v), onHold: (a, h) => holds.push([a, h]) });
  touch.mount(document.body);
  touch.setEnabled(true);
  touch.setContext(seatContext('tank', 'driver', { cmr: 40 }));
  assert.equal(touch.dom.jump.textContent, 'BRAKE'); assert.equal(touch.dom.jump.getAttribute('aria-label'), 'Brake vehicle');
  assert.equal(touch.dom.countermeasure.textContent, 'SMOKE'); assert.equal(touch.dom.countermeasure.dataset.ready, 'false');
  assert.equal(touch.root.dataset.vehicleType, 'tank');
  for (const action of ['vehicleSeat', 'countermeasure', 'bigMap', 'spot']) assert.equal(touch.dom[action].classList.contains('is-hidden'), false, `${action} shown`);
  assert.equal(touch.dom.deploy.classList.contains('is-hidden'), true);
  // Gunners cannot drive: the stick hides and releases.
  touch.setContext(seatContext('tank', 'commander'));
  assert.equal(touch.dom.move.hidden, true);
  assert.deepEqual(moves.at(-1), { x: 0, y: 0, magnitude: 0 }, 'changing seat recentres the stick');
  touch.setContext(seatContext('helicopter', 'driver'));
  assert.equal(touch.dom.countermeasure.textContent, 'FLARES'); assert.equal(touch.root.classList.contains('is-aircraft'), true);
  assert.equal(touch.dom.flightUp.getAttribute('aria-label'), 'Climb helicopter');
  touch.setContext(seatContext('plane', 'driver'));
  assert.equal(touch.dom.flightUp.getAttribute('aria-label'), 'Pitch aircraft up');
  touch.setContext({ ...infantry, conquest: true });
  assert.equal(touch.dom.jump.textContent, 'JUMP'); assert.equal(touch.dom.move.hidden, false);
  assert.equal(touch.root.classList.contains('is-aircraft'), false);
  touch.dispose();
}

/* ------------------------ Conquest buttons -> HUD -> vehicle controller */

{
  const calls = [];
  const controller = {
    requestSeat: index => { calls.push(['seat', index]); return true; },
    queueCountermeasure: () => { calls.push(['cm']); return true; },
    interactHeldMs: () => 0,
  };
  const spots = [];
  const hud = new ConquestHud(document.body, { onSpot: () => spots.push(1), eventTarget: dom.window });
  const f = fixture('transport-door');
  const args = { match: f.match, mapMeta, self: f.self, players: f.players, vehicles: f.vehicles, nowMs: FIXTURE_NOW,
    camera: cameraPose({ ...f.camera, aspect: 844 / 390 }), viewport: { width: 844, height: 390 }, vehicleController: controller };
  hud.update(args);
  assert.equal(document.body.dataset.vehicleSeated, 'true');
  const fields = hud.touchContextFields();
  assert.deepEqual(fields, { ...state.CONQUEST_TOUCH_DEFAULTS, conquest: true, deployOpen: false, vehicleSeatCount: 5, vehicleCountermeasure: null, vehicleCountermeasureReady: false });
  assert.deepEqual(state.conquestTouchFields({ active: false }), state.CONQUEST_TOUCH_DEFAULTS, 'outside Conquest every key resets');

  const touch = new TouchControls({ documentRef: document });
  touch.mount(document.body); touch.setEnabled(true);
  touch.setContext({ ...infantry, vehicleSeated: true, vehicleType: 'transport', vehicleSeatId: 'door-left', vehicleRole: 'gunner', vehicleCanDrive: false, vehicleCanFire: true, ...fields });
  const press = (action, id) => {
    touch.dom[action].dispatchEvent({ type: 'pointerdown', pointerId: id });
    touch.dom[action].dispatchEvent({ type: 'pointerup', pointerId: id });
  };
  press('vehicleSeat', 1);
  assert.deepEqual(calls, [['seat', 2]], 'SEAT asks for the next free seat (door-right, F3)');
  press('spot', 2);
  assert.equal(spots.length, 1);
  press('bigMap', 3);
  assert.equal(hud.bigMap.open, true, 'MAP opens the full map');
  press('bigMap', 4);
  assert.equal(hud.bigMap.open, false);
  // Hidden buttons never fire (countermeasure belongs to the pilot).
  press('countermeasure', 5);
  assert.deepEqual(calls, [['seat', 2]]);

  // As pilot of the attack helicopter the countermeasure reaches the controller.
  const pilot = fixture('heli-pilot');
  hud.update({ ...args, match: pilot.match, self: pilot.self, players: pilot.players, vehicles: pilot.vehicles });
  const pilotFields = hud.touchContextFields();
  assert.equal(pilotFields.vehicleCountermeasure, 'flares'); assert.equal(pilotFields.vehicleCountermeasureReady, true);
  touch.setContext({ ...infantry, vehicleSeated: true, vehicleType: 'helicopter', vehicleSeatId: 'driver', vehicleRole: 'pilot', vehicleCanDrive: true, vehicleCanFire: true, ...pilotFields });
  press('countermeasure', 6);
  assert.deepEqual(calls.at(-1), ['cm']);
  const sent = calls.length;
  press('vehicleSeat', 7);
  assert.equal(calls.length, sent, 'the gunner seat is taken: no seat request');
  assert.equal(state.nextFreeSeatIndex({ type: 'helicopter', seatOccupants: { driver: 'me', gunner: null } }, 'driver'), 1);

  hud.dispose();
  assert.equal(document.body.dataset.vehicleSeated, undefined, 'dispose clears the seated flag');
  assert.equal(dom.window.listenerCount(CONQUEST_TOUCH_EVENT), 0);
  touch.dispose();
}

dom.restore();
console.log('Conquest vehicle touch: per-seat buttons, seat cycle, countermeasure, map and spot routing, seat-change release passed');
