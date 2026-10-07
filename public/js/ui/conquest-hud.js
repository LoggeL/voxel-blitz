/**
 * Conquest HUD orchestrator (contract §3.6). It owns no gameplay truth: every
 * frame it rebuilds the read model from the latest authoritative snapshot
 * (conquest-hud-state.js) and hands it to the presentation modules under
 * ./conquest/. Events (score, flag transitions, deploy refusals, vehicle hits)
 * arrive through handleEvent.
 */
import { bindingLabel, isTypingTarget, matchesBinding } from '../keybindings.js';
import {
  bannerForEvent, captureRingModel, conquestTouchFields, flagChipModels, flagMarkerModels, hullZoneFlash, interactModel, isAircraftType,
  killerCard, lockerModel, mapItems, matchEndBanner, nextFreeSeatIndex, readConquest, restrictedModel, reticleModel, scoreEntry,
  seatedVehicle, spreadEdgeMarkers, squadListModel, ticketModel, unitMarkerModels, vehicleHitMark, vehiclePanelModel,
} from './conquest-hud-state.js';
import { CONQUEST_TOUCH_EVENT } from '../engine/touch-controls.js';
import { el } from './hud-support.js';
import { BigMap } from './conquest/big-map.js';
import { Banners, LockWarning, RestrictedOverlay } from './conquest/banners.js';
import { CaptureRing } from './conquest/capture-ring.js';
import { DeployScreen } from './conquest/deploy-screen.js';
import { InteractPrompt } from './conquest/interact.js';
import { WorldMarkers } from './conquest/markers.js';
import { Minimap } from './conquest/minimap.js';
import { cameraAngles, cameraPosition, createProjector } from './conquest/projection.js';
import { Reticles } from './conquest/reticles.js';
import { ScoreTicker } from './conquest/score-ticker.js';
import { SquadList } from './conquest/squad-list.js';
import { TopBar } from './conquest/top-bar.js';
import { VehiclePanel } from './conquest/vehicle-panel.js';

const clockNow = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
const MARKER_INSETS_DESKTOP = Object.freeze({ top: 96, bottom: 120, left: 48, right: 48 });
const MARKER_INSETS_TOUCH = Object.freeze({ top: 124, bottom: 150, left: 28, right: 28 });
/** Phone landscape: HP card, minimap and MAP / SPOT fill the left edge, so left markers clamp right of them. */
const MARKER_INSETS_TOUCH_LANDSCAPE = Object.freeze({ top: 124, bottom: 150, left: 196, right: 28 });
/** Fixed HUD panels edge-clamped flag markers keep clear of (re-measured at most every OBSTACLE_MS). */
const MARKER_OBSTACLES = ['.cq-minimap', '.cq-squad', '.cq-map-hint', '.cq-vehicle', '.cq-top', '.cq-banner', '.cq-ring', '.cq-interact', '.cq-lock',
  '.cq-restricted', '#healthbar', '#ammo', '#grenade-count', '.vb-touch-button'].join(', ');
const OBSTACLE_MS = 400;
/** The crosshair and its reticle labels (vehicle ammo, lock, pipper): clamped edge markers stay out of it. */
const crosshairZone = (width, height) => ({ left: width / 2 - 70, right: width / 2 + 70, top: height / 2 - 50, bottom: height / 2 + 60 });
/** A snapshot within this long of the last refresh() leaves drawing to the next frame. */
const FRAME_DRIVEN_MS = 250;
/** How long the M / Y hint above the minimap stays after the HUD appears (until first use). */
export const MAP_HINT_MS = 30000;

export class ConquestHud {
  constructor(parent = globalThis.document?.body, {
    onInteract = () => {}, onDeploy = () => {}, onSpot = () => {}, onSupport = () => {},
    combatHud = null, eventTarget = typeof window !== 'undefined' ? window : null, inputEnabled = () => true,
  } = {}) {
    // Keys for spot and the full map only act while gameplay input is live (not in menus).
    this.inputEnabled = typeof inputEnabled === 'function' ? inputEnabled : () => true;
    this.onSpot = onSpot;
    this.combatHud = combatHud;
    this.root = el('section', 'vb-conquest-hud', parent);
    this.root.hidden = true;
    this.root.setAttribute('aria-label', 'Conquest tactical information');
    this.markers = new WorldMarkers(this.root);
    this.reticles = new Reticles(this.root);
    this.topBar = new TopBar(this.root);
    this.banners = new Banners(this.root);
    this.ring = new CaptureRing(this.root);
    this.ticker = new ScoreTicker(this.root);
    this.lock = new LockWarning(this.root);
    this.restricted = new RestrictedOverlay(this.root);
    this.minimap = new Minimap(this.root, { onOpen: () => this.toggleBigMap(true) });
    this.squadList = new SquadList(this.root);
    this.vehiclePanel = new VehiclePanel(this.root);
    this.interact = new InteractPrompt(this.root, { onInteract, onSupport });
    this.spotFlash = el('div', 'cq-spot-flash', this.root);
    this.spotFlash.hidden = true;
    this.bigMapHint = el('div', 'cq-map-hint', this.root);
    this.bigMap = new BigMap(this.root);
    this.deploy = new DeployScreen(this.root, { onDeploy });
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
    if (!this.active || event.defaultPrevented || isTypingTarget(event.target)) return;
    if (matchesBinding(event, 'interact')) {
      // A hold only starts while gameplay input is live (never behind the pause menu).
      if (down && !event.repeat && this.inputEnabled()) this._interactDownAt = clockNow();
      return;
    }
    if (!down || event.repeat) return;
    if (event.key === 'Escape' && this.bigMap.open) { this.toggleBigMap(false); return; }
    // Enter deploys from the deploy screen (gameplay input is closed while dead).
    if (this.dead && this.deploy.open && event.key === 'Enter') { this.deploy.deploy(); return; }
    if (!this.inputEnabled()) return;
    if (matchesBinding(event, 'bigMap') && !this.dead) { this.toggleBigMap(); return; }
    if (matchesBinding(event, 'spot') && !this.dead) this.spot();
  }

  /**
   * Gamepad Conquest actions from this frame's press edges (Input.padButtons).
   * Alive: D-pad right spots and R3 (unscoped) toggles the full map; seated,
   * D-pad up takes the next free seat, LB fires countermeasures and Y cycles
   * the seat weapon. Deploy screen: D-pad up/down pick the spawn, LB/RB the
   * kit, A deploys. Interact (D-pad left) goes through VehicleController.padInteract.
   */
  padInput({ pressed = null, scoped = false, blocked = false } = {}) {
    if (!this.active || !pressed || blocked) return false;
    if (this.dead) {
      if (!this.deploy.open) return false;
      if (pressed.slotUp) this.deploy.step('spawn', -1);
      if (pressed.grenadePouch) this.deploy.step('spawn', 1);
      if (pressed.lastWeapon) this.deploy.step('kit', -1);
      if (pressed.grenade) this.deploy.step('kit', 1);
      if (pressed.jump) this.deployNow();
      return true;
    }
    if (!this.inputEnabled()) return false;
    if (pressed.buy) this.spot();
    if (pressed.zoom && !scoped) this.toggleBigMap();
    if (this.seated) {
      if (pressed.slotUp) this.conquestAction('vehicleSeat');
      if (pressed.lastWeapon) this.conquestAction('countermeasure');
      if (pressed.weapon) this.vehicleController?.queueWeaponNext?.();
    }
    return true;
  }

  /** Spot along the view (keyboard or touch); the server validates cone, range and line of sight. */
  spot() {
    if (!this.active || this.dead || !(this.self?.hp > 0)) return false;
    this._hintUsed = true;
    this.onSpot();
    return true;
  }

  toggleBigMap(open) {
    if (!this.active) return false;
    this._hintUsed = true;
    const next = this.bigMap.setOpen(open === undefined ? !this.bigMap.open : !!open);
    this.root.dataset.bigMap = String(next);
    return next;
  }

  /** Touch DEPLOY button: same as pressing the deploy screen button. */
  deployNow() { return this.dead && this.deploy.open ? this.deploy.deploy() : false; }

  /**
   * One Conquest touch button (touch-controls CONQUEST_TOUCH_ACTIONS): full
   * map, spot, deploy, next free seat and countermeasure. Seat and
   * countermeasure requests go through the vehicle controller as on keyboard.
   */
  conquestAction(action) {
    if (!this.active) return false;
    switch (action) {
      case 'bigMap': return this.dead ? false : this.toggleBigMap() || true;
      case 'spot': return this.spot();
      case 'deploy': return this.deployNow();
      case 'vehicleSeat': {
        const index = this.seated ? nextFreeSeatIndex(this.seated.row, this.seated.seat.id) : -1;
        return index >= 0 ? !!this.vehicleController?.requestSeat?.(index) : false;
      }
      case 'countermeasure': return !!this.vehicleController?.queueCountermeasure?.();
      default: return false;
    }
  }

  /** Conquest fields the integrator merges into the TouchControls context. */
  touchContextFields() {
    return conquestTouchFields({ active: this.active, dead: this.dead, deployOpen: this.deploy.open,
      deploy: this.deploy.model, seated: this.seated });
  }

  setDead(dead, killerInfo = null) {
    this.dead = !!dead;
    if (killerInfo) this.killerInfo = killerInfo;
    if (!this.dead) this.killerInfo = null;
    const show = this.dead && this.active;
    this.deploy.setOpen(show, this.killerInfo);
    this.root.dataset.dead = String(this.dead);
    if (this.dead) { this.bigMap.setOpen(false); this.reticles.clear(); this.markers.clear(); }
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
  refresh({ camera = undefined, nowMs = undefined, viewport = undefined, interactHeld = undefined, interactDown = undefined } = {}) {
    if (!this._lastArgs || !this.active) return;
    const args = { ...this._lastArgs };
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
    const cq = readConquest(match, mapMeta);
    if (!cq) { this._lastArgs = null; this.hide(); return false; }
    this._lastArgs = args;
    if (vehicleController) this.vehicleController = vehicleController;
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
    if (post && this.deploy.open) this.deploy.setOpen(false);
    else if (!post && this.dead && (wasHidden || !this.deploy.open)) this.deploy.setOpen(true, this.killerInfo);
    this.cq = cq;
    this.self = self;
    const selfTeam = self?.team === 'alpha' || self?.team === 'bravo' ? self.team : null;
    this.selfTeam = selfTeam;
    this.root.dataset.team = selfTeam || '';
    const vehicles = Array.isArray(args.vehicles) ? args.vehicles : [];
    const alive = !!self && self.state !== 'dead' && self.hp > 0;
    this.seated = alive ? seatedVehicle(self, vehicles) : null;
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

    this.topBar.update(ticketModel(cq, selfTeam, now), flagChipModels(cq, selfTeam));
    this.banners.update(now);
    this.ticker.update(now);

    const alive = !!self && self.state !== 'dead' && self.hp > 0;
    const seated = this.seated;
    if (doc?.body?.dataset) doc.body.dataset.vehicleSeated = String(!!seated);
    this.root.dataset.seated = seated ? seated.row.type : '';
    this.root.dataset.touch = String(touch);

    // THREE refreshes matrixWorldInverse only while rendering; project with this frame's pose.
    camera?.updateMatrixWorld?.();
    const angles = cameraAngles(camera);
    const eye = cameraPosition(camera);
    const yaw = angles?.yaw ?? (Number.isFinite(self?.yaw) ? self.yaw : 0);
    const projector = alive && camera ? createProjector(camera, width, height) : null;
    const items = mapItems({ cq, self, players, vehicles, selfTeam });

    if (this.dead || !alive) {
      this.ring.update(null);
      this.vehiclePanel.update(null);
      this.interact.update(null, { nowMs: now });
      this.lock.update(null);
      this.restricted.update(null);
      this.reticles.clear();
      this.markers.clear();
      this.minimap.root.hidden = true;
      this.squadList.update(null);
      this.deploy.update({ cq, self, players, vehicles, nowMs: now, mapItems: items, meta: cq.meta });
      return;
    }
    this.minimap.root.hidden = false;
    this.squadList.update(squadListModel({ cq, self, players, vehicles }));
    // Airborne aircraft crew never count toward a capture (spec F1), so no ring for them.
    const airborne = !!seated && isAircraftType(seated.row.type) && seated.row.grounded === false;
    this.ring.update(airborne ? null : captureRingModel(cq, self, selfTeam));
    // The lock bearing is drawn around the crosshair, so it is relative to the view, not the hull.
    const panel = vehiclePanelModel(seated, { selfId: self.id, players, selfTeam, yaw });
    this.vehiclePanel.update(panel, now);
    this.lock.update(panel?.lock ?? null);
    const reticle = seated && projector ? reticleModel(seated, { projector, players, vehicles, selfTeam }) : null;
    const locker = projector ? lockerModel(self, { projector, vehicles, selfTeam, seated,
      camera: angles && eye ? { ...eye, yaw: angles.yaw, pitch: angles.pitch } : null }) : null;
    this.reticles.draw(reticle, locker, width, height, { touch });
    // Markers after the reticles: edge-clamped flags keep clear of the panels, the crosshair and the drawn instruments.
    const insets = !touch ? MARKER_INSETS_DESKTOP : width > height && height <= 500 ? MARKER_INSETS_TOUCH_LANDSCAPE : MARKER_INSETS_TOUCH;
    this.markers.update(
      projector ? spreadEdgeMarkers(flagMarkerModels(cq, self, selfTeam, projector, insets), { width, height, insets,
        obstacles: [...this._markerObstacles(width, height, touch), crosshairZone(width, height), ...this.reticles.reserved] }) : [],
      projector ? unitMarkerModels({ self, players, vehicles, selfTeam, projector, insets }) : [],
    );
    this.restricted.update(restrictedModel(self, cq));
    const prompt = interactModel({ self, players, vehicles, nearbyVehicle, seated });
    this.interact.update(prompt, { heldMs: this._heldMs(vehicleController ?? this.vehicleController, interactHeld, clockNow(), interactDown), nowMs: now, touch });
    this.minimap.draw({ items, center: { x: self.x, z: self.z }, yaw, size: cq.size, meta: cq.meta, nowMs: now });
    this.bigMap.draw({ items, size: cq.size, meta: cq.meta, nowMs: now });
    // A short onboarding hint, not a permanent keybind line: it fades after
    // MAP_HINT_MS in the match or once the player has used M or Y.
    const hintLive = !this._hintUsed && clockNow() - this._shownAt < MAP_HINT_MS;
    const hint = this.bigMap.open || !hintLive ? '' : `${bindingLabel('bigMap')} MAP · ${bindingLabel('spot')} SPOT`;
    if (!touch && this.bigMapHint.textContent !== hint) this.bigMapHint.textContent = hint;
    this.bigMapHint.hidden = touch || !hint;
    this.spotFlash.hidden = now >= this._spotUntil;
  }

  /** Forget the measured HUD panel rects (after a layout change the caller knows about). */
  invalidateLayout() { this._obstacleCache = null; }

  /** Screen rects of the visible fixed HUD panels, cached per layout and refreshed a few times a second. */
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

  handleEvent(ev, selfId) {
    if (!ev || typeof ev !== 'object') return;
    const now = this._lastNow || Date.now();
    const selfTeam = this.selfTeam;
    switch (ev.kind) {
      case 'score': {
        const entry = scoreEntry(ev, selfId);
        if (entry) this.ticker.push(entry, now);
        break;
      }
      case 'flag_captured': case 'flag_neutralized': case 'flag_state': case 'ticket_low': {
        const flag = this.cq?.flags?.find(f => f.id === ev.flag);
        const banner = bannerForEvent(ev, selfTeam, { flagOwner: flag?.owner ?? null, flagName: flag?.name ?? null });
        if (banner) this.banners.push(banner, now);
        break;
      }
      case 'deploy_refused':
        if (String(ev.id) === String(selfId)) this.deploy.refuse(ev.reason);
        break;
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
        break;
      }
      case 'vehicle_destroyed':
        this.combatHud?.vehicleDestroyed?.(ev);
        break;
      case 'kill': {
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
    if (body?.dataset) delete body.dataset.vehicleSeated;
    if (this.root.hidden) return;
    this.root.hidden = true;
    this.bigMap.setOpen(false);
    this.deploy.setOpen(false);
    this.reticles.clear();
    this.markers.clear();
    this.ticker.clear();
    this.banners.clear();
    this._endKey = null;
  }

  dispose() {
    this.hide();
    this._lastArgs = null;
    this.vehicleController = null;
    this.eventTarget?.removeEventListener?.(CONQUEST_TOUCH_EVENT, this._onTouchAction);
    this.eventTarget?.removeEventListener?.('keydown', this._onKeyDown, true);
    this.eventTarget?.removeEventListener?.('keyup', this._onKeyUp, true);
    this.eventTarget?.removeEventListener?.('blur', this._onBlur);
    this.root.remove();
  }
}
