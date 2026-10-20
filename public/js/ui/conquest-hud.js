/**
 * Conquest HUD orchestrator (contract §3.6). It owns no gameplay truth: every
 * frame it rebuilds the read model from the latest authoritative snapshot
 * (conquest-hud-state.js) and hands it to the presentation modules under
 * ./conquest/. Events (score, flag transitions, deploy refusals, vehicle hits)
 * arrive through handleEvent.
 */
import { bindingLabel, isTypingTarget, matchesBinding } from '../keybindings.js';
import {
  bannerForEvent, hijackBanner, reconGadgetBanner, captureRingModel, chutePromptModel, conquestTouchFields, flagChipModels, flagMarkerModels, hullZoneFlash, interactModel, isAircraftType,
  killerCard, kitUnlockBanner, kitUnlockState, lockerModel, mapItems, matchEndBanner, nextFreeSeatIndex, ownKitUnlocks, readConquest,
  restrictedModel, reticleModel, scoreEntry, seatedVehicle, spreadEdgeMarkers, squadListModel, tankHitCallout, ticketModel, unitMarkerModels,
  vehicleHitMark, vehiclePanelModel, weatherChipModel,
} from './conquest-hud-state.js';
import { KITS, decodeConquestPlayer } from '../../../shared/conquest-contract.js';
import { kitDeployable } from '../../../shared/conquest-kits.js';
import { upgradeSpot } from '../../../shared/vehicle-upgrades.js';
import { CONQUEST_TOUCH_EVENT } from '../engine/touch-controls.js';
import { el } from './hud-support.js';
import { BigMap } from './conquest/big-map.js';
import { Banners, LockWarning, RestrictedOverlay } from './conquest/banners.js';
import { CaptureRing } from './conquest/capture-ring.js';
import { DeployScreen } from './conquest/deploy-screen.js';
import { InteractPrompt } from './conquest/interact.js';
import { WorldMarkers } from './conquest/markers.js';
import { Minimap } from './conquest/minimap.js';
import { setOverviewMap } from './conquest/map-painter.js';
import { cameraAngles, cameraPosition, createProjector } from './conquest/projection.js';
import { Reticles } from './conquest/reticles.js';
import { ScoreTicker } from './conquest/score-ticker.js';
import { SquadList } from './conquest/squad-list.js';
import { TopBar } from './conquest/top-bar.js';
import { VehiclePanel } from './conquest/vehicle-panel.js';
import { ViewStrip, viewButtonLabel, viewStripModel } from './conquest/view-strip.js';
import { FlightHint } from './conquest/flight-hint.js';
import { CommRose } from './conquest/comm-rose.js';
import { OrderChip, RadioFeed } from './conquest/order-chip.js';
import {
  PAD_ROSE_HOLD_MS, commRoseModel, downedMedicModel, isSquadLeader, orderFlagOf, radioLine, requestMapItems, requestMarkerModels, squadOrderBanner,
  squadOrderModel, visibleRequests, withOrderRing,
} from './conquest/comms-state.js';
import { MortarSight, mortarBanner, mortarSightModel } from './conquest/mortar-sight.js';
import { FpvFeed, fpvBanner, fpvFeedModel } from './conquest/fpv-feed.js';
import { RibbonToast, ribbonToastEntry } from './conquest/ribbons.js';
import { WeatherChip } from './conquest/weather-chip.js';
import { bridgeBanner, bridgeChipBadge, bridgeMapModel, bridgeStateBanner } from './conquest/bridge-hud.js';
import { mapEventBanner, mapEventHud, mapEventMapItems, mapEventMarkerModels, mapEventPoint, syncMapEventPhases, whereText } from './conquest/map-events.js';
import { MAP_EVENT_DEFS, MAP_EVENT_KIND } from '../../../shared/conquest-map-events.js';

const clockNow = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
/** Per-frame DOM writes compare first: an equal data-* or hidden write still invalidates style. */
const setData = (node, key, value) => { if (node.dataset[key] !== value) node.dataset[key] = value; };
const setHidden = (node, hidden) => { if (node.hidden !== hidden) node.hidden = hidden; };
const MARKER_INSETS_DESKTOP = Object.freeze({ top: 96, bottom: 120, left: 48, right: 48 });
const MARKER_INSETS_TOUCH = Object.freeze({ top: 124, bottom: 150, left: 28, right: 28 });
/** Phone landscape: HP card, minimap and MAP / SPOT fill the left edge, so left markers clamp right of them. */
const MARKER_INSETS_TOUCH_LANDSCAPE = Object.freeze({ top: 124, bottom: 150, left: 196, right: 28 });
/** Fixed HUD panels edge-clamped flag markers keep clear of (re-measured at most every OBSTACLE_MS). */
const MARKER_OBSTACLES = ['.cq-minimap', '.cq-squad', '.cq-order', '.cq-radio', '.cq-map-hint', '.cq-vehicle', '.cq-top', '.cq-weather', '.cq-view', '.cq-banner', '.cq-ring', '.cq-interact', '.cq-lock',
  '.cq-restricted', '.cq-mortar', '#healthbar', '#ammo', '#grenade-count', '.vb-touch-button'].join(', ');
const OBSTACLE_MS = 400;
/** The crosshair and its reticle labels (vehicle ammo, lock, pipper): clamped edge markers stay out of it. */
const crosshairZone = (width, height) => ({ left: width / 2 - 70, right: width / 2 + 70, top: height / 2 - 50, bottom: height / 2 + 60 });
/** A snapshot within this long of the last refresh() leaves drawing to the next frame. */
const FRAME_DRIVEN_MS = 250;
/** An Assault bandage refill and an own kill this close together read as ADRENALINE. */
const ADRENALINE_KILL_WINDOW_MS = 1500;
/** How long the M / Y hint above the minimap stays after the HUD appears (until first use). */
export const MAP_HINT_MS = 30000;

/** Lowest minimap floor over a health card in the left column, and the floor once the card docks at the right. */
export const HEALTH_FLOOR = Object.freeze({ left: 104, docked: 22, gap: 18 });

/**
 * Where the minimap stands and how tall the health card is, from the card's
 * box: a card whose centre lies right of the screen centre is docked under
 * the weapon card (desktop Conquest), so the minimap drops to the bottom edge.
 */
export function healthCardLayout(rect, viewportWidth, viewportHeight) {
  const height = rect?.height > 0 ? Math.round(rect.height) : 0;
  if (!height) return { floor: HEALTH_FLOOR.left, height: 0, docked: false };
  const docked = (rect.left + rect.width / 2) > viewportWidth / 2;
  const floor = docked ? HEALTH_FLOOR.docked : Math.max(HEALTH_FLOOR.left, Math.round(viewportHeight - rect.top + HEALTH_FLOOR.gap));
  return { floor, height, docked };
}

export class ConquestHud {
  constructor(parent = globalThis.document?.body, {
    onInteract = () => {}, onDeploy = () => {}, onDeployOpen = () => {}, onSpot = () => {}, onSupport = () => {},
    combatHud = null, eventTarget = typeof window !== 'undefined' ? window : null, inputEnabled = () => true,
    shellRaycast = null, careerProfile = () => null, replayHold = () => false, mapId = null,
    onComm = () => {}, onOrder = () => {}, onCapture = () => {}, onRadio = () => {}, onMortar = () => {},
  } = {}) {
    // The battlefield's overview image, picked before the minimap, big map and
    // deploy map load it (update() keeps it in step with mapMeta.id after).
    if (typeof mapId === 'string' && mapId) { this._overviewMap = mapId; setOverviewMap(mapId); }
    // Map events (conquest/map-events.js): the definitions `ev` decodes against (setEventDefs swaps them
    // for fixtures) and the phase of each event the HUD has bannered, from events and snapshots alike.
    this.eventDefs = MAP_EVENT_DEFS;
    this._eventPhases = new Map();
    // Map event presenters send their own intents (a call-in designation) through the support route.
    this.onSupport = onSupport;
    // Comm rose picks ({comm: kind}), full-map orders ({order: flagId | ''}), the Input UI capture
    // (Input.setUiCapture: the rose and the map cursor own the aim while up) and the radio squelch.
    this.onComm = typeof onComm === 'function' ? onComm : () => {};
    this.onOrder = typeof onOrder === 'function' ? onOrder : () => {};
    this.onCapture = typeof onCapture === 'function' ? onCapture : () => {};
    this.onRadio = typeof onRadio === 'function' ? onRadio : () => {};
    // True while the local killcam replay runs or waits for the death intro: the deploy screen opens after it.
    this.replayHold = typeof replayHold === 'function' ? replayHold : () => false;
    // Solid-block picker for the tank shell impact marker (the camera picker stops on water; shells don't).
    this.shellRaycast = typeof shellRaycast === 'function' ? shellRaycast : null;
    // Keys for spot and the full map only act while gameplay input is live (not in menus).
    this.inputEnabled = typeof inputEnabled === 'function' ? inputEnabled : () => true;
    this.onSpot = onSpot;
    // Touch MORTAR: place the Support's mortar (the `mortar` intent, like slot key 3).
    this.onMortar = typeof onMortar === 'function' ? onMortar : () => {};
    this.combatHud = combatHud;
    this.root = el('section', 'vb-conquest-hud', parent);
    this.root.hidden = true;
    this.root.setAttribute('aria-label', 'Conquest tactical information');
    this._watchHealthPanel();
    // Gimbal sensor dressing (vignette, scanlines, grain) under markers and reticles;
    // the monochrome grade of the world is a body[data-vehicle-sight] filter on #game.
    this.sensor = el('div', 'cq-sensor', this.root);
    this.sensor.setAttribute('aria-hidden', 'true');
    this.sensor.hidden = true;
    // Tank driver's phosphor periscope dressing (wash, scanlines, vignette); the light grade is the same body flag.
    this.scope = el('div', 'cq-scope', this.root);
    this.scope.setAttribute('aria-hidden', 'true');
    this.scope.hidden = true;
    this.markers = new WorldMarkers(this.root);
    this.reticles = new Reticles(this.root);
    this.topBar = new TopBar(this.root);
    this.weather = new WeatherChip(this.topBar);
    this.viewStrip = new ViewStrip(this.root);
    this.flightHint = new FlightHint(this.root);
    this.banners = new Banners(this.root);
    // RIBBON EARNED toast (server `ribbon` events), under the ticket bar and any banner.
    this.ribbonToast = new RibbonToast(this.root);
    this.ring = new CaptureRing(this.root);
    this.ticker = new ScoreTicker(this.root);
    this.lock = new LockWarning(this.root);
    this.restricted = new RestrictedOverlay(this.root);
    this.minimap = new Minimap(this.root, { onOpen: () => this.toggleBigMap(true) });
    this.squadList = new SquadList(this.root);
    this.orderChip = new OrderChip(this.root);
    this.radio = new RadioFeed(this.root);
    this.vehiclePanel = new VehiclePanel(this.root);
    // Support mortar fire control (right edge, above the vehicle card) and its in-world impact ring.
    this.mortarSight = new MortarSight(this.root, { hints: `MOUSE AIM · RMB SNAP · LMB FIRE · ${bindingLabel('interact')} LEAVE` });
    // Engineer FPV drone feed (docs/design/conquest/fpv/): the goggle view while the own drone flies.
    // (Crouch lists every key bound to it; the hint names the last, C by default.)
    this.fpvFeed = new FpvFeed(this.root, { hints: `MOUSE AIM · ${bindingLabel('forward')} FLY · ${bindingLabel('jump')} / ${String(bindingLabel('crouch')).split(' / ').pop()} CLIMB / SINK · LMB DETONATE · ${bindingLabel('slot3')} CUT` });
    this._watchVehiclePanel();
    this.interact = new InteractPrompt(this.root, { onInteract, onSupport });
    this.spotFlash = el('div', 'cq-spot-flash', this.root);
    this.spotFlash.hidden = true;
    // Tank armour callout under the crosshair: RICOCHET, NO PENETRATION, TRACKS HIT, HULL REAR.
    this.hitCallout = el('div', 'cq-hit-callout', this.root);
    this.hitCallout.setAttribute('aria-live', 'polite');
    this.hitCallout.hidden = true;
    this.bigMapHint = el('div', 'cq-map-hint', this.root);
    this.bigMap = new BigMap(this.root, { onOrder: flagId => this.sendOrder(flagId) });
    this.rose = new CommRose(this.root, { onPick: segment => this._sendComm(segment), onClose: () => this._syncCapture() });
    this._capture = null;
    this._captureKind = '';
    this._padRoseAt = null;
    this._padRose = false;
    this._view = null;
    this.deploy = new DeployScreen(this.root, { onDeploy, onOpen: onDeployOpen, onCallMedic: () => this.callMedic(),
      career: typeof careerProfile === 'function' ? careerProfile : () => null });
    // Authoritative kit unlocks (the latest own `kit_unlocks` event).
    this.kitUnlocks = kitUnlockState();
    this.deploy.setUnlocks(this.kitUnlocks);
    // Medic heal feedback ('+5 HP' beside the health card, from the server `heal` event).
    // Rides the health card itself when it exists (the HUD root otherwise).
    this.healTick = el('div', 'cq-heal-tick', globalThis.document?.getElementById?.('healthbar') ?? this.root);
    this.healTick.hidden = true;
    this._healUntil = 0;
    this._healSum = 0;
    this._medkitLeft = null;
    this.dead = false;
    this.killerInfo = null;
    this.vehicleController = null;
    this._lastArgs = null;
    this.cq = null;
    this.self = null;
    this.selfTeam = null;
    this.seated = null;
    this._lastNow = 0;
    this._refreshAt = null;
    this._shownAt = clockNow();
    this._hintUsed = false;
    this._spotUntil = 0;
    this._calloutUntil = 0;
    this._interactDownAt = null;
    this._downSince = null;
    this._endKey = null;
    this.eventTarget = eventTarget;
    this._onKeyDown = event => this._key(event, true);
    this._onKeyUp = event => this._key(event, false);
    this._onBlur = () => { this._interactDownAt = null; };
    this._onTouchAction = event => this.conquestAction(event?.detail?.action);
    // Capture phase, like the vehicle controller: Input's bubble listener prevents
    // default on every bound gameplay key, which would hide Y / M from a later listener.
    eventTarget?.addEventListener?.('keydown', this._onKeyDown, true);
    eventTarget?.addEventListener?.('keyup', this._onKeyUp, true);
    eventTarget?.addEventListener?.('blur', this._onBlur);
    eventTarget?.addEventListener?.(CONQUEST_TOUCH_EVENT, this._onTouchAction);
  }

  get active() { return !this.root.hidden; }

  _key(event, down) {
    // A release always ends the hold, even when the vehicle controller consumed
    // it (preventDefault) as an enter/exit tap: a stale start would read as a
    // hold that never ends and keep sending revive or repair intents.
    if (!down && matchesBinding(event, 'interact')) { this._interactDownAt = null; return; }
    // Releasing the comm rose key sends the highlighted segment (hold mode).
    if (!down && matchesBinding(event, 'commRose')) { if (this.rose.open && this.rose.mode === 'hold') this.rose.pick(); return; }
    if (!this.active || event.defaultPrevented || isTypingTarget(event.target)) return;
    if (matchesBinding(event, 'interact')) {
      // A hold only starts while gameplay input is live (never behind the pause menu).
      if (down && !event.repeat && this.inputEnabled()) this._interactDownAt = clockNow();
      return;
    }
    if (!down || event.repeat) return;
    if (event.key === 'Escape' && this.rose.open) { this.rose.close(); return; }
    if (event.key === 'Escape' && this.bigMap.open) { this.toggleBigMap(false); return; }
    // Enter deploys from the deploy screen (gameplay input is closed while dead).
    if (this.dead && this.deploy.open && event.key === 'Enter') { this.deploy.deploy(); return; }
    if (this.dead && this.deploy.open && this._deployKey(event)) { event.preventDefault?.(); return; }
    // Down on the deploy screen: the comm rose key calls a medic (gameplay input is closed while dead).
    if (this.dead && matchesBinding(event, 'commRose')) { this.callMedic(); return; }
    if (!this.inputEnabled()) return;
    if (matchesBinding(event, 'bigMap') && !this.dead) { this.toggleBigMap(); return; }
    if (matchesBinding(event, 'commRose') && !this.dead) { this.openRose('hold'); return; }
    if (matchesBinding(event, 'spot') && !this.dead) this.spot();
  }

  /**
   * Deploy screen keys (gameplay input is closed while dead): the arrows up and
   * down pick the spawn, left and right the class (CLASSES) or the focused
   * hull's upgrade (VEHICLES); C / V open the CLASSES / VEHICLES tab and Q / E
   * move the hull focus. Physical codes, like the gameplay bindings.
   */
  _deployKey(event) {
    const vehicles = this.deploy.tab === 'vehicles';
    switch (event.key) {
      case 'ArrowUp': return this.deploy.step('spawn', -1);
      case 'ArrowDown': return this.deploy.step('spawn', 1);
      case 'ArrowLeft': return this.deploy.step(vehicles ? 'upgrade' : 'kit', -1);
      case 'ArrowRight': return this.deploy.step(vehicles ? 'upgrade' : 'kit', 1);
    }
    switch (event.code) {
      case 'KeyC': if (!vehicles) return false; this.deploy.setTab('class'); return true;
      case 'KeyV': if (vehicles) return false; this.deploy.setTab('vehicles'); return true;
      case 'KeyQ': return vehicles && this.deploy.step('hull', -1);
      case 'KeyE': return vehicles && this.deploy.step('hull', 1);
    }
    return false;
  }

  /**
   * Gamepad Conquest actions from this frame's press edges (Input.padButtons).
   * Alive: D-pad right spots and R3 (unscoped) toggles the full map; seated,
   * D-pad up takes the next free seat, LB fires countermeasures, Y cycles
   * the seat weapon and D-pad down the camera view. Deploy screen: D-pad up/down pick the spawn, LB/RB the
   * kit, Y flips CLASSES / VEHICLES, A deploys; in VEHICLES LT/RT move the hull focus and LB/RB step its
   * upgrade. Interact (D-pad left) goes through VehicleController.padInteract.
   */
  padInput({ pressed = null, held = null, scoped = false, blocked = false } = {}) {
    if (!this.active || !pressed || blocked) { this._padRoseAt = null; return false; }
    if (this.dead) {
      if (!this.deploy.open) return false;
      if (pressed.slotUp) this.deploy.step('spawn', -1);
      if (pressed.grenadePouch) this.deploy.step('spawn', 1);
      const vehicles = this.deploy.tab === 'vehicles';
      if (pressed.lastWeapon) this.deploy.step(vehicles ? 'upgrade' : 'kit', -1);
      if (pressed.grenade) this.deploy.step(vehicles ? 'upgrade' : 'kit', 1);
      if (vehicles && pressed.ads) this.deploy.step('hull', -1);
      if (vehicles && pressed.fire) this.deploy.step('hull', 1);
      if (pressed.weapon) this.deploy.step('tab', 1);
      if (pressed.jump) this.deployNow();
      // D-pad right (the rose's hold key) calls a medic while down.
      if (pressed.buy) this.callMedic();
      return true;
    }
    if (!this.inputEnabled()) { this._padRoseAt = null; return false; }
    // D-pad right: a tap spots, a hold of PAD_ROSE_HOLD_MS opens the comm rose (the right
    // stick picks, the release sends). Without `held` (older callers) a press spots at once.
    if (held) this._padRoseHold(!!pressed.buy, !!held.buy);
    else if (pressed.buy) this.spot();
    if (pressed.zoom && !scoped) this.toggleBigMap();
    if (this.seated) {
      if (pressed.slotUp) this.conquestAction('vehicleSeat');
      if (pressed.lastWeapon) this.conquestAction('countermeasure');
      if (pressed.weapon) this.vehicleController?.queueWeaponNext?.();
      // D-pad down (the infantry grenade pouch) cycles the camera view like V.
      if (pressed.grenadePouch) this.vehicleController?.cycleView?.();
    }
    return true;
  }

  _padRoseHold(pressedNow, heldNow) {
    const at = clockNow();
    if (pressedNow) { this._padRoseAt = at; this._padRose = false; }
    if (this._padRoseAt == null) return;
    if (heldNow) {
      if (!this._padRose && at - this._padRoseAt >= PAD_ROSE_HOLD_MS) this._padRose = this.openRose('hold');
      return;
    }
    // Released: the rose sends its pick, a short tap spots.
    const rose = this._padRose;
    this._padRoseAt = null;
    this._padRose = false;
    if (rose) { if (this.rose.open) this.rose.pick(); } else this.spot();
  }

  /** The comm rose model for this frame (segments, ORDER flag under the crosshair). */
  _roseModel() {
    const args = this._lastArgs;
    if (!args || !this.cq) return null;
    return commRoseModel({ cq: this.cq, self: this.self, vehicles: Array.isArray(args.vehicles) ? args.vehicles : [], seated: this.seated, view: this._view });
  }

  /**
   * Open the comm rose: 'hold' (U / D-pad right: aim and release) or 'tap'
   * (touch COMMS: tap a segment). Closed while dead, in menus and on the full map.
   */
  openRose(mode = 'hold') {
    if (!this.active || this.dead || !this.inputEnabled() || this.rose.open) return false;
    const model = this._roseModel();
    if (!model) return false;
    if (this.bigMap.open) this.toggleBigMap(false);
    this.rose.show(model, { mode });
    this._syncCapture();
    return true;
  }

  /** A rose pick: SPOT runs the ordinary spot, every other segment sends `{comm: kind}`. */
  _sendComm(segment) {
    if (!segment || segment.enabled === false) return false;
    if (segment.kind === 'spot') return this.spot();
    this.onComm(segment.kind);
    return true;
  }

  /**
   * NEED MEDIC while down (deploy screen: U, D-pad right, the CALL MEDIC
   * button). Sent only while the own row reads down and carries no live
   * medic request yet; the server checks both again.
   */
  callMedic() {
    if (!this.active || !this.dead) return false;
    const medic = downedMedicModel(this.self, this._lastArgs?.players);
    if (!medic || medic.requested) return false;
    this.onComm('medic');
    return true;
  }

  /** A full-map order pick ('' clears the order). */
  sendOrder(flagId) {
    if (!this.active || this.dead) return false;
    this.onOrder(flagId);
    return true;
  }

  /**
   * Hand the Input UI capture to whichever overlay owns the aim: the rose,
   * else the full map's order cursor for a squad leader; null when neither.
   */
  _syncCapture() {
    const kind = this.rose.open ? 'rose' : this.bigMap.open && this.active && !this.dead && isSquadLeader(this.cq, this.self) ? 'map' : '';
    if (kind === this._captureKind) return;
    this._captureKind = kind;
    if (kind !== 'map') this.bigMap.showCursor(false);
    this._capture = kind === 'rose' ? {
      move: (dx, dy) => this.rose.steer(dx, dy),
      stick: (x, y) => this.rose.stick(x, y),
      press: button => (button === 0 ? this.rose.pick() : this.rose.close()),
    } : kind === 'map' ? {
      move: (dx, dy) => { this.bigMap.showCursor(true); this.bigMap.steerCursor(dx, dy); },
      stick: (x, y, dt) => { this.bigMap.showCursor(true); this.bigMap.stickCursor(x, y, dt); },
      press: button => (button === 0 ? (this.bigMap.showCursor(true), this.bigMap.clickCursor()) : this.toggleBigMap(false)),
    } : null;
    this.onCapture(this._capture);
  }

  /** Spot along the view (keyboard or touch); the server validates cone, range and line of sight. */
  spot() {
    if (!this.active || this.dead || !(this.self?.hp > 0)) return false;
    this._hintUsed = true;
    this.onSpot();
    return true;
  }

  /**
   * The deployable the own kit carries with the gadget picked on the deploy
   * screen ('mortar' for a Support with the M-81), else null. The server checks
   * the gadget it actually issued; this only decides what digit 3 asks for.
   */
  deployableFor(self) {
    const kit = decodeConquestPlayer(self)?.kit ?? null;
    return kit ? kitDeployable(kit, this.deploy?.selection?.gadget ?? 0) : null;
  }

  toggleBigMap(open) {
    if (!this.active) return false;
    this._hintUsed = true;
    const next = this.bigMap.setOpen(open === undefined ? !this.bigMap.open : !!open);
    this.root.dataset.bigMap = String(next);
    if (next) this.rose.close();
    if (next) this.bigMap.setOrders({ leader: isSquadLeader(this.cq, this.self), orderFlag: orderFlagOf(this.cq, this.self)?.flagId ?? null });
    this._syncCapture();
    return next;
  }

  /** The killcam replay ended or was skipped: open the deploy screen now rather than on the next snapshot. */
  syncReplay() {
    if (!this.dead || !this.active || this.deploy.open || this.replayHold() || this._lastArgs?.match?.phase === 'post') return false;
    this.deploy.setOpen(true, this.killerInfo);
    return true;
  }

  /** Touch DEPLOY button: same as pressing the deploy screen button. */
  deployNow() { return this.dead && this.deploy.open ? this.deploy.deploy() : false; }

  /**
   * One Conquest touch button (touch-controls CONQUEST_TOUCH_ACTIONS): full
   * map, spot, deploy, next free seat, countermeasure, camera view, comm rose
   * and the Support's MORTAR. Seat and
   * countermeasure requests go through the vehicle controller as on keyboard.
   */
  conquestAction(action) {
    if (!this.active) return false;
    switch (action) {
      case 'bigMap': return this.dead ? false : this.toggleBigMap() || true;
      case 'spot': return this.spot();
      case 'deploy': return this.deployNow();
      // COMMS: the comm rose in tap mode (a second press closes it).
      case 'comms': return this.rose.open ? this.rose.close() : this.openRose('tap');
      case 'vehicleSeat': {
        const index = this.seated ? nextFreeSeatIndex(this.seated.row, this.seated.seat.id) : -1;
        return index >= 0 ? !!this.vehicleController?.requestSeat?.(index) : false;
      }
      case 'countermeasure': return !!this.vehicleController?.queueCountermeasure?.();
      // VIEW: the seat's next camera view, like V and the pad's D-pad down.
      case 'vehicleView': return this.seated ? !!this.vehicleController?.cycleView?.() : false;
      // MORTAR: a Support with the M-81 on foot places and mans it (the server checks kit and ground).
      // FPV: an Engineer with the drone launches it, or cuts the link of the one he flies.
      case 'mortar': return !this.dead && !this.seated && (['mortar', 'fpv'].includes(this.deployableFor(this.self)) || this.fpvPilot?.active === true)
        ? this.onMortar() !== false : false;
      default: return false;
    }
  }

  /** Conquest fields the integrator merges into the TouchControls context. */
  touchContextFields() {
    return conquestTouchFields({ active: this.active, dead: this.dead, deployOpen: this.deploy.open,
      deploy: this.deploy.model, seated: this.seated, deployable: this.dead ? null : this.deployableFor(this.self), piloting: !this.dead && this.fpvPilot?.active === true,
      viewLabel: this.seated ? viewButtonLabel(this.vehicleController?.viewState?.()) : '' });
  }

  setDead(dead, killerInfo = null) {
    this.dead = !!dead;
    if (killerInfo) this.killerInfo = killerInfo;
    if (!this.dead) this.killerInfo = null;
    const show = this.dead && this.active && !this.replayHold();
    this.deploy.setOpen(show, this.killerInfo);
    this.root.dataset.dead = String(this.dead);
    if (this.dead) {
      this.bigMap.setOpen(false); this.rose.close(); this.reticles.clear(); this._setSight(''); this.markers.clear();
      this._syncCapture();
    }
  }

  /**
   * Total Interact hold time: own key tracking, the vehicle controller's, an
   * explicit hold in ms, or `interactDown` (the merged keyboard / pad / touch
   * Interact state of this frame, timed here).
   */
  _heldMs(vehicleController, interactHeld, now, interactDown) {
    if (interactDown === true) this._downSince ??= now;
    else if (interactDown === false) this._downSince = null;
    let held = this._interactDownAt === null ? 0 : now - this._interactDownAt;
    if (this._downSince != null) held = Math.max(held, now - this._downSince);
    held = Math.max(held, this.interact.pressedMs(now));
    const fromController = vehicleController?.interactHeldMs?.();
    if (Number.isFinite(fromController)) held = Math.max(held, fromController);
    if (Number.isFinite(interactHeld)) held = Math.max(held, interactHeld);
    return held;
  }

  /**
   * Re-run the last update with a fresh camera / clock (call once per render
   * frame so screen-space markers and reticles track the camera between
   * snapshots). Values still come only from the last authoritative snapshot.
   */
  refresh({ camera = undefined, nowMs = undefined, viewport = undefined, interactHeld = undefined, interactDown = undefined, chute = undefined, fpv = undefined } = {}) {
    if (!this._lastArgs || !this.active) return;
    const args = { ...this._lastArgs };
    // FPV drone telemetry (FpvPilot.telemetry), null while no own drone flies.
    if (fpv !== undefined) args.fpv = fpv;
    // Predicted parachute prompt ('ready' / 'open', see chutePromptModel).
    if (chute !== undefined) args.chute = chute;
    if (camera !== undefined) args.camera = camera;
    if (nowMs !== undefined) args.nowMs = nowMs;
    if (viewport !== undefined) args.viewport = viewport;
    if (interactHeld !== undefined) args.interactHeld = interactHeld;
    if (interactDown !== undefined) args.interactDown = interactDown;
    this._lastArgs = args;
    this._refreshAt = clockNow();
    this._render();
  }

  /**
   * Ingest one authoritative snapshot. While refresh() drives every render
   * frame, a snapshot only updates the state and the next frame draws, so a
   * 60 Hz snapshot stream never doubles the per-frame DOM and canvas work.
   */
  update(args = {}) {
    if (!this._ingest(args)) return;
    if (!(this._refreshAt !== null && clockNow() - this._refreshAt < FRAME_DRIVEN_MS)) this._render();
  }

  /** State half of update(): mode, death and deploy transitions, the seated hull. False outside Conquest. */
  _ingest(args) {
    const { match, mapMeta = null, self = null, vehicleController = null, nowMs = null } = args;
    const cq = readConquest(match, mapMeta, { eventDefs: this.eventDefs });
    if (!cq) { this._lastArgs = null; this.hide(); return false; }
    if (mapMeta?.id && mapMeta.id !== this._overviewMap) { this._overviewMap = mapMeta.id; setOverviewMap(mapMeta.id); }
    this._lastArgs = args;
    if (vehicleController) this.vehicleController = vehicleController;
    if (args.fpvPilot) this.fpvPilot = args.fpvPilot;
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    this._lastNow = now;
    const wasHidden = this.root.hidden;
    this.root.hidden = false;
    if (wasHidden) this._shownAt = clockNow();
    // Death and life follow the authoritative self row (setDead adds the killer card).
    if (self) {
      const selfDead = self.state === 'dead' || !(self.hp > 0);
      if (selfDead !== this.dead) this.setDead(selfDead);
    }
    const post = match.phase === 'post';
    const replay = this.dead && this.replayHold();
    if ((post || replay) && this.deploy.open) this.deploy.setOpen(false);
    else if (!post && !replay && this.dead && (wasHidden || !this.deploy.open)) this.deploy.setOpen(true, this.killerInfo);
    this.cq = cq;
    this.self = self;
    const selfTeam = self?.team === 'alpha' || self?.team === 'bravo' ? self.team : null;
    this.selfTeam = selfTeam;
    setData(this.root, 'team', selfTeam || '');
    const vehicles = Array.isArray(args.vehicles) ? args.vehicles : [];
    const alive = !!self && self.state !== 'dead' && self.hp > 0;
    this.seated = alive ? seatedVehicle(self, vehicles) : null;
    // The Iron Bridge collapsing banner also follows the snapshot's stage: a player who
    // joined during the groan missed the `failing` event (pushed once per collapse).
    const collapsing = post ? null : bridgeStateBanner(cq, now);
    if (collapsing && collapsing.key !== this._bridgeFailing) this.banners.push(collapsing.banner, now);
    this._bridgeFailing = collapsing?.key ?? null;
    // Map events likewise: a phase the snapshot shows that no `map_event` bannered yet (a joiner mid-event).
    if (!post) {
      const sync = syncMapEventPhases(cq, this._eventPhases, now);
      this._eventPhases = sync.seen;
      for (const ev of sync.fresh) this._pushMapEvent(ev, now);
    }
    const end = matchEndBanner(match, selfTeam);
    if (end && end.key !== this._endKey) { this._endKey = end.key; this.banners.hold(end, now); }
    else if (!end && this._endKey) { this._endKey = null; this.banners.clear(); }
    return true;
  }

  /** Draw half of update(): every view from the last ingested snapshot and this frame's camera and clock. */
  _render() {
    const args = this._lastArgs;
    const cq = this.cq;
    if (!args || !cq) return;
    const { self = null, camera = null, nearbyVehicle = null, vehicleController = null, nowMs = null,
      interactHeld = null, interactDown = undefined, viewport = null } = args;
    const players = Array.isArray(args.players) ? args.players : [];
    const vehicles = Array.isArray(args.vehicles) ? args.vehicles : [];
    const now = Number.isFinite(nowMs) ? nowMs : this._lastNow;
    this._lastNow = now;
    const selfTeam = this.selfTeam;
    const doc = globalThis.document;
    const touch = !!doc?.documentElement?.classList?.contains('vb-touch-mode');
    const width = viewport?.width ?? globalThis.innerWidth ?? 1280;
    const height = viewport?.height ?? globalThis.innerHeight ?? 720;
    const alive = !!self && self.state !== 'dead' && self.hp > 0;
    const seated = this.seated;
    // THREE refreshes matrixWorldInverse only while rendering; project with this frame's pose.
    camera?.updateMatrixWorld?.();
    const angles = cameraAngles(camera);
    const eye = cameraPosition(camera);
    const yaw = angles?.yaw ?? (Number.isFinite(self?.yaw) ? self.yaw : 0);
    const projector = alive && camera ? createProjector(camera, width, height) : null;
    this._view = eye && angles ? { ...eye, yaw: angles.yaw, pitch: angles.pitch } : null;
    // Squad order (the squad tuple's flag) and the comm requests this player should see.
    const order = orderFlagOf(cq, self);
    const requests = alive ? visibleRequests({ self, players, vehicles, seated }) : [];
    const items = [...withOrderRing(mapItems({ cq, self, players, vehicles, selfTeam }), order), ...requestMapItems(requests),
      ...mapEventMapItems(cq, selfTeam, { nowMs: now })];
    const bridge = bridgeMapModel(cq);
    // The minimap paints before this frame's HUD DOM writes: its flag letters are canvas
    // text, and text on a canvas in the document first flushes every pending style change.
    const living = !this.dead && alive;
    if (touch !== this._touch) { this._touch = touch; this.minimap.invalidateSize(); } // --cq-minimap follows touch mode
    if (living) {
      setHidden(this.minimap.root, false);
      this.minimap.draw({ items, center: { x: self.x, z: self.z }, yaw, size: cq.size, meta: cq.meta, nowMs: now, bridge, mapEvents: cq.mapEvents });
    }

    this.topBar.update(ticketModel(cq, selfTeam, now), flagChipModels(cq, selfTeam), { bridge: bridgeChipBadge(cq) });
    const weather = this.weather.update(weatherChipModel(cq, { kit: this._selfKit(self), seatedType: this.seated?.row?.type ?? null,
      hullSpot: this.seated?.row ? upgradeSpot(this.seated.row)?.range ?? null : null }), now);
    // The weather tab hangs under the ticket bar: banners drop below it (conquest.css).
    setData(this.root, 'weather', String(weather));
    this.banners.update(now);
    this.ribbonToast.update(now);
    this.ticker.update(now);
    this.radio.update(clockNow());

    if (doc?.body?.dataset) {
      setData(doc.body, 'vehicleSeated', String(!!seated));
      // A mouse-aim pilot's aim circle replaces the infantry crosshair at the screen centre.
      setData(doc.body, 'flightAim', String(!!seated && this.vehicleController?.aimFlight === true));
    }
    setData(this.root, 'seated', seated ? seated.row.type : '');
    setData(this.root, 'touch', String(touch));
    const fpvFeed = living && !seated ? fpvFeedModel(args.fpv ?? null) : null;
    this.fpvFeed.update(fpvFeed, { clockMs: clockNow() });
    setData(this.root, 'fpv', String(!!fpvFeed));

    // Map event presenters' own HUD parts (a call-in's READY pill and full-map designator).
    mapEventHud({ hud: this, cq, self, selfTeam, leader: isSquadLeader(cq, self), living, touch, nowMs: now });

    if (!living) {
      this.ring.update(null);
      this.vehiclePanel.update(null);
      this.viewStrip.update(null);
      this.flightHint.update(null);
      this.interact.update(null, { nowMs: now });
      this.lock.update(null);
      this.restricted.update(null);
      this.reticles.clear();
      this.mortarSight.hide();
      this._setSight('');
      this.markers.clear();
      setHidden(this.minimap.root, true);
      this.squadList.update(null);
      this.orderChip.update(null);
      if (this.rose.open) this.rose.close();
      this.deploy.update({ cq, self, players, vehicles, nowMs: now, mapItems: items, meta: cq.meta });
      // A fresh life restocks the bandages: that is no ADRENALINE refill.
      this._medkitLeft = null;
      return;
    }
    this.squadList.update(squadListModel({ cq, self, players, vehicles }));
    this.orderChip.update(squadOrderModel(cq, self));
    setData(this.root, 'order', order ? order.stance : '');
    // The rose keeps its labels current (ORDER follows the crosshair on touch, where the aim stays live).
    if (this.rose.open) this.rose.setModel(this._roseModel());
    if (this.bigMap.open) this.bigMap.setOrders({ leader: isSquadLeader(cq, self), orderFlag: order?.flagId ?? null });
    this._syncCapture();
    // Airborne aircraft crew never count toward a capture (spec F1), so no ring for them.
    const airborne = !!seated && isAircraftType(seated.row.type) && seated.row.grounded === false;
    this.ring.update(airborne ? null : captureRingModel(cq, self, selfTeam));
    // The lock bearing is drawn around the crosshair, so it is relative to the view, not the hull.
    const panel = vehiclePanelModel(seated, { selfId: self.id, players, selfTeam, yaw, raycast: this.shellRaycast });
    // Pilot control hint (desktop): the first few pilot-seat entries per aircraft type and flight mode.
    const pilotSeat = !!seated && !touch && seated.seat?.drives === true && isAircraftType(seated.row.type);
    this.flightHint.update(pilotSeat ? { type: seated.row.type, vehicleId: seated.row.id,
      mode: this.vehicleController?.flight?.mode ?? 'keyboard' } : null, clockNow());
    this.vehiclePanel.update(panel, now);
    // V / D-pad down: the seat's camera views, shown briefly after a change.
    this.viewStrip.update(seated ? viewStripModel(this.vehicleController?.viewState?.(), clockNow(), bindingLabel('vehicleView')) : null);
    this.lock.update(panel?.lock ?? null);
    // A mount sight (the chin gunner's gimbal sensor) reads range, heading and zoom from this camera.
    const sight = seated && eye && angles && this.vehicleController?.sightActive === true
      ? { ...eye, yaw: angles.yaw, pitch: angles.pitch, zoom: this.vehicleController?.view?.zoom ?? 1 } : null;
    // The tank hull indicator turns the hull as presented this frame (VehicleView eases the rows) against the view.
    const presented = seated ? this.vehicleController?.renderRow : null;
    // The tank driver's DRIVER periscope swaps the hull indicator and the vehicle card for its own instruments.
    const view = seated ? this.vehicleController?.viewState?.()?.view ?? null : null;
    const periscope = view === 'driver' && seated.row.type === 'tank' && seated.seat?.id === 'driver' && !sight;
    setData(this.root, 'vehicleView', periscope ? 'driver' : '');
    const aim = periscope && Number.isFinite(this.vehicleController?.yaw) ? { yaw: this.vehicleController.yaw, pitch: this.vehicleController.pitch } : null;
    // The mortar operator gets the fire-control panel and the ground ring instead of a reticle.
    const mortar = seated && seated.row.type === 'mortar' ? mortarSightModel(seated, { items, raycast: this.shellRaycast, projector,
      aim: Number.isFinite(this.vehicleController?.yaw) ? { yaw: this.vehicleController.yaw, pitch: this.vehicleController.pitch } : null,
      snap: this.vehicleController?.mortarSnap ?? null, nowMs: clockNow() }) : null;
    this.mortarSight.update(mortar, { items, meta: cq.meta, size: cq.size, viewYaw: angles?.yaw ?? null, nowMs: now, clockMs: clockNow() });
    const reticle = !mortar && seated && projector ? reticleModel(seated, { projector, players, vehicles, selfTeam,
      raycast: this.shellRaycast, flightAim: this.vehicleController?.aimFlight === true, sight,
      viewYaw: angles?.yaw ?? null, hullYaw: presented?.id === seated.row.id ? presented.yaw : null,
      view: periscope ? 'driver' : null, driverAim: aim, lockScale: cq?.weather?.lock ?? 1 }) : null;
    this._setSight(reticle?.sensor ? 'sensor' : reticle?.periscope ? 'periscope' : '');
    // A dive puts the bomb pipper below the aim, where phones keep the exit prompt: it steps above the aim then.
    setData(this.root, 'bombSight', String(!!reticle && reticle.ccip !== undefined));
    const locker = projector ? lockerModel(self, { projector, vehicles, selfTeam, seated, lockScale: cq?.weather?.lock ?? 1,
      camera: angles && eye ? { ...eye, yaw: angles.yaw, pitch: angles.pitch } : null }) : null;
    this.reticles.draw(reticle, locker, width, height, { touch });
    // Markers after the reticles: edge-clamped flags keep clear of the panels, the crosshair and the drawn instruments.
    const insets = !touch ? MARKER_INSETS_DESKTOP : width > height && height <= 500 ? MARKER_INSETS_TOUCH_LANDSCAPE : MARKER_INSETS_TOUCH;
    // Map event hexagons share the flags' edge spread, so an edge-clamped event never sits on a flag marker.
    const eventMarkers = projector ? mapEventMarkerModels(cq, { self, selfTeam, projector, insets, nowMs: now }) : [];
    const spread = projector ? spreadEdgeMarkers([...flagMarkerModels(cq, self, selfTeam, projector, insets), ...eventMarkers.filter(m => m.kind === 'event')],
      { width, height, insets, obstacles: [...this._markerObstacles(width, height, touch), crosshairZone(width, height), ...this.reticles.reserved] }) : [];
    this.markers.update(
      spread.filter(m => m.kind !== 'event').map(m => (order && m.id === order.flagId ? { ...m, order: order.stance } : m)),
      projector ? [...this._unitMarkers(unitMarkerModels({ self, players, vehicles, selfTeam, projector, insets }), requestMarkerModels(requests, { projector })),
        ...spread.filter(m => m.kind === 'event'), ...eventMarkers.filter(m => m.kind !== 'event')] : [],
    );
    this.restricted.update(restrictedModel(self, cq, { aircraft: !!seated && isAircraftType(seated.row.type), nowMs: now }));
    // Assault ADRENALINE: a bandage came back (the authoritative count rose) right after an
    // own kill. A Medic aura restock alone or a respawn refill is not adrenaline.
    const medkitLeft = Number.isFinite(self?.medkit?.remaining) ? self.medkit.remaining : Array.isArray(self?.medkit) ? self.medkit[0] : null;
    // The row and the kill event may land a frame apart in either order, so the two are paired in a window.
    if (Number.isFinite(this._medkitLeft) && medkitLeft > this._medkitLeft && KITS[this._selfKit(self)]?.ability === 'adrenaline') this._rearmAt = now;
    if (this._rearmAt != null && now - this._rearmAt > ADRENALINE_KILL_WINDOW_MS) this._rearmAt = null;
    if (this._rearmAt != null && Math.abs(this._rearmAt - (this._ownKillAt ?? -Infinity)) <= ADRENALINE_KILL_WINDOW_MS) {
      this._rearmAt = null;
      this.spotFlash.textContent = 'ADRENALINE · +1 BANDAGE';
      this.spotFlash.dataset.tone = 'heal';
      this._spotUntil = now + 1800;
      this.spotFlash.hidden = false;
    }
    this._medkitLeft = medkitLeft;
    setHidden(this.healTick, now >= this._healUntil);
    if (this.healTick.hidden) this._healSum = 0;
    const prompt = (!seated && chutePromptModel(args.chute)) || interactModel({ self, players, vehicles, nearbyVehicle, seated, mapEvents: cq.mapEvents });
    this.interact.update(prompt, { heldMs: this._heldMs(vehicleController ?? this.vehicleController, interactHeld, clockNow(), interactDown), nowMs: now, touch });
    this.bigMap.draw({ items, size: cq.size, meta: cq.meta, nowMs: now, bridge, mapEvents: cq.mapEvents });
    // A short onboarding hint, not a permanent keybind line: it fades after
    // MAP_HINT_MS in the match or once the player has used M or Y.
    const hintLive = !this._hintUsed && clockNow() - this._shownAt < MAP_HINT_MS;
    const hint = this.bigMap.open || !hintLive ? '' : `${bindingLabel('bigMap')} MAP · ${bindingLabel('spot')} SPOT`;
    if (!touch && this.bigMapHint.textContent !== hint) this.bigMapHint.textContent = hint;
    setHidden(this.bigMapHint, touch || !hint);
    setHidden(this.spotFlash, now >= this._spotUntil);
    setHidden(this.hitCallout, now >= this._calloutUntil);
  }

  /** Forget the measured HUD panel rects (after a layout change the caller knows about). */
  invalidateLayout() { this._obstacleCache = null; }

  /** Screen rects of the visible fixed HUD panels, cached per layout and refreshed a few times a second. */
  /**
   * Seat sight look: 'sensor' (the gimbal's monochrome sensor), 'periscope' (the
   * tank driver's phosphor display) or '': the overlay and the body flag that grades #game.
   */
  _setSight(kind) {
    if ((this._sight ?? '') === kind) return;
    this._sight = kind;
    this.sensor.hidden = kind !== 'sensor';
    this.scope.hidden = kind !== 'periscope';
    const body = globalThis.document?.body;
    if (body?.dataset) body.dataset.vehicleSight = kind;
  }

  _markerObstacles(width, height, touch) {
    const key = `${width}x${height}:${touch}`;
    const at = clockNow();
    const cache = this._obstacleCache;
    if (cache && cache.key === key && at - cache.at < OBSTACLE_MS) return cache.rects;
    const rects = [];
    for (const node of globalThis.document?.querySelectorAll?.(MARKER_OBSTACLES) ?? []) {
      if (node.hidden || node.closest?.('[hidden]')) continue;
      const r = node.getBoundingClientRect?.();
      if (r && r.width > 0 && r.height > 0) rects.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
    }
    this._obstacleCache = { key, at, rects };
    return rects;
  }

  /** Unit markers plus request markers: a requester's squad / team dot gives way to its NEED ... marker. */
  _unitMarkers(units, requests) {
    if (!requests.length) return units;
    const calling = new Set(requests.map(r => r.by ?? r.id));
    return [...units.filter(m => !((m.kind === 'squad' || m.kind === 'team') && calling.has(m.id))), ...requests];
  }

  /** Swap the map event definitions `ev` / `evp` decode against (fixtures, captures, tests). */
  setEventDefs(defs) { this.eventDefs = Array.isArray(defs) ? defs : MAP_EVENT_DEFS; this._eventPhases = new Map(); }

  /** Banner for a `map_event` (or a snapshot phase), with the live distance and bearing from the viewer. */
  _pushMapEvent(ev, now) {
    const id = ev.event;
    const where = () => {
      const decoded = (this.cq?.mapEvents?.events ?? []).find(e => e.id === id);
      const at = decoded ? mapEventPoint(decoded, this.cq) : Array.isArray(ev.pos) ? { x: ev.pos[0], y: ev.pos[1], z: ev.pos[2] } : null;
      return this.dead || !this.self ? '' : whereText(this.self, at);
    };
    const banner = mapEventBanner(ev, { nowMs: now, selfTeam: this.selfTeam, selfId: this.self?.id ?? null, defs: this.eventDefs, where });
    if (banner) this.banners.push(banner, now);
  }

  /** Kit id of the self row (decoded cq[0]). */
  _selfKit(self) { return decodeConquestPlayer(self)?.kit ?? null; }

  handleEvent(ev, selfId) {
    if (!ev || typeof ev !== 'object') return;
    const now = this._lastNow || Date.now();
    const selfTeam = this.selfTeam;
    switch (ev.kind) {
      case 'kit_unlocks': {
        const own = ownKitUnlocks(ev, selfId);
        // The same event can arrive twice (boot replay, then the snapshot drain).
        if (!own || ev === this._kitUnlocksEv) break;
        this._kitUnlocksEv = ev;
        this.kitUnlocks = kitUnlockState(own);
        this.deploy.setUnlocks(this.kitUnlocks);
        if (own.newly.length) this.deploy.markNew(own.newly);
        // An open deploy screen names the new class in its own UNLOCKS header (no banner over its cards).
        const banner = kitUnlockBanner(own, now);
        if (banner && !this.deploy.open) this.banners.push(banner, now);
        break;
      }
      case 'heal':
        // Healed: a short '+HP' tick on the health card, summed while it shows.
        if (String(ev.id) === String(selfId) && Number(ev.hp) > 0) {
          this._healSum = (now < this._healUntil ? this._healSum : 0) + Number(ev.hp);
          // Self-heal pulses are 2.5 HP: show the half instead of rounding it up.
          const sum = Math.round(this._healSum * 10) / 10;
          this.healTick.textContent = `+${Number.isInteger(sum) ? sum : sum.toFixed(1)} HP`;
          this._healUntil = now + 1400;
          this.healTick.hidden = false;
        }
        break;
      case 'score': {
        const entry = scoreEntry(ev, selfId);
        if (entry) this.ticker.push(entry, now);
        break;
      }
      case 'ribbon': case 'medal': {
        const toast = ribbonToastEntry(ev, selfId);
        if (toast) this.ribbonToast.push(toast, now);
        break;
      }
      case 'flag_captured': case 'flag_neutralized': case 'flag_state': case 'ticket_low': case 'sector_captured': case 'sector_overtime': {
        const flag = this.cq?.flags?.find(f => f.id === ev.flag);
        const banner = bannerForEvent(ev, selfTeam, { flagOwner: flag?.owner ?? null, flagName: flag?.name ?? null });
        if (banner) this.banners.push(banner, now);
        break;
      }
      case 'deploy_refused':
        if (String(ev.id) === String(selfId)) {
          // A locked class names its level; a locked vehicle upgrade also names the hull and the upgrade.
          this.deploy.refuse(ev.reason !== 'locked' ? ev.reason : ev.upgrade ? { reason: 'locked', level: ev.level, vehicle: ev.vehicle, upgrade: ev.upgrade }
            : { reason: 'locked', level: ev.level });
        }
        break;
      case 'squad_order': {
        // The own squad's new (or cleared) order: a banner and the radio squelch.
        const squad = decodeConquestPlayer(this.self)?.squad | 0;
        const flag = ev.flag != null ? this.cq?.flags?.find(f => f.id === ev.flag) ?? null : null;
        const banner = squadOrderBanner(ev, { selfTeam, squad, flag, now });
        if (banner) { this.banners.push(banner, now); this.onRadio(ev); }
        break;
      }
      case 'comm':
      case 'comm_answer': {
        const info = decodeConquestPlayer(this.self);
        const line = radioLine(ev, { selfId, selfTeam, squad: info?.squad | 0, kit: info?.kit ?? null,
          driving: this.seated?.seat?.drives === true, players: this._lastArgs?.players });
        if (line) { this.radio.push(line, clockNow()); this.onRadio(ev); }
        break;
      }
      case 'revive':
        if (String(ev.id) === String(selfId)) this.banners.push({ key: `rev:${ev.by}:${now}`, tone: 'own', title: 'REVIVED', detail: 'BACK IN THE FIGHT', priority: 6 }, now);
        break;
      case 'spot':
        if (String(ev.by) === String(selfId) && Array.isArray(ev.ids) && ev.ids.length) {
          this.spotFlash.textContent = ev.ids.length > 1 ? `${ev.ids.length} ENEMIES SPOTTED` : 'ENEMY SPOTTED';
          this._spotUntil = now + 1400;
          this.spotFlash.hidden = false;
        }
        break;
      case 'vehicle_hit': {
        const mark = vehicleHitMark(ev, selfId);
        if (mark) this.combatHud?.hitmark?.(mark);
        const flash = hullZoneFlash(ev, this.seated?.row);
        if (flash) this.vehiclePanel.flashZone(flash, now);
        const callout = tankHitCallout(ev, selfId, this.seated?.row);
        if (callout) {
          this.hitCallout.textContent = callout.text;
          this.hitCallout.dataset.tone = callout.tone;
          this._calloutUntil = now + (callout.tone === 'bad' ? 2200 : 1300);
          this.hitCallout.hidden = false;
        }
        break;
      }
      case 'vehicle_destroyed':
        this.combatHud?.vehicleDestroyed?.(ev);
        break;
      case 'weather_strike':
        // Lightning: the weather tab flashes with the sky (ConquestWeatherView owns the bolt and the light).
        this.weather.flash(now);
        break;
      case 'bridge': {
        // Iron Bridge collapse: damaged, collapsing (held with its countdown), destroyed.
        const banner = bridgeBanner(ev, now);
        if (banner) this.banners.push(banner, now);
        // The snapshot's stage then never repeats this collapse's banner (_ingest).
        if (ev.name === 'failing') this._bridgeFailing = Number.isFinite(ev.fallAt) ? Math.round(ev.fallAt) : 'failing';
        break;
      }
      case MAP_EVENT_KIND: {
        // Map events: one banner per phase (the snapshot may have shown this one already), notes always.
        if (!ev.note) {
          if (this._eventPhases.get(ev.event) === ev.phase) break;
          this._eventPhases.set(ev.event, ev.phase);
        }
        this._pushMapEvent(ev, now);
        break;
      }
      case 'vehicle_hijacked': {
        const banner = hijackBanner(ev, selfTeam, selfId);
        if (banner) this.banners.push(banner, now);
        break;
      }
      case 'recon_gadget': {
        const banner = reconGadgetBanner(ev, selfId);
        if (banner) this.banners.push(banner, now);
        break;
      }
      case 'mortar': {
        const banner = mortarBanner(ev, selfId);
        if (banner) this.banners.push(banner, now);
        break;
      }
      case 'fpv': {
        const banner = fpvBanner(ev, selfId);
        if (banner) this.banners.push(banner, now);
        break;
      }
      case 'kill': {
        // ADRENALINE only re-arms on an own kill: remember when the last one landed.
        if (selfId != null && String(ev.killer) === String(selfId) && String(ev.victim) !== String(selfId)) this._ownKillAt = now;
        const card = killerCard(ev, selfId, this._lastArgs?.players);
        if (card) {
          this.killerInfo = card;
          if (this.deploy.open) this.deploy.setKiller(card);
        }
        break;
      }
      default: break;
    }
  }

  hide() {
    const body = globalThis.document?.body;
    if (body?.dataset) { delete body.dataset.vehicleSeated; delete body.dataset.flightAim; }
    this._setSight('');
    if (this.root.hidden) return;
    this.root.hidden = true;
    this.bigMap.setOpen(false);
    this.rose.close();
    this.radio.clear();
    this._syncCapture();
    this.deploy.setOpen(false);
    this.reticles.clear();
    this.mortarSight.hide();
    this.fpvFeed.hide();
    this.markers.clear();
    this.ticker.clear();
    this.banners.clear();
    this.ribbonToast.clear();
    if (this.healTick) this.healTick.hidden = true;
    this._endKey = null;
  }

  /**
   * The health card grows upward when the pain / panic meters appear. On a
   * phone the minimap and squad list stand on it (--cq-floor); on desktop it
   * docks under the weapon and grenade cards at the bottom right, which stand
   * on its height (--cq-health-h on the body, styles/conquest-cards.css).
   */
  _watchHealthPanel() {
    const doc = this.root.ownerDocument, win = doc?.defaultView;
    const card = doc?.getElementById?.('healthbar');
    if (!card || !win || typeof win.ResizeObserver !== 'function') return;
    const sync = () => {
      const { floor, height } = healthCardLayout(card.getBoundingClientRect(), win.innerWidth, win.innerHeight);
      if (floor !== this._floor) { this._floor = floor; this.root.style.setProperty('--cq-floor', `${floor}px`); }
      if (height !== this._healthHeight) {
        this._healthHeight = height;
        if (height > 0) doc.body?.style?.setProperty?.('--cq-health-h', `${height}px`);
        else doc.body?.style?.removeProperty?.('--cq-health-h');
      }
    };
    this._healthObserver = new win.ResizeObserver(sync);
    this._healthObserver.observe(card);
    this._onViewportResize = sync;
    win.addEventListener('resize', sync);
    sync();
  }

  /**
   * The vehicle card stands on the health row at the bottom right (desktop,
   * styles/conquest-cards.css) and its height follows the hull; the mortar
   * fire-control panel stands on the card (--cq-vehicle-h on the HUD root).
   */
  _watchVehiclePanel() {
    const win = this.root.ownerDocument?.defaultView, card = this.vehiclePanel?.root;
    if (!card || !win || typeof win.ResizeObserver !== 'function') return;
    const sync = () => {
      const height = Math.round(card.getBoundingClientRect().height);
      if (height === this._vehicleHeight) return;
      this._vehicleHeight = height;
      if (height > 0) this.root.style.setProperty('--cq-vehicle-h', `${height}px`);
      else this.root.style.removeProperty('--cq-vehicle-h');
    };
    this._vehicleObserver = new win.ResizeObserver(sync);
    this._vehicleObserver.observe(card);
    sync();
  }

  dispose() {
    this._healthObserver?.disconnect();
    this._vehicleObserver?.disconnect();
    this.minimap.dispose();
    this.root.ownerDocument?.body?.style?.removeProperty?.('--cq-health-h');
    if (this._onViewportResize) this.root.ownerDocument?.defaultView?.removeEventListener('resize', this._onViewportResize);
    this.hide();
    this._lastArgs = null;
    this.vehicleController = null;
    this.eventTarget?.removeEventListener?.(CONQUEST_TOUCH_EVENT, this._onTouchAction);
    this.eventTarget?.removeEventListener?.('keydown', this._onKeyDown, true);
    this.eventTarget?.removeEventListener?.('keyup', this._onKeyUp, true);
    this.eventTarget?.removeEventListener?.('blur', this._onBlur);
    this.healTick?.remove();
    this.fpvFeed.dispose();
    this.root.remove();
  }
}
