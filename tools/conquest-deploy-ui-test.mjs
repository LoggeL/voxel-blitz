// Conquest deploy screen (WP7): spawn options from the shared deployOptions,
// kit picker with variant, countdown to respawnAt, Deploy -> onDeploy choice,
// deploy_refused feedback, killer card, the touch DEPLOY button and the
// spectator overlay it replaces. Fake DOM, no browser.
import assert from 'node:assert/strict';
import { installFakeDom, isShown } from './lib/conquest-ui-dom.mjs';
import { CONQUEST_RULES, KIT_IDS, KITS } from '../shared/conquest-contract.js';
import { deployOptions, deployViewFromSnapshot, resolveDeployChoice } from '../shared/conquest.js';
import { decodeConquestPlayer } from '../shared/conquest-contract.js';

const dom = installFakeDom({ width: 1440, height: 900 });
const { document } = dom;
const state = await import('../public/js/ui/conquest-hud-state.js');
const { ConquestHud } = await import('../public/js/ui/conquest-hud.js');
const { DeployScreen } = await import('../public/js/ui/conquest/deploy-screen.js');
const { SpectatorHud } = await import('../public/js/ui/spectator-hud.js');
const { TouchControls, visibleTouchActions, CONQUEST_TOUCH_EVENT } = await import('../public/js/engine/touch-controls.js');
const { cameraPose } = await import('../public/js/ui/conquest/projection.js');
const { WEAPON_NAMES } = await import('../public/js/ui/hud-support.js');
const { conquestHudFixtures, fixtureMapMeta, FIXTURE_NOW } = await import('../public/js/capture/conquest-hud-fixtures.js');

const fixtures = conquestHudFixtures();
const mapMeta = fixtureMapMeta();
const fixture = id => fixtures.find(f => f.id === id);
const deploy = fixture('deploy'), refusedFixture = fixture('deploy-refused');
const cqOf = f => state.readConquest(f.match, mapMeta);
let groups = 0;

/* --------------------------------------------------------- pure model */

{
  const model = state.deployModel({ cq: cqOf(deploy), self: deploy.self, players: deploy.players, vehicles: deploy.vehicles,
    nowMs: FIXTURE_NOW, selection: deploy.selection });
  const summary = Object.fromEntries(model.options.map(o => [o.spawn, o.ok ? 'ok' : o.reason]));
  assert.deepEqual(summary, {
    hq: 'ok', 'flag:A': 'ok', 'flag:B': 'contested', 'squad:sq1': 'ok', 'squad:sq2': 'ok',
    'vehicle:alpha-tank': 'ok', 'vehicle:alpha-helicopter': 'ok',
  }, 'HQ, held flags (B is being neutralized), squadmates and hulls with free seats');
  // The HUD lists exactly what the shared validator (also used by the server) returns.
  const shared = deployOptions(deployViewFromSnapshot(cqOf(deploy), deploy.players, deploy.vehicles, decodeConquestPlayer),
    { id: 'me', team: 'alpha', squad: 1 });
  assert.deepEqual(model.options.map(o => [o.spawn, o.ok, o.reason]), shared.map(o => [o.spawn, o.ok, o.reason]));
  assert.equal(model.options.find(o => o.spawn === 'flag:B').reasonText, 'FLAG IS CONTESTED OR BEING NEUTRALIZED');
  assert.deepEqual(model.options.find(o => o.spawn === 'vehicle:alpha-helicopter').seats, ['gunner']);
  assert.equal(model.options.find(o => o.kind === 'hq').label, 'WEST HQ');
  assert.equal(model.spawn, 'flag:A'); assert.equal(model.valid, true); assert.equal(model.selectedKey, 'flag:A');
  assert.equal(model.waitMs, 3200); assert.equal(model.countdown, '3.2'); assert.equal(model.ready, false, 'not before respawnAt');
  assert.equal(model.timeoutMs, 3200 + CONQUEST_RULES.deployTimeoutMs);
  assert.deepEqual(model.choice, { spawn: 'flag:A', kit: 'engineer', variant: 1 });
  assert.deepEqual(model.kits.map(k => k.id), KIT_IDS);
  const engineer = model.kits.find(k => k.id === 'engineer');
  assert.equal(engineer.selected, true); assert.deepEqual(engineer.primaries.map(p => p.selected), [false, true]);
  assert.equal(engineer.gadget, WEAPON_NAMES.rocket, 'the engineer gadget is the AT rocket');
  assert.deepEqual(engineer.grenades, Object.entries(KITS.engineer.grenades).map(([t, n]) => `${n}× ${t.toUpperCase()}`));

  // A refused choice, a stale selection and a vehicle seat.
  const refused = state.deployModel({ cq: cqOf(deploy), self: deploy.self, players: deploy.players, vehicles: deploy.vehicles, nowMs: FIXTURE_NOW,
    selection: { spawn: 'flag:B', kit: 'assault' } });
  assert.equal(refused.valid, false); assert.equal(refused.reason, 'contested'); assert.equal(refused.reasonText, 'FLAG IS CONTESTED OR BEING NEUTRALIZED');
  const stale = state.deployModel({ cq: cqOf(deploy), self: deploy.self, players: deploy.players, vehicles: deploy.vehicles, selection: { spawn: 'flag:D' } });
  assert.equal(stale.spawn, 'hq', 'an option that no longer exists falls back to HQ');
  const seat = state.deployModel({ cq: cqOf(refusedFixture), self: refusedFixture.self, players: refusedFixture.players, vehicles: refusedFixture.vehicles,
    nowMs: FIXTURE_NOW, selection: refusedFixture.selection, refused: 'contested' });
  assert.equal(seat.seatId, 'commander'); assert.equal(seat.valid, true); assert.equal(seat.ready, true, 'respawnAt passed');
  assert.equal(seat.down, true); assert.equal(seat.refused.text, 'FLAG IS CONTESTED OR BEING NEUTRALIZED');
  const full = { ...deploy.vehicles[0], seatOccupants: { driver: 'tm1', commander: 'tm2' } };
  const noSeat = state.deployModel({ cq: cqOf(deploy), self: deploy.self, players: deploy.players, vehicles: [full], selection: { spawn: 'vehicle:alpha-tank' } });
  assert.equal(noSeat.options.find(o => o.kind === 'vehicle').reason, 'seat'); assert.equal(noSeat.valid, false);
  assert.equal(resolveDeployChoice(seat.options, 'vehicle:alpha-tank:driver').ok, true);
  for (const reason of ['invalid', 'contested', 'enemy', 'busy', 'cooldown', 'seat']) assert.ok(state.DEPLOY_REFUSED_TEXT[reason], `${reason} has text`);
  groups++;
}

/* --------------------------------------------------------- deploy screen */

// Opening the screen frees the pointer once (a locked pointer hides the cursor).
{
  let opened = 0;
  const screen = new DeployScreen(document.createElement('div'), { onOpen: () => opened++ });
  screen.setOpen(true);
  screen.setOpen(true);
  assert.equal(opened, 1, 'onOpen fires on the closed -> open edge only');
  screen.setOpen(false);
  screen.setOpen(true);
  assert.equal(opened, 2, 'reopening after the next death frees the pointer again');
  groups++;
}

{
  const sent = [];
  const parent = document.createElement('div');
  const screen = new DeployScreen(parent, { onDeploy: choice => sent.push(choice) });
  screen.selection = { ...screen.selection, ...deploy.selection };
  screen.setOpen(true, deploy.killer);
  const items = state.mapItems({ cq: cqOf(deploy), self: deploy.self, players: deploy.players, vehicles: deploy.vehicles, selfTeam: 'alpha' });
  const update = (extra = {}) => screen.update({ cq: cqOf(deploy), self: deploy.self, players: deploy.players, vehicles: deploy.vehicles,
    nowMs: FIXTURE_NOW, mapItems: items, meta: mapMeta.conquest, ...extra });
  update();
  assert.equal(screen.root.hidden, false);
  assert.equal(screen.killerTitle.textContent, 'KILLED BY'); assert.equal(screen.killerName.textContent, 'ROURKE');
  assert.equal(screen.killerDetail.textContent, '120MM AP · 142 M');
  const rows = screen.spawnList.querySelectorAll('.cq-spawn');
  assert.equal(rows.length, 7);
  const flagB = rows.find(b => b.dataset.kind === 'flag' && b.textContent.startsWith('BFLAG B'));
  assert.equal(flagB.disabled, true); assert.ok(flagB.textContent.includes('FLAG IS CONTESTED'));
  assert.equal(rows.find(b => b.getAttribute('aria-selected') === 'true').textContent.startsWith('AFLAG A'), true);
  assert.equal(screen.spawnList.querySelectorAll('.cq-spawn-seat').length, 2, 'tank lists its two free seats');
  assert.equal(screen.button.textContent, 'DEPLOY · FLAG A · 3.2');
  assert.equal(screen.kits.querySelectorAll('.cq-kit').length, 4);
  // The deploy map paints every spawn and is pickable.
  assert.equal(screen.map.spawnHits.length, 7);

  screen.button.click();
  assert.deepEqual(sent, [{ spawn: 'flag:A', kit: 'engineer', variant: 1 }], 'Deploy sends {spawn, kit, variant}');
  assert.equal(screen.button.textContent, 'DEPLOYING IN 3.2');
  // A change while readied is re-sent so the server holds the latest choice.
  screen.kits.querySelectorAll('.cq-kit-pick').find(b => b.textContent.startsWith('RECON')).click();
  update();
  assert.deepEqual(sent.at(-1), { spawn: 'flag:A', kit: 'recon', variant: 1 });
  assert.equal(dom.storage.getItem('vb-conquest-kit'), 'recon', 'kit choice persists');
  screen.kits.querySelectorAll('.cq-kit-variant').find(b => b.textContent && b.parentNode.parentNode.dataset.kit === 'recon' && b.classList.contains('is-selected') === false).click();
  update();
  assert.equal(sent.at(-1).variant, 0);
  screen.spawnList.querySelectorAll('.cq-spawn-seat').find(b => b.textContent === 'CMDR').click();
  update();
  assert.equal(sent.at(-1).spawn, 'vehicle:alpha-tank:commander');
  // A change the client rate limiter refuses (onDeploy -> false) stays pending
  // and is re-sent on a later update instead of silently keeping the old kit.
  const passThrough = screen.onDeploy;
  let limited = true;
  screen.onDeploy = choice => (limited ? false : passThrough(choice));
  screen.select({ kit: 'assault' });
  const beforeLimit = sent.length;
  update();
  assert.equal(sent.length, beforeLimit, 'the limited send reached nobody');
  assert.equal(screen._resend, true, 'the refused send stays pending');
  limited = false;
  update();
  assert.equal(sent.at(-1).kit, 'assault', 'the pending choice is re-sent once the limiter allows it');
  assert.equal(screen._resend, false);
  screen.onDeploy = passThrough;

  // deploy_refused: back to choosing with the reason.
  screen.refuse('enemy');
  update();
  assert.equal(screen.status.textContent, 'REFUSED · ENEMIES IN THE ZONE'); assert.equal(screen.status.dataset.tone, 'warn');
  assert.equal(screen.readied, false); assert.equal(screen.button.textContent, 'DEPLOY · TANK · 3.2');
  // Choosing an unavailable spawn disables the button.
  screen.select({ spawn: 'flag:B' });
  update();
  assert.equal(screen.button.disabled, true); assert.equal(screen.button.textContent, 'SPAWN UNAVAILABLE');
  const before = sent.length;
  assert.equal(screen.deploy(), false); assert.equal(sent.length, before, 'an invalid choice is never sent');
  // Time passes: countdown done, auto-deploy timer shown.
  screen.select({ spawn: 'hq' });
  update({ nowMs: FIXTURE_NOW + 4000 });
  assert.equal(screen.button.textContent, 'DEPLOY · WEST HQ');
  assert.equal(screen.status.textContent, `AUTO-DEPLOY IN ${Math.ceil((CONQUEST_RULES.deployTimeoutMs - 800) / 1000)} S`);
  groups++;
}

/* --------------------------------------- ConquestHud: dead -> deploy -> alive */

{
  const sent = [];
  const hud = new ConquestHud(document.body, { onDeploy: c => sent.push(c), eventTarget: dom.window });
  hud.deploy.selection = { spawn: 'hq', kit: 'support', variant: 0 };
  const alive = { ...deploy.self, hp: 100, state: 'alive', x: 300, z: 300 };
  const args = self => ({ match: deploy.match, mapMeta, self, players: [self, ...deploy.players.slice(1)], vehicles: deploy.vehicles, nowMs: FIXTURE_NOW,
    camera: cameraPose({ ...deploy.camera, aspect: 1.6 }), viewport: { width: 1440, height: 900 } });
  hud.update(args(alive));
  assert.equal(hud.deploy.open, false);
  assert.deepEqual(hud.touchContextFields(), { ...state.CONQUEST_TOUCH_DEFAULTS, conquest: true, deployOpen: false },
    'every touch key is present so a persistent context never keeps a stale one');
  // The kill arrives, then the dead row: the deploy screen opens with the killer card.
  hud.handleEvent({ kind: 'kill', killer: 'en1', victim: 'me', w: 'sniper', hs: true }, 'me');
  hud.update(args(deploy.self));
  assert.equal(hud.dead, true); assert.equal(hud.deploy.open, true); assert.equal(isShown(hud.deploy.root), true);
  assert.equal(hud.deploy.killerName.textContent, 'ROURKE'); assert.ok(hud.deploy.killerDetail.textContent.includes('HEADSHOT'));
  assert.equal(hud.minimap.root.hidden, true); assert.equal(hud.ring.root.hidden, true);
  assert.deepEqual(hud.touchContextFields(), { ...state.CONQUEST_TOUCH_DEFAULTS, conquest: true, deployOpen: true, deployValid: true, deployLabel: 'DEPLOY 3.2' });
  // Touch DEPLOY (vb-conquest-action) and Enter both deploy.
  dom.window.dispatchEvent({ type: CONQUEST_TOUCH_EVENT, detail: { action: 'deploy' } });
  assert.deepEqual(sent, [{ spawn: 'hq', kit: 'support', variant: 0 }]);
  dom.window.dispatchEvent({ type: 'keydown', key: 'Enter', code: 'Enter', repeat: false, target: document.body });
  assert.equal(sent.length, 2);
  hud.handleEvent({ kind: 'deploy_refused', id: 'me', reason: 'cooldown' }, 'me');
  hud.update(args(deploy.self));
  assert.equal(hud.deploy.status.textContent, 'REFUSED · SQUAD SPAWN COOLING DOWN');
  hud.handleEvent({ kind: 'deploy_refused', id: 'someone-else', reason: 'seat' }, 'me');
  hud.update(args(deploy.self));
  assert.equal(hud.deploy.status.textContent, 'REFUSED · SQUAD SPAWN COOLING DOWN', 'only own refusals');
  // M does nothing while dead; the deploy map stays.
  dom.window.dispatchEvent({ type: 'keydown', key: 'm', code: 'KeyM', repeat: false, target: document.body });
  assert.equal(hud.bigMap.open, false);
  // Spawned: the screen closes and the HUD returns.
  hud.update(args(alive));
  assert.equal(hud.dead, false); assert.equal(hud.deploy.open, false); assert.equal(hud.minimap.root.hidden, false);
  assert.equal(hud.killerInfo, null, 'a new life forgets the killer');
  // Match end: no deploy screen over the result.
  hud.update({ ...args(deploy.self), match: { ...deploy.match, phase: 'post', winner: 'bravo' } });
  assert.equal(hud.deploy.open, false); assert.equal(hud.banners.title.textContent, 'DEFEAT');
  hud.dispose();
  assert.equal(dom.window.listenerCount(CONQUEST_TOUCH_EVENT), 0, 'dispose removes the touch listener');
  groups++;
}

/* -------------------------------------------- spectator overlay replaced */

{
  const spectator = new SpectatorHud();
  const hudRoot = document.createElement('div');
  spectator.build(hudRoot);
  spectator.setState({ active: true, hasTarget: true, targetName: 'Rourke' });
  assert.equal(spectator.dom.root.classList.contains('hidden'), false);
  spectator.setSuppressed(true);
  assert.equal(spectator.dom.root.classList.contains('hidden'), true, 'Conquest deploy screen replaces the spectator overlay');
  spectator.setState({ active: true, hasTarget: true });
  assert.equal(spectator.dom.root.classList.contains('hidden'), true, 'stays hidden whatever the camera reports');
  spectator.setSuppressed(false);
  assert.equal(spectator.dom.root.classList.contains('hidden'), false);
  spectator.dispose();
  groups++;
}

/* ------------------------------------------------- touch DEPLOY button */

{
  assert.deepEqual([...visibleTouchActions({ deployOpen: true, alive: false })], ['deploy'], 'the deploy screen shows one DEPLOY button');
  const touch = new TouchControls({ documentRef: document });
  touch.mount(document.body);
  touch.setEnabled(true);
  touch.setSpectating(true);
  touch.setContext({ alive: false, deployOpen: true, deployValid: true, deployLabel: 'DEPLOY 3.2' });
  assert.equal(touch.dom.deploy.classList.contains('is-hidden'), false, 'visible even while spectating');
  assert.equal(touch.dom.deploy.textContent, 'DEPLOY 3.2');
  assert.equal(document.documentElement.classList.contains('vb-touch-deploying'), true, 'the panel button yields to the touch button');
  const actions = [];
  const listener = event => actions.push(event.detail.action);
  dom.window.addEventListener(CONQUEST_TOUCH_EVENT, listener);
  const press = (button, id) => {
    button.dispatchEvent({ type: 'pointerdown', pointerId: id, clientX: 0, clientY: 0 });
    button.dispatchEvent({ type: 'pointerup', pointerId: id, clientX: 0, clientY: 0 });
  };
  press(touch.dom.deploy, 7);
  assert.deepEqual(actions, ['deploy']);
  touch.setEnabled(false);
  assert.equal(document.documentElement.classList.contains('vb-touch-deploying'), false, 'disabled controls give the panel its button back');
  touch.setEnabled(true);
  touch.setContext({ alive: true, conquest: true, canFire: true });
  assert.equal(touch.dom.deploy.classList.contains('is-hidden'), true);
  // onConquest replaces the window event when the integrator passes it.
  const direct = [];
  const routed = new TouchControls({ documentRef: document, onConquest: action => direct.push(action) });
  routed.mount(document.body); routed.setEnabled(true);
  routed.setContext({ alive: true, conquest: true });
  press(routed.dom.spot, 9);
  assert.deepEqual(direct, ['spot']); assert.deepEqual(actions, ['deploy']);
  routed.dispose(); touch.dispose();
  dom.window.removeEventListener(CONQUEST_TOUCH_EVENT, listener);
  groups++;
}

dom.restore();
console.log(`Conquest deploy UI: ${groups} groups passed (shared deploy options, kit picker, refusals, killer card, touch DEPLOY, spectator hand-off, pointer release)`);
