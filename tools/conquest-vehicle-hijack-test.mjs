// Hijacking: an empty enemy hull can be boarded and changes team; a crewed one
// cannot; titans never. The pad keeps its home team, clients get the prompt,
// the boardable filter and a banner.
import assert from 'node:assert/strict';
import { GameEngine } from '../server/game.js';
import { VEHICLE_TYPE_IDS } from '../shared/conquest-contract.js';
import { vehicleBoardable, vehicleHijackable } from '../shared/vehicle-seats.js';
import { hijackBanner, interactModel } from '../public/js/ui/conquest-hud-state.js';

function fixture(type = 'jeep') {
  const frames = [], dimensions = { sx: 512, sy: 64, sz: 512 };
  const world = { dimensions, getBlock: (_x, y) => y === 0 ? 3 : 0, findSpawns: () => [{ x: 400, y: 1, z: 400 }], setBlock() {} };
  const game = new GameEngine({ mode: 'conquest', world, mapMeta: { id: 'frontier', dimensions,
    spawns: { conquest: { alpha: [{ x: 400, y: 1, z: 400 }], bravo: [{ x: 440, y: 1, z: 400 }] } },
    conquest: { flags: [], bases: {}, vehicleSpawns: [{ id: 'v', type, team: 'alpha', x: 200, y: 1, z: 200, yaw: 0 }] } },
  broadcast: frame => frames.push(frame) });
  for (const id of ['owner', 'mate', 'thief', 'thief2']) game.addClient(id, id);
  const [owner, mate, thief, thief2] = ['owner', 'mate', 'thief', 'thief2'].map(id => game.entities.get(id));
  game.mode.policy.setLobbyTeam(owner, 'alpha'); game.mode.policy.setLobbyTeam(mate, 'alpha');
  game.mode.policy.setLobbyTeam(thief, 'bravo'); game.mode.policy.setLobbyTeam(thief2, 'bravo');
  for (const p of [owner, mate, thief, thief2]) Object.assign(p, { x: 400, y: 1, z: 400, hp: 100, armor: 0, spawnProtectedUntil: 0, input: { keys: {}, yaw: 0, pitch: 0 } });
  const v = game.vehicles.vehicles.get('v');
  const near = p => Object.assign(p, { x: v.x, y: v.y, z: v.z });
  const events = () => game.tickEvents ?? [];
  return { game, v, owner, mate, thief, thief2, near, events };
}

for (const type of VEHICLE_TYPE_IDS) {
  const f = fixture(type);
  // A crewed enemy hull cannot be boarded.
  f.near(f.owner);
  assert.equal(f.game.vehicles.enter(f.owner, 'v'), true);
  f.near(f.thief);
  assert.equal(f.game.vehicles.enter(f.thief, 'v'), false, `${type}: a crewed enemy hull is refused`);
  assert.equal(f.v.team, 'alpha');
  // Once empty it is hijacked: the thief takes the first seat and the hull changes team.
  assert.equal(f.game.vehicles.exit(f.owner), true);
  Object.assign(f.owner, { x: 400, z: 400 });
  f.v.spotted = { bravo: Infinity };
  f.game.tickEvents = [];
  assert.equal(f.game.vehicles.enter(f.thief, 'v'), true, `${type}: an empty enemy hull is hijacked`);
  assert.equal(f.v.team, 'bravo');
  assert.equal(f.thief.vehicleId, 'v');
  assert.equal(f.thief.vehicleSeatId, 'driver');
  assert.deepEqual(f.v.spotted, {}, 'old spots lapse');
  const ev = f.events().find(e => e.kind === 'vehicle_hijacked');
  assert.deepEqual(ev && { ...ev }, { t: 'ev', kind: 'vehicle_hijacked', vehicleId: 'v', type, by: 'thief', from: 'alpha', to: 'bravo' });
  // The thief's teammate joins; the old owners now see an enemy hull.
  if (f.v.seatOccupants && Object.keys(f.v.seatOccupants).length > 1) {
    f.near(f.thief2);
    assert.equal(f.game.vehicles.enter(f.thief2, 'v'), true, `${type}: teammates of the hijacker board normally`);
  }
  f.near(f.mate);
  assert.equal(f.game.vehicles.enter(f.mate, 'v'), false, `${type}: the old team cannot board a crewed hijacked hull`);
  // The pad still belongs to the hull's home team: a wreck respawns for alpha at its own pad.
  assert.equal(f.game.vehicles.padTeam(f.v), 'alpha', `${type}: the HQ pad keeps its home team`);
}

// Titan hulls are never hijackable; teamless hulls are boardable by anyone.
assert.equal(vehicleHijackable({ type: 'titan_ion', team: 'alpha', seatOccupants: {} }, 'bravo'), false);
assert.equal(vehicleHijackable({ type: 'tank', team: 'alpha', seatOccupants: { driver: null, commander: null } }, 'bravo'), true);
assert.equal(vehicleHijackable({ type: 'tank', team: 'alpha', seatOccupants: { driver: 'x', commander: null } }, 'bravo'), false);
assert.equal(vehicleHijackable({ type: 'tank', team: 'alpha', seatOccupants: {} }, 'alpha'), false, 'own hulls are not hijacked');
assert.equal(vehicleBoardable({ type: 'jeep', team: null }, 'bravo'), true);
assert.equal(vehicleBoardable({ type: 'jeep', team: 'alpha', seatOccupants: { gunner: 'x' } }, 'bravo'), false);

// HUD: the prompt says HIJACK for an empty enemy hull and nothing for a crewed one.
{
  const self = { id: 'me', team: 'bravo', hp: 100, x: 0, y: 0, z: 0, cq: [0, 0, 0, 0, 0, 0, 0] };
  const empty = { id: 'h', type: 'tank', team: 'alpha', hp: 1000, x: 1, y: 0, z: 0, seatOccupants: { driver: null, commander: null } };
  const prompt = interactModel({ self, players: [self], vehicles: [empty], nearbyVehicle: empty });
  assert.equal(prompt?.type, 'enter');
  assert.equal(prompt.hijack, true);
  assert.match(prompt.label, /^HIJACK TANK · F1 DRIVER/);
  const crewed = { ...empty, seatOccupants: { driver: 'x', commander: null } };
  assert.equal(interactModel({ self, players: [self], vehicles: [crewed], nearbyVehicle: crewed }), null);
  const own = { ...empty, team: 'bravo' };
  assert.match(interactModel({ self, players: [self], vehicles: [own], nearbyVehicle: own }).label, /^ENTER TANK/);
}
{
  const ev = { kind: 'vehicle_hijacked', vehicleId: 'h', type: 'helicopter', by: 'me', from: 'alpha', to: 'bravo' };
  assert.equal(hijackBanner(ev, 'bravo', 'me').title, 'ATTACK HELI HIJACKED');
  assert.equal(hijackBanner(ev, 'bravo', 'mate').tone, 'own');
  assert.equal(hijackBanner(ev, 'alpha', 'x').tone, 'enemy');
}
console.log('conquest vehicle hijack test passed');
