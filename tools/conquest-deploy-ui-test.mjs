// Conquest deploy screen (WP7): spawn options from the shared deployOptions,
// kit picker with variant, countdown to respawnAt, Deploy -> onDeploy choice,
// deploy_refused feedback, killer card, the touch DEPLOY button and the
// spectator overlay it replaces. Fake DOM, no browser.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installFakeDom, isShown } from './lib/conquest-ui-dom.mjs';
import { CONQUEST_RULES, KIT_IDS, KITS } from '../shared/conquest-contract.js';
import { deployOptions, deployViewFromSnapshot, resolveDeployChoice } from '../shared/conquest.js';
import { decodeConquestPlayer } from '../shared/conquest-contract.js';
import { KIT_MENU_ORDER, KIT_ROLE_RULES } from '../shared/conquest-kits.js';

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
  assert.deepEqual(model.choice, { spawn: 'flag:A', kit: 'engineer', variant: 1, gadget: 0 }, 'the engineer choice carries its gadget (AT by default)');
  assert.deepEqual(model.kits.map(k => k.id), KIT_MENU_ORDER, 'class cards follow the menu order (wire order is KIT_IDS)');
  assert.deepEqual([...model.kits.map(k => k.id)].sort(), [...KIT_IDS].sort());
  assert.deepEqual(model.kits.filter(k => !k.unlocked).map(k => k.id), ['pyro', 'grenadier', 'raider', 'marksman'], 'without kit_unlocks only base kits are open');
  const engineer = model.kits.find(k => k.id === 'engineer');
  assert.equal(engineer.selected, true); assert.deepEqual(engineer.primaries.map(p => p.selected), [false, true]);
  assert.equal(engineer.gadget, WEAPON_NAMES.rocket, 'the engineer gadget is the AT rocket');
  assert.deepEqual(engineer.gadgets.map(g => [g.weapon, g.role, g.selected]), [['rocket', 'AT', true], ['stinger', 'AA', false]],
    'the engineer card offers the AT launcher and the STINGER');
  assert.deepEqual(model.kits.filter(k => k.id !== 'engineer').map(k => k.gadgets.length), [0, 0, 0, 0, 0, 0, 0, 0], 'other kits have no gadget choice');
  const aa = state.deployModel({ cq: cqOf(deploy), self: deploy.self, players: deploy.players, vehicles: deploy.vehicles,
    nowMs: FIXTURE_NOW, selection: { ...deploy.selection, gadget: 1 } });
  assert.deepEqual(aa.choice, { spawn: 'flag:A', kit: 'engineer', variant: 1, gadget: 1 });
  assert.equal(aa.kits.find(k => k.id === 'engineer').gadget, WEAPON_NAMES.stinger);
  const assaultAa = state.deployModel({ cq: cqOf(deploy), self: deploy.self, players: deploy.players, vehicles: deploy.vehicles,
    nowMs: FIXTURE_NOW, selection: { spawn: 'hq', kit: 'assault', gadget: 1 } });
  assert.deepEqual(assaultAa.choice, { spawn: 'hq', kit: 'assault', variant: 0 }, 'a kit without a gadget choice never sends one');
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
  assert.equal(screen.kits.querySelectorAll('.cq-kit').length, 9);
  assert.equal(screen.kits.querySelectorAll('.cq-kit.is-locked').length, 4, 'four level unlocks are locked at level 1');
  assert.equal(screen.kits.querySelectorAll('.cq-kit-row').length, 2, 'base row and unlocks row');
  // A locked card never selects: it names its unlock level instead.
  const lockedPick = screen.kits.querySelectorAll('.cq-kit-pick').find(b => b.textContent.startsWith('GRENADIER'));
  assert.equal(lockedPick.getAttribute('aria-disabled'), 'true');
  lockedPick.click();
  assert.equal(screen.selection.kit, 'engineer', 'a locked class is not selectable');
  // The note lands in the class info line beside the cards (a phone sees it where it tapped),
  // never in the header status, which keeps the revive / refusal / auto-deploy texts.
  assert.equal(screen.kitInfo.textContent, 'GRENADIER UNLOCKS AT LV 5');
  assert.equal(screen.kitInfo.dataset.tone, 'warn');
  assert.equal(screen.status.textContent, '', 'a locked tap never takes over the status line');
  // It fades on its own and is gone when the screen opens again.
  screen.lockNoteUntil = 0; update();
  assert.ok(screen.kitInfo.textContent.startsWith('ENGINEER · REPAIR — '), `info line falls back to the selected class (${screen.kitInfo.textContent})`);
  screen.lockedPick(screen.model.kits.find(card => card.id === 'raider'));
  screen.setOpen(false); screen.setOpen(true, deploy.killer); update();
  assert.equal(screen.lockNote, null, 'reopening the deploy screen clears a locked-class note');
  // Hover or keyboard / gamepad focus explains a class; numbers come from the kit tables.
  screen.hoverKit('medic');
  assert.ok(screen.kitInfo.textContent.startsWith('MEDIC · REVIVE · HEAL — '), screen.kitInfo.textContent);
  assert.ok(screen.kitInfo.textContent.includes(`${KIT_ROLE_RULES.healRadius} M`), 'the Medic hint states the aura radius from KIT_ROLE_RULES');
  screen.hoverKit('marksman');
  assert.ok(screen.kitInfo.textContent.startsWith('MARKSMAN · UNLOCKS AT LV 9 — '), screen.kitInfo.textContent);
  screen.hoverKit(null);
  screen.select({});
  // LB / RB skip locked classes.
  const stepped = [];
  for (let i = 0; i < 10; i++) { screen.step('kit', 1); stepped.push(screen.selection.kit); }
  assert(stepped.every(kit => ['assault', 'medic', 'engineer', 'support', 'recon'].includes(kit)), `stepping skips locked kits (${stepped})`);
  screen.select({ kit: 'engineer', variant: 1, gadget: 0 });
  // kit_unlocks opens the Pyro card.
  screen.setUnlocks(state.kitUnlockState({ level: 3, unlocked: ['assault', 'medic', 'engineer', 'support', 'recon', 'pyro'] }));
  assert.equal(screen.kits.querySelectorAll('.cq-kit.is-locked').length, 3, 'level 3 opens the Pyro');
  // A level-up's `newly` kits carry a NEW tag on the picker until picked.
  screen.markNew(['pyro']);
  assert.equal(screen.kits.querySelectorAll('.cq-kit-new').length, 1, 'the new Pyro card is tagged NEW');
  // Unlocked while this screen is open (no HUD banner): the header status names it too,
  // since phones keep the header in view but not the UNLOCKS row.
  update();
  assert.equal(screen.status.textContent, 'NEW CLASS · PYRO', 'an unlock while the screen is open leads the header status');
  assert.equal(screen.status.dataset.tone, 'new');
  screen.select({ kit: 'pyro' }); update();
  assert.equal(screen.kits.querySelectorAll('.cq-kit-new').length, 0, 'picking the new class clears its tag');
  assert.equal(screen.status.textContent, '', 'picking the new class clears the status note');
  assert.notEqual(screen.status.dataset.tone, 'new');
  // An unlock from before this screen opened (the alive banner announced it) keeps only the NEW tag.
  screen.setOpen(false); screen.markNew(['pyro']); screen.setOpen(true, deploy.killer); update();
  assert.equal(screen.kits.querySelectorAll('.cq-kit-new').length, 1);
  assert.equal(screen.status.textContent, '', 'an unlock announced by the banner is not repeated in the status');
  // A note opened while open survives the auto-deploy timer, and a refusal takes the line to itself.
  screen.markNew(['pyro']); update({ nowMs: FIXTURE_NOW + 4000 });
  assert.equal(screen.status.textContent, `NEW CLASS · PYRO · AUTO-DEPLOY IN ${Math.ceil((CONQUEST_RULES.deployTimeoutMs - 800) / 1000)} S`);
  screen.refuse('enemy'); update();
  assert.equal(screen.status.textContent, 'REFUSED · ENEMIES IN THE ZONE'); assert.equal(screen.status.dataset.tone, 'warn');
  screen.refused = null; screen.select({ kit: 'pyro' }); update();
  screen.select({ kit: 'engineer', variant: 1, gadget: 0 });
  screen.setUnlocks(state.kitUnlockState(null));
  // The deploy map paints every spawn and is pickable.
  assert.equal(screen.map.spawnHits.length, 7);

  screen.button.click();
  assert.deepEqual(sent, [{ spawn: 'flag:A', kit: 'engineer', variant: 1, gadget: 0 }], 'Deploy sends {spawn, kit, variant, gadget}');
  // The gadget toggle (AT / AA) on the engineer card re-sends the choice with the STINGER.
  const gadgetButtons = screen.kits.querySelectorAll('.cq-kit-gadget');
  assert.deepEqual(gadgetButtons.map(b => b.dataset.gadget), ['rocket', 'stinger'], 'only the engineer card shows the gadget toggle');
  gadgetButtons[1].click();
  update();
  assert.deepEqual(sent.at(-1), { spawn: 'flag:A', kit: 'engineer', variant: 1, gadget: 1 }, 'picking the STINGER re-sends gadget 1');
  assert.equal(dom.storage.getItem('vb-conquest-kit-gadget'), '1', 'gadget choice persists');
  assert.equal(screen.kits.querySelector('.cq-kit-gadget.is-selected').dataset.gadget, 'stinger');
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
  {
    // A class unlocked while the deploy screen is open: no HUD banner over its spawns and cards (NEW-1);
    // the UNLOCKS header names it in the screen's own flow and the card carries the NEW tag.
    const pushed = [];
    const push = hud.banners.push.bind(hud.banners);
    hud.banners.push = (...a) => { pushed.push(a[0]?.title); return push(...a); };
    hud.handleEvent({ kind: 'kit_unlocks', id: 'me', level: 5, unlocked: ['assault', 'medic', 'engineer', 'support', 'recon', 'pyro', 'grenadier'], newly: ['grenadier'] }, 'me');
    hud.update(args(deploy.self));
    assert.deepEqual(pushed, [], 'no unlock banner while the deploy screen is open');
    const unlockHead = hud.deploy.kits.querySelector('.cq-deploy-section-unlock');
    assert.equal(unlockHead.querySelector('.cq-deploy-section-new')?.textContent, 'NEW CLASS · GRENADIER', 'the UNLOCKS header names the new class');
    assert.ok(hud.deploy.status.textContent.startsWith('NEW CLASS · GRENADIER'), `the header status names it as well (${hud.deploy.status.textContent})`);
    assert.equal(hud.deploy.kits.querySelector('.cq-deploy-section-base .cq-deploy-section-new'), null, 'the base header has no news');
    hud.banners.push = push;
    hud.deploy.setUnlocks(state.kitUnlockState(null)); hud.deploy.newKits.clear();
    const css = readFileSync(new URL('../public/styles/conquest.css', import.meta.url), 'utf8');
    assert.match(css, /:has\(\.cq-deploy:not\(\[hidden\]\)\) \.cq-banner \{ visibility: hidden; \}/, 'banners stay hidden under an open deploy screen');
    assert.doesNotMatch(css, /\.cq-banner \{ z-index: 7/, 'no banner is lifted above the deploy screen');
  }
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

/* ------------------------------ classes HUD: adrenaline, heal tick, unlocks */

{
  const hud = new ConquestHud(document.body, { eventTarget: dom.window });
  let t = FIXTURE_NOW;
  // The deploy fixture's self is an Engineer: this one is an Assault (cq[0] = 0).
  const row = (medkit, extra = {}) => ({ ...deploy.self, cq: [0, ...deploy.self.cq.slice(1)], hp: 100, state: 'alive', x: 300, z: 300, medkit: { remaining: medkit }, ...extra });
  const frame = self => { t += 50; hud.update({ match: deploy.match, mapMeta, self, players: [self, ...deploy.players.slice(1)], vehicles: deploy.vehicles,
    nowMs: t, camera: cameraPose({ ...deploy.camera, aspect: 1.6 }), viewport: { width: 1440, height: 900 } }); };
  const flashed = () => isShown(hud.spotFlash) && hud.spotFlash.textContent.startsWith('ADRENALINE');
  assert.equal(decodeConquestPlayer(row(1)).kit, 'assault');
  // Spent medkit, death, respawn with a fresh medkit: no ADRENALINE.
  frame(row(0)); frame({ ...deploy.self }); frame(row(1)); frame(row(1));
  assert.equal(flashed(), false, 'a respawn refill is not adrenaline');
  // A Medic aura restock (0 -> 1 with no own kill): no ADRENALINE.
  frame(row(0)); frame(row(1)); frame(row(1));
  assert.equal(flashed(), false, 'a Medic restock is not adrenaline');
  // An own enemy kill with the re-arm: the flash shows, in either arrival order.
  frame(row(0));
  hud.handleEvent({ kind: 'kill', killer: 'me', victim: 'en2', w: 'rifle' }, 'me');
  frame(row(1));
  assert.equal(flashed(), true, 'kill + re-arm reads as ADRENALINE');
  t += 4000; frame(row(1));
  frame(row(0)); frame(row(1));
  hud.handleEvent({ kind: 'kill', killer: 'me', victim: 'en3', w: 'rifle' }, 'me');
  frame(row(1));
  assert.equal(flashed(), true, 'the row may land before the kill event');
  // Heal ticks keep the half HP of a self-heal pulse.
  hud.handleEvent({ kind: 'heal', id: 'me', by: 'me', hp: 2.5 }, 'me');
  assert.equal(hud.healTick.textContent, '+2.5 HP');
  hud.handleEvent({ kind: 'heal', id: 'me', by: 'm', hp: 5 }, 'me');
  assert.equal(hud.healTick.textContent, '+7.5 HP');
  // kit_unlocks: replayed twice (boot buffer + snapshot drain) it banners once; newly tags the card NEW.
  const unlock = { kind: 'kit_unlocks', id: 'me', level: 3, unlocked: ['assault', 'medic', 'engineer', 'support', 'recon', 'pyro'], newly: ['pyro'] };
  const pushes = [];
  const push = hud.banners.push.bind(hud.banners);
  hud.banners.push = (...a) => { pushes.push(a[0]?.title); return push(...a); };
  hud.handleEvent(unlock, 'me'); hud.handleEvent(unlock, 'me');
  assert.deepEqual(pushes, ['NEW CLASS UNLOCKED · PYRO'], 'one banner per kit_unlocks event');
  assert.ok(hud.kitUnlocks.unlocked.has('pyro'));
  assert.ok(hud.deploy.newKits.has('pyro'), 'the new class is tagged on the picker');
  // The join announcement of a veteran carries no `newly`: no banner at all.
  hud.handleEvent({ kind: 'kit_unlocks', id: 'me', level: 9, unlocked: KIT_IDS.slice(), newly: [] }, 'me');
  assert.equal(pushes.length, 1, 'a veteran joining gets no NEW CLASSES banner');
  hud.dispose();
  groups++;
}

/* ------------------------- class picker layout is the same for every pick (R1-8) */

{
  const parent = document.createElement('div');
  const screen = new DeployScreen(parent, {});
  screen.selection = { ...screen.selection, ...deploy.selection };
  screen.setOpen(true, deploy.killer);
  screen.setUnlocks(state.kitUnlockState({ level: 3, unlocked: ['assault', 'medic', 'engineer', 'support', 'recon', 'pyro'] }));
  const update = () => screen.update({ cq: cqOf(deploy), self: deploy.self, players: deploy.players, vehicles: deploy.vehicles,
    nowMs: FIXTURE_NOW, mapItems: [], meta: mapMeta.conquest });
  // Per pick: the order of the strip's blocks, every card's children, and the loadout slot's rows.
  const shape = () => ({
    blocks: screen.kits.children.map(n => n.className.split(' ')[0] + (n.className.includes('section-') ? `:${n.className.split('section-')[1]}` : '')),
    cards: screen.kits.querySelectorAll('.cq-kit').map(card => `${card.dataset.kit}:${card.children.map(c => c.className).join('+')}`),
    loadout: screen.kits.querySelector('.cq-kit-loadout').children.map(c => c.className.replace(/\s*is-placeholder/, '')),
  });
  const shapes = {};
  for (const kit of ['assault', 'medic', 'engineer', 'support', 'recon', 'pyro']) {
    screen.select({ kit }); update();
    assert.equal(screen.kits.querySelector('.cq-kit-loadout').dataset.kit, kit, `the loadout slot shows the picked ${kit}`);
    assert.equal(screen.kits.querySelectorAll('.cq-kit .cq-kit-variant').length, 0, 'no card carries toggles: they live in the one loadout slot');
    assert.equal(screen.kits.querySelectorAll('.cq-kit-loadout .cq-kit-variant').length, 2, `${kit}: two primaries`);
    shapes[kit] = shape();
  }
  for (const kit of Object.keys(shapes)) assert.deepEqual(shapes[kit], shapes.assault, `picking ${kit} leaves the strip's structure (and so its height) unchanged`);
  assert.deepEqual(shapes.assault.blocks, ['cq-deploy-section:base', 'cq-kit-row', 'cq-kit-loadout', 'cq-kit-info', 'cq-deploy-section:unlock', 'cq-kit-row'],
    'loadout slot under the base row, then the info line and the unlocks');
  assert.deepEqual(shapes.assault.loadout, ['cq-kit-loadout-name', 'cq-kit-variants', 'cq-kit-gadgets', 'cq-kit-gear'],
    'a class without a gadget choice keeps a (hidden) gadget row while the Engineer is open');
  screen.select({ kit: 'engineer' }); update();
  assert.equal(screen.kits.querySelectorAll('.cq-kit-loadout .cq-kit-gadget').length, 2);
  assert.equal(screen.kits.querySelector('.cq-kit-loadout .cq-kit-gadgets').classList.contains('is-placeholder'), false);
  const css = readFileSync(new URL('../public/styles/conquest.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /\.cq-kit\.is-selected \{ grid-column/, 'the picked card never spans the row on phones (no reflow)');
  assert.doesNotMatch(css, /\.cq-kit-row[^{]*\{[^}]*align-items: start/, 'class cards in a row share one height');
  assert.match(css, /\.cq-kit-loadout \.cq-kit-gadgets\.is-placeholder \{ display: block; visibility: hidden;/, 'phones reserve the gadget row');
  // Phones: the header status keeps a fixed two-line row even while empty, so an auto-deploy
  // timer or a refusal appearing mid-choice never pushes the classes down.
  const phone = css.slice(css.indexOf('@media (max-width: 700px)'));
  assert.match(phone, /\.cq-deploy-status, \.cq-deploy-status:empty \{[^}]*flex: 0 0 100%;[^}]*height: 30px;[^}]*-webkit-line-clamp: 2;/, 'phones reserve the status row');
  // 701-1023 px: the four unlock cards get the full width and DEPLOY its own row (no text under the button).
  const narrow = css.slice(css.indexOf('@media (max-width: 1023px)'), css.indexOf('@media (max-width: 700px)'));
  assert.match(narrow, /\.cq-deploy-foot \{ grid-row: 3; \}/, 'narrow desktop moves DEPLOY under the unlocks');
  assert.match(narrow, /\.cq-kit-row-unlock \{ margin-right: 0; \}/, 'narrow desktop gives the unlocks the full width');
  assert.match(css, /\.cq-kit-new \{ position: absolute;/, 'the NEW tag is a corner badge, out of the card grid');
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
