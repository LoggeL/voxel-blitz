// Titanfall HUD, loadout, key controllers and announcer (docs/titanfall.md §8,
// owned by WP6): the titanfall client registry's `ui` module.
//
//   client-module contract  init?(app, client), tick(snapshot, dt), frame(dt, ctx), onEvent(event), dispose()
//   titanHold()             input bits for the seated send (§3.6): 1 sprint, 2 defensive held, 4 ADS,
//                           8 reload, 16 melee held, 32 core
//
// Per frame: the pure model (titan-hud-state.js) from the newest snapshot, the
// own row's `tf` and the `tfs` frame -> TitanHud DOM; the loadout screen on
// join and while dead; the pilot / titan key contexts (pilot-controller.js,
// titan-controller.js) and the titanfall touch buttons turn into
// `{t:'titanfall'}` intents through NetClient.sendTitanfall (a short retry
// queue rides out its per-intent gaps). Embark is VehicleController's
// held interact; the walker's controls feed the WP2 predictor exactly
// (setControlsSource). dispose() removes every listener, timer, DOM node and
// body attribute, so Q is lean again once the match ends.
import { bindingLabel } from '../keybindings.js';
import { nowMs } from '../util/math.js';
import { TITAN_TYPE_IDS, TITAN_PHASE, isTitanType, decodeTitanRow } from '../../../shared/titan-contract.js';
import { TITAN_RULES, titanFrame, rodeoContact } from '../../../shared/vehicle-handling/titan.js';
import { TitanHud } from './titan-hud.js';
import { publishCockpitHud, cockpitHudLive, resetCockpitHud } from './titan-cockpit-hud.js';
import { equippedTacticalLatch, titanHudModel, titanfallTouchModel } from './titan-hud-state.js';
import { TitanLoadout, readStoredLoadout, writeStoredLoadout, renderTitanPortraits, warmTitanPortraits, disposeTitanPortraits } from './titan-loadout.js';
import { createPilotController } from './pilot-controller.js';
import { createTitanController, createEjectTaps, TITAN_HOLD } from './titan-controller.js';
import { createTitanfallAnnouncer, titanfallEventCue, titanfallStateCues } from './titanfall-announcer.js';
import * as titanPredict from './titan-predict.js';
import { setTitanfallTouchSource, TITANFALL_TOUCH_EVENT } from '../engine/touch-controls.js';
import { PilotWrist, wristShown, wristLive, resetWrist } from './pilot-wrist.js';
import { getBlock, isSolidBlock } from '../../../shared/worlddata.js';
import { createWeaponDisplayModel, weaponDisplayModel } from '../guns/weapon-display.js';

/** Labels of the keys the HUD prints, refreshed at most once a second (rebinds apply live). */
const PROMPT_ACTIONS = Object.freeze(['interact', 'jump', 'callTitan', 'pilotTactical', 'titanDash', 'titanDefensive',
  'titanTactical', 'titanOrdnance', 'titanCore', 'titanSmoke', 'titanEject']);
/** Ability verbs of the titan key actions (§3.7). */
const ABILITY_VERBS = Object.freeze({ titanDefensive: 'def', titanTactical: 'tac', titanOrdnance: 'ord', titanCore: 'core',
  titanSmoke: 'smoke', titanMelee: 'melee' });
const INTENT_TTL_MS = 260;
/** After DEPLOY the screen stays shut this long while the server's deployQueued flag is on its way. */
const DEPLOY_RESEND_MS = 1500;
const TOAST_MS = 2600;
const REFUSALS = Object.freeze({ meter: 'TITAN METER NOT FULL', sky: 'NO SKY ABOVE · MOVE INTO THE OPEN', range: 'OUT OF RANGE',
  owned: 'TITAN ALREADY DEPLOYED', bay: 'TITAN BAY FULL', spawn: 'TOO CLOSE TO SPAWN', fluid: 'CANNOT DROP INTO WATER',
  uneven: 'GROUND TOO UNEVEN', blocked: 'DROP ZONE BLOCKED', enclosed: 'NO WAY OUT · MOVE INTO THE OPEN' });

let S = null;

const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
const doc = () => (typeof document !== 'undefined' ? document : null);

function keyLabels() {
  const keys = {};
  for (const action of PROMPT_ACTIONS) {
    try { keys[action] = String(bindingLabel(action) || '').toUpperCase(); } catch { keys[action] = ''; }
  }
  if (keys.titanDash === 'SPACE' || keys.titanDash === ' ') keys.titanDash = 'SPACE';
  return keys;
}

/** Server-time estimate for this frame. */
function serverNow(ctx) {
  if (Number.isFinite(ctx?.nowMs) && ctx.nowMs > 0) return ctx.nowMs;
  const snap = S?.snapshot;
  return Number.isFinite(snap?.serverNow) ? snap.serverNow + Math.max(0, nowMs() - S.snapshotAt) : NaN;
}

function vc() { return S?.app?.vehicleController ?? null; }
function inputEnabled() { return S?.app?.session?.gameplayInputEnabled !== false; }
function seatedInOwnTitan() {
  const controller = vc();
  const row = S?.client?.selfRow?.();
  const tf = S?.client?.selfTf?.();
  return !!controller?.active && controller.titan && controller.seatId === 'driver' && !!row && row.state === 'alive'
    && !!tf?.titanId && controller.vehicle?.id === tf.titanId;
}
function pilotOnFoot() {
  const row = S?.client?.selfRow?.();
  return !!row && row.state === 'alive' && !row.vehicleId && !vc()?.active;
}

// ---- intents --------------------------------------------------------------------------------

/** Send now, or retry for INTENT_TTL_MS while NetClient's per-intent gap holds it back. */
function intent(key, value, { onSent = null } = {}) {
  if (!S) return false;
  S.queue = S.queue.filter(entry => entry.key !== key || (key === 'ability' && entry.value !== value));
  const entry = { key, value, until: nowMs() + INTENT_TTL_MS, onSent };
  if (flushOne(entry)) return true;
  S.queue.push(entry);
  return false;
}
function flushOne(entry) {
  const net = S?.app?.net;
  let sent = false;
  try {
    if (entry.before && entry.before() === false) return true;   // dropped by its guard
    sent = net?.sendTitanfall?.({ [entry.key]: entry.value }) === true;
  } catch { sent = false; }
  if (sent) { S.sent.push({ key: entry.key, value: entry.value }); if (S.sent.length > 64) S.sent.shift(); entry.onSent?.(); }
  return sent;
}
function flushQueue() {
  if (!S?.queue.length) return;
  const at = nowMs();
  S.queue = S.queue.filter(entry => at <= entry.until && !flushOne(entry));
}

/**
 * Dash (WP2 send order): 1) the seated input with this frame's walker controls goes out
 * first (and the 20 Hz send clock restarts), 2) `ability:'dash'`, 3) the predictor's
 * noteDash with the same controls. A dash held back by the ability gap retries whole.
 */
function dash() {
  const app = S.app, controller = vc();
  const walker = controller?.walker ?? { fwd: 0, side: 0, aimYaw: controller?.yaw ?? 0, aimPitch: controller?.pitch ?? 0, sprint: false };
  const send = () => {
    const row = controller?.vehicle;
    if (!row || !seatedInOwnTitan()) return false;
    const live = app.matchState?.phase === 'live' || app.matchState?.phase == null;
    app.net?.sendInput?.({ vehicleThrottle: walker.fwd, vehicleSteer: walker.side, vehicleBrake: 0, vehicleLift: 0,
      yaw: walker.aimYaw, pitch: walker.aimPitch, keys: {}, weapon: app.weapon?.slot, vehicleAction: null, reload: false,
      wantFire: !!(inputEnabled() && app.input?.wantFireHeld && live), titanHold: titanHold(),
      ...(walker.titanSight ? { titanSight: walker.titanSight } : {}),
      vehicleControlId: row.id, vehicleControlSeatId: controller.seatId });
    app._vehicleSendAt = nowMs() + 50;
    return true;
  };
  const entry = { key: 'ability', value: 'dash', until: nowMs() + INTENT_TTL_MS, before: send,
    onSent: () => { try { titanPredict.noteDash({ fwd: walker.fwd, side: walker.side, aimYaw: walker.aimYaw }); } catch { /* predictor gone */ } } };
  S.queue = S.queue.filter(item => !(item.key === 'ability' && item.value === 'dash'));
  if (!flushOne(entry)) S.queue.push(entry);
}

// ---- actions ---------------------------------------------------------------------------------

function toast(text) {
  if (!S || !text) return;
  S.local.toast = text;
  S.toastUntil = nowMs() + TOAST_MS;
}

/** The pilot context action (T on keyboard, the TITAN chip on touch): rodeo / battery / call. */
function pilotContext(source = 'key') {
  const p = S?.model?.pilot;
  if (!p) return false;
  const rodeo = p.rodeo;
  if (rodeo?.kind === 'rip') { S.local.ripStartedAt = serverNow(S.ctx); intent('rodeo', 'rip'); return true; }
  if (rodeo?.kind === 'mount' && rodeo.inReach !== false) { intent('rodeo', 'mount'); return true; }
  if (rodeo?.kind === 'insert' && rodeo.inReach !== false) { if (rodeo.refused) toast('SHIELD FULL'); else intent('rodeo', 'insert'); return true; }
  if (source === 'touch') return callTitan();
  return false;
}
function callTitan() {
  const meter = S?.model?.pilot?.meter;
  if (!meter) return false;
  if (meter.state === 'bay') { toast(meter.label || 'TITAN BAY FULL'); return true; }
  if (meter.state !== 'ready') return false;
  intent('call', 1);
  return true;
}

function onPilotAction(action) {
  if (action === 'pilotTactical') intent('tac', 1);
  else if (action === 'callTitan') callTitan();
  else if (action === 'interact' && !vc()) pilotContext('key');
}

function onTitanAction(action, down) {
  if (!S) return;
  if (action === 'titanDash') { if (down) dash(); return; }
  if (action === 'titanView') { if (down) vc()?.cycleView?.(); return; }
  if (action === 'titanEject') {
    if (!down) return;
    const doomed = !!S.model?.titan?.doomed;
    if (S.ejectTaps.tap(nowMs(), doomed)) intent('eject', 1);
    S.local.ejectTaps = S.ejectTaps.count(nowMs());
    return;
  }
  const verb = ABILITY_VERBS[action];
  if (verb && down) intent('ability', verb);
}

function onTouch(event) {
  const { action, down } = event?.detail ?? {};
  if (!S || typeof action !== 'string') return;
  if (action === 'callTitan') {
    if (!down) { S.touchEmbarkAt = null; return; }
    const context = titanfallTouchModel(S.model)?.context ?? null;
    // EMBARK: held like T (TITAN_RULES.embark.holdMs, frame() sends the enter); EXIT: a tap disembarks.
    if (context === 'EMBARK') { if (pilotOnFoot() && inputEnabled()) { S.touchEmbarkAt = nowMs(); S.touchEmbarkSent = false; } return; }
    if (context === 'EXIT') { if (seatedInOwnTitan() && inputEnabled()) vc()?.queueInteract?.(); return; }
    if (pilotOnFoot()) pilotContext('touch');
    return;
  }
  if (action === 'pilotTactical') { if (down && pilotOnFoot()) intent('tac', 1); return; }
  S.titanKeys?.touch(action, !!down);
}

/** VehicleController hook: T next to a titan's back or a friendly titan with a battery is ours. */
function interactClaim() {
  const rodeo = S?.model?.pilot?.rodeo;
  if (!rodeo || !inputEnabled()) return false;
  return pilotContext('key');
}

// ---- rodeo (feel pass) ----------------------------------------------------------------------------

/** A predicted contact grabs only this far inside the server's contact gap (rows trail the prediction). */
const RODEO_PREDICT_MARGIN = 0.3;
const PILOT_HALF_W = 0.32;

/** Titan hull velocities [vx, vz] by id from consecutive snapshots (the HUD's jump-arc check). */
function trackTitans(snapshot) {
  const t = snapshot?.serverNow;
  if (!Number.isFinite(t)) return;
  const vel = {}, next = new Map();
  for (const row of snapshot.vehicles ?? []) {
    if (!row || !isTitanType(row.type) || !Number.isFinite(row.x) || !Number.isFinite(row.z)) continue;
    const prev = S.titanTrack?.get(row.id), dt = prev ? (t - prev.t) / 1000 : 0;
    vel[row.id] = dt > 0.005 && dt < 0.5 ? [(row.x - prev.x) / dt, (row.z - prev.z) / dt] : (dt === 0 && S.local.titanVel?.[row.id]) || [0, 0];
    next.set(row.id, { x: row.x, z: row.z, t });
  }
  S.titanTrack = next;
  S.local.titanVel = vel;
}

/** The predicted local pilot for the rodeo prompt: feet, velocity, grounded, jumps left; null when not on foot. */
function localBody() {
  const player = S?.app?.player, physics = player?.physics;
  if (!physics?.pilotRules || player.alive === false || !pilotOnFoot()) return null;
  const { pos, vel } = physics;
  if (!pos || !vel) return null;
  return { x: pos.x, y: pos.y, z: pos.z, vx: vel.x, vy: vel.y, vz: vel.z, grounded: !!physics.grounded, jumpsLeft: physics.pilot?.jumpsLeft ?? 0 };
}

/**
 * LocalPlayer hook: the enemy titan an airborne predicted body at `pos` touches by
 * the server's contact rule (newest rows, a margin inside the gap; no rider, not
 * the hull left less than remountMs ago), or null.
 */
function rodeoContactFor(pos) {
  if (!S || !pos) return null;
  const skipId = S.rodeoLeft && nowMs() < S.rodeoLeft.until ? S.rodeoLeft.id : null;
  const self = S.client.selfRow?.(), rows = S.client.snapshot?.()?.vehicles;
  if (!self || !Array.isArray(rows)) return null;
  for (const row of rows) {
    if (!isTitanType(row?.type) || !(row.hp > 0) || row.wreck || !row.team || row.team === self.team || String(row.id) === String(skipId)) continue;
    const titan = decodeTitanRow(row);
    if (titan?.rider || titan?.phase === TITAN_PHASE.dropping) continue;
    const contact = rodeoContact(pos, row);
    if (contact && contact.zone !== 'front' && contact.gap <= TITAN_RULES.rodeo.contact - RODEO_PREDICT_MARGIN) return row.id;
  }
  return null;
}

/**
 * LocalPlayer hook: the rider's feet on the presented (drawn) hull `id`. The
 * hull-local offset is the server's (own row against that titan's row in the
 * same snapshot) while riding, else the nominal spot 0.3 m off the rear plate
 * (a predicted mount). Null without a drawn hull.
 */
function rodeoPoseFor(id) {
  if (!S || id == null) return null;
  const hull = S.app?.vehicleView?.presentedRow?.(id);
  const f = titanFrame(hull);
  if (!hull || !f || ![hull.x, hull.y, hull.z].every(Number.isFinite)) return null;
  let lx = 0, ly = f.backY - 1.2, lz = f.hl + 0.3 + PILOT_HALF_W;
  const self = S.client.selfRow?.(), row = S.client.snapshot?.()?.vehicles?.find(item => item?.id === id);
  if (self && row && S.client.selfTf?.()?.rodeoVehicleId === id && [self.x, self.y, self.z, row.x, row.y, row.z].every(Number.isFinite)) {
    const c = Math.cos(finite(row.yaw)), s = Math.sin(finite(row.yaw)), dx = self.x - row.x, dz = self.z - row.z;
    lx = dx * c - dz * s; ly = self.y - row.y; lz = dx * s + dz * c;
  }
  const c = Math.cos(finite(hull.yaw)), s = Math.sin(finite(hull.yaw));
  return { x: hull.x + lx * c + lz * s, y: hull.y + ly, z: hull.z - lx * s + lz * c };
}

/** LocalPlayer / PilotCamera hook: the drawn hull `id`'s position (the rodeo camera backs off it), or null. */
function rodeoHullFor(id) {
  if (!S || id == null) return null;
  const hull = S.app?.vehicleView?.presentedRow?.(id);
  return hull && [hull.x, hull.y, hull.z].every(Number.isFinite) ? hull : null;
}

// ---- touch context ------------------------------------------------------------------------------

/** The touch EMBARK hold: progress 0..1; at 1 the enter for the own titan is queued once. */
function touchEmbark(controller, at) {
  if (S.touchEmbarkAt == null) return 0;
  if (!pilotOnFoot() || !inputEnabled()) { S.touchEmbarkAt = null; return 0; }
  const progress = Math.min(1, Math.max(0, (at - S.touchEmbarkAt) / TITAN_RULES.embark.holdMs));
  if (progress >= 1 && !S.touchEmbarkSent) {
    S.touchEmbarkSent = true;
    const near = controller?.nearest;
    const ownId = S.client.selfTf?.()?.titanId ?? null;
    if (near && ownId != null && String(near.id) === String(ownId) && isTitanType(near.type ?? near.kind)) controller.queueInteract?.();
  }
  return progress;
}

function touchContext() { return titanfallTouchModel(S?.model); }

// ---- loadout ----------------------------------------------------------------------------------------

/** Respawn countdown for the screen: none while held off the field at join / match start (§3.4 deploy). */
function loadoutRespawnIn(model) {
  return model?.layout === 'dead' && !S.client.selfTf?.()?.staged ? model.respawnIn : null;
}

function openLoadout(reason) {
  if (!S?.loadout) return;
  const row = S.client.selfRow?.();
  const dead = S.model?.layout === 'dead';
  S.loadoutReason = reason;
  S.loadout.open({ team: row?.team === 'bravo' ? 'bravo' : 'alpha', dead, respawnIn: dead ? loadoutRespawnIn(S.model) : null,
    autoDeployIn: dead ? S.model?.autoDeployIn ?? null : null });
  // The screen needs the cursor: gameplay input pauses and pointer lock is released until it closes.
  try { S.app?.session?.setOverlayBlock?.('titanLoadout', true); } catch { /* no session */ }
  try { S.app?.input?.exit?.(); } catch { /* no pointer lock */ }
}

/**
 * §3.4 deploy: the server holds a human off the field (join, match start, every death) until DEPLOY.
 * While it waits (tf `deploy` without `deployQueued`) the screen is open; it closes on DEPLOY, on the
 * spawn and at match end. A DEPLOY the server never acknowledged reopens it after DEPLOY_RESEND_MS.
 */
function syncLoadout(model) {
  const loadout = S.loadout;
  if (!loadout) return;
  const layout = model.layout;
  const tf = S.client.selfTf?.();
  if (!S.joinedOpen && (layout === 'pilot' || layout === 'dead')) {
    S.joinedOpen = true;
    // The init send can predate this player's engine entity (lobby, loading): resend the stored pick
    // with the first row, so an idle auto-deploy still takes it.
    if (S.stored) intent('loadout', S.loadout.packed);
  }
  const post = (S.client.snapshot?.() ?? S.snapshot)?.match?.phase === 'post';
  // The killcam replay of this death plays first (and its head-flight intro): the screen opens when it ends.
  const killcam = S.app?.killcam;
  const replay = layout === 'dead' && !post && !!(killcam?.active || killcam?.pending);
  if (replay && loadout.isOpen && S.loadoutReason === 'death') loadout.close();
  const waiting = layout === 'dead' && !!tf?.deploy && !tf.deployQueued && !post && !replay;
  if (!waiting || tf?.deployQueued) S.deploySentAt = null;
  const sent = S.deploySentAt != null && nowMs() - S.deploySentAt < DEPLOY_RESEND_MS;
  if (waiting && !sent && !loadout.isOpen) openLoadout(tf.staged ? 'join' : 'death');
  if (loadout.isOpen) {
    if (layout === 'dead' && !post) loadout.update({ dead: true, respawnIn: loadoutRespawnIn(model), autoDeployIn: model.autoDeployIn ?? null });
    else if (S.loadoutReason === 'death' || S.loadoutReason === 'join') loadout.close();
    else loadout.update({ dead: false, respawnIn: null });
  }
  // The loadout screen replaces the stock spectator/respawn overlay and the death note, as Conquest's
  // deploy screen does: hidden while it is open and the whole time the server holds this player for
  // DEPLOY (staged at join, dead on the screen, or a queued DEPLOY whose countdown the titanfall dead
  // panel shows). The match result shows the stock overlays again.
  setDeployCover(layout === 'dead' && !post);
}

/** Suppress the stock spectator overlay (SpectatorHud) and, through titanfall.css, the death note. */
function setDeployCover(on) {
  if (!S || S.deployCover === on) return;
  S.deployCover = on;
  try { S.app?.hud?.spectator?.setSuppressed?.(on); } catch { /* no stock HUD */ }
  const body = doc()?.body;
  if (body?.dataset) { if (on) body.dataset.titanfallDeploy = ''; else delete body.dataset.titanfallDeploy; }
}

/**
 * On-gun ammo counters (weapon-display.js, §8.6 On-gun displays): on foot, the drawn pilot gun's rear counter shows
 * the predicted weapon state and the `tfs` lock. While it is on screen (first person, not scoped, not an ARCHER
 * aiming) the floating ammo card hides on desktop and touch (titanfall.css body[data-titanfall-gun-display]);
 * third person, spectating, seated, the scoped KRABER and guns without a counter keep the card.
 */
function syncGunDisplay(layout, tfs) {
  const rig = S.app?.rig, weapon = S.app?.weapon;
  let shown = null;
  const onFoot = layout === 'pilot' && !!rig?.setWeaponDisplay && !!weapon?.readDisplay;
  if (onFoot) {
    S.gunRead ??= {};
    S.gunOptions ??= { mode: 'titanfall', lock: 0 };
    S.gunDisplay ??= createWeaponDisplayModel();
    S.gunOptions.lock = tfs?.lockProgress ?? 0;
    shown = weaponDisplayModel(weapon.readDisplay(S.gunRead), S.gunOptions, S.gunDisplay);
  }
  // On foot a weapon without a panel (the knife) leaves the built panels alone: the rig keeps the last model
  // and each panel paints only its own gun. Leaving the pilot layout (embark, titan, death) strips them.
  if (shown) rig.setWeaponDisplay(shown);
  else if (S.gunDisplayOn && !onFoot) rig?.setWeaponDisplay?.(null);
  S.gunDisplayOn = !!shown || (S.gunDisplayOn && onFoot);
  const live = !!shown && rig?.weaponDisplayLive === true;
  const body = doc()?.body;
  if (body?.dataset && ('titanfallGunDisplay' in body.dataset) !== live) {
    if (live) body.dataset.titanfallGunDisplay = ''; else delete body.dataset.titanfallGunDisplay;
  }
}

// ---- pilot wrist display --------------------------------------------------------------------------

const wristSolidAt = (x, y, z) => isSolidBlock(getBlock(x, y, z));

/** The wrist display on the match's first-person rig (built at init, so the load-time shader warm-up links it). */
function createWrist(app) {
  if (!app?.rig?.root || !doc()) return null;
  const wrist = new PilotWrist({ solidAt: wristSolidAt });
  return wrist.attach(app.rig) ? wrist : null;
}

/**
 * Pilot wrist display (pilot-wrist.js, §8.7 Wrist display): on foot the tactical readout sits on the left forearm.
 * While its screen is live (drawn, in view, not behind the receiver in ADS) the floating DOM tactical chip hides
 * (titanfall.css body[data-titanfall-wrist]); spectating, seated, embarking and dead keep the chip's layout rules.
 */
function syncWrist(model, ctx) {
  const show = !!S.wrist && wristShown(model, { spectating: S.app?.spectator?.active === true });
  S.wrist?.update(show ? model.pilot.tactical : null, { show, camera: ctx?.camera ?? null, aim: S.app?.player ?? null,
    touch: !!S.local.touch, weapon: S.app?.weapon?.def?.id ?? null });
  const live = show && wristLive();
  const body = doc()?.body;
  if (body?.dataset && ('titanfallWrist' in body.dataset) !== live) { if (live) body.dataset.titanfallWrist = ''; else delete body.dataset.titanfallWrist; }
}

/** DEPLOY / READY: dead (or held at join) it is the spawn request with the pick, alive just the pick. */
function deployPressed() {
  if (!S) return;
  const packed = S.loadout.packed;
  writeStoredLoadout(packed);
  S.stored = true;
  const row = S.client.selfRow?.();
  if (row && row.state !== 'alive') { S.deploySentAt = nowMs(); intent('deploy', packed); }
  else intent('loadout', packed);
}

function onLoadoutChange(packed) {
  writeStoredLoadout(packed);
  S.stored = true;
  intent('loadout', packed);
}

// ---- module contract ------------------------------------------------------------------------------

/** Load time (titanfall-client prepare, before warmShaders): link the loadout portrait programs. */
export async function prepare(app) {
  if (!S || S.app !== app || !app?.renderer || !doc()) return;
  await warmTitanPortraits(app.renderer, { documentRef: doc() });
}

export function init(app, client) {
  dispose();
  const d = doc();
  S = {
    app, client, snapshot: null, snapshotAt: 0, model: null, prevModel: null, ctx: null, keys: keyLabels(), keysAt: nowMs(),
    queue: [], sent: [], local: { ripStartedAt: NaN, ejectTaps: 0, embarkProgress: 0, toast: null, touch: false }, toastUntil: 0,
    touchEmbarkAt: null, touchEmbarkSent: false,
    ejectTaps: createEjectTaps(), joinedOpen: false, deploySentAt: null, loadoutReason: null, stored: false,
    lastPhase: null, mountAt: -Infinity, walkerSeen: null, reloadLatch: false, hud: null, loadout: null,
    pilotKeys: null, titanKeys: null, announcer: null, priorVcClaim: null, touchListener: null, tacLatch: null, deployCover: false,
  };
  const stored = readStoredLoadout();
  S.stored = stored != null;
  S.wrist = createWrist(app);
  const parent = d?.getElementById?.('hud') ?? d?.body ?? null;
  if (d && parent) {
    S.hud = new TitanHud(parent, { documentRef: d });
    S.loadout = new TitanLoadout(d.body, {
      documentRef: d, packed: stored ?? undefined, onChange: onLoadoutChange,
      onDeploy: deployPressed,
      onClose: () => {
        if (!S) return;
        try { S.app?.session?.setOverlayBlock?.('titanLoadout', false); } catch { /* no session */ }
        // Inside the DEPLOY click this is the gesture pointer lock needs: the spectator view (dead) or play takes the mouse.
        try { S.app?.session?.restoreGameplayFocus?.(); } catch { /* gesture needed */ }
      },
      portraits: (team, size) => renderTitanPortraits(app?.renderer, { team, size, types: TITAN_TYPE_IDS, documentRef: d, anchor: app?.player?.pos ?? null }),
    });
    d.body.dataset.titanfall = 'hidden';
  }
  // The server keeps the default until told: send the stored pick once.
  if (stored != null) intent('loadout', stored);
  S.pilotKeys = createPilotController({ active: () => !!S && pilotOnFoot() && inputEnabled() && !S.loadout?.isOpen, onAction: onPilotAction });
  S.titanKeys = createTitanController({ active: () => !!S && seatedInOwnTitan() && inputEnabled(), onAction: onTitanAction });
  // The shared announcer voice (sfx.objectiveAudio): loaded lazily so node tests never touch WebAudio.
  const owner = S;
  import('../audio/sfx.js').then(({ sfx }) => {
    if (S !== owner) return;
    let audio = null;
    try { audio = sfx?.objectiveAudio?.() ?? null; } catch { audio = null; }
    S.announcer = createTitanfallAnnouncer({ audio });
    // Decode the calls now, not on the first cue (frame() retries until the AudioContext exists).
    S.announcer.load();
  }).catch(() => {});
  const controller = app?.vehicleController;
  if (controller) { S.priorVcClaim = controller.interactClaim ?? null; controller.interactClaim = interactClaim; }
  titanPredict.setControlsSource(() => {
    const walker = vc()?.walker;
    return walker ? { fwd: walker.fwd, side: walker.side, aimYaw: walker.aimYaw, aimPitch: walker.aimPitch, sprint: walker.sprint }
      : { fwd: 0, side: 0, aimYaw: vc()?.yaw ?? 0, aimPitch: vc()?.pitch ?? 0, sprint: false };
  });
  setTitanfallTouchSource(touchContext);
  // Rodeo prediction (LocalPlayer): grab on a predicted contact, ride the drawn hull.
  if (app?.player) { app.player.rodeoContactFor = rodeoContactFor; app.player.rodeoPoseFor = rodeoPoseFor; app.player.rodeoHullFor = rodeoHullFor; }
  S.touchListener = event => onTouch(event);
  d?.defaultView?.addEventListener?.(TITANFALL_TOUCH_EVENT, S.touchListener);
}

export function tick(snapshot, dt) {
  if (!S || !snapshot) return;
  S.snapshot = snapshot;
  S.snapshotAt = nowMs();
  const match = snapshot.match;
  const phase = match?.phase ?? null;
  if (phase === 'post' && S.lastPhase !== 'post' && match?.winner !== undefined) {
    for (const cue of titanfallStateCues(null, {}, { winner: match.winner ?? null, selfTeam: S.client.selfRow?.()?.team ?? null })) S.announcer?.play(cue);
  }
  S.lastPhase = phase;
  trackTitans(snapshot);
}

export function frame(dt, ctx = {}) {
  if (!S) return;
  S.ctx = ctx;
  const at = nowMs();
  if (at - S.keysAt > 1000) { S.keys = keyLabels(); S.keysAt = at; }
  if (S.local.toast && at > S.toastUntil) S.local.toast = null;
  S.local.ejectTaps = S.ejectTaps.count(at);
  S.announcer?.load();
  const controller = vc();
  S.local.embarkProgress = Math.max(controller?.holdInteract?.() ?? 0, touchEmbark(controller, at));
  S.local.touch = !!doc()?.documentElement?.classList?.contains?.('vb-touch-mode');
  // A reload press seen by controls() after the last seated send rides the next one (bit 8).
  const walker = controller?.walker;
  if (walker?.reload && walker !== S.walkerSeen) S.reloadLatch = true;
  flushQueue();
  const snapshot = S.client.snapshot?.() ?? S.snapshot;
  const now = serverNow(ctx);
  const selfRow = S.client.selfRow?.(), tfs = S.client.selfFrame?.();
  S.tacLatch = equippedTacticalLatch(S.tacLatch, { selfRow, tfs });
  S.local.equippedTactical = S.tacLatch?.id ?? null;
  S.local.body = localBody();
  // The hull just jumped off is not grabbed straight back (rodeo.js remountMs).
  const riding = S.client.selfTf?.()?.rodeoVehicleId ?? null;
  if (S.ridingId && S.ridingId !== riding) S.rodeoLeft = { id: S.ridingId, until: at + TITAN_RULES.rodeo.remountMs };
  S.ridingId = riding;
  const model = titanHudModel({ snapshot, selfRow, tfs, now, keys: S.keys, local: S.local });
  // Rodeo: the server grabs an airborne pilot on contact; the intent backs it up (it checks the contact again).
  // A pilot standing in contact mounts with a jump or T, never by walking past.
  const rodeo = model.pilot?.rodeo;
  if (rodeo?.kind === 'mount' && rodeo.inReach && S.local.body?.grounded === false && at - S.mountAt > 400) { S.mountAt = at; intent('rodeo', 'mount'); }
  if (rodeo?.kind !== 'ripping' && Number.isFinite(S.local.ripStartedAt) && !(model.pilot?.rodeo)) S.local.ripStartedAt = NaN;
  S.prevModel = S.model;
  S.model = model;
  for (const cue of titanfallStateCues(S.prevModel, model)) S.announcer?.play(cue);
  // The session's stock HUD build (GameplayHud.buildHUD clears #hud after create) detaches this HUD: re-attach it.
  const hudRoot = S.hud?.root;
  if (hudRoot && hudRoot.isConnected === false) (doc()?.getElementById?.('hud') ?? doc()?.body)?.appendChild?.(hudRoot);
  S.hud?.render(model);
  const body = doc()?.body;
  if (body?.dataset && body.dataset.titanfall !== model.layout) body.dataset.titanfall = model.layout;
  // First-person in the own titan with the diegetic cockpit HUD drawn (titan-cockpit-hud.js): the DOM titan HUD,
  // crosshair, hit marker, kill feed and badge hide (titanfall.css); chase, on foot, embark and eject keep them.
  publishCockpitHud(model, S.keys);
  syncGunDisplay(model.layout, tfs);
  syncWrist(model, ctx);
  const local = S.app?.vehicleView?.localView;
  const cockpit = model.layout === 'titan' && !!local && !local.sight && String(local.id) === String(S.client.selfTf?.()?.titanId) && cockpitHudLive();
  if (body?.dataset && ('titanfallCockpit' in body.dataset) !== cockpit) { if (cockpit) body.dataset.titanfallCockpit = ''; else delete body.dataset.titanfallCockpit; }
  syncLoadout(model);
  // Pad: A deploys from the open screen like the DEPLOY button (§3.4 deploy; no cursor needed).
  const pad = S.app?.input?.padButtons;
  if (pad?.pressed?.jump && S.loadout?.isOpen && model.layout === 'dead' && !S.app?.hud?.settingsOpen) { deployPressed(); S.loadout.close(); }
}

export function onEvent(event) {
  if (!S || !event) return;
  const self = S.app?.myId;
  const tf = S.client.selfTf?.();
  const players = S.snapshot?.players ?? [];
  const cue = titanfallEventCue(event, { selfId: self, selfTeam: S.client.selfRow?.()?.team ?? null, ownTitanId: tf?.titanId ?? null,
    teamOf: id => players.find(row => String(row?.id) === String(id))?.team ?? null });
  if (cue) S.announcer?.play(cue);
  if (self == null) return;
  if (event.kind === 'rodeo_rip' && String(event.id) === String(self)) S.local.ripStartedAt = NaN;
  if (event.kind === 'rodeo_off' && String(event.id) === String(self)) S.local.ripStartedAt = NaN;
  if (event.kind === 'titanfall_refused' && String(event.owner) === String(self)) toast(REFUSALS[event.reason] ?? 'TITANFALL REFUSED');
  // A refusal toast does not outlive the accepted re-call (it would sit above the inbound beam).
  if (event.kind === 'titanfall_drop' && String(event.owner) === String(self)) { S.local.toast = null; S.toastUntil = 0; }
  if (event.kind === 'titan_eject' && String(event.id) === String(self)) S.ejectTaps.reset();
  if (event.kind === 'oob_warning' && String(event.id) === String(self) && Number.isFinite(event.until)) S.local.oobUntil = event.until;
}

/** Seated-send bits (§3.6): sprint and reload from the walker controls, the held titan keys, ADS. */
export function titanHold() {
  if (!S || !seatedInOwnTitan()) return 0;
  const controller = vc();
  const walker = controller?.walker;
  let bits = S.titanKeys?.held() ?? 0;
  if (walker?.sprint) bits |= TITAN_HOLD.sprint;
  if (controller?.opticHeld) bits |= TITAN_HOLD.ads;
  if (S.reloadLatch || (walker?.reload && walker !== S.walkerSeen)) bits |= TITAN_HOLD.reload;
  S.reloadLatch = false;
  S.walkerSeen = walker ?? null;
  return bits;
}

/** Test and capture hook: the last painted model and the sent intents. */
export function debugState() {
  return S ? { model: S.model, sent: S.sent.slice(), queue: S.queue.map(({ key, value }) => ({ key, value })), loadoutOpen: !!S.loadout?.isOpen,
    played: S.announcer?.played?.slice() ?? [] } : null;
}

export function dispose() {
  if (!S) return;
  const state = S;
  S = null;
  try { state.pilotKeys?.dispose(); } catch { /* already gone */ }
  try { state.titanKeys?.dispose(); } catch { /* already gone */ }
  try { state.announcer?.dispose(); } catch { /* already gone */ }
  state.hud?.dispose();
  state.loadout?.dispose();
  disposeTitanPortraits();
  try { state.app?.session?.setOverlayBlock?.('titanLoadout', false); } catch { /* no session */ }
  const controller = state.app?.vehicleController;
  if (controller && controller.interactClaim === interactClaim) controller.interactClaim = state.priorVcClaim;
  titanPredict.setControlsSource(null);
  setTitanfallTouchSource(null);
  const player = state.app?.player;
  if (player?.rodeoContactFor === rodeoContactFor) player.rodeoContactFor = null;
  if (player?.rodeoPoseFor === rodeoPoseFor) player.rodeoPoseFor = null;
  if (player?.rodeoHullFor === rodeoHullFor) player.rodeoHullFor = null;
  const d = doc();
  if (state.touchListener) d?.defaultView?.removeEventListener?.(TITANFALL_TOUCH_EVENT, state.touchListener);
  if (d?.body?.dataset) { delete d.body.dataset.titanfall; delete d.body.dataset.titanfallDeploy; delete d.body.dataset.titanfallCockpit; }
  if (d?.body?.dataset) delete d.body.dataset.titanfallGunDisplay;
  state.wrist?.dispose();
  resetWrist();
  if (d?.body?.dataset) delete d.body.dataset.titanfallWrist;
  if (state.gunDisplayOn) state.app?.rig?.setWeaponDisplay?.(null);
  resetCockpitHud();
  if (state.deployCover) try { state.app?.hud?.spectator?.setSuppressed?.(false); } catch { /* no stock HUD */ }
}
