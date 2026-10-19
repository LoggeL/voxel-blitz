// Squad orders and the comm rose on the client (docs/conquest.md "Squad
// orders and the comm rose", design docs/design/conquest/orders/): the pure
// read models (order chip, rose segments, request audience, radio lines,
// banners), then the real ConquestHud on a fake DOM: U hold / release,
// D-pad right tap vs hold, the touch COMMS button, full-map orders for
// leaders only, the Input UI capture seam (look and fire pause while the
// rose or the map cursor is up) and the order / request markers.
//
//   node tools/conquest-orders-ui-test.mjs
import assert from 'node:assert/strict';
import { installFakeDom, isShown, textsDrawn } from './lib/conquest-ui-dom.mjs';

const dom = installFakeDom({ width: 1440, height: 900 });
const { document } = dom;

const { ConquestHud } = await import('../public/js/ui/conquest-hud.js');
const { cameraPose, createProjector } = await import('../public/js/ui/conquest/projection.js');
const comms = await import('../public/js/ui/conquest/comms-state.js');
const { CommRose, wedgePath } = await import('../public/js/ui/conquest/comm-rose.js');
const { RadioFeed, RADIO_LINE_MS, RADIO_LINES } = await import('../public/js/ui/conquest/order-chip.js');
const { readConquest } = await import('../public/js/ui/conquest-hud-state.js');
const { conquestHudFixtures, fixtureMapMeta, FIXTURE_NOW } = await import('../public/js/capture/conquest-hud-fixtures.js');
const { visibleTouchActions } = await import('../public/js/engine/touch-controls.js');
const { defaultKeybindings, bindingLabel } = await import('../public/js/keybindings.js');
const { Input } = await import('../public/js/engine/input.js');
const { COMM_ROSE, COMM_KINDS, encodeCommField, decodeCommField, commRequestsOf } = await import('../shared/conquest-comms.js');

const fixtures = conquestHudFixtures();
const mapMeta = fixtureMapMeta();
const byId = id => fixtures.find(f => f.id === id) ?? assert.fail(`fixture ${id}`);
const VIEW = { width: 1440, height: 900 };
const args = (f, patch = {}) => ({ match: f.match, mapMeta, self: f.self, players: f.players, vehicles: f.vehicles, nowMs: FIXTURE_NOW,
  camera: cameraPose({ ...f.camera, aspect: VIEW.width / VIEW.height }), viewport: VIEW, ...patch });
const cqOf = f => readConquest(f.match, mapMeta);
let checks = 0;
const ok = (value, message) => { assert.ok(value, message); checks++; };
const eq = (a, b, message) => { assert.deepEqual(a, b, message); checks++; };

/* --------------------------------------------------------------- models */
{
  const rose = byId('orders-rose'), chip = byId('orders-chip');
  // The order chip: the leader reads YOUR ORDER, a member SQUAD ORDER; the stance follows the owner.
  const lead = comms.squadOrderModel(cqOf(rose), rose.self);
  eq([lead.flagId, lead.stance, lead.title, lead.name, lead.leader], ['C', 'attack', 'ATTACK C', 'IRON BRIDGE', true], 'leader order chip');
  ok(Math.abs(lead.distance - 232) <= 1, 'chip distance from the self row');
  const member = comms.squadOrderModel(cqOf(chip), chip.self);
  eq([member.title, member.leader], ['ATTACK C', false], 'member order chip');
  const held = { ...chip.match, conquest: { ...chip.match.conquest, flags: chip.match.conquest.flags.map(t => (t[0] === 'C' ? ['C', 100, 'alpha', 'idle', 0, 0] : t)) } };
  eq(comms.squadOrderModel(readConquest(held, mapMeta), chip.self).title, 'DEFEND C', 'a captured attack flag reads DEFEND');
  eq(comms.orderFlagOf(cqOf(chip), chip.self), { flagId: 'C', stance: 'attack' });
  const none = { ...chip.match, conquest: { ...chip.match.conquest, squads: [['alpha', 1, 'sq1']] } };
  eq(comms.squadOrderModel(readConquest(none, mapMeta), chip.self), null, 'no order, no chip');
  ok(comms.isSquadLeader(cqOf(rose), rose.self) && !comms.isSquadLeader(cqOf(chip), chip.self), 'leader from the squad tuple');

  // The rose: ATTACK C under the crosshair for the leader; a member's ORDER is disabled.
  const view = f => ({ x: f.camera.x, y: f.camera.y, z: f.camera.z, yaw: f.camera.yaw, pitch: f.camera.pitch });
  const model = comms.commRoseModel({ cq: cqOf(rose), self: rose.self, vehicles: [], view: view(rose) });
  eq(model.segments.map(s => s.kind), [...COMM_ROSE], 'one segment per rose entry, clockwise');
  eq(COMM_ROSE, ['medic', 'ammo', 'repair', 'ride', 'yes', 'no', 'spot', 'order'], 'rose order matches design A');
  const order = model.segments.find(s => s.kind === 'order');
  eq([order.label, order.enabled, order.flagId, order.icon], ['ATTACK C', true, 'C', 'attack'], 'leader aims at C');
  eq(model.segments.find(s => s.kind === 'repair').enabled, false, 'NEED REPAIR needs a damaged hull nearby');
  const memberRose = comms.commRoseModel({ cq: cqOf(chip), self: chip.self, vehicles: [], view: view(chip) });
  eq([memberRose.segments.at(-1).enabled, memberRose.segments.at(-1).note], [false, 'LEADER ONLY'], 'members cannot order');
  const skyward = comms.commRoseModel({ cq: cqOf(rose), self: rose.self, vehicles: [], view: { ...view(rose), pitch: 1.2 } });
  eq(skyward.segments.at(-1).note, 'AIM AT A FLAG', 'no flag in sight, no order');
  const damaged = { id: 'j1', type: 'jeep', team: 'alpha', hp: 120, x: rose.self.x + 4, y: rose.self.y, z: rose.self.z };
  ok(comms.commRoseModel({ cq: cqOf(rose), self: rose.self, vehicles: [damaged], view: view(rose) }).segments[2].enabled, 'a damaged jeep in reach enables NEED REPAIR');
  const seated = { row: { ...damaged, hp: 400 }, seat: { id: 'driver', drives: true } };
  const inJeep = comms.commRoseModel({ cq: cqOf(rose), self: rose.self, vehicles: [], seated, view: view(rose) }).segments;
  eq([inJeep[1].enabled, inJeep[3].enabled, inJeep[2].enabled], [false, false, false], 'seated: no ammo / ride, an undamaged hull needs no repair');

  // Deflection picks a wedge clockwise from the top; the dead zone picks none.
  eq([comms.roseIndexAt(0, -60), comms.roseIndexAt(60, 0), comms.roseIndexAt(0, 60), comms.roseIndexAt(-45, -45), comms.roseIndexAt(4, -4)], [0, 2, 4, 7, -1]);
  ok(/^M.*A98 98 0 0 1 .*L.*A47 47 0 0 0 .*Z$/.test(wedgePath(0, 45)), 'annular wedge path');

  // Requests: the cqc field rides the requester row; the audience is the kit that answers it.
  eq(decodeCommField({ cqc: encodeCommField({ seq: 9, kind: 'repair', responder: 'b2', vehicleId: 'alpha-jeep-1' }) }),
    { seq: 9, kind: 'repair', responder: 'b2', vehicleId: 'alpha-jeep-1' });
  eq(decodeCommField({ cqc: [1, COMM_KINDS.indexOf('yes'), null] }), null, 'only request kinds decode');
  const requests = commRequestsOf(rose.players);
  eq(requests.map(r => [r.by, r.kind]), [['sq4', 'medic']], 'the fixture squadmate needs a medic');
  const medicSees = comms.visibleRequests({ self: rose.self, players: rose.players });
  eq([medicSees.length, medicSees[0].name, medicSees[0].own], [1, 'Nova', false], 'a Medic sees NEED MEDIC');
  ok(Math.abs(medicSees[0].distance - 34) <= 1, 'at 34 m');
  const assault = { ...rose.self, cq: [0, ...rose.self.cq.slice(1)] };
  eq(comms.visibleRequests({ self: assault, players: rose.players }).length, 0, 'an Assault does not');
  const own = comms.visibleRequests({ self: chip.self, players: chip.players });
  eq([own.length, own[0].own, own[0].kind, own[0].responderName], [1, true, 'ammo', 'Brannock'], 'the requester sees its own request and responder');
  const foe = { ...rose.self, team: 'bravo' };
  eq(comms.visibleRequests({ self: foe, players: rose.players }).length, 0, 'never the other team');
  const projector = createProjector(cameraPose({ ...rose.camera, aspect: VIEW.width / VIEW.height }), VIEW.width, VIEW.height);
  const markers = comms.requestMarkerModels(medicSees, { projector });
  eq([markers.length, markers[0].kind, markers[0].name, markers[0].by], [1, 'request', 'NEED MEDIC', 'sq4'], 'a world marker over the requester');
  eq(comms.requestMarkerModels(own, { projector }).length, 0, 'no world marker over oneself');
  eq(comms.requestMapItems(own)[0].rel, 'self');

  // Radio lines and the order banner.
  const ctx = { selfId: 'me', selfTeam: 'alpha', squad: 1, kit: 'assault', players: chip.players };
  eq(comms.radioLine({ kind: 'comm', team: 'alpha', by: 'sq2', comm: 'yes', squad: 1 }, ctx), { text: 'BRANNOCK: AFFIRMATIVE', tone: 'squad' });
  eq(comms.radioLine({ kind: 'comm', team: 'alpha', by: 'tm1', comm: 'no', squad: 2 }, ctx), null, 'other squads stay off the radio');
  eq(comms.radioLine({ kind: 'comm', team: 'bravo', by: 'en1', comm: 'yes', squad: 1 }, ctx), null, 'enemies never');
  eq(comms.radioLine({ kind: 'comm', team: 'alpha', by: 'me', comm: 'ride', squad: 1, seq: 3 }, ctx).text, 'NEED RIDE SENT');
  eq(comms.radioLine({ kind: 'comm', team: 'alpha', by: 'tm1', comm: 'medic', squad: 2, seq: 4 }, ctx), null, 'an Assault skips other squads\' medic calls');
  eq(comms.radioLine({ kind: 'comm', team: 'alpha', by: 'tm1', comm: 'medic', squad: 2, seq: 4 }, { ...ctx, kit: 'medic' }).text, 'VALE: NEED MEDIC', 'a Medic hears them');
  eq(comms.radioLine({ kind: 'comm_answer', team: 'alpha', by: 'me', comm: 'ammo', seq: 7, responder: 'sq2' }, ctx).text, 'AMMO BRANNOCK RESPONDING');
  const flagC = cqOf(chip).flags.find(f => f.id === 'C');
  eq(comms.squadOrderBanner({ team: 'alpha', squad: 1, flag: 'C', by: 'sq1' }, { selfTeam: 'alpha', squad: 1, flag: flagC, now: 1 }).title, 'ATTACK C');
  eq(comms.squadOrderBanner({ team: 'alpha', squad: 2, flag: 'C', by: 'tm1' }, { selfTeam: 'alpha', squad: 1, flag: flagC }), null, 'other squads: no banner');
  eq(comms.squadOrderBanner({ team: 'alpha', squad: 1, flag: null, by: 'sq1' }, { selfTeam: 'alpha', squad: 1 }).title, 'ORDER CLEARED');

  const feed = new RadioFeed(document.body);
  for (let i = 0; i < 5; i++) feed.push({ text: `LINE ${i}`, tone: 'squad' }, 1000 + i);
  eq(feed.lines.map(l => l.text), ['LINE 2', 'LINE 3', 'LINE 4'].slice(-RADIO_LINES), 'the feed keeps the newest lines');
  feed.push({ text: 'LINE 4', tone: 'squad' }, 1100);
  eq(feed.lines.length, RADIO_LINES, 'a repeated line refreshes instead of stacking');
  feed.update(1100 + RADIO_LINE_MS + 1);
  ok(feed.root.hidden && !feed.lines.length, 'lines fade out');
}

/* ------------------------------------------------------------- HUD (DOM) */
function hudFor(f, extra = {}) {
  const sent = { comm: [], order: [], spot: 0, capture: [], radio: 0 };
  const hud = new ConquestHud(document.body, { eventTarget: dom.window, onSpot: () => { sent.spot++; },
    onComm: kind => sent.comm.push(kind), onOrder: flag => sent.order.push(flag), onCapture: c => sent.capture.push(c), onRadio: () => { sent.radio++; }, ...extra });
  hud.update(args(f));
  return { hud, sent };
}
const key = (code, type) => dom.window.dispatchEvent({ type, code, key: code, repeat: false, target: document.body });
const roseCode = defaultKeybindings().commRose[0];
eq([roseCode, bindingLabel('commRose')], ['KeyU', 'U'], 'U holds the comm rose');

// Keyboard: hold U, push the mouse up (NEED MEDIC), release: one comm intent; the capture comes and goes.
{
  const { hud, sent } = hudFor(byId('orders-rose'));
  key(roseCode, 'keydown');
  ok(hud.rose.open && isShown(hud.rose.root), 'U opens the rose');
  const capture = sent.capture.at(-1);
  ok(capture && typeof capture.move === 'function', 'the rose takes the Input UI capture');
  eq(hud.rose.hubSub.textContent, 'RELEASE TO SEND');
  eq(hud.rose.labels.map(l => l.text.textContent), ['NEED MEDIC', 'NEED AMMO', 'NEED REPAIR', 'NEED RIDE', 'AFFIRMATIVE', 'NEGATIVE', 'SPOT', 'ATTACK C']);
  capture.move(0, -70);
  eq(hud.rose.selected?.kind, 'medic', 'mouse up highlights NEED MEDIC');
  eq(hud.rose.labels[0].dataset.selected, 'true');
  key(roseCode, 'keyup');
  eq(sent.comm, ['medic'], 'releasing U sends it');
  ok(!hud.rose.open && sent.capture.at(-1) === null, 'the rose closes and releases the capture');
  // Up-left: the ORDER wedge (the server resolves the flag under the crosshair again).
  key(roseCode, 'keydown');
  sent.capture.at(-1).move(-50, -50);
  sent.capture.at(-1).press(0, 'mouse');
  eq(sent.comm, ['medic', 'order'], 'LMB sends the highlighted ORDER');
  // A release in the dead zone, a disabled wedge or Escape sends nothing.
  key(roseCode, 'keydown'); key(roseCode, 'keyup');
  key(roseCode, 'keydown'); sent.capture.at(-1).move(70, 0); key(roseCode, 'keyup');
  key(roseCode, 'keydown'); sent.capture.at(-1).move(0, -70);
  dom.window.dispatchEvent({ type: 'keydown', code: 'Escape', key: 'Escape', repeat: false, target: document.body });
  eq(sent.comm, ['medic', 'order'], 'dead zone, NEED REPAIR (disabled) and Escape send nothing');
  ok(!hud.rose.open);
  // SPOT runs the ordinary spot path.
  key(roseCode, 'keydown'); sent.capture.at(-1).move(-70, 0); key(roseCode, 'keyup');
  eq(sent.spot, 1, 'SPOT from the rose spots');
  // Not behind the menu, not while dead.
  const gated = new ConquestHud(document.body, { eventTarget: dom.window, inputEnabled: () => false, onComm: k => sent.comm.push(k) });
  gated.update(args(byId('orders-rose')));
  ok(!gated.openRose('hold'), 'no rose while gameplay input is closed');
  gated.dispose();
  hud.setDead(true);
  ok(!hud.openRose('hold'), 'no rose while dead');
  hud.dispose();
}

// A member: ORDER is disabled; the radio and the order chip follow the events.
{
  const f = byId('orders-chip');
  const { hud, sent } = hudFor(f);
  for (const ev of f.events) hud.handleEvent(ev, 'me');
  hud.update(args(f));
  ok(isShown(hud.orderChip.root), 'the order chip shows');
  eq([hud.orderChip.head.textContent, hud.orderChip.title.textContent, hud.orderChip.name.textContent], ['SQUAD ORDER', 'ATTACK C', '– IRON BRIDGE']);
  eq(hud.orderChip.root.dataset.stance, 'attack');
  eq(hud.radio.lines.map(l => l.text), ['BRANNOCK: AFFIRMATIVE', 'NEED AMMO SENT', 'AMMO BRANNOCK RESPONDING'], 'radio feed');
  ok(sent.radio >= 3, 'every radio line squelches');
  eq(hud.markers.flags.get('C').dataset.order, 'attack', 'the C marker carries the ATTACK tag');
  eq(hud.markers.flags.get('C').order.textContent, 'ATTACK');
  eq(hud.markers.flags.get('D').dataset.order, '', 'other flags carry none');
  eq(hud.root.dataset.order, 'attack');
  hud.openRose('hold');
  hud.rose.highlight(COMM_ROSE.indexOf('order'));
  hud.rose.pick();
  eq(sent.comm, [], 'a disabled ORDER never sends');
  // The minimap rings the order flag: two more arcs than the same frame without an order.
  const arcs = h => { h.minimap.context.calls.length = 0; h.update(args(h === hud ? f : plain)); return h.minimap.context.calls.filter(c => c[0] === 'arc').length; };
  const plain = { ...f, match: { ...f.match, conquest: { ...f.match.conquest, squads: [['alpha', 1, 'sq1'], ['alpha', 2, 'tm1'], ['bravo', 1, 'en1']] } } };
  const bare = hudFor(plain).hud;
  eq(arcs(hud) - arcs(bare), 2, 'the minimap draws the double order ring');
  bare.dispose();
  hud.dispose();
}

// The full map: leaders order by clicking flags (the standing flag clears), members cannot.
{
  const f = byId('orders-map');
  const { hud, sent } = hudFor(f);
  hud.toggleBigMap(true);
  hud.update(args(f));
  ok(/PICK A FLAG/.test(hud.bigMap.hint.textContent), 'the leader hint');
  eq(hud.bigMap.root.dataset.leader, 'true');
  const capture = sent.capture.at(-1);
  ok(capture && typeof capture.stick === 'function', 'the map cursor takes the capture for a leader');
  ok(hud.bigMap.map.flagHits.length === 5, 'every drawn flag is pickable');
  const d = hud.bigMap.map.flagHits.find(h => h.id === 'D');
  eq(hud.bigMap.map.flagAt(d.u, d.v), 'D');
  hud.bigMap.cursorAt = { u: d.u + 0.01, v: d.v };
  capture.press(0, 'mouse');
  eq(sent.order, ['D'], 'a click on D orders D');
  ok(!hud.bigMap.cursor.hidden, 'the cursor shows');
  const b = hud.bigMap.map.flagHits.find(h => h.id === 'B');
  hud.bigMap.cursorAt = { u: b.u, v: b.v };
  capture.press(0, 'mouse');
  eq(sent.order, ['D', ''], 'a click on the standing order flag clears it');
  capture.move(5000, 5000);
  eq(hud.bigMap.cursorAt, { u: 1, v: 1 }, 'the cursor stays on the map');
  // Pointer path (touch / unlocked mouse): the canvas pointerdown.
  hud.bigMap.map.canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 600, height: 600 });
  hud.bigMap.map.canvas.dispatchEvent({ type: 'pointerdown', clientX: d.u * 600, clientY: d.v * 600 });
  eq(sent.order, ['D', '', 'D'], 'a tap on D orders D');
  hud.toggleBigMap(false);
  eq(sent.capture.at(-1), null, 'closing the map releases the capture');
  hud.dispose();
  // A member's map: no capture, no orders.
  const member = byId('orders-chip');
  const m = hudFor(member);
  m.hud.toggleBigMap(true);
  m.hud.update(args(member));
  ok(m.sent.capture.every(c => c === null), 'members keep their aim on the map');
  ok(!m.hud.bigMap.orderFlag('D') && !m.sent.order.length, 'and order nothing');
  eq(m.hud.bigMap.hint.textContent, 'SQUAD LEADERS ORDER FROM THIS MAP');
  m.hud.dispose();
}

// Pad: a D-pad right tap spots, a hold opens the rose; the right stick picks, the release sends.
{
  const { hud, sent } = hudFor(byId('orders-rose'));
  hud.padInput({ pressed: { buy: true }, held: { buy: true } });
  hud.padInput({ pressed: {}, held: { buy: false } });
  eq([sent.spot, hud.rose.open], [1, false], 'tap: spot');
  hud.padInput({ pressed: { buy: true }, held: { buy: true } });
  hud._padRoseAt -= comms.PAD_ROSE_HOLD_MS + 10;
  hud.padInput({ pressed: {}, held: { buy: true } });
  ok(hud.rose.open, 'hold: the rose opens');
  sent.capture.at(-1).stick(0.9, 0.05, 0.016);
  eq(hud.rose.selected?.kind, 'repair', 'stick right: NEED REPAIR (disabled)');
  sent.capture.at(-1).stick(0, -0.95, 0.016);
  sent.capture.at(-1).stick(0, 0, 0.016);
  eq(hud.rose.selected?.kind, 'medic', 'a centred stick keeps the last pick');
  hud.padInput({ pressed: {}, held: { buy: false } });
  eq([sent.comm, sent.spot, hud.rose.open], [['medic'], 1, false], 'release sends NEED MEDIC, no spot');
  // Legacy callers without `held` still spot on the press.
  hud.padInput({ pressed: { buy: true } });
  eq(sent.spot, 2);
  hud.dispose();
}

// Touch: the COMMS button opens the rose in tap mode; a tap on a wedge sends.
{
  const { hud, sent } = hudFor(byId('orders-rose'));
  ok(visibleTouchActions({ alive: true, conquest: true, canFire: true }).has('comms'), 'COMMS shows on foot');
  ok(visibleTouchActions({ alive: true, conquest: true, vehicleSeated: true, vehicleType: 'jeep', vehicleRole: 'driver' }).has('comms'), 'and seated');
  ok(!visibleTouchActions({ alive: true, conquest: false }).has('comms'), 'never outside Conquest');
  ok(hud.conquestAction('comms'), 'COMMS opens the rose');
  eq([hud.rose.mode, hud.rose.hubSub.textContent], ['tap', 'TAP TO SEND']);
  hud.rose.labels[COMM_ROSE.indexOf('ride')].click();
  eq(sent.comm, ['ride'], 'a tap on NEED RIDE sends it');
  hud.conquestAction('comms');
  hud.rose.hub.click();
  ok(!hud.rose.open && sent.comm.length === 1, 'the hub closes without sending');
  hud.conquestAction('comms'); hud.conquestAction('comms');
  ok(!hud.rose.open, 'COMMS again closes it');
  hud.dispose();
}

// Request markers in the world: the Medic leader sees NEED MEDIC over Nova instead of her squad dot.
{
  const f = byId('orders-rose');
  const { hud } = hudFor(f);
  hud.update(args(f));
  const shown = hud.markers.units.filter(n => !n.hidden);
  const request = shown.find(n => n.dataset.kind === 'request');
  ok(request && /^NEED MEDIC 3\d m$/.test(request.label.textContent), 'NEED MEDIC 34 m');
  eq(request.dataset.comm, 'medic');
  ok(!shown.some(n => n.dataset.kind === 'squad' && n.label.textContent === 'Nova'), 'her squad dot gives way to the request');
  const texts = textsDrawn(hud.minimap.context);
  ok(Array.isArray(texts), 'minimap drew');
  hud.dispose();
}

/* ------------------------------------------------------------- Input seam */
{
  const input = new Input({});
  input.fallback = true; input._locked = true; input._focused = true;
  input.setGameplayEnabled?.(true);
  const moves = [], presses = [];
  input.setUiCapture({ move: (dx, dy, source) => moves.push([dx, dy, source]), press: (button, source) => presses.push([button, source]) });
  ok(input.uiCaptured, 'captured');
  input._onMouseMove({ movementX: 12, movementY: -7 });
  eq(moves, [[12, -7, 'mouse']], 'locked mouse pixels steer the overlay');
  const look = input.consumeDelta();
  eq([look.dx, look.dy], [0, 0], 'the camera does not turn');
  input._onMouseDown({ button: 0, isTrusted: true, preventDefault() {} });
  eq(presses, [[0, 'mouse']], 'LMB reaches the overlay');
  eq(input.wantFireHeld, false, 'and never fires');
  input._onTouchLook(30, 0);
  eq(input.consumeDelta().dx, 0, 'touch look is frozen too');
  input.setUiCapture(null);
  ok(!input.uiCaptured);
  input._onMouseMove({ movementX: 12, movementY: 0 });
  ok(input.consumeDelta().dx > 0, 'released: the mouse turns the camera again');
  input.dispose?.();
}

console.log(`Conquest orders UI: ${checks} checks passed (order chip, rose segments and wedge pick, request audience and markers, radio feed and banners, U hold / release, pad tap vs hold, touch COMMS, full-map leader orders, Input UI capture).`);
