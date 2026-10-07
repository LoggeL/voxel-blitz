// Conquest HUD (WP7): the pure read model over the authoritative snapshot and
// events, then every fixture state rendered through the real ConquestHud,
// kill feed, scoreboard and result overlay on a fake DOM (no browser).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installFakeDom, isShown, textsDrawn } from './lib/conquest-ui-dom.mjs';
import {
  CONQUEST_RULES, SCORE_LABELS, TEAM_DISPLAY, VEHICLE_TOPOLOGY, VEHICLE_WEAPON_META,
} from '../shared/conquest-contract.js';

const dom = installFakeDom({ width: 1440, height: 900 });
const { document } = dom;

const state = await import('../public/js/ui/conquest-hud-state.js');
const { ConquestHud } = await import('../public/js/ui/conquest-hud.js');
const { cameraPose, createProjector, clampToEdge, leadPoint, ballisticPoint } = await import('../public/js/ui/conquest/projection.js');
const { supportPump, SUPPORT_INTERVAL_MS } = await import('../public/js/ui/conquest/interact.js');
const { stackTicker, TICKER_HOLD_MS } = await import('../public/js/ui/conquest/score-ticker.js');
const { scheduleBanner, tickBanners, BANNER_MS } = await import('../public/js/ui/conquest/banners.js');
const { zonePaths } = await import('../public/js/ui/conquest/vehicle-panel.js');
const { declutter } = await import('../public/js/ui/conquest/big-map.js');
const { KILL_KEY_ICONS, ICON_PATHS } = await import('../public/js/ui/conquest/icons.js');
const { conquestHudFixtures, fixtureMapMeta, FIXTURE_NOW } = await import('../public/js/capture/conquest-hud-fixtures.js');
const { WEAPON_NAMES, VEHICLE_KILL_KEYS, isVehicleKillKey } = await import('../public/js/ui/hud-support.js');
const { CombatHudController } = await import('../public/js/ui/combat-hud.js');
const { Scoreboard, groupBySquad, squadName } = await import('../public/js/ui/scoreboard.js');
const { MatchResultOverlay } = await import('../public/js/ui/match-result-overlay.js');
const { KEYBINDING_ACTIONS, defaultKeybindings, normalizeKeybindings, bindingLabel } = await import('../public/js/keybindings.js');

const fixtures = conquestHudFixtures();
const mapMeta = fixtureMapMeta();
const byId = id => fixtures.find(f => f.id === id) ?? assert.fail(`fixture ${id}`);
const VIEW = { width: 1440, height: 900 };
const projectorFor = f => createProjector(cameraPose({ ...f.camera, aspect: VIEW.width / VIEW.height }), VIEW.width, VIEW.height);
const cqOf = f => state.readConquest(f.match, mapMeta);
let checks = 0;
const ok = () => { checks++; };

/* ------------------------------------------------------------ fixtures */

const REQUIRED = ['capturing', 'neutralizing', 'contested', 'defending', 'restoring', 'east-relative', 'out-of-bounds', 'revive',
  'tank-driver', 'tank-commander', 'heli-pilot', 'heli-gunner', 'transport-door', 'jet', 'enter-jeep', 'big-map', 'deploy',
  'deploy-refused', 'scoreboard', 'result'];
assert.deepEqual(fixtures.map(f => f.id), REQUIRED, 'every acceptance state has a fixture, in capture order'); ok();
for (const f of fixtures) {
  assert.equal(f.match.mode, 'conquest');
  assert.equal(f.match.conquest.flags.length, 5, `${f.id}: all 5 flags are on the wire`);
  assert.ok(f.players.some(p => p.id === 'me'), `${f.id}: self row present`);
}
ok();

/* ---------------------------------------------------------- tickets/top */

{
  assert.equal(state.relativeTeam('alpha', 'alpha'), 'own');
  assert.equal(state.relativeTeam('alpha', 'bravo'), 'enemy');
  assert.equal(state.relativeTeam(null, 'bravo'), 'neutral');
  assert.equal(state.teamDisplayName('alpha'), 'WEST');
  assert.equal(state.teamDisplayName('bravo'), 'EAST');
  assert.equal(state.bleedLabel(3000), '▼ 1/3s');
  assert.equal(state.bleedLabel(1500), '▼ 1/1.5s');
  assert.equal(state.bleedLabel(0), '');
  assert.equal(state.clockText(14 * 60_000 + 32_000), '14:32');

  // Bleed both ways: the enemy bleeds while we hold 3; we bleed while they hold 4.
  const enemyBleeds = state.ticketModel(cqOf(byId('capturing')), 'alpha', FIXTURE_NOW);
  assert.equal(enemyBleeds.own.name, 'WEST'); assert.equal(enemyBleeds.own.bleeding, false);
  assert.equal(enemyBleeds.enemy.name, 'EAST'); assert.equal(enemyBleeds.enemy.bleed, '▼ 1/3s');
  assert.equal(enemyBleeds.clock, '14:32');
  const ownBleeds = state.ticketModel(cqOf(byId('restoring')), 'alpha', FIXTURE_NOW);
  assert.equal(ownBleeds.own.bleed, '▼ 1/1s'); assert.equal(ownBleeds.enemy.bleeding, false);
  assert.equal(ownBleeds.own.tickets, 61); assert.equal(ownBleeds.own.low, true, '61/300 is under the 25 % ticket-low line');
  assert.ok(Math.abs(ownBleeds.own.fraction - 61 / 300) < 1e-9);

  // Team-relative: playing EAST puts EAST on the own (blue) side.
  const east = state.ticketModel(cqOf(byId('east-relative')), 'bravo', FIXTURE_NOW);
  assert.equal(east.own.team, 'bravo'); assert.equal(east.own.name, 'EAST'); assert.equal(east.own.tickets, 233);
  assert.equal(east.enemy.name, 'WEST');
  const eastChips = state.flagChipModels(cqOf(byId('east-relative')), 'bravo');
  assert.deepEqual(eastChips.map(c => c.owner), ['enemy', 'enemy', 'neutral', 'own', 'own']);
  assert.equal(eastChips[2].lean, 'own', 'negative control leans toward bravo = own for an EAST player');
  ok();

  const chips = state.flagChipModels(cqOf(byId('contested')), 'alpha');
  assert.deepEqual(chips.map(c => c.id), ['A', 'B', 'C', 'D', 'E']);
  assert.equal(chips[2].contested, true); assert.equal(chips[2].fill, 0.22);
  assert.equal(chips[1].state, 'restoring'); assert.equal(chips[1].moving, 'own');
  ok();
}

/* --------------------------------------------------------- capture ring */

{
  const ring = id => { const f = byId(id); return state.captureRingModel(cqOf(f), f.self, f.selfTeam); };
  const expect = {
    capturing: ['CAPTURING', '3 vs 1', 'own'], neutralizing: ['NEUTRALIZING', '2 vs 0', 'own'], contested: ['CONTESTED', '2 vs 2', 'contested'],
    defending: ['DEFENDING', '1 vs 0', 'own'], restoring: ['RESTORING', '1 vs 0', 'own'],
  };
  for (const [id, [label, counts, tone]] of Object.entries(expect)) {
    const model = ring(id);
    assert.equal(model?.label, label, `${id} ring label`);
    assert.equal(model.counts, counts, `${id} atk vs def`);
    assert.equal(model.tone, tone, `${id} tone`);
  }
  assert.equal(ring('capturing').flagId, 'C');
  assert.equal(ring('out-of-bounds'), null, 'no ring outside every zone');
  // Enemy majority on an own flag reads LOSING; on a neutral one OUTNUMBERED.
  const cq = cqOf(byId('defending'));
  const losing = { ...cq, flags: cq.flags.map(f => f.id === 'A' ? { ...f, state: 'neutralizing', alpha: 1, bravo: 3 } : f) };
  assert.equal(state.captureRingModel(losing, byId('defending').self, 'alpha').label, 'LOSING');
  // Dead players and players above the zone (|dy| > presenceDy) get no ring.
  assert.equal(state.captureRingModel(cqOf(byId('capturing')), { ...byId('capturing').self, hp: 0, state: 'dead' }, 'alpha'), null);
  assert.equal(state.captureRingModel(cqOf(byId('capturing')), { ...byId('capturing').self, y: 26 + CONQUEST_RULES.presenceDy + 1 }, 'alpha'), null);
  ok();
}

/* ------------------------------------------------- restricted / revive */

{
  const oob = byId('out-of-bounds');
  const model = state.restrictedModel(oob.self, cqOf(oob));
  assert.equal(model.seconds, 7); assert.equal(model.ms, 6400); assert.equal(model.title, 'OUT OF BOUNDS');
  const hq = FRONTIER_HQ_BRAVO();
  const inHq = state.restrictedModel({ ...oob.self, x: hq.x, z: hq.z }, cqOf(oob));
  assert.equal(inHq.title, 'ENEMY HQ · RESTRICTED');
  assert.equal(state.restrictedModel({ ...oob.self, cq: [0, 1, 0, 0, 0, 0, 0] }), null, 'cq[4] = 0: no countdown');

  const revive = byId('revive');
  const prompt = state.interactModel({ self: revive.self, players: revive.players, vehicles: revive.vehicles });
  assert.equal(prompt.type, 'revive'); assert.equal(prompt.targetId, 'dn1'); assert.equal(prompt.progress, 0.6); assert.equal(prompt.hold, true);
  assert.equal(prompt.label, 'REVIVE MERCER');
  // A non-assault kit gets no revive prompt; an engineer near a damaged own hull gets repair.
  const engineer = { ...revive.self, cq: [1, 1, 0, 0, 0, 0, 25] };
  assert.equal(state.interactModel({ self: engineer, players: revive.players, vehicles: [] }), null);
  const hull = { id: 'alpha-jeep', type: 'jeep', team: 'alpha', hp: 160, x: engineer.x + 2, y: engineer.y, z: engineer.z };
  const repair = state.interactModel({ self: engineer, players: revive.players, vehicles: [hull] });
  assert.equal(repair.type, 'repair'); assert.equal(repair.targetId, 'alpha-jeep'); assert.equal(repair.label, 'REPAIR JEEP 50%');
  assert.equal(repair.progress, 0.25);
  assert.equal(state.interactModel({ self: engineer, vehicles: [{ ...hull, team: 'bravo' }] }), null, 'enemy hulls are never repaired');
  assert.equal(state.interactModel({ self: engineer, vehicles: [{ ...hull, hp: 320 }] }), null, 'a full hull needs no repair');

  // Hold pump: nothing before repairHoldStartMs, then {type, targetId} at 5 Hz, retarget immediately.
  let pump = { lastAt: -Infinity, targetId: null, active: false };
  let step = supportPump(pump, { model: prompt, heldMs: CONQUEST_RULES.repairHoldStartMs - 1, nowMs: 1000 });
  assert.equal(step.send, null);
  step = supportPump(step.state, { model: prompt, heldMs: CONQUEST_RULES.repairHoldStartMs, nowMs: 1000 });
  assert.deepEqual(step.send, { type: 'revive', targetId: 'dn1' });
  const sends = [];
  for (let t = 1000; t <= 2000; t += 16) {
    step = supportPump(step.state, { model: prompt, heldMs: 400 + t, nowMs: t });
    if (step.send) sends.push(t);
  }
  assert.ok(sends.length >= 4 && sends.length <= 5, `≈5 Hz while held (${sends.length} in 1 s)`);
  assert.ok(SUPPORT_INTERVAL_MS < CONQUEST_RULES.supportIntentStaleMs, 'resend interval beats the server staleness window');
  step = supportPump(step.state, { model: { ...prompt, targetId: 'dn2' }, heldMs: 2000, nowMs: 2001 });
  assert.deepEqual(step.send, { type: 'revive', targetId: 'dn2' });
  assert.equal(supportPump(step.state, { model: { type: 'enter', targetId: 'x' }, heldMs: 5000, nowMs: 3000 }).send, null, 'enter never pumps');
  ok();
}

function FRONTIER_HQ_BRAVO() { return mapMeta.conquest.bases.bravo; }

/* ------------------------------------------------------ vehicle panels */

const seatedOf = f => state.seatedVehicle(f.self, f.vehicles);
const panelOf = f => state.vehiclePanelModel(seatedOf(f), { selfId: 'me', players: f.players, selfTeam: f.selfTeam, yaw: seatedOf(f)?.row.yaw });
{
  const tank = panelOf(byId('tank-driver'));
  assert.equal(tank.name, 'TANK'); assert.equal(tank.seatId, 'driver'); assert.equal(tank.drives, true);
  assert.deepEqual(tank.seats.map(s => s.text), ['F1 DRIVER (you)', 'F2 COMMANDER']);
  assert.deepEqual(tank.weapons.map(w => w.label), ['120MM AP', '120MM HE', 'COAX 7.62']);
  assert.equal(tank.weapons[0].selected, true); assert.equal(tank.weapons[0].reload, 0.4); assert.equal(tank.weapons[0].ready, false);
  assert.equal(tank.weapons[0].ammo, 4, 'ammo from mounts[i][2]');
  assert.equal(tank.weapons[2].heat, 0.22);
  assert.deepEqual(tank.badges.map(b => b.label), ['DISABLED', 'BURNING']);
  assert.equal(tank.cm.kind, 'smoke'); assert.equal(tank.cm.available, false); assert.equal(tank.cm.ready, 0.46);
  assert.equal(tank.hpText, '230 / 1000'); assert.equal(tank.lock, null);

  const commander = panelOf(byId('tank-commander'));
  assert.equal(commander.seatId, 'commander'); assert.deepEqual(commander.weapons.map(w => w.label), ['.50 HMG']);
  assert.equal(commander.weapons[0].heat, 0.81); assert.equal(commander.cm, null, 'countermeasures belong to the driving seat');
  assert.deepEqual(commander.seats.map(s => s.you), [false, true]);

  const pilot = panelOf(byId('heli-pilot'));
  assert.equal(pilot.weapons[0].label, 'ROCKET POD'); assert.equal(pilot.weapons[0].ammo, 9);
  assert.equal(pilot.lock.state, 1); assert.equal(pilot.lock.label, 'LOCKING');
  assert.equal(pilot.lock.sourceId, 'en1'); assert.ok(Number.isFinite(pilot.lock.bearing), 'bearing toward the locking enemy');
  assert.equal(pilot.cm.kind, 'flares'); assert.equal(pilot.cm.available, true); assert.equal(pilot.aircraft, true);

  const gunner = panelOf(byId('heli-gunner'));
  assert.equal(gunner.seatId, 'gunner'); assert.equal(gunner.weapons[0].label, '25MM CHIN'); assert.equal(gunner.lock.label, 'LOCKED');

  const door = panelOf(byId('transport-door'));
  assert.equal(door.seatId, 'door-left'); assert.equal(door.lock.state, 3); assert.equal(door.lock.label, 'MISSILE INBOUND');
  assert.deepEqual(door.badges.map(b => b.key), ['burning']);
  assert.equal(door.seats.length, VEHICLE_TOPOLOGY.transport.length);

  const jet = panelOf(byId('jet'));
  assert.deepEqual(jet.weapons.map(w => [w.label, w.selected]), [['20MM CANNON', false], ['AA MISSILE', true]]);
  assert.equal(jet.altitude, 140); assert.equal(jet.speedKmh, Math.round(92 * 3.6));

  // Seat strip marks bots; zone flashes map hit zones onto the silhouette.
  const botRow = { ...seatedOf(byId('tank-driver')).row };
  const strip = state.seatStrip(botRow, 'me', [{ id: 'sq2', name: 'Bot', bot: true }]);
  assert.equal(strip[1].text, 'F2 COMMANDER [bot]');
  assert.deepEqual(zonePaths('side'), ['left', 'right']); assert.deepEqual(zonePaths('rear'), ['rear']);
  assert.deepEqual(state.nextFreeSeatIndex(seatedOf(byId('transport-door')).row, 'door-left'), 2, 'seat cycle skips taken seats');
  assert.equal(state.nextFreeSeatIndex(seatedOf(byId('jet')).row, 'driver'), -1);
  ok();
}

/* ------------------------------------------------------------- reticles */

{
  const reticle = id => { const f = byId(id); return state.reticleModel(seatedOf(f), { projector: projectorFor(f), players: f.players, vehicles: f.vehicles, selfTeam: f.selfTeam }); };
  const tank = reticle('tank-driver');
  assert.equal(tank.kind, 'tank'); assert.equal(tank.ready, false); assert.equal(tank.reload, 0.4);
  assert.ok(tank.impact && Number.isFinite(tank.impact.x), 'barrel impact projected from the mount pose');
  assert.equal(reticle('tank-commander').kind, 'mg');
  const pods = reticle('heli-pilot');
  assert.equal(pods.kind, 'pods'); assert.equal(pods.convergence, 120); assert.ok(pods.pip, 'pod pip at convergence');
  const gimbal = reticle('heli-gunner');
  assert.equal(gimbal.kind, 'gimbal'); assert.ok(Math.abs(gimbal.yaw - -0.9) < 1e-6); assert.equal(gimbal.yawLimit, 1.9);
  const door = reticle('transport-door');
  assert.equal(door.kind, 'door'); assert.equal(door.side, 'left'); assert.equal(door.atLimit, true, '1.35 rad past the door axis is at the 1.4 rad limit');
  const jet = reticle('jet');
  assert.equal(jet.kind, 'jet'); assert.ok(jet.pipper, 'lead pipper on the enemy helicopter'); assert.ok(jet.target);
  assert.ok(jet.pipper.tof > 0, 'missile flight time from VEHICLE_WEAPON_META.speed');
  assert.equal(jet.altitude, 140);
  assert.equal(state.reticleModel(null, { projector: projectorFor(byId('jet')) }), null);

  // Lead pipper math: a crossing target is led by velocity × time of flight.
  const lead = leadPoint([0, 0, 0], [0, 0, -300], [20, 0, 0], VEHICLE_WEAPON_META.aaMissile.speed);
  assert.ok(lead.tof > 1.9 && lead.tof < 2.1); assert.ok(Math.abs(lead.point[0] - 20 * lead.tof) < 1e-6);
  assert.deepEqual(leadPoint([0, 0, 0], [5, 0, 0], [9, 0, 0], 0).point, [5, 0, 0], 'hitscan aims at the target');
  const drop = ballisticPoint([0, 10, 0], [0, 0, -1], 170, 6, 170);
  assert.ok(Math.abs(drop[1] - (10 - 3)) < 1e-9, 'tank shell drops g·t²/2 after 1 s');

  const jetFix = byId('jet');
  const jetSeat = state.seatedVehicle(jetFix.self, jetFix.vehicles);
  const locker = state.lockerModel(jetFix.self, { projector: projectorFor(jetFix), vehicles: jetFix.vehicles, selfTeam: 'alpha',
    camera: jetFix.camera, seated: jetSeat });
  assert.equal(locker.label, 'LOCKING 70%'); assert.equal(locker.targetId, 'bravo-helicopter', 'inside the AA missile lock cone and range');
  const target = jetFix.vehicles.find(v => v.id === 'bravo-helicopter');
  const range = Math.hypot(target.x - jetFix.camera.x, target.y - jetFix.camera.y, target.z - jetFix.camera.z);
  const onFoot = state.lockerModel(jetFix.self, { projector: projectorFor(jetFix), vehicles: jetFix.vehicles, selfTeam: 'alpha', camera: jetFix.camera });
  assert.equal(onFoot.targetId, range > 275 ? null : 'bravo-helicopter', `the engineer rocket's 250 m lock range decides (target at ${range.toFixed(0)} m)`);
  assert.equal(state.lockerModel(byId('capturing').self, {}), null, 'no locker box without cq[5]');
  ok();
}

/* --------------------------------------------------- markers and map */

{
  const f = byId('capturing');
  const projector = projectorFor(f);
  const flags = state.flagMarkerModels(cqOf(f), f.self, 'alpha', projector, { top: 96, bottom: 120, left: 48, right: 48 });
  assert.equal(flags.length, 5);
  for (const m of flags) {
    assert.ok(m.x >= 48 - 1e-6 && m.x <= VIEW.width - 48 + 1e-6 && m.y >= 96 - 1e-6 && m.y <= VIEW.height - 120 + 1e-6, `${m.id} clamped inside the insets`);
  }
  assert.equal(flags.find(m => m.id === 'C').inside, true, 'the flag we stand in hides its marker');
  assert.ok(flags.some(m => m.edge), 'flags behind the camera clamp to the edge');
  assert.equal(flags.find(m => m.id === 'A').distance, Math.round(Math.hypot(232 - f.self.x, 248 - f.self.z)));
  const edge = clampToEdge({ x: 3000, y: 450, inside: false }, 1440, 900);
  assert.equal(edge.edge, true); assert.equal(edge.x, 1400); assert.ok(Math.abs(edge.angle - Math.PI / 2) < 1e-9);

  // Edge markers slide along their border: off each other, off fixed HUD panels and off on-screen markers.
  const insets = { top: 96, bottom: 120, left: 48, right: 48 };
  const stacked = [
    { id: 'A', x: 48, y: 400, edge: true, inside: false, distance: 176 },
    { id: 'D', x: 48, y: 410, edge: true, inside: false, distance: 240 },
    { id: 'C', x: 700, y: 420, edge: false, inside: false, distance: 20 },
    { id: 'E', x: 1392, y: 300, edge: true, inside: false, distance: 250 },
  ];
  const minimapBox = { left: 0, top: 560, right: 230, bottom: 820 };
  const spread = state.spreadEdgeMarkers(stacked, { width: 1440, height: 900, insets, obstacles: [minimapBox] });
  const at = id => spread.find(m => m.id === id);
  const box = state.FLAG_MARKER_BOX;
  assert.deepEqual([at('A').x, at('A').y], [48, 400], 'the nearest edge marker keeps its clamp slot');
  assert.equal(at('D').x, 48, 'a left-edge marker stays on the left edge');
  assert.ok(Math.abs(at('D').y - at('A').y) >= box.top + box.bottom, 'stacked edge markers separate by a full marker');
  assert.deepEqual([at('C').x, at('C').y, at('E').x, at('E').y], [700, 420, 1392, 300], 'on-screen and lone markers stay put');
  assert.ok(at('D').y >= insets.top && at('D').y <= 900 - insets.bottom, 'slides stay inside the insets');
  const blocked = state.spreadEdgeMarkers([{ id: 'B', x: 48, y: 700, edge: true, inside: false, distance: 90 }],
    { width: 1440, height: 900, insets, obstacles: [minimapBox] })[0];
  assert.ok(blocked.y + box.bottom <= minimapBox.top, `an edge marker leaves the minimap (y ${blocked.y})`);
  assert.equal(state.spreadEdgeMarkers(flags, { width: VIEW.width, height: VIEW.height, insets }).length, flags.length);
  // A pile on one border keeps the bearing order (B above A above D), with a clear gap between neighbours.
  const pile = state.spreadEdgeMarkers([
    { id: 'A', x: 1392, y: 400, edge: true, inside: false, distance: 100 },
    { id: 'B', x: 1392, y: 396, edge: true, inside: false, distance: 200 },
    { id: 'D', x: 1392, y: 404, edge: true, inside: false, distance: 300 },
    { id: 'E', x: 1392, y: 401, edge: true, inside: false, distance: 400 },
  ], { width: 1440, height: 900, insets });
  const py = id => pile.find(m => m.id === id).y;
  assert.equal(py('A'), 400, 'the nearest keeps its slot');
  assert.ok(py('B') < py('A') && py('D') > py('A'), `order follows the clamp order (B ${py('B')}, A 400, D ${py('D')})`);
  const ys = pile.map(m => m.y).sort((a, b) => a - b);
  for (let i = 1; i < ys.length; i++) assert.ok(ys[i] - ys[i - 1] >= box.top + box.bottom + state.EDGE_MARKER_GAP, `gap between piled markers (${ys.join(', ')})`);
  assert.ok(pile.every(m => m.x === 1392), 'a pile with room stays on its border');
  // A border too short for all of them still never stacks two markers.
  const crowded = state.spreadEdgeMarkers(['A', 'B', 'C', 'D', 'E'].map((id, i) => ({ id, x: 196, y: 180, edge: true, inside: false, distance: 100 + i })),
    { width: 844, height: 390, insets: { top: 124, bottom: 150, left: 196, right: 28 }, obstacles: [{ left: 0, top: 0, right: 844, bottom: 100 }] });
  for (let i = 0; i < crowded.length; i++) for (let j = 0; j < i; j++) {
    const a = crowded[i], b = crowded[j];
    assert.ok(Math.abs(a.x - b.x) >= box.left + box.right || Math.abs(a.y - b.y) >= box.top + box.bottom, `${a.id} and ${b.id} do not stack`);
  }

  // Squad list beside the minimap.
  const squadFix = byId('capturing');
  const model = state.squadListModel({ cq: cqOf(squadFix), self: squadFix.self, players: squadFix.players, vehicles: squadFix.vehicles });
  assert.equal(model.name, 'ALPHA'); assert.equal(model.selfLeader, true, 'squad 1 is led by the local player');
  assert.deepEqual(model.rows.map(r => [r.name, r.kit, r.state, r.vehicleType]),
    [['Brannock', 'support', 'alive', null], ['Halden', 'assault', 'alive', null], ['Kestrel', 'engineer', 'alive', null]],
    'squadmates only (no self, no other squad), kits from cq[0]');
  const rv = byId('revive');
  const downRow = state.squadListModel({ cq: cqOf(rv), self: rv.self, players: rv.players }).rows.find(r => r.name === 'Mercer');
  assert.equal(downRow.state, 'down', 'a downed mate reads DOWN');
  assert.ok(!state.squadListModel({ cq: cqOf(rv), self: rv.self, players: rv.players }).rows.some(r => r.name === 'Lindqvist'), 'other squads stay out');
  // Seated mates show their hull; a dead (not downed) mate reads DEAD; the leader is flagged.
  const seatedPlayers = squadFix.players.map(p => p.id === 'sq1' ? { ...p, vehicleId: 'alpha-helicopter', vehicleSeatId: 'gunner' } : p.id === 'sq2' ? { ...p, hp: 0, state: 'dead' } : p);
  const cqCap = cqOf(squadFix);
  const led = { ...cqCap, squads: cqCap.squads.map(sq => sq.team === 'alpha' && sq.squadId === 1 ? { ...sq, leaderId: 'sq1' } : sq) };
  const seated = state.squadListModel({ cq: led, self: squadFix.self, players: seatedPlayers, vehicles: squadFix.vehicles });
  assert.deepEqual(seated.rows.map(r => [r.name, r.state, r.vehicleType, r.leader]),
    [['Kestrel', 'alive', 'helicopter', true], ['Brannock', 'dead', null, false], ['Halden', 'alive', null, false]], 'leader first, hull and death from the rows');
  assert.equal(state.squadListModel({ cq: cqCap, self: { ...squadFix.self, cq: [0, 0, 0, 0, 0, 0, 0] }, players: squadFix.players }), null, 'no squad, no list');
  const revive = byId('revive');
  const units = state.unitMarkerModels({ self: revive.self, players: revive.players, vehicles: revive.vehicles, selfTeam: 'alpha', projector: projectorFor(revive) });
  assert.deepEqual(units.filter(u => u.kind === 'down').map(u => u.id).sort(), ['dn1', 'dn2'], 'downed teammates within 40 m');
  const far = state.unitMarkerModels({ self: { ...revive.self, x: revive.self.x + 60 }, players: revive.players, selfTeam: 'alpha', projector: projectorFor(revive) });
  assert.equal(far.filter(u => u.kind === 'down').length, 0, 'none beyond 40 m');

  const items = state.mapItems({ cq: cqOf(f), self: f.self, players: f.players, vehicles: f.vehicles, selfTeam: 'alpha' });
  const kinds = id => items.filter(i => i.id === id).map(i => i.kind);
  assert.deepEqual(kinds('en1'), ['spotted'], 'cq[3] spotted enemy shows');
  assert.deepEqual(kinds('en2'), [], 'unspotted enemy stays hidden');
  assert.deepEqual(kinds('sq1'), ['squad']); assert.deepEqual(kinds('tm1'), ['team']);
  assert.equal(items.find(i => i.id === 'bravo-tank').rel, 'spotted', 'vehicles[].sp shows the enemy hull');
  assert.equal(items.filter(i => i.kind === 'flag').length, 5); assert.equal(items.filter(i => i.kind === 'hq').length, 2);
  const hidden = state.mapItems({ cq: cqOf(f), self: f.self, players: f.players, vehicles: f.vehicles.map(v => ({ ...v, sp: 0 })), selfTeam: 'alpha' });
  assert.equal(hidden.some(i => i.id === 'bravo-tank'), false);
  const placed = state.minimapPlacement({ x: 0, z: -10 }, { x: 0, z: 0 }, 0, 2);
  assert.ok(Math.abs(placed.x) < 1e-9 && placed.y === -20, 'heading-up: ahead is up');
  ok();
}

/* --------------------------------------------- events: ticker, banners */

{
  assert.deepEqual(state.scoreEntry({ kind: 'score', id: 'me', pts: 250, reason: 'capture' }, 'me').label, SCORE_LABELS.capture);
  assert.equal(state.scoreEntry({ kind: 'score', id: 'other', pts: 100, reason: 'kill' }, 'me'), null, 'only own score events');
  let lines = [];
  lines = stackTicker(lines, state.scoreEntry({ kind: 'score', id: 'me', pts: 10, reason: 'repair' }, 'me'), 0);
  lines = stackTicker(lines, state.scoreEntry({ kind: 'score', id: 'me', pts: 10, reason: 'repair' }, 'me'), 300);
  lines = stackTicker(lines, state.scoreEntry({ kind: 'score', id: 'me', pts: 100, reason: 'kill' }, 'me'), 400);
  assert.deepEqual(lines.map(l => l.text), ['+20 REPAIR ×2', '+100 KILL']);
  assert.equal(stackTicker(lines, null, 400 + TICKER_HOLD_MS).length, 0, 'lines leave after 3 s');

  const b = (ev, team = 'alpha', owner = null) => state.bannerForEvent(ev, team, { flagOwner: owner, flagName: 'Iron Bridge' });
  assert.equal(b({ kind: 'flag_captured', flag: 'C', team: 'alpha' }).title, 'OBJECTIVE C · IRON BRIDGE CAPTURED');
  assert.equal(b({ kind: 'flag_captured', flag: 'C', team: 'bravo' }).tone, 'enemy');
  assert.equal(b({ kind: 'flag_neutralized', flag: 'B', team: 'bravo', prev: 'alpha' }).title, 'OBJECTIVE B · IRON BRIDGE LOST');
  assert.equal(b({ kind: 'flag_neutralized', flag: 'D', team: 'alpha', prev: 'bravo' }).title, 'OBJECTIVE D · IRON BRIDGE NEUTRALIZED');
  assert.equal(b({ kind: 'flag_state', flag: 'B', state: 'neutralizing', team: 'bravo' }, 'alpha', 'alpha').title, 'OBJECTIVE B · IRON BRIDGE UNDER ATTACK');
  assert.equal(b({ kind: 'flag_state', flag: 'D', state: 'neutralizing', team: 'alpha' }, 'alpha', 'bravo'), null, 'no banner for our own attack');
  assert.equal(b({ kind: 'flag_state', flag: 'B', state: 'restoring', team: 'alpha' }, 'alpha', 'alpha'), null);
  assert.equal(b({ kind: 'ticket_low', team: 'alpha', tickets: 75 }).title, 'REINFORCEMENTS LOW');
  assert.equal(b({ kind: 'ticket_low', team: 'bravo', tickets: 30 }).title, 'ENEMY REINFORCEMENTS LOW');
  assert.deepEqual(state.matchEndBanner({ mode: 'conquest', phase: 'post', winner: 'bravo' }, 'bravo').title, 'VICTORY');
  assert.deepEqual(state.matchEndBanner({ mode: 'conquest', phase: 'post', winner: 'alpha' }, 'bravo').title, 'DEFEAT');
  assert.deepEqual(state.matchEndBanner({ mode: 'conquest', phase: 'post', winner: null }, 'bravo').outcome, 'draw');
  assert.equal(state.matchEndBanner({ mode: 'conquest', phase: 'live' }, 'alpha'), null);

  // Scheduling: higher priority replaces, a repeated key within 6 s is dropped, expiry pops the queue.
  let sched = { current: null, queue: [], seen: new Map() };
  sched = scheduleBanner(sched, { key: 'atk:B', priority: 1, title: 'a' }, 0);
  sched = scheduleBanner(sched, { key: 'neu:B', priority: 4, title: 'b' }, 100);
  assert.equal(sched.current.key, 'neu:B'); assert.equal(sched.queue[0].key, 'atk:B');
  sched = scheduleBanner(sched, { key: 'neu:B', priority: 4, title: 'b' }, 200);
  assert.equal(sched.queue.length, 1, 'oscillating events never spam');
  sched = tickBanners(sched, 100 + BANNER_MS);
  assert.equal(sched.current.key, 'atk:B');

  assert.equal(state.vehicleHitMark({ kind: 'vehicle_hit', attacker: 'me', eff: 1 }, 'me'), 'armor');
  assert.equal(state.vehicleHitMark({ kind: 'vehicle_hit', attacker: 'me', eff: 0 }, 'me'), 'spark');
  assert.equal(state.vehicleHitMark({ kind: 'vehicle_hit', attacker: 'x', eff: 1 }, 'me'), null);
  assert.deepEqual(state.hullZoneFlash({ kind: 'vehicle_hit', vehicleId: 't', zone: 'rear', eff: 1 }, { id: 't' }), { zone: 'rear', effective: true });

  const card = state.killerCard({ kind: 'kill', killer: 'en1', victim: 'me', w: 'tankAP', hs: false }, 'me', byId('capturing').players);
  assert.equal(card.name, 'Rourke'); assert.equal(card.weaponName, '120MM AP'); assert.ok(card.distance > 0);
  const restricted = state.killerCard({ kind: 'kill', killer: 'me', victim: 'me', w: 'restricted' }, 'me', []);
  assert.equal(restricted.self, true); assert.equal(restricted.name, 'RESTRICTED AREA');
  assert.equal(state.killerCard({ kind: 'kill', killer: 'me', victim: 'en1', w: 'rifle' }, 'me', []), null);
  ok();
}

/** A combat HUD whose row and hitmarker timers never outlive the test. */
function quietCombat(domParts) {
  const combat = new CombatHudController({ dom: domParts, matchDom: {}, state: {}, isBuilt: () => true, getHudRoot: () => document.body });
  combat._setTimer = () => 0;
  combat._clearTimer = () => {};
  return combat;
}

/* ------------------------------------------- kill feed: every vehicle key */

{
  for (const key of [...Object.keys(VEHICLE_WEAPON_META), 'vehicle', 'restricted']) {
    assert.ok(WEAPON_NAMES[key], `${key} has a kill-feed name`);
    assert.ok(isVehicleKillKey(key) && VEHICLE_KILL_KEYS.includes(key));
    assert.ok(ICON_PATHS[KILL_KEY_ICONS[key]], `${key} has a vector icon`);
  }
  assert.equal(WEAPON_NAMES.vehicle, 'ROADKILL');
  const kf = document.createElement('div');
  const combat = quietCombat({ kf });
  combat.setNames([{ id: 'me', name: 'You' }, { id: 'en1', name: 'Rourke' }]);
  for (const key of [...VEHICLE_KILL_KEYS, 'rocket']) {
    combat.killfeed({ killer: 'en1', victim: 'me', w: key });
    const row = kf.firstChild;
    assert.ok(!row.textContent.includes('ENVIRONMENT'), `${key}: no ENVIRONMENT kill-feed row`);
    assert.ok(row.textContent.includes(WEAPON_NAMES[key]), `${key}: row names ${WEAPON_NAMES[key]}`);
    if (key !== 'rocket') assert.equal(row.querySelectorAll('.kf-vehicle-icon').length, 1, `${key}: vector icon`);
  }
  combat.vehicleDestroyed({ kind: 'vehicle_destroyed', vehicleId: 'bravo-tank', type: 'tank', attacker: 'me', assists: [], crewKilled: 2 });
  const destroyed = kf.querySelectorAll('.kf-vehicle-destroyed').at(-1);
  assert.equal(destroyed.textContent, 'YouDESTROYEDTANK+2 CREW');
  combat.dispose?.();
  ok();
}

/* --------------------------------------------- scoreboard and results */

{
  const f = byId('scoreboard');
  const rows = f.players.map(state.scoreboardRow);
  assert.deepEqual(rows.find(r => r.squad === 1 && r.objective === 350), { score: 860, kills: 4, deaths: 2, objective: 350, vehicles: 1, revives: 0, captures: 1, squad: 1, kit: 'engineer' });
  assert.equal(squadName(1), 'ALPHA'); assert.equal(squadName(2), 'BRAVO');
  const grouped = groupBySquad(f.players.filter(p => p.team === 'alpha'));
  assert.deepEqual(grouped.map(p => p.id), ['me', 'sq1', 'sq2', 'tm1', 'tm2'], 'squad 1 (2340 pts) before squad 2 (1420 pts)');

  const parent = document.createElement('div');
  const board = new Scoreboard();
  board.build(parent);
  board.update(f.players, f.match, 'me');
  const heads = board.root.querySelectorAll('th').map(th => th.textContent);
  assert.deepEqual(heads.slice(0, 8), ['SQ', 'PLAYER', 'SCORE', 'K', 'D', 'OBJ', 'VEH', 'REV']);
  const squads = board.root.querySelectorAll('.vb-sb-squad-row').map(r => r.textContent);
  assert.deepEqual(squads, ['SQUAD ALPHA', 'SQUAD BRAVO', 'SQUAD ALPHA', 'SQUAD BRAVO']);
  assert.ok(board.root.textContent.includes(`${TEAM_DISPLAY.alpha} 214`) && board.root.textContent.includes(`${TEAM_DISPLAY.bravo} 187`), 'WEST/EAST ticket headings');
  const sections = board.root.querySelectorAll('.vb-scoreboard-team');
  assert.deepEqual(sections.map(s => s.dataset.rel), ['own', 'enemy']);

  const graph = state.ticketGraphModel(byId('result').match.conquest.ticketGraph, { width: 480, height: 110 });
  assert.equal(graph.durationMs, 600_000); assert.equal(graph.alpha.split(' ').length, 61);
  assert.equal(state.ticketGraphModel([[0, 300, 300]]), null, 'one sample is no graph');
  const mvps = state.conquestMvps(byId('result').match.results);
  assert.deepEqual(mvps.map(m => [m.title, m.name]), /* objective tie 400 = 400 goes to the higher score */ [['MVP', 'Rourke'], ['TOP GUN', 'Rourke'], ['OBJECTIVE', 'Rourke'], ['TANK BUSTER', 'Ibarra'], ['MEDIC', 'Okafor']]);

  const overlay = new MatchResultOverlay();
  const hud = document.createElement('div');
  overlay.build(hud);
  const result = byId('result');
  overlay.update(result.match, result.self, result.players, FIXTURE_NOW);
  assert.equal(overlay.dom.conquest.hidden, false);
  assert.equal(overlay.dom.graph.querySelectorAll('polyline').length, 2);
  assert.deepEqual(overlay.dom.graph.querySelectorAll('polyline').map(l => l.getAttribute('class')), ['vb-result-graph-line is-own', 'vb-result-graph-line is-enemy']);
  assert.equal(overlay.dom.mvps.children.length, 5);
  assert.ok(overlay.dom.detail.textContent.includes('WEST HOLDS THE FRONTIER'));
  assert.equal(overlay.dom.score.textContent, `${result.match.conquest.tickets.alpha}:${result.match.conquest.tickets.bravo}`);
  ok();
}

/* ------------------------------------------------------------ keybinds */

{
  const actions = Object.fromEntries(KEYBINDING_ACTIONS.map(a => [a.id, a]));
  const defaults = defaultKeybindings();
  assert.deepEqual(defaults.spot, ['KeyY']); assert.deepEqual(defaults.bigMap, ['KeyM']);
  for (const [id, code] of [['vehicleCountermeasure', 'KeyX'], ['vehicleCamera', 'KeyC'], ['vehicleWeaponNext', 'KeyQ']]) {
    assert.deepEqual(defaults[id], [code]); assert.equal(actions[id].context, 'vehicle', `${id} lives in the vehicle context`);
  }
  // Same-context defaults never collide; vehicle keys may share prone/crouch/lean.
  const seen = new Map();
  for (const action of KEYBINDING_ACTIONS) for (const code of defaults[action.id]) {
    const key = `${action.context}:${code}`;
    assert.ok(!seen.has(key), `${code} bound twice in ${action.context}: ${seen.get(key)} and ${action.id}`);
    seen.set(key, action.id);
  }
  const normalized = normalizeKeybindings({});
  assert.deepEqual(normalized.prone, ['KeyX']); assert.deepEqual(normalized.vehicleCountermeasure, ['KeyX']);
  assert.equal(bindingLabel('spot', normalized), 'Y'); assert.equal(bindingLabel('bigMap', normalized), 'M');
  ok();
}

/* -------------------------------------------- render every fixture (DOM) */

function renderFixture(f, { onDeploy = () => {}, onSupport = () => {}, onSpot = () => {} } = {}) {
  const kf = document.createElement('div');
  const combat = quietCombat({ kf, hitmarker: document.createElement('div') });
  combat.setNames(f.players);
  const hud = new ConquestHud(document.body, { combatHud: combat, onDeploy, onSupport, onSpot, eventTarget: dom.window });
  if (f.selection) hud.deploy.selection = { ...hud.deploy.selection, ...f.selection };
  const args = { match: f.match, mapMeta, self: f.self, players: f.players, vehicles: f.vehicles, nowMs: FIXTURE_NOW,
    camera: cameraPose({ ...f.camera, aspect: VIEW.width / VIEW.height }), nearbyVehicle: f.nearbyVehicle, interactHeld: f.interactHeld, viewport: VIEW };
  hud.update(args);
  if (f.dead) hud.setDead(true, f.killer);
  if (f.bigMap) hud.toggleBigMap(true);
  for (const ev of f.events) if (ev.kind === 'kill') combat.killfeed(ev); else hud.handleEvent(ev, 'me');
  hud.update(args);
  return { hud, combat, kf, args };
}

const renderArgs = f => ({ match: f.match, mapMeta, self: f.self, players: f.players, vehicles: f.vehicles, nowMs: FIXTURE_NOW,
  camera: cameraPose({ ...f.camera, aspect: VIEW.width / VIEW.height }), viewport: VIEW });
const shownText = node => (isShown(node) ? node.textContent : '');
const rendered = new Map();
for (const f of fixtures) {
  const r = renderFixture(f);
  rendered.set(f.id, r);
  const { hud } = r;
  assert.equal(hud.root.hidden, false, `${f.id}: HUD visible in Conquest`);
  assert.equal(hud.topBar.chipNodes.size, 5, `${f.id}: five chips`);
  assert.equal(hud.topBar.own.name.textContent, f.selfTeam === 'bravo' ? 'EAST' : 'WEST', `${f.id}: own team left`);
  assert.equal(hud.topBar.clock.textContent, '14:32');
  assert.ok(!/MOUSE AIM|CLICK FIRE|T EXIT|COLLECTIVE/.test(hud.root.textContent), `${f.id}: no permanent keybind help line`);
}
ok();

{
  const cap = rendered.get('capturing').hud;
  assert.equal(shownText(cap.ring.label), 'CAPTURING'); assert.equal(cap.ring.ownCount.textContent, '3'); assert.equal(cap.ring.enemyCount.textContent, '1');
  assert.equal(cap.ring.root.dataset.tone, 'own');
  assert.equal(cap.topBar.enemy.bleed.textContent, '▼ 1/3s'); assert.equal(cap.topBar.own.bleed.textContent, '');
  assert.deepEqual(cap.ticker.list.children.map(n => n.textContent), ['+100KILL', '+50ATTACKER KILL', '+25HEADSHOT']);
  assert.equal(cap.ticker.total.textContent, '+175');
  const chipC = cap.topBar.chipNodes.get('C');
  assert.equal(chipC.dataset.owner, 'neutral'); assert.equal(chipC.dataset.lean, 'own'); assert.equal(chipC.style.getPropertyValue('--fill'), '0.380');
  assert.equal(cap.markers.flags.get('C').hidden, true);
  assert.ok(textsDrawn(cap.minimap.context).includes('C'), 'minimap paints flag letters');
  assert.equal(cap.minimap.root.hidden, false);

  assert.equal(shownText(rendered.get('neutralizing').hud.ring.label), 'NEUTRALIZING');
  const contested = rendered.get('contested').hud;
  assert.equal(contested.ring.root.dataset.tone, 'contested'); assert.equal(contested.topBar.chipNodes.get('C').dataset.contested, 'true');
  assert.equal(contested.markers.flags.get('C').dataset.contested, 'true');
  const defending = rendered.get('defending').hud;
  assert.equal(shownText(defending.ring.label), 'DEFENDING');
  assert.equal(shownText(defending.banners.title), 'OBJECTIVE B · ST. ALDRIC UNDER ATTACK');
  const restoring = rendered.get('restoring').hud;
  assert.equal(shownText(restoring.ring.label), 'RESTORING'); assert.equal(restoring.topBar.own.bleed.textContent, '▼ 1/1s');
  assert.equal(shownText(restoring.banners.title), 'REINFORCEMENTS LOW');
  assert.equal(restoring.topBar.own.box.dataset.low, 'true');

  const east = rendered.get('east-relative').hud;
  assert.ok(east.topBar.own.box.classList.contains('cq-team-own'), 'EAST rides in the blue own slot');
  assert.equal(east.topBar.own.tickets.textContent, '233');
  assert.equal(east.topBar.chipNodes.get('D').dataset.owner, 'own');
  assert.equal(shownText(east.banners.title), 'OBJECTIVE C · IRON BRIDGE NEUTRALIZED');

  const oob = rendered.get('out-of-bounds').hud;
  assert.equal(oob.restricted.root.hidden, false); assert.equal(oob.restricted.seconds.textContent, '7');
  assert.equal(oob.restricted.title.textContent, 'OUT OF BOUNDS');

  const revive = rendered.get('revive').hud;
  assert.equal(revive.interact.root.hidden, false); assert.equal(revive.interact.label.textContent, 'HOLD REVIVE MERCER');
  assert.equal(revive.interact.arc.getAttribute('stroke-dashoffset'), (2 * Math.PI * 17 * 0.4).toFixed(2), 'hold ring from cq[6] = 60 %');
  assert.equal(revive.markers.units.filter(n => !n.hidden && n.dataset.kind === 'down').length, 2);
  ok();
}

{
  const css = readFileSync(new URL('../public/styles/conquest.css', import.meta.url), 'utf8');
  assert.match(css, /--cq-own:\s*#4cc3ff/); assert.match(css, /--cq-enemy:\s*#ff8a3d/); assert.match(css, /--cq-neutral:\s*#d8d8d8/);
  assert.match(css, /\.cq-team-own \.cq-tickets \{ color: var\(--cq-own\)/, 'own tickets are blue whatever the team');
  ok();
}

{
  const tank = rendered.get('tank-driver');
  const panel = tank.hud.vehiclePanel;
  assert.equal(panel.root.hidden, false); assert.equal(panel.name.textContent, 'TANK'); assert.equal(panel.root.dataset.hp, 'critical');
  assert.deepEqual(panel.badges.children.map(n => n.textContent), ['DISABLED', 'BURNING']);
  assert.deepEqual(panel.weapons.children.map(n => n.querySelector('.cq-weapon-name').textContent), ['120MM AP', '120MM HE', 'COAX 7.62']);
  assert.equal(panel.weapons.children[0].dataset.state, 'reloading');
  assert.equal(panel.cmLabel.textContent, 'SMOKE 46%');
  assert.equal(panel._zones.rear.classList.contains('is-hit'), true, 'rear AT hit flashes the rear zone');
  assert.ok(tank.kf.textContent.includes('DESTROYED') && tank.kf.textContent.includes('JEEP'), 'X DESTROYED JEEP row from vehicle_destroyed');
  assert.ok(!tank.kf.textContent.includes('ENVIRONMENT'));
  assert.ok(tank.combat.dom.hitmarker.classList.contains('vb-armor-hit'), 'effective own hull hit: yellow armour marker');
  assert.ok(tank.hud.reticles.context.calls.length > 0, 'tank reticle painted');
  tank.hud.update(tank.args);
  assert.equal(document.body.dataset.vehicleSeated, 'true', 'seated flag hides the infantry ammo card');

  for (const [id, label] of [['heli-pilot', 'LOCKING'], ['heli-gunner', 'LOCKED'], ['transport-door', 'MISSILE INBOUND']]) {
    const hud = rendered.get(id).hud;
    assert.equal(hud.lock.root.hidden, false); assert.equal(hud.lock.root.dataset.state, String({ LOCKING: 1, LOCKED: 2, 'MISSILE INBOUND': 3 }[label]));
    assert.ok(hud.lock.label.textContent.startsWith(label), `${id} lock banner`);
  }
  const jet = rendered.get('jet').hud;
  const jetText = textsDrawn(jet.reticles.context);
  assert.ok(jetText.includes('KM/H') && jetText.includes('ALT M') && jetText.includes('LOCKING 70%'), 'speed/alt tapes and locker label');
  assert.equal(rendered.get('tank-commander').hud.vehiclePanel.cm.hidden, true);

  const enter = rendered.get('enter-jeep').hud;
  assert.equal(enter.interact.label.textContent, 'ENTER JEEP · F2 GUNNER'); assert.equal(enter.interact.ringBox.hidden, true);
  assert.equal(enter.vehiclePanel.root.hidden, true);

  const big = rendered.get('big-map').hud;
  assert.equal(big.bigMap.open, true); assert.equal(big.bigMap.root.hidden, false);
  const bigText = textsDrawn(big.bigMap.map.context);
  for (const name of ['KESTREL FARM', 'IRON BRIDGE', 'KESSLER WORKS']) assert.ok(bigText.includes(name), `big map labels ${name}`);
  const squadHud = rendered.get('capturing').hud;
  assert.equal(squadHud.squadList.root.hidden, false);
  assert.equal(squadHud.squadList.head.textContent, 'ALPHA SQUAD');
  assert.deepEqual(squadHud.squadList.rows.filter(n => !n.hidden).map(n => n.label.textContent), ['Brannock', 'Halden', 'Kestrel']);
  assert.equal(rendered.get('deploy').hud.squadList.root.hidden, true, 'no squad list while dead (deploy screen)');
  const rev = rendered.get('revive').hud.squadList.rows.find(n => n.label.textContent === 'Mercer');
  assert.equal(rev.dataset.state, 'down'); assert.equal(rev.state.textContent, 'DOWN');
  // Map layering: flag names paint after every hull and spawn badge, so no badge covers a name.
  for (const [id, map] of [['deploy', rendered.get('deploy').hud.deploy.map], ['big-map', big.bigMap.map]]) {
    const all = map.context.calls;
    const calls = all.slice(all.findLastIndex(c => c[0] === 'clearRect'));
    const lastBadge = calls.findLastIndex(c => c[0] === 'arc' || c[0] === 'fill');
    const firstName = calls.findIndex(c => c[0] === 'fillText' && c[1] === 'IRON BRIDGE');
    assert.ok(firstName > lastBadge, `${id}: IRON BRIDGE is drawn above the badges (${firstName} > ${lastBadge})`);
  }
  // Badges on a flag step aside, at most maxShift from their true spot, and off each other.
  const badges = [{ x: 100, y: 100, ox: 100, oy: 100, r: 10 }, { x: 101, y: 100, ox: 101, oy: 100, r: 10 }];
  declutter(badges, [{ x: 100, y: 100, r: 15 }], { px: 400, maxShift: 40 });
  for (const b of badges) {
    assert.ok(Math.hypot(b.x - 100, b.y - 100) >= 25 - 0.5, `badge clears the flag (${b.x.toFixed(1)}, ${b.y.toFixed(1)})`);
    assert.ok(Math.hypot(b.x - b.ox, b.y - b.oy) <= 40 + 1e-6, 'badge stays near its true spot');
  }
  assert.ok(Math.hypot(badges[0].x - badges[1].x, badges[0].y - badges[1].y) >= 20 - 0.5, 'badges clear each other');
  ok();
}

/* ---------------------------------------------- interactions (callbacks) */

{
  const f = byId('revive');
  const supports = [];
  const { hud, args } = renderFixture(f, { onSupport: intent => supports.push(intent) });
  assert.deepEqual(supports, [{ type: 'revive', targetId: 'dn1' }], 'held ≥ 300 ms near a downed mate sends support');
  hud.update({ ...args, nowMs: FIXTURE_NOW + 100 });
  hud.update({ ...args, nowMs: FIXTURE_NOW + 250 });
  assert.equal(supports.length >= 1, true);
  hud.update({ ...args, interactHeld: 0 });
  const before = supports.length;
  hud.update({ ...args, interactHeld: 0 });
  assert.equal(supports.length, before, 'releasing Interact stops the pump');

  const spots = [];
  const spotter = renderFixture(byId('capturing'), { onSpot: () => spots.push(1) }).hud;
  dom.window.dispatchEvent({ type: 'keydown', code: 'KeyY', key: 'y', repeat: false, target: document.body });
  assert.equal(spots.length, 1, 'Y spots');
  dom.window.dispatchEvent({ type: 'vb-conquest-action', detail: { action: 'spot' } });
  assert.equal(spots.length, 2, 'touch SPOT (vb-conquest-action) routes through the HUD');
  spotter.handleEvent({ kind: 'spot', by: 'me', ids: ['en1', 'en2'] }, 'me');
  assert.equal(spotter.spotFlash.textContent, '2 ENEMIES SPOTTED');
  dom.window.dispatchEvent({ type: 'keydown', code: 'KeyM', key: 'm', repeat: false, target: document.body });
  assert.equal(spotter.bigMap.open, true, 'M opens the full map');
  spotter.dispose();
  assert.equal(document.body.dataset.vehicleSeated, undefined);

  // Merged Interact state (keyboard / pad / touch USE) is timed by the HUD itself.
  const timed = [];
  const reviveHud = new ConquestHud(document.body, { onSupport: i => timed.push(i), eventTarget: dom.window });
  const reviveArgs = { ...renderArgs(f), interactHeld: undefined };
  reviveHud.update({ ...reviveArgs, interactDown: true });
  assert.equal(timed.length, 0, 'a fresh press is not a hold yet');
  reviveHud._downSince -= CONQUEST_RULES.repairHoldStartMs + 10;
  reviveHud.refresh({ interactDown: true });
  assert.deepEqual(timed, [{ type: 'revive', targetId: 'dn1' }], 'interactDown held past repairHoldStartMs pumps support');
  reviveHud.refresh({ interactDown: false });
  assert.equal(reviveHud._downSince, null);
  // Pressing and holding the prompt itself (touch) also counts; a tap on a revive prompt never enters a hull.
  const interacts = [];
  reviveHud.interact.root.dispatchEvent({ type: 'pointerdown', pointerId: 3 });
  reviveHud.interact.pressedAt -= 400;
  reviveHud.refresh({ nowMs: FIXTURE_NOW + 1000 });
  assert.equal(timed.length, 2, 'holding the prompt sends support');
  reviveHud.interact.root.dispatchEvent({ type: 'pointerup', pointerId: 3 });
  assert.equal(reviveHud.interact.pressedMs(0), 0);
  reviveHud.dispose();
  const enterHud = new ConquestHud(document.body, { onInteract: () => interacts.push('enter'), eventTarget: dom.window });
  enterHud.update({ ...renderArgs(byId('enter-jeep')), nearbyVehicle: byId('enter-jeep').nearbyVehicle });
  enterHud.interact.root.click();
  assert.deepEqual(interacts, ['enter'], 'tapping ENTER enters');
  enterHud.update(renderArgs(f));
  enterHud.interact.root.click();
  assert.deepEqual(interacts, ['enter'], 'tapping a revive prompt does not');
  enterHud.dispose();

  // Menus (gameplay input closed): Y and M do nothing.
  const gated = [];
  const menuHud = new ConquestHud(document.body, { onSpot: () => gated.push(1), eventTarget: dom.window, inputEnabled: () => false });
  menuHud.update(renderArgs(byId('capturing')));
  dom.window.dispatchEvent({ type: 'keydown', code: 'KeyY', key: 'y', repeat: false, target: document.body });
  dom.window.dispatchEvent({ type: 'keydown', code: 'KeyM', key: 'm', repeat: false, target: document.body });
  assert.equal(gated.length, 0); assert.equal(menuHud.bigMap.open, false);
  const interactCode = defaultKeybindings().interact[0];
  dom.window.dispatchEvent({ type: 'keydown', code: interactCode, key: interactCode.slice(-1).toLowerCase(), repeat: false, target: document.body });
  assert.equal(menuHud._interactDownAt, null, 'Interact behind a menu never starts a revive / repair hold');
  menuHud.dispose();

  // The vehicle controller prevents the T release it turns into an enter/exit tap.
  // The HUD's hold still ends there, or a stale start would pump support later.
  const staleHud = new ConquestHud(document.body, { eventTarget: dom.window });
  staleHud.update(renderArgs(byId('enter-jeep')));
  dom.window.dispatchEvent({ type: 'keydown', code: interactCode, key: 't', repeat: false, target: document.body });
  assert.notEqual(staleHud._interactDownAt, null, 'T starts the HUD hold while no hull is in range');
  dom.window.dispatchEvent({ type: 'keyup', code: interactCode, key: 't', repeat: false, target: document.body, defaultPrevented: true });
  assert.equal(staleHud._interactDownAt, null, 'a consumed (prevented) T release still ends the hold');
  staleHud.dispose();

  // Gamepad: D-pad right spots, R3 toggles the full map unless scoped; seated,
  // D-pad up takes the next free seat, LB pops countermeasures and Y cycles weapons.
  const padSpots = [], padCalls = [];
  const padHud = new ConquestHud(document.body, { onSpot: () => padSpots.push(1), eventTarget: dom.window });
  padHud.update(renderArgs(byId('capturing')));
  assert.equal(padHud.padInput({ pressed: null }), false, 'no pad frame does nothing');
  padHud.padInput({ pressed: { buy: true } });
  assert.equal(padSpots.length, 1, 'D-pad right spots');
  padHud.padInput({ pressed: { zoom: true }, scoped: true });
  assert.equal(padHud.bigMap.open, false, 'R3 while scoped stays a zoom step');
  padHud.padInput({ pressed: { zoom: true } });
  assert.equal(padHud.bigMap.open, true, 'R3 opens the full map');
  padHud.padInput({ pressed: { zoom: true } });
  assert.equal(padHud.bigMap.open, false, 'R3 closes it again');
  padHud.padInput({ pressed: { buy: true }, blocked: true });
  assert.equal(padSpots.length, 1, 'nothing acts behind the settings menu');
  const tankFixture = byId('tank-driver');
  // Free the commander seat so D-pad up has a seat to move to.
  const driver = { ...tankFixture, vehicles: tankFixture.vehicles.map(row => (row.seatOccupants?.driver === 'me'
    ? { ...row, seatOccupants: { driver: 'me' } } : row)) };
  const fakeController = { requestSeat: i => padCalls.push(['seat', i]), queueCountermeasure: () => padCalls.push(['cm']),
    queueWeaponNext: () => padCalls.push(['weapon']) };
  padHud.update({ ...renderArgs(driver), vehicleController: fakeController });
  padHud.padInput({ pressed: { slotUp: true, lastWeapon: true, weapon: true } });
  assert.deepEqual(padCalls, [['seat', 1], ['cm'], ['weapon']], 'D-pad up asks for the free commander seat (F2)');
  padHud.dispose();
  const gatedPad = new ConquestHud(document.body, { onSpot: () => padSpots.push(1), eventTarget: dom.window, inputEnabled: () => false });
  gatedPad.update(renderArgs(byId('capturing')));
  gatedPad.padInput({ pressed: { buy: true, zoom: true } });
  assert.equal(padSpots.length, 1); assert.equal(gatedPad.bigMap.open, false, 'pad Conquest actions wait for gameplay input');
  gatedPad.dispose();
  ok();
}

/* ------------------------------------ frame pacing, hint, deploy, reticles */

{
  document.documentElement.classList.remove('vb-touch-mode');
  const { MAP_HINT_MS } = await import('../public/js/ui/conquest-hud.js');
  const { DeployScreen } = await import('../public/js/ui/conquest/deploy-screen.js');
  const f = byId('capturing');
  const hud = new ConquestHud(document.body, { eventTarget: dom.window });
  const args = renderArgs(f);
  hud.update(args);
  assert.equal(shownText(hud.ring.label), 'CAPTURING', 'a snapshot draws immediately before refresh() drives frames');
  let renders = 0;
  const draw = hud._render.bind(hud);
  hud._render = () => { renders++; draw(); };
  hud.refresh({ nowMs: FIXTURE_NOW + 8 });
  assert.equal(renders, 1);
  hud.update({ ...args, nowMs: FIXTURE_NOW + 16 });
  assert.equal(renders, 1, 'frame-driven: a snapshot only ingests, the next frame draws (no double render)');
  assert.equal(hud.self, args.self, 'the ingested state is current for events');
  hud.refresh({ nowMs: FIXTURE_NOW + 20 });
  assert.equal(renders, 2);
  hud._refreshAt -= 1000;
  hud.update({ ...args, nowMs: FIXTURE_NOW + 40 });
  assert.equal(renders, 3, 'once refresh() stops, snapshots draw again');
  // The M / Y hint is onboarding, not a permanent keybind line.
  assert.equal(isShown(hud.bigMapHint), true); assert.equal(hud.bigMapHint.textContent, 'M MAP · Y SPOT');
  hud._shownAt -= MAP_HINT_MS + 1;
  hud._refreshAt = null;
  hud.update(args);
  assert.equal(isShown(hud.bigMapHint), false, 'the hint goes away after MAP_HINT_MS');
  const used = new ConquestHud(document.body, { eventTarget: dom.window });
  used.update(args);
  used.spot();
  used.update(args);
  assert.equal(isShown(used.bigMapHint), false, 'or once the player has spotted or opened the map');
  used.dispose(); hud.dispose();

  // Airborne crew never count toward a capture: no ring while flying over a zone, the ring again once landed.
  {
    const air = new ConquestHud(document.body, { eventTarget: dom.window });
    const heli = { id: 'my-heli', type: 'helicopter', team: 'alpha', x: f.self.x, y: f.self.y, z: f.self.z, yaw: 0, hp: 650,
      seatOccupants: { driver: 'me' }, occupantId: 'me', mounts: [[0, 0, 14, 0, 0], [0, 0, -1, 0, 0]] };
    air.update({ ...args, vehicles: [{ ...heli, grounded: false }] });
    assert.equal(air.seated?.row.id, 'my-heli'); assert.equal(air.ring.root.hidden, true, 'flying: no capture ring');
    air.update({ ...args, vehicles: [heli] });
    assert.equal(air.ring.root.hidden, false, 'landed in the zone: the ring is back');
    air.dispose();
  }

  // A readied spawn that leaves the option list (flag lost) asks again instead of a stale "deploying".
  const deploy = byId('deploy');
  const sent = [];
  const screen = new DeployScreen(document.body, { onDeploy: c => sent.push(c) });
  screen.setOpen(true);
  screen.selection = { spawn: 'flag:A', kit: 'engineer', variant: 1 };
  const cqA = cqOf(deploy);
  screen.update({ cq: cqA, self: deploy.self, players: deploy.players, vehicles: deploy.vehicles, nowMs: FIXTURE_NOW });
  assert.equal(screen.deploy(), true); assert.equal(screen.readied, true);
  assert.deepEqual(sent, [{ spawn: 'flag:A', kit: 'engineer', variant: 1 }]);
  const lostA = { ...deploy.match, conquest: { ...deploy.match.conquest,
    flags: deploy.match.conquest.flags.map(t => (t[0] === 'A' ? ['A', -100, 'bravo', 'idle', 0, 0] : t)) } };
  screen.update({ cq: state.readConquest(lostA, mapMeta), self: deploy.self, players: deploy.players, vehicles: deploy.vehicles, nowMs: FIXTURE_NOW });
  assert.equal(screen.selection.spawn, 'hq'); assert.equal(screen.readied, false);
  assert.equal(sent.length, 1, 'nothing is sent behind the player\'s back');
  assert.ok(screen.button.textContent.startsWith('DEPLOY ·'), screen.button.textContent);
  screen.root.remove();

  // Gamepad on the deploy screen: D-pad steps deployable spawns, LB/RB the kit, A deploys.
  const padSent = [];
  const padDeploy = new ConquestHud(document.body, { onDeploy: c => padSent.push(c), eventTarget: dom.window, inputEnabled: () => false });
  padDeploy.update(renderArgs(deploy));
  padDeploy.setDead(true);
  padDeploy.update(renderArgs(deploy));
  const spawns = padDeploy.deploy.model.options.filter(o => o.ok).map(o => o.spawn);
  assert.ok(spawns.length >= 2, 'the deploy fixture offers several spawns');
  const firstSpawn = padDeploy.deploy.model.selectedKey;
  padDeploy.padInput({ pressed: { grenadePouch: true } });
  assert.equal(padDeploy.deploy.model.selectedKey, spawns[(spawns.indexOf(firstSpawn) + 1) % spawns.length], 'D-pad down picks the next spawn');
  padDeploy.padInput({ pressed: { slotUp: true } });
  assert.equal(padDeploy.deploy.model.selectedKey, firstSpawn, 'D-pad up steps back');
  const kits = padDeploy.deploy.model.kits.map(card => card.id);
  const firstKit = padDeploy.deploy.selection.kit;
  padDeploy.padInput({ pressed: { grenade: true } });
  assert.equal(padDeploy.deploy.selection.kit, kits[(kits.indexOf(firstKit) + 1) % kits.length], 'RB picks the next kit');
  padDeploy.padInput({ pressed: { lastWeapon: true } });
  assert.equal(padDeploy.deploy.selection.kit, firstKit, 'LB steps back');
  padDeploy.padInput({ pressed: { jump: true } });
  assert.deepEqual(padSent.map(c => [c.spawn, c.kit]), [[firstSpawn, firstKit]], 'A deploys the shown choice while gameplay input is closed');
  padDeploy.dispose();

  // Gimbal and door arcs read the shared mount limits; gimbal pitch is relative to the hull.
  const gunner = byId('heli-gunner');
  const seated = state.seatedVehicle(gunner.self, gunner.vehicles);
  const pitched = { ...seated, row: { ...seated.row, pitch: 0.2,
    mounts: seated.row.mounts.map((m, i) => (i === state.mountState(seated.row, 'gunner', 'chin').index ? [m[0], 0.1, ...m.slice(2)] : m)) } };
  const gimbal = state.reticleModel(pitched, { projector: projectorFor(gunner), vehicles: gunner.vehicles, selfTeam: 'alpha' });
  assert.ok(Math.abs(gimbal.pitch - -0.1) < 1e-9, 'world pitch 0.1 on a hull pitched 0.2 is 0.1 below the gimbal axis');
  assert.deepEqual([gimbal.pitchMin, gimbal.pitchMax, gimbal.yawLimit], [-1.05, 0.17, 1.9]);
  const doorFix = byId('transport-door');
  const door = state.reticleModel(state.seatedVehicle(doorFix.self, doorFix.vehicles), { projector: projectorFor(doorFix), vehicles: doorFix.vehicles });
  assert.equal(door.arc, 1.4);

  // Killer card prefers the server's lethal shot length; marker glyphs follow the hull type.
  const card = state.killerCard({ kind: 'kill', killer: 'en1', victim: 'me', w: 'sniper', dist: 212.4 }, 'me', f.players);
  assert.equal(card.distance, 212.4);
  const markers = new (await import('../public/js/ui/conquest/markers.js')).WorldMarkers(document.body);
  const unit = (vehicleType) => ({ kind: 'spotted-vehicle', id: 'v', vehicleType, name: '', distance: 50, x: 10, y: 10 });
  markers.update([], [unit('tank')]);
  const node = markers.units[0], tankGlyph = node.glyph.children[0];
  markers.update([], [unit('plane')]);
  assert.notEqual(node.glyph.children[0], tankGlyph, 'a reused marker node redraws its hull glyph');
  markers.root.remove();
  ok();
}

/* ------------------------------------------ capture tool overlap rule */

{
  const { overlaps } = await import('./conquest-hud-capture.mjs');
  const box = (left, top, w, h) => ({ left, top, right: left + w, bottom: top + h, width: w, height: h });
  assert.deepEqual(overlaps({ minimap: box(10, 120, 104, 104), vehicle: box(200, 600, 150, 120), ring: box(160, 450, 70, 70),
    buttons: [{ action: 'fire', box: box(300, 700, 70, 70) }, { action: 'jump', box: box(320, 690, 60, 60) }] }),
  ['vehicle × touch:fire', 'vehicle × touch:jump'], 'HUD boxes against touch buttons; buttons among themselves are touch-controls\' own contract');
  assert.deepEqual(overlaps({ minimap: box(0, 0, 10, 10), ring: box(10, 0, 10, 10), buttons: [] }), [], 'touching edges do not overlap');
  ok();
}

for (const { hud } of rendered.values()) hud.dispose();
dom.restore();
console.log(`Conquest UI: ${checks} groups passed (read model, ${fixtures.length} fixture states rendered, kill feed, scoreboard, results, keybinds)`);
