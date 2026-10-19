// Conquest weapon / grenade / health cards and the touch VIEW face
// (docs/design/conquest/hud/): the health card's dock decides the minimap
// floor, the cards' values come from the shared HUD state (fire mode from the
// weapon table, the medkit key from the binding), the VIEW button names the
// active camera view, and styles/conquest-cards.css only restyles the shared
// cards while the Conquest HUD is up. Fake DOM, no browser.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installFakeDom } from './lib/conquest-ui-dom.mjs';
import { VEHICLE_TOPOLOGY, seatWeaponList } from '../shared/conquest-contract.js';
import { WEAPONS } from '../shared/combatmath.js';

const dom = installFakeDom({ width: 844, height: 390 });
const { document } = dom;
globalThis.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const { TouchControls, visibleTouchActions } = await import('../public/js/engine/touch-controls.js');
const { ConquestHud, HEALTH_FLOOR, healthCardLayout } = await import('../public/js/ui/conquest-hud.js');
const state = await import('../public/js/ui/conquest-hud-state.js');
const { VIEW_BUTTON_LABELS, viewButtonLabel } = await import('../public/js/ui/conquest/view-strip.js');
const { seatViews, vehicleViewLabel } = await import('../public/js/session/vehicle-camera.js');
const { MedkitHud } = await import('../public/js/ui/medkit-hud.js');
const { cameraPose } = await import('../public/js/ui/conquest/projection.js');
const { conquestHudFixtures, fixtureMapMeta, FIXTURE_NOW } = await import('../public/js/capture/conquest-hud-fixtures.js');
let checks = 0;
const check = (value, message) => { assert(value, message); checks++; };

/** VehicleCamera.viewState() for a seat in `view` (default: its first view). */
function viewState(type, seatId, view = seatViews(type, seatId)[0]) {
  const views = seatViews(type, seatId);
  return { type, seatId, view, label: vehicleViewLabel(type, seatId, view),
    views: views.map(id => ({ id, label: vehicleViewLabel(type, seatId, id) })), changedAt: -1e9 };
}

// --- health card dock and the minimap floor ---------------------------------------------
{
  const row = (left, top, width = 408, height = 38) => ({ left, top, width, height, right: left + width, bottom: top + height });
  // Desktop Conquest: the row docks at the bottom right under the weapon card; the minimap drops to the edge.
  const docked = healthCardLayout(row(1440 - 22 - 408, 900 - 22 - 38), 1440, 900);
  check(docked.docked && docked.floor === HEALTH_FLOOR.docked && docked.height === 38, 'a right-docked health row lets the minimap sit on the bottom edge');
  // A health card in the left column (phones, the tank periscope, other layouts) keeps the minimap standing on it.
  const left = healthCardLayout(row(22, 900 - 22 - 38, 240), 1440, 900);
  check(!left.docked && left.floor === HEALTH_FLOOR.left, 'a short left card keeps the 104 px floor');
  const tall = healthCardLayout(row(22, 900 - 22 - 120, 240, 120), 1440, 900);
  check(tall.floor === 120 + 22 + HEALTH_FLOOR.gap, 'pain / panic rows lift the floor with the card');
  const none = healthCardLayout({ left: 0, top: 0, width: 0, height: 0 }, 1440, 900);
  check(none.floor === HEALTH_FLOOR.left && none.height === 0, 'no card: the default floor and no height');
}

// --- VIEW face: the active view's name ----------------------------------------------------
{
  check(viewButtonLabel(null) === '' && viewButtonLabel({ views: [{ id: 'chase', label: 'CHASE' }], view: 'chase' }) === '', 'no face without two views');
  check(viewButtonLabel(viewState('tank', 'driver')) === 'HATCH', 'the tank driver starts in HATCH');
  check(viewButtonLabel(viewState('tank', 'driver', 'chase')) === 'CHASE', 'CHASE after a press');
  check(viewButtonLabel(viewState('plane', 'driver', 'flyby')) === 'FLYBY', 'the jet FLYBY');
  const firstPerson = Object.keys(VEHICLE_TOPOLOGY).flatMap(type => VEHICLE_TOPOLOGY[type].map(seat => [type, seat.id]))
    .find(([type, seatId]) => seatViews(type, seatId).length > 1 && vehicleViewLabel(type, seatId, 'cockpit') === 'FIRST PERSON'
      && seatViews(type, seatId).includes('cockpit'));
  check(firstPerson && viewButtonLabel(viewState(...firstPerson, 'cockpit')) === VIEW_BUTTON_LABELS['FIRST PERSON'], 'FIRST PERSON gets the short POV face');
  // Every face of every seat fits the 44 px button (8 px type: at most 7 characters).
  for (const [type, seats] of Object.entries(VEHICLE_TOPOLOGY)) {
    for (const seat of seats) {
      for (const view of seatViews(type, seat.id)) {
        const face = viewButtonLabel(viewState(type, seat.id, view));
        if (seatViews(type, seat.id).length > 1) check(face.length > 0 && face.length <= 7, `${type}:${seat.id} ${view} face "${face}" fits`);
      }
    }
  }
}

// --- touch fields and the VIEW button -----------------------------------------------------
{
  check(state.CONQUEST_TOUCH_DEFAULTS.vehicleViewLabel === '', 'the defaults reset the face');
  const seat = VEHICLE_TOPOLOGY.tank.find(s => s.id === 'driver');
  const row = { id: 'alpha-tank', type: 'tank', team: 'alpha', hp: 100, cmr: 100, seatOccupants: { driver: 'me' } };
  const fields = state.conquestTouchFields({ active: true, seated: { row, seat }, viewLabel: 'CHASE' });
  check(fields.vehicleViewLabel === 'CHASE' && fields.vehicleViewCount === 4, 'a seated player gets the face');
  check(state.conquestTouchFields({ active: true, viewLabel: 'CHASE' }).vehicleViewLabel === '', 'on foot: no face');
  check(state.conquestTouchFields({ active: false, viewLabel: 'CHASE' }).vehicleViewLabel === '', 'outside Conquest: no face');

  const touch = new TouchControls({ documentRef: document });
  touch.mount(document.body); touch.setEnabled(true);
  const context = { alive: true, canFire: true, vehicleSeated: true, vehicleType: 'tank', vehicleId: row.id, vehicleSeatId: 'driver',
    vehicleRole: seat.role, vehicleCanDrive: true, vehicleCanFire: seatWeaponList('tank', 'driver').length > 0, ...fields };
  touch.setContext(context);
  const button = touch.dom.vehicleView;
  check(!button.classList.contains('is-hidden') && button.textContent === 'CHASE' && button.dataset.view === 'CHASE', 'VIEW shows CHASE');
  check(button.getAttribute('aria-label') === 'Next camera view (now CHASE)', 'and says so');
  touch.setContext({ ...context, vehicleViewLabel: 'HATCH' });
  check(button.textContent === 'HATCH', 'the face follows the camera');
  touch.setContext({ ...context, vehicleViewLabel: '' });
  check(button.textContent === 'VIEW' && button.dataset.view === '' && button.getAttribute('aria-label') === 'Next camera view', 'no label: plain VIEW');
  touch.setContext({ alive: true, canFire: true, conquest: true });
  check(button.classList.contains('is-hidden'), 'on foot VIEW hides');
  check(!visibleTouchActions({ alive: true, conquest: true, vehicleViewLabel: 'CHASE', vehicleViewCount: 4 }).has('vehicleView'), 'only seated players get VIEW');
  touch.dispose();
}

// --- ConquestHud hands the vehicle camera's view to the touch context --------------------
{
  const fixture = conquestHudFixtures().find(f => f.id === 'tank-driver');
  const hud = new ConquestHud(document.body, { eventTarget: dom.window });
  let current = viewState('tank', 'driver');
  const controller = { interactHeldMs: () => 0, viewState: () => current, cycleView: () => { current = viewState('tank', 'driver', 'chase'); return 'chase'; } };
  hud.update({ match: fixture.match, mapMeta: fixtureMapMeta(), self: fixture.self, players: fixture.players, vehicles: fixture.vehicles,
    nowMs: FIXTURE_NOW, camera: cameraPose({ ...fixture.camera, aspect: 844 / 390 }), viewport: { width: 844, height: 390 }, vehicleController: controller });
  check(hud.touchContextFields().vehicleViewLabel === 'HATCH', 'the seat default view');
  check(hud.conquestAction('vehicleView') === true, 'VIEW cycles through the controller');
  check(hud.touchContextFields().vehicleViewLabel === 'CHASE', 'the next context names the new view');
  hud.dispose();
}

// --- card values from the shared HUD state ------------------------------------------------
{
  // Medkit: the key on its own for the Conquest key badge, empty once used.
  const card = document.createElement('div');
  document.body.appendChild(card);
  const medkit = new MedkitHud();
  medkit.build(document.body, card);
  medkit.update({ remaining: 1, active: false }, true, 74);
  check(medkit.inventory.dataset.key === 'J' && medkit.inventory.dataset.compact === 'MEDKIT ×1', 'unused medkit: key J and MEDKIT ×1');
  medkit.update({ remaining: 0, active: false }, true, 74);
  check(medkit.inventory.dataset.key === '' && medkit.inventory.dataset.compact === 'MEDKIT USED', 'used: no key badge');
  medkit.dispose();
  // Fire mode: the weapon card's tag reads the weapon table's trigger mode.
  const source = readFileSync(new URL('../public/js/ui/gameplay-hud.js', import.meta.url), 'utf8');
  check(/d\.ammo\.dataset\.fireMode = WEAPONS\[key\]\?\.mode \?\? ''/.test(source), 'the ammo card carries WEAPONS[key].mode');
  check(['auto', 'semi', 'bolt', 'pump', 'melee'].every(mode => Object.values(WEAPONS).some(w => w.mode === mode)), 'trigger modes are weapon data');
}

// --- stylesheet: Conquest-only, loaded after the shared card sheets -----------------------
{
  const css = readFileSync(new URL('../public/styles/conquest-cards.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const scope = 'body:has(> .vb-conquest-hud';
  const rules = [...css.matchAll(/([^{}]+)\{[^{}]*\}/g)].map(match => match[1].trim()).filter(sel => !sel.startsWith('@'));
  const shared = /#(ammo|healthbar|hpfill|grenade-count|weapon-icon|weaponname|ammocount|ammoreserve|charge-meter|hud)\b|\.vb-(medkit|grenade|ammo)/;
  for (const selector of rules) {
    for (const part of selector.split(/,(?![^(]*\))/)) {
      if (shared.test(part)) check(part.includes(scope), `shared card selector is Conquest-scoped: ${part.trim()}`);
    }
  }
  check(!/^\s*&/m.test(css), 'flat selectors (no CSS nesting)');
  // A display value set here outranks the shared hide rules (.vb-medkit-inventory[hidden],
  // .vb-touch-button.is-hidden): every such rule must exclude the hidden state itself.
  const hiddenBy = { '.vb-medkit-inventory': ':not([hidden])', '.vb-touch-vehicleView': ':not(.is-hidden)' };
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const display = /(?:^|;)\s*display\s*:\s*([^;]+)/.exec(match[2])?.[1]?.trim();
    if (!display || display === 'none') continue;
    for (const part of match[1].trim().split(/,(?![^(]*\))/)) {
      const last = part.trim().split(/\s+/).pop();
      for (const [target, guard] of Object.entries(hiddenBy)) {
        if (last.startsWith(target) && !last.includes('::')) check(last.includes(guard), `${part.trim()} sets display ${display} only with ${guard}`);
      }
    }
  }
  // main.js merges a literal fallback into the persistent touch context when there is no
  // ConquestHud: it must list every default key, or a stale VIEW face / count would survive.
  const main = readFileSync(new URL('../public/js/main.js', import.meta.url), 'utf8');
  const fallback = /this\.conquestHud\.touchContextFields\(\) : \{([^}]*)\}/.exec(main)?.[1] ?? '';
  for (const key of Object.keys(state.CONQUEST_TOUCH_DEFAULTS)) check(new RegExp(`\\b${key}:`).test(fallback), `main.js touch fallback lists ${key}`);
  for (const page of ['../public/index.html', '../public/conquest-hud-capture.html']) {
    const html = readFileSync(new URL(page, import.meta.url), 'utf8');
    const at = name => html.indexOf(`styles/${name}`);
    check(at('conquest-cards.css') > Math.max(at('conquest.css'), at('medkit.css'), at('bubble-hud.css'), at('grenade-pouch.css'), at('touch-controls.css')),
      `${page} loads conquest-cards.css after the shared card sheets`);
  }
}

console.log(`conquest-hud-cards-test: ${checks} checks passed`);
