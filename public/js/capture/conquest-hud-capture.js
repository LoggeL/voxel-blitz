/**
 * Static Conquest HUD capture page: renders every HUD state from the JSON-like
 * fixtures through the real ConquestHud, HUD (kill feed, scoreboard, result)
 * and TouchControls. No WebGL, no audio, no server. Driven by
 * tools/conquest-hud-capture.mjs through window.__cq.
 */
import { HUD } from '../ui/hud.js';
import { ConquestHud } from '../ui/conquest-hud.js';
import { TouchControls } from '../engine/touch-controls.js';
import { cameraPose } from '../ui/conquest/projection.js';
import { readConquest, seatedVehicle, vehiclePanelModel } from '../ui/conquest-hud-state.js';
import { KIT_IDS, KITS, seatWeaponList } from '../../../shared/conquest-contract.js';
import { GRENADE_TYPE_IDS } from '../../../shared/grenade-rules.js';
import { WEAPONS } from '../../../shared/combatmath.js';
import { conquestHudFixtures, fixtureMapMeta, FIXTURE_NOW } from './conquest-hud-fixtures.js';
import { WeaponWheelController as WheelSession } from '../session/weapon-wheel-controller.js';
import { wheelAngleForSlot } from '../ui/weapon-wheel.js';
import { kitLoadout } from '../../../shared/conquest-kits.js';
import { WEAPON_IDS } from '../../../shared/combatmath.js';

const fixtures = conquestHudFixtures();
const mapMeta = fixtureMapMeta();
const label = document.getElementById('capture-label');
let hud = null;
let conquest = null;
/** The latest render's update args: rerender() replays them after a click changed the HUD's own state. */
let lastArgs = null;
let touch = null;
const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

function ensureHud() {
  if (hud) return hud;
  hud = new HUD();
  hud.buildHUD();
  hud.menuDone?.();
  hud.setMapMeta?.(mapMeta);
  return hud;
}

/** The touch context the integrator builds: infantry or seat basics plus ConquestHud.touchContextFields(). */
function touchContext(state, seated, fields) {
  if (state.dead) return { alive: false, ...fields };
  const seat = seated?.seat;
  return {
    alive: true, canFire: true, canReload: true, weaponCount: 3, canThrow: true, grenadeTotal: 3,
    canInteract: !!(state.nearbyVehicle || state.interactHeld), grenadeReady: 0, grenadeCounts: [2, 0, 0, 0, 1],
    ...(seated ? {
      vehicleSeated: true, vehicleType: seated.row.type, vehicleId: seated.row.id, vehicleSeatId: seat.id, vehicleRole: seat.role,
      vehicleCanDrive: seat.drives, vehicleCanFire: seatWeaponList(seated.row.type, seat.id).length > 0,
    } : {}),
    ...fields,
  };
}

/**
 * The local-player HUD bag main.js feeds HUD.setState every frame, built from
 * the fixture's own row: the kit's first primary with a full magazine, the
 * kit's grenade stock and an unused medkit. Without it the infantry cards
 * (ammo, grenade Ready Card, medkit) paint their unset defaults.
 */
function localHudState(state) {
  const self = state.self;
  const kit = KITS[KIT_IDS[self.cq?.[0]] || 'assault'] || KITS.assault;
  const weapon = WEAPONS[kit.primaries[0]] || WEAPONS.rifle;
  const grenades = GRENADE_TYPE_IDS.map(type => kit.grenades[type] || 0);
  const alive = !state.dead && self.state !== 'dead';
  return {
    alive, hp: alive ? self.hp : 0, medkit: { remaining: 1, active: false, progress: 0 }, armor: 0,
    wid: weapon.id, wname: weapon.name, mag: weapon.magSize, reserve: Math.max(1, (weapon.spareMags ?? 3) - 1), infiniteMagazines: false,
    grenades, grenadeType: Math.max(0, grenades.findIndex(n => n > 0)), grenadeReady: Math.max(0, grenades.findIndex(n => n > 0)),
    grenadeCharge: 0, grenadeCharging: false, grenadePouchOpen: false, grenadePouchHover: -1,
    reloading01: null, reloadStaged: false, adsT01: 0, scopeActive: false, yawDeg: 0,
  };
}

async function render(id, { touch: touchMode = false } = {}) {
  const state = fixtures.find(f => f.id === id);
  if (!state) throw new Error(`unknown fixture ${id}`);
  const h = ensureHud();
  conquest?.dispose();
  h.setScoreboard?.(false);
  conquest = new ConquestHud(document.body, { combatHud: h.combat, onDeploy() {}, onSpot() {}, onSupport() {}, onInteract() {},
    careerProfile: () => state.career ?? null });
  if (touchMode && !touch) {
    touch = new TouchControls({ documentRef: document });
    touch.mount(document.body);
    touch.setEnabled(true);
  }
  // The live game sets the touch class at boot, before any HUD update.
  document.documentElement.classList.toggle('vb-touch-mode', !!touchMode);
  const width = innerWidth, height = innerHeight;
  const camera = cameraPose({ ...state.camera, aspect: width / height });
  h.combat.clearKillfeed?.();
  h.combat.setNames(state.players);
  h.setMatchState(state.match, state.self, state.players, FIXTURE_NOW);
  // main.js reports the input device the same way (touch hides key badges, compacts the Ready Card).
  h.gameplay?.setDeviceLabels?.({ touch: touchMode });
  h.setState(localHudState(state));
  if (state.selection) conquest.deploy.selection = { ...conquest.deploy.selection, ...state.selection };
  const args = { match: state.match, mapMeta, self: state.self, players: state.players, vehicles: state.vehicles, camera,
    nearbyVehicle: state.nearbyVehicle, nowMs: FIXTURE_NOW, interactHeld: state.interactHeld, viewport: { width, height } };
  lastArgs = args;
  conquest.update(args);
  if (state.dead) conquest.setDead(true, state.killer);
  if (state.bigMap) conquest.toggleBigMap(true);
  for (const ev of state.events) {
    if (ev.kind === 'kill') h.killfeed(ev);
    else conquest.handleEvent(ev, 'me');
  }
  conquest.update(args);
  if (state.screen === 'scoreboard') h.setScoreboard(true);
  const seated = seatedVehicle(state.self, state.vehicles);
  if (touch) touch.setContext(touchMode ? touchContext(state, seated, conquest.touchContextFields()) : null);
  label.textContent = `${state.id} · ${state.title} · ${width}×${height}`;
  await frame();
  // Image decodes (overview map) settle after the first frame; draw again, with the HUD panels
  // (touch buttons, vehicle card) laid out so edge markers measure their final positions.
  conquest.invalidateLayout();
  conquest.update(args);
  await frame();
  return { id, title: state.title, seated: seated ? `${seated.row.type}:${seated.seat.id}` : null,
    panel: seated ? vehiclePanelModel(seated, { selfId: 'me', players: state.players, selfTeam: state.selfTeam })?.name : null,
    flags: readConquest(state.match, mapMeta)?.flags.length ?? 0 };
}

const rect = el => {
  if (!el || el.hidden || el.closest?.('[hidden]')) return null;
  const style = getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden') return null;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height } : null;
};

const union = (a, b) => (!a ? b : !b ? a : { left: Math.min(a.left, b.left), top: Math.min(a.top, b.top), right: Math.max(a.right, b.right),
  bottom: Math.max(a.bottom, b.bottom), width: Math.max(a.right, b.right) - Math.min(a.left, b.left), height: Math.max(a.bottom, b.bottom) - Math.min(a.top, b.top) });

/** Box of an element's rendered text (padding and stretched block width excluded). */
function textRect(selector) {
  const node = document.querySelector(selector);
  if (!rect(node)) return null;
  const range = document.createRange();
  range.selectNodeContents(node);
  const r = range.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height } : null;
}

/**
 * Every fixed HUD box the capture tool checks for overlap. While the deploy
 * screen or the full map covers the view only that overlay's own parts count
 * (everything else is underneath it).
 */
function boxes() {
  const one = selector => rect(document.querySelector(selector));
  const buttons = [...document.querySelectorAll('.vb-touch-button')].map(b => ({ action: b.dataset.action, box: rect(b) })).filter(b => b.box);
  if (one('.cq-deploy')) {
    // The class picker and the header status line must clear the killer card and the pause button too.
    return { 'deploy-title': union(textRect('.cq-deploy-title'), textRect('.cq-deploy-team')), 'deploy-killer': one('.cq-deploy-killer'),
      'deploy-status': textRect('.cq-deploy-status'), 'deploy-classes': one('.cq-deploy-side'),
      buttons: buttons.filter(b => b.action === 'pause') };
  }
  if (one('.cq-bigmap')) return { bigmap: one('.cq-bigmap-panel'), buttons: [] };
  const flags = [...document.querySelectorAll('.cq-flag-marker[data-edge="true"]')]
    .map(n => ({ id: n.querySelector('.cq-flag-marker-letter')?.textContent || '?', box: union(rect(n), rect(n.querySelector('.cq-flag-marker-distance'))) }))
    .filter(f => f.box);
  return {
    top: one('.cq-top'), banner: one('.cq-banner'), ring: one('.cq-ring'), ticker: one('.cq-ticker'), minimap: one('.cq-minimap'), squad: one('.cq-squad'),
    'map-hint': one('.cq-map-hint'), vehicle: one('.cq-vehicle'), interact: one('.cq-interact'), lock: one('.cq-lock'), restricted: one('.cq-restricted'),
    healthbar: one('#healthbar'), ammo: one('#ammo'), grenades: one('#grenade-count'), 'reload-hint': one('#reload-hint'), killfeed: one('#killfeed'),
    // The result panel fills phone screens: its header texts are what must clear the pause button.
    scoreboard: one('#scoreboard.is-open'),
    result: one('#match-result-screen:not(.hidden)') ? union(textRect('#match-result-eyebrow'), textRect('#match-result-title')) : null,
    flags, buttons, viewport: { width: innerWidth, height: innerHeight },
  };
}

/**
 * Opens the real weapon wheel over a rendered HUD fixture. Entries come from the
 * session WeaponWheelController against a snapshot-shaped context: the kit's
 * authoritative `owned` list (kitWeapons) and its issued ammo, so the capture shows
 * exactly what a live Conquest player of that kit gets. `mode` other than
 * 'conquest' renders the unchanged full wheel for comparison.
 */
async function wheel({ fixture = 'defending', kit = 'engineer', variant = 0, gadget = 0, mode = 'conquest',
  current = 'primary', hover = 1, touch: touchMode = false } = {}) {
  await render(fixture, { touch: touchMode });
  const h = ensureHud();
  const loadout = kitLoadout(kit, variant, gadget);
  const ammo = Object.fromEntries(WEAPON_IDS.map((id, slot) => [id, { mag: loadout.mag[slot], reserve: loadout.reserve[slot] }]));
  const equipped = loadout[current] || loadout.primary;
  const context = {
    match: { mode }, self: { owned: mode === 'conquest' ? loadout.owned : undefined, state: 'alive' },
    enabled: true, alive: true, spectating: false,
    weapon: { slot: WEAPON_IDS.indexOf(equipped), ammoOf: id => (mode === 'conquest' ? ammo[id] : { mag: WEAPONS[id].magSize, reserve: 3 }), forceWeapon() {} },
  };
  h.setWeaponWheelState({ open: false });
  const picks = [];
  context.weapon.forceWeapon = slot => picks.push(WEAPON_IDS[slot]);
  const session = new WheelSession({
    input: { setWeaponWheelOpen() {}, isWeaponWheelClosing: () => false }, hud: h, getContext: () => context,
  });
  // The live wiring (main.js): a pick from the overlay commits through the session controller.
  h.setupWeaponWheel({ onPick: index => session.commit(index), onCancel: () => session.close() });
  session.openWheel();
  await frame();
  const count = document.querySelectorAll('#weapon-wheel .vb-wheel-slot').length;
  if (hover >= 0 && hover < count) {
    const rad = wheelAngleForSlot(hover, count) * Math.PI / 180;
    h.setWeaponWheelState({ x: Math.cos(rad) * 0.62, y: Math.sin(rad) * 0.62 });
  }
  await frame();
  label.textContent = `weapon wheel · ${mode} · ${kit} · ${innerWidth}×${innerHeight}`;
  const root = document.getElementById('weapon-wheel');
  const dom = [...root.querySelectorAll('.vb-wheel-slot')].map(node => ({
    role: node.querySelector('.vb-wheel-role')?.textContent || '', name: node.querySelector('.vb-wheel-name')?.textContent || '',
    key: node.querySelector('.vb-wheel-key')?.textContent || '', ammo: node.querySelector('.vb-wheel-ammo')?.textContent || '',
    locked: node.classList.contains('is-locked'), current: node.classList.contains('is-current'), hl: node.classList.contains('is-hl'),
  }));
  /** Flicks past the commit ring toward segment `index`; returns what got equipped. */
  const flick = async (index) => {
    if (!session.open) session.openWheel();
    const n = session.entries().length;
    const rad = wheelAngleForSlot(index, n) * Math.PI / 180;
    h.setWeaponWheelState({ x: 0, y: 0 });
    h.setWeaponWheelState({ x: Math.cos(rad) * 1.5, y: Math.sin(rad) * 1.5 });
    await frame();
    return picks.at(-1) ?? null;
  };
  return { count, ids: session.entries().map(entry => entry.id), kit: root.classList.contains('is-kit'), dom,
    hub: [...root.querySelectorAll('.vb-wheel-hub > *')].map(n => n.textContent),
    flick: async () => {
      const out = [];
      for (let i = 0; i < count; i++) { picks.length = 0; out.push(await flick(i)); }
      session.close();
      return out;
    } };
}

/** Flick-selects every segment of a kit wheel through the real overlay geometry; returns the equipped ids. */
async function wheelFlick(options) {
  const info = await wheel({ ...options, hover: -1 });
  return info.flick();
}

const rerender = async () => { if (conquest && lastArgs) conquest.update(lastArgs); await frame(); };
window.__cq = { ids: fixtures.map(f => f.id), titles: Object.fromEntries(fixtures.map(f => [f.id, f.title])), render, rerender, boxes, wheel, wheelFlick, ready: true };
